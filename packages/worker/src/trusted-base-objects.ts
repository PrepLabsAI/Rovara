import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedGitEnvironment } from "./git.js";
import { candidateLayout } from "./isolated-git.js";

const execFile = promisify(execFileCallback);

// Reads a base commit's rule files from a verified copy of that commit's objects.
//
// The only thing taken from the caller is the base commit's id. Its length names the hash (40 hexadecimal characters: SHA-1, 64: SHA-256); the
// workspace's own configuration is never asked. The commit, its tree and each candidate rule file are fetched as bytes, and each one's id is computed
// here, from the object's type, size and bytes, and must equal the id it was asked for. The tree is parsed here too. Git is only used to find and
// inflate stored objects; nothing it reports about their content is believed. (Node's SHA-1 does not detect collision attacks. That is acceptable
// here: the base commit's id comes from the broker and is already trusted, and the check is against stored bytes that were changed after it was made.)
//
// Git never starts with the workspace's `.git` as its git directory and never follows the workspace's `objects/info` (alternates, pack lists,
// commit graphs). Its git directory is an empty, read-only one that the worker image carries (EMPTY_GIT_DIRECTORY_ROOT, one per hash), so no process
// that can write the workspace or the scratch directory can give git a config, a remote or a hook to run. Its objects directory (GIT_OBJECT_DIRECTORY) is
// a scratch directory that holds only objects: the workspace's pack files (and their indexes) are linked in, and a loose object is linked in only when it is
// one of the three that are read. A file planted in that directory can at most redirect where objects are read from, and the checks on the bytes catch that.
// The workspace's config, hooks, `info/` files and refs are never copied.
//
// The scratch directory is made where a hard link from the workspace works (decided by a test link, not by the device number, since a bind mount
// shares its device with the directory it shows and a link between the two fails), so nothing is copied. Every workspace file that is
// linked or copied is opened without following a link, checked to be a regular file, and (when it has to be copied) copied from that open file under
// a size limit and the overall deadline. The whole read has one deadline, and every git process is stopped when it passes.

/** A base object that is missing, does not match its id, or could not be read. It carries no detail: nothing of the store reaches a message. */
export class BaseObjectsUnverified extends Error {
  constructor() {
    super("base objects could not be verified");
    this.name = "BaseObjectsUnverified";
  }
}

export type BaseRuleFile =
  | { kind: "absent" }
  | { kind: "symlink"; candidate: string }
  | { kind: "oversize"; candidate: string; size: number }
  | { kind: "file"; candidate: string; content: Buffer };

const SHA1_ID = /^[0-9a-f]{40}$/u;
const SHA256_ID = /^[0-9a-f]{64}$/u;
const PACK_FILE = /^pack-[0-9a-f]+\.(?:pack|idx)$/u;
/** A commit over this size stops the read (a commit message that large is not a real base commit). */
const COMMIT_BYTES = 1024 * 1024;
const TREE_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;
/** The whole read, from the first file system call to the last git process. */
const OVERALL_DEADLINE_MS = 120_000;
/** The most that may be copied (not linked) into the scratch directory, in total, when the scratch directory is on another file system. */
const COPY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
/** The most pack files (and indexes) that are brought in; a workspace with more stops the read. */
const MAX_PACK_FILES = 10_000;
/** The most a blob whose bytes are hashed may hold; a larger one stops the read. */
const MAX_BLOB_BYTES = 1024 * 1024 * 1024;
/** Where the worker image keeps its empty, read-only git directories (`empty-sha1.git`, `empty-sha256.git`). */
export const EMPTY_GIT_DIRECTORY_ROOT = "/usr/share/agentx";
/** Names a different directory for local runs and tests; a worker image never sets it. */
export const EMPTY_GIT_DIRECTORY_ROOT_VARIABLE = "AGENTX_EMPTY_GIT_DIRECTORY_ROOT";
const SCRATCH_PREFIX = "agentx-base-rules-";
const STALE_SCRATCH_MS = 60 * 60 * 1000;
/** The name of a test link (and of the empty file one is made from): a worker killed between making it and removing it leaves it behind. */
const LINK_PROBE_PREFIX = "agentx-link-probe-";

type Algorithm = "sha1" | "sha256";

function algorithmOf(commit: string): Algorithm {
  if (SHA1_ID.test(commit)) return "sha1";
  if (SHA256_ID.test(commit)) return "sha256";
  throw new BaseObjectsUnverified();
}

export interface TreeEntry { mode: number; oid: string }

/** The entries of a raw tree (`<mode> <name>\0<raw id>`, repeated) whose names are in `wanted`; any malformed byte, or a wanted name twice, is refused. A mode may be written with a leading zero (`040000`). */
export function parseTreeEntries(bytes: Buffer, hashBytes: number, wanted: ReadonlySet<string>): Map<string, TreeEntry> {
  const found = new Map<string, TreeEntry>();
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(0x20, position);
    if (space <= position) throw new BaseObjectsUnverified();
    const mode = bytes.toString("latin1", position, space);
    if (!/^[0-7]{5,7}$/u.test(mode)) throw new BaseObjectsUnverified();
    const end = bytes.indexOf(0, space + 1);
    if (end <= space + 1 || end + 1 + hashBytes > bytes.length) throw new BaseObjectsUnverified();
    const name = bytes.toString("latin1", space + 1, end);
    if (wanted.has(name)) {
      if (found.has(name)) throw new BaseObjectsUnverified();
      found.set(name, { mode: Number.parseInt(mode, 8), oid: bytes.toString("hex", end + 1, end + 1 + hashBytes) });
    }
    position = end + 1 + hashBytes;
  }
  return found;
}

/** The tree id a commit's first line names. */
export function commitTreeId(bytes: Buffer, hashBytes: number): string {
  const header = bytes.toString("latin1", 0, Math.min(bytes.length, 5 + hashBytes * 2 + 1));
  const match = new RegExp(`^tree ([0-9a-f]{${String(hashBytes * 2)}})\\n$`, "u").exec(header);
  if (match?.[1] === undefined) throw new BaseObjectsUnverified();
  return match[1];
}

async function plainDirectory(path: string): Promise<boolean> {
  const stat = await lstat(path).catch(() => undefined);
  return stat !== undefined && stat.isDirectory();
}

export interface ReadOptions {
  /** The workspace root: where a scratch directory on the workspace's own file system can be made when the temporary directory is on another one. */
  workspaceRoot?: string;
  /** The overall deadline in milliseconds. */
  deadlineMs?: number;
  /** The most that may be copied in total when a hard link is not possible. */
  copyLimitBytes?: number;
  /** Test seam: how a file is hard-linked. */
  linkFile?: (source: string, target: string) => Promise<void>;
  /** Where the empty git directories are (default: {@link EMPTY_GIT_DIRECTORY_ROOT_VARIABLE}, else {@link EMPTY_GIT_DIRECTORY_ROOT}). */
  emptyGitDirectoryRoot?: string;
  /** The most pack files that are brought in. */
  maxPackFiles?: number;
  /** The most a blob whose bytes are hashed may hold. */
  maxBlobBytes?: number;
  /** Test seam: the clock the leftover sweeps judge age by (default Date.now). A link's change time cannot be set back, so a test moves the clock instead. */
  now?: () => number;
  /** Test seam: called once the scratch directory and its objects directory exist, before git runs. */
  onScratchReady?: (paths: { scratch: string; objects: string }) => Promise<void>;
  /**
   * Test seam, never passed by a production caller (a test pins that): turns off one of git's own layers of protection so a test can show that the read-only
   * git directory holds on its own. Everything is on by default. `gitDirectory` names, from the scratch directory, a git directory to use in place of the
   * image's read-only one (it stands in for a writable, per-read git directory); it is looked at after `onScratchReady` has run.
   */
  gitHardeningForTest?: { protocolBans?: boolean; noLazyFetch?: boolean; gitDirectory?: (scratch: string) => string };
}

/** Refuses an entry (and, for a directory, everything below it) that is a link or that this process could write. */
async function assertReadOnly(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (stat.mode & 0o222) !== 0) throw new BaseObjectsUnverified();
  if (await access(path, fsConstants.W_OK).then(() => true, () => false)) throw new BaseObjectsUnverified();
  if (stat.isDirectory()) for (const name of await readdir(path)) await assertReadOnly(join(path, name));
}

/** The image's empty git directory for `algorithm`; throws unless it exists, is not reached through a link and is read-only throughout. There is no other git directory to fall back to. */
async function emptyGitDirectory(algorithm: Algorithm, configured: string | undefined): Promise<string> {
  const root = configured ?? process.env[EMPTY_GIT_DIRECTORY_ROOT_VARIABLE] ?? EMPTY_GIT_DIRECTORY_ROOT;
  const path = join(await realpath(root), `empty-${algorithm}.git`);
  await assertReadOnly(path);
  return path;
}

/**
 * Where the scratch directory goes: the first of these where a hard link from the workspace works. (1) The worker's own directory under the workspace
 * root (`.agentx-runtime/tmp`, where it exists, mode 0700, not a link): it is on the workspace's mount. (2) The temporary directory, when it is on the
 * workspace's file system. (3) A directory the worker owns under the workspace root (`.agentx/scratch`, made when missing). Two paths that report the
 * same device can still be different mounts (a bind mount is one), and a hard link between mounts fails with EXDEV, so a candidate is decided by
 * `canLink` (one test link from the workspace into it), not by its device alone. When none takes a link the temporary directory is used and files are
 * copied, under limits.
 */
export async function chooseScratchRoot(workspaceRoot: string | undefined, device: number, base: string = tmpdir(), canLink: (root: string) => Promise<boolean> = async () => true): Promise<string> {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  /** The directory's own path when it can be used as a scratch root. The temporary directory may be reached through a link (as /tmp is on some systems); a directory under the workspace may not. */
  const usable = async (path: string, create: boolean, mayBeLinked: boolean): Promise<string | undefined> => {
    try {
      if (create) await mkdir(path, { recursive: true, mode: 0o700 });
      const real = await realpath(path);
      if (!mayBeLinked && real !== path) return undefined;
      const stat = await lstat(real);
      if (!stat.isDirectory() || stat.dev !== device) return undefined;
      if (!mayBeLinked && !(stat.uid === owner && (stat.mode & 0o777) === 0o700)) return undefined;
      return (await canLink(real)) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  if (workspaceRoot !== undefined) {
    const runtime = await usable(join(workspaceRoot, ".agentx-runtime", "tmp"), false, false);
    if (runtime !== undefined) return runtime;
  }
  const temporary = await usable(base, false, true);
  if (temporary !== undefined) return temporary;
  if (workspaceRoot !== undefined) {
    const own = await usable(join(workspaceRoot, ".agentx", "scratch"), true, false);
    if (own !== undefined) return own;
  }
  return base;
}

/**
 * The scratch root for a read: {@link chooseScratchRoot}, deciding each candidate by one test link from the workspace's object store: the first pack file
 * is linked in (or, when there is none, a small file made for the purpose in the object store and removed afterwards) under a name of its own, which
 * is checked to be that file and removed. Any failure of the test means that candidate does not take a link.
 */
async function scratchRootFor(objects: string, workspaceRoot: string | undefined, link: (source: string, target: string) => Promise<void>, now: () => number): Promise<string> {
  const packs = join(objects, "pack");
  let source: string | undefined;
  let made: string | undefined;
  await removeStaleLinkProbes(objects, now);
  try {
    if (await plainDirectory(packs)) {
      for (const name of (await readdir(packs)).filter((entry) => PACK_FILE.test(entry)).sort()) {
        if ((await lstat(join(packs, name)).catch(() => undefined))?.isFile() === true) { source = join(packs, name); break; }
      }
    }
    if (source === undefined) {
      const path = join(objects, `${LINK_PROBE_PREFIX}${String(process.pid)}-${randomBytes(6).toString("hex")}`);
      try {
        await (await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600)).close();
        made = path;
        source = path;
      } catch { /* no test source: no candidate takes a link, and files are copied */ }
    }
    const canLink = async (root: string): Promise<boolean> => {
      if (source === undefined) return false;
      await removeStaleLinkProbes(root, now);
      const target = join(root, `${LINK_PROBE_PREFIX}${String(process.pid)}-${randomBytes(6).toString("hex")}`);
      try {
        const before = await lstat(source);
        await link(source, target);
        const after = await lstat(target);
        return after.isFile() && after.ino === before.ino && after.dev === before.dev;
      } catch {
        return false;
      } finally {
        await rm(target, { force: true }).catch(() => undefined);
      }
    };
    return await chooseScratchRoot(workspaceRoot, (await lstat(objects)).dev, tmpdir(), canLink);
  } finally {
    if (made !== undefined) await rm(made, { force: true }).catch(() => undefined);
  }
}

/** Removes scratch directories an earlier read left behind (a killed worker), so they cannot pile up. Best effort. */
async function removeStaleScratch(root: string, now: () => number): Promise<void> {
  try {
    for (const name of await readdir(root)) {
      if (!name.startsWith(SCRATCH_PREFIX)) continue;
      const stat = await lstat(join(root, name)).catch(() => undefined);
      if (stat?.isDirectory() === true && now() - stat.mtimeMs > STALE_SCRATCH_MS) await rm(join(root, name), { recursive: true, force: true });
    }
  } catch { /* nothing to clean */ }
  await removeStaleLinkProbes(root, now);
}

/**
 * Removes the test links an earlier read left behind in `directory` (a killed worker): entries named like one that are older than the scratch age limit.
 * Only a regular file goes: it is opened without following a link (and without blocking, so a pipe is passed over), checked to be a regular file, and the
 * name is unlinked only while it still leads to that file. Links, pipes, directories and every other name are left alone. Best effort.
 * Age is the later of the file's modification and change times: a test link to a pack shares the pack's (often old) modification time, but making the
 * link sets its change time, so a link another read made a moment ago is never judged old.
 */
async function removeStaleLinkProbes(directory: string, now: () => number): Promise<void> {
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => name.startsWith(LINK_PROBE_PREFIX));
  } catch { return; }
  for (const name of names) {
    const path = join(directory, name);
    try {
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || now() - Math.max(opened.mtimeMs, opened.ctimeMs) <= STALE_SCRATCH_MS) continue;
        const named = await lstat(path);
        if (named.isFile() && named.ino === opened.ino && named.dev === opened.dev) await unlink(path);
      } finally {
        await handle.close();
      }
    } catch { /* gone, a link, or not readable: not ours to remove */ }
  }
}

interface Placement {
  link: (source: string, target: string) => Promise<void>;
  signal: AbortSignal;
  copyLimit: number;
  copied: number;
}

/**
 * Puts the workspace's regular file `source` at `target`: a hard link where the file system allows one, else a copy from the open file. The source is
 * opened without following a link and without blocking, and must be a regular file (a link, a pipe or a device is skipped). After a link is made the
 * inode behind `target` must be the file that was checked. A copy that would pass the size limit, or the deadline, stops the read.
 */
async function place(source: string, target: string, placement: Placement): Promise<boolean> {
  let handle;
  try {
    handle = await open(source, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (error) {
    if (["ENOENT", "ELOOP", "ENXIO", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return false;
    try {
      await placement.link(source, target);
      const linked = await lstat(target);
      if (linked.isFile() && linked.ino === stat.ino && linked.dev === stat.dev) return true;
      // The path now leads to another file than the one that was checked: it is not used.
      await rm(target, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
    }
    if (placement.copied + stat.size > placement.copyLimit) throw new BaseObjectsUnverified();
    const out = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        if (placement.signal.aborted) throw new BaseObjectsUnverified();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        placement.copied += bytesRead;
        if (placement.copied > placement.copyLimit) throw new BaseObjectsUnverified();
        await out.write(buffer, 0, bytesRead);
        position += bytesRead;
      }
    } finally {
      await out.close();
    }
    return true;
  } finally {
    await handle.close();
  }
}

/** One entry of a verified tree: its name, mode and object id. */
export interface TreeListingEntry { name: string; mode: number; oid: string }

/** The most entries one tree may list; a larger one stops the read. */
const MAX_TREE_ENTRIES = 100_000;

/**
 * Every entry of a raw tree whose bytes were already verified against the tree's id. Names are read as UTF-8; an entry git itself would refuse
 * (an empty name, `.`, `..`, `.git`, or a name holding `/`) means the tree was tampered with and stops the read.
 */
export function parseTreeListing(bytes: Buffer, hashBytes: number): TreeListingEntry[] {
  const listed: TreeListingEntry[] = [];
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(0x20, position);
    if (space <= position) throw new BaseObjectsUnverified();
    const mode = bytes.toString("latin1", position, space);
    if (!/^[0-7]{5,7}$/u.test(mode)) throw new BaseObjectsUnverified();
    const end = bytes.indexOf(0, space + 1);
    if (end <= space + 1 || end + 1 + hashBytes > bytes.length) throw new BaseObjectsUnverified();
    const name = bytes.toString("utf8", space + 1, end);
    if (name === "." || name === ".." || name.toLowerCase() === ".git" || name.includes("/")) throw new BaseObjectsUnverified();
    // A name that is not valid UTF-8 cannot be addressed by a path the resolver builds, so it is left out.
    if (name.includes("\uFFFD")) { position = end + 1 + hashBytes; continue; }
    listed.push({ name, mode: Number.parseInt(mode, 8), oid: bytes.toString("hex", end + 1, end + 1 + hashBytes) });
    if (listed.length > MAX_TREE_ENTRIES) throw new BaseObjectsUnverified();
    position = end + 1 + hashBytes;
  }
  const names = new Set<string>();
  for (const entry of listed) {
    if (names.has(entry.name)) throw new BaseObjectsUnverified();
    names.add(entry.name);
  }
  return listed;
}

/**
 * A base commit's objects, opened once and read many times: the same verified copy {@link readVerifiedBaseRuleFile} makes (one scratch directory
 * of linked packs, a read-only empty git directory, every object hashed against its own id), kept open until `close()`. `fetchObject` returns the
 * bytes of a commit, tree or blob only when they hash to the id asked for, and `rootTreeId` is the verified commit's tree. The overall deadline
 * runs from `open` to `close`; every failure is {@link BaseObjectsUnverified}. The caller must `close()` (it removes the scratch directory).
 */
export interface VerifiedBaseObjects {
  readonly rootTreeId: string;
  readonly hashBytes: number;
  fetchObject(type: "commit" | "tree" | "blob", oid: string, maximum: number, keep: number): Promise<{ size: number; bytes: Buffer | undefined }>;
  close(): Promise<void>;
}

export async function openVerifiedBaseObjects(directory: string, baseCommit: string, options: ReadOptions = {}): Promise<VerifiedBaseObjects> {
  const algorithm = algorithmOf(baseCommit);
  const hashBytes = algorithm === "sha1" ? 20 : 32;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? OVERALL_DEADLINE_MS);
  const { signal } = controller;
  let scratch: string | undefined;
  const cleanUp = async (): Promise<void> => {
    clearTimeout(deadline);
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    const layout = await candidateLayout(directory);
    const now = options.now ?? Date.now;
    const root = await scratchRootFor(layout.objects, options.workspaceRoot, options.linkFile ?? link, now);
    await removeStaleScratch(root, now);
    scratch = await mkdtemp(join(root, SCRATCH_PREFIX));
    const objectsDirectory = join(scratch, "objects");
    await mkdir(join(objectsDirectory, "pack"), { recursive: true, mode: 0o700 });
    await options.onScratchReady?.({ scratch, objects: objectsDirectory });
    const hardening = options.gitHardeningForTest;
    const gitDir = hardening?.gitDirectory?.(scratch) ?? await emptyGitDirectory(algorithm, options.emptyGitDirectoryRoot);
    // GIT_DIR is read-only and empty. GIT_NO_LAZY_FETCH is honoured by Git 2.45 and later (the image's 2.39 ignores it), and the protocol settings are command-line
    // configuration, which Git does honour; `core.repositoryformatversion` and `extensions.*` are read only from the repository's own config file, so they cannot be set here.
    const env = isolatedGitEnvironment(gitDir, { GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objectsDirectory, GIT_OPTIONAL_LOCKS: "0", ...(hardening?.noLazyFetch === false ? {} : { GIT_NO_LAZY_FETCH: "1" }) },
      hardening?.protocolBans === false ? [] : ["ext", "file", "git", "http", "https", "ssh"].map((name) => [`protocol.${name}.allow`, "never"] as const));
    const placement: Placement = { link: options.linkFile ?? link, signal, copyLimit: options.copyLimitBytes ?? COPY_LIMIT_BYTES, copied: 0 };
    // One link per pack file and index; the workspace's `objects/info` and everything else in its git directory is left out.
    const packs = join(layout.objects, "pack");
    if (await plainDirectory(packs)) {
      const names = (await readdir(packs)).filter((name) => PACK_FILE.test(name));
      if (names.length > (options.maxPackFiles ?? MAX_PACK_FILES)) throw new BaseObjectsUnverified();
      for (const name of names) {
        if (signal.aborted) throw new BaseObjectsUnverified();
        await place(join(packs, name), join(objectsDirectory, "pack", name), placement);
      }
    }
    const scratchDirectory = scratch;
    const fetch = async (type: "commit" | "tree" | "blob", oid: string, maximum: number, keep: number, signal: AbortSignal): Promise<{ size: number; bytes: Buffer | undefined }> => {
      const callPlacement: Placement = { ...placement, signal };
      // A loose object is linked in only for the object being read: one link per read, however many loose objects the workspace holds.
      let looseTarget: string | undefined;
      const loose = join(layout.objects, oid.slice(0, 2));
      if (await plainDirectory(loose)) {
        await mkdir(join(objectsDirectory, oid.slice(0, 2)), { recursive: true });
        const target = join(objectsDirectory, oid.slice(0, 2), oid.slice(2));
        const placed = await place(join(loose, oid.slice(2)), target, callPlacement);
        placement.copied = callPlacement.copied;
        if (placed) looseTarget = target;
      }
      const attempt = async (): Promise<{ size: number; bytes: Buffer | undefined }> => {
        const sizeText = (await execFile("git", ["cat-file", "-s", oid], { cwd: scratchDirectory, env, timeout: GIT_TIMEOUT_MS, signal, encoding: "utf8", maxBuffer: 64 })).stdout.trim();
        if (!/^\d{1,15}$/u.test(sizeText)) throw new BaseObjectsUnverified();
        const size = Number(sizeText);
        if (size > maximum) throw new BaseObjectsUnverified();
        return { size, bytes: await streamVerified(scratchDirectory, env, algorithm, type, oid, size, keep, signal) };
      };
      try {
        return await attempt();
      } catch (error) {
        // A loose copy that does not match is left out and the object is read from the packs alone (git reads loose objects first).
        if (looseTarget === undefined || signal.aborted) throw error;
        await rm(looseTarget, { force: true });
        return attempt();
      }
    };
    // One deadline for opening (linking the packs, reading the commit) and a fresh one for every object read afterwards: a resolve that reads
    // many files is not cut off by a clock that has been running since the source was opened. Reads are serialised, which the placement
    // counters rely on.
    let reading: Promise<unknown> = Promise.resolve();
    const fetchObject: VerifiedBaseObjects["fetchObject"] = (type, oid, maximum, keep) => {
      const run = reading.then(async () => {
        const each = new AbortController();
        const timer = setTimeout(() => each.abort(), options.deadlineMs ?? OVERALL_DEADLINE_MS);
        try {
          return await fetch(type, oid, maximum, keep, each.signal);
        } catch (error) {
          throw error instanceof BaseObjectsUnverified ? error : new BaseObjectsUnverified();
        } finally {
          clearTimeout(timer);
        }
      });
      reading = run.catch(() => undefined);
      return run;
    };
    const commit = (await fetch("commit", baseCommit, COMMIT_BYTES, COMMIT_BYTES, signal)).bytes!;
    clearTimeout(deadline);
    const rootTreeId = commitTreeId(commit, hashBytes);
    return { rootTreeId, hashBytes, fetchObject, close: cleanUp };
  } catch (error) {
    await cleanUp();
    throw error instanceof BaseObjectsUnverified ? error : new BaseObjectsUnverified();
  }
}

/**
 * The verified rule file of `baseCommit`'s tree, by the first of `candidates` that the tree names. Throws {@link BaseObjectsUnverified} when the
 * commit, the tree or the rule file is missing, malformed, or does not hash to its id, or when the deadline passes. A commit whose tree names none
 * of the candidates gives `absent`. `limit` is the largest rule file whose bytes are returned; a larger one is still verified (its bytes are hashed
 * as they stream, so a stored size that was changed is caught), and reported by its size.
 */
export async function readVerifiedBaseRuleFile(directory: string, baseCommit: string, candidates: readonly string[], limit: number, options: ReadOptions = {}): Promise<BaseRuleFile> {
  const objects = await openVerifiedBaseObjects(directory, baseCommit, options);
  try {
    const tree = (await objects.fetchObject("tree", objects.rootTreeId, TREE_BYTES, TREE_BYTES)).bytes!;
    const entries = parseTreeEntries(tree, objects.hashBytes, new Set(candidates));
    for (const candidate of candidates) {
      const entry = entries.get(candidate);
      if (entry === undefined) continue;
      const kind = entry.mode & 0o170000;
      // Directories and submodules are passed over, as the working-tree read passes over them.
      if (kind === 0o120000) return { kind: "symlink", candidate };
      if (kind !== 0o100000) continue;
      const blob = await objects.fetchObject("blob", entry.oid, options.maxBlobBytes ?? MAX_BLOB_BYTES, limit);
      if (blob.bytes === undefined) return { kind: "oversize", candidate, size: blob.size };
      return { kind: "file", candidate, content: blob.bytes };
    }
    return { kind: "absent" };
  } catch (error) {
    throw error instanceof BaseObjectsUnverified ? error : new BaseObjectsUnverified();
  } finally {
    await objects.close();
  }
}

/** The most a tree may hold in bytes (the same bound the rule-file read uses). */
export const VERIFIED_TREE_BYTES = TREE_BYTES;
/** The most a blob whose bytes are hashed may hold. */
export const VERIFIED_MAX_BLOB_BYTES = MAX_BLOB_BYTES;

/**
 * Runs `git cat-file <type> <oid>`, hashes `<type> <size>\0` plus what it prints, and resolves with the bytes (when `size` is at most `keep`) only when
 * exactly `size` bytes came and the digest equals `oid`. More bytes than `size`, a non-zero exit, or the deadline, reject; nothing is buffered beyond `keep`.
 */
function streamVerified(cwd: string, env: NodeJS.ProcessEnv, algorithm: Algorithm, type: string, oid: string, size: number, keep: number, signal: AbortSignal): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", type, oid], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    const hash = createHash(algorithm);
    hash.update(`${type} ${String(size)}\0`);
    const kept: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new BaseObjectsUnverified()), GIT_TIMEOUT_MS);
    const onAbort = () => finish(new BaseObjectsUnverified());
    function finish(error?: BaseObjectsUnverified, bytes?: Buffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(bytes);
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", () => finish(new BaseObjectsUnverified()));
    child.stdout.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > size) return finish(new BaseObjectsUnverified());
      hash.update(chunk);
      if (size <= keep) kept.push(chunk);
      return undefined;
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0 || received !== size || hash.digest("hex") !== oid) return finish(new BaseObjectsUnverified());
      return finish(undefined, size <= keep ? Buffer.concat(kept) : undefined);
    });
  });
}
