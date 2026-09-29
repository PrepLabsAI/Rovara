// Spec 025 Task 6: the broker actions developer task routes use, driven over the Slack harness's fake table.
import { randomUUID } from "node:crypto";
import { describe, expect, it, type Mock } from "vitest";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
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
  return { ...harness, identity, workspaceId: preparation.workspace.id, preparationId: preparation.operationId, conversationId };
}

/** Every write the fake table holds, to show a refused action wrote nothing. */
function snapshot(db: { items: Map<string, unknown> }): string {
  return JSON.stringify([...db.items.entries()]);
}

/** Moves the running task to a terminal status just before the next transaction, as a worker result racing the cancel would. */
function finishBeforeNextTransaction(db: { send: (command: never) => Promise<unknown>; get: (pk: string, sk: string) => Record<string, unknown> | undefined }, workspaceId: string, operationId: string) {
  const original = db.send;
  db.send = async (command: never) => {
    if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
      db.send = original;
      const target = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`)!;
      target.status = "SUCCEEDED";
      target.fence = Number(target.fence) + 1;
    }
    return original(command);
  };
}

describe("the developer identity (FR-017, FR-021)", () => {
  it("owns the workspace it prepares, with a developer membership for its key", async () => {
    const { db, workspaceId } = await readyWorkspace();
    const ownerKey = taskOwnerKey(MAYA.developerId, taskId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ ownerKey, projectName: "payments" });
    expect(db.get(`MEMBER#${ownerKey}`, "PROJECT#payments")).toMatchObject({ role: "developer" });
  });
});

describe("the prepare operation (FR-022)", () => {
  it("records the developer as its requester", async () => {
    const { db, workspaceId, preparationId } = await readyWorkspace();
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${preparationId}`)).toMatchObject({
      kind: "prepare", requestedBy: { kind: "developer", developerId: MAYA.developerId, provider: "slack" },
    });
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

describe("acceptPullRequest attribution and draft (FR-023, R14)", () => {
  it("keeps a display name with a backtick and a mention inert in the footer", async () => {
    const { db, actions, workspaceId } = await readyWorkspace();
    const identity = developerTaskIdentity({ ...task, developerName: "Ma`ya @octocat" });
    const accepted = await actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix", body: "Fixes #12." }, () => []);
    const record = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${accepted.operation.id}`) as { publication: { body: string } };
    expect(record.publication.body).toBe("Fixes #12.\n\n---\nRequested by ``Ma`ya @octocat`` via AgentX, started from Claude Code");
  });

  it("passes draft on to GitHub when the worker publishes", async () => {
    const { db, actions, identity, workspaceId, brokerInput, callback } = await readyWorkspace();
    const reconcile = (brokerInput as { githubPullRequests: { reconcilePullRequest: Mock } }).githubPullRequests.reconcilePullRequest;
    reconcile.mockResolvedValue({ number: 7, url: "https://github.com/example/demo/pull/7", reconciled: false });
    const accepted = await actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix", body: "Fixes #12.", draft: true }, () => []);
    const record = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${accepted.operation.id}`) as { publication: { body: string; headBranch: string } };
    await callback(workspaceId, accepted.operation.id, "pull-request", {
      repository: "demo", repositoryUrl: "https://github.com/example/demo.git", headBranch: record.publication.headBranch, baseBranch: "main",
      commit: "d".repeat(40), title: "Fix", body: record.publication.body,
    });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ title: "Fix", body: record.publication.body, draft: true }));
  });
});

describe("ownership of the workspace an action is given", () => {
  const stranger = developerTaskIdentity({ ...task, taskId: "55555555-5555-4555-8555-555555555555" });

  it("refuses to cancel another owner's task as NOT_FOUND and writes nothing", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    const before = snapshot(db);
    let calls = 0;
    await expect(actions.cancelRunning(stranger, await actions.workspace(workspaceId), () => { calls += 1; return []; })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toBe(0);
    expect(snapshot(db)).toBe(before);
  });

  it("refuses to close another owner's workspace as NOT_FOUND, even one already closing, and writes nothing", async () => {
    const { db, actions, identity, workspaceId } = await readyWorkspace();
    await expect(actions.startClose(stranger, await actions.workspace(workspaceId), randomUUID(), () => [])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await actions.startClose(identity, await actions.workspace(workspaceId), randomUUID(), () => []);
    const before = snapshot(db);
    await expect(actions.startClose(stranger, await actions.workspace(workspaceId), randomUUID(), () => [])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(snapshot(db)).toBe(before);
  });
});

describe("a cancel that loses a race (FR-022)", () => {
  it("says nothing is running when the task finished first, and writes nothing", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const { operation } = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    const workspace = await actions.workspace(workspaceId);
    finishBeforeNextTransaction(db, workspaceId, operation.id);
    expect(await actions.cancelRunning(identity, workspace, () => [])).toEqual({ outcome: "NOTHING_RUNNING" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toHaveLength(0);
  });

  it("answers WORKSPACE_BUSY when an extra item's condition fails, and writes nothing", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    const { operation } = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    db.set({ pk: "BLOCK", sk: "BLOCK" });
    await expect(actions.cancelRunning(identity, await actions.workspace(workspaceId), () => [
      { Put: { TableName: "state", Item: { pk: "BLOCK", sk: "BLOCK" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ])).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operation.id}`)).toMatchObject({ status: "ACCEPTED" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "cancel")).toHaveLength(0);
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

describe("reads that span pages", () => {
  /** A table that answers every query one item per page, as DynamoDB does past 1 MB. */
  function onePerPage(db: { send: (command: never) => Promise<unknown> }) {
    const original = db.send;
    db.send = async (command: never) => {
      const { constructor, input } = command as { constructor: { name: string }; input: { ExclusiveStartKey?: { pk: string; sk: string }; Limit?: number } };
      if (constructor.name !== "QueryCommand") return original(command);
      const { ExclusiveStartKey, Limit, ...rest } = input;
      const all = ((await original({ constructor, input: rest } as never)) as { Items: Array<{ pk: string; sk: string }> }).Items;
      const start = ExclusiveStartKey === undefined ? 0 : all.findIndex((item) => item.pk === ExclusiveStartKey.pk && item.sk === ExclusiveStartKey.sk) + 1;
      const page = all.slice(start, start + Math.min(1, Limit ?? 1));
      const last = page.at(-1);
      return { Items: page, ...(last !== undefined && start + 1 < all.length ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    };
  }

  it("reads every page of operations, artifacts and pull requests, and stops events at the limit", async () => {
    const { db, actions, identity, workspaceId, conversationId, events, artifact } = await readyWorkspace();
    const { operation } = await actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => []);
    await events(workspaceId, operation.id, [{ type: "lifecycle", payload: {} }, { type: "progress", payload: { message: "a" } }, { type: "progress", payload: { message: "b" } }]);
    await artifact(workspaceId, operation.id, "one.txt", "1");
    await artifact(workspaceId, operation.id, "two.txt", "2");
    for (const number of [1, 2]) {
      db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `PULL_REQUEST#demo#${number}`, entityType: "PULL_REQUEST", repository: "demo", number, url: `https://github.com/example/demo/pull/${number}`, state: "open" });
    }
    onePerPage(db);
    const reads: DeveloperTaskActions = actions;
    expect((await reads.operations(workspaceId)).map((entry) => entry.kind).sort()).toEqual(["prepare", "task"]);
    expect((await reads.artifacts(workspaceId, operation.id)).map((entry) => entry.name).sort()).toEqual(["one.txt", "two.txt"]);
    expect((await reads.pullRequests(workspaceId)).map((entry) => entry.number).sort()).toEqual([1, 2]);
    expect(await reads.eventsNewestFirst(operation.id, 2)).toHaveLength(2);
  });
});
