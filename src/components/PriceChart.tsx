// Price chart for a curve, powered by the stacc-backend indexer.
//
// Fetches GET /curves/:mint/chart?bucket=<s>&limit=<n> on mount + every
// 15s. Each point is a time bucket containing the LAST trade's price in
// LST atoms per MEME atom. Recharts renders a smoothed line; volume bars
// would go here too if/when we want them.
//
// If the indexer has no data (degraded mode, fresh curve, or backend
// unreachable) we render an empty-state pill instead of an empty chart.

import { useEffect, useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

interface ChartPoint {
  t: string
  p: string
  v: string
  n: number
}

const BACKEND_URL =
  (import.meta as unknown as { env?: { VITE_BACKEND_URL?: string } }).env
    ?.VITE_BACKEND_URL ?? 'http://127.0.0.1:3000'

export function PriceChart({
  mint,
  bucketSec = 300,
  pollMs = 15_000,
}: {
  mint: string
  bucketSec?: number
  pollMs?: number
}) {
  const [points, setPoints] = useState<ChartPoint[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const url = `${BACKEND_URL}/curves/${mint}/chart?bucket=${bucketSec}&limit=200`
    const load = async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          if (!cancelled) setErr(`backend ${res.status}`)
          return
        }
        const j = (await res.json()) as { points?: ChartPoint[]; degraded?: boolean }
        if (!cancelled) {
          setErr(null)
          setPoints(j.points ?? [])
        }
      } catch (e) {
        if (!cancelled) setErr((e as Error).message)
      }
    }
    load()
    const id = setInterval(load, pollMs)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [mint, bucketSec, pollMs])

  const data = useMemo(
    () =>
      (points ?? []).map((p) => ({
        t: new Date(p.t).getTime(),
        // Number-converted price — fine for chart axis, we use bigint
        // strings only for accounting.
        p: Number(p.p),
        v: Number(p.v),
      })),
    [points],
  )

  if (points === null && !err) {
    return <EmptyChart message="loading chart…" />
  }
  if (err) {
    return <EmptyChart message={`chart unavailable (${err})`} />
  }
  if (data.length === 0) {
    return <EmptyChart message="no trades yet — chart appears after the first buy" />
  }

  return (
    <div style={{ width: '100%', height: 220 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="rgb(0 0 0 / 0.06)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={(v) =>
              new Date(v).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })
            }
            minTickGap={48}
            tick={{ fontSize: 11, fill: 'var(--color-dim, #888)' }}
            axisLine={{ stroke: 'rgb(0 0 0 / 0.12)' }}
            tickLine={{ stroke: 'rgb(0 0 0 / 0.12)' }}
          />
          <YAxis
            dataKey="p"
            tickFormatter={(v: number) => (v === 0 ? '0' : v.toExponential(1))}
            width={64}
            tick={{ fontSize: 11, fill: 'var(--color-dim, #888)' }}
            axisLine={{ stroke: 'rgb(0 0 0 / 0.12)' }}
            tickLine={{ stroke: 'rgb(0 0 0 / 0.12)' }}
            domain={['auto', 'auto']}
          />
          <Tooltip
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            formatter={(v, name) => {
              const num = Number(v ?? 0)
              return name === 'p'
                ? [num.toExponential(4) + ' LST/MEME', 'price']
                : [String(v), String(name ?? '')]
            }}
            contentStyle={{
              fontSize: 12,
              border: '1px solid rgb(0 0 0 / 0.12)',
              background: 'var(--bg, #fff)',
            }}
          />
          <Line
            type="monotone"
            dataKey="p"
            stroke="#0a6e3c"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div
      style={{
        height: 220,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px dashed rgb(0 0 0 / 0.12)',
        borderRadius: 12,
        color: 'var(--color-dim, #888)',
        fontSize: 12,
      }}
    >
      {message}
    </div>
  )
}
