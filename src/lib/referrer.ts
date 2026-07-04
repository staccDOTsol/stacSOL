// Stacc-ui referrer plumbing.
//
// The Sanctum stake pool charges a 6.9% deposit fee on SOL → stacSOL. The
// pool config splits that fee with a referrer:
//
//     manager      = 50%   (3.45% of deposit, kept by stacc)
//     referrer     = 50%   (3.45% of deposit, paid into a stacSOL ATA)
//
// The referrer ATA is one of the accounts in the DepositSol ix. The UI
// ALWAYS points that slot at the marketing wallet below — there is no
// `?ref=` override, no localStorage referrer, no user-specified referrer.
// Every deposit signed through this UI credits the marketing budget.

import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { MINT, TOKEN_2022 } from './constants'

/** The one and only referrer — collects the 50% referral share of the 6.9%
 *  deposit fee on every mint. Routed to the marketing wallet so the referral
 *  revenue flows back into the bait-loop's operating budget (the manager
 *  wallet is what funds bait + collects recovery via WithdrawSol). Treated
 *  as the SOURCE OF TRUTH for "referrer" — update here when rotating. */
export const MARKETING_REFERRER = new PublicKey(
  'Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j',
)

/**
 * Derive the referrer's stacSOL ATA. Always paired with an idempotent
 * create ix paid by the depositor — the ATA MUST exist before DepositSol
 * runs or it errors with AccountNotInitialized on the referral slot.
 *
 * Cost to depositor: ~0.002 SOL of rent for the ATA, refundable if the
 * referrer ever closes their ATA. Cheap insurance vs the deposit failing.
 *
 * Returns:
 *   - `referrerAta` — pubkey of the referrer's stacSOL ATA
 *   - `createIx` — the idempotent ATA-create ix to prepend to the deposit tx
 */
export function deriveReferrerAtaAndCreateIx(args: {
  payer: PublicKey
  referrer: PublicKey
}): { referrerAta: PublicKey; createIx: TransactionInstruction } {
  // allowOwnerOffCurve=true so PDA-shaped referrers (the marketing wallet
  // itself is off-curve) work transparently.
  const referrerAta = getAssociatedTokenAddressSync(
    MINT,
    args.referrer,
    true,
    TOKEN_2022,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  const createIx = createAssociatedTokenAccountIdempotentInstruction(
    args.payer,
    referrerAta,
    args.referrer,
    MINT,
    TOKEN_2022,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  return { referrerAta, createIx }
}
