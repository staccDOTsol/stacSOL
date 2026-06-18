import { useCallback, useMemo, useState } from 'react'
import {
  useAccount,
  useBalance,
  useConnect,
  usePublicClient,
  useReadContract,
  useSendTransaction,
  useSwitchChain,
  useWriteContract,
} from 'wagmi'
import {
  formatUnits,
  maxUint256,
  parseUnits,
  type Address,
  type Hash,
} from 'viem'
import type { EvmChainConfig } from '../lib/evm-chains'
import {
  erc20Abi,
  erc4626Abi,
  lidoStEthAbi,
  wstEthAbi,
  LIDO_STETH,
  WSTETH_MAINNET,
} from '../lib/evm-abi'

type Tab = 'mint' | 'redeem'
type Source = 'native' | 'lst'

const FEE = 0.069
const DEC = 18

function fmt(n: bigint | undefined, d = 4): string {
  if (n == null) return '—'
  const v = Number(formatUnits(n, DEC))
  if (!Number.isFinite(v)) return '—'
  return v.toLocaleString(undefined, { maximumFractionDigits: d })
}

type Status =
  | { s: 'idle' }
  | { s: 'busy'; m: string }
  | { s: 'ok'; m: string; hash?: Hash }
  | { s: 'err'; m: string }

export function EvmActionPanel({
  chain,
  nav,
}: {
  chain: EvmChainConfig
  nav: number | null
}) {
  const { address, chainId, isConnected } = useAccount()
  const { connect, connectors } = useConnect()
  const { switchChainAsync } = useSwitchChain()
  const publicClient = usePublicClient({ chainId: chain.chainId })
  const { writeContractAsync } = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()

  const vault = chain.contract as Address

  const [tab, setTab] = useState<Tab>('mint')
  const [source, setSource] = useState<Source>('native')
  const [amt, setAmt] = useState('')
  const [status, setStatus] = useState<Status>({ s: 'idle' })

  const onChain = chainId === chain.chainId

  const { data: assetAddr } = useReadContract({
    address: vault,
    abi: erc4626Abi,
    functionName: 'asset',
    chainId: chain.chainId,
  })

  const asset = assetAddr as Address | undefined

  const { data: nativeBal } = useBalance({
    address,
    chainId: chain.chainId,
  })

  const { data: assetBal } = useReadContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: chain.chainId,
    query: { enabled: !!address && !!asset },
  })

  const { data: shareBal } = useReadContract({
    address: vault,
    abi: erc4626Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: chain.chainId,
    query: { enabled: !!address },
  })

  const { data: allowance } = useReadContract({
    address: asset,
    abi: erc20Abi,
    functionName: 'allowance',
    args: address && asset ? [address, vault] : undefined,
    chainId: chain.chainId,
    query: { enabled: !!address && !!asset },
  })

  const num = Number(amt) || 0
  const assetsWei = useMemo(() => {
    if (!num) return 0n
    try {
      return parseUnits(amt, DEC)
    } catch {
      return 0n
    }
  }, [amt])

  const { data: previewShares } = useReadContract({
    address: vault,
    abi: erc4626Abi,
    functionName: 'previewDeposit',
    args: assetsWei > 0n ? [assetsWei] : undefined,
    chainId: chain.chainId,
    query: { enabled: tab === 'mint' && assetsWei > 0n },
  })

  const { data: previewAssets } = useReadContract({
    address: vault,
    abi: erc4626Abi,
    functionName: 'previewRedeem',
    args: num > 0 ? [parseUnits(amt || '0', DEC)] : undefined,
    chainId: chain.chainId,
    query: { enabled: tab === 'redeem' && num > 0 },
  })

  const busy = status.s === 'busy'

  const ensureReady = useCallback(async (): Promise<Address | null> => {
    if (!isConnected) {
      const c = connectors[0]
      if (!c) {
        setStatus({ s: 'err', m: 'No injected wallet found' })
        return null
      }
      connect({ connector: c, chainId: chain.chainId })
      return null
    }
    if (chainId !== chain.chainId) {
      setStatus({ s: 'busy', m: `Switching to ${chain.name}…` })
      await switchChainAsync({ chainId: chain.chainId })
    }
    if (!address) return null
    return address
  }, [
    address,
    chain.chainId,
    chain.name,
    chainId,
    connect,
    connectors,
    isConnected,
    switchChainAsync,
  ])

  const waitTx = useCallback(
    async (hash: Hash, label: string) => {
      setStatus({ s: 'busy', m: `${label}…` })
      if (!publicClient) throw new Error('RPC unavailable')
      await publicClient.waitForTransactionReceipt({ hash })
      return hash
    },
    [publicClient],
  )

  const approveIfNeeded = useCallback(
    async (amount: bigint) => {
      const cur = allowance ?? 0n
      if (cur >= amount) return
      if (!asset) throw new Error('Asset not loaded')
      const hash = await writeContractAsync({
        address: asset,
        abi: erc20Abi,
        functionName: 'approve',
        args: [vault, maxUint256],
        chainId: chain.chainId,
      })
      await waitTx(hash, 'Approving backing token')
    },
    [allowance, asset, chain.chainId, vault, waitTx, writeContractAsync],
  )

  const depositLst = useCallback(
    async (owner: Address, amount: bigint) => {
      if (!asset) throw new Error('Asset not loaded')
      await approveIfNeeded(amount)
      const hash = await writeContractAsync({
        address: vault,
        abi: erc4626Abi,
        functionName: 'deposit',
        args: [amount, owner],
        chainId: chain.chainId,
      })
      await waitTx(hash, 'Depositing to vault')
      return hash
    },
    [approveIfNeeded, asset, chain.chainId, vault, waitTx, writeContractAsync],
  )

  const mintFromNativeEth = useCallback(
    async (owner: Address, value: bigint) => {
      const submitHash = await writeContractAsync({
        address: LIDO_STETH,
        abi: lidoStEthAbi,
        functionName: 'submit',
        args: ['0x0000000000000000000000000000000000000000'],
        value,
        chainId: 1,
      })
      await waitTx(submitHash, 'Staking ETH → stETH (Lido)')

      const stBal = (await publicClient!.readContract({
        address: LIDO_STETH,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint

      const wrapHash = await writeContractAsync({
        address: WSTETH_MAINNET,
        abi: wstEthAbi,
        functionName: 'wrap',
        args: [stBal],
        chainId: 1,
      })
      await waitTx(wrapHash, 'Wrapping stETH → wstETH')

      const wstBal = (await publicClient!.readContract({
        address: WSTETH_MAINNET,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint

      return depositLst(owner, wstBal)
    },
    [depositLst, publicClient, waitTx, writeContractAsync],
  )

  const mintFromNativeSwap = useCallback(
    async (owner: Address, value: bigint) => {
      const res = await fetch(
        `/api/evm-swap?chainId=${chain.chainId}&amount=${value.toString()}&user=${owner}`,
      )
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `swap quote ${res.status}`)
      }
      const swap = (await res.json()) as { to: Address; data: `0x${string}`; value: string }
      setStatus({ s: 'busy', m: 'Swapping to backing LST…' })
      const swapHash = await sendTransactionAsync({
        to: swap.to,
        data: swap.data,
        value: BigInt(swap.value),
        chainId: chain.chainId,
      })
      await waitTx(swapHash, 'Swap')

      const bal = (await publicClient!.readContract({
        address: asset!,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
      })) as bigint

      return depositLst(owner, bal)
    },
    [asset, chain.chainId, depositLst, publicClient, sendTransactionAsync, waitTx],
  )

  const handlePrimary = async () => {
    if (!isConnected) {
      const c = connectors[0]
      if (!c) {
        setStatus({ s: 'err', m: 'No injected wallet found' })
        return
      }
      connect({ connector: c, chainId: chain.chainId })
      return
    }
    if (!onChain) {
      try {
        setStatus({ s: 'busy', m: `Switching to ${chain.name}…` })
        await switchChainAsync({ chainId: chain.chainId })
        setStatus({ s: 'idle' })
      } catch (e) {
        setStatus({ s: 'err', m: (e as Error).message || 'Chain switch failed' })
      }
      return
    }
    if (tab === 'mint') await submitMint()
    else await submitRedeem()
  }

  const submitMint = async () => {
    try {
      const owner = await ensureReady()
      if (!owner || !num || assetsWei <= 0n) return

      setStatus({ s: 'busy', m: 'Preparing…' })

      let hash: Hash
      if (source === 'lst') {
        hash = await depositLst(owner, assetsWei)
      } else if (chain.id === 'eth') {
        hash = await mintFromNativeEth(owner, assetsWei)
      } else if (chain.id === 'base' || chain.id === 'bnb') {
        hash = await mintFromNativeSwap(owner, assetsWei)
      } else {
        setStatus({
          s: 'err',
          m: 'Stake HYPE for kHYPE on Kinetiq first, then mint from LST.',
        })
        return
      }

      setAmt('')
      setStatus({ s: 'ok', m: `Minted ${chain.symbol}`, hash })
    } catch (e) {
      setStatus({ s: 'err', m: (e as Error).message || 'Transaction failed' })
    }
  }

  const submitRedeem = async () => {
    try {
      const owner = await ensureReady()
      if (!owner || !num) return
      const shares = parseUnits(amt, DEC)
      if (shares <= 0n || (shareBal ?? 0n) < shares) return

      setStatus({ s: 'busy', m: 'Redeeming…' })
      const hash = await writeContractAsync({
        address: vault,
        abi: erc4626Abi,
        functionName: 'redeem',
        args: [shares, owner, owner],
        chainId: chain.chainId,
      })
      await waitTx(hash, 'Redeeming from vault')
      setAmt('')
      setStatus({ s: 'ok', m: `Redeemed to ${chain.backing}`, hash })
    } catch (e) {
      setStatus({ s: 'err', m: (e as Error).message || 'Transaction failed' })
    }
  }

  const nativeSym =
    chain.id === 'bnb' ? 'BNB' : chain.id === 'hype' ? 'HYPE' : 'ETH'

  const maxNative = nativeBal
    ? Math.max(0, Number(formatUnits(nativeBal.value, DEC)) - 0.002)
    : 0
  const maxLst = assetBal ? Number(formatUnits(assetBal, DEC)) : 0
  const maxShares = shareBal ? Number(formatUnits(shareBal, DEC)) : 0

  const setPct = (p: number) => {
    const base =
      tab === 'redeem'
        ? maxShares
        : source === 'native'
          ? maxNative
          : maxLst
    setAmt(((base * p) / 100).toFixed(6))
  }

  const explorerTx = (hash: Hash) =>
    `${chain.explorer}/tx/${hash}`

  return (
    <div className="panel evm-panel">
      <div className="tabs" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <button
          type="button"
          className={`tab ${tab === 'mint' ? 'active' : ''}`}
          onClick={() => {
            setTab('mint')
            setStatus({ s: 'idle' })
          }}
        >
          Mint
        </button>
        <button
          type="button"
          className={`tab ${tab === 'redeem' ? 'active' : ''}`}
          onClick={() => {
            setTab('redeem')
            setStatus({ s: 'idle' })
          }}
        >
          Redeem
        </button>
      </div>

      <div className="panel-body">
        {tab === 'mint' && (
          <div className="evm-source-toggle">
            <button
              type="button"
              className={`amt-pct ${source === 'native' ? 'is-active' : ''}`}
              onClick={() => setSource('native')}
            >
              From {nativeSym}
            </button>
            <button
              type="button"
              className={`amt-pct ${source === 'lst' ? 'is-active' : ''}`}
              onClick={() => setSource('lst')}
            >
              From {chain.backing}
            </button>
          </div>
        )}

        <div className="panel-row">
          <span className="field-label">
            {tab === 'mint'
              ? source === 'native'
                ? `Deposit ${nativeSym}`
                : `Deposit ${chain.backing}`
              : `Redeem ${chain.symbol}`}
          </span>
          <span className="field-balance">
            {isConnected && onChain ? (
              <>
                {tab === 'redeem' ? (
                  <>
                    balance <b>{fmt(shareBal)} {chain.symbol}</b>
                  </>
                ) : source === 'native' ? (
                  <>
                    balance <b>{fmt(nativeBal?.value)} {nativeSym}</b>
                  </>
                ) : (
                  <>
                    balance <b>{fmt(assetBal)} {chain.backing}</b>
                  </>
                )}
              </>
            ) : (
              <span style={{ color: 'var(--ink-muted)' }}>
                {isConnected ? `switch to ${chain.short}` : 'connect wallet'}
              </span>
            )}
          </span>
        </div>

        <div className="amt-input-row">
          <input
            className="amt-input tabular"
            inputMode="decimal"
            placeholder="0.00"
            value={amt}
            onChange={(e) => setAmt(e.target.value)}
          />
          <span className="amt-token">
            {tab === 'redeem'
              ? chain.symbol
              : source === 'native'
                ? nativeSym
                : chain.backing}
          </span>
        </div>

        <div className="amt-pcts">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              type="button"
              className="amt-pct"
              onClick={() => setPct(p)}
            >
              {p === 100 ? 'max' : `${p}%`}
            </button>
          ))}
        </div>

        {tab === 'mint' && num > 0 && (
          <div className="receive" style={{ marginTop: 14 }}>
            <div className="lhs">
              {previewShares != null
                ? fmt(previewShares, 6)
                : nav != null
                  ? (num * (1 - FEE) * (1 / (nav || 1))).toFixed(6)
                  : '—'}
            </div>
            <div className="rhs">{chain.symbol}</div>
          </div>
        )}

        {tab === 'redeem' && num > 0 && previewAssets != null && (
          <div className="receive" style={{ marginTop: 14 }}>
            <div className="lhs">{fmt(previewAssets, 6)}</div>
            <div className="rhs">{chain.backing}</div>
          </div>
        )}

        {tab === 'mint' && source === 'native' && chain.id === 'hype' && (
          <p className="evm-hint">
            Step 1:{' '}
            <a href="https://kinetiq.xyz/stake-hype" target="_blank" rel="noreferrer">
              Stake HYPE → kHYPE
            </a>{' '}
            on Kinetiq. Then switch to &quot;From kHYPE&quot; and deposit here.
          </p>
        )}

        {tab === 'mint' && source === 'native' && chain.id === 'eth' && (
          <p className="evm-hint">
            One flow: {nativeSym} → stETH (Lido) → wstETH → approve → vault deposit.
          </p>
        )}

        {tab === 'mint' && source === 'native' && (chain.id === 'base' || chain.id === 'bnb') && (
          <p className="evm-hint">
            One flow: {nativeSym} → {chain.backing} (Paraswap) → approve → vault deposit.
          </p>
        )}

        {status.s === 'err' && (
          <div className="status err" style={{ marginTop: 14 }}>
            {status.m}
          </div>
        )}
        {status.s === 'ok' && (
          <div className="status ok" style={{ marginTop: 14 }}>
            {status.m}
            {status.hash && (
              <>
                {' '}
                <a href={explorerTx(status.hash)} target="_blank" rel="noreferrer">
                  view tx ↗
                </a>
              </>
            )}
          </div>
        )}
        {status.s === 'busy' && (
          <div className="status work" style={{ marginTop: 14 }}>
            <span className="spin" /> {status.m}
          </div>
        )}

        <button
          type="button"
          className="cta-primary"
          disabled={
            busy ||
            (isConnected &&
              onChain &&
              (!num ||
                (tab === 'mint' && source === 'native' && chain.id === 'hype')))
          }
          onClick={() => void handlePrimary()}
          style={{ marginTop: 18 }}
        >
          {busy ? (
            <>
              <span className="spin" /> {status.m}
            </>
          ) : !isConnected ? (
            <>Connect wallet to {tab}</>
          ) : !onChain ? (
            <>Switch to {chain.name}</>
          ) : tab === 'mint' ? (
            source === 'native' && chain.id === 'hype' ? (
              <>Use From kHYPE after staking</>
            ) : (
              <>Mint {chain.symbol}</>
            )
          ) : (
            <>Redeem to {chain.backing}</>
          )}
        </button>
      </div>
    </div>
  )
}