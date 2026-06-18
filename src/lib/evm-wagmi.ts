import { createConfig, http, injected } from 'wagmi'
import { base, bsc, mainnet } from 'wagmi/chains'
import { coinbaseWallet, walletConnect } from 'wagmi/connectors'
import { defineChain, type EIP1193Provider } from 'viem'
import { phantomProvider } from './evm-connect'

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

type InjectedEth = EIP1193Provider & {
  isRabby?: boolean
  isTrust?: boolean
  isTrustWallet?: boolean
  providers?: InjectedEth[]
}

type EthWindow = {
  ethereum?: InjectedEth
  trustwallet?: { ethereum?: InjectedEth }
}

function rabbyProvider(window?: EthWindow): EIP1193Provider | undefined {
  const eth = window?.ethereum
  if (!eth) return undefined
  if (eth.isRabby) return eth
  return eth.providers?.find((p: InjectedEth) => p.isRabby)
}

function trustProvider(window?: EthWindow): EIP1193Provider | undefined {
  const tw = window?.trustwallet?.ethereum
  if (tw) return tw
  const eth = window?.ethereum
  if (!eth) return undefined
  if (eth.isTrust || eth.isTrustWallet) return eth
  return eth.providers?.find(
    (p: InjectedEth) => p.isTrust || p.isTrustWallet,
  )
}

const wcId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string | undefined

const evmConnectors = [
  injected({
    target: {
      id: 'phantom',
      name: 'Phantom',
      provider: () => phantomProvider(),
    },
  }),
  injected({ target: 'metaMask' }),
  injected({
    target: {
      id: 'rabby',
      name: 'Rabby',
      provider: rabbyProvider,
    },
  }),
  coinbaseWallet({ appName: 'stacSOL' }),
  injected({
    target: {
      id: 'trust',
      name: 'Trust Wallet',
      provider: trustProvider,
    },
  }),
  ...(wcId
    ? [
        walletConnect({
          projectId: wcId,
          showQrModal: true,
        }),
      ]
    : []),
]

function alchemyProxy(chainId: number) {
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://stacsol.app'
  return http(`${origin}/api/evm-rpc?chainId=${chainId}`)
}

export const wagmiConfig = createConfig({
  chains: evmWagmiChains,
  connectors: evmConnectors,
  // Phantom EVM breaks on eth_chainId — phantom-provider.ts caches chainChanged.
  multiInjectedProviderDiscovery: false,
  syncConnectedChain: true,
  transports: {
    [hyperEvm.id]: http(hyperEvm.rpcUrls.default.http[0]),
    [mainnet.id]: alchemyProxy(1),
    [base.id]: alchemyProxy(8453),
    [bsc.id]: alchemyProxy(56),
  },
})