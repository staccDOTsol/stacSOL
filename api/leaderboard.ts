import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'

const MARKETING_REFERRER = 'Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j'

// 6.9% Token-2022 transfer fee on stacSOL. When converting stacSOL atoms
// to "realizable SOL", we apply (1 - fee) to the NAV — that's what a holder
// would actually receive on burn (the transfer fee is withheld + burned).
const STAC_TRANSFER_FEE_BPS = 690
const STAC_PAYOUT_FRACTION = (10_000 - STAC_TRANSFER_FEE_BPS) / 10_000

async function fetchLatestNav(): Promise<number | null> {
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const limit = Math.min(
      Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1),
      500,
    )
    const includeMarketing = String(req.query.includeMarketing ?? 'true') !== 'false'

    const where = includeMarketing ? '' : 'WHERE rc.referrer != $2'
    const params: (string | number)[] = [limit]
    if (!includeMarketing) params.push(MARKETING_REFERRER)

    // LEFT JOIN holder_summary so each referrer row carries is_doxxed +
    // display_name. Referrers who never held / interacted on-chain won't
    // have a holder_summary row — those fall back to is_doxxed=false.
    const sql = `
      SELECT
        rc.referrer,
        SUM(rc.fee_stacsol)::TEXT       AS fee_stacsol,
        SUM(rc.sol_lamports)::TEXT      AS sol_referred,
        COUNT(*)::INT                   AS deposits,
        COUNT(DISTINCT rc.depositor)::INT AS unique_depositors,
        EXTRACT(EPOCH FROM MIN(rc.ts)) * 1000 AS first_at,
        EXTRACT(EPOCH FROM MAX(rc.ts)) * 1000 AS last_at,
        COALESCE(hs.is_doxxed, FALSE)   AS is_doxxed,
        hs.display_name                  AS display_name
      FROM referral_credits rc
      LEFT JOIN holder_summary hs ON hs.wallet = rc.referrer
      ${where}
      GROUP BY rc.referrer, hs.is_doxxed, hs.display_name
      ORDER BY SUM(rc.fee_stacsol) DESC
      LIMIT $1
    `
    const r = await getPool().query(sql, params)

    const totalSql = `
      SELECT
        COUNT(*)::INT             AS total_deposits,
        COUNT(DISTINCT referrer)::INT AS total_referrers,
        COUNT(DISTINCT depositor)::INT AS total_depositors,
        SUM(fee_stacsol)::TEXT    AS total_fee_stacsol,
        SUM(sol_lamports)::TEXT   AS total_sol_referred
      FROM referral_credits
    `
    const totals = await getPool().query(totalSql)

    const navRate = await fetchLatestNav()

    res.setHeader(
      'Cache-Control',
      'public, max-age=30, s-maxage=30, stale-while-revalidate=120',
    )
    res.status(200).json({
      marketingReferrer: MARKETING_REFERRER,
      navRate, // SOL per stacSOL, used client-side to value fee_stacsol
      payoutFraction: STAC_PAYOUT_FRACTION, // 0.931 — captures the 6.9% T22 fee
      totals: {
        deposits: totals.rows[0]?.total_deposits ?? 0,
        referrers: totals.rows[0]?.total_referrers ?? 0,
        depositors: totals.rows[0]?.total_depositors ?? 0,
        feeStacsol: totals.rows[0]?.total_fee_stacsol ?? '0',
        solReferred: totals.rows[0]?.total_sol_referred ?? '0',
      },
      rows: r.rows.map((row, i) => ({
        rank: i + 1,
        referrer: row.referrer,
        feeStacsol: row.fee_stacsol,
        solReferred: row.sol_referred,
        deposits: row.deposits,
        uniqueDepositors: row.unique_depositors,
        firstAt: Number(row.first_at),
        lastAt: Number(row.last_at),
        isMarketing: row.referrer === MARKETING_REFERRER,
        isDoxxed: row.is_doxxed === true,
        displayName: row.display_name ?? null,
      })),
    })
  } catch (e) {
    console.error('leaderboard error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
