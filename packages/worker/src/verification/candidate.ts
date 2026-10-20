import { resolve } from "node:path";
import { AgentXError, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, agentXError } from "@agentx/contracts";
import { snapshotTree, withIsolatedGit } from "../isolated-git.js";

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
