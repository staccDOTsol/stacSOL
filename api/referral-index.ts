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

// Indexes the *referral fee* leg of every DepositSol on the stacSOL pool —
// account index 6 (referrer_ata) of variants 14 (DepositSol) and 24
// (DepositSolWithSlippage). Mirrors api/manager-fee-index.ts (same shape,
// different account index). We use the raw-fetch _solana-rpc helpers
// instead of @solana/web3.js because the latter's rpc-websockets → uuid
// chain breaks under @vercel/node's CJS runtime — ERR_REQUIRE_ESM took
// the original web3.js-based implementation of this endpoint down in
// production, leaving referral_credits empty.
const POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'
const POOL_PROGRAM = 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY'
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

interface ReferralRow {
  sig: string
  ixIndex: number
  slot: number
  ts: Date
  referrer: string
  referrerAta: string
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
  const r = await getPool().query(
    'SELECT newest_sig, oldest_sig, backfill_done FROM referral_index_state WHERE id = 1',
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
    `UPDATE referral_index_state
     SET newest_sig = $1, oldest_sig = $2, backfill_done = $3, updated_at = NOW()
     WHERE id = 1`,
    [c.newest_sig, c.oldest_sig, c.backfill_done],
  )
}

function extractCredits(sig: string, tx: ParsedTransactionRpc): ReferralRow[] {
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

  // Pre-compute per-ATA total deposit lamports across ALL candidate ixs in
  // this tx. The pre/post token-balance map (balByAta) gives us a single
  // cross-tx delta per ATA; when a single tx has multiple DepositSol ixs
  // crediting the same referrer (or manager) ATA — zap routers, multi-leg
  // deposits — that delta is the SUM of every kickback. To get per-ix
  // shares we split proportionally by each ix's deposit lamports. NAV is
  // constant within a single tx, so the lamports ratio = the kickback ratio
  // exactly.
  //
  // Without this split, the old code (a) recorded a single (sig)-keyed row
  // carrying the WHOLE tx delta as that one ix's fee_stacsol, and (b)
  // dropped the remaining N-1 ixs at the PK conflict. Net effect was
  // fee_stacsol × N, sol_lamports × (1/N), apparent ROI inflated to N²×
  // the real 3.45% ratio on the referrers leaderboard.
  const lampsByReferrerAta = new Map<string, bigint>()
  const lampsByManagerAta = new Map<string, bigint>()
  for (const ix of candidates) {
    const accs = ix.accounts ?? []
    if (accs.length <= REFERRER_ACCOUNT_INDEX) continue
    const bytes = decodeIxData(ix.data)
    if (!bytes) continue
    const lams = readU64LE(bytes, 1)
    const rAta = accs[REFERRER_ACCOUNT_INDEX]
    const mAta = accs[MANAGER_FEE_ACCOUNT_INDEX]
    if (rAta) lampsByReferrerAta.set(rAta, (lampsByReferrerAta.get(rAta) ?? 0n) + lams)
    if (mAta) lampsByManagerAta.set(mAta, (lampsByManagerAta.get(mAta) ?? 0n) + lams)
  }
  const splitDelta = (delta: bigint, totalAtaLamps: bigint, ixLamps: bigint): bigint => {
    if (totalAtaLamps <= 0n) return delta
    return (delta * ixLamps) / totalAtaLamps
  }

  const slot = tx.slot
  const ts = new Date((tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000)
  const out: ReferralRow[] = []
  for (let i = 0; i < candidates.length; i++) {
    const ix = candidates[i]
    const accs = ix.accounts ?? []
    if (accs.length <= REFERRER_ACCOUNT_INDEX) continue
    const referrerAta = accs[REFERRER_ACCOUNT_INDEX]
    const managerAta = accs[MANAGER_FEE_ACCOUNT_INDEX]
    const destAta = accs[DEST_USER_ATA_INDEX]
    const depositor = accs[DEPOSITOR_ACCOUNT_INDEX]
    const bytes = decodeIxData(ix.data)
    if (!bytes) continue
    const solLamports = readU64LE(bytes, 1)
    // The pre/post token-balance delta on the referrer's ATA is normally
    // a clean read of the kickback. BUT when the depositor sets themselves
    // as their own referrer (self-referral, very common — every "organic"
    // depositor who pre-set themselves does this), the referrer ATA *is*
    // the destination ATA, so its delta = user_portion + manager_keep +
    // referrer_fee = nearly the entire mint output. The result is a
    // ~20–30× overstatement of "earned via referral" for self-referrers.
    //
    // The deposit fee is split 50/50 between manager and referrer, so the
    // manager ATA's delta is the same magnitude as the actual referrer
    // fee — and on a self-referral, the manager ATA is distinct from
    // destAta and therefore not contaminated. We use it as the canonical
    // signal whenever referrerAta collides with destAta.
    //
    // All three branches go through splitDelta to attribute the per-ATA
    // cross-tx delta proportionally to *this* ix's deposit lamports — the
    // delta value is the same for every ix in the loop, so the split is
    // what makes the per-row math right.
    const referrerDeltaTx = balByAta.get(referrerAta) ?? 0n
    const managerDeltaTx = balByAta.get(managerAta) ?? 0n
    let feeDelta: bigint
    if (referrerAta && destAta && referrerAta === destAta && managerAta !== destAta) {
      // self-referral path → use manager-leg as the canonical kickback
      feeDelta = splitDelta(
        managerDeltaTx,
        lampsByManagerAta.get(managerAta) ?? 0n,
        solLamports,
      )
    } else if (referrerAta && managerAta && referrerAta === managerAta) {
      // depositor self-referred AND happens to be the manager — both legs
      // collapse into one ATA delta which is 2× the actual kickback for
      // every contributing ix; split per-ix then halve.
      const shared = splitDelta(
        referrerDeltaTx,
        lampsByReferrerAta.get(referrerAta) ?? 0n,
        solLamports,
      )
      feeDelta = shared / 2n
    } else {
      // clean 3-party deposit → split referrer-leg delta proportionally
      feeDelta = splitDelta(
        referrerDeltaTx,
        lampsByReferrerAta.get(referrerAta) ?? 0n,
        solLamports,
      )
    }
    if (feeDelta <= 0n) continue
    out.push({
      sig,
      ixIndex: i,
      slot,
      ts,
      referrer: '',
      referrerAta,
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
): Promise<{ inserted: number; rows: ReferralRow[] }> {
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
  const candidates: ReferralRow[] = []
  for (const { sig, tx } of out) {
    if (!tx) continue
    candidates.push(...extractCredits(sig, tx))
  }
  if (candidates.length === 0) return { inserted: 0, rows: [] }
  const owners = await resolveAtaOwners(
    endpoint,
    candidates.map((r) => r.referrerAta),
  )
  const filled = candidates
    .map((r) => ({ ...r, referrer: owners.get(r.referrerAta) ?? '' }))
    .filter((r) => r.referrer !== '')
  let inserted = 0
  for (const r of filled) {
    const result = await getPool().query(
      `INSERT INTO referral_credits
        (sig, ix_index, slot, ts, referrer, referrer_ata, depositor, sol_lamports, fee_stacsol)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (sig, ix_index) DO NOTHING`,
      [
        r.sig,
        r.ixIndex,
        r.slot,
        r.ts,
        r.referrer,
        r.referrerAta,
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
    console.error('referral-index error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
