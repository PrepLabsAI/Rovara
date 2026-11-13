import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { assertTwoCompanyIsolation } from "../../packages/testing/src/isolation/two-company.js";
import { GitHubFixtureProvider } from "../support/ports/github-fixture-provider.js";
import { HostRateLimitError, agentXError } from "@agentx/contracts";
import { FakeHostModel } from "@agentx/broker/fakes";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GitHubFixtureApi, GITHUB_ORG_SCOPE as scope, GITHUB_REPO_URL } from "../support/ports/github-fixture-api.js";

const repository = { url: GITHUB_REPO_URL };
const head = "a".repeat(40), base = "b".repeat(40), tip = "c".repeat(40);
const entry = (path: string, mode = "100644", type = "blob") => ({ path, mode, type, sha: "d".repeat(40) });
const file = (filename: string, status = "modified", previous_filename?: string) => ({ filename, status, additions: 1, deletions: 1, ...(previous_filename === undefined ? {} : { previous_filename }) });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } });

async function world() {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app" });
  const api = new GitHubFixtureApi(model);
  const state = {
    headEntries: [entry("AGENTS.md")], baseEntries: [entry("AGENTS.md")], files: [file("AGENTS.md")], truncated: false,
    prHead: head, prTip: tip, mergeBase: base, failurePath: "", failureStatus: 404, rate: false, missingMergeBase: false, allowed: true, allowedCompany: scope.orgId as string,
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      requests.push(path);
      let answer: Response;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: state.rate ? { "retry-after": "30" } : {} });
      if (state.failurePath !== "" && (state.failurePath === "/pulls/1" ? path.endsWith(state.failurePath) : path.includes(state.failurePath))) answer = json({ message: state.rate ? "API rate limit exceeded" : "Not Found" }, state.failureStatus);
      else if (/\/pulls\/1\/files\?/.test(path)) answer = json(state.files);
      else if (path.endsWith("/pulls/1")) answer = json({ head: { sha: state.prHead }, base: { sha: state.prTip } });
      else if (path.includes("/compare/")) answer = json(state.missingMergeBase ? {} : { merge_base_commit: { sha: state.mergeBase } });
      else if (path.includes("/git/trees/")) answer = json({ tree: path.includes(head) ? state.headEntries : state.baseEntries, truncated: state.truncated });
      else {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          if (!Buffer.isBuffer(chunk)) throw new Error("unexpected HTTP body chunk");
          chunks.push(chunk);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
        answer = await api.fetch(`https://api.github.com${path}`, { method: request.method ?? "GET", headers, ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks).toString() }) });
      }
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    now: () => Date.parse("2026-10-30T10:00:00Z"),
    requireInstallationBound: async orgId => { if (!state.allowed || orgId !== state.allowedCompany) throw agentXError("GITHUB_NOT_CONNECTED", "repository unavailable"); },
    fetchImplementation: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== "https://api.github.com") throw new Error("unexpected host");
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    },
  });
  const host = githubCodeHost(provider, { credentialRef: "github" });
  const ref = { repository, id: "1", url: `${GITHUB_REPO_URL}/pull/1` };
  return { host, provider, state, requests, ref };
}

describe("GitHub file details over local HTTP", () => {
  it("maps modes, uses the merge base and previous path, and never guesses unknown or directory types", async () => {
    const w = await world();
    w.state.headEntries = [entry("plain"), entry("legacy", "100664"), entry("exec", "100755"), entry("link", "120000"), entry("module", "160000", "commit"), entry("unknown", "100600"), entry("dir", "040000", "tree"), entry("renamed", "100755"), entry("added")];
    w.state.baseEntries = [entry("old", "120000"), entry("deleted"), ...w.state.headEntries.filter(e => !["renamed", "added"].includes(e.path))];
    w.state.files = [...w.state.headEntries.map(e => file(e.path)), file("deleted", "removed")];
    w.state.files[7] = file("renamed", "renamed", "old");
    const result = await w.host.changedFiles(w.ref, 1, scope);
    const types = Object.fromEntries(result.files.map(f => [f.path, f.entry]));
    expect(types).toEqual({ plain: { head: "file", base: "file" }, legacy: { head: "file", base: "file" }, exec: { head: "executable", base: "executable" }, link: { head: "symlink", base: "symlink" }, module: { head: "submodule", base: "submodule" }, unknown: undefined, dir: undefined, renamed: { head: "executable", base: "symlink" }, added: { head: "file", base: "none" }, deleted: { head: "none", base: "file" } });
    expect(w.requests.some(p => p.includes(`/compare/${tip}...${head}`))).toBe(true);
    expect(w.requests.some(p => p.includes(`/git/trees/${base}`))).toBe(true);
    expect(w.requests.some(p => p.includes(`/git/trees/${tip}`))).toBe(false);
  });
  it("reuses two trees across pages and instruction reads with exact request counts", async () => {
    const w = await world();
    await w.host.changedFiles(w.ref, 1, scope);
    const cold = w.requests.length;
    await w.host.changedFiles(w.ref, 2, scope);
    expect(w.requests.filter(p => p.includes("/git/trees/"))).toHaveLength(2);
    expect(w.requests.length - cold).toBe(3);
    const before = w.requests.length;
    expect(await w.host.instructionFiles!(repository, head, scope)).toEqual({ files: [{ path: "AGENTS.md", type: "file" }], complete: true });
    expect(w.requests.length - before).toBe(1); // fresh installation authorization on cached read
    expect(cold).toBe(8); // installation, two permission-scoped token mints, five data reads
  });
  it.each([`/git/trees/${head}`, `/git/trees/${base}`, "/compare/", "/pulls/1"])("leaves metadata unknown for failed %s", async failurePath => {
    const w = await world();
    w.state.failurePath = failurePath;
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
  });
  it.each(["prHead", "prTip", "mergeBase"] as const)("leaves metadata unknown for malformed %s", async key => {
    const w = await world(); w.state[key] = "main";
    await expect(w.provider.getPullRequestFileRevisions(repository.url, 1, scope)).rejects.toBeDefined();
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
  });
  it("leaves metadata unknown when the compare omits its merge base", async () => {
    const w = await world(); w.state.missingMergeBase = true;
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
  });
  it("does not trust a truncated tree and reports incomplete instructions", async () => {
    const w = await world(); w.state.truncated = true;
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
    expect((await w.host.instructionFiles!(repository, head, scope)).complete).toBe(false);
  });
  it.each([403, 429])("surfaces HTTP %s rate limits on tree, compare and files reads", async status => {
    for (const path of ["/git/trees/", "/compare/", "/files?", "/pulls/1", "/installation", "/access_tokens"]) {
      const w = await world(); Object.assign(w.state, { failurePath: path, failureStatus: status, rate: true });
      await expect(w.host.changedFiles(w.ref, 1, scope)).rejects.toBeInstanceOf(HostRateLimitError);
    }
  });
  it("throws on instruction read failures and unknown modes instead of claiming completeness", async () => {
    const w = await world(); w.state.failurePath = "/git/trees/";
    await expect(w.host.instructionFiles!(repository, head, scope)).rejects.toBeDefined();
    w.state.failurePath = ""; w.state.headEntries = [entry("AGENTS.md", "100600")];
    await expect(w.host.instructionFiles!(repository, head, scope)).rejects.toBeDefined();
  });
  it("bounds instruction results, validates limits, and lists only matching entry paths", async () => {
    const w = await world();
    w.state.headEntries = [entry("nested/Claude.md", "100755"), entry(".agents/link", "120000"), entry(".cursor/module", "160000", "commit"), entry("notes.md", "120000"), entry("AGENTS.md.bak"), entry(".cursor", "040000", "tree"), entry(".cursor/rules", "040000", "tree")];
    expect((await w.host.instructionFiles!(repository, head, scope)).files).toEqual([
      { path: "nested/Claude.md", type: "executable" }, { path: ".agents/link", type: "symlink" }, { path: ".cursor/module", type: "submodule" },
    ]);
    expect(await w.host.instructionFiles!(repository, head, scope, { max: 0 })).toEqual({ files: [], complete: false });
    expect((await w.host.instructionFiles!(repository, head, scope, { max: 3 })).complete).toBe(true);
    for (const max of [NaN, -1, Infinity, 0.5]) await expect(w.host.instructionFiles!(repository, head, scope, { max })).rejects.toBeDefined();
    await expect(w.host.instructionFiles!(repository, "main", scope)).rejects.toBeDefined();
  });
  it("isolates cache entries by company and rechecks revoked access even on a warm cache", async () => {
    const w = await world();
    await w.host.instructionFiles!(repository, head, scope);
    const other = { orgId: "org_bbbbbbbbbbbbbbbbbbbb" };
    await expect(w.host.instructionFiles!(repository, head, other)).rejects.toBeDefined();
    await expect(w.host.changedFiles(w.ref, 1, other)).rejects.toBeDefined();
    w.state.allowedCompany = other.orgId; w.state.headEntries = [entry("other/AGENTS.md")];
    expect((await w.host.instructionFiles!(repository, head, other)).files[0]?.path).toBe("other/AGENTS.md");
    w.state.allowed = false;
    await expect(w.host.instructionFiles!(repository, head, other)).rejects.toBeDefined();
  });
  it("resolves a tree near the host limit with the default 500 instruction cap", async () => {
    const w = await world();
    w.state.headEntries = Array.from({ length: 99_000 }, (_, i) => entry(i < 500 ? `pkg${i}/AGENTS.md` : `src/${i}.ts`));
    const result = await w.host.instructionFiles!(repository, head, scope);
    expect(result.files).toHaveLength(500); expect(result.complete).toBe(true);
    expect((await w.host.instructionFiles!(repository, head, scope, { max: 499 })).complete).toBe(false);
  });
});

it("isolates the shared GitHub tree cache with the two-company kit", async () => {
  const w = await world();
  await assertTwoCompanyIsolation({ surfaces: [{
    kind: "list", name: "GitHub cached instructions and changed entries",
    async plant(company) {
      w.state.allowedCompany = company.orgId;
      w.state.headEntries = [entry(`${company.canary}/AGENTS.md`)];
      await w.host.instructionFiles!(repository, head, company.scope);
    },
    async observe(company) {
      w.state.allowedCompany = company.orgId;
      w.state.headEntries = [entry(`${company.canary}/AGENTS.md`)];
      w.state.files = [file(`${company.canary}/AGENTS.md`, "added")];
      const changed = await w.host.changedFiles(w.ref, 1, company.scope);
      expect(changed.files[0]?.entry).toEqual({ head: "file", base: "none" });
      return { changed, instructions: await w.host.instructionFiles!(repository, head, company.scope) };
    },
  }] });
});

it("resolves a full 1000-file port page against a large tree in bounded time", async () => {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app" });
  const provider = new GitHubFixtureProvider(model);
  model.commit("main", Object.fromEntries(Array.from({ length: 99_000 }, (_, i) => [`src/${i}`, "old"])));
  model.commit("feature", Object.fromEntries(Array.from({ length: 1_000 }, (_, i) => [`src/${i}`, "new"])));
  const { cr } = model.reconcile({ sourceBranch: "feature", targetBranch: "main", title: "large diff" });
  provider.listPullRequestFiles = async () => ({ files: Array.from({ length: 1_000 }, (_, i) => file(`src/${i}`)) });
  const host = githubCodeHost(provider, { credentialRef: "github" });
  const result = await host.changedFiles({ repository, id: cr.id, url: model.crUrl(cr.id) }, 1, scope);
  expect(result.files).toHaveLength(1_000);
  expect(result.files.every(f => f.entry?.head === "file" && f.entry.base === "file")).toBe(true);
});

it("refuses duplicate tree entries and never guesses a descendant below a symlink", async () => {
  const w = await world();
  w.state.headEntries = [entry("AGENTS.md"), entry("AGENTS.md")];
  await expect(w.host.instructionFiles!(repository, head, scope)).rejects.toBeDefined();
  w.state.headEntries = [entry("folder", "120000")]; w.state.files = [file("folder/AGENTS.md")];
  expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
});

it("rejects malformed revisions and mismatched mode/type combinations", async () => {
  const w = await world();
  w.state.headEntries = [entry("AGENTS.md", "100644", "commit")];
  expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
  await expect(w.host.instructionFiles!(repository, head, scope)).rejects.toBeDefined();
  await expect(w.provider.getPullRequestFileRevisions(repository.url, 0, scope)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
});

it("evicts immutable trees beyond the bounded cache capacity", async () => {
  const w = await world();
  for (let i = 0; i < 9; i += 1) await w.host.instructionFiles!(repository, i.toString(16).padStart(40, "0"), scope);
  const before = w.requests.filter(p => p.includes("/git/trees/")).length;
  await w.host.instructionFiles!(repository, "0".repeat(40), scope);
  expect(w.requests.filter(p => p.includes("/git/trees/")).length - before).toBe(1);
});

it("does not retain truncated trees and throws for malformed tree rows", async () => {
  const w = await world(); w.state.truncated = true;
  expect((await w.host.instructionFiles!(repository, head, scope)).complete).toBe(false);
  w.state.truncated = false;
  expect((await w.host.instructionFiles!(repository, head, scope)).complete).toBe(true);
  const other = await world();
  other.state.headEntries = [null as unknown as ReturnType<typeof entry>];
  await expect(other.host.instructionFiles!(repository, head, scope)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
});

it("preserves providers that implement neither optional addition", async () => {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app" });
  model.commit("feature", { "a": "new" });
  const { cr } = model.reconcile({ sourceBranch: "feature", targetBranch: "main", title: "legacy" });
  const provider = new GitHubFixtureProvider(model);
  const old = new Proxy(provider, { get(target, property) {
    if (property === "listTreeAtCommit" || property === "getPullRequestFileRevisions") return undefined;
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } });
  const host = githubCodeHost(old, { credentialRef: "github" });
  expect(typeof host.instructionFiles).toBe("undefined");
  expect((await host.changedFiles({ repository, id: cr.id, url: model.crUrl(cr.id) }, 1, scope)).files[0]?.entry).toBeUndefined();
});

it("keeps repository and revision identities in the cache key", async () => {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app" });
  const provider = new GitHubFixtureProvider(model);
  provider.checkRepository = async () => undefined;
  provider.listTreeAtCommit = async (url, revision) => ({ truncated: false, entries: [entry(`${url.endsWith("other") ? "other" : "app"}/${revision}/AGENTS.md`)] });
  const host = githubCodeHost(provider, { credentialRef: "github" });
  await expect(host.instructionFiles!(repository, "main", scope)).rejects.toBeDefined();
  for (const url of [repository.url, "https://github.com/acme/other"]) for (const revision of [head, base]) {
    expect((await host.instructionFiles!({ url }, revision, scope)).files[0]?.path).toBe(`${url.endsWith("other") ? "other" : "app"}/${revision}/AGENTS.md`);
  }
});

it("returns exactly the default maximum and marks one extra match incomplete", async () => {
  const w = await world();
  w.state.headEntries = Array.from({ length: 501 }, (_, i) => entry(`pkg${i}/AGENTS.md`));
  const result = await w.host.instructionFiles!(repository, head, scope);
  expect(result.files).toHaveLength(500); expect(result.complete).toBe(false);
});

it("counts a cold instruction read including installation and token setup", async () => {
  const w = await world();
  expect((await w.host.instructionFiles!(repository, head, scope)).complete).toBe(true);
  expect(w.requests).toHaveLength(3);
});
