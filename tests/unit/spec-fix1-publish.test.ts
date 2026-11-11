// The BROKER builds the spec commit through GitHub; nothing of the builder's workspace is in it, and the broker checks the commit adds exactly the spec's files before a pull request opens.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SpecFile } from "@agentx/contracts";
import { GitHubSpecError, githubSpecClient } from "../../packages/broker/src/plugins/code-host/github/spec-git-client.js";
import { SpecPublishError, assertSpecPaths, gitBlobSha, publishSpec, type SpecGitClient, type SpecPullRequestOpener } from "../../packages/broker/src/core/spec/publish.js";

const BASE = "b".repeat(40);
const BRANCH = "agentx/11111111-1111-4111-a111-111111111111";
const FOLDER = ".kiro/specs/reset/";
const FILES: SpecFile[] = [
  { path: `${FOLDER}requirements.md`, content: "- 1.1 WHEN a THE SYSTEM SHALL b\n" },
  { path: `${FOLDER}tasks.md`, content: "- [ ] 1. t\n" },
];
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** A small model of GitHub's Git Data API: trees are path -> blob maps, a tree built `on` a base keeps everything the base had (as GitHub's base_tree does). */
function fakeGit(options: { baseFiles?: Record<string, string>; hooks?: Partial<Record<"createBlob" | "createTree" | "compare" | "getCommit", (value: never) => unknown>> } = {}) {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>();
  const commits = new Map<string, { tree: string; parents: string[] }>();
  const branches = new Map<string, string>();
  const calls: string[] = [];
  const baseTree = new Map<string, string>(Object.entries(options.baseFiles ?? { "rules/AGENTS.md": gitBlobSha("be careful\n") }));
  trees.set("t".repeat(40), baseTree);
  commits.set(BASE, { tree: "t".repeat(40), parents: [] });
  const git: SpecGitClient = {
    branchContains: async () => true,
    getCommit: async (sha) => { calls.push("getCommit"); const found = commits.get(sha); if (found === undefined) throw new Error("404"); return (options.hooks?.getCommit?.(sha as never) as typeof found | undefined) ?? found; },
    getBranch: async (branch) => branches.get(branch),
    createBlob: async (content) => { calls.push("createBlob"); const sha = gitBlobSha(content); blobs.set(sha, content); return (options.hooks?.createBlob?.(content as never) as string | undefined) ?? sha; },
    createTree: async (base, entries) => {
      calls.push(`createTree:${base}`);
      const parent = trees.get(base); if (parent === undefined) throw new Error("no base tree");
      const next = new Map(parent);
      for (const entry of entries) next.set(entry.path, entry.sha);
      const dropped = options.hooks?.createTree?.(next as never) as Map<string, string> | undefined;
      const final = dropped ?? next;
      const id = sha1(`tree${JSON.stringify([...final.entries()])}`);
      trees.set(id, final);
      return id;
    },
    createCommit: async ({ tree, parent, message }) => { calls.push(`createCommit:${parent}`); const id = sha1(`commit${tree}${parent}${message}`); commits.set(id, { tree, parents: [parent] }); return id; },
    createBranch: async (branch, sha) => { calls.push("createBranch"); branches.set(branch, sha); },
    deleteBranch: async (branch) => { calls.push("deleteBranch"); branches.delete(branch); },
    compare: async (base, head) => {
      calls.push("compare");
      const from = trees.get(commits.get(base)!.tree)!; const to = trees.get(commits.get(head)!.tree)!;
      const files: Array<{ path: string; status: string; sha: string }> = [];
      for (const [path, sha] of to) { if (!from.has(path)) files.push({ path, status: "added", sha }); else if (from.get(path) !== sha) files.push({ path, status: "modified", sha }); }
      for (const [path, sha] of from) if (!to.has(path)) files.push({ path, status: "removed", sha });
      let count = 0; for (let cursor: string | undefined = head; cursor !== undefined && cursor !== base; cursor = commits.get(cursor)?.parents[0]) count += 1;
      const answered = { complete: true, commits: count, files };
      return (options.hooks?.compare?.(answered as never) as typeof answered | undefined) ?? answered;
    },
  };
  return { git, blobs, trees, commits, branches, calls };
}
function opener(head: () => string) {
  const closed: number[] = [];
  const open = vi.fn(async () => ({ number: 7, url: "https://github.com/acme/meta/pull/7", reconciled: false }));
  const pullRequests: SpecPullRequestOpener = { open, read: async () => ({ head: head(), title: "Rovara spec: Reset", body: "b" }), close: async (number) => { closed.push(number); } };
  return { pullRequests, closed, open };
}
const input = (overrides: Record<string, unknown> = {}) => ({ files: FILES, folder: FOLDER, baseCommit: BASE, baseBranch: "main", branch: BRANCH, title: "Rovara spec: Reset", body: "b", forbiddenFolders: [] as string[], ...overrides });

describe("the broker makes the commit", () => {
  it("creates the blobs from its own files, a tree on the base commit's own tree, a commit whose only parent is the base, and the branch, then opens the pull request", async () => {
    const g = fakeGit();
    const o = opener(() => [...g.branches.values()][0]!);
    const out = await publishSpec({ git: g.git, pullRequests: o.pullRequests }, input());
    expect(g.calls.filter((call) => call === "createBlob")).toHaveLength(2);
    expect(g.calls).toContain(`createTree:${"t".repeat(40)}`);
    expect(g.calls).toContain(`createCommit:${BASE}`);
    expect(g.branches.get(BRANCH)).toBe(out.commit);
    expect(g.commits.get(out.commit)!.parents).toEqual([BASE]);
    expect([...g.trees.get(g.commits.get(out.commit)!.tree)!.keys()].sort()).toEqual([`${FOLDER}requirements.md`, `${FOLDER}tasks.md`, "rules/AGENTS.md"]);
    expect(o.open).toHaveBeenCalledWith(expect.objectContaining({ headBranch: BRANCH, baseBranch: "main" }));
    expect(out).toMatchObject({ number: 7, url: "https://github.com/acme/meta/pull/7" });
  });
  it("opens nothing, and deletes the branch, when the commit changes more than the spec (a file of the base is gone)", async () => {
    const g = fakeGit({ hooks: { createTree: ((tree: Map<string, string>) => { const copy = new Map(tree); copy.delete("rules/AGENTS.md"); return copy; }) } });
    const o = opener(() => [...g.branches.values()][0]!);
    await expect(publishSpec({ git: g.git, pullRequests: o.pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
    expect(o.open).not.toHaveBeenCalled();
    expect(g.branches.size).toBe(0);
  });
  it("opens nothing when a file of the base is changed, a file is not added, or GitHub shows other files than the spec's", async () => {
    for (const name of ["modified", "extra"] as const) {
      const g = fakeGit({ baseFiles: { "rules/AGENTS.md": gitBlobSha("x\n"), [`${FOLDER}requirements.md`]: gitBlobSha("old\n") } });
      if (name === "extra") g.trees.get("t".repeat(40))!.delete(`${FOLDER}requirements.md`);
      const hooks = name === "extra" ? { compare: ((answer: { files: unknown[] }) => ({ ...answer, files: [...answer.files, { path: "other.md", status: "added", sha: "e".repeat(40) }] })) as never } : {};
      const withHooks = fakeGit({ baseFiles: Object.fromEntries(g.trees.get("t".repeat(40))!), hooks });
      const o = opener(() => [...withHooks.branches.values()][0]!);
      await expect(publishSpec({ git: withHooks.git, pullRequests: o.pullRequests }, input()), name).rejects.toMatchObject({ reason: "verification" });
      expect(o.open, name).not.toHaveBeenCalled();
    }
  });
  it("opens nothing when a blob's hash is not the hash of the broker's own content", async () => {
    const wrongBlob = fakeGit({ hooks: { createBlob: (() => "f".repeat(40)) } });
    await expect(publishSpec({ git: wrongBlob.git, pullRequests: opener(() => "x").pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
    const g = fakeGit({ hooks: { compare: ((answer: { files: Array<{ sha: string }> }) => ({ ...answer, files: answer.files.map((file) => ({ ...file, sha: "d".repeat(40) })) })) } });
    const o = opener(() => [...g.branches.values()][0]!);
    await expect(publishSpec({ git: g.git, pullRequests: o.pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
    expect(o.open).not.toHaveBeenCalled();
  });
  it("opens nothing when the list of changes is cut, or the commit sits on more than the base", async () => {
    for (const patch of [{ complete: false }, { commits: 2 }]) {
      const g = fakeGit({ hooks: { compare: ((answer: object) => ({ ...answer, ...patch })) } });
      const o = opener(() => [...g.branches.values()][0]!);
      await expect(publishSpec({ git: g.git, pullRequests: o.pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
      expect(o.open).not.toHaveBeenCalled();
    }
  });
  it("opens nothing when the commit has another parent than the pinned base", async () => {
    const g = fakeGit({ hooks: { getCommit: ((sha: string) => (sha === BASE ? undefined : { tree: "t".repeat(40), parents: ["e".repeat(40)] })) } });
    const o = opener(() => [...g.branches.values()][0]!);
    await expect(publishSpec({ git: g.git, pullRequests: o.pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
    expect(o.open).not.toHaveBeenCalled();
  });
  it("closes a pull request whose head is not the verified commit", async () => {
    const g = fakeGit();
    const o = opener(() => "9".repeat(40));
    await expect(publishSpec({ git: g.git, pullRequests: o.pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
    expect(o.closed).toEqual([7]);
  });
  it("reuses a branch left by a cut-short earlier try only after verifying it again, and deletes a branch that does not verify", async () => {
    const first = fakeGit();
    const firstOut = await publishSpec({ git: first.git, pullRequests: opener(() => [...first.branches.values()][0]!).pullRequests }, input());
    const createdBefore = first.calls.filter((call) => call === "createBlob").length;
    const again = await publishSpec({ git: first.git, pullRequests: opener(() => [...first.branches.values()][0]!).pullRequests }, input());
    expect(again.commit).toBe(firstOut.commit);
    expect(first.calls.filter((call) => call === "createBlob")).toHaveLength(createdBefore);
    const planted = fakeGit();
    const evil = sha1("evil"); planted.commits.set(evil, { tree: "t".repeat(40), parents: [BASE] }); planted.branches.set(BRANCH, evil);
    const o = opener(() => evil);
    await expect(publishSpec({ git: planted.git, pullRequests: o.pullRequests }, input())).rejects.toMatchObject({ reason: "verification" });
    expect(planted.branches.has(BRANCH)).toBe(false);
    expect(o.open).not.toHaveBeenCalled();
  });
  it("says a GitHub failure is transient (try again later) and a refusal is not", async () => {
    const g = fakeGit(); g.git.createBlob = async () => { throw new GitHubSpecError(502); };
    const error = await publishSpec({ git: g.git, pullRequests: opener(() => "x").pullRequests }, input()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SpecPublishError);
    expect(error).toMatchObject({ reason: "github", transient: true });
    expect(String((error as Error).message)).not.toContain("secret-detail");
  });
});

describe("what a spec publication may write", () => {
  const refuse = (files: SpecFile[], folder = FOLDER, forbidden: string[] = []) => expect(() => assertSpecPaths(files, folder, forbidden)).toThrow(SpecPublishError);
  it("accepts the spec's own files in its folder", () => { expect(() => assertSpecPaths(FILES, FOLDER, [])).not.toThrow(); });
  it.each([
    ["outside the folder", [{ path: "other/x.md", content: "x" }]], ["a rules file", [{ path: `${FOLDER}AGENTS.md`, content: "x" }]], ["CODEOWNERS", [{ path: `${FOLDER}CODEOWNERS`, content: "x" }]],
    ["under .git", [{ path: `${FOLDER}.git/config`, content: "x" }]], ["a dot-dot", [{ path: `${FOLDER}../x.md`, content: "x" }]], ["a duplicate in another case", [{ path: `${FOLDER}A.md`, content: "x" }, { path: `${FOLDER}a.md`, content: "y" }]],
    ["over the file limit", [{ path: `${FOLDER}a.md`, content: "x".repeat(65 * 1024) }]], ["none", []],
  ] as Array<[string, SpecFile[]]>)("refuses %s", (_name, files) => { refuse(files); });
  it("refuses a folder that is a rules, steering, config or automation folder, the root, or one of the project's own knowledge folders", () => {
    refuse([{ path: ".github/workflows/x.md", content: "x" }], ".github/workflows/");
    refuse([{ path: ".rovara/x.md", content: "x" }], ".rovara/");
    refuse([{ path: "x.md", content: "x" }], "");
    refuse([{ path: "design/rules/x.md", content: "x" }], "design/rules/", ["design/rules"]);
  });
});

describe("the GitHub client", () => {
  function recorder(answers: Array<{ status: number; body?: unknown }>) {
    const requests: Array<{ url: string; method: string; body?: unknown; headers: Record<string, string> }> = [];
    let i = 0;
    const fetchImplementation = (async (url: string, init: { method: string; body?: string; headers: Record<string, string> }) => {
      requests.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }) });
      const answer = answers[Math.min(i++, answers.length - 1)]!;
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => JSON.stringify(answer.body ?? {}) };
    }) as unknown as typeof fetch;
    return { requests, client: githubSpecClient({ repository: { owner: "acme", name: "meta" }, token: "TOKEN", fetchImplementation }) };
  }
  it("builds the commit with base_tree and one parent, mode 100644 blobs, and a refs/heads ref", async () => {
    const r = recorder([{ status: 201, body: { sha: "1".repeat(40) } }, { status: 201, body: { sha: "2".repeat(40) } }, { status: 201, body: { sha: "3".repeat(40) } }, { status: 201, body: {} }]);
    await r.client.createBlob("hi");
    await r.client.createTree("a".repeat(40), [{ path: "x/y.md", sha: "1".repeat(40) }]);
    await r.client.createCommit({ message: "m", tree: "2".repeat(40), parent: BASE });
    await r.client.createBranch(BRANCH, "3".repeat(40));
    expect(r.requests.map((request) => [request.method, request.url.replace("https://api.github.com/repos/acme/meta", "")])).toEqual([["POST", "/git/blobs"], ["POST", "/git/trees"], ["POST", "/git/commits"], ["POST", "/git/refs"]]);
    expect(r.requests[0]!.body).toEqual({ content: "hi", encoding: "utf-8" });
    expect(r.requests[1]!.body).toEqual({ base_tree: "a".repeat(40), tree: [{ path: "x/y.md", mode: "100644", type: "blob", sha: "1".repeat(40) }] });
    expect(r.requests[2]!.body).toEqual({ message: "m", tree: "2".repeat(40), parents: [BASE] });
    expect(r.requests[3]!.body).toEqual({ ref: `refs/heads/${BRANCH}`, sha: "3".repeat(40) });
    expect(r.requests.every((request) => request.headers["authorization"] === "Bearer TOKEN")).toBe(true);
  });
  it("reads a comparison's files with their blob hashes, and says a full page may be cut", async () => {
    const r = recorder([{ status: 200, body: { total_commits: 1, files: [{ filename: "a.md", status: "added", sha: "1".repeat(40) }] } }]);
    expect(await r.client.compare(BASE, "c".repeat(40))).toEqual({ complete: true, commits: 1, files: [{ path: "a.md", status: "added", sha: "1".repeat(40) }] });
    const full = recorder([{ status: 200, body: { total_commits: 1, files: Array.from({ length: 100 }, (_, index) => ({ filename: `f${String(index)}`, status: "added", sha: "1".repeat(40) })) } }]);
    expect((await full.client.compare(BASE, "c".repeat(40))).complete).toBe(false);
  });
  it("answers undefined for a missing branch, fails with a fixed sentence (no GitHub text) on an error, and refuses a non-hash answer", async () => {
    expect(await recorder([{ status: 404 }]).client.getBranch(BRANCH)).toBeUndefined();
    const failing = recorder([{ status: 500, body: { message: "secret-detail" } }]);
    await expect(failing.client.createBlob("x")).rejects.toThrow("GitHub answered 500");
    await expect(recorder([{ status: 201, body: { sha: "not-a-sha" } }]).client.createBlob("x")).rejects.toThrow();
  });
  it("lists a directory and reads a file at a commit, bounded", async () => {
    const dir = recorder([{ status: 200, body: [{ name: "001-a", type: "dir" }, { name: "README.md", type: "file" }] }]);
    expect(await dir.client.listDirectory("specs", BASE)).toEqual([{ name: "001-a", type: "dir" }, { name: "README.md", type: "file" }]);
    expect(dir.requests[0]!.url).toContain(`/contents/specs?ref=${BASE}`);
    const file = recorder([{ status: 200, body: { type: "file", encoding: "base64", size: 3, content: Buffer.from("abc").toString("base64") } }]);
    expect(await file.client.readFile("a.md", BASE, 10)).toBe("abc");
    const big = recorder([{ status: 200, body: { type: "file", encoding: "base64", size: 999, content: "" } }]);
    expect(await big.client.readFile("a.md", BASE, 10)).toBeUndefined();
  });
});
