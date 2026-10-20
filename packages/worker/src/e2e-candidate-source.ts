import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";

const SHA1 = /^[a-f0-9]{40}$/;
const GIT_OUTPUT_CAP_BYTES = 4096;
const STDERR_TAIL_BYTES = 2048;
const REGULAR_FILE_CAP_BYTES = 8 * 1024 * 1024;

/** How the worker reads the candidate commit it is about to build. The default is the `git` and `tar` on this machine. */
export type CandidateGit = {
  /** The tree id of `commitSha` (`git -C <root> rev-parse <commitSha>^{tree}`). */
  treeOf(repositoryRoot: string, commitSha: string, signal: AbortSignal): Promise<string>;
  /** Extracts exactly the files of commit `commitSha` (`git -C <root> archive`) into the existing directory `destination`. */
  archiveInto(repositoryRoot: string, commitSha: string, destination: string, signal: AbortSignal): Promise<void>;
};

/** The part of an approved build source manifest the worker enforces on what it staged. */
export type ApprovedBuildSource = {
  files: ReadonlyArray<{ path: string; mode: "100644" | "100755"; sha256: string }>;
  omissions: ReadonlyArray<{ path: string }>;
};

/**
 * Everything git and tar get from this process. The candidate's own code can write into its repository, so git is told to trust nothing but the
 * objects named by id: no replace refs, no system or global config, no home directory, and none of this worker's credentials.
 */
export function candidateGitEnvironment(): Record<string, string> {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}
/**
 * Repository-local attribute files cannot be switched off by environment, so the global one is pinned empty and `enforceApprovedBuildSource` holds the content.
 * `safe.directory` is set on the command line (a protected place) for the worker's own repository path only: with no home or global config, git would
 * otherwise refuse a repository whose owner is not the worker's user.
 */
const gitFlags = (repositoryRoot: string): string[] => ["-c", "core.attributesFile=/dev/null", "-c", `safe.directory=${repositoryRoot}`];
const NOT_A_SHA = "candidate commit is not a full lowercase hex object id";
const tailOf = (text: string): string => (text.length <= STDERR_TAIL_BYTES ? text : text.slice(text.length - STDERR_TAIL_BYTES)).trim();

export function createProcessCandidateGit(): CandidateGit {
  return {
    treeOf: (repositoryRoot, commitSha, signal) => new Promise<string>((resolve, reject) => {
      if (!SHA1.test(commitSha)) { reject(new Error(NOT_A_SHA)); return; }
      execFile("git", [...gitFlags(repositoryRoot), "-C", repositoryRoot, "rev-parse", `${commitSha}^{tree}`], { env: candidateGitEnvironment(), maxBuffer: GIT_OUTPUT_CAP_BYTES, signal, encoding: "utf8" }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`could not read the candidate tree: ${tailOf(stderr) || error.message}`)); return; }
        const tree = stdout.trim();
        if (!SHA1.test(tree)) { reject(new Error("git did not answer with a tree id")); return; }
        resolve(tree);
      });
    }),
    archiveInto: (repositoryRoot, commitSha, destination, signal) => new Promise<void>((resolve, reject) => {
      if (!SHA1.test(commitSha)) { reject(new Error(NOT_A_SHA)); return; }
      if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("candidate extraction was cancelled")); return; }
      const archive = spawn("git", [...gitFlags(repositoryRoot), "-C", repositoryRoot, "archive", "--format=tar", commitSha], { env: candidateGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
      // -p keeps the archive's modes whatever this process's umask is: the build container's unprivileged user must be able to read the tree.
      const extract = spawn("tar", ["-x", "-p", "-f", "-", "-C", destination, "--no-same-owner"], { env: candidateGitEnvironment(), stdio: ["pipe", "ignore", "pipe"] });
      let archiveStderr = ""; let extractStderr = "";
      let archiveCode: number | null | undefined; let extractCode: number | null | undefined;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (error) { archive.kill("SIGKILL"); extract.kill("SIGKILL"); reject(error); } else resolve();
      };
      const onAbort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("candidate extraction was cancelled"));
      const check = () => {
        if (archiveCode === undefined || extractCode === undefined) return;
        if (archiveCode !== 0) finish(new Error(`git archive failed: ${tailOf(archiveStderr)}`));
        else if (extractCode !== 0) finish(new Error(`tar failed: ${tailOf(extractStderr)}`));
        else finish();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      archive.stderr.on("data", (chunk: Buffer) => { archiveStderr = tailOf(archiveStderr + chunk.toString("utf8")); });
      extract.stderr.on("data", (chunk: Buffer) => { extractStderr = tailOf(extractStderr + chunk.toString("utf8")); });
      extract.stdin.on("error", () => undefined);
      archive.stdout.pipe(extract.stdin);
      archive.once("error", (error) => finish(new Error(`could not run git: ${error.message}`)));
      extract.once("error", (error) => finish(new Error(`could not run tar: ${error.message}`)));
      archive.once("close", (code) => { archiveCode = code ?? 1; check(); });
      extract.once("close", (code) => { extractCode = code ?? 1; check(); });
    }),
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
 * extracted into a fresh `destination` (its parent must exist) and held to every approved build source manifest. A refused tree is removed.
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
    await input.git.archiveInto(input.repositoryRoot, input.commitSha, input.destination, input.signal);
    // The build container's unprivileged user reads this tree through a read-only mount.
    await chmod(input.destination, 0o755);
    for (const manifest of input.manifests) await enforceApprovedBuildSource(input.destination, manifest);
  } catch (error) {
    await removeWithoutFollowing(dirname(input.destination), basename(input.destination)).catch(() => undefined);
    throw error;
  }
}
