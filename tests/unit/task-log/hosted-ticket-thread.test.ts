// L4-LP2: the task log and the ticket thread on a HOSTED company (`hostedTicketUpdates`): the company's own Linear connection behind a fake GraphQL fetch, the real handlers, the real task log and ticket updates over a
// memory store that two companies share (keys are company-scoped). What is held: status_only is today's one-shot comment (golden, whatever the log holds); a task only its owner can see never goes above status_only,
// at any level; a shared task goes up to the project's level; each company writes only for its own tasks with its own token; projects choose their own level; the plan's summary appears in the log when it is supplied.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { agentSessionKey, intakeItemIdOf, ticketUpdatesSettingsKey, type CodeMilestone, type OrgId, type Principal, type TicketUpdateLevel } from "@agentx/contracts";
import { hostedTicketUpdates, hostedTrackerFor } from "../../../packages/broker/src/aws/hosted-intake.js";
import { ticketSessionStartExtras } from "../../../packages/broker/src/aws/hosted-intake.js";
import { claimIntakeItem, markIntakeStarted } from "../../../packages/broker/src/core/intake/store.js";
import { bindSessionSurface } from "../../../packages/broker/src/core/sessions/bindings.js";
import { createSessionStartExtras } from "../../../packages/broker/src/local/app/session-start.js";
import { originTicketOf, saveTicketUpdates, ticketStartedShared, THREAD_ROOT_EDIT_GAP_MS } from "../../../packages/broker/src/core/ticket-updates/index.js";
import { answerEntriesOf, appendTaskLog, createTaskLogHooks, questionEntriesOf, readTaskLog } from "../../../packages/broker/src/core/task-log/index.js";
import { MemoryDocumentStore } from "../../../packages/broker/src/ports/memory-document-store.js";
import { linearCommentIdFor } from "../../../packages/broker/src/plugins/tracker/linear/api.js";

const A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const URL_KEY: Record<string, string> = { [A]: "acme", [B]: "beta" };
const QUESTIONS = [{ id: "q1", text: "Cap value?", options: [{ id: "a", label: "20,000" }, { id: "b", label: "50,000" }] }];

interface Comment { id: string; issue: string; parent?: string | undefined; body: string; company: string }

/** A fake Linear: each company's token reads and writes only its own workspace; every write is recorded with the token's company. */
function fakeLinear() {
  const comments = new Map<string, Comment>();
  const writes: Array<{ company: string; kind: "create" | "edit"; id: string; parent?: string | undefined; body: string }> = [];
  const companyOfToken = (header: string): string => header.replace("Bearer tok-", "");
  const impl: typeof fetch = async (_input, init) => {
    const company = companyOfToken(String((init?.headers as Record<string, string>)["authorization"] ?? (init?.headers as Record<string, string>)["Authorization"] ?? ""));
    const body = JSON.parse(init?.body as string) as { query: string; variables: Record<string, unknown> };
    const reply = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
    const q = body.query;
    if (q.includes("issue(id:")) {
      const key = (body.variables["id"] as string);
      return reply({ issue: { id: `iss:${company}:${key}`, identifier: key, url: `https://linear.app/${URL_KEY[company]}/issue/${key}/x`, state: { name: "Todo" }, team: { states: { nodes: [] } } } });
    }
    if (q.includes("comment(id:")) {
      const found = comments.get((body.variables["id"] as string));
      return reply({ comment: found === undefined || found.company !== company ? null : { id: found.id, issue: { identifier: found.issue }, ...(found.parent === undefined ? {} : { parent: { id: found.parent } }) } });
    }
    if (q.includes("commentCreate")) {
      const input = body.variables["input"] as { id: string; issueId: string; body: string; parentId?: string };
      const issue = input.issueId.split(":")[2]!;
      if (!comments.has(input.id)) comments.set(input.id, { id: input.id, issue, parent: input.parentId, body: input.body, company });
      writes.push({ company, kind: "create", id: input.id, parent: input.parentId, body: input.body });
      return reply({ commentCreate: { success: true } });
    }
    if (q.includes("commentUpdate")) {
      const id = (body.variables["id"] as string);
      const found = comments.get(id)!;
      found.body = (body.variables["input"] as { body: string }).body;
      writes.push({ company, kind: "edit", id, body: found.body });
      return reply({ commentUpdate: { success: true } });
    }
    return new Response(JSON.stringify({ errors: [{ message: "unexpected" }] }), { status: 200 });
  };
  return { fetch: impl, comments, writes };
}

async function world(options: { planSummary?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  const linear = fakeLinear();
  const clock = { now: Date.parse("2026-11-17T12:00:00.000Z") };
  const logs: Array<Record<string, unknown>> = [];
  const hookTable = new Map<string, ReturnType<typeof createTaskLogHooks>>([[A, createTaskLogHooks()], [B, createTaskLogHooks()]]);
  const hook = (company: OrgId) => hookTable.get(company)!;
  const summaries: Array<[string, string]> = [];
  const handlersOf = (company: OrgId) => hostedTicketUpdates({
    companyId: company, store, connections: { accessToken: async (asked: string) => `tok-${asked}` }, fetch: linear.fetch, now: () => clock.now, log: (entry) => logs.push(entry), taskLog: hook(company),
    ...(options.planSummary === true ? { planSummaryOf: async (org: OrgId, taskId: string) => { summaries.push([org, taskId]); return { revision: 1, needed: "Add a cap to campaigns", lines: ["Add a field", "Check it"], risk: "medium", estimate: "$4 to $10" }; } } : {}),
  });
  const handlerTable = new Map<string, ReturnType<typeof handlersOf>>([[A, handlersOf(A)], [B, handlersOf(B)]]);
  const handlersFor = (company: OrgId) => handlerTable.get(company)!;
  const at = (): string => new Date(clock.now).toISOString();
  const setLevel = (company: OrgId, project: string, level: TicketUpdateLevel | undefined) => saveTicketUpdates({ store, now: () => clock.now }, {
    orgId: company, project, requestId: randomUUID(), by: "owner", settings: { comments: true, changeStatus: false, statuses: {}, ...(level === undefined ? {} : { level }) },
  });
  /**
   * A task started from a Linear ticket by intake (its session and ticket binding in the start's transaction, the intake item marked started for THIS task). `origin` says how the ticket and the task relate:
   * "intake" (the default): the intake item names this task; "hand_linked": the task came from elsewhere (Slack, web) and its session was bound to the ticket by hand, no intake item; "raced": the intake item says
   * started for this session but names ANOTHER task (a duplicate or raced start); "none": no ticket at all.
   */
  async function task(company: OrgId, project: string, key: string, options: { shared?: boolean; origin?: "intake" | "hand_linked" | "raced" | "none" } = {}) {
    const origin = options.origin ?? "intake";
    const taskId = randomUUID();
    const principal: Principal = { companyId: company, personId: `owner-${company.slice(4, 8)}`, displayName: "Owner", roles: ["member"], provider: "hosted" };
    const url = `https://linear.app/${URL_KEY[company]}/issue/${key}/x`;
    const table = { store, now: () => clock.now };
    const itemId = intakeItemIdOf("linear", key);
    let sessionId: string;
    if (origin === "intake" || origin === "raced") {
      const extras = ticketSessionStartExtras(company)({ taskId, project, title: "Refunds fail", principal, client: "tracker", receivedAt: at(), ticket: { system: "linear", id: key, url } });
      await store.transact([...extras.items]);
      sessionId = extras.sessionId!;
    } else {
      const extras = createSessionStartExtras(company)({ taskId, project, title: "Refunds fail", principal, client: "web", receivedAt: at() });
      await store.transact([...extras.items]);
      sessionId = extras.sessionId!;
      if (origin === "hand_linked") await bindSessionSurface(table, { orgId: company, sessionId, binding: { kind: "tracker_item", system: "linear", id: key, url } });
    }
    await store.put({ item: { pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId, companyId: company, project, sessionId, title: "Refunds fail", developerId: principal.personId } });
    if (origin === "intake" || origin === "raced") {
      await claimIntakeItem(table, { orgId: company, project, itemId, channel: "tracker", system: "linear", id: key, url, title: "Refunds fail", requester: { display: "Dana", standing: "outsider" }, state: "starting", startedBy: "holder" });
      await markIntakeStarted(table, company, project, itemId, { holder: "holder", taskId: origin === "raced" ? randomUUID() : taskId, sessionId, requester: { display: "Dana", standing: "outsider" } });
    }
    if (options.shared === true) await store.put({ item: { ...agentSessionKey(company, sessionId, "SHARE#1"), principal: { kind: "org" }, level: "view", sharedBy: { developerId: "a".repeat(64), name: "Owner" }, sharedAt: at() } });
    const milestone = (kind: CodeMilestone["kind"], over: Partial<CodeMilestone> = {}): CodeMilestone => ({ kind, orgId: company, taskId, sessionId, at: at(), text: "x", ...over });
    const log = (entries: Parameters<typeof appendTaskLog>[1]["entries"]) => appendTaskLog(store, { orgId: company, taskId, entries });
    const send = async (m: CodeMilestone) => { for (const handler of handlersFor(company)) await handler.on(m); };
    return { taskId, sessionId, milestone, log, send, company };
  }
  const roots = (company: OrgId) => [...linear.comments.values()].filter((c) => c.company === company && c.parent === undefined);
  return { store, linear, clock, logs, hook, handlersFor, setLevel, task, at, roots, summaries };
}
type World = Awaited<ReturnType<typeof world>>;
const qa = (w: World, round = 1) => [...questionEntriesOf({ round, at: w.at(), questions: QUESTIONS }), ...answerEntriesOf({ round, at: w.at(), by: "Ana Ruiz", surface: "slack", questions: QUESTIONS, answers: [{ questionId: "q1", optionId: "a" }] })];

describe("hosted: status only is today's one-shot comment, byte for byte", () => {
  it("writes the fixed words once, to the company's own workspace, whatever the log holds and even for a shared task (no level set, and a level of status_only)", async () => {
    for (const level of [undefined, "status_only"] as const) {
      const w = await world();
      if (level !== undefined) await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1", { shared: true });
      await t.log(qa(w));
      await t.send(t.milestone("started"));
      expect(w.linear.writes).toEqual([{ company: A, kind: "create", id: linearCommentIdFor(A, `ticket_update:${t.taskId}:started`), parent: undefined, body: 'Rovara started work on this ticket: "Refunds fail".' }]);
      // No thread row, no root, no edit; the log entries never reach the ticket.
      expect(await w.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
      await w.hook(A).changed(t.taskId);
      expect(w.linear.writes).toHaveLength(1);
    }
  });
});

describe("hosted: a task only its owner can see, and not started from a ticket, never goes above status only", () => {
  const LOG_AFTER = async (w: World, t: Awaited<ReturnType<World["task"]>>) => {
    await t.log(qa(w));
    await t.send(t.milestone("started"));
    await w.hook(A).changed(t.taskId);
    w.clock.now += THREAD_ROOT_EDIT_GAP_MS + 1;
    await t.log(questionEntriesOf({ round: 2, at: w.at(), questions: QUESTIONS }));
    await w.hook(A).changed(t.taskId);
    await t.send(t.milestone("merged"));
  };
  for (const level of ["decisions", "plan_decisions", "full"] as const) {
    it(`at the ${level} level a task whose ticket was linked by hand gets nothing (no ticket it started from): no root, no reply, no edit, by milestone or by the log's hook`, async () => {
      const w = await world();
      await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1", { origin: "hand_linked" });
      await LOG_AFTER(w, t);
      expect(w.linear.writes).toEqual([]);
      expect(await w.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    });

    it(`at the ${level} level a task started from Slack, the web or an AI tool (no ticket at all) gets nothing`, async () => {
      const w = await world();
      await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1", { origin: "none" });
      await LOG_AFTER(w, t);
      expect(w.linear.writes).toEqual([]);
      expect(await w.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    });

    it(`at the ${level} level a duplicate or raced start (the intake item is started for the session but names another task) gets the one-shot comment only: no root, no reply, no edit`, async () => {
      const w = await world();
      await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1", { origin: "raced" });
      await LOG_AFTER(w, t);
      expect(w.linear.writes.map((write) => write.kind)).toEqual(["create", "create"]);
      expect(w.linear.writes.map((write) => write.parent)).toEqual([undefined, undefined]);
      expect(w.linear.writes[0]!.body).toBe('Rovara started work on this ticket: "Refunds fail".');
      expect(await w.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    });
  }
});

describe("hosted: a task started from a ticket is shared for the ticket's thread above status only (owner decision 254zzq)", () => {
  for (const level of ["decisions", "plan_decisions", "full"] as const) {
    it(`at the ${level} level a ticket-started task with no share and no People entry gets one root comment edited in place, with the decision and who made it, by milestone and by the log's hook`, async () => {
      const w = await world();
      await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1");
      await t.send(t.milestone("started"));
      expect(w.roots(A)).toHaveLength(1);
      expect(w.linear.writes[0]).toMatchObject({ company: A, kind: "create", parent: undefined });
      await t.log(qa(w));
      w.clock.now += THREAD_ROOT_EDIT_GAP_MS + 1;
      await w.hook(A).changed(t.taskId);
      expect(w.roots(A)).toHaveLength(1);
      expect(await w.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "TICKET_THREAD" })).toBeDefined();
      expect([...w.linear.comments.values()].map((c) => c.body).join("\n")).toContain("Ana Ruiz");
      expect(w.linear.writes.every((write) => write.company === A)).toBe(true);
      // The one-shot "started" comment is not also written: the thread replaces it at these levels.
      expect(w.linear.writes.some((write) => write.body === 'Rovara started work on this ticket: "Refunds fail".')).toBe(false);
    });
  }

  it("at full a question comes as a reply in the thread", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    const t = await w.task(A, "payments", "ENG-1");
    await t.send(t.milestone("started"));
    await t.log(questionEntriesOf({ round: 1, at: w.at(), questions: QUESTIONS }));
    await w.hook(A).changed(t.taskId);
    expect([...w.linear.comments.values()].filter((c) => c.parent !== undefined)).toHaveLength(1);
  });

  it("at status_only (or no level saved, or a level saved before the levels) the same ticket-started task gets today's one-shot comment: no thread, whatever the log holds", async () => {
    for (const level of [undefined, "status_only"] as const) {
      const w = await world();
      if (level !== undefined) await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1");
      await t.log(qa(w));
      await t.send(t.milestone("started"));
      await w.hook(A).changed(t.taskId);
      expect(w.linear.writes).toEqual([{ company: A, kind: "create", id: linearCommentIdFor(A, `ticket_update:${t.taskId}:started`), parent: undefined, body: 'Rovara started work on this ticket: "Refunds fail".' }]);
      expect(await w.store.get({ pk: `DEVTASK#${t.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    }
  });

  it("is not a way round the other gates: comments off writes nothing", async () => {
    const w = await world();
    await saveTicketUpdates({ store: w.store, now: () => w.clock.now }, { orgId: A, project: "payments", requestId: randomUUID(), by: "owner", settings: { comments: false, changeStatus: false, statuses: {}, level: "full" } });
    const t = await w.task(A, "payments", "ENG-1");
    await t.log(qa(w));
    await t.send(t.milestone("started"));
    await w.hook(A).changed(t.taskId);
    expect(w.linear.writes).toEqual([]);
  });
});

describe("ticketStartedShared: the rule itself", () => {
  const sharedOf = (w: World, scope: { orgId: OrgId } = { orgId: A }) => ticketStartedShared({ store: w.store, now: () => w.clock.now, scope });

  it("is true for a task intake started from a ticket above status_only (each level), and false at status_only, with no level saved, or with a level that does not parse", async () => {
    for (const [level, expected] of [["decisions", true], ["plan_decisions", true], ["full", true], ["status_only", false], [undefined, false]] as const) {
      const w = await world();
      if (level !== undefined) await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1");
      expect(await sharedOf(w)(A, t.taskId), String(level)).toBe(expected);
    }
    const bad = await world();
    await bad.store.put({ item: { ...ticketUpdatesSettingsKey(A, "payments"), entityType: "TICKET_UPDATES", orgId: A, project: "payments", settings: { level: "everything" }, revision: 1 } });
    const t = await bad.task(A, "payments", "ENG-1");
    expect(await sharedOf(bad)(A, t.taskId)).toBe(false);
  });

  it("is false for a task whose ticket was linked by hand, a raced start, a task with no ticket, a missing task and a task with no project or session", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    for (const origin of ["hand_linked", "raced", "none"] as const) {
      const t = await w.task(A, "payments", `ENG-${origin}`, { origin });
      expect(await sharedOf(w)(A, t.taskId), origin).toBe(false);
      // Positive control for the "raced" case: the loose rule (the item is started for this session) does name a ticket, only the strict one refuses it.
      if (origin === "raced") expect(await originTicketOf({ store: w.store, now: () => w.clock.now }, { orgId: A, project: "payments", taskId: t.taskId, sessionId: t.sessionId })).toBeDefined();
    }
    expect(await sharedOf(w)(A, randomUUID())).toBe(false);
    const noSession = randomUUID();
    await w.store.put({ item: { pk: `DEVTASK#${noSession}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: noSession, companyId: A, project: "payments", title: "t" } });
    expect(await sharedOf(w)(A, noSession)).toBe(false);
    const noProject = randomUUID();
    await w.store.put({ item: { pk: `DEVTASK#${noProject}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: noProject, companyId: A, sessionId: "s", title: "t" } });
    expect(await sharedOf(w)(A, noProject)).toBe(false);
  });

  it("keeps the answer of the records it composes with: a task the base says is shared stays shared (even at status_only), a base that throws does not hide a ticket-started task", async () => {
    const w = await world();
    const t = await w.task(A, "payments", "ENG-1", { origin: "hand_linked" });
    const base = async () => true;
    expect(await ticketStartedShared({ store: w.store, now: () => w.clock.now, scope: { orgId: A } }, base)(A, t.taskId)).toBe(true);
    await w.setLevel(A, "payments", "full");
    const ticket = await w.task(A, "payments", "ENG-2");
    const throwing = async (): Promise<boolean> => { throw new Error("store down"); };
    expect(await ticketStartedShared({ store: w.store, now: () => w.clock.now, scope: { orgId: A } }, throwing)(A, ticket.taskId)).toBe(true);
    // A store fault inside the ticket rule is no answer: the records still say shared.
    const faulty = { get: async () => { throw new Error("store down"); } } as unknown as typeof w.store;
    expect(await ticketStartedShared({ store: faulty, now: () => w.clock.now, scope: { orgId: A } }, base)(A, t.taskId)).toBe(true);
    expect(await ticketStartedShared({ store: faulty, now: () => w.clock.now, scope: { orgId: A } })(A, t.taskId)).toBe(false);
    // Neither true nor shared: a throwing base on a not-ticket-started task is an error the caller fails closed on.
    await expect(ticketStartedShared({ store: w.store, now: () => w.clock.now, scope: { orgId: A } }, throwing)(A, t.taskId)).rejects.toThrow("store down");
  });

  it("is company-scoped: company A's rule is false for company B's task (even one company A's level would allow), and a rule scoped to A refuses B's task even when B's own records allow it", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    await w.setLevel(B, "payments", "full");
    const ta = await w.task(A, "payments", "ENG-1");
    const tb = await w.task(B, "payments", "ENG-1");
    expect(await sharedOf(w)(A, ta.taskId)).toBe(true);
    expect(await sharedOf(w)(A, tb.taskId)).toBe(false);
    expect(await sharedOf(w)(B, tb.taskId)).toBe(false);
    expect(await sharedOf(w, { orgId: B })(B, tb.taskId)).toBe(true);
    expect(await sharedOf(w, { orgId: B })(A, ta.taskId)).toBe(false);
    // A task record that names another company is not company A's task, whatever its session and intake item say.
    await w.store.put({ item: { ...(await w.store.get({ pk: `DEVTASK#${ta.taskId}`, sk: "META" }))!, companyId: B } });
    expect(await sharedOf(w)(A, ta.taskId)).toBe(false);
    // B at status_only while A is at full: B's level is B's own.
    const w2 = await world();
    await w2.setLevel(A, "payments", "full");
    const tb2 = await w2.task(B, "payments", "ENG-1");
    expect(await ticketStartedShared({ store: w2.store, now: () => w2.clock.now, scope: { orgId: B } })(B, tb2.taskId)).toBe(false);
  });
});

describe("hosted: a shared task goes up to the project's level", () => {
  it("full: one root comment edited in place, and a reply for the question and for the answer, with who answered and where", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    const t = await w.task(A, "payments", "ENG-1", { shared: true });
    await t.send(t.milestone("started"));
    expect(w.roots(A)).toHaveLength(1);
    expect(w.linear.writes[0]).toMatchObject({ company: A, kind: "create", parent: undefined });
    await t.log(qa(w));
    w.clock.now += THREAD_ROOT_EDIT_GAP_MS + 1;
    await w.hook(A).changed(t.taskId);
    const all = [...w.linear.comments.values()];
    expect(all.filter((c) => c.parent === undefined)).toHaveLength(1);
    expect(all.filter((c) => c.parent !== undefined).map((c) => c.body).join("\n")).toContain("Ana Ruiz");
    expect(w.linear.writes.every((write) => write.company === A)).toBe(true);
    expect(w.linear.writes.some((write) => write.kind === "edit")).toBe(true);
  });

  it("decisions: the plan's summary is not on the ticket; plan_decisions: it is (the log has it only when the host supplied the summary)", async () => {
    for (const [level, expectSummary] of [["decisions", false], ["plan_decisions", true]] as const) {
      const w = await world({ planSummary: true });
      await w.setLevel(A, "payments", level);
      const t = await w.task(A, "payments", "ENG-1", { shared: true });
      // The plan is waiting: the task's own record says so for the summary's source (supplied by the host as a function).
      await t.send(t.milestone("plan_ready"));
      expect(w.summaries.length).toBeGreaterThan(0);
      expect(w.summaries.every(([org, id]) => org === A && id === t.taskId)).toBe(true);
      expect((await readTaskLog(w.store, A, t.taskId)).map((entry) => entry.kind)).toContain("plan_summary");
      const text = w.roots(A).map((c) => c.body).join("\n");
      expect(text.includes("Add a cap to campaigns"), level).toBe(expectSummary);
    }
  });

  it("without a plan summary supplied, no plan_summary entry is logged and none is written", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "plan_decisions");
    const t = await w.task(A, "payments", "ENG-1", { shared: true });
    await t.send(t.milestone("plan_ready"));
    expect((await readTaskLog(w.store, A, t.taskId)).map((entry) => entry.kind)).not.toContain("plan_summary");
    expect(w.roots(A).map((c) => c.body).join("\n")).not.toContain("Add a cap");
  });

  it("a failing plan summary leaves the other entries and the thread alone", async () => {
    const w = await world();
    const failing = hostedTicketUpdates({
      companyId: A, store: w.store, connections: { accessToken: async () => `tok-${A}` }, fetch: w.linear.fetch, now: () => w.clock.now, log: (entry) => w.logs.push(entry),
      planSummaryOf: async () => { throw new Error("boom: sk-live secret"); },
    });
    await w.setLevel(A, "payments", "plan_decisions");
    const t = await w.task(A, "payments", "ENG-1", { shared: true });
    for (const handler of failing) await handler.on(t.milestone("plan_ready"));
    expect((await readTaskLog(w.store, A, t.taskId)).map((entry) => entry.kind)).toEqual(["status"]);
    expect(w.roots(A)).toHaveLength(1);
    expect(JSON.stringify(w.logs)).not.toContain("sk-live");
  });
});

describe("hosted: two companies and two projects", () => {
  it("each company writes only its own task, to its own workspace, with its own token, even for the same ticket key", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    await w.setLevel(B, "payments", "full");
    const ta = await w.task(A, "payments", "ENG-1", { shared: true });
    const tb = await w.task(B, "payments", "ENG-1", { shared: true });
    await ta.send(ta.milestone("started"));
    await tb.send(tb.milestone("started"));
    await ta.log(qa(w));
    await tb.log(qa(w));
    w.clock.now += THREAD_ROOT_EDIT_GAP_MS + 1;
    await w.hook(A).changed(ta.taskId);
    await w.hook(B).changed(tb.taskId);
    expect(w.roots(A)).toHaveLength(1);
    expect(w.roots(B)).toHaveLength(1);
    expect(new Set(w.linear.writes.map((write) => write.company))).toEqual(new Set([A, B]));
    // A comment is on its own company's issue only (the fake refuses to read another company's comment as its own).
    for (const comment of w.linear.comments.values()) expect(comment.issue).toBe("ENG-1");
  });

  it("company A's handlers are told company B's milestone, and company A's hook is told company B's task: nothing is written, nothing is logged for B", async () => {
    const w = await world();
    await w.setLevel(B, "payments", "full");
    const tb = await w.task(B, "payments", "ENG-1", { shared: true });
    await tb.log(qa(w));
    const before = (await readTaskLog(w.store, B, tb.taskId)).length;
    for (const handler of w.handlersFor(A)) await handler.on(tb.milestone("started"));
    await w.hook(A).changed(tb.taskId);
    expect(w.linear.writes).toEqual([]);
    expect((await readTaskLog(w.store, B, tb.taskId)).length).toBe(before);
    expect(await w.store.get({ pk: `DEVTASK#${tb.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
  });

  it("a milestone that names company A for a task that is company B's writes nothing", async () => {
    const w = await world();
    await w.setLevel(B, "payments", "full");
    const tb = await w.task(B, "payments", "ENG-1", { shared: true });
    for (const handler of w.handlersFor(A)) await handler.on({ ...tb.milestone("started"), orgId: A });
    expect(w.linear.writes).toEqual([]);
  });

  it("a ticket-started task in each company: company A at full gets its thread with its token, company B at status_only gets the one-shot comment only; each project has its own level", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    await w.setLevel(A, "web", "status_only");
    await w.setLevel(B, "payments", "status_only");
    const ta = await w.task(A, "payments", "ENG-1");
    const aWeb = await w.task(A, "web", "ENG-2");
    const tb = await w.task(B, "payments", "ENG-1");
    for (const t of [ta, aWeb, tb]) await t.send(t.milestone("started"));
    expect(await w.store.get({ pk: `DEVTASK#${ta.taskId}`, sk: "TICKET_THREAD" })).toBeDefined();
    expect(await w.store.get({ pk: `DEVTASK#${aWeb.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    expect(await w.store.get({ pk: `DEVTASK#${tb.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    for (const t of [aWeb, tb]) expect(w.linear.writes.find((write) => write.id === linearCommentIdFor(t.company, `ticket_update:${t.taskId}:started`))?.body).toBe('Rovara started work on this ticket: "Refunds fail".');
    expect(w.linear.writes.filter((write) => write.company === B).map((write) => write.kind)).toEqual(["create"]);
  });

  it("each project has its own level: a shared task in the project at full gets a thread, one in the project at status_only gets the one-shot comment", async () => {
    const w = await world();
    await w.setLevel(A, "payments", "full");
    await w.setLevel(A, "web", "status_only");
    const pay = await w.task(A, "payments", "ENG-1", { shared: true });
    const web = await w.task(A, "web", "ENG-2", { shared: true });
    await pay.send(pay.milestone("started"));
    await web.send(web.milestone("started"));
    expect(await w.store.get({ pk: `DEVTASK#${pay.taskId}`, sk: "TICKET_THREAD" })).toBeDefined();
    expect(await w.store.get({ pk: `DEVTASK#${web.taskId}`, sk: "TICKET_THREAD" })).toBeUndefined();
    expect(w.linear.writes.find((write) => write.id === linearCommentIdFor(A, `ticket_update:${web.taskId}:started`))?.body).toBe('Rovara started work on this ticket: "Refunds fail".');
  });
});

describe("hosted: the log's hook", () => {
  it("is not told, and writes nothing, when the project turned comments off", async () => {
    const w = await world();
    await saveTicketUpdates({ store: w.store, now: () => w.clock.now }, { orgId: A, project: "payments", requestId: randomUUID(), by: "owner", settings: { comments: false, changeStatus: false, statuses: {}, level: "full" } });
    const t = await w.task(A, "payments", "ENG-1", { shared: true });
    await t.log(qa(w));
    await w.hook(A).changed(t.taskId);
    expect(w.linear.writes).toEqual([]);
  });

  it("a hook told of a task that does not exist writes nothing and does not throw", async () => {
    const w = await world();
    await expect(w.hook(A).changed(randomUUID())).resolves.toBeUndefined();
    expect(w.linear.writes).toEqual([]);
  });
});

describe("hosted: the company's own Linear tracker has the thread methods, each tied to its company", () => {
  it("replies in a thread and edits a comment it wrote with the company's token; another company's scope is refused for each, before anything is sent", async () => {
    const w = await world();
    const tracker = hostedTrackerFor(A, { accessToken: async (asked: string) => `tok-${asked}` }, w.linear.fetch)("linear")!;
    const ref = { tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/x" };
    const root = await tracker.comment!(ref, "root", { orgId: A }, { key: "root" });
    expect(root).toEqual({ commentId: linearCommentIdFor(A, "root") });
    await tracker.comment!(ref, "reply", { orgId: A }, { key: "reply-1", parentId: linearCommentIdFor(A, "root") });
    await tracker.updateComment!(ref, linearCommentIdFor(A, "root"), "root v2", { orgId: A });
    expect(w.linear.writes.map((write) => [write.company, write.kind])).toEqual([[A, "create"], [A, "create"], [A, "edit"]]);
    const sent = w.linear.writes.length;
    await expect(tracker.updateComment!(ref, linearCommentIdFor(A, "root"), "x", { orgId: B })).rejects.toThrow("another company");
    await expect(tracker.comment!(ref, "x", { orgId: B }, { key: "reply-2", parentId: linearCommentIdFor(A, "root") })).rejects.toThrow("another company");
    expect(w.linear.writes).toHaveLength(sent);
  });
});
