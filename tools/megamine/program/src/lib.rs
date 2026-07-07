//! MEGAMINE — million-voxel mining war composed on uponly curves.
//!
//! * WORLD: 100^3 voxels in one 1 MB program account (`["mine"]`), one byte
//!   per voxel: 0 = rock, 1..=255 = dug by faction id. Grown to full size via
//!   permissionless `GrowMine` calls (10 KB realloc cap per instruction —
//!   megapixel's grow_board pattern).
//! * FACTIONS: any uponly curve mint, registered permissionlessly — but
//!   constitutional: `RegisterFaction` deserializes the 115-byte Curve account
//!   and rejects curves under the backing floor or over the fee caps.
//! * DIG: keccak PoW against the round seed, then burn a fixed *NAV-value* of
//!   faction tokens (units = value * supply / vault) — every faction destroys
//!   the same real backing per voxel regardless of its price schedule. Dig
//!   SOL fee splits pot/dev by init-burned bps; foreign factions (curve
//!   creator != splitter) pay `foreign_fee_mult` times the house tier.
//! * VEIN: keccak(seed, idx) under a threshold — stateless, verifiable, no
//!   oracle. Reward scales with depth, paid half to the digger and half as a
//!   bare lamport donation to the faction's curve PDA (uponly counts any PDA
//!   lamports as backing — the floor pump needs no CPI).
//! * HOUSE CURVES: `InitHouseCurve` CPIs uponly's Initialize with the
//!   system-owned splitter PDA as signing creator, so both sides' creator
//!   fees stream to `["splitter"]`; permissionless `Sweep` splits its balance
//!   pot/dev by init-burned bps.
//! * NO ADMIN KEYS: every parameter (including the uponly program id this
//!   composes against) is fixed at `Initialize` and can never change.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    keccak,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
pub const CONFIG_SEED: &[u8] = b"config";
pub const MINE_SEED: &[u8] = b"mine";
pub const POT_SEED: &[u8] = b"pot";
pub const SPLITTER_SEED: &[u8] = b"splitter";
pub const FACTION_SEED: &[u8] = b"faction";
pub const UPONLY_CURVE_SEED: &[u8] = b"curve";
pub const COMMIT_SEED: &[u8] = b"commit";

#[cfg(not(feature = "mini"))]
pub const SIZE: usize = 100;
#[cfg(feature = "mini")]
pub const SIZE: usize = 50; // devnet dress-rehearsal build: 125 KB map, ~0.87 SOL rent
pub const MINE_SIZE: usize = SIZE * SIZE * SIZE; // 1,000,000 voxels, 1 byte each
pub const GROW_STEP: usize = 10_240; // MAX_PERMITTED_DATA_INCREASE
pub const CONFIG_SIZE: usize = 163;
pub const LINK_SIZE: usize = 66;
pub const UPONLY_CURVE_SIZE: usize = 147;
pub const COMMIT_SIZE: usize = 110; // digger + curve + seed + slot + idx + faction + bump

const TOKEN_PROGRAM: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const E_BAD_PARAMS: u32 = 1;
const E_BAD_PDA: u32 = 2;
const E_ALREADY_INIT: u32 = 3;
const E_MINE_NOT_GROWN: u32 = 4;
const E_UNCONSTITUTIONAL: u32 = 5;
const E_BAD_CURVE: u32 = 6;
const E_POW: u32 = 7;
const E_VOXEL_TAKEN: u32 = 8;
const E_NOT_EXPOSED: u32 = 9;
const E_ROUND_OVER: u32 = 10;
const E_ROUND_LIVE: u32 = 11;
const E_BAD_ACCOUNT: u32 = 12;
const E_OVERFLOW: u32 = 13;
const E_CURVE_EMPTY: u32 = 14;
const E_FACTIONS_FULL: u32 = 15;
const E_TOO_EARLY: u32 = 16; // reveal in the same slot as commit (or before it seals)

const fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Config {
    pub uponly_program: Pubkey,
    pub dev: Pubkey,
    pub dig_fee: u64,
    pub foreign_fee_mult: u8,
    pub dig_fee_dev_bps: u16,
    pub splitter_pot_bps: u16,
    pub dig_burn_value: u64,
    pub vein_threshold: u32, // strike probability = threshold / 2^32
    pub vein_base: u64,
    pub round_secs: u32,
    pub pow_bits: u8,
    pub min_backing_floor_bps: u16, // constitution
    pub max_creator_fee_bps: u16,   // constitution
    pub next_faction: u8,
    pub round_id: u64,
    pub round_seed: [u8; 32],
    pub round_end_ts: i64,
    pub mine_len: u32,
    pub bump: u8,
    pub mine_bump: u8,
    pub pot_bump: u8,
    pub splitter_bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct FactionLink {
    pub mint: Pubkey,
    pub curve: Pubkey,
    pub id: u8,
    pub bump: u8,
}

/// A dug voxel awaiting its vein roll. The cost (burn + fee) is already sunk at
/// commit; reveal resolves the vein against slot_hashes[commit_slot], which is
/// unknowable at commit time — so the outcome can't be precomputed, and commit
/// + reveal can't be atomically bundled-and-reverted (they must span slots).
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct Commit {
    pub digger: Pubkey,
    pub curve: Pubkey,
    pub round_seed: [u8; 32],
    pub commit_slot: u64,
    pub idx: u32,
    pub faction_id: u8,
    pub bump: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub enum MineInstruction {
    /// Burn every parameter. accounts: payer(s,w) config(w) mine(w) pot(r)
    /// splitter(r) uponly_program(r) dev(r) system(r)
    Initialize {
        dig_fee: u64,
        foreign_fee_mult: u8,
        dig_fee_dev_bps: u16,
        splitter_pot_bps: u16,
        dig_burn_value: u64,
        vein_threshold: u32,
        vein_base: u64,
        round_secs: u32,
        pow_bits: u8,
        min_backing_floor_bps: u16,
        max_creator_fee_bps: u16,
    },
    /// Permissionless +10KB realloc toward MINE_SIZE. accounts: payer(s,w)
    /// config(w) mine(w) system(r)
    GrowMine,
    /// CPI uponly Initialize with splitter as signing creator, then register
    /// the faction. accounts: payer(s,w) config(w) splitter(w) mint(r)
    /// curve(w) link(w) uponly_program(r) system(r)
    InitHouseCurve {
        start_price_fp: u128,
        double_vol: u64,
        buy_fee_creator_bps: u16,
        buy_fee_floor_bps: u16,
        sell_fee_creator_bps: u16,
        sell_fee_floor_bps: u16,
        min_backing_bps: u16,
    },
    /// Permissionless, constitutional. accounts: payer(s,w) config(w) mint(r)
    /// curve(r) link(w) system(r)
    RegisterFaction,
    /// Commit half of a dig: PoW, burn, fee, claim the voxel, and record a
    /// Commit — but do NOT roll the vein. accounts: digger(s,w) config(r)
    /// mine(w) link(r) mint(w) digger_ata(w) curve(w) pot(w) splitter(r)
    /// dev(w) token(r) system(r) commit(w)
    Commit { idx: u32, nonce: u64 },
    /// Permissionless after the window. accounts: config(w) slot_hashes(r)
    Rotate,
    /// Permissionless splitter payout. accounts: config(r) splitter(w) pot(w)
    /// dev(w) system(r)
    Sweep,
    /// Reveal half of a dig: resolve the vein against slot_hashes[commit_slot]
    /// (unknowable at commit), pay a strike, and close the commit (rent back to
    /// digger). Permissionless. accounts: cranker(s,w) config(r) commit(w)
    /// pot(w) curve(w) digger(w) slot_hashes(r) system(r)
    Reveal,
}

// ---------------------------------------------------------------------------
// uponly Curve mirror (byte offsets in the 115-byte account)
// ---------------------------------------------------------------------------
pub struct CurveView {
    pub buy_creator: Pubkey,
    pub sell_creator: Pubkey,
    pub buy_fee_creator_bps: u16,
    pub sell_fee_creator_bps: u16,
    pub min_backing_bps: u16,
}

pub fn parse_curve(data: &[u8]) -> Result<CurveView, ProgramError> {
    if data.len() != UPONLY_CURVE_SIZE {
        return Err(err(E_BAD_CURVE));
    }
    let u16at = |o: usize| u16::from_le_bytes(data[o..o + 2].try_into().unwrap());
    Ok(CurveView {
        buy_creator: Pubkey::new_from_array(data[32..64].try_into().unwrap()),
        sell_creator: Pubkey::new_from_array(data[64..96].try_into().unwrap()),
        buy_fee_creator_bps: u16at(120),
        sell_fee_creator_bps: u16at(124),
        min_backing_bps: u16at(128),
    })
}

// ---------------------------------------------------------------------------
// PDAs & helpers
// ---------------------------------------------------------------------------
pub fn config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[CONFIG_SEED], program_id)
}
pub fn mine_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[MINE_SEED], program_id)
}
pub fn pot_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POT_SEED], program_id)
}
pub fn splitter_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SPLITTER_SEED], program_id)
}
pub fn faction_pda(program_id: &Pubkey, mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[FACTION_SEED, mint.as_ref()], program_id)
}

pub fn coord(idx: usize) -> (usize, usize, usize) {
    (idx % SIZE, (idx / SIZE) % SIZE, idx / (SIZE * SIZE))
}
pub fn on_boundary(x: usize, y: usize, z: usize) -> bool {
    x == 0 || y == 0 || z == 0 || x == SIZE - 1 || y == SIZE - 1 || z == SIZE - 1
}
pub fn depth_of(x: usize, y: usize, z: usize) -> u64 {
    [x, y, z, SIZE - 1 - x, SIZE - 1 - y, SIZE - 1 - z]
        .into_iter()
        .min()
        .unwrap() as u64
}

/// PoW: keccak(digger ‖ idx ‖ round_seed ‖ nonce), first 8 bytes as u64,
/// must clear u64::MAX >> pow_bits.
pub fn pow_clears(digger: &Pubkey, idx: u32, seed: &[u8; 32], nonce: u64, bits: u8) -> bool {
    let h = keccak::hashv(&[
        digger.as_ref(),
        &idx.to_le_bytes(),
        seed,
        &nonce.to_le_bytes(),
    ]);
    u64::from_le_bytes(h.0[..8].try_into().unwrap()) <= (u64::MAX >> bits)
}

/// Vein: keccak("vein" ‖ round_seed ‖ idx ‖ commit_slothash), first 4 bytes as
/// u32 < threshold. The slot hash is unknowable at commit time, so the outcome
/// can't be precomputed off-chain nor bundled-and-reverted for free.
pub fn vein_hits(seed: &[u8; 32], idx: u32, slothash: &[u8], threshold: u32) -> bool {
    let h = keccak::hashv(&[b"vein", seed, &idx.to_le_bytes(), slothash]);
    u32::from_le_bytes(h.0[..4].try_into().unwrap()) < threshold
}

fn load_config(program_id: &Pubkey, ai: &AccountInfo) -> Result<Config, ProgramError> {
    if ai.owner != program_id {
        return Err(err(E_BAD_PDA));
    }
    let cfg = Config::try_from_slice(&ai.data.borrow())?;
    let expect =
        Pubkey::create_program_address(&[CONFIG_SEED, &[cfg.bump]], program_id).map_err(|_| err(E_BAD_PDA))?;
    if expect != *ai.key {
        return Err(err(E_BAD_PDA));
    }
    Ok(cfg)
}

fn store_config(cfg: &Config, ai: &AccountInfo) -> ProgramResult {
    cfg.serialize(&mut &mut ai.data.borrow_mut()[..])?;
    Ok(())
}

fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    pda: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    program_id: &Pubkey,
    size: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?.minimum_balance(size);
    invoke_signed(
        &system_instruction::create_account(payer.key, pda.key, rent, size as u64, program_id),
        &[payer.clone(), pda.clone(), system.clone()],
        &[seeds],
    )
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------
entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    match MineInstruction::try_from_slice(data)? {
        MineInstruction::Initialize {
            dig_fee,
            foreign_fee_mult,
            dig_fee_dev_bps,
            splitter_pot_bps,
            dig_burn_value,
            vein_threshold,
            vein_base,
            round_secs,
            pow_bits,
            min_backing_floor_bps,
            max_creator_fee_bps,
        } => initialize(
            program_id,
            accounts,
            Config {
                uponly_program: Pubkey::default(), // filled from accounts
                dev: Pubkey::default(),
                dig_fee,
                foreign_fee_mult,
                dig_fee_dev_bps,
                splitter_pot_bps,
                dig_burn_value,
                vein_threshold,
                vein_base,
                round_secs,
                pow_bits,
                min_backing_floor_bps,
                max_creator_fee_bps,
                next_faction: 1,
                round_id: 1,
                round_seed: [0; 32],
                round_end_ts: 0,
                mine_len: 0,
                bump: 0,
                mine_bump: 0,
                pot_bump: 0,
                splitter_bump: 0,
            },
        ),
        MineInstruction::GrowMine => grow_mine(program_id, accounts),
        MineInstruction::InitHouseCurve {
            start_price_fp,
            double_vol,
            buy_fee_creator_bps,
            buy_fee_floor_bps,
            sell_fee_creator_bps,
            sell_fee_floor_bps,
            min_backing_bps,
        } => init_house_curve(
            program_id,
            accounts,
            start_price_fp,
            double_vol,
            buy_fee_creator_bps,
            buy_fee_floor_bps,
            sell_fee_creator_bps,
            sell_fee_floor_bps,
            min_backing_bps,
        ),
        MineInstruction::RegisterFaction => register_faction(program_id, accounts),
        MineInstruction::Commit { idx, nonce } => commit(program_id, accounts, idx, nonce),
        MineInstruction::Rotate => rotate(program_id, accounts),
        MineInstruction::Sweep => sweep(program_id, accounts),
        MineInstruction::Reveal => reveal(program_id, accounts),
    }
}

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], mut cfg: Config) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let mine_ai = next_account_info(ai)?;
    let pot_ai = next_account_info(ai)?;
    let splitter_ai = next_account_info(ai)?;
    let uponly_ai = next_account_info(ai)?;
    let dev_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *system_ai.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !uponly_ai.executable {
        return Err(err(E_BAD_PARAMS)); // must compose against a real program
    }
    if cfg.dig_fee_dev_bps > 10_000
        || cfg.splitter_pot_bps > 10_000
        || cfg.foreign_fee_mult == 0
        || cfg.pow_bits > 40
        || cfg.round_secs == 0
        || cfg.dig_burn_value == 0
        || cfg.min_backing_floor_bps == 0
    {
        return Err(err(E_BAD_PARAMS));
    }

    let (config_key, bump) = config_pda(program_id);
    let (mine_key, mine_bump) = mine_pda(program_id);
    let (pot_key, pot_bump) = pot_pda(program_id);
    let (splitter_key, splitter_bump) = splitter_pda(program_id);
    if config_key != *config_ai.key
        || mine_key != *mine_ai.key
        || pot_key != *pot_ai.key
        || splitter_key != *splitter_ai.key
    {
        return Err(err(E_BAD_PDA));
    }
    if config_ai.owner == program_id || !config_ai.data_is_empty() {
        return Err(err(E_ALREADY_INIT));
    }

    create_pda_account(payer, config_ai, system_ai, program_id, CONFIG_SIZE, &[CONFIG_SEED, &[bump]])?;
    let first = GROW_STEP.min(MINE_SIZE);
    create_pda_account(payer, mine_ai, system_ai, program_id, first, &[MINE_SEED, &[mine_bump]])?;
    // pot & splitter stay SYSTEM-owned zero-data PDAs: uponly can pay the
    // splitter (system transfer on buys needs no data), and we debit both via
    // system-transfer CPIs signed with their seeds. Fund to rent-exempt zero.
    let zero_rent = Rent::get()?.minimum_balance(0);
    for (pda, seeds_key) in [(pot_ai, pot_key), (splitter_ai, splitter_key)] {
        let _ = seeds_key;
        if pda.lamports() < zero_rent {
            invoke(
                &system_instruction::transfer(payer.key, pda.key, zero_rent - pda.lamports()),
                &[payer.clone(), pda.clone(), system_ai.clone()],
            )?;
        }
    }

    let clock = Clock::get()?;
    cfg.uponly_program = *uponly_ai.key;
    cfg.dev = *dev_ai.key;
    cfg.round_seed = keccak::hashv(&[b"genesis", &clock.slot.to_le_bytes()]).0;
    cfg.round_end_ts = clock
        .unix_timestamp
        .checked_add(cfg.round_secs as i64)
        .ok_or(err(E_OVERFLOW))?;
    cfg.mine_len = first as u32;
    cfg.bump = bump;
    cfg.mine_bump = mine_bump;
    cfg.pot_bump = pot_bump;
    cfg.splitter_bump = splitter_bump;
    store_config(&cfg, config_ai)?;
    msg!("megamine: init uponly={} dev={} mine {}B/{}", uponly_ai.key, dev_ai.key, first, MINE_SIZE);
    Ok(())
}

// ---------------------------------------------------------------------------
// GrowMine — permissionless realloc toward MINE_SIZE
// ---------------------------------------------------------------------------
fn grow_mine(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let mine_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut cfg = load_config(program_id, config_ai)?;
    if mine_ai.owner != program_id
        || *mine_ai.key
            != Pubkey::create_program_address(&[MINE_SEED, &[cfg.mine_bump]], program_id)
                .map_err(|_| err(E_BAD_PDA))?
    {
        return Err(err(E_BAD_PDA));
    }
    let cur = mine_ai.data_len();
    if cur >= MINE_SIZE {
        return Err(err(E_ALREADY_INIT));
    }
    let new_len = (cur + GROW_STEP).min(MINE_SIZE);
    let need = Rent::get()?.minimum_balance(new_len);
    if mine_ai.lamports() < need {
        invoke(
            &system_instruction::transfer(payer.key, mine_ai.key, need - mine_ai.lamports()),
            &[payer.clone(), mine_ai.clone(), system_ai.clone()],
        )?;
    }
    mine_ai.realloc(new_len, true)?;
    cfg.mine_len = new_len as u32;
    store_config(&cfg, config_ai)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// InitHouseCurve — CPI uponly Initialize with splitter as signing creator
// ---------------------------------------------------------------------------
#[derive(BorshSerialize)]
enum UponlyInstruction {
    Initialize {
        buy_creator: Pubkey,
        sell_creator: Pubkey,
        start_price_fp: u128,
        double_vol: u64,
        buy_fee_creator_bps: u16,
        buy_fee_floor_bps: u16,
        sell_fee_creator_bps: u16,
        sell_fee_floor_bps: u16,
        min_backing_bps: u16,
    },
}

#[allow(clippy::too_many_arguments)]
fn init_house_curve(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    start_price_fp: u128,
    double_vol: u64,
    buy_fee_creator_bps: u16,
    buy_fee_floor_bps: u16,
    sell_fee_creator_bps: u16,
    sell_fee_floor_bps: u16,
    min_backing_bps: u16,
) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let splitter_ai = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let curve_ai = next_account_info(ai)?;
    let link_ai = next_account_info(ai)?;
    let uponly_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut cfg = load_config(program_id, config_ai)?;
    if *uponly_ai.key != cfg.uponly_program {
        return Err(err(E_BAD_ACCOUNT));
    }
    // house curves must themselves be constitutional
    if min_backing_bps < cfg.min_backing_floor_bps
        || buy_fee_creator_bps > cfg.max_creator_fee_bps
        || sell_fee_creator_bps > cfg.max_creator_fee_bps
    {
        return Err(err(E_UNCONSTITUTIONAL));
    }

    let splitter_key = Pubkey::create_program_address(&[SPLITTER_SEED, &[cfg.splitter_bump]], program_id)
        .map_err(|_| err(E_BAD_PDA))?;
    if *splitter_ai.key != splitter_key {
        return Err(err(E_BAD_PDA));
    }
    let data = borsh::to_vec(&UponlyInstruction::Initialize {
        buy_creator: splitter_key,
        sell_creator: splitter_key,
        start_price_fp,
        double_vol,
        buy_fee_creator_bps,
        buy_fee_floor_bps,
        sell_fee_creator_bps,
        sell_fee_floor_bps,
        min_backing_bps,
    })?;
    invoke(
        &Instruction {
            program_id: cfg.uponly_program,
            accounts: vec![
                AccountMeta::new(*payer.key, true), // payer funds curve rent; creators are args
                AccountMeta::new(*curve_ai.key, false),
                AccountMeta::new_readonly(*mint_ai.key, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            data,
        },
        &[payer.clone(), curve_ai.clone(), mint_ai.clone(), system_ai.clone(), uponly_ai.clone()],
    )?;

    create_link(program_id, payer, link_ai, system_ai, mint_ai.key, curve_ai.key, &mut cfg)?;
    store_config(&cfg, config_ai)?;
    msg!("megamine: house faction {} mint={} curve={}", cfg.next_faction - 1, mint_ai.key, curve_ai.key);
    Ok(())
}

// ---------------------------------------------------------------------------
// RegisterFaction — permissionless, constitutional
// ---------------------------------------------------------------------------
fn register_faction(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let payer = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let curve_ai = next_account_info(ai)?;
    let link_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let mut cfg = load_config(program_id, config_ai)?;

    // the curve must be a real uponly curve for this mint
    if curve_ai.owner != &cfg.uponly_program {
        return Err(err(E_BAD_CURVE));
    }
    let curve = parse_curve(&curve_ai.data.borrow())?;
    let bump = curve_ai.data.borrow()[146];
    let expect = Pubkey::create_program_address(
        &[UPONLY_CURVE_SEED, mint_ai.key.as_ref(), &[bump]],
        &cfg.uponly_program,
    )
    .map_err(|_| err(E_BAD_CURVE))?;
    if expect != *curve_ai.key {
        return Err(err(E_BAD_CURVE));
    }
    // constitution: governed above the floor, creator fees within the cap
    if curve.min_backing_bps < cfg.min_backing_floor_bps
        || curve.buy_fee_creator_bps > cfg.max_creator_fee_bps
        || curve.sell_fee_creator_bps > cfg.max_creator_fee_bps
    {
        return Err(err(E_UNCONSTITUTIONAL));
    }

    create_link(program_id, payer, link_ai, system_ai, mint_ai.key, curve_ai.key, &mut cfg)?;
    store_config(&cfg, config_ai)?;
    msg!("megamine: faction {} registered mint={}", cfg.next_faction - 1, mint_ai.key);
    Ok(())
}

fn create_link<'a>(
    program_id: &Pubkey,
    payer: &AccountInfo<'a>,
    link_ai: &AccountInfo<'a>,
    system_ai: &AccountInfo<'a>,
    mint: &Pubkey,
    curve: &Pubkey,
    cfg: &mut Config,
) -> ProgramResult {
    if cfg.next_faction == 0 {
        return Err(err(E_FACTIONS_FULL)); // wrapped past 255
    }
    let (link_key, link_bump) = faction_pda(program_id, mint);
    if link_key != *link_ai.key {
        return Err(err(E_BAD_PDA));
    }
    if link_ai.owner == program_id || !link_ai.data_is_empty() {
        return Err(err(E_ALREADY_INIT));
    }
    create_pda_account(
        payer,
        link_ai,
        system_ai,
        program_id,
        LINK_SIZE,
        &[FACTION_SEED, mint.as_ref(), &[link_bump]],
    )?;
    let link = FactionLink { mint: *mint, curve: *curve, id: cfg.next_faction, bump: link_bump };
    link.serialize(&mut &mut link_ai.data.borrow_mut()[..])?;
    cfg.next_faction = cfg.next_faction.wrapping_add(1);
    Ok(())
}

// ---------------------------------------------------------------------------
// Dig
// ---------------------------------------------------------------------------
fn spl_burn(account: &Pubkey, mint: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = Vec::with_capacity(9);
    data.push(8u8); // Burn
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*account, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn commit(program_id: &Pubkey, accounts: &[AccountInfo], idx: u32, nonce: u64) -> ProgramResult {
    let ai = &mut accounts.iter();
    let digger = next_account_info(ai)?;
    let config_ai = next_account_info(ai)?;
    let mine_ai = next_account_info(ai)?;
    let link_ai = next_account_info(ai)?;
    let mint_ai = next_account_info(ai)?;
    let digger_ata = next_account_info(ai)?;
    let curve_ai = next_account_info(ai)?;
    let pot_ai = next_account_info(ai)?;
    let splitter_ai = next_account_info(ai)?;
    let dev_ai = next_account_info(ai)?;
    let token_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;
    let commit_ai = next_account_info(ai)?;

    if !digger.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *token_ai.key != TOKEN_PROGRAM || *system_ai.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let cfg = load_config(program_id, config_ai)?;
    if mine_ai.owner != program_id
        || *mine_ai.key
            != Pubkey::create_program_address(&[MINE_SEED, &[cfg.mine_bump]], program_id)
                .map_err(|_| err(E_BAD_PDA))?
    {
        return Err(err(E_BAD_PDA));
    }
    let clock = Clock::get()?;
    if clock.unix_timestamp >= cfg.round_end_ts {
        return Err(err(E_ROUND_OVER)); // rotate first
    }

    // faction link + its curve
    if link_ai.owner != program_id {
        return Err(err(E_BAD_PDA));
    }
    let link = FactionLink::try_from_slice(&link_ai.data.borrow())?;
    if link.mint != *mint_ai.key || link.curve != *curve_ai.key {
        return Err(err(E_BAD_ACCOUNT));
    }
    let (pot_key, splitter_key) = (
        Pubkey::create_program_address(&[POT_SEED, &[cfg.pot_bump]], program_id).map_err(|_| err(E_BAD_PDA))?,
        Pubkey::create_program_address(&[SPLITTER_SEED, &[cfg.splitter_bump]], program_id)
            .map_err(|_| err(E_BAD_PDA))?,
    );
    if *pot_ai.key != pot_key || *splitter_ai.key != splitter_key || *dev_ai.key != cfg.dev {
        return Err(err(E_BAD_ACCOUNT));
    }

    // proof of work
    if !pow_clears(digger.key, idx, &cfg.round_seed, nonce, cfg.pow_bits) {
        return Err(err(E_POW));
    }

    // voxel: within the surveyed frontier + intact + exposed. The map may be
    // partially grown (GrowMine is permissionless — the crowd funds the
    // frontier); voxels beyond mine_len are unsurveyed rock: undiggable and
    // opaque to exposure checks.
    let i = idx as usize;
    if i >= MINE_SIZE {
        return Err(err(E_BAD_PARAMS));
    }
    if i >= cfg.mine_len as usize {
        return Err(err(E_MINE_NOT_GROWN)); // beyond the frontier — fund a GrowMine
    }
    {
        let map = mine_ai.data.borrow();
        if map[i] != 0 {
            return Err(err(E_VOXEL_TAKEN));
        }
        let (x, y, z) = coord(i);
        let exposed = on_boundary(x, y, z)
            || [
                (x > 0).then(|| i - 1),
                (x < SIZE - 1).then(|| i + 1),
                (y > 0).then(|| i - SIZE),
                (y < SIZE - 1).then(|| i + SIZE),
                (z > 0).then(|| i - SIZE * SIZE),
                (z < SIZE - 1).then(|| i + SIZE * SIZE),
            ]
            .into_iter()
            .flatten()
            .any(|n| n < map.len() && map[n] != 0);
        if !exposed {
            return Err(err(E_NOT_EXPOSED));
        }
    }

    // NAV-value burn: units = burn_value * supply / vault — equal real backing
    // destroyed per voxel across all factions.
    let vault = curve_ai
        .lamports()
        .saturating_sub(Rent::get()?.minimum_balance(UPONLY_CURVE_SIZE));
    let supply = {
        let d = mint_ai.data.borrow();
        if d.len() < 44 {
            return Err(err(E_BAD_ACCOUNT));
        }
        u64::from_le_bytes(d[36..44].try_into().unwrap())
    };
    if vault == 0 || supply == 0 {
        return Err(err(E_CURVE_EMPTY));
    }
    let units = ((cfg.dig_burn_value as u128 * supply as u128) / vault as u128).max(1);
    let units = u64::try_from(units).map_err(|_| err(E_OVERFLOW))?;
    invoke(
        &spl_burn(digger_ata.key, mint_ai.key, digger.key, units),
        &[digger_ata.clone(), mint_ai.clone(), digger.clone(), token_ai.clone()],
    )?;

    // dig fee: house curves (creator == splitter) pay the base tier
    let curve = parse_curve(&curve_ai.data.borrow())?;
    let house = curve.buy_creator == splitter_key && curve.sell_creator == splitter_key;
    let fee = cfg.dig_fee * if house { 1 } else { cfg.foreign_fee_mult as u64 };
    let dev_cut = (fee as u128 * cfg.dig_fee_dev_bps as u128 / 10_000) as u64;
    if dev_cut > 0 {
        invoke(
            &system_instruction::transfer(digger.key, dev_ai.key, dev_cut),
            &[digger.clone(), dev_ai.clone(), system_ai.clone()],
        )?;
    }
    if fee - dev_cut > 0 {
        invoke(
            &system_instruction::transfer(digger.key, pot_ai.key, fee - dev_cut),
            &[digger.clone(), pot_ai.clone(), system_ai.clone()],
        )?;
    }

    // claim the voxel
    mine_ai.data.borrow_mut()[i] = link.id;

    // record the commit — the vein roll happens in reveal() against
    // slot_hashes[commit_slot], unknowable now. the cost above is already sunk,
    // so the outcome cannot be bundled-and-reverted for free.
    let (commit_key, commit_bump) =
        Pubkey::find_program_address(&[COMMIT_SEED, &idx.to_le_bytes()], program_id);
    if *commit_ai.key != commit_key {
        return Err(err(E_BAD_PDA));
    }
    create_pda_account(
        digger, commit_ai, system_ai, program_id, COMMIT_SIZE,
        &[COMMIT_SEED, &idx.to_le_bytes(), &[commit_bump]],
    )?;
    Commit {
        digger: *digger.key,
        curve: *curve_ai.key,
        round_seed: cfg.round_seed,
        commit_slot: clock.slot,
        idx,
        faction_id: link.id,
        bump: commit_bump,
    }
    .serialize(&mut &mut commit_ai.data.borrow_mut()[..])?;
    msg!("megamine: commit idx={} faction={} slot={} burned={}", idx, link.id, clock.slot, units);
    Ok(())
}

// ---------------------------------------------------------------------------
// Reveal — resolve a commit against slot_hashes[commit_slot] (permissionless)
// ---------------------------------------------------------------------------
fn reveal(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let _cranker = next_account_info(ai)?; // any fee payer; no rights needed
    let config_ai = next_account_info(ai)?;
    let commit_ai = next_account_info(ai)?;
    let pot_ai = next_account_info(ai)?;
    let curve_ai = next_account_info(ai)?;
    let digger_ai = next_account_info(ai)?;
    let slot_hashes_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;

    let cfg = load_config(program_id, config_ai)?;
    if commit_ai.owner != program_id {
        return Err(err(E_BAD_PDA));
    }
    let c = Commit::try_from_slice(&commit_ai.data.borrow())?;
    let expect = Pubkey::create_program_address(&[COMMIT_SEED, &c.idx.to_le_bytes(), &[c.bump]], program_id)
        .map_err(|_| err(E_BAD_PDA))?;
    if expect != *commit_ai.key {
        return Err(err(E_BAD_PDA));
    }
    if *digger_ai.key != c.digger || *curve_ai.key != c.curve {
        return Err(err(E_BAD_ACCOUNT));
    }
    let pot_key = Pubkey::create_program_address(&[POT_SEED, &[cfg.pot_bump]], program_id).map_err(|_| err(E_BAD_PDA))?;
    if *pot_ai.key != pot_key
        || *slot_hashes_ai.key != solana_program::sysvar::slot_hashes::ID
        || *system_ai.key != system_program::ID
    {
        return Err(err(E_BAD_ACCOUNT));
    }
    let clock = Clock::get()?;
    if clock.slot <= c.commit_slot {
        return Err(err(E_TOO_EARLY)); // commit slot not yet sealed -> cannot be same-slot/bundled
    }

    // find the hash of the commit slot in the SlotHashes ring (512 recent).
    // entries: [len:u64][ (slot:u64, hash:[u8;32]) x len ], newest first.
    let mut struck_reward: u64 = 0;
    {
        let data = slot_hashes_ai.data.borrow();
        let len = u64::from_le_bytes(data[0..8].try_into().unwrap()) as usize;
        let mut hash: Option<[u8; 32]> = None;
        for k in 0..len {
            let o = 8 + k * 40;
            let slot = u64::from_le_bytes(data[o..o + 8].try_into().unwrap());
            if slot == c.commit_slot {
                hash = Some(data[o + 8..o + 40].try_into().unwrap());
                break;
            }
        }
        match hash {
            Some(h) if vein_hits(&c.round_seed, c.idx, &h, cfg.vein_threshold) => {
                let (x, y, z) = coord(c.idx as usize);
                let depth = depth_of(x, y, z);
                let pot_free = pot_ai.lamports().saturating_sub(Rent::get()?.minimum_balance(0));
                // elastic: a strike claims a slice of the pot — the bigger the pot, the
                // bigger the strike. 8% at the surface, +0.4% per depth ring, cap 30%.
                let bps = (800 + 40 * depth).min(3000);
                let elastic = pot_free.saturating_mul(bps) / 10_000;
                // floor: the old fixed reward guarantees a thin/fresh pot still pays out.
                let floor = cfg.vein_base * (10 + 2 * depth) / 10;
                struck_reward = elastic.max(floor).min(pot_free);
            }
            Some(_) => msg!("megamine: dry idx={} faction={}", c.idx, c.faction_id),
            None => msg!("megamine: expired idx={} (reveal too late)", c.idx),
        }
    }
    if struck_reward > 0 {
        let half = struck_reward / 2;
        let pot_seeds: &[&[u8]] = &[POT_SEED, &[cfg.pot_bump]];
        invoke_signed(
            &system_instruction::transfer(pot_ai.key, digger_ai.key, half),
            &[pot_ai.clone(), digger_ai.clone(), system_ai.clone()],
            &[pot_seeds],
        )?;
        // floor pump: bare lamports onto the curve PDA = uponly backing
        invoke_signed(
            &system_instruction::transfer(pot_ai.key, curve_ai.key, struck_reward - half),
            &[pot_ai.clone(), curve_ai.clone(), system_ai.clone()],
            &[pot_seeds],
        )?;
        msg!("megamine: STRIKE idx={} faction={} reward={} (half to floor)", c.idx, c.faction_id, struck_reward);
    }
    // close the commit -> rent back to the digger
    let lam = commit_ai.lamports();
    **commit_ai.try_borrow_mut_lamports()? = 0;
    **digger_ai.try_borrow_mut_lamports()? += lam;
    commit_ai.data.borrow_mut().fill(0);
    Ok(())
}

// ---------------------------------------------------------------------------
// Rotate — permissionless round advance
// ---------------------------------------------------------------------------
fn rotate(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let config_ai = next_account_info(ai)?;
    let slot_hashes_ai = next_account_info(ai)?;

    let mut cfg = load_config(program_id, config_ai)?;
    let clock = Clock::get()?;
    if clock.unix_timestamp < cfg.round_end_ts {
        return Err(err(E_ROUND_LIVE));
    }
    if *slot_hashes_ai.key != solana_program::sysvar::slot_hashes::ID {
        return Err(err(E_BAD_ACCOUNT));
    }
    // entropy: latest slot hash (unknowable before the rotation slot) + chain
    let data = slot_hashes_ai.data.borrow();
    let recent: &[u8] = if data.len() >= 48 { &data[16..48] } else { &[] };
    cfg.round_seed = keccak::hashv(&[
        &cfg.round_seed,
        recent,
        &clock.slot.to_le_bytes(),
        &cfg.round_id.to_le_bytes(),
    ])
    .0;
    cfg.round_id += 1;
    cfg.round_end_ts = clock
        .unix_timestamp
        .checked_add(cfg.round_secs as i64)
        .ok_or(err(E_OVERFLOW))?;
    store_config(&cfg, config_ai)?;
    msg!("megamine: round {} seed rotated", cfg.round_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Sweep — split splitter balance pot/dev by burned bps
// ---------------------------------------------------------------------------
fn sweep(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let ai = &mut accounts.iter();
    let config_ai = next_account_info(ai)?;
    let splitter_ai = next_account_info(ai)?;
    let pot_ai = next_account_info(ai)?;
    let dev_ai = next_account_info(ai)?;
    let system_ai = next_account_info(ai)?;

    let cfg = load_config(program_id, config_ai)?;
    let splitter_key = Pubkey::create_program_address(&[SPLITTER_SEED, &[cfg.splitter_bump]], program_id)
        .map_err(|_| err(E_BAD_PDA))?;
    let pot_key = Pubkey::create_program_address(&[POT_SEED, &[cfg.pot_bump]], program_id)
        .map_err(|_| err(E_BAD_PDA))?;
    if *splitter_ai.key != splitter_key || *pot_ai.key != pot_key || *dev_ai.key != cfg.dev {
        return Err(err(E_BAD_ACCOUNT));
    }
    let excess = splitter_ai
        .lamports()
        .saturating_sub(Rent::get()?.minimum_balance(0));
    if excess == 0 {
        return Ok(());
    }
    let to_pot = (excess as u128 * cfg.splitter_pot_bps as u128 / 10_000) as u64;
    let seeds: &[&[u8]] = &[SPLITTER_SEED, &[cfg.splitter_bump]];
    if to_pot > 0 {
        invoke_signed(
            &system_instruction::transfer(splitter_ai.key, pot_ai.key, to_pot),
            &[splitter_ai.clone(), pot_ai.clone(), system_ai.clone()],
            &[seeds],
        )?;
    }
    if excess - to_pot > 0 {
        invoke_signed(
            &system_instruction::transfer(splitter_ai.key, dev_ai.key, excess - to_pot),
            &[splitter_ai.clone(), dev_ai.clone(), system_ai.clone()],
            &[seeds],
        )?;
    }
    msg!("megamine: sweep {} -> pot {} / dev {}", excess, to_pot, excess - to_pot);
    Ok(())
}
