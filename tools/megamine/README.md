# MEGAMINE — the million-voxel mine

Token-vs-token mining war composed on top of the
[uponly](https://github.com/BuildwithAnon/uponly) curve factory. Four factions,
each an uponly curve token. One 100×100×100 rock cube — **exactly 1,000,000
voxels** (the million-nft-homepage, extruded into 3D). Dig it out, strike veins,
pump your faction's floor.

Lineage, deliberately: **ORE v1** (per-dig proof-of-work grind) ×
**ORE v2 / Parley** (epoch rounds, seed-derived board, permissionless settle) ×
**megapixel** (million-cell occupancy bitmap, claim-what-you-touch) ×
**uponly** (ratchet curves as the faction economy).

## Why uponly makes this work

The whole game is built from three verbs, and *every one of them* is
floor-accretive to a faction's curve — that's the composition thesis:

| game verb | on-chain reality | curve effect |
|---|---|---|
| **buy in** | `Buy` on the faction's uponly curve | vault ↑, price ↑, NAV floor ↑ |
| **dig** | plain SPL `Burn` of faction tokens (permissionless — the mint is a normal SPL mint, holders can always burn their own) | supply ↓ → **NAV per token ↑ for every remaining holder** |
| **strike a vein** | 50% SOL to the digger, 50% transferred to the faction's curve PDA — uponly counts *any* lamports on the PDA as backing (`backing()` = PDA lamports − rent, "anyone may pump the floor", program/src/lib.rs:200) | vault ↑ with **zero** supply ↑ → pure floor pump |

So the faction scoreboard isn't kills or territory — it's **NAV**. A faction
that digs hard deflates its own supply; a faction that strikes veins gets its
floor donated up. uponly gives the "numba" a hard floor and this game gives the
flow-financed ratchet the thing it's otherwise missing: a *reason* for flow.

## The game

- **World:** 100³ voxels, all rock at genesis. A voxel is diggable when exposed
  (on the cube's surface, or adjacent to an already-dug voxel). Tunnels only —
  no teleport mining. Dug voxels are permanently claimed in faction color.
- **Crowd-funded frontier:** the map account starts at one 10 KB slab and
  digging works immediately within the surveyed region; `GrowMine` is
  permissionless, so *anyone* can pay rent for the next slab. The mine only
  extends as far as someone paid to survey it — launch needs ~2 SOL, not ~9,
  and the pot/dev split can buy the frontier back over time.
- **PoW (ORE v1 nod):** each dig requires grinding a nonce client-side until
  `hash(player:voxel:roundSeed:nonce)` clears the difficulty target. Demo uses
  a fast JS mixer (cyrb53); the on-chain version uses keccak like ORE's drillx.
- **Dig cost:** burns 1 faction token + a small SOL fee that feeds the round pot.
- **Rounds (ORE v2 / Parley nod):** every round, vein positions are derived from
  `sha256(roundId ‖ prevSeed)` — no RNG oracle, verifiable by anyone. Deeper
  veins are richer (`reward ∝ depth from nearest face`). Unstruck veins vanish
  when the round rotates: the mine reshuffles.
- **Strike:** vein reward paid from the pot — half to the digger's wallet, half
  donated to the digger's faction curve PDA.

## Run the demo

```bash
cd tools/megamine && bun server.ts   # http://localhost:4700
```

Bun server + single-file three.js UI (house pattern: ansem-watch, megapixel).
Curve math is a **faithful BigInt port of uponly's `buy`/`sell`** — chunked
exponential advance, governor cap at `NAV/backing`, mint never below NAV+1bp,
full-exit floor payout — so the demo economics are exactly what mainnet would
do. Bot diggers keep all four factions moving so the mine is alive on load.
State is in-memory (restart = fresh mine); this is a game demo, not a ledger.

## Phase 2 — on-chain (BUILT, tests green — deploy parked on canonical uponly)

`program/` — raw solana-program single-file (uponly's own idiom), 139 KB .so.
**4/4 litesvm integration tests pass against the real uponly binary**
(`tests/fixtures/uponly.so`, built from BuildwithAnon source; the uponly
program id is randomized every test run — megamine takes it as an init
parameter, nothing is hardcoded to any deploy):

- `full_composition_flow` — house curve init via CPI (splitter lands as
  uponly creator, verified byte-for-byte), 1% creator fee streams to splitter
  on a real uponly Buy, PoW dig with NAV-normalized burn (±100 lamports),
  20/80 dig-fee split, voxel-taken + not-exposed + tunneling + bad-PoW
  rejections, sweep splits creator fees 50/50 pot/dev.
- `constitution_gates_registration` — 93.5%-governed curve registers; 10%
  degen curve and 5%-fee gouge curve are both refused a pickaxe.
- `vein_strike_pays_digger_and_floor` — strike pays half to the digger, half
  lands as lamports on the faction's uponly curve PDA (the floor pump).
- `rotate_reseeds_and_invalidates_pow` — early rotate refused, warp past the
  window rotates the seed, stale-seed PoW rejected, fresh grind digs.

```bash
cd program
~/.local/share/solana/install/releases/2.3.0/solana-release/bin/cargo-build-sbf --tools-version v1.53
cargo test --release
```

**Live on devnet** (dress rehearsal, `mini` feature = 50³ map for cheap rent):

| | address |
|---|---|
| megamine | `8ReVUwn2CGmeu7suQzjQ5yreWxPGQ3fnwktH8S1yKbMW` |
| uponly (test fixture deploy) | `AN6NdpTJyceDfH9eNLYvk6ttUHR3bvDWhvUs4JjWHTKQ` |
| mine map | `71xLkc3rDze1TQCj2gobw8Ln8G2Yk7icvd9S7Heognvi` |

`KEYPAIR=~/jjj.json bun devnet.ts` replays the whole flow: init + grows,
house curve via CPI (creator == splitter verified on-chain), 1 SOL uponly buy
(creator fee lands on splitter), keccak PoW grinds (~1 s at 2^16), three digs,
live vein strikes paying digger + floor.

**Mainnet deploy is parked** until the canonical uponly program ships:
run `./verify-uponly.sh <program-id>` against his deployment, then
`Initialize` (default build, 100³) with his program id. Architecture (same trust-elimination path as megapixel phase 2,
plus Parley's round idioms):

| account | seeds | role |
|---|---|---|
| `Mine` | `["mine"]` | **1 byte/voxel faction map** — 1 MB, one account (~7 SOL rent; megapixel's bitmap trick, widened to 255 faction slots) |
| `FactionLink` | `["faction", mint]` | binds a faction id to an uponly curve PDA (validated: PDA = `["curve", mint]` under the uponly program id) |
| `Round` | `["round", id]` | seed, phase window, pot lamports, struck count |
| `Pot` | `["pot"]` | vein prize pool |
| `Splitter` | `["splitter"]` | **`creator` of every house faction curve** — permissionless `sweep()` splits balance pot/dev by init-burned bps |
| `Digger` | `["digger", authority]` | faction, dig count, strike tally |

Instructions: `init_mine · register_faction · dig · rotate_round`.

**Faction registration is permissionless but constitutional.** Anyone can
register any uponly mint; `register_faction` deserializes the 115-byte curve
account and enforces `min_backing_bps ≥ 9350` and creator-fee caps — degen
curves don't get a pickaxe. Dig cost is **normalized by NAV, not token count**:
a dig burns a fixed lamport-value at NAV (`units = cost × supply / vault`), so
every faction destroys the same real backing per voxel regardless of its
price schedule.

**House factions self-fund the pot — and pay the dev.** uponly's `creator` can
be any pubkey and is paid by plain lamport transfer — so genesis faction curves
are initialized with `creator = Splitter PDA` (`["splitter"]`), which anyone
can `sweep()` to distribute by bps **burned in at `init_mine`**: 50% vein pot /
50% dev treasury. A fixed fee constant is not an admin key — nothing can
change, pause, or redirect it. Since uponly pays creator on both sides (1% of
every buy AND sell), the dev earns on all house-curve churn, including trading
that never touches the mine. Foreign factions keep their own creator (that's
their incentive to show up) and pay a 2–3× SOL dig fee tier instead.

**Dev revenue, complete list (all init-burned, no admin keys):**
1. Splitter share of house-curve creator fees (both sides, perpetual).
2. 20% of dig fees (80% to pot); foreign factions' higher tier included.
3. `VX x,y,z` cNFT mint fee (~0.001 SOL/voxel, 100% dev) — optional vanity,
   outside the flywheel entirely: megapixel's sell-the-pixels model.
4. Genesis position: the dev inits the house curves and buys at start price;
   NAV ∝ x^0.093 is brutally front-loaded, and the game exists to drive x.
Keep 1–2 modest — "every verb pumps the floor" is the pitch, and a fat skim
falsifies it. 3–4 don't touch the flywheel at all.

- `dig(idx, nonce)`: verify keccak PoW against `Round.seed`; check-and-set the
  voxel's 2-bit cell (atomic, on-chain — a taken voxel reverts, exactly like
  megapixel's `claim_region`); require one of the 6 neighbors dug or `idx` on
  the boundary; CPI `spl_token::burn` of the faction mint from the digger's
  ATA; transfer dig fee to the `Round` pot. Vein check: `keccak(seed ‖ idx)`
  below the vein threshold → payout split — lamports to digger, lamports to
  the **uponly curve PDA** (a bare system transfer; no uponly CPI needed, the
  vault reads its own balance).
- `rotate_round`: permissionless after the window (Parley's `Settle` idiom);
  next seed = `sha256(round_id ‖ prev_seed)` from a slothash mix-in.
- Optional flex: mint each dug voxel as a cNFT (`VX x,y,z`) via the megapixel
  machinery — mine PDA as tree delegate, coordinates derived from the claim,
  unforgeable off-rect leaves. The excavation becomes a collectible sculpture.

No admin keys anywhere in the loop: uponly has none, the mine bitmap is
append-only, rounds rotate permissionlessly. The only parameters are chosen at
`init_mine` and burned in.

## Honest footnote

uponly curves are flow-financed (see the DD in the session that built this):
price > NAV always, and the floor rises only from buyer overpayment + fees.
This game doesn't fix that — it *weaponizes* it. Dig burns are voluntary
supply destruction in exchange for vein EV, which is the same greater-fool
flow, just routed through a game loop that's actually fun. The one genuine
improvement: strike donations raise NAV with no supply issued, which is the
closest thing to "yield" a curve like this can have. Worst-case exit is still
bounded by the governor (−14.75% at the flagship 93.5%/3%/6% params), and that
bound is per-curve config — check `min_backing_bps` before you ape a faction.
