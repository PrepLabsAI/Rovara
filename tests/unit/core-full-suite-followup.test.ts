// TE-C3 part A: the full suite after the draft, in Code's core on the document store. One follow-up per task and commit, a daily cap per project, the budget's say, a newer commit superseding,
// results accepted once for the commit they name, a Rovara fault never read as a failed suite, and the words and facts the pull request, the merge card and the "Rovara" Check read.
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { agentXError, type OrgId } from "../../packages/contracts/src/index.js";
import {
  FOLLOWUP_DAILY_CAP, FOLLOWUP_MAX_RUN_MS, checkFullSuiteOf, followupLine, fullSuiteMergeGate, fullSuiteStateOf, markFollowupRunning, needsFullSuiteFollowup, queueFullSuiteFollowup, readFollowup,
  recordFollowupResult, followupAtPublication, fullSuiteCheckFact, type FollowupDeps,
} from "../../packages/broker/src/core/proof/full-suite-followup.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const D1 = "1".repeat(64);
const D2 = "2".repeat(64);
const H1 = "a".repeat(40);
const H2 = "b".repeat(40);

function deps(over: Partial<FollowupDeps> = {}) {
  const now = { value: T0 };
  const admitted: string[] = [];
  const store = new MemoryDocumentStore({ ttlAttribute: "indexExpiresAt" });
  const d: FollowupDeps = { store, now: () => now.value, admit: async (input) => { admitted.push(input.taskId); }, ...over };
  return { d, now, admitted, store };
}
const at = (orgId: OrgId = ORG, taskId = "task-1", digest = D1, head = H1) => ({ orgId, project: "web", taskId, candidateDigest: digest, headSha: head });
const PASSED = { outcome: "completed" as const, passed: 412, failed: 0, total: 412, flaky: 0, finishedAt: "2026-11-15T10:40:00.000Z" };
const FAILED = { outcome: "completed" as const, passed: 410, failed: 2, total: 412, flaky: 1, finishedAt: "2026-11-15T10:40:00.000Z" };

describe("whether a follow-up is needed", () => {
  const done = [{ after: "passed" as const }];
  it("the whole suite ran and finished: not needed", () => {
    expect(needsFullSuiteFollowup({ selection: { method: "full", selected: 412, total: 412 }, testChecks: done })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: { method: "coverage_map", selected: 412, total: 412 }, testChecks: done })).toBe(false);
  });
  it("no selection, or a selection that does not add up: not needed (never a guess)", () => {
    expect(needsFullSuiteFollowup({ selection: undefined, testChecks: done })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: { method: "coverage_map", selected: 13, total: 12 }, testChecks: done })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: { method: "coverage_map", selected: -1, total: 12 } as never, testChecks: done })).toBe(false);
    expect(needsFullSuiteFollowup({ selection: { method: "made_up", selected: 1, total: 12 } as never, testChecks: done })).toBe(false);
  });
});

describe("queueing", () => {
  it("the project's daily cap: the run past it is not queued and says why", async () => {
    const { d } = deps();
    for (let index = 0; index < FOLLOWUP_DAILY_CAP; index += 1) expect((await queueFullSuiteFollowup(d, at(ORG, `task-${String(index)}`))).queued).toBe(true);
    expect(await queueFullSuiteFollowup(d, at(ORG, "task-over"))).toEqual({ queued: false, reason: "daily_cap" });
    expect(await readFollowup(d, at(ORG, "task-over"))).toBeUndefined();
  });
  it("one past the longest run is queued again by a replay, and nothing late is taken for the old run", async () => {
    const { d, now } = deps();
    await queueFullSuiteFollowup(d, at());
    now.value += FOLLOWUP_MAX_RUN_MS + 1;
    expect(await markFollowupRunning(d, at())).toBe(false);
    expect(await recordFollowupResult(d, { ...at(), result: PASSED })).toBe(false);
    expect(await queueFullSuiteFollowup(d, at())).toEqual({ queued: true, replayed: false });
    expect(await recordFollowupResult(d, { ...at(), result: PASSED })).toBe(true);
  });
  it("the same after an older commit's run expired", async () => {
    const { d, now } = deps();
    await queueFullSuiteFollowup(d, at());
    await queueFullSuiteFollowup(d, at(ORG, "task-1", D2, H2));
    now.value += FOLLOWUP_MAX_RUN_MS + 1;
    expect(await queueFullSuiteFollowup(d, at())).toEqual({ queued: true, replayed: true });
    expect((await readFollowup(d, at()))?.state).toBe("superseded");
  });
  it("a re-queue that races a newer commit taking the pointer neither runs the old commit nor takes the pointer back", async () => {
    const { d, store, now } = deps();
    await queueFullSuiteFollowup(d, at());
    await recordFollowupResult(d, { ...at(), result: { outcome: "rovara_problem", finishedAt: "2026-11-15T10:40:00.000Z" } });
    now.value += 1_000;
    let first = true;
    const racing: FollowupDeps = { ...d, store: { get: store.get.bind(store), update: store.update.bind(store), transact: async (items) => {
      // Between this call's pointer read and its write, a newer commit is queued.
      if (first) { first = false; now.value -= 500; await queueFullSuiteFollowup(d, at(ORG, "task-1", D2, H2)); now.value += 500; }
      return store.transact(items);
    } } };
    expect((await queueFullSuiteFollowup(racing, at())).queued).toBe(false);
    expect((await readFollowup(d, at()))?.state).toBe("errored");
    expect((await readFollowup(d, at(ORG, "task-1", D2, H2)))?.state).toBe("queued");
  });
  it("a charge for a run that did not queue is given back: a lost race and a store fault", async () => {
    const released: string[] = [];
    const lost = deps({ release: async (input) => { released.push(input.taskId); } });
    const raced = { ...lost.d, store: { get: lost.store.get.bind(lost.store), update: lost.store.update.bind(lost.store), transact: async () => ({ applied: false as const, reason: "condition_failed" as const, failed: [2] }) } } as FollowupDeps;
    expect(await queueFullSuiteFollowup(raced, at())).toEqual({ queued: false, reason: "unavailable" });
    const broken = { ...lost.d, store: { get: lost.store.get.bind(lost.store), update: lost.store.update.bind(lost.store), transact: async () => { throw new Error("down"); } } } as FollowupDeps;
    await expect(queueFullSuiteFollowup(broken, at(ORG, "task-2"))).rejects.toThrow("down");
    expect(released).toEqual(["task-1", "task-2"]);
  });
  it("a race lost to the same follow-up reads as queued (replayed), not as a Rovara problem", async () => {
    const { d, store } = deps();
    let first = true;
    const racing = { ...d, store: { get: store.get.bind(store), update: store.update.bind(store), transact: async (items: Parameters<typeof store.transact>[0]) => {
      if (first) { first = false; await queueFullSuiteFollowup(d, at()); }
      return store.transact(items);
    } } } satisfies FollowupDeps;
    expect(await queueFullSuiteFollowup(racing, at())).toEqual({ queued: true, replayed: true });
  });
  it("two commits whose digests share the stored prefix are refused, never mixed up", async () => {
    const { d } = deps();
    await queueFullSuiteFollowup(d, at());
    await expect(queueFullSuiteFollowup(d, at(ORG, "task-1", "1".repeat(16) + "f".repeat(48), H2))).rejects.toThrow(/^CONFIG_INVALID: the follow-up names a commit another/u);
  });
  it("the budget says no: not queued, reason budget; any other error goes on up", async () => {
    const refused = deps({ admit: async () => { throw agentXError("PROJECT_BUDGET_EXCEEDED", "no room"); } });
    expect(await queueFullSuiteFollowup(refused.d, at())).toEqual({ queued: false, reason: "budget" });
    const broken = deps({ admit: async () => { throw new Error("store down"); } });
    await expect(queueFullSuiteFollowup(broken.d, at())).rejects.toThrow("store down");
  });
  it.each([
    ["a bad digest", { candidateDigest: "x" }],
    ["a bad head", { headSha: "abc" }],
    ["a task id with a separator", { taskId: "a#b" }],
    ["a project with a separator", { project: "w#b" }],
  ])("refuses %s with fixed words", async (_label, over) => {
    const { d } = deps();
    await expect(queueFullSuiteFollowup(d, { ...at(), ...over })).rejects.toThrow(/^CONFIG_INVALID: the follow-up names/u);
  });
});

describe("results", () => {
  it("running, then passed: accepted once", async () => {
    const { d } = deps();
    await queueFullSuiteFollowup(d, at());
    expect(await markFollowupRunning(d, at())).toBe(true);
    expect(await recordFollowupResult(d, { ...at(), result: PASSED })).toBe(true);
    expect(await recordFollowupResult(d, { ...at(), result: FAILED })).toBe(false);
    expect(await readFollowup(d, at())).toMatchObject({ state: "passed", result: { passed: 412, total: 412 } });
  });
  it("a run Rovara could not finish (its own fault) is 'errored', never a failed suite", async () => {
    const { d } = deps();
    await queueFullSuiteFollowup(d, at());
    await recordFollowupResult(d, { ...at(), result: { outcome: "rovara_problem", finishedAt: "2026-11-15T10:40:00.000Z" } });
    const view = await readFollowup(d, at());
    expect(view?.state).toBe("errored");
    expect(checkFullSuiteOf(view, true)).toBe("not_run");
    expect(fullSuiteStateOf(view, true)).toBe("not_run");
  });
  it("a newer commit supersedes: the older follow-up's result is refused and it reads superseded", async () => {
    const { d } = deps();
    await queueFullSuiteFollowup(d, at());
    await queueFullSuiteFollowup(d, at(ORG, "task-1", D2, H2));
    expect(await recordFollowupResult(d, { ...at(), result: PASSED })).toBe(false);
    expect((await readFollowup(d, at()))?.state).toBe("superseded");
    expect((await readFollowup(d, at(ORG, "task-1", D2, H2)))?.state).toBe("queued");
  });
  it.each([
    ["counts that do not add up", { ...PASSED, total: 411 }],
    ["no tests", { ...PASSED, passed: 0, total: 0 }],
    ["a negative count", { ...PASSED, failed: -1, total: 411 }],
    ["more flaky than total", { ...PASSED, flaky: 413 }],
    ["a bad time", { ...PASSED, finishedAt: "soon" }],
    ["an unknown outcome", { ...PASSED, outcome: "maybe" }],
  ])("refuses %s with fixed words, never a guessed pass", async (_label, result) => {
    const { d } = deps();
    await queueFullSuiteFollowup(d, at());
    await expect(recordFollowupResult(d, { ...at(), result: result as never })).rejects.toThrow(/^CONFIG_INVALID: the full run's result/u);
    expect((await readFollowup(d, at()))?.state).toBe("queued");
  });
  it("one that waited past the longest run reads expired, never passed", async () => {
    const { d, now } = deps();
    await queueFullSuiteFollowup(d, at());
    now.value += FOLLOWUP_MAX_RUN_MS + 1;
    expect((await readFollowup(d, at()))?.state).toBe("expired");
    expect(checkFullSuiteOf(await readFollowup(d, at()), true)).toBe("not_run");
  });
});

describe("what the pull request, the Check and the merge card read", () => {
  const view = (state: string) => ({ state, candidateDigest: D1, headSha: H1, queuedAt: "2026-11-15T10:00:00.000Z", ...(state === "passed" ? { result: PASSED } : state === "failed" ? { result: FAILED } : {}) }) as never;
  it("the Check's full-suite fact", () => {
    expect(checkFullSuiteOf(undefined, false)).toBe("not_needed");
    expect(checkFullSuiteOf(undefined, true)).toBe("not_run");
    expect(checkFullSuiteOf(view("queued"), true)).toBe("pending");
    expect(checkFullSuiteOf(view("running"), true)).toBe("pending");
    expect(checkFullSuiteOf(view("passed"), true)).toBe("passed");
    expect(checkFullSuiteOf(view("failed"), true)).toBe("failed");
    expect(checkFullSuiteOf(view("superseded"), true)).toBe("not_run");
    expect(checkFullSuiteOf(view("errored"), true)).toBe("not_run");
    expect(checkFullSuiteOf(view("expired"), true)).toBe("not_run");
  });
  it("the pull request's testing row state", () => {
    expect(fullSuiteStateOf(undefined, false)).toBe("not_needed");
    expect(fullSuiteStateOf(view("queued"), true)).toBe("pending");
    expect(fullSuiteStateOf(view("passed"), true)).toBe("not_needed");
    expect(fullSuiteStateOf(view("failed"), true)).toBeUndefined();
    expect(fullSuiteStateOf(view("superseded"), true)).toBe("not_run");
    expect(fullSuiteStateOf(undefined, true)).toBe("not_run");
  });
  it("the line: counts and fixed words only", () => {
    expect(followupLine(view("queued"), undefined)).toContain("pending");
    expect(followupLine(view("passed"), undefined)).toBe("Full suite: passed on this commit (412 of 412).");
    expect(followupLine(view("failed"), undefined)).toContain("2 of 412 failing");
    expect(followupLine(view("errored"), undefined)).toContain("Rovara could not finish");
    expect(followupLine(undefined, { queued: false, reason: "daily_cap" })).toBe("Full suite: not run today (project cap 20 reached).");
    expect(followupLine(undefined, { queued: false, reason: "unavailable" })).toContain("a Rovara problem");
    expect(followupLine(undefined, { queued: false, reason: "budget" })).toContain("budget");
    expect(followupLine(undefined, undefined)).toBeUndefined();
  });
  it("the merge card: pending is medium (or blocked by policy), failed is high and blocked, a Rovara fault is never high", () => {
    const gate = (state: string | undefined, policy: "allow_pending" | "block_until_passed" = "allow_pending") => fullSuiteMergeGate({ policy, followup: state === undefined ? undefined : view(state), needed: true, baseRisk: "low" });
    expect(gate("queued")).toEqual({ allowed: true, risk: "medium", reason: "pending" });
    expect(gate("queued", "block_until_passed").allowed).toBe(false);
    expect(gate("failed")).toEqual({ allowed: false, risk: "high", reason: "failed" });
    for (const state of ["errored", "expired", "superseded", undefined]) {
      for (const policy of ["allow_pending", "block_until_passed"] as const) expect(gate(state, policy), `${String(state)} ${policy}`).toEqual({ allowed: true, risk: "medium", reason: "rovara_problem" });
    }
    const limited = (reason: "daily_cap" | "budget" | "unavailable", policy: "allow_pending" | "block_until_passed") => fullSuiteMergeGate({ policy, followup: undefined, needed: true, baseRisk: "low", notQueued: { queued: false, reason } });
    expect(limited("daily_cap", "block_until_passed")).toEqual({ allowed: false, risk: "medium", reason: "not_run" });
    expect(limited("budget", "allow_pending")).toEqual({ allowed: true, risk: "medium", reason: "not_run" });
    expect(limited("unavailable", "block_until_passed")).toEqual({ allowed: true, risk: "medium", reason: "rovara_problem" });
    expect(gate("passed")).toEqual({ allowed: true, risk: "low", reason: "passed" });
    expect(fullSuiteMergeGate({ policy: "allow_pending", followup: undefined, needed: false, baseRisk: "high" })).toEqual({ allowed: true, risk: "high", reason: "none_needed" });
  });
});

describe("the seams part B calls", () => {
  const affected = { method: "coverage_map" as const, selected: 12, total: 412 };
  it("at publication: affected tests only -> queued, the row says pending, with its line", async () => {
    const { d } = deps();
    const out = await followupAtPublication(d, { ...at(), selection: affected, testChecks: [{ after: "passed" }] });
    expect(out).toMatchObject({ needed: true, queued: { queued: true }, fullSuite: "pending" });
    expect(out.line).toContain("pending");
    expect(await fullSuiteCheckFact(d, { ...at(), needed: true })).toBe("pending");
  });
  it("at publication: the whole suite ran -> nothing queued, nothing said", async () => {
    const { d, admitted } = deps();
    expect(await followupAtPublication(d, { ...at(), selection: { method: "full", selected: 412, total: 412 }, testChecks: [{ after: "passed" }] })).toEqual({ needed: false, fullSuite: "not_needed" });
    expect(admitted).toEqual([]);
  });
  it("at publication over the cap: the row says not run, with the cap's line", async () => {
    const { d } = deps();
    for (let index = 0; index < FOLLOWUP_DAILY_CAP; index += 1) await queueFullSuiteFollowup(d, at(ORG, `task-${String(index)}`));
    const out = await followupAtPublication(d, { ...at(ORG, "task-over"), selection: affected, testChecks: [] });
    expect(out).toMatchObject({ needed: true, queued: { queued: false, reason: "daily_cap" }, fullSuite: "not_run" });
    expect(out.line).toContain("project cap 20 reached");
  });
  it("at publication a store fault is 'not queued: a Rovara problem', never pending and never thrown", async () => {
    const { d } = deps();
    const broken = { ...d, store: { ...d.store, get: d.store.get.bind(d.store), update: d.store.update.bind(d.store), transact: async () => { throw new Error("down"); } } } as FollowupDeps;
    const out = await followupAtPublication(broken, { ...at(), selection: affected, testChecks: [] });
    expect(out).toMatchObject({ needed: true, queued: { queued: false, reason: "unavailable" }, fullSuite: "not_run" });
    expect(out.line).toContain("a Rovara problem");
  });
  it("at publication again after the follow-up failed: no testing view (never 'not run'), and the line says failed", async () => {
    const { d } = deps();
    await queueFullSuiteFollowup(d, at());
    await recordFollowupResult(d, { ...at(), result: FAILED });
    const out = await followupAtPublication(d, { ...at(), selection: affected, testChecks: [] });
    expect(out.fullSuite).toBeUndefined();
    expect(out.line).toContain("failed on this commit");
  });
  it("the Check's fact: a read that fails is not run (neutral), never passed", async () => {
    const { d } = deps();
    const broken = { ...d, store: { ...d.store, get: async () => { throw new Error("down"); } } } as FollowupDeps;
    expect(await fullSuiteCheckFact(broken, { ...at(), needed: true })).toBe("not_run");
    expect(await fullSuiteCheckFact(d, { ...at(), needed: false })).toBe("not_needed");
  });
});
