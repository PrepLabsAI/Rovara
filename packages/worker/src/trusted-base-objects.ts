import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
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
// commit graphs). It runs in an empty git directory this module makes in a worker-owned scratch directory, which holds only objects: the workspace's
// pack files (and their indexes) are linked in, and a loose object is linked in only when it is one of the three that are read. The workspace's config,
// hooks, `info/` files and refs are never copied.
//
// The scratch directory is made on the workspace's own file system, where a hard link works and nothing is copied. Every workspace file that is
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
const SCRATCH_PREFIX = "agentx-base-rules-";
const STALE_SCRATCH_MS = 60 * 60 * 1000;

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
}

/**
 * Where the scratch directory goes: the temporary directory when it is on the workspace's file system (hard links then work), else a directory the
 * worker owns (mode 0700, not a link) on that file system under the workspace root, else the temporary directory (files are then copied, under limits).
 */
export async function chooseScratchRoot(workspaceRoot: string | undefined, device: number, base: string = tmpdir()): Promise<string> {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  /** The directory's own path when it can be used as a scratch root. The temporary directory may be reached through a link (as /tmp is on some systems); a directory under the workspace may not. */
  const usable = async (path: string, create: boolean, mayBeLinked: boolean): Promise<string | undefined> => {
    try {
      if (create) await mkdir(path, { recursive: true, mode: 0o700 });
      const real = await realpath(path);
      if (!mayBeLinked && real !== path) return undefined;
      const stat = await lstat(real);
      if (!stat.isDirectory() || stat.dev !== device) return undefined;
      return mayBeLinked || (stat.uid === owner && (stat.mode & 0o777) === 0o700) ? real : undefined;
    } catch {
      return undefined;
    }
  };
  const temporary = await usable(base, false, true);
  if (temporary !== undefined) return temporary;
  if (workspaceRoot !== undefined) {
    const runtime = await usable(join(workspaceRoot, ".agentx-runtime", "tmp"), false, false);
    if (runtime !== undefined) return runtime;
    const own = await usable(join(workspaceRoot, ".agentx", "scratch"), true, false);
    if (own !== undefined) return own;
  }
  return base;
}

/** Removes scratch directories an earlier read left behind (a killed worker), so they cannot pile up. Best effort. */
async function removeStaleScratch(root: string): Promise<void> {
  try {
    for (const name of await readdir(root)) {
      if (!name.startsWith(SCRATCH_PREFIX)) continue;
      const stat = await lstat(join(root, name)).catch(() => undefined);
      if (stat?.isDirectory() === true && Date.now() - stat.mtimeMs > STALE_SCRATCH_MS) await rm(join(root, name), { recursive: true, force: true });
    }
  } catch { /* nothing to clean */ }
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

/**
 * The verified rule file of `baseCommit`'s tree, by the first of `candidates` that the tree names. Throws {@link BaseObjectsUnverified} when the
 * commit, the tree or the rule file is missing, malformed, or does not hash to its id, or when the deadline passes. A commit whose tree names none
 * of the candidates gives `absent`. `limit` is the largest rule file whose bytes are returned; a larger one is still verified (its bytes are hashed
 * as they stream, so a stored size that was changed is caught), and reported by its size.
 */
export async function readVerifiedBaseRuleFile(directory: string, baseCommit: string, candidates: readonly string[], limit: number, options: ReadOptions = {}): Promise<BaseRuleFile> {
  const algorithm = algorithmOf(baseCommit);
  const hashBytes = algorithm === "sha1" ? 20 : 32;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), options.deadlineMs ?? OVERALL_DEADLINE_MS);
  const { signal } = controller;
  let scratch: string | undefined;
  try {
    const layout = await candidateLayout(directory);
    const root = await chooseScratchRoot(options.workspaceRoot, (await lstat(layout.objects)).dev);
    await removeStaleScratch(root);
    scratch = await mkdtemp(join(root, SCRATCH_PREFIX));
    const gitDir = join(scratch, "base.git");
    await execFile("git", ["init", "--bare", "--quiet", "--template=", `--object-format=${algorithm}`, gitDir], { cwd: scratch, env: isolatedGitEnvironment(scratch), timeout: GIT_TIMEOUT_MS, signal });
    const env = isolatedGitEnvironment(scratch, { GIT_DIR: gitDir, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" });
    const placement: Placement = { link: options.linkFile ?? link, signal, copyLimit: options.copyLimitBytes ?? COPY_LIMIT_BYTES, copied: 0 };
    // One link per pack file and index; the workspace's `objects/info` and everything else in its git directory is left out.
    const packs = join(layout.objects, "pack");
    if (await plainDirectory(packs)) {
      for (const name of await readdir(packs)) {
        if (PACK_FILE.test(name)) await place(join(packs, name), join(gitDir, "objects/pack", name), placement);
      }
    }
    const fetch = async (type: "commit" | "tree" | "blob", oid: string, maximum: number, keep: number): Promise<{ size: number; bytes: Buffer | undefined }> => {
      // A loose object is linked in only for the object being read: one link per read, however many loose objects the workspace holds.
      let looseTarget: string | undefined;
      const loose = join(layout.objects, oid.slice(0, 2));
      if (await plainDirectory(loose)) {
        await mkdir(join(gitDir, "objects", oid.slice(0, 2)), { recursive: true });
        const target = join(gitDir, "objects", oid.slice(0, 2), oid.slice(2));
        if (await place(join(loose, oid.slice(2)), target, placement)) looseTarget = target;
      }
      const attempt = async (): Promise<{ size: number; bytes: Buffer | undefined }> => {
        const sizeText = (await execFile("git", ["cat-file", "-s", oid], { cwd: scratch, env, timeout: GIT_TIMEOUT_MS, signal, encoding: "utf8", maxBuffer: 64 })).stdout.trim();
        if (!/^\d{1,15}$/u.test(sizeText)) throw new BaseObjectsUnverified();
        const size = Number(sizeText);
        if (size > maximum) throw new BaseObjectsUnverified();
        return { size, bytes: await streamVerified(scratch!, env, algorithm, type, oid, size, keep, signal) };
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
    const commit = (await fetch("commit", baseCommit, COMMIT_BYTES, COMMIT_BYTES)).bytes!;
    const treeId = commitTreeId(commit, hashBytes);
    const tree = (await fetch("tree", treeId, TREE_BYTES, TREE_BYTES)).bytes!;
    const entries = parseTreeEntries(tree, hashBytes, new Set(candidates));
    for (const candidate of candidates) {
      const entry = entries.get(candidate);
      if (entry === undefined) continue;
      const kind = entry.mode & 0o170000;
      // Directories and submodules are passed over, as the working-tree read passes over them.
      if (kind === 0o120000) return { kind: "symlink", candidate };
      if (kind !== 0o100000) continue;
      const blob = await fetch("blob", entry.oid, Number.MAX_SAFE_INTEGER, limit);
      if (blob.bytes === undefined) return { kind: "oversize", candidate, size: blob.size };
      return { kind: "file", candidate, content: blob.bytes };
    }
    return { kind: "absent" };
  } catch (error) {
    throw error instanceof BaseObjectsUnverified ? error : new BaseObjectsUnverified();
  } finally {
    clearTimeout(deadline);
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

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
