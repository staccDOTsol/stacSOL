import type { VercelRequest, VercelResponse } from '@vercel/node'

// /api/evm-rpc — browser-safe JSON-RPC proxy to Alchemy (avoids CORS on public RPCs).

const NETWORK_BY_CHAIN: Record<string, string> = {
  '1': 'eth-mainnet',
  '8453': 'base-mainnet',
  '56': 'bnb-mainnet',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' })
  }

  const chainId = String(req.query.chainId ?? '')
  const network = NETWORK_BY_CHAIN[chainId]
  if (!network) {
    return res.status(400).json({ error: 'chainId must be 1, 8453, or 56' })
  }

  const key = process.env.ALCHEMY_API?.trim()
  if (!key) {
    return res.status(500).json({ error: 'ALCHEMY_API not configured' })
  }

  const body =
    typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? {})

  const upstream = await fetch(`https://${network}.g.alchemy.com/v2/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })

  const json = await upstream.json()
  res.setHeader('Cache-Control', 'no-store')
  res.status(upstream.status).json(json)
}