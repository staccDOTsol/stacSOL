// Shared stacSOL-ATA balance polling hook. Mirrors useSolBalance but reads
// the wallet's Token-2022 ATA for the stacSOL mint with a single
// `getAccountInfo` per tick — no tx-history walk.
//
// Why this exists: usePosition() does a full pagination of every signature
// touching the ATA plus `getParsedTransactions` to recover cost basis. For
// an active wallet that takes 5–30s the first time, during which `position`
// is null and the dashboard shows balance 0. This hook gives the UI a
// fast-path read of the live balance so the Burn-tab balance, percent
// buttons, and Position card don't block on the heavy fetch.

import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { Connection, PublicKey } from '@solana/web3.js'
import { deriveAta } from '../lib/ix'
import { MINT } from '../lib/constants'

interface CacheEntry {
  balance: bigint | null
  ts: number
  inflight: Promise<bigint> | null
  subscribers: Set<(b: bigint) => void>
  intervalId: ReturnType<typeof setInterval> | null
}

const cache = new Map<string, CacheEntry>()

const KEY_FN = (conn: Connection, owner: PublicKey): string =>
  `${conn.rpcEndpoint}:${owner.toBase58()}`

/**
 * Subscribe to the wallet's stacSOL ATA balance (atomic units, 9 decimals).
 * Returns null until the first fetch resolves. Null also means the wallet
 * is disconnected (publicKey === null).
 */
export function useStacBalance(
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
    const ata = deriveAta(publicKey, MINT)
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
        // Token-2022 mint-account base layout: amount (u64) lives at byte 64
        // of the account data — same offset as legacy SPL Token because the
        // base struct is shared; Token-2022 extensions live AFTER byte 165.
        const acc = await connection.getAccountInfo(ata, 'processed')
        if (!acc) return 0n
        return acc.data.readBigUInt64LE(64)
      })()
      try {
        const v = await entry.inflight
        entry.balance = v
        entry.ts = Date.now()
        entry.subscribers.forEach(s => s(v))
      } catch {
        /* keep last known value, retry on next interval */
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
