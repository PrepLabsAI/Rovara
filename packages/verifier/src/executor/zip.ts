import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * A small, strict ZIP reader and writer for the one archive the executor handles: a browser trace. Entries are deflated, so a credential inside one cannot be seen by
 * scanning the archive's own bytes; the reader opens every entry, and refuses (returns null for) anything it cannot read in full, so a caller can treat an archive it
 * cannot open as unscanned. No ZIP64, no encryption, no multi-disk archives.
 */
export type ZipEntry = Readonly<{ name: string; data: Uint8Array }>;

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const MAX_ENTRIES = 8_192;
const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** True when the bytes begin like a ZIP archive (a local file header). */
export const looksLikeZip = (bytes: Uint8Array): boolean => bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** Every entry of the archive, inflated and checked against its recorded size and CRC; null when anything about the archive cannot be read in full. */
export function readZip(input: Uint8Array): ZipEntry[] | null {
  try {
    const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (!looksLikeZip(bytes)) return null;
    let end = -1;
    for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 0xffff); at -= 1) {
      if (bytes.readUInt32LE(at) === END_SIGNATURE) { end = at; break; }
    }
    if (end < 0) return null;
    const count = bytes.readUInt16LE(end + 10);
    const directorySize = bytes.readUInt32LE(end + 12);
    const directoryOffset = bytes.readUInt32LE(end + 16);
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || count > MAX_ENTRIES || directoryOffset + directorySize > end) return null;
    const entries: ZipEntry[] = [];
    let cursor = directoryOffset;
    let total = 0;
    for (let index = 0; index < count; index += 1) {
      if (cursor + 46 > bytes.byteLength || bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) return null;
      const flags = bytes.readUInt16LE(cursor + 8);
      const method = bytes.readUInt16LE(cursor + 10);
      const crc = bytes.readUInt32LE(cursor + 16);
      const compressedSize = bytes.readUInt32LE(cursor + 20);
      const size = bytes.readUInt32LE(cursor + 24);
      const nameLength = bytes.readUInt16LE(cursor + 28);
      const extraLength = bytes.readUInt16LE(cursor + 30);
      const commentLength = bytes.readUInt16LE(cursor + 32);
      const localOffset = bytes.readUInt32LE(cursor + 42);
      if ((flags & 1) !== 0 || compressedSize === 0xffffffff || size === 0xffffffff || size > MAX_ENTRY_BYTES) return null;
      const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
      cursor += 46 + nameLength + extraLength + commentLength;
      if (localOffset + 30 > bytes.byteLength || bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) return null;
      const dataStart = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
      if (dataStart + compressedSize > bytes.byteLength) return null;
      const stored = bytes.subarray(dataStart, dataStart + compressedSize);
      let data: Buffer;
      if (method === 0) data = stored;
      else if (method === 8) data = inflateRawSync(stored, { maxOutputLength: Math.max(1, size) });
      else return null;
      total += data.byteLength;
      if (data.byteLength !== size || crc32(data) !== crc || total > MAX_TOTAL_BYTES) return null;
      entries.push({ name, data: Uint8Array.from(data) });
    }
    return entries;
  } catch { return null; }
}

/** A ZIP archive of the entries, deflated unless `store` is set (or the entry is empty). Names are UTF-8, times are fixed, so the same entries give the same bytes. */
export function writeZip(entries: readonly { name: string; data: Uint8Array; store?: boolean }[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const method = entry.store === true || data.byteLength === 0 ? 0 : 8;
    const body = method === 0 ? data : deflateRawSync(data);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(body.byteLength, 18);
    local.writeUInt32LE(data.byteLength, 22); local.writeUInt16LE(name.byteLength, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIGNATURE, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(body.byteLength, 20);
    central.writeUInt32LE(data.byteLength, 24); central.writeUInt16LE(name.byteLength, 28); central.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.byteLength + name.byteLength + body.byteLength;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.byteLength, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}
