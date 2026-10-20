import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, E2ERegisteredRuntimeSchema, E2EPolicySchema, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, createCandidateManifest,
  WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, workflowRequestId, workspaceSessionKey, readCanonicalPlan, deriveE2ESyntheticRuntimeAccountRef, portableOperationId, type E2EApplicationPlanIntent,
  e2eApplicationMetadataSourceRefs, e2eRuntimeCapabilityDigest, inspectE2ERepository, proposeE2ESetup, selectE2EApplicationExecutionPlan,
  type E2EPolicy, type E2EScenario, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { deriveE2EApplicationFeatureExecutionSelection } from "../../packages/broker/src/e2e/application-feature-plan-intent.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { buildFeatureE2EPlanningContext, describeFeatureE2EExecutableKinds }
  from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { planDocumentInstructions, workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { portableFeatureIntentOf } from "../../packages/broker/src/e2e/portable-feature-intent.js";
import { createApplicationPlanNegotiationRecorder } from "../../packages/broker/src/aws/dispatcher.js";
import { decideTaskWorkflow } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { call, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PROFILE = WEB_API_RUNTIME_PROFILE_ID;
// The broker reads the clock itself, so the rows are valid around the real current time.
const NOW = Date.now();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const shaCanonical = (value: unknown) => sha(canonicalJson(value));
const ordersContractManifest = readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8");
const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };

/** One v2 catalog row of the qualified profile, carrying the real registered capability descriptor of its kind. */
function webApiRow(kind: "web" | "api", overrides: Record<string, unknown> = {}, editCapabilities: (value: ReturnType<typeof webApiRuntimeCapabilities>) => ReturnType<typeof webApiRuntimeCapabilities> = (value) => value) {
  const capabilities = editCapabilities(webApiRuntimeCapabilities(kind, "a".repeat(64)));
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux", arch: "arm64" };
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId: PROFILE, capabilityDigest,
    runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "c".repeat(64), fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }],
    positiveProbeIds: ["web-csv-positive"], negativeProbeIds: ["web-csv-negative"] };
  return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "catalog", catalogRevision: 3,
    profileId: PROFILE, generation: 4, binding, bindingDigest: shaCanonical(binding), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: shaCanonical(runnerEnvironment), runnerToolchain, runnerToolchainDigest: shaCanonical(runnerToolchain),
    capabilities, capabilityDigest, probeManifest: { ...probeBody, manifestDigest: shaCanonical(probeBody) },
    qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
    state: "READY", qualifiedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 3_600_000).toISOString(), ...overrides });
}

function snapshotOf(contents: Record<string, string>): E2ESourceSnapshot {
  const candidate = createCandidateManifest([{ repositoryId: "example/demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const sources = Object.entries(contents).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.from(text), kind: "blob" as const }));
  return { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((source) => source.path), sources };
}
/** The orders fixture: its package.json carries the agentx.e2e project contract (the explicit launch recipe). */
const contractSnapshot = snapshotOf({ "package.json": ordersContractManifest });
/** A web package with a start script and a lockfile: discovery infers its launch recipe; there is no project contract. */
const inferredSnapshot = snapshotOf({ "package.json": JSON.stringify({ name: "shop-web", scripts: { start: "node server.js" } }), "package-lock.json": "{}" });

/** The same project contract on an API package: discovery proposes an API target for it. */
const apiSnapshot = (() => {
  const manifest = JSON.parse(ordersContractManifest) as { name: string; agentx: { e2e: Record<string, unknown> } };
  return snapshotOf({ "package.json": JSON.stringify({ ...manifest, name: "@acme/orders-api", dependencies: { express: "4.0.0" },
    agentx: { e2e: { ...manifest.agentx.e2e, targetAccounts: [] } } }) });
})();

const csvScenario: E2EScenario = { scenarioId: "export-csv", requirementId: "orders-export", requestedTargetIds: ["web-1"], required: true,
  accountProfileId: "synthetic", minimumEvidence: "runtime", requiredRealComponentIds: [],
  steps: [{ kind: "navigate", path: "/orders" }, { kind: "click", testId: "export-csv" }],
  assertions: [{ kind: "csv", downloadName: "orders.csv", columns: ["id", "total"], rows: [["1", "10"]] }] };

type Ready = ReadonlyArray<{ kind: "web" | "api"; profileId: string }>;
/** Approved setup proposal and the project policy derived from it, exactly as the setup-proposals route builds them. */
function approvedSetup(snapshot: E2ESourceSnapshot, readyProfiles: Ready, onlyTargetIds?: readonly string[]) {
  const inspection = inspectE2ERepository(snapshot, snapshot.candidate).inspection;
  const proposal = proposeE2ESetup({ inspection, snapshot, expectedCandidate: snapshot.candidate, readyProfiles });
  const policy: E2EPolicy = E2EPolicySchema.parse({ schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [],
    targets: proposal.targets.filter((target) => onlyTargetIds === undefined || onlyTargetIds.includes(target.targetId)), defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
    capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10,
      maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } });
  return { inspection, proposal, policy, setupApproval: { artifactId: "setup", digest: shaCanonical(proposal) } };
}

type PlanInput = { snapshot?: E2ESourceSnapshot; scenario?: E2EScenario; targetId?: string; setupReady?: Ready; planRuntimeProfileId?: string; executable?: boolean;
  registeredRuntimes?: ReturnType<typeof webApiRow>[]; modelRouteRevision?: string; accountRef?: { revision?: number; definitionDigest?: string }; sourceSha?: string };

/** The approved setup, policy and v2 intent for one scenario on one target, as the selection facade and the approval evaluation both take them. */
function planFixture(input: PlanInput) {
  const snapshot = input.snapshot ?? contractSnapshot;
  const scenario = input.scenario ?? csvScenario;
  const setup = approvedSetup(snapshot, input.setupReady ?? [{ kind: "web", profileId: PROFILE }]);
  const target = setup.proposal.targets.find((item) => item.targetId === (input.targetId ?? "web-1"))!;
  const application = setup.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  const refs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths)
    .map((ref) => (input.sourceSha === undefined ? ref : { ...ref, sha256: input.sourceSha }));
  const executable = input.executable ?? true;
  const accountRef = { ...(application.recipe === null ? { applicationId: application.applicationId, profileId: target.accountProfileId, revision: 1, definitionDigest: "2".repeat(64) }
    : deriveE2ESyntheticRuntimeAccountRef({ applicationId: application.applicationId, accountProfileId: target.accountProfileId, recipeDigest: application.recipe.recipeDigest })), ...input.accountRef };
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId, sourcePath: "package.json", sourceSha256: refs.find((ref) => ref.path === "package.json")!.sha256 }],
    scenarios: [scenario], semanticExportDeltas: [],
    applicationRuntimeRefs: executable ? [{ targetId: target.targetId, applicationId: application.applicationId, recipeDigest: application.recipe!.recipeDigest,
      sourceRefs: refs, runtimeProfileId: input.planRuntimeProfileId ?? target.runtimeProfileId, accountProfileId: target.accountProfileId }] : [],
    runtimeAccountRefs: executable ? [accountRef] : [],
    unavailableTargetRefs: executable ? [] : [{ targetId: target.targetId, applicationId: application.applicationId, accountProfileId: target.accountProfileId, sourceRefs: refs }] });
  return { snapshot, scenario, setup, target, application, intent, accountRef, executable,
    policy: { ...setup.policy, baselineScenarioIds: [scenario.scenarioId], modelRouteRevision: input.modelRouteRevision ?? null } };
}

/** Runs the production selection facade for one web scenario against the approved setup. */
function plan(input: PlanInput) {
  const { snapshot, setup, target, intent, accountRef, executable, policy } = planFixture(input);
  const semanticApproval = { artifactId: "feature-plan", digest: "1".repeat(64) };
  return deriveE2EApplicationFeatureExecutionSelection({ intent, snapshot, artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest,
    planDigest: "3".repeat(64), approvedSemanticApproval: semanticApproval, setupProposal: setup.proposal, setupApproval: setup.setupApproval,
    policy, registeredRuntimes: input.registeredRuntimes ?? [webApiRow("web")],
    runtimeAvailability: [{ targetId: target.targetId, profileId: PROFILE, connection: "connected", approval: "approved", qualification: "qualified",
      authorizationRevision: "web-auth-r1" }],
    runtimeAccountRefs: executable ? [accountRef] : [], runtimeCatalogId: "catalog", runtimeBinding: null as never, featureVerifier: null, now: NOW });
}

describe("browser and API scenarios on a qualified runtime profile", () => {
  it("admits a web scenario with a csv assertion as one application group with nothing unavailable", () => {
    const { plan: selected } = plan({});
    expect(selected.criteria).toHaveLength(1);
    expect(selected.criteria[0]?.expectedCaseIds).toHaveLength(1);
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0]).toMatchObject({ mode: "real-runtime", runtimeProfileId: PROFILE, targetIds: ["web-1"] });
    expect(selected.groups[0]?.expectedCases[0]?.upstreamTestId).toMatch(/^\.agentx\/e2e\/generated-application\.test\.ts::case-/);
    expect(selected.unavailableCriteria).toEqual([]);
    expect(selected.effectiveTargets).toMatchObject([{ targetId: "web-1", runtimeProfileId: PROFILE }]);
  });

  it("keeps the same scenario unavailable while the target is still on the phase-unavailable placeholder", () => {
    const { plan: selected } = plan({ setupReady: [], executable: false });
    expect(selected.groups).toEqual([]);
    expect(selected.unavailableCriteria).toHaveLength(1);
    expect(selected.criteria[0]?.expectedCaseIds).toEqual([]);
  });

  it("keeps an agent step unavailable until M1.4", () => {
    const agent: E2EScenario = { ...csvScenario, scenarioId: "agent-orders",
      steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] };
    const { plan: selected } = plan({ scenario: agent, modelRouteRevision: "route-v1" });
    expect(selected.groups).toEqual([]);
    expect(selected.unavailableCriteria).toEqual([{ criterionId: selected.criteria[0]!.criterionId, reason: "agent-steps-arrive-in-m1.4" }]);
  });

  it("admits an API scenario with a status and a json assertion on the READY api row", () => {
    const apiScenario: E2EScenario = { ...csvScenario, scenarioId: "list-orders", requirementId: "orders-api", requestedTargetIds: ["api-1"],
      steps: [{ kind: "request", requestId: "orders", path: "/api/orders", method: "GET", body: {} }],
      assertions: [{ kind: "http-status", path: "/api/orders", method: "GET", equals: 200 }, { kind: "json", responseId: "orders", schemaRef: "orders-list/v1", equals: { orders: [] } }] };
    const { plan: selected } = plan({ snapshot: apiSnapshot, targetId: "api-1", scenario: apiScenario, setupReady: [{ kind: "api", profileId: PROFILE }],
      registeredRuntimes: [webApiRow("web"), webApiRow("api")] });
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0]).toMatchObject({ mode: "real-runtime", runtimeProfileId: PROFILE, targetIds: ["api-1"] });
    expect(selected.unavailableCriteria).toEqual([]);
    // The web row alone cannot serve an API target.
    expect(plan({ snapshot: apiSnapshot, targetId: "api-1", scenario: apiScenario, setupReady: [{ kind: "api", profileId: PROFILE }],
      registeredRuntimes: [webApiRow("web")] }).plan.groups).toEqual([]);
  });

  it("matches the registered runtime by profile and target kind, since every profile has a web row and an api row", () => {
    const { plan: selected } = plan({ registeredRuntimes: [webApiRow("api"), webApiRow("web")] });
    expect(selected.groups).toHaveLength(1);
    expect(selected.unavailableCriteria).toEqual([]);
    const apiOnly = plan({ registeredRuntimes: [webApiRow("api")] }).plan;
    expect(apiOnly.groups).toEqual([]);
    expect(apiOnly.unavailableCriteria).toHaveLength(1);
  });

  it("plans a target with only an inferred launch recipe as unavailable until the project declares a contract", () => {
    const executable = plan({ snapshot: inferredSnapshot }).plan;
    expect(executable.groups).toEqual([]);
    expect(executable.unavailableCriteria).toEqual([{ criterionId: executable.criteria[0]!.criterionId, reason: "needs-project-contract" }]);
    const declared = plan({ snapshot: inferredSnapshot, executable: false }).plan;
    expect(declared.groups).toEqual([]);
    expect(declared.unavailableCriteria).toEqual([{ criterionId: declared.criteria[0]!.criterionId, reason: "needs-project-contract" }]);
  });

  it("never makes a target approved on the placeholder profile executable by naming the qualified profile in the plan", () => {
    expect(() => plan({ setupReady: [], planRuntimeProfileId: PROFILE })).toThrow(/runtime profile/i);
    // The same refusal holds in selection itself, with a binding that was derived while the target was approved on the qualified profile.
    const approved = plan({});
    const setup = approvedSetup(contractSnapshot, []);
    const input = { ...approved.selectionInput, policy: { ...approved.selectionInput.policy, targets: setup.proposal.targets },
      setupProposal: setup.proposal, setupApproval: setup.setupApproval };
    expect(() => selectE2EApplicationExecutionPlan(input)).toThrow(/runtime profile/i);
  });

  it("refuses a plan whose runtime profile is not the one the approved target carries", () => {
    expect(() => plan({ planRuntimeProfileId: "foreign-runtime-profile" })).toThrow(/runtime profile/i);
  });
});

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const APPROVED_ARTIFACT = { id: "feature-plan", sha256: "1".repeat(64) };
const APPROVED_REF = { artifactId: APPROVED_ARTIFACT.id, digest: APPROVED_ARTIFACT.sha256 };

/** The approval evaluation of the same fixture the selection facade tests use, with the rows the broker would have admitted. */
function evaluate(input: PlanInput & { runtimeBinding?: typeof binding; artifact?: typeof APPROVED_ARTIFACT; policyBaselineIds?: string[]; setupSnapshot?: E2ESourceSnapshot;
  mutateIntent?: (intent: E2EApplicationPlanIntent, fixture: ReturnType<typeof planFixture>) => unknown; mutatePolicy?: (policy: ReturnType<typeof planFixture>["policy"]) => ReturnType<typeof planFixture>["policy"] }) {
  const fx = planFixture(input);
  const policy = { ...fx.policy, baselineScenarioIds: input.policyBaselineIds ?? fx.policy.baselineScenarioIds };
  return evaluateApplicationPlanApproval({ intent: input.mutateIntent === undefined ? fx.intent : E2EApplicationPlanIntentSchema.parse(input.mutateIntent(fx.intent, fx)), taskId: TASK_ID, artifact: input.artifact ?? APPROVED_ARTIFACT,
    snapshot: input.setupSnapshot ?? fx.snapshot, setupProposal: fx.setup.proposal, setupApproval: fx.setup.setupApproval,
    policy: input.mutatePolicy === undefined ? policy : input.mutatePolicy(policy),
    registeredRuntimes: input.registeredRuntimes ?? [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: input.runtimeBinding ?? binding, now: NOW });
}
const refusal = (result: ReturnType<typeof evaluate>) => (result.ok ? "approved" : result.reason);

describe("approving a plan that carries an application intent", () => {
  it("derives the selection against the approved setup and the READY rows, and records what 2.3 and 2.4 read", () => {
    const fx = planFixture({});
    const result = evaluate({});
    expect(result.ok, refusal(result)).toBe(true);
    if (!result.ok) return;
    const record = result.selection;
    expect(record).toMatchObject({ schemaVersion: "e2e-application-selection/v1", semanticApproval: APPROVED_REF, setupApproval: fx.setup.setupApproval,
      executableTargetIds: ["web-1"], unavailableCriteria: [], evaluatedAt: new Date(NOW).toISOString() });
    expect(record.intentDigest).toBe(shaCanonical(fx.intent));
    for (const field of ["planDigest", "applicationApprovalBindingDigest", "applicationExecutionPlanDigest", "applicationBundleDigest"] as const) expect(record[field]).toMatch(/^[a-f0-9]{64}$/);
    expect(record.runtimeRows).toEqual([{ kind: "web", profileId: PROFILE, runtimeCatalogId: "catalog", catalogRevision: 3, generation: 4,
      bindingDigest: shaCanonical(binding), capabilityDigest: webApiRow("web").capabilityDigest, expiresAt: webApiRow("web").expiresAt }]);
    // The same approval is the same record, and a different artifact is a different binding.
    expect(evaluate({})).toEqual(result);
    const other = evaluate({ artifact: { id: "feature-plan", sha256: "4".repeat(64) } });
    expect(other.ok && other.selection.planDigest).not.toBe(record.planDigest);
  });

  it("approves an intent that lists its target as unavailable, recording each criterion that will wait", () => {
    const result = evaluate({ executable: false, setupReady: [] });
    expect(result.ok, refusal(result)).toBe(true);
    if (!result.ok) return;
    expect(result.selection).toMatchObject({ executableTargetIds: [], applicationApprovalBindingDigest: null, runtimeRows: [] });
    expect(result.selection.unavailableCriteria).toHaveLength(1);
    expect(result.selection.unavailableCriteria[0]).toMatchObject({ reason: "application runtime assignment is explicitly unavailable" });
    expect(result.selection.unavailableCriteria[0]!.criterionId).toMatch(/^criterion-/);
  });

  describe("refuses, never dropping a scenario and never falling back to portable", () => {
    const cases: Array<[string, Parameters<typeof evaluate>[0], RegExp]> = [
      ["the runtime row is missing", { registeredRuntimes: [] }, /web runtime.*READY/i],
      ["only the other kind's row is READY", { registeredRuntimes: [webApiRow("api")] }, /web runtime.*READY/i],
      ["the row is bound to another runtime binding", { runtimeBinding: { ...binding, launchTemplateId: "lt-fedcba9876543210" } }, /another runtime binding/i],
      ["the row has expired", { registeredRuntimes: [webApiRow("web", { qualifiedAt: new Date(NOW - 7_200_000).toISOString(), expiresAt: new Date(NOW - 1_000).toISOString() })] }, /not READY/i],
      ["the row is parked", { registeredRuntimes: [webApiRow("web", { state: "UNAVAILABLE" })] }, /not READY/i],
      ["the descriptor does not support a step the scenario uses", { registeredRuntimes: [webApiRow("web", {}, (value) => ({ ...value,
        supportedSteps: value.supportedSteps.filter((step) => step !== "click") }))] }, /not ready|unsupported|capabilit/i],
      ["the scenario has an agent step", { modelRouteRevision: "route-v1", scenario: { ...csvScenario, scenarioId: "agent-orders",
        steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] } }, /agent-steps-arrive-in-m1\.4/],
      ["the launch recipe is only inferred, without a project contract", { snapshot: inferredSnapshot }, /needs-project-contract/],
      ["the target is approved on the phase-unavailable profile but the plan names the qualified one", { setupReady: [], planRuntimeProfileId: PROFILE }, /runtime profile/i],
      ["the plan names a runtime profile the target does not carry", { planRuntimeProfileId: "foreign-runtime-profile" }, /runtime profile/i],
      ["the account reference is not the synthetic account identity", { accountRef: { definitionDigest: "2".repeat(64) } }, /account/i],
      ["a source reference does not match the approved snapshot", { sourceSha: "9".repeat(64) }, /source/i],
      ["the plan omits a baseline scenario the policy pins", { policyBaselineIds: ["pinned-baseline"] }, /baseline/i],
    ];
    for (const [name, input, expected] of cases) {
      it(`when ${name}`, () => {
        const result = evaluate(input);
        expect(result.ok).toBe(false);
        const reason = refusal(result);
        expect(reason).toMatch(expected);
        expect(reason.length).toBeLessThanOrEqual(600);
        expect(reason).not.toMatch(/\p{Cc}/u);
      });
    }

    it("when the application's metadata changed since the setup was approved", () => {
      const changed = JSON.stringify({ ...(JSON.parse(ordersContractManifest) as Record<string, unknown>), description: "changed after setup approval" });
      const result = evaluate({ setupSnapshot: snapshotOf({ "package.json": changed }) });
      expect(result.ok).toBe(false);
      expect(refusal(result)).toMatch(/source|metadata|setup/i);
    });

    it("lists every executable criterion that is not executable, by scenario and target", () => {
      const reason = refusal(evaluate({ registeredRuntimes: [webApiRow("web", {}, (value) => ({ ...value, supportedAssertions: value.supportedAssertions.filter((kind) => kind !== "csv") }))] }));
      expect(reason).toContain("export-csv");
      expect(reason).toContain("web-1");
    });
  });
});

// ---- Fix round 1 ----

const mixedPackage = { ...(JSON.parse(ordersContractManifest) as Record<string, unknown>), exports: { ".": "./src/index.mjs" } };
/** The orders contract app that also exports a portable module with one callable, so discovery offers a portable operation beside the web target. */
const mixedSnapshot = snapshotOf({ "package.json": JSON.stringify(mixedPackage), "src/index.mjs": "export function priceRows(input) { return { rows: input.rows }; }\n" });
const portableScenario = (operationId: string): E2EScenario => ({ scenarioId: "render-orders", requirementId: "render-orders", requestedTargetIds: ["web-1"], required: true,
  accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [],
  steps: [{ kind: "invoke-contract", operationId, input: { mode: "success" } }], assertions: [{ kind: "state", probeId: "result", equals: "Sample order", pollTimeoutMs: 1000 }] });
/** Adds a portable scenario that calls a callable the setup snapshot does not export yet (the prompt lets the planner propose it as future code). */
const withProposedCallable = (intent: E2EApplicationPlanIntent, fixture: ReturnType<typeof planFixture>) => {
  const operationId = portableOperationId(".", fixture.application.applicationId);
  return { ...intent, scenarios: [...intent.scenarios, portableScenario(operationId)],
    portableOperationRefs: [{ operationId, applicationId: fixture.application.applicationId, requestedTargetIds: ["web-1"], packageExportSubpath: ".",
      moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named", exportName: "renderOrders" } }] };
};

describe("a mixed v2 intent (Ruling AV): application scenarios are derived, portable ones follow the v1 portable rules", () => {
  it("approves a plan that also proposes a new callable, which the v1 approval path accepts without source binding", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable });
    expect(result.ok, refusal(result)).toBe(true);
  });

  it("derives the selection and binding from the application scenarios only, so portable criteria never wait in unavailableCriteria", () => {
    const mixed = evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable });
    const alone = evaluate({ snapshot: mixedSnapshot });
    expect(mixed.ok && alone.ok).toBe(true);
    if (!mixed.ok || !alone.ok) return;
    expect(mixed.selection.unavailableCriteria).toEqual([]);
    expect(mixed.selection.executableTargetIds).toEqual(["web-1"]);
    // The binding and plan are those of the application part, whatever portable scenarios sit beside it ...
    expect(mixed.selection.applicationApprovalBindingDigest).toBe(alone.selection.applicationApprovalBindingDigest);
    expect(mixed.selection.applicationExecutionPlanDigest).toBe(alone.selection.applicationExecutionPlanDigest);
    // ... while the intent digest identifies the whole canonical intent.
    expect(mixed.selection.intentDigest).not.toBe(alone.selection.intentDigest);
    const fixture = planFixture({ snapshot: mixedSnapshot });
    expect(mixed.selection.intentDigest).toBe(shaCanonical(E2EApplicationPlanIntentSchema.parse(withProposedCallable(fixture.intent, fixture))));
  });

  it("accepts a pinned baseline scenario that is a portable one", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable, policyBaselineIds: ["export-csv", "render-orders"] });
    expect(result.ok, refusal(result)).toBe(true);
  });

  it("still refuses a pinned baseline scenario the plan omits entirely", () => {
    expect(refusal(evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable, policyBaselineIds: ["export-csv", "pinned-elsewhere"] }))).toMatch(/baseline.*pinned-elsewhere/i);
  });

  it("refuses a version 2 intent with no application scenario, since a portable-only plan is a version 1 plan", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: (intent, fixture) => ({ ...withProposedCallable(intent, fixture),
      scenarios: [portableScenario(portableOperationId(".", fixture.application.applicationId))], applicationRuntimeRefs: [], runtimeAccountRefs: [], unavailableTargetRefs: [] }) });
    expect(refusal(result)).toMatch(/no application scenario.*schemaVersion 1/i);
  });
});

describe("a scenario that starts with a portable step but continues with application steps (fix round 2)", () => {
  it("is refused as mixing portable and application steps, not stripped as portable", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: (intent, fixture) => {
      const operationId = portableOperationId(".", fixture.application.applicationId);
      const mixedScenario = { ...portableScenario(operationId), scenarioId: "render-then-click", steps: [...portableScenario(operationId).steps, { kind: "click" as const, testId: "export-csv" }] };
      const proposed = withProposedCallable(intent, fixture);
      return { ...proposed, scenarios: [...intent.scenarios, mixedScenario] };
    } });
    expect(result.ok).toBe(false);
    expect(refusal(result)).toMatch(/cannot mix portable and application steps/);
  });
});

describe("approval refusals the first round left untested", () => {
  it("refuses a target that is not in the pinned policy", () => {
    expect(refusal(evaluate({ mutatePolicy: (policy) => ({ ...policy, targets: policy.targets.filter((item) => item.targetId !== "web-1") }) })))
      .toMatch(/target web-1 is not in the pinned project policy/);
  });

  it("refuses a target that is not a web or API target", () => {
    expect(refusal(evaluate({ mutatePolicy: (policy) => ({ ...policy, targets: policy.targets.map((item) => item.targetId === "web-1"
      ? { targetId: "web-1", applicationId: item.applicationId, runtimeProfileId: item.runtimeProfileId, accountProfileId: item.accountProfileId,
        kind: "mobile" as const, os: "android" as const, appId: "com.example.orders", deviceProfileId: "pixel" } : item) }) })))
      .toMatch(/target web-1 is a mobile target; only web and API targets/);
  });

  it("refuses a target approved on a profile that is not qualified even when the plan names that same profile", () => {
    expect(refusal(evaluate({ setupReady: [], planRuntimeProfileId: "web-phase-unavailable" })))
      .toMatch(/approved on runtime profile web-phase-unavailable, which cannot run application scenarios/);
  });

  it("names the specific refusal when the descriptor lacks a step, not the row-not-READY one", () => {
    const reason = refusal(evaluate({ registeredRuntimes: [webApiRow("web", {}, (value) => ({ ...value, supportedSteps: value.supportedSteps.filter((step) => step !== "click") }))] }));
    expect(reason).toMatch(/scenario export-csv on target web-1: application runtime is not ready: /);
    expect(reason).not.toMatch(/is not READY now/);
    expect(reason).not.toMatch(/READY for this project's runtime binding/);
  });
});

describe("the synthetic account is authorized only by the approved project contract (Ruling AT)", () => {
  const withProfileScope = (scope: "synthetic-test" | "external-test") => {
    const manifest = JSON.parse(ordersContractManifest) as { agentx: { e2e: { accountProfiles: Array<{ profileId: string; scope: string }> } } };
    manifest.agentx.e2e.accountProfiles = manifest.agentx.e2e.accountProfiles.map((profile) => profile.profileId === "synthetic" ? { ...profile, scope } : profile);
    return snapshotOf({ "package.json": JSON.stringify(manifest) });
  };

  it("approves when the contract declares the account as a synthetic test account", () => {
    expect(evaluate({ snapshot: withProfileScope("synthetic-test") }).ok).toBe(true);
  });

  it("refuses a synthetic reference for an account the contract declares as an external account", () => {
    expect(refusal(evaluate({ snapshot: withProfileScope("external-test") })))
      .toMatch(/account profile synthetic.*not declared as a synthetic test account by the application's project contract/);
  });
});

describe("planning context for a qualified web target", () => {
  const ready = [{ kind: "web" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedSteps,
    supportedAssertions: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedAssertions }];
  const contextFor = (snapshot: E2ESourceSnapshot, ...[readyRuntimes]: [typeof ready | undefined] | []) => {
    const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }], ["web-1"]);
    const result = buildFeatureE2EPlanningContext(setup.policy, snapshot, { origin: "approved-setup", preparedCommitSha: null,
      ...(readyRuntimes === undefined ? {} : { readyRuntimes }) });
    if (result.status !== "available") throw new Error(result.reason);
    return result;
  };

  it("takes the runtime profile from the approved target and lists the executable step and assertion kinds", () => {
    const context = contextFor(contractSnapshot, ready);
    expect(context.runtimeRefs).toMatchObject([{ targetId: "web-1", runtimeProfileId: PROFILE }]);
    expect(context.unavailableTargetRefs).toEqual([]);
    expect(context.unavailableReasons).toEqual([]);
    expect(context.executableKinds).toEqual([{ kind: "web", steps: ["navigate", "fill", "click", "choose-file"], assertions: ["text", "visible", "csv"] }]);
    const text = describeFeatureE2EExecutableKinds(context);
    expect(text).toContain("navigate, fill, click, choose-file");
    expect(text).toContain("text, visible, csv");
    const offered = text.split("\n").filter((line) => line.startsWith("- web targets"));
    expect(offered).toHaveLength(1);
    expect(offered[0]).not.toContain("agent");
  });

  it("never offers agent steps, even when a registered descriptor lists them", () => {
    const text = describeFeatureE2EExecutableKinds({ targets: [{ targetId: "web-1", applicationId: "app", kind: "web", accountProfileId: "synthetic" }],
      unavailableTargetRefs: [], executableKinds: [{ kind: "web", steps: ["navigate", "agent", "click"], assertions: ["visible"] }] });
    expect(text).toContain("steps navigate, click;");
    expect(text.split("\n").filter((line) => line.startsWith("- web targets"))[0]).not.toContain("agent");
  });

  it("puts the same target in the unavailable list while its runtime is not READY now", () => {
    const context = contextFor(contractSnapshot);
    expect(context.unavailableTargetRefs).toMatchObject([{ targetId: "web-1" }]);
    expect(context.unavailableReasons).toEqual([{ targetId: "web-1", reason: "runtime-not-ready" }]);
    expect(context.executableKinds).toEqual([]);
    expect(describeFeatureE2EExecutableKinds(context)).toBe("");
  });

  it("marks an inferred-recipe target unavailable with the needs-project-contract reason even when the runtime is READY", () => {
    const context = contextFor(inferredSnapshot, ready);
    expect(context.unavailableTargetRefs).toMatchObject([{ targetId: "web-1" }]);
    expect(context.unavailableReasons).toEqual([{ targetId: "web-1", reason: "needs-project-contract" }]);
    expect(context.executableKinds).toEqual([]);
  });

  it("states the executable kinds in the planner prompt only for an executable target", () => {
    const text = planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: contextFor(contractSnapshot, ready) });
    expect(text).toContain("navigate, fill, click, choose-file");
    expect(text).toContain("text, visible, csv");
    const unavailable = planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: contextFor(contractSnapshot) });
    expect(unavailable).not.toContain("navigate, fill, click, choose-file");
  });

  it("names the api kinds from the registered api descriptor, including the state probe", () => {
    const api = webApiRuntimeCapabilities("api", "a".repeat(64));
    const text = describeFeatureE2EExecutableKinds({ targets: [{ targetId: "api-1", applicationId: "orders-api", kind: "api", accountProfileId: "synthetic" }],
      unavailableTargetRefs: [], executableKinds: [{ kind: "api", steps: [...api.supportedSteps], assertions: [...api.supportedAssertions] }] });
    expect(text).toContain("api targets (api-1): steps request; assertions http-status, json, state.");
  });

  it("keeps the exact pre-2.2 context and prompt for a policy with no target on a qualified profile (Ruling AQ)", () => {
    const setup = approvedSetup(contractSnapshot, [], ["web-1"]);
    const context = buildFeatureE2EPlanningContext(setup.policy, contractSnapshot, { origin: "approved-setup", preparedCommitSha: null,
      readyRuntimes: ready });
    if (context.status !== "available") throw new Error(context.reason);
    expect(context.runtimeRefs?.every((item) => item.runtimeProfileId === "web-phase-unavailable")).toBe(true);
    expect(context.unavailableTargetRefs?.map((item) => item.targetId)).toEqual(["web-1"]);
    expect(Object.keys(context)).not.toContain("unavailableReasons");
    expect(Object.keys(context)).not.toContain("executableKinds");
    // Hashes of the context JSON and of the planner instructions, computed from the code at 8ec3eb02 (before Task 2.2).
    expect(sha(JSON.stringify(context))).toBe("08406287d684d9347d93acf5a2b7f392795721d4451f1042ef6ac4b9ec86067e");
    expect(sha(planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context }))).toBe("17dbd45eb17aaabb817ba1c866c0561db14525f43f6e2ee5663ad266e6afaf2f");
  });
});

// The ordinary feature PLAN, end to end through the broker: an approved setup whose web target was proposed against the READY profile,
// planned against the project's current runtime catalog rows (Ruling AL: web and api rows, matched to the project's runtime binding).
describe("ordinary feature PLAN with an approved qualified web target", () => {
  type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
  type Rows = Record<"web" | "api", Record<string, unknown> | undefined>;
  const SLACK_THREAD = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000099" };
  /** Registers the project against its approved setup and the catalog rows, then starts a task and runs its preparation, up to the planning invocation. */
  async function startPlanning(rows: Rows, afterApproval?: (harness: Harness) => void, viaSlack = false) {
    const snapshot = contractSnapshot;
    const capture = vi.fn(async () => snapshot);
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const projectRow = () => harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")[0]!;
    const projectBinding = projectRow().runtimeBinding as typeof binding;
    for (const kind of ["web", "api"] as const) {
      const row = rows[kind];
      if (row !== undefined) harness.db.set({ ...e2eRegisteredRuntimeKey("catalog", PROFILE, kind), ...row, binding: projectBinding, bindingDigest: shaCanonical(projectBinding) });
    }
    const proposalResponse = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals",
      user: { subject: "admin-subject", admin: true }, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposalResponse.status, JSON.stringify(proposalResponse.body)).toBe(200);
    const proposalRef = String(proposalResponse.body.proposalRef);
    const proposalSha256 = String(proposalResponse.body.proposalSha256);
    const approval = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: { subject: "admin-subject", admin: true },
      body: { projectName: "payments", proposalRef, proposalSha256, decision: "approve" } });
    expect(approval.status, JSON.stringify(approval.body)).toBe(200);
    const definition = projectRow().definition as Record<string, unknown> & { revision: number };
    const registration = await call(harness.handler, { method: "POST", path: "/v1/admin/projects", user: { subject: "admin-subject", admin: true },
      body: { definition: { ...definition, revision: definition.revision + 1, e2e: proposalResponse.body.policy }, runtimeBinding: projectRow().runtimeBinding,
        setupApproval: { proposalRef, proposalSha256, decision: "approve" } } });
    expect(registration.status, JSON.stringify(registration.body)).toBe(201);
    afterApproval?.(harness);
    const instructions = "Add an orders table with an Export CSV button";
    let taskId: string;
    if (viaSlack) {
      const started = await harness.handler({ source: "agentx.slack-ingress", action: "start-workflow", thread: SLACK_THREAD, userId: MAYA.slackUserId,
        instructions, workflowPath: "QUICK", requestId: randomUUID() });
      expect(started.statusCode, started.body).toBe(200);
      taskId = String((JSON.parse(started.body) as { taskId: string }).taskId);
    } else {
      const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions, client: "planning-test", workflow: true, workflowPath: "QUICK" });
      expect(start.status, JSON.stringify(start.body)).toBe(200);
      taskId = String((start.body.task as { taskId: string }).taskId);
    }
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as { workspaceId: string };
    const preparation = harness.db.find((row) => row.pk === `WORKSPACE#${task.workspaceId}` && row.entityType === "OPERATION" && row.kind === "prepare")[0]!;
    await harness.finish(task.workspaceId, String(preparation.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: snapshot.commitSha }] } });
    const planning = harness.db.find((row) => row.pk === `WORKSPACE#${task.workspaceId}` && row.entityType === "OPERATION" && row.workflowMode === "PLAN")[0]!;
    const payload = (harness.db.find((row) => row.entityType === "OUTBOX" && row.operationId === planning.id)[0]!.invocation as { payload: { prompt: string; workflowE2EPlanVersion?: number } }).payload;
    return { harness, taskId, workspaceId: task.workspaceId, planningId: String(planning.id), payload, snapshot, projectBinding, projectRow, capture, proposalRef,
      policy: E2EPolicySchema.parse(proposalResponse.body.policy) };
  }
  const plannedInvocation = async (rows: Rows, afterApproval?: (harness: Harness) => void) => (await startPlanning(rows, afterApproval)).payload;
  const plannedPrompt = async (...args: Parameters<typeof plannedInvocation>) => (await plannedInvocation(...args)).prompt;

  it("tells the planner the executable kinds and asks for the v2 application intent when the project's current web row is READY", async () => {
    const { prompt, workflowE2EPlanVersion } = await plannedInvocation({ web: webApiRow("web"), api: webApiRow("api") });
    expect(workflowE2EPlanVersion).toBe(2);
    expect(prompt).toContain("e2e?: WorkflowFeatureE2EIntent;");
    expect(prompt).toContain("Application E2E plan guidance (schemaVersion 2):");
    expect(prompt).toContain('"runtimeAccountRefs":[{"applicationId":');
    expect(prompt).toContain(`"runtimeProfileId":"${PROFILE}"`);
    expect(prompt).toContain("navigate, fill, click, choose-file");
    expect(prompt).toContain("text, visible, csv");
    expect(prompt).toContain('"unavailableReasons":[]');
  });

  it("lists the web target as unavailable when its row is gone at planning time", async () => {
    // The proposal needs a READY row; the row then disappears before the task plans, so planning re-checks and finds it not ready.
    const key = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
    const { prompt, workflowE2EPlanVersion } = await plannedInvocation({ web: webApiRow("web"), api: undefined }, (harness) => harness.db.delete(key.pk, key.sk));
    expect(workflowE2EPlanVersion).toBeUndefined();
    expect(prompt).not.toContain("Application E2E plan guidance");
    expect(prompt).toContain("e2e?: E2EFeaturePlanIntent;");
    expect(prompt).toContain('{"targetId":"web-1","reason":"runtime-not-ready"}');
    expect(prompt).not.toContain("navigate, fill, click, choose-file");
  });

  it("does not count a row bound to another runtime binding as READY", async () => {
    const key = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");
    const prompt = await plannedPrompt({ web: webApiRow("web"), api: undefined }, (harness) => {
      const row = harness.db.get(key.pk, key.sk)!;
      const other = { ...binding, launchTemplateId: "lt-fedcba9876543210" };
      harness.db.set({ ...row, binding: other, bindingDigest: shaCanonical(other) });
    });
    expect(prompt).toContain('"reason":"runtime-not-ready"');
    expect(prompt).not.toContain("navigate, fill, click, choose-file");
  });

  // ---- Plan APPROVE of a plan that carries the v2 application intent (Task 2.2b) ----

  const READY_WEB = { kind: "web" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedSteps,
    supportedAssertions: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedAssertions };
  const webKey = e2eRegisteredRuntimeKey("catalog", PROFILE, "web");

  /** A planning task whose planner has answered with the v2 intent a planner would build from the prompt's own context. */
  async function plannedWithApplicationIntent(options: { viaSlack?: boolean; afterApproval?: (harness: Harness) => void; scenarios?: (target: { targetId: string; accountProfileId: string }) => E2EScenario[] } = {}) {
    const started = await startPlanning({ web: webApiRow("web"), api: webApiRow("api") }, options.afterApproval, options.viaSlack === true);
    const { harness, workspaceId, planningId, snapshot } = started;
    const { policy } = started;
    const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [READY_WEB] });
    if (context.status !== "available") throw new Error(context.reason);
    const target = context.targets.find((item) => item.targetId === "web-1")!;
    const forTarget = <T extends { applicationId: string }>(refs: readonly T[]) => refs.filter((ref) => ref.applicationId === target.applicationId);
    const scenarios = options.scenarios?.(target) ?? [{ ...csvScenario, requestedTargetIds: [target.targetId], accountProfileId: target.accountProfileId }];
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: forTarget(context.accountContextRefs).filter((ref) => ref.profileId === target.accountProfileId), scenarios, semanticExportDeltas: [],
      applicationRuntimeRefs: context.runtimeRefs!.filter((ref) => ref.targetId === target.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! })),
      runtimeAccountRefs: forTarget(context.runtimeAccountRefs!).filter((ref) => ref.profileId === target.accountProfileId), unavailableTargetRefs: [] });
    const answer = planAnswer(planDocument({ title: "Export CSV", claims: [{ id: "1", text: "Orders can be exported as CSV." }], e2e: intent }));
    await harness.artifact(workspaceId, planningId, "plan.md", answer);
    await harness.finish(workspaceId, planningId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    return { ...started, intent, target };
  }
  type Planned = Awaited<ReturnType<typeof plannedWithApplicationIntent>>;

  const workflowOf = (planned: Planned) => (planned.harness.db.get(`DEVTASK#${planned.taskId}`, "META") as { workflow: { revision: number; stage: string; state: string; candidate?: unknown;
    artifacts: Array<{ id: string; sha256: string; objectKey: string }>; e2e?: Record<string, unknown> } }).workflow;
  const operationIds = (planned: Planned) => planned.harness.db.find((row) => row.pk === `WORKSPACE#${planned.workspaceId}` && row.entityType === "OPERATION").map((row) => row.id);
  const decide = (planned: Planned, decision: "APPROVE" | "REQUEST_CHANGES") => {
    const workflow = workflowOf(planned);
    return planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision, decision,
      reason: decision === "APPROVE" ? "Approve the exact application intent" : "Correct the application intent", artifactDigest: workflow.artifacts.at(-1)!.sha256 });
  };
  const errorOf = (response: { body: Record<string, unknown> }) => response.body.error as { code?: string; message?: string };
  /** The approval was refused: the task is exactly as it was (same revision, artifact, operations), and the owner can still request changes. */
  async function expectRefusedThenRequestChanges(planned: Planned, code: RegExp, message: RegExp) {
    const before = workflowOf(planned);
    const operationsBefore = operationIds(planned);
    const bytes = planned.harness.s3.objects.get(before.artifacts.at(-1)!.objectKey);
    const refused = await decide(planned, "APPROVE");
    expect(refused.status, JSON.stringify(refused.body)).toBeGreaterThanOrEqual(400);
    expect(errorOf(refused).code).toMatch(code);
    expect(errorOf(refused).message).toMatch(message);
    const after = workflowOf(planned);
    expect(after).toEqual(before);
    expect(after.e2e).toBeUndefined();
    expect(operationIds(planned)).toEqual(operationsBefore);
    expect(planned.harness.s3.objects.get(before.artifacts.at(-1)!.objectKey)).toBe(bytes);
    const requested = await decide(planned, "REQUEST_CHANGES");
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(operationIds(planned).length).toBeGreaterThan(operationsBefore.length);
  }

  it("records the derived selection beside the approved plan in the workflow's e2e progress", async () => {
    const planned = await plannedWithApplicationIntent();
    const artifact = workflowOf(planned).artifacts.at(-1)!;
    expect(planned.harness.s3.objects.get(artifact.objectKey)).toContain('"schemaVersion":2');
    const approved = await decide(planned, "APPROVE");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const workflow = workflowOf(planned);
    expect(workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", e2e: { required: true, contractDigest: artifact.sha256 } });
    const record = E2EApplicationSelectionRecordSchema.parse(workflow.e2e!.applicationSelection);
    expect(record).toMatchObject({ schemaVersion: "e2e-application-selection/v1", executableTargetIds: [planned.target.targetId], unavailableCriteria: [],
      semanticApproval: { artifactId: artifact.id, digest: artifact.sha256 } });
    expect(record.intentDigest).toBe(shaCanonical(planned.intent));
    expect(record.applicationApprovalBindingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(record.runtimeRows).toMatchObject([{ kind: "web", profileId: PROFILE, runtimeCatalogId: "catalog", catalogRevision: 3, generation: 4,
      bindingDigest: shaCanonical(planned.projectBinding) }]);
    // The rest of the progress is what a portable approval records: the same digests, derived the same way.
    for (const field of ["policyDigest", "bundleDigest", "executionPlanDigest"]) expect(workflow.e2e![field]).toMatch(/^[a-f0-9]{64}$/);
    expect(workflow.e2e).toMatchObject({ currentGroupRunIds: [], resultRefs: [] });
  });

  it("approves from Slack the same way", async () => {
    const planned = await plannedWithApplicationIntent({ viaSlack: true });
    const workflow = workflowOf(planned);
    const answer = await planned.harness.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId: planned.taskId, userId: MAYA.slackUserId, thread: SLACK_THREAD,
      requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision: "APPROVE", reason: "Approve", selectedOptionalCheckIds: [] });
    expect(answer.statusCode, answer.body).toBe(200);
    expect(JSON.parse(answer.body)).not.toMatchObject({ refused: true });
    expect(workflowOf(planned)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(E2EApplicationSelectionRecordSchema.safeParse(workflowOf(planned).e2e?.applicationSelection).success).toBe(true);
  });

  it("approves against the rows READY now, and the pinned project revision's binding rather than a later revision's", async () => {
    const planned = await plannedWithApplicationIntent();
    const pinned = planned.harness.db.find((row) => row.entityType === "PROJECT" && (row.definition as { name?: string } | undefined)?.name === "payments")
      .sort((left, right) => Number((right.definition as { revision: number }).revision) - Number((left.definition as { revision: number }).revision))[0]!;
    const definition = pinned.definition as { revision: number };
    const otherBinding = { ...planned.projectBinding, launchTemplateId: "lt-fedcba9876543210" };
    // A newer revision of the project is bound elsewhere; the task is pinned to the revision it started on.
    planned.harness.db.set({ ...pinned, sk: `REV#${String(definition.revision + 1).padStart(12, "0")}`, definition: { ...definition, revision: definition.revision + 1 }, runtimeBinding: otherBinding });
    const approved = await decide(planned, "APPROVE");
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(workflowOf(planned).e2e?.applicationSelection).toMatchObject({ runtimeRows: [{ bindingDigest: shaCanonical(planned.projectBinding) }] });
  });

  describe("refuses, leaving the plan waiting so the owner can request changes", () => {
    it("when the web runtime row is gone at approval time, although it was READY when the plan was written", async () => {
      const planned = await plannedWithApplicationIntent();
      planned.harness.db.delete(webKey.pk, webKey.sk);
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /cannot be approved.*READY/i);
    });

    it("when the row is bound to another runtime binding", async () => {
      const planned = await plannedWithApplicationIntent();
      const row = planned.harness.db.get(webKey.pk, webKey.sk)!;
      const other = { ...planned.projectBinding, launchTemplateId: "lt-fedcba9876543210" };
      planned.harness.db.set({ ...row, binding: other, bindingDigest: shaCanonical(other) });
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /cannot be approved.*READY/i);
    });

    it("when the row has expired", async () => {
      const planned = await plannedWithApplicationIntent();
      const row = planned.harness.db.get(webKey.pk, webKey.sk)!;
      planned.harness.db.set({ ...row, qualifiedAt: new Date(Date.now() - 7_200_000).toISOString(), expiresAt: new Date(Date.now() - 1_000).toISOString() });
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /cannot be approved.*READY/i);
    });

    it("when a scenario uses an agent step", async () => {
      const planned = await plannedWithApplicationIntent({ scenarios: (target) => [{ ...csvScenario, scenarioId: "agent-orders", requestedTargetIds: [target.targetId],
        accountProfileId: target.accountProfileId, steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] }] });
      // The pinned policy has no model route, so the agent step is refused outright (with a route it waits as agent-steps-arrive-in-m1.4; see the evaluation cases).
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /agent steps require an approved model route/i);
    });

    it("when the plan's account reference is not the synthetic account identity", async () => {
      const planned = await plannedWithApplicationIntent();
      const workflow = workflowOf(planned);
      const artifact = workflow.artifacts.at(-1)!;
      const text = planned.harness.s3.objects.get(artifact.objectKey)!;
      expect(text).toContain(planned.intent.runtimeAccountRefs[0]!.definitionDigest);
      // The stored artifact is content-addressed; a plan with another digest is a different artifact, so submit it as the planner's next answer instead.
      const forged = { ...planned.intent, runtimeAccountRefs: [{ ...planned.intent.runtimeAccountRefs[0]!, definitionDigest: "2".repeat(64) }] };
      await planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision, decision: "REQUEST_CHANGES",
        reason: "Resubmit", artifactDigest: artifact.sha256 });
      const replanning = planned.harness.db.find((row) => row.pk === `WORKSPACE#${planned.workspaceId}` && row.entityType === "OPERATION" && row.workflowMode === "PLAN").at(-1)!;
      await planned.harness.artifact(planned.workspaceId, String(replanning.id), "plan.md",
        planAnswer(planDocument({ title: "Export CSV", claims: [{ id: "1", text: "Orders can be exported as CSV." }], e2e: forged })));
      await planned.harness.finish(planned.workspaceId, String(replanning.id), "SUCCEEDED", { result: { workflowMode: "PLAN" } });
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /synthetic account identity/i);
    });

    it("when the approved setup proposal can no longer be verified, saying it could not check rather than approving", async () => {
      const planned = await plannedWithApplicationIntent();
      planned.harness.s3.objects.set(planned.proposalRef, `${planned.harness.s3.objects.get(planned.proposalRef)!} `);
      await expectRefusedThenRequestChanges(planned, /RUNTIME_UNAVAILABLE/, /could not be checked.*nothing was approved/i);
    });

    it("when the runtime row cannot be read, saying it could not check rather than treating the runtime as unqualified", async () => {
      const planned = await plannedWithApplicationIntent();
      const send = planned.harness.db.send.bind(planned.harness.db);
      planned.harness.db.send = async (command) => {
        const input = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input;
        if (command.constructor.name === "GetCommand" && input?.Key?.pk === webKey.pk && input.Key.sk === webKey.sk) throw new Error("throttled");
        return send(command);
      };
      try {
        await expectRefusedThenRequestChanges(planned, /RUNTIME_UNAVAILABLE/, /runtime catalog could not be read.*nothing was approved/i);
      } finally { planned.harness.db.send = send; }
    });

    it("when the row changes between being read and the approval committing", async () => {
      const planned = await plannedWithApplicationIntent();
      const saved = planned.harness.db.get(webKey.pk, webKey.sk)!;
      const before = workflowOf(planned);
      const operationsBefore = operationIds(planned);
      const send = planned.harness.db.send.bind(planned.harness.db);
      let changed = false;
      planned.harness.db.send = async (command) => {
        const items = (command as { input?: { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> } }).input?.TransactItems;
        if (!changed && command.constructor.name === "TransactWriteCommand" && items?.some((item) => item.ConditionCheck?.Key?.pk === webKey.pk && item.ConditionCheck.Key.sk === webKey.sk)) {
          changed = true;
          planned.harness.db.set({ ...saved, generation: 5 });
        }
        return send(command);
      };
      try {
        const raced = await decide(planned, "APPROVE");
        expect(changed).toBe(true);
        expect(raced.status).not.toBe(200);
        expect(workflowOf(planned)).toEqual(before);
        expect(operationIds(planned)).toEqual(operationsBefore);
      } finally { planned.harness.db.send = send; }
    });
  });
  // ---- Fix round 1 ----

  it("never approves a v2 plan on a broker that has no application plan validation installed", async () => {
    const planned = await plannedWithApplicationIntent();
    const input = planned.harness.brokerInput as unknown as { documentClient: never; tableName: string; developer: never };
    const caller = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: MAYA.provider, name: MAYA.name };
    const bare = developerTaskRouteDependencies({ documentClient: input.documentClient, tableName: input.tableName, developer: input.developer, now: Date.now,
      tasks: planned.harness.actions }, caller);
    const before = workflowOf(planned);
    const operationsBefore = operationIds(planned);
    await expect(decideTaskWorkflow(bare, caller, planned.taskId, { requestId: randomUUID(), expectedRevision: before.revision, decision: "APPROVE", reason: "Approve",
      artifactDigest: before.artifacts.at(-1)!.sha256 })).rejects.toThrow(/cannot be approved here.*not installed/);
    expect(workflowOf(planned)).toEqual(before);
    expect(operationIds(planned)).toEqual(operationsBefore);
  });

  it("refuses to store a v2 plan uploaded by a planning run that did not negotiate workflowE2EPlanVersion 2 (Ruling AW)", async () => {
    // The row is gone at planning time, so the planner is sent the portable prompt and no plan version.
    const started = await startPlanning({ web: webApiRow("web"), api: undefined }, (harness) => harness.db.delete(webKey.pk, webKey.sk));
    expect(started.payload.workflowE2EPlanVersion).toBeUndefined();
    const { harness, workspaceId, planningId, snapshot, policy } = started;
    const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [] });
    if (context.status !== "available") throw new Error(context.reason);
    const target = context.targets.find((item) => item.targetId === "web-1")!;
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: context.accountContextRefs.filter((ref) => ref.applicationId === target.applicationId && ref.profileId === target.accountProfileId),
      scenarios: [{ ...csvScenario, requestedTargetIds: [target.targetId], accountProfileId: target.accountProfileId }], semanticExportDeltas: [],
      applicationRuntimeRefs: [], runtimeAccountRefs: [], unavailableTargetRefs: context.unavailableTargetRefs!.filter((ref) => ref.targetId === target.targetId) });
    await harness.artifact(workspaceId, planningId, "plan.md", planAnswer(planDocument({ title: "Export CSV", claims: [{ id: "1", text: "Orders can be exported." }], e2e: intent })));
    await harness.finish(workspaceId, planningId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const task = harness.db.get(`DEVTASK#${started.taskId}`, "META") as { workflow: { state: string; blockReason?: string; artifacts: unknown[] }; planUnreadable?: { errors: string[] } };
    expect(task.workflow).toMatchObject({ state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.planUnreadable });
    expect(task.workflow.artifacts).toEqual([]);
    expect(task.planUnreadable?.errors.join(" ")).toMatch(/schemaVersion 2 was not offered for this planning step/);
  });

  it("fails closed at portable dispatch and verification: a v2-approved plan has no portable intent to run", async () => {
    const planned = await plannedWithApplicationIntent();
    expect((await decide(planned, "APPROVE")).status).toBe(200);
    const artifact = workflowOf(planned).artifacts.at(-1)!;
    const approved = readCanonicalPlan(planned.harness.s3.objects.get(artifact.objectKey)!);
    expect(approved?.e2e?.schemaVersion).toBe(2);
    // Both portable paths (startWorkflowE2EChecksDispatch and verifyWorkflowE2EEvidence) read the canonical intent through this one guard.
    expect(portableFeatureIntentOf(approved!)).toEqual({ ok: false, reason: "application-e2e-intent-needs-application-verification" });
    expect(portableFeatureIntentOf({ ...approved!, e2e: undefined })).toEqual({ ok: false, reason: "canonical-e2e-intent-missing" });
    const v1 = { schemaVersion: 1 as const, requestedTargetIds: ["web-1"], accountContextRefs: [], scenarios: [], semanticExportDeltas: [] };
    expect(portableFeatureIntentOf({ ...approved!, e2e: v1 })).toEqual({ ok: true, intent: v1 });
  });

  // ---- Fix round 2 ----

  it("refuses a v2 plan from a run the dispatcher downgraded to a worker without task.workflowE2EApplicationPlan (Ruling AW)", async () => {
    const started = await startPlanning({ web: webApiRow("web"), api: webApiRow("api") });
    // The broker offered version 2 and recorded it ...
    expect(started.payload.workflowE2EPlanVersion).toBe(2);
    const operationKey = { pk: `WORKSPACE#${started.workspaceId}`, sk: `OPERATION#${started.planningId}` };
    expect(started.harness.db.get(operationKey.pk, operationKey.sk)).toMatchObject({ workflowE2EPlanVersion: 2 });
    // ... then delivery found a worker without the feature and reported it (what createEc2Delivery does before it posts).
    const outbox = started.harness.db.find((row) => row.entityType === "OUTBOX" && row.operationId === started.planningId)[0]!;
    const input = started.harness.brokerInput as unknown as { documentClient: never; tableName: string };
    await createApplicationPlanNegotiationRecorder({ documentClient: input.documentClient, tableName: input.tableName })(outbox as never);
    expect(started.harness.db.get(operationKey.pk, operationKey.sk)).not.toHaveProperty("workflowE2EPlanVersion");
    const context = buildFeatureE2EPlanningContext(started.policy, started.snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [READY_WEB] });
    if (context.status !== "available") throw new Error(context.reason);
    const target = context.targets.find((item) => item.targetId === "web-1")!;
    const forTarget = <T extends { applicationId: string; profileId?: string; accountProfileId?: string }>(refs: readonly T[]) => refs.filter((ref) => ref.applicationId === target.applicationId);
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: forTarget(context.accountContextRefs).filter((ref) => ref.profileId === target.accountProfileId),
      scenarios: [{ ...csvScenario, requestedTargetIds: [target.targetId], accountProfileId: target.accountProfileId }], semanticExportDeltas: [],
      applicationRuntimeRefs: context.runtimeRefs!.filter((ref) => ref.targetId === target.targetId).map((ref) => ({ ...ref, recipeDigest: ref.recipeDigest! })),
      runtimeAccountRefs: forTarget(context.runtimeAccountRefs!).filter((ref) => ref.profileId === target.accountProfileId), unavailableTargetRefs: [] });
    await started.harness.artifact(started.workspaceId, started.planningId, "plan.md", planAnswer(planDocument({ title: "Export CSV", claims: [{ id: "1", text: "Orders can be exported." }], e2e: intent })));
    await started.harness.finish(started.workspaceId, started.planningId, "SUCCEEDED", { result: { workflowMode: "PLAN" } });
    const task = started.harness.db.get(`DEVTASK#${started.taskId}`, "META") as { workflow: { state: string; blockReason?: string; artifacts: unknown[] }; planUnreadable?: { errors: string[] } };
    expect(task.workflow).toMatchObject({ state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.planUnreadable });
    expect(task.workflow.artifacts).toEqual([]);
    expect(task.planUnreadable?.errors.join(" ")).toMatch(/schemaVersion 2 was not offered for this planning step/);
  });

  it("still stores a v2 plan from a run whose worker was not downgraded", async () => {
    const planned = await plannedWithApplicationIntent();
    expect(workflowOf(planned).artifacts).toHaveLength(1);
  });

  // ---- Dispatch of an approved application plan (Task 2.4: Ruling AL, Ruling AX, the 2.2b carry) ----

  /**
   * Approves the v2 plan and puts the task where the broker dispatches its checks: VERIFY/WAITING on a candidate, with the dispatch row due, its compute
   * readiness operation done and the session READY. Nothing of the candidate export is needed: an application selection is checked before any source is read.
   */
  async function atChecksDispatch(planned: Planned, options: { mutateTask?: (task: Record<string, unknown>) => Record<string, unknown> } = {}) {
    expect((await decide(planned, "APPROVE")).status).toBe(200);
    const { harness, taskId, workspaceId } = planned;
    const key = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const task = harness.db.get(key.pk, key.sk)!;
    const approved = WorkflowSnapshotSchema.parse(task.workflow);
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "e".repeat(40), baseCommitSha: planned.snapshot.commitSha }]);
    const verifying = WorkflowSnapshotSchema.parse({ ...approved, revision: approved.revision + 1, stage: "VERIFY", state: "WAITING", candidate });
    harness.db.set(options.mutateTask === undefined ? { ...task, workflow: verifying } : options.mutateTask({ ...task, workflow: verifying }));
    const readyOperationId = randomUUID();
    const dispatch = (workflowDispatchItem("state", taskId, verifying.revision, "CHECKS", candidate.digest, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item;
    dispatch.readinessOperationId = readyOperationId;
    harness.db.set(dispatch);
    const marker = { purpose: "workflow-e2e-readiness", taskId, workflowRevision: verifying.revision, candidateDigest: candidate.digest, dispatchSk: dispatch.sk,
      outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, verifying.revision, candidate.digest), readyGeneration: 2 };
    harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${readyOperationId}`, entityType: "OPERATION", id: readyOperationId, workspaceId, kind: "resume",
      status: "SUCCEEDED", fence: 2, requestId: readyOperationId, payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      workflowE2EReadiness: marker });
    harness.db.set({ ...workspaceSessionKey(workspaceId), workspaceId, state: "READY", generation: 2 });
    const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });
    const dispatchKey = String(dispatch.sk);
    const runDispatch = async () => { await harness.handler({ source: "agentx.workflow-dispatch-recovery" }); };
    const taskNow = () => harness.db.get(key.pk, key.sk) as { workflow: { stage: string; state: string; blockReason?: string; revision: number } };
    const checksOperations = () => harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && row.workflowMode === "CHECKS");
    const admissionObjects = () => [...harness.s3.objects.keys()].filter((name) => name.startsWith("workflow-e2e-admissions/"));
    return { ...planned, runDispatch, taskNow, checksOperations, admissionObjects, dispatchRow: () => harness.db.get("WORKFLOW_DISPATCH", dispatchKey), taskKey: key };
  }

  /** The task is blocked for good, in plain words, and nothing was started or retried. */
  async function expectBlockedAtDispatch(dispatched: Awaited<ReturnType<typeof atChecksDispatch>>, reason: RegExp) {
    await dispatched.runDispatch();
    expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(dispatched.taskNow().workflow.blockReason).toMatch(reason);
    expect(dispatched.dispatchRow()).toBeUndefined();
    expect(dispatched.checksOperations()).toEqual([]);
    expect(dispatched.admissionObjects()).toEqual([]);
    // Run again: a removed row stays removed, so the task is never re-driven.
    await dispatched.runDispatch();
    expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
  }

  it("blocks a v2-approved task at CHECKS dispatch instead of running it as a portable round or looping on the portable refusal (Ruling AX, the 2.2b carry)", async () => {
    const dispatched = await atChecksDispatch(await plannedWithApplicationIntent());
    expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    await expectBlockedAtDispatch(dispatched, /cannot dispatch application rounds yet.*Nothing was run/s);
  });

  describe("the selection approved at plan APPROVE must still be the one dispatched (Ruling AL)", () => {
    const refusalPrefix = "The approved application checks can no longer run as approved: ";
    const reasonOf = (text: string) => new RegExp(refusalPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + text, "s");

    it("passes the unchanged selection through the check (it is the only thing left standing between it and the round)", async () => {
      const dispatched = await atChecksDispatch(await plannedWithApplicationIntent());
      await dispatched.runDispatch();
      // Not the "no longer run as approved" refusal: the selection derived again equals the recorded one.
      expect(dispatched.taskNow().workflow.blockReason).not.toContain(refusalPrefix);
      expect(dispatched.taskNow().workflow.blockReason).toContain("cannot dispatch application rounds yet");
    });

    it("refuses when the runtime row was replaced by a new generation", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
      await expectBlockedAtDispatch(dispatched, reasonOf("the web runtime linux-arm64-web-api-v1 \\(generation 5.*is not the approved web runtime.*generation 4"));
    });

    it("refuses when the row's expiry or capabilities moved, since a changed row is not the approved one", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      const saved = planned.harness.db.get(webKey.pk, webKey.sk)!;
      planned.harness.db.set({ ...saved, expiresAt: new Date(Date.parse(String(saved.expiresAt)) + 60_000).toISOString() });
      await expectBlockedAtDispatch(dispatched, reasonOf("the web runtime .* is not the approved web runtime"));
    });

    it("refuses when the row is no longer READY, saying the runtime is not ready", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, state: "REVOKED" });
      await expectBlockedAtDispatch(dispatched, reasonOf(".*web runtime of profile linux-arm64-web-api-v1"));
    });

    it("refuses when the row expired", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, expiresAt: new Date(Date.now() - 1_000).toISOString() });
      await expectBlockedAtDispatch(dispatched, reasonOf(".*web runtime of profile linux-arm64-web-api-v1"));
    });

    it("refuses when the row's runtime binding moved", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      const other = { ...planned.projectBinding, launchTemplateId: "lt-fedcba9876543210" };
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, binding: other, bindingDigest: shaCanonical(other) });
      await expectBlockedAtDispatch(dispatched, reasonOf(".*web runtime of profile linux-arm64-web-api-v1"));
    });

    it("refuses a selection that is not the recorded one: another intent, other targets, other approvals, or no record at all", async () => {
      const recordOf = (task: Record<string, unknown>) => (task.workflow as { e2e: { applicationSelection: Record<string, unknown> } }).e2e.applicationSelection;
      const tampered = (edit: (record: Record<string, unknown>) => void) => (task: Record<string, unknown>) => {
        const copy = structuredClone(task);
        edit(recordOf(copy));
        return copy;
      };
      const cases: Array<[string, (task: Record<string, unknown>) => Record<string, unknown>, RegExp]> = [
        ["another intent", tampered((record) => { record.intentDigest = "9".repeat(64); }), reasonOf("the approved plan's E2E intent")],
        ["other targets", tampered((record) => { record.executableTargetIds = ["web-1", "web-2"]; }), reasonOf("the targets that can run application scenarios")],
        ["another setup approval", tampered((record) => { record.setupApproval = { artifactId: "setup-elsewhere", digest: "8".repeat(64) }; }), reasonOf("the setup approval")],
        ["another plan approval", tampered((record) => { record.semanticApproval = { artifactId: "plan-elsewhere", digest: "7".repeat(64) }; }), reasonOf("the plan approval")],
        ["another application binding", tampered((record) => { record.applicationApprovalBindingDigest = "6".repeat(64); }), reasonOf("the approved applications' source")],
        ["a row that was not part of the approval", tampered((record) => { record.runtimeRows = []; }), reasonOf("the web runtime .* was not part of the approval")],
        ["an approved row that is not there now", tampered((record) => { (record.runtimeRows as unknown[]).push({ ...(record.runtimeRows as Array<Record<string, unknown>>)[0]!, kind: "api" }); }), reasonOf("the approved api runtime")],
        ["no record", (task) => { const copy = structuredClone(task); delete (copy.workflow as { e2e: Record<string, unknown> }).e2e.applicationSelection; return copy; },
          /no recorded application selection/],
      ];
      for (const [label, mutateTask, reason] of cases) {
        const dispatched = await atChecksDispatch(await plannedWithApplicationIntent(), { mutateTask });
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow, label).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
        expect(dispatched.taskNow().workflow.blockReason, label).toMatch(reason);
        expect(dispatched.checksOperations(), label).toEqual([]);
        expect(dispatched.dispatchRow(), label).toBeUndefined();
      }
    });

    it("retries within its budget, and does not block, when the selection cannot be read now", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      const send = planned.harness.db.send.bind(planned.harness.db);
      planned.harness.db.send = async (command) => {
        const input = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input;
        if (command.constructor.name === "GetCommand" && input?.Key?.pk === webKey.pk && input.Key.sk === webKey.sk) throw new Error("throttled");
        return send(command);
      };
      try { await dispatched.runDispatch(); } finally { planned.harness.db.send = send; }
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
      expect(dispatched.dispatchRow()).toMatchObject({ attempts: 1, kind: "CHECKS" });
      expect(dispatched.checksOperations()).toEqual([]);
    });
  });

});
