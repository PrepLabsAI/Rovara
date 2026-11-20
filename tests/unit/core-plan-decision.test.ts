// What a plan decision takes from the stored plan: its own decisions and what it says of needing no change come from the checked document, never from the surface; a structured plan that cannot be read
// back is not approved (fail closed); and a Markdown plan has nothing to read.
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, createWorkflowSnapshot, submitWorkflowArtifact, type JsonValue, type WorkflowSnapshot } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { localOwnerPrincipal } from "../../packages/broker/src/ports/policy-defaults.js";
import { PLAN_UNREADABLE_REFUSAL, createWorkflowDocumentSubject, workflowTaskKey, type WorkflowSubjectOptions } from "../../packages/broker/src/core/decisions/workflow-subject.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const PLAN = "b".repeat(64);
const FACTS = { planDecisions: [{ id: "d1", optionIds: ["a", "b"], recommended: "a" }] };

function waiting(format: "structured" | "markdown"): WorkflowSnapshot {
  const initial = createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: "2026-11-09T09:59:00.000Z" });
  return submitWorkflowArtifact(initial, {
    expectedRevision: initial.revision, now: "2026-11-09T10:00:00.000Z",
    artifact: { id: "plan-v1", type: "plan", version: 1, sha256: PLAN, producer: "agentx-planner", objectKey: `tasks/${TASK}/plan-v1.json`, createdAt: "2026-11-09T10:00:00.000Z", format },
  });
}

async function decide(options: Partial<WorkflowSubjectOptions>, details: Record<string, unknown>, outcome: "approve" | "request_changes" = "approve", format: "structured" | "markdown" = "structured") {
  const workflow = waiting(format);
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workflowTaskKey(TASK), orgId: IMPLICIT_COMPANY_ID, project: "web", workflow: JSON.parse(JSON.stringify(workflow)) as JsonValue } });
  const subject = createWorkflowDocumentSubject({ store, riskOf: () => "low", ...options });
  const loaded = (await subject.load(IMPLICIT_COMPANY_ID, TASK))!;
  const attempt = { companyId: IMPLICIT_COMPANY_ID, kind: subject.kind, subjectId: TASK, requestId: "11111111-1111-4111-8111-111111111111", outcome, seen: { revision: workflow.revision, artifactDigest: PLAN }, reason: "Please change it.", credentials: [], details };
  const applied = await subject.apply(loaded, attempt, [localOwnerPrincipal({ companyId: IMPLICIT_COMPANY_ID })], "2026-11-09T10:05:00.000Z");
  return (applied.result as { workflow: WorkflowSnapshot }).workflow;
}

describe("a plan decision and the stored plan", () => {
  it("refuses to approve a structured plan that cannot be read back, with or without answers", async () => {
    await expect(decide({ planFactsOf: async () => "unreadable" }, {})).rejects.toMatchObject({ message: PLAN_UNREADABLE_REFUSAL });
    await expect(decide({ planFactsOf: async () => "unreadable" }, { answers: [{ decisionId: "d1", optionId: "a", opened: true }] })).rejects.toMatchObject({ message: PLAN_UNREADABLE_REFUSAL });
  });

  it("still lets the owner send an unreadable plan back (nothing is approved)", async () => {
    const after = await decide({ planFactsOf: async () => "unreadable" }, {}, "request_changes");
    expect(after.decisions.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES" });
  });

  it("holds the answers to the options the document offers, whatever decision list a surface sent", async () => {
    const forged = { answers: [{ decisionId: "d1", optionId: "z", opened: true }], planDecisions: [{ id: "d1", optionIds: ["z"], recommended: "z" }] };
    await expect(decide({ planFactsOf: async () => FACTS }, forged)).rejects.toThrow(/option/u);
    const ok = await decide({ planFactsOf: async () => FACTS }, { answers: [{ decisionId: "d1", optionId: "b", opened: true }] });
    expect(ok.decisions.at(-1)).toMatchObject({ decision: "APPROVE", answerOverrides: [{ decisionId: "d1", optionId: "b" }] });
  });
});
