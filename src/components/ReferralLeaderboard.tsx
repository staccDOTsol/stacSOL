// Gamified referral leaderboard.
//
// Backed by /api/leaderboard, which aggregates `referral_credits` (one row
// per DepositSol ix that credited the referrer's stacSOL ATA). The endpoint
// excludes the two house wallets by default (marketing/default referrer +
// manager keypair) so the board shows real third-party referrers; pass
// `?includeHouse=true` to reveal them.
//
// Gamification layer on top of the raw table:
//   - A 🥇🥈🥉 podium for the top 3 (raised middle, glow, medal).
//   - Fee bars on every ranked row, width ∝ fee relative to #1.
//   - A "YOU" hero: your rank + earnings + your personal share link (the same
//     ?ref= mechanism surfaced in ReferralCard), with a one-tap copy + tweet.
//   - Doxx opt-in on your own row (anonymous pseudonym by default).

import { useEffect, useMemo, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { Card } from './Stats'
import { fmtAmount } from '../lib/format'
import { WalletIdentity, DoxxToggle, type DoxxIdentity } from './walletDoxx'
import { useReferrer } from '../lib/referrer'
import { TwitterBird } from './icons'

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
  isManager: boolean
  wallet: string
}

interface LeaderboardResponse {
  marketingReferrer: string
  managerWallet: string
  includeHouse: boolean
  navRate: number | null
  payoutFraction: number
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

const fmtSol = (n: number, dp = 2) =>
  n.toLocaleString(undefined, { maximumFractionDigits: dp, minimumFractionDigits: dp })

const stacAtomToSol = (atom: bigint | string, nav: number | null, payout: number): number | null => {
  if (nav == null) return null
  const big = typeof atom === 'bigint' ? atom : BigInt(atom || '0')
  return (Number(big) / 1e9) * nav * payout
}
const lamportsToSol = (lam: bigint | string): number =>
  Number(typeof lam === 'bigint' ? lam : BigInt(lam || '0')) / LAMPORTS_PER_SOL

const MEDALS = ['🥇', '🥈', '🥉']

export function ReferralLeaderboard() {
  const { publicKey } = useWallet()
  const ref = useReferrer()
  const [data, setData] = useState<LeaderboardResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [includeHouse, setIncludeHouse] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [copiedLink, setCopiedLink] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const url = `/api/leaderboard?limit=50${includeHouse ? '&includeHouse=true' : ''}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as Omit<LeaderboardResponse, 'rows'> & {
          rows: Omit<LeaderboardRow, 'wallet'>[]
        }
        if (!cancelled) {
          setData({ ...json, rows: json.rows.map((r) => ({ ...r, wallet: r.referrer })) })
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
  }, [includeHouse, refreshTick])

  const myPk = publicKey?.toBase58() ?? null
  const myRow = useMemo(() => data?.rows.find((r) => r.referrer === myPk) ?? null, [data, myPk])

  const nav = data?.navRate ?? null
  const payout = data?.payoutFraction ?? 0.931
  const rows = data?.rows ?? []
  const topFeeAtom = rows.length ? Number(BigInt(rows[0].feeStacsol || '0')) : 1

  const copyAddr = async (pk: string) => {
    try {
      await navigator.clipboard.writeText(pk)
      setCopiedKey(pk)
      setTimeout(() => setCopiedKey((k) => (k === pk ? null : k)), 1500)
    } catch { /* ignore */ }
  }

  const shareUrl = publicKey ? ref.buildShareUrl(publicKey) : null
  const copyLink = async () => {
    if (!shareUrl) return
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1500)
    } catch { /* ignore */ }
  }
  const tweetHref = shareUrl
    ? `https://twitter.com/intent/tweet?text=${encodeURIComponent(
        `🔥 mint $stacSOL via my link — I earn 3.45% of every referred mint as stacSOL\n${shareUrl}`,
      )}`
    : '#'

  const totalFeeSol = data ? stacAtomToSol(data.totals.feeStacsol, nav, payout) : null
  const totalReferred = data ? lamportsToSol(data.totals.solReferred) : 0

  const myFeeSol = myRow ? stacAtomToSol(myRow.feeStacsol, nav, payout) : null
  const myReferred = myRow ? lamportsToSol(myRow.solReferred) : 0

  return (
    <Card title="🏆 Referral leaderboard · earn 3.45% of every referred mint">
      {/* Totals strip */}
      {data && (
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 mb-4 text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
          <Stat n={data.totals.referrers.toLocaleString()} label="referrers" />
          <Stat n={data.totals.depositors.toLocaleString()} label="referred" />
          <Stat n={fmtSol(totalReferred, 0)} label="SOL volume" />
          <Stat
            n={totalFeeSol != null ? `${fmtSol(totalFeeSol)} ◎` : `${fmtAmount(BigInt(data.totals.feeStacsol))}`}
            label="paid to referrers"
            hot
          />
        </div>
      )}

      {/* YOUR share-link hero */}
      <div className="mb-5 rounded-lg border border-[rgb(255_119_51_/_0.45)] bg-gradient-to-br from-[rgb(255_119_51_/_0.10)] to-[rgb(255_34_0_/_0.04)] p-3.5">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <span className="text-[10px] uppercase tracking-[2px] text-[var(--color-ember)] font-black">
            your referral link
          </span>
          {myRow && (
            <span className="text-[11px] font-black text-[var(--color-fg)]">
              you&apos;re{' '}
              <span className="text-[var(--color-ember)]">#{myRow.rank}</span>
              {nav != null && myFeeSol != null && (
                <span className="text-[var(--color-green)] ml-1.5 font-mono">
                  +{fmtSol(myFeeSol)} ◎ earned
                </span>
              )}
            </span>
          )}
          {publicKey && !myRow && (
            <span className="text-[10px] text-[var(--color-dim)]">
              no referrals yet — share to get on the board
            </span>
          )}
        </div>
        {shareUrl ? (
          <div className="grid grid-cols-[1fr_auto_auto] gap-2">
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full px-3 py-2 bg-[var(--color-bg)] text-[var(--color-fg)] border border-[rgb(255_51_0_/_0.4)] rounded font-mono text-[11px] focus:outline-none focus:border-[var(--color-hot)]"
            />
            <button
              type="button"
              onClick={copyLink}
              className="px-3 py-2 bg-[var(--color-hot)] text-black font-black uppercase tracking-wider text-[11px] rounded hover:brightness-110"
            >
              {copiedLink ? '✓' : 'copy'}
            </button>
            <a
              href={tweetHref}
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-2 border border-[var(--color-hot)] text-[var(--color-hot)] rounded hover:bg-[var(--color-hot)] hover:text-black transition-colors grid place-items-center"
              title="Tweet your link"
            >
              <TwitterBird className="w-4 h-4" />
            </a>
          </div>
        ) : (
          <div className="px-3 py-2 bg-[var(--color-bg)] text-[var(--color-dim)] border border-[rgb(255_51_0_/_0.2)] rounded font-mono text-[11px]">
            connect wallet to generate your share link
          </div>
        )}
        {myRow && (
          <div className="mt-2 flex items-center justify-between gap-2 flex-wrap text-[10px] text-[var(--color-dim)] font-mono">
            <span>{fmtSol(myReferred, 2)} ◎ referred · {myRow.deposits} deposits</span>
            <DoxxToggle row={myRow} onChanged={() => setRefreshTick((t) => t + 1)} />
          </div>
        )}
      </div>

      {error && <div className="text-[11px] text-[var(--color-warn)] mb-3">could not load leaderboard: {error}</div>}
      {!data && !error && (
        <div className="text-[11px] text-[var(--color-dim)] uppercase tracking-[2px] py-3">loading…</div>
      )}

      {/* Podium — top 3 */}
      {rows.length >= 3 && (
        <div className="grid grid-cols-3 gap-2 mb-4 items-end">
          {[1, 0, 2].map((idx) => {
            const row = rows[idx]
            if (!row) return <div key={idx} />
            const feeSol = stacAtomToSol(row.feeStacsol, nav, payout)
            const isMe = row.referrer === myPk
            const raised = idx === 0
            return (
              <div
                key={row.referrer}
                className={`rounded-lg border text-center px-2 pt-3 pb-2.5 ${
                  raised ? 'pb-4 -mt-2' : ''
                } ${
                  isMe
                    ? 'border-[var(--color-ember)] bg-[rgb(255_119_51_/_0.12)]'
                    : idx === 0
                      ? 'border-[rgb(255_204_0_/_0.55)] bg-[rgb(255_204_0_/_0.07)]'
                      : 'border-[rgb(255_51_0_/_0.25)] bg-[var(--color-bg)]'
                }`}
              >
                <div className={`${raised ? 'text-3xl' : 'text-2xl'} leading-none mb-1`}>{MEDALS[idx]}</div>
                <div className="flex justify-center scale-90 origin-top">
                  <WalletIdentity row={row} isMe={isMe} copy={copyAddr} copiedKey={copiedKey} />
                </div>
                <div className="mt-1.5 text-[var(--color-green)] font-black text-[13px] font-mono">
                  {feeSol != null ? `${fmtSol(feeSol)} ◎` : `${fmtAmount(BigInt(row.feeStacsol))}`}
                </div>
                <div className="text-[9px] uppercase tracking-[1.5px] text-[var(--color-dim)]">
                  {fmtSol(lamportsToSol(row.solReferred), 0)} ◎ referred
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Ranked list with fee bars (rank 4+, or all if <3) */}
      {rows.length > 0 && (
        <div className="space-y-1">
          {(rows.length >= 3 ? rows.slice(3) : rows).map((row) => {
            const isMe = row.referrer === myPk
            const feeAtom = BigInt(row.feeStacsol || '0')
            const feeSol = stacAtomToSol(feeAtom, nav, payout)
            const barPct = topFeeAtom > 0 ? Math.max(3, (Number(feeAtom) / topFeeAtom) * 100) : 3
            return (
              <div
                key={row.referrer}
                className={`relative overflow-hidden rounded px-2.5 py-1.5 flex items-center gap-2 ${
                  isMe ? 'border border-[rgb(255_119_51_/_0.5)] bg-[rgb(255_119_51_/_0.06)]' : ''
                }`}
              >
                {/* fee bar */}
                <div
                  className="absolute inset-y-0 left-0 bg-[rgb(255_34_0_/_0.07)] rounded"
                  style={{ width: `${barPct}%` }}
                  aria-hidden
                />
                <span className="relative w-6 text-right text-[var(--color-dim)] font-black text-[11px] tabular-nums">
                  {row.rank}
                </span>
                <div className="relative flex-1 min-w-0 flex items-center gap-2">
                  <WalletIdentity row={row} isMe={isMe} copy={copyAddr} copiedKey={copiedKey} />
                  {row.isMarketing && <Tag label="default" warn />}
                  {row.isManager && <Tag label="house" warn />}
                </div>
                <div className="relative text-right">
                  <div className="text-[var(--color-green)] font-bold text-[12px] font-mono leading-tight">
                    {feeSol != null ? `${fmtSol(feeSol)} ◎` : fmtAmount(feeAtom)}
                  </div>
                  <div className="text-[9px] text-[var(--color-dim)] tabular-nums">
                    {fmtSol(lamportsToSol(row.solReferred), 0)} ◎ · {row.deposits}×
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {data && rows.length === 0 && (
        <div className="text-[11px] text-[var(--color-dim)] py-3">
          no referral credits indexed yet — check back in a few minutes.
        </div>
      )}

      {/* Footer: house toggle + provenance */}
      <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => setIncludeHouse((v) => !v)}
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-fg)] underline-offset-2 hover:underline"
          title="The default + manager house wallets self-refer; hidden by default."
        >
          {includeHouse ? 'hide house wallets' : 'show house wallets'}
        </button>
        <span className="text-[9px] text-[var(--color-dim)]">
          ◎ = SOL value @ burn (NAV × 0.931) · updates ~5 min
        </span>
      </div>
    </Card>
  )
}

function Stat({ n, label, hot }: { n: string; label: string; hot?: boolean }) {
  return (
    <span>
      <span className={`font-mono normal-case tracking-normal ${hot ? 'text-[var(--color-green)]' : 'text-[var(--color-fg)]'}`}>
        {n}
      </span>{' '}
      {label}
    </span>
  )
}

function Tag({ label, warn }: { label: string; warn?: boolean }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-[8px] uppercase tracking-[2px] font-black border ${
        warn
          ? 'border-[var(--color-warn)] text-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)]'
          : 'border-[var(--color-dim)] text-[var(--color-dim)]'
      }`}
    >
      {label}
    </span>
  )
}
