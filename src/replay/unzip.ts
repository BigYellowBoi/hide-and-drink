/**
 * A minimal zip reader for saved games. Reads only the central directory; each file is a lazy
 * slice of the original File, so gigabytes of video are never loaded into memory. Handles
 * zip64 (client-zip writes it past 4 GB) and stored or deflated entries (deflated, in case
 * someone re-zipped a saved game).
 */

export interface ZipEntry {
  name: string
  size: number
  /** The file's bytes (decompressed if needed). */
  blob: () => Promise<Blob>
}

const EOCD = 0x06054b50
const EOCD64 = 0x06064b50
const EOCD64_LOCATOR = 0x07064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

async function bytes(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer())
}

const u64 = (v: DataView, at: number) => Number(v.getBigUint64(at, true))

export class ZipError extends Error {}

export async function readZip(file: Blob): Promise<Map<string, ZipEntry>> {
  // End of central directory: in the last 22 bytes plus up to 64 KB of comment.
  const tailStart = Math.max(0, file.size - 22 - 65_536)
  const tail = await bytes(file, tailStart, file.size)
  let eocd = -1
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipError('Not a zip file.')
  let count = tail.getUint16(eocd + 10, true)
  let cdSize = tail.getUint32(eocd + 12, true)
  let cdOffset = tail.getUint32(eocd + 16, true)
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === EOCD64_LOCATOR) {
    const at = u64(tail, eocd - 20 + 8)
    const rec = await bytes(file, at, at + 56)
    if (rec.getUint32(0, true) === EOCD64) {
      count = u64(rec, 32)
      cdSize = u64(rec, 40)
      cdOffset = u64(rec, 48)
    }
  }

  const cd = await bytes(file, cdOffset, cdOffset + cdSize)
  const decoder = new TextDecoder()
  const entries = new Map<string, ZipEntry>()
  let p = 0
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== CENTRAL) throw new ZipError('The zip looks damaged.')
    const method = cd.getUint16(p + 10, true)
    let compressed = cd.getUint32(p + 20, true)
    let size = cd.getUint32(p + 24, true)
    const nameLen = cd.getUint16(p + 28, true)
    const extraLen = cd.getUint16(p + 30, true)
    const commentLen = cd.getUint16(p + 32, true)
    let local = cd.getUint32(p + 42, true)
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen))
    // Zip64 extra field: the 0xFFFFFFFF values, in order.
    let e = p + 46 + nameLen
    const extraEnd = e + extraLen
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true)
      const len = cd.getUint16(e + 2, true)
      if (id === 0x0001) {
        let q = e + 4
        if (size === 0xffffffff) {
          size = u64(cd, q)
          q += 8
        }
        if (compressed === 0xffffffff) {
          compressed = u64(cd, q)
          q += 8
        }
        if (local === 0xffffffff) local = u64(cd, q)
      }
      e += 4 + len
    }
    p = extraEnd + commentLen
    if (name.endsWith('/')) continue
    if (method !== 0 && method !== 8) throw new ZipError(`Can't read ${name} (compression ${method}).`)
    const at = local
    const len = compressed
    entries.set(name, {
      name,
      size,
      blob: async () => {
        const head = await bytes(file, at, at + 30)
        if (head.getUint32(0, true) !== LOCAL) throw new ZipError('The zip looks damaged.')
        const start = at + 30 + head.getUint16(26, true) + head.getUint16(28, true)
        const raw = file.slice(start, start + len)
        if (method === 0) return raw
        return new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob()
      },
    })
  }
  return entries
}
