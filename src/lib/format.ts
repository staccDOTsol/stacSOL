import { DECIMALS } from './constants'

// `places` default bumped 4 → 6: any sub-0.0001 token amount (referral
// credits, dust burns, tiny LP shares) previously rounded to `0.0000`. 6dp
// surfaces real values like `0.000123` and matches the redemption-rate
// precision used elsewhere on the site.
export function fmtAmount(big: bigint, decimals = DECIMALS, places = 6) {
  const n = Number(big) / Math.pow(10, decimals)
  return n.toLocaleString(undefined, {
    maximumFractionDigits: places,
    minimumFractionDigits: places,
  })
}

export function shortPk(pk: string) {
  return pk.slice(0, 4) + '…' + pk.slice(-4)
}

/**
 * Stable, non-reversible pseudonym derived from a wallet pubkey. Same
 * input → same output forever, but you can't recover the pubkey from the
 * pseudonym without exhaustively iterating all possible pubkeys. We use
 * this for non-doxxed leaderboard rows so they're still uniquely
 * identifiable across re-sorts but the underlying wallet stays private.
 *
 * Implementation: 32-bit FNV-1a hash → render 6 hex digits with a
 * fixed prefix. ~16M slots is more than enough for any current holder
 * set; collisions, if they ever happen, just mean two anonymous rows
 * happen to share a label — they're still distinct rows in the table.
 */
export function anonymousPseudonym(pk: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < pk.length; i++) {
    hash ^= pk.charCodeAt(i)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  const hex = hash.toString(16).padStart(8, '0').slice(0, 6)
  return `holder-${hex}`
}
