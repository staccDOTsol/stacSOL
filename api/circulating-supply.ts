import type { VercelRequest, VercelResponse } from '@vercel/node'

// stacSOL circulating-supply endpoint for CoinGecko / CMC / GeckoTerminal
// listing forms. They poll a URL, expect a plain numeric body (or simple
// JSON), and surface that on the asset page.
//
// IMPORTANT: we deliberately avoid `@solana/web3.js` here. Its `Connection`
// transitively imports `rpc-websockets`, which has an ESM/CJS conflict
// against the newer `uuid@14` it pulls in — this breaks every Vercel
// serverless function that touches it (see the same crash on /api/snapshot).
// Raw JSON-RPC over fetch is one HTTP call, zero deps, identical correctness.
//
// Formats:
//   - default → text/plain, single decimal in UI units (e.g. "411.738818846")
//   - ?format=json → application/json with extra context for dashboards
//
// stacSOL specifics: every minted token is in circulation. There is no
// team allocation, no vesting schedule, no treasury lockup. Circulating
// supply == total supply == mint.supply == pool.pool_token_supply (modulo
// a sub-epoch drift between UpdateStakePoolBalance crank calls).

const MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const POOL = 'E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb'
const DECIMALS = 9

function rpcUrl(): string {
  return (
    process.env.RPC_URL ||
    process.env.VITE_RPC_URL ||
    'https://api.mainnet-beta.solana.com'
  )
}

interface RpcAccountInfoResult {
  value: { data: [string, string]; lamports: number; owner: string } | null
}

async function getAccountB64(address: string): Promise<Buffer> {
  const r = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [address, { encoding: 'base64', commitment: 'confirmed' }],
    }),
  })
  if (!r.ok) throw new Error(`rpc http ${r.status}`)
  const j = (await r.json()) as { result?: RpcAccountInfoResult; error?: unknown }
  if (j.error) throw new Error(`rpc error: ${JSON.stringify(j.error)}`)
  if (!j.result?.value) throw new Error(`account ${address} not found`)
  const [b64, encoding] = j.result.value.data
  if (encoding !== 'base64') throw new Error(`unexpected encoding: ${encoding}`)
  return Buffer.from(b64, 'base64')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    // Live mint.supply from Token-2022. Mint base layout (same for SPL Token
    // and Token-2022): mint_authority opt @0..36, supply (u64 LE) @36..44,
    // decimals @44, is_initialized @45, ...
    const mintData = await getAccountB64(MINT)
    const mintSupply = mintData.readBigUInt64LE(36)

    // Pool accounting supply for diagnostics (drifts < 1 epoch behind mint
    // supply between UpdateStakePoolBalance cranks; safe to surface).
    const poolData = await getAccountB64(POOL)
    const poolTokenSupply = poolData.readBigUInt64LE(266)

    // UI-units string with full precision (no toLocaleString — aggregators
    // reject "1,234.56", they want "1234.56").
    const supplyUi = formatAtomic(mintSupply, DECIMALS)
    const poolSupplyUi = formatAtomic(poolTokenSupply, DECIMALS)

    res.setHeader(
      'Cache-Control',
      'public, max-age=60, s-maxage=60, stale-while-revalidate=300',
    )
    res.setHeader('Access-Control-Allow-Origin', '*')

    if ((req.query.format ?? 'text') === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      // Dual key shapes intentional — different aggregators look for
      // different conventions:
      //   • Colosseum scraper (and most modern dashboards): camelCase
      //     `circulatingSupply` — strictly required, returns "No
      //     circulating supply found" otherwise.
      //   • CoinGecko / CMC standard tooling: snake_case
      //     `circulating_supply`.
      // Serving both means one URL works in every place we need to paste
      // it — and the response is still valid JSON either way.
      const supply = Number(supplyUi)
      res.status(200).send(
        JSON.stringify({
          circulatingSupply: supply,
          totalSupply: supply,
          maxSupply: null,
          circulating_supply: supply,
          total_supply: supply,
          max_supply: null,
          mint: MINT,
          decimals: DECIMALS,
          source: 'token-2022 mint.supply (live, unmodified)',
          pool_token_supply_accounting: Number(poolSupplyUi),
          poolTokenSupplyAccounting: Number(poolSupplyUi),
          notes:
            'No team allocation, vesting, or treasury lockup — every minted stacSOL is in circulation.',
        }),
      )
      return
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.status(200).send(supplyUi)
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store')
    res.status(500).json({ ok: false, error: (e as Error).message })
  }
}

/** Atomic u64 → UI-decimal string. (411382136046n, 9) → "411.382136046". */
function formatAtomic(atom: bigint, decimals: number): string {
  if (decimals <= 0) return atom.toString()
  const s = atom.toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, -decimals)
  const fracPart = s.slice(-decimals).replace(/0+$/, '')
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
}
