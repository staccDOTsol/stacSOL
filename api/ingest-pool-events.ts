import type { VercelRequest, VercelResponse } from '@vercel/node'
import bs58 from 'bs58'
import { ensureSchema, getPool } from './_db.js'
import {
  RpcPubkey,
  deriveAssociatedTokenAddress,
  findProgramAddressSync,
  getMultipleAccountsBase64,
  getParsedTransaction,
  getSignaturesForAddress,
  getAccountInfoBase64,
  decodeAccountData,
  type ParsedTransactionRpc,
  type ParsedInstructionRpc,
  type SignatureInfo,
} from './_solana-rpc.js'

const POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'
const POOL_PROGRAM = 'SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY'
const MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'

// HawkFi userPda derivation (verified against on-chain Anchor seeds error
// in src/lib/hawkfi-v2.ts: ["multi-user", HAWK_FARM, authority]).
const IYF_MAIN = 'FqGg2Y1FNxMiGd51Q6UETixQWkF5fB92MysbYogRJb3P'
const HAWK_FARM = '7jLQhREMxXjKdpwVuN6gwsWt3BNfAg9WqbepffPbi4ww'

const MINT_PUB = new RpcPubkey(MINT)
const TOKEN_2022_PUB = new RpcPubkey(TOKEN_2022)
const IYF_MAIN_PUB = new RpcPubkey(IYF_MAIN)
const HAWK_FARM_PUB = new RpcPubkey(HAWK_FARM)

function deriveHawkfiUserPda(authority: string): string {
  const ownerPub = new RpcPubkey(authority)
  return findProgramAddressSync(
    [Buffer.from('multi-user'), HAWK_FARM_PUB.toBytes(), ownerPub.toBytes()],
    IYF_MAIN_PUB,
  ).pubkey.toString()
}

function deriveStacAta(owner: string): string {
  return deriveAssociatedTokenAddress(
    new RpcPubkey(owner),
    MINT_PUB,
    TOKEN_2022_PUB,
  ).toString()
}

// SPL stake pool v1.0.0 ix variants we care about.
const DEPOSIT_VARIANTS = new Set([14, 24])
const WITHDRAW_VARIANTS = new Set([16, 25])

// Account-index conventions for v1.0.0 stake-pool ixs.
const DEP_DEPOSITOR_IDX = 3
const DEP_DEST_ATA_IDX = 4
const DEP_MGR_FEE_ATA_IDX = 5
const DEP_REFERRER_ATA_IDX = 6
const WD_USER_AUTH_IDX = 2
const WD_USER_ATA_IDX = 3
const WD_RECIPIENT_IDX = 5

const MAX_SIGS_PER_PASS = 250
const MAX_TX_RPC_CONCURRENCY = 5
const ACCOUNT_BATCH = 50

interface IndexerCursor {
  newest_sig: string | null
  oldest_sig: string | null
  backfill_done: boolean
}

interface PoolEventRow {
  signature: string
  ixIndex: number
  slot: number
  blockTime: Date
  wallet: string
  kind: 'mint' | 'burn'
  solLamports: bigint
  stacAtom: bigint
  impliedNav: number
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

function isPoolStakeIx(
  ix: ParsedInstructionRpc,
): ix is ParsedInstructionRpc & { programId: string; data: string; accounts: string[] } {
  if (!ix.programId || ix.programId !== POOL_PROGRAM) return false
  if (!ix.data) return false
  if (!ix.accounts || ix.accounts.length === 0) return false
  const bytes = decodeIxData(ix.data)
  if (!bytes || bytes.length < 9) return false
  const v = bytes[0]
  if (!DEPOSIT_VARIANTS.has(v) && !WITHDRAW_VARIANTS.has(v)) return false
  // Must reference the stacSOL pool at slot 0.
  if (ix.accounts[0] !== POOL) return false
  return true
}

interface AtaBalanceMap {
  [ata: string]: { owner: string; preAtom: bigint; postAtom: bigint }
}

function buildAtaBalanceMap(tx: ParsedTransactionRpc): AtaBalanceMap {
  const map: AtaBalanceMap = {}
  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey)
  const pre = tx.meta?.preTokenBalances ?? []
  const post = tx.meta?.postTokenBalances ?? []
  for (const p of post) {
    if (p.mint !== MINT) continue
    const ata = accountKeys[p.accountIndex]
    if (!ata) continue
    const preEntry = pre.find(
      (x) => x.accountIndex === p.accountIndex && x.mint === p.mint,
    )
    map[ata] = {
      owner: p.owner ?? preEntry?.owner ?? '',
      preAtom: BigInt(preEntry?.uiTokenAmount.amount ?? '0'),
      postAtom: BigInt(p.uiTokenAmount.amount),
    }
  }
  for (const p of pre) {
    if (p.mint !== MINT) continue
    const ata = accountKeys[p.accountIndex]
    if (!ata || map[ata]) continue
    map[ata] = {
      owner: p.owner ?? '',
      preAtom: BigInt(p.uiTokenAmount.amount),
      postAtom: 0n,
    }
  }
  return map
}

function extractEvents(
  sig: string,
  tx: ParsedTransactionRpc,
): PoolEventRow[] {
  if (tx.meta?.err) return []
  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey)
  const ataMap = buildAtaBalanceMap(tx)

  const candidates: ParsedInstructionRpc[] = []
  const top = tx.transaction.message.instructions
  for (const ix of top) if (isPoolStakeIx(ix)) candidates.push(ix)
  for (const inner of tx.meta?.innerInstructions ?? []) {
    for (const ix of inner.instructions) if (isPoolStakeIx(ix)) candidates.push(ix)
  }
  if (candidates.length === 0) return []

  const slot = tx.slot
  const blockTime = new Date(
    (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000,
  )
  const out: PoolEventRow[] = []

  for (let i = 0; i < candidates.length; i++) {
    const ix = candidates[i]
    const bytes = decodeIxData(ix.data)
    if (!bytes) continue
    const variant = bytes[0]
    const ixAmount = readU64LE(bytes, 1)
    const accounts = ix.accounts ?? []

    if (DEPOSIT_VARIANTS.has(variant)) {
      const depositor = accounts[DEP_DEPOSITOR_IDX]
      const destAta = accounts[DEP_DEST_ATA_IDX]
      const mgrAta = accounts[DEP_MGR_FEE_ATA_IDX]
      const refAta = accounts[DEP_REFERRER_ATA_IDX]
      const ataInfo = ataMap[destAta]
      if (!ataInfo) continue
      let stacDelta = ataInfo.postAtom - ataInfo.preAtom
      if (stacDelta <= 0n) continue
      // SPL stake-pool DepositSol mints to three ATAs in the same tx:
      //   accounts[4] = dest_user_ata  (user portion)
      //   accounts[5] = manager_fee_ata (manager keep)
      //   accounts[6] = referrer_ata    (referrer fee)
      // With the configured 6.9% deposit fee + 50/50 referral split, the
      // manager_keep == referrer_fee. When the dest ATA is also the
      // referrer ATA (self-referral) or the manager fee ATA (depositor
      // is the manager), the postTokenBalance delta on accounts[4]
      // INCLUDES those extra credits — and naively attributing the full
      // SOL cost to the combined amount overstates how much stacSOL the
      // depositor "paid for". We back those out here using the
      // independent ataMap entries for accounts[5] and accounts[6].
      let referrerCreditFromSelf = 0n
      let managerFeeCreditFromSelf = 0n
      if (refAta && refAta === destAta) {
        const refInfo = ataMap[mgrAta]
        if (refInfo) {
          // 50/50 split → referrer_fee == manager_keep; using the
          // manager_keep delta as a clean read of the referrer portion
          // avoids needing live fee-param lookup from the pool.
          referrerCreditFromSelf = refInfo.postAtom - refInfo.preAtom
          if (referrerCreditFromSelf < 0n) referrerCreditFromSelf = 0n
        }
      }
      if (mgrAta && mgrAta === destAta && refAta !== destAta) {
        const refInfo = ataMap[refAta]
        if (refInfo) {
          managerFeeCreditFromSelf = refInfo.postAtom - refInfo.preAtom
          if (managerFeeCreditFromSelf < 0n) managerFeeCreditFromSelf = 0n
        }
      }
      const overcount = referrerCreditFromSelf + managerFeeCreditFromSelf
      if (overcount > 0n && overcount < stacDelta) {
        stacDelta = stacDelta - overcount
      }
      const wallet = ataInfo.owner || depositor
      const solLamports = ixAmount
      const impliedNav =
        stacDelta > 0n ? Number(solLamports) / Number(stacDelta) : 0
      out.push({
        signature: sig,
        ixIndex: i,
        slot,
        blockTime,
        wallet,
        kind: 'mint',
        solLamports,
        stacAtom: stacDelta,
        impliedNav,
      })
    } else if (WITHDRAW_VARIANTS.has(variant)) {
      const userAuth = accounts[WD_USER_AUTH_IDX]
      const userAta = accounts[WD_USER_ATA_IDX]
      const recipient = accounts[WD_RECIPIENT_IDX]
      const ataInfo = ataMap[userAta]
      // ixAmount = total stacSOL submitted (gross of withdrawal fee).
      const stacAtom = ixAmount > 0n
        ? ixAmount
        : ataInfo
        ? ataInfo.preAtom - ataInfo.postAtom
        : 0n
      if (stacAtom <= 0n) continue
      const wallet = (ataInfo?.owner) || userAuth

      const recipientIdx = accountKeys.indexOf(recipient)
      let solReceived = 0n
      if (recipientIdx >= 0 && tx.meta) {
        const pre = BigInt(tx.meta.preBalances[recipientIdx] ?? 0)
        const post = BigInt(tx.meta.postBalances[recipientIdx] ?? 0)
        const delta = post - pre
        const isFeePayer = recipientIdx === 0
        const txFee = BigInt(tx.meta.fee ?? 0)
        solReceived = isFeePayer ? delta + txFee : delta
      }
      if (solReceived <= 0n) continue
      const impliedNav = Number(solReceived) / Number(stacAtom)
      out.push({
        signature: sig,
        ixIndex: i,
        slot,
        blockTime,
        wallet,
        kind: 'burn',
        solLamports: solReceived,
        stacAtom,
        impliedNav,
      })
    }
  }
  return out
}

async function loadCursor(): Promise<IndexerCursor> {
  const r = await getPool().query(
    'SELECT newest_sig, oldest_sig, backfill_done FROM pool_index_state WHERE id = 1',
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
    `UPDATE pool_index_state
     SET newest_sig = $1, oldest_sig = $2, backfill_done = $3, updated_at = NOW()
     WHERE id = 1`,
    [c.newest_sig, c.oldest_sig, c.backfill_done],
  )
}

async function fetchTxsConcurrent(
  endpoint: string,
  sigs: string[],
): Promise<Array<{ sig: string; tx: ParsedTransactionRpc | null }>> {
  const out: Array<{ sig: string; tx: ParsedTransactionRpc | null }> = []
  for (let i = 0; i < sigs.length; i += MAX_TX_RPC_CONCURRENCY) {
    const chunk = sigs.slice(i, i + MAX_TX_RPC_CONCURRENCY)
    const results = await Promise.all(
      chunk.map((sig) =>
        getParsedTransaction(endpoint, sig)
          .then((tx) => ({ sig, tx }))
          .catch(() => ({ sig, tx: null as ParsedTransactionRpc | null })),
      ),
    )
    out.push(...results)
  }
  return out
}

async function persistEvents(rows: PoolEventRow[]): Promise<{
  inserted: number
  affected: Set<string>
}> {
  const affected = new Set<string>()
  if (rows.length === 0) return { inserted: 0, affected }

  // Multi-row INSERT — one round-trip instead of N. Massive win on
  // backfill batches (~250 rows otherwise = ~250 RTTs to Neon).
  const cols = 9
  const placeholders: string[] = []
  const params: unknown[] = []
  for (let i = 0; i < rows.length; i++) {
    const base = i * cols
    placeholders.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
    )
    const r = rows[i]
    params.push(
      r.signature,
      r.ixIndex,
      r.slot,
      r.blockTime,
      r.wallet,
      r.kind,
      r.solLamports.toString(),
      r.stacAtom.toString(),
      r.impliedNav,
    )
    affected.add(r.wallet)
  }
  const sql =
    `INSERT INTO pool_events
        (signature, ix_index, slot, block_time, wallet, kind,
         sol_lamports, stac_atom, implied_nav)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (signature, ix_index) DO NOTHING`
  const result = await getPool().query(sql, params)
  return { inserted: result.rowCount ?? 0, affected }
}

async function processBatch(
  endpoint: string,
  sigInfos: SignatureInfo[],
): Promise<{ inserted: number; affected: Set<string> }> {
  if (sigInfos.length === 0) {
    return { inserted: 0, affected: new Set() }
  }
  const txs = await fetchTxsConcurrent(
    endpoint,
    sigInfos.map((s) => s.signature),
  )
  const candidateRows: PoolEventRow[] = []
  for (const { sig, tx } of txs) {
    if (!tx) continue
    candidateRows.push(...extractEvents(sig, tx))
  }
  return persistEvents(candidateRows)
}

async function rebuildHolderEvents(wallets: Iterable<string>): Promise<number> {
  const list = Array.from(new Set(Array.from(wallets)))
  if (list.length === 0) return 0
  // Single-query batch upsert via TEXT[] unnest. Beats per-wallet
  // round-trips by 10-100x on backfill bursts where we can have 100s
  // of affected wallets per cron run.
  const sql = `
    INSERT INTO holder_summary (wallet,
        net_sol_in_lamports, gross_sol_in_lamports, gross_sol_out_lamports,
        mint_count, burn_count, first_event_at, last_event_at, updated_at)
    SELECT
      pe.wallet,
      COALESCE(SUM(CASE WHEN pe.kind='mint' THEN pe.sol_lamports
                        WHEN pe.kind='burn' THEN -pe.sol_lamports END), 0)::NUMERIC,
      COALESCE(SUM(CASE WHEN pe.kind='mint' THEN pe.sol_lamports ELSE 0 END), 0)::NUMERIC,
      COALESCE(SUM(CASE WHEN pe.kind='burn' THEN pe.sol_lamports ELSE 0 END), 0)::NUMERIC,
      COALESCE(SUM(CASE WHEN pe.kind='mint' THEN 1 ELSE 0 END), 0)::INT,
      COALESCE(SUM(CASE WHEN pe.kind='burn' THEN 1 ELSE 0 END), 0)::INT,
      MIN(pe.block_time),
      MAX(pe.block_time),
      NOW()
    FROM unnest($1::TEXT[]) AS w(wallet)
    JOIN pool_events pe ON pe.wallet = w.wallet
    GROUP BY pe.wallet
    ON CONFLICT (wallet) DO UPDATE SET
      net_sol_in_lamports = EXCLUDED.net_sol_in_lamports,
      gross_sol_in_lamports = EXCLUDED.gross_sol_in_lamports,
      gross_sol_out_lamports = EXCLUDED.gross_sol_out_lamports,
      mint_count = EXCLUDED.mint_count,
      burn_count = EXCLUDED.burn_count,
      first_event_at = EXCLUDED.first_event_at,
      last_event_at = EXCLUDED.last_event_at,
      updated_at = NOW()
  `
  const r = await getPool().query(sql, [list])
  return r.rowCount ?? list.length
}

/**
 * Refresh `referral_earned_*` + `manager_fee_earned_*` columns on
 * holder_summary by aggregating the referral_credits + manager_fee_credits
 * tables (populated by /api/referral-index and /api/manager-fee-index
 * respectively). We touch every holder row each call — the row count is
 * small (low thousands at most) and these are the columns that drive the
 * "EARNED" badge in the leaderboard, so keeping them fresh on every
 * pool-events run is worth one extra UPSERT.
 */
async function rebuildEarnedCredits(): Promise<number> {
  const sql = `
    WITH ref AS (
      SELECT referrer AS wallet,
             COALESCE(SUM(fee_stacsol), 0)::NUMERIC AS atom,
             COUNT(*)::INT AS cnt
      FROM referral_credits
      GROUP BY referrer
    ),
    mgr AS (
      SELECT manager AS wallet,
             COALESCE(SUM(fee_stacsol), 0)::NUMERIC AS atom,
             COUNT(*)::INT AS cnt
      FROM manager_fee_credits
      GROUP BY manager
    ),
    combo AS (
      SELECT
        COALESCE(ref.wallet, mgr.wallet) AS wallet,
        COALESCE(ref.atom, 0)::NUMERIC   AS ref_atom,
        COALESCE(ref.cnt, 0)::INT        AS ref_cnt,
        COALESCE(mgr.atom, 0)::NUMERIC   AS mgr_atom,
        COALESCE(mgr.cnt, 0)::INT        AS mgr_cnt
      FROM ref
      FULL OUTER JOIN mgr ON ref.wallet = mgr.wallet
    )
    INSERT INTO holder_summary
      (wallet, referral_earned_atom, referral_earned_count,
       manager_fee_earned_atom, manager_fee_earned_count, updated_at)
    SELECT wallet, ref_atom, ref_cnt, mgr_atom, mgr_cnt, NOW() FROM combo
    ON CONFLICT (wallet) DO UPDATE SET
      referral_earned_atom = EXCLUDED.referral_earned_atom,
      referral_earned_count = EXCLUDED.referral_earned_count,
      manager_fee_earned_atom = EXCLUDED.manager_fee_earned_atom,
      manager_fee_earned_count = EXCLUDED.manager_fee_earned_count,
      updated_at = NOW()
  `
  const r = await getPool().query(sql)
  return r.rowCount ?? 0
}

async function refreshBalances(
  endpoint: string,
  wallets: string[],
): Promise<number> {
  if (wallets.length === 0) return 0
  let touched = 0
  for (let i = 0; i < wallets.length; i += ACCOUNT_BATCH) {
    const slice = wallets.slice(i, i + ACCOUNT_BATCH)
    const addresses: string[] = []
    for (const w of slice) {
      addresses.push(deriveStacAta(w))
      const userPda = deriveHawkfiUserPda(w)
      addresses.push(deriveStacAta(userPda))
    }
    const infos = await getMultipleAccountsBase64(endpoint, addresses, 'processed')
    // Single multi-row UPSERT for the whole slice.
    const upWallets: string[] = []
    const upWalletAtoms: string[] = []
    const upHawkAtoms: string[] = []
    const upTotals: string[] = []
    for (let j = 0; j < slice.length; j++) {
      const wallet = slice[j]
      const walletAtaInfo = infos[j * 2]
      const hawkAtaInfo = infos[j * 2 + 1]
      const walletAtom = (() => {
        if (!walletAtaInfo) return 0n
        const buf = decodeAccountData(walletAtaInfo)
        if (buf.length < 72) return 0n
        return buf.readBigUInt64LE(64)
      })()
      const hawkAtom = (() => {
        if (!hawkAtaInfo) return 0n
        const buf = decodeAccountData(hawkAtaInfo)
        if (buf.length < 72) return 0n
        return buf.readBigUInt64LE(64)
      })()
      const total = walletAtom + hawkAtom
      upWallets.push(wallet)
      upWalletAtoms.push(walletAtom.toString())
      upHawkAtoms.push(hawkAtom.toString())
      upTotals.push(total.toString())
    }
    if (upWallets.length === 0) continue
    const sql = `
      INSERT INTO holder_summary (wallet, wallet_stac_atom, hawkfi_stac_atom,
          total_stac_atom, balances_updated_at, updated_at)
      SELECT
        u.wallet,
        u.wallet_atom::NUMERIC,
        u.hawk_atom::NUMERIC,
        u.total_atom::NUMERIC,
        NOW(),
        NOW()
      FROM unnest($1::TEXT[], $2::TEXT[], $3::TEXT[], $4::TEXT[])
        AS u(wallet, wallet_atom, hawk_atom, total_atom)
      ON CONFLICT (wallet) DO UPDATE SET
        wallet_stac_atom = EXCLUDED.wallet_stac_atom,
        hawkfi_stac_atom = EXCLUDED.hawkfi_stac_atom,
        total_stac_atom = EXCLUDED.total_stac_atom,
        balances_updated_at = NOW(),
        updated_at = NOW()
    `
    await getPool().query(sql, [upWallets, upWalletAtoms, upHawkAtoms, upTotals])
    touched += upWallets.length
  }
  return touched
}

/**
 * Compute transferred-out / transferred-in deltas for every holder.
 *
 * The pool indexer only sees DepositSol (mint) and WithdrawSol (burn) events
 * — direct Token-2022 transfers between wallets are invisible. That makes
 * wallets that minted then gifted their stacSOL elsewhere look like they
 * paid SOL and got nothing (-100% P&L), and makes their recipients look
 * like "pure earners" with no cost basis.
 *
 * We can't index every Token-2022 transfer cheaply, but we don't have to —
 * the *net* delta is recoverable from the identity:
 *
 *   actual_balance = minted - burned + referral_earned + manager_fee_earned
 *                    + transferred_in - transferred_out
 *
 * Rearranged:
 *
 *   expected_supply = minted - burned + referral_earned + manager_fee_earned
 *   delta           = actual_balance - expected_supply
 *
 *   delta > 0  ⇒ this wallet received stacSOL it didn't earn / mint
 *   delta < 0  ⇒ this wallet sent stacSOL it can't account for
 *
 * Caveat: referral_earned_atom is currently over-counted on self-referred
 * mints (see referral-index.ts). For wallets that self-refer heavily,
 * expected_supply is inflated, which can spuriously flag them as
 * "transferred out" when really their referral attribution is bogus. Until
 * the referral indexer is fixed, treat transferred_out > 0 on heavy
 * self-referrers with skepticism.
 */
async function rebuildTransferDeltas(): Promise<number> {
  const sql = `
    WITH events AS (
      SELECT
        wallet,
        COALESCE(SUM(CASE WHEN kind = 'mint' THEN stac_atom ELSE 0 END), 0)::NUMERIC AS minted_atom,
        COALESCE(SUM(CASE WHEN kind = 'burn' THEN stac_atom ELSE 0 END), 0)::NUMERIC AS burned_atom
      FROM pool_events
      GROUP BY wallet
    ),
    expected AS (
      SELECT
        hs.wallet,
        COALESCE(e.minted_atom, 0) - COALESCE(e.burned_atom, 0)
          + hs.referral_earned_atom
          + hs.manager_fee_earned_atom AS expected_supply
      FROM holder_summary hs
      LEFT JOIN events e ON e.wallet = hs.wallet
    )
    UPDATE holder_summary hs
    SET
      transferred_out_atom = GREATEST(0::NUMERIC, expected.expected_supply - hs.total_stac_atom),
      transferred_in_atom  = GREATEST(0::NUMERIC, hs.total_stac_atom - expected.expected_supply)
    FROM expected
    WHERE hs.wallet = expected.wallet
  `
  const r = await getPool().query(sql)
  return r.rowCount ?? 0
}

async function recomputeNavSnapshot(rate: number): Promise<number> {
  // P&L treats `transferred_out` as an implicit burn at current NAV
  // (×0.931 because the Token-2022 transfer fee applies on outgoing
  // transfers too) and treats `transferred_in` as an implicit
  // free-earned credit (the recipient paid 0 SOL on-chain).
  //
  // CRITICAL: we net out referral + manager-fee passthrough from the
  // transferred_out credit. A referrer wallet who earned R stacSOL of
  // referrals and immediately shipped R stacSOL onward shouldn't get
  // credited for the value at BOTH ends — that double-counts. Only the
  // excess of transferred_out beyond own-earned credits represents real
  // wallet-to-wallet shipment of paid-in stacSOL, and only that excess
  // earns the burn-credit. The pure-passthrough wallet ends up with
  // pnl_sol == (current_holdings_value − cost_basis), which is the right
  // number and matches what a user sees in the Position card.
  //
  // breakeven_nav uses the same effective_transferred_out so the
  // breakeven point is calculated against the wallet's real recoupable
  // stacSOL (current holdings + transfers-out that weren't pass-through),
  // not pumped by referral churn.
  const sql = `
    UPDATE holder_summary
    SET
      burn_net_sol = ((total_stac_atom::DOUBLE PRECISION) / 1e9) * $1 * 0.931,
      transferred_out_sol = ((transferred_out_atom::DOUBLE PRECISION) / 1e9) * $1 * 0.931,
      transferred_in_sol  = ((transferred_in_atom::DOUBLE PRECISION)  / 1e9) * $1 * 0.931,
      pnl_sol = (((total_stac_atom::DOUBLE PRECISION) / 1e9) * $1 * 0.931)
                + ((GREATEST(transferred_out_atom - referral_earned_atom - manager_fee_earned_atom, 0)::DOUBLE PRECISION) / 1e9 * $1 * 0.931)
                + ((gross_sol_out_lamports::DOUBLE PRECISION) / 1e9)
                - ((gross_sol_in_lamports::DOUBLE PRECISION) / 1e9),
      pnl_pct = CASE
                  WHEN gross_sol_in_lamports > 0
                  THEN ((((total_stac_atom::DOUBLE PRECISION) / 1e9) * $1 * 0.931)
                        + ((GREATEST(transferred_out_atom - referral_earned_atom - manager_fee_earned_atom, 0)::DOUBLE PRECISION) / 1e9 * $1 * 0.931)
                        + ((gross_sol_out_lamports::DOUBLE PRECISION) / 1e9)
                        - ((gross_sol_in_lamports::DOUBLE PRECISION) / 1e9))
                       / ((gross_sol_in_lamports::DOUBLE PRECISION) / 1e9)
                  ELSE NULL
                END,
      breakeven_nav = CASE
                        WHEN (total_stac_atom + GREATEST(transferred_out_atom - referral_earned_atom - manager_fee_earned_atom, 0)) > 0
                          AND gross_sol_in_lamports > gross_sol_out_lamports
                        THEN (((gross_sol_in_lamports - gross_sol_out_lamports)::DOUBLE PRECISION) / 1e9)
                             / ((((total_stac_atom + GREATEST(transferred_out_atom - referral_earned_atom - manager_fee_earned_atom, 0))::DOUBLE PRECISION) / 1e9) * 0.931)
                        ELSE NULL
                      END,
      earned_sol = (((referral_earned_atom + manager_fee_earned_atom)::DOUBLE PRECISION) / 1e9)
                   * $1 * 0.931
                   + ((transferred_in_atom::DOUBLE PRECISION) / 1e9) * $1 * 0.931,
      updated_at = NOW()
  `
  const r = await getPool().query(sql, [rate])
  return r.rowCount ?? 0
}

async function fetchLiveNav(endpoint: string): Promise<number> {
  const acc = await getAccountInfoBase64(endpoint, POOL, 'processed')
  if (!acc) throw new Error('pool account not found')
  const buf = decodeAccountData(acc)
  const totalLamports = buf.readBigUInt64LE(258)
  const tokenSupply = buf.readBigUInt64LE(266)
  if (tokenSupply === 0n) return 1
  return Number(totalLamports) / Number(tokenSupply)
}

async function listAllHolders(): Promise<string[]> {
  const r = await getPool().query(
    `SELECT wallet FROM holder_summary
     ORDER BY GREATEST(COALESCE(last_event_at, '1970-01-01'::TIMESTAMPTZ),
                       COALESCE(balances_updated_at, '1970-01-01'::TIMESTAMPTZ)) ASC`,
  )
  return r.rows.map((row) => row.wallet as string)
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
    const eventAffected = new Set<string>()

    if (cursor.newest_sig) {
      const tail = await getSignaturesForAddress(endpoint, POOL, {
        until: cursor.newest_sig,
        limit: MAX_SIGS_PER_PASS,
      })
      tailFetched = tail.length
      scanned += tail.length
      const r = await processBatch(endpoint, tail)
      inserted += r.inserted
      r.affected.forEach((w) => eventAffected.add(w))
      if (tail.length > 0) newNewest = tail[0].signature
    } else {
      const seed = await getSignaturesForAddress(endpoint, POOL, {
        limit: MAX_SIGS_PER_PASS,
      })
      tailFetched = seed.length
      scanned += seed.length
      const r = await processBatch(endpoint, seed)
      inserted += r.inserted
      r.affected.forEach((w) => eventAffected.add(w))
      if (seed.length > 0) {
        newNewest = seed[0].signature
        newOldest = seed[seed.length - 1].signature
      } else {
        backfillDone = true
      }
    }

    // Multi-pass backfill: keep paginating older signatures until either
    // we've burned our per-run budget (BACKFILL_PASSES) or RPC returns
    // an empty page (we've reached pool deploy). Each pass costs ~10s
    // worst-case (250 getParsedTransaction at concurrency 5), so a
    // 4-pass cap stays comfortably under the 60s timeout.
    // Conservative — 2 passes (=500 sigs) per cron beat keeps us well
    // under the 60s function timeout when DB writes are bursty.
    const BACKFILL_PASSES = 2
    for (let pass = 0; !backfillDone && newOldest && pass < BACKFILL_PASSES; pass++) {
      const older = await getSignaturesForAddress(endpoint, POOL, {
        before: newOldest,
        limit: MAX_SIGS_PER_PASS,
      })
      backfillFetched += older.length
      scanned += older.length
      const r = await processBatch(endpoint, older)
      inserted += r.inserted
      r.affected.forEach((w) => eventAffected.add(w))
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

    const eventsTouched = await rebuildHolderEvents(eventAffected)
    const earnedTouched = await rebuildEarnedCredits()

    // Balance refresh: stale-first ordering. Cap per run so we stay
    // inside the function timeout budget.
    const everyone = await listAllHolders()
    const REFRESH_CAP = 600
    const toRefresh = everyone.slice(0, REFRESH_CAP)
    for (const w of eventAffected) {
      if (!toRefresh.includes(w)) toRefresh.push(w)
    }
    const balancesTouched = await refreshBalances(endpoint, toRefresh)

    // Must run AFTER balances refresh + AFTER rebuildEarnedCredits because
    // it reads wallet_stac_atom + referral_earned_atom + manager_fee_earned_atom
    // against pool_events. Result feeds into recomputeNavSnapshot below.
    const transfersTouched = await rebuildTransferDeltas()

    const rate = await fetchLiveNav(endpoint)
    const navTouched = await recomputeNavSnapshot(rate)

    res.status(200).json({
      ok: true,
      scanned,
      tailFetched,
      backfillFetched,
      inserted,
      eventsTouched,
      earnedTouched,
      balancesTouched,
      transfersTouched,
      navTouched,
      rate,
      cursor: { newest_sig: newNewest, oldest_sig: newOldest, backfill_done: backfillDone },
    })
  } catch (e) {
    console.error('ingest-pool-events error:', e)
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}
