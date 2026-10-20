import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";
import { candidateWriteStep, commitLock, kindIn, lockIn, openDirectory, readFileIn, releaseLock, workTreeByDescriptor, type DirectoryLock, type HeldDirectory } from "./candidate-fs.js";
import { assertNoEmbeddedRepositories, assertNoLfsFiles, isolatedGitEnvironment } from "./git.js";

const execFile = promisify(execFileCallback);

// The coding agent owns the candidate repository and keeps running while the worker reads it. Git cannot be told to ignore a repository's own config, and
// a `filter.<name>` the worker has not heard of cannot be switched off from outside, so the only safe way to run Git on the agent's files is to never
// let Git see the agent's repository: every call here names a throwaway git directory the worker created seconds ago (empty template, no hooks, no
// refs, a config of git's own defaults), and the candidate appears only as `--work-tree` (files, which carry no config) and as an object directory
// (objects, which carry none either). Nothing in this module starts Git with the candidate's `.git` as its git directory, and nothing reads the candidate's
// `.git/config` except `candidateConfigValues`, which copies a handful of plain-value keys under a strict grammar and never an executable setting.

export const NOT_PLAIN = "candidate repository is not a plain git directory";
export const HEX40 = /^[0-9a-f]{40}$/;
const SMALL_FILE_BYTES = 1024 * 1024;
const PACKED_REFS_CAP_BYTES = 256 * 1024 * 1024;

/** Settings of the candidate's own config the worker keeps because they change which bytes `git add` stages. Plain values only, never a command. */
const KEPT_CONFIG_KEYS = new Set(["core.filemode", "core.symlinks", "core.autocrlf", "core.eol", "core.safecrlf"]);
const KEPT_CONFIG_VALUE = /^[A-Za-z0-9]{1,16}$/;

/** Where the candidate repository's pieces are, checked to be real directories that are not reached through a symlink. */
export type CandidateLayout = { workTree: string; gitDirectory: string; objects: string };

async function plainDirectory(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink() || (await realpath(path)) !== path) throw new Error(NOT_PLAIN);
}

export async function candidateLayout(directory: string): Promise<CandidateLayout> {
  const workTree = await realpath(directory).catch(() => { throw new Error(NOT_PLAIN); });
  const gitDirectory = join(workTree, ".git");
  const objects = join(gitDirectory, "objects");
  await plainDirectory(gitDirectory);
  await plainDirectory(objects);
  if (objects.includes("\n")) throw new Error(NOT_PLAIN);
  return { workTree, gitDirectory, objects };
}

/** Reads a small regular file without following a symlink at its path; `undefined` when it is absent. */
export async function readSmallFile(path: string, limit: number): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new Error(NOT_PLAIN, { cause: error });
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(NOT_PLAIN);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The plain-value settings (see KEPT_CONFIG_KEYS) of the candidate's config, read from a private copy of the file. Any other key, and `include`, is never looked at. */
async function candidateConfigValues(layout: CandidateLayout, scratch: string, gitDir: string): Promise<Array<readonly [string, string]>> {
  const bytes = await readSmallFile(join(layout.gitDirectory, "config"), SMALL_FILE_BYTES);
  if (bytes === undefined) return [];
  const copy = join(scratch, "candidate-config");
  await writeFile(copy, bytes, { mode: 0o600 });
  // `--file` reads that one file and, without `--includes`, follows no include.path.
  const listing = (await execFile("git", [`--git-dir=${gitDir}`, "config", "--file", copy, "--list", "-z"], { cwd: scratch, env: isolatedGitEnvironment(layout.workTree), encoding: "utf8", maxBuffer: 4 * SMALL_FILE_BYTES })).stdout;
  const kept = new Map<string, string>();
  for (const record of listing.split("\0")) {
    if (record === "") continue;
    const newline = record.indexOf("\n");
    const key = newline < 0 ? record : record.slice(0, newline);
    // Files this setting ignores would be staged into the candidate's tree and published, and the worker does not read the file it names.
    if (key === "core.excludesfile" && (newline < 0 || record.slice(newline + 1) !== "")) {
      throw agentXError("CONFIG_INVALID", "the repository's Git config sets core.excludesFile, which AgentX does not honour when it captures your files, so files it ignores would be included. " +
        "Unset it (git config --unset core.excludesFile) and put the patterns in .gitignore or .git/info/exclude.");
    }
    if (!KEPT_CONFIG_KEYS.has(key)) continue;
    // A key with no value is a boolean true.
    const value = newline < 0 ? "true" : record.slice(newline + 1);
    if (!KEPT_CONFIG_VALUE.test(value)) throw new Error(`candidate repository sets ${key} to a value the worker does not accept`);
    kept.set(key, value);
  }
  return [...kept];
}

export type IndexKind = "temporary" | "real" | "none" | "work";

export type IsolatedRunOptions = {
  /**
   * Which index file Git works on: the worker's temporary one (the default), the candidate's real `.git/index`, none, or `"work"`: the worker's copy of the real
   * index (see isolated-repository.ts), the index a command that mirrors the work tree (checkout, reset, status) uses.
   */
  index?: IndexKind;
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
  /** Where the command starts: the private scratch directory (the default), or the work tree, for a command whose answer depends on it (`rev-parse --show-toplevel`). */
  cwd?: "scratch" | "worktree";
  /** Standard input for the command (a list of paths for `checkout-index --stdin`); the pipe is closed either way. */
  input?: string | Buffer;
};

export interface IsolatedGit {
  readonly layout: CandidateLayout;
  /** A private directory, removed with the throwaway repository. */
  readonly scratch: string;
  /** The worker's temporary index file (it does not exist until Git writes it). */
  readonly temporaryIndex: string;
  /** The worker's copy of the real index; it exists only after isolated-repository.ts has copied it. */
  readonly workIndex: string;
  /** The throwaway repository's own git directory. */
  readonly gitDir: string;
  /** The Git arguments that name the throwaway repository and, where Git is not started in the work tree, the work tree, for helpers that spawn Git themselves. */
  readonly location: readonly string[];
  /** The working directory a helper that spawns Git itself must give it: the held work tree on Linux (see withIsolatedGit), else the scratch directory. */
  readonly workTreeCwd: string;
  env(index?: IndexKind): NodeJS.ProcessEnv;
  /** Everything a caller needs to spawn `git <args>` itself (to stream its output) the way `text` runs it. */
  spawnSpec(args: readonly string[], index?: IndexKind): { args: string[]; env: NodeJS.ProcessEnv; cwd: string };
  text(args: readonly string[], options?: IsolatedRunOptions): Promise<string>;
  bytes(args: readonly string[], options?: IsolatedRunOptions): Promise<Buffer>;
  /** The commit HEAD names, read from the candidate's HEAD and refs files. */
  headCommit(): Promise<string>;
  /** Moves what HEAD names (the branch it points at, or HEAD itself when detached) from `expected` to `next`, under Git's own lock file protocol. */
  advanceHead(expected: string, next: string): Promise<void>;
  /** Copies the objects Git created in the throwaway repository into the candidate's object directory. Idempotent; a `"write"` session also does it when `use` returns. */
  exportObjects(): Promise<void>;
}

/**
 * Runs `use` against a throwaway bare repository this worker created under the temporary directory, then removes it on every path. Git reads the candidate's
 * objects through `objects/info/alternates` and writes the objects it creates (the tree of a snapshot, a commit, a fetched pack) to the throwaway repository's own
 * object directory. `"write"` then copies them into the candidate's object directory, where the candidate repository and later reviews read them, through the
 * worker's own descriptor-relative writes (candidate-fs.ts) rather than through Git, which would follow a symlink the agent put in `objects/`. `"read"` writes
 * nothing to the candidate.
 */
export async function withIsolatedGit<T>(directory: string, mode: "read" | "write", use: (git: IsolatedGit) => Promise<T>): Promise<T> {
  const layout = await candidateLayout(directory);
  const scratch = await mkdtemp(join(tmpdir(), "agentx-candidate-git-"));
  let workTreeHeld: HeldDirectory | undefined;
  try {
    const gitDir = join(scratch, "worker.git");
    const initEnv = isolatedGitEnvironment(layout.workTree);
    await execFile("git", ["init", "--bare", "--quiet", "--template=", gitDir], { cwd: scratch, env: initEnv });
    await mkdir(join(gitDir, "info"), { recursive: true });
    await mkdir(join(gitDir, "objects", "info"), { recursive: true });
    await writeFile(join(gitDir, "objects", "info", "alternates"), `${layout.objects}\n`, { mode: 0o600 });
    // Ignore patterns and attributes are plain text: the files carry no command, and the agent's own exclusions and attributes keep deciding what `add` stages.
    for (const name of ["exclude", "attributes"]) {
      const bytes = await readSmallFile(join(layout.gitDirectory, "info", name), SMALL_FILE_BYTES).catch(() => undefined);
      if (bytes !== undefined) await writeFile(join(gitDir, "info", name), bytes, { mode: 0o600 });
    }
    // On Linux the work tree is held open and Git is started in it, with no `--work-tree` path: `git` then takes its working directory as the work tree. A path
    // swapped for a symlink afterwards cannot redirect what Git reads or writes, because Git's working directory is the directory that was opened, not a path.
    workTreeHeld = workTreeByDescriptor() ? await openDirectory(layout.workTree) : undefined;
    // Git reads `core.bare` from the repository's own config file while it sets itself up (a setting from the environment comes too late), so the throwaway
    // repository, whose config is the worker's, is made non-bare for it to take its working directory as the work tree.
    if (workTreeHeld !== undefined) await execFile("git", [`--git-dir=${gitDir}`, "config", "core.bare", "false"], { cwd: scratch, env: initEnv });
    const config = await candidateConfigValues(layout, scratch, gitDir);
    const temporaryIndex = join(scratch, "index");
    const workIndex = join(scratch, "work-index");
    const realIndex = join(layout.gitDirectory, "index");
    const location = workTreeHeld === undefined ? [`--git-dir=${gitDir}`, `--work-tree=${layout.workTree}`] as const : [`--git-dir=${gitDir}`] as const;
    const workTreeCwd = workTreeHeld?.descriptorPath ?? scratch;
    const indexFiles = { temporary: temporaryIndex, real: realIndex, work: workIndex } as const;
    const env = (index: IndexKind = "temporary"): NodeJS.ProcessEnv => isolatedGitEnvironment(layout.workTree, {
      ...(index === "none" ? {} : { GIT_INDEX_FILE: indexFiles[index] }),
    }, config);
    const run = async (args: readonly string[], options: IsolatedRunOptions, encoding: "utf8" | "buffer") => {
      const child = execFile("git", [...location, ...args],
        { cwd: workTreeHeld?.descriptorPath ?? (options.cwd === "worktree" ? layout.workTree : scratch), env: env(options.index), encoding, maxBuffer: options.maxBuffer ?? SMALL_FILE_BYTES, ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
          ...(options.signal === undefined ? {} : { signal: options.signal }) });
      // A command can exit before its standard input is written (every command but checkout-index ignores it); the pipe's EPIPE must not crash the worker.
      child.child.stdin?.on("error", () => undefined);
      child.child.stdin?.end(options.input);
      return (await child).stdout;
    };
    const exportObjects = () => copyObjectsOut(join(gitDir, "objects"), layout);
    const result = await use({
      layout, scratch, temporaryIndex, workIndex, gitDir, location, workTreeCwd, env, exportObjects,
      spawnSpec: (args, index = "none") => ({ args: [...location, ...args], env: env(index), cwd: workTreeCwd }),
      text: async (args, options = {}) => (await run(args, options, "utf8")) as string,
      bytes: async (args, options = {}) => (await run(args, options, "buffer")) as unknown as Buffer,
      headCommit: () => readHead(layout).then((head) => head.commit),
      advanceHead: (expected, next) => advanceHead(layout, expected, next),
    });
    if (mode === "write") await exportObjects();
    return result;
  } finally {
    await workTreeHeld?.close();
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The tree of `commit` plus the work tree as it is now, computed in `git`'s temporary index (never the candidate's real one): `read-tree`, then `add --all`, then
 * `write-tree`, with the nested-repository refusal (and the Git LFS one, unless `refuseLfs` is false) in between. Git runs in the throwaway repository, so no filter, driver or hook of the candidate's
 * config exists for it to run. A nested repository's own config is out of that protection, so Git is kept away from every tracked gitlink: a gitlink path is
 * excluded from `add` (its entry stays as `commit` has it), because Git asks a checked-out submodule for its status by running Git inside it, under its config,
 * and a nested repository can appear at that path between the check for one and `add`. Needs Git 2.25 or later (`--pathspec-from-file`).
 */
export async function snapshotTree(git: IsolatedGit, commit: string, options: { readonly refuseLfs?: boolean } = {}): Promise<string> {
  await git.text(["read-tree", commit]);
  const gitlinks = await assertNoEmbeddedRepositories(git.layout.workTree, git.env(), git.location, git.workTreeCwd);
  // Capture does not refuse Git LFS files (`refuseLfs: false`), as it never did; publication and the checks before it do.
  if (options.refuseLfs !== false) await assertNoLfsFiles(git.layout.workTree, git.env(), git.location, git.workTreeCwd);
  await addWorkTree(git, "temporary", gitlinks);
  return (await git.text(["write-tree"])).trim();
}

/**
 * `git add --all` of the work tree into the index `index`, keeping Git away from every tracked gitlink in `gitlinks` (see snapshotTree). A gitlink whose path is
 * no longer a directory is refused: its entry would otherwise stay in the tree while the work tree no longer has the submodule.
 */
export async function addWorkTree(git: IsolatedGit, index: IndexKind, gitlinks: readonly string[]): Promise<void> {
  for (const path of gitlinks) {
    const stat = await lstat(join(git.layout.workTree, path)).catch(() => undefined);
    if (stat === undefined || !stat.isDirectory()) {
      throw agentXError("CONFIG_INVALID", `the repository has a submodule at ${path} that is no longer a directory. AgentX tasks do not yet support changes to a project's submodules.`);
    }
  }
  if (gitlinks.length === 0) await git.text(["add", "--all", "--", "."], { index, maxBuffer: 1024 * 1024 });
  else {
    const pathspecs = join(git.scratch, "pathspecs");
    await writeFile(pathspecs, [".", ...gitlinks.map((path) => `:(exclude,literal)${path}`)].map((entry) => `${entry}\0`).join(""), { mode: 0o600 });
    await git.text(["add", "--all", `--pathspec-from-file=${pathspecs}`, "--pathspec-file-nul"], { index, maxBuffer: 1024 * 1024 });
  }
}

/** Git's own rules for a ref name, applied strictly: anything unusual is refused rather than guessed at. */
export function isSafeRefName(name: string): boolean {
  if (!name.startsWith("refs/") || name.length > 255 || name.endsWith("/") || name.endsWith(".") || name.includes("//") || name.includes("..") || name.includes("@{")) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f~^:?*[\\]/u.test(name)) return false;
  return name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

const OBJECT_DIRECTORY = /^[0-9a-f]{2}$/;
const LOOSE_OBJECT = /^[0-9a-f]{38}$/;
const PACK_FILE = /^pack-[0-9a-f]+\.(pack|idx|rev|bitmap|mtimes)$/;

async function copyInto(directory: HeldDirectory, source: string, name: string): Promise<void> {
  if ((await kindIn(directory, name)) !== undefined) return;
  const temporary = `tmp_obj_${randomUUID()}`;
  await candidateWriteStep(`object ${directory.path.split("/").slice(-1)[0]}/${name}`);
  await copyFile(source, directory.entry(temporary), fsConstants.COPYFILE_EXCL);
  await rename(directory.entry(temporary), directory.entry(name));
}

/** Copies the loose objects and packs in `source` (an object directory the worker owns) that the candidate's object directory does not have yet. Packs go in with their index last. */
async function copyObjectsOut(source: string, layout: CandidateLayout): Promise<void> {
  const target = await openDirectory(layout.objects);
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (entry.isDirectory() && OBJECT_DIRECTORY.test(entry.name)) {
        const files = (await readdir(join(source, entry.name))).filter((name) => LOOSE_OBJECT.test(name));
        if (files.length === 0) continue;
        const directory = await target.subdirectory(entry.name, true);
        try { for (const name of files) await copyInto(directory!, join(source, entry.name, name), name); } finally { await directory?.close(); }
      } else if (entry.isDirectory() && entry.name === "pack") {
        const names = (await readdir(join(source, "pack"))).filter((name) => PACK_FILE.test(name));
        if (names.length === 0) continue;
        const directory = await target.subdirectory("pack", true);
        try {
          for (const name of [...names].sort((left, right) => Number(left.endsWith(".idx")) - Number(right.endsWith(".idx")))) await copyInto(directory!, join(source, "pack", name), name);
        } finally { await directory?.close(); }
      }
    }
  } finally {
    await target.close();
  }
}

/** The directory holding the loose ref `ref` (every level opened without following a symlink, made first when `create` is set), held until `close`; `undefined` when it does not exist. */
async function openRefParent(git: HeldDirectory, ref: string, create: boolean): Promise<{ directory: HeldDirectory; leaf: string; close(): Promise<void> } | undefined> {
  const parts = ref.split("/");
  const leaf = parts.pop()!;
  const opened: HeldDirectory[] = [];
  let current = git;
  const close = async () => { for (const directory of opened.reverse()) await directory.close().catch(() => undefined); };
  try {
    for (const part of parts) {
      const next = await current.subdirectory(part, create);
      if (next === undefined) { await close(); return undefined; }
      opened.push(next);
      current = next;
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { directory: current, leaf, close };
}

type Head = { kind: "detached" } | { kind: "branch"; ref: string };

/**
 * The one place HEAD's commit is resolved without Git: the branch HEAD names, as a loose ref file or a line of packed-refs, all read through the held `.git`
 * directory. A symbolic ref chain, an odd name or a symlink on the way is refused. `parent` is the held directory of the branch's loose ref when the caller holds it.
 */
async function readHeadHeld(git: HeldDirectory, parent?: { directory: HeldDirectory; leaf: string }): Promise<Head & { commit: string }> {
  const headBytes = await readFileIn(git, "HEAD", 4096);
  if (headBytes === undefined) throw new Error("candidate repository has no HEAD");
  const headText = headBytes.toString("utf8").replace(/\n$/u, "");
  if (HEX40.test(headText)) return { kind: "detached", commit: headText };
  const symbolic = /^ref: (\S+)$/u.exec(headText);
  if (symbolic?.[1] === undefined || !isSafeRefName(symbolic[1])) throw new Error("candidate HEAD is not a commit or a plain branch reference");
  const ref = symbolic[1];
  const own = parent === undefined ? await openRefParent(git, ref, false) : undefined;
  const where = parent ?? own;
  try {
    if (where !== undefined && (await kindIn(where.directory, where.leaf)) === "file") {
      const text = (await readFileIn(where.directory, where.leaf, 4096))?.toString("utf8").replace(/\n$/u, "") ?? "";
      if (!HEX40.test(text)) throw new Error("candidate branch reference does not name a commit");
      return { kind: "branch", ref, commit: text };
    }
    if (where !== undefined && (await kindIn(where.directory, where.leaf)) === "other") throw new Error("candidate branch reference is not a plain file");
  } finally {
    await own?.close();
  }
  const packed = await readFileIn(git, "packed-refs", PACKED_REFS_CAP_BYTES);
  for (const line of packed?.toString("utf8").split("\n") ?? []) {
    if (line.length === 41 + ref.length && line[40] === " " && line.endsWith(ref) && HEX40.test(line.slice(0, 40))) return { kind: "branch", ref, commit: line.slice(0, 40) };
  }
  throw new Error("candidate branch has no commit");
}

export async function readHead(layout: CandidateLayout): Promise<Head & { commit: string }> {
  const git = await openDirectory(layout.gitDirectory);
  try { return await readHeadHeld(git); } finally { await git.close(); }
}

/**
 * Moves HEAD's commit from `expected` to `next` the way `git update-ref HEAD <next> <expected>` does, minus the reflog (no entry is written): the ref file is
 * created exclusively as `<name>.lock` (another Git holding that lock refuses us, as it would refuse itself), HEAD's own lock is held too when HEAD names a
 * branch, so a concurrent checkout cannot move HEAD underneath, the commit it holds is checked to still be `expected`, and the lock is renamed over the ref.
 * Every directory down to the ref is opened once, without following a symlink, and every operation goes through those descriptors (candidate-fs.ts). No Git
 * process runs in the candidate's repository, so no config or hook of it can.
 */
async function advanceHead(layout: CandidateLayout, expected: string, next: string): Promise<void> {
  if (!HEX40.test(expected) || !HEX40.test(next)) throw new Error("candidate commit is invalid");
  const git = await openDirectory(layout.gitDirectory);
  const held: DirectoryLock[] = [];
  let parent: Awaited<ReturnType<typeof openRefParent>>;
  try {
    const head = await readHeadHeld(git);
    if (head.kind === "branch") parent = await openRefParent(git, head.ref, true);
    const headLock = await lockIn(git, "HEAD");
    held.push(headLock);
    const targetLock = head.kind === "detached" ? headLock : await lockIn(parent!.directory, parent!.leaf);
    if (targetLock !== headLock) held.push(targetLock);
    const locked = await readHeadHeld(git, parent);
    if (locked.commit !== expected || locked.kind !== head.kind || (locked.kind === "branch" && head.kind === "branch" && locked.ref !== head.ref)) {
      throw new Error("candidate HEAD moved while it was being updated");
    }
    await commitLock(targetLock, `${next}\n`);
  } finally {
    for (const lock of held) await releaseLock(lock);
    await parent?.close();
    await git.close();
  }
}

export { openRefParent, readHeadHeld };
