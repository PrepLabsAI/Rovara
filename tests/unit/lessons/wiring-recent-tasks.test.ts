// L4-LP12b (2): "would have applied to N tasks last month" for the weekly list's tie-break, from the project's own recent tasks: its load rows name the tasks, each task's own record and plan give the scope the loader saw.
// No model, nothing written. A read that cannot be answered whole is "not known" (the tie-break is then left out, as it was), never a partial count.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { buildCoreRegistry, createCoreRuntime } from "../../../packages/broker/src/core-host/index.js";
import { createCoreLessons, readCoreLessonsSwitch, setCoreLessonsGate, CORE_LESSONS_VARIABLE } from "../../../packages/broker/src/core-host/lessons.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { documentMeasureSink } from "../../../packages/broker/src/lessons/measure.js";
import { RECENT_ROWS_MAX, RECENT_TASKS_MAX, RECENT_TASKS_MS, RECENT_TASKS_TTL_MS, cachedRecentTasks, readRecentTaskScopes, type RecentTasksPorts } from "../../../packages/broker/src/lessons/recent-tasks.js";
import { orderWeekly, wouldHaveApplied } from "../../../packages/broker/src/lessons/weekly-order.js";
import { FAKE_COMPANY, createFakeWorld } from "../../support/core-host-fakes.js";
import { Clock, PROJECT, WS, lessonRecord } from "./lesson-helpers.js";
import { A as COMPANY, B as OTHER, DAY } from "./phase12-helpers.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";

// The lessons helpers open the learning gate for the whole file; the hosted worlds set their own, so it is put back open.
afterEach(() => { vi.useRealTimers(); setLearnedLessonsGate(() => true); });

const TASK = (n: number): string => `task-${String(n).padStart(4, "0")}`;
const KEY = { workspaceId: WS, project: PROJECT };

async function rows(documents: MemoryDocumentStore, clock: Clock, entries: Array<{ taskId: string; ageDays: number; company?: OrgId; project?: string; stage?: string }>): Promise<void> {
  for (const entry of entries) {
    const sink = documentMeasureSink(documents, entry.company ?? COMPANY, clock.now);
    await sink.load({ workspaceId: entry.company ?? COMPANY, project: entry.project ?? PROJECT, taskId: entry.taskId, stage: entry.stage ?? "IMPLEMENT", round: 1, at: clock.now() - entry.ageDays * DAY, budgetLessons: 5, activeCount: 3, eligibleCount: 3, loaded: [], leftOut: [] });
  }
}
function ports(files: Record<string, string[]>, over: Partial<RecentTasksPorts> & { project?: string } = {}) {
  const asked: string[] = [];
  const value: RecentTasksPorts = {
    task: async (id) => { asked.push(id); return files[id] === undefined ? undefined : { project: over.project ?? PROJECT, files: files[id] }; },
    repositories: async () => ["api"], ...over,
  };
  return { ports: value, asked };
}
const deps = (documents: MemoryDocumentStore, clock: Clock, p: RecentTasksPorts) => ({ documents, companyId: COMPANY, now: clock.now, ports: p });

describe("the recent tasks of a project", () => {
  it("the tasks of the last 30 days, newest first and each once (a task with several steps is one), with the repositories of the project and the files its plan names (golden)", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [
      { taskId: TASK(1), ageDays: 2, stage: "PLAN" }, { taskId: TASK(1), ageDays: 2, stage: "IMPLEMENT" }, { taskId: TASK(2), ageDays: 10 }, { taskId: TASK(3), ageDays: 29 },
      { taskId: TASK(4), ageDays: 31 },
    ]);
    const { ports: p, asked } = ports({ [TASK(1)]: ["src/billing/a.ts"], [TASK(2)]: [], [TASK(3)]: ["src/search/b.ts"], [TASK(4)]: ["src/old.ts"] });
    expect(await readRecentTaskScopes(deps(documents, clock, p), KEY)).toEqual([
      { repos: ["api"], files: ["src/billing/a.ts"], languages: [] }, { repos: ["api"], files: [], languages: [] }, { repos: ["api"], files: ["src/search/b.ts"], languages: [] },
    ]);
    // Nothing older than the window was even read.
    expect(asked.sort()).toEqual([TASK(1), TASK(2), TASK(3)]);
  });

  it("another company's rows and another project's rows are never read, and a task of another project is left out (two companies, two projects)", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }, { taskId: TASK(2), ageDays: 1, company: OTHER }, { taskId: TASK(3), ageDays: 1, project: "other-project" }, { taskId: TASK(4), ageDays: 1 }]);
    const { ports: p, asked } = ports({ [TASK(1)]: ["a.ts"], [TASK(2)]: ["b-secret.ts"], [TASK(3)]: ["c.ts"], [TASK(4)]: ["d.ts"] });
    const scopes = await readRecentTaskScopes(deps(documents, clock, { ...p, task: async (id) => (id === TASK(4) ? { project: "other-project", files: ["wrong.ts"] } : p.task(id)) }), KEY);
    expect(scopes).toEqual([{ repos: ["api"], files: ["a.ts"], languages: [] }]);
    expect(asked).not.toContain(TASK(2));
    expect(asked).not.toContain(TASK(3));
    // Asked about another company's key, the answer is "not known" and nothing is read at all.
    asked.length = 0;
    expect(await readRecentTaskScopes(deps(documents, clock, p), { workspaceId: OTHER, project: PROJECT })).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("a task that is not this company's (the port says so) is left out, not counted", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }, { taskId: TASK(2), ageDays: 2 }]);
    expect(await readRecentTaskScopes(deps(documents, clock, ports({ [TASK(1)]: ["a.ts"] }).ports), KEY)).toEqual([{ repos: ["api"], files: ["a.ts"], languages: [] }]);
  });

  it("not known (undefined), never a partial list: no task, a failed read of a task or of the repositories, repositories not known, a clock that ran out", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    expect(await readRecentTaskScopes(deps(documents, clock, ports({}).ports), KEY)).toBeUndefined();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }, { taskId: TASK(2), ageDays: 2 }]);
    const good = ports({ [TASK(1)]: ["a.ts"], [TASK(2)]: ["b.ts"] }).ports;
    expect(await readRecentTaskScopes(deps(documents, clock, good), KEY)).toHaveLength(2);
    expect(await readRecentTaskScopes(deps(documents, clock, { ...good, task: async (id) => { if (id === TASK(2)) throw new Error("plan unreadable"); return good.task(id); } }), KEY)).toBeUndefined();
    expect(await readRecentTaskScopes(deps(documents, clock, { ...good, repositories: async () => { throw new Error("project unreadable"); } }), KEY)).toBeUndefined();
    expect(await readRecentTaskScopes(deps(documents, clock, { ...good, repositories: async () => undefined }), KEY)).toBeUndefined();
    expect(await readRecentTaskScopes({ ...deps(documents, clock, good), documents: { query: async () => { throw new Error("store down"); } } }, KEY)).toBeUndefined();
  });

  it("one total limit: at most RECENT_TASKS_MAX tasks are read, newest first, and a long list of load rows is read only up to RECENT_ROWS_MAX", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, Array.from({ length: RECENT_TASKS_MAX + 15 }, (_, i) => ({ taskId: TASK(i), ageDays: 20 - i / 10 })));
    const files = Object.fromEntries(Array.from({ length: RECENT_TASKS_MAX + 15 }, (_, i) => [TASK(i), [`f${String(i)}.ts`]]));
    const { ports: p, asked } = ports(files);
    expect(await readRecentTaskScopes(deps(documents, clock, p), KEY)).toHaveLength(RECENT_TASKS_MAX);
    expect(asked).toHaveLength(RECENT_TASKS_MAX);
    // Newest first: the first tasks written (the oldest ages) are not among them.
    expect(asked).not.toContain(TASK(0));
    const query = vi.spyOn(documents, "query");
    await readRecentTaskScopes(deps(documents, clock, ports({}).ports), KEY);
    expect(query.mock.calls.reduce((total, [request]) => total + (request.limit ?? 0), 0)).toBeLessThanOrEqual(RECENT_ROWS_MAX);
  });

  it("a read that runs past its time is not known (a task read that never answers does not hold the weekly list)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, Array.from({ length: 12 }, (_, i) => ({ taskId: TASK(i), ageDays: 1 + i / 10 })));
    const slow = ports({}, { task: async (id) => { vi.setSystemTime(Date.now() + RECENT_TASKS_MS); return { project: PROJECT, files: [id] }; } }).ports;
    expect(await readRecentTaskScopes(deps(documents, clock, slow), KEY)).toBeUndefined();
  });

  it("a read that never answers (a plan object, a task record, the repositories, the store) is let go when the time is up: the answer is 'not known', never a hang", async () => {
    vi.useFakeTimers();
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }]);
    const never = () => new Promise<never>(() => undefined);
    const good = ports({ [TASK(1)]: ["a.ts"] }).ports;
    for (const hung of [{ ...good, task: never }, { ...good, repositories: never }]) {
      const reading = readRecentTaskScopes(deps(documents, clock, hung), KEY);
      await vi.advanceTimersByTimeAsync(RECENT_TASKS_MS + 10);
      expect(await reading).toBeUndefined();
    }
    const reading = readRecentTaskScopes({ ...deps(documents, clock, good), documents: { query: never } }, KEY);
    await vi.advanceTimersByTimeAsync(RECENT_TASKS_MS + 10);
    expect(await reading).toBeUndefined();
  });

  it("a read that finishes after the time was up is dropped, not kept: the next page reads again", async () => {
    vi.useFakeTimers();
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let slow = true;
    const { ports: p, asked } = ports({ [TASK(1)]: ["a.ts"] }, { repositories: async () => { if (slow) await gate; return ["api"]; } });
    const read = cachedRecentTasks(deps(documents, clock, p));
    const late = read(KEY);
    await vi.advanceTimersByTimeAsync(RECENT_TASKS_MS + 10);
    expect(await late).toBeUndefined();
    slow = false;
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(await read(KEY)).toHaveLength(1);
    expect(asked).toEqual([TASK(1)]);
  });

  it("a page opened again while a slow read runs shares that read (one read per project at a time)", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { ports: p, asked } = ports({ [TASK(1)]: ["a.ts"] }, { repositories: async () => { await gate; return ["api"]; } });
    const read = cachedRecentTasks(deps(documents, clock, p));
    const first = read(KEY);
    const second = read(KEY);
    release();
    expect(await first).toHaveLength(1);
    expect(await second).toHaveLength(1);
    expect(asked).toEqual([TASK(1)]);
  });

  it("kept for the project for a while, so a weekly page opened again does not read the plans again; 'not known' is read again; another project and another company have their own", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }]);
    const { ports: p, asked } = ports({ [TASK(1)]: ["a.ts"] });
    const read = cachedRecentTasks(deps(documents, clock, p));
    expect(await read(KEY)).toHaveLength(1);
    expect(await read(KEY)).toHaveLength(1);
    expect(asked).toEqual([TASK(1)]);
    clock.advance(RECENT_TASKS_TTL_MS + 1);
    expect(await read(KEY)).toHaveLength(1);
    expect(asked).toEqual([TASK(1), TASK(1)]);
    expect(await read({ workspaceId: OTHER, project: PROJECT })).toBeUndefined();
    // An unknown answer is not remembered.
    const empty = cachedRecentTasks(deps(documents, clock, ports({}, { repositories: async () => undefined }).ports));
    expect(await empty(KEY)).toBeUndefined();
    expect(await empty(KEY)).toBeUndefined();
  });
});

describe("the weekly tie-break uses it", () => {
  const pending = (id: string, paths: string[]) => lessonRecord({ id, status: "pending", scope: { repos: ["api"], paths }, approvals: [], pendingExpiresAt: 9e15, provenance: { ...lessonRecord().provenance, memberCorrection: true, authors: ["ann"], supportTasks: ["t1"] } });
  const NOW = 1_800_000_000_000;

  it("two suggestions that tie on everything before it: the one that would have applied to more of last month's tasks comes first, and its reason says how many", async () => {
    const clock = new Clock();
    const documents = new MemoryDocumentStore();
    await rows(documents, clock, [{ taskId: TASK(1), ageDays: 1 }, { taskId: TASK(2), ageDays: 2 }, { taskId: TASK(3), ageDays: 3 }]);
    const scopes = (await readRecentTaskScopes(deps(documents, clock, ports({ [TASK(1)]: ["src/billing/a.ts"], [TASK(2)]: ["src/billing/b.ts"], [TASK(3)]: ["src/search/c.ts"] }).ports), KEY))!;
    const billing = pending("les_bill0001", ["src/billing/**"]);
    const search = pending("les_srch0001", ["src/search/**"]);
    expect(wouldHaveApplied(billing, scopes)).toBe(2);
    expect(wouldHaveApplied(search, scopes)).toBe(1);
    const withTasks = orderWeekly({ lessons: [search, billing], now: NOW, extras: { recentTasks: scopes } }).picks;
    expect(withTasks.map((row) => row.id)).toEqual(["les_bill0001", "les_srch0001"]);
    expect(withTasks[0]!.reason).toContain("Would have applied to 2 tasks last month.");
    // Unknown (no tasks read): no tie-break, and no sentence about it.
    const without = orderWeekly({ lessons: [search, billing], now: NOW }).picks;
    expect(without.every((row) => !row.reason.includes("Would have applied"))).toBe(true);
  });
});

describe("wired for a company's lessons (the weekly extras the digest route reads)", () => {
  const FAKE = FAKE_COMPANY as OrgId;
  const DEFINITION: ProjectDefinition = {
    name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
    repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
  };
  const people: HostedLessonPeople = {
    async approvers() { return { complete: true, membershipVersion: 1, ownerIds: ["ann"], eligibleIds: ["ann"], lastEligibleLossAtMs: null }; },
    async onProjectRoster() { return true; }, async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased() { return false; },
  };

  async function companyWorld() {
    const env = { [CORE_LESSONS_VARIABLE]: "on" };
    const fake = createFakeWorld();
    setCoreLessonsGate(env);
    const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
    await fake.store.put({ item: { ...projectRevisionKey(FAKE, DEFINITION.name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(DEFINITION)) as JsonValue } });
    await fake.store.put({ item: { ...orgProjectCatalogKey(FAKE, DEFINITION.name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
    const runtime = createCoreRuntime({
      registry, companyId: FAKE, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
      repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
    });
    const lessons = createCoreLessons({ flow: runtime.flow, registry, companyId: FAKE, lessonsSwitch: readCoreLessonsSwitch(env).value, people, hostFor: async () => undefined, now: () => fake.clock.now })!;
    const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId: FAKE }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
    return { fake, lessons, taskId: task.taskId };
  }

  it("the weekly extras carry the project's recent tasks (its repositories and what each task's plan names) once a load row names a task; with no task they carry none", async () => {
    const w = await companyWorld();
    const key = { workspaceId: FAKE, project: "payments" };
    const extras = (): Promise<{ recentTasks?: unknown } | undefined> => w.lessons.runtime.routes.weeklyExtras!(key);
    expect((await extras())?.recentTasks).toBeUndefined();
    await documentMeasureSink(w.fake.store, FAKE, () => w.fake.clock.now).load({ workspaceId: FAKE, project: "payments", taskId: w.taskId, stage: "IMPLEMENT", round: 1, at: w.fake.clock.now, budgetLessons: 5, activeCount: 1, eligibleCount: 1, loaded: [], leftOut: [] });
    // The task has no plan document yet: it is a task of the project all the same (the loader would have asked with no files).
    expect((await extras())?.recentTasks).toEqual([{ repos: ["demo"], files: [], languages: [] }]);
  });
});
