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

/**
 * Final review I2: the cancel is being written when its target's own result lands first
 * ("finished"), or when something else changed the target meanwhile ("changed").
 */
function raceTheCancel(db: ReturnType<typeof createBroker>["db"], workspaceId: string, taskOperationId: string, mode: "finished" | "changed") {
  const original = db.send;
  let raced = 0;
  db.send = async (command) => {
    if (raced === 0 && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) {
      raced += 1;
      if (mode === "finished") db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)!.status = "SUCCEEDED";
      throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] });
    }
    return original(command);
  };
  return () => raced;
}

const cancelOperations = (db: ReturnType<typeof createBroker>["db"], workspaceId: string) =>
  db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "cancel");

describe("the cancel routes when the cancel races its target (final review I2)", () => {
  it("the owner route answers 202 duplicate with the finished target operation, and writes no cancel", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const raced = raceTheCancel(db, workspaceId, taskOperationId, "finished");
    const answer = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/operations/${taskOperationId}/cancel`);
    expect(raced()).toBe(1);
    expect(answer).toMatchObject({ status: 202, body: { duplicate: true, operation: { id: taskOperationId, kind: "task", status: "SUCCEEDED" } } });
    expect(cancelOperations(db, workspaceId)).toHaveLength(0);
  });

  it("the owner route answers WORKSPACE_BUSY when the target is still live but changed meanwhile", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const raced = raceTheCancel(db, workspaceId, taskOperationId, "changed");
    const answer = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/operations/${taskOperationId}/cancel`);
    expect(raced()).toBe(1);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.body).toMatchObject({ error: { code: "WORKSPACE_BUSY" } });
    expect(String((answer.body.error as { message: string }).message)).toContain("try again");
    expect(cancelOperations(db, workspaceId)).toHaveLength(0);
  });

  it("the Slack stop reads a finished target as nothing running, never as a cancel it made", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    raceTheCancel(db, workspaceId, taskOperationId, "finished");
    const stopped = await stopEvent(handler);
    expect(stopped).toMatchObject({ status: 200, body: { outcome: "NOTHING_RUNNING", workspaceId } });
    expect(stopped.body).not.toHaveProperty("cancelOperationId");
  });

  it("the Slack stop fails with WORKSPACE_BUSY when the target changed, so the ingress says to try again", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    raceTheCancel(db, workspaceId, taskOperationId, "changed");
    const stopped = await stopEvent(handler);
    expect(stopped.status).not.toBe(200);
    expect(stopped.body).toMatchObject({ error: { code: "WORKSPACE_BUSY" } });
  });

  it("the administrator cancel reads a finished target as nothing running, and a changed one as WORKSPACE_BUSY", async () => {
    const finished = await runningTask();
    raceTheCancel(finished.db, finished.workspaceId, finished.taskOperationId, "finished");
    const path = (workspaceId: string) => `/v1/admin/workspaces/${workspaceId}/cancel`;
    const nothing = await call(finished.handler, { method: "POST", path: path(finished.workspaceId), user: { subject: "admin-subject", admin: true } });
    expect(nothing).toMatchObject({ status: 202, body: { outcome: "NOTHING_RUNNING", workspaceId: finished.workspaceId } });
    expect(nothing.body).not.toHaveProperty("cancelOperationId");

    const changed = await runningTask();
    raceTheCancel(changed.db, changed.workspaceId, changed.taskOperationId, "changed");
    const busy = await call(changed.handler, { method: "POST", path: path(changed.workspaceId), user: { subject: "admin-subject", admin: true } });
    expect(busy.body).toMatchObject({ error: { code: "WORKSPACE_BUSY" } });
  });
});

describe("a repeated owner cancel (#173 review: the shared cancel path is unchanged for its callers)", () => {
  it("still queues a fresh cancel for a target already CANCEL_REQUESTED, so a cancel whose dispatch was lost can be sent again", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const path = `/v1/service/workspaces/${workspaceId}/operations/${taskOperationId}/cancel`;
    expect((await serviceCall(handler, thread, pratik, "POST", path)).status).toBe(202);
    const again = await serviceCall(handler, thread, pratik, "POST", path);
    expect(again).toMatchObject({ status: 202, body: { duplicate: false, operation: { kind: "cancel" } } });
    expect(cancelOperations(db, workspaceId)).toHaveLength(2);
  });
});

/**
 * Issue 196: the task's own result lands between the cancel's read of its target and the cancel's
 * write. Nothing is faked about the write: the fake DynamoDB evaluates the cancel's real condition
 * against the target as it now stands.
 */
function finishJustBeforeTheCancelWrite(
  db: ReturnType<typeof createBroker>["db"], workspaceId: string, taskOperationId: string, status: "SUCCEEDED" | "FAILED",
) {
  const original = db.send;
  let finished = 0;
  db.send = async (command) => {
    if (finished === 0 && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) {
      finished += 1;
      db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)!.status = status;
    }
    return original(command);
  };
  return () => finished;
}

const cancelOutbox = (db: ReturnType<typeof createBroker>["db"]) =>
  db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "cancel");

describe("a task that finishes just before the cancel is written (#196)", () => {
  it("the owner route keeps the task's final status, answers already finished with it, and queues no cancel", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const finished = finishJustBeforeTheCancelWrite(db, workspaceId, taskOperationId, "SUCCEEDED");
    const answer = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/operations/${taskOperationId}/cancel`);
    expect(finished()).toBe(1);
    expect(answer).toMatchObject({ status: 202, body: { duplicate: true, operation: { id: taskOperationId, kind: "task", status: "SUCCEEDED" } } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(cancelOperations(db, workspaceId)).toHaveLength(0);
    expect(cancelOutbox(db)).toHaveLength(0);
  });

  it("the Slack stop keeps a failed task FAILED, reads it as nothing running, and queues no cancel", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const finished = finishJustBeforeTheCancelWrite(db, workspaceId, taskOperationId, "FAILED");
    const stopped = await stopEvent(handler);
    expect(finished()).toBe(1);
    expect(stopped).toMatchObject({ status: 200, body: { outcome: "NOTHING_RUNNING", workspaceId } });
    expect(stopped.body).not.toHaveProperty("cancelOperationId");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).toMatchObject({ status: "FAILED" });
    expect(cancelOperations(db, workspaceId)).toHaveLength(0);
    expect(cancelOutbox(db)).toHaveLength(0);
  });

  it("the administrator cancel keeps the final status and names it, so the CLI can say the task already finished", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const finished = finishJustBeforeTheCancelWrite(db, workspaceId, taskOperationId, "SUCCEEDED");
    const answer = await call(handler, { method: "POST", path: `/v1/admin/workspaces/${workspaceId}/cancel`, user: { subject: "admin-subject", admin: true } });
    expect(finished()).toBe(1);
    expect(answer).toMatchObject({ status: 202, body: { outcome: "NOTHING_RUNNING", workspaceId, finishedStatus: "SUCCEEDED" } });
    expect(answer.body).not.toHaveProperty("cancelOperationId");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(cancelOperations(db, workspaceId)).toHaveLength(0);
    expect(cancelOutbox(db)).toHaveLength(0);
  });

  it("the administrator cancel names the final status too when the task had finished before the cancel read it", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    // The result is recorded but the workspace still names the task as its active operation.
    db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)!.status = "FAILED";
    const answer = await call(handler, { method: "POST", path: `/v1/admin/workspaces/${workspaceId}/cancel`, user: { subject: "admin-subject", admin: true } });
    expect(answer).toMatchObject({ status: 202, body: { outcome: "NOTHING_RUNNING", workspaceId, finishedStatus: "FAILED" } });
    expect(cancelOperations(db, workspaceId)).toHaveLength(0);
  });

  it("a task still running is cancelled as before", async () => {
    const { db, handler, workspaceId, taskOperationId } = await runningTask();
    const answer = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/operations/${taskOperationId}/cancel`);
    expect(answer).toMatchObject({ status: 202, body: { duplicate: false, operation: { kind: "cancel" } } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${taskOperationId}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    expect(cancelOperations(db, workspaceId)).toHaveLength(1);
    expect(cancelOutbox(db)).toHaveLength(1);
  });
});
