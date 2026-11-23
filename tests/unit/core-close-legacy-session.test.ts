import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { change, workspaceSessionKey } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";

async function fixture() {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "legacy session retention" });
  const sk = workspaceSessionKey(task.workspaceId), wk = workspaceKey(h.deps.companyId, task.workspaceId);
  await h.store.put({ item: { ...sk, state: "READY" } });
  return { h, task, sk, wk };
}
it.each([[false, "closeRetention"], [true, "closeRetention"], [false, "closeDestroy"], [true, "closeDestroy"]] as const)("SESSION ownership alone refuses unbound Close before any write (missing workspace: %s, field: %s)", async (missingWorkspace, field) => {
  const w = await fixture();
  await w.h.store.update({ key: w.sk, ops: [change.set(field, { schemaVersion: 1 })] });
  if (missingWorkspace) await w.h.store.delete({ key: w.wk });
  const writes = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "delete")];
  await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: expect.stringContaining(`/v1/dev/tasks/${w.task.taskId}/close`) as string });
  for (const effect of writes) expect(effect).not.toHaveBeenCalled();
});
it.each(["closeRetention", "closeDestroy"] as const)("SESSION %s arriving at the legacy claim is checked atomically", async field => {
  const w = await fixture(), transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  w.h.store.transact = async items => {
    if (!raced) { raced = true; await w.h.store.update({ key: w.sk, ops: [change.set(field, { schemaVersion: 1 })] }); }
    return transact(items);
  };
  await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  expect((await w.h.store.get(taskKey(w.task.taskId)))?.closedAt).toBeUndefined();
  expect((await w.h.store.get(w.wk))?.legacyCloseClaim).toBeUndefined();
});

it("another task's legacy claim refuses without overwriting ownership or closing the task", async () => {
  const w = await fixture();
  await w.h.store.update({ key: w.wk, ops: [change.set("legacyCloseClaim", randomUUID())] });
  const workspace = await w.h.store.get(w.wk), task = await w.h.store.get(taskKey(w.task.taskId));
  const deliver = vi.spyOn(w.h.machines, "deliver");
  await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  expect(await w.h.store.get(w.wk)).toEqual(workspace);
  expect(await w.h.store.get(taskKey(w.task.taskId))).toEqual(task);
  expect(deliver).not.toHaveBeenCalled();
});

it.each([
  ["task company", "task", "companyId", "org_bbbbbbbbbbbbbbbbbbbb"],
  ["task workspace", "task", "workspaceId", "other"],
  ["task closed", "task", "closedAt", "2026-11-22T00:00:00.000Z"],
  ["task close", "task", "closeOperationId", "other"],
  ["workspace company", "workspace", "companyId", "org_bbbbbbbbbbbbbbbbbbbb"],
  ["workspace fence", "workspace", "fence", 999],
  ["workspace holder", "workspace", "activeOperationId", "other"],
] as const)("a racing %s prevents the legacy claim and all flush effects", async (_name, kind, path, value) => {
  const w = await fixture(), transact = w.h.store.transact.bind(w.h.store); let raced = false;
  w.h.store.transact = async items => {
    if (!raced) { raced = true; await w.h.store.update({ key: kind === "task" ? taskKey(w.task.taskId) : w.wk, ops: [change.set(path, value)] }); }
    return transact(items);
  };
  const deliver = vi.spyOn(w.h.machines, "deliver");
  await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  expect((await w.h.store.get(w.wk))?.legacyCloseClaim).toBeUndefined(); expect(deliver).not.toHaveBeenCalled();
});

it("the real READY hold transaction refuses a legacy claim arriving after the step read (H)", async () => {
  const { holdWorkspaceItem, readWorkspace } = await import("../../packages/broker/src/core/task-flow/stage-machine.js");
  const w = await fixture();
  await w.h.store.update({ key: w.wk, ops: [change.set("status", "READY"), change.set("activeOperationId", null)] });
  const seen = (await readWorkspace(w.h.deps, w.task.workspaceId))!;
  const hold = holdWorkspaceItem(seen, randomUUID(), new Date().toISOString());
  await w.h.store.update({ key: w.wk, ops: [change.set("legacyCloseClaim", w.task.taskId)] });
  const before = await w.h.store.get(w.wk);
  expect((await w.h.store.transact([hold])).applied).toBe(false);
  expect(await w.h.store.get(w.wk)).toEqual(before);
});
