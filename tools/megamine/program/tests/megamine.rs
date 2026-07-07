//! megamine litesvm integration tests — composed against the REAL uponly
//! binary (tests/fixtures/uponly.so, built from BuildwithAnon/uponly source).
//! The uponly program id is randomized every run: megamine takes it as an
//! init parameter, proving nothing is hardcoded to any particular deploy.

use borsh::BorshDeserialize;
use litesvm::LiteSVM;
use megamine::{
    config_pda, faction_pda, mine_pda, pot_pda, pow_clears, splitter_pda, vein_hits, Config,
    FactionLink, MineInstruction, GROW_STEP, MINE_SIZE, SIZE, UPONLY_CURVE_SIZE,
};
use solana_sdk::{
    clock::Clock,
    rent::Rent,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction, system_program,
    sysvar::slot_hashes,
    transaction::Transaction,
};
use spl_associated_token_account::get_associated_token_address;

const SOL: u64 = 1_000_000_000;
const DIG_FEE: u64 = 100_000;
const DIG_BURN_VALUE: u64 = 1_000_000; // 0.001 SOL of NAV per voxel
const VEIN_BASE: u64 = 50_000_000;
const POW_BITS: u8 = 8;

struct World {
    svm: LiteSVM,
    megamine: Pubkey,
    uponly: Pubkey,
    payer: Keypair,
    dev: Pubkey,
    config: Pubkey,
    mine: Pubkey,
    pot: Pubkey,
    splitter: Pubkey,
}

fn ix(
    program: Pubkey,
    metas: Vec<AccountMeta>,
    data: &MineInstruction,
) -> Instruction {
    Instruction { program_id: program, accounts: metas, data: borsh::to_vec(data).unwrap() }
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let bh = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, bh);
    if let Err(e) = svm.send_transaction(tx) {
        panic!("tx failed: {:?}\nlogs:\n{}", e.err, e.meta.logs.join("\n"));
    }
}

fn try_send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &[payer], bh);
    svm.send_transaction(tx)
        .map(|_| ())
        .map_err(|e| format!("{:?} | {}", e.err, e.meta.logs.join(" ")))
}

fn read_config(svm: &LiteSVM, config: &Pubkey) -> Config {
    Config::try_from_slice(&svm.get_account(config).unwrap().data).unwrap()
}

fn token_balance(svm: &LiteSVM, ata: &Pubkey) -> u64 {
    let d = svm.get_account(ata).unwrap().data;
    u64::from_le_bytes(d[64..72].try_into().unwrap())
}

/// Boot megamine + uponly, init the mine, grow to full size.
fn setup(vein_threshold: u32) -> World {
    let mut svm = LiteSVM::new();
    let megamine_id = Pubkey::new_unique();
    let uponly_id = Pubkey::new_unique();
    svm.add_program(
        megamine_id,
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/megamine.so"))
            .expect("cargo build-sbf first"),
    );
    svm.add_program(
        uponly_id,
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/uponly.so"))
            .expect("uponly fixture missing"),
    );

    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 200 * SOL).unwrap();
    let dev = Pubkey::new_unique();

    let (config, _) = config_pda(&megamine_id);
    let (mine, _) = mine_pda(&megamine_id);
    let (pot, _) = pot_pda(&megamine_id);
    let (splitter, _) = splitter_pda(&megamine_id);

    send(
        &mut svm,
        &[ix(
            megamine_id,
            vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(config, false),
                AccountMeta::new(mine, false),
                AccountMeta::new(pot, false),
                AccountMeta::new(splitter, false),
                AccountMeta::new_readonly(uponly_id, false),
                AccountMeta::new_readonly(dev, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &MineInstruction::Initialize {
                dig_fee: DIG_FEE,
                foreign_fee_mult: 3,
                dig_fee_dev_bps: 2_000,   // 20% of dig fees to dev
                splitter_pot_bps: 5_000,  // creator fees: 50% pot / 50% dev
                dig_burn_value: DIG_BURN_VALUE,
                vein_threshold,
                vein_base: VEIN_BASE,
                round_secs: 3_600,
                pow_bits: POW_BITS,
                min_backing_floor_bps: 9_350, // the constitution
                max_creator_fee_bps: 100,
            },
        )],
        &payer,
        &[],
    );

    // grow the mine to the full million bytes, 12 reallocs per tx
    let grow = |mm: Pubkey, cfg: Pubkey, mine: Pubkey, p: &Keypair| {
        ix(
            mm,
            vec![
                AccountMeta::new(p.pubkey(), true),
                AccountMeta::new(cfg, false),
                AccountMeta::new(mine, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &MineInstruction::GrowMine,
        )
    };
    let mut grows = (MINE_SIZE - GROW_STEP + GROW_STEP - 1) / GROW_STEP; // ceil
    while grows > 0 {
        let n = grows.min(12);
        let ixs: Vec<Instruction> = (0..n).map(|_| grow(megamine_id, config, mine, &payer)).collect();
        send(&mut svm, &ixs, &payer, &[]);
        svm.expire_blockhash();
        grows -= n;
    }
    assert_eq!(svm.get_account(&mine).unwrap().data.len(), MINE_SIZE);
    assert_eq!(read_config(&svm, &config).mine_len as usize, MINE_SIZE);

    World { svm, megamine: megamine_id, uponly: uponly_id, payer, dev, config, mine, pot, splitter }
}

// ---------- uponly-side helpers (mirror client/src/curve.rs) ----------

fn uponly_curve_pda(uponly: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"curve", mint.as_ref()], uponly).0
}

fn create_mint_ixs(w: &World, mint: &Keypair) -> Vec<Instruction> {
    let curve = uponly_curve_pda(&w.uponly, &mint.pubkey());
    let rent = w.svm.minimum_balance_for_rent_exemption(82);
    vec![
        system_instruction::create_account(&w.payer.pubkey(), &mint.pubkey(), rent, 82, &spl_token::id()),
        spl_token::instruction::initialize_mint2(&spl_token::id(), &mint.pubkey(), &curve, None, 9).unwrap(),
    ]
}

#[derive(borsh::BorshSerialize)]
enum UponlyIx {
    #[allow(dead_code)]
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
    Buy { lamports: u64, min_out: u64 },
}

fn uponly_init_direct(w: &mut World, mint: &Keypair, creator: &Keypair, min_backing_bps: u16, creator_fee_bps: u16) {
    let curve = uponly_curve_pda(&w.uponly, &mint.pubkey());
    let mut ixs = create_mint_ixs(w, mint);
    ixs.push(Instruction {
        program_id: w.uponly,
        accounts: vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new(curve, false),
            AccountMeta::new_readonly(mint.pubkey(), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: borsh::to_vec(&UponlyIx::Initialize {
            buy_creator: creator.pubkey(),
            sell_creator: creator.pubkey(),
            start_price_fp: 10u128.pow(15),
            double_vol: 50 * SOL,
            buy_fee_creator_bps: creator_fee_bps,
            buy_fee_floor_bps: 200,
            sell_fee_creator_bps: creator_fee_bps,
            sell_fee_floor_bps: 500,
            min_backing_bps,
        })
        .unwrap(),
    });
    let payer = w.payer.insecure_clone();
    let _ = creator;
    send(&mut w.svm, &ixs, &payer, &[mint]);
}

fn uponly_buy(w: &mut World, buyer: &Keypair, mint: &Pubkey, creator: &Pubkey, lamports: u64) {
    let curve = uponly_curve_pda(&w.uponly, mint);
    let ata = get_associated_token_address(&buyer.pubkey(), mint);
    let mut ixs = vec![];
    if w.svm.get_account(&ata).is_none() {
        ixs.push(spl_associated_token_account::instruction::create_associated_token_account(
            &buyer.pubkey(),
            &buyer.pubkey(),
            mint,
            &spl_token::id(),
        ));
    }
    ixs.push(Instruction {
        program_id: w.uponly,
        accounts: vec![
            AccountMeta::new(buyer.pubkey(), true),
            AccountMeta::new(curve, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new(ata, false),
            AccountMeta::new(*creator, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data: borsh::to_vec(&UponlyIx::Buy { lamports, min_out: 0 }).unwrap(),
    });
    send(&mut w.svm, &ixs, buyer, &[]);
}

// ---------- megamine-side helpers ----------

fn init_house_curve(w: &mut World, mint: &Keypair) -> Pubkey {
    let curve = uponly_curve_pda(&w.uponly, &mint.pubkey());
    let (link, _) = faction_pda(&w.megamine, &mint.pubkey());
    let mut ixs = create_mint_ixs(w, mint);
    ixs.push(ix(
        w.megamine,
        vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new(w.config, false),
            AccountMeta::new(w.splitter, false),
            AccountMeta::new_readonly(mint.pubkey(), false),
            AccountMeta::new(curve, false),
            AccountMeta::new(link, false),
            AccountMeta::new_readonly(w.uponly, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        &MineInstruction::InitHouseCurve {
            start_price_fp: 10u128.pow(15),
            double_vol: 50 * SOL,
            buy_fee_creator_bps: 100,
            buy_fee_floor_bps: 200,
            sell_fee_creator_bps: 100,
            sell_fee_floor_bps: 500,
            min_backing_bps: 9_350,
        },
    ));
    let payer = w.payer.insecure_clone();
    send(&mut w.svm, &ixs, &payer, &[mint]);
    curve
}

fn register_faction_ix(w: &World, mint: &Pubkey) -> Instruction {
    let curve = uponly_curve_pda(&w.uponly, mint);
    let (link, _) = faction_pda(&w.megamine, mint);
    ix(
        w.megamine,
        vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new(w.config, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(curve, false),
            AccountMeta::new(link, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        &MineInstruction::RegisterFaction,
    )
}

fn grind(digger: &Pubkey, idx: u32, seed: &[u8; 32]) -> u64 {
    (0u64..).find(|n| pow_clears(digger, idx, seed, *n, POW_BITS)).unwrap()
}

fn commit_pda_addr(megamine: &Pubkey, idx: u32) -> Pubkey {
    Pubkey::find_program_address(&[b"commit", &idx.to_le_bytes()], megamine).0
}

fn dig_ix(w: &World, digger: &Pubkey, mint: &Pubkey, idx: u32, nonce: u64) -> Instruction {
    let curve = uponly_curve_pda(&w.uponly, mint);
    let (link, _) = faction_pda(&w.megamine, mint);
    ix(
        w.megamine,
        vec![
            AccountMeta::new(*digger, true),
            AccountMeta::new_readonly(w.config, false),
            AccountMeta::new(w.mine, false),
            AccountMeta::new_readonly(link, false),
            AccountMeta::new(*mint, false),
            AccountMeta::new(get_associated_token_address(digger, mint), false),
            AccountMeta::new(curve, false),
            AccountMeta::new(w.pot, false),
            AccountMeta::new_readonly(w.splitter, false),
            AccountMeta::new(w.dev, false),
            AccountMeta::new_readonly(spl_token::id(), false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new(commit_pda_addr(&w.megamine, idx), false),
        ],
        &MineInstruction::Commit { idx, nonce },
    )
}

fn reveal_ix(w: &World, cranker: &Pubkey, digger: &Pubkey, mint: &Pubkey, idx: u32) -> Instruction {
    let curve = uponly_curve_pda(&w.uponly, mint);
    ix(
        w.megamine,
        vec![
            AccountMeta::new(*cranker, true),
            AccountMeta::new_readonly(w.config, false),
            AccountMeta::new(commit_pda_addr(&w.megamine, idx), false),
            AccountMeta::new(w.pot, false),
            AccountMeta::new(curve, false),
            AccountMeta::new(*digger, false),
            AccountMeta::new_readonly(slot_hashes::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        &MineInstruction::Reveal,
    )
}

/// Seal the commit slot: advance the clock one slot and plant that slot's hash
/// in the SlotHashes sysvar so reveal can resolve it. Mirrors bincode's Vec
/// layout: [len:u64][ (slot:u64, hash:[u8;32]) ].
fn seal_slot(w: &mut World, commit_slot: u64) {
    let mut clock: Clock = w.svm.get_sysvar();
    clock.slot = commit_slot + 1;
    w.svm.set_sysvar(&clock);
    let mut data = Vec::new();
    data.extend_from_slice(&1u64.to_le_bytes());
    data.extend_from_slice(&commit_slot.to_le_bytes());
    data.extend_from_slice(&[7u8; 32]);
    w.svm
        .set_account(
            slot_hashes::ID,
            solana_sdk::account::Account {
                lamports: 1_000_000,
                data,
                owner: solana_sdk::sysvar::ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[test]
fn full_composition_flow() {
    let mut w = setup(0); // no veins — pure dig economics

    // 1. house curve init via CPI: splitter must end up as uponly creator
    let mint = Keypair::new();
    let curve = init_house_curve(&mut w, &mint);
    let curve_data = w.svm.get_account(&curve).unwrap();
    assert_eq!(curve_data.owner, w.uponly);
    assert_eq!(curve_data.data.len(), UPONLY_CURVE_SIZE);
    let buy_creator = Pubkey::new_from_array(curve_data.data[32..64].try_into().unwrap());
    let sell_creator = Pubkey::new_from_array(curve_data.data[64..96].try_into().unwrap());
    assert_eq!(buy_creator, w.splitter, "house buy_creator must be the splitter PDA");
    assert_eq!(sell_creator, w.splitter, "house sell_creator must be the splitter PDA");
    let link: FactionLink =
        FactionLink::try_from_slice(&w.svm.get_account(&faction_pda(&w.megamine, &mint.pubkey()).0).unwrap().data)
            .unwrap();
    assert_eq!(link.id, 1);

    // 2. buy on the REAL uponly program; creator fee lands on the splitter
    let digger = Keypair::new();
    w.svm.airdrop(&digger.pubkey(), 20 * SOL).unwrap();
    let splitter_before = w.svm.get_balance(&w.splitter).unwrap();
    let splitter = w.splitter;
    uponly_buy(&mut w, &digger, &mint.pubkey(), &splitter, 2 * SOL);
    let creator_fee = w.svm.get_balance(&w.splitter).unwrap() - splitter_before;
    assert_eq!(creator_fee, 2 * SOL / 100, "1% buy creator fee streams to splitter");

    // 3. dig a boundary voxel: PoW + NAV-value burn + fee split
    let cfg = read_config(&w.svm, &w.config);
    let idx = 0u32; // corner — boundary, exposed
    let nonce = grind(&digger.pubkey(), idx, &cfg.round_seed);
    let ata = get_associated_token_address(&digger.pubkey(), &mint.pubkey());
    let tokens_before = token_balance(&w.svm, &ata);
    let pot_before = w.svm.get_balance(&w.pot).unwrap();
    let dev_before = w.svm.get_balance(&w.dev).unwrap_or(0);
    // snapshot the NAV inputs the program sees at dig time (pre-burn)
    let vault = w.svm.get_balance(&curve).unwrap() - w.svm.minimum_balance_for_rent_exemption(UPONLY_CURVE_SIZE);
    let supply = {
        let d = w.svm.get_account(&mint.pubkey()).unwrap().data;
        u64::from_le_bytes(d[36..44].try_into().unwrap())
    };
    let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), idx, nonce);
    send(&mut w.svm, &[dix], &digger, &[]);

    let mine = w.svm.get_account(&w.mine).unwrap().data;
    assert_eq!(mine[0], 1, "voxel claimed by faction 1");
    let burned = tokens_before - token_balance(&w.svm, &ata);
    assert!(burned > 0, "dig burned tokens");
    // NAV-value check: burned units * vault / supply ≈ DIG_BURN_VALUE
    let value = burned as u128 * vault as u128 / supply as u128;
    assert!((value as i128 - DIG_BURN_VALUE as i128).abs() < 100, "burn is NAV-normalized: {value}");
    assert_eq!(w.svm.get_balance(&w.dev).unwrap() - dev_before, DIG_FEE / 5, "20% dig fee to dev");
    assert_eq!(w.svm.get_balance(&w.pot).unwrap() - pot_before, DIG_FEE * 4 / 5, "80% dig fee to pot");

    // 4. same voxel again → taken; interior voxel → not exposed
    w.svm.expire_blockhash();
    let n2 = grind(&digger.pubkey(), idx, &cfg.round_seed);
    let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), idx, n2);
    let e = try_send(&mut w.svm, &[dix], &digger).unwrap_err();
    assert!(e.contains("Custom(8)"), "voxel taken: {e}");
    let interior = (50 + 50 * SIZE + 50 * SIZE * SIZE) as u32;
    let n3 = grind(&digger.pubkey(), interior, &cfg.round_seed);
    let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), interior, n3);
    let e = try_send(&mut w.svm, &[dix], &digger).unwrap_err();
    assert!(e.contains("Custom(9)"), "not exposed: {e}");

    // 5. tunneling: neighbor of the dug corner is now diggable
    let neighbor = 1u32;
    let n4 = grind(&digger.pubkey(), neighbor, &cfg.round_seed);
    let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), neighbor, n4);
    send(&mut w.svm, &[dix], &digger, &[]);

    // 6. bad PoW rejected
    w.svm.expire_blockhash();
    let fresh = 2u32;
    let bad_nonce = grind(&digger.pubkey(), fresh, &cfg.round_seed) + 1;
    if !pow_clears(&digger.pubkey(), fresh, &cfg.round_seed, bad_nonce, POW_BITS) {
        let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), fresh, bad_nonce);
    let e = try_send(&mut w.svm, &[dix], &digger).unwrap_err();
        assert!(e.contains("Custom(7)"), "pow rejected: {e}");
    }

    // 7. sweep: splitter creator fees split 50/50 pot/dev
    let excess = w.svm.get_balance(&w.splitter).unwrap() - w.svm.minimum_balance_for_rent_exemption(0);
    let (pot0, dev0) = (w.svm.get_balance(&w.pot).unwrap(), w.svm.get_balance(&w.dev).unwrap());
    send(
        &mut w.svm,
        &[ix(
            w.megamine,
            vec![
                AccountMeta::new_readonly(w.config, false),
                AccountMeta::new(w.splitter, false),
                AccountMeta::new(w.pot, false),
                AccountMeta::new(w.dev, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &MineInstruction::Sweep,
        )],
        &w.payer.insecure_clone(),
        &[],
    );
    assert_eq!(w.svm.get_balance(&w.pot).unwrap() - pot0, excess / 2, "half of creator fees to pot");
    assert_eq!(w.svm.get_balance(&w.dev).unwrap() - dev0, excess - excess / 2, "half to dev");
}

#[test]
fn constitution_gates_registration() {
    let mut w = setup(0);

    // compliant foreign curve (93.5% governor, 1% creator) registers fine
    let good = Keypair::new();
    let good_creator = Keypair::new();
    w.svm.airdrop(&good_creator.pubkey(), SOL).unwrap();
    uponly_init_direct(&mut w, &good, &good_creator, 9_350, 100);
    let payer = w.payer.insecure_clone();
    let rix = register_faction_ix(&w, &good.pubkey());
    send(&mut w.svm, &[rix], &payer, &[]);
    let link: FactionLink =
        FactionLink::try_from_slice(&w.svm.get_account(&faction_pda(&w.megamine, &good.pubkey()).0).unwrap().data)
            .unwrap();
    assert_eq!(link.id, 1);

    // degen curve (10% backing) does NOT get a pickaxe
    let degen = Keypair::new();
    let degen_creator = Keypair::new();
    w.svm.airdrop(&degen_creator.pubkey(), SOL).unwrap();
    uponly_init_direct(&mut w, &degen, &degen_creator, 8_250, 100); // uponly-legal (82.5% floor), constitution-illegal (<93.5%)
    let rix = register_faction_ix(&w, &degen.pubkey());
    let e = try_send(&mut w.svm, &[rix], &payer).unwrap_err();
    assert!(e.contains("Custom(5)"), "unconstitutional: {e}");

    // fee-gouging curve (5% creator per side) rejected too
    let gouge = Keypair::new();
    let gouge_creator = Keypair::new();
    w.svm.airdrop(&gouge_creator.pubkey(), SOL).unwrap();
    uponly_init_direct(&mut w, &gouge, &gouge_creator, 9_350, 500);
    let rix = register_faction_ix(&w, &gouge.pubkey());
    let e = try_send(&mut w.svm, &[rix], &payer).unwrap_err();
    assert!(e.contains("Custom(5)"), "fee gouge rejected: {e}");
}

#[test]
fn vein_strike_pays_digger_and_floor() {
    let mut w = setup(u32::MAX); // every dig strikes

    let mint = Keypair::new();
    let curve = init_house_curve(&mut w, &mint);
    let digger = Keypair::new();
    w.svm.airdrop(&digger.pubkey(), 20 * SOL).unwrap();
    let splitter = w.splitter;
    uponly_buy(&mut w, &digger, &mint.pubkey(), &splitter, 2 * SOL);

    // fund the pot so the strike pays full freight
    let payer = w.payer.insecure_clone();
    send(
        &mut w.svm,
        &[system_instruction::transfer(&payer.pubkey(), &w.pot, SOL)],
        &payer,
        &[],
    );

    let cfg = read_config(&w.svm, &w.config);
    let idx = 0u32; // corner: depth 0 → reward = vein_base
    let nonce = grind(&digger.pubkey(), idx, &cfg.round_seed);

    // commit sinks the burn + fee and claims the voxel — no vein yet
    let commit_slot = w.svm.get_sysvar::<Clock>().slot;
    let cix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), idx, nonce);
    send(&mut w.svm, &[cix], &digger, &[]);

    // reveal in the SAME slot must fail — this is the anti-bundle guarantee
    let rix_early = reveal_ix(&w, &w.payer.pubkey(), &digger.pubkey(), &mint.pubkey(), idx);
    let payer = w.payer.insecure_clone();
    let e = try_send(&mut w.svm, &[rix_early], &payer).unwrap_err();
    assert!(e.contains("Custom(16)"), "reveal cannot share the commit slot: {e}");
    w.svm.expire_blockhash();

    // seal the commit slot, then reveal — the roll resolves against its hash
    seal_slot(&mut w, commit_slot);
    let curve_before = w.svm.get_balance(&curve).unwrap();
    let digger_before = w.svm.get_balance(&digger.pubkey()).unwrap();
    let pot_before = w.svm.get_balance(&w.pot).unwrap();
    let rix = reveal_ix(&w, &w.payer.pubkey(), &digger.pubkey(), &mint.pubkey(), idx);
    send(&mut w.svm, &[rix], &payer, &[]);

    // elastic: a depth-0 strike claims 8% of the pot, floored at vein_base
    let rent0 = w.svm.get_sysvar::<Rent>().minimum_balance(0);
    let pot_free = pot_before - rent0;
    let reward = std::cmp::max(pot_free * 800 / 10_000, VEIN_BASE); // depth 0 → bps 800
    assert!(reward > VEIN_BASE, "funded pot should make the elastic slice beat the floor");
    assert_eq!(
        w.svm.get_balance(&curve).unwrap() - curve_before,
        reward - reward / 2,
        "half the vein donated to the faction's uponly floor"
    );
    // reveal pays reward/2 to the digger AND refunds the commit rent (cranker paid the tx fee)
    let digger_delta =
        w.svm.get_balance(&digger.pubkey()).unwrap() as i128 - digger_before as i128;
    assert!(
        digger_delta >= (reward / 2) as i128,
        "digger got their half + rent back: {digger_delta}"
    );
}

#[test]
fn rotate_reseeds_and_invalidates_pow() {
    let mut w = setup(0);
    let mint = Keypair::new();
    init_house_curve(&mut w, &mint);
    let digger = Keypair::new();
    w.svm.airdrop(&digger.pubkey(), 20 * SOL).unwrap();
    let splitter = w.splitter;
    uponly_buy(&mut w, &digger, &mint.pubkey(), &splitter, 2 * SOL);

    let cfg = read_config(&w.svm, &w.config);
    let old_seed = cfg.round_seed;

    // rotate too early → rejected
    let rotate = ix(
        w.megamine,
        vec![
            AccountMeta::new(w.config, false),
            AccountMeta::new_readonly(slot_hashes::ID, false),
        ],
        &MineInstruction::Rotate,
    );
    let payer = w.payer.insecure_clone();
    let e = try_send(&mut w.svm, &[rotate.clone()], &payer).unwrap_err();
    assert!(e.contains("Custom(11)"), "round still live: {e}");
    w.svm.expire_blockhash();

    // warp past the window → rotates, seed changes
    let mut clock: Clock = w.svm.get_sysvar();
    clock.unix_timestamp += 3_601;
    w.svm.set_sysvar(&clock);
    send(&mut w.svm, &[rotate], &payer, &[]);
    let cfg2 = read_config(&w.svm, &w.config);
    assert_eq!(cfg2.round_id, 2);
    assert_ne!(cfg2.round_seed, old_seed);

    // a nonce ground against the OLD seed no longer digs
    let idx = 0u32;
    let stale = grind(&digger.pubkey(), idx, &old_seed);
    if !pow_clears(&digger.pubkey(), idx, &cfg2.round_seed, stale, POW_BITS) {
        let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), idx, stale);
    let e = try_send(&mut w.svm, &[dix], &digger).unwrap_err();
        assert!(e.contains("Custom(7)"), "stale pow rejected: {e}");
        w.svm.expire_blockhash();
    }
    // and a fresh grind works
    w.svm.expire_blockhash();
    let fresh = grind(&digger.pubkey(), idx, &cfg2.round_seed);
    let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), idx, fresh);
    send(&mut w.svm, &[dix], &digger, &[]);
    assert_eq!(w.svm.get_account(&w.mine).unwrap().data[0], 1);
}

#[test]
fn frontier_digging_before_full_growth() {
    // like setup() but WITHOUT growing the map — only the initial 10,240 bytes
    let mut svm = LiteSVM::new();
    let megamine_id = Pubkey::new_unique();
    let uponly_id = Pubkey::new_unique();
    svm.add_program(
        megamine_id,
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/target/deploy/megamine.so")).unwrap(),
    );
    svm.add_program(
        uponly_id,
        &std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/uponly.so")).unwrap(),
    );
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 50 * SOL).unwrap();
    let dev = Pubkey::new_unique();
    let (config, _) = config_pda(&megamine_id);
    let (mine, _) = mine_pda(&megamine_id);
    let (pot, _) = pot_pda(&megamine_id);
    let (splitter, _) = splitter_pda(&megamine_id);
    send(
        &mut svm,
        &[ix(
            megamine_id,
            vec![
                AccountMeta::new(payer.pubkey(), true),
                AccountMeta::new(config, false),
                AccountMeta::new(mine, false),
                AccountMeta::new(pot, false),
                AccountMeta::new(splitter, false),
                AccountMeta::new_readonly(uponly_id, false),
                AccountMeta::new_readonly(dev, false),
                AccountMeta::new_readonly(system_program::ID, false),
            ],
            &MineInstruction::Initialize {
                dig_fee: DIG_FEE,
                foreign_fee_mult: 3,
                dig_fee_dev_bps: 2_000,
                splitter_pot_bps: 5_000,
                dig_burn_value: DIG_BURN_VALUE,
                vein_threshold: 0,
                vein_base: VEIN_BASE,
                round_secs: 3_600,
                pow_bits: POW_BITS,
                min_backing_floor_bps: 9_350,
                max_creator_fee_bps: 100,
            },
        )],
        &payer,
        &[],
    );
    assert_eq!(svm.get_account(&mine).unwrap().data.len(), GROW_STEP, "only the first slab exists");

    let mut w = World { svm, megamine: megamine_id, uponly: uponly_id, payer, dev, config, mine, pot, splitter };
    let mint = Keypair::new();
    init_house_curve(&mut w, &mint);
    let digger = Keypair::new();
    w.svm.airdrop(&digger.pubkey(), 20 * SOL).unwrap();
    let splitter = w.splitter;
    uponly_buy(&mut w, &digger, &mint.pubkey(), &splitter, 2 * SOL);

    let cfg = read_config(&w.svm, &w.config);
    assert_eq!(cfg.mine_len as usize, GROW_STEP);

    // dig within the frontier works
    let idx = 0u32;
    let nonce = grind(&digger.pubkey(), idx, &cfg.round_seed);
    let dix = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), idx, nonce);
    send(&mut w.svm, &[dix], &digger, &[]);
    assert_eq!(w.svm.get_account(&w.mine).unwrap().data[0], 1);

    // beyond the frontier: rejected as unsurveyed (Custom(4))
    let beyond = (GROW_STEP + 100) as u32;
    let n2 = grind(&digger.pubkey(), beyond, &cfg.round_seed);
    let dix2 = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), beyond, n2);
    let e = try_send(&mut w.svm, &[dix2], &digger).unwrap_err();
    assert!(e.contains("Custom(4)"), "beyond frontier rejected: {e}");

    // one crowd-funded grow extends the frontier, then that voxel... is
    // interior (not boundary, no dug neighbor) — still not exposed (Custom(9))
    let gix = ix(
        w.megamine,
        vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new(w.config, false),
            AccountMeta::new(w.mine, false),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        &MineInstruction::GrowMine,
    );
    let payer2 = w.payer.insecure_clone();
    send(&mut w.svm, &[gix], &payer2, &[]);
    assert_eq!(read_config(&w.svm, &w.config).mine_len as usize, 2 * GROW_STEP);
    w.svm.expire_blockhash();
    let n3 = grind(&digger.pubkey(), beyond, &cfg.round_seed);
    let dix3 = dig_ix(&w, &digger.pubkey(), &mint.pubkey(), beyond, n3);
    let e = try_send(&mut w.svm, &[dix3], &digger).unwrap_err();
    assert!(e.contains("Custom(9)"), "surveyed but unexposed: {e}");
}
