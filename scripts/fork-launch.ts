#!/usr/bin/env bun
/**
 * stacSOL fork launcher.
 *
 * Two steps to stand up a clean copy of the protocol with a 13.8% transfer
 * fee whose harvest is split 50/50 (burn for NAV + liqd-to-SOL → PDA):
 *
 *   STEP 1 (this script): create a fresh Token-2022 mint with a
 *     TransferFeeConfig of 1380 bps (13.8%) and an effectively-uncapped
 *     maximum fee, decimals 9. All authorities (mint, freeze, transfer-fee,
 *     withdraw-withheld) are set to the launch wallet.
 *
 *   STEP 2 (spl-stake-pool CLI): create a Sanctum SPL stake pool that USES
 *     that mint as its pool token. This is the audited, standard path — we do
 *     NOT hand-roll the pool's Initialize instruction (getting it wrong wastes
 *     real SOL). If the `spl-stake-pool` CLI is on PATH this script runs it for
 *     you; otherwise it prints the exact command to run.
 *
 * After both steps, set in your dapp / burn-loop env:
 *   VITE_MINT / MINT  = <mint from step 1>
 *   VITE_POOL / POOL  = <pool from step 2>
 *   LIQD_DESTINATION  = <the PDA the SOL half is routed to>
 *
 * SECURITY: the launch key is read at runtime from KEYPAIR_JSON or KEYPAIR.
 * It is never written to the repo. Use a FRESH key — any key you have ever
 * pasted into a chat / log is compromised and must not control a real mint.
 *
 *   # dry-run (default — prints the plan, signs nothing):
 *   RPC_URL="https://your-rpc/key" KEYPAIR=./launch.json \
 *     bun run scripts/fork-launch.ts
 *
 *   # execute (creates the mint on mainnet):
 *   RPC_URL="https://your-rpc/key" KEYPAIR=./launch.json \
 *     bun run scripts/fork-launch.ts --execute
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getMintLen,
  createInitializeTransferFeeConfigInstruction,
  createInitializeMintInstruction,
} from '@solana/spl-token'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'

// ------------------------------------------------------------------- config
const DECIMALS = Number(process.env.DECIMALS ?? 9)
// 1380 bps = 13.8% — the fork transfer fee.
const FEE_BPS = Number(process.env.FEE_BPS ?? 1380)
// Effectively-uncapped max fee so 13.8% always applies, even to large moves.
const MAX_FEE = BigInt(process.env.MAX_FEE ?? '18446744073709551615') // u64 max

// Stake-pool fees for step 2 (separate from the T22 transfer fee).
//   - epoch/withdrawal: 0 by default — the only ongoing fee is the 13.8% T22
//     transfer fee whose harvest is split (burn + liqd-to-SOL → PDA).
//   - deposit: 13.8% (1380/10000) to mirror the original referral mechanic —
//     50% of it (6.9%) is kicked to the referrer, 50% to the manager. Set
//     DEPOSIT_FEE=0/100 if you want SOL→stacSOL mints to be fee-free.
const EPOCH_FEE = process.env.EPOCH_FEE ?? '0/100'
const WITHDRAWAL_FEE = process.env.WITHDRAWAL_FEE ?? '0/100'
const DEPOSIT_FEE = process.env.DEPOSIT_FEE ?? '1380/10000'
const REFERRAL_FEE = process.env.REFERRAL_FEE ?? '50' // % of deposit fee to referrer
const MAX_VALIDATORS = process.env.MAX_VALIDATORS ?? '2950'

const RPC_URL = process.env.RPC_URL
if (!RPC_URL) throw new Error('set RPC_URL')

const EXECUTE = process.argv.includes('--execute')

function loadLaunchKey(): Keypair {
  const raw = process.env.KEYPAIR_JSON
  if (raw && raw.trim()) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)))
  const path = process.env.KEYPAIR
  if (!path) {
    throw new Error(
      'provide the launch key via KEYPAIR=/path/to/launch.json or ' +
        'KEYPAIR_JSON="$(cat launch.json)". Use a FRESH key — never one that ' +
        'has been pasted into a chat or log.',
    )
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, 'utf-8'))))
}

async function main() {
  const conn = new Connection(RPC_URL!, 'confirmed')
  const payer = loadLaunchKey()
  const mintKp = Keypair.generate()

  console.log('▸ stacSOL fork launcher')
  console.log(`  rpc        ${RPC_URL!.split('?')[0]}?`)
  console.log(`  mode       ${EXECUTE ? 'EXECUTE (mainnet)' : 'dry-run (pass --execute)'}`)
  console.log(`  payer      ${payer.publicKey.toBase58()}`)
  console.log(`  new mint   ${mintKp.publicKey.toBase58()}`)
  console.log(`  decimals   ${DECIMALS}`)
  console.log(`  fee        ${FEE_BPS} bps (${FEE_BPS / 100}%)  maxFee=${MAX_FEE === 18446744073709551615n ? 'uncapped' : MAX_FEE.toString()}`)

  const bal = await conn.getBalance(payer.publicKey)
  console.log(`  payer bal  ${(bal / 1e9).toFixed(6)} SOL`)
  if (EXECUTE && bal < 0.05 * 1e9) {
    throw new Error('payer balance < 0.05 SOL — fund the launch wallet before --execute')
  }

  // ---- STEP 1: Token-2022 mint with TransferFeeConfig --------------------
  const extensions = [ExtensionType.TransferFeeConfig]
  const mintLen = getMintLen(extensions)
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen)

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mintKp.publicKey,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // transfer-fee-config + withdraw-withheld authorities = launch wallet
    createInitializeTransferFeeConfigInstruction(
      mintKp.publicKey,
      payer.publicKey, // transferFeeConfigAuthority
      payer.publicKey, // withdrawWithheldAuthority
      FEE_BPS,
      MAX_FEE,
      TOKEN_2022_PROGRAM_ID,
    ),
    createInitializeMintInstruction(
      mintKp.publicKey,
      DECIMALS,
      payer.publicKey, // mint authority (held by the pool program after step 2)
      payer.publicKey, // freeze authority
      TOKEN_2022_PROGRAM_ID,
    ),
  )

  console.log('\n▸ STEP 1 — create Token-2022 mint')
  console.log(`  mint rent  ${(lamports / 1e9).toFixed(6)} SOL (${mintLen} bytes)`)

  if (!EXECUTE) {
    console.log('  (dry-run) would create the mint above. Re-run with --execute.')
  } else {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer, mintKp], {
      commitment: 'confirmed',
    })
    console.log(`  ✓ mint created: ${mintKp.publicKey.toBase58()}`)
    console.log(`  ✓ sig:          ${sig}`)
  }

  // ---- STEP 2: Sanctum SPL stake pool over that mint ---------------------
  // The audited route is the spl-stake-pool CLI with --mint pointing at our
  // T22 mint. We never hand-roll Initialize here.
  console.log('\n▸ STEP 2 — create the stake pool (spl-stake-pool CLI)')
  const cliArgs = [
    'create-pool',
    '--mint', mintKp.publicKey.toBase58(),
    '--epoch-fee-numerator', EPOCH_FEE.split('/')[0],
    '--epoch-fee-denominator', EPOCH_FEE.split('/')[1],
    '--withdrawal-fee-numerator', WITHDRAWAL_FEE.split('/')[0],
    '--withdrawal-fee-denominator', WITHDRAWAL_FEE.split('/')[1],
    '--deposit-fee-numerator', DEPOSIT_FEE.split('/')[0],
    '--deposit-fee-denominator', DEPOSIT_FEE.split('/')[1],
    '--referral-fee', REFERRAL_FEE,
    '--max-validators', MAX_VALIDATORS,
  ]
  const hasCli = spawnSync('spl-stake-pool', ['--version'], { stdio: 'ignore' }).status === 0
  console.log(`  spl-stake-pool CLI: ${hasCli ? 'found' : 'NOT found on PATH'}`)
  console.log('  command:')
  console.log(`    RPC_URL="${RPC_URL!}" \\`)
  console.log(`    spl-stake-pool --url "${RPC_URL!}" ${cliArgs.join(' ')}`)
  if (!hasCli) {
    console.log('  install: cargo install spl-stake-pool-cli  (or use Sanctum tooling)')
  }
  if (EXECUTE && hasCli) {
    console.log('  running create-pool...')
    const r = spawnSync('spl-stake-pool', ['--url', RPC_URL!, ...cliArgs], {
      stdio: 'inherit',
    })
    if (r.status !== 0) throw new Error(`spl-stake-pool create-pool exited ${r.status}`)
  } else if (EXECUTE) {
    console.log('  ⚠ CLI missing — run the command above manually to finish step 2.')
  }

  console.log('\n▸ Next — wire the addresses into env:')
  console.log(`  MINT=${mintKp.publicKey.toBase58()}`)
  console.log('  POOL=<pool pubkey printed by create-pool>')
  console.log('  LIQD_DESTINATION=<the PDA the SOL half is routed to>')
  console.log('  then run: bun run scripts/burn-loop.ts')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
