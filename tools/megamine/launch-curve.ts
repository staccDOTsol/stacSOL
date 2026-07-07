// Launch a curve on CANONICAL uponly mainnet (DQf1…) — atomic, per the
// upstream audit: mint create + authority-to-PDA + Initialize in ONE tx.
// Optionally follows with a genesis buy.
//
//   RPC=<url> KEYPAIR=~/presale1.json BUY_SOL=0.15 bun launch-curve.ts
//
// Params default to the flagship "main token" config from his launcher
// (1 SOL start, 25 SOL per 2x, 3%/6% all-in fees, 93.5% governor) — which
// also passes megamine's 93.5% constitution for later faction registration.
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";

const UPONLY = new PublicKey(process.env.UPONLY ?? "DQf1BBhRNnhthJUmsCT6Rt2whodZyNLbsqKQ3kHYUU6N");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROG = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const conn = new Connection(process.env.RPC ?? "https://api.mainnet-beta.solana.com", "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(process.env.KEYPAIR ?? `${process.env.HOME}/presale1.json`, "utf8"))),
);
const BUY_SOL = Number(process.env.BUY_SOL ?? 0);
const buyCreator = new PublicKey(process.env.BUY_CREATOR ?? payer.publicKey);
const sellCreator = new PublicKey(process.env.SELL_CREATOR ?? payer.publicKey);

const u8b = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u128 = (n: bigint) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & 0xffffffffffffffffn); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const meta = (p: PublicKey, s = false, w = false) => ({ pubkey: p, isSigner: s, isWritable: w });

async function main() {
  const bal = await conn.getBalance(payer.publicKey);
  console.log(`payer ${payer.publicKey.toBase58()} — ${(bal / 1e9).toFixed(4)} SOL`);
  console.log(`uponly ${UPONLY.toBase58()} (CAUTION: upgrade authority not burned yet)`);

  const mint = Keypair.generate();
  const curve = PublicKey.findProgramAddressSync([Buffer.from("curve"), mint.publicKey.toBuffer()], UPONLY)[0];
  const rent82 = await conn.getMinimumBalanceForRentExemption(82);

  const initData = Buffer.concat([
    u8b(0),
    buyCreator.toBuffer(),
    sellCreator.toBuffer(),
    u128(BigInt(process.env.START_PRICE_FP ?? "1000000000000000000")), // 1 SOL/token
    u64(BigInt(process.env.DOUBLE_VOL_SOL ?? 25) * BigInt(LAMPORTS_PER_SOL)),
    u16(Number(process.env.BUY_FEE_CREATOR_BPS ?? 100)),
    u16(Number(process.env.BUY_FEE_FLOOR_BPS ?? 200)),
    u16(Number(process.env.SELL_FEE_CREATOR_BPS ?? 100)),
    u16(Number(process.env.SELL_FEE_FLOOR_BPS ?? 500)),
    u16(Number(process.env.MIN_BACKING_BPS ?? 9350)),
  ]);

  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey, newAccountPubkey: mint.publicKey,
      lamports: rent82, space: 82, programId: TOKEN,
    }),
    new TransactionInstruction({ // InitializeMint2: decimals 9, authority = curve PDA, no freeze
      programId: TOKEN,
      keys: [meta(mint.publicKey, false, true)],
      data: Buffer.concat([u8b(20), u8b(9), curve.toBuffer(), u8b(0)]),
    }),
    new TransactionInstruction({
      programId: UPONLY,
      keys: [
        meta(payer.publicKey, true, true),
        meta(curve, false, true),
        meta(mint.publicKey),
        meta(SystemProgram.programId),
      ],
      data: initData,
    }),
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [payer, mint], { commitment: "confirmed" });
  console.log(`\n⛏ CURVE LAUNCHED (atomic)`);
  console.log(`mint : ${mint.publicKey.toBase58()}`);
  console.log(`curve: ${curve.toBase58()}`);
  console.log(`tx   : https://solscan.io/tx/${sig}`);

  if (BUY_SOL > 0) {
    const ata = PublicKey.findProgramAddressSync(
      [payer.publicKey.toBuffer(), TOKEN.toBuffer(), mint.publicKey.toBuffer()], ATA_PROG)[0];
    const buyTx = new Transaction().add(
      new TransactionInstruction({ programId: ATA_PROG, keys: [
        meta(payer.publicKey, true, true), meta(ata, false, true), meta(payer.publicKey),
        meta(mint.publicKey), meta(SystemProgram.programId), meta(TOKEN),
      ], data: u8b(1) }),
      new TransactionInstruction({ programId: UPONLY, keys: [
        meta(payer.publicKey, true, true), meta(curve, false, true), meta(mint.publicKey, false, true),
        meta(ata, false, true), meta(buyCreator, false, true), meta(TOKEN), meta(SystemProgram.programId),
      ], data: Buffer.concat([u8b(1), u64(BigInt(Math.round(BUY_SOL * 1e9))), u64(0n)]) }),
    );
    const bsig = await sendAndConfirmTransaction(conn, buyTx, [payer], { commitment: "confirmed" });
    console.log(`\ngenesis buy ${BUY_SOL} SOL: https://solscan.io/tx/${bsig}`);
    const acc = (await conn.getAccountInfo(ata))!;
    console.log(`tokens: ${Number(acc.data.readBigUInt64LE(64)) / 1e9}`);
    const cv = await conn.getBalance(curve);
    console.log(`curve vault: ${(cv / 1e9).toFixed(4)} SOL`);
  }
}
main().catch((e) => { console.error(e.logs ?? e); process.exit(1); });
