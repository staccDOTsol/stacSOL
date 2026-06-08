// stacSOL single-sided liquidity page (Meteora DLMM).
//
// Lets the user place a directional one-sided position on any of the
// stacSOL/* DLMM pools deployed by scripts/init-meteora-pools.ts.
//
// UX:
//   1. Pick goal: "accumulate stacSOL" or "scale out of stacSOL"
//      (this picks the deposit token automatically — Meteora rule:
//       bins above activeId hold X, below hold Y)
//   2. Pick range magnitude: 2x / 5x / 10x (clamped to Meteora's 70-bin cap)
//   3. Enter the AMOUNT OF DEPOSIT TOKEN (not SOL). If you're short, we
//      swap from your SOL via Jupiter to top up. If you have enough, no swap.
//   4. Bundle Meteora position tx + (optional) Jupiter swap tx + Jito tip,
//      sign all at once, submit as atomic Jito bundle.

import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  HELIUS_SENDER_TIP_LAMPORTS,
  SOL_MINT,
  appendIxToV0Tx,
  extractSignatures,
  getJupiterSwapTx,
  heliusTipIx,
  jupiterQuote,
  pollAllSigsConfirmed,
  pollConfirmTransaction,
  sendViaHeliusSender,
  solscanTx,
} from './lib/zap'

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const STACSOL_DECIMALS = 9
// Meteora's per-position cap is 70 bins. lib/dlmm.ts splits the deposit into
// 1 preflight + N chunks, each sent independently via Helius Sender. Each
// chunk carries its own Helius tip ix; chunks have no inter-dependencies so
// they fan out and confirm in parallel. Max coverage = MAX_CHUNKS × 70 bins.
const MAX_BINS_PER_POSITION = 70
const MAX_CHUNKS = 4

interface PoolEntry {
  name: string
  mint: string
  decimals: number
  poolAddress: string
  tokenX: string
  tokenY: string
  binStep: number
  feeBps: number
  activeId: number
  initialPriceYPerX: number
}

interface BundleStep {
  label: string
  state: 'pending' | 'running' | 'done' | 'error'
  detail?: string
}

export default function SingleSided() {
  useEffect(() => {
    const prev = document.title
    document.title = 'stacSOL single-sided'
    return () => {
      document.title = prev
    }
  }, [])

  const [pools, setPools] = useState<PoolEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const r = await fetch('/api/meteora-pools')
        if (!r.ok) throw new Error(`pools ${r.status}`)
        const j = await r.json()
        if (!cancelled) {
          setPools(j.pools ?? [])
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    const id = setInterval(run, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  return (
    <div className="min-h-screen text-[var(--color-fg)]">
      <Nav />
      <Hero />
      <Disclaimer />
      <section className="max-w-[1080px] mx-auto px-6 py-8">
        {error && (
          <p className="text-[var(--color-warn)] text-[12px] mb-4">
            error loading pools: {error}
          </p>
        )}
        {loading && pools.length === 0 && (
          <p className="text-[var(--color-dim)] text-[12px]">loading pools…</p>
        )}
        {!loading && pools.length === 0 && (
          <p className="text-[var(--color-dim)] text-[12px]">
            no Meteora pools deployed yet — run{' '}
            <code className="text-[var(--color-fg)]">
              bun run scripts/init-meteora-pools.ts --execute
            </code>{' '}
            to deploy them.
          </p>
        )}
        <div className="space-y-5">
          {pools.map((p) => (
            <PoolCard key={p.poolAddress} pool={p} />
          ))}
        </div>
      </section>
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
        <div className="flex items-center gap-3">
          <a
            href="/portfolio"
            className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-ember)] hover:text-[var(--color-fg)] no-underline"
          >
            portfolio →
          </a>
          <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
            single-sided · hawkfi
          </span>
          <WalletMultiButton />
        </div>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 pt-16 pb-8 text-center">
      <h1 className="m-0 text-[clamp(36px,6vw,72px)] font-black tracking-[-0.04em] leading-[0.95] text-[var(--color-fg)]">
        Single-sided{' '}
        <span className="text-[var(--color-hot)] [text-shadow:0_0_24px_rgba(255,34,0,0.5)]">
          directional bet.
        </span>
      </h1>
      <p className="mt-6 max-w-[680px] mx-auto text-[14px] leading-relaxed text-[var(--color-dim)]">
        Concentrated liquidity on Meteora DLMM. Pick a side, pick a direction
        (the magnitude of the move you expect), commit SOL. We zap into the
        right token and place a single-sided position, all in one Jito bundle.
        HawkFi can rebalance these later.
      </p>
    </section>
  )
}

function Disclaimer() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 pb-4 space-y-4">
      <div className="rounded-lg border-2 border-[var(--color-green)] bg-[rgb(34_238_136_/_0.05)] p-5">
        <div className="flex items-start gap-3">
          <span className="text-[var(--color-green)] text-2xl leading-none">↑</span>
          <div className="space-y-2">
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-green)]">
              Yield keeps accruing while LP&apos;d
            </div>
            <p className="m-0 text-[13px] leading-relaxed text-[var(--color-fg)]">
              The protocol earns on every stacSOL ever minted — supply is
              supply, regardless of whether your tokens sit in your wallet or
              in this pool. NAV climbs against the full balance, so you don&apos;t
              forfeit redemption-rate gains by becoming an LP. The LP earns
              swap fees on top.
            </p>
            <p className="m-0 text-[13px] leading-relaxed text-[var(--color-fg)]">
              Trade-off: you can&apos;t burn stacSOL while it&apos;s inside a
              position. Withdraw via{' '}
              <a href="/portfolio" className="text-[var(--color-hot)]">/portfolio</a>{' '}
              first, then burn from your wallet.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border-2 border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.05)] p-5">
        <div className="flex items-start gap-3">
          <span className="text-[var(--color-warn)] text-2xl leading-none">⚠</span>
          <div className="space-y-2">
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-warn)]">
              read this — single-sided concentrated LP risk
            </div>
            <p className="m-0 text-[13px] leading-relaxed text-[var(--color-fg)]">
              A single-sided position is essentially a stack of limit orders.
              If price moves THROUGH your range, you fully convert to the
              other token at progressively worse prices. If price moves AWAY
              from your range, you collect zero fees and your position sits
              dormant. This is{' '}
              <span className="text-[var(--color-warn)] font-black">
                not "set and forget"
              </span>
              .
            </p>
            <p className="m-0 text-[13px] leading-relaxed text-[var(--color-fg)]">
              stacSOL is Token-2022 with a 13.8% transfer fee. Every swap
              through the pool burns that fee on the stacSOL leg, which
              compounds against LPs over time.
            </p>
            <p className="m-0 text-[13px] leading-relaxed text-[var(--color-fg)]">
              Worst case: if the paired token rugs or trades to{' '}
              <span className="font-black text-[var(--color-hot)]">zero</span>,
              the position is fcukered — you end up holding all of the
              worthless side. NAV growth on the rest of the protocol can&apos;t
              save a single LP from a dead-token pair. Don&apos;t LP money you
              can&apos;t afford to lose.
            </p>
          </div>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="max-w-[1080px] mx-auto px-6 py-10 border-t border-[rgb(255_34_0_/_0.12)] text-center text-[10px] text-[var(--color-dim)] uppercase tracking-[2px]">
      meteora dlmm · positions managed via{' '}
      <a
        href="https://hawksight.fi"
        target="_blank"
        rel="noopener noreferrer"
        className="text-[var(--color-hot)]"
      >
        hawkfi
      </a>{' '}
      after deposit
    </footer>
  )
}

/* ============================== pool card ============================== */

function PoolCard({ pool }: { pool: PoolEntry }) {
  const [open, setOpen] = useState<'deposit' | 'withdraw' | null>(null)
  const isStacX = pool.tokenX === STACSOL_MINT
  const otherSymbol = pool.name
  const stacFirstLabel = isStacX
    ? `stacSOL / ${otherSymbol}`
    : `${otherSymbol} / stacSOL`

  // Display price: stacSOL per OTHER (always, regardless of lex order)
  const stacPerOther = isStacX
    ? pool.initialPriceYPerX > 0
      ? 1 / pool.initialPriceYPerX
      : 0
    : pool.initialPriceYPerX
  const otherPerStac = isStacX
    ? pool.initialPriceYPerX
    : pool.initialPriceYPerX > 0
    ? 1 / pool.initialPriceYPerX
    : 0

  return (
    <article className="rounded-lg bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)]">
      <header className="p-5 border-b border-[rgb(255_34_0_/_0.12)] grid grid-cols-[1fr_auto] gap-4 items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-[2px] px-2 py-0.5 rounded border border-[rgb(255_34_0_/_0.35)] bg-[rgb(255_34_0_/_0.06)] text-[var(--color-hot)]">
              meteora dlmm
            </span>
            <h2 className="m-0 text-lg font-black text-[var(--color-fg)]">
              {stacFirstLabel}
            </h2>
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-dim)] font-mono">
            {pool.poolAddress.slice(0, 8)}…{pool.poolAddress.slice(-6)} · binStep{' '}
            {pool.binStep}bp · fee {(pool.feeBps / 100).toFixed(2)}%
          </div>
          <div className="mt-2 text-[11px] text-[var(--color-fg)]">
            ~{otherPerStac.toLocaleString(undefined, { maximumFractionDigits: 6 })}{' '}
            {otherSymbol} / stacSOL ·{' '}
            {stacPerOther.toLocaleString(undefined, { maximumFractionDigits: 6 })}{' '}
            stacSOL / {otherSymbol}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOpen(open === 'deposit' ? null : 'deposit')}
            className={`px-4 py-2 text-[10px] font-black uppercase tracking-[2px] rounded border transition ${
              open === 'deposit'
                ? 'bg-[var(--color-hot)] text-black border-[var(--color-hot)]'
                : 'text-[var(--color-hot)] border-[var(--color-hot)] hover:bg-[rgb(255_34_0_/_0.1)]'
            }`}
          >
            deposit
          </button>
          <button
            type="button"
            onClick={() => setOpen(open === 'withdraw' ? null : 'withdraw')}
            className={`px-4 py-2 text-[10px] font-black uppercase tracking-[2px] rounded border transition ${
              open === 'withdraw'
                ? 'bg-[var(--color-warn)] text-black border-[var(--color-warn)]'
                : 'text-[var(--color-warn)] border-[var(--color-warn)] hover:bg-[rgb(255_204_0_/_0.1)]'
            }`}
          >
            withdraw
          </button>
        </div>
      </header>
      {open === 'deposit' && (
        <DepositPanel pool={pool} onClose={() => setOpen(null)} />
      )}
      {open === 'withdraw' && (
        <WithdrawPanel pool={pool} onClose={() => setOpen(null)} />
      )}
    </article>
  )
}

/* ============================ deposit panel ============================ */

type Goal = 'accumulate' | 'scale-out'
type Magnitude = 2 | 5 | 10

interface BinChunk {
  minBinId: number
  maxBinId: number
}

interface DepositPlan {
  /** Side the user must hold to deposit (after zap) */
  depositMint: string
  depositMintDecimals: number
  isDepositingX: boolean
  /** Direction relative to activeId */
  direction: 'above' | 'below'
  /** Bins requested by the user (before any cap) */
  requestedBins: number
  /** Bins we'll actually cover after MAX_CHUNKS truncation */
  coveredBins: number
  /** True when the requested range exceeded the bundle cap */
  truncated: boolean
  /** Per-position chunks; len() in [1..MAX_CHUNKS]. Each chunk fits in 1 position tx. */
  chunks: BinChunk[]
}

function computeDepositPlan(
  pool: PoolEntry,
  goal: Goal,
  magnitude: Magnitude,
): DepositPlan {
  const isStacX = pool.tokenX === STACSOL_MINT
  // Bin offset for an Nx price move
  const s = pool.binStep / 10000
  const requestedBins = Math.max(1, Math.ceil(Math.log(magnitude) / Math.log(1 + s)))
  const maxCoverable = MAX_BINS_PER_POSITION * MAX_CHUNKS
  const coveredBins = Math.min(requestedBins, maxCoverable)
  const truncated = coveredBins < requestedBins

  // Determine which side to deposit and which direction (above or below activeId)
  // - accumulate stacSOL: deposit OTHER, in bins where it'll be sold for stacSOL
  // - scale out of stacSOL: deposit stacSOL, in bins where it'll be sold for OTHER
  //
  // Meteora rule: bins above activeId hold X (sells X up); bins below activeId hold Y (sells Y down)
  let isDepositingX: boolean
  let direction: 'above' | 'below'

  if (goal === 'accumulate') {
    // Accumulating stacSOL → depositing the OTHER token
    if (isStacX) {
      // OTHER = Y; bins below hold Y
      isDepositingX = false
      direction = 'below'
    } else {
      // OTHER = X; bins above hold X
      isDepositingX = true
      direction = 'above'
    }
  } else {
    // scale-out of stacSOL → depositing stacSOL
    if (isStacX) {
      isDepositingX = true
      direction = 'above'
    } else {
      isDepositingX = false
      direction = 'below'
    }
  }

  // Chunk the range into ≤MAX_CHUNKS positions of ≤MAX_BINS_PER_POSITION each.
  const chunks: BinChunk[] = []
  let consumed = 0
  while (consumed < coveredBins && chunks.length < MAX_CHUNKS) {
    const sz = Math.min(MAX_BINS_PER_POSITION, coveredBins - consumed)
    let minDelta: number
    let maxDelta: number
    if (direction === 'above') {
      // bins above activeId: deltas 1..coveredBins
      minDelta = consumed + 1
      maxDelta = consumed + sz
    } else {
      // bins below activeId: deltas -coveredBins..-1, allocated furthest-first
      // so chunk 0 starts adjacent to activeId
      maxDelta = -(consumed + 1)
      minDelta = -(consumed + sz)
    }
    chunks.push({
      minBinId: pool.activeId + minDelta,
      maxBinId: pool.activeId + maxDelta,
    })
    consumed += sz
  }

  const depositMint = isDepositingX ? pool.tokenX : pool.tokenY
  const depositMintDecimals =
    depositMint === STACSOL_MINT ? STACSOL_DECIMALS : pool.decimals

  return {
    depositMint,
    depositMintDecimals,
    isDepositingX,
    direction,
    requestedBins,
    coveredBins,
    truncated,
    chunks,
  }
}

/**
 * Resolve which token program owns a mint by reading its account header.
 * Cached for the page's lifetime since mints don't change owner.
 */
const mintProgramCache = new Map<string, PublicKey>()
async function resolveTokenProgram(
  connection: import('@solana/web3.js').Connection,
  mint: PublicKey,
): Promise<PublicKey> {
  const k = mint.toBase58()
  const cached = mintProgramCache.get(k)
  if (cached) return cached
  const acc = await connection.getAccountInfo(mint)
  if (!acc) {
    // Default to classic Token if we can't read; safer than throwing.
    return new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
  }
  mintProgramCache.set(k, acc.owner)
  return acc.owner
}

/** Read user's balance (atomic) for a given mint, dynamically resolving
 *  the token program. Returns 0n on missing ATA. */
async function readMintBalance(
  connection: import('@solana/web3.js').Connection,
  owner: PublicKey,
  mint: PublicKey,
): Promise<bigint> {
  if (mint.toBase58() === SOL_MINT) {
    return BigInt(await connection.getBalance(owner))
  }
  const programId = await resolveTokenProgram(connection, mint)
  try {
    const ata = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    const acc = await connection.getAccountInfo(ata)
    if (!acc) return 0n
    return acc.data.readBigUInt64LE(64)
  } catch {
    return 0n
  }
}

function DepositPanel({
  pool,
  onClose,
}: {
  pool: PoolEntry
  onClose: () => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [goal, setGoal] = useState<Goal>('accumulate')
  const [magnitude, setMagnitude] = useState<Magnitude>(5)
  // Input is now in DEPOSIT-TOKEN UI units (not SOL).
  const [tokenAmount, setTokenAmount] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [steps, setSteps] = useState<BundleStep[]>([])
  const [bundleLink, setBundleLink] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rateLimited, setRateLimited] = useState(false)

  const inputAmount = parseFloat(tokenAmount)
  const plan = useMemo(
    () => computeDepositPlan(pool, goal, magnitude),
    [pool, goal, magnitude],
  )
  const otherSymbol = pool.name
  const depositLabel =
    plan.depositMint === STACSOL_MINT ? 'stacSOL' : otherSymbol
  const isDepositingWsol = plan.depositMint === SOL_MINT

  // Live balances: native SOL + the deposit token (for max button + coverage).
  const [solBalance, setSolBalance] = useState<bigint | null>(null)
  const [depositBalance, setDepositBalance] = useState<bigint | null>(null)
  const [balRefresh, setBalRefresh] = useState(0)
  useEffect(() => {
    if (!wallet.publicKey) {
      setSolBalance(null)
      setDepositBalance(null)
      return
    }
    let cancelled = false
    const owner = wallet.publicKey
    ;(async () => {
      try {
        const sol = BigInt(await connection.getBalance(owner))
        if (cancelled) return
        setSolBalance(sol)
        // readMintBalance auto-detects classic-Token vs Token-2022 from the
        // mint's owner program — fixes the bug where thystaccfloweth-family
        // tokens (FOMOX402 et al, all Token-2022) showed 0 balance because
        // we were deriving the ATA under the wrong program.
        const bal = await readMintBalance(
          connection,
          owner,
          new PublicKey(plan.depositMint),
        )
        if (!cancelled) setDepositBalance(bal)
      } catch {
        if (!cancelled) {
          setSolBalance(null)
          setDepositBalance(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    wallet.publicKey,
    connection,
    isDepositingWsol,
    plan.depositMint,
    balRefresh,
  ])

  const onSubmit = async () => {
    if (!wallet.publicKey || !wallet.signAllTransactions) {
      setError('connect wallet first')
      return
    }
    if (!agreed) {
      setError('check the acknowledgment first')
      return
    }
    if (!inputAmount || inputAmount <= 0) {
      setError(`enter a ${depositLabel} amount`)
      return
    }

    setError(null)
    setRateLimited(false)
    setBundleLink(null)
    setSubmitting(true)

    const owner = wallet.publicKey
    const stepLabels: BundleStep[] = []
    const updateStep = (i: number, patch: Partial<BundleStep>) => {
      stepLabels[i] = { ...stepLabels[i], ...patch }
      setSteps([...stepLabels])
    }

    try {
      // --- 1. Compute deposit amount + check balance, swap if short ---
      stepLabels.push({ label: 'check balance', state: 'running' })
      setSteps([...stepLabels])

      const txs: VersionedTransaction[] = []
      const depositAmountAtomic = BigInt(
        Math.floor(inputAmount * Math.pow(10, plan.depositMintDecimals)),
      )

      // Read user's deposit-token balance — auto-detects token program.
      const have = await readMintBalance(
        connection,
        owner,
        new PublicKey(plan.depositMint),
      )

      const haveUi = Number(have) / Math.pow(10, plan.depositMintDecimals)
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `you have ${haveUi.toFixed(4)} ${depositLabel}, need ${inputAmount.toFixed(4)}`,
      })

      const shortfall = have >= depositAmountAtomic ? 0n : depositAmountAtomic - have

      if (shortfall > 0n) {
        if (isDepositingWsol) {
          throw new Error(
            `you only have ${haveUi.toFixed(4)} SOL but need ${inputAmount.toFixed(4)} — top up wallet`,
          )
        }
        // Quote SOL → depositMint to figure out lamports needed
        stepLabels.push({ label: `top up ${depositLabel} from SOL`, state: 'running' })
        setSteps([...stepLabels])

        // First quote: 1 SOL → depositMint to derive rate
        const onesol = BigInt(LAMPORTS_PER_SOL)
        const rateQuote = await jupiterQuote({
          inputMint: SOL_MINT,
          outputMint: plan.depositMint,
          amount: onesol,
          swapMode: 'ExactIn',
          slippageBps: 5000,
        })
        const outAtomPerSol = Number(rateQuote.outAmount)
        if (outAtomPerSol <= 0) {
          throw new Error(`no jupiter route SOL → ${depositLabel}`)
        }
        // Lamports needed = shortfall × LAMPORTS_PER_SOL / outAtomPerSol × 1.05 (5% buffer for slippage)
        const lamportsForSwap = BigInt(
          Math.ceil((Number(shortfall) * LAMPORTS_PER_SOL) / outAtomPerSol * 1.05),
        )
        // Actual swap quote at the exact lamports
        const swapQuote = await jupiterQuote({
          inputMint: SOL_MINT,
          outputMint: plan.depositMint,
          amount: lamportsForSwap,
          swapMode: 'ExactIn',
          slippageBps: 5000,
        })
        // Send the Jupiter swap as a standalone Helius Sender call FIRST
        // and wait for on-chain confirmation, BEFORE building the deposit.
        // Jupiter doesn't expose a Helius-tip option, so we ask Jupiter for
        // the swap tx with `prioritizationFeeLamports: 'auto'` (normal
        // priority fee, NOT a tip) and then APPEND a Helius tip transfer
        // ix ourselves via appendIxToV0Tx. The Sender requires that tip ix
        // or it rejects the tx.
        // Trade-off: swap and deposit aren't atomic — if swap lands and
        // deposit fails, user is left with depositLabel tokens they can
        // deposit later (or refund).
        const swapTxRaw = await getJupiterSwapTx({
          quote: swapQuote,
          userPublicKey: owner,
          prioritizationFeeLamports: 'auto',
        })
        const swapTx = await appendIxToV0Tx(connection, swapTxRaw, heliusTipIx(owner))
        const [signedSwap] = (await wallet.signAllTransactions([swapTx])) as VersionedTransaction[]
        const swapSig = await sendViaHeliusSender(signedSwap)
        // Confirm via HTTP polling. If the swap genuinely fails the
        // pollConfirmTransaction throws with the on-chain error; we then
        // abort (otherwise the deposit would fail with confusing balance
        // errors). On polling timeout we proceed anyway — Sender's
        // dual-routing means the swap usually lands even when our poller
        // hasn't seen it yet.
        try {
          await pollConfirmTransaction(connection, swapSig, {
            commitment: 'confirmed',
            timeoutMs: 45_000,
          })
        } catch (e) {
          const msg = (e as Error).message
          if (msg.includes('failed on chain')) throw e
          /* timeout — proceed; deposit will fail with the real reason if balance is short */
        }
        updateStep(stepLabels.length - 1, {
          state: 'done',
          detail: `~${(Number(lamportsForSwap) / LAMPORTS_PER_SOL).toFixed(4)} SOL → ~${(Number(swapQuote.outAmount) / Math.pow(10, plan.depositMintDecimals)).toFixed(4)} ${depositLabel} (sender — sig ${swapSig.slice(0, 8)}…)`,
        })
      } else {
        stepLabels.push({
          label: `${depositLabel} sufficient`,
          state: 'done',
          detail: `using your ${haveUi.toFixed(4)} ${depositLabel}, no swap`,
        })
        setSteps([...stepLabels])
      }

      // --- 2. Build HawkFi-wrapped deposit txs ---
      // Position lands owned by user's HawkFi userPda → automation eligible.
      // First-time depositors automatically get a `newUser` ix prepended
      // (initializes their userPda on the iyfMain program). The deposit
      // moves user wallet → userPda → Meteora reserve in a single signed
      // batch, but we send the userPda-init + preflight first, then fan
      // out chunks in parallel.
      stepLabels.push({ label: 'build hawkfi deposit (auto-managed)', state: 'running' })
      setSteps([...stepLabels])

      const { buildHawkDepositTxs } = await import('./lib/hawkfi-flows')

      // Strategy mapping: SingleSided uses BidAsk. Meteora's SDK converts
      // its "BidAsk" enum (= 2) into the on-chain ImBalanced variant (= 8)
      // with parameters[0] = 1 if singleSidedX. We pass the on-chain
      // variant directly to keep the wire format identical to the SDK's.
      const HAWK_STRATEGY_BIDASK_IMBALANCED = 8

      // Distribute the user's total deposit across chunks. Equal split.
      const chunkCount = plan.chunks.length
      const perChunk = depositAmountAtomic / BigInt(chunkCount)
      const remainder = depositAmountAtomic - perChunk * BigInt(chunkCount)
      const perChunkAmounts: bigint[] = []
      for (let i = 0; i < chunkCount; i++) {
        perChunkAmounts.push(i === chunkCount - 1 ? perChunk + remainder : perChunk)
      }
      const perChunkX = plan.isDepositingX ? perChunkAmounts : perChunkAmounts.map(() => 0n)
      const perChunkY = plan.isDepositingX ? perChunkAmounts.map(() => 0n) : perChunkAmounts

      const built = await buildHawkDepositTxs(connection, owner, {
        pool: new PublicKey(pool.poolAddress),
        chunks: plan.chunks.map((c) => ({ minBinId: c.minBinId, maxBinId: c.maxBinId })),
        perChunkXAtomic: perChunkX,
        perChunkYAtomic: perChunkY,
        strategyType: HAWK_STRATEGY_BIDASK_IMBALANCED,
        singleSidedX: plan.isDepositingX,
        // Generous bin-slippage allowance — chunks span up to 70 bins from
        // active price; tight slippage (e.g. 5) would reject most deposits.
        // Meteora's default is 50; we use 1000 to be permissive for far
        // ranges. Slippage applies to active-id drift, not the bin range.
        maxActiveBinSlippage: 1000,
      })

      const rangeStart = plan.chunks[0].minBinId
      const rangeEnd = plan.chunks[plan.chunks.length - 1].maxBinId
      const totalBins = plan.chunks.reduce((s, c) => s + (c.maxBinId - c.minBinId + 1), 0)
      const txCount = (built.ensureUserPdaTx ? 1 : 0) + 1 + built.chunkTxs.length
      const totalTipSol = (txCount * HELIUS_SENDER_TIP_LAMPORTS) / LAMPORTS_PER_SOL
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${chunkCount} hawkfi-managed position${chunkCount === 1 ? '' : 's'} · bins ${rangeStart}…${rangeEnd} (Δ${totalBins})${plan.truncated ? ` · partial of requested Δ${plan.requestedBins} (re-deposit for rest)` : ''}${built.ensureUserPdaTx ? ' · userPda init included' : ''} · ${totalTipSol.toFixed(4)} SOL tips`,
      })

      // --- 4. Sign all in ONE wallet popup ---
      // Order: [optional userPda init, preflight, ...chunks]. Sending is
      // staged below: userPda init → preflight → chunks (parallel).
      const allTxs: VersionedTransaction[] = []
      if (built.ensureUserPdaTx) allTxs.push(built.ensureUserPdaTx)
      allTxs.push(built.preflightTx, ...built.chunkTxs)
      txs.push(...allTxs)

      stepLabels.push({ label: 'sign all transactions', state: 'running' })
      setSteps([...stepLabels])
      const signed = (await wallet.signAllTransactions(txs)) as VersionedTransaction[]
      let cursor = 0
      const signedUserPdaInit = built.ensureUserPdaTx ? signed[cursor++] : null
      const signedPreflight = signed[cursor++]
      const signedChunks = signed.slice(cursor)
      // Some wallet adapters clear the position-key partial signatures during
      // signAllTransactions, leaving the chunk's signer slot at zero. Re-sign
      // each chunk with its position keypair to guarantee Sender sees valid
      // signatures; this is a no-op when the wallet preserved them.
      built.reattachChunkSigs(signedChunks)
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${signed.length} txs signed${signedUserPdaInit ? ' (incl. userPda init)' : ''}`,
      })

      // --- 5a. Init userPda if needed (first deposit only) ---
      if (signedUserPdaInit) {
        stepLabels.push({ label: 'register hawkfi userPda', state: 'running' })
        setSteps([...stepLabels])
        const sig = await sendViaHeliusSender(signedUserPdaInit)
        try {
          await pollConfirmTransaction(connection, sig, {
            commitment: 'confirmed',
            timeoutMs: 60_000,
          })
        } catch (e) {
          throw new Error(
            `userPda init ${sig.slice(0, 8)}… ${(e as Error).message}. check ${solscanTx(sig)}.`,
            { cause: e },
          )
        }
        updateStep(stepLabels.length - 1, {
          state: 'done',
          detail: `${sig.slice(0, 8)}… (one-time per wallet)`,
        })
      }

      // --- 5b. Send preflight via Helius Sender ---
      stepLabels.push({ label: 'send preflight (atas + wsol wrap + bin arrays + deposit→userPda)', state: 'running' })
      setSteps([...stepLabels])
      const preflightSig = await sendViaHeliusSender(signedPreflight)
      try {
        await pollConfirmTransaction(connection, preflightSig, {
          commitment: 'confirmed',
          timeoutMs: 60_000,
        })
      } catch (e) {
        const msg = (e as Error).message
        throw new Error(
          `preflight ${preflightSig.slice(0, 8)}… ${msg}. check ${solscanTx(preflightSig)} and retry — chunks not submitted.`,
          { cause: e },
        )
      }
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `confirmed ${preflightSig.slice(0, 8)}…`,
      })

      // --- 6. Fan out chunks: send all in parallel via Helius Sender ---
      stepLabels.push({
        label: `send ${signedChunks.length} chunk${signedChunks.length === 1 ? '' : 's'} via helius sender`,
        state: 'running',
      })
      setSteps([...stepLabels])
      const chunkSigs = await Promise.all(
        signedChunks.map((tx) => sendViaHeliusSender(tx)),
      )
      // Cross-check the sigs we got from the Sender against the sigs
      // computed from the signed-tx bytes. They should match exactly; if
      // they don't, the wallet/sender disagreed about the message and the
      // tx will never land.
      const localSigs = extractSignatures(signedChunks)
      for (let i = 0; i < chunkSigs.length; i++) {
        if (chunkSigs[i] !== localSigs[i]) {
          throw new Error(
            `chunk ${i + 1}/${chunkSigs.length} sender returned signature ${chunkSigs[i].slice(0, 8)}… but local computed ${localSigs[i].slice(0, 8)}… — mismatch`,
          )
        }
      }
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: chunkSigs.map((s) => s.slice(0, 8) + '…').join(' · '),
      })

      stepLabels.push({ label: 'waiting for inclusion', state: 'running' })
      setSteps([...stepLabels])
      const confirmed = await pollAllSigsConfirmed(connection, chunkSigs, {
        commitment: 'confirmed',
        timeoutMs: 90_000,
      })
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${confirmed.length}/${chunkSigs.length} confirmed`,
      })
      // Surface the preflight sig too so the user can see all parts.
      setBundleLink([preflightSig, ...chunkSigs])
      setTokenAmount('')
      setBalRefresh((n) => n + 1)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      stepLabels.forEach((s, i) => {
        if (s.state === 'running') {
          stepLabels[i] = { ...s, state: 'error', detail: msg }
        }
      })
      setSteps([...stepLabels])
    } finally {
      setSubmitting(false)
    }
  }

  const directionWord = plan.direction === 'above' ? 'upward' : 'downward'
  const positionDescription =
    goal === 'accumulate'
      ? `Deposit ${depositLabel} in bins ${directionWord} from current price. As price moves into your range, ${depositLabel} converts to stacSOL.`
      : `Deposit stacSOL in bins ${directionWord} from current price. As price moves into your range, stacSOL converts to ${otherSymbol}.`

  return (
    <div className="border-t border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.04)] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
          place single-sided position
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--color-dim)] text-xl leading-none hover:text-[var(--color-fg)]"
        >
          ×
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Toggle active={goal === 'accumulate'} onClick={() => setGoal('accumulate')}>
          accumulate stacSOL
        </Toggle>
        <Toggle active={goal === 'scale-out'} onClick={() => setGoal('scale-out')}>
          scale out of stacSOL
        </Toggle>
      </div>

      <div>
        <label className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
          range magnitude (move you expect)
        </label>
        <div className="grid grid-cols-3 gap-2 mt-1">
          {([2, 5, 10] as Magnitude[]).map((m) => (
            <Toggle
              key={m}
              active={magnitude === m}
              onClick={() => setMagnitude(m)}
            >
              {m}x
            </Toggle>
          ))}
        </div>
      </div>

      {/* Live balances — show what user has BEFORE typing. */}
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-[var(--color-bg)] rounded px-3 py-2 border border-[rgb(255_34_0_/_0.1)]">
          <div className="text-[9px] font-black uppercase tracking-[2px] text-[var(--color-hot)]">
            SOL
          </div>
          <div className="tabular-mono text-[12px] font-black text-[var(--color-fg)] truncate">
            {solBalance != null
              ? (Number(solBalance) / LAMPORTS_PER_SOL).toFixed(4)
              : '—'}
          </div>
        </div>
        <div className="bg-[var(--color-bg)] rounded px-3 py-2 border border-[rgb(255_34_0_/_0.1)]">
          <div className="text-[9px] font-black uppercase tracking-[2px] text-[var(--color-dim)]">
            {depositLabel}
          </div>
          <div className="tabular-mono text-[12px] font-black text-[var(--color-fg)] truncate">
            {depositBalance != null
              ? (Number(depositBalance) / Math.pow(10, plan.depositMintDecimals)).toFixed(4)
              : '—'}
          </div>
        </div>
      </div>

      <div>
        <label className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] flex items-center justify-between">
          <span>{depositLabel} amount to deposit</span>
          {depositBalance != null && depositBalance > 0n && (
            <button
              type="button"
              onClick={() => {
                if (isDepositingWsol) {
                  // Reserve helius tips (preflight + worst-case 4 chunks) +
                  // tx fees for the WSOL "max" deposit.
                  const reserve = BigInt(
                    HELIUS_SENDER_TIP_LAMPORTS * (1 + MAX_CHUNKS) + 5_000_000,
                  )
                  const max = depositBalance > reserve ? depositBalance - reserve : 0n
                  setTokenAmount((Number(max) / LAMPORTS_PER_SOL).toFixed(4))
                } else {
                  const ui = Number(depositBalance) / Math.pow(10, plan.depositMintDecimals)
                  setTokenAmount(ui.toFixed(Math.min(6, plan.depositMintDecimals)))
                }
              }}
              className="text-[10px] uppercase tracking-wider text-[var(--color-hot)] hover:text-[var(--color-ember)] font-black"
            >
              max
            </button>
          )}
        </label>
        <input
          type="number"
          step="any"
          min="0"
          value={tokenAmount}
          onChange={(e) => setTokenAmount(e.target.value)}
          placeholder="0.0"
          className="w-full mt-1 px-3 py-2 bg-[var(--color-bg)] border border-[rgb(255_34_0_/_0.25)] rounded text-[var(--color-fg)] font-mono text-base focus:outline-none focus:border-[var(--color-hot)]"
        />
        {/* Coverage preview — visible before submit. */}
        {inputAmount > 0 && (
          <div className="mt-2 bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)] space-y-1">
            {(() => {
              const have = depositBalance != null
                ? Number(depositBalance) / Math.pow(10, plan.depositMintDecimals)
                : null
              const sufficient = have != null && have >= inputAmount
              const short = have != null ? Math.max(0, inputAmount - have) : null
              const decimals = Math.min(6, plan.depositMintDecimals)
              const color = have == null
                ? 'var(--color-dim)'
                : sufficient
                ? 'var(--color-green)'
                : 'var(--color-warn)'
              const status =
                have == null
                  ? 'connect wallet'
                  : sufficient
                  ? '✓ covered'
                  : isDepositingWsol
                  ? `⚠ short ${short!.toFixed(decimals)} SOL — top up wallet`
                  : `→ swap ${short!.toFixed(decimals)} ${depositLabel} from SOL`
              return (
                <>
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-center text-[11px]">
                    <div className="text-[var(--color-dim)] uppercase tracking-wider text-[10px]">
                      deposit {depositLabel}
                    </div>
                    <div className="tabular-mono text-right">
                      <span className="text-[var(--color-fg)] font-black">
                        {inputAmount.toFixed(decimals)}
                      </span>
                      <span className="text-[var(--color-dim)]"> need · </span>
                      <span className="text-[var(--color-fg)]">
                        {have != null ? have.toFixed(decimals) : '—'}
                      </span>
                      <span className="text-[var(--color-dim)]"> have</span>
                    </div>
                  </div>
                  <div className="text-right text-[10px]" style={{ color }}>
                    {status}
                  </div>
                </>
              )
            })()}
          </div>
        )}
        <div className="text-[10px] text-[var(--color-dim)] mt-1">
          plus {((HELIUS_SENDER_TIP_LAMPORTS * (1 + plan.chunks.length)) / LAMPORTS_PER_SOL).toFixed(4)} SOL helius sender tips + ~0.001 SOL fees
        </div>
      </div>

      <div className="bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)] space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
          plan
        </div>
        <div className="text-[12px] text-[var(--color-fg)]">
          {positionDescription}
        </div>
        <div className="text-[11px] text-[var(--color-dim)]">
          range: bins{' '}
          <span className="text-[var(--color-fg)] font-mono">
            {Math.min(plan.chunks[0].minBinId, plan.chunks[plan.chunks.length - 1].minBinId)}
          </span>{' '}
          …{' '}
          <span className="text-[var(--color-fg)] font-mono">
            {Math.max(plan.chunks[0].maxBinId, plan.chunks[plan.chunks.length - 1].maxBinId)}
          </span>{' '}
          (Δ{plan.coveredBins} bins, BidAsk · {plan.chunks.length} position{plan.chunks.length === 1 ? '' : 's'})
          {plan.truncated && (
            <span className="text-[var(--color-warn)]">
              {' '}· truncated from Δ{plan.requestedBins} (Jito 5-tx bundle cap)
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--color-dim)]">
          deposit token:{' '}
          <span className="text-[var(--color-fg)] font-mono">
            {depositLabel}
          </span>
        </div>
      </div>

      <label className="flex items-start gap-2 text-[12px] text-[var(--color-fg)] cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1"
        />
        <span>
          I understand this is a directional, concentrated LP bet. If price
          moves through my range, I will fully convert to the other token at
          progressively worse prices. If price moves away, I earn no fees.
        </span>
      </label>

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting || !agreed || !wallet.publicKey || !inputAmount}
        className="w-full py-3 bg-[var(--color-hot)] text-black font-black uppercase tracking-[3px] text-xs rounded disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
      >
        {submitting
          ? 'working…'
          : rateLimited
          ? 'tap again — jito throttled'
          : `place ${magnitude}x ${goal === 'accumulate' ? 'accumulate' : 'scale-out'} position`}
      </button>

      {steps.length > 0 && <StepList steps={steps} />}
      {bundleLink && <BundleResult txIds={bundleLink} />}
      {error && (
        <div className={`text-[11px] font-mono break-all ${rateLimited ? 'text-[var(--color-ember)]' : 'text-[var(--color-warn)]'}`}>
          {rateLimited ? '⏳' : 'error:'} {error}
        </div>
      )}
    </div>
  )
}

/* ============================ withdraw panel ============================ */
//
// Lists the user's open positions on this pool (read live from chain via the
// Meteora SDK). For each position we build a HawkFi withdraw tx with
// shouldClaimAndClose=true so liquidity, accrued fees, and rent are all
// returned in a single signed tx. Multiple positions bundle in one signAll.

interface UserPosition {
  publicKey: string
  lowerBinId: number
  upperBinId: number
  totalXAmount: bigint
  totalYAmount: bigint
}

function WithdrawPanel({
  pool,
  onClose,
}: {
  pool: PoolEntry
  onClose: () => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [positions, setPositions] = useState<UserPosition[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [steps, setSteps] = useState<BundleStep[]>([])
  const [bundleLink, setBundleLink] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [rateLimited, setRateLimited] = useState(false)

  // Load user's open positions on this pool.
  useEffect(() => {
    if (!wallet.publicKey) {
      setPositions(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const DLMMmod = await import('@meteora-ag/dlmm')
        const DLMM = DLMMmod.default
        const { deriveUserPda } = await import('./lib/hawkfi-flows')
        const [userPda] = deriveUserPda(wallet.publicKey!)
        const dlmm = await DLMM.create(connection, new PublicKey(pool.poolAddress))
        // Fetch direct + HawkFi-managed positions on this pool so the
        // close-all flow can act on both.
        const [direct, hawk] = await Promise.all([
          dlmm.getPositionsByUserAndLbPair(wallet.publicKey!).catch(() => null),
          dlmm.getPositionsByUserAndLbPair(userPda).catch(() => null),
        ])
        if (cancelled) return
        const seen = new Set<string>()
        type DlmmUserPosition = NonNullable<typeof direct>['userPositions'][number]
        const merged: DlmmUserPosition[] = []
        for (const src of [direct, hawk]) {
          if (!src) continue
          for (const p of src.userPositions) {
            const k = p.publicKey.toBase58()
            if (seen.has(k)) continue
            seen.add(k)
            merged.push(p)
          }
        }
        const items = merged.map((p) => {
          const lb = p.positionData
          return {
            publicKey: p.publicKey.toBase58(),
            lowerBinId: lb.lowerBinId,
            upperBinId: lb.upperBinId,
            totalXAmount: BigInt(lb.totalXAmount.toString()),
            totalYAmount: BigInt(lb.totalYAmount.toString()),
          }
        })
        setPositions(items)
        setLoadErr(null)
      } catch (e) {
        if (!cancelled) {
          setLoadErr((e as Error).message)
          setPositions([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [wallet.publicKey, connection, pool.poolAddress, refresh])

  const isStacX = pool.tokenX === STACSOL_MINT
  const stacDecimals = STACSOL_DECIMALS
  const otherDecimals = pool.decimals
  const otherSymbol = pool.name

  const formatPosition = (p: UserPosition) => {
    const stacAtom = isStacX ? p.totalXAmount : p.totalYAmount
    const otherAtom = isStacX ? p.totalYAmount : p.totalXAmount
    const stacUi = Number(stacAtom) / Math.pow(10, stacDecimals)
    const otherUi = Number(otherAtom) / Math.pow(10, otherDecimals)
    return { stacUi, otherUi }
  }

  const onSubmit = async () => {
    if (!wallet.publicKey || !wallet.signAllTransactions) {
      setError('connect wallet first')
      return
    }
    if (!agreed) {
      setError('check the acknowledgment first')
      return
    }
    if (!positions || positions.length === 0) {
      setError('no positions to withdraw')
      return
    }

    setError(null)
    setRateLimited(false)
    setBundleLink(null)
    setSubmitting(true)

    const owner = wallet.publicKey
    const stepLabels: BundleStep[] = []
    const updateStep = (i: number, patch: Partial<BundleStep>) => {
      stepLabels[i] = { ...stepLabels[i], ...patch }
      setSteps([...stepLabels])
    }

    try {
      // No Jito bundle cap to worry about (single-tx Helius Sender). Cap to
      // a sane batch size to keep one wallet popup manageable; positions
      // beyond this are picked up on the next withdraw.
      const MAX_WITHDRAW_TXS = 8
      const targetPositions = positions.slice(0, MAX_WITHDRAW_TXS)
      const truncated = positions.length > MAX_WITHDRAW_TXS

      stepLabels.push({
        label: `build ${targetPositions.length} withdraw tx${targetPositions.length === 1 ? '' : 's'}`,
        state: 'running',
      })
      setSteps([...stepLabels])

      // Per-position dispatch: HawkFi-owned (= userPda) → HawkFi withdraw,
      // direct-owned (= user wallet) → native Meteora SDK withdraw. The
      // resulting tx shape is the same (single tx with embedded tip) so
      // downstream sign/send/poll is uniform.
      const { buildDlmmWithdrawCloseTx } = await import('./lib/dlmm')
      const { buildHawkWithdrawCloseTx, classifyPositionOwnership } = await import('./lib/hawkfi-flows')
      const dlmmMod = await import('@meteora-ag/dlmm')
      const dlmmForPool = await dlmmMod.default.create(connection, new PublicKey(pool.poolAddress))
      const tokenXMint = dlmmForPool.tokenX.publicKey as PublicKey
      const tokenYMint = dlmmForPool.tokenY.publicKey as PublicKey
      const tokenXProgram = dlmmForPool.tokenX.owner as PublicKey
      const tokenYProgram = dlmmForPool.tokenY.owner as PublicKey
      let hawkCount = 0
      let directCount = 0
      const txs = await Promise.all(
        targetPositions.map(async (p) => {
          const cls = await classifyPositionOwnership(connection, new PublicKey(p.publicKey), owner)
          if (cls.kind === 'hawkfi') {
            hawkCount++
            return buildHawkWithdrawCloseTx(connection, owner, {
              pool: new PublicKey(pool.poolAddress),
              position: new PublicKey(p.publicKey),
              tokenXMint,
              tokenYMint,
              tokenXProgram,
              tokenYProgram,
              lowerBinId: p.lowerBinId,
              upperBinId: p.upperBinId,
            })
          }
          directCount++
          return buildDlmmWithdrawCloseTx(connection, owner, {
            pool: new PublicKey(pool.poolAddress),
            position: new PublicKey(p.publicKey),
            lowerBinId: p.lowerBinId,
            upperBinId: p.upperBinId,
          })
        }),
      )

      const totalTipSol =
        (txs.length * HELIUS_SENDER_TIP_LAMPORTS) / LAMPORTS_PER_SOL
      const ownership = `${hawkCount} hawkfi-owned + ${directCount} direct`
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${txs.length} position${txs.length === 1 ? '' : 's'} (${ownership})${truncated ? ` · ${positions.length - txs.length} more on next withdraw` : ''} · ${totalTipSol.toFixed(4)} SOL helius tips`,
      })

      stepLabels.push({ label: 'sign all transactions', state: 'running' })
      setSteps([...stepLabels])
      const signed = (await wallet.signAllTransactions(txs)) as VersionedTransaction[]
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${signed.length} txs signed`,
      })

      stepLabels.push({
        label: `send ${signed.length} withdraw${signed.length === 1 ? '' : 's'} via helius sender`,
        state: 'running',
      })
      setSteps([...stepLabels])
      const sigs = await Promise.all(signed.map((tx) => sendViaHeliusSender(tx)))
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: sigs.map((s) => s.slice(0, 8) + '…').join(' · '),
      })

      stepLabels.push({ label: 'waiting for inclusion', state: 'running' })
      setSteps([...stepLabels])
      const confirmed = await pollAllSigsConfirmed(connection, sigs, {
        commitment: 'confirmed',
        timeoutMs: 90_000,
      })
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${confirmed.length}/${sigs.length} confirmed`,
      })
      setBundleLink(sigs)
      setRefresh((n) => n + 1)
    } catch (e) {
      const msg = (e as Error).message
      setError(msg)
      stepLabels.forEach((s, i) => {
        if (s.state === 'running') {
          stepLabels[i] = { ...s, state: 'error', detail: msg }
        }
      })
      setSteps([...stepLabels])
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.04)] p-5 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-warn)]">
          withdraw + close
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--color-dim)] text-xl leading-none hover:text-[var(--color-fg)]"
        >
          ×
        </button>
      </div>

      <div className="text-[11px] text-[var(--color-dim)] leading-relaxed">
        Closes ALL of your positions on this pool: pulls remaining liquidity,
        claims accrued swap fees, and reclaims rent — all in one bundled
        signature. Built via the HawkFi SDK.
      </div>

      {!wallet.publicKey && (
        <div className="text-[12px] text-[var(--color-dim)]">connect wallet to load positions</div>
      )}
      {wallet.publicKey && positions == null && !loadErr && (
        <div className="text-[12px] text-[var(--color-dim)]">loading positions…</div>
      )}
      {loadErr && (
        <div className="text-[11px] text-[var(--color-warn)] font-mono break-all">
          load error: {loadErr}
        </div>
      )}
      {wallet.publicKey && positions && positions.length === 0 && (
        <div className="text-[12px] text-[var(--color-dim)]">
          no open positions on this pool
        </div>
      )}
      {positions && positions.length > 0 && (
        <ol className="m-0 p-0 list-none space-y-2">
          {positions.map((p) => {
            const { stacUi, otherUi } = formatPosition(p)
            return (
              <li
                key={p.publicKey}
                className="bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_204_0_/_0.2)] grid grid-cols-[1fr_auto] gap-3 items-center"
              >
                <div className="min-w-0">
                  <div className="text-[12px] font-mono text-[var(--color-fg)] truncate">
                    {p.publicKey.slice(0, 8)}…{p.publicKey.slice(-6)}
                  </div>
                  <div className="text-[10px] text-[var(--color-dim)] mt-0.5">
                    bins {p.lowerBinId}…{p.upperBinId}
                  </div>
                </div>
                <div className="text-right text-[11px]">
                  <div className="font-mono text-[var(--color-fg)]">
                    {stacUi.toFixed(4)} stacSOL
                  </div>
                  <div className="font-mono text-[var(--color-dim)]">
                    {otherUi.toLocaleString(undefined, {
                      maximumFractionDigits: 6,
                    })}{' '}
                    {otherSymbol}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {positions && positions.length > 4 && (
        <div className="text-[10px] text-[var(--color-warn)]">
          you have {positions.length} positions — Jito bundle caps at 4 withdraws
          per click. Tap submit again after this lands to handle the rest.
        </div>
      )}

      <label className="flex items-start gap-2 text-[12px] text-[var(--color-fg)] cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1"
        />
        <span>
          I understand: positions are closed, not partially withdrawn. Token
          composition you receive depends on where price has moved relative to
          your range while open.
        </span>
      </label>

      <button
        type="button"
        onClick={onSubmit}
        disabled={
          submitting ||
          !agreed ||
          !wallet.publicKey ||
          !positions ||
          positions.length === 0
        }
        className="w-full py-3 bg-[var(--color-warn)] text-black font-black uppercase tracking-[3px] text-xs rounded disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
      >
        {submitting
          ? 'working…'
          : rateLimited
          ? 'tap again — jito throttled'
          : `withdraw + close ${Math.min(positions?.length ?? 0, 4)} position${(positions?.length ?? 0) === 1 ? '' : 's'}`}
      </button>

      {steps.length > 0 && <StepList steps={steps} />}
      {bundleLink && <BundleResult txIds={bundleLink} />}
      {error && (
        <div className={`text-[11px] font-mono break-all ${rateLimited ? 'text-[var(--color-ember)]' : 'text-[var(--color-warn)]'}`}>
          {rateLimited ? '⏳' : 'error:'} {error}
        </div>
      )}
    </div>
  )
}

/* =============================== shared =============================== */

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`py-2 text-[10px] font-black uppercase tracking-wider rounded border transition ${
        active
          ? 'bg-[var(--color-hot)] text-black border-[var(--color-hot)]'
          : 'text-[var(--color-fg)] border-[rgb(255_34_0_/_0.25)] hover:bg-[rgb(255_34_0_/_0.06)]'
      }`}
    >
      {children}
    </button>
  )
}

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
        ✓ position placed
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
