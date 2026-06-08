/**
 * stacSOL fork burn loop — with 13.8% fee split
 *
 * Every 5 minutes:
 *   1. Find every Token-2022 token account for the mint whose
 *      TransferFeeAmount.withheld_amount ≥ MIN_CLAIM (default 0.001).
 *   2. WithdrawWithheldTokensFromAccounts → our manager ATA, in chunks.
 *   3. Split the swept balance:
 *        a. Liqd-to-SOL leg — SPLIT_LIQD_BPS of it is redeemed to SOL via the
 *           pool's WithdrawSol (at NAV) with the lamports sent straight to the
 *           LIQD_DESTINATION PDA.
 *        b. Burn leg — the remainder is BurnChecked via Token-2022, shrinking
 *           mint.supply and pushing NAV up (the stacSOL "pitch").
 *      With the default SPLIT_LIQD_BPS=5000 and a 13.8% fee that's 6.9% liqd
 *      to the PDA + 6.9% burned for NAV.
 *   4. Run the SPL stake pool's update flow
 *      (UpdateValidatorListBalance + UpdateStakePoolBalance + Cleanup) to
 *      reconcile pool.pool_token_supply with the new mint.supply, so the
 *      rate gain materializes in redemption math immediately.
 *
 * Requires: a keypair JSON holding the manager authority (the same pubkey
 * configured as withdraw-withheld authority on the mint AND owner of the
 * destination ATA).
 *
 * Usage:
 *   RPC_URL="https://your-rpc/key"      \
 *   MINT=<fork mint>  POOL=<fork pool>  \
 *   LIQD_DESTINATION=<your PDA>         \
 *   KEYPAIR=./manager.json              \
 *   bun run scripts/burn-loop.ts
 *
 *   # or pass the key directly (handy for Railway/Vercel/etc):
 *   KEYPAIR_JSON="$(cat manager.json)" ... bun run scripts/burn-loop.ts
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import fs from 'node:fs'

// ------------------------------------------------------------------- config
// Fork addresses come from env (MINT / POOL), falling back to the original
// stacSOL deployment so this script keeps working unchanged on the original.
const MINT = new PublicKey(
  process.env.MINT ?? '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
)
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
const POOL = new PublicKey(
  process.env.POOL ?? 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb',
)

// ---- Fork fee split -------------------------------------------------------
// Of every harvest, SPLIT_LIQD_BPS goes to the "liqd to SOL → PDA" leg and the
// remainder is burned for NAV (the stacSOL "pitch"). Default 5000 = 50/50:
// with a 13.8% transfer fee that's 6.9% burned + 6.9% redeemed to SOL.
const SPLIT_LIQD_BPS = BigInt(process.env.SPLIT_LIQD_BPS ?? '5000')
// Destination the SOL half is sent to (the arbitrary PDA you provide). The
// pool's WithdrawSol redeems stacSOL → SOL at NAV and credits this account
// directly. Required to run the split; if unset the loop burns 100% (original
// stacSOL behavior) and logs a warning.
const LIQD_DESTINATION = process.env.LIQD_DESTINATION
  ? new PublicKey(process.env.LIQD_DESTINATION)
  : null
const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const SYSVAR_STAKE_HISTORY = new PublicKey('SysvarStakeHistory1111111111111111111111111')
const STAKE_PROGRAM = new PublicKey('Stake11111111111111111111111111111111111111')
const DECIMALS = 9
const MIN_CLAIM_TOKENS = 0.001
const MIN_CLAIM = BigInt(Math.floor(MIN_CLAIM_TOKENS * 10 ** DECIMALS))
// Default 5 min — set BURN_LOOP_TICK_MS to override (e.g. 30000 for 30s).
// At fast cadences burn-loop fires harvest + recovery much more often,
// which keeps the bait wallet topped up via WithdrawSol but uses more
// RPC + sends more on-chain txs.
const TICK_MS = Number(process.env.BURN_LOOP_TICK_MS ?? 5 * 60 * 1000)
const CHUNK = 20 // source accounts per WithdrawWithheld tx

const RPC_URL = process.env.RPC_URL
if (!RPC_URL) {
  throw new Error(
    'set RPC_URL env var (any Solana mainnet RPC with reasonable rate limits)',
  )
}

// /api/manager-state — base URL + shared secret for the optional burn-tick
// telemetry feed. If unset, reporting silently no-ops.
const MANAGER_STATE_URL =
  process.env.MANAGER_STATE_URL ?? 'https://stacsol.app/api/manager-state'
const MANAGER_STATE_SECRET = process.env.MANAGER_STATE_SECRET

interface BurnReport {
  harvestedAtom: bigint
  liqdAtom: bigint
  liqdLamports: bigint
  burnedAtom: bigint
  navBefore?: number
  navAfter?: number
  candidateCount: number
}

async function reportBurnTick(rep: BurnReport): Promise<void> {
  if (!MANAGER_STATE_SECRET) return
  // Skip the post when nothing material happened — avoids spamming rows
  // for idle ticks.
  if (rep.harvestedAtom === 0n && rep.burnedAtom === 0n && rep.liqdAtom === 0n) return
  try {
    const r = await fetch(MANAGER_STATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-manager-secret': MANAGER_STATE_SECRET,
      },
      body: JSON.stringify({
        kind: 'burn',
        harvestedAtom: rep.harvestedAtom.toString(),
        liqdAtom: rep.liqdAtom.toString(),
        liqdLamports: rep.liqdLamports.toString(),
        burnedAtom: rep.burnedAtom.toString(),
        navBefore: rep.navBefore ?? null,
        navAfter: rep.navAfter ?? null,
        candidateCount: rep.candidateCount,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      log(`manager-state POST burn ${r.status}: ${txt.slice(0, 200)}`)
    }
  } catch (e) {
    log(`manager-state POST burn error: ${(e as Error).message}`)
  }
}

// Two ways to provide the manager keypair, in priority order:
//   1. KEYPAIR_JSON — the raw JSON array (preferred for Railway/Vercel/etc
//      where a filesystem-mounted secret is awkward).
//   2. KEYPAIR — filesystem path to a Solana CLI keypair JSON (preferred for
//      local dev where the file already exists).
function loadAuthority(): Keypair {
  const raw = process.env.KEYPAIR_JSON
  if (raw && raw.trim()) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  }
  const path = process.env.KEYPAIR
  if (!path) {
    throw new Error(
      'provide manager keypair via KEYPAIR=/path/to/keypair.json or ' +
        'KEYPAIR_JSON="$(cat keypair.json)"',
    )
  }
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))),
  )
}

// Construct with an explicit non-functional ws endpoint so confirmTransaction
// and friends don't try to open subscriptions. We poll signatures over HTTP
// instead — Helius's ws was returning non-101 (likely plan limit / auth) and
// the unhandled errors from the bundled ws client were crashing the process.
const conn = new Connection(RPC_URL, {
  commitment: 'confirmed',
  wsEndpoint: 'wss://localhost:1', // intentionally invalid; we never subscribe
  disableRetryOnRateLimit: false,
  confirmTransactionInitialTimeout: 60_000,
})
const authority = loadAuthority()

// ----------------------------------------------------------- resilience
const RETRIES = 3
const BACKOFF_MS = 1500
const CONFIRM_POLL_MS = 2000
const CONFIRM_TIMEOUT_MS = 90_000

/** Best-effort retry around any RPC call. Logs each attempt. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < RETRIES; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = (e as Error)?.message ?? String(e)
      if (i < RETRIES - 1) {
        log(`${label} retry ${i + 1}/${RETRIES - 1}: ${msg}`)
        await sleep(BACKOFF_MS * (i + 1))
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/**
 * Poll signature status over HTTP instead of via the ws subscription used by
 * Connection.confirmTransaction. Returns when confirmed/finalized/errored, or
 * when the blockhash expires, or after CONFIRM_TIMEOUT_MS.
 */
async function confirmByPolling(
  sig: string,
  lastValidBlockHeight: number,
): Promise<{ err: unknown }> {
  const start = Date.now()
  while (Date.now() - start < CONFIRM_TIMEOUT_MS) {
    try {
      const res = await conn.getSignatureStatuses([sig], { searchTransactionHistory: false })
      const status = res.value[0]
      if (status) {
        if (status.err) return { err: status.err }
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return { err: null }
        }
      }
      const bh = await conn.getBlockHeight('confirmed')
      if (bh > lastValidBlockHeight) return { err: 'blockhash expired before confirmation' }
    } catch {
      /* RPC blip — sleep and retry */
    }
    await sleep(CONFIRM_POLL_MS)
  }
  return { err: 'confirmation timeout' }
}

// Process-level error handlers — log and keep the loop alive.
process.on('unhandledRejection', (err) => {
  const msg = err instanceof Error ? err.message : String(err)
  log(`UNHANDLED REJECTION (suppressed): ${msg}`)
})
process.on('uncaughtException', (err) => {
  log(`UNCAUGHT EXCEPTION (suppressed): ${err.message}`)
})
process.on('SIGINT', () => {
  log('SIGINT — shutting down')
  process.exit(0)
})

// ----------------------------------------------------------- byte helpers
const u64le = (v: bigint | number) => {
  const n = BigInt(v)
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(n, 0)
  return out
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fmtTok = (n: bigint) =>
  (Number(n) / 10 ** DECIMALS).toLocaleString(undefined, {
    maximumFractionDigits: 6,
  })

// ----------------------------------------------------------- pdas
function deriveAta(owner: PublicKey) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_2022.toBytes(), MINT.toBytes()],
    ATA_PROGRAM,
  )
  return ata
}

// ----------------------------------------------------------- instructions
function ixCreateAtaIdempotent(payer: PublicKey, owner: PublicKey) {
  const ata = deriveAta(owner)
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  })
}

// Token-2022 instruction 26 = TransferFeeExtension; sub-discriminator 3 =
// WithdrawWithheldTokensFromAccounts. The sub-ix carries `num_token_accounts:
// u8` as a packed argument — without it the program rejects with 0xc
// InvalidInstruction. Account list:
//   0  mint                       (writable)
//   1  destination token account  (writable)
//   2  withdraw-withheld authority (signer)
//   3+ source token accounts      (writable)
function ixWithdrawWithheld(sources: PublicKey[], destination: PublicKey) {
  if (sources.length === 0 || sources.length > 0xff) {
    throw new Error(`invalid source count: ${sources.length}`)
  }
  return new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
      ...sources.map((pk) => ({ pubkey: pk, isSigner: false, isWritable: true })),
    ],
    data: Buffer.from([26, 3, sources.length]),
  })
}

// Token-2022 BurnChecked = 15. Data: [15, amount: u64, decimals: u8]
function ixBurnChecked(account: PublicKey, amount: bigint) {
  return new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: authority.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([15]), u64le(amount), Buffer.from([DECIMALS])]),
  })
}

// SPL stake pool — UpdateValidatorListBalance (variant 6).
// Data: [6, start_index: u32, no_merge: bool]
function ixUpdateValidatorListBalance(validatorList: PublicKey, reserveStake: PublicKey) {
  const [withdrawAuth] = PublicKey.findProgramAddressSync(
    [POOL.toBytes(), new TextEncoder().encode('withdraw')],
    POOL_PROGRAM,
  )
  const data = Buffer.alloc(6)
  data.writeUInt8(6, 0)
  data.writeUInt32LE(0, 1)
  data.writeUInt8(0, 5)
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: false },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: validatorList, isSigner: false, isWritable: true },
      { pubkey: reserveStake, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_STAKE_HISTORY, isSigner: false, isWritable: false },
      { pubkey: STAKE_PROGRAM, isSigner: false, isWritable: false },
    ],
    data,
  })
}

// SPL stake pool — UpdateStakePoolBalance (variant 7). Data: [7]
// Reconciles pool.total_lamports with reserve+VSAs AND syncs
// pool.pool_token_supply with the live mint.supply.
function ixUpdateStakePoolBalance(
  validatorList: PublicKey,
  reserveStake: PublicKey,
  managerFeeAccount: PublicKey,
) {
  const [withdrawAuth] = PublicKey.findProgramAddressSync(
    [POOL.toBytes(), new TextEncoder().encode('withdraw')],
    POOL_PROGRAM,
  )
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: validatorList, isSigner: false, isWritable: true },
      { pubkey: reserveStake, isSigner: false, isWritable: false },
      { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([7]),
  })
}

// SPL stake pool — CleanupRemovedValidatorEntries (variant 8). Data: [8]
function ixCleanupRemovedValidatorEntries(validatorList: PublicKey) {
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: false },
      { pubkey: validatorList, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([8]),
  })
}

// SPL stake pool — WithdrawSol (variant 16). Data: [16, pool_tokens: u64].
// Redeems `poolTokens` stacSOL from `burner`'s ATA into SOL at the live NAV,
// crediting the lamports to `recipient`. The fork's "liqd to SOL" leg points
// `recipient` straight at the destination PDA so the SOL lands there in one
// instruction (no separate transfer, no rounding mismatch). This also burns
// the pool tokens, shrinking supply just like the NAV burn.
function ixWithdrawSol(
  burner: PublicKey,
  recipient: PublicKey,
  poolTokens: bigint,
  reserveStake: PublicKey,
  managerFeeAccount: PublicKey,
) {
  const [withdrawAuth] = PublicKey.findProgramAddressSync(
    [POOL.toBytes(), new TextEncoder().encode('withdraw')],
    POOL_PROGRAM,
  )
  const burnerAta = deriveAta(burner)
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: burner, isSigner: true, isWritable: false }, // user_transfer_authority
      { pubkey: burnerAta, isSigner: false, isWritable: true },
      { pubkey: reserveStake, isSigner: false, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true }, // recipient (lamports)
      { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_STAKE_HISTORY, isSigner: false, isWritable: false },
      { pubkey: STAKE_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([16]), u64le(poolTokens)]),
  })
}

// Read pool's validator_list, reserve_stake, manager_fee_account from chain.
async function fetchPoolRefs() {
  const acc = await withRetry('fetchPoolRefs', () => conn.getAccountInfo(POOL, 'confirmed'))
  if (!acc) throw new Error('pool not found')
  const d = acc.data
  return {
    validatorList: new PublicKey(d.subarray(98, 130)),
    reserveStake: new PublicKey(d.subarray(130, 162)),
    managerFeeAccount: new PublicKey(d.subarray(194, 226)),
    poolTotalLamports: d.readBigUInt64LE(258),
    poolTokenSupply: d.readBigUInt64LE(266),
  }
}

// ----------------------------------------------------------- tx send
async function sendIxs(ixs: TransactionInstruction[], label: string) {
  if (ixs.length === 0) return
  const tx = new Transaction()
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }))
  for (const ix of ixs) tx.add(ix)
  tx.feePayer = authority.publicKey

  const { blockhash, lastValidBlockHeight } = await withRetry(
    `${label} blockhash`,
    () => conn.getLatestBlockhash('confirmed'),
  )
  tx.recentBlockhash = blockhash
  tx.sign(authority)

  // skipPreflight: true — some RPC endpoints (Jito, Triton send-only tiers,
  // certain Helius plans) reject `simulateTransaction` with "Invalid Request:
  // running preflight check is not supported." Setting this to false there
  // makes every send retry-loop forever without ever broadcasting. Since we
  // pre-validate via withRetry + confirmByPolling, dropping preflight is safe.
  const sig = await withRetry(`${label} send`, () =>
    conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }),
  )
  log(`${label} sent ${sig}`)

  const conf = await confirmByPolling(sig, lastValidBlockHeight)
  if (conf.err) {
    log(`${label} FAILED ${JSON.stringify(conf.err)}`)
  } else {
    log(`${label} confirmed`)
  }
}

// ----------------------------------------------------------- discovery
// Token-2022 token account layout w/ TransferFeeAmount extension:
//   0..32   mint
//   32..64  owner
//   64..72  amount
//   ...
//   165     account_type (=2)
//   166+    TLV extensions
//
// We pull every account where mint==MINT (memcmp at offset 0) then walk the
// TLV stream client-side to read the withheld balance.
async function findAccountsWithWithheld() {
  const accs = await withRetry('getProgramAccounts', () =>
    conn.getProgramAccounts(TOKEN_2022, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0, bytes: MINT.toBase58() } },
      ],
    }),
  )
  const result: { pubkey: PublicKey; withheld: bigint; balance: bigint }[] = []
  for (const { pubkey, account } of accs) {
    const d = account.data
    // Skip if not a token account (account_type byte at 165 must be 2).
    if (d.length <= 165 || d[165] !== 2) continue
    const balance = d.readBigUInt64LE(64)
    let off = 166
    let withheld = 0n
    while (off + 4 <= d.length) {
      const type = d.readUInt16LE(off)
      const len = d.readUInt16LE(off + 2)
      if (type === 0) break
      if (type === 2 /* TransferFeeAmount */) {
        withheld = d.readBigUInt64LE(off + 4)
        break
      }
      off += 4 + len
    }
    if (withheld >= MIN_CLAIM) result.push({ pubkey, withheld, balance })
  }
  return result
}

async function readBalance(ata: PublicKey): Promise<bigint> {
  const acc = await withRetry('readBalance', () => conn.getAccountInfo(ata, 'processed'))
  if (!acc) return 0n
  return acc.data.readBigUInt64LE(64)
}

// ----------------------------------------------------------- log
function log(msg: string) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${t}] ${msg}`)
}

// One-shot guard so the manager-fee-account mismatch warning logs at most once.
let warnedFeeAcct = false

// ----------------------------------------------------------- tick
async function tick() {
  const ata = deriveAta(authority.publicKey)
  log(`tick — authority ${authority.publicKey.toBase58()} ata ${ata.toBase58()}`)

  // Telemetry — populated through the tick + posted at the end so the
  // dashboard can attribute NAV growth to source.
  let harvestedAtom = 0n
  let liqdAtom = 0n // stacSOL redeemed to SOL and sent to the PDA this tick
  let liqdLamports = 0n // SOL (lamports) the PDA received this tick
  let burnedAtom = 0n
  let candidateCount = 0
  let navBefore: number | undefined
  let navAfter: number | undefined
  try {
    const r0 = await fetchPoolRefs()
    if (r0.poolTokenSupply > 0n)
      navBefore = Number(r0.poolTotalLamports) / Number(r0.poolTokenSupply)
    // The pool's deposit fee (the "mint" fee — also 13.8% on this fork) mints
    // stacSOL into manager_fee_account. spl-stake-pool create-pool sets that to
    // the manager's ATA — i.e. THIS ata — so deposit-fee accrual lands in the
    // same account we sweep and rides the identical 50/50 burn+liqd split as
    // the transfer fee. Warn (once) if the pool was created with a different
    // fee account, since then deposit fees would NOT be auto-split here.
    if (!warnedFeeAcct && !r0.managerFeeAccount.equals(ata)) {
      warnedFeeAcct = true
      log(
        `WARNING manager_fee_account ${r0.managerFeeAccount.toBase58()} != manager ATA — ` +
          `deposit (mint) fees accrue there and will NOT be split by this loop. ` +
          `Re-create the pool with the manager ATA as fee account, or sweep it manually.`,
      )
    }
  } catch {
    /* non-fatal */
  }

  // 1. Discover accounts with withheld ≥ MIN_CLAIM.
  const candidates = await findAccountsWithWithheld()
  const totalWithheld = candidates.reduce((s, a) => s + a.withheld, 0n)
  candidateCount = candidates.length
  harvestedAtom = totalWithheld
  log(
    `found ${candidates.length} candidate account(s), total withheld = ${fmtTok(totalWithheld)} stacSOL`,
  )

  // 2. Withdraw withheld → our ATA, in chunks (ensure ATA exists once).
  if (candidates.length > 0) {
    const ataAcc = await conn.getAccountInfo(ata, 'processed')
    if (!ataAcc) {
      await sendIxs(
        [ixCreateAtaIdempotent(authority.publicKey, authority.publicKey)],
        'create-ata',
      )
    }
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const chunk = candidates.slice(i, i + CHUNK)
      const sum = chunk.reduce((s, c) => s + c.withheld, 0n)
      try {
        await sendIxs(
          [ixWithdrawWithheld(chunk.map((c) => c.pubkey), ata)],
          `withdraw-withheld[${chunk.length} accts, ${fmtTok(sum)} stacSOL]`,
        )
      } catch (e) {
        log(`withdraw-withheld error: ${(e as Error).message}`)
      }
    }
  }

  // 3. Fork fee split. Everything swept into our ATA is the harvested 13.8%.
  //    Split it: SPLIT_LIQD_BPS gets redeemed to SOL (WithdrawSol at NAV) and
  //    sent straight to the destination PDA ("liqd to SOL"); the rest is burned
  //    for NAV (the stacSOL "pitch"). Default 5000 bps → 6.9% liqd + 6.9% burn.
  const balanceAfterSweep = await readBalance(ata)
  log(`ata balance after harvest: ${fmtTok(balanceAfterSweep)} stacSOL`)
  let burnedAny = false

  if (balanceAfterSweep > 0n) {
    // 3a. Liqd-to-SOL leg → PDA. Skipped (and folded into the burn) if no
    //     destination is configured, which reproduces original 100%-burn. On
    //     failure we leave the share in the ATA so 3b burns it rather than
    //     losing it.
    const liqdShare = LIQD_DESTINATION
      ? (balanceAfterSweep * SPLIT_LIQD_BPS) / 10_000n
      : 0n
    if (LIQD_DESTINATION && liqdShare > 0n) {
      try {
        const refs = await fetchPoolRefs()
        const totalLam = refs.poolTotalLamports
        const supply = refs.poolTokenSupply
        // Project the SOL the PDA will receive: share * NAV.
        const projectedLamports =
          supply > 0n ? (liqdShare * totalLam) / supply : 0n
        log(
          `liqd: redeeming ${fmtTok(liqdShare)} stacSOL → ~${(Number(projectedLamports) / 1e9).toFixed(6)} SOL ` +
            `to ${LIQD_DESTINATION.toBase58()}`,
        )
        await sendIxs(
          [
            ixWithdrawSol(
              authority.publicKey,
              LIQD_DESTINATION,
              liqdShare,
              refs.reserveStake,
              refs.managerFeeAccount,
            ),
          ],
          `liqd-withdraw ${fmtTok(liqdShare)} stacSOL → PDA`,
        )
        burnedAny = true
        liqdAtom = liqdShare
        liqdLamports = projectedLamports
      } catch (e) {
        log(`liqd error: ${(e as Error).message} — burning this share instead`)
      }
    } else if (!LIQD_DESTINATION) {
      log('LIQD_DESTINATION unset — burning 100% (no split this tick)')
    }
  }

  // 3b. Burn whatever stacSOL is still in our ATA after the liqd leg — that's
  //     the burn share (plus any liqd share that failed to redeem above).
  const balance = await readBalance(ata)
  if (balance > 0n) {
    log(`ata balance after liqd: ${fmtTok(balance)} stacSOL — burning for NAV`)
    try {
      await sendIxs([ixBurnChecked(ata, balance)], `burn ${fmtTok(balance)} stacSOL`)
      burnedAny = true
      burnedAtom = balance
    } catch (e) {
      log(`burn error: ${(e as Error).message}`)
    }
  } else if (burnedAny) {
    log(`ata empty after liqd — nothing left to burn this tick`)
  }
  const burned = burnedAny

  // 4. Sync the pool's accounting so the rate gain materializes for redeemers.
  //    Skip if we didn't burn anything this tick (no drift to clear).
  if (burned) {
    try {
      const refs = await fetchPoolRefs()
      await sendIxs(
        [
          ixUpdateValidatorListBalance(refs.validatorList, refs.reserveStake),
          ixUpdateStakePoolBalance(refs.validatorList, refs.reserveStake, refs.managerFeeAccount),
          ixCleanupRemovedValidatorEntries(refs.validatorList),
        ],
        'update-pool-balance',
      )
      const refsAfter = await fetchPoolRefs()
      const rate = Number(refsAfter.poolTotalLamports) / Number(refsAfter.poolTokenSupply)
      navAfter = rate
      log(`pool rate now: ${rate.toFixed(6)} SOL/stacSOL`)
    } catch (e) {
      log(`update-pool error: ${(e as Error).message}`)
    }
  }

  // Post tick summary so the dashboard can chart burn velocity + attribute
  // NAV growth. Idle ticks (nothing harvested/recovered/burned) get skipped
  // inside reportBurnTick.
  await reportBurnTick({
    harvestedAtom,
    liqdAtom,
    liqdLamports,
    burnedAtom,
    navBefore,
    navAfter,
    candidateCount,
  })
}

// ----------------------------------------------------------- main loop
async function main() {
  log(`starting burn-loop · interval=${TICK_MS / 1000}s · min-claim=${MIN_CLAIM_TOKENS} stacSOL`)
  const keypairSource = process.env.KEYPAIR_JSON
    ? 'env:KEYPAIR_JSON'
    : `file:${process.env.KEYPAIR}`
  log(`rpc=${RPC_URL.split('?')[0]}? · keypair=${keypairSource} · authority=${authority.publicKey.toBase58()}`)
  log(`mint=${MINT.toBase58()} · pool=${POOL.toBase58()}`)
  if (LIQD_DESTINATION) {
    const liqdPct = Number(SPLIT_LIQD_BPS) / 100
    log(`fee split · liqd ${liqdPct}% → ${LIQD_DESTINATION.toBase58()} · burn ${100 - liqdPct}% → NAV`)
  } else {
    log('fee split · LIQD_DESTINATION unset → burning 100% for NAV (no split)')
  }
  // run immediately, then every TICK_MS
  while (true) {
    try {
      await tick()
    } catch (e) {
      log(`tick error: ${(e as Error).message}`)
    }
    await sleep(TICK_MS)
  }
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
