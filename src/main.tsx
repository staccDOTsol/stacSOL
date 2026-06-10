import { Buffer } from 'buffer'
// Buffer polyfill for Solana web3.js / spl libs (browser has no global Buffer)
;(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer

import { StrictMode, Suspense, lazy, useMemo } from 'react'
import { createRoot } from 'react-dom/client'
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui'
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  TrustWalletAdapter,
} from '@solana/wallet-adapter-wallets'

import './index.css'
import { RPC_URL } from './lib/constants'
import { ThemeToggle } from './components/ThemeToggle'

// Route components are lazy-loaded so each route only ships the chunks it
// actually needs. Critical for mobile in-app browsers (Phantom, Trust)
// that OOM-crash on multi-MB JS payloads.
const Landing = lazy(() => import('./Landing.tsx'))
const App = lazy(() => import('./App.tsx'))
const Guide = lazy(() => import('./Guide.tsx'))
const Liquidity = lazy(() => import('./Liquidity.tsx'))
const SingleSided = lazy(() => import('./SingleSided.tsx'))
const Portfolio = lazy(() => import('./Portfolio.tsx'))
const Faq = lazy(() => import('./Faq.tsx'))
const Leaderboard = lazy(() => import('./Leaderboard.tsx'))
const Baitscope = lazy(() => import('./Baitscope.tsx'))
const Liqmonsta = lazy(() => import('./Liqmonsta.tsx'))

// Derive the WebSocket endpoint from the HTTP RPC URL. @solana/web3.js does
// this auto-derivation internally too, but doing it here means we can pin
// it explicitly (no surprise mismatches) and route to a healthy WS host
// when the HTTP host doesn't expose one. The 'http' → 'ws' substitution
// preserves protocol (https → wss).
const WS_ENDPOINT = RPC_URL.replace(/^http/i, 'ws')

function Providers({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new TrustWalletAdapter(),
    ],
    [],
  )
  return (
    <ConnectionProvider
      endpoint={RPC_URL}
      config={{
        commitment: 'confirmed',
        wsEndpoint: WS_ENDPOINT,
        // Disable retries-on-rate-limit on the WS subscription path. Helius
        // rotates 429s aggressively which would otherwise trigger reconnect
        // storms on the wallet adapter's account-change subscriptions.
        disableRetryOnRateLimit: true,
      }}
    >
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}

const path = window.location.pathname
const isGuide = path === '/guide' || path.startsWith('/guide/')
const isLiquidity = path === '/liquidity' || path.startsWith('/liquidity/')
const isSingleSided =
  path === '/singlesided' || path.startsWith('/singlesided/')
const isPortfolio = path === '/portfolio' || path.startsWith('/portfolio/')
const isFaq = path === '/faq' || path.startsWith('/faq/')
const isLeaderboard = path === '/leaderboard' || path.startsWith('/leaderboard/')
const isBaitscope = path === '/baitscope' || path.startsWith('/baitscope/')
const isLiqmonsta = path === '/liqmonsta' || path.startsWith('/liqmonsta/')
// The dashboard (mint/burn/wrap/position) lives at `/` (and keeps working
// at `/app` for old links). The marketing landing moved to `/landing`.
const isLanding = path === '/landing' || path.startsWith('/landing/')

function RouteFallback() {
  return (
    <div className="max-w-[720px] mx-auto px-4 py-6 text-[var(--color-dim)] text-xs uppercase tracking-[3px] font-black">
      loading…
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Theme toggle sits outside Suspense so it's visible the moment
        the bundle loads, even while a route is still resolving. */}
    <ThemeToggle />
    <Suspense fallback={<RouteFallback />}>
      {isGuide ? (
        <Guide />
      ) : isFaq ? (
        // Faq self-wraps in a ConnectionProvider (no wallet needed) so it
        // can read live pool state via usePool() without dragging the
        // wallet-adapter chunk into the route.
        <Faq />
      ) : isLiquidity ? (
        <Providers>
          <Liquidity />
        </Providers>
      ) : isSingleSided ? (
        <Providers>
          <SingleSided />
        </Providers>
      ) : isPortfolio ? (
        <Providers>
          <Portfolio />
        </Providers>
      ) : isLeaderboard ? (
        <Providers>
          <Leaderboard />
        </Providers>
      ) : isBaitscope ? (
        // Baitscope reads /api/flywheel-feed (no wallet needed) so it
        // doesn't drag the wallet-adapter chunk into the route.
        <Baitscope />
      ) : isLiqmonsta ? (
        <Providers>
          <Liqmonsta />
        </Providers>
      ) : isLanding ? (
        // Marketing landing, parked at /landing. Pure static, no wallet
        // provider (CTAs link out to / which mounts the providers).
        <Landing />
      ) : (
        // Default `/` (and legacy `/app`) → the mint / burn / wrap /
        // position dashboard.
        <Providers>
          <App />
        </Providers>
      )}
    </Suspense>
  </StrictMode>,
)
