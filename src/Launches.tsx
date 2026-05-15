// /launches — dashboard of every curve indexed by stacc-backend.
//
// Pulls GET /curves (sorted by TVL by default, with a recent toggle),
// renders each as a card linking to /trade?mint=<pubkey>. A prominent
// "+ launch new" pill in the top-right hops to /create.
//
// Falls back to a friendly empty-state when the backend's degraded
// (no Neon DB) or no curves exist yet.

import { useEffect, useMemo, useState } from 'react'

import EditorialNav from './components/EditorialNav'
import WalletPill from './components/WalletPill'

const BACKEND_URL =
  (import.meta as unknown as { env?: { VITE_BACKEND_URL?: string } }).env
    ?.VITE_BACKEND_URL ?? 'http://127.0.0.1:3000'

interface CurveRow {
  mint: string
  bondingCurve: string
  creator: string
  name: string | null
  symbol: string | null
  uri: string | null
  complete: boolean
  migrated: boolean
  realQuoteReserves: string
  virtualQuoteReserves: string
  realTokenReserves: string
  virtualTokenReserves: string
  tokenTotalSupply: string
  createdAt: string
  updatedAt: string
}

type Sort = 'tvl' | 'recent'

// stacSOL atoms (9 decimals) → human stacSOL
const ATOMS_PER_LST = 1_000_000_000

function formatLst(atomsStr: string): string {
  const atoms = BigInt(atomsStr || '0')
  const whole = Number(atoms) / ATOMS_PER_LST
  if (whole < 0.001) return whole.toExponential(2)
  if (whole < 1) return whole.toFixed(4)
  if (whole < 100) return whole.toFixed(2)
  return Math.round(whole).toLocaleString()
}

function shorten(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`
}

interface OffChainMeta {
  image?: string
  description?: string
}

// Small in-memory cache so re-renders don't refetch the same URI.
const offChainCache = new Map<string, OffChainMeta | null>()

function useOffChainMeta(uri: string | null): OffChainMeta | null {
  const [meta, setMeta] = useState<OffChainMeta | null>(
    uri ? offChainCache.get(uri) ?? null : null,
  )
  useEffect(() => {
    if (!uri) return
    if (offChainCache.has(uri)) {
      setMeta(offChainCache.get(uri) ?? null)
      return
    }
    let cancelled = false
    fetch(uri)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: OffChainMeta | null) => {
        if (cancelled) return
        offChainCache.set(uri, j ?? null)
        setMeta(j)
      })
      .catch(() => {
        if (!cancelled) {
          offChainCache.set(uri, null)
          setMeta(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [uri])
  return meta
}

function CurveCard({ c }: { c: CurveRow }) {
  const meta = useOffChainMeta(c.uri)
  const status = c.migrated ? 'migrated' : c.complete ? 'graduated' : 'live'
  const statusColor =
    status === 'migrated' ? '#0a6e3c' : status === 'graduated' ? '#a86a00' : '#999'

  return (
    <a
      href={`/trade?mint=${c.mint}`}
      style={{
        display: 'flex',
        gap: 16,
        padding: 16,
        border: '1px solid rgb(0 0 0 / 0.12)',
        borderRadius: 12,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 120ms',
        background: 'var(--bg, transparent)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'rgb(0 0 0 / 0.32)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'rgb(0 0 0 / 0.12)'
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 8,
          background: 'rgb(0 0 0 / 0.04)',
          flexShrink: 0,
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {meta?.image ? (
          <img
            src={meta.image}
            alt={c.name ?? c.symbol ?? c.mint}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div style={{ fontSize: 24, color: 'var(--color-dim, #888)' }}>
            {(c.symbol ?? '?').slice(0, 2).toUpperCase()}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ fontSize: 16, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {c.name ?? '(no name)'}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-dim, #888)', fontWeight: 600 }}>
            ${c.symbol ?? '?'}
          </div>
          <div
            style={{
              fontSize: 10,
              padding: '2px 6px',
              borderRadius: 4,
              background: `${statusColor}22`,
              color: statusColor,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            {status}
          </div>
        </div>
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-dim, #888)', fontFamily: 'monospace' }}>
          {shorten(c.mint)} · {new Date(c.createdAt).toLocaleDateString()}
        </div>
        {meta?.description && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: 'var(--color-text, #444)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
            }}
          >
            {meta.description}
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right', minWidth: 72 }}>
        <div style={{ fontSize: 10, color: 'var(--color-dim, #888)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          tvl
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 2 }}>
          {formatLst(c.realQuoteReserves)}
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-dim, #888)' }}>stacSOL</div>
      </div>
    </a>
  )
}

export default function Launches() {
  const [curves, setCurves] = useState<CurveRow[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('tvl')

  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/curves?sort=${sort}&limit=100`)
        if (!res.ok) {
          if (!cancelled) setErr(`backend ${res.status}`)
          return
        }
        const j = (await res.json()) as { curves?: CurveRow[]; degraded?: boolean }
        if (cancelled) return
        setErr(null)
        setCurves(j.curves ?? [])
      } catch (e) {
        if (!cancelled) setErr((e as Error).message)
      }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sort])

  const subtitle = useMemo(() => {
    if (curves === null) return 'loading…'
    if (curves.length === 0) return 'no curves indexed yet — be the first'
    return `${curves.length} curve${curves.length === 1 ? '' : 's'}`
  }, [curves])

  return (
    <>
      <EditorialNav pathname="/launches" ctaSlot={<WalletPill />} />
      <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px 96px' }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.01em', margin: 0 }}>
              launches
            </h1>
            <div style={{ marginTop: 4, fontSize: 13, color: 'var(--color-dim, #888)' }}>
              {subtitle}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', border: '1px solid rgb(0 0 0 / 0.12)', borderRadius: 8, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setSort('tvl')}
                style={{
                  padding: '6px 12px',
                  border: 'none',
                  background: sort === 'tvl' ? 'rgb(0 0 0 / 0.08)' : 'transparent',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontWeight: sort === 'tvl' ? 600 : 400,
                }}
              >
                tvl
              </button>
              <button
                type="button"
                onClick={() => setSort('recent')}
                style={{
                  padding: '6px 12px',
                  border: 'none',
                  background: sort === 'recent' ? 'rgb(0 0 0 / 0.08)' : 'transparent',
                  fontSize: 12,
                  cursor: 'pointer',
                  fontWeight: sort === 'recent' ? 600 : 400,
                }}
              >
                recent
              </button>
            </div>
            <a
              href="/create"
              style={{
                padding: '8px 16px',
                background: '#0a6e3c',
                color: '#fff',
                borderRadius: 8,
                textDecoration: 'none',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              + launch new
            </a>
          </div>
        </header>

        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {err && (
            <div
              style={{
                padding: 16,
                border: '1px dashed rgb(220 60 60 / 0.4)',
                borderRadius: 8,
                color: '#b04040',
                fontSize: 13,
              }}
            >
              {err} — make sure stacc-backend is running and{' '}
              <code>VITE_BACKEND_URL</code> points at it.
            </div>
          )}
          {curves !== null && curves.length === 0 && !err && (
            <div
              style={{
                padding: 32,
                border: '1px dashed rgb(0 0 0 / 0.16)',
                borderRadius: 12,
                textAlign: 'center',
                color: 'var(--color-dim, #888)',
              }}
            >
              <div style={{ fontSize: 32 }}>👻</div>
              <div style={{ marginTop: 8, fontSize: 14 }}>nothing's been launched yet</div>
              <a
                href="/create"
                style={{
                  display: 'inline-block',
                  marginTop: 16,
                  padding: '8px 16px',
                  background: '#0a6e3c',
                  color: '#fff',
                  borderRadius: 8,
                  textDecoration: 'none',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                launch the first curve →
              </a>
            </div>
          )}
          {curves?.map((c) => (
            <CurveCard key={c.mint} c={c} />
          ))}
        </div>
      </main>
    </>
  )
}
