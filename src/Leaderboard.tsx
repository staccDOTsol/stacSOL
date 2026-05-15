// Holders leaderboard page (mounted at /leaderboard).
//
// Backed by /api/holders-leaderboard which aggregates pool_events into a
// per-wallet `holder_summary` row, joined with on-chain stacSOL balances
// (wallet ATA + HawkFi userPda ATA). The cron ingester at
// /api/ingest-pool-events refreshes both. We refetch every 60s — the
// endpoint sets a 30s edge cache so this is cheap.
//
// This page is *separate* from src/components/Leaderboard.tsx (the
// referrers card on the homepage). They live in different folders + have
// different default exports so they can coexist without name collision.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { fmtAmount, shortPk } from './lib/format'
import { WalletIdentity, DoxxToggle } from './components/walletDoxx'
import EditorialNav from './components/EditorialNav'
import WalletPill from './components/WalletPill'

const REFRESH_MS = 60_000
const SEARCH_DEBOUNCE_MS = 250
const MARKETING_WALLET = 'Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j'

type OrderBy =
  | 'pnl_sol'
  | 'pnl_pct'
  | 'total_stac'
  | 'gross_sol_in'
  | 'first_event_at'
  | 'last_event_at'

interface HolderRow {
  rank: number
  wallet: string
  walletStacAtom: string
  hawkfiStacAtom: string
  totalStacAtom: string
  grossSolIn: string
  grossSolOut: string
  netSolIn: string
  pnlSol: number
  pnlPct: number | null
  breakevenNav: number | null
  burnNetSol: number
  mintCount: number
  burnCount: number
  referralEarnedAtom: string
  referralEarnedCount: number
  managerFeeEarnedAtom: string
  managerFeeEarnedCount: number
  earnedSol: number
  // Token-2022 transfer deltas inferred from balance vs accounted supply.
  // transferred_out: minted - burned + earned > current_balance → diff
  // transferred_in:  current_balance > minted - burned + earned → diff
  transferredOutAtom: string
  transferredInAtom: string
  transferredOutSol: number
  transferredInSol: number
  firstEventAt: number
  lastEventAt: number
  isMarketing: boolean
  // Doxx state from /api/holders-leaderboard. When false, the row renders
  // as a stable pseudonym; copy / solscan links are hidden so the real
  // address can't be lifted out of the markup either.
  isDoxxed: boolean
  displayName: string | null
}

interface HoldersLeaderboardResponse {
  rows: HolderRow[]
  totals: {
    holders: number
    totalStacAtom: string
    sumGrossIn: string
    sumEarnedAtom: string
    sumEarnedSol: number
    sumPnlSol: number
    sumPnlSolAdj: number
    avgPnlPct: number
    profitableCount: number
    underwaterCount: number
    /** profitable/underwater on paid trading only (no referral credit). */
    paidProfitableCount?: number
    paidUnderwaterCount?: number
  }
  rate: number | null
  asOf: number
  nextCursor: string | null
  my: HolderRow | null
}

// A wallet whose stacSOL came primarily from protocol earnings (referral
// or manager-fee credits, no SOL paid). When earned > 0 and either no
// SOL was deposited at all, or the earned SOL value beats their direct
// cost basis, we hide the "cost basis" column and show the P&L as a
// "free" gain — showing -X% on a referral-fee earner is misleading.
function isPureEarner(row: HolderRow): boolean {
  const earnedAtom = BigInt(row.referralEarnedAtom || '0') + BigInt(row.managerFeeEarnedAtom || '0')
  if (earnedAtom <= 0n) return false
  const grossIn = BigInt(row.grossSolIn || '0')
  return grossIn === 0n
}

function isMixedEarner(row: HolderRow): boolean {
  const earnedAtom = BigInt(row.referralEarnedAtom || '0') + BigInt(row.managerFeeEarnedAtom || '0')
  return earnedAtom > 0n && BigInt(row.grossSolIn || '0') > 0n
}

// Threshold for "meaningful" transfer activity — ignore dust deltas that
// come from rounding / off-by-one between the indexer's expected supply
// and the live on-chain balance. 0.001 stacSOL = 1e6 atoms.
const TRANSFER_DUST = 1_000_000n

function hasTransferredOut(row: HolderRow): boolean {
  try {
    return BigInt(row.transferredOutAtom || '0') >= TRANSFER_DUST
  } catch {
    return false
  }
}

function hasTransferredIn(row: HolderRow): boolean {
  try {
    return BigInt(row.transferredInAtom || '0') >= TRANSFER_DUST
  } catch {
    return false
  }
}

// The display P&L is just `pnl_sol` from the ingester.
//
// IMPORTANT — this used to return `pnlSol + earnedSol`. That double-counted
// referral / manager-fee credits, because the ingester's `pnl_sol` formula
// already values them via `total_stac_atom × NAV × 0.931` (for still-held
// kickbacks) and via `gross_sol_out_lamports` (for burned kickbacks). Adding
// `earned_sol` again inflated the headline by exactly the SOL value of
// every referral kickback the wallet had received — making the leaderboard
// promise users SOL they would never see on withdraw.
//
// We now show `pnlSol` as the headline and surface `earnedSol` only as an
// attribution sub-label ("of which X came free"). This matches what users
// actually receive when they burn.
function adjustedPnl(row: HolderRow): number {
  return row.pnlSol
}

// ROI on lifetime invested capital (grossSolIn), not on "net at risk
// right now" (netSolIn). The API's `row.pnlPct = pnlSol / netSolIn` made
// active churners look catastrophic (e.g. someone who'd minted 66 SOL and
// burned back 63 SOL looked like −96% — because the denominator was the
// tiny 3 SOL residual). Lifetime ROI on grossSolIn matches user intuition:
// "how did my paid trading lifecycle do?" → realized + unrealized over
// total ever deposited.
//
// Returns null when grossSolIn is 0 (pure earner — no paid base exists).
function roiPctOnGross(row: HolderRow): number | null {
  const grossIn = Number(BigInt(row.grossSolIn || '0')) / LAMPORTS_PER_SOL
  if (grossIn <= 0) return null
  return row.pnlSol / grossIn
}

// breakevenNav from the API can be wildly above current NAV (or negative)
// for wallets that have churned heavily. When it's >50× current NAV it
// represents "would need NAV to moon 50× for your paid cost basis to
// recoup" — algebraically right, practically irrelevant. Hide in those
// cases instead of showing a misleading number.
function breakevenDisplay(row: HolderRow, currentRate: number | null): string {
  if (row.breakevenNav == null) return '—'
  if (row.breakevenNav < 0) return '—'
  if (currentRate != null && row.breakevenNav > currentRate * 20) return 'far'
  return row.breakevenNav.toFixed(6)
}

interface ColumnSpec {
  key: OrderBy
  label: string
  align?: 'left' | 'right'
  hideOnMobile?: boolean
  hint?: string
}

const COLUMNS: ColumnSpec[] = [
  {
    key: 'total_stac',
    label: 'stacSOL held',
    align: 'right',
    hint: 'Current on-chain stacSOL balance (wallet ATA + HawkFi userPda ATA, summed).',
  },
  {
    key: 'gross_sol_in',
    label: 'cost basis',
    align: 'right',
    hint: 'Lifetime SOL ever paid to the mint flow on this wallet. Not netted against burns.',
  },
  {
    key: 'pnl_sol',
    label: 'P&L SOL',
    align: 'right',
    hint:
      'P&L in SOL: (held × 0.931 × NAV) + lifetime burn payouts − lifetime SOL paid in. This is what a wallet would actually realize if it burned right now — referral / manager-fee kickbacks are already in `held` (they were paid as stacSOL into the ATA), so they show up here without needing to be added separately.',
  },
  {
    key: 'pnl_pct',
    label: 'P&L %',
    align: 'right',
    hint:
      'Lifetime ROI on paid SOL only (pnl_sol ÷ total SOL ever deposited). Does NOT include referral credits — those show as +earned in the SOL column.',
  },
  {
    key: 'first_event_at',
    label: 'first',
    align: 'right',
    hideOnMobile: true,
    hint: 'Time since this wallet first interacted with the protocol.',
  },
  {
    key: 'last_event_at',
    label: 'last',
    align: 'right',
    hideOnMobile: true,
    hint: 'Time since this wallet last minted, burned, or earned a credit.',
  },
]

const fmtSolNum = (lamports: bigint | string | number) => {
  const big =
    typeof lamports === 'bigint'
      ? lamports
      : typeof lamports === 'string'
      ? BigInt(lamports || '0')
      : BigInt(Math.round(lamports))
  return (Number(big) / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
  })
}

const fmtSolFloat = (sol: number) =>
  sol.toLocaleString(undefined, {
    maximumFractionDigits: 4,
    minimumFractionDigits: 4,
  })

function fmtRel(ms: number): string {
  if (!ms) return '—'
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86_400)}d`
}

export default function HoldersLeaderboard() {
  const { publicKey } = useWallet()
  const myPk = publicKey?.toBase58() ?? null

  // Opt this surface into the editorial design (ivory/jade body, sticky nav).
  // The page's Tailwind utilities reference --color-bg / --color-hot etc.,
  // which get remapped onto editorial tokens by index.css.
  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  const [rows, setRows] = useState<HolderRow[]>([])
  const [meta, setMeta] = useState<HoldersLeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const [orderBy, setOrderBy] = useState<OrderBy>('total_stac')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [hideUnderwater, setHideUnderwater] = useState(false)
  const [hideMarketing, setHideMarketing] = useState(false)
  const [minStac, setMinStac] = useState(0)

  // Bumped after a successful doxx / undoxx so the table immediately
  // re-fetches and the row swaps render state without waiting for the
  // 60s polling tick.
  const [refreshTick, setRefreshTick] = useState(0)
  const onDoxxChanged = useCallback(() => setRefreshTick((t) => t + 1), [])

  // Debounce search input -> effective query.
  useEffect(() => {
    const id = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [searchInput])

  const buildQuery = useCallback(
    (cursor: string | null) => {
      const params = new URLSearchParams()
      params.set('orderBy', orderBy)
      params.set('dir', dir)
      params.set('limit', '50')
      if (search) params.set('search', search)
      if (hideUnderwater) params.set('hideUnderwater', 'true')
      if (hideMarketing) params.set('hideMarketing', 'true')
      if (minStac > 0) params.set('minStac', String(minStac))
      if (cursor) params.set('cursor', cursor)
      if (myPk) params.set('my', myPk)
      return `/api/holders-leaderboard?${params.toString()}`
    },
    [orderBy, dir, search, hideUnderwater, hideMarketing, minStac, myPk],
  )

  // Reset on filter / sort change.
  useEffect(() => {
    let cancelled = false
    const fetchInitial = async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await fetch(buildQuery(null))
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const json = (await r.json()) as HoldersLeaderboardResponse
        if (cancelled) return
        setRows(json.rows)
        setMeta(json)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchInitial()
    return () => {
      cancelled = true
    }
  }, [buildQuery, refreshTick])

  // Periodic refresh (top page only) — never hijack the user's pagination.
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const r = await fetch(buildQuery(null))
        if (!r.ok) return
        const json = (await r.json()) as HoldersLeaderboardResponse
        // Only replace if we're on the first page (no extra rows from
        // load-more). Otherwise just refresh totals + my row.
        if (rows.length <= 50) {
          setRows(json.rows)
        }
        setMeta((prev) => ({
          ...(prev as HoldersLeaderboardResponse),
          ...json,
          rows: rows.length <= 50 ? json.rows : (prev as HoldersLeaderboardResponse).rows,
        }))
      } catch {
        /* swallow — next tick will retry */
      }
    }, REFRESH_MS)
    return () => clearInterval(id)
  }, [buildQuery, rows.length])

  const loadMore = useCallback(async () => {
    if (!meta?.nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const r = await fetch(buildQuery(meta.nextCursor))
      if (!r.ok) return
      const json = (await r.json()) as HoldersLeaderboardResponse
      setRows((prev) => [...prev, ...json.rows])
      setMeta((prev) =>
        prev
          ? {
              ...prev,
              nextCursor: json.nextCursor,
              totals: json.totals,
              rate: json.rate,
              asOf: json.asOf,
              my: json.my ?? prev.my,
            }
          : json,
      )
    } finally {
      setLoadingMore(false)
    }
  }, [buildQuery, meta?.nextCursor, loadingMore])

  // Infinite scroll: trigger loadMore when the sentinel becomes visible.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !meta?.nextCursor) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore()
      },
      { rootMargin: '256px' },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [loadMore, meta?.nextCursor])

  const onColumnClick = useCallback(
    (col: OrderBy) => {
      if (col === orderBy) {
        setDir((d) => (d === 'desc' ? 'asc' : 'desc'))
      } else {
        setOrderBy(col)
        setDir('desc')
      }
    },
    [orderBy],
  )

  const myRow = meta?.my ?? null

  const copy = async (pk: string) => {
    try {
      await navigator.clipboard.writeText(pk)
      setCopiedKey(pk)
      setTimeout(() => setCopiedKey((k) => (k === pk ? null : k)), 1500)
    } catch {
      /* ignore */
    }
  }

  const stickyTotal = useMemo(() => {
    if (!meta) return null
    const totalStacUi = Number(BigInt(meta.totals.totalStacAtom)) / 1e9
    const sumIn = Number(BigInt(meta.totals.sumGrossIn)) / LAMPORTS_PER_SOL
    const sumEarnedStac =
      Number(BigInt(meta.totals.sumEarnedAtom || '0')) / 1e9
    // Real economic state: what the protocol would pay out if every holder
    // burned right now. burn_net_per_token = balance × (1 - 0.069) × NAV.
    const rate = meta.rate ?? 0
    const burnValueIfAllRedeem = totalStacUi * 0.931 * rate
    // Derive sumGrossOut from the identity:
    //   sumPnlSol = sumBurnNetSol + sumGrossOut − sumGrossIn
    // where sumBurnNetSol = totalStacUi × 0.931 × rate (= burnValueIfAllRedeem).
    // This avoids needing a new API field.
    const sumOut = meta.totals.sumPnlSol + sumIn - burnValueIfAllRedeem
    return {
      totalStacUi,
      sumIn,
      sumOut: Math.max(0, sumOut),
      sumEarnedStac,
      burnValueIfAllRedeem,
    }
  }, [meta])

  return (
    <>
      <EditorialNav pathname="/leaderboard" ctaSlot={<WalletPill />} />
      <div className="max-w-[1080px] mx-auto px-4 py-6">

      <h1 className="m-0 mb-2 text-5xl font-black tracking-[-0.05em] text-[var(--color-hot)]">
        holders leaderboard
      </h1>
      <div className="mb-6 flex items-center gap-3">
        <span className="inline-block w-6 h-[2px] bg-[var(--color-hot)]" />
        <p className="m-0 text-[var(--color-ember)] uppercase tracking-[6px] text-xs font-black">
          who paid · who waits · who burns
        </p>
        <span className="inline-block w-6 h-[2px] bg-[var(--color-hot)]" />
      </div>

      {/* Totals strip — protocol economic state.
          Avoids the "earned (free)" alarm number which was misleading:
          referral stacSOL is a *slice* of the held supply, not extra value
          floating on top. Show the real metric: what the protocol would
          pay out if every holder redeemed right now, and the SOL in vs
          SOL out flow. */}
      {meta && stickyTotal && (
        <div className="mb-4 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
          <span>
            <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
              {meta.totals.holders.toLocaleString()}
            </span>{' '}
            wallets
          </span>
          <span>
            <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
              {stickyTotal.totalStacUi.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            </span>{' '}
            stac held
          </span>
          <span title="Cumulative SOL ever deposited via mint, across all wallets.">
            <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
              {stickyTotal.sumIn.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            </span>{' '}
            SOL in
            <span className="ml-0.5 cursor-help opacity-60">ⓘ</span>
          </span>
          <span title="Cumulative SOL ever withdrawn via burn, across all wallets. Derived from sumPnlSol identity (burnValue + sumOut − sumIn = sumPnl).">
            <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
              {stickyTotal.sumOut.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}
            </span>{' '}
            SOL out
            <span className="ml-0.5 cursor-help opacity-60">ⓘ</span>
          </span>
          {meta.rate != null && (
            <span title="What the protocol would pay out IF every holder burned every stacSOL right now, at current NAV, after the 6.9% Token-2022 transfer fee. Compare to on-chain backing (Pool card on the home page) to see solvency.">
              <span className="text-[var(--color-green)] font-mono normal-case tracking-normal">
                {stickyTotal.burnValueIfAllRedeem.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </span>{' '}
              burn value
              <span className="ml-0.5 cursor-help opacity-60">ⓘ</span>
            </span>
          )}
          {/* Up/down chip pair — show both bases so the referral-attribution
              lift is visible. "paid only" = pnl on actual mints/burns; "adj"
              = paid + value of referral kickbacks. */}
          {(() => {
            const paidUp = meta.totals.paidProfitableCount
            const paidDown = meta.totals.paidUnderwaterCount
            const adjUp = meta.totals.profitableCount
            const adjDown = meta.totals.underwaterCount
            return (
              <>
                {paidUp != null && paidDown != null && (
                  <span
                    title="Paid trading only: wallets whose own SOL in / SOL out (no referral credits) is positive vs negative. This is your trading-skill split."
                  >
                    <span className="text-[var(--color-dim)] mr-1">paid:</span>
                    <span className="text-[var(--color-green)] font-mono normal-case tracking-normal">
                      {paidUp}
                    </span>
                    <span className="text-[var(--color-dim)] mx-0.5">/</span>
                    <span className="text-[var(--color-warn)] font-mono normal-case tracking-normal">
                      {paidDown}
                    </span>
                    <span className="ml-1 cursor-help opacity-60">ⓘ</span>
                  </span>
                )}
                <span
                  title="Adjusted: paid P&L plus the current-NAV value of any stacSOL credited via referrals. Wallets lifted into profit by referral kickbacks alone show up positive here even if their paid trading lost money."
                >
                  <span className="text-[var(--color-dim)] mr-1">adj:</span>
                  <span className="text-[var(--color-green)] font-mono normal-case tracking-normal">
                    {adjUp}
                  </span>
                  <span className="text-[var(--color-dim)] mx-0.5">/</span>
                  <span className="text-[var(--color-warn)] font-mono normal-case tracking-normal">
                    {adjDown}
                  </span>
                  <span className="ml-1 cursor-help opacity-60">ⓘ</span>
                </span>
              </>
            )
          })()}
          {meta.rate != null && (
            <span>
              NAV{' '}
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {meta.rate.toFixed(6)}
              </span>
            </span>
          )}
          {meta.totals.sumEarnedSol > 0 && (
            <span
              className="opacity-60"
              title="Referral attribution: SOL value (at current NAV) of stacSOL ever credited via the 50/50 referral + manager-fee split of the 6.9% deposit fee. This is a SUBSET of the held supply, not additional value. Counting it would double-count what's already in 'burn value' above."
            >
              <span className="font-mono normal-case tracking-normal">
                {fmtSolFloat(meta.totals.sumEarnedSol)}
              </span>{' '}
              ref attr
              <span className="ml-0.5 cursor-help opacity-80">ⓘ</span>
            </span>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="search wallet (substring)"
          className="flex-1 min-w-[220px] px-3 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[var(--color-bg)] text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-dim)] focus:outline-none focus:border-[var(--color-hot)]"
        />
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] cursor-pointer">
          <input
            type="checkbox"
            checked={hideUnderwater}
            onChange={(e) => setHideUnderwater(e.target.checked)}
            className="accent-[var(--color-hot)]"
          />
          hide underwater
        </label>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] cursor-pointer">
          <input
            type="checkbox"
            checked={hideMarketing}
            onChange={(e) => setHideMarketing(e.target.checked)}
            className="accent-[var(--color-hot)]"
          />
          hide marketing
        </label>
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
          min stac
          <input
            type="number"
            min={0}
            step={0.1}
            value={minStac || ''}
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              setMinStac(Number.isFinite(v) && v > 0 ? v : 0)
            }}
            placeholder="0"
            className="w-20 px-2 py-1 rounded border border-[rgb(255_34_0_/_0.4)] bg-[var(--color-bg)] text-[12px] text-[var(--color-fg)] placeholder:text-[var(--color-dim)] focus:outline-none focus:border-[var(--color-hot)]"
          />
        </label>
      </div>

      {/* "You" sticky row.
          Three display modes:
          - pure earner: no SOL paid → show only the "free" earned column
          - mixed earner: paid AND earned → SPLIT into paid / earned / combined
            beats. The naive single-line render put pnl_pct (paid-base) next
            to adjustedPnl (combined) which read as a contradiction; this
            splits them so each number is on its own base.
          - plain holder: just pnl + pnl_pct
      */}
      {myPk && myRow && (() => {
        const myPure = isPureEarner(myRow)
        const myMixed = isMixedEarner(myRow)
        const myAdj = adjustedPnl(myRow)
        const paidPnl = myRow.pnlSol
        const earnedSol = myRow.earnedSol || 0
        const adjColor = myPure || myAdj >= 0
          ? 'text-[var(--color-green)]'
          : 'text-[var(--color-warn)]'
        const paidColor = paidPnl >= 0
          ? 'text-[var(--color-green)]'
          : 'text-[var(--color-warn)]'
        return (
          <div className="mb-3 px-3 py-2 rounded border border-[rgb(255_119_51_/_0.5)] bg-[rgb(255_119_51_/_0.08)] sticky top-2 z-10 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
              <div className="flex items-center gap-2">
                <span className="text-[var(--color-ember)] font-black">
                  #{myRow.rank}
                </span>
                {/* WalletIdentity respects isDoxxed even for the own row.
                    By default it renders the anonymous pseudonym (with a
                    "you" badge) so a screenshot of this banner doesn't
                    expose the user's address. Only after the user opts in
                    via the DoxxToggle below does the real shortPk + copy
                    + solscan link render here. */}
                <WalletIdentity
                  row={myRow}
                  isMe
                  copy={(t) => navigator.clipboard.writeText(t)}
                  copiedKey={null}
                />
                {(myPure || myMixed) && (
                  <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-green)] text-[var(--color-green)] bg-[rgb(0_180_0_/_0.08)]">
                    earned
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--color-dim)] font-mono">
                <span>{fmtAmount(BigInt(myRow.totalStacAtom))} stac</span>

                {myPure ? (
                  /* received stacSOL with zero SOL paid → only the
                     earned column makes sense, no percentage. */
                  <>
                    <span className={adjColor}>
                      +{fmtSolFloat(earnedSol)} SOL
                    </span>
                    <span className="text-[10px] uppercase tracking-[2px] text-[var(--color-ember)]">
                      free
                    </span>
                  </>
                ) : myMixed ? (
                  /* paid AND earned. Show the headline P&L (which already
                     includes referral-credit value via the held balance)
                     plus an "of which X came free" attribution note. The
                     previous design added paid + earned and showed the
                     sum as the headline — that double-counted the referral
                     kickbacks against the same stacSOL once-as-held-balance
                     and once-as-earned-credit. Now we show only the real
                     realizable number. */
                  <>
                    <span className={`${adjColor} font-black`}>
                      {myAdj >= 0 ? '+' : '−'}
                      {fmtSolFloat(Math.abs(myAdj))} SOL
                    </span>
                    {(() => {
                      const roi = roiPctOnGross(myRow)
                      return roi == null ? null : (
                        <span
                          className={`${adjColor} opacity-70`}
                          title="lifetime ROI on total SOL deposited"
                        >
                          ({(roi * 100).toFixed(2)}%)
                        </span>
                      )
                    })()}
                    <span className="text-[var(--color-dim)]">·</span>
                    <span
                      className="text-[10px] uppercase tracking-[2px] text-[var(--color-ember)]"
                      title="of your P&L above, this much came from stacSOL credited via referrals / manager-fee (no SOL paid for it). Already included in the headline, not additive."
                    >
                      of which free
                    </span>
                    <span className="text-[var(--color-ember)]">
                      +{fmtSolFloat(earnedSol)} SOL
                    </span>
                  </>
                ) : (
                  /* plain holder — no referrals/manager-fee credits. */
                  <>
                    <span className={paidColor}>
                      {paidPnl >= 0 ? '+' : '−'}
                      {fmtSolFloat(Math.abs(paidPnl))} SOL
                    </span>
                    {(() => {
                      const roi = roiPctOnGross(myRow)
                      return roi == null ? null : (
                        <span
                          className={paidColor}
                          title="lifetime ROI on total SOL deposited"
                        >
                          ({(roi * 100).toFixed(2)}%)
                        </span>
                      )
                    })()}
                  </>
                )}
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <DoxxToggle row={myRow} onChanged={onDoxxChanged} />
            </div>
          </div>
        )
      })()}

      {myPk && !myRow && !loading && (
        <div className="mb-3 px-3 py-2 rounded border border-[rgb(107_68_53_/_0.5)] bg-[var(--color-bg)] text-[11px] text-[var(--color-dim)]">
          your wallet has no stacSOL activity yet — mint below to get on the
          board
        </div>
      )}

      {error && (
        <div className="text-[11px] text-[var(--color-warn)] mb-3">
          could not load leaderboard: {error}
        </div>
      )}

      {loading && rows.length === 0 && (
        <div className="text-[11px] text-[var(--color-dim)] uppercase tracking-[2px] py-3">
          loading…
        </div>
      )}

      {!loading && rows.length === 0 && !error && (
        <div className="text-[11px] text-[var(--color-dim)] py-3">
          no holders match the current filters. The first cron run after
          deploy backfills ~60h of pool history; refresh in a few minutes if
          you just shipped.
        </div>
      )}

      {rows.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto rounded border border-[rgb(255_34_0_/_0.12)] bg-[var(--color-bg2)]">
            <table className="w-full text-[11px] tabular-mono">
              <thead className="sticky top-0 bg-[var(--color-bg2)] z-[5]">
                <tr className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] border-b border-[rgb(255_34_0_/_0.18)]">
                  <th className="text-left pl-3 pr-2 py-2 font-black">#</th>
                  <th className="text-left px-2 py-2 font-black">wallet</th>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      className={`px-2 py-2 font-black select-none ${
                        c.align === 'right' ? 'text-right' : 'text-left'
                      } ${c.hideOnMobile ? 'hidden lg:table-cell' : ''}`}
                      title={c.hint}
                    >
                      <button
                        type="button"
                        onClick={() => onColumnClick(c.key)}
                        className={`uppercase tracking-[2px] hover:text-[var(--color-hot)] cursor-pointer ${
                          orderBy === c.key
                            ? 'text-[var(--color-ember)]'
                            : 'text-[var(--color-dim)]'
                        }`}
                      >
                        {c.label}
                        {c.hint && (
                          <span className="ml-1 opacity-50 cursor-help">ⓘ</span>
                        )}
                        {orderBy === c.key && (
                          <span className="ml-1">
                            {dir === 'desc' ? '▼' : '▲'}
                          </span>
                        )}
                      </button>
                    </th>
                  ))}
                  <th
                    className="text-right px-2 py-2 font-black"
                    title="Break-even NAV: the redemption rate at which the wallet's paid SOL in would exactly equal SOL out + held value. NAV has to climb to this number before the wallet is profitable on paid trading alone. 'far' = >20× current NAV (effectively unreachable). '—' = pure earner (no paid SOL)."
                  >
                    break-even
                    <span className="ml-1 opacity-50 cursor-help">ⓘ</span>
                  </th>
                  <th className="text-right pl-2 pr-3 py-2 font-black hidden lg:table-cell">
                    flows
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <HolderRowDesktop
                    key={row.wallet}
                    row={row}
                    isMe={row.wallet === myPk}
                    copy={copy}
                    copiedKey={copiedKey}
                    currentRate={meta?.rate ?? null}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list */}
          <div className="md:hidden space-y-2">
            {rows.map((row) => (
              <HolderCardMobile
                key={row.wallet}
                row={row}
                isMe={row.wallet === myPk}
                copy={copy}
                copiedKey={copiedKey}
                currentRate={meta?.rate ?? null}
              />
            ))}
          </div>

          <div ref={sentinelRef} className="h-12" />

          {meta?.nextCursor && (
            <div className="flex justify-center mt-4">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] uppercase tracking-[3px] font-black text-[var(--color-hot)] hover:bg-[rgb(255_34_0_/_0.12)] disabled:opacity-50 transition"
              >
                {loadingMore ? 'loading…' : 'load more'}
              </button>
            </div>
          )}

          {!meta?.nextCursor && (
            <p className="text-[10px] text-[var(--color-dim)] text-center mt-4">
              that's everyone.
            </p>
          )}
        </>
      )}

      <p className="mt-6 text-[10px] text-[var(--color-dim)] leading-relaxed">
        Indexed from on-chain DepositSol / WithdrawSol ixs (program{' '}
        <span className="font-mono">SP12…vhY</span>). Balances cover both
        the wallet's stacSOL ATA and its HawkFi userPda ATA. P&amp;L is{' '}
        <code className="text-[var(--color-fg)]">
          held × NAV × 0.931 + grossOut − grossIn
        </code>{' '}
        — realized burns plus the current burn value of held stacSOL, minus
        SOL ever deposited. The percentage is ROI on{' '}
        <code className="text-[var(--color-fg)]">grossIn</code>{' '}
        (lifetime deposited capital), not on the residual still-committed
        slice — that's the figure that matches user intuition for
        churn-heavy wallets. The{' '}
        <span className="text-[var(--color-green)] uppercase tracking-[2px] text-[9px]">
          earned
        </span>{' '}
        column is the deposit-fee leg credited to referrers / manager (50/50
        split, 3.45% of mint output each). Wallets whose stacSOL came
        purely from earnings show a{' '}
        <span className="text-[var(--color-green)] uppercase tracking-[2px] text-[9px]">
          earned
        </span>{' '}
        badge with cost basis hidden. Break-even NAV is the rate at which
        the burn payout equals net SOL paid in. Updates every ~5min via
        Vercel cron.
        <br />
        Marketing wallet (
        <a
          href={`https://solscan.io/account/${MARKETING_WALLET}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-warn)] hover:text-[var(--color-fg)] no-underline"
        >
          {shortPk(MARKETING_WALLET)}
        </a>
        ) is the default referrer credit destination — toggle off to see
        organic depositors only.
      </p>
    </div>
    </>
  )
}

function PnLCells({ row }: { row: HolderRow }) {
  const pure = isPureEarner(row)
  const mixed = isMixedEarner(row)
  // For pure earners, show the SOL value of their earned credits as a
  // green "free" gain — they paid 0 SOL, so the conventional P&L %
  // (divisor = 0) is meaningless.
  if (pure) {
    return (
      <>
        <td className="text-right px-2 py-2 font-bold text-[var(--color-green)]">
          +{fmtSolFloat(row.earnedSol || 0)}
        </td>
        <td className="text-right px-2 py-2 text-[var(--color-ember)] text-[10px] uppercase tracking-[2px]">
          free
        </td>
      </>
    )
  }
  const adj = adjustedPnl(row)
  const profitable = adj >= 0
  const color = profitable ? 'text-[var(--color-green)]' : 'text-[var(--color-warn)]'
  // Use ROI on gross deposited (lifetime return) instead of API's
  // netSolIn-based pnlPct. Heavy churners look sane this way.
  const roi = roiPctOnGross(row)
  const paidColor = row.pnlSol >= 0
    ? 'text-[var(--color-green)]'
    : 'text-[var(--color-warn)]'
  return (
    <>
      <td className={`text-right px-2 py-2 font-bold ${color}`}>
        <span title={
          mixed
            ? `realized + unrealized P&L. of this, +${fmtSolFloat(row.earnedSol || 0)} SOL came from referral / manager-fee kickbacks (free upside, already included — not additive).`
            : `realized + unrealized over total deposited`
        }>
          {adj >= 0 ? '+' : '−'}
          {fmtSolFloat(Math.abs(adj))}
        </span>
        {mixed && (
          <span
            className="ml-1 text-[9px] text-[var(--color-ember)] uppercase tracking-[2px]"
            title={`of which +${fmtSolFloat(row.earnedSol || 0)} SOL came free via referral / manager-fee credits`}
          >
            (incl. {fmtSolFloat(row.earnedSol || 0)}f)
          </span>
        )}
      </td>
      <td className={`text-right px-2 py-2 ${paidColor}`}
          title="lifetime ROI on paid SOL only — referral / manager-fee credits boost the SOL column on the left without consuming paid capital, so this ratio measures paid trading skill in isolation">
        {roi == null ? '—' : `${(roi * 100).toFixed(1)}%`}
      </td>
    </>
  )
}


function HolderRowDesktop({
  row,
  isMe,
  copy,
  copiedKey,
  currentRate,
}: {
  row: HolderRow
  isMe: boolean
  copy: (pk: string) => void
  copiedKey: string | null
  currentRate: number | null
}) {
  const pure = isPureEarner(row)
  const mixed = isMixedEarner(row)
  const adj = adjustedPnl(row)
  const underwater = !pure && adj < 0
  const baseClass = isMe
    ? 'bg-[rgb(255_119_51_/_0.10)] border-y border-[rgb(255_119_51_/_0.4)]'
    : underwater
    ? 'bg-[rgb(255_204_0_/_0.04)] border-b border-[rgb(255_34_0_/_0.06)]'
    : 'border-b border-[rgb(255_34_0_/_0.06)]'
  const earnedCount = (row.referralEarnedCount || 0) + (row.managerFeeEarnedCount || 0)
  return (
    <tr className={baseClass}>
      <td className="text-left pl-3 pr-2 py-2 text-[var(--color-dim)] font-black">
        {row.rank}
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <WalletIdentity row={row} isMe={isMe} copy={copy} copiedKey={copiedKey} />
          {row.isMarketing && (
            <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-warn)] text-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)]">
              marketing
            </span>
          )}
          {(pure || mixed) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-green)] text-[var(--color-green)] bg-[rgb(0_180_0_/_0.08)]"
              title={`earned ${fmtSolFloat(row.earnedSol || 0)} SOL of stacSOL value across ${earnedCount} referral/manager-fee credit${earnedCount === 1 ? '' : 's'} (zero SOL paid)`}
            >
              earned
            </span>
          )}
          {hasTransferredOut(row) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)]"
              title={`sent out ~${fmtAmount(BigInt(row.transferredOutAtom))} stac via Token-2022 transfer (≈${fmtSolFloat(row.transferredOutSol)} SOL at NAV); counted in P&L as implicit burn`}
            >
              sent →
            </span>
          )}
          {hasTransferredIn(row) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)]"
              title={`received ~${fmtAmount(BigInt(row.transferredInAtom))} stac via Token-2022 transfer (≈${fmtSolFloat(row.transferredInSol)} SOL at NAV); zero SOL paid`}
            >
              ← recv
            </span>
          )}
          {isMe && (
            <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-ember)] text-[var(--color-ember)] bg-[rgb(255_119_51_/_0.1)]">
              you
            </span>
          )}
          {BigInt(row.hawkfiStacAtom) > 0n && (
            <span
              className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]"
              title={`includes ${fmtAmount(BigInt(row.hawkfiStacAtom))} stac in HawkFi userPda ATA`}
            >
              · hawkfi
            </span>
          )}
        </div>
      </td>
      <td className="text-right px-2 py-2 text-[var(--color-fg)] font-bold">
        {fmtAmount(BigInt(row.totalStacAtom))}
      </td>
      <td className="text-right px-2 py-2 text-[var(--color-dim)]">
        {pure ? (
          <span title="zero SOL deposited — all stacSOL came from referral or manager-fee credits">
            —
          </span>
        ) : (
          fmtSolNum(row.grossSolIn)
        )}
      </td>
      <PnLCells row={row} />
      <td className="text-right px-2 py-2 text-[var(--color-dim)] hidden lg:table-cell">
        {row.firstEventAt ? `${fmtRel(row.firstEventAt)} ago` : '—'}
      </td>
      <td className="text-right px-2 py-2 text-[var(--color-dim)] hidden lg:table-cell">
        {row.lastEventAt ? `${fmtRel(row.lastEventAt)} ago` : '—'}
      </td>
      <td className="text-right px-2 py-2 text-[var(--color-dim)] font-mono">
        {pure ? '—' : breakevenDisplay(row, currentRate)}
      </td>
      <td className="text-right pl-2 pr-3 py-2 text-[var(--color-dim)] hidden lg:table-cell">
        {row.mintCount}m / {row.burnCount}b
        {earnedCount > 0 && (
          <span className="text-[var(--color-green)]"> · {earnedCount}e</span>
        )}
      </td>
    </tr>
  )
}

function HolderCardMobile({
  row,
  isMe,
  copy,
  copiedKey,
  currentRate,
}: {
  row: HolderRow
  isMe: boolean
  copy: (pk: string) => void
  copiedKey: string | null
  currentRate: number | null
}) {
  const pure = isPureEarner(row)
  const mixed = isMixedEarner(row)
  const adj = adjustedPnl(row)
  const underwater = !pure && adj < 0
  const ringClass = isMe
    ? 'border-[rgb(255_119_51_/_0.5)] bg-[rgb(255_119_51_/_0.08)]'
    : underwater
    ? 'border-[rgb(255_204_0_/_0.18)] bg-[rgb(255_204_0_/_0.04)]'
    : 'border-[rgb(255_34_0_/_0.10)] bg-[var(--color-bg2)]'
  const pnlColor = pure
    ? 'text-[var(--color-green)]'
    : underwater
    ? 'text-[var(--color-warn)]'
    : 'text-[var(--color-green)]'
  const earnedCount = (row.referralEarnedCount || 0) + (row.managerFeeEarnedCount || 0)
  return (
    <div className={`rounded border p-3 ${ringClass}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-[2px] font-black text-[var(--color-dim)]">
            #{row.rank}
          </span>
          <WalletIdentity
            row={row}
            isMe={isMe}
            copy={copy}
            copiedKey={copiedKey}
            className="text-[12px]"
          />
        </div>
        <div className="flex gap-1">
          {row.isMarketing && (
            <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-warn)] text-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)]">
              mkt
            </span>
          )}
          {(pure || mixed) && (
            <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-green)] text-[var(--color-green)] bg-[rgb(0_180_0_/_0.08)]">
              earned
            </span>
          )}
          {hasTransferredOut(row) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)]"
              title={`sent ~${fmtAmount(BigInt(row.transferredOutAtom))} stac via transfer`}
            >
              sent
            </span>
          )}
          {hasTransferredIn(row) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)]"
              title={`received ~${fmtAmount(BigInt(row.transferredInAtom))} stac via transfer`}
            >
              recv
            </span>
          )}
          {isMe && (
            <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-ember)] text-[var(--color-ember)] bg-[rgb(255_119_51_/_0.1)]">
              you
            </span>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <div>
          <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
            stacSOL held
          </div>
          <div className="font-mono text-[var(--color-fg)]">
            {fmtAmount(BigInt(row.totalStacAtom))}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
            P&amp;L
          </div>
          <div className={`font-mono font-bold ${pnlColor}`}>
            {pure ? (
              <>
                +{fmtSolFloat(row.earnedSol || 0)} SOL
                <span className="text-[10px] ml-1 text-[var(--color-ember)]">
                  (free)
                </span>
              </>
            ) : (
              <>
                {adj >= 0 ? '+' : '−'}
                {fmtSolFloat(Math.abs(adj))} SOL
                {(() => {
                  const roi = roiPctOnGross(row)
                  return roi == null ? null : (
                    <span
                      className="text-[10px] ml-1"
                      title="lifetime ROI on total SOL deposited"
                    >
                      ({(roi * 100).toFixed(1)}%)
                    </span>
                  )
                })()}
              </>
            )}
          </div>
          {mixed && (
            <div className="text-[9px] text-[var(--color-ember)] mt-0.5">
              incl. +{fmtSolFloat(row.earnedSol || 0)} SOL earned
            </div>
          )}
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
            cost basis
          </div>
          <div className="font-mono text-[var(--color-dim)]">
            {pure ? '—' : `${fmtSolNum(row.grossSolIn)} SOL`}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
            break-even
          </div>
          <div className="font-mono text-[var(--color-dim)]">
            {pure ? '—' : breakevenDisplay(row, currentRate)}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
            flows
          </div>
          <div className="font-mono text-[var(--color-dim)]">
            {row.mintCount} mint / {row.burnCount} burn
            {earnedCount > 0 && (
              <span className="text-[var(--color-green)]"> · {earnedCount} earned</span>
            )}
          </div>
        </div>
        <div>
          <div className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]">
            last activity
          </div>
          <div className="font-mono text-[var(--color-dim)]">
            {row.lastEventAt ? `${fmtRel(row.lastEventAt)} ago` : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}
