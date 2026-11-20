// L4-EVW6 (DEC 254zzz43 / 254zzz14): the narrow GitHub write of the eval wrapper pull request. It is the ONLY write Rovara makes to a customer's repository outside a task, so every rule is proved by what GitHub would
// be asked: a stand-in for GitHub's git data API records every request. One new branch `rovara/eval-wrapper-<12 hex>`, one new file at one of the two fixed paths, one pull request; nothing else, and no generic write API.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  EVAL_WRAPPER_CONFLICT_MESSAGE, EVAL_WRAPPER_NODE_PATH, EVAL_WRAPPER_PATH_TAKEN_MESSAGE, EVAL_WRAPPER_PYTHON_PATH, EVAL_WRAPPER_WRITE_PATHS, type CodeHost, type EvalWrapperPullRequestInput,
} from "@agentx/contracts";
import { FakeCodeHost, FakeHostModel } from "@agentx/broker/fakes";
import * as writer from "../../packages/broker/src/plugins/code-host/github/eval-wrapper-pr.js";
import { findEvalWrapperPullRequestOn, openEvalWrapperPullRequestOn, type EvalWrapperWriteContext } from "../../packages/broker/src/plugins/code-host/github/eval-wrapper-pr.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import type { GitHubCodeHostProvider } from "../../packages/broker/src/plugins/code-host/github/provider.js";

type Entry = "file" | "symlink" | "submodule";
const BRANCH = "rovara/eval-wrapper-0123456789ab";
const URL_A = "https://github.com/acme/app";

/** A repository as GitHub's git data API shows it, and every request made to it. */
class FakeGitHub {
  readonly requests: string[] = [];
  readonly branches = new Map<string, string>();
  readonly commits = new Map<string, { tree: Map<string, Entry>; parent?: string }>();
  readonly written = { blobs: [] as unknown[], trees: [] as Array<Record<string, unknown>>, commits: [] as Array<Record<string, unknown>>, refs: [] as Array<Record<string, unknown>>, pulls: [] as Array<Record<string, unknown>> };
  failPulls = false;
  refAlreadyExists = false;
  /** The ref is created, then the request fails (a timeout after GitHub applied it). */
  refThenThrow = false;
  /** Runs when the pull request is asked for (a person pushes to the branch in between). */
  onPull: (() => void) | undefined;
  private counter = 0;
  private sha(): string { this.counter += 1; return this.counter.toString(16).padStart(40, "0"); }
  constructor(files: Record<string, Entry> = { "src/a.ts": "file" }) { this.seed(files); }
  seed(files: Record<string, Entry>): string {
    const sha = this.sha();
    this.commits.set(sha, { tree: new Map(Object.entries(files)), ...(this.branches.get("main") === undefined ? {} : { parent: this.branches.get("main")! }) });
    this.branches.set("main", sha);
    return sha;
  }
  get writes(): string[] { return this.requests.filter((request) => !request.startsWith("GET ")); }
  private json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
  private listing(folder: string, tree: ReadonlyMap<string, Entry>): Response {
    const own = tree.get(folder);
    if (own !== undefined) return this.json(200, { type: own === "file" ? "file" : own, name: folder.split("/").pop(), sha: this.sha(), content: "", encoding: "base64" });
    const names = new Map<string, "file" | "dir" | "symlink" | "submodule">();
    for (const [path, type] of tree) {
      if (!path.startsWith(`${folder}/`)) continue;
      const rest = path.slice(folder.length + 1);
      names.set(rest.split("/")[0]!, rest.includes("/") ? "dir" : type);
    }
    return names.size === 0 ? this.json(404, { message: "Not Found" }) : this.json(200, [...names].map(([name, type]) => ({ name, type })));
  }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/repos/acme/app", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    this.requests.push(`${method} ${path}`);
    let match: RegExpExecArray | null;
    if (method === "GET" && (match = /^\/git\/ref\/heads\/(.+)$/u.exec(path)) !== null) {
      const head = this.branches.get(decodeURIComponent(match[1]!));
      return head === undefined ? this.json(404, { message: "Not Found" }) : this.json(200, { object: { sha: head } });
    }
    if (method === "GET" && (match = /^\/contents\/(.+)$/u.exec(path)) !== null) {
      const commit = this.commits.get(url.searchParams.get("ref")!);
      return commit === undefined ? this.json(404, { message: "Not Found" }) : this.listing(decodeURIComponent(match[1]!), commit.tree);
    }
    if (method === "GET" && (match = /^\/git\/commits\/([0-9a-f]{40})$/u.exec(path)) !== null) return this.commits.has(match[1]!) ? this.json(200, { tree: { sha: "9".repeat(40) } }) : this.json(404, {});
    if (method === "POST" && path === "/git/blobs") { this.written.blobs.push(body); return this.json(201, { sha: this.sha() }); }
    if (method === "POST" && path === "/git/trees") { this.written.trees.push(body); return this.json(201, { sha: this.sha() }); }
    if (method === "POST" && path === "/git/commits") {
      this.written.commits.push(body);
      const sha = this.sha();
      this.commits.set(sha, { tree: new Map(this.commits.get((body.parents as string[])[0]!)!.tree), parent: (body.parents as string[])[0]! });
      return this.json(201, { sha });
    }
    if (method === "POST" && path === "/git/refs") {
      this.written.refs.push(body);
      if (this.refAlreadyExists || this.branches.has(String(body.ref).replace("refs/heads/", ""))) return this.json(422, { message: "Reference already exists" });
      this.branches.set(String(body.ref).replace("refs/heads/", ""), String(body.sha));
      if (this.refThenThrow) throw new Error("timed out");
      return this.json(201, { object: { sha: body.sha } });
    }
    if (method === "POST" && path === "/pulls") {
      this.written.pulls.push(body);
      this.onPull?.();
      return this.failPulls ? this.json(422, { message: "Validation Failed" }) : this.json(201, { number: 7, html_url: "https://github.com/acme/app/pull/7" });
    }
    if (method === "DELETE" && (match = /^\/git\/refs\/heads\/(.+)$/u.exec(path)) !== null) { this.branches.delete(decodeURIComponent(match[1]!)); return new Response(null, { status: 204 }); }
    if (method === "GET" && path === "/pulls") return this.json(200, url.searchParams.get("head") === `acme:${BRANCH}` ? [{ number: 7, html_url: "https://github.com/acme/app/pull/7" }] : []);
    return this.json(500, { message: `unexpected ${method} ${path}` });
  };
}

const contextOf = (github: FakeGitHub): EvalWrapperWriteContext => ({ fetch: github.fetch, owner: "acme", name: "app", token: "token" });
const requestOf = (github: FakeGitHub, over: Record<string, unknown> = {}): EvalWrapperPullRequestInput => ({
  repository: { url: URL_A }, baseBranch: "main", baseRevision: github.branches.get("main")!, branch: BRANCH, path: EVAL_WRAPPER_PYTHON_PATH, content: "# wrapper\n", title: "Add Rovara's eval wrapper", body: "Please read it.", ...over,
});
const refusal = async (call: () => Promise<unknown>): Promise<string> => { try { await call(); return ""; } catch (error) { return error instanceof Error ? error.message : String(error); } };

describe("the GitHub eval wrapper pull request: what it does", () => {

  it("works for the Node wrapper path too, and for a repository whose rovara folder already holds other files", async () => {
    const github = new FakeGitHub({ "rovara/notes.md": "file", "src/a.ts": "file" });
    await openEvalWrapperPullRequestOn(contextOf(github), requestOf(github, { path: EVAL_WRAPPER_NODE_PATH }));
    expect(github.written.trees[0]!.tree).toEqual([expect.objectContaining({ path: EVAL_WRAPPER_NODE_PATH })]);
  });
});

describe("the GitHub eval wrapper pull request: what it refuses (nothing is asked of GitHub)", () => {
  it.each([
    "src/a.ts", ".github/workflows/ci.yml", "AGENTS.md", "CLAUDE.md", ".rovara/lessons.md", "rovara/eval-wrapper.sh", "rovara/other.py", "rovara/../x.py", "/rovara/eval-wrapper.py", "rovara/eval-wrapper.py/x", "ROVARA/eval-wrapper.py", "",
  ])("the path %j is refused before any request", async (path) => {
    const github = new FakeGitHub();
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github, { path })))).not.toBe("");
    expect(github.requests).toEqual([]);
  });

  it.each([
    "main", "master", "develop", "agentx/11111111-2222-4333-8444-555555555555", "rovara/lessons-0123456789ab", "rovara/eval-wrapper-0123456789a", "rovara/eval-wrapper-0123456789abc", "rovara/eval-wrapper-0123456789AB", "rovara/eval-wrapper-0123456789ab/x", "feature/x",
  ])("the branch %j is refused before any request", async (branch) => {
    const github = new FakeGitHub();
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github, { branch })))).not.toBe("");
    expect(github.requests).toEqual([]);
  });

  it("a request with a second file, an extra field, an empty or oversize file, or a bad commit identity is refused before any request", async () => {
    const github = new FakeGitHub();
    for (const over of [{ files: [{ path: EVAL_WRAPPER_PYTHON_PATH, content: "x" }] }, { force: true }, { content: "" }, { content: "x".repeat(100_001) }, { baseRevision: "main" }, { baseBranch: BRANCH }]) {
      expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github, over))), JSON.stringify(over).slice(0, 40)).not.toBe("");
    }
    expect(github.requests).toEqual([]);
  });

  it.each([
    ["a file", { [EVAL_WRAPPER_PYTHON_PATH]: "file" as Entry }],
    ["a symbolic link", { [EVAL_WRAPPER_PYTHON_PATH]: "symlink" as Entry }],
    ["a submodule", { [EVAL_WRAPPER_PYTHON_PATH]: "submodule" as Entry }],
    ["a folder", { [`${EVAL_WRAPPER_PYTHON_PATH}/x.txt`]: "file" as Entry }],
    ["a file where the rovara folder would be", { rovara: "file" as Entry }],
    ["a symbolic link where the rovara folder would be", { rovara: "symlink" as Entry }],
  ])("%s at the wrapper's path is never replaced: refused as taken, and NOTHING is written", async (_name, files) => {
    const github = new FakeGitHub(files);
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github)))).toContain(EVAL_WRAPPER_PATH_TAKEN_MESSAGE);
    expect(github.writes).toEqual([]);
    expect([...github.branches.keys()]).toEqual(["main"]);
  });

  it("a default branch that moved since the path was checked is a conflict, and so is a branch name somebody already has: nothing is written", async () => {
    const moved = new FakeGitHub();
    const request = requestOf(moved);
    moved.seed({ "src/a.ts": "file", [EVAL_WRAPPER_PYTHON_PATH]: "file" });
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(moved), request))).toContain(EVAL_WRAPPER_CONFLICT_MESSAGE);
    expect(moved.writes).toEqual([]);
    const taken = new FakeGitHub();
    const theirs = taken.seed({ "src/a.ts": "file" });
    taken.branches.set(BRANCH, theirs);
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(taken), requestOf(taken)))).toContain(EVAL_WRAPPER_CONFLICT_MESSAGE);
    expect(taken.writes).toEqual([]);
    expect(taken.branches.get(BRANCH)).toBe(theirs);
  });

  it("a branch created between the check and the create is a conflict: it is never moved, adopted or deleted", async () => {
    const github = new FakeGitHub();
    github.refAlreadyExists = true;
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github)))).toContain(EVAL_WRAPPER_CONFLICT_MESSAGE);
    expect(github.writes).not.toContain("POST /pulls");
    expect(github.writes.some((write) => write.startsWith("DELETE"))).toBe(false);
  });
});

describe("the GitHub eval wrapper pull request: a failure leaves nothing of Rovara's behind", () => {
  it("when the pull request cannot be opened, the branch Rovara just made is deleted", async () => {
    const github = new FakeGitHub();
    github.failPulls = true;
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github)))).toMatch(/pull request creation failed/u);
    expect(github.writes.at(-1)).toBe(`DELETE /git/refs/heads/${BRANCH}`);
    expect([...github.branches.keys()]).toEqual(["main"]);
  });

  it("a branch that a person pushed to in the meantime is never deleted", async () => {
    const github = new FakeGitHub();
    github.failPulls = true;
    github.onPull = () => { github.branches.set(BRANCH, "f".repeat(40)); };
    await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github)));
    expect(github.writes.some((write) => write.startsWith("DELETE"))).toBe(false);
    expect(github.branches.get(BRANCH)).toBe("f".repeat(40));
  });
});

describe("the GitHub eval wrapper pull request: lost answers and odd names", () => {
  it("a branch create that GitHub applied but whose answer was lost is removed (only while it is Rovara's own commit)", async () => {
    const github = new FakeGitHub();
    github.refThenThrow = true;
    expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github)))).toBe("timed out");
    expect(github.writes).not.toContain("POST /pulls");
    expect([...github.branches.keys()]).toEqual(["main"]);
  });

  it("a default branch name with a dot segment is refused before any request", async () => {
    const github = new FakeGitHub();
    for (const baseBranch of ["..", "a/../b", "./x", "a//b"]) expect(await refusal(() => openEvalWrapperPullRequestOn(contextOf(github), requestOf(github, { baseBranch }))), baseBranch).not.toBe("");
    expect(github.requests).toEqual([]);
  });
});

describe("the lookup of a wrapper pull request", () => {
  it("finds the pull request of one of Rovara's wrapper branches, and refuses every other branch name before asking", async () => {
    const github = new FakeGitHub();
    expect(await findEvalWrapperPullRequestOn(contextOf(github), BRANCH)).toEqual({ number: 7, url: "https://github.com/acme/app/pull/7" });
    expect(await findEvalWrapperPullRequestOn(contextOf(github), "rovara/eval-wrapper-ffffffffffff")).toBeUndefined();
    const asked = github.requests.length;
    for (const branch of ["main", "rovara/lessons-0123456789ab", "agentx/x", "rovara/eval-wrapper-0123"]) expect(await refusal(() => findEvalWrapperPullRequestOn(contextOf(github), branch)), branch).not.toBe("");
    expect(github.requests).toHaveLength(asked);
    expect(github.requests.every((request) => request.startsWith("GET "))).toBe(true);
  });
});

describe("no generic commit API", () => {
  it("the module exports exactly the two operations, and its source has no update, merge, force, default-branch or generic path", () => {
    expect(Object.keys(writer).sort()).toEqual(["findEvalWrapperPullRequestOn", "openEvalWrapperPullRequestOn"]);
    const source = readFileSync(join(import.meta.dirname, "../../packages/broker/src/plugins/code-host/github/eval-wrapper-pr.ts"), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line)).join("\n");
    expect(source).not.toMatch(/"PATCH"|"PUT"|force:|\/merge|checkedRepositoryPath|commitFiles|CommitFiles/u);
    // Every method used is one of GET, POST and the one DELETE of the branch Rovara made.
    expect([...new Set([...source.matchAll(/method: "([A-Z]+)"/gu)].map((match) => match[1]))].sort()).toEqual(["DELETE", "POST"]);
    expect(EVAL_WRAPPER_WRITE_PATHS).toEqual([EVAL_WRAPPER_PYTHON_PATH, EVAL_WRAPPER_NODE_PATH]);
  });

  it("the code host port has no generic file write, and the narrow write is named in only the files that wire or call it", () => {
    const root = join(import.meta.dirname, "../..");
    const walk = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (name === "node_modules" || name === "dist" || name.endsWith(".tsbuildinfo")) return [];
      return statSync(path).isDirectory() ? walk(path) : name.endsWith(".ts") ? [path] : [];
    });
    const sources = ["broker", "contracts", "worker"].flatMap((name) => walk(join(root, "packages", name, "src"))).map((path) => ({ rel: relative(root, path), text: readFileSync(path, "utf8") }));
    expect(sources.filter((file) => /\bcommitFiles\b|CommitFilesInput|CommitFilesResult|commitFilesToBranch|commitLessonFiles/u.test(file.text)).map((file) => file.rel)).toEqual([]);
    expect(sources.filter((file) => /evalWrapperPullRequest/u.test(file.text)).map((file) => file.rel).sort()).toEqual([
      "packages/broker/src/core/setup-agent/eval-wrapper-host.ts", "packages/broker/src/core/setup-agent/eval-wrapper.ts", "packages/broker/src/plugins/code-host/github/index.ts", "packages/broker/src/plugins/code-host/github/provider.ts", "packages/broker/src/plugins/fake/code-host.ts", "packages/contracts/src/plugins/code-host.ts",
    ]);
    // Only the wrapper module opens it, and only the card's route calls that module (a person's POST).
    expect(sources.filter((file) => /evalWrapperPullRequest[!?]?\.open\(/u.test(file.text)).map((file) => file.rel)).toEqual(["packages/broker/src/core/setup-agent/eval-wrapper.ts"]);
    expect(sources.filter((file) => /openEvalWrapperPullRequest\(/u.test(file.text) && !/plugins\/code-host\/github|plugins\/fake|aws\/core-code-host/u.test(file.rel)).map((file) => file.rel).sort())
      .toEqual(["packages/broker/src/core-host/setup-run-routes.ts", "packages/broker/src/core/setup-agent/eval-wrapper.ts"]);
  });
});

describe("the adapter and the fake host hold the same line", () => {
  const stubProvider = (calls: string[]): GitHubCodeHostProvider => ({
    openEvalWrapperPullRequest: async (url: string, request: EvalWrapperPullRequestInput) => { calls.push(`open ${url} ${request.path}`); return { revision: "a".repeat(40), number: 3, url: "https://github.com/acme/app/pull/3" }; },
    findEvalWrapperPullRequest: async (_url: string, branch: string) => { calls.push(`find ${branch}`); return undefined; },
  }) as unknown as GitHubCodeHostProvider;
  const adapter = (calls: string[]): CodeHost => githubCodeHost(stubProvider(calls), { credentialRef: "github" });
  const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as never;

  it("the GitHub adapter offers the narrow write only when the client has both halves, and parses the request before the client is asked", async () => {
    expect(githubCodeHost({} as unknown as GitHubCodeHostProvider, { credentialRef: "github" }).evalWrapperPullRequest).toBeUndefined();
    const calls: string[] = [];
    const host = adapter(calls);
    const input = { repository: { url: URL_A }, baseBranch: "main", baseRevision: "b".repeat(40), branch: BRANCH, path: EVAL_WRAPPER_NODE_PATH, content: "x", title: "t", body: "" };
    expect((await host.evalWrapperPullRequest!.open(input as never, scope)).ref.id).toBe("3");
    for (const over of [{ path: "src/a.ts" }, { path: ".rovara/lessons.md" }, { branch: "main" }, { branch: "rovara/lessons-0123456789ab" }, { extra: 1 }]) {
      await expect(host.evalWrapperPullRequest!.open({ ...input, ...over } as never, scope), JSON.stringify(over)).rejects.toThrow();
    }
    expect(calls).toEqual([`open ${URL_A} ${EVAL_WRAPPER_NODE_PATH}`]);
    await host.evalWrapperPullRequest!.forBranch({ url: URL_A }, BRANCH, scope);
    expect(calls.at(-1)).toBe(`find ${BRANCH}`);
  });

  it("the fake host refuses what the real adapter refuses, and removes the branch it made when the pull request fails", async () => {
    const model = new FakeHostModel({ url: URL_A, id: "4242", fullName: "acme/app", webBase: "https://github.com" });
    const host = new FakeCodeHost(model);
    const base = model.headOf("main");
    const input = { repository: { url: URL_A }, baseBranch: "main", baseRevision: base, branch: BRANCH, path: EVAL_WRAPPER_PYTHON_PATH, content: "x", title: "t", body: "" } as EvalWrapperPullRequestInput;
    const fakeScope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as never;
    for (const over of [{ path: "src/a.ts" }, { branch: "main" }, { branch: "rovara/lessons-0123456789ab" }, { baseRevision: "c".repeat(40) }]) {
      await expect(host.evalWrapperPullRequest.open({ ...input, ...over } as EvalWrapperPullRequestInput, fakeScope), JSON.stringify(over)).rejects.toThrow();
    }
    expect([...model.branches.keys()]).toEqual(["main"]);
    vi.spyOn(model, "reconcile").mockImplementationOnce(() => { throw new Error("refused"); });
    await expect(host.evalWrapperPullRequest.open(input, fakeScope)).rejects.toThrow("refused");
    expect([...model.branches.keys()]).toEqual(["main"]);
    const opened = await host.evalWrapperPullRequest.open(input, fakeScope);
    expect(model.changeRequests).toHaveLength(1);
    expect(model.headOf("main")).toBe(base);
    expect(await host.evalWrapperPullRequest.forBranch({ url: URL_A }, BRANCH, fakeScope)).toEqual(opened.ref);
    await expect(host.evalWrapperPullRequest.forBranch({ url: URL_A }, "main", fakeScope)).rejects.toThrow();
    // Something at the path is never replaced.
    const other = new FakeHostModel({ url: URL_A, id: "4242", fullName: "acme/app", webBase: "https://github.com", initialFiles: { [EVAL_WRAPPER_PYTHON_PATH]: "mine" } });
    await expect(new FakeCodeHost(other).evalWrapperPullRequest.open({ ...input, baseRevision: other.headOf("main") }, fakeScope)).rejects.toThrow(EVAL_WRAPPER_PATH_TAKEN_MESSAGE);
    expect(other.changeRequests).toHaveLength(0);
  });
});
