// Minimal curve-launchpad client.
//
// The on-chain program lives at `GLstzf6zSDdU44K1GUCPKy9NyZx7qyUpb9L8qrXCrADo`
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
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { MINT as QUOTE_MINT } from './constants'

// Curve-launchpad program ID (declared in curve-launchpad/src/lib.rs).
export const CURVE_LAUNCHPAD_PROGRAM_ID = new PublicKey(
  'GLstzf6zSDdU44K1GUCPKy9NyZx7qyUpb9L8qrXCrADo',
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
const LAST_WITHDRAW_SEED = Buffer.from('last-withdraw')

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

export function deriveLastWithdraw(
  programId = CURVE_LAUNCHPAD_PROGRAM_ID,
): PublicKey {
  return PublicKey.findProgramAddressSync([LAST_WITHDRAW_SEED], programId)[0]
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
/** sha256("global:withdraw")[..8] */
const WITHDRAW_DISCRIMINATOR = new Uint8Array([
  183, 18, 70, 156, 148, 109, 161, 34,
])
/** sha256("global:create")[..8] */
const CREATE_DISCRIMINATOR = new Uint8Array([
  24, 30, 200, 40, 5, 28, 7, 119,
])

// Metaplex Token Metadata program — used to derive the `metadata` PDA on
// create. Fixed mainnet address (also valid on devnet).
const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
)

// PDA for the create ix's mint authority. Seeds: [b"mint-authority"].
const MINT_AUTHORITY_SEED = Buffer.from('mint-authority')
function deriveMintAuthority(programId = CURVE_LAUNCHPAD_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED], programId)[0]
}

function deriveMetadata(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBytes(),
      mint.toBytes(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  )[0]
}

// Borsh-encodes a String: 4-byte LE length + UTF-8 bytes.
const borshString = (s: string): Uint8Array => {
  const bytes = new TextEncoder().encode(s)
  const out = new Uint8Array(4 + bytes.length)
  new DataView(out.buffer).setUint32(0, bytes.length, true)
  out.set(bytes, 4)
  return out
}

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
  // Quote (stacSOL) is Token-2022 — derive its ATAs with the Token-2022 program id.
  const bondingCurveQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const userQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  )
  const feeRecipientQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    feeRecipient,
    true,
    TOKEN_2022_PROGRAM_ID,
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

// ---------------------------------------------------------------------------
// create ix — launches a new bonding curve. The MEME mint must be a fresh
// keypair (signer); the program init's its supply, transfers it into the
// curve's MEME ATA, and revokes both freeze + mint authority on the spot.
//
// Account ordering matches `instructions/create.rs`'s `#[derive(Accounts)]`:
//   mint (signer), creator (signer), mint_authority, bonding_curve,
//   bonding_curve_token_account, global, metadata, system_program,
//   token_program, associated_token_program, token_metadata_program, rent,
//   then the #[event_cpi] trailing pair (event_authority + program self).
// ---------------------------------------------------------------------------

export interface CreateParams {
  /** Fresh keypair pubkey for the new MEME mint. Caller signs the tx with it. */
  mint: PublicKey
  /** The wallet launching the curve (pays rent + becomes the metadata payer). */
  creator: PublicKey
  /** Token name (Metaplex metadata). */
  name: string
  /** Token symbol (Metaplex metadata). */
  symbol: string
  /** Off-chain JSON metadata URI (Vercel Blob URL pointing to the metadata.json). */
  uri: string
}

export function ixCurveCreate(params: CreateParams): TransactionInstruction {
  const { mint, creator, name, symbol, uri } = params
  const bondingCurve = deriveBondingCurve(mint)
  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID,
  )
  const mintAuthority = deriveMintAuthority()
  const metadata = deriveMetadata(mint)

  const data = concat(
    CREATE_DISCRIMINATOR,
    borshString(name),
    borshString(symbol),
    borshString(uri),
  )

  return new TransactionInstruction({
    programId: CURVE_LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: creator, isSigner: true, isWritable: true },
      { pubkey: mintAuthority, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
      { pubkey: deriveGlobal(), isSigner: false, isWritable: false },
      { pubkey: metadata, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: METAPLEX_TOKEN_METADATA_PROGRAM_ID, isSigner: false, isWritable: false },
      // Rent sysvar — Anchor expects this account at this slot for the create ix.
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      // #[event_cpi] trailing pair.
      { pubkey: deriveEventAuthority(CURVE_LAUNCHPAD_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: CURVE_LAUNCHPAD_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

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
      // Two distinct token-program slots:
      // - `token_program` (legacy SPL Token) — moves MEME between curve ↔ user.
      // - `quote_token_program` (Token-2022) — moves stacSOL between
      //   user/curve/fee-recipient with TransferChecked + TransferFee.
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
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
      // Legacy SPL Token for the MEME side, Token-2022 for the LST quote side.
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: a.eventAuthority, isSigner: false, isWritable: false },
      { pubkey: a.program, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  })
}

// ---------------------------------------------------------------------------
// withdraw ix
//
// Drains the bonding curve's MEME + LST reserves to the withdraw authority
// after the curve completes. Account ordering matches
// `programs/curve-launchpad/src/instructions/withdraw.rs` — note that the
// Withdraw struct is NOT `#[event_cpi]` (no trailing event_authority/program),
// has no fee_recipient, and orders the programs as `associated_token_program,
// system_program, token_program, quote_token_program`.
// ---------------------------------------------------------------------------

export interface WithdrawParams {
  /** The withdraw authority — must match `Global.withdraw_authority`. */
  user: PublicKey
  /** MEME mint of the curve being drained. */
  mint: PublicKey
  /** Defaults to the stacSOL mint. Must match `Global.quote_mint`. */
  quoteMint?: PublicKey
}

export function ixCurveWithdraw(params: WithdrawParams): TransactionInstruction {
  const { user, mint } = params
  const quoteMint = params.quoteMint ?? QUOTE_MINT

  const global = deriveGlobal()
  const lastWithdraw = deriveLastWithdraw()
  const bondingCurve = deriveBondingCurve(mint)
  // MEME side: legacy SPL Token program.
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
  // Quote (stacSOL) side: Token-2022.
  const bondingCurveQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const userQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  return new TransactionInstruction({
    programId: CURVE_LAUNCHPAD_PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: global, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: quoteMint, isSigner: false, isWritable: false },
      { pubkey: lastWithdraw, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: bondingCurveTokenAccount, isSigner: false, isWritable: true },
      { pubkey: bondingCurveQuoteAccount, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteAccount, isSigner: false, isWritable: true },
      // Withdraw orders the program slots as ATA, system, token, quote_token.
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(WITHDRAW_DISCRIMINATOR),
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
