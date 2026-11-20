// Setup and test health SH5: the broker's result classifier. Every row of design 4.1 and 4.2; "Code failed" wins; the worker's own words are never trusted.
import { describe, expect, it } from "vitest";
import {
  AUTO_FIX_CODES, AUTO_FIX_TRANSIENT_GROUP_CODES, E2E_APPLICATION_SEND_BACK_CODES, EvidencePackSchema, WORKFLOW_AGENTX_ACTOR_ID,
  WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX,
  WORKFLOW_BLOCK_REASONS, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, createCandidateManifest, createWorkflowSnapshot, wholeTaskSpendUsd,
  type AutoFixBudget, type AutoFixFacts, type WorkflowDecision, type WorkflowSnapshot,
} from "@agentx/contracts";
import { RESULT_RULES, classifyTestingResult, hasUnconfirmedFailingTest, newFailingCheckIds, readableFailingTests, workflowCheckKind, type ResultInput, type ResultOutcome } from "../../packages/broker/src/core/proof/verification-result.js";

const taskId = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const ownerId = "a".repeat(64);
const NOW = "2026-11-01T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "app", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
const otherCandidate = createCandidateManifest([{ repositoryId: "app", commitSha: "4".repeat(40), treeSha: "5".repeat(40), baseCommitSha: "3".repeat(40) }]);
const roundId = "11111111-1111-4111-8111-111111111111";
const groupRunId = "22222222-2222-4222-8222-222222222222";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hex = (char: string): string => char.repeat(64);
type Over = Record<string, unknown>;

const budget = (over: Partial<AutoFixBudget> = {}): AutoFixBudget => ({ enabled: true, dayBudgetHasRoom: true, baselineRequests: 0, spend: { spentUsd: wholeTaskSpendUsd(2), roundEstimateUsd: 2, capUsd: 15 }, ...over });
const approval = (n: number): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 2, decision: "APPROVE", actorId: ownerId, actorRole: "TASK_OWNER", reason: "approved", artifactDigest: hex("b"), at: NOW,
});
const automatic = (n: number, source: "AUTO_FIX" | "AUTO_RETRY", stage: "VERIFY" | "REVIEW" = "VERIFY"): WorkflowDecision => WorkflowDecisionRecordSchema.parse({
  requestId: uuid(n), workflowRevision: 5, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic", source, at: NOW, auto: { stage, candidateDigest: candidate.digest },
});
const RETRY_USED = [approval(1), automatic(2, "AUTO_RETRY")];

function snapshot(stage: "VERIFY" | "REVIEW", state: "BLOCKED" | "READY" | "RUNNING", blockReason: string | undefined, over: Over = {}): WorkflowSnapshot {
  return WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId, now: NOW }), revision: 7, stage, state, ...(blockReason === undefined ? {} : { blockReason }), candidate, decisions: [approval(1)], ...over,
  });
}
const blocked = (stage: "VERIFY" | "REVIEW", reason: string | undefined, over: Over = {}) => snapshot(stage, "BLOCKED", reason, over);
const e2eProgress = (over: Over = {}): Over => ({ contractDigest: hex("c"), policyDigest: hex("d"), bundleDigest: hex("e"), executionPlanDigest: hex("f"), required: true, currentRoundId: roundId, currentGroupRunIds: [groupRunId], resultRefs: [], ...over });
const verifyE2e = (reason: string, over: Over = {}) => blocked("VERIFY", reason, { e2e: e2eProgress(), ...over });
const incomplete = (...entries: string[]): string => `${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (${entries.join("; ")})`;
const results = (rows: Over[], digest = candidate.digest): Over => ({ verification: { candidateDigest: digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: rows } });
const check = (checkId: string, status: string, extra: Over = {}): Over => ({ checkId, status, ...extra });
const passed = (over: Over = {}) => snapshot("REVIEW", "READY", undefined, { ...results([check("unit", "PASS"), check("lint", "PASS")]), ...over });

function pack(checks: Over[] = [], over: Over = {}) {
  return EvidencePackSchema.parse({
    schemaVersion: 1, candidateDigest: candidate.digest,
    environment: { tier: "sandbox", envRevision: 1, services: [], data: "synthetic", accounts: [] },
    checks: checks.map((entry) => ({ checkId: "unit", kind: "test", label: "unit", before: "passed", after: "passed", class: "passing", durationMs: 5, ...entry })),
    selection: { method: "full", selected: 10, total: 10 }, api: [], browser: [], notTested: [], ...over,
  });
}
const tests = (failedNames: string[], extra: Over = {}) => ({
  total: 10, passed: 10 - failedNames.length, failed: failedNames.length, skipped: 0, errored: 0, newTests: [],
  names: failedNames.map((name) => ({ name, status: "failed" })), ...extra,
});

function run(workflow: WorkflowSnapshot, over: Partial<ResultInput> = {}): ResultOutcome {
  return classifyTestingResult({ workflow, facts: {}, budget: budget(), evidence: pack([{}]), alreadyFailing: [], ...over });
}
const decided = (result: string, reasons: string[] = []) => ({ decided: true, result, reasons });
const waiting = (waitingFor: string) => ({ decided: false, waiting: waitingFor });

describe("design 4.2: every auto-fix code has exactly one place", () => {
  it("lists every code, and no other", () => {
    expect(Object.keys(RESULT_RULES).sort()).toEqual([...AUTO_FIX_CODES].sort());
  });
});

describe("Verified and Partially verified (nothing failed or blocked)", () => {

  it("is never Verified without a current verification, a candidate, or evidence for exactly this code", () => {
    expect(run(passed({ candidate: undefined, verification: undefined }))).toEqual(waiting("not_checked_yet"));
    expect(run(snapshot("REVIEW", "READY", undefined, results([check("unit", "PASS")], otherCandidate.digest)))).toEqual(waiting("not_checked_yet"));
    expect(run(passed(), { evidence: undefined })).toEqual(decided("partially_verified", ["evidence_missing"]));
    expect(run(passed(), { evidence: { ...pack([{}]), candidateDigest: otherCandidate.digest } })).toEqual(decided("partially_verified", ["evidence_missing"]));
  });

  it("is Partially verified when no check was selected", () => {
    const reviewOnly = snapshot("REVIEW", "READY", undefined, { verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [], reviewOnly: true } });
    expect(run(reviewOnly)).toEqual(decided("partially_verified", ["no_checks_ran"]));
  });

  it("is Partially verified for each thing planned that did not run", () => {
    const notTested = (kind: string, id = "x") => pack([{}], { notTested: [{ kind, id, text: "x", reason: "x" }] });
    expect(run(passed(), { evidence: notTested("claim") })).toEqual(decided("partially_verified", ["claim_not_tested"]));
    expect(run(passed(), { evidence: notTested("scenario") })).toEqual(decided("partially_verified", ["scenario_not_tested"]));
    expect(run(passed(), { evidence: notTested("check") })).toEqual(decided("partially_verified", ["check_not_run"]));
    expect(run(passed(), { evidence: notTested("environment") })).toEqual(decided("partially_verified", ["evidence_unreadable"]));
    expect(run(passed(), { evidence: pack([{ after: "not_run", class: "not_rerun" }]) })).toEqual(decided("partially_verified", ["check_not_run"]));
    expect(run(passed(), { evidence: pack([{ after: "unknown", class: "not_rerun" }]) })).toEqual(decided("partially_verified", ["check_not_run"]));
    expect(run(passed(), { planned: { fullSuite: "pending" } })).toEqual(decided("partially_verified", ["full_suite_pending"]));
    expect(run(passed(), { planned: { fullSuite: "not_run" } })).toEqual(decided("partially_verified", ["full_suite_not_run"]));
    expect(run(passed(), { planned: { fullSuite: "not_needed" } })).toEqual(decided("verified"));
  });

  it("counts a mocked service only when a claim needs the real one, and not-selected tests never lower the result", () => {
    const mocked = pack([{}], { notTested: [{ kind: "mocked_service", id: "scorer", text: "scorer is mocked", reason: "answered from recorded responses" }, { kind: "not_selected", id: "selection", text: "3 of 10 not run", reason: "not selected" }] });
    expect(run(passed(), { evidence: mocked })).toEqual(decided("verified"));
    expect(run(passed(), { evidence: mocked, planned: { claimsNeedingRealService: ["scorer"] } })).toEqual(decided("partially_verified", ["real_service_not_tested"]));
    expect(run(passed(), { evidence: mocked, planned: { claimsNeedingRealService: ["other"] } })).toEqual(decided("verified"));
  });

  it("is not Verified while required browser or API checks are not qualified on this code", () => {
    expect(run(snapshot("VERIFY", "RUNNING", undefined, { ...results([check("unit", "PASS")]), e2e: e2eProgress() }))).toEqual(waiting("not_checked_yet"));
  });

  it("is not decided when a result is not a pass and no signal explains it", () => {
    expect(run(snapshot("REVIEW", "READY", undefined, results([check("unit", "FAILED")])))).toEqual(waiting("not_checked_yet"));
    expect(run(snapshot("VERIFY", "BLOCKED", undefined, results([check("unit", "PASS"), check("lint", "UNKNOWN")])))).toEqual(waiting("cause_unknown"));
  });
});

describe("Code failed (4.2 code rows)", () => {
  it("is Code failed for each fault the new code causes", () => {
    for (const groupCode of E2E_APPLICATION_SEND_BACK_CODES) {
      expect(run(verifyE2e(incomplete(`g1: ${groupCode}`)))).toEqual(decided("code_failed", ["app_failed"]));
    }
    const failedRound = { status: "FAILED", candidateDigest: candidate.digest, roundId, groupRunIds: [groupRunId], admissionSha256: hex("7"), evidenceSha256: hex("8") };
    expect(run(verifyE2e("one or more admitted E2E groups failed", { e2e: e2eProgress({ failedRound }) }))).toEqual(decided("code_failed", ["e2e_assertion_failed"]));
    expect(run(verifyE2e(`${WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX}the build source is unusable.`))).toEqual(decided("code_failed", ["round_refused"]));
    expect(run(blocked("VERIFY", WORKFLOW_BLOCK_REASONS.regressionFound))).toEqual(decided("code_failed", ["regression_found"]));
    expect(run(blocked("VERIFY", undefined, results([check("unit", "FAILED")])), { facts: { checkOriginal: { unit: "passed" } } })).toEqual(decided("code_failed", ["check_failed"]));
    expect(run(blocked("VERIFY", undefined, results([check("unit", "FAILED")])), { facts: { checkExpectsPass: ["unit"] } })).toEqual(decided("code_failed", ["check_failed"]));
  });

  it("is Code failed when an unclear E2E round passed on the original code in every group, and only then", () => {
    const unknown = () => verifyE2e(`${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (evidence floor unmet)`);
    expect(run(unknown(), { facts: { e2eUnknownGroups: { g1: "passed", g2: "passed" } } })).toEqual(decided("code_failed", ["e2e_assertion_failed"]));
    for (const garbage of ["PASS", "ok", "", null, 1, true]) expect(run(unknown(), { facts: { e2eUnknownGroups: { g1: "passed", g2: garbage as never } } })).toEqual(waiting("cause_unknown"));
  });

  it("does not count a review's findings as a test result", () => {
    const review = { operationId: uuid(90), candidateDigest: candidate.digest, role: "CRITIC", provider: "p", version: "1", status: "FINDINGS", findings: [{ text: "bug", origin: "INTRODUCED" }], readOnly: true, recordedAt: NOW };
    const securityReview = { ...review, operationId: uuid(91), role: "SECURITY", status: "PASS", findings: [] };
    const atReview = blocked("REVIEW", undefined, { ...results([check("unit", "PASS")]), reviews: [review, securityReview] });
    expect(run(atReview)).toEqual(decided("verified"));
  });
});

describe("a test that fails on the original code too (4.2 fails-on-original-code)", () => {
  const failing = () => blocked("VERIFY", undefined, results([check("unit", "FAILED")]));
  const facts: AutoFixFacts = { checkOriginal: { unit: "failed" } };
  /** The task's own check list names `unit` with this kind (the broker takes a check's kind from it when the pack does not name the check). */
  const withKind = (kind: string | undefined, id = "unit") => blocked("VERIFY", undefined, { ...results([check(id, "FAILED")]), checkPolicy: { required: [{ id, label: id, command: { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 }, ...(kind === undefined ? {} : { kind }) }], optional: [], selectedOptionalIds: [], proposed: [] } });
  const evidence = (names: string[], extra: Over = {}) => pack([{ checkId: "unit", before: "failed", after: "failed", class: "already_failing", tests: tests(names), ...extra }]);

  it("never excuses a test the change itself added, even when its name is in the already-failing set", () => {
    const added = evidence(["t1", "t2"], { tests: tests(["t1", "t2"], { newTests: ["t2"] }) });
    expect(run(failing(), { facts, evidence: added, alreadyFailing: ["t1", "t2"] })).toEqual(decided("code_failed", ["new_failing_test", "fails_on_original_code"]));
    expect(run(failing(), { facts, evidence: added, alreadyFailing: [{ name: "t1", checkId: "unit" }, { name: "t2", checkId: "unit" }] })).toEqual(decided("code_failed", ["new_failing_test", "fails_on_original_code"]));
    expect(run(failing(), { facts, evidence: evidence(["t1"], { tests: tests(["t1"], { newTests: ["other"] }) }), alreadyFailing: ["t1"] })).toEqual(decided("partially_verified", ["known_failing_only"]));
  });

  // M2 (second Opus re-check): a test check with no usable per-test data cannot confirm anything, so it is the code's fault, not "Blocked by environment" (a compile error or an import that breaks collection runs no test at all).
  it("is Code failed when a failed test check has no usable per-test data (no counts, a zero count, a compile or import break), or there is no pack for this code", () => {
    const sameReasons = decided("code_failed", ["new_failing_test", "fails_on_original_code"]);
    expect(run(failing(), { facts, evidence: pack([{ checkId: "unit", before: "failed", after: "failed", class: "already_failing" }]), alreadyFailing: ["t1"] })).toEqual(sameReasons);
    expect(run(failing(), { facts, evidence: evidence([], { tests: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0, newTests: [], names: [] } }), alreadyFailing: ["t1"] })).toEqual(sameReasons);
    expect(run(withKind("test"), { facts, evidence: undefined, alreadyFailing: ["t1"] })).toEqual(sameReasons);
    // A pack for other code is no pack for this one.
    expect(run(withKind("test"), { facts, evidence: { ...evidence(["t1"]), candidateDigest: otherCandidate.digest }, alreadyFailing: ["t1"] })).toEqual(sameReasons);
    // A pack that names other checks only.
    expect(run(withKind("test"), { facts, evidence: pack([{ checkId: "other", before: "passed", after: "passed", class: "passing" }]), alreadyFailing: ["t1"] })).toEqual(sameReasons);
  });

  // M2 scope (coordinator): the no-pack rule is about TESTS. The kind comes from the task's own check list by check id; unknown or not `test` keeps the old rule (Blocked by environment).
  it("keeps the old rule (Blocked) for a lint, another kind, or a check the task's list does not name, with no pack or a pack that does not name it", () => {
    const old = decided("blocked_by_environment", ["fails_on_original_code"]);
    for (const kind of ["lint", "typecheck", "build", "other", undefined]) {
      expect(run(withKind(kind), { facts, evidence: undefined, alreadyFailing: ["t1"] }), String(kind)).toEqual(old);
      expect(run(withKind(kind), { facts, evidence: pack([{ checkId: "other", before: "passed", after: "passed", class: "passing" }]), alreadyFailing: ["t1"] }), String(kind)).toEqual(old);
    }
    // The list does not name the failed check at all.
    const unlisted = blocked("VERIFY", undefined, { ...results([check("unit", "FAILED")]), checkPolicy: { required: [{ id: "elsewhere", label: "x", command: { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 }, kind: "test" }], optional: [], selectedOptionalIds: [], proposed: [] } });
    expect(run(unlisted, { facts, evidence: undefined, alreadyFailing: ["t1"] })).toEqual(old);
    expect(run(failing(), { facts, evidence: undefined, alreadyFailing: ["t1"] })).toEqual(old);
    expect(workflowCheckKind(withKind("lint"), "unit")).toBe("lint");
    expect(workflowCheckKind(withKind("lint"), "nope")).toBeUndefined();
  });

  it("is Code failed when a failing test name appears twice (one known name cannot stand for two failures)", () => {
    const twice = evidence(["t1", "t1"]);
    expect(run(failing(), { facts, evidence: twice, alreadyFailing: ["t1"] })).toEqual(decided("code_failed", ["new_failing_test", "fails_on_original_code"]));
    expect(hasUnconfirmedFailingTest(twice.checks[0]!, ["t1"])).toBe(true);
    expect(newFailingCheckIds(twice, ["t1"])).toEqual(["unit"]);
    expect(readableFailingTests(twice.checks[0]!)).toBeUndefined();
    expect(readableFailingTests(evidence(["a", "b"]).checks[0]!)).toEqual(["a", "b"]);
  });

  it("is Blocked for an unclear E2E round whose groups also fail on the original code", () => {
    const unknown = verifyE2e(`${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (evidence floor unmet)`);
    expect(run(unknown, { facts: { e2eUnknownGroups: { g1: "failed" } } })).toEqual(decided("blocked_by_environment", ["fails_on_original_code"]));
    expect(run(unknown, { facts: { e2eUnknownGroups: { g1: "passed", g2: "cannot-run" } } })).toEqual(decided("blocked_by_environment", ["fails_on_original_code"]));
  });
});

describe("unclear faults are not decided (4.2 unchanged)", () => {
  const unknown = () => verifyE2e(`${WORKFLOW_APPLICATION_EVIDENCE_INCOMPLETE_PREFIX} (evidence floor unmet)`);

  it("waits for the original-code run, and for an unknown cause", () => {
    expect(run(unknown())).toEqual(waiting("original_code_pending"));
    expect(run(unknown(), { facts: { e2eUnknownGroups: { g1: "pending" } } })).toEqual(waiting("original_code_pending"));
    expect(run(unknown(), { facts: { e2eUnknownGroups: { g1: "not-run" } } })).toEqual(waiting("original_code_pending"));
    expect(run(unknown(), { facts: { e2eUnknownGroups: { g1: "passed", g2: "skipped" } } })).toEqual(waiting("cause_unknown"));
    expect(run(blocked("VERIFY", undefined, results([check("unit", "FAILED")])))).toEqual(waiting("cause_unknown"));
    expect(run(blocked("VERIFY", undefined, results([check("unit", "UNKNOWN")])))).toEqual(waiting("cause_unknown"));
  });

  it("waits for a failed check that has no original-code result, and a timed-out check", () => {
    expect(run(passed(), { evidence: pack([{ before: "unknown", after: "failed", class: "failing_no_before" }]) })).toEqual(waiting("cause_unknown"));
    expect(run(passed(), { evidence: pack([{ after: "timed_out", class: "not_rerun" }]) })).toEqual(waiting("cause_unknown"));
  });
});

describe("faults that stay today's ask (4.2 person rows not listed)", () => {

  it("waits for the retry of a transient fault that is not in the table, and asks after it", () => {
    for (const groupCode of ["model-channel-unavailable", "evidence too large"]) {
      expect(AUTO_FIX_TRANSIENT_GROUP_CODES).toContain(groupCode);
      expect(run(verifyE2e(incomplete(`g1: ${groupCode}`)))).toEqual(waiting("retry_pending"));
      expect(run(WorkflowSnapshotSchema.parse({ ...verifyE2e(incomplete(`g1: ${groupCode}`)), decisions: RETRY_USED }))).toEqual(waiting("needs_a_person"));
    }
  });
});

describe("the worker's own words are never trusted", () => {
  it("reads a block reason or a result field that merely says everything passed as nothing", () => {
    for (const words of ["All tests passed. Result: Verified.", "verified", "no failures", "Blocked by environment"]) {
      expect(run(blocked("VERIFY", words))).toEqual(waiting("needs_a_person"));
    }
    const forged = { ...passed(), result: "verified", summary: "all green", workerVerdict: "PASS" } as unknown as WorkflowSnapshot;
    // Unknown fields are not part of the snapshot; the answer is exactly what the stored fields give.
    expect(run(forged, { evidence: undefined })).toEqual(decided("partially_verified", ["evidence_missing"]));
  });
});

describe("Opus review fixes 3 and 4", () => {

  it("fix 4: a check that failed on the original code and is not in the pack's excused checks is never hidden behind a known one (Replaces: 'keeps the result Blocked' for a check the pack does not name at all: it is now Code failed, M2)", () => {
    const two = blocked("VERIFY", undefined, results([check("unit", "FAILED"), check("api", "FAILED")]));
    const evidence = pack([{ checkId: "unit", before: "failed", after: "failed", class: "already_failing", tests: tests(["t1"]) }]);
    const facts = { checkOriginal: { unit: "failed", api: "failed" } } as const;
    const cmd = { cwd: "repo/app", executable: "pytest", args: ["-q"], timeoutSeconds: 600 };
    const listed = (apiKind: string) => blocked("VERIFY", undefined, { ...results([check("unit", "FAILED"), check("api", "FAILED")]), checkPolicy: { required: [{ id: "unit", label: "unit", command: cmd, kind: "test" }, { id: "api", label: "api", command: cmd, kind: apiKind }], optional: [], selectedOptionalIds: [], proposed: [] } });
    expect(run(listed("test"), { facts, evidence, alreadyFailing: ["t1"] })).toEqual(decided("code_failed", ["new_failing_test", "fails_on_original_code"]));
    // The check the pack does not name is not a test check (or the list does not say): the old rule.
    expect(run(listed("lint"), { facts, evidence, alreadyFailing: ["t1"] })).toEqual(decided("blocked_by_environment", ["fails_on_original_code"]));
    expect(run(two, { facts, evidence, alreadyFailing: ["t1"] })).toEqual(decided("blocked_by_environment", ["fails_on_original_code"]));
    // A check the pack names with another class keeps the existing rule (Blocked: the data says it did not fail before).
    const named = pack([
      { checkId: "unit", before: "failed", after: "failed", class: "already_failing", tests: tests(["t1"]) },
      { checkId: "api", kind: "lint", before: "failed", after: "failed", class: "already_failing" },
    ]);
    expect(run(two, { facts, evidence: named, alreadyFailing: ["t1"] })).toEqual(decided("blocked_by_environment", ["fails_on_original_code"]));
    // Both covered and known: still Partially verified.
    const both = pack([
      { checkId: "unit", before: "failed", after: "failed", class: "already_failing", tests: tests(["t1"]) },
      { checkId: "api", before: "failed", after: "failed", class: "already_failing", tests: tests(["t2"]) },
    ]);
    expect(run(two, { facts, evidence: both, alreadyFailing: ["t1", "t2"] })).toEqual(decided("partially_verified", ["known_failing_only"]));
    // One of the two has a failing test nobody knows: the code's fault, whatever the other one is.
    expect(run(two, { facts, evidence: both, alreadyFailing: ["t1"] })).toEqual(decided("code_failed", ["new_failing_test", "fails_on_original_code"]));
  });
});
