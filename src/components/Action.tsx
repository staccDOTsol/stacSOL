import { useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { Card } from './Stats'
import { deriveAta, ixCreateAtaIdempotent, ixDepositSol, ixWithdrawSol } from '../lib/ix'
import { DECIMALS, MINT, TOKEN_2022 } from '../lib/constants'
import { deriveReferrerAtaAndCreateIx, MARKETING_REFERRER } from '../lib/referrer'
import { useSolBalance } from '../hooks/useSolBalance'
import type { PoolState } from '../lib/pool'
import type { Position } from '../lib/position'
import { fireBurn, fireMint, shake, summarizeError } from '../lib/confetti'

// Reserve a small SOL buffer for fees + rent when user picks 100% mint.
const SOL_RESERVE_AT_MAX = 0.01

type Mode = 'mint' | 'burn'

interface ActionStatus {
  state: 'signing' | 'sending' | 'confirming' | 'success' | 'error'
  message: string
  signature?: string
}

export function Action({
  mode,
  pool,
  position,
  onDone,
  appendLog,
  lpStacAtom = 0n,
}: {
  mode: Mode
  pool: PoolState | null
  position?: Position | null
  onDone: () => void
  appendLog: (msg: string) => void
  /** stacSOL the user holds INSIDE LP positions (DLMM + CPMM). Comes from
   *  `useLpExposure()` hoisted in App.tsx. We use it only to render the
   *  breakdown under the burn balance ("wallet 22 · in LPs 1.5 · total
   *  23.5"). The burn percent buttons still operate on wallet balance only,
   *  because WithdrawSol can't burn LP'd stacSOL directly — the user has
   *  to withdraw from the LP first via /portfolio. */
  lpStacAtom?: bigint
}) {
  const { connection } = useConnection()
  const { publicKey, signTransaction } = useWallet()
  const [amt, setAmt] = useState('')
  // Set by the 100% / max button on burn so submit can use the exact bigint
  // (balance − 1 atom) instead of re-parsing the displayed string and risking
  // a round-up that pushes us over the actual on-chain balance. Cleared on
  // any manual edit to the input.
  const [exactAtoms, setExactAtoms] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ActionStatus | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Shared SOL balance — both Action cards (mint + burn) and the WalletCard
  // subscribe to the same poll loop via this hook so we don't fan out
  // multiple parallel getBalance requests on connect (helps Phantom mobile
  // webview survive). Burn mode doesn't need this for its quick-amount
  // buttons (those use the position balance), but the hook is cheap when
  // multiple consumers share it.
  const lamports = useSolBalance(mode === 'mint' ? publicKey : null)
  const solBalance = lamports != null ? lamports / LAMPORTS_PER_SOL : null

  // Available balance the percent buttons operate on. For mint we leave a
  // small SOL buffer at 100%; intermediate percents take the slice straight.
  const maxAvailable =
    mode === 'mint'
      ? solBalance != null
        ? Math.max(0, solBalance)
        : null
      : position
      ? Number(position.balance) / Math.pow(10, DECIMALS)
      : null

  const setPercent = (pct: number) => {
    if (maxAvailable == null) return
    // Burn 100% needs to land EXACTLY at balance - 1 atom. Going through
    // float UI and back to bigint at submit time can round UP (e.g.
    // 0.7477006 → toFixed(6) → "0.747701" → 747701000 atoms, over the
    // actual 747700600 balance) and the WithdrawSol fails on
    // InsufficientFunds. Keep the exact bigint here and let submit use it.
    if (mode === 'burn' && pct === 100 && position && position.balance > 0n) {
      const atoms = position.balance - 1n
      setExactAtoms(atoms)
      setAmt((Number(atoms) / Math.pow(10, DECIMALS)).toFixed(9))
      return
    }
    let raw =
      mode === 'mint' && pct === 100
        ? maxAvailable - SOL_RESERVE_AT_MAX
        : (maxAvailable * pct) / 100
    if (raw < 0) raw = 0
    setExactAtoms(null)
    // Trim to 6 decimals — input step is 0.001 but lamport precision is 9.
    setAmt(raw > 0 ? raw.toFixed(6) : '')
  }

  const disabled = !pool || !publicKey || !signTransaction || busy || !amt || Number(amt) <= 0

  const submit = async () => {
    if (!pool || !publicKey || !signTransaction) return
    const value = Number(amt)
    if (!Number.isFinite(value) || value <= 0) return
    setBusy(true)
    try {
      // Build as a VersionedTransaction (v0) instead of a legacy Transaction.
      // Phantom's mobile in-app browser intermittently crashes at parse
      // time when handed a legacy tx that mixes ComputeBudget + a Token-2022
      // mint reference + idempotent ATA creates. Symptom is "Phantom
      // closes when you tap Mint" — no approval modal, no error to the
      // dapp, just gone. Same payload as a v0 message lands cleanly.
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ]

      if (mode === 'mint') {
        const lamports = BigInt(Math.floor(value * LAMPORTS_PER_SOL))

        // Pre-check both ATAs and skip the create ix when they already
        // exist on chain. createAssociatedTokenAccountIdempotent is a
        // safe no-op when the account exists, but the IX BYTES still
        // count toward tx size and Phantom mobile has a smaller usable
        // budget than the network 1232-byte limit. Dropping no-op ixs
        // shaves ~50 bytes each AND reduces account-meta count, both
        // of which help the mobile parser.
        const userAta = deriveAta(publicKey, MINT, TOKEN_2022)
        const { referrerAta: referralAta, createIx: referralCreateIx } =
          deriveReferrerAtaAndCreateIx({
            payer: publicKey,
            referrer: MARKETING_REFERRER,
          })

        // One getMultipleAccountsInfo call covers all checks.
        const checkAcc: PublicKey[] = [userAta, referralAta]
        const accInfos = await connection.getMultipleAccountsInfo(checkAcc, 'processed')
        const userAtaExists = accInfos[0] != null
        const referralAtaExists = accInfos[1] != null

        if (!userAtaExists) {
          ixs.push(ixCreateAtaIdempotent(publicKey, publicKey, MINT))
        }
        // Repeat ATA precheck and create for both REFERRER and MANAGER fee ATAs.

        // 1. Referrer ATA
        if (!referralAtaExists) {
          // Note: still uses `Idempotent` variant in case of a race —
          // safe even if another tx creates it between our check and the
          // landing of this tx.
          ixs.push(referralCreateIx)
        }

        // 2. Manager fee ATA — no precheck (it isn't in checkAcc), the
        // idempotent create is a safe no-op when it already exists.
        ixs.push(ixCreateAtaIdempotent(publicKey, pool.managerFeeAccount, MINT))

        ixs.push(ixDepositSol(publicKey, lamports, pool, referralAta))
      } else {
        // Prefer the exact atom count captured by the 100%/max button
        // when present — round-tripping through the displayed string can
        // round up by 1 atom on certain balances and the burn would fail
        // on InsufficientFunds. Manual typing clears exactAtoms.
        const tokens =
          exactAtoms != null
            ? exactAtoms
            : BigInt(Math.floor(value * Math.pow(10, DECIMALS)))
        ixs.push(ixWithdrawSol(publicKey, tokens, pool))
      }

      const { blockhash } = await connection.getLatestBlockhash('confirmed')

      // Build BOTH a v0 and a legacy version from the same ix set. Phantom
      // mobile is happiest with v0; Trust mobile's adapter often errors on
      // v0 with cryptic messages ("invalid transaction format", "method
      // not supported"). Fallback chain: try v0 first, on any signing
      // failure rebuild + sign as legacy, surface the original error only
      // if BOTH paths fail.
      const v0Message = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message()
      const v0Tx = new VersionedTransaction(v0Message)

      setStatus({ state: 'signing', message: 'awaiting wallet signature…' })
      appendLog(`signing ${mode} ${value}…`)

      let signedSerialized: Uint8Array
      try {
        const signed = (await signTransaction(v0Tx)) as VersionedTransaction
        signedSerialized = signed.serialize()
      } catch (v0Err) {
        // Rebuild as a legacy Transaction and retry. Wallets that don't
        // support v0 (older Trust, some WalletConnect-bridged ones) take
        // legacy fine. We log the v0 error so we can see what the wallet
        // actually said in the appendLog stream.
        appendLog(
          `wallet rejected v0 (${(v0Err as Error).message?.slice(0, 80) ?? 'unknown'}) — retrying as legacy tx`,
        )
        const legacyTx = new Transaction({
          feePayer: publicKey,
          recentBlockhash: blockhash,
        })
        for (const ix of ixs) legacyTx.add(ix)
        try {
          // signTransaction's type is VersionedTransaction; the runtime
          // adapter accepts both shapes. Cast through `unknown` so TS
          // doesn't reject the cross-shape conversion at compile time.
          const signedLegacy = (await signTransaction(
            legacyTx as unknown as VersionedTransaction,
          )) as unknown as Transaction
          signedSerialized = signedLegacy.serialize()
        } catch (legacyErr) {
          // Both paths failed. Re-throw with both errors so the user can
          // see what's actually wrong.
          const v0Msg = (v0Err as Error).message ?? String(v0Err)
          const legacyMsg = (legacyErr as Error).message ?? String(legacyErr)
          throw new Error(
            `wallet rejected both v0 and legacy: v0=${v0Msg.slice(0, 100)} · legacy=${legacyMsg.slice(0, 100)}`,
          )
        }
      }

      setStatus({ state: 'sending', message: 'broadcasting…' })
      const sig = await connection.sendRawTransaction(signedSerialized)
      appendLog(`${mode} sent: ${sig}`)
      setStatus({ state: 'confirming', message: 'waiting for confirmation…', signature: sig })

      // HTTP polling, not the WebSocket-based connection.confirmTransaction.
      // Managed RPCs drop subscription sockets mid-call and hang forever.
      let confErr: unknown = null
      try {
        const { pollConfirmTransaction } = await import('../lib/zap')
        await pollConfirmTransaction(connection, sig, {
          blockhash,
          commitment: 'confirmed',
          timeoutMs: 60_000,
        })
      } catch (e) {
        confErr = e
      }
      if (confErr) {
        const err = (confErr as Error).message
        appendLog(`${mode} FAILED ${err}`)
        setStatus({ state: 'error', message: err, signature: sig })
        shake(cardRef.current)
      } else {
        appendLog(`${mode} confirmed → ${sig}`)
        const verb = mode === 'mint' ? 'minted' : 'burned'
        const unit = mode === 'mint' ? 'SOL → stacSOL' : 'stacSOL → SOL'
        setStatus({
          state: 'success',
          message: `${verb} ${value} ${unit}`,
          signature: sig,
        })
        if (mode === 'mint') fireMint()
        else fireBurn()
        setAmt('')
        setExactAtoms(null)
      }
      onDone()
    } catch (e) {
      const msg = summarizeError(e)
      appendLog(`${mode} error: ${msg}`)
      setStatus({ state: 'error', message: msg })
      shake(cardRef.current)
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'mint' ? 'Mint stacSOL' : 'Burn stacSOL'
  const placeholder = mode === 'mint' ? 'SOL amount' : 'stacSOL amount'
  const label = busy ? '…' : mode === 'mint' ? 'Mint' : 'Burn'
  const warn =
    mode === 'mint'
      ? 'deposit fee 6.9% on chain — receive ~93.1% of the pool token equivalent. ATA created idempotently.'
      : 'withdrawal fee 6.9% on chain — payout ≈ amount × current pool rate × 0.931. SOL returns from the reserve account; if the reserve is short, burn fails.'

  const unit = mode === 'mint' ? 'SOL' : 'stacSOL'
  const balanceLabel =
    maxAvailable != null
      ? `${maxAvailable.toFixed(mode === 'mint' ? 4 : 6)} ${unit}`
      : publicKey
      ? '…'
      : 'connect wallet'

  // For burn mode: if the user holds stacSOL in LP positions, surface the
  // breakdown so they don't think their balance dropped. WithdrawSol can
  // only burn from the wallet ATA — LP'd stacSOL has to be withdrawn first
  // (via /portfolio for DLMM, /liquidity for CPMM).
  const lpStacUi = Number(lpStacAtom) / Math.pow(10, DECIMALS)
  const showLpHint = mode === 'burn' && lpStacAtom > 0n && maxAvailable != null
  const totalStacUi = showLpHint ? (maxAvailable ?? 0) + lpStacUi : null

  // ---- "withdraw earned SOL only" affordance ------------------------------
  // Burn just enough wallet stacSOL to extract the profit (mark-to-NAV gain
  // above net-SOL-paid), keep the rest as "principal" still earning. Math:
  //
  //   keepStac = costSol / (rate × 0.931)   ← stac needed to back principal
  //   burnStac = walletBalance − keepStac   ← what to burn now
  //   payout  = burnStac × rate × 0.931    ← SOL the user receives
  //
  // Gated on:
  //   • burn mode
  //   • pool loaded (need NAV)
  //   • position has a wallet balance > 0
  //   • position has cost basis (real on-site mints, not just transfers in)
  //   • currently profitable on a partial burn (rate × 0.931 > cost/balance)
  //
  // The button just FILLS the input box — user still hits the main "Burn"
  // to actually sign. No surprise sends.
  const earnedHint = (() => {
    if (mode !== 'burn') return null
    if (!pool || pool.poolTokenSupplyAccounting <= 0n) return null
    if (!position || position.balance <= 0n) return null
    const rate =
      Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
    const burnPayoutFraction = 0.931
    const cost =
      position.totalSolIn > position.totalSolOut
        ? Number(position.totalSolIn - position.totalSolOut) / LAMPORTS_PER_SOL
        : 0
    if (cost <= 0) {
      return {
        kind: 'no-cost-basis' as const,
      }
    }
    const balanceUi = Number(position.balance) / Math.pow(10, DECIMALS)
    const fullBurnPayout = balanceUi * rate * burnPayoutFraction
    if (fullBurnPayout <= cost) {
      const breakeven = cost / (balanceUi * burnPayoutFraction)
      return {
        kind: 'underwater' as const,
        rate,
        breakeven,
      }
    }
    const keepStac = cost / (rate * burnPayoutFraction)
    const burnStac = Math.max(0, balanceUi - keepStac)
    const payoutSol = burnStac * rate * burnPayoutFraction
    return {
      kind: 'ready' as const,
      burnStac,
      keepStac,
      payoutSol,
      cost,
    }
  })()

  return (
    <div ref={cardRef}>
      <Card title={title}>
        <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
          <input
            type="number"
            min="0"
            step="0.001"
            value={amt}
            onChange={(e) => {
              // Manual edit invalidates the captured 100%/max bigint —
              // re-parse from the input string on submit.
              setExactAtoms(null)
              setAmt(e.target.value)
            }}
            placeholder={placeholder}
            className="w-full px-3 py-2 bg-[var(--color-bg)] text-[var(--color-fg)] border border-[rgb(255_51_0_/_0.4)] rounded font-[inherit] focus:outline-none focus:border-[var(--color-hot)]"
          />
          <button
            onClick={submit}
            disabled={disabled}
            className="px-4 py-2 bg-[var(--color-hot)] text-black font-bold uppercase tracking-wider rounded enabled:hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {label}
          </button>
        </div>

        <div className="mt-2 grid grid-cols-[auto_1fr] gap-2 items-center">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-dim)]">
            balance: <span className="text-[var(--color-fg)] font-mono">{balanceLabel}</span>
          </span>
          <div className="flex gap-1.5 justify-end">
            {[25, 50, 75, 100].map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPercent(p)}
                disabled={maxAvailable == null || maxAvailable <= 0 || busy}
                className="px-2 py-1 text-[10px] font-black uppercase tracking-wider border border-[rgb(255_51_0_/_0.35)] rounded text-[var(--color-hot)] enabled:hover:bg-[rgb(255_51_0_/_0.08)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {p === 100 && mode === 'mint' ? 'max' : `${p}%`}
              </button>
            ))}
          </div>
        </div>

        {earnedHint?.kind === 'ready' && (
          <button
            type="button"
            onClick={() => {
              setExactAtoms(null)
              setAmt(earnedHint.burnStac.toFixed(6))
            }}
            disabled={busy}
            className="mt-3 w-full px-3 py-3 text-left rounded border-2 border-[var(--color-green)] bg-[rgb(34_238_136_/_0.06)] hover:bg-[rgb(34_238_136_/_0.12)] transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-green)]">
              ↓ withdraw earned SOL only
            </div>
            <div className="mt-1.5 text-[12px] text-[var(--color-fg)] leading-snug">
              burn{' '}
              <span className="font-mono text-[var(--color-fg)]">
                {earnedHint.burnStac.toFixed(6)}
              </span>{' '}
              stacSOL · receive{' '}
              <span className="font-mono text-[var(--color-green)] font-black">
                +{earnedHint.payoutSol.toFixed(6)} SOL
              </span>
            </div>
            <div className="mt-1 text-[10px] text-[var(--color-dim)]">
              keeps{' '}
              <span className="font-mono text-[var(--color-fg)]">
                {earnedHint.keepStac.toFixed(6)}
              </span>{' '}
              stacSOL ≈ your{' '}
              <span className="font-mono text-[var(--color-fg)]">
                {earnedHint.cost.toFixed(6)} SOL
              </span>{' '}
              principal at current NAV — still earning. Tap to fill amount,
              then hit Burn.
            </div>
          </button>
        )}

        {earnedHint?.kind === 'underwater' && (
          <div className="mt-3 px-3 py-2 rounded border border-[rgb(255_204_0_/_0.35)] bg-[rgb(255_204_0_/_0.04)] text-[10px] text-[var(--color-dim)] leading-relaxed">
            <span className="text-[var(--color-warn)] font-black uppercase tracking-[2px]">
              earned-only unavailable
            </span>{' '}
            — full burn would still be underwater (current NAV{' '}
            <span className="font-mono text-[var(--color-fg)]">
              {earnedHint.rate.toFixed(6)}
            </span>
            , break-even at{' '}
            <span className="font-mono text-[var(--color-fg)]">
              {earnedHint.breakeven.toFixed(6)}
            </span>
            ). Hold — every bp of NAV climb is yours.
          </div>
        )}

        {showLpHint && totalStacUi != null && (
          <div className="mt-1.5 text-[10px] text-[var(--color-dim)] leading-relaxed space-y-1">
            <div>
              wallet shows{' '}
              <span className="text-[var(--color-fg)] font-mono">
                {(maxAvailable ?? 0).toFixed(6)}
              </span>{' '}
              burnable here ·{' '}
              <span className="text-[var(--color-warn)] font-mono">
                {lpStacUi.toFixed(6)}
              </span>{' '}
              in LP positions (total{' '}
              <span className="text-[var(--color-fg)] font-mono">
                {totalStacUi.toFixed(6)}
              </span>
              ). Burn here only acts on the wallet portion. Withdraw LPs via{' '}
              <a
                href="/portfolio"
                className="text-[var(--color-hot)] underline hover:text-[var(--color-ember)]"
              >
                /portfolio
              </a>{' '}
              first to burn the rest.
            </div>
            <div>
              <span className="text-[var(--color-green)]">earning:</span> the
              redemption rate climbs against{' '}
              <span className="text-[var(--color-fg)] font-mono">
                {totalStacUi.toFixed(6)}
              </span>{' '}
              stacSOL — wallet AND LP — so yield accrues on the full position.{' '}
              <span className="text-[var(--color-warn)]">IL risk:</span> the
              paired side of an LP can move independently. If the other token
              tanks (or goes to 0), that LP is fcukered regardless of NAV.
            </div>
          </div>
        )}

        {status && <StatusBanner status={status} onDismiss={() => setStatus(null)} />}

        <p className="mt-2 text-[11px] text-[var(--color-warn)]">{warn}</p>
      </Card>
    </div>
  )
}

function StatusBanner({
  status,
  onDismiss,
}: {
  status: ActionStatus
  onDismiss: () => void
}) {
  const tone =
    status.state === 'success'
      ? 'bg-[rgb(255_51_0_/_0.12)] text-[var(--color-hot)] border-[var(--color-hot)]'
      : status.state === 'error'
      ? 'bg-[rgb(255_204_0_/_0.10)] text-[var(--color-warn)] border-[var(--color-warn)]'
      : 'bg-[var(--color-bg)] text-[var(--color-fg)] border-[var(--color-dim)]'
  const icon =
    status.state === 'success'
      ? '✓'
      : status.state === 'error'
      ? '✗'
      : status.state === 'signing'
      ? '✎'
      : status.state === 'sending'
      ? '↗'
      : '⏳'
  // Errors get a beefier render: bold text, full message (no truncation),
  // and a long-press-to-copy hint so mobile users can share the actual
  // error verbatim instead of "it doesn't work". Other states stay compact.
  const isError = status.state === 'error'
  return (
    <div
      className={`mt-2 flex items-start gap-2 px-3 py-2 border rounded ${
        isError ? 'text-[13px]' : 'text-[12px]'
      } ${tone}`}
    >
      <span className="text-base leading-none mt-[2px]">{icon}</span>
      <div className="flex-1 min-w-0">
        <div
          className={`break-words ${isError ? 'font-bold select-all' : ''}`}
        >
          {status.message}
        </div>
        {isError && (
          <div className="mt-1 text-[10px] opacity-70 uppercase tracking-wider">
            tap-and-hold to copy · screenshot + send to @notstacc on tg
          </div>
        )}
        {status.signature && (
          <a
            href={`https://solscan.io/tx/${status.signature}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] uppercase tracking-wider underline opacity-80 hover:opacity-100"
          >
            view on solscan ↗
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="text-[10px] uppercase tracking-wider opacity-60 hover:opacity-100"
        aria-label="dismiss"
      >
        ✕
      </button>
    </div>
  )
}
