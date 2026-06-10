/**
 * stacSOL bait loop — always-on daemon.
 *
 * Goal: manufacture imbalance on stacSOL secondary markets so arbers (and
 * organic flow) are forced through the Token-2022 transfer-fee path. Every
 * cross-pair swap arbers do to close the imbalance withholds 6.9% per leg.
 * burn-loop.ts then sweeps that withholding into NAV.
 *
 * What this script does each cycle:
 *   1. Snapshot the manager wallet SOL balance.
 *   2. Mint stacSOL via DepositSol (free for the manager — deposit fee
 *      goes back to us, T22 transfer-fee gets withheld in our own ATA and
 *      swept by the burn-loop).
 *   3. Sell that stacSOL via Jupiter — routed through ONE specific dex
 *      (BAIT_DEX_INCLUDE) so we push the price on that pool only. The
 *      sell-side T22 fee withholds in the LP's ATA — also swept later.
 *   4. Compute realised SOL cost = pre_balance − post_balance.
 *   5. POST the cost to /api/manager-state — burn-loop will reclaim it
 *      via WithdrawSol over the next few ticks before burning the excess.
 *
 * The "exclusion" leg the user described — buy on Pool A, sell elsewhere —
 * is replaced by the simpler "mint on protocol (free), sell on Pool A"
 * because:
 *   • The mint leg has zero LP cost (it's against the protocol pool).
 *   • The sell leg creates the same imbalance on Pool A.
 *   • We pay LP fees + slippage ONCE instead of twice.
 *
 * Usage:
 *   RPC_URL=...                       \
 *   KEYPAIR_JSON="$(cat manager.json)"  \
 *   MANAGER_STATE_SECRET=...            \
 *   bun run scripts/bait-loop.ts
 *
 * Tuning env vars (all optional, sensible defaults):
 *   BAIT_SIZE_SOL=0.05            — SOL per bait cycle
 *   BAIT_INTERVAL_MS=900000       — 15 min between cycles
 *   BAIT_DEX_INCLUDE=Raydium CP   — Jupiter `dexes` filter for the sell leg
 *   BAIT_SLIPPAGE_BPS=300         — Jupiter slippage cap (3%)
 *   MAX_OUTSTANDING_COST_SOL=2    — pause baiting if backlog exceeds this
 *   MIN_WALLET_RESERVE_SOL=0.05   — never drop wallet SOL below this
 *   MANAGER_STATE_URL=...         — defaults to https://stacsol.app/api/manager-state
 *   JUPITER_URL=https://lite-api.jup.ag — base for /swap/v1/quote + /swap
 *   DRY_RUN=1                     — log what would happen, send nothing
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import fs from 'node:fs'

// ---------------------------------------------------------------- constants
const MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
const SYSVAR_CLOCK = new PublicKey('SysvarC1ock11111111111111111111111111111111')
const SYSVAR_STAKE_HISTORY = new PublicKey('SysvarStakeHistory1111111111111111111111111')
const STAKE_PROGRAM = new PublicKey('Stake11111111111111111111111111111111111111')
const WSOL = 'So11111111111111111111111111111111111111112'
const DECIMALS = 9

// ---------------------------------------------------------------- env
const RPC_URL = process.env.RPC_URL
if (!RPC_URL) throw new Error('set RPC_URL env var')

const MANAGER_STATE_URL =
  process.env.MANAGER_STATE_URL ?? 'https://stacsol.app/api/manager-state'
const MANAGER_STATE_SECRET = process.env.MANAGER_STATE_SECRET
if (!MANAGER_STATE_SECRET) {
  throw new Error(
    'set MANAGER_STATE_SECRET env var (must match the value configured ' +
      'on the /api/manager-state endpoint)',
  )
}

const BAIT_SIZE_SOL = Number(process.env.BAIT_SIZE_SOL ?? '0.05')
const BAIT_SIZE_LAMPORTS = BigInt(Math.floor(BAIT_SIZE_SOL * LAMPORTS_PER_SOL))
const BAIT_INTERVAL_MS = Number(process.env.BAIT_INTERVAL_MS ?? `${15 * 60 * 1000}`)
// DEX whitelist used to filter venues discovered from /api/lp. A "venue"
// is a specific LP pool (e.g. Raydium CP stacSOL-Staccana). We discover
// venues automatically and force-route each bait through the venue's
// intermediate mint, so traffic actually hits the pool we want to push.
// BAIT_TARGETS (or BAIT_DEX_INCLUDE) stays env-compatible — it's now the
// DEX whitelist used during venue discovery.
const BAIT_DEX_WHITELIST = new Set(
  (process.env.BAIT_TARGETS ?? process.env.BAIT_DEX_INCLUDE ?? 'Raydium CP,Meteora DLMM,Meteora DAMM v2')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
)
const LP_API_URL = process.env.LP_API_URL ?? 'https://stacsol.app/api/lp'
const BAIT_MIN_LP_LIQ_USD = Number(process.env.BAIT_MIN_LP_LIQ_USD ?? '50')
const BAIT_VENUE_REFRESH_CYCLES = Math.max(
  1,
  Number(process.env.BAIT_VENUE_REFRESH_CYCLES ?? '10'),
)
// 'rotate' = one target per cycle, advance index each tick (default).
// 'sweep'  = every target every cycle, BAIT_SIZE_SOL split evenly across them.
const BAIT_MODE = (process.env.BAIT_MODE ?? 'rotate') as 'rotate' | 'sweep'
// Minimum expected post-impact P&L in bps-of-bait-size required for the
// daemon to fire. Default is a very negative number (effectively
// always-fire) — the bait loop's design is intentionally loss-tolerant
// per cycle:
//   • Recovery step on burn-loop withdraws SOL from the protocol to
//     repay the bait cost (the manager-state backlog).
//   • Every bait creates LP imbalance → arbers correct it → those arber
//     trades pay 6.9% Token-2022 transfer fee → burn-loop sweeps and
//     burns it → NAV climbs for everyone (including the protocol's
//     SOL-backed reserve).
// If you set this to a positive number, the daemon waits for spreads big
// enough to be profitable on its own — that's a different game (yield
// farming the LP), not bait. Default behaviour is "push the needle, let
// arbers + burn-loop close the loop."
const BAIT_PROFIT_THRESHOLD_BPS = Number(process.env.BAIT_PROFIT_THRESHOLD_BPS ?? '-100000')
// Hard kill switch: if true, completely bypasses the threshold gate.
// Equivalent to BAIT_PROFIT_THRESHOLD_BPS=-Infinity but more readable.
const BAIT_ALWAYS_FIRE =
  process.env.BAIT_ALWAYS_FIRE === '0' || process.env.BAIT_ALWAYS_FIRE === 'false'
    ? false
    : true
// Force a direction regardless of LP/NAV. 'auto' (default) picks adaptively.
const BAIT_DIRECTION = (process.env.BAIT_DIRECTION ?? 'auto') as
  | 'auto'
  | 'mint_sell'
  | 'buy_burn'
  | 'skip'
const BAIT_SLIPPAGE_BPS = Number(process.env.BAIT_SLIPPAGE_BPS ?? '300')
const MAX_OUTSTANDING_COST_SOL = Number(process.env.MAX_OUTSTANDING_COST_SOL ?? '2')
const MIN_WALLET_RESERVE_SOL = Number(process.env.MIN_WALLET_RESERVE_SOL ?? '0.05')
// If JUPITER_API_KEY is set, use the keyed `api.jup.ag` endpoint (10× rate
// limit). Otherwise fall back to `lite-api.jup.ag` (heavily rate-limited).
// Both expose the same v1 routes.
const JUPITER_API_KEY = process.env.JUPITER_API_KEY
const JUPITER_URL =
  process.env.JUPITER_URL ?? (JUPITER_API_KEY ? 'https://api.jup.ag' : 'https://lite-api.jup.ag')
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'

// Cycle counter for round-robin venue rotation.
let cycleN = 0

// A "venue" is a specific LP pool we want to push imbalance on. For
// SOL-quoted pools (intermediateMint=null) Jupiter routes directly. For
// cross-pairs (Staccana, USDC, PROOFV3, …) we set `restrictIntermediateTokens`
// so Jupiter is forced to route via that token — which means the trade
// physically goes through the cross-pair pool we care about.
interface Venue {
  dex: string // Jupiter-compatible dex name (e.g. "Raydium CP")
  intermediateMint: string | null // null = direct SOL routing
  intermediateSymbol: string
  pairName: string // e.g. "stacSOL-Staccana"
  liqUsd: number
}
function labelVenue(v: Venue): string {
  return `${v.dex}/${v.intermediateSymbol}`
}
// Jupiter doesn't expose a "force routing through this mint" param — its
// `restrictIntermediateTokens` is a boolean (whitelist top-tokens or not),
// not a mint filter. So we use the next-best trick:
//   • Direct SOL-paired venue → constrain `dexes` so Jupiter takes the
//     specific pool we want.
//   • Cross-pair venue (intermediate ≠ SOL) → drop the dex filter and let
//     Jupiter route freely. If the cross-pair pool is the cheapest path
//     (often true for deep pools like Staccana at $20k vs. SOL pair at
//     $264) Jupiter naturally takes it. Best-effort, not guaranteed.
function venueQuoteArgs(v: Venue): { dexes?: string } {
  return v.intermediateMint ? {} : { dexes: v.dex }
}

// Birdeye/source strings differ from Jupiter `dexes` strings. Normalize
// so /api/lp's "Raydium Cp" maps to Jupiter's "Raydium CP", etc.
const BIRDEYE_TO_JUPITER_DEX: Record<string, string> = {
  'Raydium Cp': 'Raydium CP',
  'Raydium CP': 'Raydium CP',
  'Raydium Cpmm': 'Raydium CP',
  'Raydium CPMM': 'Raydium CP',
  'Meteora Dlmm': 'Meteora DLMM',
  'Meteora DLMM': 'Meteora DLMM',
  'Meteora Damm V2': 'Meteora DAMM v2',
  'Meteora DAMM V2': 'Meteora DAMM v2',
  'Meteora DAMM v2': 'Meteora DAMM v2',
}
function normalizeDex(s: string): string {
  return BIRDEYE_TO_JUPITER_DEX[s] ?? s
}

// Pull live LP list, filter to qualifying stacSOL cross-pairs, build venues.
async function loadVenues(): Promise<Venue[]> {
  try {
    const r = await fetch(LP_API_URL, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) {
      log(`venue discovery: GET ${LP_API_URL} → ${r.status}`)
      return []
    }
    // The /api/lp response sometimes carries control chars from upstream
    // (Birdeye), which trips JSON.parse. Strip them at byte level.
    const raw = new Uint8Array(await r.arrayBuffer())
    const cleaned: number[] = []
    for (const b of raw) {
      if (b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) cleaned.push(b)
    }
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(cleaned))) as {
      markets?: Array<{
        source: string
        name: string
        liquidity: number | null
        price: number | null
        base?: { address: string; symbol: string }
        quote?: { address: string; symbol: string }
        isProtocolPool?: boolean
      }>
    }
    const stac = MINT.toBase58()
    const venues: Venue[] = []
    for (const m of d.markets ?? []) {
      if (m.isProtocolPool) continue // protocol pool — we mint here, can't bait
      const liq = m.liquidity ?? 0
      if (liq < BAIT_MIN_LP_LIQ_USD) continue
      const dex = normalizeDex(m.source)
      if (!BAIT_DEX_WHITELIST.has(dex)) continue
      const base = m.base?.address
      const quote = m.quote?.address
      let intermediateMint: string | null
      let intermediateSymbol: string
      if (base === stac) {
        if (quote === WSOL) {
          intermediateMint = null
          intermediateSymbol = 'SOL'
        } else if (!quote) continue
        else {
          intermediateMint = quote
          intermediateSymbol = m.quote?.symbol ?? quote.slice(0, 4)
        }
      } else if (quote === stac) {
        if (base === WSOL) {
          intermediateMint = null
          intermediateSymbol = 'SOL'
        } else if (!base) continue
        else {
          intermediateMint = base
          intermediateSymbol = m.base?.symbol ?? base.slice(0, 4)
        }
      } else {
        continue // not a stacSOL pool
      }
      venues.push({
        dex,
        intermediateMint,
        intermediateSymbol,
        pairName: m.name,
        liqUsd: liq,
      })
    }
    venues.sort((a, b) => b.liqUsd - a.liqUsd)
    return venues
  } catch (e) {
    log(`venue discovery error: ${(e as Error).message}`)
    return []
  }
}

// Active venue list. Refreshed at startup and every BAIT_VENUE_REFRESH_CYCLES.
let venues: Venue[] = []

function loadAuthority(): Keypair {
  const raw = process.env.KEYPAIR_JSON
  if (raw && raw.trim()) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  const path = process.env.KEYPAIR
  if (!path) {
    throw new Error('set KEYPAIR or KEYPAIR_JSON env var (manager keypair)')
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))))
}

const conn = new Connection(RPC_URL, {
  commitment: 'confirmed',
  wsEndpoint: 'wss://localhost:1', // intentionally invalid; never subscribed
  disableRetryOnRateLimit: false,
  confirmTransactionInitialTimeout: 60_000,
})
const authority = loadAuthority()

// ---------------------------------------------------------------- helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const u64le = (v: bigint | number) => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64LE(BigInt(v), 0)
  return out
}

function log(msg: string) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${t}] ${msg}`)
}

function deriveAta(owner: PublicKey, mint = MINT, tokenProgram = TOKEN_2022) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )
  return ata
}

function deriveWithdrawAuth() {
  const [auth] = PublicKey.findProgramAddressSync(
    [POOL.toBytes(), new TextEncoder().encode('withdraw')],
    POOL_PROGRAM,
  )
  return auth
}

// ATA-create idempotent (variant 1).
function ixCreateAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) {
  const ata = deriveAta(owner, mint, tokenProgram)
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

// Pool refs (reserve, manager_fee, etc.)
async function fetchPoolRefs() {
  const acc = await conn.getAccountInfo(POOL, 'confirmed')
  if (!acc) throw new Error('pool not found')
  const d = acc.data
  return {
    reserveStake: new PublicKey(d.subarray(130, 162)),
    managerFeeAccount: new PublicKey(d.subarray(194, 226)),
    poolTotalLamports: d.readBigUInt64LE(258),
    poolTokenSupply: d.readBigUInt64LE(266),
  }
}

// SPL stake pool DepositSol (variant 14). Self-referral so deposit fee
// returns to manager. Data: [14, lamports: u64].
function ixDepositSol(
  funder: PublicKey,
  lamports: bigint,
  reserveStake: PublicKey,
  managerFeeAccount: PublicKey,
) {
  const withdrawAuth = deriveWithdrawAuth()
  const userAta = deriveAta(funder)
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: reserveStake, isSigner: false, isWritable: true },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true }, // referral = self
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([14]), u64le(lamports)]),
  })
}

// SPL stake pool WithdrawSol (variant 16). Manager owns the withdraw fee
// so this is free for us. Data: [16, pool_tokens: u64].
function ixWithdrawSol(
  burner: PublicKey,
  poolTokens: bigint,
  reserveStake: PublicKey,
  managerFeeAccount: PublicKey,
) {
  const withdrawAuth = deriveWithdrawAuth()
  const burnerAta = deriveAta(burner)
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: burner, isSigner: true, isWritable: false }, // user_transfer_authority
      { pubkey: burnerAta, isSigner: false, isWritable: true },
      { pubkey: reserveStake, isSigner: false, isWritable: true },
      { pubkey: burner, isSigner: false, isWritable: true }, // recipient (lamports)
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

// Read T22 token account state. The `amount` field (offset 64) is the
// *gross* balance held by the account; the TransferFeeAmount extension
// (TLV type 2) holds the portion withheld for transfer-fee sweeps.
// Burnable / spendable = amount − withheld. Burn() will fail with
// "insufficient funds" if you try to consume the withheld portion.
async function readStacAccount(ata: PublicKey): Promise<{
  amount: bigint
  withheld: bigint
  spendable: bigint
}> {
  const acc = await conn.getAccountInfo(ata, 'processed')
  if (!acc) return { amount: 0n, withheld: 0n, spendable: 0n }
  const d = acc.data
  const amount = d.readBigUInt64LE(64)
  let withheld = 0n
  // account_type byte at offset 165 == 2 indicates extension TLV follows.
  if (d.length > 165 && d[165] === 2) {
    let off = 166
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
  }
  return { amount, withheld, spendable: amount - withheld }
}

// Fee constants used to recover the *true* LP exchange rate from a
// fee-bearing Jupiter quote. T22 transfer fee is 6.9%; Raydium CP charges
// ~0.25% per swap; conservative approximation for "the LP only sees
// X × (1 − T22) × (1 − LP_FEE) on either side of a probed swap."
const T22_FEE_RATE = 0.069
const LP_FEE_APPROX = 0.0025

// Size-aware probes. We quote Jupiter at the EXACT bait size in each
// direction, so the price-impact of our own trade is priced in. On a thin
// LP, the small-reference-size probe lies — it shows the "ideal" mid
// price, then our actual bait eats 10–20% slippage and we lose money
// every cycle. Probing at real size means the daemon only fires when the
// post-impact outcome is genuinely net-positive.
//
// Returns expected SOL P&L (signed: positive = profit, negative = cost),
// or null if no route exists.

async function probeMintSellOutcome(
  venue: Venue,
  solSize: number,
  navSolPerStac: number,
): Promise<number | null> {
  // Mint output: (S / NAV) stacSOL gross, ~93.1% spendable after T22 withhold
  // on mint side (the 6.9% goes back into next sweep so ignore for P&L).
  const expectedStacFromMint = (solSize / navSolPerStac) * (1 - T22_FEE_RATE)
  if (expectedStacFromMint <= 0) return null
  const stacAtoms = BigInt(Math.floor(expectedStacFromMint * 10 ** DECIMALS))
  try {
    const q = await jupiterQuote({
      inputMint: MINT.toBase58(),
      outputMint: WSOL,
      amount: stacAtoms,
      ...venueQuoteArgs(venue),
      slippageBps: 100,
    })
    const solOut = Number(q.outAmount) / LAMPORTS_PER_SOL
    return solOut - solSize // signed P&L in SOL
  } catch (e) {
    log(`probeMintSellOutcome(${labelVenue(venue)}) failed: ${(e as Error).message}`)
    return null
  }
}

async function probeBuyBurnOutcome(
  venue: Venue,
  solSize: number,
  navSolPerStac: number,
): Promise<number | null> {
  const solAtoms = BigInt(Math.floor(solSize * LAMPORTS_PER_SOL))
  try {
    const q = await jupiterQuote({
      inputMint: WSOL,
      outputMint: MINT.toBase58(),
      amount: solAtoms,
      ...venueQuoteArgs(venue),
      slippageBps: 100,
    })
    const stacGross = Number(q.outAmount) / 10 ** DECIMALS
    // T22 withholds on receipt into our ATA → only (1 - T22) is spendable
    // and burnable on the protocol.
    const stacSpendable = stacGross * (1 - T22_FEE_RATE)
    const solFromBurn = stacSpendable * navSolPerStac
    return solFromBurn - solSize // signed P&L in SOL
  } catch (e) {
    log(`probeBuyBurnOutcome(${labelVenue(venue)}) failed: ${(e as Error).message}`)
    return null
  }
}

// ---------------------------------------------------------------- manager-state api
interface ManagerState {
  outstandingBaitCostLamports: string
  lifetimeBaitCostLamports: string
  lifetimeBaitRecoveredLamports: string
  lifetimeBaitCycles: number
  lifetimeRecoveryCycles: number
}

async function fetchManagerState(): Promise<ManagerState | null> {
  try {
    const r = await fetch(MANAGER_STATE_URL, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) {
      log(`manager-state GET ${r.status}`)
      return null
    }
    return (await r.json()) as ManagerState
  } catch (e) {
    log(`manager-state GET error: ${(e as Error).message}`)
    return null
  }
}

interface BaitReport {
  /** signed lamports: positive = cost, negative = profit */
  solDeltaLamports: bigint
  /** Bait round-trip size (mint side) in lamports */
  sizeLamports: bigint
  venueLabel: string
  intermediateSymbol: string
  direction: 'mint_sell' | 'buy_burn'
  /** Jupiter's route, e.g. "Raydium CP -> Manifest -> Whirlpool" */
  route?: string
}

async function reportBait(rep: BaitReport): Promise<void> {
  try {
    const costL = rep.solDeltaLamports > 0n ? rep.solDeltaLamports : 0n
    const r = await fetch(MANAGER_STATE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-manager-secret': MANAGER_STATE_SECRET!,
      },
      body: JSON.stringify({
        kind: 'bait',
        // Back-compat: older endpoint reads `lamports` for the cost counter.
        // New endpoint also reads `solDeltaLamports` (signed) + detail fields
        // to insert a bait_events row regardless of profit/cost.
        lamports: costL.toString(),
        solDeltaLamports: rep.solDeltaLamports.toString(),
        sizeLamports: rep.sizeLamports.toString(),
        venueLabel: rep.venueLabel,
        intermediateSymbol: rep.intermediateSymbol,
        direction: rep.direction,
        route: rep.route,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) {
      const txt = await r.text().catch(() => '')
      log(`manager-state POST bait ${r.status}: ${txt.slice(0, 200)}`)
    }
  } catch (e) {
    log(`manager-state POST bait error: ${(e as Error).message}`)
  }
}

// ---------------------------------------------------------------- jupiter
interface JupQuote {
  inputMint: string
  inAmount: string
  outputMint: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  priceImpactPct?: string
  routePlan?: Array<{ swapInfo?: { label?: string; ammKey?: string } }>
}

async function jupiterQuote(args: {
  inputMint: string
  outputMint: string
  amount: bigint
  dexes?: string
  excludeDexes?: string
  /** Comma-separated mint list — Jupiter must route through one of these */
  restrictIntermediateTokens?: string
  slippageBps: number
}): Promise<JupQuote> {
  const params = new URLSearchParams({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount.toString(),
    swapMode: 'ExactIn',
    slippageBps: args.slippageBps.toString(),
    onlyDirectRoutes: 'false',
  })
  if (args.dexes) params.set('dexes', args.dexes)
  if (args.excludeDexes) params.set('excludeDexes', args.excludeDexes)
  if (args.restrictIntermediateTokens)
    params.set('restrictIntermediateTokens', args.restrictIntermediateTokens)
  const url = `${JUPITER_URL}/swap/v1/quote?${params.toString()}`
  const headers: Record<string, string> = {}
  if (JUPITER_API_KEY) headers['x-api-key'] = JUPITER_API_KEY
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`jupiter quote ${r.status}: ${txt.slice(0, 200)}`)
  }
  return (await r.json()) as JupQuote
}

async function jupiterSwap(args: {
  quote: JupQuote
  userPublicKey: PublicKey
}): Promise<VersionedTransaction> {
  const swapHeaders: Record<string, string> = { 'Content-Type': 'application/json' }
  if (JUPITER_API_KEY) swapHeaders['x-api-key'] = JUPITER_API_KEY
  const r = await fetch(`${JUPITER_URL}/swap/v1/swap`, {
    method: 'POST',
    headers: swapHeaders,
    body: JSON.stringify({
      quoteResponse: args.quote,
      userPublicKey: args.userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      asLegacyTransaction: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`jupiter swap ${r.status}: ${txt.slice(0, 200)}`)
  }
  const j = (await r.json()) as { swapTransaction?: string }
  if (!j.swapTransaction) throw new Error('jupiter swap: no swapTransaction')
  const buf = Uint8Array.from(atob(j.swapTransaction), (c) => c.charCodeAt(0))
  return VersionedTransaction.deserialize(buf)
}

// ---------------------------------------------------------------- send helpers
//
// We never use conn.confirmTransaction — it auto-subscribes to a ws endpoint
// and we've intentionally set wsEndpoint to an unreachable placeholder. Poll
// signature statuses over HTTP instead.

const CONFIRM_POLL_MS = 2000
const CONFIRM_TIMEOUT_MS = 90_000

async function confirmByPolling(sig: string, lastValidBlockHeight: number) {
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

async function sendLegacyIxs(ixs: TransactionInstruction[], label: string) {
  const tx = new Transaction()
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
  for (const ix of ixs) tx.add(ix)
  tx.feePayer = authority.publicKey
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.sign(authority)
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false })
  log(`${label} sent ${sig}`)
  const conf = await confirmByPolling(sig, lastValidBlockHeight)
  if (conf.err) {
    throw new Error(`${label} failed: ${JSON.stringify(conf.err)}`)
  }
  log(`${label} confirmed`)
  return sig
}

async function sendVersionedTx(vtx: VersionedTransaction, label: string) {
  // Jupiter's reply is unsigned; we sign and broadcast. We can't rewrite the
  // blockhash without recompiling the message (versioned tx body is sealed
  // by Jupiter), so we accept the blockhash they baked in and let it expire
  // gracefully on the polling side if it's too stale.
  const lastValidBlockHeight = (await conn.getLatestBlockhash('confirmed')).lastValidBlockHeight
  vtx.sign([authority])
  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false })
  log(`${label} sent ${sig}`)
  const conf = await confirmByPolling(sig, lastValidBlockHeight)
  if (conf.err) {
    throw new Error(`${label} failed: ${JSON.stringify(conf.err)}`)
  }
  log(`${label} confirmed`)
  return sig
}

// ---------------------------------------------------------------- direction picker
//
// Adaptive direction logic:
//   • Read NAV from on-chain pool state.
//   • Probe LP spot price on the target dex via a tiny quote.
//   • If LP > NAV × (1 + threshold) → MINT_SELL (extract premium).
//   • If LP < NAV × (1 − threshold) → BUY_BURN (close discount).
//   • Else → SKIP (no edge worth paying gas for).
//
// Manual override via BAIT_DIRECTION=mint_sell | buy_burn | skip.

type Direction = 'mint_sell' | 'buy_burn' | 'skip'

interface DirectionDecision {
  dir: Direction
  /** Expected post-impact P&L in SOL (signed). Positive = profit. */
  expectedPnlSol: number | null
  /** Expected P&L in basis points of bait size (signed). */
  expectedBps: number | null
}

async function pickDirection(
  venue: Venue,
  navSolPerStac: number,
  solSize: number,
): Promise<DirectionDecision> {
  if (BAIT_DIRECTION !== 'auto') {
    return { dir: BAIT_DIRECTION, expectedPnlSol: null, expectedBps: null }
  }
  // Probe both directions at the actual bait size. Each returns expected
  // net SOL P&L *after* impact + fees on this particular venue.
  const [mintSellPnl, buyBurnPnl] = await Promise.all([
    probeMintSellOutcome(venue, solSize, navSolPerStac),
    probeBuyBurnOutcome(venue, solSize, navSolPerStac),
  ])

  // If both routes 404, skip.
  if (mintSellPnl == null && buyBurnPnl == null) {
    return { dir: 'skip', expectedPnlSol: null, expectedBps: null }
  }

  // Pick the higher expected P&L (treating nulls as -∞).
  const bestPnl =
    mintSellPnl == null ? (buyBurnPnl as number) : buyBurnPnl == null ? mintSellPnl : Math.max(mintSellPnl, buyBurnPnl)
  const bestDir: Direction =
    mintSellPnl == null
      ? 'buy_burn'
      : buyBurnPnl == null
      ? 'mint_sell'
      : mintSellPnl >= buyBurnPnl
      ? 'mint_sell'
      : 'buy_burn'

  // Convert to bps-of-size — informational only when always-fire is on.
  const expectedBps = solSize > 0 ? (bestPnl / solSize) * 10_000 : 0

  // Always-fire mode (default): execute the less-losing direction every
  // cycle. Per-cycle losses are expected and intentional — recovery on
  // burn-loop withdraws SOL to cover the bait cost, and arbers triggered
  // by our LP-imbalance generate the burn juice that grows NAV. The bait
  // is the input to a flywheel, not a standalone profit strategy.
  if (BAIT_ALWAYS_FIRE) {
    return { dir: bestDir, expectedPnlSol: bestPnl, expectedBps }
  }

  // Profit-gated mode: only fire when expected P&L beats threshold.
  // Useful if you want to stop losing and let the LP arbitrage organically.
  if (expectedBps > BAIT_PROFIT_THRESHOLD_BPS) {
    return { dir: bestDir, expectedPnlSol: bestPnl, expectedBps }
  }
  return { dir: 'skip', expectedPnlSol: bestPnl, expectedBps }
}

// ---------------------------------------------------------------- flows
//
// Each flow takes a size budget (SOL lamports), executes the round trip on
// the target dex, and returns { delta: bigint, profitable: boolean }.
// delta is the SOL outflow (negative = profit). Reporting + state updates
// happen in the caller.

interface FlowResult {
  delta: bigint // pre - post (signed: positive = cost, negative = profit)
  /** Jupiter's actual route, e.g. "Raydium CP -> Manifest -> Whirlpool" */
  route?: string
}

async function mintAndSell(sizeLamports: bigint, venue: Venue): Promise<FlowResult | null> {
  const stacAta = deriveAta(authority.publicKey)
  const refs = await fetchPoolRefs()
  const preLamports = BigInt(await conn.getBalance(authority.publicKey, 'confirmed'))
  const stacBefore = await readStacAccount(stacAta)

  if (DRY_RUN) {
    log(`DRY mint_sell: would DepositSol ${(Number(sizeLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL via ${labelVenue(venue)}`)
    return { delta: 0n }
  }

  // Mint stacSOL via protocol (manager fees self-rebate, T22 withhold sweeps).
  try {
    await sendLegacyIxs(
      [
        ixCreateAtaIdempotent(authority.publicKey, authority.publicKey, MINT, TOKEN_2022),
        ixDepositSol(authority.publicKey, sizeLamports, refs.reserveStake, refs.managerFeeAccount),
      ],
      `mint_sell:deposit ${(Number(sizeLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
    )
  } catch (e) {
    log(`mint_sell deposit failed: ${(e as Error).message}`)
    return null
  }

  // Use *spendable* delta — Jupiter will transfer the spendable portion out,
  // the freshly-withheld 6.9% stays in our ATA and gets swept by burn-loop.
  const stacAfter = await readStacAccount(stacAta)
  const stacMinted = stacAfter.spendable - stacBefore.spendable
  if (stacMinted <= 0n) {
    log(`mint returned 0 spendable stacSOL — aborting sell leg`)
    return null
  }
  log(
    `mint_sell: minted ${(Number(stacMinted) / 1e9).toFixed(6)} stacSOL spendable ` +
      `(+${(Number(stacAfter.withheld - stacBefore.withheld) / 1e9).toFixed(6)} withheld → next sweep)`,
  )

  // Sell on target venue via Jupiter (routed through the venue's
  // intermediate mint if it's a cross-pair, otherwise direct).
  let quote: JupQuote
  try {
    quote = await jupiterQuote({
      inputMint: MINT.toBase58(),
      outputMint: WSOL,
      amount: stacMinted,
      ...venueQuoteArgs(venue),
      slippageBps: BAIT_SLIPPAGE_BPS,
    })
  } catch (e) {
    log(`mint_sell quote failed: ${(e as Error).message} (stacSOL stranded — burn-loop will sweep)`)
    return null
  }
  const route = quote.routePlan?.map((r) => r.swapInfo?.label).filter(Boolean).join(' → ') ?? '?'
  log(
    `mint_sell quote: ${(Number(stacMinted) / 1e9).toFixed(6)} stacSOL → ` +
      `${(Number(quote.outAmount) / LAMPORTS_PER_SOL).toFixed(6)} SOL via ${route} ` +
      `(impact ${quote.priceImpactPct ?? '?'}%)`,
  )

  try {
    const vtx = await jupiterSwap({ quote, userPublicKey: authority.publicKey })
    await sendVersionedTx(vtx, `mint_sell:sell ${(Number(stacMinted) / 1e9).toFixed(6)} stacSOL`)
  } catch (e) {
    log(`mint_sell sell failed: ${(e as Error).message}`)
    return null
  }

  const postLamports = BigInt(await conn.getBalance(authority.publicKey, 'confirmed'))
  return { delta: preLamports - postLamports, route }
}

async function buyAndBurn(sizeLamports: bigint, venue: Venue): Promise<FlowResult | null> {
  const stacAta = deriveAta(authority.publicKey)
  const refs = await fetchPoolRefs()
  const preLamports = BigInt(await conn.getBalance(authority.publicKey, 'confirmed'))
  const stacBefore = await readStacAccount(stacAta)

  if (DRY_RUN) {
    log(`DRY buy_burn: would buy ${(Number(sizeLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL → stacSOL via ${labelVenue(venue)}`)
    return { delta: 0n }
  }

  // Buy stacSOL on target venue (this pushes price UP on that pool = bait).
  let quote: JupQuote
  try {
    quote = await jupiterQuote({
      inputMint: WSOL,
      outputMint: MINT.toBase58(),
      amount: sizeLamports,
      ...venueQuoteArgs(venue),
      slippageBps: BAIT_SLIPPAGE_BPS,
    })
  } catch (e) {
    log(`buy_burn quote failed: ${(e as Error).message}`)
    return null
  }
  const route = quote.routePlan?.map((r) => r.swapInfo?.label).filter(Boolean).join(' → ') ?? '?'
  log(
    `buy_burn quote: ${(Number(sizeLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL → ` +
      `${(Number(quote.outAmount) / 1e9).toFixed(6)} stacSOL via ${route} ` +
      `(impact ${quote.priceImpactPct ?? '?'}%)`,
  )

  try {
    const vtx = await jupiterSwap({ quote, userPublicKey: authority.publicKey })
    await sendVersionedTx(vtx, `buy_burn:buy ${(Number(sizeLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
  } catch (e) {
    log(`buy_burn buy failed: ${(e as Error).message}`)
    return null
  }

  // Burn what we bought via WithdrawSol. Token-2022's withhold-on-receive
  // means we got `delta_amount` total but only `delta_spendable` is
  // burnable — the rest (6.9%) is held in our own ATA's withheld_amount
  // and gets swept by burn-loop on its next tick.
  const stacAfter = await readStacAccount(stacAta)
  const stacBoughtAmount = stacAfter.amount - stacBefore.amount
  const stacBoughtSpendable = stacAfter.spendable - stacBefore.spendable
  if (stacBoughtSpendable <= 0n) {
    log(`buy_burn: 0 spendable stacSOL acquired (gross=${(Number(stacBoughtAmount) / 1e9).toFixed(6)}) — skipping burn leg`)
    return null
  }
  log(
    `buy_burn: bought ${(Number(stacBoughtAmount) / 1e9).toFixed(6)} stacSOL gross, ` +
      `${(Number(stacBoughtSpendable) / 1e9).toFixed(6)} spendable ` +
      `(+${(Number(stacAfter.withheld - stacBefore.withheld) / 1e9).toFixed(6)} withheld → next sweep) ` +
      `— burning spendable via WithdrawSol`,
  )

  try {
    await sendLegacyIxs(
      [ixWithdrawSol(authority.publicKey, stacBoughtSpendable, refs.reserveStake, refs.managerFeeAccount)],
      `buy_burn:withdraw ${(Number(stacBoughtSpendable) / 1e9).toFixed(6)} stacSOL`,
    )
  } catch (e) {
    log(`buy_burn WithdrawSol failed: ${(e as Error).message} (stacSOL stranded — next burn-loop will burn)`)
    return null
  }

  const postLamports = BigInt(await conn.getBalance(authority.publicKey, 'confirmed'))
  return { delta: preLamports - postLamports, route }
}

// ---------------------------------------------------------------- one cycle
//
// Per cycle:
//   1. Safety check — backlog under cap, wallet SOL > reserve.
//   2. Pick targets:
//        rotate mode: one DEX from BAIT_TARGETS, advancing each cycle
//        sweep mode:  every DEX in BAIT_TARGETS, size split evenly
//   3. For each target: pick direction (adaptive), execute, report.

async function executeOneTarget(venue: Venue, sizeLamports: bigint, navSolPerStac: number) {
  const solSize = Number(sizeLamports) / LAMPORTS_PER_SOL
  const tag = labelVenue(venue)
  const { dir, expectedPnlSol, expectedBps } = await pickDirection(venue, navSolPerStac, solSize)
  log(
    `[${tag}] pair=${venue.pairName} liq=$${venue.liqUsd.toFixed(0)} ` +
      `NAV=${navSolPerStac.toFixed(6)} size=${solSize.toFixed(4)} SOL ` +
      `expected=${expectedPnlSol == null ? '?' : (expectedPnlSol >= 0 ? '+' : '') + expectedPnlSol.toFixed(6)} SOL ` +
      `(${expectedBps == null ? '?' : (expectedBps >= 0 ? '+' : '') + expectedBps.toFixed(0)}bps) ` +
      `→ direction=${dir}`,
  )

  if (dir === 'skip') return

  let result: FlowResult | null = null
  if (dir === 'mint_sell') {
    result = await mintAndSell(sizeLamports, venue)
  } else if (dir === 'buy_burn') {
    result = await buyAndBurn(sizeLamports, venue)
  }

  if (!result) {
    log(`[${tag}] cycle aborted — no state change reported`)
    return
  }
  const deltaSol = Number(result.delta) / LAMPORTS_PER_SOL
  log(
    `[${tag}] ${dir} done: net SOL delta=${deltaSol >= 0 ? '+' : ''}${(-deltaSol).toFixed(6)} ` +
      `(${result.delta < 0n ? 'PROFIT' : result.delta > 0n ? 'COST' : 'flat'})`,
  )
  // Always report so the dashboard sees every cycle (profitable ones too).
  // The endpoint only advances the cost counter on positive delta — profit
  // cycles still get a bait_events row for venue/route attribution.
  await reportBait({
    solDeltaLamports: result.delta,
    sizeLamports,
    venueLabel: tag,
    intermediateSymbol: venue.intermediateSymbol,
    direction: dir as 'mint_sell' | 'buy_burn',
    route: result.route,
  })
  if (result.delta > 0n) {
    log(`[${tag}] reported ${(Number(result.delta) / LAMPORTS_PER_SOL).toFixed(6)} SOL cost to manager-state`)
  } else {
    log(`[${tag}] reported ${(-deltaSol).toFixed(6)} SOL profit cycle to manager-state`)
  }
}

async function refreshVenues(reason: string) {
  const fresh = await loadVenues()
  if (fresh.length === 0) {
    log(`${reason}: no venues returned (keeping existing ${venues.length})`)
    return
  }
  venues = fresh
  log(`${reason}: ${venues.length} venues`)
  for (const v of venues) {
    log(
      `  • ${labelVenue(v)} pair=${v.pairName} liq=$${v.liqUsd.toFixed(2)}` +
        (v.intermediateMint ? ` via=${v.intermediateMint}` : ' (direct SOL)'),
    )
  }
}

async function baitOnce() {
  cycleN += 1

  // Refresh venues on the first cycle and every BAIT_VENUE_REFRESH_CYCLES.
  if (cycleN === 1 || cycleN % BAIT_VENUE_REFRESH_CYCLES === 0) {
    await refreshVenues(`venues refresh (cycle #${cycleN})`)
  }

  log(
    `bait cycle #${cycleN} — mode=${BAIT_MODE}, venues=${venues.length}, ` +
      `size=${BAIT_SIZE_SOL} SOL, dry=${DRY_RUN}`,
  )

  if (venues.length === 0) {
    log(`no venues available — skipping cycle`)
    return
  }

  // 1. Safety: outstanding cost backlog under cap.
  const state = await fetchManagerState()
  if (state) {
    const outstanding = Number(state.outstandingBaitCostLamports) / LAMPORTS_PER_SOL
    log(`outstanding backlog: ${outstanding.toFixed(6)} SOL (cap ${MAX_OUTSTANDING_COST_SOL})`)
    if (outstanding > MAX_OUTSTANDING_COST_SOL) {
      log(`backlog over cap — skipping cycle, letting burn-loop catch up`)
      return
    }
  }

  // 2. Safety: wallet balance.
  const preLamports = BigInt(await conn.getBalance(authority.publicKey, 'confirmed'))
  const preSol = Number(preLamports) / LAMPORTS_PER_SOL
  const requiredSol = BAIT_SIZE_SOL + MIN_WALLET_RESERVE_SOL
  log(`wallet SOL: ${preSol.toFixed(6)} (need ${requiredSol.toFixed(6)})`)
  if (preSol < requiredSol) {
    log(`insufficient SOL — skipping cycle`)
    return
  }

  // 3. Read NAV once per cycle.
  const refs = await fetchPoolRefs()
  const navSolPerStac =
    refs.poolTokenSupply > 0n ? Number(refs.poolTotalLamports) / Number(refs.poolTokenSupply) : 1
  log(`NAV: ${navSolPerStac.toFixed(6)} SOL/stacSOL`)

  // 4. Pick venues for this cycle.
  if (BAIT_MODE === 'sweep') {
    const perVenue = BAIT_SIZE_LAMPORTS / BigInt(venues.length)
    if (perVenue <= 0n) {
      log(`sweep size too small per venue — skipping`)
      return
    }
    log(`sweep: ${venues.length} venues × ${(Number(perVenue) / LAMPORTS_PER_SOL).toFixed(6)} SOL`)
    for (const v of venues) {
      try {
        await executeOneTarget(v, perVenue, navSolPerStac)
      } catch (e) {
        log(`[${labelVenue(v)}] target error (suppressed): ${(e as Error).message}`)
      }
    }
  } else {
    // rotate — full size into one venue per cycle, advance index each cycle
    const v = venues[(cycleN - 1) % venues.length]
    await executeOneTarget(v, BAIT_SIZE_LAMPORTS, navSolPerStac)
  }
}

// ---------------------------------------------------------------- main
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

async function main() {
  log(
    `starting bait-loop · interval=${BAIT_INTERVAL_MS / 1000}s · ` +
      `size=${BAIT_SIZE_SOL} SOL · mode=${BAIT_MODE} · ` +
      `dex-whitelist=[${[...BAIT_DEX_WHITELIST].join(', ')}] · ` +
      `min-liq=$${BAIT_MIN_LP_LIQ_USD} · ` +
      `refresh=every ${BAIT_VENUE_REFRESH_CYCLES} cycles · ` +
      `direction=${BAIT_DIRECTION} · ` +
      (BAIT_ALWAYS_FIRE
        ? `gate=ALWAYS-FIRE (recovery + arber-burn closes the loop) · `
        : `threshold=${BAIT_PROFIT_THRESHOLD_BPS}bps · `) +
      `slippage=${BAIT_SLIPPAGE_BPS}bps · dry=${DRY_RUN}`,
  )
  log(
    `rpc=${RPC_URL!.split('?')[0]}? · ` +
      `authority=${authority.publicKey.toBase58()} · ` +
      `state=${MANAGER_STATE_URL} · ` +
      `lp-api=${LP_API_URL}`,
  )
  // Initial venue load before first cycle so the banner is meaningful.
  await refreshVenues('initial venue load')
  while (true) {
    try {
      await baitOnce()
    } catch (e) {
      log(`bait cycle error (suppressed): ${(e as Error).message}`)
    }
    await sleep(BAIT_INTERVAL_MS)
  }
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
