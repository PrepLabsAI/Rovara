import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, e2eExecutionPlanDigest, type E2EPolicy, type E2EScenario, type E2ESourceSnapshot } from "@agentx/contracts";
import { effectiveContractTargetId, portableE2EUpstreamTestId, PORTABLE_E2E_TEST_PATH, selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const moduleBytes = Buffer.from("export const exportOrders = () => true");
const manifestBytes = Buffer.from(JSON.stringify({ name: "app", scripts: { start: "vite" }, exports: { ".": "./src/export.ts" } }));
const apiModuleBytes = Buffer.from("export const listOrders = () => []");
const apiManifestBytes = Buffer.from(JSON.stringify({ name: "orders-api", scripts: { start: "node server.js" }, dependencies: { express: "1" }, exports: { ".": "./src/export.ts" } }));
const apiSchemaBytes = Buffer.from(JSON.stringify({
  openapi: "3.1.0",
  paths: { "/orders": { get: { responses: { "200": { description: "ok" } } } } },
}));
const candidate = createCandidateManifest([{ repositoryId: "acme/app", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
const sourceItems = [
  { path: "apps/web/package.json", sha256: hash(manifestBytes.toString()), bytes: manifestBytes, kind: "blob" as const },
  { path: "apps/web/src/export.ts", sha256: hash(moduleBytes.toString()), bytes: moduleBytes, kind: "blob" as const },
  { path: "apps/api/package.json", sha256: hash(apiManifestBytes.toString()), bytes: apiManifestBytes, kind: "blob" as const },
  { path: "apps/api/src/export.ts", sha256: hash(apiModuleBytes.toString()), bytes: apiModuleBytes, kind: "blob" as const },
  { path: "apps/api/openapi.json", sha256: hash(apiSchemaBytes.toString()), bytes: apiSchemaBytes, kind: "blob" as const },
];
const sourceSnapshot: E2ESourceSnapshot = { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sourceItems.map((item) => item.path), sources: sourceItems };
const inspected = inspectE2ERepository(sourceSnapshot, candidate);
const web = inspected.inspection.proposedTargets.find((target) => target.kind === "web")!;
const api = inspected.inspection.proposedTargets.find((target) => target.kind === "api")!;
const sandbox = { targetId: "default-sandbox" as const, profileId: "default-sandbox", connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "auth-1" };
const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["baseline"], targets: [web, api], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
const scenario: E2EScenario = { scenarioId: "baseline", requirementId: "orders-auth", requestedTargetIds: [web.targetId, api.targetId], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [], steps: [{ kind: "invoke-contract", operationId: inspected.portableOperations.find((operation) => operation.applicationId === web.applicationId)!.operationId, input: null }], assertions: [{ kind: "state", probeId: "result", equals: true, pollTimeoutMs: 1000 }] };
const input = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "b".repeat(64), policy, scenarios: [scenario], selectedTargetIds: [web.targetId], sandboxAvailability: sandbox, runtimeAvailability: [], mockableComponents: [{ componentId: "bank-api", requestedTargetId: web.targetId, kind: "api" as const, sourceRefs: [{ path: "apps/web/src/export.ts", sha256: hash(moduleBytes.toString()) }] }] };

describe("safe E2E execution plan selection", () => {
  it("preserves inherited required criteria and target identities when a caller selects a subset", () => {
    const plan = selectE2EExecutionPlan(input);
    expect(plan.criteria.map((criterion) => criterion.requestedTargetId)).toEqual([web.targetId, api.targetId]);
    expect(plan.groups.flatMap((group) => group.expectedCases.map((item) => [item.requestedTargetId, item.targetId]))).toEqual([[ web.targetId, expect.stringMatching(/^contract-/) ]]);
    expect(plan.criteria.every((criterion) => criterion.required)).toBe(true);
    expect(plan.unavailableCriteria.map((item) => item.criterionId)).toContain(plan.criteria.find((item) => item.requestedTargetId === api.targetId)?.criterionId);
    expect(plan.groups.flatMap((group) => group.expectedCases).every((item) => item.agentId === "default" && item.upstreamTestId.startsWith(`${PORTABLE_E2E_TEST_PATH}::case-`))).toBe(true);
    expect(portableE2EUpstreamTestId(["feature", "web", "contract-web", "a".repeat(64)])).toBe(portableE2EUpstreamTestId(["feature", "web", "contract-web", "a".repeat(64)]));
    expect(e2eExecutionPlanDigest({ ...plan, digest: "0".repeat(64) })).toBe(plan.digest);
  });

  it("keeps an unavailable native floor visible when the sandbox is absent or caller supplies an unsafe mock", () => {
    const noSandbox = selectE2EExecutionPlan({ ...input, sandboxAvailability: null });
    expect(noSandbox.groups).toHaveLength(0);
    expect(noSandbox.unavailableCriteria).toHaveLength(2);
    const arbitrary = selectE2EExecutionPlan({ ...input, scenarios: [{ ...scenario, requiredRealComponentIds: ["bank-api"] }] });
    expect(arbitrary.groups).toHaveLength(0);
    expect(arbitrary.unavailableCriteria).toHaveLength(2);
    expect(arbitrary.criteria.every((criterion) => criterion.requiredRealComponentIds.includes("bank-api"))).toBe(true);
  });

  it("rejects empty scenario assignments and does not trust claimed native availability before phase support", () => {
    expect(() => selectE2EExecutionPlan({ ...input, scenarios: [] })).toThrow();
    const plan = selectE2EExecutionPlan({ ...input, runtimeAvailability: [{ targetId: "web", profileId: "chromium", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth-1" }] });
    expect(plan.groups.some((group) => group.mode === "real-runtime")).toBe(false);
  });

  it("keeps every required floor and deterministic case mapping through the full 64-tuple limit", () => {
    const scenarios = Array.from({ length: 32 }, (_, index) => ({
      ...scenario, scenarioId: `baseline-${index}`, requirementId: `requirement-${index}`,
      requestedTargetIds: [web.targetId, api.targetId], required: true, minimumEvidence: "mock-contract" as const,
      requiredRealComponentIds: [],
    }));
    const plan = selectE2EExecutionPlan({ ...input, policy: { ...policy, baselineScenarioIds: [] }, scenarios });
    expect(plan.criteria).toHaveLength(64);
    expect(plan.criteria.every((criterion) => criterion.required && criterion.minimumEvidence === "mock-contract" && criterion.requiredRealComponentIds.length === 0)).toBe(true);
    expect(plan.groups.flatMap((group) => group.expectedCases)).toHaveLength(32);
    expect(plan.unavailableCriteria).toHaveLength(32);
    expect(selectE2EExecutionPlan({ ...input, policy: { ...policy, baselineScenarioIds: [] }, scenarios }).digest).toBe(plan.digest);
    const longRequestedId = "x".repeat(80);
    expect(effectiveContractTargetId(longRequestedId)).toHaveLength(73);
    expect(effectiveContractTargetId(longRequestedId)).not.toContain(longRequestedId);
  });
});
