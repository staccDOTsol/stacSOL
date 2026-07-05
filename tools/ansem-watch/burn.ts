// Buy-and-burn: the fee wallet spends accrued SOL fees on $BUCKINGHAM via
// Jupiter Ultra, then burns the tokens (SPL burn -> supply reduction).
// Runs on a timer; self-activates once the wallet holds > RESERVE + MIN_BURN.

import { Database } from "bun:sqlite";
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  TransactionMessage,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createBurnCheckedInstruction,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const JUP_KEY = process.env.JUP_API_KEY || "jup_af37688f07828e1e5033327fc6d1a8e3eecacd76c1d4c5774e23f740c1ea2361";
const JUP = "https://api.jup.ag/ultra/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const BURN_MINT = process.env.BURN_MINT || "FcrChwb4uneNCGcydadz2VDwhdpv6JAai9JRyEt4pump";

const RESERVE = Number(process.env.BURN_RESERVE_LAMPORTS || "20000000"); // keep 0.02 SOL for rent/fees
const MIN_BURN = Number(process.env.BURN_MIN_LAMPORTS || "20000000"); // only swap if >= 0.02 SOL spendable

const conn = new Connection(RPC_URL, "confirmed");
let fee: Keypair | null = null;
let burnMintPk: PublicKey;
let burnDecimals = 6;

const db = new Database(
  `${process.env.DATA_DIR || new URL(".", import.meta.url).pathname}/subs.db`,
);
db.exec(`
  CREATE TABLE IF NOT EXISTS burns (
    ts INTEGER, sol_spent INTEGER, tokens INTEGER, buy_sig TEXT, burn_sig TEXT
  );
`);

async function loadFee() {
  const raw =
    process.env.SUB_BURN_KEYPAIR_JSON ||
    process.env.SUB_MERCHANT_KEYPAIR_JSON ||
    (await Bun.file(process.env.SUB_MERCHANT_KEYPAIR || `${process.env.HOME}/jjj.json`).text().catch(() => null));
  if (!raw) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

export async function initBurn() {
  fee = await loadFee();
  if (!fee) { console.log("[burn] no fee keypair — buy-and-burn disabled"); return; }
  burnMintPk = new PublicKey(BURN_MINT);
  try {
    const m = await getMint(conn, burnMintPk);
    burnDecimals = m.decimals;
  } catch {}
  console.log(`[burn] buy-and-burn enabled — fee wallet ${fee.publicKey.toBase58()} spends on ${BURN_MINT.slice(0, 8)}… (${burnDecimals}dp)`);
}

export function burnStatus() {
  const agg = db.query("SELECT COUNT(*) n, COALESCE(SUM(sol_spent),0) sol, COALESCE(SUM(tokens),0) tok, MAX(ts) last FROM burns").get() as any;
  return {
    enabled: !!fee,
    wallet: fee?.publicKey.toBase58() ?? null,
    burnMint: BURN_MINT,
    totalBurns: agg.n,
    solSpent: agg.sol / 1e9,
    tokensBurned: agg.tok / 10 ** burnDecimals,
    lastBurn: agg.last ?? 0,
  };
}

async function jup(path: string, opts?: RequestInit) {
  const r = await fetch(JUP + path, {
    ...opts,
    headers: { "x-api-key": JUP_KEY, "content-type": "application/json", ...(opts?.headers || {}) },
  });
  return r.json();
}

/** one buy-and-burn cycle; safe no-op when under threshold */
export async function buyAndBurn() {
  if (!fee) return;
  const bal = await conn.getBalance(fee.publicKey).catch(() => 0);
  const spend = bal - RESERVE;
  if (spend < MIN_BURN) return;

  try {
    // 1) Jupiter Ultra order: SOL -> BURN_MINT (Ultra handles wrapping + routing)
    const order: any = await jup(
      `/order?inputMint=${SOL_MINT}&outputMint=${BURN_MINT}&amount=${spend}&taker=${fee.publicKey.toBase58()}`,
    );
    if (!order || !order.transaction || order.errorMessage) {
      console.log(`[burn] no executable order (${order?.errorMessage || "no tx"})`);
      return;
    }

    // 2) sign + execute via Ultra
    const tx = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
    tx.sign([fee]);
    const exec: any = await jup("/execute", {
      method: "POST",
      body: JSON.stringify({ signedTransaction: Buffer.from(tx.serialize()).toString("base64"), requestId: order.requestId }),
    });
    if (exec?.status !== "Success" && !exec?.signature) {
      console.log(`[burn] execute failed: ${JSON.stringify(exec).slice(0, 200)}`);
      return;
    }
    const buySig = exec.signature || "";
    console.log(`[burn] bought ~${(Number(order.outAmount) / 10 ** burnDecimals).toFixed(2)} tokens for ${(spend / 1e9).toFixed(4)} SOL: ${buySig.slice(0, 12)}`);

    // 3) burn everything now in the fee wallet's token account
    await new Promise((r) => setTimeout(r, 4000));
    const ata = getAssociatedTokenAddressSync(burnMintPk, fee.publicKey);
    const acct = await getAccount(conn, ata).catch(() => null);
    const amount = acct ? acct.amount : 0n;
    let burnSig = "";
    if (amount > 0n) {
      const ix = createBurnCheckedInstruction(ata, burnMintPk, fee.publicKey, amount, burnDecimals);
      const bh = await conn.getLatestBlockhash();
      const msg = new TransactionMessage({ payerKey: fee.publicKey, recentBlockhash: bh.blockhash, instructions: [ix] }).compileToV0Message();
      const btx = new VersionedTransaction(msg);
      btx.sign([fee]);
      burnSig = await conn.sendTransaction(btx, { skipPreflight: false });
      await conn.confirmTransaction({ signature: burnSig, ...bh }, "confirmed").catch(() => {});
      console.log(`[burn] 🔥 burned ${(Number(amount) / 10 ** burnDecimals).toFixed(2)} tokens: ${burnSig.slice(0, 12)}`);
    }

    db.run("INSERT INTO burns VALUES (?, ?, ?, ?, ?)", [Math.floor(Date.now() / 1000), spend, Number(amount), buySig, burnSig]);
  } catch (e: any) {
    console.log(`[burn] cycle failed: ${String(e?.message ?? e).slice(0, 160)}`);
  }
}
