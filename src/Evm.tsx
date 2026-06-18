// stacSOL — `/evm`. Multi-chain EVM vaults: stacHYPE / stacETH / stacBNB.
//
// Each chain runs the same ERC-4626 flywheel — 6.9% mint, redeem, and
// transfer fees burned into a monotonically rising redemption rate — backed
// by that chain's native yield LST. Cards surface live NAV from /api/evm-nav
// and deep-link to the verified contracts on each explorer.

import { useEffect, useState } from 'react'
import EditorialNav from './components/EditorialNav'
import { EvmActionPanel } from './components/EvmActionPanel'
import EvmWalletPill from './components/EvmWalletPill'
import { useEvmNav } from './hooks/useEvmNav'
import {
  EVM_CHAINS,
  explorerAddress,
  type EvmChainConfig,
} from './lib/evm-chains'

function fmtNav(n: number | null | undefined, d = 6): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(d)
}

function fmtAtoms(raw: string | null, decimals = 18, d = 4): string {
  if (!raw) return '—'
  try {
    const n = Number(BigInt(raw)) / 10 ** decimals
    if (!Number.isFinite(n)) return '—'
    return n.toLocaleString(undefined, { maximumFractionDigits: d })
  } catch {
    return '—'
  }
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function ChainCard({
  chain,
  nav,
  live,
  assets,
  supply,
}: {
  chain: EvmChainConfig
  nav: number | null
  live: boolean
  assets: string | null
  supply: string | null
}) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(chain.contract)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  return (
    <article
      className="position evm-card"
      style={{ borderTop: `3px solid ${chain.accent}` }}
    >
      <div className="position-head">
        <div>
          <div
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: chain.accent,
              marginBottom: 6,
            }}
          >
            {chain.short} · chain {chain.chainId}
          </div>
          <h2 className="position-h" style={{ margin: 0 }}>
            {chain.name}
          </h2>
        </div>
        <span className={`live-chip ${live ? '' : 'dim'}`}>
          <span className="dot" />
          {live ? 'live' : 'pending'}
        </span>
      </div>

      <div className="position-bal tabular" style={{ marginTop: 8 }}>
        {fmtNav(nav)}
        <span className="unit">
          {chain.backing}/{chain.symbol}
        </span>
      </div>
      <div className="position-eq">
        <b>{chain.symbol}</b> · {chain.tokenName}
      </div>

      <div className="position-table">
        <div className="pt-row">
          <span className="pt-k">Backing</span>
          <span className="pt-v">{chain.backingLabel}</span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Vault assets</span>
          <span className="pt-v tabular">{fmtAtoms(assets)} {chain.backing}</span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Supply</span>
          <span className="pt-v tabular">{fmtAtoms(supply)} {chain.symbol}</span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Fees</span>
          <span className="pt-v">{chain.feePct}% mint · redeem · xfer → burn</span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Contract</span>
          <span className="pt-v" style={{ fontSize: 11 }}>
            {shortAddr(chain.contract)}
          </span>
        </div>
      </div>

      <EvmActionPanel chain={chain} nav={nav} />

      <div className="evm-card-actions">
        <a
          className="btn btn-ghost"
          href={explorerAddress(chain)}
          target="_blank"
          rel="noreferrer"
        >
          Explorer
          <span className="arrow">↗</span>
        </a>
        <button type="button" className="btn btn-ghost" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy address'}
        </button>
      </div>
    </article>
  )
}

export default function Evm() {
  const { byId, loading, data } = useEvmNav()

  useEffect(() => {
    const prev = document.title
    document.title = 'stacSOL — EVM'
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
      <EditorialNav
        pathname="/evm"
        ctaSlot={<EvmWalletPill label="Connect EVM wallet" />}
      />
      <main className="dash shell">
        <section style={{ paddingBlock: '32px 28px' }}>
          <div className="eyebrow" style={{ marginBottom: 16 }}>
            evm · multi-chain flywheel
          </div>
          <h1
            className="serif"
            style={{
              fontSize: 'clamp(36px, 5vw, 56px)',
              lineHeight: 1.02,
              letterSpacing: '-0.025em',
              margin: 0,
              maxWidth: '20ch',
            }}
          >
            stacSOL on <em style={{ color: 'var(--accent-deep)' }}>EVM.</em>
          </h1>
          <p
            style={{
              maxWidth: '58ch',
              marginTop: 18,
              fontSize: 16,
              lineHeight: 1.55,
              color: 'var(--ink-soft)',
            }}
          >
            The same hyper-yielding vault math as Solana — ERC-4626 vaults on
            Hyperliquid, Ethereum, Base, and BNB. Each receipt token is backed by
            that chain&apos;s yield-bearing LST; 6.9% on every mint, redeem, and
            transfer is burned straight into NAV.
          </p>
          <p
            style={{
              maxWidth: '58ch',
              marginTop: 14,
              fontSize: 14,
              lineHeight: 1.55,
              color: 'var(--ink-muted)',
            }}
          >
            Solana stacSOL still lives at{' '}
            <a href="/app" style={{ color: 'var(--accent-deep)' }}>
              /app
            </a>
            . These EVM vaults are independent deployments — deposit the backing
            asset on each chain to mint the local receipt token.
          </p>
        </section>

        <div className="evm-grid">
          {EVM_CHAINS.map((chain) => {
            const row = byId(chain.id)
            return (
              <ChainCard
                key={chain.id}
                chain={chain}
                nav={row?.nav ?? null}
                live={row?.live ?? false}
                assets={row?.totalAssets ?? null}
                supply={row?.totalSupply ?? null}
              />
            )
          })}
        </div>

        <section
          style={{
            marginTop: 48,
            paddingBlock: 28,
            borderTop: '1px solid var(--line)',
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 12 }}>
            how it works
          </div>
          <p
            style={{
              maxWidth: '62ch',
              fontSize: 15,
              lineHeight: 1.65,
              color: 'var(--ink-soft)',
              margin: 0,
            }}
          >
            Each vault is an audited ERC-4626 share token.{' '}
            <strong>NAV = totalAssets ÷ totalSupply</strong>. Fees on mint,
            redeem, and transfer shrink supply while backing stays in the vault —
            so the redemption rate only climbs. Connect an EVM wallet above, pick
            a chain card, and mint from native gas token or the backing LST —
            approve + deposit happen in-wallet. Redeem returns the backing LST.
          </p>
          {data?.fetchedAt && (
            <div
              className="mono"
              style={{
                marginTop: 16,
                fontSize: 10,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--ink-faint)',
              }}
            >
              NAV refreshed ·{' '}
              {loading ? 'updating…' : new Date(data.fetchedAt).toLocaleTimeString()}
            </div>
          )}
        </section>
      </main>
    </>
  )
}