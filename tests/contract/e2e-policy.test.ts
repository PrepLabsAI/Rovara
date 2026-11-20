import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EPolicySchema, E2EScenarioBundleSchema, E2EExecutionPlanSchema, E2EQualifiedResultSchema, aggregateE2EVerification, e2eExecutionPlanDigest, E2E_WORKER_PROTOCOL, assertE2EWorkerProtocol, e2eBindingDigest, projectE2EVerification, validateE2EScenarioBundleForPolicy, E2EAppRecipeSchema, E2EAssertionSchema, E2EScenarioSchema, E2EStepSchema, E2ERoundSchema } from "../../packages/contracts/src/e2e-node.js";
import { ProjectDefinitionSchema } from "../../packages/contracts/src/project-node.js";
import { WorkflowCheckSchema } from "../../packages/contracts/src/task-workflow-node.js";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";

const limits = {
  runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000,
  maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null,
};
const target = { targetId: "web-main", applicationId: "app-main", runtimeProfileId: "browser-linux", accountProfileId: "synthetic-tenant" , kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 800 } };
const caseIdentity = { scenarioId: "home", targetId: "web-main", requestedTargetId: "web-main", accountProfileId: "synthetic-tenant", accountContextId: "account-home", accountContextDigest: "5".repeat(64), executionDescriptorDigest: "6".repeat(64), minimumEvidence: "mock-contract", requiredRealComponentIds: [] as string[], agentId: "template-v1", repeat: 0, assertionDigests: ["4".repeat(64)] };
const expectedCase = { caseId: e2eCaseIdFromIdentity(caseIdentity), criterionId: "criterion-1", ...caseIdentity, upstreamTestId: e2eUpstreamTestIdFromIdentity(caseIdentity), assertionDigest: createHash("sha256").update(canonicalJson(caseIdentity.assertionDigests)).digest("hex"), required: true };
const reidentify = (item: typeof expectedCase): typeof expectedCase => ({ ...item, caseId: e2eCaseIdFromIdentity(item), upstreamTestId: e2eUpstreamTestIdFromIdentity(item) });
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
    expectedCases: [expectedCase],
    admittedAt: "2026-10-12T12:00:00.000Z", deadlineAt: "2026-10-12T12:05:00.000Z",
  };
}

const successfulResult = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, binding: baseBinding(), producer: "trusted-verifier", startedAt: "2026-10-12T12:00:01.000Z",
  finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed", qualification: "trusted",
  executionMode: "mock-only", reason: "complete", cases: [{ caseId: expectedCase.caseId, executionDescriptorDigest: expectedCase.executionDescriptorDigest, accountContextId: expectedCase.accountContextId, accountContextDigest: expectedCase.accountContextDigest, status: "passed", reason: "assertions-passed", attemptCount: 1,
    assertionDigest: baseBinding().expectedCases[0]!.assertionDigest, assertionReceipts: [{ assertionIndex: 0, assertionDigest: "4".repeat(64), status: "passed", reason: "assertions-passed" }], artifacts: [], coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], observedMockedComponentIds: ["api"], unexercisedBehaviors: [] } }],
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
    const expected = reidentify({ ...baseBinding().expectedCases[0], criterionId: "criterion-1" } as typeof expectedCase);
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

  it("leaves a bundle's agent steps with no model route to the execution plan (agent-route-not-approved)", () => {
    const scenario = { scenarioId: "agent", requirementId: "r", requestedTargetIds: ["web-main"], required: true, accountProfileId: "synthetic-tenant", minimumEvidence: "source", requiredRealComponentIds: [], steps: [{ kind: "agent", goal: "do work", maxActions: 1 }], assertions: [{ kind: "visible", testId: "done", equals: true }] };
    const bundle = { schemaVersion: 1, planDigest: "a".repeat(64), bundleDigest: "a5a5fb82d39eafe8bc7f4649b7f52ef1c1c7c07d8353cad27593506d4a24fb02", templateVersion: "trusted-v1", scenarios: [scenario] };
    expect(E2EScenarioBundleSchema.safeParse(bundle).success).toBe(true);
    // Whether a route is approved is the execution plan's to judge (the scenario is unavailable with agent-route-not-approved), so the bundle itself is valid.
    expect(() => validateE2EScenarioBundleForPolicy(bundle, policy())).not.toThrow();
  });

  it("retains requested and effective target identities in criteria and group cases", () => {
    const caseItem = reidentify({ ...baseBinding().expectedCases[0], scenarioId: "s1", targetId: "web-main", requestedTargetId: "requested-web" } as typeof expectedCase);
    const testPlan = planWithDigest({ schemaVersion: 1, digest: "a".repeat(64), candidateDigest: "b".repeat(64), planDigest: "c".repeat(64), criteria: [{ criterionId: "criterion-1", requirementId: "r1", scenarioId: "s1", requestedTargetId: "requested-web", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: [caseItem.caseId] }], effectiveTargets: [{ targetId: "web-main", applicationId: "app-main", runtimeProfileId: "browser-linux", accountProfileId: "synthetic-tenant", kind: "contract", requestedTargetId: "requested-web", adapterProfileId: "adapter-v1" }], groups: [{ groupId: "g1", targetIds: ["web-main"], runtimeProfileId: "sandbox-v1", mode: "mock-only", mockManifestDigest: "d".repeat(64), expectedCases: [caseItem] }], mocks: [], unavailableCriteria: [] });
    expect(E2EExecutionPlanSchema.safeParse(testPlan).success).toBe(true);
  });

  it("refuses project-e2e command collisions and reserves the check identity", () => {
    const validProject = { name: "payments", revision: 1, repositories: [{ name: "payments-api", url: "https://github.com/example/payments-api.git", path: "repo/payments-api", defaultBranch: "main", credentialRef: "github-agentx-sdlc" }], setup: [], readiness: [], orchestratorInstructions: "Delegate all code changes to the remote worker." };
    expect(ProjectDefinitionSchema.safeParse({ ...validProject, e2e: policy() }).success).toBe(true);
    expect(WorkflowCheckSchema.safeParse({ id: "project-e2e", label: "fake", command: { cwd: "repo/payments-api", executable: "true", args: [], timeoutSeconds: 1 } }).success).toBe(false);
  });

  it("binds deterministic group and run limits to the round deadline", () => {
    const binding = baseBinding();
    expect(e2eBindingDigest(binding as never)).toBe("86626b1c17ff1f7b1f7b9b6eef409bf2da053054fe9c6703254f3a2b37fd8a18");
    expect(E2EQualifiedResultSchema.safeParse(successfulResult()).success).toBe(true);
    expect(E2EQualifiedResultSchema.safeParse(successfulResult({ cases: [{ ...successfulResult().cases[0], assertionReceipts: [] }] })).success).toBe(false);
    expect(E2EQualifiedResultSchema.safeParse(successfulResult({ cases: [{ ...successfulResult().cases[0], assertionReceipts: [successfulResult().cases[0]!.assertionReceipts[0], successfulResult().cases[0]!.assertionReceipts[0]] }] })).success).toBe(false);
    expect(E2EQualifiedResultSchema.safeParse(successfulResult({ modelReceiptIds: ["receipt-1"] })).success).toBe(false);
    const unknownProtocol = { ...successfulResult(), binding: { ...binding, protocol: "trusted-e2e/v9" } };
    expect(E2EQualifiedResultSchema.safeParse(unknownProtocol).success).toBe(false);
  });

  it("keeps a required criterion UNKNOWN when its group has no result", () => {
    const expected = reidentify({ ...baseBinding().expectedCases[0], criterionId: "criterion-1" } as typeof expectedCase);
    const plan = planWithDigest({ schemaVersion: 1, digest: "a".repeat(64), candidateDigest: "b".repeat(64), planDigest: "c".repeat(64), criteria: [{ criterionId: "criterion-1", requirementId: "req-1", scenarioId: "home", requestedTargetId: "web-main", required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [], expectedCaseIds: [expected.caseId] }], effectiveTargets: [target], groups: [{ groupId: "group-1", targetIds: ["web-main"], runtimeProfileId: "browser-linux", mode: "mock-only", mockManifestDigest: "b".repeat(64), expectedCases: [expected] }], mocks: [], unavailableCriteria: [] });
    expect(aggregateE2EVerification(plan as never, []).results[0]?.status).toBe("UNKNOWN");
    const emptyRequired = planWithDigest({ ...plan, criteria: [{ ...plan.criteria[0], expectedCaseIds: [] }], groups: [], unavailableCriteria: [{ criterionId: "criterion-1", reason: "runtime profile unavailable" }] });
    expect(E2EExecutionPlanSchema.safeParse(emptyRequired).success).toBe(true);
    expect(aggregateE2EVerification(emptyRequired as never, []).results[0]?.status).toBe("UNKNOWN");
    expect(E2EExecutionPlanSchema.safeParse(planWithDigest({ ...emptyRequired, unavailableCriteria: [] })).success).toBe(false);
  });
});

const reidentifyCase = <T extends Record<string, unknown>>(item: T): T => ({ ...item, caseId: e2eCaseIdFromIdentity(item as never), upstreamTestId: e2eUpstreamTestIdFromIdentity(item as never) });

function e2eRoundReviewFixture() {
  const d = (char: string) => char.repeat(64);
  const targets = ["web-1", "web-2"].map((targetId, index) => ({ targetId, applicationId: `app-${index}`, runtimeProfileId: "browser-v1", accountProfileId: "account-v1", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 800 } }));
  const cases = targets.map((target, index) => reidentifyCase({ caseId: "", criterionId: `criterion-${index}`, scenarioId: `scenario-${index}`, targetId: target.targetId, requestedTargetId: target.targetId, agentId: "template-v1", repeat: 0 as const, executionDescriptorDigest: d("1"), accountContextId: `context-${index}`, accountContextDigest: d("2"), accountProfileId: target.accountProfileId, assertionDigest: createHash("sha256").update(canonicalJson([d("4")])).digest("hex"), assertionDigests: [d("4")], required: true, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [] as string[] }));
  const planContent = { schemaVersion: 1 as const, candidateDigest: d("c"), planDigest: d("d"), criteria: cases.map((item, index) => ({ criterionId: item.criterionId, requirementId: `req-${index}`, scenarioId: item.scenarioId, requestedTargetId: item.requestedTargetId, required: true, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [], expectedCaseIds: [item.caseId] })), effectiveTargets: targets, groups: cases.map((item, index) => ({ groupId: `group-${index}`, targetIds: [item.targetId], runtimeProfileId: "browser-v1", mode: "mock-only" as const, mockManifestDigest: d(index === 0 ? "5" : "6"), expectedCases: [item] })), mocks: [], unavailableCriteria: [] };
  const planDigest = createHash("sha256").update(canonicalJson(planContent)).digest("hex");
  const plan = { ...planContent, digest: planDigest };
  const admittedAt = "2026-10-12T12:00:00.000Z";
  const deadlineAt = "2026-10-12T12:05:00.000Z";
  const common = { schemaVersion: 1 as const, roundId: "a0000000-0000-4000-8000-000000000010", taskId: "task-current", operationId: "operation-current", operationFence: 3, workflowRevision: 7, executionPlanDigest: planDigest, authorizationRevision: "auth-current", candidateDigest: plan.candidateDigest, planDigest: plan.planDigest, policyDigest: d("7"), bundleDigest: d("8"), modelRouteRevision: null, admittedAt, deadlineAt };
  const bindings = cases.map((expectedCase, index) => ({ ...common, runId: `a0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, groupId: `group-${index}`, executionMode: "mock-only" as const, appBuildDigest: d(index === 0 ? "1" : "9"), environmentDigest: d(index === 0 ? "2" : "a"), runtimeManifestDigest: d(index === 0 ? "3" : "b"), mockManifestDigest: d(index === 0 ? "5" : "6"), expectedCases: [expectedCase] }));
  const results = bindings.map((binding) => ({ schemaVersion: 1 as const, binding, producer: "trusted-verifier", startedAt: "2026-10-12T12:00:01.000Z", finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed" as const, qualification: "trusted" as const, executionMode: "mock-only" as const, reason: "complete", cases: binding.expectedCases.map((item) => ({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, status: "passed" as const, reason: "assertions-passed", attemptCount: 1, assertionDigest: item.assertionDigest, assertionReceipts: item.assertionDigests.map((assertionDigest, assertionIndex) => ({ assertionIndex, assertionDigest, status: "passed" as const, reason: "assertions-passed" })), artifacts: [], coverage: { observedScope: "mock-contract" as const, subject: "candidate" as const, executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], observedMockedComponentIds: ["api"], unexercisedBehaviors: [] } })), rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed" as const }));
  const round = { schemaVersion: 1 as const, roundId: common.roundId, taskId: common.taskId, operationId: common.operationId, operationFence: common.operationFence, workflowRevision: common.workflowRevision, executionPlanDigest: planDigest, admittedAt, deadlineAt, limits: { runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 180_000, caseTimeoutMs: 90_000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxSpendUsd: null }, groupBindings: bindings };
  return { plan, round, results };
}

describe("E2E contracts: limits and URL and JSON validation", () => {
  it("bounds callback receipt on both sides while retaining the full run deadline", () => {
    const f = e2eRoundReviewFixture();
    const oneDayEarly = { ...f.results[0]!, receivedAt: "2026-10-11T12:00:02.000Z" };
    const lowerBoundary = { ...f.results[0]!, receivedAt: "2026-10-12T11:59:57.000Z" };
    const upperBoundary = { ...f.results[0]!, receivedAt: "2026-10-12T12:05:07.000Z" };
    const tooLate = { ...f.results[0]!, receivedAt: "2026-10-12T12:05:07.001Z" };
    expect(projectE2EVerification(oneDayEarly as never).results[0]?.status).toBe("UNKNOWN");
    expect(projectE2EVerification(lowerBoundary as never).results[0]?.status).toBe("PASS");
    expect(projectE2EVerification(upperBoundary as never).results[0]?.status).toBe("PASS");
    expect(projectE2EVerification(tooLate as never).results[0]?.status).toBe("UNKNOWN");
    expect(aggregateE2EVerification(f.plan as never, [oneDayEarly, f.results[1]] as never, f.round as never).results[0]?.status).toBe("UNKNOWN");
    expect(aggregateE2EVerification(f.plan as never, [lowerBoundary, f.results[1]] as never, f.round as never).results[0]?.status).toBe("PASS");
  });

  it("rejects every non-index array own property without invoking accessors", () => {
    const step = (input: unknown) => ({ kind: "invoke-contract", operationId: "op", input });
    for (const key of ["4294967295", "01", "-0", "extra"]) {
      const value: unknown[] = [];
      Object.defineProperty(value, key, { enumerable: true, configurable: true, value: "not-json-array-data" });
      expect(E2EStepSchema.safeParse(step(value)).success).toBe(false);
    }
    const sparse = new Array(1);
    expect(E2EStepSchema.safeParse(step(sparse)).success).toBe(false);
    let accessorRan = false;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "4294967295", { enumerable: true, get() { accessorRan = true; return "x"; } });
    expect(E2EStepSchema.safeParse(step(accessor)).success).toBe(false);
    expect(accessorRan).toBe(false);
    expect(E2EStepSchema.safeParse(step(["valid", 4, null])).success).toBe(true);
  });

  it("rejects URL parser whitespace and embedded control normalization at every app-path surface", () => {
    const scenario = (path: string) => ({ scenarioId: "s", requirementId: "r", requestedTargetIds: ["web-1"], required: true, accountProfileId: "account-v1", minimumEvidence: "source", requiredRealComponentIds: [], steps: [{ kind: "navigate", path }], assertions: [{ kind: "visible", testId: "done", equals: true }] });
    const paths = [" https://foreign.example/", "\thttps://foreign.example/", "java\nscript:alert(1)"];
    for (const path of paths) {
      expect(E2EStepSchema.safeParse({ kind: "navigate", path }).success).toBe(false);
      expect(E2EStepSchema.safeParse({ kind: "request", requestId: "r", path, method: "GET", body: null }).success).toBe(false);
      expect(E2EStepSchema.safeParse({ kind: "deep-link", path }).success).toBe(false);
      expect(E2EScenarioSchema.safeParse(scenario(path)).success).toBe(false);
      expect(E2EAssertionSchema.safeParse({ kind: "http-status", path, method: "GET", equals: 200 }).success).toBe(false);
      const recipe = { schemaVersion: 1, recipeDigest: "a".repeat(64), build: [], launch: { kind: "service", start: { program: "node", args: [], cwd: "repo", timeoutMs: 1000, env: {} }, health: { path, expectedStatus: 200 } }, serviceProfileIds: [], seedProfileId: "seed", accountProfileIds: ["account"], allowedOrigins: [] };
      expect(E2EAppRecipeSchema.safeParse(recipe).success).toBe(false);
    }
    expect(E2EStepSchema.safeParse({ kind: "navigate", path: "/users/profile" }).success).toBe(true);
  });

  it("applies depth and byte limits to JSON literals, not their enclosing record, and never throws", () => {
    const step = (input: unknown) => ({ kind: "invoke-contract", operationId: "op", input });
    expect(E2EStepSchema.safeParse(step("x".repeat(65_534))).success).toBe(true);
    expect(E2EStepSchema.safeParse(step("x".repeat(65_535))).success).toBe(false);
    let depth32: unknown = null;
    for (let index = 0; index < 32; index += 1) depth32 = { v: depth32 };
    const depth33: unknown = { v: depth32 };
    expect(E2EStepSchema.safeParse(step(depth32)).success).toBe(true);
    expect(E2EStepSchema.safeParse(step(depth33)).success).toBe(false);

    const f = e2eRoundReviewFixture();
    const large = structuredClone(f.plan) as { digest: string; groups: Array<{ expectedCases: Array<Record<string, unknown>>; [key: string]: unknown }>; criteria: Array<Record<string, unknown>>; [key: string]: unknown };
    const components = Array.from({ length: 32 }, (_, index) => `${index}-` + "x".repeat(115));
    const templateCase = large.groups[0]!.expectedCases[0]!;
    large.groups = [{ ...large.groups[0]!, expectedCases: Array.from({ length: 16 }, (_, index) => reidentifyCase({ ...templateCase, caseId: "", criterionId: `large-criterion-${index}`, scenarioId: `large-scenario-${index}`, requiredRealComponentIds: components })) }];
    large.criteria = large.groups[0]!.expectedCases.map((item) => ({ criterionId: item.criterionId, requirementId: "req", scenarioId: item.scenarioId, requestedTargetId: item.requestedTargetId, required: item.required, minimumEvidence: item.minimumEvidence, requiredRealComponentIds: components, expectedCaseIds: [item.caseId] }));
    const content: Record<string, unknown> = { ...large };
    delete content.digest;
    large.digest = createHash("sha256").update(canonicalJson(content)).digest("hex");
    expect(Buffer.byteLength(canonicalJson(large))).toBeGreaterThan(65_536);
    expect(Buffer.byteLength(canonicalJson(large))).toBeLessThan(262_144);
    expect(() => E2EExecutionPlanSchema.safeParse(large)).not.toThrow();
    expect(E2EExecutionPlanSchema.safeParse(large).success).toBe(true);
  });
});

const target1 = { targetId: "web-1", applicationId: "app-1", runtimeProfileId: "browser-v1", accountProfileId: "account-v1", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 800 } };

const target2 = { ...target1, targetId: "web-2", applicationId: "app-2" };

const admittedAt = "2026-10-12T12:00:00.000Z";

const deadlineAt = "2026-10-12T12:05:00.000Z";

const expected = (_caseId: string, criterionId: string, targetId: string) => {
  const identity = { scenarioId: `scenario-${criterionId}`, targetId, requestedTargetId: targetId, accountProfileId: "account-v1", accountContextId: `context-${criterionId}`, accountContextDigest: createHash("sha256").update(`context-${criterionId}`).digest("hex"), executionDescriptorDigest: createHash("sha256").update(`descriptor-${criterionId}`).digest("hex"), minimumEvidence: "mock-contract", requiredRealComponentIds: [] as string[], agentId: "template-v1", repeat: 0, assertionDigests: ["4".repeat(64)] };
  return { caseId: e2eCaseIdFromIdentity(identity), criterionId, ...identity, upstreamTestId: e2eUpstreamTestIdFromIdentity(identity), assertionDigest: createHash("sha256").update(canonicalJson(identity.assertionDigests)).digest("hex"), required: true };
};

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
  const result = (binding: typeof binding1) => ({ schemaVersion: 1, binding, producer: "trusted-verifier", startedAt: "2026-10-12T12:00:01.000Z", finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed", qualification: "trusted", executionMode: "mock-only", reason: "complete", cases: binding.expectedCases.map((item) => ({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, status: "passed", reason: "assertions-passed", attemptCount: 1, assertionDigest: item.assertionDigest, assertionReceipts: item.assertionDigests.map((assertionDigest, assertionIndex) => ({ assertionIndex, assertionDigest, status: "passed", reason: "assertions-passed" })), artifacts: [], coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], observedMockedComponentIds: ["api"], unexercisedBehaviors: [] } })), rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed" });
  const round = { schemaVersion: 1, roundId: common.roundId, taskId: common.taskId, operationId: common.operationId, operationFence: common.operationFence, workflowRevision: common.workflowRevision, executionPlanDigest: common.executionPlanDigest, admittedAt, deadlineAt, limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null }, groupBindings: [binding1, binding2] };
  return { plan, round, bindings: [binding1, binding2], results: [result(binding1), result(binding2)] };
}

describe("E2E contracts: rounds, membership and inputs", () => {
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
    const optionalCase = reidentifyCase({ ...f.bindings[0]!.expectedCases[0]!, scenarioId: "optional-scenario", required: false });
    const optional = { ...f.results[0], binding: { ...f.bindings[0]!, expectedCases: [...f.bindings[0]!.expectedCases, optionalCase] }, cases: [...f.results[0]!.cases, { ...f.results[0]!.cases[0]!, caseId: optionalCase.caseId, executionDescriptorDigest: optionalCase.executionDescriptorDigest, accountContextId: optionalCase.accountContextId, accountContextDigest: optionalCase.accountContextDigest, status: "failed" }] };
    expect(projectE2EVerification(optional as never).results[0]?.status).toBe("PASS");
  });

  it("bounds rounds by total cases, unique run/case IDs, and shared admission timeout", () => {
    const f = fixture();
    const makeLarge = (count: number) => f.bindings.slice(0, 2).map((binding, index) => ({ ...binding, groupId: `large-${index}`, runId: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, expectedCases: Array.from({ length: count }, (_, n) => reidentifyCase({ ...binding.expectedCases[0]!, scenarioId: `large-scenario-${index}-${n}`, criterionId: `criterion-${index}-${n}`, required: false })) }));
    const baseRound = { ...f.round, groupBindings: makeLarge(32) };
    expect(E2ERoundSchema.safeParse(baseRound).success).toBe(true);
    expect(E2ERoundSchema.safeParse({ ...baseRound, groupBindings: makeLarge(33) }).success).toBe(false);
    expect(E2ERoundSchema.safeParse({ ...f.round, deadlineAt: "2026-10-12T23:00:00.000Z" }).success).toBe(false);
    expect(E2ERoundSchema.safeParse({ ...f.round, groupBindings: [f.bindings[0]!, { ...f.bindings[1]!, runId: f.bindings[0]!.runId }] }).success).toBe(false);
  });
});
