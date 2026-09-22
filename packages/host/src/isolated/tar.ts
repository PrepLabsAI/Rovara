/**
 * A strict reader for the one archive shape this host accepts from a worker.
 *
 * The archive arrives from an untrusted container, so it is parsed in memory and never
 * written to disk. That is the point: an extraction that touches the filesystem can be
 * steered by the archive itself, and a symlink member is enough to make a later "read
 * the file I just extracted" return a host file instead. Nothing here creates a path,
 * so there is no path to redirect.
 *
 * Everything outside the narrow shape a run legitimately produces is refused rather
 * than tolerated: traversal, absolute names, links of either kind, devices and other
 * special entries, duplicate names, oversized members and oversized totals.
 */

export class UntrustedArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedArchiveError";
  }
}

export interface ArchiveLimits {
  /** Refuse an archive whose members exceed this in total, before expansion. */
  maxTotalBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxTotalBytes: 256 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
  maxEntries: 4_096,
};

const BLOCK = 512;

/** Regular-file members only, keyed by their validated relative path. */
export type ArchiveEntries = Map<string, Buffer>;

/**
 * Parse a ustar archive into memory, refusing anything outside the accepted shape.
 *
 * Directory members are allowed and ignored; only regular files are returned. Long-name
 * extensions are refused rather than interpreted, because supporting them would mean
 * reimplementing the part of tar most likely to hide a surprise.
 */
export function readTarEntries(archive: Buffer, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveEntries {
  const entries: ArchiveEntries = new Map();
  let offset = 0;
  let total = 0;
  let emptyBlocks = 0;

  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      emptyBlocks += 1;
      offset += BLOCK;
      if (emptyBlocks >= 2) break;
      continue;
    }
    emptyBlocks = 0;
    assertChecksum(header);

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12, "size");
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const path = prefix ? `${prefix}/${name}` : name;

    if (entries.size + 1 > limits.maxEntries) {
      throw new UntrustedArchiveError(`archive has more than ${limits.maxEntries} entries`);
    }
    if (size > limits.maxEntryBytes) {
      throw new UntrustedArchiveError(`archive entry ${path} exceeds ${limits.maxEntryBytes} bytes`);
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw new UntrustedArchiveError(`archive exceeds ${limits.maxTotalBytes} bytes in total`);
    }

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      throw new UntrustedArchiveError(`archive entry ${path} is truncated`);
    }

    // Extended headers carry metadata, not content. They are skipped and deliberately
    // NOT applied: a pax record can restate an entry's path, and honouring that would
    // reintroduce exactly the traversal this reader exists to refuse. The ustar fields
    // remain the only thing that names a member.
    if (typeflag === "x" || typeflag === "g") {
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
      continue;
    }

    // Directories carry no payload we use; everything that is not a plain file or a
    // directory is refused by kind, including both link types and every device node.
    if (typeflag === "5") {
      // `tar -C dir .` writes the archive root as a directory member named ".".
      assertSafePath(path.replace(/\/+$/, ""), { allowRoot: true });
    } else if (typeflag === "0" || typeflag === "\0") {
      const safe = assertSafePath(path);
      if (entries.has(safe)) {
        throw new UntrustedArchiveError(`archive repeats the entry ${safe}`);
      }
      entries.set(safe, Buffer.from(archive.subarray(dataStart, dataEnd)));
    } else {
      throw new UntrustedArchiveError(
        `archive entry ${path} has unsupported type '${typeflag === "\0" ? "\\0" : typeflag}'`,
      );
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
  }

  if (entries.size === 0) throw new UntrustedArchiveError("archive contains no readable file entries");
  return entries;
}

/** Read one required regular file from a parsed archive. */
export function requireEntry(entries: ArchiveEntries, path: string): Buffer {
  const value = entries.get(path);
  if (!value) throw new UntrustedArchiveError(`archive is missing ${path}`);
  return value;
}

/**
 * Accept only a relative path that stays inside the archive.
 *
 * `./` prefixes are normalised away because tar writes them for a `.` context, but a
 * `..` segment, an absolute path, a drive-style prefix, a backslash or an embedded NUL
 * is refused outright rather than normalised into something that looks safe.
 */
function assertSafePath(raw: string, options: { allowRoot?: boolean } = {}): string {
  if (!raw) throw new UntrustedArchiveError("archive entry has an empty name");
  if (raw.includes("\0")) throw new UntrustedArchiveError("archive entry name contains a NUL");
  if (raw.includes("\\")) throw new UntrustedArchiveError(`archive entry ${raw} contains a backslash`);
  if (raw.startsWith("/")) throw new UntrustedArchiveError(`archive entry ${raw} is absolute`);
  if (/^[A-Za-z]:/.test(raw)) throw new UntrustedArchiveError(`archive entry ${raw} is absolute`);

  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw new UntrustedArchiveError(`archive entry ${raw} escapes the archive`);
    segments.push(segment);
  }
  if (segments.length === 0) {
    if (options.allowRoot) return "";
    throw new UntrustedArchiveError(`archive entry ${raw} names no file`);
  }
  return segments.join("/");
}

function readString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function readOctal(header: Buffer, start: number, length: number, label: string): number {
  const text = readString(header, start, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new UntrustedArchiveError(`archive ${label} field is not octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UntrustedArchiveError(`archive ${label} field is out of range`);
  }
  return value;
}

function assertChecksum(header: Buffer): void {
  const recorded = readOctal(header, 148, 8, "checksum");
  let signed = 0;
  let unsigned = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  if (recorded !== unsigned && recorded !== signed) {
    throw new UntrustedArchiveError("archive header checksum does not match");
  }
}
