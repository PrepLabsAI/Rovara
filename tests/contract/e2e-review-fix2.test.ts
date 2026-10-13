import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  E2EAppRecipeSchema, E2EAssertionSchema, E2EExecutionPlanSchema, E2EScenarioSchema, E2EStepSchema,
  aggregateE2EVerification, projectE2EVerification,
} from "../../packages/contracts/src/e2e.js";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";

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
  const results = bindings.map((binding) => ({ schemaVersion: 1 as const, binding, producer: "trusted-verifier", startedAt: "2026-10-12T12:00:01.000Z", finishedAt: "2026-10-12T12:00:02.000Z", receivedAt: "2026-10-12T12:00:03.000Z", status: "passed" as const, qualification: "trusted" as const, executionMode: "mock-only" as const, reason: "complete", cases: binding.expectedCases.map((item) => ({ caseId: item.caseId, executionDescriptorDigest: item.executionDescriptorDigest, accountContextId: item.accountContextId, accountContextDigest: item.accountContextDigest, status: "passed" as const, reason: "assertions-passed", attemptCount: 1, assertionDigest: item.assertionDigest, assertionReceipts: item.assertionDigests.map((assertionDigest, assertionIndex) => ({ assertionIndex, assertionDigest, status: "passed" as const, reason: "assertions-passed" })), artifacts: [], coverage: { observedScope: "mock-contract" as const, subject: "candidate" as const, executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], unexercisedBehaviors: [] } })), rawReportSha256: null, modelReceiptIds: [], cleanup: "confirmed" as const }));
  const round = { schemaVersion: 1 as const, roundId: common.roundId, taskId: common.taskId, operationId: common.operationId, operationFence: common.operationFence, workflowRevision: common.workflowRevision, executionPlanDigest: planDigest, admittedAt, deadlineAt, limits: { runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 180_000, caseTimeoutMs: 90_000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200_000, maxOutputTokens: 20_000, maxSpendUsd: null }, groupBindings: bindings };
  return { plan, round, results };
}

describe("fix-round-2 review regressions", () => {
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
