// Port lane L9a: the `object-storage` adapter that keeps each object as one file under a folder (provisional, owner decision 58).
//
// Layout: <root>/objects/<D_part>/<D_part>/<F_leaf>. Every file is a one-line JSON header, a newline, then the bytes, so an object and
// what is known about it are written by ONE rename (a reader never sees an object without its header, or a header without its bytes).
// The folder and file names are an injective spelling of the key:
//   - folders start with D_ and files with F_, so a key that is another key's start (`a` and `a/b`) never needs the same name;
//   - capital letters are spelled `^` and the small letter, other punctuation `%XX`, so two keys that differ only in case stay two files
//     on a case-insensitive disk (the default on macOS) and a key can never spell `.` or `..`.
// A key is also checked by `assertObjectKey` before it is spelled, every folder is checked to still lie under the real root, and files are
// opened with O_NOFOLLOW, so a link planted inside the root cannot lead out of it. Files are 0600 and folders 0700.
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import { join, sep } from "node:path";
import {
  ObjectConflictError,
  ObjectKeyError,
  ObjectTooBigError,
  assertObjectKey,
  assertObjectMeta,
  assertObjectPrefix,
  type ObjectMeta,
  type ObjectPutOptions,
  type ObjectStat,
  type ObjectStorage,
} from "@agentx/contracts";

const FOLDER = "D_";
const FILE = "F_";
const HEADER_MAX_BYTES = 16_384;
/** A file name may be 255 bytes; its two-character prefix leaves this much for the spelled part. */
const SPELLED_PART_MAX = 250;
export const FOLDER_OBJECT_DEFAULT_MAX_BYTES = 256 * 1_048_576;

/**
 * The folder's file system cannot make a hard link (a network share, some FAT or exFAT volumes, a folder on another device). A new object is published with a hard link, which is
 * the one step that fails if the name is taken, so the adapter will not fall back to a write that two writers could both win. Put the folder on a local disk.
 */
export class FolderHardLinksUnsupportedError extends Error {
  constructor() {
    super("the object folder's file system does not support hard links, which immutable objects need; choose a folder on a local disk (APFS, ext4, NTFS)");
    this.name = "FolderHardLinksUnsupportedError";
  }
}

export interface FolderObjectStorageOptions {
  /** Test hook: the call that makes a hard link. Default: the file system's. */
  linkFile?: typeof link;
  /** The folder the store owns. It is made (0700) if it is not there. Nothing else should be kept in it. */
  root: string;
  /** The largest object `put` accepts. Default 256 MiB. */
  maxObjectBytes?: number;
  now?: () => number;
  /** Days an object of a retention class is kept; a class that is not named is kept until it is deleted. */
  retentionDays?: Readonly<Record<string, number>>;
}

interface Header {
  v: 1;
  bytes: number;
  contentType: string;
  metadata: Record<string, string>;
  retention: string;
  /** Epoch milliseconds, absent for no expiry. */
  expiresAt?: number;
}

/** One part of a key as a file name. */
export function spellPart(part: string): string {
  let spelled = "";
  for (const char of part) {
    if (/[a-z0-9._=-]/.test(char)) spelled += char;
    else if (/[A-Z]/.test(char)) spelled += `^${char.toLowerCase()}`;
    else spelled += `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`;
  }
  return spelled;
}

/** The part a file name spells, or undefined when the name is not one this store wrote. */
export function unspellPart(name: string): string | undefined {
  let part = "";
  for (let index = 0; index < name.length; index += 1) {
    const char = name.charAt(index);
    if (char === "^") {
      const next = name.charAt(index + 1);
      if (!/[a-z]/.test(next)) return undefined;
      part += next.toUpperCase();
      index += 1;
    } else if (char === "%") {
      const hex = name.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) return undefined;
      part += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
    } else if (/[a-z0-9._=-]/.test(char)) part += char;
    else return undefined;
  }
  return part === "" ? undefined : part;
}

/** A part as a file name, or `ObjectKeyError` when it would not fit in one (a long part of capitals, or of punctuation, which takes two or three characters each). */
function spelled(part: string): string {
  const name = spellPart(part);
  if (name.length > SPELLED_PART_MAX) throw new ObjectKeyError("this part of the key is too long to be one file name here (a part of 128 characters must be mostly lower case)");
  return name;
}

const isExists = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
const isMissing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

export class FolderObjectStorage implements ObjectStorage {
  readonly #root: string;
  readonly #objects: string;
  readonly #temp: string;
  readonly #max: number;
  readonly #now: () => number;
  readonly #days: Readonly<Record<string, number>>;
  readonly #link: typeof link;
  #realRoot: string | undefined;

  constructor(options: FolderObjectStorageOptions) {
    this.#root = options.root;
    this.#objects = join(options.root, "objects");
    this.#temp = join(options.root, "tmp");
    this.#max = options.maxObjectBytes ?? FOLDER_OBJECT_DEFAULT_MAX_BYTES;
    this.#now = options.now ?? Date.now;
    this.#days = options.retentionDays ?? {};
    this.#link = options.linkFile ?? link;
    if (!Number.isInteger(this.#max) || this.#max < 1) throw new RangeError("maxObjectBytes is a whole number of bytes, at least 1");
  }

  /** The real path of the root, made on first use. A root that is a link is refused. */
  async #ready(): Promise<string> {
    if (this.#realRoot !== undefined) return this.#realRoot;
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const details = await lstat(this.#root);
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error("the object folder must be a plain folder, not a link");
    // A folder other users can write to (a worker's workspace is one) could have links planted in it: refused.
    if (process.platform !== "win32" && ((details.mode & 0o022) !== 0 || (typeof process.getuid === "function" && details.uid !== process.getuid()))) throw new Error("the object folder must belong to you and not be writable by others");
    for (const folder of [this.#objects, this.#temp]) await mkdir(folder, { recursive: true, mode: 0o700 });
    this.#realRoot = await realpath(this.#root);
    // A crash between the write and the rename leaves a part file behind; ones an hour old belong to no running write.
    for (const name of await readdir(this.#temp).catch(() => [] as string[])) {
      if (!name.endsWith(".part")) continue;
      const age = await lstat(join(this.#temp, name)).then((details) => this.#now() - details.mtimeMs, () => 0);
      if (age > 3_600_000) await rm(join(this.#temp, name), { force: true });
    }
    return this.#realRoot;
  }

  async #insideRoot(folder: string): Promise<boolean> {
    const root = await this.#ready();
    const real = await realpath(folder).catch(() => undefined);
    return real !== undefined && (real === root || real.startsWith(root + sep));
  }

  #folderOf(parts: readonly string[]): string {
    return join(this.#objects, ...parts.map((part) => FOLDER + spelled(part)));
  }

  #fileOf(key: string): { folder: string; file: string } {
    assertObjectKey(key);
    const parts = key.split("/");
    const leaf = parts.pop() as string;
    const folder = this.#folderOf(parts);
    return { folder, file: join(folder, FILE + spelled(leaf)) };
  }

  /**
   * Makes the folders of a key one level at a time, looking at each before going in: a link or a file where a folder belongs ends the write, so no
   * folder is ever made through a link that leads out of the store. (The check and the rename after it are not one step; a root only its owner can write is what makes that safe.)
   */
  async #makeFolders(key: string): Promise<void> {
    const parts = key.split("/").slice(0, -1);
    let current = this.#objects;
    for (const part of parts) {
      current = join(current, FOLDER + spelled(part));
      try {
        await lstat(current);
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (failure) {
          if (!isExists(failure)) throw failure;
        }
      }
      const now = await lstat(current);
      if (now.isSymbolicLink() || !now.isDirectory()) throw new Error("the object folder lies outside the store");
    }
    if (!(await this.#insideRoot(current))) throw new Error("the object folder lies outside the store");
  }

  put(key: string, bytes: Uint8Array, meta: ObjectMeta, options?: ObjectPutOptions): Promise<void> {
    return this.#longPaths(() => this.#put(key, bytes, meta, options));
  }

  /** A key whose folders and file would make a path longer than the disk allows is a bad key, not a disk error. */
  async #longPaths<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENAMETOOLONG") throw new ObjectKeyError("this key is too long to be kept as a path here");
      throw error;
    }
  }

  async #put(key: string, bytes: Uint8Array, meta: ObjectMeta, options: ObjectPutOptions | undefined): Promise<void> {
    const { file } = this.#fileOf(key);
    assertObjectMeta(meta);
    if (bytes.byteLength > this.#max) throw new ObjectTooBigError(bytes.byteLength, this.#max);
    await this.#ready();
    const days = this.#days[meta.retention];
    const header: Header = {
      v: 1, bytes: bytes.byteLength, contentType: meta.contentType, metadata: { ...meta.metadata }, retention: meta.retention,
      ...(days === undefined ? {} : { expiresAt: this.#now() + days * 86_400_000 }),
    };
    const headerLine = Buffer.from(`${JSON.stringify(header)}\n`);
    if (headerLine.byteLength > HEADER_MAX_BYTES) throw new RangeError("the object's header is too large");
    await this.#makeFolders(key);
    const temporary = join(this.#temp, `${randomBytes(12).toString("hex")}.part`);
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(headerLine);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (options?.overwrite === true) await rename(temporary, file);
      else await this.#publishNew(key, temporary, file);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true });
      throw error;
    }
  }

  /**
   * Puts a finished temporary file at a key that must be new. A hard link fails if the name is taken and makes it appear whole otherwise, in one step, so of two
   * writers racing for a key exactly one wins. A taken name that holds an expired object is cleared (reading it does that) and the link tried again.
   */
  async #publishNew(key: string, temporary: string, file: string): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.#link(temporary, file);
        await rm(temporary, { force: true });
        return;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV") throw new FolderHardLinksUnsupportedError();
        if (code !== "EEXIST") throw error;
        if ((await this.#read(key, false, 0)) !== undefined) break;
      }
    }
    throw new ObjectConflictError(key);
  }

  /** Reads the header of the file at `file` and, when asked, the bytes after it. Undefined for no such object, an expired one or a file this store did not write. */
  async #read(key: string, withBytes: boolean, maxBytes: number): Promise<{ header: Header; body?: Uint8Array } | undefined> {
    const { folder, file } = this.#fileOf(key);
    await this.#ready();
    if (!(await this.#insideRoot(folder))) return undefined;
    let handle: FileHandle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error) || (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP")) return undefined;
      throw error;
    }
    try {
      const details = await handle.stat();
      if (!details.isFile()) return undefined;
      const head = Buffer.alloc(Math.min(HEADER_MAX_BYTES, details.size));
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      const newline = head.subarray(0, bytesRead).indexOf(0x0a);
      if (newline < 0) return undefined;
      let header: Header;
      try {
        header = JSON.parse(head.subarray(0, newline).toString("utf8")) as Header;
      } catch {
        return undefined;
      }
      const bodyBytes = details.size - (newline + 1);
      if (header.v !== 1 || header.bytes !== bodyBytes) return undefined;
      if (header.expiresAt !== undefined && header.expiresAt <= this.#now()) {
        await rm(file, { force: true });
        return undefined;
      }
      if (!withBytes) return { header };
      if (header.bytes > maxBytes) return undefined;
      const body = Buffer.alloc(header.bytes);
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead: count } = await handle.read(body, offset, body.length - offset, newline + 1 + offset);
        if (count === 0) return undefined;
        offset += count;
      }
      return { header, body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength) };
    } finally {
      await handle.close();
    }
  }

  async get(key: string, maxBytes: number): Promise<Uint8Array | undefined> {
    return (await this.#longPaths(() => this.#read(key, true, maxBytes)))?.body;
  }

  async stat(key: string): Promise<ObjectStat | undefined> {
    const found = await this.#longPaths(() => this.#read(key, false, 0));
    return found === undefined ? undefined : { bytes: found.header.bytes, metadata: { ...found.header.metadata } };
  }

  async delete(key: string): Promise<void> {
    const { folder, file } = this.#fileOf(key);
    await this.#longPaths(async () => {
      await this.#ready();
      if (!(await this.#insideRoot(folder))) return;
      await rm(file, { force: true });
      await this.#pruneFolders(folder);
    });
  }

  async deletePrefix(prefix: string): Promise<boolean> {
    assertObjectPrefix(prefix);
    await this.#ready();
    const parts = prefix.split("/");
    // The last part is the start of a name unless the prefix ends with a slash; every earlier part is a whole folder.
    const partial = parts.pop() as string;
    const start = this.#folderOf(parts);
    if (!(await this.#insideRoot(start))) return true;
    let left = false;
    const walk = async (folder: string, onlyStartingWith: string | undefined): Promise<void> => {
      let entries: string[];
      try {
        entries = await readdir(folder);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const name of entries) {
        const path = join(folder, name);
        if (name.startsWith(FOLDER)) {
          const part = unspellPart(name.slice(FOLDER.length));
          if (part === undefined) { left = true; continue; }
          if (onlyStartingWith !== undefined && !part.startsWith(onlyStartingWith)) continue;
          const details = await lstat(path);
          if (!details.isDirectory()) { left = true; continue; }
          await walk(path, undefined);
        } else if (name.startsWith(FILE)) {
          const part = unspellPart(name.slice(FILE.length));
          if (part === undefined) { left = true; continue; }
          if (onlyStartingWith !== undefined && !part.startsWith(onlyStartingWith)) continue;
          await rm(path, { force: true });
        }
      }
      if (folder !== this.#objects) await rmdir(folder).catch(() => undefined);
    };
    await walk(start, partial === "" ? undefined : partial);
    // The folder a prefix ends inside may still hold other objects; "none is left" is about this prefix, so look again.
    return !left && !(await this.#anyUnder(start, partial));
  }

  async #anyUnder(folder: string, partial: string): Promise<boolean> {
    let entries: string[];
    try {
      entries = await readdir(folder);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    return entries.some((name) => {
      const prefix = name.startsWith(FOLDER) ? FOLDER : name.startsWith(FILE) ? FILE : undefined;
      if (prefix === undefined) return false;
      const part = unspellPart(name.slice(prefix.length));
      return part !== undefined && part.startsWith(partial);
    });
  }

  /** Removes the folders a delete left empty, up to (not including) the objects folder. */
  async #pruneFolders(folder: string): Promise<void> {
    let current = folder;
    while (current.startsWith(this.#objects + sep)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }
      current = join(current, "..");
    }
  }
}
