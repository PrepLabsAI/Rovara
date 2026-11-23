import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { createWorkerServerState, handleWorkerRequest } from "../../packages/worker/src/server.js";

// Worker reproduction from the destructive-version lane; broker transaction races remain with their owner.
it("a completed plain-close preflight excludes a delayed older writer until deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "task-destructive-version-writer-"));
  const journal = new OperationJournal(root);
  const writes: string[] = [];
  const state = createWorkerServerState(journal, { execute: async (invocation) => {
    if (invocation.kind === "task") writes.push("new unpublished bytes");
    return { safeToClose: true, repositories: [] };
  } });
  const base = { protocolVersion: 1 as const, workspaceId: randomUUID(), projectRevision: 1, callbackCapability: "c".repeat(64) };
  const send = (invocation: WorkerInvocation) => handleWorkerRequest(new Request("http://worker/invocations", { method: "POST", body: JSON.stringify(invocation) }), state);
  try {
    expect((await send({ ...base, kind: "close", operationId: randomUUID(), fence: 9, payload: {} })).status).toBe(200);
    await vi.waitFor(() => expect(state.activeOperations.size).toBe(0));
    // Delivery was delayed while its broker operation was written off as lost.
    await send({ ...base, kind: "task", operationId: randomUUID(), fence: 8, payload: { conversationId: randomUUID(), prompt: "Write the fixture" } });
    await vi.waitFor(() => expect(state.activeOperations.size).toBe(0));
    expect(writes).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
