import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool, LIVE_NAV_SQL } from './_db.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '500'), 10) || 500, 1), 5000)
    // Optional `since` param: ms epoch — return snapshots newer than this.
    const sinceMs = parseInt(String(req.query.since ?? '0'), 10) || 0

    // rate is computed at read time (LIVE_NAV_SQL) from the raw chain-read
    // columns, never trusted from the stored column — see _db.ts.
    const sql = sinceMs > 0
      ? `SELECT id, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms,
                 total_lamports, pool_token_supply, mint_supply,
                 reserve_lamports, ${LIVE_NAV_SQL} AS rate,
                 last_update_epoch, lp_price_sol
         FROM pool_snapshots
         WHERE ts > to_timestamp($2 / 1000.0)
         ORDER BY ts ASC
         LIMIT $1`
      : `SELECT * FROM (
           SELECT id, EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms,
                  total_lamports, pool_token_supply, mint_supply,
                  reserve_lamports, ${LIVE_NAV_SQL} AS rate,
                  last_update_epoch, lp_price_sol
           FROM pool_snapshots
           ORDER BY ts DESC
           LIMIT $1
         ) sub ORDER BY ts_ms ASC`
    const params = sinceMs > 0 ? [limit, sinceMs] : [limit]
    const r = await getPool().query(sql, params)

    // Cache aggressively — snapshots only change every few minutes.
    res.setHeader('Cache-Control', 'public, max-age=10, s-maxage=10, stale-while-revalidate=60')
    res.status(200).json(
      r.rows.map((row) => ({
        ts: Number(row.ts_ms),
        totalLamports: row.total_lamports,
        poolTokenSupply: row.pool_token_supply,
        mintSupply: row.mint_supply,
        reserveLamports: row.reserve_lamports,
        rate: row.rate,
        lastUpdateEpoch: Number(row.last_update_epoch),
        lpPriceSol: row.lp_price_sol != null ? Number(row.lp_price_sol) : null,
      })),
    )
  } catch (e) {
    console.error('history error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
