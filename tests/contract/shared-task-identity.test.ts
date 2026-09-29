// tests/contract/shared-task-identity.test.ts
// Spec 025 FR-054, C11, C13, C14: a shared thread's service calls, resolved by the broker.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAYA, createDeveloperTaskBroker, markThreadPosted, teammate } from "../support/developer-task-broker.js";
import { SLACK_TEAM, loadSlackBroker } from "../support/slack-broker.js";

const PRIYA = "U0PRIYA001";
/** Every broker answer carries the request's requestId beside the result's own fields: the result alone. */
function result(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId, ...rest } = body;
  expect(typeof requestId).toBe("string");
  return rest;
}

/** What a Slack service from before 25c sends, and what this release's service sends. */
const OLDER_REQUEST = { includeIntegrations: true, includeSettingsRevision: true, includeConnectors: true, includeAllConnectorTypes: true, includeRecoverableOperations: true, lazyPreparation: true, includeActionPolicy: true };
const WORKSPACE_REQUEST = { ...OLDER_REQUEST, includeSharedTask: true };

async function continueThread(mode: "view" | "continue" = "continue") {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code", shareToChannel: true, shareMode: mode });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const workspaceId = (harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string }).workspaceId;
  const active = () => (harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string | null }).activeOperationId;
  await harness.finish(workspaceId, String(active()), "SUCCEEDED");
  await harness.finish(workspaceId, String(active()), "SUCCEEDED");
  const subject = markThreadPosted(harness.db, taskId);
  const ensure = (body: Record<string, unknown> = WORKSPACE_REQUEST) => teammate(harness.handler, subject, PRIYA, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), ...body });
  const workspaces = () => harness.db.find((item) => item.entityType === "WORKSPACE").length;
  return { ...harness, taskId, workspaceId, subject, active, ensure, workspaces };
}

async function channelTask(h: Awaited<ReturnType<typeof continueThread>>, name?: string) {
  const conversation = await teammate(h.handler, h.subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {}, name);
  const conversationId = String((conversation.body.conversation as { id: string }).id);
  return teammate(h.handler, h.subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "run the linter" }, name);
}

function threadOf(subject: string) {
  return Object.fromEntries(["teamId", "channelId", "threadTs"].map((key, index) => [key, subject.split("/")[index]]));
}

describe("an ordinary thread beside a shared one (characterization, C23)", () => {
  it("still gets its own thread workspace, charged to the member, and ignores the includeSharedTask opt-in", async () => {
    const h = await continueThread();
    const other = `${SLACK_TEAM}/${h.subject.split("/")[1]}/1695500000.000900`;
    const before = h.workspaces();
    const answer = await teammate(h.handler, other, PRIYA, "POST", "/v1/service/threads/workspace", { requestId: randomUUID(), ...WORKSPACE_REQUEST });
    expect(answer.body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", created: true });
    expect(answer.body).not.toHaveProperty("sharedTask");
    expect(answer.body.workspaceId).not.toBe(h.workspaceId);
    expect(h.workspaces()).toBe(before + 1);
    // Its conversations stay its own: the shared task's workspace is out of its reach.
    expect((await teammate(h.handler, other, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {})).status).toBe(404);
    const stop = await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: threadOf(other), userId: PRIYA });
    expect(JSON.parse(stop.body)).toMatchObject({ outcome: "NOTHING_RUNNING" });
  });
});

describe("a continue thread acts on the task's workspace (FR-054)", () => {
  it("answers the task's workspace: never created, never charged, nothing to recover", async () => {
    const h = await continueThread();
    const before = h.workspaces();
    const answer = await h.ensure();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "WORKSPACE", workspaceId: h.workspaceId, status: "READY", created: false, recoverableOperations: [], sharedTask: { taskId: h.taskId, developerName: "Maya Chen" } });
    expect(h.workspaces()).toBe(before);
    expect(h.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${PRIYA}`)).toBeUndefined();
  });

  it("runs the teammate's request as the teammate, and records who started it (C13)", async () => {
    const h = await continueThread();
    const accepted = await channelTask(h, "Priya");
    expect(accepted.status).toBe(202);
    const operationId = String((accepted.body.operation as { id: string }).id);
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ kind: "task", requestedBy: { teamId: SLACK_TEAM, userId: PRIYA } });
    expect(h.db.get(`DEVTASK#${h.taskId}`, `CHANNEL_OPERATION#${operationId}`)).toMatchObject({ slackUserId: PRIYA, name: "Priya" });
  });

  it("writes no AI-tool completed record under the developer's name when a teammate's operation ends (F3)", async () => {
    const h = await continueThread();
    const accepted = await channelTask(h, "Priya");
    const operationId = String((accepted.body.operation as { id: string }).id);
    await h.finish(h.workspaceId, operationId, "SUCCEEDED");
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${operationId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(h.db.find((item) => item.pk === `TASK#${h.taskId}` && item.operationId === operationId)).toEqual([]);
    // The developer's own operations still get theirs.
    expect(h.db.find((item) => item.pk === `TASK#${h.taskId}` && item.phase === "completed").length).toBeGreaterThan(0);
  });

  it("keeps a WORKSPACE answer strict for a Slack service that does not ask for sharedTask", async () => {
    const h = await continueThread();
    expect((await h.ensure(OLDER_REQUEST)).body).not.toHaveProperty("sharedTask");
  });
});

describe("a thread that is not open to the channel (C11, Review Focus 2)", () => {
  it("answers VIEW_ONLY and creates nothing once the thread is view only", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/share`, { requestId: randomUUID(), shareMode: "view" });
    const before = h.workspaces();
    expect(result((await h.ensure()).body)).toEqual({ outcome: "VIEW_ONLY", taskId: h.taskId, closed: false });
    expect((await h.ensure(OLDER_REQUEST)).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(h.workspaces()).toBe(before);
    // The thread's own key owns no workspace, so the task's is out of reach.
    expect((await teammate(h.handler, h.subject, PRIYA, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {})).status).toBe(404);
  });

  it("says closed once the task is closed", async () => {
    const h = await continueThread();
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, closedAt: new Date().toISOString() });
    expect(result((await h.ensure()).body)).toEqual({ outcome: "VIEW_ONLY", taskId: h.taskId, closed: true });
  });

  it("treats a thread whose channel now serves another project as view only", async () => {
    const h = await continueThread();
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, project: "ledger" });
    expect((await h.ensure()).body).toMatchObject({ outcome: "VIEW_ONLY" });
  });

  it("refuses to close the task from the thread: only the developer closes it", async () => {
    const h = await continueThread();
    expect(result((await teammate(h.handler, h.subject, PRIYA, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID(), includeSharedTask: true })).body)).toEqual({ outcome: "REFUSED", reason: "shared_task" });
    expect((await teammate(h.handler, h.subject, PRIYA, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect((await teammate(h.handler, h.subject, PRIYA, "POST", "/v1/service/threads/workspace/close/complete", { requestId: randomUUID(), operationId: randomUUID() })).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(h.db.get(`WORKSPACE#${h.workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("fails closed on a shared record it cannot read", async () => {
    const h = await continueThread();
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, ownerKey: "0".repeat(64) });
    const before = h.workspaces();
    expect((await h.ensure()).body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(h.workspaces()).toBe(before);
  });
});

describe("stop in a shared thread (Q8)", () => {
  it("cancels the running task operation from a continue thread, and nothing from a view-only one", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "keep going" });
    const stop = async () => JSON.parse((await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: threadOf(h.subject), userId: PRIYA })).body) as { outcome: string };
    expect(await stop()).toMatchObject({ outcome: "CANCEL_REQUESTED" });
    expect(h.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toEqual([expect.objectContaining({ requestedBy: { teamId: SLACK_TEAM, userId: PRIYA } })]);
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, mode: "view" });
    expect(await stop()).toMatchObject({ outcome: "NOTHING_RUNNING" });
  });

  it("stops nothing when the channel now serves another project (F16)", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "keep going" });
    h.db.set({ ...h.db.get(`SHARED_TASK#${h.subject}`, "META")!, project: "ledger" });
    const response = await h.handler({ source: "agentx.slack-ingress", action: "stop-task", thread: threadOf(h.subject), userId: PRIYA });
    expect(JSON.parse(response.body)).toMatchObject({ outcome: "NOTHING_RUNNING" });
    expect(h.db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toEqual([]);
  });
});

describe("the developer meets a channel turn (C14, D4)", () => {
  it("answers TASK_BUSY naming the teammate and the waiting messages, for continue and for a pull request", async () => {
    const h = await continueThread();
    await channelTask(h, "Priya");
    h.db.set({ pk: `THREAD#${h.subject}`, sk: "META", pendingRequests: 3 });
    const continued = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "also this" });
    expect(continued.body.error).toMatchObject({ code: "TASK_BUSY" });
    const message = String((continued.body.error as { message: string }).message);
    expect(message).toContain("a request from Priya in its shared Slack thread");
    // F18: the running turn may already have answered, so the count is a floor.
    expect(message).toContain("at least 2 more channel messages are waiting");
    expect(message).toContain("agentx_share_task");
    const pr = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/pull-requests`, { requestId: randomUUID(), title: "t" });
    expect(String((pr.body.error as { message: string }).message)).toContain("Priya");
  });

  it("gives no count when the thread's pending messages may be only the running turn (F18)", async () => {
    const h = await continueThread();
    await channelTask(h);
    for (const [pending, expected] of [[1, undefined], [2, "at least 1 more channel message is waiting"]] as const) {
      h.db.set({ pk: `THREAD#${h.subject}`, sk: "META", pendingRequests: pending });
      const message = String(((await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "x" })).body.error as { message: string }).message);
      expect(message).toContain(`a request from Slack user ${PRIYA} in its shared Slack thread`);
      if (expected === undefined) expect(message).not.toContain("waiting");
      else expect(message).toContain(expected);
    }
  });

  it("reads the waiting count from the Slack threads table, and gives none without one (C14 wiring)", async () => {
    const h = await continueThread();
    const accepted = await channelTask(h, "Priya");
    const operationId = String((accepted.body.operation as { id: string }).id);
    h.db.set({ pk: `THREAD#${h.subject}`, sk: "META", pendingRequests: 4 });
    const reads: Array<Record<string, unknown>> = [];
    const send = h.db.send;
    h.db.send = async (command) => {
      if (command.constructor.name === "GetCommand") reads.push({ TableName: command.input.TableName, Key: command.input.Key });
      return send(command);
    };
    expect(await h.actions.channelActivity({ taskId: h.taskId, operationId, threadSubject: h.subject })).toEqual({ driver: { slackUserId: PRIYA, name: "Priya" }, waiting: 3 });
    expect(reads).toContainEqual({ TableName: "threads", Key: { pk: `THREAD#${h.subject}`, sk: "META" } });
    const module = await loadSlackBroker() as unknown as { createDeveloperTaskActions: (input: never) => typeof h.actions };
    const legacy: Record<string, unknown> = { ...h.brokerInput };
    delete legacy.slackThreadsTableName;
    expect(await module.createDeveloperTaskActions(legacy as never).channelActivity({ taskId: h.taskId, operationId, threadSubject: h.subject })).toEqual({ driver: { slackUserId: PRIYA, name: "Priya" }, waiting: 0 });
    // An operation no teammate started names no driver.
    expect(await h.actions.channelActivity({ taskId: h.taskId, operationId: randomUUID(), threadSubject: h.subject })).toEqual({ waiting: 0 });
  });

  it("keeps 25b's TASK_BUSY words when the running operation is the developer's own", async () => {
    const h = await continueThread();
    await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "first" });
    const again = await h.dev(MAYA, "POST", `/v1/dev/tasks/${h.taskId}/continue`, { requestId: randomUUID(), instructions: "second" });
    expect((again.body.error as { message: string }).message).toBe(`task ${h.taskId} is still working; wait for it with agentx_wait_for_task, or stop it with agentx_cancel_task`);
  });
});
