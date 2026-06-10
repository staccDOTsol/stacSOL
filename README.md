# stacSOL

A hyper-yielding Solana LST. Built on the audited Sanctum SPL stake-pool program with a Token-2022 6.9% transfer-fee burn loop layered on top — so NAV climbs from staking yield AND from every cross-pair DEX trade. The redemption rate is mathematically monotonic up; the program has no code path that can decrease it.

Live: **[stacsol.app](https://stacsol.app)** · Docs: **[/faq](https://stacsol.app/faq)** · X: **[@thystaccfloweth](https://x.com/thystaccfloweth)** · TG: **[t.me/StaccPROOF](https://t.me/StaccPROOF)**

This repo is the **dApp + serverless API + operational scripts** for the protocol. The on-chain stake pool itself is Sanctum's deployed program (unmodified) — there is no custom Rust in this repo.

---

## On-chain addresses

| What | Address |
| --- | --- |
| Mint (Token-2022, 9 decimals) | `6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f` |
| Stake pool | `E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb` |
| Reserve stake account | `67ZvAvjKVX9ns8YFnMnAxyhPFibxsHJXQZcX3YeViyTP` |
| Sanctum SPL stake-pool program | `SP12tWFxD9oJsVWNavTTBZvMbA6gkAmxtVgxdqvyvhY` |

---

## How the rate climbs

```
 NAV  =  pool.total_lamports  /  pool.pool_token_supply
```

Two yield sources, both compounding into the numerator/denominator ratio:

1. **Staking yield** — backing SOL is held in the pool reserve (currently 100% liquid; the architecture supports validator delegation but isn't using it yet, by choice).
2. **Token-2022 transfer-fee burn loop** — every transfer of stacSOL withholds 6.9% of the moved amount. Cross-pair DEX trades, swaps, and CEX deposits all trigger transfers. The withheld portion gets harvested by `scripts/burn-loop.ts` every 5 minutes:
   - `WithdrawWithheldTokensFromAccounts` → manager ATA
   - `BurnChecked` → drops `mint.supply`
   - `UpdateValidatorListBalance` + `UpdateStakePoolBalance` + `Cleanup` → reconciles `pool.pool_token_supply` with the new `mint.supply` so the rate gain materializes in redemption math immediately

Result: NAV goes up. Both `mint.supply` and `pool.pool_token_supply` shrink, `pool.total_lamports` is unchanged, ratio rises monotonically.

---

## What's in this repo

```
api/                 Vercel serverless functions (REST routes hit by the dapp)
src/                 React + Vite client — mint / burn / portfolio / LP zaps / FAQ
scripts/             CLI utilities (burn loop, pool init, diagnostics)
public/              Static assets
```

Notable client surfaces:

- `/` — homepage with mint, burn, position card, NAV vs LP charts, history
- `/portfolio` — DLMM positions (HawkFi-managed + direct), claim/withdraw flows
- `/liquidity` — Raydium CPMM zap-in/out
- `/singlesided` — Meteora DLMM concentrated single-sided LP
- `/faq` — bankrun math + safety + fee mechanics, rendered against live pool state
- `/guide` — narrative walkthrough

Notable serverless routes:

- `/api/circulating-supply` — live token supply for CoinGecko / GeckoTerminal listing form. Plain text by default; `?format=json` returns both camelCase and snake_case shape.
- `/api/snapshot`, `/api/history`, `/api/lp` — pool stats + LP analytics for the homepage charts
- `/api/leaderboard`, `/api/referral-index` — referral bookkeeping
- `/api/jup-quote`, `/api/jup-swap` — proxied Jupiter quote/swap (keeps the API key server-side)
- `/api/hawkfi` — HawkFi v2 read helpers

---

## Running locally

Requires Node 20+, pnpm, and a Solana mainnet RPC endpoint.

```bash
git clone https://github.com/<you>/stacsol-app.git
cd stacsol-app
pnpm install
cp .env.example .env.local
# fill in RPC_URL + VITE_RPC_URL at minimum (the rest are optional for read flows)
pnpm dev
```

The dev server runs at `http://localhost:5173`. Vercel-style API routes work via `vercel dev` if you want the `/api/*` paths locally, or just hit production URLs (CORS is permissive).

### Build / deploy

```bash
pnpm build          # Vite static build
vercel --prod       # deploy (project must be linked to Vercel first)
```

The deployed site at stacsol.app is a Vercel project. `dist/` builds the SPA, `api/` runs as Node serverless functions.

---

## Operational scripts

Everything in `scripts/` is operator-only. Most read on-chain state and need only `RPC_URL`. Two need a manager keypair:

| Script | Purpose | Auth needed |
| --- | --- | --- |
| `live-numbers.ts` | Print live rate / supply / APR | RPC only |
| `check-mint-programs.ts` | Audit token program + transfer-fee config of paired assets | RPC only |
| `check-wallets.ts` | SOL + stacSOL balances for protocol-public + (optional) local keypair wallets | RPC only |
| `investigate-user.ts` | Full position breakdown for a user wallet — wallet + LPs + tx history + P&L | RPC only |
| `burn-loop.ts` | The 5-min harvest+burn+update-pool loop. Run in a process supervisor on a long-lived host. | RPC + manager keypair |
| `init-meteora-pools.ts` | One-shot: initialize the DLMM pools listed on `/singlesided` | RPC + creator keypair |

Examples:

```bash
# Live numbers (rate, supply, realized APR, etc.)
RPC_URL="https://your-rpc/key" \
  pnpm dlx tsx scripts/live-numbers.ts

# Position dump for a wallet
RPC_URL="https://your-rpc/key" \
  pnpm dlx tsx scripts/investigate-user.ts <wallet-pubkey>

# Burn loop (long-running; use a supervisor)
RPC_URL="https://your-rpc/key" \
  KEYPAIR=./manager-keypair.json \
  pnpm dlx tsx scripts/burn-loop.ts
```

---

## Architecture overview

- **Stake pool**: unmodified Sanctum SPL stake-pool program — same deployed bytecode running JitoSOL, INF, BSOL, JUPSOL. We use it as a library, not a fork. All audits inherit.
- **Token-2022**: stacSOL is Token-2022 with `TransferFeeConfig` set to 690bps. The mint, transfer-fee, and withdraw-withheld authorities are held by the manager keypair.
- **Burn loop**: out-of-process script (`scripts/burn-loop.ts`) that periodically harvests withheld fees and triggers `UpdateStakePoolBalance` to materialize the rate gain. Runs every 5 minutes.
- **Frontend**: React 19 + Vite 7 + Tailwind v4. Solana Wallet Adapter. Talks directly to RPC for reads; routes signed transactions through Helius Sender for landing.
- **HawkFi v2 integration**: hand-rolled instruction builders in `src/lib/hawkfi-v2.ts` for HawkFi-managed DLMM positions (auto-rebalancing). Direct-owned positions use the native Meteora SDK path. The Portfolio component classifies ownership and dispatches to the right flow.
- **Referral system**: 50% of the 6.9% deposit fee (i.e. ~3.45% of the user's SOL) routes to a referrer ATA designated via `?ref=<pubkey>`. Default is the marketing wallet; custom refs persist via localStorage. Tracked in Postgres for the leaderboard.

---

## Security

- **No custom Solana program code in this repo.** The on-chain pool is Sanctum's audited SPL stake-pool program. The Token-2022 mint uses standard SPL extensions only.
- **Burn-loop authority** is the manager keypair. It can: harvest withheld fees, burn from the manager ATA, update the pool. It CANNOT: drain the reserve, change the mint's transfer-fee config without governance, mint new stacSOL out of nowhere (mint authority is held by the pool program, not the keypair).
- **Reserve solvency**: `pool.total_lamports / pool.pool_token_supply` is what the program pays out on `WithdrawSol`. Per the SPL stake-pool program, that ratio cannot regress. See `/faq` for the bankrun math.
- **No keys in this repo.** `.env`, `.env.local`, `keys/`, `*.keypair.json`, `secret*.json` are all gitignored.

If you find a vulnerability, DM [@notstacc](https://t.me/notstacc) on Telegram before disclosing publicly.

---

## License

MIT — do whatever, no warranty, don't blame us if you LP into a dead memecoin.
