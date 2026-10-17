import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2EExpectedCaseSchema } from "../../packages/contracts/src/e2e.js";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { E2EApplicationPlanIntentSchema, createCandidateManifest, e2eApplicationMetadataSourceRefs, inspectE2ERepository,
  E2ERegisteredRuntimeSchema, E2ERuntimeCapabilityDescriptorSchema, e2eRuntimeCapabilityDigest, e2eScenarioBundleDigest,
  proposeE2ESetup, type E2EPolicy, type E2ESourceSnapshot } from "../../packages/contracts/src/index.js";
import { e2eApplicationUpstreamTestIdFromIdentity, projectE2EApplicationPortableSelection, selectE2EApplicationExecutionPlan,
  type E2EApplicationPlanSelectionInput } from "../../packages/contracts/src/e2e-application-execution-plan.js";
import { e2eCaseIdFromIdentity, e2eCaseIdentityDigest, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import { deriveE2EApplicationApprovalBinding } from "../../packages/broker/src/e2e/application-plan-binding.js";
import { deriveE2EFeaturePortableApprovalBinding } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import { deriveE2EApplicationFeatureExecutionSelection } from "../../packages/broker/src/e2e/application-feature-plan-intent.js";
import { compileE2EScenarios } from "../../packages/verifier/src/scenarios.js";

function qualifiedWebRuntime(profileId: string, now: number) {
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId,
    kind: "web", host: { os: "linux", arch: "x64" }, engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
    runtimeManifestDigest: "a".repeat(64), supportedSteps: ["navigate"], supportedAssertions: ["visible"],
    evidenceScopes: ["runtime"], networkPolicyDigest: "b".repeat(64), browsers: ["chromium"] });
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux", arch: "x64" };
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId, capabilityDigest,
    runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "c".repeat(64), fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }],
    positiveProbeIds: ["browser-opens"], negativeProbeIds: ["browser-blocked-network"] };
  const probeManifest = { ...probeBody, manifestDigest: hash(probeBody) };
  const base = { schemaVersion: 2 as const, entityType: "E2E_FEATURE_VERIFIER" as const, runtimeCatalogId: "runtime-catalog",
    catalogRevision: 3, profileId, generation: 4, binding, bindingDigest: hash(binding), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: hash(runnerEnvironment), runnerToolchain, runnerToolchainDigest: hash(runnerToolchain),
    capabilities, capabilityDigest, probeManifest, qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
    state: "READY" as const, qualifiedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() };
  return E2ERegisteredRuntimeSchema.parse(base);
}

describe("application upstream test identity", () => {
  it("uses the application generated test path and preserves the shared case tuple", () => {
    const identity = { scenarioId: "native-home", targetId: "android-app", requestedTargetId: "android",
      accountProfileId: "synthetic", accountContextId: "ctx", accountContextDigest: "a".repeat(64),
      executionDescriptorDigest: "b".repeat(64), minimumEvidence: "runtime", requiredRealComponentIds: [],
      agentId: "default", repeat: 0, assertionDigests: ["c".repeat(64)] };
    expect(e2eApplicationUpstreamTestIdFromIdentity(identity)).toBe(`.agentx/e2e/generated-application.test.ts::case-${e2eCaseIdentityDigest(identity)}`);
    expect(e2eUpstreamTestIdFromIdentity(identity)).toBe(`.agentx/e2e/generated-contract.test.ts::case-${e2eCaseIdentityDigest(identity)}`);
    const parsed = E2EExpectedCaseSchema.safeParse({ ...identity, caseId: e2eCaseIdFromIdentity(identity), criterionId: "criterion-1",
      upstreamTestId: e2eApplicationUpstreamTestIdFromIdentity(identity), targetId: identity.targetId, requestedTargetId: identity.requestedTargetId,
      assertionDigest: createHash("sha256").update(canonicalJson(identity.assertionDigests)).digest("hex"), required: true,
      minimumEvidence: identity.minimumEvidence, requiredRealComponentIds: identity.requiredRealComponentIds });
    expect(parsed.success).toBe(true);
  });
});

describe("application execution plan selection", () => {
  it("retains a source-bound native criterion with no invented profile or runnable group", () => {
    const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const candidate = createCandidateManifest([{ repositoryId: "mobile-app", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const files = [
      { path: "android/app/src/main/AndroidManifest.xml", bytes: Buffer.from('<manifest package="com.example.mobile"><application/></manifest>\n') },
      { path: "android/app/build.gradle", bytes: Buffer.from('plugins { id "com.android.application" }\n') },
    ];
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha,
      treeComplete: true, treePaths: files.map((file) => file.path),
      sources: files.map((file) => ({ ...file, sha256: hash(file.bytes), kind: "blob" as const })) };
    const inspection = inspectE2ERepository(snapshot, candidate).inspection;
    const target = inspection.proposedTargets[0]!;
    const scenario = { scenarioId: "native-home", requirementId: "home-visible", requestedTargetIds: [target.targetId], required: true,
      accountProfileId: target.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
      steps: [{ kind: "launch-app" as const }], assertions: [{ kind: "visible" as const, testId: "home", equals: true }] };
    const application = inspection.applications[0]!;
    const metadataRefs = e2eApplicationMetadataSourceRefs(snapshot, target.applicationId, application.sourcePaths);
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId],
      accountContextRefs: [{ applicationId: target.applicationId, profileId: target.accountProfileId,
        sourcePath: "android/app/src/main/AndroidManifest.xml", sourceSha256: hash(files[0]!.bytes) }], scenarios: [scenario],
      semanticExportDeltas: [], applicationRuntimeRefs: [], runtimeAccountRefs: [], unavailableTargetRefs: [{ targetId: target.targetId,
        applicationId: target.applicationId, accountProfileId: target.accountProfileId, sourceRefs: metadataRefs }] });
    const setupProposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate });
    const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [scenario.scenarioId],
      targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
      capture: { screenshots: false, traces: false, video: false, downloads: false },
      limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
        maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
    const selectionInput: E2EApplicationPlanSelectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot,
      planDigest: "c".repeat(64), policy, scenarios: [scenario], selectedTargetIds: [target.targetId], sandboxAvailability: null,
      runtimeAvailability: [],
      approvedSemanticApproval: { artifactId: "plan", digest: "d".repeat(64) }, intent,
      intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval: { artifactId: "setup", digest: hash(canonicalJson(setupProposal)) },
      applicationApprovalBinding: null, registeredRuntimes: [], runtimeAccountRefs: [], now: Date.parse("2026-10-17T18:00:00.000Z") };
    const plan = selectE2EApplicationExecutionPlan(selectionInput);
    expect(plan.criteria).toHaveLength(1);
    expect(plan.criteria[0]).toMatchObject({ required: true, minimumEvidence: "runtime", requiredRealComponentIds: [], expectedCaseIds: [] });
    expect(plan.unavailableCriteria).toHaveLength(1);
    expect(plan.groups).toEqual([]);
  });

  it("keeps native baseline scope outside a model-free portable compiler projection", () => {
    const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const candidate = createCandidateManifest([{ repositoryId: "mixed-apps", commitSha: "e".repeat(40), treeSha: "f".repeat(40) }]);
    const openApi = { openapi: "3.1.0", info: { title: "Orders", version: "1" }, paths: { "/orders": { get: {
      operationId: "listOrders", parameters: [{ name: "mode", in: "query", required: true, schema: { type: "string", enum: ["success", "refusal", "invalid-data"] } }],
      responses: {
        "200": { description: "orders", content: { "application/json": { schema: { type: "object",
          properties: { orders: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } } },
          required: ["orders"], additionalProperties: false } } } },
        "403": { description: "refused", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } },
          required: ["error"], additionalProperties: false } } } },
      },
    } } } };
    const mockFixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "listOrders", method: "GET", path: "/orders", inputField: "mode",
      variants: [{ id: "success", inputValue: "success", status: 200, body: { orders: [{ name: "Sample order" }] } },
        { id: "refusal", inputValue: "refusal", status: 403, body: { error: "refused" } },
        { id: "invalid-data", inputValue: "invalid-data", status: 200, body: { orders: "bad" } }] };
    const files = [
      { path: "apps/web/package.json", bytes: Buffer.from(JSON.stringify({ name: "web-app", type: "module", scripts: { start: "node server.js" }, exports: { "./ops": "./src/ops.js" } })) },
      { path: "apps/web/src/ops.js", bytes: Buffer.from("export function list() { return { ok: true }; }\n") },
      { path: "apps/web/openapi.json", bytes: Buffer.from(JSON.stringify(openApi)) },
      { path: "apps/web/fixtures/orders-mocks.json", bytes: Buffer.from(JSON.stringify(mockFixture)) },
      { path: "apps/mobile/android/app/src/main/AndroidManifest.xml", bytes: Buffer.from('<manifest package="com.example.mobile"><application/></manifest>\n') },
      { path: "apps/mobile/android/app/build.gradle", bytes: Buffer.from('plugins { id "com.android.application" }\n') },
    ];
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha,
      treeComplete: true, treePaths: files.map((file) => file.path),
      sources: files.map((file) => ({ ...file, sha256: hash(file.bytes), kind: "blob" as const })) };
    const discovery = inspectE2ERepository(snapshot, candidate);
    const web = discovery.inspection.proposedTargets.find((target) => target.kind === "web")!;
    const android = discovery.inspection.proposedTargets.find((target) => target.kind === "mobile")!;
    const operation = discovery.portableOperations.find((item) => item.applicationId === web.applicationId)!;
    const webApplication = discovery.inspection.applications.find((item) => item.applicationId === web.applicationId)!;
    const nativeApplication = discovery.inspection.applications.find((item) => item.applicationId === android.applicationId)!;
    const webIdentity = e2eApplicationMetadataSourceRefs(snapshot, web.applicationId, webApplication.sourcePaths)[0]!;
    const nativeIdentity = e2eApplicationMetadataSourceRefs(snapshot, android.applicationId, nativeApplication.sourcePaths)[0]!;
    const accountContextRefs = [
      { applicationId: web.applicationId, profileId: web.accountProfileId, sourcePath: webIdentity.path, sourceSha256: webIdentity.sha256 },
      { applicationId: android.applicationId, profileId: android.accountProfileId, sourcePath: nativeIdentity.path, sourceSha256: nativeIdentity.sha256 },
    ];
    const portableScenario = { scenarioId: "web-export", requirementId: "export-runs", requestedTargetIds: [web.targetId], required: true,
      accountProfileId: web.accountProfileId, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [],
      steps: [{ kind: "invoke-contract" as const, operationId: operation.operationId, input: {} }],
      assertions: [{ kind: "state" as const, probeId: "result", equals: { ok: true }, pollTimeoutMs: 1000 }] };
    const nativeScenario = { scenarioId: "native-home", requirementId: "native-home-visible", requestedTargetIds: [android.targetId], required: true,
      accountProfileId: android.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
      steps: [{ kind: "launch-app" as const }], assertions: [{ kind: "visible" as const, testId: "home", equals: true }] };
    const realScenario = { scenarioId: "web-ui", requirementId: "web-ui-visible", requestedTargetIds: [web.targetId], required: true,
      accountProfileId: web.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
      steps: [{ kind: "navigate" as const, path: "/" }], assertions: [{ kind: "visible" as const, testId: "home", equals: true }] };
    const agentScenario = { scenarioId: "web-agent", requirementId: "web-agent-visible", requestedTargetIds: [web.targetId], required: true,
      accountProfileId: web.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
      steps: [{ kind: "agent" as const, goal: "inspect the home page", maxActions: 3 }],
      assertions: [{ kind: "visible" as const, testId: "home", equals: true }] };
    const setupProposal = proposeE2ESetup({ inspection: discovery.inspection, snapshot, expectedCandidate: candidate });
    const setupApproval = { artifactId: "setup", digest: hash(canonicalJson(setupProposal)) };
    const semanticApproval = { artifactId: "full-plan", digest: "1".repeat(64) };
    const operationRef = { operationId: operation.operationId, applicationId: operation.applicationId, requestedTargetIds: [web.targetId],
      packageExportSubpath: operation.exportName, moduleSpecifier: "./src/ops.js", callableSelector: { kind: "named" as const, exportName: "list" } };
    const runtimeRef = { targetId: web.targetId, applicationId: web.applicationId, recipeDigest: webApplication.recipe!.recipeDigest,
      sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, web.applicationId, webApplication.sourcePaths), runtimeProfileId: "qualified-chromium", accountProfileId: web.accountProfileId };
    const runtimeAccountRef = { applicationId: web.applicationId, profileId: web.accountProfileId, revision: 1, definitionDigest: "2".repeat(64) };
    const mockComponentId = `api-schema-${hash(Buffer.from("apps/web/openapi.json")).slice(0, 12)}`;
    const mockFixtureBytes = files.find((file) => file.path === "apps/web/fixtures/orders-mocks.json")!.bytes;
    const mockFixtureRef = { componentId: mockComponentId, requestedTargetId: web.targetId, operationId: "listOrders",
      sourcePath: "apps/web/fixtures/orders-mocks.json", sourceSha256: hash(mockFixtureBytes) };
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [web.targetId, android.targetId],
      portableOperationRefs: [operationRef], mockFixtureRefs: [], accountContextRefs, scenarios: [realScenario, agentScenario, portableScenario, nativeScenario],
      semanticExportDeltas: [], applicationRuntimeRefs: [runtimeRef], runtimeAccountRefs: [runtimeAccountRef],
      unavailableTargetRefs: [{ targetId: android.targetId, applicationId: android.applicationId, accountProfileId: android.accountProfileId,
        sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, android.applicationId, nativeApplication.sourcePaths) }] });
    const planDigest = "3".repeat(64);
    const realIntent = E2EApplicationPlanIntentSchema.parse({ ...intent, requestedTargetIds: [web.targetId],
      portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: [accountContextRefs[0]!], scenarios: [realScenario],
      applicationRuntimeRefs: [runtimeRef], runtimeAccountRefs: [runtimeAccountRef], unavailableTargetRefs: [],
      semanticExportDeltas: [] });
    const applicationApprovalBinding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent: realIntent,
      artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest, setupProposal, setupApproval });
    const portableApprovalBinding = deriveE2EFeaturePortableApprovalBinding({ intent: { schemaVersion: 1, requestedTargetIds: [web.targetId],
      portableOperationRefs: [operationRef], mockFixtureRefs: [], accountContextRefs: [accountContextRefs[0]!],
      scenarios: [portableScenario], semanticExportDeltas: [] }, snapshot, artifactId: semanticApproval.artifactId,
      artifactSha256: semanticApproval.digest, planDigest });
    const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["native-home"],
      targets: [web, android], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: "route-v1",
      capture: { screenshots: false, traces: false, video: false, downloads: false },
      limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
        maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
    const input: E2EApplicationPlanSelectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot,
      planDigest, policy, scenarios: intent.scenarios, selectedTargetIds: intent.requestedTargetIds,
      sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved",
        qualification: "qualified", authorizationRevision: "sandbox-auth" }, runtimeAvailability: [], portableApprovalBinding,
      approvedSemanticApproval: semanticApproval, intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval,
      applicationApprovalBinding, registeredRuntimes: [], runtimeAccountRefs: [runtimeAccountRef], now: Date.parse("2026-10-17T18:00:00.000Z") };
    const projection = projectE2EApplicationPortableSelection(input)!;
    expect(input.policy.modelRouteRevision).toBe("route-v1");
    expect(projection.selectionInput.policy.modelRouteRevision).toBeNull();
    expect(projection.selectionInput.policy.baselineScenarioIds).toEqual([]);
    expect(projection.selectionInput.scenarios.map((scenario) => scenario.scenarioId)).toEqual(["web-export"]);
    const group = projection.executionPlan.groups[0]!;
    const compiled = compileE2EScenarios(projection.bundle, projection.executionPlan.effectiveTargets, group,
      { selectionInput: projection.selectionInput, executionPlan: projection.executionPlan, group });
    expect(compiled.expectedCases.map((item) => item.caseId)).toEqual(group.expectedCases.map((item) => item.caseId));
    const combined = selectE2EApplicationExecutionPlan(input);
    expect(combined.criteria.find((item) => item.scenarioId === "native-home")).toMatchObject({ minimumEvidence: "runtime", expectedCaseIds: [] });
    const nativeCriterion = combined.criteria.find((item) => item.scenarioId === "native-home")!;
    expect(combined.unavailableCriteria.some((item) => item.criterionId === nativeCriterion.criterionId)).toBe(true);
    expect(combined.groups.find((item) => item.groupId === group.groupId)?.expectedCases.map((item) => item.caseId))
      .toEqual(group.expectedCases.map((item) => item.caseId));
    const fullBundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1",
      scenarios: intent.scenarios, bundleDigest: "0".repeat(64) };
    const fullBundle = { ...fullBundleBody, bundleDigest: e2eScenarioBundleDigest(fullBundleBody) };
    expect(() => compileE2EScenarios(fullBundle, combined.effectiveTargets, group,
      { selectionInput: input, executionPlan: combined, group })).toThrow();
    expect(() => selectE2EApplicationExecutionPlan({ ...input, intentDigest: "f".repeat(64) })).toThrow(/intent digest/);
    expect(() => selectE2EApplicationExecutionPlan({ ...input, setupApproval: { ...setupApproval, digest: "f".repeat(64) } })).toThrow(/setup approval/);
    const foreignPolicy = { ...policy, targets: policy.targets.map((target) => target.targetId === android.targetId
      ? { ...target, applicationId: "foreign-app" } : target) };
    expect(() => selectE2EApplicationExecutionPlan({ ...input, policy: foreignPolicy })).toThrow(/differs from protected source identity/);
    const foreignUnavailableIntent = E2EApplicationPlanIntentSchema.parse({ ...intent, unavailableTargetRefs: intent.unavailableTargetRefs?.map((ref) =>
      ref.targetId === android.targetId ? { ...ref, sourceRefs: [webIdentity] } : ref) });
    expect(() => selectE2EApplicationExecutionPlan({ ...input, intent: foreignUnavailableIntent,
      intentDigest: hash(canonicalJson(foreignUnavailableIntent)) })).toThrow(/source or account identity differs/);

    const now = Date.parse("2026-10-17T18:00:00.000Z");
    const readyInput = { ...input, now, registeredRuntimes: [qualifiedWebRuntime(runtimeRef.runtimeProfileId, now)],
      runtimeAvailability: [{ targetId: web.targetId, profileId: runtimeRef.runtimeProfileId, connection: "connected" as const,
        approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "web-auth-r1" }] };
    const agentIntent = E2EApplicationPlanIntentSchema.parse({ ...intent, scenarios: [agentScenario, portableScenario, nativeScenario] });
    expect(() => selectE2EApplicationExecutionPlan({ ...input, policy: { ...policy, modelRouteRevision: null },
      intent: agentIntent, scenarios: agentIntent.scenarios, intentDigest: hash(canonicalJson(agentIntent)) })).toThrow(/agent steps require an approved model route revision/);
    const ready = selectE2EApplicationExecutionPlan(readyInput);
    expect(ready.criteria.find((item) => item.scenarioId === "web-ui")?.expectedCaseIds).toHaveLength(1);
    expect(ready.groups.find((item) => item.mode === "real-runtime")?.expectedCases[0]?.upstreamTestId)
      .toMatch(/^\.agentx\/e2e\/generated-application\.test\.ts::case-/);
    const parked = selectE2EApplicationExecutionPlan({ ...readyInput,
      registeredRuntimes: [E2ERegisteredRuntimeSchema.parse({ ...readyInput.registeredRuntimes[0], state: "PARKED" })] });
    expect(parked.criteria.find((item) => item.scenarioId === "web-ui")?.expectedCaseIds).toEqual([]);
    expect(parked.unavailableCriteria.some((item) => item.criterionId === ready.criteria.find((item) => item.scenarioId === "web-ui")?.criterionId)).toBe(true);
    const futureQualified = selectE2EApplicationExecutionPlan({ ...readyInput,
      registeredRuntimes: [E2ERegisteredRuntimeSchema.parse({ ...readyInput.registeredRuntimes[0],
        qualifiedAt: new Date(now + 1_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() })] });
    expect(futureQualified.criteria.find((item) => item.scenarioId === "web-ui")?.expectedCaseIds).toEqual([]);
    expect(() => selectE2EApplicationExecutionPlan({ ...readyInput,
      runtimeAccountRefs: [{ ...runtimeAccountRef, revision: runtimeAccountRef.revision + 1 }] })).toThrow(/runtime account revisions differ/);
    const mixedStepIntent = E2EApplicationPlanIntentSchema.parse({ ...intent,
      scenarios: intent.scenarios.map((scenario) => scenario.scenarioId === "web-ui" ? { ...scenario,
        steps: [{ kind: "navigate", path: "/" }, { kind: "invoke-contract", operationId: operation.operationId, input: {} }] } : scenario) });
    expect(() => selectE2EApplicationExecutionPlan({ ...readyInput, intent: mixedStepIntent, scenarios: mixedStepIntent.scenarios,
      intentDigest: hash(canonicalJson(mixedStepIntent)) })).toThrow(/cannot mix portable and application steps/);

    const facade = deriveE2EApplicationFeatureExecutionSelection({ intent, snapshot, artifactId: semanticApproval.artifactId,
      artifactSha256: semanticApproval.digest, planDigest, approvedSemanticApproval: semanticApproval, setupProposal, setupApproval,
      policy, registeredRuntimes: [], runtimeAvailability: [], runtimeAccountRefs: [runtimeAccountRef], runtimeCatalogId: "catalog",
      runtimeBinding: null as never, featureVerifier: null, now: Date.parse("2026-10-17T18:00:00.000Z") });
    expect(facade.applicationApprovalBinding?.runtimeRefs).toEqual([runtimeRef]);
    expect(facade.portableApprovalBinding).not.toBeNull();
    expect(facade.plan.criteria.map((item) => item.scenarioId)).toEqual(["web-export", "web-ui", "web-agent", "native-home"]);
    expect(facade.plan.criteria.find((item) => item.scenarioId === "native-home")?.expectedCaseIds).toEqual([]);
    expect(facade.plan.unavailableCriteria.some((item) => item.criterionId === nativeCriterion.criterionId)).toBe(true);
    expect(facade.selectionInput.policy.modelRouteRevision).toBe("route-v1");
    expect(facade.portableProjection?.selectionInput.policy.modelRouteRevision).toBeNull();
    expect(facade.portableProjection?.selectionInput.policy.limits.maxModelRequests).toBe(1);
    expect(facade.portableProjection?.executionPlan.groups).toEqual([]);

    const realOnlyIntent = E2EApplicationPlanIntentSchema.parse({ ...intent, requestedTargetIds: [web.targetId],
      portableOperationRefs: [], mockFixtureRefs: [mockFixtureRef], accountContextRefs: [accountContextRefs[0]!],
      scenarios: [realScenario], applicationRuntimeRefs: [runtimeRef], runtimeAccountRefs: [runtimeAccountRef], unavailableTargetRefs: [],
      semanticExportDeltas: [] });
    const realOnlySelection = deriveE2EApplicationFeatureExecutionSelection({ intent: realOnlyIntent, snapshot,
      artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest,
      approvedSemanticApproval: semanticApproval, setupProposal, setupApproval, policy: { ...policy, baselineScenarioIds: [], targets: [web] },
      registeredRuntimes: [qualifiedWebRuntime(runtimeRef.runtimeProfileId, Date.parse("2026-10-17T18:00:00.000Z"))],
      runtimeAvailability: [{ targetId: web.targetId, profileId: runtimeRef.runtimeProfileId, connection: "connected", approval: "approved",
        qualification: "qualified", authorizationRevision: "web-auth-r1" }], runtimeAccountRefs: [runtimeAccountRef], runtimeCatalogId: "catalog",
      runtimeBinding: null as never, featureVerifier: null, now: Date.parse("2026-10-17T18:00:00.000Z") });
    expect(realOnlySelection.portableApprovalBinding).toBeNull();
    expect(realOnlySelection.selectionInput.mockableComponents).toHaveLength(1);
    expect(realOnlySelection.selectionInput.mockableComponents?.[0]).toMatchObject({ componentId: mockComponentId, requestedTargetId: web.targetId });
    expect(realOnlySelection.plan.groups).toHaveLength(1);
    expect(realOnlySelection.plan.groups[0]).toMatchObject({ mode: "hybrid", targetIds: [web.targetId] });
    expect(realOnlySelection.plan.mocks).toHaveLength(1);
    expect(realOnlySelection.plan.mocks[0]).toMatchObject({ componentId: mockComponentId, requestedTargetId: web.targetId,
      effectiveTargetId: web.targetId, kind: "api", fixtureVersion: "openapi-json-fixture-v1", reason: "phase-unavailable",
      sourceRefs: [{ path: "apps/web/openapi.json", sha256: hash(files.find((file) => file.path === "apps/web/openapi.json")!.bytes) }], apiFixture: mockFixture });
    expect(realOnlySelection.plan.groups[0]?.mockManifestDigest)
      .toBe(createHash("sha256").update(canonicalJson(realOnlySelection.plan.mocks)).digest("hex"));
    expect(() => selectE2EApplicationExecutionPlan({ ...realOnlySelection.selectionInput, mockableComponents: [] }))
      .toThrow(/do not exactly match the full approved intent and protected source/);
    const requiredRealIntent = E2EApplicationPlanIntentSchema.parse({ ...realOnlyIntent, scenarios: [{ ...realScenario,
      requiredRealComponentIds: [mockComponentId] }] });
    const requiredRealSelection = deriveE2EApplicationFeatureExecutionSelection({ intent: requiredRealIntent, snapshot,
      artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest,
      approvedSemanticApproval: semanticApproval, setupProposal, setupApproval, policy: { ...policy, baselineScenarioIds: [], targets: [web] },
      registeredRuntimes: [qualifiedWebRuntime(runtimeRef.runtimeProfileId, Date.parse("2026-10-17T18:00:00.000Z"))],
      runtimeAvailability: [{ targetId: web.targetId, profileId: runtimeRef.runtimeProfileId, connection: "connected", approval: "approved",
        qualification: "qualified", authorizationRevision: "web-auth-r1" }], runtimeAccountRefs: [runtimeAccountRef], runtimeCatalogId: "catalog",
      runtimeBinding: null as never, featureVerifier: null, now: Date.parse("2026-10-17T18:00:00.000Z") });
    expect(requiredRealSelection.plan.groups[0]).toMatchObject({ mode: "real-runtime" });
    expect(requiredRealSelection.plan.mocks).toEqual([]);
    expect(requiredRealSelection.plan.groups[0]?.expectedCases[0]?.requiredRealComponentIds).toEqual([mockComponentId]);

    const allUnavailableIntent = E2EApplicationPlanIntentSchema.parse({ ...intent, applicationRuntimeRefs: [], runtimeAccountRefs: [],
      unavailableTargetRefs: [
        { targetId: web.targetId, applicationId: web.applicationId, accountProfileId: web.accountProfileId,
          sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, web.applicationId, webApplication.sourcePaths) },
        { targetId: android.targetId, applicationId: android.applicationId, accountProfileId: android.accountProfileId,
          sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, android.applicationId, nativeApplication.sourcePaths) },
      ] });
    const allUnavailable = deriveE2EApplicationFeatureExecutionSelection({ intent: allUnavailableIntent, snapshot,
      artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest, approvedSemanticApproval: semanticApproval,
      setupProposal, setupApproval, policy, registeredRuntimes: [], runtimeAvailability: [], runtimeAccountRefs: [],
      runtimeCatalogId: "catalog", runtimeBinding: null as never, featureVerifier: null, now });
    expect(allUnavailable.applicationApprovalBinding).toBeNull();
    expect(allUnavailable.portableApprovalBinding).not.toBeNull();
    expect(allUnavailable.portableProjection).not.toBeNull();
    expect(allUnavailable.plan.groups).toEqual([]);
    expect(allUnavailable.plan.criteria.map((item) => item.scenarioId)).toEqual(["web-export", "web-ui", "web-agent", "native-home"]);
  });
});
