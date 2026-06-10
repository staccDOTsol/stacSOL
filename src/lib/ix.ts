import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  StakeProgram,
} from '@solana/web3.js'
import { ATA_PROGRAM, MINT, POOL, POOL_PROGRAM, TOKEN_2022 } from './constants'
import type { PoolState } from './pool'

const enc = new TextEncoder()

const u8 = (n: number) => new Uint8Array([n & 0xff])
const u64le = (v: bigint | number) => {
  const n = BigInt(v)
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(i * 8)) & 0xffn)
  return out
}
const concat = (...arrs: Uint8Array[]) => {
  const total = arrs.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrs) {
    out.set(a, off)
    off += a.length
  }
  return out
}

export function deriveAta(owner: PublicKey, mint = MINT, tokenProgram = TOKEN_2022) {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()],
    ATA_PROGRAM,
  )
  return ata
}

export function deriveWithdrawAuth() {
  const [auth] = PublicKey.findProgramAddressSync(
    [POOL.toBytes(), enc.encode('withdraw')],
    POOL_PROGRAM,
  )
  return auth
}

export function ixCreateAtaIdempotent(
  payer: PublicKey,
  owner: PublicKey,
  mint = MINT,
  tokenProgram = TOKEN_2022,
) {
  const ata = deriveAta(owner, mint, tokenProgram)
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(u8(1)), // CreateIdempotent
  })
}

// SPL stake pool v1.0.0 — DepositSol = variant 14.
//
// Account slot 6 is the referral stacSOL ATA. Whoever owns that ATA collects
// the pool's `sol_referral_fee` share of the deposit fee (currently 50% of
// the 6.9% deposit fee = ~3.45% of the deposit amount). When `referralAta`
// is omitted we fall back to the depositor's own ATA — the fee then comes
// straight back to the user (effectively a self-rebate).
//
// The supplied `referralAta` MUST exist on chain before this ix runs; the
// caller is responsible for prepending an idempotent ATA-create ix when
// pointing at someone else's wallet (`deriveReferrerAtaAndCreateIx` in
// `lib/referrer.ts` builds both pubkey + create-ix in one call).
export function ixDepositSol(
  funder: PublicKey,
  lamports: bigint,
  pool: PoolState,
  referralAta?: PublicKey,
) {
  const withdrawAuth = deriveWithdrawAuth()
  const userAta = deriveAta(funder)
  const referral = referralAta ?? userAta
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: pool.reserveStake, isSigner: false, isWritable: true },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: referral, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(u8(14), u64le(lamports))),
  })
}

// SPL stake pool v1.0.0 — WithdrawSol = variant 16
export function ixWithdrawSol(burner: PublicKey, poolTokens: bigint, pool: PoolState) {
  const withdrawAuth = deriveWithdrawAuth()
  const userAta = deriveAta(burner)
  return new TransactionInstruction({
    programId: POOL_PROGRAM,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: withdrawAuth, isSigner: false, isWritable: false },
      { pubkey: burner, isSigner: true, isWritable: false }, // user_transfer_authority
      { pubkey: userAta, isSigner: false, isWritable: true },
      { pubkey: pool.reserveStake, isSigner: false, isWritable: true },
      { pubkey: burner, isSigner: false, isWritable: true }, // recipient lamport account
      { pubkey: pool.managerFeeAccount, isSigner: false, isWritable: true },
      { pubkey: MINT, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concat(u8(16), u64le(poolTokens))),
  })
}
