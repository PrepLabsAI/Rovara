import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseRequestLookupPath,
  taskPayloadHash,
  type AuthenticatedIdentity,
} from "@agentx/broker";
import type { Operation, WorkerInvocation } from "@agentx/contracts";
import { openHostDatabase } from "../src/store/database.js";
import { SqliteRegistry } from "../src/store/sqlite-registry.js";
import { SqliteOperationStore } from "../src/store/sqlite-operations.js";
import { createLocalBrokerHandler } from "../src/routes.js";
import vectors from "../../../tests/fixtures/p02-request-recovery.json" with { type: "json" };

/**
 * The digest the coordinator accepted and other lanes pin.
 *
 * The local host is a new transport for the same contract, so this file must not move.
 * If a change here is ever genuinely needed it is a versioned contract migration, not an
 * edit: every limit this host enforces is carried out of band precisely so the hashed
 * payload, and therefore this digest, stay exactly as they were.
 */
const ACCEPTED_FIXTURE_DIGEST = "3982a8cf4cf86343ab65ab9338c5c2f3e81b503df44c6fe4934712b11679910d";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity: AuthenticatedIdentity = {
  issuer: "https://identity.example.test",
  subject: "alice",
  ownerKey: "alice".padEnd(64, "0"),
  isAdministrator: true,
  claims: {},
};

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "agentx-host-parity-"));
  roots.push(root);
  const database = openHostDatabase(join(root, "host.sqlite"));
  const registry = new SqliteRegistry(database);
  const operations = new SqliteOperationStore(database, registry);
  const memberships = [{ ownerKey: identity.ownerKey, project: "payments", role: "administrator" as const }];
  // The published vectors bind candidates to the `team-tasks` repository, so the fixture
  // project registers it and the candidate vectors exercise the real acceptance path.
  registry.registerProject(identity, {
    schemaVersion: 2, name: "payments", revision: 1,
    controlPlaneUrl: "https://agentx.example.test",
    auth: { issuer: "https://identity.example.test", clientId: "agentx", audience: "agentx" },
    environment: { image: `registry.example.test/worker@sha256:${"a".repeat(64)}` },
    repositories: [{
      name: "team-tasks", url: "https://github.com/example/team-tasks.git", path: "repo/team-tasks",
      defaultBranch: "main", credentialRef: "github-app",
    }],
    setup: [], readiness: [], orchestratorInstructions: "Delegate",
  }, memberships);
  const timestamp = new Date().toISOString();
  const workspace = await registry.createDefault({
    id: randomUUID(), ownerKey: identity.ownerKey, projectName: "payments", projectRevision: 1,
    environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
    runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
    endpointQualifier: "DEFAULT", runtimeSessionId: randomUUID(), deploymentMode: "demo-microvm",
    rootPath: "/mnt/workspace", status: "READY", activeOperationId: null, fence: 1,
    createdAt: timestamp, updatedAt: timestamp,
  });
  const conversationId = registry.createConversation(workspace.id, randomUUID());
  const handler = createLocalBrokerHandler({
    registry, operations,
    memberships,
    callbackSigningKey: randomBytes(32),
    resolveIdentity: async () => identity,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handler({
      method, path, headers: {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  return { database, registry, operations, workspace, conversationId, call };
}

describe("published request-recovery contract", () => {
  it("still ships the exact accepted fixture bytes", async () => {
    const bytes = await readFile(join(import.meta.dirname, "../../../tests/fixtures/p02-request-recovery.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(ACCEPTED_FIXTURE_DIGEST);
  });

  it("hashes every published vector identically on this host", async () => {
    expect(vectors.vectors.length).toBeGreaterThan(0);
    for (const vector of vectors.vectors) {
      expect(taskPayloadHash(vector.request as never)).toBe(vector.payloadHash);
    }
  });

  it("serves the published route shape", () => {
    const workspaceId = randomUUID();
    const requestId = randomUUID();
    expect(vectors.route.method).toBe("GET");
    expect(
      parseRequestLookupPath(
        vectors.route.path.replace("{workspaceId}", workspaceId).replace("{requestId}", requestId),
      ),
    ).toEqual({ workspaceId, requestId });
  });

  it("accepts and recovers each published vector through the durable host", async () => {
    for (const vector of vectors.vectors) {
      const h = await harness();
      const request = {
        ...(vector.request as Record<string, unknown>),
        requestId: randomUUID(),
        conversationId: h.conversationId,
      };

      const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, request);
      expect(accepted.status).toBe(202);
      const operation = (accepted.body as { operation: Operation }).operation;
      expect(operation.payloadHash).toBe(taskPayloadHash(request as never));

      const recovered = await h.call(
        "GET", `/v1/workspaces/${h.workspace.id}/requests/${operation.requestId}`,
      );
      expect(recovered.status).toBe(200);
      expect((recovered.body as { operation: Operation }).operation.payloadHash).toBe(operation.payloadHash);
      h.database.close();
    }
  });

  it("carries per-job limits out of band, never in the hashed payload", async () => {
    const h = await harness();
    const request = { requestId: randomUUID(), conversationId: h.conversationId, prompt: "Add a check" };

    const accepted = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, request);
    expect(accepted.status).toBe(202);

    // The wire payload is exactly conversationId, prompt and an optional candidate. A
    // deadline, budget or path allowlist added here would change every stored hash and
    // break the accepted fixture, which is why enforcement lives at trusted boundaries.
    const invocation = h.operations.pendingOutbox()[0]!.invocation as Extract<WorkerInvocation, { kind: "task" }>;
    expect(Object.keys(invocation.payload).sort()).toEqual(["conversationId", "prompt"]);
    expect((accepted.body as { operation: Operation }).operation.payloadHash).toBe(taskPayloadHash(request));

    const rejected = await h.call("POST", `/v1/workspaces/${h.workspace.id}/tasks`, {
      ...request, requestId: randomUUID(), deadline: "2026-09-23T00:00:00Z", maximumMicrounits: 1_000,
    });
    expect(rejected.status).toBe(400);
    h.database.close();
  });
});
