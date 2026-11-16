// Device testing slice 2: the real JPEG encoder. Baseline JPEG written without an image dependency; checked by a separately written decoder (tests/support/device-jpeg-decode.ts) that reads its tables
// from the file itself, so a round trip shows the bytes are a JPEG that comes back as the picture that went in.
import { describe, expect, it } from "vitest";
import {
  DEVICE_JPEG_AC_COUNTS, DEVICE_JPEG_AC_SYMBOLS, DEVICE_JPEG_DC_COUNTS, DEVICE_JPEG_DC_SYMBOLS, DEVICE_JPEG_QUALITIES, encodeDeviceJpeg, encodeJpegAt,
} from "../../packages/verifier/src/executor/device-jpeg.js";
import { DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES } from "../../packages/contracts/src/device-evidence.js";
import { paintDeviceRects, type DeviceFrame } from "../../packages/verifier/src/executor/device-evidence.js";
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
const meanError = (a: Uint8Array, b: Uint8Array) => { let sum = 0; let n = 0; for (let i = 0; i < a.length; i += 4) for (let c = 0; c < 3; c += 1) { sum += Math.abs(a[i + c]! - b[i + c]!); n += 1; } return sum / n; };

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
  it("writes a JFIF baseline JPEG: start, the frame's size, three components, end", () => {
    const bytes = encodeJpegAt(screen(70, 45), 80);
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect([...bytes.subarray(bytes.length - 2)]).toEqual([0xff, 0xd9]);
    const sof = bytes.findIndex((value, at) => value === 0xff && bytes[at + 1] === 0xc0);
    expect(sof).toBeGreaterThan(0);
    expect(bytes[sof + 4]).toBe(8);
    expect((bytes[sof + 5]! << 8) | bytes[sof + 6]!).toBe(45);
    expect((bytes[sof + 7]! << 8) | bytes[sof + 8]!).toBe(70);
    expect(bytes[sof + 9]).toBe(3);
  });

  it("comes back as the picture that went in: the size, flat areas, the gradient, the stripes and the colour block, within the small error a JPEG makes", () => {
    for (const [width, height] of [[70, 45], [64, 64], [8, 8], [9, 9], [1, 1], [200, 120]] as const) {
      const frame = screen(width, height);
      const back = decodeJpeg(encodeJpegAt(frame, 90));
      expect([back.width, back.height]).toEqual([width, height]);
      expect(meanError(frame.rgba, back.rgba), `${String(width)}x${String(height)}`).toBeLessThan(width * height < 200 ? 30 : 6);
    }
    const frame = screen(200, 120);
    const back = decodeJpeg(encodeJpegAt(frame, 80));
    const at = (x: number, y: number) => (y * 200 + x) * 4;
    // a flat page pixel, the colour block, and the dark stripe (average over a few pixels)
    expect(Math.abs(back.rgba[at(21, 90)]! - 236)).toBeLessThan(8);
    expect(back.rgba[at(150, 100)]!).toBeGreaterThan(170);
    expect(back.rgba[at(150, 100) + 1]!).toBeLessThan(90);
  });

  it("holds the largest coefficients a picture can have (a one-pixel checkerboard at the best quality) in the table's range and still decodes", () => {
    const rgba = new Uint8Array(32 * 32 * 4);
    for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) rgba.set(((x + y) & 1) === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 32 + x) * 4);
    const frame = { width: 32, height: 32, rgba };
    const back = decodeJpeg(encodeJpegAt(frame, 100));
    expect(meanError(frame.rgba, back.rgba)).toBeLessThan(12);
  });

  it("keeps a painted rectangle black: the point of painting before encoding", () => {
    const frame = screen(160, 100);
    const painted = paintDeviceRects(frame, [{ x: 16, y: 40, width: 64, height: 24 }]);
    const back = decodeJpeg(encodeJpegAt(painted, 80));
    for (let y = 44; y < 60; y += 1) for (let x = 20; x < 76; x += 1) for (let c = 0; c < 3; c += 1) expect(back.rgba[(y * 160 + x) * 4 + c]!, `${String(x)},${String(y)}`).toBeLessThan(24);
  });

  it("is deterministic, and a lower quality makes fewer bytes", () => {
    const frame = screen(120, 90);
    expect(Buffer.from(encodeJpegAt(frame, 80)).equals(Buffer.from(encodeJpegAt(frame, 80)))).toBe(true);
    const sizes = DEVICE_JPEG_QUALITIES.map((quality) => encodeJpegAt(noise(64, 64), quality).byteLength);
    for (let i = 1; i < sizes.length; i += 1) expect(sizes[i]!).toBeLessThan(sizes[i - 1]!);
  });

  it("stuffs every 0xFF of the scan with a zero, so no marker can appear inside the data", () => {
    const bytes = encodeJpegAt(noise(96, 96), 95);
    const scanStart = bytes.findIndex((value, at) => value === 0xff && bytes[at + 1] === 0xda);
    const dataStart = scanStart + 2 + ((bytes[scanStart + 2]! << 8) | bytes[scanStart + 3]!);
    let ff = 0;
    for (let at = dataStart; at < bytes.length - 2; at += 1) if (bytes[at] === 0xff) { ff += 1; expect(bytes[at + 1], `at ${String(at)}`).toBe(0); at += 1; }
    expect(ff).toBeGreaterThan(0);
    const back = decodeJpeg(bytes);
    expect(back.width).toBe(96);
  });

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

  it("encodes a phone-sized screen in a few seconds", () => {
    const start = Date.now();
    const bytes = encodeJpegAt(screen(720, 1280), 80);
    expect(Date.now() - start).toBeLessThan(8_000);
    expect(bytes.byteLength).toBeLessThan(DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES);
    expect(decodeJpeg(bytes).height).toBe(1280);
  });
});

describe("encodeDeviceJpeg", () => {
  it("takes the best quality that fits the cap, and the first one if it already fits", () => {
    const frame = noise(96, 96);
    const sizes = DEVICE_JPEG_QUALITIES.map((quality) => encodeJpegAt(frame, quality).byteLength);
    expect(encodeDeviceJpeg(frame, sizes[0]!).byteLength).toBe(sizes[0]);
    expect(encodeDeviceJpeg(frame, sizes[2]!).byteLength).toBe(sizes[2]);
    expect(encodeDeviceJpeg(frame, sizes[2]! + 1).byteLength).toBe(sizes[2]);
    expect(encodeDeviceJpeg(frame, sizes[4]!).byteLength).toBe(sizes[4]);
  });

  it("returns the smallest it can when even that is over the cap (the runner then says 'over the size cap'), never a cut picture", () => {
    const frame = noise(96, 96);
    const smallest = encodeJpegAt(frame, DEVICE_JPEG_QUALITIES.at(-1)!);
    const got = encodeDeviceJpeg(frame, 10);
    expect(got.byteLength).toBe(smallest.byteLength);
    expect(decodeJpeg(got).width).toBe(96);
  });

  it("throws on a frame that is not pixels, so the runner says the screenshot could not be taken", () => {
    expect(() => encodeDeviceJpeg({ width: 3, height: 3, rgba: new Uint8Array(5) }, DEVICE_EVIDENCE_SCREENSHOT_MAX_BYTES)).toThrow();
  });
});
