/**
 * Roll-call: SOL + stacSOL balances for the public protocol wallets and
 * any keypair JSONs you keep locally (dev convenience, never bundled).
 *
 * Usage:
 *   RPC_URL="https://your-rpc/key" KEYS_DIR=./keys \
 *     bun run scripts/check-wallets.ts
 *
 *   # or pass extra wallets as CLI args:
 *   RPC_URL="https://your-rpc/key" \
 *     bun run scripts/check-wallets.ts SomePub… AnotherPub…
 */

import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

const RPC = process.env.RPC_URL
if (!RPC) throw new Error('set RPC_URL env var')
const KEYS_DIR = process.env.KEYS_DIR // optional — only if you keep local keypairs

const STACSOL_MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

// Public, on-chain protocol-owned addresses. Safe to share — these are
// referenced in src/lib/referrer.ts (marketing default) and surface through
// other code paths, anyone can derive them.
const PUBLIC_WALLETS: { label: string; pk: PublicKey }[] = [
  { label: 'marketing-default', pk: new PublicKey('Bq4KMaVvzemx4tyfoyhZ7Kooo494GEv1xq9MLgRkfF6j') },
]

function deriveAta(owner: PublicKey, mint: PublicKey, programId: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )
  return ata
}

async function main() {
  const conn = new Connection(RPC, 'confirmed')

  const wallets: { label: string; pk: PublicKey }[] = [...PUBLIC_WALLETS]

  // CLI-passed extras: anything that parses as a base58 pubkey is added.
  for (const arg of process.argv.slice(2)) {
    try {
      wallets.push({ label: 'cli', pk: new PublicKey(arg) })
    } catch {
      console.warn(`skipping non-pubkey CLI arg: ${arg}`)
    }
  }

  // Walk an optional KEYS_DIR for keypair JSON files (local-only). Files
  // whose contents aren't a 64-byte JSON array are silently skipped.
  if (KEYS_DIR && existsSync(KEYS_DIR)) {
    const files = readdirSync(KEYS_DIR).filter((f) => f.endsWith('.json') && f !== '.gitkeep')
    for (const f of files) {
      try {
        const raw = JSON.parse(readFileSync(join(KEYS_DIR, f), 'utf8'))
        if (Array.isArray(raw) && raw.length === 64) {
          const kp = Keypair.fromSecretKey(new Uint8Array(raw))
          wallets.push({ label: `keys/${f}`, pk: kp.publicKey })
        }
      } catch {
        // skip non-keypair JSONs
      }
    }
  }

  // Dedupe by pubkey
  const seen = new Set<string>()
  const dedup = wallets.filter((w) => {
    const k = w.pk.toBase58()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  console.log(`checking ${dedup.length} wallets…\n`)
  let totalSol = 0
  let totalStac = 0n

  for (const w of dedup) {
    const sol = await conn.getBalance(w.pk).catch(() => 0)
    let stac = 0n
    try {
      const ata = deriveAta(w.pk, STACSOL_MINT, TOKEN_2022)
      const acc = await conn.getAccountInfo(ata)
      if (acc) stac = acc.data.readBigUInt64LE(64)
    } catch {}
    const solUi = sol / LAMPORTS_PER_SOL
    const stacUi = Number(stac) / 1e9
    totalSol += solUi
    totalStac += stac
    console.log(`${w.label.padEnd(28)}  ${w.pk.toBase58()}`)
    console.log(`  SOL: ${solUi.toFixed(6).padStart(14)}  ·  stacSOL: ${stacUi.toFixed(6).padStart(14)}`)
    console.log()
  }

  // Also check pool reserve + manager ATA from pool config
  const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
  const poolAcc = await conn.getAccountInfo(POOL, 'processed')
  if (poolAcc) {
    const reserveStake = new PublicKey(poolAcc.data.subarray(130, 162))
    const managerFeeAccount = new PublicKey(poolAcc.data.subarray(194, 226))
    const totalLamports = poolAcc.data.readBigUInt64LE(258)
    console.log('---- pool extras ----')
    console.log(`reserve stake account     ${reserveStake.toBase58()}`)
    const reserveAcc = await conn.getAccountInfo(reserveStake)
    if (reserveAcc) console.log(`  liquid SOL: ${(reserveAcc.lamports / 1e9).toFixed(6)}`)
    console.log(`  pool.totalLamports: ${(Number(totalLamports) / 1e9).toFixed(6)}`)
    console.log()
    console.log(`manager fee acct (stacSOL ATA)  ${managerFeeAccount.toBase58()}`)
    const mAcc = await conn.getAccountInfo(managerFeeAccount)
    if (mAcc) {
      const mStac = mAcc.data.readBigUInt64LE(64)
      console.log(`  stacSOL: ${(Number(mStac) / 1e9).toFixed(6)}`)
    }
  }

  console.log('\n----- TOTAL across keypair-controlled wallets -----')
  console.log(`SOL:     ${totalSol.toFixed(6)}`)
  console.log(`stacSOL: ${(Number(totalStac) / 1e9).toFixed(6)}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
