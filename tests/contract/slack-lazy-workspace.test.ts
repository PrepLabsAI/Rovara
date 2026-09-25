import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import { SlackThreadWorkspaceResultSchema } from "../../packages/contracts/src/slack.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, fakeGitHubMcp, lazyEnsureWorkspace, loadSlackBroker,
  registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const threadOne = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";
const bob = "U0456789012";
const carol = "U0789012345";

beforeAll(async () => {
  await loadSlackBroker();
});

describe("lazy thread workspace records", () => {
  it("creates a thread record with no compute and no limit charge", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const created = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(created.status).toBe(200);
    delete created.body.requestId;
    const workspaceId = created.body.workspaceId as string;
    expect(SlackThreadWorkspaceResultSchema.parse(created.body)).toEqual({
      outcome: "WORKSPACE", workspaceId, status: "UNPREPARED", operationId: null, created: true,
      orchestratorInstructions: "Delegate work (revision 1).", connectors: [], repositories: ["demo"],
      recoverableOperations: [], settingsRevision: 1,
    });
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED", fence: 0, projectRevision: 1, activeOperationId: null });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "OUTBOX")).toHaveLength(0);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    const threadRecord = db.find((item) => item.entityType === "SLACK_THREAD")[0];
    expect(threadRecord).toMatchObject({ thread: threadOne, workspaceId });
    expect(threadRecord).not.toHaveProperty("starterUserId");

    const followUp = await lazyEnsureWorkspace(handler, threadOne, bob);
    expect(followUp.body).toMatchObject({ workspaceId, status: "UNPREPARED", operationId: null, created: false });
  });

  it("gives a member any number of connector-only threads, past both limits", async () => {
    const { db, handler } = createBroker({ memberLimit: 1, organizationLimit: 2 });
    await registerSlackProject(handler);
    for (const ts of ["000001", "000002", "000003", "000004"]) {
      const created = await lazyEnsureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.${ts}`, pratik);
      expect(created.body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", created: true });
    }
    expect((await lazyEnsureWorkspace(handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000005`, carol)).body).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(5);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });

  it("answers connector discovery and calls, and keeps the ledger, for a thread with no compute", async () => {
    const { githubMcp, invoke } = fakeGitHubMcp();
    const { db, handler } = createBroker({ githubMcp });
    await registerSlackProject(handler, { connectors: GITHUB_LIST_ISSUES });
    const created = await lazyEnsureWorkspace(handler, threadOne, pratik);
    expect(created.body.connectors).toEqual([{ name: "github", type: "github", label: expect.any(String) as string, scopes: ["demo"], connected: true }]);
    const workspaceId = created.body.workspaceId as string;
    expect((await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`)).status).toBe(201);
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const catalog = ConnectorCatalogSchema.parse((await serviceCall(handler, threadOne, pratik, "GET", `${path}/tools`)).body.catalog);
    const requestId = randomUUID();
    const called = await serviceCall(handler, threadOne, pratik, "POST", `${path}/call`, {
      requestId, scope: "demo", tool: "list_issues", schemaHash: catalog.tools[0]!.scopes[0]!.schemaHash, arguments: {},
    });
    expect(called.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenCalledOnce();
    expect(db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && String(item.sk).includes(requestId))).toHaveLength(1);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "OPERATION")).toHaveLength(0);
  });

  it("refuses coding operations on a thread with no compute", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const conversation = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    const task = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "list the files",
    });
    expect(task.status).toBe(409);
    expect(task.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is UNPREPARED" });
    const pullRequest = await serviceCall(handler, threadOne, pratik, "POST", `/v1/service/workspaces/${workspaceId}/pull-requests`, {
      requestId: randomUUID(), repository: "demo", title: "Fix",
    });
    expect(pullRequest.status).toBe(409);
    expect(pullRequest.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is UNPREPARED" });
  });

  it("tells a connector-only thread there is nothing to close, and leaves it usable", async () => {
    const { db, handler, deleteWorkspaceSession } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await lazyEnsureWorkspace(handler, threadOne, pratik)).body.workspaceId as string;
    const close = await serviceCall(handler, threadOne, bob, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.body).toMatchObject({ outcome: "NOT_FOUND" });
    expect(deleteWorkspaceSession).not.toHaveBeenCalled();
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "UNPREPARED" });
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
    expect((await lazyEnsureWorkspace(handler, threadOne, pratik)).body).toMatchObject({ workspaceId, status: "UNPREPARED", created: false });
  });

  it("creates one record when two first messages race", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const results = await Promise.all([lazyEnsureWorkspace(handler, threadOne, pratik), lazyEnsureWorkspace(handler, threadOne, bob)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(new Set(results.map((result) => result.body.workspaceId)).size).toBe(1);
    expect(results.map((result) => result.body.created).sort()).toEqual([false, true]);
    expect(db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "DEFAULT_WORKSPACE")).toHaveLength(1);
    expect(db.find((item) => item.entityType === "SLACK_LIMIT")).toHaveLength(0);
  });
});
