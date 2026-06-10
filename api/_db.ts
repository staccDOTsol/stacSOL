import { Pool } from 'pg'

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
  `
  await getPool().query(sql)
}
