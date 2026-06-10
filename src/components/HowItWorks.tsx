import { Card } from './Stats'

export function HowItWorks() {
  return (
    <Card title="Field manual">
      <div className="space-y-7">
        <Section num="01" title="What stacSOL actually is">
          <p className="lead">
            stacSOL is the{' '}
            <span className="text-[var(--color-fg)]">base trading asset</span>{' '}
            for the thystaccfloweth ecosystem — a liquid staking token whose
            redemption rate climbs every time the family trades. Pure staking
            yield is the floor (~7% APR, the bSOL / blazeSOL baseline). The
            actual yield is the floor plus everything else.
          </p>
          <p>
            Every transfer of stacSOL withholds 6.9% via Token-2022. The
            harvest loop sweeps and burns those holdings every five minutes,
            so the redemption rate compounds with{' '}
            <span className="text-[var(--color-ember)] font-black">cross-pair churn</span>:
          </p>
          <Bulleted>
            <li>swaps in stacSOL/SOL pairs on raydium / meteora / orca</li>
            <li>swaps in cross-pairs — stacSOL paired against any other thystaccfloweth token</li>
            <li>LP rebalancing whenever paired-asset prices move</li>
            <li>arbitrage between DEX quotes and the pool&apos;s redemption rate</li>
            <li>any cross-program move hitting a Transfer ix</li>
          </Bulleted>
          <p>
            <span className="text-[var(--color-fg)] font-black">Volume IS the yield.</span>{' '}
            More cross-pairs, more trading in those pairs, faster supply burns,
            faster the rate climbs.
          </p>
        </Section>

        <Divider />

        <Section num="02" title="Why stakers alone don't grow it">
          <p className="lead">
            A whale who mints 10,000 stacSOL and sits still actually{' '}
            <span className="text-[var(--color-warn)] font-black">dilutes</span>{' '}
            APR for everyone. More backing SOL, same per-token burn rate,
            smaller per-token bump per cycle. Stake-only growth collapses
            stacSOL toward the 7% LST floor and dies.
          </p>
          <p>The protocol grows in the opposite direction:</p>
          <NumberedList>
            <li>
              More stacSOL pairs on Raydium / Meteora / Orca → deeper liquidity.
            </li>
            <li>
              Deeper liquidity → tighter spreads → DEX traders route
              through stacSOL pairs.
            </li>
            <li>
              More routing → more 6.9% transfer-fee burns → NAV climbs faster.
            </li>
            <li>
              Rising rate → attracts more pairs and more speculators → repeat.
            </li>
          </NumberedList>
          <p className="warn">
            The marketing trap is "stake stacSOL, earn yield." That positioning
            collapses to 7%. The real product is a base trading asset for the
            family — pair every new thystaccfloweth token against stacSOL, not SOL.
          </p>
        </Section>

        <Divider />

        <Section num="03" title="Early-days APR">
          <p className="lead">
            The dashboard&apos;s implied APR is the simple-interest annualization of rate
            change since pool deploy.{' '}
            <span className="text-[var(--color-warn)] font-black">
              Mathematically honest. Not a forecast.
            </span>
          </p>
          <p>Three reasons the early number runs hot:</p>
          <NumberedList>
            <li>
              The first hours had a backlog of withheld dust from initial DEX listings. The
              loop swept it all at once. One-shot, not steady state.
            </li>
            <li>
              As supply grows, the same transfer-fee burn divides across more holders.
              Per-token rate bump per burn shrinks proportionally.
            </li>
            <li>
              As the rate diverges from 1.0, DEX arbitrage tightens. The spread between DEX
              price and pool redemption sets the ceiling on how much transfer churn is worth
              doing.
            </li>
          </NumberedList>
          <p className="warn">
            Trust your own cost basis vs. the current redemption rate. The position card
            above doesn&apos;t lie. Annualized APR projected from days of data does.
          </p>
        </Section>

        <Divider />

        <Section num="04" title="Risk surface">
          <Bulleted>
            <li>
              <span className="text-[var(--color-fg)] font-black">PDA mint authority.</span>{' '}
              No one can mint stacSOL outside a DepositSol flow. Rug-mint risk: zero.
            </li>
            <li>
              <span className="text-[var(--color-fg)] font-black">
                Deployer-held authorities.
              </span>{' '}
              Transfer-fee config and withdraw-withheld auth sit on the deployer wallet.
              Could lower the fee (slows yield) or rotate the harvest target. Already near
              program ceiling — can&apos;t materially raise it.
            </li>
            <li>
              <span className="text-[var(--color-fg)] font-black">Pool manager.</span> Same
              wallet can change pool fees, swap validators, set funding authorities.
              Standard Sanctum-LST trust model.
            </li>
            <li>
              <span className="text-[var(--color-fg)] font-black">
                Solana liveness &amp; validator slashing.
              </span>{' '}
              Same as any LST.
            </li>
            <li>
              <span className="text-[var(--color-fg)] font-black">DEX premium risk.</span>{' '}
              If a market lists stacSOL above redemption value, buyers there lose on burn.
              Always mint and burn on this site, not on a DEX.
            </li>
            <li>
              <span className="text-[var(--color-warn)] font-black">
                No insurance fund. No audit. No soft launch.
              </span>{' '}
              Explicit by design.
            </li>
          </Bulleted>
        </Section>

        <Divider />

        <Section num="05" title="When to burn">
          <p className="lead">
            When the redemption rate crosses your{' '}
            <span className="text-[var(--color-ember)] font-black">breakeven</span> —
            displayed in the position card. The breakeven banner turns hot when you&apos;re
            profitable, amber when you&apos;re still underwater.
          </p>
          <p>
            The rate only moves up. If you&apos;re green and need the SOL, burn here — the
            on-site burn is always a better fill than aping out on a DEX, because DEX prices
            have to absorb the 6.9% transfer fee on top of pool slippage.
          </p>
        </Section>
      </div>
    </Card>
  )
}

function Section({
  num,
  title,
  children,
}: {
  num: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="grid grid-cols-[auto_1fr] gap-x-4 items-start">
      <div className="tabular-mono font-black text-[var(--color-hot)] text-2xl leading-none pt-0.5 [text-shadow:0_0_8px_rgba(255,34,0,0.4)]">
        {num}
      </div>
      <div>
        <h3 className="m-0 mb-3 text-[11px] font-black uppercase tracking-[3px] text-[var(--color-fg)]">
          {title}
        </h3>
        <div className="space-y-3 text-[13px] leading-relaxed text-[var(--color-dim-text,#c8b4a0)] [&>p]:m-0 [&>p]:text-[var(--color-fg)] [&_.lead]:text-[14px] [&_.lead]:text-[var(--color-fg)] [&_.warn]:text-[var(--color-warn)] [&_.warn]:text-[12px]">
          {children}
        </div>
      </div>
    </section>
  )
}

function Divider() {
  return <hr className="m-0 border-0 border-t border-[rgb(255_34_0_/_0.12)]" />
}

function Bulleted({ children }: { children: React.ReactNode }) {
  return (
    <ul className="m-0 pl-0 list-none space-y-2 text-[13px] leading-relaxed text-[var(--color-fg)] [&>li]:relative [&>li]:pl-4 [&>li]:before:content-['—'] [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:text-[var(--color-hot)] [&>li]:before:font-black">
      {children}
    </ul>
  )
}

function NumberedList({ children }: { children: React.ReactNode }) {
  return (
    <ol className="m-0 pl-0 list-none counter-reset-[step] space-y-2.5 text-[13px] leading-relaxed text-[var(--color-fg)] [&>li]:relative [&>li]:pl-7 [&>li]:before:absolute [&>li]:before:left-0 [&>li]:before:top-0 [&>li]:before:tabular-mono [&>li]:before:text-[var(--color-hot)] [&>li]:before:font-black [&>li]:before:text-[11px] [counter-reset:step] [&>li]:before:[counter-increment:step] [&>li]:before:[content:counter(step,decimal-leading-zero)]">
      {children}
    </ol>
  )
}
