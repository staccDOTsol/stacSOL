// ansem-watch: Birdeye ingester + SQLite + websocket broadcaster for the crash dashboard.
// Run: bun run tools/ansem-watch/server.ts   (port 4477)
//
// Tries Birdeye's streaming socket first (needs Business package); on rejection falls
// back to fast REST polling. Either way the browser gets a real websocket at /ws and
// every event is persisted to ansem.db so PnL/flow survive restarts.

import { Database } from "bun:sqlite";
// billing lives in a sidecar process (subs-server.ts, :4478) — proxied below
const SUBS_URL = process.env.SUBS_URL || "http://127.0.0.1:4478";

const KEY = process.env.BIRDEYE_API_KEY || "3fa616d53b45415c8bd550e7820b3160";
// any ticker: WATCH_MINT env, CLI arg, or POST /api/watch {mint} at runtime.
// Last runtime switch persists in DATA_DIR/current-mint.
const DEFAULT_MINT = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
let MINT =
  process.env.WATCH_MINT ||
  Bun.argv[2] ||
  DEFAULT_MINT;
const WSOL = "So11111111111111111111111111111111111111112";
const BE = "https://public-api.birdeye.so";
const PORT = 4477;
const HEADERS = { "X-API-KEY": KEY, "x-chain": "solana", accept: "application/json" };

// ---------- db (one file per watched mint; DATA_DIR for fly volumes) ----------
const DATA_DIR = process.env.DATA_DIR || new URL(".", import.meta.url).pathname;

// runtime-switched mint takes precedence over env default
try {
  const saved = require("fs").readFileSync(`${DATA_DIR}/current-mint`, "utf8").trim();
  if (saved && !process.env.WATCH_MINT && !Bun.argv[2]) MINT = saved;
} catch {}

let db: Database;
let insTrade: any, insLiq: any, insTick: any, insHolder: any;

function initDb(mint: string) {
  if (db) db.close();
  db = new Database(`${DATA_DIR}/watch-${mint.slice(0, 8)}.db`);
  db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS trades (
    tx_hash TEXT PRIMARY KEY, block_time INTEGER, owner TEXT, side TEXT,
    usd REAL, tok REAL, source TEXT, pool TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trades_owner ON trades(owner);
  CREATE INDEX IF NOT EXISTS idx_trades_time ON trades(block_time);
  CREATE TABLE IF NOT EXISTS liq_events (
    k TEXT PRIMARY KEY, tx_hash TEXT, block_time INTEGER, owner TEXT,
    kind TEXT, usd REAL, source TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_liq_owner ON liq_events(owner);
  CREATE TABLE IF NOT EXISTS price_ticks (t INTEGER, price REAL);
  CREATE TABLE IF NOT EXISTS holders (
    snap_time INTEGER, owner TEXT, ui_amount REAL, rank INTEGER,
    PRIMARY KEY (snap_time, owner)
  );
`);
  insTrade = db.prepare(
    "INSERT OR IGNORE INTO trades VALUES ($h, $t, $o, $side, $usd, $tok, $src, $pool)",
  );
  insLiq = db.prepare("INSERT OR IGNORE INTO liq_events VALUES ($k, $h, $t, $o, $kind, $usd, $src)");
  insTick = db.prepare("INSERT INTO price_ticks VALUES ($t, $p)");
  insHolder = db.prepare("INSERT OR IGNORE INTO holders VALUES ($t, $o, $a, $r)");
}

initDb(MINT);

// ---------- live state ----------
let price = 0;
let solPrice = 81;
let overview: any = null;
let candlesCache: any = { data: { items: [] } };
let holdersCache: any[] = [];
let mode = "starting"; // "birdeye-ws" | "poll"

// ---------- birdeye helpers ----------
async function be(path: string): Promise<any> {
  const r = await fetch(`${BE}${path}`, { headers: HEADERS });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

// CORS so the aggr frontend (:4488) can hit us directly, no proxy needed
const CORS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

// common Solana defi venues — union'd with whatever Birdeye actually reports
const KNOWN_SOURCES = [
  "pump_amm", "pump_fun", "meteora_dlmm", "meteora_damm_v2", "meteora",
  "whirlpool", "raydium", "raydium_clmm", "raydium_cp", "orca",
  "fusion_amm", "solfi", "obric_v2", "lifinity", "phoenix", "zerofi",
  "stabble_weighted_swap", "aquifer", "tessera_v", "humidifi", "goosefx_gamma",
];
const srcToPair = (s: string) => s.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

// defi sources seen live — feeds /api/products so the aggr client paints per-DEX markets
let seenSources = new Set<string>();
function loadSeenSources() {
  seenSources = new Set(
    (db.query("SELECT DISTINCT source FROM trades").all() as any[]).map((r) => r.source).filter(Boolean),
  );
}
loadSeenSources();

function normTrade(t: any) {
  if (t.source) seenSources.add(t.source);

  // REST /defi/txs shape: base/quote legs where base = the watched token
  let tok = t.base?.uiAmount ?? 0;
  let usd = tok * (t.base?.price ?? t.basePrice ?? price ?? 0);
  let side = t.side;
  if (t.quote?.address === WSOL && t.quote?.price) solPrice = t.quote.price;

  // Birdeye websocket TXS_DATA shape: from/to legs — find the watched-token leg
  if (!tok && (t.from || t.to)) {
    const legs = [t.from, t.to].filter(Boolean);
    const baseLeg = legs.find((l: any) => l.address === MINT);
    const otherLeg = legs.find((l: any) => l.address !== MINT);
    if (baseLeg) {
      tok = Math.abs(baseLeg.uiChangeAmount ?? baseLeg.uiAmount ?? 0);
      // per-leg unit price first — volumeUSD spans the WHOLE route on multi-hop
      // swaps where the token is just an intermediate leg, inflating usd/tok
      usd = tok * (baseLeg.price ?? baseLeg.nearestPrice ?? 0) || t.volumeUSD || 0;
      side = side ?? (baseLeg === t.to ? "buy" : "sell");
      if (otherLeg?.address === WSOL && otherLeg?.price) solPrice = otherLeg.price;
    }
  }

  // sanity clamp: if the implied unit price is wildly off spot (multi-hop
  // route artifacts, stale leg prices), re-value at spot
  if (tok > 0 && price > 0) {
    const implied = usd / tok;
    if (implied > price * 1.15 || implied < price / 1.15) {
      usd = tok * price;
    }
  }

  return {
    h: t.txHash, t: t.blockUnixTime, o: t.owner, side,
    usd, tok, src: t.source ?? "", pool: t.poolId ?? t.poolAddress ?? "",
  };
}

function normLiq(t: any) {
  let usd = 0;
  for (const tok of t.tokens ?? []) {
    if (tok.address === WSOL) usd += tok.uiAmount * solPrice;
    else if (tok.address === MINT) usd += tok.uiAmount * price;
  }
  return {
    k: t.txHash + t.txType + (t.tokens?.map((x: any) => x.amount).join(",") ?? ""),
    h: t.txHash, t: t.blockUnixTime, o: t.owner, kind: t.txType, usd, src: t.source ?? "",
  };
}

function ingestTrade(raw: any): boolean {
  const tr = normTrade(raw);
  if (!tr.h || !tr.o) return false;
  const res = insTrade.run({ $h: tr.h, $t: tr.t, $o: tr.o, $side: tr.side, $usd: tr.usd, $tok: tr.tok, $src: tr.src, $pool: tr.pool });
  if (res.changes > 0) { publish({ type: "trade", data: tr }); return true; }
  return false;
}

function ingestLiq(raw: any): boolean {
  const lq = normLiq(raw);
  if (!lq.h || !lq.o) return false;
  const res = insLiq.run({ $k: lq.k, $h: lq.h, $t: lq.t, $o: lq.o, $kind: lq.kind, $usd: lq.usd, $src: lq.src });
  if (res.changes > 0) { publish({ type: "liq", data: lq }); return true; }
  return false;
}

// ---------- aggregates (SQL, whole watch history) ----------
function leaderboard() {
  const rows = db.query(`
    SELECT t.owner,
      SUM(CASE WHEN side='buy' THEN usd ELSE 0 END) AS buy_usd,
      SUM(CASE WHEN side='sell' THEN usd ELSE 0 END) AS sell_usd,
      SUM(CASE WHEN side='buy' THEN tok ELSE -tok END) AS net_tok,
      COUNT(*) AS n,
      EXISTS(SELECT 1 FROM liq_events l WHERE l.owner = t.owner) AS lp
    FROM trades t GROUP BY t.owner
    HAVING buy_usd + sell_usd >= 100
  `).all() as any[];
  const scored = rows.map((r) => ({
    o: r.owner, buy: r.buy_usd, sell: r.sell_usd, net: r.net_tok, n: r.n, lp: !!r.lp,
    pnl: r.sell_usd + r.net_tok * price - r.buy_usd,
    vol: r.buy_usd + r.sell_usd,
  }));
  scored.sort((a, b) => b.pnl - a.pnl);
  return { winners: scored.filter((r) => r.pnl > 0).slice(0, 25), losers: scored.filter((r) => r.pnl < 0).slice(-25).reverse() };
}

function flowStats() {
  const f = db.query(`
    SELECT
      SUM(CASE WHEN side='buy' THEN usd ELSE 0 END) AS buy_usd,
      SUM(CASE WHEN side='sell' THEN usd ELSE 0 END) AS sell_usd,
      COUNT(*) AS trades, COUNT(DISTINCT owner) AS wallets,
      MIN(block_time) AS since
    FROM trades
  `).get() as any;
  const l = db.query(`
    SELECT
      SUM(CASE WHEN kind='add' THEN usd ELSE 0 END) AS added,
      SUM(CASE WHEN kind='remove' THEN usd ELSE 0 END) AS removed
    FROM liq_events
  `).get() as any;
  const dump = db.query(
    "SELECT owner, usd, block_time FROM trades WHERE side='sell' ORDER BY usd DESC LIMIT 1",
  ).get() as any;
  return { ...f, ...l, dump, mode };
}

// ---------- pollers ----------
async function pollTrades() {
  try {
    const items = (await be(`/defi/txs/token?address=${MINT}&offset=0&limit=50&tx_type=swap&sort_type=desc`)).data?.items ?? [];
    for (const t of items.reverse()) ingestTrade(t);
  } catch (e) { console.error("trades:", e); }
}

async function pollLiq() {
  try {
    const [a, r] = await Promise.all([
      be(`/defi/txs/token?address=${MINT}&offset=0&limit=25&tx_type=add&sort_type=desc`).catch(() => null),
      be(`/defi/txs/token?address=${MINT}&offset=0&limit=25&tx_type=remove&sort_type=desc`).catch(() => null),
    ]);
    const items = [...(a?.data?.items ?? []), ...(r?.data?.items ?? [])].sort((x, y) => x.blockUnixTime - y.blockUnixTime);
    for (const t of items) ingestLiq(t);
  } catch (e) { console.error("liq:", e); }
}

async function pollOverview() {
  try {
    const d = (await be(`/defi/token_overview?address=${MINT}`)).data;
    overview = d; price = d.price;
    insTick.run({ $t: Math.floor(Date.now() / 1000), $p: d.price });
    publish({ type: "overview", data: d });
  } catch (e) { console.error("overview:", e); }
}

// aggr timeframe (seconds) -> nearest Birdeye OHLCV resolution (min is 1m)
function tfToBirdeye(sec) {
  const table = [
    [60, "1m"], [180, "3m"], [300, "5m"], [900, "15m"], [1800, "30m"],
    [3600, "1H"], [7200, "2H"], [14400, "4H"], [21600, "6H"], [28800, "8H"],
    [43200, "12H"], [86400, "1D"], [259200, "3D"], [604800, "1W"],
  ];
  let pick = "1m";
  for (const [s, t] of table) { pick = t; if (sec <= s) break; }
  const secs = { "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1H": 3600, "2H": 7200, "4H": 14400, "6H": 21600, "8H": 28800, "12H": 43200, "1D": 86400, "3D": 259200, "1W": 604800 };
  return { type: pick, seconds: secs[pick] };
}

const candleCacheByTf: Record<string, { at: number; data: any }> = {};
async function candlesForTf(sec: number) {
  const { type, seconds } = tfToBirdeye(sec);
  const cached = candleCacheByTf[type];
  const nowMs = Date.now();
  if (cached && nowMs - cached.at < 20000) return cached.data;
  const now = Math.floor(nowMs / 1000);
  const from = now - seconds * 220; // ~220 bars of history
  const data = await be(`/defi/ohlcv?address=${MINT}&type=${type}&time_from=${from}&time_to=${now}`);
  candleCacheByTf[type] = { at: nowMs, data };
  return data;
}

async function pollCandles() {
  try {
    const now = Math.floor(Date.now() / 1000);
    candlesCache = await be(`/defi/ohlcv?address=${MINT}&type=1m&time_from=${now - 3 * 3600}&time_to=${now}`);
  } catch (e) { console.error("candles:", e); }
}

async function pollHolders() {
  try {
    const items = (await be(`/defi/v3/token/holder?address=${MINT}&offset=0&limit=50`)).data?.items ?? [];
    const t = Math.floor(Date.now() / 1000);
    items.forEach((h: any, i: number) => insHolder.run({ $t: t, $o: h.owner, $a: h.ui_amount, $r: i + 1 }));
    // delta vs each owner's FIRST snapshot in the db = "who's exiting since watch start"
    const first = new Map(
      (db.query(`
        SELECT owner, ui_amount FROM holders h
        WHERE snap_time = (SELECT MIN(snap_time) FROM holders WHERE owner = h.owner)
      `).all() as any[]).map((r) => [r.owner, r.ui_amount]),
    );
    const sellers = new Set(
      (db.query("SELECT DISTINCT owner FROM trades WHERE side='sell'").all() as any[]).map((r) => r.owner),
    );
    const supply = overview?.totalSupply || (overview ? overview.marketCap / overview.price : 1e9);
    holdersCache = items.map((h: any, i: number) => ({
      rank: i + 1, o: h.owner, amt: h.ui_amount,
      pct: (h.ui_amount / supply) * 100,
      delta: h.ui_amount - (first.get(h.owner) ?? h.ui_amount),
      selling: sellers.has(h.owner),
      lp: !!db.query("SELECT 1 FROM liq_events WHERE owner=? LIMIT 1").get(h.owner),
    }));
    publish({ type: "holders", data: holdersCache });
  } catch (e) { console.error("holders:", e); }
}

// ---------- birdeye streaming (used automatically if the key's package allows it) ----------
let birdeyeWs: WebSocket | null = null;
function tryBirdeyeWS() {
  let gotData = false;
  const wsMint = MINT;
  try {
    const ws = new WebSocket(`wss://public-api.birdeye.so/socket/solana?x-api-key=${KEY}`, {
      protocols: ["echo-protocol"],
      headers: { Origin: "ws://public-api.birdeye.so" },
    } as any);
    birdeyeWs = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "SUBSCRIBE_TXS", data: { queryType: "simple", address: wsMint } }));
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "TXS_DATA") {
        gotData = true; mode = "birdeye-ws";
        ingestTrade(msg.data);
      } else if (msg.type === "ERROR") {
        console.log("birdeye ws rejected (plan lacks streaming), using fast REST poll:", msg.data);
        ws.close();
      }
    };
    ws.onclose = () => {
      if (wsMint !== MINT) return; // switched away — the new mint has its own socket
      if (!gotData) mode = "poll";
      else setTimeout(tryBirdeyeWS, 2000);
    };
    ws.onerror = () => {};
  } catch { mode = "poll"; }
}

// ---------- local websocket fanout ----------
function publish(msg: any) {
  server.publish("feed", JSON.stringify(msg));
}

const INDEX = new URL("./index.html", import.meta.url).pathname;
// built aggr terminal (tools/ansem-aggr/dist) — served at / when present
const AGGR_DIST = process.env.AGGR_DIST || new URL("../ansem-aggr/dist", import.meta.url).pathname;
const aggrIndex = Bun.file(`${AGGR_DIST}/index.html`);
const hasAggr = await aggrIndex.exists();

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const p = url.pathname;
    // CORS preflight for cross-origin POSTs (e.g. dev app on :4488 → relay :4477)
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
          "access-control-max-age": "86400",
        },
      });
    }
    if (p === "/ws") {
      const tag = `${req.headers.get("origin") ?? "no-origin"} ${req.headers.get("user-agent")?.slice(0, 40) ?? ""}`;
      if (srv.upgrade(req, { data: { tag } })) return undefined as any;
      return new Response("upgrade failed", { status: 400 });
    }
    if (p === "/dash" || p === "/dash/") {
      return new Response(Bun.file(INDEX), { headers: { "content-type": "text/html" } });
    }
    if (hasAggr && !p.startsWith("/api/") && p !== "/paywall.js" && p !== "/plan.json") {
      // aggr terminal at / — static files with SPA fallback. no-cache because
      // aggr's build ids are per-day, not per-content: same-day rebuilds reuse
      // filenames and would poison browser caches otherwise.
      const NOCACHE = { "cache-control": "no-cache" };
      const f = Bun.file(`${AGGR_DIST}${p === "/" ? "/index.html" : p}`);
      if (await f.exists()) return new Response(f, { headers: NOCACHE });
      if (!p.includes(".")) {
        return new Response(aggrIndex, { headers: { "content-type": "text/html", ...NOCACHE } });
      }
      return new Response("not found", { status: 404 });
    }
    if (p === "/" || p === "/index.html") {
      return new Response(Bun.file(INDEX), { headers: { "content-type": "text/html" } });
    }
    if (p === "/api/candles") {
      const tf = Number(url.searchParams.get("tf") || 60);
      if (!tf || tf <= 60) {
        // sub-minute / 1m: serve the always-warm 1m cache
        return Response.json(candlesCache, { headers: CORS });
      }
      try {
        return Response.json(await candlesForTf(tf), { headers: CORS });
      } catch (e) {
        return Response.json(candlesCache, { headers: CORS });
      }
    }
    if (p === "/api/debug") {
      console.log(`[debug] ${url.search}`);
      return new Response("ok", { headers: CORS });
    }
    if (p.startsWith("/api/sub/") || p.startsWith("/api/burn/") || p === "/paywall.js" || p === "/plan.json") {
      try {
        const r = await fetch(SUBS_URL + p + url.search, {
          method: req.method,
          headers: { "content-type": req.headers.get("content-type") ?? "application/json" },
          body: req.method === "POST" ? await req.text() : undefined,
          signal: AbortSignal.timeout(30000),
        });
        const h = new Headers(r.headers);
        h.set("access-control-allow-origin", "*");
        return new Response(await r.arrayBuffer(), { status: r.status, headers: h });
      } catch (e) {
        return Response.json({ enabled: false, subscribed: false, error: "billing sidecar unavailable" }, { headers: CORS });
      }
    }
    if (p === "/api/watch" && req.method === "POST") {
      let body: any;
      try { body = await req.json(); } catch { return Response.json({ error: "bad json" }, { status: 400, headers: CORS }); }
      const mint = String(body?.mint ?? "").trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
        return Response.json({ error: "not a valid solana mint" }, { status: 400, headers: CORS });
      }
      if (mint !== MINT) {
        // verify birdeye knows it before committing
        try {
          const ov = (await be(`/defi/token_overview?address=${mint}`)).data;
          if (!ov?.symbol && !ov?.price) throw new Error("no data");
          switchMint(mint, ov);
        } catch (e) {
          return Response.json({ error: `birdeye has no data for that mint (${e})` }, { status: 422, headers: CORS });
        }
      }
      return Response.json({ ok: true, mint: MINT, symbol: overview?.symbol ?? "" }, { headers: CORS });
    }
    if (p === "/api/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 2) return Response.json({ items: [] }, { headers: CORS });
      try {
        const r = await be(
          `/defi/v3/search?keyword=${encodeURIComponent(q)}&target=token&sort_by=liquidity&sort_type=desc&offset=0&limit=12`,
        );
        const toks = (r?.data?.items ?? []).flatMap((g) => g.result ?? []);
        const items = toks
          .filter((t) => t.address && t.symbol)
          .map((t) => ({
            symbol: t.symbol, name: t.name, address: t.address,
            mcap: t.market_cap ?? t.fdv ?? 0,
            liquidity: t.liquidity ?? 0, price: t.price ?? 0,
            volume24h: t.volume_24h_usd ?? 0,
            priceChange24h: t.price_change_24h_percent ?? 0, logo: t.logo_uri ?? "",
          }));
        return Response.json({ items }, { headers: CORS });
      } catch (e) {
        return Response.json({ items: [], error: String(e) }, { headers: CORS });
      }
    }
    if (p === "/api/products") {
      // defi labels for the aggr client: one "market" per DEX source
      const products = [...new Set([...KNOWN_SOURCES, ...seenSources])].map(srcToPair).sort();
      return Response.json(
        { mint: MINT, symbol: overview?.symbol ?? "", products },
        { headers: CORS },
      );
    }
    if (p === "/api/bootstrap") {
      const trades = db.query("SELECT * FROM trades ORDER BY block_time DESC LIMIT 150").all();
      const liq = db.query("SELECT * FROM liq_events ORDER BY block_time DESC LIMIT 100").all();
      return Response.json(
        { mint: MINT, overview, trades, liq, boards: leaderboard(), flow: flowStats(), holders: holdersCache, mode },
        { headers: CORS },
      );
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      ws.subscribe("feed");
      console.log(`[ws] open: ${(ws.data as any)?.tag}`);
    },
    message() {},
    close(ws, code, reason) {
      console.log(`[ws] close(${code} ${reason || ""}): ${(ws.data as any)?.tag}`);
    },
  },
});

// ---------- runtime mint switch ----------
function switchMint(mint: string, ov: any) {
  console.log(`[watch] switching ${MINT} -> ${mint} (${ov?.symbol})`);
  MINT = mint;
  try { require("fs").writeFileSync(`${DATA_DIR}/current-mint`, mint); } catch {}

  // swap storage + reset all per-token state
  initDb(MINT);
  loadSeenSources();
  overview = ov;
  price = ov?.price ?? 0;
  candlesCache = { data: { items: [] } };
  holdersCache = [];
  mode = "starting";

  // drop the old birdeye stream; the new one subscribes to the new mint
  try { birdeyeWs?.close(); } catch {}
  birdeyeWs = null;
  tryBirdeyeWS();

  // warm caches right away
  pollCandles();
  pollHolders();
  pollTrades();
  pollLiq();

  // tell connected clients to start over
  publish({ type: "reset", data: { mint: MINT, symbol: ov?.symbol ?? "" } });
}

// ---------- boot ----------
tryBirdeyeWS();
await pollOverview();
await pollCandles();
await pollHolders();
pollTrades(); pollLiq();

setInterval(() => { if (mode !== "birdeye-ws") pollTrades(); }, 2000);
setInterval(pollLiq, 5000);
setInterval(pollOverview, 5000);
setInterval(pollCandles, 60000);
setInterval(pollHolders, 45000);
setInterval(() => publish({ type: "stats", data: { boards: leaderboard(), flow: flowStats() } }), 15000);

console.log(`token-watch up on http://localhost:${PORT} — mint ${MINT} (db: watch-${MINT.slice(0, 8)}.db, ingest mode pending: ${mode})`);
