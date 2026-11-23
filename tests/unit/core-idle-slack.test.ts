import { expect, it } from "vitest";
import { change } from "@agentx/contracts";
import { createHarness, newRequestId } from "../support/task-flow-harness.js";
import { runWatchPartition } from "../../packages/broker/src/core/task-flow/run-watch-rows.js";
import { taskThreadKey } from "../../packages/broker/src/core/channel/threads.js";
import { operationKey } from "../../packages/broker/src/core/task-flow/keys.js";

// Removing the idle sweep, the event-sequence fence, or the waiter check must each prevent these expectations.
it("stops an idle Slack operation with a durable system receipt and a single thread note", async () => {
  const { h, task, run } = await runningSlack();
  const notes: string[] = [];
  const sweep = async () => {
    const module = await import("../../packages/broker/src/aws/core-idle-slack.js");
    await module.sweepCoreIdleSlack({ flow: h.deps, threadsTableName: "threads", documentClient: { async send() { return {}; } }, companyOf: async () => h.deps.companyId, postNote: async (_where, text) => { notes.push(text); } });
  };
  h.clock.advance(86_400);
  await sweep();
  expect((await h.store.get(operationKey(h.deps.companyId, task.workspaceId, run["operationId"] as string)))?.["status"]).toBe("DISPATCHING");
  h.clock.advance(1);
  await sweep();
  expect((await h.store.get(operationKey(h.deps.companyId, task.workspaceId, run["operationId"] as string)))?.["status"]).toBe("CANCELLED");
  const receipts = await h.store.query({ pk: `DEVTASK#${task.taskId}`, sk: { op: "beginsWith", prefix: "REQUEST#idle-cancel-" } });
  expect(receipts.items).toEqual([expect.objectContaining({ entityType: "IDEMPOTENCY", action: "cancel", actor: { type: "system", id: "idle-slack-watchdog" }, operationId: run["operationId"] })]);
  await sweep();
  expect(notes).toHaveLength(1);
});

async function runningSlack() {
  const h = createHarness({ machines: { startingChecks: 0 } });
  await h.registerProject();
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting", client: "slack" });
  await h.flow.dispatchOnce();
  const prepare = (await h.store.query({ pk: runWatchPartition(h.deps.companyId) })).items[0]!;
  h.machines.finish(prepare["machineId"] as string, prepare["operationId"] as string);
  await h.flow.recordResult({ workspaceId: task.workspaceId, operationId: prepare["operationId"] as string, fence: 1, status: "SUCCEEDED" });
  await h.flow.dispatchOnce();
  const run = (await h.store.query({ pk: runWatchPartition(h.deps.companyId) })).items[0]!;
  await h.store.update({ key: { pk: `DEVTASK#${task.taskId}`, sk: "META" }, ops: [change.set("sessionId", "idle-session")] });
  await h.store.put({ item: { ...taskThreadKey(h.deps.companyId, "idle-session"), entityType: "CHANNEL_THREAD", personId: h.owner.principal.personId, conversation: { channel: "slack", tenant: "T0EXAMPLE", space: "C0EXAMPLE", thread: "1234567890.123456" } } });
  return { h, task, run };
}

it.each([
  { name: "fresh waiter", idle: 86_401, turn: (operationId: string, now: number) => ({ operationId, seenAt: new Date(now - 899_000).toISOString() }), stop: false },
  { name: "expired waiter", idle: 86_401, turn: (operationId: string, now: number) => ({ operationId, seenAt: new Date(now - 900_000).toISOString() }), stop: true },
  { name: "unstamped waiter at 48h", idle: 172_800, turn: (operationId: string) => ({ operationId }), stop: false },
  { name: "unstamped waiter after 48h", idle: 172_801, turn: (operationId: string) => ({ operationId }), stop: true },
  { name: "unreadable waiter", idle: 200_000, turn: () => "bad", stop: false },
])("preserves the retired $name rule", async ({ idle, turn, stop }) => {
  const { h, task, run } = await runningSlack();
  h.clock.advance(idle);
  const { sweepCoreIdleSlack } = await import("../../packages/broker/src/aws/core-idle-slack.js");
  await sweepCoreIdleSlack({ flow: h.deps, threadsTableName: "threads", documentClient: { async send() { return { Item: { activeTurn: turn(run["operationId"] as string, h.clock.now) } }; } }, companyOf: async () => h.deps.companyId, postNote: async () => undefined });
  expect((await h.store.get(operationKey(h.deps.companyId, task.workspaceId, run["operationId"] as string)))?.["status"]).toBe(stop ? "CANCELLED" : "DISPATCHING");
});

it("a worker event landing during the idle check prevents the destructive claim", async () => {
  const { h, task, run } = await runningSlack();
  h.clock.advance(86_401);
  const key = operationKey(h.deps.companyId, task.workspaceId, run["operationId"] as string);
  const { sweepCoreIdleSlack } = await import("../../packages/broker/src/aws/core-idle-slack.js");
  const report = await sweepCoreIdleSlack({ flow: h.deps, threadsTableName: "threads", documentClient: { async send() { await h.store.update({ key, ops: [change.add("eventSequence", 1)] }); return {}; } }, companyOf: async () => h.deps.companyId, postNote: async () => { throw new Error("must not post"); } });
  expect(report.cancelled).toBe(0);
  expect(await h.store.get(key)).toMatchObject({ status: "DISPATCHING", eventSequence: 1 });
});

it.each(["read-failure", "foreign-company", "no-thread"])("keeps the operation on %s", async (mode) => {
  const { h, task, run } = await runningSlack();
  h.clock.advance(86_401);
  if (mode === "no-thread") await h.store.delete({ key: taskThreadKey(h.deps.companyId, "idle-session") });
  const { sweepCoreIdleSlack } = await import("../../packages/broker/src/aws/core-idle-slack.js");
  await sweepCoreIdleSlack({ flow: h.deps, threadsTableName: "threads", documentClient: { async send() { if (mode === "read-failure") throw new Error("unavailable"); return {}; } }, companyOf: async () => mode === "foreign-company" ? "org_aaaaaaaaaaaaaaaaaaaa" : h.deps.companyId, postNote: async () => { throw new Error("must not post"); } });
  expect((await h.store.get(operationKey(h.deps.companyId, task.workspaceId, run["operationId"] as string)))?.["status"]).toBe("DISPATCHING");
});

it("recovers the same idle cancellation after a crash following its receipt", async () => {
  const { h, task, run } = await runningSlack();
  h.clock.advance(86_401);
  const operationId = run["operationId"] as string;
  const { sweepCoreIdleSlack } = await import("../../packages/broker/src/aws/core-idle-slack.js");
  const transact = h.store.transact.bind(h.store);
  let crash = true;
  h.store.transact = async (items) => {
    if (crash && items.some((item) => item.kind === "update" && item.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "CANCELLED"))) { crash = false; throw new Error("crash after receipt"); }
    return transact(items);
  };
  const notes: string[] = [];
  const deps = { flow: h.deps, threadsTableName: "threads", documentClient: { async send() { return {}; } }, companyOf: async () => h.deps.companyId, postNote: async (_where: unknown, text: string) => { notes.push(text); } };
  expect(await sweepCoreIdleSlack(deps)).toMatchObject({ failed: 1 });
  expect(await h.store.get(operationKey(h.deps.companyId, task.workspaceId, operationId))).toMatchObject({ status: "CANCEL_REQUESTED" });
  expect(await sweepCoreIdleSlack(deps)).toMatchObject({ cancelled: 1 });
  expect(await h.store.get(operationKey(h.deps.companyId, task.workspaceId, operationId))).toMatchObject({ status: "CANCELLED" });
  expect(notes).toHaveLength(1);
});
