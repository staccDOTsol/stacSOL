import { useMemo, useState } from 'react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from './Stats'
import { useHistory, type Snapshot } from '../hooks/useHistory'

type MetricKey = 'rate' | 'backing' | 'supply' | 'mintSupply'

interface Metric {
  key: MetricKey
  label: string
  unit: string
  hint: string
  color: string
  /** Pull a value out of a snapshot. */
  pick: (s: Snapshot) => number
  /** Format Y-axis ticks. */
  fmt: (n: number) => string
}

const METRICS: Metric[] = [
  {
    key: 'rate',
    label: 'NAV (live)',
    unit: 'SOL / stacSOL',
    hint: 'pool.total_lamports ÷ mint.supply — chain truth, counts every on-chain burn instantly (history backfilled the same way)',
    color: '#ff3300',
    pick: (s) => s.rate,
    fmt: (n) => n.toFixed(4),
  },
  {
    key: 'backing',
    label: 'Backing',
    unit: 'SOL',
    hint: 'pool.total_lamports — total SOL the pool accounts as backing the supply',
    color: '#ffaa66',
    pick: (s) => Number(s.totalLamports) / 1e9,
    fmt: (n) => n.toFixed(2),
  },
  {
    key: 'supply',
    label: 'Pool supply',
    unit: 'stacSOL',
    hint: 'pool.pool_token_supply — what the program uses for redemption math',
    color: '#22ee88',
    pick: (s) => Number(s.poolTokenSupply) / 1e9,
    fmt: (n) => n.toFixed(2),
  },
  {
    key: 'mintSupply',
    label: 'Token-2022 supply',
    unit: 'stacSOL',
    hint: 'mint.supply — outstanding tokens. Drops on every burn, whoever sends it.',
    color: '#ffcc00',
    pick: (s) => Number(s.mintSupply) / 1e9,
    fmt: (n) => n.toFixed(2),
  },
]

export function HistoryCharts() {
  const { history, error, loading } = useHistory()
  const [openKey, setOpenKey] = useState<MetricKey | null>('rate')

  return (
    <Card title="History">
      {error && (
        <p className="m-0 mb-2 text-[11px] text-[var(--color-warn)]">
          history fetch error: {error} (db may not be seeded yet)
        </p>
      )}
      {!error && history.length === 0 && !loading && (
        <p className="m-0 mb-2 text-[11px] text-[var(--color-dim)]">
          no snapshots yet — Vercel cron writes one every 5min, check back shortly.
        </p>
      )}
      <div className="flex flex-col gap-2">
        {METRICS.map((m) => (
          <ChartRow
            key={m.key}
            metric={m}
            history={history}
            open={openKey === m.key}
            onToggle={() => setOpenKey(openKey === m.key ? null : m.key)}
          />
        ))}
      </div>
      <p className="mt-3 text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
        snapshots from postgres · {history.length} points · cron */5min
      </p>
    </Card>
  )
}

function ChartRow({
  metric,
  history,
  open,
  onToggle,
}: {
  metric: Metric
  history: Snapshot[]
  open: boolean
  onToggle: () => void
}) {
  const data = useMemo(
    () => history.map((s) => ({ ts: s.ts, value: metric.pick(s) })),
    [history, metric],
  )
  const last = data.length > 0 ? data[data.length - 1].value : null
  const first = data.length > 0 ? data[0].value : null
  const delta = last != null && first != null ? last - first : null
  const deltaPct = delta != null && first != null && first !== 0 ? delta / first : null
  const isUp = delta != null && delta >= 0

  return (
    <div
      className={`rounded border ${
        open
          ? 'border-[var(--color-hot)] bg-[rgb(255_51_0_/_0.04)]'
          : 'border-[rgb(255_51_0_/_0.18)] bg-[var(--color-bg)]'
      } transition-colors`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-[rgb(255_51_0_/_0.06)] transition"
      >
        <div className="flex flex-col">
          <span className="text-[11px] uppercase tracking-wider text-[var(--color-dim)]">
            {metric.label}
          </span>
          <span className="text-base font-bold text-[var(--color-fg)]">
            {last != null ? metric.fmt(last) : '—'}
            <span className="text-[10px] text-[var(--color-dim)] ml-1">{metric.unit}</span>
          </span>
        </div>
        <div className="flex items-center gap-3">
          {deltaPct != null && (
            <span
              className={`text-[11px] font-bold ${
                isUp ? 'text-[var(--color-green)]' : 'text-[var(--color-warn)]'
              }`}
            >
              {isUp ? '↑' : '↓'} {Math.abs(deltaPct * 100).toFixed(2)}%
            </span>
          )}
          <span
            className={`text-[var(--color-hot)] transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          >
            ▸
          </span>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3">
          <p className="text-[10px] text-[var(--color-dim)] mt-1 mb-2">{metric.hint}</p>
          {data.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-[11px] text-[var(--color-dim)]">
              waiting for first snapshot…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgb(255 51 0 / 0.08)" vertical={false} />
                <XAxis
                  dataKey="ts"
                  type="number"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={(v: number) =>
                    new Date(v).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  }
                  stroke="#884422"
                  tick={{ fontSize: 10, fill: '#884422' }}
                  minTickGap={40}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  stroke="#884422"
                  tick={{ fontSize: 10, fill: '#884422' }}
                  tickFormatter={metric.fmt}
                  width={60}
                />
                <Tooltip
                  contentStyle={{
                    background: '#1a0606',
                    border: '1px solid rgb(255 51 0 / 0.4)',
                    borderRadius: 4,
                    fontSize: 11,
                    color: '#ffaa66',
                  }}
                  labelFormatter={(v) => new Date(Number(v)).toLocaleString()}
                  formatter={(v) => [metric.fmt(Number(v)) + ' ' + metric.unit, metric.label]}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={metric.color}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  )
}
