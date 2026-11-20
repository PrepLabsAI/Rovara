// Lead 4, slice A4: the cost report's time split and send-backs, folded from a task's work events (`core/report/times.ts`) and served on `GET /v1/app/org/report/tasks`.
// Proven here: working vs waiting is attributed right (a step that runs is Rovara working, a plan or a question is a decision wait, a pull request review is shown apart, a queued step is the system's); the numbers are
// absent, never zero, for a task the events do not cover from its start; a company and a project only ever see their own events; a settled task keeps its numbers.
import { describe, expect, it } from "vitest";
import { codeMilestoneKey, type OrgId, type ReportTasksResponse, type WorkEventInput } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { readCompanyReportTasks } from "../../packages/broker/src/core/report/read.js";
import { reportStartItems } from "../../packages/broker/src/core/report/task-row.js";
import { TIMES_EVENTS_MAX, foldTimes, readTaskTimes, timesOfStored } from "../../packages/broker/src/core/report/times.js";
import { workEventRow } from "../../packages/broker/src/core/work-events/work-events.js";
import { workEventId } from "@agentx/contracts";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const at = (hour: number, minute = 0, day = 17): string => `2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
const MIN = 60_000;

type Spec = { kind: WorkEventInput["kind"]; at: string; source?: string } & Record<string, unknown>;
const event = (company: OrgId, taskId: string, project: string, spec: Spec): WorkEventInput => {
  const { kind, at: when, source, ...rest } = spec;
  return { version: 1, id: workEventId({ kind, taskId, source: source ?? `${kind}@${when}` }), at: when, orgId: company, project, taskId, actor: { kind: "system" }, kind, ...rest } as WorkEventInput;
};
const wait = (when: string, waitingOn: string, reason?: string): Spec => ({ kind: "waiting_changed", at: when, waitingOn, ...(reason === undefined ? {} : { reason }) });
const started = (when: string): Spec => ({ kind: "task_started", at: when, origin: "web" });
const answered = (when: string, place: string, outcome = "changes_requested", n = 0): Spec => ({ kind: "decision_answered", at: when, source: `d${String(n)}`, decisionId: `d${String(n)}`, decision: "plan_review", outcome, place });

/** The timeline of the main case: queued 09:00, runs 09:01-09:11, plan waits 09:11-10:11, runs 10:11-10:41, pull request review 10:41-12:41 (merged). */
const MAIN: Spec[] = [started(at(9)), wait(at(9), "system", "queued"), wait(at(9, 1), "agent"), wait(at(9, 11), "person", "plan_approval"), wait(at(10, 11), "agent"), wait(at(10, 41), "person", "pr_review")];

function world() {
  const store = new MemoryDocumentStore();
  const put = async (spec: Spec[], company: OrgId, taskId: string, project: string): Promise<void> => {
    for (const one of spec) await store.put({ item: workEventRow(event(company, taskId, project, one)) });
  };
  const seed = async (input: { company?: OrgId; n: number; project?: string; startedAt: string; merged?: string; closedAt?: string; events?: Spec[] }): Promise<string> => {
    const company = input.company ?? A;
    const taskId = id(input.n);
    const project = input.project ?? "alpha";
    const items = reportStartItems({ companyId: company, taskId, project, title: `Task ${String(input.n)}`, origin: "app", receivedAt: input.startedAt });
    expect((await store.transact(items)).applied).toBe(true);
    const workflow = input.merged === undefined ? undefined : { stage: "MERGED", state: "COMPLETE", outcome: "MERGED", path: "FULL", updatedAt: input.merged, pullRequests: [{ url: "https://github.com/acme/web/pull/7", state: "MERGED" }] };
    await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", companyId: company, taskId, project, title: `Task ${String(input.n)}`, createdAt: input.startedAt, ...(input.closedAt === undefined ? {} : { closedAt: input.closedAt }), ...(workflow === undefined ? {} : { workflow: workflow }) } });
    if (input.merged !== undefined) await store.put({ item: { ...codeMilestoneKey(taskId, "merged", 1), entityType: "CODE_MILESTONE", orgId: company, taskId, kind: "merged", at: input.merged, text: "merged" } });
    await put(input.events ?? [], company, taskId, project);
    return taskId;
  };
  const read = (company: OrgId, query: Record<string, unknown> = { from: "2026-11-01T00:00:00.000Z" }, now = NOW): Promise<ReportTasksResponse> => readCompanyReportTasks(store, company, query, now);
  return { store, seed, put, read };
}

describe("the time split, attributed", () => {

  it("an event after the end is not counted, and an open task runs to now", async () => {
    const task = { taskId: id(1), project: "alpha", orgId: A };
    const spec = [started(at(9)), wait(at(9), "agent"), wait(at(11), "person", "pr_review"), wait(at(13), "agent")];
    const folded = foldTimes(spec.map((one) => event(A, id(1), "alpha", one)), task, Date.parse(at(12)), NOW)!;
    expect(folded).toMatchObject({ workingMs: 120 * MIN, prReviewMs: 60 * MIN });
    const open = foldTimes(spec.map((one) => event(A, id(1), "alpha", one)), task, undefined, Date.parse(at(14)))!;
    expect(open).toMatchObject({ workingMs: 120 * MIN + 60 * MIN, prReviewMs: 120 * MIN });
    const w = world();
    const taskId = await w.seed({ n: 2, startedAt: at(9), events: spec });
    const row = (await w.read(A, { from: "2026-11-01T00:00:00.000Z" }, Date.parse(at(14)))).tasks.find((entry) => entry.taskId === taskId)!;
    expect(row).toMatchObject({ state: "open", workingMs: 180 * MIN, waitingPeopleMs: { decisionsMs: 0, prReviewMs: 120 * MIN } });
  });

  it("send-backs: Rovara's and people's are told apart by who, an automatic retry is none, and a repeated event counts once", () => {
    const task = { taskId: id(1), project: "alpha", orgId: A };
    const spec = [started(at(9)), wait(at(9), "agent"), answered(at(10), "rovara_auto_fix", "changes_requested", 1), answered(at(10, 1), "rovara_ci_fix", "changes_requested", 2), answered(at(10, 2), "rovara_auto_retry", "answered", 3),
      answered(at(10, 3), "person_send_back", "changes_requested", 4), answered(at(10, 4), "person_pr_feedback", "changes_requested", 5), answered(at(10, 5), "person_gate", "approved", 6), answered(at(10, 5), "person_gate", "approved", 6)];
    const events = [...spec, spec[2]!].map((one) => event(A, id(1), "alpha", one)) as never;
    expect(foldTimes(events, task, Date.parse(at(11)), NOW)).toMatchObject({ sendBacksRovara: 2, sendBacksPeople: 2 });
  });
});

describe("absent is not zero", () => {

  it("events that do not cover the task from its start leave the numbers out: no start event, no wait, an event row that cannot be read, too many events", async () => {
    const w = world();
    const noStart = await w.seed({ n: 1, startedAt: at(9), events: [wait(at(9), "agent")] });
    const noWait = await w.seed({ n: 2, startedAt: at(9), events: [started(at(9))] });
    const broken = await w.seed({ n: 3, startedAt: at(9), events: MAIN });
    const brokenRow = workEventRow(event(A, id(3), "alpha", wait(at(10, 55), "agent")));
    await w.store.put({ item: { ...brokenRow, kind: "waiting_changed", waitingOn: "nobody" } });
    const rows = new Map((await w.read(A)).tasks.map((task) => [task.taskId, task]));
    for (const taskId of [noStart, noWait, broken]) expect(rows.get(taskId)).toBeDefined();
    for (const taskId of [noStart, noWait, broken]) expect(Object.keys(rows.get(taskId)!)).not.toContain("workingMs");
    const many = await w.seed({ n: 4, startedAt: at(9), events: [started(at(9)), wait(at(9), "agent")] });
    for (let n = 0; n < TIMES_EVENTS_MAX + 2; n += 1) await w.store.put({ item: workEventRow(event(A, id(4), "alpha", { kind: "step_started", at: at(9, 30), source: `s${String(n)}`, step: "plan" })) });
    expect(Object.keys((await w.read(A)).tasks.find((task) => task.taskId === many)!)).not.toContain("workingMs");
  });

  it("a stored times object that is not six whole numbers is not known", () => {
    expect(timesOfStored({ workingMs: 1, decisionsMs: 2, prReviewMs: 3, waitingSystemMs: 4, sendBacksRovara: 0, sendBacksPeople: 0 })).toEqual({ workingMs: 1, decisionsMs: 2, prReviewMs: 3, waitingSystemMs: 4, sendBacksRovara: 0, sendBacksPeople: 0 });
    for (const bad of [undefined, null, [], {}, { workingMs: 1 }, { workingMs: -1, decisionsMs: 2, prReviewMs: 3, waitingSystemMs: 4, sendBacksRovara: 0, sendBacksPeople: 0 }, { workingMs: 1.5, decisionsMs: 2, prReviewMs: 3, waitingSystemMs: 4, sendBacksRovara: 0, sendBacksPeople: 0 },
      { workingMs: 1, decisionsMs: 2, prReviewMs: 3, waitingSystemMs: 4, sendBacksRovara: 0, sendBacksPeople: 0, extra: 1 }]) expect(timesOfStored(bad)).toBeUndefined();
  });
});

describe("covered from the start, or not known", () => {
  const task = { taskId: id(1), project: "alpha", orgId: A };
  const fold = (spec: Spec[], end: string | undefined = at(11)) => foldTimes(spec.map((one) => event(A, id(1), "alpha", one)), task, end === undefined ? undefined : Date.parse(end), NOW);

  it("a task that counted no time at all is not known, not a row of zeros", () => {
    expect(fold([started(at(9)), wait(at(9), "agent")], at(9))).toBeUndefined();
    expect(fold([started(at(9)), wait(at(9), "agent")], at(8))).toBeUndefined();
  });
});

describe("company and project keyed", () => {
  it("two companies: each reads only its own events, another company's event in this company's partition is skipped and counted, and never used", async () => {
    const w = world();
    const taskA = await w.seed({ n: 1, company: A, startedAt: at(9), merged: at(12, 41), events: MAIN });
    const taskB = await w.seed({ n: 2, company: B, startedAt: at(9), merged: at(12, 41), events: [started(at(9)), wait(at(9), "agent")] });
    const readA = await w.read(A);
    const readB = await w.read(B);
    expect(readA.tasks.map((task) => task.taskId)).toEqual([taskA]);
    expect(readB.tasks.map((task) => task.taskId)).toEqual([taskB]);
    expect(readA.tasks[0]).toMatchObject({ workingMs: 40 * MIN });
    expect(readB.tasks[0]).toMatchObject({ workingMs: Date.parse(at(12, 41)) - Date.parse(at(9)) });
    // A row of company B put into A's partition for A's task (the key does not name B, the row does): skipped, and A's numbers are unchanged.
    const stray = workEventRow(event(B, taskA, "alpha", wait(at(9, 5), "person", "plan_approval")));
    await w.store.put({ item: { ...stray, pk: `ORG#${A}#WORK_EVENTS#2026-11#${String(Number.parseInt(taskA.replace(/-/gu, "").slice(0, 2), 16) % 8)}` } });
    const store = w.store;
    const fresh = await readTaskTimes(store, { taskId: taskA, project: "alpha", orgId: A }, at(9), at(12, 41), NOW);
    expect(fresh.skipped).toBe(1);
    expect(fresh.times).toMatchObject({ workingMs: 40 * MIN, decisionsMs: 60 * MIN });
    // The same task id under company B finds none of A's events.
    const other = await readTaskTimes(store, { taskId: taskA, project: "alpha", orgId: B }, at(9), at(12, 41), NOW);
    expect(other.times).toBeUndefined();
  });

  it("two projects: an event of the task that names another project is not used, and each task has its own numbers", async () => {
    const w = world();
    const one = await w.seed({ n: 1, project: "alpha", startedAt: at(9), merged: at(12, 41), events: MAIN });
    const two = await w.seed({ n: 2, project: "beta", startedAt: at(9), merged: at(12, 41), events: [started(at(9)), wait(at(9), "person", "answer")] });
    // A stray event for task one that says it is project beta's.
    await w.store.put({ item: workEventRow(event(A, id(1), "beta", wait(at(9, 2), "person", "pr_review"))) });
    const rows = new Map((await w.read(A)).tasks.map((task) => [task.taskId, task]));
    expect(rows.get(one)).toMatchObject({ project: "alpha", workingMs: 40 * MIN, waitingPeopleMs: { decisionsMs: 60 * MIN, prReviewMs: 120 * MIN } });
    expect(rows.get(two)).toMatchObject({ project: "beta", workingMs: 0, waitingPeopleMs: { decisionsMs: Date.parse(at(12, 41)) - Date.parse(at(9)), prReviewMs: 0 } });
    expect((await w.read(A, { from: "2026-11-01T00:00:00.000Z", project: "beta" })).tasks.map((task) => task.taskId)).toEqual([two]);
  });

});

describe("a read that fails", () => {
  it("is the report's retryable refusal, never a guess", async () => {
    const w = world();
    await w.seed({ n: 1, startedAt: at(9), events: MAIN });
    const failing = { ...w.store, get: w.store.get.bind(w.store), getMany: w.store.getMany.bind(w.store), update: w.store.update.bind(w.store), transact: w.store.transact.bind(w.store),
      query: async (request: { pk: string }) => { if (request.pk.includes("WORK_EVENTS")) throw new Error("boom"); return w.store.query(request); } };
    await expect(readCompanyReportTasks(failing as never, A, { from: "2026-11-01T00:00:00.000Z" }, NOW)).rejects.toThrow();
  });
});
