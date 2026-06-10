/**
 * Launch the "stacc on ketamine by mistake" token on Hatch.
 *
 * Idempotent flow:
 *   1. Create / load ~/.config/stacsol/hatch-launcher.json keypair.
 *   2. Print the pubkey and required balance. If under-funded, poll until
 *      the wallet has ≥ 0.3 SOL, then continue automatically.
 *   3. Call hatch-sdk's launch() with the staged metadata URL.
 *   4. Print mint, pool, signature, and a solscan link.
 *
 * Run with:
 *   pnpm tsx scripts/hatch-launch.ts
 *
 * Requires:
 *   RPC_URL          — Solana mainnet RPC (Helius/Triton/QuickNode).
 *   HATCH_FEE_RATE   — optional, "1.00" | "2.00" | "5.00" (default "1.00").
 *   HATCH_LAUNCH_MODE — optional, "normal" | "cto" (default "normal").
 *   HATCH_NAME       — optional override (default "stacc on ketamine by mistake").
 *   HATCH_SYMBOL     — optional override (default "KMINE").
 *   HATCH_URI        — optional override (default stacsol.app/launches/.../metadata.json).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'

const KEYPAIR_PATH =
  process.env.HATCH_LAUNCHER_KEYPAIR ??
  `${homedir()}/.config/stacsol/hatch-launcher.json`

const RPC_URL = process.env.RPC_URL
if (!RPC_URL) {
  console.error('RPC_URL env var required')
  process.exit(1)
}

const FEE_RATE = (process.env.HATCH_FEE_RATE ?? '1.00') as '1.00' | '2.00' | '5.00'
const LAUNCH_MODE = (process.env.HATCH_LAUNCH_MODE ?? 'normal').toLowerCase()

const NAME = process.env.HATCH_NAME ?? 'stacc on ketamine by mistake'
const SYMBOL = process.env.HATCH_SYMBOL ?? 'KMINE'
const URI =
  process.env.HATCH_URI ??
  'https://stacsol.app/launches/stacc-on-ketamine/metadata.json'

const REQUIRED_SOL = 0.3 // Hatch quoted ~0.243–0.249 SOL all-in; 0.3 leaves buffer.

function loadOrCreateKeypair(path: string): Keypair {
  if (existsSync(path)) {
    const arr = JSON.parse(readFileSync(path, 'utf-8')) as number[]
    return Keypair.fromSecretKey(Uint8Array.from(arr))
  }
  const kp = Keypair.generate()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 })
  console.log(`generated fresh keypair → ${path}`)
  return kp
}

async function waitForBalance(connection: Connection, kp: Keypair) {
  while (true) {
    const lamports = await connection.getBalance(kp.publicKey, 'confirmed')
    const sol = lamports / LAMPORTS_PER_SOL
    if (sol >= REQUIRED_SOL) {
      console.log(`✓ balance: ${sol.toFixed(4)} SOL — proceeding`)
      return
    }
    process.stdout.write(
      `\rwaiting for funding · current ${sol.toFixed(4)} SOL · need ≥ ${REQUIRED_SOL} SOL `,
    )
    await new Promise((r) => setTimeout(r, 5_000))
  }
}

async function checkMetadata(uri: string) {
  const r = await fetch(uri)
  if (!r.ok) {
    throw new Error(`metadata uri unreachable: ${r.status} ${r.statusText}`)
  }
  const ct = r.headers.get('content-type') ?? ''
  if (!ct.includes('json')) {
    throw new Error(`metadata uri is not JSON (content-type: ${ct})`)
  }
  const j = (await r.json()) as { name?: string; symbol?: string; image?: string }
  if (!j.name || !j.symbol || !j.image) {
    throw new Error('metadata JSON missing name/symbol/image')
  }
  // verify image too
  const ir = await fetch(j.image, { method: 'HEAD' })
  if (!ir.ok) {
    throw new Error(`metadata image unreachable: ${ir.status}`)
  }
  console.log(`✓ metadata ok: ${j.name} (${j.symbol})`)
}

async function main() {
  console.log('hatch · stacc on ketamine by mistake — launch script')
  console.log('═'.repeat(60))

  const connection = new Connection(RPC_URL!, 'confirmed')
  const signer = loadOrCreateKeypair(KEYPAIR_PATH)

  console.log(`signer: ${signer.publicKey.toBase58()}`)
  console.log(`launch mode: ${LAUNCH_MODE}`)
  console.log(`fee rate: ${FEE_RATE}%`)
  console.log(`name: ${NAME}`)
  console.log(`symbol: ${SYMBOL}`)
  console.log(`uri: ${URI}`)
  console.log()

  console.log('verifying metadata is publicly reachable…')
  await checkMetadata(URI)
  console.log()

  console.log(`required balance: ${REQUIRED_SOL} SOL`)
  console.log(`fund: ${signer.publicKey.toBase58()}`)
  await waitForBalance(connection, signer)
  console.log()

  // Dynamic import — hatch-sdk is a github dep that ships TS source.
  console.log('loading hatch-sdk…')
  const sdk = await import('hatch-sdk')
  const { HatchClient } = sdk
  // CTO mode constant is only exposed when needed.
  const launchMode =
    LAUNCH_MODE === 'cto' && (sdk as { LAUNCH_MODE_CTO?: unknown }).LAUNCH_MODE_CTO
      ? (sdk as { LAUNCH_MODE_CTO: unknown }).LAUNCH_MODE_CTO
      : undefined

  const hatch = new HatchClient({ connection, signer })

  console.log('launching…')
  const result = await hatch.launch({
    name: NAME,
    symbol: SYMBOL,
    uri: URI,
    feeRate: FEE_RATE,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...(launchMode ? { launchMode: launchMode as any } : {}),
  })

  console.log()
  console.log('🐣 LAUNCHED')
  console.log('═'.repeat(60))
  console.log(`mint:     ${result.mint.toBase58()}`)
  console.log(`pool:     ${result.lbPair.toBase58()}`)
  console.log(`position: ${result.position.toBase58()}`)
  if (result.setupSignature) {
    console.log(`setup tx: https://solscan.io/tx/${result.setupSignature}`)
  }
  if (result.ctoSetupSignature) {
    console.log(`cto tx:   https://solscan.io/tx/${result.ctoSetupSignature}`)
  }
  console.log(`launch:   https://solscan.io/tx/${result.signature}`)
  console.log()
  console.log(`hatch:    https://hatchfun.xyz/token/${result.mint.toBase58()}`)
  console.log(`solscan:  https://solscan.io/token/${result.mint.toBase58()}`)
  console.log()
  console.log('save the mint address — claim fees later with `pnpm tsx scripts/hatch-claim.ts`')
}

main().catch((e: unknown) => {
  console.error()
  console.error('launch failed:', e)
  process.exit(1)
})
