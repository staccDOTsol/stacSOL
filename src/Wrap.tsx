// stacSOL — /wrap surface. Dedicated lander for people who need
// **wstacSOL** (the plain-SPL wrapped form) for venues that can't handle
// Token-2022 transfer-fee accounting — most notably ride.markets/funds/stacc.
//
// Two one-click flows:
//
//   STAKE & WRAP   — SOL → stacSOL (DepositSol) → wstacSOL (Wrap)   one tx
//   UNWRAP & UNSTAKE — wstacSOL → stacSOL (Unwrap) → SOL (WithdrawSol) one tx
//
// Each path bundles the SPL stake-pool ix and the wrapper ix into a single
// VersionedTransaction so the user signs once and gets the final asset
// directly. No bouncing through /app, no two-step UX.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import EditorialNav from './components/EditorialNav'
import { ReferralCard } from './components/ReferralCard'
import { usePool } from './hooks/usePool'
import { useSolBalance } from './hooks/useSolBalance'
import { useStacBalance } from './hooks/useStacBalance'
import { useWstacBalance } from './hooks/useWstacBalance'
import { useEpoch } from './hooks/useEpoch'
import {
  deriveAta,
  ixCreateAtaIdempotent,
  ixDepositSol,
  ixWithdrawSol,
} from './lib/ix'
import {
  ixWrap,
  ixUnwrap,
  ixCreateWrappedAtaIdempotent,
} from './lib/wrapper-ix'
import { deriveReferrerAtaAndCreateIx, useReferrer } from './lib/referrer'
import { DECIMALS, MINT, TOKEN_2022 } from './lib/constants'
import { fireBurn, fireMint, summarizeError } from './lib/confetti'

const FEE = 0.069

// Default precision bumped 4 → 6 to match App/Mobile/format.ts. See
// lib/format.ts fmtAmount for the rationale (small token amounts no longer
// round to 0.0000).
function fmt(n: number | null | undefined, d = 6): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

type Status =
  | { s: 'signing'; m: string }
  | { s: 'sending'; m: string }
  | { s: 'confirming'; m: string; sig: string }
  | { s: 'ok'; m: string; sig: string }
  | { s: 'err'; m: string }

// -----------------------------------------------------------------------------
// Stake & Wrap — SOL → stacSOL → wstacSOL in one signed tx
// -----------------------------------------------------------------------------
function StakeAndWrapCard({
  rate,
  walletSol,
  staleByEpochs,
  onDone,
}: {
  rate: number
  walletSol: number | null
  staleByEpochs: number
  onDone: () => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const modal = useWalletModal()
  const { pool } = usePool()
  const ref = useReferrer()
  const [amt, setAmt] = useState('')
  const [activePct, setActivePct] = useState<number | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  const maxAvailable = Math.max(0, (walletSol ?? 0) - 0.01)
  const num = Number(amt) || 0
  // SOL → stacSOL via DepositSol pays a 6.9% protocol fee on top of NAV.
  // Then stacSOL → wstacSOL pays the 6.9% Token-2022 transfer fee on the
  // user→vault leg. Composed: net = num/rate * 0.931 * 0.931.
  const expected = useMemo(() => {
    if (!num) return 0
    return (num / rate) * (1 - FEE) * (1 - FEE)
  }, [num, rate])

  const setPercent = (p: number) => {
    setActivePct(p)
    setAmt(((maxAvailable * p) / 100).toFixed(4))
  }

  const busy = !!status && status.s !== 'ok' && status.s !== 'err'
  const disabled =
    !pool ||
    !num ||
    num <= 0 ||
    num > maxAvailable ||
    staleByEpochs > 0 ||
    busy

  const submit = async () => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      modal.setVisible(true)
      return
    }
    if (!pool) return
    const value = Number(amt)
    if (!Number.isFinite(value) || value <= 0) return
    try {
      setStatus({ s: 'signing', m: 'Awaiting wallet signature…' })
      const pubkey = wallet.publicKey
      const lamports = BigInt(Math.floor(value * LAMPORTS_PER_SOL))
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ]
      // Idempotent ATA creates — user's stacSOL ATA + wrapped (legacy SPL)
      // ATA. The stake-pool manager fee account is already a Token-2022
      // account stored in pool state; it is not a wallet owner to derive an
      // ATA from.
      const userStacAta = deriveAta(pubkey, MINT, TOKEN_2022)
      const acc = await connection.getAccountInfo(userStacAta, 'processed')
      if (!acc) ixs.push(ixCreateAtaIdempotent(pubkey, pubkey, MINT))
      ixs.push(ixCreateWrappedAtaIdempotent(pubkey, pubkey))
      // Referrer ATA gets 50% of the 6.9% deposit fee (the other 50% goes
      // to the pool manager's fee account). Without this slot the
      // referrer share silently routes back to the depositor's own ATA
      // via the `referral ?? userAta` fallback in ix.ts.
      const referringSelf = ref.referrer.equals(pubkey)
      const { referrerAta, createIx: refCreateIx } = deriveReferrerAtaAndCreateIx({
        payer: pubkey,
        referrer: ref.referrer,
      })
      if (!referringSelf) ixs.push(refCreateIx)
      // Stake: SOL → stacSOL (lands net of 6.9% deposit fee on the user's
      // stacSOL ATA).
      ixs.push(
        ixDepositSol(pubkey, lamports, pool, referringSelf ? undefined : referrerAta),
      )
      // Wrap: the entire stacSOL we just received gets pushed into the
      // wrapper. The wrap ix is delta-accounted so we can pass the GROSS
      // expected net-of-deposit amount and the program will mint exactly
      // what survives the underlying transfer-fee leg.
      const stacIn = (lamports * (1000n - 69n)) / 1000n // post-DepositSol
      ixs.push(ixWrap(pubkey, stacIn))

      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      const v0 = new VersionedTransaction(
        new TransactionMessage({
          payerKey: pubkey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      )
      let serialized: Uint8Array
      try {
        const signed = (await wallet.signTransaction(v0)) as VersionedTransaction
        serialized = signed.serialize()
      } catch (signErr) {
        const msg = (signErr as Error)?.message ?? String(signErr)
        if (/user reject|user cancel|rejected by user|cancelled/i.test(msg)) {
          throw new Error('cancelled')
        }
        const versionedTxFailure =
          /version|v0|VersionedTransaction|unsupported|method not supported|invalid transaction format/i.test(
            msg,
          )
        if (!versionedTxFailure) throw signErr
        const legacy = new Transaction({ feePayer: pubkey, recentBlockhash: blockhash })
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
      setStatus({
        s: 'ok',
        m: `Staked & wrapped ${fmt(value)} SOL → ${fmt(expected)} wstacSOL`,
        sig,
      })
      fireMint()
      setAmt('')
      setActivePct(null)
      onDone()
    } catch (e) {
      setStatus({ s: 'err', m: summarizeError(e) })
    }
  }

  return (
    <div className="panel">
      <div className="panel-body">
        <div className="panel-row">
          <span className="field-label">Stake & Wrap</span>
          <span className="field-balance">
            available{' '}
            <b
              className="clickable"
              onClick={() => setPercent(100)}
              title="Set max"
            >
              {wallet.connected && walletSol == null ? (
                <>
                  <span className="spin" style={{ marginRight: 6 }} />—
                </>
              ) : (
                <>{fmt(maxAvailable)} SOL</>
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
            }}
          />
          <span className="amt-token">SOL</span>
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
          <span className="glyph" aria-hidden>↓</span>
        </div>

        <div className="panel-row" style={{ marginBottom: 12 }}>
          <span className="field-label">You receive</span>
          <span className="field-balance" style={{ color: 'var(--accent-deep)' }}>
            est. at NAV {rate.toFixed(6)}
          </span>
        </div>
        <div className="receive">
          <div className="lhs">{fmt(expected, 6)}</div>
          <div className="rhs">wstacSOL</div>
        </div>

        {num > 0 && (
          <div className="receipt">
            <div className="r-row">
              <span>Deposit fee 6.9% (burned to NAV)</span>
              <b>−{fmt(num * FEE, 6)} SOL</b>
            </div>
            <div className="r-row">
              <span>Wrap transfer fee 6.9% (burned to NAV)</span>
              <b>−{fmt((num / rate) * (1 - FEE) * FEE, 6)} stacSOL</b>
            </div>
            <div className="r-row good">
              <span>Both fees compound into NAV</span>
              <b>+13.4%</b>
            </div>
          </div>
        )}

        {staleByEpochs > 0 && (
          <div className="status work" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>⏳</span>
            <span>
              Pool out of date by{' '}
              <b className="mono">
                {staleByEpochs} epoch{staleByEpochs === 1 ? '' : 's'}
              </b>
              . Burn-loop normally cranks within 5 min.
            </span>
          </div>
        )}

        <button
          className="cta-primary"
          disabled={!!(wallet.connected && disabled) || busy}
          onClick={submit}
        >
          {busy ? (
            <>
              <span className="spin" /> {status?.m}
            </>
          ) : !wallet.connected ? (
            <>
              Connect wallet to stake &amp; wrap
              <span style={{ marginLeft: 2 }}>⇒</span>
            </>
          ) : (
            <>
              Stake &amp; Wrap
              <span style={{ marginLeft: 2 }}>↗</span>
            </>
          )}
        </button>

        {status?.s === 'ok' && (
          <div className="status ok" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>✓</span>
            <div style={{ flex: 1 }}>
              <div>{status.m}</div>
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
              <div style={{ marginTop: 10 }}>
                <a
                  href="https://www.ride.markets/funds/stacc"
                  target="_blank"
                  rel="noreferrer"
                  className="nav-cta"
                  style={{
                    background: 'var(--accent-deep)',
                    color: 'var(--bg)',
                    padding: '8px 14px',
                    fontSize: 12,
                  }}
                >
                  Deploy on ride.markets
                  <span style={{ marginLeft: 2 }}>↗</span>
                </a>
              </div>
            </div>
          </div>
        )}

        {status?.s === 'err' && (
          <div className="status err" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
            <span>{status.m}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Unwrap & Unstake — wstacSOL → stacSOL → SOL in one signed tx
// -----------------------------------------------------------------------------
function UnwrapAndUnstakeCard({
  rate,
  walletWstacAtom,
  staleByEpochs,
  onDone,
}: {
  rate: number
  walletWstacAtom: bigint | null
  staleByEpochs: number
  onDone: () => void
}) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const modal = useWalletModal()
  const { pool } = usePool()
  const [amt, setAmt] = useState('')
  const [activePct, setActivePct] = useState<number | null>(null)
  const [exactAtoms, setExactAtoms] = useState<bigint | null>(null)
  const [status, setStatus] = useState<Status | null>(null)

  const walletWstac =
    walletWstacAtom != null
      ? Number(walletWstacAtom) / Math.pow(10, DECIMALS)
      : 0
  const maxAvailable = walletWstac
  const num = Number(amt) || 0
  // wstacSOL → stacSOL: unwrap burns wstacSOL 1:1 then transfers stacSOL
  // out of the vault, which is subject to the 6.9% T22 transfer fee. Then
  // stacSOL → SOL: WithdrawSol pays a 6.9% protocol fee on top of NAV.
  // Composed: net SOL = num * 0.931 * rate * 0.931.
  const expected = useMemo(() => {
    if (!num) return 0
    return num * (1 - FEE) * rate * (1 - FEE)
  }, [num, rate])

  const setPercent = (p: number) => {
    setActivePct(p)
    if (p === 100 && walletWstacAtom != null && walletWstacAtom > 0n) {
      const atoms = walletWstacAtom - 1n
      setExactAtoms(atoms)
      setAmt((Number(atoms) / Math.pow(10, DECIMALS)).toFixed(9))
      return
    }
    setExactAtoms(null)
    setAmt(((maxAvailable * p) / 100).toFixed(6))
  }

  const busy = !!status && status.s !== 'ok' && status.s !== 'err'
  const disabled =
    !pool ||
    !num ||
    num <= 0 ||
    num > maxAvailable ||
    staleByEpochs > 0 ||
    busy

  const submit = async () => {
    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      modal.setVisible(true)
      return
    }
    if (!pool) return
    const value = Number(amt)
    if (!Number.isFinite(value) || value <= 0) return
    try {
      setStatus({ s: 'signing', m: 'Awaiting wallet signature…' })
      const pubkey = wallet.publicKey
      const wstacIn =
        exactAtoms ?? BigInt(Math.floor(value * Math.pow(10, DECIMALS)))
      const ixs: TransactionInstruction[] = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ]
      // Underlying stacSOL ATA may not exist yet on this wallet — pre-create.
      const userStacAta = deriveAta(pubkey, MINT, TOKEN_2022)
      const acc = await connection.getAccountInfo(userStacAta, 'processed')
      if (!acc) ixs.push(ixCreateAtaIdempotent(pubkey, pubkey, MINT))
      // Unwrap: burns wstacSOL, vault transfers stacSOL to user
      // (6.9% T22 fee withheld on the user-leg).
      ixs.push(ixUnwrap(pubkey, wstacIn))
      // Withdraw: stacSOL → SOL via stake-pool WithdrawSol. We pass the
      // post-unwrap net amount (gross × 0.931) so we don't try to burn
      // more stacSOL than actually arrived in the ATA.
      const stacOutFromUnwrap = (wstacIn * (1000n - 69n)) / 1000n
      ixs.push(ixWithdrawSol(pubkey, stacOutFromUnwrap, pool))

      const { blockhash } = await connection.getLatestBlockhash('confirmed')
      const v0 = new VersionedTransaction(
        new TransactionMessage({
          payerKey: pubkey,
          recentBlockhash: blockhash,
          instructions: ixs,
        }).compileToV0Message(),
      )
      let serialized: Uint8Array
      try {
        const signed = (await wallet.signTransaction(v0)) as VersionedTransaction
        serialized = signed.serialize()
      } catch (signErr) {
        const msg = (signErr as Error)?.message ?? String(signErr)
        if (/user reject|user cancel|rejected by user|cancelled/i.test(msg)) {
          throw new Error('cancelled')
        }
        const versionedTxFailure =
          /version|v0|VersionedTransaction|unsupported|method not supported|invalid transaction format/i.test(
            msg,
          )
        if (!versionedTxFailure) throw signErr
        const legacy = new Transaction({ feePayer: pubkey, recentBlockhash: blockhash })
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
      setStatus({
        s: 'ok',
        m: `Unwrapped & unstaked ${fmt(value)} wstacSOL → ${fmt(expected)} SOL`,
        sig,
      })
      fireBurn()
      setAmt('')
      setActivePct(null)
      setExactAtoms(null)
      onDone()
    } catch (e) {
      setStatus({ s: 'err', m: summarizeError(e) })
    }
  }

  return (
    <div className="panel">
      <div className="panel-body">
        <div className="panel-row">
          <span className="field-label">Unwrap & Unstake</span>
          <span className="field-balance">
            balance{' '}
            <b
              className="clickable"
              onClick={() => setPercent(100)}
              title="Set max"
            >
              {wallet.connected && walletWstacAtom == null ? (
                <>
                  <span className="spin" style={{ marginRight: 6 }} />—
                </>
              ) : (
                <>{fmt(maxAvailable, 6)} wstacSOL</>
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
              setExactAtoms(null)
            }}
          />
          <span className="amt-token">wstacSOL</span>
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
          <span className="glyph" aria-hidden>↓</span>
        </div>

        <div className="panel-row" style={{ marginBottom: 12 }}>
          <span className="field-label">You receive</span>
          <span className="field-balance" style={{ color: 'var(--accent-deep)' }}>
            est. at NAV {rate.toFixed(6)}
          </span>
        </div>
        <div className="receive">
          <div className="lhs">{fmt(expected, 6)}</div>
          <div className="rhs">SOL</div>
        </div>

        {num > 0 && (
          <div className="receipt">
            <div className="r-row">
              <span>Unwrap transfer fee 6.9% (burned to NAV)</span>
              <b>−{fmt(num * FEE, 6)} wstacSOL</b>
            </div>
            <div className="r-row">
              <span>Withdrawal fee 6.9% (burned to NAV)</span>
              <b>
                −{fmt(num * (1 - FEE) * rate * FEE, 6)} SOL
              </b>
            </div>
          </div>
        )}

        {staleByEpochs > 0 && (
          <div className="status work" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>⏳</span>
            <span>
              Pool out of date by{' '}
              <b className="mono">
                {staleByEpochs} epoch{staleByEpochs === 1 ? '' : 's'}
              </b>
              . Burn-loop normally cranks within 5 min.
            </span>
          </div>
        )}

        <button
          className="cta-primary"
          disabled={!!(wallet.connected && disabled) || busy}
          onClick={submit}
        >
          {busy ? (
            <>
              <span className="spin" /> {status?.m}
            </>
          ) : !wallet.connected ? (
            <>
              Connect wallet to unwrap &amp; unstake
              <span style={{ marginLeft: 2 }}>⇒</span>
            </>
          ) : (
            <>
              Unwrap &amp; Unstake
              <span style={{ marginLeft: 2 }}>↗</span>
            </>
          )}
        </button>

        {status?.s === 'ok' && (
          <div className="status ok" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>✓</span>
            <div style={{ flex: 1 }}>
              <div>{status.m}</div>
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
            </div>
          </div>
        )}

        {status?.s === 'err' && (
          <div className="status err" style={{ marginTop: 14 }}>
            <span style={{ fontSize: 14, lineHeight: 1 }}>×</span>
            <span>{status.m}</span>
          </div>
        )}
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Page root
// -----------------------------------------------------------------------------
export default function WrapPage() {
  const wallet = useWallet()
  const { pool, refresh } = usePool()
  const solLamports = useSolBalance(wallet.publicKey ?? null)
  const walletSol =
    solLamports != null ? solLamports / LAMPORTS_PER_SOL : null
  const walletStacAtom = useStacBalance(wallet.publicKey ?? null)
  const walletWstacAtom = useWstacBalance(wallet.publicKey ?? null)
  const epoch = useEpoch()
  const ref = useRef<number>(0)

  const rate =
    pool && pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : 1

  const staleByEpochs =
    pool && epoch ? Math.max(0, epoch.epoch - Number(pool.lastUpdateEpoch)) : 0

  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  const onDone = () => {
    refresh()
    ref.current++
  }

  // Tiny live balance summary in the hero so the user sees what they have
  // before scrolling to the action cards.
  const wstacFmt =
    walletWstacAtom != null
      ? fmt(Number(walletWstacAtom) / Math.pow(10, DECIMALS))
      : null
  const stacFmt =
    walletStacAtom != null
      ? fmt(Number(walletStacAtom) / Math.pow(10, DECIMALS))
      : null

  return (
    <>
      <EditorialNav pathname="/wrap" />
      <main className="dash shell">
        <section style={{ paddingBlock: '32px 24px' }}>
          <div className="eyebrow" style={{ marginBottom: 16 }}>
            wstacSOL · plain-SPL wrapped form
          </div>
          <h1
            className="serif"
            style={{
              fontSize: 'clamp(36px, 5vw, 56px)',
              lineHeight: 1.02,
              letterSpacing: '-0.025em',
              margin: 0,
              maxWidth: '22ch',
            }}
          >
            Need some <em style={{ color: 'var(--accent-deep)' }}>wstacSOL?</em>
          </h1>
          <p
            style={{
              maxWidth: '54ch',
              marginTop: 18,
              fontSize: 16,
              lineHeight: 1.55,
              color: 'var(--ink-soft)',
            }}
          >
            Maybe for{' '}
            <a
              href="https://www.ride.markets/funds/stacc"
              target="_blank"
              rel="noreferrer"
              style={{
                color: 'var(--accent-deep)',
                borderBottom: '1px dashed currentColor',
              }}
            >
              ride.markets/funds/stacc
            </a>{' '}
            — or any venue that can't price a Token-2022 transfer-fee asset.
            One signed transaction takes you from SOL to wstacSOL (or back).
            Same redemption rate, same flywheel, no two-hop UX.
          </p>

          {wallet.connected && (stacFmt || wstacFmt) && (
            <div
              style={{
                marginTop: 22,
                display: 'flex',
                flexWrap: 'wrap',
                gap: '8px 22px',
                fontFamily: 'var(--f-mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                color: 'var(--ink-muted)',
              }}
            >
              <span>
                stacSOL{' '}
                <b
                  className="tabular"
                  style={{
                    color: 'var(--ink)',
                    fontFamily: 'var(--f-mono)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  {stacFmt ?? '—'}
                </b>
              </span>
              <span>
                wstacSOL{' '}
                <b
                  className="tabular"
                  style={{
                    color: 'var(--ink)',
                    fontFamily: 'var(--f-mono)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  {wstacFmt ?? '—'}
                </b>
              </span>
              <span>
                NAV{' '}
                <b
                  className="tabular"
                  style={{
                    color: 'var(--accent-deep)',
                    fontFamily: 'var(--f-mono)',
                    textTransform: 'none',
                    letterSpacing: 0,
                  }}
                >
                  {rate.toFixed(6)}
                </b>
              </span>
            </div>
          )}
        </section>

        <div className="dash-grid">
          <StakeAndWrapCard
            rate={rate}
            walletSol={walletSol}
            staleByEpochs={staleByEpochs}
            onDone={onDone}
          />
          <UnwrapAndUnstakeCard
            rate={rate}
            walletWstacAtom={walletWstacAtom}
            staleByEpochs={staleByEpochs}
            onDone={onDone}
          />
        </div>

        <div style={{ marginTop: 32, maxWidth: 640 }}>
          <ReferralCard />
        </div>

        <section
          style={{
            marginTop: 56,
            paddingBlock: 32,
            borderTop: '1px solid var(--line)',
          }}
        >
          <div className="eyebrow" style={{ marginBottom: 14 }}>
            why wrap
          </div>
          <p
            style={{
              maxWidth: '62ch',
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--ink-soft)',
              margin: 0,
            }}
          >
            wstacSOL is a plain SPL Token (not Token-2022) backed 1:1 by
            stacSOL held in the wrapper vault. No transfer fee on movements
            of wstacSOL itself — the 6.9% only fires when you wrap into the
            vault and when you unwrap out of it. That makes wstacSOL usable
            anywhere SPL Token is expected (CEX listings, simple LP pools,
            most lending markets, ride.markets) while leaving the
            burn-flywheel intact for stacSOL holders who don't move tokens.
          </p>
          <div style={{ marginTop: 22 }}>
            <a
              href="https://www.ride.markets/funds/stacc"
              target="_blank"
              rel="noreferrer"
              className="nav-cta"
              style={{
                background: 'var(--accent-deep)',
                color: 'var(--bg)',
                padding: '11px 18px',
                fontSize: 13,
              }}
            >
              <span className="pulse" />
              Open ride.markets/funds/stacc
              <span style={{ marginLeft: 2 }}>↗</span>
            </a>
          </div>
        </section>
      </main>
    </>
  )
}
