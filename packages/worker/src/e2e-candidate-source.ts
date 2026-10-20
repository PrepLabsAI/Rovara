import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

const SHA1 = /^[a-f0-9]{40}$/;
const STDERR_TAIL_BYTES = 2048;
const REGULAR_FILE_CAP_BYTES = 8 * 1024 * 1024;
const TREE_LISTING_CAP_BYTES = 32 * 1024 * 1024;
const MAX_TREE_ENTRIES = 100_000;
const MAX_FILES = 10_000;
const MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024;
const BLOB_STREAM_CAP_BYTES = MAX_TOTAL_FILE_BYTES + MAX_FILES * 128;

/** An entry of the candidate tree that is not a regular file and so is never written: a symlink (120000) or a submodule (160000). */
export type SkippedTreeEntry = { path: string; mode: string };

/** How the worker reads the candidate commit it is about to build. The default never runs git inside the candidate's own repository. */
export type CandidateGit = {
  /** The tree id of `commitSha`, resolved by git in a worker-owned throwaway repository that only borrows the candidate's objects. */
  treeOf(repositoryRoot: string, commitSha: string, signal: AbortSignal): Promise<string>;
  /**
   * Writes exactly the regular files (100644, 100755) of commit `commitSha` into the existing directory `destination`, byte for byte, applying no filter,
   * attribute or export substitution. Symlinks and submodules are not written; they are returned so the caller can hold them to the approved omissions.
   */
  materializeInto(repositoryRoot: string, commitSha: string, destination: string, signal: AbortSignal): Promise<ReadonlyArray<SkippedTreeEntry>>;
};

/** The part of an approved build source manifest the worker enforces on what it staged. */
export type ApprovedBuildSource = {
  files: ReadonlyArray<{ path: string; mode: "100644" | "100755"; sha256: string }>;
  omissions: ReadonlyArray<{ path: string; mode: string }>;
};

/**
 * Everything git gets from this process: no replace objects, no system or global config, no home directory, no credentials, no prompts. Git is only ever
 * run in a repository this worker just created, so there is no candidate-controlled config or attributes for it to read.
 */
export function candidateGitEnvironment(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}
const GIT_FLAGS = ["-c", "core.attributesFile=/dev/null"] as const;
const NOT_A_SHA = "candidate commit is not a full lowercase hex object id";
const tailOf = (text: string): string => (text.length <= STDERR_TAIL_BYTES ? text : text.slice(text.length - STDERR_TAIL_BYTES)).trim();

/** Runs `git` with the hardened environment and no shell; kills it on abort or when its output passes `maxBytes`. */
function runGit(args: readonly string[], options: { cwd: string; signal: AbortSignal; maxBytes: number; input?: Buffer }): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    if (options.signal.aborted) { reject(options.signal.reason instanceof Error ? options.signal.reason : new Error("candidate git was cancelled")); return; }
    const child = spawn("git", [...GIT_FLAGS, ...args], { cwd: options.cwd, env: candidateGitEnvironment(), stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let total = 0; let stderr = "";
    let settled = false;
    const finish = (error?: Error, value?: Buffer) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(value!);
    };
    const onAbort = () => finish(options.signal.reason instanceof Error ? options.signal.reason : new Error("candidate git was cancelled"));
    options.signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > options.maxBytes) { finish(new Error("candidate source exceeds its size bound")); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = tailOf(stderr + chunk.toString("utf8")); });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => finish(new Error(`could not run git: ${error.message}`)));
    child.once("close", (code) => { if (code === 0) finish(undefined, Buffer.concat(chunks)); else finish(new Error(`git ${args.find((arg) => !arg.startsWith("-") && !arg.startsWith("/")) ?? ""} failed: ${stderr}`)); });
    child.stdin.end(options.input);
  });
}

const NOT_PLAIN = "candidate repository is not a plain git directory";
async function plainDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) throw new Error(NOT_PLAIN);
}

/**
 * Runs `use` against a throwaway bare repository this worker owns, created under `scratchRoot` with an empty template, no refs, no config beyond git's own
 * defaults, and `objects/info/alternates` naming only the candidate's object directory. Nothing of the candidate repository except its objects is readable
 * by git here, and the throwaway is removed on every path.
 */
async function withBorrowedObjects<T>(scratchRoot: string, repositoryRoot: string, signal: AbortSignal, use: (gitDir: string) => Promise<T>): Promise<T> {
  const realRepository = await realpath(repositoryRoot).catch(() => { throw new Error(NOT_PLAIN); });
  const gitDirectory = join(realRepository, ".git");
  const objects = join(gitDirectory, "objects");
  await plainDirectory(gitDirectory);
  await plainDirectory(objects);
  if (objects.includes("\n")) throw new Error(NOT_PLAIN);
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const work = await mkdtemp(join(scratchRoot, "git-"));
  try {
    const gitDir = join(work, "borrowed.git");
    await runGit(["init", "--bare", "--quiet", "--template=", gitDir], { cwd: work, signal, maxBytes: 4096 });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
    return await use(gitDir);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const FILE_MODES = new Set(["100644", "100755"]);
const SKIPPED_MODES = new Set(["120000", "160000"]);

/** Writes `bytes` at `relativePath` under `root`: folders are created or must be real directories, the file is created exclusively, and nothing is followed. */
async function writeFileConfined(root: string, relativePath: string, bytes: Buffer, executable: boolean): Promise<void> {
  const parts = relativePath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || relativePath.startsWith("/") || relativePath.includes("\0")) throw new Error(`${MISMATCH}: unsafe path`);
  let current = await realpath(root);
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = await lstat(current).catch(() => undefined);
    if (stat === undefined) await mkdir(current, { mode: 0o755 });
    else if (!stat.isDirectory()) throw new Error(`${MISMATCH}: ${relativePath} passes through a symlink or file`);
  }
  const target = join(current, parts.at(-1)!);
  await writeFile(target, bytes, { flag: "wx", mode: executable ? 0o755 : 0o644 });
  // The mode is set outright: a process umask must not make the tree unreadable to the build container's user.
  await chmod(target, executable ? 0o755 : 0o644);
}

export function createProcessCandidateGit(scratchRoot: string): CandidateGit {
  return {
    treeOf: async (repositoryRoot, commitSha, signal) => {
      if (!SHA1.test(commitSha)) throw new Error(NOT_A_SHA);
      return withBorrowedObjects(scratchRoot, repositoryRoot, signal, async (gitDir) => {
        const tree = (await runGit([`--git-dir=${gitDir}`, "rev-parse", `${commitSha}^{tree}`], { cwd: dirname(gitDir), signal, maxBytes: 4096 })).toString("utf8").trim();
        if (!SHA1.test(tree)) throw new Error("git did not answer with a tree id");
        return tree;
      });
    },
    materializeInto: async (repositoryRoot, commitSha, destination, signal) => {
      if (!SHA1.test(commitSha)) throw new Error(NOT_A_SHA);
      return withBorrowedObjects(scratchRoot, repositoryRoot, signal, async (gitDir) => {
        const cwd = dirname(gitDir);
        const listing = await runGit([`--git-dir=${gitDir}`, "ls-tree", "-r", "-z", "--full-tree", `${commitSha}^{tree}`], { cwd, signal, maxBytes: TREE_LISTING_CAP_BYTES });
        const records = listing.toString("utf8").split("\0").filter((record) => record !== "");
        if (records.length > MAX_TREE_ENTRIES) throw new Error("candidate tree has more entries than the build source allows");
        const files: Array<{ path: string; mode: string; sha: string }> = [];
        const skipped: SkippedTreeEntry[] = [];
        for (const record of records) {
          const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/s.exec(record);
          if (!match) throw new Error("git listed a tree entry in an unexpected form");
          const [, mode, type, sha, path] = match as unknown as [string, string, string, string, string];
          if (SKIPPED_MODES.has(mode)) skipped.push({ path, mode });
          else if (FILE_MODES.has(mode) && type === "blob") files.push({ path, mode, sha });
          else throw new Error(`candidate tree entry ${path} has a mode the build source cannot hold`);
        }
        if (files.length > MAX_FILES) throw new Error("candidate tree has more files than the build source allows");
        const blobs = files.length === 0 ? Buffer.alloc(0) : await runGit([`--git-dir=${gitDir}`, "cat-file", "--batch"],
          { cwd, signal, maxBytes: BLOB_STREAM_CAP_BYTES, input: Buffer.from(`${files.map((file) => file.sha).join("\n")}\n`) });
        let offset = 0; let totalBytes = 0;
        for (const file of files) {
          const newline = blobs.indexOf(0x0a, offset);
          const header = newline < 0 ? [] : blobs.subarray(offset, newline).toString("utf8").split(" ");
          const size = Number(header[2]);
          if (header[0] !== file.sha || header[1] !== "blob" || !Number.isSafeInteger(size) || size < 0 || size > REGULAR_FILE_CAP_BYTES) throw new Error(`candidate blob for ${file.path} is missing or too large`);
          totalBytes += size;
          if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new Error("candidate files exceed the build source size bound");
          const bytes = blobs.subarray(newline + 1, newline + 1 + size);
          if (bytes.byteLength !== size || blobs[newline + 1 + size] !== 0x0a) throw new Error(`candidate blob for ${file.path} is truncated`);
          await writeFileConfined(destination, file.path, bytes, file.mode === "100755");
          offset = newline + 2 + size;
        }
        return skipped;
      });
    },
  };
}

const MISMATCH = "staged candidate source differs from the approved build source";

/**
 * Removes `relativePath` under `root` without ever following a symlink: every folder on the way must be a real directory (a symlink or file there is
 * refused, never walked through), the leaf is unlinked or removed as it is, and a missing path is already removed. Nothing outside `root` can be touched.
 */
export async function removeWithoutFollowing(root: string, relativePath: string): Promise<void> {
  const parts = relativePath.split("/");
  if (relativePath.startsWith("/") || parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`${MISMATCH}: unsafe path to remove`);
  const realRoot = await realpath(root);
  let current = realRoot;
  for (const [index, part] of parts.entries()) {
    const next = join(current, part);
    let stat;
    try { stat = await lstat(next); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (index === parts.length - 1) { await rm(next, { recursive: true, force: true }); return; }
    if (!stat.isDirectory()) throw new Error(`${MISMATCH}: ${relativePath} passes through a symlink or file`);
    const real = await realpath(next);
    if (real !== next || !(real + sep).startsWith(realRoot + sep)) throw new Error(`${MISMATCH}: ${relativePath} leaves the staging directory`);
    current = next;
  }
}

/** The one repository the admission's candidate holds, and only when it is the exact admitted commit and tree. */
export function admittedRepositoryOf(candidate: { repositories: ReadonlyArray<{ repositoryId: string; commitSha: string; treeSha: string }> }, commitSha: string, treeSha: string): string {
  const [repository] = candidate.repositories;
  if (candidate.repositories.length !== 1 || repository === undefined) throw new Error("native E2E application candidate repository is ambiguous: the admission must name exactly one");
  if (repository.commitSha !== commitSha || repository.treeSha !== treeSha) throw new Error("native E2E application candidate repository is not the admitted commit and tree");
  return repository.repositoryId;
}

/** Every approved build source manifest must describe the admitted candidate's repository, commit and tree, not another one. */
export function assertBuildSourceBelongsToCandidate(manifests: ReadonlyArray<{ repository: { repositoryId: string; commitSha: string; treeSha: string } }>,
  admitted: { repositoryId: string; commitSha: string; treeSha: string }): void {
  for (const manifest of manifests) {
    const { repositoryId, commitSha, treeSha } = manifest.repository;
    if (repositoryId !== admitted.repositoryId || commitSha !== admitted.commitSha || treeSha !== admitted.treeSha) {
      throw new Error("an approved build source does not belong to the admitted candidate commit and tree");
    }
  }
}

/**
 * Makes the staged directory exactly the approved build source: the manifest's explicit omissions (symlinks, submodules, blocked paths) are removed, and every
 * file left must be a regular file the manifest lists, byte-identical and with the same executable bit. Anything else, or anything missing, refuses the tree.
 */
export async function enforceApprovedBuildSource(directory: string, manifest: ApprovedBuildSource): Promise<void> {
  for (const omission of manifest.omissions) await removeWithoutFollowing(directory, omission.path);
  const expected = new Map(manifest.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(relative === "" ? directory : join(directory, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const absolute = join(directory, path);
      const stat = await lstat(absolute);
      if (stat.isDirectory()) { await walk(path); continue; }
      const file = expected.get(path);
      if (!stat.isFile() || file === undefined || stat.size > REGULAR_FILE_CAP_BYTES) throw new Error(`${MISMATCH}: ${path} is not an approved regular file`);
      const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
      if (digest !== file.sha256 || ((stat.mode & 0o111) !== 0) !== (file.mode === "100755")) throw new Error(`${MISMATCH}: ${path} changed`);
      seen.add(path);
    }
  };
  await walk("");
  const missing = manifest.files.find((file) => !seen.has(file.path));
  if (missing !== undefined) throw new Error(`${MISMATCH}: ${missing.path} is missing`);
}

/**
 * Stages the exact candidate commit for a build: the repository's tree for that commit must be the admitted one before anything is created, then the commit is
 * written (blobs only) into a fresh `destination` and held to every approved build source manifest. A refused tree is removed.
 */
export async function stageCandidateSource(input: { git: CandidateGit; repositoryRoot: string; commitSha: string; treeSha: string; destination: string;
  manifests: readonly ApprovedBuildSource[]; signal: AbortSignal }): Promise<void> {
  const tree = await input.git.treeOf(input.repositoryRoot, input.commitSha, input.signal);
  if (tree !== input.treeSha) throw new Error("candidate tree does not match admission");
  // A directory a crashed attempt of this round left behind is removed (never followed), then the stage is rebuilt from the commit.
  await mkdir(dirname(input.destination), { recursive: true, mode: 0o700 });
  await removeWithoutFollowing(dirname(input.destination), basename(input.destination));
  await mkdir(input.destination, { mode: 0o755 });
  try {
    const skipped = await input.git.materializeInto(input.repositoryRoot, input.commitSha, input.destination, input.signal);
    // A symlink or submodule is never written; it must be one the approved build source explicitly omits (path and mode), or the tree is refused.
    for (const entry of skipped) {
      if (!input.manifests.every((manifest) => manifest.omissions.some((omission) => omission.path === entry.path && omission.mode === entry.mode))) {
        throw new Error(`candidate contains a symlink or submodule the approved build source does not omit: ${entry.path}`);
      }
    }
    // The build container's unprivileged user reads this tree through a read-only mount.
    await chmod(input.destination, 0o755);
    for (const manifest of input.manifests) await enforceApprovedBuildSource(input.destination, manifest);
  } catch (error) {
    await removeWithoutFollowing(dirname(input.destination), basename(input.destination)).catch(() => undefined);
    throw error;
  }
}
