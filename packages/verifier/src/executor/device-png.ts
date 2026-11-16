// Device testing slice 4 (DEC 244): a PNG reader for the iOS simulator's screenshots (`simctl io <device> screenshot --type=png`). The driver needs the pixels (to paint over what must be hidden), and
// the repository has no image dependency, so this reads exactly what a screenshot is: a non-interlaced 8-bit RGB or RGBA image. Anything else (a palette, 16 bits, interlacing, a missing or repeated
// header, a bad length, a checksum that does not match, a size over the pixel cap) is not a frame (undefined). Bounded: the size is read and checked BEFORE anything is inflated, and the inflate is
// held to exactly the bytes that size needs. The result's alpha is always opaque (a screenshot has none worth keeping, and the paint check compares whole pixels).
import { crc32, inflateSync } from "node:zlib";
import type { DeviceFrame } from "./device-evidence.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most bytes of a PNG file read (a screenshot of a phone is well under this). */
export const DEVICE_PNG_MAX_BYTES = 32 * 1_048_576;

/** The frame of a PNG, or undefined when it is not an 8-bit non-interlaced RGB or RGBA image of at most `maxPixels` pixels whose every chunk is whole and whose checksums match. Never throws. */
export function decodeDevicePng(bytes: unknown, maxPixels: number): DeviceFrame | undefined {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || bytes.byteLength > DEVICE_PNG_MAX_BYTES || !SIGNATURE.every((value, at) => bytes[at] === value)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; channels: 3 | 4 } | undefined;
  const parts: Uint8Array[] = [];
  let idatBytes = 0;
  let ended = false;
  let index = 0;
  while (at + 12 <= bytes.byteLength) {
    const length = view.getUint32(at);
    const typeStart = at + 4;
    const end = typeStart + 4 + length + 4;
    if (length > bytes.byteLength || end > bytes.byteLength) return undefined;
    const type = String.fromCharCode(bytes[typeStart]!, bytes[typeStart + 1]!, bytes[typeStart + 2]!, bytes[typeStart + 3]!);
    const body = bytes.subarray(typeStart + 4, typeStart + 4 + length);
    if (crc32(bytes.subarray(typeStart, typeStart + 4 + length)) !== view.getUint32(typeStart + 4 + length)) return undefined;
    if (index === 0) {
      if (type !== "IHDR" || length !== 13) return undefined;
      const width = view.getUint32(typeStart + 4);
      const height = view.getUint32(typeStart + 8);
      const depth = body[8];
      const colour = body[9];
      if (width < 1 || height < 1 || width * height > maxPixels || depth !== 8 || (colour !== 2 && colour !== 6) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) return undefined;
      header = { width, height, channels: colour === 2 ? 3 : 4 };
    } else if (type === "IHDR") return undefined;
    else if (type === "IDAT") {
      if (ended) return undefined;
      idatBytes += length;
      if (idatBytes > DEVICE_PNG_MAX_BYTES) return undefined;
      parts.push(body);
    } else if (type === "IEND") { ended = true; at = end; break; }
    // Every other chunk (colour profile, gamma, text, physical size) is skipped, its checksum already checked.
    index += 1;
    at = end;
  }
  if (header === undefined || !ended || at !== bytes.byteLength || parts.length === 0) return undefined;
  const { width, height, channels } = header;
  const row = width * channels;
  const expected = (row + 1) * height;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(parts), { maxOutputLength: expected + 1 }); } catch { return undefined; }
  if (raw.byteLength !== expected) return undefined;

  const rgba = new Uint8Array(width * height * 4);
  let previous: Uint8Array = new Uint8Array(row);
  let line: Uint8Array = new Uint8Array(row);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (row + 1)]!;
    const source = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    for (let x = 0; x < row; x += 1) {
      const left = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const upLeft = x >= channels ? previous[x - channels]! : 0;
      let value = source[x]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) return undefined;
      line[x] = value & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      rgba[out] = line[x * channels]!;
      rgba[out + 1] = line[x * channels + 1]!;
      rgba[out + 2] = line[x * channels + 2]!;
      rgba[out + 3] = 255;
    }
    [previous, line] = [line, previous];
  }
  return { width, height, rgba };
}
