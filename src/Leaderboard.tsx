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
import { ReferralLeaderboard } from './components/ReferralLeaderboard'

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
  /** USD price of 1 SOL at response time (CoinGecko-sourced server-side).
   *  Used to render volume metrics in $. null if the price fetch failed. */
  solUsd?: number | null
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
// and the live on-chain balance. 0.001 stacSOL = 1e6 atoms. The sent/recv
// markers matter for reading the table: P&L values transferred-out stac as
// an implicit burn, so a wallet that moved its bag into an LP can show
// positive P&L on a small remaining balance.
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
    hint: 'Current on-chain stacSOL balance. The dim line under it is what that bag pays out if burned right now (held × NAV × 0.931).',
  },
  {
    key: 'gross_sol_in',
    label: 'cost basis',
    align: 'right',
    hint: 'Net SOL paid in: lifetime deposits minus SOL already taken back out via burns.',
  },
  {
    key: 'pnl_sol',
    label: 'P&L',
    align: 'right',
    hint: 'Up or down, in SOL: burn value of held stacSOL + SOL ever withdrawn − SOL ever deposited. The % is that P&L over total SOL ever deposited.',
  },
  {
    key: 'last_event_at',
    label: 'last active',
    align: 'right',
    hideOnMobile: true,
    hint: 'Time since this wallet last minted, burned, or earned a credit.',
  },
]

// 6dp for the same reason fmtSolFloat / fmtAmount were bumped: sub-0.0001
// SOL net values previously read as `0.0000` on the row's net-SOL cell.
const fmtSolNum = (lamports: bigint | string | number) => {
  const big =
    typeof lamports === 'bigint'
      ? lamports
      : typeof lamports === 'string'
      ? BigInt(lamports || '0')
      : BigInt(Math.round(lamports))
  return (Number(big) / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
  })
}

// 6 decimals so sub-0.0001 SOL earnings render as e.g. `0.000123` rather than
// collapsing to `0.0000`. Matches the redemption-rate precision (6dp) and the
// `fmt(x, 6)` pattern used for earned-SOL on the App page. Keep the duplicate
// in components/Leaderboard.tsx in sync.
const fmtSolFloat = (sol: number) =>
  sol.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
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
  const [hideMarketing, setHideMarketing] = useState(false)

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
      if (hideMarketing) params.set('hideMarketing', 'true')
      if (cursor) params.set('cursor', cursor)
      if (myPk) params.set('my', myPk)
      return `/api/holders-leaderboard?${params.toString()}`
    },
    [orderBy, dir, search, hideMarketing, myPk],
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
    // Real economic state: what the protocol would pay out if every holder
    // burned right now. burn_net_per_token = balance × (1 - 0.069) × NAV.
    const burnValueIfAllRedeem = totalStacUi * 0.931 * (meta.rate ?? 0)
    return { totalStacUi, burnValueIfAllRedeem }
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

      {/* Totals strip — the five numbers that matter: how many wallets,
          how much stac, what it's all worth on burn, the NAV, and how many
          are up vs down. Everything else lives in column tooltips. */}
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
          {meta.rate != null && (
            <span title="What the protocol would pay out if every holder burned every stacSOL right now, at current NAV, after the 6.9% fee.">
              <span className="text-[var(--color-green)] font-mono normal-case tracking-normal">
                {stickyTotal.burnValueIfAllRedeem.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })}
              </span>{' '}
              SOL burn value
              <span className="ml-0.5 cursor-help opacity-60">ⓘ</span>
            </span>
          )}
          {meta.rate != null && (
            <span>
              NAV{' '}
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {meta.rate.toFixed(6)}
              </span>
            </span>
          )}
          <span title="Wallets currently in profit vs underwater (P&L as shown in the table).">
            <span className="text-[var(--color-green)] font-mono normal-case tracking-normal">
              {meta.totals.profitableCount}
            </span>
            <span className="text-[var(--color-dim)] mx-0.5">up /</span>
            <span className="text-[var(--color-warn)] font-mono normal-case tracking-normal">
              {meta.totals.underwaterCount}
            </span>
            <span className="text-[var(--color-dim)] ml-0.5">down</span>
          </span>
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
            checked={hideMarketing}
            onChange={(e) => setHideMarketing(e.target.checked)}
            className="accent-[var(--color-hot)]"
          />
          hide marketing wallet
        </label>
      </div>

      {/* "You" sticky row — rank, bag, one P&L number. Pure earners (zero
          SOL paid) get "+X SOL free" instead of a meaningless percentage. */}
      {myPk && myRow && (() => {
        const myPure = isPureEarner(myRow)
        const myPnl = adjustedPnl(myRow)
        const color = myPure || myPnl >= 0
          ? 'text-[var(--color-green)]'
          : 'text-[var(--color-warn)]'
        const roi = roiPctOnGross(myRow)
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
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--color-dim)] font-mono">
                <span>{fmtAmount(BigInt(myRow.totalStacAtom))} stac</span>
                {myPure ? (
                  <span className={color}>
                    +{fmtSolFloat(myRow.earnedSol || 0)} SOL free
                  </span>
                ) : (
                  <span className={`${color} font-black`}>
                    {myPnl >= 0 ? '+' : '−'}
                    {fmtSolFloat(Math.abs(myPnl))} SOL
                    {roi != null && ` (${(roi * 100).toFixed(2)}%)`}
                  </span>
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

      {/* Historical referral leaderboard — archived record of third-party
          referrers from when the UI supported ?ref= links. Read-only: all
          deposits now credit the marketing wallet. */}
      <div className="mt-10 mb-6">
        <ReferralLeaderboard />
      </div>

      <p className="mt-6 text-[10px] text-[var(--color-dim)] leading-relaxed">
        Indexed from on-chain DepositSol / WithdrawSol ixs, updated every
        ~5min. P&amp;L = what the wallet would have if it burned everything
        right now (held × NAV × 0.931) plus SOL it already took out, minus
        SOL it ever put in; the % is that number over everything it ever put
        in. Wallets tagged{' '}
        <span className="text-[var(--color-green)] uppercase tracking-[2px] text-[9px]">
          earned
        </span>{' '}
        got some or all of their stacSOL free via the deposit-fee split. The{' '}
        <span className="text-[var(--color-warn)] uppercase tracking-[2px] text-[9px]">
          marketing
        </span>{' '}
        wallet (
        <a
          href={`https://solscan.io/account/${MARKETING_WALLET}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-warn)] hover:text-[var(--color-fg)] no-underline"
        >
          {shortPk(MARKETING_WALLET)}
        </a>
        ) collects the referral share of every deposit fee — filter it out
        above to see organic depositors only.
      </p>
    </div>
    </>
  )
}

// One P&L cell: "+X SOL (Y%)". Pure earners (zero SOL paid) show
// "+X free" instead — a percentage over a 0-SOL base is meaningless.
function PnLCell({ row }: { row: HolderRow }) {
  const pure = isPureEarner(row)
  if (pure) {
    return (
      <td className="text-right px-2 py-2 font-bold text-[var(--color-green)]">
        +{fmtSolFloat(row.earnedSol || 0)}
        <span className="ml-1 text-[9px] text-[var(--color-ember)] uppercase tracking-[2px]">
          free
        </span>
      </td>
    )
  }
  const pnl = adjustedPnl(row)
  const color = pnl >= 0 ? 'text-[var(--color-green)]' : 'text-[var(--color-warn)]'
  const roi = roiPctOnGross(row)
  const mixed = isMixedEarner(row)
  return (
    <td
      className={`text-right px-2 py-2 font-bold ${color}`}
      title={
        mixed
          ? `of this, +${fmtSolFloat(row.earnedSol || 0)} SOL came free via referral / manager-fee credits (already included, not additive)`
          : undefined
      }
    >
      {pnl >= 0 ? '+' : '−'}
      {fmtSolFloat(Math.abs(pnl))}
      {roi != null && (
        <span className="ml-1 font-normal opacity-70">
          ({(roi * 100).toFixed(1)}%)
        </span>
      )}
    </td>
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
  const worthSol =
    currentRate != null
      ? (Number(BigInt(row.totalStacAtom)) / 1e9) * currentRate * 0.931
      : null
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
              title={`earned ${fmtSolFloat(row.earnedSol || 0)} SOL of stacSOL value via referral / manager-fee credits (zero SOL paid)`}
            >
              earned
            </span>
          )}
          {hasTransferredOut(row) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)]"
              title={`moved ~${fmtAmount(BigInt(row.transferredOutAtom))} stac out of the wallet (LPs, transfers — ≈${fmtSolFloat(row.transferredOutSol)} SOL at NAV). P&L counts it as an implicit burn, which is why P&L can beat the held bag.`}
            >
              sent →
            </span>
          )}
          {hasTransferredIn(row) && (
            <span
              className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-dim)] text-[var(--color-dim)] bg-[var(--color-bg)]"
              title={`received ~${fmtAmount(BigInt(row.transferredInAtom))} stac via transfer (zero SOL paid)`}
            >
              ← recv
            </span>
          )}
          {isMe && (
            <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-ember)] text-[var(--color-ember)] bg-[rgb(255_119_51_/_0.1)]">
              you
            </span>
          )}
        </div>
      </td>
      <td className="text-right px-2 py-2">
        <div className="text-[var(--color-fg)] font-bold">
          {fmtAmount(BigInt(row.totalStacAtom))}
        </div>
        {worthSol != null && worthSol > 0 && (
          <div
            className="text-[9px] text-[var(--color-dim)]"
            title="what this bag pays out if burned right now (held × NAV × 0.931)"
          >
            ≈ {worthSol.toLocaleString(undefined, { maximumFractionDigits: 2 })} SOL
          </div>
        )}
      </td>
      <td className="text-right px-2 py-2 text-[var(--color-dim)]">
        {pure ? (
          <span title="zero SOL deposited — all stacSOL came from referral or manager-fee credits">
            —
          </span>
        ) : (
          (() => {
            // NET cost basis = grossSolIn − grossSolOut. See mobile row
            // for the rationale + perceived-double-count fix.
            const grossIn = BigInt(row.grossSolIn || '0')
            const grossOut = BigInt(row.grossSolOut || '0')
            const net = grossIn > grossOut ? grossIn - grossOut : 0n
            return fmtSolNum(net.toString())
          })()
        )}
      </td>
      <PnLCell row={row} />
      <td className="text-right px-2 py-2 text-[var(--color-dim)] hidden lg:table-cell">
        {row.lastEventAt ? `${fmtRel(row.lastEventAt)} ago` : '—'}
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
  const worthSol =
    currentRate != null
      ? (Number(BigInt(row.totalStacAtom)) / 1e9) * currentRate * 0.931
      : null
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
          {worthSol != null && worthSol > 0 && (
            <div className="text-[9px] text-[var(--color-dim)]">
              ≈ {worthSol.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
              SOL if burned
            </div>
          )}
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
        </div>
        <div>
          <div
            className="text-[9px] uppercase tracking-[2px] text-[var(--color-dim)]"
            title="Net SOL paid in: lifetime deposits minus SOL already taken back out via burns."
          >
            cost basis
          </div>
          <div className="font-mono text-[var(--color-dim)]">
            {pure
              ? '—'
              : (() => {
                  // NET cost basis = gross_sol_in − gross_sol_out.
                  // Was rendering raw gross_sol_in which looked like
                  // double-counting after a mint→burn→mint cycle ('cost
                  // basis 92 SOL on a 27-stacSOL bag with NAV 1.79').
                  const grossIn = BigInt(row.grossSolIn || '0')
                  const grossOut = BigInt(row.grossSolOut || '0')
                  const net = grossIn > grossOut ? grossIn - grossOut : 0n
                  return `${fmtSolNum(net.toString())} SOL`
                })()}
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
