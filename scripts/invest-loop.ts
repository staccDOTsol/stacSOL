/**
 * staccsol invest loop — always-on daemon.
 *
 * Goal: continuously push idle wSOL from the staccsol vault's base account
 * into its underlying KLEND reserve, so depositors' SOL earns yield without
 * waiting for a manual "Invest" click.
 *
 * What this script does each cycle:
 *   1. Fetch VaultState (read-only) → token_available
 *   2. If token_available > MIN_INVEST_LAMPORTS, build investSingleReserveIxs
 *      via @kamino-finance/klend-sdk for the first allocation's reserve.
 *   3. Sign with the manager keypair, broadcast, confirm.
 *   4. Sleep INVEST_LOOP_TICK_MS and repeat.
 *
 * Why "first allocation's reserve":
 *   - The staccsol vault has weight=100 on Cn7xKd today; if you add more
 *     reserves later, we'd want to invest across all of them per-weight.
 *     For now this is intentionally single-reserve to keep the loop simple
 *     and match the live vault config. TODO: loop over all allocations once
 *     the vault has >1 active reserve.
 *
 * Why not a Vercel cron:
 *   - @kamino-finance/klend-sdk pulls in @orca-so/whirlpools-core (wasm)
 *     and other transitive deps that break under @vercel/node's CJS
 *     runtime. Running as a long-lived Bun/Node daemon (Railway, Fly,
 *     systemd, etc.) avoids the wedge entirely.
 *
 * Usage:
 *   RPC_URL="https://your-rpc/key"  \
 *   KEYPAIR=./manager.json          \
 *   bun run scripts/invest-loop.ts
 *
 *   # or pass key inline (Railway / Vercel-style secrets):
 *   RPC_URL="https://your-rpc/key"  \
 *   KEYPAIR_JSON="$(cat manager.json)" \
 *   bun run scripts/invest-loop.ts
 *
 *   # Override tuning via env:
 *   INVEST_LOOP_TICK_MS=300000      # default 5 min
 *   MIN_INVEST_LAMPORTS=10000000    # default 0.01 SOL — skip if available < this
 *   VAULT_ADDRESS=7grPoQ...         # default = staccsol
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { createSolanaRpc, createKeyPairSignerFromBytes } from '@solana/kit'
import {
  KaminoVault,
  KaminoVaultClient,
  VaultState,
} from '@kamino-finance/klend-sdk'
import fs from 'node:fs'

// -------------------------------------------------------------------- config
const RPC_URL = process.env.RPC_URL
if (!RPC_URL) {
  console.error('missing RPC_URL')
  process.exit(1)
}
const VAULT_ADDRESS =
  process.env.VAULT_ADDRESS ?? '7grPoQCXHgZwaBTNFcQjadWnSEP1zvb1EMtQPgTEE9sR'
const TICK_MS = Number(process.env.INVEST_LOOP_TICK_MS ?? 5 * 60 * 1000)
// Don't bother investing if available is below this — keeps the loop from
// spending fees on a fraction-of-a-cent invest. 0.01 SOL default.
const MIN_INVEST_LAMPORTS = BigInt(process.env.MIN_INVEST_LAMPORTS ?? 10_000_000)
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true'
const PRIORITY_FEE_MICROLAMPORTS = Number(process.env.PRIORITY_FEE_MICROLAMPORTS ?? 50_000)

// ------------------------------------------------------------------ keypair
function loadAuthority(): Keypair {
  const raw = process.env.KEYPAIR_JSON
  if (raw && raw.trim()) {
    const trimmed = raw.trim()
    // Support both base58-encoded 64-byte and JSON array forms.
    if (trimmed.startsWith('[')) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)))
    }
    // base58
    // Lazy require so we only pay for the dep if needed
    const bs58 = require('bs58').default ?? require('bs58')
    return Keypair.fromSecretKey(bs58.decode(trimmed))
  }
  const path = process.env.KEYPAIR
  if (!path) throw new Error('set KEYPAIR or KEYPAIR_JSON env var (manager keypair)')
  const bytes = JSON.parse(fs.readFileSync(path, 'utf-8'))
  return Keypair.fromSecretKey(Uint8Array.from(bytes))
}

const authority = loadAuthority()

// ---------------------------------------------------------------- connection
const conn = new Connection(RPC_URL, { commitment: 'confirmed' })
const kitRpc = createSolanaRpc(RPC_URL)
const kvaultClient = new KaminoVaultClient(kitRpc as any, 400)

// -------------------------------------------------------------------- utils
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fmtSol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(6)
function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

/** Convert a kit-style ix (with role-based accounts) to legacy web3.js. */
function kitToLegacy(kitIx: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(kitIx.programAddress),
    keys: kitIx.accounts.map((a: any) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === 2 || a.role === 3,
      isWritable: a.role === 1 || a.role === 3,
    })),
    data: Buffer.from(kitIx.data),
  })
}

// ----------------------------------------------------------- core operation
async function investOnce(): Promise<{ skipped: boolean; reason?: string; sig?: string; invested?: bigint }> {
  const vaultAddrPk = new PublicKey(VAULT_ADDRESS)
  // Fast pre-check: read available via raw RPC to skip without doing SDK work.
  const acc = await conn.getAccountInfo(vaultAddrPk, 'confirmed')
  if (!acc) return { skipped: true, reason: 'vault account missing' }
  // token_available lives at offset 224 (u64 LE) per the IDL layout.
  const available = acc.data.readBigUInt64LE(224)
  if (available < MIN_INVEST_LAMPORTS) {
    return { skipped: true, reason: `available ${fmtSol(available)} < min ${fmtSol(MIN_INVEST_LAMPORTS)}` }
  }

  // Load vault state via SDK + pick the first allocation's reserve.
  const vaultStateRes = await VaultState.fetch(kitRpc as any, VAULT_ADDRESS as any)
  if (!vaultStateRes) return { skipped: true, reason: 'VaultState.fetch returned null' }
  const vault = KaminoVault.loadWithClientAndState(
    kvaultClient,
    VAULT_ADDRESS as any,
    vaultStateRes,
  )
  // Use SDK to enumerate active allocations
  const activeReserves = (vaultStateRes.vaultAllocationStrategy as any[])
    .filter((a: any) => String(a.reserve) !== '11111111111111111111111111111111')
  if (activeReserves.length === 0) return { skipped: true, reason: 'no active allocations' }
  // For now, target the first active reserve. TODO: weighted distribution
  // across all allocations once vault has >1.
  const targetReserveAddr = String(activeReserves[0].reserve)

  // Build invest ixs via SDK (clean, matches deployed Kvault).
  const reservesMap = await kvaultClient.loadVaultReserves(vaultStateRes)
  const kReserve = reservesMap.get(targetReserveAddr as any)
  if (!kReserve) return { skipped: true, reason: `reserve ${targetReserveAddr} not loaded` }
  const adminSigner = await createKeyPairSignerFromBytes(authority.secretKey)
  const kitIxs = await kvaultClient.investSingleReserveIxs(
    adminSigner as any,
    vault,
    { address: targetReserveAddr as any, state: kReserve.state },
    reservesMap,
  )

  if (DRY_RUN) {
    log(`DRY_RUN: would invest ${fmtSol(available)} SOL into reserve ${targetReserveAddr.slice(0, 8)}…`)
    return { skipped: true, reason: 'DRY_RUN' }
  }

  // Build, sign, send.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('finalized')
  const msg = new TransactionMessage({
    payerKey: authority.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: PRIORITY_FEE_MICROLAMPORTS }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
      ...kitIxs.map(kitToLegacy),
    ],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([authority])
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false })
  const conf = await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    'confirmed',
  )
  if (conf.value.err) {
    throw new Error(`invest failed: ${JSON.stringify(conf.value.err)} (sig ${sig})`)
  }
  return { skipped: false, sig, invested: available }
}

// --------------------------------------------------------------------- main
async function main() {
  log(
    `starting invest-loop · vault=${VAULT_ADDRESS} · interval=${TICK_MS / 1000}s · ` +
      `min=${fmtSol(MIN_INVEST_LAMPORTS)} SOL · ` +
      `authority=${authority.publicKey.toBase58()} · ` +
      `rpc=${RPC_URL.split('?')[0]}? · ` +
      `dry=${DRY_RUN}`,
  )
  while (true) {
    try {
      const r = await investOnce()
      if (r.skipped) {
        log(`skip: ${r.reason}`)
      } else {
        log(`✅ invested ${fmtSol(r.invested!)} SOL · sig ${r.sig}`)
      }
    } catch (e) {
      log(`invest cycle error (suppressed): ${(e as Error).message}`)
    }
    await sleep(TICK_MS)
  }
}

main().catch((e) => {
  log(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
