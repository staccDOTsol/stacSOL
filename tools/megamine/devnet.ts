// megamine devnet dress rehearsal — full composed flow on a real cluster:
// init mine → grow map → house curve via CPI (splitter = creator) → buy on
// uponly → keccak PoW grind → dig (NAV burn + fee split, maybe strike).
// Mini build (SIZE=50). Mainnet = same script, canonical uponly id, full size.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { readFileSync } from "node:fs";

const MEGAMINE = new PublicKey(process.env.MEGAMINE ?? "8ReVUwn2CGmeu7suQzjQ5yreWxPGQ3fnwktH8S1yKbMW");
const UPONLY = new PublicKey(process.env.UPONLY ?? "AN6NdpTJyceDfH9eNLYvk6ttUHR3bvDWhvUs4JjWHTKQ");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SIZE = Number(process.env.SIZE ?? 50), MINE_SIZE = SIZE ** 3, GROW = 10_240;
const GROW_TO = Math.min(Number(process.env.GROW_TO ?? MINE_SIZE), MINE_SIZE);
const POW_BITS = BigInt(process.env.POW_BITS ?? 16);
const HOUSE_CURVES = Number(process.env.HOUSE_CURVES ?? 1);
const BUY_SOL = Number(process.env.BUY_SOL ?? 1);
const DIGS = Number(process.env.DIGS ?? 3);
const CLUSTER = process.env.CLUSTER ?? "devnet";

const conn = new Connection(process.env.RPC ?? "https://api.devnet.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(
    JSON.parse(readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/.config/solana/id.json`, "utf8")),
  ),
);

const pda = (seeds: (Buffer | Uint8Array)[], prog = MEGAMINE) =>
  PublicKey.findProgramAddressSync(seeds, prog)[0];
const CONFIG = pda([Buffer.from("config")]);
const MINE = pda([Buffer.from("mine")]);
const POT = pda([Buffer.from("pot")]);
const SPLITTER = pda([Buffer.from("splitter")]);
const curvePda = (mint: PublicKey) => pda([Buffer.from("curve"), mint.toBuffer()], UPONLY);
const linkPda = (mint: PublicKey) => pda([Buffer.from("faction"), mint.toBuffer()]);
const ataOf = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()], ATA_PROG)[0];

// ---- LE buffer writers ----
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn); b.writeBigUInt64LE(n >> 64n, 8); return b; };

const ix = (prog: PublicKey, keys: { p: PublicKey; s?: boolean; w?: boolean }[], data: Buffer) =>
  new TransactionInstruction({
    programId: prog,
    keys: keys.map((k) => ({ pubkey: k.p, isSigner: !!k.s, isWritable: !!k.w })),
    data,
  });

async function getInfo(pk: PublicKey) {
  for (let i = 0; i < 10; i++) {
    const a = await conn.getAccountInfo(pk);
    if (a) return a;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("account not visible after retries: " + pk.toBase58());
}

async function send(ixs: TransactionInstruction[], signers: Keypair[] = []) {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer, ...signers], { commitment: "confirmed" });
}

// ---- PoW (mirror of lib.rs pow_clears) ----
function grind(digger: PublicKey, idx: number, seed: Uint8Array): bigint {
  const target = (2n ** 64n - 1n) >> POW_BITS;
  const base = Buffer.concat([digger.toBuffer(), u32(idx), Buffer.from(seed)]);
  for (let nonce = 0n; ; nonce++) {
    const h = keccak_256(Buffer.concat([base, u64(nonce)]));
    if (Buffer.from(h.slice(0, 8)).readBigUInt64LE() <= target) return nonce;
  }
}

const sol = (l: number) => (l / LAMPORTS_PER_SOL).toFixed(4);
const link = (sig: string) => CLUSTER === "mainnet" ? `https://solscan.io/tx/${sig}` : `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function main() {
  console.log(`payer ${payer.publicKey.toBase58()} — ${sol(await conn.getBalance(payer.publicKey))} SOL`);
  console.log(`megamine ${MEGAMINE.toBase58()}\nuponly   ${UPONLY.toBase58()}`);

  // 1. Initialize (idempotent: skip if config exists)
  if (!(await conn.getAccountInfo(CONFIG))) {
    const data = Buffer.concat([
      u8(0),
      u64(BigInt(process.env.DIG_FEE ?? 100_000)), // dig_fee
      u8(3),                // foreign_fee_mult
      u16(2_000),           // dig_fee_dev_bps
      u16(5_000),           // splitter_pot_bps
      u64(1_000_000n),      // dig_burn_value: 0.001 SOL of NAV
      u32(Number(process.env.VEIN_THRESHOLD ?? 1_073_741_823)),
      u64(BigInt(process.env.VEIN_BASE ?? 10_000_000)),
      u32(Number(process.env.ROUND_SECS ?? 3_600)),
      u8(Number(POW_BITS)),
      u16(9_350),           // constitution floor
      u16(100),             // creator fee cap
    ]);
    const sig = await send([
      ix(MEGAMINE, [
        { p: payer.publicKey, s: true, w: true },
        { p: CONFIG, w: true },
        { p: MINE, w: true },
        { p: POT, w: true },
        { p: SPLITTER, w: true },
        { p: UPONLY },
        { p: payer.publicKey }, // dev = payer for the rehearsal
        { p: SystemProgram.programId },
      ], data),
    ]);
    console.log(`init: ${link(sig)}`);
  } else console.log("config exists — skipping init");

  // 2. Grow the map to full size
  const growIx = () =>
    ix(MEGAMINE, [
      { p: payer.publicKey, s: true, w: true },
      { p: CONFIG, w: true },
      { p: MINE, w: true },
      { p: SystemProgram.programId },
    ], u8(1));
  let len = (await getInfo(MINE)).data.length;
  while (len < GROW_TO) {
    const n = Math.min(12, Math.ceil((GROW_TO - len) / GROW));
    const sig = await send(Array.from({ length: n }, growIx));
    len = (await getInfo(MINE)).data.length;
    console.log(`grow ×${n} → ${len}/${MINE_SIZE} (target ${GROW_TO}): ${link(sig)}`);
  }

  // 3. House curves via CPI — splitter becomes the uponly fee recipient
  const mints: Keypair[] = [];
  for (let h = 0; h < HOUSE_CURVES; h++) {
  const mint = Keypair.generate();
  mints.push(mint);
  const curve = curvePda(mint.publicKey);
  const rent82 = await conn.getMinimumBalanceForRentExemption(82);
  const initMint2 = Buffer.concat([u8(20), u8(9), curve.toBuffer(), u8(0)]);
  const houseData = Buffer.concat([
    u8(2),
    u128(10n ** 15n), // 0.001 SOL start price
    u64(50n * BigInt(LAMPORTS_PER_SOL)),
    u16(100), u16(200), u16(100), u16(500), u16(9_350),
  ]);
  const sig3 = await send(
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
        lamports: rent82, space: 82, programId: TOKEN,
      }),
      ix(TOKEN, [{ p: mint.publicKey, w: true }], initMint2),
      ix(MEGAMINE, [
        { p: payer.publicKey, s: true, w: true },
        { p: CONFIG, w: true },
        { p: SPLITTER, w: true },
        { p: mint.publicKey },
        { p: curve, w: true },
        { p: linkPda(mint.publicKey), w: true },
        { p: UPONLY },
        { p: SystemProgram.programId },
      ], houseData),
    ],
    [mint],
  );
  console.log(`house curve (mint ${mint.publicKey.toBase58()}): ${link(sig3)}`);
  const curveAcc = (await getInfo(curve));
  const creator = new PublicKey(curveAcc.data.slice(32, 64));
  console.log(`  uponly buy_creator == splitter? ${creator.equals(SPLITTER)}`);

  // 4. Buy on uponly (creator fee → splitter)
  const ataH = ataOf(payer.publicKey, mint.publicKey);
  const createAta = ix(ATA_PROG, [
    { p: payer.publicKey, s: true, w: true },
    { p: ataH, w: true },
    { p: payer.publicKey },
    { p: mint.publicKey },
    { p: SystemProgram.programId },
    { p: TOKEN },
  ], u8(1)); // CreateIdempotent
  const buy = ix(UPONLY, [
    { p: payer.publicKey, s: true, w: true },
    { p: curvePda(mint.publicKey), w: true },
    { p: mint.publicKey, w: true },
    { p: ataH, w: true },
    { p: SPLITTER, w: true },
    { p: TOKEN },
    { p: SystemProgram.programId },
  ], Buffer.concat([u8(1), u64(BigInt(Math.round(BUY_SOL * LAMPORTS_PER_SOL))), u64(0n)]));
  console.log(`buy ${BUY_SOL} SOL: ${link(await send([createAta, buy]))}`);
  console.log(`  splitter balance (creator fee landed): ${sol(await conn.getBalance(SPLITTER))} SOL`);
  } // end house curve loop
  const mint = mints[0];
  const ata = ataOf(payer.publicKey, mint.publicKey);
  const curve = curvePda(mint.publicKey);

  // 4b. Register an existing foreign curve as a faction (optional)
  if (process.env.REGISTER_MINT) {
    const fmint = new PublicKey(process.env.REGISTER_MINT);
    const rsig = await send([
      ix(MEGAMINE, [
        { p: payer.publicKey, s: true, w: true },
        { p: CONFIG, w: true },
        { p: fmint },
        { p: curvePda(fmint), w: false },
        { p: linkPda(fmint), w: true },
        { p: SystemProgram.programId },
      ], u8(3)),
    ]);
    console.log(`registered foreign faction ${fmint.toBase58()}: ${link(rsig)}`);
  }

  // 5. Fund the pot so strikes pay
  await send([SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: POT, lamports: 50_000_000 })]);

  // 6. Dig three voxels with real PoW
  const cfg = (await conn.getAccountInfo(CONFIG))!.data;
  const seed = cfg.slice(115, 147);
  for (const idx of Array.from({ length: DIGS }, (_, k) => k)) {
    const t0 = Date.now();
    const nonce = grind(payer.publicKey, idx, seed);
    const dig = ix(MEGAMINE, [
      { p: payer.publicKey, s: true, w: true },
      { p: CONFIG },
      { p: MINE, w: true },
      { p: linkPda(mint.publicKey) },
      { p: mint.publicKey, w: true },
      { p: ata, w: true },
      { p: curve, w: true },
      { p: POT, w: true },
      { p: SPLITTER },
      { p: payer.publicKey, w: true }, // dev = payer
      { p: TOKEN },
      { p: SystemProgram.programId },
    ], Buffer.concat([u8(4), u32(idx), u64(nonce)]));
    const sig = await send([dig]);
    console.log(`dig idx=${idx} (ground nonce ${nonce} in ${Date.now() - t0}ms): ${link(sig)}`);
  }

  // 7. Proof: read the world + economics straight from the chain
  const mine = (await getInfo(MINE)).data;
  console.log(`voxels [0,1,2] = [${mine[0]}, ${mine[1]}, ${mine[2]}] (1 = faction 1)`);
  const curveNow = await conn.getBalance(curve);
  const supply = (await getInfo(mint.publicKey)).data.readBigUInt64LE(36);
  console.log(`curve vault ${sol(curveNow)} SOL, supply ${Number(supply) / 1e9} tokens (burned by digs)`);
  console.log(`pot ${sol(await conn.getBalance(POT))} SOL, splitter ${sol(await conn.getBalance(SPLITTER))} SOL`);
  console.log(`\nmine account: https://explorer.solana.com/address/${MINE.toBase58()}?cluster=devnet`);
}

main().catch((e) => { console.error(e); process.exit(1); });
