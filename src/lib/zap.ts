// Helpers for one-click "zap" liquidity flows on top of Helius Sender:
//   • Jupiter exactIn/exactOut swaps (returned as unsigned VersionedTransactions
//     so the wallet adapter can sign them in a single signAllTransactions call)
//   • Helius Sender submission for any standalone tx that wants priority
//     inclusion (https://www.helius.dev/docs/sender)
//   • HTTP-poll-based confirmation (no WebSocket subscriptions, ever)
//
// Every tx submitted through Helius Sender MUST include a transfer ix to one
// of Helius's tip accounts (minimum 0.0002 SOL); the dual-routed sender
// rejects bundles that don't write-lock a tip account. We use 0.001 SOL by
// default — 5× the minimum, generous enough to land during congestion while
// staying meaningfully cheaper than Jito's 0.01 SOL bundle tips.

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { fetchPool } from './pool'
import { ixCreateAtaIdempotent, ixDepositSol, ixWithdrawSol } from './ix'
import { MINT } from './constants'

// -----------------------------------------------------------------------------
// Helius Sender
// -----------------------------------------------------------------------------

// Single global endpoint (Helius routes to nearest leader internally). For
// strictly minimum-latency setups they expose regional endpoints
// (frankfurt/tokyo/ny/etc.) too, but the global endpoint is fine for the
// browser-side latencies we deal with.
export const HELIUS_SENDER_URL = 'https://sender.helius-rpc.com/fast'

// Helius's tip accounts — distinct list from Jito's. Picking an account that
// isn't on this list causes the Sender to reject with "must include tip
// transfer to a Helius tip account".
const HELIUS_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]

/** 0.001 SOL — 5× Helius's 0.0002 minimum. Enough to land during congestion;
 *  still ~10× cheaper than the previous 0.01 SOL Jito bundle tip. */
export const HELIUS_SENDER_TIP_LAMPORTS = 1_000_000

export function pickHeliusTipAccount(): PublicKey {
  return new PublicKey(
    HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)],
  )
}

/** Build a tip TransactionInstruction targeting a randomly-picked Helius tip
 *  account. Inline this into any tx you intend to submit via Helius Sender. */
export function heliusTipIx(
  owner: PublicKey,
  lamports: number = HELIUS_SENDER_TIP_LAMPORTS,
): TransactionInstruction {
  return SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: pickHeliusTipAccount(),
    lamports,
  })
}

/**
 * Append an instruction (typically a Helius tip transfer) to an existing v0
 * VersionedTransaction. Used to retrofit a tip onto a tx we don't fully
 * control (e.g. one Jupiter built for us). Resolves any address-lookup tables
 * referenced by the tx so we can decompile, append, and recompile.
 *
 * The resulting tx has new signatures requirements identical to the input
 * (same fee payer, same signers); existing signatures are NOT preserved —
 * caller must re-sign.
 */
export async function appendIxToV0Tx(
  connection: Connection,
  tx: VersionedTransaction,
  ix: TransactionInstruction,
): Promise<VersionedTransaction> {
  // Resolve any ALTs the tx references — TransactionMessage.decompile needs
  // them to expand the lookup-table account indices into real PublicKeys.
  const altKeys = tx.message.addressTableLookups.map((l) => l.accountKey)
  const altAccounts: AddressLookupTableAccount[] = []
  for (const key of altKeys) {
    const r = await connection.getAddressLookupTable(key)
    if (r.value) altAccounts.push(r.value)
  }

  const decompiled = TransactionMessage.decompile(tx.message, {
    addressLookupTableAccounts: altAccounts,
  })
  decompiled.instructions.push(ix)

  // Recompile with the SAME ALTs so the resulting tx stays as compact as
  // before (otherwise the appended ix could push it over the 1232-byte limit
  // when the originals were leaning on ALTs hard).
  const newMsg = decompiled.compileToV0Message(altAccounts)
  return new VersionedTransaction(newMsg)
}

/**
 * Submit a single signed transaction through Helius Sender for fast inclusion.
 * Accepts either a legacy or v0 transaction. The tx MUST include a transfer
 * to a Helius tip account or the Sender rejects with a "no tip" error.
 *
 * Returns the on-chain signature. Caller is responsible for confirmation
 * polling — Helius requires `maxRetries: 0` so retries are caller-side.
 */
export async function sendViaHeliusSender(
  signedTx: VersionedTransaction | { serialize(): Uint8Array | Buffer },
): Promise<string> {
  const bytesRaw = signedTx.serialize()
  const bytes =
    bytesRaw instanceof Uint8Array
      ? bytesRaw
      : new Uint8Array(bytesRaw as ArrayLike<number>)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  const encoded = btoa(bin)

  const r = await fetch(HELIUS_SENDER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: '1',
      method: 'sendTransaction',
      params: [
        encoded,
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`helius sender ${r.status}: ${txt.slice(0, 300)}`)
  }
  const j = (await r.json()) as {
    result?: string
    error?: { message?: string }
  }
  if (j.error) throw new Error(`helius sender: ${j.error.message ?? 'error'}`)
  if (!j.result) throw new Error('helius sender: no signature')
  return j.result
}

// -----------------------------------------------------------------------------
// Jupiter
// -----------------------------------------------------------------------------

// Jupiter calls go through our /api/jup-* proxy so the JUPITER_API_KEY stays
// server-side. The proxy forwards to api.jup.ag (paid tier) which routes
// through deeper paths than lite-api.jup.ag — important for thin pairs like
// stacSOL/* where the free tier returns "no routes found" on multi-hop swaps.
const JUP_QUOTE_PATH = '/api/jup-quote'
const JUP_SWAP_PATH = '/api/jup-swap'
const WSOL = 'So11111111111111111111111111111111111111112'

export interface JupQuote {
  inputMint: string
  inAmount: string
  outputMint: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: 'ExactIn' | 'ExactOut'
  slippageBps: number
  priceImpactPct?: string
  routePlan?: unknown[]
}

export async function jupiterQuote(args: {
  inputMint: string
  outputMint: string
  amount: bigint
  swapMode: 'ExactIn' | 'ExactOut'
  slippageBps: number
}): Promise<JupQuote> {
  const url =
    `${JUP_QUOTE_PATH}?` +
    new URLSearchParams({
      inputMint: args.inputMint,
      outputMint: args.outputMint,
      amount: args.amount.toString(),
      swapMode: args.swapMode,
      slippageBps: args.slippageBps.toString(),
    }).toString()
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`jupiter quote ${r.status}: ${txt.slice(0, 200)}`)
  }
  const j = await r.json()
  if (j.errorCode || j.error) {
    throw new Error(
      `jupiter: ${j.error || j.errorCode} (${args.inputMint.slice(0, 6)} → ${args.outputMint.slice(0, 6)})`,
    )
  }
  if (!j.outAmount && !j.inAmount) {
    throw new Error(`jupiter quote: no route (${args.inputMint} → ${args.outputMint})`)
  }
  return j as JupQuote
}

/**
 * Build an unsigned VersionedTransaction for a Jupiter swap. Caller is
 * responsible for signing.
 *
 * `prioritizationFeeLamports` accepts:
 *   - `number` — flat priority fee in microlamports
 *   - `'auto'` — Jupiter picks based on network conditions (default)
 *
 * To make the resulting tx Helius-Sender-eligible, append a Helius tip ix
 * via `appendIxToV0Tx(connection, swapTx, heliusTipIx(owner))` before
 * signing.
 */
export async function getJupiterSwapTx(args: {
  quote: JupQuote
  userPublicKey: PublicKey
  prioritizationFeeLamports?: number | 'auto'
}): Promise<VersionedTransaction> {
  const r = await fetch(JUP_SWAP_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: args.quote,
      userPublicKey: args.userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      asLegacyTransaction: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: args.prioritizationFeeLamports ?? 'auto',
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`jupiter swap ${r.status}: ${txt.slice(0, 200)}`)
  }
  const j = (await r.json()) as { swapTransaction?: string }
  if (!j.swapTransaction) throw new Error('jupiter swap: no swapTransaction')
  const buf = Uint8Array.from(atob(j.swapTransaction), (c) => c.charCodeAt(0))
  return VersionedTransaction.deserialize(buf)
}

// -----------------------------------------------------------------------------
// stacSOL stake-pool helpers
// -----------------------------------------------------------------------------

/**
 * Build a v0 transaction that mints stacSOL by depositing `lamports` SOL into
 * the Sanctum stake pool. Used as a Jupiter-swap replacement when the topup
 * target is stacSOL — Jupiter's SOL → stacSOL route goes through the Sanctum
 * router and includes accounts that Jito flags as vote-account-adjacent
 * (irrelevant for Helius Sender, but the SDK route still has the 6.9%
 * Token-2022 transfer-fee gotcha that this avoids).
 *
 * MintTo (which DepositSol uses internally) doesn't trigger TransferFee —
 * only Transfer ixs do.
 */
export async function buildStacsolMintTx(
  connection: Connection,
  owner: PublicKey,
  lamports: bigint,
  /** Optional referrer pubkey. When set, derives + idempotently creates
   *  the referrer's stacSOL ATA and routes the pool's `sol_referral_fee`
   *  share (50% of 6.9% = ~3.45% of deposit) into it. When omitted, the
   *  referral slot defaults to the depositor's own ATA (self-rebate). */
  referrer?: PublicKey,
): Promise<VersionedTransaction> {
  const pool = await fetchPool(connection)
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ixCreateAtaIdempotent(owner, owner, MINT),
  ]
  let referrerAta: PublicKey | undefined
  if (referrer && !referrer.equals(owner)) {
    const { deriveReferrerAtaAndCreateIx } = await import('./referrer')
    const r = deriveReferrerAtaAndCreateIx({ payer: owner, referrer })
    referrerAta = r.referrerAta
    ixs.push(r.createIx)
  }
  ixs.push(ixDepositSol(owner, lamports, pool, referrerAta))
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

/**
 * Build a v0 transaction that burns stacSOL via WithdrawSol on the Sanctum
 * stake pool. Used as a Jupiter-swap replacement when converting stacSOL → SOL
 * after an LP withdraw — the native WithdrawSol path also avoids the 6.9%
 * Token-2022 transfer fee that Jupiter's swap incurs.
 */
export async function buildStacsolBurnTx(
  connection: Connection,
  owner: PublicKey,
  tokens: bigint,
): Promise<VersionedTransaction> {
  const pool = await fetchPool(connection)
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ixWithdrawSol(owner, tokens, pool),
  ]
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

/**
 * Compute the SOL lamports needed as input to DepositSol so that the user
 * receives at least `desiredStacsolAtomic` stacSOL after the 6.9% deposit
 * fee. Includes a small buffer to absorb rate drift between build and execute.
 *
 * rate = pool.totalLamports / pool.poolTokenSupply (SOL lamports per stacSOL atom)
 * desired_post_fee = lamports_in / rate × 0.931
 * → lamports_in = desired_post_fee × rate / 0.931
 */
export function lamportsForStacsolMint(
  desiredStacsolAtomic: bigint,
  poolTotalLamports: bigint,
  poolTokenSupplyAccounting: bigint,
  bufferBps: number = 200, // 2% drift cushion
): bigint {
  if (poolTokenSupplyAccounting === 0n) return desiredStacsolAtomic
  const POST_FEE_NUM = 931n
  const POST_FEE_DEN = 1000n
  const buffNum = BigInt(10000 + bufferBps)
  const buffDen = 10000n
  return (
    (desiredStacsolAtomic *
      poolTotalLamports *
      POST_FEE_DEN *
      buffNum) /
    (poolTokenSupplyAccounting * POST_FEE_NUM * buffDen)
  )
}

// -----------------------------------------------------------------------------
// Confirmation polling (HTTP only — never connection.confirmTransaction)
// -----------------------------------------------------------------------------

/**
 * Fetch the on-chain logs for a confirmed tx and pull out the most relevant
 * line — typically Anchor's "AnchorError caused by account: X. Error Code: Y"
 * which tells you exactly what failed and on which account. Returns null if
 * the tx isn't fetchable yet (race) or has no logs.
 */
export async function fetchTxErrorDetail(
  connection: Connection,
  signature: string,
): Promise<string | null> {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'confirmed',
    })
    const logs = tx?.meta?.logMessages
    if (!logs || logs.length === 0) return null

    // Look for the Anchor "caused by account" line — most useful for
    // AccountNotInitialized (3012), AccountOwnedByWrongProgram (3007), etc.
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i]
      if (
        /AnchorError|caused by account|Error Code|ConstraintRaw|InvalidAccountData|insufficient/i.test(
          line,
        )
      ) {
        return line.trim().slice(0, 300)
      }
    }
    // Fallback to last "Program log:" line.
    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].startsWith('Program log:')) {
        return logs[i].trim().slice(0, 300)
      }
    }
    return logs[logs.length - 1]?.trim().slice(0, 300) ?? null
  } catch {
    return null
  }
}

/**
 * Build a "tx X failed on chain" error message, augmented with the on-chain
 * Anchor error log line when available. Errors enriched this way go from
 * "Custom 3012, good luck" to "Custom 3012 — AnchorError caused by account
 * userTokenY. Error Code: AccountNotInitialized" which is actually
 * actionable.
 */
async function buildOnChainErrorMessage(
  connection: Connection,
  signature: string,
  rawErr: unknown,
): Promise<string> {
  const errStr =
    typeof rawErr === 'string' ? rawErr : JSON.stringify(rawErr)
  const detail = await fetchTxErrorDetail(connection, signature)
  if (detail) {
    return `tx ${signature.slice(0, 8)}… failed on chain: ${errStr} — ${detail}`
  }
  return `tx ${signature.slice(0, 8)}… failed on chain: ${errStr}`
}

/**
 * Poll-based signature confirmation. Replaces `connection.confirmTransaction`,
 * which uses a WebSocket subscription that frequently disconnects on managed
 * RPCs and never resolves. Polling via `getSignatureStatuses` is HTTP-only
 * and tolerates RPC flakiness — at the cost of one round-trip per poll.
 *
 * Throws with a useful message if the tx errors out, isn't found within
 * `lastValidBlockHeight`, or the deadline passes. On-chain errors are
 * enriched with the Anchor error log line via `fetchTxErrorDetail`.
 *
 * `commitment` defaults to 'confirmed'. 'finalized' adds ~12s of waiting.
 */
export async function pollConfirmTransaction(
  connection: Connection,
  signature: string,
  opts: {
    blockhash?: string
    lastValidBlockHeight?: number
    commitment?: 'processed' | 'confirmed' | 'finalized'
    timeoutMs?: number
    pollIntervalMs?: number
  } = {},
): Promise<{ slot: number; confirmationStatus: string }> {
  const commitment = opts.commitment ?? 'confirmed'
  const timeoutMs = opts.timeoutMs ?? 60_000
  const pollIntervalMs = opts.pollIntervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs

  const tier = (s: string): number =>
    s === 'finalized' ? 3 : s === 'confirmed' ? 2 : s === 'processed' ? 1 : 0
  const wantTier = tier(commitment)

  while (Date.now() < deadline) {
    try {
      const r = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
      const st = r.value[0]
      if (st) {
        if (st.err) {
          throw new Error(
            await buildOnChainErrorMessage(connection, signature, st.err),
          )
        }
        const haveTier = tier(st.confirmationStatus ?? 'processed')
        if (haveTier >= wantTier) {
          return {
            slot: st.slot,
            confirmationStatus: st.confirmationStatus ?? 'processed',
          }
        }
      }

      if (opts.lastValidBlockHeight != null) {
        const currentHeight = await connection.getBlockHeight('confirmed')
        if (currentHeight > opts.lastValidBlockHeight) {
          throw new Error(
            `tx ${signature.slice(0, 8)}… blockhash expired (current height ${currentHeight} > lastValidBlockHeight ${opts.lastValidBlockHeight}); resubmit with a fresh blockhash`,
          )
        }
      }
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (msg.startsWith('tx ')) throw e
      // Transient RPC errors: keep polling.
    }
    await new Promise((res) => setTimeout(res, pollIntervalMs))
  }
  throw new Error(
    `tx ${signature.slice(0, 8)}… not ${commitment} within ${Math.floor(timeoutMs / 1000)}s — check ${solscanTx(signature)}`,
  )
}

/**
 * Poll N signatures in parallel with one combined `getSignatureStatuses` call
 * per tick (instead of N independent polls). Resolves once all reach
 * `commitment`; throws as soon as any fails on chain.
 *
 * Use this after fan-out submissions where multiple txs land independently
 * (e.g. each DLMM chunk via its own Helius Sender call).
 */
export async function pollAllSigsConfirmed(
  connection: Connection,
  signatures: string[],
  opts: {
    commitment?: 'processed' | 'confirmed' | 'finalized'
    timeoutMs?: number
    pollIntervalMs?: number
  } = {},
): Promise<{ sig: string; slot: number; confirmationStatus: string }[]> {
  if (signatures.length === 0) return []
  const commitment = opts.commitment ?? 'confirmed'
  const timeoutMs = opts.timeoutMs ?? 90_000
  const pollIntervalMs = opts.pollIntervalMs ?? 1_500
  const deadline = Date.now() + timeoutMs

  const tier = (s: string): number =>
    s === 'finalized' ? 3 : s === 'confirmed' ? 2 : s === 'processed' ? 1 : 0
  const wantTier = tier(commitment)

  // Track confirmed sigs so we don't re-process on later ticks.
  const confirmed = new Map<
    string,
    { slot: number; confirmationStatus: string }
  >()

  while (Date.now() < deadline && confirmed.size < signatures.length) {
    try {
      const pending = signatures.filter((s) => !confirmed.has(s))
      const r = await connection.getSignatureStatuses(pending, {
        searchTransactionHistory: true,
      })
      // First pass: detect any tx that errored on chain. If so, fetch its
      // logs and throw with the enriched message — we abort the whole batch
      // because partial success here usually means re-submission is needed
      // anyway.
      for (let i = 0; i < r.value.length; i++) {
        const st = r.value[i]
        const sig = pending[i]
        if (st?.err) {
          throw new Error(await buildOnChainErrorMessage(connection, sig, st.err))
        }
      }
      // Second pass: record any that have reached the target commitment.
      r.value.forEach((st, i) => {
        const sig = pending[i]
        if (!st) return
        const haveTier = tier(st.confirmationStatus ?? 'processed')
        if (haveTier >= wantTier) {
          confirmed.set(sig, {
            slot: st.slot,
            confirmationStatus: st.confirmationStatus ?? 'processed',
          })
        }
      })
    } catch (e) {
      const msg = (e as Error).message ?? ''
      if (msg.startsWith('tx ')) throw e
      // Transient RPC error: keep polling.
    }
    if (confirmed.size < signatures.length) {
      await new Promise((res) => setTimeout(res, pollIntervalMs))
    }
  }

  if (confirmed.size < signatures.length) {
    const missing = signatures.filter((s) => !confirmed.has(s))
    throw new Error(
      `${missing.length}/${signatures.length} txs not ${commitment} within ${Math.floor(timeoutMs / 1000)}s. missing: ${missing.map((s) => s.slice(0, 8) + '…').join(', ')}`,
    )
  }

  // Preserve input order in the return.
  return signatures.map((sig) => {
    const r = confirmed.get(sig)!
    return { sig, ...r }
  })
}

// -----------------------------------------------------------------------------
// Send + confirm convenience: sign, send via Helius Sender, poll on chain
// -----------------------------------------------------------------------------

/**
 * Submit a signed tx via Helius Sender and immediately wait for on-chain
 * confirmation via HTTP polling. Returns the signature once confirmed.
 *
 * The tx MUST include a Helius tip ix (use `heliusTipIx(owner)` or
 * `appendIxToV0Tx(...)` to add one).
 */
export async function sendAndConfirmViaHeliusSender(
  connection: Connection,
  signedTx: VersionedTransaction,
  opts: {
    blockhash?: string
    lastValidBlockHeight?: number
    commitment?: 'processed' | 'confirmed' | 'finalized'
    timeoutMs?: number
  } = {},
): Promise<string> {
  const sig = await sendViaHeliusSender(signedTx)
  await pollConfirmTransaction(connection, sig, opts)
  return sig
}

// -----------------------------------------------------------------------------
// Misc utilities
// -----------------------------------------------------------------------------

export const SOL_MINT = WSOL

export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}`
}

/** Extract the fee-payer (slot 0) signature from each signed tx, base58-
 *  encoded. Used to identify on-chain inclusion of a fan-out batch. */
export function extractSignatures(signed: VersionedTransaction[]): string[] {
  const out: string[] = []
  for (const tx of signed) {
    const raw = tx.signatures?.[0]
    if (!raw || raw.length !== 64) continue
    let allZero = true
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== 0) {
        allZero = false
        break
      }
    }
    if (allZero) continue
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
    out.push(bs58encode(bytes))
  }
  return out
}

// Minimal base58 encoder so we don't pull `bs58` in just to format 64-byte
// signatures for getSignatureStatuses lookups. (The `bs58` package adds
// ~12KB to the bundle for one helper.)
function bs58encode(bytes: Uint8Array): string {
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  if (bytes.length === 0) return ''
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  const size = ((bytes.length - zeros) * 138) / 100 + 1
  const b58 = new Uint8Array(Math.floor(size))
  let length = 0
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    let j = 0
    for (let k = b58.length - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * b58[k]
      b58[k] = carry % 58
      carry = Math.floor(carry / 58)
    }
    length = j
  }
  let start = b58.length - length
  while (start < b58.length && b58[start] === 0) start++
  let out = ''
  for (let i = 0; i < zeros; i++) out += ALPHA[0]
  for (let i = start; i < b58.length; i++) out += ALPHA[b58[i]]
  return out
}
