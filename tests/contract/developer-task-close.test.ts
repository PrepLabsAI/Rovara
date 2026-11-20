// Spec 025 Task 12: closing a developer task (FR-016, FR-030, R6, R15, R22, owner decisions 5 and 6).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
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
  const close = (requestId: string, discardUnpublished = false) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId, ...(discardUnpublished ? { discard_unpublished: true } : {}) });
  const member = () => harness.db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`);
  return { ...harness, taskId, task, active, close, member };
}

/** A task whose setup failed: its workspace is PREPARATION_FAILED, and its slot was released (#213). */
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
/** A task's close records as `phase:outcome`, sorted, so a count also says which records they are. */
const closePhases = (db: FakeDynamoDb, taskId: string) =>
  db.find((item) => item.pk === `TASK#${taskId}` && item.action === "close").map((item) => `${String(item.phase)}:${String(item.outcome)}`).sort();

describe("closing a task (R15)", () => {

  it("discards unpublished workspace state only when the owner explicitly authorizes it", async () => {
    const { db, close, task, taskId, active, finish, deleteEc2Session, member } = await finished();
    const requestId = randomUUID();
    const accepted = await close(requestId, true);
    expect(accepted.body).toMatchObject({ closed: false, task: { closing: true } });
    const closeId = active();
    expect(db.get(`WORKSPACE#${task.workspaceId}`, `OPERATION#${closeId}`)).toMatchObject({
      kind: "close",
      discardUnpublished: true,
      requestedBy: { kind: "developer", developerId: MAYA.developerId },
    });
    await finish(task.workspaceId, closeId, "SUCCEEDED", {
      result: { safeToClose: false, repositories: [{ name: "demo", reasons: ["worktree_changes", "untracked_files"] }] },
    });
    expect(deleteEc2Session).toHaveBeenCalledWith(task.workspaceId);
    expect(db.get(`WORKSPACE#${task.workspaceId}`, "META")).toMatchObject({ status: "CLOSED" });
    expect(db.get(`DEVTASK#${taskId}`, "META")).toHaveProperty("closedAt");
    expect(member()).toMatchObject({ count: 0 });
    expect(closePhases(db, taskId)).toEqual(["accepted:accepted", "completed:succeeded"]);
    const retried = await close(requestId, true);
    expect(retried.body).toMatchObject({ closed: true, discardedUnpublished: true });
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

});

describe("closing a task: repeats, races and audit records (R12, R15)", () => {

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

  it("releases the counters exactly once when two completions race (a lost race is not an error)", async () => {
    const { db, close, taskId, task, active, finish, member, actions, deleteEc2Session } = await finished();
    const stale = structuredClone(db.get(`DEVTASK#${taskId}`, "META")) as unknown as DeveloperTaskRecord;
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

  it("refuses a setup-failed close that fails for another reason with a clear message, and keeps the task", async () => {
    const { db, close, taskId } = await setupFailed();
    // A task whose setup failed before #213 still holds its charge, and here the organization
    // counter lost it: not a race, not already released.
    Object.assign(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${MAYA.slackUserId}`) as Record<string, unknown>, { count: 1, tasks: new Set([taskId]) });
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

});
