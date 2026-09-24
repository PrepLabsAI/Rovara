import { randomUUID } from "node:crypto";
import {
  CallbackCapabilities,
  InMemoryRegistry,
  OperationStore,
  OwnerScopedOutputStore,
  WorkerCallbackService,
  type AuthenticatedIdentity,
} from "../../packages/broker/src/index.js";
import { describe, expect, it } from "vitest";

describe("worker usage event compatibility", () => {
  it("accepts and stores the usage event through the open control-plane event contract", async () => {
    const registry = new InMemoryRegistry();
    const owner = identity();
    const workspaceId = randomUUID();
    const now = new Date().toISOString();
    await registry.createDefault({
      id: workspaceId,
      ownerKey: owner.ownerKey,
      projectName: "usage",
      projectRevision: 1,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: randomUUID(),
      deploymentMode: "demo-microvm",
      rootPath: "/mnt/workspace",
      status: "READY",
      preparationManifest: ".agentx/preparation-manifest.json",
      activeOperationId: null,
      fence: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operations = new OperationStore(registry);
    const accepted = await operations.acceptTask(workspaceId, owner.ownerKey, {
      requestId: randomUUID(),
      conversationId: randomUUID(),
      prompt: "record usage",
    });
    const workspace = await registry.get(workspaceId);
    if (!workspace?.activeOperationId) throw new Error("workspace operation was not acquired");
    const capabilities = new CallbackCapabilities(Buffer.alloc(32, 7));
    const token = capabilities.issue({
      workspaceId,
      operationId: accepted.operation.id,
      fence: workspace.fence,
      actions: ["events"],
      expiresInSeconds: 60,
    });
    const outputs = new OwnerScopedOutputStore(registry);
    const service = new WorkerCallbackService({ capabilities, registry, operations, outputs });
    const payload = {
      schemaVersion: 1,
      outcome: "SUCCEEDED",
      provider: "amazon-bedrock",
      modelId: "model",
      cacheRetention: "long",
      tokens: { input: 10, output: 2, cacheRead: 8, cacheWrite: 1, total: 21 },
      cacheReadRatio: 8 / 19,
      costUsd: 0.001,
    };

    await expect(service.appendEvents(token, workspaceId, accepted.operation.id, {
      events: [{ type: "usage", timestamp: now, payload }],
    })).resolves.toEqual({ accepted: 1 });
    await expect(outputs.pageEvents(owner, workspaceId, accepted.operation.id)).resolves.toMatchObject({
      events: [{ type: "usage", payload }],
    });
  });
});

function identity(): AuthenticatedIdentity {
  const ownerKey = "a".repeat(64);
  return {
    issuer: "https://identity.example.test",
    subject: "usage-user",
    ownerKey,
    isAdministrator: false,
    claims: {},
  };
}
