// tests/contract/stuck-cancel-retry.test.ts
// Issue 195: the reconciler queues a stuck cancel again, once, in its own process. It checks
// everything again and queues it through requestCancellation, the cancel route's own path (moved to
// cancellation.ts by #173). It never asks the broker.
import { createHmac, randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, finishOperation, loadSlackBroker, markReady, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";
import { FAILED_CANCEL_RELEASED_MESSAGE, STUCK_CANCEL_RETRY_MS, createCancelRetrier, sweepStuckCancels } from "../../packages/broker/src/aws/stuck-cancels.js";

const SIGNING_KEY = "c".repeat(64);

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";
const slackThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };

beforeAll(async () => {
  await loadSlackBroker();
});

/** A thread's task the member stopped, whose cancel the reconciler has recorded one retry for. */
async function stuckCancel(options: { claimed?: boolean } = {}) {
  const broker = createBroker();
  await registerSlackProject(broker.handler);
  const workspaceId = (await ensureWorkspace(broker.handler, thread, pratik)).body.workspaceId as string;
  markReady(broker.db, workspaceId);
  const conversation = await serviceCall(broker.handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
  const task = await serviceCall(broker.handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
    requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run the tests",
  });
  const taskOperationId = (task.body.operation as { id: string }).id;
  const stopped = await broker.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: slackThread, userId: pratik });
  const firstCancelId = (JSON.parse(stopped.body) as { cancelOperationId: string }).cancelOperationId;
  const operation = () => broker.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)!;
  if (options.claimed !== false) broker.db.set({ ...operation(), cancelRetriedAt: new Date().toISOString() });
  const cancels = () => broker.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel" && item.targetOperationId === taskOperationId);
  const retry = () => createCancelRetrier({ client: broker.db, tableName: "state", callbackSigningKey: SIGNING_KEY })(workspaceId, taskOperationId);
  return { ...broker, workspaceId, taskOperationId, firstCancelId, operation, cancels, retry };
}

describe("the stuck-cancel retry, in the reconciler (issue 195)", () => {
  it("queues a fresh cancel for the task through the cancel path", async () => {
    const { db, workspaceId, taskOperationId, firstCancelId, operation, cancels, retry } = await stuckCancel();
    const retried = await retry();
    expect(retried).toMatchObject({ outcome: "REQUEUED" });
    const cancelId = (retried as { cancelOperationId: string }).cancelOperationId;
    expect(cancelId).not.toBe(firstCancelId);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${cancelId}`)).toMatchObject({ kind: "cancel", status: "ACCEPTED", targetOperationId: taskOperationId });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === cancelId);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ status: "PENDING", invocation: { kind: "cancel", operationId: cancelId, payload: { targetOperationId: taskOperationId } } });
    expect(operation()).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(operation()).toHaveProperty("cancelRetriedAt");
    expect(cancels()).toHaveLength(2);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: taskOperationId });
  });

  it("signs the cancel's worker callbacks with the callback signing key, as the broker does", async () => {
    const { db, retry } = await stuckCancel();
    const cancelId = (await retry() as { cancelOperationId: string }).cancelOperationId;
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === cancelId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    const [body, signature] = capability.split(".");
    expect(signature).toBe(createHmac("sha256", SIGNING_KEY).update(body!).digest("base64url"));
    expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toMatchObject({ operationId: cancelId, actions: ["artifacts", "events", "result"] });
  });

  it("queues nothing unless the reconciler recorded the retry first", async () => {
    const { cancels, retry } = await stuckCancel({ claimed: false });
    expect(await retry()).toEqual({ outcome: "SKIPPED", reason: "not-claimed" });
    expect(cancels()).toHaveLength(1);
  });

  it("queues nothing for a task that is no longer CANCEL_REQUESTED", async () => {
    const { db, operation, cancels, retry } = await stuckCancel();
    db.set({ ...operation(), status: "CANCELLED" });
    expect(await retry()).toEqual({ outcome: "SKIPPED", reason: "not-cancel-requested" });
    expect(cancels()).toHaveLength(1);
  });

  it("queues nothing for an operation that no longer holds the workspace", async () => {
    const { db, workspaceId, cancels, retry } = await stuckCancel();
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, "META")!, activeOperationId: randomUUID() });
    expect(await retry()).toEqual({ outcome: "SKIPPED", reason: "not-active" });
    expect(cancels()).toHaveLength(1);
  });

  it("never retries an AI tool's developer task", async () => {
    const { db, workspaceId, cancels, retry } = await stuckCancel();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect(await retry()).toEqual({ outcome: "SKIPPED", reason: "developer-task" });
    expect(cancels()).toHaveLength(1);
  });

  it("queues nothing for a workspace that is gone", async () => {
    const { db, workspaceId, cancels, retry } = await stuckCancel();
    db.delete(`WORKSPACE#${workspaceId}`, "META");
    expect(await retry()).toEqual({ outcome: "SKIPPED", reason: "not-active" });
    expect(cancels()).toHaveLength(1);
  });

  it("queues nothing when the task's fence is no longer the workspace's", async () => {
    const { db, workspaceId, operation, cancels, retry } = await stuckCancel();
    const meta = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    db.set({ ...meta, fence: (operation().fence as number) + 1 });
    expect(await retry()).toEqual({ outcome: "SKIPPED", reason: "fence-changed" });
    expect(cancels()).toHaveLength(1);
  });

  it("answers finished, and queues nothing, for a task that ended while the cancel was being written", async () => {
    const { db, workspaceId, taskOperationId, operation, cancels } = await stuckCancel();
    const racing = {
      async send(command: unknown) {
        // The task's result lands between the retrier's reads and its write.
        if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") db.set({ ...operation(), status: "CANCELLED" });
        return db.send(command as never);
      },
    };
    expect(await createCancelRetrier({ client: racing, tableName: "state", callbackSigningKey: SIGNING_KEY })(workspaceId, taskOperationId)).toEqual({ outcome: "SKIPPED", reason: "finished" });
    expect(cancels()).toHaveLength(1);
  });
});

describe("the broker (issue 195)", () => {
  it("no longer takes a retry request from the reconciler: it queues nothing", async () => {
    const { handler, workspaceId, taskOperationId, cancels } = await stuckCancel();
    const response = await handler({ source: "agentx.session-reconciler", action: "retry-stuck-cancel", workspaceId, operationId: taskOperationId });
    expect(JSON.parse(response.body)).not.toHaveProperty("outcome");
    expect(cancels()).toHaveLength(1);
  });
});

describe("the retried cancel's result (issue 195)", () => {
  it("never turns a task the first cancel already ended into INTERRUPTED", async () => {
    const { db, handler, workspaceId, firstCancelId, operation, retry } = await stuckCancel();
    const secondCancelId = (await retry() as { cancelOperationId: string }).cancelOperationId;
    await finishOperation(handler, db, workspaceId, firstCancelId, "SUCCEEDED");
    expect(operation()).toMatchObject({ status: "CANCELLED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    // The worker no longer knows the task, so the retried cancel fails.
    await finishOperation(handler, db, workspaceId, secondCancelId, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${secondCancelId}`)).toMatchObject({ status: "FAILED" });
    expect(operation()).toMatchObject({ status: "CANCELLED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("frees the workspace when the retried cancel fails and leaves the task INTERRUPTED but holding it", async () => {
    const { db, handler, workspaceId, operation, retry } = await stuckCancel();
    const secondCancelId = (await retry() as { cancelOperationId: string }).cancelOperationId;
    await finishOperation(handler, db, workspaceId, secondCancelId, "FAILED");
    // As today, a failed cancel marks the task INTERRUPTED without freeing the workspace.
    expect(operation()).toMatchObject({ status: "INTERRUPTED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ activeOperationId: operation().id });
    const logs: Array<Record<string, unknown>> = [];
    const later = new Date(Date.now() + STUCK_CANCEL_RETRY_MS + 60_000);
    // Issue 202, owner answer 3: only once the worker says it runs nothing.
    const busy = await sweepStuckCancels({ client: db, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId, compute: "alive", worker: "busy" }], later);
    expect(busy.failed).toEqual([operation().id]);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ activeOperationId: operation().id });
    logs.length = 0;
    const result = await sweepStuckCancels({ client: db, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId, compute: "alive", worker: "idle" }], later);
    expect(result.interrupted).toEqual([operation().id]);
    expect(operation()).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "worker-idle" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(logs).toEqual([{ event: "stuck_cancel.released", workspaceId, operationId: operation().id, reason: "worker-idle" }]);
  });
});

describe("a task's own late result after a failed cancel (issue 202)", () => {
  /** The task's own result callback, as its worker sends it, answered as the broker answers it. */
  async function ownResult(handler: Parameters<typeof call>[0], db: Parameters<typeof finishOperation>[1], workspaceId: string, operationId: string, status: string) {
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
    const capability = (outbox.invocation as { callbackCapability: string }).callbackCapability;
    return call(handler, {
      method: "POST",
      path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/result`,
      headers: { "x-agentx-callback-capability": capability },
      body: { operationId, status, result: { summary: "done" } },
    });
  }

  /** A thread's task whose member's first cancel failed: INTERRUPTED, still holding the workspace. */
  async function failedFirstCancel() {
    const broker = await stuckCancel({ claimed: false });
    await finishOperation(broker.handler, broker.db, broker.workspaceId, broker.firstCancelId, "FAILED");
    expect(broker.operation()).toMatchObject({ status: "INTERRUPTED" });
    expect(broker.db.get(`WORKSPACE#${broker.workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: broker.taskOperationId });
    return { ...broker, meta: () => broker.db.get(`WORKSPACE#${broker.workspaceId}`, "META")! };
  }

  it("frees the workspace, keeps the task INTERRUPTED, records own-result, and answers the worker without a conflict", async () => {
    const { db, handler, workspaceId, taskOperationId, operation, meta } = await failedFirstCancel();
    const response = await ownResult(handler, db, workspaceId, taskOperationId, "SUCCEEDED");
    expect(response.status).toBe(200);
    expect(response.body.operation).toMatchObject({ id: taskOperationId, status: "INTERRUPTED" });
    expect(operation()).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "own-result", error: FAILED_CANCEL_RELEASED_MESSAGE });
    expect(operation()).toHaveProperty("workspaceReleasedAt");
    // Results stay immutable: the late result is not stored.
    expect(operation().result).not.toEqual({ summary: "done" });
    expect(meta()).toMatchObject({ status: "READY" });
    expect(meta()).not.toHaveProperty("activeOperationId");
  });

  it("answers a repeat of that result the same way, and writes nothing more", async () => {
    const { db, handler, workspaceId, taskOperationId, operation } = await failedFirstCancel();
    await ownResult(handler, db, workspaceId, taskOperationId, "FAILED");
    const released = structuredClone(operation());
    const again = await ownResult(handler, db, workspaceId, taskOperationId, "FAILED");
    expect(again.status).toBe(200);
    expect(again.body.operation).toMatchObject({ id: taskOperationId, status: "INTERRUPTED" });
    expect(operation()).toEqual(released);
  });

  it("writes nothing, and still refuses it as today, for an INTERRUPTED task that no longer holds the workspace", async () => {
    const { db, handler, workspaceId, taskOperationId, operation, meta } = await failedFirstCancel();
    db.set({ ...meta(), status: "READY", activeOperationId: undefined });
    const before = structuredClone(operation());
    const response = await ownResult(handler, db, workspaceId, taskOperationId, "SUCCEEDED");
    expect(response.status).not.toBe(200);
    expect(JSON.stringify(response.body)).toContain("IDEMPOTENCY_CONFLICT");
    expect(operation()).toEqual(before);
    expect(meta()).toMatchObject({ status: "READY" });
  });

  it("never frees a workspace a newer operation holds, or one whose fence moved", async () => {
    for (const change of ["newer-operation", "new-fence"] as const) {
      const { db, handler, workspaceId, taskOperationId, operation, meta } = await failedFirstCancel();
      const newer = randomUUID();
      db.set(change === "newer-operation" ? { ...meta(), activeOperationId: newer } : { ...meta(), fence: (meta().fence as number) + 1 });
      const before = structuredClone(operation());
      const response = await ownResult(handler, db, workspaceId, taskOperationId, "SUCCEEDED");
      expect(JSON.stringify(response.body)).toContain("IDEMPOTENCY_CONFLICT");
      expect(operation()).toEqual(before);
      expect(meta()).toMatchObject({ status: "BUSY", activeOperationId: change === "newer-operation" ? newer : taskOperationId });
    }
  });

  it("answers a late result after the reconciler already freed the workspace without a conflict, and writes nothing", async () => {
    const { db, handler, workspaceId, taskOperationId, operation, meta } = await failedFirstCancel();
    const swept = await sweepStuckCancels({ client: db, tableName: "state" }, [{ workspaceId, compute: "gone" }], new Date());
    expect(swept.interrupted).toEqual([taskOperationId]);
    const released = structuredClone(operation());
    const response = await ownResult(handler, db, workspaceId, taskOperationId, "SUCCEEDED");
    expect(response.status).toBe(200);
    expect(response.body.operation).toMatchObject({ id: taskOperationId, status: "INTERRUPTED" });
    expect(operation()).toEqual(released);
    expect(operation()).toMatchObject({ workspaceReleaseReason: "compute-gone" });
    expect(meta()).not.toHaveProperty("activeOperationId");
  });

  it("frees an AI tool's developer task's workspace the same way", async () => {
    const { db, handler, workspaceId, taskOperationId, operation, meta } = await failedFirstCancel();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect((await ownResult(handler, db, workspaceId, taskOperationId, "SUCCEEDED")).status).toBe(200);
    expect(operation()).toMatchObject({ status: "INTERRUPTED", workspaceReleaseReason: "own-result" });
    expect(meta()).not.toHaveProperty("activeOperationId");
  });

  it("leaves other terminal results as they were: a cancelled task's late result is still refused", async () => {
    const { db, handler, workspaceId, taskOperationId, firstCancelId, operation } = await stuckCancel({ claimed: false });
    await finishOperation(handler, db, workspaceId, firstCancelId, "SUCCEEDED");
    expect(operation()).toMatchObject({ status: "CANCELLED" });
    const response = await ownResult(handler, db, workspaceId, taskOperationId, "SUCCEEDED");
    expect(JSON.stringify(response.body)).toContain("IDEMPOTENCY_CONFLICT");
    expect(operation()).not.toHaveProperty("workspaceReleasedAt");
  });
});
