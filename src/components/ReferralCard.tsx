// ReferralCard — editorial-design surface for the stake-pool referral fee.
//
// Three states:
//   1. Wallet not connected → show how the program splits the deposit fee
//      and explain that connecting unlocks a personal share link.
//   2. Wallet connected, using marketing default referrer → show the user's
//      personal share link they can copy/share to start collecting.
//   3. Wallet connected, browsing under someone else's `?ref=…` → show
//      whose link they're using + offer to clear it before minting.
//
// All numbers are stated as fractions of the deposit, not absolute SOL, so
// the copy stays correct as users mint different amounts.

import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { useReferrer } from '../lib/referrer'
import { shortPk } from '../lib/format'

export function ReferralCard() {
  const wallet = useWallet()
  const ref = useReferrer()
  const [copied, setCopied] = useState(false)

  const shareUrl = wallet.publicKey ? ref.buildShareUrl(wallet.publicKey) : null
  const usingOverride = ref.isExplicit && !ref.isMarketingDefault
  const usingOverrideAndItsNotMe =
    usingOverride && wallet.publicKey != null && !ref.referrer.equals(wallet.publicKey)

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable — user can long-press the input */
    }
  }

  return (
    <div
      className="position"
      style={{ marginTop: 20, paddingBlock: 22, paddingInline: 22 }}
    >
      <div className="position-head" style={{ marginBottom: 14 }}>
        <h3 className="position-h" style={{ fontSize: 22 }}>
          Your referral
        </h3>
        <span
          className={`live-chip ${wallet.connected ? '' : 'dim'}`}
          style={{ padding: '2px 8px', fontSize: 9 }}
        >
          <span className="dot" />
          {usingOverride
            ? usingOverrideAndItsNotMe
              ? 'using friend'
              : 'self'
            : 'marketing default'}
        </span>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 13.5,
          lineHeight: 1.55,
          color: 'var(--ink-soft)',
        }}
      >
        Every mint pays a 6.9% deposit fee. The pool splits it 50 / 50 — half
        to the protocol, half to <b>whoever the referrer ATA points at</b>.
        Your link drops you into that slot for everyone who mints through
        it. Compounds with every deposit, forever.
      </p>

      {usingOverrideAndItsNotMe && (
        <div className="status work" style={{ marginTop: 14 }}>
          <span style={{ fontSize: 14, lineHeight: 1 }}>↻</span>
          <div style={{ flex: 1 }}>
            <div>
              You're minting under{' '}
              <b className="mono">{shortPk(ref.referrer.toBase58())}</b>'s
              link.
            </div>
            <button
              onClick={ref.clear}
              style={{
                marginTop: 8,
                fontSize: 11,
                fontFamily: 'var(--f-mono)',
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--accent-deep)',
                borderBottom: '1px dashed currentColor',
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
              }}
            >
              clear & use my own
            </button>
          </div>
        </div>
      )}

      {wallet.connected && shareUrl ? (
        <div style={{ marginTop: 18 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>
            share link
          </div>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'stretch',
              borderRadius: 10,
              border: '1px solid var(--line)',
              padding: 4,
              background: 'var(--bg-soft)',
            }}
          >
            <input
              readOnly
              value={shareUrl}
              onFocus={e => e.currentTarget.select()}
              className="mono"
              style={{
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 0,
                padding: '8px 10px',
                fontSize: 12,
                color: 'var(--ink-soft)',
                outline: 'none',
              }}
            />
            <button
              onClick={() => copy(shareUrl)}
              style={{
                padding: '8px 14px',
                fontSize: 11,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                fontFamily: 'var(--f-mono)',
                color: 'var(--bg)',
                background: 'var(--ink)',
                borderRadius: 8,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {copied ? '✓ copied' : 'copy'}
            </button>
          </div>
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              gap: 12,
              flexWrap: 'wrap',
            }}
          >
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
                "minting stacSOL — yield-as-deflation, monotonically up. NAV's mine if you mint through:",
              )}&url=${encodeURIComponent(shareUrl)}`}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 11,
                fontFamily: 'var(--f-mono)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--accent-deep)',
                borderBottom: '1px dashed currentColor',
              }}
            >
              share on x
            </a>
            <a
              href={`https://t.me/share/url?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(
                'mint stacSOL through my link — half the deposit fee comes back to me, the rest funds NAV',
              )}`}
              target="_blank"
              rel="noreferrer"
              style={{
                fontSize: 11,
                fontFamily: 'var(--f-mono)',
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--accent-deep)',
                borderBottom: '1px dashed currentColor',
              }}
            >
              share on telegram
            </a>
          </div>
        </div>
      ) : (
        <p
          style={{
            marginTop: 16,
            marginBottom: 0,
            fontSize: 12,
            fontFamily: 'var(--f-mono)',
            letterSpacing: '0.02em',
            color: 'var(--ink-muted)',
          }}
        >
          connect wallet to get your share link.
        </p>
      )}
    </div>
  )
}
