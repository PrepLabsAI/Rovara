import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/project.js";
import { createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const otherThread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const user = "U0123456789";
const models = {
  default: { provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" },
  approved: [
    { provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" },
    { provider: "amazon-bedrock", modelId: "fast-model", label: "Fast" },
  ],
};

beforeAll(loadSlackBroker);

describe("project worker model selection", () => {
  it("requires a unique approved default and labels", () => {
    const base = {
      name: "payments", revision: 1,
      repositories: [{ name: "demo", url: "https://github.com/example/demo", path: "repo/demo", defaultBranch: "main", credentialRef: "github-app" }],
      setup: [], readiness: [], orchestratorInstructions: "Delegate.",
    };
    expect(ProjectDefinitionSchema.safeParse({ ...base, models }).success).toBe(true);
    expect(ProjectDefinitionSchema.safeParse({ ...base, models: { ...models, default: { provider: "x", modelId: "missing" } } }).success).toBe(false);
    expect(ProjectDefinitionSchema.safeParse({ ...base, models: { ...models, approved: [...models.approved, { provider: "x", modelId: "x", label: "FAST" }] } }).success).toBe(false);
  });

  it("stores one project-wide selection and resolves it into the next task", async () => {
    const { handler, db } = createBroker();
    await registerSlackProject(handler, { models });
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;

    const selected = await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "amazon-bedrock", modelId: "fast-model" });
    expect(selected).toMatchObject({ status: 200, body: { projectName: "payments", source: "selection", current: { label: "Fast" } } });
    expect(db.find((item) => item.entityType === "PROJECT_MODEL_SELECTION")).toEqual([expect.objectContaining({
      model: { provider: "amazon-bedrock", modelId: "fast-model" },
      updatedBy: { teamId: SLACK_TEAM, userId: user },
      updatedAt: expect.any(String) as string,
    })]);
    const listedElsewhere = await serviceCall(handler, otherThread, user, "GET", "/v1/service/project/models");
    expect(listedElsewhere.body).toMatchObject({ source: "selection", current: { modelId: "fast-model" } });

    const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    expect(task.status).toBe(202);
    const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === (task.body.operation as { id: string }).id)[0]!.invocation as { payload: Record<string, unknown> };
    expect(invocation.payload.model).toEqual({ provider: "amazon-bedrock", modelId: "fast-model" });
  });

  it("rejects unapproved choices and falls back when a later revision removes a selection", async () => {
    const { handler, db } = createBroker();
    await registerSlackProject(handler, { models });
    const refused = await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "other", modelId: "unapproved" });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    await serviceCall(handler, thread, user, "PUT", "/v1/service/project/model", { provider: "amazon-bedrock", modelId: "fast-model" });
    await registerSlackProject(handler, { revision: 2, models: { default: models.default, approved: [models.default] } });

    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === (task.body.operation as { id: string }).id)[0]!.invocation as { payload: Record<string, unknown> };
    expect(invocation.payload.model).toEqual({ provider: "amazon-bedrock", modelId: "default-model" });
    expect(invocation.payload.modelSelectionDiagnostic).toMatch(/no longer approved/);
  });

  it("omits the task model for a legacy project", async () => {
    const { handler, db } = createBroker();
    await registerSlackProject(handler);
    const workspace = await ensureWorkspace(handler, thread, user);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const refused = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
      requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "test it", provider: "attacker-choice",
    });
    expect(refused).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "test it" });
    const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === (task.body.operation as { id: string }).id)[0]!.invocation as { payload: Record<string, unknown> };
    expect(invocation.payload).not.toHaveProperty("model");
  });
});
