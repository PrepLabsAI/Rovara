// Q1 redesign: NEVER restore into the candidate. Read tracked bytes/modes and isolated Git status
// before and after; mutate a fresh, hard-link-free copy per mutant. Copies never contain .git.
// Untracked/ignored test artifacts are copied but are NOT part of the candidate integrity comparison.
// No recovery journal names a candidate write: a worker crash leaves only disposable scratch. A timed
// out child may still be writing its copy; its owner must sweep it after writers stop.
// Settled copies are deleted by the caller; deletion never establishes candidate integrity.
// These filesystem guards are not a sandbox for arbitrary test programs. The injected runner must
// mount ONLY the supplied copy as its project; never reuse a runner closed over the candidate.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { mutationPathRefused, type SpotMutant } from "@agentx/contracts";
import { candidateWriteStep, openDirectory, removeIn, type HeldDirectory } from "../candidate-fs.js";
import { withIsolatedRepository } from "../isolated-repository.js";

const COPY_FILE_BYTES = 32 * 1024 * 1024;
const COPY_TOTAL_BYTES = 512 * 1024 * 1024;
const COPY_ENTRIES = 20_000;
export class MutationCopyTooLarge extends Error {}
const REFUSED = "mutation copy refused";
export type Checkpoint = () => void;
const noDeadline = () => undefined;
export interface CandidateSnapshot { digest: string; status: string }
export interface MutationCopy { readonly directory: string }
const ownedCopies = new WeakSet<MutationCopy>();

function components(path: string): string[] {
  const parts = path.split("/");
  if (mutationPathRefused(path) || isAbsolute(path) || path.includes("\\") || parts.some((part) => part === "" || part === "." || part === ".." || part.toLowerCase() === ".git")) throw new Error(REFUSED);
  return parts;
}
async function parentOf(root: string, path: string): Promise<{ directory: HeldDirectory; name: string }> {
  const parts = components(path);
  let directory = await openDirectory(root);
  try {
    for (const part of parts.slice(0, -1)) {
      const info = await lstat(directory.entry(part));
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(REFUSED);
      const next = await directory.subdirectory(part, false);
      if (next === undefined) throw new Error(REFUSED);
      await directory.close(); directory = next;
    }
    return { directory, name: parts.at(-1)! };
  } catch (error) { await directory.close(); throw error; }
}

async function readPlain(root: string, path: string, cap: number, checkpoint: Checkpoint): Promise<{ bytes: Buffer; mode: number }> {
  checkpoint();
  const { directory, name } = await parentOf(root, path);
  let handle;
  try {
    const before = await lstat(directory.entry(name));
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > cap) throw new Error(REFUSED);
    handle = await open(directory.entry(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino || info.size > cap) throw new Error(REFUSED);
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      checkpoint();
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || after.nlink !== 1) throw new Error(REFUSED);
    checkpoint();
    return { bytes: bytes.subarray(0, length), mode: info.mode & 0o7777 };
  } finally { await handle?.close(); await directory.close(); }
}
export async function readMutationSource(root: string, path: string, cap: number, checkpoint: Checkpoint = noDeadline): Promise<string> {
  return new TextDecoder("utf-8", { fatal: true }).decode((await readPlain(root, path, cap, checkpoint)).bytes);
}

/** Read-only Git session, copied index, literal paths, no refresh persisted to the candidate. */
export async function snapshotCandidate(root: string, checkpoint: Checkpoint = noDeadline): Promise<CandidateSnapshot> {
  checkpoint();
  const listing = await withIsolatedRepository(root, "read", { refs: true, index: "work" }, async (git) => ({
    paths: await git.text(["--literal-pathspecs", "ls-files", "--cached", "-z"], { index: "work", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }),
    status: await git.text(["--literal-pathspecs", "-c", "core.filemode=true", "status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=all"], { index: "work", timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }),
  }));
  const hash = createHash("sha256");
  const paths = [...new Set(listing.paths.split("\0").filter(Boolean))].sort();
  if (paths.length > COPY_ENTRIES) throw new Error(REFUSED);
  let bytes = 0;
  for (const path of paths) {
    checkpoint(); components(path);
    try {
      const file = await readPlain(root, path, COPY_FILE_BYTES, checkpoint);
      bytes += file.bytes.length;
      if (bytes > COPY_TOTAL_BYTES) throw new Error(REFUSED);
      hash.update(JSON.stringify([path, file.mode, file.bytes.length])); hash.update(file.bytes);
    } catch (error) {
      // Tracked deletions still have a position in the fingerprint. Every other failure refuses.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(JSON.stringify([path, "missing"]));
    }
  }
  checkpoint();
  return { digest: hash.digest("hex"), status: listing.status };
}

/** Copy files independently and retain only links resolving wholly inside the finished copy.
 * Links are never traversed, so dependency aliases do not count their target entries twice. */
export async function createMutationCopy(candidate: string, runDir: string, checkpoint: Checkpoint = noDeadline): Promise<MutationCopy> {
  checkpoint();
  const source = await realpath(candidate); const scratch = await realpath(runDir);
  const rel = relative(source, scratch);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) throw new Error(REFUSED);
  const directory = await mkdtemp(join(scratch, "copy-"));
  let total = 0; let entries = 0;
  const links: string[] = [];
  const walk = async (path: string, depth: number): Promise<void> => {
    checkpoint();
    if (depth > 64) throw new Error(REFUSED);
    const held = await openDirectory(path === "" ? source : join(source, path));
    try {
      for (const name of await readdir(held.descriptorPath ?? held.path)) {
        checkpoint();
        if (path === "" && name === ".git") continue;
        const child = path === "" ? name : `${path}/${name}`;
        components(child);
        entries += 1;
        if (entries > COPY_ENTRIES) throw new MutationCopyTooLarge();
        const info = await lstat(held.entry(name));
        if (info.isSymbolicLink()) {
          const target = await readlink(held.entry(name));
          // Absolute links back to the candidate are aliases, never copied as capabilities.
          if (isAbsolute(target)) throw new Error(REFUSED);
          await symlink(target, join(directory, child)); links.push(child);
        } else if (info.isDirectory()) { await mkdir(join(directory, child), { mode: 0o700 }); await walk(child, depth + 1); }
        else {
          const file = await readPlain(source, child, COPY_FILE_BYTES, checkpoint);
          total += file.bytes.length;
          if (total > COPY_TOTAL_BYTES) throw new Error(REFUSED);
          await writeFile(join(directory, child), file.bytes, { flag: "wx", mode: file.mode & 0o777 });
        }
      }
    } finally { await held.close(); }
  };
  try {
    await walk("", 0);
    for (const link of links) {
      checkpoint();
      const target = await realpath(join(directory, link));
      const rel = relative(directory, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(REFUSED);
    }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const copy: MutationCopy = Object.freeze({ directory }); ownedCopies.add(copy);
  return copy;
}

/** Only a capability produced above can be written; never a caller-supplied candidate directory. */
export async function writeScratchMutant(copy: MutationCopy, mutant: SpotMutant, original: string): Promise<void> {
  if (!ownedCopies.has(copy)) throw new Error(REFUSED);
  const { directory, name } = await parentOf(copy.directory, mutant.path);
  let handle;
  try {
    const before = await lstat(directory.entry(name));
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) throw new Error(REFUSED);
    await candidateWriteStep("mutation write");
    // NO O_TRUNC until the descriptor's identity and link count are checked.
    handle = await open(directory.entry(name), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino) throw new Error(REFUSED);
    if (info.size > 1024 * 1024 || (await handle.readFile()).toString("utf8") !== original) throw new Error(REFUSED);
    if (!Number.isSafeInteger(mutant.start) || !Number.isSafeInteger(mutant.end) || mutant.start < 0 || mutant.end <= mutant.start || mutant.end > original.length) throw new Error(REFUSED);
    const bytes = Buffer.from(original.slice(0, mutant.start) + mutant.replacement + original.slice(mutant.end));
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (bytesWritten === 0) throw new Error(REFUSED);
      offset += bytesWritten;
    }
    await handle.sync();
  } finally { await handle?.close(); await directory.close(); }
}

/** Recovery of an interrupted run needs no candidate path or original-byte journal. Never reuse the copy. */
export async function discardMutationCopy(copy: MutationCopy): Promise<void> {
  if (!ownedCopies.has(copy)) return;
  ownedCopies.delete(copy);
  await rm(copy.directory, { recursive: true, force: true }).catch(() => undefined);
}

/** Remove the named old report before starting a test; copying a report must not freshen its evidence. */
export async function clearScratchReport(copy: MutationCopy, cwd: string, argument: string): Promise<void> {
  if (!ownedCopies.has(copy)) throw new Error(REFUSED);
  const path = cwd === "." || cwd === "" ? argument : `${cwd}/${argument}`;
  const { directory, name } = await parentOf(copy.directory, path);
  try {
    const info = await lstat(directory.entry(name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return;
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(REFUSED);
    await removeIn(directory, name);
  } finally { await directory.close(); }
}
