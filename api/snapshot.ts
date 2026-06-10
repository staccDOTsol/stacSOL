import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ensureSchema, getPool } from './_db.js'
import { fetchAllStacsolMarkets, pickLpPriceSol } from './_birdeye.js'
import {
  decodeAccountData,
  getAccountInfoBase64,
} from './_solana-rpc.js'

const POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'
const MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'

// Get the deepest SOL-paired LP price (excluding the Sanctum protocol pool
// itself, which would just be NAV). Falls back to null on any error so the
// snapshot still records pool state even if Birdeye is down.
async function fetchLpPriceSol(): Promise<number | null> {
  try {
    const apiKey = process.env.BIRDEYE_API_KEY
    if (!apiKey) return null
    const markets = await fetchAllStacsolMarkets(apiKey)
    const fromMarkets = pickLpPriceSol(markets)
    if (fromMarkets != null && isFinite(fromMarkets) && fromMarkets > 0) {
      return fromMarkets
    }
    const jup = process.env.JUPITER_API_KEY
    if (!jup) return null
    const q = await fetch(
      'https://api.jup.ag/swap/v1/quote' +
        '?inputMint=' + MINT +
        '&outputMint=So11111111111111111111111111111111111111112' +
        '&amount=1000000000' +
        '&slippageBps=500' +
        '&swapMode=ExactIn',
      { headers: { 'x-api-key': jup }, signal: AbortSignal.timeout(8000) },
    )
    if (!q.ok) return null
    const j = (await q.json()) as { outAmount?: string }
    if (!j.outAmount) return null
    return Number(j.outAmount) / 1e9
  } catch {
    return null
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const endpoint = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'

    const [poolAcc, mintAcc, lpPriceSol] = await Promise.all([
      getAccountInfoBase64(endpoint, POOL, 'processed'),
      getAccountInfoBase64(endpoint, MINT, 'processed'),
      fetchLpPriceSol(),
    ])
    if (!poolAcc) throw new Error('pool not found')
    if (!mintAcc) throw new Error('mint not found')

    const d = decodeAccountData(poolAcc)
    const reserveStakeBytes = d.subarray(130, 162)
    // Encode reserveStake as base58 string for the follow-up RPC call.
    const reserveStake = bytesToBase58(reserveStakeBytes)
    const totalLamports = d.readBigUInt64LE(258)
    const poolTokenSupply = d.readBigUInt64LE(266)
    const lastUpdateEpoch = d.readBigUInt64LE(274)

    const reserveAcc = await getAccountInfoBase64(endpoint, reserveStake, 'processed')
    if (!reserveAcc) throw new Error('reserve not found')

    const reserveLamports = BigInt(reserveAcc.lamports)
    const mintBuf = decodeAccountData(mintAcc)
    const mintSupply = mintBuf.readBigUInt64LE(36)
    const rate = Number(totalLamports) / Number(poolTokenSupply || 1n)

    await getPool().query(
      `INSERT INTO pool_snapshots
        (total_lamports, pool_token_supply, mint_supply, reserve_lamports, rate, last_update_epoch, lp_price_sol)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        totalLamports.toString(),
        poolTokenSupply.toString(),
        mintSupply.toString(),
        reserveLamports.toString(),
        rate,
        Number(lastUpdateEpoch),
        lpPriceSol,
      ],
    )

    res.status(200).json({
      ok: true,
      ts: new Date().toISOString(),
      rate,
      lp_price_sol: lpPriceSol,
      total_lamports: totalLamports.toString(),
      pool_token_supply: poolTokenSupply.toString(),
      mint_supply: mintSupply.toString(),
      reserve_lamports: reserveLamports.toString(),
    })
  } catch (e) {
    console.error('snapshot error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}

// Inline base58 encoder (no external dep beyond what we already import via
// _solana-rpc -> bs58). Imported lazily here to keep the top of the file
// dep-free.
import bs58 from 'bs58'
function bytesToBase58(b: Uint8Array): string {
  return bs58.encode(b)
}
