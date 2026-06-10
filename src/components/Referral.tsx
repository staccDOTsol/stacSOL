// Referral / share-link card.
//
// Shows the user three things:
//
//   1. Where the deposit-fee referral share is currently going (marketing
//      default vs explicit override from `?ref=…`).
//   2. The user's personal share link (when wallet connected) so they can
//      redirect that fee to their own wallet on every deposit they refer.
//   3. The math: 50% × 6.9% deposit fee = ~3.45% of every referred SOL
//      deposit lands as stacSOL in the referrer's ATA.
//
// We're upfront about the marketing-budget default — anyone landing on
// the site without a `?ref=` link is funding stacc's marketing wallet
// (3.45% of their mint), and the card says so plainly. Override by
// pasting any wallet's `?ref=<pubkey>` link or by sharing your own.

import { useEffect, useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { Card } from './Stats'
import { MARKETING_REFERRER, useReferrer } from '../lib/referrer'
import { TwitterBird } from './icons'

export function Referral() {
  const { publicKey } = useWallet()
  const ref = useReferrer()
  const [copied, setCopied] = useState(false)

  // Reset the "copied!" pill after 1.5s so it doesn't stick forever.
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])

  const shareUrl = publicKey ? ref.buildShareUrl(publicKey) : null
  const refStr = ref.referrer.toBase58()
  const refShort = `${refStr.slice(0, 6)}…${refStr.slice(-4)}`

  return (
    <Card title="Referral · earn 3.45% of every referred mint">
      {/* Status row — what's currently set + override hint */}
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-[var(--color-dim)] uppercase tracking-wider text-[10px]">
          fee going to:
        </span>
        {ref.isMarketingDefault ? (
          <>
            <span className="px-2 py-0.5 rounded border border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)] text-[var(--color-warn)] font-black text-[10px] uppercase tracking-[2px]">
              marketing budget
            </span>
            <span className="font-mono text-[var(--color-dim)]" title={refStr}>
              {refShort}
            </span>
          </>
        ) : (
          <>
            <span className="px-2 py-0.5 rounded border border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.08)] text-[var(--color-hot)] font-black text-[10px] uppercase tracking-[2px]">
              custom referrer
            </span>
            <a
              href={`https://solscan.io/account/${refStr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-[var(--color-fg)] hover:text-[var(--color-hot)] no-underline"
              title={refStr}
            >
              {refShort}
            </a>
            <button
              type="button"
              onClick={() => ref.clear()}
              className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] hover:text-[var(--color-warn)] underline-offset-2 hover:underline"
              title="Reset to marketing default"
            >
              reset
            </button>
          </>
        )}
      </div>

      {/* Plain-English explainer of the fee math + the marketing default */}
      <p className="mt-3 mb-0 text-[11px] leading-relaxed text-[var(--color-dim)]">
        Every SOL → stacSOL mint pays a{' '}
        <span className="text-[var(--color-fg)] font-mono">6.9%</span> deposit fee.
        The pool splits it 50/50:{' '}
        <span className="text-[var(--color-fg)]">manager (stacc)</span> takes one
        half, the <span className="text-[var(--color-fg)]">referrer</span> takes
        the other half ({' '}
        <span className="text-[var(--color-fg)] font-mono">≈3.45%</span> of every
        referred deposit, paid as stacSOL into the referrer&apos;s ATA).
        {ref.isMarketingDefault ? (
          <>
            {' '}
            <span className="text-[var(--color-warn)]">
              By default that 3.45% lands in the marketing wallet
            </span>{' '}
            ({refShort}). It funds shitposts, ad buys, and bagholder dinners.
            Share <em>your</em> link below to redirect it to your own wallet on
            every deposit signed through it.
          </>
        ) : (
          <>
            {' '}
            You&apos;re currently routing referrals to{' '}
            <span className="text-[var(--color-fg)] font-mono">{refShort}</span>{' '}
            — every mint you sign on this page sends them ≈3.45% as stacSOL.
          </>
        )}
      </p>

      {/* Personal share link — only meaningful when a wallet is connected */}
      <div className="mt-4">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] mb-1">
          your share link
        </div>
        {shareUrl ? (
          <>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input
                readOnly
                value={shareUrl}
                onFocus={(e) => e.currentTarget.select()}
                className="w-full px-3 py-2 bg-[var(--color-bg)] text-[var(--color-fg)] border border-[rgb(255_51_0_/_0.4)] rounded font-mono text-[11px] focus:outline-none focus:border-[var(--color-hot)]"
              />
              <button
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(shareUrl)
                    setCopied(true)
                  } catch {
                    // Clipboard API blocked (insecure origin / permission denied).
                    // Fall through silently — the input is selected for manual copy.
                  }
                }}
                className="px-3 py-2 bg-[var(--color-hot)] text-black font-bold uppercase tracking-wider rounded hover:brightness-110"
              >
                {copied ? '✓' : 'copy'}
              </button>
            </div>
            <a
              href={buildReferralTweetIntent(shareUrl)}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 flex items-center justify-center gap-2.5 px-4 py-3 border border-[var(--color-hot)] text-[var(--color-hot)] rounded font-black uppercase tracking-[2px] text-xs hover:bg-[var(--color-hot)] hover:text-black transition-colors"
            >
              <TwitterBird className="w-4 h-4" />
              <span>Tweet your link</span>
            </a>
            <details className="mt-2 group">
              <summary className="cursor-pointer text-[10px] uppercase tracking-[2px] text-[var(--color-dim)] hover:text-[var(--color-ember)] transition-colors list-none flex items-center gap-1.5">
                <span className="inline-block transition-transform group-open:rotate-90 text-[var(--color-hot)]">
                  ▸
                </span>
                preview tweet
              </summary>
              <pre className="mt-2 p-3 bg-[var(--color-bg)] border border-[rgb(255_34_0_/_0.1)] rounded text-[11px] text-[var(--color-fg)] leading-relaxed whitespace-pre-wrap break-words">
                {buildReferralTweetText(shareUrl)}
              </pre>
            </details>
          </>
        ) : (
          <div className="px-3 py-2 bg-[var(--color-bg)] text-[var(--color-dim)] border border-[rgb(255_51_0_/_0.2)] rounded font-mono text-[11px]">
            connect wallet to generate your share link
          </div>
        )}
        <p className="mt-2 mb-0 text-[10px] text-[var(--color-dim)]">
          Anyone who lands on stacsol.app via your link will pay 3.45% of every
          mint into your wallet (as stacSOL). The link sticks across navigation
          via localStorage, so they only need to click it once to be tagged.
        </p>
      </div>
    </Card>
  )
}

/**
 * Build the templated tweet body for the referral share button. Sized for
 * X's free-tier 280-char weighted cap (URLs count as 23 regardless of
 * length, emoji count as 2). Total weighted length below: ~210 chars,
 * leaving margin if X tweaks the rules. Same vibe as the pool/position
 * tweets in `TweetButton.tsx` but framed around the referrer-earnings
 * pitch — "use my link, I get 3.45% of your mint as stacSOL".
 */
function buildReferralTweetText(shareUrl: string): string {
  const lines = [
    '🔥 mint $stacSOL via my link',
    '',
    'NAV-only LST · 6.9% in/out · every trade burns 6.9% on stacSOL → rate climbs · volume IS yield',
    '',
    '↓ 3.45% of every referred mint comes back to me as stacSOL',
    shareUrl,
  ]
  return lines.join('\n')
}

function buildReferralTweetIntent(shareUrl: string): string {
  return `https://twitter.com/intent/tweet?text=${encodeURIComponent(buildReferralTweetText(shareUrl))}`
}

// Lazy-loaded so the marketing-wallet pubkey constant isn't re-imported
// from elsewhere; keeps the dep graph linear.
export const REFERRAL_DEFAULT_PUBKEY = MARKETING_REFERRER
