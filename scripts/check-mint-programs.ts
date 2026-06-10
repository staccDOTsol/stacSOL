/**
 * Print the SPL Token vs Token-2022 program owner + transfer-fee config
 * for each asset stacSOL pairs with. Useful when evaluating compatibility
 * with lending protocols / venues that don't support fee-on-transfer
 * Token-2022 mints.
 *
 * Usage:
 *   RPC_URL="https://your-rpc/key" \
 *     bun run scripts/check-mint-programs.ts
 */

import { Connection, PublicKey } from '@solana/web3.js'

const RPC = process.env.RPC_URL
if (!RPC) throw new Error('set RPC_URL env var')
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

const ASSETS: { label: string; mint: string }[] = [
  { label: 'stacSOL',  mint: '6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f' },
  { label: 'WSOL',     mint: 'So11111111111111111111111111111111111111112' },
  { label: 'USDC',     mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { label: 'PROOFv3',  mint: 'CLWeikxiw8pC9JEtZt14fqDzYfXF7uVwLuvnJPkrE7av' },
  { label: 'FOMOX402', mint: 'GezJEsABGEmZVoXsDKHCCwYvxGPhQFk4hd91MchYQZaM' },
  { label: 'Staccana', mint: '73edX6xoGY4v5y2hzuKdrUbJXLntqgmo74au1Ki1pump' },
]

// TLV extension type 1 = TransferFeeConfig
const EXT_TRANSFER_FEE_CONFIG = 1

async function main() {
  const conn = new Connection(RPC, 'confirmed')
  for (const a of ASSETS) {
    const mint = new PublicKey(a.mint)
    const acc = await conn.getAccountInfo(mint)
    if (!acc) { console.log(`${a.label}  MISSING`); continue }
    const owner = acc.owner.toBase58()
    const isToken2022 = acc.owner.equals(TOKEN_2022)
    const isToken = acc.owner.equals(TOKEN)
    const programLabel = isToken2022 ? 'TOKEN-2022' : isToken ? 'SPL-Token' : `OTHER (${owner})`
    let extras = ''
    if (isToken2022 && acc.data.length > 165) {
      // walk TLV after the 165-byte mint base layout
      let off = 165
      // skip 1-byte account_type marker = 1 (mint)
      const accountType = acc.data[off]
      if (accountType === 1) off += 1
      while (off + 4 <= acc.data.length) {
        const extType = acc.data.readUInt16LE(off)
        const extLen = acc.data.readUInt16LE(off + 2)
        const dataOff = off + 4
        if (extType === EXT_TRANSFER_FEE_CONFIG && dataOff + extLen <= acc.data.length) {
          // TransferFeeConfig layout includes newer / older fee structures
          // Older epoch fee starts at +60 (transfer_fee_config_authority +32, withdraw_withheld_authority +32, withheld_amount +8 = +72? let me parse loosely)
          // Just dump the basis_points fields by scanning known offsets.
          const cfg = acc.data.subarray(dataOff, dataOff + extLen)
          // cfg layout: 32 transfer_fee_config_authority, 32 withdraw_withheld_authority, 8 withheld_amount, then older_fee + newer_fee (each: 8 epoch + 8 maxFee + 2 transferFeeBasisPoints)
          const olderFeeBps = cfg.readUInt16LE(72 + 16)
          const newerFeeBps = cfg.readUInt16LE(72 + 16 + 18)
          extras += `  transfer-fee: older=${olderFeeBps}bps newer=${newerFeeBps}bps`
        }
        if (extLen === 0) break
        off = dataOff + extLen
        if (off > acc.data.length) break
      }
    }
    const decimals = acc.data[44]
    console.log(`${a.label.padEnd(10)}  ${a.mint.padEnd(45)}  ${programLabel.padEnd(15)} dec=${decimals}${extras}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
