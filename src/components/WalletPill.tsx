// Connect / disconnect pill rendered in the editorial nav's right slot on
// every wallet-aware route (App, Portfolio, Leaderboard). When disconnected
// it opens the wallet-adapter modal; when connected it shows the truncated
// pubkey and disconnects on click.

import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'

interface Props {
  /** Label shown when wallet is disconnected. Pages can specialise (e.g.
   *  "Connect to Mint" on /app, plain "Connect" elsewhere). */
  connectLabel?: string
}

export default function WalletPill({ connectLabel = 'Connect wallet' }: Props) {
  const wallet = useWallet()
  const modal = useWalletModal()
  const short = wallet.publicKey
    ? `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}`
    : null

  if (short) {
    return (
      <button
        className="nav-cta"
        onClick={() => wallet.disconnect().catch(() => {})}
        title="Disconnect"
        style={{ background: 'var(--accent-deep)', color: 'var(--bg)' }}
      >
        <span className="pulse" />
        {short}
      </button>
    )
  }
  return (
    <button
      className="nav-cta"
      onClick={() => modal.setVisible(true)}
      style={{ background: 'var(--accent-deep)', color: 'var(--bg)' }}
    >
      <span className="pulse" />
      {connectLabel}
      <span style={{ marginLeft: 2 }} aria-hidden>
        →
      </span>
    </button>
  )
}
