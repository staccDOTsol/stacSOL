// stacSOL — /app dashboard. Editorial redesign.
//
// Replaces the legacy fire-red Action/Wrap/Position stack with the design's
// calm cardless layout: PoolStats strip + Mint/Burn/Wrap tabbed panel +
// Position card with NAV sparkline + QuickActions. Wires to the existing
// usePool/usePosition/useSolBalance hooks and the existing ix.ts builders
// so on-chain mint and burn still go through the same code path that
// produced production-tested confirmations.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import EditorialNav from './components/EditorialNav'
import { ReferralCard } from './components/ReferralCard'
import WalletPill from './components/WalletPill'
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { usePool } from './hooks/usePool'
import { usePosition } from './hooks/usePosition'
import { useLpExposure } from './hooks/useLpExposure'
import { useSolBalance } from './hooks/useSolBalance'
import { useStacBalance } from './hooks/useStacBalance'
import { useWstacBalance } from './hooks/useWstacBalance'
import { useHistory } from './hooks/useHistory'
import { findRealizedDailyRate } from './Landing'
import { useMyHolderRow, type HolderRow } from './hooks/useMyHolderRow'
import { useEpoch } from './hooks/useEpoch'
import {
  deriveAta,
  ixCreateAtaIdempotent,
  ixDepositSol,
  ixWithdrawSol,
} from './lib/ix'
import { deriveReferrerAtaAndCreateIx, useReferrer } from './lib/referrer'
import {
  ixWrap,
  ixUnwrap,
  ixCreateWrappedAtaIdempotent,
} from './lib/wrapper-ix'
import { DECIMALS, MINT, TOKEN_2022 } from './lib/constants'
import { fireBurn, fireMint, summarizeError } from './lib/confetti'
import type { PoolState } from './lib/pool'
import type { Position } from './lib/position'

const FEE = 0.069

// Default precision bumped 4 → 6: see lib/format.ts fmtAmount for rationale.
// 6dp matches the redemption-rate precision and surfaces sub-0.0001 token
// values (earned dust, referral credits, tiny burns) that previously rounded
// to `0.0000`.
function fmt(n: number | null | undefined, d = 6): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

// Nav rendered via shared EditorialNav (see components/EditorialNav.tsx).
// /app passes a wallet-pill `ctaSlot` so connect/disconnect is in the nav.

// -----------------------------------------------------------------------------
// PoolStats — ruled strip, no boxes
// -----------------------------------------------------------------------------
interface Perf {
  dailyRate: number | null
  doublingDays: number | null
  live: boolean
}

// IMPORTANT: must use the same realised-rate algorithm as Landing.tsx /
// components/Stats.tsx, otherwise the App's "Daily yield · doubles every X
// days" cell disagrees with the Landing hero's "DOUBLING TIME · 87-90 days at
// the current realized rate" card. The bug shipped with a single-fixed-24h
// window here (target = last.ts - 24h, snap to nearest) while Landing already
// used findRealizedDailyRate (longest plausible window, ≤5%/day spike cap).
// Different windows, different answers — same data — users on /app saw
// ~1.01%/day · 69 days while /  showed ~0.78%/day · 89 days simultaneously.
// findRealizedDailyRate is re-exported from Landing.tsx specifically so this
// hook (and Stats.tsx) can share the canonical implementation.
function usePerf(): Perf {
  const { history } = useHistory()
  return useMemo(() => {
    const found = findRealizedDailyRate(history)
    if (!found) return { dailyRate: null, doublingDays: null, live: false }
    return {
      dailyRate: found.dailyRate,
      doublingDays: Math.log(2) / Math.log(1 + found.dailyRate),
      live: true,
    }
  }, [history])
}

function PoolStats({ pool, rate, perf }: { pool: PoolState | null; rate: number; perf: Perf }) {
  const live = pool != null
  const backing = pool ? Number(pool.poolTotalLamports) / 1e9 : 0
  const supply = pool ? Number(pool.poolTokenSupplyAccounting) / 1e9 : 0
  const stats = [
    { k: 'Backing', v: fmt(backing), u: 'SOL', s: 'pool.total_lamports' },
    { k: 'Supply', v: fmt(supply), u: 'stacSOL', s: 'pool.pool_token_supply' },
    {
      k: 'Redemption rate',
      v: rate.toFixed(6),
      u: 'SOL/stacSOL',
      s: 'monotonically up',
    },
    {
      k: 'Daily yield',
      v: perf.dailyRate != null ? (perf.dailyRate * 100).toFixed(2) : '—',
      u: '%/day',
      s:
        perf.doublingDays != null
          ? `doubles every ${perf.doublingDays.toFixed(1)} days`
          : 'accumulating…',
    },
  ]
  return (
    <div style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 6,
        }}
      >
        <span className={`live-chip ${live ? '' : 'dim'}`}>
          <span className="dot" />
          {live ? 'live · on-chain' : 'fallback data'}
        </span>
      </div>
      <div className="stats">
        {stats.map((s, i) => (
          <div className="stat" key={i}>
            <div className="stat-k">{s.k}</div>
            <div className="stat-v tabular">
              {s.v}
              <span className="unit">{s.u}</span>
            </div>
            <div className="stat-sub">{s.s}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// ActionPanel — Mint / Burn / Wrap / Unwrap. All four wired against the
// production ix builders (ix.ts + wrapper-ix.ts).
// -----------------------------------------------------------------------------
type Tab = 'mint' | 'burn' | 'wrap' | 'unwrap'

function ActionPanel({
  pool,
  rate,
  position,
  holderRow,
  walletSol,
  walletStacAtom,
  walletWstacAtom,
  lpStac,
  staleByEpochs,
  onDone,
}: {
  pool: PoolState | null
  rate: number
  position: Position | null
  /** Indexed cost basis from /api/holders-leaderboard. When present this is
   *  the authoritative source — `grossSolIn` is parsed from DepositSol ix
   *  data so it excludes Jupiter zap-in swaps, Jito tips, and CB fees that
   *  the on-chain ATA walk in usePosition would otherwise include. */
  holderRow: HolderRow | null
  walletSol: number | null
  /** Live ATA balance in atomic units (useStacBalance). Decoupled from
   *  `position.balance` so the UI doesn't block on usePosition's heavy
   *  tx-history walk — without this, an active wallet with thousands of
   *  ATA-touching sigs shows balance 0 for the first 5–30s. */
  walletStacAtom: bigint | null
  /** Live wstacSOL ATA balance (atomic). Used by the Unwrap tab. */
  walletWstacAtom: bigint | null
  lpStac: number
  /** How many cluster epochs the pool is behind. 0 = fresh; >0 means
   *  DepositSol / WithdrawSol will fail with custom error 0x11 until the
   *  manager (or anyone) cranks the update ixs. */
  staleByEpochs: number
  onDone: () => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const modal = useWalletModal()
  // Referrer (from `?ref=<pubkey>` → localStorage → marketing default). The
  // 50% of the 6.9% deposit fee that the stake-pool routes to a referrer ATA
  // depends on which ATA we drop into slot 6 of DepositSol. Without this
  // hook every mint silently self-referrals via lib/ix.ts's `referral ??
  // userAta` fallback — neither the user's intended referrer nor the
  // marketing wallet gets credited.
  const ref = useReferrer()
  const [tab, setTab] = useState<Tab>('mint')
  const [amt, setAmt] = useState('')
  const [activePct, setActivePct] = useState<number | null>(null)
  // When user clicks max / 100%, we capture the EXACT bigint atom count
  // (balance − 1) and use that at submit time. Without this, the float
  // round-trip `balance → toFixed(6) → BigInt(Math.floor(...))` can round
  // UP by one atom on certain balances (e.g. 0.747700600 → "0.747701" →
  // 747_701_000n > on-chain 747_700_600n) and the tx fails on
  // InsufficientFunds. Cleared on any manual input edit so typing again
  // falls back to the float path.
  const [exactAtoms, setExactAtoms] = useState<bigint | null>(null)
  const [status, setStatus] = useState<{
    s: 'signing' | 'sending' | 'confirming' | 'ok' | 'err'
    m: string
    sig?: string
  } | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setAmt('')
    setActivePct(null)
    setExactAtoms(null)
    setStatus(null)
  }, [tab])

  // Prefer the live ATA read — useStacBalance returns in one RPC round-trip
  // even on wallets with deep histories. Falls back to position.balance only
  // if the live hook hasn't fired yet but the heavy fetch happens to have
  // finished first.
  const walletStacAtomEff = walletStacAtom ?? position?.balance ?? null
  const walletStac =
    walletStacAtomEff != null
      ? Number(walletStacAtomEff) / Math.pow(10, DECIMALS)
      : 0
  const walletWstac =
    walletWstacAtom != null
      ? Number(walletWstacAtom) / Math.pow(10, DECIMALS)
      : 0
  // Prefer the indexer's grossSolIn (parsed from on-chain DepositSol ix data)
  // — the ATA-walk fallback in usePosition over-counts when the user minted
  // via Jupiter zap-in (sees full swap-in SOL, not just the deposit). Without
  // this the break-even NAV inflates to absurd values (e.g. 1649 SOL/stacSOL
  // for the dev wallet).
  const costSol = holderRow
    ? Number(holderRow.grossSolIn) / 1e9
    : position
      ? Number(position.totalSolIn - position.totalSolOut) / 1e9
      : 0

  // Max available depends on the tab's input token. Mint pulls from SOL with
  // a small fee buffer; burn + wrap pull from stacSOL ATA; unwrap pulls from
  // wstacSOL ATA.
  const maxAvailable =
    tab === 'mint'
      ? Math.max(0, (walletSol ?? 0) - 0.01)
      : tab === 'unwrap'
        ? walletWstac
        : walletStac

  const inputToken =
    tab === 'mint'
      ? 'SOL'
      : tab === 'burn' || tab === 'wrap'
        ? 'stacSOL'
        : 'wstacSOL'
  const outToken =
    tab === 'mint'
      ? 'stacSOL'
      : tab === 'burn'
        ? 'SOL'
        : tab === 'wrap'
          ? 'wstacSOL'
          : 'stacSOL'

  const num = Number(amt) || 0
  // Math estimate — used as the initial value and as the fallback when sim
  // hasn't returned yet (or returns an error). Composes the pool's 6.9%
  // protocol fee on top of the redemption rate; close to truth for display
  // but not authoritative.
  const mathOut = useMemo(() => {
    if (!num) return 0
    if (tab === 'mint') return (num / rate) * (1 - FEE)
    if (tab === 'burn') return num * rate * (1 - FEE)
    // wrap: gross stacSOL in, net (1 − FEE) wstacSOL out (vault accounting
    // is delta-based, so the user gets exactly what survives the transfer).
    // unwrap: gross wstacSOL in (burns 1:1), net (1 − FEE) stacSOL out.
    return num * (1 - FEE)
  }, [num, tab, rate])

  // Simulated `you receive` — runs the actual ix sequence on chain via
  // simulateTransaction (sigVerify: false), reads the post-state of the
  // user's output ATA / wallet, and returns the exact delta. This catches
  // every quirk the math estimate misses: Token-2022 transfer-fee rounding,
  // the pool's epoch-fee composition, manager-fee carve-outs, ATA rent.
  // Doubles as a pre-flight error check (0x11 / insufficient funds /
  // anything else surface here BEFORE the user signs).
  const [simResult, setSimResult] = useState<{
    out: number | null
    err: string | null
    loading: boolean
  } | null>(null)

  useEffect(() => {
    // Reset when input cleared, wallet disconnected, or amount > balance.
    if (
      !wallet.connected ||
      !wallet.publicKey ||
      !num ||
      num <= 0 ||
      num > maxAvailable
    ) {
      setSimResult(null)
      return
    }
    const pubkey = wallet.publicKey
    // Mint and burn need the pool; wrap/unwrap don't.
    if ((tab === 'mint' || tab === 'burn') && !pool) {
      setSimResult(null)
      return
    }
    let cancelled = false
    setSimResult({ out: null, err: null, loading: true })
    const handle = setTimeout(async () => {
      try {
        // Atom-precise input. exactAtoms is set by max / 100%; otherwise
        // convert the float to atoms with the right scale per tab.
        const atoms =
          exactAtoms ??
          (tab === 'mint'
            ? BigInt(Math.floor(num * LAMPORTS_PER_SOL))
            : BigInt(Math.floor(num * Math.pow(10, DECIMALS))))

        const ixs: TransactionInstruction[] = [
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        ]
        let outputAddress = pubkey
        let outputIsLamports = false
        let preAtoms: bigint = 0n

        if (tab === 'mint' && pool) {
          ixs.push(ixCreateAtaIdempotent(pubkey, pubkey, MINT))
          // Referrer ATA gets the 50% referrer share of the 6.9% deposit
          // fee. Skip the explicit create when the depositor is referring
          // themselves (their ATA already exists from the create above).
          const referringSelf = ref.referrer.equals(pubkey)
          const { referrerAta, createIx: refCreateIx } = deriveReferrerAtaAndCreateIx({
            payer: pubkey,
            referrer: ref.referrer,
          })
          if (!referringSelf) ixs.push(refCreateIx)
          ixs.push(
            ixDepositSol(pubkey, atoms, pool, referringSelf ? undefined : referrerAta),
          )
          outputAddress = deriveAta(pubkey, MINT, TOKEN_2022)
          preAtoms = walletStacAtom ?? 0n
        } else if (tab === 'burn' && pool) {
          ixs.push(ixWithdrawSol(pubkey, atoms, pool))
          outputAddress = pubkey
          outputIsLamports = true
          preAtoms = BigInt(Math.floor((walletSol ?? 0) * LAMPORTS_PER_SOL))
        } else if (tab === 'wrap') {
          ixs.push(ixCreateWrappedAtaIdempotent(pubkey, pubkey))
          ixs.push(ixWrap(pubkey, atoms))
          // Wrapped ATA derived per wrapper-ix helper. PublicKey path matches
          // deriveWrapAtas in lib/wrapper-ix.
          outputAddress = (await import('./lib/wrapper-ix')).deriveWrapAtas(
            pubkey,
          ).wrapped
          preAtoms = walletWstacAtom ?? 0n
        } else {
          // unwrap
          ixs.push(ixCreateAtaIdempotent(pubkey, pubkey, MINT))
          ixs.push(ixUnwrap(pubkey, atoms))
          outputAddress = deriveAta(pubkey, MINT, TOKEN_2022)
          preAtoms = walletStacAtom ?? 0n
        }

        // Placeholder blockhash — replaceRecentBlockhash overrides it.
        const msg = new TransactionMessage({
          payerKey: pubkey,
          recentBlockhash: '11111111111111111111111111111111',
          instructions: ixs,
        }).compileToV0Message()
        const tx = new VersionedTransaction(msg)

        const sim = await connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: {
            encoding: 'base64',
            addresses: [outputAddress.toBase58()],
          },
        })

        if (cancelled) return

        if (sim.value.err) {
          // Surface the on-chain error. Pull a "custom program error: 0xN"
          // string out of the InstructionError tuple if possible; fall
          // through to logs otherwise.
          let errMsg = JSON.stringify(sim.value.err)
          const errObj = sim.value.err as unknown as {
            InstructionError?: [number, { Custom?: number } | string]
          }
          if (errObj.InstructionError) {
            const [, detail] = errObj.InstructionError
            if (typeof detail === 'object' && detail.Custom != null) {
              errMsg = `custom program error: 0x${detail.Custom.toString(16)}`
            }
          }
          setSimResult({
            out: null,
            err: summarizeError(new Error(errMsg)),
            loading: false,
          })
          return
        }

        const acc = sim.value.accounts?.[0]
        if (!acc) {
          setSimResult({
            out: null,
            err: 'sim returned no account state',
            loading: false,
          })
          return
        }
        const data = Buffer.from(acc.data[0], 'base64')
        let postAtoms: bigint
        if (outputIsLamports) {
          postAtoms = BigInt(acc.lamports)
        } else {
          // SPL Token / Token-2022 base layout — amount @ byte 64.
          postAtoms = data.readBigUInt64LE(64)
        }
        const delta = postAtoms - preAtoms
        const scale = outputIsLamports
          ? LAMPORTS_PER_SOL
          : Math.pow(10, DECIMALS)
        // For burn, the delta is post-fee SOL minus tx fees — slightly less
        // than the gross payout, which is what the wallet will actually
        // credit. That's the correct number to show.
        const simOut = Number(delta) / scale
        setSimResult({
          out: simOut > 0 ? simOut : 0,
          err: null,
          loading: false,
        })
      } catch (e) {
        if (cancelled) return
        setSimResult({
          out: null,
          err: summarizeError(e),
          loading: false,
        })
      }
    }, 400)

    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [
    tab,
    num,
    amt,
    exactAtoms,
    wallet.connected,
    wallet.publicKey,
    pool,
    connection,
    maxAvailable,
    walletStacAtom,
    walletWstacAtom,
    walletSol,
  ])

  // What to display under "You receive":
  //   - Wallet disconnected → math estimate (preview only, no sig yet).
  //   - Wallet connected + sim in flight → null (renders "—" + spinner).
  //     Avoids the "math says 0.54 → sim corrects to 0.49 three seconds
  //     later" heart-attack jump.
  //   - Sim succeeded → exact simulated number.
  //   - Sim failed → fall through to math estimate so the receipt area
  //     still has a sane preview; the error block surfaces the failure.
  const simReady = simResult != null && !simResult.loading
  const out: number | null =
    !wallet.connected
      ? mathOut
      : !num
        ? 0
        : simResult?.out != null
          ? simResult.out
          : simReady && simResult?.err
            ? mathOut
            : null
  const outIsSimulated = simResult?.out != null && !simResult.err

  // Earned-only smart-burn affordance — same heuristic as the prototype.
  // When the indexer has a row, prefer its breakevenNav directly (already
  // accounts for the 6.9% withdraw fee + transfer fee composition); fall
  // back to computing it locally otherwise.
  const earnedHint = useMemo(() => {
    if (tab !== 'burn') return null
    if (!costSol || !walletStac || rate <= 0) return null
    const be = holderRow?.breakevenNav ?? costSol / (walletStac * (1 - FEE))
    const fullPayout = walletStac * rate * (1 - FEE)
    if (fullPayout <= costSol) {
      return { kind: 'underwater' as const, be }
    }
    const keepStac = costSol / (rate * (1 - FEE))
    const burnStac = Math.max(0, walletStac - keepStac)
    const payoutSol = burnStac * rate * (1 - FEE)
    return { kind: 'ready' as const, keepStac, burnStac, payoutSol, cost: costSol }
  }, [tab, rate, costSol, walletStac, holderRow])

  const setPercent = (p: number) => {
    setActivePct(p)
    // Burn / wrap / unwrap at 100% must land EXACTLY at balance − 1 atom.
    // Going through float → toFixed(6) → BigInt(Math.floor) can round UP
    // by one atom (e.g. 0.747700600 → "0.747701" → 747_701_000n) and the
    // tx fails on InsufficientFunds. Capture the bigint here and let
    // submit() use it directly.
    if (p === 100) {
      const balAtom =
        tab === 'burn' || tab === 'wrap'
          ? walletStacAtomEff
          : tab === 'unwrap'
            ? walletWstacAtom
            : null
      if (balAtom != null && balAtom > 0n) {
        const atoms = balAtom - 1n
        setExactAtoms(atoms)
        setAmt((Number(atoms) / Math.pow(10, DECIMALS)).toFixed(9))
        return
      }
    }
    setExactAtoms(null)
    setAmt((maxAvailable * (p / 100)).toFixed(6))
  }

  const busy = status && status.s !== 'ok' && status.s !== 'err'
  const disabled = !pool || !num || num <= 0 || num > maxAvailable

  const submit = async () => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      modal.setVisible(true)
      return
    }
    const value = Number(amt)
    if (!Number.isFinite(value) || value <= 0) return
    try {
      setStatus({ s: 'signing', m: 'Awaiting wallet signature…' })
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ]
      if (tab === 'mint') {
        if (!pool) return
        const lamports = BigInt(Math.floor(value * LAMPORTS_PER_SOL))
        const userAta = deriveAta(wallet.publicKey, MINT, TOKEN_2022)
        const acc = await connection.getAccountInfo(userAta, 'processed')
        if (!acc) ixs.push(ixCreateAtaIdempotent(wallet.publicKey, wallet.publicKey, MINT))
        // Referrer ATA — collects 50% of the 6.9% deposit fee. Defaults to
        // marketing wallet when no `?ref=…` link was used; honours the
        // user's saved override otherwise. Skip the create when the
        // depositor IS the referrer (their ATA already exists from above).
        const referringSelf = ref.referrer.equals(wallet.publicKey)
        const { referrerAta, createIx: refCreateIx } = deriveReferrerAtaAndCreateIx({
          payer: wallet.publicKey,
          referrer: ref.referrer,
        })
        if (!referringSelf) ixs.push(refCreateIx)
        ixs.push(
          ixDepositSol(
            wallet.publicKey,
            lamports,
            pool,
            referringSelf ? undefined : referrerAta,
          ),
        )
      } else if (tab === 'burn') {
        if (!pool) return
        // Prefer the bigint captured by max — see setPercent + onChange.
        const tokens = exactAtoms ?? BigInt(Math.floor(value * Math.pow(10, DECIMALS)))
        ixs.push(ixWithdrawSol(wallet.publicKey, tokens, pool))
      } else if (tab === 'wrap') {
        const tokens = exactAtoms ?? BigInt(Math.floor(value * Math.pow(10, DECIMALS)))
        // The wrap ix is init_if_needed for the wrapped ATA program-side,
        // but pre-creating it shaves bytes off the wrap ix and stops
        // sizing-sensitive mobile wallets from choking.
        ixs.push(ixCreateWrappedAtaIdempotent(wallet.publicKey, wallet.publicKey))
        ixs.push(ixWrap(wallet.publicKey, tokens))
      } else {
        // unwrap
        const tokens = exactAtoms ?? BigInt(Math.floor(value * Math.pow(10, DECIMALS)))
        // Underlying stacSOL ATA may not exist yet if the user only ever
        // received wstacSOL — pre-create idempotently.
        const userUnderAta = deriveAta(wallet.publicKey, MINT, TOKEN_2022)
        const acc = await connection.getAccountInfo(userUnderAta, 'processed')
        if (!acc) ixs.push(ixCreateAtaIdempotent(wallet.publicKey, wallet.publicKey, MINT))
        ixs.push(ixUnwrap(wallet.publicKey, tokens))
      }
      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      const v0 = new VersionedTransaction(
        new TransactionMessage({
          payerKey: wallet.publicKey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      )
      let serialized: Uint8Array
      try {
        const signed = (await wallet.signTransaction(v0)) as VersionedTransaction
        serialized = signed.serialize()
      } catch (signErr) {
        // Distinguish "user rejected the popup" (clean cancel — show
        // cancelled, don't retry) from "wallet doesn't support v0 / threw
        // a real error" (try once as legacy Transaction for older
        // adapters). The previous unconditional retry was silently
        // popping the wallet a SECOND time when the first was rejected,
        // which the user saw as "Awaiting wallet signature…" forever
        // with no way out.
        const msg = (signErr as Error)?.message ?? String(signErr)
        if (/user reject|user cancel|rejected by user|cancelled/i.test(msg)) {
          throw new Error('cancelled')
        }
        // Versioned-tx failure shapes — these are the only cases worth
        // retrying as legacy. Anything else: surface the original error.
        const versionedTxFailure =
          /version|v0|VersionedTransaction|unsupported|method not supported|invalid transaction format/i.test(
            msg,
          )
        if (!versionedTxFailure) throw signErr
        const legacy = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash })
        for (const ix of ixs) legacy.add(ix)
        const signedLegacy = (await wallet.signTransaction(
          legacy as unknown as VersionedTransaction,
        )) as unknown as Transaction
        serialized = signedLegacy.serialize()
      }
      setStatus({ s: 'sending', m: 'Broadcasting transaction…' })
      const sig = await connection.sendRawTransaction(serialized)
      setStatus({ s: 'confirming', m: 'Waiting for confirmation…', sig })
      const { pollConfirmTransaction } = await import('./lib/zap')
      await pollConfirmTransaction(connection, sig, {
        blockhash,
        commitment: 'confirmed',
        timeoutMs: 60_000,
      })
      const verb =
        tab === 'mint'
          ? 'Minted'
          : tab === 'burn'
            ? 'Burned'
            : tab === 'wrap'
              ? 'Wrapped'
              : 'Unwrapped'
      setStatus({
        s: 'ok',
        m: `${verb} ${fmt(value)} ${inputToken} → ${fmt(out)} ${outToken}`,
        sig,
      })
      if (tab === 'mint') fireMint()
      else if (tab === 'burn') fireBurn()
      setAmt('')
      setActivePct(null)
      setExactAtoms(null)
      onDone()
    } catch (e) {
      setStatus({ s: 'err', m: summarizeError(e) })
    }
  }

  return (
    <div className="panel" ref={cardRef}>
      <div className="tabs" role="tablist">
        {(['mint', 'burn', 'wrap', 'unwrap'] as Tab[]).map(t => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${tab === t ? 'active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'mint'
              ? 'Mint'
              : t === 'burn'
                ? 'Burn'
                : t === 'wrap'
                  ? 'Wrap'
                  : 'Unwrap'}
          </button>
        ))}
      </div>

      <div className="panel-body">
        <div className="panel-row">
          <span className="field-label">
            You{' '}
            {tab === 'burn'
              ? 'burn'
              : tab === 'mint'
                ? 'deposit'
                : tab === 'wrap'
                  ? 'wrap'
                  : 'unwrap'}
          </span>
          <span className="field-balance">
            {tab === 'mint' ? 'available' : 'balance'}{' '}
            <b
              className="clickable"
              onClick={() => setPercent(100)}
              title="Set max"
            >
              {/* Show spinner instead of 0 while the live ATA / SOL hooks
                  haven't returned yet. Avoids the "balance 0.000000 stacSOL"
                  flash that scares wallets with real holdings. */}
              {wallet.connected &&
              ((tab === 'mint' && walletSol == null) ||
                ((tab === 'burn' || tab === 'wrap') &&
                  walletStacAtom == null &&
                  position == null) ||
                (tab === 'unwrap' && walletWstacAtom == null)) ? (
                <>
                  <span className="spin" style={{ marginRight: 6 }} />—
                </>
              ) : (
                <>
                  {fmt(maxAvailable)} {inputToken}
                </>
              )}
            </b>
          </span>
        </div>

        <div className="amt-input-row">
          <input
            className="amt-input tabular"
            inputMode="decimal"
            placeholder="0.00"
            value={amt}
            onChange={e => {
              setAmt(e.target.value)
              setActivePct(null)
              // Manual edit invalidates the exact-bigint snapshot — fall
              // back to the float path at submit time.
              setExactAtoms(null)
            }}
          />
          <span className="amt-token">{inputToken}</span>
        </div>

        <div className="amt-pcts">
          {[25, 50, 75, 100].map(p => (
            <button
              key={p}
              className={`amt-pct ${activePct === p ? 'is-active' : ''}`}
              onClick={() => setPercent(p)}
            >
              {p === 100 ? 'max' : `${p}%`}
            </button>
          ))}
        </div>

        <div className="swap-divider">
          <span className="glyph" aria-hidden>
            ↓
          </span>
        </div>

        <div className="panel-row" style={{ marginBottom: 12 }}>
          <span className="field-label">You receive</span>
          <span
            className="field-balance"
            style={{ color: 'var(--accent-deep)' }}
          >
            {simResult?.loading ? (
              <>simulating…</>
            ) : outIsSimulated ? (
              <span className="live-chip" style={{ padding: '2px 8px', fontSize: 9 }}>
                <span className="dot" />
                simulated · exact
              </span>
            ) : (
              <>est. at NAV {rate.toFixed(6)}</>
            )}
          </span>
        </div>
        <div className="receive">
          <div className="lhs">
            {out == null ? (
              <span style={{ color: 'var(--ink-faint)' }}>
                <span className="spin" style={{ marginRight: 10 }} />—
              </span>
            ) : (
              fmt(out, 6)
            )}
          </div>
          <div className="rhs">{outToken}</div>
        </div>

        {/* On-chain simulation pre-flight error. Surfaces 0x11
            (StakeListAndPoolOutOfDate), insufficient funds, and any other
            program error BEFORE the user signs — saves a wasted wallet
            round-trip. Hides while loading and after a fresh successful
            sim. */}
        {simResult?.err && !simResult.loading && (
          <div className="status err" style={{ marginTop: 12 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
            <span>{simResult.err}</span>
          </div>
        )}

        {num > 0 && (
          <div className="receipt">
            <div className="r-row">
              <span>
                {tab === 'mint'
                  ? 'Deposit fee 6.9% (burned to NAV)'
                  : tab === 'burn'
                    ? 'Withdrawal fee 6.9% (burned to NAV)'
                    : tab === 'wrap'
                      ? 'Transfer fee 6.9% (user → vault)'
                      : 'Transfer fee 6.9% (vault → user)'}
              </span>
              <b>
                −{fmt(num * FEE, 6)} {inputToken}
              </b>
            </div>
            <div className="r-row">
              <span>Network · priority fees</span>
              <b>~0.00018 SOL</b>
            </div>
            {tab === 'mint' && (
              <div className="r-row good">
                <span>Compounds into redemption rate</span>
                <b>+{(FEE * 100).toFixed(1)}%</b>
              </div>
            )}
          </div>
        )}

        {tab === 'burn' && earnedHint?.kind === 'ready' && (
          <div
            className="earned-cta"
            onClick={() => {
              setAmt(earnedHint.burnStac.toFixed(6))
              setActivePct(null)
            }}
          >
            <div className="ec-k">↓ withdraw earned SOL only</div>
            <div className="ec-v">
              Burn <b>{fmt(earnedHint.burnStac, 6)}</b> stacSOL · receive{' '}
              <b style={{ color: 'var(--accent-deep)' }}>
                +{fmt(earnedHint.payoutSol, 6)} SOL
              </b>
            </div>
            <div className="ec-sub">
              Keeps {fmt(earnedHint.keepStac, 6)} stacSOL ≈ your{' '}
              {fmt(earnedHint.cost)} SOL principal at current NAV, still
              earning. Tap to fill, then Burn.
            </div>
          </div>
        )}

        {tab === 'burn' && earnedHint?.kind === 'underwater' && (
          <div className="status work" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>⏳</span>
            <span>
              Full burn would still be underwater — break-even at NAV{' '}
              <b className="mono">{earnedHint.be.toFixed(6)}</b>. Hold; every
              basis point is yours.
            </span>
          </div>
        )}

        {/* Stale-pool warning. The stake-pool program rejects DepositSol /
            WithdrawSol with custom error 0x11 (StakeListAndPoolOutOfDate)
            when `last_update_epoch` < current cluster epoch. The manager's
            burn loop normally cranks UpdateValidatorListBalance +
            UpdateStakePoolBalance every 5min so this clears at the epoch
            boundary; if the cron is lagging we show the user before they
            spend a wallet sig. Wrap / Unwrap go through the wrapper
            program and don't care. */}
        {staleByEpochs > 0 && (tab === 'mint' || tab === 'burn') && (
          <div className="status work" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>⏳</span>
            <span>
              Pool out of date by{' '}
              <b className="mono">
                {staleByEpochs} epoch{staleByEpochs === 1 ? '' : 's'}
              </b>{' '}
              — the manager normally cranks within 5 minutes. {tab} is paused
              until then.
            </span>
          </div>
        )}

        <button
          className="cta-primary"
          disabled={
            !!busy ||
            (wallet.connected && disabled) ||
            (staleByEpochs > 0 && (tab === 'mint' || tab === 'burn')) ||
            // Pre-flight failed — don't let the user spend a sig on a tx
            // we already know will fail. Loading state stays enabled
            // because the previous successful sim's values are still
            // displayed.
            !!(simResult?.err && !simResult.loading)
          }
          onClick={submit}
        >
          {busy ? (
            <>
              <span className="spin" /> {status?.m}
            </>
          ) : !wallet.connected ? (
            <>
              Connect wallet to {tab}
              <span style={{ marginLeft: 2 }}>⇒</span>
            </>
          ) : (
            <>
              {tab === 'mint'
                ? 'Mint stacSOL'
                : tab === 'burn'
                  ? 'Burn for SOL'
                  : tab === 'wrap'
                    ? 'Wrap to wstacSOL'
                    : 'Unwrap to stacSOL'}
              <span style={{ marginLeft: 2 }}>↗</span>
            </>
          )}
        </button>

        {status?.s === 'ok' && (
          <div className="status ok" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>✓</span>
            <div style={{ flex: 1 }}>
              <div>{status.m}</div>
              {status.sig && (
                <div
                  className="mono"
                  style={{ fontSize: 10.5, marginTop: 4, opacity: 0.8 }}
                >
                  tx {status.sig.slice(0, 6)}…{status.sig.slice(-4)} ·{' '}
                  <a
                    href={`https://solscan.io/tx/${status.sig}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'inherit', textDecoration: 'underline' }}
                  >
                    view on solscan ↗
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {status?.s === 'err' && (
          <div className="status err" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
            <span>{status.m}</span>
          </div>
        )}

        {tab === 'burn' && lpStac > 0 && (
          <p
            className="mono"
            style={{
              marginTop: 14,
              fontSize: 11,
              color: 'var(--ink-muted)',
              lineHeight: 1.6,
            }}
          >
            ⓘ wallet {fmt(walletStac)} burnable here · {fmt(lpStac)} in
            LP positions (total {fmt(walletStac + lpStac)}). Withdraw LP
            via{' '}
            <a
              href="/portfolio"
              style={{
                color: 'var(--accent-deep)',
                borderBottom: '1px dashed currentColor',
              }}
            >
              portfolio
            </a>{' '}
            to burn the rest.
          </p>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// PositionCard — balance in display serif, NAV sparkline, ruled P&L table
// -----------------------------------------------------------------------------
function PositionCard({
  rate,
  position,
  holderRow,
  walletStacAtom,
  lpStac,
  connected,
}: {
  rate: number
  position: Position | null
  holderRow: HolderRow | null
  /** Live ATA balance (atomic units). Same fast-path source as ActionPanel. */
  walletStacAtom: bigint | null
  lpStac: number
  connected: boolean
}) {
  // Loading state: when connected but neither the fast ATA read nor the
  // heavy fetchPosition has returned, we DON'T render zeros — the user
  // would briefly see "0.000000 stacSOL ≈ 0 SOL · -100% P&L" before
  // numbers populate. Skeleton dashes everywhere until at least one
  // source resolves.
  const balanceLoading =
    connected && walletStacAtom == null && position == null
  // Cost basis loads in a separate hop (the indexer row); render the
  // P&L row only once it actually arrives so we don't flash a wrong
  // gain/loss.
  const costLoading =
    connected && holderRow == null && position == null

  const walletStac =
    walletStacAtom != null
      ? Number(walletStacAtom) / Math.pow(10, DECIMALS)
      : position
        ? Number(position.balance) / Math.pow(10, DECIMALS)
        : 0
  const total = walletStac + lpStac
  // Gross mark @ NAV — what the protocol values your position at.
  const grossValue = total * rate
  // Net realised value — what you'd actually receive if you burned right
  // now, after the 6.9% withdraw fee. P&L below is computed against this
  // because that's the only value you can extract.
  const netValue = grossValue * (1 - FEE)
  // Authoritative cost basis from the indexer (DepositSol ix data only) —
  // falls back to ATA-walk position numbers, then to zero.
  const costSol = holderRow
    ? Number(holderRow.grossSolIn) / 1e9
    : position
      ? Number(position.totalSolIn - position.totalSolOut) / 1e9
      : 0
  const hasCostBasis = costSol > 0
  // Prefer the indexer's pnlSol / pnlPct when available — same numbers the
  // leaderboard renders, already net of withdraw fee and reconciled with
  // earned-stacSOL credits. Otherwise compute locally against netValue.
  const pnl = holderRow
    ? holderRow.pnlSol
    : netValue - costSol
  const pnlPct = holderRow?.pnlPct != null
    ? holderRow.pnlPct
    : hasCostBasis
      ? (pnl / costSol) * 100
      : 0
  const gain = pnl >= 0

  // Helper: render either a value or an em-dash + tiny spinner depending
  // on whether the relevant data source has loaded. Lets us keep the
  // table structure stable while populating asynchronously.
  const ld = (loading: boolean, value: string) =>
    loading ? (
      <span style={{ color: 'var(--ink-faint)' }}>
        <span className="spin" style={{ marginRight: 6 }} />—
      </span>
    ) : (
      value
    )

  const points = useMemo(() => {
    const n = 32
    const start = 1.0
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1)
      const noise = Math.sin(i * 0.6) * 0.004 + (Math.random() - 0.5) * 0.002
      return start + t * (rate - start) + noise
    })
  }, [rate])

  const W = 320,
    H = 70,
    pad = 4
  const min = Math.min(...points),
    max = Math.max(...points)
  const path = points
    .map((p, i) => {
      const x = pad + (i / (points.length - 1)) * (W - 2 * pad)
      const y = pad + (1 - (p - min) / (max - min || 1)) * (H - 2 * pad)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  const area = path + ` L${W - pad},${H} L${pad},${H} Z`

  return (
    <div className="position">
      <div className="position-head">
        <h3 className="position-h">Your position</h3>
        <span
          className={`live-chip ${connected ? '' : 'dim'}`}
          style={{ padding: '2px 8px', fontSize: 9 }}
        >
          <span className="dot" />
          {connected ? 'on-chain' : 'demo'}
        </span>
      </div>
      <div className="position-bal tabular">
        {balanceLoading ? (
          <span style={{ color: 'var(--ink-faint)' }}>
            <span className="spin" style={{ marginRight: 10 }} />—
          </span>
        ) : (
          <>
            {fmt(total, 6)}
            <span className="unit">stacSOL</span>
          </>
        )}
      </div>
      <div className="position-eq">
        {balanceLoading ? (
          <span style={{ color: 'var(--ink-muted)' }}>
            reading on-chain balance…
          </span>
        ) : (
          <>
            ≈ <b className="tabular">{fmt(netValue)} SOL</b> if burned now
            <span style={{ color: 'var(--ink-muted)' }}>
              {' · '}
              {fmt(grossValue)} at NAV
            </span>
          </>
        )}
      </div>

      <div className="spark">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="sparkFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={area} fill="url(#sparkFill)" />
          <path d={path} fill="none" stroke="var(--accent-deep)" strokeWidth="1.5" />
          <circle
            cx={W - pad}
            cy={
              pad +
              (1 - (points[points.length - 1] - min) / (max - min || 1)) *
                (H - 2 * pad)
            }
            r="3"
            fill="var(--accent-deep)"
          />
        </svg>
        <div className="axis">
          <span>30d ago</span>
          <span>now</span>
        </div>
      </div>

      <div className="position-table">
        <div className="pt-row">
          <span className="pt-k">In wallet</span>
          <span className="pt-v tabular">
            {ld(balanceLoading, `${fmt(walletStac, 6)} stacSOL`)}
          </span>
        </div>
        <div className="pt-row">
          <span className="pt-k">In LP positions</span>
          <span className="pt-v tabular">{fmt(lpStac, 6)} stacSOL</span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Cost basis</span>
          <span
            className="pt-v tabular"
            style={{ color: hasCostBasis ? 'var(--ink)' : 'var(--ink-muted)' }}
          >
            {!connected
              ? 'connect wallet'
              : ld(
                  costLoading,
                  hasCostBasis ? `${fmt(costSol)} SOL` : 'no mints yet',
                )}
          </span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Mark · NAV {rate.toFixed(6)}</span>
          <span className="pt-v tabular">
            {ld(balanceLoading, `${fmt(grossValue)} SOL`)}
          </span>
        </div>
        <div className="pt-row">
          <span className="pt-k">Burn payout (−6.9%)</span>
          <span className="pt-v tabular">
            {ld(balanceLoading, `${fmt(netValue)} SOL`)}
          </span>
        </div>
        {hasCostBasis && !balanceLoading && !costLoading && (
          <div className="pt-row">
            <span className="pt-k">
              Unrealized P&L{' '}
              <span style={{ color: 'var(--ink-faint)', fontSize: 10 }}>
                {holderRow ? 'indexed' : 'net of fee'}
              </span>
            </span>
            <span className={`pt-v tabular ${gain ? 'gain' : 'loss'}`}>
              {gain ? '+' : ''}
              {fmt(pnl)} SOL · {gain ? '+' : ''}
              {pnlPct.toFixed(2)}%
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// QuickActions — link strip to the rest of the surface
// -----------------------------------------------------------------------------
function QuickActions() {
  const items = [
    { k: 'Portfolio', s: 'DLMM positions · claim & withdraw', h: '/portfolio' },
    { k: 'Liquidity', s: 'Raydium CPMM zap-in / zap-out', h: '/liquidity' },
    { k: 'Single-sided', s: 'Meteora DLMM concentrated LP', h: '/singlesided' },
    { k: 'Leaderboard', s: 'Holders, P&L, referrals', h: '/leaderboard' },
    { k: 'Liqmonsta', s: 'Auto-rebalance LP smasher', h: '/liqmonsta' },
    { k: 'FAQ', s: 'Bankrun math · safety · fee mechanics', h: '/faq' },
    { k: 'Terms', s: 'Long-form ToS · LST factory carve-out', h: '/terms' },
    { k: 'Wrap', s: 'stacSOL ↔ wstacSOL · for ride.markets', h: '/wrap' },
  ]
  return (
    <div className="quick-actions">
      {items.map(it => (
        <a key={it.k} className="qa" href={it.h}>
          <div>
            <div className="qa-k">{it.k}</div>
            <div className="qa-sub">{it.s}</div>
          </div>
          <div className="qa-arrow">→</div>
        </a>
      ))}
    </div>
  )
}

// -----------------------------------------------------------------------------
// App root
// -----------------------------------------------------------------------------
export default function App() {
  const { pool, refresh } = usePool()
  const [posTick, setPosTick] = useState(0)
  const { position } = usePosition(posTick)
  const wallet = useWallet()
  const solLamports = useSolBalance(wallet.publicKey ?? null)
  const walletSol = solLamports != null ? solLamports / LAMPORTS_PER_SOL : null
  // Live stacSOL ATA balance (one getAccountInfo per tick). This is the
  // *displayed* balance — usePosition's heavy tx-history walk runs in
  // parallel for cost basis / mint tranches but the UI doesn't wait on it.
  const walletStacAtom = useStacBalance(wallet.publicKey ?? null)
  const walletWstacAtom = useWstacBalance(wallet.publicKey ?? null)
  const perf = usePerf()
  const epoch = useEpoch()
  // Authoritative indexed view of the connected wallet's mints / burns /
  // transfers — used as the primary cost-basis source.
  const { row: holderRow } = useMyHolderRow()

  const rate =
    pool && pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : 1

  const lpExposure = useLpExposure(rate)
  const lpStac = Number(lpExposure.stacsolAtom) / Math.pow(10, DECIMALS)

  // Detect "pool out of date" — the SPL stake-pool program rejects deposits
  // and withdrawals with custom error 0x11 (StakeListAndPoolOutOfDate) when
  // `last_update_epoch` < current cluster epoch. The manager's burn loop
  // normally cranks UpdateValidatorListBalance + UpdateStakePoolBalance
  // every 5min so this clears within an epoch boundary, but if the cron is
  // lagging the user shouldn't get a useless "program error 0x11" toast
  // after wasting a wallet signature.
  const staleByEpochs =
    pool && epoch ? Math.max(0, epoch.epoch - Number(pool.lastUpdateEpoch)) : 0

  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  const onDone = () => {
    refresh()
    setPosTick(t => t + 1)
  }

  return (
    <>
      <EditorialNav
        pathname="/app"
        ctaSlot={<WalletPill connectLabel="Connect to Mint" />}
      />
      <main className="dash shell">
        <div className="dash-grid">
          <div>
            <h1 className="dash-h">
              <span className="serif">stacSOL</span>{' '}
              <span
                className="serif"
                style={{ color: 'var(--ink-muted)', fontStyle: 'italic' }}
              >
                · dashboard
              </span>
            </h1>
            <div className="dash-sub">
              protocol live · pool E6oqvrLK…Qixqb · refresh 10s
            </div>

            <PoolStats pool={pool} rate={rate} perf={perf} />

            <ActionPanel
              pool={pool}
              rate={rate}
              position={position}
              holderRow={holderRow}
              walletSol={walletSol}
              walletStacAtom={walletStacAtom}
              walletWstacAtom={walletWstacAtom}
              lpStac={lpStac}
              staleByEpochs={staleByEpochs}
              onDone={onDone}
            />
          </div>

          <aside className="aside">
            <PositionCard
              rate={rate}
              position={position}
              holderRow={holderRow}
              walletStacAtom={walletStacAtom}
              lpStac={lpStac}
              connected={wallet.connected}
            />
            <ReferralCard />
            <QuickActions />
          </aside>
        </div>
      </main>
    </>
  )
}
