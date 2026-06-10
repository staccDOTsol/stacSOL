import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'

// Single fetch that powers the /baitscope dashboard. Returns:
//   • current manager_state counters
//   • last N bait events (default 100) for the live feed
//   • last N burn events (default 50) for burn-velocity chart
//   • per-minute aggregated series for the last `windowMin` minutes
//   • per-venue rollup over the window
//   • derived volume + yield attribution:
//       transferVolumeStac   = sum(harvested_atom) / 0.069
//       transferVolumeStacFromBait = our_bait_size_total × 2 × 0.069  (rough)
//       arbTransferVolumeStac      = max(0, total - bait)
//       arbBurnSol           = arb_share × burned_atom × nav
//       baitBurnSol          = bait_share × burned_atom × nav
// The frontend renders charts off the per-minute series and shows the
// attribution as percentages.
//
// Query params:
//   windowMin (default 60, max 1440)
//   baitLimit (default 100, max 500)
//   burnLimit (default 50, max 200)

const T22_FEE_RATE = 0.069
const LAMPORTS_PER_SOL = 1_000_000_000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const windowMin = Math.min(Math.max(parseInt(String(req.query.windowMin ?? '60'), 10) || 60, 1), 1440)
    const baitLimit = Math.min(Math.max(parseInt(String(req.query.baitLimit ?? '100'), 10) || 100, 1), 500)
    const burnLimit = Math.min(Math.max(parseInt(String(req.query.burnLimit ?? '50'), 10) || 50, 1), 200)

    const pool = getPool()

    const [state, baitFeed, burnFeed, baitSeries, burnSeries, venueRollup] = await Promise.all([
      pool.query(
        `SELECT outstanding_bait_cost_lamports::text   AS outstanding,
                lifetime_bait_cost_lamports::text       AS lifetime_cost,
                lifetime_bait_recovered_lamports::text  AS lifetime_recovered,
                lifetime_bait_cycles, lifetime_recovery_cycles,
                last_bait_at, last_recovery_at, updated_at
           FROM manager_state WHERE id = 1`,
      ),
      pool.query(
        `SELECT id, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms,
                venue_label, intermediate_symbol, direction,
                size_lamports::text AS size_lamports,
                sol_delta_lamports::text AS sol_delta_lamports,
                route
           FROM bait_events
           ORDER BY ts DESC
           LIMIT $1`,
        [baitLimit],
      ),
      pool.query(
        `SELECT id, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms,
                harvested_atom::text AS harvested_atom,
                recovered_atom::text AS recovered_atom,
                burned_atom::text    AS burned_atom,
                nav_before, nav_after, candidate_count
           FROM burn_events
           ORDER BY ts DESC
           LIMIT $1`,
        [burnLimit],
      ),
      // Per-minute bait aggregate over the window
      pool.query(
        `SELECT date_trunc('minute', ts) AS minute,
                SUM(size_lamports)        AS size_lamports,
                SUM(sol_delta_lamports)   AS sol_delta_lamports,
                SUM(CASE WHEN sol_delta_lamports > 0 THEN sol_delta_lamports ELSE 0 END) AS cost_lamports,
                SUM(CASE WHEN sol_delta_lamports < 0 THEN -sol_delta_lamports ELSE 0 END) AS profit_lamports,
                COUNT(*)                  AS cycles
           FROM bait_events
          WHERE ts > NOW() - ($1::int * INTERVAL '1 minute')
          GROUP BY minute
          ORDER BY minute ASC`,
        [windowMin],
      ),
      // Per-minute burn aggregate
      pool.query(
        `SELECT date_trunc('minute', ts) AS minute,
                SUM(harvested_atom) AS harvested_atom,
                SUM(recovered_atom) AS recovered_atom,
                SUM(burned_atom)    AS burned_atom,
                AVG(nav_after)      AS nav_after,
                COUNT(*)            AS ticks
           FROM burn_events
          WHERE ts > NOW() - ($1::int * INTERVAL '1 minute')
          GROUP BY minute
          ORDER BY minute ASC`,
        [windowMin],
      ),
      // Per-venue rollup over the window — for the per-venue chart
      pool.query(
        `SELECT venue_label,
                intermediate_symbol,
                COUNT(*) AS cycles,
                SUM(size_lamports)      AS size_lamports,
                SUM(sol_delta_lamports) AS sol_delta_lamports,
                SUM(CASE WHEN sol_delta_lamports > 0 THEN sol_delta_lamports ELSE 0 END) AS cost_lamports,
                SUM(CASE WHEN sol_delta_lamports < 0 THEN -sol_delta_lamports ELSE 0 END) AS profit_lamports
           FROM bait_events
          WHERE ts > NOW() - ($1::int * INTERVAL '1 minute')
          GROUP BY venue_label, intermediate_symbol
          ORDER BY size_lamports DESC NULLS LAST`,
        [windowMin],
      ),
    ])

    const stateRow = state.rows[0]
    const currentNav = (() => {
      const last = burnFeed.rows.find((r) => r.nav_after != null)
      return last ? Number(last.nav_after) : null
    })()

    // Derive volume + attribution.
    //
    // Total stacSOL volume through transfer-fee accounts in window:
    //   volume_atoms = sum(harvested_atom) / 0.069
    //
    // Our bait-attributable share of that volume:
    //   mint_sell: 1 stacSOL transfer hits a non-manager ATA (sell leg
    //              into the LP pool's stacSOL token account)
    //   buy_burn:  0 stacSOL transfers hit non-manager ATAs (we receive
    //              into our own ATA, then burn — no outgoing stacSOL transfer)
    //   Mint-side withhold lives in OUR ATA and gets recovered through
    //   the recovery loop, not arb-attributable.
    //   So bait_volume_atoms ≈ size_stac × ~1.0 per cycle on average.
    //
    // Arb/organic share = max(0, total - bait).
    //
    // NAV growth fuel = burned_atom × NAV (SOL value burned). We
    // attribute that SOL pro-rata to bait_share vs arb_share.

    const harvestedAtomTotal = burnFeed.rows.reduce(
      (a, r) => a + BigInt(r.harvested_atom ?? '0'),
      0n,
    )
    const burnedAtomTotal = burnFeed.rows.reduce(
      (a, r) => a + BigInt(r.burned_atom ?? '0'),
      0n,
    )
    const baitSizeLamportsTotal = baitFeed.rows.reduce(
      (a, r) => a + BigInt(r.size_lamports ?? '0'),
      0n,
    )
    const navForAttribution = currentNav ?? 1
    // Convert bait size SOL -> stacSOL atoms at current NAV
    const baitStacAtoms =
      navForAttribution > 0
        ? Number(baitSizeLamportsTotal) / navForAttribution
        : 0
    // ~1 stacSOL transfer to a non-manager ATA per cycle on average
    // (mint_sell sells INTO the LP pool ATA; buy_burn receives back INTO
    // our own ATA → no external transfer leg).
    const baitWithholdAtoms = baitStacAtoms * 1 * T22_FEE_RATE
    const totalWithholdAtoms = Number(harvestedAtomTotal)
    const arbWithholdAtoms = Math.max(0, totalWithholdAtoms - baitWithholdAtoms)
    const totalVolumeAtoms = totalWithholdAtoms / T22_FEE_RATE
    const baitVolumeAtoms = baitWithholdAtoms / T22_FEE_RATE
    const arbVolumeAtoms = arbWithholdAtoms / T22_FEE_RATE
    const baitShare = totalWithholdAtoms > 0 ? baitWithholdAtoms / totalWithholdAtoms : 0
    const arbShare = 1 - baitShare
    const burnedSolValue = (Number(burnedAtomTotal) / 1e9) * navForAttribution
    const baitBurnedSol = burnedSolValue * baitShare
    const arbBurnedSol = burnedSolValue * arbShare

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      ok: true,
      now: Date.now(),
      windowMin,
      state: stateRow
        ? {
            outstandingBaitCostLamports: stateRow.outstanding,
            lifetimeBaitCostLamports: stateRow.lifetime_cost,
            lifetimeBaitRecoveredLamports: stateRow.lifetime_recovered,
            lifetimeBaitCycles: Number(stateRow.lifetime_bait_cycles),
            lifetimeRecoveryCycles: Number(stateRow.lifetime_recovery_cycles),
            lastBaitAt: stateRow.last_bait_at ? new Date(stateRow.last_bait_at).getTime() : null,
            lastRecoveryAt: stateRow.last_recovery_at
              ? new Date(stateRow.last_recovery_at).getTime()
              : null,
            updatedAt: new Date(stateRow.updated_at).getTime(),
          }
        : null,
      currentNav,
      attribution: {
        transferVolumeStac: totalVolumeAtoms / 1e9,
        baitVolumeStac: baitVolumeAtoms / 1e9,
        arbVolumeStac: arbVolumeAtoms / 1e9,
        baitSharePct: baitShare * 100,
        arbSharePct: arbShare * 100,
        burnedStac: Number(burnedAtomTotal) / 1e9,
        burnedSolValue,
        baitBurnedSol,
        arbBurnedSol,
      },
      baitFeed: baitFeed.rows.map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts_ms),
        venueLabel: r.venue_label as string,
        intermediateSymbol: r.intermediate_symbol as string,
        direction: r.direction as string,
        sizeSol: Number(r.size_lamports) / LAMPORTS_PER_SOL,
        solDelta: Number(r.sol_delta_lamports) / LAMPORTS_PER_SOL,
        route: r.route as string | null,
      })),
      burnFeed: burnFeed.rows.map((r) => ({
        id: Number(r.id),
        ts: Number(r.ts_ms),
        harvestedStac: Number(r.harvested_atom) / 1e9,
        recoveredStac: Number(r.recovered_atom) / 1e9,
        burnedStac: Number(r.burned_atom) / 1e9,
        navBefore: r.nav_before != null ? Number(r.nav_before) : null,
        navAfter: r.nav_after != null ? Number(r.nav_after) : null,
        candidateCount: Number(r.candidate_count),
      })),
      baitSeries: baitSeries.rows.map((r) => ({
        ts: new Date(r.minute).getTime(),
        sizeSol: Number(r.size_lamports ?? 0) / LAMPORTS_PER_SOL,
        deltaSol: Number(r.sol_delta_lamports ?? 0) / LAMPORTS_PER_SOL,
        costSol: Number(r.cost_lamports ?? 0) / LAMPORTS_PER_SOL,
        profitSol: Number(r.profit_lamports ?? 0) / LAMPORTS_PER_SOL,
        cycles: Number(r.cycles),
      })),
      burnSeries: burnSeries.rows.map((r) => ({
        ts: new Date(r.minute).getTime(),
        harvestedStac: Number(r.harvested_atom ?? 0) / 1e9,
        recoveredStac: Number(r.recovered_atom ?? 0) / 1e9,
        burnedStac: Number(r.burned_atom ?? 0) / 1e9,
        navAfter: r.nav_after != null ? Number(r.nav_after) : null,
        ticks: Number(r.ticks),
      })),
      venueRollup: venueRollup.rows.map((r) => ({
        venueLabel: r.venue_label as string,
        intermediateSymbol: r.intermediate_symbol as string,
        cycles: Number(r.cycles),
        sizeSol: Number(r.size_lamports ?? 0) / LAMPORTS_PER_SOL,
        deltaSol: Number(r.sol_delta_lamports ?? 0) / LAMPORTS_PER_SOL,
        costSol: Number(r.cost_lamports ?? 0) / LAMPORTS_PER_SOL,
        profitSol: Number(r.profit_lamports ?? 0) / LAMPORTS_PER_SOL,
      })),
    })
  } catch (e) {
    console.error('flywheel-feed error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
