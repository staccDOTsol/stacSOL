import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { useWallet } from '@solana/wallet-adapter-react'
import { Card } from './Stats'
import { GROSS_APR } from '../lib/constants'
import { computeApr } from '../lib/apr'
import { useDeployTs } from '../hooks/useDeployTs'
import { computePnL, type Position } from '../lib/position'
import type { PoolState } from '../lib/pool'
import { TwitterBird } from './icons'
import { useReferrer } from '../lib/referrer'

/**
 * Two tweets, two buttons. "Tweet pool" composes a pool-stats snapshot;
 * "Tweet position" composes the connected wallet's holding + P&L. Both
 * target X — no Bluesky, just tweets.
 *
 * If the user has a wallet connected, every shared URL is auto-tagged
 * with their personal `?ref=<pubkey>` link. Anyone who lands on the
 * site through that tweet pays 3.45% of their mint into the connected
 * wallet's stacSOL ATA. No extra step — tweeting IS referring.
 */
export function TweetButton({
  pool,
  position,
}: {
  pool: PoolState | null
  position: Position | null
}) {
  const deployTs = useDeployTs()
  const { publicKey } = useWallet()
  const ref = useReferrer()
  if (!pool) return null

  // Personal ref URL when wallet's connected; otherwise use whatever
  // referrer is currently active (could be marketing default OR a custom
  // ref the user landed via). Either way, the tweet propagates SOMEONE's
  // ref so the click chain stays attributed.
  const shareUrl = publicKey
    ? ref.buildShareUrl(publicKey)
    : ref.buildShareUrl(ref.referrer)
  const usingPersonalRef = publicKey != null
  // Compact tagline — 31 weighted chars (↑ counts as 2). Keeps room under
  // X's 280-cap when added to either the pool or position template.
  const refTagline = usingPersonalRef
    ? '↑ 3.45% kicked back via my link'
    : null

  const rate =
    pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : 1
  const { apr } = computeApr(rate, deployTs)
  const pnl = position ? computePnL(position, rate) : null
  const hasPosition =
    !!position && position.balance > 0n && pnl?.pnlOnBurnLamports != null
  const profitable = pnl?.profitableToBurn === true

  // ---- pool tweet ---------------------------------------------------------
  // Free-tier X cap is 280 weighted chars (URL = 23 regardless of length,
  // emoji ~= 2). Templates below sit well under that with the personal-ref
  // tagline attached. CA pubkey alone is 44 chars so we drop it from the
  // body — the URL goes to the dapp, which surfaces CA prominently.
  const poolLines: string[] = []
  poolLines.push('🔥 $stacSOL — NAV-only LST · 6.9% in/out')
  poolLines.push('')
  poolLines.push(
    apr != null
      ? `rate ${rate.toFixed(4)} · APR ${(apr * 100).toFixed(0)}%`
      : `rate ${rate.toFixed(4)} · ~${(GROSS_APR * 100).toFixed(0)}% floor + burn`,
  )
  poolLines.push(
    'every cross-pair trade burns 6.9% on stacSOL → NAV climbs · volume IS yield',
  )
  poolLines.push('')
  poolLines.push(shareUrl)
  if (refTagline) poolLines.push(refTagline)
  const poolText = poolLines.join('\n')

  // ---- position tweet -----------------------------------------------------
  let positionText: string | null = null
  if (hasPosition && pnl) {
    const balance = (Number(position!.balance) / 1e9).toFixed(4)
    const pnlLam = pnl.pnlOnBurnLamports!
    const sign = pnlLam >= 0n ? '+' : '−'
    const abs = pnlLam < 0n ? -pnlLam : pnlLam
    const pnlSol = (Number(abs) / LAMPORTS_PER_SOL).toFixed(4)
    const pnlPct =
      pnl.pnlOnBurnPct != null
        ? `${pnlLam >= 0n ? '+' : ''}${(pnl.pnlOnBurnPct * 100).toFixed(2)}%`
        : ''
    const lines: string[] = []
    lines.push(`🔥 my $stacSOL bag · ${balance} @ rate ${rate.toFixed(4)}`)
    lines.push('')
    lines.push(
      `burn P&L: ${sign}${pnlSol} SOL (${pnlPct}) ${profitable ? '✓' : '⏳'}`,
    )
    lines.push('')
    lines.push('NAV-only LST · every trade burns 6.9% on stacSOL → rate ratchets')
    lines.push('')
    lines.push(shareUrl)
    if (refTagline) lines.push(refTagline)
    positionText = lines.join('\n')
  }

  return (
    <Card title="Share">
      <div className={`grid gap-3 ${positionText ? 'grid-cols-2' : 'grid-cols-1'}`}>
        <ShareLink href={tweetIntent(poolText)}>
          Tweet pool
        </ShareLink>
        {positionText && (
          <ShareLink href={tweetIntent(positionText)}>Tweet position</ShareLink>
        )}
      </div>

      <p className="mt-3 mb-0 text-[10px] text-[var(--color-dim)] leading-relaxed">
        {usingPersonalRef ? (
          <>
            <span className="text-[var(--color-green)] font-black uppercase tracking-wider">
              ref auto-attached
            </span>{' '}
            — tweets embed{' '}
            <code className="text-[var(--color-fg)] font-mono">
              ?ref={publicKey!.toBase58().slice(0, 4)}…{publicKey!.toBase58().slice(-4)}
            </code>
            . Mints through this tweet earn you 3.45% as stacSOL.
          </>
        ) : ref.isMarketingDefault ? (
          <>
            no wallet connected — tweets link to{' '}
            <code className="text-[var(--color-fg)] font-mono">stacsol.app</code>{' '}
            with the marketing default ref. Connect to attach{' '}
            <em>your</em> wallet and earn 3.45% on referred mints.
          </>
        ) : (
          <>
            no wallet connected — tweets propagate the current{' '}
            <code className="text-[var(--color-fg)] font-mono">?ref=…</code>{' '}
            (someone else&apos;s). Connect to attribute mints to{' '}
            <em>your</em> wallet instead.
          </>
        )}
      </p>

      <details className="mt-4 group">
        <summary className="cursor-pointer text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-ember)] transition-colors list-none flex items-center gap-1.5">
          <span className="inline-block transition-transform group-open:rotate-90 text-[var(--color-hot)]">
            ▸
          </span>
          preview
        </summary>
        <div className="mt-3 space-y-3">
          <Preview label="Tweet pool" text={poolText} />
          {positionText && <Preview label="Tweet position" text={positionText} />}
        </div>
      </details>
    </Card>
  )
}

function tweetIntent(text: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`
}

function ShareLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center justify-center gap-2.5 px-4 py-3 border border-[var(--color-hot)] text-[var(--color-hot)] rounded font-black uppercase tracking-[2px] text-xs hover:bg-[var(--color-hot)] hover:text-black transition-colors"
    >
      <TwitterBird className="w-4 h-4" />
      <span>{children}</span>
    </a>
  )
}

function Preview({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="text-[9px] font-black uppercase tracking-[3px] text-[var(--color-dim)] mb-1.5">
        {label}
      </div>
      <pre className="m-0 p-3 bg-[var(--color-bg)] border border-[rgb(255_34_0_/_0.1)] rounded text-[11px] text-[var(--color-fg)] leading-relaxed whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  )
}
