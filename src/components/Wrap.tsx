import { useEffect, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import {
  ComputeBudgetProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { Card } from './Stats'
import { DECIMALS, MINT, TOKEN_2022 } from '../lib/constants'
import { deriveAta, ixCreateAtaIdempotent } from '../lib/ix'
import {
  STACSOL_FEE_BPS,
  WSTACSOL_MINT,
} from '../lib/wrapper-constants'
import {
  WSTACSOL_TOKEN_PROGRAM,
  deriveWrapAtas,
  ixCreateWrappedAtaIdempotent,
  ixUnwrap,
  ixWrap,
} from '../lib/wrapper-ix'
import { fireBurn, fireMint, shake, summarizeError } from '../lib/confetti'

type Mode = 'wrap' | 'unwrap'

interface ActionStatus {
  state: 'signing' | 'sending' | 'confirming' | 'success' | 'error'
  message: string
  signature?: string
}

// Estimated user-side payout after the underlying's TransferFee.
// Wrap:   gross stacSOL → minted wstacSOL = gross × (1 − fee)
// Unwrap: burned wstacSOL → received stacSOL = burned × (1 − fee)
// (Fee is on the underlying T22 transfer in both directions because:
//  wrap = user → vault transfer; unwrap = vault → user transfer.)
const feeMultiplier = (1 - STACSOL_FEE_BPS / 10_000)

export function Wrap({
  onDone,
  appendLog,
}: {
  onDone: () => void
  appendLog: (msg: string) => void
}) {
  const { connection } = useConnection()
  const { publicKey, signTransaction } = useWallet()
  const [mode, setMode] = useState<Mode>('wrap')
  const [amt, setAmt] = useState('')
  // Set by the 100% / max button so submit can use the exact bigint
  // (balance − 1 atom) instead of re-parsing the displayed string and
  // risking a round-up that pushes the wrap/unwrap input over the
  // actual on-chain balance. Cleared on any manual edit, mode toggle,
  // or successful submit.
  const [exactAtoms, setExactAtoms] = useState<bigint | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<ActionStatus | null>(null)
  const [stacBalance, setStacBalance] = useState<bigint | null>(null)
  const [wstacBalance, setWstacBalance] = useState<bigint | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)

  // Balance poll for both stacSOL (T22) and wstacSOL (SPL). Same RPC tier as
  // the rest of the page so we coalesce naturally — no fancy hook needed.
  useEffect(() => {
    if (!publicKey) {
      setStacBalance(null)
      setWstacBalance(null)
      return
    }
    let cancelled = false
    const stacAta = deriveAta(publicKey, MINT, TOKEN_2022)
    const { wrapped: wstacAta } = deriveWrapAtas(publicKey)

    const poll = async () => {
      try {
        const [stacAcc, wstacAcc] = await connection.getMultipleAccountsInfo(
          [stacAta, wstacAta],
          'processed',
        )
        if (cancelled) return
        // Both SPL & T22 token accounts store `amount` at offset 64.
        setStacBalance(stacAcc ? stacAcc.data.readBigUInt64LE(64) : 0n)
        setWstacBalance(wstacAcc ? wstacAcc.data.readBigUInt64LE(64) : 0n)
      } catch {
        /* RPC blip */
      }
    }
    poll()
    const id = setInterval(poll, 10_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [connection, publicKey])

  const sourceBalance = mode === 'wrap' ? stacBalance : wstacBalance
  const sourceLabel = mode === 'wrap' ? 'stacSOL' : 'wstacSOL'
  const destLabel = mode === 'wrap' ? 'wstacSOL' : 'stacSOL'

  const sourceUi = sourceBalance != null ? Number(sourceBalance) / 10 ** DECIMALS : null
  const amtNum = Number(amt)
  const estimatedOut = Number.isFinite(amtNum) && amtNum > 0 ? amtNum * feeMultiplier : 0

  const setPercent = (pct: number) => {
    if (sourceUi == null || sourceUi <= 0) return
    // 100%/max: lock the exact (balance − 1 atom) bigint so the submit
    // path can use it directly. toFixed(6) on the displayed string can
    // round UP for certain balances (e.g. 0.7477006 → "0.747701"),
    // pushing the on-chain transfer over actual balance and failing.
    if (pct === 100 && sourceBalance != null && sourceBalance > 0n) {
      const atoms = sourceBalance - 1n
      setExactAtoms(atoms)
      setAmt((Number(atoms) / 10 ** DECIMALS).toFixed(9))
      return
    }
    setExactAtoms(null)
    const raw = (sourceUi * pct) / 100
    setAmt(raw > 0 ? raw.toFixed(6) : '')
  }

  const disabled =
    !publicKey || !signTransaction || busy || !amt || amtNum <= 0 ||
    (sourceUi != null && amtNum > sourceUi + 1e-9)

  const submit = async () => {
    if (!publicKey || !signTransaction) return
    if (!Number.isFinite(amtNum) || amtNum <= 0) return
    setBusy(true)
    try {
      // Prefer the captured 100%/max bigint when present; falls back to
      // re-parsing the displayed string on any other amount. Submit-time
      // float math can round up by 1 atom on certain balances which is
      // exactly the failure mode this whole branch exists to prevent.
      const raw =
        exactAtoms != null
          ? exactAtoms
          : BigInt(Math.floor(amtNum * 10 ** DECIMALS))

      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ]

      // Pre-create ATAs only when missing (saves bytes + helps Phantom
      // mobile's parser — mirrors the pattern from `Action.tsx`).
      const stacAta = deriveAta(publicKey, MINT, TOKEN_2022)
      const { wrapped: wstacAta } = deriveWrapAtas(publicKey)
      const accChecks = await connection.getMultipleAccountsInfo(
        [stacAta, wstacAta],
        'processed',
      )
      const stacAtaExists = accChecks[0] != null
      const wstacAtaExists = accChecks[1] != null

      if (mode === 'wrap') {
        // user_underlying_ata must already exist (program reads it as `mut`,
        // not `init_if_needed`). user_wrapped_ata is init_if_needed
        // program-side, but we still create it client-side to keep the wrap
        // ix's account-meta count predictable for wallets that struggle with
        // init_if_needed sizing.
        if (!stacAtaExists) ixs.push(ixCreateAtaIdempotent(publicKey, publicKey, MINT, TOKEN_2022))
        if (!wstacAtaExists) ixs.push(ixCreateWrappedAtaIdempotent(publicKey, publicKey))
        ixs.push(ixWrap(publicKey, raw))
      } else {
        // unwrap: user_wrapped_ata must exist (we burn from it). user_under
        // ata is init_if_needed program-side; explicit create kept for
        // parser consistency.
        if (!stacAtaExists) ixs.push(ixCreateAtaIdempotent(publicKey, publicKey, MINT, TOKEN_2022))
        ixs.push(ixUnwrap(publicKey, raw))
      }

      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      const v0Msg = new TransactionMessage({
        payerKey: publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
      }).compileToV0Message()
      const v0Tx = new VersionedTransaction(v0Msg)

      setStatus({ state: 'signing', message: 'awaiting wallet signature…' })
      appendLog(`signing ${mode} ${amtNum}…`)

      let signedSerialized: Uint8Array
      try {
        const signed = (await signTransaction(v0Tx)) as VersionedTransaction
        signedSerialized = signed.serialize()
      } catch (v0Err) {
        // Fallback to legacy for adapters that choke on v0 (older Trust etc.).
        appendLog(
          `wallet rejected v0 (${(v0Err as Error).message?.slice(0, 80) ?? 'unknown'}) — retrying legacy`,
        )
        const legacy = new Transaction({ feePayer: publicKey, recentBlockhash: blockhash })
        for (const ix of ixs) legacy.add(ix)
        const signedLegacy = (await signTransaction(
          legacy as unknown as VersionedTransaction,
        )) as unknown as Transaction
        signedSerialized = signedLegacy.serialize()
      }

      setStatus({ state: 'sending', message: 'broadcasting…' })
      const sig = await connection.sendRawTransaction(signedSerialized)
      appendLog(`${mode} sent: ${sig}`)
      setStatus({ state: 'confirming', message: 'waiting for confirmation…', signature: sig })

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
        const verb = mode === 'wrap' ? 'wrapped' : 'unwrapped'
        setStatus({
          state: 'success',
          message: `${verb} ${amtNum} ${sourceLabel} → ~${estimatedOut.toFixed(6)} ${destLabel}`,
          signature: sig,
        })
        if (mode === 'wrap') fireMint()
        else fireBurn()
        setAmt('')
        setExactAtoms(null)
        onDone()
      }
    } catch (e) {
      const msg = summarizeError(e)
      appendLog(`${mode} error: ${msg}`)
      setStatus({ state: 'error', message: msg })
      shake(cardRef.current)
    } finally {
      setBusy(false)
    }
  }

  const balanceLabel =
    sourceUi != null
      ? `${sourceUi.toFixed(6)} ${sourceLabel}`
      : publicKey
      ? '…'
      : 'connect wallet'

  return (
    <div ref={cardRef}>
      <Card title={mode === 'wrap' ? 'Wrap → wstacSOL' : 'Unwrap → stacSOL'}>
        {/* mode toggle */}
        <div className="mb-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => { setMode('wrap'); setExactAtoms(null); setAmt(''); setStatus(null) }}
            className={`px-3 py-2 rounded text-[11px] font-black uppercase tracking-[2px] transition ${
              mode === 'wrap'
                ? 'bg-[var(--color-hot)] text-black'
                : 'bg-[rgb(255_34_0_/_0.06)] text-[var(--color-hot)] border border-[rgb(255_34_0_/_0.4)] hover:bg-[rgb(255_34_0_/_0.12)]'
            }`}
          >
            stacSOL → wstacSOL
          </button>
          <button
            type="button"
            onClick={() => { setMode('unwrap'); setExactAtoms(null); setAmt(''); setStatus(null) }}
            className={`px-3 py-2 rounded text-[11px] font-black uppercase tracking-[2px] transition ${
              mode === 'unwrap'
                ? 'bg-[var(--color-warn)] text-black'
                : 'bg-[rgb(255_204_0_/_0.06)] text-[var(--color-warn)] border border-[rgb(255_204_0_/_0.4)] hover:bg-[rgb(255_204_0_/_0.12)]'
            }`}
          >
            wstacSOL → stacSOL
          </button>
        </div>

        <div className="grid grid-cols-[1fr_auto] gap-2 items-center">
          <input
            type="number"
            min="0"
            step="0.001"
            value={amt}
            onChange={(e) => {
              // Manual edit invalidates the captured max bigint —
              // re-parse from the input on submit.
              setExactAtoms(null)
              setAmt(e.target.value)
            }}
            placeholder={`${sourceLabel} amount`}
            className="w-full px-3 py-2 bg-[var(--color-bg)] text-[var(--color-fg)] border border-[rgb(255_51_0_/_0.4)] rounded font-[inherit] focus:outline-none focus:border-[var(--color-hot)]"
          />
          <button
            onClick={submit}
            disabled={disabled}
            className={`px-4 py-2 text-black font-bold uppercase tracking-wider rounded enabled:hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed ${
              mode === 'wrap' ? 'bg-[var(--color-hot)]' : 'bg-[var(--color-warn)]'
            }`}
          >
            {busy ? '…' : mode === 'wrap' ? 'Wrap' : 'Unwrap'}
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
                disabled={sourceUi == null || sourceUi <= 0 || busy}
                className="px-2 py-1 text-[10px] font-black uppercase tracking-wider border border-[rgb(255_51_0_/_0.35)] rounded text-[var(--color-hot)] enabled:hover:bg-[rgb(255_51_0_/_0.08)] disabled:opacity-30 disabled:cursor-not-allowed"
              >
                {p}%
              </button>
            ))}
          </div>
        </div>

        {amtNum > 0 && Number.isFinite(amtNum) && (
          <div className="mt-3 px-3 py-2 rounded border border-[rgb(255_51_0_/_0.25)] bg-[rgb(255_51_0_/_0.04)] text-[11px] text-[var(--color-dim)] leading-relaxed">
            you send{' '}
            <span className="font-mono text-[var(--color-fg)]">
              {amtNum.toFixed(6)}
            </span>{' '}
            {sourceLabel} · receive{' '}
            <span className="font-mono text-[var(--color-hot)] font-black">
              ~{estimatedOut.toFixed(6)} {destLabel}
            </span>{' '}
            (after {(STACSOL_FEE_BPS / 100).toFixed(1)}% stacSOL transfer fee)
          </div>
        )}

        {status && <StatusBanner status={status} onDismiss={() => setStatus(null)} />}

        <p className="mt-2 text-[11px] text-[var(--color-warn)]">
          {mode === 'wrap'
            ? `wraps stacSOL (T22, ${(STACSOL_FEE_BPS / 100).toFixed(1)}% fee) → wstacSOL (plain SPL, no fee, AMM-friendly). Vault holds 1:1 underlying.`
            : `burns wstacSOL, returns stacSOL from vault. The ${(STACSOL_FEE_BPS / 100).toFixed(1)}% T22 fee applies on the vault → you transfer.`}
        </p>

        <p className="mt-1 text-[10px] text-[var(--color-dim)] font-mono">
          wstacSOL mint: {WSTACSOL_MINT.toBase58()}
        </p>
        <p className="mt-0.5 text-[10px] text-[var(--color-dim)] font-mono">
          wstacSOL token program: {WSTACSOL_TOKEN_PROGRAM.toBase58().slice(0, 8)}… (SPL)
        </p>
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
    status.state === 'success' ? '✓'
    : status.state === 'error' ? '✗'
    : status.state === 'signing' ? '✎'
    : status.state === 'sending' ? '↗'
    : '⏳'
  const isError = status.state === 'error'
  return (
    <div className={`mt-2 flex items-start gap-2 px-3 py-2 border rounded ${isError ? 'text-[13px]' : 'text-[12px]'} ${tone}`}>
      <span className="text-base leading-none mt-[2px]">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className={`break-words ${isError ? 'font-bold select-all' : ''}`}>
          {status.message}
        </div>
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
