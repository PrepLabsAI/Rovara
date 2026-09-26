import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { deterministicZip } from "../../scripts/release/zip.js";

const entries = [
  { path: "b/index.js", data: Buffer.from("console.log('b');\n") },
  { path: "a.js", data: Buffer.from("export const a = 1;\n") },
];

function localHeaders(zip: Buffer): Array<{ name: string; time: number; date: number; data: Buffer }> {
  const found = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    found.push({ name, time: zip.readUInt16LE(offset + 10), date: zip.readUInt16LE(offset + 12), data: inflateRawSync(zip.subarray(start, start + compressedSize)) });
    offset = start + compressedSize;
  }
  return found;
}

describe("deterministic zip", () => {
  it("is byte-identical regardless of input order", () => {
    const one = deterministicZip(entries);
    const two = deterministicZip([...entries].reverse());
    expect(createHash("sha256").update(one).digest("hex")).toBe(createHash("sha256").update(two).digest("hex"));
  });

  it("sorts entries, fixes the timestamp at 1980-01-01, and round-trips the contents", () => {
    const headers = localHeaders(deterministicZip(entries));
    expect(headers.map((h) => h.name)).toEqual(["a.js", "b/index.js"]);
    expect(headers.every((h) => h.time === 0 && h.date === ((0 << 9) | (1 << 5) | 1))).toBe(true);
    expect(headers[0]!.data.toString()).toBe("export const a = 1;\n");
    expect(headers[1]!.data.toString()).toBe("console.log('b');\n");
  });

  it("refuses unsafe or duplicate paths", () => {
    expect(() => deterministicZip([{ path: "../x", data: Buffer.from("") }])).toThrow(/path/);
    expect(() => deterministicZip([{ path: "/abs", data: Buffer.from("") }])).toThrow(/path/);
    expect(() => deterministicZip([{ path: "a", data: Buffer.from("1") }, { path: "a", data: Buffer.from("2") }])).toThrow(/duplicate/);
  });

  it("ends with a valid end-of-central-directory record for the entry count", () => {
    const zip = deterministicZip(entries);
    const eocd = zip.length - 22;
    expect(zip.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(zip.readUInt16LE(eocd + 10)).toBe(2);
  });

  it("refuses an entry whose data exceeds the 4 GiB zip32 limit, without allocating 4 GiB", () => {
    // A real Buffer this large would OOM the test run; deterministicZip only needs to read
    // `.length` to reject it, so a stub with just that property exercises the guard cheaply.
    const oversized = { length: 0x1_0000_0000 } as unknown as Buffer;
    expect(() => deterministicZip([{ path: "big", data: oversized }])).toThrow(/4 GiB|zip32 limit/);
  });
});
