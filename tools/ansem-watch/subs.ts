// Access billing for the carnage terminal. Two models, both upfront-funded:
//
//   Flat passes  — Day 1 SOL / 24h, Month 18 SOL / 30d (unlimited while active)
//   Pay-as-you-go — deposit any SOL, burns at 0.05 SOL/hr ONLY while your tab is
//                   open. The relay meters real elapsed time between visibility-
//                   gated heartbeats (close the tab → the meter stops). You only
//                   pay for the minutes you actually watch.
//
// On-chain part = a single SOL transfer to the merchant, verified here. No hot
// merchant key: the server only needs the receive address.

import { Database } from "bun:sqlite";
import {
  address,
  createSolanaRpc,
  createNoopSigner,
  pipe,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransaction,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

const RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const rpc = createSolanaRpc(RPC_URL);
const MERCHANT = process.env.SUB_MERCHANT_ADDRESS || "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb";

const LAMPORTS = 1_000_000_000n;
// pay-as-you-go burn rate
const RATE_PER_HOUR = BigInt(process.env.SUB_RATE_LAMPORTS_PER_HOUR || "50000000"); // 0.05 SOL/hr
const RATE_PER_SEC = Number(RATE_PER_HOUR) / 3600;
const METER_GAP_CAP = 30; // max seconds credited per heartbeat (guards against gaps)

// flat passes: fixed price -> access window
const TIERS: Record<string, { label: string; lamports: bigint; seconds: number }> = {
  day: { label: "Day pass", lamports: 1n * LAMPORTS, seconds: 24 * 3600 },
  month: { label: "Month pass", lamports: 18n * LAMPORTS, seconds: 30 * 24 * 3600 },
};
// pay-as-you-go deposit presets
const PAYG = { min: 100_000_000n, presets: [100_000_000n, 250_000_000n, 1_000_000_000n] }; // 0.1 / 0.25 / 1 SOL

const db = new Database(
  `${process.env.DATA_DIR || new URL(".", import.meta.url).pathname}/subs.db`,
);
db.exec(`
  CREATE TABLE IF NOT EXISTS passes (
    wallet TEXT PRIMARY KEY, expires INTEGER, tier TEXT, last_sig TEXT, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS credits (
    wallet TEXT PRIMARY KEY, balance INTEGER, last_meter INTEGER, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS used_sigs (sig TEXT PRIMARY KEY, wallet TEXT, ts INTEGER);
`);

export function subsInfo() {
  return {
    enabled: true,
    merchant: MERCHANT,
    tiers: Object.entries(TIERS).map(([id, t]) => ({ id, label: t.label, sol: Number(t.lamports) / 1e9, hours: t.seconds / 3600 })),
    payg: {
      rateSolPerHour: Number(RATE_PER_HOUR) / 1e9,
      minSol: Number(PAYG.min) / 1e9,
      presetsSol: PAYG.presets.map((p) => Number(p) / 1e9),
    },
  };
}

function creditBalance(wallet: string): number {
  const row = db.query("SELECT balance FROM credits WHERE wallet = ?").get(wallet) as any;
  return row ? row.balance : 0;
}

export function passStatus(wallet: string) {
  const now = Math.floor(Date.now() / 1000);
  const pass = db.query("SELECT * FROM passes WHERE wallet = ?").get(wallet) as any;
  const passActive = !!pass && pass.expires > now;
  const bal = creditBalance(wallet);
  const creditActive = bal > 0;
  const secondsLeft = passActive
    ? pass.expires - now
    : creditActive
      ? Math.floor(bal / RATE_PER_SEC)
      : 0;
  return {
    enabled: true,
    subscribed: passActive || creditActive,
    mode: passActive ? "pass" : creditActive ? "credit" : null,
    tier: passActive ? pass.tier : null,
    balanceSol: bal / 1e9,
    secondsLeft,
    expires: passActive ? pass.expires : 0,
  };
}

/** build an unsigned SOL transfer to the merchant, for a flat tier or a payg deposit */
export async function buildPayTx(wallet: string, kind: string, lamports?: number | string) {
  let amount: bigint;
  if (kind === "day" || kind === "month") {
    amount = TIERS[kind].lamports;
  } else if (kind === "payg") {
    amount = BigInt(lamports ?? PAYG.presets[0]);
    if (amount < PAYG.min) throw new Error(`minimum deposit is ${Number(PAYG.min) / 1e9} SOL`);
  } else {
    throw new Error("unknown kind");
  }
  const payer = address(wallet);
  const noop = createNoopSigner(payer);
  const ix = getTransferSolInstruction({ source: noop, destination: address(MERCHANT), amount });
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return { tx: getBase64EncodedWireTransaction(compileTransaction(msg)), lamports: amount.toString() };
}

/** verify a payment on-chain, then apply it (grant window or add credit) */
export async function confirmPay(wallet: string, kind: string, signature: string) {
  if (!signature) throw new Error("no signature");
  if (db.query("SELECT 1 FROM used_sigs WHERE sig = ?").get(signature)) {
    return { ...passStatus(wallet), reused: true };
  }

  // quick lookup (a few tries, well under the proxy timeout); if not confirmed
  // yet return a soft pending so the client keeps polling instead of erroring
  let tx: any = null;
  for (let i = 0; i < 4; i++) {
    tx = await rpc
      .getTransaction(signature as any, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" })
      .send()
      .catch(() => null);
    if (tx) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!tx) return { ...passStatus(wallet), pending: true } as any;
  if (tx.meta?.err) throw new Error("payment transaction failed on-chain");

  const keys: string[] = tx.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const mi = keys.indexOf(MERCHANT);
  const delta = mi >= 0 ? BigInt(tx.meta.postBalances[mi]) - BigInt(tx.meta.preBalances[mi]) : 0n;
  if (delta <= 0n) {
    if (wallet === MERCHANT) throw new Error("that's the merchant wallet — pay from a different wallet");
    throw new Error("no payment to the merchant found in that transaction");
  }

  const now = Math.floor(Date.now() / 1000);
  db.run("INSERT INTO used_sigs VALUES (?, ?, ?)", [signature, wallet, now]);

  if (kind === "day" || kind === "month") {
    const t = TIERS[kind];
    if (delta < (t.lamports * 99n) / 100n) throw new Error(`underpaid for ${kind}`);
    const existing = db.query("SELECT expires FROM passes WHERE wallet = ?").get(wallet) as any;
    const base = existing && existing.expires > now ? existing.expires : now;
    db.run(
      "INSERT INTO passes VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET expires=excluded.expires, tier=excluded.tier, last_sig=excluded.last_sig, updated=excluded.updated",
      [wallet, base + t.seconds, kind, signature, now],
    );
  } else {
    // payg: credit exactly what landed; start the meter clock fresh
    const added = Number(delta);
    const row = db.query("SELECT balance FROM credits WHERE wallet = ?").get(wallet) as any;
    const balance = (row ? row.balance : 0) + added;
    db.run(
      "INSERT INTO credits VALUES (?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET balance=excluded.balance, last_meter=excluded.last_meter, updated=excluded.updated",
      [wallet, balance, now, now],
    );
  }
  return passStatus(wallet);
}

/**
 * meter heartbeat — burns real elapsed time since the last ping (capped), but
 * only if the wallet is on the pay-as-you-go credit model. Flat-pass holders
 * are untouched. Called every ~10s from the client while the tab is visible.
 */
export function meter(wallet: string) {
  const now = Math.floor(Date.now() / 1000);
  const pass = db.query("SELECT expires FROM passes WHERE wallet = ?").get(wallet) as any;
  if (pass && pass.expires > now) return passStatus(wallet); // flat pass: no burn

  const row = db.query("SELECT balance, last_meter FROM credits WHERE wallet = ?").get(wallet) as any;
  if (!row || row.balance <= 0) return passStatus(wallet);

  const elapsed = row.last_meter ? Math.min(now - row.last_meter, METER_GAP_CAP) : 0;
  const burn = Math.floor(elapsed * RATE_PER_SEC);
  const balance = Math.max(0, row.balance - burn);
  db.run("UPDATE credits SET balance = ?, last_meter = ?, updated = ? WHERE wallet = ?", [balance, now, now, wallet]);
  return passStatus(wallet);
}
