// Minimal curve-launchpad client.
//
// The on-chain program lives at `Cpm3iVenngWyh3YQUXtjR1PudXBXfJJqLhxMGrDiVSkW`
// (see ~/triton/curve-launchpad/programs/curve-launchpad/src/lib.rs). It's an
// Anchor-style bonding-curve launchpad whose quote token was migrated from
// native SOL to an LST (stacSOL — see SPEC.md §1). The program is unaware of
// Sanctum; from its point of view a buy is "user transfers LST in, gets MEME
// out" and a sell is the mirror.
//
// We only need `buy` and `sell` from this file — the Sanctum SOL ↔ LST hop
// is composed alongside it by `lib/sanctum-route.ts`. We deliberately do NOT
// pull in `@coral-xyz/anchor` here to keep this file tree-shakeable and
// avoid dragging the Anchor IDL parser into the buy/sell path. Instead we
// hand-pack the discriminator + args (mirroring the pattern already used
// for `lib/ix.ts` against the SPL stake-pool program).
//
// The Anchor discriminator is the first 8 bytes of `sha256("global:<ix>")`.
// Account ordering matches the order declared on `#[derive(Accounts)]` in
// `instructions/buy.rs` and `instructions/sell.rs`. If those structs grow,
// the order here MUST be kept in sync.

import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { MINT as QUOTE_MINT, TOKEN_2022 } from './constants'

// Curve-launchpad program ID (declared in curve-launchpad/src/lib.rs).
export const CURVE_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  'Cpm3iVenngWyh3YQUXtjR1PudXBXfJJqLhxMGrDiVSkW',
)

// Anchor `#[event_cpi]` ABI requires the event-authority PDA + program self
// as trailing accounts on every CPI ix. They're derived from the program ID
// (event authority is `["__event_authority"]`).
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority')

function deriveEventAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([EVENT_AUTHORITY_SEED], programId)[0]
}

const GLOBAL_SEED = Buffer.from('global')
const BONDING_CURVE_SEED = Buffer.from('bonding-curve')

export function deriveGlobal(programId = CURVE_LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([GLOBAL_SEED], programId)[0]
}

export function deriveBondingCurve(
  mint: PublicKey,
  programId = CURVE_LAUNCHPAD_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBytes()],
    programId,
  )[0]
}

// ---------------------------------------------------------------------------
// Anchor discriminators — sha256("global:<ix_name>")[..8]
// Pre-computed so this module is sync-friendly (no top-level await).
// ---------------------------------------------------------------------------

/** sha256("global:buy")[..8] */
const BUY_DISCRIMINATOR = new Uint8Array([
  102, 6, 61, 18, 1, 218, 235, 234,
])
/** sha256("global:sell")[..8] */
const SELL_DISCRIMINATOR = new Uint8Array([
  51, 230, 133, 164, 1, 127, 131, 173,
])

const u64le = (v: bigint | number) => {
  const n = BigInt(v)
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn)
  return out
}

const concat = (...arrs: Uint8Array[]) => {
  const total = arrs.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Shared account derivation
// ---------------------------------------------------------------------------

interface TradeAccounts {
  user: PublicKey
  feeRecipient: PublicKey
  mint: PublicKey
  /** Defaults to the stacSOL mint. Must match `Global.quote_mint`. */
  quoteMint?: PublicKey
}

interface ResolvedTradeAccounts {
  user: PublicKey
  global: PublicKey
  feeRecipient: PublicKey
  mint: PublicKey
  quoteMint: PublicKey
  bondingCurve: PublicKey
  bondingCurveTokenAccount: PublicKey
  bondingCurveQuoteAccount: PublicKey
  userTokenAccount: PublicKey
  userQuoteAccount: PublicKey
  feeRecipientQuoteAccount: PublicKey
  eventAuthority: PublicKey
  program: PublicKey
}

function resolveAccounts(args: TradeAccounts): ResolvedTradeAccounts {
  const { user, feeRecipient, mint } = args
  const quoteMint = args.quoteMint ?? QUOTE_MINT

  const bondingCurve = deriveBondingCurve(mint)
  // MEME token: standard SPL token program.
  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
  )
  const userTokenAccount = getAssociatedTokenAddressSync(
    mint,
    user,
    false,
    TOKEN_PROGRAM_ID,
  )
  // Quote (stacSOL) is Token-2022.
  const bondingCurveQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    bondingCurve,
    true,
    TOKEN_2022,
  )
  const userQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    user,
    false,
    TOKEN_2022,
  )
  const feeRecipientQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    feeRecipient,
    true,
    TOKEN_2022,
  )

  return {
    user,
    global: deriveGlobal(),
    feeRecipient,
    mint,
    quoteMint,
    bondingCurve,
    bondingCurveTokenAccount,
    bondingCurveQuoteAccount,
    userTokenAccount,
    userQuoteAccount,
    feeRecipientQuoteAccount,
    eventAuthority: deriveEventAuthority(CURVE_LAUNCHPAD_PROGRAM_ID),
    program: CURVE_LAUNCHPAD_PROGRAM_ID,
  }
}

// ---------------------------------------------------------------------------
// buy / sell ixs
//
// Account ordering MUST match the `#[derive(Accounts)]` declaration in
// `programs/curve-launchpad/src/instructions/buy.rs` and `sell.rs`. The
// `#[event_cpi]` macro appends `event_authority` + program self after the
// declared accounts.
// ---------------------------------------------------------------------------

export interface BuyParams extends TradeAccounts {
  /** Atomic units of MEME the user is buying. */
  tokenAmount: bigint
  /** Atomic units of LST the user is willing to spend at most (incl. fee). */
  maxQuoteCost: bigint
}

export function ixCurveBuy(params: BuyParams): TransactionInstruction {
  const a = resolveAccounts(params)
  const data = concat(BUY_DISCRIMINATOR, u64le(params.tokenAmount), u64le(params.maxQuoteCost))

  return new TransactionInstruction({
    programId: CURVE_LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: a.user, isSigner: true, isWritable: true },
      { pubkey: a.global, isSigner: false, isWritable: false },
      { pubkey: a.feeRecipient, isSigner: false, isWritable: false },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: a.quoteMint, isSigner: false, isWritable: false },
      { pubkey: a.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: a.bondingCurveTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.bondingCurveQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: a.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.userQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: a.feeRecipientQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      // The program declares `token_program: Program<'info, Token>` (legacy
      // SPL Token) — used to move MEME between curve ↔ user. The quote ATA
      // transfers will need Token-2022 once the program is updated to be
      // mixed-token aware. For now we pass legacy Token to satisfy the
      // declared constraint; flagged in SPEC.md follow-up.
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      // #[event_cpi] trailing accounts
      { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: a.program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

export interface SellParams extends TradeAccounts {
  /** Atomic units of MEME the user is selling. */
  tokenAmount: bigint
  /** Atomic units of LST the user must receive at least (after fee). */
  minQuoteOutput: bigint
}

export function ixCurveSell(params: SellParams): TransactionInstruction {
  const a = resolveAccounts(params)
  const data = concat(SELL_DISCRIMINATOR, u64le(params.tokenAmount), u64le(params.minQuoteOutput))

  return new TransactionInstruction({
    programId: CURVE_LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: a.user, isSigner: true, isWritable: true },
      { pubkey: a.global, isSigner: false, isWritable: false },
      { pubkey: a.feeRecipient, isSigner: false, isWritable: false },
      { pubkey: a.mint, isSigner: false, isWritable: false },
      { pubkey: a.quoteMint, isSigner: false, isWritable: false },
      { pubkey: a.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: a.bondingCurveTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.bondingCurveQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: a.userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: a.userQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: a.feeRecipientQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: a.program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

// ---------------------------------------------------------------------------
// BondingCurve / Global account fetchers
//
// Both accounts have a fixed-size prefix; we parse only the fields the trade
// quote needs. Discriminator-aware Anchor `program.account.X.fetch` would
// drag the whole IDL parser into the bundle.
// ---------------------------------------------------------------------------

export interface BondingCurveState {
  virtualQuoteReserves: bigint
  virtualTokenReserves: bigint
  realQuoteReserves: bigint
  realTokenReserves: bigint
  tokenTotalSupply: bigint
  complete: boolean
}

export function parseBondingCurve(data: Buffer): BondingCurveState {
  // 8-byte Anchor discriminator + struct (no Pubkeys, all u64+bool).
  const o = 8
  return {
    virtualQuoteReserves: data.readBigUInt64LE(o + 0),
    virtualTokenReserves: data.readBigUInt64LE(o + 8),
    realQuoteReserves: data.readBigUInt64LE(o + 16),
    realTokenReserves: data.readBigUInt64LE(o + 24),
    tokenTotalSupply: data.readBigUInt64LE(o + 32),
    complete: data[o + 40] === 1,
  }
}

export interface GlobalState {
  authority: PublicKey
  initialized: boolean
  feeRecipient: PublicKey
  initialVirtualTokenReserves: bigint
  initialVirtualQuoteReserves: bigint
  initialRealTokenReserves: bigint
  initialRealQuoteReserves: bigint
  initialTokenSupply: bigint
  feeBasisPoints: bigint
  withdrawAuthority: PublicKey
  quoteMint: PublicKey
}

export function parseGlobal(data: Buffer): GlobalState {
  const o = 8
  const pk = (off: number) => new PublicKey(data.subarray(off, off + 32))
  return {
    authority: pk(o + 0),
    initialized: data[o + 32] === 1,
    feeRecipient: pk(o + 33),
    initialVirtualTokenReserves: data.readBigUInt64LE(o + 65),
    initialVirtualQuoteReserves: data.readBigUInt64LE(o + 73),
    initialRealTokenReserves: data.readBigUInt64LE(o + 81),
    initialRealQuoteReserves: data.readBigUInt64LE(o + 89),
    initialTokenSupply: data.readBigUInt64LE(o + 97),
    feeBasisPoints: data.readBigUInt64LE(o + 105),
    withdrawAuthority: pk(o + 113),
    quoteMint: pk(o + 145),
  }
}

// ---------------------------------------------------------------------------
// AMM math — port of programs/curve-launchpad/src/amm/amm.rs. Used by the
// frontend to derive (1) the quote-in amount for a given MEME-out target on
// buy, and (2) the quote-out amount for a given MEME-in on sell. Mirrors the
// on-chain `get_buy_price` / `get_sell_price` exactly so client preview
// matches what the program will charge.
// ---------------------------------------------------------------------------

export interface QuotePreview {
  /** MEME atomic units exchanged. */
  tokenAmount: bigint
  /** LST atomic units exchanged (pre-fee). */
  quoteAmount: bigint
  /** Fee in LST atomic units. */
  fee: bigint
  /** Total LST in (buy) or net LST out (sell). */
  totalQuote: bigint
}

/** Replicates apply_buy + fee — quote required to buy `tokenAmount` MEME. */
export function previewBuy(
  curve: BondingCurveState,
  tokenAmount: bigint,
  feeBasisPoints: bigint,
): QuotePreview {
  const finalTokenAmount =
    tokenAmount > curve.realTokenReserves ? curve.realTokenReserves : tokenAmount

  const product = curve.virtualQuoteReserves * curve.virtualTokenReserves
  const newVirtTok = curve.virtualTokenReserves - finalTokenAmount
  const newVirtQuote = product / newVirtTok + 1n
  const quoteAmount = newVirtQuote - curve.virtualQuoteReserves
  const fee = (quoteAmount * feeBasisPoints) / 10000n
  return {
    tokenAmount: finalTokenAmount,
    quoteAmount,
    fee,
    totalQuote: quoteAmount + fee,
  }
}

/** Replicates apply_sell + fee — quote received from selling `tokenAmount`. */
export function previewSell(
  curve: BondingCurveState,
  tokenAmount: bigint,
  feeBasisPoints: bigint,
  initialVirtualTokenReserves: bigint,
): QuotePreview {
  // get_sell_price math: scale by initialVirtualTokenReserves to preserve
  // precision under integer division (matches the Rust impl exactly).
  const newVirtTok = curve.virtualTokenReserves + tokenAmount
  const scaled = tokenAmount * initialVirtualTokenReserves
  const proportion = scaled / newVirtTok
  let quoteAmount = (curve.virtualQuoteReserves * proportion) / initialVirtualTokenReserves
  if (quoteAmount > curve.realQuoteReserves) quoteAmount = curve.realQuoteReserves
  const fee = (quoteAmount * feeBasisPoints) / 10000n
  return {
    tokenAmount,
    quoteAmount,
    fee,
    totalQuote: quoteAmount - fee,
  }
}
