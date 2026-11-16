// Test support (device testing slice 2): a small baseline JPEG decoder, only for what Rovara's own encoder writes (8 bits, three components with no subsampling, Huffman, no restart markers).
// It is written separately from the encoder (the tables come from the file's own DHT, not from the encoder's constants) so a round trip proves the bytes are a JPEG, not that two halves agree.
export type DecodedJpeg = { width: number; height: number; rgba: Uint8Array };

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31,
  39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

type Huffman = { maxCode: number[]; valPtr: number[]; minCode: number[]; symbols: number[] };
function buildHuffman(counts: number[], symbols: number[]): Huffman {
  const maxCode: number[] = new Array<number>(17).fill(-1);
  const minCode: number[] = new Array<number>(17).fill(0);
  const valPtr: number[] = new Array<number>(17).fill(0);
  let code = 0;
  let at = 0;
  for (let length = 1; length <= 16; length += 1) {
    valPtr[length] = at;
    minCode[length] = code;
    code += counts[length - 1]!;
    at += counts[length - 1]!;
    maxCode[length] = counts[length - 1]! === 0 ? -1 : code - 1;
    code <<= 1;
  }
  return { maxCode, valPtr, minCode, symbols };
}

export function decodeJpeg(bytes: Uint8Array): DecodedJpeg {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("not a JPEG");
  let at = 2;
  const quant: Record<number, number[]> = {};
  const tables: Record<string, Huffman> = {};
  let width = 0;
  let height = 0;
  let components: Array<{ id: number; quant: number }> = [];
  let scanSelectors: Array<{ dc: number; ac: number }> = [];
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error("marker expected");
    const marker = bytes[at + 1]!;
    at += 2;
    if (marker === 0xd9) throw new Error("no scan");
    const length = (bytes[at]! << 8) | bytes[at + 1]!;
    const body = bytes.subarray(at + 2, at + length);
    if (marker === 0xdb) {
      let p = 0;
      while (p < body.length) {
        const precision = body[p]! >> 4;
        const id = body[p]! & 15;
        if (precision !== 0) throw new Error("8-bit tables only");
        const table = new Array<number>(64);
        for (let i = 0; i < 64; i += 1) table[ZIGZAG[i]!] = body[p + 1 + i]!;
        quant[id] = table;
        p += 65;
      }
    } else if (marker === 0xc0) {
      if (body[0] !== 8) throw new Error("8 bits only");
      height = (body[1]! << 8) | body[2]!;
      width = (body[3]! << 8) | body[4]!;
      if (body[5] !== 3) throw new Error("three components only");
      components = [0, 1, 2].map((i) => { if (body[7 + i * 3] !== 0x11) throw new Error("no subsampling only"); return { id: body[6 + i * 3]!, quant: body[8 + i * 3]! }; });
    } else if (marker === 0xc4) {
      let p = 0;
      while (p < body.length) {
        const kind = body[p]! >> 4;
        const id = body[p]! & 15;
        const counts = Array.from(body.subarray(p + 1, p + 17));
        const total = counts.reduce((sum, value) => sum + value, 0);
        tables[`${String(kind)}${String(id)}`] = buildHuffman(counts, Array.from(body.subarray(p + 17, p + 17 + total)));
        p += 17 + total;
      }
    } else if (marker === 0xda) {
      scanSelectors = [0, 1, 2].map((i) => ({ dc: body[2 + i * 2]! >> 4, ac: body[2 + i * 2]! & 15 }));
      at += length;
      break;
    } else if (marker >= 0xc1 && marker <= 0xcf && marker !== 0xc4) throw new Error("not a baseline JPEG");
    at += length;
  }
  // The entropy-coded data: byte stuffing removed, stopping at a marker.
  const data: number[] = [];
  for (let i = at; i < bytes.length; i += 1) {
    if (bytes[i] === 0xff) {
      if (bytes[i + 1] === 0) { data.push(0xff); i += 1; continue; }
      break;
    }
    data.push(bytes[i]!);
  }
  let bitAt = 0;
  const bit = () => { const byte = data[bitAt >> 3]; if (byte === undefined) throw new Error("data ends early"); const value = (byte >> (7 - (bitAt & 7))) & 1; bitAt += 1; return value; };
  const bits = (n: number) => { let value = 0; for (let i = 0; i < n; i += 1) value = (value << 1) | bit(); return value; };
  const symbolOf = (table: Huffman) => {
    let code = 0;
    for (let length = 1; length <= 16; length += 1) {
      code = (code << 1) | bit();
      if (table.maxCode[length]! >= 0 && code <= table.maxCode[length]! && code >= table.minCode[length]!) return table.symbols[table.valPtr[length]! + code - table.minCode[length]!]!;
    }
    throw new Error("bad code");
  };
  const extend = (value: number, size: number) => (size === 0 ? 0 : value < 1 << (size - 1) ? value - (1 << size) + 1 : value);
  const planes = components.map(() => new Float32Array(width * height));
  const predictor = [0, 0, 0];
  const block = new Float32Array(64);
  const coefficients = new Float32Array(64);
  const basis = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) for (let u = 0; u < 8; u += 1) basis[x * 8 + u] = (Math.cos(((2 * x + 1) * u * Math.PI) / 16) * (u === 0 ? Math.SQRT1_2 : 1)) / 2;
  const rowsDone = new Float64Array(64);
  for (let top = 0; top < height; top += 8) {
    for (let left = 0; left < width; left += 8) {
      for (let component = 0; component < 3; component += 1) {
        coefficients.fill(0);
        const selector = scanSelectors[component]!;
        const dcSize = symbolOf(tables[`0${String(selector.dc)}`]!);
        predictor[component] = predictor[component]! + extend(bits(dcSize), dcSize);
        const quantTable = quant[components[component]!.quant]!;
        coefficients[0] = predictor[component]! * quantTable[0]!;
        for (let k = 1; k < 64;) {
          const symbol = symbolOf(tables[`1${String(selector.ac)}`]!);
          const run = symbol >> 4;
          const size = symbol & 15;
          if (size === 0) { if (run === 15) { k += 16; continue; } break; }
          k += run;
          if (k > 63) throw new Error("run past the block");
          coefficients[ZIGZAG[k]!] = extend(bits(size), size) * quantTable[ZIGZAG[k]!]!;
          k += 1;
        }
        // The inverse transform, one axis at a time: along each row of coefficients, then down each column.
        for (let v = 0; v < 8; v += 1) for (let x = 0; x < 8; x += 1) { let sum = 0; for (let u = 0; u < 8; u += 1) sum += coefficients[v * 8 + u]! * basis[x * 8 + u]!; rowsDone[v * 8 + x] = sum; }
        for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) { let sum = 0; for (let v = 0; v < 8; v += 1) sum += rowsDone[v * 8 + x]! * basis[y * 8 + v]!; block[y * 8 + x] = sum; }
        for (let y = 0; y < 8 && top + y < height; y += 1) for (let x = 0; x < 8 && left + x < width; x += 1) planes[component]![(top + y) * width + left + x] = block[y * 8 + x]!;
      }
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  for (let i = 0; i < width * height; i += 1) {
    const y = planes[0]![i]! + 128;
    const cb = planes[1]![i]!;
    const cr = planes[2]![i]!;
    rgba[i * 4] = clamp(y + 1.402 * cr);
    rgba[i * 4 + 1] = clamp(y - 0.344136 * cb - 0.714136 * cr);
    rgba[i * 4 + 2] = clamp(y + 1.772 * cb);
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}
