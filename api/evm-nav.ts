import type { VercelRequest, VercelResponse } from '@vercel/node'

// /api/evm-nav — live ERC-4626 NAV (totalAssets ÷ totalSupply) for each
// stacSOL EVM vault. Uses ALCHEMY_API server-side where available; falls
// back to public RPC for Hyperliquid.

const SELECTORS = {
  totalAssets: '0x01e1d114',
  totalSupply: '0x18160ddd',
} as const

type ChainId = 'hype' | 'eth' | 'base' | 'bnb'

interface ChainSpec {
  id: ChainId
  contract: string
  alchemyNetwork?: string
  publicRpc: string
}

const CHAINS: ChainSpec[] = [
  {
    id: 'hype',
    contract: '0x9fd839d497f46c27fb9d0e519e02c0c099ea3cb5',
    publicRpc: 'https://rpc.hyperliquid.xyz/evm',
  },
  {
    id: 'eth',
    contract: '0x3992b2Da589a752918510AB94CFFA18b9A283B48',
    alchemyNetwork: 'eth-mainnet',
    publicRpc: 'https://eth.llamarpc.com',
  },
  {
    id: 'base',
    contract: '0x3992b2Da589a752918510AB94CFFA18b9A283B48',
    alchemyNetwork: 'base-mainnet',
    publicRpc: 'https://mainnet.base.org',
  },
  {
    id: 'bnb',
    contract: '0x3992b2Da589a752918510AB94CFFA18b9A283B48',
    alchemyNetwork: 'bnb-mainnet',
    publicRpc: 'https://bsc-dataseed.binance.org',
  },
]

function rpcUrl(spec: ChainSpec): string {
  const key = process.env.ALCHEMY_API?.trim()
  if (key && spec.alchemyNetwork) {
    return `https://${spec.alchemyNetwork}.g.alchemy.com/v2/${key}`
  }
  return spec.publicRpc
}

async function ethCall(url: string, to: string, data: string): Promise<bigint> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  })
  if (!res.ok) throw new Error(`rpc ${res.status}`)
  const json = (await res.json()) as { result?: string; error?: { message: string } }
  if (json.error) throw new Error(json.error.message)
  if (!json.result || json.result === '0x') return 0n
  return BigInt(json.result)
}

async function fetchChainNav(spec: ChainSpec) {
  const url = rpcUrl(spec)
  const [assets, supply] = await Promise.all([
    ethCall(url, spec.contract, SELECTORS.totalAssets),
    ethCall(url, spec.contract, SELECTORS.totalSupply),
  ])
  const nav =
    supply > 0n ? Number(assets) / Number(supply) : null
  return {
    id: spec.id,
    totalAssets: assets.toString(),
    totalSupply: supply.toString(),
    nav,
    live: supply > 0n,
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const results = await Promise.all(
      CHAINS.map(async (c) => {
        try {
          return await fetchChainNav(c)
        } catch (e) {
          return {
            id: c.id,
            totalAssets: null,
            totalSupply: null,
            nav: null,
            live: false,
            error: (e as Error).message,
          }
        }
      }),
    )

    res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=15, stale-while-revalidate=60')
    res.status(200).json({ chains: results, fetchedAt: Date.now() })
  } catch (e) {
    console.error('evm-nav error:', e)
    res.status(500).json({ error: (e as Error).message })
  }
}