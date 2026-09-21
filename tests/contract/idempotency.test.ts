import { describe, expect, it } from "vitest";
import { InMemoryRegistry, OperationStore, taskPayloadHash } from "../../packages/broker/src/index.js";

function workspace(ownerKey = "alice-owner-key-0000") {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerKey,
    projectName: "payments",
    projectRevision: 1,
    environmentDigest: `repo@sha256:${"a".repeat(64)}`,
    runtimeArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/agentx",
    endpointQualifier: "DEFAULT",
    runtimeSessionId: crypto.randomUUID(),
    deploymentMode: "instances-ebs" as const,
    capacityProviderArn:
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:capacity-provider/agentx",
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

  it("conflicts on a changed candidate instead of replaying another job", async () => {
    const registry = new InMemoryRegistry();
    const storedWorkspace = await registry.createDefault(workspace());
    const operations = new OperationStore(registry);
    const request = {
      requestId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      prompt: "Keep caf\u00e9 labels",
      candidate: {
        jobId: crypto.randomUUID(),
        attempt: 1,
        repository: "payments",
        baseCommit: "a".repeat(40),
      },
    };
    const accepted = await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, request);
    expect(accepted.operation.payloadHash).toBe(taskPayloadHash(request));

    const replay = await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, request);
    expect(replay.duplicate).toBe(true);
    expect(replay.operation.id).toBe(accepted.operation.id);

    const changes = [
      { jobId: crypto.randomUUID() },
      { attempt: 2 },
      { repository: "billing" },
      { baseCommit: "b".repeat(40) },
    ];
    for (const change of changes) {
      await expect(
        operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, {
          ...request,
          candidate: { ...request.candidate, ...change },
        }),
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
    }

    expect(operations.pendingOutbox()).toHaveLength(1);
    expect(operations.operations.size).toBe(1);
  });

  it("replays the same job when only the key order of an identical request changes", async () => {
    const registry = new InMemoryRegistry();
    const storedWorkspace = await registry.createDefault(workspace());
    const operations = new OperationStore(registry);
    const requestId = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    const candidate = { jobId: crypto.randomUUID(), attempt: 1, repository: "payments", baseCommit: "a".repeat(40) };
    const accepted = await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, {
      requestId, conversationId, prompt: "Keep caf\u00e9 labels", candidate,
    });
    const reordered = await operations.acceptTask(storedWorkspace.id, storedWorkspace.ownerKey, {
      candidate: {
        baseCommit: candidate.baseCommit,
        repository: candidate.repository,
        attempt: candidate.attempt,
        jobId: candidate.jobId,
      },
      prompt: "Keep caf\u00e9 labels",
      conversationId,
      requestId,
    });
    expect(reordered.duplicate).toBe(true);
    expect(reordered.operation.id).toBe(accepted.operation.id);
    expect(operations.pendingOutbox()).toHaveLength(1);
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
