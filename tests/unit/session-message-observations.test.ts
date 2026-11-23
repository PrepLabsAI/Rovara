import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, LIVE_STEER_REAPPROVAL_REASON, LIVE_STEER_REVISED_REASON, WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE, change } from "@agentx/contracts";
import { createSessionControl, createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/index.js";
import { markSteerRevised, messageKey, messageOf, readSteerMessage } from "../../packages/broker/src/core/sessions/steer.js";
import { settleLiveSteerReapproval } from "../../packages/broker/src/core/sessions/live-steer-reapproval.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createNoopAuditSink, localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { legacyMessageSchema } from "../support/session-message-legacy.js";

const orgId = IMPLICIT_COMPANY_ID;
const taskId = "11111111-1111-4111-8111-111111111111";
const sessionId = taskSessionId(taskId);
const owner = localOwnerPrincipal();
const at = "2026-11-21T12:00:00.000Z";
const requestId = "22222222-2222-4222-8222-222222222222";

async function world() {
  const store = new MemoryDocumentStore();
  await store.transact(createTaskSessionItems({ orgId, sessionId, taskId, project: "demo", agent: { agentId: "rovara-code", name: "Rovara Code", version: 1 }, title: "Retry", owner, origin: "app", payer: { kind: "member", developerId: developerIdOf(owner) }, now: at }));
  let sends = 0;
  const control = createSessionControl({ store, audit: createNoopAuditSink(), now: () => new Date(at), host: {
    cancelTask: async () => undefined, retryWorkflow: async () => undefined,
    planMessage: async () => { sends += 1; return { state: "queued" }; },
  } });
  const sent = await control.tell(owner, orgId, sessionId, { requestId, text: "Use the existing table" });
  if (sent.status !== "done") throw new Error("fixture message refused");
  const messageId = sent.message.messageId;
  const key = messageKey({ orgId, sessionId }, messageId);
  const raw = () => store.get(key);
  const delivered = () => store.update({ key, ops: [change.set("delivery", { state: "delivered", at })] });
  return { store, control, messageId, key, raw, delivered, sends: () => sends };
}

describe("persisted delivery observations, reader-first", () => {
  it("persists Checking only during the same-message read, with zero extra sends and an unchanged receipt", async () => {
    const w = await world();
    let reads = 0;
    const store = {
      update: w.store.update.bind(w.store),
      async get(key: typeof w.key) {
        expect(key).toEqual(w.key);
        reads += 1;
        const row = await w.store.get(key);
        if (reads === 2) {
          expect(row?.["deliveryObservation"]).toEqual({ state: "checking" });
          const repeated = await w.control.tell(owner, orgId, sessionId, { requestId, text: "Use the existing table" });
          expect(repeated.status).toBe("done");
          if (repeated.status === "done") expect(legacyMessageSchema.safeParse(repeated.message).success).toBe(true);
        }
        return row;
      },
    };
    const read = await readSteerMessage(store, orgId, sessionId, w.messageId);
    expect(reads).toBe(2);
    expect(read?.delivery).toEqual({ state: "queued", at });
    expect(read).not.toHaveProperty("deliveryObservation");
    expect((await w.raw())?.["deliveryObservation"]).toBeUndefined();
    expect(w.sends()).toBe(1);
    expect(legacyMessageSchema.safeParse(read).success).toBe(true);
  });

  it("clears Checking after a failed read without changing the receipt or sending", async () => {
    const w = await world();
    let reads = 0;
    const store = { update: w.store.update.bind(w.store), get: async (key: typeof w.key) => {
      reads += 1;
      if (reads === 2) throw new Error("read unavailable");
      return w.store.get(key);
    } };
    await expect(readSteerMessage(store, orgId, sessionId, w.messageId)).rejects.toThrow("read unavailable");
    expect((await w.raw())?.["deliveryObservation"]).toBeUndefined();
    expect((await w.raw())?.["delivery"]).toEqual({ state: "queued", at });
    expect(w.sends()).toBe(1);
  });

  it("records Outside plan only for the real re-approval evidence and retains it through revision", async () => {
    const w = await world();
    const task = { orgId, sessionId };
    const deps = { store: w.store, now: () => new Date(at) };
    expect(await settleLiveSteerReapproval(deps, task, `ordinary failure ${w.messageId}`)).toBe(0);
    expect(await settleLiveSteerReapproval(deps, task, `${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE}: ${w.messageId}`)).toBe(0);
    expect((await w.raw())?.["deliveryObservation"]).toBeUndefined();
    await w.delivered();
    expect(await settleLiveSteerReapproval(deps, task, `ordinary failure ${w.messageId}`)).toBe(0);
    expect((await w.raw())?.["deliveryObservation"]).toBeUndefined();
    expect(await markSteerRevised(deps, orgId, sessionId, w.messageId)).toBe(false);
    expect((await w.raw())?.["deliveryObservation"]).toBeUndefined();
    expect(await settleLiveSteerReapproval(deps, task, `${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE}: ${w.messageId}`)).toBe(1);
    expect((await w.raw())?.["deliveryObservation"]).toEqual({ state: "outside_plan" });
    expect((await w.raw())?.["delivery"]).toEqual({ state: "delivered", at, reason: LIVE_STEER_REAPPROVAL_REASON });
    const read = await readSteerMessage(w.store, orgId, sessionId, w.messageId);
    expect(legacyMessageSchema.safeParse(read).success).toBe(true);
    expect((await w.raw())?.["deliveryObservation"]).toEqual({ state: "outside_plan" });
    expect(await markSteerRevised(deps, orgId, sessionId, w.messageId)).toBe(true);
    expect((await w.raw())?.["deliveryObservation"]).toEqual({ state: "outside_plan" });
    expect((await w.raw())?.["delivery"]).toEqual({ state: "delivered", at, reason: LIVE_STEER_REVISED_REASON });
    expect(await settleLiveSteerReapproval(deps, task, `${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE}: ${w.messageId}`)).toBe(0);
    expect(w.sends()).toBe(1);
  });

  it("does not erase a concurrent Outside plan observation when the Checking read finishes", async () => {
    const w = await world();
    await w.delivered();
    let reads = 0;
    const store = { update: w.store.update.bind(w.store), get: async (key: typeof w.key) => {
      reads += 1;
      if (reads === 2) await settleLiveSteerReapproval({ store: w.store }, { orgId, sessionId }, `${WORKFLOW_LIVE_STEER_REAPPROVAL_MESSAGE}: ${w.messageId}`);
      return w.store.get(key);
    } };
    await readSteerMessage(store, orgId, sessionId, w.messageId);
    expect(reads).toBe(2);
    expect((await w.raw())?.["deliveryObservation"]).toEqual({ state: "outside_plan" });
    expect(w.sends()).toBe(1);
  });

  it("never marks missing, deleted, comment or cross-session/company rows, or a receipt alone as Outside plan", async () => {
    const w = await world();
    expect(await readSteerMessage(w.store, orgId, "ses_bbbbbbbbbbbbbbbbbbbb", w.messageId)).toBeUndefined();
    expect(messageOf({ ...(await w.raw()), orgId: "other" }, { orgId, sessionId })).toBeUndefined();
    for (const ops of [[change.set("kind", "comment")], [change.set("kind", "steer"), change.set("deletedAt", at)]]) {
      await w.store.update({ key: w.key, ops });
      expect(await readSteerMessage(w.store, orgId, sessionId, w.messageId)).toBeUndefined();
      expect((await w.raw())?.["deliveryObservation"]).toBeUndefined();
    }
    expect(w.sends()).toBe(1);
  });
});
