// Spec 025 Task 6: the broker actions developer task routes use, driven over the Slack harness's fake table.
import { randomUUID } from "node:crypto";
import { describe, expect, it, type Mock } from "vitest";
import type { DeveloperTaskActions } from "../../packages/broker/src/aws/developer-task-actions.js";
import { developerTaskIdentity } from "../../packages/broker/src/developer/task-records.js";
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

describe("acceptTask with a developer identity (FR-019, FR-022)", () => {

  it("writes nothing when an extra item's condition fails", async () => {
    const { db, actions, identity, workspaceId, conversationId } = await readyWorkspace();
    db.set({ pk: "BLOCK", sk: "BLOCK" });
    await expect(actions.acceptTask(identity, workspaceId, { requestId: randomUUID(), conversationId, prompt: "x" }, () => [
      { Put: { TableName: "state", Item: { pk: "BLOCK", sk: "BLOCK" }, ConditionExpression: "attribute_not_exists(pk)" } },
    ])).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "task")).toHaveLength(0);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "READY" });
  });

});

describe("the pull request footer says where a task started and who asked (FR-023)", () => {
  const footerOf = async (named: Partial<typeof task>) => {
    const { db, actions, workspaceId } = await readyWorkspace();
    const identity = developerTaskIdentity({ ...task, ...named });
    const accepted = await actions.acceptPullRequest(identity, workspaceId, { requestId: randomUUID(), repository: "demo", title: "Fix", body: "Fixes #12." }, () => []);
    const record = db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${accepted.operation.id}`) as { publication: { body: string } };
    return record.publication.body;
  };

  it("names a Slack-started task's requester as the task owner, started from Slack", async () => {
    expect(await footerOf({ developerName: "Slack user U0BSPTAFNG2", client: "Slack" })).toBe("Fixes #12.\n\n---\nRequested by the task owner via AgentX, started from Slack");
    // A task stored before the Slack client was kept reads the same.
    expect(await footerOf({ developerName: "Slack user U0BSPTAFNG2", client: "an AI tool" })).toBe("Fixes #12.\n\n---\nRequested by the task owner via AgentX, started from Slack");
  });

});

describe("acceptPullRequest attribution and draft (FR-023, R14)", () => {

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

describe("closing and cancelling with a developer identity", () => {

  it("says nothing is running when the workspace is idle", async () => {
    const { actions, identity, workspaceId } = await readyWorkspace();
    expect(await actions.cancelRunning(identity, await actions.workspace(workspaceId), () => [])).toEqual({ outcome: "NOTHING_RUNNING" });
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
