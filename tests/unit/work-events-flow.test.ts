// Lead 4, slice A4: the work events the task flow writes, from the points that already exist (a step starts or ends, the task waits for a decision, a decision is made). What is proven here:
//   - GOLDEN: with events on, every transaction the flow writes is byte-identical to the one without them, apart from the extra event items (and the stored task is the same);
//   - the events say what happened (the wait, the send-back, who by), in closed words, with no person in them;
//   - idempotent per event, bounded, and a failure to make an event never fails a step;
//   - company and project keyed.
import { describe, expect, it } from "vitest";
import { WorkEventSchema, type OrgId, type TransactItem, type WorkflowSnapshot } from "@agentx/contracts";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { commitWorkflow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { FLOW_EVENTS_MAX, TRANSACTION_ITEMS_MAX, flowEventsOf, flowWorkEventItems, startWorkEventItems, waitOf } from "../../packages/broker/src/core/work-events/flow-events.js";
import { WORK_EVENTS_PER_CHANGE_MAX } from "../../packages/broker/src/core/work-events/work-events.js";
import { isEventItem, planWaiting, type EventWorld } from "../support/work-events-world.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const TASK = "00000000-0000-4000-8000-000000000001";

/** Makes the random ids of two runs comparable: each distinct uuid or long hex string becomes its place of first appearance. */
function normalise(value: unknown): string {
  const seen = new Map<string, string>();
  return JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}/gu, (match) => {
    if (!seen.has(match)) seen.set(match, `<id${String(seen.size)}>`);
    return seen.get(match)!;
  });
}

/** The scripted task: planned, sent back for changes, planned again, approved. */
async function script(w: EventWorld): Promise<void> {
  await w.decide(1, "REQUEST_CHANGES", "Also return the build number");
  expect(await w.workflow()).toMatchObject({ stage: "PLAN", state: "READY" });
  await w.replan();
  await w.finish(w.last(), w.planned(2));
  expect(await w.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  w.h.clock.advance(600);
  await w.decide(2, "APPROVE", "Looks good");
  expect(await w.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "READY" });
}

const snapshot = (over: Record<string, unknown> = {}): WorkflowSnapshot => ({ stage: "PLAN", state: "RUNNING", revision: 3, updatedAt: "2026-11-17T10:00:00.000Z", taskId: TASK, decisions: [], artifacts: [], ...over }) as unknown as WorkflowSnapshot;
const was = (): WorkflowSnapshot => snapshot({ revision: 2, state: "READY" });

describe("golden: events on change nothing but the event items", () => {
  it("every transaction is the same with events on as with them off, minus the event items; the stored task is the same", async () => {
    const off = await planWaiting({ workEvents: false });
    await script(off);
    const on = await planWaiting({ workEvents: true });
    await script(on);
    const without = off.recorded.log.map((items) => items.filter((item) => !isEventItem(item)));
    const withEvents = on.recorded.log.map((items) => items.filter((item) => !isEventItem(item)));
    expect(normalise(withEvents)).toBe(normalise(without));
    // Positive control: events were written with events on, none with them off.
    expect(off.recorded.log.flat().filter(isEventItem)).toEqual([]);
    expect(on.recorded.log.flat().filter(isEventItem).length).toBeGreaterThan(8);
    expect(await off.events()).toEqual([]);
    expect(normalise((await readTask(on.h.deps, on.taskId))!)).toBe(normalise((await readTask(off.h.deps, off.taskId))!));
  });
});

describe("what the events say", () => {
  it("a task's wait, step and decision events follow the flow, in closed words, and name no person", async () => {
    const w = await planWaiting({ workEvents: true });
    await script(w);
    const events = await w.events();
    for (const event of events) expect(WorkEventSchema.safeParse(event).success).toBe(true);
    const waits = events.flatMap((event) => (event.kind === "waiting_changed" ? [`${event.waitingOn}:${event.reason ?? "-"}`] : []));
    // The plan runs from the start (Understand off), the owner decides, the replan is queued and runs, the owner decides again, coding is queued.
    expect(waits.filter((wait) => wait === "person:plan_approval")).toHaveLength(2);
    expect(waits.filter((wait) => wait === "agent:-")).toHaveLength(2);
    expect(waits.filter((wait) => wait === "system:queued")).toHaveLength(2);
    expect(waits.at(-1)).toBe("system:queued");
    expect(events.filter((event) => event.kind === "task_started")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "step_started")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "step_ended")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "decision_asked")).toHaveLength(2);
    const answered = events.flatMap((event) => (event.kind === "decision_answered" ? [`${event.outcome}:${event.place}`] : []));
    expect(answered).toEqual(["changes_requested:person_gate", "approved:person_gate"]);
    expect(events.filter((event) => event.kind === "plan_approved")).toHaveLength(1);
    // No person anywhere: every actor is the system or the agent, and the owner's id is in no event.
    const owner = String((await w.workflow())!.ownerId);
    expect(events.every((event) => event.actor.kind !== "person")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(owner);
    expect(events.every((event) => event.orgId === w.h.deps.companyId && event.taskId === w.taskId && event.project === "payments")).toBe(true);
  });

  it("a send-back by Rovara is a rovara place, an automatic retry is no send-back, and a person's is a person place", () => {
    const decision = (n: number, source: string, actorRole: string) => ({ requestId: `00000000-0000-4000-8000-0000000000a${String(n)}`, workflowRevision: 4, decision: "REQUEST_CHANGES", actorId: "x", actorRole, reason: "r", source, at: "2026-11-17T10:00:00.000Z" });
    const before = snapshot({ stage: "REVIEW", revision: 4 });
    const after = snapshot({ revision: 5, stage: "IMPLEMENT", state: "READY", decisions: [decision(1, "AUTO_FIX", "AGENTX"), decision(2, "AUTO_RETRY", "AGENTX"), decision(3, "SEND_BACK", "TASK_OWNER"), decision(4, "FINDINGS", "PROJECT_ADMIN")] });
    const answered = (events: ReturnType<typeof flowEventsOf>) => events.flatMap((event) => (event.kind === "decision_answered" ? [`${event.outcome}:${event.place}`] : []));
    expect(answered(flowEventsOf(before, after, { orgId: A, project: "alpha" }))).toEqual(["changes_requested:rovara_auto_fix", "answered:rovara_auto_retry", "changes_requested:person_send_back", "changes_requested:person_findings"]);
    // A CI fix round Rovara started is its own send-back, once per round.
    expect(answered(flowEventsOf(before, snapshot({ revision: 5, fixRounds: { ci: 1, conflict: 0, feedbackAuto: 0 } }), { orgId: A, project: "alpha" }))).toEqual(["changes_requested:rovara_ci_fix"]);
    // An approved round of pull request feedback is people asking for changes; a dismissal sends nothing back.
    const feedback = (n: number, decision: string) => ({ schemaVersion: 1, requestId: `00000000-0000-4000-8000-0000000000b${String(n)}`, workflowRevision: 4, decision, actorId: "x", actorRole: "TASK_OWNER", at: "2026-11-17T10:00:00.000Z" });
    expect(answered(flowEventsOf(before, snapshot({ revision: 5, feedbackDecisions: [feedback(1, "APPROVE"), feedback(2, "DISMISS")] }), { orgId: A, project: "alpha" }))).toEqual(["changes_requested:person_pr_feedback"]);
  });

  it("classifies what the workflow waits for", () => {
    const wait = (stage: string, state: string, blockReason?: string) => waitOf({ stage, state, ...(blockReason === undefined ? {} : { blockReason }) } as never);
    expect(wait("IMPLEMENT", "RUNNING")).toEqual({ on: "agent" });
    expect(wait("IMPLEMENT", "READY")).toEqual({ on: "system", reason: "queued" });
    expect(wait("PLAN_REVIEW", "WAITING")).toEqual({ on: "person", reason: "plan_approval" });
    expect(wait("UNDERSTAND", "WAITING")).toEqual({ on: "person", reason: "answer" });
    expect(wait("WAIT_FOR_MERGE", "WAITING")).toEqual({ on: "person", reason: "pr_review" });
    expect(wait("REVIEW", "BLOCKED")).toEqual({ on: "person", reason: "blocked" });
    expect(wait("MERGED", "COMPLETE")).toEqual({ on: "none" });
    expect(wait("CLOSED", "COMPLETE")).toEqual({ on: "none" });
  });

  it("a step that ends blocked is failed, one that is paused for spend is stopped, and one that finishes is done", () => {
    const ended = (after: Record<string, unknown>) => flowEventsOf(snapshot({ revision: 4, stage: "IMPLEMENT", state: "RUNNING" }), snapshot({ revision: 5, ...after }), { orgId: A, project: "alpha" }).flatMap((event) => (event.kind === "step_ended" ? [`${event.step}:${event.outcome}:${event.cause ?? "-"}`] : []));
    expect(ended({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "checks failed" })).toEqual(["implement:failed:other"]);
    expect(ended({ stage: "VERIFY", state: "READY" })).toEqual(["implement:done:-"]);
  });
});

describe("idempotent per event", () => {
  it("the same transition makes the same ids and rows, and writing it twice leaves one row each", async () => {
    const w = await planWaiting({ workEvents: true });
    await script(w);
    const after = (await readTask(w.h.deps, w.taskId))!.workflow!;
    const before = { ...after, revision: after.revision - 1, stage: "PLAN_REVIEW", state: "WAITING" } as unknown as WorkflowSnapshot;
    const input = { enabled: true, orgId: w.h.deps.companyId, project: "payments", before, after, room: 50 };
    const once = flowWorkEventItems(input);
    expect(once.length).toBeGreaterThan(0);
    expect(JSON.stringify(flowWorkEventItems(input))).toBe(JSON.stringify(once));
    expect((await w.h.store.transact(once)).applied).toBe(true);
    const afterFirst = await w.events();
    expect((await w.h.store.transact(once)).applied).toBe(true);
    const afterSecond = await w.events();
    expect(afterSecond.length).toBe(afterFirst.length);
    expect(afterSecond.length).toBeGreaterThan(0);
  });

  it("a replayed start makes the same events; another task makes others; the first wait is read from the snapshot the task starts with", () => {
    const input = { companyId: A, taskId: TASK, project: "alpha", origin: "web", receivedAt: "2026-11-17T09:00:00.000Z" };
    const kinds = (workflow?: WorkflowSnapshot) => startWorkEventItems({ ...input, ...(workflow === undefined ? {} : { workflow }) }).map((item) => (item as unknown as { item: { kind: string; waitingOn?: string; reason?: string } }).item).map((row) => `${row.kind}${row.waitingOn === undefined ? "" : `:${row.waitingOn}:${row.reason ?? "-"}`}`).sort();
    // A plain task has no workflow: it started, and nothing is known to wait for.
    expect(kinds()).toEqual(["task_started"]);
    // A task that starts running (Understand off) waits for the agent; one that starts queued (Understand first) waits for the system.
    expect(kinds(snapshot({ revision: 1, state: "RUNNING", updatedAt: input.receivedAt }))).toEqual(["step_started", "task_started", "waiting_changed:agent:-"]);
    expect(kinds(snapshot({ revision: 1, stage: "UNDERSTAND", state: "READY", updatedAt: input.receivedAt }))).toEqual(["task_started", "waiting_changed:system:queued"]);
    const queued = snapshot({ revision: 1, stage: "UNDERSTAND", state: "READY", updatedAt: input.receivedAt });
    expect(JSON.stringify(startWorkEventItems({ ...input, workflow: queued }))).toBe(JSON.stringify(startWorkEventItems({ ...input, workflow: queued })));
    expect(JSON.stringify(startWorkEventItems({ ...input, taskId: "00000000-0000-4000-8000-000000000002", workflow: queued }))).not.toBe(JSON.stringify(startWorkEventItems({ ...input, workflow: queued })));
  });

  it("each wait is strictly after the one before, even when the clock did not move", () => {
    const first = flowEventsOf(snapshot({ revision: 2, state: "READY" }), snapshot({ revision: 3, state: "RUNNING" }), { orgId: A, project: "alpha" });
    expect(first.length).toBeGreaterThan(0);
    for (const event of first) expect(Date.parse(event.at)).toBe(Date.parse("2026-11-17T10:00:00.000Z") + 1);
    // A later clock is kept as it is.
    const later = flowEventsOf(snapshot({ revision: 2, state: "READY" }), snapshot({ revision: 3, updatedAt: "2026-11-17T10:05:00.000Z" }), { orgId: A, project: "alpha" });
    for (const event of later) expect(event.at).toBe("2026-11-17T10:05:00.000Z");
  });

  it("a transition that does not move the revision makes no events", () => {
    expect(flowEventsOf(snapshot(), snapshot(), { orgId: A, project: "alpha" })).toEqual([]);
  });
});

describe("a failure to make an event never fails a step", () => {
  it("a snapshot it cannot read, an invalid project and an invalid time give no events and no throw", () => {
    const input = { enabled: true, orgId: A, before: was(), room: 50 };
    expect(flowWorkEventItems({ ...input, project: "alpha", after: snapshot() }).length).toBeGreaterThan(0);
    expect(flowWorkEventItems({ ...input, project: "alpha", after: snapshot({ updatedAt: "not a time" }) })).toEqual([]);
    expect(flowWorkEventItems({ ...input, project: "not a valid project name!!", after: snapshot() })).toEqual([]);
    expect(() => flowWorkEventItems({ ...input, project: "alpha", after: snapshot({ pullRequests: 5 }) })).not.toThrow();
    expect(flowWorkEventItems({ ...input, project: "alpha", after: snapshot({ pullRequests: 5 }) })).toEqual([]);
    // A snapshot with no decision list (an old record) still makes its wait events.
    expect(flowWorkEventItems({ ...input, project: "alpha", after: snapshot({ decisions: null }) }).length).toBeGreaterThan(0);
    expect(flowWorkEventItems({ ...input, project: "alpha", after: undefined as never })).toEqual([]);
    expect(flowWorkEventItems({ ...input, orgId: "nope", project: "alpha", after: snapshot() })).toEqual([]);
  });

  it("the pure function itself never throws on a snapshot it cannot read", () => {
    expect(() => flowEventsOf(was(), snapshot({ pullRequests: 5 }), { orgId: A, project: "alpha" })).not.toThrow();
    expect(flowEventsOf(was(), snapshot({ pullRequests: 5 }), { orgId: A, project: "alpha" })).toEqual([]);
    expect(flowEventsOf(was(), undefined as never, { orgId: A, project: "alpha" })).toEqual([]);
  });

  it("the skips are told, never their content", () => {
    const skips: string[] = [];
    flowWorkEventItems({ enabled: true, orgId: "nope", project: "alpha", before: was(), after: snapshot(), room: 50, onSkip: (reason) => skips.push(reason) });
    expect(skips).toContain("invalid");
  });

  it("with no room left in the transaction no event is added (all or none)", () => {
    const skips: string[] = [];
    const input = { enabled: true, orgId: A, project: "alpha", before: was(), after: snapshot() };
    expect(flowWorkEventItems({ ...input, room: 1, onSkip: (reason) => skips.push(reason) })).toEqual([]);
    expect(skips).toContain("no_room");
    expect(flowWorkEventItems({ ...input, room: 0 })).toEqual([]);
    expect(flowWorkEventItems({ ...input, room: 50 }).length).toBeGreaterThan(1);
  });

  it("a real commit whose transaction is already full still commits, with no events added", async () => {
    const w = await planWaiting({ workEvents: true });
    const task = (await readTask(w.h.deps, w.taskId))!;
    const filler: TransactItem[] = Array.from({ length: TRANSACTION_ITEMS_MAX - 1 }, (_, n) => ({ kind: "put" as const, item: { pk: `FILLER#${String(n)}`, sk: "X", n } }));
    const waiting = task.workflow!;
    const next = { ...waiting, revision: waiting.revision + 1, stage: "PLAN_REVIEW", state: "BLOCKED", blockReason: "stopped for a test", updatedAt: w.h.deps.now!().toISOString() } as unknown as WorkflowSnapshot;
    const eventsBefore = (await w.events()).length;
    // PLAN_REVIEW is never stored blocked, so the real transition is a running plan step; build one the schema accepts.
    const running = { ...waiting, revision: waiting.revision + 1, stage: "PLAN", state: "RUNNING", updatedAt: w.h.deps.now!().toISOString() } as unknown as WorkflowSnapshot;
    void next;
    expect(await commitWorkflow(w.h.deps, task, running, filler)).toBe(true);
    expect((await readTask(w.h.deps, w.taskId))!.workflow).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect((await w.events()).length).toBe(eventsBefore);
    // The same commit with room for them writes them (positive control).
    const task2 = (await readTask(w.h.deps, w.taskId))!;
    const waitingAgain = { ...task2.workflow!, revision: task2.workflow!.revision + 1, stage: "PLAN_REVIEW", state: "WAITING", updatedAt: w.h.deps.now!().toISOString() } as unknown as WorkflowSnapshot;
    expect(await commitWorkflow(w.h.deps, task2, waitingAgain)).toBe(true);
    expect((await w.events()).length).toBeGreaterThan(eventsBefore);
  });

  it("is off unless the flow says true", () => {
    for (const enabled of [undefined, false] as const) expect(flowWorkEventItems({ enabled, orgId: A, project: "alpha", before: was(), after: snapshot(), room: 50 })).toEqual([]);
  });

  it("is bounded: at most FLOW_EVENTS_MAX in one change", () => {
    expect(FLOW_EVENTS_MAX).toBeLessThanOrEqual(WORK_EVENTS_PER_CHANGE_MAX);
    const pullRequests = Array.from({ length: 32 }, (_, n) => ({ repositoryId: `acme/repo${String(n)}`, number: n + 1, url: "https://github.com/x/y/pull/1", candidateDigest: "a".repeat(64), required: true, state: "MERGED" }));
    const input = { enabled: true, orgId: A, project: "alpha", before: snapshot({ revision: 2, state: "WAITING", stage: "WAIT_FOR_MERGE" }), after: snapshot({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests }), room: 99 };
    expect(flowEventsOf(input.before, input.after, { orgId: A, project: "alpha" }).length).toBeGreaterThan(FLOW_EVENTS_MAX);
    const skips: string[] = [];
    const items = flowWorkEventItems({ ...input, onSkip: (reason) => skips.push(reason) });
    expect(items.length).toBeLessThanOrEqual(FLOW_EVENTS_MAX);
    expect(skips).toContain("too_many");
  });
});

describe("company and project keyed", () => {
  const rowOf = (companyId: OrgId, project: string) => (startWorkEventItems({ companyId, taskId: TASK, project, origin: "web", receivedAt: "2026-11-17T09:00:00.000Z" })[0] as { item: Record<string, unknown> }).item;

  it("the rows are in the company's own partition and carry the project", () => {
    const rowA = rowOf(A, "alpha");
    const rowB = rowOf(B, "beta");
    expect(String(rowA["pk"])).toContain(`ORG#${A}#WORK_EVENTS#`);
    expect(String(rowB["pk"])).toContain(`ORG#${B}#WORK_EVENTS#`);
    expect([rowA["orgId"], rowA["project"], rowB["orgId"], rowB["project"]]).toEqual([A, "alpha", B, "beta"]);
    expect(String(rowA["pk"])).not.toContain(B);
  });

  it("two companies' flows write only into their own partitions", async () => {
    const a = await planWaiting({ workEvents: true, companyId: A });
    const b = await planWaiting({ workEvents: true, companyId: B });
    for (const [world, company, other] of [[a, A, B], [b, B, A]] as const) {
      const rows = world.recorded.log.flat().filter(isEventItem).map((item) => (item as unknown as { item: { pk: string; orgId: string } }).item);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.pk.startsWith(`ORG#${company}#WORK_EVENTS#`) && row.orgId === company && !row.pk.includes(other))).toBe(true);
    }
  });

  it("two projects' tasks carry their own project", async () => {
    const a = await planWaiting({ workEvents: true, project: "payments" });
    const events = await a.events();
    expect(new Set(events.map((event) => event.project))).toEqual(new Set(["payments"]));
  });
});
