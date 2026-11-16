// Device testing slice 4: the PNG reader for the iOS simulator's screenshots. Every filter, both channel counts, a split image data, and a refusal (undefined, never a guess or a throw) for everything
// that is not an 8-bit non-interlaced RGB or RGBA image with whole chunks and matching checksums, a size over the cap, or more data than the size needs.
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEVICE_PNG_MAX_BYTES, decodeDevicePng } from "../../packages/verifier/src/executor/device-png.js";
import { chunk, header, join, png } from "../support/device-png-encode.js";

const colour = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) & 0xff, (x * 5 + y * 71) & 0xff, (x * 13 + y * 3 + 7) & 0xff];
const SIG = png(1, 1, () => [0, 0, 0]).subarray(0, 8);
const expectPixels = (bytes: Uint8Array, width: number, height: number) => {
  const frame = decodeDevicePng(bytes, 1_000_000)!;
  expect(frame).toBeDefined();
  expect([frame.width, frame.height, frame.rgba.length]).toEqual([width, height, width * height * 4]);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) expect([...frame.rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)], `${String(x)},${String(y)}`).toEqual([...colour(x, y), 255]);
};

describe("decodeDevicePng", () => {
  it("reads every filter type, RGB and RGBA", () => {
    for (const filter of [0, 1, 2, 3, 4]) for (const channels of [3, 4] as const) expectPixels(png(9, 7, colour, { filters: [filter], channels }), 9, 7);
    expectPixels(png(9, 8, colour, { filters: [0, 1, 2, 3, 4] }), 9, 8);
  });
  it("reads image data split over several chunks, and skips other chunks whose checksums match", () => {
    expectPixels(png(20, 20, colour, { idatSplit: 7, extra: [chunk("gAMA", new Uint8Array(4)), chunk("tEXt", new TextEncoder().encode("Comment\0hi"))] }), 20, 20);
  });
  it("makes every pixel opaque whatever the file's alpha says", () => {
    const frame = decodeDevicePng(png(3, 3, () => [10, 20, 30], { alpha: 7 }), 100)!;
    expect([...frame.rgba.subarray(0, 4)]).toEqual([10, 20, 30, 255]);
  });
  it("refuses a file that is not an 8-bit non-interlaced RGB or RGBA image", () => {
    const data = (width: number, height: number, bytesPerPixel: number) => deflateSync(Buffer.alloc((width * bytesPerPixel + 1) * height));
    const build = (ihdr: Uint8Array, idat: Uint8Array) => join(SIG, ihdr, chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
    for (const [what, bytes] of [
      ["16 bits", build(header(2, 2, 16, 6), data(2, 2, 8))], ["16 bits, data the size of 8", build(header(2, 2, 16, 6), data(2, 2, 4))], ["palette", build(header(2, 2, 8, 3), data(2, 2, 1))], ["grey", build(header(2, 2, 8, 0), data(2, 2, 1))], ["grey and alpha", build(header(2, 2, 8, 4), data(2, 2, 2))],
      ["interlaced", build(header(2, 2, 8, 6, 1), data(2, 2, 4))], ["zero width", build(header(0, 2), data(1, 2, 4))], ["zero height", build(header(2, 0), data(2, 1, 4))],
    ] as const) expect(decodeDevicePng(bytes, 1_000), what).toBeUndefined();
  });
  it("refuses a size over the pixel cap before it inflates anything", () => {
    const big = join(SIG, header(4_000_000, 4_000_000), chunk("IDAT", deflateSync(Buffer.alloc(10))), chunk("IEND", new Uint8Array(0)));
    expect(decodeDevicePng(big, 8_000_000)).toBeUndefined();
    expect(decodeDevicePng(png(10, 10, colour), 99)).toBeUndefined();
    expect(decodeDevicePng(png(10, 10, colour), 100)).toBeDefined();
  });
  it("refuses data of the wrong length: too little, too much (a bomb), or none", () => {
    const rows = (n: number) => deflateSync(Buffer.alloc((2 * 4 + 1) * n));
    const build = (idat: Uint8Array | undefined) => join(SIG, header(2, 2), ...(idat === undefined ? [] : [chunk("IDAT", idat)]), chunk("IEND", new Uint8Array(0)));
    expect(decodeDevicePng(build(rows(2)), 100)).toBeDefined();
    expect(decodeDevicePng(build(rows(1)), 100)).toBeUndefined();
    expect(decodeDevicePng(build(rows(3)), 100)).toBeUndefined();
    expect(decodeDevicePng(build(deflateSync(Buffer.alloc((2 * 4 + 1) * 2 + 1))), 100), "one byte too many").toBeUndefined();
    expect(decodeDevicePng(build(deflateSync(Buffer.alloc((2 * 4 + 1) * 2 - 1))), 100), "one byte too few").toBeUndefined();
    expect(decodeDevicePng(build(deflateSync(Buffer.alloc(50_000_000))), 100)).toBeUndefined();
    expect(decodeDevicePng(build(undefined), 100)).toBeUndefined();
    expect(decodeDevicePng(build(new Uint8Array([1, 2, 3, 4])), 100)).toBeUndefined();
  });
  it("refuses a bad filter byte, a bad checksum, a bad signature, a repeated or missing header, a chunk that runs past the end, data after the end, and a missing end", () => {
    const good = png(4, 4, colour);
    const flip = (at: number) => { const copy = Uint8Array.from(good); copy[at] = copy[at]! ^ 0xff; return copy; };
    expect(decodeDevicePng(good, 100)).toBeDefined();
    expect(decodeDevicePng(flip(0), 100), "signature").toBeUndefined();
    expect(decodeDevicePng(flip(16), 100), "header width (checksum)").toBeUndefined();
    expect(decodeDevicePng(flip(good.length - 1), 100), "end checksum").toBeUndefined();
    expect(decodeDevicePng(flip(50), 100), "data checksum").toBeUndefined();
    const badFilter = join(SIG, header(2, 1), chunk("IDAT", deflateSync(Buffer.from([9, 0, 0, 0, 0, 0, 0, 0, 0]))), chunk("IEND", new Uint8Array(0)));
    expect(decodeDevicePng(badFilter, 100), "filter 9").toBeUndefined();
    const idat = chunk("IDAT", deflateSync(Buffer.alloc(9)));
    expect(decodeDevicePng(join(SIG, header(2, 1), header(2, 1), idat, chunk("IEND", new Uint8Array(0))), 100), "second header").toBeUndefined();
    expect(decodeDevicePng(join(SIG, idat, header(2, 1), chunk("IEND", new Uint8Array(0))), 100), "header not first").toBeUndefined();
    expect(decodeDevicePng(join(SIG, header(2, 1), idat), 100), "no end").toBeUndefined();
    expect(decodeDevicePng(join(good, new Uint8Array([1])), 100), "after the end").toBeUndefined();
    expect(decodeDevicePng(good.subarray(0, good.length - 5), 100), "cut").toBeUndefined();
    expect(decodeDevicePng(join(SIG, header(2, 1), idat, chunk("IEND", new Uint8Array(0)), idat), 100), "data after end").toBeUndefined();
    expect(decodeDevicePng(join(SIG, header(2, 1), idat, chunk("IEND", new Uint8Array(0)), chunk("IDAT", deflateSync(Buffer.alloc(9)))), 100), "chunk after end").toBeUndefined();
  });
  it("refuses what is not bytes, and a file over the byte cap, without throwing", () => {
    for (const value of [undefined, null, "png", 5, [], {}, new Uint8Array(0), new Uint8Array(10)]) expect(decodeDevicePng(value, 100)).toBeUndefined();
    expect(decodeDevicePng(new Uint8Array(DEVICE_PNG_MAX_BYTES + 1), 100)).toBeUndefined();
  });
});
