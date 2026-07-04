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
  { id: '/evm', label: 'EVM' },
  { id: '/faq', label: 'FAQ' },
  { id: '/terms', label: 'Terms' },
]

// Routes that don't fit on the desktop nav strip but should still be one tap
// away on mobile — surfaced via the hamburger drawer.
const MORE_LINKS = [
  { id: '/wrap', label: 'Wrap', sub: 'stacSOL ↔ wstacSOL · one-click for ride.markets' },
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
