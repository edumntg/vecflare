// Segment file layout (little-endian):
//   0   u32 magic "VFS1"
//   4   u32 dim
//   8   u32 count
//   12  u32 idsBytes
//   16  reserved to 32
//   32  float32[count * dim]        vectors, row i at 32 + i*dim*4
//   ... ids block: per row u16 len + utf8 bytes
// Vectors come first so a point read is one fixed range request.

export const HEADER_BYTES = 32;
const MAGIC = 0x31534656; // "VFS1"

const enc = new TextEncoder();
const dec = new TextDecoder();

export function vectorRange(idx: number, dim: number): { offset: number; length: number } {
  return { offset: HEADER_BYTES + idx * dim * 4, length: dim * 4 };
}

export function estimateRowBytes(id: string, dim: number): number {
  return dim * 4 + 2 + id.length * 2;
}

export function encodeSegment(ids: string[], vectors: Float32Array, dim: number): Uint8Array {
  const count = ids.length;
  if (vectors.length !== count * dim) throw new Error("vectors length does not match ids * dim");
  const idBytes = ids.map((id) => enc.encode(id));
  let idsBytes = 0;
  for (const b of idBytes) {
    if (b.length > 0xffff) throw new Error("id too long");
    idsBytes += 2 + b.length;
  }
  const vecBytes = count * dim * 4;
  const out = new Uint8Array(HEADER_BYTES + vecBytes + idsBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, dim, true);
  view.setUint32(8, count, true);
  view.setUint32(12, idsBytes, true);
  out.set(new Uint8Array(vectors.buffer, vectors.byteOffset, vecBytes), HEADER_BYTES);
  let p = HEADER_BYTES + vecBytes;
  for (const b of idBytes) {
    view.setUint16(p, b.length, true);
    out.set(b, p + 2);
    p += 2 + b.length;
  }
  return out;
}

export class Segment {
  readonly dim: number;
  readonly count: number;
  readonly ids: string[];
  readonly vectors: Float32Array;
  readonly bytes: number;

  constructor(buf: ArrayBuffer) {
    const view = new DataView(buf);
    if (view.getUint32(0, true) !== MAGIC) throw new Error("bad segment magic");
    this.dim = view.getUint32(4, true);
    this.count = view.getUint32(8, true);
    const idsBytes = view.getUint32(12, true);
    const vecBytes = this.count * this.dim * 4;
    this.vectors = new Float32Array(buf, HEADER_BYTES, this.count * this.dim);
    const ids = new Array<string>(this.count);
    let p = HEADER_BYTES + vecBytes;
    const end = p + idsBytes;
    for (let i = 0; i < this.count; i++) {
      const len = view.getUint16(p, true);
      ids[i] = dec.decode(new Uint8Array(buf, p + 2, len));
      p += 2 + len;
    }
    if (p !== end) throw new Error("segment ids block length mismatch");
    this.ids = ids;
    this.bytes = buf.byteLength;
  }

  vector(idx: number): Float32Array {
    return this.vectors.subarray(idx * this.dim, (idx + 1) * this.dim);
  }
}
