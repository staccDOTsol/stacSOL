// stacSOL Visual Guide — Part 1.
// Long-form scroll page. Rendered at /guide. No wallet providers required.
//
// Positioning frame: stacSOL is the SOL of the thystaccfloweth — a base
// trading asset for the family, not a passive yield product. The flywheel
// is cross-pair volume → 6.9% transfer-fee burn → NAV climbs. Pure stakers
// dilute APR. Lead with the positioning, then mechanic, then safety guard
// rails (13.8% worst case), then the Jupiter chart misread.

import { useEffect } from 'react'

export default function Guide() {
  useEffect(() => {
    const prevTitle = document.title
    document.title = 'stacSOL — the SOL of the thystaccfloweth'
    return () => {
      document.title = prevTitle
    }
  }, [])

  return (
    <div className="min-h-screen text-[var(--color-fg)]">
      <Nav />
      <Hero />
      <Flywheel />
      <Mechanic />
      <Rules />
      <SafeZone />
      <ButTheChart />
      <TwoPaths />
      <Anatomy />
      <Summary />
      <Footer />
    </div>
  )
}

function Nav() {
  return (
    <div className="sticky top-0 z-20 bg-[rgba(8,2,3,0.85)] backdrop-blur border-b border-[rgb(255_34_0_/_0.15)]">
      <div className="max-w-[1080px] mx-auto px-6 py-3 flex items-center justify-between">
        <a
          href="/"
          className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline [text-shadow:0_0_8px_rgba(255,34,0,0.5)]"
        >
          ← stacsol.app
        </a>
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
          guide · part 1
        </span>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 pt-24 pb-20 text-center">
      <Pill tone="red">stacSOL guide — part 1</Pill>
      <h1 className="mt-8 text-[clamp(48px,8vw,108px)] font-black tracking-[-0.04em] leading-[0.95] text-[var(--color-fg)]">
        stacSOL is the{' '}
        <span className="text-[var(--color-hot)] [text-shadow:0_0_28px_rgba(255,34,0,0.5)]">
          SOL
        </span>
        <br />
        of the thystaccfloweth.
      </h1>
      <p className="mt-8 max-w-[680px] mx-auto text-[15px] leading-relaxed text-[var(--color-dim)]">
        Not a passive yield product. A base trading asset for the entire
        thystaccfloweth family — every cross-pair that lists against stacSOL
        feeds the protocol. Volume IS the yield.
      </p>

      <div className="mt-14 grid md:grid-cols-3 gap-4 max-w-[800px] mx-auto text-left">
        <HeroStat
          tone="red"
          big="6.9%"
          label="transfer-fee burn"
          sub="every trade feeds NAV"
        />
        <HeroStat
          tone="green"
          big="↑"
          label="redemption rate"
          sub="monotonically up. only direction."
        />
        <HeroStat
          tone="green"
          big="13.8%"
          label="worst-case drawdown"
          sub="if you follow the rules"
        />
      </div>

      <div className="mt-14 text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
        scroll for the flywheel <span className="ml-2">↓</span>
      </div>
    </section>
  )
}

function Flywheel() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader eyebrow="The flywheel" title="Volume is the yield." />
      <p className="max-w-[720px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        Most LSTs collapse to ~7% APR — pure staking yield, decay over time.
        stacSOL doesn&apos;t, because the redemption rate compounds with
        trading volume across thystaccfloweth pairs. Every transfer of stacSOL
        withholds 6.9% via Token-2022 and burns it on a five-minute loop.
        More trades, more burn, faster NAV climb.
      </p>

      <div className="mt-12 grid md:grid-cols-2 gap-4">
        <FeatureCard
          symbol="✓"
          title="What grows the protocol"
          body="New thystaccfloweth tokens listing against stacSOL. Trading volume in those cross-pairs. Active LPs rebalancing. Every transfer is fuel for the burn loop."
          tone="green"
        />
        <FeatureCard
          symbol="✗"
          title="What dilutes the protocol"
          body="Whales minting and sitting still. Pure stakers add backing SOL but generate zero burns. More supply against the same burn rate shrinks the per-token bump for everyone."
          tone="red"
        />
      </div>

      <div className="mt-10 bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)] rounded-lg p-6">
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
          The growth loop
        </div>
        <ol className="mt-3 m-0 pl-0 list-none space-y-2 text-[14px] leading-relaxed text-[var(--color-fg)]">
          <li><span className="text-[var(--color-hot)] font-black tabular-mono mr-2">1.</span>More stacSOL pairs on Raydium / Meteora / Orca → deeper liquidity</li>
          <li><span className="text-[var(--color-hot)] font-black tabular-mono mr-2">2.</span>Deeper liquidity → tighter spreads → DEX traders route through stacSOL</li>
          <li><span className="text-[var(--color-hot)] font-black tabular-mono mr-2">3.</span>More routing → more 6.9% transfer-fee burns on every swap</li>
          <li><span className="text-[var(--color-hot)] font-black tabular-mono mr-2">4.</span>More burns → NAV climbs faster → attracts more pairs</li>
          <li><span className="text-[var(--color-hot)] font-black tabular-mono mr-2">5.</span>Repeat. T-Rex eats.</li>
        </ol>
      </div>
    </section>
  )
}

function Mechanic() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader eyebrow="Mechanic" title="How the burn works." />
      <p className="max-w-[720px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        stacSOL is a liquid staking token built on Token-2022. Mint and burn
        on the official site redeem at NAV against the protocol pool — but
        the rate climbs from <em>everything else</em>: every transfer of
        stacSOL withholds 6.9% and feeds the burn loop.
      </p>

      <div className="mt-12 grid md:grid-cols-3 gap-4">
        <FeatureCard
          symbol="★"
          title="Mint (deposit)"
          body="Deposit SOL → receive stacSOL at NAV. No slippage, no AMM. Direct against the protocol's staked reserves."
          tone="green"
        />
        <FeatureCard
          symbol="♻"
          title="Burn (redeem)"
          body="Return stacSOL → receive SOL at NAV plus accrued yield. Direct against the pool. Always a better fill than DEX."
          tone="green"
        />
        <FeatureCard
          symbol="🔥"
          title="The burn loop"
          body="Every Token-2022 transfer withholds 6.9%. A daemon sweeps and burns withheld balances every five minutes. Supply only goes down. NAV only goes up."
          tone="red"
        />
      </div>
    </section>
  )
}

function Rules() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader eyebrow="Protocol rules" title="The 3 rules." />
      <p className="max-w-[680px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        The 13.8% worst-case is the deal you get when you follow these. Anything
        else is a different game with different math.
      </p>

      <div className="mt-12 space-y-4">
        <Rule
          n="1"
          title="Mint only on the official site"
          body="Deposit SOL and receive stacSOL exclusively through the protocol's official interface."
        />
        <Rule
          n="2"
          title="Burn only on the official site"
          body="Redeem stacSOL for SOL only on the official site. Never sell on Jupiter or secondary AMMs."
        />
        <Rule
          n="3"
          title="No quick roundtrips"
          body="Staking yield needs time to accrue. A fast roundtrip doesn't give NAV time to grow."
        />
      </div>
    </section>
  )
}

function SafeZone() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader eyebrow="The deal" title="The safe zone." />
      <p className="max-w-[680px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        Stack the rules together and you get a clean envelope:
      </p>

      <div className="mt-12 rounded-lg bg-[var(--color-bg2)] border border-[rgb(34_238_136_/_0.4)] p-8 md:p-10">
        <div className="grid md:grid-cols-[1fr_auto_1fr] gap-8 items-center">
          <div>
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-green)]">
              the path
            </div>
            <div className="mt-3 text-[20px] md:text-[28px] font-black text-[var(--color-fg)] leading-tight">
              Official mint
              <span className="text-[var(--color-green)] mx-2">→</span>
              hold
              <span className="text-[var(--color-green)] mx-2">→</span>
              official burn
            </div>
            <div className="mt-3 text-[13px] text-[var(--color-dim)]">
              That&apos;s the whole strategy.
            </div>
          </div>

          <div className="hidden md:block w-px h-32 bg-[rgb(34_238_136_/_0.25)]" />

          <div className="text-center md:text-left">
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-green)]">
              max drawdown
            </div>
            <div
              className="mt-2 tabular-mono text-[clamp(64px,9vw,120px)] font-black text-[var(--color-green)] leading-none"
              style={{ textShadow: '0 0 28px rgba(34,238,136,0.45)' }}
            >
              13.8%
            </div>
            <div className="mt-2 text-[12px] uppercase tracking-[2px] text-[var(--color-dim)] font-black">
              worst case, ever
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function ButTheChart() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <Pill tone="red">heads up</Pill>
      <h2 className="m-0 mt-6 text-[clamp(32px,5vw,56px)] font-black tracking-[-0.03em] leading-[1] text-[var(--color-fg)]">
        But you might have seen{' '}
        <span className="text-[var(--color-hot)]">this chart.</span>
      </h2>
      <p className="max-w-[680px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        It&apos;s real. It&apos;s also the wrong instrument. This is the Jupiter
        secondary-market price, where speculators trade stacSOL ↔ SOL with price
        impact. It is not the redemption value of the token.
      </p>

      <ChartCard />

      <div className="mt-10 grid md:grid-cols-2 gap-4">
        <FeatureCard
          symbol="⚠"
          title="LP price = noise"
          body="The Jupiter / AMM price is secondary market noise. It can detach during one-sided panic flow. It is not what you redeem for."
          tone="red"
        />
        <FeatureCard
          symbol="✓"
          title="NAV = redemption"
          body="Mint and burn on the official site go through the protocol pool. They redeem at NAV — completely independent of whatever the LP price is doing."
          tone="green"
        />
      </div>

      <div className="mt-10 bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)] rounded-lg p-6">
        <div className="flex items-start gap-3">
          <span className="text-[var(--color-hot)] text-xl leading-none">⚠</span>
          <div>
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
              The chart is the wrong instrument
            </div>
            <p className="mt-2 text-[14px] leading-relaxed text-[var(--color-fg)]">
              Anyone reading the secondary chart as &ldquo;the truth&rdquo; of the
              token is reading the wrong instrument. LP price can detach during
              one-sided flow. NAV redemption is the load-bearing number — and
              it only goes up.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function ChartCard() {
  return (
    <div className="mt-10 mx-auto bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)] rounded-lg p-6">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-black uppercase tracking-[2px] text-[var(--color-dim)]">
          stacSOL / SOL on Jupiter (secondary)
        </span>
        <span className="tabular-mono text-[var(--color-hot)] font-black text-sm">
          −89.0% ▼
        </span>
      </div>

      <svg viewBox="0 0 720 220" className="w-full h-[220px]">
        <defs>
          <linearGradient id="redfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ff2200" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ff2200" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* NAV reference line */}
        <line
          x1="0"
          x2="720"
          y1="35"
          y2="35"
          stroke="#22ee88"
          strokeWidth="2"
          strokeDasharray="6 6"
        />
        <text x="360" y="26" textAnchor="middle" fill="#22ee88" fontSize="11" fontWeight="700">
          NAV = real redemption value (only goes up)
        </text>

        <path
          d="M 0 50 L 60 55 L 110 70 L 160 65 L 210 90 L 260 100 L 310 110 L 360 130 L 410 145 L 460 165 L 510 175 L 560 185 L 610 192 L 660 198 L 720 200 L 720 220 L 0 220 Z"
          fill="url(#redfill)"
        />
        <path
          d="M 0 50 L 60 55 L 110 70 L 160 65 L 210 90 L 260 100 L 310 110 L 360 130 L 410 145 L 460 165 L 510 175 L 560 185 L 610 192 L 660 198 L 720 200"
          stroke="#ff5555"
          strokeWidth="2.5"
          fill="none"
        />
        <text x="710" y="170" textAnchor="end" fill="#ff5555" fontSize="11" fontWeight="700">
          LP price ← jupiter only, ignore this if you mint/burn on site
        </text>
      </svg>

      <div className="mt-3 text-[11px] text-[var(--color-dim)]">
        The dashed green line is what your stacSOL actually redeems for on the
        official site. The red line is what panic sellers eat on the AMM.
      </div>
    </div>
  )
}

function TwoPaths() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader
        eyebrow="Comparison"
        title="The good path vs the dangerous path."
      />
      <p className="max-w-[680px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        You only end up on the right side of this comparison if you ignore the
        rules and trade on Jupiter. Following the rules, you stay on the left.
      </p>

      <div className="mt-12 grid md:grid-cols-2 gap-5">
        <PathCard
          tone="green"
          label="✓ official protocol"
          steps={[
            ['SOL', 'Mint on official site', 'Deposit SOL into the pool'],
            ['stac', 'Receive stacSOL', 'At pool NAV, no slippage'],
            ['stac', 'Burn on official site', 'Return stacSOL to the pool'],
            ['SOL', 'Receive SOL', 'NAV + accrued staking yield'],
          ]}
          footerLabel="Worst-case drawdown"
          footerValue="13.8%"
          footerSub="Following protocol rules"
        />
        <PathCard
          tone="red"
          label="✗ ignoring the rules"
          steps={[
            ['SOL', 'Buy on Jupiter', 'Swap SOL → stacSOL on AMM'],
            ['stac', 'Receive stacSOL', 'With AMM price impact'],
            ['stac', 'Panic sell', 'Mass dump into Jupiter LP'],
            ['SOL', 'Receive far less SOL', 'You are a price-taker on the AMM'],
          ]}
          footerLabel="Worst observed loss"
          footerValue="−89%"
          footerSub="What you eat as a Jupiter price-taker"
        />
      </div>
    </section>
  )
}

function Anatomy() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader eyebrow="Under the hood" title="Anatomy of the flow." />
      <p className="max-w-[680px] mt-4 text-[15px] leading-relaxed text-[var(--color-dim)]">
        Mint and burn transact against the pool. Jupiter is a separate venue
        with separate math.
      </p>

      <div className="mt-12 space-y-4">
        <FlowRow
          tone="green"
          label="MINT"
          left={['SOL', 'Your SOL', 'Deposit on the official site']}
          right={['stac', 'stacSOL', 'Received at pool NAV']}
        />

        <PoolBlock />

        <FlowRow
          tone="green"
          label="BURN"
          left={['stac', 'stacSOL', 'Returned to the pool']}
          right={['SOL', 'Your SOL + yield', 'Redeemed at NAV, no AMM']}
        />

        <FlowRow
          tone="red"
          label="⚠ JUPITER (DON'T)"
          left={['stac', 'Panic sell', 'stacSOL → SOL with price impact']}
          right={['SOL', 'Way less SOL', 'Price-taker on the AMM']}
        />
      </div>

      <div className="mt-10 grid md:grid-cols-2 gap-4">
        <Tag tone="green" label="Protocol pool" sub="Real NAV. Where you redeem." />
        <Tag tone="red" label="Jupiter AMM" sub="Market noise. Where you don't trade." />
      </div>
    </section>
  )
}

function Summary() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 py-20 border-t border-[rgb(255_34_0_/_0.12)]">
      <SectionHeader eyebrow="TL;DR" title="The summary." />
      <div className="mt-8 max-w-[720px] space-y-4 text-[15px] leading-relaxed text-[var(--color-fg)]">
        <p>
          stacSOL is the base trading asset for the thystaccfloweth ecosystem.
          Volume across cross-pairs feeds the 6.9% transfer-fee burn loop. The
          redemption rate climbs every five minutes the family is trading.
        </p>
        <p>
          Mint and burn on the official site redeem at NAV, capped at 13.8%
          drawdown in the worst case. That&apos;s the safety contract — but
          the protocol&apos;s job is being load-bearing for the family, not
          producing yield for stakers who sit still.
        </p>
        <p>
          The Jupiter chart shows secondary-market LP price on a thin pool.
          It can detach during panic. It does not affect what you redeem for
          on the official site.
        </p>
        <p className="text-[var(--color-hot)] font-black">
          Growth = more cross-pairs and more cross-pair volume.
        </p>
      </div>

      <div className="mt-12 grid md:grid-cols-2 gap-4">
        <Verdict tone="green" prefix="✓ ALWAYS">
          Mint and burn on the official site. Pair new thystaccfloweth tokens
          against stacSOL.
        </Verdict>
        <Verdict tone="red" prefix="✗ NEVER">
          Panic-sell on Jupiter. Position stacSOL as a passive staking
          vehicle.
        </Verdict>
      </div>

      <div className="mt-16 text-center">
        <a
          href="/"
          className="inline-block bg-[var(--color-hot)] text-black px-8 py-4 text-xs font-black uppercase tracking-[3px] no-underline rounded hover:brightness-110 transition"
        >
          go to stacsol.app →
        </a>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="max-w-[1080px] mx-auto px-6 py-10 border-t border-[rgb(255_34_0_/_0.12)] text-center text-[11px] text-[var(--color-dim)] uppercase tracking-[2px]">
      stacSOL visual guide — part 1: the SOL of the thystaccfloweth ·{' '}
      <span className="text-[var(--color-fg)]">volume is the yield.</span>
    </footer>
  )
}

/* ---------- shared building blocks ---------- */

type Tone = 'green' | 'red'

function toneColor(tone: Tone) {
  return tone === 'green' ? 'var(--color-green)' : 'var(--color-hot)'
}

function toneBorder(tone: Tone) {
  return tone === 'green'
    ? 'rgb(34 238 136 / 0.32)'
    : 'rgb(255 34 0 / 0.32)'
}

function toneTint(tone: Tone) {
  return tone === 'green'
    ? 'rgb(34 238 136 / 0.05)'
    : 'rgb(255 34 0 / 0.05)'
}

function Pill({ children, tone = 'red' }: { children: React.ReactNode; tone?: Tone }) {
  const c = toneColor(tone)
  return (
    <span
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full border text-[10px] font-black uppercase tracking-[3px]"
      style={{
        color: c,
        borderColor: toneBorder(tone),
        background: toneTint(tone),
      }}
    >
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: c, boxShadow: `0 0 6px ${c}` }}
      />
      {children}
    </span>
  )
}

function SectionHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
        {eyebrow}
      </div>
      <h2 className="m-0 mt-3 text-[clamp(32px,5vw,56px)] font-black tracking-[-0.03em] leading-[1] text-[var(--color-fg)]">
        {title}
      </h2>
    </div>
  )
}

function HeroStat({
  tone,
  big,
  label,
  sub,
}: {
  tone: Tone
  big: string
  label: string
  sub: string
}) {
  const c = toneColor(tone)
  return (
    <div
      className="rounded-lg p-6 bg-[var(--color-bg2)] border"
      style={{ borderColor: toneBorder(tone) }}
    >
      <div
        className="tabular-mono text-5xl font-black leading-none"
        style={{ color: c, textShadow: `0 0 20px ${c}55` }}
      >
        {big}
      </div>
      <div
        className="mt-3 text-[10px] font-black uppercase tracking-[3px]"
        style={{ color: c }}
      >
        {label}
      </div>
      <div className="mt-1 text-[12px] text-[var(--color-dim)] leading-snug">
        {sub}
      </div>
    </div>
  )
}

function FeatureCard({
  symbol,
  title,
  body,
  tone,
}: {
  symbol: string
  title: string
  body: string
  tone: Tone
}) {
  return (
    <div
      className="rounded-lg p-6 bg-[var(--color-bg2)] border"
      style={{ borderColor: toneBorder(tone) }}
    >
      <div
        className="w-10 h-10 rounded-md flex items-center justify-center text-xl font-black"
        style={{
          color: toneColor(tone),
          background: toneTint(tone),
          border: `1px solid ${toneBorder(tone)}`,
        }}
      >
        {symbol}
      </div>
      <h3 className="mt-4 mb-2 text-base font-black text-[var(--color-fg)]">
        {title}
      </h3>
      <p className="m-0 text-[13px] leading-relaxed text-[var(--color-dim)]">
        {body}
      </p>
    </div>
  )
}

function PathCard({
  tone,
  label,
  steps,
  footerLabel,
  footerValue,
  footerSub,
}: {
  tone: Tone
  label: string
  steps: [string, string, string][]
  footerLabel: string
  footerValue: string
  footerSub: string
}) {
  const c = toneColor(tone)
  return (
    <div
      className="rounded-lg overflow-hidden bg-[var(--color-bg2)] border"
      style={{ borderColor: toneBorder(tone) }}
    >
      <div
        className="px-5 py-3 text-[10px] font-black uppercase tracking-[3px]"
        style={{ color: c, background: toneTint(tone), borderBottom: `1px solid ${toneBorder(tone)}` }}
      >
        {label}
      </div>
      <ol className="list-none m-0 p-5 space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3">
            <span
              className="tabular-mono shrink-0 w-12 text-center text-[10px] font-black uppercase tracking-[1.5px] py-1.5 rounded border"
              style={{
                color: c,
                borderColor: toneBorder(tone),
                background: toneTint(tone),
              }}
            >
              {s[0]}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-black text-[var(--color-fg)]">
                {s[1]}
              </div>
              <div className="text-[12px] text-[var(--color-dim)] leading-snug">
                {s[2]}
              </div>
            </div>
          </li>
        ))}
      </ol>
      <div
        className="px-5 py-4 border-t"
        style={{ borderColor: toneBorder(tone), background: toneTint(tone) }}
      >
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
          {footerLabel}
        </div>
        <div className="mt-1 tabular-mono text-3xl font-black" style={{ color: c }}>
          {footerValue}
        </div>
        <div className="text-[11px] text-[var(--color-dim)] mt-1">{footerSub}</div>
      </div>
    </div>
  )
}

function FlowRow({
  tone,
  label,
  left,
  right,
}: {
  tone: Tone
  label: string
  left: [string, string, string]
  right: [string, string, string]
}) {
  const c = toneColor(tone)
  return (
    <div
      className="rounded-lg bg-[var(--color-bg2)] border p-5"
      style={{ borderColor: toneBorder(tone) }}
    >
      <div
        className="text-[10px] font-black uppercase tracking-[3px] mb-4"
        style={{ color: c }}
      >
        {label}
      </div>
      <div className="grid md:grid-cols-[1fr_auto_1fr] gap-4 items-center">
        <FlowSide tone={tone} step={left} />
        <div className="hidden md:block text-2xl font-black" style={{ color: c }}>
          →
        </div>
        <FlowSide tone={tone} step={right} />
      </div>
    </div>
  )
}

function FlowSide({ tone, step }: { tone: Tone; step: [string, string, string] }) {
  const c = toneColor(tone)
  return (
    <div className="flex items-center gap-3">
      <span
        className="tabular-mono shrink-0 w-14 text-center text-[10px] font-black uppercase tracking-[1.5px] py-2 rounded border"
        style={{ color: c, borderColor: toneBorder(tone), background: toneTint(tone) }}
      >
        {step[0]}
      </span>
      <div className="min-w-0">
        <div className="text-[13px] font-black text-[var(--color-fg)]">{step[1]}</div>
        <div className="text-[12px] text-[var(--color-dim)] leading-snug">{step[2]}</div>
      </div>
    </div>
  )
}

function PoolBlock() {
  return (
    <div className="rounded-lg bg-[rgb(34_238_136_/_0.06)] border border-[rgb(34_238_136_/_0.4)] p-6 text-center">
      <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-green)]">
        protocol pool
      </div>
      <div className="mt-2 text-[16px] font-black text-[var(--color-fg)]">
        Staked SOL reserves in the protocol contract
      </div>
      <div className="mt-2 text-[var(--color-green)] text-[12px] font-black uppercase tracking-[2px]">
        ★ NAV is calculated here ★
      </div>
    </div>
  )
}

function Tag({ tone, label, sub }: { tone: Tone; label: string; sub: string }) {
  const c = toneColor(tone)
  return (
    <div
      className="rounded-lg p-4 border bg-[var(--color-bg2)]"
      style={{ borderColor: toneBorder(tone) }}
    >
      <div className="text-[10px] font-black uppercase tracking-[3px]" style={{ color: c }}>
        {label}
      </div>
      <div className="mt-1 text-[13px] text-[var(--color-fg)]">{sub}</div>
    </div>
  )
}

function Rule({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-lg bg-[var(--color-bg2)] border border-[rgb(34_238_136_/_0.32)] p-6 flex items-start gap-5">
      <div
        className="tabular-mono shrink-0 w-12 h-12 rounded-md flex items-center justify-center text-2xl font-black text-[var(--color-green)] border border-[rgb(34_238_136_/_0.4)] bg-[rgb(34_238_136_/_0.06)]"
        style={{ textShadow: '0 0 8px rgba(34,238,136,0.45)' }}
      >
        {n}
      </div>
      <div>
        <h3 className="m-0 text-base font-black text-[var(--color-fg)]">{title}</h3>
        <p className="m-0 mt-2 text-[13px] leading-relaxed text-[var(--color-dim)]">
          {body}
        </p>
      </div>
    </div>
  )
}

function Verdict({
  tone,
  prefix,
  children,
}: {
  tone: Tone
  prefix: string
  children: React.ReactNode
}) {
  const c = toneColor(tone)
  return (
    <div
      className="rounded-lg p-6 bg-[var(--color-bg2)] border"
      style={{ borderColor: toneBorder(tone) }}
    >
      <div
        className="text-[10px] font-black uppercase tracking-[3px]"
        style={{ color: c }}
      >
        {prefix}
      </div>
      <div className="mt-2 text-[16px] font-black text-[var(--color-fg)]">
        {children}
      </div>
    </div>
  )
}
