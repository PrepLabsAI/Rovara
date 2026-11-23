import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { executeWorkerCancelInvocation } from "../../packages/worker/src/cancel-invocation.js";
import { closeInvocationResult } from "../../packages/worker/src/close-workspace.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "worker-destructive-fence-"));
  roots.push(root);
  const journal = new OperationJournal(root);
  const base = { protocolVersion: 1 as const, operationId: randomUUID(), workspaceId: randomUUID(), projectRevision: 1, callbackCapability: "c".repeat(64), fence: 9 };
  const older: WorkerInvocation = { ...base, kind: "task", operationId: randomUUID(), fence: 8, payload: { conversationId: randomUUID(), prompt: "Write" } };
  return { root, journal, base, older };
}

it("a direct close raises the durable fence even when its busy check fails", async () => {
  const h = await fixture();
  await expect(closeInvocationResult(h.root, () => true, h.base)).rejects.toMatchObject({ code: "WORKSPACE_BUSY" });
  await expect(new OperationJournal(h.root).accept(h.older)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});

it("a direct cancel persists its fence before tombstoning a delayed operation", async () => {
  const h = await fixture();
  const cancel: Extract<WorkerInvocation, { kind: "cancel" }> = { ...h.base, kind: "cancel", payload: { targetOperationId: randomUUID() } };
  await expect(executeWorkerCancelInvocation(cancel, new WorkerCancellationController(), h.journal)).resolves.toMatchObject({ status: "CANCELLED" });
  await expect(new OperationJournal(h.root).accept(h.older)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
});
