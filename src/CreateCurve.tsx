// /create — launch a new bonding curve on the stacc curve-launchpad.
//
// Flow:
//   1. User fills out the form (name, symbol, description, image, socials).
//   2. POST multipart to /api/upload — server uploads image + Metaplex JSON
//      to Vercel Blob, returns { metadataUri }.
//   3. Generate a fresh mint Keypair client-side.
//   4. Build a transaction with `ixCurveCreate({ mint, creator, name, symbol,
//      uri: metadataUri })`. The mint Keypair co-signs.
//   5. Wallet signs, send, confirm.
//   6. On success, route the user to /trade?mint=<new mint pubkey>.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'

import { ixCurveCreate } from './lib/curve-launchpad'
import EditorialNav from './components/EditorialNav'
import WalletPill from './components/WalletPill'

interface UploadResponse {
  imageUrl: string
  metadataUri: string
  metadata: {
    name: string
    symbol: string
    image: string
  }
}

async function uploadMetadata(form: FormData): Promise<UploadResponse> {
  const res = await fetch('/api/upload', { method: 'POST', body: form })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body?.error || `upload failed (${res.status})`)
  }
  return res.json() as Promise<UploadResponse>
}

async function buildAndSendCreateTx(args: {
  connection: Connection
  creator: PublicKey
  mint: Keypair
  name: string
  symbol: string
  uri: string
  signTransaction: (
    tx: VersionedTransaction,
  ) => Promise<VersionedTransaction>
}): Promise<string> {
  const { connection, creator, mint, name, symbol, uri, signTransaction } = args

  const createIx = ixCurveCreate({
    mint: mint.publicKey,
    creator,
    name,
    symbol,
    uri,
  })

  // Modest priority fee — create is rent-heavy (mint, bonding curve PDA, ATA,
  // Metaplex metadata account) and we want it landed without retry pain.
  const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 50_000,
  })
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })

  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({
    payerKey: creator,
    recentBlockhash: blockhash,
    instructions: [priorityIx, cuIx, createIx],
  }).compileToV0Message()

  const tx = new VersionedTransaction(msg)
  // Mint keypair signs first; wallet adds the creator signature next.
  tx.sign([mint])
  const signed = await signTransaction(tx)

  const sig = await connection.sendTransaction(signed, {
    skipPreflight: false,
    maxRetries: 3,
  })
  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash,
      lastValidBlockHeight: (await connection.getBlockHeight('confirmed')) + 150,
    },
    'confirmed',
  )
  return sig
}

export default function CreateCurve() {
  const { connection } = useConnection()
  const { publicKey, signTransaction } = useWallet()

  // Editorial-design tokens (ivory/jade/ink) are scoped via
  // body[data-design="editorial"]; turn them on for this route only.
  useEffect(() => {
    document.body.setAttribute('data-design', 'editorial')
    return () => document.body.removeAttribute('data-design')
  }, [])

  const [name, setName] = useState('')
  const [symbol, setSymbol] = useState('')
  const [description, setDescription] = useState('')
  const [twitter, setTwitter] = useState('')
  const [website, setWebsite] = useState('')
  const [telegram, setTelegram] = useState('')
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'signing'; uri: string }
    | { kind: 'confirming'; sig: string; mint: string }
    | { kind: 'done'; sig: string; mint: string; uri: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const canSubmit = useMemo(() => {
    return (
      !!publicKey &&
      !!signTransaction &&
      !!name.trim() &&
      symbol.trim().length >= 1 &&
      symbol.trim().length <= 10 &&
      !!imageFile &&
      !busy
    )
  }, [publicKey, signTransaction, name, symbol, imageFile, busy])

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null
    setImageFile(f)
    setImagePreview(f ? URL.createObjectURL(f) : null)
  }

  const onSubmit = async () => {
    if (!publicKey || !signTransaction || !imageFile) return
    setBusy(true)
    setStatus({ kind: 'uploading' })

    try {
      const form = new FormData()
      form.append('name', name.trim())
      form.append('symbol', symbol.trim().toUpperCase())
      if (description.trim()) form.append('description', description.trim())
      if (twitter.trim()) form.append('twitter', twitter.trim())
      if (website.trim()) form.append('website', website.trim())
      if (telegram.trim()) form.append('telegram', telegram.trim())
      form.append('image', imageFile)

      const upload = await uploadMetadata(form)

      const mintKp = Keypair.generate()
      setStatus({ kind: 'signing', uri: upload.metadataUri })

      const sig = await buildAndSendCreateTx({
        connection,
        creator: publicKey,
        mint: mintKp,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        uri: upload.metadataUri,
        signTransaction,
      })

      setStatus({
        kind: 'done',
        sig,
        mint: mintKp.publicKey.toBase58(),
        uri: upload.metadataUri,
      })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message ?? 'failed' })
    } finally {
      setBusy(false)
    }
  }

  const reset = () => {
    setName('')
    setSymbol('')
    setDescription('')
    setTwitter('')
    setWebsite('')
    setTelegram('')
    setImageFile(null)
    setImagePreview(null)
    setStatus({ kind: 'idle' })
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  return (
    <>
      <EditorialNav pathname="/create" ctaSlot={<WalletPill />} />
      <div className="mx-auto max-w-2xl px-4 py-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">launch a curve</h1>
          <p className="mt-1 text-sm text-neutral-500">
            mint a new token on the stacc curve-launchpad. quote token is
            stacSOL (yield-bearing). freeze authority is auto-revoked at launch.
          </p>
        </header>

      <div className="grid gap-5">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">name</span>
          <input
            className="w-full rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 32))}
            placeholder="my big bag"
            maxLength={32}
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">symbol</span>
          <input
            className="w-full rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm uppercase outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
            value={symbol}
            onChange={(e) =>
              setSymbol(e.target.value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10))
            }
            placeholder="MYBAG"
            maxLength={10}
            disabled={busy}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">description</span>
          <textarea
            className="w-full resize-none rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 500))}
            placeholder="optional"
            rows={3}
            maxLength={500}
            disabled={busy}
          />
        </label>

        <div>
          <span className="mb-1 block text-sm font-medium">image</span>
          <div className="flex items-center gap-4">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={onFileChange}
              disabled={busy}
              className="block w-full cursor-pointer rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-200 file:px-3 file:py-1 file:text-xs hover:file:bg-neutral-300 dark:border-neutral-700 dark:bg-neutral-900/40 dark:file:bg-neutral-800 dark:file:text-neutral-100"
            />
            {imagePreview && (
              <img
                src={imagePreview}
                alt="preview"
                className="h-16 w-16 rounded-lg object-cover ring-1 ring-neutral-300 dark:ring-neutral-700"
              />
            )}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">twitter</span>
            <input
              className="w-full rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
              value={twitter}
              onChange={(e) => setTwitter(e.target.value)}
              placeholder="@handle"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">website</span>
            <input
              className="w-full rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
              value={website}
              onChange={(e) => setWebsite(e.target.value)}
              placeholder="https://"
              disabled={busy}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">telegram</span>
            <input
              className="w-full rounded-lg border border-neutral-300 bg-white/50 px-3 py-2 text-sm outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/40"
              value={telegram}
              onChange={(e) => setTelegram(e.target.value)}
              placeholder="t.me/..."
              disabled={busy}
            />
          </label>
        </div>

        {!publicKey ? (
          <div className="rounded-lg border border-neutral-300 bg-neutral-100/50 px-3 py-3 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/40 dark:text-neutral-400">
            connect a wallet to launch.
          </div>
        ) : null}

        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSubmit}
          className="rounded-lg bg-neutral-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {busy
            ? status.kind === 'uploading'
              ? 'uploading metadata…'
              : status.kind === 'signing'
                ? 'awaiting wallet signature…'
                : 'confirming…'
            : 'launch'}
        </button>

        {status.kind === 'done' && (
          <div className="rounded-lg border border-emerald-400 bg-emerald-50 p-4 text-sm dark:border-emerald-700 dark:bg-emerald-950/40">
            <div className="font-medium text-emerald-700 dark:text-emerald-300">
              launched.
            </div>
            <div className="mt-2 grid gap-1 text-xs text-emerald-900/80 dark:text-emerald-100/80">
              <div>
                mint:{' '}
                <a
                  className="font-mono underline"
                  href={`https://solscan.io/token/${status.mint}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {status.mint}
                </a>
              </div>
              <div>
                tx:{' '}
                <a
                  className="font-mono underline"
                  href={`https://solscan.io/tx/${status.sig}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {status.sig.slice(0, 12)}…
                </a>
              </div>
              <div>
                metadata:{' '}
                <a
                  className="font-mono underline"
                  href={status.uri}
                  target="_blank"
                  rel="noreferrer"
                >
                  {status.uri.split('/').slice(-1)[0]}
                </a>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <a
                href={`/trade?mint=${status.mint}`}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700"
              >
                trade →
              </a>
              <button
                onClick={reset}
                type="button"
                className="rounded-md border border-emerald-600 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-400 dark:text-emerald-300 dark:hover:bg-emerald-950"
              >
                launch another
              </button>
            </div>
          </div>
        )}

        {status.kind === 'error' && (
          <div className="rounded-lg border border-red-400 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
            {status.message}
          </div>
        )}
        </div>
      </div>
    </>
  )
}
