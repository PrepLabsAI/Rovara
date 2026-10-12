import { describe, expect, it } from "vitest";
import {
  E2EPolicySchema,
  E2EScenarioBundleSchema,
  E2EExecutionPlanSchema,
  E2EQualifiedResultSchema,
  aggregateE2EVerification,
  e2eExecutionPlanDigest,
  E2E_WORKER_PROTOCOL,
  assertE2EWorkerProtocol,
  e2eBindingDigest,
  projectE2EVerification,
  validateE2EScenarioBundleForPolicy,
} from "../../packages/contracts/src/e2e.js";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/project.js";
import { WorkflowCheckSchema } from "../../packages/contracts/src/task-workflow.js";

const limits = {
  runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000,
  maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null,
};
const target = { targetId: "web-main", applicationId: "app-main", runtimeProfileId: "browser-linux", accountProfileId: "synthetic-tenant" , kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 800 } };
const policy = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["home"], targets: [target],
  defaultSandboxProfileId: "sandbox-v1", fallback: "mock-unconnected", modelRouteRevision: null,
  capture: { screenshots: false, traces: false, video: false, downloads: false }, limits, ...overrides,
});
const planWithDigest = <T extends Record<string, unknown>>(plan: T): T & { digest: string } => ({ ...plan, digest: e2eExecutionPlanDigest(plan as never) });

function baseBinding() {
  return {
    schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000001", roundId: "a0000000-0000-4000-8000-000000000002",
    taskId: "task-1", operationId: "operation-1", operationFence: 1, workflowRevision: 1, groupId: "group-1",
    executionPlanDigest: "a".repeat(64), executionMode: "mock-only", mockManifestDigest: "b".repeat(64), authorizationRevision: "auth-r1",
    candidateDigest: "c".repeat(64), planDigest: "d".repeat(64), policyDigest: "e".repeat(64), bundleDigest: "f".repeat(64),
    appBuildDigest: "1".repeat(64), environmentDigest: "2".repeat(64), runtimeManifestDigest: "3".repeat(64), modelRouteRevision: null,
    expectedCases: [{ caseId: "case-1", criterionId: "criterion-1", scenarioId: "home", upstreamTestId: "home", targetId: "web-main", requestedTargetId: "web-main", agentId: "template-v1", repeat: 0, assertionDigest: "4".repeat(64), required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [] }],
    admittedAt: "2026-10-12T12:00:00.000Z", deadlineAt: "2026-10-12T12:05:00.000Z",
  };
}

const successfulResult = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, binding: baseBinding(), producer: "trusted-verifier", startedAt: "2026-10-12T12:00:01.000Z",
  finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed", qualification: "trusted",
  executionMode: "mock-only", reason: "complete", cases: [{ caseId: "case-1", status: "passed", reason: "assertions-passed", attemptCount: 1,
    assertionDigest: "4".repeat(64), artifacts: [], coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], unexercisedBehaviors: [] } }],
  rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed", ...overrides,
});

describe("E2E contracts", () => {
  it("keeps legacy project and workflow records valid when E2E fields are absent", () => {
    const legacy = ProjectDefinitionSchema.safeParse({ name: "payments", revision: 1, repositories: [{ name: "payments-api", url: "https://github.com/example/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }], setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker." });
    expect(legacy.success).toBe(true);
    expect(E2E_WORKER_PROTOCOL).toBe("trusted-e2e/v1");
    expect(() => assertE2EWorkerProtocol("trusted-e2e/v9")).toThrow(/does not support/);
  });

  it("rejects unknown policy fields and installation hard-ceiling overruns", () => {
    expect(E2EPolicySchema.safeParse(policy({ limits: { ...limits, runTimeoutMs: 1800001 } })).success).toBe(false);
    expect(E2EPolicySchema.safeParse(policy({ unexpected: true })).success).toBe(false);
  });

  it("rejects duplicate requested targets, scenarios, criteria, and expected cases", () => {
    expect(E2EPolicySchema.safeParse(policy({ targets: [target, target] })).success).toBe(false);
    const scenario = { scenarioId: "home", requirementId: "req", requestedTargetIds: ["web-main"], required: true, accountProfileId: "synthetic-tenant", minimumEvidence: "source", requiredRealComponentIds: [], steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "page", equals: true }] };
    const bundle = { schemaVersion: 1, planDigest: "a".repeat(64), bundleDigest: "b".repeat(64), templateVersion: "trusted-v1", scenarios: [scenario, scenario] };
    expect(E2EScenarioBundleSchema.safeParse(bundle).success).toBe(false);
    const plan = planWithDigest({ schemaVersion: 1, digest: "a".repeat(64), candidateDigest: "b".repeat(64), planDigest: "c".repeat(64), criteria: [], effectiveTargets: [], groups: [], mocks: [], unavailableCriteria: [] });
    expect(E2EExecutionPlanSchema.safeParse(plan).success).toBe(true);
    const expected = { ...baseBinding().expectedCases[0], criterionId: "criterion-1" };
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...plan, groups: [{ groupId: "g1", targetIds: ["web-main"], runtimeProfileId: "sandbox-v1", mode: "mock-only", mockManifestDigest: "d".repeat(64), expectedCases: [expected, expected] }], effectiveTargets: [target] })).success).toBe(false);
  });

  it("does not project exploratory, simulation-only, or insufficient-evidence passes as PASS", () => {
    const exploratory = projectE2EVerification(successfulResult({ qualification: "exploratory" }) as never);
    expect(exploratory.results[0]?.status).toBe("UNKNOWN");
    const simulation = successfulResult();
    (simulation.cases[0]!.coverage as { subject: string }).subject = "simulation";
    expect(projectE2EVerification(simulation as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification(successfulResult({ cases: [] }) as never).results[0]?.status).toBe("UNKNOWN");
  });

  it("permits a null model route only for bundles without agent steps", () => {
    const scenario = { scenarioId: "agent", requirementId: "r", requestedTargetIds: ["web-main"], required: true, accountProfileId: "synthetic-tenant", minimumEvidence: "source", requiredRealComponentIds: [], steps: [{ kind: "agent", goal: "do work", maxActions: 1 }], assertions: [{ kind: "visible", testId: "done", equals: true }] };
    const bundle = { schemaVersion: 1, planDigest: "a".repeat(64), bundleDigest: "a5a5fb82d39eafe8bc7f4649b7f52ef1c1c7c07d8353cad27593506d4a24fb02", templateVersion: "trusted-v1", scenarios: [scenario] };
    expect(E2EScenarioBundleSchema.safeParse(bundle).success).toBe(true);
    expect(() => validateE2EScenarioBundleForPolicy(bundle, policy())).toThrow(/model route/);
  });

  it("retains requested and effective target identities in criteria and group cases", () => {
    const testPlan = planWithDigest({ schemaVersion: 1, digest: "a".repeat(64), candidateDigest: "b".repeat(64), planDigest: "c".repeat(64), criteria: [{ criterionId: "criterion-1", requirementId: "r1", scenarioId: "s1", requestedTargetId: "requested-web", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: ["case-1"] }], effectiveTargets: [{ targetId: "web-main", applicationId: "app-main", runtimeProfileId: "browser-linux", accountProfileId: "synthetic-tenant", kind: "contract", requestedTargetId: "requested-web", adapterProfileId: "adapter-v1" }], groups: [{ groupId: "g1", targetIds: ["web-main"], runtimeProfileId: "sandbox-v1", mode: "mock-only", mockManifestDigest: "d".repeat(64), expectedCases: [{ ...baseBinding().expectedCases[0], scenarioId: "s1", targetId: "web-main", requestedTargetId: "requested-web" }] }], mocks: [], unavailableCriteria: [] });
    expect(E2EExecutionPlanSchema.safeParse(testPlan).success).toBe(true);
  });

  it("refuses project-e2e command collisions and reserves the check identity", () => {
    const validProject = { name: "payments", revision: 1, repositories: [{ name: "payments-api", url: "https://github.com/example/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }], setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker." };
    expect(ProjectDefinitionSchema.safeParse({ ...validProject, e2e: policy() }).success).toBe(true);
    expect(WorkflowCheckSchema.safeParse({ id: "project-e2e", label: "fake", command: { cwd: "repo/payments-api", executable: "true", args: [], timeoutSeconds: 1 } }).success).toBe(false);
  });

  it("binds deterministic group and run limits to the round deadline", () => {
    const binding = baseBinding();
    expect(e2eBindingDigest(binding as never)).toBe("2d22c47f30122809e129747876bc1250949e59efb801530ac0ab3ad87fae51eb");
    expect(E2EQualifiedResultSchema.safeParse(successfulResult()).success).toBe(true);
    expect(E2EQualifiedResultSchema.safeParse(successfulResult({ modelReceiptIds: ["receipt-1"] })).success).toBe(false);
    const unknownProtocol = { ...successfulResult(), binding: { ...binding, protocol: "trusted-e2e/v9" } };
    expect(E2EQualifiedResultSchema.safeParse(unknownProtocol).success).toBe(false);
  });

  it("keeps a required criterion UNKNOWN when its group has no result", () => {
    const expected = { ...baseBinding().expectedCases[0], criterionId: "criterion-1" };
    const plan = planWithDigest({ schemaVersion: 1, digest: "a".repeat(64), candidateDigest: "b".repeat(64), planDigest: "c".repeat(64), criteria: [{ criterionId: "criterion-1", requirementId: "req-1", scenarioId: "home", requestedTargetId: "web-main", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: ["case-1"] }], effectiveTargets: [target], groups: [{ groupId: "group-1", targetIds: ["web-main"], runtimeProfileId: "browser-linux", mode: "mock-only", mockManifestDigest: "b".repeat(64), expectedCases: [expected] }], mocks: [], unavailableCriteria: [] });
    expect(aggregateE2EVerification(plan as never, []).results[0]?.status).toBe("UNKNOWN");
    const emptyRequired = planWithDigest({ ...plan, criteria: [{ ...plan.criteria[0], expectedCaseIds: [] }], groups: [], unavailableCriteria: [{ criterionId: "criterion-1", reason: "runtime profile unavailable" }] });
    expect(E2EExecutionPlanSchema.safeParse(emptyRequired).success).toBe(true);
    expect(aggregateE2EVerification(emptyRequired as never, []).results[0]?.status).toBe("UNKNOWN");
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...emptyRequired, unavailableCriteria: [] })).success).toBe(false);
  });
});
