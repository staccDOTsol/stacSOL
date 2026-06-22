module.exports = {
  apps: [
    {
      name: "flashloan",
      script: "/opt/homebrew/bin/bun",
      args: "run scripts/ggss-whirlpool-flashloan.ts --loop",
      cwd: "/Users/stacc/claude/stacSOL",
      instances: "max",          // = 18 on this machine
      exec_mode: "fork",         // fork, not cluster (no HTTP)
      restart_delay: 0,
      min_uptime: "0s",
      max_restarts: 1000000,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      out_file: "/Users/stacc/claude/stacSOL/logs/flashloan-out.log",
      error_file: "/Users/stacc/claude/stacSOL/logs/flashloan-err.log",
      merge_logs: true,
      log_date_format: "HH:mm:ss.SSS",
    },
    {
      // Dashboard indexer. Replaces the dead Vercel crons (which need a Pro
      // plan for */5 schedules and stopped on 2026-05-28). Drives the same
      // cron handlers — snapshot, pool-events, referral, manager-fee, burns —
      // on a local 5-minute loop against the live chain. Bun auto-loads
      // .env.local; run-indexers.ts repoints DATABASE_URL at the real Neon.
      name: "indexer",
      script: "/opt/homebrew/bin/bun",
      args: "run scripts/run-indexers.ts --loop",
      cwd: "/Users/stacc/claude/stacSOL",
      instances: 1,              // single writer — no parallel cursor races
      exec_mode: "fork",
      restart_delay: 10000,
      min_uptime: "30s",
      max_restarts: 1000000,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        LOOP_MS: "300000",       // 5 min, matching the old cron cadence
      },
      out_file: "/Users/stacc/claude/stacSOL/logs/indexer-out.log",
      error_file: "/Users/stacc/claude/stacSOL/logs/indexer-err.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
