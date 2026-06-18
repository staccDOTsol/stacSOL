import type { VercelRequest, VercelResponse } from '@vercel/node'

// /api/evm-swap — Paraswap route for native → vault backing asset on Base/BNB.
// ETH mainnet uses Lido+wstETH in the client; Hype uses Kinetiq stake first.

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

const ASSET_BY_CHAIN: Record<string, string> = {
  '8453': '0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', // wstETH on Base
  '56': '0xa2e3356610840701bdf5611a53974510ae27e2e', // weETH on BNB
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const chainId = String(req.query.chainId ?? '')
    const amount = String(req.query.amount ?? '')
    const user = String(req.query.user ?? '').toLowerCase()

    if (!chainId || !amount || !user || !/^0x[a-f0-9]{40}$/.test(user)) {
      return res.status(400).json({ error: 'chainId, amount (wei), user required' })
    }

    const destToken = ASSET_BY_CHAIN[chainId]
    if (!destToken) {
      return res.status(400).json({ error: 'swap only supported on base (8453) and bnb (56)' })
    }

    const priceUrl = new URL('https://apiv5.paraswap.io/prices/')
    priceUrl.searchParams.set('srcToken', NATIVE)
    priceUrl.searchParams.set('destToken', destToken)
    priceUrl.searchParams.set('amount', amount)
    priceUrl.searchParams.set('srcDecimals', '18')
    priceUrl.searchParams.set('destDecimals', '18')
    priceUrl.searchParams.set('side', 'SELL')
    priceUrl.searchParams.set('network', chainId)
    priceUrl.searchParams.set('userAddress', user)

    const priceRes = await fetch(priceUrl.toString())
    if (!priceRes.ok) {
      const err = await priceRes.text()
      return res.status(priceRes.status).json({ error: err || 'paraswap price failed' })
    }
    const price = (await priceRes.json()) as {
      priceRoute: { destAmount?: string } & Record<string, unknown>
      destAmount?: string
    }

    const destAmount =
      price.priceRoute?.destAmount ?? price.destAmount ?? ''
    if (!destAmount) {
      return res.status(502).json({ error: 'paraswap returned no destAmount' })
    }

    const txRes = await fetch(
      `https://apiv5.paraswap.io/transactions/${chainId}?ignoreChecks=true`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          srcToken: NATIVE,
          destToken,
          srcAmount: amount,
          destAmount,
          priceRoute: price.priceRoute,
          userAddress: user,
          partner: 'stacsol',
        }),
      },
    )
    if (!txRes.ok) {
      const err = await txRes.text()
      return res.status(txRes.status).json({ error: err || 'paraswap tx failed' })
    }
    const tx = (await txRes.json()) as {
      to: string
      data: string
      value: string
      gas?: string
    }

    res.setHeader('Cache-Control', 'no-store')
    res.status(200).json({
      destAmount,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })
  } catch (e) {
    console.error('evm-swap error:', e)
    res.status(500).json({ error: (e as Error).message })
  }
}