import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RequestIndexIntegrityError, taskPayloadHash } from "@agentx/broker";
import type { WorkerInvocation } from "@agentx/contracts";
import { openHostDatabase } from "../src/store/database.js";
import { SqliteRegistry } from "../src/store/sqlite-registry.js";
import { SqliteOperationStore } from "../src/store/sqlite-operations.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function databaseFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agentx-host-store-"));
  roots.push(root);
  return join(root, "host.sqlite");
}

function workspaceRecord(ownerKey = "a".repeat(64)) {
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

function projectDefinition(revision = 1) {
  return {
    schemaVersion: 2 as const,
    name: "payments",
    revision,
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


/** The smallest real task invocation the store can queue for these store-level tests. */
function invocationBuilder(workspaceId: string) {
  return {
    invocation: ({ operationId, fence, request }: {
      operationId: string; fence: number; request: { conversationId: string; prompt: string };
    }): WorkerInvocation => ({
      protocolVersion: 1, kind: "task", operationId, workspaceId, fence, projectRevision: 1,
      callbackCapability: "c".repeat(64),
      payload: { conversationId: request.conversationId, prompt: request.prompt },
    }),
  };
}

const administrator = { ownerKey: "a".repeat(64), isAdministrator: true } as never;
const memberships = [{ ownerKey: "a".repeat(64), project: "payments", role: "administrator" as const }];

describe("durable host stores", () => {
  it("keeps projects, workspaces, conversations and operations across a reopen", async () => {
    const file = await databaseFile();
    const requestId = randomUUID();
    let workspaceId: string;
    let operationId: string;

    {
      const database = openHostDatabase(file);
      const registry = new SqliteRegistry(database);
      const operations = new SqliteOperationStore(database, registry);
      registry.registerProject(administrator, projectDefinition(), memberships);
      const workspace = await registry.createDefault(workspaceRecord());
      workspaceId = workspace.id;
      registry.createConversation(workspace.id, randomUUID());
      const conversationId = registry.listConversations(workspace.id)[0]!;
      const accepted = await operations.acceptTask(workspace.id, workspace.ownerKey, {
        requestId, conversationId, prompt: "Add a check",
      }, invocationBuilder(workspace.id));
      operationId = accepted.operation.id;
      database.close();
    }

    const database = openHostDatabase(file);
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);

    expect(registry.getProject("payments", 1)?.definition.name).toBe("payments");
    expect((await registry.get(workspaceId))?.id).toBe(workspaceId);
    expect(registry.listConversations(workspaceId)).toHaveLength(1);
    expect(operations.get(operationId)?.id).toBe(operationId);
    expect(operations.getByRequest(workspaceId, "a".repeat(64), requestId)?.id).toBe(operationId);
    expect(operations.pendingOutbox()).toHaveLength(1);
    database.close();
  });

  it("refuses a second workspace writer and releases it durably", async () => {
    const database = openHostDatabase(await databaseFile());
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);
    const workspace = await registry.createDefault(workspaceRecord());
    const conversationId = randomUUID();
    registry.createConversation(workspace.id, conversationId);

    const first = await operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId: randomUUID(), conversationId, prompt: "first",
    }, invocationBuilder(workspace.id));
    await expect(operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId: randomUUID(), conversationId, prompt: "second",
    }, invocationBuilder(workspace.id))).rejects.toThrow(/WORKSPACE_BUSY/);

    await registry.releaseWriter(workspace.id, first.operation.id);
    expect((await registry.get(workspace.id))?.activeOperationId).toBeNull();
    database.close();
  });

  it("treats request identifiers as binary and case-sensitive", async () => {
    const database = openHostDatabase(await databaseFile());
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);
    const workspace = await registry.createDefault(workspaceRecord());
    const conversationId = randomUUID();
    registry.createConversation(workspace.id, conversationId);
    const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

    const accepted = await operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId: upper, conversationId, prompt: "Add a check",
    }, invocationBuilder(workspace.id));

    expect(operations.getByRequest(workspace.id, workspace.ownerKey, upper)?.id)
      .toBe(accepted.operation.id);
    expect(operations.getByRequest(workspace.id, workspace.ownerKey, upper.toLowerCase()))
      .toBeUndefined();
    expect(accepted.operation.requestId).toBe(upper);
    database.close();
  });

  it("conflicts when changed material reuses a request identifier", async () => {
    const database = openHostDatabase(await databaseFile());
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);
    const workspace = await registry.createDefault(workspaceRecord());
    const conversationId = randomUUID();
    registry.createConversation(workspace.id, conversationId);
    const request = {
      requestId: randomUUID(), conversationId, prompt: "Add a check",
      candidate: { jobId: randomUUID(), attempt: 1, repository: "app", baseCommit: "a".repeat(40) },
    };

    const accepted = await operations.acceptTask(workspace.id, workspace.ownerKey, request, invocationBuilder(workspace.id));
    expect(accepted.operation.payloadHash).toBe(taskPayloadHash(request));
    const replay = await operations.acceptTask(workspace.id, workspace.ownerKey, request, invocationBuilder(workspace.id));
    expect(replay.duplicate).toBe(true);
    expect(replay.operation.id).toBe(accepted.operation.id);

    for (const change of [
      { prompt: "different" },
      { candidate: { ...request.candidate, baseCommit: "b".repeat(40) } },
      { candidate: { ...request.candidate, jobId: randomUUID() } },
    ]) {
      await expect(operations.acceptTask(workspace.id, workspace.ownerKey, { ...request, ...change }, invocationBuilder(workspace.id)))
        .rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    }

    expect(operations.pendingOutbox()).toHaveLength(1);
    expect(operations.countOperations()).toBe(1);
    database.close();
  });

  it("reports a dangling request index as unavailable, never as absence", async () => {
    const database = openHostDatabase(await databaseFile());
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);
    const workspace = await registry.createDefault(workspaceRecord());
    const conversationId = randomUUID();
    registry.createConversation(workspace.id, conversationId);
    const requestId = randomUUID();
    await operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId, conversationId, prompt: "Add a check",
    }, invocationBuilder(workspace.id));

    database.exec(`UPDATE request_index SET operation_id = '${randomUUID()}' WHERE request_id = '${requestId}'`);

    expect(() => operations.getByRequest(workspace.id, workspace.ownerKey, requestId))
      .toThrow(RequestIndexIntegrityError);
    database.close();
  });

  it("writes the operation, request index and outbox in one transaction", async () => {
    const database = openHostDatabase(await databaseFile());
    const registry = new SqliteRegistry(database);
    const operations = new SqliteOperationStore(database, registry);
    const workspace = await registry.createDefault(workspaceRecord());
    const conversationId = randomUUID();
    registry.createConversation(workspace.id, conversationId);

    // A conversation that does not exist must abort the whole accept, leaving no
    // partial operation, index entry, outbox row or writer lease behind.
    await expect(operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId: randomUUID(), conversationId: randomUUID(), prompt: "Add a check",
    }, invocationBuilder(workspace.id))).rejects.toThrow(/NOT_FOUND/);

    expect(operations.countOperations()).toBe(0);
    expect(operations.pendingOutbox()).toHaveLength(0);
    expect((await registry.get(workspace.id))?.activeOperationId).toBeNull();
    expect((await registry.get(workspace.id))?.fence).toBe(1);
    database.close();
  });

  it("records events and artifact metadata durably and rehashes artifact bytes", async () => {
    const file = await databaseFile();
    let operationId = "";
    let workspaceId = "";
    {
      const database = openHostDatabase(file);
      const registry = new SqliteRegistry(database);
      const operations = new SqliteOperationStore(database, registry);
      const workspace = await registry.createDefault(workspaceRecord());
      workspaceId = workspace.id;
      const conversationId = randomUUID();
      registry.createConversation(workspace.id, conversationId);
      const accepted = await operations.acceptTask(workspace.id, workspace.ownerKey, {
        requestId: randomUUID(), conversationId, prompt: "Add a check",
      }, invocationBuilder(workspace.id));
      operationId = accepted.operation.id;
      operations.appendEvents(operationId, [{ type: "progress", payload: { step: 1 } }]);
      operations.putArtifact({
        operationId, workspaceId, name: "workspace.diff",
        mediaType: "text/plain; charset=utf-8", content: Buffer.from("+2\n").toString("base64"),
      });
      database.close();
    }

    const database = openHostDatabase(file);
    const operations = new SqliteOperationStore(database, new SqliteRegistry(database));
    expect(operations.listEvents(operationId)).toHaveLength(1);
    const artifacts = operations.listArtifacts(operationId);
    expect(artifacts).toHaveLength(1);
    const artifact = operations.getArtifact(workspaceId, artifacts[0]!.id);
    expect(Buffer.from(artifact!.content, "base64").toString("utf8")).toBe("+2\n");
    expect(() => operations.putArtifact({
      operationId, workspaceId, name: artifacts[0]!.name,
      mediaType: "text/plain; charset=utf-8", content: Buffer.from("tampered").toString("base64"),
    })).toThrow(/IDEMPOTENCY_CONFLICT/);
    database.close();
  });
});
