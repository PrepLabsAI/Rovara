// tests/contract/stuck-cancel-broker.test.ts
// Issue 195: the reconciler asks the broker to queue a stuck cancel again, once. The broker checks
// everything again and queues it through the cancel route's own path.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, finishOperation, loadSlackBroker, markReady, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";
import { STUCK_CANCEL_RETRY_MS, sweepStuckCancels } from "../../packages/broker/src/aws/stuck-cancels.js";

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
  const retry = async (fields: Record<string, unknown> = {}) => {
    const response = await broker.handler({ source: "agentx.session-reconciler", action: "retry-stuck-cancel", workspaceId, operationId: taskOperationId, ...fields });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { ...broker, workspaceId, taskOperationId, firstCancelId, operation, cancels, retry };
}

describe("the stuck-cancel retry, in the broker (issue 195)", () => {
  it("queues a fresh cancel for the task through the cancel path", async () => {
    const { db, workspaceId, taskOperationId, firstCancelId, operation, cancels, retry } = await stuckCancel();
    const retried = await retry();
    expect(retried).toMatchObject({ status: 200, body: { outcome: "REQUEUED" } });
    const cancelId = retried.body.cancelOperationId as string;
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

  it("queues nothing unless the reconciler recorded the retry first", async () => {
    const { cancels, retry } = await stuckCancel({ claimed: false });
    expect(await retry()).toMatchObject({ status: 200, body: { outcome: "SKIPPED", reason: "not-claimed" } });
    expect(cancels()).toHaveLength(1);
  });

  it("queues nothing for a task that is no longer CANCEL_REQUESTED", async () => {
    const { db, operation, cancels, retry } = await stuckCancel();
    db.set({ ...operation(), status: "CANCELLED" });
    expect(await retry()).toMatchObject({ status: 200, body: { outcome: "SKIPPED", reason: "not-cancel-requested" } });
    expect(cancels()).toHaveLength(1);
  });

  it("queues nothing for an operation that no longer holds the workspace", async () => {
    const { db, workspaceId, cancels, retry } = await stuckCancel();
    db.set({ ...db.get(`WORKSPACE#${workspaceId}`, "META")!, activeOperationId: randomUUID() });
    expect(await retry()).toMatchObject({ status: 200, body: { outcome: "SKIPPED", reason: "not-active" } });
    expect(cancels()).toHaveLength(1);
  });

  it("never retries an AI tool's developer task", async () => {
    const { db, workspaceId, cancels, retry } = await stuckCancel();
    db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect(await retry()).toMatchObject({ status: 200, body: { outcome: "SKIPPED", reason: "developer-task" } });
    expect(cancels()).toHaveLength(1);
  });

  it("refuses IDs that are not UUIDs", async () => {
    const { cancels, retry } = await stuckCancel();
    expect(await retry({ operationId: "../x" })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect(cancels()).toHaveLength(1);
  });

  it("never takes the internal path for a request that came through API Gateway", async () => {
    const { cancels, retry } = await stuckCancel();
    const response = await retry({ version: "2.0", rawPath: "/v1/anything", headers: {}, requestContext: { requestId: "r", http: { method: "POST" } } });
    expect(response.status).not.toBe(200);
    expect(cancels()).toHaveLength(1);
  });
});

describe("the retried cancel's result (issue 195)", () => {
  it("never turns a task the first cancel already ended into INTERRUPTED", async () => {
    const { db, handler, workspaceId, taskOperationId, firstCancelId, operation, retry } = await stuckCancel();
    const secondCancelId = (await retry()).body.cancelOperationId as string;
    await finishOperation(handler, db, workspaceId, firstCancelId, "SUCCEEDED");
    expect(operation()).toMatchObject({ status: "CANCELLED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    // The worker no longer knows the task, so the retried cancel fails.
    await finishOperation(handler, db, workspaceId, secondCancelId, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${secondCancelId}`)).toMatchObject({ status: "FAILED" });
    expect(operation()).toMatchObject({ status: "CANCELLED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(taskOperationId).toBeDefined();
  });

  it("frees the workspace when the retried cancel fails and leaves the task INTERRUPTED but holding it", async () => {
    const { db, handler, workspaceId, operation, retry } = await stuckCancel();
    const secondCancelId = (await retry()).body.cancelOperationId as string;
    await finishOperation(handler, db, workspaceId, secondCancelId, "FAILED");
    // As today, a failed cancel marks the task INTERRUPTED without freeing the workspace.
    expect(operation()).toMatchObject({ status: "INTERRUPTED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ activeOperationId: operation().id });
    const logs: Array<Record<string, unknown>> = [];
    const later = new Date(Date.now() + STUCK_CANCEL_RETRY_MS + 60_000);
    const result = await sweepStuckCancels({ client: db, tableName: "state", log: (entry) => { logs.push(entry); } }, [{ workspaceId, compute: "alive" }], later);
    expect(result.interrupted).toEqual([operation().id]);
    expect(operation()).toMatchObject({ status: "INTERRUPTED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(logs).toEqual([{ event: "stuck_cancel.released", workspaceId, operationId: operation().id }]);
  });
});
