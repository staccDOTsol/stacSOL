import { fmtAmount, shortPk } from '../lib/format'
import type { PoolState } from '../lib/pool'
import { POOL } from '../lib/constants'
import { useHistory } from '../hooks/useHistory'

// Reliability guards. Need to match Landing.tsx/useLivePerf so both surfaces
// render the SAME implied APR. Previously this card used a since-deploy
// linear annualization (`(rate−1) × year/elapsed`) while Landing used
// trailing-24h linear, producing wildly different displayed APRs for the
// same protocol (the user reported "1.00% APR" here vs. 400%+ on Landing).
// Switching to trailing-24h compound aligns both surfaces.
const MIN_HISTORY_SPAN_DAYS = 0.5
const MAX_PLAUSIBLE_DAILY = 0.5
const MAX_DISPLAYED_APR_PCT = 100_000

export function Stats({ pool }: { pool: PoolState | null }) {
  const { history } = useHistory()

  // Authoritative rate is what the SPL stake pool program uses for redemption.
  // pool.total_lamports / pool.pool_token_supply. While pool is null (RPC
  // hasn't responded yet) we render "—" instead of "1.000000" — the latter
  // gives the user a brief panic that NAV crashed back to par.
  const reserves = pool ? fmtAmount(pool.poolTotalLamports) : '—'
  const supply = pool ? fmtAmount(pool.poolTokenSupplyAccounting) : '—'
  const rateLoaded = !!pool && pool.poolTokenSupplyAccounting > 0n
  const rateNum = rateLoaded
    ? Number(pool!.poolTotalLamports) / Number(pool!.poolTokenSupplyAccounting)
    : 1
  const rateStr = rateLoaded ? rateNum.toFixed(6) : '—'

  // Live mint.supply may diverge between UpdateStakePoolBalance calls due to
  // out-of-band burns; surface this so users can see whether a sync is pending.
  const mintLive = pool ? Number(pool.mintSupply) / 1e9 : null
  const accountingLive = pool ? Number(pool.poolTokenSupplyAccounting) / 1e9 : null
  const drift = mintLive != null && accountingLive != null ? accountingLive - mintLive : null
  const driftStr =
    drift != null && Math.abs(drift) > 1e-6
      ? `pending sync — Token-2022 mint.supply is ${mintLive!.toFixed(6)}, drift ${drift > 0 ? '+' : ''}${drift.toFixed(6)} stacSOL`
      : null

  // Trailing-24h compound APR. Same math as Landing.tsx so both surfaces
  // render the same number for the same protocol state. Returns null when
  // the history span is too short to trust.
  let aprPct: number | null = null
  let aprWindowDays: number | null = null
  if (history.length > 1) {
    const last = history[history.length - 1]
    const target = last.ts - 24 * 60 * 60 * 1000
    let prev = history[0]
    for (const row of history) {
      if (Math.abs(row.ts - target) < Math.abs(prev.ts - target)) prev = row
    }
    const dtDays = (last.ts - prev.ts) / (1000 * 60 * 60 * 24)
    if (prev.rate > 0 && last.rate > prev.rate && dtDays >= MIN_HISTORY_SPAN_DAYS) {
      const dailyRate = Math.pow(last.rate / prev.rate, 1 / dtDays) - 1
      if (dailyRate > 0 && dailyRate <= MAX_PLAUSIBLE_DAILY) {
        aprPct = Math.min(
          MAX_DISPLAYED_APR_PCT,
          (Math.pow(1 + dailyRate, 365) - 1) * 100,
        )
        aprWindowDays = dtDays
      }
    }
  }
  const aprDisplayable = aprPct != null && aprPct >= 0 && aprPct < MAX_DISPLAYED_APR_PCT
  const aprDisplay = !rateLoaded
    ? '—'
    : aprDisplayable && aprPct != null
      ? aprPct >= 1000
        ? `${Math.round(aprPct).toLocaleString()}%`
        : `${aprPct.toFixed(2)}%`
      : '—'
  const aprDetail = !rateLoaded
    ? 'waiting for pool state'
    : !aprDisplayable
      ? history.length > 1
        ? 'gathering data — need ≥12h of snapshots'
        : 'waiting for /api/history'
      : `trailing ${aprWindowDays!.toFixed(1)}d compound · matches landing`

  return (
    <Card title="Pool">
      <div className="grid grid-cols-2 gap-3">
        <Stat
          label="Backing"
          value={reserves}
          unit="SOL"
          sub="pool.total_lamports (program accounting)"
        />
        <Stat
          label="Supply"
          value={supply}
          unit="stacSOL"
          sub="pool.pool_token_supply"
        />
        <Stat
          label="Redemption rate (NAV)"
          value={rateStr}
          unit="SOL / stacSOL"
          sub="what WithdrawSol actually pays out"
        />
        <Stat label="Implied APR" value={aprDisplay} sub={aprDetail} />
      </div>
      {driftStr && (
        <p className="mt-3 text-[11px] text-[var(--color-warn)]">⏳ {driftStr}</p>
      )}
      <p className="mt-3 text-[11px] text-[var(--color-dim)]">
        Pool {shortPk(POOL.toBase58())} · last update epoch{' '}
        {pool ? pool.lastUpdateEpoch.toString() : '—'} · refreshes every 10s
      </p>
    </Card>
  )
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card-hot bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)] rounded-md p-5 mb-5">
      <h2 className="m-0 mb-4 text-base font-black uppercase tracking-[4px] text-[var(--color-hot)] [text-shadow:0_0_10px_rgba(255,34,0,0.5),0_0_2px_rgba(255,34,0,0.9)]">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Stat({
  label,
  value,
  unit,
  sub,
}: {
  label: string
  value: string
  unit?: string
  sub?: string
}) {
  return (
    <div className="bg-[var(--color-bg)] rounded-md p-4 border border-[rgb(255_34_0_/_0.1)]">
      <div className="text-[10px] font-bold uppercase tracking-[2px] text-[var(--color-dim)]">{label}</div>
      <div className="mt-1.5 leading-none">
        <span className="tabular-mono text-3xl font-extrabold text-[var(--color-fg)]">{value}</span>
        {unit && <span className="text-[11px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider">{unit}</span>}
      </div>
      {sub && <div className="text-[11px] text-[var(--color-dim)] mt-2 leading-tight">{sub}</div>}
    </div>
  )
}
