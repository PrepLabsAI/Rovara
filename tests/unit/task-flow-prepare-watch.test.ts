import { expect, it } from "vitest";
import { chargeMarkerKey, taskPointerKey, workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";

it("fails an undelivered preparation only after 50 minutes and releases its slot once", async () => {
  const h = createHarness();
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
  const workspace = (await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId)))!;
  h.clock.advance(50 * 60);
  await h.flow.sweepRunsOnce();
  expect((await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId)))?.["status"]).toBe("PREPARING");
  h.clock.advance(1);
  await h.flow.sweepRunsOnce();
  expect(await h.store.get(operationKey(h.deps.companyId, task.workspaceId, workspace["activeOperationId"] as string))).toMatchObject({ status: "FAILED", error: "setup did not finish within 50 minutes; close this task and start a new one" });
  expect(await h.store.get(taskPointerKey(h.deps.companyId, task.workspaceId))).not.toHaveProperty("pendingPrompt");
  const full = (await h.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))!;
  expect(await h.store.get(chargeMarkerKey(full["charge"] as never, task.taskId))).toBeUndefined();
  await h.flow.sweepRunsOnce();
  expect(await h.store.get((full["charge"] as { member: {pk: string; sk: string} }).member)).toMatchObject({ count: 0 });
});

it("a successful prepare result racing the watchdog keeps its result and slot", async () => {
  const h = createHarness();
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
  const workspace = (await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId)))!;
  const operationId = workspace["activeOperationId"] as string;
  const transact = h.store.transact.bind(h.store);
  let raced = false;
  h.store.transact = async (items) => {
    if (!raced && items.some((item) => item.kind === "update" && item.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "FAILED"))) {
      raced = true;
      await h.flow.recordResult({ workspaceId: task.workspaceId, operationId, fence: 1, status: "SUCCEEDED" });
    }
    return transact(items);
  };
  h.clock.advance(3_001);
  await h.flow.sweepRunsOnce();
  expect(raced).toBe(true);
  expect(await h.store.get(operationKey(h.deps.companyId, task.workspaceId, operationId))).toMatchObject({ status: "SUCCEEDED" });
  const full = (await h.store.get({ pk: `DEVTASK#${task.taskId}`, sk: "META" }))!;
  expect(await h.store.get(chargeMarkerKey(full["charge"] as never, task.taskId))).toBeDefined();
});

it("never settles a foreign company watch row", async () => {
  const h = createHarness();
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
  const { prepareWatchKey } = await import("../../packages/broker/src/core/task-flow/prepare-watch.js");
  const key = prepareWatchKey(h.deps.companyId, new Date(h.clock.now).toISOString(), task.workspaceId);
  await h.store.update({ key, ops: [{ op: "set", path: ["companyId"], value: "org_aaaaaaaaaaaaaaaaaaaa" }] });
  h.clock.advance(3_001);
  await h.flow.sweepRunsOnce();
  expect(await h.store.get(workspaceKey(h.deps.companyId, task.workspaceId))).toMatchObject({ status: "PREPARING" });
});
