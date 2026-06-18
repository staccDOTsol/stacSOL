import { useAccount, useConnect, useDisconnect } from 'wagmi'

export default function EvmWalletPill({ label = 'Connect EVM wallet' }: { label?: string }) {
  const { address } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()

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
    <button
      type="button"
      className="nav-cta"
      disabled={isPending}
      onClick={() => {
        const c = connectors[0]
        if (c) connect({ connector: c })
      }}
      style={{ background: 'var(--accent-deep)', color: 'var(--bg)' }}
    >
      <span className="pulse" />
      {isPending ? 'Connecting…' : label}
      <span style={{ marginLeft: 2 }} aria-hidden>
        →
      </span>
    </button>
  )
}