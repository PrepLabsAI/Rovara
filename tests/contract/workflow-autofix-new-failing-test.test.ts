// Setup and test health (owner decision, Opus re-check M2): a check that failed on the original code too but ALSO has a failing test that was not failing before is the code's fault. The auto-fix policy
// sends it back like any code fault, within the existing limits (two send backs per approved plan, then a person is asked), and never asks a person straight away. The broker sets the fact from its own evidence
// pack and only while `vx` is on; without it every mapping is today's, and a check that failed before with nothing new still asks.
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_AGENTX_ACTOR_ID, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, autoFixAskCard, autoFixDecision, classifyBlockedWorkflow, createCandidateManifest, createWorkflowSnapshot, wholeTaskSpendUsd,
  AUTO_FIX_CODE_CLASS, type AutoFixBudget, type AutoFixFacts, type WorkflowDecision, type WorkflowSnapshot,
} from "@agentx/contracts";

const NOW = "2026-11-02T12:00:00.000Z";
const ownerId = "a".repeat(64);
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const budget = (): AutoFixBudget => ({ enabled: true, dayBudgetHasRoom: true, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(2), roundEstimateUsd: 2, capUsd: 15 } });
const approval = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({ requestId: uuid(n), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: "b".repeat(64), at: NOW });
const sentBack = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source: "AUTO_FIX", at: NOW, auto: { stage: "VERIFY", candidateDigest: candidate.digest },
});
const failedChecks = (...ids: string[]) => ({ verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: ids.map((checkId) => ({ checkId, status: "FAILED" })) } });
const blocked = (checks: string[], decisions: WorkflowDecision[] = [approval(1)]): WorkflowSnapshot => WorkflowSnapshotSchema.parse({
  ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId, now: NOW }), revision: 7, stage: "VERIFY", state: "BLOCKED", candidate, decisions, ...failedChecks(...checks),
});
const codesOf = (workflow: WorkflowSnapshot, facts: AutoFixFacts) => classifyBlockedWorkflow(workflow, facts).map((entry) => entry.code);
const decide = (workflow: WorkflowSnapshot, facts: AutoFixFacts) => autoFixDecision(workflow, facts, budget());
/** The check failed on the original code too (the person case today). */
const OLD: AutoFixFacts = { checkOriginal: { unit: "failed" } };

describe("the code new-failing-test", () => {
  it("is a code fault in the class table, and only ever comes from the broker's fact", () => {
    expect(AUTO_FIX_CODE_CLASS["new-failing-test"]).toBe("code");
    expect(codesOf(blocked(["unit"]), { ...OLD, newFailingChecks: ["unit"] })).toEqual(["new-failing-test"]);
    // A text-shaped or other-check fact does nothing: it must name this very check.
    expect(codesOf(blocked(["unit"]), { ...OLD, newFailingChecks: ["other"] })).toEqual(["fails-on-original-code"]);
    expect(codesOf(blocked(["unit"]), { ...OLD, newFailingChecks: [] })).toEqual(["fails-on-original-code"]);
  });
});

describe("with the fact (vx on)", () => {
  it("sends the code back at once, never asking a person first", () => {
    expect(decide(blocked(["unit"]), { ...OLD, newFailingChecks: ["unit"] })).toEqual({ action: "SEND_BACK", codes: ["new-failing-test"] });
  });

  it("also sends back a check whose original-code result nobody knows (the cause was unclear)", () => {
    expect(decide(blocked(["unit"]), {})).toMatchObject({ action: "ASK", reason: "unclear-fault" });
    expect(decide(blocked(["unit"]), { newFailingChecks: ["unit"] })).toEqual({ action: "SEND_BACK", codes: ["new-failing-test"] });
  });

  it("stops at the existing cap: after two automatic send backs a person is asked, naming the limit, and the card is the generic ask", () => {
    const one = blocked(["unit"], [approval(1), sentBack(2)]);
    expect(decide(one, { ...OLD, newFailingChecks: ["unit"] })).toEqual({ action: "SEND_BACK", codes: ["new-failing-test"] });
    const two = blocked(["unit"], [approval(1), sentBack(2), sentBack(3)]);
    const asked = decide(two, { ...OLD, newFailingChecks: ["unit"] });
    expect(asked).toEqual({ action: "ASK", reason: "send-back-limit", codes: ["new-failing-test"] });
    // Not the Fix setup card: it is the code's fault, not the setup's.
    expect(autoFixAskCard({ reason: "send-back-limit", codes: ["new-failing-test"] }, "VERIFY")).toBe("ask");
    expect(autoFixAskCard({ reason: "needs-a-person", codes: ["new-failing-test", "fails-on-original-code"] }, "VERIFY")).toBe("ask");
  });

  it("keeps the other limits: no send back without money, with the day budget gone, or with a full history", () => {
    const facts = { ...OLD, newFailingChecks: ["unit"] };
    expect(autoFixDecision(blocked(["unit"]), facts, { ...budget(), dayBudgetHasRoom: false })).toMatchObject({ action: "ASK", reason: "day-budget" });
    expect(autoFixDecision(blocked(["unit"]), facts, { ...budget(), spend: { spentUsd: wholeTaskSpendUsd(14), roundEstimateUsd: 2, capUsd: 15 } })).toMatchObject({ action: "ASK", reason: "spend-cap" });
    expect(autoFixDecision(blocked(["unit"]), facts, { ...budget(), enabled: false })).toEqual({ action: "NONE" });
  });

  it("only the named check changes: another failed check that failed on old code and has nothing new still asks a person first (a person's fault asks before a code fault)", () => {
    const two = blocked(["unit", "api"]);
    const facts: AutoFixFacts = { checkOriginal: { unit: "failed", api: "failed" }, newFailingChecks: ["unit"] };
    expect(codesOf(two, facts)).toEqual(["new-failing-test", "fails-on-original-code"]);
    expect(decide(two, facts)).toMatchObject({ action: "ASK", reason: "original-code-also-fails" });
  });
});

describe("without the fact (vx off) the mapping is today's", () => {
  it("a check that failed on the original code stays an ask for a person, with the Fix setup card", () => {
    expect(codesOf(blocked(["unit"]), OLD)).toEqual(["fails-on-original-code"]);
    expect(decide(blocked(["unit"]), OLD)).toEqual({ action: "ASK", reason: "original-code-also-fails", codes: ["fails-on-original-code"] });
    expect(autoFixAskCard({ reason: "original-code-also-fails", codes: ["fails-on-original-code"] }, "VERIFY")).toBe("fix_setup");
  });

  it("a check that passed on the original code is sent back as before, and one nobody knows about still waits for the cause", () => {
    expect(decide(blocked(["unit"]), { checkOriginal: { unit: "passed" } })).toEqual({ action: "SEND_BACK", codes: ["check-failed"] });
    expect(codesOf(blocked(["unit"]), {})).toEqual(["check-failed-cause-unknown"]);
  });

  it("a fact with a non-list value or one that does not name the check changes nothing (a check that failed before and has nothing new is not touched)", () => {
    expect(decide(blocked(["unit"]), { ...OLD, newFailingChecks: ["not-unit"] })).toMatchObject({ action: "ASK", reason: "original-code-also-fails" });
  });
});
