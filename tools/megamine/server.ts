// megamine — million-voxel mining war on uponly faction curves.
// Bun server: serves the UI, holds the 100^3 world, runs rounds/veins/bots,
// and simulates each faction's economy with a faithful BigInt port of
// uponly's on-chain buy/sell math (program/src/lib.rs).
import { createHash } from "node:crypto";

const SIZE = 100;
const N = SIZE * SIZE * SIZE; // 1,000,000 voxels
const PORT = Number(process.env.PORT ?? 4700);
const ROUND_MS = Number(process.env.ROUND_MS ?? 4 * 60_000);
const VEINS_PER_ROUND = Number(process.env.VEINS ?? 16_384); // ~1 strike per 61 digs
const DIFF_BITS = Number(process.env.DIFF_BITS ?? 20); // pow: hash < 2^53 / 2^DIFF_BITS
const POW_TARGET = 2 ** 53 / 2 ** DIFF_BITS;
const DIG_TOKENS = 1_000_000_000n; // 1 faction token burned per voxel
const DIG_FEE = 500_000n; // 0.0005 SOL to the round pot per dig
const ROUND_SEED_POT = 5_000_000_000n; // 5 SOL house seed per round (demo)
const VEIN_BASE = 50_000_000n; // 0.05 SOL, scaled up with depth
const JOIN_SOL = 10_000_000_000n; // 10 demo SOL per player
const dir = new URL(".", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// uponly curve math — BigInt port of program/src/lib.rs buy/sell, verbatim
// semantics: chunked exponential advance, governor cap at NAV/backing,
// mint never below NAV+1bp, sells at NAV with floor share retained.
// ---------------------------------------------------------------------------
const FP = 1_000_000_000n;
const E18 = 10n ** 18n;
const LN2_FP = 693_147_181n;
const CHUNK_DIV = 32n;
const MAX_BUY_DOUBLINGS = 8n;

type Curve = {
  priceFp: bigint; doubleVol: bigint; vault: bigint; supply: bigint; cumVol: bigint;
  buyFeeCreatorBps: bigint; buyFeeFloorBps: bigint;
  sellFeeCreatorBps: bigint; sellFeeFloorBps: bigint;
  minBackingBps: bigint; creatorEarned: bigint;
};

const navFp = (c: Curve) => (c.supply > 0n ? (c.vault * E18) / c.supply : 0n);

function curveBuy(c: Curve, lamports: bigint): bigint {
  const creatorFee = (lamports * c.buyFeeCreatorBps) / 10_000n;
  const donation = (lamports * c.buyFeeFloorBps) / 10_000n;
  const net = lamports - creatorFee - donation;
  if (net <= 0n) throw new Error("zero buy");
  const d = c.doubleVol;
  if (net > MAX_BUY_DOUBLINGS * d) throw new Error("buy too large — split it");
  const chunk = d / CHUNK_DIV > 0n ? d / CHUNK_DIV : 1n;
  const s0 = c.supply;
  let remaining = net, vRun = c.vault + donation, p = c.priceFp, out = 0n;
  while (remaining > 0n) {
    const cc = remaining < chunk ? remaining : chunk;
    const p0 = p;
    p += (p * ((LN2_FP * cc) / d)) / FP;
    const sRun = s0 + out;
    let pe: bigint;
    if (sRun > 0n) {
      const nav = (vRun * E18) / sRun;
      if (c.minBackingBps > 0n) {
        const cap = (nav * 10_000n) / c.minBackingBps;
        if (p > cap) p = cap;
        if (p < p0) p = p0; // price never goes down
      }
      pe = (p0 + p) / 2n;
      if (pe <= nav) pe = nav + nav / 10_000n + 1n;
    } else {
      pe = (p0 + p) / 2n;
    }
    out += (cc * E18) / pe;
    vRun += cc;
    remaining -= cc;
  }
  c.priceFp = p;
  c.cumVol += net;
  c.vault += net + donation;
  c.creatorEarned += creatorFee;
  c.supply += out;
  return out;
}

function curveSell(c: Curve, units: bigint): bigint {
  if (units <= 0n || units > c.supply) throw new Error("bad sell size");
  const gross = (units * c.vault) / c.supply;
  const creatorFee = (gross * c.sellFeeCreatorBps) / 10_000n;
  // full exit pays the floor share out — supply==0 must imply vault==0
  const floorKeep = units === c.supply ? 0n : (gross * c.sellFeeFloorBps) / 10_000n;
  const toSeller = gross - creatorFee - floorKeep;
  c.vault -= toSeller + creatorFee;
  c.supply -= units;
  c.creatorEarned += creatorFee;
  return toSeller;
}

// game verbs the program doesn't need to know about:
const curveBurn = (c: Curve, units: bigint) => { c.supply -= units; }; // SPL burn
const curveDonate = (c: Curve, lamports: bigint) => { c.vault += lamports; }; // lamports to PDA

// ---------------------------------------------------------------------------
// Factions — flagship uponly params (93.5% governor, 3% buy / 6% sell all-in)
// ---------------------------------------------------------------------------
function freshCurve(): Curve {
  return {
    priceFp: 10n ** 15n, // 0.001 SOL/token start
    doubleVol: 50_000_000_000n, // 2x per 50 SOL of net buys (demo-fast)
    vault: 0n, supply: 0n, cumVol: 0n,
    buyFeeCreatorBps: 100n, buyFeeFloorBps: 200n,
    sellFeeCreatorBps: 100n, sellFeeFloorBps: 500n,
    minBackingBps: 9_350n, creatorEarned: 0n,
  };
}

const FACTIONS = [
  { f: 1, name: "OBSIDIAN", color: "#a78bfa", curve: freshCurve() },
  { f: 2, name: "RUST", color: "#fb923c", curve: freshCurve() },
  { f: 3, name: "VERDIGRIS", color: "#34d399", curve: freshCurve() },
  { f: 4, name: "BONE", color: "#e7e5e4", curve: freshCurve() },
];
const faction = (f: number) => FACTIONS.find((x) => x.f === f);
// genesis: house buys 5 SOL into each curve so NAV/price exist on load
for (const F of FACTIONS) curveBuy(F.curve, 5_000_000_000n);

// ---------------------------------------------------------------------------
// World: Uint8Array — 0 rock, 1..4 dug-by-faction. Exposure set for dig rules.
// ---------------------------------------------------------------------------
const world = new Uint8Array(N);
const idxOf = (x: number, y: number, z: number) => x + y * SIZE + z * SIZE * SIZE;
const coordOf = (i: number) => [i % SIZE, Math.floor(i / SIZE) % SIZE, Math.floor(i / (SIZE * SIZE))];
const onBoundary = (x: number, y: number, z: number) =>
  x === 0 || y === 0 || z === 0 || x === SIZE - 1 || y === SIZE - 1 || z === SIZE - 1;
const depthOf = (x: number, y: number, z: number) =>
  Math.min(x, y, z, SIZE - 1 - x, SIZE - 1 - y, SIZE - 1 - z);

const exposed = new Set<number>(); // intact voxels currently diggable
for (let z = 0; z < SIZE; z++)
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      if (onBoundary(x, y, z)) exposed.add(idxOf(x, y, z));

const NEIGHBORS = [ [1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1] ];

// ---------------------------------------------------------------------------
// PoW — cyrb53: deterministic 53-bit mixer, identical impl in the web worker.
// (Demo stand-in for keccak/drillx; see README.)
// ---------------------------------------------------------------------------
function powHash(str: string): number {
  let h1 = 0xdeadbeef | 0, h2 = 0x41c6ce57 | 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0); // 53-bit
}

// ---------------------------------------------------------------------------
// Rounds & veins — seed chain sha256(id ‖ prevSeed), veins from sha256(seed:i)
// ---------------------------------------------------------------------------
const sha = (s: string) => createHash("sha256").update(s).digest();

type Round = { id: number; seed: string; endsAt: number; pot: bigint; struck: number; veins: Map<number, bigint> };
let round: Round;

function rollVeins(seed: string): Map<number, bigint> {
  const veins = new Map<number, bigint>();
  for (let i = 0; veins.size < VEINS_PER_ROUND && i < VEINS_PER_ROUND * 3; i++) {
    const h = sha(`${seed}:vein:${i}`);
    const x = h[0] % SIZE, y = h[1] % SIZE, z = h[2] % SIZE;
    const idx = idxOf(x, y, z);
    if (world[idx] !== 0 || veins.has(idx)) continue;
    const depth = depthOf(x, y, z); // 0..49 — deeper is richer
    veins.set(idx, VEIN_BASE * BigInt(10 + depth * 2) / 10n);
  }
  return veins;
}

function startRound(id: number, prevSeed: string) {
  const seed = sha(`${id}:${prevSeed}`).toString("hex").slice(0, 16);
  const carry = round?.pot ?? 0n; // unstruck value rolls forward
  round = { id, seed, endsAt: Date.now() + ROUND_MS, pot: carry + ROUND_SEED_POT, struck: 0, veins: rollVeins(seed) };
  pushEvent({ t: "round", id, seed, endsAt: round.endsAt, potSol: sol(round.pot) });
}

// ---------------------------------------------------------------------------
// Players & events
// ---------------------------------------------------------------------------
type Player = {
  id: string; name: string; f: number; sol: bigint;
  tokens: Record<number, bigint>; dug: number; strikes: number; struckSol: bigint; bot?: boolean;
};
const players = new Map<string, Player>();

let seq = 0;
const events: any[] = [];
function pushEvent(e: any) {
  e.seq = ++seq;
  events.push(e);
  if (events.length > 5_000) events.splice(0, 1_000);
}

const sol = (l: bigint) => Number(l) / 1e9;
const tok = (u: bigint) => Number(u) / 1e9;

function newPlayer(name: string, f: number, bot = false): Player {
  const id = (bot ? "bot-" : "") + crypto.randomUUID().slice(0, 8);
  const p: Player = { id, name: name.slice(0, 24), f, sol: bot ? JOIN_SOL * 5n : JOIN_SOL, tokens: { 1: 0n, 2: 0n, 3: 0n, 4: 0n }, dug: 0, strikes: 0, struckSol: 0n, bot };
  players.set(id, p);
  return p;
}

// ---------------------------------------------------------------------------
// Dig — the composed verb: burn tokens (NAV/token up) + fee to pot; on a vein
// strike, half to digger, half DONATED to the faction curve (floor pump).
// ---------------------------------------------------------------------------
function digAt(p: Player, idx: number): { strike?: number } {
  if (idx < 0 || idx >= N || world[idx] !== 0) throw new Error("voxel not intact");
  if (!exposed.has(idx)) throw new Error("voxel not exposed — tunnel to it");
  const F = faction(p.f)!;
  if (p.tokens[p.f] < DIG_TOKENS) throw new Error(`need ${tok(DIG_TOKENS)} ${F.name} token to dig — buy in`);
  if (p.sol < DIG_FEE) throw new Error("out of SOL for the dig fee");

  p.tokens[p.f] -= DIG_TOKENS;
  curveBurn(F.curve, DIG_TOKENS); // supply down, NAV/token up for the faction
  p.sol -= DIG_FEE;
  round.pot += DIG_FEE;

  world[idx] = p.f;
  exposed.delete(idx);
  const [x, y, z] = coordOf(idx);
  for (const [dx, dy, dz] of NEIGHBORS) {
    const nx = x + dx, ny = y + dy, nz = z + dz;
    if (nx < 0 || ny < 0 || nz < 0 || nx >= SIZE || ny >= SIZE || nz >= SIZE) continue;
    const ni = idxOf(nx, ny, nz);
    if (world[ni] === 0) exposed.add(ni);
  }
  p.dug++;
  pushEvent({ t: "dig", idx, f: p.f });

  const vein = round.veins.get(idx);
  if (vein !== undefined) {
    round.veins.delete(idx);
    round.struck++;
    const reward = vein < round.pot ? vein : round.pot;
    round.pot -= reward;
    const toDigger = reward / 2n;
    p.sol += toDigger;
    p.strikes++;
    p.struckSol += toDigger;
    curveDonate(F.curve, reward - toDigger); // lamports straight onto the curve PDA
    pushEvent({ t: "strike", idx, f: p.f, by: p.name, sol: sol(reward), depth: depthOf(x, y, z) });
    return { strike: Number(reward) };
  }
  return {};
}

// ---------------------------------------------------------------------------
// Bots — two per faction so the mine is alive on load; they play by the same
// economy (buy on the curve, burn to dig, pay the fee), just skip the PoW.
// ---------------------------------------------------------------------------
const botNames = ["drillbert", "shaftboss", "seamus", "pickle", "borehild", "dustin", "cavey", "veins mcgee"];
const bots: Player[] = FACTIONS.flatMap((F, i) =>
  [0, 1].map((j) => newPlayer(botNames[i * 2 + j], F.f, true)),
);

function botTick() {
  const b = bots[Math.floor(Math.random() * bots.length)];
  try {
    if (b.tokens[b.f] < DIG_TOKENS) {
      if (b.sol < 1_000_000_000n) return; // broke bot retires
      b.sol -= 1_000_000_000n;
      b.tokens[b.f] += curveBuy(faction(b.f)!.curve, 1_000_000_000n);
      pushEvent({ t: "buy", f: b.f, by: b.name, sol: 1 });
      return;
    }
    // dig a random exposed voxel, biased toward ones its faction already touched
    const pool = [...exposed];
    if (!pool.length) return;
    let pick = pool[Math.floor(Math.random() * pool.length)];
    for (let tries = 0; tries < 6; tries++) {
      const cand = pool[Math.floor(Math.random() * pool.length)];
      const [x, y, z] = coordOf(cand);
      const nearOwn = NEIGHBORS.some(([dx, dy, dz]) => {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        return nx >= 0 && ny >= 0 && nz >= 0 && nx < SIZE && ny < SIZE && nz < SIZE && world[idxOf(nx, ny, nz)] === b.f;
      });
      if (nearOwn) { pick = cand; break; }
    }
    digAt(b, pick);
  } catch { /* bot swallowed an economic reality; carry on */ }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------
function factionState(F: (typeof FACTIONS)[number]) {
  const c = F.curve;
  const nav = navFp(c);
  const backing = c.priceFp > 0n ? Number((nav * 10_000n) / c.priceFp) / 100 : 0;
  return {
    f: F.f, name: F.name, color: F.color,
    priceSol: Number(c.priceFp) / 1e18,
    navSol: Number(nav) / 1e18,
    backingPct: Math.min(backing, 100),
    vaultSol: sol(c.vault),
    supplyTokens: tok(c.supply),
    creatorSol: sol(c.creatorEarned),
    cumVolSol: sol(c.cumVol),
    dug: dugCount[F.f],
  };
}
const dugCount: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };

function stateJson() {
  return {
    size: SIZE, diffBits: DIFF_BITS, digTokens: tok(DIG_TOKENS), digFeeSol: sol(DIG_FEE),
    round: { id: round.id, seed: round.seed, endsAt: round.endsAt, potSol: sol(round.pot), veins: round.veins.size, struck: round.struck },
    factions: FACTIONS.map(factionState),
    leaderboard: [...players.values()]
      .sort((a, b) => Number(b.struckSol - a.struckSol) || b.dug - a.dug)
      .slice(0, 10)
      .map((p) => ({ name: p.name, f: p.f, dug: p.dug, strikes: p.strikes, struckSol: sol(p.struckSol), bot: !!p.bot })),
    seq,
  };
}

const meJson = (p: Player) => ({
  id: p.id, name: p.name, f: p.f, sol: sol(p.sol),
  tokens: Object.fromEntries(Object.entries(p.tokens).map(([k, v]) => [k, tok(v)])),
  dug: p.dug, strikes: p.strikes, struckSol: sol(p.struckSol),
});

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

startRound(1, "genesis");
setInterval(() => { if (Date.now() >= round.endsAt) startRound(round.id + 1, round.seed); }, 1_000);
setInterval(botTick, 900);
// recount territory lazily (dug counters drive the HUD bars)
setInterval(() => {
  const c: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (let i = 0; i < N; i++) if (world[i] !== 0) c[world[i]]++;
  Object.assign(dugCount, c);
}, 5_000);

// ---- mainnet activity: distinct diggers + vein strikes in the last 5 min ----
const MEG_RPC = process.env.RPC ?? "https://mainnet.helius-rpc.com/?api-key=6d653217-043c-447e-b1aa-f9fb77525270";
const MEG_ID = "BWduMhsy2Z1ptkL2Pjjb6727zDVxMaFSqbmhuQ6Lmgeq";
let activity = { diggers: 0, veins: 0, digs: 0, updated: 0 };
async function megRpc(method: string, params: any) {
  const r = await fetch(MEG_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await r.json()).result;
}
async function pollActivity() {
  const now = Math.floor(Date.now() / 1000);
  const sigs = await megRpc("getSignaturesForAddress", [MEG_ID, { limit: 250 }]);
  const recent = (sigs || []).filter((s: any) => !s.err && s.blockTime && s.blockTime >= now - 300).slice(0, 150);
  const diggers = new Set<string>(); let veins = 0, digs = 0;
  const byTeam: Record<number, { digs: number; veins: number }> = {};
  const bump = (t: number, k: "digs" | "veins") => { (byTeam[t] ??= { digs: 0, veins: 0 })[k]++; };
  for (let i = 0; i < recent.length; i += 20) {
    const txs = await Promise.all(recent.slice(i, i + 20).map((s: any) =>
      megRpc("getTransaction", [s.signature, { maxSupportedTransactionVersion: 0, encoding: "json" }]).catch(() => null)));
    for (const tx of txs) {
      const logs = ((tx?.meta?.logMessages) || []).join(" ");
      const c = logs.match(/megamine: commit idx=\d+ faction=(\d+)/);
      if (c) { digs++; bump(+c[1], "digs"); const k = tx?.transaction?.message?.accountKeys?.[0]; if (k) diggers.add(k); }
      const v = logs.match(/megamine: STRIKE idx=\d+ faction=(\d+)/);
      if (v) { veins++; bump(+v[1], "veins"); }
    }
  }
  activity = { diggers: diggers.size, veins, digs, teams: Object.keys(byTeam).length, byTeam, updated: now };
}
setInterval(() => pollActivity().catch(() => {}), 25_000);
pollActivity().catch(() => {});

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/api/activity") return json(activity);

    if (path === "/" || path === "/chain") return new Response(Bun.file(dir + "chain.html"), { headers: { "content-type": "text/html", "cache-control": "no-store" } });
    if (path === "/sim") return new Response(Bun.file(dir + "index.html"));
    if (path === "/state") return json(stateJson());
    if (path === "/world")
      return new Response(world, { headers: { "content-type": "application/octet-stream" } });

    if (path === "/delta") {
      const since = Number(url.searchParams.get("since") ?? 0);
      return json({ seq, events: events.filter((e) => e.seq > since).slice(-500) });
    }

    if (path === "/me") {
      const p = players.get(url.searchParams.get("id") ?? "");
      return p ? json(meJson(p)) : bad("unknown player", 404);
    }

    if (req.method !== "POST") return bad("nope", 405);
    let body: any;
    try { body = await req.json(); } catch { return bad("bad json"); }

    try {
      if (path === "/join") {
        const f = Number(body.faction);
        if (!faction(f)) return bad("faction must be 1..4");
        if (!body.name || typeof body.name !== "string") return bad("name required");
        const p = newPlayer(body.name, f);
        pushEvent({ t: "join", f, by: p.name });
        return json(meJson(p));
      }

      const p = players.get(body.id ?? "");
      if (!p) return bad("unknown player — join first", 401);

      if (path === "/buy") {
        const f = Number(body.faction ?? p.f);
        const F = faction(f);
        if (!F) return bad("bad faction");
        const lamports = BigInt(Math.round(Number(body.sol) * 1e9));
        if (!(lamports > 0n) || lamports > p.sol) return bad("bad size / insufficient SOL");
        p.sol -= lamports;
        p.tokens[f] += curveBuy(F.curve, lamports);
        pushEvent({ t: "buy", f, by: p.name, sol: sol(lamports) });
        return json(meJson(p));
      }

      if (path === "/sell") {
        const f = Number(body.faction ?? p.f);
        const F = faction(f);
        if (!F) return bad("bad faction");
        const units = BigInt(Math.round(Number(body.tokens) * 1e9));
        if (!(units > 0n) || units > p.tokens[f]) return bad("bad size / insufficient tokens");
        p.tokens[f] -= units;
        p.sol += curveSell(F.curve, units);
        pushEvent({ t: "sell", f, by: p.name, tokens: tok(units) });
        return json(meJson(p));
      }

      if (path === "/dig") {
        const idx = Number(body.idx);
        const nonce = String(body.nonce ?? "");
        const h = powHash(`${p.id}:${idx}:${round.seed}:${nonce}`);
        if (h >= POW_TARGET) return bad("pow does not clear the target — grind harder");
        const r = digAt(p, idx);
        return json({ ...meJson(p), strike: r.strike ? r.strike / 1e9 : undefined });
      }
    } catch (e: any) {
      return bad(e?.message ?? "error");
    }
    return bad("not found", 404);
  },
});

console.log(`megamine ⛏  http://localhost:${PORT}  (${N.toLocaleString()} voxels, round ${ROUND_MS / 60000}m, pow 2^${DIFF_BITS})`);
