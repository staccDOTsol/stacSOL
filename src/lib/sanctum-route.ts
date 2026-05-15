// Sanctum SOL ↔ LST routing for curve-launchpad trades.
//
// The launchpad's `buy`/`sell` ixs take an LST (stacSOL) as quote. The user
// thinks in SOL. This file composes the two-hop transaction so the user's
// SOL gets deposited into the Sanctum SPL stake pool (yielding stacSOL) just
// before a buy, and the LST proceeds of a sell get redeemed back to SOL.
//
// We deliberately reuse the existing `ixDepositSol` / `ixWithdrawSol` helpers
// from `lib/ix.ts` — they already implement the Sanctum-flavored SPL stake-
// pool variants 14 (DepositSol) and 16 (WithdrawSol) against the stacSOL
// pool. No external Sanctum router SDK is needed because stacSOL IS a
// Sanctum SPL stake pool; the deposit/withdraw ixs ARE the Sanctum router
// for this LST.
//
// Token-2022 TransferFee handling: stacSOL has a 6.9% transfer fee. The
// curve's accounts receive LST through SPL transfers — so each transfer is
// fee'd. To absorb both rounding and an unfavorable rate move between
// preview and on-chain execution we pad the quote-cost cap (buy) / floor
// (sell). The defaults here aim at +/-1% on top of the 6.9% the pool
// withholds itself; tighten if slippage tolerance matters more than
// reliability of landing.

import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  ixCreateAtaIdempotent,
  ixDepositSol,
  ixWithdrawSol,
} from './ix'
import { MINT as QUOTE_MINT, TOKEN_2022 } from './constants'
import type { PoolState } from './pool'
import {
  ixCurveBuy,
  ixCurveSell,
  previewBuy,
  previewSell,
  type BondingCurveState,
  type GlobalState,
} from './curve-launchpad'

/** Slippage buffer on the LST side, in basis points. 100 = 1%. */
export const DEFAULT_LST_SLIPPAGE_BPS = 100n

/**
 * Convert SOL lamports → expected stacSOL atoms at the pool's current rate.
 *
 * NAV = pool.poolTotalLamports / pool.poolTokenSupplyAccounting. Inverted:
 * 1 lamport of SOL → (1 / NAV) atoms of stacSOL, minus the 6.9% deposit fee.
 *
 * The pool charges a deposit fee (`epochFeeNumer / epochFeeDenom`). After
 * the deposit, the user's stacSOL ATA receives `(lamports / NAV) * (1 -
 * deposit_fee_rate)` atoms. We use this preview to size `max_quote_cost` on
 * a buy.
 */
export function previewSolToLst(lamports: bigint, pool: PoolState): bigint {
  if (pool.poolTotalLamports === 0n) return 0n
  // (lamports * supply) / total = stacSOL atoms BEFORE fee.
  const grossAtoms = (lamports * pool.poolTokenSupplyAccounting) / pool.poolTotalLamports
  // Deposit fee withheld by the pool, in pool units. epochFeeDenom == 0
  // means no fee; guard against division by zero.
  if (pool.epochFeeDenom === 0n) return grossAtoms
  const feeAtoms = (grossAtoms * pool.epochFeeNumer) / pool.epochFeeDenom
  return grossAtoms - feeAtoms
}

/**
 * Convert stacSOL atoms → expected SOL lamports redeemed via WithdrawSol.
 * Pool charges a SOL withdrawal fee too; we use the same epoch-fee fields
 * (current pool config has matching numerator/denom for both directions —
 * see `pool.ts` for the parsed offsets).
 */
export function previewLstToSol(atoms: bigint, pool: PoolState): bigint {
  if (pool.poolTokenSupplyAccounting === 0n) return 0n
  const grossLamports = (atoms * pool.poolTotalLamports) / pool.poolTokenSupplyAccounting
  if (pool.epochFeeDenom === 0n) return grossLamports
  const feeLamports = (grossLamports * pool.epochFeeNumer) / pool.epochFeeDenom
  return grossLamports - feeLamports
}

/** Add slippage tolerance on top of a quoted LST cost (buy direction). */
export function padUp(amount: bigint, bps: bigint = DEFAULT_LST_SLIPPAGE_BPS): bigint {
  return amount + (amount * bps) / 10000n
}

/** Subtract slippage tolerance from a quoted LST receipt (sell direction). */
export function padDown(amount: bigint, bps: bigint = DEFAULT_LST_SLIPPAGE_BPS): bigint {
  // Floor at 0 — pathological case where bps ≥ 10000.
  const reduction = (amount * bps) / 10000n
  return reduction >= amount ? 0n : amount - reduction
}

// ---------------------------------------------------------------------------
// Trade builders
// ---------------------------------------------------------------------------

export interface BuildBuyArgs {
  user: PublicKey
  /** MEME mint of the curve being bought. */
  mint: PublicKey
  /** SOL lamports the user is spending. */
  solLamports: bigint
  /** Number of MEME atoms (atomic units) targeted for purchase. */
  tokenAmount: bigint
  pool: PoolState
  global: GlobalState
  bondingCurve: BondingCurveState
  feeRecipient: PublicKey
  /** Optional override on the LST slippage buffer (default 1%). */
  lstSlippageBps?: bigint
  /** Optional referral ATA for the Sanctum DepositSol slot. */
  referralAta?: PublicKey
}

export interface BuiltBuy {
  ixs: TransactionInstruction[]
  /** Quoted LST atoms received from the SOL deposit (before TransferFee). */
  lstExpected: bigint
  /** maxQuoteCost passed to the curve ix (lstExpected with buffer). */
  maxQuoteCost: bigint
  /** Curve-side preview (MEME out, LST in pre-fee, fee). */
  preview: ReturnType<typeof previewBuy>
}

/**
 * Compose `[create-ATAs, depositSolToLst, curveBuy]`.
 *
 * The caller signs and sends the resulting tx. ATAs for MEME (user) and LST
 * (user + fee recipient) are created idempotently — the curve program also
 * marks them `init_if_needed` but issuing the ix here saves a Compute Units
 * round-trip if the program's `init_if_needed` path is missed (e.g. user
 * lacks rent for both ATAs because the deposit hasn't landed yet).
 */
export function buildBuy(args: BuildBuyArgs): BuiltBuy {
  const slippageBps = args.lstSlippageBps ?? DEFAULT_LST_SLIPPAGE_BPS
  const lstExpected = previewSolToLst(args.solLamports, args.pool)
  // Pre-curve preview of what max_quote_cost the curve will charge.
  const preview = previewBuy(
    args.bondingCurve,
    args.tokenAmount,
    args.global.feeBasisPoints,
  )
  // Cap at the expected LST receipt, padded up so a brief rate dip between
  // sim and execution doesn't fail the buy. If the curve's own quote is the
  // tighter constraint we cap there (no reason to send more allowance than
  // the curve will consume).
  const paddedLst = padUp(lstExpected, slippageBps)
  const maxQuoteCost = paddedLst < preview.totalQuote ? padUp(preview.totalQuote, slippageBps) : paddedLst

  const ixs: TransactionInstruction[] = []
  // The Sanctum DepositSol ix only takes a stacSOL ATA for the depositor;
  // the referral ATA is required to exist by the pool program. The curve's
  // `init_if_needed` covers the user/fee-recipient quote ATAs but we still
  // ensure the user's MEME ATA exists ahead of the curve transfer.
  ixs.push(
    ixCreateAtaIdempotent(args.user, args.user, QUOTE_MINT, TOKEN_2022),
  )
  ixs.push(ixDepositSol(args.user, args.solLamports, args.pool, args.referralAta))
  ixs.push(
    ixCurveBuy({
      user: args.user,
      feeRecipient: args.feeRecipient,
      mint: args.mint,
      tokenAmount: args.tokenAmount,
      maxQuoteCost,
    }),
  )

  return { ixs, lstExpected, maxQuoteCost, preview }
}

export interface BuildSellArgs {
  user: PublicKey
  mint: PublicKey
  /** MEME atomic units being sold. */
  tokenAmount: bigint
  pool: PoolState
  global: GlobalState
  bondingCurve: BondingCurveState
  feeRecipient: PublicKey
  lstSlippageBps?: bigint
}

export interface BuiltSell {
  ixs: TransactionInstruction[]
  /** LST atoms expected from the curve (net of curve fee). */
  lstExpected: bigint
  /** minQuoteOutput passed to the curve ix. */
  minQuoteOutput: bigint
  /** SOL lamports the user should receive after the WithdrawSol redemption. */
  solExpected: bigint
  preview: ReturnType<typeof previewSell>
}

/**
 * Compose `[curveSell, withdrawSolFromLst]`.
 *
 * The curve's sell hands LST to the user's quote ATA. We immediately burn
 * the same amount via the SPL stake-pool WithdrawSol ix so the user ends
 * the tx with SOL in their wallet — no LST overhang.
 *
 * Note: we use the LST amount the curve says it will pay (`preview.totalQuote`)
 * minus a small buffer to cover the curve's actual on-chain rounding when
 * computing the WithdrawSol amount. If the curve pays MORE than buffered,
 * the leftover dust stays in the user's stacSOL ATA — harmless, recoverable
 * later from the dashboard.
 */
export function buildSell(args: BuildSellArgs): BuiltSell {
  const slippageBps = args.lstSlippageBps ?? DEFAULT_LST_SLIPPAGE_BPS
  const preview = previewSell(
    args.bondingCurve,
    args.tokenAmount,
    args.global.feeBasisPoints,
    args.global.initialVirtualTokenReserves,
  )
  // User must accept at least `lstFloor` LST from the curve.
  const lstFloor = padDown(preview.totalQuote, slippageBps)
  // Amount we'll redeem via WithdrawSol — same floor (dust above this lands
  // in user's wallet as stacSOL, which they can withdraw via /app later).
  const lstToBurn = lstFloor
  const solExpected = previewLstToSol(lstToBurn, args.pool)

  const ixs: TransactionInstruction[] = []
  ixs.push(
    ixCreateAtaIdempotent(args.user, args.user, QUOTE_MINT, TOKEN_2022),
  )
  ixs.push(
    ixCurveSell({
      user: args.user,
      feeRecipient: args.feeRecipient,
      mint: args.mint,
      tokenAmount: args.tokenAmount,
      minQuoteOutput: lstFloor,
    }),
  )
  if (lstToBurn > 0n) {
    ixs.push(ixWithdrawSol(args.user, lstToBurn, args.pool))
  }

  return {
    ixs,
    lstExpected: preview.totalQuote,
    minQuoteOutput: lstFloor,
    solExpected,
    preview,
  }
}
