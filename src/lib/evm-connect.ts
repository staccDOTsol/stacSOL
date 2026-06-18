import type { Connector } from 'wagmi'
import type { EIP1193Provider } from 'viem'

type EthWindow = Window & {
  phantom?: { ethereum?: EIP1193Provider & { isPhantom?: boolean } }
  ethereum?: EIP1193Provider & {
    isMetaMask?: boolean
    isRabby?: boolean
    isCoinbaseWallet?: boolean
    isTrust?: boolean
    isTrustWallet?: boolean
    isPhantom?: boolean
    providers?: EIP1193Provider[]
  }
  coinbaseWalletExtension?: EIP1193Provider
  trustwallet?: { ethereum?: EIP1193Provider }
}

export function phantomProvider(): EIP1193Provider | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as EthWindow
  const p = w.phantom?.ethereum
  if (p?.isPhantom !== false) return p
  return undefined
}

export function connectorAvailable(id: string): boolean {
  if (typeof window === 'undefined') return true
  const w = window as EthWindow
  switch (id) {
    case 'phantom':
      return !!phantomProvider()
    case 'metaMask':
    case 'metaMaskSDK':
      return !!w.ethereum?.isMetaMask && !w.ethereum?.isPhantom
    case 'rabby':
      return !!w.ethereum?.isRabby
    case 'coinbaseWallet':
    case 'coinbaseWalletSDK':
      return !!(w.coinbaseWalletExtension || w.ethereum?.isCoinbaseWallet)
    case 'trust':
      return !!(
        w.trustwallet?.ethereum ||
        w.ethereum?.isTrust ||
        w.ethereum?.isTrustWallet
      )
    case 'walletConnect':
      return true
    case 'injected':
      return !!w.ethereum
    default:
      return true
  }
}

export function formatConnectError(e: unknown, connector?: Connector): string {
  const err = e as {
    name?: string
    code?: number
    message?: string
    shortMessage?: string
    details?: string
  }
  const raw = err?.shortMessage || err?.message || err?.details || ''
  const name = connector?.name ?? 'Wallet'

  if (err?.code === 4001 || /user rejected|rejected/i.test(raw)) {
    return `${name} connection cancelled.`
  }
  if (/provider not found|connector not found/i.test(raw)) {
    return `${name} not detected — open the extension and enable EVM, then retry.`
  }
  if (/unexpected error/i.test(raw)) {
    return `${name}: enable Ethereum/EVM in the wallet settings, then retry. If it persists, try MetaMask or Rabby.`
  }
  if (raw) return raw.replace(/Version: viem@[\d.]+/gi, '').trim()
  return `${name} connection failed.`
}