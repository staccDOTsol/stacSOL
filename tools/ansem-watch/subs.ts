// Native Solana subscription billing for the carnage terminal.
// Uses solana-foundation/subscriptions (De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44).
//
// Plan: 0.05 wSOL per 1-hour period. The subscribe tx (built here, signed by the
// viewer's wallet) wraps SOL into their wSOL ATA, inits the subscription authority
// and accepts the plan. The relay is merchant + puller and collects every hour.

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
  sendAndConfirmTransactionFactory,
  createSolanaRpcSubscriptions,
  getSignatureFromTransaction,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
} from "@solana-program/token";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  findPlanPda,
  findSubscriptionDelegationPda,
  fetchMaybePlan,
  fetchMaybeSubscriptionAuthorityFromSeeds,
  fetchMaybeSubscriptionDelegation,
  getCreatePlanOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getSubscribeOverlayInstructionAsync,
  getTransferSubscriptionOverlayInstructionAsync,
} from "@solana/subscriptions";

const WSOL = address("So11111111111111111111111111111111111111112");
const PLAN_ID = BigInt(process.env.SUB_PLAN_ID || "1");
const PRICE_LAMPORTS = BigInt(process.env.SUB_PRICE_LAMPORTS || "50000000"); // 0.05 SOL
const PERIOD_HOURS = 1n;
const RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const RPC_WS = process.env.SOLANA_RPC_WS || RPC_URL.replace(/^http/, "ws");

const rpc = createSolanaRpc(RPC_URL);

// merchant/puller keypair: env JSON array, or a file path
async function loadMerchant() {
  const raw =
    process.env.SUB_MERCHANT_KEYPAIR_JSON ||
    (await Bun.file(
      process.env.SUB_MERCHANT_KEYPAIR || `${process.env.HOME}/.config/solana/id.json`,
    ).text().catch(() => null));
  if (!raw) return null;
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(raw)));
}

let merchant: Awaited<ReturnType<typeof loadMerchant>> = null;
let planPda: any = null;
let merchantAta: any = null;
let ready = false;

const subsDb = new Database(
  `${process.env.DATA_DIR || new URL(".", import.meta.url).pathname}/subs.db`,
);
subsDb.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    wallet TEXT PRIMARY KEY, sub_pda TEXT, created INTEGER,
    last_paid INTEGER, status TEXT
  );
`);

async function sendWithMerchant(ixs: any[]) {
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(merchant!, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await rpc.sendTransaction(wire, { encoding: "base64", skipPreflight: false }).send();
  // poll for confirmation (no ws dependency)
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const st = await rpc.getSignatureStatuses([sig]).send();
    const cs = st.value?.[0]?.confirmationStatus;
    if (cs === "confirmed" || cs === "finalized") return sig;
  }
  throw new Error(`tx ${sig} not confirmed in time`);
}

/** boot: ensure merchant, plan, and merchant wSOL ATA exist */
export async function initSubscriptions() {
  merchant = await loadMerchant();
  if (!merchant) {
    console.log("[subs] no merchant keypair — subscriptions disabled");
    return;
  }
  [planPda] = await findPlanPda({ owner: merchant.address, planId: PLAN_ID });
  [merchantAta] = await findAssociatedTokenPda({
    mint: WSOL, owner: merchant.address, tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const plan = await fetchMaybePlan(rpc, planPda);
  if (!plan.exists) {
    console.log(`[subs] creating plan ${planPda} (0.05 wSOL / 1h) — merchant ${merchant.address}`);
    const ixs = [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: merchant, mint: WSOL, owner: merchant.address,
      }),
      await getCreatePlanOverlayInstructionAsync({
        owner: merchant,
        planId: PLAN_ID,
        mint: WSOL,
        amount: PRICE_LAMPORTS,
        periodHours: PERIOD_HOURS,
        endTs: 0n,
        destinations: [merchant.address],
        pullers: [merchant.address],
        metadataUri: "https://ansem-carnage.fly.dev/plan.json",
      }),
    ];
    const sig = await sendWithMerchant(ixs);
    console.log(`[subs] plan created: ${sig}`);
  } else {
    console.log(`[subs] plan exists: ${planPda}`);
  }
  ready = true;
}

export function subsInfo() {
  return {
    // SUB_FORCE_ENABLED=1: preview the paywall without a funded merchant
    enabled: ready || process.env.SUB_FORCE_ENABLED === "1",
    merchant: merchant?.address ?? null,
    planId: PLAN_ID.toString(),
    planPda: planPda ?? null,
    mint: WSOL,
    lamportsPerPeriod: PRICE_LAMPORTS.toString(),
    periodHours: Number(PERIOD_HOURS),
    priceSolPerHour: Number(PRICE_LAMPORTS) / 1e9,
  };
}

/** on-chain + local status for a wallet */
export async function subStatus(wallet: string) {
  if (!ready) return { enabled: false, subscribed: false };
  const subscriber = address(wallet);
  const [subPda] = await findSubscriptionDelegationPda({ planPda, subscriber });
  const sub = await fetchMaybeSubscriptionDelegation(rpc, subPda);
  const row = subsDb.query("SELECT * FROM subscribers WHERE wallet = ?").get(wallet) as any;
  if (!sub.exists) {
    return { enabled: true, subscribed: false };
  }
  const expires = Number(sub.data.expiresAtTs ?? 0n);
  const cancelled = expires !== 0 && expires < Date.now() / 1000;
  if (!row) {
    subsDb.run(
      "INSERT OR IGNORE INTO subscribers VALUES (?, ?, ?, ?, 'active')",
      [wallet, subPda, Math.floor(Date.now() / 1000), 0],
    );
  }
  return {
    enabled: true,
    subscribed: !cancelled,
    delinquent: row?.status === "delinquent",
    subPda,
    lastPaid: row?.last_paid ?? 0,
  };
}

/** build the unsigned subscribe tx: wrap SOL → init authority (if needed) → subscribe */
export async function buildSubscribeTx(wallet: string, hours: number) {
  if (!ready) throw new Error("subscriptions not initialized");
  const subscriber = address(wallet);
  const noop = createNoopSigner(subscriber);
  const fund = PRICE_LAMPORTS * BigInt(Math.max(1, Math.min(168, Math.floor(hours))));

  const [userAta] = await findAssociatedTokenPda({
    mint: WSOL, owner: subscriber, tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const ixs: any[] = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer: noop, mint: WSOL, owner: subscriber,
    }),
    getTransferSolInstruction({ source: noop, destination: userAta, amount: fund }),
    getSyncNativeInstruction({ account: userAta }),
  ];

  const authority = await fetchMaybeSubscriptionAuthorityFromSeeds(rpc, {
    user: subscriber, tokenMint: WSOL,
  }).catch(() => ({ exists: false }));

  if (!(authority as any).exists) {
    ixs.push(
      await getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: noop, tokenMint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS, userAta,
      }),
    );
  }

  const plan = await fetchMaybePlan(rpc, planPda);
  if (!plan.exists) throw new Error("plan missing on-chain");

  ixs.push(
    await getSubscribeOverlayInstructionAsync({
      merchant: merchant!.address,
      planId: PLAN_ID,
      subscriber: noop,
      tokenMint: WSOL,
      expectedAmount: plan.data.terms.amount,
      expectedPeriodHours: plan.data.terms.periodHours,
      expectedCreatedAt: plan.data.terms.createdAt,
      expectedSubscriptionAuthorityInitId: (authority as any).exists
        ? (authority as any).data.initId
        : undefined,
    }),
  );

  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(subscriber, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const compiled = compileTransaction(msg);
  return { tx: getBase64EncodedWireTransaction(compiled) };
}

/** top-up tx: just wrap more SOL into the subscriber's wSOL ATA */
export async function buildTopupTx(wallet: string, hours: number) {
  const subscriber = address(wallet);
  const noop = createNoopSigner(subscriber);
  const fund = PRICE_LAMPORTS * BigInt(Math.max(1, Math.min(168, Math.floor(hours))));
  const [userAta] = await findAssociatedTokenPda({
    mint: WSOL, owner: subscriber, tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const ixs = [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: noop, mint: WSOL, owner: subscriber }),
    getTransferSolInstruction({ source: noop, destination: userAta, amount: fund }),
    getSyncNativeInstruction({ account: userAta }),
  ];
  const { value: latest } = await rpc.getLatestBlockhash().send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(subscriber, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  return { tx: getBase64EncodedWireTransaction(compileTransaction(msg)) };
}

/** mark first payment collected right after subscribe confirms (subscribe implies period start) */
export function noteSubscribed(wallet: string, subPda: string) {
  subsDb.run(
    "INSERT INTO subscribers VALUES (?, ?, ?, 0, 'active') ON CONFLICT(wallet) DO UPDATE SET status='active', sub_pda=excluded.sub_pda",
    [wallet, subPda, Math.floor(Date.now() / 1000)],
  );
}

/** hourly collector — pull 0.05 wSOL from every active subscriber whose period elapsed */
export async function collectDue() {
  if (!ready) return;
  const now = Math.floor(Date.now() / 1000);
  const due = subsDb
    .query("SELECT * FROM subscribers WHERE status != 'cancelled' AND last_paid <= ?")
    .all(now - 3600) as any[];
  for (const row of due) {
    try {
      const ix = await getTransferSubscriptionOverlayInstructionAsync({
        caller: merchant!,
        delegator: address(row.wallet),
        tokenMint: WSOL,
        subscriptionPda: address(row.sub_pda),
        planPda,
        amount: PRICE_LAMPORTS,
        receiverAta: merchantAta,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const sig = await sendWithMerchant([ix]);
      subsDb.run("UPDATE subscribers SET last_paid = ?, status = 'active' WHERE wallet = ?", [now, row.wallet]);
      console.log(`[subs] collected 0.05 wSOL from ${row.wallet}: ${sig}`);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/PERIOD_NOT_ELAPSED|0x/.test(msg) && row.last_paid === 0) {
        // fresh subscription — first period may not be collectable yet, that's fine
        subsDb.run("UPDATE subscribers SET last_paid = ? WHERE wallet = ?", [now, row.wallet]);
        continue;
      }
      console.log(`[subs] collect failed for ${row.wallet} (marking delinquent): ${msg.slice(0, 160)}`);
      subsDb.run("UPDATE subscribers SET status = 'delinquent' WHERE wallet = ?", [row.wallet]);
    }
  }
}
