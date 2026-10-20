// Spec 051 D-16 (#290): AgentX measures an agent command's before result itself, on the code as it was before the task,
// so the regression rule no longer depends on the agent testing before it edits. For the length of the before runs, each
// repository's files are put back to its starting commit, then the agent's files are restored and checked to be exact.
//
// Only Git's object store and a private ref are written: the repository's own index, HEAD, branches and stash are never
// touched, and ignored files (built extensions, node_modules, virtual environments) stay as they are, so the before runs
// use the same environment as the agent's. The agent's files are kept under ORIGINAL_CODE_REF until they are restored,
// so a worker that stops mid-way loses nothing: recoverAgentFiles puts them back before the next task.
import { rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertNoEmbeddedRepositories } from "../git.js";
import { addWorkTree } from "../isolated-git.js";
import { runIsolatedGit, withIsolatedRepository } from "../isolated-repository.js";

const MAX_GIT_OUTPUT_BYTES = 268_435_456;
const GIT_TIMEOUT_MS = 10 * 60_000;
/** Holds the agent's files (a tree) while a repository shows its original code. Never a branch, so `git branch` stays quiet. */
export const ORIGINAL_CODE_REF = "refs/agentx/agent-files";
/** A gitlink (a submodule's commit): never written or deleted here. */
const GITLINK_MODE = "160000";

export interface OriginalCodeRepository {
  /** The repository's directory on the worker. */
  directory: string;
  /** The commit the task started from: the preparation commit, or an eval's base commit. */
  commit: string;
}

export interface OriginalCode {
  /** Shows every repository's original code, runs `work`, and restores the agent's files exactly, even when `work` fails. */
  run<T>(work: () => Promise<T>): Promise<T>;
}

/** The agent's files could not be restored exactly. They are kept under ORIGINAL_CODE_REF; the task must not go on. */
export class AgentFilesRestoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentFilesRestoreError";
  }
}

export function gitOriginalCode(repositories: readonly OriginalCodeRepository[]): OriginalCode {
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      const swapped: { directory: string; agentTree: string }[] = [];
      let result: { value: T } | undefined;
      let workError: unknown;
      try {
        for (const repository of repositories) {
          const directory = await git(repository.directory, ["rev-parse", "--show-toplevel"]);
          const agentTree = await workingTree(directory);
          const originalTree = await git(directory, ["rev-parse", "--verify", `${repository.commit}^{tree}`]);
          if (agentTree === originalTree) continue;
          // The agent's files are safe in the object store before any of them is changed.
          await git(directory, ["update-ref", ORIGINAL_CODE_REF, agentTree]);
          swapped.push({ directory, agentTree });
          await writeTree(directory, agentTree, originalTree);
        }
        result = { value: await work() };
      } catch (error) {
        workError = error;
      }
      // Restore in reverse order; every repository is tried even when one fails.
      const failures: string[] = [];
      for (const { directory, agentTree } of swapped.reverse()) {
        try {
          await restore(directory, agentTree);
        } catch (error) {
          failures.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (failures.length > 0) {
        throw new AgentFilesRestoreError(`AgentX could not restore the agent's files after running the original code; they are kept under ${ORIGINAL_CODE_REF}. ${failures.join("; ")}`);
      }
      if (result === undefined) throw workError;
      return result.value;
    },
  };
}

/**
 * Puts back the agent's files a stopped worker left under ORIGINAL_CODE_REF, before a task starts. Returns the
 * directories it restored. A repository without the ref is left alone.
 */
export async function recoverAgentFiles(directories: readonly string[]): Promise<string[]> {
  const recovered: string[] = [];
  for (const repositoryDirectory of directories) {
    let directory: string;
    let agentTree: string;
    try {
      directory = await git(repositoryDirectory, ["rev-parse", "--show-toplevel"]);
      agentTree = await git(directory, ["rev-parse", "--verify", "--quiet", ORIGINAL_CODE_REF]);
    } catch {
      continue;
    }
    if (agentTree === "") continue;
    await restore(directory, agentTree);
    recovered.push(directory);
  }
  return recovered;
}

/** Makes the working tree equal `agentTree`, checks it, and only then drops the ref that keeps it. */
async function restore(directory: string, agentTree: string): Promise<void> {
  await writeTree(directory, await workingTree(directory), agentTree);
  const now = await workingTree(directory);
  if (now !== agentTree) throw new Error(`the files differ from the agent's after restoring (${now} is not ${agentTree})`);
  await git(directory, ["update-ref", "-d", ORIGINAL_CODE_REF]);
}

/**
 * The tree of the working tree as it is: tracked files as they are now, and untracked files that are not ignored.
 * Built in a copy of the index, so the repository's own index is never changed and unchanged files are not rehashed.
 */
async function workingTree(directory: string): Promise<string> {
  // In a throwaway repository that never reads the workspace repository's config (isolated-repository.ts), on a copy of the repository's index.
  return withIsolatedRepository(directory, "write", { index: "work" }, async (repository) => {
    const gitlinks = await assertNoEmbeddedRepositories(repository.layout.workTree, repository.env("work"), repository.location, repository.workTreeCwd);
    await addWorkTree(repository, "work", gitlinks);
    return (await repository.text(["write-tree"], { index: "work", maxBuffer: MAX_GIT_OUTPUT_BYTES })).trim();
  });
}

/**
 * Changes the working tree from `from` to `to`, touching only the paths that differ: files only in `from` are deleted
 * (with any directory left empty), and files in `to` that are new or changed are written from Git's object store.
 * `directory` is the repository's top level, which the paths in both trees are relative to.
 */
async function writeTree(directory: string, from: string, to: string): Promise<void> {
  const raw = await git(directory, ["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to], {}, false);
  const remove: string[] = [];
  const write: string[] = [];
  const fields = raw.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]!;
    const path = fields[index + 1]!;
    const [fromMode, toMode, , , status] = header.replace(/^:/, "").split(" ");
    if (fromMode === GITLINK_MODE || toMode === GITLINK_MODE || path === "") continue;
    if (status === "D") remove.push(path);
    else write.push(path);
  }
  for (const path of remove) await removeFile(directory, path);
  if (write.length === 0) return;
  // The files are written from Git's object store with no filter of the repository's: none is defined in the throwaway repository.
  await withIsolatedRepository(directory, "read", {}, async (repository) => {
    await repository.text(["read-tree", to], { index: "temporary", maxBuffer: MAX_GIT_OUTPUT_BYTES });
    await repository.text(["checkout-index", "--force", "-z", "--stdin"], { index: "temporary", maxBuffer: MAX_GIT_OUTPUT_BYTES, input: `${write.join("\0")}\0` });
  });
}

async function removeFile(root: string, path: string): Promise<void> {
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return;
  await unlink(target).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  // Directories the file leaves empty go too, up to the repository root; a directory with anything left stays.
  for (let parent = dirname(target); parent !== root && parent.startsWith(`${root}${sep}`); parent = dirname(parent)) {
    try {
      await rmdir(parent);
    } catch {
      break;
    }
  }
}

/**
 * Runs one Git command for the repository `directory` names, in a throwaway repository that never reads the repository's own config, hooks or attributes files
 * (isolated-repository.ts), starting in the work tree. `env` is ignored: the throwaway repository's environment is the worker's own. Exported for tests.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function git(directory: string, args: string[], _env: Record<string, string> = {}, trim = true, input?: string): Promise<string> {
  const stdout = await runIsolatedGit(directory, args, { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT_BYTES, cwd: "worktree", ...(input === undefined ? {} : { input }) });
  return trim ? stdout.trim() : stdout;
}
