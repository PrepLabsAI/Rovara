import { describe, expect, it } from "vitest";
import {
  CallbackCapabilities,
  CallbackReceiver,
  InMemoryRegistry,
  OperationStore,
  OutboxConsumer,
  RetryingDispatcher,
} from "../../packages/broker/src/index.js";

function readyWorkspace() {
  const timestamp = new Date().toISOString();
  return {
    deploymentMode: "ec2-ebs" as const,
    id: crypto.randomUUID(),
    ownerKey: "alice-owner-key-0000",
    projectName: "payments",
    projectRevision: 1,
    environmentDigest: `repo@sha256:${"a".repeat(64)}`,
    rootPath: "/mnt/workspace" as const,
    status: "READY" as const,
    activeOperationId: null,
    fence: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("durable dispatch and callbacks", () => {
  it("retries dispatch and marks one outbox record delivered", async () => {
    const registry = new InMemoryRegistry();
    const workspace = await registry.createDefault(readyWorkspace());
    const operations = new OperationStore(registry);
    await operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      prompt: "run",
    });
    let attempts = 0;
    const dispatcher = new RetryingDispatcher(
      {
        async dispatch() {
          attempts += 1;
          if (attempts < 3) throw new Error("transient");
        },
      },
      { maxAttempts: 3, baseDelayMs: 0 },
    );
    const consumer = new OutboxConsumer(operations, dispatcher);
    await consumer.drain();
    expect(attempts).toBe(3);
    expect(operations.pendingOutbox()).toHaveLength(0);
  });

  it("rejects stale fences and capabilities without artifact scope", async () => {
    const registry = new InMemoryRegistry();
    const workspace = await registry.createDefault(readyWorkspace());
    const operations = new OperationStore(registry);
    const accepted = await operations.acceptTask(workspace.id, workspace.ownerKey, {
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      prompt: "run",
    });
    const capabilities = new CallbackCapabilities(Buffer.alloc(32, 7));
    const eventsOnly = capabilities.issue({
      workspaceId: workspace.id,
      operationId: accepted.operation.id,
      fence: accepted.operation.fence,
      actions: ["events"],
      expiresInSeconds: 60,
    });
    const receiver = new CallbackReceiver(registry, operations, capabilities);
    await expect(receiver.recordArtifact(eventsOnly, { name: "diff.patch" })).rejects.toThrow(/CALLBACK_FORBIDDEN/);
    await registry.forceFence(workspace.id);
    await expect(receiver.recordEvent(eventsOnly, { type: "progress", payload: "late" })).rejects.toThrow(
      /STALE_FENCE/,
    );
  });
});
