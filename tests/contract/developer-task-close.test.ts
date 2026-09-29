// Spec 025 Task 12: closing a developer task (FR-016, FR-030, R6, R15, R22, owner decisions 5 and 6).
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { agentXError } from "@agentx/contracts";
import { finishTaskClose } from "../../packages/broker/src/aws/developer-tasks.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

async function finished(options: { memberLimit?: number } = {}) {
  const harness = await createDeveloperTaskBroker(options);
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix it", client: "claude-code" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string; createdAt: string };
  const active = () => String((harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
  await harness.finish(task.workspaceId, active(), "SUCCEEDED");
  await harness.finish(task.workspaceId, active(), "SUCCEEDED");
  const close = (requestId: string) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId });
  const member = () => harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`);
  return { ...harness, taskId, task, active, close, member };
}

/** A task whose setup failed: its workspace is PREPARATION_FAILED and it still holds its slot. */
async function setupFailed() {
  const harness = await createDeveloperTaskBroker();
  const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
  const taskId = (response.body.task as { taskId: string }).taskId;
  const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
  await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "npm ci exited 1" });
  const close = (requestId: string = randomUUID()) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId });
  return { ...harness, taskId, workspaceId, close };
}

const SAFE = { result: { safeToClose: true, repositories: [] } };
const organization = (db: FakeDynamoDb) => db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION");

describe("closing a task (R15)", () => {
  it("runs the preflight, then finishes the close itself: compute deleted, workspace CLOSED, counters released", async () => {
    const { db, close, task, taskId, active, finish, deleteEc2Session, member, dev } = await finished();
    const requestId = randomUUID();
    const started = await close(requestId);
    expect(started.body).toMatchObject({ closed: false, task: { closing: true } });
    const closeId = active();
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${closeId}`)).toMatchObject({ kind: "close", requestedBy: { kind: "developer" } });
    await finish(task.workspaceId, closeId, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(deleteEc2Session).toHaveBeenCalledWith(task.workspaceId);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(member()).toMatchObject({ count: 0 });
    expect(member()).not.toHaveProperty("tasks");
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
    expect(db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
    expect(db.get(`DEVELOPER#${MAYA.developerId}`, `TASK#${task.createdAt}#${taskId}`)).toMatchObject({ status: "CLOSED" });
    expect((await close(requestId)).body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CLOSED" });
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close")).toHaveLength(1);
  });

  it("keeps the task when the preflight finds unpublished work, and says which", async () => {
    const { db, close, task, active, finish, member } = await finished();
    const requestId = randomUUID();
    await close(requestId);
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes"] }] } });
    expect((await close(requestId)).body).toMatchObject({ closed: false, unpublished: [{ repository: "demo", reasons: ["worktree_changes"] }], task: { status: "SUCCEEDED" } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(member()).toMatchObject({ count: 1 });
  });

  it("shows the refused close on the task itself, so the AI tool can check back with agentx_get_task (R22)", async () => {
    const { dev, close, task, taskId, active, finish } = await finished();
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }] } });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "SUCCEEDED", unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }] });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).not.toHaveProperty("closing");
  });

  it("closes a task that never started at once", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "npm ci exited 1" });
    const closed = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 0 });
    expect(organization(harness.db)).toMatchObject({ count: 0 });
  });

  it("answers TASK_BUSY while the task is still starting", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() })).body.error).toMatchObject({ code: "TASK_BUSY" });
  });

  it("finishes a close on the next read when the first completion failed", async () => {
    const { db, close, task, taskId, active, finish, deleteEc2Session, dev } = await finished();
    deleteEc2Session!.mockRejectedValueOnce(Object.assign(new Error("starting"), { name: "AgentXError" }));
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CLOSED" });
  });

  it("releases the counter it charged even when the developer's Slack link changed since (R6)", async () => {
    const { db, close, task, active, finish, member } = await finished();
    (db.get(`DEVELOPER#${MAYA.developerId}`, "META") as Record<string, unknown>).slackUserId = "U0MAYANEW";
    const requestId = randomUUID();
    await close(requestId);
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(member()).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYANEW")).toBeUndefined();
  });

  it("frees the slot for a new task", async () => {
    const { close, task, active, finish, dev } = await finished({ memberLimit: 1 });
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "next" })).status).toBe(200);
  });
});

describe("closing a task: repeats, races and audit records (R12, R15)", () => {
  it("answers a fresh request_id while the close is in flight with the same close, not TASK_BUSY, and writes no record", async () => {
    const { db, close, taskId, task, active } = await finished();
    await close(randomUUID());
    const closeId = active();
    const again = await close(randomUUID());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ closed: false, task: { closing: true } });
    expect(db.find((item) => item.entityType === "OPERATION" && item.workspaceId === task.workspaceId && item.kind === "close")).toHaveLength(1);
    expect(active()).toBe(closeId);
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close")).toHaveLength(1);
  });

  it("answers a fresh request_id after the close with the closed task and writes nothing", async () => {
    const { db, close, taskId, task, active, finish, member } = await finished();
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect((await close(randomUUID())).body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close")).toHaveLength(1);
    expect(member()).toMatchObject({ count: 0 });
  });

  it("starts a new preflight for a fresh request_id after a refused close, and closes once the work is published", async () => {
    const { db, close, taskId, task, active, finish, member } = await finished();
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }] } });
    const second = await close(randomUUID());
    expect(second.body).toMatchObject({ closed: false, task: { closing: true } });
    expect(second.body).not.toHaveProperty("unpublished");
    expect(second.body.task).not.toHaveProperty("unpublished");
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(member()).toMatchObject({ count: 0 });
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close")).toHaveLength(2);
  });

  it("answers continue and pull requests on a closing task with the closing message, not TASK_BUSY", async () => {
    const { dev, taskId, close } = await finished();
    await close(randomUUID());
    const closing = { code: "CONFIG_INVALID", message: "this task is closing; check it with agentx_get_task, and if the close is refused for unpublished work you can continue it" };
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" })).body.error).toEqual(closing);
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/pull-requests`, { requestId: randomUUID(), title: "x" })).body.error).toEqual(closing);
  });

  it("answers TASK_BUSY while a turn runs, naming what to do", async () => {
    const { dev, taskId, close } = await finished();
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" });
    const busy = await close(randomUUID());
    expect(busy.body.error).toMatchObject({ code: "TASK_BUSY" });
    expect(String((busy.body.error as { message: string }).message)).toContain("agentx_cancel_task");
  });

  it("writes one accepted close record for a task that never started, and none on a repeat (ruling F15)", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    await harness.finish(workspaceId, String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId), "FAILED", { error: "npm ci exited 1" });
    const requestId = randomUUID();
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId });
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId });
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    const records = harness.db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ phase: "accepted", outcome: "accepted" });
    expect(harness.db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`)).toMatchObject({ count: 0 });
    expect(organization(harness.db)).toMatchObject({ count: 0 });
  });

  it("releases the counters exactly once when two completions race (a lost race is not an error)", async () => {
    const { db, close, taskId, task, active, finish, member, actions, deleteEc2Session } = await finished();
    const stale = structuredClone(db.get(`DEVTASK#${taskId}`, "META")) as DeveloperTaskRecord;
    await close(randomUUID());
    const closeId = active();
    await finish(task.workspaceId, closeId, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(member()).toMatchObject({ count: 0 });
    const calls = deleteEc2Session!.mock.calls.length;
    // A second completion that read the task before the first one landed.
    await expect(finishTaskClose({ tableName: actions.tableName, actions, documentClient: db }, stale, closeId)).resolves.toBeUndefined();
    expect(deleteEc2Session!.mock.calls.length).toBe(calls);
    expect(member()).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
  });

  it("closes a task whose counters were already released, without releasing them again", async () => {
    const { db, close, taskId, task, active, finish, actions, deleteEc2Session, member } = await finished();
    deleteEc2Session!.mockRejectedValueOnce(Object.assign(new Error("starting"), { name: "AgentXError" }));
    await close(randomUUID());
    const closeId = active();
    await finish(task.workspaceId, closeId, "SUCCEEDED", SAFE);
    // An earlier release took this task's slot back, but the close itself never landed.
    const counter = db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`) as Record<string, unknown>;
    counter.count = 0;
    delete counter.tasks;
    (organization(db) as Record<string, unknown>).count = 0;
    const record = db.get(`DEVTASK#${taskId}`, "META") as DeveloperTaskRecord;
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(finishTaskClose({ tableName: actions.tableName, actions, documentClient: db }, record, closeId)).resolves.toBeUndefined();
      expect(logged.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)).toContainEqual({ component: "broker", event: "developer.task_release_already_released", taskId });
    } finally {
      logged.mockRestore();
    }
    expect(db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(organization(db)).toMatchObject({ count: 0 });
    expect(member()).toMatchObject({ count: 0 });
  });

  it("refuses a setup-failed close that fails for another reason with a clear message, and keeps the task", async () => {
    const { db, close, taskId } = await setupFailed();
    // The organization counter lost this task's charge: not a race, not already released.
    (organization(db) as Record<string, unknown>).count = 0;
    const refused = await close();
    expect(refused.body.error).toEqual({ code: "WORKSPACE_BUSY", message: "AgentX could not close this task just now; try agentx_close_task again, and ask an admin if it keeps failing" });
    expect(db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
    expect(db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close")).toHaveLength(0);
  });

  it("answers TASK_BUSY when a setup-failed task's compute is still stopping, and closes on a retry", async () => {
    const { db, close, taskId, deleteEc2Session } = await setupFailed();
    deleteEc2Session!.mockRejectedValueOnce(agentXError("WORKSPACE_BUSY", "workspace compute is starting or stopping; retry the close"));
    const busy = await close();
    expect(busy.body.error).toEqual({ code: "TASK_BUSY", message: "the task's compute is still stopping; try agentx_close_task again shortly" });
    expect(db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
    expect((await close()).body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("finishes a close through the close route when the first completion failed", async () => {
    const { close, task, active, finish, deleteEc2Session, member, db } = await finished();
    deleteEc2Session!.mockRejectedValueOnce(Object.assign(new Error("starting"), { name: "AgentXError" }));
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", SAFE);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    expect((await close(randomUUID())).body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(member()).toMatchObject({ count: 0 });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("releases once when two closes both find it CLOSING and both delete the compute", async () => {
    const { close, task, taskId, active, finish, deleteEc2Session, member, db, dev } = await finished();
    deleteEc2Session!.mockRejectedValueOnce(Object.assign(new Error("starting"), { name: "AgentXError" }));
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", SAFE);
    // Each deletion waits for the other, so both closes read CLOSING before either lands.
    let deletions = 0;
    let bothDeleting!: () => void;
    const together = new Promise<void>((resolve) => { bothDeleting = resolve; });
    deleteEc2Session!.mockImplementation(async () => {
      if (++deletions === 2) bothDeleting();
      await together;
    });
    const answers = await Promise.all([close(randomUUID()), close(randomUUID())]);
    expect(deletions).toBe(2);
    for (const answer of answers) expect(answer.body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).toMatchObject({ status: "CLOSED" });
    expect(member()).toMatchObject({ count: 0 });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("stops showing a refused close's unpublished work once the developer continues", async () => {
    const { dev, close, task, taskId, active, finish } = await finished();
    await close(randomUUID());
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }] } });
    await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "push it" });
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).not.toHaveProperty("unpublished");
    await finish(task.workspaceId, active(), "SUCCEEDED");
    expect((await dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task).not.toHaveProperty("unpublished");
  });

  it("always says why when it did not close", async () => {
    const { close, task, active, finish, deleteEc2Session } = await finished();
    const refusedId = randomUUID();
    expect((await close(refusedId)).body).toMatchObject({ closed: false, message: "AgentX is checking the task's workspace for unpublished work before closing it; check back with agentx_get_task" });
    await finish(task.workspaceId, active(), "SUCCEEDED", { result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["unpushed_head"] }] } });
    expect((await close(refusedId)).body).toMatchObject({
      closed: false, unpublished: [{ repository: "demo", reasons: ["unpushed_head"] }],
      message: "not closed: some work is not published; push it or open a pull request with agentx_open_pull_request, then close the task again",
    });
    const failedId = randomUUID();
    await close(failedId);
    await finish(task.workspaceId, active(), "FAILED", { error: "git status exited 128" });
    expect((await close(failedId)).body).toMatchObject({ closed: false, message: "the check for unpublished work did not finish; try agentx_close_task again with a new request_id" });
    const starting = () => Object.assign(new Error("starting"), { name: "AgentXError" });
    deleteEc2Session!.mockRejectedValueOnce(starting()).mockRejectedValueOnce(starting());
    const safeId = randomUUID();
    await close(safeId);
    await finish(task.workspaceId, active(), "SUCCEEDED", SAFE);
    expect((await close(safeId)).body).toMatchObject({ closed: false, message: "the workspace has no unpublished work, but its compute is not removed yet; try agentx_close_task again shortly" });
    expect((await close(safeId)).body).toMatchObject({ closed: true });
  });

  it("answers a continue or pull request that loses the race to a close with the closing message", async () => {
    const { db, dev, taskId, task } = await finished();
    const closingOnSecondRead = () => {
      let reads = 0;
      const send = db.send;
      db.send = async (command) => {
        const input = (command as { input: { Key?: { pk?: string; sk?: string } } }).input;
        const answer = await send(command);
        if (command.constructor.name === "GetCommand" && input.Key?.pk === `WORKSPACE#${task.workspaceId}` && input.Key.sk === "META" && ++reads === 1) {
          // A close committed right after this route checked the workspace.
          Object.assign(db.get(`WORKSPACE#${task.workspaceId}`, "META")!, { status: "CLOSING", activeOperationId: randomUUID(), closeOperationId: randomUUID() });
        }
        return answer;
      };
      return () => { db.send = send; };
    };
    const closing = { code: "CONFIG_INVALID", message: "this task is closing; check it with agentx_get_task, and if the close is refused for unpublished work you can continue it" };
    const workspace = structuredClone(db.get(`WORKSPACE#${task.workspaceId}`, "META")!);
    let restore = closingOnSecondRead();
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" })).body.error).toEqual(closing);
    restore();
    db.set(structuredClone(workspace));
    restore = closingOnSecondRead();
    expect((await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/pull-requests`, { requestId: randomUUID(), title: "x" })).body.error).toEqual(closing);
    restore();
  });

  it("leaves a Slack thread's workspace alone: the worker's close result finishes nothing for it", async () => {
    const { db, close, task, active, finish } = await finished();
    // Without the task pointer the result is a Slack workspace's: the close stays CLOSING for the Slack flow.
    await close(randomUUID());
    const closeId = active();
    for (const [key, item] of db.items) if (item.pk === `WORKSPACE#${task.workspaceId}` && item.sk === "DEVELOPER_TASK") db.items.delete(key);
    await finish(task.workspaceId, closeId, "SUCCEEDED", { result: { safeToClose: true, repositories: [] } });
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
  });
});
