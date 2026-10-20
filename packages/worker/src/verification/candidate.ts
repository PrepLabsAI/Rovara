import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentXError, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, agentXError, createCandidateManifest, isSafeE2ESourcePath, type CandidateManifest } from "@agentx/contracts";
import { commitLock, lockIn, openDirectory, readFileIn, releaseLock, type DirectoryLock, type HeldDirectory } from "../candidate-fs.js";
import { snapshotTree, withIsolatedGit, type IsolatedGit } from "../isolated-git.js";

const INDEX_BYTES = 512 * 1024 * 1024;

export interface CandidateRepositoryInput {
  repositoryId: string;
  directory: string;
  /** The commit the task started from; it must be an ancestor of HEAD. */
  baseCommitSha?: string;
}

export interface CandidateRepositoryIdentity {
  repositoryId: string;
  commitSha: string;
  treeSha: string;
  baseCommitSha?: string;
}

/** A first-party export of committed Git objects. It is sent through the private candidate-export
 * callback, separately from the model-visible terminal result. */
export interface CommittedCandidateSourceExport {
  schemaVersion: "workflow-candidate-source/v1";
  candidate: CandidateManifest;
  repositories: Array<{
    repositoryId: string;
    commitSha: string;
    treeSha: string;
    baseCommitSha?: string;
    treeComplete: true;
    treePaths: string[];
    sources: Array<{ path: string; sha256: string; bytesBase64: string; kind: "blob" }>;
  }>;
}

const MAX_CANDIDATE_SOURCE_COUNT = 512;
const MAX_CANDIDATE_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATE_SOURCE_FILE_BYTES = 512 * 1024;

/**
 * Reads source from the exact committed HEAD objects. A temporary-index tree is deliberately not
 * accepted here: callers must first commit the final candidate and then bind this export to the
 * independently captured candidate identities.
 */
export async function readCommittedCandidateSourceExport(
  inputs: readonly CandidateRepositoryInput[],
  identities: readonly CandidateRepositoryIdentity[],
): Promise<CommittedCandidateSourceExport> {
  if (inputs.length === 0 || inputs.length !== identities.length || inputs.length > 32) {
    throw new Error("committed candidate source inputs are incomplete");
  }
  const repositories: CommittedCandidateSourceExport["repositories"] = [];
  let totalSourceBytes = 0;
  for (const input of [...inputs].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))) {
    const identity = identities.find((entry) => entry.repositoryId === input.repositoryId);
    if (!identity || !/^[a-f0-9]{40}$/.test(identity.commitSha) || !/^[a-f0-9]{40}$/.test(identity.treeSha)) {
      throw new Error("committed candidate source identity is invalid");
    }
    const directory = resolve(input.directory);
    // Git runs in a worker-owned throwaway repository that borrows only the candidate's objects (see isolated-git.ts), with no replace objects.
    const { treePaths, sources } = await withIsolatedGit(directory, "read", async (git) => {
      const commit = (await git.text(["rev-parse", "--verify", `${await git.headCommit()}^{commit}`], { index: "none" })).trim();
      const tree = (await git.text(["rev-parse", "--verify", `${commit}^{tree}`], { index: "none" })).trim();
      if (commit !== identity.commitSha || tree !== identity.treeSha || (input.baseCommitSha !== undefined && identity.baseCommitSha !== input.baseCommitSha)) {
        throw new Error("committed source does not match the final candidate identity");
      }
      const listing = await git.bytes(["ls-tree", "-rz", "-r", "--full-tree", commit], { index: "none" });
      const treePaths: string[] = [];
      const sources: CommittedCandidateSourceExport["repositories"][number]["sources"] = [];
      for (const record of listing.toString("binary").split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        if (tab < 0) throw new Error("committed Git tree entry is malformed");
        const metadata = record.slice(0, tab).split(" ");
        const pathBytes = Buffer.from(record.slice(tab + 1), "binary");
        const path = pathBytes.toString("utf8");
        if (!Buffer.from(path, "utf8").equals(pathBytes) || path.length === 0 || path.length > 1024 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
          throw new Error("committed Git tree path is not safely representable");
        }
        treePaths.push(path);
        // The complete tree inventory retains excluded paths, while only runner-safe regular blobs
        // are materialized. In particular, never promote credential-like paths into callback bytes.
        if (metadata[1] !== "blob" || (metadata[0] !== "100644" && metadata[0] !== "100755") || !isSafeE2ESourcePath(path)) continue;
        if (sources.length >= MAX_CANDIDATE_SOURCE_COUNT) throw new Error("committed candidate has too many source blobs for the accepted snapshot bound");
        const oid = metadata[2];
        if (!oid || !/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("committed Git blob identity is malformed");
        const sizeText = (await git.text(["cat-file", "-s", oid], { index: "none" })).trim();
        const byteLength = Number(sizeText);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_CANDIDATE_SOURCE_FILE_BYTES) continue;
        totalSourceBytes += byteLength;
        if (totalSourceBytes > MAX_CANDIDATE_SOURCE_BYTES) throw new Error("committed candidate source exceeds the accepted aggregate byte bound");
        const bytes = await git.bytes(["cat-file", "blob", oid], { index: "none", maxBuffer: MAX_CANDIDATE_SOURCE_FILE_BYTES + 1 });
        if (bytes.byteLength !== byteLength) throw new Error("committed Git blob size changed while reading");
        sources.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64"), kind: "blob" });
      }
      return { treePaths, sources };
    });
    if (new Set(treePaths).size !== treePaths.length) throw new Error("committed Git tree contains duplicate paths");
    repositories.push({ repositoryId: input.repositoryId, commitSha: identity.commitSha, treeSha: identity.treeSha,
      ...(identity.baseCommitSha === undefined ? {} : { baseCommitSha: identity.baseCommitSha }), treeComplete: true, treePaths, sources });
  }
  const candidate = createCandidateManifest(identities);
  return { schemaVersion: "workflow-candidate-source/v1", candidate, repositories };
}

/**
 * Captures the Git candidate without touching the worktree's real index. A temporary index starts
 * from HEAD, then stages the current tracked and untracked files solely to compute a tree object.
 * Git never runs in the candidate repository itself (see isolated-git.ts); the tree and its blobs are written to the candidate's object
 * directory, where the review diff reads them.
 */
export async function readCandidateRepositories(
  inputs: readonly CandidateRepositoryInput[],
): Promise<CandidateRepositoryIdentity[]> {
  if (inputs.length === 0 || inputs.length > 32 || new Set(inputs.map((entry) => entry.repositoryId)).size !== inputs.length) {
    throw new Error("candidate repository identities are invalid");
  }
  const candidates: CandidateRepositoryIdentity[] = [];
  for (const input of [...inputs].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(input.repositoryId)
      || (input.baseCommitSha !== undefined && !/^[a-f0-9]{40}$/.test(input.baseCommitSha))) throw new Error("candidate repository identities are invalid");
    const directory = resolve(input.directory);
    try {
      const identity = await withIsolatedGit(directory, "write", async (git) => {
        const commit = (await git.text(["rev-parse", "--verify", `${await git.headCommit()}^{commit}`], { index: "none" })).trim();
        const tree = await snapshotTree(git, commit);
        if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error("invalid git object identity");
        // Exit status 1: HEAD does not descend from the base (the agent rewrote history past it), which the owner is
        // told in plain words. Any other failure (such as an unknown commit) leaves the candidate unreadable.
        if (input.baseCommitSha !== undefined) {
          await git.text(["merge-base", "--is-ancestor", input.baseCommitSha, commit], { index: "none" })
            .catch((error: unknown) => {
              if ((error as { code?: unknown }).code === 1) throw agentXError("CONFIG_INVALID", WORKFLOW_HISTORY_REWRITTEN_MESSAGE);
              throw error;
            });
        }
        return { commit, tree };
      });
      candidates.push({
        repositoryId: input.repositoryId, commitSha: identity.commit, treeSha: identity.tree,
        ...(input.baseCommitSha === undefined ? {} : { baseCommitSha: input.baseCommitSha }),
      });
    } catch (error) {
      // A refusal (such as a nested repository) says what the project must change; anything else is unreadable.
      if (error instanceof AgentXError) throw error;
      throw new Error(`candidate repository ${input.repositoryId} is not a readable Git worktree`, { cause: error });
    }
  }
  return candidates;
}

/**
 * Persists the current IMPLEMENT worktree as a local commit and synchronizes Git's real index to it.
 * To preserve user staging, the existing index must be either the old HEAD tree or the full candidate
 * tree; divergent/partially staged content is rejected before mutation. The commit is parented to the
 * current HEAD so prior model commits remain in history. This is local only: no checkout, push, or hooks.
 *
 * No Git process runs in the candidate repository (see isolated-git.ts). Git builds the tree and the commit in a throwaway repository whose object directory is
 * the candidate's, so both objects land where the candidate repository reads them, and the only writes to the candidate's own files are HEAD (a lock file
 * renamed over it, as Git does it) and the real index, which this function already replaced by the same lock-and-rename.
 */
export async function commitCandidateWorktree(
  inputs: readonly CandidateRepositoryInput[],
): Promise<CandidateRepositoryIdentity[]> {
  if (inputs.length === 0 || inputs.length > 32 || new Set(inputs.map((entry) => entry.repositoryId)).size !== inputs.length) {
    throw new Error("candidate repository identities are invalid");
  }
  const committed: CandidateRepositoryIdentity[] = [];
  for (const input of [...inputs].sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(input.repositoryId)
      || (input.baseCommitSha !== undefined && !/^[a-f0-9]{40}$/.test(input.baseCommitSha))) throw new Error("candidate repository identities are invalid");
    try {
      committed.push(await withIsolatedGit(resolve(input.directory), "write", (git) => commitRepository(git, input)));
    } catch (error) {
      if (error instanceof AgentXError) throw error;
      throw new Error(`candidate repository ${input.repositoryId} could not be safely committed`, { cause: error });
    }
  }
  return committed;
}

async function commitRepository(git: IsolatedGit, input: CandidateRepositoryInput): Promise<CandidateRepositoryIdentity> {
  // `.git` is opened once without following a symlink, and the real index and its lock are read and written through that descriptor (candidate-fs.ts).
  const gitDirectory = await openDirectory(git.layout.gitDirectory);
  try { return await commitRepositoryIn(git, gitDirectory, input); } finally { await gitDirectory.close(); }
}

async function commitRepositoryIn(git: IsolatedGit, gitDirectory: HeldDirectory, input: CandidateRepositoryInput): Promise<CandidateRepositoryIdentity> {
  const identityOf = (commitSha: string, treeSha: string): CandidateRepositoryIdentity => ({ repositoryId: input.repositoryId, commitSha, treeSha,
    ...(input.baseCommitSha === undefined ? {} : { baseCommitSha: input.baseCommitSha }) });
  const run = async (args: readonly string[], index: "temporary" | "real" | "none" = "temporary"): Promise<string> =>
    (await git.text(args, { index, maxBuffer: 1024 * 1024 })).trim();
  const commitOf = async (): Promise<string> => run(["rev-parse", "--verify", `${await git.headCommit()}^{commit}`], "none");
  const oldHead = await commitOf();
  if (!/^[a-f0-9]{40}$/.test(oldHead)) throw new Error("candidate HEAD is invalid");
  if (input.baseCommitSha !== undefined) {
    await run(["merge-base", "--is-ancestor", input.baseCommitSha, oldHead], "none").catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 1) throw agentXError("CONFIG_INVALID", WORKFLOW_HISTORY_REWRITTEN_MESSAGE);
      throw error;
    });
  }
  const tree = await snapshotTree(git, oldHead);
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new Error("candidate tree is invalid");
  const oldTree = await run(["rev-parse", `${oldHead}^{tree}`], "none");
  const unmerged = await run(["ls-files", "--unmerged", "-z"], "real");
  if (unmerged !== "") throw agentXError("CONFIG_INVALID", "the repository index has unresolved entries; resolve them before the implementation can be saved");
  const indexBefore = await readFileIn(gitDirectory, "index", INDEX_BYTES);
  const indexMatches = async (revision: string): Promise<boolean> => {
    try {
      await run(["diff", "--cached", "--quiet", revision], "real");
      return true;
    } catch (error) {
      if ((error as { code?: unknown }).code === 1) return false;
      throw error;
    }
  };
  if (!(await indexMatches(oldHead)) && !(await indexMatches(tree))) {
    throw agentXError("CONFIG_INVALID", "the staged files differ from the implementation snapshot; preserve or resolve those staged changes before continuing");
  }
  if (tree === oldTree) return identityOf(oldHead, oldTree);
  const commit = await run([
    "-c", "user.name=AgentX", "-c", "user.email=agentx@localhost",
    "commit-tree", tree, "-p", oldHead, "-m", "AgentX IMPLEMENT candidate snapshot",
  ], "none");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("candidate commit is invalid");

  const candidateIndex = await readFile(git.temporaryIndex);
  let refAdvanced = false;
  let lock: DirectoryLock | undefined;
  try {
    // Git's normal index.lock protocol prevents a concurrent index writer from being overwritten.
    lock = await lockIn(gitDirectory, "index");

    // Refuse a changed worktree or real index before advancing the worker-owned HEAD.
    const currentHead = await git.headCommit();
    const currentIndex = await readFileIn(gitDirectory, "index", INDEX_BYTES);
    if (currentHead !== oldHead || !sameOptionalBytes(indexBefore, currentIndex)) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository changed while AgentX was saving the implementation candidate");
    }
    if (await snapshotTree(git, oldHead) !== tree) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository files changed while AgentX was saving the implementation candidate");
    }
    // The commit and trees are in the candidate's object directory before HEAD names the commit.
    await git.exportObjects();
    await git.advanceHead(oldHead, commit);
    refAdvanced = true;
    // The index carries the modification time of the worker's temporary one: Git judges which entries may be "racily clean" by comparing them with it.
    const stamp = await stat(git.temporaryIndex);
    await commitLock(lock, candidateIndex, { atime: stamp.atime, mtime: stamp.mtime });

    const newHead = await commitOf();
    const newTree = await run(["rev-parse", "--verify", `${newHead}^{tree}`], "none");
    const indexAfter = await readFileIn(gitDirectory, "index", INDEX_BYTES);
    if (!sameOptionalBytes(candidateIndex, indexAfter)) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository index changed while AgentX was saving the implementation candidate");
    }
    const worktreeTreeAfter = await snapshotTree(git, newHead);
    if (newHead !== commit || newTree !== tree) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository reference changed while AgentX was verifying its implementation snapshot");
    }
    if (!sameOptionalBytes(candidateIndex, indexAfter)) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository index changed while AgentX was verifying its implementation snapshot");
    }
    if (worktreeTreeAfter !== tree) {
      throw agentXError("OPERATION_INTERRUPTED", "the repository changed while AgentX was verifying its implementation snapshot");
    }
    return identityOf(newHead, newTree);
  } catch (error) {
    if (lock !== undefined) await releaseLock(lock);
    if (refAdvanced && error instanceof Error && !(error instanceof AgentXError)) {
      throw agentXError("OPERATION_INTERRUPTED", "the candidate commit was saved but its index could not be synchronized; the workspace must be checked before retrying");
    }
    throw error;
  }
}

function sameOptionalBytes(left: Buffer | undefined, right: Buffer | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined && left.equals(right);
}

/**
 * Whether the candidate is still the code the task started from: every repository has a recorded base and holds its base
 * commit's tree. Such a change has nothing to check, review or publish. A repository with no recorded base can't be shown
 * unchanged, so the candidate is not refused for it.
 */
export async function candidateUnchangedSinceBase(
  inputs: readonly CandidateRepositoryInput[],
  candidates: readonly CandidateRepositoryIdentity[],
): Promise<boolean> {
  let compared = 0;
  for (const candidate of candidates) {
    const input = inputs.find((entry) => entry.repositoryId === candidate.repositoryId);
    if (candidate.baseCommitSha === undefined) return false;
    if (input === undefined) continue;
    const baseCommitSha = candidate.baseCommitSha;
    const baseTree = await withIsolatedGit(resolve(input.directory), "read", async (git) => (await git.text(["rev-parse", "--verify", `${baseCommitSha}^{tree}`], { index: "none" })).trim());
    if (baseTree !== candidate.treeSha) return false;
    compared += 1;
  }
  return compared > 0;
}
