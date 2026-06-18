import type { EIP1193Provider } from 'viem'

/** Last resort when Phantom throws on eth_chainId before any chainChanged event. */
const CHAIN_FALLBACK = '0x1' as const

const SAFE_METHODS = new Set(['eth_chainId', 'net_version'])

function normalizeChainHex(chainId: unknown): `0x${string}` | null {
  if (typeof chainId === 'string' && chainId.startsWith('0x')) {
    return chainId as `0x${string}`
  }
  if (typeof chainId === 'number' && Number.isFinite(chainId)) {
    return `0x${chainId.toString(16)}` as `0x${string}`
  }
  return null
}

export function wrapResilientProvider(
  raw: EIP1193Provider,
  fallbackChainHex: `0x${string}` = CHAIN_FALLBACK,
): EIP1193Provider {
  let cachedChainHex: `0x${string}` | null = null

  const rawRequest = raw.request.bind(raw) as (args: {
    method: string
    params?: unknown
  }) => Promise<unknown>

  const onChainChanged = (chainId: unknown) => {
    const hex = normalizeChainHex(chainId)
    if (hex) cachedChainHex = hex
  }

  raw.on?.('chainChanged', onChainChanged)

  const request = (async (args: { method: string; params?: unknown }) => {
    if (SAFE_METHODS.has(args.method)) {
      try {
        const result = await rawRequest(args)
        const hex = normalizeChainHex(result)
        if (hex) {
          cachedChainHex = hex
          return hex
        }
      } catch {
        /* Phantom evmAsk.js throws He: Unexpected error here */
      }
      return cachedChainHex ?? fallbackChainHex
    }
    return rawRequest(args)
  }) as EIP1193Provider['request']

  return {
    ...raw,
    request,
    on: raw.on?.bind(raw),
    removeListener: raw.removeListener?.bind(raw),
  }
}

export function getPhantomEvmProvider(): EIP1193Provider | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as Window & {
    phantom?: { ethereum?: EIP1193Provider & { isPhantom?: boolean } }
  }
  const raw = w.phantom?.ethereum
  if (!raw) return undefined
  return wrapResilientProvider(raw)
}