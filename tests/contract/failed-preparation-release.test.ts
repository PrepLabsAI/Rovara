// Issue #213, part one: a workspace whose preparation failed stops counting toward the per-person
// and organization workspace limits at once, a new message in its Slack thread starts fresh, and a
// later close never gives the slot back a second time.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { releaseFailedPreparation } from "../../packages/broker/src/aws/failed-preparation.js";
import { failActiveOperation, failOutboxOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { sweepStuckCancels } from "../../packages/broker/src/aws/stuck-cancels.js";
import type { DurableOutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { preparationFailedMessage } from "../../packages/slack-service/src/messages.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, createBroker, finishOperation, lazyEnsureWorkspace, loadSlackBroker, prepareThread, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadOne = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const threadTwo = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const threadThree = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000003`;
const pratik = "U0123456789";
const bob = "U0456789012";

beforeAll(async () => {
  await loadSlackBroker();
});

const member = (db: FakeDynamoDb, userId: string) => db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${userId}`);
const organization = (db: FakeDynamoDb) => db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION");
const threadRecord = (db: FakeDynamoDb, subject: string) => db.find((item) => item.entityType === "SLACK_THREAD" && item.thread === subject)[0];
const outboxOf = (db: FakeDynamoDb, operationId: string) => db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0] as unknown as DurableOutboxRecord;

/** A thread whose compute preparation was accepted (charged), as the lazy worker asks for it. */
async function preparingThread(db: FakeDynamoDb, handler: Parameters<typeof lazyEnsureWorkspace>[0], subject: string, userId: string) {
  const workspaceId = (await lazyEnsureWorkspace(handler, subject, userId)).body.workspaceId as string;
  const prepared = await prepareThread(handler, subject, userId);
  const operationId = prepared.body.operationId as string;
  expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
  return { workspaceId, operationId };
}

/** Runs `run` with console.log captured; answers the parsed JSON lines it logged. */
async function logged(run: () => Promise<unknown>): Promise<unknown[]> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await run();
    return spy.mock.calls.map(([line]: unknown[]): unknown => { try { return JSON.parse(String(line)) as unknown; } catch { return String(line); } });
  } finally {
    spy.mockRestore();
  }
}

describe("a Slack thread whose workspace failed preparation (#213)", () => {
  it("stops counting toward the per-person and organization limits when the worker reports the failure", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 1 });

    await finishOperation(handler, db, workspaceId, operationId, "FAILED");

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
    expect(threadRecord(db, threadOne)).not.toHaveProperty("starterUserId");
  });

  it("stops counting when the worker failed to boot and the dispatch failed (the live case)", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);

    await failOutboxOperation(db, "state", outboxOf(db, operationId), "RUNTIME_UNAVAILABLE: workspace compute failed to start: boot failed");

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("stops counting when the reconciler finds the preparing compute lost", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId } = await preparingThread(db, handler, threadOne, pratik);

    await failActiveOperation(db, "state", workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("stops counting when the stuck-cancel sweep ends a cancelled preparation whose compute is gone", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    Object.assign(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!, { status: "CANCEL_REQUESTED", updatedAt: new Date(Date.now() - 40 * 60_000).toISOString() });

    const swept = await sweepStuckCancels({ client: db, tableName: "state" }, [{ workspaceId, compute: "gone" }], new Date());

    expect(swept.ended).toEqual([operationId]);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("lets the same person, and the organization, start another workspace at once", async () => {
    const { db, handler } = createBroker({ memberLimit: 1, organizationLimit: 1 });
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");

    await lazyEnsureWorkspace(handler, threadTwo, pratik);
    expect((await prepareThread(handler, threadTwo, pratik)).body).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadTwo] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("prepares the thread's workspace again, charged afresh, on the next message in that thread", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");

    const next = await lazyEnsureWorkspace(handler, threadOne, bob);
    expect(next.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING" });
    expect(next.body.operationId).not.toBe(operationId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", activeOperationId: next.body.operationId });
    // The member who asked this time is charged, once; the earlier starter is not charged again.
    expect(member(db, bob)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(organization(db)).toMatchObject({ count: 1 });
    expect(threadRecord(db, threadOne)).toMatchObject({ starterUserId: bob });
  });

  it("refuses the fresh start at the limit, and leaves the failed workspace uncharged", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    await preparingThread(db, handler, threadTwo, pratik);

    const refused = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(refused.body).toMatchObject({
      outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1,
      starterThreads: [{ teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000002" }],
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadTwo] });
    expect(threadRecord(db, threadOne)).not.toHaveProperty("starterUserId");
  });

  it("keeps a failure recorded before this release charged, and retries it under that one charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    // As a workspace failed before #213 is stored: still charged, its starter still recorded.
    Object.assign(member(db, pratik)!, { count: 1, threads: [threadOne] });
    Object.assign(organization(db)!, { count: 1 });
    Object.assign(threadRecord(db, threadOne)!, { starterUserId: pratik });

    const next = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(next.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING" });
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("releases a failed workspace once, however many times the release runs", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await preparingThread(db, handler, threadTwo, bob);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await failOutboxOperation(db, "state", outboxOf(db, operationId), "RUNTIME_UNAVAILABLE: workspace compute failed to start: boot failed");

    await releaseFailedPreparation(db, "state", workspaceId);
    await releaseFailedPreparation(db, "state", workspaceId);

    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(member(db, bob)).toMatchObject({ count: 1, threads: [threadTwo] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("gives the slot back exactly once when the thread is retried, set up and then closed", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await preparingThread(db, handler, threadTwo, bob);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "FAILED");
    const retried = await lazyEnsureWorkspace(handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, retried.body.operationId as string, "SUCCEEDED");
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 2 });

    const started = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    await finishOperation(handler, db, workspaceId, started.body.operationId as string, "SUCCEEDED", { safeToClose: true, repositories: [] });
    const completed = await serviceCall(handler, threadOne, pratik, "POST", "/v1/service/threads/workspace/close/complete", {
      requestId: randomUUID(), operationId: started.body.operationId,
    });
    expect(completed.body).toMatchObject({ outcome: "CLOSED", workspaceId });
    await releaseFailedPreparation(db, "state", workspaceId);

    expect(member(db, pratik)).toMatchObject({ count: 0, threads: [] });
    expect(member(db, bob)).toMatchObject({ count: 1, threads: [threadTwo] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("still counts a workspace that prepared, and a release does nothing to it", async () => {
    const { db, handler } = createBroker({ memberLimit: 1 });
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    await finishOperation(handler, db, workspaceId, operationId, "SUCCEEDED");
    await releaseFailedPreparation(db, "state", workspaceId);

    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 1 });
    expect(threadRecord(db, threadOne)).toMatchObject({ starterUserId: pratik });
    await lazyEnsureWorkspace(handler, threadThree, pratik);
    expect((await prepareThread(handler, threadThree, pratik)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER" });
  });

  it("still counts a workspace that is still preparing", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId } = await preparingThread(db, handler, threadOne, pratik);
    await releaseFailedPreparation(db, "state", workspaceId);
    expect(member(db, pratik)).toMatchObject({ count: 1, threads: [threadOne] });
    expect(organization(db)).toMatchObject({ count: 1 });
  });

  it("logs the release by IDs only", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const { workspaceId, operationId } = await preparingThread(db, handler, threadOne, pratik);
    const lines = await logged(() => finishOperation(handler, db, workspaceId, operationId, "FAILED"));
    expect(lines).toContainEqual({ component: "broker", event: "workspace.preparation_failed_released", workspaceId, owner: "slack_thread" });
  });
});

describe("a developer task whose setup failed (#213)", () => {
  async function setupFailed(options: { memberLimit?: number } = {}) {
    const harness = await createDeveloperTaskBroker(options);
    const response = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "x" });
    const taskId = (response.body.task as { taskId: string }).taskId;
    const { workspaceId } = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    expect(member(harness.db, MAYA.slackUserId!)).toMatchObject({ count: 1 });
    const active = String((harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { activeOperationId: string }).activeOperationId);
    await harness.finish(workspaceId, active, "FAILED", { error: "npm ci exited 1" });
    return { ...harness, taskId, workspaceId };
  }

  it("stops counting toward the limits as soon as setup fails, before any close", async () => {
    const { db, taskId } = await setupFailed();
    const counter = member(db, MAYA.slackUserId!) as { count: number; tasks?: Set<string> };
    expect(counter.count).toBe(0);
    expect(counter.tasks?.has(taskId) ?? false).toBe(false);
    expect(organization(db)).toMatchObject({ count: 0 });
    expect(db.get(`DEVTASK#${taskId}`, "META")).not.toHaveProperty("closedAt");
  });

  it("lets the developer start a new task at once, at a limit of one", async () => {
    const { dev } = await setupFailed({ memberLimit: 1 });
    expect((await dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "again" })).status).toBe(200);
  });

  it("closes the task afterwards without giving the slot back a second time", async () => {
    const { db, dev, taskId } = await setupFailed();
    const closed = await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/close`, { requestId: randomUUID() });
    expect(closed.body).toMatchObject({ closed: true, task: { status: "CLOSED" } });
    expect(member(db, MAYA.slackUserId!)).toMatchObject({ count: 0 });
    expect(organization(db)).toMatchObject({ count: 0 });
  });

  it("says the workspace was released when the developer tries to continue", async () => {
    const { dev, taskId } = await setupFailed();
    const refused = await dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/continue`, { requestId: randomUUID(), instructions: "more" });
    expect(refused.body.error).toEqual({
      code: "CONFIG_INVALID",
      message: "this task never started and its workspace was released, so it no longer counts toward your workspace limit; start a new task with agentx_start_task, and close this one with agentx_close_task",
    });
  });
});

describe("the thread's notice for a failed setup (#213)", () => {
  it("says plainly that the workspace was released and that a new message starts fresh", () => {
    expect(preparationFailedMessage("FAILED")).toBe(
      "AgentX could not set up this thread's workspace (FAILED). The workspace was released, so it no longer counts toward the workspace limit. Mention me again in this thread to start fresh.",
    );
    expect(preparationFailedMessage("FAILED", "setup step 1 (npm ci) exited 1")).toBe(
      "AgentX could not set up this thread's workspace (FAILED). The workspace was released, so it no longer counts toward the workspace limit. Ask an administrator to fix the project's setup commands, then mention me again in this thread to start fresh.\nReason: setup step 1 (npm ci) exited 1",
    );
  });
});
