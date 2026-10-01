// Spec 025 Task 11: continue, cancel and pull requests on a developer task, and the completed audit
// records (FR-016, FR-021, FR-023, FR-037, R12, R16, R17, US1 scenarios 4 and 5).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { SLACK_CHANNEL, call } from "../support/slack-broker.js";

const said = (text: string) => ({ type: "progress", payload: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } } });

async function finished(
  status: "SUCCEEDED" | "FAILED" = "SUCCEEDED",
  options: Parameters<typeof createDeveloperTaskBroker>[0] = {},
  setup: (handler: Parameters<typeof call>[0]) => Promise<void> = async () => {},
) {
  const harness = await createDeveloperTaskBroker(options);
  await setup(harness.handler);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the flaky retry test", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; conversationId: string };
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  const prepareId = active();
  await harness.finish(task.workspaceId, prepareId, "SUCCEEDED");
  const firstTaskId = active();
  await harness.events(task.workspaceId, firstTaskId, [said("Fixed: the test used a real clock.")]);
  await harness.finish(task.workspaceId, firstTaskId, status, status === "FAILED" ? { error: "tests failed" } : {});
  const post = (route: string, body: unknown) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/${route}`, body);
  const turns = () => harness.db.find((item) => item.pk === `TASK#${taskId}`);
  return { ...harness, taskId, task, prepareId, firstTaskId, active, post, turns };
}

describe("continue (US1 scenario 5, FR-019)", () => {
  it("runs the new instructions unchanged in the same workspace and conversation", async () => {
    const { db, post, task, active, turns } = await finished();
    const requestId = randomUUID();
    const response = await post("continue", { requestId, instructions: "Now add a test for the timeout path." });
    expect(response.body.task).toMatchObject({ status: "RUNNING" });
    const operation = db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${active()}`);
    expect(operation).toMatchObject({ kind: "task", conversationId: task.conversationId, requestId, requestedBy: { kind: "developer" } });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === active())[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe("Now add a test for the timeout path.");
    expect(turns().filter((item) => item.action === "continue" && item.phase === "accepted")).toHaveLength(1);
    expect((await post("continue", { requestId, instructions: "Now add a test for the timeout path." })).body.task).toMatchObject({ status: "RUNNING" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "task")).toHaveLength(2);
  });

  it("keeps the starting revision when the project has a newer one", async () => {
    const { db, handler, post, task } = await finished();
    await registerRevision(handler, 2, [{ name: "demo" }]);
    await post("continue", { requestId: randomUUID(), instructions: "more" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ projectRevision: 1 });
  });

  it("answers TASK_BUSY while the task runs, naming what to do", async () => {
    const { post } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "one" });
    const busy = await post("continue", { requestId: randomUUID(), instructions: "two" });
    expect(busy.body.error).toMatchObject({ code: "TASK_BUSY" });
    expect(String((busy.body.error as { message: string }).message)).toContain("agentx_wait_for_task");
    expect(String((busy.body.error as { message: string }).message)).toContain("agentx_cancel_task");
  });

  it("gives two concurrent continues one RUNNING and one TASK_BUSY, and one new task operation", async () => {
    const { db, post, task, turns } = await finished();
    const answers = await Promise.all([
      post("continue", { requestId: randomUUID(), instructions: "one" }),
      post("continue", { requestId: randomUUID(), instructions: "two" }),
    ]);
    expect(answers.filter((answer) => (answer.body.task as { status?: string } | undefined)?.status === "RUNNING")).toHaveLength(1);
    expect(answers.filter((answer) => (answer.body.error as { code?: string } | undefined)?.code === "TASK_BUSY")).toHaveLength(1);
    // The first task and one continue.
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "task")).toHaveLength(2);
    expect(turns().filter((item) => item.action === "continue" && item.phase === "accepted")).toHaveLength(1);
  });

  it("refuses a task that never started (R17)", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "npm ci exited 1" });
    const refused = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "retry" });
    expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "this task never started; close it with agentx_close_task and start a new one" });
  });

  it("refuses a task whose setup failed for want of a worker too (R17), not as TASK_BUSY", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "RUNTIME_UNAVAILABLE: no capacity" });
    for (const [route, body] of [["continue", { requestId: randomUUID(), instructions: "retry" }], ["pull-requests", { requestId: randomUUID(), title: "x" }]] as const) {
      const refused = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/${route}`, body);
      expect(refused.body.error).toEqual({ code: "CONFIG_INVALID", message: "this task never started; close it with agentx_close_task and start a new one" });
    }
  });

  it("lets a developer who lost channel access continue and open a PR on their own task (R11, spec edge case)", async () => {
    let member = true;
    const channelMembers = async (request: ChannelMembersRequest): Promise<ChannelMembersResponse> => ({ ok: true, memberOf: member ? request.channelIds.filter((id) => id === SLACK_CHANNEL) : [] });
    const { post, turns, finish, task, active } = await finished("SUCCEEDED", { channelMembers });
    member = false;
    const continued = await post("continue", { requestId: randomUUID(), instructions: "more" });
    expect(continued.status).toBe(200);
    expect(continued.body.task).toMatchObject({ status: "RUNNING" });
    await finish(task.workspaceId, active(), "SUCCEEDED");
    const opened = await post("pull-requests", { requestId: randomUUID(), title: "x" });
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ operationStatus: "ACCEPTED" });
    expect(turns().filter((item) => (item.action === "continue" || item.action === "pull_request") && item.phase === "accepted")).toHaveLength(2);
  });

  it("refuses to cancel a closed task, as continue does, and writes no audit record (final review M2)", async () => {
    const { db, post, taskId, turns } = await finished();
    (db.get(`DEVTASK#${taskId}`, "META") as { closedAt?: string }).closedAt = new Date().toISOString();
    const before = turns().length;
    expect((await post("cancel", { requestId: randomUUID() })).body.error).toEqual({ code: "CONFIG_INVALID", message: "this task is closed; start a new one with agentx_start_task" });
    expect(turns()).toHaveLength(before);
    expect(turns().filter((item) => item.action === "cancel")).toHaveLength(0);
  });

  it("refuses to cancel a task whose workspace is closed, with no audit record (final review M2)", async () => {
    const { db, post, task, turns } = await finished();
    Object.assign(db.get(`WORKSPACE#${task.workspaceId}`, "META")!, { status: "CLOSED", closedAt: new Date().toISOString() });
    expect((await post("cancel", { requestId: randomUUID() })).body.error).toEqual({ code: "CONFIG_INVALID", message: "this task is closed; start a new one with agentx_start_task" });
    expect(turns().filter((item) => item.action === "cancel")).toHaveLength(0);
  });

  it("refuses a closed task", async () => {
    const { db, post, taskId } = await finished();
    (db.get(`DEVTASK#${taskId}`, "META") as { closedAt?: string }).closedAt = new Date().toISOString();
    expect((await post("continue", { requestId: randomUUID(), instructions: "more" })).body.error).toEqual({ code: "CONFIG_INVALID", message: "this task is closed; start a new one with agentx_start_task" });
    expect((await post("pull-requests", { requestId: randomUUID(), title: "x" })).body.error).toEqual({ code: "CONFIG_INVALID", message: "this task is closed; start a new one with agentx_start_task" });
  });

  it("redacts a secret in the instructions from the accepted record but sends them unchanged to the worker", async () => {
    const planted = "xoxb-2222222222-planted-secret";
    const { db, post, active, turns } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: `use ${planted}` });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === active())[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe(`use ${planted}`);
    expect(JSON.stringify(turns())).not.toContain(planted);
  });
});

describe("cancel", () => {
  it("before the instructions run, removes them, and the task reads CANCELLED (R16)", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const cancelled = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(cancelled.body.task).toMatchObject({ status: "CANCELLED" });
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, "DEVELOPER_TASK")).toMatchObject({ cancelledAt: expect.any(String) as string });
    expect(harness.db.find((item) => item.pk === `TASK#${taskId}` && item.action === "cancel")).toHaveLength(1);
  });

  it("before the instructions run, touches only the pointer, never the workspace or the prepare (P45)", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const workspace = structuredClone(harness.db.get(`WORKSPACE#${workspaceId}`, "META"));
    const prepareId = String((workspace as { activeOperationId: string }).activeOperationId);
    const prepare = structuredClone(harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`));
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toEqual(workspace);
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${prepareId}`)).toEqual(prepare);
    expect(harness.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toHaveLength(0);
    // The prepare's result then queues nothing.
    await harness.finish(workspaceId, prepareId, "SUCCEEDED");
    expect(harness.db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(0);
    expect((await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CANCELLED" });
  });

  it("while it runs, asks the worker to stop, and the task reads CANCELLED once the worker says so", async () => {
    const { db, post, task, active, finish, taskId, dev } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const running = active();
    await post("cancel", { requestId: randomUUID() });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${running}`)).toMatchObject({ status: "CANCEL_REQUESTED" });
    const cancelOperation = db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")[0]!;
    await finish(task.workspaceId, String(cancelOperation.id), "SUCCEEDED");
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CANCELLED" });
  });

  it("with nothing running, answers with the task as it is", async () => {
    const { post } = await finished();
    expect((await post("cancel", { requestId: randomUUID() })).body.task).toMatchObject({ status: "SUCCEEDED" });
  });

  it("keeps the final status of a turn that finishes just before the cancel is written, and queues no cancel (#196)", async () => {
    const { db, post, task, active, turns } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const running = active();
    // The turn's result lands between the cancel's read and its write; the fake evaluates the real condition.
    const original = db.send;
    db.send = async (command) => {
      if (command.constructor.name === "TransactWriteCommand" && JSON.stringify(command.input).includes("\"CANCEL_REQUESTED\"")) {
        db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${running}`)!.status = "SUCCEEDED";
      }
      return original(command);
    };
    const response = await post("cancel", { requestId: randomUUID() });
    expect(response.body.task).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${running}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toHaveLength(0);
    expect(turns().filter((item) => item.action === "cancel")).toEqual([expect.objectContaining({ responseText: "Nothing was running." })]);
  });

  it("repeated with the same requestId returns the task and writes nothing more (F14)", async () => {
    // Nothing running.
    const idle = await finished();
    const idleRequest = randomUUID();
    await idle.post("cancel", { requestId: idleRequest });
    const idleCount = idle.db.find(() => true).length;
    expect((await idle.post("cancel", { requestId: idleRequest })).body.task).toMatchObject({ status: "SUCCEEDED" });
    expect(idle.db.find(() => true)).toHaveLength(idleCount);
    expect(idle.turns().filter((item) => item.action === "cancel")).toHaveLength(1);

    // While it runs.
    const busy = await finished();
    await busy.post("continue", { requestId: randomUUID(), instructions: "long job" });
    const busyRequest = randomUUID();
    await busy.post("cancel", { requestId: busyRequest });
    const busyCount = busy.db.find(() => true).length;
    expect((await busy.post("cancel", { requestId: busyRequest })).body.task).toMatchObject({ status: "RUNNING" });
    expect(busy.db.find(() => true)).toHaveLength(busyCount);
    expect(busy.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toHaveLength(1);
    expect(busy.turns().filter((item) => item.action === "cancel")).toHaveLength(1);

    // Before the instructions run.
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const startingRequest = randomUUID();
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: startingRequest });
    const startingCount = harness.db.find(() => true).length;
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: startingRequest })).body.task).toMatchObject({ status: "CANCELLED" });
    expect(harness.db.find(() => true)).toHaveLength(startingCount);
  });

  it("answers a concurrent duplicate cancel with the task, writing one cancel", async () => {
    const { db, post, turns } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const requestId = randomUUID();
    const answers = await Promise.all([post("cancel", { requestId }), post("cancel", { requestId })]);
    for (const answer of answers) expect(answer.body.task).toMatchObject({ status: "RUNNING" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "OUTBOX" && (item.invocation as { kind?: string } | undefined)?.kind === "cancel")).toHaveLength(1);
    expect(turns().filter((item) => item.action === "cancel")).toHaveLength(1);
  });

  it("answers a cancel that met a changing task in plain words, naming the tool, with the code kept", async () => {
    const { db, post, task, active } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    // The running operation's fence moved on, so the cancel's transaction fails its condition.
    (db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${active()}`) as { fence: number }).fence += 1;
    const response = await post("cancel", { requestId: randomUUID() });
    expect(response.body.error).toEqual({ code: "WORKSPACE_BUSY", message: "the task changed while cancelling; try agentx_cancel_task again" });
  });

  it("refuses a requestId already used for another action of the task", async () => {
    const { post } = await finished();
    const requestId = randomUUID();
    await post("continue", { requestId, instructions: "one" });
    expect((await post("cancel", { requestId })).body.error).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("writes each accepted record in the cancel's own transaction, with the cancel operation", async () => {
    const { post, turns, db } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    await post("cancel", { requestId: randomUUID() });
    const cancelOperation = db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")[0]!;
    expect(turns().filter((item) => item.action === "cancel")).toEqual([expect.objectContaining({ phase: "accepted", operationId: cancelOperation.id, responseText: "Asked the worker to stop." })]);
  });
});

describe("pull requests (US1 scenario 4, FR-023)", () => {
  it("opens a draft on the only repository through the publication path, with the developer footer", async () => {
    const { db, post, task, turns } = await finished();
    const requestId = randomUUID();
    const response = await post("pull-requests", { requestId, title: "Fix the flaky retry test", body: "Uses a fake clock." });
    expect(response.body).toMatchObject({ operationStatus: "ACCEPTED", task: { status: "RUNNING" } });
    const operationId = String(response.body.operationId);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({
      kind: "publish",
      publication: { repository: "demo", draft: true, body: "Uses a fake clock.\n\n---\nRequested by `Maya Chen` via AgentX, started from Claude Code" },
    });
    expect(turns().filter((item) => item.action === "pull_request" && item.phase === "accepted")).toHaveLength(1);
    const again = await post("pull-requests", { requestId, title: "Fix the flaky retry test", body: "Uses a fake clock." });
    expect(again.body.operationId).toBe(operationId);
    expect(turns().filter((item) => item.action === "pull_request")).toHaveLength(1);
  });

  it("passes draft: false on to the publication", async () => {
    const { db, post, task } = await finished();
    const response = await post("pull-requests", { requestId: randomUUID(), title: "Ready", draft: false });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${String(response.body.operationId)}`)).toMatchObject({ publication: { draft: false } });
  });

  it("returns the pull request, and records it once, after the worker publishes it", async () => {
    const { db, post, task, turns, finish } = await finished();
    const requestId = randomUUID();
    const operationId = String((await post("pull-requests", { requestId, title: "Fix" })).body.operationId);
    const operation = db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${operationId}`) as { publication: { headBranch: string } };
    const url = "https://github.com/example/demo/pull/7";
    await finish(task.workspaceId, operationId, "SUCCEEDED", {
      result: { repository: "demo", number: 7, url, headBranch: operation.publication.headBranch, baseBranch: "main", commit: "a".repeat(40), checks: [], reconciled: false },
    });
    const again = await post("pull-requests", { requestId, title: "Fix" });
    expect(again.body).toMatchObject({ operationId, operationStatus: "SUCCEEDED", pullRequest: { repository: "demo", number: 7, url, state: "open" } });
    expect(turns().filter((item) => item.action === "pull_request" && item.phase === "completed")).toEqual([
      expect.objectContaining({ outcome: "succeeded", operationId, responseText: `Pull request ${url}` }),
    ]);
  });

  it("asks for the repository when the task's own revision has several", async () => {
    // Changed from the brief (controller ruling): the list comes from the revision the task is
    // pinned to and publishes from, so the revision with two repositories is registered first.
    const { post, db, taskId } = await finished("SUCCEEDED", {}, (handler) => registerRevision(handler, 2, [{ name: "demo" }, { name: "docs" }]));
    expect(db.get(`DEVTASK#${taskId}`, "META")).toMatchObject({ startingRevision: 2 });
    const response = await post("pull-requests", { requestId: randomUUID(), title: "x" });
    expect(response.body.error).toEqual({ code: "CONFIG_INVALID", message: "this project has several repositories; name one of: demo, docs" });
  });

  it("does not list a repository a newer revision added: the task publishes from its own", async () => {
    const { db, handler, post, task } = await finished();
    await registerRevision(handler, 2, [{ name: "demo" }, { name: "docs" }]);
    const response = await post("pull-requests", { requestId: randomUUID(), title: "x" });
    expect(response.body).toMatchObject({ operationStatus: "ACCEPTED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${String(response.body.operationId)}`)).toMatchObject({ publication: { repository: "demo" } });
  });

  it("says so when the task's own project revision is no longer registered", async () => {
    const { db, post } = await finished();
    for (const [key, item] of db.items) if (item.pk === "PROJECT#payments" && item.sk === `REV#${String(1).padStart(12, "0")}`) db.items.delete(key);
    expect((await post("pull-requests", { requestId: randomUUID(), title: "x" })).body.error).toEqual({ code: "CONFIG_INVALID", message: "this task's project revision is no longer registered; ask an admin" });
  });

  it("answers a repeated requestId after the task closed with the closed-task error", async () => {
    const { db, post, taskId } = await finished();
    const requestId = randomUUID();
    await post("pull-requests", { requestId, title: "x" });
    (db.get(`DEVTASK#${taskId}`, "META") as { closedAt?: string }).closedAt = new Date().toISOString();
    expect((await post("pull-requests", { requestId, title: "x" })).body.error).toEqual({ code: "CONFIG_INVALID", message: "this task is closed; start a new one with agentx_start_task" });
  });

  it("answers TASK_BUSY while the task runs", async () => {
    const { post } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "one" });
    expect((await post("pull-requests", { requestId: randomUUID(), title: "x" })).body.error).toMatchObject({ code: "TASK_BUSY" });
  });
});

describe("completed audit records (R12, FR-037)", () => {
  it("records the result summary when a task operation ends, once, keyed by the operation", async () => {
    const { turns, finish, task, firstTaskId } = await finished();
    const completed = turns().filter((item) => item.phase === "completed");
    expect(completed).toEqual([expect.objectContaining({ action: "start", outcome: "succeeded", operationId: firstTaskId, responseText: "Fixed: the test used a real clock." })]);
    await finish(task.workspaceId, firstTaskId, "SUCCEEDED");
    expect(turns().filter((item) => item.phase === "completed")).toHaveLength(1);
  });

  it("records a failure with its outcome", async () => {
    const { turns } = await finished("FAILED");
    expect(turns().filter((item) => item.phase === "completed")).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  it("records a continue's result as a continue", async () => {
    const { post, turns, finish, task, active } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "more" });
    const running = active();
    await finish(task.workspaceId, running, "SUCCEEDED");
    expect(turns().filter((item) => item.phase === "completed" && item.operationId === running)).toEqual([expect.objectContaining({ action: "continue", outcome: "succeeded" })]);
  });

  it("keeps a cancelled task's completed record, written with the cancel's result, once (F13)", async () => {
    const { db, post, turns, finish, task, active } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const running = active();
    await post("cancel", { requestId: randomUUID() });
    const cancelOperation = db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")[0]!;
    await finish(task.workspaceId, String(cancelOperation.id), "SUCCEEDED");
    const completed = () => turns().filter((item) => item.phase === "completed" && item.operationId === running);
    expect(completed()).toEqual([expect.objectContaining({ action: "continue", outcome: "cancelled" })]);
    // The task's own result, arriving after, changes nothing.
    await finish(task.workspaceId, running, "CANCELLED");
    expect(completed()).toHaveLength(1);
    // The cancel operation itself has no completed record: it is not a task or publish.
    expect(turns().filter((item) => item.operationId === cancelOperation.id && item.phase === "completed")).toHaveLength(0);
  });

  it("logs a completed record it cannot build with the task ID and error name, and records neither it nor the result", async () => {
    const { db, post, finish, task, active, taskId, turns } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "more" });
    const running = active();
    // A client name the turn record schema refuses (at most 40 characters).
    (db.get(`DEVTASK#${taskId}`, "META") as { client: string }).client = "x".repeat(41);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { lines.push(String(line)); });
    try {
      await expect(finish(task.workspaceId, running, "SUCCEEDED")).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    const logged = lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).find((entry) => entry.event === "developer.completed_turn_failed");
    expect(logged).toMatchObject({ taskId, operationId: running, error: "ZodError" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${running}`)).toMatchObject({ status: "ACCEPTED" });
    expect(turns().filter((item) => item.phase === "completed" && item.operationId === running)).toHaveLength(0);
  });

  it("records the cancel's result when the target finished first, with the target's one completed record", async () => {
    const { db, post, turns, finish, task, active } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const running = active();
    await post("cancel", { requestId: randomUUID() });
    const cancelOperation = db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")[0]!;
    await finish(task.workspaceId, running, "SUCCEEDED");
    await finish(task.workspaceId, String(cancelOperation.id), "SUCCEEDED");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${String(cancelOperation.id)}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${running}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(turns().filter((item) => item.phase === "completed" && item.operationId === running)).toEqual([expect.objectContaining({ outcome: "succeeded" })]);
  });

  it("records a task the cancel could not stop cleanly as interrupted (F13)", async () => {
    const { db, post, turns, finish, task, active } = await finished();
    await post("continue", { requestId: randomUUID(), instructions: "long job" });
    const running = active();
    await post("cancel", { requestId: randomUUID() });
    const cancelOperation = db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")[0]!;
    await finish(task.workspaceId, String(cancelOperation.id), "FAILED", { error: "worker did not stop" });
    expect(turns().filter((item) => item.phase === "completed" && item.operationId === running)).toEqual([expect.objectContaining({ outcome: "interrupted" })]);
  });
});

async function registerRevision(handler: Parameters<typeof call>[0], revision: number, repositories: Array<{ name: string }>) {
  const response = await call(handler, {
    method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
    body: {
      definition: {
        name: "payments", revision,
        repositories: repositories.map((repository) => ({ name: repository.name, url: `https://github.com/example/${repository.name}.git`, path: `repo/${repository.name}`, defaultBranch: "main", credentialRef: "github-app" })),
        setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
      },
      runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" },
    },
  });
  if (response.status !== 201) throw new Error(`registration failed: ${JSON.stringify(response.body)}`);
}
