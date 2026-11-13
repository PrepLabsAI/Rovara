// GitHub's Git Data and contents API for one repository, with a token that never leaves the broker. Every call has a timeout, never follows a redirect, reads a bounded answer, and fails with a
// fixed sentence (GitHub's own text is never kept). Used by publish.ts (blobs, tree, commit, branch, compare) and for reading the meta repo's folders at a commit.
import { SpecHostError, type SpecGitClient } from "../../../core/spec/publish.js";

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;
const ANSWER_MAX_BYTES = 2 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;

export class GitHubSpecError extends SpecHostError {
  constructor(status: number) { super(status, `GitHub answered ${String(status)}`); this.name = "GitHubSpecError"; }
}

export interface GitHubRepositoryRef { owner: string; name: string }

export function githubSpecClient(input: { repository: GitHubRepositoryRef; token: string; fetchImplementation?: typeof fetch }): SpecGitClient & {
  listDirectory(path: string, ref: string): Promise<Array<{ name: string; type: "file" | "dir" | "other" }> | undefined>;
  readFile(path: string, ref: string, maxBytes: number): Promise<string | undefined>;
} {
  const fetcher = input.fetchImplementation ?? fetch;
  const base = `${API}/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}`;
  async function call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, allow: readonly number[] = []): Promise<{ status: number; json: unknown }> {
    const response = await fetcher(`${base}${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${input.token}`, "x-github-api-version": "2022-11-28", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !allow.includes(response.status)) throw new GitHubSpecError(response.status);
    const text = response.status === 204 ? "" : await response.text();
    if (text.length > ANSWER_MAX_BYTES) throw new GitHubSpecError(502);
    if (!response.ok) return { status: response.status, json: undefined };
    try { return { status: response.status, json: text === "" ? undefined : JSON.parse(text) as unknown }; } catch { throw new GitHubSpecError(502); }
  }
  const record = (value: unknown): Record<string, unknown> => { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GitHubSpecError(502); return value as Record<string, unknown>; };
  const sha = (value: unknown): string => { if (typeof value !== "string" || !SHA.test(value)) throw new GitHubSpecError(502); return value; };
  const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

  return {
    getCommit: async (commit) => {
      const json = record((await call("GET", `/git/commits/${sha(commit)}`)).json);
      const parents = Array.isArray(json["parents"]) ? json["parents"].map((parent) => sha(record(parent)["sha"])) : [];
      return { tree: sha(record(json["tree"])["sha"]), parents };
    },
    getBranch: async (branch) => {
      const answered = await call("GET", `/git/ref/heads/${encodePath(branch)}`, undefined, [404]);
      return answered.status === 404 ? undefined : sha(record(record(answered.json)["object"])["sha"]);
    },
    createBlob: async (content) => sha(record((await call("POST", "/git/blobs", { content, encoding: "utf-8" })).json)["sha"]),
    createTree: async (baseTree, entries) => sha(record((await call("POST", "/git/trees", { base_tree: sha(baseTree), tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: sha(entry.sha) })) })).json)["sha"]),
    createCommit: async ({ message, tree, parent }) => sha(record((await call("POST", "/git/commits", { message, tree: sha(tree), parents: [sha(parent)] })).json)["sha"]),
    createBranch: async (branch, commit) => { await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: sha(commit) }); },
    deleteBranch: async (branch) => { await call("DELETE", `/git/refs/heads/${encodePath(branch)}`, undefined, [404, 422]); },
    branchContains: async (commit, branch) => {
      // The comparison of the commit with the branch: "ahead" or "identical" means the branch holds the commit; "diverged" or "behind" means it was moved on without it.
      const json = record((await call("GET", `/compare/${sha(commit)}...${encodePath(branch)}?per_page=1`)).json);
      return json["status"] === "ahead" || json["status"] === "identical";
    },
    compare: async (baseCommit, headCommit) => {
      const json = record((await call("GET", `/compare/${sha(baseCommit)}...${sha(headCommit)}?per_page=100`)).json);
      const files = Array.isArray(json["files"]) ? json["files"].map((entry) => {
        const file = record(entry);
        return { path: typeof file["filename"] === "string" ? file["filename"] : "", status: typeof file["status"] === "string" ? file["status"] : "", sha: typeof file["sha"] === "string" ? file["sha"] : "" };
      }) : [];
      const commits = typeof json["total_commits"] === "number" ? json["total_commits"] : -1;
      // GitHub lists at most 300 files of a comparison, and 100 to a page: a list that fills the page may be cut.
      return { complete: files.length < 100 && commits >= 0, commits, files };
    },
    listDirectory: async (path, ref) => {
      const answered = await call("GET", `/contents/${encodePath(path)}?ref=${sha(ref)}`, undefined, [404]);
      if (answered.status === 404 || !Array.isArray(answered.json)) return undefined;
      return answered.json.slice(0, 1_000).map((entry) => {
        const item = record(entry);
        return { name: typeof item["name"] === "string" ? item["name"] : "", type: item["type"] === "file" ? "file" as const : item["type"] === "dir" ? "dir" as const : "other" as const };
      });
    },
    readFile: async (path, ref, maxBytes) => {
      const answered = await call("GET", `/contents/${encodePath(path)}?ref=${sha(ref)}`, undefined, [404]);
      if (answered.status === 404) return undefined;
      const item = record(answered.json);
      if (item["type"] !== "file" || item["encoding"] !== "base64" || typeof item["content"] !== "string" || (typeof item["size"] === "number" && item["size"] > maxBytes)) return undefined;
      const bytes = Buffer.from(item["content"], "base64");
      return bytes.byteLength > maxBytes ? undefined : bytes.toString("utf8");
    },
  };
}
