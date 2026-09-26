import { inflateRawSync } from "node:zlib";

export interface ReadZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Minimal reader for the zip files scripts/release/zip.ts writes: local file headers only (no
 * zip64, no data descriptors), which is all `deterministicZip`'s own output ever contains.
 */
export function readZipEntries(zip: Buffer): ReadZipEntry[] {
  const entries: ReadZipEntry[] = [];
  let offset = 0;
  while (zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18);
    const nameLength = zip.readUInt16LE(offset + 26);
    const extraLength = zip.readUInt16LE(offset + 28);
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const start = offset + 30 + nameLength + extraLength;
    entries.push({ name, data: inflateRawSync(zip.subarray(start, start + compressedSize)) });
    offset = start + compressedSize;
  }
  return entries;
}
