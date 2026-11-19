// The BROKER builds the spec commit. Nothing about it comes from the builder's workspace and no worker holds a push credential to the meta repository: the broker creates the blobs, the tree
// (on the base commit's own tree), the commit (one parent: the pinned base) and the branch through the code host's git data calls (`SpecGitClient`), then asks the host what the commit changed and refuses anything but exactly the spec's files,
// each added, each with the blob hash the broker computed from its own content. Only then is the pull request opened, and its head is checked to be that commit.
import { createHash } from "node:crypto";
import { AgentXError, SPEC_FILES_MAX, SPEC_FILE_MAX_BYTES, specFileNameProblem, specFolderProblem, specPathProblem, type SpecFile } from "@agentx/contracts";

export const SPEC_TOTAL_MAX_BYTES = 256 * 1024;

/** What the broker needs of a code host's git data calls, for one repository, with a credential that is the broker's alone. The GitHub adapter is `plugins/code-host/github/spec-git-client.ts`. */
export interface SpecGitClient {
  /** The tree of a commit. */
  getCommit(sha: string): Promise<{ tree: string; parents: string[] }>;
  /** Whether `commit` is on `branch` (the branch is at it or ahead of it). False when the branch was moved on without it. */
  branchContains(commit: string, branch: string): Promise<boolean>;
  /** The commit a branch points at, or undefined when there is no such branch. */
  getBranch(branch: string): Promise<string | undefined>;
  createBlob(content: string): Promise<string>;
  createTree(baseTree: string, entries: ReadonlyArray<{ path: string; sha: string }>): Promise<string>;
  createCommit(input: { message: string; tree: string; parent: string }): Promise<string>;
  createBranch(branch: string, sha: string): Promise<void>;
  deleteBranch(branch: string): Promise<void>;
  /** What `head` changes against `base`: the changed files (name, status, blob hash) and how many commits there are. `complete` is false when GitHub cut the list. */
  compare(base: string, head: string): Promise<{ complete: boolean; commits: number; files: Array<{ path: string; status: string; sha: string }> }>;
}

export interface SpecPullRequestOpener {
  /** `reconciled`: an open pull request for the branch was found, not made now. */
  open(input: { headBranch: string; baseBranch: string; title: string; body: string }): Promise<{ number: number; url: string; reconciled: boolean }>;
  read(number: number): Promise<{ head: string; title: string; body: string }>;
  close(number: number): Promise<void>;
}

/** A code host's answer that is a refusal or a fault, with the HTTP status the host gave. An adapter throws it (or a class that extends it); `classifyPublishError` reads the status. */
export class SpecHostError extends Error {
  constructor(readonly status: number, message = `the code host answered ${String(status)}`) { super(message); this.name = "SpecHostError"; }
}

export type SpecPublishFailure = "paths" | "github" | "verification" | "base" | "setup";

export class SpecPublishError extends Error {
  constructor(readonly reason: SpecPublishFailure, readonly transient: boolean) {
    super(`spec publication refused: ${reason}`);
    this.name = "SpecPublishError";
  }
}

/** Whether a failure may pass by itself: GitHub 5xx, 429 and 408, a network error or a timeout, a server-side RUNTIME_UNAVAILABLE. A 4xx, a missing credential or repository, or a refusal is permanent. */
export function classifyPublishError(error: unknown): boolean {
  if (error instanceof SpecPublishError) return error.transient;
  if (error instanceof SpecHostError) return error.status >= 500 || error.status === 429 || error.status === 408;
  if (error instanceof AgentXError) {
    // The connection's pull request step says what GitHub answered ("... failed with HTTP 422"): a 4xx is a refusal, not an outage.
    const status = /\bHTTP (\d{3})\b/u.exec(error.message);
    if (status !== null) return classifyPublishError(new SpecHostError(Number(status[1])));
    return error.code === "RUNTIME_UNAVAILABLE";
  }
  if (error instanceof TypeError || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) return true;
  // Anything else (a credential that is not an installation token, a repository that is not on GitHub) is the project's to fix.
  return false;
}

/** The Git blob hash of a text, as `git hash-object` gives it. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${String(bytes.byteLength)}\0`).update(bytes).digest("hex");
}

/**
 * The paths a spec publication may write: inside `folder`, new files only (checked again against GitHub below), not in a rules, steering, skills, config or automation folder, no rules/steering/ownership file names,
 * no duplicates (any case), bounded in number and size. Throws SpecPublishError("paths").
 */
export function assertSpecPaths(files: readonly SpecFile[], folder: string, forbiddenFolders: readonly string[]): void {
  const refuse = (): never => { throw new SpecPublishError("paths", false); };
  if (files.length === 0 || files.length > SPEC_FILES_MAX) refuse();
  const prefix = `${folder.replace(/\/+$/u, "")}/`;
  if (specPathProblem(folder) !== undefined || specFolderProblem(folder, forbiddenFolders) !== undefined) refuse();
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (specPathProblem(file.path) !== undefined || !file.path.startsWith(prefix) || specFileNameProblem(file.path) !== undefined || specFolderProblem(file.path.split("/").slice(0, -1).join("/"), forbiddenFolders) !== undefined
      || seen.has(file.path.toLowerCase()) || bytes > SPEC_FILE_MAX_BYTES) refuse();
    seen.add(file.path.toLowerCase());
  }
  if (total > SPEC_TOTAL_MAX_BYTES) refuse();
}

/** Checks that `head` is one commit on `base` that adds exactly `files`, each with its own hash. Throws SpecPublishError("verification"). */
async function verifyCommit(git: SpecGitClient, base: string, head: string, files: readonly SpecFile[]): Promise<void> {
  const refuse = (): never => { throw new SpecPublishError("verification", false); };
  const commit = await git.getCommit(head);
  if (commit.parents.length !== 1 || commit.parents[0] !== base) refuse();
  const changed = await git.compare(base, head);
  if (!changed.complete || changed.commits !== 1 || changed.files.length !== files.length) refuse();
  const expected = new Map(files.map((file) => [file.path, gitBlobSha(file.content)]));
  for (const file of changed.files) {
    if (file.status !== "added" || expected.get(file.path) !== file.sha) refuse();
    expected.delete(file.path);
  }
  if (expected.size !== 0) refuse();
}

/**
 * Publishes a spec: builds the commit through GitHub, verifies it, opens the pull request, checks its head. A branch that already exists (a cut-short earlier try) is verified and reused, never trusted. On a
 * verification failure the branch is deleted and no pull request is opened. GitHub errors are `transient`.
 */
export async function publishSpec(
  deps: { git: SpecGitClient; pullRequests: SpecPullRequestOpener },
  input: { files: readonly SpecFile[]; folder: string; baseCommit: string; baseBranch: string; branch: string; title: string; body: string; forbiddenFolders: readonly string[] },
): Promise<{ commit: string; number: number; url: string }> {
  assertSpecPaths(input.files, input.folder, input.forbiddenFolders);
  if (!/^[a-f0-9]{40}$/u.test(input.baseCommit) || !/^agentx\/[0-9a-f-]{36}$/u.test(input.branch)) throw new SpecPublishError("paths", false);
  let head: string | undefined;
  try {
    // The commit the spec is built on must still be on the default branch: if the branch was rewritten, the pull request would carry the old history back.
    if (!(await deps.git.branchContains(input.baseCommit, input.baseBranch))) throw new SpecPublishError("base", false);
    head = await deps.git.getBranch(input.branch);
    if (head === undefined) {
      const base = await deps.git.getCommit(input.baseCommit);
      const entries: Array<{ path: string; sha: string }> = [];
      for (const file of input.files) {
        const sha = await deps.git.createBlob(file.content);
        if (sha !== gitBlobSha(file.content)) throw new SpecPublishError("verification", false);
        entries.push({ path: file.path, sha });
      }
      const tree = await deps.git.createTree(base.tree, entries);
      head = await deps.git.createCommit({ message: input.title.replace(/[\r\n]+/gu, " ").slice(0, 200), tree, parent: input.baseCommit });
      await deps.git.createBranch(input.branch, head);
    }
    await verifyCommit(deps.git, input.baseCommit, head, input.files);
  } catch (error) {
    if (error instanceof SpecPublishError) {
      if (error.reason === "verification" && head !== undefined) await deps.git.deleteBranch(input.branch).catch(() => undefined);
      throw error;
    }
    throw new SpecPublishError("github", classifyPublishError(error));
  }
  try {
    const opened = await deps.pullRequests.open({ headBranch: input.branch, baseBranch: input.baseBranch, title: input.title, body: input.body });
    const seen = await deps.pullRequests.read(opened.number);
    const normal = (text: string): string => text.replace(/\r\n?/gu, "\n").trimEnd();
    // A pull request found again (not made now) is adopted only when it is Rovara's own: title and body exactly what Rovara sends. Someone else's is never adopted and never closed.
    if (opened.reconciled && (seen.title !== input.title || normal(seen.body) !== normal(input.body))) throw new SpecPublishError("verification", false);
    if (seen.head !== head) {
      await deps.pullRequests.close(opened.number).catch(() => undefined);
      throw new SpecPublishError("verification", false);
    }
    return { commit: head, number: opened.number, url: opened.url };
  } catch (error) {
    if (error instanceof SpecPublishError) throw error;
    throw new SpecPublishError("github", classifyPublishError(error));
  }
}

