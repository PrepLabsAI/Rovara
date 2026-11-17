import { describe, expect, it } from "vitest";
import { HostRateLimitError, WikiFileMapSchema, WIKI_MAP_LIMITS, type CodeHost, type HostScope } from "@agentx/contracts";
import { FakeCodeHost } from "../../packages/broker/src/plugins/fake/code-host.js";
import { FakeHostModel } from "../../packages/broker/src/plugins/fake/model.js";
import { computeWikiFileMap, mapRepository, WIKI_MAP_NO_LISTING, WIKI_MAP_REPO_UNAVAILABLE, type FileMapHost, type FileMapRepository } from "../../packages/broker/src/core/wiki/file-map.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const DAY = 86_400_000;
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa" } as HostScope;
const deps = { scope, now: () => NOW };
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();
const url = "https://github.com/acme/app.git";

function world(files: Record<string, string>, name = "app") {
  const model = new FakeHostModel({ url, id: "1", fullName: `acme/${name}`, initialFiles: files });
  const host = new FakeCodeHost(model);
  return { model, host, repo: (overrides: Partial<FileMapRepository> = {}): FileMapRepository => ({ name, url, defaultBranch: "main", host, ...overrides }) };
}
/** A host that counts every listing, directory and commit-count call. */
function counted(host: FileMapHost) {
  const calls = { tree: 0, dir: 0, activity: 0 };
  const wrapped: FileMapHost = {
    baseBranchHead: (...args) => host.baseBranchHead(...args),
    repositoryTree: host.repositoryTree === undefined ? undefined : (...args) => { calls.tree += 1; return host.repositoryTree!(...args); },
    directoryEntries: host.directoryEntries === undefined ? undefined : (...args) => { calls.dir += 1; return host.directoryEntries!(...args); },
    commitActivity: host.commitActivity === undefined ? undefined : (...args) => { calls.activity += 1; return host.commitActivity!(...args); },
  };
  return { wrapped, calls };
}
const SAMPLE = {
  "README.md": "# hi", "package.json": "{}", "package-lock.json": "{}", "src/a/one.ts": "x", "src/a/two.ts": "x", "src/a/three.ts": "x", "src/b/index.ts": "x", "src/b/b.ts": "x", "src/b/c.ts": "x",
  "tests/a.test.ts": "x", "docs/guide.md": "x", "web/app.py": "x", "web/b.py": "x", "web/c.py": "x", "vendor/lib/x.php": "x", "node_modules/p/i.js": "x", "dist/main.js": "x", "assets/logo.png": "x",
  ".env": "TOKEN=1", "config/server.pem": "k", "secrets/db.txt": "s",
};

describe("wiki file map: one repository", () => {
  it("counts files, languages, areas and tests, skips vendored, generated, lock and secret files, and pins one commit", async () => {
    const w = world(SAMPLE);
    const head = w.model.headOf("main");
    const map = await mapRepository(w.repo(), deps, NOW + 60_000, 100);
    expect(map.status).toBe("ok");
    expect(map.commit).toBe(head);
    expect(map.skipped).toEqual({ generated: 1, vendored: 2, lockfiles: 1, assets: 1, secret: 3 });
    expect(map.files).toBe(SAMPLE_COUNTED);
    expect(map.languages.map((l) => l.language)).toEqual(["TypeScript", "Python"]);
    expect(map.areas.map((a) => a.path).sort()).toEqual([".", "docs", "src/a", "src/b", "tests", "web"].sort());
    expect(map.testFolders).toEqual(["tests"]);
    expect(map.skippedFolders).toEqual(["dist", "node_modules", "vendor"]);
    expect(map.pages).toEqual({ repository: 1, modules: 3, modulesCapped: false });
  });

  it("never lists a secret-shaped path anywhere in the map (names, folders, chips)", async () => {
    const w = world({ ...SAMPLE, "src/a/.env.local": "x", "vendor/app/.env": "x", "dist/keys/id_rsa": "x", "billing/prod.tfvars": "x", "billing/a.ts": "x", "billing/b.ts": "x", "billing/c.ts": "x" });
    const map = await computeWikiFileMap({ project: "p", repositories: [w.repo()] }, deps);
    const text = JSON.stringify(map);
    for (const needle of [".env", "server.pem", "secrets", "id_rsa", "tfvars", "db.txt"]) expect(text, needle).not.toContain(needle);
    expect(map.repositories[0]!.skipped.secret).toBe(7);
  });

  it("measures activity per source area from the code host and ranks the busiest first", async () => {
    const w = world(SAMPLE);
    const base = w.model.headOf("main");
    w.model.commitTimes.set(base, iso(400));
    const c1 = w.model.commit("main", { "src/a/one.ts": "y" }); w.model.commitTimes.set(c1, iso(10));
    const c2 = w.model.commit("main", { "src/a/two.ts": "y" }); w.model.commitTimes.set(c2, iso(5));
    const c3 = w.model.commit("main", { "src/b/b.ts": "y" }); w.model.commitTimes.set(c3, iso(3));
    const c4 = w.model.commit("main", { "web/app.py": "y" }); w.model.commitTimes.set(c4, iso(200));
    const map = await mapRepository(w.repo(), deps, NOW + 60_000, 100);
    const by = Object.fromEntries(map.areas.map((a) => [a.path, a]));
    expect(by["src/a"]).toMatchObject({ commits: 2, rank: 1 });
    expect(by["src/b"]).toMatchObject({ commits: 1, rank: 2 });
    expect(by["web"]).toMatchObject({ commits: 0, lastChangeAt: iso(200), rank: 3 });
    expect(by["tests"]?.commits).toBeUndefined();
    expect(map.activity).toEqual({ status: "ok", days: 90 });
    const chips = (await computeWikiFileMap({ project: "p", repositories: [w.repo()] }, deps)).chips;
    expect(chips.filter((c) => c.kind === "write_first").map((c) => c.path)).toEqual(["src/a", "src/b"]);
    expect(chips.filter((c) => c.kind === "skip_old").map((c) => c.path)).toEqual(["web"]);
    expect(chips.filter((c) => c.kind === "skip_generated").map((c) => [c.path, c.defaultOn])).toEqual([["dist", true], ["node_modules", true], ["vendor", true]]);
    expect(chips.filter((c) => c.kind !== "skip_generated").every((c) => !c.defaultOn)).toBe(true);
  });

  it("says partial when the code host cut the tree and the folder walk could not finish, and never calls that complete", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) files[`pkg${String(i)}/a.ts`] = "x";
    const w = world(files);
    w.model.incompleteTrees.add(w.model.headOf("main"));
    const { wrapped, calls } = counted(w.host);
    const map = await mapRepository(w.repo({ host: wrapped }), deps, NOW + 60_000, 0);
    expect(map.status).toBe("partial");
    expect(map.partial).toMatch(/^partial: the code host cut its file list, so Rovara walked the folders: stopped after 80 folder reads, \d+ folders not read/u);
    expect(calls.dir).toBe(WIKI_MAP_LIMITS.directoryWalkRequests);
    expect(map.files).toBeLessThan(100);
    const whole = await computeWikiFileMap({ project: "p", repositories: [w.repo({ host: wrapped })] }, deps);
    expect(whole.complete).toBe(false);
  });

  it("is complete (no partial text) when the folder walk covers every folder after a cut tree", async () => {
    const w = world(SAMPLE);
    w.model.incompleteTrees.add(w.model.headOf("main"));
    const map = await mapRepository(w.repo(), deps, NOW + 60_000, 100);
    expect(map.status).toBe("ok");
    expect(map.partial).toBeUndefined();
    expect(map.files).toBe(SAMPLE_COUNTED);
    // The walk does not enter vendored, generated or secret folders: they are named, not read.
    expect(map.skippedFolders).toEqual(["dist", "node_modules", "vendor"]);
    expect(JSON.stringify(map)).not.toContain("secrets");
  });

  it("says partial when the host cut the tree and cannot list folders", async () => {
    const w = world(SAMPLE);
    w.model.incompleteTrees.add(w.model.headOf("main"));
    const { wrapped } = counted(w.host);
    const map = await mapRepository(w.repo({ host: { ...wrapped, directoryEntries: undefined } }), deps, NOW + 60_000, 100);
    expect(map.status).toBe("partial");
    expect(map.partial).toContain("partial: the code host cut its file list and cannot list folders");
  });

  it("says partial when the folder walk is stopped by depth", async () => {
    const w = world({ "a/b/c/d/e/f/g/h.ts": "x", "a/x.ts": "x" });
    w.model.incompleteTrees.add(w.model.headOf("main"));
    const map = await mapRepository(w.repo(), deps, NOW + 60_000, 100);
    expect(map.status).toBe("partial");
    expect(map.partial).toContain("folders not read");
  });

  it("reports a repository the host cannot read as unavailable in fixed words, never the cause", async () => {
    const w = world(SAMPLE);
    const failing: FileMapHost = { ...counted(w.host).wrapped, repositoryTree: async () => { throw new Error("token ghs_SECRETVALUE leaked in this message"); } };
    const map = await mapRepository(w.repo({ host: failing }), deps, NOW + 60_000, 100);
    expect(map).toMatchObject({ status: "unavailable", unavailable: WIKI_MAP_REPO_UNAVAILABLE, files: 0 });
    expect(JSON.stringify(map)).not.toContain("SECRET");
    const noListing = await mapRepository(w.repo({ host: { ...counted(w.host).wrapped, repositoryTree: undefined } }), deps, NOW + 60_000, 100);
    expect(noListing.unavailable).toBe(WIKI_MAP_NO_LISTING);
  });

  it("keeps the map and says partial activity when the host asks Rovara to slow down or the commit-count budget runs out", async () => {
    const w = world(SAMPLE);
    const slow: FileMapHost = { ...counted(w.host).wrapped, commitActivity: async () => { throw new HostRateLimitError(NOW + 1000); } };
    const limited = await mapRepository(w.repo({ host: slow }), deps, NOW + 60_000, 100);
    expect(limited.status).toBe("ok");
    expect(limited.activity.status).toBe("unavailable");
    const { wrapped, calls } = counted(w.host);
    const tight = await mapRepository(w.repo({ host: wrapped }), deps, NOW + 60_000, 1);
    expect(calls.activity).toBeLessThanOrEqual(2);
    expect(tight.activity.status).toBe("partial");
    expect(tight.activity.reason).toMatch(/commit-count limit was reached; measured \d of 3 folders/u);
  });

  it("stops measuring when time is up", async () => {
    const w = world(SAMPLE);
    let clock = NOW;
    const { wrapped, calls } = counted(w.host);
    const ticking = { scope, now: () => (clock += 1_000) };
    const map = await mapRepository(w.repo({ host: wrapped }), ticking, NOW + 2_500, 100);
    expect(calls.activity).toBeLessThan(3);
    expect(map.activity.status === "partial" || map.activity.status === "unavailable").toBe(true);
  });

  it("estimates pages: a start page, one per repository, module pages (capped), a cross-repository page, three fixed pages", async () => {
    const w1 = world(SAMPLE, "one");
    const w2 = world({ "src/x/a.ts": "x", "src/x/b.ts": "x", "src/x/c.ts": "x" }, "two");
    const single = await computeWikiFileMap({ project: "p", repositories: [w1.repo()] }, deps);
    expect(single.forecast).toEqual({ repositories: 1, files: SAMPLE_COUNTED, pages: 1 + 1 + 3 + 0 + 3, pagesCapped: false, price: "not_priced_yet" });
    const two = await computeWikiFileMap({ project: "p", repositories: [w1.repo({ name: "one" }), w2.repo({ name: "two" })] }, deps);
    expect(two.forecast.pages).toBe(1 + 2 + 4 + 1 + 3);
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i += 1) for (const f of ["a", "b", "c"]) many[`mod${String(i)}/${f}.ts`] = "x";
    const big = await computeWikiFileMap({ project: "p", repositories: [world(many).repo()] }, deps);
    expect(big.repositories[0]!.pages).toEqual({ repository: 1, modules: 40, modulesCapped: true });
    expect(big.repositories[0]!.areas.length).toBe(40);
  });

  it("caps pages per project and says so", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) for (const f of ["a", "b", "c"]) many[`mod${String(i)}/${f}.ts`] = "x";
    const repos = Array.from({ length: 10 }, (_, i) => world(many, `r${String(i)}`).repo({ name: `r${String(i)}` }));
    const map = await computeWikiFileMap({ project: "p", repositories: repos }, deps);
    expect(map.forecast).toMatchObject({ pages: 300, pagesCapped: true });
  });

  it("reads at most 20 repositories and says how many were left out", async () => {
    const repos = Array.from({ length: 23 }, (_, i) => world({ "a.ts": "x" }, `r${String(i)}`).repo({ name: `r${String(i)}` }));
    const { wrapped, calls } = counted(repos[0]!.host);
    const map = await computeWikiFileMap({ project: "p", repositories: repos.map((r) => ({ ...r, host: wrapped })) }, deps);
    expect(map.repositories).toHaveLength(20);
    expect(calls.tree).toBe(20);
    expect(map.repositoriesOmitted).toBe(3);
    expect(map.complete).toBe(false);
  });

  it("shares the commit-count budget across repositories", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) for (const f of ["a", "b", "c"]) files[`m${String(i)}/${f}.ts`] = "x";
    const repos = Array.from({ length: 4 }, (_, i) => world(files, `r${String(i)}`).repo({ name: `r${String(i)}` }));
    const { wrapped, calls } = counted(repos[0]!.host);
    await computeWikiFileMap({ project: "p", repositories: repos.map((r) => ({ ...r, host: wrapped })) }, deps);
    // 30 areas x 4 repos would be 120 calls; each repo gets 160 / 4 = 40 requests, and each 0-commit area costs 2.
    expect(calls.activity).toBeLessThanOrEqual(WIKI_MAP_LIMITS.activityRequests);
  });

  it("answers in the contract's own shape, with no dollar field", async () => {
    const w = world(SAMPLE);
    const map = await computeWikiFileMap({ project: "p", repositories: [w.repo()] }, deps);
    expect(WikiFileMapSchema.parse(map)).toEqual(map);
    expect(JSON.stringify(map)).not.toMatch(/usd|dollar|cost|\$/iu);
    expect(map.forecast.price).toBe("not_priced_yet");
  });
});

// Counted files of SAMPLE: README.md, package.json, src/a x3, src/b x3, tests/a.test.ts, docs/guide.md, web x3 = 13.
const SAMPLE_COUNTED = 13;
void (null as unknown as CodeHost);

describe("wiki file map contract", () => {
  it("refuses a map that is partial without saying so, and a whole one that claims to be partial", async () => {
    const w = world(SAMPLE);
    const whole = await computeWikiFileMap({ project: "p", repositories: [w.repo()] }, deps);
    const repo = whole.repositories[0]!;
    const bad = (override: object) => WikiFileMapSchema.safeParse({ ...whole, repositories: [{ ...repo, ...override }] }).success;
    expect(bad({})).toBe(true);
    expect(bad({ status: "partial" })).toBe(false);
    expect(bad({ status: "partial", partial: "the code host cut the list" })).toBe(false);
    expect(bad({ status: "partial", partial: "partial: the code host cut the list" })).toBe(true);
    expect(bad({ partial: "partial: because" })).toBe(false);
    expect(bad({ status: "unavailable" })).toBe(false);
    expect(bad({ unavailable: "x" })).toBe(false);
    expect(bad({ extra: 1 })).toBe(false);
    expect(WikiFileMapSchema.safeParse({ ...whole, forecast: { ...whole.forecast, price: "$4.00" } }).success).toBe(false);
    expect(WikiFileMapSchema.safeParse({ ...whole, forecast: { ...whole.forecast, estimatedUsd: 4 } }).success).toBe(false);
  });
});
