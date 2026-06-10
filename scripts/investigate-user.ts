/**
 * Diagnostic dump: full stacSOL position breakdown for a wallet — wallet
 * + LP holdings, ownership classification (direct vs HawkFi PDA), recent
 * tx history, mint/burn cost basis, and current mark-to-NAV / burn-net
 * P&L. Useful for support DMs ("why am I at X SOL after Y deposits").
 *
 * Usage:
 *   RPC_URL="https://your-rpc/key" \
 *     bun run scripts/investigate-user.ts <wallet-pubkey>
 */

import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'

const RPC = process.env.RPC_URL
if (!RPC) throw new Error('set RPC_URL env var')

const userArg = process.argv[2]
if (!userArg) {
  throw new Error(
    'usage: bun run scripts/investigate-user.ts <wallet-pubkey>',
  )
}
const USER = new PublicKey(userArg)
const STACSOL_MINT = new PublicKey('6K4xdfEk5rvySM496rxm4x8AgC9wVt7N4C7mFFpNAj5f')
const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

const METEORA_POOLS = [
  { name: 'WSOL', poolAddress: 'AhioAr1uitCVfJ2Fi3rh19pGi9brEVAj9iyLT6Fw5eXf' },
  { name: 'USDC', poolAddress: '6qrxgP5XsEdQHcdo5UFQS9LyfELWXvnMNhA6pF6YqjFj' },
  { name: 'Staccana', poolAddress: '245kUb1aHRaFL5QGw28DxY96Y1P5xLAWjUJc1Ckg7Y5P' },
  { name: 'FOMOX402', poolAddress: '2z83AkxqfvqFGLJyuuVuvpXB9gT2XTr42T3VqB281s3C' },
  { name: 'PROOFV3', poolAddress: 'AJA9HAXTFHFTMZLL34VxXaYR7tXMBKJbPwroHEpeRr4V' },
]

const HAWKFI_PROGRAM = new PublicKey('iyfMb1AdFnksWDx2pTKQXgkMtjkEKQDXpfQNxYgL3aB')
const META_DLMM = new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo')

function deriveUserPda(owner: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_pda'), owner.toBuffer()],
    HAWKFI_PROGRAM,
  )
  return pda
}

async function main() {
  const conn = new Connection(RPC, 'confirmed')
  const userPda = deriveUserPda(USER)

  console.log('USER:', USER.toBase58())
  console.log('userPDA (HawkFi):', userPda.toBase58())
  console.log('---')

  const solBal = await conn.getBalance(USER)
  console.log(`SOL balance: ${(solBal / LAMPORTS_PER_SOL).toFixed(6)} SOL`)

  // stacSOL ATA
  const stacAta = getAssociatedTokenAddressSync(
    STACSOL_MINT, USER, false, TOKEN_2022, ASSOCIATED_TOKEN_PROGRAM_ID,
  )
  let stacBal = 0n
  try {
    const acc = await conn.getAccountInfo(stacAta)
    if (acc) stacBal = acc.data.readBigUInt64LE(64)
  } catch {}
  console.log(`stacSOL wallet ATA: ${(Number(stacBal) / 1e9).toFixed(6)}`)
  console.log(`  ata addr: ${stacAta.toBase58()}`)

  // Inline pool state read (avoids importing src/ which uses import.meta.env)
  const POOL = new PublicKey('E6oqvrLKexQwFJyCnQ8ewx8xt9tQo7uezat24f5Qixqb')
  const poolAcc = await conn.getAccountInfo(POOL, 'processed')
  if (!poolAcc) throw new Error('pool not found')
  const totalLamports = poolAcc.data.readBigUInt64LE(258)
  const tokenSupply = poolAcc.data.readBigUInt64LE(266)
  const rate = Number(totalLamports) / Number(tokenSupply)
  console.log(`current NAV rate: ${rate.toFixed(6)} SOL/stacSOL  (totalLamports=${totalLamports}, supply=${tokenSupply})`)

  console.log('---')

  // DLMM positions across both wallet and userPDA
  const DLMMmod = await import('@meteora-ag/dlmm')
  const DLMM = (DLMMmod as any).default

  let totalStacInLp = 0n
  let totalSolValueLp = 0
  let totalUnclaimedFees: { x: bigint; y: bigint } = { x: 0n, y: 0n }
  const breakdown: any[] = []

  for (const mp of METEORA_POOLS) {
    try {
      const dlmm = await DLMM.create(conn, new PublicKey(mp.poolAddress))
      const [direct, hawk] = await Promise.all([
        dlmm.getPositionsByUserAndLbPair(USER).catch(() => null),
        dlmm.getPositionsByUserAndLbPair(userPda).catch(() => null),
      ])
      const positions: any[] = []
      const seen = new Set<string>()
      for (const src of [direct, hawk]) {
        if (!src) continue
        for (const p of src.userPositions) {
          const k = p.publicKey.toBase58()
          if (seen.has(k)) continue
          seen.add(k)
          positions.push({
            ...p,
            ownership: src === direct ? 'direct' : 'hawkfi',
          })
        }
      }
      for (const pos of positions) {
        const lb = pos.positionData
        const xAtom = BigInt(lb.totalXAmount.toString())
        const yAtom = BigInt(lb.totalYAmount.toString())
        const feeX = BigInt(lb.feeX?.toString() ?? '0')
        const feeY = BigInt(lb.feeY?.toString() ?? '0')
        // tokenX/Y vary per pool - need to know which side is stacSOL
        const isStacX = mp.name !== 'USDC' && mp.name !== 'WSOL' // for our pools
        // Actually use the pool def
        const { METEORA_POOLS: defs } = await import('../src/lib/meteora-pools')
        const def = defs.find((d) => d.poolAddress === mp.poolAddress)!
        const isStacXReal = def.tokenX === STACSOL_MINT.toBase58()
        const stacAtom = isStacXReal ? xAtom : yAtom
        const otherAtom = isStacXReal ? yAtom : xAtom
        const stacFeeAtom = isStacXReal ? feeX : feeY
        const otherFeeAtom = isStacXReal ? feeY : feeX

        totalStacInLp += stacAtom
        const solValue = (Number(stacAtom) / 1e9) * rate
        totalSolValueLp += solValue

        breakdown.push({
          pool: mp.name,
          ownership: pos.ownership,
          posKey: pos.publicKey.toBase58(),
          stacUI: (Number(stacAtom) / 1e9).toFixed(6),
          otherUI: (Number(otherAtom) / Math.pow(10, def.decimals)).toFixed(6),
          otherSym: def.name,
          unclaimedStacFee: (Number(stacFeeAtom) / 1e9).toFixed(6),
          unclaimedOtherFee: (Number(otherFeeAtom) / Math.pow(10, def.decimals)).toFixed(6),
          stacAsSol: solValue.toFixed(6),
        })
      }
    } catch (e) {
      console.log(`  pool ${mp.name}: failed (${(e as Error).message.slice(0, 80)})`)
    }
  }

  console.log('DLMM positions:')
  if (breakdown.length === 0) {
    console.log('  (none)')
  } else {
    for (const b of breakdown) {
      console.log(
        `  ${b.pool} [${b.ownership}] pos=${b.posKey.slice(0, 8)}…  ${b.stacUI} stacSOL + ${b.otherUI} ${b.otherSym}  (≈ ${b.stacAsSol} SOL of stac at NAV)  fees: ${b.unclaimedStacFee} stac + ${b.unclaimedOtherFee} ${b.otherSym}`,
      )
    }
    console.log(`  TOTAL stacSOL in LPs: ${(Number(totalStacInLp) / 1e9).toFixed(6)}`)
    console.log(`  Total SOL-value of stac in LPs (at NAV ${rate.toFixed(6)}): ${totalSolValueLp.toFixed(6)} SOL`)
  }
  console.log('---')

  // Tx history — last 50 sigs
  const sigs = await conn.getSignaturesForAddress(USER, { limit: 50 })
  console.log(`recent ${sigs.length} txs (most recent first):`)
  let netSolIn = 0n // SOL deposited to mint stacSOL
  let netSolOut = 0n
  let mints = 0
  let burns = 0
  let depositsLp = 0
  let withdrawsLp = 0

  for (const s of sigs) {
    if (s.err) continue
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
    if (!tx) continue
    const meta = tx.meta
    if (!meta) continue
    const accountKeys = tx.transaction.message.getAccountKeys ?
      tx.transaction.message.getAccountKeys().keySegments().flat() :
      (tx.transaction.message as any).accountKeys
    const userIdx = accountKeys.findIndex((k: PublicKey) => k.equals(USER))
    if (userIdx < 0) continue

    const pre = meta.preBalances[userIdx]
    const post = meta.postBalances[userIdx]
    const solDelta = post - pre
    const ts = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '?'
    const fee = meta.fee
    const dt = new Date((s.blockTime ?? 0) * 1000)
    const ageHours = (Date.now() - (s.blockTime ?? 0) * 1000) / 3600000

    // stacSOL token-balance changes
    let stacDelta = 0n
    const preTb = meta.preTokenBalances ?? []
    const postTb = meta.postTokenBalances ?? []
    const preStac = preTb.find((b) => b.owner === USER.toBase58() && b.mint === STACSOL_MINT.toBase58())
    const postStac = postTb.find((b) => b.owner === USER.toBase58() && b.mint === STACSOL_MINT.toBase58())
    const preAmt = preStac ? BigInt(preStac.uiTokenAmount.amount) : 0n
    const postAmt = postStac ? BigInt(postStac.uiTokenAmount.amount) : 0n
    stacDelta = postAmt - preAmt

    // Check for HawkFi/DLMM program in instructions
    const programs = new Set(accountKeys.filter((_, i) => {
      const ixs = (tx.transaction.message as any).instructions ?? []
      return ixs.some((ix: any) => ix.programIdIndex === i)
    }).map((k: PublicKey) => k.toBase58()))

    // Compiled instructions
    const compiledIxs = (tx.transaction.message as any).compiledInstructions ??
      (tx.transaction.message as any).instructions ?? []
    const programIds = new Set<string>()
    for (const ix of compiledIxs) {
      const idx = ix.programIdIndex ?? ix.programIdIndex
      if (idx != null) {
        programIds.add(accountKeys[idx]?.toBase58?.() ?? '')
      }
    }

    let label = '?'
    if (programIds.has(META_DLMM.toBase58())) {
      label = stacDelta < 0n ? 'DLMM-deposit' : 'DLMM-withdraw'
      if (stacDelta < 0n) depositsLp++
      else if (stacDelta > 0n) withdrawsLp++
    } else if (stacDelta > 0n && solDelta < 0) {
      label = 'mint'
      mints++
      netSolIn += BigInt(-solDelta) - BigInt(fee)
    } else if (stacDelta < 0n && solDelta > 0) {
      label = 'burn'
      burns++
      netSolOut += BigInt(solDelta)
    }

    const stacUi = (Number(stacDelta) / 1e9).toFixed(6)
    const solUi = (solDelta / LAMPORTS_PER_SOL).toFixed(6)
    console.log(`  ${ts}  ${ageHours.toFixed(1)}h ago  ${label.padEnd(14)}  SOL Δ ${solUi.padStart(12)}  stacSOL Δ ${stacUi.padStart(12)}  ${s.signature.slice(0, 12)}…`)
  }
  console.log('---')
  console.log(`SUMMARY:`)
  console.log(`  mints: ${mints}, burns: ${burns}, DLMM-deposits: ${depositsLp}, DLMM-withdraws: ${withdrawsLp}`)
  console.log(`  net SOL in (mints): ${(Number(netSolIn) / LAMPORTS_PER_SOL).toFixed(6)}`)
  console.log(`  net SOL out (burns): ${(Number(netSolOut) / LAMPORTS_PER_SOL).toFixed(6)}`)
  console.log(`  current SOL: ${(solBal / LAMPORTS_PER_SOL).toFixed(6)}`)
  console.log(`  current stacSOL wallet: ${(Number(stacBal) / 1e9).toFixed(6)}`)
  console.log(`  current stacSOL in LPs: ${(Number(totalStacInLp) / 1e9).toFixed(6)}`)
  const totalStac = stacBal + totalStacInLp
  console.log(`  TOTAL stacSOL holdings: ${(Number(totalStac) / 1e9).toFixed(6)}`)
  console.log(`  TOTAL stacSOL × NAV (${rate.toFixed(6)}): ${((Number(totalStac) / 1e9) * rate).toFixed(6)} SOL`)
  console.log(`  TOTAL stacSOL × NAV × 0.931 (after burn fee): ${((Number(totalStac) / 1e9) * rate * 0.931).toFixed(6)} SOL`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
