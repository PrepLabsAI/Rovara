import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { taskPayloadHash, type AuthenticatedIdentity } from "@agentx/broker";
import type { Operation, WorkerInvocation } from "@agentx/contracts";
import { openHostDatabase } from "../src/store/database.js";
import { SqliteRegistry } from "../src/store/sqlite-registry.js";
import { SqliteOperationStore } from "../src/store/sqlite-operations.js";
import { createLocalBrokerHandler } from "../src/routes.js";
import { mintCallbackCapability } from "../src/capability.js";

const roots: string[] = [];
const callbackSigningKey = randomBytes(32);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function identity(subject: string, isAdministrator = false): AuthenticatedIdentity {
  return {
    issuer: "https://identity.example.test",
    subject,
    ownerKey: subject.padEnd(64, "0"),
    isAdministrator,
    claims: {},
  };
}

function projectDefinition() {
  return {
    schemaVersion: 2 as const,
    name: "payments",
    revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
    environment: { image: `registry.example.test/worker@sha256:${"a".repeat(64)}` },
    repositories: [{
      name: "app", url: "https://github.com/example/app.git", path: "repo/app",
      defaultBranch: "main", credentialRef: "github-app",
    }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate",
  };
}

function workspaceRecord(ownerKey: string) {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    ownerKey,
    projectName: "payments",
    projectRevision: 1,
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
    endpointQualifier: "DEFAULT",
    runtimeSessionId: randomUUID(),
    deploymentMode: "demo-microvm" as const,
    rootPath: "/mnt/workspace" as const,
    status: "READY" as const,
    activeOperationId: null,
    fence: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "agentx-host-routes-"));
  roots.push(root);
  const database = openHostDatabase(join(root, "host.sqlite"));
  const registry = new SqliteRegistry(database);
  const operations = new SqliteOperationStore(database, registry);
  const alice = identity("alice", true);
  const memberships = [
    { ownerKey: alice.ownerKey, project: "payments", role: "administrator" as const },
    { ownerKey: identity("mallory").ownerKey, project: "payments", role: "developer" as const },
  ];
  let caller = alice;
  const handler = createLocalBrokerHandler({
    registry, operations, memberships, callbackSigningKey,
    resolveIdentity: async () => caller,
  });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await handler({
      method, path, headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };

  registry.registerProject(alice, projectDefinition(), memberships);
  const workspace = await registry.createDefault(workspaceRecord(alice.ownerKey));
  const conversationId = registry.createConversation(workspace.id, randomUUID());

  return {
    database, registry, operations, workspace, conversationId, alice, memberships, call,
    as: (next: AuthenticatedIdentity) => { caller = next; },
    outboxInvocation: () => operations.pendingOutbox()[0]!.invocation as Extract<WorkerInvocation, { kind: "task" }>,
  };
}

describe("local broker routes", () => {
  it("accepts a task, queues one invocation and mints a fence-bound capability", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check" };

    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, request);

    expect(accepted.status).toBe(202);
    const operation = (accepted.body as { operation: Operation }).operation;
    expect(operation.payloadHash).toBe(taskPayloadHash(request));
    const invocation = h.outboxInvocation();
    expect(invocation.operationId).toBe(operation.id);
    expect(invocation.fence).toBe(operation.fence);
    expect(invocation.payload.conversationId).toBe(h.conversationId);
    expect(h.operations.pendingOutbox()).toHaveLength(1);
    h.database.close();
  });

  it("takes the caller only from the trusted adapter, never from the body", async () => {
    const h = await harness();

    // A body naming another owner is refused as a server-controlled field, and the
    // identity used for authorization is the adapter's, not anything the caller sent.
    const forged = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check",
      ownerKey: identity("mallory").ownerKey,
    });
    expect(forged.status).toBe(403);

    h.as(identity("mallory"));
    const stranger = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check",
    });
    expect(stranger.status).toBe(404);
    expect(h.operations.countOperations()).toBe(0);
    h.database.close();
  });

  it("recovers an accepted request read-only, byte for byte", async () => {
    const h = await harness();
    const requestId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId, conversationId: h.conversationId, prompt: "Add a check",
    });
    expect(accepted.status).toBe(202);

    const recovered = await h.call("GET", `/v1/workspaces/${h.workspace.id}/requests/${requestId}`);
    expect(recovered.status).toBe(200);
    expect((recovered.body as { operation: Operation }).operation.id)
      .toBe((accepted.body as { operation: Operation }).operation.id);

    // A different spelling is a different request identity, and an unknown request is
    // simply not found — neither may cause a second job.
    expect((await h.call("GET", `/v1/workspaces/${h.workspace.id}/requests/${requestId.toLowerCase()}`)).status)
      .toBe(404);
    expect((await h.call("GET", `/v1/workspaces/${h.workspace.id}/requests/${randomUUID()}`)).status).toBe(404);
    expect(h.operations.countOperations()).toBe(1);
    expect(h.operations.pendingOutbox()).toHaveLength(1);
    h.database.close();
  });

  it("accepts a worker callback only for its exact operation and fence", async () => {
    const h = await harness();
    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check",
    });
    const operation = (accepted.body as { operation: Operation }).operation;
    const invocation = h.outboxInvocation();
    const events = `/v1/internal/workspaces/${h.workspace.id}/operations/${operation.id}/events`;

    const ok = await h.call("POST", events, { events: [{ type: "progress", payload: { step: 1 } }] },
      { "x-agentx-callback-capability": invocation.callbackCapability });
    expect(ok.status).toBe(200);

    // A capability the worker minted for itself, one bound to a different fence, an
    // expired one, and a missing one are all refused: a worker claim is not authority.
    for (const capability of [
      mintCallbackCapability({
        key: randomBytes(32), workspaceId: h.workspace.id, operationId: operation.id,
        fence: operation.fence, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      mintCallbackCapability({
        key: callbackSigningKey, workspaceId: h.workspace.id, operationId: operation.id,
        fence: operation.fence + 1, expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      mintCallbackCapability({
        key: callbackSigningKey, workspaceId: h.workspace.id, operationId: operation.id,
        fence: operation.fence, expiresAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    ]) {
      const refused = await h.call("POST", events, { events: [{ type: "progress", payload: {} }] },
        { "x-agentx-callback-capability": capability });
      // CALLBACK_FORBIDDEN is 409 in the existing AgentX error contract, which this host
      // reuses rather than redefining. The code is the meaningful assertion.
      expect(refused.status).toBe(409);
      expect((refused.body as { error: { code: string } }).error.code).toBe("CALLBACK_FORBIDDEN");
    }
    const missing = await h.call("POST", events, { events: [] });
    expect(missing.status).toBe(409);
    expect((missing.body as { error: { code: string } }).error.code).toBe("CALLBACK_FORBIDDEN");
    expect(h.operations.listEvents(operation.id)).toHaveLength(1);
    h.database.close();
  });

  it("refuses a capability pointed at another operation in the same workspace", async () => {
    const h = await harness();
    const first = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "first",
    });
    const operation = (first.body as { operation: Operation }).operation;
    const stolen = h.outboxInvocation().callbackCapability;

    const refused = await h.call(
      "POST",
      `/v1/internal/workspaces/${h.workspace.id}/operations/${randomUUID()}/events`,
      { events: [{ type: "progress", payload: {} }] },
      { "x-agentx-callback-capability": stolen },
    );

    expect(refused.status).toBe(409);
    expect((refused.body as { error: { code: string } }).error.code).toBe("CALLBACK_FORBIDDEN");
    expect(h.operations.listEvents(operation.id)).toHaveLength(0);
    h.database.close();
  });

  it("stores an artifact through a callback and serves it back to its owner only", async () => {
    const h = await harness();
    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check",
    });
    const operation = (accepted.body as { operation: Operation }).operation;
    const capability = h.outboxInvocation().callbackCapability;
    const content = Buffer.from("candidate bytes").toString("base64");

    const stored = await h.call(
      "POST", `/v1/internal/workspaces/${h.workspace.id}/operations/${operation.id}/artifacts`,
      { name: "workspace.diff", mediaType: "text/plain; charset=utf-8", content },
      { "x-agentx-callback-capability": capability },
    );
    expect(stored.status).toBe(200);
    const artifactId = (stored.body as { artifactId: string }).artifactId;

    const fetched = await h.call("GET", `/v1/workspaces/${h.workspace.id}/artifacts/${artifactId}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as { artifact: { content: string } }).artifact.content).toBe(content);

    h.as(identity("mallory"));
    expect((await h.call("GET", `/v1/workspaces/${h.workspace.id}/artifacts/${artifactId}`)).status).toBe(404);
    h.database.close();
  });

  it("settles a terminal result, releases the writer and refuses a changed repeat", async () => {
    const h = await harness();
    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check",
    });
    const operation = (accepted.body as { operation: Operation }).operation;
    const capability = h.outboxInvocation().callbackCapability;
    const result = `/v1/internal/workspaces/${h.workspace.id}/operations/${operation.id}/result`;
    const headers = { "x-agentx-callback-capability": capability };

    expect((await h.call("POST", result, { status: "SUCCEEDED", result: { ok: true } }, headers)).status).toBe(200);
    // A worker that lost our reply repeats the identical result; that is not a conflict.
    expect((await h.call("POST", result, { status: "SUCCEEDED", result: { ok: true } }, headers)).status).toBe(200);
    // A different outcome for the same operation is refused.
    expect((await h.call("POST", result, { status: "FAILED" }, headers)).status).toBe(409);

    expect((await h.registry.get(h.workspace.id))?.activeOperationId).toBeNull();
    expect((await h.registry.get(h.workspace.id))?.status).toBe("READY");
    h.database.close();
  });

  it("requests cancellation once and queues exactly one cancel invocation", async () => {
    const h = await harness();
    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check",
    });
    const operation = (accepted.body as { operation: Operation }).operation;
    const path = `/v1/workspaces/${h.workspace.id}/operations/${operation.id}/cancel`;

    expect((await h.call("POST", path, {})).status).toBe(202);
    expect((await h.call("POST", path, {})).status).toBe(202);

    const pending = h.operations.pendingOutbox();
    expect(pending.filter((record) => record.invocation.kind === "cancel")).toHaveLength(1);
    expect(h.operations.get(operation.id)?.status).toBe("CANCEL_REQUESTED");
    h.database.close();
  });

  it("refuses an unknown route and a malformed identifier without touching storage", async () => {
    const h = await harness();
    for (const path of [
      "/v1/nope",
      `/v1/workspaces/not-a-uuid/tasks`,
      `/v1/workspaces/${h.workspace.id}/requests/not-a-uuid`,
    ]) {
      const response = await h.call("GET", path);
      expect(response.status).toBe(404);
    }
    expect(h.operations.countOperations()).toBe(0);
    h.database.close();
  });
});
