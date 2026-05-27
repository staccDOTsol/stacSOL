// Shared sticky editorial nav — used on Landing, App, Terms, Portfolio,
// Leaderboard, Faq. Provides:
//   • brand mark linking home
//   • route links (active state via current pathname)
//   • theme toggle (ivory ↔ ink, syncs with useTheme)
//   • prominent Mint CTA (jade pill, "Connect to Mint" when wallet absent on
//     /app, "Mint stacSOL" elsewhere)
//
// Important: the component renders editorial-design markup (.nav .nav-inner
// .nav-mark .nav-links etc) defined in stacsol.css. It assumes
// body[data-design="editorial"] is set somewhere up the tree so the
// stylesheet's selectors actually fire.

import { useEffect, useMemo, useState } from 'react'
import { useTheme } from '../hooks/useTheme'

interface Props {
  /** Override of current pathname (useful in SSR or testing). Defaults to
   *  window.location.pathname. */
  pathname?: string
  /** What the right-hand CTA should say. Defaults to "Mint stacSOL". On the
   *  /app route the parent typically passes "Connect to Mint" when the
   *  wallet is disconnected, then swaps in a wallet-pill when connected. */
  ctaLabel?: string
  /** Optional element to render in place of the default Mint CTA — used by
   *  /app's Nav so it can swap in a wallet pubkey pill when connected. */
  ctaSlot?: React.ReactNode
}

const NAV_LINKS = [
  { id: '/', label: 'Home' },
  { id: '/app', label: 'App' },
  { id: '/portfolio', label: 'Portfolio' },
  { id: '/leaderboard', label: 'Leaderboard' },
  { id: 'https://yal.fun', label: 'YAL.fun', external: true },
  { id: '/faq', label: 'FAQ' },
  { id: '/terms', label: 'Terms' },
]

// Routes that don't fit on the desktop nav strip but should still be one tap
// away on mobile — surfaced via the hamburger drawer.
const MORE_LINKS = [
  { id: '/wrap', label: 'Wrap', sub: 'stacSOL ↔ wstacSOL · one-click for ride.markets' },
  { id: '/liquidity', label: 'Liquidity', sub: 'Raydium CPMM zap-in / zap-out' },
  { id: '/singlesided', label: 'Single-sided', sub: 'Meteora DLMM concentrated LP' },
  { id: '/liqmonsta', label: 'Liqmonsta', sub: 'Auto-rebalance LP smasher' },
  { id: '/guide', label: 'Guide', sub: 'SOL of the thystaccfloweth' },
  { id: '/baitscope', label: 'Baitscope', sub: 'Flywheel feed · trades & burns' },
]

function ThemeButton() {
  const { theme, toggle } = useTheme()
  const isInk = theme === 'dark'
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label={`Switch to ${isInk ? 'ivory' : 'ink'} theme`}
      title={`Switch to ${isInk ? 'ivory' : 'ink'} theme`}
      onClick={toggle}
    >
      <svg
        className="sun"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
      <svg
        className="moon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
      </svg>
    </button>
  )
}

function MintCta({ label }: { label: string }) {
  return (
    <a
      href="/app"
      className="nav-cta"
      style={{
        background: 'var(--accent-deep)',
        color: 'var(--bg)',
        padding: '11px 20px',
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: '0.01em',
      }}
    >
      <span className="pulse" />
      {label}
      <span style={{ marginLeft: 2 }} aria-hidden>
        →
      </span>
    </a>
  )
}

function HamburgerButton({
  open,
  onClick,
}: {
  open: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`nav-burger ${open ? 'is-open' : ''}`}
      aria-label={open ? 'Close menu' : 'Open menu'}
      aria-expanded={open}
      onClick={onClick}
    >
      <span />
      <span />
      <span />
    </button>
  )
}

function MobileDrawer({
  open,
  onClose,
  path,
}: {
  open: boolean
  onClose: () => void
  path: string
}) {
  // Lock body scroll while the drawer is open so the page underneath doesn't
  // jitter when the user pans the menu.
  useEffect(() => {
    if (!open) return
    const prev = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    const onEsc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onEsc)
    return () => {
      document.documentElement.style.overflow = prev
      window.removeEventListener('keydown', onEsc)
    }
  }, [open, onClose])

  const isActive = (id: string) =>
    id === '/' ? path === '/' : path === id || path.startsWith(id + '/')

  return (
    <>
      <div
        className={`nav-scrim ${open ? 'is-open' : ''}`}
        onClick={onClose}
        aria-hidden
      />
      <aside
        className={`nav-drawer ${open ? 'is-open' : ''}`}
        aria-hidden={!open}
      >
        <div className="nav-drawer-section">
          <div className="nav-drawer-eyebrow">core</div>
          {NAV_LINKS.map(l => (
            <a
              key={l.id}
              href={l.id}
              className={isActive(l.id) ? 'active' : ''}
              onClick={onClose}
            >
              <span>{l.label}</span>
              <span className="arrow">→</span>
            </a>
          ))}
        </div>
        <div className="nav-drawer-section">
          <div className="nav-drawer-eyebrow">other surfaces</div>
          {MORE_LINKS.map(l => (
            <a
              key={l.id}
              href={l.id}
              className={isActive(l.id) ? 'active' : ''}
              onClick={onClose}
            >
              <span>
                <span className="k">{l.label}</span>
                <span className="sub">{l.sub}</span>
              </span>
              <span className="arrow">→</span>
            </a>
          ))}
        </div>
        <div className="nav-drawer-foot">
          <a
            href="https://x.com/thystaccfloweth"
            target="_blank"
            rel="noreferrer"
          >
            X / @thystaccfloweth
          </a>
          <a
            href="https://github.com/staccDOTsol/stacSOL"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </aside>
    </>
  )
}

// Sticky validator-pointer banner — TL;DR of stacSOL's backing infra so
// visitors can independently verify the validator is real, live, and ours.
// Dismissal persists via localStorage; bump BANNER_VERSION to re-show after
// material updates. The previous FOMOX402 → stacSOL migration banner shipped
// under the '2026-05-25-stacsol' version key and is now retired.
const BANNER_VERSION = '2026-05-27-validator'
const BANNER_KEY = `stacsol_banner_dismissed_${BANNER_VERSION}`
const VALIDATOR_URL =
  'https://www.validators.app/validators/3ENj7S6zgjbkH1dLx6okTeLu6n1SPbHn4vCc2KD7r5GF?locale=en&network=mainnet'

function MigrationBanner() {
  const [dismissed, setDismissed] = useState<boolean | null>(null)
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(BANNER_KEY) === '1')
    } catch {
      setDismissed(false)
    }
  }, [])
  if (dismissed !== false) return null
  // Hardcoded colors instead of theme vars — `--ink` and `--ivory` invert
  // meaning between light/dark mode (they're page text/page paper, not
  // fixed paint values), so using them as banner background made the
  // text vanish in light mode (light text on light page bg). Banner
  // wants to be a constant-dark surface across BOTH themes so the
  // editorial palette stays calm and the announcement stays legible.
  const BANNER_BG = '#0a0a0a'
  const BANNER_FG = '#f7f5ee'
  const BANNER_LINE = 'rgba(255,255,255,0.18)'
  const BANNER_LINK = '#7BE0A4'
  return (
    <div
      role="region"
      aria-label="stacSOL validator announcement"
      style={{
        background: BANNER_BG,
        color: BANNER_FG,
        borderBottom: `1px solid ${BANNER_LINE}`,
        fontFamily: 'var(--f-sans)',
        fontSize: 13,
        lineHeight: 1.45,
        position: 'sticky',
        top: 0,
        zIndex: 1000,
      }}
    >
      <div
        className="shell"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '8px 0',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ flex: '1 1 auto', minWidth: 220, color: BANNER_FG }}>
          <strong style={{ fontFamily: 'var(--f-display)', letterSpacing: '0.01em', color: BANNER_FG }}>
            stacSOL validator is live.
          </strong>{' '}
          We run our own node on patched agave with native TowerSync vote
          batching · 100% commission · every lamport of yield compounds into
          NAV. Independently verify on{' '}
          <a
            href={VALIDATOR_URL}
            target="_blank"
            rel="noreferrer"
            style={{
              color: BANNER_LINK,
              textDecoration: 'underline',
              textDecorationThickness: 1,
              textUnderlineOffset: 2,
            }}
          >
            validators.app
          </a>
          . Vote account{' '}
          <code style={{ fontFamily: 'var(--f-mono)', fontSize: 11, color: BANNER_FG }}>
            3ENj…r5GF
          </code>
          .
        </span>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(BANNER_KEY, '1')
            } catch {
              /* fall through */
            }
            setDismissed(true)
          }}
          aria-label="Dismiss"
          style={{
            border: `1px solid ${BANNER_LINE}`,
            background: 'transparent',
            color: BANNER_FG,
            fontFamily: 'var(--f-mono)',
            fontSize: 11,
            letterSpacing: '0.04em',
            padding: '4px 10px',
            cursor: 'pointer',
            flex: '0 0 auto',
          }}
        >
          DISMISS ✕
        </button>
      </div>
    </div>
  )
}

export default function EditorialNav({
  pathname,
  ctaLabel = 'Mint stacSOL',
  ctaSlot,
}: Props) {
  const path = useMemo(
    () => pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/'),
    [pathname],
  )
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <>
      <MigrationBanner />
      <nav className="nav">
        <div className="shell nav-inner">
          <a href="/" className="nav-mark">
            stacSOL
          </a>
          <div className="nav-links">
            {NAV_LINKS.map(l => (
              <a
                key={l.id}
                href={l.id}
                // @ts-ignore
                target={l.external ? '_blank' : undefined}

                // @ts-ignore
                rel={l.external ? 'noreferrer' : undefined}
                className={

                // @ts-ignore
                  l.external
                    ? ''
                    : l.id === '/'
                      ? path === '/' ? 'active' : ''
                      : path === l.id || path.startsWith(l.id + '/') ? 'active' : ''
                }
              >
                {l.label}
              </a>
            ))}
          </div>
          <div className="nav-right">
            <ThemeButton />
            {ctaSlot ?? <MintCta label={ctaLabel} />}
            <HamburgerButton
              open={menuOpen}
              onClick={() => setMenuOpen(o => !o)}
            />
          </div>
        </div>
      </nav>
      <MobileDrawer
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        path={path}
      />
    </>
  )
}
