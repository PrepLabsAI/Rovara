// Spec 025 Task 6: the broker actions developer task routes use, driven over the Slack harness's fake table.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { developerTaskIdentity, taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { markReady } from "../support/slack-broker.js";

const taskId = "44444444-4444-4444-8444-444444444444";
const task = { taskId, developerId: MAYA.developerId, provider: "slack" as const, developerName: "Maya Chen", client: "Claude Code" };

async function readyWorkspace() {
  const harness = await createDeveloperTaskBroker();
  const identity = developerTaskIdentity(task);
  const project = await harness.actions.latestProject("payments");
  if (!project) throw new Error("project missing");
  const preparation = await harness.actions.preparation(identity, project, randomUUID());
  await harness.actions.transact(preparation.items);
  markReady(harness.db, preparation.workspace.id);
  const conversationId = randomUUID();
  harness.db.set({ pk: `WORKSPACE#${preparation.workspace.id}`, sk: `CONVERSATION#${conversationId}`, entityType: "CONVERSATION", id: conversationId, workspaceId: preparation.workspace.id, createdAt: "x", updatedAt: "x" });
  return { ...harness, identity, workspaceId: preparation.workspace.id, conversationId };
}

describe("the developer identity (FR-017, FR-021)", () => {
  it("owns the workspace it prepares, with a developer membership for its key", async () => {
    const { db, workspaceId } = await readyWorkspace();
    const ownerKey = taskOwnerKey(MAYA.developerId, taskId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ ownerKey, projectName: "payments" });
    expect(db.get(`MEMBER#${ownerKey}`, "PROJECT#payments")).toMatchObject({ role: "developer" });
  });
});

describe("acceptTask with a developer identity (FR-019, FR-022)", () => {
  it("records the developer requester, sends the instructions unchanged, and writes the extra items in the same transaction", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const prompt = "Fix the flaky retry test.\n\nKeep the public API.\u00a0";
    const accepted = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt }, (operation) => [
      { Put: { TableName: "turns", Item: { pk: `TASK#${taskId}`, sk: `TURN#${operation.id}`, marker: true } } },
    ]);
    expect(accepted.operation.requestedBy).toEqual({ kind: "developer", developerId: MAYA.developerId, provider: "slack" });
    const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === accepted.operation.id)[0];
    expect((outbox?.invocation as { payload: { prompt: string } }).payload.prompt).toBe(prompt);
    expect(db.get(`TASK#${taskId}`, `TURN#${accepted.operation.id}`)).toMatchObject({ marker: true });
  });

  it("writes nothing when an extra item's condition fails", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    db.set({ pk: "BLOCK", sk: "BLOCK" });
    await expect(actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => [
      { Put: { TableName: "state", Item: { pk: "BLOCK", sk: "BLOCK" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ])).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(0);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

  it("answers a repeated request with the first operation and writes no extra items again", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const request = { requestId: randomUUID(), conversationId, prompt: "x" };
    let calls = 0;
    const extra = () => { calls += 1; return []; };
    const first = await actions.acceptTask(identity, workspaceId, request, extra);
    const second = await actions.acceptTask(identity, workspaceId, request, extra);
    expect(second).toMatchObject({ duplicate: true, operation: { id: first.operation.id } });
    expect(calls).toBe(1);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(1);
  });
});

describe("acceptPullRequest with a developer identity (FR-023, R14)", () => {
  it("ends the body with the developer footer and keeps draft on the publication", async () => {
    const { db, actions, identity, workspaceId } = await readyWorkspace();
    const accepted = await actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix the retry test", body: "Fixes #12.", draft: true }, () => []);
    const record = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${accepted.operation.id}`) as { publication: { body: string; draft?: boolean } };
    expect(record.publication.body).toBe("Fixes #12.\n\n---\nRequested by `Maya Chen` via AgentX, started from Claude Code");
    expect(record.publication.draft).toBe(true);
  });
});

describe("closing and cancelling with a developer identity", () => {
  it("starts the close preflight with the developer requester and no Slack closedBy", async () => {
    const { db, actions, identity, workspaceId } = await readyWorkspace();
    const workspace = await actions.workspace(workspaceId);
    const started = await actions.startClose(identity, workspace, randomUUID(), () => []);
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${started.operationId}`)).toMatchObject({ kind: "close", requestedBy: { kind: "developer" } });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "CLOSING" });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).not.toHaveProperty("closedBy");
  });

  it("answers a repeated close with the first operation and writes no extra items again", async () => {
    const { db, actions, identity, workspaceId } = await readyWorkspace();
    const requestId = randomUUID();
    let calls = 0;
    const extra = () => { calls += 1; return []; };
    const first = await actions.startClose(identity, await actions.workspace(workspaceId), requestId, extra);
    const second = await actions.startClose(identity, await actions.workspace(workspaceId), requestId, extra);
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ operationId: first.operationId, duplicate: true });
    expect(calls).toBe(1);
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "close")).toHaveLength(1);
  });

  it("cancels the running task with the developer requester and the extra items in the same transaction", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const { operation } = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    const result = await actions.cancelRunning(identity, await actions.workspace(workspaceId), (cancel) => [
      { Put: { TableName: "turns", Item: { pk: `TASK#${taskId}`, sk: `TURN#${cancel.id}`, marker: true } } },
    ]);
    expect(result).toMatchObject({ outcome: "CANCEL_REQUESTED", targetOperationId: operation.id });
    if (result.outcome !== "CANCEL_REQUESTED") throw new Error("expected a cancel");
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${result.cancelOperationId}`)).toMatchObject({ kind: "cancel", requestedBy: { kind: "developer", developerId: MAYA.developerId } });
    expect(db.get(`TASK#${taskId}`, `TURN#${result.cancelOperationId}`)).toMatchObject({ marker: true });
  });

  it("says nothing is running when the workspace is idle", async () => {
    const { actions, identity, workspaceId } = await readyWorkspace();
    expect(await actions.cancelRunning(identity, await actions.workspace(workspaceId), () => [])).toEqual({ outcome: "NOTHING_RUNNING" });
  });
});

describe("what the task reads", () => {
  it("lists the workspace's operations, newest events first, artifacts with their size, and pull requests", async () => {
    const { actions, identity, workspaceId, conversationId, events, artifact } = await readyWorkspace();
    const { operation } = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    await events(workspaceId, operation.id, [{ type: "lifecycle", payload: { status: "RUNNING" } }, { type: "progress", payload: { message: "npm test" } }]);
    await artifact(workspaceId, operation.id, "workspace.diff", "## demo\n");
    expect((await actions.operations(workspaceId)).map((entry) => entry.kind).sort()).toEqual(["prepare", "task"]);
    expect((await actions.eventsNewestFirst(operation.id, 10)).map((entry) => entry.type)).toEqual(["progress", "lifecycle"]);
    expect(await actions.artifacts(workspaceId, operation.id)).toEqual([expect.objectContaining({ name: "workspace.diff", size: 8 })]);
    const [stored] = await actions.artifacts(workspaceId, operation.id);
    expect(await actions.readArtifact(stored!.objectKey, 1_000)).toBe("## demo\n");
    expect(await actions.readArtifact(stored!.objectKey, 2)).toBe("##");
    expect(await actions.pullRequests(workspaceId)).toEqual([]);
  });
});
