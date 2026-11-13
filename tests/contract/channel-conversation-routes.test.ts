// Spec 062 Phase 4: the orchestrator acts for an adapter conversation on the service routes. The broker checks the
// adapter, binding, link and developer on every call, and charges the workspace to the linked developer.
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { channelLinkKey, conversationOwnerIssuer, conversationSubject } from "@rovara-code/contracts";
import { ownerKeyForSubject } from "../../packages/core/src/aws/lambda.js";
import { releaseFailedPreparation } from "../../packages/core/src/aws/failed-preparation.js";
import { SLACK_TEAM, call, createBroker, loadSlackBroker, markReady, orchestratorPrincipal, registerSlackProject, type Handler } from "../support/slack-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const admin = { subject: "admin-subject", admin: true };
const developerId = "d".repeat(64);
const conversation = { channel: "whatsapp", tenant: "+14155550100", space: "group=AbC-12_x", thread: "main" };
const actor = { channel: "whatsapp", tenant: "+14155550100", userId: "+919876544821" };
const subject = conversationSubject(conversation);
const ownerKey = ownerKeyForSubject(conversationOwnerIssuer("whatsapp"), subject);

beforeAll(async () => { await loadSlackBroker(); });

async function setup(options: { memberLimit?: number; link?: boolean; revoked?: boolean; slackUserId?: string } = {}) {
  const harness = createBroker({
    ...(options.memberLimit === undefined ? {} : { memberLimit: options.memberLimit }),
    extra: {
      channelAdapters: { secretPrefix: "agentx/test/", secrets: { put: vi.fn(async () => undefined) } },
      developer: {
        issuer: "https://rovara.example.com", env: "test", methods: { slack: true, oidc: true }, slackTeamId: SLACK_TEAM, signInTableName: "signin",
        channelMembers: async () => ({ ok: true as const, memberOf: [] }),
      },
    },
  });
  await registerSlackProject(harness.handler);
  const as = (method: string, path: string, body?: unknown) => call(harness.handler, { method, path, user: admin, ...(body === undefined ? {} : { body }) });
  expect((await as("PUT", "/v1/admin/channels/whatsapp", {
    callbackUrl: "https://adapter.example.com/rovara",
    capabilities: { threads: false, buttons: 3, edits: false, maxTextLength: 4096, proactive: false },
    projects: ["payments"],
  })).status).toBe(200);
  expect((await as("PUT", `/v1/admin/channels/whatsapp/bindings/${encodeURIComponent(conversation.tenant)}/${encodeURIComponent(conversation.space)}`, { projectName: "payments" })).status).toBe(200);
  if (options.link !== false) harness.db.set({ ...channelLinkKey(actor), entityType: "CHANNEL_LINK", actor, developerId, linkedAt: "2026-11-08T10:00:00.000Z" });
  harness.db.set({
    pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://login.example.com", subject: "ada", displayName: "Ada Lovelace",
    firstSignInAt: "2026-11-01T00:00:00.000Z", lastSignInAt: "2026-11-01T00:00:00.000Z", revoked: options.revoked === true,
    ...(options.slackUserId === undefined ? {} : { slackUserId: options.slackUserId }),
  });
  return { ...harness, as };
}

function service(handler: Handler, path: string, body: unknown, headers: Record<string, string> = {}) {
  return call(handler, {
    method: "POST", path, service: { principal: orchestratorPrincipal },
    headers: { "x-agentx-conversation": subject, "x-agentx-actor": actor.userId, ...headers },
    body,
  });
}

const ensure = (handler: Handler, extra: Record<string, unknown> = {}) =>
  service(handler, "/v1/service/threads/workspace", { requestId: randomUUID(), lazyPreparation: true, includeSettingsRevision: true, ...extra });
const prepare = (handler: Handler) => service(handler, "/v1/service/threads/workspace/prepare", { requestId: randomUUID() });

describe("an adapter conversation's workspace", () => {
  it("is created unprepared, owned by the conversation, with the developer as its creator", async () => {
    const { handler, db } = await setup();
    const answer = await ensure(handler);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: "WORKSPACE", status: "UNPREPARED", created: true });
    const workspace = db.get(`WORKSPACE#${answer.body.workspaceId as string}`, "META");
    expect(workspace).toMatchObject({ ownerKey, projectName: "payments" });
    expect(db.get(`SLACK_THREAD#${ownerKey}`, "META")).toMatchObject({ entityType: "CHANNEL_THREAD", thread: subject, creator: { developerId, name: "Ada Lovelace" } });
    // The same conversation answers the same workspace.
    expect((await ensure(handler)).body.workspaceId).toBe(answer.body.workspaceId);
  });

  it("is prepared on the developer's charge, and the operation names the developer", async () => {
    const { handler, db } = await setup();
    const workspaceId = (await ensure(handler)).body.workspaceId as string;
    const prepared = await prepare(handler);
    expect(prepared.body).toMatchObject({ outcome: "WORKSPACE", status: "PREPARING", created: true });
    const charge = { member: { pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER" }, organization: { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION" } };
    expect(db.get(`SLACK_THREAD#${ownerKey}`, "META")).toMatchObject({ starterDeveloperId: developerId, charge, workspaceId });
    expect(db.get(charge.member.pk, charge.member.sk)).toMatchObject({ count: 1, tasks: new Set([`conversation:${subject}`]) });
    expect(db.get(charge.organization.pk, charge.organization.sk)).toMatchObject({ count: 1 });
    const operation = db.find((item) => item.entityType === "OPERATION" && item.workspaceId === workspaceId)[0];
    expect(operation).toMatchObject({ kind: "prepare", requestedBy: { kind: "developer", developerId, provider: "oidc" } });
  });

  it("shares the Slack member's counter when the developer is linked to Slack (R6)", async () => {
    const { handler, db } = await setup({ slackUserId: "U0MAYA001" });
    await ensure(handler);
    await prepare(handler);
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "MEMBER#U0MAYA001")).toMatchObject({ count: 1 });
  });

  it("is refused at the developer's limit", async () => {
    const { handler, db } = await setup({ memberLimit: 1 });
    db.set({ pk: `DEVELOPER_LIMIT#${developerId}`, sk: "MEMBER", entityType: "DEVELOPER_LIMIT", count: 1, tasks: new Set(["7f1c2a4e-9b0d-4c3e-8a5f-1d2e3f4a5b6c"]) });
    await ensure(handler);
    expect((await prepare(handler)).body).toMatchObject({ outcome: "LIMIT_REACHED", limit: "MEMBER", maximum: 1, starterThreads: [] });
  });

  it("gives the charge back when its preparation fails", async () => {
    const { handler, db } = await setup();
    const workspaceId = (await ensure(handler)).body.workspaceId as string;
    await prepare(handler);
    const workspace = db.get(`WORKSPACE#${workspaceId}`, "META")!;
    workspace.status = "PREPARATION_FAILED";
    delete workspace.activeOperationId;
    expect(await releaseFailedPreparation(db, "state", workspaceId, () => undefined)).toBe("released");
    expect(db.get(`DEVELOPER_LIMIT#${developerId}`, "MEMBER")).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_THREAD#${ownerKey}`, "META")?.starterDeveloperId).toBeUndefined();
    expect(await releaseFailedPreparation(db, "state", workspaceId, () => undefined)).not.toBe("released");
  });

  it("closes on the starter's word and gives the developer's slot back", async () => {
    const { handler, db } = await setup();
    const workspaceId = (await ensure(handler)).body.workspaceId as string;
    await prepare(handler);
    markReady(db, workspaceId);
    const started = await service(handler, "/v1/service/threads/workspace/close", { requestId: randomUUID() });
    expect(started.status).toBe(202);
    const operationId = started.body.operationId as string;
    // An adapter actor is not a Slack member, so the workspace records no Slack closer; the operation names the developer.
    expect(db.get(`WORKSPACE#${workspaceId}`, "META")?.closedBy).toBeUndefined();
    await succeed(handler, db, workspaceId, operationId);
    const closed = await service(handler, "/v1/service/threads/workspace/close/complete", { requestId: randomUUID(), operationId });
    expect(closed.body).toMatchObject({ outcome: "CLOSED", workspaceId });
    expect(db.get(`DEVELOPER_LIMIT#${developerId}`, "MEMBER")).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_LIMIT#${SLACK_TEAM}`, "ORGANIZATION")).toMatchObject({ count: 0 });
    expect(db.get(`SLACK_THREAD#${ownerKey}`, "META")).toMatchObject({ closeOperationId: operationId });
    expect(typeof db.get(`SLACK_THREAD#${ownerKey}`, "META")?.closedAt).toBe("string");
    // Repeated, the close answers the same and gives nothing back twice.
    expect((await service(handler, "/v1/service/threads/workspace/close/complete", { requestId: randomUUID(), operationId })).body).toMatchObject({ outcome: "CLOSED" });
    expect(db.get(`DEVELOPER_LIMIT#${developerId}`, "MEMBER")).toMatchObject({ count: 0 });
  });

  it("answers the project's models through the binding", async () => {
    const { handler } = await setup();
    const answer = await call(handler, { method: "GET", path: "/v1/service/project/models", service: { principal: orchestratorPrincipal }, headers: { "x-agentx-conversation": subject, "x-agentx-actor": actor.userId } });
    // registerSlackProject sets no models: the route is reached, and refuses for the project, not the caller.
    expect(answer.body).toMatchObject({ error: { code: "CONFIG_INVALID" } });
  });
});

describe("an adapter conversation is refused (fail closed)", () => {
  it.each([
    ["an unlinked actor", { link: false }],
    ["a revoked developer", { revoked: true }],
  ])("for %s", async (_name, options) => {
    const { handler } = await setup(options);
    expect((await ensure(handler)).status).toBe(403);
  });

  it("for a space no longer bound, or an adapter removed", async () => {
    const unbound = await setup();
    await unbound.as("DELETE", `/v1/admin/channels/whatsapp/bindings/${encodeURIComponent(conversation.tenant)}/${encodeURIComponent(conversation.space)}`);
    expect((await ensure(unbound.handler)).status).toBe(403);
    const removed = await setup();
    await removed.as("DELETE", "/v1/admin/channels/whatsapp");
    expect((await ensure(removed.handler)).status).toBe(403);
  });

  it("for Slack-only routes, an actor from another tenant, and a call naming both a Slack thread and a conversation", async () => {
    const { handler } = await setup();
    // A Slack-started task's thread note, which only a Slack thread has.
    expect((await service(handler, "/v1/service/tasks/thread-notes/answered", { taskId: randomUUID(), messageTs: "1695500000.000009" })).status).toBe(403);
    expect((await ensure(handler, {})).status).toBe(200);
    const otherTenant = await call(handler, {
      method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal },
      headers: { "x-agentx-conversation": subject.replace("+14155550100", "+14155550199"), "x-agentx-actor": actor.userId }, body: { requestId: randomUUID(), lazyPreparation: true },
    });
    expect(otherTenant.status).toBe(403);
    expect((await service(handler, "/v1/service/threads/workspace", { requestId: randomUUID(), lazyPreparation: true }, { "x-agentx-slack-thread": `${SLACK_TEAM}/C0123456789/1695500000.000001` })).status).toBe(400);
  });

  it("for a Slack subject or a missing actor in the conversation headers", async () => {
    const { handler } = await setup();
    const bad = (headers: Record<string, string>) => call(handler, { method: "POST", path: "/v1/service/threads/workspace", service: { principal: orchestratorPrincipal }, headers, body: { requestId: randomUUID(), lazyPreparation: true } });
    expect((await bad({ "x-agentx-conversation": `${SLACK_TEAM}/C0123456789/1695500000.000001`, "x-agentx-actor": "U0123456789" })).status).toBe(400);
    expect((await bad({ "x-agentx-conversation": subject })).status).toBe(400);
  });

  it("for a caller that is not the orchestrator role", async () => {
    const { handler } = await setup();
    const answer = await call(handler, {
      method: "POST", path: "/v1/service/threads/workspace", service: { principal: "arn:aws:sts::111122223333:assumed-role/Other/x" },
      headers: { "x-agentx-conversation": subject, "x-agentx-actor": actor.userId }, body: { requestId: randomUUID(), lazyPreparation: true },
    });
    expect(answer.status).toBe(403);
  });

  it("when the deployment has no channel adapters", async () => {
    const harness = createBroker();
    await registerSlackProject(harness.handler);
    expect((await ensure(harness.handler)).status).toBe(404);
  });
});

async function succeed(handler: Handler, db: FakeDynamoDb, workspaceId: string, operationId: string): Promise<void> {
  const outbox = db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0];
  const capability = (outbox?.invocation as { callbackCapability?: string } | undefined)?.callbackCapability;
  if (capability === undefined) throw new Error("close callback capability is missing");
  const response = await call(handler, {
    method: "POST", path: `/v1/internal/workspaces/${workspaceId}/operations/${operationId}/result`,
    headers: { "x-agentx-callback-capability": capability },
    body: { operationId, status: "SUCCEEDED", result: { safeToClose: true, repositories: [] } },
  });
  expect(response.status).toBe(200);
}
