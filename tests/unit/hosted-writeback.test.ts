// R1 + L1 6.2 (owner DEC 254zzz466, plan 0.1 #3, #4, #8, #9, #14): what a hosted company's Linear ticket gets while the work goes, and what it never gets twice.
// The company's own Linear connection (a fake GraphQL behind the fetch seam, tests/support/fake-linear-writes.ts), the real ticket-updates handlers (`hostedTicketUpdates`), the real task log and the real
// milestone host over a memory store. These are the equivalents of the A1 journeys' pinned gap "nothing is written back on hosted": that pin flips in 6.3, here the behaviour is asserted.
//
// Held here:
//   - the five moments (started, plan ready, pull request opened, merged, closed) each write ONE comment, at the project's level (status_only one-shot comments; full: one thread), and the three status
//     moves (In Progress, In Review, Done) go with them; a replay of any moment, even twice at once, writes nothing more;
//   - Rovara notes its own write BEFORE it writes (so the echo is never taken for a member's act);
//   - a ticket that is already further along (or finished) is not moved back; a team with no status of that name is noted, the comment still goes, and the move is never guessed;
//   - a revoked write access, a disconnected company and a Linear outage never fail the task: refused ones are settled in words, a fault that may pass is told again by the milestone sweep and posts once;
//   - each company writes only with its own token to its own workspace.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, change, intakeItemIdOf, intakeOwnWriteKey, ticketUpdatesSettingsKey, type AuditEvent, type CodeMilestone, type OrgId, type Principal, type TicketUpdatesSettings } from "@agentx/contracts";
import { hostedTicketUpdates, hostedTrackerFor } from "../../packages/broker/src/aws/hosted-intake.js";
import { ticketSessionStartExtras } from "../../packages/broker/src/aws/hosted-intake.js";
import { notConnected } from "../../packages/broker/src/aws/linear-connections.js";
import { claimIntakeItem, markIntakeStarted } from "../../packages/broker/src/core/intake/store.js";
import { ownWriteVerdictOf } from "../../packages/broker/src/core/intake/own-writes.js";
import { createDocumentMilestones, codeMilestoneItems } from "../../packages/broker/src/core/milestones/milestones.js";
import {
  HOSTED_SEED_TICKET_UPDATES, STATUS_DEFAULT_REQUEST_ID, THREAD_ROOT_EDIT_GAP_MS, flipSeededStatusDefaults, readStatusMissing, releaseStatusFlip, statusFlipGoKey, readTicketUpdates, readWriteAccess, saveTicketUpdates, seedTicketUpdatesIfUnset, seededStatusRows,
} from "../../packages/broker/src/core/ticket-updates/index.js";
import { TASK_FLOW_INDEXES } from "../../packages/broker/src/core/task-flow/flow.js";
import { createTaskLogHooks } from "../../packages/broker/src/core/task-log/index.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { linearCommentIdFor } from "../../packages/broker/src/plugins/tracker/linear/api.js";
import { fakeLinearWrites, urlKeyOf, DEFAULT_STATES } from "../support/fake-linear-writes.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const PR = { repository: "demo", number: 7, url: "https://github.com/example/demo/pull/7" };
const STATUS_ONLY: TicketUpdatesSettings = { comments: true, changeStatus: true, statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" } };

async function world(options: { states?: typeof DEFAULT_STATES; disconnected?: boolean } = {}) {
  const store = new MemoryDocumentStore({ indexes: TASK_FLOW_INDEXES });
  const linear = fakeLinearWrites(options.states === undefined ? {} : { states: options.states });
  const clock = { now: Date.parse("2026-11-24T12:00:00.000Z") };
  const logs: Array<Record<string, unknown>> = [];
  const access = { disconnected: options.disconnected === true };
  const connections = { accessToken: async (asked: string) => { if (access.disconnected) throw notConnected(); return `tok-${asked}`; } };
  const handlersOf = (company: OrgId) => hostedTicketUpdates({ companyId: company, store, connections, fetch: linear.fetch, now: () => clock.now, log: (entry) => logs.push(entry), taskLog: createTaskLogHooks() });
  const handlers = new Map<string, ReturnType<typeof handlersOf>>([[A, handlersOf(A)], [B, handlersOf(B)]]);
  const at = (): string => new Date(clock.now).toISOString();
  const settle = (company: OrgId, project: string, settings: TicketUpdatesSettings) => saveTicketUpdates({ store, now: () => clock.now }, { orgId: company, project, requestId: randomUUID(), by: "owner", settings });
  /** A task started from a Linear ticket by intake: its session and ticket binding, and the intake item marked started for THIS task. */
  async function task(company: OrgId, project: string, key: string) {
    const taskId = randomUUID();
    const principal: Principal = { companyId: company, personId: `owner-${company.slice(4, 8)}`, displayName: "Owner", roles: ["member"], provider: "hosted" };
    const url = `https://linear.app/${urlKeyOf(company)}/issue/${key}/x`;
    const table = { store, now: () => clock.now };
    const itemId = intakeItemIdOf("linear", key);
    const extras = ticketSessionStartExtras(company)({ taskId, workspaceId: `ws-${taskId}`, project, title: "Refunds fail", principal, client: "tracker", receivedAt: at(), ticket: { system: "linear", id: key, url } });
    await store.transact([...extras.items]);
    const sessionId = extras.sessionId!;
    await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, companyId: company, project, sessionId, title: "Refunds fail", developerId: principal.personId } });
    await claimIntakeItem(table, { orgId: company, project, itemId, channel: "tracker", system: "linear", id: key, url, title: "Refunds fail", requester: { display: "Dana", standing: "outsider" }, state: "starting", startedBy: "holder" });
    await markIntakeStarted(table, company, project, itemId, { holder: "holder", taskId, sessionId, requester: { display: "Dana", standing: "outsider" } });
    await store.put({ item: { ...agentSessionKey(company, sessionId, "SHARE#1"), principal: { kind: "org" }, level: "view", sharedBy: { developerId: "a".repeat(64), name: "Owner" }, sharedAt: at() } });
    const milestone = (kind: CodeMilestone["kind"], over: Partial<CodeMilestone> = {}): CodeMilestone => ({ kind, orgId: company, taskId, sessionId, at: at(), text: "x", ...over });
    const send = async (m: CodeMilestone) => { for (const handler of handlers.get(company)!) await handler.on(m); };
    return { taskId, sessionId, milestone, send, company, key };
  }
  return { store, linear, clock, logs, handlers, task, settle, at, connections: access };
}
type World = Awaited<ReturnType<typeof world>>;
const commentIds = (w: World, company: OrgId) => w.linear.writes.filter((write) => write.company === company && write.kind === "create").map((write) => write.id);
const oneShotId = (taskId: string, key: string): string => linearCommentIdFor(A, `ticket_update:${taskId}:${key}`);

describe("the five moments write one comment each and move the status as the work goes (status_only: the one-shot comments)", () => {
  it("started, plan ready, pull request, merged on one ticket; closed on another; each moment is one comment and the three moves are In Progress, In Review, Done; the ticket's words never change", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    const u = await w.task(A, "payments", "ENG-2");
    await t.send(t.milestone("started"));
    expect(w.linear.stateOf(A, "ENG-1")).toBe("In Progress");
    await t.send(t.milestone("plan_ready"));
    expect(w.linear.stateOf(A, "ENG-1")).toBe("In Progress");
    await t.send(t.milestone("pr_ready", { pullRequests: [PR] }));
    expect(w.linear.stateOf(A, "ENG-1")).toBe("In Review");
    await t.send(t.milestone("merged"));
    expect(w.linear.stateOf(A, "ENG-1")).toBe("Done");
    await u.send(u.milestone("closed"));
    // A closed task with no merge is a comment only: the ticket stays where it was.
    expect(w.linear.stateOf(A, "ENG-2")).toBe("Todo");
    expect(w.linear.moves(A)).toEqual(["In Progress", "In Review", "Done"]);
    const posted = w.linear.commentsOf(A).map((entry) => `${entry.issue}: ${entry.body}`);
    expect(posted).toEqual([
      'ENG-1: Rovara started work on this ticket: "Refunds fail".\nStatus: In Progress.',
      'ENG-1: Rovara\'s plan for this ticket is ready for review: "Refunds fail".',
      `ENG-1: Rovara opened a pull request for this ticket: "Refunds fail".\nStatus: In Review.\nPull request: ${PR.url}`,
      'ENG-1: Rovara\'s pull request for this ticket was merged: "Refunds fail".\nStatus: Done.',
      'ENG-2: Rovara\'s task for this ticket was closed: "Refunds fail".',
    ]);
    // Each comment's id is made from the company and the moment, so Linear itself can tell a repeat.
    expect(commentIds(w, A)[0]).toBe(oneShotId(t.taskId, "started"));
    expect(commentIds(w, A)).toHaveLength(5);
    // Nothing leaves that the fixed words do not carry: no plan text, no log, no person's id.
    expect(JSON.stringify([...w.linear.comments.values()].map((entry) => entry.body))).not.toMatch(/owner-aaaa|Dana|org_/u);
  });

  it("a replay of any moment, and the same moment told twice at once, writes nothing more", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    const moments = [t.milestone("started"), t.milestone("plan_ready"), t.milestone("pr_ready", { pullRequests: [PR] }), t.milestone("merged")];
    for (const m of moments) await t.send(m);
    const after = { writes: w.linear.writes.length, moves: w.linear.moves(A).length };
    for (const m of moments) { await t.send(m); await t.send(m); }
    await Promise.all(moments.flatMap((m) => [t.send(m), t.send(m)]));
    expect({ writes: w.linear.writes.length, moves: w.linear.moves(A).length }).toEqual(after);
    expect(after.moves).toBe(3);
    expect(commentIds(w, A)).toHaveLength(4);
  });

  it("Rovara notes its own write BEFORE it writes, for the comment and for the move, so the echo is not a member's act", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    const seen: string[] = [];
    w.linear.beforeWrite(async (write) => {
      const noted = await w.store.get(intakeOwnWriteKey(A, intakeItemIdOf("linear", "eng-1"), "touch", ""));
      seen.push(`${write.kind}:${noted === undefined ? "no-note" : "noted"}`);
    });
    await t.send(t.milestone("started"));
    expect(seen).toEqual(["move:noted", "create:noted"]);
    // The echo of both, arriving at Rovara as a member's change on the ticket, is not told apart from Rovara's own: it starts nothing.
    const verdict = await ownWriteVerdictOf({ store: w.store, now: () => w.clock.now }, { orgId: A, project: "payments", externalRef: { system: "linear", id: "ENG-1" }, act: { kind: "label", value: "rovara" }, occurredAt: w.at() });
    expect(verdict).toBe("touched");
  });
});

describe("the project's thread level (the hosted default, level full): one thread, and the same status moves, each once", () => {
  it("moves In Progress, In Review and Done with the thread's comments; a replay moves nothing and posts nothing more", async () => {
    const w = await world();
    await w.settle(A, "payments", HOSTED_SEED_TICKET_UPDATES);
    const t = await w.task(A, "payments", "ENG-1");
    // The thread's root comment is edited at most once in a while (a moment inside it is told again by the milestone sweep): each moment here comes after that gap.
    const moments = [t.milestone("started"), t.milestone("pr_ready", { pullRequests: [PR] }), t.milestone("merged")];
    for (const m of moments) { w.clock.now += THREAD_ROOT_EDIT_GAP_MS + 1_000; await t.send(m); }
    expect(w.linear.moves(A)).toEqual(["In Progress", "In Review", "Done"]);
    const written = w.linear.writes.length;
    for (const m of moments) { w.clock.now += THREAD_ROOT_EDIT_GAP_MS + 1_000; await t.send(m); }
    expect(w.linear.writes).toHaveLength(written);
    expect(w.linear.commentsOf(A).length).toBeGreaterThan(0);
    // The thread is the ticket's: no other ticket got a word.
    expect(new Set(w.linear.commentsOf(A).map((entry) => entry.issue))).toEqual(new Set(["ENG-1"]));
  });
});

describe("a move that is not a plain step forward is left alone, in words", () => {
  it("a ticket already Done or Canceled, or a person's own later status, is not moved back; the comment still goes", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const done = await w.task(A, "payments", "ENG-1");
    w.linear.setState(A, "ENG-1", "Done");
    await done.send(done.milestone("started"));
    const canceled = await w.task(A, "payments", "ENG-2");
    w.linear.setState(A, "ENG-2", "Canceled");
    await canceled.send(canceled.milestone("started"));
    const ahead = await w.task(A, "payments", "ENG-3");
    w.linear.setState(A, "ENG-3", "In Review");
    await ahead.send(ahead.milestone("started"));
    expect(w.linear.moves(A)).toEqual([]);
    expect([w.linear.stateOf(A, "ENG-1"), w.linear.stateOf(A, "ENG-2"), w.linear.stateOf(A, "ENG-3")]).toEqual(["Done", "Canceled", "In Review"]);
    expect(w.linear.commentsOf(A)).toHaveLength(3);
    // The comment does not claim a status it did not move to.
    expect(w.linear.commentsOf(A).every((entry) => !entry.body.includes("Status:"))).toBe(true);
    expect(w.logs.some((entry) => entry["event"] === "ticket_update.status_not_forward")).toBe(true);
  });

  it("a team with no status of that name is noted for the project's card and the comment still goes; a later move that works clears the note", async () => {
    const w = await world({ states: DEFAULT_STATES.filter((state) => state.name !== "In Review") });
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    await t.send(t.milestone("started"));
    await t.send(t.milestone("pr_ready", { pullRequests: [PR] }));
    expect(w.linear.moves(A)).toEqual(["In Progress"]);
    expect(w.linear.stateOf(A, "ENG-1")).toBe("In Progress");
    expect(w.linear.commentsOf(A).map((entry) => entry.body.split("\n")[0])).toEqual(['Rovara started work on this ticket: "Refunds fail".', 'Rovara opened a pull request for this ticket: "Refunds fail".']);
    const table = { store: w.store, now: () => w.clock.now };
    expect(await readStatusMissing(table, A, "linear", "payments")).toEqual({ pr_opened: "In Review" });
    // Another company's, and another project's, are not touched by it.
    expect(await readStatusMissing(table, B, "linear", "payments")).toEqual({});
    expect(await readStatusMissing(table, A, "linear", "other")).toEqual({});
    expect(w.logs.some((entry) => entry["event"] === "ticket_update.status_missing" && entry["moment"] === "pr_opened")).toBe(true);
    await t.send(t.milestone("merged"));
    expect(w.linear.moves(A)).toEqual(["In Progress", "Done"]);
    // The pull request moment's note stays until a move for THAT moment works.
    expect(await readStatusMissing(table, A, "linear", "payments")).toEqual({ pr_opened: "In Review" });
  });

  it("status changes switched off move nothing and write the comment (a person's saved choice is honoured)", async () => {
    const w = await world();
    await w.settle(A, "payments", { ...STATUS_ONLY, changeStatus: false });
    const t = await w.task(A, "payments", "ENG-1");
    await t.send(t.milestone("started"));
    expect(w.linear.moves(A)).toEqual([]);
    expect(w.linear.commentsOf(A)).toHaveLength(1);
  });
});

describe("a ticket write that fails never fails the task, and posts once", () => {
  it("revoked write access (Linear refuses the move and the comment): noted for the page, settled, never retried, nothing thrown", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    w.linear.fail("issueUpdate", "http_403");
    w.linear.fail("commentCreate", "http_403");
    await expect(t.send(t.milestone("started"))).resolves.toBeUndefined();
    expect(w.linear.writes).toEqual([]);
    expect(await readWriteAccess({ store: w.store, now: () => w.clock.now }, A, ["linear"])).toMatchObject([{ tracker: "linear", state: "needs_write_access" }]);
    expect(w.logs.some((entry) => entry["event"] === "ticket_update.sent" && entry["outcome"] === "needs_write_access")).toBe(true);
    // A second delivery of the same milestone finds it settled: no more calls.
    const calls = w.linear.reads.length;
    await t.send(t.milestone("started"));
    expect(w.linear.reads).toHaveLength(calls);
    expect(w.linear.writes).toEqual([]);
  });

  it("a company whose connection is gone (disconnected, or Linear revoked the app): nothing is written, nothing throws, and it is settled in words", async () => {
    const w = await world({ disconnected: true });
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    await expect(t.send(t.milestone("started"))).resolves.toBeUndefined();
    expect(w.linear.writes).toEqual([]);
    expect(w.linear.reads).toEqual([]);
    expect(JSON.stringify(w.logs)).not.toContain("tok-");
  });

  it("a Linear outage: the milestone host tells the handler again after the backoff, and the comment and the move land exactly once", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const t = await w.task(A, "payments", "ENG-1");
    const milestones = createDocumentMilestones({ store: w.store, now: () => w.clock.now, companyId: A });
    for (const handler of w.handlers.get(A)!) milestones.register(handler);
    w.linear.fail("issueUpdate", "server_error", 1);
    w.linear.fail("commentCreate", "server_error", 1);
    await w.store.transact(codeMilestoneItems(t.milestone("started"), 1));
    await milestones.deliver(t.taskId);
    expect(w.linear.writes).toEqual([]);
    // Not due yet: the sweep tells nobody.
    expect(await milestones.deliverDue()).toEqual({ attempted: 0 });
    // Each failure is told again later than the last (the move failed first, then the comment): the sweep keeps coming back until both have landed, and then stops.
    w.clock.now += 5 * 60_000;
    expect(await milestones.deliverDue()).toEqual({ attempted: 1 });
    expect(w.linear.moves(A)).toEqual(["In Progress"]);
    expect(commentIds(w, A)).toEqual([]);
    w.clock.now += 10 * 60_000;
    expect(await milestones.deliverDue()).toEqual({ attempted: 1 });
    expect(commentIds(w, A)).toEqual([oneShotId(t.taskId, "started")]);
    // The sweep once more, and a delivery by hand: nothing posts or moves again.
    w.clock.now += 10 * 60_000;
    expect(await milestones.deliverDue()).toEqual({ attempted: 0 });
    await milestones.deliver(t.taskId);
    expect(commentIds(w, A)).toHaveLength(1);
  });

  it("a comment whose answer was lost is the same comment on the next try (Linear holds the id): it is never posted twice", async () => {
    const w = await world();
    await w.settle(A, "payments", { ...STATUS_ONLY, changeStatus: false });
    const t = await w.task(A, "payments", "ENG-1");
    // The create reaches Linear and the answer is lost: the first call stored the comment, then the caller was told it failed.
    w.linear.beforeWrite(async () => undefined);
    await t.send(t.milestone("started"));
    const id = oneShotId(t.taskId, "started");
    // Another process (no claim of ours left) tries the same moment: the same id; Linear refuses a second, the caller finds the first.
    await w.store.delete({ key: { pk: `DEVTASK#${t.taskId}`, sk: "TICKET_UPDATE#started" } });
    await t.send(t.milestone("started"));
    expect(w.linear.commentsOf(A)).toHaveLength(1);
    expect([...w.linear.comments.keys()]).toEqual([id]);
  });
});

describe("a reconnect to another Linear workspace never moves or comments on an unrelated issue with the same key", () => {
  it("the ticket's own workspace decides: after the company reconnects elsewhere nothing is moved or written and it is settled in words; in the same workspace it moves", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    const same = await w.task(A, "payments", "ENG-1");
    await same.send(same.milestone("started"));
    expect(w.linear.moves(A)).toEqual(["In Progress"]);
    const before = w.linear.writes.length;
    // The company reconnects to another workspace, where ENG-2 is an unrelated issue; the ticket's own link still says "acme".
    const moved = await w.task(A, "payments", "ENG-2");
    w.linear.reconnectTo(A, "gamma");
    await expect(moved.send(moved.milestone("started"))).resolves.toBeUndefined();
    expect(w.linear.writes).toHaveLength(before);
    expect(w.linear.stateOf(A, "ENG-2")).toBe("Todo");
    expect(w.logs.some((entry) => entry["event"] === "ticket_update.sent" && entry["outcome"] === "not_found")).toBe(true);
    // The tracker says it in words too: a move for a ticket of the old workspace is a refusal, not a move.
    const tracker = hostedTrackerFor(A, { accessToken: async (asked: string) => `tok-${asked}` }, w.linear.fetch)("linear")!;
    await expect(tracker.setStatusByName!({ tracker: "linear", id: "ENG-2", url: "https://linear.app/acme/issue/ENG-2/x" }, "Done", { orgId: A })).rejects.toMatchObject({ reason: "not_found" });
    expect(w.linear.moves(A)).toEqual(["In Progress"]);
    // A ticket that belongs to the workspace the company is now connected to still moves.
    await expect(tracker.setStatusByName!({ tracker: "linear", id: "ENG-2", url: "https://linear.app/gamma/issue/ENG-2/x" }, "Done", { orgId: A })).resolves.toBe("moved");
    expect(w.linear.moves(A)).toEqual(["In Progress", "Done"]);
  });

  it("a ticket link that is set but is not a Linear issue link names no workspace: the move is refused (not_found), never made on a guess, and Linear is not asked", async () => {
    const w = await world();
    const tracker = hostedTrackerFor(A, { accessToken: async (asked: string) => `tok-${asked}` }, w.linear.fetch)("linear")!;
    for (const url of ["https://evil.example/acme/issue/ENG-2/x", "not a link", "http://linear.app/acme/issue/ENG-2/x"]) {
      await expect(tracker.setStatusByName!({ tracker: "linear", id: "ENG-2", url }, "Done", { orgId: A })).rejects.toMatchObject({ reason: "not_found" });
    }
    expect(w.linear.reads).toEqual([]);
    expect(w.linear.moves(A)).toEqual([]);
  });
});

describe("each company writes only with its own token, to its own workspace", () => {
  it("two companies with the same ticket key: each ticket is written in its own workspace; a milestone told to the other company's handler writes nothing", async () => {
    const w = await world();
    await w.settle(A, "payments", STATUS_ONLY);
    await w.settle(B, "payments", STATUS_ONLY);
    const a = await w.task(A, "payments", "ENG-1");
    const b = await w.task(B, "payments", "ENG-1");
    await a.send(a.milestone("started"));
    await b.send(b.milestone("started"));
    expect(w.linear.writes.filter((write) => write.company === A).length).toBe(2);
    expect(w.linear.writes.filter((write) => write.company === B).length).toBe(2);
    expect([w.linear.stateOf(A, "ENG-1"), w.linear.stateOf(B, "ENG-1")]).toEqual(["In Progress", "In Progress"]);
    // A's handler told of B's task writes nothing (the task is another company's).
    const before = w.linear.writes.length;
    for (const handler of w.handlers.get(A)!) await handler.on(b.milestone("merged"));
    expect(w.linear.writes).toHaveLength(before);
  });
});

describe("the company's tracker refuses another company's scope before any token is read", () => {
  it("a status move or a comment asked under company B's scope through company A's tracker is refused and nothing is sent", async () => {
    const w = await world();
    const tracker = hostedTrackerFor(A, { accessToken: async (asked: string) => `tok-${asked}` }, w.linear.fetch)("linear")!;
    const ref = { tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" };
    await expect(tracker.setStatusByName!(ref, "Done", { orgId: B })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(tracker.setStatusByName!(ref, "Done", { system: "install" })).rejects.toThrow();
    await expect(tracker.comment!(ref, "x", { orgId: B }, { key: "k" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(w.linear.reads).toEqual([]);
    expect(w.linear.writes).toEqual([]);
  });
});

describe("the one-time flip of the seeded status default (DEC 254zzz466 c)", () => {
  const seed = (w: World, company: OrgId, project: string) => seedTicketUpdatesIfUnset({ store: w.store, now: () => w.clock.now }, { orgId: company, project, settings: { ...HOSTED_SEED_TICKET_UPDATES, changeStatus: false }, by: "owner" });
  const flipper = (w: World, company: OrgId, projects: string[], audit: AuditEvent[], options: { auditFails?: boolean } = {}) => ({
    store: w.store, now: () => w.clock.now, projects: async () => projects,
    audit: { record: async (event: AuditEvent) => { if (options.auditFails === true) throw new Error("ledger down"); audit.push(event); } },
    log: (event: string, fields: Record<string, unknown>) => { w.logs.push({ event, ...fields }); },
    company,
  });
  // The operator's go for company A (controller decision 2026-11-24): every flip below runs after it, except the test that proves the flip waits for it.
  const go = (w: World) => releaseStatusFlip({ store: w.store, now: () => w.clock.now }, A, "operator");

  it("a new project's first team pick now seeds the move ON (the Code-side seed), with the whole conversation", () => {
    expect(HOSTED_SEED_TICKET_UPDATES).toMatchObject({ comments: true, changeStatus: true, level: "full", statuses: { started: "In Progress", pr_opened: "In Review", merged: "Done" } });
  });

  it("waits for the operator's go: with no go row nothing is flipped, nothing audited, the pass is not marked done and a waiting line is logged; another company's go does not release this one; once released it flips", async () => {
    const w = await world();
    await seed(w, A, "seeded");
    const audit: AuditEvent[] = [];
    const { company, ...base } = flipper(w, A, ["seeded"], audit);
    await releaseStatusFlip({ store: w.store, now: () => w.clock.now }, B, "operator");
    expect(await flipSeededStatusDefaults(base, company)).toBe(0);
    expect(await flipSeededStatusDefaults(base, company)).toBe(0);
    expect(audit).toEqual([]);
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "seeded")).settings.changeStatus).toBe(false);
    expect(w.logs.filter((entry) => entry["event"] === "ticket_update.status_default_flip_waiting")).toHaveLength(2);
    // A go row in this company's partition that names another company is no go.
    await w.store.put({ item: { ...statusFlipGoKey(A), entityType: "TICKET_STATUS_FLIP", orgId: B, by: "operator", at: "2026-11-24T00:00:00.000Z" } });
    expect(await flipSeededStatusDefaults(base, company)).toBe(0);
    await releaseStatusFlip({ store: w.store, now: () => w.clock.now }, A, "operator");
    expect(await flipSeededStatusDefaults(base, company)).toBe(1);
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "seeded")).settings.changeStatus).toBe(true);
  });

  it("turns on only the rows nobody saved over: the seed row (revision 1) flips to revision 2 by the system with every other setting kept; a saved choice, even a saved off, is never touched", async () => {
    const w = await world();
    await go(w);
    await seed(w, A, "seeded");
    await seed(w, A, "also-seeded");
    await w.settle(A, "chosen-off", { comments: true, changeStatus: false, statuses: {}, level: "decisions" });
    await seed(w, A, "edited-after-seed");
    await saveTicketUpdates({ store: w.store, now: () => w.clock.now }, { orgId: A, project: "edited-after-seed", requestId: randomUUID(), by: "person", settings: { ...HOSTED_SEED_TICKET_UPDATES, changeStatus: false } });
    await seed(w, B, "other-company");
    const audit: AuditEvent[] = [];
    const table = flipper(w, A, ["seeded", "also-seeded", "chosen-off", "edited-after-seed", "never-saved"], audit);
    const { company, ...base } = table;
    expect(await seededStatusRows(base, A)).toEqual(["seeded", "also-seeded"]);
    expect(await flipSeededStatusDefaults(base, company)).toBe(2);
    for (const project of ["seeded", "also-seeded"]) {
      const row = await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, project);
      expect(row).toMatchObject({ revision: 2, requestId: STATUS_DEFAULT_REQUEST_ID, settings: { ...HOSTED_SEED_TICKET_UPDATES, changeStatus: true } });
      expect((await w.store.get(ticketUpdatesSettingsKey(A, project)))?.["by"]).toBe("system");
    }
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "chosen-off")).settings.changeStatus).toBe(false);
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "edited-after-seed")).settings.changeStatus).toBe(false);
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "never-saved")).revision).toBe(0);
    // Another company's seeded row is its own company's pass, untouched here.
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, B, "other-company")).settings.changeStatus).toBe(false);
    // One audit row per project changed, by the system, naming the project and nothing of the ticket system.
    expect(audit.map((event) => [event.action, event.subject?.id, event.actor.type, event.companyId])).toEqual([
      ["ticket_updates.status_default_on", "seeded", "system", A], ["ticket_updates.status_default_on", "also-seeded", "system", A],
    ]);
  });

  // Review 6.2a: the read guard on revision 1 is its own check (not only the conditional write): a row that still carries the seed's request id at another revision is not touched and nothing is audited for it.
  it("a row with the seed's request id but not revision 1 is left alone and records no audit row", async () => {
    const w = await world();
    await go(w);
    await seed(w, A, "odd");
    await w.store.update({ key: ticketUpdatesSettingsKey(A, "odd"), ops: [change.set("revision", 2)] });
    const audit: AuditEvent[] = [];
    const { company, ...base } = flipper(w, A, ["odd"], audit);
    expect(await flipSeededStatusDefaults(base, company)).toBe(0);
    expect(audit).toEqual([]);
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "odd")).settings.changeStatus).toBe(false);
  });

  it("runs once: a second pass changes nothing and records nothing, and a project seeded afterwards is not flipped (it is seeded ON already)", async () => {
    const w = await world();
    await go(w);
    await seed(w, A, "seeded");
    const audit: AuditEvent[] = [];
    const { company, ...base } = flipper(w, A, ["seeded", "later"], audit);
    expect(await flipSeededStatusDefaults(base, company)).toBe(1);
    await seed(w, A, "later");
    expect(await flipSeededStatusDefaults(base, company)).toBe(0);
    expect(audit).toHaveLength(1);
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "later")).settings.changeStatus).toBe(false);
  });

  it("the audit row comes BEFORE the change: a ledger that cannot take it leaves the row as it was, and the pass is not marked done (the next one tries again)", async () => {
    const w = await world();
    await go(w);
    await seed(w, A, "seeded");
    const { company, ...broken } = flipper(w, A, ["seeded"], [], { auditFails: true });
    await expect(flipSeededStatusDefaults(broken, company)).rejects.toThrow("ledger down");
    expect((await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "seeded")).settings.changeStatus).toBe(false);
    const audit: AuditEvent[] = [];
    const { company: again, ...ok } = flipper(w, A, ["seeded"], audit);
    expect(await flipSeededStatusDefaults(ok, again)).toBe(1);
  });

  it("a person who saves at the same moment wins: the flip is one conditional write on revision 1 and the seed's request id", async () => {
    const w = await world();
    await go(w);
    await seed(w, A, "seeded");
    const audit: AuditEvent[] = [];
    const { company, ...base } = flipper(w, A, ["seeded"], audit);
    const racing = { ...base, audit: { record: async (event: AuditEvent) => {
      audit.push(event);
      await saveTicketUpdates({ store: w.store, now: () => w.clock.now }, { orgId: A, project: "seeded", requestId: randomUUID(), by: "person", settings: { ...HOSTED_SEED_TICKET_UPDATES, changeStatus: false, level: "status_only" } });
    } } };
    expect(await flipSeededStatusDefaults(racing, company)).toBe(0);
    expect(await readTicketUpdates({ store: w.store, now: () => w.clock.now }, A, "seeded")).toMatchObject({ revision: 2, settings: { changeStatus: false, level: "status_only" } });
  });
});
