// Device testing slice 2: the real JPEG encoder. Baseline JPEG written without an image dependency; checked by a separately written decoder (tests/support/device-jpeg-decode.ts) that reads its tables
// from the file itself, so a round trip shows the bytes are a JPEG that comes back as the picture that went in.
import { describe, expect, it } from "vitest";
import {
  DEVICE_JPEG_AC_COUNTS, DEVICE_JPEG_AC_SYMBOLS, DEVICE_JPEG_DC_COUNTS, DEVICE_JPEG_DC_SYMBOLS, DEVICE_JPEG_QUALITIES, encodeDeviceJpeg, encodeJpegAt,
} from "../../packages/verifier/src/executor/device-jpeg.js";
import { type DeviceFrame } from "../../packages/verifier/src/executor/device-evidence.js";
import { decodeJpeg } from "../support/device-jpeg-decode.js";

/** A screen-like picture: a light page, a gradient bar, a dark text-like stripe pattern and a coloured block. */
function screen(width: number, height: number): DeviceFrame {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      let colour: [number, number, number] = [236, 236, 236];
      if (y < height / 5) colour = [Math.floor((x / width) * 255), 80, 200 - Math.floor((x / width) * 150)];
      else if (y > height / 2 && y < height / 2 + 12 && x % 6 < 3) colour = [20, 20, 20];
      else if (x > width / 2 && y > (height * 3) / 4) colour = [200, 40, 40];
      rgba.set([...colour, 255], at);
    }
  }
  return { width, height, rgba };
}
const noise = (width: number, height: number): DeviceFrame => {
  const rgba = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < rgba.length; i += 1) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rgba[i] = i % 4 === 3 ? 255 : seed >> 16 & 0xff; }
  return { width, height, rgba };
};

describe("the standard Huffman tables", () => {
  it("hold exactly the symbols a baseline JPEG codes: 12 sizes for the DC value, and every (run, size) of an AC value plus end-of-block and sixteen zeros", () => {
    expect(DEVICE_JPEG_DC_COUNTS.reduce((sum, value) => sum + value, 0)).toBe(DEVICE_JPEG_DC_SYMBOLS.length);
    expect([...DEVICE_JPEG_DC_SYMBOLS]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(DEVICE_JPEG_AC_COUNTS.reduce((sum, value) => sum + value, 0)).toBe(DEVICE_JPEG_AC_SYMBOLS.length);
    const wanted = new Set<number>([0x00, 0xf0]);
    for (let run = 0; run < 16; run += 1) for (let size = 1; size <= 10; size += 1) wanted.add((run << 4) | size);
    expect(new Set(DEVICE_JPEG_AC_SYMBOLS)).toEqual(wanted);
    expect(DEVICE_JPEG_AC_SYMBOLS).toHaveLength(162);
    expect(DEVICE_JPEG_AC_COUNTS).toHaveLength(16);
    expect(DEVICE_JPEG_DC_COUNTS).toHaveLength(16);
  });
});

describe("encodeJpegAt", () => {

  it("refuses a frame that is not pixels, or a quality that is not 1 to 100, with one fixed sentence", () => {
    const ok = screen(8, 8);
    const bad: DeviceFrame[] = [
      { width: 0, height: 8, rgba: new Uint8Array(0) }, { width: 8, height: 0, rgba: new Uint8Array(0) }, { width: 8, height: 8, rgba: new Uint8Array(10) }, { width: 1.5, height: 8, rgba: new Uint8Array(48) },
      { width: Number.NaN, height: 8, rgba: new Uint8Array(0) }, { width: 65_536, height: 1, rgba: new Uint8Array(65_536 * 4) }, { width: 8, height: 8, rgba: [] as unknown as Uint8Array }, { width: -1, height: 8, rgba: new Uint8Array(0) },
    ];
    for (const frame of bad) expect(() => encodeJpegAt(frame, 80)).toThrow("the picture cannot be encoded");
    for (const quality of [0, 101, 1.5, Number.NaN, -3]) expect(() => encodeJpegAt(ok, quality)).toThrow("the picture cannot be encoded");
    expect(() => encodeJpegAt(ok, 1)).not.toThrow();
    expect(() => encodeJpegAt(ok, 100)).not.toThrow();
  });
});

describe("encodeDeviceJpeg", () => {

  it("returns the smallest it can when even that is over the cap (the runner then says 'over the size cap'), never a cut picture", () => {
    const frame = noise(96, 96);
    const smallest = encodeJpegAt(frame, DEVICE_JPEG_QUALITIES.at(-1)!);
    const got = encodeDeviceJpeg(frame, 10);
    expect(got.byteLength).toBe(smallest.byteLength);
    expect(decodeJpeg(got).width).toBe(96);
  });
});
