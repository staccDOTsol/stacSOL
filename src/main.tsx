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

// Route components are lazy-loaded so visiting / only ships the Landing
// bundle, not the wallet-adapter / Solana web3 chunk. Critical for mobile
// in-app browsers (Phantom, Trust) that OOM-crash on multi-MB JS payloads —
// the marketing landing has zero wallet dependency.
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
const Terms = lazy(() => import('./Terms.tsx'))
const WrapPage = lazy(() => import('./Wrap.tsx'))
const Trade = lazy(() => import('./Trade.tsx'))
const CreateCurve = lazy(() => import('./CreateCurve.tsx'))
const Launches = lazy(() => import('./Launches.tsx'))

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
const isTerms = path === '/terms' || path.startsWith('/terms/')
const isWrap = path === '/wrap' || path.startsWith('/wrap/')
// /trade — curve-launchpad buy/sell UI. SOL in, SOL out, LST in the middle.
const isTrade = path === '/trade' || path.startsWith('/trade/')
// /create — launch a new bonding curve. Form + image upload via Vercel Blob.
const isCreate = path === '/create' || path.startsWith('/create/')
// /launches — dashboard of every curve on the launchpad.
const isLaunches = path === '/launches' || path.startsWith('/launches/')
// The dashboard (mint/burn/wrap/position) used to live at `/`. It now
// lives at `/app` so `/` can serve the marketing landing without dragging
// the wallet-adapter / Solana web3 chunk on first paint.
const isApp = path === '/app' || path.startsWith('/app/')

function RouteFallback() {
  return (
    <div className="max-w-[720px] mx-auto px-4 py-6 text-[var(--color-dim)] text-xs uppercase tracking-[3px] font-black">
      loading…
    </div>
  )
}

// Landing, App, and Terms all use the editorial design (data-design="editorial"
// set on mount). The standalone ThemeToggle from the legacy fire-red palette
// would collide with the design's sticky-nav theme button, so suppress it on
// editorial routes. Other routes (Guide, Liquidity, SingleSided, etc.) still
// render the legacy ThemeToggle in the top-right corner.
const isLanding =
  !isGuide &&
  !isFaq &&
  !isLiquidity &&
  !isSingleSided &&
  !isPortfolio &&
  !isLeaderboard &&
  !isBaitscope &&
  !isLiqmonsta &&
  !isTerms &&
  !isWrap &&
  !isTrade &&
  !isCreate &&
  !isLaunches &&
  !isApp
// Editorial routes render the shared EditorialNav (with its own
// theme-toggle button), so we suppress the legacy top-right ThemeToggle on
// these paths to avoid two togglers on the same page. Guide / Liquidity /
// SingleSided / Liqmonsta / Baitscope still use the corner toggle.
const isEditorial =
  isLanding ||
  isApp ||
  isTerms ||
  isWrap ||
  isTrade ||
  isCreate ||
  isLaunches ||
  isPortfolio ||
  isLeaderboard ||
  isFaq

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Theme toggle sits outside Suspense so it's visible the moment
        the bundle loads, even while a route is still resolving.
        Hidden on `/` so it can't collide with the Landing nav pill. */}
    {!isEditorial && <ThemeToggle />}
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
      ) : isTerms ? (
        // /terms — pure static long-form ToS. No wallet adapter needed.
        <Terms />
      ) : isWrap ? (
        // /wrap — dedicated lander for stacSOL ↔ wstacSOL plus one-click
        // SOL → wstacSOL (stake-and-wrap) and wstacSOL → SOL
        // (unwrap-and-unstake). Needs the wallet adapter.
        <Providers>
          <WrapPage />
        </Providers>
      ) : isTrade ? (
        // /trade — curve-launchpad buy/sell, transparently routed through
        // stacSOL as the quote token. User sees SOL in / SOL out. See
        // src/Trade.tsx + src/lib/sanctum-route.ts.
        <Providers>
          <Trade />
        </Providers>
      ) : isCreate ? (
        // /create — launch a new bonding curve. Image + metadata go through
        // /api/upload (Vercel Blob), then ixCurveCreate signs+sends.
        <Providers>
          <CreateCurve />
        </Providers>
      ) : isLaunches ? (
        // /launches — dashboard of every curve indexed by stacc-backend.
        // No wallet needed for browsing but Providers wraps so the
        // shared WalletPill in the nav can connect on demand.
        <Providers>
          <Launches />
        </Providers>
      ) : isApp ? (
        // The mint / burn / wrap / position dashboard. Wallet-adapter
        // mounted here only — the marketing landing at `/` stays clean.
        <Providers>
          <App />
        </Providers>
      ) : (
        // Default `/` → marketing landing. Pure static, no wallet provider
        // (CTAs link out to /app which mounts the providers on demand).
        <Landing />
      )}
    </Suspense>
  </StrictMode>,
)
