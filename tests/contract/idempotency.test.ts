import { describe, expect, it } from "vitest";
import { InMemoryRegistry, OperationStore } from "../../packages/broker/src/index.js";

function workspace(ownerKey = "alice-owner-key-0000") {
  const timestamp = new Date().toISOString();
  return {
    deploymentMode: "ec2-ebs" as const,
    id: crypto.randomUUID(),
    ownerKey,
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

describe("workspace registry and idempotent operations", () => {
  it("conditionally creates one default workspace per owner/project", async () => {
    const registry = new InMemoryRegistry();
    const input = workspace();
    const [first, second] = await Promise.all([
      registry.createDefault(input),
      registry.createDefault({ ...input, id: crypto.randomUUID() }),
    ]);
    expect(first.id).toBe(second.id);
  });

  it("returns one operation for identical retries and rejects key reuse", async () => {
    const registry = new InMemoryRegistry();
    const storedWorkspace = await registry.createDefault(workspace());
    const operations = new OperationStore(registry);
    const requestId = crypto.randomUUID();
    const request = {
      requestId,
      conversationId: crypto.randomUUID(),
      prompt: "add an endpoint",
    };
    const first = await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, request);
    const duplicate = await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, request);
    expect(duplicate.operation.id).toBe(first.operation.id);
    expect(operations.pendingOutbox()).toHaveLength(1);
    await expect(
      operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, {
        ...request,
        prompt: "different payload",
      }),
    ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("allows only one active writer", async () => {
    const registry = new InMemoryRegistry();
    const storedWorkspace = await registry.createDefault(workspace());
    const operations = new OperationStore(registry);
    await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, {
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      prompt: "first",
    });
    await expect(
      operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, {
        requestId: crypto.randomUUID(),
        conversationId: crypto.randomUUID(),
        prompt: "second",
      }),
    ).rejects.toThrow(/WORKSPACE_BUSY/);
  });
});
