import { randomUUID } from "node:crypto";
import { InMemoryRegistry, OperationStore, OutboxConsumer } from "../../packages/broker/src/index.js";
import { describe, expect, it } from "vitest";

describe("accepted task recovery", () => {
  it("keeps accepted work discoverable and starts at most one run across dispatcher restart", async () => {
    const registry = new InMemoryRegistry();
    const ownerKey = "a".repeat(64);
    const now = new Date().toISOString();
    const workspace = await registry.createDefault({
      id: randomUUID(),
      ownerKey,
      projectName: "payments",
      projectRevision: 1,
      environmentDigest: `registry.example.test/worker@sha256:${"a".repeat(64)}`,
      runtimeArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/agentx",
      endpointQualifier: "DEFAULT",
      runtimeSessionId: randomUUID(),
      deploymentMode: "instances-ebs",
      capacityProviderArn: "arn:aws:bedrock-agentcore:us-east-1:111122223333:capacity-provider/agentx",
      rootPath: "/mnt/workspace",
      status: "READY",
      preparationManifest: ".agentx/preparation-manifest.json",
      activeOperationId: null,
      fence: 1,
      createdAt: now,
      updatedAt: now,
    });
    const operations = new OperationStore(registry);
    const request = { requestId: randomUUID(), conversationId: randomUUID(), prompt: "run remotely" };
    const accepted = await operations.acceptTask(workspace.id, ownerKey, request);

    const failedDispatcher = new OutboxConsumer(operations, {
      dispatch: async () => {
        throw new Error("dispatcher stopped after durable acceptance");
      },
    });
    await expect(failedDispatcher.drain()).rejects.toThrow(/stopped/);
    expect(operations.get(accepted.operation.id)?.status).toBe("ACCEPTED");
    expect(operations.pendingOutbox()).toHaveLength(1);

    let starts = 0;
    const replacementDispatcher = new OutboxConsumer(operations, {
      dispatch: async () => {
        starts += 1;
      },
    });
    await replacementDispatcher.drain();
    await replacementDispatcher.drain();
    expect(starts).toBe(1);
    expect(operations.pendingOutbox()).toHaveLength(0);

    const retry = await operations.acceptTask(workspace.id, ownerKey, request);
    expect(retry.duplicate).toBe(true);
    expect(retry.operation.id).toBe(accepted.operation.id);
    expect(starts).toBe(1);
  });
});
