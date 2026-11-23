import { cancelTask } from "../../packages/broker/src/core/task-flow/cancel.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentSessionKey, change, when, type StoredDocument, type TransactItem } from "@agentx/contracts";
import type { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createHarness } from "../support/task-flow-harness.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { createTaskSessionItems, developerIdOf, taskSessionId } from "../../packages/broker/src/core/sessions/create.js";

async function fixture(discard = true) {
  const h = createHarness({ audit: "recording" }); await h.registerProject();
  // This fixture isolates acceptance; recovery is exercised in core-close-recovery.test.ts.
  h.deps.resumeAcceptedClose = async () => {};
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "close race" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId), tk = taskKey(task.taskId);
  const ws = (await h.store.get(wk))!;
  if (typeof ws.activeOperationId !== "string") throw new Error("fixture holder missing");
  const holderId = ws.activeOperationId;
  const op = operationKey(h.deps.companyId, task.workspaceId, holderId);
  await h.store.update({ key: wk, ops: [change.set("machine", { machineId: "original-machine", machineKey: "original" }), change.set("machineReservationId", "machine-reservation")] });
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
  const run = operationKey(h.deps.companyId, task.workspaceId, randomUUID());
  await h.store.put({ item: { ...(await h.store.get(op))!, ...run, id: run.sk.slice(10), kind: "task", status: "RUNNING", machineId: "original-machine", fence: 0 } });
  const sessionId = taskSessionId(task.taskId), sk = agentSessionKey(h.deps.companyId, sessionId, "META");
  await h.store.transact(createTaskSessionItems({ orgId: h.deps.companyId, sessionId, taskId: task.taskId, project: "payments", agent: { agentId: "agt_00000000000000000000", name: "Code", version: 1 }, title: "close race", owner: h.owner.principal, origin: "app", payer: { kind: "member", developerId: developerIdOf(h.owner.principal) }, now: task.createdAt }));
  await h.store.update({ key: tk, ops: [change.set("sessionId", sessionId)] });
  const auth = { pk: `ORG#${h.deps.companyId}#MEMBER#owner`, sk: "META" };
  await h.store.put({ item: { ...auth, role: "owner", companyId: h.deps.companyId } });
  h.deps.access.ownerActing = async () => {
    const row = await h.store.get(auth);
    return row?.role === "owner" && row.companyId === h.deps.companyId ? { actorId: h.owner.principal.personId, items: [{ kind: "check", key: auth, condition: when.and(when.eq("role", "owner"), when.eq("companyId", h.deps.companyId)) }] } : undefined;
  };
  const retained = vi.fn(async () => true);
  h.deps.closeInspection = { async raiseFence() {}, async inspectWorkspaceForClose() { return { inspection: { safeToClose: !discard, repositories: discard ? [{ name: "demo", reasons: ["untracked_files"] }] : [], contentDigest: "a".repeat(64) }, retentionId: "retention-1" }; }, retained };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, holderId)).toBe(true);
  const preview = await h.flow.previewClose(h.owner, task.taskId, discard ? "discard" : "close");
  if (preview.preview === null) throw new Error("fixture must have a preview");
  const input = { requestId: randomUUID(), expectedPreviewDigest: preview.preview.digest, discard_unpublished: discard };
  const effects = { flush: 0, holds: 0, terminations: 0, releases: 0, dispatch: 0, deletions: 0, follower: 0, model: 0 };
  h.deps.moneyStop = { flushWaitMs: 0, async keepWholeHold() { effects.holds++; } };
  h.deps.admission.release = async () => { effects.releases++; };
  h.machines.terminate = async () => { effects.terminations++; };
  h.machines.deliver = async () => { effects.dispatch++; return { duplicate: false }; };
  h.deps.onTaskClosed = async () => { effects.follower++; };
  let committedWrites = 0;
  const originalPut = h.store.put.bind(h.store), originalTransact = h.store.transact.bind(h.store);
  const originalUpdate = h.store.update.bind(h.store), originalDelete = h.store.delete.bind(h.store);
  h.store.put = async (request) => { const result = await originalPut(request); if (result.applied) committedWrites++; return result; };
  h.store.transact = async (items) => { const result = await originalTransact(items); if (result.applied) committedWrites += items.filter((i) => i.kind !== "check").length; return result; };
  h.store.update = async (request) => { if (request.ops.some((o) => o.op === "set" && o.path[0] === "status" && o.value === "CANCEL_REQUESTED")) effects.flush++; const result = await originalUpdate(request); if (result.applied) committedWrites++; return result; };
  h.store.delete = async (request) => { effects.deletions++; const result = await originalDelete(request); if (result.applied) committedWrites++; return result; };
  const memoryStore = h.store as MemoryDocumentStore;
  const snapshot = async () => {
    const rows: StoredDocument[] = []; let cursor: string | undefined;
    do { const page = await memoryStore.scanPage(cursor === undefined ? {} : { cursor }); rows.push(...page.items); cursor = page.cursor; } while (cursor !== undefined);
    return rows.sort((a, b) => `${a.pk}/${a.sk}`.localeCompare(`${b.pk}/${b.sk}`));
  };
  const close = (request: unknown = input) => h.flow.close(h.owner, task.taskId, request);
  const race = (mutate: () => Promise<unknown>) => {
    const transact = h.store.transact.bind(h.store); let injected = false; let afterDrift: StoredDocument[] = [];
    h.store.transact = async (items: readonly TransactItem[]) => {
      if (!injected && items.some((i) => i.kind === "update" && i.key.pk === tk.pk)) { injected = true; await mutate(); afterDrift = await snapshot(); }
      return transact(items);
    };
    return { injected: () => injected, afterDrift: () => afterDrift };
  };
  return { h, task, tk, wk, op, run, sk, auth, sessionId, input, close, effects, snapshot, race, retained, originalUpdate, writes: () => committedWrites };
}
type World = Awaited<ReturnType<typeof fixture>>;
function textField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new Error(`missing string field: ${field}`);
  return value;
}
const noEffects = { flush: 0, holds: 0, terminations: 0, releases: 0, dispatch: 0, deletions: 0, follower: 0, model: 0 };
async function stale(w: World, before: StoredDocument[]) {
  await expect(w.close()).rejects.toMatchObject({ code: "CHANGE_STALE", statusCode: 409 });
  expect(await w.snapshot()).toEqual(before); expect(w.effects).toEqual(noEffects); expect(w.writes()).toBe(0);
}

// Removing any lifecycle, inspection or atomic claim condition must turn its race into an acceptance.
describe("core accepted close preview races (P2)", () => {
  for (const discard of [false, true]) {
    it(`rejects stale ${discard ? "discard" : "plain close"} before every store/effect`, async () => {
      const w = await fixture(discard); w.input.expectedPreviewDigest = "0".repeat(64); await stale(w, await w.snapshot());
    });
  }
  const drifts: Array<[string, (w: World) => Promise<unknown>]> = [
    ["workspace lifecycle", (w) => w.originalUpdate({ key: w.wk, ops: [change.set("status", "STOPPED")] })],
    ["fence", (w) => w.originalUpdate({ key: w.wk, ops: [change.add("fence", 1)] })],
    ["holder", (w) => w.originalUpdate({ key: w.wk, ops: [change.set("activeOperationId", randomUUID())] })],
    ["workspace owner", (w) => w.originalUpdate({ key: w.wk, ops: [change.set("ownerKey", "other")] })],
    ["workspace company", (w) => w.originalUpdate({ key: w.wk, ops: [change.set("companyId", "other")] })],
    ["task company", (w) => w.originalUpdate({ key: w.tk, ops: [change.set("companyId", "other")] })],
    ["task closed", (w) => w.originalUpdate({ key: w.tk, ops: [change.set("closedAt", "2026-11-21T00:00:00Z")] })],
    ["task workflow", (w) => w.originalUpdate({ key: w.tk, ops: [change.set("workflow", { revision: 20, state: "BLOCKED", stage: "PLAN" })] })],
    ["task owner", (w) => w.originalUpdate({ key: w.tk, ops: [change.set("developerId", "other")] })],
    ["task close claim", (w) => w.originalUpdate({ key: w.tk, ops: [change.set("closeOperationId", randomUUID())] })],
    ["inspection list", (w) => w.originalUpdate({ key: w.op, ops: [change.set("result.closeInspection.repositories", [{ name: "demo", reasons: ["worktree_changes"] }])] })],
    ["same-label content", (w) => w.originalUpdate({ key: w.op, ops: [change.set("result.closeInspection.contentDigest", "b".repeat(64))] })],
    ["inspection status", (w) => w.originalUpdate({ key: w.op, ops: [change.set("status", "FAILED")] })],
    ["inspection company", (w) => w.originalUpdate({ key: w.op, ops: [change.set("companyId", "other")] })],
    ["inspection retention", (w) => w.originalUpdate({ key: w.op, ops: [change.set("result.closeInspection.retentionId", "different")] })],
    ["run lifecycle", (w) => w.originalUpdate({ key: w.run, ops: [change.set("status", "SUCCEEDED")] })],
    ["session owner", (w) => w.originalUpdate({ key: w.sk, ops: [change.set("owner", { developerId: "a".repeat(64), name: "Other" })] })],
    ["session ended", (w) => w.originalUpdate({ key: w.sk, ops: [change.set("endedAt", "2026-11-21T00:00:00Z")] })],
    ["role loss", (w) => w.originalUpdate({ key: w.auth, ops: [change.set("role", "viewer")] })],
    ["company membership loss", (w) => w.originalUpdate({ key: w.auth, ops: [change.set("companyId", "other")] })],
  ];
  for (const [label, mutate] of drifts) it(`refuses ${label} after reads at commit, zero committed writes`, async () => {
    const w = await fixture(); const race = w.race(() => mutate(w));
    await expect(w.close()).rejects.toMatchObject({ code: "CHANGE_STALE", statusCode: 409 });
    expect(race.injected()).toBe(true); expect(await w.snapshot()).toEqual(race.afterDrift()); expect(w.effects).toEqual(noEffects); expect(w.writes()).toBe(0);
  });
  for (const field of ["role", "companyId"]) it(`refuses prior ${field} authority loss with no writes`, async () => {
    const w = await fixture(); await w.originalUpdate({ key: w.auth, ops: [change.set(field, "lost")] }); await stale(w, await w.snapshot());
  });
  it("losing exclusive retention never reacquires consent or starts effects", async () => {
    const w = await fixture(); w.retained.mockResolvedValue(false); await stale(w, await w.snapshot());
  });
  for (const pin of [null, "", "ABC", 123, "A".repeat(64)]) it(`rejects malformed pin ${String(pin).slice(0, 5)} without fallback`, async () => {
    const w = await fixture(), before = await w.snapshot();
    await expect(w.close({ ...w.input, expectedPreviewDigest: pin })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await w.snapshot()).toEqual(before); expect(w.effects).toEqual(noEffects); expect(w.writes()).toBe(0);
  });
  for (const discard of [false, true]) it(`accepts matching ${discard ? "discard" : "plain close"} atomically, retaining reservations`, async () => {
    const w = await fixture(discard), before = await w.snapshot();
    const view = await w.close(); expect(view.closing).toBe(true); expect(view.closedAt).toBeUndefined();
    const task = (await w.h.store.get(w.tk))!, ws = (await w.h.store.get(w.wk))!;
    expect(task.releasedAt).toBeUndefined(); expect(task.closedAt).toBeUndefined();
    const accepted = (await w.h.store.get(operationKey(w.h.deps.companyId, w.task.workspaceId, textField(task, "closeOperationId"))))!;
    expect(accepted).toMatchObject({ kind: "close", status: "ACCEPTED", closeAcceptance: { schemaVersion: 1, phase: "accepted", expectedPreviewDigest: w.input.expectedPreviewDigest, inspection: { retentionId: "retention-1", contentDigest: "a".repeat(64) }, original: { run: { id: w.run.sk.slice(10), fence: 0 }, workspace: { machine: { machineId: "original-machine" }, machineReservationId: "machine-reservation" } }, receipts: {} } });
    expect(ws).toMatchObject({ status: "CLOSING", activeOperationId: accepted.id, fence: Number(before.find((r) => r.pk === w.wk.pk && r.sk === w.wk.sk)!.fence) + 1 });
    expect(await w.h.store.get(agentSessionKey(w.h.deps.companyId, w.sessionId, `REQUEST#${w.input.requestId}`))).toMatchObject({ action: "close", operationId: accepted.id, intentHash: accepted.payloadHash });
    const rows = await w.snapshot();
    expect(rows.some((r) => r.entityType === "AGENT_SESSION_EVENT" && typeof r.text === "string" && r.text.includes("requested"))).toBe(true);
    expect(rows.some((r) => r.entityType === "AUDIT" && r.action === "session.close_requested")).toBe(true);
    expect(rows.find((r) => r.entityType === "OUTBOX" && r.id === accepted.id)).toMatchObject({ status: "PENDING", body: { resumeClose: true, operationId: accepted.id } });
    expect(w.effects).toEqual(noEffects);
  });
  it("ignores unrelated comment, usage and follower drift", async () => {
    const w = await fixture(); w.race(async () => {
      await w.originalUpdate({ key: w.tk, ops: [change.set("commentCount", 7)] });
      await w.originalUpdate({ key: w.run, ops: [change.set("usage", { total: 2 })] });
      await w.originalUpdate({ key: w.sk, ops: [change.set("followerCount", 4)] });
    });
    expect((await w.close()).closing).toBe(true);
  });
  it("exact replay keeps the same acceptance, deadline, effects and receipts; changed intent conflicts", async () => {
    const w = await fixture(); await w.close(); const before = await w.snapshot(), writes = w.writes();
    expect((await w.close()).closing).toBe(true); expect(await w.snapshot()).toEqual(before);
    await expect(w.close({ ...w.input, discard_unpublished: false })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await expect(w.close({ ...w.input, expectedPreviewDigest: "b".repeat(64) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await w.snapshot()).toEqual(before); expect(w.effects).toEqual(noEffects); expect(w.writes()).toBe(writes);
  });
  it("concurrent exact requests create one accepted operation and resume outbox", async () => {
    const w = await fixture(); const results = await Promise.all([w.close(), w.close()]);
    expect(results.every((r) => r.closing)).toBe(true);
    const rows = await w.snapshot(); expect(rows.filter((r) => r.entityType === "OPERATION" && r.closeAcceptance !== undefined)).toHaveLength(1);
    expect(rows.filter((r) => r.entityType === "OUTBOX" && (r.body as { resumeClose?: unknown }).resumeClose === true)).toHaveLength(1); expect(w.effects).toEqual(noEffects);
  });
  it("concurrent different requests cannot claim the same reviewed state", async () => {
    const w = await fixture(); const results = await Promise.allSettled([w.close(), w.close({ ...w.input, requestId: randomUUID() })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "CHANGE_STALE", statusCode: 409 } });
    expect((await w.snapshot()).filter((r) => r.closeAcceptance !== undefined)).toHaveLength(1);
  });
  it("keeps resume deliveries pending instead of dispatching or interrupting accepted close as worker work", async () => {
    const w = await fixture(); await w.close(); const accepted = (await w.h.store.get(w.tk))!.closeOperationId;
    await w.h.flow.relayOnce(); await w.h.flow.dispatchOnce({ maxMessages: 10 });
    expect(await w.h.store.get(operationKey(w.h.deps.companyId, w.task.workspaceId, textField({ accepted }, "accepted")))).toMatchObject({ status: "ACCEPTED", closeAcceptance: { phase: "accepted" } });
    expect(w.effects).toEqual(noEffects);
  });
  it("absent digest keeps DEC 304 close and accounting behavior, without claiming checked consent", async () => {
    const w = await fixture();
    // Old clients never had a retained preflight. Remove that fixture before restoring the running holder.
    await w.originalUpdate({ key: w.op, ops: [change.remove("result")] });
    await w.originalUpdate({ key: w.wk, ops: [change.set("activeOperationId", w.run.sk.slice(10))] });
    expect((await w.close({ requestId: randomUUID(), discard_unpublished: true })).status).toBe("CLOSED");
    expect(w.effects.flush).toBe(1); expect(w.effects.holds).toBe(1); expect(w.effects.terminations).toBe(1);
    expect((await w.snapshot()).some((r) => r.closeAcceptance !== undefined)).toBe(false);
  });
  it("R1 retained legacy refusal leaves the bound close as the only acceptance", async () => {
    const w = await fixture(), transact = w.h.store.transact.bind(w.h.store);
    let injected = false;
    w.h.store.transact = async (items) => {
      if (!injected && items.some((i) => i.kind === "update" && i.key.pk === w.tk.pk && i.ops.some((o) => o.op === "set" && o.path[0] === "closedAt"))) {
        injected = true; await w.close();
      }
      return transact(items);
    };
    await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(injected).toBe(false);
    await w.close();
    const accepted = (await w.snapshot()).find((r) => r.closeAcceptance !== undefined);
    expect(accepted).toMatchObject({ status: "ACCEPTED", closeAcceptance: { phase: "accepted" } });
    expect((await w.h.store.get(w.wk))!.status).toBe("CLOSING");
    expect((await w.h.store.get(w.tk))!.closedAt).toBeUndefined();
    expect(w.effects).toEqual(noEffects);
  });
  it("R2 rejects stale consent after a model run resumes before usage flush or any write", async () => {
    const w = await fixture();
    await w.originalUpdate({ key: w.wk, ops: [change.set("activeOperationId", w.run.sk.slice(10)), change.add("fence", 1)] });
    await w.originalUpdate({ key: w.run, ops: [change.set("fence", Number((await w.h.store.get(w.wk))!.fence))] });
    const relay = vi.spyOn(w.h.deps.outbox, "relay");
    await stale(w, await w.snapshot());
    expect(relay).not.toHaveBeenCalled();
  });
  it("R3 absent digest with a valid retained preview refuses without manufacturing consent", async () => {
    const w = await fixture(false);
    expect((await w.h.flow.previewClose(w.h.owner, w.task.taskId, "close")).preview).not.toBeNull();
    const before = await w.snapshot();
    await expect(w.close({ requestId: randomUUID() })).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(await w.snapshot()).toEqual(before);
    expect((await w.snapshot()).some((r) => r.closeAcceptance !== undefined)).toBe(false);
    expect(w.effects.terminations).toBe(0);
  });
  it("R4 accepts a matching preview with over 100 historical operations in a bounded transaction", async () => {
    const w = await fixture(false);
    for (let i = 0; i < 125; i++) {
      const key = operationKey(w.h.deps.companyId, w.task.workspaceId, randomUUID());
      await w.h.store.put({ item: { ...(await w.h.store.get(w.run))!, ...key, id: key.sk.slice(10), status: "SUCCEEDED", createdAt: "2020-01-01T00:00:00Z" } });
    }
    const preview = await w.h.flow.previewClose(w.h.owner, w.task.taskId, "close");
    if (preview.preview === null) throw new Error("missing preview");
    const transact = w.h.store.transact.bind(w.h.store); let size = 0;
    w.h.store.transact = async (items) => { size = Math.max(size, items.length); return transact(items); };
    expect((await w.close({ ...w.input, expectedPreviewDigest: preview.preview.digest })).closing).toBe(true);
    expect(size).toBeLessThan(20);
  });
  it("Stop cannot cancel an accepted broker close or reopen its workspace", async () => {
    const w = await fixture(); await w.close();
    const before = await w.snapshot();
    expect(await cancelTask(w.h.deps, w.task.taskId)).toEqual({ nothingRunning: true });
    expect(await w.snapshot()).toEqual(before); expect(w.effects).toEqual(noEffects);
  });

});
