#!/usr/bin/env bun
/**
 * Save Finance permissionless-pool launcher.
 *
 * Initialises a new Save lending market owned by you, then optionally adds
 * the configured reserves. Dry-run by default — pass `--execute` to actually
 * sign + broadcast. The 200 SLND fee Save charges for permissionless pools
 * is NOT included here; pay it via the Save UI before/after, or extend this
 * script to transfer it to the Save treasury wallet up front.
 *
 *   bun scripts/save-pool-launch.ts                 # dry-run
 *   bun scripts/save-pool-launch.ts --execute        # actually create
 *   bun scripts/save-pool-launch.ts --market=<pk>    # skip init, add reserves only
 *
 * Env (in .env.local or shell):
 *   RPC_URL      Solana mainnet RPC (Helius / Triton / etc.)
 *   WALLET_KEY   JSON array of 64 bytes (Solana CLI keypair format)
 */
import { LAMPORTS_PER_SOL, SystemProgram } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, createInitializeAccountInstruction } from '@solana/spl-token';

import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedMessage,
  sendAndConfirmTransaction,
} from '@solana/web3.js'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'

import {
  buildInitMarketIxs,
  buildInitReserveIxs,
  defaultReserveConfig,
  fetchSaveRent,
  NULL_ORACLE,
  SOLEND_PRODUCTION_PROGRAM_ID,
} from '../src/lib/save-pool'
import bs58 from 'bs58';
import { VersionedTransaction } from '@solana/web3.js'
import { AddressLookupTableAccount } from '@solana/web3.js'
import { AddressLookupTableInstruction } from '@solana/web3.js'
import { AddressLookupTableProgram } from '@solana/web3.js'
// ---------- Reserve plan -----------------------------------------------------

interface ReservePlan {
  symbol: string
  mint: string
  decimals: number
  initialDepositUi: number // human units (e.g. 0.1 SOL, 1.0 USDC)
  pythOracle?: string // omit / null → unpriced
  switchboardOracle?: string // omit → null
  /** Override the default reserve config (LTV, liq threshold etc.). */
  config?: Partial<ReturnType<typeof defaultReserveConfig>>
}

// Pyth feed addresses (mainnet, Pyth v1 program). Sources:
//   https://pyth.network/developers/price-feed-ids#solana-mainnet
const PYTH_USDC = 'Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'
const PYTH_SOL = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG'

const RESERVE_PLAN: ReservePlan[] = [
  // USDC — Pyth-priced, sane LTV. 1 USDC seed.
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    initialDepositUi: 1,
    pythOracle: PYTH_USDC,
  },
  // wSOL — Pyth-priced. 0.1 SOL seed.
  {
    symbol: 'wSOL',
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    initialDepositUi: 0.1,
    pythOracle: PYTH_SOL,
  },
  // wstacSOL — no Pyth feed. Reserves can be initialized with NULL_ORACLE,
  // but they'll be unborrowable until an oracle is set via SetReserveOracle.
  // For now, mirror SOL's price as a placeholder; correct via permissioned
  // post-init update later. Seed 0.1 wstacSOL.
  {
    symbol: 'wstacSOL',
    mint: 'GB2Y9s7N9HcpCmrqyByygMfRsJDLH1Gt7wasTtczohYL',
    decimals: 9,
    initialDepositUi: 0.1,
    pythOracle: PYTH_SOL, // placeholder — wstacSOL ≈ stacSOL ≈ ~NAV SOL
    config: {
      // tighter risk on a brand-new unpriced asset
      loanToValueRatio: 30,
      liquidationThreshold: 40,
      maxLiquidationThreshold: 50,
    },
  },
  // Curated LP (D8jKy56SzVZh2ejnYTxavG7jzGTgbzT8vaPDPM5ZPCbE) — also no Pyth.
  // Listing as deposit-only (LTV=0 so nobody can borrow against it). Replace
  // the oracle / config when you have a real feed.
  {
    symbol: 'LP-D8jKy',
    mint: 'D8jKy56SzVZh2ejnYTxavG7jzGTgbzT8vaPDPM5ZPCbE',
    decimals: 9, // confirm before running — Raydium CP LPs vary
    initialDepositUi: 0.001,
    pythOracle: PYTH_SOL, // placeholder — replace
    config: {
      loanToValueRatio: 0, // collateral only
      liquidationThreshold: 0,
      maxLiquidationThreshold: 0,
    },
  },
]

// ---------- main -------------------------------------------------------------

function arg(flag: string): string | undefined {
  const a = process.argv.find((s) => s.startsWith(flag + '=')) ?? process.argv.find((s) => s === flag)
  if (!a) return undefined
  return a.includes('=') ? a.split('=', 2)[1] : ''
}

function loadWallet(): Keypair {
  return Keypair.fromSecretKey(bs58.decode(process.env.MANAGER_STATE_SECRET!));
}

async function main() {
  const execute = process.argv.includes('--execute')
  const marketOverride = arg('--market')
  const skip = (arg('--skip') ?? '').split(',').filter(Boolean)

  const rpcUrl = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'
  const wallet = loadWallet()
  const owner = wallet.publicKey

  console.log(`▸ Save permissionless pool launcher`)
  console.log(`  rpc      ${rpcUrl}`)
  console.log(`  owner    ${owner.toBase58()}`)
  console.log(`  mode     ${execute ? 'EXECUTE' : 'dry-run (pass --execute to commit)'}`)

  const conn = new Connection(rpcUrl, 'confirmed')
  const rent = await fetchSaveRent(conn)
  console.log(
    `  rent     market ${(rent.lendingMarket / 1e9).toFixed(6)} SOL · reserve ${(rent.reserve / 1e9).toFixed(6)} SOL · spl-acc ${(rent.splAccount / 1e9).toFixed(6)} SOL · spl-mint ${(rent.splMint / 1e9).toFixed(6)} SOL`,
  )

  // Step 1: initLendingMarket (unless --market= override given).
  let marketPubkey: PublicKey
  let authorityPubkey: PublicKey
  if (true) {
    marketPubkey = new PublicKey("H9K39tHtaA6Szm4S84LQjNHL9Moj4vDQzDZxaDtjmXgx")
    const [pda] = PublicKey.findProgramAddressSync(
      [marketPubkey.toBytes()],
      SOLEND_PRODUCTION_PROGRAM_ID,
    )
    authorityPubkey = pda
    console.log(`▸ Using existing market ${marketPubkey.toBase58()}`)
    console.log(`  authority ${authorityPubkey.toBase58()}`)
  } else {
    const built = await buildInitMarketIxs({
      owner,
      rentExemptLamports: rent.lendingMarket,
    })
    console.log(`▸ Step 1: initLendingMarket`)
    console.log(`  market    ${built.marketPubkey.toBase58()}`)
    console.log(`  authority ${built.authorityPubkey.toBase58()}`)

    marketPubkey = built.marketPubkey
    authorityPubkey = built.authorityPubkey
  }

    const validAlts = [new PublicKey("8eXXe5vKAgJMV4r9crhZjQ9yFgA9AEkh1d7ned1N4U4y")];


  // Step 2: per-reserve initReserve.
  for (const r of RESERVE_PLAN) {
    if (skip.includes(r.symbol)) {
      console.log(`▸ Skipping reserve ${r.symbol}`)
      continue
    }
    console.log(`\n▸ Step 2.${RESERVE_PLAN.indexOf(r) + 1}: initReserve · ${r.symbol}`)

    const mint = new PublicKey(r.mint)
    const sourceAta = getAssociatedTokenAddressSync(mint, owner)
    // BN doesn't accept fractional numbers — go through string atoms.
    // initialDepositUi can be 0.1 etc., so multiply in float space and floor.
    const atoms = BigInt(
      Math.floor(r.initialDepositUi * Math.pow(10, r.decimals)),
    )
    void BN // silence unused if no other BN math left
    console.log(
      `  mint      ${r.mint}\n  source    ${sourceAta.toBase58()}\n  deposit   ${r.initialDepositUi} ${r.symbol} (${atoms.toString()} atoms)`,
    )

    // Sanity: ATA must exist with sufficient balance before we run.
    if (execute) {
      const info = await conn.getTokenAccountBalance(sourceAta).catch(() => null)
      if (!info?.value) {
        console.log(`  ✗ source ATA empty or missing — fund ${r.symbol} first`)
        continue
      }
      const onChain = BigInt(info.value.amount)
      if (onChain < atoms) {
        console.log(
          `  ✗ insufficient ${r.symbol}: have ${onChain.toString()}, need ${atoms.toString()}`,
        )
        continue
      }
    }

    const oracles = {
      pythOracle: r.pythOracle ? new PublicKey(r.pythOracle) : NULL_ORACLE,
      switchboardOracle: r.switchboardOracle
        ? new PublicKey(r.switchboardOracle)
        : NULL_ORACLE,
    }

    const plan = await buildInitReserveIxs({
      owner,
      market: marketPubkey,
      authority: authorityPubkey,
      liquidityMint: mint,
      liquidityMintDecimals: r.decimals,
      initialDepositAtoms: atoms,
      sourceLiquidityAta: sourceAta,
      oracles,
      config: r.config,
      rent: {
        reserve: rent.reserve,
        splAccount: rent.splAccount,
        splMint: rent.splMint,
      },
    })

    console.log(
      `  reserve   ${plan.reservePubkey.toBase58()}\n  cMint     ${plan.collateralMintPubkey.toBase58()}\n  liqSupply ${plan.liquiditySupplyPubkey.toBase58()}\n  feeRecv   ${plan.liquidityFeeReceiverPubkey.toBase58()}\n  destColl  ${plan.destinationCollateralAta.toBase58()}\n  ixs       ${plan.ixs.length}`,
    )

    if (execute) {

      const accountsInPlan: PublicKey[] = [];
      for (const ix of plan.ixs) {
        for (const key of ix.keys) {
          accountsInPlan.push(key.pubkey);
        }
      }

      // Properly build all required address lookup table keys as dictated by solana docs
      const oneAlt = validAlts[0];
      let addressLookupTableAccounts = await conn.getAddressLookupTable(oneAlt);

      const seen: PublicKey[] = [];
      for (const acc of accountsInPlan) {
        if (!addressLookupTableAccounts.value?.state.addresses.some((a) => a.equals(acc))) {
          seen.push(acc);
        }
      }
      // When building the V0 transaction, 
      // make sure to pass the correct AddressLookupTableAccount to compileToV0Message.
      // the API is: compileToV0Message(lookupTables: AddressLookupTableAccount[]): VersionedMessage

      // If getAddressLookupTable fails to resolve to a value, throw a useful error.
      const lookupTableAccountResult = await conn.getAddressLookupTable(oneAlt);
      if (!lookupTableAccountResult.value) {
        throw new Error(
          `Address lookup table ${oneAlt.toBase58()} unavailable or invalid.`
        );
      }
      const lookupTableAccount = lookupTableAccountResult.value as AddressLookupTableAccount;

      try {
        // Fix: only sign with Keypairs that are *actually required as signers* for the current transaction,
        // to avoid the "unknown signer" error from web3.js.

        /**
         * Given a Transaction and an array of available Keypairs, find and sign only the ones that match
         * a required isSigner AccountMeta in the message.
         */
        function signOnlyRequiredSigners(transaction: Transaction, wallet: Keypair, possibleSigners: Keypair[]) {
          // The wallet *MUST* be included if it's a required signer (fee payer always is).
          // Also, fee payer must be present, which is always wallet.publicKey.
          // Construct a map of available keypairs by their public key base58.
          const signerMap: Record<string, Keypair> = {
            [wallet.publicKey.toBase58()]: wallet,
          };
          for (const kp of possibleSigners) {
            signerMap[kp.publicKey.toBase58()] = kp;
          }

          // Find the list of pubkeys the tx message thinks are signers
          // (The Transaction._instructions build up .signers, which is then used in .sign)
          // .sign will expect the *exact* required keys or will now throw.

          const requiredSigners = transaction.instructions
            .flatMap(ix => ix.keys)
            .filter(meta => meta.isSigner)
            .map(meta => meta.pubkey.toBase58());

          // Ensure the fee payer (wallet) is first, then append other unique required signers we possess
          const uniqueRequiredSigners = Array.from(new Set([wallet.publicKey.toBase58(), ...requiredSigners]));

          // Produce Keypair[] for the ones we possess out of wallet+plan.signers
          const actualSigners: Keypair[] = [];
          for (const pk58 of uniqueRequiredSigners) {
            if (signerMap[pk58]) {
              actualSigners.push(signerMap[pk58]);
            }
          }

          transaction.sign(...actualSigners);

          // Optionally, warn if we do NOT possess all required signers (should not happen)
          const notPossessed = uniqueRequiredSigners.filter(pk58 => !signerMap[pk58]);
          if (notPossessed.length > 0) {
            console.warn(
              'Warning: these required signers are missing from signing set:', 
              notPossessed
            );
          }
        }

        // Split instructions for two transactions
        const splitAt = Math.floor(plan.ixs.length / 2);

        // First transaction
        const message = new Transaction().add(...(plan.ixs.slice(0, splitAt) as TransactionInstruction[]));  
        const blockhash1 = await conn.getLatestBlockhash();
        message.recentBlockhash = blockhash1.blockhash;
        message.feePayer = wallet.publicKey;
        message.lastValidBlockHeight = blockhash1.lastValidBlockHeight;

        // Only sign with required keys for this tx
        signOnlyRequiredSigners(message, wallet, plan.signers);

        const sig2 = await conn.sendRawTransaction(message.serialize());
        console.log(`  ✓ v0Tx landed: ${sig2}`);
        console.log(`  ✓ initReserve landed: ${sig2}`);

        // Second transaction
        const message2 = new Transaction().add(...(plan.ixs.slice(splitAt) as TransactionInstruction[]));  
        const blockhash2 = await conn.getLatestBlockhash();
        message2.recentBlockhash = blockhash2.blockhash;
        message2.feePayer = wallet.publicKey;
        message2.lastValidBlockHeight = blockhash2.lastValidBlockHeight;

        signOnlyRequiredSigners(message2, wallet, plan.signers);

        const sig3 = await conn.sendRawTransaction(message2.serialize());
        console.log(`  ✓ v0Tx2 landed: ${sig3}`);
        console.log(`  ✓ initReserve landed: ${sig3}`);
      } catch (e: any) {
        // Catch SendTransactionError and log full error with logs
        if (e && typeof e === 'object' && typeof e.getLogs === 'function') {
          console.error("SendTransactionError:", e);
          try {
            const logs = await e.getLogs();
            if (logs) {
              console.error("Transaction simulation logs:", logs);
            } else {
              console.error("No logs returned from getLogs().");
            }
          } catch (logErr) {
            console.error("Error fetching logs from SendTransactionError:", logErr);
          }
        }
        throw e;
      }
    }
}
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})  