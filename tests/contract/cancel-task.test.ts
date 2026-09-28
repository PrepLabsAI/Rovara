import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";
const bob = "U0456789012";
const slackThread = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000001" };

beforeAll(async () => {
  await loadSlackBroker();
});

/** A bound thread whose workspace is running one coding task. */
async function runningTask() {
  const broker = createBroker();
  await registerSlackProject(broker.handler);
  const workspaceId = (await ensureWorkspace(broker.handler, thread, pratik)).body.workspaceId as string;
  markReady(broker.db, workspaceId);
  const conversation = await serviceCall(broker.handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
  const task = await serviceCall(broker.handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
    requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run the tests",
  });
  expect(task.status).toBe(202);
  const taskOperationId = (task.body.operation as { id: string }).id;
  return { ...broker, workspaceId, taskOperationId };
}

async function stopEvent(handler: ReturnType<typeof createBroker>["handler"], userId = bob, threadValue: unknown = slackThread) {
  const response = await (handler)({
    source: "agentx.slack-ingress", action: "stop-task", thread: threadValue, userId,
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

describe("the Slack stop command, in the broker (#126)", () => {
  it("cancels the thread's running task for any member of the channel", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const stopped = await stopEvent(handler);
    expect(stopped).toMatchObject({ status: 200, body: { outcome: "CANCEL_REQUESTED", workspaceId, targetOperationId: taskOperationId } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    const cancelId = stopped.body.cancelOperationId as string;
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${cancelId}`)).toMatchObject({
      kind: "cancel", status: "ACCEPTED", requestedBy: { teamId: SLACK_TEAM, userId: bob },
    });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === cancelId)[0];
    expect(outbox?.invocation).toMatchObject({ kind: "cancel", payload: { targetOperationId: taskOperationId } });
  });

  it("does nothing more for a second stop, or for a thread with nothing running", async () => {
    const { handler } = await runningTask();
    await stopEvent(handler);
    expect((await stopEvent(handler)).body).toMatchObject({ outcome: "NOTHING_RUNNING" });

    const idle = createBroker();
    await registerSlackProject(idle.handler);
    const idleStop = (await stopEvent(idle.handler)).body;
    expect(idleStop).toMatchObject({ outcome: "NOTHING_RUNNING" });
    expect(idleStop).not.toHaveProperty("workspaceId");
  });

  it("refuses a thread in an unbound channel", async () => {
    const { handler } = await runningTask();
    const refused = await stopEvent(handler, bob, { ...slackThread, channelId: "C0999999999" });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
  });

  it("never takes the internal path for a request that came through API Gateway", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const response = await (handler as unknown as (event: unknown) => Promise<{ statusCode: number }>)({
      source: "agentx.slack-ingress", action: "stop-task", thread: slackThread, userId: bob,
      version: "2.0", rawPath: "/v1/anything", headers: {}, requestContext: { requestId: "r", http: { method: "POST" } },
    });
    expect(response.statusCode).not.toBe(200);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).not.toMatchObject({ status: "CANCEL_REQUESTED" });
  });
});

describe("an administrator cancelling a task (#126)", () => {
  it("cancels any workspace's running task, and only for an administrator", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const path = `/v1/admin/workspaces/${workspaceId}/cancel`;
    const denied = await call(handler, { method: "POST", path, user: { subject: "not-an-admin" } });
    expect(denied.status).toBe(403);
    const cancelled = await call(handler, { method: "POST", path, user: { subject: "admin-subject", admin: true } });
    expect(cancelled).toMatchObject({ status: 202, body: { outcome: "CANCEL_REQUESTED", targetOperationId: taskOperationId } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    const again = await call(handler, { method: "POST", path, user: { subject: "admin-subject", admin: true } });
    expect(again.body).toMatchObject({ outcome: "NOTHING_RUNNING" });
  });
});
