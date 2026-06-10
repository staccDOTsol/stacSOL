import { useState } from 'react'
import { Card } from './Stats'
import { MINT } from '../lib/constants'

export function Manifesto() {
  const ca = MINT.toBase58()
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ca)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <Card title="The mechanic">
      {/* CA chip */}
      <div className="mb-7 bg-[var(--color-bg)] border border-[rgb(255_34_0_/_0.18)] rounded p-3 flex items-center gap-3 flex-wrap">
        <span className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
          Contract
        </span>
        <code className="flex-1 min-w-0 text-[12px] sm:text-[13px] tabular-mono text-[var(--color-fg)] break-all">
          {ca}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 text-[10px] uppercase tracking-[2px] px-2.5 py-1 bg-[var(--color-hot)] text-black rounded font-black hover:brightness-110"
        >
          {copied ? 'copied' : 'copy'}
        </button>
        <a
          href={`https://solscan.io/token/${ca}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[10px] uppercase tracking-[2px] px-2.5 py-1 border border-[var(--color-hot)] text-[var(--color-hot)] rounded font-black hover:bg-[var(--color-hot)] hover:text-black transition-colors"
        >
          solscan
        </a>
      </div>

      {/* Lead */}
      <p className="m-0 mb-7 text-[15px] leading-relaxed text-[var(--color-fg)]">
        stacSOL is the{' '}
        <span className="font-black text-[var(--color-hot)]">base trading asset</span>{' '}
        for the thystaccfloweth ecosystem. mint fee, burn fee, epoch manager fee,
        Token-2022 transfer fee — every one set to{' '}
        <span className="font-black text-[var(--color-hot)]">6.9%</span>, harvested
        and burned every five minutes. supply only moves down. NAV only moves up.
        every trade in the family feeds it.
      </p>

      {/* Numbered principles */}
      <div className="space-y-5">
        <Principle num="01" label="The fee">
          Token-2022&apos;s TransferFee extension withholds 6.9% in the source account on every
          transfer — holder-to-holder, LP rebalance, DEX swap, anything that hits a Transfer ix.
        </Principle>
        <Principle num="02" label="The harvest">
          a daemon walks every Token-2022 stacSOL account every five minutes, sweeps the withheld
          balances to the manager via WithdrawWithheldTokensFromAccounts, BurnChecked&apos;s the lot,
          and runs UpdateStakePoolBalance to sync the pool&apos;s accounting in the same tick.
        </Principle>
        <Principle num="03" label="The result">
          <code className="tabular-mono text-[var(--color-ember)]">mint.supply</code> falls.{' '}
          <code className="tabular-mono text-[var(--color-ember)]">reserve_stake.lamports</code>{' '}
          holds. redemption rate rises monotonically. every transfer between holders makes the
          next holder marginally richer.
        </Principle>
      </div>

      {/* Hairline */}
      <hr className="my-7 border-0 border-t border-[rgb(255_34_0_/_0.15)]" />

      {/* For holders */}
      <h3 className="m-0 mb-4 text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)]">
        For holders
      </h3>
      <div className="space-y-4 text-[13px] leading-relaxed text-[var(--color-fg)]">
        <p className="m-0">
          <span className="font-black text-[var(--color-ember)]">Always mint and burn here.</span>{' '}
          direct pool interaction beats any DEX — DEX prices must absorb the 6.9% transfer fee on
          top of pool slippage, so on-site fills are structurally better.
        </p>
        <p className="m-0">
          <span className="font-black text-[var(--color-ember)]">Don&apos;t burn at a loss.</span>{' '}
          if your cost basis sits above the current redemption rate, wait. the rate only climbs.
          burn when you&apos;re whole, not when you&apos;re underwater.
        </p>
      </div>

      {/* Footer */}
      <div className="mt-7 pt-5 border-t border-[rgb(255_34_0_/_0.1)] flex items-center gap-3 text-[9px] uppercase tracking-[4px] text-[var(--color-dim)]">
        <span className="text-[var(--color-warn)] font-black">proof &amp; bs</span>
        <span className="text-[var(--color-dim)]">·</span>
        <span>get profits</span>
        <span className="text-[var(--color-dim)]">·</span>
        <span>stacc overflow</span>
      </div>
    </Card>
  )
}

function Principle({
  num,
  label,
  children,
}: {
  num: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 items-start">
      <div className="tabular-mono font-black text-[var(--color-hot)] text-2xl leading-none pt-0.5 [text-shadow:0_0_8px_rgba(255,34,0,0.4)]">
        {num}
      </div>
      <div>
        <div className="text-[10px] font-black uppercase tracking-[3px] text-[var(--color-dim)] mb-1.5">
          {label}
        </div>
        <div className="text-[13px] leading-relaxed text-[var(--color-fg)]">{children}</div>
      </div>
    </div>
  )
}
