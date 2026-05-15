// Marketing landing for stacSOL.app — editorial redesign.
// Single elegant system: ivory ground, ink type, jade accent.
// Replaces the old marquee/mint-lime treatment.
//
// No wallet provider mounted here — fully static so the wallet-adapter
// chunk doesn't load on first paint. Live data comes from /api/history
// only (small JSON, edge-cached). All CTAs link to /app where the heavy
// bundle loads on demand.

import { useEffect, useState } from 'react'
import EditorialNav from './components/EditorialNav'
import { MINT, POOL } from './lib/constants'

// -----------------------------------------------------------------------------
// Live perf hook — derives doubling time and "SOL to print $100/day" from
// /api/history + CoinGecko. Mirrors the design prototype's useLivePerf but
// pulls from the project's existing /api/history endpoint shape.
// -----------------------------------------------------------------------------

interface PerfState {
  rate: number | null
  dailyRate: number | null
  doublingDays: number | null
  solFor100: number | null
  solUsd: number
  loading: boolean
  liveRate: boolean
  liveHistory: boolean
  livePrice: boolean
}

const INITIAL: PerfState = {
  rate: null,
  dailyRate: null,
  doublingDays: null,
  solFor100: null,
  solUsd: 222,
  loading: true,
  liveRate: false,
  liveHistory: false,
  livePrice: false,
}

// Public Solana RPC — CORS-open, no API key needed. We use it instead of
// /api/history because the landing page is served outside of a
// ConnectionProvider and (in `vite dev`) Vercel serverless functions
// aren't running, so /api/* returns 404. Direct RPC works in dev and prod.
const PUBLIC_RPC = 'https://solana-rpc.publicnode.com'

/** JSON-RPC getMultipleAccounts → decodes the SPL stake-pool struct and the
 *  Token-2022 mint to compute the current redemption rate exactly the same
 *  way lib/pool.ts does server-side. Returns null on any failure (CORS,
 *  network, decode) so the UI can show "—" instead of a fake rate. */
async function fetchLiveRate(): Promise<number | null> {
  try {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'getMultipleAccounts',
      params: [
        [POOL.toBase58(), MINT.toBase58()],
        { encoding: 'base64', commitment: 'processed' },
      ],
    }
    const r = await fetch(PUBLIC_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) return null
    const j = (await r.json()) as {
      result?: { value: Array<{ data: [string, string] } | null> }
    }
    const accounts = j.result?.value
    if (!accounts || accounts.length < 2 || !accounts[0] || !accounts[1]) {
      return null
    }
    const poolData = Uint8Array.from(atob(accounts[0].data[0]), c => c.charCodeAt(0))
    // SPL stake-pool v1.0.0 fixed offsets — total_lamports @ 258, supply @ 266.
    // Use DataView with the underlying ArrayBuffer so byteOffset (from atob's
    // typed array) is respected.
    const dv = new DataView(poolData.buffer, poolData.byteOffset, poolData.byteLength)
    const totalLamports = dv.getBigUint64(258, true)
    const supply = dv.getBigUint64(266, true)
    if (supply === 0n) return null
    return Number(totalLamports) / Number(supply)
  } catch {
    return null
  }
}

// Reliability guards. Tiny windows of history (a couple of snapshots minutes
// apart) compute essentially-zero daily rates that don't reflect the
// protocol's actual trajectory; oversize windows (huge ratio over a few
// hours, e.g. the first day after deploy) blow up to obviously-fake APRs.
// Inside [MIN, MAX) the number is plausible; outside, we show "—" rather
// than mislead.
const MIN_HISTORY_SPAN_DAYS = 0.5 // require ≥12h of snapshots before trusting daily rate
const MAX_PLAUSIBLE_DAILY = 0.5 // 50%/day cap — anything beyond is data noise
const MAX_DISPLAYED_APR_PCT = 100_000 // beyond this we render "—"; not believable

function useLivePerf(refreshMs = 30_000): PerfState {
  const [state, setState] = useState<PerfState>(INITIAL)

  useEffect(() => {
    // Track the latest fetch generation so an in-flight call from a previous
    // interval tick can't clobber the state with stale data. Without this
    // guard, if `fetchAll` ever takes longer than `refreshMs` (CoinGecko
    // hiccup, slow RPC) two ticks overlap and whichever finishes last wins —
    // produces visibly-flipping numbers between renders.
    let generation = 0
    let cancelledMount = false

    const fetchAll = async () => {
      const myGen = ++generation
      const next: PerfState = { ...INITIAL, loading: false }
      const stale = () => cancelledMount || myGen !== generation

      // 1. Live NAV — direct RPC. Authoritative; doesn't depend on /api/*.
      const rate = await fetchLiveRate()
      if (stale()) return
      if (rate != null) {
        next.rate = rate
        next.liveRate = true
      }

      // 2. Historical rate trajectory → realised compound daily yield +
      //    doubling time. Only available when /api/history is reachable
      //    (deployed Vercel build, or vite dev with proxy). Guards:
      //    - need ≥ MIN_HISTORY_SPAN_DAYS of span so tiny windows don't
      //      compute essentially-zero daily rates
      //    - reject dailyRate above MAX_PLAUSIBLE_DAILY as data noise
      try {
        const r = await fetch('/api/history?limit=500')
        if (r.ok) {
          const rows: { ts: number; rate: number }[] = await r.json()
          if (Array.isArray(rows) && rows.length > 1) {
            const last = rows[rows.length - 1]
            if (!next.rate && last.rate > 0) next.rate = last.rate
            const target = last.ts - 24 * 60 * 60 * 1000
            let prev = rows[0]
            for (const row of rows) {
              if (Math.abs(row.ts - target) < Math.abs(prev.ts - target)) {
                prev = row
              }
            }
            const dtDays = (last.ts - prev.ts) / (1000 * 60 * 60 * 24)
            if (
              prev.rate > 0 &&
              last.rate > prev.rate &&
              dtDays >= MIN_HISTORY_SPAN_DAYS
            ) {
              const dailyRate = Math.pow(last.rate / prev.rate, 1 / dtDays) - 1
              if (dailyRate > 0 && dailyRate <= MAX_PLAUSIBLE_DAILY) {
                next.dailyRate = dailyRate
                next.doublingDays = Math.log(2) / Math.log(1 + dailyRate)
                next.liveHistory = true
              }
            }
          }
        }
      } catch {
        /* /api/history unavailable — leave dailyRate / doublingDays null */
      }
      if (stale()) return

      // 3. SOL spot — CoinGecko (CORS-open). Used to compute "SOL needed
      //    to print $100/day". Falls back to a fixed estimate if down.
      try {
        const r = await fetch(
          'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
        )
        if (r.ok) {
          const j: { solana?: { usd?: number } } = await r.json()
          if (j.solana?.usd) {
            next.solUsd = j.solana.usd
            next.livePrice = true
          }
        }
      } catch {
        /* keep fallback solUsd */
      }
      if (stale()) return

      // Only derive solFor100 if dailyRate survived the sanity guards above —
      // means hero scoreboard and implied APR are guaranteed to come from the
      // SAME dailyRate value within a single tick (no more "$100/day on 35
      // SOL" + "1.00% APR" disagreement).
      if (next.dailyRate != null) {
        next.solFor100 = 100 / next.solUsd / next.dailyRate
      }

      setState(next)
    }
    fetchAll()
    const id = setInterval(fetchAll, refreshMs)
    return () => {
      cancelledMount = true
      clearInterval(id)
    }
  }, [refreshMs])

  return state
}

// -----------------------------------------------------------------------------
// NAV ticker — tiny +ε pip animation so the rate feels alive. While the live
// rate is loading we render an em-dash so the pip can't accumulate against
// the placeholder `1.0` and produce a wrong-looking value like 1.000044.
// -----------------------------------------------------------------------------
function NavTicker({ rate }: { rate: number | null }) {
  const [pip, setPip] = useState(0)
  useEffect(() => {
    if (rate == null) return
    const id = setInterval(
      () => setPip(p => p + Math.random() * 0.0000018),
      1100,
    )
    return () => clearInterval(id)
  }, [rate])
  if (rate == null) {
    return (
      <span className="mono tabular" style={{ color: 'var(--ink-muted)' }}>
        —
      </span>
    )
  }
  return (
    <span className="mono tabular" style={{ color: 'var(--accent-deep)' }}>
      {(rate + pip).toFixed(6)}
    </span>
  )
}

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------
function HeroBlock({ perf }: { perf: PerfState }) {
  // Compound APR — `(1 + dailyRate)^365 − 1`. At low daily rates this is
  // ≈ dailyRate × 365; at the protocol's actual rate it explodes correctly
  // instead of misrepresenting as a linear annual. Clamp implausible values
  // to null so the cell renders "—" rather than e.g. "1.2M%".
  const aprPct =
    perf.dailyRate != null
      ? Math.min(
          MAX_DISPLAYED_APR_PCT,
          (Math.pow(1 + perf.dailyRate, 365) - 1) * 100,
        )
      : null
  const aprDisplayable =
    aprPct != null && aprPct >= 0 && aprPct < MAX_DISPLAYED_APR_PCT
  return (
    <section className="hero shell">
      <div className="hero-eyebrow">
        <span className="dot" />
        <span className="eyebrow">protocol live · solana mainnet</span>
        {(perf.liveRate || perf.liveHistory || perf.livePrice) && (
          <span
            className={`live-chip ${perf.loading ? 'dim' : ''}`}
            style={{ marginLeft: 8 }}
          >
            <span className="dot" />
            live data
          </span>
        )}
      </div>

      <div className="scoreboard">
        <div className="score">
          <div className="score-k">
            <span className="live-dot" />
            doubling time
          </div>
          <div className="score-v">
            <em>
              {perf.doublingDays != null ? perf.doublingDays.toFixed(1) : '—'}
            </em>
            <span className="small">days</span>
          </div>
          <div className="score-sub">
            {perf.doublingDays != null ? (
              <>
                stacSOL is doubling holders' money every{' '}
                <b>
                  {Math.max(1, Math.floor(perf.doublingDays - 1))}–
                  {Math.ceil(perf.doublingDays + 1)} days
                </b>{' '}
                at the current realized rate. Burn-loop reconciled every 5
                minutes.
              </>
            ) : (
              'Realised daily yield is derived from the indexed pool history. Live once a few snapshots have rolled in.'
            )}
          </div>
        </div>

        <div className="score">
          <div className="score-k">
            <span className="live-dot" />
            $100/day on
          </div>
          <div className="score-v tabular">
            {perf.solFor100 != null ? perf.solFor100.toFixed(2) : '—'}
            <span className="small">SOL</span>
          </div>
          <div className="score-sub">
            That's the SOL it currently takes, stacc'd, to print{' '}
            <b>$100/day</b>. At <b>${perf.solUsd.toFixed(0)}/SOL</b> spot.
            Recomputed every block.
          </div>
        </div>
      </div>

      <h1 className="hero-h1">
        Yield as <em>deflation,</em>
        <br /> not inflation.
      </h1>

      <p className="hero-lede">
        stacSOL is a hyper-yielding Solana liquid staking token. Built on
        Sanctum's audited stake pool, with a 6.9% Token-2022 transfer-fee burn
        loop layered on top — the redemption rate climbs from staking yield{' '}
        <em>and</em> from every cross-pair trade. Mathematically monotonic up.
      </p>

      <div className="hero-meta">
        <div className="meta-cell">
          <div className="meta-k">redemption rate</div>
          <div className="meta-v">
            <NavTicker rate={perf.rate} />
            <sup>↑</sup>
          </div>
          <div className="meta-sub">SOL per stacSOL · climbing</div>
        </div>
        <div className="meta-cell">
          <div className="meta-k">transfer fee</div>
          <div className="meta-v tabular">
            6.9
            <span
              style={{
                fontFamily: 'var(--f-mono)',
                fontSize: '0.45em',
                marginLeft: 2,
                color: 'var(--ink-muted)',
              }}
            >
              %
            </span>
          </div>
          <div className="meta-sub">burned every 5 min</div>
        </div>
        <div className="meta-cell">
          <div className="meta-k">backing</div>
          <div className="meta-v tabular">
            100
            <span
              style={{
                fontFamily: 'var(--f-mono)',
                fontSize: '0.45em',
                marginLeft: 2,
                color: 'var(--ink-muted)',
              }}
            >
              %
            </span>
          </div>
          <div className="meta-sub">liquid SOL reserve</div>
        </div>
        <div className="meta-cell">
          <div className="meta-k">implied APR</div>
          <div className="meta-v tabular">
            {!aprDisplayable || aprPct == null
              ? '—'
              : aprPct >= 1000
                ? Math.round(aprPct).toLocaleString()
                : aprPct.toFixed(1)}
            <span
              style={{
                fontFamily: 'var(--f-mono)',
                fontSize: '0.45em',
                marginLeft: 2,
                color: 'var(--ink-muted)',
              }}
            >
              %
            </span>
          </div>
          <div className="meta-sub">from 24h rate change</div>
        </div>
      </div>

      <div className="hero-cta-row">
        <a className="btn btn-primary" href="/app">
          Mint stacSOL
          <span className="arrow">→</span>
        </a>
        <a className="btn btn-ghost" href="#why">
          How it works
        </a>
        <a
          className="btn btn-ghost"
          href="/faq"
          style={{ borderColor: 'transparent' }}
        >
          Read the bankrun math
          <span className="arrow">↗</span>
        </a>
      </div>
    </section>
  )
}

function Proofs() {
  const items = [
    {
      n: 'PROOF A',
      t: '1 stacSOL is always worth more than 1 SOL plus accumulated yield.',
    },
    {
      n: 'PROOF B',
      t: 'Every transfer in the ecosystem burns 6.9% of itself. Forever.',
    },
    {
      n: 'PROOF C',
      t: 'Fewer tokens exist over time. Your share gets larger, automatically.',
    },
  ]
  return (
    <section className="section shell" id="why">
      <div className="section-head">
        <h2 className="section-h">
          Why <em>stake.</em>
        </h2>
        <p className="section-lede">
          When you mint stacSOL, every single transfer in the ecosystem
          withholds 6.9% — and every five minutes those withheld tokens are
          burned and reconciled into the redemption rate. The result is the
          same yield mechanics inverted: instead of diluting your bag with new
          emissions, the protocol concentrates your share of the existing one.
        </p>
      </div>

      <div className="proofs">
        {items.map(p => (
          <div className="proof" key={p.n}>
            <div className="proof-n">{p.n}</div>
            <div className="proof-text">{p.t}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Compare() {
  const rows = [
    {
      k: 'yield source',
      them: 'inflation — mint new tokens',
      us: 'deflation — burn existing tokens',
    },
    { k: 'supply over time', them: 'increases', us: 'decreases' },
    {
      k: 'your share value',
      them: 'diluted by emissions',
      us: 'concentrated by burns',
    },
    {
      k: 'transfer fee',
      them: '0% — free to move',
      us: '6.9% — burned forever',
    },
    {
      k: 'claim frequency',
      them: 'manual — you claim',
      us: 'auto — every transfer burns',
    },
    {
      k: 'rate trajectory',
      them: 'depends on validator',
      us: 'monotonically up — by program',
    },
  ]
  return (
    <section className="section shell" id="tokenomics">
      <div className="section-head">
        <h2 className="section-h">
          Built <em>different.</em>
        </h2>
        <p className="section-lede">
          Traditional staking inflates supply to pay yield. stacSOL deflates
          supply to deliver the same outcome — but with a redemption ratio the
          SPL stake-pool program is mathematically incapable of regressing.
        </p>
      </div>

      <div className="cmp">
        <div className="cmp-row head">
          <div>·</div>
          <div>them</div>
          <div>us</div>
        </div>
        {rows.map(r => (
          <div className="cmp-row" key={r.k}>
            <div className="label">{r.k}</div>
            <div className="them">{r.them}</div>
            <div className="us">{r.us}</div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Architecture() {
  return (
    <section className="section shell">
      <div className="section-head">
        <h2 className="section-h">
          The <em>mechanism.</em>
        </h2>
        <p className="section-lede">
          Two yield sources, both compounding into one ratio. No custom
          on-chain code — stacSOL uses Sanctum's deployed SPL stake-pool
          program unmodified. Token-2022 handles the transfer-fee accounting
          natively.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 0,
          borderTop: '1px solid var(--line)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div
          style={{
            padding: '40px 32px 40px 0',
            borderRight: '1px solid var(--line)',
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 18 }}>
            source one
          </div>
          <h3
            className="serif"
            style={{
              fontSize: 28,
              lineHeight: 1.1,
              margin: 0,
              marginBottom: 16,
              letterSpacing: '-0.015em',
            }}
          >
            Staking yield.
          </h3>
          <p
            style={{
              color: 'var(--ink-soft)',
              fontSize: 15,
              lineHeight: 1.6,
              maxWidth: '42ch',
              margin: 0,
            }}
          >
            Backing SOL sits in the pool reserve. The redemption ratio is{' '}
            <span className="mono" style={{ color: 'var(--ink)' }}>
              total_lamports / pool_token_supply
            </span>
            . The program has no code path that can decrease it.
          </p>
        </div>
        <div style={{ padding: '40px 0 40px 32px' }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>
            source two
          </div>
          <h3
            className="serif"
            style={{
              fontSize: 28,
              lineHeight: 1.1,
              margin: 0,
              marginBottom: 16,
              letterSpacing: '-0.015em',
            }}
          >
            Burn loop.
          </h3>
          <p
            style={{
              color: 'var(--ink-soft)',
              fontSize: 15,
              lineHeight: 1.6,
              maxWidth: '42ch',
              margin: 0,
            }}
          >
            Every five minutes the manager harvests withheld transfer fees,
            burns them, and reconciles{' '}
            <span className="mono" style={{ color: 'var(--ink)' }}>
              pool_token_supply
            </span>{' '}
            with the new mint supply. Both denominators shrink. Numerator
            unchanged. Ratio rises.
          </p>
        </div>
      </div>

      <div
        style={{
          marginTop: 56,
          padding: '48px 0',
          textAlign: 'center',
          borderTop: '1px solid var(--line-soft)',
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <div className="eyebrow" style={{ marginBottom: 28 }}>
          net asset value
        </div>
        <div
          className="serif tabular"
          style={{
            fontSize: 'clamp(36px, 5vw, 64px)',
            lineHeight: 1,
            letterSpacing: '-0.025em',
            color: 'var(--ink)',
          }}
        >
          NAV <span style={{ color: 'var(--ink-muted)' }}>=</span>{' '}
          <span
            style={{
              textDecoration: 'overline',
              textUnderlineOffset: 4,
              paddingBottom: 4,
            }}
          >
            total lamports
          </span>
          <span
            style={{
              display: 'inline-block',
              width: 1,
              height: '0.8em',
              background: 'var(--ink)',
              margin: '0 0.4em',
              verticalAlign: 'middle',
            }}
          />
          <span style={{ textDecoration: 'underline' }}>pool token supply</span>
        </div>
        <div
          className="mono"
          style={{
            marginTop: 24,
            color: 'var(--ink-muted)',
            fontSize: 12,
            letterSpacing: '0.1em',
          }}
        >
          monotonically non-decreasing · by program
        </div>
      </div>
    </section>
  )
}

function FaqStrip() {
  const items = [
    {
      q: 'Is it safe?',
      a: "The on-chain pool is Sanctum's audited SPL stake-pool program, deployed by Sanctum, used unmodified. No custom Rust in this repo.",
    },
    {
      q: 'Can the rate go down?',
      a: 'No. The SPL stake-pool program has no code path that decreases the redemption ratio. Burns shrink the denominator only.',
    },
    {
      q: 'How is the burn loop authorized?',
      a: 'Manager keypair can harvest, burn, and trigger UpdateStakePoolBalance. It cannot drain reserves, mint new stacSOL, or change the transfer fee config.',
    },
    {
      q: "What's the catch?",
      a: "Transferring stacSOL costs you 6.9% — by design. If you trade frequently you'll pay it; if you hold, the burn flywheel works for you.",
    },
  ]
  return (
    <section className="section shell" id="faq">
      <div className="section-head">
        <h2 className="section-h">
          Reasonable <em>questions.</em>
        </h2>
        <p className="section-lede">
          The full bankrun math, safety properties, fee mechanics, and operator
          authorities are documented and rendered against live pool state at{' '}
          <a
            href="/faq"
            style={{
              color: 'var(--accent-deep)',
              textDecoration: 'underline',
              textDecorationThickness: 1,
              textUnderlineOffset: 3,
            }}
          >
            /faq
          </a>
          .
        </p>
      </div>
      <div style={{ borderTop: '1px solid var(--line)' }}>
        {items.map((it, i) => (
          <details
            key={i}
            style={{
              borderBottom: '1px solid var(--line-soft)',
              padding: '22px 0',
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                listStyle: 'none',
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 24,
                fontSize: 18,
                fontFamily: 'var(--f-display)',
                letterSpacing: '-0.01em',
                color: 'var(--ink)',
              }}
            >
              <span>{it.q}</span>
              <span
                className="mono"
                style={{
                  color: 'var(--ink-muted)',
                  fontSize: 13,
                  fontFeatureSettings: '"tnum" 1',
                }}
              >
                {String(i + 1).padStart(2, '0')} →
              </span>
            </summary>
            <p
              style={{
                margin: '14px 0 0',
                color: 'var(--ink-soft)',
                fontSize: 15,
                lineHeight: 1.6,
                maxWidth: '62ch',
                textWrap: 'pretty',
              }}
            >
              {it.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  )
}

function Closing() {
  return (
    <section className="closing shell">
      <h2>
        Welcome to <br /> the <em>staccening.</em>
      </h2>
      <p className="sub">
        stacSOL is SOL on crack — the redemption rate cannot regress. Instead
        of selling and missing the upside, just borrow against it.
      </p>
      <div className="cta-row">
        <a className="btn btn-primary" href="/app">
          Start staccing
          <span className="arrow">→</span>
        </a>
        <button
          className="btn btn-ghost"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        >
          Back to top
        </button>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="foot">
      <div className="shell foot-inner">
        <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
          <a href="/faq">FAQ</a>
          <a href="/leaderboard">Leaderboard</a>
          <a href="/portfolio">Portfolio</a>
          <a href="/terms">Terms</a>
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
        <div className="addr">
          mint · 6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f
        </div>
      </div>
    </footer>
  )
}

// Nav rendered via shared EditorialNav (see components/EditorialNav.tsx).

export default function Landing() {
  const perf = useLivePerf()

  // Tag the body so the editorial palette/typography in stacsol.css applies
  // to this surface only.
  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  return (
    <>
      <EditorialNav pathname="/" />
      <main>
        <HeroBlock perf={perf} />
        <Proofs />
        <Compare />
        <Architecture />
        <FaqStrip />
        <Closing />
        <Footer />
      </main>
    </>
  )
}
