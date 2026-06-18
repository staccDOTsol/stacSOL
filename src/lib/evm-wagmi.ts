import { createConfig, http, injected } from 'wagmi'
import { base, bsc, mainnet } from 'wagmi/chains'
import { defineChain } from 'viem'

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

export const wagmiConfig = createConfig({
  chains: evmWagmiChains,
  connectors: [injected()],
  transports: {
    [hyperEvm.id]: http(hyperEvm.rpcUrls.default.http[0]),
    [mainnet.id]: http('https://eth.llamarpc.com'),
    [base.id]: http('https://mainnet.base.org'),
    [bsc.id]: http('https://bsc-dataseed.binance.org'),
  },
})