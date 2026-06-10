import { useMemo } from 'react'
import { Card } from './Stats'
import { useLpPrice, type LpMarket } from '../hooks/useLpPrice'

// Lists every market Birdeye knows about for stacSOL — grouped into
// the protocol pool (Sanctum, equals NAV), SOL-paired LPs, and
// cross-pairs against other thystaccfloweth-family tokens.

export function Markets() {
  const { markets, error, loading } = useLpPrice()

  const grouped = useMemo(() => {
    const protocol = markets.filter((m) => m.isProtocolPool)
    const solPair = markets
      .filter((m) => !m.isProtocolPool && m.isSolPair)
      .sort((a, b) => b.liquidity - a.liquidity)
    const cross = markets
      .filter((m) => !m.isProtocolPool && !m.isSolPair)
      .sort((a, b) => b.liquidity - a.liquidity)
    return { protocol, solPair, cross }
  }, [markets])

  const totalSolPairLiq = grouped.solPair.reduce((s, m) => s + (m.liquidity || 0), 0)
  const totalCrossLiq = grouped.cross.reduce((s, m) => s + (m.liquidity || 0), 0)

  return (
    <Card title="Markets">
      <p className="m-0 mb-3 text-[12px] text-[var(--color-dim)] leading-relaxed">
        Every venue Birdeye sees holding stacSOL. The{' '}
        <span className="text-[var(--color-green)] font-black">protocol pool</span>{' '}
        is NAV (where mint/burn redeems).{' '}
        <span className="text-[var(--color-hot)] font-black">SOL pairs</span>{' '}
        are thin secondary AMMs — don&apos;t trade them.{' '}
        <span className="text-[var(--color-ember)] font-black">Cross-pairs</span>{' '}
        are stacSOL paired against other thystaccfloweth tokens — every swap
        in those feeds the 6.9% transfer-fee burn. They&apos;re the engine.
      </p>

      {error && (
        <p className="m-0 mb-2 text-[11px] text-[var(--color-warn)]">
          markets fetch error: {error}
        </p>
      )}
      {!error && markets.length === 0 && !loading && (
        <p className="m-0 text-[11px] text-[var(--color-dim)]">no markets yet…</p>
      )}

      {grouped.protocol.length > 0 && (
        <Group title="Protocol pool (NAV)" tone="green">
          {grouped.protocol.map((m) => (
            <Row key={m.address} m={m} tone="green" />
          ))}
        </Group>
      )}

      {grouped.solPair.length > 0 && (
        <Group
          title={`SOL pairs (${grouped.solPair.length})`}
          tone="hot"
          subtitle={`total LP TVL: $${fmtNum(totalSolPairLiq)}`}
        >
          {grouped.solPair.map((m) => (
            <Row key={m.address} m={m} tone="hot" />
          ))}
        </Group>
      )}

      {grouped.cross.length > 0 && (
        <Group
          title={`Cross-pairs (${grouped.cross.length})`}
          tone="dim"
          subtitle={`total cross TVL: $${fmtNum(totalCrossLiq)}`}
        >
          {grouped.cross.map((m) => (
            <Row key={m.address} m={m} tone="dim" />
          ))}
        </Group>
      )}

      <p className="mt-3 text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
        markets via birdeye · refreshes every 30s
      </p>
    </Card>
  )
}

function Group({
  title,
  subtitle,
  tone,
  children,
}: {
  title: string
  subtitle?: string
  tone: 'green' | 'hot' | 'dim'
  children: React.ReactNode
}) {
  const c =
    tone === 'green'
      ? 'var(--color-green)'
      : tone === 'hot'
      ? 'var(--color-hot)'
      : 'var(--color-fg)'
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between mb-2">
        <span
          className="text-[10px] font-black uppercase tracking-[3px]"
          style={{ color: c }}
        >
          {title}
        </span>
        {subtitle && (
          <span className="text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
            {subtitle}
          </span>
        )}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Row({ m, tone }: { m: LpMarket; tone: 'green' | 'hot' | 'dim' }) {
  const c =
    tone === 'green'
      ? 'var(--color-green)'
      : tone === 'hot'
      ? 'var(--color-hot)'
      : 'var(--color-dim)'
  // Show price meaningfully for SOL pairs — invert if SOL is base. Birdeye
  // can return null/0 for very thin markets, so handle that defensively.
  let priceLabel = '—'
  if (m.price != null && isFinite(m.price) && m.price > 0) {
    if (m.isSolPair) {
      const solPerStac = m.isStacsolBase ? m.price : 1 / m.price
      priceLabel = `${solPerStac.toFixed(6)} SOL`
    } else {
      priceLabel = `${m.price.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${
        m.isStacsolBase ? m.quote.symbol : m.base.symbol
      }`
    }
  }

  return (
    <div className="bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)] grid grid-cols-[1fr_auto] gap-3 items-center">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-black uppercase tracking-[2px] px-1.5 py-0.5 rounded border"
            style={{ color: c, borderColor: `${c}55` }}
          >
            {m.source}
          </span>
          <span className="text-[12px] font-black text-[var(--color-fg)] truncate">
            {m.name}
          </span>
        </div>
        <div className="text-[10px] text-[var(--color-dim)] mt-1 font-mono truncate">
          {m.address.slice(0, 8)}…{m.address.slice(-6)}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="tabular-mono text-[12px] font-black" style={{ color: c }}>
          {priceLabel}
        </div>
        <div className="text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
          ${fmtNum(m.liquidity)} liq · ${fmtNum(m.volume24h)} v24h
        </div>
      </div>
    </div>
  )
}

function fmtNum(n: number) {
  if (n == null || !isFinite(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}k`
  if (Math.abs(n) >= 1) return n.toFixed(2)
  return n.toFixed(4)
}
