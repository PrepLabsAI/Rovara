// tests/contract/stuck-cancels.test.ts
// Issue 195: a task left CANCEL_REQUESTED because its cancel never reached the worker is retried
// once, or ended, so its workspace is never held for good.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  STUCK_CANCEL_INTERRUPTED_MESSAGE,
  STUCK_CANCEL_LOST_MESSAGE,
  STUCK_CANCEL_MS,
  STUCK_CANCEL_RETRY_MS,
  stuckCancelSigningKey,
  sweepStuckCancels,
  type StuckCancelCandidate,
  type StuckCancelDependencies,
} from "../../packages/broker/src/aws/stuck-cancels.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const minutesLater = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

type Retry = NonNullable<StuckCancelDependencies["retryCancel"]>;

function setup(options: { retry?: Retry | false } = {}) {
  const db = new FakeDynamoDb();
  const logs: Array<Record<string, unknown>> = [];
  const retryCancel = vi.fn<Retry>(options.retry === false || options.retry === undefined ? async () => ({ outcome: "REQUEUED", cancelOperationId: randomUUID() }) : options.retry);
  const dependencies: StuckCancelDependencies = {
    client: db,
    tableName: "state",
    ...(options.retry === false ? {} : { retryCancel }),
    log: (entry) => { logs.push(entry); },
  };
  const sweep = (candidates: StuckCancelCandidate[], at: Date = NOW) => sweepStuckCancels(dependencies, candidates, at);
  return { db, logs, retryCancel, sweep };
}

/** A workspace whose active operation is a task in `status`, last changed `minutes` ago. */
function seedTask(db: FakeDynamoDb, status: string, minutes: number, fields: Record<string, unknown> = {}, workspace: Record<string, unknown> = {}) {
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "BUSY", activeOperationId: operationId, fence: 3, deploymentMode: "ec2-ebs", ...workspace });
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "task", status, fence: 3, createdAt: minutesAgo(minutes + 5), updatedAt: minutesAgo(minutes), ...fields });
  const operation = () => db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
  const meta = () => db.get(`WORKSPACE#${workspaceId}`, "META")!;
  return { workspaceId, operationId, operation, meta };
}

const empty = { retried: [], ended: [], interrupted: [], unretried: [], failed: [] };

describe("the limits (issue 195)", () => {
  it("are 30 minutes each", () => {
    expect(STUCK_CANCEL_MS).toBe(30 * 60_000);
    expect(STUCK_CANCEL_RETRY_MS).toBe(30 * 60_000);
  });
});

describe("a stuck cancel whose compute is gone", () => {
  it("ends the operation as the lost-compute path does and frees the workspace", async () => {
    const { db, sweep, logs, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "gone" }])).toEqual({ ...empty, ended: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "FAILED", error: STUCK_CANCEL_LOST_MESSAGE, result: null, updatedAt: NOW.toISOString() });
    expect(task.meta()).toMatchObject({ status: "READY", updatedAt: NOW.toISOString() });
    expect(task.meta()).not.toHaveProperty("activeOperationId");
    expect(retryCancel).not.toHaveBeenCalled();
    expect(logs).toEqual([{ event: "stuck_cancel.ended", workspaceId: task.workspaceId, operationId: task.operationId, reason: "compute-gone" }]);
  });

  it("ends a retried one too, without waiting for the retry limit", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 40, { cancelRetriedAt: minutesAgo(5) });
    expect((await sweep([{ workspaceId: task.workspaceId, compute: "gone" }])).ended).toEqual([task.operationId]);
    expect(task.operation()).toMatchObject({ status: "FAILED", error: STUCK_CANCEL_LOST_MESSAGE });
  });

  it("frees a close's workspace back to the status it had, as the lost-compute path does", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31, { kind: "close", closePreviousStatus: "STOPPED" });
    await sweep([{ workspaceId: task.workspaceId, compute: "gone" }]);
    expect(task.meta()).toMatchObject({ status: "STOPPED" });
  });

  it("ends an AI tool's developer task by the same lost-compute rule", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect((await sweep([{ workspaceId: task.workspaceId, compute: "gone" }])).ended).toEqual([task.operationId]);
  });
});

describe("a stuck cancel whose compute is alive", () => {
  it("re-queues the cancel once, recording the retry first", async () => {
    const { db, sweep, logs, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    retryCancel.mockImplementationOnce(async () => {
      // The retry is recorded before the broker is asked, so a crash here can never retry twice.
      expect(task.operation()).toMatchObject({ cancelRetriedAt: NOW.toISOString() });
      return { outcome: "REQUEUED", cancelOperationId: "cancel-2" };
    });
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual({ ...empty, retried: [task.operationId] });
    expect(retryCancel).toHaveBeenCalledTimes(1);
    expect(retryCancel).toHaveBeenCalledWith(task.workspaceId, task.operationId);
    expect(task.operation()).toMatchObject({ status: "CANCEL_REQUESTED", cancelRetriedAt: NOW.toISOString() });
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
    expect(logs).toEqual([{ event: "stuck_cancel.retried", workspaceId: task.workspaceId, operationId: task.operationId, cancelOperationId: "cancel-2" }]);
  });

  it("never re-queues it again on later runs", async () => {
    const { db, sweep, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const }];
    await sweep(candidate);
    expect(await sweep(candidate, minutesLater(10))).toEqual(empty);
    expect(await sweep(candidate, minutesLater(20))).toEqual(empty);
    expect(retryCancel).toHaveBeenCalledTimes(1);
  });

  it("ends a retried cancel still stuck after the retry limit as interrupted, and frees the workspace", async () => {
    const { db, sweep, logs, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const }];
    await sweep(candidate);
    logs.length = 0;
    expect(await sweep(candidate, minutesLater(29))).toEqual(empty);
    const later = minutesLater(31);
    expect(await sweep(candidate, later)).toEqual({ ...empty, interrupted: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "INTERRUPTED", error: STUCK_CANCEL_INTERRUPTED_MESSAGE, result: null, updatedAt: later.toISOString() });
    expect(task.meta()).toMatchObject({ status: "READY" });
    expect(task.meta()).not.toHaveProperty("activeOperationId");
    expect(retryCancel).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([{ event: "stuck_cancel.interrupted", workspaceId: task.workspaceId, operationId: task.operationId }]);
    // Ended for good: nothing more on the next run.
    expect(await sweep(candidate, minutesLater(60))).toEqual(empty);
  });

  it("times the retry from a newer cancel request, if someone asked again after the retry", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 5, { cancelRetriedAt: minutesAgo(40) });
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual(empty);
    expect(task.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
  });

  it("logs and counts a retry that could not be queued, and never retries it again", async () => {
    const failure = Object.assign(new Error("secret-bearing message"), { name: "StuckCancelRetryFailed" });
    const { db, sweep, logs, retryCancel } = setup({ retry: async () => { throw failure; } });
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const }];
    expect(await sweep(candidate)).toEqual({ ...empty, failed: [task.operationId] });
    expect(logs).toEqual([{ event: "stuck_cancel.retry_failed", workspaceId: task.workspaceId, operationId: task.operationId, errorName: "StuckCancelRetryFailed" }]);
    expect(JSON.stringify(logs)).not.toContain("secret-bearing");
    expect(await sweep(candidate, minutesLater(10))).toEqual(empty);
    expect(retryCancel).toHaveBeenCalledTimes(1);
    // The retry limit still ends it.
    expect((await sweep(candidate, minutesLater(31))).interrupted).toEqual([task.operationId]);
  });

  it("logs a retry that was skipped, and still ends it after the retry limit", async () => {
    const { db, sweep, logs } = setup({ retry: async () => ({ outcome: "SKIPPED", reason: "not-active" }) });
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const }];
    expect(await sweep(candidate)).toEqual(empty);
    expect(logs).toEqual([{ event: "stuck_cancel.retry_skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "not-active" }]);
    expect((await sweep(candidate, minutesLater(31))).interrupted).toEqual([task.operationId]);
  });

  it("leaves it alone while its cancel operation is still progressing, and retries once that goes quiet", async () => {
    const { db, sweep, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 40);
    const cancelId = randomUUID();
    const cancel = (status: string, minutes: number) => db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${cancelId}`, entityType: "OPERATION", id: cancelId, workspaceId: task.workspaceId, kind: "cancel", targetOperationId: task.operationId, status, fence: 3, updatedAt: minutesAgo(minutes) });
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const }];
    cancel("RUNNING", 5);
    expect(await sweep(candidate)).toEqual(empty);
    expect(task.operation()).not.toHaveProperty("cancelRetriedAt");
    cancel("RUNNING", 31);
    expect((await sweep(candidate)).retried).toEqual([task.operationId]);
    expect(retryCancel).toHaveBeenCalledTimes(1);
  });

  it("retries at once when its cancel operation failed, and ignores other operations' cancels", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const other = randomUUID();
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${randomUUID()}`, kind: "cancel", targetOperationId: task.operationId, status: "FAILED", fence: 3, updatedAt: minutesAgo(2) });
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: `OPERATION#${randomUUID()}`, kind: "cancel", targetOperationId: other, status: "RUNNING", fence: 2, updatedAt: minutesAgo(2) });
    expect((await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).retried).toEqual([task.operationId]);
  });

  it("leaves an AI tool's developer task alone, as today", async () => {
    const { db, sweep, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    db.set({ pk: `WORKSPACE#${task.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual(empty);
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }], minutesLater(120))).toEqual(empty);
    expect(retryCancel).not.toHaveBeenCalled();
    expect(task.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(task.operation()).not.toHaveProperty("cancelRetriedAt");
  });

  it("without a way to re-queue (the legacy deployment), only logs and counts it", async () => {
    const { db, sweep, logs } = setup({ retry: false });
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }])).toEqual({ ...empty, unretried: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(task.operation()).not.toHaveProperty("cancelRetriedAt");
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
    expect(logs).toEqual([{ event: "stuck_cancel.retry_unavailable", workspaceId: task.workspaceId, operationId: task.operationId }]);
  });
});

describe("a retried cancel that failed", () => {
  it("frees the workspace its INTERRUPTED task still holds, only after the retry limit", async () => {
    const { db, sweep, logs } = setup();
    const task = seedTask(db, "INTERRUPTED", 1, { cancelRetriedAt: minutesAgo(10) });
    const candidate = [{ workspaceId: task.workspaceId, compute: "alive" as const }];
    expect(await sweep(candidate)).toEqual(empty);
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
    expect(await sweep(candidate, minutesLater(31))).toEqual({ ...empty, interrupted: [task.operationId] });
    expect(task.operation()).toMatchObject({ status: "INTERRUPTED" });
    expect(task.meta()).toMatchObject({ status: "READY" });
    expect(task.meta()).not.toHaveProperty("activeOperationId");
    expect(logs).toEqual([{ event: "stuck_cancel.released", workspaceId: task.workspaceId, operationId: task.operationId }]);
  });

  it("never frees one the sweep did not retry", async () => {
    const { db, sweep } = setup();
    const task = seedTask(db, "INTERRUPTED", 600);
    expect(await sweep([{ workspaceId: task.workspaceId, compute: "alive" }, { workspaceId: task.workspaceId, compute: "gone" }])).toEqual(empty);
    expect(task.meta()).toMatchObject({ status: "BUSY", activeOperationId: task.operationId });
  });

  it("logs a release that lost a race, and does not count it", async () => {
    const { db, logs } = setup();
    const task = seedTask(db, "INTERRUPTED", 40, { cancelRetriedAt: minutesAgo(40) });
    const send = db.send;
    const racing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "TransactWriteCommand") db.set({ ...task.meta(), activeOperationId: randomUUID() });
      return send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: racing, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId: task.workspaceId, compute: "alive" }], NOW);
    expect(result).toEqual(empty);
    expect(logs).toEqual([{ event: "stuck_cancel.skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "changed" }]);
  });
});

describe("what the sweep never touches", () => {
  it("a cancel still within the limit, whatever the compute", async () => {
    const { db, sweep, retryCancel } = setup();
    const alive = seedTask(db, "CANCEL_REQUESTED", 29);
    const gone = seedTask(db, "CANCEL_REQUESTED", 29);
    expect(await sweep([{ workspaceId: alive.workspaceId, compute: "alive" }, { workspaceId: gone.workspaceId, compute: "gone" }])).toEqual(empty);
    expect(alive.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(gone.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(retryCancel).not.toHaveBeenCalled();
  });

  it("an operation that is not CANCEL_REQUESTED, however old", async () => {
    const { db, sweep, retryCancel } = setup();
    const tasks = ["ACCEPTED", "DISPATCHING", "RUNNING", "SUCCEEDED", "CANCELLED", "INTERRUPTED", "FAILED"].map((status) => seedTask(db, status, 600));
    const before = tasks.map((task) => structuredClone(task.operation()));
    for (const compute of ["alive", "gone"] as const) {
      expect(await sweep(tasks.map((task) => ({ workspaceId: task.workspaceId, compute })))).toEqual(empty);
    }
    expect(tasks.map((task) => task.operation())).toEqual(before);
    expect(retryCancel).not.toHaveBeenCalled();
  });

  it("a workspace whose compute is starting or stopping, or that has no active operation", async () => {
    const { db, sweep, retryCancel } = setup();
    const unknown = seedTask(db, "CANCEL_REQUESTED", 600);
    const idle = seedTask(db, "CANCEL_REQUESTED", 600, {}, { status: "READY", activeOperationId: undefined });
    expect(await sweep([{ workspaceId: unknown.workspaceId, compute: "unknown" }, { workspaceId: idle.workspaceId, compute: "gone" }, { workspaceId: randomUUID(), compute: "gone" }])).toEqual(empty);
    expect(unknown.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(idle.operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(retryCancel).not.toHaveBeenCalled();
  });

  it("an operation whose cancel landed after it was read", async () => {
    const { db, logs } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    // The worker's cancel result lands between the sweep's reads and its write.
    const send = db.send;
    const racing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "TransactWriteCommand") {
        db.set({ ...task.operation(), status: "CANCELLED" });
        db.set({ ...task.meta(), status: "READY", activeOperationId: undefined });
      }
      return send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: racing, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId: task.workspaceId, compute: "gone" }], NOW);
    expect(result).toEqual(empty);
    expect(logs).toEqual([{ event: "stuck_cancel.skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "changed" }]);
    expect(task.operation()).toMatchObject({ status: "CANCELLED" });
    expect(task.meta()).toMatchObject({ status: "READY" });
  });
});

describe("races", () => {
  it("does not retry when the cancel was asked again between the read and the claim", async () => {
    const { db, logs, retryCancel } = setup();
    const task = seedTask(db, "CANCEL_REQUESTED", 31);
    const send = db.send;
    const racing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "UpdateCommand") db.set({ ...task.operation(), updatedAt: NOW.toISOString() });
      return send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: racing, tableName: "state", retryCancel, log: (entry) => { logs.push(entry); } }, [{ workspaceId: task.workspaceId, compute: "alive" }], NOW);
    expect(result).toEqual(empty);
    expect(retryCancel).not.toHaveBeenCalled();
    expect(task.operation()).not.toHaveProperty("cancelRetriedAt");
    expect(logs).toEqual([{ event: "stuck_cancel.skipped", workspaceId: task.workspaceId, operationId: task.operationId, reason: "changed" }]);
  });
});

describe("failures", () => {
  it("are logged by name and counted per workspace, and the sweep goes on to the next", async () => {
    const { db, logs } = setup();
    const broken = seedTask(db, "CANCEL_REQUESTED", 31);
    const fine = seedTask(db, "CANCEL_REQUESTED", 31);
    const failing = { ...db, send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === "GetCommand" && JSON.stringify(command.input.Key).includes(broken.workspaceId)) {
        throw Object.assign(new Error("throttled with details"), { name: "ProvisionedThroughputExceededException" });
      }
      return db.send(command);
    } } as unknown as FakeDynamoDb;
    const result = await sweepStuckCancels({ client: failing, tableName: "state", log: (entry) => { logs.push(entry); } }, [
      { workspaceId: broken.workspaceId, compute: "gone" }, { workspaceId: fine.workspaceId, compute: "gone" },
    ], NOW);
    expect(result).toEqual({ ...empty, ended: [fine.operationId], failed: [broken.workspaceId] });
    expect(logs).toContainEqual({ event: "stuck_cancel.check_failed", workspaceId: broken.workspaceId, errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("throttled with details");
  });
});

describe("where the retry is wired", () => {
  it("only where the reconciler holds the callback signing key (named environments), as #173's backstop", () => {
    expect(stuckCancelSigningKey({ CALLBACK_SIGNING_KEY: "k".repeat(64) })).toBe("k".repeat(64));
    expect(stuckCancelSigningKey({})).toBeUndefined();
    expect(stuckCancelSigningKey({ CALLBACK_SIGNING_KEY: "" })).toBeUndefined();
    // The broker's name no longer turns the retry on: the reconciler never invokes the broker.
    expect(stuckCancelSigningKey({ BROKER_FUNCTION_NAME: "agentx-staging-broker" })).toBeUndefined();
  });
});
