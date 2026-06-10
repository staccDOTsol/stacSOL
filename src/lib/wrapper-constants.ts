import { PublicKey } from '@solana/web3.js'

// Wrapper v3 program — fresh deploy with Metaplex-metadata ix support.
// (The old `H7nzSS…` program was closed; PDAs from that deployment are
// orphaned and the old wstacSOL `EimRmt…` is dead.)
export const WRAPPER_PROGRAM = new PublicKey(
  'Afvo8cB9xMMKfXvPAgS2sXJRHbqtos1jsEcQ5xskQAKs',
)

// `original_authority` captured at wrapper initialize. Used as the state PDA
// seed component — does NOT change even if `transfer_authority` is ever
// called. We pin it as a constant rather than reading from state so this
// module has no I/O dependency.
export const WRAPPER_ORIGINAL_AUTHORITY = new PublicKey(
  'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb',
)

// Pre-derived PDAs (constant — cheaper than findProgramAddress on every render).
//   state = [state, original_authority, MINT]
//   vault = [vault, state, MINT]
//   v1    = [wrapped_mint, state, [1]] (plain SPL)
export const WRAPPER_STATE = new PublicKey(
  '5ebmVgguaeBMZKQU3m2ytnkw6FAnvFo89DVvfGiND9HL',
)
export const WRAPPER_VAULT = new PublicKey(
  '5ZGUwvYCmTwFQDNqFRKqzXKF8jtkUeQUxYPPYEY8MNJ3',
)

/**
 * Plain SPL wrapped mint (v1). Token program = TOKEN_PROGRAM (not Token-2022).
 * No transfer fee. Backed 1:1 by stacSOL in the vault. Has Metaplex
 * metadata attached for wallet / explorer display.
 *
 * Decimals match the underlying (9). 1 wstacSOL ≡ 1 stacSOL at unwrap time
 * (modulo the underlying's 690-bps transfer fee on the vault → user leg).
 */
export const WSTACSOL_MINT = new PublicKey(
  'GB2Y9s7N9HcpCmrqyByygMfRsJDLH1Gt7wasTtczohYL',
)
export const WSTACSOL_VERSION = 1

// Underlying-mint transfer fee on stacSOL (T22 TransferFeeConfig).
// 690 bps = 6.9 %. Applies on every underlying transfer, including:
//   - wrap (user → vault)        → user gets net stacSOL × (1 − fee) as wstacSOL
//   - unwrap (vault → user)      → user gets unwrap amount × (1 − fee) as stacSOL
// Surfacing it in the UI so users see the actual payout, not the gross.
export const STACSOL_FEE_BPS = 690
