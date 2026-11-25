// W1: the merge-tracking sweep's budgets, fairness, settle and rate-limit rules. The three reads of a row (verify, feedback, reconcile) are replaced by hooks so a test can make any of them stall, fail or answer.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HostRateLimitError, change, type ReadBudget } from "@agentx/contracts";
import { host, ORG } from "../support/service-host.js";
import { TASK_ID } from "../support/merge-world.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";
import { recoveryRowKey } from "../../packages/broker/src/core/merge/store.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { fixedCodeSettings } from "../../packages/broker/src/core/merge/defaults.js";
import { createMergeTrackingService, createMilestoneService, wakeMergeTracking, DUE_CANDIDATES_MAX, SWEEP_MAX_ROWS } from "../../packages/broker/src/services/merge-tracking.js";
import type * as ChangedFilesModule from "../../packages/broker/src/core/build-step/changed-files.js";
import type * as FeedbackServiceModule from "../../packages/broker/src/core/pr-feedback/service.js";
import type * as MergeTrackingModule from "../../packages/broker/src/core/merge/merge-tracking.js";
import { instrumentGithubFetch, githubRequestContext, withGithubRequestContext } from "../../packages/broker/src/plugins/code-host/github/request-context.js";

type Hooks = {
  verify?: (taskId: string, beforeRequest: () => void) => Promise<"verified" | "unavailable">;
  feedback?: (taskId: string, budget: ReadBudget) => Promise<"unchanged" | "collected" | "retry">;
  reconcile?: (taskId: string, budget: ReadBudget) => Promise<{ kind: "OBSERVED"; nextAt?: number } | { kind: "RETRY"; retryAt: number; scope: "task" | "github-global" }>;
};
const hooks = vi.hoisted((): { current: Hooks } => ({ current: {} }));

vi.mock("../../packages/broker/src/core/build-step/changed-files.js", async (importOriginal) => ({
  ...await importOriginal<typeof ChangedFilesModule>(),
  verifyPublishedChanges: (_flow: unknown, task: { taskId: string }, beforeRequest?: () => void) => hooks.current.verify === undefined ? Promise.resolve("verified" as const) : hooks.current.verify(task.taskId, beforeRequest ?? (() => undefined)),
}));
vi.mock("../../packages/broker/src/core/pr-feedback/service.js", async (importOriginal) => ({
  ...await importOriginal<typeof FeedbackServiceModule>(),
  collectTrackedFeedback: (_deps: unknown, task: { taskId: string }, budget: ReadBudget) => hooks.current.feedback === undefined ? Promise.resolve("unchanged" as const) : hooks.current.feedback(task.taskId, budget),
}));
vi.mock("../../packages/broker/src/core/merge/merge-tracking.js", async (importOriginal) => ({
  ...await importOriginal<typeof MergeTrackingModule>(),
  reconcileTrackingTask: (_deps: unknown, taskId: string, budget: ReadBudget) => hooks.current.reconcile === undefined ? Promise.resolve({ kind: "OBSERVED" as const }) : hooks.current.reconcile(taskId, budget),
}));

beforeEach(() => { hooks.current = {}; });
afterEach(() => { hooks.current = {}; });

/** Waits until the phase that runs this read is ended by its own signal (what a hung GitHub request does under the request context). */
const stallUntilPhaseEnds = (): Promise<never> => new Promise((_resolve, reject) => {
  const signal = githubRequestContext()?.signal;
  if (signal === undefined) { reject(new Error("no phase signal")); return; }
  if (signal.aborted) { reject(new Error("phase ended")); return; }
  signal.addEventListener("abort", () => reject(new Error("phase ended")));
});

/** The real verify catches a read that failed and says "unavailable" (a rate limit excepted). */
const stallVerify = (): Promise<"unavailable"> => stallUntilPhaseEnds().catch(() => "unavailable" as const);

async function world(options: { pollMs?: number; drift?: boolean } = {}) {
  const w = await host();
  // `drift`: the service's clock keeps running while the test waits (the harness clock is otherwise frozen, so a row's elapsed time would never show).
  const started = Date.now();
  const now = (): number => w.clock.ms + (options.drift === true ? Date.now() - started : 0);
  const entries: Array<Record<string, unknown>> = [];
  const tracking = createMergeTrackingService({
    flow: w.h.deps, registry: w.registry, companyId: ORG, milestones: createMilestoneService({ store: w.h.store, now }), people: w.people,
    settings: fixedCodeSettings({ allowSelfApproval: true, mergeMethod: "squash", codeReviewers: [], revision: 1 }), now,
    requestScope: withGithubRequestContext, log: (entry) => entries.push(entry), ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  });
  const taskIds: string[] = [TASK_ID];
  const addTasks = async (count: number): Promise<string[]> => {
    const meta = (await w.h.store.get(taskKey(TASK_ID)))!;
    const added: string[] = [];
    for (let n = 0; n < count; n += 1) {
      const id = `${String(n + 10).padStart(2, "0")}000000-0000-4000-8000-000000000000`;
      const workflow = JSON.parse(JSON.stringify(meta["workflow"])) as { taskId: string };
      await w.h.store.put({ item: { ...meta, ...taskKey(id), taskId: id, workflow: { ...workflow, taskId: id } } });
      // The sweep reads only tasks that carry the core's mark (D1-2).
      await w.h.store.put({ item: { ...(await w.h.store.get(engineStampKey(TASK_ID)))!, ...engineStampKey(id), taskId: id } });
      await w.h.store.put({ item: { ...recoveryRowKey(id), entityType: "WORKFLOW_MERGE_RECOVERY", kind: "tracking", taskId: id, nextAttemptAt: 0 } });
      added.push(id);
    }
    taskIds.push(...added);
    return added;
  };
  const row = async (taskId: string) => (await w.h.store.get(recoveryRowKey(taskId)))!;
  return { ...w, tracking, entries, addTasks, row };
}

it("a verify read that hangs ends at its own phase: the row settles with a truthful 'GitHub read incomplete', attempts advance, reconcile still runs, and the next pass completes", async () => {
  const w = await world();
  const seen: string[] = [];
  hooks.current.verify = stallVerify;
  hooks.current.reconcile = async (taskId, budget) => { seen.push(`${taskId}:${String(budget.signal.aborted)}`); return { kind: "OBSERVED" }; };
  const at = w.clock.ms;
  const started = Date.now();
  expect(await w.tracking.sweep({ budgetMs: 1_000 })).toEqual({ attempted: 1 });
  expect(Date.now() - started).toBeLessThan(900);
  // Reconcile ran, on a budget the stalled verify had not spent.
  expect(seen).toEqual([`${TASK_ID}:false`]);
  expect(await w.row(TASK_ID)).toMatchObject({ attempts: 1, readState: "github_read_incomplete", lastAttemptAt: at, nextAttemptAt: at + 60_000 });
  w.clock.ms += 61_000;
  hooks.current.verify = async () => "verified";
  await w.tracking.sweep({ budgetMs: 1_000 });
  const done = await w.row(TASK_ID);
  expect(done).toMatchObject({ attempts: 0, lastAttemptAt: w.clock.ms });
  expect(done["readState"]).toBeUndefined();
});

it("a feedback read that is slow, fails or says retry never blocks tracking: reconcile runs, the row keeps one poll, and feedback catches up", async () => {
  for (const kind of ["retry", "throws", "stalls"] as const) {
    const w = await world();
    const reconciled: string[] = [];
    hooks.current.feedback = kind === "retry" ? async () => "retry" : kind === "throws" ? async () => { throw new Error("feedback broke"); } : () => stallUntilPhaseEnds();
    hooks.current.reconcile = async (taskId) => { reconciled.push(taskId); return { kind: "OBSERVED" }; };
    const at = w.clock.ms;
    await w.tracking.sweep({ budgetMs: 1_000 });
    expect(reconciled, kind).toEqual([TASK_ID]);
    expect(await w.row(TASK_ID), kind).toMatchObject({ attempts: 0, readState: "feedback_incomplete", nextAttemptAt: at + 60_000 });
    expect(w.entries.some((entry) => entry["event"] === "sweep.feedback_failed") , kind).toBe(kind !== "retry");
    // Feedback catches up on the next pass: the row is read again and the state clears.
    w.clock.ms += 61_000;
    hooks.current.feedback = async () => "unchanged";
    await w.tracking.sweep({ budgetMs: 1_000 });
    expect((await w.row(TASK_ID))["readState"], kind).toBeUndefined();
    expect(reconciled, kind).toHaveLength(2);
  }
});

it("a rate limit during feedback still pauses the sweep until the time GitHub named", async () => {
  const w = await world();
  const until = w.clock.ms + 600_000;
  hooks.current.feedback = async () => { throw new HostRateLimitError(until); };
  await w.tracking.sweep({ budgetMs: 1_000 });
  expect(w.tracking.pausedUntil()).toBe(until);
  expect(await w.row(TASK_ID)).toMatchObject({ attempts: 1, nextAttemptAt: until });
});

it("the three phases never take each other's time: a stalled verify and a stalled feedback leave reconcile its own live budget", async () => {
  const w = await world();
  let reconcileSignalLive: boolean | undefined;
  hooks.current.verify = stallVerify;
  hooks.current.feedback = () => stallUntilPhaseEnds();
  hooks.current.reconcile = async (_taskId, budget) => { reconcileSignalLive = !budget.signal.aborted; budget.beforeRequest(); return { kind: "OBSERVED" }; };
  await w.tracking.sweep({ budgetMs: 1_200 });
  expect(reconcileSignalLive).toBe(true);
  expect(await w.row(TASK_ID)).toMatchObject({ readState: "github_read_incomplete", attempts: 1 });
});

it("more due rows than one sweep takes: ten stuck rows cannot starve the healthy ones, which are tracked within the next pass", async () => {
  const w = await world({ drift: true });
  const others = await w.addTasks(12);
  const all = [TASK_ID, ...others];
  expect(all.length).toBeGreaterThan(SWEEP_MAX_ROWS);
  const stuck = new Set([...all].sort().slice(0, SWEEP_MAX_ROWS));
  const healthy = all.filter((id) => !stuck.has(id));
  expect(healthy.length).toBeGreaterThan(0);
  const tracked: string[] = [];
  hooks.current.verify = (taskId) => stuck.has(taskId) ? stallVerify() : Promise.resolve("verified");
  hooks.current.reconcile = async (taskId) => { if (stuck.has(taskId)) await stallUntilPhaseEnds(); tracked.push(taskId); return { kind: "OBSERVED" }; };
  expect(await w.tracking.sweep({ budgetMs: 2_000 })).toEqual({ attempted: SWEEP_MAX_ROWS });
  expect(tracked.filter((id) => healthy.includes(id))).toEqual([]);
  for (const id of stuck) expect(await w.row(id)).toMatchObject({ attempts: 1, lastAttemptAt: expect.any(Number) as number });
  // The next pass (the stuck rows' one-poll wait is over): the healthy rows come first.
  w.clock.ms += 61_000;
  await w.tracking.sweep({ budgetMs: 2_000 });
  expect(tracked.slice(0, healthy.length).sort()).toEqual([...healthy].sort());
  for (const id of healthy) expect((await w.row(id))["attempts"]).toBe(0);
});

it("orders the due rows by failed attempts, then by the longest since the last attempt (round robin), whatever their keys", async () => {
  const w = await world();
  const [a, b, c] = await w.addTasks(3);
  const set = (id: string, attempts: number, lastAttemptAt: number) => w.h.store.update({ key: recoveryRowKey(id), ops: [change.set("attempts", attempts), change.set("lastAttemptAt", lastAttemptAt), change.set("nextAttemptAt", 0)] });
  await set(TASK_ID, 3, 100);
  await set(a!, 0, 900);
  await set(b!, 0, 200);
  await set(c!, 1, 50);
  const order: string[] = [];
  hooks.current.reconcile = async (taskId) => { order.push(taskId); return { kind: "OBSERVED" }; };
  await w.tracking.sweep({ budgetMs: 2_000 });
  expect(order).toEqual([b, a, c, TASK_ID]);
});

it("reads at most DUE_CANDIDATES_MAX owned due rows before it picks, and still tracks only SWEEP_MAX_ROWS", async () => {
  const w = await world();
  await w.addTasks(DUE_CANDIDATES_MAX + 5);
  const order: string[] = [];
  hooks.current.reconcile = async (taskId) => { order.push(taskId); return { kind: "OBSERVED" }; };
  expect(await w.tracking.sweep({ budgetMs: 3_000 })).toEqual({ attempted: SWEEP_MAX_ROWS });
  expect(order).toHaveLength(SWEEP_MAX_ROWS);
});

// D1-2 (ruling g): a task of the retired old workflow (same company, an open pull request, a WORKFLOW_MERGE_RECOVERY row, no core mark) is left exactly as it is: the sweep neither reads GitHub
// for it nor settles or deletes its row.
it("leaves an old task's row alone: no mark, the same company, an open pull request: nothing is observed, nothing is written, the row stays", async () => {
  const w = await world();
  const [old, marked] = await w.addTasks(2);
  await w.h.store.delete({ key: engineStampKey(old!) });
  const before = JSON.stringify(await w.row(old!));
  const seen: string[] = [];
  hooks.current.reconcile = async (taskId) => { seen.push(taskId); return { kind: "OBSERVED" }; };
  const writes: unknown[] = [];
  const put = vi.spyOn(w.h.store, "update"); const del = vi.spyOn(w.h.store, "delete"); const tx = vi.spyOn(w.h.store, "transact");
  // The harness task itself and the marked one are tracked; the old one is not even attempted.
  expect(await w.tracking.sweep({ budgetMs: 3_000 })).toEqual({ attempted: 2 });
  expect(seen.sort()).toEqual([TASK_ID, marked!].sort());
  expect(seen).not.toContain(old!);
  expect(JSON.stringify(await w.row(old!))).toBe(before);
  expect(await w.h.store.get(recoveryRowKey(old!))).toBeDefined();
  for (const call of [...put.mock.calls, ...del.mock.calls, ...tx.mock.calls]) writes.push(JSON.stringify(call).includes(old!) ? call : undefined);
  expect(writes.filter((call) => call !== undefined)).toEqual([]);
});

it("a wake does not skip a failing row's backoff, only lowers, and always records its time", async () => {
  const w = await world();
  const [healthy, failing, longAgo, dueNow] = await w.addTasks(4);
  const now = w.clock.ms;
  const put = (id: string, fields: Record<string, number>) => w.h.store.update({ key: recoveryRowKey(id), ops: Object.entries(fields).map(([name, value]) => change.set(name, value)) });
  await put(healthy!, { nextAttemptAt: now + 240_000, attempts: 0 });
  await put(failing!, { nextAttemptAt: now + 170_000, attempts: 3, lastAttemptAt: now - 10_000 });
  await put(longAgo!, { nextAttemptAt: now + 500_000, attempts: 3, lastAttemptAt: now - 300_000 });
  await put(dueNow!, { nextAttemptAt: now - 5_000, attempts: 3, lastAttemptAt: now - 1_000 });
  for (const id of [healthy!, failing!, longAgo!, dueNow!]) await w.tracking.wake(id);
  expect(await w.row(healthy!)).toMatchObject({ nextAttemptAt: now, lastHintAt: now });
  // Failing, last tried 10 s ago, 3 failures = a 180 s wait: the wake leaves it at its own earlier time and never moves it forward.
  expect(await w.row(failing!)).toMatchObject({ nextAttemptAt: now + 170_000, lastHintAt: now });
  expect(await w.row(longAgo!)).toMatchObject({ nextAttemptAt: now, lastHintAt: now });
  expect((await w.row(dueNow!))["nextAttemptAt"]).toBe(now - 5_000);
  // A failing row whose wait is still running is not made due by the wake; the person-initiated caller can ask for it.
  await put(failing!, { nextAttemptAt: now + 900_000, attempts: 3, lastAttemptAt: now - 10_000 });
  await w.tracking.wake(failing!);
  expect((await w.row(failing!))["nextAttemptAt"]).toBe(now + 170_000);
  await put(failing!, { nextAttemptAt: now + 900_000 });
  await wakeMergeTracking(w.h.store, failing!, now, { bypassBackoff: true });
  expect((await w.row(failing!))["nextAttemptAt"]).toBe(now);
  // A wake of a task with no tracking row, or a row of another kind, writes nothing.
  await wakeMergeTracking(w.h.store, "99999999-9999-4999-8999-999999999999", now);
  expect(await w.h.store.get(recoveryRowKey("99999999-9999-4999-8999-999999999999"))).toBeUndefined();
});

it("a hint that arrives while a pass reads the row is merged: the pass's write keeps it, for a clean pass and for a failing one", async () => {
  for (const failing of [false, true]) {
    const w = await world();
    const at = w.clock.ms;
    hooks.current.verify = async () => { w.clock.ms += 5_000; await w.tracking.wake(TASK_ID); return failing ? "unavailable" : "verified"; };
    await w.tracking.sweep({ budgetMs: 1_000 });
    const row = await w.row(TASK_ID);
    expect(row["lastHintAt"], String(failing)).toBe(at + 5_000);
    if (failing) expect(row, "failing keeps its wait").toMatchObject({ attempts: 1, nextAttemptAt: at + 5_000 + 60_000, lastAttemptAt: at + 5_000 });
    else expect(row, "clean: due again at once").toMatchObject({ attempts: 0, nextAttemptAt: at + 5_000, quiet: 0 });
  }
  // Control: no hint, the normal wait.
  const w = await world();
  const at = w.clock.ms;
  await w.tracking.sweep({ budgetMs: 1_000 });
  expect((await w.row(TASK_ID))["nextAttemptAt"]).toBe(at + 60_000);
});

it("a settle that cannot write is logged and counted, never swallowed, and the sweep goes on", async () => {
  const w = await world();
  const [other] = await w.addTasks(1);
  const update = w.h.store.update.bind(w.h.store);
  vi.spyOn(w.h.store, "update").mockImplementation(async (request) => {
    if (request.key.pk === "WORKFLOW_MERGE_RECOVERY") throw new Error("write refused");
    return update(request);
  });
  expect(await w.tracking.sweep({ budgetMs: 1_000 })).toEqual({ attempted: 2 });
  const failed = w.entries.filter((entry) => entry["event"] === "sweep.settle_failed");
  // Two attempts per row (the guarded write, then the plain one) only when the guard failed; a throw is logged once per row.
  expect(failed.map((entry) => entry["taskId"]).sort()).toEqual([TASK_ID, other].sort());
  expect(failed.every((entry) => entry["error"] === "Error" && entry["component"] === "merge_tracking")).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("write refused");
});

it("rows the pass had no time for are logged as deferred", async () => {
  const w = await world();
  await w.addTasks(2);
  hooks.current.verify = async () => { w.clock.ms += 10_000; return "verified"; };
  expect(await w.tracking.sweep({ budgetMs: 1_000 })).toEqual({ attempted: 1 });
  expect(w.entries.find((entry) => entry["event"] === "sweep.rows_deferred")).toMatchObject({ deferred: 2 });
});

it("reads end before the pass does, so the settle writes of the last row always fit inside it", async () => {
  const w = await world();
  await w.addTasks(1);
  // The first row's reads end 900 ms into a 1000 ms pass: the 150 ms kept for settle writes is already inside them, so the second row is not started.
  hooks.current.verify = async () => { w.clock.ms += 900; return "verified"; };
  expect(await w.tracking.sweep({ budgetMs: 1_000 })).toEqual({ attempted: 1 });
  expect(w.entries.find((entry) => entry["event"] === "sweep.rows_deferred")).toMatchObject({ deferred: 1 });
});

/** A GitHub answer with the rate-limit headers `remaining` of `limit`, read inside the phase the way a client's fetch reads it. */
const readWithLimit = async (remaining: number, limit: number, resetAt: number): Promise<"verified"> => {
  const fetchImplementation = instrumentGithubFetch(async () => new Response("{}", { headers: { "x-ratelimit-remaining": String(remaining), "x-ratelimit-limit": String(limit), "x-ratelimit-reset": String(Math.floor(resetAt / 1000)) } }));
  await fetchImplementation("https://api.github.com/repos/acme/app/pulls/1");
  return "verified";
};

it("pauses the background sweep at the rate-limit reserve (5 % of the limit, at least 200), until X-RateLimit-Reset, and not at ten requests", async () => {
  const cases: Array<{ remaining: number; paused: boolean }> = [
    { remaining: 10, paused: true }, { remaining: 240, paused: true }, { remaining: 249, paused: true }, { remaining: 250, paused: false }, { remaining: 400, paused: false }, { remaining: 4_000, paused: false },
  ];
  for (const { remaining, paused } of cases) {
    const w = await world();
    await w.addTasks(1);
    const resetAt = Math.floor((w.clock.ms + 900_000) / 1000) * 1000;
    hooks.current.verify = () => readWithLimit(remaining, 5_000, resetAt);
    const report = await w.tracking.sweep({ budgetMs: 2_000 });
    expect(report.attempted, `remaining ${remaining}`).toBe(paused ? 1 : 2);
    expect(w.tracking.pausedUntil(), `remaining ${remaining}`).toBe(paused ? resetAt : undefined);
    if (paused) {
      expect(w.entries.find((entry) => entry["event"] === "sweep.rate_reserve")).toMatchObject({ resetAt });
      // The pause is kept, so the next pass (even a new process) does not ask GitHub again before the reset.
      expect(await w.h.store.get({ pk: "WORKFLOW_MERGE_SWEEP", sk: "COOLDOWN" })).toMatchObject({ until: resetAt });
      expect(await w.tracking.sweep({ budgetMs: 2_000 })).toEqual({ attempted: 0 });
    }
  }
});

it("times every request of the sweep: method, a template without ids, status, milliseconds, rate-limit headers", async () => {
  const w = await world();
  const resetAt = Math.floor((w.clock.ms + 900_000) / 1000) * 1000;
  hooks.current.verify = () => readWithLimit(4_900, 5_000, resetAt);
  await w.tracking.sweep({ budgetMs: 1_000 });
  expect(w.entries.find((entry) => entry["event"] === "github.request")).toMatchObject({ method: "GET", pathTemplate: "/repos/:owner/:repo/pulls/:id", status: 200, remaining: 4_900, limit: 5_000, resetAt });
});

it("REVIEW (Opus W1): the reserve never falls below 200 requests, even when 5 % of the limit is less (a 1,000-request installation pauses at 150 left)", async () => {
  for (const { remaining, paused } of [{ remaining: 150, paused: true }, { remaining: 199, paused: true }, { remaining: 200, paused: false }]) {
    const w = await world();
    await w.addTasks(1);
    const resetAt = Math.floor((w.clock.ms + 900_000) / 1000) * 1000;
    hooks.current.verify = () => readWithLimit(remaining, 1_000, resetAt);
    await w.tracking.sweep({ budgetMs: 2_000 });
    expect(w.tracking.pausedUntil(), `remaining ${remaining} of 1000`).toBe(paused ? resetAt : undefined);
  }
});
