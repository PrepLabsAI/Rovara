import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentXError, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, agentXError } from "@agentx/contracts";
import { assertNoEmbeddedRepositories, gitHardenedEnvironment } from "../git.js";

const execFile = promisify(execFileCallback);

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
    const temporary = await mkdtemp(join(tmpdir(), "agentx-candidate-index-"));
    const indexPath = join(temporary, "index");
    try {
      // One hardened environment per repository (see git.ts): every call below runs Git in the agent's repository.
      const env = { ...(await gitHardenedEnvironment(directory)), GIT_INDEX_FILE: indexPath };
      const { stdout: commitSha } = await execFile("git", ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"], { env, encoding: "utf8" });
      await execFile("git", ["-C", directory, "read-tree", "HEAD"], { env, encoding: "utf8" });
      await assertNoEmbeddedRepositories(directory, env);
      await execFile("git", ["-C", directory, "add", "--all", "--", "."], { env, encoding: "utf8", maxBuffer: 1024 * 1024 });
      const { stdout: treeSha } = await execFile("git", ["-C", directory, "write-tree"], { env, encoding: "utf8" });
      const commit = commitSha.trim();
      const tree = treeSha.trim();
      if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9]{40}$/.test(tree)) throw new Error("invalid git object identity");
      // Exit status 1: HEAD does not descend from the base (the agent rewrote history past it), which the owner is
      // told in plain words. Any other failure (such as an unknown commit) leaves the candidate unreadable.
      if (input.baseCommitSha !== undefined) {
        await execFile("git", ["-C", directory, "merge-base", "--is-ancestor", input.baseCommitSha, commit], { env, encoding: "utf8" })
          .catch((error: unknown) => {
            if ((error as { code?: unknown }).code === 1) throw agentXError("CONFIG_INVALID", WORKFLOW_HISTORY_REWRITTEN_MESSAGE);
            throw error;
          });
      }
      candidates.push({
        repositoryId: input.repositoryId, commitSha: commit, treeSha: tree,
        ...(input.baseCommitSha === undefined ? {} : { baseCommitSha: input.baseCommitSha }),
      });
    } catch (error) {
      // A refusal (such as a nested repository) says what the project must change; anything else is unreadable.
      if (error instanceof AgentXError) throw error;
      throw new Error(`candidate repository ${input.repositoryId} is not a readable Git worktree`, { cause: error });
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  return candidates;
}
