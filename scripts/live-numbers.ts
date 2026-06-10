/**
 * Print the live pool snapshot in the format we paste into DMs / pitch
 * decks: redemption rate, total backing, supply, liquid reserve, deploy
 * timestamp, age, realized gain, implied APR.
 *
 * Usage:
 *   RPC_URL="https://your-rpc/key" \
 *     bun run scripts/live-numbers.ts
 */

import { Connection, PublicKey } from '@solana/web3.js'

async function main() {
  const rpc = process.env.RPC_URL
  if (!rpc) throw new Error('set RPC_URL env var')
  const conn = new Connection(rpc, 'confirmed')
  const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
  const acc = await conn.getAccountInfo(POOL, 'processed')
  if (!acc) throw new Error('pool missing')
  const totalLamports = acc.data.readBigUInt64LE(258)
  const supply = acc.data.readBigUInt64LE(266)
  const lastEpoch = acc.data.readBigUInt64LE(274)
  const reserve = new PublicKey(acc.data.subarray(130, 162))
  const reserveAcc = await conn.getAccountInfo(reserve, 'processed')
  const rate = Number(totalLamports) / Number(supply)
  const sol = Number(totalLamports) / 1e9
  const stac = Number(supply) / 1e9
  const liquid = reserveAcc ? reserveAcc.lamports / 1e9 : 0

  // Find true deploy timestamp via earliest pool tx
  const sigs = await conn.getSignaturesForAddress(POOL, { limit: 1000 })
  const earliest = sigs[sigs.length - 1]
  const deployTs = earliest?.blockTime ?? null

  console.log('rate:', rate.toFixed(6))
  console.log('totalLamports SOL:', sol.toFixed(4))
  console.log('supply stacSOL:', stac.toFixed(4))
  console.log('liquid reserve SOL:', liquid.toFixed(4))
  console.log('lastUpdateEpoch:', lastEpoch.toString())
  console.log('reserve addr:', reserve.toBase58())
  if (deployTs) {
    const ageSec = Date.now() / 1000 - deployTs
    const ageDays = ageSec / 86400
    const ageHours = ageSec / 3600
    const realized = rate - 1
    const apr = (realized * 365 / ageDays) * 100
    console.log('deploy ts:', new Date(deployTs * 1000).toISOString())
    console.log('age:', ageDays.toFixed(2), 'days /', ageHours.toFixed(1), 'hrs')
    console.log('realized gain:', (realized * 100).toFixed(2) + '%')
    console.log('implied APR:', apr.toFixed(0) + '%')
  } else {
    console.log('deploy ts: unknown')
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
