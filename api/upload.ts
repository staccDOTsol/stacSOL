// /api/upload — receives a multipart form with the curve's image + metadata
// fields (name, symbol, description, twitter, website, telegram), uploads the
// image to Vercel Blob, generates a Metaplex-compatible JSON pointing at it,
// uploads the JSON too, and returns both URLs to the caller.
//
// The frontend then passes `metadataUri` to `ixCurveCreate` as the on-chain
// `uri` field. The `imageUrl` is just returned for the UI preview.
//
// BLOB_READ_WRITE_TOKEN is sourced from process.env. Keep it server-side only;
// never inline into client bundles.
//
// Multipart parsing uses `formidable` (battle-tested) — earlier hand-rolled
// loop didn't reliably get the body in vercel-dev because @vercel/node's
// runtime had already consumed the stream.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'
import formidable from 'formidable'
import { readFile } from 'node:fs/promises'

export const config = {
  api: {
    bodyParser: false, // formidable owns the body
  },
}

interface MetadataJson {
  name: string
  symbol: string
  description?: string
  image: string
  showName?: boolean
  twitter?: string
  website?: string
  telegram?: string
  createdAt: string
}

function fieldVal(v: string | string[] | undefined): string {
  if (!v) return ''
  return Array.isArray(v) ? v[0] ?? '' : v
}

async function parseForm(req: VercelRequest): Promise<{
  fields: formidable.Fields
  file: formidable.File | null
}> {
  const form = formidable({
    multiples: false,
    maxFileSize: 8 * 1024 * 1024, // 8 MB — meme images, not videos
    keepExtensions: true,
  })
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err)
        return
      }
      const f = files.image
      const file = Array.isArray(f) ? f[0] ?? null : (f ?? null)
      resolve({ fields, file })
    })
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' })
    return
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.status(500).json({ error: 'BLOB_READ_WRITE_TOKEN not configured' })
    return
  }

  try {
    const { fields, file } = await parseForm(req)
    const name = fieldVal(fields.name).trim()
    const symbol = fieldVal(fields.symbol).trim()
    if (!name || !symbol) {
      res.status(400).json({ error: 'name and symbol are required' })
      return
    }
    if (!file) {
      res.status(400).json({ error: 'image file is required' })
      return
    }

    const buf = await readFile(file.filepath)

    const slug = symbol.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
    const ts = Date.now().toString(36)
    const ext = (file.originalFilename?.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase()
    const imagePath = `stacc-launchpad/${slug}-${ts}.${ext}`

    const imageBlob = await put(imagePath, buf, {
      access: 'public',
      contentType: file.mimetype ?? 'image/png',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })

    const metadata: MetadataJson = {
      name,
      symbol,
      description: fieldVal(fields.description).trim().slice(0, 1000) || undefined,
      image: imageBlob.url,
      showName: true,
      twitter: fieldVal(fields.twitter).trim() || undefined,
      website: fieldVal(fields.website).trim() || undefined,
      telegram: fieldVal(fields.telegram).trim() || undefined,
      createdAt: new Date().toISOString(),
    }

    const metadataPath = `stacc-launchpad/${slug}-${ts}.json`
    const metadataBlob = await put(metadataPath, JSON.stringify(metadata, null, 2), {
      access: 'public',
      contentType: 'application/json',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })

    res.status(200).json({
      imageUrl: imageBlob.url,
      metadataUri: metadataBlob.url,
      metadata,
    })
  } catch (err) {
    console.error('[api/upload]', err)
    res.status(500).json({ error: (err as Error).message ?? 'upload failed' })
  }
}
