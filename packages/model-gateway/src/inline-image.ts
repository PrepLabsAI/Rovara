import { record } from "./model-gateway-token.js";

/** Internal hold metadata, never forwarded to a provider or written as a new record kind. */
export interface InlineImageBound { tokens: number; dataBytes: number }
// Source packet dated 2026-11-22: https://platform.claude.com/docs/en/build-with-claude/vision
// and https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-anthropic-claude-messages.html
// ceil(w/28)*ceil(h/28), sides clamped to 8000; owner-approved high-res ceiling 4784.
// The fixed 256-token margin covers image overhead; actual usage still determines settlement.
// Use the conservative 200k-context count and Bedrock's stricter encoded-size limit on both Claude paths.
export const MAX_INLINE_IMAGES = 100;
const MAX_BASE64_BYTES = 5 * 1024 * 1024;
const MAX_JPEG_HEADER_BYTES = 64 * 1024;
// The whole GIF (at most MAX_BASE64_BYTES) is walked; this caps the frames walked before the image is refused.
export const MAX_GIF_FRAMES = 2048;
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const signature = (b: Buffer, at: number, hex: string): boolean => b.subarray(at, at + hex.length / 2).equals(Buffer.from(hex, "hex"));

// A JPEG decoder may keep any of several start-of-frame markers (Pillow keeps the LAST before SOS), so bound by
// the larger of every SOF width and every SOF height, and refuse a header that never reaches SOS within the cap.
function jpegDimensions(b: Buffer): [number, number] | undefined {
  if (!signature(b, 0, "ffd8")) return undefined;
  const end = Math.min(b.length, MAX_JPEG_HEADER_BYTES);
  let at = 2;
  let width = 0, height = 0, framed = false;
  while (at + 4 <= end) {
    if (b[at++] !== 0xff) return undefined;
    while (b[at] === 0xff) at++;
    const marker = b[at++]!;
    // Standalone markers carry no length; a decoder may skip them where this scan would misread them as segments.
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) return undefined;
    const size = b.readUInt16BE(at);
    if (size < 2 || at + size > end) return undefined;
    if (SOF.has(marker)) {
      // A complete SOF includes precision, dimensions and all component descriptors.
      if (size < 8 || size !== 8 + 3 * b[at + 7]!) return undefined;
      width = Math.max(width, b.readUInt16BE(at + 5)); height = Math.max(height, b.readUInt16BE(at + 3)); framed = true;
    } else if (marker === 0xda) return framed ? [width, height] : undefined;
    at += size;
  }
  return undefined;
}

/** Skips a run of data sub-blocks; returns the offset after its zero terminator, or undefined if it runs off the end. */
function gifSubBlocks(b: Buffer, from: number): number | undefined {
  let at = from;
  for (;;) {
    if (at >= b.length) return undefined;
    const size = b[at++]!;
    if (size === 0) return at;
    at += size;
  }
}

// Decoders size a GIF from its frames as well as its logical screen (Pillow grows the canvas to every frame), so
// walk the blocks and bound by max(screen, every frame's left+width / top+height). Anything the walk cannot finish
// (no frame, no trailer, an unknown block, more frames than the cap) is unbounded and refused: never under-estimate.
function gifDimensions(b: Buffer): [number, number] | undefined {
  if (b.length < 13 || !/^GIF8[79]a$/u.test(b.toString("latin1", 0, 6))) return undefined;
  let width = b.readUInt16LE(6), height = b.readUInt16LE(8);
  let at = 13 + (b[10]! & 0x80 ? 3 << ((b[10]! & 7) + 1) : 0);
  let frames = 0;
  while (at < b.length) {
    const block = b[at++]!;
    if (block === 0x3b) return frames === 0 ? undefined : [width, height];
    if (block === 0x21) { // extension: label byte, then data sub-blocks
      const next = gifSubBlocks(b, at + 1);
      if (next === undefined) return undefined;
      at = next;
    } else if (block === 0x2c) { // image descriptor: left, top, width, height, packed
      if (++frames > MAX_GIF_FRAMES || at + 9 > b.length) return undefined;
      width = Math.max(width, b.readUInt16LE(at) + b.readUInt16LE(at + 4));
      height = Math.max(height, b.readUInt16LE(at + 2) + b.readUInt16LE(at + 6));
      const packed = b[at + 8]!;
      at += 9 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0) + 1; // local colour table, LZW code size byte
      const next = gifSubBlocks(b, at);
      if (next === undefined) return undefined;
      at = next;
    } else return undefined;
  }
  return undefined;
}

function webpDimensions(b: Buffer): [number, number] | undefined {
  if (b.length < 20 || !signature(b, 0, "52494646") || !signature(b, 8, "57454250")) return undefined;
  if (b.readUInt32LE(4) + 8 !== b.length) return undefined;
  const size = b.readUInt32LE(16);
  if (size > b.length - 20) return undefined;
  switch (b.toString("latin1", 12, 16)) {
    case "VP8X":
      if (size !== 10) return undefined;
      return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    case "VP8L": {
      if (size < 5 || b[20] !== 0x2f) return undefined;
      const bits = b.readUInt32LE(21);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
    case "VP8 ":
      if (size < 10 || !signature(b, 23, "9d012a")) return undefined;
      return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    default: return undefined;
  }
}

function dimensions(b: Buffer, mime: unknown): [number, number] | undefined {
  switch (mime) {
    case "image/png":
      if (b.length < 33 || !signature(b, 0, "89504e470d0a1a0a0000000d49484452")) return undefined;
      return [b.readUInt32BE(16), b.readUInt32BE(20)];
    case "image/gif":
      return gifDimensions(b);
    case "image/jpeg": return jpegDimensions(b);
    case "image/webp": return webpDimensions(b);
    default: return undefined;
  }
}

/** Header inspection only: no decompression, pixels, remote reads or caller-supplied dimensions. */
export function inlineImageBound(block: Record<string, unknown>): InlineImageBound | undefined {
  const source = record(block.source);
  if (source?.type !== "base64" || typeof source.data !== "string" || source.data.length === 0 || source.data.length > MAX_BASE64_BYTES) return undefined;
  const data = Buffer.from(source.data, "base64");
  // Buffer's decoder accepts invalid suffixes/whitespace; require the exact canonical encoding.
  if (data.toString("base64") !== source.data) return undefined;
  let size: [number, number] | undefined;
  try { size = dimensions(data, source.media_type); } catch { return undefined; }
  if (size === undefined || size[0] === 0 || size[1] === 0) return undefined;
  const patches = Math.ceil(Math.min(size[0], 8000) / 28) * Math.ceil(Math.min(size[1], 8000) / 28);
  return { tokens: Math.min(patches, 4784) + 256, dataBytes: source.data.length };
}
