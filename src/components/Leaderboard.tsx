// Top referrers leaderboard.
//
// Backed by /api/leaderboard which aggregates the `referral_credits` table
// (one row per DepositSol ix that credited the referrer's stacSOL ATA —
// variant 14, account index 6, see api/referral-index.ts). The endpoint
// also JOINs `holder_summary` to surface each referrer's doxx state +
// display name, and returns the current NAV so the UI can value the
// stacSOL kickback in SOL terms.
//
// Display strategies ported from the holders leaderboard (src/Leaderboard.tsx):
//   - WalletIdentity: anonymous pseudonym by default, opt-in doxx via signature
//   - DoxxToggle on the connected wallet's own row
//   - SOL-value of fee_stacsol shown alongside raw stacSOL (using NAV × 0.931
//     because the T22 transfer fee applies on burn). The raw stacSOL number
//     stays so referrers can see what's in their ATA right now.
//   - Sticky "you" row with rich breakdown (rank, raw kickback, SOL value,
//     ROI on referred volume, opt-in CTA)
//   - Honest tooltips: separate "what you'd get if you burned now" from
//     "what your referees deposited" — the latter is volume, not income.

import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Card } from './Stats'
import { fmtAmount } from '../lib/format'
import { WalletIdentity, DoxxToggle, type DoxxIdentity } from './walletDoxx'

interface LeaderboardRow extends DoxxIdentity {
  rank: number
  referrer: string
  feeStacsol: string
  solReferred: string
  deposits: number
  uniqueDepositors: number
  firstAt: number
  lastAt: number
  isMarketing: boolean
  // `wallet` is the field WalletIdentity expects; we mirror referrer into it.
  wallet: string
}

interface LeaderboardResponse {
  marketingReferrer: string
  navRate: number | null
  payoutFraction: number // 0.931 — net of 6.9% T22 transfer fee
  totals: {
    deposits: number
    referrers: number
    depositors: number
    feeStacsol: string
    solReferred: string
  }
  rows: LeaderboardRow[]
}

const REFRESH_MS = 60_000

// 6 decimals — see /src/Leaderboard.tsx fmtSolFloat for the rationale. These
// two helpers must stay in sync; the file-level Leaderboard.tsx is the
// editorial-design page that the live site renders, and components/Leaderboard
// is the legacy embedded variant still used inside a few action panels.
const fmtSolFloat = (n: number) =>
  n.toLocaleString(undefined, {
    maximumFractionDigits: 6,
    minimumFractionDigits: 6,
  })

const stacAtomToSol = (
  atom: bigint | string,
  nav: number | null,
  payout: number,
): number | null => {
  if (nav == null) return null
  const big = typeof atom === 'bigint' ? atom : BigInt(atom || '0')
  return (Number(big) / 1e9) * nav * payout
}

const lamportsToSol = (lam: bigint | string): number => {
  const big = typeof lam === 'bigint' ? lam : BigInt(lam || '0')
  return Number(big) / LAMPORTS_PER_SOL
}

export function Leaderboard() {
  const { publicKey } = useWallet()
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [excludeMarketing, setExcludeMarketing] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const url = `/api/leaderboard?limit=25${
          excludeMarketing ? '&includeMarketing=false' : ''
        }`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as Omit<LeaderboardResponse, 'rows'> & {
          rows: Omit<LeaderboardRow, 'wallet'>[]
        }
        if (!cancelled) {
          // Mirror referrer → wallet so the shared WalletIdentity works
          // without forking its prop shape.
          const rows: LeaderboardRow[] = json.rows.map((r) => ({
            ...r,
            wallet: r.referrer,
          }))
          setData({ ...json, rows })
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    }
    fetchOnce()
    const id = setInterval(fetchOnce, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [excludeMarketing, refreshTick])

  const onDoxxChanged = () => setRefreshTick((t) => t + 1)

  const myPk = publicKey?.toBase58() ?? null
  const myRow = useMemo(
    () => data?.rows.find((r) => r.referrer === myPk) ?? null,
    [data, myPk],
  )

  const copy = async (pk: string) => {
    try {
      await navigator.clipboard.writeText(pk)
      setCopiedKey(pk)
      setTimeout(() => setCopiedKey((k) => (k === pk ? null : k)), 1500)
    } catch {
      /* ignore */
    }
  }

  const nav = data?.navRate ?? null
  const payout = data?.payoutFraction ?? 0.931

  // Totals → SOL value.
  const totalFeeStacAtom = data?.totals.feeStacsol ?? '0'
  const totalFeeSolValue = stacAtomToSol(totalFeeStacAtom, nav, payout)
  const totalReferredSol = data ? lamportsToSol(data.totals.solReferred) : 0

  return (
    <Card title="Leaderboard · top referrers by lifetime fees">
      {/* Filter toggle + aggregated SOL value strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <button
          type="button"
          onClick={() => setExcludeMarketing((v) => !v)}
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-fg)] underline-offset-2 hover:underline"
          title="Toggle marketing-wallet visibility"
        >
          {excludeMarketing
            ? 'show marketing default'
            : 'hide marketing default'}
        </button>
        {data && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
            <span>
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {data.totals.referrers.toLocaleString()}
              </span>{' '}
              referrers
            </span>
            <span>
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {data.totals.deposits.toLocaleString()}
              </span>{' '}
              deposits
            </span>
            <span title="lifetime stacSOL kicked back to referrers (raw token amount, sitting in their ATAs)">
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {fmtAmount(BigInt(totalFeeStacAtom))}
              </span>{' '}
              stacSOL paid
              {totalFeeSolValue != null && (
                <span className="ml-1 text-[var(--color-ember)] normal-case tracking-normal">
                  · ≈ {fmtSolFloat(totalFeeSolValue)} SOL @ burn
                </span>
              )}
            </span>
            <span title="lifetime SOL deposited *by* referees (referred volume — this is the gross funnel, not your income)">
              <span className="text-[var(--color-fg)] font-mono normal-case tracking-normal">
                {fmtSolFloat(totalReferredSol)}
              </span>{' '}
              SOL referred (volume)
            </span>
          </div>
        )}
      </div>

      {/* Sticky "you" row */}
      {myPk && myRow && data && (() => {
        const feeStacAtom = BigInt(myRow.feeStacsol || '0')
        const feeSol = stacAtomToSol(feeStacAtom, nav, payout)
        const referredVolumeSol = lamportsToSol(myRow.solReferred)
        // ROI is fee value vs the volume — useful sanity check vs the
        // theoretical 3.45% (50% of 6.9% deposit fee, paid as stacSOL).
        const effRoi =
          feeSol != null && referredVolumeSol > 0
            ? feeSol / referredVolumeSol
            : null
        return (
          <div className="mb-3 px-3 py-2 rounded border border-[rgb(255_119_51_/_0.5)] bg-[rgb(255_119_51_/_0.08)] sticky top-2 z-10 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[var(--color-ember)] font-black">
                  #{myRow.rank}
                </span>
                <WalletIdentity
                  row={myRow}
                  isMe
                  copy={copy}
                  copiedKey={copiedKey}
                />
                {myRow.isMarketing && (
                  <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-warn)] text-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)]">
                    marketing
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--color-dim)] font-mono">
                <span title="raw stacSOL kickback sitting in your ATA — this is what you actually own from referrals">
                  {fmtAmount(feeStacAtom)} stac
                </span>
                {feeSol != null && (
                  <span
                    className="text-[var(--color-green)]"
                    title={`if you burned every stacSOL you've earned via referrals right now, you'd receive this much SOL (NAV ${nav?.toFixed(4) ?? '?'} × 0.931 payout)`}
                  >
                    ≈ {fmtSolFloat(feeSol)} SOL @ burn
                  </span>
                )}
                <span className="text-[var(--color-dim)]">·</span>
                <span title="lifetime SOL deposited *by* your referees — gross funnel volume, NOT your income">
                  {fmtSolFloat(referredVolumeSol)} SOL referred
                </span>
                {effRoi != null && (
                  <span
                    className="text-[var(--color-dim)] opacity-80"
                    title="your fee value vs your referred volume. should be ≈ 3.45% (= 50% of the 6.9% deposit fee). lower = referees burned their fee back into NAV before you valued it."
                  >
                    ({(effRoi * 100).toFixed(2)}%)
                  </span>
                )}
                <span className="text-[var(--color-dim)]">·</span>
                <span>{myRow.deposits} referred deposits</span>
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <DoxxToggle row={myRow} onChanged={onDoxxChanged} />
            </div>
          </div>
        )
      })()}

      {myPk && !myRow && data && (
        <div className="mb-3 px-3 py-2 rounded border border-[rgb(107_68_53_/_0.5)] bg-[var(--color-bg)] text-[11px] text-[var(--color-dim)]">
          your wallet hasn&apos;t earned any referral fees yet — share your
          link to get on the board
        </div>
      )}

      {error && (
        <div className="text-[11px] text-[var(--color-warn)] mb-3">
          could not load leaderboard: {error}
        </div>
      )}

      {!data && !error && (
        <div className="text-[11px] text-[var(--color-dim)] uppercase tracking-[2px] py-3">
          loading…
        </div>
      )}

      {data && data.rows.length === 0 && (
        <div className="text-[11px] text-[var(--color-dim)] py-3">
          no referral credits indexed yet — backfill is still running. Check
          back in a few minutes.
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-[11px] tabular-mono">
            <thead>
              <tr className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
                <th className="text-left pl-1 pr-3 py-1.5 font-black">#</th>
                <th className="text-left px-3 py-1.5 font-black">wallet</th>
                <th
                  className="text-right px-3 py-1.5 font-black"
                  title="raw stacSOL sitting in this referrer's ATA from kickbacks"
                >
                  fee (stacSOL)
                </th>
                <th
                  className="text-right px-3 py-1.5 font-black"
                  title="SOL value if they burned every kicked-back stacSOL right now (NAV × 0.931)"
                >
                  ≈ SOL @ burn
                </th>
                <th
                  className="text-right px-3 py-1.5 font-black hidden sm:table-cell"
                  title="lifetime SOL deposited *by* this referrer's referees — gross funnel volume, NOT their income"
                >
                  SOL referred
                </th>
                <th className="text-right px-3 py-1.5 font-black">deposits</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => {
                const isMe = row.referrer === myPk
                const feeAtom = BigInt(row.feeStacsol || '0')
                const feeSol = stacAtomToSol(feeAtom, nav, payout)
                const referredSol = lamportsToSol(row.solReferred)
                return (
                  <tr
                    key={row.referrer}
                    className={
                      isMe
                        ? 'bg-[rgb(255_119_51_/_0.08)] border-y border-[rgb(255_119_51_/_0.4)]'
                        : 'border-b border-[rgb(255_34_0_/_0.06)]'
                    }
                  >
                    <td className="text-left pl-1 pr-3 py-2 text-[var(--color-dim)] font-black">
                      {row.rank}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <WalletIdentity
                          row={row}
                          isMe={isMe}
                          copy={copy}
                          copiedKey={copiedKey}
                        />
                        {row.isMarketing && (
                          <span className="px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border border-[var(--color-warn)] text-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)]">
                            default
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-fg)] font-bold">
                      {fmtAmount(feeAtom)}
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-green)] font-bold">
                      {feeSol != null ? fmtSolFloat(feeSol) : '—'}
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-dim)] hidden sm:table-cell">
                      {fmtSolFloat(referredSol)}
                    </td>
                    <td className="text-right px-3 py-2 text-[var(--color-dim)]">
                      {row.deposits.toLocaleString()}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[10px] text-[var(--color-dim)] leading-relaxed">
        Indexed from on-chain DepositSol ixs (program{' '}
        <span className="font-mono">SP12…vhY</span>, account slot 6 = referrer
        ATA). Updates every ~5 min. Backfill from launch may take a few hours
        to complete after the first deploy.{' '}
        <span className="text-[var(--color-ember)]">
          fee (stacSOL) is the raw kickback in the referrer&apos;s ATA;{' '}
          ≈ SOL @ burn values it at the current NAV minus the 6.9% transfer
          fee on burn. SOL referred is the gross funnel volume — not income.
        </span>
      </p>
    </Card>
  )
}
