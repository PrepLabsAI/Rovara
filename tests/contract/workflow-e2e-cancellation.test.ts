import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerInvocationSchema } from "@agentx/contracts";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { OperationJournal } from "../../packages/worker/src/journal.js";
import { executeWorkerCancelInvocation } from "../../packages/worker/src/cancel-invocation.js";
import { executeWorkflowE2EChecks } from "../../packages/worker/src/workflow-e2e-checks.js";

describe("workflow E2E cancellation", () => {
  it("does not read a protected CHECKS admission after its operation has already been cancelled", async () => {
    const taskId = "44444444-4444-4444-8444-444444444444";
    const invocation = WorkerInvocationSchema.parse({
      protocolVersion: 1,
      kind: "task",
      operationId: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      fence: 1,
      projectRevision: 1,
      callbackCapability: "c".repeat(32),
      payload: {
        conversationId: "33333333-3333-4333-8333-333333333333",
        prompt: "Run the approved E2E checks.",
        workflowMode: "CHECKS",
        readiness: [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 }],
        workflowE2EAdmission: {
          schemaVersion: 1,
          taskId,
          workflowRevision: 8,
          candidateDigest: "a".repeat(64),
          roundId: "55555555-5555-4555-8555-555555555555",
          groupRunIds: ["66666666-6666-4666-8666-666666666666"],
          admissionRef: { key: `workflow-e2e-admissions/sha256/${"b".repeat(64)}.json`, sha256: "b".repeat(64), byteLength: 4096 },
        },
      },
    });
    const cancelled = new AbortController();
    cancelled.abort(new Error("operation cancelled"));
    const readAdmission = vi.fn(async () => { throw new Error("protected admission read must not occur"); });

    await expect(executeWorkflowE2EChecks({
      invocation,
      readAdmission,
      saveEvidence: async () => { throw new Error("cancelled execution must not save evidence"); },
      sourceRoot: "/workspace",
      evidenceRoot: "/evidence",
      signal: cancelled.signal,
    } as Parameters<typeof executeWorkflowE2EChecks>[0] & { signal: AbortSignal })).rejects.toThrow("operation cancelled");
    expect(readAdmission).not.toHaveBeenCalled();
  });

  it("uses the production cancel-invocation path to abort and journal the exact running operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentx-workflow-cancel-"));
    try {
      const targetOperationId = "11111111-1111-4111-8111-111111111111";
      const targetInvocation = WorkerInvocationSchema.parse({
        protocolVersion: 1, kind: "task", operationId: targetOperationId,
        workspaceId: "22222222-2222-4222-8222-222222222222", fence: 1, projectRevision: 1,
        callbackCapability: "c".repeat(32), payload: { conversationId: "33333333-3333-4333-8333-333333333333", prompt: "Run checks." },
      });
      const cancelInvocation = WorkerInvocationSchema.parse({
        protocolVersion: 1, kind: "cancel", operationId: "77777777-7777-4777-8777-777777777777",
        workspaceId: targetInvocation.workspaceId, fence: 2, projectRevision: 1,
        callbackCapability: "d".repeat(32), payload: { targetOperationId },
      });
      const journal = new OperationJournal(root);
      await journal.accept(targetInvocation);
      await journal.transition(targetOperationId, "RUNNING");
      const controller = new WorkerCancellationController();
      let aborted = false;
      controller.register(targetOperationId, { abort: async () => { aborted = true; } });

      const result = await executeWorkerCancelInvocation(cancelInvocation, controller, journal);

      expect(result).toEqual({ status: "CANCELLED", remainingProcesses: 0 });
      expect(aborted).toBe(true);
      expect(await journal.get(targetOperationId)).toMatchObject({ status: "CANCELLED" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
