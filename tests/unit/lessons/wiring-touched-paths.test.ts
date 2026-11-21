// L4-LP12b (1): the credit of a clean merge uses the files the MERGED change really touched (read from the code host), not "the lessons a Build step was given". The source reads the list WHOLE or not at all; the task's end hands it on
// to the counters; the credit rule keeps a lesson about other repositories out. The hosted world is the one of hosted-learning-sources.test.ts (a real core flow and lessons for company A).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { orgProjectCatalogKey, projectRevisionKey, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { createOwnerTaskAccess } from "../../../packages/broker/src/core/task-flow/access.js";
import { taskKey } from "../../../packages/broker/src/core/task-flow/keys.js";
import { localOwnerPrincipal } from "../../../packages/broker/src/ports/policy-defaults.js";
import { CORE_ENGINE_ON, buildCoreRegistry, createCoreRuntime, type CoreRuntime } from "../../../packages/broker/src/core-host/index.js";
import type { HostedLessonPeople } from "../../../packages/broker/src/lessons/hosted-people.js";
import { setLearnedLessonsGate } from "../../../packages/broker/src/lessons/policy.js";
import { lessonAreaOverlap, lessonCreditShares } from "../../../packages/broker/src/lessons/credit.js";
import { learnFromEndedTask, type TaskSubjectBase } from "../../../packages/broker/src/lessons/task-end.js";
import { InMemoryLessonStore } from "../../../packages/broker/src/lessons/store.js";
import { createLocalLessonSources, TOUCHED_PATHS_MAX, TOUCHED_READ_MS } from "../../../packages/broker/src/local/app/lessons-sources.js";
import type { LessonRepositories } from "../../../packages/broker/src/local/app/lessons-repos.js";
import type { EvidenceSpan } from "../../../packages/broker/src/lessons/reflect-input.js";
import type { OutcomeRowReader } from "../../../packages/broker/src/lessons/task-outcome-rows.js";
import type { ProcessDeps } from "../../../packages/broker/src/lessons/process.js";
import type { CounterDeps } from "../../../packages/broker/src/lessons/counters.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../../support/core-host-fakes.js";
import { Alerts, Audit, BASE, Clock, MERGED, MemoryVectors, PROJECT, ScriptedModel, Spend, WS, candidateJson, embedder, facts, lessonRecord, reply, seed, settings, verifier } from "./lesson-helpers.js";

// The lessons helpers open the learning gate for the whole file; the hosted worlds set their own, so it is put back open.
afterEach(() => { vi.useRealTimers(); setLearnedLessonsGate(() => true); });

const A = FAKE_COMPANY as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb";
const DEFINITION: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [
    { name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" },
    { name: "web", url: "https://github.com/example/web.git", path: "repo/web", defaultBranch: "main", credentialRef: "host-app" },
  ],
};
const MEMBER = "ann";
const people: HostedLessonPeople = {
  async approvers() { return { complete: true, membershipVersion: 1, ownerIds: [MEMBER], eligibleIds: [MEMBER], lastEligibleLossAtMs: null }; },
  async onProjectRoster(_c, _p, personId) { return personId === MEMBER; }, async linkedAccounts() { return []; }, async displayName() { return undefined; }, async isErased() { return false; },
};

async function hostedWorld(companyOfTask: string = A): Promise<{ fake: FakeWorld; runtime: CoreRuntime; taskId: string }> {
  const fake = createFakeWorld();
  setLearnedLessonsGate(() => true);
  const registry = await buildCoreRegistry({ modules: fake.modules, context: fake.context(), areas: ["flow", "build", "merge"] });
  await fake.store.put({ item: { ...projectRevisionKey(A, DEFINITION.name, 1), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(DEFINITION)) as JsonValue } });
  await fake.store.put({ item: { ...orgProjectCatalogKey(A, DEFINITION.name), entityType: "PROJECT_CATALOG", latestRevision: 1 } });
  const runtime = createCoreRuntime({
    registry, companyId: A, flags: CORE_ENGINE_ON, callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5),
    repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(fake.clock.now), log: () => undefined,
  });
  const { task } = await runtime.flow.start({ principal: localOwnerPrincipal({ companyId: A }), client: "test", origin: "app" as const }, { requestId: randomUUID(), project: "payments", instructions: "Add a /health endpoint", workflow: true, workflowPath: "QUICK" });
  if (companyOfTask !== A) {
    const record = (await fake.store.get(taskKey(task.taskId)))! as unknown as Record<string, unknown>;
    await fake.store.put({ item: { ...record, companyId: companyOfTask } as never });
  }
  return { fake, runtime, taskId: task.taskId };
}

/** Writes the pull requests and the outcome onto the task's stored workflow, as the flow would have committed them. */
async function merge(fake: FakeWorld, taskId: string, pullRequests: Array<{ repositoryId: string; number: number; state: string }>, outcome: string | undefined = "MERGED"): Promise<void> {
  const record = (await fake.store.get(taskKey(taskId)))! as unknown as Record<string, unknown> & { workflow: Record<string, unknown> };
  await fake.store.put({ item: { ...record, workflow: { ...record.workflow, ...(outcome === undefined ? {} : { outcome }), pullRequests: pullRequests.map((pr) => ({ ...pr, url: `https://github.com/example/${pr.repositoryId}/pull/${String(pr.number)}`, headSha: "a".repeat(40), required: true, candidateDigest: "d".repeat(64) })) } } as never });
}

interface FakeFile { path: string; previousPath?: string; status?: string; additions?: number; deletions?: number }
type Pages = FakeFile[][];
/** A code host whose pull request file lists are `pages[repository][number]` (a list of pages). */
function fakeHost(pagesOf: Record<string, Pages>, behaviour: { throws?: boolean; hang?: boolean } = {}) {
  const calls: Array<{ repo: string; page: number }> = [];
  const host = {
    kind: "github",
    feedback: async () => ({ comments: [], changeRequest: { headTreeRevision: "t" } }),
    standing: async () => ({ permission: "write", accountType: "person" }),
    changedFiles: async (ref: { repository: { url: string }; id: string }, page: number) => {
      const repo = /\/([^/.]+)(?:\.git)?$/u.exec(ref.repository.url)![1]!;
      calls.push({ repo, page });
      if (behaviour.hang === true) return new Promise<never>(() => undefined);
      if (behaviour.throws === true) throw new Error("rate limited");
      const pages = pagesOf[repo] ?? [];
      const files = pages[page - 1] ?? [];
      return { files: files.map((file) => ({ status: "modified", additions: 1, deletions: 0, ...file })), ...(page < pages.length ? { nextPage: page + 1 } : {}) };
    },
  };
  return { host, calls };
}

function sourcesOf(w: { fake: FakeWorld; runtime: CoreRuntime }, host: unknown, companyId: OrgId = A) {
  const reposOf = (name: string) => ({ name, url: `https://github.com/example/${name}.git`, place: `github:repo/${name}`, fullName: `example/${name}`, private: true, codeHost: host, repository: { url: `https://github.com/example/${name}.git` }, scope: {} });
  const repos = { ofProject: async () => ["demo", "web"].map(reposOf), ofTask: async (_project: string, _revision: number, name: string) => (["demo", "web"].includes(name) ? reposOf(name) : undefined) } as unknown as LessonRepositories;
  return createLocalLessonSources({ flow: w.runtime.flow.deps, companyId, ownerId: "rovara-system", repos, now: () => w.fake.clock.now, hosted: { people } });
}

const read = async (w: { fake: FakeWorld; runtime: CoreRuntime; taskId: string }, host: unknown, context?: "human_edit") => sourcesOf(w, host).source.read({ workspaceId: A, taskId: w.taskId, ...(context === undefined ? {} : { context }) });

describe("the source reads the merged change's own file list from the code host", () => {
  it("every merged pull request of the task, both names of a rename, './' removed, and the repositories they are in (golden)", async () => {
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }, { repositoryId: "web", number: 9, state: "MERGED" }, { repositoryId: "web", number: 10, state: "CLOSED" }]);
    const { host, calls } = fakeHost({
      demo: [[{ path: "src/billing/money.ts" }, { path: "./docs/a.md", status: "added" }], [{ path: "src/new-name.ts", previousPath: "src/old-name.ts", status: "renamed" }]],
      web: [[{ path: "/app/page.tsx" }]],
    });
    const result = await read(w, host);
    expect(result?.touchedPaths).toEqual(["src/billing/money.ts", "docs/a.md", "src/new-name.ts", "src/old-name.ts", "app/page.tsx"]);
    expect(result?.touchedRepos).toEqual(["demo", "web"]);
    // Two pages of the first repository and one of the second; the closed pull request was not asked about.
    expect(calls).toEqual([{ repo: "demo", page: 1 }, { repo: "demo", page: 2 }, { repo: "web", page: 1 }]);
  });

  it("a known EMPTY list is known (a merge that changed no file touches nothing), not 'not known'", async () => {
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }]);
    const result = await read(w, fakeHost({ demo: [[]] }).host);
    expect(result?.touchedPaths).toEqual([]);
    expect(result?.touchedRepos).toEqual(["demo"]);
  });

  it("not known (no list at all, so the credit works as it did) when the list could not be read whole", async () => {
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }]);
    const cases: Array<[string, () => Promise<Awaited<ReturnType<typeof read>>>]> = [
      ["the host fails", () => read(w, fakeHost({ demo: [[{ path: "a.ts" }]] }, { throws: true }).host)],
      // Ten pages is all a read walks; an eleventh page that is still promised means the list is cut.
      ["the list is cut (more pages than a read walks)", () => read(w, fakeHost({ demo: Array.from({ length: 12 }, (_, i) => [{ path: `src/f${String(i)}.ts` }]) }).host)],
      ["more names than one credit reads", () => read(w, fakeHost({ demo: [Array.from({ length: TOUCHED_PATHS_MAX + 1 }, (_, i) => ({ path: `src/f${String(i)}.ts` }))] }).host)],
    ];
    for (const [name, run] of cases) {
      const result = await run();
      expect(result, name).toBeDefined();
      expect(result?.touchedPaths, name).toBeUndefined();
      expect(result?.touchedRepos, name).toBeUndefined();
    }
  });

  it("exactly the limit is still a whole list", async () => {
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }]);
    const result = await read(w, fakeHost({ demo: [Array.from({ length: TOUCHED_PATHS_MAX }, (_, i) => ({ path: `src/f${String(i)}.ts` }))] }).host);
    expect(result?.touchedPaths).toHaveLength(TOUCHED_PATHS_MAX);
  });

  it("a pull request that is still open, or whose state is not known, may be part of the change: the list is not whole, so it is not given", async () => {
    for (const state of ["OPEN", "UNKNOWN"]) {
      const w = await hostedWorld();
      await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }, { repositoryId: "web", number: 9, state }]);
      const { host, calls } = fakeHost({ demo: [[{ path: "a.ts" }]], web: [[{ path: "b.ts" }]] });
      const result = await read(w, host);
      expect(result?.touchedPaths, state).toBeUndefined();
      expect(calls, state).toEqual([]);
    }
  });

  it("a task with more merged pull requests than the read allows, or none merged, has no list", async () => {
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, Array.from({ length: 6 }, (_, i) => ({ repositoryId: "demo", number: i + 1, state: "MERGED" })));
    expect((await read(w, fakeHost({ demo: [[{ path: "a.ts" }]] }).host))?.touchedPaths).toBeUndefined();
    const none = await hostedWorld();
    await merge(none.fake, none.taskId, [{ repositoryId: "demo", number: 7, state: "CLOSED" }]);
    expect((await read(none, fakeHost({}).host))?.touchedPaths).toBeUndefined();
  });

  it("a repository the project does not have is not read, and the list is not given", async () => {
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }, { repositoryId: "elsewhere", number: 2, state: "MERGED" }]);
    expect((await read(w, fakeHost({ demo: [[{ path: "a.ts" }]] }).host))?.touchedPaths).toBeUndefined();
  });

  it("only a task that MERGED reads the list: a closed task and a human edit's read never ask the host", async () => {
    const closed = await hostedWorld();
    await merge(closed.fake, closed.taskId, [{ repositoryId: "demo", number: 7, state: "CLOSED" }], "CLOSED");
    const asked = fakeHost({ demo: [[{ path: "a.ts" }]] });
    expect((await read(closed, asked.host))?.touchedPaths).toBeUndefined();
    // A task that ended closed although one of its pull requests had merged: its end is not a merge, so no list is read.
    const mixed = await hostedWorld();
    await merge(mixed.fake, mixed.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }], "CLOSED");
    expect((await read(mixed, asked.host))?.touchedPaths).toBeUndefined();
    const edited = await hostedWorld();
    await merge(edited.fake, edited.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }]);
    expect((await read(edited, asked.host, "human_edit"))?.touchedPaths).toBeUndefined();
    expect(asked.calls).toEqual([]);
  });

  it("a host that never answers is not waited for past the read's own time: the list is not known", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const w = await hostedWorld();
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }]);
    const reading = read(w, fakeHost({ demo: [[{ path: "a.ts" }]] }, { hang: true }).host);
    await vi.advanceTimersByTimeAsync(TOUCHED_READ_MS + 50);
    const result = await reading;
    expect(result).toBeDefined();
    expect(result?.touchedPaths).toBeUndefined();
  });

  it("two companies: a task of company B is not read by company A's source, and the host is never asked about it", async () => {
    const w = await hostedWorld(B);
    await merge(w.fake, w.taskId, [{ repositoryId: "demo", number: 7, state: "MERGED" }]);
    const asked = fakeHost({ demo: [[{ path: "secret/b-only.ts" }]] });
    expect(await read(w, asked.host)).toBeUndefined();
    expect(asked.calls).toEqual([]);
  });
});

describe("the credit rule keeps a lesson about other repositories out", () => {
  const web = lessonRecord({ id: "les_webb0001", scope: { repos: ["web"], paths: ["src/**"] } });
  const api = lessonRecord({ id: "les_apii0001", scope: { repos: ["api"], paths: ["src/**"] } });
  const anyRepo = lessonRecord({ id: "les_anyy0001", scope: { paths: ["src/**"] } });

  it("a change that only reached the api repository does not touch a lesson about web (the same path in another repository is not its area); repositories not known rule nothing out", () => {
    expect(lessonAreaOverlap(web, ["src/a.ts"], ["api"])).toBe(false);
    expect(lessonAreaOverlap(web, ["src/a.ts"], ["api", "web"])).toBe(true);
    expect(lessonAreaOverlap(web, ["src/a.ts"], undefined)).toBe(true);
    expect(lessonAreaOverlap(anyRepo, ["src/a.ts"], ["api"])).toBe(true);
    expect(lessonAreaOverlap(web, ["docs/a.md"], ["web"])).toBe(false);
  });

  it("shares 1/k among the lessons the real change reached, with and without a report (golden)", () => {
    const lessons = new Map([[web.id, web], [api.id, api], [anyRepo.id, anyRepo]]);
    const loaded = new Set(lessons.keys());
    expect([...lessonCreditShares({ lessons, loaded, reports: undefined, touched: ["src/a.ts"], touchedRepos: ["api"] })]).toEqual([["les_anyy0001", 0.5], ["les_apii0001", 0.5]]);
    const reports = [{ reported: true, units: [web, api, anyRepo].map((l) => ({ id: `L-${l.id}`, kind: "lesson", used: true, areaTouched: true })) }];
    expect([...lessonCreditShares({ lessons, loaded, reports, touched: ["src/a.ts"], touchedRepos: ["web"] })]).toEqual([["les_anyy0001", 0.5], ["les_webb0001", 0.5]]);
  });
});

describe("the task's end hands the real list to the counters", () => {
  const merged = { workspaceId: WS, taskId: "task-1", outcome: "merged" as const };
  const KEY = { workspaceId: WS, project: PROJECT };
  const baseOf = (over: Partial<TaskSubjectBase> = {}): TaskSubjectBase => ({
    facts: {
      workspaceId: WS, project: PROJECT, taskId: "task-1", repositories: ["api"], baseCommit: BASE, mergedCommit: MERGED, outcome: "merged", task: { developerId: "creator", startedBy: { developerId: "starter" }, agent: { agentId: "a" } },
      rest: { initiatorTrust: "member", steeringTrust: ["member"], intentTrust: "member", links: [], spans: [] as EvidenceSpan[] },
    },
    sendBackRequestIds: [], ...over,
  });

  async function ended(base: TaskSubjectBase, ids: Array<[string, { repos?: string[]; paths?: string[] }]>) {
    const store = new InMemoryLessonStore();
    const audit = new Audit();
    const clock = new Clock();
    const configured = settings({ mode: "On" });
    await seed(store, ...ids.map(([id, scope]) => lessonRecord({ id, scope })));
    await store.putManifest({ taskId: "task-1", workspaceId: WS, project: PROJECT, stage: "IMPLEMENT", round: 1, setVersion: 1, memory: "live", at: 1, lessons: ids.map(([id]) => ({ id, version: 1, score: 0.5, why: "scope" as const, citation: "valid" as const })), bytes: 10 });
    const rows: OutcomeRowReader = { async sendBack() { return undefined; }, async revertedBy() { return undefined; } };
    const process: ProcessDeps = {
      store, embedder, vectors: new MemoryVectors(), judgeModel: new ScriptedModel(), spend: new Spend(), audit, alerts: new Alerts(), now: clock.now, verifier: verifier("valid"), facts: facts(), settings: configured,
      newId: (() => { let n = 0; return () => `les_${String(++n).padStart(4, "0")}`; })(),
    };
    const counters: CounterDeps = { store, judge: { rate: async () => "unrelated" as const, usable: async () => true }, settings: configured, audit, now: clock.now };
    const deps = {
      source: { read: async () => base }, rows, settings: configured, counters,
      reflect: { model: Object.assign(new ScriptedModel([reply(candidateJson({ type: "fact", evidenceSpanIds: ["S1"] }))]), { quote: async () => ({ ok: true as const, usd: 0.02 }) }), spend: new Spend(), audit, settings: configured, edition: "public" as const, now: clock.now },
      process,
    };
    await learnFromEndedTask(deps, merged);
    return (await store.duePending(KEY, clock.now() + 30 * 86_400_000, 100)).map((entry) => [entry.key, entry.weight] as const).sort();
  }

  it("the merged change's files decide who is credited: a lesson in an untouched area gets nothing, the touched one the whole credit", async () => {
    const lessons: Array<[string, { repos: string[]; paths: string[] }]> = [["les_billing1", { repos: ["api"], paths: ["src/billing/**"] }], ["les_search01", { repos: ["api"], paths: ["src/search/**"] }]];
    expect(await ended(baseOf({ touchedPaths: ["src/billing/money.ts"], touchedRepos: ["api"] }), lessons)).toEqual([["helpful:task-1:les_billing1", 1]]);
  });

  it("the repositories travel with the files: a lesson about web is not credited for a change that reached only api", async () => {
    const lessons: Array<[string, { repos: string[]; paths: string[] }]> = [["les_apilesn1", { repos: ["api"], paths: ["src/**"] }], ["les_weblesn1", { repos: ["web"], paths: ["src/**"] }]];
    expect(await ended(baseOf({ touchedPaths: ["src/a.ts"], touchedRepos: ["api"] }), lessons)).toEqual([["helpful:task-1:les_apilesn1", 1]]);
  });

  it("no list from the source: exactly the old credit (each loaded lesson 1/k, nobody excluded for overlap)", async () => {
    const lessons: Array<[string, { repos: string[]; paths: string[] }]> = [["les_billing1", { repos: ["api"], paths: ["src/billing/**"] }], ["les_search01", { repos: ["api"], paths: ["src/search/**"] }]];
    expect(await ended(baseOf(), lessons)).toEqual([["helpful:task-1:les_billing1", 0.5], ["helpful:task-1:les_search01", 0.5]]);
  });
});
