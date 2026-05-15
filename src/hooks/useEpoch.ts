// Polls the cluster's epoch info every 30s. Used to detect when the
// stake-pool's lastUpdateEpoch falls behind the cluster — the SPL
// stake-pool program rejects DepositSol / WithdrawSol with code 0x11
// (StakeListAndPoolOutOfDate) until the manager cranks
// UpdateValidatorListBalance + UpdateStakePoolBalance. Surfacing the lag
// proactively means users see a useful warning instead of a cryptic
// "program error 0x11" toast after their wallet sig fires.

import { useEffect, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'

export interface EpochInfo {
  epoch: number
  slotIndex: number
  slotsInEpoch: number
}

export function useEpoch(refreshMs = 30_000): EpochInfo | null {
  const { connection } = useConnection()
  const [info, setInfo] = useState<EpochInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const e = await connection.getEpochInfo('confirmed')
        if (!cancelled) {
          setInfo({
            epoch: e.epoch,
            slotIndex: e.slotIndex,
            slotsInEpoch: e.slotsInEpoch,
          })
        }
      } catch {
        /* keep previous reading */
      }
    }
    fetchOnce()
    const id = setInterval(fetchOnce, refreshMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connection, refreshMs])

  return info
}
