// The GitHub side of the eval wrapper pull request (L4-EVW6, DEC 254zzz43). This is the ONLY place Rovara writes to a customer's repository outside a task, and it is deliberately NOT a general way to write files
// (DEC 254zzz14 deleted that). The caller (the provider) has already checked that the repository is reachable through the company's own GitHub App installation and minted a repository-scoped token
// (`contents: write`, `pull_requests: write`); this module only speaks the API with it. It is reached only from a person's POST (the route checks their live role and writes the audit first).
//
// What it will and will not do, in code:
//  - it makes ONE new branch named `rovara/eval-wrapper-<12 hex>` that does not exist (never the default branch, never any other name), adds ONE new file at one of the two fixed wrapper paths, and opens ONE pull request
//    from that branch against the default branch the caller named. Nothing else: no update of a branch that exists, no second file, no other path, no write to the default branch, no merge;
//  - the default branch must still be at the commit the caller checked the path at (else a conflict, nothing is written), and NOTHING may be at the wrapper's path at that commit: a file, a folder, a symbolic link or a
//    submodule there (or a file where its parent folder would be) is refused as "taken", never replaced;
//  - the commit is built from the objects first (blob, tree on top of that commit, a commit whose parent is that commit) and the branch is created pointing at it in ONE step, so a branch never exists without its file;
//  - when the pull request cannot be opened, the branch Rovara just made is deleted, but only while it still points at the commit Rovara made (a push by anyone else is never touched);
//  - every request is bounded in time, follows no redirect, and addresses the one repository the token was minted for.
// The only exports are the two operations and their context; there is no function here that takes a branch, a path or a file from a caller without the checks above.
import { EVAL_WRAPPER_CONFLICT_MESSAGE, EVAL_WRAPPER_BRANCH_PATTERN, EVAL_WRAPPER_PATH_TAKEN_MESSAGE, EVAL_WRAPPER_WRITE_PATHS, EvalWrapperPullRequestInputSchema, agentXError, type EvalWrapperPullRequestInput } from "@agentx/contracts";

const TIMEOUT_MS = 10_000;
const SHA = /^[a-f0-9]{40}$/u;
/** GitHub lists at most 1,000 entries of a folder: a listing this long that does not name the wrapper cannot say it is absent. */
const LISTING_MAX_ENTRIES = 1_000;

export interface EvalWrapperWriteContext {
  fetch: typeof fetch;
  owner: string;
  name: string;
  token: string;
}

const headers = (token: string): Record<string, string> => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "agentx-control-plane", "x-github-api-version": "2022-11-28" });
const repoUrl = (context: EvalWrapperWriteContext, tail: string): string => `https://api.github.com/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}${tail}`;
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");
const send = (context: EvalWrapperWriteContext, tail: string, init: { method?: string; body?: unknown } = {}): Promise<Response> => context.fetch(repoUrl(context, tail), {
  method: init.method ?? "GET", headers: headers(context.token), ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
});
/** Drops an answer's body without ever throwing (a body that was already read is locked, and cancelling it rejects). */
const drop = (response: Response): void => { try { void response.body?.cancel().catch(() => undefined); } catch { /* already read */ } };
const failed = (what: string, response: Response): never => { drop(response); throw agentXError("RUNTIME_UNAVAILABLE", `GitHub ${what} failed with HTTP ${String(response.status)}`); };
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const sha40 = (value: unknown, what: string): string => {
  if (typeof value !== "string" || !SHA.test(value)) throw agentXError("RUNTIME_UNAVAILABLE", `GitHub returned an invalid ${what}`);
  return value;
};
async function post(context: EvalWrapperWriteContext, tail: string, body: unknown, what: string): Promise<Record<string, unknown>> {
  const response = await send(context, tail, { method: "POST", body });
  if (!response.ok) return failed(what, response);
  return record(await response.json());
}
/** Whether a 422 answer's message says the reference already exists. Reads at most 4 KB; anything else is "no". */
async function isExistsMessage(response: Response): Promise<boolean> {
  try {
    const message = record(JSON.parse((await response.text()).slice(0, 4096))).message;
    return typeof message === "string" && /already exists/iu.test(message);
  } catch { return false; }
}

/** The commit a branch points at, or undefined when the branch does not exist. */
async function headOf(context: EvalWrapperWriteContext, branch: string): Promise<string | undefined> {
  const response = await send(context, `/git/ref/heads/${encodePath(branch)}`);
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) return failed("branch lookup", response);
  return sha40(record(record(await response.json()).object).sha, "branch reference");
}

/**
 * Whether anything is at the wrapper's path at a commit: the folder that holds it is read once. Absent folder = free. A listing that names the wrapper (any type), a folder that is really a file, a link or a submodule, and a
 * listing too long to say are all "taken" (a refusal, never a write). GitHub failing to answer throws.
 */
async function pathIsFree(context: EvalWrapperWriteContext, path: string, commit: string): Promise<boolean> {
  const cut = path.lastIndexOf("/");
  const folder = cut < 0 ? "" : path.slice(0, cut);
  const name = path.slice(cut + 1);
  const response = await send(context, `/contents${folder === "" ? "" : `/${encodePath(folder)}`}?ref=${encodeURIComponent(commit)}`);
  if (response.status === 404) { await response.body?.cancel(); return true; }
  if (!response.ok) return failed("path lookup", response);
  const body: unknown = await response.json();
  if (!Array.isArray(body)) return false;
  if ((body as Array<{ name?: unknown }>).some((entry) => entry.name === name)) return false;
  return body.length < LISTING_MAX_ENTRIES;
}

/**
 * Creates the branch with the one new file and opens the one pull request (see the header). Throws `CONFIG_INVALID` with the fixed `EVAL_WRAPPER_CONFLICT_MESSAGE` (the default branch moved, or the branch name was taken)
 * or `EVAL_WRAPPER_PATH_TAKEN_MESSAGE` (something is at the path), and `RUNTIME_UNAVAILABLE` for GitHub failing; after any throw the repository holds nothing Rovara added.
 */
export async function openEvalWrapperPullRequestOn(context: EvalWrapperWriteContext, request: EvalWrapperPullRequestInput): Promise<{ revision: string; number: number; url: string }> {
  const input = EvalWrapperPullRequestInputSchema.parse(request);
  // The checks the schema also makes, kept here so this function holds them on its own.
  if (!EVAL_WRAPPER_BRANCH_PATTERN.test(input.branch) || input.branch === input.baseBranch) throw agentXError("CONFIG_INVALID", "branch name is invalid");
  if (!EVAL_WRAPPER_WRITE_PATHS.includes(input.path)) throw agentXError("CONFIG_INVALID", "file path is not one Rovara writes an eval wrapper to");
  if (!SHA.test(input.baseRevision)) throw agentXError("CONFIG_INVALID", "commit identity is invalid");
  // The default branch is where the caller read it, and the new branch does not exist.
  const baseHead = await headOf(context, input.baseBranch);
  if (baseHead === undefined) throw agentXError("CONFIG_INVALID", "the base branch does not exist");
  if (baseHead !== input.baseRevision) throw agentXError("CONFIG_INVALID", EVAL_WRAPPER_CONFLICT_MESSAGE);
  if (await headOf(context, input.branch) !== undefined) throw agentXError("CONFIG_INVALID", EVAL_WRAPPER_CONFLICT_MESSAGE);
  // Never over anything: nothing may be at the path at that commit.
  if (!await pathIsFree(context, input.path, baseHead)) throw agentXError("CONFIG_INVALID", EVAL_WRAPPER_PATH_TAKEN_MESSAGE);

  // The objects first: a blob, a tree on top of the base commit's tree, a commit whose parent IS the base commit.
  const parent = await send(context, `/git/commits/${baseHead}`);
  if (!parent.ok) return failed("commit lookup", parent);
  const baseTree = sha40(record(record(await parent.json()).tree).sha, "tree");
  const blob = await post(context, "/git/blobs", { content: Buffer.from(input.content, "utf8").toString("base64"), encoding: "base64" }, "file write");
  const tree = sha40((await post(context, "/git/trees", { base_tree: baseTree, tree: [{ path: input.path, mode: "100644", type: "blob", sha: sha40(blob.sha, "blob") }] }, "file write")).sha, "tree");
  const commit = sha40((await post(context, "/git/commits", { message: `Add Rovara's eval wrapper (${input.path})`, tree, parents: [baseHead] }, "file write")).sha, "commit");

  // The branch is created pointing at that commit in one step. 422 "Reference already exists": the name was taken between the check and the create, a conflict (nothing is moved or adopted).
  const created = await send(context, "/git/refs", { method: "POST", body: { ref: `refs/heads/${input.branch}`, sha: commit } });
  if (created.status === 422 && await isExistsMessage(created)) { drop(created); throw agentXError("CONFIG_INVALID", EVAL_WRAPPER_CONFLICT_MESSAGE); }
  if (!created.ok) return failed("branch creation", created);
  await created.body?.cancel();

  let opened: Record<string, unknown>;
  try {
    opened = await post(context, "/pulls", { title: input.title, head: input.branch, base: input.baseBranch, body: input.body }, "pull request creation");
    if (typeof opened.number !== "number" || !Number.isSafeInteger(opened.number) || opened.number < 1) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  } catch (error) {
    await removeOwnBranch(context, input.branch, commit);
    throw error;
  }
  const url = typeof opened.html_url === "string" && opened.html_url.startsWith("https://") ? opened.html_url : "";
  return { revision: commit, number: opened.number, url };
}

/** Deletes the branch this call made, only while it still points at the commit this call made (best effort: a failure leaves it for a person, who can delete it). */
async function removeOwnBranch(context: EvalWrapperWriteContext, branch: string, commit: string): Promise<void> {
  try {
    if (await headOf(context, branch) !== commit) return;
    const response = await send(context, `/git/refs/heads/${encodePath(branch)}`, { method: "DELETE" });
    drop(response);
  } catch { /* left for the person */ }
}

/** The pull request (any state) made from one of Rovara's own `rovara/eval-wrapper-<12 hex>` branches, or undefined. No other branch name is looked up. A read only. */
export async function findEvalWrapperPullRequestOn(context: EvalWrapperWriteContext, branch: string): Promise<{ number: number; url: string } | undefined> {
  if (!EVAL_WRAPPER_BRANCH_PATTERN.test(branch)) throw agentXError("CONFIG_INVALID", "branch name is invalid");
  const query = new URLSearchParams({ state: "all", head: `${context.owner}:${branch}`, per_page: "1" });
  const response = await send(context, `/pulls?${query.toString()}`);
  if (!response.ok) return failed("pull request lookup", response);
  const value: unknown = await response.json();
  const first = Array.isArray(value) ? (value[0] as { number?: unknown; html_url?: unknown } | undefined) : undefined;
  if (first === undefined) return undefined;
  if (typeof first.number !== "number" || !Number.isSafeInteger(first.number)) throw agentXError("RUNTIME_UNAVAILABLE", "GitHub returned an invalid pull request response");
  return { number: first.number, url: typeof first.html_url === "string" && first.html_url.startsWith("https://") ? first.html_url : "" };
}
