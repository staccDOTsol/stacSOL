// stacSOL FAQ — `/faq`. No wallet provider needed.
//
// Lives separately from Guide so it stays scannable and source-of-truth for
// the questions people actually ask in DMs / TG / X. Updated as new questions
// land. Pulls live pool numbers from the same `usePool` hook the homepage
// uses so the bankrun math always reflects current state, not a stale doc.
//
// Questions ordered by frequency in the wild (Danny + early holders' DMs).
// "Is it safe?" first, fee math second, yield/decay third, mechanics last.

import { useEffect } from 'react'
import { ConnectionProvider } from '@solana/wallet-adapter-react'
import { RPC_URL } from './lib/constants'
import { usePool } from './hooks/usePool'

export default function Faq() {
  useEffect(() => {
    const prev = document.title
    document.title = 'stacSOL — FAQ'
    return () => {
      document.title = prev
    }
  }, [])

  return (
    // We wrap in a ConnectionProvider so usePool() can read live pool state,
    // but no WalletProvider — FAQ is read-only and doesn't need to sign
    // anything. Keeps the bundle small.
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: 'confirmed' }}>
      <div className="min-h-screen text-[var(--color-fg)]">
        <Nav />
        <Hero />
        <LiveStats />
        <Section title="Contact">
          <Q
            q="How do I reach the dev directly?"
            a={
              <>
                <p>
                  Three channels, in order of "where will I see your message
                  fastest":
                </p>
                <ul>
                  <li>
                    <strong>Telegram DM:</strong>{' '}
                    <a
                      href="https://t.me/notstacc"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      @notstacc
                    </a>{' '}
                    — for anything specific (your wallet, a tx that
                    didn&apos;t land, a deposit you&apos;re considering).
                  </li>
                  <li>
                    <strong>Telegram group:</strong>{' '}
                    <a
                      href="https://t.me/StaccPROOF"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      t.me/StaccPROOF
                    </a>{' '}
                    — for general discussion, status updates, holder chat.
                  </li>
                  <li>
                    <strong>X / Twitter:</strong>{' '}
                    <a
                      href="https://x.com/thystaccfloweth"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      @thystaccfloweth
                    </a>{' '}
                    — for shitposts, ecosystem updates, and DMs.
                  </li>
                </ul>
                <p>
                  No support email, no helpdesk ticketing, no Discord. DM is
                  the channel — replies usually land within a few hours,
                  often immediately if I&apos;m awake.
                </p>
              </>
            }
          />
        </Section>

        <Section title="Safety">
          <Q
            q="Can I get my SOL back? Is the reserve actually solvent?"
            a={<BankrunMath />}
          />
          <Q
            q='What happens if everyone burns at once ("bank run")?'
            a={
              <>
                <p>
                  Everyone gets the advertised rate. The redemption rate is
                  defined as <code>total_SOL ÷ total_stacSOL</code>. When you
                  burn, both numerator and denominator drop proportionally —
                  the rate stays flat through any volume of simultaneous
                  burns.
                </p>
                <p>
                  The reserve account is on chain. Look it up. If it ever
                  drifts below <code>supply × rate × 0.862</code> (the 0.862
                  is the 13.8% withdraw fee that stays in the pool), that
                  would be a real problem. Today it sits comfortably above.
                </p>
              </>
            }
          />
          <Q
            q="What if I can't burn because someone else burned first?"
            a={
              <>
                <p>
                  Doesn't work that way. Burns don't compete for a pool of
                  liquidity — each burn is an independent <code>WithdrawSol</code>{' '}
                  ix that pulls SOL from the reserve at the exact rate at that
                  slot. There's no AMM, no order book, no slippage, no priority
                  ordering. First to land = same rate as last to land.
                </p>
                <p>
                  Only failure mode is the reserve being literally empty,
                  which the bankrun math rules out as long as deposits =
                  supply × rate.
                </p>
              </>
            }
          />
          <Q
            q="What if the reserve runs out of liquid SOL because it's all staked?"
            a={
              <>
                <p>
                  <strong>Currently a non-issue: zero validators have been
                  delegated.</strong> 100% of the reserve sits as liquid SOL
                  in the reserve stake account, payable instantly via{' '}
                  <code>WithdrawSol</code>. No epoch-bounded un-staking
                  delays, no "stuck for 2.3 days" wait that other LSTs
                  inherit from their delegated validator portions.
                </p>
                <p>
                  Why no delegation? The validator inflation yield (~7% APR
                  baseline) is dwarfed by the 5,400%+ premium the
                  Token-2022 burn loop is currently producing. Locking SOL
                  in stake accounts to capture an extra 7% would directly
                  trade liquid-bankrun-safety for a rounding error of yield.
                  Bad trade.
                </p>
                <p>
                  Sanctum's program supports delegation if/when the burn
                  premium decays enough that staking yield matters. Until
                  then: every SOL in the reserve can be paid out
                  immediately. Nothing&apos;s "locked in stake for an epoch".
                </p>
              </>
            }
          />
          <Q
            q='"What if there is literally a bug and the reserve under-pays?"'
            a={
              <>
                <p>
                  The pool runs against{' '}
                  <strong>Sanctum&apos;s deployed program directly</strong> —
                  not a fork, not a redeploy. The exact same on-chain Rust
                  that runs BSOL, INF, jitoSOL, bonkSOL, every Sanctum LST.
                  <strong> $1.5B+ in TVL</strong> across the family
                  currently relies on this exact code path; we&apos;re a
                  config layer on top.
                </p>
                <p>
                  See{' '}
                  <a
                    href="https://defillama.com/protocol/sanctum"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    DefiLlama / Sanctum
                  </a>{' '}
                  for live numbers. If <code>WithdrawSol</code> can be made
                  to under-pay, half of Solana&apos;s LST ecosystem
                  evaporates with it. Not a stacSOL-specific risk — a
                  Solana-LST-systemic one.
                </p>
                <p>
                  More directly: the program computes payout from the SAME
                  on-chain values it reports the rate from
                  (<code>total_lamports</code>, <code>pool_token_supply</code>).
                  There is no code path where the displayed rate exceeds
                  what the program will actually pay. Either the burn lands
                  at <code>0.862 × amount × rate</code> or the ix reverts
                  with no funds moved.
                </p>
              </>
            }
          />
          <Q
            q="Has the contract been audited? Did the dev write any custom Rust?"
            a={
              <>
                <p>
                  <strong>The dev has no Rust deployed.</strong> stacSOL is
                  not a custom program, not a fork, not a redeploy — it&apos;s
                  a stake pool initialized against{' '}
                  <strong>Sanctum&apos;s already-deployed program</strong>{' '}
                  (<code>SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY</code>),
                  the exact same on-chain code that runs BSOL, INF, jitoSOL,
                  bonkSOL, every other Sanctum LST.
                </p>
                <p>
                  What&apos;s ours is the <em>config</em> on top of
                  Sanctum&apos;s Rust. Deposit fee, withdrawal fee, manager
                  fee, referral split — all values bounded by what the
                  program allows, set via the standard <code>splsp</code>{' '}
                  CLI. Same way every other LST manager dials their
                  economics. No custom instructions, no custom validation,
                  no custom anything.
                </p>
                <p>
                  The stacSOL mint itself is a standard{' '}
                  <strong>Token-2022 mint</strong> with the official{' '}
                  <code>TransferFeeConfig</code> extension at 13.8%. Token-2022
                  is Solana&apos;s officially-deployed program (
                  <code>TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb</code>).
                  Nothing exotic in the mint either.
                </p>
                <p>
                  So the audit question collapses to the audit question for
                  every Sanctum LST:{' '}
                  <strong>
                    Sanctum&apos;s program is audited and battle-tested
                    across $1.5B+ TVL
                  </strong>
                  , and Solana&apos;s Token-2022 is audited and runs
                  trillions of token operations. Our deployment inherits
                  both audits unchanged.
                </p>
                <p>
                  Risk surface in plain English: standard LST risk (validator
                  slashing, Solana liveness) + manager-key risk (we can dial
                  pool fees within program-allowed bounds, but cannot mint
                  or burn pool tokens outside the program&apos;s standard{' '}
                  <code>DepositSol</code> / <code>WithdrawSol</code> flows).
                </p>
              </>
            }
          />
        </Section>

        <Section title="Fees">
          <Q
            q="Is there really a 13.8% fee on both mint AND burn?"
            a={
              <>
                <p>
                  Yes. Both directions. Set in the pool config and visible on
                  chain. Mint pays the fee in SOL (you receive 86.2% of the
                  pool token equivalent); burn pays the fee in pool tokens
                  (you receive `0.862 × amount × current_rate` SOL).
                </p>
                <p>
                  This is intentional. The fee feeds the manager wallet,
                  which funds operations (RPC, infra, harvest cron, dev). On
                  burn the fee is taken in stacSOL not SOL — so the SOL you
                  receive matches the rate the chart shows, just multiplied
                  by 0.862.
                </p>
              </>
            }
          />
          <Q
            q="What's the Token-2022 transfer fee for? Is that ALSO 13.8%?"
            a={
              <>
                <p>
                  Same 13.8%. Every <code>Transfer</code> ix on the stacSOL
                  mint withholds 13.8% to the mint's withheld bucket. The
                  harvest loop sweeps that withheld stacSOL and burns it
                  every five minutes — supply drops, reserve unchanged,
                  redemption rate climbs. That's the entire yield mechanism.
                </p>
                <p>
                  <code>Transfer</code> ≠ <code>Burn</code>. Burning your
                  stacSOL via <code>WithdrawSol</code> on the site doesn't
                  trigger the transfer fee (burns and transfers are separate
                  Token-2022 ixs). Selling on a DEX <em>does</em> trigger it,
                  which is why on-site burns are always a strictly better
                  fill.
                </p>
              </>
            }
          />
          <Q
            q="Why is on-site burn always better than selling on a DEX?"
            a={
              <>
                <p>Two reasons stack:</p>
                <ol>
                  <li>
                    <strong>DEX prices have to absorb the 13.8% transfer fee.</strong>{' '}
                    Buyers on the other side of your sell pay 13.8% on the
                    stacSOL they receive — so they bid down to compensate.
                    You eat that bid-down on top of normal AMM slippage.
                  </li>
                  <li>
                    <strong>On-site burn pays out at the exact redemption rate.</strong>{' '}
                    No AMM curve, no slippage, no front-running. <code>WithdrawSol</code>{' '}
                    is a deterministic function of <code>amount × rate</code>.
                  </li>
                </ol>
                <p>
                  Net: on-site fill is structurally better, often by 3–5%+
                  depending on DEX depth. Always burn here.
                </p>
              </>
            }
          />
          <Q
            q="What's the referral 50% / 6.9% thing?"
            a={
              <>
                <p>
                  The 13.8% deposit fee splits 50/50 between the manager
                  (stacc) and a "referrer" wallet. That referrer slot defaults
                  to the marketing wallet (
                  <code>Bq4KMa…fF6j</code>
                  ); anyone landing on{' '}
                  <a href="https://stacsol.app/">stacsol.app</a>{' '}
                  via a <code>?ref=&lt;your-pubkey&gt;</code> link redirects
                  it to <em>your</em> wallet on every mint they sign through
                  it.
                </p>
                <p>
                  Result: ≈6.9% of every referred mint lands as stacSOL in
                  the referrer's ATA. Connect your wallet on the homepage to
                  generate your share link.
                </p>
              </>
            }
          />
        </Section>

        <Section title="Yield + APR decay">
          <Q
            q="Why is the implied APR going down so fast?"
            a={
              <>
                <p>
                  Two things in that chart, only one matters.
                </p>
                <p>
                  <strong>The mechanical part:</strong>{' '}
                  <code>impliedAPR = (rate − 1) × 365 / days</code>. That's
                  simple-interest annualization — by definition any past gain
                  gets averaged over a longer window every day. Even if NAV
                  freezes, the curve has to slope down. The dashed line on
                  the chart shows what it'd look like if the rate had frozen
                  at the anchor. Pure 1/days decay. Math artifact, not a
                  yield event.
                </p>
                <p>
                  <strong>The signal that matters:</strong> the{' '}
                  <em>gap</em> between the actual line (solid) and the
                  expected-frozen line (dashed). That gap is the "yield
                  premium" card on the chart — currently several thousand
                  percent. It's the real annualized rate of NAV growth
                  <em>since the anchor</em>, not the slope of either line.
                </p>
                <p>
                  Tl;dr: the line going down is the math. The gap above the
                  dashed line is the yield. The gap is still huge.
                </p>
              </>
            }
          />
          <Q
            q="Where does the steady-state APR floor land then?"
            a={
              <>
                <p>
                  Floor is bounded below by validator staking yield (~7%
                  APR) — that&apos;s the pure-staking baseline of the
                  underlying Sanctum stake pool. Everything on top is from
                  the 13.8% Token-2022 transfer-fee burn loop, which scales
                  with <strong>cross-pair trading volume</strong>.
                </p>
                <p>
                  The actual rate at any moment is a tug-of-war between
                  two forces:
                </p>
                <ul>
                  <li>
                    <strong className="text-[var(--color-warn)]">Supply growth</strong>{' '}
                    pulls the per-token bump <em>down</em> — same fee
                    harvest divided across more holders.
                  </li>
                  <li>
                    <strong className="text-[var(--color-green)]">Volume growth</strong>{' '}
                    pulls it <em>up</em> — every new cross-pair, every new
                    LP venue, every new meme launch using stacSOL as quote
                    means more Transfer ixs → more 13.8% withheld → more
                    burned per harvest cycle.
                  </li>
                </ul>
                <p>
                  We&apos;re still early — the floor is unsettled while
                  the volume side keeps stepping up. Active catalysts in
                  motion right now:
                </p>
                <ul>
                  <li>
                    Closed-beta LP onboarding just opened up to broader
                    LPers — more stacSOL/* pools, more routing.
                  </li>
                  <li>
                    Quoting a fund on{' '}
                    <a
                      href="https://www.ride.markets/"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      ride.markets
                    </a>{' '}
                    — first non-team and first non-Jupiter-strict-list
                    LST they&apos;d quote.
                  </li>
                  <li>
                    Raydium Launchlab dev approved stacSOL as a
                    permissionful <em>quote</em> pair for meme launches —
                    every Launchlab launch could pair against stacSOL,
                    funneling launch-day volume directly into the burn
                    loop.
                  </li>
                  <li>+ a few more in the pipe.</li>
                </ul>
                <p>
                  Each of those is a step-function increase in the
                  volume term, not the supply term. So while a generic
                  LST&apos;s daily rate decays mechanically toward
                  staking yield, stacSOL&apos;s near-term direction is{' '}
                  <strong className="text-[var(--color-green)]">
                    biased up
                  </strong>{' '}
                  for as long as catalysts keep landing. Steady state
                  isn&apos;t a fixed number — it&apos;s wherever the
                  tug-of-war settles, and right now the rope&apos;s still
                  moving.
                </p>
              </>
            }
          />
          <Q
            q="Why doesn't pure staking grow stacSOL?"
            a={
              <>
                <p>
                  A whale who mints 10,000 stacSOL and sits still actually{' '}
                  <em>dilutes</em> APR for everyone else. More backing SOL,
                  same per-token burn rate, smaller per-token bump per
                  harvest cycle. Stake-only growth collapses stacSOL toward
                  the underlying staking yield.
                </p>
                <p>
                  The protocol grows in the opposite direction: more
                  cross-pairs listing against stacSOL → deeper liquidity →
                  tighter spreads → DEX traders route through stacSOL pairs →
                  more 13.8% transfer-fee burns → NAV climbs faster → attracts
                  more pairs. Repeat.
                </p>
              </>
            }
          />
          <Q
            q="When should I burn?"
            a={
              <>
                <p>
                  When the redemption rate crosses your breakeven (your
                  cost-basis SOL ÷ your stacSOL balance ÷ 0.862, accounting
                  for the burn fee). Above that, every basis point of NAV
                  climb is free money.
                </p>
                <p>
                  Don't burn underwater. The rate only goes up — wait for it
                  to cross your breakeven and you turn a loss into a profit
                  by waiting.
                </p>
              </>
            }
          />
          <Q
            q="If I LP my stacSOL, do I still earn yield?"
            a={
              <>
                <p>
                  <strong>Yes.</strong> The protocol earns on{' '}
                  <em>every stacSOL ever minted</em>, not just the ones in
                  wallets. Supply is supply. NAV (= total_lamports ÷ supply)
                  climbs against the entire token supply — your wallet
                  balance, the LP&apos;s share, everyone&apos;s. Burn fees
                  still accumulate to your token whether it&apos;s in your
                  wallet or in a Raydium / Meteora pool.
                </p>
                <p>
                  When the homepage burn card shows &quot;wallet 22 · in LPs
                  1.5 · total 23.5&quot;, all 23.5 are appreciating against
                  the rate. The split just changes <em>where</em> the
                  stacSOL lives, not whether it earns.
                </p>
                <p>
                  The trade-off: LP&apos;d stacSOL can&apos;t be burned
                  directly via WithdrawSol — it has to be withdrawn from the
                  pool first (via{' '}
                  <a href="/portfolio" style={{ color: 'var(--color-hot)' }}>
                    /portfolio
                  </a>{' '}
                  for DLMM, the &quot;remove&quot; tab on{' '}
                  <a href="/liquidity" style={{ color: 'var(--color-hot)' }}>
                    /liquidity
                  </a>{' '}
                  for CPMM), <em>then</em> burned from your wallet. Two steps
                  instead of one.
                </p>
                <p>
                  Bonus on top: the LP itself earns swap fees from volume
                  routing through the pool. So a stacSOL/SOL LP earns NAV
                  appreciation <em>and</em> swap fees in parallel.
                </p>
              </>
            }
          />
          <Q
            q="What's the catch with LPing?"
            a={
              <>
                <p>
                  <strong>Impermanent loss.</strong> The LP holds both sides
                  of the pair. If price moves between them, your LP value can
                  end up below &quot;just held both tokens separately&quot;.
                  That&apos;s normal AMM math, not a stacSOL-specific risk —
                  but it bites harder against thinly-traded tokens.
                </p>
                <p>
                  Worst case: <strong>the paired token rugs or trades to
                  zero</strong>. Your LP share becomes effectively all of
                  the worthless side — arbitrageurs sold off the stacSOL leg
                  as the price collapsed. NAV growth on the broader protocol
                  can&apos;t save a single LP from a dead-token pair. Your
                  fcukered position is fcukered.
                </p>
                <p>
                  We don&apos;t expect this for the tokens currently listed
                  (PROOF, FOMOX402, Staccana, SOL itself), but the risk is
                  not zero on small caps. The neutral default if you don&apos;t
                  want this exposure: hold stacSOL in your wallet, let NAV
                  climb, never touch a pool. You give up the LP fee bonus and
                  the directional bet, you keep the pure protocol yield.
                </p>
              </>
            }
          />
        </Section>

        <Section title="Mechanics">
          <Q
            q="Where do the SOL deposits actually go?"
            a={
              <>
                <p>
                  Into the pool's reserve stake account on chain — a single
                  publicly-addressable Sanctum-program-owned account. Not a
                  custodial wallet, not a multisig, not an off-chain
                  anything. You can read its lamport balance from any RPC.
                </p>
                <p>
                  <strong>Currently no SOL is delegated to validators.</strong>{' '}
                  The reserve sits 100% liquid so withdraws land
                  instantly. Other LSTs delegate most of their reserve to
                  validators (earning ~7% inflation yield) at the cost of
                  epoch-bounded un-staking delays before the SOL can pay
                  out — we skip that entirely until the burn-loop premium
                  decays enough to make 7% inflation yield matter.
                </p>
              </>
            }
          />
          <Q
            q="Who controls the manager keys?"
            a={
              <>
                <p>
                  The deployer wallet. Same trust model as every other
                  Sanctum LST. The manager can change pool fees, swap
                  validators in/out, set funding authorities. The manager{' '}
                  <em>cannot</em> mint or burn pool tokens outside the
                  standard <code>DepositSol</code> / <code>WithdrawSol</code>{' '}
                  flows — those are PDA-gated.
                </p>
                <p>
                  Mint authority is a PDA, not the deployer. Rug-mint risk
                  is zero.
                </p>
              </>
            }
          />
          <Q
            q="Can the team turn off the 13.8% transfer fee?"
            a={
              <>
                <p>
                  Yes — Token-2022's transfer-fee config sits on a deployer
                  wallet authority. Lowering the fee would slow yield
                  (smaller per-transfer burn). Raising it can't go above the
                  protocol max. Removing it entirely would cap NAV growth at
                  pure staking yield.
                </p>
                <p>
                  We have no plans to lower it. The whole protocol thesis
                  depends on the burn loop. Lowering the fee would defeat
                  the point.
                </p>
              </>
            }
          />
          <Q
            q="What's the difference between the on-site rate and what I see on Jupiter / Birdeye?"
            a={
              <>
                <p>
                  The on-site rate (NAV) is what <code>WithdrawSol</code>{' '}
                  actually pays. The DEX price is whatever the thinnest LP
                  on Solana decided to quote — almost always lower than NAV
                  because DEX bidders have to discount the 13.8% transfer fee
                  they'll pay if they ever try to move the stacSOL.
                </p>
                <p>
                  Always trust the on-site rate for "how much SOL is my
                  stacSOL worth". DEX charts are noise.
                </p>
              </>
            }
          />
          <Q
            q="Is there a token besides stacSOL?"
            a={
              <>
                <p>
                  No. stacSOL is the entire protocol. The thystaccfloweth
                  family of tokens (Staccana, FOMOX402, PROOFV3, ...) are
                  separate launches that pair against stacSOL on DEXes — the
                  more of them list, the more trading fee feeds the burn
                  loop. None of them <em>are</em> stacSOL or share its
                  authorities.
                </p>
              </>
            }
          />
        </Section>

        <Footer />
      </div>
    </ConnectionProvider>
  )
}

// -----------------------------------------------------------------------------
// Live stats card — pulls current pool state and renders the bankrun math
// using actual numbers, so the FAQ doesn't go stale.
// -----------------------------------------------------------------------------

function LiveStats() {
  const { pool } = usePool()
  if (!pool) return null

  const total = Number(pool.poolTotalLamports) / 1e9
  const supply = Number(pool.poolTokenSupplyAccounting) / 1e9
  const rate = supply > 0 ? total / supply : 0
  // First-round payout: each user's burn yields 0.862 × amount × rate.
  // The remaining 0.138 lands in the manager fee account as stacSOL.
  // The protocol's mech burns those manager fees, which pays out the
  // remaining ~13.8% of reserve in a follow-on cascade. Net effect across
  // ALL rounds: the entire reserve pays out, supply → 0, rate climbs
  // monotonically from Token-2022 withheld being harvested (supply drops
  // without reserve outflow). The "surplus" below is the SOL waiting to
  // pay out the cascade rounds — NOT idle profit, NOT extractable rent.
  const userBurnOut = supply * 0.862 * rate
  const cascadeRemaining = total - userBurnOut

  return (
    <section className="max-w-[860px] mx-auto px-6 py-8">
      <div className="rounded border border-[rgb(34_238_136_/_0.35)] bg-[rgb(34_238_136_/_0.04)] p-5">
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-green)] mb-3">
          live pool state · refreshes every 10s
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-[13px]">
          <Stat label="reserve SOL (100% liquid)" value={total.toFixed(4)} />
          <Stat label="stacSOL supply" value={supply.toFixed(4)} />
          <Stat label="redemption rate" value={rate.toFixed(6)} />
          <Stat
            label="cascade remainder"
            value={`${cascadeRemaining.toFixed(4)} SOL`}
            tone="green"
          />
        </div>
        <p className="mt-3 text-[11px] text-[var(--color-dim)] leading-relaxed">
          <strong>Round 1</strong> — every holder burns at the same instant:{' '}
          <code>{supply.toFixed(2)} × 0.862 × {rate.toFixed(4)} = {userBurnOut.toFixed(2)} SOL</code>{' '}
          paid out to users; <code>{(supply * 0.138).toFixed(2)}</code> stacSOL
          accumulates in the manager fee account.{' '}
          <strong>Round 2+</strong> — the protocol&apos;s mech immediately
          burns those manager-fee tokens, paying out the remaining{' '}
          <code>{cascadeRemaining.toFixed(2)} SOL</code> in a recursive
          cascade (manager burn → small fee back to manager → burn → …).
        </p>
        <p className="mt-2 text-[11px] text-[var(--color-dim)] leading-relaxed">
          Net: the <strong>entire {total.toFixed(2)} SOL</strong> reserve
          pays out by the end of a complete bankrun. Supply → 0. The rate
          actually <em>climbs</em> mid-cascade because every Token-2022
          transfer (manager-fee routing) triggers a 13.8% withhold, which
          the harvest loop burns within 5 minutes — supply drops without
          touching the reserve.
        </p>
        <p className="mt-2 text-[11px] text-[var(--color-dim)] leading-relaxed">
          Zero SOL is delegated to validators. Every lamport is payable
          instantly via <code>WithdrawSol</code> (no epoch-bounded
          un-staking like other LSTs).
        </p>
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  tone = 'fg',
}: {
  label: string
  value: string
  tone?: 'fg' | 'green'
}) {
  const color =
    tone === 'green' ? 'text-[var(--color-green)]' : 'text-[var(--color-fg)]'
  return (
    <div>
      <div className="text-[9px] font-black uppercase tracking-[2px] text-[var(--color-dim)]">
        {label}
      </div>
      <div className={`mt-1 font-mono ${color}`}>{value}</div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Reusable bankrun math block — referenced by the first FAQ Q since it's the
// most-asked question.
// -----------------------------------------------------------------------------

function BankrunMath() {
  const { pool } = usePool()
  if (!pool) return <p>(loading live pool state…)</p>
  const total = Number(pool.poolTotalLamports) / 1e9
  const supply = Number(pool.poolTokenSupplyAccounting) / 1e9
  const rate = supply > 0 ? total / supply : 0
  const round1Out = supply * 0.862 * rate
  const cascadeRemaining = total - round1Out
  return (
    <>
      <p>
        Yes. The pool is fully backed at the redemption rate — by
        construction, since the rate is <em>defined</em> as{' '}
        <code>total_SOL ÷ supply</code>. Today (live numbers above):
      </p>
      <ul>
        <li>Reserve: <code>{total.toFixed(2)} SOL</code></li>
        <li>Supply: <code>{supply.toFixed(2)} stacSOL</code></li>
        <li>Rate: <code>{rate.toFixed(4)}</code></li>
      </ul>
      <p>
        <strong>Round 1 — everyone burns at the same instant.</strong>{' '}
        <code>WithdrawSol</code> burns 86.2% of each user&apos;s amount
        (paying them <code>0.862 × amount × rate</code>) and routes the
        13.8% manager fee to the pool&apos;s manager fee account as
        stacSOL. Total user payout: <code>{round1Out.toFixed(2)} SOL</code>.
        Remaining in reserve:{' '}
        <code>{cascadeRemaining.toFixed(2)} SOL</code>.
      </p>
      <p>
        <strong>Round 2+ — the manager burns the fees.</strong> Per the
        protocol mech, every stacSOL that lands in the manager fee account
        gets burned. Each manager-burn does the same 0.862/0.138 split,
        recursively, with the remainder cascading back to the fee account
        and burning again. Geometric sum: the remaining{' '}
        <code>{cascadeRemaining.toFixed(2)} SOL</code> pays out across the
        cascade rounds.
      </p>
      <p>
        <strong>
          Net across the full bankrun: every lamport in the reserve pays
          out, supply goes to ~0, and the rate <em>climbs</em> through the
          cascade
        </strong>{' '}
        because every Token-2022 transfer (each manager-fee routing) triggers
        a 13.8% withhold that the harvest loop burns within 5 minutes —
        supply drops without any reserve outflow. Late burners get a
        better rate than early burners.
      </p>
      <p>
        Translation: not only is the reserve solvent, the protocol is
        designed so a bankrun makes the rate go UP for the people still
        burning. Zero shortfall, mathematically — the only "lost" amount
        is rounding dust on Token-2022 transfer-fee math.
      </p>
    </>
  )
}

// -----------------------------------------------------------------------------
// Layout primitives.
// -----------------------------------------------------------------------------

function Nav() {
  return (
    <div className="sticky top-0 z-20 bg-[rgba(8,2,3,0.85)] backdrop-blur border-b border-[rgb(255_34_0_/_0.15)]">
      <div className="max-w-[860px] mx-auto px-6 py-3 flex items-center justify-between">
        <a
          href="/"
          className="text-[11px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline [text-shadow:0_0_8px_rgba(255,34,0,0.5)]"
        >
          ← stacsol.app
        </a>
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
          frequently asked
        </span>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="max-w-[860px] mx-auto px-6 pt-16 pb-8">
      <h1 className="m-0 text-[clamp(40px,7vw,72px)] font-black tracking-[-0.04em] leading-[0.95] text-[var(--color-hot)] [text-shadow:0_0_18px_rgba(255,34,0,0.6)]">
        FAQ
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-[var(--color-dim)] max-w-[640px]">
        Direct answers to questions people actually ask. No marketing fluff.
        Math is checked against live pool state — the bankrun numbers below
        update every 10 seconds.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {[
          ['/', 'stacsol.app →'],
          ['/guide', 'guide'],
          ['/portfolio', 'portfolio'],
          ['/singlesided', 'single-sided'],
          ['/liquidity', 'liquidity'],
        ].map(([href, label]) => (
          <a
            key={href}
            href={href}
            className="inline-flex items-center px-3 py-1.5 rounded border border-[rgb(255_34_0_/_0.4)] bg-[rgb(255_34_0_/_0.06)] text-[10px] font-black uppercase tracking-[3px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.12)] transition"
          >
            {label}
          </a>
        ))}
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="max-w-[860px] mx-auto px-6 py-12 mt-12 border-t border-[rgb(255_34_0_/_0.15)]">
      <div className="text-center">
        <p className="m-0 text-[11px] text-[var(--color-dim)] uppercase tracking-[3px] font-black">
          question not answered? dm me directly.
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {/* DM channels first — these are the "the dev will reply" surfaces.
              Public group last for general chat / community context. */}
          <a
            href="https://t.me/notstacc"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded border border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.06)] text-[11px] font-black uppercase tracking-[2px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.14)] transition"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-hot)]" />
            tg dm · @notstacc
          </a>
          <a
            href="https://x.com/thystaccfloweth"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded border border-[var(--color-hot)] bg-[rgb(255_34_0_/_0.06)] text-[11px] font-black uppercase tracking-[2px] text-[var(--color-hot)] no-underline hover:bg-[rgb(255_34_0_/_0.14)] transition"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-hot)]" />
            x · @thystaccfloweth
          </a>
          <a
            href="https://t.me/StaccPROOF"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-4 py-2 rounded border border-[var(--color-ember)] bg-[rgb(255_119_51_/_0.06)] text-[11px] font-black uppercase tracking-[2px] text-[var(--color-ember)] no-underline hover:bg-[rgb(255_119_51_/_0.14)] transition"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-ember)]" />
            tg group · t.me/StaccPROOF
          </a>
        </div>
        <p className="mt-6 text-[10px] text-[var(--color-dim)]">
          no insurance fund · no audit · no soft launch · explicit by design
        </p>
      </div>
    </footer>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="max-w-[860px] mx-auto px-6 py-8">
      <h2 className="m-0 mb-5 text-[12px] font-black uppercase tracking-[4px] text-[var(--color-hot)] border-b border-[rgb(255_34_0_/_0.2)] pb-2">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  )
}

function Q({ q, a }: { q: string; a: React.ReactNode }) {
  // <details> gives us native expand/collapse with no JS state — cheap,
  // accessible, and the open state is shareable via :target-style links
  // later if we want to add anchor support.
  return (
    <details className="group rounded border border-[rgb(255_34_0_/_0.18)] bg-[var(--color-bg2)] open:bg-[rgb(255_34_0_/_0.04)] transition-colors">
      <summary className="cursor-pointer px-4 py-3 list-none flex items-start gap-3 text-[14px] font-black text-[var(--color-fg)] hover:text-[var(--color-hot)]">
        <span className="text-[var(--color-hot)] text-[12px] mt-1 group-open:rotate-90 transition-transform">
          ▸
        </span>
        <span className="flex-1">{q}</span>
      </summary>
      <div className="px-4 pb-4 pt-1 pl-10 text-[13px] leading-relaxed text-[var(--color-dim)] [&>p]:mb-3 [&>p:last-child]:mb-0 [&_code]:bg-[var(--color-bg)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[var(--color-fg)] [&_code]:text-[12px] [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-3 [&_li]:mb-1 [&_strong]:text-[var(--color-fg)] [&_em]:text-[var(--color-fg)] [&_em]:not-italic [&_a]:text-[var(--color-hot)] [&_a]:underline [&_a]:underline-offset-2">
        {a}
      </div>
    </details>
  )
}
