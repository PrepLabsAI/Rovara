import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import {
  E2EAssertionSchema, E2EExecutionPlanSchema, E2ERoundSchema, E2EScenarioSchema, E2EStepSchema,
  aggregateE2EVerification, e2eExecutionPlanDigest, projectE2EVerification,
} from "../../packages/contracts/src/e2e.js";

const target1 = { targetId: "web-1", applicationId: "app-1", runtimeProfileId: "browser-v1", accountProfileId: "account-v1", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 800 } };
const target2 = { ...target1, targetId: "web-2", applicationId: "app-2" };
const admittedAt = "2026-10-12T12:00:00.000Z";
const deadlineAt = "2026-10-12T12:05:00.000Z";
const expected = (_caseId: string, criterionId: string, targetId: string) => {
  const identity = { scenarioId: `scenario-${criterionId}`, targetId, requestedTargetId: targetId, accountProfileId: "account-v1", accountContextId: `context-${criterionId}`, accountContextDigest: createHash("sha256").update(`context-${criterionId}`).digest("hex"), executionDescriptorDigest: createHash("sha256").update(`descriptor-${criterionId}`).digest("hex"), minimumEvidence: "mock-contract", requiredRealComponentIds: [] as string[], agentId: "template-v1", repeat: 0, assertionDigests: ["4".repeat(64)] };
  return { caseId: e2eCaseIdFromIdentity(identity), criterionId, ...identity, upstreamTestId: e2eUpstreamTestIdFromIdentity(identity), assertionDigest: createHash("sha256").update(canonicalJson(identity.assertionDigests)).digest("hex"), required: true };
};
const reidentify = <T extends ReturnType<typeof expected>>(item: T): T => ({ ...item, caseId: e2eCaseIdFromIdentity(item), upstreamTestId: e2eUpstreamTestIdFromIdentity(item) });
const planWithDigest = <T extends Record<string, unknown>>(plan: T): T & { digest: string } => ({ ...plan, digest: e2eExecutionPlanDigest(plan as never) });
function fixture() {
  const cases1 = [expected("case-1", "criterion-1", "web-1")];
  const cases2 = [expected("case-2", "criterion-2", "web-2")];
  const plan = planWithDigest({ schemaVersion: 1, digest: "0".repeat(64), candidateDigest: "c".repeat(64), planDigest: "d".repeat(64), criteria: [
    { criterionId: "criterion-1", requirementId: "req-1", scenarioId: "scenario-criterion-1", requestedTargetId: "web-1", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: [cases1[0]!.caseId] },
    { criterionId: "criterion-2", requirementId: "req-2", scenarioId: "scenario-criterion-2", requestedTargetId: "web-2", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: [cases2[0]!.caseId] },
  ], effectiveTargets: [target1, target2], groups: [
    { groupId: "group-1", targetIds: ["web-1"], runtimeProfileId: "browser-v1", mode: "mock-only", mockManifestDigest: "5".repeat(64), expectedCases: cases1 },
    { groupId: "group-2", targetIds: ["web-2"], runtimeProfileId: "browser-v1", mode: "mock-only", mockManifestDigest: "6".repeat(64), expectedCases: cases2 },
  ], mocks: [], unavailableCriteria: [] });
  const common = { schemaVersion: 1, roundId: "a0000000-0000-4000-8000-000000000010", taskId: "task-current", operationId: "operation-current", operationFence: 3, workflowRevision: 7, executionPlanDigest: plan.digest, executionMode: "mock-only", authorizationRevision: "auth-current", candidateDigest: plan.candidateDigest, planDigest: plan.planDigest, policyDigest: "7".repeat(64), bundleDigest: "8".repeat(64), modelRouteRevision: null, admittedAt, deadlineAt };
  const makeBinding = (groupId: string, runId: string, appBuildDigest: string, environmentDigest: string, runtimeManifestDigest: string, mockManifestDigest: string, expectedCases: typeof cases1) => ({ ...common, runId, groupId, appBuildDigest, environmentDigest, runtimeManifestDigest, mockManifestDigest, expectedCases });
  const binding1 = makeBinding("group-1", "a0000000-0000-4000-8000-000000000001", "1".repeat(64), "2".repeat(64), "3".repeat(64), "5".repeat(64), cases1);
  const binding2 = makeBinding("group-2", "a0000000-0000-4000-8000-000000000002", "9".repeat(64), "a".repeat(64), "b".repeat(64), "6".repeat(64), cases2);
  const result = (binding: typeof binding1) => ({ schemaVersion: 1, binding, producer: "trusted-verifier", startedAt: "2026-10-12T12:00:01.000Z", finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed", qualification: "trusted", executionMode: "mock-only", reason: "complete", cases: binding.expectedCases.map((item) => ({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, status: "passed", reason: "assertions-passed", attemptCount: 1, assertionDigest: item.assertionDigest, assertionReceipts: item.assertionDigests.map((assertionDigest, assertionIndex) => ({ assertionIndex, assertionDigest, status: "passed", reason: "assertions-passed" })), artifacts: [], coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], unexercisedBehaviors: [] } })), rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed" });
  const round = { schemaVersion: 1, roundId: common.roundId, taskId: common.taskId, operationId: common.operationId, operationFence: common.operationFence, workflowRevision: common.workflowRevision, executionPlanDigest: common.executionPlanDigest, admittedAt, deadlineAt, limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null }, groupBindings: [binding1, binding2] };
  return { plan, round, bindings: [binding1, binding2], results: [result(binding1), result(binding2)] };
}

describe("review regressions for E2E contract foundation", () => {
  it("requires a complete current round before aggregation can pass", () => {
    const f = fixture();
    expect(aggregateE2EVerification(f.plan as never, f.results as never).results[0]?.status).toBe("UNKNOWN");
    expect(aggregateE2EVerification(f.plan as never, f.results as never, f.round as never).results[0]?.status).toBe("PASS");
    const previous = fixture();
    previous.results[1] = { ...previous.results[1]!, binding: { ...previous.bindings[1]!, runId: "a0000000-0000-4000-8000-000000000099", roundId: "a0000000-0000-4000-8000-000000000099", taskId: "task-old" } };
    expect(aggregateE2EVerification(f.plan as never, previous.results as never, f.round as never).results[0]?.status).toBe("UNKNOWN");
  });

  it("rejects mixed current task, fence, workflow, policy, bundle, authorization, route, and group manifests", () => {
    const f = fixture();
    const mutations = [
      { taskId: "task-other" }, { operationFence: 4 }, { workflowRevision: 8 }, { policyDigest: "f".repeat(64) },
      { bundleDigest: "e".repeat(64) }, { authorizationRevision: "auth-old" }, { modelRouteRevision: "route-old" },
      { appBuildDigest: "f".repeat(64) }, { environmentDigest: "e".repeat(64) }, { runtimeManifestDigest: "d".repeat(64) },
    ];
    for (const mutation of mutations) {
      const changed = [...f.results] as Array<Record<string, unknown>>;
      changed[1] = { ...changed[1], binding: { ...f.bindings[1], ...mutation } };
      expect(aggregateE2EVerification(f.plan as never, changed as never, f.round as never).results[0]?.status).toBe("UNKNOWN");
    }
  });

  it("does not project mismatched assertion digests or retries as passing", () => {
    const f = fixture();
    const changed = f.results[0]!;
    const assertion = { ...changed, cases: [{ ...changed.cases[0]!, assertionDigest: "f".repeat(64) }] };
    const retry = { ...changed, cases: [{ ...changed.cases[0]!, attemptCount: 2 }] };
    expect(projectE2EVerification(assertion as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification(retry as never).results[0]?.status).toBe("UNKNOWN");
    expect(aggregateE2EVerification(f.plan as never, [assertion, f.results[1]] as never, f.round as never).results[0]?.status).toBe("UNKNOWN");
  });

  it("rejects orphan, duplicated, or mismatched criterion and case membership", () => {
    const f = fixture();
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...f.plan, criteria: [] })).success).toBe(false);
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...f.plan, groups: [f.plan.groups[0], f.plan.groups[0]] })).success).toBe(false);
    const first = f.plan.criteria[0]!;
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...f.plan, criteria: [{ ...first, expectedCaseIds: [f.plan.groups[0]!.expectedCases[0]!.caseId, f.plan.groups[0]!.expectedCases[0]!.caseId] }, f.plan.criteria[1]] })).success).toBe(false);
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...f.plan, criteria: [{ ...first, scenarioId: "other-scenario" }, f.plan.criteria[1]] })).success).toBe(false);
  });

  it("keeps out-of-window results as history but projects them UNKNOWN", () => {
    const f = fixture();
    const result = f.results[0]!;
    expect(projectE2EVerification({ ...result, finishedAt: "2026-10-12T12:06:00.000Z" } as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification({ ...result, startedAt: "2026-10-12T11:59:59.000Z" } as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification({ ...result, receivedAt: "2026-10-12T12:55:08.000Z" } as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification({ ...result, receivedAt: "2026-10-12T12:05:07.000Z" } as never).results[0]?.status).toBe("PASS");
  });

  it("validates JSON-only scenario inputs without getters, serialization hooks, or digest collisions", () => {
    const base = { scenarioId: "s", requirementId: "r", requestedTargetIds: ["web-1"], required: true, accountProfileId: "account-v1", minimumEvidence: "source", requiredRealComponentIds: [], assertions: [{ kind: "visible", testId: "done", equals: true }] };
    const step = (input: unknown) => ({ kind: "invoke-contract", operationId: "export", input });
    expect(E2EStepSchema.safeParse(step({ left: "x".repeat(40000), right: "y".repeat(40000) })).success).toBe(false);
    for (const value of [undefined, () => true, NaN, Infinity, 1n, new Date(), { toJSON() { return {}; } }]) expect(E2EStepSchema.safeParse(step(value)).success).toBe(false);
    let getterRan = false;
    const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { getterRan = true; throw new Error("getter ran"); } });
    expect(() => E2EScenarioSchema.safeParse({ ...base, steps: [step(accessor)] })).not.toThrow();
    expect(E2EScenarioSchema.safeParse({ ...base, steps: [step(accessor)] }).success).toBe(false);
    expect(getterRan).toBe(false);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(E2EStepSchema.safeParse(step(cycle)).success).toBe(false);
    expect(E2EScenarioSchema.safeParse({ ...base, steps: [step({ a: "x".repeat(40000), b: "y".repeat(40000) })] }).success).toBe(false);
  });

  it("uses distinct file and same-origin application path validation", () => {
    const scenario = (step: unknown, assertions: unknown[] = [{ kind: "visible", testId: "done", equals: true }]) => ({ scenarioId: "s", requirementId: "r", requestedTargetIds: ["web-1"], required: true, accountProfileId: "account-v1", minimumEvidence: "source", requiredRealComponentIds: [], steps: [step], assertions });
    expect(E2EScenarioSchema.safeParse(scenario({ kind: "navigate", path: "/users" })).success).toBe(true);
    expect(E2EScenarioSchema.safeParse(scenario({ kind: "navigate", path: "javascript:alert(1)" })).success).toBe(false);
    expect(E2EAssertionSchema.safeParse({ kind: "http-status", path: "https://foreign.example/", method: "GET", equals: 200 }).success).toBe(false);
    expect(E2EAssertionSchema.safeParse({ kind: "file", fixtureRootId: "fixtures", relativePath: "%2e%2e/secret", sha256: "a".repeat(64) }).success).toBe(false);
  });

  it("maps trusted unstable outcomes to FAILED without promoting stale or exploratory results", () => {
    const f = fixture();
    expect(projectE2EVerification({ ...f.results[0], status: "unstable" } as never).results[0]?.status).toBe("FAILED");
    expect(projectE2EVerification({ ...f.results[0], status: "stale" } as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification({ ...f.results[0], status: "unstable", qualification: "exploratory" } as never).results[0]?.status).toBe("UNKNOWN");
    const optionalCase = reidentify({ ...f.bindings[0]!.expectedCases[0]!, scenarioId: "optional-scenario", required: false });
    const optional = { ...f.results[0], binding: { ...f.bindings[0]!, expectedCases: [...f.bindings[0]!.expectedCases, optionalCase] }, cases: [...f.results[0]!.cases, { ...f.results[0]!.cases[0]!, caseId: optionalCase.caseId, executionDescriptorDigest: optionalCase.executionDescriptorDigest, accountContextId: optionalCase.accountContextId, accountContextDigest: optionalCase.accountContextDigest, status: "failed" }] };
    expect(projectE2EVerification(optional as never).results[0]?.status).toBe("PASS");
  });

  it("bounds rounds by total cases, unique run/case IDs, and shared admission timeout", () => {
    const f = fixture();
    const makeLarge = (count: number) => f.bindings.slice(0, 2).map((binding, index) => ({ ...binding, groupId: `large-${index}`, runId: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, expectedCases: Array.from({ length: count }, (_, n) => reidentify({ ...binding.expectedCases[0]!, scenarioId: `large-scenario-${index}-${n}`, criterionId: `criterion-${index}-${n}`, required: false })) }));
    const baseRound = { ...f.round, groupBindings: makeLarge(32) };
    expect(E2ERoundSchema.safeParse(baseRound).success).toBe(true);
    expect(E2ERoundSchema.safeParse({ ...baseRound, groupBindings: makeLarge(33) }).success).toBe(false);
    expect(E2ERoundSchema.safeParse({ ...f.round, deadlineAt: "2026-10-12T23:00:00.000Z" }).success).toBe(false);
    expect(E2ERoundSchema.safeParse({ ...f.round, groupBindings: [f.bindings[0]!, { ...f.bindings[1]!, runId: f.bindings[0]!.runId }] }).success).toBe(false);
  });
});
