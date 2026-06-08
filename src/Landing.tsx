// Marketing landing for stacSOL.app — replaces the old dashboard at `/`.
//
// Visual language is intentionally separate from the app's fire/red theme:
// near-black backdrops with a mint-green accent + lime kicker, modeled on
// the reference design at https://bwagsieclwpdo.kimi.page. The dashboard
// (mint / burn / wrap / position) lives at /app and keeps its existing
// look — this page is purely a marketing surface that funnels users into
// the actual product.
//
// No wallet provider is mounted here — the page is fully static so it can
// be rendered without dragging the wallet-adapter chunk. Every CTA links
// to /app (or another route) where the heavy bundle loads on demand.
//
// One small live data hit: the "1.xxx+" tile and the in-line NAV mention
// pull the latest pool NAV from /api/history?limit=1 (single small JSON
// row, edge-cached for 10s). Everything else is static copy.

import { useEffect, useRef, useState } from 'react'

// Latest pool NAV, formatted as "1.xxx" with three decimals. Fetched
// lazily on mount; falls back to "1.000" while in flight or on failure
// so the layout never goes empty. The history endpoint already caches
// at the edge so this is cheap to call on every landing pageview.
function useLatestNav(): { display: string; raw: number | null } {
  const [nav, setNav] = useState<number | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/history?limit=1')
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: { rate?: number }[] | null) => {
        if (cancelled) return
        const r = rows?.[0]?.rate
        if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
          setNav(r)
        }
      })
      .catch(() => {
        /* swallow — fall back to baseline 1.000 */
      })
    return () => {
      cancelled = true
    }
  }, [])
  const display = (nav ?? 1).toFixed(3)
  return { display, raw: nav }
}

// -----------------------------------------------------------------------------
// Reusable building blocks
// -----------------------------------------------------------------------------

/**
 * Looping word-strip. Renders `items` twice inside a flex track so the
 * 0 → -50% slide animation produces seamless infinite scrolling. The
 * `direction` controls which way the track travels; `speedSeconds` lets
 * callers tune per-strip pace (faster for the small dark strips, slower
 * for the giant lime ones so the text doesn't blur into mush).
 */
function Marquee({
  items,
  direction = 'left',
  speedSeconds = 22,
  className = '',
  itemClassName = '',
  separator = '•',
}: {
  items: string[]
  direction?: 'left' | 'right'
  speedSeconds?: number
  className?: string
  itemClassName?: string
  separator?: string
}) {
  const doubled = [...items, ...items]
  const animationName =
    direction === 'left' ? 'stak-marquee-left' : 'stak-marquee-right'
  return (
    <div className={`overflow-hidden whitespace-nowrap ${className}`}>
      <div
        className="flex w-max"
        style={{
          animation: `${animationName} ${speedSeconds}s linear infinite`,
        }}
      >
        {doubled.map((word, i) => (
          <span
            key={`${word}-${i}`}
            className={`inline-flex items-center ${itemClassName}`}
          >
            <span>{word}</span>
            <span aria-hidden className="px-6 opacity-80">
              {separator}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Sticky top nav. Stays attached to the viewport but flips its background
 * once you scroll past the cream hero so the mint pill keeps contrast on
 * the dark sections below. The pill itself always links to /app.
 */
function TopNav() {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      // Use the first hero's height as the threshold. The hero is 100vh
      // tall; once we've scrolled past ~70% of that the dark backdrop
      // takes over and the nav needs the inverted treatment.
      const flipAt = window.innerHeight * 0.7
      if (window.scrollY > flipAt) {
        el.dataset.dark = 'true'
      } else {
        el.dataset.dark = 'false'
      }
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  return (
    <nav
      ref={ref}
      data-dark="false"
      className="fixed top-0 inset-x-0 z-50 px-6 py-5 flex items-center justify-between transition-colors duration-300 data-[dark=true]:text-[var(--color-stak-fg)] text-[#1a1a1a]"
    >
      <div className="flex items-center gap-8 text-[11px] font-bold tracking-[3px] uppercase">
        <a
          href="/"
          className="no-underline text-current hover:opacity-70 transition-opacity"
        >
          home
        </a>
        <a
          href="#tokenomics"
          className="no-underline text-current hover:opacity-70 transition-opacity"
        >
          tokenomics
        </a>
      </div>
      <a
        href="/app#wrap"
        className="inline-flex items-center justify-center px-5 py-2 rounded-full bg-[var(--color-stak-mint)] text-[#0a1a14] text-[11px] font-bold tracking-[3px] uppercase no-underline hover:brightness-110 transition"
      >
        wrap stacsol
      </a>
    </nav>
  )
}

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

function Hero() {
  return (
    <section className="stak-grain relative min-h-screen flex flex-col items-center justify-center px-6 overflow-hidden">
      {/* Massive wordmark. Letter-spacing is tuned so it fills the viewport
          on desktop but reflows safely on mobile via the responsive font
          sizing below. */}
      <h1 className="m-0 text-[#0c0c0c] font-display font-medium leading-none text-center select-none tracking-[-0.03em] text-[18vw] sm:text-[15vw]">
        stacSOL
      </h1>
      {/* Bottom-of-hero green wash that bleeds into the dark section
          underneath — sets up the visual handoff. */}
      <div className="absolute bottom-0 inset-x-0 h-32 bg-gradient-to-b from-transparent to-[var(--color-stak-lime)]/60 pointer-events-none" />
      {/* Down-arrow scroll cue, sits just above the green wash. */}
      <div className="absolute bottom-10 left-1/2 -translate-x-1/2 text-[#1a1a1a] text-2xl animate-bounce">
        ⌄
      </div>
    </section>
  )
}

function MarqueeStripDark() {
  // Tight, small-cap marquee on the dark backdrop — sets the tone before
  // the WHY STAKE block. Two rows running in opposite directions adds
  // motion without being garish.
  const items = ['13.8% burn', 'mint', 'wrap', 'deposit', 'borrow', 'loop']
  return (
    <div className="bg-[var(--color-stak-bg)] text-[var(--color-stak-mint)] py-4 border-y border-[var(--color-stak-line)]">
      <Marquee
        items={items.map((s) => s.toUpperCase())}
        direction="left"
        speedSeconds={24}
        itemClassName="text-[13px] font-bold tracking-[3px]"
      />
    </div>
  )
}

function WhyStake() {
  const { display: navStr, raw: navRaw } = useLatestNav()
  return (
    <section
      id="why"
      className="bg-[var(--color-stak-bg)] text-[var(--color-stak-fg)] px-6 sm:px-12 py-24 sm:py-32"
    >
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_minmax(320px,420px)] gap-12 lg:gap-20 items-start">
        <div>
          <h2 className="m-0 mb-12 font-display font-light tracking-[-0.02em] leading-none text-5xl sm:text-7xl">
            why stake?
          </h2>
          <div className="space-y-12">
            {/* Each proof tile uses the same structural pattern: small
                lime-colored label, then a large condensed statement that
                reads as a manifesto line. The statements are deliberately
                terse — they're meant to feel like axioms, not paragraphs. */}
            <div>
              <div className="text-[var(--color-stak-lime)] text-[11px] font-mono tracking-[3px] uppercase mb-3">
                proof a
              </div>
              <div className="font-display font-light text-3xl sm:text-5xl leading-tight tracking-[-0.01em]">
                1 stacSOL &gt; 1 SOL + accumulated yield
              </div>
            </div>
            <div>
              <div className="text-[var(--color-stak-lime)] text-[11px] font-mono tracking-[3px] uppercase mb-3">
                proof b
              </div>
              <div className="font-display font-light text-3xl sm:text-5xl leading-tight tracking-[-0.01em]">
                every transfer = + burned forever
              </div>
            </div>
            <div>
              <div className="text-[var(--color-stak-lime)] text-[11px] font-mono tracking-[3px] uppercase mb-3">
                proof c
              </div>
              <div className="font-display font-light text-3xl sm:text-5xl leading-tight tracking-[-0.01em]">
                fewer tokens → your share worth more
              </div>
            </div>
          </div>
        </div>

        {/* Live NAV tile. Mint-colored digits for "1.xxx" (the current
            stacSOL→SOL rate from /api/history), lime "+" kicker for the
            "and rising" idea. While the fetch is in flight we render the
            baseline 1.000 so layout never pops. */}
        <div className="rounded-2xl border border-[var(--color-stak-line)] bg-[var(--color-stak-bg-soft)] p-8 sm:p-10">
          <div className="font-display font-light leading-none tracking-[-0.04em] text-6xl sm:text-7xl">
            <span className="text-[var(--color-stak-mint)]">{navStr}</span>
            <span className="text-[var(--color-stak-lime)]">+</span>
          </div>
          <div className="mt-6 text-[var(--color-stak-dim)] text-[11px] font-mono tracking-[3px] uppercase">
            stacSOL = SOL + yield
          </div>
          <div className="mt-3 flex items-center gap-2 text-[var(--color-stak-mint)] text-[11px] font-mono tracking-[3px] uppercase">
            <span
              className={
                'w-1.5 h-1.5 rounded-full bg-[var(--color-stak-mint)] [box-shadow:0_0_8px_var(--color-stak-mint)] ' +
                (navRaw != null ? 'animate-pulse' : 'opacity-40')
              }
            />
            {navRaw != null ? 'growing every block' : 'loading…'}
          </div>
        </div>
      </div>

      {/* Two-column explainer paragraph. Mono body type because the rest
          of the section leans display — the visual whiplash makes the
          prose feel like a footnote / receipt, which is the vibe. */}
      <div className="max-w-7xl mx-auto mt-20 grid grid-cols-1 md:grid-cols-2 gap-8 text-[var(--color-stak-fg)]/80 font-mono text-[13px] leading-relaxed">
        <p className="m-0">
          When you mint stacSOL, every single transfer in the ecosystem
          takes a 13.8% fee. That fee gets burned — destroyed forever —
          every 5 minutes. The result? Fewer stacSOL tokens exist over
          time, meaning your 1 stacSOL is worth more and more SOL.
        </p>
        <p className="m-0">
          It&apos;s like staking, except the yield comes from deflation
          instead of inflation. While everyone else is diluting their bags
          with new token emissions, stacSOL holders are watching their
          share of the pie grow automatically.
        </p>
      </div>
    </section>
  )
}

function MarqueeStripGiant() {
  // The giant lime strip is the visual centerpiece between the two
  // analytical sections. Two rows in opposite directions; both are
  // intentionally slower than the small dark strips so the typography
  // stays legible at this size.
  const items = ['wrap', 'mint', 'deposit', 'borrow', 'loop']
  const upper = items.map((s) => s.toUpperCase())
  return (
    <div className="bg-[var(--color-stak-bg)] py-8 sm:py-12 overflow-hidden">
      <Marquee
        items={upper}
        direction="left"
        speedSeconds={48}
        className="text-[var(--color-stak-lime)]"
        itemClassName="font-display font-medium tracking-[-0.02em] text-[14vw] sm:text-[12vw] leading-none"
        separator="•"
      />
      <Marquee
        items={upper.slice().reverse()}
        direction="right"
        speedSeconds={56}
        className="text-[var(--color-stak-lime)] mt-2 sm:mt-4"
        itemClassName="font-display font-medium tracking-[-0.02em] text-[14vw] sm:text-[12vw] leading-none"
        separator="•"
      />
    </div>
  )
}

function BuiltDifferent() {
  // Comparison rows are an array so the markup stays uniform. THEM/US
  // contrast: black-and-white on the left, lime/mint on the right. The
  // section is anchored at #tokenomics so the top-nav link can jump to
  // it without a router round-trip.
  const rows: { label: string; them: string; us: string }[] = [
    {
      label: 'yield source',
      them: 'inflation — mint new tokens',
      us: 'deflation — burn existing tokens',
    },
    {
      label: 'supply over time',
      them: 'increases ↗',
      us: 'decreases ↘',
    },
    {
      label: 'your share value',
      them: 'diluted by inflation',
      us: 'concentrated by burns',
    },
    {
      label: 'transfer fee',
      them: '0% — free to move',
      us: '13.8% — burns forever',
    },
    {
      label: 'claim frequency',
      them: 'manual — you claim',
      us: 'auto — every transfer burns',
    },
  ]
  return (
    <section
      id="tokenomics"
      className="bg-[var(--color-stak-bg)] text-[var(--color-stak-fg)] px-6 sm:px-12 py-24 sm:py-32"
    >
      <div className="max-w-7xl mx-auto">
        <h2 className="m-0 font-display font-light leading-none tracking-[-0.02em] text-5xl sm:text-7xl [text-shadow:0_0_24px_rgba(255,255,255,0.18)]">
          built different
        </h2>
        <p className="mt-6 max-w-md text-[var(--color-stak-fg)]/80 font-mono text-[13px] leading-relaxed">
          While traditional staking inflates supply to pay yield, stacSOL
          deflates. The same yield mechanics, inverted.
        </p>

        <div className="mt-16 border-t border-[var(--color-stak-line)]">
          {/* Header row — only meaningful on wide screens; on mobile the
              labels fold into each row as inline mini-headers. */}
          <div className="hidden md:grid grid-cols-[1.2fr_1fr_1fr] py-4 text-[11px] font-mono tracking-[3px] uppercase text-[var(--color-stak-dim)]">
            <div />
            <div>them</div>
            <div className="text-[var(--color-stak-mint)]">us</div>
          </div>
          {rows.map((row) => (
            <div
              key={row.label}
              className="grid grid-cols-1 md:grid-cols-[1.2fr_1fr_1fr] gap-2 md:gap-6 py-6 border-t border-[var(--color-stak-line)] font-mono text-[13px]"
            >
              <div className="uppercase tracking-[3px] text-[11px] text-[var(--color-stak-dim)]">
                {row.label}
              </div>
              <div className="text-[var(--color-stak-fg)]/85">
                <span className="md:hidden text-[var(--color-stak-dim)] text-[10px] uppercase tracking-[3px] mr-2">
                  them ·
                </span>
                {row.them}
              </div>
              <div className="text-[var(--color-stak-mint)]">
                <span className="md:hidden text-[var(--color-stak-dim)] text-[10px] uppercase tracking-[3px] mr-2">
                  us ·
                </span>
                {row.us}
              </div>
            </div>
          ))}
        </div>

        <a
          href="/faq"
          className="mt-16 inline-flex items-center gap-3 font-display font-light text-3xl sm:text-4xl tracking-[-0.02em] text-[var(--color-stak-mint)] no-underline hover:opacity-80 transition"
        >
          see the tokenomics
          <span aria-hidden>→</span>
        </a>
      </div>
    </section>
  )
}

function Stackening() {
  // Hero-scale glow text. The blur-shadow is the whole effect — pure CSS,
  // no images. Below it, a four-cell stat row with the headline figures.
  return (
    <section className="bg-[var(--color-stak-bg)] text-[var(--color-stak-fg)] px-6 sm:px-12 py-24 sm:py-40 overflow-hidden">
      <div className="max-w-7xl mx-auto">
        <h2
          className="m-0 font-display font-light leading-[0.85] tracking-[-0.04em] text-[16vw] sm:text-[14vw] text-[var(--color-stak-fg)]/90 text-center"
          style={{ textShadow: '0 0 48px rgba(255,255,255,0.15)' }}
        >
          welcome to
          <br />
          the staccening
        </h2>

        <div className="mt-16 grid grid-cols-2 lg:grid-cols-4 gap-x-6 gap-y-12">
          {/* All four numbers are protocol constants, not pool state — no
              fetch required. The two 13.8% figures are intentional: one is
              the Token-2022 transfer fee (every send burns), the other is
              the deposit/burn fee on mint and redeem. They're the same
              percentage but two different mechanisms; both are real. */}
          <Stat value="13.8%" label="transfer fee · burns" />
          <Stat value="5 min" label="burn interval" />
          <Stat value="∞" label="up only" />
          <Stat value="13.8%" label="mint / burn fee" />
        </div>

        {/* The borrow-against-it pitch. Quote-block bar on the left,
            staccish disclaimer on the bottom-right to keep it grounded. */}
        <div className="mt-20 max-w-2xl">
          <div className="border-l-2 border-[var(--color-stak-mint)] pl-5 font-mono text-[13px] leading-relaxed text-[var(--color-stak-fg)]/85">
            stacSOL is SOL on crack — the price cannot possibly go down
            vs SOL. Instead of selling your stacSOL and missing the
            upside, just borrow against it. Your stacSOL keeps printing
            value while you spend the borrowed cash.
          </div>
          <div className="mt-3 pl-5 text-[var(--color-stak-mint)] text-[10px] font-mono tracking-[3px] uppercase">
            — not stacc&apos;s words
          </div>
        </div>

        {/* Primary CTA — funnels into the dashboard's mint section. */}
        <div className="mt-16">
          <a
            href="/app#mint"
            className="inline-flex items-center gap-3 font-display font-medium text-5xl sm:text-7xl tracking-[-0.02em] text-[var(--color-stak-fg)] no-underline hover:text-[var(--color-stak-mint)] transition-colors"
          >
            start staccing
            <span aria-hidden>→</span>
          </a>
          <div className="mt-3 text-[var(--color-stak-dim)] text-[11px] font-mono tracking-[3px] uppercase">
            mint at stacsol.app
          </div>
        </div>
      </div>
    </section>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-display font-light text-5xl sm:text-7xl leading-none tracking-[-0.02em] text-[var(--color-stak-mint)]">
        {value}
      </div>
      <div className="mt-3 text-[var(--color-stak-dim)] text-[11px] font-mono tracking-[3px] uppercase">
        {label}
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer className="bg-[var(--color-stak-bg)] text-[var(--color-stak-dim)] px-6 sm:px-12 py-10 border-t border-[var(--color-stak-line)]">
      <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4 text-[11px] font-mono tracking-[3px] uppercase">
        <div className="flex gap-6">
          <a href="/" className="text-current no-underline hover:opacity-80">
            home
          </a>
          <a
            href="#tokenomics"
            className="text-current no-underline hover:opacity-80"
          >
            tokenomics
          </a>
          <a
            href="/app"
            className="text-current no-underline hover:opacity-80"
          >
            app
          </a>
        </div>
        <div className="text-[var(--color-stak-dim)]">
          © 2026 stacSOL · all rights reserved
        </div>
      </div>
    </footer>
  )
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function Landing() {
  return (
    <div className="bg-[var(--color-stak-bg)] text-[var(--color-stak-fg)] font-mono min-h-screen">
      <TopNav />
      <Hero />
      <MarqueeStripDark />
      <WhyStake />
      <MarqueeStripGiant />
      <BuiltDifferent />
      <Stackening />
      <Footer />
    </div>
  )
}
