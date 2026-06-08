import { PublicKey } from '@solana/web3.js'

const env = (k: string): string | undefined =>
  (import.meta.env?.[k] as string | undefined) || undefined

export const POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')

// Fork addresses. After running `scripts/fork-launch.ts`, set VITE_POOL and
// VITE_MINT to the freshly-created pool + Token-2022 mint. The defaults below
// are the original stacSOL deployment and are only placeholders for the fork.
export const POOL = new PublicKey(
  env('VITE_POOL') ?? 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb',
)
export const MINT = new PublicKey(
  env('VITE_MINT') ?? '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f',
)
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export const DECIMALS = 9

// Token-2022 transfer fee on the fork mint. 1380 bps = 13.8%. Set at mint
// creation in scripts/fork-launch.ts; surfaced here for UI math.
export const FEE_BPS = 1380
export const FEE_PAYOUT_FRACTION = (10_000 - FEE_BPS) / 10_000 // 0.862

// Of the harvested 13.8%, this fraction is redeemed to SOL and routed to the
// liqd destination PDA; the remainder is burned for NAV. 5000 bps = a 50/50
// split (6.9% burn + 6.9% liqd-to-SOL → PDA).
export const FEE_SPLIT_LIQD_BPS = 5000

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
export const RPC_URL =
  params.get('rpc') ||
  (import.meta.env.VITE_RPC_URL as string | undefined) ||
  'https://api.mainnet-beta.solana.com'

// Solana mainnet nominal staking yield used as the gross-APR base for the
// guesstimate. Real yield drifts with inflation schedule + validator perf.
export const GROSS_APR = 0.07
