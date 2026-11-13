// Item C1 (decision 59): the GitHub side of `CodeHost.commitFiles` and `deleteBranch`, copied from Cloud's lessons repo file lane. These tests run it against a small in-memory stand-in for GitHub's
// git data API, so the rules the code states in its header are proved by what GitHub would be asked: branch names, paths, a branch nobody has, a head that moved, a symbolic link.
import { describe, expect, it } from "vitest";
import { commitFilesOn, deleteBranchOn, checkedRepositoryPath, type GithubWriteContext } from "../../packages/core/src/plugins/code-host/github/commit-files.js";
import { COMMIT_CONFLICT_MESSAGE, COMMIT_SYMLINK_MESSAGE } from "@rovara-code/contracts";

type Entry = { type: "file"; text: string } | { type: "symlink" } | { type: "dir" };
interface Commit { tree: Map<string, Entry>; parent?: string }

/** A repository as GitHub's git data API shows it: commits, branches, blobs and trees, and the requests made. */
class FakeGitHub {
  readonly commits = new Map<string, Commit>();
  readonly branches = new Map<string, string>();
  readonly blobs = new Map<string, string>();
  readonly trees = new Map<string, Map<string, Entry>>();
  readonly requests: string[] = [];
  private counter = 0;
  /** A push lands on the branch between the caller's read and the move of the branch. */
  racePush: ((branch: string) => void) | undefined;
  private sha(): string { this.counter += 1; return this.counter.toString(16).padStart(40, "0"); }
  seed(branch: string, files: Record<string, Entry | string>): string {
    const sha = this.sha();
    const tree = new Map<string, Entry>(Object.entries(files).map(([path, entry]) => [path, typeof entry === "string" ? { type: "file" as const, text: entry } : entry]));
    this.commits.set(sha, { tree, ...(this.branches.get(branch) === undefined ? {} : { parent: this.branches.get(branch)! }) });
    this.branches.set(branch, sha);
    return sha;
  }
  private json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/repos/acme/app", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    this.requests.push(`${method} ${path}`);
    let match: RegExpExecArray | null;
    if (method === "GET" && (match = /^\/git\/ref\/heads\/(.+)$/.exec(path)) !== null) {
      const head = this.branches.get(decodeURIComponent(match[1]!));
      return head === undefined ? this.json(404, { message: "Not Found" }) : this.json(200, { object: { sha: head } });
    }
    if (method === "GET" && (match = /^\/contents\/(.+)$/.exec(path)) !== null) {
      const ref = url.searchParams.get("ref")!;
      const commit = this.commits.get(this.branches.get(ref) ?? ref);
      const entry = commit?.tree.get(decodeURIComponent(match[1]!));
      if (entry === undefined) return this.json(404, { message: "Not Found" });
      if (entry.type === "symlink") return this.json(200, { type: "symlink", sha: this.sha(), content: "", encoding: "base64" });
      if (entry.type === "dir") return this.json(200, []);
      return this.json(200, { type: "file", sha: this.sha(), content: Buffer.from(entry.text, "utf8").toString("base64"), encoding: "base64" });
    }
    if (method === "POST" && path === "/git/refs") {
      const branch = String(body.ref).replace("refs/heads/", "");
      if (this.branches.has(branch)) return this.json(422, { message: "Reference already exists" });
      this.branches.set(branch, String(body.sha));
      return this.json(201, {});
    }
    if (method === "GET" && (match = /^\/git\/commits\/(.+)$/.exec(path)) !== null) {
      const tree = this.sha();
      this.trees.set(tree, new Map(this.commits.get(match[1]!)!.tree));
      return this.json(200, { tree: { sha: tree } });
    }
    if (method === "POST" && path === "/git/blobs") {
      const sha = this.sha();
      this.blobs.set(sha, Buffer.from(String(body.content), "base64").toString("utf8"));
      return this.json(201, { sha });
    }
    if (method === "POST" && path === "/git/trees") {
      const sha = this.sha();
      const tree = new Map(this.trees.get(String(body.base_tree)));
      for (const item of body.tree as Array<{ path: string; sha: string }>) tree.set(item.path, { type: "file", text: this.blobs.get(item.sha)! });
      this.trees.set(sha, tree);
      return this.json(201, { sha });
    }
    if (method === "POST" && path === "/git/commits") {
      const sha = this.sha();
      this.commits.set(sha, { tree: this.trees.get(String(body.tree))!, parent: (body.parents as string[])[0]! });
      return this.json(201, { sha });
    }
    if (method === "PATCH" && (match = /^\/git\/refs\/heads\/(.+)$/.exec(path)) !== null) {
      const branch = decodeURIComponent(match[1]!);
      this.racePush?.(branch);
      this.racePush = undefined;
      const current = this.branches.get(branch);
      if (current === undefined) return this.json(404, { message: "Not Found" });
      // `force: false`: only a fast-forward of the branch's current head.
      if (body.force !== false || this.commits.get(String(body.sha))?.parent !== current) return this.json(422, { message: "Update is not a fast forward" });
      this.branches.set(branch, String(body.sha));
      return this.json(200, {});
    }
    if (method === "DELETE" && (match = /^\/git\/refs\/heads\/(.+)$/.exec(path)) !== null) {
      return this.branches.delete(decodeURIComponent(match[1]!)) ? new Response(null, { status: 204 }) : this.json(422, { message: "Reference does not exist" });
    }
    return this.json(500, { message: `unexpected ${method} ${path}` });
  };
  context(): GithubWriteContext { return { fetch: this.fetch, owner: "acme", name: "app", token: ["fixture", "token"].join("-") }; }
}

const BRANCH = "rovara/lessons-0123456789ab";
const request = (over: Partial<Parameters<typeof commitFilesOn>[1]> = {}) => ({ branch: BRANCH, baseBranch: "main", message: "Lessons", fromBase: true, files: [{ path: ".rovara/lessons.md", content: "one\n" }], ...over });
const failure = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); } catch (error) { return (error as Error).message; } return "did not fail"; };

describe("commitFilesOn", () => {
  it("creates the branch at the base the caller read, writes only what differs, and never moves the base branch", async () => {
    const host = new FakeGitHub();
    const base = host.seed("main", { "README.md": "# demo\n" });
    const first = await commitFilesOn(host.context(), request({ baseRevision: base }));
    expect(first.changed).toBe(true);
    expect(host.branches.get(BRANCH)).toBe(first.revision);
    expect(host.branches.get("main")).toBe(base);
    expect(host.commits.get(first.revision)!.parent).toBe(base);
    expect(host.commits.get(first.revision)!.tree.get(".rovara/lessons.md")).toEqual({ type: "file", text: "one\n" });
    // The same text again, on the branch as it now is: nothing is written (no blob, tree or commit request).
    host.requests.length = 0;
    const same = await commitFilesOn(host.context(), request({ fromBase: false, expectedHead: first.revision, previous: [{ path: ".rovara/lessons.md", content: "one\n" }] }));
    expect(same).toEqual({ revision: first.revision, changed: false });
    expect(host.requests.filter((line) => line.startsWith("POST"))).toEqual([]);
  });

  it("refuses a branch name or a path outside the allowlist before GitHub is asked anything", async () => {
    const host = new FakeGitHub();
    host.seed("main", { "README.md": "x" });
    for (const branch of ["main", "agentx/0123456789ab", "rovara/lessons-0123456789abc", "rovara/lessons-0123456789AB", "rovara/lessons-../x"]) {
      expect(await failure(() => commitFilesOn(host.context(), request({ branch }))), branch).toContain("branch name is invalid");
    }
    for (const path of ["src/a.ts", ".rovara/other.md", "../AGENTS.md", ".rovara//lessons.md", "/AGENTS.md"]) {
      expect(await failure(() => commitFilesOn(host.context(), request({ files: [{ path, content: "x" }] }))), path).toMatch(/file path/);
    }
    expect(host.requests).toEqual([]);
    expect(() => checkedRepositoryPath("a/./b")).toThrow();
  });

  it("never writes to a branch that exists for a new change request: it is a conflict, and the branch is left as it is", async () => {
    const host = new FakeGitHub();
    const base = host.seed("main", { "README.md": "x" });
    host.branches.set(BRANCH, base);
    expect(await failure(() => commitFilesOn(host.context(), request()))).toContain(COMMIT_CONFLICT_MESSAGE);
    expect(host.branches.get(BRANCH)).toBe(base);
    // A creation that loses the race ("Reference already exists") is the same conflict.
    const racing = new FakeGitHub();
    racing.seed("main", { "README.md": "x" });
    const real = racing.fetch;
    let first = true;
    const context = { ...racing.context(), fetch: (async (input, init) => {
      if (first && init?.method === "POST" && (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).endsWith("/git/refs")) { first = false; racing.branches.set(BRANCH, racing.branches.get("main")!); }
      return real(input, init);
    }) as typeof fetch };
    expect(await failure(() => commitFilesOn(context, request()))).toContain(COMMIT_CONFLICT_MESSAGE);
  });

  it("refuses an update when the branch moved since the caller read it, or a file is not as it was read", async () => {
    const host = new FakeGitHub();
    const base = host.seed("main", { "README.md": "x" });
    const first = await commitFilesOn(host.context(), request({ baseRevision: base }));
    const moved = host.seed(BRANCH, { ".rovara/lessons.md": "one\n", "extra.txt": "pushed by a person" });
    const update = request({ fromBase: false, files: [{ path: ".rovara/lessons.md", content: "two\n" }] });
    expect(await failure(() => commitFilesOn(host.context(), { ...update, expectedHead: first.revision }))).toContain(COMMIT_CONFLICT_MESSAGE);
    expect(await failure(() => commitFilesOn(host.context(), { ...update, expectedHead: moved, previous: [{ path: ".rovara/lessons.md", content: "something else\n" }] }))).toContain(COMMIT_CONFLICT_MESSAGE);
    expect(await failure(() => commitFilesOn(host.context(), { ...update, expectedHead: moved, previous: [{ path: ".rovara/lessons.md", content: null }] }))).toContain(COMMIT_CONFLICT_MESSAGE);
    expect(host.branches.get(BRANCH)).toBe(moved);
    // A branch that is gone while an update expects it is a conflict, not a new branch.
    host.branches.delete(BRANCH);
    expect(await failure(() => commitFilesOn(host.context(), { ...update, expectedHead: moved }))).toContain(COMMIT_CONFLICT_MESSAGE);
    expect(host.branches.has(BRANCH)).toBe(false);
  });

  it("builds on the head it read only: a commit pushed before the branch is moved makes the move a conflict", async () => {
    const host = new FakeGitHub();
    const base = host.seed("main", { "README.md": "x" });
    const first = await commitFilesOn(host.context(), request({ baseRevision: base }));
    host.racePush = (branch) => { host.seed(branch, { ".rovara/lessons.md": "one\n", "pushed.txt": "mid-air" }); };
    const refused = await failure(() => commitFilesOn(host.context(), request({ fromBase: false, expectedHead: first.revision, files: [{ path: ".rovara/lessons.md", content: "two\n" }] })));
    expect(refused).toContain(COMMIT_CONFLICT_MESSAGE);
    // What the person pushed is still the head.
    expect(host.commits.get(host.branches.get(BRANCH)!)!.tree.get("pushed.txt")).toBeDefined();
  });

  it("refuses to write over a symbolic link, a directory, and anything else it cannot read as a file", async () => {
    const host = new FakeGitHub();
    host.seed("main", { "AGENTS.md": { type: "symlink" }, "CLAUDE.md": { type: "dir" } });
    expect(await failure(() => commitFilesOn(host.context(), request({ files: [{ path: "AGENTS.md", content: "pointer" }] })))).toContain(COMMIT_SYMLINK_MESSAGE);
    expect(await failure(() => commitFilesOn(host.context(), { ...request({ files: [{ path: "CLAUDE.md", content: "pointer" }] }), branch: "rovara/lessons-aaaaaaaaaaaa" }))).toContain("directory");
  });

  it("refuses a bad commit identity and a missing base branch", async () => {
    const host = new FakeGitHub();
    host.seed("main", { "README.md": "x" });
    expect(await failure(() => commitFilesOn(host.context(), request({ baseRevision: "abc" })))).toContain("commit identity is invalid");
    expect(await failure(() => commitFilesOn(host.context(), request({ baseBranch: "develop" })))).toContain("the base branch does not exist");
  });
});

describe("deleteBranchOn", () => {
  it("deletes only a lessons branch, says 'gone' for one that is not there, and fails for any other refusal", async () => {
    const host = new FakeGitHub();
    host.seed("main", { "README.md": "x" });
    host.branches.set(BRANCH, host.branches.get("main")!);
    expect(await deleteBranchOn(host.context(), BRANCH)).toBe("deleted");
    expect(await deleteBranchOn(host.context(), BRANCH)).toBe("gone");
    host.requests.length = 0;
    for (const branch of ["main", "agentx/0123456789ab", "rovara/lessons-x"]) expect(await failure(() => deleteBranchOn(host.context(), branch)), branch).toContain("branch name is invalid");
    expect(host.requests).toEqual([]);
    expect(host.branches.has("main")).toBe(true);
    const failing: GithubWriteContext = { ...host.context(), fetch: async () => new Response("{}", { status: 404 }) };
    expect(await failure(() => deleteBranchOn(failing, BRANCH))).toContain("HTTP 404");
  });
});
