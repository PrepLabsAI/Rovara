import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { closeRecoveryHarness } from "../support/close-recovery-harness.js";
import { createHarness } from "../support/task-flow-harness.js";

it("refuses unbound retained Close before any write, flush, accounting or release and names the preview path", async () => {
  const w = await closeRecoveryHarness({ money: true });
  const before = await w.money();
  const effects = [vi.spyOn(w.h.store, "transact"), vi.spyOn(w.h.store, "put"), vi.spyOn(w.h.store, "update"), vi.spyOn(w.h.store, "delete"), vi.spyOn(w.h.deps.admission, "release"), vi.spyOn(w.h.machines, "deliver")];
  await expect(w.h.flow.close(w.h.owner, w.task.taskId, { requestId: randomUUID() })).rejects.toMatchObject({ code: "WORKSPACE_BUSY", message: expect.stringContaining(`/v1/dev/tasks/${w.task.taskId}/close`) as string });
  for (const effect of effects) expect(effect).not.toHaveBeenCalled();
  expect(await w.money()).toEqual(before);
  expect(w.destroyed.size).toBe(0);
  expect(w.terminated.size).toBe(0);
});

it("keeps the documented unbound Close body working when no retention exists", async () => {
  const h = createHarness(); await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "legacy" });
  expect(await h.flow.close(h.owner, task.taskId, { requestId: randomUUID() })).toMatchObject({ status: "CLOSED" });
});

it("still accepts a bound Close through its exact preview", async () => {
  const w = await closeRecoveryHarness({ money: true });
  await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
  expect((await w.accepted())?.closeAcceptance?.phase).toBe("complete");
  expect(w.destroyed.size).toBe(1);
});

it("a retention intent racing the legacy claim refuses without flush or partial writes", async () => {
  const w = await closeRecoveryHarness({ money: true });
  // A pending preflight with no target has not yet acquired retention.
  await w.h.store.update({ key: w.inspected, ops: [change.remove("result"), change.set("closePreflight", { schemaVersion: 1 }), change.set("status", "RUNNING")] });
  const transact = w.h.store.transact.bind(w.h.store);
  let raced = false;
  const deliver = vi.spyOn(w.h.machines, "deliver");
  w.h.store.transact = async items => {
    if (!raced) {
      raced = true;
      await w.h.store.update({ key: w.inspected, ops: [change.set("closePreflight.target", { sessionGeneration: 1, instanceId: "i-01234567", volumeId: "vol-01234567", dataGeneration: randomUUID() })] });
    }
    return transact(items);
  };
  const before = await w.money();
  await expect(w.h.flow.close(w.h.owner, w.task.taskId)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  expect(deliver).not.toHaveBeenCalled();
  expect((await w.h.store.get(w.tk))?.closedAt).toBeUndefined();
  expect((await w.h.store.get(w.wk))?.legacyCloseClaim).toBeUndefined();
  expect(await w.money()).toEqual(before);
});
