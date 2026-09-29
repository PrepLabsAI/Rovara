import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { STUCK_SETUP_MESSAGE, sweepStuckSetups } from "../../packages/broker/src/aws/stuck-setup.js";
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

  it("queues nothing when the prepare fails, and clears the raw instructions (controller ruling)", async () => {
    const { db, finish, task, taskId, prepareId, taskOperations } = await started();
    await finish(task.workspaceId, prepareId, "FAILED", { error: "npm ci exited 1" });
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).toMatchObject({ taskId });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED" });
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
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("attribute_exists(pendingPrompt)")) queueAttempts += 1;
      return original(command);
    };
    const results = await Promise.allSettled([finish(task.workspaceId, prepareId, "SUCCEEDED"), finish(task.workspaceId, prepareId, "SUCCEEDED")]);
    expect(queueAttempts).toBe(2); // both callbacks got as far as trying to queue the task
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: taskOperations()[0]?.id });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("retries the decision once when the queuing transaction meets a transaction in flight", async () => {
    const { db, finish, task, prepareId, taskOperations, taskOutbox } = await started();
    const original = db.send;
    let conflicts = 0;
    db.send = async (command) => {
      if (conflicts === 0 && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("attribute_exists(pendingPrompt)")) {
        conflicts += 1;
        const items = (command.input as { TransactItems: unknown[] }).TransactItems;
        throw Object.assign(new Error("Transaction cancelled"), {
          name: "TransactionCanceledException",
          CancellationReasons: items.map((_, index) => ({ Code: index === 0 ? "TransactionConflict" : "None" })),
        });
      }
      return original(command);
    };
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(conflicts).toBe(1);
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "BUSY", activeOperationId: taskOperations()[0]?.id });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
  });

  it("records the prepare as FAILED when the project's latest revision cannot be read, so close frees the slot (final review I1)", async () => {
    const harness = await started();
    const { db, finish, task, taskId, prepareId, taskOperations, dev } = harness;
    const original = db.send;
    let failedReads = 0;
    db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("PROJECT#payments") && JSON.stringify(command.input).includes("REV#")) {
        failedReads += 1;
        throw Object.assign(new Error("The table does not exist"), { name: "ResourceNotFoundException" });
      }
      return original(command);
    };
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await finish(task.workspaceId, prepareId, "SUCCEEDED");
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({
        component: "broker", event: "developer.first_task_queue_failed", taskId, operationId: prepareId, error: "ResourceNotFoundException",
      }));
    } finally {
      db.send = original;
      logged.mockRestore();
    }
    expect(failedReads).toBeGreaterThan(0);
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).not.toHaveProperty("pendingPrompt");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED" });
    // A repeated SUCCEEDED callback from the worker is answered, not refused.
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    const read = await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`);
    expect(read.body).toMatchObject({ task: { status: "FAILED", failure: { category: "setup_failed" } } });
    const closed = await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it.each([
    ["ThrottlingException", {}],
    ["ProvisionedThroughputExceededException", {}],
    ["InternalServerError", { $metadata: { httpStatusCode: 500 } }],
  ])("answers a retryable %s with 503 and records nothing, so the worker's next try queues the first task (FR-055, C19)", async (name, extra) => {
    const { db, finish, task, prepareId, taskOperations, taskOutbox } = await started();
    const original = db.send;
    let failedReads = 0;
    db.send = async (command) => {
      if (failedReads === 0 && command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("REV#")) {
        failedReads += 1;
        throw Object.assign(new Error("try again later"), { name, ...extra });
      }
      return original(command);
    };
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(finish(task.workspaceId, prepareId, "SUCCEEDED")).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "developer.first_task_queue_retry", operationId: prepareId, error: name }));
    } finally {
      db.send = original;
      logged.mockRestore();
    }
    expect(failedReads).toBe(1);
    // Nothing was recorded: the prepare still runs, and the instructions still wait.
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).not.toMatchObject({ status: "FAILED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARING", activeOperationId: prepareId });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "DEVELOPER_TASK")).toHaveProperty("pendingPrompt");
    // The worker's next try queues the first task.
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(1);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "BUSY" });
    // A further repeat is answered and queues nothing more; the member is charged once.
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1 });
  });

  it("answers a temporary error from the queuing write with 503, and the next try queues the task once (FR-055, C19)", async () => {
    const { db, finish, task, prepareId, taskOperations, taskOutbox } = await started();
    const original = db.send;
    let failedWrites = 0;
    db.send = async (command) => {
      if (failedWrites === 0 && command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("OUTBOX")) {
        failedWrites += 1;
        throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      }
      return original(command);
    };
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(finish(task.workspaceId, prepareId, "SUCCEEDED")).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual(expect.objectContaining({ event: "developer.first_task_queue_retry", operationId: prepareId, error: "ThrottlingException" }));
    } finally {
      db.send = original;
      logged.mockRestore();
    }
    expect(failedWrites).toBe(1);
    expect(taskOperations()).toHaveLength(0);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "PREPARING", activeOperationId: prepareId });
    await finish(task.workspaceId, prepareId, "SUCCEEDED");
    expect(taskOperations()).toHaveLength(1);
    expect(taskOutbox()).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 1 });
  });

  it("leaves a prepare whose every try met a temporary error to the stuck-setup sweep (D21)", async () => {
    const { db, finish, task, prepareId, taskOperations } = await started();
    const original = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "QueryCommand" && JSON.stringify(command.input).includes("REV#")) throw Object.assign(new Error("slow down"), { name: "ThrottlingException" });
      return original(command);
    };
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) await expect(finish(task.workspaceId, prepareId, "SUCCEEDED")).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
    } finally {
      db.send = original;
      logged.mockRestore();
    }
    expect(await sweepStuckSetups(db, "state", new Date(Date.now() + 51 * 60_000))).toMatchObject({ failed: [task.workspaceId] });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${prepareId}`)).toMatchObject({ status: "FAILED", error: STUCK_SETUP_MESSAGE });
    expect(taskOperations()).toHaveLength(0);
  });

  it("a Slack thread's failed prepare creates no developer task pointer", async () => {
    const { db, handler, finish } = await createDeveloperTaskBroker();
    const thread = await ensureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`, "U0PRATIK01");
    const workspaceId = String(thread.body.workspaceId);
    await finish(workspaceId, String(thread.body.operationId), "FAILED", { error: "npm ci exited 1" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "DEVELOPER_TASK")).toBeUndefined();
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
