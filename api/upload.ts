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

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { put } from '@vercel/blob'

export const config = {
  api: {
    bodyParser: false, // we need the raw multipart body
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

async function readMultipart(req: VercelRequest): Promise<{
  fields: Record<string, string>
  file: { name: string; type: string; buffer: Buffer } | null
}> {
  const contentType = req.headers['content-type'] ?? ''
  const match = contentType.match(/boundary=([^;]+)/i)
  if (!match) throw new Error('missing multipart boundary')
  const boundary = `--${match[1].trim()}`

  // Buffer the whole body. For metadata uploads (a meme image, a few KB of
  // text), this is fine. If we ever accept video we'd want streaming.
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  const body = Buffer.concat(chunks)
  const parts = body.toString('binary').split(boundary).slice(1, -1)

  const fields: Record<string, string> = {}
  let file: { name: string; type: string; buffer: Buffer } | null = null

  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const headerBlock = part.slice(2, headerEnd) // strip leading \r\n
    const rawBody = part.slice(headerEnd + 4, part.length - 2) // strip trailing \r\n
    const dispositionMatch = headerBlock.match(/name="([^"]+)"(?:; filename="([^"]+)")?/i)
    if (!dispositionMatch) continue
    const fieldName = dispositionMatch[1]
    const fileName = dispositionMatch[2]
    if (fileName) {
      const typeMatch = headerBlock.match(/Content-Type:\s*([^\r\n]+)/i)
      const type = typeMatch ? typeMatch[1].trim() : 'application/octet-stream'
      file = {
        name: fileName,
        type,
        buffer: Buffer.from(rawBody, 'binary'),
      }
    } else {
      fields[fieldName] = Buffer.from(rawBody, 'binary').toString('utf-8')
    }
  }

  return { fields, file }
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
    const { fields, file } = await readMultipart(req)
    const { name, symbol } = fields
    if (!name || !symbol) {
      res.status(400).json({ error: 'name and symbol are required' })
      return
    }
    if (!file) {
      res.status(400).json({ error: 'image file is required' })
      return
    }

    // Upload image first so we have the public URL for the metadata JSON.
    const slug = symbol.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
    const ts = Date.now().toString(36)
    const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? 'png').toLowerCase()
    const imagePath = `stacc-launchpad/${slug}-${ts}.${ext}`

    const imageBlob = await put(imagePath, file.buffer, {
      access: 'public',
      contentType: file.type,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    })

    const metadata: MetadataJson = {
      name,
      symbol,
      description: fields.description?.slice(0, 1000),
      image: imageBlob.url,
      showName: true,
      twitter: fields.twitter || undefined,
      website: fields.website || undefined,
      telegram: fields.telegram || undefined,
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
