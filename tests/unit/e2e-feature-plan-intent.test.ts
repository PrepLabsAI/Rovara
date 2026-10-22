import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, canonicalJson, portableOperationId, buildE2ESharedView, e2ePlanHasCompleteRequiredCriteria, parsePlanDocument, e2eScenarioBundleDigest, type E2EFeaturePlanIntent, type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { deriveProjectSetupSourceSmoke } from "../../packages/broker/src/e2e/project-setup-source-smoke.js";
import { selectE2EExecutionPlan } from "../../packages/contracts/src/e2e-execution-plan.js";
import { buildE2EFeatureRound, deriveE2EFeatureExecutionAdmission, deriveE2EFeaturePortableApprovalBinding } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import { buildFeatureE2EPlanningContext, isExactFeatureE2ESourceSnapshot } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { compileE2EScenarios } from "../../packages/verifier/src/scenarios.js";
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
  it("keeps unlinked fixture hints while binding a proposed new callable only after final source adds it", () => {
    const baseModule = Buffer.from("export function priceRows(input) { function unrelated(input) { return input.mode; } return { rows: input.rows }; }\n");
    const baseCandidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "d".repeat(40), treeSha: "e".repeat(40) }]);
    const baseSnapshot: E2ESourceSnapshot = { ...snapshot, candidate: baseCandidate, commitSha: baseCandidate.repositories[0]!.commitSha,
      treeSha: baseCandidate.repositories[0]!.treeSha,
      sources: snapshot.sources.map((source) => source.path === "src/index.mjs" ? { ...source, sha256: sha(baseModule), bytes: baseModule } : source) };
    const context = buildFeatureE2EPlanningContext(policy, baseSnapshot, { origin: "approved-setup", preparedCommitSha: null });
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.portableOperations[0]?.callableSelectors.map((item) => item.selector)).toEqual([{ kind: "named", exportName: "priceRows" }]);
    expect(context.mockFixtures[0]?.callableMappings).toEqual([]);

    const operation = context.portableOperations[0]!;
    const fixture = context.mockFixtures[0]!;
    const proposed: E2EFeaturePlanIntent = {
      schemaVersion: 1, requestedTargetIds: context.targets.map((item) => item.targetId),
      portableOperationRefs: [{ operationId: operation.operationId, applicationId: operation.applicationId,
        requestedTargetIds: operation.requestedTargetIds, packageExportSubpath: operation.packageExportSubpath,
        moduleSpecifier: operation.moduleSpecifier, callableSelector: { kind: "named", exportName: "renderOrders" } }],
      mockFixtureRefs: [{ componentId: fixture.componentId, requestedTargetId: fixture.requestedTargetIds[0]!,
        operationId: fixture.operationId, sourcePath: fixture.sourcePath, sourceSha256: fixture.sourceSha256 }],
      accountContextRefs: context.accountContextRefs,
      scenarios: fixture.variants.map((variant) => ({ scenarioId: `render-orders-${variant.id}`, requirementId: "render-orders",
        requestedTargetIds: [fixture.requestedTargetIds[0]!], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract" as const,
        requiredRealComponentIds: [], steps: [{ kind: "invoke-contract" as const, operationId: operation.operationId, input: { mode: variant.inputValue } }],
        assertions: [{ kind: "state" as const, probeId: "result", equals: variant.id === "success" ? "Sample order" : variant.id === "refusal" ? "refused:403" : "invalid-data", pollTimeoutMs: 1000 }] })),
      semanticExportDeltas: [],
    };
    const parsed = parsePlanDocument(`\`\`\`agentx-plan\n${JSON.stringify({ schemaVersion: 1, title: "Render orders", why: [{ text: "Show orders from the source-backed API contract.", author: "owner" }],
      claims: [{ id: "1", text: "A user can view orders." }], notChanging: ["Existing access rules."], risks: ["The renderer is proposed future code."], decisions: [], e2e: proposed })}\n\`\`\``, { kind: "plan" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.plan.e2e?.schemaVersion !== 1) return;
    const proposedIntent = parsed.plan.e2e;
    expect(() => deriveE2EFeaturePortableApprovalBinding({ intent: proposedIntent, snapshot: baseSnapshot,
      artifactId: "feature-plan", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) })).toThrow();

    const finalModule = Buffer.from(`${baseModule.toString("utf8")}export async function renderOrders(input) { const response = await fetch("/orders?mode=" + encodeURIComponent(input.mode)); if (!response.ok) return "refused:" + response.status; const body = await response.json(); if (!Array.isArray(body.orders)) return "invalid-data"; return body.orders.map((row) => row.name).join(","); }\n`);
    const finalCandidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "f".repeat(40), treeSha: "1".repeat(40) }]);
    const finalSnapshot: E2ESourceSnapshot = { ...baseSnapshot, candidate: finalCandidate, commitSha: finalCandidate.repositories[0]!.commitSha,
      treeSha: finalCandidate.repositories[0]!.treeSha,
      sources: baseSnapshot.sources.map((source) => source.path === "src/index.mjs" ? { ...source, sha256: sha(finalModule), bytes: finalModule } : source) };
    const finalBinding = deriveE2EFeaturePortableApprovalBinding({ intent: parsed.plan.e2e, snapshot: finalSnapshot,
      artifactId: "feature-plan", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) });
    expect(finalBinding.operations[0]).toMatchObject({ callableSelector: { kind: "named", exportName: "renderOrders" },
      sourceRefs: [{ path: "src/index.mjs", sha256: sha(finalModule) }] });
  });

  it("turns prepared-source discovery into a parseable three-case mock proposal and compiled admission", () => {
    const context = buildFeatureE2EPlanningContext(policy, snapshot);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.source).toEqual({ origin: "prepared-commit", commitSha: snapshot.commitSha, treeSha: snapshot.treeSha,
      candidateDigest: snapshot.candidate.digest, preparedCommitStatus: "MATCHED", preparedCommitSha: snapshot.commitSha, currentCheckoutUnverified: false });
    expect(context.targets).toEqual([{ targetId: "web-1", applicationId: "ordinary-orders", kind: "web", accountProfileId: "synthetic" }]);
    const operation = context.portableOperations.find((item) => item.operationId === portableOperationId(".", "ordinary-orders"));
    expect(operation).toMatchObject({ packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs",
      callableSelectors: [{ selector: { kind: "named", exportName: "renderOrders" } }] });
    expect(context.mockFixtures).toHaveLength(1);
    expect(context.mockFixtures[0]).toMatchObject({ contractPath: "openapi.json", method: "GET", path: "/orders",
      inputSelector: { kind: "query", name: "mode" }, callableMappings: [] });
    expect(context.mockFixtures[0]?.variants.map((variant) => variant.id)).toEqual(["success", "refusal", "invalid-data"]);

    const proposed: E2EFeaturePlanIntent = {
      schemaVersion: 1, requestedTargetIds: context.targets.map((item) => item.targetId),
      portableOperationRefs: context.portableOperations.map((item) => ({ operationId: item.operationId, applicationId: item.applicationId,
        requestedTargetIds: item.requestedTargetIds, packageExportSubpath: item.packageExportSubpath, moduleSpecifier: item.moduleSpecifier,
        callableSelector: item.callableSelectors[0]!.selector })),
      mockFixtureRefs: context.mockFixtures.flatMap(({ componentId, requestedTargetIds, operationId, sourcePath, sourceSha256 }) =>
        requestedTargetIds.map((requestedTargetId) => ({ componentId, requestedTargetId, operationId, sourcePath, sourceSha256 }))),
      accountContextRefs: context.accountContextRefs,
      scenarios: context.mockFixtures[0]!.variants.map((variant) => ({ scenarioId: `render-orders-${variant.id}`, requirementId: "render-orders-requirement",
        requestedTargetIds: [context.mockFixtures[0]!.requestedTargetIds[0]!], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract" as const,
        requiredRealComponentIds: [], steps: [{ kind: "invoke-contract" as const, operationId: operation!.operationId,
          input: { [context.mockFixtures[0]!.inputSelector.name]: variant.inputValue } }],
        assertions: [{ kind: "state" as const, probeId: "result", equals: variant.id === "success" ? "Sample order" : variant.id === "refusal" ? "refused:403" : "invalid-data", pollTimeoutMs: 1000 }] })),
      semanticExportDeltas: [],
    };
    const parsed = parsePlanDocument(`\`\`\`agentx-plan\n${JSON.stringify({ schemaVersion: 1, title: "Render orders", why: [{ text: "Show orders.", author: "owner" }],
      claims: [{ id: "1", text: "A user can view orders." }], notChanging: ["Existing access rules."], risks: ["Mock scenarios are proposals, not qualification evidence."], decisions: [], e2e: proposed })}\n\`\`\``, { kind: "plan" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.plan.e2e?.schemaVersion !== 1) return;
    const admission = deriveE2EFeatureExecutionAdmission({ intent: parsed.plan.e2e, snapshot, artifactId: "feature-plan", artifactSha256: "b".repeat(64),
      planDigest: "c".repeat(64), policy, runtimeCatalogId: "local-catalog", runtimeBinding: binding, featureVerifier: featureRecord,
      now: Date.parse("2026-10-13T12:30:00.000Z") });
    expect(admission.plan.groups.flatMap((group) => group.expectedCases).map((item) => item.scenarioId)).toEqual(["render-orders-success", "render-orders-refusal", "render-orders-invalid-data"]);
    expect(admission.selectionInput.mockableComponents?.[0]).toMatchObject({ componentId: context.mockFixtures[0]!.componentId,
      requestedTargetId: context.mockFixtures[0]!.requestedTargetIds[0]!, kind: "api" });
    const group = admission.plan.groups[0]!;
    const bundleBody = { schemaVersion: 1 as const, planDigest: "c".repeat(64), templateVersion: "trusted-e2e/v1", scenarios: proposed.scenarios, bundleDigest: "0".repeat(64) };
    const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
    const compiled = compileE2EScenarios(bundle, admission.plan.effectiveTargets, group, { selectionInput: admission.selectionInput, executionPlan: admission.plan, group });
    expect(compiled.caseBindings.size).toBe(3);
  });

  it("keeps package operations available when the base export module has no callable yet", () => {
    const seedModule = Buffer.from("export const seed = 1;\n");
    const seedCandidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "2".repeat(40), treeSha: "3".repeat(40) }]);
    const seedSnapshot: E2ESourceSnapshot = { ...snapshot, candidate: seedCandidate, commitSha: seedCandidate.repositories[0]!.commitSha,
      treeSha: seedCandidate.repositories[0]!.treeSha,
      sources: snapshot.sources.map((source) => source.path === "src/index.mjs" ? { ...source, sha256: sha(seedModule), bytes: seedModule } : source) };
    const context = buildFeatureE2EPlanningContext(policy, seedSnapshot);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.portableOperations).toHaveLength(1);
    expect(context.portableOperations[0]).toMatchObject({ operationId: portableOperationId(".", "ordinary-orders"),
      moduleSpecifier: "./src/index.mjs", callableSelectors: [] });
    expect(context.mockFixtures[0]?.callableMappings).toEqual([]);
    expect(() => deriveE2EFeaturePortableApprovalBinding({ intent, snapshot: seedSnapshot,
      artifactId: "feature-plan", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) })).toThrow();
    const finalModule = Buffer.from(`${seedModule.toString("utf8")}export function renderOrders(input) { return input.mode; }\n`);
    const finalCandidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "4".repeat(40), treeSha: "5".repeat(40) }]);
    const finalSnapshot: E2ESourceSnapshot = { ...seedSnapshot, candidate: finalCandidate, commitSha: finalCandidate.repositories[0]!.commitSha,
      treeSha: finalCandidate.repositories[0]!.treeSha,
      sources: seedSnapshot.sources.map((source) => source.path === "src/index.mjs" ? { ...source, sha256: sha(finalModule), bytes: finalModule } : source) };
    expect(deriveE2EFeaturePortableApprovalBinding({ intent, snapshot: finalSnapshot, artifactId: "feature-plan",
      artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) }).operations[0]).toMatchObject({
      callableSelector: { kind: "named", exportName: "renderOrders" }, sourceRefs: [{ path: "src/index.mjs", sha256: sha(finalModule) }],
    });
  });

  it("marks prepared snapshot identity mismatches unknown and keeps oversized context out of prompts", () => {
    expect(isExactFeatureE2ESourceSnapshot(snapshot, "ordinary-orders", snapshot.commitSha)).toBe(true);
    expect(isExactFeatureE2ESourceSnapshot(snapshot, "another-repository", snapshot.commitSha)).toBe(false);
    expect(isExactFeatureE2ESourceSnapshot(snapshot, "ordinary-orders", "9".repeat(40))).toBe(false);
    expect(isExactFeatureE2ESourceSnapshot({ ...snapshot, treeSha: "9".repeat(40) }, "ordinary-orders", snapshot.commitSha)).toBe(false);
    const mismatch = buildFeatureE2EPlanningContext(policy, snapshot, { preparedCommitSha: "9".repeat(40) });
    expect(mismatch).toMatchObject({ status: "unknown" });
    expect(buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: "9".repeat(40) }))
      .toMatchObject({ status: "unknown" });
    const oversized = buildFeatureE2EPlanningContext({ ...policy, baselineScenarioIds: ["x".repeat(12_001)] }, snapshot);
    expect(oversized).toMatchObject({ status: "unknown" });
    const missingTargets = buildFeatureE2EPlanningContext({ ...policy, targets: [{ ...target, targetId: "unconfigured-target" }] }, snapshot);
    expect(missingTargets).toMatchObject({ status: "unknown" });
  });

  it("reads the approved target's runtime profile, and keeps a package with no launch recipe unavailable on a READY runtime", () => {
    const approved: E2EPolicy = { ...policy, targets: [{ ...target, runtimeProfileId: "linux-arm64-web-api-v1" }] };
    const readyRuntimes = [{ kind: "web" as const, profileId: "linux-arm64-web-api-v1", supportedSteps: ["navigate", "fill", "click", "choose-file"] as never,
      supportedAssertions: ["text", "visible", "csv"] as never }];
    const context = buildFeatureE2EPlanningContext(approved, snapshot, { readyRuntimes });
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.runtimeRefs).toMatchObject([{ targetId: "web-1", runtimeProfileId: "linux-arm64-web-api-v1" }]);
    // ordinary-orders has no start script and declares no agentx.e2e contract, so discovery proposes no launch recipe for it.
    expect(context.unavailableReasons).toEqual([{ targetId: "web-1", reason: "no-launch-recipe" }]);
    expect(context.executableKinds).toEqual([]);
    const placeholder = buildFeatureE2EPlanningContext(policy, snapshot, { readyRuntimes });
    if (placeholder.status !== "available") return;
    expect(placeholder.runtimeRefs).toMatchObject([{ runtimeProfileId: "web-phase-unavailable" }]);
    // No target on a qualified profile: the pre-2.2 context shape (Ruling AQ).
    expect(placeholder).not.toHaveProperty("unavailableReasons");
    expect(placeholder).not.toHaveProperty("executableKinds");
  });

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
    expect(() => deriveE2EFeaturePortableApprovalBinding({ intent: { ...intent, mockFixtureRefs: intent.mockFixtureRefs?.map((item) => ({ ...item, sourceSha256: "0".repeat(64) })) }, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) })).toThrow();
    expect(() => deriveE2EFeaturePortableApprovalBinding({ intent: { ...intent, accountContextRefs: intent.accountContextRefs.map((item) => ({ ...item, sourceSha256: "0".repeat(64) })) }, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64) })).toThrow();
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

  describe("a project policy that pins an AI navigation route (M1.4 Task 4.2)", () => {
    const PINNED = "r1-0123456789ab";
    const pinned = { ...policy, modelRouteRevision: PINNED };
    const admit = (candidatePolicy: E2EPolicy) => deriveE2EFeatureExecutionAdmission({ intent, snapshot, artifactId: "plan-artifact", artifactSha256: "b".repeat(64),
      planDigest: "c".repeat(64), policy: candidatePolicy, runtimeCatalogId: "local-catalog", runtimeBinding: binding,
      featureVerifier: featureRecord, now: Date.parse("2026-10-13T12:30:00.000Z") });

    it("still selects the same portable groups and cases, with the model-free policy projection", () => {
      const plain = admit(policy);
      const withRoute = admit(pinned);
      expect(withRoute.plan.groups.length).toBeGreaterThan(0);
      expect(withRoute.plan.groups.flatMap((group) => group.expectedCases).map((item) => item.scenarioId))
        .toEqual(plain.plan.groups.flatMap((group) => group.expectedCases).map((item) => item.scenarioId));
      expect(withRoute.selectionInput.policy.modelRouteRevision).toBeNull();
      expect(withRoute.plan.digest).toBe(plain.plan.digest);
    });

    it("binds a null model route in every group of the round", () => {
      const admission = admit(pinned);
      const { round } = buildE2EFeatureRound({ admission, taskId: "task-1", operationId: "operation-1", operationFence: 3, workflowRevision: 8,
        roundId: "22222222-2222-4222-8222-222222222222", runIds: admission.plan.groups.map((_, index) => `33333333-3333-4333-8333-33333333333${index}`),
        admittedAt: "2026-10-13T12:30:00.000Z", deadlineAt: "2026-10-13T12:31:00.000Z" });
      expect(round.groupBindings.every((item) => item.modelRouteRevision === null)).toBe(true);
    });

    it("gives project setup smoke the same projection, so a pinned route does not empty its plan", () => {
      const smoke = (candidatePolicy: E2EPolicy) => deriveProjectSetupSourceSmoke({ projectName: "ordinary-orders", proposalSha256: "d".repeat(64), approval: { proposalSha256: "d".repeat(64) },
        snapshot, policy: candidatePolicy,
        sandboxAvailability: { targetId: "default-sandbox", profileId: "default-sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "catalog-1" },
        runtimeAvailability: [] });
      const setupPolicy = { ...policy, baselineScenarioIds: [] };
      const plain = selectE2EExecutionPlan(smoke(setupPolicy).selectionInput);
      const withRoute = smoke({ ...setupPolicy, modelRouteRevision: PINNED });
      expect(plain.groups.length).toBeGreaterThan(0);
      expect(withRoute.selectionInput.policy.modelRouteRevision).toBeNull();
      expect(selectE2EExecutionPlan(withRoute.selectionInput).groups.length).toBe(plain.groups.length);
    });
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
