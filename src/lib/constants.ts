import { PublicKey } from '@solana/web3.js'

export const POOL_PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
export const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
export const MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')
export const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
export const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

export const DECIMALS = 9

const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
export const RPC_URL =
  params.get('rpc') ||
  (import.meta.env.VITE_RPC_URL as string | undefined) ||
  'https://api.mainnet-beta.solana.com'

// Solana mainnet nominal staking yield used as the gross-APR base for the
// guesstimate. Real yield drifts with inflation schedule + validator perf.
export const GROSS_APR = 0.07
