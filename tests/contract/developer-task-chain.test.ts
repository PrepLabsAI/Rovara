import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveTaskStatus, type OperationFacts } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

async function started(instructions = "Fix the flaky retry test") {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions, client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; conversationId: string };
  const prepareId = String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const taskOperations = () => harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "task");
  const taskOutbox = () => harness.db.find((item) => item.entityType === "OUTBOX" && item.workspaceId === task.workspaceId && (item.invocation as { kind: string }).kind === "task");
  return { ...harness, taskId, task, prepareId, taskOperations, taskOutbox };
}

describe("the first task is queued by the prepare's result (R3, FR-018)", () => {
  it("moves the workspace to BUSY with the task operation in the same transaction", async () => {
    const instructions = "Fix the flaky retry test\n\nexactly as written \u00e9  ";
    const { db, finish, task, prepareId, taskOperations, taskOutbox } = await started(instructions);
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    const [operation] = taskOperations();
    expect(operation).toMatchObject({ status: "ACCEPTED", conversationId: task.conversationId, requestedBy: { kind: "developer", developerId: MAYA.developerId, provider: "slack" } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: operation?.id, preparationManifest: ".agentx/preparation-manifest.json" });
    const [outbox] = taskOutbox();
    expect((outbox?.invocation as { payload: { prompt: string; conversationStarted: boolean } }).payload).toMatchObject({ prompt: instructions, conversationStarted: false });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("a repeated prepare result queues the first task once (Review Focus 1)", async () => {
    const { finish, task, prepareId, taskOperations, taskOutbox } = await started();
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
  });

  it("queues nothing when the prepare fails, and keeps the instructions for the record", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    await finish(task.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).toHaveProperty("pendingPrompt");
  });

  it("queues nothing when the task was cancelled before its instructions ran (R16)", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const pointer = db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")!;
    delete pointer.pendingPrompt;
    pointer.cancelledAt = new Date().toISOString();
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("still records the prepare when a cancel lands between the read and the write", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const original = db.send;
    let raced = false;
    db.send = async (command) => {
      // The cancel lands just before the result's transaction is committed.
      if (!raced && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("REMOVE pendingPrompt")) {
        raced = true;
        const pointer = db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")!;
        delete pointer.pendingPrompt;
        pointer.cancelledAt = new Date().toISOString();
      }
      return original(command);
    };
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(raced).toBe(true);
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("two prepare results racing each other queue the first task once", async () => {
    const { db, finish, task, prepareId, taskOperations, taskOutbox } = await started();
    const original = db.send;
    let queueAttempts = 0;
    db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("REMOVE pendingPrompt")) queueAttempts += 1;
      return original(command);
    };
    const results = await Promise.allSettled([finish(task.workspaceId, prepareId, "SUCCEEDED"), finish(task.workspaceId, prepareId, "SUCCEEDED")]);
    expect(queueAttempts).toBe(2); // both callbacks got as far as trying to queue the task
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
  });

  it("leaves each outcome in the state R4 reads: RUNNING, setup_failed or CANCELLED", async () => {
    const derived = (harness: Awaited<ReturnType<typeof started>>) => deriveTaskStatus({
      workspaceStatus: String((harness.db.get(`WORKSPACE#${harness.task.workspaceId}`, "META") as { status: string }).status),
      pointer: harness.db.get(`WORKSPACE#${harness.task.workspaceId}`, "DEVELOPER_TASK"),
      operations: harness.db.find((item) => item.entityType === "OPERATION" && item.workspaceId === harness.task.workspaceId) as unknown as OperationFacts[],
    });
    const succeeded = await started();
    await succeeded.finish(succeeded.task.workspaceId, succeeded.prepareId, "SUCCEEDED");
    expect(derived(succeeded)).toMatchObject({ status: "RUNNING", current: { id: succeeded.taskOperations()[0]?.id } });
    const failed = await started();
    await failed.finish(failed.task.workspaceId, failed.prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(derived(failed)).toMatchObject({ status: "FAILED", failure: { category: "setup_failed", message: "npm ci exited 1" } });
    const cancelled = await started();
    const pointer = cancelled.db.get(`WORKSPACE#${cancelled.task.workspaceId}`, "DEVELOPER_TASK")!;
    delete pointer.pendingPrompt;
    pointer.cancelledAt = new Date().toISOString();
    await cancelled.finish(cancelled.task.workspaceId, cancelled.prepareId, "SUCCEEDED");
    expect(derived(cancelled)).toMatchObject({ status: "CANCELLED" });
  });

  it("leaves a Slack thread's prepare as it was: READY, nothing queued", async () => {
    const { db, handler, finish } = await createDeveloperTaskBroker();
    const thread = await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`, "U0PRATIK01");
    const workspaceId = String(thread.body.workspaceId);
    await finish(workspaceId, String(thread.body.operationId), "SUCCEEDED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId && item.kind === "task")).toHaveLength(0);
  });
});
