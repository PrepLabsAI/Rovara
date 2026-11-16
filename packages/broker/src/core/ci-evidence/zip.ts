// TE-E0 option B: the report files inside a GitHub Actions artifact (a zip), read in memory with fixed limits and no new dependency (Node's zlib inflates). Only `.xml` and `.json` entries are read;
// nothing is written to disk and entry names are never used as paths. The whole archive is refused ("unreadable") on anything this reader does not take whole: zip64, encryption, an unknown method,
// sizes that disagree, a bad header, text that is not UTF-8, or a limit passed. Never a partial answer.
import { inflateRawSync } from "node:zlib";

/** The most bytes of a zipped artifact read at all. */
export const ARTIFACT_ZIP_BYTES_MAX = 20 * 1024 * 1024;
/** The most entries the central directory may list, report files read, bytes of one report, and bytes of all reports together. */
export const ZIP_ENTRIES_MAX = 500;
export const ZIP_REPORT_FILES_MAX = 20;
export const ZIP_REPORT_BYTES_MAX = 8 * 1024 * 1024;
export const ZIP_REPORTS_TOTAL_BYTES_MAX = 32 * 1024 * 1024;

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const REPORT_NAME = /\.(?:xml|json)$/iu;

export type ZipReports = { kind: "read"; files: Array<{ name: string; text: string }> } | { kind: "unreadable" };

const unreadable: ZipReports = { kind: "unreadable" };

/** The report files of a zip, whole, or `unreadable`. */
export function zipReports(zip: Uint8Array): ZipReports {
  if (zip.byteLength < 22 || zip.byteLength > ARTIFACT_ZIP_BYTES_MAX) return unreadable;
  const data = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end record is in the last 22 + 65,535 bytes (its comment is at most that long).
  let end = -1;
  for (let at = data.length - 22; at >= Math.max(0, data.length - 22 - 65_535); at -= 1) {
    if (data.readUInt32LE(at) === EOCD) { end = at; break; }
  }
  if (end === -1) return unreadable;
  const entries = data.readUInt16LE(end + 10);
  const directorySize = data.readUInt32LE(end + 12);
  const directoryAt = data.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff || entries > ZIP_ENTRIES_MAX) return unreadable;
  if (directoryAt + directorySize > end) return unreadable;
  const files: Array<{ name: string; text: string }> = [];
  let total = 0;
  let at = directoryAt;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > end || data.readUInt32LE(at) !== CENTRAL) return unreadable;
    const flags = data.readUInt16LE(at + 8);
    const method = data.readUInt16LE(at + 10);
    const compressed = data.readUInt32LE(at + 20);
    const size = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28);
    const extraLength = data.readUInt16LE(at + 30);
    const commentLength = data.readUInt16LE(at + 32);
    const localAt = data.readUInt32LE(at + 42);
    if (at + 46 + nameLength > end) return unreadable;
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || !REPORT_NAME.test(name)) continue;
    if ((flags & 0x1) !== 0 || compressed === 0xffffffff || size === 0xffffffff || (method !== 0 && method !== 8)) return unreadable;
    if (files.length >= ZIP_REPORT_FILES_MAX || size > ZIP_REPORT_BYTES_MAX || total + size > ZIP_REPORTS_TOTAL_BYTES_MAX) return unreadable;
    if (localAt + 30 > directoryAt || data.readUInt32LE(localAt) !== LOCAL) return unreadable;
    const start = localAt + 30 + data.readUInt16LE(localAt + 26) + data.readUInt16LE(localAt + 28);
    if (start + compressed > directoryAt) return unreadable;
    const packed = data.subarray(start, start + compressed);
    let raw: Buffer;
    try {
      raw = method === 0 ? Buffer.from(packed) : inflateRawSync(packed, { maxOutputLength: size + 1 });
    } catch {
      return unreadable;
    }
    if (raw.length !== size) return unreadable;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      return unreadable;
    }
    total += size;
    files.push({ name: Array.from(name.replace(/[\p{Cc}\p{Cf}]/gu, " ")).slice(0, 200).join(""), text });
  }
  return { kind: "read", files };
}
