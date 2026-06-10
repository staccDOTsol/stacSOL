import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'

const MARKETING_WALLET = 'Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j'

// Operational wallet: the manager keypair that runs the burn loop, holds
// withdraw-withheld authority, and does mint-flow plumbing for the pool.
// Not a "holder" in any meaningful sense — its mint / burn / transfer
// activity is infrastructure, not user behavior. Always exclude from the
// leaderboard so user counts and aggregates aren't distorted.
const BOT_BURNER_WALLET = 'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb'

const ALLOWED_ORDER_BY: Record<string, string> = {
  pnl_pct: 'pnl_pct',
  pnl_sol: 'pnl_sol',
  total_stac: 'total_stac_atom',
  gross_sol_in: 'gross_sol_in_lamports',
  first_event_at: 'first_event_at',
  last_event_at: 'last_event_at',
}

interface QueryParams {
  orderBy: string
  dir: 'asc' | 'desc'
  search: string | null
  minStac: bigint
  hideUnderwater: boolean
  hideMarketing: boolean
  cursor: string | null
  limit: number
  my: string | null
}

function parseQuery(req: VercelRequest): QueryParams {
  const orderByParam = String(req.query.orderBy ?? 'pnl_sol')
  const orderBy = ALLOWED_ORDER_BY[orderByParam] ? orderByParam : 'pnl_sol'
  const dirParam = String(req.query.dir ?? 'desc').toLowerCase()
  const dir: 'asc' | 'desc' = dirParam === 'asc' ? 'asc' : 'desc'
  const search = req.query.search ? String(req.query.search).trim() : null
  const minStacRaw = String(req.query.minStac ?? '0')
  const minStacFloat = Number(minStacRaw)
  // minStac is in stacSOL UI units; convert to atoms (9 decimals).
  const minStac =
    Number.isFinite(minStacFloat) && minStacFloat > 0
      ? BigInt(Math.floor(minStacFloat * 1e9))
      : 0n
  const hideUnderwater = String(req.query.hideUnderwater ?? 'false') === 'true'
  const hideMarketing = String(req.query.hideMarketing ?? 'false') === 'true'
  const cursor = req.query.cursor ? String(req.query.cursor) : null
  const limit = Math.min(
    Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
    200,
  )
  const my = req.query.my ? String(req.query.my) : null
  return { orderBy, dir, search, minStac, hideUnderwater, hideMarketing, cursor, limit, my }
}

async function fetchLatestSnapshotNav(): Promise<number | null> {
  // Read NAV from the most recent pool_snapshots row instead of an RPC
  // call — @solana/web3.js + rpc-websockets blow up at runtime under
  // Vercel's CJS-Lambda environment (ERR_REQUIRE_ESM on uuid). The
  // /api/snapshot cron refreshes this every 5min, plenty fresh for a
  // leaderboard.
  try {
    const r = await getPool().query(
      `SELECT rate FROM pool_snapshots ORDER BY ts DESC LIMIT 1`,
    )
    if (r.rows.length === 0) return null
    const rate = Number(r.rows[0].rate)
    return Number.isFinite(rate) ? rate : null
  } catch {
    return null
  }
}

interface RawHolderRow {
  wallet: string
  wallet_stac_atom: string
  hawkfi_stac_atom: string
  total_stac_atom: string
  gross_sol_in_lamports: string
  gross_sol_out_lamports: string
  net_sol_in_lamports: string
  pnl_sol: number | null
  pnl_pct: number | null
  burn_net_sol: number | null
  breakeven_nav: number | null
  mint_count: number
  burn_count: number
  referral_earned_atom: string | null
  referral_earned_count: number | null
  manager_fee_earned_atom: string | null
  manager_fee_earned_count: number | null
  earned_sol: number | null
  transferred_out_atom: string | null
  transferred_in_atom: string | null
  transferred_out_sol: number | null
  transferred_in_sol: number | null
  first_at: number | null
  last_at: number | null
  global_rank: number
  is_doxxed: boolean | null
  display_name: string | null
}

function shapeRow(row: RawHolderRow) {
  const referralEarnedAtom = row.referral_earned_atom ?? '0'
  const managerFeeEarnedAtom = row.manager_fee_earned_atom ?? '0'
  const earnedSol = row.earned_sol == null ? 0 : Number(row.earned_sol)
  return {
    rank: row.global_rank,
    wallet: row.wallet,
    walletStacAtom: row.wallet_stac_atom,
    hawkfiStacAtom: row.hawkfi_stac_atom,
    totalStacAtom: row.total_stac_atom,
    grossSolIn: row.gross_sol_in_lamports,
    grossSolOut: row.gross_sol_out_lamports,
    netSolIn: row.net_sol_in_lamports,
    pnlSol: row.pnl_sol == null ? 0 : Number(row.pnl_sol),
    pnlPct: row.pnl_pct == null ? null : Number(row.pnl_pct),
    breakevenNav: row.breakeven_nav == null ? null : Number(row.breakeven_nav),
    burnNetSol: row.burn_net_sol == null ? 0 : Number(row.burn_net_sol),
    mintCount: row.mint_count,
    burnCount: row.burn_count,
    referralEarnedAtom,
    referralEarnedCount: row.referral_earned_count ?? 0,
    managerFeeEarnedAtom,
    managerFeeEarnedCount: row.manager_fee_earned_count ?? 0,
    earnedSol,
    transferredOutAtom: row.transferred_out_atom ?? '0',
    transferredInAtom: row.transferred_in_atom ?? '0',
    transferredOutSol: row.transferred_out_sol == null ? 0 : Number(row.transferred_out_sol),
    transferredInSol: row.transferred_in_sol == null ? 0 : Number(row.transferred_in_sol),
    firstEventAt: row.first_at == null ? 0 : Number(row.first_at),
    lastEventAt: row.last_at == null ? 0 : Number(row.last_at),
    isMarketing: row.wallet === MARKETING_WALLET,
    // Doxx state: when true the client renders the real shortPk(wallet)
    // and any display_name. Otherwise the row shows a stable pseudonym
    // derived from the wallet pubkey (still uniquely identifies the row
    // across re-sorts, but doesn't leak the address).
    isDoxxed: row.is_doxxed === true,
    displayName: row.display_name ?? null,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const q = parseQuery(req)

    // Build the WHERE clause first — these params are used by both the
    // ranked-rows query AND the totals + my-row queries.
    const filterParts: string[] = []
    const filterParams: (string | number)[] = []
    const pushParam = (v: string | number) => {
      filterParams.push(v)
      return `$${filterParams.length}`
    }
    if (q.search) filterParts.push(`wallet ILIKE ${pushParam(`%${q.search}%`)}`)
    if (q.minStac > 0n)
      filterParts.push(`total_stac_atom >= ${pushParam(q.minStac.toString())}::NUMERIC`)
    if (q.hideUnderwater) filterParts.push(`(pnl_sol IS NOT NULL AND pnl_sol >= 0)`)
    if (q.hideMarketing)
      filterParts.push(`wallet <> ${pushParam(MARKETING_WALLET)}`)
    // Always exclude the bot-burner manager keypair — it's protocol
    // infrastructure, not a holder. Including it distorts the holder
    // count and inflates aggregate "transferred out" because the manager
    // is the natural sink for mint-flow withheld stacSOL.
    filterParts.push(`wallet <> ${pushParam(BOT_BURNER_WALLET)}`)
    // Skip rows with zero history AND zero balance (defensive).
    filterParts.push(
      `(total_stac_atom > 0 OR mint_count > 0 OR burn_count > 0)`,
    )
    const whereSql = filterParts.length ? `WHERE ${filterParts.join(' AND ')}` : ''

    const orderCol = ALLOWED_ORDER_BY[q.orderBy]
    const dirSql = q.dir === 'asc' ? 'ASC' : 'DESC'
    const isTimestampCol =
      orderCol === 'first_event_at' || orderCol === 'last_event_at'
    const rankCol = isTimestampCol
      ? `EXTRACT(EPOCH FROM ${orderCol}) * 1000`
      : `${orderCol}::DOUBLE PRECISION`

    // Build the ranked CTE (used by the page query AND the my-row query).
    const rankedCte = `
      SELECT
        wallet,
        wallet_stac_atom::TEXT,
        hawkfi_stac_atom::TEXT,
        total_stac_atom::TEXT,
        gross_sol_in_lamports::TEXT,
        gross_sol_out_lamports::TEXT,
        net_sol_in_lamports::TEXT,
        pnl_sol,
        pnl_pct,
        burn_net_sol,
        breakeven_nav,
        mint_count,
        burn_count,
        referral_earned_atom::TEXT,
        referral_earned_count,
        manager_fee_earned_atom::TEXT,
        manager_fee_earned_count,
        earned_sol,
        transferred_out_atom::TEXT,
        transferred_in_atom::TEXT,
        transferred_out_sol,
        transferred_in_sol,
        EXTRACT(EPOCH FROM first_event_at) * 1000 AS first_at,
        EXTRACT(EPOCH FROM last_event_at) * 1000 AS last_at,
        is_doxxed,
        display_name,
        ROW_NUMBER() OVER (
          ORDER BY ${rankCol} ${dirSql} NULLS LAST, wallet ASC
        )::INT AS global_rank
      FROM holder_summary
      ${whereSql}
    `

    // Cursor pagination: walk the ranked CTE by global_rank. We resolve
    // the cursor wallet's rank in a separate query (cheap — single row
    // lookup by wallet PK with the same filter set).
    let cursorRank = 0
    if (q.cursor) {
      const c = await getPool().query(
        `WITH ranked AS (${rankedCte})
         SELECT global_rank FROM ranked WHERE wallet = $${
           filterParams.length + 1
         }`,
        [...filterParams, q.cursor],
      )
      if (c.rows.length > 0) {
        cursorRank = c.rows[0].global_rank as number
      }
    }

    const pageParams = [...filterParams]
    let pageCursorClause = ''
    if (cursorRank > 0) {
      pageParams.push(cursorRank)
      pageCursorClause = `WHERE global_rank > $${pageParams.length}`
    }
    pageParams.push(q.limit + 1)
    const limitParamIdx = pageParams.length

    const sql = `
      WITH ranked AS (${rankedCte})
      SELECT * FROM ranked
      ${pageCursorClause}
      ORDER BY global_rank ASC
      LIMIT $${limitParamIdx}
    `
    const r = await getPool().query(sql, pageParams)
    const rows = r.rows.slice(0, q.limit).map((row) => shapeRow(row as RawHolderRow))
    const nextCursor =
      r.rows.length > q.limit ? (r.rows[q.limit] as RawHolderRow).wallet : null

    // Totals across the *filtered* set.
    //
    // IMPORTANT — `pnl_sol` already values referral / manager-fee kickbacks
    // through `total_stac_atom × NAV × 0.931` (held kickbacks) and
    // `gross_sol_out_lamports` (burned kickbacks). The previous design
    // exposed `sum_pnl_adj = SUM(pnl_sol + earned_sol)` and a profitable/
    // underwater count based on the same `pnl_sol + earned_sol` predicate —
    // both double-counted referral credits and inflated the aggregate
    // numbers by exactly the SOL-value of all kickbacks the protocol
    // had paid out.
    //
    // We now report `sum_pnl_adj == sum_pnl` (kept as a field for client
    // compatibility) and use `pnl_sol` alone for the profitable / underwater
    // counters. `sum_earned_sol` remains as a separate attribution number
    // — "of the aggregate P&L, this much came from free credits" — but it
    // is no longer added on top.
    const totalsSql = `
      SELECT
        COUNT(*)::INT                                                  AS holders,
        COALESCE(SUM(total_stac_atom), 0)::TEXT                        AS sum_stac,
        COALESCE(SUM(gross_sol_in_lamports), 0)::TEXT                  AS sum_in,
        COALESCE(SUM(referral_earned_atom + manager_fee_earned_atom), 0)::TEXT AS sum_earned_atom,
        COALESCE(SUM(earned_sol), 0)::DOUBLE PRECISION                 AS sum_earned_sol,
        COALESCE(SUM(pnl_sol), 0)::DOUBLE PRECISION                    AS sum_pnl_adj,
        COALESCE(SUM(pnl_sol), 0)::DOUBLE PRECISION                    AS sum_pnl,
        COALESCE(AVG(pnl_pct), 0)::DOUBLE PRECISION                    AS avg_pnl_pct,
        COALESCE(SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END), 0)::INT AS profitable,
        COALESCE(SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END), 0)::INT AS underwater,
        COALESCE(SUM(CASE WHEN pnl_sol > 0 THEN 1 ELSE 0 END), 0)::INT AS paid_profitable,
        COALESCE(SUM(CASE WHEN pnl_sol < 0 THEN 1 ELSE 0 END), 0)::INT AS paid_underwater
      FROM holder_summary
      ${whereSql}
    `
    const totals = await getPool().query(totalsSql, filterParams)

    let myRow: ReturnType<typeof shapeRow> | null = null
    if (q.my) {
      const mySql = `
        WITH ranked AS (${rankedCte})
        SELECT * FROM ranked WHERE wallet = $${filterParams.length + 1} LIMIT 1
      `
      const m = await getPool().query(mySql, [...filterParams, q.my])
      if (m.rows.length > 0) {
        myRow = shapeRow(m.rows[0] as RawHolderRow)
      }
    }

    const rate = await fetchLatestSnapshotNav()

    res.setHeader(
      'Cache-Control',
      'public, max-age=30, s-maxage=30, stale-while-revalidate=60',
    )
    res.status(200).json({
      rows,
      totals: {
        holders: totals.rows[0]?.holders ?? 0,
        totalStacAtom: totals.rows[0]?.sum_stac ?? '0',
        sumGrossIn: totals.rows[0]?.sum_in ?? '0',
        sumEarnedAtom: totals.rows[0]?.sum_earned_atom ?? '0',
        sumEarnedSol: Number(totals.rows[0]?.sum_earned_sol ?? 0),
        sumPnlSol: Number(totals.rows[0]?.sum_pnl ?? 0),
        sumPnlSolAdj: Number(totals.rows[0]?.sum_pnl_adj ?? 0),
        avgPnlPct: Number(totals.rows[0]?.avg_pnl_pct ?? 0),
        profitableCount: totals.rows[0]?.profitable ?? 0,
        underwaterCount: totals.rows[0]?.underwater ?? 0,
        paidProfitableCount: totals.rows[0]?.paid_profitable ?? 0,
        paidUnderwaterCount: totals.rows[0]?.paid_underwater ?? 0,
      },
      rate,
      asOf: Date.now(),
      nextCursor,
      my: myRow,
    })
  } catch (e) {
    console.error('holders-leaderboard error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
