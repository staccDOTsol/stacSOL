import { Pool } from 'pg'

/**
 * Read-time live NAV for pool_snapshots rows: backing ÷ LIVE mint supply,
 * derived from the raw chain-read columns instead of trusting the stored
 * `rate`. The stored column is only as good as whatever deployment wrote
 * the row — an old snapshot writer (or cron pinned to a stale deployment)
 * inserts accounting-formula rates that lag out-of-band burns, and a single
 * such row at the head of the series flattens every trailing-yield
 * computation. Falls back to the stored rate for legacy rows with no
 * mint_supply.
 */
export const LIVE_NAV_SQL = `CASE WHEN mint_supply > 0
  THEN (total_lamports / mint_supply)::DOUBLE PRECISION
  ELSE rate END`

// Neon pooled connection. Note: this module is imported by every serverless
// function — pg.Pool internally caches connections per-process, so even
// though Vercel may cold-start a fresh handler, repeated invocations on the
// same warm container reuse the same TCP connections.
let pool: Pool | null = null
export function getPool(): Pool {
  if (pool) return pool
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set')
  pool = new Pool({ connectionString: url, max: 3 })
  return pool
}

/**
 * Idempotent schema migration. Called on every snapshot/history request so
 * we don't need a separate migration step for the initial deploy. The
 * `IF NOT EXISTS` makes this safe to call concurrently.
 */
export async function ensureSchema() {
  const sql = `
    CREATE TABLE IF NOT EXISTS pool_snapshots (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      total_lamports NUMERIC NOT NULL,
      pool_token_supply NUMERIC NOT NULL,
      mint_supply NUMERIC NOT NULL,
      reserve_lamports NUMERIC NOT NULL,
      rate DOUBLE PRECISION NOT NULL,
      last_update_epoch BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pool_snapshots_ts_idx ON pool_snapshots(ts DESC);
    ALTER TABLE pool_snapshots ADD COLUMN IF NOT EXISTS lp_price_sol DOUBLE PRECISION;

    CREATE TABLE IF NOT EXISTS app_migrations (
      key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One-shot backfill: \`rate\` historically stored total_lamports ÷
    -- pool_token_supply — the stake-pool's INTERNAL accounting supply, which
    -- only re-syncs with the live Token-2022 mint at UpdateStakePoolBalance.
    -- Every out-of-band burn (manual BurnChecked, external burn loops) left
    -- a drift window where history under-reported NAV. Each row already
    -- stores the live mint_supply that was read from chain at snapshot time,
    -- so the honest live rate is recoverable retroactively without walking
    -- any transactions: backing ÷ live supply. /api/snapshot now writes the
    -- same formula going forward.
    DO $rate_live_backfill$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM app_migrations
                     WHERE key = 'rate_live_mint_supply_v1') THEN
        UPDATE pool_snapshots
           SET rate = total_lamports::DOUBLE PRECISION
                      / mint_supply::DOUBLE PRECISION
         WHERE mint_supply > 0;
        INSERT INTO app_migrations (key) VALUES ('rate_live_mint_supply_v1')
          ON CONFLICT (key) DO NOTHING;
      END IF;
    END
    $rate_live_backfill$;

    CREATE TABLE IF NOT EXISTS referral_credits (
      sig TEXT NOT NULL,
      ix_index INT NOT NULL DEFAULT 0,
      slot BIGINT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      referrer TEXT NOT NULL,
      referrer_ata TEXT NOT NULL,
      depositor TEXT NOT NULL,
      sol_lamports NUMERIC NOT NULL,
      fee_stacsol NUMERIC NOT NULL,
      PRIMARY KEY (sig, ix_index)
    );
    CREATE INDEX IF NOT EXISTS referral_credits_referrer_idx ON referral_credits(referrer);
    CREATE INDEX IF NOT EXISTS referral_credits_ts_idx ON referral_credits(ts DESC);

    CREATE TABLE IF NOT EXISTS referral_index_state (
      id INT PRIMARY KEY DEFAULT 1,
      newest_sig TEXT,
      oldest_sig TEXT,
      backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO referral_index_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- One-shot migration from the legacy single-column PK on referral_credits.
    -- The old PK was sig alone, which silently dropped all but the first
    -- DepositSol ix in any multi-ix transaction (zap routers etc.), while
    -- the inserted row stored the CROSS-TX balance delta (sum of all
    -- kickbacks in that tx) as its fee_stacsol — so fee was over-counted ×N
    -- and sol_lamports under-counted ×(1/N). Apparent ROI on the referrers
    -- leaderboard inflated to N² × the real 3.45% ratio.
    --
    -- We detect the legacy schema by counting PK columns on referral_credits.
    -- If it's still single-column, ensure the ix_index column exists, drop
    -- the old PK, add the composite PK, truncate the bad rows, and reset
    -- the indexer cursor so the next cron pass refills correctly.
    --
    -- Same treatment for manager_fee_credits (its PK was already composite
    -- but its indexer had the same cross-tx delta bug — each per-ix row
    -- carried the full tx-wide delta, over-counting by N for multi-ix txs).
    DO $referral_pk_migration$
    DECLARE
      legacy_pk_cols INT;
    BEGIN
      SELECT COALESCE(SUM(1), 0)::INT INTO legacy_pk_cols
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'referral_credits'::regclass
        AND c.contype = 'p';

      IF legacy_pk_cols = 1 THEN
        -- Add ix_index column if the legacy table predates it (the CREATE
        -- TABLE IF NOT EXISTS above is a no-op against an existing table,
        -- so the new column declaration in the table body doesn't apply).
        ALTER TABLE referral_credits
          ADD COLUMN IF NOT EXISTS ix_index INT NOT NULL DEFAULT 0;
        ALTER TABLE referral_credits DROP CONSTRAINT referral_credits_pkey;
        ALTER TABLE referral_credits ADD PRIMARY KEY (sig, ix_index);
        TRUNCATE referral_credits;
        UPDATE referral_index_state
           SET newest_sig = NULL, oldest_sig = NULL, backfill_done = FALSE
           WHERE id = 1;
        TRUNCATE manager_fee_credits;
        -- The manager-fee-index state table is created lazily on first
        -- run of that endpoint, so guard the UPDATE against a fresh DB
        -- where it may not exist yet.
        IF EXISTS (SELECT 1 FROM information_schema.tables
                   WHERE table_name = 'manager_fee_index_state') THEN
          UPDATE manager_fee_index_state
             SET newest_sig = NULL, oldest_sig = NULL, backfill_done = FALSE
             WHERE id = 1;
        END IF;
      END IF;
    END
    $referral_pk_migration$;

    -- Per-tx log of stacSOL credited to the manager_fee_account (account
    -- index 5 of DepositSol). Mirrors referral_credits but for the manager-
    -- fee leg. Lets us surface "earned via protocol fees" separately from
    -- "paid for via SOL deposit".
    CREATE TABLE IF NOT EXISTS manager_fee_credits (
      sig TEXT NOT NULL,
      ix_index INT NOT NULL DEFAULT 0,
      slot BIGINT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      manager TEXT NOT NULL,
      manager_fee_ata TEXT NOT NULL,
      depositor TEXT NOT NULL,
      sol_lamports NUMERIC NOT NULL,
      fee_stacsol NUMERIC NOT NULL,
      PRIMARY KEY (sig, ix_index)
    );
    CREATE INDEX IF NOT EXISTS manager_fee_credits_manager_idx ON manager_fee_credits(manager);
    CREATE INDEX IF NOT EXISTS manager_fee_credits_ts_idx ON manager_fee_credits(ts DESC);

    -- Per-event log of every DepositSol / WithdrawSol that hit the stacSOL
    -- pool. One row per (signature, ix-occurrence) — multiple ixs in the
    -- same tx (e.g. zap router calling DepositSol twice) get distinct rows
    -- via signature + ix_index.
    CREATE TABLE IF NOT EXISTS pool_events (
      signature TEXT NOT NULL,
      ix_index INT NOT NULL DEFAULT 0,
      slot BIGINT NOT NULL,
      block_time TIMESTAMPTZ NOT NULL,
      wallet TEXT NOT NULL,
      kind TEXT NOT NULL,
      sol_lamports NUMERIC NOT NULL,
      stac_atom NUMERIC NOT NULL,
      implied_nav DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (signature, ix_index)
    );
    CREATE INDEX IF NOT EXISTS pool_events_wallet_idx ON pool_events(wallet);
    CREATE INDEX IF NOT EXISTS pool_events_block_time_idx ON pool_events(block_time DESC);

    CREATE TABLE IF NOT EXISTS holder_summary (
      wallet TEXT PRIMARY KEY,
      wallet_stac_atom NUMERIC NOT NULL DEFAULT 0,
      hawkfi_stac_atom NUMERIC NOT NULL DEFAULT 0,
      total_stac_atom NUMERIC NOT NULL DEFAULT 0,
      net_sol_in_lamports NUMERIC NOT NULL DEFAULT 0,
      gross_sol_in_lamports NUMERIC NOT NULL DEFAULT 0,
      gross_sol_out_lamports NUMERIC NOT NULL DEFAULT 0,
      mint_count INT NOT NULL DEFAULT 0,
      burn_count INT NOT NULL DEFAULT 0,
      first_event_at TIMESTAMPTZ,
      last_event_at TIMESTAMPTZ,
      burn_net_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
      pnl_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
      pnl_pct DOUBLE PRECISION,
      breakeven_nav DOUBLE PRECISION,
      balances_updated_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS holder_summary_pnl_pct_idx ON holder_summary(pnl_pct DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS holder_summary_pnl_sol_idx ON holder_summary(pnl_sol DESC NULLS LAST);
    CREATE INDEX IF NOT EXISTS holder_summary_total_stac_idx ON holder_summary(total_stac_atom DESC);

    -- "Earned" stacSOL — credited to a wallet via referral or manager-fee
    -- mechanisms inside DepositSol, with zero SOL paid by the wallet itself.
    -- Derived from referral_credits + manager_fee_credits tables on each
    -- ingester run. Surfaced separately in the leaderboard so we can show
    -- "free" earnings vs paid cost basis.
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS referral_earned_atom NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS referral_earned_count INT NOT NULL DEFAULT 0;
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS manager_fee_earned_atom NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS manager_fee_earned_count INT NOT NULL DEFAULT 0;
    -- Cached SOL value of the earned stacSOL at last NAV recompute. Updated
    -- alongside pnl_sol so the leaderboard can show earned x NAV x 0.931
    -- without reading rate at query time.
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS earned_sol DOUBLE PRECISION NOT NULL DEFAULT 0;

    -- stacSOL transferred OUT of this wallet via direct Token-2022 transfers
    -- (i.e. not a WithdrawSol on the pool program). Inferred from
    --   transferred_out = max(0, minted - burned - current_balance + referrals + manager_fees)
    -- so it captures Token-2022 peer-to-peer flow that the pool indexer
    -- can't see directly. Without this, wallets that minted stacSOL and
    -- then gifted it elsewhere show a misleading -100% P&L (paid SOL, hold
    -- zero, never burned). With it, we treat the transfer as an
    -- "implicit burn at current NAV" so P&L lines up with reality.
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS transferred_out_atom NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS transferred_out_sol  DOUBLE PRECISION NOT NULL DEFAULT 0;
    -- Mirror for receivers: stacSOL their on-chain balance contains
    -- beyond what their mints + earned credits would explain. Treated as
    -- "received free" so they don't show up as plain holders with
    -- nonsensical infinite ROI.
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS transferred_in_atom NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS transferred_in_sol  DOUBLE PRECISION NOT NULL DEFAULT 0;

    -- Doxx opt-in. The leaderboard renders every row anonymously by default
    -- (stable per-wallet pseudonym derived from the pubkey hash). Holders
    -- who explicitly opt in via /api/doxx (wallet-signed message) get their
    -- real address shown alongside an optional display_name. The signature
    -- requirement prevents anyone from doxxing a wallet that isn't theirs.
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS is_doxxed BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE holder_summary ADD COLUMN IF NOT EXISTS display_name TEXT;

    CREATE TABLE IF NOT EXISTS pool_index_state (
      id INT PRIMARY KEY DEFAULT 1,
      newest_sig TEXT,
      oldest_sig TEXT,
      backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
      last_balance_refresh_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO pool_index_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Single-row tracker for the bait-and-recover P&L.
    -- bait-loop.ts INCREMENTS outstanding_bait_cost_lamports after each
    -- imbalance round-trip (real LP fees + slippage paid out of manager
    -- wallet). burn-loop.ts DECREMENTS it during the recovery step: before
    -- burning swept withholding, withdraws enough stacSOL to recoup the
    -- outstanding cost, only then burns the excess.
    CREATE TABLE IF NOT EXISTS manager_state (
      id INT PRIMARY KEY DEFAULT 1,
      outstanding_bait_cost_lamports NUMERIC NOT NULL DEFAULT 0,
      lifetime_bait_cost_lamports NUMERIC NOT NULL DEFAULT 0,
      lifetime_bait_recovered_lamports NUMERIC NOT NULL DEFAULT 0,
      lifetime_bait_cycles INT NOT NULL DEFAULT 0,
      lifetime_recovery_cycles INT NOT NULL DEFAULT 0,
      last_bait_at TIMESTAMPTZ,
      last_recovery_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT manager_state_single_row CHECK (id = 1)
    );
    INSERT INTO manager_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Per-cycle bait detail. Each row is one bait round-trip executed by
    -- bait-loop.ts. Lets the dashboard chart per-venue cost/profit over
    -- time, attribute imbalance to a specific cross-pair, and compute
    -- transfer-volume yield.
    --
    --   sol_delta_lamports: signed pre - post wallet SOL (positive = cost,
    --     negative = profit).
    --   direction: 'mint_sell' | 'buy_burn'.
    --   venue_label: e.g. "Raydium CP/Staccana".
    --   intermediate_symbol: "SOL" for direct, otherwise the cross-pair
    --     intermediate ticker.
    --   route: e.g. "Raydium CP -> Manifest -> Whirlpool" (Jupiter's actual path).
    CREATE TABLE IF NOT EXISTS bait_events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      venue_label TEXT NOT NULL,
      intermediate_symbol TEXT NOT NULL,
      direction TEXT NOT NULL,
      size_lamports NUMERIC NOT NULL,
      sol_delta_lamports NUMERIC NOT NULL,
      route TEXT
    );
    CREATE INDEX IF NOT EXISTS bait_events_ts_idx ON bait_events(ts DESC);
    CREATE INDEX IF NOT EXISTS bait_events_venue_idx ON bait_events(venue_label, ts DESC);

    -- Per-tick burn-loop summary. Captures the volume of stacSOL that
    -- moved through Token-2022 transfer-fee withholding, how much we
    -- recovered (covering bait), how much we actually burned, and the
    -- NAV jump that materialised — so we can attribute redemption-rate
    -- growth to source (bait vs arber + organic).
    --
    --   harvested_atom: total stacSOL swept from withholding accounts.
    --     stacSOL transfer-volume in this window ~= harvested / 0.069.
    --   recovered_atom: stacSOL WithdrawSol'd to repay bait backlog.
    --   burned_atom: stacSOL actually burned via BurnChecked — pure NAV fuel.
    --   nav_before / nav_after: pool rate before/after the tick.
    --   candidate_count: # withholding accounts swept this tick.
    CREATE TABLE IF NOT EXISTS burn_events (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      harvested_atom NUMERIC NOT NULL DEFAULT 0,
      recovered_atom NUMERIC NOT NULL DEFAULT 0,
      burned_atom NUMERIC NOT NULL DEFAULT 0,
      nav_before DOUBLE PRECISION,
      nav_after DOUBLE PRECISION,
      candidate_count INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS burn_events_ts_idx ON burn_events(ts DESC);

    -- Provenance for burn_events rows. 'self_report' = legacy POSTs from
    -- scripts/burn-loop.ts via /api/manager-state; 'derived' = rows indexed
    -- from on-chain Token-2022 burns by /api/ingest-burn-events (the current
    -- burn loop runs externally and does not self-report). sig is the burn's
    -- transaction signature — the partial unique index makes re-ingestion
    -- idempotent. Self-reported rows keep sig NULL.
    ALTER TABLE burn_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'self_report';
    ALTER TABLE burn_events ADD COLUMN IF NOT EXISTS sig TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS burn_events_sig_uidx
      ON burn_events(sig) WHERE sig IS NOT NULL;
    -- Drop remnants of an abandoned snapshot-diff reconciliation approach
    -- (its DDL briefly ran against prod; supply diffing turned out to be
    -- unusable because Sanctum-routed DepositStake mints are invisible to
    -- pool_events — see ingest-burn-events.ts).
    ALTER TABLE burn_events DROP COLUMN IF EXISTS snapshot_id;
    DROP TABLE IF EXISTS burn_reconcile_state;

    -- Signature cursor for /api/ingest-burn-events. Same shape as
    -- referral_index_state / pool_index_state.
    CREATE TABLE IF NOT EXISTS burn_index_state (
      id INT PRIMARY KEY DEFAULT 1,
      newest_sig TEXT,
      oldest_sig TEXT,
      backfill_done BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO burn_index_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Indexed meme universe for the trifecta flywheel. Top Solana tokens by
    -- market cap, above a liquidity floor, minus the majors/stables/LSTs that
    -- aren't laddering targets. Refreshed wholesale by /api/index-universe
    -- (one Birdeye tokenlist sweep, cron every 15 min — the mcap ranking
    -- barely moves intraday so this stays deep inside the CU budget) and read
    -- by /api/universe with SWR. The captured mc/liquidity/volume let the
    -- controller later filter relative to OUR own mcap ("bigger than us") and
    -- skip the fiction-mcap thin pools whose headline cap is one wash-trade
    -- wide. Nothing user-facing ever calls Birdeye directly.
    CREATE TABLE IF NOT EXISTS meme_universe (
      address TEXT PRIMARY KEY,
      symbol TEXT,
      name TEXT,
      decimals INT,
      mc DOUBLE PRECISION,
      liquidity DOUBLE PRECISION,
      volume24h DOUBLE PRECISION,
      price_usd DOUBLE PRECISION,
      logo_uri TEXT,
      rank INT NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS meme_universe_rank_idx ON meme_universe(rank);
    CREATE INDEX IF NOT EXISTS meme_universe_mc_idx ON meme_universe(mc DESC NULLS LAST);

    CREATE TABLE IF NOT EXISTS meme_universe_state (
      id INT PRIMARY KEY DEFAULT 1,
      last_refresh_at TIMESTAMPTZ,
      token_count INT NOT NULL DEFAULT 0,
      min_liquidity DOUBLE PRECISION,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT meme_universe_state_single_row CHECK (id = 1)
    );
    INSERT INTO meme_universe_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- Trifecta flywheel position-marker tokens (A/B/C and any the controller
    -- mints later). Created by scripts/mint-trifecta.ts; the on-chain
    -- Token-2022 metadata `uri` points back at /api/meta?mint=<address>, which
    -- serves the Metaplex-style JSON (image etc.) out of this row. `cluster`
    -- tags devnet vs mainnet so a rehearsal mint and a live mint can coexist.
    -- `mint_authority` records the retained authority (NULL once renounced).
    CREATE TABLE IF NOT EXISTS trifecta_tokens (
      mint TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      image TEXT NOT NULL,
      external_url TEXT,
      decimals INT NOT NULL,
      cluster TEXT NOT NULL DEFAULT 'devnet',
      mint_authority TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `
  await getPool().query(sql)
}
