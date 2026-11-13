// Lessons in the repo (R2; adapted from the lessons-repo-publish lane 6 source, which is never merged): the GitHub side of `CodeHost.commitFiles` and `deleteBranch`, kept out of github-app.ts. The caller (the provider) has already checked that the repository
// is reachable through the App and minted a repository-scoped token with `contents: write` (the same scope a worker's push uses); this module only speaks the contents API with it.
//
// What it will and will not do, in code:
//  - it writes (and deletes) only a working branch named `rovara/lessons-<12 hex>` (never the default branch or any other name, a worker's task branch included) and only the lessons file and the three instruction files a pointer goes to;
//  - a NEW change request needs a branch that does not exist: it is created at the base revision the caller computed from. A branch that exists, at the base or not, is never written to for a new change request
//    and never moved (nothing is "adopted"); the caller uses another name. A creation that loses a race ("Reference already exists") is the same conflict (fix round 4, G1, G2);
//  - the write goes through the Git Data API (blobs, tree, a commit whose parent is the head the files were read at) and the branch is moved with `force: false`, which GitHub refuses unless the commit is a fast-forward of the
//    branch's current head: a commit pushed in between is never built on (G4);
//  - the caller says what it computed the files from (`baseRevision`, `expectedHead`, `previous`): a branch or file that is not as it read it is refused, so a person's push in between is never overwritten (M1);
//  - a symbolic link at a target path is refused (M2): writing to it would replace the link with a file and break a team's single-source setup; a directory, a submodule or a file too big to read at the path is a refused write, never "absent";
//  - each file is read on the branch first and written only when its text differs, so the same call twice changes nothing (the second answers `changed: false`);
//  - every path is a plain repository path (no empty, dot or dot-dot segment, no backslash, no control character), and every request is bounded in time and follows no redirect.
import { COMMIT_CONFLICT_MESSAGE, COMMIT_SYMLINK_MESSAGE, GitBranchNameSchema, LESSON_FILE_BRANCH_PATTERN, LESSON_FILE_WRITE_PATHS, agentXError } from "@rovara-code/contracts";

const ALLOWED_PATHS: ReadonlySet<string> = new Set(LESSON_FILE_WRITE_PATHS);
const TIMEOUT_MS = 10_000;

export interface GithubWriteContext {
  fetch: typeof fetch;
  owner: string;
  name: string;
  token: string;
}
export interface CommitFilesRequest {
  branch: string; baseBranch: string; message: string; fromBase: boolean;
  files: ReadonlyArray<{ path: string; content: string }>;
  baseRevision?: string | undefined; expectedHead?: string | undefined; previous?: ReadonlyArray<{ path: string; content: string | null }> | undefined;
}

function headers(token: string): Record<string, string> {
  return { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "agentx-control-plane", "x-github-api-version": "2022-11-28" };
}
const repoUrl = (context: GithubWriteContext, tail: string): string => `https://api.github.com/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}${tail}`;
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

/** A repository-relative path: bounded, no empty, dot or dot-dot segment, no backslash, no control character. Throws CONFIG_INVALID. */
export function checkedRepositoryPath(path: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path) || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw agentXError("CONFIG_INVALID", "file path is invalid");
  }
  return path;
}

async function send(context: GithubWriteContext, tail: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
  return context.fetch(repoUrl(context, tail), {
    method: init.method ?? "GET", headers: headers(context.token), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
  });
}
/** Drops an answer's body without ever throwing (a body that was already read is locked, and cancelling it rejects). */
const drop = (response: Response): void => { try { void response.body?.cancel().catch(() => undefined); } catch { /* already read */ } };
const failed = (what: string, response: Response): never => { drop(response); throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} failed with HTTP ${String(response.status)}`); };
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const SHA = /^[a-f0-9]{40}$/u;
/** Fixed sentences: the pass maps them to the codes the project page shows. */
export const SYMLINK_MESSAGE = COMMIT_SYMLINK_MESSAGE;
export const CONFLICT_MESSAGE = COMMIT_CONFLICT_MESSAGE;

/** The commit a branch points at, or undefined when the branch does not exist. */
async function headOf(context: GithubWriteContext, branch: string): Promise<string | undefined> {
  const response = await send(context, `/git/ref/heads/${encodePath(branch)}`);
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) return failed("branch lookup", response);
  const sha = record(record(await response.json()).object).sha;
  if (typeof sha !== "string" || !SHA.test(sha)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid branch reference");
  return sha;
}

/** A file on a ref: its blob id and text, or undefined when there is nothing at the path. A symbolic link, a directory, a submodule and a file over 1 MB are refused. */
async function fileOn(context: GithubWriteContext, path: string, ref: string): Promise<{ sha: string; text: string } | undefined> {
  const response = await send(context, `/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) return failed("file lookup", response);
  const body: unknown = await response.json();
  if (Array.isArray(body)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub file write refused: the path is a directory");
  const value = record(body);
  if (value.type === "symlink") throw agentXError("CONFIG_INVALID", SYMLINK_MESSAGE);
  // Only a path with nothing at it is "absent". A submodule, or a file the contents API does not return inline (over 1 MB: `encoding: "none"`), is something Rovara cannot read and must not replace: a refused write.
  if (value.type !== "file" || typeof value.sha !== "string" || typeof value.content !== "string" || value.encoding !== "base64") throw agentXError("RUNTIME_UNAVAILABLE", "GitHub file write refused: the path is not a file Rovara can read");
  return { sha: value.sha, text: Buffer.from(value.content.replace(/\n/gu, ""), "base64").toString("utf8") };
}

/** Whether a 422 answer's message says the reference already exists (a branch created in between, or a name somebody took). Reads at most 4 KB; anything else is "no". */
async function isExistsMessage(response: Response): Promise<boolean> {
  try {
    const message = record(JSON.parse((await response.text()).slice(0, 4096))).message;
    return typeof message === "string" && /already exists/iu.test(message);
  } catch { return false; }
}
/** Whether a 422 answer's message says the update would not be a fast-forward (the branch moved since the commit's parent was read). */
async function isNotFastForward(response: Response): Promise<boolean> {
  try {
    const message = record(JSON.parse((await response.text()).slice(0, 4096))).message;
    return typeof message === "string" && /fast[- ]forward/iu.test(message);
  } catch { return false; }
}
const sha40 = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !SHA.test(value)) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub returned an invalid ${what}`);
  return value;
};
async function post(context: GithubWriteContext, tail: string, body: unknown, what: string): Promise<Record<string, unknown>> {
  const response = await send(context, tail, { method: "POST", body });
  if (!response.ok) return failed(what, response);
  return record(await response.json());
}

/**
 * Writes the files on the branch (see the header) through the Git Data API: blobs, a tree on top of the head the files were read at, a commit whose parent IS that head, and then the branch moved with `force: false`, which GitHub
 * refuses unless the new commit is a fast-forward of the branch's current head. That last step is the compare-and-swap: a commit pushed to the branch since the head was read makes the update fail, and nothing is built on it
 * (fix round 4, G4). Returns the branch's head after the write, and whether anything changed.
 */
export async function commitFilesOn(context: GithubWriteContext, request: CommitFilesRequest): Promise<{ revision: string; changed: boolean }> {
  if (!LESSON_FILE_BRANCH_PATTERN.test(request.branch) || !GitBranchNameSchema.safeParse(request.branch).success || request.branch === request.baseBranch) throw agentXError("CONFIG_INVALID", "branch name is invalid");
  if (!GitBranchNameSchema.safeParse(request.baseBranch).success) throw agentXError("CONFIG_INVALID", "branch name is invalid");
  const files = request.files.map((file) => ({ path: checkedRepositoryPath(file.path), content: file.content }));
  if (files.some((file) => !ALLOWED_PATHS.has(file.path))) throw agentXError("CONFIG_INVALID", "file path is not one Rovara writes lessons to");
  for (const sha of [request.baseRevision, request.expectedHead]) if (sha !== undefined && !SHA.test(sha)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
  const baseHead = await headOf(context, request.baseBranch);
  if (baseHead === undefined) throw agentXError("CONFIG_INVALID", "the base branch does not exist");
  // The branch starts where the caller read the files, not where the base is now: a change made to the base in between then shows up as a conflict in the change request, never as a silent revert.
  const base = request.baseRevision ?? baseHead;
  let head = await headOf(context, request.branch);
  if (request.fromBase && head !== undefined) {
    // A new change request needs a branch nobody has: a branch that exists, at the base or not, is left exactly as it is, and the caller uses another name (round 4, G1: nothing is adopted).
    throw agentXError("CONFIG_INVALID", CONFLICT_MESSAGE);
  }
  if (head === undefined) {
    if (!request.fromBase && request.expectedHead !== undefined) throw agentXError("CONFIG_INVALID", CONFLICT_MESSAGE);
    const created = await send(context, "/git/refs", { method: "POST", body: { ref: `refs/heads/${request.branch}`, sha: base } });
    // 422 "Reference already exists": the name was taken between the check and the create. That is a conflict, and the caller tries another name (G2).
    if (created.status === 422 && (await isExistsMessage(created))) { drop(created); throw agentXError("CONFIG_INVALID", CONFLICT_MESSAGE); }
    if (!created.ok) return failed("branch creation", created);
    await created.body?.cancel();
    head = base;
  } else if (request.expectedHead !== undefined && head !== request.expectedHead) {
    throw agentXError("CONFIG_INVALID", CONFLICT_MESSAGE);
  }
  // What each file is at the head the new commit will be built on.
  const changes: Array<{ path: string; content: string }> = [];
  for (const file of files) {
    const current = await fileOn(context, file.path, head);
    const expected = request.previous?.find((entry) => entry.path === file.path);
    if (expected !== undefined && (current?.text ?? null) !== expected.content) throw agentXError("CONFIG_INVALID", CONFLICT_MESSAGE);
    if (current !== undefined && current.text === file.content) continue;
    changes.push(file);
  }
  if (changes.length === 0) return { revision: head, changed: false };
  const parent = await send(context, `/git/commits/${head}`);
  if (!parent.ok) return failed("commit lookup", parent);
  const baseTree = sha40(record(record(await parent.json()).tree).sha, "tree");
  const entries: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of changes) {
    const blob = await post(context, "/git/blobs", { content: Buffer.from(file.content, "utf8").toString("base64"), encoding: "base64" }, "file write");
    entries.push({ path: file.path, mode: "100644", type: "blob", sha: sha40(blob.sha, "blob") });
  }
  const tree = sha40((await post(context, "/git/trees", { base_tree: baseTree, tree: entries }, "file write")).sha, "tree");
  const commit = sha40((await post(context, "/git/commits", { message: request.message, tree, parents: [head] }, "file write")).sha, "commit");
  const moved = await send(context, `/git/refs/heads/${encodePath(request.branch)}`, { method: "PATCH", body: { sha: commit, force: false } });
  // Not a fast-forward (a commit landed on the branch since its head was read), or the branch is gone: a conflict, and nothing was built on the other commit. Any other refusal (a branch rule) is a refused write.
  if (moved.status === 409 || moved.status === 404 || (moved.status === 422 && (await isNotFastForward(moved)))) { drop(moved); throw agentXError("CONFIG_INVALID", CONFLICT_MESSAGE); }
  if (!moved.ok) return failed("file write", moved);
  await moved.body?.cancel();
  return { revision: commit, changed: true };
}

/**
 * Deletes one of Rovara's own lessons branches (a name `rovara/lessons-<12 hex>` only; any other name is refused before the host is asked). "gone" when there is no such branch. Deleting the head branch of an open pull
 * request closes that pull request, which is why the pass uses it to clean up a write whose pull request was never recorded.
 */
export async function deleteBranchOn(context: GithubWriteContext, branch: string): Promise<"deleted" | "gone"> {
  if (!LESSON_FILE_BRANCH_PATTERN.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
  const response = await send(context, `/git/refs/heads/${encodePath(branch)}`, { method: "DELETE" });
  // Only GitHub's own "Reference does not exist" (a 422) means there was nothing to delete. A 404 (the repository or the permission), any other 422 and every other refusal is a failure the caller tries again, never "gone" (review L3).
  if (response.status === 422 && await doesNotExist(response)) { drop(response); return "gone"; }
  if (!response.ok) return failed("branch deletion", response);
  await response.body?.cancel();
  return "deleted";
}

/** Whether a 422 answer's message says the reference does not exist. Reads at most 4 KB; anything else is "no". */
async function doesNotExist(response: Response): Promise<boolean> {
  try {
    const message = record(JSON.parse((await response.text()).slice(0, 4096))).message;
    return typeof message === "string" && /reference does not exist/iu.test(message);
  } catch { return false; }
}
