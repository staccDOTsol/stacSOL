// /trade — curve-launchpad buy/sell UI, routed via stacSOL.
//
// User types SOL on buy / MEME on sell. Composes the transaction as:
//   buy:  [createAta, depositSol→stacSOL, curve.buy]
//   sell: [createAta, curve.sell, withdrawSol→SOL]
//
// All LST mechanics are hidden behind a "routed via LST (yield-bearing)"
// subtitle on each input. The user never sees a stacSOL balance on this page
// — they think SOL in, SOL out, with a 6.9% pool fee on each Sanctum hop +
// the curve's own fee on top. See `lib/sanctum-route.ts` for the composer.
//
// Curve mint is passed via `?mint=<pubkey>` query param. We render an empty
// state when no mint is set so the route is still loadable without a curve
// selected (useful for design/sanity checks).

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useConnection,
  useWallet,
} from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { getAccount, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { usePool } from './hooks/usePool'
import { useSolBalance } from './hooks/useSolBalance'
import {
  CURVE_LAUNCHPAD_PROGRAM_ID,
  deriveBondingCurve,
  deriveGlobal,
  parseBondingCurve,
  parseGlobal,
  type BondingCurveState,
  type GlobalState,
} from './lib/curve-launchpad'
import { buildBuy, buildSell, previewSolToLst, previewLstToSol } from './lib/sanctum-route'
import { fireBurn, fireMint, shake, summarizeError } from './lib/confetti'

const MEME_DECIMALS = 6 // matches DEFAULT_DECIMALS in curve-launchpad

interface Status {
  state: 'signing' | 'sending' | 'confirming' | 'success' | 'error'
  message: string
  signature?: string
}

function parseMintFromUrl(): PublicKey | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('mint')
  if (!raw) return null
  try {
    return new PublicKey(raw)
  } catch {
    return null
  }
}

export default function Trade() {
  const { connection } = useConnection()
  const { publicKey, signTransaction } = useWallet()
  const { pool } = usePool()
  const solLamports = useSolBalance(publicKey)

  const mint = useMemo(parseMintFromUrl, [])

  const [global, setGlobal] = useState<GlobalState | null>(null)
  const [curve, setCurve] = useState<BondingCurveState | null>(null)
  const [memeBalance, setMemeBalance] = useState<bigint>(0n)

  const [mode, setMode] = useState<'buy' | 'sell'>('buy')
  const [amt, setAmt] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const [log, setLog] = useState<string[]>([])
  const cardRef = useRef<HTMLDivElement>(null)

  const appendLog = (m: string) =>
    setLog((cur) => [...cur.slice(-30), `${new Date().toLocaleTimeString()} · ${m}`])

  // Body design — match the editorial palette used on /app, /portfolio, etc.
  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  // Load Global + BondingCurve once + on focus.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const globalPda = deriveGlobal()
        const gAcc = await connection.getAccountInfo(globalPda, 'processed')
        if (cancelled) return
        if (gAcc) setGlobal(parseGlobal(gAcc.data))

        if (mint) {
          const bcPda = deriveBondingCurve(mint)
          const bcAcc = await connection.getAccountInfo(bcPda, 'processed')
          if (cancelled) return
          if (bcAcc) setCurve(parseBondingCurve(bcAcc.data))
        }
      } catch (e) {
        appendLog(`load error: ${(e as Error).message}`)
      }
    }
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
    }
  }, [connection, mint])

  // Poll user's MEME balance.
  useEffect(() => {
    if (!publicKey || !mint) {
      setMemeBalance(0n)
      return
    }
    let cancelled = false
    const tick = async () => {
      try {
        const ata = PublicKey.findProgramAddressSync(
          [publicKey.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
          new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
        )[0]
        const acc = await getAccount(connection, ata, 'processed', TOKEN_PROGRAM_ID).catch(
          () => null,
        )
        if (cancelled) return
        setMemeBalance(acc ? acc.amount : 0n)
      } catch {
        if (!cancelled) setMemeBalance(0n)
      }
    }
    tick()
    const id = window.setInterval(tick, 10_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [connection, publicKey, mint])

  // --- Quote preview ---------------------------------------------------------
  const numericAmt = Number(amt)
  const haveAmt = Number.isFinite(numericAmt) && numericAmt > 0

  const preview = useMemo(() => {
    if (!curve || !global || !haveAmt || !pool) return null
    if (mode === 'buy') {
      // SOL → LST → MEME estimation
      const lamports = BigInt(Math.floor(numericAmt * LAMPORTS_PER_SOL))
      const lstAtoms = previewSolToLst(lamports, pool)
      // Invert curve buy: given LST in (after fee), find MEME out. Closed form
      // is straightforward — x = product / (Q + lstAfterCurveFee) - virtTok.
      const feeBps = global.feeBasisPoints
      const lstAfterCurveFee = (lstAtoms * 10000n) / (10000n + feeBps)
      const product = curve.virtualQuoteReserves * curve.virtualTokenReserves
      const newVirtTok = product / (curve.virtualQuoteReserves + lstAfterCurveFee)
      const memeOut =
        newVirtTok >= curve.virtualTokenReserves
          ? 0n
          : curve.virtualTokenReserves - newVirtTok
      const capped =
        memeOut > curve.realTokenReserves ? curve.realTokenReserves : memeOut
      return {
        lst: lstAtoms,
        meme: capped,
      }
    } else {
      // MEME → LST → SOL estimation
      const memeAtoms = BigInt(Math.floor(numericAmt * 10 ** MEME_DECIMALS))
      const newVirtTok = curve.virtualTokenReserves + memeAtoms
      const scaled = memeAtoms * global.initialVirtualTokenReserves
      const prop = scaled / newVirtTok
      let lstGross = (curve.virtualQuoteReserves * prop) / global.initialVirtualTokenReserves
      if (lstGross > curve.realQuoteReserves) lstGross = curve.realQuoteReserves
      const fee = (lstGross * global.feeBasisPoints) / 10000n
      const lstNet = lstGross - fee
      const solOut = previewLstToSol(lstNet, pool)
      return {
        lst: lstNet,
        meme: memeAtoms,
        sol: solOut,
      }
    }
  }, [curve, global, pool, mode, haveAmt, numericAmt])

  const setPercent = (pct: number) => {
    if (mode === 'sell') {
      if (memeBalance <= 0n) return
      const ui = (Number(memeBalance) / 10 ** MEME_DECIMALS) * (pct / 100)
      setAmt(ui.toFixed(MEME_DECIMALS))
    } else {
      if (solLamports == null) return
      const balance = solLamports / LAMPORTS_PER_SOL
      const reserve = pct === 100 ? 0.01 : 0
      const ui = Math.max(0, balance * (pct / 100) - reserve)
      setAmt(ui.toFixed(6))
    }
  }

  const disabled =
    !mint || !pool || !global || !curve || !publicKey || !signTransaction || busy || !haveAmt

  const submit = async () => {
    if (!mint || !pool || !global || !curve || !publicKey || !signTransaction) return
    if (!haveAmt) return
    setBusy(true)
    try {
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ]
      const feeRecipient = global.feeRecipient

      if (mode === 'buy') {
        const lamports = BigInt(Math.floor(numericAmt * LAMPORTS_PER_SOL))
        if (!preview) throw new Error('preview not ready')
        const tokenAmount = preview.meme
        if (tokenAmount <= 0n) throw new Error('quote yields 0 MEME — try a larger SOL amount')
        const built = buildBuy({
          user: publicKey,
          mint,
          solLamports: lamports,
          tokenAmount,
          pool,
          global,
          bondingCurve: curve,
          feeRecipient,
        })
        ixs.push(...built.ixs)
        appendLog(
          `buy: ${lamports} lamports SOL → ~${built.lstExpected} LST atoms → ${tokenAmount} MEME atoms (max_quote_cost=${built.maxQuoteCost})`,
        )
      } else {
        const tokens = BigInt(Math.floor(numericAmt * 10 ** MEME_DECIMALS))
        if (tokens <= 0n) throw new Error('amount must be > 0')
        const built = buildSell({
          user: publicKey,
          mint,
          tokenAmount: tokens,
          pool,
          global,
          bondingCurve: curve,
          feeRecipient,
        })
        ixs.push(...built.ixs)
        appendLog(
          `sell: ${tokens} MEME atoms → ~${built.lstExpected} LST → ~${built.solExpected} lamports SOL (min_quote_output=${built.minQuoteOutput})`,
        )
      }

      const { blockhash } = await connection.getLatestBlockhash('confirmed')

      // v0 → legacy fallback, same shape as Action.tsx.
      const v0 = new VersionedTransaction(
        new TransactionMessage({
          payerKey: publicKey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      )

      setStatus({ state: 'signing', message: 'awaiting wallet signature…' })
      let signedSerialized: Uint8Array
      try {
        const signed = (await signTransaction(v0)) as VersionedTransaction
        signedSerialized = signed.serialize()
      } catch (v0Err) {
        appendLog(`wallet rejected v0 (${(v0Err as Error).message?.slice(0, 80) ?? '?'}) — retry legacy`)
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

      try {
        const { pollConfirmTransaction } = await import('./lib/zap')
        await pollConfirmTransaction(connection, sig, {
          blockhash,
          commitment: 'confirmed',
          timeoutMs: 60_000,
        })
      } catch (e) {
        const msg = (e as Error).message
        appendLog(`${mode} confirm error: ${msg}`)
        setStatus({ state: 'error', message: msg, signature: sig })
        shake(cardRef.current)
        return
      }

      setStatus({ state: 'success', message: `${mode} confirmed`, signature: sig })
      if (mode === 'buy') fireMint()
      else fireBurn()
      setAmt('')
      // refresh on success
      try {
        const bcPda = deriveBondingCurve(mint)
        const bcAcc = await connection.getAccountInfo(bcPda, 'processed')
        if (bcAcc) setCurve(parseBondingCurve(bcAcc.data))
      } catch {
        // ignore — UI will refresh on next focus
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

  // -------------- render --------------
  if (!mint) {
    return (
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '96px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 32 }}>
          <WalletMultiButton />
        </div>
        <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.01em' }}>Trade</h1>
        <p style={{ marginTop: 12, color: 'var(--color-dim, #999)' }}>
          No curve selected. Append <code>?mint=&lt;pubkey&gt;</code> to the URL to load a
          launchpad curve.
        </p>
      </main>
    )
  }

  const solBalanceUi = solLamports != null ? solLamports / LAMPORTS_PER_SOL : null
  const memeBalanceUi = Number(memeBalance) / 10 ** MEME_DECIMALS
  const balanceLabel =
    mode === 'buy'
      ? solBalanceUi != null
        ? `${solBalanceUi.toFixed(4)} SOL`
        : publicKey
          ? '…'
          : 'connect wallet'
      : memeBalance > 0n
        ? `${memeBalanceUi.toFixed(MEME_DECIMALS)} tokens`
        : publicKey
          ? '0 tokens'
          : 'connect wallet'

  const previewLabel = (() => {
    if (!preview) return null
    if (mode === 'buy') {
      const memeUi = Number(preview.meme) / 10 ** MEME_DECIMALS
      return `≈ ${memeUi.toFixed(4)} tokens out`
    } else {
      const solUi = Number(preview.sol ?? 0n) / LAMPORTS_PER_SOL
      return `≈ ${solUi.toFixed(6)} SOL out`
    }
  })()

  return (
    <>
      <main style={{ maxWidth: 720, margin: '0 auto', padding: '32px 24px 96px' }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 32 }}>
          <WalletMultiButton />
        </div>
        <h1 style={{ fontSize: 32, fontWeight: 900, letterSpacing: '-0.01em' }}>Trade</h1>
        <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-dim, #888)' }}>
          curve {mint.toBase58().slice(0, 6)}…{mint.toBase58().slice(-6)} ·{' '}
          program {CURVE_LAUNCHPAD_PROGRAM_ID.toBase58().slice(0, 6)}…
        </div>

        <div
          ref={cardRef}
          style={{
            marginTop: 32,
            padding: 24,
            border: '1px solid rgb(0 0 0 / 0.12)',
            borderRadius: 8,
          }}
        >
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            <button
              type="button"
              onClick={() => setMode('buy')}
              disabled={busy}
              style={{
                padding: '8px 20px',
                fontSize: 12,
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                background: mode === 'buy' ? 'var(--accent-deep)' : 'transparent',
                color: mode === 'buy' ? 'var(--bg)' : 'var(--color-fg)',
                border: '1px solid rgb(0 0 0 / 0.2)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Buy
            </button>
            <button
              type="button"
              onClick={() => setMode('sell')}
              disabled={busy}
              style={{
                padding: '8px 20px',
                fontSize: 12,
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '0.15em',
                background: mode === 'sell' ? 'var(--accent-deep)' : 'transparent',
                color: mode === 'sell' ? 'var(--bg)' : 'var(--color-fg)',
                border: '1px solid rgb(0 0 0 / 0.2)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              Sell
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              min="0"
              step={mode === 'buy' ? '0.001' : '0.000001'}
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              placeholder={mode === 'buy' ? 'SOL amount' : 'MEME amount'}
              style={{
                width: '100%',
                padding: '10px 12px',
                background: 'var(--color-bg, #fff)',
                color: 'var(--color-fg, #000)',
                border: '1px solid rgb(0 0 0 / 0.25)',
                borderRadius: 4,
                fontFamily: 'inherit',
                fontSize: 16,
              }}
            />
            <button
              onClick={submit}
              disabled={disabled}
              style={{
                padding: '10px 20px',
                background: 'var(--accent-deep)',
                color: 'var(--bg)',
                fontWeight: 900,
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                border: 'none',
                borderRadius: 4,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
              }}
            >
              {busy ? '…' : mode === 'buy' ? 'Buy' : 'Sell'}
            </button>
          </div>

          {/* Subtitle on the trade input — transparency about LST routing. */}
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--color-dim, #888)',
            }}
          >
            routed via LST (yield-bearing)
          </div>

          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.15em', color: 'var(--color-dim, #888)' }}>
              balance: <span style={{ fontFamily: 'monospace' }}>{balanceLabel}</span>
            </span>
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {[25, 50, 75, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPercent(p)}
                  disabled={busy}
                  style={{
                    padding: '4px 8px',
                    fontSize: 10,
                    fontWeight: 900,
                    textTransform: 'uppercase',
                    letterSpacing: '0.15em',
                    border: '1px solid rgb(0 0 0 / 0.25)',
                    borderRadius: 4,
                    background: 'transparent',
                    color: 'var(--color-fg)',
                    cursor: 'pointer',
                  }}
                >
                  {p === 100 ? 'max' : `${p}%`}
                </button>
              ))}
            </div>
          </div>

          {previewLabel && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: 'rgb(0 0 0 / 0.04)',
                borderRadius: 4,
                fontSize: 13,
                fontFamily: 'monospace',
              }}
            >
              {previewLabel}
            </div>
          )}

          {status && (
            <div
              style={{
                marginTop: 16,
                padding: 12,
                borderRadius: 4,
                fontSize: 12,
                background:
                  status.state === 'success'
                    ? 'rgb(34 238 136 / 0.1)'
                    : status.state === 'error'
                      ? 'rgb(255 51 0 / 0.1)'
                      : 'rgb(0 0 0 / 0.04)',
              }}
            >
              <div style={{ fontWeight: 700 }}>{status.message}</div>
              {status.signature && (
                <a
                  href={`https://solscan.io/tx/${status.signature}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ fontFamily: 'monospace', fontSize: 11 }}
                >
                  {status.signature.slice(0, 12)}…{status.signature.slice(-8)}
                </a>
              )}
            </div>
          )}

          {curve && global && (
            <div
              style={{
                marginTop: 24,
                paddingTop: 16,
                borderTop: '1px solid rgb(0 0 0 / 0.1)',
                fontSize: 11,
                color: 'var(--color-dim, #888)',
                fontFamily: 'monospace',
                display: 'grid',
                gap: 4,
              }}
            >
              <div>
                real LST reserves:{' '}
                {(Number(curve.realQuoteReserves) / 1e9).toFixed(4)} stacSOL
              </div>
              <div>
                real MEME reserves:{' '}
                {(Number(curve.realTokenReserves) / 10 ** MEME_DECIMALS).toLocaleString()}
              </div>
              <div>fee: {Number(global.feeBasisPoints) / 100}%</div>
              <div>complete: {curve.complete ? 'yes' : 'no'}</div>
            </div>
          )}
        </div>

        {log.length > 0 && (
          <details
            style={{
              marginTop: 24,
              fontSize: 11,
              fontFamily: 'monospace',
              color: 'var(--color-dim, #888)',
            }}
          >
            <summary style={{ cursor: 'pointer' }}>log</summary>
            <div style={{ marginTop: 8, display: 'grid', gap: 2 }}>
              {log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </details>
        )}
      </main>
    </>
  )
}
