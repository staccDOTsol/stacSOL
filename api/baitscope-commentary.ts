import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'

// /api/baitscope-commentary
//
// Returns a 1-3 sentence observation over the bait/burn loop's recent
// activity. Two modes:
//   • If ANTHROPIC_API_KEY is set in env, calls Claude Haiku 4.5 with a
//     compact summary of the last `windowMin` minutes and returns its
//     natural-language read.
//   • Otherwise computes a deterministic summary so the dashboard panel
//     always has content.
//
// POST {windowMin?: number}. windowMin default 60, max 1440.

const LAMPORTS_PER_SOL = 1_000_000_000
const T22_FEE_RATE = 0.069

interface SummaryStats {
  windowMin: number
  cycles: number
  cycleProfits: number
  cycleCosts: number
  netSol: number
  totalSizeSol: number
  topVenue: { label: string; deltaSol: number; cycles: number } | null
  worstVenue: { label: string; deltaSol: number; cycles: number } | null
  transferVolumeStac: number
  arbVolumeStac: number
  baitVolumeStac: number
  arbSharePct: number
  burnedStac: number
  burnedSolValue: number
  arbBurnedSol: number
  navDelta: number | null
  navStart: number | null
  navEnd: number | null
  outstandingSol: number
}

async function computeStats(windowMin: number): Promise<SummaryStats> {
  await ensureSchema()
  const pool = getPool()
  const [bait, burn, state, navWindow] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) AS cycles,
              SUM(size_lamports) AS size_l,
              SUM(sol_delta_lamports) AS delta_l,
              SUM(CASE WHEN sol_delta_lamports > 0 THEN sol_delta_lamports ELSE 0 END) AS cost_l,
              SUM(CASE WHEN sol_delta_lamports < 0 THEN -sol_delta_lamports ELSE 0 END) AS profit_l
         FROM bait_events
        WHERE ts > NOW() - ($1::int * INTERVAL '1 minute')`,
      [windowMin],
    ),
    pool.query(
      `SELECT SUM(harvested_atom) AS harvested,
              SUM(burned_atom) AS burned,
              SUM(recovered_atom) AS recovered
         FROM burn_events
        WHERE ts > NOW() - ($1::int * INTERVAL '1 minute')`,
      [windowMin],
    ),
    pool.query(
      `SELECT outstanding_bait_cost_lamports::text AS outstanding
         FROM manager_state WHERE id = 1`,
    ),
    pool.query(
      `SELECT
         (SELECT nav_after FROM burn_events
            WHERE ts > NOW() - ($1::int * INTERVAL '1 minute') AND nav_after IS NOT NULL
            ORDER BY ts ASC LIMIT 1) AS nav_start,
         (SELECT nav_after FROM burn_events
            WHERE nav_after IS NOT NULL
            ORDER BY ts DESC LIMIT 1) AS nav_end`,
      [windowMin],
    ),
  ])
  const venues = await pool.query(
    `SELECT venue_label, COUNT(*)::int AS cycles, SUM(sol_delta_lamports) AS delta_l
       FROM bait_events
      WHERE ts > NOW() - ($1::int * INTERVAL '1 minute')
      GROUP BY venue_label
      ORDER BY delta_l ASC NULLS LAST`,
    [windowMin],
  )

  const r = bait.rows[0]
  const b = burn.rows[0]
  const w = navWindow.rows[0]
  const cycles = Number(r?.cycles ?? 0)
  const cycleCosts = Number(r?.cost_l ?? 0) / LAMPORTS_PER_SOL
  const cycleProfits = Number(r?.profit_l ?? 0) / LAMPORTS_PER_SOL
  const netSol = -(Number(r?.delta_l ?? 0) / LAMPORTS_PER_SOL)
  const totalSizeSol = Number(r?.size_l ?? 0) / LAMPORTS_PER_SOL
  const harvested = Number(b?.harvested ?? 0)
  const burned = Number(b?.burned ?? 0)
  const transferVolumeStac = harvested / T22_FEE_RATE / 1e9
  const navStart = w?.nav_start != null ? Number(w.nav_start) : null
  const navEnd = w?.nav_end != null ? Number(w.nav_end) : null
  const navForAtt = navEnd ?? navStart ?? 1
  const baitStacAtoms = navForAtt > 0 ? (totalSizeSol * LAMPORTS_PER_SOL) / navForAtt : 0
  // ~1 leg per cycle hits a non-manager ATA (see flywheel-feed.ts).
  const baitWithholdAtoms = baitStacAtoms * 1 * T22_FEE_RATE
  const arbWithholdAtoms = Math.max(0, harvested - baitWithholdAtoms)
  const arbShare = harvested > 0 ? arbWithholdAtoms / harvested : 0
  const baitVolumeStac = baitWithholdAtoms / T22_FEE_RATE / 1e9
  const arbVolumeStac = arbWithholdAtoms / T22_FEE_RATE / 1e9
  const burnedStac = burned / 1e9
  const burnedSolValue = burnedStac * navForAtt
  const arbBurnedSol = burnedSolValue * arbShare

  const venuesList = venues.rows.map((row) => ({
    label: row.venue_label as string,
    deltaSol: -(Number(row.delta_l ?? 0) / LAMPORTS_PER_SOL),
    cycles: Number(row.cycles),
  }))
  const topVenue = venuesList[venuesList.length - 1] ?? null
  const worstVenue = venuesList[0] ?? null

  const outstandingSol = state.rows[0]
    ? Number(state.rows[0].outstanding) / LAMPORTS_PER_SOL
    : 0

  return {
    windowMin,
    cycles,
    cycleProfits,
    cycleCosts,
    netSol,
    totalSizeSol,
    topVenue,
    worstVenue,
    transferVolumeStac,
    arbVolumeStac,
    baitVolumeStac,
    arbSharePct: arbShare * 100,
    burnedStac,
    burnedSolValue,
    arbBurnedSol,
    navDelta: navStart && navEnd ? navEnd - navStart : null,
    navStart,
    navEnd,
    outstandingSol,
  }
}

function fallbackCommentary(s: SummaryStats): string {
  if (s.cycles === 0) {
    return `No bait cycles recorded in the last ${s.windowMin}m. Daemon may be idle or warming up.`
  }
  const parts: string[] = []
  parts.push(
    `${s.cycles} cycles in ${s.windowMin}m churned ${s.totalSizeSol.toFixed(2)} SOL through cross-pair LPs, ` +
      `${s.netSol >= 0 ? 'netting +' + s.netSol.toFixed(4) : 'costing ' + (-s.netSol).toFixed(4)} SOL on the wallet.`,
  )
  if (s.transferVolumeStac > 0) {
    parts.push(
      `Total transfer-fee volume ≈ ${s.transferVolumeStac.toFixed(3)} stacSOL — ` +
        `${s.arbSharePct.toFixed(0)}% from third-party flow ` +
        `(${s.arbVolumeStac.toFixed(3)} stacSOL).`,
    )
  }
  if (s.burnedStac > 0) {
    parts.push(
      `Burned ${s.burnedStac.toFixed(4)} stacSOL (≈${s.burnedSolValue.toFixed(4)} SOL NAV fuel), ` +
        `of which ${s.arbBurnedSol.toFixed(4)} SOL was arb-attributed NAV growth.`,
    )
  }
  if (s.navDelta != null && Math.abs(s.navDelta) > 1e-6) {
    parts.push(
      `NAV ${s.navDelta > 0 ? '+' : ''}${(s.navDelta * 1e6).toFixed(1)} micro-SOL ` +
        `(${s.navStart?.toFixed(6)} → ${s.navEnd?.toFixed(6)}).`,
    )
  }
  return parts.join(' ')
}

async function claudeCommentary(s: SummaryStats, apiKey: string): Promise<string | null> {
  const prompt =
    `You are the analyst for stacSOL's "baitscope" dashboard — a Token-2022 LST with a 6.9% transfer fee that gets swept into a burn loop, raising NAV per token over time. ` +
    `An imbalance daemon ("bait-loop") deliberately churns stacSOL through cross-pair LPs (Staccana, PROOFV3, USDC, etc.) to create arbitrage opportunities. ` +
    `Every transfer through those pools fires the 6.9% T22 fee — both ours and any third-party arber's. Burn-loop sweeps the withheld stacSOL, recovers SOL to repay bait cost, and burns the excess.\n\n` +
    `Here's the last ${s.windowMin}-minute summary:\n` +
    `• Bait cycles: ${s.cycles} (size ${s.totalSizeSol.toFixed(3)} SOL total, net ${s.netSol >= 0 ? '+' : ''}${s.netSol.toFixed(4)} SOL)\n` +
    `• Total transfer volume: ${s.transferVolumeStac.toFixed(4)} stacSOL\n` +
    `• Our bait volume: ${s.baitVolumeStac.toFixed(4)} stacSOL · arb+organic volume: ${s.arbVolumeStac.toFixed(4)} stacSOL (${s.arbSharePct.toFixed(1)}%)\n` +
    `• Burned: ${s.burnedStac.toFixed(4)} stacSOL ≈ ${s.burnedSolValue.toFixed(4)} SOL NAV fuel\n` +
    `• Arb-attributed NAV gain: ${s.arbBurnedSol.toFixed(4)} SOL\n` +
    `• NAV: ${s.navStart?.toFixed(6) ?? '?'} → ${s.navEnd?.toFixed(6) ?? '?'}\n` +
    `• Top venue: ${s.topVenue ? `${s.topVenue.label} (${s.topVenue.deltaSol >= 0 ? '+' : ''}${s.topVenue.deltaSol.toFixed(4)} SOL across ${s.topVenue.cycles} cycles)` : 'n/a'}\n` +
    `• Worst venue: ${s.worstVenue && s.worstVenue !== s.topVenue ? `${s.worstVenue.label} (${s.worstVenue.deltaSol >= 0 ? '+' : ''}${s.worstVenue.deltaSol.toFixed(4)} SOL across ${s.worstVenue.cycles} cycles)` : 'n/a'}\n` +
    `• Outstanding bait backlog: ${s.outstandingSol.toFixed(4)} SOL\n\n` +
    `Write 2-3 sentences: what's happening right now, is the flywheel healthy, and one thing worth watching. Be direct, no marketing fluff, no emojis. Use plain language for the operator skimming this on phone. If something looks broken or off (huge backlog, no arb share, NAV stalled while volume is high), call it out.`

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      console.error('claude commentary error', r.status, txt.slice(0, 200))
      return null
    }
    const j = (await r.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = j.content?.find((b) => b.type === 'text')?.text
    return text ? text.trim() : null
  } catch (e) {
    console.error('claude commentary fetch failed', e)
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const body =
      req.method === 'POST'
        ? ((typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as {
            windowMin?: number
          })
        : { windowMin: undefined }
    const windowMin = Math.min(Math.max(Number(body?.windowMin ?? 60) || 60, 1), 1440)
    const stats = await computeStats(windowMin)
    const apiKey = process.env.ANTHROPIC_API_KEY
    let commentary: string | null = null
    let source: 'claude' | 'fallback' = 'fallback'
    if (apiKey) {
      commentary = await claudeCommentary(stats, apiKey)
      if (commentary) source = 'claude'
    }
    if (!commentary) commentary = fallbackCommentary(stats)
    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({ ok: true, commentary, source, stats })
  } catch (e) {
    console.error('baitscope-commentary error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
