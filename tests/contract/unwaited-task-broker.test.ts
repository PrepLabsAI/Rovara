// Issue 173: the broker's side of the reconciler backstop. The reconciler invokes the broker
// directly (never through API Gateway) with a workspace and operation; the broker checks again that
// the task is a Slack thread's coding task live past the limit with nobody waiting, and cancels it
// through requestCancellation, the cancel route's own path.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { UNWAITED_TASK_LIMIT_MS } from "../../packages/broker/src/aws/unwaited-tasks.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadTs = "1695500000.000001";
const subject = `${SLACK_TEAM}/${SLACK_CHANNEL}/${threadTs}`;
const pratik = "U0123456789";

beforeAll(async () => {
  await loadSlackBroker();
});

/** A bound thread whose workspace runs one coding task, started `age` milliseconds ago. */
async function runningTask(options: { age?: number; threadsTable?: boolean } = {}) {
  const broker = createBroker(options.threadsTable === false ? {} : { slackThreadsTableName: "threads" });
  await registerSlackProject(broker.handler);
  const workspaceId = (await ensureWorkspace(broker.handler, subject, pratik)).body.workspaceId as string;
  markReady(broker.db, workspaceId);
  const conversation = await serviceCall(broker.handler, subject, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
  const task = await serviceCall(broker.handler, subject, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
    requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run the tests",
  });
  expect(task.status).toBe(202);
  const operationId = (task.body.operation as { id: string }).id;
  const operation = broker.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
  operation.status = "RUNNING";
  operation.createdAt = new Date(Date.now() - (options.age ?? UNWAITED_TASK_LIMIT_MS + 60_000)).toISOString();
  return { ...broker, workspaceId, operationId, operation };
}

async function stopUnwaited(handler: ReturnType<typeof createBroker>["handler"], workspaceId: string, operationId: string) {
  const response = await handler({ source: "agentx.session-reconciler", action: "stop-unwaited-task", workspaceId, operationId });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

const cancels = (db: ReturnType<typeof createBroker>["db"], workspaceId: string) =>
  db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "cancel");

describe("the broker's unwaited task stop (#173)", () => {
  it("cancels a Slack thread's task live past the limit with no turn waiting, through the cancel path, and names the thread", async () => {
    const { db, handler, workspaceId, operationId } = await runningTask();
    const stopped = await stopUnwaited(handler, workspaceId, operationId);
    expect(stopped).toMatchObject({ status: 200, body: { outcome: "CANCEL_REQUESTED", thread: { channelId: SLACK_CHANNEL, threadTs } } });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    const cancelId = stopped.body.cancelOperationId as string;
    const cancel = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${cancelId}`);
    expect(cancel).toMatchObject({ kind: "cancel", status: "ACCEPTED", targetOperationId: operationId });
    // Nobody asked for it: the reconciler is no member of the thread.
    expect(cancel).not.toHaveProperty("requestedBy");
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === cancelId)[0];
    expect(outbox?.invocation).toMatchObject({ kind: "cancel", payload: { targetOperationId: operationId } });
  });

  it("cancels a task left alone only after the limit, never before", async () => {
    const young = await runningTask({ age: UNWAITED_TASK_LIMIT_MS - 60_000 });
    expect((await stopUnwaited(young.handler, young.workspaceId, young.operationId)).body).toMatchObject({ outcome: "SKIPPED" });
    expect(young.operation.status).toBe("RUNNING");
    expect(cancels(young.db, young.workspaceId)).toHaveLength(0);
  });

  it("never cancels a task a turn is waiting on (the thread's activeTurn names it)", async () => {
    const { db, handler, workspaceId, operationId, operation } = await runningTask();
    db.set({ pk: `THREAD#${subject}`, sk: "META", workspaceId, activeTurn: { eventId: "Ev0123", workspaceId, operationId } });
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "SKIPPED", reason: "waited-on" });
    expect(operation.status).toBe("RUNNING");
    expect(cancels(db, workspaceId)).toHaveLength(0);
  });

  it("never cancels when the thread's activeTurn cannot be read, in case it names the task", async () => {
    const { db, handler, workspaceId, operationId, operation } = await runningTask();
    db.set({ pk: `THREAD#${subject}`, sk: "META", workspaceId, activeTurn: { eventId: "Ev0123" } });
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "SKIPPED" });
    expect(operation.status).toBe("RUNNING");
  });

  it("cancels when the thread's activeTurn names another operation", async () => {
    const { db, handler, workspaceId, operationId } = await runningTask();
    db.set({ pk: `THREAD#${subject}`, sk: "META", workspaceId, activeTurn: { eventId: "Ev0123", workspaceId, operationId: randomUUID() } });
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "CANCEL_REQUESTED" });
  });

  it("never cancels a task started from an AI tool (an MCP developer task)", async () => {
    const pointed = await runningTask();
    pointed.db.set({ pk: `WORKSPACE#${pointed.workspaceId}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() });
    expect((await stopUnwaited(pointed.handler, pointed.workspaceId, pointed.operationId)).body).toMatchObject({ outcome: "SKIPPED", reason: "developer-task" });
    expect(pointed.operation.status).toBe("RUNNING");

    const requested = await runningTask();
    requested.operation.requestedBy = { kind: "developer", developerId: "a".repeat(64), provider: "slack" };
    expect((await stopUnwaited(requested.handler, requested.workspaceId, requested.operationId)).body).toMatchObject({ outcome: "SKIPPED" });
    expect(requested.operation.status).toBe("RUNNING");
  });

  it("never touches a task already asked to cancel, so a second stop queues nothing more", async () => {
    const { db, handler, workspaceId, operationId } = await runningTask();
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "SKIPPED" });
    expect(cancels(db, workspaceId)).toHaveLength(1);
  });

  it("never touches a finished task, another kind of operation, or one that no longer owns its workspace", async () => {
    const finished = await runningTask();
    finished.operation.status = "SUCCEEDED";
    expect((await stopUnwaited(finished.handler, finished.workspaceId, finished.operationId)).body).toMatchObject({ outcome: "SKIPPED" });

    const publish = await runningTask();
    publish.operation.kind = "publish";
    expect((await stopUnwaited(publish.handler, publish.workspaceId, publish.operationId)).body).toMatchObject({ outcome: "SKIPPED" });
    expect(publish.operation.status).toBe("RUNNING");

    const released = await runningTask();
    released.db.get(`WORKSPACE#${released.workspaceId}`, "META")!.activeOperationId = randomUUID();
    expect((await stopUnwaited(released.handler, released.workspaceId, released.operationId)).body).toMatchObject({ outcome: "SKIPPED" });
    expect(released.operation.status).toBe("RUNNING");
  });

  it("never cancels a workspace no Slack thread owns", async () => {
    const { db, handler, workspaceId, operationId, operation } = await runningTask();
    const thread = db.find((item) => item.entityType === "SLACK_THREAD")[0]!;
    delete thread.thread;
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "SKIPPED", reason: "not-a-slack-thread" });
    expect(operation.status).toBe("RUNNING");
  });

  it("refuses where the broker cannot read the Slack threads table (the legacy deployment)", async () => {
    const { handler, workspaceId, operationId, operation } = await runningTask({ threadsTable: false });
    const refused = await stopUnwaited(handler, workspaceId, operationId);
    expect(refused.status).toBe(404);
    expect(operation.status).toBe("RUNNING");
  });

  it("never takes the internal path for a request that came through API Gateway", async () => {
    const { handler, workspaceId, operationId, operation } = await runningTask();
    const response = await handler({
      source: "agentx.session-reconciler", action: "stop-unwaited-task", workspaceId, operationId,
      version: "2.0", rawPath: "/v1/anything", headers: {}, requestContext: { requestId: "r", http: { method: "POST" } },
    });
    expect(response.statusCode).not.toBe(200);
    expect(operation.status).toBe("RUNNING");
  });

  it("never overwrites a task that finished while the cancel was being written, and queues no cancel (review I3)", async () => {
    const { db, handler, workspaceId, operationId, operation } = await runningTask();
    const original = db.send;
    db.send = async (command) => {
      // The task's own result lands just before the cancel's transaction.
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) operation.status = "SUCCEEDED";
      return original(command);
    };
    expect((await stopUnwaited(handler, workspaceId, operationId)).body).toMatchObject({ outcome: "SKIPPED", reason: "finished" });
    expect(operation.status).toBe("SUCCEEDED");
    expect(cancels(db, workspaceId)).toHaveLength(0);
  });

  it("queues one cancel when a member's stop lands between the check and the cancel, and names no thread to note (review I3)", async () => {
    const { db, handler, workspaceId, operationId, operation } = await runningTask();
    const original = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) operation.status = "CANCEL_REQUESTED";
      return original(command);
    };
    const answer = await stopUnwaited(handler, workspaceId, operationId);
    expect(answer.body).not.toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(cancels(db, workspaceId)).toHaveLength(0);
  });
});

