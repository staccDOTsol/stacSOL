/**
 * Unstick the stacSOL bank run: pull delegated stake out of the lone
 * validator back toward the reserve so WithdrawSol works again.
 *
 * Mechanism: staker (WzMaL78…, also manager) calls DecreaseValidatorStake
 * WithReserve. The amount splits off the validator's active stake into a
 * transient account and begins deactivating. It lands in the reserve only
 * AFTER the next epoch boundary + an UpdateStakePoolBalance crank (see
 * scripts/finish-reserve-refill via `updateStakePool`). NOT instant.
 *
 * The pool program is a FORK (SP12tWFx…), not the canonical SPoo1…, but it
 * uses the identical spl-stake-pool instruction layout (verified against
 * historical tags: 10=WithdrawStake, 6=UpdateValidatorListBalance). So we
 * build the ix with the SDK's instruction encoder, derive every PDA with the
 * FORK program id, and override ix.programId to the fork.
 *
 *   bun run scripts/decrease-stake.ts                # simulate only (default)
 *   bun run scripts/decrease-stake.ts --send         # actually send
 *   LEAVE_SOL=5 bun run scripts/decrease-stake.ts    # leave 5 SOL delegated
 *
 * Env: RPC_URL, KEYPAIR_PATH (default ~/jjj.json)
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import { StakePoolInstruction } from '@solana/spl-stake-pool'

const PROGRAM = new PublicKey('SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY')
const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
const VOTE = new PublicKey('35GSjBdKG49hTh5xA9HViwQNEmZMzDigNvBpKJXjKKAv')

const send = process.argv.includes('--send')
const LEAVE_SOL = Number(process.env.LEAVE_SOL ?? 1.03) // delegated SOL to keep on the validator
const keypairPath = process.env.KEYPAIR_PATH ?? `${homedir()}/jjj.json`

const con = new Connection(process.env.RPC_URL!, 'confirmed')
const staker = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(readFileSync(keypairPath, 'utf8'))),
)

const pool = (await con.getAccountInfo(POOL))!.data
const validatorList = new PublicKey(pool.subarray(98, 130))
const reserveStake = new PublicKey(pool.subarray(130, 162))

const [withdrawAuthority] = PublicKey.findProgramAddressSync(
  [POOL.toBuffer(), Buffer.from('withdraw')],
  PROGRAM,
)
const [validatorStake] = PublicKey.findProgramAddressSync(
  [VOTE.toBuffer(), POOL.toBuffer()],
  PROGRAM,
)
// transientSeedSuffixStart is 0 in the validator list; the canonical helper
// bumps it by 1 for the non-additional path.
const transientStakeSeed = 1
const sbuf = Buffer.alloc(8)
sbuf.writeBigUInt64LE(BigInt(transientStakeSeed))
const [transientStake] = PublicKey.findProgramAddressSync(
  [Buffer.from('transient'), VOTE.toBuffer(), POOL.toBuffer(), sbuf],
  PROGRAM,
)

// Read live validator-list active stake for this validator.
const vl = (await con.getAccountInfo(validatorList))!.data
const activeStake = vl.readBigUInt64LE(9) // first entry active_stake_lamports
const leaveLamports = BigInt(Math.floor(LEAVE_SOL * 1e9))
const lamports = Number(activeStake - leaveLamports)

console.log('staker            :', staker.publicKey.toBase58())
console.log('validator_stake   :', validatorStake.toBase58())
console.log('transient_stake   :', transientStake.toBase58())
console.log('withdraw_authority:', withdrawAuthority.toBase58())
console.log('reserve_stake     :', reserveStake.toBase58())
console.log('active stake      :', (Number(activeStake) / 1e9).toFixed(4), 'SOL')
console.log('decreasing        :', (lamports / 1e9).toFixed(4), 'SOL (leaving', LEAVE_SOL, 'SOL delegated)')

if (lamports <= 0) throw new Error('nothing to decrease')

// Use the non-reserve DecreaseValidatorStake: it funds the new transient
// account's rent from the validator-stake split itself, NOT the reserve.
// The WithReserve variant fails here because the reserve is drained (0.003
// SOL) — it can't fund the transient rent, which is the very condition we're
// trying to fix. `reserveStake` stays read for logging only.
void reserveStake
const ix = StakePoolInstruction.decreaseValidatorStake({
  stakePool: POOL,
  staker: staker.publicKey,
  withdrawAuthority,
  validatorList,
  validatorStake,
  transientStake,
  lamports,
  transientStakeSeed,
})
ix.programId = PROGRAM // override canonical SPoo1… → fork SP12tWFx…

const tx = new Transaction().add(ix)
tx.feePayer = staker.publicKey
const { blockhash, lastValidBlockHeight } = await con.getLatestBlockhash()
tx.recentBlockhash = blockhash
tx.sign(staker)

const sim = await con.simulateTransaction(tx)
console.log('\n=== SIMULATION ===')
console.log('err  :', JSON.stringify(sim.value.err))
console.log('units:', sim.value.unitsConsumed)
console.log((sim.value.logs ?? []).join('\n'))

if (sim.value.err) {
  console.error('\n✗ simulation failed — NOT sending')
  process.exit(1)
}
if (!send) {
  console.log('\n✓ simulation clean. Re-run with --send to broadcast.')
  process.exit(0)
}

const { sendAndConfirmRawTransaction } = await import('@solana/web3.js')
const sig = await sendAndConfirmRawTransaction(con, tx.serialize(), {
  commitment: 'confirmed',
})
console.log('\n✓ SENT:', sig)
console.log('blockhash valid until height', lastValidBlockHeight)
