// stacSOL EVM deployments — Hyperliquid, Ethereum, Base, BNB.
// Contract addresses from the June 2026 mainnet deploy thread:
// https://x.com/STACCoverflow/status/2061674220338180464

export type EvmChainId = 'hype' | 'eth' | 'base' | 'bnb'

export interface EvmChainConfig {
  id: EvmChainId
  /** Display name in the card header */
  name: string
  /** Short nav label */
  short: string
  /** Receipt token symbol */
  symbol: string
  tokenName: string
  chainId: number
  contract: `0x${string}`
  /** Underlying yield-bearing asset the vault holds */
  backing: string
  backingLabel: string
  explorer: string
  /** Alchemy network slug — omitted for chains Alchemy doesn't host */
  alchemyNetwork?: string
  /** Public fallback RPC */
  publicRpc: string
  accent: string
  feePct: number
}

const STAC_ETH_MULTI = '0x3992b2Da589a752918510AB94CFFA18b9A283B48' as const

export const EVM_CHAINS: EvmChainConfig[] = [
  {
    id: 'hype',
    name: 'Hyperliquid',
    short: 'Hype',
    symbol: 'stacHYPE',
    tokenName: 'Stacc Staked HYPE',
    chainId: 999,
    contract: '0x9fd839d497f46c27fb9d0e519e02c0c099ea3cb5',
    backing: 'kHYPE',
    backingLabel: 'Kinetiq Staked HYPE',
    explorer: 'https://hyperevmscan.io',
    publicRpc: 'https://rpc.hyperliquid.xyz/evm',
    accent: '#5eead4',
    feePct: 6.9,
  },
  {
    id: 'eth',
    name: 'Ethereum',
    short: 'ETH',
    symbol: 'stacETH',
    tokenName: 'Stacc Staked ETH',
    chainId: 1,
    contract: STAC_ETH_MULTI,
    backing: 'wstETH',
    backingLabel: 'Wrapped staked ETH',
    explorer: 'https://etherscan.io',
    alchemyNetwork: 'eth-mainnet',
    publicRpc: 'https://eth.llamarpc.com',
    accent: '#818cf8',
    feePct: 6.9,
  },
  {
    id: 'base',
    name: 'Base',
    short: 'Base',
    symbol: 'stacETH',
    tokenName: 'Stacc Staked ETH',
    chainId: 8453,
    contract: STAC_ETH_MULTI,
    backing: 'wstETH',
    backingLabel: 'Wrapped staked ETH',
    explorer: 'https://basescan.org',
    alchemyNetwork: 'base-mainnet',
    publicRpc: 'https://mainnet.base.org',
    accent: '#60a5fa',
    feePct: 6.9,
  },
  {
    id: 'bnb',
    name: 'BNB Chain',
    short: 'BNB',
    symbol: 'stacBNB',
    tokenName: 'Stacc Staked BNB',
    chainId: 56,
    contract: STAC_ETH_MULTI,
    backing: 'weETH',
    backingLabel: 'Wrapped eETH',
    explorer: 'https://bscscan.com',
    alchemyNetwork: 'bnb-mainnet',
    publicRpc: 'https://bsc-dataseed.binance.org',
    accent: '#facc15',
    feePct: 6.9,
  },
]

export function explorerAddress(chain: EvmChainConfig): string {
  return `${chain.explorer}/address/${chain.contract}`
}

export function explorerWrite(chain: EvmChainConfig): string {
  return `${chain.explorer}/address/${chain.contract}#writeContract`
}