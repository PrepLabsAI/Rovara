import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { e2eExecutionPlanDigest, type E2EPolicy, type E2EScenario } from "@agentx/contracts";
import { portableE2EUpstreamTestId, PORTABLE_E2E_TEST_PATH, selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const moduleBytes = Buffer.from("export const exportOrders = () => []");
const manifestBytes = Buffer.from(JSON.stringify({ name: "app", exports: { ".": "./src/export.ts" } }));
const web = { targetId: "web", applicationId: "app", runtimeProfileId: "web-phase-unavailable", accountProfileId: "synthetic", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 720 } };
const api = { targetId: "api", applicationId: "app", runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api" as const, protocol: "http" as const, originRef: "api-origin" };
const sandbox = { targetId: "default-sandbox" as const, profileId: "default-sandbox", connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "auth-1" };
const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["baseline"], targets: [web, api], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
const scenario: E2EScenario = { scenarioId: "baseline", requirementId: "orders-auth", requestedTargetIds: ["web", "api"], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: ["orders-service"], steps: [{ kind: "request", requestId: "export", path: "/export", method: "GET", body: null }], assertions: [{ kind: "http-status", path: "/export", method: "GET", equals: 200 }] };
const input = { candidateDigest: "a".repeat(64), planDigest: "b".repeat(64), policy, scenarios: [scenario], selectedTargetIds: ["web"], sandboxAvailability: sandbox, runtimeAvailability: [], verifiedSources: [{ path: "package.json", sha256: hash(manifestBytes.toString()), bytes: manifestBytes }, { path: "src/export.ts", sha256: hash(moduleBytes.toString()), bytes: moduleBytes }], portableOperations: [{ applicationId: "app", targetIds: ["web", "api"], manifestPath: "package.json", exportName: ".", operationId: "module-", sourceRefs: [{ path: "src/export.ts", sha256: hash(moduleBytes.toString()) }] }], mockableComponents: [{ componentId: "orders-service", requestedTargetId: "api", kind: "api" as const, sourceRefs: [{ path: "src/export.ts", sha256: hash(moduleBytes.toString()) }] }] };

describe("safe E2E execution plan selection", () => {
  it("preserves inherited required criteria and target identities when a caller selects a subset", () => {
    const plan = selectE2EExecutionPlan(input);
    expect(plan.criteria.map((criterion) => criterion.requestedTargetId)).toEqual(["web", "api"]);
    expect(plan.groups.flatMap((group) => group.expectedCases.map((item) => [item.requestedTargetId, item.targetId]))).toEqual([[ "api", expect.stringMatching(/^contract-/) ], [ "web", expect.stringMatching(/^contract-/) ]]);
    expect(plan.criteria.every((criterion) => criterion.required && criterion.expectedCaseIds.length === 1)).toBe(true);
    expect(plan.groups.flatMap((group) => group.expectedCases).every((item) => item.agentId === "default" && item.upstreamTestId.startsWith(`${PORTABLE_E2E_TEST_PATH}::case-`))).toBe(true);
    expect(portableE2EUpstreamTestId(["feature", "web", "contract-web", "a".repeat(64)])).toBe(portableE2EUpstreamTestId(["feature", "web", "contract-web", "a".repeat(64)]));
    expect(e2eExecutionPlanDigest({ ...plan, digest: "0".repeat(64) })).toBe(plan.digest);
  });

  it("keeps an unavailable native floor visible when the sandbox is absent or caller supplies an unsafe mock", () => {
    const noSandbox = selectE2EExecutionPlan({ ...input, sandboxAvailability: null });
    expect(noSandbox.groups).toHaveLength(0);
    expect(noSandbox.unavailableCriteria).toHaveLength(2);
    const arbitrary = selectE2EExecutionPlan({ ...input, mockableComponents: [{ ...input.mockableComponents[0]!, sourceRefs: [{ path: "missing.ts", sha256: "c".repeat(64) }] }] });
    expect(arbitrary.groups).toHaveLength(1);
    expect(arbitrary.unavailableCriteria).toHaveLength(1);
  });

  it("rejects empty scenario assignments and does not trust claimed native availability before phase support", () => {
    expect(() => selectE2EExecutionPlan({ ...input, scenarios: [] })).toThrow();
    const plan = selectE2EExecutionPlan({ ...input, runtimeAvailability: [{ targetId: "web", profileId: "chromium", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth-1" }] });
    expect(plan.groups.some((group) => group.mode === "real-runtime")).toBe(false);
  });

  it("keeps every required floor and deterministic case mapping through the full 64-tuple limit", () => {
    const scenarios = Array.from({ length: 32 }, (_, index) => ({
      ...scenario, scenarioId: `baseline-${index}`, requirementId: `requirement-${index}`,
      requestedTargetIds: ["web", "api"], required: true, minimumEvidence: "mock-contract" as const,
      requiredRealComponentIds: ["orders-service"],
    }));
    const plan = selectE2EExecutionPlan({ ...input, policy: { ...policy, baselineScenarioIds: [] }, scenarios });
    expect(plan.criteria).toHaveLength(64);
    expect(plan.criteria.every((criterion) => criterion.required && criterion.minimumEvidence === "mock-contract" && criterion.requiredRealComponentIds.includes("orders-service"))).toBe(true);
    expect(plan.groups.flatMap((group) => group.expectedCases)).toHaveLength(64);
    expect(selectE2EExecutionPlan({ ...input, policy: { ...policy, baselineScenarioIds: [] }, scenarios }).digest).toBe(plan.digest);
    const overBudget = scenarios.map((item) => ({ ...item, requestedTargetIds: ["web", "api", "web2"] }));
    expect(() => selectE2EExecutionPlan({ ...input, policy: { ...policy, targets: [web, api, { ...web, targetId: "web2" }] }, scenarios: overBudget })).toThrow(/64/);
  });
});
