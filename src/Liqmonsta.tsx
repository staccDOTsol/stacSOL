// /liqmonsta — one-click migrator from SOL-paired LPs → stacSOL-paired LPs,
// across every AMM that has a resolver registered.
//
// Wiring status flows from src/lib/resolvers/<amm>.ts → ResolverMeta. Each
// resolver knows how to scan, close, and reopen for its AMM. The page itself
// is AMM-agnostic — adding a new AMM is just dropping in a resolver file.
//
// SMASH flow per position:
//   1. resolver.buildCloseTxs(pos)              → tx that recovers SOL + tokenB
//   2. SOL → stacSOL via DepositSol             → fresh stacSOL bag
//   3. resolver.buildOpenTxs(pos, stacEst)      → new position on stacSOL/tokenB
//   4. one wallet sign covers all of them
//   5. sequential submit via Helius Sender, polling each sig to confirmed
//      before the next so dependent txs see chain state.

import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import { ixCreateAtaIdempotent, ixDepositSol } from './lib/ix'
import { MINT as STACSOL_MINT_PK } from './lib/constants'
import { fetchPool } from './lib/pool'
import {
  HELIUS_SENDER_TIP_LAMPORTS,
  heliusTipIx,
  pollAllSigsConfirmed,
  sendViaHeliusSender,
  solscanTx,
} from './lib/zap'
import {
  loadResolvers,
  type AmmResolver,
  type AmmType,
  type RawPosition,
} from './lib/resolvers'

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type StepState = 'pending' | 'running' | 'done' | 'error' | 'skipped'

interface SmashStep {
  label: string
  state: StepState
  detail?: string
  sig?: string
}

interface PerPositionLog {
  positionKey: string
  steps: SmashStep[]
}

// -----------------------------------------------------------------------------
// Page
// -----------------------------------------------------------------------------

export default function Liqmonsta() {
  useEffect(() => {
    const prev = document.title
    document.title = 'liqmonsta — one-click LP migrate to stacSOL'
    return () => {
      document.title = prev
    }
  }, [])

  const { connection } = useConnection()
  const { publicKey, signAllTransactions } = useWallet()

  const [resolvers, setResolvers] = useState<AmmResolver[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanErr, setScanErr] = useState<string | null>(null)
  const [positions, setPositions] = useState<RawPosition[]>([])
  const [nav, setNav] = useState<number | null>(null)
  const [smashing, setSmashing] = useState(false)
  const [logs, setLogs] = useState<PerPositionLog[]>([])

  // -------------------- load resolvers once --------------------
  useEffect(() => {
    let cancelled = false
    loadResolvers().then((rs) => {
      if (!cancelled) setResolvers(rs)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // -------------------- scan --------------------
  useEffect(() => {
    if (!publicKey || resolvers.length === 0) {
      setPositions([])
      return
    }
    let cancelled = false
    ;(async () => {
      setScanning(true)
      setScanErr(null)
      try {
        const pool = await fetchPool(connection)
        const currentRate =
          pool && pool.poolTokenSupplyAccounting > 0n
            ? Number(pool.poolTotalLamports) /
              Number(pool.poolTokenSupplyAccounting)
            : 1
        if (!cancelled) setNav(currentRate)

        // Run every resolver's scan in parallel; collect results into one
        // flat list. A failing resolver doesn't block the others.
        const results = await Promise.all(
          resolvers.map((r) =>
            r
              .scan(connection, publicKey)
              .catch((e) => {
                console.warn(`[liqmonsta] ${r.meta.amm} scan failed:`, e)
                return [] as RawPosition[]
              }),
          ),
        )
        if (!cancelled) setPositions(results.flat())
      } catch (e) {
        if (!cancelled) setScanErr((e as Error).message)
      } finally {
        if (!cancelled) setScanning(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicKey, connection, resolvers])

  const migratable = useMemo(
    () => positions.filter((p) => p.state === 'migratable'),
    [positions],
  )

  const totalSol = useMemo(
    () => migratable.reduce((s, p) => s + Number(p.solAtom) / LAMPORTS_PER_SOL, 0),
    [migratable],
  )

  const resolverByAmm = useMemo(() => {
    const m = new Map<AmmType, AmmResolver>()
    for (const r of resolvers) m.set(r.meta.amm, r)
    return m
  }, [resolvers])

  // -------------------- smash --------------------
  async function smash() {
    if (!publicKey || !signAllTransactions) return
    setSmashing(true)
    const fresh: PerPositionLog[] = migratable.map((p) => ({
      positionKey: p.positionId,
      steps: [],
    }))
    setLogs(fresh)
    const push = (idx: number, step: SmashStep) => {
      fresh[idx] = { ...fresh[idx], steps: [...fresh[idx].steps, step] }
      setLogs([...fresh])
    }
    const update = (idx: number, lastDelta: Partial<SmashStep>) => {
      const steps = fresh[idx].steps
      const last = steps[steps.length - 1]
      steps[steps.length - 1] = { ...last, ...lastDelta }
      fresh[idx] = { ...fresh[idx], steps: [...steps] }
      setLogs([...fresh])
    }

    try {
      for (let i = 0; i < migratable.length; i++) {
        try {
          await migrateOne(migratable[i], i, push, update)
        } catch (e) {
          update(i, { state: 'error', detail: (e as Error).message })
        }
      }
    } finally {
      setSmashing(false)
    }
  }

  async function migrateOne(
    pos: RawPosition,
    idx: number,
    push: (i: number, s: SmashStep) => void,
    update: (i: number, d: Partial<SmashStep>) => void,
  ) {
    if (!publicKey || !signAllTransactions) throw new Error('wallet not connected')
    const r = resolverByAmm.get(pos.amm)
    if (!r) throw new Error(`no resolver for ${pos.amm}`)

    // 1. Build close txs.
    push(idx, { label: `1/3 close on ${r.meta.label}`, state: 'running' })
    let closeResult
    try {
      closeResult = await r.buildCloseTxs(connection, publicKey, pos)
    } catch (e) {
      update(idx, { state: 'skipped', detail: (e as Error).message })
      return
    }

    // 2. Build mint stacSOL tx.
    //
    // We don't know the exact SOL recovered until close confirms — the
    // pool's reserves may have drifted between scan and execution, and on
    // some pools the close-resulting balance is materially less than the
    // scan-time estimate (observed: SOL/Staccana CPMM close returning ~88%
    // of scan estimate). The previous absolute 0.005 SOL buffer broke when
    // the gap exceeded the buffer, with `Custom 1 — insufficient lamports`
    // on the deposit-sol transfer. We now apply a percentage haircut
    // (10%) so the mint deposit survives reserve drift up to ±10%, plus an
    // absolute 0.005 SOL pad for close-tx fees / jito tip / rent edges.
    const recoveredSolEstimate = Number(closeResult.estSolAtom) / LAMPORTS_PER_SOL
    const depositSolEstimate = Math.max(0, recoveredSolEstimate * 0.9 - 0.005)
    const lamportsToDeposit = BigInt(Math.floor(depositSolEstimate * LAMPORTS_PER_SOL))
    const stacPool = await fetchPool(connection)
    if (!stacPool) throw new Error('stacsol pool state unreadable')

    const mintTx = new Transaction()
    mintTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    mintTx.add(ixCreateAtaIdempotent(publicKey, publicKey, STACSOL_MINT_PK))
    mintTx.add(ixDepositSol(publicKey, lamportsToDeposit, stacPool))
    mintTx.add(heliusTipIx(publicKey, HELIUS_SENDER_TIP_LAMPORTS))
    mintTx.feePayer = publicKey
    const blockhashCtx = await connection.getLatestBlockhash('confirmed')
    mintTx.recentBlockhash = blockhashCtx.blockhash

    // 3. Estimate post-mint stacSOL atoms.
    const navNow =
      stacPool.poolTokenSupplyAccounting > 0n
        ? Number(stacPool.poolTotalLamports) /
          Number(stacPool.poolTokenSupplyAccounting)
        : 1
    const expectedStacAtom = BigInt(
      Math.floor((Number(lamportsToDeposit) * 0.862) / navNow),
    )

    // 4. Build open txs.
    let openResult
    try {
      openResult = await r.buildOpenTxs(connection, publicKey, pos, expectedStacAtom)
    } catch (e) {
      update(idx, { state: 'skipped', detail: (e as Error).message })
      return
    }

    update(idx, { state: 'done', detail: 'planned' })

    // 5. Compose tx list + sign.
    const closeTxs = closeResult.txs
    const openTxs = openResult.txs
    const txsToSign: (Transaction | VersionedTransaction)[] = []
    txsToSign.push(...closeTxs)
    txsToSign.push(mintTx)
    const openOffset = txsToSign.length
    txsToSign.push(...openTxs)

    push(idx, {
      label: `sign ${txsToSign.length} txs (close + mint + open)`,
      state: 'running',
    })
    const signed = (await signAllTransactions(txsToSign as never[])) as (
      | Transaction
      | VersionedTransaction
    )[]
    // Reattach pre-signed sigs on the open leg (e.g. DLMM position keypairs).
    if (openResult.reattach) {
      const sliced = signed.slice(openOffset)
      openResult.reattach(sliced)
    }
    update(idx, { state: 'done', detail: 'signed' })

    // 6. Sequential submit: close[0..n], mint, open[0..m].
    const submit = async (label: string, tx: Transaction | VersionedTransaction) => {
      push(idx, { label, state: 'running' })
      const sig = await sendViaHeliusSender(
        tx as VersionedTransaction | { serialize(): Uint8Array | Buffer },
      )
      update(idx, { state: 'running', sig })
      await pollAllSigsConfirmed(connection, [sig], { timeoutMs: 90_000 })
      update(idx, { state: 'done' })
    }

    let cursor = 0
    for (let k = 0; k < closeTxs.length; k++) {
      await submit(`2/3 submit close ${k + 1}/${closeTxs.length}`, signed[cursor++])
    }
    await submit('mint SOL → stacSOL', signed[cursor++])
    for (let k = 0; k < openTxs.length; k++) {
      await submit(`3/3 open ${k + 1}/${openTxs.length}`, signed[cursor++])
    }
  }

  // -------------------- render --------------------
  return (
    <div className="min-h-screen text-[var(--color-fg)]">
      <Nav />
      <Hero />

      <div className="max-w-[960px] mx-auto px-6 py-10">
        {!publicKey ? (
          <ConnectPrompt />
        ) : (
          <>
            <ScanSummary
              scanning={scanning}
              error={scanErr}
              positions={positions}
              migratable={migratable}
              totalSol={totalSol}
              nav={nav}
            />

            {migratable.length > 0 && (
              <SmashButton
                count={migratable.length}
                totalSol={totalSol}
                busy={smashing}
                onClick={smash}
              />
            )}

            <PositionList positions={positions} />

            <WiringStatus resolvers={resolvers} />

            {logs.length > 0 && <SmashLogs logs={logs} positions={migratable} />}
          </>
        )}
      </div>

      <Footer />
    </div>
  )
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function Nav() {
  return (
    <div className="sticky top-0 z-20 bg-[rgba(8,2,3,0.85)] backdrop-blur border-b border-[rgb(255_34_0_/_0.15)]">
      <div className="max-w-[960px] mx-auto px-6 py-3 flex items-center justify-between">
        <a
          href="/"
          className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline [text-shadow:0_0_8px_rgba(255,34,0,0.5)]"
        >
          ← stacsol.app
        </a>
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
          liqmonsta
        </span>
        <WalletMultiButton />
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="max-w-[960px] mx-auto px-6 pt-16 pb-10 text-center">
      <span className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-[rgb(255_34_0_/_0.35)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-hot)] [box-shadow:0_0_6px_var(--color-hot)]" />
        one-click LP migration · multi-AMM
      </span>
      <h1 className="mt-6 text-[clamp(40px,7vw,84px)] font-black tracking-[-0.04em] leading-[0.95] text-[var(--color-fg)]">
        liq<span className="text-[var(--color-hot)]">monsta</span>
      </h1>
      <p className="mt-4 max-w-[680px] mx-auto text-[14px] leading-relaxed text-[var(--color-dim)]">
        One click. Every SOL-paired LP you own — DLMM, CPMM, CLMM, Whirlpools,
        DAMM — closed, the SOL minted into stacSOL, reopened on a mirrored
        stacSOL pair at the equivalent price. Same range, same exposure. Every
        swap on the new LP feeds the 13.8% transfer-fee burn.
      </p>
    </section>
  )
}

function ConnectPrompt() {
  return (
    <div className="rounded-lg border border-[rgb(255_34_0_/_0.22)] bg-[var(--color-bg2)] p-8 text-center">
      <p className="m-0 text-[14px] text-[var(--color-dim)]">
        Connect your wallet to scan your SOL-paired LP positions.
      </p>
    </div>
  )
}

function ScanSummary({
  scanning,
  error,
  positions,
  migratable,
  totalSol,
  nav,
}: {
  scanning: boolean
  error: string | null
  positions: RawPosition[]
  migratable: RawPosition[]
  totalSol: number
  nav: number | null
}) {
  if (scanning) {
    return (
      <div className="rounded-lg border border-[rgb(255_34_0_/_0.22)] bg-[var(--color-bg2)] p-6 text-[12px] text-[var(--color-dim)] uppercase tracking-[2px]">
        scanning your LP positions across all AMMs…
      </div>
    )
  }
  if (error) {
    return (
      <div className="rounded-lg border border-[rgb(255_204_0_/_0.4)] bg-[rgb(255_204_0_/_0.06)] p-6">
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-warn)]">
          scan error
        </div>
        <p className="mt-2 m-0 text-[12px] text-[var(--color-fg)] break-words">
          {error}
        </p>
      </div>
    )
  }
  if (positions.length === 0) {
    return (
      <div className="rounded-lg border border-[rgb(255_34_0_/_0.22)] bg-[var(--color-bg2)] p-6">
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
          no SOL-paired LP positions found
        </div>
        <p className="mt-2 m-0 text-[12px] text-[var(--color-fg)]">
          We scan every position-style LP you own — Meteora DLMM, Raydium
          CPMM, Raydium CLMM, Orca Whirlpools, Meteora DAMM. Connect a wallet
          with SOL-paired LPs to see them here.
        </p>
      </div>
    )
  }
  const skipped = positions.length - migratable.length
  return (
    <div className="grid md:grid-cols-3 gap-3">
      <Stat
        big={`${positions.length}`}
        label="SOL-paired positions"
        sub="across all AMMs"
        tone="red"
      />
      <Stat
        big={`${migratable.length}`}
        label="migratable now"
        sub={skipped > 0 ? `(${skipped} need target pool init)` : 'curated targets exist'}
        tone="green"
      />
      <Stat
        big={`${totalSol.toFixed(3)}`}
        label="total SOL to convert"
        sub={nav != null ? `NAV ${nav.toFixed(4)} SOL/stacSOL` : 'NAV loading…'}
        tone="green"
      />
    </div>
  )
}

function Stat({
  big,
  label,
  sub,
  tone,
}: {
  big: string
  label: string
  sub: string
  tone: 'red' | 'green'
}) {
  const c = tone === 'red' ? 'var(--color-hot)' : 'var(--color-green)'
  return (
    <div className="rounded-lg border border-[rgb(255_34_0_/_0.18)] bg-[var(--color-bg2)] p-5">
      <div
        className="tabular-mono text-4xl font-black leading-none"
        style={{ color: c, textShadow: `0 0 16px ${c}55` }}
      >
        {big}
      </div>
      <div className="mt-2 text-[10px] font-black uppercase tracking-[3px]" style={{ color: c }}>
        {label}
      </div>
      <div className="mt-1 text-[11px] text-[var(--color-dim)]">{sub}</div>
    </div>
  )
}

function SmashButton({
  count,
  totalSol,
  busy,
  onClick,
}: {
  count: number
  totalSol: number
  busy: boolean
  onClick: () => void
}) {
  return (
    <div className="mt-6 rounded-lg border border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.06)] p-6 text-center">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="w-full px-6 py-5 bg-[var(--color-hot)] text-black text-2xl font-black uppercase tracking-[6px] rounded enabled:hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ textShadow: '0 0 8px rgba(0,0,0,0.3)' }}
      >
        {busy ? 'smashing…' : `SMASH ${count} → stacSOL`}
      </button>
      <p className="mt-3 m-0 text-[11px] text-[var(--color-dim)]">
        {busy
          ? 'one sign prompt per position — close → mint → reopen, sequential per position'
          : `closes each position on its native AMM, mints ${totalSol.toFixed(3)} SOL → stacSOL, reopens at mirrored range`}
      </p>
    </div>
  )
}

function ammBadgeColor(amm: AmmType) {
  switch (amm) {
    case 'meteora-dlmm':
      return 'var(--color-green)'
    case 'raydium-cpmm':
      return 'var(--color-ember)'
    case 'raydium-clmm':
      return 'var(--color-warn)'
    case 'orca-whirlpool':
      return 'var(--color-hot)'
    case 'meteora-damm':
      return 'var(--color-dim)'
    case 'pump-amm':
      return 'var(--color-fg)'
    default:
      return 'var(--color-fg)'
  }
}

function stateColor(state: RawPosition['state']) {
  return state === 'migratable'
    ? 'var(--color-green)'
    : state === 'already-stacsol'
    ? 'var(--color-ember)'
    : 'var(--color-warn)'
}

function stateLabel(state: RawPosition['state']) {
  return state === 'migratable'
    ? 'migratable'
    : state === 'already-stacsol'
    ? 'already stacSOL'
    : 'target pool — wiring soon'
}

function PositionList({ positions }: { positions: RawPosition[] }) {
  if (positions.length === 0) return null
  return (
    <div className="mt-6 space-y-2">
      <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
        positions
      </div>
      {positions.map((p) => {
        const c = stateColor(p.state)
        const solUi = Number(p.solAtom) / LAMPORTS_PER_SOL
        const stacUi = Number(p.stacAtom) / 1e9
        const otherUi = Number(p.otherAtom) / Math.pow(10, p.otherDecimals)
        const ammC = ammBadgeColor(p.amm)
        return (
          <div
            key={`${p.amm}-${p.positionId}`}
            className="rounded-lg border bg-[var(--color-bg2)] p-4"
            style={{ borderColor: `${c}55` }}
          >
            <div className="flex items-baseline justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className="text-[10px] font-black uppercase tracking-[2px] px-1.5 py-0.5 rounded border"
                    style={{ color: ammC, borderColor: `${ammC}55` }}
                  >
                    {p.amm.replace('-', ' ')}
                  </span>
                  <span
                    className="text-[10px] font-black uppercase tracking-[2px] px-1.5 py-0.5 rounded border"
                    style={{ color: c, borderColor: `${c}55` }}
                  >
                    {p.poolLabel}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-[2px]"
                    style={{ color: c }}
                  >
                    {stateLabel(p.state)}
                  </span>
                </div>
                <div className="mt-1 font-mono text-[11px] text-[var(--color-dim)] truncate">
                  {p.positionId.slice(0, 8)}…{p.positionId.slice(-6)}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="tabular-mono text-[13px] font-black text-[var(--color-fg)]">
                  {p.solAtom > 0n && `${solUi.toFixed(4)} SOL`}
                  {p.stacAtom > 0n && (
                    <>
                      {p.solAtom > 0n && ' + '}
                      {stacUi.toFixed(4)} stacSOL
                    </>
                  )}
                  {p.otherAtom > 0n && (
                    <>
                      {(p.solAtom > 0n || p.stacAtom > 0n) && ' + '}
                      {otherUi.toFixed(2)} {p.otherSymbol}
                    </>
                  )}
                  {p.solAtom === 0n && p.stacAtom === 0n && p.otherAtom === 0n && (
                    <span className="text-[var(--color-dim)]">
                      ?
                    </span>
                  )}
                </div>
                {p.range && (
                  <div className="text-[10px] text-[var(--color-dim)] uppercase tracking-wider">
                    src range {p.range.lower} → {p.range.upper}
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function WiringStatus({ resolvers }: { resolvers: AmmResolver[] }) {
  if (resolvers.length === 0) return null
  return (
    <div className="mt-8">
      <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)] mb-2">
        AMM coverage
      </div>
      <div className="rounded-lg border border-[rgb(255_34_0_/_0.18)] bg-[var(--color-bg2)] divide-y divide-[rgb(255_34_0_/_0.08)]">
        {resolvers.map((r) => {
          const allLive =
            r.meta.scan === 'live' && r.meta.close === 'live' && r.meta.open === 'live'
          const partial =
            r.meta.scan === 'live' &&
            (r.meta.close === 'live' || r.meta.open === 'live') &&
            !allLive
          const status: 'live' | 'partial' | 'wiring' = allLive
            ? 'live'
            : partial
            ? 'partial'
            : 'wiring'
          const c =
            status === 'live'
              ? 'var(--color-green)'
              : status === 'partial'
              ? 'var(--color-ember)'
              : 'var(--color-dim)'
          return (
            <div
              key={r.meta.amm}
              className="grid grid-cols-[auto_1fr_auto] gap-3 items-center px-4 py-2.5"
            >
              <span
                className="text-[10px] font-black uppercase tracking-[2px] w-20 text-center px-1.5 py-0.5 rounded border"
                style={{ color: c, borderColor: `${c}55` }}
              >
                {status}
              </span>
              <span className="text-[13px] font-black text-[var(--color-fg)]">
                {r.meta.label}
              </span>
              <span className="text-[10px] text-[var(--color-dim)] tabular-mono">
                scan {r.meta.scan} · close {r.meta.close} · open {r.meta.open}
              </span>
            </div>
          )
        })}
      </div>
      <p className="mt-2 text-[10px] text-[var(--color-dim)] uppercase tracking-[2px]">
        smash fires every AMM tagged <span className="text-[var(--color-green)]">live</span> on
        the same position pass. <span className="text-[var(--color-ember)]">partial</span>
        and <span className="text-[var(--color-dim)]">wiring</span> light up as their
        resolvers finish — no copy change needed.
      </p>
    </div>
  )
}

function SmashLogs({
  logs,
  positions,
}: {
  logs: PerPositionLog[]
  positions: RawPosition[]
}) {
  const byKey = new Map(positions.map((p) => [p.positionId, p]))
  return (
    <div className="mt-8 space-y-3">
      <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
        progress
      </div>
      {logs.map((log) => {
        const pos = byKey.get(log.positionKey)
        return (
          <div
            key={log.positionKey}
            className="rounded-lg border border-[rgb(255_34_0_/_0.22)] bg-[var(--color-bg2)] p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[12px] font-black text-[var(--color-fg)]">
                {pos?.poolLabel ?? '?'}
              </span>
              <span className="font-mono text-[10px] text-[var(--color-dim)]">
                {log.positionKey.slice(0, 8)}…
              </span>
            </div>
            <div className="space-y-1.5">
              {log.steps.map((s, i) => (
                <StepRow key={i} step={s} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StepRow({ step }: { step: SmashStep }) {
  const icon =
    step.state === 'done'
      ? '✓'
      : step.state === 'error'
      ? '✗'
      : step.state === 'skipped'
      ? '⊘'
      : step.state === 'running'
      ? '◔'
      : '·'
  const color =
    step.state === 'done'
      ? 'var(--color-green)'
      : step.state === 'error'
      ? 'var(--color-warn)'
      : step.state === 'skipped'
      ? 'var(--color-dim)'
      : 'var(--color-ember)'
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="font-black tabular-mono" style={{ color }}>
        {icon}
      </span>
      <span className="text-[var(--color-fg)] flex-1 min-w-0">{step.label}</span>
      {step.detail && (
        <span className="text-[10px] text-[var(--color-dim)] truncate max-w-[40%]">
          {step.detail}
        </span>
      )}
      {step.sig && (
        <a
          href={solscanTx(step.sig)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] uppercase tracking-[2px] text-[var(--color-hot)] underline-offset-2 hover:underline"
        >
          ↗ tx
        </a>
      )}
    </div>
  )
}

function Footer() {
  return (
    <footer className="max-w-[960px] mx-auto px-6 py-8 border-t border-[rgb(255_34_0_/_0.12)] text-center text-[10px] text-[var(--color-dim)] uppercase tracking-[2px]">
      liqmonsta · smashes every SOL-paired LP into stacSOL ·{' '}
      <span className="text-[var(--color-ember)]">
        resolver-pluggable per AMM
      </span>
    </footer>
  )
}
