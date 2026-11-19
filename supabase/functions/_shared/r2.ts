// R2 through its S3 API: presigned URLs (SigV4 query signing) and object checks.

import { AwsClient } from 'npm:aws4fetch@1.0.20'
import { objectUrl, type R2Config } from './media.ts'

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

  return { presign, size, remove }
}
