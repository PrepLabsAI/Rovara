import type { verifyWorkflowE2EEvidence } from "../../packages/broker/src/core/e2e/verification.js";
import { describe, expect, it, vi } from "vitest";
import { createCandidateManifest, createWorkflowSnapshot, when } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createDocumentObjectStorage } from "../../packages/broker/src/core/proof/evidence-blob-store.js";
import type { ApplicationTask } from "../../packages/broker/src/core/e2e/application-seams.js";
import { createApplicationPublicationFence } from "../../packages/broker/src/core/e2e/publication-fence.js";
import { failClosedAuthority } from "../../packages/broker/src/core/e2e/authority.js";

const verifier = vi.hoisted(() => vi.fn<typeof verifyWorkflowE2EEvidence>());
vi.mock("../../packages/broker/src/core/e2e/verification.js", () => ({ verifyWorkflowE2EEvidence: verifier }));

describe("publication verifier boundary", () => {
  it("never passes a missing qualified operation to verification", async () => {
    const store = new MemoryDocumentStore(); const companyId = "org_11111111111111111111";
    const workflow = createWorkflowSnapshot({ taskId: "11111111-1111-4111-8111-111111111111", ownerId: "a".repeat(64), now: "2026-11-21T12:00:00.000Z" });
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const artifact = { id: "plan", type: "plan" as const, version: 1, sha256: "a".repeat(64), producer: "planner", createdAt: "2026-11-21T12:00:00.000Z", objectKey: "plan" };
    workflow.candidate = candidate; workflow.artifacts = [artifact];
    workflow.decisions = [{ requestId: "approval", workflowRevision: 1, decision: "APPROVE", artifactDigest: artifact.sha256, actorId: workflow.ownerId, actorRole: "TASK_OWNER", reason: "approved", at: artifact.createdAt }];
    workflow.e2e = { required: true, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), currentRoundId: "round", currentGroupRunIds: ["run"], resultRefs: [],
      qualifiedRound: { candidateDigest: candidate.digest, contractDigest: artifact.sha256, policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), roundId: "round", groupRunIds: ["run"], admissionSha256: "e".repeat(64), evidenceSha256: "f".repeat(64) } };
    const task = { companyId, taskId: workflow.taskId, workspaceId: "workspace", workflow } as ApplicationTask;
    verifier.mockReset(); verifier.mockImplementation(async (_deps, _operation, _task, _candidate, _projection, diagnostic) => {
      if (diagnostic !== undefined) diagnostic.authorityChecks = [{ kind: "check", key: { pk: "authority", sk: "META" }, condition: when.present() }]; return "PASS";
    });
    const objects = createDocumentObjectStorage(store, { companyId });
    const publication = createApplicationPublicationFence({ companyId, store, e2e: { state: { store }, objects, authority: failClosedAuthority, readTask: async () => task } });
    expect(await publication(task)).toBeUndefined();
    expect(verifier).not.toHaveBeenCalled();
  });
});
