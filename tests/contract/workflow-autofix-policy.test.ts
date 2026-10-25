import { describe, expect, it } from "vitest";
import {
  AUTO_FIX_PERSON_GROUP_CODES, AUTO_FIX_TRANSIENT_GROUP_CODES, E2E_APPLICATION_SEND_BACK_CODES, WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX,
  WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE,
  WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, WorkflowTransitionError, autoFixDecision, createCandidateManifest,
  createWorkflowSnapshot, decideWorkflow, workflowFindingFingerprint, returnWorkflowToImplementation, returnWorkflowToImplementationAutomatically, submitWorkflowArtifact, workflowAutoActionRequestId,
  workflowAutoFixCounts, workflowAutomaticRetryDecision, wholeTaskSpendUsd,
  type AutoFixBudget, type AutoFixFacts, type WorkflowAutoSpend, type WorkflowDecision, type WorkflowSnapshot,
} from "@agentx/contracts";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const NOW = "2026-10-25T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const otherCandidate = createCandidateManifest([{ repositoryId: "app", commitSha: "4".repeat(40), treeSha: "5".repeat(40), baseCommitSha: "3".repeat(40) }]);
const roundId = "11111111-1111-4111-8111-111111111111";
const groupRunId = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (char: string): string => char.repeat(64);

const GROUPS_FAILED = "one or more admitted E2E groups failed";
const incomplete = (...entries: string[]): string => `${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (${entries.join("; ")})`;

const SPEND: WorkflowAutoSpend = { spentUsd: wholeTaskSpendUsd(2), roundEstimateUsd: 2, capUsd: 15 };
type BudgetOver = Partial<Omit<AutoFixBudget, "spend">> & { spentUsd?: number; roundEstimateUsd?: number; capUsd?: number };
const budget = (over: BudgetOver = {}): AutoFixBudget => {
  const { spentUsd, roundEstimateUsd, capUsd, ...rest } = over;
  return { enabled: true, dayBudgetHasRoom: true, baselineRequests: 0, ...rest,
    spend: { spentUsd: spentUsd === undefined ? SPEND.spentUsd : wholeTaskSpendUsd(spentUsd), roundEstimateUsd: roundEstimateUsd ?? SPEND.roundEstimateUsd, capUsd: capUsd ?? SPEND.capUsd } };
};

const approval = (n: number, at = NOW): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: hex("b"), at,
});
const ownerSendBack = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: ownerId, actorRole: "TASK_OWNER", reason: "fix it", source: "SEND_BACK", at: NOW,
});
const automatic = (n: number, source: "AUTO_FIX" | "AUTO_RETRY", stage: "VERIFY" | "REVIEW" = "VERIFY", candidateDigest: string | undefined = candidate.digest): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source, at: NOW,
  auto: { stage, ...(candidateDigest === undefined ? {} : { candidateDigest }) },
});

type Over = Record<string, unknown>;
/** A workflow stored as the previous code stored it: one plan approval, coding done, then blocked. */
function blocked(stage: "VERIFY" | "REVIEW", blockReason: string | undefined, over: Over = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: NOW }), revision: 7, stage, state: "BLOCKED", ...(blockReason === undefined ? {} : { blockReason }),
    candidate, decisions: [approval(1)], ...over,
  });
}
const e2eProgress = (over: Over = {}): Over => ({
  contractDigest: hex("c"), policyDigest: hex("d"), bundleDigest: hex("e"), executionPlanDigest: hex("f"), required: true, currentRoundId: roundId, currentGroupRunIds: [groupRunId], resultRefs: [], ...over,
});
const failedRound = (over: Over = {}): Over => ({ status: "FAILED", candidateDigest: candidate.digest, roundId, groupRunIds: [groupRunId], admissionSha256: hex("7"), evidenceSha256: hex("8"), ...over });
const verify = (reason: string, over: Over = {}): WorkflowSnapshot => blocked("VERIFY", reason, { e2e: e2eProgress(), ...over });
const verification = (results: Over[], digest = candidate.digest): Over => ({ verification: { candidateDigest: digest, producer: "worker", environmentId: "env", recordedAt: NOW, results } });
const review = (role: "CRITIC" | "SECURITY", status: string, findings: Over[] = [], over: Over = {}): Over => ({
  operationId: uuid(role === "CRITIC" ? 90 : 91), candidateDigest: candidate.digest, role, provider: "p", version: "1", status, findings, readOnly: true, recordedAt: NOW, ...over,
});
const finding = (text: string, over: Over = {}): Over => ({ text, origin: "INTRODUCED", ...over });

function decide(workflow: WorkflowSnapshot, facts: AutoFixFacts = {}, over: BudgetOver = {}) {
  return autoFixDecision(workflow, facts, budget(over));
}

describe("AUTOFIX policy: classification of a blocked browser and API round", () => {
  it("sends back for each code the candidate causes, and records which code", () => {
    for (const code of E2E_APPLICATION_SEND_BACK_CODES) {
      expect(decide(verify(incomplete(`g1: ${code}`)))).toEqual({ action: "SEND_BACK", codes: [code] });
    }
  });

  it("retries once for each infrastructure code, and asks for a cancel the owner made", () => {
    for (const code of AUTO_FIX_TRANSIENT_GROUP_CODES) {
      expect(decide(verify(incomplete(`g1: ${code}`)))).toEqual({ action: "RETRY", stage: "VERIFY", codes: [code] });
    }
    expect(decide(verify(incomplete("g1: cancelled")), { ownerCancelled: true })).toMatchObject({ action: "ASK", reason: "needs-a-person", codes: ["cancelled-by-owner"] });
  });

  it("asks for each code only a person can fix, and for a code nobody classified", () => {
    for (const code of AUTO_FIX_PERSON_GROUP_CODES) {
      expect(decide(verify(incomplete(`g1: ${code}`)))).toEqual({ action: "ASK", reason: "needs-a-person", codes: [code] });
    }
    expect(decide(verify(incomplete("g1: brand-new-code")))).toEqual({ action: "ASK", reason: "needs-a-person", codes: ["unknown-group-code"] });
  });

  it("sends back a mixed round (code plus infrastructure), but asks when a person is also needed", () => {
    expect(decide(verify(incomplete("g1: build-failed", "g2: executor-failed")))).toEqual({ action: "SEND_BACK", codes: ["build-failed", "executor-failed"] });
    expect(decide(verify(incomplete("g1: build-failed", "g2: login-failed")))).toEqual({ action: "ASK", reason: "needs-a-person", codes: ["build-failed", "login-failed"] });
  });

  it("asks for every block only a person fixes", () => {
    const reasons: Array<[string, string]> = [
      [WORKFLOW_HISTORY_REWRITTEN_MESSAGE, "history-rewritten"],
      [`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}no runtime`, "runtime-unusable"],
      [`${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}accounts`, "accounts-changed"],
      ["a block reason nobody has ever seen", "unreadable"],
      [WORKFLOW_BLOCK_REASONS.checksUnconfirmed, "unreadable"],
    ];
    for (const [reason, expected] of reasons) expect(decide(verify(reason))).toEqual({ action: "ASK", reason: "needs-a-person", codes: [expected] });
  });

  it("sends back a round that could not be started from an unusable build source", () => {
    expect(decide(verify(`${WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX}the build source is unusable. Send the task back to coding, or close it.`))).toEqual({ action: "SEND_BACK", codes: ["round-refused"] });
  });

  it("sends back a FAILED assertion of the current round, and reads a failure of any other round as nothing", () => {
    expect(decide(verify(GROUPS_FAILED, { e2e: e2eProgress({ failedRound: failedRound() }) }))).toEqual({ action: "SEND_BACK", codes: ["e2e-assertion-failed"] });
    expect(decide(verify(GROUPS_FAILED, { e2e: e2eProgress({ failedRound: failedRound({ roundId: "33333333-3333-4333-8333-333333333333" }) }) })))
      .toEqual({ action: "ASK", reason: "needs-a-person", codes: ["unreadable"] });
    expect(decide(verify(GROUPS_FAILED, { e2e: e2eProgress({ failedRound: failedRound({ candidateDigest: otherCandidate.digest }) }) })))
      .toMatchObject({ action: "ASK", codes: ["unreadable"] });
  });
});

describe("AUTOFIX policy: checks", () => {
  const check = (checkId: string, status: string, extra: Over = {}): Over => ({ checkId, status, ...extra });
  const failedCheck = (facts: AutoFixFacts = {}, id = "proposed-1") => decide(blocked("VERIFY", undefined, verification([check("lint", "PASS"), check(id, "FAILED")])), facts);

  it("decides a failed check by how it behaved on the original code", () => {
    expect(failedCheck({ checkOriginal: { "proposed-1": "passed" } })).toEqual({ action: "SEND_BACK", codes: ["check-failed"] });
    expect(failedCheck({ checkExpectsPass: ["proposed-1"] })).toEqual({ action: "SEND_BACK", codes: ["check-failed"] });
    expect(failedCheck({})).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["check-failed-cause-unknown"] });
    expect(failedCheck({ checkOriginal: { "proposed-1": "failed" } })).toEqual({ action: "ASK", reason: "original-code-also-fails", codes: ["fails-on-original-code"] });
    expect(failedCheck({ checkOriginal: { "proposed-1": "cannot-run" } })).toEqual({ action: "ASK", reason: "original-code-also-fails", codes: ["fails-on-original-code"] });
    // Another check's original-code result says nothing about this one.
    expect(failedCheck({ checkOriginal: { other: "passed" } })).toMatchObject({ action: "ASK", reason: "unclear-fault" });
  });

  it("asks for a broken check, retries one that never started, and treats an UNKNOWN result as unclear", () => {
    const run = (result: Over) => decide(blocked("VERIFY", undefined, verification([result])));
    expect(run(check("c", "FAILED", { broken: true }))).toEqual({ action: "ASK", reason: "needs-a-person", codes: ["check-broken"] });
    expect(run(check("c", "FAILED", { programNotFound: true }))).toEqual({ action: "ASK", reason: "needs-a-person", codes: ["check-broken"] });
    expect(run(check("c", "FAILED", { neverStarted: true }))).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["check-not-started"] });
    expect(run(check("c", "UNKNOWN"))).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["check-result-unknown"] });
  });

  it("ignores results recorded for other code, and reads a block with only passing results as nothing", () => {
    expect(decide(blocked("VERIFY", undefined, verification([check("c", "FAILED")], otherCandidate.digest)))).toMatchObject({ action: "ASK", codes: ["unreadable"] });
    expect(decide(blocked("VERIFY", undefined, verification([check("c", "PASS")])))).toMatchObject({ action: "ASK", codes: ["unreadable"] });
  });

  it("sends back a regression found by the review-only rerun, and retries a runner that failed", () => {
    expect(decide(blocked("VERIFY", WORKFLOW_BLOCK_REASONS.regressionFound))).toEqual({ action: "SEND_BACK", codes: ["regression-found"] });
    expect(decide(blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed))).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["check-runner-failed"] });
  });

  it("adds the outage facts as infrastructure faults", () => {
    expect(decide(blocked("VERIFY", WORKFLOW_BLOCK_REASONS.checkRunnerFailed), { providerOutage: true, runnerBusy: true }))
      .toEqual({ action: "RETRY", stage: "VERIFY", codes: ["check-runner-failed", "provider-outage", "runner-busy"] });
  });
});

describe("AUTOFIX policy: reviews", () => {
  it("sends back blocking findings of the current code, and nothing else about a review", () => {
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [finding("SQL is built from input")]), review("SECURITY", "PASS")] })))
      .toEqual({ action: "SEND_BACK", codes: ["review-findings"] });
    // Pre-existing and advisory findings never block, so a block with only those is not readable as a code fault.
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "PASS", [finding("old", { origin: "PRE_EXISTING" })]), review("SECURITY", "PASS")] })))
      .toMatchObject({ action: "ASK", codes: ["unreadable"] });
    // A review of older code describes code that is gone.
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [finding("x")], { candidateDigest: otherCandidate.digest }), review("SECURITY", "PASS")] })))
      .toMatchObject({ action: "ASK", codes: ["unreadable"] });
  });

  it("does not send back a finding the owner accepted", () => {
    const f = finding("accepted one");
    const fingerprint = workflowFindingFingerprint("CRITIC", { text: "accepted one" });
    const accepted = { candidateDigest: candidate.digest, role: "CRITIC", fingerprint, text: "accepted one", reason: "fine", actorId: ownerId, at: NOW };
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [f]), review("SECURITY", "PASS")], acceptedFindings: [accepted] })))
      .toMatchObject({ action: "ASK", codes: ["unreadable"] });
  });

  it("retries a review run that stopped, and asks when the review is unusable", () => {
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FAILED", [], { failureReason: "TIMEOUT" }), review("SECURITY", "PASS")] })))
      .toEqual({ action: "RETRY", stage: "REVIEW", codes: ["review-run-failed"] });
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FAILED", [], { failureReason: "CANDIDATE_CHANGED" }), review("SECURITY", "PASS")] })))
      .toEqual({ action: "ASK", reason: "needs-a-person", codes: ["review-unusable"] });
    expect(decide(blocked("REVIEW", WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE))).toEqual({ action: "RETRY", stage: "REVIEW", codes: ["review-not-run"] });
  });

  it("sends back when findings and a stopped run come together", () => {
    expect(decide(blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [finding("bug")]), review("SECURITY", "INTERRUPTED", [], { failureReason: "INTERRUPTED" })] })))
      .toEqual({ action: "SEND_BACK", codes: ["review-findings", "review-run-failed"] });
  });
});

describe("AUTOFIX policy: unclear faults are settled by each group's own original-code result", () => {
  const unknown = (): WorkflowSnapshot => verify(`${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (evidence floor unmet)`);
  const groups = (g: Record<string, "passed" | "failed" | "cannot-run" | "skipped" | "pending" | "not-run">): AutoFixFacts => ({ e2eUnknownGroups: g });

  it("requests the original-code round once when it does not know yet, and asks when it was requested and still does not know the groups", () => {
    expect(decide(unknown())).toEqual({ action: "REQUEST_BASELINE", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "not-run" }))).toEqual({ action: "REQUEST_BASELINE", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), {}, { baselineRequests: 1 })).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "not-run" }), { baselineRequests: 1 })).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["e2e-evidence-unknown"] });
  });

  it("waits while a group's original-code result is pending, and sends back only when every UNKNOWN group itself passed", () => {
    expect(decide(unknown(), groups({ g1: "pending" }))).toEqual({ action: "WAIT_FOR_BASELINE", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "passed", g2: "pending" }))).toEqual({ action: "WAIT_FOR_BASELINE", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "passed" }))).toEqual({ action: "SEND_BACK", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "passed", g2: "passed" }))).toEqual({ action: "SEND_BACK", codes: ["e2e-evidence-unknown"] });
  });

  it("asks when any UNKNOWN group failed or could not run on the original code, whatever the others did", () => {
    expect(decide(unknown(), groups({ g1: "failed" }))).toEqual({ action: "ASK", reason: "original-code-also-fails", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "passed", g2: "cannot-run" }))).toEqual({ action: "ASK", reason: "original-code-also-fails", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ g1: "pending", g2: "failed" }))).toMatchObject({ action: "ASK", reason: "original-code-also-fails" });
  });

  it("never sends back a group the baseline skipped (an AI-navigated group) on another group's result", () => {
    // g-web passed on the original code; g-ai was skipped there: the overall baseline "passed", but g-ai has no evidence of its own.
    expect(decide(unknown(), groups({ "g-web": "passed", "g-ai": "skipped" }))).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["e2e-evidence-unknown"] });
    expect(decide(unknown(), groups({ "g-ai": "skipped" }))).toMatchObject({ action: "ASK", reason: "unclear-fault" });
    expect(decide(unknown(), groups({ "g-ai": "skipped", "g-web": "pending" }))).toMatchObject({ action: "ASK", reason: "unclear-fault" });
  });

  it("fails closed: an unexpected or garbage result for any group asks, and only an explicit passed sends back", () => {
    for (const garbage of ["PASS", "ok", "", "unknown", null, undefined, 1, true, {}]) {
      expect(decide(unknown(), groups({ g1: garbage as never }))).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["e2e-evidence-unknown"] });
      expect(decide(unknown(), groups({ g1: "passed", g2: garbage as never }))).toEqual({ action: "ASK", reason: "unclear-fault", codes: ["e2e-evidence-unknown"] });
    }
  });

  it("does not let the E2E baseline settle a check, and an infrastructure fault retries before the baseline is asked", () => {
    const check = blocked("VERIFY", undefined, verification([{ checkId: "c", status: "FAILED" }]));
    expect(decide(check, groups({ g1: "passed" }))).toMatchObject({ action: "ASK", reason: "unclear-fault" });
    expect(decide(verify(incomplete("g1: executor-failed")), groups({ g1: "failed" }))).toMatchObject({ action: "RETRY" });
  });
});

describe("AUTOFIX policy: the money and counts are required inputs", () => {
  const buildFailed = (): WorkflowSnapshot => verify(incomplete("g1: build-failed"));
  const withBudget = (over: Record<string, unknown>) => autoFixDecision(buildFailed(), {}, { ...budget(), ...over });

  it("asks, naming the missing input, when whole-task spend, the day budget or the baseline count is missing or unreadable", () => {
    expect(withBudget({})).toMatchObject({ action: "SEND_BACK" });
    for (const over of [{ spend: undefined }, { spend: { roundEstimateUsd: 2, capUsd: 15 } }, { spend: { ...SPEND, spentUsd: "2" } }, { spend: { ...SPEND, capUsd: undefined } },
      { dayBudgetHasRoom: undefined }, { baselineRequests: undefined }, { baselineRequests: 0.5 }, { baselineRequests: -1 }]) {
      expect(withBudget(over)).toEqual({ action: "ASK", reason: "inputs-missing", codes: ["build-failed"] });
    }
    expect(autoFixDecision(buildFailed(), {}, undefined as unknown as AutoFixBudget)).toMatchObject({ action: "ASK", reason: "inputs-missing" });
  });

  it("also asks for a retry and for the original-code request, and still asks a person first", () => {
    expect(autoFixDecision(verify(incomplete("g1: executor-failed")), {}, { ...budget(), spend: undefined } as unknown as AutoFixBudget)).toMatchObject({ action: "ASK", reason: "inputs-missing" });
    expect(autoFixDecision(verify(`${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (floor)`), {}, { ...budget(), spend: undefined } as unknown as AutoFixBudget)).toMatchObject({ action: "ASK", reason: "inputs-missing" });
    expect(autoFixDecision(verify(incomplete("g1: login-failed")), {}, { ...budget(), spend: undefined } as unknown as AutoFixBudget)).toMatchObject({ action: "ASK", reason: "needs-a-person" });
  });

  it("is held by the guard functions too: over the cap, unreadable or missing spend is refused there", () => {
    const base = verify(incomplete("g1: build-failed"));
    const retryBase = verify(incomplete("g1: executor-failed"));
    const over = { spentUsd: wholeTaskSpendUsd(14), roundEstimateUsd: 2, capUsd: 15 };
    expect(() => returnWorkflowToImplementationAutomatically(base, { expectedRevision: 7, reason: "r", spend: over, now: NOW })).toThrow(/spend/);
    expect(() => workflowAutomaticRetryDecision(retryBase, { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: over, now: NOW })).toThrow(/spend/);
    for (const spend of [undefined, { ...SPEND, spentUsd: Number.NaN }, { ...SPEND, capUsd: Number.POSITIVE_INFINITY }, { ...SPEND, roundEstimateUsd: -1 }, { spentUsd: 1 }]) {
      expect(() => returnWorkflowToImplementationAutomatically(base, { expectedRevision: 7, reason: "r", spend: spend as never, now: NOW })).toThrow(/spend/);
      expect(() => workflowAutomaticRetryDecision(retryBase, { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: spend as never, now: NOW })).toThrow(/spend/);
    }
    // Exactly at the cap is allowed, as in the policy.
    const exact = { spentUsd: wholeTaskSpendUsd(13), roundEstimateUsd: 2, capUsd: 15 };
    expect(returnWorkflowToImplementationAutomatically(base, { expectedRevision: 7, reason: "r", spend: exact, now: NOW }).stage).toBe("IMPLEMENT");
  });
});

describe("AUTOFIX policy: limits", () => {
  const buildFailed = (decisions: WorkflowDecision[]): WorkflowSnapshot => verify(incomplete("g1: build-failed"), { decisions });

  it("sends back at most twice per approved plan, then asks naming the limit", () => {
    expect(decide(buildFailed([approval(1)]))).toMatchObject({ action: "SEND_BACK" });
    expect(decide(buildFailed([approval(1), automatic(2, "AUTO_FIX")]))).toMatchObject({ action: "SEND_BACK" });
    expect(decide(buildFailed([approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX")]))).toEqual({ action: "ASK", reason: "send-back-limit", codes: ["build-failed"] });
  });

  it("counts the owner's own send backs for nothing, and only the sends since the last plan approval", () => {
    expect(decide(buildFailed([approval(1), ownerSendBack(2), ownerSendBack(3), ownerSendBack(4)]))).toMatchObject({ action: "SEND_BACK" });
    expect(decide(buildFailed([approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4)]))).toMatchObject({ action: "SEND_BACK" });
  });

  it("stops at 6 automatic actions in the whole task", () => {
    const six = [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4), automatic(5, "AUTO_FIX"), automatic(6, "AUTO_FIX"), approval(7),
      automatic(8, "AUTO_RETRY", "REVIEW", otherCandidate.digest), automatic(9, "AUTO_RETRY", "REVIEW", hex("9"))];
    expect(workflowAutoFixCounts(six).actions).toBe(6);
    expect(decide(buildFailed(six))).toEqual({ action: "ASK", reason: "total-limit", codes: ["build-failed"] });
    expect(decide(buildFailed(six.slice(0, -1)))).toMatchObject({ action: "SEND_BACK" });
  });

  it("retries a stage once per candidate", () => {
    const executorFailed = (decisions: WorkflowDecision[]): WorkflowSnapshot => verify(incomplete("g1: executor-failed"), { decisions });
    expect(decide(executorFailed([approval(1)]))).toMatchObject({ action: "RETRY" });
    expect(decide(executorFailed([approval(1), automatic(2, "AUTO_RETRY")]))).toEqual({ action: "ASK", reason: "retry-limit", codes: ["executor-failed"] });
    // Another candidate, or another stage, has its own retry.
    expect(decide(executorFailed([approval(1), automatic(2, "AUTO_RETRY", "VERIFY", otherCandidate.digest)]))).toMatchObject({ action: "RETRY" });
    expect(decide(executorFailed([approval(1), automatic(2, "AUTO_RETRY", "REVIEW")]))).toMatchObject({ action: "RETRY" });
  });

  it("asks when the spend, the day budget or the decision history leaves no room", () => {
    const base = buildFailed([approval(1)]);
    expect(decide(base, {}, { spentUsd: 13.5, roundEstimateUsd: 2 })).toEqual({ action: "ASK", reason: "spend-cap", codes: ["build-failed"] });
    expect(decide(base, {}, { spentUsd: 13, roundEstimateUsd: 2 })).toMatchObject({ action: "SEND_BACK" });
    for (const spentUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(decide(base, {}, { spentUsd })).toMatchObject({ action: "ASK", reason: "inputs-missing" });
    expect(decide(base, {}, { dayBudgetHasRoom: false })).toMatchObject({ action: "ASK", reason: "day-budget" });
    const full = [approval(1), ...Array.from({ length: 99 }, (_, index) => ownerSendBack(index + 100))];
    expect(decide(buildFailed(full))).toMatchObject({ action: "ASK", reason: "history-full" });
    // A retry is held to the same money.
    expect(decide(verify(incomplete("g1: executor-failed")), {}, { spentUsd: 14.5 })).toMatchObject({ action: "ASK", reason: "spend-cap" });
  });

  it("does nothing when switched off, outside a blocked VERIFY or REVIEW, and asks when a pull request is open", () => {
    const base = buildFailed([approval(1)]);
    expect(decide(base, {}, { enabled: false })).toEqual({ action: "NONE" });
    expect(decide(WorkflowSnapshotSchema.parse({ ...base, state: "READY", blockReason: undefined }))).toEqual({ action: "NONE" });
    expect(decide(WorkflowSnapshotSchema.parse({ ...base, stage: "IMPLEMENT" }))).toEqual({ action: "NONE" });
    const withPullRequest = WorkflowSnapshotSchema.parse({ ...base, pullRequests: [{
      repositoryId: "app", number: 4, url: "https://github.com/o/r/pull/4", required: true, candidateDigest: candidate.digest, state: "OPEN", headSha: "6".repeat(40), observedAt: NOW,
    }] });
    expect(decide(withPullRequest)).toMatchObject({ action: "ASK", reason: "needs-a-person", codes: ["build-failed", "pull-request-open"] });
  });
});

describe("AUTOFIX: the AGENTX actor", () => {
  const blockedForSendBack = (over: Over = {}): WorkflowSnapshot => verify(incomplete("g1: build-failed"), over);

  it("sends blocked work back as AGENTX with a derived request ID, and clears the block like the owner's Send back", () => {
    const before = blockedForSendBack();
    const after = returnWorkflowToImplementationAutomatically(before, { expectedRevision: 7, reason: "The app did not build.", spend: SPEND, now: NOW });
    expect(after).toMatchObject({ stage: "IMPLEMENT", state: "READY", revision: 8 });
    expect(after.blockReason).toBeUndefined();
    const added = after.decisions.at(-1)!;
    expect(added).toMatchObject({
      requestId: workflowAutoActionRequestId(taskId, 7, "AUTO_FIX"), workflowRevision: 7, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX",
      source: "AUTO_FIX", auto: { stage: "VERIFY", candidateDigest: candidate.digest },
    });
    // The same move by the owner leaves the same snapshot except for the decision.
    const byOwner = returnWorkflowToImplementation(before, { requestId: uuid(500), actorId: ownerId, reason: "x", now: NOW });
    expect({ ...after, decisions: [] }).toEqual({ ...byOwner, decisions: [] });
  });

  it("is idempotent for the same revision, and only one of two writers on a revision wins", () => {
    const before = blockedForSendBack();
    const once = returnWorkflowToImplementationAutomatically(before, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW });
    expect(returnWorkflowToImplementationAutomatically(once, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toEqual(once);
    expect(once.decisions.filter((decision) => decision.source === "AUTO_FIX")).toHaveLength(1);
    // The owner pressed Send back first: the automatic one is out of date.
    const ownerFirst = returnWorkflowToImplementation(before, { requestId: uuid(501), actorId: ownerId, reason: "x", now: NOW });
    expect(() => returnWorkflowToImplementationAutomatically(ownerFirst, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/out of date/);
    // And the other way round: the owner presses after the automatic one, and finds the work no longer blocked.
    expect(() => returnWorkflowToImplementation(once, { requestId: uuid(502), actorId: ownerId, reason: "x", now: NOW })).toThrow(WorkflowTransitionError);
    expect(() => returnWorkflowToImplementationAutomatically(before, { expectedRevision: 6, reason: "r", spend: SPEND, now: NOW })).toThrow(/out of date/);
  });

  it("works from a blocked REVIEW too, naming that stage", () => {
    const reviewBlocked = blocked("REVIEW", undefined, { reviews: [review("CRITIC", "FINDINGS", [finding("bug")]), review("SECURITY", "PASS")] });
    const after = returnWorkflowToImplementationAutomatically(reviewBlocked, { expectedRevision: 7, reason: "findings", spend: SPEND, now: NOW });
    expect(after.decisions.at(-1)).toMatchObject({ source: "AUTO_FIX", auto: { stage: "REVIEW" } });
  });

  it("refuses everywhere except a blocked VERIFY or REVIEW", () => {
    const base = blockedForSendBack();
    const tryIt = (workflow: unknown) => () => returnWorkflowToImplementationAutomatically(workflow, { expectedRevision: (workflow as WorkflowSnapshot).revision, reason: "r", spend: SPEND, now: NOW });
    expect(tryIt(WorkflowSnapshotSchema.parse({ ...base, stage: "IMPLEMENT" }))).toThrow(WorkflowTransitionError);
    expect(tryIt(WorkflowSnapshotSchema.parse({ ...base, state: "RUNNING", blockReason: undefined }))).toThrow(WorkflowTransitionError);
    // A plan waiting for its owner's approval.
    const planReview = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId, now: NOW }), {
      expectedRevision: 1, now: NOW,
      artifact: { id: "plan-v1", type: "plan", version: 1, sha256: hex("b"), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: NOW },
    });
    expect(planReview.stage).toBe("PLAN_REVIEW");
    expect(tryIt(planReview)).toThrow(WorkflowTransitionError);
    // A pull request is open.
    const withPullRequest = { ...base, pullRequests: [{ repositoryId: "app", number: 4, url: "https://github.com/o/r/pull/4", required: true, candidateDigest: candidate.digest, state: "OPEN", headSha: "6".repeat(40), observedAt: NOW }] };
    expect(tryIt(WorkflowSnapshotSchema.parse(withPullRequest))).toThrow(/pull request/);
    // The change is ready to publish.
    expect(tryIt({ ...base, stage: "PULL_REQUEST", state: "READY" })).toThrow();
  });

  it("refuses blocks only a person fixes, whatever the caller decided", () => {
    for (const reason of [WORKFLOW_HISTORY_REWRITTEN_MESSAGE, `${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}x`, `${WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX}x`]) {
      expect(() => returnWorkflowToImplementationAutomatically(verify(reason), { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/needs a person/);
    }
  });

  it("holds the limits itself: 2 automatic send backs per plan, 6 automatic actions, a full history", () => {
    const two = blockedForSendBack({ decisions: [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX")] });
    expect(() => returnWorkflowToImplementationAutomatically(two, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/limit/);
    const newPlan = blockedForSendBack({ decisions: [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4)] });
    expect(returnWorkflowToImplementationAutomatically(newPlan, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW }).stage).toBe("IMPLEMENT");
    const six = blockedForSendBack({ decisions: [approval(1), automatic(2, "AUTO_FIX"), automatic(3, "AUTO_FIX"), approval(4), automatic(5, "AUTO_FIX"), automatic(6, "AUTO_FIX"), approval(7),
      automatic(8, "AUTO_RETRY", "REVIEW", hex("9")), automatic(9, "AUTO_RETRY", "REVIEW", hex("a"))] });
    expect(() => returnWorkflowToImplementationAutomatically(six, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/limit/);
    const full = blockedForSendBack({ decisions: [approval(1), ...Array.from({ length: 99 }, (_, index) => ownerSendBack(index + 100))] });
    expect(() => returnWorkflowToImplementationAutomatically(full, { expectedRevision: 7, reason: "r", spend: SPEND, now: NOW })).toThrow(/history is full/);
  });

  it("records an automatic retry once per stage and candidate, and not for another stage or a stale revision", () => {
    const base = verify(incomplete("g1: executor-failed"));
    const decision = workflowAutomaticRetryDecision(base, { expectedRevision: 7, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW });
    expect(decision).toMatchObject({ requestId: workflowAutoActionRequestId(taskId, 7, "AUTO_RETRY"), actorRole: "AGENTX", source: "AUTO_RETRY", auto: { stage: "VERIFY", candidateDigest: candidate.digest } });
    const recorded = WorkflowSnapshotSchema.parse({ ...base, decisions: [...base.decisions, decision] });
    expect(workflowAutomaticRetryDecision(recorded, { expectedRevision: 7, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW })).toEqual(decision);
    const next = WorkflowSnapshotSchema.parse({ ...recorded, revision: 9 });
    expect(() => workflowAutomaticRetryDecision(next, { expectedRevision: 9, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW })).toThrow(/already retried/);
    expect(() => workflowAutomaticRetryDecision(base, { expectedRevision: 7, stage: "REVIEW", reason: "retry", spend: SPEND, now: NOW })).toThrow(/blocked stage/);
    expect(() => workflowAutomaticRetryDecision(base, { expectedRevision: 6, stage: "VERIFY", reason: "retry", spend: SPEND, now: NOW })).toThrow(/out of date/);
    expect(() => workflowAutomaticRetryDecision(verify(WORKFLOW_HISTORY_REWRITTEN_MESSAGE), { expectedRevision: 7, stage: "VERIFY", reason: "r", spend: SPEND, now: NOW })).toThrow(/needs a person/);
  });

  it("can never approve, skip, reject, publish or carry an approval's fields", () => {
    const automaticFields = { requestId: uuid(700), workflowRevision: 3, actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "r", source: "AUTO_FIX", auto: { stage: "VERIFY" }, at: NOW };
    expect(WorkflowDecisionRecordSchema.safeParse({ ...automaticFields, decision: "REQUEST_CHANGES" }).success).toBe(true);
    for (const decision of ["APPROVE", "SKIP", "REJECT"]) expect(WorkflowDecisionRecordSchema.safeParse({ ...automaticFields, decision }).success).toBe(false);
    const request = { ...automaticFields, decision: "REQUEST_CHANGES" };
    for (const extra of [{ artifactDigest: hex("b") }, { workBreakdownDigest: hex("b") }, { selectedOptionalCheckIds: ["a"] }, { commentsIncluded: 1 }, { via: "PAGE" }, { answerOverrides: [{ decisionId: "d1", optionId: "x" }] }]) {
      expect(WorkflowDecisionRecordSchema.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    // The AGENTX role is for the AGENTX identity and automatic sources only, and an automatic source is for the AGENTX role only.
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorId: ownerId }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorRole: "TASK_OWNER" }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorId: ownerId, actorRole: "PROJECT_ADMIN" }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, source: "SEND_BACK" }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, auto: undefined }).success).toBe(false);
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorRole: "TASK_OWNER", actorId: ownerId, source: "SEND_BACK" }).success).toBe(false);
    // `auto` belongs to automatic decisions only.
    expect(WorkflowDecisionRecordSchema.safeParse({ ...request, actorRole: "TASK_OWNER", actorId: ownerId, source: "SEND_BACK", auto: { stage: "VERIFY" } }).success).toBe(false);
  });

  it("is not an owner: it cannot approve a plan through the owner's gate", () => {
    const planReview = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId, now: NOW }), {
      expectedRevision: 1, now: NOW,
      artifact: { id: "plan-v1", type: "plan", version: 1, sha256: hex("b"), producer: "agentx-planner", objectKey: `tasks/${taskId}/plan-v1.md`, createdAt: NOW },
    });
    const approve = { requestId: uuid(800), expectedRevision: planReview.revision, decision: "APPROVE", artifactDigest: hex("b"), reason: "ok" };
    expect(() => decideWorkflow(planReview, approve, { actorId: WORKFLOW_AGENTX_ACTOR_ID, role: "AGENTX" as never }, { now: NOW, allowedSkipStages: [] })).toThrow();
    expect(() => decideWorkflow(planReview, approve, { actorId: WORKFLOW_AGENTX_ACTOR_ID, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [] })).toThrow(WorkflowTransitionError);
    expect(() => decideWorkflow(planReview, approve, { actorId: WORKFLOW_AGENTX_ACTOR_ID, role: "TASK_OWNER" }, { now: NOW, allowedSkipStages: [], authority: { actorId: WORKFLOW_AGENTX_ACTOR_ID, ownerIds: [ownerId] } }))
      .toThrow(WorkflowTransitionError);
  });

  it("keeps parsing every decision stored before AGENTX existed", () => {
    for (const stored of [
      { requestId: uuid(900), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "ok", artifactDigest: hex("b"), at: NOW },
      { requestId: uuid(901), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: ownerId, actorRole: "PROJECT_ADMIN", reason: "back", source: "SEND_BACK", at: NOW },
      { requestId: uuid(902), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: ownerId, actorRole: "TASK_OWNER", reason: "findings", source: "FINDINGS", at: NOW },
      { requestId: uuid(903), workflowRevision: 2, decision: "SKIP", actorId: ownerId, actorRole: "TASK_OWNER", reason: "skip", at: NOW },
    ]) expect(WorkflowDecisionRecordSchema.parse(stored)).toEqual(stored);
    const workflow = blocked("VERIFY", incomplete("g1: build-failed"), { decisions: [approval(1), ownerSendBack(2)], e2e: e2eProgress() });
    expect(decide(workflow)).toMatchObject({ action: "SEND_BACK" });
    expect(workflowAutoFixCounts(workflow.decisions)).toMatchObject({ sendBacksSincePlanApproval: 0, actions: 0 });
  });
});
