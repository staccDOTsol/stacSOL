// stacSOL liquidity page — one-stop add/remove for the five Raydium CPMM
// pools that hold stacSOL.
//
// IMPORTANT: Adding liquidity to any AMM exposes the LP to impermanent loss.
// We disclaim this prominently before any deposit can be initiated.

import { useEffect, useMemo, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import { LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'
import {
  HELIUS_SENDER_TIP_LAMPORTS,
  SOL_MINT,
  buildStacsolBurnTx,
  buildStacsolMintTx,
  getJupiterSwapTx,
  jupiterQuote,
  lamportsForStacsolMint,
  pickHeliusTipAccount,
  pollConfirmTransaction,
  sendViaHeliusSender,
  solscanTx,
} from './lib/zap'
import { fetchPool } from './lib/pool'
import { useReferrer } from './lib/referrer'

interface RayPool {
  type: string
  programId: string
  id: string
  mintA: { address: string; symbol: string; decimals: number; programId: string }
  mintB: { address: string; symbol: string; decimals: number; programId: string }
  price: number
  mintAmountA: number
  mintAmountB: number
  feeRate: number
  tvl: number
  lpMint: { address: string; decimals: number; programId: string }
  lpAmount: number
  lpPrice: number
  day: { volume: number; volumeFee: number; apr: number }
  week: { volume: number; apr: number }
  month: { volume: number; apr: number }
}

const STACSOL_MINT = '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f'
const WSOL_MINT = 'So11111111111111111111111111111111111111112'

export default function Liquidity() {
  useEffect(() => {
    const prev = document.title
    document.title = 'stacSOL liquidity'
    return () => {
      document.title = prev
    }
  }, [])

  const [pools, setPools] = useState<RayPool[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const fetchOnce = async () => {
      try {
        const r = await fetch('/api/liquidity-pools')
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
    fetchOnce()
    const id = setInterval(fetchOnce, 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  // Sort: stacSOL pairs first (most relevant), highest TVL first within group.
  const sortedPools = useMemo(() => {
    const containsStac = (p: RayPool) =>
      p.mintA.address === STACSOL_MINT || p.mintB.address === STACSOL_MINT
    return [...pools]
      .filter(containsStac)
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
  }, [pools])

  return (
    <div className="min-h-screen text-[var(--color-fg)]">
      <Nav />
      <Hero />
      <ILDisclaimer />
      <section className="max-w-[1080px] mx-auto px-6 py-8">
        {error && (
          <p className="text-[var(--color-warn)] text-[12px] mb-4">
            error loading pools: {error}
          </p>
        )}
        {loading && pools.length === 0 && (
          <p className="text-[var(--color-dim)] text-[12px]">loading pools…</p>
        )}
        <div className="space-y-5">
          {sortedPools.map((p) => (
            <PoolCard key={p.id} pool={p} />
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
            liquidity
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
        Provide{' '}
        <span className="text-[var(--color-hot)] [text-shadow:0_0_24px_rgba(255,34,0,0.5)]">
          liquidity.
        </span>
      </h1>
      <p className="mt-6 max-w-[640px] mx-auto text-[14px] leading-relaxed text-[var(--color-dim)]">
        One-stop add/remove for the five Raydium CPMM pools that hold stacSOL.
        Stats refresh every 30 seconds. Connect wallet to see your existing
        LP positions.
      </p>
    </section>
  )
}

function ILDisclaimer() {
  return (
    <section className="max-w-[1080px] mx-auto px-6 pb-4 space-y-4">
      <div className="rounded-lg border-2 border-[var(--color-green)] bg-[rgb(34_238_136_/_0.05)] p-5">
        <div className="flex items-start gap-3">
          <span className="text-[var(--color-green)] text-2xl leading-none">↑</span>
          <div>
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-green)]">
              Yield keeps accruing while LP&apos;d
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg)]">
              Every stacSOL you mint is backed by the same NAV — whether it&apos;s
              sitting in your wallet, in a Raydium pool, or in a Meteora DLMM
              position. The redemption rate climbs against the full supply, so
              you don&apos;t lose protocol yield by becoming an LP. Burn fees still
              accumulate to your token. The LP earns swap fees on top.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg)]">
              The trade-off: LP&apos;d stacSOL can&apos;t be burned directly — withdraw
              from the pool first via{' '}
              <a href="/portfolio" className="text-[var(--color-hot)]">/portfolio</a>{' '}
              (DLMM) or the &quot;remove&quot; tab below (CPMM), then burn from your
              wallet.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-lg border-2 border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.05)] p-5">
        <div className="flex items-start gap-3">
          <span className="text-[var(--color-warn)] text-2xl leading-none">⚠</span>
          <div>
            <div className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-warn)]">
              Impermanent loss risk — read this
            </div>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg)]">
              Adding liquidity to any AMM means you receive LP tokens that
              represent a share of <em>both</em> sides of the pool. When the
              relative price between the two tokens changes, the value of your
              LP position can be lower than if you&apos;d simply held the two
              tokens separately. This is{' '}
              <span className="font-black text-[var(--color-warn)]">
                impermanent loss
              </span>
              .
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg)]">
              Most of these pools are paired against thinly-traded tokens
              (Staccana, FOMOX402, PROOFV3) — IL on those can be{' '}
              <span className="font-black text-[var(--color-hot)]">severe</span>{' '}
              and is not theoretical. Fees earned on volume may or may not
              compensate. Pool prices can also detach from NAV (see{' '}
              <a href="/guide" className="text-[var(--color-hot)]">the guide</a>).
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg)]">
              Worst case: if the paired token rugs or trades to{' '}
              <span className="font-black text-[var(--color-hot)]">zero</span>,
              that LP position is fcukered — your share of the pool becomes
              effectively all of the worthless side. The stacSOL inside it is
              gone (sold off via arbitrage as the price collapsed). NAV
              accrual on the broader pool can&apos;t save a single LP from a
              dead-token pair. We don&apos;t expect this for the tokens
              currently listed, but plan for it.
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-fg)] font-black">
              Do not LP money you can&apos;t afford to lose. This is not financial advice.
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
      pools via raydium · stats via api-v3.raydium.io · refreshes every 30s
    </footer>
  )
}

/* ------------------------- pool card ------------------------- */

function PoolCard({ pool }: { pool: RayPool }) {
  const [open, setOpen] = useState<'add' | 'remove' | null>(null)
  const isSolPair =
    pool.mintA.address === WSOL_MINT || pool.mintB.address === WSOL_MINT
  const isStacBaseA = pool.mintA.address === STACSOL_MINT

  // Display price as SOL/quote-pertinent unit. For SOL-pair, invert if needed.
  const priceLabel = (() => {
    if (isSolPair) {
      const solPerStac = isStacBaseA ? pool.price : pool.price > 0 ? 1 / pool.price : null
      return solPerStac != null
        ? `${solPerStac.toFixed(6)} SOL / stacSOL`
        : '—'
    }
    return `${pool.price.toFixed(6)} ${pool.mintB.symbol} / ${pool.mintA.symbol}`
  })()

  return (
    <article className="rounded-lg bg-[var(--color-bg2)] border border-[rgb(255_34_0_/_0.22)]">
      <header className="p-5 border-b border-[rgb(255_34_0_/_0.12)] grid grid-cols-[1fr_auto] gap-4 items-center">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black uppercase tracking-[2px] px-2 py-0.5 rounded border border-[rgb(255_34_0_/_0.35)] bg-[rgb(255_34_0_/_0.06)] text-[var(--color-hot)]">
              raydium cp
            </span>
            <h2 className="m-0 text-lg font-black text-[var(--color-fg)]">
              {pool.mintA.symbol} / {pool.mintB.symbol}
            </h2>
          </div>
          <div className="mt-1 text-[11px] text-[var(--color-dim)] font-mono">
            {pool.id.slice(0, 8)}…{pool.id.slice(-6)} · {priceLabel}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOpen(open === 'add' ? null : 'add')}
            className={`px-4 py-2 text-[10px] font-black uppercase tracking-[2px] rounded border transition ${
              open === 'add'
                ? 'bg-[var(--color-hot)] text-black border-[var(--color-hot)]'
                : 'text-[var(--color-hot)] border-[var(--color-hot)] hover:bg-[rgb(255_34_0_/_0.1)]'
            }`}
          >
            add
          </button>
          <button
            type="button"
            onClick={() => setOpen(open === 'remove' ? null : 'remove')}
            className={`px-4 py-2 text-[10px] font-black uppercase tracking-[2px] rounded border transition ${
              open === 'remove'
                ? 'bg-[var(--color-warn)] text-black border-[var(--color-warn)]'
                : 'text-[var(--color-warn)] border-[var(--color-warn)] hover:bg-[rgb(255_204_0_/_0.1)]'
            }`}
          >
            remove
          </button>
        </div>
      </header>

      <div className="p-5 grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="TVL" value={`$${fmtNum(pool.tvl)}`} />
        <Stat label="day APR" value={`${fmtNum(pool.day.apr)}%`} />
        <Stat label="day vol" value={`$${fmtNum(pool.day.volume)}`} />
        <Stat label="fee" value={`${(pool.feeRate * 100).toFixed(2)}%`} />
      </div>

      <div className="px-5 pb-5 grid grid-cols-2 gap-3">
        <SubStat
          label={`${pool.mintA.symbol} in pool`}
          value={fmtNum(pool.mintAmountA)}
        />
        <SubStat
          label={`${pool.mintB.symbol} in pool`}
          value={fmtNum(pool.mintAmountB)}
        />
      </div>

      {open === 'add' && <AddPanel pool={pool} onClose={() => setOpen(null)} />}
      {open === 'remove' && (
        <RemovePanel pool={pool} onClose={() => setOpen(null)} />
      )}
    </article>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)]">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
        {label}
      </div>
      <div className="tabular-mono text-base font-black text-[var(--color-fg)] mt-0.5">
        {value}
      </div>
    </div>
  )
}

function SubStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-[11px] text-[var(--color-dim)]">
      <span className="uppercase tracking-wider">{label}: </span>
      <span className="text-[var(--color-fg)] font-mono">{value}</span>
    </div>
  )
}

/* ------------------------- add panel ------------------------- */
//
// One-click zap-in. User enters a SOL total. We:
//   1. Compute target deposit amounts of A and B (50/50 SOL value)
//   2. Read user's current balances of A and B
//   3. Conditionally Jupiter-swap SOL → A and/or SOL → B for any shortfall
//   4. Build Raydium addLiquidity tx with embedded Jito tip
//   5. signAllTransactions in one popup
//   6. Submit as a Jito bundle — atomic, MEV-protected

interface BundleStep {
  label: string
  state: 'pending' | 'running' | 'done' | 'error'
  detail?: string
}

async function getTokenBalanceAtomic(
  connection: import('@solana/web3.js').Connection,
  owner: PublicKey,
  mint: string,
  programId: string,
): Promise<bigint> {
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(mint),
      owner,
      false,
      new PublicKey(programId),
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    const acc = await connection.getAccountInfo(ata)
    if (!acc) return 0n
    return acc.data.readBigUInt64LE(64)
  } catch {
    return 0n
  }
}

function AddPanel({ pool, onClose }: { pool: RayPool; onClose: () => void }) {
  const { connection } = useConnection()
  const wallet = useWallet()
  // Pull the active referrer (marketing default OR `?ref=` override) so the
  // stake-pool DepositSol calls inside the zap route the 50% deposit-fee
  // share into the right ATA.
  const ref = useReferrer()
  // User picks WHICH token to specify. Amount entered is in that token's
  // UI units. Matching other side computed at current pool ratio. We only
  // swap from SOL if either side comes up short.
  const [chosenSide, setChosenSide] = useState<'A' | 'B'>('A')
  const [tokenAmount, setTokenAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [steps, setSteps] = useState<BundleStep[]>([])
  const [bundleLink, setBundleLink] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)

  const isAWsol = pool.mintA.address === SOL_MINT
  const isBWsol = pool.mintB.address === SOL_MINT
  const inputNum = parseFloat(tokenAmount)
  const chosenSym = chosenSide === 'A' ? pool.mintA.symbol : pool.mintB.symbol
  const otherSym = chosenSide === 'A' ? pool.mintB.symbol : pool.mintA.symbol
  // Pool price is mintB per mintA (UI units, both sides scaled to atomic-aware).
  // Raydium API's `price` field IS UI mintB per UI mintA at current ratio.
  const otherPerChosen = chosenSide === 'A'
    ? pool.price
    : pool.price > 0 ? 1 / pool.price : 0
  const matchingOther = isFinite(inputNum) && inputNum > 0
    ? inputNum * otherPerChosen
    : 0

  // Live balances: native SOL + each side of the pool (if not WSOL).
  // Refresh whenever wallet connects/changes or after a successful zap.
  const [solBalance, setSolBalance] = useState<bigint | null>(null)
  const [aBalance, setABalance] = useState<bigint | null>(null)
  const [bBalance, setBBalance] = useState<bigint | null>(null)
  const [balRefresh, setBalRefresh] = useState(0)
  useEffect(() => {
    if (!wallet.publicKey) {
      setSolBalance(null)
      setABalance(null)
      setBBalance(null)
      return
    }
    let cancelled = false
    const owner = wallet.publicKey
    ;(async () => {
      try {
        const [sol, a, b] = await Promise.all([
          connection.getBalance(owner).then(BigInt),
          isAWsol
            ? Promise.resolve(0n)
            : getTokenBalanceAtomic(connection, owner, pool.mintA.address, pool.mintA.programId),
          isBWsol
            ? Promise.resolve(0n)
            : getTokenBalanceAtomic(connection, owner, pool.mintB.address, pool.mintB.programId),
        ])
        if (cancelled) return
        setSolBalance(sol)
        setABalance(a)
        setBBalance(b)
      } catch {
        if (!cancelled) {
          setSolBalance(null)
          setABalance(null)
          setBBalance(null)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    wallet.publicKey,
    connection,
    isAWsol,
    isBWsol,
    pool.mintA.address,
    pool.mintA.programId,
    pool.mintB.address,
    pool.mintB.programId,
    balRefresh,
  ])

  const onSubmit = async () => {
    if (!wallet.publicKey || !wallet.signAllTransactions) {
      setError('connect wallet first')
      return
    }
    if (!agreed) {
      setError('check the IL acknowledgment first')
      return
    }
    if (!inputNum || inputNum <= 0) {
      setError(`enter a ${chosenSym} amount`)
      return
    }

    setError(null)
    setBundleLink(null)
    setSubmitting(true)

    const owner = wallet.publicKey
    const stepLabels: BundleStep[] = [
      { label: 'check balances', state: 'running' },
    ]
    setSteps(stepLabels)
    const updateStep = (i: number, patch: Partial<BundleStep>) => {
      stepLabels[i] = { ...stepLabels[i], ...patch }
      setSteps([...stepLabels])
    }

    try {
      // --- 1. Read user balances + compute targets in atomic units ---
      // Chosen side target = the amount user typed. Other side target =
      // matching amount at current pool ratio. We do NOT pre-buffer the
      // requirement check against held balances — if the user has enough
      // of the other side, we use it as-is. The 30% headroom is applied
      // ONLY to the swap input (Jupiter ExactIn lamports), since slippage
      // + Token-2022 withholding only matters when we're acquiring tokens.
      // Previously this buffer also gated the haveB ≥ bTarget check, which
      // forced Jupiter swaps even when the user had enough B to deposit
      // directly. Result: "I clicked max but only half deployed" — the
      // matching B got swapped from the user's SOL even though their B
      // wallet balance was sufficient.
      const aTargetUi = chosenSide === 'A' ? inputNum : matchingOther
      const bTargetUi = chosenSide === 'A' ? matchingOther : inputNum
      const aTargetAtom = BigInt(
        Math.floor(aTargetUi * Math.pow(10, pool.mintA.decimals)),
      )
      const bTargetAtom = BigInt(
        Math.floor(bTargetUi * Math.pow(10, pool.mintB.decimals)),
      )

      const haveA = isAWsol
        ? BigInt(await connection.getBalance(owner))
        : await getTokenBalanceAtomic(connection, owner, pool.mintA.address, pool.mintA.programId)
      const haveB = isBWsol
        ? BigInt(await connection.getBalance(owner))
        : await getTokenBalanceAtomic(connection, owner, pool.mintB.address, pool.mintB.programId)

      const haveAUi = Number(haveA) / Math.pow(10, pool.mintA.decimals)
      const haveBUi = Number(haveB) / Math.pow(10, pool.mintB.decimals)
      updateStep(0, {
        state: 'done',
        detail: `you have ${haveAUi.toFixed(6)} ${pool.mintA.symbol}, ${haveBUi.toFixed(6)} ${pool.mintB.symbol}`,
      })

      // --- 2. Compute shortfalls (in atomic) ---
      // Compare against the unbuffered target. If we DO need to swap, we
      // still over-acquire by 30% on the swap input below to absorb price
      // movement / transfer-fee withholding. Whatever lands above the
      // target stays in the user's wallet — Raydium doesn't deposit it.
      const shortfallA = haveA >= aTargetAtom ? 0n : aTargetAtom - haveA
      const shortfallB = haveB >= bTargetAtom ? 0n : bTargetAtom - haveB
      const needsSwapA = shortfallA > 0n && !isAWsol
      const needsSwapB = shortfallB > 0n && !isBWsol
      // If chosen side is WSOL and short, fail — we don't auto-swap from
      // anywhere into SOL itself.
      if (shortfallA > 0n && isAWsol) {
        throw new Error(
          `you only have ${haveAUi.toFixed(6)} SOL but need ${(Number(aTargetAtom) / 1e9).toFixed(6)}`,
        )
      }
      if (shortfallB > 0n && isBWsol) {
        throw new Error(
          `you only have ${haveBUi.toFixed(6)} SOL but need ${(Number(bTargetAtom) / 1e9).toFixed(6)}`,
        )
      }

      // Match against stacSOL mint to decide between native DepositSol and
      // Jupiter swap. Jupiter's SOL → stacSOL route locks vote-account-adjacent
      // accounts (Sanctum router) and Jito refuses to bundle that. Our own
      // DepositSol ix is bundle-safe and avoids the 6.9% transfer fee.
      const isAStacsol = pool.mintA.address === STACSOL_MINT
      const isBStacsol = pool.mintB.address === STACSOL_MINT

      // --- 3. Get SOL prices for any side that needs a Jupiter swap ---
      // Skip Jupiter quotes for stacSOL (we mint natively) and for sides we
      // already have enough of.
      let priceA_sol_per_atom = 0
      let priceB_sol_per_atom = 0
      const aNeedsJupQuote = needsSwapA && !isAStacsol
      const bNeedsJupQuote = needsSwapB && !isBStacsol
      if (aNeedsJupQuote || bNeedsJupQuote) {
        stepLabels.push({ label: 'price tokens for swap', state: 'running' })
        setSteps([...stepLabels])
        const onesol = BigInt(LAMPORTS_PER_SOL)
        if (aNeedsJupQuote) {
          const q = await jupiterQuote({
            inputMint: SOL_MINT,
            outputMint: pool.mintA.address,
            amount: onesol,
            swapMode: 'ExactIn',
            slippageBps: 5000,
          })
          const outAtom = Number(q.outAmount)
          if (outAtom <= 0) throw new Error(`no jupiter route SOL → ${pool.mintA.symbol}`)
          priceA_sol_per_atom = 1 / outAtom
        }
        if (bNeedsJupQuote) {
          const q = await jupiterQuote({
            inputMint: SOL_MINT,
            outputMint: pool.mintB.address,
            amount: onesol,
            swapMode: 'ExactIn',
            slippageBps: 5000,
          })
          const outAtom = Number(q.outAmount)
          if (outAtom <= 0) throw new Error(`no jupiter route SOL → ${pool.mintB.symbol}`)
          priceB_sol_per_atom = 1 / outAtom
        }
        updateStep(stepLabels.length - 1, { state: 'done', detail: 'prices ok' })
      }

      // Each stage (optional swap A, optional swap B, addLiquidity) is its
      // own tx. We sign them all in one wallet popup, then send sequentially
      // via Helius Sender — addLiquidity can't run until swap balances have
      // landed. Each tx must carry its own Helius tip ix; we append one to
      // every preceding tx via appendIxToV0Tx, and let the Raydium SDK put
      // a tip-shaped transfer (to a Helius tip account) directly into the
      // addLiquidity tx via txTipConfig.
      const { appendIxToV0Tx, heliusTipIx } = await import('./lib/zap')
      const txs: VersionedTransaction[] = []

      // --- 4. Optional Jupiter swap (or native mint for stacSOL) for side A ---
      if (needsSwapA) {
        stepLabels.push({ label: `top up ${pool.mintA.symbol} from SOL`, state: 'running' })
        setSteps([...stepLabels])
        if (isAStacsol) {
          // Native DepositSol path — bundle-safe, no 6.9% fee on the output.
          // Buffer 3000bps (30%) covers Token-2022 6.9% transfer fee +
          // Raydium 50% slippage tolerance + pool ratio drift.
          const stakePool = await fetchPool(connection)
          const lamportsForA = lamportsForStacsolMint(
            shortfallA,
            stakePool.poolTotalLamports,
            stakePool.poolTokenSupplyAccounting,
            3000,
          )
          const txRaw = await buildStacsolMintTx(connection, owner, lamportsForA, ref.referrer)
          const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
          txs.push(tx)
          updateStep(stepLabels.length - 1, {
            state: 'done',
            detail: `native DepositSol — ~${(Number(lamportsForA) / LAMPORTS_PER_SOL).toFixed(6)} SOL → ~${(Number(shortfallA) / Math.pow(10, pool.mintA.decimals)).toFixed(6)} stacSOL (no 6.9% fee)`,
          })
        } else {
          // 30% buffer on swap input — slippageBps is 5000 (50%) so we
          // need real headroom to ensure outAmount ≥ shortfall even when
          // the route fills near the worst-case slippage. Excess tokens
          // received above the deposit target stay in the user's wallet
          // (Raydium only consumes `inputAmount` worth on each side).
          const lamportsForA = BigInt(
            Math.ceil(Number(shortfallA) * priceA_sol_per_atom * LAMPORTS_PER_SOL * 1.3),
          )
          const q = await jupiterQuote({
            inputMint: SOL_MINT,
            outputMint: pool.mintA.address,
            amount: lamportsForA,
            swapMode: 'ExactIn',
            slippageBps: 5000,
          })
          const txRaw = await getJupiterSwapTx({
            quote: q,
            userPublicKey: owner,
            prioritizationFeeLamports: 'auto',
          })
          const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
          txs.push(tx)
          updateStep(stepLabels.length - 1, {
            state: 'done',
            detail: `~${(Number(lamportsForA) / LAMPORTS_PER_SOL).toFixed(6)} SOL → ~${(Number(q.outAmount) / Math.pow(10, pool.mintA.decimals)).toFixed(6)} ${pool.mintA.symbol} (you were short ${(Number(shortfallA) / Math.pow(10, pool.mintA.decimals)).toFixed(6)})`,
          })
        }
      } else {
        stepLabels.push({
          label: `${pool.mintA.symbol} sufficient`,
          state: 'done',
          detail: `using your ${haveAUi.toFixed(6)} ${pool.mintA.symbol}, no swap`,
        })
        setSteps([...stepLabels])
      }

      // --- 5. Optional Jupiter swap (or native mint for stacSOL) for side B ---
      if (needsSwapB) {
        stepLabels.push({ label: `top up ${pool.mintB.symbol} from SOL`, state: 'running' })
        setSteps([...stepLabels])
        if (isBStacsol) {
          // 3000bps (30%) buffer — comfortably covers Token-2022 6.9% fee +
          // Raydium's now-50% slippage tolerance + pool ratio drift.
          const stakePool = await fetchPool(connection)
          const lamportsForB = lamportsForStacsolMint(
            shortfallB,
            stakePool.poolTotalLamports,
            stakePool.poolTokenSupplyAccounting,
            3000,
          )
          const txRaw = await buildStacsolMintTx(connection, owner, lamportsForB, ref.referrer)
          const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
          txs.push(tx)
          updateStep(stepLabels.length - 1, {
            state: 'done',
            detail: `native DepositSol — ~${(Number(lamportsForB) / LAMPORTS_PER_SOL).toFixed(6)} SOL → ~${(Number(shortfallB) / Math.pow(10, pool.mintB.decimals)).toFixed(6)} stacSOL (no 6.9% fee)`,
          })
        } else {
          // Same 30% headroom rationale as the A-side path above.
          const lamportsForB = BigInt(
            Math.ceil(Number(shortfallB) * priceB_sol_per_atom * LAMPORTS_PER_SOL * 1.3),
          )
          const q = await jupiterQuote({
            inputMint: SOL_MINT,
            outputMint: pool.mintB.address,
            amount: lamportsForB,
            swapMode: 'ExactIn',
            slippageBps: 5000,
          })
          const txRaw = await getJupiterSwapTx({
            quote: q,
            userPublicKey: owner,
            prioritizationFeeLamports: 'auto',
          })
          const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
          txs.push(tx)
          updateStep(stepLabels.length - 1, {
            state: 'done',
            detail: `~${(Number(lamportsForB) / LAMPORTS_PER_SOL).toFixed(6)} SOL → ~${(Number(q.outAmount) / Math.pow(10, pool.mintB.decimals)).toFixed(6)} ${pool.mintB.symbol} (you were short ${(Number(shortfallB) / Math.pow(10, pool.mintB.decimals)).toFixed(6)})`,
          })
        }
      } else {
        stepLabels.push({
          label: `${pool.mintB.symbol} sufficient`,
          state: 'done',
          detail: `using your ${haveBUi.toFixed(6)} ${pool.mintB.symbol}, no swap`,
        })
        setSteps([...stepLabels])
      }

      // --- 6. Build Raydium addLiquidity tx with Jito tip baked in ---
      // Use the user's chosen side as the base. baseIn=true means input is in
      // mintA terms; we set it based on `side`.
      stepLabels.push({ label: 'build add-liquidity', state: 'running' })
      setSteps([...stepLabels])
      const { Raydium, TxVersion, Percent } = await import('@raydium-io/raydium-sdk-v2')
      const raydium = await Raydium.load({
        connection,
        owner,
        signAllTransactions: wallet.signAllTransactions,
        cluster: 'mainnet',
        disableFeatureCheck: true,
        blockhashCommitment: 'confirmed',
      })
      const poolKeysData = await raydium.api.fetchPoolKeysById({ idList: [pool.id] })
      const poolKeys = poolKeysData[0]
      const poolInfoData = await raydium.api.fetchPoolById({ ids: pool.id })
      const poolInfo = poolInfoData[0]
      if (!poolKeys || !poolInfo) throw new Error('could not fetch pool data')

      const baseAmount = chosenSide === 'A' ? aTargetAtom : bTargetAtom
      const addResult = await raydium.cpmm.addLiquidity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        poolInfo: poolInfo as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        poolKeys: poolKeys as any,
        inputAmount: new BN(baseAmount.toString()),
        baseIn: chosenSide === 'A',
        slippage: new Percent(50, 100),
        txVersion: TxVersion.V0,
        // Raydium SDK injects a SystemProgram.transfer tip ix into the tx
        // for the chosen address — point it at a Helius tip account
        // (Sender accepts the same shape; it doesn't care WHERE the tip
        // goes, only that there's a transfer to one of its tip accounts).
        txTipConfig: {
          address: pickHeliusTipAccount(),
          amount: new BN(HELIUS_SENDER_TIP_LAMPORTS),
        },
      })
      txs.push(addResult.transaction)
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${inputNum.toFixed(6)} ${chosenSym} + ~${matchingOther.toFixed(6)} ${otherSym}, tip ${(HELIUS_SENDER_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      })

      // --- 8. Sign all in one wallet popup ---
      stepLabels.push({ label: 'sign all transactions', state: 'running' })
      setSteps([...stepLabels])
      const signed = (await wallet.signAllTransactions(txs)) as VersionedTransaction[]
      updateStep(stepLabels.length - 1, { state: 'done', detail: `${signed.length} txs signed` })

      // --- 9. Send each tx via Helius Sender, sequentially ---
      // Sequential (NOT parallel) because addLiquidity needs the swap
      // balances on chain first. We send tx N, wait for confirmed, then
      // send tx N+1.
      const sigs: string[] = []
      for (let i = 0; i < signed.length; i++) {
        const isLast = i === signed.length - 1
        const label = isLast
          ? 'send addLiquidity via helius sender'
          : `send tx ${i + 1}/${signed.length} via helius sender`
        stepLabels.push({ label, state: 'running' })
        setSteps([...stepLabels])
        const sig = await sendViaHeliusSender(signed[i])
        sigs.push(sig)
        updateStep(stepLabels.length - 1, {
          state: 'running',
          detail: `${sig.slice(0, 8)}… waiting for confirmation`,
        })
        await pollConfirmTransaction(connection, sig, {
          commitment: 'confirmed',
          timeoutMs: 75_000,
        })
        updateStep(stepLabels.length - 1, {
          state: 'done',
          detail: `confirmed ${sig.slice(0, 8)}…`,
        })
      }

      setBundleLink(sigs)
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

  return (
    <div className="border-t border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.04)] p-5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)]">
          add liquidity (one-click zap)
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
        Pick a side and enter how much of <em>that</em> token to deposit. The
        matching amount of the other side is computed at the current pool
        ratio.{' '}
        <span className="text-[var(--color-green)]">max balanced</span> uses
        BOTH wallet balances — capped where one runs out — so nothing gets
        swapped or left over.{' '}
        <span className="text-[var(--color-hot)]">max {`<token>`}</span>{' '}
        consumes all of one side and tops up the other from your SOL. All txs
        sign at once and stream through Helius Sender (tip:{' '}
        <span className="text-[var(--color-fg)]">
          {(HELIUS_SENDER_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6)} SOL/tx
        </span>
        ).
      </div>

      {/* Side picker */}
      <div className="grid grid-cols-2 gap-2">
        {(['A', 'B'] as const).map((s) => {
          const sym = s === 'A' ? pool.mintA.symbol : pool.mintB.symbol
          const active = chosenSide === s
          return (
            <button
              key={s}
              type="button"
              onClick={() => setChosenSide(s)}
              className={`py-2 text-[11px] font-black uppercase tracking-[2px] rounded border transition ${
                active
                  ? 'bg-[var(--color-hot)] text-black border-[var(--color-hot)]'
                  : 'text-[var(--color-fg)] border-[rgb(255_34_0_/_0.25)] hover:bg-[rgb(255_34_0_/_0.06)]'
              }`}
            >
              deposit {sym}
            </button>
          )
        })}
      </div>

      {/* Live balances — show user what they have before committing.
          If they already have one or both sides, the zap skips that swap. */}
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <BalanceTile
          label="SOL"
          value={solBalance != null ? Number(solBalance) / LAMPORTS_PER_SOL : null}
          decimals={4}
          tone="hot"
        />
        <BalanceTile
          label={pool.mintA.symbol}
          value={
            isAWsol
              ? solBalance != null
                ? Number(solBalance) / LAMPORTS_PER_SOL
                : null
              : aBalance != null
              ? Number(aBalance) / Math.pow(10, pool.mintA.decimals)
              : null
          }
          decimals={4}
          tone="dim"
        />
        <BalanceTile
          label={pool.mintB.symbol}
          value={
            isBWsol
              ? solBalance != null
                ? Number(solBalance) / LAMPORTS_PER_SOL
                : null
              : bBalance != null
              ? Number(bBalance) / Math.pow(10, pool.mintB.decimals)
              : null
          }
          decimals={4}
          tone="dim"
        />
      </div>

      <div>
        <label className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] flex items-center justify-between">
          <span>{chosenSym} amount to deposit</span>
          {(() => {
            // Two max buttons when sensible:
            //   • "max balanced"  → use BOTH wallet balances at current pool
            //                       ratio, capped at whichever side runs out
            //                       first. No SOL→token swap, no leftover.
            //   • "max <chosen>"  → consume ALL of the chosen side, top up the
            //                       other side from SOL via Jupiter (or native
            //                       DepositSol for stacSOL). Useful when the
            //                       user wants directional exposure beyond
            //                       what they currently hold.
            const isChosenWsol =
              chosenSide === 'A' ? isAWsol : isBWsol
            const isOtherWsol =
              chosenSide === 'A' ? isBWsol : isAWsol
            const decimals =
              chosenSide === 'A' ? pool.mintA.decimals : pool.mintB.decimals

            // Effective UI balance for each side, treating WSOL as native SOL.
            const tipReserveLamports = HELIUS_SENDER_TIP_LAMPORTS * 3 + 5_000_000
            const chosenBalUi: number | null = (() => {
              if (isChosenWsol) {
                if (solBalance == null) return null
                const safe = solBalance > BigInt(tipReserveLamports)
                  ? solBalance - BigInt(tipReserveLamports)
                  : 0n
                return Number(safe) / LAMPORTS_PER_SOL
              }
              const bal = chosenSide === 'A' ? aBalance : bBalance
              if (bal == null) return null
              return Number(bal) / Math.pow(10, decimals)
            })()
            const otherBalUi: number | null = (() => {
              if (isOtherWsol) {
                if (solBalance == null) return null
                const safe = solBalance > BigInt(tipReserveLamports)
                  ? solBalance - BigInt(tipReserveLamports)
                  : 0n
                return Number(safe) / LAMPORTS_PER_SOL
              }
              const bal = chosenSide === 'A' ? bBalance : aBalance
              if (bal == null) return null
              const otherDec = chosenSide === 'A' ? pool.mintB.decimals : pool.mintA.decimals
              return Number(bal) / Math.pow(10, otherDec)
            })()

            const hasBoth =
              chosenBalUi != null && otherBalUi != null &&
              chosenBalUi > 0 && otherBalUi > 0 &&
              otherPerChosen > 0

            const balancedMax = hasBoth
              ? Math.min(chosenBalUi!, otherBalUi! / otherPerChosen)
              : 0

            // 6dp ceiling matches the rest of the site; wSOL's 9 native
            // decimals are still clamped to 6 (was 4) so the "max balanced"
            // helper button stops dropping precision on small balances.
            const fmt = (n: number) =>
              n.toFixed(Math.min(6, decimals))

            return (
              <span className="flex items-center gap-3">
                {hasBoth && balancedMax > 0 && (
                  <button
                    type="button"
                    onClick={() => setTokenAmount(fmt(balancedMax))}
                    title={`Use both wallet balances at the current pool ratio (${chosenBalUi!.toFixed(6)} ${chosenSym} + ${otherBalUi!.toFixed(6)} ${otherSym}, capped where one runs out). No SOL → token swap.`}
                    className="text-[10px] uppercase tracking-wider text-[var(--color-green)] hover:brightness-125 font-black"
                  >
                    max balanced
                  </button>
                )}
                {chosenBalUi != null && chosenBalUi > 0 && (
                  <button
                    type="button"
                    onClick={() => setTokenAmount(fmt(chosenBalUi!))}
                    title={`Consume ALL of your ${chosenSym}. The other side is topped up from your SOL via Jupiter (or native DepositSol for stacSOL).`}
                    className="text-[10px] uppercase tracking-wider text-[var(--color-hot)] hover:text-[var(--color-ember)] font-black"
                  >
                    max {chosenSym.toLowerCase()}
                  </button>
                )}
              </span>
            )
          })()}
        </label>
        <input
          type="number"
          step="any"
          min="0"
          placeholder="0.0"
          className="w-full mt-1 px-3 py-2 bg-[var(--color-bg)] border border-[rgb(255_34_0_/_0.25)] rounded text-[var(--color-fg)] font-mono text-base focus:outline-none focus:border-[var(--color-hot)]"
          value={tokenAmount}
          onChange={(e) => setTokenAmount(e.target.value)}
        />
        {/* Coverage preview — show user up-front whether they have enough of
            each side or if a SOL → side swap is needed. Mirrors what onSubmit
            does, but visible before clicking. */}
        {inputNum > 0 && (
          <div className="mt-2 space-y-1.5 bg-[var(--color-bg)] rounded p-3 border border-[rgb(255_34_0_/_0.1)]">
            <CoverageRow
              label={`input ${chosenSym}`}
              required={inputNum}
              have={(() => {
                const bal = chosenSide === 'A' ? aBalance : bBalance
                const isWsol = chosenSide === 'A' ? isAWsol : isBWsol
                if (isWsol)
                  return solBalance != null
                    ? Number(solBalance) / LAMPORTS_PER_SOL
                    : null
                return bal != null
                  ? Number(bal) / Math.pow(10, chosenSide === 'A' ? pool.mintA.decimals : pool.mintB.decimals)
                  : null
              })()}
              decimals={Math.min(
                6,
                chosenSide === 'A' ? pool.mintA.decimals : pool.mintB.decimals,
              )}
              symbol={chosenSym}
              isWsol={chosenSide === 'A' ? isAWsol : isBWsol}
            />
            {matchingOther > 0 && (
              <CoverageRow
                label={`matching ${otherSym}`}
                required={matchingOther}
                have={(() => {
                  const bal = chosenSide === 'A' ? bBalance : aBalance
                  const isWsol = chosenSide === 'A' ? isBWsol : isAWsol
                  if (isWsol)
                    return solBalance != null
                      ? Number(solBalance) / LAMPORTS_PER_SOL
                      : null
                  return bal != null
                    ? Number(bal) / Math.pow(10, chosenSide === 'A' ? pool.mintB.decimals : pool.mintA.decimals)
                    : null
                })()}
                decimals={Math.min(
                  6,
                  chosenSide === 'A' ? pool.mintB.decimals : pool.mintA.decimals,
                )}
                symbol={otherSym}
                isWsol={chosenSide === 'A' ? isBWsol : isAWsol}
              />
            )}
          </div>
        )}
        <div className="text-[10px] text-[var(--color-dim)] mt-1">
          plus {(HELIUS_SENDER_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6)} SOL helius sender tip per tx + ~0.001 SOL fees
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
          I understand this position is exposed to{' '}
          <span className="text-[var(--color-warn)] font-black">
            impermanent loss
          </span>{' '}
          and may lose value relative to simply holding the two tokens.
        </span>
      </label>

      <button
        type="button"
        onClick={onSubmit}
        disabled={submitting || !agreed || !wallet.publicKey || !inputNum}
        className="w-full py-3 bg-[var(--color-hot)] text-black font-black uppercase tracking-[3px] text-xs rounded disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
      >
        {submitting
          ? 'working…'
          : inputNum > 0
          ? `deposit ${inputNum} ${chosenSym}${matchingOther > 0 ? ` + ${matchingOther.toFixed(6)} ${otherSym}` : ''}`
          : `deposit ${chosenSym}`}
      </button>

      {steps.length > 0 && <StepList steps={steps} />}
      {bundleLink && <BundleResult txIds={bundleLink} />}
      {error && (
        <div className="text-[11px] text-[var(--color-warn)] font-mono break-all">
          error: {error}
        </div>
      )}
    </div>
  )
}

/* ------------------------- remove panel ------------------------- */
//
// One-click zap-out. We:
//   1. Withdraw LP → receive A and B
//   2. For each non-WSOL side: Jupiter swap that token → SOL
//   3. Bundle everything into a Jito bundle (atomic)
//
// Note: swap-after-withdraw quotes are computed against expected outputs
// (proportional to the LP amount being burned). On-chain reserves can drift
// between bundle build and execution; slippage in the swap covers it.

function RemovePanel({
  pool,
  onClose,
}: {
  pool: RayPool
  onClose: () => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const [lpBalance, setLpBalance] = useState<bigint | null>(null)
  const [percent, setPercent] = useState(100)
  const [submitting, setSubmitting] = useState(false)
  const [steps, setSteps] = useState<BundleStep[]>([])
  const [bundleLink, setBundleLink] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [zapToSol, setZapToSol] = useState(true)

  const isAWsol = pool.mintA.address === SOL_MINT
  const isBWsol = pool.mintB.address === SOL_MINT

  useEffect(() => {
    if (!wallet.publicKey) {
      setLpBalance(null)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const lpMint = new PublicKey(pool.lpMint.address)
        const ata = getAssociatedTokenAddressSync(
          lpMint,
          wallet.publicKey!,
          false,
          new PublicKey(pool.lpMint.programId),
          ASSOCIATED_TOKEN_PROGRAM_ID,
        )
        const acc = await connection.getAccountInfo(ata)
        if (cancelled) return
        if (!acc) setLpBalance(0n)
        else setLpBalance(acc.data.readBigUInt64LE(64))
      } catch {
        if (!cancelled) setLpBalance(0n)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [wallet.publicKey, pool.lpMint.address, pool.lpMint.programId, connection])

  const lpBalanceUi =
    lpBalance != null ? Number(lpBalance) / Math.pow(10, pool.lpMint.decimals) : null
  const lpAmountToRemoveUi =
    lpBalanceUi != null ? (lpBalanceUi * percent) / 100 : 0

  const onSubmit = async () => {
    if (!wallet.publicKey || !wallet.signAllTransactions) {
      setError('connect wallet first')
      return
    }
    if (!agreed) {
      setError('check the acknowledgment first')
      return
    }
    if (!lpBalance || lpBalance === 0n || percent <= 0) {
      setError('nothing to remove')
      return
    }

    setError(null)
    setBundleLink(null)
    setSubmitting(true)

    const owner = wallet.publicKey
    const stepLabels: BundleStep[] = []
    const updateStep = (i: number, patch: Partial<BundleStep>) => {
      stepLabels[i] = { ...stepLabels[i], ...patch }
      setSteps([...stepLabels])
    }

    try {
      // --- 1. Compute LP amount to burn + expected output amounts ---
      stepLabels.push({ label: 'compute outputs', state: 'running' })
      setSteps([...stepLabels])

      // At 100% we burn (lpBalance − 1 atom) so a stale balance read
      // (another in-flight tx, a pending fee deduction, an atomic dust
      // delta from the pool itself) can't push the burn over actual
      // on-chain LP balance — `Burn` fails on InsufficientFunds and the
      // whole withdraw bundle aborts. The 1-atom haircut is invisible to
      // the user (≈1e−9 of an LP token) but eliminates the off-by-one.
      const lpToBurn =
        percent === 100
          ? lpBalance > 0n
            ? lpBalance - 1n
            : 0n
          : (lpBalance * BigInt(percent)) / 100n
      // Expected output, atomic. Use API-reported pool amounts; slippage covers
      // any drift between now and execution.
      const totalLpUi = pool.lpAmount
      const myLpUi = Number(lpToBurn) / Math.pow(10, pool.lpMint.decimals)
      const fraction = totalLpUi > 0 ? myLpUi / totalLpUi : 0
      const expectedAUi = pool.mintAmountA * fraction
      const expectedBUi = pool.mintAmountB * fraction
      const expectedAAtom = BigInt(
        Math.floor(expectedAUi * Math.pow(10, pool.mintA.decimals)),
      )
      const expectedBAtom = BigInt(
        Math.floor(expectedBUi * Math.pow(10, pool.mintB.decimals)),
      )
      // Apply 5% safety haircut so the swap-input amount can't exceed what
      // actually arrives in the user's wallet.
      const swapInA = (expectedAAtom * 95n) / 100n
      const swapInB = (expectedBAtom * 95n) / 100n
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `~${expectedAUi.toFixed(6)} ${pool.mintA.symbol} + ~${expectedBUi.toFixed(6)} ${pool.mintB.symbol}`,
      })

      // --- 2. Build Raydium withdrawLiquidity tx with Jito tip ---
      stepLabels.push({ label: 'build withdraw tx', state: 'running' })
      setSteps([...stepLabels])
      const { Raydium, TxVersion, Percent } = await import(
        '@raydium-io/raydium-sdk-v2'
      )
      const raydium = await Raydium.load({
        connection,
        owner,
        signAllTransactions: wallet.signAllTransactions,
        cluster: 'mainnet',
        disableFeatureCheck: true,
        blockhashCommitment: 'confirmed',
      })
      const poolKeysData = await raydium.api.fetchPoolKeysById({ idList: [pool.id] })
      const poolKeys = poolKeysData[0]
      const poolInfoData = await raydium.api.fetchPoolById({ ids: pool.id })
      const poolInfo = poolInfoData[0]
      if (!poolKeys || !poolInfo) throw new Error('could not fetch pool data')

      const withdrawResult = await raydium.cpmm.withdrawLiquidity({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        poolInfo: poolInfo as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        poolKeys: poolKeys as any,
        lpAmount: new BN(lpToBurn.toString()),
        slippage: new Percent(50, 100),
        txVersion: TxVersion.V0,
        closeWsol: true,
        // Raydium injects a tip-shaped SystemProgram.transfer ix; point it
        // at a Helius tip account so the resulting tx is sender-eligible.
        txTipConfig: {
          address: pickHeliusTipAccount(),
          amount: new BN(HELIUS_SENDER_TIP_LAMPORTS),
        },
      })
      const { appendIxToV0Tx, heliusTipIx } = await import('./lib/zap')
      const txs: VersionedTransaction[] = [withdrawResult.transaction]
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `burn ${myLpUi.toFixed(6)} LP, tip ${(HELIUS_SENDER_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
      })

      // --- 3. Optional zap-out swaps (received tokens → SOL) ---
      // Only do this for non-WSOL sides if the user opted in. For stacSOL,
      // bypass Jupiter and use native WithdrawSol — Jupiter's stacSOL → SOL
      // route goes through the Sanctum router and locks vote-account-adjacent
      // accounts, which causes Jito to reject the bundle.
      const isAStacsolOut = pool.mintA.address === STACSOL_MINT
      const isBStacsolOut = pool.mintB.address === STACSOL_MINT
      if (zapToSol) {
        if (!isAWsol && swapInA > 0n) {
          stepLabels.push({
            label: isAStacsolOut
              ? `burn ${pool.mintA.symbol} → SOL (native)`
              : `swap ${pool.mintA.symbol} → SOL`,
            state: 'running',
          })
          setSteps([...stepLabels])
          if (isAStacsolOut) {
            const txRaw = await buildStacsolBurnTx(connection, owner, swapInA)
            const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
            txs.push(tx)
            updateStep(stepLabels.length - 1, {
              state: 'done',
              detail: `~${(Number(swapInA) / Math.pow(10, pool.mintA.decimals)).toFixed(6)} stacSOL → SOL via WithdrawSol (redeemed at NAV)`,
            })
          } else {
            const q = await jupiterQuote({
              inputMint: pool.mintA.address,
              outputMint: SOL_MINT,
              amount: swapInA,
              swapMode: 'ExactIn',
              slippageBps: 5000,
            })
            const txRaw = await getJupiterSwapTx({
              quote: q,
              userPublicKey: owner,
              prioritizationFeeLamports: 'auto',
            })
            const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
            txs.push(tx)
            updateStep(stepLabels.length - 1, {
              state: 'done',
              detail: `~${(Number(swapInA) / Math.pow(10, pool.mintA.decimals)).toFixed(6)} ${pool.mintA.symbol} → ~${(Number(q.outAmount) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
            })
          }
        }

        if (!isBWsol && swapInB > 0n) {
          stepLabels.push({
            label: isBStacsolOut
              ? `burn ${pool.mintB.symbol} → SOL (native)`
              : `swap ${pool.mintB.symbol} → SOL`,
            state: 'running',
          })
          setSteps([...stepLabels])
          if (isBStacsolOut) {
            const txRaw = await buildStacsolBurnTx(connection, owner, swapInB)
            const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
            txs.push(tx)
            updateStep(stepLabels.length - 1, {
              state: 'done',
              detail: `~${(Number(swapInB) / Math.pow(10, pool.mintB.decimals)).toFixed(6)} stacSOL → SOL via WithdrawSol (redeemed at NAV)`,
            })
          } else {
            const q = await jupiterQuote({
              inputMint: pool.mintB.address,
              outputMint: SOL_MINT,
              amount: swapInB,
              swapMode: 'ExactIn',
              slippageBps: 5000,
            })
            const txRaw = await getJupiterSwapTx({
              quote: q,
              userPublicKey: owner,
              prioritizationFeeLamports: 'auto',
            })
            const tx = await appendIxToV0Tx(connection, txRaw, heliusTipIx(owner))
            txs.push(tx)
            updateStep(stepLabels.length - 1, {
              state: 'done',
              detail: `~${(Number(swapInB) / Math.pow(10, pool.mintB.decimals)).toFixed(6)} ${pool.mintB.symbol} → ~${(Number(q.outAmount) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
            })
          }
        }
      }

      // --- 4. Sign all + send sequentially via Helius Sender ---
      // Sequential because the zap-out swaps consume balances produced by
      // the LP withdraw (tx 1). Sending in parallel would race and the
      // swaps would either fail (no balance yet) or partially fill.
      stepLabels.push({ label: 'sign all transactions', state: 'running' })
      setSteps([...stepLabels])
      const signed = (await wallet.signAllTransactions(txs)) as VersionedTransaction[]
      updateStep(stepLabels.length - 1, {
        state: 'done',
        detail: `${signed.length} txs signed`,
      })

      const sigs: string[] = []
      const txLabels = ['lp withdraw', 'zap-out swap A', 'zap-out swap B']
      for (let i = 0; i < signed.length; i++) {
        stepLabels.push({
          label: `send ${txLabels[i] ?? `tx ${i + 1}`} via helius sender`,
          state: 'running',
        })
        setSteps([...stepLabels])
        const sig = await sendViaHeliusSender(signed[i])
        sigs.push(sig)
        updateStep(stepLabels.length - 1, {
          state: 'running',
          detail: `${sig.slice(0, 8)}… waiting for confirmation`,
        })
        await pollConfirmTransaction(connection, sig, {
          commitment: 'confirmed',
          timeoutMs: 75_000,
        })
        updateStep(stepLabels.length - 1, {
          state: 'done',
          detail: `confirmed ${sig.slice(0, 8)}…`,
        })
      }
      setBundleLink(sigs)
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
    <div className="border-t border-[var(--color-warn)] bg-[rgb(255_204_0_/_0.04)] p-5 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-warn)]">
          remove liquidity (one-click zap-out)
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-[var(--color-dim)] text-xl leading-none hover:text-[var(--color-fg)]"
        >
          ×
        </button>
      </div>

      <div className="text-[12px] text-[var(--color-dim)]">
        your LP balance:{' '}
        <span className="text-[var(--color-fg)] font-mono font-black">
          {lpBalanceUi != null
            ? lpBalanceUi.toFixed(6)
            : wallet.publicKey
            ? '…'
            : 'connect wallet'}
        </span>
      </div>

      <div className="space-y-2">
        <label className="text-[10px] uppercase tracking-wider text-[var(--color-dim)] flex items-center justify-between">
          <span>remove %</span>
          <span className="tabular-mono text-[var(--color-fg)] font-black">
            {percent}%
          </span>
        </label>
        <input
          type="range"
          min="0"
          max="100"
          step="1"
          value={percent}
          onChange={(e) => setPercent(Number(e.target.value))}
          className="w-full"
        />
        <div className="flex gap-2">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPercent(p)}
              className="flex-1 py-1 text-[10px] font-black uppercase tracking-wider border border-[rgb(255_204_0_/_0.3)] rounded text-[var(--color-warn)] hover:bg-[rgb(255_204_0_/_0.06)]"
            >
              {p}%
            </button>
          ))}
        </div>
      </div>

      {lpAmountToRemoveUi > 0 && (
        <div className="text-[12px] text-[var(--color-dim)]">
          burning ~
          <span className="text-[var(--color-fg)] font-mono font-black">
            {lpAmountToRemoveUi.toFixed(6)}
          </span>{' '}
          LP tokens
        </div>
      )}

      <label className="flex items-start gap-2 text-[12px] text-[var(--color-fg)] cursor-pointer">
        <input
          type="checkbox"
          checked={zapToSol}
          onChange={(e) => setZapToSol(e.target.checked)}
          className="mt-1"
        />
        <span>
          Zap-out: also swap{' '}
          {!isAWsol && pool.mintA.symbol}
          {!isAWsol && !isBWsol && ' + '}
          {!isBWsol && pool.mintB.symbol}{' '}
          back to SOL in the same bundle.
        </span>
      </label>

      <label className="flex items-start gap-2 text-[12px] text-[var(--color-fg)] cursor-pointer">
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          className="mt-1"
        />
        <span>
          I understand the amounts I receive may differ from what I deposited
          due to price changes and fees while LPing.
        </span>
      </label>

      <button
        type="button"
        onClick={onSubmit}
        disabled={
          submitting || !agreed || !wallet.publicKey || !lpBalance || lpBalance === 0n
        }
        className="w-full py-3 bg-[var(--color-warn)] text-black font-black uppercase tracking-[3px] text-xs rounded disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110"
      >
        {submitting
          ? 'working…'
          : `remove ${percent}% ${zapToSol ? '→ SOL' : 'as both tokens'}`}
      </button>

      {steps.length > 0 && <StepList steps={steps} />}
      {bundleLink && <BundleResult txIds={bundleLink} />}
      {error && (
        <div className="text-[11px] text-[var(--color-warn)] font-mono break-all">
          error: {error}
        </div>
      )}
    </div>
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

function BalanceTile({
  label,
  value,
  decimals,
  tone,
}: {
  label: string
  value: number | null
  decimals: number
  tone: 'hot' | 'green' | 'dim'
}) {
  const c =
    tone === 'hot'
      ? 'var(--color-hot)'
      : tone === 'green'
      ? 'var(--color-green)'
      : 'var(--color-dim)'
  return (
    <div className="bg-[var(--color-bg)] rounded px-3 py-2 border border-[rgb(255_34_0_/_0.1)]">
      <div
        className="text-[9px] font-black uppercase tracking-[2px]"
        style={{ color: c }}
      >
        {label}
      </div>
      <div className="tabular-mono text-[12px] font-black text-[var(--color-fg)] truncate">
        {value != null && isFinite(value) ? value.toFixed(decimals) : '—'}
      </div>
    </div>
  )
}

function CoverageRow({
  label,
  required,
  have,
  decimals,
  symbol,
  isWsol,
}: {
  label: string
  required: number
  have: number | null
  decimals: number
  symbol: string
  isWsol: boolean
}) {
  const sufficient = have != null && have >= required
  const short = have != null ? Math.max(0, required - have) : null
  const color = have == null
    ? 'var(--color-dim)'
    : sufficient
    ? 'var(--color-green)'
    : 'var(--color-warn)'
  // For WSOL: shortfall fails (can't swap into native SOL).
  const status =
    have == null
      ? 'connect wallet'
      : sufficient
      ? '✓ covered'
      : isWsol
      ? `⚠ short ${short!.toFixed(decimals)} SOL — top up wallet`
      : `→ swap ${short!.toFixed(decimals)} ${symbol} from SOL`

  return (
    <div className="grid grid-cols-[1fr_auto] gap-2 items-center text-[11px]">
      <div className="text-[var(--color-dim)] uppercase tracking-wider text-[10px]">
        {label}
      </div>
      <div className="tabular-mono text-right">
        <span className="text-[var(--color-fg)] font-black">
          {required.toFixed(decimals)}
        </span>
        <span className="text-[var(--color-dim)]"> need · </span>
        <span className="text-[var(--color-fg)]">
          {have != null ? have.toFixed(decimals) : '—'}
        </span>
        <span className="text-[var(--color-dim)]"> have</span>
      </div>
      <div className="col-span-2 text-right text-[10px]" style={{ color }}>
        {status}
      </div>
    </div>
  )
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

function fmtNum(n: number | null | undefined) {
  if (n == null || !isFinite(n)) return '—'
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(2)}k`
  if (Math.abs(n) >= 1) return n.toFixed(2)
  if (Math.abs(n) >= 0.01) return n.toFixed(6)
  return n.toFixed(6)
}
