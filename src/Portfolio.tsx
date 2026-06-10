// /portfolio — single page that aggregates ALL of a user's stacSOL-related
// LP positions across both Meteora DLMM (CLMM-style) and Raydium CPMM.
//
// CLMM section: per-position rows with "claim fees" and "withdraw + close"
// actions, plus a header "claim all CLMM fees" that bundles up to 4 fee
// claims into a single Jito bundle. All CLMM tx-building flows through
// HawkFi's SDK so positions remain manageable in their UI.
//
// CPMM section: lists Raydium LP token holdings for the 5 stacSOL pools
// with proportional X/Y claim. "Remove" links to /liquidity (where the
// existing zap-out flow handles the burn + auto-swap to SOL).

import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import EditorialNav from './components/EditorialNav'
import WalletPill from './components/WalletPill'
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  HELIUS_SENDER_TIP_LAMPORTS,
  pollAllSigsConfirmed,
  sendViaHeliusSender,
  solscanTx,
} from './lib/zap'
import {
  METEORA_POOLS,
  STACSOL_DECIMALS,
  STACSOL_MINT,
  type MeteoraPool,
} from './lib/meteora-pools'

interface DlmmPosition {
  publicKey: string
  poolAddress: string
  poolName: string
  poolMint: string
  poolDecimals: number
  isStacX: boolean
  lowerBinId: number
  upperBinId: number
  totalXAtom: bigint
  totalYAtom: bigint
  feeXAtom: bigint
  feeYAtom: bigint
  /** 'hawkfi' = position.owner == userPda (auto-managed; HawkFi can rebalance/compound).
   *  'direct'  = position.owner == user wallet (no automation).
   *  Set during the position fetch in the dual-query path. */
  ownership: 'hawkfi' | 'direct'
}

interface CpmmPool {
  id: string
  mintA: { address: string; symbol: string; decimals: number }
  mintB: { address: string; symbol: string; decimals: number }
  mintAmountA: number
  mintAmountB: number
  lpAmount: number
  lpMint: { address: string; decimals: number; programId: string }
  tvl: number
  day?: { apr?: number }
}

interface CpmmPosition {
  poolId: string
  pairLabel: string
  myLpAtom: bigint
  myLpUi: number
  fractionOfPool: number
  stacsolUi: number
  otherUi: number
  otherSymbol: string
  tvl: number
  apr: number | null
}

export default function Portfolio() {
  useEffect(() => {
    const prev = document.title
    document.title = 'stacSOL portfolio'
    return () => {
      document.title = prev
    }
  }, [])

  // Editorial palette opt-in. The page's internal Tailwind utilities reference
  // --color-bg, --color-hot, etc. — those vars get remapped onto the
  // ivory/jade tokens by the body[data-design="editorial"] block in
  // index.css, so the existing markup recolors automatically.
  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  const { connection } = useConnection()
  const { publicKey, signAllTransactions } = useWallet()
  const walletModal = useWalletModal()

  const [dlmmLoading, setDlmmLoading] = useState(false)
  const [dlmmPositions, setDlmmPositions] = useState<DlmmPosition[]>([])
  const [dlmmErr, setDlmmErr] = useState<string | null>(null)

  const [cpmmLoading, setCpmmLoading] = useState(false)
  const [cpmmPositions, setCpmmPositions] = useState<CpmmPosition[]>([])
  const [cpmmErr, setCpmmErr] = useState<string | null>(null)

  const [refresh, setRefresh] = useState(0)
  const tickRefresh = () => setRefresh((n) => n + 1)

  // ------------------- load CLMM (DLMM) positions -------------------
  useEffect(() => {
    if (!publicKey) {
      setDlmmPositions([])
      return
    }
    let cancelled = false
    ;(async () => {
      setDlmmLoading(true)
      setDlmmErr(null)
      try {
        const DLMMmod = await import('@meteora-ag/dlmm')
        const DLMM = DLMMmod.default
        // Fetch positions owned by BOTH the user wallet (direct positions)
        // AND the user's HawkFi userPda (auto-managed positions). Latter
        // is empty if user never used HawkFi, which is fine — the SDK call
        // returns 0 positions and we move on.
        const { deriveUserPda } = await import('./lib/hawkfi-flows')
        const [userPda] = deriveUserPda(publicKey)
        const all: DlmmPosition[] = []
        await Promise.all(
          METEORA_POOLS.map(async (pool: MeteoraPool) => {
            try {
              const dlmm = await DLMM.create(
                connection,
                new PublicKey(pool.poolAddress),
              )
              // Two parallel queries: direct + HawkFi-managed. We dedupe
              // by position pubkey just in case of overlap.
              const [direct, hawk] = await Promise.all([
                dlmm.getPositionsByUserAndLbPair(publicKey).catch(() => null),
                dlmm.getPositionsByUserAndLbPair(userPda).catch(() => null),
              ])
              const seen = new Set<string>()
              const isStacX = pool.tokenX === STACSOL_MINT
              const ingest = (
                positions: typeof direct,
                ownership: 'hawkfi' | 'direct',
              ) => {
                if (!positions) return
                for (const p of positions.userPositions) {
                  const key = p.publicKey.toBase58()
                  if (seen.has(key)) continue
                  seen.add(key)
                  const pd = p.positionData
                  all.push({
                    publicKey: key,
                    poolAddress: pool.poolAddress,
                    poolName: pool.name,
                    poolMint: pool.mint,
                    poolDecimals: pool.decimals,
                    isStacX,
                    lowerBinId: pd.lowerBinId,
                    upperBinId: pd.upperBinId,
                    totalXAtom: BigInt(pd.totalXAmount.toString()),
                    totalYAtom: BigInt(pd.totalYAmount.toString()),
                    feeXAtom: BigInt(pd.feeX.toString()),
                    feeYAtom: BigInt(pd.feeY.toString()),
                    ownership,
                  })
                }
              }
              // Ingest HawkFi-owned first so they win the dedupe — if
              // somehow a position appears in both queries (shouldn't, but
              // belt-and-suspenders), the HawkFi label wins.
              ingest(hawk, 'hawkfi')
              ingest(direct, 'direct')
            } catch {
              // swallow per-pool errors so one bad pool doesn't kill the page
            }
          }),
        )
        if (!cancelled) setDlmmPositions(all)
      } catch (e) {
        if (!cancelled) setDlmmErr((e as Error).message)
      } finally {
        if (!cancelled) setDlmmLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicKey, connection, refresh])

  // ------------------- load CPMM positions -------------------
  useEffect(() => {
    if (!publicKey) {
      setCpmmPositions([])
      return
    }
    let cancelled = false
    ;(async () => {
      setCpmmLoading(true)
      setCpmmErr(null)
      try {
        const r = await fetch('/api/liquidity-pools')
        if (!r.ok) throw new Error(`pools ${r.status}`)
        const j = (await r.json()) as { pools: CpmmPool[] }
        const pools = j.pools ?? []
        const items: CpmmPosition[] = []
        for (const p of pools) {
          if (
            p.mintA.address !== STACSOL_MINT &&
            p.mintB.address !== STACSOL_MINT
          ) {
            continue
          }
          let myLpAtom = 0n
          try {
            const ata = getAssociatedTokenAddressSync(
              new PublicKey(p.lpMint.address),
              publicKey,
              false,
              new PublicKey(p.lpMint.programId),
              ASSOCIATED_TOKEN_PROGRAM_ID,
            )
            const acc = await connection.getAccountInfo(ata)
            if (acc) myLpAtom = acc.data.readBigUInt64LE(64)
          } catch {
            myLpAtom = 0n
          }
          if (myLpAtom === 0n) continue
          const myLpUi = Number(myLpAtom) / Math.pow(10, p.lpMint.decimals)
          const fraction = p.lpAmount > 0 ? myLpUi / p.lpAmount : 0
          if (fraction === 0) continue
          const isStacA = p.mintA.address === STACSOL_MINT
          const stacUi = (isStacA ? p.mintAmountA : p.mintAmountB) * fraction
          const otherUi = (isStacA ? p.mintAmountB : p.mintAmountA) * fraction
          const otherSymbol = isStacA ? p.mintB.symbol : p.mintA.symbol
          items.push({
            poolId: p.id,
            pairLabel: `${p.mintA.symbol}/${p.mintB.symbol}`,
            myLpAtom,
            myLpUi,
            fractionOfPool: fraction,
            stacsolUi: stacUi,
            otherUi,
            otherSymbol,
            tvl: p.tvl,
            apr: p.day?.apr ?? null,
          })
        }
        if (!cancelled) setCpmmPositions(items)
      } catch (e) {
        if (!cancelled) setCpmmErr((e as Error).message)
      } finally {
        if (!cancelled) setCpmmLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [publicKey, connection, refresh])

  // ------------------- aggregate exposure -------------------
  const aggregate = useMemo(() => {
    let stacAtom = 0n
    let claimableStacAtom = 0n
    for (const p of dlmmPositions) {
      const stac = p.isStacX ? p.totalXAtom : p.totalYAtom
      const fee = p.isStacX ? p.feeXAtom : p.feeYAtom
      stacAtom += stac
      claimableStacAtom += fee
    }
    let cpmmStacUi = 0
    for (const c of cpmmPositions) cpmmStacUi += c.stacsolUi
    return {
      dlmmStacUi: Number(stacAtom) / Math.pow(10, STACSOL_DECIMALS),
      claimableStacUi:
        Number(claimableStacAtom) / Math.pow(10, STACSOL_DECIMALS),
      cpmmStacUi,
      totalStacUi:
        Number(stacAtom) / Math.pow(10, STACSOL_DECIMALS) + cpmmStacUi,
    }
  }, [dlmmPositions, cpmmPositions])

  return (
    <div className="min-h-screen text-[var(--color-fg)]">
      <EditorialNav pathname="/portfolio" ctaSlot={<WalletPill />} />
      <Hero aggregate={aggregate} dlmmCount={dlmmPositions.length} cpmmCount={cpmmPositions.length} />

      <section className="max-w-[1080px] mx-auto px-6 pb-10">
        {!publicKey && (
          <div
            className="rounded-2xl p-10 text-center"
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--line)',
              marginTop: 24,
            }}
          >
            <div
              className="serif"
              style={{
                fontSize: 'clamp(28px, 4vw, 40px)',
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                marginBottom: 12,
              }}
            >
              Connect to see your positions.
            </div>
            <p
              style={{
                margin: '0 auto 24px',
                maxWidth: '52ch',
                color: 'var(--ink-soft)',
                fontSize: 15,
                lineHeight: 1.6,
              }}
            >
              Your DLMM (single-sided) and CPMM (balanced) liquidity
              positions, claimable fees, and breakdowns load directly from
              chain after connect — nothing stored server-side.
            </p>
            <button
              className="nav-cta"
              onClick={() => walletModal.setVisible(true)}
              style={{
                background: 'var(--accent-deep)',
                color: 'var(--bg)',
                padding: '12px 22px',
                fontSize: 13,
              }}
            >
              <span className="pulse" />
              Connect wallet
              <span style={{ marginLeft: 2 }} aria-hidden>
                →
              </span>
            </button>
          </div>
        )}

        {publicKey && (
          <>
            <ClmmSection
              positions={dlmmPositions}
              loading={dlmmLoading}
              error={dlmmErr}
              onRefresh={tickRefresh}
              walletKey={publicKey}
              connection={connection}
              signAllTransactions={signAllTransactions}
            />

            <CpmmSection
              positions={cpmmPositions}
              loading={cpmmLoading}
              error={cpmmErr}
            />
          </>
        )}
      </section>

      <Footer />
    </div>
  )
}

/* ============================== chrome ============================== */
// Legacy Nav() replaced by the shared EditorialNav in components/.

function Hero({
  aggregate,
  dlmmCount,
  cpmmCount,
}: {
  aggregate: { totalStacUi: number; dlmmStacUi: number; cpmmStacUi: number; claimableStacUi: number }
  dlmmCount: number
  cpmmCount: number
}) {
  return (
    <section className="max-w-[1080px] mx-auto px-6 pt-12 pb-8">
      <h1 className="m-0 text-[clamp(36px,5vw,64px)] font-black tracking-[-0.04em] leading-[0.95] text-[var(--color-fg)]">
        Portfolio
      </h1>
      <p className="mt-3 max-w-[680px] text-[13px] text-[var(--color-dim)]">
        All your stacSOL liquidity in one place — Meteora DLMM (single-sided) +
        Raydium CPMM (balanced). Claim fees and withdraw without leaving the page.
      </p>

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="total stacSOL exposure" value={aggregate.totalStacUi.toFixed(4)} unit="stacSOL" tone="green" />
        <Stat label="claimable fees (CLMM)" value={aggregate.claimableStacUi.toFixed(6)} unit="stacSOL" tone="hot" />
        <Stat label="DLMM positions" value={String(dlmmCount)} unit="" tone="dim" />
        <Stat label="CPMM positions" value={String(cpmmCount)} unit="" tone="dim" />
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  unit,
  tone,
}: {
  label: string
  value: string
  unit: string
  tone: 'green' | 'hot' | 'dim'
}) {
  const c =
    tone === 'green'
      ? 'var(--color-green)'
      : tone === 'hot'
      ? 'var(--color-hot)'
      : 'var(--color-fg)'
  return (
    <div className="bg-[var(--color-bg2)] rounded p-3 border border-[rgb(255_34_0_/_0.18)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
        {label}
      </div>
      <div className="mt-0.5 leading-tight tabular-mono text-base font-black" style={{ color: c }}>
        {value}
        {unit && (
          <span className="text-[10px] text-[var(--color-dim)] ml-1 uppercase tracking-wider">
            {unit}
          </span>
        )}
      </div>
    </div>
  )
}

function Footer() {
  return (
    <footer className="max-w-[1080px] mx-auto px-6 py-10 border-t border-[rgb(255_34_0_/_0.12)] text-center text-[10px] text-[var(--color-dim)] uppercase tracking-[2px]">
      DLMM management via HawkFi · live position data refreshes on demand
    </footer>
  )
}

/* ============================ CLMM section ============================ */

interface BundleStep {
  label: string
  state: 'pending' | 'running' | 'done' | 'error'
  detail?: string
}

function ClmmSection({
  positions,
  loading,
  error,
  onRefresh,
  walletKey,
  connection,
  signAllTransactions,
}: {
  positions: DlmmPosition[]
  loading: boolean
  error: string | null
  onRefresh: () => void
  walletKey: PublicKey
  connection: import('@solana/web3.js').Connection
  signAllTransactions:
    | ((txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>)
    | undefined
}) {
  const [bulkRunning, setBulkRunning] = useState(false)
  const [bulkSteps, setBulkSteps] = useState<BundleStep[]>([])
  const [bulkResult, setBulkResult] = useState<string[] | null>(null)
  const [bulkErr, setBulkErr] = useState<string | null>(null)
  const [bulkLimited, setBulkLimited] = useState(false)

  const positionsWithFees = positions.filter(
    (p) => p.feeXAtom > 0n || p.feeYAtom > 0n,
  )

  const claimAll = async () => {
    if (!signAllTransactions) {
      setBulkErr('connect wallet first')
      return
    }
    if (positionsWithFees.length === 0) {
      setBulkErr('no claimable fees')
      return
    }
    setBulkErr(null)
    setBulkLimited(false)
    setBulkResult(null)
    setBulkRunning(true)
    const steps: BundleStep[] = []
    const update = (i: number, p: Partial<BundleStep>) => {
      steps[i] = { ...steps[i], ...p }
      setBulkSteps([...steps])
    }
    try {
      // No bundle cap to fight; cap to 8 to keep one wallet popup
      // manageable. Remaining positions are picked up next click.
      const MAX_CLAIMS = 8
      const targets = positionsWithFees.slice(0, MAX_CLAIMS)
      const truncated = positionsWithFees.length > MAX_CLAIMS
      steps.push({
        label: `build ${targets.length} claim tx${targets.length === 1 ? '' : 's'}`,
        state: 'running',
      })
      setBulkSteps([...steps])
      // Per-position dispatch: HawkFi-owned → HawkFi claim path (claim_fee2
      // → withdraw_token_from_user_pda forwards to user wallet),
      // direct-owned → native Meteora SDK claim_fee.
      const { buildDlmmClaimFeesTx } = await import('./lib/dlmm')
      const { buildHawkClaimTx, classifyPositionOwnership } = await import('./lib/hawkfi-flows')
      const dlmmMod = await import('@meteora-ag/dlmm')
      // Cache pool token info per pool we touch — claim helpers need it.
      const poolInfoCache = new Map<
        string,
        {
          tokenXMint: PublicKey
          tokenYMint: PublicKey
          tokenXProgram: PublicKey
          tokenYProgram: PublicKey
        }
      >()
      const getPoolInfo = async (poolAddr: string) => {
        const cached = poolInfoCache.get(poolAddr)
        if (cached) return cached
        const dlmm = await dlmmMod.default.create(connection, new PublicKey(poolAddr))
        const info = {
          tokenXMint: dlmm.tokenX.publicKey as PublicKey,
          tokenYMint: dlmm.tokenY.publicKey as PublicKey,
          tokenXProgram: dlmm.tokenX.owner as PublicKey,
          tokenYProgram: dlmm.tokenY.owner as PublicKey,
        }
        poolInfoCache.set(poolAddr, info)
        return info
      }
      let hawkCount = 0
      let directCount = 0
      const txs = await Promise.all(
        targets.map(async (p) => {
          const cls = await classifyPositionOwnership(
            connection,
            new PublicKey(p.publicKey),
            walletKey,
          )
          if (cls.kind === 'hawkfi') {
            hawkCount++
            const info = await getPoolInfo(p.poolAddress)
            return buildHawkClaimTx(connection, walletKey, {
              pool: new PublicKey(p.poolAddress),
              position: new PublicKey(p.publicKey),
              tokenXMint: info.tokenXMint,
              tokenYMint: info.tokenYMint,
              tokenXProgram: info.tokenXProgram,
              tokenYProgram: info.tokenYProgram,
              lowerBinId: p.lowerBinId,
              upperBinId: p.upperBinId,
            })
          }
          directCount++
          return buildDlmmClaimFeesTx(connection, walletKey, {
            pool: new PublicKey(p.poolAddress),
            position: new PublicKey(p.publicKey),
          })
        }),
      )
      const totalTipSol = (txs.length * HELIUS_SENDER_TIP_LAMPORTS) / LAMPORTS_PER_SOL
      update(steps.length - 1, {
        state: 'done',
        detail: `${txs.length} position${txs.length === 1 ? '' : 's'} (${hawkCount} hawkfi + ${directCount} direct)${truncated ? ` · ${positionsWithFees.length - txs.length} more after this lands` : ''} · ${totalTipSol.toFixed(4)} SOL tips`,
      })

      steps.push({ label: 'sign all transactions', state: 'running' })
      setBulkSteps([...steps])
      const signed = (await signAllTransactions(txs)) as VersionedTransaction[]
      update(steps.length - 1, { state: 'done', detail: `${signed.length} txs signed` })

      steps.push({
        label: `send ${signed.length} claim${signed.length === 1 ? '' : 's'} via helius sender`,
        state: 'running',
      })
      setBulkSteps([...steps])
      const sigs = await Promise.all(signed.map((tx) => sendViaHeliusSender(tx)))
      update(steps.length - 1, {
        state: 'done',
        detail: sigs.map((s) => s.slice(0, 8) + '…').join(' · '),
      })

      steps.push({ label: 'waiting for inclusion', state: 'running' })
      setBulkSteps([...steps])
      const confirmed = await pollAllSigsConfirmed(connection, sigs, {
        commitment: 'confirmed',
        timeoutMs: 90_000,
      })
      update(steps.length - 1, {
        state: 'done',
        detail: `${confirmed.length}/${sigs.length} confirmed`,
      })
      setBulkResult(sigs)
      onRefresh()
    } catch (e) {
      const msg = (e as Error).message
      setBulkLimited(false)
      setBulkErr(msg)
      steps.forEach((s, i) => {
        if (s.state === 'running') steps[i] = { ...s, state: 'error', detail: msg }
      })
      setBulkSteps([...steps])
    } finally {
      setBulkRunning(false)
    }
  }

  return (
    <section className="mt-8">
      <header className="flex items-center justify-between mb-3">
        <h2 className="m-0 text-lg font-black uppercase tracking-[3px] text-[var(--color-hot)]">
          Meteora DLMM (single-sided)
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="text-[10px] font-black uppercase tracking-[2px] px-3 py-2 rounded border border-[rgb(255_34_0_/_0.35)] text-[var(--color-dim)] hover:text-[var(--color-fg)]"
          >
            refresh
          </button>
          <button
            type="button"
            onClick={claimAll}
            disabled={bulkRunning || positionsWithFees.length === 0}
            className="text-[10px] font-black uppercase tracking-[2px] px-3 py-2 rounded border border-[var(--color-green)] bg-[rgb(34_238_136_/_0.06)] text-[var(--color-green)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {bulkRunning
              ? 'working…'
              : bulkLimited
              ? 'tap again — jito throttled'
              : `claim all fees (${positionsWithFees.length})`}
          </button>
        </div>
      </header>

      {error && (
        <p className="text-[var(--color-warn)] text-[12px]">load error: {error}</p>
      )}
      {loading && positions.length === 0 && (
        <p className="text-[var(--color-dim)] text-[12px]">loading…</p>
      )}
      {!loading && positions.length === 0 && !error && (
        <p className="text-[var(--color-dim)] text-[12px]">
          no DLMM positions. <a href="/singlesided" className="text-[var(--color-hot)]">place one →</a>
        </p>
      )}

      <div className="space-y-2">
        {positions.map((p) => (
          <ClmmRow
            key={p.publicKey}
            position={p}
            walletKey={walletKey}
            connection={connection}
            signAllTransactions={signAllTransactions}
            onRefresh={onRefresh}
          />
        ))}
      </div>

      {bulkSteps.length > 0 && (
        <div className="mt-3">
          <StepList steps={bulkSteps} />
        </div>
      )}
      {bulkResult && (
        <div className="mt-3">
          <BundleResult txIds={bulkResult} />
        </div>
      )}
      {bulkErr && (
        <div
          className={`mt-2 text-[11px] font-mono break-all ${bulkLimited ? 'text-[var(--color-ember)]' : 'text-[var(--color-warn)]'}`}
        >
          {bulkLimited ? '⏳' : 'error:'} {bulkErr}
        </div>
      )}
    </section>
  )
}

function ClmmRow({
  position,
  walletKey,
  connection,
  signAllTransactions,
  onRefresh,
}: {
  position: DlmmPosition
  walletKey: PublicKey
  connection: import('@solana/web3.js').Connection
  signAllTransactions:
    | ((txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>)
    | undefined
  onRefresh: () => void
}) {
  const [running, setRunning] = useState<'claim' | 'close' | null>(null)
  const [steps, setSteps] = useState<BundleStep[]>([])
  const [result, setResult] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [limited, setLimited] = useState(false)

  const stacAtom = position.isStacX ? position.totalXAtom : position.totalYAtom
  const otherAtom = position.isStacX ? position.totalYAtom : position.totalXAtom
  const stacUi = Number(stacAtom) / Math.pow(10, STACSOL_DECIMALS)
  const otherUi = Number(otherAtom) / Math.pow(10, position.poolDecimals)
  const stacFeeAtom = position.isStacX ? position.feeXAtom : position.feeYAtom
  const otherFeeAtom = position.isStacX ? position.feeYAtom : position.feeXAtom
  const stacFeeUi = Number(stacFeeAtom) / Math.pow(10, STACSOL_DECIMALS)
  const otherFeeUi = Number(otherFeeAtom) / Math.pow(10, position.poolDecimals)
  const hasFees = stacFeeAtom > 0n || otherFeeAtom > 0n

  const runAction = async (action: 'claim' | 'close') => {
    if (!signAllTransactions) {
      setErr('connect wallet first')
      return
    }
    setErr(null)
    setLimited(false)
    setResult(null)
    setRunning(action)
    const labels: BundleStep[] = []
    const upd = (i: number, p: Partial<BundleStep>) => {
      labels[i] = { ...labels[i], ...p }
      setSteps([...labels])
    }
    try {
      // Dispatch by ownership: HawkFi-owned positions go through HawkFi's
      // CPI (auto-managed); direct-owned positions go through native
      // Meteora SDK. Either way the surface is one v0 tx with a Helius
      // tip, signed in one popup.
      const { buildDlmmWithdrawCloseTx, buildDlmmClaimFeesTx } = await import('./lib/dlmm')
      const { buildHawkClaimTx, buildHawkWithdrawCloseTx, classifyPositionOwnership } =
        await import('./lib/hawkfi-flows')
      const cls = await classifyPositionOwnership(
        connection,
        new PublicKey(position.publicKey),
        walletKey,
      )
      const isHawk = cls.kind === 'hawkfi'
      const ownershipTag = isHawk ? 'hawkfi-managed' : 'direct-owned'

      const txs: VersionedTransaction[] = []

      // For HawkFi paths we need pool token info (mints + token programs).
      // Fetch via DLMM SDK lazily — only if we're routing through HawkFi.
      let tokenInfo:
        | {
            tokenXMint: PublicKey
            tokenYMint: PublicKey
            tokenXProgram: PublicKey
            tokenYProgram: PublicKey
          }
        | null = null
      if (isHawk) {
        const dlmmMod = await import('@meteora-ag/dlmm')
        const dlmm = await dlmmMod.default.create(connection, new PublicKey(position.poolAddress))
        tokenInfo = {
          tokenXMint: dlmm.tokenX.publicKey as PublicKey,
          tokenYMint: dlmm.tokenY.publicKey as PublicKey,
          tokenXProgram: dlmm.tokenX.owner as PublicKey,
          tokenYProgram: dlmm.tokenY.owner as PublicKey,
        }
      }

      if (action === 'claim') {
        labels.push({
          label: `build claim tx (${ownershipTag})`,
          state: 'running',
        })
        setSteps([...labels])
        const tx = isHawk
          ? await buildHawkClaimTx(connection, walletKey, {
              pool: new PublicKey(position.poolAddress),
              position: new PublicKey(position.publicKey),
              tokenXMint: tokenInfo!.tokenXMint,
              tokenYMint: tokenInfo!.tokenYMint,
              tokenXProgram: tokenInfo!.tokenXProgram,
              tokenYProgram: tokenInfo!.tokenYProgram,
              lowerBinId: position.lowerBinId,
              upperBinId: position.upperBinId,
            })
          : await buildDlmmClaimFeesTx(connection, walletKey, {
              pool: new PublicKey(position.poolAddress),
              position: new PublicKey(position.publicKey),
            })
        txs.push(tx)
        upd(labels.length - 1, {
          state: 'done',
          detail: `+ ${(HELIUS_SENDER_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(4)} SOL helius tip`,
        })
      } else {
        labels.push({
          label: `build withdraw + close tx (${ownershipTag})`,
          state: 'running',
        })
        setSteps([...labels])
        const tx = isHawk
          ? await buildHawkWithdrawCloseTx(connection, walletKey, {
              pool: new PublicKey(position.poolAddress),
              position: new PublicKey(position.publicKey),
              tokenXMint: tokenInfo!.tokenXMint,
              tokenYMint: tokenInfo!.tokenYMint,
              tokenXProgram: tokenInfo!.tokenXProgram,
              tokenYProgram: tokenInfo!.tokenYProgram,
              lowerBinId: position.lowerBinId,
              upperBinId: position.upperBinId,
            })
          : await buildDlmmWithdrawCloseTx(connection, walletKey, {
              pool: new PublicKey(position.poolAddress),
              position: new PublicKey(position.publicKey),
              lowerBinId: position.lowerBinId,
              upperBinId: position.upperBinId,
            })
        txs.push(tx)
        upd(labels.length - 1, {
          state: 'done',
          detail: `+ ${(HELIUS_SENDER_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(4)} SOL helius tip`,
        })
      }

      labels.push({ label: 'sign transaction', state: 'running' })
      setSteps([...labels])
      const signed = (await signAllTransactions(txs)) as VersionedTransaction[]
      upd(labels.length - 1, { state: 'done', detail: `${signed.length} tx signed` })

      labels.push({ label: 'send via helius sender', state: 'running' })
      setSteps([...labels])
      const sig = await sendViaHeliusSender(signed[0])
      upd(labels.length - 1, { state: 'done', detail: `${sig.slice(0, 8)}…` })

      labels.push({ label: 'waiting for inclusion', state: 'running' })
      setSteps([...labels])
      await pollAllSigsConfirmed(connection, [sig], {
        commitment: 'confirmed',
        timeoutMs: 75_000,
      })
      upd(labels.length - 1, {
        state: 'done',
        detail: `confirmed ${sig.slice(0, 8)}…`,
      })
      setResult([sig])
      onRefresh()
    } catch (e) {
      const msg = (e as Error).message
      setLimited(false)
      setErr(msg)
      labels.forEach((s, i) => {
        if (s.state === 'running') labels[i] = { ...s, state: 'error', detail: msg }
      })
      setSteps([...labels])
    } finally {
      setRunning(null)
    }
  }

  return (
    <article className="rounded bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.18)] p-4">
      <div className="grid md:grid-cols-[1fr_auto] gap-3 items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-[2px] px-2 py-0.5 rounded border border-[rgb(255_34_0_/_0.35)] bg-[rgb(255_34_0_/_0.06)] text-[var(--color-hot)]">
              meteora dlmm
            </span>
            {position.ownership === 'hawkfi' ? (
              <span
                className="text-[10px] font-black uppercase tracking-[2px] px-2 py-0.5 rounded border border-[var(--color-green)] bg-[rgb(34_238_136_/_0.08)] text-[var(--color-green)]"
                title="Position owner is your HawkFi userPda — eligible for HawkFi auto-rebalance/auto-compound."
              >
                hawkfi · auto
              </span>
            ) : (
              <span
                className="text-[10px] font-black uppercase tracking-[2px] px-2 py-0.5 rounded border border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.08)] text-[var(--color-warn)]"
                title="Position owner is your wallet directly — NOT auto-managed. Close + reopen via SingleSided to enable HawkFi automation."
              >
                direct · manual
              </span>
            )}
            <span className="text-[12px] font-black text-[var(--color-fg)]">
              stacSOL / {position.poolName}
            </span>
            <span className="text-[10px] text-[var(--color-dim)] font-mono">
              {position.publicKey.slice(0, 6)}…{position.publicKey.slice(-4)}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-dim)]">
            bins {position.lowerBinId}…{position.upperBinId} · liquidity{' '}
            <span className="text-[var(--color-fg)] font-mono">
              {stacUi.toFixed(4)} stacSOL + {otherUi.toLocaleString(undefined, { maximumFractionDigits: 6 })} {position.poolName}
            </span>
          </div>
          {hasFees && (
            <div className="mt-1 text-[11px] text-[var(--color-green)]">
              fees claimable:{' '}
              <span className="font-mono">
                {stacFeeUi.toFixed(6)} stacSOL + {otherFeeUi.toLocaleString(undefined, { maximumFractionDigits: 6 })} {position.poolName}
              </span>
            </div>
          )}
          {position.ownership === 'direct' && (
            <div className="mt-1 text-[10px] text-[var(--color-warn)]">
              ⚠ this position is not HawkFi-automated. close + reopen via{' '}
              <a
                href={`/singlesided?pool=${position.poolAddress}`}
                className="underline hover:text-[var(--color-ember)]"
              >
                SingleSided →
              </a>{' '}
              to enable auto-rebalance.
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => runAction('claim')}
            disabled={running !== null || !hasFees}
            className="text-[10px] font-black uppercase tracking-[2px] px-3 py-2 rounded border border-[var(--color-green)] text-[var(--color-green)] hover:bg-[rgb(34_238_136_/_0.06)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running === 'claim' ? '…' : 'claim'}
          </button>
          <button
            type="button"
            onClick={() => runAction('close')}
            disabled={running !== null}
            className="text-[10px] font-black uppercase tracking-[2px] px-3 py-2 rounded border border-[var(--color-warn)] text-[var(--color-warn)] hover:bg-[rgb(255_204_0_/_0.06)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {running === 'close' ? '…' : 'close + collect'}
          </button>
        </div>
      </div>

      {steps.length > 0 && (
        <div className="mt-3">
          <StepList steps={steps} />
        </div>
      )}
      {result && (
        <div className="mt-3">
          <BundleResult txIds={result} />
        </div>
      )}
      {err && (
        <div
          className={`mt-2 text-[11px] font-mono break-all ${limited ? 'text-[var(--color-ember)]' : 'text-[var(--color-warn)]'}`}
        >
          {limited ? '⏳' : 'error:'} {err}
        </div>
      )}
    </article>
  )
}

/* ============================ CPMM section ============================ */

function CpmmSection({
  positions,
  loading,
  error,
}: {
  positions: CpmmPosition[]
  loading: boolean
  error: string | null
}) {
  return (
    <section className="mt-12">
      <header className="flex items-center justify-between mb-3">
        <h2 className="m-0 text-lg font-black uppercase tracking-[3px] text-[var(--color-hot)]">
          Raydium CPMM (balanced)
        </h2>
      </header>

      {error && (
        <p className="text-[var(--color-warn)] text-[12px]">load error: {error}</p>
      )}
      {loading && positions.length === 0 && (
        <p className="text-[var(--color-dim)] text-[12px]">loading…</p>
      )}
      {!loading && positions.length === 0 && !error && (
        <p className="text-[var(--color-dim)] text-[12px]">
          no CPMM LP positions. <a href="/liquidity" className="text-[var(--color-hot)]">add some →</a>
        </p>
      )}

      <div className="space-y-2">
        {positions.map((p) => (
          <article
            key={p.poolId}
            className="rounded bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.18)] p-4 grid md:grid-cols-[1fr_auto] gap-3 items-center"
          >
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-[2px] px-2 py-0.5 rounded border border-[rgb(255_34_0_/_0.35)] bg-[rgb(255_34_0_/_0.06)] text-[var(--color-hot)]">
                  raydium cp
                </span>
                <span className="text-[12px] font-black text-[var(--color-fg)]">
                  {p.pairLabel}
                </span>
                {p.apr != null && (
                  <span className="text-[10px] text-[var(--color-green)] font-mono">
                    {p.apr.toLocaleString(undefined, { maximumFractionDigits: 0 })}% APR
                  </span>
                )}
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-dim)]">
                LP balance{' '}
                <span className="text-[var(--color-fg)] font-mono">
                  {p.myLpUi.toFixed(6)}
                </span>
                {' · '}
                {(p.fractionOfPool * 100).toFixed(3)}% of pool
              </div>
              <div className="mt-1 text-[11px] text-[var(--color-fg)]">
                claim:{' '}
                <span className="font-mono">
                  {p.stacsolUi.toFixed(4)} stacSOL + {p.otherUi.toLocaleString(undefined, { maximumFractionDigits: 6 })} {p.otherSymbol}
                </span>
              </div>
            </div>
            <div>
              <a
                href="/liquidity"
                className="inline-block text-[10px] font-black uppercase tracking-[2px] px-3 py-2 rounded border border-[var(--color-warn)] text-[var(--color-warn)] hover:bg-[rgb(255_204_0_/_0.06)] no-underline"
              >
                manage on /liquidity
              </a>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}

/* ============================== shared ============================== */

function StepList({ steps }: { steps: BundleStep[] }) {
  return (
    <ol className="m-0 p-0 list-none space-y-1.5 bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)]">
      {steps.map((s, i) => (
        <li key={i} className="grid grid-cols-[18px_1fr] gap-2 items-start">
          <span
            className="text-base leading-none mt-0.5"
            style={{ color: stepColor(s.state) }}
            aria-hidden
          >
            {stepIcon(s.state)}
          </span>
          <div className="min-w-0">
            <div
              className="text-[11px] font-black uppercase tracking-wider"
              style={{ color: stepColor(s.state) }}
            >
              {s.label}
            </div>
            {s.detail && (
              <div className="text-[10px] text-[var(--color-dim)] font-mono break-all mt-0.5">
                {s.detail}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}

function stepIcon(state: BundleStep['state']) {
  if (state === 'done') return '✓'
  if (state === 'error') return '✕'
  if (state === 'running') return '◔'
  return '○'
}

function stepColor(state: BundleStep['state']) {
  if (state === 'done') return 'var(--color-green)'
  if (state === 'error') return 'var(--color-warn)'
  if (state === 'running') return 'var(--color-ember)'
  return 'var(--color-dim)'
}

function BundleResult({ txIds }: { txIds: string[] }) {
  return (
    <div className="bg-[rgb(34_238_136_/_0.06)] border border-[rgb(34_238_136_/_0.4)] rounded p-3">
      <div className="text-[11px] font-black uppercase tracking-[2px] text-[var(--color-green)] mb-2">
        ✓ bundle landed
      </div>
      <ul className="m-0 p-0 list-none space-y-1">
        {txIds.map((id) => (
          <li key={id}>
            <a
              href={solscanTx(id)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] font-mono text-[var(--color-green)] hover:underline break-all"
            >
              {id.slice(0, 12)}…{id.slice(-12)} ↗
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}
