/**
 * Init Meteora DLMM pools for stacSOL × {WSOL, USDC, Staccana, FOMOX402, PROOFV3}.
 *
 * Run dry-run (no broadcast):
 *   bun run scripts/init-meteora-pools.ts
 *
 * Run for real:
 *   bun run scripts/init-meteora-pools.ts --execute
 *
 * Reads:
 *   - RPC_URL from env (or falls back to mainnet-beta)
 *   - JUPITER_API_KEY from env (used to quote initial pair price)
 *   - ~/triton/keys/manager.json — creator keypair
 *
 * Writes (after successful execution):
 *   - scripts/meteora-pools.json — manifest of pool addresses
 */

import {
  Connection,
  Keypair,
  PublicKey,
  type Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

/**
 * Send a tx and poll signature status over HTTP. We bypass
 * sendAndConfirmTransaction because Helius's free-tier WSS rejects
 * subscriptions (Expected 101 status code) and the default confirm path hangs
 * on retrying the websocket forever.
 */
async function sendAndConfirmHttp(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  timeoutMs = 90_000,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash('finalized')
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)
  const raw = tx.serialize()
  const sig = await connection.sendRawTransaction(raw, {
    skipPreflight: false,
    maxRetries: 0,
  })
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const status = await connection.getSignatureStatus(sig, {
      searchTransactionHistory: false,
    })
    const v = status.value
    if (v) {
      if (v.err) {
        throw new Error(`tx failed: ${JSON.stringify(v.err)} (sig ${sig})`)
      }
      const cs = v.confirmationStatus
      if (cs === 'confirmed' || cs === 'finalized') return sig
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`confirm timeout: ${sig}`)
}
import DLMM, {
  ActivationType,
  deriveCustomizablePermissionlessLbPair,
  LBCLMM_PROGRAM_IDS,
} from '@meteora-ag/dlmm'
import BN from 'bn.js'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const STACSOL = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')
const STACSOL_DECIMALS = 9

interface Target {
  name: string
  mint: string
  decimals: number
  binStep: number // basis points (e.g. 100 = 1.00%)
  feeBps: number // trading fee in basis points
}

const TARGETS: Target[] = [
  // bin step + fee tuned per pair: tighter for stable-ish, wider for memecoins
  { name: 'WSOL', mint: 'So11111111111111111111111111111111111111112', decimals: 9, binStep: 25, feeBps: 100 },
  { name: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, binStep: 100, feeBps: 200 },
  { name: 'Staccana', mint: '73edX6xoGY4v5y2hzuKdrUbJXLntqgmo74au1Ki1pump', decimals: 6, binStep: 200, feeBps: 500 },
  { name: 'FOMOX402', mint: 'GezJEsABGEmZVoXsDKHCCwYvxGPhQFk4hd91MchYQZaM', decimals: 9, binStep: 200, feeBps: 500 },
  { name: 'PROOFV3', mint: 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av', decimals: 6, binStep: 200, feeBps: 500 },
]

interface PoolManifestEntry {
  name: string
  mint: string
  decimals: number
  poolAddress: string
  tokenX: string
  tokenY: string
  binStep: number
  feeBps: number
  activeId: number
  initialPriceYPerX: number
  txSig?: string
  alreadyExisted?: boolean
}

const MANIFEST_PATH = path.join(__dirname, 'meteora-pools.json')

async function jupiterPrice(args: {
  inputMint: string
  outputMint: string
  amount: bigint
  apiKey: string
}): Promise<number> {
  const url = new URL('https://api.jup.ag/swap/v1/quote')
  url.searchParams.set('inputMint', args.inputMint)
  url.searchParams.set('outputMint', args.outputMint)
  url.searchParams.set('amount', args.amount.toString())
  url.searchParams.set('slippageBps', '1000')
  url.searchParams.set('swapMode', 'ExactIn')
  const r = await fetch(url.toString(), {
    headers: { 'x-api-key': args.apiKey },
  })
  if (!r.ok) {
    throw new Error(`jupiter ${r.status}: ${await r.text()}`)
  }
  const j = (await r.json()) as { outAmount?: string; errorCode?: string; error?: string }
  if (j.errorCode || j.error) {
    throw new Error(`jupiter: ${j.error || j.errorCode}`)
  }
  if (!j.outAmount) throw new Error('no outAmount')
  return Number(j.outAmount)
}

/**
 * Meteora's bin price is `(1 + binStep / BASIS_POINT_MAX) ^ binId`, where
 * BASIS_POINT_MAX = 10000. Returns the binId whose theoretical price is
 * closest to the supplied target price (in raw units, i.e. priceY/priceX
 * with both expressed in atomic units).
 */
function priceToActiveId(targetRawPrice: number, binStep: number): number {
  const base = 1 + binStep / 10000
  // log_base(target) = ln(target) / ln(base)
  return Math.round(Math.log(targetRawPrice) / Math.log(base))
}

async function poolExists(
  connection: Connection,
  tokenX: PublicKey,
  tokenY: PublicKey,
): Promise<PublicKey | null> {
  const programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta'])
  const [poolPda] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, programId)
  const acc = await connection.getAccountInfo(poolPda)
  return acc ? poolPda : null
}

async function main() {
  const execute = process.argv.includes('--execute')
  const rpc = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
  const jupKey = process.env.JUPITER_API_KEY
  if (!jupKey) {
    console.error('JUPITER_API_KEY not set — needed to quote initial pair prices')
    process.exit(1)
  }

  const keypath = path.join(os.homedir(), 'triton', 'keys', 'manager.json')
  if (!fs.existsSync(keypath)) {
    console.error(`creator keypair not found at ${keypath}`)
    process.exit(1)
  }
  const keypair = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypath, 'utf-8'))),
  )

  const connection = new Connection(rpc, 'confirmed')
  console.log(`mode: ${execute ? 'EXECUTE' : 'DRY-RUN'}`)
  console.log(`rpc: ${rpc}`)
  console.log(`creator: ${keypair.publicKey.toBase58()}`)
  const balance = await connection.getBalance(keypair.publicKey)
  console.log(`balance: ${(balance / 1e9).toFixed(4)} SOL`)

  const manifest: PoolManifestEntry[] = []

  for (const t of TARGETS) {
    console.log(`\n=== ${t.name} (${t.mint}) ===`)
    try {
      const targetMint = new PublicKey(t.mint)

      // Meteora convention: lexicographic order of mints. tokenX < tokenY.
      const stacFirst = Buffer.compare(STACSOL.toBuffer(), targetMint.toBuffer()) < 0
      const tokenX = stacFirst ? STACSOL : targetMint
      const tokenY = stacFirst ? targetMint : STACSOL
      const decX = stacFirst ? STACSOL_DECIMALS : t.decimals
      const decY = stacFirst ? t.decimals : STACSOL_DECIMALS

      // Quote 1 unit of tokenX → tokenY via Jupiter, in atomic units.
      const oneXAtomic = BigInt(10 ** decX)
      let outAtomic: number
      try {
        outAtomic = await jupiterPrice({
          inputMint: tokenX.toBase58(),
          outputMint: tokenY.toBase58(),
          amount: oneXAtomic,
          apiKey: jupKey,
        })
      } catch (e) {
        console.warn(
          `  jupiter quote failed (${(e as Error).message}); using fallback price 1.0`,
        )
        outAtomic = 10 ** decY
      }
      // Raw price = (Y atomic out) / (X atomic in), already in atomic terms.
      const rawPrice = outAtomic / Number(oneXAtomic)
      const uiPrice = (outAtomic / 10 ** decY) / 1 // 1 X-ui → uiPrice Y-ui
      console.log(`  1 X (${stacFirst ? 'stacSOL' : t.name}) → ${uiPrice.toFixed(6)} Y (${stacFirst ? t.name : 'stacSOL'})`)

      const activeId = priceToActiveId(rawPrice, t.binStep)
      console.log(`  binStep=${t.binStep} feeBps=${t.feeBps} activeId=${activeId}`)
      console.log(`  X=${tokenX.toBase58()}`)
      console.log(`  Y=${tokenY.toBase58()}`)

      // Already exists?
      const existing = await poolExists(connection, tokenX, tokenY)
      if (existing) {
        console.log(`  ✓ pool already exists at ${existing.toBase58()} (skipping)`)
        manifest.push({
          name: t.name,
          mint: t.mint,
          decimals: t.decimals,
          poolAddress: existing.toBase58(),
          tokenX: tokenX.toBase58(),
          tokenY: tokenY.toBase58(),
          binStep: t.binStep,
          feeBps: t.feeBps,
          activeId,
          initialPriceYPerX: uiPrice,
          alreadyExisted: true,
        })
        continue
      }

      // Build the create-pair tx.
      const tx = await DLMM.createCustomizablePermissionlessLbPair2(
        connection,
        new BN(t.binStep),
        tokenX,
        tokenY,
        new BN(activeId),
        new BN(t.feeBps),
        ActivationType.Timestamp,
        false,
        keypair.publicKey,
      )
      console.log(`  built tx (${tx.instructions.length} ix)`)

      const programId = new PublicKey(LBCLMM_PROGRAM_IDS['mainnet-beta'])
      const [poolPda] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, programId)

      if (!execute) {
        console.log(`  [dry-run] would create pool at ${poolPda.toBase58()}`)
        manifest.push({
          name: t.name,
          mint: t.mint,
          decimals: t.decimals,
          poolAddress: poolPda.toBase58(),
          tokenX: tokenX.toBase58(),
          tokenY: tokenY.toBase58(),
          binStep: t.binStep,
          feeBps: t.feeBps,
          activeId,
          initialPriceYPerX: uiPrice,
        })
        continue
      }

      // Send via HTTP polling — Helius WSS rejects subscriptions on this plan.
      const sig = await sendAndConfirmHttp(connection, tx, [keypair])
      console.log(`  ✓ created pool ${poolPda.toBase58()}`)
      console.log(`  sig: ${sig}`)
      manifest.push({
        name: t.name,
        mint: t.mint,
        decimals: t.decimals,
        poolAddress: poolPda.toBase58(),
        tokenX: tokenX.toBase58(),
        tokenY: tokenY.toBase58(),
        binStep: t.binStep,
        feeBps: t.feeBps,
        activeId,
        initialPriceYPerX: uiPrice,
        txSig: sig,
      })
    } catch (e) {
      console.error(`  ✗ failed: ${(e as Error).message}`)
    }
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  console.log(`\nmanifest written to ${MANIFEST_PATH}`)
  console.log(`pools: ${manifest.length}`)

  // Suppress unused import warning
  void TransactionMessage
  void VersionedTransaction
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
