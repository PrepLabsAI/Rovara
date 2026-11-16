// Test support (device testing slice 4): a tiny PNG writer, so the decoder is tested against files whose every byte the test chose (a filter per row, a channel count, a chunk order).
import { crc32, deflateSync } from "node:zlib";

export function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}
export function header(width: number, height: number, depth = 8, colour = 6, interlace = 0): Uint8Array {
  const body = new Uint8Array(13);
  const view = new DataView(body.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  body.set([depth, colour, 0, 0, interlace], 8);
  return chunk("IHDR", body);
}
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const join = (...parts: Uint8Array[]): Uint8Array => { const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { out.set(part, at); at += part.length; } return out; };
const paeth = (a: number, b: number, c: number) => { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** A PNG of `rgb(x, y)` pixels, each row written with the given filter (cycled): 0 none, 1 sub, 2 up, 3 average, 4 Paeth. `channels` 3 writes RGB, 4 RGBA (alpha as given, default 255). */
export function png(width: number, height: number, rgb: (x: number, y: number) => [number, number, number], options: { filters?: number[]; channels?: 3 | 4; alpha?: number; extra?: Uint8Array[]; idatSplit?: number } = {}): Uint8Array {
  const channels = options.channels ?? 4;
  const filters = options.filters ?? [0];
  const row = width * channels;
  const rows: Uint8Array[] = [];
  let previous = new Uint8Array(row);
  for (let y = 0; y < height; y += 1) {
    const line = new Uint8Array(row);
    for (let x = 0; x < width; x += 1) { const [r, g, b] = rgb(x, y); line.set(channels === 4 ? [r, g, b, options.alpha ?? 255] : [r, g, b], x * channels); }
    const filter = filters[y % filters.length]!;
    const out = new Uint8Array(row + 1);
    out[0] = filter;
    for (let x = 0; x < row; x += 1) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      const predicted = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      out[x + 1] = (line[x]! - predicted) & 0xff;
    }
    rows.push(out);
    previous = line;
  }
  const data = deflateSync(Buffer.from(join(...rows)));
  const split = options.idatSplit ?? data.length;
  const idats: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += split) idats.push(chunk("IDAT", data.subarray(at, at + split)));
  return join(SIGNATURE, header(width, height, 8, channels === 4 ? 6 : 2), ...(options.extra ?? []), ...idats, chunk("IEND", new Uint8Array(0)));
}
