// Issue 173: the reconciler backstop. A Slack thread's coding task still live 4 hours after it
// started, with nobody waiting on it, is cancelled through the broker's cancel path, and the thread
// gets one short note. This file covers the reconciler's side: which operations it hands to the
// broker, and what it does with the answer. The broker's own checks are in unwaited-task-broker.test.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  UNWAITED_TASK_LIMIT_MS, UNWAITED_TASK_NOTE, createBrokerTaskStopper, sweepUnwaitedTasks, unwaitedTaskBackstopWanted, type UnwaitedTaskStop,
} from "../../packages/broker/src/aws/unwaited-tasks.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const THREAD = { channelId: "C0123456789", threadTs: "1695500000.000001" };

/** A workspace whose active operation is the given one. */
function seed(db: FakeDynamoDb, operation: Record<string, unknown> = {}) {
  const workspaceId = randomUUID();
  const operationId = randomUUID();
  const ownerKey = `owner-${workspaceId}`;
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", entityType: "WORKSPACE", status: "BUSY", activeOperationId: operationId, fence: 3, ownerKey });
  db.set({ pk: `SLACK_THREAD#${ownerKey}`, sk: "META", entityType: "SLACK_THREAD", thread: "T0123456789/C0123456789/1695500000.000001", workspaceId });
  db.set({
    pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId,
    kind: "task", status: "RUNNING", fence: 3, createdAt: ago(UNWAITED_TASK_LIMIT_MS + 60_000), updatedAt: ago(60_000), ...operation,
  });
  return { workspaceId, operationId };
}

function harness(stop?: (workspaceId: string, operationId: string) => Promise<UnwaitedTaskStop>) {
  const db = new FakeDynamoDb();
  const logs: Array<Record<string, unknown>> = [];
  const stopTask = vi.fn(stop ?? (async (workspaceId: string, operationId: string): Promise<UnwaitedTaskStop> => {
    // As the broker does: the target moves to CANCEL_REQUESTED.
    db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!.status = "CANCEL_REQUESTED";
    return { outcome: "CANCEL_REQUESTED", cancelOperationId: randomUUID(), thread: THREAD };
  }));
  const postNote = vi.fn<(thread: { channelId: string; threadTs: string }, text: string) => Promise<void>>(async () => undefined);
  const sweep = (workspaceIds: string[], at = NOW) => sweepUnwaitedTasks({ client: db, tableName: "state", stopTask, postNote, log: (entry) => { logs.push(entry); } }, workspaceIds, at);
  return { db, logs, stopTask, postNote, sweep };
}

describe("the unwaited task backstop: the limit (#173)", () => {
  it("is 4 hours, as the owner decided, and the note says so in plain words", () => {
    expect(UNWAITED_TASK_LIMIT_MS).toBe(4 * 60 * 60 * 1000);
    expect(UNWAITED_TASK_NOTE).toContain("over 4 hours with nobody waiting on it");
    expect(UNWAITED_TASK_NOTE).not.toMatch(/—|–/);
  });

  it("cancels a task left alone only after the limit, never before", async () => {
    const { db, sweep, stopTask } = harness();
    const young = seed(db, { createdAt: ago(UNWAITED_TASK_LIMIT_MS - 60_000) });
    const exactly = seed(db, { createdAt: ago(UNWAITED_TASK_LIMIT_MS) });
    const old = seed(db, { createdAt: ago(UNWAITED_TASK_LIMIT_MS + 1) });
    const result = await sweep([young.workspaceId, exactly.workspaceId, old.workspaceId]);
    expect(stopTask).toHaveBeenCalledExactlyOnceWith(old.workspaceId, old.operationId);
    expect(result.cancelled).toEqual([old.operationId]);
    // The young one is cancelled once it passes the limit, on a later run.
    stopTask.mockClear();
    await sweep([young.workspaceId], new Date(NOW.getTime() + 2 * 60_000));
    expect(stopTask).toHaveBeenCalledExactlyOnceWith(young.workspaceId, young.operationId);
  });

  it("hands over ACCEPTED, DISPATCHING and RUNNING tasks only", async () => {
    const { db, sweep, stopTask } = harness();
    const live = ["ACCEPTED", "DISPATCHING", "RUNNING"].map((status) => seed(db, { status }));
    const others = ["CANCEL_REQUESTED", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].map((status) => seed(db, { status }));
    await sweep([...live, ...others].map((seeded) => seeded.workspaceId));
    expect(stopTask.mock.calls.map(([, operationId]) => operationId).sort()).toEqual(live.map((seeded) => seeded.operationId).sort());
  });

  it("never touches an operation of another kind, or one that no longer owns its workspace", async () => {
    const { db, sweep, stopTask } = harness();
    const kinds = ["prepare", "publish", "maintain", "close", "cancel"].map((kind) => seed(db, { kind }));
    const released = seed(db);
    db.get(`WORKSPACE#${released.workspaceId}`, "META")!.activeOperationId = randomUUID();
    const idle = seed(db);
    delete db.get(`WORKSPACE#${idle.workspaceId}`, "META")!.activeOperationId;
    await sweep([...kinds, released, idle].map((seeded) => seeded.workspaceId).concat(randomUUID()));
    expect(stopTask).not.toHaveBeenCalled();
  });
});

describe("the unwaited task backstop: what it never touches (#173)", () => {
  it("never hands over a task started from an AI tool (an MCP developer task)", async () => {
    const { db, sweep, stopTask } = harness();
    const byDeveloper = seed(db, { requestedBy: { kind: "developer", developerId: "a".repeat(64), provider: "slack" } });
    const developerWorkspace = seed(db);
    db.set({ pk: `WORKSPACE#${developerWorkspace.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    await sweep([byDeveloper.workspaceId, developerWorkspace.workspaceId]);
    expect(stopTask).not.toHaveBeenCalled();
  });
});

describe("the unwaited task backstop: the broker's answer (#173)", () => {
  it("posts the note once, to the thread the broker names, and never again on later runs", async () => {
    const { db, sweep, postNote, logs } = harness();
    const old = seed(db);
    await sweep([old.workspaceId]);
    await sweep([old.workspaceId]);
    expect(postNote).toHaveBeenCalledExactlyOnceWith(THREAD, UNWAITED_TASK_NOTE);
    expect(logs).toContainEqual(expect.objectContaining({ event: "unwaited_task.cancelled", workspaceId: old.workspaceId, operationId: old.operationId }));
  });

  it("posts nothing when the broker found the task waited on, finished or otherwise not to cancel", async () => {
    const { db, sweep, postNote } = harness(async () => ({ outcome: "SKIPPED", reason: "waited-on" }));
    const old = seed(db);
    const result = await sweep([old.workspaceId]);
    expect(postNote).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
  });

  it("logs a failed cancel by its error name only, and retries it on the next run", async () => {
    let attempts = 0;
    const planted = Object.assign(new Error("PLANTED-CANCEL-MESSAGE xoxb-secret"), { name: "TooManyRequestsException" });
    const { db, sweep, postNote, logs, stopTask } = harness(async (workspaceId, operationId) => {
      attempts += 1;
      if (attempts === 1) throw planted;
      db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!.status = "CANCEL_REQUESTED";
      return { outcome: "CANCEL_REQUESTED", cancelOperationId: randomUUID(), thread: THREAD };
    });
    const old = seed(db);
    const first = await sweep([old.workspaceId]);
    expect(first.failed).toEqual([old.operationId]);
    expect(logs).toContainEqual({ event: "unwaited_task.cancel_failed", workspaceId: old.workspaceId, operationId: old.operationId, errorName: "TooManyRequestsException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED");
    expect(postNote).not.toHaveBeenCalled();
    const second = await sweep([old.workspaceId]);
    expect(stopTask).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ cancelled: [old.operationId], failed: [] });
    expect(postNote).toHaveBeenCalledOnce();
  });

  it("goes on to the next task after a failed cancel", async () => {
    const { db, sweep, stopTask } = harness(async (workspaceId, operationId) => {
      if (workspaceId === first.workspaceId) throw new Error("boom");
      db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!.status = "CANCEL_REQUESTED";
      return { outcome: "CANCEL_REQUESTED", cancelOperationId: randomUUID(), thread: THREAD };
    });
    const first = seed(db);
    const second = seed(db);
    const result = await sweep([first.workspaceId, second.workspaceId]);
    expect(stopTask).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ cancelled: [second.operationId], failed: [first.operationId] });
  });

  it("logs a failed note by its error name only and does not post it again (the task is already cancelled)", async () => {
    const { db, sweep, postNote, logs } = harness();
    postNote.mockRejectedValueOnce(Object.assign(new Error("PLANTED-NOTE-MESSAGE"), { name: "SlackPostError" }));
    const old = seed(db);
    const result = await sweep([old.workspaceId]);
    expect(result).toMatchObject({ cancelled: [old.operationId], noteFailures: 1 });
    expect(logs).toContainEqual({ event: "unwaited_task.note_failed", workspaceId: old.workspaceId, operationId: old.operationId, errorName: "SlackPostError" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED");
    await sweep([old.workspaceId]);
    expect(postNote).toHaveBeenCalledOnce();
  });
});

describe("the unwaited task backstop: invoking the broker (#173)", () => {
  const reply = (statusCode: number, body: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify({ statusCode, body: JSON.stringify(body) })) });

  it("sends the broker the internal event and reads its answer", async () => {
    const invoke = vi.fn<(payload: string) => Promise<{ Payload: Uint8Array }>>(async () => reply(200, { outcome: "CANCEL_REQUESTED", cancelOperationId: "c-1", thread: THREAD, requestId: "session-reconciler" }));
    const stop = createBrokerTaskStopper(invoke);
    expect(await stop("w-1", "o-1")).toEqual({ outcome: "CANCEL_REQUESTED", cancelOperationId: "c-1", thread: THREAD });
    expect(JSON.parse(invoke.mock.calls[0]![0])).toEqual({ source: "agentx.session-reconciler", action: "stop-unwaited-task", workspaceId: "w-1", operationId: "o-1" });
    const skip = createBrokerTaskStopper(async () => reply(200, { outcome: "SKIPPED", reason: "waited-on" }));
    expect(await skip("w-1", "o-1")).toEqual({ outcome: "SKIPPED", reason: "waited-on" });
  });

  it("throws, named by the broker's error code, when the broker refuses or fails, so the sweep logs it and retries", async () => {
    await expect(createBrokerTaskStopper(async () => reply(404, { error: { code: "NOT_FOUND", message: "PLANTED" } }))("w", "o"))
      .rejects.toMatchObject({ name: "BrokerRefused_NOT_FOUND" });
    await expect(createBrokerTaskStopper(async () => ({ FunctionError: "Unhandled", Payload: new Uint8Array() }))("w", "o"))
      .rejects.toMatchObject({ name: "BrokerInvokeFailed" });
    await expect(createBrokerTaskStopper(async () => reply(200, { outcome: "CANCEL_REQUESTED" }))("w", "o"))
      .rejects.toMatchObject({ name: "BrokerAnswerUnreadable" });
    await expect(createBrokerTaskStopper(async () => reply(500, { error: { code: "has spaces; PLANTED" } }))("w", "o"))
      .rejects.toMatchObject({ name: "BrokerRefused_unknown" });
  });

  it("is wired only where the broker and the Slack secret are named (named environments)", () => {
    expect(unwaitedTaskBackstopWanted({})).toBe(false);
    expect(unwaitedTaskBackstopWanted({ BROKER_FUNCTION_NAME: "broker" })).toBe(false);
    expect(unwaitedTaskBackstopWanted({ BROKER_FUNCTION_NAME: "broker", SLACK_SECRET_ARN: "arn:aws:secretsmanager:us-east-1:111122223333:secret:agentx/staging/slack-AbCdEf" })).toBe(true);
  });
});

describe("the unwaited task backstop: cheap pre-checks and isolation (#173 review)", () => {
  it("never invokes the broker for a workspace no Slack thread owns (an API or CLI workspace)", async () => {
    const { db, sweep, stopTask } = harness();
    const api = seed(db);
    const ownerKey = String(db.get(`WORKSPACE#${api.workspaceId}`, "META")!.ownerKey);
    db.delete(`SLACK_THREAD#${ownerKey}`, "META");
    const elsewhere = seed(db);
    const otherOwner = String(db.get(`WORKSPACE#${elsewhere.workspaceId}`, "META")!.ownerKey);
    db.get(`SLACK_THREAD#${otherOwner}`, "META")!.workspaceId = randomUUID();
    await sweep([api.workspaceId, elsewhere.workspaceId]);
    expect(stopTask).not.toHaveBeenCalled();
  });

  it("logs a failed read for one workspace by its error name, counts it, and goes on to the next", async () => {
    const { db, sweep, stopTask, logs } = harness();
    const broken = seed(db);
    const fine = seed(db);
    const original = db.send;
    db.send = async (command) => {
      if (JSON.stringify(command.input).includes(`WORKSPACE#${broken.workspaceId}`)) throw Object.assign(new Error("PLANTED-READ"), { name: "ProvisionedThroughputExceededException" });
      return original(command);
    };
    const result = await sweep([broken.workspaceId, fine.workspaceId]);
    expect(stopTask).toHaveBeenCalledExactlyOnceWith(fine.workspaceId, fine.operationId);
    expect(result).toMatchObject({ cancelled: [fine.operationId], failed: [broken.workspaceId] });
    expect(logs).toContainEqual({ event: "unwaited_task.read_failed", workspaceId: broken.workspaceId, errorName: "ProvisionedThroughputExceededException" });
    expect(JSON.stringify(logs)).not.toContain("PLANTED");
  });
});

