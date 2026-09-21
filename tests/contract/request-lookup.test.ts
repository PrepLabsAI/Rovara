import { createHash, randomUUID } from "node:crypto";
import { SignJWT, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Operation } from "@agentx/contracts";
import {
  InMemoryRegistry,
  JwtAuthenticator,
  OperationStore,
  createBrokerHandler,
  parseRequestLookupPath,
  taskPayloadHash,
  type BrokerRequest,
  type ProjectMembership,
} from "../../packages/broker/src/index.js";
import vectors from "../fixtures/p02-request-recovery.json" with { type: "json" };

const issuer = "https://identity.example.test";
const audience = "agentx";
const ownerKeyFor = (subject: string) =>
  createHash("sha256").update(issuer).update("\0").update(subject).digest("hex");

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;

beforeAll(async () => {
  keys = await generateKeyPair("ES256");
});

async function token(subject: string, { expired = false } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(expired ? now - 7200 : now)
    .setExpirationTime(expired ? now - 3600 : now + 3600)
    .sign(keys.privateKey);
}

function workspaceRecord(ownerKey: string) {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    ownerKey,
    projectName: "payments",
    projectRevision: 1,
    environmentDigest: `repo@sha256:${"a".repeat(64)}`,
    runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agentx",
    endpointQualifier: "DEFAULT",
    runtimeSessionId: randomUUID(),
    deploymentMode: "instances-ebs" as const,
    capacityProviderArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/agentx",
    rootPath: "/mnt/workspace" as const,
    status: "READY" as const,
    activeOperationId: null,
    fence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function harness(options: { memberships?: readonly ProjectMembership[] } = {}) {
  const ownerKey = ownerKeyFor("alice");
  const registry = new InMemoryRegistry();
  const workspace = await registry.createDefault(workspaceRecord(ownerKey));
  const operations = new OperationStore(registry);
  const acquireWriter = vi.spyOn(registry, "acquireWriter");
  const acceptTask = vi.spyOn(operations, "acceptTask");
  const handler = createBrokerHandler({
    authenticator: new JwtAuthenticator(
      { issuer, audience, adminClaim: "groups", adminValues: ["admins"] },
      async () => keys.publicKey,
    ),
    memberships: options.memberships ?? [{ ownerKey, project: "payments", role: "developer" }],
    registry,
    operations,
  });
  const call = async (path: string, subject = "alice", overrides: Partial<BrokerRequest> = {}) => {
    const bearer = overrides.headers ? {} : { authorization: `Bearer ${await token(subject)}` };
    const response = await handler({
      method: "GET",
      path,
      headers: { ...bearer, ...overrides.headers },
      ...overrides,
    });
    return {
      status: response.statusCode,
      body: JSON.parse(response.body) as { operation?: Operation; error?: { code: string; message: string } },
    };
  };
  const snapshot = () => structuredClone({
    workspaces: [...registry.workspaces.entries()],
    defaults: [...registry.defaults.entries()],
    operations: [...operations.operations.entries()],
    idempotency: [...operations.idempotency.entries()],
    outbox: [...operations.outbox.entries()],
    events: [...operations.events.entries()],
  });
  /** Clear setup-time calls so an assertion only covers what the lookup itself did. */
  const arm = () => { acquireWriter.mockClear(); acceptTask.mockClear(); };
  return { ownerKey, registry, operations, workspace, call, snapshot, arm, acquireWriter, acceptTask };
}

const lookupPath = (workspaceId: string, requestId: string) =>
  `/v1/workspaces/${workspaceId}/requests/${requestId}`;

describe("request lookup path matching", () => {
  it("matches only well-formed UUID pairs", () => {
    const workspaceId = randomUUID();
    const requestId = randomUUID();
    expect(parseRequestLookupPath(lookupPath(workspaceId, requestId)))
      .toEqual({ workspaceId, requestId });
    // Identifiers are preserved exactly. Acceptance keys its index on the verbatim string,
    // so folding case here would look up a key acceptance never wrote.
    expect(parseRequestLookupPath(lookupPath(workspaceId.toUpperCase(), requestId)))
      .toEqual({ workspaceId: workspaceId.toUpperCase(), requestId });
    expect(parseRequestLookupPath(lookupPath(workspaceId, requestId.toUpperCase())))
      .toEqual({ workspaceId, requestId: requestId.toUpperCase() });
    const mixed = "AaAaAAAA-aaaa-4AAA-8aAA-AAAAaaaaAAAA";
    expect(parseRequestLookupPath(lookupPath(workspaceId, mixed)))
      .toEqual({ workspaceId, requestId: mixed });
    for (const path of [
      lookupPath("not-a-uuid", requestId),
      lookupPath(workspaceId, "../../admin"),
      lookupPath(workspaceId, `${requestId}extra`),
      `/v1/workspaces/${workspaceId}/requests`,
      `/v1/workspaces/${workspaceId}/requests/${requestId}/events`,
      `/v1/workspaces/${workspaceId}/operations/${requestId}`,
    ]) {
      expect(parseRequestLookupPath(path)).toBeUndefined();
    }
  });
});

describe("generic broker request recovery", () => {
  it("REVIEW recovers an accepted uppercase request ID without creating new work", async () => {
    const h = await harness();
    const request = { requestId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", conversationId: randomUUID(), prompt: "Add a check" };
    const accepted = await h.call(`/v1/workspaces/${h.workspace.id}/tasks`, "alice", {method: "POST", body: JSON.stringify(request)});
    expect(accepted.status).toBe(202);
    const before = h.snapshot();
    const recovered = await h.call(lookupPath(h.workspace.id, request.requestId));
    expect(recovered.status).toBe(200);
    expect(recovered.body.operation?.id).toBe(accepted.body.operation?.id);
    expect(h.snapshot()).toEqual(before);
  });

  it.each([
    ["uppercase", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"],
    ["mixed-case", "CcCcCCCC-cccc-4CCC-8cCC-CCCCccccCCCC"],
  ])("submits and recovers a %s request id through the real handlers", async (_label, requestId) => {
    const h = await harness();
    const request = { requestId, conversationId: randomUUID(), prompt: "Add a check" };

    const accepted = await h.call(`/v1/workspaces/${h.workspace.id}/tasks`, "alice", {
      method: "POST", body: JSON.stringify(request),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body.operation?.requestId).toBe(requestId);

    const before = h.snapshot();
    h.arm();
    const recovered = await h.call(lookupPath(h.workspace.id, requestId));

    expect(recovered.status).toBe(200);
    expect(recovered.body.operation?.id).toBe(accepted.body.operation?.id);
    // Stored identity is preserved verbatim, not normalized on the way out.
    expect(recovered.body.operation?.requestId).toBe(requestId);
    expect(recovered.body.operation?.payloadHash).toBe(taskPayloadHash(request));

    // Read-only, and no second job.
    expect(h.snapshot()).toEqual(before);
    expect(h.acceptTask).not.toHaveBeenCalled();
    expect(h.acquireWriter).not.toHaveBeenCalled();
    expect(h.operations.pendingOutbox()).toHaveLength(1);
  });

  it("still refuses a case-variant request id to another owner", async () => {
    const h = await harness({
      memberships: [
        { ownerKey: ownerKeyFor("alice"), project: "payments", role: "developer" },
        { ownerKey: ownerKeyFor("mallory"), project: "payments", role: "developer" },
      ],
    });
    const requestId = "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD";
    const request = { requestId, conversationId: randomUUID(), prompt: "Add a check" };
    expect((await h.call(`/v1/workspaces/${h.workspace.id}/tasks`, "alice", {
      method: "POST", body: JSON.stringify(request),
    })).status).toBe(202);
    const before = h.snapshot();
    h.arm();

    const stranger = await h.call(lookupPath(h.workspace.id, requestId), "mallory");

    expect(stranger.status).toBe(404);
    expect(stranger.body.operation).toBeUndefined();
    expect(h.snapshot()).toEqual(before);
    expect(h.acceptTask).not.toHaveBeenCalled();
  });

  it("treats a different spelling of the same UUID as a different request identity", async () => {
    const h = await harness();
    const submitted = "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE";
    const request = { requestId: submitted, conversationId: randomUUID(), prompt: "Add a check" };
    expect((await h.call(`/v1/workspaces/${h.workspace.id}/tasks`, "alice", {
      method: "POST", body: JSON.stringify(request),
    })).status).toBe(202);
    const before = h.snapshot();
    h.arm();

    // Acceptance keys its index on the verbatim string, so the lowercase spelling is a
    // different identity and was never accepted. Reporting it as found would hand back an
    // operation the caller did not submit; reporting 404 is correct, and per
    // docs/p02-request-recovery.md a 404 must not trigger a resubmission.
    const other = await h.call(lookupPath(h.workspace.id, submitted.toLowerCase()));

    expect(other.status).toBe(404);
    expect(other.body.operation).toBeUndefined();
    expect(h.snapshot()).toEqual(before);
    expect(h.acceptTask).not.toHaveBeenCalled();
    expect(h.acquireWriter).not.toHaveBeenCalled();
    expect(h.operations.pendingOutbox()).toHaveLength(1);
  });

  it("returns the already accepted operation to its authenticated owner", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    const accepted = await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    const before = h.snapshot();
    h.arm();

    const response = await h.call(lookupPath(h.workspace.id, request.requestId));

    expect(response.status).toBe(200);
    expect(response.body.operation).toEqual(accepted.operation);
    expect(response.body.operation?.payloadHash).toBe(taskPayloadHash(request));
    expect(h.snapshot()).toEqual(before);
    expect(h.acquireWriter).not.toHaveBeenCalled();
    expect(h.acceptTask).not.toHaveBeenCalled();
    expect(h.operations.pendingOutbox()).toHaveLength(1);
  });

  it.each(["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const)(
    "recovers a %s operation without changing it",
    async (status) => {
      const h = await harness();
      const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
      const accepted = await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
      const transitioned = h.operations.transition(accepted.operation.id, status);
      const before = h.snapshot();

      const response = await h.call(lookupPath(h.workspace.id, request.requestId));

      expect(response.status).toBe(200);
      expect(response.body.operation).toEqual(transitioned);
      expect(h.snapshot()).toEqual(before);
    },
  );

  it("does not disclose the operation to another authenticated owner", async () => {
    const h = await harness({
      memberships: [
        { ownerKey: ownerKeyFor("alice"), project: "payments", role: "developer" },
        { ownerKey: ownerKeyFor("mallory"), project: "payments", role: "developer" },
      ],
    });
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    const before = h.snapshot();
    h.arm();

    const response = await h.call(lookupPath(h.workspace.id, request.requestId), "mallory");

    expect(response.status).toBe(404);
    expect(response.body.operation).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(request.conversationId);
    expect(h.snapshot()).toEqual(before);
  });

  it("stops disclosing the operation once project membership is revoked", async () => {
    const h = await harness({ memberships: [] });
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    const before = h.snapshot();
    h.arm();

    const response = await h.call(lookupPath(h.workspace.id, request.requestId));

    expect(response.status).toBe(404);
    expect(response.body.operation).toBeUndefined();
    expect(h.snapshot()).toEqual(before);
  });

  it("rejects an expired token before reading anything", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    const before = h.snapshot();
    h.arm();

    const response = await h.call(lookupPath(h.workspace.id, request.requestId), "alice", {
      headers: { authorization: `Bearer ${await token("alice", { expired: true })}` },
    });

    // The security-relevant invariant: an expired token discloses nothing and changes nothing.
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body.operation).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(request.conversationId);
    expect(h.snapshot()).toEqual(before);
    expect(h.acceptTask).not.toHaveBeenCalled();
    expect(h.acquireWriter).not.toHaveBeenCalled();

    // KNOWN GAP, pinned rather than silently changed: createBrokerHandler maps a jose
    // verification failure through its generic catch, so an expired token answers
    // 400 CONFIG_INVALID instead of the 401 AUTH_REQUIRED a missing token answers. Correcting
    // it would change authentication semantics for every route on this handler, which is
    // outside the read-only lookup contract. Recorded in docs/p02-request-recovery.md.
    expect(response.status).toBe(400);
    expect(response.body.error?.code).toBe("CONFIG_INVALID");
  });

  it("rejects a missing bearer token", async () => {
    const h = await harness();
    const response = await h.call(lookupPath(h.workspace.id, randomUUID()), "alice", { headers: {} });
    expect(response.status).toBe(401);
    expect(response.body.error?.code).toBe("AUTH_REQUIRED");
  });

  it("reports an unknown request and an unknown workspace as not found", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    const before = h.snapshot();
    h.arm();

    expect((await h.call(lookupPath(h.workspace.id, randomUUID()))).status).toBe(404);
    expect((await h.call(lookupPath(randomUUID(), request.requestId))).status).toBe(404);

    expect(h.snapshot()).toEqual(before);
    expect(h.acceptTask).not.toHaveBeenCalled();
    expect(h.acquireWriter).not.toHaveBeenCalled();
  });

  it("does not route a malformed identifier to storage", async () => {
    const h = await harness();
    const response = await h.call(`/v1/workspaces/${h.workspace.id}/requests/not-a-uuid`);
    expect(response.status).toBe(404);
    expect(response.body.error?.code).toBe("NOT_FOUND");
    expect(response.body.error?.message).toBe("NOT_FOUND: route not found");
  });

  it("reports a dangling index as a storage failure rather than absence", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    const accepted = await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    h.operations.operations.delete(accepted.operation.id);
    h.arm();

    const response = await h.call(lookupPath(h.workspace.id, request.requestId));

    expect(response.status).toBe(503);
    expect(response.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(response.body.error?.code).not.toBe("NOT_FOUND");
    expect(response.body.operation).toBeUndefined();
    expect(h.acceptTask).not.toHaveBeenCalled();
  });

  it("reports an unexpected storage failure without leaking its detail or a row", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    vi.spyOn(h.operations, "getByRequest").mockImplementation(() => {
      throw new Error("dynamodb throttled: secret-table-detail");
    });
    h.arm();

    const response = await h.call(lookupPath(h.workspace.id, request.requestId));

    expect(response.status).toBe(503);
    expect(response.body.error?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(JSON.stringify(response.body)).not.toContain("secret-table-detail");
    expect(JSON.stringify(response.body)).not.toContain(request.conversationId);
    expect(h.acceptTask).not.toHaveBeenCalled();
  });

  it("stays read-only under repeated recovery attempts", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check" };
    await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
    const before = h.snapshot();
    h.arm();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await h.call(lookupPath(h.workspace.id, request.requestId))).status).toBe(200);
    }

    expect(h.snapshot()).toEqual(before);
    expect(h.operations.pendingOutbox()).toHaveLength(1);
    expect(h.acquireWriter).not.toHaveBeenCalled();
    expect(h.acceptTask).not.toHaveBeenCalled();
  });
});

describe("published compatibility vectors", () => {
  it("still describes the implemented hash for every vector", () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);
    for (const vector of vectors.vectors) {
      expect(taskPayloadHash(vector.request as never)).toBe(vector.payloadHash);
    }
  });

  it("matches the route this lane implements", () => {
    const workspaceId = randomUUID();
    const requestId = randomUUID();
    expect(vectors.route.method).toBe("GET");
    expect(
      parseRequestLookupPath(
        vectors.route.path.replace("{workspaceId}", workspaceId).replace("{requestId}", requestId),
      ),
    ).toEqual({ workspaceId, requestId });
  });

  it("drives the real handler with the published vectors", async () => {
    for (const vector of vectors.vectors) {
      const h = await harness();
      const request = { ...(vector.request as Record<string, unknown>), requestId: randomUUID() } as never;
      const accepted = await h.operations.acceptTask(h.workspace.id, h.ownerKey, request);
      expect(accepted.operation.payloadHash).toBe(vector.payloadHash);
      const response = await h.call(lookupPath(h.workspace.id, accepted.operation.requestId));
      expect(response.status).toBe(200);
      expect(response.body.operation?.payloadHash).toBe(vector.payloadHash);
    }
  });
});
