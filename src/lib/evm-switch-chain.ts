import type { Chain } from 'viem'
import type { Connector } from 'wagmi'
import { evmWagmiChains } from './evm-wagmi'

type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

function chainById(id: number): Chain | undefined {
  return evmWagmiChains.find((c) => c.id === id)
}

function toHexChainId(id: number): `0x${string}` {
  return `0x${id.toString(16)}` as `0x${string}`
}

function addChainParams(chain: Chain) {
  return {
    chainId: toHexChainId(chain.id),
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
    blockExplorerUrls: chain.blockExplorers
      ? [chain.blockExplorers.default.url]
      : undefined,
  }
}

/** User-facing message for wallet RPC failures (viem often wraps these). */
export function walletChainError(
  e: unknown,
  chainName: string,
  chainId?: number,
): string {
  const err = e as { code?: number; message?: string; shortMessage?: string }
  if (err?.code === 4001) {
    return 'Wallet rejected the network request — approve the popup to continue.'
  }
  if (err?.code === 4902) {
    return `${chainName} is not in your wallet yet — approve the add-network popup.`
  }
  const raw = err?.shortMessage || err?.message || ''
  if (/unsupported chain|unrecognized chain|not supported/i.test(raw)) {
    const id = chainId ?? '?'
    return `${chainName} (chain ${id}) may not be supported by this wallet. Try MetaMask or Rabby, or add the network manually.`
  }
  if (raw) return raw.replace(/Version: viem@[\d.]+/i, '').trim()
  return `Could not switch to ${chainName}. Check your wallet supports this network.`
}

export async function getWalletChainId(
  connector: Connector | undefined,
): Promise<number | null> {
  if (!connector) return null
  try {
    const provider = (await connector.getProvider()) as Eip1193Provider
    const hex = (await provider.request({ method: 'eth_chainId' })) as string
    const id = parseInt(hex, 16)
    return Number.isFinite(id) ? id : null
  } catch {
    return null
  }
}

async function waitForWalletChain(
  provider: Eip1193Provider,
  targetChainId: number,
  timeoutMs = 12_000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const hex = (await provider.request({ method: 'eth_chainId' })) as string
    const current = parseInt(hex, 16)
    if (current === targetChainId) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `Wallet stayed on chain ${await getWalletChainIdFromProvider(provider)} — approve the network switch in your wallet.`,
  )
}

async function getWalletChainIdFromProvider(
  provider: Eip1193Provider,
): Promise<number | 'unknown'> {
  try {
    const hex = (await provider.request({ method: 'eth_chainId' })) as string
    const id = parseInt(hex, 16)
    return Number.isFinite(id) ? id : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * EIP-1193 switch with wallet_addEthereumChain fallback (required for HyperEVM 999
 * and other chains wallets don't ship with).
 */
export async function switchWalletChain(
  connector: Connector | undefined,
  targetChainId: number,
): Promise<void> {
  if (!connector) throw new Error('Wallet not connected')
  const chain = chainById(targetChainId)
  if (!chain) throw new Error(`Chain ${targetChainId} not supported`)

  const provider = (await connector.getProvider()) as Eip1193Provider
  const hexId = toHexChainId(targetChainId)

  const current = await getWalletChainIdFromProvider(provider)
  if (current === targetChainId) return

  const trySwitch = () =>
    provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexId }],
    })

  try {
    await trySwitch()
  } catch (switchErr: unknown) {
    const code = (switchErr as { code?: number })?.code
    if (code === 4001) {
      throw new Error(walletChainError(switchErr, chain.name, chain.id))
    }

    // 4902 = chain missing; Phantom and others sometimes return a generic error.
    try {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [addChainParams(chain)],
      })
    } catch (addErr: unknown) {
      throw new Error(
        walletChainError(addErr ?? switchErr, chain.name, chain.id),
      )
    }

    try {
      await trySwitch()
    } catch {
      /* chainChanged event should still fire after add */
    }
  }

  await waitForWalletChain(provider, targetChainId)
}

/** Switch if needed and block until the wallet provider reports the target chain. */
export async function ensureWalletOnChain(
  connector: Connector | undefined,
  targetChainId: number,
  chainName: string,
): Promise<void> {
  try {
    await switchWalletChain(connector, targetChainId)
  } catch (e) {
    throw new Error(walletChainError(e, chainName, targetChainId))
  }
}