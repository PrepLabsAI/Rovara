// T3: a close bound to a preview's digest, over a fake provider (the port, NOT machine proof). The destruction after acceptance is pinned by core-close-recovery.test.ts; this file pins WHAT may be accepted:
// a clean preview closes, findings need the discard preview's own digest and the flag, and every replay is the same acceptance.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { change, workspaceSessionKey } from "@agentx/contracts";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { operationKey, taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness } from "../support/task-flow-harness.js";

async function world(findings: boolean, options: { guardOn?: boolean } = {}) {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "bound close" });
  const wk = workspaceKey(h.deps.companyId, task.workspaceId);
  const holder = (await h.store.get(wk))!["activeOperationId"] as string;
  await h.store.update({ key: operationKey(h.deps.companyId, task.workspaceId, holder), ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
  h.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: !findings, repositories: findings ? [{ name: "demo", reasons: ["unpushed_head"] }] : [], contentDigest: "a".repeat(64) }, retentionId: "kept" }; } };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, holder)).toBe(true);
  if (options.guardOn === true) {
    await h.store.update({ key: wk, ops: [change.set("machineGeneration", 1), change.set("machine", { machineId: "m-1", machineKey: task.workspaceId })] });
    await h.store.put({ item: { ...workspaceSessionKey(task.workspaceId), entityType: "WORKSPACE_SESSION", workspaceId: task.workspaceId, state: "READY", generation: 1 } });
    h.deps.closeGuard = { enforce: true };
  }
  const resumed = vi.fn(async () => {});
  h.deps.resumeAcceptedClose = resumed;
  const digest = async (action: "close" | "discard") => (await h.flow.previewClose(h.owner, task.taskId, action)).preview!.digest;
  const accepted = async () => {
    const id = (await h.store.get(taskKey(task.taskId)))!["closeOperationId"];
    return typeof id === "string" ? (await h.store.get(operationKey(h.deps.companyId, task.workspaceId, id)))! : undefined;
  };
  return { h, task, digest, resumed, accepted };
}

describe("the bound close", () => {
  it("a clean preview and its digest are accepted, with no discard", async () => {
    const w = await world(false);
    await w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID(), expectedPreviewDigest: await w.digest("close") });
    expect(await w.accepted()).toMatchObject({ kind: "close", closeAcceptance: { discardUnpublished: false } });
    expect(w.resumed).toHaveBeenCalledTimes(1);
  });
  it("findings: the close digest alone, and the close digest WITH the discard flag, are both refused; only the discard preview's digest with the flag is accepted, and it records the discard", async () => {
    const w = await world(true);
    const close = await w.digest("close"), discard = await w.digest("discard");
    expect(close).not.toBe(discard);
    for (const body of [{ expectedPreviewDigest: close }, { expectedPreviewDigest: close, discard_unpublished: true }, { expectedPreviewDigest: discard }, { expectedPreviewDigest: "f".repeat(64), discard_unpublished: true }]) {
      await expect(w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID(), ...body })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    }
    expect(await w.accepted()).toBeUndefined();
    await w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID(), expectedPreviewDigest: discard, discard_unpublished: true });
    expect(await w.accepted()).toMatchObject({ closeAcceptance: { discardUnpublished: true } });
  });
  it("replays: the same bytes any number of times are the same acceptance; the same request id with other bytes conflicts; another request id after acceptance is stale", async () => {
    const w = await world(false);
    const requestId = randomUUID(), digest = await w.digest("close");
    const first = await w.h.flow.close(w.h.owner, w.task.taskId, { requestId, expectedPreviewDigest: digest });
    for (let again = 0; again < 3; again += 1) expect(await w.h.flow.close(w.h.owner, w.task.taskId, { requestId, expectedPreviewDigest: digest })).toEqual(first);
    const operation = await w.accepted();
    await expect(w.h.flow.close(w.h.owner, w.task.taskId, { requestId, expectedPreviewDigest: "e".repeat(64) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID(), expectedPreviewDigest: digest })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await w.accepted()).toEqual(operation);
  });
  it("a digest of another task's preview is refused", async () => {
    const a = await world(false), b = await world(false);
    await expect(a.h.flow.close(a.h.owner, a.task.taskId, { requestId: randomUUID(), expectedPreviewDigest: await b.digest("close") })).rejects.toMatchObject({ code: "CHANGE_STALE" });
  });
  it("is not subject to the unbound guard: on a guarded, machine-backed workspace it still accepts, and the unbound close after it conflicts", async () => {
    const w = await world(false, { guardOn: true });
    await w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID(), expectedPreviewDigest: await w.digest("close") });
    expect(await w.accepted()).toMatchObject({ kind: "close" });
    await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});
