import type { VercelRequest, VercelResponse } from '@vercel/node'
import {
  deriveAssociatedTokenAddress,
  findProgramAddressSync,
  getMultipleAccountsBase64,
  getParsedTransaction,
  getSignaturesForAddress,
  decodeAccountData,
  type ParsedTransactionRpc,
  type ParsedInstructionRpc,
  type SignatureInfo,
} from './_solana-rpc.js'

import { ensureSchema, getPool } from './_db.js'

// SOL-denominated price endpoint for stacSOL + wstacSOL via canonical
// Sanctum SPL stake-pool math.
//
//   NAV = pool.total_lamports / pool.pool_token_supply        (SOL / stacSOL)
//   price(stacSOL)  = NAV
//   price(wstacSOL) = NAV × (1 − transferFeeBps/10000)
//
// The wstacSOL discount captures the 6.9% Token-2022 transfer fee that
// fires on the vault → user leg of an unwrap. 1 wstacSOL → unwrap → 0.931
// stacSOL → × NAV = realizable SOL.
//
// Backed by pool_snapshots by default (5-min cron, postgres-cheap). Pass
// `?live=true` to read pool state directly off-chain via RPC instead.

const POOL = new RpcPubkey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSTACSOL_MINT = 'GB2Y9s7N9HcpCmrqyByygMfRsJDLH1Gt7wasTtczohYL'

const TRANSFER_FEE_BPS = 690 // 6.9% Token-2022 fee on stacSOL transfers
const PAYOUT_FRACTION = (10_000 - TRANSFER_FEE_BPS) / 10_000

interface NavSnapshot {
  navSol: number
  totalLamports: string
  poolTokenSupply: string
  lastUpdateEpoch: number
  asOfMs: number
  source: 'snapshot' | 'live-rpc'
}

async function fetchLatestNavFromSnapshots(): Promise<NavSnapshot | null> {
  try {
    await ensureSchema()
    const r = await getPool().query(
      `SELECT
        total_lamports::TEXT          AS total_lamports,
        pool_token_supply::TEXT       AS pool_token_supply,
        last_update_epoch             AS last_update_epoch,
        rate                          AS rate,
        EXTRACT(EPOCH FROM ts) * 1000 AS ts_ms
       FROM pool_snapshots
       ORDER BY ts DESC
       LIMIT 1`,
    )
    if (r.rows.length === 0) return null
    const row = r.rows[0] as {
      total_lamports: string
      pool_token_supply: string
      last_update_epoch: number
      rate: number
      ts_ms: number
    }
    return {
      navSol: Number(row.rate),
      totalLamports: row.total_lamports,
      poolTokenSupply: row.pool_token_supply,
      lastUpdateEpoch: Number(row.last_update_epoch),
      asOfMs: Number(row.ts_ms),
      source: 'snapshot',
    }
  } catch {
    return null
  }
}

import {
  RpcPubkey,
  getAccountInfoBase64,
} from './_solana-rpc.js'

async function fetchLiveNav(rpcUrl: string): Promise<NavSnapshot> {
  // Fetch raw account data over RPC
  // POOL should be a string representing the public key, not RpcPubkey
  const acc = await getAccountInfoBase64(rpcUrl, POOL.toString())
  if (!acc || typeof acc.data !== 'string') throw new Error('pool account not found or malformed')

  // acc.data is a base64-encoded string, decode it as a Buffer
  const d = Buffer.from(acc.data, 'base64')

  // Read u64 values out of the buffer at the proper offsets
  const totalLamports = d.readBigUInt64LE(258)
  const poolTokenSupply = d.readBigUInt64LE(266)
  const lastUpdateEpoch = d.readBigUInt64LE(274)
  const nav =
    poolTokenSupply > 0n ? Number(totalLamports) / Number(poolTokenSupply) : 1

  return {
    navSol: nav,
    totalLamports: totalLamports.toString(),
    poolTokenSupply: poolTokenSupply.toString(),
    lastUpdateEpoch: Number(lastUpdateEpoch),
    asOfMs: Date.now(),
    source: 'live-rpc',
  }
}
async function fetchSolPriceUs(): Promise<number | null> {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')
  if (!r.ok) return null
  const j = await r.json()
  return j.solana.usd
}
export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const live = String(req.query.live ?? '') === 'true'
    let snap: NavSnapshot | null = null
    if (live) {
      const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
      snap = await fetchLiveNav(rpcUrl)
    } else {
      snap = await fetchLatestNavFromSnapshots()
      if (!snap) {
        // Fallback to live if postgres has no rows yet (cold start, fresh deploy).
        const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
        snap = await fetchLiveNav(rpcUrl)
      }
    }

    const stacsolPriceSol = snap.navSol
    const wstacsolPriceSol = snap.navSol * PAYOUT_FRACTION

    res.setHeader(
      'Cache-Control',
      'public, max-age=15, s-maxage=15, stale-while-revalidate=60',
    )
    const priceUsdc = await fetchSolPriceUs()
    if (!priceUsdc) {
      return res.status(500).json({ ok: false, error: 'Failed to fetch SOL price' })
    } 
    const priceStacsolUsdc = priceUsdc * stacsolPriceSol
    res.status(200).send( priceStacsolUsdc )  
  } catch (e) {
    console.error('price error:', e)
    res.status(500).send({ ok: false, error: (e as Error).message })
  }
}
