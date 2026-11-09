// Lane L6b: sessions. A session wraps a task and shows where it stands: created with the task, kept current from the task's facts and the cost ledger, stopped, retried and told through the task flow's control
// host, listed and read. The sources are fakes at the seams (the task flow's facts, the cost, the control host).
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_COMPANY_ID, agentSessionKey, openAgentSessionKey, sessionTaskStatus, type AgentSessionRecord, type AuditSink, type DocumentChange, type OrgId, type Principal, type SessionId, type TransactItem,
} from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import {
  SessionStore, computeTaskState, createSessionControl, createTaskSessionItems, developerIdOf, listSessions, projectChanges, readSessionEvents, refreshSessionSummary, sessionSnapshot, sessionTargetsOf,
  sweepOpenSessions, taskSessionId, type SessionChange, type SessionControlHost, type SessionTaskFacts, type SummaryDependencies,
} from "../../packages/broker/src/core/sessions/index.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK2 = "11111111-2222-4333-8444-555555555555";
const SESSION = taskSessionId(TASK) as SessionId;
const T0 = "2026-11-09T10:00:00.000Z";
const clock = { now: new Date("2026-11-09T10:05:00.000Z") };

const facts = (overrides: Partial<SessionTaskFacts> = {}): SessionTaskFacts => ({
  companyId: ORG, taskId: TASK, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0, ...overrides,
});

function world(initial: Partial<SessionTaskFacts> | undefined = {}) {
  const store = new MemoryDocumentStore();
  const state = { facts: initial === undefined ? undefined : facts(initial) as SessionTaskFacts | undefined, cost: 0 };
  const changes: SessionChange[] = [];
  const deps: SummaryDependencies = {
    store, facts: { read: async () => state.facts }, cost: { costUsd: async () => state.cost }, now: () => clock.now, log: () => undefined,
    onChange: [async (change) => { changes.push(change); }],
  };
  const create = async (taskId = TASK, project = "web") => {
    const items = createTaskSessionItems({
      orgId: ORG, sessionId: taskSessionId(taskId), taskId, project, agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER,
      origin: "app" as never, payer: { kind: "member", developerId: OWNER_ID } as never, now: T0,
    });
    return store.transact(items);
  };
  return { store, state, deps, changes, create };
}

const get = async (store: MemoryDocumentStore, sessionId: SessionId = SESSION): Promise<AgentSessionRecord> => (await new SessionStore(store).get(ORG, sessionId))!;

describe("a task session is created with its task", () => {
  it("writes the header, the leg, the started event, the lists and the sweep entry together, once", async () => {
    const { store, create } = world();
    expect(await create()).toMatchObject({ applied: true });
    const session = await get(store);
    expect(session).toMatchObject({ kind: "task", subject: { kind: "task", taskId: TASK }, summary: { status: "starting" }, owner: { developerId: OWNER_ID }, revision: 1, summaryRevision: 1 });
    expect(await store.get(openAgentSessionKey(ORG, SESSION))).toBeDefined();
    const events = await readSessionEvents(store, ORG, SESSION);
    expect(events.events).toHaveLength(1);
    expect(events.events[0]).toMatchObject({ type: "started", text: expect.stringContaining("Add retry") });
    // The same start again is refused whole: there is never a second session for a task.
    expect(await create()).toMatchObject({ applied: false });
  });

  it("the id belongs to the task, and a title with a token in it is redacted", async () => {
    expect(taskSessionId(TASK)).toBe(taskSessionId(TASK));
    expect(taskSessionId(TASK)).not.toBe(taskSessionId(TASK2));
    const { store } = world();
    const fake = ["sk", "ant", "x".repeat(40)].join("-");
    const items = createTaskSessionItems({ orgId: ORG, sessionId: taskSessionId(TASK2), taskId: TASK2, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: `Fix ${fake}`, owner: OWNER, origin: "app" as never, payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 });
    await store.transact(items);
    expect(JSON.stringify((await store.query({ pk: agentSessionKey(ORG, taskSessionId(TASK2) as SessionId, "META").pk })).items)).not.toContain(fake);
  });
});

describe("the summary of a task session", () => {
  const stateOf = (overrides: Partial<SessionTaskFacts>, cost = 0, previous?: AgentSessionRecord["summary"]) => computeTaskState(facts(overrides), cost, previous, clock.now.getTime());

  it("reads the stage: a plan under review needs the owner, a pull request waits, a blocked task needs someone and can be retried", () => {
    expect(stateOf({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } }).summary).toMatchObject({ status: "needs_person", needsPeople: [OWNER_ID] });
    expect(stateOf({ workflow: { stage: "WAIT_FOR_MERGE", state: "WAITING" } }).summary.status).toBe("waiting");
    expect(stateOf({ workflow: { stage: "IMPLEMENT", state: "BLOCKED", blockReason: "something broke" } }).summary).toMatchObject({ status: "needs_person", workflowBlocked: true });
    expect(stateOf({ runStatus: "STARTING", workflow: { stage: "UNDERSTAND", state: "RUNNING" } }).summary.status).toBe("starting");
    expect(stateOf({ runStatus: "CANCELLED" }).summary.status).toBe("stopped");
    expect(stateOf({ budgetPaused: true }).summary.status).toBe("paused");
  });

  it("a task with no workflow reads from its run, and a failed run says why in words", () => {
    expect(stateOf({ workflow: undefined, runStatus: "RUNNING" }).summary.status).toBe("running");
    const failed = stateOf({ workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" }).summary;
    expect(failed).toMatchObject({ status: "waiting", lastRunFailed: true, step: "Failed: the run took too long and was stopped" });
  });

  it("the work is over when the pull request merged, the plan was rejected, the task was answered or closed, or the workspace could not be prepared", () => {
    expect(stateOf({ workflow: { stage: "MERGED", state: "COMPLETE" } }).ended).toMatchObject({ status: "succeeded" });
    expect(stateOf({ workflow: { stage: "CLOSED", state: "COMPLETE", outcome: "ANSWERED" } }).ended).toMatchObject({ status: "succeeded" });
    expect(stateOf({ workflow: { stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" } }).ended).toMatchObject({ status: "cancelled" });
    expect(stateOf({ closedAt: T0 }).ended).toMatchObject({ status: "cancelled", at: T0 });
    expect(stateOf({ workflow: undefined, closedAt: T0, runStatus: "FAILED" }).ended).toMatchObject({ status: "failed" });
    expect(stateOf({ failedPrepare: { at: T0 } }).ended).toMatchObject({ status: "failed" });
  });

  it("a long step, a token in the peek, and the cost are cleaned; the status model's words are the summary's", () => {
    const secret = ["ghp", "y".repeat(36)].join("_");
    const { summary } = stateOf({ step: `Coding ${"x".repeat(400)}`, peek: `ran with ${secret}` }, 1.2345678);
    expect([...summary.step!].length).toBeLessThanOrEqual(200);
    expect(summary.peek).not.toContain(secret);
    expect(summary.costUsd).toBe(1.234568);
    expect(sessionTaskStatus(summary)).toMatchObject({ state: "building" });
    expect(stateOf({ peek: undefined }, 0, { ...summary, peek: "kept" }).summary.peek).toBe("kept");
  });
});

describe("refreshing a session", () => {
  it("writes the new summary, the revision, the tile and one event, and tells the hooks", async () => {
    const w = world({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" }, step: "Waiting for approval" });
    await w.create();
    expect(await refreshSessionSummary(w.deps, ORG, SESSION)).toBe("updated");
    const session = await get(w.store);
    expect(session).toMatchObject({ summary: { status: "needs_person", needsPeople: [OWNER_ID] }, summaryRevision: 2 });
    expect((await readSessionEvents(w.store, ORG, SESSION)).events.map((event) => event.type)).toEqual(["started", "step"]);
    expect(w.changes).toHaveLength(1);
    expect(w.changes[0]).toMatchObject({ statusChanged: true, stepChanged: true, ended: false, summaryRevision: 2 });
    // Nothing changed: nothing written, nobody told.
    expect(await refreshSessionSummary(w.deps, ORG, SESSION)).toBe("unchanged");
    expect(w.changes).toHaveLength(1);
    expect((await get(w.store)).summaryRevision).toBe(2);
  });

  it("refreshes racing each other leave one consistent revision per change", async () => {
    const w = world();
    await w.create();
    const results = await Promise.all([1, 2, 3, 4].map(() => refreshSessionSummary(w.deps, ORG, SESSION)));
    expect(results.filter((result) => result === "updated").length).toBeGreaterThanOrEqual(1);
    const session = await get(w.store);
    expect(session.summaryRevision).toBe(1 + results.filter((result) => result === "updated").length);
    expect(session.summary.status).toBe("running");
  });

  it("ending takes the session out of the sweep, keeps the status it ended with, and never reopens", async () => {
    const w = world({ workflow: { stage: "MERGED", state: "COMPLETE" }, step: "Merged" });
    await w.create();
    await refreshSessionSummary(w.deps, ORG, SESSION);
    const ended = await get(w.store);
    expect(ended).toMatchObject({ summary: { status: "succeeded" }, endedAt: expect.any(String) });
    expect(await w.store.get(openAgentSessionKey(ORG, SESSION))).toBeUndefined();
    expect(w.changes.at(-1)).toMatchObject({ ended: true });
    // The task is read as running again (a bad source): the session does not reopen.
    w.state.facts = facts();
    expect(await refreshSessionSummary(w.deps, ORG, SESSION)).toBe("unchanged");
    expect((await get(w.store)).summary.status).toBe("succeeded");
    // Its cost catching up changes the summary but not its status.
    w.state.facts = facts({ workflow: { stage: "MERGED", state: "COMPLETE" } });
    w.state.cost = 2.5;
    expect(await refreshSessionSummary(w.deps, ORG, SESSION)).toBe("updated");
    expect((await get(w.store)).summary).toMatchObject({ status: "succeeded", costUsd: 2.5 });
  });

  it("a task of another company, a task that is gone and a session that is gone change nothing", async () => {
    const w = world({ companyId: "org_11111111111111111111" });
    await w.create();
    expect(await refreshSessionSummary(w.deps, ORG, SESSION)).toBe("unchanged");
    w.state.facts = undefined;
    expect(await refreshSessionSummary(w.deps, ORG, SESSION)).toBe("unchanged");
    expect(await refreshSessionSummary(w.deps, ORG, "ses_nonexistent00000000" as SessionId)).toBe("unchanged");
    expect(await refreshSessionSummary(w.deps, "org_11111111111111111111" as OrgId, SESSION)).toBe("unchanged");
    expect((await get(w.store)).summaryRevision).toBe(1);
  });

  it("a hook that fails does not fail the refresh", async () => {
    const w = world();
    await w.create();
    const deps: SummaryDependencies = { ...w.deps, onChange: [async () => { throw new Error("down"); }] };
    expect(await refreshSessionSummary(deps, ORG, SESSION)).toBe("updated");
  });
});

describe("the projector and the sweep", () => {
  it("a change to a task that names a session targets that session once, and nothing else does", () => {
    const change = (pk: string, after?: Record<string, unknown>): DocumentChange => ({ sequence: "1", kind: "modify", cause: "write", key: { pk, sk: "META" }, ...(after === undefined ? {} : { after: { pk, sk: "META", ...after } as never }) });
    const targets = sessionTargetsOf([
      change(`DEVTASK#${TASK}`, { orgId: ORG, sessionId: SESSION }), change(`DEVTASK#${TASK}`, { orgId: ORG, sessionId: SESSION }),
      change("OTHER#1", { orgId: ORG, sessionId: "ses_x" }), change(`DEVTASK#other`, {}), change(`DEVTASK#t3`, { orgId: 5, sessionId: SESSION }),
    ]);
    expect(targets).toEqual([{ orgId: ORG, sessionId: SESSION }]);
  });

  it("a batch refreshes its sessions, and fails (to be retried) only when none could be refreshed", async () => {
    const w = world();
    await w.create();
    const change: DocumentChange = { sequence: "1", kind: "modify", cause: "write", key: { pk: `DEVTASK#${TASK}`, sk: "META" }, after: { pk: `DEVTASK#${TASK}`, sk: "META", orgId: ORG, sessionId: SESSION } };
    expect(await projectChanges(w.deps, [change])).toEqual({ refreshed: 1, failed: 0 });
    expect((await get(w.store)).summary.status).toBe("running");
    const broken: SummaryDependencies = { ...w.deps, facts: { read: async () => { throw new Error("down"); } } };
    await expect(projectChanges(broken, [change])).rejects.toThrow();
  });

  it("the sweep refreshes every open session, tells the after-sweep hook, and stops at its deadline", async () => {
    const w = world();
    await w.create();
    await w.store.transact(createTaskSessionItems({ orgId: ORG, sessionId: taskSessionId(TASK2), taskId: TASK2, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Second", owner: OWNER, origin: "app" as never, payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
    let after = 0;
    const result = await sweepOpenSessions({ ...w.deps, afterSweep: async () => { after += 1; } });
    expect(result).toMatchObject({ visited: 2, complete: true });
    expect(after).toBe(1);
    // The second session's task has no facts of its own in this fake source (it answers task 1's): its company/task check refuses it.
    expect(result.updated).toBe(1);
    const late = await sweepOpenSessions({ ...w.deps, now: () => new Date(clock.now.getTime() + 60_000) }, { budgetMs: -1 });
    expect(late).toMatchObject({ visited: 0, complete: false });
  });
});

describe("stop, retry and tell", () => {
  const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  function controlled(initial: Partial<SessionTaskFacts> = {}, host?: Partial<SessionControlHost>, audit: AuditSink = createNoopAuditSink()) {
    const w = world(initial);
    const calls: string[] = [];
    const real: SessionControlHost = {
      cancelTask: async (taskId, requestId) => { calls.push(`cancel:${taskId}:${requestId}`); },
      retryWorkflow: async (taskId, requestId) => { calls.push(`retry:${taskId}:${requestId}`); },
      deliverMessage: async (taskId, message) => { calls.push(`tell:${taskId}:${message.messageId}`); return { state: "queued" }; },
      ...host,
    };
    const control = createSessionControl({ store: w.store, audit, host: real, now: () => clock.now, refresh: (orgId, sessionId) => refreshSessionSummary(w.deps, orgId, sessionId), log: () => undefined });
    return { ...w, control, calls };
  }

  it("the owner stops a session: the task flow cancels, the event and the request are recorded, and a repeat writes nothing", async () => {
    const audits: string[] = [];
    const audit: AuditSink = { stage: (event) => { audits.push(event.action); return [{ kind: "put", item: { pk: `AUDIT#${event.eventId}`, sk: "E" } } as TransactItem]; }, async record() {} };
    const w = controlled({}, undefined, audit);
    await w.create();
    const first = await w.control.stop(OWNER, ORG, SESSION, { requestId: REQ(1) });
    expect(first).toMatchObject({ status: "done", repeated: false });
    expect(w.calls).toEqual([`cancel:${TASK}:${REQ(1)}`]);
    expect((await readSessionEvents(w.store, ORG, SESSION)).events.map((event) => event.type)).toContain("stopped");
    expect(audits).toEqual(["session.stopped"]);
    const again = await w.control.stop(OWNER, ORG, SESSION, { requestId: REQ(1) });
    expect(again).toMatchObject({ status: "done", repeated: true });
    expect(w.calls).toHaveLength(1);
    expect((await readSessionEvents(w.store, ORG, SESSION)).events.filter((event) => event.type === "stopped")).toHaveLength(1);
  });

  it("a person who is not the owner, or is from another company, reads a missing session and nothing is called", async () => {
    const w = controlled();
    await w.create();
    const guest: Principal = { ...OWNER, personId: "guest", roles: ["collaborator"] };
    const stranger: Principal = { ...OWNER, companyId: "org_11111111111111111111" };
    expect(await w.control.stop(guest, ORG, SESSION, { requestId: REQ(1) })).toMatchObject({ status: "refused", reason: "not_found" });
    expect(await w.control.stop(stranger, ORG, SESSION, { requestId: REQ(1) })).toMatchObject({ status: "refused", reason: "not_found" });
    expect(await w.control.retry(guest, ORG, SESSION, { requestId: REQ(2) })).toMatchObject({ reason: "not_found" });
    expect(await w.control.tell(guest, ORG, SESSION, { requestId: REQ(3), text: "hi" })).toMatchObject({ reason: "not_found" });
    expect(await w.control.stop(OWNER, ORG, "ses_nonexistent00000000" as SessionId, { requestId: REQ(4) })).toMatchObject({ reason: "not_found" });
    expect(w.calls).toEqual([]);
  });

  it("an adapter can say who may act (the seam members plug into)", async () => {
    const w = world();
    await w.create();
    const guest: Principal = { ...OWNER, personId: "guest", roles: ["collaborator"] };
    const control = createSessionControl({ store: w.store, audit: createNoopAuditSink(), host: { cancelTask: async () => undefined, retryWorkflow: async () => undefined, deliverMessage: async () => ({ state: "queued" }) }, authorize: (principal, _session, action) => principal.personId === "guest" && action === "tell", now: () => clock.now });
    expect(await control.tell(guest, ORG, SESSION, { requestId: REQ(1), text: "hello" })).toMatchObject({ status: "done" });
    expect(await control.stop(guest, ORG, SESSION, { requestId: REQ(2) })).toMatchObject({ reason: "not_found" });
    expect(await control.stop(OWNER, ORG, SESSION, { requestId: REQ(3) })).toMatchObject({ reason: "not_found" });
  });

  it("a stop on an ended session, a bad request id, and a request id used for something else are refused", async () => {
    const w = controlled({ workflow: { stage: "MERGED", state: "COMPLETE" } });
    await w.create();
    await refreshSessionSummary(w.deps, ORG, SESSION);
    expect(await w.control.stop(OWNER, ORG, SESSION, { requestId: REQ(1) })).toMatchObject({ status: "refused", reason: "ended" });
    expect(await w.control.stop(OWNER, ORG, SESSION, { requestId: "not-a-uuid" })).toMatchObject({ reason: "invalid" });
    const open = controlled();
    await open.create();
    await open.control.tell(OWNER, ORG, SESSION, { requestId: REQ(7), text: "hello" });
    expect(await open.control.stop(OWNER, ORG, SESSION, { requestId: REQ(7) })).toMatchObject({ reason: "request_id_reused" });
  });

  it("without a control host nothing is stopped and nothing is written", async () => {
    const w = world();
    await w.create();
    const control = createSessionControl({ store: w.store, audit: createNoopAuditSink(), now: () => clock.now });
    expect(await control.stop(OWNER, ORG, SESSION, { requestId: REQ(1) })).toMatchObject({ reason: "unavailable" });
    expect((await readSessionEvents(w.store, ORG, SESSION)).events.map((event) => event.type)).toEqual(["started"]);
  });

  it("retry works on a blocked workflow only, in the same session", async () => {
    const w = controlled({ workflow: { stage: "IMPLEMENT", state: "BLOCKED", blockReason: "tests failed" } });
    await w.create();
    expect(await w.control.retry(OWNER, ORG, SESSION, { requestId: REQ(1) })).toMatchObject({ status: "refused", reason: "nothing_to_retry" });
    await refreshSessionSummary(w.deps, ORG, SESSION);
    expect(await w.control.retry(OWNER, ORG, SESSION, { requestId: REQ(2) })).toMatchObject({ status: "done", repeated: false });
    expect(w.calls).toEqual([`retry:${TASK}:${REQ(2)}`]);
    expect(await w.control.retry(OWNER, ORG, SESSION, { requestId: REQ(2) })).toMatchObject({ status: "done", repeated: true });
    expect(w.calls).toHaveLength(1);
  });

  it("a failed task that ended says a new task is the way on", async () => {
    const w = controlled({ workflow: undefined, closedAt: T0, runStatus: "FAILED" });
    await w.create();
    await refreshSessionSummary(w.deps, ORG, SESSION);
    expect(await w.control.retry(OWNER, ORG, SESSION, { requestId: REQ(1) })).toMatchObject({ reason: "nothing_to_retry", message: expect.stringContaining("new task") });
  });

  it("a message is information with its fate; it is stored once, never in an event, and an ended session takes none", async () => {
    const w = controlled({}, { deliverMessage: async () => ({ state: "not_delivered", reason: "no step is running" }) });
    await w.create();
    const secretText = "please use the other table";
    const sent = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(1), text: secretText });
    expect(sent).toMatchObject({ status: "done", message: { kind: "steer", delivery: { state: "not_delivered", reason: "no step is running" }, text: secretText } });
    const events = (await readSessionEvents(w.store, ORG, SESSION)).events;
    expect(events.map((event) => event.type)).toContain("steer_not_delivered");
    expect(JSON.stringify(events)).not.toContain(secretText);
    const repeat = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(1), text: secretText });
    expect(repeat).toMatchObject({ status: "done", repeated: true, message: { messageId: (sent as { message: { messageId: string } }).message.messageId } });
    expect(await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(2), text: "   " })).toMatchObject({ reason: "invalid" });
    const ended = controlled({ workflow: { stage: "MERGED", state: "COMPLETE" } });
    await ended.create();
    await refreshSessionSummary(ended.deps, ORG, SESSION);
    expect(await ended.control.tell(OWNER, ORG, SESSION, { requestId: REQ(3), text: "late" })).toMatchObject({ reason: "ended" });
  });
});

describe("reading sessions", () => {
  it("lists the owner's sessions newest first with a filter, and the snapshot says what can be done", async () => {
    const w = world({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    await w.create();
    await refreshSessionSummary(w.deps, ORG, SESSION);
    const second = taskSessionId(TASK2);
    await w.store.transact(createTaskSessionItems({ orgId: ORG, sessionId: second, taskId: TASK2, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Second", owner: OWNER, origin: "app" as never, payer: { kind: "member", developerId: OWNER_ID } as never, now: "2026-11-09T10:01:00.000Z" }));
    const all = await listSessions(w.store, ORG, OWNER_ID);
    expect(all.sessions.map((session) => session.title)).toEqual(["Second", "Add retry"]);
    const needs = await listSessions(w.store, ORG, OWNER_ID, { filter: "needs_me" });
    expect(needs.sessions.map((session) => session.sessionId)).toEqual([SESSION]);
    expect((await listSessions(w.store, ORG, "f".repeat(64))).sessions).toEqual([]);
    expect((await listSessions(w.store, ORG, OWNER_ID, { limit: 1 })).sessions).toHaveLength(1);
    const snapshot = sessionSnapshot(needs.sessions[0]!);
    expect(snapshot).toMatchObject({ state: "needs_you", needsYou: true, open: true, actions: ["watch", "steer", "stop"] });
    expect(snapshot.statusText).toContain("Needs you");
  });

  it("the event log pages by cursor and re-reads a little before it", async () => {
    const w = world({ workflow: { stage: "PLAN_REVIEW", state: "WAITING" } });
    await w.create();
    const store = new SessionStore(w.store);
    for (let index = 0; index < 5; index += 1) {
      const hex = index.toString(16).padStart(24, "0");
      await store.appendEvent(ORG, SESSION, { eventId: `evt_${hex}`, at: `2026-11-09T10:0${String(index + 1)}:00.000Z`, type: "comment", text: `note ${String(index)}` });
    }
    const first = await readSessionEvents(w.store, ORG, SESSION);
    expect(first.events).toHaveLength(6);
    expect(first.next).toMatch(/^2026-11-09T10:05:00\.000Z#evt_/u);
    expect((await readSessionEvents(w.store, ORG, SESSION, { after: first.next })).events).toEqual([]);
    await store.appendEvent(ORG, SESSION, { eventId: `evt_${"f".repeat(24)}`, at: "2026-11-09T10:06:00.000Z", type: "comment", text: "later" });
    expect((await readSessionEvents(w.store, ORG, SESSION, { after: first.next })).events.map((event) => event.text)).toEqual(["later"]);
    expect(await store.appendEvent(ORG, SESSION, { eventId: `evt_${"f".repeat(24)}`, at: "2026-11-09T10:06:00.000Z", type: "comment", text: "later" })).toBe("exists");
    await expect(readSessionEvents(w.store, ORG, SESSION, { after: "garbage" })).rejects.toThrow();
  });

  it("a session of another company reads as absent", async () => {
    const w = world();
    await w.create();
    expect(await new SessionStore(w.store).get("org_11111111111111111111" as OrgId, SESSION)).toBeUndefined();
    expect(await new SessionStore(w.store).getForTask(ORG, { taskId: TASK, orgId: ORG, sessionId: SESSION })).toBeDefined();
    expect(await new SessionStore(w.store).getForTask(ORG, { taskId: "another", orgId: ORG, sessionId: SESSION })).toBeUndefined();
    expect(await new SessionStore(w.store).getForTask(ORG, { taskId: TASK, orgId: "org_11111111111111111111" as OrgId, sessionId: SESSION })).toBeUndefined();
  });
});
