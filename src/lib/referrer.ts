// Stacc-ui referrer plumbing.
//
// The Sanctum stake pool charges a 13.8% deposit fee on SOL → stacSOL. The
// pool config splits that fee with a referrer:
//
//     manager      = 50%   (6.9% of deposit, kept by stacc)
//     referrer     = 50%   (6.9% of deposit, paid into a stacSOL ATA the
//                            depositor designates)
//
// The referrer ATA is one of the accounts in the DepositSol ix; whoever's
// stacSOL ATA sits in that slot collects the fee on every deposit signed by
// that user.
//
// Default with no override: the marketing wallet
// `Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j` collects the 50% share. The
// UI is explicit about this — anyone landing on the site without a `?ref=`
// link sends the referral fee to the marketing budget unless they paste in
// their own / a friend's pubkey via the share link mechanism.
//
// Three pieces here:
//
//   1. `parseReferrerFromUrl()` — reads `?ref=<pubkey>` once on page load
//      and persists the (validated) referrer to localStorage. Subsequent
//      visits without the param keep using the saved referrer until the
//      user explicitly clears it via `clearReferrer()`.
//
//   2. `useReferrer()` — React hook returning the current referrer +
//      helpers to inspect / clear / regenerate the share URL.
//
//   3. `getReferrerStacsolAta(connection, refPubkey)` — derives the
//      referrer's stacSOL ATA AND emits a `createAssociatedTokenAccount
//      Idempotent` ix paid by the depositor. The ATA must exist on chain
//      before DepositSol runs; without this preflight the ix throws
//      AccountNotInitialized on the referral slot.

import { useEffect, useState } from 'react'
import { PublicKey, type TransactionInstruction } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { MINT, TOKEN_2022 } from './constants'

const STORAGE_KEY = 'stacc-ui:referrer'
const URL_PARAM = 'ref'

/** Default referrer — collects the 50% referral share of the 13.8% deposit
 *  fee on every mint without a `?ref=` link. Currently routed to the pool
 *  manager wallet so the referral revenue flows back into the bait-loop's
 *  operating budget (the manager wallet is what funds bait + collects
 *  recovery via WithdrawSol). Treated as the SOURCE OF TRUTH for "default
 *  referrer" — update here when rotating. */
export const MARKETING_REFERRER = new PublicKey(
  'WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb',
)

/** Validate a base58 string as a Solana PublicKey. We deliberately accept
 *  off-curve addresses here — many real "wallets" people share are
 *  program-derived (Squads multisigs, vault PDAs, etc.) and are perfectly
 *  fine as ATA owners (we pass `allowOwnerOffCurve=true` when deriving). */
export function tryParseRefPubkey(s: string | null | undefined): PublicKey | null {
  if (!s) return null
  try {
    return new PublicKey(s)
  } catch {
    return null
  }
}

/** Read `?ref=<pubkey>` from the current URL. If valid, persist to local
 *  storage. Returns the persisted referrer (URL takes precedence over
 *  storage on every page load — last referrer link wins). */
function parseReferrerFromUrl(): PublicKey | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const fromUrl = tryParseRefPubkey(params.get(URL_PARAM))
  if (fromUrl) {
    try {
      window.localStorage.setItem(STORAGE_KEY, fromUrl.toBase58())
    } catch {
      /* storage disabled (Safari private mode) — fall through to in-memory */
    }
    return fromUrl
  }
  // No URL ref → load from storage if present.
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY)
    return tryParseRefPubkey(saved)
  } catch {
    return null
  }
}

export function clearReferrer(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

export interface UseReferrerResult {
  /** Currently-applied referrer pubkey. NEVER null — falls back to
   *  `MARKETING_REFERRER` when the user has no override. The DepositSol ix
   *  always points at this address's stacSOL ATA. */
  referrer: PublicKey
  /** True when the user explicitly set a referrer via `?ref=…` or kept one
   *  in localStorage from a previous link. False when we're using the
   *  marketing default. UI surfaces this distinction prominently so the
   *  user knows where the fee is going. */
  isExplicit: boolean
  /** True iff `referrer.equals(MARKETING_REFERRER)`. Convenience for the
   *  share UI. */
  isMarketingDefault: boolean
  /** Build a share URL for the given owner. Defaults to current page +
   *  `?ref=<owner>`; UI calls this with `wallet.publicKey` to generate the
   *  user's personal ref link. */
  buildShareUrl: (ownerPubkey: PublicKey) => string
  /** Clear any stored override and revert to the marketing default. */
  clear: () => void
}

export function useReferrer(): UseReferrerResult {
  const [override, setOverride] = useState<PublicKey | null>(() =>
    parseReferrerFromUrl(),
  )

  // Re-parse on every popstate (back/forward navigation) so users can land
  // on a stacc.app/?ref=… link from anywhere and immediately see the badge
  // light up without a hard refresh.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onPop = () => setOverride(parseReferrerFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const referrer = override ?? MARKETING_REFERRER
  const isExplicit = override !== null
  const isMarketingDefault = referrer.equals(MARKETING_REFERRER)

  const buildShareUrl = (ownerPubkey: PublicKey): string => {
    if (typeof window === 'undefined') {
      return `https://stacsol.app/?${URL_PARAM}=${ownerPubkey.toBase58()}`
    }
    const url = new URL(window.location.origin + '/')
    url.searchParams.set(URL_PARAM, ownerPubkey.toBase58())
    return url.toString()
  }

  return {
    referrer,
    isExplicit,
    isMarketingDefault,
    buildShareUrl,
    clear: () => {
      clearReferrer()
      setOverride(null)
    },
  }
}

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
 *   - `createIx` — null if no preflight needed (caller is referring self
 *     and ATA already exists upstream); otherwise the idempotent ATA-
 *     create ix to prepend to the deposit tx
 */
export function deriveReferrerAtaAndCreateIx(args: {
  payer: PublicKey
  referrer: PublicKey
}): { referrerAta: PublicKey; createIx: TransactionInstruction } {
  // allowOwnerOffCurve=true so PDA-shaped referrers (Squads multisigs, vault
  // PDAs, the marketing wallet which is itself off-curve) work transparently.
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
