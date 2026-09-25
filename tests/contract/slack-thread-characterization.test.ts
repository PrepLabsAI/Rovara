// Pins the thread workspace behaviour that phase 14b must keep for threads that have compute.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectorCatalogSchema } from "../../packages/contracts/src/connectors.js";
import {
  GITHUB_LIST_ISSUES, SLACK_CHANNEL, SLACK_TEAM, createBroker, ensureWorkspace, fakeGitHubMcp, finishOperation,
  loadSlackBroker, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const pratik = "U0123456789";
const bob = "U0456789012";

beforeAll(async () => {
  await loadSlackBroker();
});

describe("thread workspaces before lazy preparation (characterization)", () => {
  it("ignores request fields it does not know and prepares at once", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const response = await serviceCall(handler, thread, pratik, "POST", "/v1/service/threads/workspace", {
      requestId: randomUUID(), includeIntegrations: true, includeSettingsRevision: true, futureFlag: true,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(1);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1, threads: [thread] });
  });

  it("charges a thread to its starter only, never to a member who follows up", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread, pratik);
    await ensureWorkspace(handler, thread, bob);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${bob}`)).toBeUndefined();
    expect(db.find((item) => item.entityType === "SLACK_THREAD")[0]).toMatchObject({ starterUserId: pratik });
  });

  it("retries a failed preparation at the next request without charging the limit again", async () => {
    const { db, handler } = createBroker();
    await registerSlackProject(handler);
    const first = await ensureWorkspace(handler, thread, pratik);
    const workspaceId = first.body.workspaceId as string;
    await finishOperation(handler, db, workspaceId, first.body.operationId as string, "FAILED");
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARATION_FAILED", fence: 1 });

    const retried = await ensureWorkspace(handler, thread, pratik);
    expect(retried.body).toMatchObject({ outcome: "WORKSPACE", workspaceId, status: "PREPARING", created: false });
    expect(retried.body.operationId).not.toBe(first.body.operationId);
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING", fence: 2 });
    expect(db.find((item) => item.entityType === "OPERATION" && item.kind === "prepare")).toHaveLength(2);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, `MEMBER#${pratik}`)).toMatchObject({ count: 1 });
  });

  it("refuses to close a workspace that is still being prepared", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    await ensureWorkspace(handler, thread, pratik);
    const close = await serviceCall(handler, thread, pratik, "POST", "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(close.status).toBe(409);
    expect(close.body.error).toEqual({ code: "WORKSPACE_BUSY", message: "workspace is PREPARING; wait for active work before closing it" });
  });

  it("serves connector discovery and calls whatever the workspace status", async () => {
    const { githubMcp, invoke } = fakeGitHubMcp();
    const { db, handler } = createBroker({ githubMcp });
    await registerSlackProject(handler, { connectors: GITHUB_LIST_ISSUES });
    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")).toMatchObject({ status: "PREPARING" });
    const path = `/v1/service/workspaces/${workspaceId}/connectors/github`;
    const discovered = await serviceCall(handler, thread, pratik, "GET", `${path}/tools`);
    expect(discovered.status).toBe(200);
    const catalog = ConnectorCatalogSchema.parse(discovered.body.catalog);
    const called = await serviceCall(handler, thread, pratik, "POST", `${path}/call`, {
      requestId: randomUUID(), scope: "demo", tool: "list_issues", schemaHash: catalog.tools[0]!.scopes[0]!.schemaHash, arguments: {},
    });
    expect(called.body.result).toMatchObject({ status: "SUCCEEDED" });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("creates a conversation at once but refuses a task until the workspace is ready", async () => {
    const { handler } = createBroker();
    await registerSlackProject(handler);
    const workspaceId = (await ensureWorkspace(handler, thread, pratik)).body.workspaceId as string;
    const conversation = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
    expect(conversation.status).toBe(201);
    const task = await serviceCall(handler, thread, pratik, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "list the files",
    });
    expect(task.status).toBe(409);
    expect(task.body.error).toEqual({ code: "WORKSPACE_NOT_READY", message: "workspace is PREPARING" });
  });
});
