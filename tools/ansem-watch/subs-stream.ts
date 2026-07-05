// Streaming micropayment subscription via the native Solana subscriptions
// program's RECURRING DELEGATION (De1egAF…vR44).
//
// The viewer authorizes ONCE: they wrap some SOL into their own wSOL account
// and grant the relay's puller a recurring delegation — a per-minute allowance
// that resets each 60s period. The funds NEVER leave the viewer's wallet until
// pulled; the relay pulls one micro-payment (0.05 SOL/hr ÷ 60 ≈ 0.00083 SOL)
// for each minute the tab is actually open, and the viewer can revoke anytime.
//
// Why 60s and not per-second: every pull is an on-chain transaction (~5000
// lamport fee). Per-second-per-user would be thousands of tx/hour with fees
// dwarfing the amounts. 60s is the practical micropayment floor.

import { Database } from "bun:sqlite";
import {
  address,
  createSolanaRpc,
  createKeyPairSignerFromBytes,
  createNoopSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  compileTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findRecurringDelegationPda,
  fetchMaybeRecurringDelegation,
  fetchDelegationsByDelegator,
  fetchMaybeSubscriptionAuthorityFromSeeds,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getCreateRecurringDelegationOverlayInstructionAsync,
  getTransferRecurringOverlayInstructionAsync,
} from "@solana/subscriptions";

const RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const rpc = createSolanaRpc(RPC_URL);
const WSOL = address("So11111111111111111111111111111111111111112");

const RATE_PER_HOUR = BigInt(process.env.SUB_RATE_LAMPORTS_PER_HOUR || "50000000"); // 0.05 SOL/hr
const PERIOD_S = 60n;
const AMOUNT_PER_PERIOD = RATE_PER_HOUR / 60n; // per-minute micropayment cap
const ACTIVE_WINDOW = 90; // a streamer is "watching" if seen within 90s

let puller: Awaited<ReturnType<typeof loadPuller>> = null;
let pullerAta: any = null;

async function loadPuller() {
  const raw =
    process.env.SUB_MERCHANT_KEYPAIR_JSON ||
    (await Bun.file(
      process.env.SUB_MERCHANT_KEYPAIR || `${process.env.HOME}/.config/solana/id.json`,
    ).text().catch(() => null));
  if (!raw) return null;
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw)));
}

const db = new Database(
  `${process.env.DATA_DIR || new URL(".", import.meta.url).pathname}/subs.db`,
);
db.exec(`
  CREATE TABLE IF NOT EXISTS streams (
    wallet TEXT PRIMARY KEY, nonce INTEGER, delegation_pda TEXT,
    expiry INTEGER, last_seen INTEGER, last_pull INTEGER, updated INTEGER
  );
`);

export async function initStreaming() {
  puller = await loadPuller();
  if (!puller) {
    console.log("[stream] no puller keypair — streaming disabled");
    return;
  }
  [pullerAta] = await findAssociatedTokenPda({ mint: WSOL, owner: puller.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  console.log(`[stream] recurring-delegation micropayments enabled — puller ${puller.address}, ${Number(AMOUNT_PER_PERIOD) / 1e9} SOL / ${PERIOD_S}s`);
}

export function streamEnabled() {
  return !!puller;
}

export function streamInfo() {
  return {
    enabled: !!puller,
    puller: puller?.address ?? null,
    rateSolPerHour: Number(RATE_PER_HOUR) / 1e9,
    periodSeconds: Number(PERIOD_S),
    amountPerPeriodSol: Number(AMOUNT_PER_PERIOD) / 1e9,
  };
}

/**
 * On-chain authoritative: a wallet is "streaming" iff it holds a live recurring
 * delegation to our puller — true regardless of local DB (survives redeploys,
 * confirm hiccups, cache wipes). Caches the result so the pull loop can find it.
 */
export async function streamStatus(wallet: string) {
  const now = Math.floor(Date.now() / 1000);
  if (!puller) return { enabled: false, subscribed: false, mode: null, secondsLeft: 0, expires: 0 };

  try {
    const dels: any[] = await fetchDelegationsByDelegator(rpc, address(wallet));
    let best: any = null;
    for (const d of dels) {
      if (d.kind !== "recurring") continue;
      if (String(d.data.header.delegatee) !== String(puller.address)) continue;
      if (String(d.data.mint) !== String(WSOL)) continue;
      const exp = Number(d.data.expiryTs ?? 0n);
      if (exp !== 0 && exp <= now) continue;
      if (!best || Number(d.data.expiryTs) > Number(best.data.expiryTs)) best = d;
    }
    if (best) {
      const exp = Number(best.data.expiryTs ?? 0n);
      const row = db.query("SELECT last_seen, last_pull FROM streams WHERE wallet = ?").get(wallet) as any;
      db.run(
        "INSERT INTO streams VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET delegation_pda=excluded.delegation_pda, expiry=excluded.expiry, updated=excluded.updated",
        [wallet, 0, String(best.address), exp || now + 365 * 86400, row?.last_seen ?? 0, row?.last_pull ?? 0, now],
      );
      return { enabled: true, subscribed: true, mode: "stream", secondsLeft: exp === 0 ? 999999 : exp - now, expires: exp };
    }
  } catch (e) {
    // RPC hiccup — fall back to the local cache below
  }

  const row = db.query("SELECT * FROM streams WHERE wallet = ?").get(wallet) as any;
  const active = !!row && row.expiry > now;
  return {
    enabled: !!puller,
    subscribed: active,
    mode: active ? "stream" : null,
    secondsLeft: active ? row.expiry - now : 0,
    expires: active ? row.expiry : 0,
  };
}

/** heartbeat: mark this streamer as currently watching (drives the pull loop) */
export function streamSeen(wallet: string) {
  const now = Math.floor(Date.now() / 1000);
  const row = db.query("SELECT expiry FROM streams WHERE wallet = ?").get(wallet) as any;
  if (row && row.expiry > now) {
    db.run("UPDATE streams SET last_seen = ? WHERE wallet = ?", [now, wallet]);
    return true;
  }
  return false;
}

/**
 * build the one-time authorization tx: wrap SOL into the viewer's own wSOL
 * account, init their subscription authority (if needed), and create a
 * recurring delegation letting the relay pull up to AMOUNT_PER_PERIOD each 60s
 * until expiry. The viewer signs; funds stay in their wallet.
 */
async function wireTx(subscriber: any, ixs: any[]) {
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(subscriber, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
}

/**
 * Step-aware: the subscriptions program stamps a SubscriptionAuthority's initId
 * from the slot it's created in, and the recurring delegation must reference
 * that initId — so a first-time viewer authorizes in two signatures:
 *   step "init"     — wrap SOL + create the subscription authority (once ever)
 *   step "delegate" — create the recurring delegation against the live authority
 * Returning viewers (authority already exists) get a single "delegate" tx.
 */
export async function buildStreamTx(wallet: string, hours: number) {
  if (!puller) throw new Error("streaming disabled (no puller)");
  const h = Math.max(1, Math.min(720, Math.floor(hours)));
  const subscriber = address(wallet);
  const noop = createNoopSigner(subscriber);
  const now = Math.floor(Date.now() / 1000);
  const fund = RATE_PER_HOUR * BigInt(h);
  const [userAta] = await findAssociatedTokenPda({ mint: WSOL, owner: subscriber, tokenProgram: TOKEN_PROGRAM_ADDRESS });

  const auth: any = await fetchMaybeSubscriptionAuthorityFromSeeds(rpc, { user: subscriber, tokenMint: WSOL }).catch(() => ({ exists: false }));

  if (!auth.exists) {
    // step 1: just create the authority (needs the wSOL ATA to exist).
    // Funds are wrapped in step 2 so we never double-wrap / double-charge.
    const ixs = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: noop, mint: WSOL, owner: subscriber }),
      await getInitSubscriptionAuthorityOverlayInstructionAsync({ owner: noop, tokenMint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS, userAta }),
    ];
    return { step: "init", tx: await wireTx(subscriber, ixs), hours: h };
  }

  // step 2 (or the only step for returning viewers): wrap funds + create the
  // recurring delegation. The wrap tops up the delegator's wSOL that pulls draw from.
  const nonce = now;
  const ixs = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: noop, mint: WSOL, owner: subscriber }),
    getTransferSolInstruction({ source: noop, destination: userAta, amount: fund }),
    getSyncNativeInstruction({ account: userAta }),
    await getCreateRecurringDelegationOverlayInstructionAsync({
      delegator: noop,
      delegatee: puller.address,
      tokenMint: WSOL,
      amountPerPeriod: AMOUNT_PER_PERIOD,
      periodLengthS: PERIOD_S,
      startTs: BigInt(now),
      expiryTs: BigInt(now + h * 3600),
      nonce: BigInt(nonce),
      expectedSubscriptionAuthorityInitId: auth.data.initId,
    }),
  ];
  const [delegationPda] = await findRecurringDelegationPda({
    subscriptionAuthority: auth.address, delegator: subscriber, delegatee: puller.address, nonce: BigInt(nonce),
  }).catch(() => [null]);

  return { step: "delegate", tx: await wireTx(subscriber, ixs), nonce, hours: h, delegationPda: delegationPda ?? null };
}

/**
 * Grant access once the recurring delegation actually exists on-chain — the
 * true source of truth. Returns { pending: true } (HTTP 200) while it's still
 * settling so the client polls without 422 spam; the tx signature is a hint,
 * not required. Only truly bad input throws (→ 422).
 */
export async function confirmStream(wallet: string, nonce: number, hours: number, signature: string) {
  if (!puller) throw new Error("streaming disabled");
  if (!nonce) throw new Error("missing nonce");

  const subscriber = address(wallet);
  const auth = await fetchMaybeSubscriptionAuthorityFromSeeds(rpc, { user: subscriber, tokenMint: WSOL }).catch(() => null) as any;
  if (!auth?.address) {
    return { enabled: true, subscribed: false, pending: true }; // authority not visible yet
  }
  const [pda] = await findRecurringDelegationPda({
    subscriptionAuthority: auth.address, delegator: subscriber, delegatee: puller.address, nonce: BigInt(nonce),
  }).catch(() => [null]);
  if (!pda) return { enabled: true, subscribed: false, pending: true };

  const del = await fetchMaybeRecurringDelegation(rpc, pda).catch(() => null) as any;
  if (!del?.exists) {
    // if the signature is known-failed, surface it; otherwise keep polling
    if (signature) {
      const tx: any = await rpc.getTransaction(signature as any, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" }).send().catch(() => null);
      if (tx?.meta?.err) {
        console.log(`[stream] authorization tx failed on-chain for ${wallet.slice(0, 8)}: ${JSON.stringify(tx.meta.err).slice(0, 120)}`);
        throw new Error("authorization transaction failed on-chain — check your balance and try again");
      }
    }
    return { enabled: true, subscribed: false, pending: true };
  }
  console.log(`[stream] ✅ delegation active for ${wallet.slice(0, 8)}`);
  return await streamStatus(wallet); // on-chain authoritative, also caches it
}

/** background pull loop: one micropayment per active streamer per 60s period */
export async function pullActiveStreams() {
  if (!puller) return;
  const now = Math.floor(Date.now() / 1000);
  const rows = db.query("SELECT * FROM streams WHERE expiry > ? AND last_seen > ?").all(now, now - ACTIVE_WINDOW) as any[];
  for (const row of rows) {
    if (row.last_pull && now - row.last_pull < Number(PERIOD_S)) continue; // one pull per period
    if (!row.delegation_pda) continue;
    try {
      const del = await fetchMaybeRecurringDelegation(rpc, address(row.delegation_pda));
      if (!(del as any).exists) { db.run("UPDATE streams SET expiry = ? WHERE wallet = ?", [now, row.wallet]); continue; }
      const [userAta] = await findAssociatedTokenPda({ mint: WSOL, owner: address(row.wallet), tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const ix = await getTransferRecurringOverlayInstructionAsync({
        delegatee: puller!,
        delegationPda: address(row.delegation_pda),
        delegator: address(row.wallet),
        delegatorAta: userAta,
        receiverAta: pullerAta,
        tokenMint: WSOL,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: AMOUNT_PER_PERIOD,
      });
      const ata = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: puller!, mint: WSOL, owner: puller!.address });
      const { value: latest } = await rpc.getLatestBlockhash().send();
      const msg = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayerSigner(puller!, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        (m) => appendTransactionMessageInstructions([ata, ix], m),
      );
      const signed = await signTransactionMessageWithSigners(msg);
      const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
      db.run("UPDATE streams SET last_pull = ? WHERE wallet = ?", [now, row.wallet]);
      console.log(`[stream] pulled ${Number(AMOUNT_PER_PERIOD) / 1e9} SOL from ${row.wallet.slice(0, 8)}: ${String(sig).slice(0, 12)}`);
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (/PERIOD_NOT_ELAPSED/.test(m)) { db.run("UPDATE streams SET last_pull = ? WHERE wallet = ?", [now, row.wallet]); continue; }
      // insufficient wSOL / revoked / unfunded puller — access lapses naturally at expiry
      console.log(`[stream] pull skipped for ${row.wallet.slice(0, 8)}: ${m.slice(0, 120)}`);
    }
  }
}
