import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgLimitKey, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createWikiMapService } from "../../packages/broker/src/core/wiki/map-service.js";
import { computeWikiFileMap, mapRepository, type FileMapHost, type FileMapRepository } from "../../packages/broker/src/core/wiki/file-map.js";
import { continueWikiBuild, endWikiBuild, readWikiBuildPointer, startWikiBuild, stopWikiBuild, type WikiBuildDeps } from "../../packages/broker/src/core/wiki-build/run.js";
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

  it("returns slots after a computation fails", async () => {
    let broken = false;
    const service = createWikiMapService({ now: () => { if (broken) throw new Error("clock failed"); return NOW; } });
    // The first clock read is in the computation when the cache is empty.
    for (let i = 0; i < 2; i += 1) {
      broken = true;
      await expect(service.make(COMPANY_A, `bad-${i}`, [], scope)).rejects.toThrow("clock failed");
    }
    broken = false;
    expect((await service.make(COMPANY_A, "good", [], scope)).project).toBe("good");
  });
});

describe("company-wide wiki build admission", () => {
  it("allows exactly two active projects across dependency instances, and two companies do not share slots", async () => {
    const w = buildWorld();
    await Promise.all([startWikiBuild(w.deps(), "admin", "one", body()), startWikiBuild(w.deps(), "admin", "two", body())]);
    await expect(startWikiBuild(w.deps(), "admin", "three", body())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await readWikiBuildPointer(w.store, COMPANY_A, "three")).toBeUndefined();
    expect((await startWikiBuild(w.deps(COMPANY_B), "admin", "one", body())).status).toBe(202);
    expect((await startWikiBuild(w.deps(COMPANY_B), "admin", "two", body())).status).toBe(202);
    await expect(startWikiBuild(w.deps(COMPANY_B), "admin", "three", body())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });    // A limit row created by the first reservation is still a typed company-limit row.
    expect((await w.store.get(orgLimitKey(COMPANY_B)))?.["entityType"]).toBe("ORG_LIMIT");
  });

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

  it("releases only the ended run's slot, once; continue competes with other projects", async () => {
    const w = buildWorld();
    const deps = w.deps();
    const request = body();
    await startWikiBuild(deps, "admin", "one", request);
    await startWikiBuild(deps, "admin", "two", body());
    expect((await startWikiBuild(deps, "admin", "one", request)).status).toBe(200);
    const old = (await readWikiBuildPointer(w.store, COMPANY_A, "one"))!;
    await stopWikiBuild(deps, "admin", "one", body());
    await startWikiBuild(w.deps(), "admin", "three", body());
    await expect(continueWikiBuild(deps, "admin", "one", body())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    await endWikiBuild(w.store, { orgId: COMPANY_A, project: "one", taskId: old.taskId }, "infrastructure", deps.now);
    await expect(startWikiBuild(w.deps(), "admin", "four", body())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    const third = (await readWikiBuildPointer(w.store, COMPANY_A, "three"))!;
    await endWikiBuild(w.store, { orgId: COMPANY_A, project: "three", taskId: third.taskId }, "infrastructure", deps.now);
    expect((await continueWikiBuild(deps, "admin", "one", body())).status).toBe(202);
    await endWikiBuild(w.store, { orgId: COMPANY_A, project: "one", taskId: old.taskId }, "built", deps.now);
    await expect(startWikiBuild(w.deps(), "admin", "four", body())).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });

  it("recovers stale reservations after the existing stale-run deadline", async () => {
    const w = buildWorld();
    await startWikiBuild(w.deps(), "admin", "one", body());
    await startWikiBuild(w.deps(), "admin", "two", body());
    const pointer = (await readWikiBuildPointer(w.store, COMPANY_A, "one"))!;
    w.clock.now += (pointer.limits.wallClockMin + 60) * 60_000 + 1;
    expect((await startWikiBuild(w.deps(), "admin", "three", body())).status).toBe(202);
    expect((await startWikiBuild(w.deps(), "admin", "four", body())).status).toBe(202);
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

  it("returns the whole multi-repository map within 25 seconds and starts no reads afterward", async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const gate = deferred<string>();
    const head = vi.fn(() => gate.promise);
    const slow = { ...host(), baseBranchHead: head };
    const result = computeWikiFileMap({ project: "one", repositories: Array.from({ length: 12 }, (_, i) => ({ ...repo(slow), name: `repo-${i}` })) }, { scope, now: Date.now });
    let done = false;
    void result.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(done).toBe(true);
    expect((await result).complete).toBe(false);
    const reads = head.mock.calls.length;
    gate.resolve(API_SHA);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(head).toHaveBeenCalledTimes(reads);
    expect(vi.getTimerCount()).toBe(0);
  });
});
