import { createHmac, hkdfSync, randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { WorkerInvocation } from "../../packages/contracts/src/index.js";
import { RepositoryGrantService } from "../../packages/broker/src/repository-access.js";
import { createWorkerCallbackSinks } from "../../packages/worker/src/callback-client.js";
import {
  SLACK_CHANNEL, SLACK_TEAM, call, createBroker, ensureWorkspace, finishOperation,
  loadSlackBroker, markReady, registerSlackProject, serviceCall,
} from "../support/slack-broker.js";

// Synthetic vector: HKDF-SHA256(UTF8("c" repeated 64),
// UTF8("agentx:callback-key-derivation:v1"), UTF8("agentx:cancel-callbacks:v1"), 32).
// Token fixtures deliberately do not call the production derivation or verifier.
const ROOT = "c".repeat(64);
const CHILD = Buffer.from("301ab48332d480814d0c7624fc8f3e3a40e5a811f1a7d236456e6b081189e9db", "hex");
const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
const user = "U0123456789";

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => vi.restoreAllMocks());

async function cancellation(options: Parameters<typeof createBroker>[0] = {}) {
  const broker = createBroker(options);
  await registerSlackProject(broker.handler);
  const workspaceId = (await ensureWorkspace(broker.handler, thread, user)).body.workspaceId as string;
  markReady(broker.db, workspaceId);
  const conversation = await serviceCall(broker.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/conversations`);
  const task = await serviceCall(broker.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, {
    requestId: randomUUID(), conversationId: (conversation.body.conversation as { id: string }).id, prompt: "run tests",
  });
  expect(task.status).toBe(202);
  const targetOperationId = (task.body.operation as { id: string }).id;
  const stop = await serviceCall(broker.handler, thread, user, "POST", `/v1/service/workspaces/${workspaceId}/operations/${targetOperationId}/cancel`);
  expect(stop.status).toBe(202);
  const operationId = (stop.body.operation as { id: string }).id;
  const invocation = broker.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as WorkerInvocation;
  const claims = {
    version: 1, purpose: "cancel-result", workspaceId, operationId, targetOperationId,
    fence: invocation.fence, actions: ["result"], expiresAt: Math.floor(Date.now() / 1000) + 32400,
  };
  return { ...broker, workspaceId, operationId, targetOperationId, invocation, claims };
}
type Fixture = Awaited<ReturnType<typeof cancellation>>;

function signBody(body: string, key = CHILD, prefix = "cancel-v1") {
  return `${prefix}.${body}.${createHmac("sha256", key).update(`${prefix}.${body}`).digest("base64url")}`;
}
function token(claims: unknown, key = CHILD) {
  return signBody(Buffer.from(JSON.stringify(claims)).toString("base64url"), key);
}
function callback(fixture: Fixture, capability: string, action = "result", route: { workspaceId?: string; operationId?: string } = {}) {
  return call(fixture.handler, {
    method: "POST", path: `/v1/internal/workspaces/${route.workspaceId ?? fixture.workspaceId}/operations/${route.operationId ?? fixture.operationId}/${action}`,
    headers: { "x-agentx-callback-capability": capability }, body: { status: "SUCCEEDED" },
  });
}
async function denied(fixture: Fixture, capability: string, action = "result", route = {}) {
  const before = structuredClone([...fixture.db.items]);
  const writes = vi.fn();
  const remove = fixture.db.onWrite(writes);
  const answer = await callback(fixture, capability, action, route);
  remove();
  expect(answer).toMatchObject({ status: 409, body: { error: { code: "CALLBACK_FORBIDDEN" } } });
  expect([...fixture.db.items]).toEqual(before);
  expect(writes).not.toHaveBeenCalled();
  expect(fixture.brokerInput.s3.send).not.toHaveBeenCalled();
  expect(fixture.brokerInput.githubPullRequests.reconcilePullRequest).not.toHaveBeenCalled();
  expect(fixture.brokerInput.githubPullRequests.updatePullRequest).not.toHaveBeenCalled();
  expect(fixture.brokerInput.codeBuild.start).not.toHaveBeenCalled();
  expect(JSON.stringify(answer.body)).not.toContain(capability);
  return answer;
}

describe("cancel-only callback verification (#201 Release A)", () => {
  it("accepts the pinned child-key vector through the unchanged worker callback client", async () => {
    const fixture = await cancellation();
    const invocation = { ...fixture.invocation, callbackCapability: token(fixture.claims) };
    const sinks = createWorkerCallbackSinks({
      controlPlaneUrl: "https://broker.example.test", invocation,
      fetchImplementation: async (input, init) => {
        const request = new Request(input, init);
        const answer = await call(fixture.handler, {
          method: request.method, path: new URL(request.url).pathname,
          headers: Object.fromEntries(request.headers), body: await request.json(),
        });
        return new Response(JSON.stringify(answer.body), { status: answer.status });
      },
    });
    await sinks.terminalSink({ operationId: fixture.operationId, status: "SUCCEEDED", result: { status: "CANCELLED" } });
    expect(fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, `OPERATION#${fixture.operationId}`)).toMatchObject({ status: "SUCCEEDED" });
    expect(fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, `OPERATION#${fixture.targetOperationId}`)).toMatchObject({ status: "CANCELLED" });
    expect(fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, "META")).not.toHaveProperty("activeOperationId");
    expect((await callback(fixture, invocation.callbackCapability)).status).toBe(200);
  });

  it("continues accepting previously queued root-signed cancel callbacks", async () => {
    const fixture = await cancellation();
    expect((await callback(fixture, fixture.invocation.callbackCapability)).status).toBe(200);
    expect(fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, `OPERATION#${fixture.targetOperationId}`)).toMatchObject({ status: "CANCELLED" });
  });

  it("preserves a target that completed through its own root-signed callback first", async () => {
    const fixture = await cancellation();
    await finishOperation(fixture.handler, fixture.db, fixture.workspaceId, fixture.targetOperationId, "SUCCEEDED");
    expect((await callback(fixture, token(fixture.claims))).status).toBe(200);
    expect(fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, `OPERATION#${fixture.targetOperationId}`)).toMatchObject({ status: "SUCCEEDED" });
  });

  it.each(["events", "artifacts", "pull-request", "pull-request-update", "codebuild"])("rejects child authority on %s even when its claims ask for it", async (action) => {
    const fixture = await cancellation();
    await denied(fixture, token(fixture.claims), action);
    await denied(fixture, token({ ...fixture.claims, actions: [action] }), action);
  });

  it.each([
    ["version", 2], ["purpose", "task-result"], ["actions", ["result", "artifacts"]], ["actions", []],
    ["workspaceId", "not-a-uuid"], ["operationId", 42], ["targetOperationId", null],
    ["fence", 0], ["fence", -1], ["fence", 1.5], ["fence", Number.MAX_SAFE_INTEGER + 1],
    ["expiresAt", "forever"], ["expiresAt", null], ["expiresAt", 1.5], ["expiresAt", Number.MAX_SAFE_INTEGER + 1],
    ["extra", "private-message-must-not-leak"],
  ])("rejects invalid claim %s=%j without effects", async (field, value) => {
    const fixture = await cancellation();
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const answer = await denied(fixture, token({ ...fixture.claims, [field]: value }));
    expect(answer.body.error).toEqual({ code: "CALLBACK_FORBIDDEN", message: "invalid cancel callback capability" });
    expect(JSON.stringify(logs.mock.calls)).not.toContain("private-message-must-not-leak");
  });

  it.each(["version", "purpose", "workspaceId", "operationId", "targetOperationId", "fence", "actions", "expiresAt"])("rejects missing %s", async (field) => {
    const fixture = await cancellation();
    const claims: Record<string, unknown> = { ...fixture.claims };
    delete claims[field];
    await denied(fixture, token(claims));
  });

  it.each([-1, 0, 32401])("rejects expiry offset %i seconds", async (offset) => {
    const fixture = await cancellation();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await denied(fixture, token({ ...fixture.claims, expiresAt: Math.floor(now / 1000) + offset }));
  });

  it.each(["workspaceId", "operationId", "targetOperationId", "fence"])("binds signed %s to the route and stored cancel", async (field) => {
    const fixture = await cancellation();
    await denied(fixture, token({ ...fixture.claims, [field]: field === "fence" ? fixture.claims.fence + 1 : randomUUID() }));
  });

  it("refuses a child token for an ordinary task's terminal result", async () => {
    const fixture = await cancellation();
    await denied(fixture, token({ ...fixture.claims, operationId: fixture.targetOperationId }), "result", { operationId: fixture.targetOperationId });
  });

  it.each(["missing", "fence", "workspace"])("rejects a %s target binding", async (mode) => {
    const fixture = await cancellation();
    const target = fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, `OPERATION#${fixture.targetOperationId}`)!;
    if (mode === "missing") fixture.db.delete(String(target.pk), String(target.sk));
    else if (mode === "fence") target.fence = fixture.claims.fence + 1;
    else target.workspaceId = randomUUID();
    await denied(fixture, token(fixture.claims));
  });

  it("keeps the existing stale-workspace guard after authenticating a child token", async () => {
    const fixture = await cancellation();
    const workspace = fixture.db.get(`WORKSPACE#${fixture.workspaceId}`, "META")!;
    workspace.fence = fixture.claims.fence + 1;
    const before = structuredClone([...fixture.db.items]);
    const answer = await callback(fixture, token(fixture.claims));
    expect(answer.body.error).toMatchObject({ code: "STALE_FENCE" });
    expect([...fixture.db.items]).toEqual(before);
  });

  it("rejects wrong-root, alternate-domain, root-signed and transport-text signatures", async () => {
    const fixture = await cancellation();
    const wrongRoot = Buffer.from(hkdfSync("sha256", "d".repeat(64), "agentx:callback-key-derivation:v1", "agentx:cancel-callbacks:v1", 32));
    const wrongDomain = Buffer.from(hkdfSync("sha256", ROOT, "agentx:callback-key-derivation:v1", "agentx:other-callbacks:v1", 32));
    for (const key of [wrongRoot, wrongDomain, Buffer.from(ROOT), Buffer.from(CHILD.toString("base64url"))]) {
      await denied(fixture, token(fixture.claims, key));
    }
  });

  it("never accepts the child key as a generic root capability or falls back on bad prefixes", async () => {
    const fixture = await cancellation();
    const body = Buffer.from(JSON.stringify(fixture.claims)).toString("base64url");
    const generic = `${body}.${createHmac("sha256", CHILD).update(body).digest("base64url")}`;
    for (const value of [generic, signBody(body, CHILD, "cancel-v2"), `cancel-v1.${fixture.invocation.callbackCapability}`, `${token(fixture.claims)}.extra`]) {
      await denied(fixture, value);
    }
  });

  it("rejects malformed JSON and noncanonical body or signature encodings", async () => {
    const fixture = await cancellation();
    const good = token(fixture.claims);
    const [, body, signature] = good.split(".");
    for (const value of [
      signBody(Buffer.from("{").toString("base64url")), signBody(Buffer.from("null").toString("base64url")),
      signBody(`${body}=`), signBody(`${body}\n`), signBody("!"),
      `cancel-v1.${body}.${signature}=`, `cancel-v1.${body}.!`, `cancel-v1..${signature}`,
      `cancel-v1.${body}.${"A".repeat(43)}`, `cancel-v1.${"A".repeat(8192)}.${signature}`,
    ]) await denied(fixture, value);
  });

  it("cannot mint a repository grant with the child or a repository key derived from it", async () => {
    const resolve = vi.fn(async () => ({ token: "must-not-be-issued" }));
    const realKey = createHmac("sha256", ROOT).update("agentx:repository-grants:v3").digest();
    const verifier = new RepositoryGrantService(realKey, resolve);
    const fixture = await cancellation({ extra: { repositoryGrants: verifier } });
    const scope = {
      ownerKey: "owner", projectName: "payments", workspaceId: fixture.workspaceId, operationId: fixture.operationId,
      repositories: [{ credentialRef: "github-app", repositoryUrl: "https://github.com/example/demo.git", access: "clone" as const }],
    };
    const forged = [CHILD, createHmac("sha256", CHILD).update("agentx:repository-grants:v3").digest()]
      .map((key) => new RepositoryGrantService(key, resolve).issue(scope));
    const before = structuredClone([...fixture.db.items]);
    for (const grant of [token(fixture.claims), ...forged]) {
      const answer = await call(fixture.handler, {
        method: "POST", path: `/v1/internal/workspaces/${fixture.workspaceId}/operations/${fixture.operationId}/repository-credentials`,
        headers: { "x-agentx-repository-grant": grant }, body: scope.repositories[0],
      });
      expect(answer).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    }
    expect([...fixture.db.items]).toEqual(before);
    expect(resolve).not.toHaveBeenCalled();
  });
});
