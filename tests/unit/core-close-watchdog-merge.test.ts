import { expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { runWatchItem } from "../../packages/broker/src/core/task-flow/run-watch-rows.js";
import { closeRecoveryHarness } from "../support/close-recovery-harness.js";

it.each(["lost", "overdue spend stop"] as const)("leaves an accepted close's %s run to its retained recovery", async (kind) => {
  const w = await closeRecoveryHarness({ money: true });
  w.h.deps.resumeAcceptedClose = async () => {};
  await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
  if (kind === "overdue spend stop") {
    await w.h.store.update({ key: w.runKey, ops: [change.set("status", "CANCEL_REQUESTED"), change.set("stopReason", "task_cap"), change.set("stopRequestedAt", new Date(w.h.clock.now).toISOString())] });
  }
  await w.h.store.transact([runWatchItem(w.h.deps, w.run, w.run.machineId!, new Date(w.h.clock.now).toISOString())]);
  const stop = vi.spyOn(w.h.machines, "stop");
  const health = vi.spyOn(w.h.machines, "health");
  const snapshot = async () => Promise.all([w.h.store.get(w.tk), w.h.store.get(w.wk), w.h.store.get(w.runKey), w.accepted(), w.money()]);
  const before = await snapshot();
  w.h.clock.advance(3_001);
  expect(await w.h.flow.sweepRunsOnce()).toMatchObject({ watched: 1, waiting: 1, interrupted: 0, failed: 0 });
  expect(await snapshot()).toEqual(before);
  expect(stop).not.toHaveBeenCalled();
  expect(health).not.toHaveBeenCalled();
  // The sweep yields only this retained run; the accepted close still settles its money and destroys its own retention.
  w.restart();
  await w.pump();
  expect((await w.accepted())?.closeAcceptance?.phase).toBe("complete");
  expect((await w.money()).hold).toBe("settled");
  expect(w.destroyed.size).toBe(1);
});
