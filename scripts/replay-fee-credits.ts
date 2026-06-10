/**
 * One-shot replay for referral_credits + manager_fee_credits.
 *
 * Why this exists:
 *
 *   The original extractCredits in api/referral-index.ts (and the mirror in
 *   api/manager-fee-index.ts) read `balByAta.get(referrerAta)` directly as
 *   the kickback amount. For "clean" 3-party deposits (depositor != referrer
 *   != manager) that's a correct read of the pre→post token-balance delta on
 *   the referrer ATA. But for self-referral (depositor sets themselves as
 *   their own referrer, very common), the referrer ATA *is* the destination
 *   ATA — so its delta includes user_portion + manager_keep + referrer_fee,
 *   ~20–30× the actual kickback.
 *
 *   sumEarnedSol on the leaderboard was therefore wildly overstated (~546
 *   SOL of "earned via referrals" against an expected ~30 SOL of actual
 *   3.45% kickbacks).
 *
 *   The extractors are now fixed (commit before this script). This script
 *   re-fetches every existing row's parsed tx, re-runs the corrected
 *   extraction, and UPDATEs fee_stacsol in place. Once it completes, the
 *   regular ingest-pool-events cron (which aggregates referral_credits +
 *   manager_fee_credits into holder_summary.referral_earned_atom +
 *   manager_fee_earned_atom) will reflect the corrected numbers on its
 *   next run.
 *
 * Usage:
 *   DATABASE_URL=... RPC_URL=... bun run scripts/replay-fee-credits.ts
 *
 *   --dry-run    don't UPDATE, just log corrected values for inspection
 *   --table=ref  only replay referral_credits (default: both)
 *   --table=mgr  only replay manager_fee_credits
 */

import bs58 from 'bs58'
import { Pool } from 'pg'

const POOL_PROGRAM = 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY'
const MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'

const DEPOSIT_SOL_VARIANTS = new Set([14, 24])
const DEPOSITOR_ACCOUNT_INDEX = 3
const DEST_USER_ATA_INDEX = 4
const MANAGER_FEE_ACCOUNT_INDEX = 5
const REFERRER_ACCOUNT_INDEX = 6

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const tableArg =
  [...args].find((a) => a.startsWith('--table='))?.split('=')[1] ?? 'both'
const replayRefs = tableArg === 'ref' || tableArg === 'both'
const replayMgr = tableArg === 'mgr' || tableArg === 'both'

const DATABASE_URL = process.env.DATABASE_URL
const RPC_URL = process.env.RPC_URL ?? 'https://api.mainnet-beta.solana.com'
if (!DATABASE_URL) {
  console.error('DATABASE_URL not set')
  process.exit(1)
}

const pg = new Pool({ connectionString: DATABASE_URL, max: 4 })

function readU64LE(b: Uint8Array, offset: number): bigint {
  let n = 0n
  for (let i = 0; i < 8; i++) n |= BigInt(b[offset + i]) << BigInt(i * 8)
  return n
}

function decodeIxData(data: string | undefined): Uint8Array | null {
  if (!data) return null
  try {
    return bs58.decode(data)
  } catch {
    return null
  }
}

interface ParsedIx {
  programId?: string
  data?: string
  accounts?: string[]
}
interface ParsedTx {
  slot: number
  blockTime: number | null
  meta: {
    err: unknown
    preTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>
    postTokenBalances?: Array<{ accountIndex: number; mint: string; uiTokenAmount: { amount: string } }>
    innerInstructions?: Array<{ instructions: ParsedIx[] }>
  }
  transaction: {
    message: {
      accountKeys: Array<{ pubkey: string }>
      instructions: ParsedIx[]
    }
  }
}

async function getParsedTx(sig: string): Promise<ParsedTx | null> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getTransaction',
    params: [
      sig,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ],
  }
  const r = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) return null
  const j = (await r.json()) as { result?: ParsedTx | null }
  return j.result ?? null
}

function isDepositSolIx(ix: ParsedIx): boolean {
  if (!ix.programId || ix.programId !== POOL_PROGRAM) return false
  if (!ix.data || !ix.accounts) return false
  const bytes = decodeIxData(ix.data)
  if (!bytes || bytes.length < 9) return false
  return DEPOSIT_SOL_VARIANTS.has(bytes[0])
}

interface ExtractedFee {
  feeStacsol: bigint
  candidateIxs: number
}

function computeCorrectedFee(
  tx: ParsedTx,
  leg: 'referrer' | 'manager',
): ExtractedFee {
  if (tx.meta?.err) return { feeStacsol: 0n, candidateIxs: 0 }
  const candidates: ParsedIx[] = []
  for (const ix of tx.transaction.message.instructions) {
    if (isDepositSolIx(ix)) candidates.push(ix)
  }
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      if (isDepositSolIx(ix)) candidates.push(ix)
    }
  }
  if (candidates.length === 0) return { feeStacsol: 0n, candidateIxs: 0 }

  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey)
  const pre = tx.meta?.preTokenBalances ?? []
  const post = tx.meta?.postTokenBalances ?? []
  const balByAta = new Map<string, bigint>()
  for (const p of post) {
    if (p.mint !== MINT) continue
    const ata = accountKeys[p.accountIndex]
    if (!ata) continue
    const preEntry = pre.find(
      (x) => x.accountIndex === p.accountIndex && x.mint === p.mint,
    )
    const before = BigInt(preEntry?.uiTokenAmount.amount ?? '0')
    const after = BigInt(p.uiTokenAmount.amount)
    balByAta.set(ata, after - before)
  }

  // Sum corrected fees across all matching ixs in the tx. Existing row
  // schema (ON CONFLICT (sig) DO NOTHING) only ever stored one row per sig,
  // but multi-ix txs really do have multiple credits — we sum here to
  // approximate the right total even though we collapse back into one row.
  let total = 0n
  for (const ix of candidates) {
    const accs = ix.accounts ?? []
    if (accs.length <= REFERRER_ACCOUNT_INDEX) continue
    const referrerAta = accs[REFERRER_ACCOUNT_INDEX]
    const managerAta = accs[MANAGER_FEE_ACCOUNT_INDEX]
    const destAta = accs[DEST_USER_ATA_INDEX]
    const referrerDelta = balByAta.get(referrerAta) ?? 0n
    const managerDelta = balByAta.get(managerAta) ?? 0n

    let fee: bigint
    if (leg === 'referrer') {
      if (referrerAta === destAta && managerAta !== destAta) fee = managerDelta
      else if (referrerAta === managerAta) fee = referrerDelta / 2n
      else fee = referrerDelta
    } else {
      if (managerAta === destAta && referrerAta !== destAta) fee = referrerDelta
      else if (managerAta === referrerAta) fee = managerDelta / 2n
      else fee = managerDelta
    }
    if (fee > 0n) total += fee
  }
  return { feeStacsol: total, candidateIxs: candidates.length }
}

interface ReplayStats {
  rows: number
  updated: number
  unchanged: number
  zeroed: number
  fetchErrors: number
  beforeTotal: bigint
  afterTotal: bigint
}

async function replayTable(
  table: 'referral_credits' | 'manager_fee_credits',
  leg: 'referrer' | 'manager',
): Promise<ReplayStats> {
  const stats: ReplayStats = {
    rows: 0,
    updated: 0,
    unchanged: 0,
    zeroed: 0,
    fetchErrors: 0,
    beforeTotal: 0n,
    afterTotal: 0n,
  }
  const r = await pg.query(
    `SELECT sig, fee_stacsol::TEXT FROM ${table} ORDER BY slot ASC`,
  )
  stats.rows = r.rows.length
  console.log(`\n=== ${table}: ${stats.rows} rows ===`)

  let i = 0
  for (const row of r.rows) {
    i++
    const sig: string = row.sig
    const oldFee = BigInt(row.fee_stacsol)
    stats.beforeTotal += oldFee
    try {
      const tx = await getParsedTx(sig)
      if (!tx) {
        stats.fetchErrors++
        console.warn(`  [${i}/${stats.rows}] ${sig.slice(0, 8)}… no tx`)
        continue
      }
      const { feeStacsol: newFee } = computeCorrectedFee(tx, leg)
      stats.afterTotal += newFee
      if (newFee === oldFee) {
        stats.unchanged++
      } else if (newFee === 0n) {
        stats.zeroed++
      } else {
        stats.updated++
      }
      if (i % 25 === 0 || i === stats.rows) {
        console.log(
          `  [${i}/${stats.rows}] ${sig.slice(0, 8)}… ` +
            `old=${Number(oldFee) / 1e9} → new=${Number(newFee) / 1e9} stac` +
            ` (${oldFee > 0n ? Number((newFee * 10000n) / oldFee) / 100 : 0}% of old)`,
        )
      }
      if (!dryRun && newFee !== oldFee) {
        await pg.query(
          `UPDATE ${table} SET fee_stacsol = $1 WHERE sig = $2`,
          [newFee.toString(), sig],
        )
      }
    } catch (e) {
      stats.fetchErrors++
      console.error(`  [${i}/${stats.rows}] ${sig.slice(0, 8)}… error:`, (e as Error).message)
    }
  }
  return stats
}

async function main() {
  console.log(`replay starting (dry-run=${dryRun}, table=${tableArg})`)
  if (replayRefs) {
    const s = await replayTable('referral_credits', 'referrer')
    console.log(`\nreferral_credits summary:`)
    console.log(`  rows: ${s.rows}`)
    console.log(`  updated: ${s.updated}, unchanged: ${s.unchanged}, zeroed: ${s.zeroed}, errors: ${s.fetchErrors}`)
    console.log(`  before total: ${Number(s.beforeTotal) / 1e9} stacSOL`)
    console.log(`  after  total: ${Number(s.afterTotal) / 1e9} stacSOL`)
    console.log(`  reduction: ${s.beforeTotal > 0n ? (100 - Number((s.afterTotal * 10000n) / s.beforeTotal) / 100).toFixed(2) : 0}%`)
  }
  if (replayMgr) {
    const s = await replayTable('manager_fee_credits', 'manager')
    console.log(`\nmanager_fee_credits summary:`)
    console.log(`  rows: ${s.rows}`)
    console.log(`  updated: ${s.updated}, unchanged: ${s.unchanged}, zeroed: ${s.zeroed}, errors: ${s.fetchErrors}`)
    console.log(`  before total: ${Number(s.beforeTotal) / 1e9} stacSOL`)
    console.log(`  after  total: ${Number(s.afterTotal) / 1e9} stacSOL`)
    console.log(`  reduction: ${s.beforeTotal > 0n ? (100 - Number((s.afterTotal * 10000n) / s.beforeTotal) / 100).toFixed(2) : 0}%`)
  }
  if (dryRun) {
    console.log(`\n[dry-run] no rows modified. drop --dry-run to commit.`)
  } else {
    console.log(`\ndone. trigger /api/ingest-pool-events to rebuild holder_summary.referral_earned_atom + manager_fee_earned_atom from the corrected rows.`)
  }
  await pg.end()
}

main().catch((e) => {
  console.error('replay failed:', e)
  process.exit(1)
})
