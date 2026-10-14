import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { AgentXError, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, agentXError, createCandidateManifest, isSafeE2ESourcePath, type CandidateManifest } from "@agentx/contracts";
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
    const env = await gitHardenedEnvironment(directory);
    const commit = (await execFile("git", ["-C", directory, "rev-parse", "--verify", "HEAD^{commit}"], { env, encoding: "utf8" })).stdout.trim();
    const tree = (await execFile("git", ["-C", directory, "rev-parse", "--verify", "HEAD^{tree}"], { env, encoding: "utf8" })).stdout.trim();
    if (commit !== identity.commitSha || tree !== identity.treeSha || (input.baseCommitSha !== undefined && identity.baseCommitSha !== input.baseCommitSha)) {
      throw new Error("committed source does not match the final candidate identity");
    }
    const listing = (await execFile("git", ["-C", directory, "ls-tree", "-rz", "-r", "--full-tree", commit], { env, encoding: "buffer" })).stdout as unknown as Buffer;
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
      const sizeText = (await execFile("git", ["-C", directory, "cat-file", "-s", oid], { env, encoding: "utf8" })).stdout.trim();
      const byteLength = Number(sizeText);
      if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_CANDIDATE_SOURCE_FILE_BYTES) continue;
      totalSourceBytes += byteLength;
      if (totalSourceBytes > MAX_CANDIDATE_SOURCE_BYTES) throw new Error("committed candidate source exceeds the accepted aggregate byte bound");
      const bytes = (await execFile("git", ["-C", directory, "cat-file", "blob", oid], { env, encoding: "buffer", maxBuffer: MAX_CANDIDATE_SOURCE_FILE_BYTES + 1 })).stdout as unknown as Buffer;
      if (bytes.byteLength !== byteLength) throw new Error("committed Git blob size changed while reading");
      sources.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), bytesBase64: bytes.toString("base64"), kind: "blob" });
    }
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
    const directory = resolve(input.directory);
    const env = await gitHardenedEnvironment(directory);
    const { stdout } = await execFile("git", ["-C", directory, "rev-parse", "--verify", `${candidate.baseCommitSha}^{tree}`], { env, encoding: "utf8" });
    if (stdout.trim() !== candidate.treeSha) return false;
    compared += 1;
  }
  return compared > 0;
}
