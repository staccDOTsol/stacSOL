import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConnect } from 'wagmi'
import type { Connector } from 'wagmi'
import { connectorAvailable, formatConnectError } from '../lib/evm-connect'

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
}: {
  open: boolean
  onClose: () => void
  /** @deprecated connect first, switch chain after — avoids Phantom HyperEVM errors */
  chainId?: number
}) {
  const { connect, connectors, isPending } = useConnect()
  const ref = useRef<HTMLDivElement>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, onClose])

  useEffect(() => {
    if (open) setErr(null)
  }, [open])

  const visible = useMemo(() => {
    const unique = connectors.filter(
      (c, i, arr) => arr.findIndex((x) => x.id === c.id) === i,
    )
    const installed = unique.filter((c) => connectorAvailable(c.id))
    return installed.length > 0 ? installed : unique
  }, [connectors])

  const connectOne = useCallback(
    async (c: Connector) => {
      setPick(c.id)
      setErr(null)
      if (!connectorAvailable(c.id)) {
        setErr(
          `${labelFor(c)} not detected — install the extension and enable EVM accounts.`,
        )
        setPick(null)
        return
      }
      try {
        // Connect on the wallet's current chain first; switch happens in the action panel.
        await connect({ connector: c })
        onClose()
      } catch (e) {
        setErr(formatConnectError(e, c))
      } finally {
        setPick(null)
      }
    },
    [connect, onClose],
  )

  if (!open) return null

  return (
    <div className="evm-wallet-menu" ref={ref} role="dialog" aria-label="Connect EVM wallet">
      <div className="evm-wallet-menu-head">Connect wallet</div>
      <ul className="evm-wallet-menu-list">
        {visible.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="evm-wallet-menu-item"
              disabled={isPending && pick === c.id}
              onClick={() => void connectOne(c)}
            >
              <span
                className="wallet-logo"
                data-w={
                  c.id === 'metaMask' || c.id === 'metaMaskSDK'
                    ? 'metamask'
                    : c.id
                }
              />
              {isPending && pick === c.id ? 'Connecting…' : labelFor(c)}
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="evm-wallet-menu-err">{err}</p>}
    </div>
  )
}