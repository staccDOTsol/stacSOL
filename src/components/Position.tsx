import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Card } from './Stats'
import type { PoolState } from '../lib/pool'
import type { MintTranche } from '../lib/position'
import { fmtAmount } from '../lib/format'
import type { LpExposure } from '../hooks/useLpExposure'
import type { HolderRow } from '../hooks/useMyHolderRow'

// Burn-side fee — the user effectively gets `stac × NAV × BURN_PAYOUT` SOL
// when they hit Burn. Hoisted to the module scope so the per-tranche table
// can use it without re-declaring.
const BURN_PAYOUT = 0.931

const fmtSol = (lamports: bigint) =>
  (Number(lamports) / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
  })

const fmtSolNum = (n: number) =>
  n.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
  })

function fmtAgo(ts: number | null): string {
  if (ts == null) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (sec < 2) return 'just now'
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

export function Position({
  pool,
  position,
  loading,
  error,
  lastBalanceTickAt,
  lpExposure,
  holderRow,
}: {
  pool: PoolState | null
  position: import('../lib/position').Position | null
  loading: boolean
  error: string | null
  lastBalanceTickAt: number | null
  /** Hoisted from App.tsx so this card AND the burn Action card share one
   *  subscription instead of fanning out duplicate fetches. */
  lpExposure: LpExposure
  /** Authoritative cost basis from the indexer (matches /leaderboard row).
   *  When present, `grossSolIn` / `grossSolOut` are sourced from on-chain
   *  DepositSol / WithdrawSol ix amounts directly — no Jupiter zap-in swaps,
   *  jito tips, or compute-budget fees mistakenly counted as cost. The ATA
   *  walk in fetchPosition() can't distinguish those wrapping costs and was
   *  overstating headline P&L for users who minted via /liquidity zaps. */
  holderRow?: HolderRow | null
}) {
  const { publicKey } = useWallet()

  // NAV (= protocol's WithdrawSol redemption rate). `null` until the pool
  // RPC fetch lands — we MUST NOT default this to 1.0 because that makes
  // every value/P&L cell render as if the user had lost 35% of their
  // stake for the ~1-3s while the pool data is still in flight. Heart-
  // attack UX. We render skeleton placeholders for value cells until
  // `pool != null`.
  const currentRate: number | null =
    pool && pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : null

  // Tick a clock so the "Xs ago" label re-renders even when nothing else changes.
  const [, setNow] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  if (!publicKey) return null

  if (loading && !position) {
    return (
      <Card title="Your position">
        <p className="m-0 text-[12px] text-[var(--color-dim)]">scanning chain history…</p>
      </Card>
    )
  }
  if (error) {
    return (
      <Card title="Your position">
        <p className="m-0 text-[12px] text-[var(--color-warn)]">error: {error}</p>
      </Card>
    )
  }

  const walletBalance = position?.balance ?? 0n
  const lpStacAtom = lpExposure.stacsolAtom
  const totalStacHolding = walletBalance + lpStacAtom

  if (totalStacHolding === 0n && lpExposure.totalValueInSol === 0) {
    return (
      <Card title="Your position">
        <p className="m-0 text-[12px] text-[var(--color-dim)]">
          no stacSOL in this wallet — mint below to take a position.
        </p>
      </Card>
    )
  }

  // Net SOL the user has actually paid in (mints) minus received (burns).
  //
  // Prefer the indexer's grossSolIn / grossSolOut (parsed from on-chain
  // DepositSol / WithdrawSol ix amounts) over the wallet's tx-delta walk.
  // The ATA walk in fetchPosition() can't distinguish the DepositSol
  // amount from any Jupiter zap-in swaps, jito tips, or compute-budget
  // fees that were bundled into the same tx (common for /liquidity and
  // /singlesided flows), so it tends to overstate cost basis by a few
  // tenths of a percent. The leaderboard uses the same indexer numbers,
  // so this keeps both surfaces showing the same P&L.
  //
  // Fall back to the on-chain walk only when the indexer hasn't seen this
  // wallet yet (e.g. fresh mint less than ~1 cron tick old).
  const txTotalSolIn = position?.totalSolIn ?? 0n
  const txTotalSolOut = position?.totalSolOut ?? 0n
  const indexedSolIn = holderRow ? BigInt(holderRow.grossSolIn) : null
  const indexedSolOut = holderRow ? BigInt(holderRow.grossSolOut) : null
  const totalSolIn = indexedSolIn ?? txTotalSolIn
  const totalSolOut = indexedSolOut ?? txTotalSolOut
  const netSolPaidLamports =
    totalSolIn > totalSolOut ? totalSolIn - totalSolOut : 0n
  const netSolPaid = Number(netSolPaidLamports) / LAMPORTS_PER_SOL
  const costBasisSource: 'indexed' | 'on-chain walk' =
    indexedSolIn != null ? 'indexed' : 'on-chain walk'

  // Two close-value numbers — the headline P&L tracks the burn-net one
  // because that's the actual cash a user receives if they hit Burn right
  // now. Previously we showed mark-to-NAV (gross) which understated losses
  // by ~6.9% and led to "huh, I thought I'd get more SOL than this" when
  // the wallet popup quoted the real payout.
  //
  //   walletNavValue   = wallet stacSOL × NAV                     (gross)
  //   walletBurnValue  = wallet stacSOL × NAV × 0.931             (net of burn fee)
  //   totalCloseGross  = walletNavValue  + lpExposure.totalValueInSol
  //   totalCloseBurn   = walletBurnValue + lpExposure.totalValueInSol
  //
  // We DON'T discount LP-side value by 0.931 because LPs withdraw via
  // Meteora/Raydium (no stake-pool burn fee on the way out). The 6.9%
  // only applies to wallet stacSOL going through WithdrawSol.
  const navLoading = currentRate == null
  const walletSolValue =
    !navLoading
      ? (Number(walletBalance) / Math.pow(10, 9)) * currentRate!
      : null
  const walletBurnValueSol =
    walletSolValue != null ? walletSolValue * BURN_PAYOUT : null
  const totalCloseGrossSol =
    walletSolValue != null
      ? walletSolValue + lpExposure.totalValueInSol
      : null
  const totalCloseBurnSol =
    walletBurnValueSol != null
      ? walletBurnValueSol + lpExposure.totalValueInSol
      : null

  // Headline P&L MUST match the leaderboard exactly. The leaderboard
  // surfaces holder_summary.pnl_sol, which is computed in SQL from
  // indexer-tracked stacSOL holdings + transferred-out passthrough
  // adjustments + gross_sol_out − gross_sol_in. If we recompute locally
  // here using walletBalance × NAV × 0.931 + lpExposure.totalValueInSol,
  // we'll diverge in two systematic ways:
  //   1. lpExposure includes the *paired-token side* of LP positions
  //      (e.g. FOMOX402 sitting alongside stacSOL in a Raydium CP pool).
  //      The leaderboard doesn't credit that — only stacSOL value.
  //   2. The leaderboard credits transferred-out stacSOL that wasn't pure
  //      referral pass-through. We don't surface transferred-out at all
  //      in the local math.
  // So when the indexer has a row for this wallet, use its pnlSol /
  // pnlPct directly. Fall back to the local close-value math only as a
  // bridge for wallets the indexer hasn't seen yet (fresh mints).
  const hasCostBasis = netSolPaidLamports > 0n
  const pnlSol =
    holderRow != null
      ? holderRow.pnlSol
      : hasCostBasis && totalCloseBurnSol != null
      ? totalCloseBurnSol - netSolPaid
      : null
  const pnlPct =
    holderRow != null
      ? holderRow.pnlPct
      : pnlSol != null && netSolPaid > 0
      ? pnlSol / netSolPaid
      : null
  const profitable = pnlSol != null && pnlSol >= 0
  const pnlColor =
    pnlSol == null
      ? 'text-[var(--color-fg)]'
      : profitable
      ? 'text-[var(--color-green)]'
      : 'text-[var(--color-warn)]'
  const pnlPrefix = pnlSol == null ? '' : pnlSol >= 0 ? '+' : '−'
  const pnlAbs = pnlSol == null ? null : Math.abs(pnlSol)

  return (
    <Card title="Your position">
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Cell label="stacSOL claim">
          <FlashOnChange value={totalStacHolding.toString()}>
            <strong className="text-2xl text-[var(--color-fg)]">{fmtAmount(totalStacHolding)}</strong>
          </FlashOnChange>
          <span className="text-xs text-[var(--color-dim)] ml-1">stacSOL</span>
          <div className="text-[11px] text-[var(--color-dim)] mt-1">
            wallet {fmtAmount(walletBalance)}
            {lpStacAtom > 0n
              ? ` · in LPs ${fmtAmount(lpStacAtom)}`
              : ''}
          </div>
        </Cell>
        <Cell label="Net SOL paid">
          <strong className="text-2xl text-[var(--color-fg)]">
            {fmtSolNum(netSolPaid)}
          </strong>
          <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
          <div className="text-[11px] text-[var(--color-dim)] mt-1">
            in {fmtSol(totalSolIn)} · out {fmtSol(totalSolOut)}
            {position
              ? ` · ${position.mintCount + position.burnCount} on-site flows*`
              : ''}
            <br />
            cost basis: {costBasisSource}
            {costBasisSource === 'on-chain walk'
              ? ' (waiting for indexer)'
              : ' — matches leaderboard'}
          </div>
        </Cell>
        <Cell label="Burn payout (net)">
          {totalCloseBurnSol != null &&
          walletBurnValueSol != null &&
          totalCloseGrossSol != null &&
          walletSolValue != null ? (
            <>
              <FlashOnChange value={totalCloseBurnSol.toFixed(6)}>
                <strong className="text-2xl text-[var(--color-fg)]">
                  {fmtSolNum(totalCloseBurnSol)}
                </strong>
              </FlashOnChange>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                wallet burn{' '}
                <span className="text-[var(--color-fg)]">
                  {fmtSolNum(walletBurnValueSol)}
                </span>
                {lpExposure.totalValueInSol > 0
                  ? ` · LPs ${fmtSolNum(lpExposure.totalValueInSol)}`
                  : ''}
                <br />
                gross @ NAV {fmtSolNum(totalCloseGrossSol)} (before 6.9% burn fee)
              </div>
            </>
          ) : (
            <>
              <strong className="text-2xl text-[var(--color-dim)]">…</strong>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                waiting for NAV — don&apos;t panic
              </div>
            </>
          )}
        </Cell>
        <Cell label="P&amp;L on burn">
          {navLoading ? (
            <>
              <strong className="text-2xl text-[var(--color-dim)]">…</strong>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                computing — NAV loading
              </div>
            </>
          ) : (
            <>
              <FlashOnChange value={pnlSol == null ? '—' : pnlSol.toFixed(6)}>
                <strong className={`text-2xl ${pnlColor}`}>
                  {pnlSol == null ? '—' : `${pnlPrefix}${fmtSolNum(pnlAbs!)}`}
                </strong>
              </FlashOnChange>
              <span className="text-xs text-[var(--color-dim)] ml-1">SOL</span>
              <div className="text-[11px] text-[var(--color-dim)] mt-1">
                {pnlPct != null
                  ? `${(pnlPct * 100).toFixed(2)}% vs net SOL paid (after 6.9% burn fee)`
                  : hasCostBasis
                  ? 'computing…'
                  : 'no cost basis'}
              </div>
              {/*
                Referral / manager-fee attribution. Mirrors the leaderboard's
                "of which X came free" beat. The earned value is ALREADY in the
                P&L number above (it's in the wallet balance × NAV), but
                surfacing it as a separate line answers the "where did my
                referral earnings show up?" question without double-counting.
              */}
              {holderRow != null &&
                holderRow.earnedSol != null &&
                holderRow.earnedSol > 0 && (
                  <div className="text-[11px] text-[var(--color-ember)] mt-0.5">
                    of which free: +{fmtSolNum(holderRow.earnedSol)} SOL{' '}
                    <span className="text-[var(--color-dim)] normal-case">
                      (referral / manager-fee credits — already counted above)
                    </span>
                  </div>
                )}
            </>
          )}
        </Cell>
      </div>

      <TrancheBreakdown
        tranches={position?.mintTranches ?? []}
        currentRate={currentRate}
        netSolPaidLamports={netSolPaidLamports}
        totalStacAtom={totalStacHolding}
      />

      {lpExposure.breakdown.length > 0 && (
        <div className="text-[11px] text-[var(--color-dim)] bg-[var(--color-bg)] rounded p-2 mb-3 space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] mb-1">
            LP positions ({lpExposure.breakdown.length})
          </div>
          {lpExposure.breakdown.map((b, i) => (
            <div key={`${b.poolId}-${i}`} className="flex items-center justify-between gap-2">
              <span className="text-[var(--color-fg)] truncate">
                {b.source === 'meteora-dlmm' ? '◆' : '○'} {b.pairLabel}
              </span>
              <span className="font-mono text-[var(--color-dim)] shrink-0">
                {b.stacsolUi.toFixed(4)} stac + {b.otherUi.toLocaleString(undefined, { maximumFractionDigits: 4 })} {b.otherSymbol} ≈ {fmtSolNum(b.valueInSol)} SOL
              </span>
            </div>
          ))}
          <div className="pt-1.5 mt-1 border-t border-[rgb(255_34_0_/_0.12)] text-[10px] leading-relaxed">
            <span className="text-[var(--color-green)]">earning:</span> NAV
            climbs against every stacSOL above — wallet AND LP — so yield
            accrues on the full holding. The LP side just delays when you can
            redeem it via burn (withdraw the LP first).{' '}
            <span className="text-[var(--color-warn)]">IL risk:</span> the
            paired token in each LP moves on its own. If it dumps or goes to
            0, that position is fcukered regardless of how much the
            stacSOL/SOL rate climbed in the meantime.
          </div>
        </div>
      )}

      <p className="m-0 text-[10px] text-[var(--color-dim)] leading-relaxed">
        * "On-site flows" counts every wallet tx where SOL and stacSOL moved
        in opposite directions. This includes Jupiter zap-swaps from{' '}
        <code className="text-[var(--color-fg)]">/liquidity</code> and{' '}
        <code className="text-[var(--color-fg)]">/singlesided</code> alongside
        actual protocol mints/burns — they're indistinguishable from a wallet
        tx-history scan alone. The "Net SOL paid" + "Total close value" + P&amp;L
        are still correct since they're balance-difference based.
      </p>

      <p className="mt-3 text-[10px] text-[var(--color-dim)] flex items-center gap-2">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-hot)] animate-pulse" />
        live · balance polled every 10s · LPs every 30s · last tick {fmtAgo(lastBalanceTickAt)}
      </p>
    </Card>
  )
}

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-[var(--color-bg)] rounded p-3">
      <div className="text-[11px] uppercase tracking-wider text-[var(--color-dim)]">{label}</div>
      {children}
    </div>
  )
}

/**
 * Wraps a child element with a brief flash animation whenever the rendered
 * `value` (a stable string key) changes. We re-mount via `key` so the
 * animation re-runs without manual state plumbing.
 */
function FlashOnChange({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <span key={value} className="inline-block animate-[flash_0.7s_ease-out]">
      {children}
    </span>
  )
}

interface NavSnapshot {
  ts: number
  rate: number
}

/**
 * Per-tranche cost-basis breakdown. Collapsed by default — it's a deep
 * cell that most users won't open, and computing the per-tranche P&L
 * requires NAV which only renders cleanly once `currentRate != null`.
 *
 * The "time to recoup" estimate for underwater tranches uses the real
 * NAV velocity computed from `/api/history` (oldest snapshot in the
 * window vs newest). With ~60h since deploy this is a few SOL/stacSOL/day
 * and translates the residual SOL gap to a calendar estimate. The number
 * is a rough projection — NAV climb is jagged on epoch boundaries — but
 * good enough to answer "weeks vs months". When NAV is flat / negative
 * over the window we render `—` instead of an infinity.
 */
function TrancheBreakdown({
  tranches,
  currentRate,
  netSolPaidLamports,
  totalStacAtom,
}: {
  tranches: MintTranche[]
  currentRate: number | null
  netSolPaidLamports: bigint
  totalStacAtom: bigint
}) {
  const [open, setOpen] = useState(false)
  const [navHistory, setNavHistory] = useState<NavSnapshot[] | null>(null)

  // Lazy fetch history when first opened. /api/history is cheap (cached
  // edge-side) but no point loading it for users who never expand.
  useEffect(() => {
    if (!open || navHistory != null) return
    let cancelled = false
    fetch('/api/history?limit=500')
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        if (cancelled) return
        if (Array.isArray(rows)) {
          const cleaned = rows
            .map((row: { ts: number; rate: number }) => ({
              ts: Number(row.ts),
              rate: Number(row.rate),
            }))
            .filter((s) => Number.isFinite(s.rate) && Number.isFinite(s.ts))
            .sort((a, b) => a.ts - b.ts)
          setNavHistory(cleaned)
        } else {
          setNavHistory([])
        }
      })
      .catch(() => {
        if (!cancelled) setNavHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [open, navHistory])

  // NAV velocity in SOL/stacSOL per millisecond (i.e., NAV rises by this
  // much per ms on average). Computed from oldest valid snapshot in the
  // last ~24h vs newest. Returns null when not enough data or when NAV
  // didn't climb (defensive — pool only goes up over reasonable windows).
  const navVelocityPerMs = useMemo(() => {
    if (!navHistory || navHistory.length < 2) return null
    const newest = navHistory[navHistory.length - 1]
    // Look back ~24h or as far as we have.
    const lookbackMs = 24 * 60 * 60 * 1000
    const target = newest.ts - lookbackMs
    let oldest = navHistory[0]
    for (const s of navHistory) {
      if (s.ts >= target) {
        oldest = s
        break
      }
    }
    const dt = newest.ts - oldest.ts
    if (dt <= 0) return null
    const dr = newest.rate - oldest.rate
    if (!Number.isFinite(dr) || dr <= 0) return null
    return dr / dt
  }, [navHistory])

  if (tranches.length === 0) return null

  const totalStacUi = Number(totalStacAtom) / 1e9
  const netSolPaidSol = Number(netSolPaidLamports) / LAMPORTS_PER_SOL
  // Aggregate break-even NAV — what NAV would have to be for a burn-now to
  // exactly recoup the user's net SOL paid in. Defined only when the user
  // currently holds stacSOL AND has a positive cost basis.
  const aggregateBreakeven =
    totalStacUi > 0 && netSolPaidSol > 0
      ? netSolPaidSol / (totalStacUi * BURN_PAYOUT)
      : null

  // Worst per-tranche break-even (highest cost basis tranche). Useful to
  // show "your last mint near top of NAV needs N more SOL/stac to repair."
  const trancheBreakevens = tranches.map((t) => {
    const breakeven =
      Number(t.stacOut) > 0
        ? Number(t.solIn) / Number(t.stacOut) / BURN_PAYOUT
        : null
    return { tranche: t, breakeven }
  })
  const worstBreakeven = trancheBreakevens.reduce<number | null>(
    (acc, x) => (x.breakeven == null ? acc : acc == null ? x.breakeven : Math.max(acc, x.breakeven)),
    null,
  )

  const distToAggregate =
    currentRate != null && aggregateBreakeven != null
      ? aggregateBreakeven - currentRate
      : null
  const distToWorst =
    currentRate != null && worstBreakeven != null
      ? worstBreakeven - currentRate
      : null

  // Time-to-recoup for the worst (highest break-even) tranche. Only shown
  // when the worst tranche is currently underwater.
  const timeToWorstRecoupMs =
    distToWorst != null && distToWorst > 0 && navVelocityPerMs != null
      ? distToWorst / navVelocityPerMs
      : null

  const fmtRate = (r: number | null) =>
    r == null ? '—' : r.toFixed(6)
  const fmtDist = (d: number | null) => {
    if (d == null) return '—'
    if (d <= 0) return `+${(-d).toFixed(6)} above`
    return `−${d.toFixed(6)} below`
  }
  const fmtDuration = (ms: number | null) => {
    if (ms == null) return '—'
    if (!Number.isFinite(ms) || ms <= 0) return '—'
    const sec = ms / 1000
    if (sec < 3600) return `${Math.round(sec / 60)}m`
    if (sec < 86_400) return `${(sec / 3600).toFixed(1)}h`
    if (sec < 86_400 * 30) return `${(sec / 86_400).toFixed(1)}d`
    if (sec < 86_400 * 365) return `${(sec / 86_400 / 30).toFixed(1)}mo`
    return `${(sec / 86_400 / 365).toFixed(1)}y`
  }

  const fmtTrancheTs = (ts: number) => {
    const d = new Date(ts)
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`
  }

  return (
    <div className="mb-3 rounded border border-[rgb(255_34_0_/_0.12)] bg-[var(--color-bg)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[rgb(255_34_0_/_0.04)] transition"
        aria-expanded={open}
      >
        <span className="text-[10px] uppercase tracking-[2px] text-[var(--color-ember)] font-black">
          {open ? '▾' : '▸'} per-tranche cost basis ({tranches.length}{' '}
          {tranches.length === 1 ? 'mint' : 'mints'})
        </span>
        <span className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
          {aggregateBreakeven != null ? (
            <>
              break-even{' '}
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {fmtRate(aggregateBreakeven)}
              </span>
            </>
          ) : (
            <>no cost basis</>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-[rgb(255_34_0_/_0.12)] p-3">
          {/* Headline summary cells */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3 text-[11px]">
            <div className="bg-[var(--color-bg2)] rounded p-2">
              <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
                aggregate break-even NAV
              </div>
              <div className="font-mono font-black text-[var(--color-fg)] text-base">
                {fmtRate(aggregateBreakeven)}
              </div>
              <div className="text-[10px] text-[var(--color-dim)]">
                you net SOL once NAV ≥ this
              </div>
            </div>
            <div className="bg-[var(--color-bg2)] rounded p-2">
              <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
                vs current NAV
              </div>
              <div
                className={`font-mono font-black text-base ${
                  distToAggregate == null
                    ? 'text-[var(--color-dim)]'
                    : distToAggregate <= 0
                    ? 'text-[var(--color-green)]'
                    : 'text-[var(--color-warn)]'
                }`}
              >
                {fmtDist(distToAggregate)}
              </div>
              <div className="text-[10px] text-[var(--color-dim)]">
                NAV {fmtRate(currentRate)} · agg {fmtRate(aggregateBreakeven)}
              </div>
            </div>
            <div className="bg-[var(--color-bg2)] rounded p-2 col-span-2 sm:col-span-1">
              <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
                worst tranche · time to recoup
              </div>
              <div className="font-mono font-black text-[var(--color-fg)] text-base">
                {worstBreakeven == null ? '—' : fmtRate(worstBreakeven)}
              </div>
              <div className="text-[10px] text-[var(--color-dim)]">
                {distToWorst != null && distToWorst > 0
                  ? `${fmtDuration(timeToWorstRecoupMs)} at recent rate`
                  : worstBreakeven != null
                  ? 'already covered ✓'
                  : ''}
              </div>
            </div>
          </div>

          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[11px] tabular-mono">
              <thead>
                <tr className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
                  <th className="text-left pl-1 pr-2 py-1 font-black">time</th>
                  <th className="text-right px-2 py-1 font-black">SOL in</th>
                  <th className="text-right px-2 py-1 font-black">stac out</th>
                  <th className="text-right px-2 py-1 font-black">mint NAV</th>
                  <th className="text-right px-2 py-1 font-black">break-even</th>
                  <th className="text-right px-2 py-1 font-black">today P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {trancheBreakevens.map(({ tranche: t, breakeven }, i) => {
                  // Per-tranche today P&L = stacOut × NAV × 0.931 - solIn
                  // (in SOL). Underwater iff break-even > current NAV.
                  const stacOutUi = Number(t.stacOut) / 1e9
                  const solInUi = Number(t.solIn) / LAMPORTS_PER_SOL
                  const todayBurnNetSol =
                    currentRate != null ? stacOutUi * currentRate * BURN_PAYOUT : null
                  const todayPnl =
                    todayBurnNetSol != null ? todayBurnNetSol - solInUi : null
                  const underwater =
                    breakeven != null && currentRate != null && breakeven > currentRate
                  const pnlColor =
                    todayPnl == null
                      ? 'text-[var(--color-dim)]'
                      : todayPnl >= 0
                      ? 'text-[var(--color-green)]'
                      : 'text-[var(--color-warn)]'
                  return (
                    <tr
                      key={`${t.sig || 'tranche'}-${i}`}
                      className={
                        underwater
                          ? 'bg-[rgb(255_204_0_/_0.04)] border-b border-[rgb(255_34_0_/_0.06)]'
                          : 'border-b border-[rgb(255_34_0_/_0.06)]'
                      }
                    >
                      <td className="text-left pl-1 pr-2 py-1.5 text-[var(--color-dim)]">
                        {t.sig ? (
                          <a
                            href={`https://solscan.io/tx/${t.sig}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[var(--color-fg)] hover:text-[var(--color-hot)] no-underline"
                            title={t.sig}
                          >
                            {fmtTrancheTs(t.ts)}
                          </a>
                        ) : (
                          <span>{fmtTrancheTs(t.ts)}</span>
                        )}
                      </td>
                      <td className="text-right px-2 py-1.5 text-[var(--color-fg)]">
                        {solInUi.toFixed(4)}
                      </td>
                      <td className="text-right px-2 py-1.5 text-[var(--color-fg)]">
                        {stacOutUi.toFixed(4)}
                      </td>
                      <td className="text-right px-2 py-1.5 text-[var(--color-dim)]">
                        {t.impliedMintNav.toFixed(6)}
                      </td>
                      <td className="text-right px-2 py-1.5 text-[var(--color-dim)]">
                        {breakeven == null ? '—' : breakeven.toFixed(6)}
                      </td>
                      <td className={`text-right px-2 py-1.5 font-bold ${pnlColor}`}>
                        {todayPnl == null
                          ? '…'
                          : `${todayPnl >= 0 ? '+' : '−'}${Math.abs(todayPnl).toFixed(4)}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <p className="mt-3 m-0 text-[10px] text-[var(--color-dim)] leading-relaxed">
            Per-mint cost basis is balance-difference based — same
            heuristic as the headline cells, so Jupiter zap-swaps in
            /liquidity and /singlesided will show up here as &quot;mint&quot;
            rows. Break-even NAV ={' '}
            <code className="text-[var(--color-fg)]">
              solIn / (stacOut × 0.931)
            </code>
            . Time-to-recoup uses the last ~24h of NAV climb from{' '}
            <code className="text-[var(--color-fg)]">/api/history</code>; epoch
            boundaries make NAV climb in steps so the projection is a rough
            order-of-magnitude.
          </p>
        </div>
      )}
    </div>
  )
}
