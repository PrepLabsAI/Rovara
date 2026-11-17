// Web task channel: the task's People are told like the people already told. A co-owner is told like the task's owner (every kind the owner is told); a commenter like a follower (a failure and the end).
// The host says who is on the task (`peopleOf`); on AWS that is `taskPeopleRecipients`, which reads the task's PEOPLE list and maps each entry to the id the queue and the inbox use. A host without People
// tells the same people as before.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, agentSessionKey, type AgentSessionRecord, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTaskSessionItems, developerIdOf, refreshSessionSummary, taskSessionId, type SessionTaskFacts, type SummaryDependencies } from "../../packages/broker/src/core/sessions/index.js";
import { PENDING_PK, attentionRecipients, inboxPartition, queueAttention, type PeopleRecipients } from "../../packages/broker/src/core/notify/index.js";
import { createNoticeService } from "../../packages/broker/src/services/notices.js";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { HOSTED_IDENTITY_PROVIDER } from "../../packages/broker/src/core-host/hosted-modules.js";
import { PEOPLE_RECIPIENTS_MAX, taskPeopleRecipients } from "../../packages/broker/src/aws/task-people-recipients.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OTHER_ORG = "org_peopleother000000001" as OrgId;
const OWNER = localOwnerPrincipal();
const OWNER_ID = developerIdOf(OWNER);
const T0 = "2026-11-09T10:00:00.000Z";
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const AGENT = { agentId: "rovara-code", name: "Rovara Code", version: 1 };
const TASK = "00000000-0000-4000-8000-000000000001";
const SESSION = taskSessionId(TASK);
const hex = (name: string) => createHash("sha256").update(name).digest("hex");
const idOf = (signIn: string) => developerIdOf({ provider: HOSTED_IDENTITY_PROVIDER, personId: signIn });
const [BOB, CAT, DEV, EVE] = ["bob", "cat", "dev", "eve"].map(hex) as [string, string, string, string];

interface World { store: MemoryDocumentStore; move: (stage: string, state: string, extra?: Partial<SessionTaskFacts>) => Promise<void>; pending: () => Promise<string[]>; inbox: (developerId: string) => Promise<number>; logs: Array<Record<string, unknown>> }

async function world(makePeopleOf?: (store: MemoryDocumentStore) => (session: AgentSessionRecord) => Promise<PeopleRecipients>): Promise<World> {
  const store = new MemoryDocumentStore();
  const peopleOf = makePeopleOf?.(store);
  const logs: Array<Record<string, unknown>> = [];
  await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: AGENT, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
  const facts: { value: SessionTaskFacts } = { value: { companyId: ORG, taskId: TASK, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } };
  let ms = NOW - 3_600_000;
  const deps: SummaryDependencies = { store, facts: { read: async () => facts.value }, cost: { costUsd: async () => 0 }, now: () => new Date(ms), log: () => undefined,
    onChange: [async (change) => { await queueAttention({ store, now: () => new Date(NOW), log: (entry) => logs.push(entry), ...(peopleOf === undefined ? {} : { peopleOf }) }, change); }] };
  const move = async (stage: string, state: string, extra: Partial<SessionTaskFacts> = {}) => { facts.value = { ...facts.value, workflow: { stage, state }, ...extra }; ms += 1_000; await refreshSessionSummary(deps, ORG, SESSION); };
  await move("IMPLEMENT", "RUNNING");
  return {
    store, move, logs,
    pending: async () => [...new Set((await store.query({ pk: PENDING_PK })).items.map((row) => (row["developerId"] as string)))].sort(),
    inbox: async (developerId) => (await store.query({ pk: inboxPartition(ORG, developerId) })).items.length,
  };
}

const sorted = (ids: string[]) => [...ids].sort();
const PEOPLE: PeopleRecipients = { owners: [idOf(BOB)], commenters: [idOf(CAT)] };

describe("who a change tells, with the task's People", () => {
  it("tells a co-owner like the owner (Needs you), and a commenter not at all for a wait", async () => {
    const w = await world(() => async () => PEOPLE);
    await w.move("PLAN_REVIEW", "WAITING");
    expect(await w.pending()).toEqual(sorted([OWNER_ID, idOf(BOB)]));
    expect(await w.inbox(idOf(BOB))).toBe(1);
    expect(await w.inbox(idOf(CAT))).toBe(0);
  });

  it("tells co-owners and commenters about a failure, like the owner and the followers", async () => {
    const w = await world(() => async () => PEOPLE);
    await w.move("IMPLEMENT", "RUNNING", { workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" });
    expect(await w.pending()).toEqual(sorted([OWNER_ID, idOf(BOB), idOf(CAT)]));
    expect(await w.inbox(idOf(CAT))).toBe(1);
  });

  it("tells nobody extra when the host has no People: the owner alone, as before", async () => {
    const w = await world();
    await w.move("PLAN_REVIEW", "WAITING");
    expect(await w.pending()).toEqual([OWNER_ID]);
  });

  it("tells the owner as before when the People cannot be read, and says so in fixed words", async () => {
    const w = await world(() => async () => { throw new Error("people down zzq"); });
    await w.move("PLAN_REVIEW", "WAITING");
    expect(await w.pending()).toEqual([OWNER_ID]);
    expect(w.logs).toEqual([{ event: "attention.people_failed", sessionId: SESSION }]);
    expect(JSON.stringify(w.logs)).not.toContain("zzq");
  });
});

describe("attentionRecipients with People", () => {
  const store = new MemoryDocumentStore();
  const summaryOf = async (stage: string, state: string, extra: Partial<SessionTaskFacts> = {}) => {
    const w = await world();
    await w.move(stage, state, extra);
    const record = (await w.store.get(agentSessionKey(ORG, SESSION, "META")))! as unknown as AgentSessionRecord;
    return { session: record, summary: record.summary };
  };
  const ask = async (kind: Parameters<typeof attentionRecipients>[3], people: PeopleRecipients | undefined, extra: Partial<SessionTaskFacts>) => {
    const { session, summary } = await summaryOf("IMPLEMENT", "RUNNING", extra);
    return attentionRecipients(store, session, summary, kind, people);
  };
  const WAIT = { workflow: { stage: "PLAN_REVIEW", state: "WAITING" } };
  const FAILED = { workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" } as Partial<SessionTaskFacts>;
  const MERGED = { workflow: { stage: "MERGED", state: "COMPLETE" }, step: "Merged" };
  const CLOSED = { workflow: undefined, display: { state: "closed" } } as Partial<SessionTaskFacts>;

  it("co-owners follow the owner's rule: told for a wait, a pause, ready and a failure; commenters follow the followers' (a failure and the end)", async () => {
    expect(await ask("needs_you", PEOPLE, WAIT)).toEqual([OWNER_ID, idOf(BOB)]);
    expect(await ask("paused", PEOPLE, WAIT)).toEqual([OWNER_ID, idOf(BOB)]);
    expect(await ask("ready", PEOPLE, WAIT)).toEqual([OWNER_ID, idOf(BOB)]);
    expect(await ask("failed", PEOPLE, FAILED)).toEqual([OWNER_ID, idOf(BOB), idOf(CAT)]);
  });

  it("a closed task tells only the followers and commenters (the owner and co-owners are not told a close); a merged one tells owner and co-owners too", async () => {
    expect(await ask("done", PEOPLE, CLOSED)).toEqual([idOf(CAT)]);
    expect(await ask("done", PEOPLE, MERGED)).toEqual([OWNER_ID, idOf(BOB), idOf(CAT)]);
  });

  it("leaves out anything that is not an attention id, repeats, and never tells one person twice", async () => {
    const people = { owners: [idOf(BOB), idOf(BOB), "not-an-id", 7 as never, OWNER_ID], commenters: [idOf(BOB), "../x"] };
    expect(await ask("failed", people, FAILED)).toEqual([OWNER_ID, idOf(BOB)]);
    expect(await ask("needs_you", { owners: "x" as never, commenters: undefined as never }, WAIT)).toEqual([OWNER_ID]);
  });

  it("keeps the owner first and the whole list within 50", async () => {
    const many = { owners: Array.from({ length: 80 }, (_, n) => idOf(hex(`co-${String(n)}`))), commenters: [] };
    const told = await ask("needs_you", many, WAIT);
    expect(told).toHaveLength(50);
    expect(told[0]).toBe(OWNER_ID);
  });
});

describe("taskPeopleRecipients (the hosted core's reader of the task's People)", () => {
  const session = (orgId: OrgId = ORG, subject: AgentSessionRecord["subject"] = { kind: "task", taskId: TASK }) => ({ orgId, subject }) as unknown as AgentSessionRecord;
  async function peopleStore(people: unknown, options: { companyId?: string | null } = {}) {
    const store = new MemoryDocumentStore();
    if (options.companyId !== null) await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: options.companyId ?? ORG } });
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false, people: people as never } });
    return store;
  }
  const entry = (developerId: string, role: string) => ({ developerId, name: "x", role, method: "cloud" });

  it("maps owners and commenters to the ids the queue uses (the hosted identity), leaving out viewers and denied people", async () => {
    const store = await peopleStore([entry(DEV, "owner"), entry(BOB, "owner"), entry(CAT, "commenter"), entry(EVE, "viewer"), entry(hex("zed"), "denied")]);
    await expect(taskPeopleRecipients(store)(session())).resolves.toEqual({ owners: [idOf(DEV), idOf(BOB)], commenters: [idOf(CAT)] });
    expect(idOf(BOB)).not.toBe(BOB);
  });

  it("reads only this company's task: another company's session, or a task with no company record, tells nobody extra", async () => {
    const store = await peopleStore([entry(BOB, "owner")]);
    await expect(taskPeopleRecipients(store)(session(OTHER_ORG))).resolves.toEqual({ owners: [], commenters: [] });
    const noMeta = await peopleStore([entry(BOB, "owner")], { companyId: null });
    await expect(taskPeopleRecipients(noMeta)(session())).resolves.toEqual({ owners: [], commenters: [] });
    const foreign = await peopleStore([entry(BOB, "owner")], { companyId: OTHER_ORG });
    await expect(taskPeopleRecipients(foreign)(session())).resolves.toEqual({ owners: [], commenters: [] });
  });

  it("tells nobody extra for a list it cannot read whole: a malformed entry, a non-array, too many entries, no list, or a session that is not a task", async () => {
    const none = { owners: [], commenters: [] };
    for (const bad of [[entry(BOB, "owner"), null], [entry(BOB, "owner"), { developerId: "short", role: "owner" }], [entry(BOB, "owner"), { developerId: CAT }], "x", { people: 1 }]) {
      await expect(taskPeopleRecipients(await peopleStore(bad))(session())).resolves.toEqual(none);
    }
    const tooMany = Array.from({ length: PEOPLE_RECIPIENTS_MAX + 1 }, (_, n) => entry(hex(`p${String(n)}`), "owner"));
    await expect(taskPeopleRecipients(await peopleStore(tooMany))(session())).resolves.toEqual(none);
    const noList = new MemoryDocumentStore();
    await noList.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", companyId: ORG } });
    await expect(taskPeopleRecipients(noList)(session())).resolves.toEqual(none);
    await expect(taskPeopleRecipients(await peopleStore([entry(BOB, "owner")]))(session(ORG, { kind: "chain", chainRunId: "x" } as never))).resolves.toEqual(none);
  });

  it("end to end through the queue: the People list in the queue's own store tells its co-owner and, on a failure, its commenter", async () => {
    const w = await world((store) => taskPeopleRecipients(store));
    await w.store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: ORG } });
    await w.store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "PEOPLE", schemaVersion: 1, revision: 2, orphaned: false, people: [entry(BOB, "owner"), entry(CAT, "commenter"), entry(EVE, "viewer")] } });
    await w.move("PLAN_REVIEW", "WAITING");
    expect(await w.pending()).toEqual(sorted([OWNER_ID, idOf(BOB)]));
    await w.move("IMPLEMENT", "RUNNING", { workflow: undefined, runStatus: "FAILED", failureCategory: "timed_out" });
    expect(await w.pending()).toEqual(sorted([OWNER_ID, idOf(BOB), idOf(CAT)]));
    expect(await w.inbox(idOf(EVE))).toBe(0);
  });
});

describe("the notice service passes the People reader to the queue", () => {
  const through = async (peopleOf?: () => Promise<PeopleRecipients>) => {
    const store = new MemoryDocumentStore();
    await store.transact(createTaskSessionItems({ orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: AGENT, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: OWNER_ID } as never, now: T0 }));
    const notices = createNoticeService({ store, registry: createAdapterRegistry(), now: () => new Date(NOW), log: () => undefined, inbox: true, ...(peopleOf === undefined ? {} : { peopleOf }) });
    const facts: { value: SessionTaskFacts } = { value: { companyId: ORG, taskId: TASK, project: "web", ownerDeveloperId: OWNER_ID, runStatus: "RUNNING", workflow: { stage: "IMPLEMENT", state: "RUNNING" }, step: "Coding", updatedAt: T0 } };
    let ms = NOW - 3_600_000;
    const deps: SummaryDependencies = { store, facts: { read: async () => facts.value }, cost: { costUsd: async () => 0 }, now: () => new Date(ms), log: () => undefined, onChange: [async (change) => { await notices.queue(change); }] };
    for (const [stage, state] of [["IMPLEMENT", "RUNNING"], ["PLAN_REVIEW", "WAITING"]] as const) { facts.value = { ...facts.value, workflow: { stage, state } }; ms += 1_000; await refreshSessionSummary(deps, ORG, SESSION); }
    return (inbox: string) => store.query({ pk: inboxPartition(ORG, inbox) }).then((page) => page.items.length);
  };

  it("keeps a co-owner's inbox row on the hosted core (nothing can message anyone), and none when no reader is given", async () => {
    const inbox = await through(async () => PEOPLE);
    expect(await inbox(idOf(BOB))).toBe(1);
    expect(await inbox(OWNER_ID)).toBe(1);
    const plain = await through();
    expect(await plain(idOf(BOB))).toBe(0);
    expect(await plain(OWNER_ID)).toBe(1);
  });
});
