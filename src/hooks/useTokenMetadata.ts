// On-chain Metaplex metadata fetcher.
//
// Resolves the Metaplex Token Metadata PDA for a given SPL mint, parses
// the `Data { name, symbol, uri, ... }` block out of the account, then
// (best-effort) GETs the off-chain JSON pointed to by `uri` so the UI
// can render the token's image + description.
//
// Used by /trade so the header shows the launched token's name/symbol/
// image instead of a raw pubkey. The launchpad's create.rs writes a
// standard mpl-token-metadata account via `create_metadata_accounts_v3`,
// so this works for every curve.
//
// Parsing notes: the on-chain `Data` is borsh-encoded (u32 LE length +
// UTF-8 bytes per string). Some Metaplex accounts are later "puffed"
// to MAX_METADATA_LEN by zero-padding after the borsh strings — our
// parser ignores trailing nulls in each string just in case.

import { useEffect, useState } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'

export const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
)

export interface OnChainMetadata {
  name: string
  symbol: string
  uri: string
}

export interface OffChainJson {
  name?: string
  symbol?: string
  description?: string
  image?: string
  showName?: boolean
  twitter?: string
  website?: string
  telegram?: string
  createdAt?: string
  [key: string]: unknown
}

export interface TokenMetadata {
  pda: PublicKey
  on: OnChainMetadata
  off: OffChainJson | null
  /** True if the off-chain JSON fetch succeeded. */
  hasOffChain: boolean
}

export function deriveMetadataPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata'),
      METAPLEX_TOKEN_METADATA_PROGRAM_ID.toBytes(),
      mint.toBytes(),
    ],
    METAPLEX_TOKEN_METADATA_PROGRAM_ID,
  )[0]
}

function parseMetadataAccount(data: Uint8Array): OnChainMetadata {
  // Header: 1 byte key + 32 bytes update_authority + 32 bytes mint.
  let o = 1 + 32 + 32
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const readString = () => {
    const len = view.getUint32(o, true)
    o += 4
    const bytes = data.subarray(o, o + len)
    o += len
    return new TextDecoder().decode(bytes).replace(/\0+$/, '')
  }
  const name = readString()
  const symbol = readString()
  const uri = readString()
  return { name, symbol, uri }
}

export function useTokenMetadata(
  connection: Connection,
  mint: PublicKey | null,
): { data: TokenMetadata | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<TokenMetadata | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const key = mint?.toBase58() ?? null

  useEffect(() => {
    if (!mint) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const pda = deriveMetadataPda(mint)
        const acc = await connection.getAccountInfo(pda, 'confirmed')
        if (cancelled) return
        if (!acc) {
          setError('metadata account not found')
          setData(null)
          return
        }
        const on = parseMetadataAccount(new Uint8Array(acc.data))
        let off: OffChainJson | null = null
        if (on.uri) {
          try {
            const res = await fetch(on.uri, { redirect: 'follow' })
            if (res.ok) off = await res.json()
          } catch {
            // off-chain unreachable — keep on-chain values for the UI
          }
        }
        if (!cancelled) {
          setData({ pda, on, off, hasOffChain: !!off })
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message)
          setData(null)
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, key])

  return { data, loading, error }
}
