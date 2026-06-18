import { createConfig, http, injected } from 'wagmi'
import { base, bsc, mainnet } from 'wagmi/chains'
import { defineChain } from 'viem'
import type { Connector } from 'wagmi'

export const hyperEvm = defineChain({
  id: 999,
  name: 'HyperEVM',
  nativeCurrency: { decimals: 18, name: 'HYPE', symbol: 'HYPE' },
  rpcUrls: {
    default: { http: ['https://rpc.hyperliquid.xyz/evm'] },
  },
  blockExplorers: {
    default: { name: 'HyperEVMScan', url: 'https://hyperevmscan.io' },
  },
})

export const evmWagmiChains = [hyperEvm, mainnet, base, bsc] as const

/** Phantom EVM — uses window.phantom.ethereum, not window.ethereum. */
export const phantomConnector = injected({ target: 'phantom' })

export function preferredEvmConnector(
  connectors: readonly Connector[],
): Connector | undefined {
  return connectors.find((c) => c.id === 'phantom') ?? connectors[0]
}

function alchemyProxy(chainId: number) {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://stacsol.app'
  return http(`${origin}/api/evm-rpc?chainId=${chainId}`)
}

export const wagmiConfig = createConfig({
  chains: evmWagmiChains,
  connectors: [phantomConnector],
  transports: {
    [hyperEvm.id]: http(hyperEvm.rpcUrls.default.http[0]),
    [mainnet.id]: alchemyProxy(1),
    [base.id]: alchemyProxy(8453),
    [bsc.id]: alchemyProxy(56),
  },
})