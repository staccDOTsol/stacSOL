// Terms of Service — long-form. Covers:
//   • The stacSOL token + dapp
//   • The permissionless LST factory (Sanctum fork)
//   • General services operated by stacc / @notstacc
//
// Not legal advice. Have a lawyer review before relying on it.

import { useEffect, type ReactNode } from 'react'
import EditorialNav from './components/EditorialNav'

interface Section {
  num: string
  id: string
  title: string
  eyebrow: string
  body: ReactNode
}

const TERMS_SECTIONS: Section[] = [
  {
    num: '01',
    id: 'acceptance',
    title: 'Acceptance',
    eyebrow: 'the contract',
    body: (
      <>
        <p>
          These Terms of Service (the "<strong>Terms</strong>") constitute a
          binding agreement between you and the operator(s) of the protocols
          and software collectively branded as "<strong>stacc</strong>", "
          <strong>stacSOL</strong>", and any permissionless liquid-staking-token
          (LST) factory built on a fork of the Sanctum SPL stake-pool program
          (the "<strong>Services</strong>"). By accessing, interacting with, or
          transacting through any website, application, smart contract,
          command-line script, or interface that surfaces or relies on the
          Services, you accept these Terms in full.
        </p>
        <p>
          If you do not agree to these Terms, do not access or use the
          Services. Continued use after any change to these Terms constitutes
          your acceptance of the change.{' '}
          <strong>Operating on a blockchain is irreversible.</strong> If you do
          not understand a transaction you are about to submit, do not submit
          it.
        </p>
      </>
    ),
  },
  {
    num: '02',
    id: 'eligibility',
    title: 'Eligibility & Prohibited Persons',
    eyebrow: 'who can use this',
    body: (
      <>
        <p>You represent and warrant that:</p>
        <ul>
          <li>You are of legal age to form a binding contract in your jurisdiction.</li>
          <li>
            You are not a resident or citizen of, and are not located in, any
            jurisdiction in which use of the Services is prohibited, restricted,
            or unauthorized by applicable law.
          </li>
          <li>
            You are not subject to any sanctions program administered by the
            United States, the United Kingdom, the European Union, the United
            Nations, or any other governmental authority. You are not listed on
            any sanctions list, including OFAC SDN, EU consolidated sanctions,
            or HMT Consolidated List.
          </li>
          <li>You will not use the Services on behalf of any person or entity prohibited from using them.</li>
          <li>You will not use the Services to launder proceeds of crime, evade taxes, finance terrorism, or commit any other unlawful act.</li>
        </ul>
        <p>
          The Services are general-purpose on-chain software. The operator does
          not custody user funds and is not in a position to enforce
          eligibility on a per-transaction basis. Compliance with applicable
          law is <strong>your sole responsibility</strong>.
        </p>
      </>
    ),
  },
  {
    num: '03',
    id: 'services',
    title: 'The Services',
    eyebrow: 'what this covers',
    body: (
      <>
        <p>The Services include, without limitation:</p>
        <ul>
          <li>
            The <strong>stacSOL</strong> liquid staking token, its Token-2022
            mint, its underlying SPL stake-pool deployment, the manager
            keypair, and the burn-loop process operated against it.
          </li>
          <li>
            A <strong>permissionless LST factory</strong> — a fork of the
            Sanctum SPL stake-pool program (and associated tooling) that allows
            arbitrary users to deploy their own liquid staking tokens with
            configurable transfer-fee economics. Tokens created via this
            factory are <strong>not</strong> created, controlled, audited,
            vetted, or endorsed by the operator.
          </li>
          <li>
            Web interfaces, RPCs, serverless API endpoints, indexers,
            leaderboards, and analytics surfaces that read and display state
            from the foregoing.
          </li>
          <li>
            Any related scripts, libraries, command-line tools, documentation,
            and open-source repositories published under the same operator.
          </li>
        </ul>
        <p>
          The Services are provided as composable, non-custodial software. The
          operator may modify, suspend, or discontinue any part of the Services
          at any time, with or without notice, and without liability to any
          user.
        </p>
      </>
    ),
  },
  {
    num: '04',
    id: 'non-custodial',
    title: 'Non-Custodial Nature',
    eyebrow: 'you hold your keys',
    body: (
      <>
        <p>
          <strong>The Services are non-custodial.</strong> The operator never
          takes possession, custody, or control of your private keys, your
          wallet, your SOL, your stacSOL, your LP positions, or any other
          asset you hold. All transactions are constructed client-side and
          signed by your wallet against the Solana blockchain.
        </p>
        <p>
          The operator cannot reverse, cancel, freeze, refund, retrieve, or
          otherwise alter any transaction once it has been broadcast. You bear
          sole responsibility for:
        </p>
        <ul>
          <li>The security of your private keys, seed phrase, and wallet software.</li>
          <li>Reviewing the contents of any transaction before approving it.</li>
          <li>The correctness of every address, instruction, slippage tolerance, and parameter you submit.</li>
          <li>Any loss arising from phishing, malware, compromised hardware, or signing a malicious transaction.</li>
        </ul>
        <div className="terms-callout">
          <span className="lbl">no recovery path</span>
          If you lose access to your keys, send funds to the wrong address, or
          sign a transaction you didn't intend to, those funds are gone. The
          operator has no recovery mechanism and will not attempt one.
        </div>
      </>
    ),
  },
  {
    num: '05',
    id: 'stacsol',
    title: 'stacSOL — Specific Terms',
    eyebrow: 'the canonical lst',
    body: (
      <>
        <p>
          stacSOL is a Token-2022 token (mint{' '}
          <code>6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f</code>) representing
          a deposit in the underlying SPL stake pool (pool{' '}
          <code>E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb</code>). The
          redemption ratio is defined by the deployed stake-pool program as{' '}
          <code>pool.total_lamports / pool.pool_token_supply</code>. The
          program has no instruction path that decreases this ratio.
        </p>
        <h3>Transfer fee.</h3>
        <p>
          stacSOL uses the Token-2022 <code>TransferFeeConfig</code> extension
          with a fee of <strong>690 basis points (6.9%)</strong> on every
          transfer. The fee is withheld at transfer time and is periodically
          harvested + burned by an operator-controlled process, which
          reconciles <code>pool.pool_token_supply</code> with the new{' '}
          <code>mint.supply</code> via <code>UpdateStakePoolBalance</code>.
        </p>
        <p>By acquiring, holding, or transferring stacSOL, you accept that:</p>
        <ul>
          <li>
            Every transfer — including swaps, deposits, LP joins, CEX moves,
            and direct wallet-to-wallet sends — burns 6.9% of the transferred
            amount forever.
          </li>
          <li>
            Mint and burn operations against the stake pool each charge a
            separate <strong>6.9% protocol fee</strong> on top of the transfer
            fee. The two fees compose; both are real.
          </li>
          <li>
            The redemption ratio's upward trajectory depends on continued
            operation of the burn-loop process. The process may pause, slow, or
            stop at any time. Pausing does not reduce the ratio; it only stops
            further increases.
          </li>
          <li>
            While the program guarantees the ratio cannot regress, the realized
            fiat or token-pair value of stacSOL depends on market conditions,
            validator yield, and counterparty solvency, none of which are
            guaranteed.
          </li>
        </ul>
        <h3>Manager authority.</h3>
        <p>
          A designated manager keypair holds <code>TransferFeeConfig</code>,
          withdraw-withheld, and stake-pool manager authorities. The manager
          may harvest withheld fees, burn from the manager-controlled
          associated token account, and trigger pool updates. The manager{' '}
          <strong>cannot</strong> drain reserves, mint new stacSOL outside the
          protocol's deposit instruction, or unilaterally change the
          transfer-fee configuration without on-chain governance.
        </p>
        <p>
          You acknowledge that the manager keypair, its custodians, and the
          burn-loop infrastructure are operational components subject to
          compromise, key loss, downtime, or operator discretion. Loss of the
          keypair would freeze the burn loop but not the redemption mechanism.
        </p>
      </>
    ),
  },
  {
    num: '06',
    id: 'factory',
    title: 'Permissionless LST Factory — Specific Terms',
    eyebrow: 'sanctum fork',
    body: (
      <>
        <p>
          The Services include a{' '}
          <strong>permissionless deployment factory</strong> derived from a
          fork of the Sanctum SPL stake-pool program. The factory lets any
          user deploy their own liquid staking token with custom validator
          delegation, fee parameters, transfer-fee economics, and authorities.
          Tokens deployed through this factory are referred to here as "
          <strong>User LSTs</strong>".
        </p>
        <div className="terms-callout">
          <span className="lbl">no endorsement</span>
          The operator does not create, audit, vet, or endorse any User LST.
          Every User LST is its own protocol with its own authorities,
          parameters, and risks. The presence of the factory does not
          constitute a recommendation that you mint, hold, or transact in any
          User LST.
        </div>
        <p>By using the factory, you (a "<strong>Deployer</strong>") represent, warrant, and acknowledge that:</p>
        <ul>
          <li>Your User LST is a separate protocol from stacSOL. The operator has no role, authority, control, or fiduciary relationship in respect of your User LST.</li>
          <li>You are solely responsible for compliance with all securities, commodities, money-transmission, tax, sanctions, and consumer-protection laws in every jurisdiction in which your User LST is offered, transferred, or marketed.</li>
          <li>You are solely responsible for the security of your manager keypair(s), your validator delegation choices, your transfer-fee parameters, and any economic claims you make about your User LST.</li>
          <li>You will not name, brand, or market your User LST in a way that suggests it is operated, audited, endorsed, or co-issued by the operator, stacc, stacSOL, Sanctum, or any of their affiliates.</li>
          <li>You will defend, indemnify, and hold the operator harmless against any claim arising out of or relating to your User LST, its holders, its validators, its counterparties, or any representation made about it.</li>
        </ul>
        <p>By acquiring, holding, or transacting in any User LST, you (a "<strong>Holder</strong>") acknowledge that:</p>
        <ul>
          <li>You are dealing directly with the Deployer, not the operator.</li>
          <li>The User LST's parameters (transfer fee, redemption mechanics, manager authority, validator set, burn schedule) are configured by the Deployer and may be materially different from stacSOL's.</li>
          <li>The operator makes no representation about the existence, solvency, intent, identity, or competence of any Deployer.</li>
          <li>The same risk disclosures that apply to stacSOL apply, with equal or greater force, to every User LST.</li>
        </ul>
      </>
    ),
  },
  {
    num: '07',
    id: 'risks',
    title: 'Risk Disclosures',
    eyebrow: 'what can go wrong',
    body: (
      <>
        <p>
          You acknowledge that using the Services involves substantial risk,
          including the potential loss of all funds you commit. Without
          limiting the foregoing:
        </p>
        <h3>Smart contract risk.</h3>
        <p>
          The SPL stake-pool program, the Token-2022 program, and any program
          code involved in the Services may contain bugs, exploits, design
          flaws, or undiscovered vulnerabilities. Audits reduce but do not
          eliminate these risks. A successful exploit may result in total loss
          of funds with no recourse.
        </p>
        <h3>Transfer-fee risk.</h3>
        <p>
          stacSOL and many User LSTs apply a 6.9% transfer fee on every
          movement. Repeated transfers — including DEX trades, MEV
          interactions, LP rebalances, and CEX deposits — compound rapidly into
          substantial value destruction relative to a no-fee token. You are
          responsible for understanding the fee economics before transacting.
        </p>
        <h3>Liquidity risk.</h3>
        <p>
          Redemption against the stake-pool reserve depends on adequate
          reserve lamports. Secondary markets (DEX pools, CEXes, OTC) may be
          thinner than reserve liquidity, may dislocate from net asset value,
          and may be unavailable at the time you wish to exit. The operator
          has no obligation to provide, maintain, or restore liquidity in any
          venue.
        </p>
        <h3>Validator and yield risk.</h3>
        <p>
          Any portion of pool reserves delegated to validators is subject to
          validator commission, downtime, slashing (if and when implemented on
          Solana), MEV behavior, and validator-side malfeasance. Staking yield
          is not guaranteed and may vary materially.
        </p>
        <h3>Key, infrastructure, and operator risk.</h3>
        <p>
          The manager keypair, the burn-loop host(s), the serverless API, the
          indexer database, the RPC providers, and the DNS for any front-end
          domain may be compromised, lost, degraded, or discontinued. Such
          events may pause the burn loop, render UI surfaces inaccessible, or
          otherwise disrupt the Services without affecting on-chain solvency.
        </p>
        <h3>Regulatory risk.</h3>
        <p>
          Liquid staking tokens, deflationary-fee tokens, and permissionless
          token-issuance infrastructure may be subject to evolving and
          inconsistent regulatory treatment globally. The Services may become
          illegal or restricted in your jurisdiction. You are responsible for
          monitoring applicable law.
        </p>
        <h3>Third-party risk.</h3>
        <p>
          The Services integrate with or display data from third parties —
          including Jupiter, Birdeye, Helius, HawkFi, Meteora, Raydium,
          CoinGecko, GitHub, X (Twitter), Telegram, and various RPC endpoints.
          The operator has no control over these third parties and is not
          responsible for their availability, accuracy, or actions.
        </p>
        <h3>Tax risk.</h3>
        <p>
          The tax treatment of staking yield, deflationary-fee accrual,
          transfer-fee burns, LP fees, and any other event arising from the
          Services is unsettled in most jurisdictions. The operator does not
          provide tax advice. Consult a qualified professional.
        </p>
      </>
    ),
  },
  {
    num: '08',
    id: 'no-advice',
    title: 'No Investment, Legal, or Tax Advice',
    eyebrow: 'we are not your advisor',
    body: (
      <>
        <p>
          Nothing on the Services constitutes investment, legal, accounting,
          tax, or any other professional advice. Numbers displayed — including
          but not limited to redemption rate, implied APR, doubling time,
          "$100/day" calculations, leaderboards, P&L estimates, and burn-loop
          projections — are <strong>informational only</strong> and may be
          inaccurate, delayed, or based on simplifying assumptions. They are
          not a recommendation to buy, sell, hold, lend, borrow, or LP into any
          asset.
        </p>
        <p>
          <strong>
            Past performance is not indicative of future results.
          </strong>{' '}
          The redemption ratio's monotonicity is a program-level property, not
          a guarantee of fiat or token-pair returns. Borrowing against
          stacSOL or any User LST introduces liquidation, oracle, and
          interest-rate risk that is not modeled or warned about by the
          Services.
        </p>
      </>
    ),
  },
  {
    num: '09',
    id: 'warranty',
    title: 'Disclaimer of Warranties',
    eyebrow: 'as-is',
    body: (
      <p>
        THE SERVICES ARE PROVIDED "<strong>AS IS</strong>" AND "
        <strong>AS AVAILABLE</strong>" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
        IMPLIED, INCLUDING BUT NOT LIMITED TO THE IMPLIED WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE,
        NON-INFRINGEMENT, ACCURACY, COMPLETENESS, AVAILABILITY, OR THAT THE
        SERVICES WILL BE UNINTERRUPTED, ERROR-FREE, SECURE, OR FREE OF VIRUSES
        OR HARMFUL COMPONENTS. THE OPERATOR DISCLAIMS ALL SUCH WARRANTIES TO
        THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW.
      </p>
    ),
  },
  {
    num: '10',
    id: 'liability',
    title: 'Limitation of Liability',
    eyebrow: 'the ceiling',
    body: (
      <>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL
          THE OPERATOR, ITS AFFILIATES, CONTRIBUTORS, OPERATORS, OR LICENSORS
          BE LIABLE TO YOU FOR ANY INDIRECT, INCIDENTAL, CONSEQUENTIAL,
          SPECIAL, PUNITIVE, OR EXEMPLARY DAMAGES, OR FOR ANY LOSS OF PROFITS,
          REVENUE, DATA, GOODWILL, OR DIGITAL ASSETS, ARISING OUT OF OR
          RELATING TO YOUR USE OF, OR INABILITY TO USE, THE SERVICES — EVEN IF
          THE OPERATOR HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
        </p>
        <p>
          THE OPERATOR'S TOTAL AGGREGATE LIABILITY TO YOU, FROM ALL CAUSES OF
          ACTION AND UNDER ALL THEORIES OF LIABILITY, WILL NOT EXCEED{' '}
          <strong>ONE HUNDRED U.S. DOLLARS (US$100)</strong>. THIS LIMITATION
          APPLIES NOTWITHSTANDING THE FAILURE OF ESSENTIAL PURPOSE OF ANY
          LIMITED REMEDY.
        </p>
        <p>
          Some jurisdictions do not allow the exclusion of certain warranties
          or the limitation of certain damages. The above limitations apply
          only to the extent permitted in your jurisdiction.
        </p>
      </>
    ),
  },
  {
    num: '11',
    id: 'indemnification',
    title: 'Indemnification',
    eyebrow: 'you cover us',
    body: (
      <p>
        You agree to defend, indemnify, and hold harmless the operator, its
        affiliates, contributors, and operators against any and all claims,
        damages, losses, liabilities, costs, and expenses (including
        reasonable attorneys' fees) arising out of or related to: (i) your
        access to or use of the Services; (ii) your violation of these Terms;
        (iii) your violation of any third-party right, including any
        intellectual property right, publicity, confidentiality, property, or
        privacy right; (iv) your violation of any applicable law; (v) any User
        LST you deploy via the factory, including all claims by holders or
        counterparties of that User LST; or (vi) any dispute between you and a
        third party arising from your use of the Services.
      </p>
    ),
  },
  {
    num: '12',
    id: 'ip',
    title: 'Intellectual Property & Open Source',
    eyebrow: 'the source',
    body: (
      <>
        <p>
          Source code published by the operator at{' '}
          <a
            href="https://github.com/staccDOTsol/stacSOL"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/staccDOTsol/stacSOL
          </a>{' '}
          and related repositories is licensed under the MIT License unless
          otherwise indicated. The Sanctum SPL stake-pool program is
          third-party software; your use of it is governed by its own license
          terms.
        </p>
        <p>
          The "stacc", "stacSOL", and "thystaccfloweth" marks, the editorial
          design of the front-end, and any non-source content are reserved to
          the operator. You may not use the marks or design to imply
          endorsement of, or association with, any User LST, third-party
          product, or service.
        </p>
      </>
    ),
  },
  {
    num: '13',
    id: 'modifications',
    title: 'Modifications & Discontinuation',
    eyebrow: 'things change',
    body: (
      <>
        <p>
          The operator may modify these Terms at any time by posting a revised
          version at this URL. The revised Terms take effect upon posting
          unless a later effective date is specified. Your continued use of
          the Services after the effective date constitutes acceptance.
        </p>
        <p>
          The operator may add, modify, suspend, or discontinue any part of
          the Services — including the burn loop, the indexer, the front-end
          UI, the API, the factory, or specific User-LST hosting — at any
          time, with or without notice, and without liability.
        </p>
      </>
    ),
  },
  {
    num: '14',
    id: 'law',
    title: 'Governing Law & Disputes',
    eyebrow: 'if it goes sideways',
    body: (
      <>
        <p>
          These Terms are governed by the laws of the operator's principal
          place of business, without regard to conflict-of-laws provisions.
          You agree that any dispute, claim, or controversy arising out of or
          relating to these Terms or the Services will be resolved exclusively
          by binding arbitration on an individual basis.{' '}
          <strong>
            You waive any right to participate in a class action, class-wide
            arbitration, or representative proceeding.
          </strong>
        </p>
        <p>
          Notwithstanding the foregoing, the operator may seek injunctive or
          equitable relief in any court of competent jurisdiction to protect
          its intellectual property, marks, infrastructure, or rights under
          these Terms.
        </p>
      </>
    ),
  },
  {
    num: '15',
    id: 'contact',
    title: 'Contact',
    eyebrow: 'reach out',
    body: (
      <>
        <p>
          Vulnerability reports, abuse complaints, and legal notices may be
          directed to{' '}
          <a
            href="https://t.me/notstacc"
            target="_blank"
            rel="noopener noreferrer"
          >
            @notstacc
          </a>{' '}
          on Telegram, or via the issue tracker of the relevant GitHub
          repository for non-sensitive matters.
        </p>
        <p>
          For pre-disclosure of security vulnerabilities, please follow
          responsible disclosure: DM{' '}
          <a
            href="https://t.me/notstacc"
            target="_blank"
            rel="noopener noreferrer"
          >
            @notstacc
          </a>{' '}
          with details and a reasonable window for remediation before public
          disclosure.
        </p>
      </>
    ),
  },
]

// Nav rendered via shared EditorialNav (see components/EditorialNav.tsx).

export default function Terms() {
  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  return (
    <>
      <EditorialNav pathname="/terms" />
      <main className="terms-page shell">
        <header className="terms-hero">
          <div className="eyebrow" style={{ marginBottom: 16 }}>
            terms of service
          </div>
          <h1>
            The <em>fine print.</em>
          </h1>
          <div className="meta">
            <span>v1.0</span>
            <span>effective · 2026-05-12</span>
            <span>jurisdiction · operator's principal place of business</span>
          </div>
          <p className="lede">
            These Terms govern your use of <strong>stacSOL</strong>, the
            permissionless LST factory built on a fork of the Sanctum SPL
            stake-pool program, and any related software, scripts, indexers,
            leaderboards, and front-ends operated under the{' '}
            <strong>stacc</strong> brand. Read them in full before
            transacting.
          </p>
        </header>

        <div className="terms-grid">
          <nav className="terms-toc" aria-label="Terms sections">
            {TERMS_SECTIONS.map(s => (
              <a key={s.id} href={`#${s.id}`}>
                <span>{s.title}</span>
                <span className="num">{s.num}</span>
              </a>
            ))}
          </nav>

          <div className="terms-body">
            {TERMS_SECTIONS.map(s => (
              <section className="terms-section" id={s.id} key={s.id}>
                <span className="num">
                  § {s.num} · {s.eyebrow}
                </span>
                <h2>{s.title}</h2>
                {s.body}
              </section>
            ))}

            <section className="terms-section" id="ack">
              <span className="num">§ — · acknowledgement</span>
              <h2>You have read this.</h2>
              <p>
                By minting, holding, transferring, LPing, deploying, or
                otherwise interacting with anything described here, you affirm
                that you have read, understood, and accepted these Terms. If
                the operator and you have entered into any other agreement,
                that other agreement does not modify these Terms unless it
                explicitly references and supersedes them.
              </p>
              <div className="terms-callout">
                <span className="lbl">disclosure</span>
                This document is a template provided as part of the dapp's
                information architecture. It has not been reviewed by counsel
                for the operator's specific jurisdiction. Operator should have
                a qualified attorney review and tailor it before relying on it
                for any listing, exchange, or regulatory filing.
              </div>
            </section>
          </div>
        </div>
      </main>
    </>
  )
}
