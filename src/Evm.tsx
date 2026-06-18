// stacSOL — `/evm`. Why the deflationary LST mechanic is Solana-only.
//
// Long-form comparison against EVM LSTs, Uniswap-style AMMs, and pump.fun's
// cross-chain expansion. No wallet provider — pure editorial content using the
// same design system as /terms and /faq.

import { useEffect, type ReactNode } from 'react'
import EditorialNav from './components/EditorialNav'

function Good({ children }: { children: ReactNode }) {
  return <span style={{ color: 'var(--accent-deep)', fontWeight: 600 }}>{children}</span>
}

function Bad({ children }: { children: ReactNode }) {
  return <span style={{ color: '#c44', fontWeight: 600 }}>{children}</span>
}

function Mute({ children }: { children: ReactNode }) {
  return (
    <span style={{ display: 'block', marginTop: 4, color: 'var(--ink-muted)', fontSize: 12 }}>
      {children}
    </span>
  )
}

function CompareRow({
  dim,
  evm,
  stac,
  pump,
}: {
  dim: string
  evm: ReactNode
  stac: ReactNode
  pump: ReactNode
}) {
  return (
    <div
      className="evm-cmp-row"
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(140px, 180px) repeat(3, 1fr)',
        gap: 1,
        background: 'var(--line-soft)',
      }}
    >
      <div
        style={{
          background: 'var(--bg)',
          padding: '14px 16px',
          fontFamily: 'var(--f-mono)',
          fontSize: 10.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--ink-muted)',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        {dim}
      </div>
      <div style={{ background: 'var(--bg)', padding: '14px 16px', fontSize: 14, color: 'var(--ink-soft)' }}>
        {evm}
      </div>
      <div style={{ background: 'var(--bg)', padding: '14px 16px', fontSize: 14, color: 'var(--ink)' }}>
        {stac}
      </div>
      <div style={{ background: 'var(--bg)', padding: '14px 16px', fontSize: 14, color: 'var(--ink-soft)' }}>
        {pump}
      </div>
    </div>
  )
}

const WHY_SOLANA = [
  {
    n: '01',
    title: 'Transfer fees need program enforcement',
    body:
      'On EVM, a token fee hook requires every contract that touches the token to call it explicitly. Uniswap v2/v3 core contracts do not. On Solana, Token-2022 enforces the 6.9% transfer fee unconditionally — swaps, sends, LP deposits, game bids, everything. Zero cooperation from pool contracts.',
  },
  {
    n: '02',
    title: 'Burns must reconcile into the redemption rate',
    body:
      'stacSOL uses Sanctum\'s audited SPL stake-pool program. The manager harvests withheld fees, burns them, and cranks UpdateStakePoolBalance so pool_token_supply tracks the live mint. EVM LSTs have no equivalent primitive that shrinks the share denominator on every transfer.',
  },
  {
    n: '03',
    title: '28 pools is cheap here, impossible on EVM',
    body:
      'Each Solana swap costs ~$0.001. Running dozens of active AMM pools with burns firing on every trade is viable. On EVM at $10–100 per swap, you would never bootstrap that burn surface for a single asset — the economics do not work.',
  },
  {
    n: '04',
    title: 'No upgradeable factory per market',
    body:
      'The navwrap program controls mint authority via a Program Derived Address per market. Burns, metadata updates, and fee parameters happen atomically in the same transaction as wrap/unwrap. On EVM you need a separate factory contract per token with upgrade risk.',
  },
]

export default function Evm() {
  useEffect(() => {
    const prev = document.title
    document.title = 'stacSOL — why not EVM'
    return () => {
      document.title = prev
    }
  }, [])

  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  return (
    <>
      <EditorialNav pathname="/evm" />
      <main className="terms-page shell">
        <header className="terms-hero">
          <div className="eyebrow">chain thesis</div>
          <h1>
            Why <em>not EVM.</em>
          </h1>
          <div className="meta">
            <span>stacSOL · Solana only</span>
            <span>updated · 2026-06-18</span>
            <span>no finalized EVM equivalent</span>
          </div>
          <p className="lede">
            stacSOL's deflationary LST mechanic — 6.9% transfer fee burned into a
            monotonically rising redemption rate — depends on primitives that do
            not exist on Ethereum today. This page explains what breaks when you
            try to port it, and why the live proof runs on Solana.
          </p>
        </header>

        <div className="terms-body" style={{ maxWidth: 'none' }}>
          <section className="terms-section">
            <span className="num">§ 01 · the proof</span>
            <h2>stacSOL already did the thing.</h2>
            <p>
              stacSOL started at 1.00 SOL/stacSOL at genesis. The live redemption
              rate has climbed purely from staking yield plus transfer-fee burns —
              no claiming, no manual staking UI, no LP position to manage.{' '}
              <strong>NAV = backing ÷ supply</strong>. Supply shrinks on every
              transfer; backing grows from validator rewards. The rate only goes up.
            </p>
            <p>
              That is the empirical proof-of-concept.{' '}
              <a href="https://fragged.app/wtf">fragged.app</a> generalizes the
              same vault÷supply math to stablecoin fragments where the vault grows
              from burns instead of staking. The mathematics are identical; only the
              yield source changes.
            </p>
          </section>

          <section className="terms-section">
            <span className="num">§ 02 · e2e comparison</span>
            <h2>
              stacSOL vs <em>EVM</em> vs pump.fun.
            </h2>
            <p>
              Three models people reach for when they hear "deflationary yield."
              Only one has a working on-chain implementation with a live NAV history.
            </p>
            <div
              style={{
                marginTop: 28,
                borderRadius: 12,
                overflow: 'hidden',
                border: '1px solid var(--line)',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(140px, 180px) repeat(3, 1fr)',
                  gap: 1,
                  background: 'var(--line-soft)',
                }}
              >
                <div style={{ background: '#18181b', padding: '12px 14px' }} />
                <div
                  style={{
                    background: '#18181b',
                    padding: '12px 14px',
                    fontFamily: 'var(--f-mono)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.12em',
                    color: '#f87171',
                    textTransform: 'uppercase',
                  }}
                >
                  EVM LST / AMM
                </div>
                <div
                  style={{
                    background: '#18181b',
                    padding: '12px 14px',
                    fontFamily: 'var(--f-mono)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.12em',
                    color: 'var(--accent-deep)',
                    textTransform: 'uppercase',
                  }}
                >
                  stacSOL
                </div>
                <div
                  style={{
                    background: '#18181b',
                    padding: '12px 14px',
                    fontFamily: 'var(--f-mono)',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.12em',
                    color: '#facc15',
                    textTransform: 'uppercase',
                  }}
                >
                  pump.fun
                </div>
              </div>
              <CompareRow
                dim="structural floor"
                evm={
                  <>
                    <Bad>no burn floor</Bad>
                    <Mute>LST rate can stall; AMM LPs bear IL</Mute>
                  </>
                }
                stac={
                  <>
                    <Good>SOL backing floor</Good>
                    <Mute>redeem via stake-pool program</Mute>
                  </>
                }
                pump={
                  <>
                    <Bad>zero · spec only</Bad>
                    <Mute>bonding curve support ends at graduation</Mute>
                  </>
                }
              />
              <CompareRow
                dim="supply mechanic"
                evm={
                  <>
                    fixed or inflationary
                    <Mute>rebases, emissions, or static ERC-20 supply</Mute>
                  </>
                }
                stac={
                  <>
                    <Good>deflationary · T22 burn</Good>
                    <Mute>every transfer reduces supply</Mute>
                  </>
                }
                pump={
                  <>
                    <Bad>inflationary bonding</Bad>
                    <Mute>minted on buy, dumped on sell</Mute>
                  </>
                }
              />
              <CompareRow
                dim="NAV direction"
                evm={
                  <>
                    bidirectional
                    <Mute>IL drags LP below entry; LST rate depends on validator</Mute>
                  </>
                }
                stac={
                  <>
                    <Good>monotone up only</Good>
                    <Mute>backing ÷ supply, supply shrinks</Mute>
                  </>
                }
                pump={
                  <>
                    any direction
                    <Mute>reflexive speculation, no structural bid</Mute>
                  </>
                }
              />
              <CompareRow
                dim="fee destination"
                evm={
                  <>
                    dispersed to LPs / protocol
                    <Mute>must be claimed per-position</Mute>
                  </>
                }
                stac={
                  <>
                    <Good>burned to NAV</Good>
                    <Mute>manager loop every ~5 min · automatic</Mute>
                  </>
                }
                pump={
                  <>
                    0.3% creator + protocol cut
                    <Mute>PumpSwap fees post-grad</Mute>
                  </>
                }
              />
              <CompareRow
                dim="yield source"
                evm={
                  <>
                    swap fees + staking
                    <Mute>Uniswap V4 hooks add dynamic fees on 4 chains</Mute>
                  </>
                }
                stac={
                  <>
                    <Good>T22 xfer burn + staking</Good>
                    <Mute>two sources, one redemption ratio</Mute>
                  </>
                }
                pump={
                  <>
                    price appreciation only
                    <Mute>no structural yield post-grad</Mute>
                  </>
                }
              />
              <CompareRow
                dim="chain requirement"
                evm={
                  <>
                    EVM-native
                    <Mute>no ERC-20 transfer-fee primitive as of June 2026</Mute>
                  </>
                }
                stac={
                  <>
                    <Good>Solana · Token-2022</Good>
                    <Mute>Sanctum stake-pool · deployed & audited</Mute>
                  </>
                }
                pump={
                  <>
                    Solana primary · EVM signaled
                    <Mute>eth/base/monad subdomains spotted</Mute>
                  </>
                }
              />
            </div>
          </section>

          <section className="terms-section">
            <span className="num">§ 03 · primitives</span>
            <h2>Why this only works on Solana.</h2>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: 20,
                marginTop: 8,
              }}
            >
              {WHY_SOLANA.map(c => (
                <div
                  key={c.n}
                  style={{
                    borderTop: '1px solid var(--line)',
                    paddingTop: 24,
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      fontSize: 11,
                      letterSpacing: '0.14em',
                      color: 'var(--accent-deep)',
                      marginBottom: 10,
                    }}
                  >
                    {c.n}
                  </div>
                  <h3 style={{ margin: '0 0 10px', fontSize: 17 }}>{c.title}</h3>
                  <p style={{ margin: 0, fontSize: 14, color: 'var(--ink-soft)', lineHeight: 1.7 }}>
                    {c.body}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="terms-section">
            <span className="num">§ 04 · the pitch</span>
            <h2>put pump.fun on EVM?</h2>
            <p>
              The Burgess pitch — <em>"put pump.fun on evm / I rake some % protocol
              fees"</em> — is the same thread as stacSOL's burn flywheel, but the
              handshake problem kills it on EVM. A bonding curve or AMM on Ethereum
              cannot enforce a universal transfer fee at the token-program level. Every
              router, pool, and aggregator would need to opt in. They do not.
            </p>
            <p>
              pump.fun's Solana implementation works because Token-2022 burns on every
              move. The game at{' '}
              <a href="https://client.staccpad.fun" target="_blank" rel="noreferrer">
                client.staccpad.fun
              </a>{' '}
              funds stacSOL deflation the same way — every bid pays 6.9%, every fee
              compounds into NAV. Porting that loop to EVM is not a frontend problem.
              It is a missing primitive.
            </p>
          </section>

          <section className="terms-section">
            <span className="num">§ 05 · next</span>
            <h2>Where to go from here.</h2>
            <p>
              If you want the live instrument, mint on{' '}
              <a href="/app">/app</a>. If you want the bankrun math, read{' '}
              <a href="/faq">/faq</a>. If you want the fragment generalization of
              the same NAV mechanic on stablecoins, see{' '}
              <a href="https://fragged.app/wtf" target="_blank" rel="noreferrer">
                fragged.app/wtf
              </a>
              .
            </p>
            <div className="hero-cta-row" style={{ marginTop: 28 }}>
              <a className="btn btn-primary" href="/app">
                Mint stacSOL
                <span className="arrow">→</span>
              </a>
              <a className="btn btn-ghost" href="/faq">
                Read the bankrun math
                <span className="arrow">↗</span>
              </a>
            </div>
          </section>
        </div>
      </main>
    </>
  )
}