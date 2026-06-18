import { useEffect, useState } from 'react'
import type { EvmChainId } from '../lib/evm-chains'

export interface EvmNavRow {
  id: EvmChainId
  totalAssets: string | null
  totalSupply: string | null
  nav: number | null
  live: boolean
  error?: string
}

interface EvmNavResponse {
  chains: EvmNavRow[]
  fetchedAt: number
}

export function useEvmNav(refreshMs = 30_000) {
  const [data, setData] = useState<EvmNavResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const res = await fetch('/api/evm-nav')
        if (!res.ok) throw new Error(`evm-nav ${res.status}`)
        const json = (await res.json()) as EvmNavResponse
        if (!cancelled) {
          setData(json)
          setLoading(false)
        }
      } catch {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    const id = setInterval(() => void load(), refreshMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [refreshMs])

  const byId = (id: EvmChainId): EvmNavRow | null =>
    data?.chains.find((c) => c.id === id) ?? null

  return { data, loading, byId }
}