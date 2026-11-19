// Device testing slice 2 (DEC 244): the real JPEG encoder the device-evidence runner is given (`encodeJpeg`, slice 1 left it to the caller). Baseline JPEG (JFIF, 8 bits, Huffman, three components,
// no subsampling), written here so that Rovara adds no image dependency to the executor: the pictures are screenshots of phone screens (flat areas, text, black paint), which this format holds well.
// The painted rectangles are already in the pixels when this runs; this file never looks at what a picture shows. Deterministic (the same pixels and quality give the same bytes), bounded
// (pixels, quality ladder) and never throws on a frame it can encode; a frame it cannot is refused with a fixed sentence.
import type { DeviceFrame } from "./device-evidence.js";

/** The most pixels one picture may have (the runner's own cap, `DEVICE_EVIDENCE_FRAME_PIXELS_MAX`, is lower); the JPEG format itself stops at 65,535 on a side. */
const SIDE_MAX = 65_535;
/** The qualities tried, best first, until the picture fits the cap. */
export const DEVICE_JPEG_QUALITIES: readonly number[] = Object.freeze([80, 65, 50, 35, 20]);

// ---- the standard tables (ITU T.81 Annex K): luminance quantisation and chrominance quantisation, in natural (row by row) order
const LUMA_Q = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const CHROMA_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array<number>(32).fill(99)];
const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31,
  39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
/** Where each natural-order coefficient sits in the zigzag scan. */
const ZIGZAG_AT = (() => { const at = new Uint8Array(64); ZIGZAG.forEach((natural, scan) => { at[natural] = scan; }); return at; })();
// The Huffman tables (Annex K.3.3 and K.3.5, the "luminance" ones: all three components use them): how many codes of each length 1 to 16, then the symbols in code order.
export const DEVICE_JPEG_DC_COUNTS: readonly number[] = Object.freeze([0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
export const DEVICE_JPEG_DC_SYMBOLS: readonly number[] = Object.freeze([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
export const DEVICE_JPEG_AC_COUNTS: readonly number[] = Object.freeze([0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]);
export const DEVICE_JPEG_AC_SYMBOLS: readonly number[] = Object.freeze([
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a,
  0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a,
  0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7,
  0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
]);

/** The canonical code of each symbol: `code[symbol]` and `length[symbol]` (length 0: the symbol has no code). */
function huffmanCodes(counts: readonly number[], symbols: readonly number[]): { code: Uint16Array; length: Uint8Array } {
  const code = new Uint16Array(256);
  const length = new Uint8Array(256);
  let next = 0;
  let at = 0;
  for (let bits = 1; bits <= 16; bits += 1) {
    for (let index = 0; index < counts[bits - 1]!; index += 1) { code[symbols[at]!] = next; length[symbols[at]!] = bits; next += 1; at += 1; }
    next <<= 1;
  }
  return { code, length };
}
const DC = huffmanCodes(DEVICE_JPEG_DC_COUNTS, DEVICE_JPEG_DC_SYMBOLS);
const AC = huffmanCodes(DEVICE_JPEG_AC_COUNTS, DEVICE_JPEG_AC_SYMBOLS);

/** The 8-point DCT matrix: `COS[u * 8 + x] = c(u) * cos((2x + 1) u pi / 16) / 2`, so a block's transform is `C * block * C^T`. */
const COS = new Float32Array(64);
for (let u = 0; u < 8; u += 1) for (let x = 0; x < 8; x += 1) COS[u * 8 + x] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;

const scaled = (base: readonly number[], quality: number): Uint8Array => {
  const factor = quality < 50 ? 5_000 / quality : 200 - 2 * quality;
  return Uint8Array.from(base, (value) => Math.min(255, Math.max(1, Math.floor((value * factor + 50) / 100))));
};

class BitWriter {
  private readonly chunks: number[] = [];
  private bits = 0;
  private count = 0;
  put(value: number, length: number): void {
    // The value's low `length` bits, most significant first. At most 16 at a time, so the 32-bit accumulator never overflows.
    this.bits = (this.bits << length) | (value & ((1 << length) - 1));
    this.count += length;
    while (this.count >= 8) {
      const byte = (this.bits >>> (this.count - 8)) & 0xff;
      this.chunks.push(byte);
      if (byte === 0xff) this.chunks.push(0);
      this.count -= 8;
    }
    this.bits &= (1 << this.count) - 1;
  }
  /** The last partial byte is padded with 1 bits, as the format asks. */
  finish(): number[] { if (this.count > 0) this.put((1 << (8 - this.count)) - 1, 8 - this.count); return this.chunks; }
}

const word = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const segment = (marker: number, body: number[]) => [0xff, marker, ...word(body.length + 2), ...body];

/** The JPEG of `frame` at one quality (1 to 100). Throws a fixed sentence on a frame that is not pixels. */
export function encodeJpegAt(frame: DeviceFrame, quality: number): Uint8Array {
  const { width, height, rgba } = frame;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > SIDE_MAX || height > SIDE_MAX || !(rgba instanceof Uint8Array) || rgba.byteLength !== width * height * 4
    || !Number.isInteger(quality) || quality < 1 || quality > 100) throw new Error("the picture cannot be encoded");
  const lumaQ = scaled(LUMA_Q, quality);
  const chromaQ = scaled(CHROMA_Q, quality);
  const header = [
    0xff, 0xd8,
    ...segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...segment(0xdb, [0, ...ZIGZAG.map((index) => lumaQ[index]!)]),
    ...segment(0xdb, [1, ...ZIGZAG.map((index) => chromaQ[index]!)]),
    ...segment(0xc0, [8, ...word(height), ...word(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...segment(0xc4, [0x00, ...DEVICE_JPEG_DC_COUNTS, ...DEVICE_JPEG_DC_SYMBOLS]),
    ...segment(0xc4, [0x10, ...DEVICE_JPEG_AC_COUNTS, ...DEVICE_JPEG_AC_SYMBOLS]),
    ...segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]),
  ];
  const writer = new BitWriter();
  const previous = [0, 0, 0];
  const planes = [new Float32Array(64), new Float32Array(64), new Float32Array(64)] as const;
  const middle = new Float32Array(64);
  const coefficient = new Int32Array(64);
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      // The block's three planes, level-shifted; an edge block repeats the last row and column.
      for (let y = 0; y < 8; y += 1) {
        const row = Math.min(height - 1, top + y);
        for (let x = 0; x < 8; x += 1) {
          const at = (row * width + Math.min(width - 1, left + x)) * 4;
          const red = rgba[at]!;
          const green = rgba[at + 1]!;
          const blue = rgba[at + 2]!;
          planes[0][y * 8 + x] = 0.299 * red + 0.587 * green + 0.114 * blue - 128;
          planes[1][y * 8 + x] = -0.168736 * red - 0.331264 * green + 0.5 * blue;
          planes[2][y * 8 + x] = 0.5 * red - 0.418688 * green - 0.081312 * blue;
        }
      }
      for (let component = 0; component < 3; component += 1) {
        const plane = planes[component]!;
        const table = component === 0 ? lumaQ : chromaQ;
        // rows: middle = block * C^T; then columns: out = C * middle
        for (let y = 0; y < 8; y += 1) for (let u = 0; u < 8; u += 1) { let sum = 0; for (let x = 0; x < 8; x += 1) sum += plane[y * 8 + x]! * COS[u * 8 + x]!; middle[y * 8 + u] = sum; }
        for (let v = 0; v < 8; v += 1) {
          for (let u = 0; u < 8; u += 1) {
            let sum = 0;
            for (let y = 0; y < 8; y += 1) sum += COS[v * 8 + y]! * middle[y * 8 + u]!;
            // An AC value is at most 10 bits in this table; a DC value may take 11 (its difference 12 is never reached by eight-bit samples).
            const scaledValue = Math.round(sum / table[v * 8 + u]!);
            coefficient[ZIGZAG_AT[v * 8 + u]!] = v === 0 && u === 0 ? scaledValue : Math.max(-1_023, Math.min(1_023, scaledValue));
          }
        }
        // DC: the difference from this component's last block, as a size and its bits.
        const diff = coefficient[0]! - previous[component]!;
        previous[component] = coefficient[0]!;
        const size = diff === 0 ? 0 : 32 - Math.clz32(Math.abs(diff));
        writer.put(DC.code[size]!, DC.length[size]!);
        if (size > 0) writer.put(diff < 0 ? diff - 1 : diff, size);
        // AC: runs of zeros, each nonzero value as (run, size) and its bits; ZRL for sixteen zeros; EOB when only zeros are left.
        let run = 0;
        for (let index = 1; index < 64; index += 1) {
          const value = coefficient[index]!;
          if (value === 0) { run += 1; continue; }
          while (run > 15) { writer.put(AC.code[0xf0]!, AC.length[0xf0]!); run -= 16; }
          const bits = 32 - Math.clz32(Math.abs(value));
          const symbol = (run << 4) | bits;
          writer.put(AC.code[symbol]!, AC.length[symbol]!);
          writer.put(value < 0 ? value - 1 : value, bits);
          run = 0;
        }
        if (run > 0) writer.put(AC.code[0x00]!, AC.length[0x00]!);
      }
    }
  }
  const scan = writer.finish();
  const out = new Uint8Array(header.length + scan.length + 2);
  out.set(header);
  out.set(scan, header.length);
  out.set([0xff, 0xd9], header.length + scan.length);
  return out;
}

/**
 * The JPEG the runner keeps: the best quality that fits `maxBytes` (the pack's screenshot cap), trying `DEVICE_JPEG_QUALITIES` in turn. If even the lowest is over the cap, that one is returned and the
 * runner reports "over the size cap": a picture is never cut or kept over the cap. Throws on a frame that is not pixels (the runner reads that as "the screenshot could not be taken").
 */
export function encodeDeviceJpeg(frame: DeviceFrame, maxBytes: number): Uint8Array {
  let last: Uint8Array | undefined;
  for (const quality of DEVICE_JPEG_QUALITIES) {
    last = encodeJpegAt(frame, quality);
    if (last.byteLength <= maxBytes) return last;
  }
  return last!;
}
