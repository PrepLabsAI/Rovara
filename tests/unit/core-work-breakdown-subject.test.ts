// What the plan decision does with a work breakdown digest (spec 059): the subject derives the graph's digest from the checked document through its `breakdown` hook; a digest a surface sent must be that one;
// without the hook a digest cannot be checked and is refused; a refusal of the hook refuses the decision; a repeat keeps the digest it was recorded with.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, createWorkflowSnapshot, submitWorkflowArtifact, type JsonValue, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { createWorkflowDocumentSubject, workflowTaskKey, type WorkflowSubjectOptions } from "../../packages/broker/src/core/decisions/workflow-subject.js";
import { WORKFLOW_BREAKDOWN_REFUSALS } from "../../packages/broker/src/developer/workflow-actions.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const DIGEST = "a".repeat(64);
const PLAN = "b".repeat(64);

function waiting(): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-09T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: PLAN, producer: "agentx-planner", objectKey: `tasks/${TASK}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format: "structured" },
  });
}

async function apply(options: Partial<WorkflowSubjectOptions>, details: Record<string, unknown>, workflow = waiting(), requestId = "11111111-1111-4111-8111-111111111111", seenRevision = workflow.revision) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workflowTaskKey(TASK), orgId: IMPLICIT_COMPANY_ID, project: "web", workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low", ...options });
  const loaded = (await subject.load(IMPLICIT_COMPANY_ID, TASK))!;
  const attempt = { companyId: IMPLICIT_COMPANY_ID, kind: subject.kind, subjectId: TASK, requestId, outcome: "approve" as const, seen: { revision: seenRevision, artifactDigest: PLAN }, credentials: [], details };
  return subject.apply(loaded, attempt, [localOwnerPrincipal({ companyId: IMPLICIT_COMPANY_ID })], "2026-11-09T10:05:00.000Z");
}
const workflowOf = (applied: Awaited<ReturnType<typeof apply>>) => (applied.result as { workflow: WorkflowSnapshot }).workflow;

describe("the work breakdown an approval binds", () => {
  it("binds the digest the hook derived, with no digest from the surface", async () => {
    const after = workflowOf(await apply({ breakdown: async () => ({ digest: DIGEST }) }, {}));
    expect(after.decisions.at(-1)).toMatchObject({ decision: "APPROVE", workBreakdownDigest: DIGEST });
    expect(after.workflowDependenciesApproval).toMatchObject({ graphDigest: DIGEST, artifactDigest: PLAN });
  });

  it("accepts the same digest from a surface, and refuses a different one (a surface cannot bind another graph)", async () => {
    expect(workflowOf(await apply({ breakdown: async () => ({ digest: DIGEST }) }, { workBreakdownDigest: DIGEST })).workflowDependenciesApproval).toMatchObject({ graphDigest: DIGEST });
    await expect(apply({ breakdown: async () => ({ digest: DIGEST }) }, { workBreakdownDigest: "c".repeat(64) })).rejects.toMatchObject({ message: WORKFLOW_BREAKDOWN_REFUSALS.digestChanged });
  });

  it("refuses a digest sent for a plan that has no breakdown", async () => {
    await expect(apply({ breakdown: async () => ({}) }, { workBreakdownDigest: DIGEST })).rejects.toMatchObject({ message: WORKFLOW_BREAKDOWN_REFUSALS.noBreakdown });
    // A plan with none and no digest is an ordinary approval, with no run bound.
    expect(workflowOf(await apply({ breakdown: async () => ({}) }, {})).workflowDependenciesApproval).toBeUndefined();
  });

  it("refuses the decision with the hook's sentence", async () => {
    await expect(apply({ breakdown: async () => ({ refusal: "the plan could not be read back" }) }, {})).rejects.toMatchObject({ message: "the plan could not be read back" });
  });

  it("refuses a digest a surface sent when nothing can check it (no hook)", async () => {
    await expect(apply({}, { workBreakdownDigest: DIGEST })).rejects.toMatchObject({ message: WORKFLOW_BREAKDOWN_REFUSALS.digestChanged });
    expect(workflowOf(await apply({}, {})).workflowDependenciesApproval).toBeUndefined();
  });

  it("answers a repeat of an approval the workflow holds with the digest it was recorded with, without asking the hook again", async () => {
    const first = workflowOf(await apply({ breakdown: async () => ({ digest: DIGEST }) }, {}));
    let asked = 0;
    // The same request id again, against the workflow that already holds the decision: the engine's own answer for a repeat (no new revision), not a different-decision error.
    await expect(apply({ breakdown: async () => { asked += 1; return { digest: "d".repeat(64) }; } }, {}, first, undefined, waiting().revision)).rejects.toMatchObject({ message: "The workflow already holds this decision." });
    expect(asked).toBe(0);
  });
});
