import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'
import { ATA_PROGRAM, MINT, TOKEN_2022 } from './constants'
import {
  WRAPPER_PROGRAM,
  WRAPPER_STATE,
  WRAPPER_VAULT,
  WSTACSOL_MINT,
} from './wrapper-constants'

// Classic SPL Token program id — the program that owns the wstacSOL v1 mint.
// (Token-2022 owns the underlying stacSOL.)
const TOKEN_PROGRAM = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
)

// Anchor instruction discriminators = sha256(`global:${name}`).slice(0, 8).
// Pre-computed so we don't hash on every call (and so this file has zero
// runtime deps on `crypto`).
const DISC_WRAP = Uint8Array.from([178, 40, 10, 189, 228, 129, 186, 140])
const DISC_UNWRAP = Uint8Array.from([126, 175, 198, 14, 212, 69, 50, 44])

const u64le = (v: bigint | number): Uint8Array => {
  const n = BigInt(v)
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn)
  return out
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

const ataFor = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey) => {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )
  return ata
}

export function deriveWrapAtas(owner: PublicKey) {
  return {
    underlying: ataFor(owner, MINT, TOKEN_2022),
    wrapped: ataFor(owner, WSTACSOL_MINT, TOKEN_PROGRAM),
  }
}

/**
 * Wrap `amount` (raw u64, 9 decimals) stacSOL → wstacSOL.
 *
 * The wrapper uses vault-balance-delta accounting, so the actual wstacSOL
 * minted equals `amount × (1 − 690 bps)` — i.e. the net amount that arrives
 * in the vault after the underlying's transfer fee is withheld. The user
 * supplies the gross; the program mints the net.
 *
 * Account order MUST match `programs/wrapper/src/instructions/wrap.rs`:
 *   user, state, underlying, wrapped, vault, user_under_ata, user_wrap_ata,
 *   underlying_tp, wrapped_tp, ata_program, system_program.
 */
export function ixWrap(user: PublicKey, amount: bigint): TransactionInstruction {
  const { underlying, wrapped } = deriveWrapAtas(user)
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: WRAPPER_STATE, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: WSTACSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: WRAPPER_VAULT, isSigner: false, isWritable: true },
      { pubkey: underlying, isSigner: false, isWritable: true },
      { pubkey: wrapped, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(DISC_WRAP, u64le(amount))),
  })
}

/**
 * Unwrap `amount` (raw u64) wstacSOL → stacSOL.
 *
 * Burns `amount` wstacSOL, then transfers `amount` underlying out of the
 * vault. The underlying's 690-bps transfer fee applies to that vault → user
 * leg, so the user actually receives `amount × (1 − 690 bps)` stacSOL.
 *
 * Same account order as wrap — only the init_if_needed semantics differ
 * (program-side), which doesn't affect the client.
 */
export function ixUnwrap(user: PublicKey, amount: bigint): TransactionInstruction {
  const { underlying, wrapped } = deriveWrapAtas(user)
  return new TransactionInstruction({
    programId: WRAPPER_PROGRAM,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: WRAPPER_STATE, isSigner: false, isWritable: false },
      { pubkey: MINT, isSigner: false, isWritable: false },
      { pubkey: WSTACSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: WRAPPER_VAULT, isSigner: false, isWritable: true },
      { pubkey: underlying, isSigner: false, isWritable: true },
      { pubkey: wrapped, isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(DISC_UNWRAP, u64le(amount))),
  })
}

/**
 * Idempotent ATA-create for the wrapped (SPL) mint. The wrap ix is
 * `init_if_needed` for the wrapped ATA program-side, so this is only
 * needed if we want to PREPEND the create to keep the wrap ix lean OR if
 * the user is on a wallet that chokes on init_if_needed sizing.
 *
 * Mirrors `ixCreateAtaIdempotent` from `lib/ix.ts` but pinned to the SPL
 * token program (wstacSOL).
 */
export function ixCreateWrappedAtaIdempotent(
  payer: PublicKey,
  owner: PublicKey,
): TransactionInstruction {
  const ata = ataFor(owner, WSTACSOL_MINT, TOKEN_PROGRAM)
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: WSTACSOL_MINT, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  })
}

export { TOKEN_PROGRAM as WSTACSOL_TOKEN_PROGRAM }
