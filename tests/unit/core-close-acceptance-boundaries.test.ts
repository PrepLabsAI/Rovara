import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { change, type StoredDocument } from "@agentx/contracts";
import { prepareCloseInspection } from "../../packages/broker/src/core/task-flow/close-inspection.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness } from "../support/task-flow-harness.js";

async function world() {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "close boundaries" });
  const ws = (await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId)))!;
  if (typeof ws.activeOperationId !== "string") throw new Error("missing holder");
  const holder = ws.activeOperationId, op = operationKey(h.deps.companyId, task.workspaceId, holder);
  await h.store.update({ key: op, ops: [change.set("kind", "close"), change.set("status", "RUNNING")] });
  h.deps.closeInspection = { async raiseFence() {}, async retained() { return true; }, async inspectWorkspaceForClose() { return { inspection: { safeToClose: true, repositories: [], contentDigest: "c".repeat(64) }, retentionId: "retention-boundary" }; } };
  expect(await prepareCloseInspection(h.deps, task.workspaceId, holder)).toBe(true);
  const preview = await h.flow.previewClose(h.owner, task.taskId, "close");
  if (preview.preview === null) throw new Error("missing preview");
  const input = { requestId: randomUUID(), expectedPreviewDigest: preview.preview.digest };
  const rows = async (): Promise<StoredDocument[]> => {
    const workspace = await h.store.query({ pk: ws.pk });
    return [...workspace.items, (await h.store.get(taskKey(task.taskId)))!];
  };
  return { h, task, op, input, rows };
}

describe("accepted close record boundaries", () => {
  it("does not certify an inspection operation whose company is absent", async () => {
    const w = await world(); await w.h.store.update({ key: w.op, ops: [change.remove("companyId")] });
    expect(await w.h.flow.previewClose(w.h.owner, w.task.taskId, "close")).toEqual({ preview: null, unavailable: "inspection_required" });
  });
  it("does not certify an inspection stored under a different workspace identity", async () => {
    const w = await world(); await w.h.store.update({ key: w.op, ops: [change.set("workspaceId", randomUUID())] });
    expect(await w.h.flow.previewClose(w.h.owner, w.task.taskId, "close")).toEqual({ preview: null, unavailable: "inspection_required" });
  });
  it("does not overwrite a task pointer close claim made after the read", async () => {
    const w = await world(), transact = w.h.store.transact.bind(w.h.store);
    let injected = false, afterDrift: StoredDocument[] = [];
    w.h.store.transact = async (items) => {
      if (!injected) {
        injected = true;
        await w.h.store.update({ key: taskPointerKey(w.h.deps.companyId, w.task.workspaceId), ops: [change.set("closeOperationId", randomUUID())] });
        afterDrift = await w.rows();
      }
      return transact(items);
    };
    await expect(w.h.flow.close(w.h.owner, w.task.taskId, w.input)).rejects.toMatchObject({ code: "CHANGE_STALE", statusCode: 409 });
    expect(await w.rows()).toEqual(afterDrift);
  });
  it("cannot use a legacy close to bypass the phases of an accepted operation", async () => {
    const w = await world(); await w.h.flow.close(w.h.owner, w.task.taskId, w.input); const before = await w.rows();
    await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await w.rows()).toEqual(before);
  });
});

it("a legacy claim arriving between the preview snapshot and acceptance leaves every close row alone (N5)", async () => {
  const w = await world(), transact = w.h.store.transact.bind(w.h.store); let raced = false, before: StoredDocument[] = [];
  w.h.store.transact = async items => {
    if (!raced) {
      raced = true;
      await w.h.store.update({ key: workspaceKey(w.h.deps.companyId, w.task.workspaceId), ops: [change.set("legacyCloseClaim", w.task.taskId)] });
      before = await w.rows();
    }
    return transact(items);
  };
  await expect(w.h.flow.close(w.h.owner, w.task.taskId, w.input)).rejects.toMatchObject({ code: "CHANGE_STALE" });
  expect(await w.rows()).toEqual(before);
});
