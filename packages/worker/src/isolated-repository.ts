import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { agentXError } from "@agentx/contracts";
import { assertNoEmbeddedRepositories, assertNoLfsFiles, isRefusedForNetwork, isolatedGitEnvironment, networkRefusal } from "./git.js";
import { runGitWithCredential, type GitCredential } from "./git-auth.js";
import {
  HEX40, isSafeRefName, readSmallFile, takeLock, verifyRefDirectories, withIsolatedGit,
  type CandidateLayout, type HeldLock, type IsolatedGit,
} from "./isolated-git.js";

const execFile = promisify(execFileCallback);

// isolated-git.ts runs Git on the candidate's files without letting Git see the candidate's repository. Most worker calls need more than a tree: they read or move
// refs (a fetch writes `refs/remotes/origin/*`, a checkout moves HEAD and a branch) and mirror the work tree into the index. This module gives them a session on the
// same throwaway repository: before the work, the candidate's HEAD and refs are copied into it, and the candidate's real index is copied beside it; the commands
// run verbatim against that copy; after the work, only what changed is applied back to the candidate, one ref at a time under Git's lock protocol (compared with
// the value that was copied, so a concurrent change is refused, never overwritten) and the index through `index.lock`. Git never starts with the candidate's `.git`
// as its git directory, so none of its config, hooks or `info/` files is read, whenever they were written.

const MAX_REFS = 200_000;
const REF_FILE_BYTES = 4096;
const PACKED_REFS_BYTES = 256 * 1024 * 1024;
const INDEX_BYTES = 512 * 1024 * 1024;
const SYMBOLIC_REF = /^ref: (refs\/\S+)$/u;

export type RefState = { head: string; packed: Buffer | undefined; refs: Map<string, string> };

function plainRefValue(name: string, text: string): string {
  const symbolic = SYMBOLIC_REF.exec(text);
  if (HEX40.test(text) || (symbolic?.[1] !== undefined && isSafeRefName(symbolic[1]))) return text;
  throw new Error(`candidate ref ${name} is not a commit or a plain symbolic reference`);
}

async function readLooseRefs(root: string, relative: string, found: Map<string, string>): Promise<void> {
  let entries;
  try { entries = await readdir(join(root, relative), { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const name = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`candidate repository has a symlink at ${name}`);
    if (entry.isDirectory()) { await readLooseRefs(root, name, found); continue; }
    if (!entry.isFile()) throw new Error(`candidate repository has something that is not a file at ${name}`);
    if (entry.name.endsWith(".lock") || !isSafeRefName(name)) continue;
    const bytes = await readSmallFile(join(root, name), REF_FILE_BYTES);
    if (bytes === undefined) continue;
    found.set(name, plainRefValue(name, bytes.toString("utf8").replace(/\n$/u, "")));
    if (found.size > MAX_REFS) throw new Error("candidate repository has too many references");
  }
}

/** HEAD, the packed-refs file and every ref of a git directory, with symlinks and odd entries refused, as plain text values (`<sha>` or `ref: <name>`). */
export async function readRefState(gitDirectory: string): Promise<RefState> {
  const headBytes = await readSmallFile(join(gitDirectory, "HEAD"), REF_FILE_BYTES);
  if (headBytes === undefined) throw new Error("candidate repository has no HEAD");
  const head = headBytes.toString("utf8").replace(/\n$/u, "");
  if (!HEX40.test(head) && !(SYMBOLIC_REF.exec(head)?.[1] !== undefined && isSafeRefName(SYMBOLIC_REF.exec(head)![1]!))) throw new Error("candidate HEAD is not a commit or a plain branch reference");
  const packed = await readSmallFile(join(gitDirectory, "packed-refs"), PACKED_REFS_BYTES);
  const refs = new Map<string, string>();
  for (const line of packed?.toString("utf8").split("\n") ?? []) {
    const match = /^([0-9a-f]{40}) (refs\/\S+)$/u.exec(line);
    if (match?.[2] !== undefined && isSafeRefName(match[2])) refs.set(match[2], match[1]!);
  }
  await readLooseRefs(gitDirectory, "refs", refs);
  return { head, packed, refs };
}

/** Copies the candidate's HEAD and refs into the throwaway repository and returns what was copied, to compare against afterwards. */
async function copyRefsIn(git: IsolatedGit): Promise<RefState> {
  const state = await readRefState(git.layout.gitDirectory);
  await writeFile(join(git.gitDir, "HEAD"), `${state.head}\n`);
  if (state.packed !== undefined) await writeFile(join(git.gitDir, "packed-refs"), state.packed);
  // Loose refs as loose files (a loose ref shadows a packed one, as in the candidate).
  const loose = new Map<string, string>();
  await readLooseRefs(git.layout.gitDirectory, "refs", loose);
  for (const [name, value] of loose) {
    await mkdir(dirname(join(git.gitDir, name)), { recursive: true });
    await writeFile(join(git.gitDir, name), `${value}\n`);
  }
  return state;
}

async function currentValue(layout: CandidateLayout, name: string): Promise<string | undefined> {
  if (!(await verifyRefDirectories(layout, name, false))) return undefined;
  const stat = await lstat(join(layout.gitDirectory, name)).catch(() => undefined);
  if (stat !== undefined && !stat.isDirectory()) {
    const loose = await readSmallFile(join(layout.gitDirectory, name), REF_FILE_BYTES);
    if (loose !== undefined) return plainRefValue(name, loose.toString("utf8").replace(/\n$/u, ""));
  }
  return (await readRefState(layout.gitDirectory)).refs.get(name);
}

/** The text of one ref or of HEAD as the candidate has it now, compared with what the throwaway started from before it is replaced. */
async function applyOne(layout: CandidateLayout, name: string, expected: string | undefined, next: string | undefined): Promise<void> {
  const interrupted = () => agentXError("OPERATION_INTERRUPTED", `the repository's ${name} changed while AgentX was working on it`);
  const isHead = name === "HEAD";
  if (!isHead) await verifyRefDirectories(layout, name, next !== undefined);
  const path = join(layout.gitDirectory, name);
  const lock: HeldLock = await takeLock(`${path}.lock`);
  let renamed = false;
  try {
    const now = isHead
      ? (await readSmallFile(path, REF_FILE_BYTES))?.toString("utf8").replace(/\n$/u, "")
      : await currentValue(layout, name);
    if (now !== expected) throw interrupted();
    if (next === undefined) {
      const loose = await readSmallFile(path, REF_FILE_BYTES).catch(() => undefined);
      if (loose === undefined) throw agentXError("OPERATION_INTERRUPTED", `AgentX cannot remove ${name}: it is kept only in packed-refs`);
      await unlink(path);
      return;
    }
    await lock.handle.writeFile(`${next}\n`);
    await lock.handle.sync();
    await lock.handle.close();
    await rename(lock.path, path);
    renamed = true;
  } finally {
    if (!renamed) {
      await lock.handle.close().catch(() => undefined);
      await unlink(lock.path).catch(() => undefined);
    }
  }
}

/** Applies what the work changed in the throwaway repository's refs and HEAD to the candidate: refs first, then HEAD. */
async function applyRefsBack(git: IsolatedGit, before: RefState): Promise<void> {
  const after = await readRefState(git.gitDir);
  for (const [name, value] of after.refs) {
    if (before.refs.get(name) !== value) await applyOne(git.layout, name, before.refs.get(name), value);
  }
  for (const [name, value] of before.refs) {
    if (!after.refs.has(name)) await applyOne(git.layout, name, value, undefined);
  }
  if (after.head !== before.head) await applyOne(git.layout, "HEAD", before.head, after.head);
}

async function copyIndexIn(git: IsolatedGit): Promise<Buffer | undefined> {
  const real = join(git.layout.gitDirectory, "index");
  const bytes = await readSmallFile(real, INDEX_BYTES);
  if (bytes === undefined) return undefined;
  await writeFile(git.workIndex, bytes, { mode: 0o600 });
  // The copy keeps the real index's modification time: Git decides which entries may be "racily clean" (same size, same second as the index) by comparing each
  // entry's time with the index file's, so a copy stamped now would make a file edited in the second the index was written look unchanged.
  const stamp = await stat(real);
  await utimes(git.workIndex, stamp.atime, stamp.mtime);
  return bytes;
}

/** Replaces the candidate's real index with the worker's copy when the work changed it, through `index.lock`, and only when the real one is still what was copied. */
async function persistIndex(git: IsolatedGit, original: Buffer | undefined): Promise<void> {
  const next = await readFile(git.workIndex).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (next === undefined || (original !== undefined && original.equals(next))) return;
  const real = join(git.layout.gitDirectory, "index");
  const lock = await takeLock(`${real}.lock`);
  let renamed = false;
  try {
    const now = await readSmallFile(real, INDEX_BYTES);
    if ((now === undefined) !== (original === undefined) || (now !== undefined && original !== undefined && !now.equals(original))) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository's index changed while AgentX was working on it");
    }
    await lock.handle.writeFile(next);
    await lock.handle.sync();
    await lock.handle.close();
    // Stamped as the worker's copy is, for the same reason: the entries were checked against that time.
    const stamp = await stat(git.workIndex);
    await utimes(lock.path, stamp.atime, stamp.mtime);
    await rename(lock.path, real);
    renamed = true;
  } finally {
    if (!renamed) {
      await lock.handle.close().catch(() => undefined);
      await unlink(lock.path).catch(() => undefined);
    }
  }
}

export interface RepositoryOptions {
  /** Copy HEAD and the refs in, and apply what the work changed back. */
  refs?: boolean;
  /** Give the work a copy of the real index (`index: "work"`); `"persist"` also installs it afterwards when the work changed it. */
  index?: "work" | "persist";
}

export interface IsolatedRepository extends IsolatedGit {
  /**
   * Refuses, as the worker always has, a repository whose config sets a key that could redirect a network call (`url.*`, `http.*`, `remote.*` other than
   * origin's url and fetch, `extensions.partialClone`). Nothing of the repository's config is used by the call either way; the refusal tells the project to fix it.
   */
  assertNetworkSafe(): Promise<void>;
  /** Runs a credentialed command (fetch, push, ls-remote) in the throwaway repository: the token reaches no process whose config the candidate controls. */
  credentialed(args: readonly string[], credential: GitCredential, options?: { timeout?: number; maxBuffer?: number }): Promise<string>;
  /** `remote.<name>.url` as the candidate's config has it, raw; `undefined` when unset. Read from a private copy of the file, no include followed. */
  remoteUrl(name?: string): Promise<string | undefined>;
}

async function configCopy(git: IsolatedGit): Promise<string | undefined> {
  const bytes = await readSmallFile(join(git.layout.gitDirectory, "config"), 1024 * 1024);
  if (bytes === undefined) return undefined;
  const copy = join(git.scratch, "candidate-config-session");
  await writeFile(copy, bytes, { mode: 0o600 });
  return copy;
}

/**
 * isolated-git.ts's throwaway repository plus, as asked, the candidate's refs and index (see the note at the top of this file). On a failure of `use`, nothing is
 * applied back (files the command already wrote to the work tree stay, as they would after a failed Git command).
 */
export async function withIsolatedRepository<T>(
  directory: string,
  mode: "read" | "write",
  options: RepositoryOptions,
  use: (repository: IsolatedRepository) => Promise<T>,
): Promise<T> {
  return withIsolatedGit(directory, mode, async (git) => {
    const refsBefore = options.refs === true ? await copyRefsIn(git) : undefined;
    const indexBefore = options.index === undefined ? undefined : await copyIndexIn(git);
    const repository: IsolatedRepository = {
      ...git,
      assertNetworkSafe: async () => {
        const copy = await configCopy(git);
        if (copy === undefined) return;
        let keys = "";
        try {
          ({ stdout: keys } = await execFile("git", [`--git-dir=${git.gitDir}`, "config", "--file", copy, "--name-only", "--get-regexp", "^(url|http|remote)\\.|^extensions\\.partialclone$"],
            { cwd: git.scratch, env: isolatedGitEnvironment(git.layout.workTree), encoding: "utf8", maxBuffer: 1024 * 1024 }));
        } catch (error) {
          if ((error as { code?: unknown }).code !== 1) throw error;
        }
        const refused = keys.split("\n").map((line) => line.trim()).filter((key) => key !== "" && isRefusedForNetwork(key));
        if (refused.length > 0) throw networkRefusal(refused);
      },
      credentialed: async (args, credential, runOptions = {}) => (await runGitWithCredential({
        directory: git.gitDir,
        args: [...git.location, ...args],
        credential,
        cwd: git.scratch,
        environment: { ...(mode === "write" ? { GIT_OBJECT_DIRECTORY: git.layout.objects } : {}) },
        ...(runOptions.timeout === undefined ? {} : { timeout: runOptions.timeout }),
        ...(runOptions.maxBuffer === undefined ? {} : { maxBuffer: runOptions.maxBuffer }),
      })).stdout,
      remoteUrl: async (name = "origin") => {
        const copy = await configCopy(git);
        if (copy === undefined) return undefined;
        try {
          return (await execFile("git", [`--git-dir=${git.gitDir}`, "config", "--file", copy, "--get", `remote.${name}.url`],
            { cwd: git.scratch, env: isolatedGitEnvironment(git.layout.workTree), encoding: "utf8" })).stdout.replace(/\n$/u, "");
        } catch (error) {
          if ((error as { code?: unknown }).code === 1) return undefined;
          throw error;
        }
      },
    };
    const result = await use(repository);
    if (refsBefore !== undefined) await applyRefsBack(git, refsBefore);
    if (options.index === "persist") await persistIndex(git, indexBefore);
    return result;
  });
}

/** What a Git command needs of the repository, judged from its subcommand: how it uses the work tree, the index and the object store. */
const WORK_TREE_WRITERS = new Set(["checkout", "reset", "revert", "merge", "add", "read-tree", "checkout-index", "restore", "switch", "cherry-pick", "rm", "mv", "clean", "stash"]);
const READS_INDEX = new Set([...WORK_TREE_WRITERS, "status", "diff", "diff-files", "diff-index", "ls-files", "write-tree", "commit"]);
const READ_ONLY = new Set(["rev-parse", "cat-file", "merge-base", "rev-list", "status", "diff", "ls-tree", "for-each-ref", "branch", "log", "show", "ls-files", "diff-tree"]);

/** The subcommand of `args`, past leading `-c key=value` pairs. */
export function subcommandOf(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-c") { index += 1; continue; }
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

export interface CommandOptions {
  maxBuffer?: number;
  timeout?: number;
  signal?: AbortSignal;
  input?: string | Buffer;
  cwd?: "scratch" | "worktree";
  /** Refs and index handling, when the subcommand's usual one is not what the call needs. */
  refs?: boolean;
  index?: "none" | "work" | "persist";
  mode?: "read" | "write";
}

/**
 * Runs one Git command for the workspace in a throwaway repository (see the note at the top of this file), as `git -C <directory> <args>` was run before: HEAD
 * and the refs are copied in and what the command changed is applied back; the index is copied in for a command that reads it, and installed afterwards when the
 * command writes the work tree. Failures are Git's own (an `execFile` error with its exit code), or an AgentXError when applying the result was refused.
 */
export async function runIsolatedGit(directory: string, args: readonly string[], options: CommandOptions = {}): Promise<string> {
  const subcommand = subcommandOf(args);
  const index = options.index ?? (WORK_TREE_WRITERS.has(subcommand) ? "persist" : READS_INDEX.has(subcommand) ? "work" : "none");
  const mode = options.mode ?? (READ_ONLY.has(subcommand) ? "read" : "write");
  return withIsolatedRepository(directory, mode, { refs: options.refs ?? true, ...(index === "none" ? {} : { index }) }, (repository) =>
    repository.text(args, {
      index: index === "none" ? "none" : "work",
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.input === undefined ? {} : { input: options.input }),
    }));
}

/** Refuses (CONFIG_INVALID) a workspace that has a nested repository checked out or Git LFS files, as the publishing and capturing paths always have. */
export async function assertWorkspaceIsPlain(directory: string): Promise<void> {
  await withIsolatedRepository(directory, "read", { index: "work" }, async (repository) => {
    await assertNoEmbeddedRepositories(repository.layout.workTree, repository.env("work"), repository.location);
    await assertNoLfsFiles(repository.layout.workTree, repository.env("work"), repository.location);
  });
}

/** A directory-less throwaway repository for a network call that needs no candidate at all (ls-remote). */
export async function withScratchRepository<T>(use: (directory: string, environment: Record<string, string>) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), "agentx-scratch-git-"));
  try {
    const gitDir = join(scratch, "scratch.git");
    await execFile("git", ["init", "--bare", "--quiet", "--template=", gitDir], { cwd: scratch, env: isolatedGitEnvironment(scratch) });
    return await use(gitDir, {});
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
