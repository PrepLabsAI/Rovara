// telling a session, with a host that keeps notes. The message, its note, the count and the rate token are one transaction; a lost race is planned again; a live message is
// answered `delivered` with the note marked; a queued one is settled when a step takes its note, and closed when the session ends.
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- vitest's expect.* matchers are typed any */
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, agentSessionKey, sessionQueuedSteersKey, when, type OrgId, type TransactItem } from "@rovara-code/contracts";
import {
  SessionStore, createSessionControl, createTaskSessionItems, developerIdOf, readSessionEvents, taskSessionId, type MessagePlan, type SessionControlHost,
} from "../../packages/core/src/core/sessions/index.js";
import { noteKey, sessionNoteItems } from "../../packages/core/src/core/sessions/notes.js";
import { closeQueuedSteers, messageKey, settleSteerDeliveries, settleSteerDeliveriesFor, SESSION_ENDED_REASON } from "../../packages/core/src/core/sessions/steer.js";
import { MemoryDocumentStore } from "../../packages/core/src/ports/memory-document-store.js";
import { createNoopAuditSink, localOwnerPrincipal } from "../../packages/core/src/ports/policy-defaults.js";

const ORG = IMPLICIT_COMPANY_ID as OrgId;
const OWNER = localOwnerPrincipal();
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const SESSION = taskSessionId(TASK);
const T0 = "2026-11-10T10:00:00.000Z";
const clock = { now: new Date("2026-11-10T10:05:00.000Z") };
const REQ = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function world(host: (store: MemoryDocumentStore) => Partial<SessionControlHost>, authorize?: Parameters<typeof createSessionControl>[0]["authorize"]) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK, companyId: ORG, sessionId: SESSION, conversationId: "c", workflow: { revision: 2 } } });
  await store.transact(createTaskSessionItems({
    orgId: ORG, sessionId: SESSION, taskId: TASK, project: "web", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Add retry", owner: OWNER, origin: "app", payer: { kind: "member", developerId: developerIdOf(OWNER) } as never, now: T0,
  }));
  const control = createSessionControl({ store, audit: createNoopAuditSink(), host: { cancelTask: async () => undefined, retryWorkflow: async () => undefined, ...host(store) }, now: () => clock.now, log: () => undefined, ...(authorize === undefined ? {} : { authorize }) });
  const session = async () => (await new SessionStore(store).get(ORG, SESSION))!;
  const count = async () => (await store.get(sessionQueuedSteersKey(ORG, SESSION)))?.["count"] ?? 0;
  const message = async (id: string) => await store.get(messageKey({ orgId: ORG, sessionId: SESSION }, id));
  return { store, control, session, count, message };
}

/** A host that keeps notes the way the local one does: the note and the task's count go in the message's own transaction. */
const noting = (store: MemoryDocumentStore, options: { live?: boolean; flaky?: { fails: number; plans: number[] } } = {}): Partial<SessionControlHost> => ({
  async planMessage(taskId, message): Promise<MessagePlan> {
    const task = (await store.get({ pk: `DEVTASK#${taskId}`, sk: "META" }))!;
    const built = sessionNoteItems(task as never, { taskId, source: "app", developerId: message.author.developerId, name: message.author.name, isOwner: message.owner, sessionId: message.sessionId, messageId: message.messageId, text: message.text }, clock.now.getTime());
    if (built.outcome === "refused") return { state: "not_delivered", reason: built.reason };
    options.flaky?.plans.push(1);
    // A rate token that another message takes first: the first `fails` transactions are refused on it.
    const race: TransactItem[] = options.flaky !== undefined && options.flaky.plans.length <= options.flaky.fails ? [{ kind: "check", key: { pk: "RACE", sk: "X" }, condition: when.present() }] : [];
    return {
      state: "queued", items: [...built.items, ...race],
      ...(options.live === true ? { goLive: async () => ({ taken: true, items: [{ kind: "update" as const, key: noteKey(taskId, message.messageId), ops: [{ op: "set" as const, path: ["liveDeliveredAt"], value: T0 }] }] }) } : {}),
    };
  },
});

describe("telling a session with notes", () => {
  it("writes the message, its note, the count and the queue's count in one transaction; the event holds no text", async () => {
    const w = await world((store) => noting(store));
    const told = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(1), text: "use the other table" });
    expect(told).toMatchObject({ status: "done", repeated: false, message: { delivery: { state: "queued" } } });
    const id = (told as { message: { messageId: string } }).message.messageId;
    expect(await w.store.get(noteKey(TASK, id))).toMatchObject({ text: "use the other table", source: "app" });
    expect((await w.store.get({ pk: `DEVTASK#${TASK}`, sk: "META" }))?.["threadNoteCount"]).toBe(1);
    expect(await w.count()).toBe(1);
    expect(JSON.stringify((await readSessionEvents(w.store, ORG, SESSION)).events)).not.toContain("other table");
    // The same request again answers the stored message and writes nothing.
    expect(await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(1), text: "use the other table" })).toMatchObject({ repeated: true });
    expect(await w.count()).toBe(1);
    expect((await w.store.get({ pk: `DEVTASK#${TASK}`, sk: "META" }))?.["threadNoteCount"]).toBe(1);
  });

  it("plans the message again when its transaction lost a race, and saves it once", async () => {
    const plans: number[] = [];
    const w = await world((store) => noting(store, { flaky: { fails: 2, plans } }));
    const told = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(2), text: "again" });
    expect(told).toMatchObject({ status: "done", message: { delivery: { state: "queued" } } });
    expect(plans).toHaveLength(3);
    expect((await w.store.get({ pk: `DEVTASK#${TASK}`, sk: "META" }))?.["threadNoteCount"]).toBe(1);
    expect(await w.count()).toBe(1);
  });

  it("gives up with a plain sentence when the race never ends, and writes nothing", async () => {
    const plans: number[] = [];
    const w = await world((store) => noting(store, { flaky: { fails: 99, plans } }));
    expect(await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(3), text: "never" })).toMatchObject({ status: "refused", reason: "unavailable" });
    expect(await w.count()).toBe(0);
    expect((await w.store.get({ pk: `DEVTASK#${TASK}`, sk: "META" }))?.["threadNoteCount"]).toBeUndefined();
  });

  it("answers a message the running step took live as delivered: the queue's count back to zero, the note marked, one event", async () => {
    const w = await world((store) => noting(store, { live: true }));
    const told = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(4), text: "go live" });
    expect(told).toMatchObject({ status: "done", message: { delivery: { state: "delivered" } } });
    const id = (told as { message: { messageId: string } }).message.messageId;
    expect(await w.count()).toBe(0);
    expect(await w.store.get(noteKey(TASK, id))).toMatchObject({ liveDeliveredAt: T0 });
    expect(await w.message(id)).toMatchObject({ delivery: { state: "delivered" } });
    const types = (await readSessionEvents(w.store, ORG, SESSION)).events.map((event) => event.type);
    expect(types.filter((type) => type === "steer_delivered")).toHaveLength(1);
  });

  it("settles a queued message once a step has taken its note, and never twice", async () => {
    const w = await world((store) => noting(store));
    const told = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(5), text: "for the next step" });
    const id = (told as { message: { messageId: string } }).message.messageId;
    const deps = { store: w.store, now: () => clock.now };
    // No step has taken it: nothing is settled.
    expect(await settleSteerDeliveries(deps, await w.session())).toBe(0);
    const note = (await w.store.get(noteKey(TASK, id)))!;
    await w.store.update({ key: { pk: `DEVTASK#${TASK}`, sk: "META" }, ops: [{ op: "set", path: ["threadNotesFedThrough"], value: note["receivedAt"] as string }] });
    expect(await settleSteerDeliveries(deps, await w.session())).toBe(1);
    expect(await w.message(id)).toMatchObject({ delivery: { state: "delivered" } });
    expect(await w.count()).toBe(0);
    expect(await w.store.get(noteKey(TASK, id))).toMatchObject({ settledAt: expect.any(String) });
    expect(await settleSteerDeliveries(deps, await w.session())).toBe(0);
    expect(await w.count()).toBe(0);
  });

  it("closes the messages no step took when the session ends: not delivered, with a fixed reason, once", async () => {
    const w = await world((store) => noting(store));
    const told = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(6), text: "too late" });
    const id = (told as { message: { messageId: string } }).message.messageId;
    const deps = { store: w.store, now: () => clock.now };
    // The session is open: nothing is closed.
    expect(await closeQueuedSteers(deps, await w.session())).toBe(0);
    await w.store.update({ key: agentSessionKey(ORG, SESSION, "META"), ops: [{ op: "set", path: ["endedAt"], value: "2026-11-10T11:00:00.000Z" }] });
    expect(await closeQueuedSteers(deps, await w.session())).toBe(1);
    expect(await w.message(id)).toMatchObject({ delivery: { state: "not_delivered", reason: SESSION_ENDED_REASON } });
    expect(await w.count()).toBe(0);
    expect(await closeQueuedSteers(deps, await w.session())).toBe(0);
    // And the by-id form never throws, even for a session that is gone.
    await expect(settleSteerDeliveriesFor(deps, ORG, "ses_00000000000000000000")).resolves.toBeUndefined();
  });

  it("a message the host refuses is saved with its reason, counts nothing and writes no note", async () => {
    const w = await world(() => ({ planMessage: async () => ({ state: "not_delivered", reason: "this task already holds all the messages it keeps" }) }));
    const told = await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(7), text: "full" });
    expect(told).toMatchObject({ message: { delivery: { state: "not_delivered", reason: "this task already holds all the messages it keeps" } } });
    expect(await w.count()).toBe(0);
    expect((await w.store.query({ pk: `DEVTASK#${TASK}`, sk: { op: "beginsWith", prefix: "NOTE#" } })).items).toHaveLength(0);
  });
});

describe("who the sender is", () => {
  it("is the session's owner only when the sender is: another person an adapter lets message is information, never the owner's instruction", async () => {
    const seen: Array<{ owner: boolean; developerId: string }> = [];
    const w = await world((store) => ({
      ...noting(store),
      async planMessage(taskId, message) { seen.push({ owner: message.owner, developerId: message.author.developerId }); return noting(store).planMessage!(taskId, message); },
    }), () => true);
    const member = { companyId: ORG, personId: "a-member", displayName: "Member", roles: [], provider: "local-owner" } as never;
    await w.control.tell(OWNER, ORG, SESSION, { requestId: REQ(8), text: "from the owner" });
    await w.control.tell(member, ORG, SESSION, { requestId: REQ(9), text: "from a member" });
    expect(seen.map((entry) => entry.owner)).toEqual([true, false]);
    const notes = (await w.store.query({ pk: `DEVTASK#${TASK}`, sk: { op: "beginsWith", prefix: "NOTE#" } })).items;
    expect(notes.map((note) => note["isOwner"]).sort()).toEqual([false, true]);
  });
});
