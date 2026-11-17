// Wiki W0 (DEC 254zh): the GitHub adapter's three read-only listings for the free file map (whole tree, one directory, commit counts), over a loopback server. Listings only: no file content is requested.
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { agentXError } from "@agentx/contracts";
import { FakeHostModel } from "@agentx/broker/fakes";
import { GitHubAppCredentialProvider } from "../../packages/broker/src/plugins/code-host/github/client.js";
import { githubCodeHost } from "../../packages/broker/src/plugins/code-host/github/index.js";
import { GitHubFixtureApi, GITHUB_ORG_SCOPE as scope, GITHUB_REPO_URL } from "../support/ports/github-fixture-api.js";

const repository = { url: GITHUB_REPO_URL };
const head = "a".repeat(40);
const entry = (path: string, mode = "100644", type = "blob") => ({ path, mode, type, sha: "d".repeat(40) });
const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))); } });

async function world() {
  const model = new FakeHostModel({ url: GITHUB_REPO_URL, id: "4242", fullName: "acme/app" });
  const api = new GitHubFixtureApi(model);
  const state = {
    tree: [entry("src", "040000", "tree"), entry("src/a.ts"), entry("link", "120000"), entry("sub", "160000", "commit")], truncated: false,
    directory: [{ name: "a.ts", type: "file" }, { name: "lib", type: "dir" }] as Array<{ name: string; type: string }> | { type: string },
    commits: [] as Array<{ date: string }>, more: false, olderCommits: [{ date: "2025-01-01T00:00:00Z" }], status: 200, rate: false,
  };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      requests.push(path);
      let answer: Response;
      const json = (body: unknown, status = state.status, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: state.rate ? { "retry-after": "30", ...headers } : headers });
      if (path.includes("/git/trees/")) answer = json({ tree: state.tree, truncated: state.truncated });
      else if (/\/contents(\/|\?)/.test(path)) answer = json(state.directory);
      else if (path.includes("/commits?")) {
        const ever = !path.includes("since=");
        const list = ever ? state.olderCommits : state.commits;
        answer = json(list.map((c) => ({ commit: { committer: { date: c.date } } })), state.status, state.more && !ever ? { link: '</next>; rel="next"' } : {});
      } else {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
        answer = await api.fetch(`https://api.github.com${path}`, { method: request.method ?? "GET", headers, ...(chunks.length === 0 ? {} : { body: Buffer.concat(chunks).toString() }) });
      }
      response.writeHead(answer.status, Object.fromEntries(answer.headers));
      response.end(await answer.text());
    })().catch(() => { response.writeHead(500); response.end(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no port");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  let allowed = scope.orgId as string;
  const provider = new GitHubAppCredentialProvider({
    credentialRef: "github", appId: "5002502", getPrivateKey: async () => privateKey.export({ type: "pkcs8", format: "pem" }).toString(), now: () => Date.parse("2026-10-30T10:00:00Z"),
    requireInstallationBound: async (orgId) => { if (orgId !== allowed) throw agentXError("GITHUB_NOT_CONNECTED", "repository unavailable"); },
    fetchImplementation: async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== "https://api.github.com") throw new Error("unexpected host");
      return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
    },
  });
  return { host: githubCodeHost(provider, { credentialRef: "github" }), state, requests, deny: () => { allowed = "org_other"; } };
}

describe("GitHub adapter: the file map's reads", () => {
  it("lists a whole tree with kinds, and says complete only when GitHub did not cut it", async () => {
    const w = await world();
    expect(await w.host.repositoryTree!(repository, head, scope)).toEqual({ entries: [{ path: "src", kind: "dir" }, { path: "src/a.ts", kind: "file" }, { path: "link", kind: "symlink" }, { path: "sub", kind: "submodule" }], complete: true });
    w.state.truncated = true;
    expect((await w.host.repositoryTree!(repository, "c".repeat(40), scope)).complete).toBe(false);
    w.state.tree = [entry("x", "100644", "mystery")];
    w.state.truncated = false;
    await expect(w.host.repositoryTree!(repository, "b".repeat(40), scope)).rejects.toBeDefined();
    expect(w.requests.filter((p) => p.includes("/contents")).length).toBe(0);
  });

  it("lists one directory's children by name and kind, never reading a file", async () => {
    const w = await world();
    expect(await w.host.directoryEntries!(repository, "", head, scope)).toEqual({ entries: [{ name: "a.ts", kind: "file" }, { name: "lib", kind: "dir" }], complete: true });
    await w.host.directoryEntries!(repository, "src/lib", head, scope);
    expect(w.requests.some((p) => p.includes("/contents/src/lib?ref="))).toBe(true);
    expect(w.requests.some((p) => p.includes("raw"))).toBe(false);
    w.state.directory = Array.from({ length: 1000 }, (_, i) => ({ name: `f${String(i)}`, type: "file" }));
    expect((await w.host.directoryEntries!(repository, "big", head, scope)).complete).toBe(false);
  });

  it("refuses a directory read for a file, a bad path, a bad commit or an unknown entry type", async () => {
    const w = await world();
    w.state.directory = { type: "file" };
    await expect(w.host.directoryEntries!(repository, "a.ts", head, scope)).rejects.toBeDefined();
    w.state.directory = [{ name: "x", type: "weird" }];
    await expect(w.host.directoryEntries!(repository, "d", head, scope)).rejects.toBeDefined();
    for (const path of ["../x", "a//b", "a\\b", "./a"]) await expect(w.host.directoryEntries!(repository, path, head, scope)).rejects.toBeDefined();
    await expect(w.host.directoryEntries!(repository, "d", "main", scope)).rejects.toBeDefined();
  });

  it("counts commits since a time for a path from one page and reports when more follow", async () => {
    const w = await world();
    w.state.commits = [{ date: "2026-10-29T00:00:00Z" }, { date: "2026-10-01T00:00:00Z" }];
    expect(await w.host.commitActivity!(repository, head, scope, { since: "2026-08-01T00:00:00Z", path: "src", cap: 100 })).toEqual({ count: 2, capped: false, latestAt: "2026-10-29T00:00:00Z" });
    const asked = w.requests.filter((p) => p.includes("/commits?")).at(-1)!;
    expect(asked).toContain(`sha=${head}`);
    expect(asked).toContain("path=src");
    expect(asked).toContain("per_page=100");
    w.state.more = true;
    expect((await w.host.commitActivity!(repository, head, scope, { since: "2026-08-01T00:00:00Z", cap: 2 })).capped).toBe(true);
  });

  it("finds the newest commit that ever touched the path when the window holds none (two requests at most)", async () => {
    const w = await world();
    const before = w.requests.filter((p) => p.includes("/commits?")).length;
    expect(await w.host.commitActivity!(repository, head, scope, { since: "2026-08-01T00:00:00Z", path: "old", cap: 100 })).toEqual({ count: 0, capped: false, latestAt: "2025-01-01T00:00:00Z" });
    expect(w.requests.filter((p) => p.includes("/commits?")).length - before).toBe(2);
  });

  it("refuses bad inputs for the commit count", async () => {
    const w = await world();
    for (const bad of [{ cap: 0 }, { cap: 101 }, { cap: 1.5 }, { cap: 5, since: "not a time" }, { cap: 5, path: "../x" }, { cap: 5, path: "" }]) {
      await expect(w.host.commitActivity!(repository, head, scope, { since: "2026-08-01T00:00:00Z", ...bad })).rejects.toBeDefined();
    }
    await expect(w.host.commitActivity!(repository, "main", scope, { since: "2026-08-01T00:00:00Z", cap: 5 })).rejects.toBeDefined();
  });

  it("keeps the company binding on every one of the reads, and signals a rate limit with the neutral error", async () => {
    const w = await world();
    w.deny();
    await expect(w.host.repositoryTree!(repository, head, scope)).rejects.toBeDefined();
    await expect(w.host.directoryEntries!(repository, "", head, scope)).rejects.toBeDefined();
    await expect(w.host.commitActivity!(repository, head, scope, { since: "2026-08-01T00:00:00Z", cap: 5 })).rejects.toBeDefined();
    const limited = await world();
    limited.state.rate = true; limited.state.status = 403;
    await expect(limited.host.commitActivity!(repository, head, scope, { since: "2026-08-01T00:00:00Z", cap: 5 })).rejects.toMatchObject({ retryAt: expect.any(Number) });
  });
});
