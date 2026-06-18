import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from './lib/evm-wagmi'
import Evm from './Evm'

const queryClient = new QueryClient()

/** Wagmi + react-query wrapper — only loaded on /evm. */
export default function EvmShell() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Evm />
      </QueryClientProvider>
    </WagmiProvider>
  )
}