// Wrapped-stacSOL ATA balance polling hook. Sibling of useStacBalance but
// targets the SPL Token (not Token-2022) wstacSOL mint. Same fast-path
// pattern: one `getAccountInfo` per tick, no tx-history walk.

import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import {
  Connection,
  PublicKey,
} from '@solana/web3.js'
import { WSTACSOL_TOKEN_PROGRAM } from '../lib/wrapper-ix'
import { WSTACSOL_MINT } from '../lib/wrapper-constants'
import { ATA_PROGRAM } from '../lib/constants'

interface CacheEntry {
  balance: bigint | null
  ts: number
  inflight: Promise<bigint> | null
  subscribers: Set<(b: bigint) => void>
  intervalId: ReturnType<typeof setInterval> | null
}

const cache = new Map<string, CacheEntry>()

const KEY_FN = (conn: Connection, owner: PublicKey): string =>
  `${conn.rpcEndpoint}:${owner.toBase58()}:wstac`

function deriveWstacAta(owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), WSTACSOL_TOKEN_PROGRAM.toBytes(), WSTACSOL_MINT.toBytes()],
    ATA_PROGRAM,
  )
  return ata
}

export function useWstacBalance(
  publicKey: PublicKey | null,
  pollMs = 12_000,
): bigint | null {
  const [balance, setBalance] = useState<bigint | null>(null)
  const { connection } = useConnection()

  useEffect(() => {
    if (!publicKey) {
      setBalance(null)
      return
    }
    const ata = deriveWstacAta(publicKey)
    const key = KEY_FN(connection, publicKey)
    let entry = cache.get(key)
    if (!entry) {
      entry = {
        balance: null,
        ts: 0,
        inflight: null,
        subscribers: new Set(),
        intervalId: null,
      }
      cache.set(key, entry)
    }

    const tick = async () => {
      if (!entry || entry.inflight) return
      entry.inflight = (async () => {
        const acc = await connection.getAccountInfo(ata, 'processed')
        if (!acc) return 0n
        // SPL Token v1 account layout — amount (u64) @ byte 64, same as
        // Token-2022's base struct.
        return acc.data.readBigUInt64LE(64)
      })()
      try {
        const v = await entry.inflight
        entry.balance = v
        entry.ts = Date.now()
        entry.subscribers.forEach(s => s(v))
      } catch {
        /* retry on next interval */
      } finally {
        if (entry) entry.inflight = null
      }
    }

    const onUpdate = (v: bigint) => setBalance(v)
    entry.subscribers.add(onUpdate)

    if (entry.balance != null && Date.now() - entry.ts < pollMs) {
      setBalance(entry.balance)
    } else {
      void tick()
      if (!entry.intervalId) entry.intervalId = setInterval(tick, pollMs)
    }

    return () => {
      if (!entry) return
      entry.subscribers.delete(onUpdate)
      if (entry.subscribers.size === 0 && entry.intervalId) {
        clearInterval(entry.intervalId)
        entry.intervalId = null
      }
    }
  }, [connection, publicKey, pollMs])

  return balance
}
