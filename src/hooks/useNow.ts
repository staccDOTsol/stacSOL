// Shared per-second clock for dopamine tickers.
//
// Every surface that renders an "accruing" number (NAV tail, position value,
// counterfactual panels) subscribes to ONE interval instead of each running
// its own setInterval — keeps re-renders aligned so all tickers advance in
// the same frame, which reads as one living system instead of three
// slightly-off metronomes.

import { useEffect, useState } from 'react'

const subscribers = new Set<(now: number) => void>()
let intervalId: ReturnType<typeof setInterval> | null = null

function ensureLoop() {
  if (intervalId != null) return
  intervalId = setInterval(() => {
    const now = Date.now()
    subscribers.forEach(s => s(now))
  }, 1000)
}

export function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    subscribers.add(setNow)
    ensureLoop()
    return () => {
      subscribers.delete(setNow)
      if (subscribers.size === 0 && intervalId != null) {
        clearInterval(intervalId)
        intervalId = null
      }
    }
  }, [])
  return now
}

/**
 * Extrapolate a value forward from its last real on-chain anchor at the
 * protocol's measured realized daily rate. This is projection between
 * truths, not fabrication: every websocket account update re-anchors the
 * base value, so the ticker can never drift further than one real event.
 */
export function accrue(
  anchorValue: number,
  anchorTs: number,
  dailyRate: number | null,
  nowMs: number,
): number {
  if (dailyRate == null || dailyRate <= 0) return anchorValue
  const days = Math.max(0, nowMs - anchorTs) / 86_400_000
  return anchorValue * Math.pow(1 + dailyRate, days)
}
