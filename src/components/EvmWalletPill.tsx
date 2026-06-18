import { useState } from 'react'
import { useAccount, useDisconnect } from 'wagmi'
import { EvmWalletMenu } from './EvmWalletMenu'

export default function EvmWalletPill({ label = 'Connect wallet' }: { label?: string }) {
  const { address } = useAccount()
  const { disconnect } = useDisconnect()
  const [menuOpen, setMenuOpen] = useState(false)

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : null

  if (short) {
    return (
      <button
        type="button"
        className="nav-cta"
        onClick={() => disconnect()}
        title="Disconnect EVM wallet"
        style={{ background: 'var(--accent-deep)', color: 'var(--bg)' }}
      >
        <span className="pulse" />
        {short}
      </button>
    )
  }

  return (
    <div className="evm-wallet-pill-wrap">
      <button
        type="button"
        className="nav-cta"
        onClick={() => setMenuOpen((o) => !o)}
        style={{ background: 'var(--accent-deep)', color: 'var(--bg)' }}
      >
        <span className="pulse" />
        {label}
        <span style={{ marginLeft: 2 }} aria-hidden>
          →
        </span>
      </button>
      <EvmWalletMenu open={menuOpen} onClose={() => setMenuOpen(false)} />
    </div>
  )
}