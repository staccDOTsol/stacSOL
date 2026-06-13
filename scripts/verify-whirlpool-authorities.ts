/**
 * Read-only check: who currently holds the five authorities on an Orca
 * WhirlpoolsConfig, and do they match an expected wallet?
 *
 * This NEVER signs or sends anything. It only calls getAccountInfo on public
 * accounts, so it needs no private key — pass the config address + (optionally)
 * the wallet you expect to own it, and it prints a held-by check for each
 * authority. If you find yourself wanting to feed it a `PK=`, that's the tell
 * you're reaching for the transfer, not the verification.
 *
 * Three authorities live on the WhirlpoolsConfig account itself:
 *   fee_authority, collect_protocol_fees_authority, reward_emissions_super_authority
 * Two live on the derived WhirlpoolsConfigExtension PDA:
 *   config_extension_authority, token_badge_authority
 *
 * Usage:
 *   RPC_URL="https://…" \
 *     bun run scripts/verify-whirlpool-authorities.ts <CONFIG_PUBKEY> [EXPECTED_OWNER]
 *
 *   # or via env:
 *   CONFIG=KPX9QQP4… EXPECTED=FVxMBHVbyPqqo6ANaY4RM1h7JBJaRHuPTF9XehwaWztp \
 *     bun run scripts/verify-whirlpool-authorities.ts
 */

import { Connection, PublicKey } from '@solana/web3.js'

const RPC =
  process.env.RPC_URL ??
  'https://mainnet.helius-rpc.com/?api-key=89a5704a-97ad-4c43-9be4-f04dc03a6b34'

// Orca Whirlpool program (mainnet). The config-extension PDA is derived under it.
const WHIRLPOOL_PROGRAM_ID = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc')

const CONFIG_ARG = process.argv[2] ?? process.env.CONFIG
const EXPECTED_ARG = process.argv[3] ?? process.env.EXPECTED

if (!CONFIG_ARG) {
  console.error(
    'Missing WhirlpoolsConfig address.\n' +
      '  Pass it as the first CLI arg or set CONFIG=…\n' +
      '  (the KPX9QQP4…gqpb you mentioned is truncated — supply the full base58 address)',
  )
  process.exit(1)
}

function pkAt(buf: Buffer, offset: number): PublicKey {
  return new PublicKey(buf.subarray(offset, offset + 32))
}

function row(label: string, actual: PublicKey | null, expected: PublicKey | null) {
  const actualStr = actual ? actual.toBase58() : '(account not found)'
  let mark = ' '
  if (expected && actual) mark = actual.equals(expected) ? '✓' : '✗'
  console.log(`  [${mark}] ${label.padEnd(34)} ${actualStr}`)
  return expected && actual ? actual.equals(expected) : null
}

async function main() {
  const conn = new Connection(RPC, 'confirmed')

  const config = new PublicKey(CONFIG_ARG!)
  const expected = EXPECTED_ARG ? new PublicKey(EXPECTED_ARG) : null

  console.log(`RPC:      ${RPC.replace(/api-key=[^&]+/, 'api-key=…')}`)
  console.log(`Config:   ${config.toBase58()}`)
  console.log(`Expected: ${expected ? expected.toBase58() : '(none — just printing current holders)'}\n`)

  const configAcc = await conn.getAccountInfo(config)
  if (!configAcc) {
    console.error('WhirlpoolsConfig account not found at that address on this RPC/cluster.')
    process.exit(1)
  }
  if (!configAcc.owner.equals(WHIRLPOOL_PROGRAM_ID)) {
    console.warn(
      `Warning: account is owned by ${configAcc.owner.toBase58()}, not the Whirlpool program. ` +
        'Offsets below assume the Orca WhirlpoolsConfig layout and may be meaningless.\n',
    )
  }

  // WhirlpoolsConfig: [8] disc, then 3 × Pubkey, then u16 default_protocol_fee_rate
  const d = configAcc.data
  const feeAuthority = pkAt(d, 8)
  const collectProtocolFeesAuthority = pkAt(d, 40)
  const rewardEmissionsSuperAuthority = pkAt(d, 72)
  const defaultProtocolFeeRate = d.readUInt16LE(104)

  // WhirlpoolsConfigExtension PDA: ["config_extension", config]
  const [configExtension] = PublicKey.findProgramAddressSync(
    [Buffer.from('config_extension'), config.toBuffer()],
    WHIRLPOOL_PROGRAM_ID,
  )
  const extAcc = await conn.getAccountInfo(configExtension)
  let configExtensionAuthority: PublicKey | null = null
  let tokenBadgeAuthority: PublicKey | null = null
  if (extAcc) {
    // [8] disc, [8] whirlpools_config, then config_extension_authority, token_badge_authority
    configExtensionAuthority = pkAt(extAcc.data, 40)
    tokenBadgeAuthority = pkAt(extAcc.data, 72)
  }

  console.log('Authorities:')
  const results = [
    row('fee_authority', feeAuthority, expected),
    row('collect_protocol_fees_authority', collectProtocolFeesAuthority, expected),
    row('reward_emissions_super_authority', rewardEmissionsSuperAuthority, expected),
    row('config_extension_authority', configExtensionAuthority, expected),
    row('token_badge_authority', tokenBadgeAuthority, expected),
  ]

  if (!extAcc) {
    console.log(
      `\n  Note: WhirlpoolsConfigExtension (${configExtension.toBase58()}) is not initialized,\n` +
        '  so config_extension_authority and token_badge_authority do not exist yet.',
    )
  }

  console.log(
    `\ndefault_protocol_fee_rate: ${defaultProtocolFeeRate} (= ${(defaultProtocolFeeRate / 100).toFixed(2)}%)`,
  )

  if (expected) {
    const checked = results.filter((r) => r !== null) as boolean[]
    const allHeld = checked.length > 0 && checked.every(Boolean)
    const heldCount = checked.filter(Boolean).length
    console.log(
      `\nResult: ${heldCount}/${checked.length} present authorities are held by ${expected.toBase58()}` +
        (allHeld ? ' — all passed.' : ' — NOT all passed.'),
    )
    process.exit(allHeld ? 0 : 2)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
