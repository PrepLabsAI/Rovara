import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, canonicalJson, portableOperationId, buildE2ESharedView, e2ePlanHasCompleteRequiredCriteria, type E2EFeaturePlanIntent, type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { buildE2EFeatureRound, deriveE2EFeatureExecutionAdmission, deriveE2EFeaturePortableApprovalBinding } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import { e2eFeatureVerifierKey } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const manifest = Buffer.from(JSON.stringify({ name: "ordinary-orders", type: "module", exports: { ".": "./src/index.mjs" } }));
const moduleBytes = Buffer.from("export async function renderOrders(input) { const response = await fetch(`/orders?mode=${encodeURIComponent(input.mode)}`); if (!response.ok) return `refused:${response.status}`; const body = await response.json(); if (!Array.isArray(body.orders)) return 'invalid-data'; return body.orders.map((row) => row.name).join(','); }\n");
const apiBytes = Buffer.from(JSON.stringify({
  openapi: "3.1.0", info: { title: "Orders", version: "1" },
  paths: { "/orders": { get: {
    operationId: "listOrders",
    parameters: [{ name: "mode", in: "query", required: true, schema: { type: "string", enum: ["success", "refusal", "invalid-data"] } }],
    responses: {
      "200": { description: "orders", content: { "application/json": { schema: {
        type: "object", properties: { orders: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } } },
        required: ["orders"], additionalProperties: false,
      } } } },
      "403": { description: "refused", content: { "application/json": { schema: {
        type: "object", properties: { error: { type: "string" } }, required: ["error"], additionalProperties: false,
      } } } },
    },
  } } },
}));
const fixtureBytes = Buffer.from(JSON.stringify({ schemaVersion: "source-backed-api-fixtures/v1", operationId: "listOrders", method: "GET", path: "/orders", inputField: "mode", variants: [
  { id: "success", inputValue: "success", status: 200, body: { orders: [{ name: "Sample order" }] } },
  { id: "refusal", inputValue: "refusal", status: 403, body: { error: "refused" } },
  { id: "invalid-data", inputValue: "invalid-data", status: 200, body: { orders: "bad" } },
] }));
const candidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
const snapshot: E2ESourceSnapshot = {
  candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha, treeComplete: true,
  treePaths: ["package.json", "src/index.mjs", "openapi.json", "fixtures/orders-mocks.json"],
  sources: [
    { path: "package.json", sha256: sha(manifest), bytes: manifest, kind: "blob" },
    { path: "src/index.mjs", sha256: sha(moduleBytes), bytes: moduleBytes, kind: "blob" },
    { path: "openapi.json", sha256: sha(apiBytes), bytes: apiBytes, kind: "blob" },
    { path: "fixtures/orders-mocks.json", sha256: sha(fixtureBytes), bytes: fixtureBytes, kind: "blob" },
  ],
};
const intent: E2EFeaturePlanIntent = {
  schemaVersion: 1, requestedTargetIds: ["web-1"],
  mockFixtureRefs: [{ componentId: `api-schema-${sha(Buffer.from("openapi.json")).slice(0, 12)}`, requestedTargetId: "web-1", operationId: "listOrders",
    sourcePath: "fixtures/orders-mocks.json", sourceSha256: sha(fixtureBytes) }],
  portableOperationRefs: [{ operationId: portableOperationId(".", "ordinary-orders"), applicationId: "ordinary-orders", requestedTargetIds: ["web-1"], packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named", exportName: "renderOrders" } }],
  accountContextRefs: [{ applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json", sourceSha256: sha(manifest) }],
  scenarios: ["success", "refusal", "invalid-data"].map((mode) => ({ scenarioId: `render-orders-${mode}`, requirementId: "render-orders-requirement", requestedTargetIds: ["web-1"], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [], steps: [{ kind: "invoke-contract" as const, operationId: portableOperationId(".", "ordinary-orders"), input: { mode } }], assertions: [{ kind: "state" as const, probeId: "result", equals: mode === "success" ? "Sample order" : mode === "refusal" ? "refused:403" : "invalid-data", pollTimeoutMs: 1000 }] })),
  semanticExportDeltas: [],
};
const target = { targetId: "web-1", applicationId: "ordinary-orders", runtimeProfileId: "web-phase-unavailable", accountProfileId: "synthetic", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 720 } };
const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["render-orders-success", "render-orders-refusal", "render-orders-invalid-data"], targets: [target], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
const runnerToolchain = { execPath: process.execPath, version: "v22.23.2" as const, platform: process.platform, arch: process.arch };
const featureKey = e2eFeatureVerifierKey("local-catalog", "default-sandbox");
const featureRecord = { pk: featureKey.pk, sk: featureKey.sk, schemaVersion: 1 as const, entityType: "E2E_FEATURE_VERIFIER" as const, runtimeCatalogId: "local-catalog", catalogRevision: 4,
  profileId: "default-sandbox", bindingDigest: sha(Buffer.from(canonicalJson(binding))), binding, manifestDigest: "d".repeat(64),
  runnerEnvironment, runnerEnvironmentDigest: sha(Buffer.from(canonicalJson(runnerEnvironment))), runnerToolchain, runnerToolchainDigest: sha(Buffer.from(canonicalJson(runnerToolchain))),
  endpoint: "http://127.0.0.1:8080", generation: 2, transportCorrelationId: "11111111-1111-4111-8111-111111111111",
  supportedFeatureScopes: ["portable-process-response/v1" as const], state: "READY" as const,
  qualifiedAt: "2026-10-13T12:00:00.000Z", expiresAt: "2026-10-13T13:00:00.000Z" };

describe("source-bound portable feature plan binding", () => {
  it("binds an Owner-approved callable reference to the exact candidate package export and module bytes", () => {
    const binding = deriveE2EFeaturePortableApprovalBinding({ intent, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) });
    expect(binding.semanticApproval).toEqual({ artifactId: "plan-artifact", digest: "b".repeat(64) });
    expect(binding.operations).toHaveLength(1);
    expect(binding.operations[0]).toMatchObject({
      purpose: "feature-invocation", operationId: portableOperationId(".", "ordinary-orders"), applicationId: "ordinary-orders",
      packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named", exportName: "renderOrders" },
      expectedExportNames: null, sourceRefs: [{ path: "src/index.mjs", sha256: sha(moduleBytes) }],
    });
    expect(binding.scenarioRegistrations).toHaveLength(3);
  });

  it("rejects a proposed module or callable that differs from the source-derived package export", () => {
    expect(() => deriveE2EFeaturePortableApprovalBinding({ intent: { ...intent, portableOperationRefs: intent.portableOperationRefs?.map((item) => ({ ...item, moduleSpecifier: "./src/other.mjs" })) }, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) })).toThrow();
    expect(() => deriveE2EFeaturePortableApprovalBinding({ intent: { ...intent, portableOperationRefs: intent.portableOperationRefs?.map((item) => ({ ...item, callableSelector: { kind: "named", exportName: "missing" } })) }, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) })).toThrow();
  });

  it("builds candidate-bound portable groups only under the separately admitted feature verifier", () => {
    const admission = deriveE2EFeatureExecutionAdmission({ intent, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64),
      planDigest: "c".repeat(64), policy, runtimeCatalogId: "local-catalog", runtimeBinding: binding,
      featureVerifier: featureRecord, now: Date.parse("2026-10-13T12:30:00.000Z") });
    expect(admission.plan.candidateDigest).toBe(candidate.digest);
    expect(admission.plan.groups.flatMap((group) => group.expectedCases).map((item) => item.scenarioId))
      .toEqual(["render-orders-success", "render-orders-refusal", "render-orders-invalid-data"]);
    expect(admission.plan.mocks, JSON.stringify({ unavailable: admission.plan.unavailableCriteria, mockable: admission.selectionInput.mockableComponents })).toHaveLength(1);
    expect(admission.plan.mocks[0]).toMatchObject({ componentId: `api-schema-${sha(Buffer.from("openapi.json")).slice(0, 12)}`, requestedTargetId: "web-1" });
    expect(admission.selectionInput.mockableComponents).toHaveLength(1);
    expect(admission.portableApprovalBinding.mockFixtures).toEqual(admission.selectionInput.mockableComponents);
    expect(admission.runtime.profileId).toBe(policy.defaultSandboxProfileId);
    const admitted = buildE2EFeatureRound({ admission, taskId: "task-1", operationId: "operation-1", operationFence: 3,
      workflowRevision: 8, roundId: "22222222-2222-4222-8222-222222222222", runIds: ["33333333-3333-4333-8333-333333333333"],
      admittedAt: "2026-10-13T12:30:00.000Z", deadlineAt: "2026-10-13T12:31:00.000Z" });
    expect(admitted.round.groupBindings).toHaveLength(admission.plan.groups.length);
    expect(admitted.groupAdmissions.map((group) => (group.binding as { groupId: string }).groupId))
      .toEqual(admission.plan.groups.map((group) => group.groupId));
    expect(() => buildE2EFeatureRound({ admission, taskId: "task-1", operationId: "operation-1", operationFence: 3,
      workflowRevision: 8, roundId: "22222222-2222-4222-8222-222222222222", runIds: [],
      admittedAt: "2026-10-13T12:30:00.000Z", deadlineAt: "2026-10-13T12:31:00.000Z" })).toThrow(/every bounded execution group/u);
    expect(() => deriveE2EFeatureExecutionAdmission({ intent, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64),
      planDigest: "c".repeat(64), policy, runtimeCatalogId: "local-catalog", runtimeBinding: binding,
      featureVerifier: { ...featureRecord, supportedFeatureScopes: ["source-interface"] }, now: Date.parse("2026-10-13T12:30:00.000Z") })).toThrow();
  });

  it("keeps a required browser criterion visible and blocking beside executable portable cases", () => {
    const browserScenario = { scenarioId: "orders-browser-navigation", requirementId: "orders-navigation", requestedTargetIds: ["web-1"], required: true,
      accountProfileId: "synthetic", minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
      steps: [{ kind: "navigate" as const, path: "/orders" }], assertions: [{ kind: "visible" as const, testId: "orders-list", equals: true }] };
    const browserIntent = { ...intent, scenarios: [...intent.scenarios, browserScenario] };
    const admission = deriveE2EFeatureExecutionAdmission({ intent: browserIntent, snapshot, artifactId: "browser-plan-artifact", artifactSha256: "e".repeat(64),
      planDigest: "f".repeat(64), policy, runtimeCatalogId: "local-catalog", runtimeBinding: binding,
      featureVerifier: featureRecord, now: Date.parse("2026-10-13T12:30:00.000Z") });
    const browserCriterion = admission.plan.criteria.find((criterion) => criterion.scenarioId === browserScenario.scenarioId);
    expect(browserCriterion?.required).toBe(true);
    expect(browserCriterion?.expectedCaseIds).toEqual([]);
    expect(admission.plan.unavailableCriteria).toContainEqual(expect.objectContaining({ criterionId: browserCriterion?.criterionId }));
    expect(admission.plan.groups.flatMap((group) => group.expectedCases)).toHaveLength(3);
    expect(e2ePlanHasCompleteRequiredCriteria(admission.plan)).toBe(false);
    const view = buildE2ESharedView({ plan: admission.plan, currentRound: null, results: [], actor: "owner",
      setup: { status: "runtime-ready", selectedTargetIds: admission.plan.effectiveTargets.map((target) => target.targetId),
        executionPlanDigest: admission.plan.digest, blockingInputIds: [], mockSubstitutableInputIds: [] },
      control: { policyPresent: true, workflowPhase: "e2e", ownerActionProposals: ["retry-run"] } });
    expect(view.e2e.status).toBe("UNKNOWN");
    expect(view.e2e.requiredCriteria).toBe(admission.plan.criteria.filter((criterion) => criterion.required).length);
    expect(view.e2e.requiredUnexercisedCriteriaIds).toContain(browserCriterion?.criterionId);
    expect(view.actions).toEqual(["retry-run"]);
  });
});
