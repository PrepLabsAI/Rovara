import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
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
    prHead: head, prTip: tip, prBaseRef: "main", staleCompare: false, headAfterFiles: "", mergeBase: base, failurePath: "", failureStatus: 404, rate: false, missingMergeBase: false, allowed: true, allowedCompany: scope.orgId as string,
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      requests.push(path);
      let answer: Response;
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: state.rate ? { "retry-after": "30" } : {} });
      if (state.failurePath !== "" && (state.failurePath === "/pulls/1" ? path.endsWith(state.failurePath) : path.includes(state.failurePath))) answer = json({ message: state.rate ? "API rate limit exceeded" : "Not Found" }, state.failureStatus);
      else if (/\/pulls\/1\/files\?/.test(path)) { answer = json(state.files); if (state.files.length === 100) answer.headers.set("link", '</next>; rel="next"'); if (state.headAfterFiles !== "") state.prHead = state.headAfterFiles; }
      else if (path.endsWith("/pulls/1")) answer = json({ head: { sha: state.prHead }, base: { sha: state.prTip, ref: state.prBaseRef } });
      else if (path.includes("/compare/")) answer = json(state.missingMergeBase ? {} : { merge_base_commit: { sha: state.staleCompare && path.includes(state.prTip) ? tip : state.mergeBase } });
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
  it.each([`/git/trees/${head}`, `/git/trees/${base}`, "/compare/", "/pulls/1"])("leaves metadata unknown for failed %s", async failurePath => {
    const w = await world();
    w.state.failurePath = failurePath;
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
  });
  it.each(["prHead", "prBaseRef", "mergeBase"] as const)("leaves metadata unknown for malformed %s", async key => {
    const w = await world(); w.state[key] = key === "prBaseRef" ? "" : "main";
    await expect(w.provider.getPullRequestFileRevisions(repository.url, 1, scope)).rejects.toBeDefined();
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
  });
  it("does not trust a truncated tree and reports incomplete instructions", async () => {
    const w = await world(); w.state.truncated = true;
    expect((await w.host.changedFiles(w.ref, 1, scope)).files[0]?.entry).toBeUndefined();
    expect((await w.host.instructionFiles!(repository, head, scope)).complete).toBe(false);
  });
  it.each([403, 429])("surfaces HTTP %s rate limits on tree, compare and files reads", async status => {
    for (const path of [`/git/trees/${head}`, `/git/trees/${base}`, "/compare/", "/files?", "/pulls/1", "/installation", "/access_tokens"]) {
      const w = await world(); Object.assign(w.state, { failurePath: path, failureStatus: status, rate: true });
      await expect(w.host.changedFiles(w.ref, 1, scope)).rejects.toBeInstanceOf(HostRateLimitError);
    }
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

it.each([
  ["unknown", true, true], ["added", true, true], ["added", false, false],
  ["removed", true, true], ["removed", false, false],
  ["modified", false, true], ["modified", true, false],
  ["renamed", false, true], ["renamed", true, false],
] as const)("omits inconsistent %s types (head %s, base %s)", async (status, hasHead, hasBase) => {
  const w = await world();
  w.state.files = [file("new", status, status === "renamed" ? "old" : undefined)];
  w.state.headEntries = hasHead ? [entry("new")] : [];
  w.state.baseEntries = hasBase ? [entry(status === "renamed" ? "old" : "new")] : [];
  const page = await w.host.changedFiles(w.ref, 1, scope);
  expect(page.files).toHaveLength(1);
  expect(page.files[0]?.entry).toBeUndefined();
});

it.each([403, 429])("preserves existing provider errors for HTTP %s rate limits", async status => {
  for (const failurePath of ["/installation", "/access_tokens", "/git/trees/", "/files?"]) {
    const w = await world(); Object.assign(w.state, { failurePath, failureStatus: status, rate: true });
    const read = failurePath === "/files?"
      ? w.provider.listPullRequestFiles(repository.url, 1, { page: 1 }, scope)
      : failurePath === "/git/trees/" ? w.provider.listTreeAtCommit(repository.url, head, scope)
      : w.provider.getFileAtCommit(repository.url, "AGENTS.md", head, scope);
    await expect(read).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  }
});

it.each([403, 429])("keeps instruction-only HTTP %s rate limits neutral, including warm authorization", async status => {
  for (const failurePath of ["/installation", "/access_tokens", "/git/trees/"]) {
    const w = await world(); Object.assign(w.state, { failurePath, failureStatus: status, rate: true });
    await expect(w.host.instructionFiles!(repository, head, scope)).rejects.toBeInstanceOf(HostRateLimitError);
  }
  const w = await world();
  await w.host.instructionFiles!(repository, head, scope);
  Object.assign(w.state, { failurePath: "/installation", failureStatus: status, rate: true });
  await expect(w.host.instructionFiles!(repository, head, scope)).rejects.toBeInstanceOf(HostRateLimitError);
});

it("omits all types after a push during the files read and preserves pagination", async () => {
  const w = await world(); w.state.headAfterFiles = "e".repeat(40);
  w.state.files = Array.from({ length: 100 }, (_, i) => file(`file-${i}`, "added"));
  const page = await w.host.changedFiles(w.ref, 1, scope, { expectedHead: head });
  expect(page.files).toHaveLength(100);
  expect(page.files.every(file => file.entry === undefined)).toBe(true);
  expect(page.nextPage).toBe(2);
  expect(w.requests.some(path => path.includes("/git/trees/"))).toBe(false);
});
