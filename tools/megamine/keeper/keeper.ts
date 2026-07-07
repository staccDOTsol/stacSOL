// megamine keeper — permissionless cranker for the commit-reveal game.
//
//  * REVEAL: every open ["commit", idx] PDA whose slot has sealed gets revealed
//    -> pays the stored digger on a strike, reclaims the commit rent on a dry or
//    expired one. Winners get paid even if they closed their tab.
//  * ROTATE: when a round's window closes, advance it (fresh slot-hash seed).
//
// Permissionless => runs on a THROWAWAY wallet, never the upgrade authority.
//   RPC=<helius> KEEPER_KEYPAIR_JSON='[..]' bun keeper.ts
//   (or KEYPAIR=~/megamine-keeper.json for local runs)
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, SYSVAR_SLOT_HASHES_PUBKEY, SystemProgram,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";

const MEGAMINE = new PublicKey(process.env.MEGAMINE ?? "BWduMhsy2Z1ptkL2Pjjb6727zDVxMaFSqbmhuQ6Lmgeq");
const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const secret = process.env.KEEPER_KEYPAIR_JSON
  ? JSON.parse(process.env.KEEPER_KEYPAIR_JSON)
  : JSON.parse(readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/megamine-keeper.json`, "utf8"));
const payer = Keypair.fromSecretKey(Uint8Array.from(secret));

const meta = (p: PublicKey, s = false, w = false) => ({ pubkey: p, isSigner: s, isWritable: w });
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, MEGAMINE)[0];
const CONFIG = pda([Buffer.from("config")]);
const POT = pda([Buffer.from("pot")]);
const COMMIT_SIZE = 110;
const INTERVAL = Number(process.env.INTERVAL_MS ?? 10_000);
const BATCH = 6;

// Commit layout: digger[0..32] curve[32..64] round_seed[64..96]
//                commit_slot(u64)[96..104] idx(u32)[104..108] faction[108] bump[109]
const parseCommit = (d: Buffer) => ({
  digger: new PublicKey(d.subarray(0, 32)),
  curve: new PublicKey(d.subarray(32, 64)),
  commit_slot: d.readBigUInt64LE(96),
  idx: d.readUInt32LE(104),
});

function revealIx(commitKey: PublicKey, c: ReturnType<typeof parseCommit>) {
  return new TransactionInstruction({
    programId: MEGAMINE,
    keys: [
      meta(payer.publicKey, true, true), meta(CONFIG), meta(commitKey, false, true),
      meta(POT, false, true), meta(c.curve, false, true), meta(c.digger, false, true),
      meta(SYSVAR_SLOT_HASHES_PUBKEY), meta(SystemProgram.programId),
    ],
    data: Buffer.from([7]),
  });
}

async function maybeRotate() {
  try {
    const cfg = await conn.getAccountInfo(CONFIG);
    if (!cfg) return;
    const roundEnd = cfg.data.readBigInt64LE(147); // Config.round_end_ts
    if (BigInt(Math.floor(Date.now() / 1000)) < roundEnd) return;
    const rot = new TransactionInstruction({
      programId: MEGAMINE,
      keys: [meta(CONFIG, false, true), meta(SYSVAR_SLOT_HASHES_PUBKEY)],
      data: Buffer.from([5]),
    });
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(rot), [payer], { commitment: "confirmed" });
    console.log(`[keeper] rotated round -> ${sig.slice(0, 16)}…`);
  } catch (e) { /* someone else rotated, or round still live */ }
}

async function tick() {
  await maybeRotate();
  const [accts, slot] = await Promise.all([
    conn.getProgramAccounts(MEGAMINE, { filters: [{ dataSize: COMMIT_SIZE }] }),
    conn.getSlot(),
  ]);
  const ready = accts
    .filter((a) => a.account.lamports > 0)                              // skip closed 0-lamport tombstones
    .map((a) => ({ key: a.pubkey, c: parseCommit(a.account.data as Buffer) }))
    .filter((x) => x.c.commit_slot > 0n && BigInt(slot) > x.c.commit_slot + 2n); // real + sealed + in the slot-hash ring
  if (!ready.length) { console.log(`[keeper] slot ${slot} — ${accts.length} open, 0 ready`); return; }
  console.log(`[keeper] slot ${slot} — revealing ${ready.length}/${accts.length}`);
  for (let i = 0; i < ready.length; i += BATCH) {
    const chunk = ready.slice(i, i + BATCH);
    try {
      const tx = new Transaction().add(...chunk.map((x) => revealIx(x.key, x.c)));
      const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
      console.log(`  revealed ${chunk.length} -> ${sig.slice(0, 16)}…`);
    } catch {
      // one stale/racey commit shouldn't sink the batch — retry singly
      for (const x of chunk) {
        try { await sendAndConfirmTransaction(conn, new Transaction().add(revealIx(x.key, x.c)), [payer], { commitment: "confirmed" }); }
        catch (e2) { console.log(`  reveal idx=${x.c.idx} skipped: ${String(e2).slice(0, 70)}`); }
      }
    }
  }
}

// tiny health endpoint so fly keeps it alive
Bun.serve({ port: Number(process.env.PORT || 8080), fetch: () => new Response("keeper ok") });
console.log(`[keeper] up — megamine ${MEGAMINE.toBase58()}, payer ${payer.publicKey.toBase58()}`);
const balance = await conn.getBalance(payer.publicKey);
console.log(`[keeper] balance ${(balance / 1e9).toFixed(4)} SOL`);
tick().catch((e) => console.error("tick", String(e)));
setInterval(() => tick().catch((e) => console.error("tick", String(e))), INTERVAL);
