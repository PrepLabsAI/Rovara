import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgLimitKey, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiMapService } from "../../packages/broker/src/core/wiki/map-service.js";
import { mapRepository, type FileMapHost, type FileMapRepository } from "../../packages/broker/src/core/wiki/file-map.js";
import { startWikiBuild, type WikiBuildDeps } from "../../packages/broker/src/core/wiki-build/run.js";
import { API_SHA, COMPANY_A, COMPANY_B, FakeStarter, fileMap, repoEntry } from "../support/wiki-build-fixtures.js";

const NOW = Date.parse("2026-11-17T12:00:00Z");
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const repo = (host: FileMapHost): FileMapRepository => ({ name: "api", url: "https://github.com/example/api", defaultBranch: "main", host });
const host = (): FileMapHost => ({ baseBranchHead: async () => API_SHA, repositoryTree: async () => ({ entries: [], complete: true }) });
const scope = { orgId: COMPANY_A };
const body = () => ({ requestId: randomUUID() });
function buildWorld() {
  const store = new MemoryDocumentStore();
  const clock = { now: NOW };
  const deps = (companyId: OrgId = COMPANY_A): WikiBuildDeps => ({
    store, companyId, now: () => clock.now, starter: new FakeStarter(store), standing: async () => ({ access: "manage" }),
    modelAccessConfigured: true, aiKey: async () => "connected", fileMap: async () => fileMap([repoEntry("api", [])]),
    defaultBranchHeads: async () => [{ repo: "api", commit: API_SHA }],
  });
  return { store, clock, deps };
}
afterEach(() => { vi.useRealTimers(); });

describe("company-wide wiki map admission", () => {
  it("allows exactly two projects, joins and reuses without a slot, and gives another company its own cap", async () => {
    const gate = deferred<string>();
    const slow = { ...host(), baseBranchHead: () => gate.promise };
    const service = createWikiMapService({ now: () => NOW });
    const first = service.make(COMPANY_A, "one", [repo(slow)], scope);
    const second = service.make(COMPANY_A, "two", [repo(slow)], scope);
    const joined = service.make(COMPANY_A, "one", [repo(slow)], scope);
    const refused = expect(service.make(COMPANY_A, "three", [repo(host())], scope)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    const other = service.make(COMPANY_B, "one", [repo(host())], { orgId: COMPANY_B });
    expect((await other).project).toBe("one");
    await refused;
    gate.resolve(API_SHA);
    const maps = await Promise.all([first, second, joined]);
    expect(maps[0]).toBe(maps[2]);
    expect(service.read(COMPANY_B, "two", [])).toBeUndefined();
    expect((await service.make(COMPANY_A, "three", [repo(host())], scope)).project).toBe("three");
  });

});

describe("wiki map service: reuse and a forced new map", () => {
  // MUTANT force: `force` is ignored, so a Build pressed again within a minute of a map pinned to a commit the branch no longer holds reads the same map and pins the same dead commit.
  it("hands back a map made less than a minute ago, unless a new one is forced (the last run was pinned to a commit that is gone)", async () => {
    let head = API_SHA;
    const moving = { ...host(), baseBranchHead: async () => head };
    const service = createWikiMapService({ now: () => NOW });
    const first = await service.make(COMPANY_A, "one", [repo(moving)], scope);
    head = "d".repeat(40);
    expect(await service.make(COMPANY_A, "one", [repo(moving)], scope)).toBe(first);
    const forced = await service.make(COMPANY_A, "one", [repo(moving)], scope, { force: true });
    expect(forced).not.toBe(first);
    expect(forced.repositories[0]?.commit).toBe(head);
    // The new map is the kept one, so the plan and the pins of the Build that forced it describe the same tree.
    expect(service.read(COMPANY_A, "one", [`${repo(moving).url}\u0000main`])).toBe(forced);
  });
});

describe("company-wide wiki build admission", () => {

  it("returns reservations after a failed starter, without changing the existing workspace count", async () => {
    const w = buildWorld();
    await w.store.put({ item: { ...orgLimitKey(COMPANY_A), entityType: "ORG_LIMIT", count: 7 } });
    const deps = w.deps();
    deps.starter = { start: async () => { throw new Error("start failed"); }, cancel: async () => undefined };
    for (let i = 0; i < 2; i += 1) await expect(startWikiBuild(deps, "admin", `bad-${i}`, body())).rejects.toThrow("start failed");
    await startWikiBuild(w.deps(), "admin", "one", body());
    await startWikiBuild(w.deps(), "admin", "two", body());
    expect((await w.store.get(orgLimitKey(COMPANY_A)))?.["count"]).toBe(7);
  });

});

describe("hard wiki map deadline", () => {
  it.each(["head", "tree", "folder", "activity"] as const)("bounds a hung %s read by the remaining deadline", async (hop) => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const hanging = deferred<never>();
    const calls = vi.fn();
    const target: FileMapHost = {
      baseBranchHead: async () => { calls("head"); return hop === "head" ? hanging.promise : API_SHA; },
      repositoryTree: async () => { calls("tree"); return hop === "tree" ? hanging.promise : { entries: [{ path: "src/a.ts", kind: "file" as const }], complete: hop !== "folder" }; },
      directoryEntries: async () => { calls("folder"); return hanging.promise; },
      commitActivity: async () => { calls("activity"); return hanging.promise; },
    };
    const result = mapRepository(repo(target), { scope, now: Date.now }, NOW + 1_000, 100);
    let done = false;
    void result.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    const map = await result;
    expect(map.status !== "ok" || map.activity.status !== "ok").toBe(true);
    const reads = calls.mock.calls.length;
    hanging.resolve(undefined as never);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

});
