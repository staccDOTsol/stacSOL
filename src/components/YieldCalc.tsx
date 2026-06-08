// "How much do I deposit to earn $X/day at the realized rate?"
//
// Frames yield as REALIZED gain since deploy (e.g. "53% in 1.4 days"), not
// the headline annualized number (8,700%+). The annualized figure is
// mathematically honest but reads as fake — humans pattern-match on simple
// "X% so far" much better, and the calculator below uses the same realized
// number to back into a deposit size.
//
// Copy framing: the daily rate is the result of a TUG-OF-WAR between two
// forces — supply growth (pulls per-token bumps down) vs cross-pair trading
// volume (pulls them up via the 13.8% Token-2022 transfer-fee burn loop).
// We're currently transitioning from closed beta to production with a stack
// of unlanded volume catalysts (ride.markets fund quote, Raydium Launchlab
// quote-pair listing, broader LP onboarding). Don't pretend the floor is
// known — it depends on how many of those land.

import { useEffect, useState } from 'react'
import type { PoolState } from '../lib/pool'
import { useDeployTs } from '../hooks/useDeployTs'

interface Props {
  pool: PoolState | null
}

/** Module-cached SOL price in USD. Fetched once on first mount, refreshed
 *  every 60s. Avoids each render firing a Jupiter quote. */
let solPriceCache: { usd: number | null; fetchedAt: number } = {
  usd: null,
  fetchedAt: 0,
}
const SOL_PRICE_REFRESH_MS = 60_000

async function fetchSolPriceUsd(): Promise<number | null> {
  // Jupiter quote: 1 SOL → USDC. Returns USDC atoms (6 decimals), so
  // divide by 1e6 to get USD value of 1 SOL.
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const SOL = 'So11111111111111111111111111111111111111112'
  try {
    const qs = new URLSearchParams({
      inputMint: SOL,
      outputMint: USDC,
      amount: String(1_000_000_000), // 1 SOL in lamports
      slippageBps: '50',
      swapMode: 'ExactIn',
    })
    const r = await fetch(`/api/jup-quote?${qs.toString()}`)
    if (!r.ok) return null
    const j = await r.json()
    const out = Number(j.outAmount)
    if (!Number.isFinite(out) || out <= 0) return null
    return out / 1e6
  } catch {
    return null
  }
}

function useSolPriceUsd(): number | null {
  const [price, setPrice] = useState<number | null>(solPriceCache.usd)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      const fresh = solPriceCache.usd != null && Date.now() - solPriceCache.fetchedAt < SOL_PRICE_REFRESH_MS
      if (fresh) {
        setPrice(solPriceCache.usd)
        return
      }
      const v = await fetchSolPriceUsd()
      if (cancelled) return
      if (v != null) {
        solPriceCache = { usd: v, fetchedAt: Date.now() }
        setPrice(v)
      }
    }
    // Defer initial fetch slightly to avoid stacking with the on-connect
    // RPC burst that crashes Phantom mobile webviews.
    const startTimer = setTimeout(tick, 800)
    const id = setInterval(tick, SOL_PRICE_REFRESH_MS)
    return () => {
      cancelled = true
      clearTimeout(startTimer)
      clearInterval(id)
    }
  }, [])

  return price
}

export function YieldCalc({ pool }: Props) {
  const deployTs = useDeployTs()
  const solPriceUsd = useSolPriceUsd()
  // User-tunable target — defaults to $100/day, but if SOL price isn't
  // loaded yet we fall back to "1 SOL/day" as a SOL-denominated target.
  const [targetUsdPerDay, setTargetUsdPerDay] = useState('100')

  if (!pool) return null

  const rate =
    pool.poolTokenSupplyAccounting > 0n
      ? Number(pool.poolTotalLamports) / Number(pool.poolTokenSupplyAccounting)
      : 1
  const elapsedSec = Math.max(1, (Date.now() - deployTs) / 1000)
  const elapsedDays = elapsedSec / 86400

  // Realized cumulative gain since deploy. Pool starts at rate = 1.0, so
  // the % gain is (rate - 1) × 100. Honest, no annualization tricks.
  const realizedPct = (rate - 1) * 100

  // Daily growth, compounded. Solves for r in (1 + r)^days = rate.
  // For deploy-anchor at 1.0 this is just rate^(1/days) - 1. We need
  // elapsedDays > 0 to avoid divide-by-zero on first paint.
  const dailyRate =
    elapsedDays > 0.001 && rate > 0 ? Math.pow(rate, 1 / elapsedDays) - 1 : 0

  // Calculator: deposit X SOL → after 13.8% mint fee, you hold
  // (X × 0.862 / rate) stacSOL × rate = (X × 0.862) SOL of value, growing
  // at dailyRate per day. So daily yield in SOL = X × 0.862 × dailyRate.
  // Solve for X given target SOL/day.
  //
  //   solDeposit = solPerDayTarget / (0.862 × dailyRate)
  //
  // Convert the user's USD target to SOL via current SOL price; if SOL
  // price hasn't loaded yet, fall back to interpreting the input as
  // SOL/day directly (with a label change).
  const targetNum = Number(targetUsdPerDay)
  const targetSolPerDay =
    Number.isFinite(targetNum) && targetNum > 0
      ? solPriceUsd != null
        ? targetNum / solPriceUsd
        : targetNum
      : 0
  const solDepositNeeded =
    dailyRate > 0 && targetSolPerDay > 0
      ? targetSolPerDay / (0.862 * dailyRate)
      : null
  const usdDepositNeeded =
    solDepositNeeded != null && solPriceUsd != null
      ? solDepositNeeded * solPriceUsd
      : null

  // Don't render the daily-rate-derived calc until we have ≥1 hour of
  // data — earlier than that the estimate is meaningless (huge per-hour
  // dust bumps annualize to silly numbers).
  const enoughData = elapsedSec > 3600

  return (
    <section className="card-hot bg-[var(--color-bg2)] border border-[rgb(34_238_136_/_0.35)] rounded-md p-5 mb-5">
      <h2 className="m-0 mb-4 text-base font-black uppercase tracking-[4px] text-[var(--color-green)] [text-shadow:0_0_10px_rgba(34,238,136,0.4),0_0_2px_rgba(34,238,136,0.9)]">
        Yield · realized + sizing
      </h2>

      {/* Realized panel — what's actually happened so far. No annualization. */}
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-[var(--color-bg)] rounded-md p-4 border border-[rgb(34_238_136_/_0.15)]">
          <div className="text-[10px] font-bold uppercase tracking-[2px] text-[var(--color-dim)]">
            Realized gain
          </div>
          <div className="mt-1.5 leading-none">
            <span className="tabular-mono text-3xl font-extrabold text-[var(--color-green)]">
              {realizedPct.toFixed(1)}
            </span>
            <span className="text-[11px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider">
              % since deploy
            </span>
          </div>
          <div className="text-[11px] text-[var(--color-dim)] mt-2 leading-tight">
            rate 1.0000 → {rate.toFixed(4)} over {elapsedDays.toFixed(2)}d
          </div>
        </div>

        <div className="bg-[var(--color-bg)] rounded-md p-4 border border-[rgb(34_238_136_/_0.15)]">
          <div className="text-[10px] font-bold uppercase tracking-[2px] text-[var(--color-dim)]">
            Daily rate (compounded)
          </div>
          <div className="mt-1.5 leading-none">
            <span className="tabular-mono text-3xl font-extrabold text-[var(--color-green)]">
              {(dailyRate * 100).toFixed(1)}
            </span>
            <span className="text-[11px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider">
              % / day
            </span>
          </div>
          <div className="text-[11px] text-[var(--color-dim)] mt-2 leading-tight">
            r where (1+r)^days = current rate · decaying as supply grows
          </div>
        </div>
      </div>

      {/* Sizing calculator — given a $/day target, back into deposit size. */}
      <div className="mt-5 bg-[var(--color-bg)] rounded-md p-4 border border-[rgb(34_238_136_/_0.15)]">
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-green)] mb-3">
          Sizing — what does $X/day cost to mint into?
        </div>
        <div className="flex items-center gap-2 text-[13px] flex-wrap">
          <span className="text-[var(--color-dim)]">target:</span>
          <span className="text-[var(--color-fg)]">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="10"
            value={targetUsdPerDay}
            onChange={(e) => setTargetUsdPerDay(e.target.value)}
            className="w-24 px-2 py-1 bg-[var(--color-bg2)] text-[var(--color-fg)] border border-[rgb(34_238_136_/_0.25)] rounded font-mono text-[13px] focus:outline-none focus:border-[var(--color-green)]"
          />
          <span className="text-[var(--color-dim)]">
            {solPriceUsd != null ? '/ day in USD' : '/ day (USD price loading…)'}
          </span>
        </div>

        {!enoughData ? (
          <p className="mt-3 text-[11px] text-[var(--color-warn)] leading-relaxed">
            need ≥1h of post-deploy data before the daily rate stabilizes
            enough to size against — check back in a bit.
          </p>
        ) : solDepositNeeded == null ? (
          <p className="mt-3 text-[11px] text-[var(--color-dim)]">
            enter a target above to see the deposit size.
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
                  Deposit needed
                </div>
                <div className="mt-1 leading-none">
                  <span className="tabular-mono text-3xl font-extrabold text-[var(--color-green)]">
                    {solDepositNeeded.toFixed(2)}
                  </span>
                  <span className="text-[11px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider">
                    SOL
                  </span>
                </div>
                {usdDepositNeeded != null && (
                  <div className="text-[11px] text-[var(--color-dim)] mt-1">
                    ≈ ${usdDepositNeeded.toFixed(0)} at $
                    {solPriceUsd!.toFixed(2)}/SOL
                  </div>
                )}
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-[2px] text-[var(--color-dim)]">
                  Mint output
                </div>
                <div className="mt-1 leading-none">
                  <span className="tabular-mono text-3xl font-extrabold text-[var(--color-fg)]">
                    {(solDepositNeeded * 0.862 / rate).toFixed(3)}
                  </span>
                  <span className="text-[11px] text-[var(--color-dim)] ml-1.5 uppercase tracking-wider">
                    stacSOL
                  </span>
                </div>
                <div className="text-[11px] text-[var(--color-dim)] mt-1">
                  after the 13.8% mint fee
                </div>
              </div>
            </div>

            <p className="mt-4 text-[11px] text-[var(--color-dim)] leading-relaxed">
              Snapshot at today's pace. Daily rate is a tug-of-war between{' '}
              <span className="text-[var(--color-warn)]">supply growth</span>{' '}
              (more holders → smaller per-token bump from the same fee
              harvest) and{' '}
              <span className="text-[var(--color-green)]">cross-pair volume</span>{' '}
              (more trades through stacSOL pairs → more 13.8% Token-2022
              transfer-fee burns → bigger harvest).
            </p>
            <p className="mt-2 text-[11px] text-[var(--color-dim)] leading-relaxed">
              We&apos;re currently transitioning from closed beta into
              production with a stack of <strong className="text-[var(--color-green)]">unlanded volume catalysts</strong>:
            </p>
            <ul className="mt-1 mb-0 list-disc pl-5 text-[11px] text-[var(--color-dim)] space-y-0.5">
              <li>
                broader LP onboarding (just opened the floodgates from beta
                LPers)
              </li>
              <li>
                <a
                  href="https://www.ride.markets/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[var(--color-green)] underline"
                >
                  ride.markets
                </a>{' '}
                fund quote in motion — first non-team, first
                non-jupiter-strict-list LST they&apos;d quote
              </li>
              <li>
                Raydium Launchlab dev approved stacSOL as permissionful{' '}
                <em>quote</em> pair for meme launches across Launchlab —
                every new launch could pair against stacSOL
              </li>
              <li>+ a few more in the pipe</li>
            </ul>
            <p className="mt-2 mb-0 text-[11px] text-[var(--color-dim)] leading-relaxed">
              Each of those is a step-function increase in the volume
              term, not the supply term. So while a generic LST&apos;s
              daily rate decays mechanically toward staking yield (~7%
              APR floor), stacSOL&apos;s near-term direction is{' '}
              <strong className="text-[var(--color-green)]">biased up</strong>{' '}
              for as long as the catalyst pipeline keeps landing.{' '}
              <strong className="text-[var(--color-warn)]">Not financial advice.</strong>{' '}
              See the{' '}
              <a href="/faq" className="text-[var(--color-green)] underline">
                FAQ
              </a>{' '}
              for the mechanic.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
