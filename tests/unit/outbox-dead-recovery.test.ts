import { afterEach, expect, it, vi } from "vitest";
import { change, companyScoped, OUTBOX_PENDING_INDEX, OUTBOX_RELAY_OWNERSHIP_MS, type Admission, type JsonValue } from "@agentx/contracts";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { createTransactionalOutbox } from "../../packages/broker/src/ports/transactional-outbox.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { MemoryQueueService } from "../../packages/broker/src/ports/memory-queue.js";
import { SqsQueueError } from "../../packages/aws-adapters/src/sqs/sqs-queue.js";
import { chargeMarkerKey, operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { prepareWatchKey } from "../../packages/broker/src/core/task-flow/prepare-watch.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";

const REASON = "Rovara couldn't start this task: the start request couldn't be queued. Try again.";
const outboxKey = (id: string) => ({ pk: companyScoped(COMPANY, `OUTBOX#${id}`), sk: "OUTBOX" });
afterEach(() => { vi.restoreAllMocks(); });

async function startBlocked() {
  const holds = new Set<string>();
  const admission: Admission = { ...createAllowAllAdmission(),
    async stage() { holds.add("start-hold"); return { decision: { allowed: true, reservationId: "start-hold" }, items: [] }; },
    async release(id) { holds.delete(id); },
  };
  const h = createHarness({ admission });
  await h.registerProject();
  const queue = await h.queues.queue("task-dispatch");
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = async () => { throw new SqsQueueError("secret provider message", { retryable: true, cause: Object.assign(new Error("secret payload"), { name: "ThrottlingException", code: "Throttled" }) }); };
  const { task } = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Rename a setting" });
  const workspace = (await h.store.get(workspaceKey(COMPANY, task.workspaceId)))!;
  const id = workspace.activeOperationId as string;
  return { ...h, holds, task, id, queue, enqueue, watch: prepareWatchKey(COMPANY, task.createdAt, task.workspaceId) };
}

it("ten failed enqueues end the task with its served reason, clear ownership, release the slot and admission hold once", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked();
  for (let attempt = 2; attempt <= 9; attempt++) expect(await h.flow.relayOnce()).toEqual({ delivered: 0, failed: 1, dead: 0 });
  expect((await h.flow.get(h.owner, h.task.taskId)).status).toBe("STARTING");
  expect(h.holds.size).toBe(1);
  expect(await h.flow.relayOnce()).toEqual({ delivered: 0, failed: 0, dead: 1 });
  await h.flow.sweepRunsOnce();
  expect(await h.flow.get(h.owner, h.task.taskId)).toMatchObject({ status: "FAILED", failure: { stage: "setup", message: REASON } });
  expect(await h.store.get(outboxKey(h.id))).toMatchObject({ status: "DEAD", attempts: 10 });
  expect(await h.store.get(outboxKey(h.id))).not.toHaveProperty("relayOwner");
  expect(await h.store.get(outboxKey(h.id))).not.toHaveProperty("relayExpiresAt");
  expect(await h.store.get(workspaceKey(COMPANY, h.task.workspaceId))).toMatchObject({ status: "PREPARATION_FAILED", activeOperationId: null });
  expect(await h.store.get(taskPointerKey(COMPANY, h.task.workspaceId))).not.toHaveProperty("pendingPrompt");
  const task = (await h.store.get(taskKey(h.task.taskId)))!;
  const charge = task.charge as unknown as Parameters<typeof chargeMarkerKey>[0];
  expect(await h.store.get(chargeMarkerKey(charge, h.task.taskId))).toBeUndefined();
  expect(await h.store.get(charge.member)).toMatchObject({ count: 0 });
  expect(await h.store.get(charge.organization)).toMatchObject({ count: 0 });
  expect(h.holds.size).toBe(0);
  await h.flow.relayOnce(); await h.flow.sweepRunsOnce();
  expect(await h.store.get(charge.member)).toMatchObject({ count: 0 });
});

it("one transient enqueue failure then success never ends the task or releases its hold", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked(); h.queue.enqueue = h.enqueue;
  expect(await h.flow.relayOnce()).toEqual({ delivered: 1, failed: 0, dead: 0 });
  expect(await h.store.get(outboxKey(h.id))).toMatchObject({ status: "QUEUED", attempts: 1 });
  expect((await h.flow.get(h.owner, h.task.taskId)).status).toBe("STARTING");
  expect(h.holds.size).toBe(1);
});

it.each(["relay", "no relay"])("scheduled recovery after %s handles an already-DEAD prepare without retrying delivery", async (via) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked();
  await h.store.update({ key: outboxKey(h.id), ops: [change.set("status", "DEAD"), change.remove("outboxState"), change.remove("outboxDueAt")] });
  if (via === "relay") await h.flow.relayOnce();
  await h.flow.sweepRunsOnce();
  expect(await h.flow.get(h.owner, h.task.taskId)).toMatchObject({ status: "FAILED", failure: { message: REASON } });
  expect(h.holds.size).toBe(0);
  expect(await h.store.get(h.watch)).toBeUndefined();
});

it("bounds the existing watch recovery and reaches the next orphan on a later pass", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked();
  const second = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "A second task" });
  const ws = (await h.store.get(workspaceKey(COMPANY, second.task.workspaceId)))!;
  for (const id of [h.id, ws.activeOperationId as string]) await h.store.update({ key: outboxKey(id), ops: [change.set("status", "DEAD")] });
  await h.flow.sweepRunsOnce({ limit: 1 });
  const views = await Promise.all([h.flow.get(h.owner, h.task.taskId), h.flow.get(h.owner, second.task.taskId)]);
  expect(views.filter((v) => v.status === "FAILED")).toHaveLength(1);
  await h.flow.sweepRunsOnce({ limit: 1 });
  expect((await h.flow.get(h.owner, h.task.taskId)).status).toBe("FAILED");
  expect((await h.flow.get(h.owner, second.task.taskId)).status).toBe("FAILED");
});

it.each(["foreign-watch", "wrong-kind", "wrong-fence", "different-active", "already-succeeded"])("does not fail a DEAD prepare's task after %s", async (scenario) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked();
  await h.store.update({ key: outboxKey(h.id), ops: [change.set("status", "DEAD")] });
  const opKey = operationKey(COMPANY, h.task.workspaceId, h.id);
  if (scenario === "foreign-watch") await h.store.update({ key: h.watch, ops: [change.set("companyId", "org_aaaaaaaaaaaaaaaaaaaa")] });
  if (scenario === "wrong-kind") await h.store.update({ key: opKey, ops: [change.set("kind", "task")] });
  if (scenario === "wrong-fence") await h.store.update({ key: opKey, ops: [change.set("fence", 99)] });
  if (scenario === "different-active") await h.store.update({ key: workspaceKey(COMPANY, h.task.workspaceId), ops: [change.set("activeOperationId", "new-operation")] });
  if (scenario === "already-succeeded") await h.store.update({ key: opKey, ops: [change.set("status", "SUCCEEDED")] });
  await h.flow.sweepRunsOnce();
  expect((await h.store.get(opKey))?.status).toBe(scenario === "already-succeeded" ? "SUCCEEDED" : "ACCEPTED");
  expect(h.holds.size).toBe(1);
  if (scenario !== "foreign-watch") expect(await h.store.get(h.watch)).toBeUndefined();
});

it("a successful result racing DEAD recovery retains its slot and hold", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked();
  await h.store.update({ key: outboxKey(h.id), ops: [change.set("status", "DEAD")] });
  const transact = h.store.transact.bind(h.store); let raced = false;
  h.store.transact = async (items) => {
    if (!raced && items.some((item) => item.kind === "update" && item.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "FAILED"))) {
      raced = true;
      await h.flow.recordResult({ workspaceId: h.task.workspaceId, operationId: h.id, fence: 1, status: "SUCCEEDED" });
    }
    return transact(items);
  };
  await h.flow.sweepRunsOnce(); expect(raced).toBe(true);
  expect(await h.store.get(operationKey(COMPANY, h.task.workspaceId, h.id))).toMatchObject({ status: "SUCCEEDED" });
  expect(h.holds.size).toBe(1);
});

async function relayFixture() {
  let at = Date.parse("2026-11-22T12:00:00Z");
  const store = new MemoryDocumentStore({ indexes: [OUTBOX_PENDING_INDEX] });
  const queues = new MemoryQueueService(); const queue = await queues.queue("dispatch");
  const make = () => createTransactionalOutbox({ store, queues, now: () => new Date(at) });
  const outbox = make();
  await store.transact([outbox.stage({ companyId: COMPANY, id: "row", queue: "dispatch", body: { secret: "payload-canary" } })]);
  return { store, queue, outbox, make, advance: () => { at += OUTBOX_RELAY_OWNERSHIP_MS; }, key: outboxKey("row") };
}

it("logs attempt, queue, provider error name and retryability without messages, payloads or credentials", async () => {
  const lines: string[] = []; vi.spyOn(console, "warn").mockImplementation((line: string) => { lines.push(line); });
  const h = await startBlocked();
  await h.flow.relayOnce();
  const log = JSON.parse(lines[1]!) as Record<string, JsonValue>;
  expect(log).toMatchObject({ event: "outbox.relay_failed", companyId: COMPANY, outboxId: h.id, queue: "task-dispatch", attempt: 2, operation: "enqueue", error: "SqsQueueError", cause: "ThrottlingException", retryable: true });
  expect(lines.join()).not.toMatch(/secret|payload-canary|instructions|credentials/u);
});

it.each([false, true])("a late owner cannot resurrect DEAD or release its receipt (success=%s)", async (success) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await relayFixture();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => { entered = r; }); const wait = new Promise<void>((r) => { finish = r; });
  const enqueue = h.queue.enqueue.bind(h.queue);
  h.queue.enqueue = async (input) => { entered(); await wait; if (!success) throw new Error("old failure"); return enqueue(input); };
  const old = h.outbox.relay({ companyId: COMPANY }); await started;
  h.advance();
  await h.store.update({ key: h.key, ops: [change.set("attempts", 9)] });
  h.queue.enqueue = async () => { throw new Error("tenth failure"); };
  expect(await h.make().relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 0, dead: 1 });
  const dead = await h.store.get(h.key);
  expect(dead).not.toHaveProperty("relayOwner"); expect(dead).not.toHaveProperty("relayExpiresAt");
  finish(); await old;
  expect(await h.store.get(h.key)).toEqual(dead);
});

it.each(["replaced", "write-error"])("a failed DEAD write (%s) does not report a committed DEAD transition", async (scenario) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await relayFixture(); await h.store.update({ key: h.key, ops: [change.set("attempts", 9)] });
  const update = h.store.update.bind(h.store);
  h.queue.enqueue = async () => {
    if (scenario === "replaced") await update({ key: h.key, ops: [change.set("relayOwner", "successor")] });
    throw new Error("failure");
  };
  h.store.update = async (request) => {
    if (scenario === "write-error" && request.ops.some((op) => op.op === "set" && op.path[0] === "status" && op.value === "DEAD")) throw new Error("store unavailable");
    return update(request);
  };
  expect(await h.outbox.relay({ companyId: COMPANY })).toEqual({ delivered: 0, failed: 1, dead: 0 });
  expect(await h.store.get(h.key)).toMatchObject({ status: "PENDING", attempts: 9 });
});

it.each(["non-prepare", "foreign-task", "different-workspace", "missing-pointer"])("does not release a start hold for %s result association", async (scenario) => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const h = await startBlocked();
  // Replayed terminal results exercise cleanup without re-running the result transaction.
  await h.store.update({ key: operationKey(COMPANY, h.task.workspaceId, h.id), ops: [change.set("status", "FAILED")] });
  if (scenario === "non-prepare") await h.store.update({ key: operationKey(COMPANY, h.task.workspaceId, h.id), ops: [change.set("kind", "task")] });
  if (scenario === "foreign-task") await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set("companyId", "org_aaaaaaaaaaaaaaaaaaaa")] });
  if (scenario === "different-workspace") await h.store.update({ key: taskKey(h.task.taskId), ops: [change.set("workspaceId", "another-workspace")] });
  if (scenario === "missing-pointer") await h.store.delete({ key: taskPointerKey(COMPANY, h.task.workspaceId) });
  await h.flow.recordResult({ workspaceId: h.task.workspaceId, operationId: h.id, fence: 1, status: "FAILED", error: "failure" });
  expect(h.holds.size).toBe(1);
});

it.each([false, true, undefined])("reports provider retryability %s with a safe default for unclassified errors", async (retryable) => {
  const lines: string[] = []; vi.spyOn(console, "warn").mockImplementation((line: string) => { lines.push(line); });
  const h = await relayFixture();
  h.queue.enqueue = async () => { throw Object.assign(new Error("credential-canary"), { name: "QueueDoesNotExist", retryable }); };
  await h.outbox.relay({ companyId: COMPANY });
  expect(JSON.parse(lines[0]!)).toMatchObject({ attempt: 1, error: "QueueDoesNotExist", retryable: retryable ?? true });
  expect(lines.join()).not.toContain("credential-canary");
});
