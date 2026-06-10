import type { VercelRequest, VercelResponse } from '@vercel/node'
import bs58 from 'bs58'
import { ensureSchema, getPool } from './_db.js'
import {
  RpcPubkey,
  getMultipleAccountsBase64,
  getParsedTransaction,
  getSignaturesForAddress,
  type ParsedTransactionRpc,
  type ParsedInstructionRpc,
  type SignatureInfo,
} from './_solana-rpc.js'

// Mirror of api/referral-index.ts but for the *manager fee* leg of every
// DepositSol — i.e. account index 5 (manager_fee_ata). Lets us track who's
// been earning protocol fees in stacSOL form without paying any SOL for
// them. Surfaced separately in the leaderboard so we can distinguish
// "earned via the protocol's deposit-fee mechanism" from "bought stacSOL
// with SOL".
const POOL_PROGRAM = 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY'
const POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'
const MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'

const DEPOSIT_SOL_VARIANTS = new Set([14, 24])
const DEPOSITOR_ACCOUNT_INDEX = 3
const DEST_USER_ATA_INDEX = 4
const MANAGER_FEE_ACCOUNT_INDEX = 5
const REFERRER_ACCOUNT_INDEX = 6

const MAX_SIGS_PER_PASS = 150
const MAX_TX_RPC_CONCURRENCY = 5

interface IndexerCursor {
  newest_sig: string | null
  oldest_sig: string | null
  backfill_done: boolean
}

interface ManagerFeeRow {
  sig: string
  ixIndex: number
  slot: number
  ts: Date
  manager: string
  managerFeeAta: string
  depositor: string
  solLamports: bigint
  feeStacsol: bigint
}

function decodeIxData(data: string | undefined): Uint8Array | null {
  if (!data) return null
  try {
    return bs58.decode(data)
  } catch {
    return null
  }
}

function readU64LE(b: Uint8Array, offset: number): bigint {
  let n = 0n
  for (let i = 0; i < 8; i++) n |= BigInt(b[offset + i]) << BigInt(i * 8)
  return n
}

function isDepositSolIx(ix: ParsedInstructionRpc): boolean {
  if (!ix.programId || ix.programId !== POOL_PROGRAM) return false
  if (!ix.data || !ix.accounts) return false
  const bytes = decodeIxData(ix.data)
  if (!bytes || bytes.length < 9) return false
  return DEPOSIT_SOL_VARIANTS.has(bytes[0])
}

async function loadCursor(): Promise<IndexerCursor> {
  await getPool().query(
    `CREATE TABLE IF NOT EXISTS manager_fee_index_state (
       id INT PRIMARY KEY DEFAULT 1,
       newest_sig TEXT,
       oldest_sig TEXT,
       backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );
     INSERT INTO manager_fee_index_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;`,
  )
  const r = await getPool().query(
    'SELECT newest_sig, oldest_sig, backfill_done FROM manager_fee_index_state WHERE id = 1',
  )
  const row = r.rows[0]
  return {
    newest_sig: row?.newest_sig ?? null,
    oldest_sig: row?.oldest_sig ?? null,
    backfill_done: row?.backfill_done ?? false,
  }
}

async function saveCursor(c: IndexerCursor): Promise<void> {
  await getPool().query(
    `UPDATE manager_fee_index_state
     SET newest_sig = $1, oldest_sig = $2, backfill_done = $3, updated_at = NOW()
     WHERE id = 1`,
    [c.newest_sig, c.oldest_sig, c.backfill_done],
  )
}

function extractCredits(sig: string, tx: ParsedTransactionRpc): ManagerFeeRow[] {
  if (tx.meta?.err) return []
  const candidates: ParsedInstructionRpc[] = []
  const top = tx.transaction.message.instructions
  for (const ix of top) if (isDepositSolIx(ix)) candidates.push(ix)
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) if (isDepositSolIx(ix)) candidates.push(ix)
  }
  if (candidates.length === 0) return []

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

  // Pre-compute per-ATA total deposit lamports across all candidate ixs
  // in this tx. Same reasoning as referral-index: when a tx has multiple
  // DepositSol ixs crediting the same manager (or referrer) ATA, the
  // pre/post token-balance delta on that ATA is the SUM of every
  // contributing kickback. The PK on manager_fee_credits is already
  // (sig, ix_index) so we DID insert N rows, but each row carried the
  // full tx-wide delta — i.e. fee was over-counted ×N for multi-ix txs.
  // Proportional split by deposit lamports restores per-ix accuracy
  // (NAV is constant within a single tx, so lamports ratio = fee ratio).
  const lampsByManagerAta = new Map<string, bigint>()
  const lampsByReferrerAta = new Map<string, bigint>()
  for (const ix of candidates) {
    const accs = ix.accounts ?? []
    if (accs.length <= REFERRER_ACCOUNT_INDEX) continue
    const bytes = decodeIxData(ix.data)
    if (!bytes) continue
    const lams = readU64LE(bytes, 1)
    const mAta = accs[MANAGER_FEE_ACCOUNT_INDEX]
    const rAta = accs[REFERRER_ACCOUNT_INDEX]
    if (mAta) lampsByManagerAta.set(mAta, (lampsByManagerAta.get(mAta) ?? 0n) + lams)
    if (rAta) lampsByReferrerAta.set(rAta, (lampsByReferrerAta.get(rAta) ?? 0n) + lams)
  }
  const splitDelta = (delta: bigint, totalAtaLamps: bigint, ixLamps: bigint): bigint => {
    if (totalAtaLamps <= 0n) return delta
    return (delta * ixLamps) / totalAtaLamps
  }

  const slot = tx.slot
  const ts = new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000)
  const out: ManagerFeeRow[] = []
  for (let i = 0; i < candidates.length; i++) {
    const ix = candidates[i]
    const accs = ix.accounts ?? []
    if (accs.length <= REFERRER_ACCOUNT_INDEX) continue
    const managerAta = accs[MANAGER_FEE_ACCOUNT_INDEX]
    const referrerAta = accs[REFERRER_ACCOUNT_INDEX]
    const destAta = accs[DEST_USER_ATA_INDEX]
    const depositor = accs[DEPOSITOR_ACCOUNT_INDEX]
    const bytes = decodeIxData(ix.data)
    if (!bytes) continue
    const solLamports = readU64LE(bytes, 1)
    // Same self-collision logic as referral-index: when the manager is
    // also the depositor (manager self-mints) the destAta == managerAta
    // and balByAta inflates the manager fee to ~full mint output. Use
    // the referrer leg as canonical (50/50 split → equal magnitude).
    //
    // Every branch goes through splitDelta so the per-ix fee = (this ix's
    // share of total deposit lamports landing in this ATA) × (cross-tx
    // delta on that ATA). Single-ix txs come out identical to before.
    const managerDeltaTx = balByAta.get(managerAta) ?? 0n
    const referrerDeltaTx = balByAta.get(referrerAta) ?? 0n
    let feeDelta: bigint
    if (managerAta && destAta && managerAta === destAta && referrerAta !== destAta) {
      // manager self-deposit → use referrer-leg as canonical fee signal
      feeDelta = splitDelta(
        referrerDeltaTx,
        lampsByReferrerAta.get(referrerAta) ?? 0n,
        solLamports,
      )
    } else if (managerAta && referrerAta && managerAta === referrerAta) {
      // collapsed legs → split, then halve to recover one side's share
      const shared = splitDelta(
        managerDeltaTx,
        lampsByManagerAta.get(managerAta) ?? 0n,
        solLamports,
      )
      feeDelta = shared / 2n
    } else {
      feeDelta = splitDelta(
        managerDeltaTx,
        lampsByManagerAta.get(managerAta) ?? 0n,
        solLamports,
      )
    }
    if (feeDelta <= 0n) continue
    out.push({
      sig,
      ixIndex: i,
      slot,
      ts,
      manager: '',
      managerFeeAta: managerAta,
      depositor,
      solLamports,
      feeStacsol: feeDelta,
    })
  }
  return out
}

async function resolveAtaOwners(
  endpoint: string,
  atas: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (atas.length === 0) return out
  const unique = Array.from(new Set(atas))
  const CHUNK = 100
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK)
    const infos = await getMultipleAccountsBase64(endpoint, slice, 'confirmed')
    for (let j = 0; j < slice.length; j++) {
      const info = infos[j]
      if (!info) continue
      const data = Buffer.from(info.data[0], 'base64')
      if (data.length < 64) continue
      const owner = new RpcPubkey(data.subarray(32, 64)).toString()
      out.set(slice[j], owner)
    }
  }
  return out
}

async function processBatch(
  endpoint: string,
  sigInfos: SignatureInfo[],
): Promise<{ inserted: number; rows: ManagerFeeRow[] }> {
  if (sigInfos.length === 0) return { inserted: 0, rows: [] }
  const out: { sig: string; tx: ParsedTransactionRpc | null }[] = []
  for (let i = 0; i < sigInfos.length; i += MAX_TX_RPC_CONCURRENCY) {
    const chunk = sigInfos.slice(i, i + MAX_TX_RPC_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((s) =>
        getParsedTransaction(endpoint, s.signature)
          .then((tx) => ({ sig: s.signature, tx }))
          .catch(() => ({ sig: s.signature, tx: null as ParsedTransactionRpc | null })),
      ),
    )
    out.push(...results)
  }
  const candidates: ManagerFeeRow[] = []
  for (const { sig, tx } of out) {
    if (!tx) continue
    candidates.push(...extractCredits(sig, tx))
  }
  if (candidates.length === 0) return { inserted: 0, rows: [] }
  const owners = await resolveAtaOwners(
    endpoint,
    candidates.map((r) => r.managerFeeAta),
  )
  const filled = candidates
    .map((r) => ({ ...r, manager: owners.get(r.managerFeeAta) ?? '' }))
    .filter((r) => r.manager !== '')
  let inserted = 0
  for (const r of filled) {
    const result = await getPool().query(
      `INSERT INTO manager_fee_credits
        (sig, ix_index, slot, ts, manager, manager_fee_ata, depositor, sol_lamports, fee_stacsol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sig, ix_index) DO NOTHING`,
      [
        r.sig,
        r.ixIndex,
        r.slot,
        r.ts,
        r.manager,
        r.managerFeeAta,
        r.depositor,
        r.solLamports.toString(),
        r.feeStacsol.toString(),
      ],
    )
    inserted += result.rowCount ?? 0
  }
  return { inserted, rows: filled }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    await ensureSchema()
    const endpoint = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
    const cursor = await loadCursor()
    let inserted = 0
    let scanned = 0
    let tailFetched = 0
    let backfillFetched = 0
    let newNewest: string | null = cursor.newest_sig
    let newOldest: string | null = cursor.oldest_sig
    let backfillDone = cursor.backfill_done

    if (cursor.newest_sig) {
      const tail = await getSignaturesForAddress(endpoint, POOL, {
        until: cursor.newest_sig,
        limit: MAX_SIGS_PER_PASS,
      })
      tailFetched = tail.length
      scanned += tail.length
      const r = await processBatch(endpoint, tail)
      inserted += r.inserted
      if (tail.length > 0) newNewest = tail[0].signature
    } else {
      const seed = await getSignaturesForAddress(endpoint, POOL, {
        limit: MAX_SIGS_PER_PASS,
      })
      tailFetched = seed.length
      scanned += seed.length
      const r = await processBatch(endpoint, seed)
      inserted += r.inserted
      if (seed.length > 0) {
        newNewest = seed[0].signature
        newOldest = seed[seed.length - 1].signature
      } else {
        backfillDone = true
      }
    }

    const BACKFILL_PASSES = 3
    for (let pass = 0; !backfillDone && newOldest && pass < BACKFILL_PASSES; pass++) {
      const older = await getSignaturesForAddress(endpoint, POOL, {
        before: newOldest,
        limit: MAX_SIGS_PER_PASS,
      })
      backfillFetched += older.length
      scanned += older.length
      const r = await processBatch(endpoint, older)
      inserted += r.inserted
      if (older.length === 0) {
        backfillDone = true
        break
      }
      newOldest = older[older.length - 1].signature
    }

    await saveCursor({
      newest_sig: newNewest,
      oldest_sig: newOldest,
      backfill_done: backfillDone,
    })

    res.status(200).json({
      ok: true,
      scanned,
      tailFetched,
      backfillFetched,
      inserted,
      cursor: { newest_sig: newNewest, oldest_sig: newOldest, backfill_done: backfillDone },
    })
  } catch (e) {
    console.error('manager-fee-index error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
