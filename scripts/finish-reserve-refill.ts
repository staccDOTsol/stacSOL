/**
 * Second half of the bank-run fix. After scripts/decrease-stake.ts moved
 * 1,844 SOL into the transient stake account, this sweeps it into the reserve
 * once it has finished deactivating (i.e. AFTER the next epoch boundary).
 *
 * Runs three cranks against the fork pool program (SP12tWFx…):
 *   UpdateValidatorListBalance (variant 6) — WITH the [validatorStake,
 *     transientStake] pair appended as remaining accounts, which is what
 *     actually merges the deactivated transient into the reserve. (burn-loop's
 *     copy omits the pair, so it can't do this sweep.)
 *   UpdateStakePoolBalance (variant 7)
 *   CleanupRemovedValidatorEntries (variant 8)
 *
 * Idempotent + safe to run early: before deactivation completes the merge is
 * a no-op, so a scheduler can call it on a loop until the reserve fills.
 *
 *   bun run scripts/finish-reserve-refill.ts          # simulate
 *   bun run scripts/finish-reserve-refill.ts --send    # broadcast
 *
 * Env: RPC_URL, KEYPAIR_PATH (default ~/jjj.json — any fee payer works; these
 * cranks are permissionless).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  StakeProgram,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_STAKE_HISTORY_PUBKEY,
  sendAndConfirmRawTransaction,
} from '@solana/web3.js'

const PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
const MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const VOTE = new PublicKey('35GSjBdKG49hTh5xA9HViwQNEmZMzDigNvBpKJXjKKAv')

const send = process.argv.includes('--send')
const con = new Connection(process.env.RPC_URL!, 'confirmed')
const payer = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(process.env.KEYPAIR_PATH ?? `${homedir()}/jjj.json`, 'utf8'))),
)

const pool = (await con.getAccountInfo(POOL))!.data
const validatorList = new PublicKey(pool.subarray(98, 130))
const reserveStake = new PublicKey(pool.subarray(130, 162))
const managerFeeAccount = new PublicKey(pool.subarray(194, 226))

const [withdrawAuth] = PublicKey.findProgramAddressSync(
  [POOL.toBuffer(), Buffer.from('withdraw')],
  PROGRAM,
)
const [validatorStake] = PublicKey.findProgramAddressSync(
  [VOTE.toBuffer(), POOL.toBuffer()],
  PROGRAM,
)
const sbuf = Buffer.alloc(8)
sbuf.writeBigUInt64LE(1n)
const [transientStake] = PublicKey.findProgramAddressSync(
  [Buffer.from('transient'), VOTE.toBuffer(), POOL.toBuffer(), sbuf],
  PROGRAM,
)

// variant 6: [6, start_index u32, no_merge u8] + per-validator [vsa, transient]
const d6 = Buffer.alloc(6)
d6.writeUInt8(6, 0)
d6.writeUInt32LE(0, 1)
d6.writeUInt8(0, 5)
const updateList = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: POOL, isSigner: false, isWritable: false },
    { pubkey: withdrawAuth, isSigner: false, isWritable: false },
    { pubkey: validatorList, isSigner: false, isWritable: true },
    { pubkey: reserveStake, isSigner: false, isWritable: true },
    { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_STAKE_HISTORY_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: StakeProgram.programId, isSigner: false, isWritable: false },
    // remaining accounts: the validator's stake + transient pair
    { pubkey: validatorStake, isSigner: false, isWritable: true },
    { pubkey: transientStake, isSigner: false, isWritable: true },
  ],
  data: d6,
})

const updateBalance = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: POOL, isSigner: false, isWritable: true },
    { pubkey: withdrawAuth, isSigner: false, isWritable: false },
    { pubkey: validatorList, isSigner: false, isWritable: true },
    { pubkey: reserveStake, isSigner: false, isWritable: false },
    { pubkey: managerFeeAccount, isSigner: false, isWritable: true },
    { pubkey: MINT, isSigner: false, isWritable: true },
    { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
  ],
  data: Buffer.from([7]),
})

const cleanup = new TransactionInstruction({
  programId: PROGRAM,
  keys: [
    { pubkey: POOL, isSigner: false, isWritable: false },
    { pubkey: validatorList, isSigner: false, isWritable: true },
  ],
  data: Buffer.from([8]),
})

const reserveBefore = (await con.getAccountInfo(reserveStake))!.lamports / 1e9
const transientBefore = (await con.getAccountInfo(transientStake))?.lamports ?? 0
console.log('reserve before  :', reserveBefore.toFixed(4), 'SOL')
console.log('transient holds :', (Number(transientBefore) / 1e9).toFixed(4), 'SOL')

const tx = new Transaction().add(updateList, updateBalance, cleanup)
tx.feePayer = payer.publicKey
const { blockhash } = await con.getLatestBlockhash()
tx.recentBlockhash = blockhash
tx.sign(payer)

const sim = await con.simulateTransaction(tx)
console.log('\nsim err:', JSON.stringify(sim.value.err))
console.log((sim.value.logs ?? []).join('\n'))
if (sim.value.err) {
  console.error('\n✗ simulation failed — NOT sending')
  process.exit(1)
}
if (!send) {
  console.log('\n✓ simulation clean. Re-run with --send after the epoch boundary.')
  process.exit(0)
}
const sig = await sendAndConfirmRawTransaction(con, tx.serialize(), { commitment: 'confirmed' })
console.log('\n✓ SENT:', sig)
const reserveAfter = (await con.getAccountInfo(reserveStake))!.lamports / 1e9
console.log('reserve after   :', reserveAfter.toFixed(4), 'SOL')
