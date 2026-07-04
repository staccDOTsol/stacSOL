import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import { fetchPool, type PoolState } from '../lib/pool'
import { MINT, POOL } from '../lib/constants'

// Poll stays as the safety net (websockets drop silently on mobile), but the
// realtime path is the two account subscriptions below: every burn-loop
// crank, deposit, or out-of-band burn patches the PoolState the moment the
// account changes — no 10s staleness window on NAV / supply / backing.
export function usePool(refreshMs = 10_000) {
  const { connection } = useConnection()
  const [pool, setPool] = useState<PoolState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetchPool(connection)
      .then((p) => { if (!cancelled) { setPool(p); setError(null) } })
      .catch((e: Error) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [connection, tick])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), refreshMs)
    return () => clearInterval(id)
  }, [refreshMs])

  // Realtime: patch the fields we can decode straight off the changed
  // account (same fixed offsets as fetchPool) instead of re-fetching all
  // three accounts on every notification.
  useEffect(() => {
    const poolSub = connection.onAccountChange(
      POOL,
      (acc) => {
        setPool((p) =>
          p
            ? {
                ...p,
                poolTotalLamports: acc.data.readBigUInt64LE(258),
                poolTokenSupplyAccounting: acc.data.readBigUInt64LE(266),
                lastUpdateEpoch: acc.data.readBigUInt64LE(274),
              }
            : p,
        )
      },
      'processed',
    )
    const mintSub = connection.onAccountChange(
      MINT,
      (acc) => {
        setPool((p) =>
          p ? { ...p, mintSupply: acc.data.readBigUInt64LE(36) } : p,
        )
      },
      'processed',
    )
    return () => {
      connection.removeAccountChangeListener(poolSub).catch(() => {})
      connection.removeAccountChangeListener(mintSub).catch(() => {})
    }
  }, [connection])

  return { pool, error, refresh: () => setTick((t) => t + 1) }
}
