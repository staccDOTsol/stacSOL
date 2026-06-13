// Shared Birdeye markets fetcher.
//
// stacSOL has multiple LPs across venues — Sanctum (the protocol pool itself,
// which equals NAV), several Raydium CP pools paired with thystaccfloweth-family
// memecoins (FOMOX402, Staccana, PROOFV3, etc.), and a real SOL/stacSOL pool.
//
// For "LP price in SOL" we want the deepest SOL-paired market that isn't the
// Sanctum protocol pool. That's the honest "secondary market is saying X" number.

const STACSOL = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL = 'So11111111111111111111111111111111111111112'
const SANCTUM_POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'

export interface BirdeyeMarket {
  address: string
  source: string
  liquidity: number
  volume24h: number
  price: number
  base: { address: string; symbol: string; decimals: number }
  quote: { address: string; symbol: string; decimals: number }
  name: string
}

interface BirdeyeMarketsResponse {
  success: boolean
  data?: { items: BirdeyeMarket[]; hasNext?: boolean }
  message?: string
}

// Page through all markets for stacSOL. Birdeye caps limit at 20 per page.
export async function fetchAllStacsolMarkets(apiKey: string): Promise<BirdeyeMarket[]> {
  const all: BirdeyeMarket[] = []
  let offset = 0
  const limit = 20
  for (let page = 0; page < 10; page++) {
    const url = `https://public-api.birdeye.so/defi/v2/markets?address=${STACSOL}&limit=${limit}&offset=${offset}&sort_by=liquidity&sort_type=desc`
    const r = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) break
    const j = (await r.json()) as BirdeyeMarketsResponse
    if (!j.success || !j.data) break
    all.push(...j.data.items)
    if (!j.data.hasNext || j.data.items.length < limit) break
    offset += limit
  }
  return all
}

/**
 * Pick the deepest SOL-paired LP, excluding the Sanctum protocol pool itself.
 * Returns SOL price per stacSOL (i.e. how many SOL you'd get for 1 stacSOL on
 * that LP at current spot), or null if no such market exists.
 */
export function pickLpPriceSol(markets: BirdeyeMarket[]): number | null {
  const candidates = markets
    .filter((m) => m.address !== SANCTUM_POOL)
    .filter((m) => m.base.address === WSOL || m.quote.address === WSOL)
    .filter((m) => m.liquidity > 0)
    .sort((a, b) => b.liquidity - a.liquidity)

  if (candidates.length === 0) return null
  const top = candidates[0]
  // Birdeye `price` semantics: price of base in terms of quote.
  // We want SOL per stacSOL. If base is stacSOL and quote is SOL, price IS what
  // we want. If base is SOL and quote is stacSOL, invert.
  if (top.base.address === STACSOL) return top.price
  if (top.quote.address === STACSOL) return 1 / top.price
  return null
}

// --- Tokenlist (universe ranking) -------------------------------------------
// Distinct from the markets fetcher above: this ranks the whole chain's tokens
// by market cap (the trifecta flywheel's target set), not the LPs of one mint.

export interface BirdeyeToken {
  address: string
  symbol?: string
  name?: string
  decimals?: number
  mc?: number
  liquidity?: number
  v24hUSD?: number
  price?: number
  logoURI?: string
}

interface BirdeyeTokenlistResponse {
  success: boolean
  // The v1 tokenlist nests the array under `tokens`; older/other shapes have
  // used `items` (as the v2 markets endpoint does). Accept either.
  data?: { tokens?: BirdeyeToken[]; items?: BirdeyeToken[]; total?: number }
  message?: string
}

/**
 * Top Solana tokens by market cap, descending, above a liquidity floor.
 * Pages `/defi/tokenlist` (Birdeye caps limit at 50/page). `count` is the
 * total wanted across pages; we stop early on a short page. One sweep is a
 * handful of calls — cron this, don't hot-path it.
 */
export async function fetchTopTokensByMcap(
  apiKey: string,
  opts: { count: number; minLiquidity: number },
): Promise<BirdeyeToken[]> {
  const out: BirdeyeToken[] = []
  const pageSize = 50
  for (let offset = 0; offset < opts.count && offset < 1000; offset += pageSize) {
    const limit = Math.min(pageSize, opts.count - offset)
    const url =
      `https://public-api.birdeye.so/defi/tokenlist?sort_by=mc&sort_type=desc` +
      `&offset=${offset}&limit=${limit}&min_liquidity=${opts.minLiquidity}`
    const r = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': 'solana' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) break
    const j = (await r.json()) as BirdeyeTokenlistResponse
    if (!j.success || !j.data) break
    const page = j.data.tokens ?? j.data.items ?? []
    out.push(...page)
    if (page.length < limit) break
  }
  return out
}

export { STACSOL, WSOL, SANCTUM_POOL }
