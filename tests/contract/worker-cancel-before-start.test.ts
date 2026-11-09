// 058-stop-close (QA6-13): a Stop that reaches the worker before the task it targets is running used to fail with NOT_FOUND ("active operation not found"). The broker then
// left the task INTERRUPTED and its workspace held, "as the worker may still run it", for the reconciler to free ten minutes later. These tests pin the worker's side of the
// fix: a cancel for an operation the worker has not seen is remembered (so the operation never starts), and a cancel for one it has taken but not yet registered stops it the
// moment it registers.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { PENDING_CANCEL_TTL_MS, WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { executeWorkerCancelInvocation } from "../../packages/worker/src/cancel-invocation.js";
import { closeInvocationResult } from "../../packages/worker/src/close-workspace.js";
import { OperationJournal, TOMBSTONE_MAX_AGE_MS } from "../../packages/worker/src/journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function journal() {
  const root = await mkdtemp(join(tmpdir(), "agentx-cancel-before-start-"));
  roots.push(root);
  return new OperationJournal(root);
}

const workspaceId = randomUUID();
const cancelOf = (targetOperationId: string): Extract<WorkerInvocation, { kind: "cancel" }> => ({
  protocolVersion: 1, kind: "cancel", operationId: randomUUID(), workspaceId, fence: 4, projectRevision: 1,
  callbackCapability: "x".repeat(40), payload: { targetOperationId },
});
const taskInvocation = (operationId: string): WorkerInvocation => ({
  protocolVersion: 1, kind: "close", operationId, workspaceId, fence: 4, projectRevision: 1, callbackCapability: "x".repeat(40), payload: {},
});

describe("a cancel for an operation this worker has never been sent", () => {
  it("succeeds, and the operation is refused if it arrives afterwards", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(await store.get(target)).toMatchObject({ operationId: target, workspaceId, fence: 4, status: "CANCELLED" });
    // The task arrives late (its delivery was already on the way): it is answered as a duplicate that ended cancelled, and never runs.
    const late = await store.accept(taskInvocation(target));
    expect(late).toMatchObject({ duplicate: true, record: { status: "CANCELLED" } });
  });

  it("is idempotent: a second cancel for it succeeds the same way", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await executeWorkerCancelInvocation(cancelOf(target), controller, store);
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).resolves.toMatchObject({ status: "CANCELLED" });
  });
});

describe("a cancel for an operation the worker has taken but that has not registered yet", () => {
  it("stops it the moment it registers, and answers once it has ended", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    let aborted = 0;
    const answer = executeWorkerCancelInvocation(cancelOf(target), controller, store, { waitMs: 5_000, pollMs: 10 });
    // The task is still preparing: it registers a little later, as run-task does after the checkout and the session.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const unregister = controller.register(target, { abort: async () => { aborted += 1; } });
    expect(controller.isCancelled(target)).toBe(true);
    // The run sees the stop on its next check and ends cancelled, as a stopped run does.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.transition(target, "CANCELLED", "operation cancelled");
    unregister();
    await expect(answer).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(aborted).toBe(1);
  });

  it("registers an already-cancelled operation with the stop in place, so the run's first check ends it", async () => {
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    expect(controller.cancelWhenRegistered(target)).toBe(true);
    expect(controller.isCancelled(target)).toBe(true);
    controller.register(target, { abort: async () => undefined });
    expect(controller.isCancelled(target)).toBe(true);
  });

  it("fails closed when the operation does not end in time: the cancel fails (the broker keeps the workspace held), and the stop stays in place", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store, { waitMs: 60, pollMs: 10 })).rejects.toMatchObject({ code: "OPERATION_INTERRUPTED" });
    expect(controller.isCancelled(target)).toBe(true);
  });

  it("leaves a finished operation alone: its cancel fails as before, and nothing is remembered", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "SUCCEEDED");
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(controller.isCancelled(target)).toBe(false);
  });
});

describe("a cancel for a running (registered) operation", () => {
  it("is unchanged: aborts it and marks the journal", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    let aborted = 0;
    controller.register(target, { abort: async () => { aborted += 1; } });
    await expect(executeWorkerCancelInvocation(cancelOf(target), controller, store)).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(aborted).toBe(1);
    expect(await store.get(target)).toMatchObject({ status: "CANCELLED" });
  });
});

describe("the stop and the operation's own delivery reach the worker at the same moment (review I1)", () => {
  it("when the operation's accept wins the race, the stop does not claim the operation never ran: it is applied when the operation registers", async () => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    // The cancel reads the journal (nothing there), then the operation is accepted before the stop's tombstone is written.
    const read = store.get.bind(store);
    let raced = false;
    store.get = async (operationId: string) => {
      const found = await read(operationId);
      if (!raced && operationId === target && found === undefined) { raced = true; await store.accept(taskInvocation(target)); await store.transition(target, "RUNNING"); }
      return found;
    };
    let aborted = 0;
    const answer = executeWorkerCancelInvocation(cancelOf(target), controller, store, { waitMs: 5_000, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The cancel has NOT answered (it would have been CANCELLED while the operation runs); the stop is waiting for the operation.
    let settled = false;
    void answer.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    expect(controller.isCancelled(target)).toBe(true);
    controller.register(target, { abort: async () => { aborted += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await store.transition(target, "CANCELLED", "operation cancelled");
    await expect(answer).resolves.toEqual({ status: "CANCELLED", remainingProcesses: 0 });
    expect(aborted).toBe(1);
    expect(raced).toBe(true);
    // The record is the operation's own, not a tombstone.
    expect(await store.get(target)).toMatchObject({ status: "CANCELLED" });
    expect((await store.get(target))?.payloadHash).not.toBe("cancelled-before-arrival");
  });
});

describe("a stop never claims an operation that finished on its own (review M1)", () => {
  it.each(["SUCCEEDED", "FAILED"] as const)("an operation that ends %s while the stop waits: the cancel fails (the broker keeps its result), and nothing stays remembered", async (ended) => {
    const store = await journal();
    const controller = new WorkerCancellationController();
    const target = randomUUID();
    await store.accept(taskInvocation(target));
    await store.transition(target, "RUNNING");
    const answer = executeWorkerCancelInvocation(cancelOf(target), controller, store, { waitMs: 5_000, pollMs: 10 });
    const failure = expect(answer).rejects.toMatchObject({ code: "NOT_FOUND" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await store.transition(target, ended, ended === "FAILED" ? "boom" : undefined);
    await failure;
    expect(controller.isCancelled(target)).toBe(false);
  });
});

describe("what a stop remembers is bounded (review M2)", () => {
  it("drops a remembered stop for an operation that never registered once its time is up", () => {
    const controller = new WorkerCancellationController();
    const never = randomUUID();
    const t0 = 1_000_000;
    controller.cancelWhenRegistered(never, t0);
    expect(controller.isCancelled(never)).toBe(true);
    controller.cancelWhenRegistered(randomUUID(), t0 + PENDING_CANCEL_TTL_MS + 1);
    expect(controller.isCancelled(never)).toBe(false);
    // So registering it later is no longer stopped.
    controller.register(never, { abort: async () => undefined });
    expect(controller.isCancelled(never)).toBe(false);
  });

  it("forgets a stop for an operation that has ended, but never one that is running", () => {
    const controller = new WorkerCancellationController();
    const ended = randomUUID();
    controller.cancelWhenRegistered(ended);
    controller.forget(ended);
    expect(controller.isCancelled(ended)).toBe(false);
    const running = randomUUID();
    controller.register(running, { abort: async () => undefined });
    controller.forget(running);
    expect(controller.isRegistered(running)).toBe(true);
  });

  it("prunes tombstones older than a week when it writes a new one, and never the record of an operation that ran", async () => {
    const store = await journal();
    const old = randomUUID(), ran = randomUUID(), fresh = randomUUID();
    await store.tombstone({ operationId: old, workspaceId, fence: 1 });
    await store.accept(taskInvocation(ran));
    expect(await store.pruneTombstones(TOMBSTONE_MAX_AGE_MS, Date.now() + TOMBSTONE_MAX_AGE_MS + 60_000)).toBe(1);
    expect(await store.get(old)).toBeUndefined();
    expect(await store.get(ran)).toBeDefined();
    await store.tombstone({ operationId: fresh, workspaceId, fence: 1 });
    expect(await store.get(fresh)).toBeDefined();
  });
});

describe("the worker's close check while another operation is active (review I2)", () => {
  it("refuses, so a close can never delete a workspace an old run may still be writing to", async () => {
    await expect(closeInvocationResult("/nonexistent-root", () => true)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  });
});
