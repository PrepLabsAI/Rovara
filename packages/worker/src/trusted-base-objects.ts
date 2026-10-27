import { execFile as execFileCallback, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
// inflate stored objects; nothing it reports about their content is believed.
//
// Git never starts with the workspace's `.git` as its git directory and never follows the workspace's `objects/info` (alternates, pack lists,
// commit graphs). It runs in an empty git directory this module makes under the temporary directory, which holds only objects: the workspace's pack
// files (and their indexes) are linked in, and a loose object is linked in only when it is one of the three that are read. The workspace's config, hooks,
// `info/` files and refs are never copied.

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
const COMMIT_BYTES = 1024 * 1024;
const TREE_BYTES = 64 * 1024 * 1024;
/** The most a blob that is only being hashed (one over the size limit) may be; a larger one cannot be verified in the time allowed. */
const OVERSIZE_BLOB_BYTES = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 60_000;

type Algorithm = "sha1" | "sha256";

function algorithmOf(commit: string): Algorithm {
  if (SHA1_ID.test(commit)) return "sha1";
  if (SHA256_ID.test(commit)) return "sha256";
  throw new BaseObjectsUnverified();
}

export interface TreeEntry { mode: number; oid: string }

/** The entries of a raw tree (`<mode> <name>\0<raw id>`, repeated) whose names are in `wanted`; any malformed byte, or a wanted name twice, is refused. */
export function parseTreeEntries(bytes: Buffer, hashBytes: number, wanted: ReadonlySet<string>): Map<string, TreeEntry> {
  const found = new Map<string, TreeEntry>();
  let position = 0;
  while (position < bytes.length) {
    const space = bytes.indexOf(0x20, position);
    if (space <= position) throw new BaseObjectsUnverified();
    const mode = bytes.toString("latin1", position, space);
    if (!/^[1-7][0-7]{4,5}$/u.test(mode)) throw new BaseObjectsUnverified();
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

/** Puts the workspace's regular file `source` at `target`: a hard link where the file system allows one, a copy (a reference copy where supported) otherwise. A link or anything that is not a regular file is skipped. */
async function place(source: string, target: string): Promise<boolean> {
  const stat = await lstat(source).catch(() => undefined);
  if (stat === undefined || !stat.isFile()) return false;
  try {
    await link(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return true;
    // Never over an existing target: a link made earlier shares the workspace file's storage.
    await copyFile(source, target, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL);
  }
  return true;
}

/**
 * The verified rule file of `baseCommit`'s tree, by the first of `candidates` that the tree names. Throws {@link BaseObjectsUnverified} when the
 * commit, the tree or the rule file is missing, malformed, or does not hash to its id. A commit whose tree names none of the candidates gives `absent`.
 * `limit` is the largest rule file whose bytes are returned; a larger one is still verified, and reported by its size.
 */
export async function readVerifiedBaseRuleFile(directory: string, baseCommit: string, candidates: readonly string[], limit: number): Promise<BaseRuleFile> {
  const algorithm = algorithmOf(baseCommit);
  const hashBytes = algorithm === "sha1" ? 20 : 32;
  let scratch: string | undefined;
  try {
    const layout = await candidateLayout(directory);
    scratch = await mkdtemp(join(tmpdir(), "agentx-base-rules-"));
    const gitDir = join(scratch, "base.git");
    await execFile("git", ["init", "--bare", "--quiet", "--template=", `--object-format=${algorithm}`, gitDir], { cwd: scratch, env: isolatedGitEnvironment(scratch), timeout: GIT_TIMEOUT_MS });
    const env = isolatedGitEnvironment(scratch, { GIT_DIR: gitDir, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" });
    // One link per pack file and index; the workspace's `objects/info` and everything else in its git directory is left out.
    const packs = join(layout.objects, "pack");
    if (await plainDirectory(packs)) {
      for (const name of await readdir(packs)) {
        if (PACK_FILE.test(name)) await place(join(packs, name), join(gitDir, "objects/pack", name));
      }
    }
    const fetch = async (type: "commit" | "tree" | "blob", oid: string, maximum: number, keep: number): Promise<{ size: number; bytes: Buffer | undefined }> => {
      // A loose object is linked in only for the object being read: one link per read, however many loose objects the workspace holds.
      const loose = join(layout.objects, oid.slice(0, 2));
      if (await plainDirectory(loose)) {
        await mkdir(join(gitDir, "objects", oid.slice(0, 2)), { recursive: true });
        await place(join(loose, oid.slice(2)), join(gitDir, "objects", oid.slice(0, 2), oid.slice(2)));
      }
      const sizeText = (await execFile("git", ["cat-file", "-s", oid], { cwd: scratch, env, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 })).stdout.trim();
      if (!/^\d{1,12}$/u.test(sizeText)) throw new BaseObjectsUnverified();
      const size = Number(sizeText);
      if (size > maximum) throw new BaseObjectsUnverified();
      return { size, bytes: await streamVerified(scratch!, env, algorithm, type, oid, size, keep) };
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
      const blob = await fetch("blob", entry.oid, OVERSIZE_BLOB_BYTES, limit);
      if (blob.bytes === undefined) return { kind: "oversize", candidate, size: blob.size };
      return { kind: "file", candidate, content: blob.bytes };
    }
    return { kind: "absent" };
  } catch (error) {
    throw error instanceof BaseObjectsUnverified ? error : new BaseObjectsUnverified();
  } finally {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Runs `git cat-file <type> <oid>`, hashes `<type> <size>\0` plus what it prints, and resolves with the bytes (when `size` is at most `keep`) only when
 * exactly `size` bytes came and the digest equals `oid`. More bytes than `size`, a non-zero exit, or the time limit, reject; nothing is buffered beyond `keep`.
 */
function streamVerified(cwd: string, env: NodeJS.ProcessEnv, algorithm: Algorithm, type: string, oid: string, size: number, keep: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["cat-file", type, oid], { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
    const hash = createHash(algorithm);
    hash.update(`${type} ${String(size)}\0`);
    const kept: Buffer[] = [];
    let received = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new BaseObjectsUnverified()), GIT_TIMEOUT_MS);
    function finish(error?: BaseObjectsUnverified, bytes?: Buffer): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(bytes);
    }
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
