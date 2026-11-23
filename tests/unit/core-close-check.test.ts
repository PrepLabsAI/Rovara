// CLOSE-RETENTION: the close guard's check request and the wake. Every provider, machine and session item here is a fake port, NOT machine proof: whether a real stopped machine starts, keeps its volume and is
// inspected is proven by the retention lane's Linux grid and by the real calls after install. What these tests pin is the DECISION: one durable check per fence, a stopped or stopping machine is checked
// (never closed on a guess), a check that cannot run says so, a check that never finishes gives the workspace back, and nothing here deletes anything.
import { describe, expect, it, vi } from "vitest";
import { change, workspaceSessionKey } from "@agentx/contracts";
import { randomUUID } from "node:crypto";
import type { Queue, ReceivedMessage } from "@agentx/contracts";
import { createBrokerCloseInspection } from "../../packages/broker/src/aws/worker-machines/close-retention.js";
import { closeCheckPort, requestCloseCheck } from "../../packages/broker/src/core/task-flow/close-check.js";
import { closeOperationId } from "../../packages/broker/src/core/task-flow/close-acceptance-record.js";
import type { CloseInspectionProvider } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { planClosePreparation, runClosePreparation } from "../../packages/broker/src/core/task-flow/close-preparation.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { CLOSE_CANNOT_CHECK_WORDS, CLOSE_CHECKING_WORDS, CLOSE_TRY_AGAIN_WORDS, retainedCloseWords } from "../../packages/broker/src/core/task-flow/close-words.js";
import { guardWorld, refusal, type GuardWorld } from "../support/close-guard-world.js";

type Availability = "ready" | "wake" | "unsupported";
const provider = (availability: Availability | undefined, extra: Partial<CloseInspectionProvider> = {}): CloseInspectionProvider => ({
  ...(availability === undefined ? {} : { availability: async () => availability }),
  ready: async () => availability === "ready", raiseFence: async () => {}, retained: async () => true,
  inspectWorkspaceForClose: async () => ({ inspection: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }], contentDigest: "a".repeat(64) }, retentionId: "kept-1" }),
  ...extra,
});
const closedAt = async (w: GuardWorld) => (await readTask(w.h.deps, w.task.taskId))?.closedAt;
const preflightId = async (w: GuardWorld) => closeOperationId(w.h.deps.companyId, w.task.workspaceId, `preflight:${(await w.workspace())!.fence + 1}`);

async function world(session: { state: string; generation?: number; extra?: Record<string, unknown> }, availability: Availability | undefined, extra: Partial<CloseInspectionProvider> = {}) {
  const w = await guardWorld({ machine: "backed", session, check: closeCheckPort });
  w.h.deps.closeInspection = provider(availability, extra);
  return w;
}

describe("a close of a machine-backed task with no preview asks for ONE check, and deletes nothing", () => {
  for (const [name, session, availability] of [
    ["a READY machine whose worker retains", { state: "READY", generation: 1, extra: { workerFeatures: ["close.retention.v1"] } }, "ready"],
    ["a STOPPED machine (its instance is gone, its volume kept)", { state: "STOPPED", generation: 2 }, "wake"],
    ["a machine that is STOPPING (Close during the stop's window)", { state: "STOPPING", generation: 2 }, "wake"],
  ] as const) {
    it(`${name}: refused with the 'checking' words, one preparation holds the workspace, nothing is terminated, stopped or deleted`, async () => {
      const w = await world(session, availability);
      const id = await preflightId(w);
      expect(await refusal(w.close())).toBe(CLOSE_CHECKING_WORDS);
      const held = (await w.workspace())!;
      const operation = await readOperation(w.h.deps, w.task.workspaceId, held.activeOperationId!);
      expect(operation).toMatchObject({ kind: "close", closePreflight: { schemaVersion: 1 }, status: "ACCEPTED" });
      expect(held.activeOperationId).toBe(id);
      expect(await closedAt(w)).toBeUndefined();
      for (const effect of [w.terminate, w.stop, w.start]) expect(effect).not.toHaveBeenCalled();
      // The session item is untouched: a STOPPED volume stays STOPPED until the preparation's own wake.
      expect((await w.h.store.get({ pk: `WORKSPACE#${w.task.workspaceId}`, sk: "SESSION" }))?.["state"]).toBe(session.state);
    });
  }

  it("pressing Close again finds the preparation: the same words, and not one write", async () => {
    const w = await world({ state: "STOPPED", generation: 2 }, "wake");
    await refusal(w.close());
    const spies = w.writes();
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CHECKING_WORDS);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await w.rows()).toEqual(before);
  });

  it("a request that finds its own fence's preparation already there answers `already`, and writes nothing", async () => {
    const w = await world({ state: "STOPPED", generation: 2 }, "wake");
    const workspace = (await w.workspace())!;
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    expect(await requestCloseCheck(w.h.deps, task, workspace)).toBe("queued");
    // A stale reader (it read the workspace before the first request landed) asks again: the preparation is found by its deterministic id.
    expect(await requestCloseCheck(w.h.deps, task, workspace)).toBe("already");
  });

  it("an old worker (a live READY session that never listed the retention feature) cannot be checked: the 'can't check' words, nothing written", async () => {
    const w = await world({ state: "READY", generation: 1 }, "unsupported");
    const spies = w.writes(), before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await w.rows()).toEqual(before);
  });

  it("a provider that cannot say what a check needs is `unsupported` (never a guess)", async () => {
    const w = await world({ state: "STOPPED", generation: 2 }, undefined);
    const before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    expect(await w.rows()).toEqual(before);
  });

  it("a retained session that was stopped is never promised a Close check (a Continue resumes it; the check is not layered on a retention): never woken by the Close, never deleted", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "STOPPED", generation: 2 }, check: closeCheckPort });
    // The record's completed preflight holds the workspace (nothing has moved since the check): it is a live retention.
    const holder = randomUUID(), fence = (await w.workspace())!.fence;
    await w.h.store.put({ item: { pk: w.wk.pk, sk: `OPERATION#${holder}`, entityType: "OPERATION", companyId: w.h.deps.companyId, id: holder, workspaceId: w.task.workspaceId, kind: "close", status: "SUCCEEDED", fence, closePreflight: { schemaVersion: 1 } } });
    await w.h.store.update({ key: w.wk, ops: [change.set("activeOperationId", holder)] });
    await w.h.store.update({ key: workspaceSessionKey(w.task.workspaceId), ops: [change.set("closeRetention", { schemaVersion: 1, operationId: holder, fence })] });
    w.h.deps.closeInspection = createBrokerCloseInspection(async () => false, w.h.deps.companyId, w.h.store);
    const spies = w.writes(), before = await w.rows();
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await w.rows()).toEqual(before);
    for (const effect of [w.terminate, w.stop, w.start]) expect(effect).not.toHaveBeenCalled();
  });

  it("a retention a step has superseded (its preflight no longer holds the workspace; the lift never landed) does not make Close say 'can't check' for ever: the check is requested and replaces it", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "STOPPED", generation: 2 }, check: closeCheckPort });
    await w.h.store.update({ key: workspaceSessionKey(w.task.workspaceId), ops: [change.set("closeRetention", { schemaVersion: 1, operationId: randomUUID(), fence: (await w.workspace())!.fence })] });
    w.h.deps.closeInspection = createBrokerCloseInspection(async () => false, w.h.deps.companyId, w.h.store);
    expect(await refusal(w.close())).toBe(CLOSE_CHECKING_WORDS);
    expect((await w.workspace())!.activeOperationId).not.toBeNull();
    for (const effect of [w.terminate, w.stop, w.start]) expect(effect).not.toHaveBeenCalled();
  });

  it("a workspace a step holds cannot be checked under it (the guard says so before asking)", async () => {
    const w = await guardWorld({ machine: "backed", session: { state: "STOPPED", generation: 2 }, check: closeCheckPort, idle: false });
    w.h.deps.closeInspection = provider("wake");
    expect(await refusal(w.close())).toBe(CLOSE_CANNOT_CHECK_WORDS);
  });

  it("a session the provider says cannot be checked is never planned, even when the worker is ready (a retained session: a second check cannot be layered on it)", async () => {
    const w = await world({ state: "READY", generation: 1, extra: { workerFeatures: ["close.retention.v1"] } }, "unsupported", { ready: async () => true });
    const spies = w.writes(), before = await w.rows();
    expect(await requestCloseCheck(w.h.deps, (await readTask(w.h.deps, w.task.taskId))!, (await w.workspace())!)).toBe("unsupported");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(await w.rows()).toEqual(before);
  });

  it("a workspace a step holds right now plans nothing, so nothing is claimed: `unsupported`", async () => {
    const w = await world({ state: "STOPPED", generation: 2 }, "wake");
    const held = { ...(await w.workspace())!, activeOperationId: "00000000-0000-4000-8000-000000000003" };
    const spies = w.writes();
    expect(await requestCloseCheck(w.h.deps, (await readTask(w.h.deps, w.task.taskId))!, held)).toBe("unsupported");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("a workspace that moved between the read and the write (a step took it) is not a check: `unsupported`, nothing held", async () => {
    const w = await world({ state: "STOPPED", generation: 2 }, "wake");
    const stale = (await w.workspace())!;
    await w.h.store.update({ key: w.wk, ops: [change.set("activeOperationId", "00000000-0000-4000-8000-000000000001")] });
    expect(await requestCloseCheck(w.h.deps, (await readTask(w.h.deps, w.task.taskId))!, stale)).toBe("unsupported");
  });
});

describe("planning a preparation", () => {
  it("needs a READY retention-capable machine now, unless the check asked for the wake (then a stopped machine is planned too)", async () => {
    const stopped = await world({ state: "STOPPED", generation: 2 }, "wake", { ready: async () => false });
    const workspace = (await stopped.workspace())!;
    expect(await planClosePreparation(stopped.h.deps, workspace)).toEqual([]);
    expect((await planClosePreparation(stopped.h.deps, workspace, workspace, { wake: true })).length).toBeGreaterThan(0);
    const ready = await world({ state: "READY", generation: 1 }, "ready", { ready: async () => true });
    expect((await planClosePreparation(ready.h.deps, (await ready.workspace())!)).length).toBeGreaterThan(0);
  });
  it("never plans for a workspace a step holds, a close claimed, or that has no machine, wake or not", async () => {
    const w = await world({ state: "STOPPED", generation: 2 }, "wake");
    const base = (await w.workspace())!;
    const machineless = { ...base, machine: undefined } as unknown as typeof base;
    for (const changed of [{ ...base, activeOperationId: "00000000-0000-4000-8000-000000000004" }, { ...base, legacyCloseClaim: w.task.taskId }, machineless]) {
      expect(await planClosePreparation(w.h.deps, changed, base, { wake: true })).toEqual([]);
    }
  });
});

// ---- the preparation: wake, wait, give the workspace back ----
const queueOf = () => {
  const queue = { ack: vi.fn(async () => true), changeVisibility: vi.fn(async () => true), deadLetter: vi.fn(async () => true) };
  return { queue: queue as unknown as Queue, ...queue };
};
const message = (receiveCount: number): ReceivedMessage => ({ messageId: "m", receiptHandle: "h", body: {}, attributes: {}, receiveCount, enqueuedAt: "2026-11-23T00:00:00.000Z" });

async function queued(session: { state: string; generation?: number }, extra: Partial<CloseInspectionProvider>) {
  const w = await world(session, "wake", extra);
  await refusal(w.close());
  const holder = (await w.workspace())!.activeOperationId!;
  return { w, holder, operation: async () => (await readOperation(w.h.deps, w.task.workspaceId, holder))! };
}

describe("the preparation wakes a stopped machine and waits for it", () => {
  it("a machine that is still starting: the preparation keeps its hold and tries again in 30 s; nothing is released, nothing deleted", async () => {
    const wake = vi.fn(async () => "waking" as const);
    const { w, holder, operation } = await queued({ state: "STOPPED", generation: 2 }, { wake });
    const q = queueOf();
    expect(await runClosePreparation(w.h.deps, q.queue, message(2), await operation())).toBe("retried");
    expect(wake).toHaveBeenCalledWith(w.task.workspaceId);
    expect(q.changeVisibility).toHaveBeenCalledWith("h", 30);
    expect(q.ack).not.toHaveBeenCalled();
    expect((await w.workspace())!.activeOperationId).toBe(holder);
    expect((await operation()).status).not.toBe("INTERRUPTED");
    expect(w.terminate).not.toHaveBeenCalled();
  });

  it("it waits longer than a plain preparation does: still held at the 20th receive, given back at the 21st", async () => {
    const { w, holder, operation } = await queued({ state: "STOPPED", generation: 2 }, { wake: async () => "waking" });
    const q = queueOf();
    expect(await runClosePreparation(w.h.deps, q.queue, message(20), await operation())).toBe("retried");
    expect((await w.workspace())!.activeOperationId).toBe(holder);
    expect(q.deadLetter).not.toHaveBeenCalled();
    expect(await runClosePreparation(w.h.deps, q.queue, message(21), await operation())).toBe("failed");
  });

  it("a machine that never came up: the operation is INTERRUPTED and the workspace is given back, so the person can press Close again (no dead hold)", async () => {
    const { w, operation } = await queued({ state: "STOPPED", generation: 2 }, { wake: async () => "waking" });
    const q = queueOf();
    expect(await runClosePreparation(w.h.deps, q.queue, message(21), await operation())).toBe("failed");
    expect((await operation()).status).toBe("INTERRUPTED");
    expect((await w.workspace())!.activeOperationId).toBeNull();
    expect(q.ack).toHaveBeenCalledWith("h");
    expect(q.deadLetter).not.toHaveBeenCalled();
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
    // The next press asks for a fresh check on the next fence.
    expect(await refusal(w.close())).toBe(CLOSE_CHECKING_WORDS);
    expect((await w.workspace())!.activeOperationId).not.toBeNull();
  });

  it("a preparation that already captured a retention target is NEVER given back by running out of tries: it is dead-lettered and the hold stays", async () => {
    const wake = vi.fn(async () => "waking" as const);
    const { w, holder, operation } = await queued({ state: "STOPPED", generation: 2 }, { wake, retained: async () => false });
    const location = await (await import("../../packages/broker/src/core/task-flow/workspace-location.js")).workspaceKeys(w.h.deps, w.task.workspaceId);
    await w.h.store.update({ key: location.operationKey(holder), ops: [change.set("closePreflight.target", { sessionGeneration: 2, instanceId: "i-1", volumeId: "vol-1" })] });
    const q = queueOf();
    expect(await runClosePreparation(w.h.deps, q.queue, message(2), await operation())).toBe("retried");
    // With a target the machine is not woken again (the retained intent is held, never replaced) and the budget is the plain one.
    expect(wake).not.toHaveBeenCalled();
    expect(await runClosePreparation(w.h.deps, q.queue, message(6), await operation())).toBe("retried");
    expect(q.deadLetter).toHaveBeenCalledWith("h", "close_preparation_pending");
    expect((await w.workspace())!.activeOperationId).toBe(holder);
    expect((await operation()).status).not.toBe("INTERRUPTED");
  });

  it("a provider that throws while waking is the old behaviour (the live check decides): nothing is deleted", async () => {
    const { w, operation } = await queued({ state: "STOPPED", generation: 2 }, { wake: async () => { throw new Error("start refused"); }, ready: async () => false });
    const q = queueOf();
    expect(await runClosePreparation(w.h.deps, q.queue, message(1), await operation())).toBe("failed");
    expect((await w.workspace())!.activeOperationId).toBeNull();
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });

  it("a woken machine is checked: the preview exists, and a person's unbound close then gets the retained words", async () => {
    const { w, holder, operation } = await queued({ state: "STOPPED", generation: 2 }, { wake: async () => "ready", ready: async () => true });
    const q = queueOf();
    expect(await runClosePreparation(w.h.deps, q.queue, message(1), await operation())).toBe("delivered");
    expect((await operation()).status).toBe("SUCCEEDED");
    expect(await refusal(w.close())).toBe(retainedCloseWords(w.task.taskId));
    expect(holder).toBe((await operation()).id);
    expect(await closedAt(w)).toBeUndefined();
    expect(w.terminate).not.toHaveBeenCalled();
  });
});

// ---- the close's own commit (G1/G2 allowed it) beside the retention lane's claim ----
describe("a close the guard allowed commits as one transaction that names every item once, and a close that did not close gives the workspace back", () => {
  const commits = (w: GuardWorld) => {
    const seen: Array<Array<{ pk: string; sk: string }>> = [];
    const original = w.h.store.transact.bind(w.h.store);
    w.h.store.transact = async (items) => { seen.push(items.map((item) => (item.kind === "put" ? { pk: item.item.pk, sk: item.item.sk } : { pk: item.key.pk, sk: item.key.sk }))); return original(items); };
    return seen;
  };
  it("the session item is checked by the guard's proof AND by the retention lane's claim, and the two are one condition on one item (DynamoDB refuses two operations on one item; the memory store would not)", async () => {
    const w = await guardWorld({ machine: "backed", session: "absent", check: closeCheckPort });
    const seen = commits(w);
    await w.close();
    expect(await closedAt(w)).toBeDefined();
    expect(seen.length).toBeGreaterThan(0);
    for (const items of seen) expect(new Set(items.map((key) => `${key.pk}|${key.sk}`)).size).toBe(items.length);
  });

  it("a commit that lost a race (a machine recorded in the window) says 'try again', and the claim the close made is removed: later steps and checks are not held by a close that never happened", async () => {
    const w = await guardWorld({ machine: "none", check: closeCheckPort });
    const original = w.h.store.transact.bind(w.h.store);
    w.h.store.transact = async (items) => {
      if (items.some((item) => item.kind === "update" && item.ops.some((op) => op.path[0] === "closedAt"))) await w.h.store.update({ key: w.wk, ops: [change.set("machine", { machineId: w.machineId, machineKey: w.task.workspaceId })] });
      return original(items);
    };
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect((await w.workspace())!.legacyCloseClaim).toBeUndefined();
    expect(await closedAt(w)).toBeUndefined();
  });

  it("a claim lost to a race is the transient 'try again', never the retained sentence (nothing is retained that the person could review)", async () => {
    const w = await guardWorld({ machine: "backed", session: "absent", check: closeCheckPort });
    w.raceOnce(async () => { await w.h.store.update({ key: w.wk, ops: [change.set("activeOperationId", "00000000-0000-4000-8000-000000000002")] }); });
    expect(await refusal(w.close())).toBe(CLOSE_TRY_AGAIN_WORDS);
    expect(await closedAt(w)).toBeUndefined();
  });
});
