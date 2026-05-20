// /m — Single-page, no-nav mobile UI.
//
// This is the page the Capacitor shell points at. It has:
//   - Privy login (email / SMS / Google / Apple / external wallet) so users
//     with no Phantom install can still earn.
//   - One vertical scroll of per-token cards (stacSOL, wstacSOL, stacUSD).
//   - Stripe Crypto Onramp button for fiat → USDC in their Privy wallet.
//   - Stripe Crypto Offramp button for USDC → bank.
//
// Everything else lives on stacsol.app (the marketing landing, the full
// /app dashboard, the editorial wrap page). The mobile route is
// deliberately stripped: no nav, no router, no marketing copy. App feel.

import { lazy, Suspense, useCallback, useMemo, useState } from 'react'
import { useConnection } from '@solana/wallet-adapter-react'
import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { usePrivy, useSolanaWallets } from '@privy-io/react-auth'
import { PrivyShell, PRIVY_CONFIGURED } from './lib/privy'
import { usePool } from './hooks/usePool'
import { useSolBalance } from './hooks/useSolBalance'
import { useStacBalance } from './hooks/useStacBalance'
import { useWstacBalance } from './hooks/useWstacBalance'
import { useEpoch } from './hooks/useEpoch'
import {
  ixWrap,
  ixUnwrap,
  ixCreateWrappedAtaIdempotent,
} from './lib/wrapper-ix'
import { ixCreateAtaIdempotent } from './lib/ix'
import { MINT, TOKEN_2022 } from './lib/constants'
import { STRIPE_CONFIGURED } from './lib/onramp'

const OnrampModal = lazy(() => import('./components/OnrampModal'))

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
// Default precision bumped 4 → 6 to match App/Wrap/format.ts. See
// lib/format.ts fmtAmount for the rationale (small token amounts no longer
// round to 0.0000).
function fmt(n: number | null | undefined, d = 6): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  })
}

function shorten(pk: string, n = 4): string {
  return `${pk.slice(0, n)}…${pk.slice(-n)}`
}

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------
function LoginGate() {
  const { login } = usePrivy()
  return (
    <div className="m-stage m-stage--login">
      <div className="m-logo">stacc</div>
      <div className="m-tagline">wallet · earn · simple</div>
      <button className="m-cta" onClick={() => login()}>
        Continue
      </button>
      <div className="m-fineprint">
        Email · SMS · Google · Apple<br />
        Or connect an existing Solana wallet
      </div>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className="m-stage m-stage--login">
      <div className="m-logo">stacc</div>
      <div className="m-tagline">wallet · earn · simple</div>
      <div className="m-warning">
        Embedded login isn't configured for this deploy.<br />
        Set <code>VITE_PRIVY_APP_ID</code> on the Vercel project and redeploy.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Authed dashboard
// ---------------------------------------------------------------------------
function Dashboard({ pubkeyStr, signTx }: { pubkeyStr: string; signTx: SignTx }) {
  const { logout } = usePrivy()
  const { connection } = useConnection()
  const pubkey = useMemo(() => new PublicKey(pubkeyStr), [pubkeyStr])

  // Live balances + pool state.
  const sol = useSolBalance(pubkey)
  const stac = useStacBalance(pubkey)
  const wstac = useWstacBalance(pubkey)
  const { pool } = usePool()
  const epoch = useEpoch()

  const stacAmt = stac == null ? null : Number(stac) / 1e9
  const wstacAmt = wstac == null ? null : Number(wstac) / 1e9
  const solAmt = sol == null ? null : Number(sol) / 1e9

  // wstacSOL redemption rate (vault / supply, climbs from underlying burns).
  const wrapRate =
    pool && pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : 1

  const [showOnramp, setShowOnramp] = useState(false)
  const [showOfframp, setShowOfframp] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const flash = useCallback((msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3200)
  }, [])

  // -------------------------------------------------------------------------
  // Tx builders: build, sign with Privy, send.
  // -------------------------------------------------------------------------
  const wrapAll = useCallback(async () => {
    if (busy || stac == null || stac === 0n) return
    setBusy('wrap')
    try {
      const ixs: TransactionInstruction[] = []
      ixs.push(ixCreateWrappedAtaIdempotent(pubkey, pubkey))
      ixs.push(ixWrap(pubkey, stac))
      await sendIxs(connection, pubkey, ixs, signTx)
      flash('Wrapped to wstacSOL ✓')
    } catch (e) {
      flash(`Wrap failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [busy, stac, pubkey, connection, signTx, flash])

  const unwrapAll = useCallback(async () => {
    if (busy || wstac == null || wstac === 0n) return
    setBusy('unwrap')
    try {
      const ixs: TransactionInstruction[] = []
      ixs.push(ixCreateAtaIdempotent(pubkey, pubkey, MINT, TOKEN_2022))
      ixs.push(ixUnwrap(pubkey, wstac))
      await sendIxs(connection, pubkey, ixs, signTx)
      flash('Unwrapped to stacSOL ✓')
    } catch (e) {
      flash(`Unwrap failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [busy, wstac, pubkey, connection, signTx, flash])

  return (
    <div className="m-stage">
      <header className="m-header">
        <div className="m-pill" onClick={() => void logout()}>
          {shorten(pubkeyStr)} · tap to exit
        </div>
        <div className="m-epoch">{epoch ? `epoch ${epoch.epoch}` : ''}</div>
      </header>

      <section className="m-balances">
        <div className="m-balance">
          <div className="m-balance__label">SOL</div>
          <div className="m-balance__amount">{fmt(solAmt)}</div>
        </div>
        <div className="m-balance">
          <div className="m-balance__label">stacSOL</div>
          <div className="m-balance__amount">{fmt(stacAmt)}</div>
        </div>
        <div className="m-balance">
          <div className="m-balance__label">wstacSOL</div>
          <div className="m-balance__amount">{fmt(wstacAmt)}</div>
        </div>
      </section>

      <section className="m-card">
        <div className="m-card__head">
          <div className="m-card__name">wstacSOL</div>
          <div className="m-card__rate">{fmt(wrapRate, 6)} SOL per</div>
        </div>
        <div className="m-card__desc">
          The SPL-compatible mirror of stacSOL. Redemption rate climbs from
          every underlying transfer fee burn.
        </div>
        <div className="m-card__actions">
          <button
            className="m-btn m-btn--primary"
            disabled={!!busy || !stac || stac === 0n}
            onClick={() => void wrapAll()}
          >
            {busy === 'wrap' ? 'Wrapping…' : 'Wrap all stacSOL'}
          </button>
          <button
            className="m-btn"
            disabled={!!busy || !wstac || wstac === 0n}
            onClick={() => void unwrapAll()}
          >
            {busy === 'unwrap' ? 'Unwrapping…' : 'Unwrap all wstacSOL'}
          </button>
        </div>
      </section>

      <section className="m-card m-card--soon">
        <div className="m-card__head">
          <div className="m-card__name">stacUSD</div>
          <div className="m-card__rate">coming soon</div>
        </div>
        <div className="m-card__desc">
          Dollar-denominated deflationary wrapper. Mint/redeem against USDC
          1:1; rate climbs from three burn vectors (mint, redeem, T22 transfer).
          Live after the wrapper-v4 program upgrade lands.
        </div>
      </section>

      <section className="m-card">
        <div className="m-card__head">
          <div className="m-card__name">Cash</div>
          <div className="m-card__rate">{STRIPE_CONFIGURED ? 'fiat in/out' : 'not configured'}</div>
        </div>
        <div className="m-card__actions">
          <button
            className="m-btn m-btn--primary"
            disabled={!STRIPE_CONFIGURED}
            onClick={() => setShowOnramp(true)}
          >
            + Add funds
          </button>
          <button
            className="m-btn"
            disabled={!STRIPE_CONFIGURED}
            onClick={() => setShowOfframp(true)}
          >
            ↓ Cash out
          </button>
        </div>
        <div className="m-card__fine">
          Stripe Crypto Onramp delivers USDC to your wallet directly. We
          never custody funds.
        </div>
      </section>

      <footer className="m-footer">
        <a href="/privacy.html">Privacy</a>
        <span>·</span>
        <a href="/support.html">Support</a>
        <span>·</span>
        <a href="/">stacsol.app</a>
      </footer>

      {showOnramp && (
        <Suspense fallback={<div className="m-modal__loading">Loading…</div>}>
          <OnrampModal
            kind="on"
            destinationWallet={pubkeyStr}
            onClose={() => setShowOnramp(false)}
          />
        </Suspense>
      )}
      {showOfframp && (
        <Suspense fallback={<div className="m-modal__loading">Loading…</div>}>
          <OnrampModal
            kind="off"
            destinationWallet={pubkeyStr}
            onClose={() => setShowOfframp(false)}
          />
        </Suspense>
      )}

      {toast && <div className="m-toast">{toast}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Privy bridge: get the embedded Solana wallet + signer
// ---------------------------------------------------------------------------
type SignTx = (tx: VersionedTransaction) => Promise<VersionedTransaction>

function MobileAuthed() {
  const { ready, authenticated, user } = usePrivy()
  const { wallets } = useSolanaWallets()

  // The first Solana wallet in the user's session — embedded if Privy
  // created one for them, external if they connected Phantom/Solflare.
  const wallet = wallets[0]

  const signTx: SignTx | null = useMemo(() => {
    if (!wallet) return null
    return async (tx) => {
      // Privy v2 Solana wallets expose signTransaction directly.
      const signed = await wallet.signTransaction(tx)
      return signed as VersionedTransaction
    }
  }, [wallet])

  if (!ready) return <div className="m-stage m-stage--login">…</div>
  if (!authenticated || !user) return <LoginGate />
  if (!wallet || !signTx) {
    return (
      <div className="m-stage m-stage--login">
        <div className="m-logo">stacc</div>
        <div className="m-tagline">provisioning wallet…</div>
      </div>
    )
  }
  return <Dashboard pubkeyStr={wallet.address} signTx={signTx} />
}

// ---------------------------------------------------------------------------
// Tx send helper
// ---------------------------------------------------------------------------
async function sendIxs(
  connection: ReturnType<typeof useConnection>['connection'],
  payer: PublicKey,
  ixs: TransactionInstruction[],
  signTx: SignTx,
) {
  const cu = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
  ]
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [...cu, ...ixs],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  const signed = await signTx(tx)
  const sig = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  })
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed')
  return sig
}

// ---------------------------------------------------------------------------
// Top-level export — wraps in PrivyProvider only here, never globally.
// ---------------------------------------------------------------------------
export default function Mobile() {
  if (!PRIVY_CONFIGURED) return <NotConfigured />
  return (
    <PrivyShell>
      <MobileAuthed />
    </PrivyShell>
  )
}
