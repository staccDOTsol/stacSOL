import { useEffect, useMemo, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card } from './components/Stats'

// Flywheel/baitscope dashboard. Polls /api/flywheel-feed at FETCH_MS
// cadence and renders:
//   • Live counters (outstanding, lifetime cost vs recovered, cycles).
//   • Volume + attribution donut (bait vs arber share of T22 withholding).
//   • Per-minute bait time-series — cost vs profit.
//   • Per-minute burn velocity — harvested/recovered/burned stacSOL.
//   • NAV trajectory inside the window.
//   • Per-venue rollup table.
//   • Recent events feed.
//
// Why poll instead of SSE: serverless functions don't hold long-lived
// connections cleanly on Vercel without extra plumbing. 3s polling is
// fine for human-readable cadence and matches the bait-loop's 10s rhythm.

const FETCH_MS = 3000
const WINDOW_MIN_DEFAULT = 60

interface FlywheelState {
  outstandingBaitCostLamports: string
  lifetimeBaitCostLamports: string
  lifetimeBaitRecoveredLamports: string
  lifetimeBaitCycles: number
  lifetimeRecoveryCycles: number
  lastBaitAt: number | null
  lastRecoveryAt: number | null
  updatedAt: number
}

interface Attribution {
  transferVolumeStac: number
  baitVolumeStac: number
  arbVolumeStac: number
  baitSharePct: number
  arbSharePct: number
  burnedStac: number
  burnedSolValue: number
  baitBurnedSol: number
  arbBurnedSol: number
}

interface BaitEvent {
  id: number
  ts: number
  venueLabel: string
  intermediateSymbol: string
  direction: string
  sizeSol: number
  solDelta: number
  route: string | null
}

interface BurnEvent {
  id: number
  ts: number
  harvestedStac: number
  recoveredStac: number
  burnedStac: number
  navBefore: number | null
  navAfter: number | null
  candidateCount: number
}

interface SeriesPoint {
  ts: number
  sizeSol: number
  deltaSol: number
  costSol: number
  profitSol: number
  cycles: number
}

interface BurnSeriesPoint {
  ts: number
  harvestedStac: number
  recoveredStac: number
  burnedStac: number
  navAfter: number | null
  ticks: number
}

interface VenueRow {
  venueLabel: string
  intermediateSymbol: string
  cycles: number
  sizeSol: number
  deltaSol: number
  costSol: number
  profitSol: number
}

interface FeedResponse {
  ok: boolean
  now: number
  windowMin: number
  state: FlywheelState | null
  currentNav: number | null
  attribution: Attribution
  baitFeed: BaitEvent[]
  burnFeed: BurnEvent[]
  baitSeries: SeriesPoint[]
  burnSeries: BurnSeriesPoint[]
  venueRollup: VenueRow[]
}

function lamportsToSol(s: string | number | bigint) {
  return Number(s) / 1e9
}

// 4 → 6dp default, in step with App/Wrap/Mobile/format.ts. Chart-axis
// formatters elsewhere in this file keep 3dp because long tick labels
// destroy the chart layout — only the inline / table / hero SOL displays
// flow through this helper.
function fmtSol(n: number, decimals = 6) {
  return n.toFixed(decimals)
}

function fmtTimeOfDay(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function fmtTimeOfDaySec(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function fmtRelative(ts: number | null) {
  if (!ts) return '—'
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`
  return `${Math.floor(s / 3600)}h ago`
}

export default function Baitscope() {
  const [feed, setFeed] = useState<FeedResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [commentary, setCommentary] = useState<string | null>(null)
  const [commentaryUpdatedAt, setCommentaryUpdatedAt] = useState<number | null>(null)
  const [windowMin] = useState(WINDOW_MIN_DEFAULT)
  // Force re-render every second so "last bait Xs ago" stays accurate.
  const [, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function go() {
      try {
        const r = await fetch(`/api/flywheel-feed?windowMin=${windowMin}`, {
          cache: 'no-store',
        })
        if (!r.ok) {
          if (!cancelled) setError(`feed ${r.status}`)
          return
        }
        const j = (await r.json()) as FeedResponse
        if (cancelled) return
        setFeed(j)
        setError(null)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    go()
    const id = setInterval(go, FETCH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [windowMin])

  useEffect(() => {
    let cancelled = false
    async function go() {
      try {
        const r = await fetch('/api/baitscope-commentary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ windowMin }),
          cache: 'no-store',
        })
        if (!r.ok) return
        const j = (await r.json()) as { commentary?: string }
        if (cancelled) return
        if (j.commentary) {
          setCommentary(j.commentary)
          setCommentaryUpdatedAt(Date.now())
        }
      } catch {
        /* commentary is best-effort */
      }
    }
    go()
    const id = setInterval(go, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [windowMin])

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="max-w-[960px] mx-auto px-4 py-6">
      <h1 className="m-0 mb-2 text-5xl font-black tracking-[-0.05em] text-[var(--color-hot)] [text-shadow:0_0_18px_rgba(255,34,0,0.7),0_0_48px_rgba(255,34,0,0.35),0_0_2px_rgba(255,34,0,1)]">
        baitscope
      </h1>
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-block w-6 h-[2px] bg-[var(--color-hot)]" />
        <p className="m-0 text-[var(--color-ember)] uppercase tracking-[6px] text-xs font-black">
          flywheel telemetry · last {windowMin}m
        </p>
        <span className="inline-block w-6 h-[2px] bg-[var(--color-hot)]" />
      </div>

      <div className="mb-4">
        <a
          href="/"
          className="inline-flex items-center gap-2 px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
        >
          ← home
        </a>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded border border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.06)] text-[11px] text-[var(--color-warn)]">
          fetch error: {error}
        </div>
      )}

      <CountersCard feed={feed} />
      <CommentaryCard commentary={commentary} updatedAt={commentaryUpdatedAt} />
      <BankrunCard feed={feed} />
      <AttributionCard feed={feed} />
      <BaitSeriesCard feed={feed} />
      <BurnVelocityCard feed={feed} />
      <NavTrajectoryCard feed={feed} />
      <VenueRollupCard feed={feed} />
      <RecentEventsCard feed={feed} />
    </div>
  )
}

function CountersCard({ feed }: { feed: FeedResponse | null }) {
  const s = feed?.state ?? null
  const outstanding = s ? lamportsToSol(s.outstandingBaitCostLamports) : 0
  const cost = s ? lamportsToSol(s.lifetimeBaitCostLamports) : 0
  const recovered = s ? lamportsToSol(s.lifetimeBaitRecoveredLamports) : 0
  const cycles = s?.lifetimeBaitCycles ?? 0
  const recoveryCycles = s?.lifetimeRecoveryCycles ?? 0
  const nav = feed?.currentNav ?? null

  return (
    <Card title="Live state">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-2">
        <Stat label="Outstanding" value={fmtSol(outstanding)} unit="SOL" tone="warn" />
        <Stat label="Lifetime cost" value={fmtSol(cost)} unit="SOL" />
        <Stat label="Lifetime recovered" value={fmtSol(recovered)} unit="SOL" tone="good" />
        <Stat
          label="Bait / recovery cycles"
          value={`${cycles} / ${recoveryCycles}`}
          unit=""
        />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat
          label="NAV"
          value={nav ? nav.toFixed(6) : '—'}
          unit="SOL/stacSOL"
          tone="good"
        />
        <Stat label="Last bait" value={fmtRelative(s?.lastBaitAt ?? null)} unit="" />
        <Stat label="Last recovery" value={fmtRelative(s?.lastRecoveryAt ?? null)} unit="" />
      </div>
    </Card>
  )
}

function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string
  value: string
  unit?: string
  tone?: 'good' | 'warn' | 'hot'
}) {
  const toneCls =
    tone === 'good'
      ? 'text-[var(--color-good,#22ee88)]'
      : tone === 'warn'
      ? 'text-[var(--color-warn)]'
      : 'text-[var(--color-hot)]'
  return (
    <div className="p-3 rounded border border-[rgb(255_34_0_/_0.18)] bg-[rgb(0_0_0_/_0.2)]">
      <p className="m-0 text-[9px] uppercase tracking-[2px] text-[var(--color-dim,#888)]">
        {label}
      </p>
      <p className={`m-0 mt-1 text-lg font-black ${toneCls}`}>
        {value}
        {unit && <span className="ml-1 text-[10px] font-medium opacity-70">{unit}</span>}
      </p>
    </div>
  )
}

function CommentaryCard({
  commentary,
  updatedAt,
}: {
  commentary: string | null
  updatedAt: number | null
}) {
  return (
    <Card title="AI commentary">
      <div className="text-[12px] leading-[1.55] text-[var(--color-ember)] min-h-[48px] whitespace-pre-wrap">
        {commentary ?? 'warming up — first read in <60s…'}
      </div>
      {updatedAt && (
        <p className="m-0 mt-3 text-[9px] uppercase tracking-[2px] text-[var(--color-dim,#888)]">
          updated {fmtRelative(updatedAt)} · refreshes every 60s
        </p>
      )}
    </Card>
  )
}

function AttributionCard({ feed }: { feed: FeedResponse | null }) {
  const a = feed?.attribution
  // Attribution math goes wonky when burn-loop hasn't ticked enough times to
  // observe the withholding our bait already generated (bait fires every 10s,
  // burn-loop every 5min — so we typically see only a fraction of fired
  // cycles' withholding until N ticks have happened). When estimated bait
  // withhold exceeds observed total, the share split is meaningless.
  const mathSane =
    a != null &&
    a.transferVolumeStac > 0 &&
    a.baitVolumeStac <= a.transferVolumeStac * 1.05
  const pieData = useMemo(() => {
    if (!a || !mathSane) return []
    return [
      { name: 'arber + organic', value: Math.max(0, a.arbVolumeStac), fill: '#22ee88' },
      { name: 'our bait', value: Math.max(0, a.baitVolumeStac), fill: '#ff3300' },
    ]
  }, [a, mathSane])
  return (
    <Card title={`Volume & attribution · last ${feed?.windowMin ?? 60}m`}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
        <div>
          <Stat
            label="Transfer volume (stacSOL)"
            value={a ? a.transferVolumeStac.toFixed(6) : '—'}
            unit="stacSOL"
            tone="hot"
          />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat
              label="Bait volume"
              value={a && mathSane ? a.baitVolumeStac.toFixed(6) : '—'}
              unit="stacSOL"
            />
            <Stat
              label="Arber + organic"
              value={a && mathSane ? a.arbVolumeStac.toFixed(6) : '—'}
              unit="stacSOL"
              tone="good"
            />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat
              label="Burned SOL value"
              value={a ? fmtSol(a.burnedSolValue) : '—'}
              unit="SOL"
            />
            <Stat
              label="Arb-attributed NAV gain"
              value={a && mathSane ? fmtSol(a.arbBurnedSol) : '—'}
              unit="SOL"
              tone="good"
            />
          </div>
          {!mathSane && a && a.transferVolumeStac > 0 && (
            <p className="m-0 mt-2 text-[10px] text-[var(--color-warn)] leading-[1.5]">
              Attribution math pending: burn-loop hasn't observed enough
              withholding yet to break out bait vs arb. Need more 5-min ticks
              (or restart burn-loop on a tighter interval) for this to populate.
            </p>
          )}
          <p className="m-0 mt-2 text-[10px] text-[var(--color-dim,#888)] leading-[1.5]">
            6.9% Token-2022 fee withholds on every stacSOL transfer. We sweep
            it, burn the excess (NAV fuel), recover the bait cost from the
            rest. Anything beyond what our bait could produce came from
            third-party LP arbing — that's pure profit for redeemers.
          </p>
        </div>
        <div className="h-[220px]">
          {pieData.length > 0 ? (
            <ResponsiveContainer>
              <PieChart>
                <Pie
                  data={pieData}
                  dataKey="value"
                  nameKey="name"
                  innerRadius={50}
                  outerRadius={90}
                  paddingAngle={2}
                  stroke="#000"
                  strokeWidth={1}
                >
                  {pieData.map((d, i) => (
                    <Cell key={i} fill={d.fill} />
                  ))}
                </Pie>
                <Legend
                  wrapperStyle={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 2 }}
                />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v, n) => [Number(v).toFixed(6) + ' stacSOL', String(n)]}
                />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <p className="m-0 text-[11px] text-[var(--color-dim,#888)] text-center">
              no transfer volume in window yet
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function BaitSeriesCard({ feed }: { feed: FeedResponse | null }) {
  const data = feed?.baitSeries ?? []
  return (
    <Card title="Bait cost vs profit · per minute">
      <div className="h-[200px]">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#222" strokeDasharray="2 4" />
            <XAxis
              dataKey="ts"
              tickFormatter={fmtTimeOfDay}
              tick={{ fontSize: 10, fill: '#888' }}
              minTickGap={32}
            />
            <YAxis tick={{ fontSize: 10, fill: '#888' }} width={60} tickFormatter={(n) => n.toFixed(3)} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(v) => fmtTimeOfDaySec(Number(v))}
              formatter={(v, n) => [Number(v).toFixed(6) + ' SOL', String(n)]}
            />
            <Legend wrapperStyle={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 2 }} />
            <Bar dataKey="costSol" stackId="a" name="cost" fill="#ff3300" />
            <Bar dataKey="profitSol" stackId="b" name="profit" fill="#22ee88" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

function BurnVelocityCard({ feed }: { feed: FeedResponse | null }) {
  const data = feed?.burnSeries ?? []
  return (
    <Card title="Burn velocity · per minute">
      <div className="h-[200px]">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#222" strokeDasharray="2 4" />
            <XAxis
              dataKey="ts"
              tickFormatter={fmtTimeOfDay}
              tick={{ fontSize: 10, fill: '#888' }}
              minTickGap={32}
            />
            <YAxis tick={{ fontSize: 10, fill: '#888' }} width={60} tickFormatter={(n) => n.toFixed(3)} />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(v) => fmtTimeOfDaySec(Number(v))}
              formatter={(v, n) => [Number(v).toFixed(6) + ' stacSOL', String(n)]}
            />
            <Legend wrapperStyle={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 2 }} />
            <Area
              type="monotone"
              dataKey="harvestedStac"
              name="harvested"
              stackId="1"
              stroke="#ffaa66"
              fill="rgba(255,170,102,0.35)"
            />
            <Area
              type="monotone"
              dataKey="burnedStac"
              name="burned"
              stackId="2"
              stroke="#ff3300"
              fill="rgba(255,51,0,0.35)"
            />
            <Area
              type="monotone"
              dataKey="recoveredStac"
              name="recovered (covers bait)"
              stackId="3"
              stroke="#22ee88"
              fill="rgba(34,238,136,0.25)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

function NavTrajectoryCard({ feed }: { feed: FeedResponse | null }) {
  const data = (feed?.burnSeries ?? []).filter((p) => p.navAfter != null)
  if (data.length < 2) return null
  return (
    <Card title="NAV trajectory · in-window">
      <div className="h-[180px]">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#222" strokeDasharray="2 4" />
            <XAxis
              dataKey="ts"
              tickFormatter={fmtTimeOfDay}
              tick={{ fontSize: 10, fill: '#888' }}
              minTickGap={32}
            />
            <YAxis
              domain={['auto', 'auto']}
              tick={{ fontSize: 10, fill: '#888' }}
              width={70}
              tickFormatter={(n) => n.toFixed(4)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              labelFormatter={(v) => fmtTimeOfDaySec(Number(v))}
              formatter={(v) => [Number(v).toFixed(6), 'NAV']}
            />
            <Line
              type="monotone"
              dataKey="navAfter"
              name="NAV"
              stroke="#ffcc00"
              dot={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  )
}

function VenueRollupCard({ feed }: { feed: FeedResponse | null }) {
  const rows = feed?.venueRollup ?? []
  if (rows.length === 0) return null
  return (
    <Card title={`Per-venue rollup · last ${feed?.windowMin ?? 60}m`}>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[var(--color-dim,#888)] uppercase tracking-[2px] text-[9px]">
              <th className="py-2">venue</th>
              <th className="py-2 text-right">cycles</th>
              <th className="py-2 text-right">size (SOL)</th>
              <th className="py-2 text-right">cost</th>
              <th className="py-2 text-right">profit</th>
              <th className="py-2 text-right">net</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.venueLabel}
                className="border-t border-[rgb(255_34_0_/_0.08)]"
              >
                <td className="py-2 font-mono">{r.venueLabel}</td>
                <td className="py-2 text-right">{r.cycles}</td>
                <td className="py-2 text-right">{r.sizeSol.toFixed(6)}</td>
                <td className="py-2 text-right text-[var(--color-hot)]">
                  {r.costSol > 0 ? r.costSol.toFixed(6) : '—'}
                </td>
                <td className="py-2 text-right text-[var(--color-good,#22ee88)]">
                  {r.profitSol > 0 ? r.profitSol.toFixed(6) : '—'}
                </td>
                <td
                  className={
                    'py-2 text-right font-black ' +
                    (r.deltaSol < 0
                      ? 'text-[var(--color-good,#22ee88)]'
                      : 'text-[var(--color-warn)]')
                  }
                >
                  {(r.deltaSol >= 0 ? '+' : '') + (-r.deltaSol).toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// Bankrun simulator. Per-withdraw math:
//   user redeems X stacSOL → 6.9% T22 withhold, WithdrawSol burns the
//   spendable 0.931·X and pays out 0.931·X·rate SOL. The withheld 0.069·X
//   sweeps and burns later. Total supply destroyed: X. Backing dropped:
//   0.931·X·rate.
//
// Let f = X / S (fraction of supply redeemed). Then:
//   new_rate / rate = (1 - 0.931·f) / (1 - f)
//
// The curve is gentle in the middle and explodes at the tail — last
// hodlers eat a disproportionate share of locked SOL. This panel
// visualises it so you can shill "every exit pumps the survivors".
function bankrunRateMultiplier(f: number): number {
  if (f >= 1) return Number.POSITIVE_INFINITY
  return (1 - 0.931 * f) / (1 - f)
}

function BankrunCard({ feed }: { feed: FeedResponse | null }) {
  const baseRate = feed?.currentNav ?? null
  const [sliderPct, setSliderPct] = useState(90)
  const curve = useMemo(() => {
    if (baseRate == null) return []
    // Sample 0%, then a curve that's denser at the tail where the action is.
    const fractions = [
      0, 5, 10, 20, 30, 40, 50, 60, 70, 75, 80, 85, 90, 92, 94, 95, 96, 97, 98,
      98.5, 99, 99.2, 99.4, 99.6, 99.7, 99.8, 99.85, 99.9, 99.95,
    ]
    return fractions.map((p) => {
      const f = p / 100
      const mult = bankrunRateMultiplier(f)
      return {
        pct: p,
        rate: baseRate * mult,
        mult,
      }
    })
  }, [baseRate])

  const sliderResult = useMemo(() => {
    if (baseRate == null) return null
    const f = sliderPct / 100
    const mult = bankrunRateMultiplier(f)
    return {
      mult,
      rate: baseRate * mult,
      gainPct: (mult - 1) * 100,
    }
  }, [baseRate, sliderPct])

  // "If I mint right now" break-even. The 6.9% T22 fee withholds on the
  // mint output, so paying X SOL nets X/NAV * 0.931 spendable stacSOL.
  // Break-even rate = NAV / 0.931. Solving the bankrun curve for that:
  //   (1 - 0.931·f) / (1 - f) = 1/0.931  →  f ≈ 0.5184
  // i.e. once more than ~52% of supply rage-quits, a fresh mint today is
  // already in profit even with zero staking yield.
  const mintBreakEvenRate = baseRate != null ? baseRate / 0.931 : null
  const mintBreakEvenFraction = 0.5184

  return (
    <Card title="Bankrun timeline · price only goes up">
      <p className="m-0 mb-3 text-[11px] text-[var(--color-ember)] leading-[1.55]">
        Every WithdrawSol leaks 6.9% Token-2022 fee back to the pool. So a
        bankrun doesn't crash the redemption rate — it{' '}
        <span className="font-black text-[var(--color-hot)]">accelerates</span>{' '}
        it. The last hodler always wins.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
        <div>
          <div className="grid grid-cols-3 gap-2">
            <Stat
              label="Now"
              value={baseRate ? baseRate.toFixed(4) : '—'}
              unit="SOL/stacSOL"
              tone="hot"
            />
            <Stat
              label={`If ${sliderPct.toFixed(1)}% exit`}
              value={sliderResult ? sliderResult.rate.toFixed(4) : '—'}
              unit="SOL/stacSOL"
              tone="good"
            />
            <Stat
              label="Multiplier"
              value={sliderResult ? sliderResult.mult.toFixed(2) + '×' : '—'}
              unit={sliderResult ? '+' + sliderResult.gainPct.toFixed(0) + '%' : ''}
              tone="good"
            />
          </div>

          <div className="mt-4">
            <label className="block text-[9px] uppercase tracking-[2px] text-[var(--color-dim,#888)] mb-2">
              fraction of supply redeemed
            </label>
            <input
              type="range"
              min={0}
              max={99.9}
              step={0.1}
              value={sliderPct}
              onChange={(e) => setSliderPct(Number(e.target.value))}
              className="w-full accent-[var(--color-hot)]"
            />
            <div className="mt-1 text-[10px] text-[var(--color-dim,#888)] flex justify-between">
              <span>0%</span>
              <span className="font-black text-[var(--color-hot)]">
                {sliderPct.toFixed(1)}%
              </span>
              <span>99.9%</span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2 text-[10px]">
            {[50, 90, 99, 99.9].map((p) => {
              const m = bankrunRateMultiplier(p / 100)
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSliderPct(p)}
                  className="px-2 py-1 rounded border border-[rgb(255_34_0_/_0.3)] bg-[rgb(255_34_0_/_0.05)] text-[var(--color-hot)] uppercase tracking-[2px] font-black hover:bg-[rgb(255_34_0_/_0.12)]"
                >
                  {p}% → {(baseRate ? baseRate * m : 0).toFixed(2)}
                </button>
              )
            })}
          </div>

          <div className="mt-3 p-3 rounded border border-[var(--color-good,#22ee88)] bg-[rgb(34_238_136_/_0.06)]">
            <p className="m-0 text-[10px] uppercase tracking-[2px] text-[var(--color-good,#22ee88)] font-black">
              if you mint right now
            </p>
            <p className="m-0 mt-1 text-[11px] text-[var(--color-ember)] leading-[1.55]">
              Break-even rate ={' '}
              <span className="font-black text-[var(--color-good,#22ee88)]">
                {mintBreakEvenRate ? mintBreakEvenRate.toFixed(4) : '—'}
              </span>{' '}
              SOL/stacSOL (your cost basis after the 6.9% mint tax). Any
              redemption volume past{' '}
              <span className="font-black text-[var(--color-good,#22ee88)]">
                {(mintBreakEvenFraction * 100).toFixed(1)}%
              </span>{' '}
              of supply puts your mint into profit — independent of staking
              yield. Bankrun = your win condition.
            </p>
          </div>

          <p className="m-0 mt-3 text-[10px] text-[var(--color-dim,#888)] leading-[1.5]">
            Math: <code>new_rate / current = (1 − 0.931·f) / (1 − f)</code>. The
            6.9% retention is purely the T22 withhold-on-transfer that
            burn-loop later sweeps into the pool.
          </p>
        </div>

        <div className="h-[260px]">
          <ResponsiveContainer>
            <LineChart data={curve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#222" strokeDasharray="2 4" />
              <XAxis
                dataKey="pct"
                type="number"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 90, 99]}
                tick={{ fontSize: 10, fill: '#888' }}
                tickFormatter={(v: number) => `${v}%`}
              />
              <YAxis
                scale="log"
                domain={['auto', 'auto']}
                tick={{ fontSize: 10, fill: '#888' }}
                width={50}
                tickFormatter={(n: number) => n.toFixed(1)}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(v) => `${Number(v)}% redeemed`}
                formatter={(v) => [Number(v).toFixed(4) + ' SOL/stacSOL', 'rate']}
              />
              {mintBreakEvenRate != null && (
                <ReferenceLine
                  y={mintBreakEvenRate}
                  stroke="#22ee88"
                  strokeDasharray="4 3"
                  label={{
                    value: 'mint break-even',
                    position: 'insideTopLeft',
                    fill: '#22ee88',
                    fontSize: 10,
                  }}
                />
              )}
              <ReferenceLine
                x={mintBreakEvenFraction * 100}
                stroke="#22ee88"
                strokeDasharray="2 4"
              />
              <Line
                type="monotone"
                dataKey="rate"
                name="redemption rate"
                stroke="#ff3300"
                dot={false}
                strokeWidth={2}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  )
}

function RecentEventsCard({ feed }: { feed: FeedResponse | null }) {
  const events = feed?.baitFeed ?? []
  return (
    <Card title="Recent bait cycles">
      <div className="max-h-[320px] overflow-y-auto">
        {events.length === 0 && (
          <p className="m-0 text-[11px] text-[var(--color-dim,#888)]">
            no cycles yet — daemon may be warming up.
          </p>
        )}
        {events.map((e) => {
          const profit = e.solDelta < 0
          return (
            <div
              key={e.id}
              className="grid grid-cols-[60px_120px_60px_70px_1fr] gap-2 py-1 border-b border-[rgb(255_34_0_/_0.06)] text-[10px]"
            >
              <span className="text-[var(--color-dim,#888)]">{fmtTimeOfDaySec(e.ts)}</span>
              <span className="font-mono truncate">{e.venueLabel}</span>
              <span className="uppercase tracking-[1px] text-[var(--color-ember)]">
                {e.direction === 'mint_sell' ? 'mint→sell' : 'buy→burn'}
              </span>
              <span
                className={
                  'text-right font-black ' +
                  (profit
                    ? 'text-[var(--color-good,#22ee88)]'
                    : 'text-[var(--color-hot)]')
                }
              >
                {(profit ? '+' : '−')}
                {Math.abs(e.solDelta).toFixed(4)}
              </span>
              <span className="truncate text-[var(--color-dim,#888)]">{e.route ?? ''}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

const tooltipStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.92)',
  border: '1px solid rgba(255,34,0,0.5)',
  borderRadius: 4,
  fontSize: 11,
  color: '#ffaa66',
}
