// Sign in with ChatGPT (#341): a task whose owner connected a working plan runs on it. The broker picks
// the model and grants the token callback; the worker asks for the token and never sees the refresh token.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatGptConnectionView } from "../../packages/contracts/src/index.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import type { ChatGptConnections } from "../../packages/broker/src/chatgpt/connections.js";
import { chatGptOwner, chatGptTaskModel } from "../../packages/broker/src/chatgpt/task-model.js";
import { CHATGPT_TOKEN_MARGIN_MS, chatGptTokenSource } from "../../packages/worker/src/chatgpt-token.js";
import { resolveTaskSessionModel } from "../../packages/worker/src/task-model.js";
import { call, createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const maya = "U0123456789";
const sam = "U0456789012";
const models = {
  default: { provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" },
  approved: [{ provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" }],
};

beforeAll(loadSlackBroker);

describe("the model a ChatGPT task runs on (#341)", () => {
  it("is the best model the plan allows that Pi knows", () => {
    expect(chatGptTaskModel(["gpt-5.5", "gpt-6.1-sol", "gpt-6-luna"])).toBe("gpt-6.1-sol");
    expect(chatGptTaskModel(["gpt-5.5", "gpt-5.6-terra"])).toBe("gpt-5.6-terra");
    expect(chatGptTaskModel(["gpt-5.5", "gpt-6.1-sol"], "gpt-5.5")).toBe("gpt-5.5");
    expect(chatGptTaskModel(["gpt-5.5"], "gpt-6.1-sol")).toBe("gpt-5.5");
    // A model Pi does not know cannot run; one Pi knows but Rovara does not rank still can.
    expect(chatGptTaskModel(["gpt-unknown-9"])).toBeUndefined();
    expect(chatGptTaskModel(["gpt-unknown-9", "gpt-4.1"])).toBe("gpt-4.1");
  });

  it("is on the plan of a developer task's owner, else of whoever asked", () => {
    const slack = (userId: string) => `slack:${userId}`;
    expect(chatGptOwner("owner-dev", { teamId: SLACK_TEAM, userId: sam }, slack)).toBe("owner-dev");
    expect(chatGptOwner(undefined, { teamId: SLACK_TEAM, userId: sam }, slack)).toBe(`slack:${sam}`);
    expect(chatGptOwner(undefined, { kind: "developer", developerId: "d".repeat(64), provider: "oidc" }, slack)).toBe("d".repeat(64));
    expect(chatGptOwner(undefined, undefined, slack)).toBeUndefined();
  });
});

/** The control plane's connections, for the developers given; anyone else has none. */
function connections(views: Record<string, ChatGptConnectionView | "unreadable">) {
  const markStatus = vi.fn<(developerId: string, status: string) => Promise<void>>(async () => undefined);
  const refreshModels = vi.fn<(developerId: string) => Promise<void>>(async () => undefined);
  const accessToken = vi.fn(async (developerId: string) => ({ access: `access-for-${developerId.slice(0, 6)}`, expiresAt: Date.parse("2026-10-11T13:00:00.000Z"), models: [] }));
  const service = {
    view: vi.fn(async (developerId: string) => {
      const view = views[developerId];
      if (view === "unreadable") throw Object.assign(new Error("DynamoDB unavailable"), { name: "InternalServerError" });
      return view ?? { connected: false };
    }),
    accessToken,
    markStatus,
    refreshModels,
  } as unknown as ChatGptConnections;
  return { service, accessToken, markStatus, refreshModels };
}

async function taskFor(user: string, views: Record<string, ChatGptConnectionView | "unreadable">) {
  const { service, accessToken, markStatus, refreshModels } = connections(views);
  const { handler, db } = createBroker({ extra: { chatgpt: service } });
  await registerSlackProject(handler, { models });
  const workspace = await ensureWorkspace(handler, thread, user);
  const workspaceId = workspace.body.workspaceId as string;
  markReady(db, workspaceId);
  const conversation = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
  const conversationId = (conversation.body.conversation as { id: string }).id;
  const task = await serviceCall(handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
  expect(task.status).toBe(202);
  const operationId = (task.body.operation as { id: string }).id;
  const invocation = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { callbackCapability: string; payload: Record<string, unknown> };
  const actions = (JSON.parse(Buffer.from(invocation.callbackCapability.split(".")[0]!, "base64url").toString("utf8")) as { actions: string[] }).actions;
  const askToken = () => call(handler, {
    method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/chatgpt-token`,
    headers: { "x-agentx-callback-capability": invocation.callbackCapability }, body: {},
  });
  const tellStatus = (body: unknown) => call(handler, {
    method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/chatgpt-status`,
    headers: { "x-agentx-callback-capability": invocation.callbackCapability }, body,
  });
  return { db, invocation, actions, askToken, tellStatus, accessToken, markStatus, refreshModels, operation: db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`), current: () => db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${operationId}`) };
}

const connected: ChatGptConnectionView = { connected: true, status: "connected", email: "maya@acme.com", models: ["gpt-5.5", "gpt-6.1-sol"] };

describe("a task whose owner connected ChatGPT (#341)", () => {
  it("runs on the owner's plan, keeps the default to fall back to, and may ask for the owner's token only", async () => {
    const owner = developerIdForSlackUser(maya);
    const h = await taskFor(maya, { [owner]: connected });
    expect(h.invocation.payload.chatgpt).toEqual({ model: { provider: "openai", modelId: "gpt-6.1-sol" } });
    expect(h.invocation.payload.model).toEqual({ provider: "amazon-bedrock", modelId: "default-model" });
    expect(h.actions).toContain("chatgpt-token");
    expect(h.operation).toMatchObject({ chatgptDeveloperId: owner });
    const token = await h.askToken();
    expect(token).toMatchObject({ status: 200, body: { accessToken: `access-for-${owner.slice(0, 6)}`, expiresAt: "2026-10-11T13:00:00.000Z" } });
    expect(h.accessToken).toHaveBeenCalledWith(owner);
    // Nothing the worker is sent, or the outbox keeps, is a token.
    expect(JSON.stringify(h.invocation)).not.toContain("access-for");
  });

  it("runs on the default, and may not ask for a token, when the owner has no working connection", async () => {
    for (const view of [undefined, { ...connected, status: "revoked" as const }, { ...connected, status: "limit-reached" as const }, { ...connected, models: ["gpt-unknown-9"] }, "unreadable" as const]) {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const h = await taskFor(maya, view === undefined ? {} : { [developerIdForSlackUser(maya)]: view });
      log.mockRestore();
      expect(h.invocation.payload).not.toHaveProperty("chatgpt");
      expect(h.actions).not.toContain("chatgpt-token");
      expect(h.operation).not.toHaveProperty("chatgptDeveloperId");
      expect(await h.askToken()).toMatchObject({ body: { error: { code: "CALLBACK_FORBIDDEN" } } });
      expect(h.accessToken).not.toHaveBeenCalled();
    }
  });

  it("is someone else's connection only for their own tasks", async () => {
    const h = await taskFor(sam, { [developerIdForSlackUser(maya)]: connected });
    expect(h.invocation.payload).not.toHaveProperty("chatgpt");
  });
});

describe("the worker's side of a ChatGPT task (#341)", () => {
  it("keeps the token until shortly before it expires, and asks once for concurrent requests", async () => {
    let clock = Date.parse("2026-10-11T12:00:00.000Z");
    const expiry = (minutes: number) => new Date(clock + minutes * 60_000).toISOString();
    const fetchToken = vi.fn()
      .mockResolvedValueOnce({ accessToken: "access-1", expiresAt: expiry(60) })
      .mockResolvedValueOnce({ accessToken: "access-2", expiresAt: expiry(120) });
    const token = chatGptTokenSource(fetchToken, () => clock);
    expect(await Promise.all([token(), token(), token()])).toEqual(["access-1", "access-1", "access-1"]);
    clock += 60 * 60_000 - CHATGPT_TOKEN_MARGIN_MS - 1;
    expect(await token()).toBe("access-1");
    clock += 2;
    expect(await token()).toBe("access-2");
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it("refuses an answer that is not a token, without echoing it", async () => {
    const token = chatGptTokenSource(async () => ({ accessToken: "has a space", expiresAt: "2026-10-11T13:00:00.000Z" }));
    await expect(token()).rejects.toThrow(/^RUNTIME_UNAVAILABLE: the control plane answered the ChatGPT token request with something unexpected$/);
  });

  it("runs the plan's model when the token is there, and the default when it is not", async () => {
    const environment = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "default-model" };
    const payload = { model: { provider: "amazon-bedrock", modelId: "project-model" }, chatgpt: { model: { provider: "openai", modelId: "gpt-6.1-sol" } } };
    const onPlan = await resolveTaskSessionModel(payload, async () => "access-1", environment);
    expect(onPlan.model).toMatchObject({ provider: "openai", modelId: "gpt-6.1-sol" });
    expect(onPlan.piAdapter).toBeDefined();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const refused = await resolveTaskSessionModel(payload, async () => { throw new Error("AUTH_REQUIRED: revoked"); }, environment);
    expect(refused.model).toMatchObject({ provider: "amazon-bedrock", modelId: "project-model" });
    expect(refused.piAdapter).toBeUndefined();
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({ event: "model_fallback", reason: "chatgpt_unavailable", effective: { modelId: "project-model" } });
    info.mockRestore();
    const plain = await resolveTaskSessionModel({ model: payload.model }, undefined, environment);
    expect(plain).toEqual({ model: expect.objectContaining({ modelId: "project-model" }) as unknown });
  });
});

describe("a ChatGPT task that stopped using the plan (#342)", () => {
  const owner = () => developerIdForSlackUser(maya);

  it("marks a plan at its limit, once, and keeps the reason on the task", async () => {
    const h = await taskFor(maya, { [owner()]: connected });
    expect(h.actions).toContain("chatgpt-status");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await h.tellStatus({ reason: "limit" })).toMatchObject({ status: 200, body: { recorded: true } });
    expect(await h.tellStatus({ reason: "limit" })).toMatchObject({ status: 200, body: { recorded: false } });
    log.mockRestore();
    expect(h.markStatus).toHaveBeenCalledTimes(1);
    expect(h.markStatus).toHaveBeenCalledWith(owner(), "limit-reached");
    expect(h.current()).toMatchObject({ chatgptFallback: "limit" });
  });

  it("revokes a refused connection, and reads the model list again for a refused model", async () => {
    const revoked = await taskFor(maya, { [owner()]: connected });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await revoked.tellStatus({ reason: "revoked" });
    expect(revoked.markStatus).toHaveBeenCalledWith(owner(), "revoked");
    const model = await taskFor(maya, { [owner()]: connected });
    await model.tellStatus({ reason: "model" });
    log.mockRestore();
    expect(model.refreshModels).toHaveBeenCalledWith(owner());
    expect(model.markStatus).not.toHaveBeenCalled();
  });

  it("takes only a known reason, and only from a task on a plan", async () => {
    const h = await taskFor(maya, { [owner()]: connected });
    expect(await h.tellStatus({ reason: "bored" })).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    const plain = await taskFor(maya, {});
    expect(await plain.tellStatus({ reason: "limit" })).toMatchObject({ body: { error: { code: "CALLBACK_FORBIDDEN" } } });
  });

  it("leaves a plan at its limit alone for an hour, then tries it again", async () => {
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const recent = await taskFor(maya, { [owner()]: { ...connected, status: "limit-reached", statusAt: at(10) } });
    expect(recent.invocation.payload).not.toHaveProperty("chatgpt");
    const hourOld = await taskFor(maya, { [owner()]: { ...connected, status: "limit-reached", statusAt: at(61) } });
    expect(hourOld.invocation.payload.chatgpt).toEqual({ model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  });
});
