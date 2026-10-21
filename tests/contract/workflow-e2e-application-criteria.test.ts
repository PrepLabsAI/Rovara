import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type * as Contracts from "@agentx/contracts";

// The verifier consults the plan's required-criteria completeness (as P0 does) before it lets a round pass. No admission the compiler accepts has a waiting required
// criterion in the fixtures available here, so the contracts function is stubbed while the real evidence still flows through the real verifier.
const completeness = vi.hoisted(() => ({ override: undefined as boolean | undefined }));
vi.mock("@agentx/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof Contracts>();
  return { ...actual, e2ePlanHasCompleteRequiredCriteria: (plan: Parameters<typeof actual.e2ePlanHasCompleteRequiredCriteria>[0]) => completeness.override ?? actual.e2ePlanHasCompleteRequiredCriteria(plan) };
});

const { verifyApplicationE2EEvidence } = await import("../../packages/broker/src/e2e/application-evidence.js");
const { encodeE2EApplicationExecutionAdmission } = await import("../../packages/verifier/src/application-scenarios.js");
const { aggregateEvidenceEnvelope, createApplicationEvidenceFixture, groupEvidenceEnvelope } = await import("../support/e2e-application-evidence-fixture.js");

describe("a required criterion that cannot run keeps a round from passing", () => {
  it("is UNKNOWN when the plan has an unexecutable required criterion, and PASS when it does not", async () => {
    const fixture = await createApplicationEvidenceFixture({ probe: "api-status-mismatch-v1", observed: { kind: "http-status", status: 503 } });
    const admission = fixture.admission;
    const admissionBytes = Buffer.from(encodeE2EApplicationExecutionAdmission(admission), "utf8");
    const admissionSha256 = createHash("sha256").update(admissionBytes).digest("hex");
    const subject = { taskId: admission.taskId, operationId: admission.operationId, operationFence: admission.operationFence, workflowRevision: admission.workflowRevision,
      candidateDigest: admission.candidateDigest, roundId: admission.round.roundId, groupRunIds: [fixture.runId], admissionSha256 };
    const receivedAt = (fixture.groupRun.actual as { collection: { receivedAt: string } }).collection.receivedAt;
    const input = { admissionBytes, subject, aggregate: aggregateEvidenceEnvelope({ admission, admissionSha256, groupRuns: [fixture.groupRun] }),
      groupEvidence: new Map([[fixture.runId, groupEvidenceEnvelope({ admission, admissionSha256, groupRun: fixture.groupRun })]]),
      receivedAt: new Map([[fixture.runId, receivedAt]]), terminalStatus: "SUCCEEDED" as const };
    expect(verifyApplicationE2EEvidence(input).verdict).toBe("PASS");
    completeness.override = false;
    try {
      const result = verifyApplicationE2EEvidence(input);
      expect(result.verdict).toBe("UNKNOWN");
      expect(result.reason).toMatch(/required criterion/u);
    } finally { completeness.override = undefined; }
  });
});
