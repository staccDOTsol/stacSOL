// Prepaid access passes for the carnage terminal.
// Upfront SOL transfer -> relay verifies the tx on-chain -> grants an access
// window keyed to the wallet. No delegate/pull machinery, no hot merchant key:
// the server only needs the DESTINATION address to receive and verify against.
//
//   Day pass:   1 SOL  -> 24h
//   Month pass: 18 SOL -> 30d (upfront, ~0.6/day — the discount tier)

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

// where subscription revenue lands (no private key needed on the server)
const MERCHANT = process.env.SUB_MERCHANT_ADDRESS || "WzMaL78srutrF6CsxEkWuhMaDF5HZA6jNRaEPengqpb";

const LAMPORTS = 1_000_000_000n;
const TIERS: Record<string, { label: string; sol: number; lamports: bigint; seconds: number }> = {
  day: { label: "Day pass", sol: 1, lamports: 1n * LAMPORTS, seconds: 24 * 3600 },
  month: { label: "Month pass", sol: 18, lamports: 18n * LAMPORTS, seconds: 30 * 24 * 3600 },
};

const db = new Database(
  `${process.env.DATA_DIR || new URL(".", import.meta.url).pathname}/subs.db`,
);
db.exec(`
  CREATE TABLE IF NOT EXISTS passes (
    wallet TEXT PRIMARY KEY, expires INTEGER, tier TEXT, last_sig TEXT, updated INTEGER
  );
  CREATE TABLE IF NOT EXISTS used_sigs (sig TEXT PRIMARY KEY, wallet TEXT, ts INTEGER);
`);

export function subsInfo() {
  return {
    enabled: true,
    merchant: MERCHANT,
    tiers: Object.entries(TIERS).map(([id, t]) => ({ id, label: t.label, sol: t.sol, hours: t.seconds / 3600 })),
  };
}

export function passStatus(wallet: string) {
  const row = db.query("SELECT * FROM passes WHERE wallet = ?").get(wallet) as any;
  const now = Math.floor(Date.now() / 1000);
  const active = !!row && row.expires > now;
  return {
    enabled: true,
    subscribed: active, // paywall.js reads `subscribed`
    active,
    expires: row?.expires ?? 0,
    tier: row?.tier ?? null,
    secondsLeft: active ? row.expires - now : 0,
  };
}

/** build the unsigned upfront-payment tx: transfer the tier price to the merchant */
export async function buildPassTx(wallet: string, tier: string) {
  const t = TIERS[tier];
  if (!t) throw new Error("unknown tier");
  const payer = address(wallet);
  const noop = createNoopSigner(payer);
  const ix = getTransferSolInstruction({
    source: noop, destination: address(MERCHANT), amount: t.lamports,
  });
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions([ix], m),
  );
  return { tx: getBase64EncodedWireTransaction(compileTransaction(msg)), lamports: t.lamports.toString() };
}

/** verify the signed+sent payment on-chain, then grant the access window */
export async function confirmPass(wallet: string, tier: string, signature: string) {
  const t = TIERS[tier];
  if (!t) throw new Error("unknown tier");
  if (!signature) throw new Error("no signature");

  if (db.query("SELECT 1 FROM used_sigs WHERE sig = ?").get(signature)) {
    return { ...passStatus(wallet), reused: true };
  }

  // poll until the tx is visible + confirmed
  let tx: any = null;
  for (let i = 0; i < 30; i++) {
    tx = await rpc
      .getTransaction(signature as any, { maxSupportedTransactionVersion: 0, encoding: "json", commitment: "confirmed" })
      .send()
      .catch(() => null);
    if (tx) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!tx) throw new Error("transaction not found / not confirmed yet");
  if (tx.meta?.err) throw new Error("transaction failed on-chain");

  // find the merchant in the account list and check its balance delta
  const keys: string[] = tx.transaction.message.accountKeys.map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const mi = keys.indexOf(MERCHANT);
  if (mi < 0) throw new Error("merchant not in transaction");
  const delta = BigInt(tx.meta.postBalances[mi]) - BigInt(tx.meta.preBalances[mi]);
  // allow a tiny tolerance for rent/edge rounding
  if (delta < (t.lamports * 99n) / 100n) {
    throw new Error(`underpaid: received ${delta} lamports, need ${t.lamports}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const existing = db.query("SELECT expires FROM passes WHERE wallet = ?").get(wallet) as any;
  const base = existing && existing.expires > now ? existing.expires : now; // stack onto remaining time
  const expires = base + t.seconds;

  db.run("INSERT INTO used_sigs VALUES (?, ?, ?)", [signature, wallet, now]);
  db.run(
    "INSERT INTO passes VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET expires=excluded.expires, tier=excluded.tier, last_sig=excluded.last_sig, updated=excluded.updated",
    [wallet, expires, tier, signature, now],
  );
  return passStatus(wallet);
}
