import { useCallback, useEffect, useRef, useState } from 'react'
import { useConnect } from 'wagmi'
import type { Connector } from 'wagmi'

const LABELS: Record<string, string> = {
  phantom: 'Phantom',
  metaMask: 'MetaMask',
  metaMaskSDK: 'MetaMask',
  rabby: 'Rabby',
  coinbaseWallet: 'Coinbase Wallet',
  coinbaseWalletSDK: 'Coinbase Wallet',
  trust: 'Trust Wallet',
  injected: 'Browser wallet',
  walletConnect: 'WalletConnect',
}

function labelFor(c: Connector): string {
  return LABELS[c.id] ?? c.name ?? c.id
}

export function EvmWalletMenu({
  open,
  onClose,
  chainId,
}: {
  open: boolean
  onClose: () => void
  chainId?: number
}) {
  const { connect, connectors, isPending, error } = useConnect()
  const ref = useRef<HTMLDivElement>(null)
  const [pick, setPick] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onClose])

  const connectOne = useCallback(
    (c: Connector) => {
      setPick(c.id)
      connect({ connector: c, chainId })
    },
    [chainId, connect],
  )

  if (!open) return null

  const unique = connectors.filter(
    (c, i, arr) => arr.findIndex((x) => x.id === c.id) === i,
  )

  return (
    <div className="evm-wallet-menu" ref={ref} role="dialog" aria-label="Connect EVM wallet">
      <div className="evm-wallet-menu-head">Connect wallet</div>
      <ul className="evm-wallet-menu-list">
        {unique.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="evm-wallet-menu-item"
              disabled={isPending && pick === c.id}
              onClick={() => connectOne(c)}
            >
              <span className={`wallet-logo`} data-w={c.id === 'metaMask' || c.id === 'metaMaskSDK' ? 'metamask' : c.id} />
              {isPending && pick === c.id ? 'Connecting…' : labelFor(c)}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="evm-wallet-menu-err">{(error as Error).message || 'Connection failed'}</p>
      )}
    </div>
  )
}