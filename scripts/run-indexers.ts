/**
 * Local indexer runner. Drives the Vercel cron handlers directly so the
 * dashboard DB keeps cranking even when Vercel crons are dead. Bun auto-loads
 * .env.local; we point DATABASE_URL at the real Neon (STORAGE2_DATABASE_URL)
 * if the local DATABASE_URL is still the placeholder.
 *
 *   bun run scripts/run-indexers.ts          # one pass of every indexer
 *   bun run scripts/run-indexers.ts --loop   # forever, every LOOP_MS
 */
if (!process.env.DATABASE_URL || /\/\/user:|@host\//.test(process.env.DATABASE_URL)) {
  process.env.DATABASE_URL = process.env.STORAGE2_DATABASE_URL!
}

import snapshot from '../api/snapshot.js'
import ingestPoolEvents from '../api/ingest-pool-events.js'
import referralIndex from '../api/referral-index.js'
import managerFeeIndex from '../api/manager-fee-index.js'
import ingestBurnEvents from '../api/ingest-burn-events.js'

type Handler = (req: any, res: any) => Promise<unknown> | unknown

const INDEXERS: Array<{ name: string; fn: Handler }> = [
  { name: 'snapshot', fn: snapshot as Handler },
  { name: 'ingest-pool-events', fn: ingestPoolEvents as Handler },
  { name: 'referral-index', fn: referralIndex as Handler },
  { name: 'manager-fee-index', fn: managerFeeIndex as Handler },
  { name: 'ingest-burn-events', fn: ingestBurnEvents as Handler },
]

function mockReqRes() {
  const captured: { code?: number; body?: unknown } = {}
  const res: any = {
    status(code: number) {
      captured.code = code
      return {
        json: (b: unknown) => ((captured.body = b), res),
        send: (b: unknown) => ((captured.body = b), res),
        end: () => res,
      }
    },
    setHeader: () => res,
    json: (b: unknown) => ((captured.body = b), res),
  }
  return { req: { query: {}, method: 'GET', headers: {} }, res, captured }
}

async function runOne(name: string, fn: Handler) {
  const { req, res, captured } = mockReqRes()
  const t0 = Date.now()
  try {
    await fn(req, res)
    const ms = Date.now() - t0
    const b: any = captured.body
    const summary =
      b && typeof b === 'object'
        ? JSON.stringify(b).slice(0, 220)
        : String(b ?? '')
    console.log(`[${new Date().toISOString()}] ${name} ${captured.code ?? '?'} (${ms}ms) ${summary}`)
  } catch (e: any) {
    console.error(`[${new Date().toISOString()}] ${name} THREW: ${e?.message ?? e}`)
  }
}

async function pass() {
  for (const { name, fn } of INDEXERS) await runOne(name, fn)
}

const LOOP = process.argv.includes('--loop')
const LOOP_MS = Number(process.env.LOOP_MS ?? 5 * 60_000)

if (LOOP) {
  console.log(`indexer loop every ${LOOP_MS}ms`)
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    await pass()
    await new Promise((r) => setTimeout(r, LOOP_MS))
  }
} else {
  await pass()
  process.exit(0)
}
