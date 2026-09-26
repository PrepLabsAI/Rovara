import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

export interface ZipEntry {
  path: string;
  data: Buffer;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const FILE_ATTRIBUTES = (0o100644 << 16) >>> 0;
// The zip32 local/central header size fields are 4-byte unsigned integers: a single entry's
// uncompressed size cannot exceed this without a zip64 extension, which this writer does not
// implement. Lambda's own code-package limits (250 MB unzipped) are far smaller, so refusing here
// is a clear, immediate error instead of a corrupt archive.
const MAX_ENTRY_SIZE = 0xffffffff;

function checkPath(path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new Error(`unsafe zip entry path ${JSON.stringify(path)}`);
  }
}

function checkEntry(entry: ZipEntry): void {
  if (entry.data.length > MAX_ENTRY_SIZE) {
    throw new Error(
      `zip entry ${JSON.stringify(entry.path)} is ${entry.data.length} bytes, which exceeds the ${MAX_ENTRY_SIZE}-byte (4 GiB) zip32 limit this writer supports`,
    );
  }
  checkPath(entry.path);
}

/** Deterministic zip: sorted entries, fixed 1980-01-01 time, 0644 files, raw deflate level 9. */
export function deterministicZip(entries: ZipEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of sorted) {
    checkEntry(entry);
    if (seen.has(entry.path)) throw new Error(`duplicate zip entry ${entry.path}`);
    seen.add(entry.path);
    const name = Buffer.from(entry.path, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attributes
    central.writeUInt32LE(FILE_ATTRIBUTES, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

export async function zipDirectory(directory: string): Promise<Buffer> {
  const entries: ZipEntry[] = [];
  async function walk(current: string): Promise<void> {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else if (item.isFile()) entries.push({ path: relative(directory, full).split(sep).join("/"), data: await readFile(full) });
      else throw new Error(`unsupported file type in asset directory: ${full}`);
    }
  }
  await walk(directory);
  return deterministicZip(entries);
}
