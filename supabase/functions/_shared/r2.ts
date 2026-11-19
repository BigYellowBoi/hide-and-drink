// R2 through its S3 API: presigned URLs (SigV4 query signing) and object checks.

import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { objectUrl, parseListKeys, type R2Config } from './media.ts'

export function r2Client(cfg: R2Config) {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: 's3',
    region: 'auto',
  })

  /** A URL the phone can PUT or GET without credentials, for expiresS seconds. */
  const presign = async (method: 'PUT' | 'GET', name: string, expiresS: number) => {
    const url = new URL(objectUrl(cfg, name))
    url.searchParams.set('X-Amz-Expires', String(expiresS))
    const signed = await aws.sign(new Request(url, { method }), { aws: { signQuery: true } })
    return signed.url
  }

  /** The object's size in bytes, or null if it isn't there. */
  const size = async (name: string): Promise<number | null> => {
    const res = await aws.fetch(objectUrl(cfg, name), { method: 'HEAD' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`R2 HEAD ${res.status}`)
    const n = Number(res.headers.get('content-length'))
    return Number.isFinite(n) ? n : null
  }

  const remove = async (name: string) => {
    const res = await aws.fetch(objectUrl(cfg, name), { method: 'DELETE' })
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${res.status}`)
  }

  /** Every key under a prefix (e.g. a game's folder), page by page. */
  const list = async (prefix: string) => {
    const keys: string[] = []
    let token: string | null = null
    do {
      const url = new URL(`https://${cfg.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(cfg.bucket)}`)
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', prefix)
      if (token) url.searchParams.set('continuation-token', token)
      const res = await aws.fetch(url.toString(), { method: 'GET' })
      if (!res.ok) throw new Error(`R2 LIST ${res.status}`)
      const page = parseListKeys(await res.text())
      keys.push(...page.keys)
      token = page.next
    } while (token)
    return keys
  }

  return { presign, size, remove, list }
}
