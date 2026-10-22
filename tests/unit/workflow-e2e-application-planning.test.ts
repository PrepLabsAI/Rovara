import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  E2EApplicationAccountDefinitionSchema, E2EApplicationPlanIntentSchema, E2EApplicationSelectionRecordSchema, E2EPolicySchema, createCandidateManifest,
  WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX, deriveE2EApplicationRuntimeAccountRef, e2eApplicationAccountDefinitionDigest, workflowApplicationRetryOffered,
  E2EWorkflowAdmissionRefSchema, WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX, WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX, WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX,
  WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX, canonicalPlanJson, workflowSendBackOffered,
  WORKFLOW_BLOCK_REASONS, WorkflowSnapshotSchema, workflowRequestId, workspaceSessionKey, readCanonicalPlan, portableOperationId, type E2EApplicationPlanIntent,
  selectE2EApplicationExecutionPlan, E2EScenarioSchema, e2eAnonymousRuntimeAccountRef, E2E_APPLICATION_ADMISSION_SCHEMA_V2,
  type E2EScenario, type E2ESourceSnapshot,
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
import { decideTaskWorkflow, taskPageStage } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTaskRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import * as routes from "../../packages/broker/src/aws/developer-routes.js";
import { decodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission } from "@agentx/verifier";
import { E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON, isE2EPlanCorrectionBlockReason } from "../../packages/broker/src/developer/task-records.js";
import { accountRegistryEntriesFromRows } from "../../packages/broker/src/e2e/application-account-registry.js";
import { ordersManifestWith, registryFor } from "../support/e2e-account-registry-fixtures.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { createRealCandidate, disposeRealCandidates } from "../support/e2e-application-candidate.js";
import { call, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { NOW, PROFILE, anonymousScenario, anonymousTargetOf, apiSnapshot, approvedSetup, binding, contractSnapshot, csvScenario, inferredSnapshot, ordersContractManifest, planFixture, sha, shaCanonical, snapshotOf, webAndApiFixture, webApiRow,
  type PlanInput } from "../support/e2e-application-plan-fixtures.js";


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

  describe("an agent step is executable only on a qualified web runtime, with an approved route", () => {
    const agentScenario = (steps: E2EScenario["steps"] = [{ kind: "agent", goal: "open the orders page", maxActions: 3 }]): E2EScenario => ({ ...csvScenario, scenarioId: "agent-orders",
      steps, assertions: [{ kind: "visible", testId: "orders", equals: true }] });
    const withAgentSupport = (kind: "web" | "api" = "web") => webApiRow(kind, {}, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] }));

    it("stays unavailable with agent-runtime-not-qualified while the READY descriptor declares no agent support", () => {
      const { plan: selected } = plan({ scenario: agentScenario(), modelRouteRevision: "r1-0123456789ab" });
      expect(selected.groups).toEqual([]);
      expect(selected.unavailableCriteria).toEqual([{ criterionId: selected.criteria[0]!.criterionId, reason: "agent-runtime-not-qualified" }]);
    });

    it("stays unavailable with agent-route-not-approved while the project policy has no route", () => {
      const { plan: selected } = plan({ scenario: agentScenario(), registeredRuntimes: [withAgentSupport()] });
      expect(selected.groups).toEqual([]);
      expect(selected.unavailableCriteria).toEqual([{ criterionId: selected.criteria[0]!.criterionId, reason: "agent-route-not-approved" }]);
    });

    it("is one application group with nothing unavailable when the descriptor supports agent and the policy pins a route", () => {
      const { plan: selected } = plan({ scenario: agentScenario(), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" });
      expect(selected.unavailableCriteria).toEqual([]);
      expect(selected.groups).toHaveLength(1);
      expect(selected.groups[0]).toMatchObject({ mode: "real-runtime", runtimeProfileId: PROFILE, targetIds: ["web-1"] });
    });

    it("binds the route revision into the case identity, so another route is another case", () => {
      const one = plan({ scenario: agentScenario(), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" }).plan;
      const two = plan({ scenario: agentScenario(), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r2-ba9876543210" }).plan;
      expect(one.groups[0]!.expectedCases[0]!.caseId).not.toBe(two.groups[0]!.expectedCases[0]!.caseId);
    });

    it("is refused at approval with agent-steps-web-only on an API target, even when its descriptor claims agent support", () => {
      const apiAgent: E2EScenario = { ...agentScenario(), requestedTargetIds: ["api-1"], steps: [{ kind: "agent", goal: "call the orders endpoint", maxActions: 3 }],
        assertions: [{ kind: "http-status", path: "/api/orders", method: "GET", equals: 200 }] };
      const fixture = planFixture({ snapshot: apiSnapshot, targetId: "api-1", scenario: apiAgent, setupReady: [{ kind: "api", profileId: PROFILE }], modelRouteRevision: "r1-0123456789ab" });
      const result = evaluateApplicationPlanApproval({ intent: fixture.intent, taskId: "11111111-1111-4111-8111-111111111111", artifact: { id: "feature-plan", sha256: "1".repeat(64) },
        snapshot: fixture.snapshot, setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy,
        registeredRuntimes: [webApiRow("web"), withAgentSupport("api")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: NOW,
        accounts: { entries: fixture.registry, mode: "approve", pinned: [] } });
      expect(result).toMatchObject({ ok: false, scope: "plan" });
      expect(!result.ok && result.reason).toMatch(/^agent-steps-web-only: scenario agent-orders/);
    });

    it("leaves a plan with no agent step exactly as it was", () => {
      const without = plan({ registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" }).plan;
      expect(without.unavailableCriteria).toEqual([]);
      expect(without.groups).toHaveLength(1);
    });

    it("refuses at approval an agent step that asks for more than 8 actions", () => {
      expect(() => plan({ scenario: agentScenario([{ kind: "agent", goal: "open the orders page", maxActions: 9 }]), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" }))
        .toThrow(/agent-step-over-budget/);
      expect(() => plan({ scenario: agentScenario([{ kind: "agent", goal: "open the orders page", maxActions: 8 }]), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" })).not.toThrow();
    });

    it("refuses at approval a group of more than 3 agent steps", () => {
      const step = { kind: "agent" as const, goal: "open the orders page", maxActions: 2 };
      expect(() => plan({ scenario: agentScenario([step, step, step, step]), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" })).toThrow(/agent-steps-over-group-limit/);
      expect(() => plan({ scenario: agentScenario([step, step, step]), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" })).not.toThrow();
    });

    it("cannot be written without a deterministic assertion after its last agent step: the scenario schema requires one (so approval needs no separate refusal)", () => {
      expect(() => E2EScenarioSchema.parse({ ...agentScenario(), assertions: [] })).toThrow();
      expect(E2EScenarioSchema.parse(agentScenario()).assertions.length).toBeGreaterThan(0);
    });

    it("refuses at approval more than 3 agent steps in one group, counted across its scenarios (2 + 2), and accepts 2 + 1", () => {
      const step = { kind: "agent" as const, goal: "open the orders page", maxActions: 2 };
      const two = (id: string): E2EScenario => ({ ...agentScenario([step, step]), scenarioId: id });
      const one = (id: string): E2EScenario => ({ ...agentScenario([step]), scenarioId: id });
      const withScenarios = (scenarios: E2EScenario[]) => () => plan({ scenario: scenarios[0]!, extraScenarios: scenarios.slice(1), registeredRuntimes: [withAgentSupport()], modelRouteRevision: "r1-0123456789ab" });
      expect(withScenarios([two("agent-a"), two("agent-b")])).toThrow(/agent-steps-over-group-limit/);
      expect(withScenarios([two("agent-a"), one("agent-b")])).not.toThrow();
    });
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
    registeredRuntimes: input.registeredRuntimes ?? [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: input.runtimeBinding ?? binding, now: NOW,
    accounts: { entries: fx.registry, mode: "approve", pinned: [] } });
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
      ["the scenario has an agent step and the descriptor declares no agent support", { modelRouteRevision: "r1-0123456789ab", scenario: { ...csvScenario, scenarioId: "agent-orders",
        steps: [{ kind: "agent", goal: "open the orders page", maxActions: 3 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] } }, /agent-runtime-not-qualified/],
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

describe("a v2 intent with portable criteria is refused at approval (Ruling BE, supersedes the acceptance half of Ruling AV)", () => {
  const BE_REASON = "put portable checks in a schemaVersion 1 plan or drop them";
  const BE_REMEDY_TEXT = BE_REASON;

  it("refuses a plan that also proposes a portable scenario, naming the remedy", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable });
    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain(BE_REASON);
    expect(refusal(result)).toContain("render-orders");
  });

  it("refuses it whether or not the portable scenario is a pinned baseline scenario", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable, policyBaselineIds: ["export-csv", "render-orders"] });
    expect(refusal(result)).toContain(BE_REASON);
  });

  it("approves the same plan without the portable scenario, with the same selection a v2-only plan always had", () => {
    const alone = evaluate({ snapshot: mixedSnapshot });
    expect(alone.ok, refusal(alone)).toBe(true);
    if (!alone.ok) return;
    expect(alone.selection).toMatchObject({ executableTargetIds: ["web-1"], unavailableCriteria: [] });
  });

  it("still refuses a pinned baseline scenario the plan omits entirely", () => {
    expect(refusal(evaluate({ policyBaselineIds: ["export-csv", "pinned-elsewhere"] }))).toMatch(/baseline.*pinned-elsewhere/i);
  });

  it("refuses a version 2 intent with no application scenario, since a portable-only plan is a version 1 plan", () => {
    const result = evaluate({ snapshot: mixedSnapshot, mutateIntent: (intent, fixture) => ({ ...withProposedCallable(intent, fixture),
      scenarios: [portableScenario(portableOperationId(".", fixture.application.applicationId))], applicationRuntimeRefs: [], runtimeAccountRefs: [], unavailableTargetRefs: [] }) });
    expect(refusal(result)).toMatch(/no application scenario.*schemaVersion 1/i);
  });

  it("also refuses a non-empty semanticExportDeltas, which would otherwise be dropped silently from the derived intent (M4)", () => {
    const result = evaluate({ mutateIntent: (intent, fixture) => ({ ...intent, semanticExportDeltas: [{ applicationId: fixture.application.applicationId, operationId: "price-rows",
      requestedTargetIds: ["web-1"], expectedExportNames: ["priceRows"], reason: "adds an export" }] }) });
    expect(result.ok).toBe(false);
    expect(refusal(result)).toContain(BE_REMEDY_TEXT);
    expect(refusal(result)).toContain("semanticExportDeltas");
  });

  it("marks a plan-intrinsic refusal (portable criteria) apart from a runtime one, so dispatch can send the plan back to planning", () => {
    const portable = evaluate({ snapshot: mixedSnapshot, mutateIntent: withProposedCallable });
    expect(!portable.ok && portable.scope).toBe("plan");
    const noRow = evaluate({ registeredRuntimes: [] });
    expect(!noRow.ok && noRow.scope).toBe("runtime");
    const expired = evaluate({ registeredRuntimes: [webApiRow("web", { qualifiedAt: new Date(NOW - 7_200_000).toISOString(), expiresAt: new Date(NOW - 1_000).toISOString() })] });
    expect(!expired.ok && expired.scope).toBe("runtime");
    const otherBinding = evaluate({ runtimeBinding: { ...binding, launchTemplateId: "lt-fedcba9876543210" } });
    expect(!otherBinding.ok && otherBinding.scope).toBe("runtime");
    // Anything else (a source reference that does not match, say) is neither: the owner is told what changed.
    const source = evaluate({ sourceSha: "9".repeat(64) });
    expect(!source.ok && source.scope).toBeUndefined();
  });

  it("tells the planner so in the version 2 prompt, and says nothing of it in a prompt that does not ask for version 2", () => {
    const readyWeb = [{ kind: "web" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedSteps,
      supportedAssertions: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedAssertions }];
    const setup = approvedSetup(contractSnapshot, [{ kind: "web", profileId: PROFILE }], ["web-1"]);
    const context = buildFeatureE2EPlanningContext(setup.policy, contractSnapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: readyWeb, accountRegistry: registryFor(contractSnapshot) });
    if (context.status !== "available") throw new Error(context.reason);
    const v2 = planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context });
    expect(v2).toContain("Application E2E plan guidance (schemaVersion 2):");
    expect(v2).toContain(BE_REASON);
    expect(v2).toMatch(/leaves portableOperationRefs and semanticExportDeltas empty/);
    expect(planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context, applicationPlans: false })).not.toContain(BE_REASON);
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

/** A VERIFY/BLOCKED workflow snapshot with a required E2E obligation and the given block reason, for the task-page text. */
function workflowFixtureFor(blockReason: string) {
  return { schemaVersion: 1, definitionId: "agentx-task-to-pr", definitionVersion: "1.0.0", taskId: TASK_ID, ownerId: "a".repeat(64), path: "QUICK", revision: 6, stage: "VERIFY", state: "BLOCKED",
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), artifacts: [], decisions: [], blockReason,
    e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } };
}

describe("web and API targets in one application plan (Ruling BF, Task 3.4)", () => {
  const bothKinds = () => {
    const fixture = webAndApiFixture();
    const run = (intent: E2EApplicationPlanIntent, registeredRuntimes = [webApiRow("web"), webApiRow("api")]) => evaluateApplicationPlanApproval({ intent, taskId: TASK_ID, artifact: APPROVED_ARTIFACT, snapshot: fixture.snapshot,
      setupProposal: fixture.setup.proposal, setupApproval: fixture.setup.setupApproval, policy: fixture.policy, registeredRuntimes,
      runtimeCatalogId: "catalog", runtimeBinding: binding, now: NOW, accounts: { entries: fixture.registry, mode: "approve", pinned: [] } });
    return { ...fixture, run };
  };

  it("approves an intent whose executable targets span web and api, recording the row of each kind", () => {
    const fixture = bothKinds();
    const result = fixture.run(fixture.build({ web: true, api: true }));
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (result.ok) {
      expect(result.selection.executableTargetIds).toEqual([fixture.web.targetId, fixture.api.targetId].sort());
      expect(result.selection.runtimeRows.map((row) => row.kind).sort()).toEqual(["api", "web"]);
      expect(result.derivation.plan.groups.map((group) => group.targetIds)).toHaveLength(2);
    }
  });

  it("approves either kind alone, with the other target listed as unavailable", () => {
    const fixture = bothKinds();
    const webOnly = fixture.run(fixture.build({ web: true, api: false }));
    expect(webOnly.ok, webOnly.ok ? "" : webOnly.reason).toBe(true);
    if (webOnly.ok) expect(webOnly.selection).toMatchObject({ executableTargetIds: [fixture.web.targetId], runtimeRows: [{ kind: "web" }] });
    const apiOnly = fixture.run(fixture.build({ web: false, api: true }));
    expect(apiOnly.ok, apiOnly.ok ? "" : apiOnly.reason).toBe(true);
    if (apiOnly.ok) expect(apiOnly.selection).toMatchObject({ executableTargetIds: [fixture.api.targetId], runtimeRows: [{ kind: "api" }] });
  });

  it("still refuses a plan that needs a kind with no READY row, naming the kind (the runtime is at fault, not the plan)", () => {
    const fixture = bothKinds();
    const noApiRow = fixture.run(fixture.build({ web: true, api: true }), [webApiRow("web")]);
    expect(noApiRow.ok).toBe(false);
    expect(noApiRow.ok ? "" : noApiRow.reason).toMatch(/no api runtime of profile .* is READY/);
    expect(!noApiRow.ok && noApiRow.scope).toBe("runtime");
  });

  it("refuses a request step on a web target and a browser step on an api target, each against its own kind's descriptor", () => {
    const fixture = bothKinds();
    const intent = fixture.build({ web: true, api: true });
    const requestOnWeb = fixture.run({ ...intent, scenarios: intent.scenarios.map((scenario) => scenario.requestedTargetIds[0] === fixture.web.targetId
      ? { ...scenario, steps: [{ kind: "request" as const, requestId: "r", path: "/health", method: "GET" as const, body: {} }], assertions: [{ kind: "http-status" as const, path: "/health", method: "GET" as const, equals: 200 }] } : scenario) });
    expect(requestOnWeb.ok).toBe(false);
    expect(requestOnWeb.ok ? "" : requestOnWeb.reason).toMatch(new RegExp(`target ${fixture.web.targetId}: application runtime is not ready`));
    const browserOnApi = fixture.run({ ...intent, scenarios: intent.scenarios.map((scenario) => scenario.requestedTargetIds[0] === fixture.api.targetId
      ? { ...scenario, steps: [{ kind: "navigate" as const, path: "/" }], assertions: [{ kind: "visible" as const, testId: "x", equals: true }] } : scenario) });
    expect(browserOnApi.ok).toBe(false);
    expect(browserOnApi.ok ? "" : browserOnApi.reason).toMatch(/UI scenario steps are incompatible with API target/);
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
      accountRegistry: registryFor(snapshot), ...(readyRuntimes === undefined ? {} : { readyRuntimes }) });
    if (result.status !== "available") throw new Error(result.reason);
    return result;
  };

  it("takes the runtime profile from the approved target and lists the executable step and assertion kinds", () => {
    const context = contextFor(contractSnapshot, ready);
    // (The target also offers the signed-out visitor, as a variant of its own on the same runtime profile.)
    expect(context.runtimeRefs).toMatchObject([{ targetId: "web-1", runtimeProfileId: PROFILE }, { targetId: "web-1-anonymous", runtimeProfileId: PROFILE, accountProfileId: "rovara-anonymous" }]);
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

  it("offers agent steps only for a web target whose project has an approved, current route, and says how to use them (Task 4.2)", () => {
    const readyWithAgent = [{ ...ready[0]!, supportedSteps: [...ready[0]!.supportedSteps, "agent" as const] }];
    const build = (agentRouteApproved?: boolean) => {
      const setup = approvedSetup(contractSnapshot, [{ kind: "web", profileId: PROFILE }], ["web-1"]);
      const result = buildFeatureE2EPlanningContext(setup.policy, contractSnapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: readyWithAgent,
        accountRegistry: registryFor(contractSnapshot), ...(agentRouteApproved === undefined ? {} : { agentRouteApproved }) });
      if (result.status !== "available") throw new Error(result.reason);
      return result;
    };
    // A registered descriptor that lists agent is not enough: without an approved, current route the planner is told agent steps are unavailable.
    for (const withheld of [build(), build(false)]) {
      expect(withheld.executableKinds![0]!.steps).not.toContain("agent");
      expect(describeFeatureE2EExecutableKinds(withheld)).toContain("Do not use `agent` steps; they stay unavailable.");
    }
    const offered = build(true);
    expect(offered.executableKinds![0]!.steps).toContain("agent");
    const text = describeFeatureE2EExecutableKinds(offered);
    expect(text.split("\n").filter((line) => line.startsWith("- web targets"))[0]).toContain("agent");
    expect(text).toMatch(/Use deterministic steps where test IDs are known and stable/);
    expect(text).not.toContain("Do not use `agent` steps");
  });

  it("puts the same target in the unavailable list while its runtime is not READY now", () => {
    const context = contextFor(contractSnapshot);
    expect(context.unavailableTargetRefs).toMatchObject([{ targetId: "web-1" }, { targetId: "web-1-anonymous" }]);
    expect(context.unavailableReasons).toEqual([{ targetId: "web-1", reason: "runtime-not-ready" }, { targetId: "web-1-anonymous", reason: "runtime-not-ready" }]);
    expect(context.executableKinds).toEqual([]);
    expect(describeFeatureE2EExecutableKinds(context)).toBe("");
  });

  it("marks an inferred-recipe target unavailable with the needs-project-contract reason even when the runtime is READY", () => {
    const context = contextFor(inferredSnapshot, ready);
    expect(context.unavailableTargetRefs).toMatchObject([{ targetId: "web-1" }]);
    expect(context.unavailableReasons).toEqual([{ targetId: "web-1", reason: "needs-project-contract" }]);
    // Only its signed-out variant is executable (Ruling AZ).
    expect(context.executableKinds).toMatchObject([{ kind: "web" }]);
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
      readyRuntimes: ready, accountRegistry: registryFor(contractSnapshot) });
    if (context.status !== "available") throw new Error(context.reason);
    expect(context.runtimeRefs?.every((item) => item.runtimeProfileId === "web-phase-unavailable")).toBe(true);
    expect(context.unavailableTargetRefs?.map((item) => item.targetId)).toEqual(["web-1"]);
    expect(Object.keys(context)).not.toContain("unavailableReasons");
    expect(Object.keys(context)).not.toContain("executableKinds");
    // Hashes of the context JSON and of the planner instructions, computed from the code at 8ec3eb02 (before Task 2.2); re-pinned in M1.3 for the fixture contract gaining the inventory origin's contractPath and renaming the orders origin variable.
    expect(sha(JSON.stringify(context))).toBe("a08213eb26bb5a1f8defff6b6d7b85fcd7f93a9dedef45b3e05c969fcda82cbc");
    expect(sha(planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context }))).toBe("86217ec02fcdf178489faed92ebc046f7e47b074e564d355ef662e3a9fd9b352");
  });
});

// The ordinary feature PLAN, end to end through the broker: an approved setup whose web target was proposed against the READY profile,
// planned against the project's current runtime catalog rows (Ruling AL: web and api rows, matched to the project's runtime binding).
describe("ordinary feature PLAN with an approved qualified web target", () => {
  type Harness = Awaited<ReturnType<typeof createDeveloperTaskBroker>>;
  type Rows = Record<"web" | "api", Record<string, unknown> | undefined>;
  const SLACK_THREAD = { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000099" };
  /** Registers the project against its approved setup and the catalog rows, then starts a task and runs its preparation, up to the planning invocation. */
  async function startPlanning(rows: Rows, afterApproval?: (harness: Harness) => void, viaSlack = false, brokerExtra: Record<string, unknown> = {}) {
    const snapshot = contractSnapshot;
    const capture = vi.fn(async () => snapshot);
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog", ...brokerExtra } });
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
  async function plannedWithApplicationIntent(options: { viaSlack?: boolean; afterApproval?: (harness: Harness) => void; scenarios?: (target: { targetId: string; accountProfileId: string }) => E2EScenario[];
    /** Extra broker dependencies, for example the installation's AI navigation settings. */ brokerExtra?: Record<string, unknown>; rows?: Rows } = {}) {
    const started = await startPlanning(options.rows ?? { web: webApiRow("web"), api: webApiRow("api") }, options.afterApproval, options.viaSlack === true, options.brokerExtra);
    const { harness, workspaceId, planningId, snapshot } = started;
    const { policy } = started;
    const context = buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [READY_WEB],
      accountRegistry: accountRegistryEntriesFromRows("payments", harness.db.find((row) => row.pk === "PROJECT#payments")) });
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
    return { ...started, intent, target, viaSlack: options.viaSlack === true };
  }
  type Planned = Awaited<ReturnType<typeof plannedWithApplicationIntent>>;

  const workflowOf = (planned: Planned) => (planned.harness.db.get(`DEVTASK#${planned.taskId}`, "META") as { workflow: { revision: number; stage: string; state: string; candidate?: unknown;
    artifacts: Array<{ id: string; sha256: string; objectKey: string }>; e2e?: Record<string, unknown> } }).workflow;
  const operationIds = (planned: Planned) => planned.harness.db.find((row) => row.pk === `WORKSPACE#${planned.workspaceId}` && row.entityType === "OPERATION").map((row) => row.id);
  const decide = (planned: Planned, decision: "APPROVE" | "REQUEST_CHANGES") => {
    const workflow = workflowOf(planned);
    // A task started from Slack belongs to its Slack owner: the owner decides from the thread, and the answer is shaped like the route's.
    if (planned.viaSlack) {
      return planned.harness.handler({ source: "agentx.slack-ingress", action: "workflow-decision", taskId: planned.taskId, userId: MAYA.slackUserId, thread: SLACK_THREAD,
        requestId: randomUUID(), expectedRevision: workflow.revision, artifactDigest: workflow.artifacts.at(-1)!.sha256, decision, reason: "Approve the exact application intent",
        selectedOptionalCheckIds: [] }).then((answer) => ({ status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown> }));
    }
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
      // The READY descriptor declares no agent support yet (Task 4.5), so the plan lists a target as executable whose scenario cannot run (it needs the route as well; see the evaluation cases).
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /agent-runtime-not-qualified/i);
    });

    it("when an agent step asks for more than 8 actions (agent-step-over-budget)", async () => {
      const planned = await plannedWithApplicationIntent({ scenarios: (target) => [{ ...csvScenario, scenarioId: "agent-orders", requestedTargetIds: [target.targetId],
        accountProfileId: target.accountProfileId, steps: [{ kind: "agent", goal: "open the orders page", maxActions: 9 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] }] });
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /agent-step-over-budget/);
    });

    it("when a scenario has more than 3 agent steps (agent-steps-over-group-limit)", async () => {
      const step = { kind: "agent" as const, goal: "open the orders page", maxActions: 2 };
      const planned = await plannedWithApplicationIntent({ scenarios: (target) => [{ ...csvScenario, scenarioId: "agent-orders", requestedTargetIds: [target.targetId],
        accountProfileId: target.accountProfileId, steps: [step, step, step, step], assertions: [{ kind: "visible", testId: "orders", equals: true }] }] });
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /agent-steps-over-group-limit/);
    });

    it("when the plan's account reference is not the registered account's (the M1.2 stand-in and any forged ref alike)", async () => {
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
      await expectRefusedThenRequestChanges(planned, /CONFIG_INVALID/, /accounts-changed-reapprove.*runtime account reference/i);
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
    const context = buildFeatureE2EPlanningContext(started.policy, started.snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [READY_WEB],
      accountRegistry: accountRegistryEntriesFromRows("payments", started.harness.db.find((row) => row.pk === "PROJECT#payments")) });
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
   * readiness operation done and the session READY. Nothing of the candidate export is seeded here: an application selection is checked before any source is read.
   */
  async function atChecksDispatch(planned: Planned, options: { mutateTask?: (task: Record<string, unknown>) => Record<string, unknown>; seedReadiness?: boolean; attempts?: number;
    /** The task's candidate; by default a fabricated one, since an application selection is checked before any source is read. */ candidate?: ReturnType<typeof createCandidateManifest> } = {}) {
    expect((await decide(planned, "APPROVE")).status).toBe(200);
    const { harness, taskId, workspaceId } = planned;
    const key = { pk: `DEVTASK#${taskId}`, sk: "META" };
    const task = harness.db.get(key.pk, key.sk)!;
    const approved = WorkflowSnapshotSchema.parse(task.workflow);
    const candidate = options.candidate ?? createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "e".repeat(40), baseCommitSha: planned.snapshot.commitSha }]);
    const verifying = WorkflowSnapshotSchema.parse({ ...approved, revision: approved.revision + 1, stage: "VERIFY", state: "WAITING", candidate });
    harness.db.set(options.mutateTask === undefined ? { ...task, workflow: verifying } : options.mutateTask({ ...task, workflow: verifying }));
    const readyOperationId = randomUUID();
    const dispatch = (workflowDispatchItem("state", taskId, verifying.revision, "CHECKS", candidate.digest, new Date().toISOString()) as { Put: { Item: Record<string, unknown> } }).Put.Item;
    // By default the compute warm-up is already done; without it the broker would have to start one before it dispatches anything.
    if (options.seedReadiness !== false) dispatch.readinessOperationId = readyOperationId;
    if (options.attempts !== undefined) dispatch.attempts = options.attempts;
    harness.db.set(dispatch);
    const marker = { purpose: "workflow-e2e-readiness", taskId, workflowRevision: verifying.revision, candidateDigest: candidate.digest, dispatchSk: dispatch.sk,
      outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, verifying.revision, candidate.digest), readyGeneration: 2 };
    if (options.seedReadiness !== false) {
      harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${readyOperationId}`, entityType: "OPERATION", id: readyOperationId, workspaceId, kind: "resume",
        status: "SUCCEEDED", fence: 2, requestId: readyOperationId, payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        workflowE2EReadiness: marker });
    }
    harness.db.set({ ...workspaceSessionKey(workspaceId), workspaceId, state: "READY", generation: 2 });
    const creator = harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META");
    if (creator !== undefined) harness.db.set({ ...creator, entityType: "DEVELOPER" });
    // A task started from Slack is owned by the Slack caller's own developer identity, which the round's creator check reads.
    if (creator !== undefined && task.developerId !== MAYA.developerId) harness.db.set({ ...creator, pk: `DEVELOPER#${String(task.developerId)}`, entityType: "DEVELOPER" });
    const dispatchKey = String(dispatch.sk);
    const runDispatch = async () => { await harness.handler({ source: "agentx.workflow-dispatch-recovery" }); };
    const taskNow = () => harness.db.get(key.pk, key.sk) as { workflow: { stage: string; state: string; blockReason?: string; revision: number } };
    const checksOperations = () => harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && row.workflowMode === "CHECKS");
    const admissionObjects = () => [...harness.s3.objects.keys()].filter((name) => name.startsWith("workflow-e2e-admissions/"));
    const readinessOperations = () => harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === workspaceId && row.workflowE2EReadiness !== undefined);
    const workspaceNow = () => harness.db.get(`WORKSPACE#${workspaceId}`, "META") as { status?: string; activeOperationId?: string } | undefined;
    const dispatchRows = () => harness.db.find((row) => row.pk === "WORKFLOW_DISPATCH" && row.taskId === taskId) as Array<Record<string, unknown> & { sk: string; workflowRevision: number }>;
    /** Marks the compute warm-up done for the task's current dispatch row, as it is for the first one by default (a retry writes a fresh row that would warm up again). */
    const reseedReadiness = () => {
      for (const row of dispatchRows()) {
        if (row.readinessOperationId !== undefined) continue;
        const operationId = randomUUID();
        harness.db.set({ ...row, readinessOperationId: operationId });
        harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "resume", status: "SUCCEEDED", fence: 2,
          requestId: operationId, payloadHash: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          workflowE2EReadiness: { purpose: "workflow-e2e-readiness", taskId, workflowRevision: row.workflowRevision, candidateDigest: candidate.digest, dispatchSk: row.sk,
            outboxId: workflowRequestId("agentx-workflow-e2e-readiness-outbox", taskId, row.workflowRevision, candidate.digest), readyGeneration: 2 } });
      }
    };
    return { ...planned, runDispatch, taskNow, checksOperations, readinessOperations, workspaceNow, admissionObjects, dispatchRows, reseedReadiness, candidate, dispatchRow: () => harness.db.get("WORKFLOW_DISPATCH", dispatchKey) as (Record<string, unknown> & { taskAccessPausedAt?: string }) | undefined, taskKey: key };
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

  const noPortableAdmission = (dispatched: Awaited<ReturnType<typeof atChecksDispatch>>) => {
    for (const name of dispatched.admissionObjects()) {
      expect((JSON.parse(dispatched.harness.s3.objects.get(name)!) as { schemaVersion?: unknown }).schemaVersion, name).toBe(E2E_APPLICATION_ADMISSION_SCHEMA_V2);
    }
  };

  it("never runs a v2-approved task as a portable round: with no candidate export it blocks, with the reason, and never loops (Ruling AX, the 2.2b carry)", async () => {
    const dispatched = await atChecksDispatch(await plannedWithApplicationIntent());
    expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
    await expectBlockedAtDispatch(dispatched, /no committed source export/);
    expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX);
    noPortableAdmission(dispatched);
  });

  // M1.4 Task 4.2: the route the project's setup pinned is re-derived when a round with AI navigation steps is dispatched. These go through the whole broker path (setup approval that
  // pins the route, plan APPROVE, the dispatch sweep), so deleting the dispatch check from `startApplicationE2EChecksDispatch` fails them.
  describe("a round with AI navigation steps is dispatched only on the route the setup pinned", () => {
    const anthropic = { provider: "anthropic", secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/provider-key-AbCdEf" };
    const agentRows: Rows = { web: webApiRow("web", {}, (value) => ({ ...value, supportedSteps: [...value.supportedSteps, "agent" as const] })), api: webApiRow("api") };
    const agentScenarios = (target: { targetId: string; accountProfileId: string }): E2EScenario[] => [{ ...csvScenario, scenarioId: "agent-orders", requestedTargetIds: [target.targetId],
      accountProfileId: target.accountProfileId, steps: [{ kind: "agent", goal: "Export the orders as a CSV file", maxActions: 4 }], assertions: [{ kind: "visible", testId: "orders", equals: true }] }];
    async function agentRound(installation: { current: () => Promise<Record<string, unknown>> }, scenarios = agentScenarios) {
      const planned = await plannedWithApplicationIntent({ rows: agentRows, scenarios, brokerExtra: { e2eAgentInstallation: () => installation.current() } });
      return { planned, dispatched: await atChecksDispatch(planned) };
    }
    const reason = (code: string) => new RegExp(`${code}: `);

    it("pins the route in the project's policy and plans the agent scenario as executable", async () => {
      const planned = await plannedWithApplicationIntent({ rows: agentRows, scenarios: agentScenarios, brokerExtra: { e2eAgentInstallation: async () => anthropic } });
      expect(planned.policy.modelRouteRevision).toMatch(/^r1-[a-f0-9]{12}$/);
      expect((await decide(planned, "APPROVE")).status).toBe(200);
      expect(E2EApplicationSelectionRecordSchema.parse(workflowOf(planned).e2e!.applicationSelection).unavailableCriteria).toEqual([]);
    });

    it("goes past the route check while the installation is unchanged (what stops it is the candidate export)", async () => {
      const { dispatched } = await agentRound({ current: async () => anthropic });
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow.blockReason).toContain("no committed source export");
    });

    it("blocks with model-route-changed-reapprove when the installation's provider changed since the setup was approved", async () => {
      const state = { current: async () => anthropic as Record<string, unknown> };
      const { dispatched } = await agentRound(state);
      state.current = async () => ({ provider: "amazon-bedrock", region: "us-east-1" });
      await expectBlockedAtDispatch(dispatched, reason("model-route-changed-reapprove"));
      expect(dispatched.taskNow().workflow.blockReason).toContain("The AI navigation settings changed");
    });

    const awsError = (name: string, status?: number) => Object.assign(new Error(name), { name, ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }) });
    const latestRead = (input: Record<string, unknown>) => String((input.Key as { sk?: string } | undefined)?.sk).startsWith("E2E_MODEL_ROUTE_LATEST#");
    const budgetRead = (input: Record<string, unknown>) => String((input.Key as { sk?: string } | undefined)?.sk).startsWith("E2E_MODEL_BUDGET#");

    describe("a fault that is not deterministic stays retryable (Ruling M4-AE): the dispatch row is kept, with its attempt counted, and the task is not blocked", () => {
      async function expectRetryable(dispatched: Awaited<ReturnType<typeof atChecksDispatch>>) {
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
        expect(dispatched.taskNow().workflow.blockReason).toBeUndefined();
        expect(dispatched.dispatchRow()).toMatchObject({ attempts: 1 });
        expect(dispatched.checksOperations()).toEqual([]);
      }

      it.each([["DynamoDB throttling", awsError("ProvisionedThroughputExceededException")], ["DynamoDB request limit", awsError("RequestLimitExceeded")],
        ["DynamoDB throttling by name", awsError("ThrottlingException")], ["an InternalServerError", awsError("InternalServerError")], ["a 503", awsError("ServiceUnavailable", 503)],
        ["an abort", awsError("AbortError")], ["a timeout", awsError("TimeoutError")]])(
        "when the registry read fails with %s", async (_name, error) => {
          const { planned, dispatched } = await agentRound({ current: async () => anthropic });
          planned.harness.db.injectFault({ command: "GetCommand", match: latestRead, error, times: 1 });
          await expectRetryable(dispatched);
        });

      it("when the budget row read fails with throttling", async () => {
        const { planned, dispatched } = await agentRound({ current: async () => anthropic });
        planned.harness.db.injectFault({ command: "GetCommand", match: budgetRead, error: awsError("ThrottlingException"), times: 1 });
        await expectRetryable(dispatched);
      });

      it.each([["SSM throttling", awsError("ThrottlingException")], ["an SSM 5xx", awsError("InternalServerError", 500)], ["a network error", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" })]])(
        "when the installation's settings fail with %s", async (_name, error) => {
          const state = { current: async () => anthropic as Record<string, unknown> };
          const { dispatched } = await agentRound(state);
          state.current = async () => { throw error; };
          await expectRetryable(dispatched);
        });

      it("and the next sweep, once the fault is gone, goes on to the candidate checks", async () => {
        const { planned, dispatched } = await agentRound({ current: async () => anthropic });
        planned.harness.db.injectFault({ command: "GetCommand", match: latestRead, error: awsError("ThrottlingException"), times: 1 });
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow.state).toBe("WAITING");
        // The backoff is not waited out here: the row is made due again.
        planned.harness.db.set({ ...dispatched.dispatchRow()!, dispatchDueSk: `2000-01-01T00:00:00.000Z#${String(dispatched.dispatchRow()!.sk)}`, nextAttemptAt: "2000-01-01T00:00:00.000Z" });
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow.blockReason).toContain("no committed source export");
      });
    });

    describe("a refusal that is deterministic is a terminal block with its code", () => {
      it.each([["settings that are missing (ParameterNotFound)", awsError("ParameterNotFound")], ["settings that cannot be read for want of permission (AccessDenied)", awsError("AccessDeniedException")],
        ["settings that fail for a reason of their own", new Error("ssm down")]])("for %s", async (_name, error) => {
        const state = { current: async () => anthropic as Record<string, unknown> };
        const { dispatched } = await agentRound(state);
        state.current = async () => { throw error; };
        await expectBlockedAtDispatch(dispatched, reason("agent-route-not-approved"));
        expect(dispatched.taskNow().workflow.blockReason).toMatch(/could not be read/);
      });

      it("for a registry read that is denied", async () => {
        const { planned, dispatched } = await agentRound({ current: async () => anthropic });
        planned.harness.db.injectFault({ command: "GetCommand", match: latestRead, error: awsError("AccessDeniedException"), times: 5 });
        await expectBlockedAtDispatch(dispatched, reason("agent-route-not-approved"));
      });

      it("for a latest-route row that is malformed", async () => {
        const { planned, dispatched } = await agentRound({ current: async () => anthropic });
        const row = planned.harness.db.get("E2E_MODEL_ROUTES", "E2E_MODEL_ROUTE_LATEST#rovara-e2e-default")!;
        planned.harness.db.set({ ...row, revisionNumber: "not-a-number" });
        await expectBlockedAtDispatch(dispatched, reason("agent-route-not-approved"));
      });
    });

    it("blocks with model-route-budget-exhausted before anything starts when the project's day has no room", async () => {
      const { planned, dispatched } = await agentRound({ current: async () => anthropic });
      planned.harness.db.set({ pk: "PROJECT#payments", sk: `E2E_MODEL_BUDGET#${new Date().toISOString().slice(0, 10)}`, inputTokens: 1_999_000, calls: 10 });
      await expectBlockedAtDispatch(dispatched, reason("model-route-budget-exhausted"));
    });

    it("does not judge the route for a round with no AI navigation step", async () => {
      const planned = await plannedWithApplicationIntent({ rows: agentRows, brokerExtra: { e2eAgentInstallation: async () => anthropic } });
      const dispatched = await atChecksDispatch(planned);
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow.blockReason).toContain("no committed source export");
    });
  });

  describe("the selection approved at plan APPROVE must still be the one dispatched (Ruling AL)", () => {
    const refusalPrefix = WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX;
    const reasonOf = (text: string) => new RegExp(refusalPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + text, "s");
    const runtimeReasonOf = (text: string) => new RegExp(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + text, "s");

    it("passes the unchanged selection through the check (it is the only thing left standing between it and the round)", async () => {
      const dispatched = await atChecksDispatch(await plannedWithApplicationIntent());
      await dispatched.runDispatch();
      // Not the "no longer run as approved" refusal: the selection derived again equals the recorded one. What stops it is the next input, the candidate export.
      expect(dispatched.taskNow().workflow.blockReason).not.toContain(refusalPrefix);
      expect(dispatched.taskNow().workflow.blockReason).toContain("no committed source export");
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
      await expectBlockedAtDispatch(dispatched, runtimeReasonOf(".*web runtime of profile linux-arm64-web-api-v1"));
    });

    it("refuses when the row expired", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, expiresAt: new Date(Date.now() - 1_000).toISOString() });
      await expectBlockedAtDispatch(dispatched, runtimeReasonOf(".*web runtime of profile linux-arm64-web-api-v1"));
    });

    it("refuses when the row's runtime binding moved", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      const other = { ...planned.projectBinding, launchTemplateId: "lt-fedcba9876543210" };
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, binding: other, bindingDigest: shaCanonical(other) });
      await expectBlockedAtDispatch(dispatched, runtimeReasonOf(".*web runtime of profile linux-arm64-web-api-v1"));
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

    it("refuses before warming the workspace, so a refused v2 task never wakes its compute (no readiness operation exists yet)", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned, { seedReadiness: false });
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
      const workspaceBefore = dispatched.workspaceNow();
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect(dispatched.taskNow().workflow.blockReason).toMatch(reasonOf("the web runtime"));
      expect(dispatched.readinessOperations(), "no warm-up operation was started").toEqual([]);
      expect(dispatched.workspaceNow(), "the workspace was not touched").toEqual(workspaceBefore);
      expect(dispatched.dispatchRow()).toBeUndefined();
    });

    it("pauses a v2 task whose creator lost access for access, instead of blocking it with the application reason (creator check first)", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned, { seedReadiness: false });
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
      const creator = planned.harness.db.get(`DEVELOPER#${MAYA.developerId}`, "META")!;
      planned.harness.db.set({ ...creator, revoked: true });
      const original = dispatched.dispatchRow()!;
      await dispatched.runDispatch();
      // Parked on its durable row for a later explicit owner action: not blocked, not retried, nothing warmed.
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
      expect(dispatched.dispatchRow()).toMatchObject({ kind: "CHECKS" });
      expect(dispatched.dispatchRow()?.taskAccessPausedAt).toEqual(expect.any(String));
      expect(dispatched.readinessOperations()).toEqual([]);
      // Once the creator is restored the same refusal applies.
      planned.harness.db.set({ ...creator, revoked: false });
      planned.harness.db.set(original);
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect(dispatched.taskNow().workflow.blockReason).toMatch(reasonOf("the web runtime"));
    });

    it("names the real remedy: retry the checks, which approves the plan again against the rows that are ready now", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow.blockReason).toMatch(/Retry the checks to approve the plan again against what is ready now/);
    });

    /** Fails the first transaction that deletes the dispatch row (the block write), and lets every later one through. */
    function failFirstBlockWrite(harness: Harness) {
      const send = harness.db.send.bind(harness.db);
      let failed = 0;
      harness.db.send = async (command) => {
        const items = (command as { input?: { TransactItems?: Array<{ Delete?: { Key?: { pk?: string } } }> } }).input?.TransactItems;
        if (failed === 0 && command.constructor.name === "TransactWriteCommand" && items?.some((item) => item.Delete?.Key?.pk === "WORKFLOW_DISPATCH")) {
          failed += 1;
          throw new Error("write failed");
        }
        return send(command);
      };
      return () => { harness.db.send = send; };
    }

    it("falls back to the bounded retry when the block cannot be written, and does not lose the task", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned);
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
      const restore = failFirstBlockWrite(planned.harness);
      try { await dispatched.runDispatch(); } finally { restore(); }
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
      expect(dispatched.dispatchRow()).toMatchObject({ attempts: 1, kind: "CHECKS" });
      expect(dispatched.checksOperations()).toEqual([]);
    });

    it("ends with the refusal's own reason, not the generic one, when the block keeps failing until the retry budget is spent", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned, { attempts: 9 });
      planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
      const restore = failFirstBlockWrite(planned.harness);
      try { await dispatched.runDispatch(); } finally { restore(); }
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect(dispatched.taskNow().workflow.blockReason).toMatch(reasonOf("the web runtime"));
      expect(dispatched.taskNow().workflow.blockReason).not.toBe(WORKFLOW_BLOCK_REASONS.checksUnconfirmed);
      expect(dispatched.dispatchRow()).toBeUndefined();
    });

    it("gives up on a selection that can never be read once the retry budget is spent, with the generic checks-unconfirmed reason", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atChecksDispatch(planned, { attempts: 9 });
      const send = planned.harness.db.send.bind(planned.harness.db);
      planned.harness.db.send = async (command) => {
        const input = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input;
        if (command.constructor.name === "GetCommand" && input?.Key?.pk === webKey.pk && input.Key.sk === webKey.sk) throw new Error("throttled");
        return send(command);
      };
      try { await dispatched.runDispatch(); } finally { planned.harness.db.send = send; }
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checksUnconfirmed });
      expect(dispatched.dispatchRow()).toBeUndefined();
      expect(dispatched.checksOperations()).toEqual([]);
    });
  });

  // ---- Task 2.4c: a real single-kind round ----

  describe("dispatching an approved application round (Task 2.4c)", () => {
    afterEach(disposeRealCandidates);
    const ORDERS_TREE = { "package.json": ordersContractManifest, "src/orders.js": "export const orders = [];\n" };
    type BuildSourceSeed = "READY" | "absent" | "REFUSED" | "another-candidate" | "another-digest" | "another-tree" | "no-object" | "tampered-object" | "export-record-differs";

    /**
     * Puts the task at CHECKS dispatch on a real committed candidate whose export and build source are stored exactly as the broker stores them after an IMPLEMENT
     * run: the export object, the IMPLEMENT operation's `candidateSourceRef` and `candidateBuildSource`, the export record's `buildSource` and the manifest object.
     */
    async function atApplicationDispatch(planned: Planned, options: { buildSource?: BuildSourceSeed; withoutExport?: boolean; seedReadiness?: boolean; tree?: Record<string, string> } = {}) {
      const real = await createRealCandidate(options.tree ?? ORDERS_TREE, { repositoryId: "demo", baseCommitSha: planned.snapshot.commitSha });
      const dispatched = await atChecksDispatch(planned, { candidate: real.source.candidate, ...(options.seedReadiness === undefined ? {} : { seedReadiness: options.seedReadiness }) });
      const { harness, workspaceId } = planned;
      // The coding run that produced the candidate is over: its operation is done and the workspace is free for the CHECKS operation.
      for (const operation of harness.db.find((row) => row.pk === `WORKSPACE#${workspaceId}` && row.entityType === "OPERATION" && row.workflowMode === "IMPLEMENT")) harness.db.set({ ...operation, status: "SUCCEEDED" });
      const { activeOperationId: _active, ...freed } = harness.db.get(`WORKSPACE#${workspaceId}`, "META")!;
      void _active;
      harness.db.set({ ...freed, status: "READY" });
      const seed = options.buildSource ?? "READY";
      if (options.withoutExport !== true) {
        const exportText = JSON.stringify(real.source);
        const exportKey = `workflow-candidate-sources/sha256/${sha(exportText)}.json`;
        harness.s3.objects.set(exportKey, exportText);
        const other = seed === "another-candidate" ? await createRealCandidate({ ...(options.tree ?? ORDERS_TREE), "src/extra.js": "export const extra = 1;\n" }, { repositoryId: "demo", baseCommitSha: planned.snapshot.commitSha }) : undefined;
        const refused = { status: "REFUSED" as const, reason: "the worker could not export a build source manifest: a source file is over the per-file limit", candidateDigest: real.source.candidate.digest };
        const stored = seed === "absent" ? undefined : seed === "REFUSED" ? refused : seed === "another-candidate" ? other!.stored
          : seed === "another-digest" ? { ...real.stored, candidateDigest: "9".repeat(64) } : seed === "another-tree" ? { ...real.stored, treeSha: "9".repeat(40) } : real.stored;
        const manifestText = seed === "tampered-object" ? real.manifestBytes.toString("utf8").replace("candidate-index-tree", "candidate-index-tree ").replace("committed-tree", "committed-tree ") : real.manifestBytes.toString("utf8");
        if (stored?.status === "READY" && seed !== "no-object") harness.s3.objects.set(stored.manifestRef.key, seed === "another-candidate" ? other!.manifestBytes.toString("utf8") : manifestText);
        const operationId = randomUUID();
        const at = new Date(Date.now() + 1000).toISOString();
        harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId, workspaceId, kind: "task", workflowMode: "IMPLEMENT", status: "SUCCEEDED",
          fence: 1, requestId: randomUUID(), payloadHash: "a".repeat(64), createdAt: at, updatedAt: at,
          candidateSourceRef: { key: exportKey, sha256: sha(exportText), byteLength: Buffer.byteLength(exportText), candidateDigest: real.source.candidate.digest },
          ...(stored === undefined ? {} : { candidateBuildSource: stored }) });
        harness.db.set({ pk: `WORKSPACE#${workspaceId}`, sk: `CANDIDATE_EXPORT#${operationId}`, entityType: "WORKFLOW_CANDIDATE_EXPORT", schemaVersion: 1, operationId, status: "COMPLETE", createdAt: at,
          ...(stored === undefined ? {} : { buildSource: seed === "export-record-differs" ? refused : stored }) });
      }
      return { ...dispatched, real, candidate: real.source.candidate };
    }
    type AtApplication = Awaited<ReturnType<typeof atApplicationDispatch>>;
    const operationRef = (dispatched: AtApplication) => E2EWorkflowAdmissionRefSchema.parse(dispatched.checksOperations()[0]!.workflowE2EAdmission);

    it("starts one CHECKS operation carrying exactly one application admission the worker decodes, for the exported commit and tree", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atApplicationDispatch(planned);
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow, JSON.stringify(dispatched.taskNow().workflow)).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
      expect(dispatched.checksOperations()).toHaveLength(1);
      expect(dispatched.dispatchRow()).toBeUndefined();
      // The one admission is an application admission, stored content addressed and read back by the worker through its immutable reference.
      expect(dispatched.admissionObjects()).toHaveLength(1);
      noPortableAdmission(dispatched);
      const ref = operationRef(dispatched);
      const bytes = planned.harness.s3.objects.get(ref.admissionRef.key)!;
      expect(sha(bytes)).toBe(ref.admissionRef.sha256);
      expect(Buffer.byteLength(bytes)).toBe(ref.admissionRef.byteLength);
      const admission = decodeE2EApplicationExecutionAdmission(bytes);
      expect(() => validateE2EApplicationExecutionAdmission(admission)).not.toThrow();
      expect(admission.candidateCommitSha).toBe(dispatched.real.identity.commitSha);
      expect(admission.candidateTreeSha).toBe(dispatched.real.identity.treeSha);
      expect(admission.sourceSnapshot).toMatchObject({ commitSha: dispatched.real.identity.commitSha, treeSha: dispatched.real.identity.treeSha });
      expect(admission.candidateDigest).toBe(dispatched.candidate.digest);
      expect(admission.taskId).toBe(planned.taskId);
      expect(admission.portableProjection).toBeNull();
      // Nothing else runs it: a second pass finds no dispatch row and starts nothing more.
      await dispatched.runDispatch();
      expect(dispatched.checksOperations()).toHaveLength(1);
      expect(dispatched.admissionObjects()).toHaveLength(1);
    });

    it("records, for verification of the round, its id, the per-group run ids and the admission digest on the operation and the workflow", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atApplicationDispatch(planned);
      await dispatched.runDispatch();
      const operation = dispatched.checksOperations()[0]!;
      const ref = operationRef(dispatched);
      const admission = decodeE2EApplicationExecutionAdmission(planned.harness.s3.objects.get(ref.admissionRef.key)!);
      expect(ref).toMatchObject({ taskId: planned.taskId, candidateDigest: dispatched.candidate.digest, roundId: admission.round.roundId, admissionRef: { sha256: sha(planned.harness.s3.objects.get(ref.admissionRef.key)!) } });
      expect(ref.groupRunIds).toEqual(admission.round.groupBindings.map((binding) => binding.runId));
      expect(ref.groupRunIds).toEqual(admission.groups.map((group) => group.outerBinding.runId));
      expect(ref.groupRunIds.length).toBeGreaterThan(0);
      expect(admission.operationId).toBe(operation.id);
      expect(admission.operationFence).toBe(operation.fence);
      const workflow = workflowOf(planned);
      expect(workflow.e2e).toMatchObject({ currentRoundId: ref.roundId, currentGroupRunIds: ref.groupRunIds });
      expect(admission.workflowRevision).toBe(workflow.revision);
      // The admission digest identifies exactly the stored content.
      const { admissionDigest, ...body } = admission;
      expect(admissionDigest).toBe(shaCanonical(body));
      // The worker is handed the same reference in its CHECKS invocation.
      const outbox = planned.harness.db.find((row) => row.entityType === "OUTBOX" && row.operationId === operation.id)[0]!;
      expect((outbox.invocation as { payload: { workflowE2EAdmission?: unknown } }).payload.workflowE2EAdmission).toEqual(ref);
    });

    describe("blocks with a specific reason, never a portable fallback and never a loop, when", () => {
      const cases: Array<[string, Parameters<typeof atApplicationDispatch>[1], RegExp]> = [
        ["the candidate has no committed source export", { withoutExport: true }, /no committed source export/],
        ["no build source manifest was exported for the candidate", { buildSource: "absent" }, /no build source manifest was exported for this candidate/],
        ["the export refused its build source, with the stored reason", { buildSource: "REFUSED" }, /the worker could not export a build source manifest: a source file is over the per-file limit/],
        ["the stored manifest is for another candidate", { buildSource: "another-candidate" }, /build source.*(another|different).*(candidate|commit|tree)/i],
        ["the stored build source record names another candidate digest, with the same commit and tree", { buildSource: "another-digest" }, /build source record is for another candidate/i],
        ["the stored build source record names another tree than the export holds", { buildSource: "another-tree" }, /build source is for another commit or tree/i],
        ["the stored manifest object is missing", { buildSource: "no-object" }, /build source manifest.*(missing|unavailable|not found)/i],
        ["the stored manifest object is not the bytes its record names", { buildSource: "tampered-object" }, /build source manifest.*(changed|digest|differs|does not match)/i],
        ["the export record and the operation disagree about the build source", { buildSource: "export-record-differs" }, /build source.*(disagree|differ|does not match)/i],
        ["the candidate's application metadata changed since the setup was approved", { tree: { ...ORDERS_TREE, "package.json": JSON.stringify({ ...(JSON.parse(ordersContractManifest) as Record<string, unknown>), description: "changed after setup approval" }) } },
          /changed since setup approval|replan|metadata|source/i],
      ];
      for (const [name, options, reason] of cases) {
        it(name, async () => {
          const dispatched = await atApplicationDispatch(await plannedWithApplicationIntent(), options);
          await expectBlockedAtDispatch(dispatched, reason);
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX);
          expect(dispatched.taskNow().workflow.blockReason!.length).toBeLessThanOrEqual(500);
          noPortableAdmission(dispatched);
        });
      }

      it("the approved runtime row changed since approval, before anything is read from the export (Ruling AL, byte-exact)", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned);
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
        await expectBlockedAtDispatch(dispatched, /can no longer run as approved.*web runtime/s);
        expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
      });
    });

    it("refuses before warming the workspace when the candidate's build source was refused, so compute is never woken for a round that cannot run", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atApplicationDispatch(planned, { buildSource: "REFUSED", seedReadiness: false });
      const workspaceBefore = dispatched.workspaceNow();
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect(dispatched.taskNow().workflow.blockReason).toMatch(/per-file limit/);
      expect(dispatched.readinessOperations()).toEqual([]);
      expect(dispatched.workspaceNow()).toEqual(workspaceBefore);
      expect(dispatched.dispatchRow()).toBeUndefined();
    });

    it("warms the workspace first for a round that can run, and waits for it: nothing is blocked and nothing admitted yet", async () => {
      const planned = await plannedWithApplicationIntent();
      const dispatched = await atApplicationDispatch(planned, { seedReadiness: false });
      await dispatched.runDispatch();
      expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
      expect(dispatched.readinessOperations()).toHaveLength(1);
      expect(dispatched.checksOperations()).toEqual([]);
      expect(dispatched.admissionObjects()).toEqual([]);
      expect(dispatched.dispatchRow()).toMatchObject({ kind: "CHECKS" });
    });

    describe("the owner's way out of a blocked application round", () => {
      const selectionOf = (planned: Planned) => E2EApplicationSelectionRecordSchema.parse(workflowOf(planned).e2e!.applicationSelection);
      const retry = (planned: Planned, dispatched: AtApplication) => planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/retry`,
        { requestId: randomUUID(), expectedRevision: dispatched.taskNow().workflow.revision, instructions: "Approve the plan again against the runtime that is ready now" });

      it("offers retrying the checks, which approves the same plan again against the rows that are there now, and the round then starts (Ruling AL stays byte-exact)", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned);
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
        const approvedBefore = selectionOf(planned);
        expect(approvedBefore.runtimeRows[0]).toMatchObject({ generation: 4 });
        const artifact = workflowOf(planned).artifacts.at(-1)!;

        const retried = await retry(planned, dispatched);
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "WAITING" });
        const approvedAfter = selectionOf(planned);
        // The same plan, approved again against the row that is ready now.
        expect(approvedAfter.runtimeRows[0]).toMatchObject({ generation: 5 });
        expect(approvedAfter.semanticApproval).toEqual({ artifactId: artifact.id, digest: artifact.sha256 });
        expect(approvedAfter.intentDigest).toBe(approvedBefore.intentDigest);
        expect(workflowOf(planned).e2e).toMatchObject({ contractDigest: artifact.sha256, required: true });
        expect(dispatched.dispatchRows().filter((row) => row.workflowRevision === dispatched.taskNow().workflow.revision)).toHaveLength(1);

        dispatched.reseedReadiness();
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
        expect(dispatched.checksOperations()).toHaveLength(1);
        // And the comparison is still exact: a row that moves again after this approval blocks again.
      });

      describe("when the test account the plan was approved with is registered again (Task 3.1)", () => {
        /** The next revision of the target's account, as an approval of the setup writes it when a definition changes or expires: same contract, a later expiry. */
        const registerNextRevision = (planned: Planned, edit: (definition: Record<string, unknown>) => Record<string, unknown> = (definition) => definition) => {
          const profileId = planned.target.accountProfileId;
          const latest = planned.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#") && String(row.sk).endsWith(`#${profileId}`))[0]!;
          const current = planned.harness.db.get("PROJECT#payments", String(latest.sk).replace("E2E_ACCOUNT_LATEST#", "E2E_ACCOUNT#") + "#REV#1")!;
          const { pk: _pk, sk: _sk, entityType: _entity, ...body } = current;
          void _pk; void _sk; void _entity;
          const next = edit({ ...body, revision: 2, expiresAt: new Date(Date.now() + 100 * 86_400_000).toISOString() });
          const definition = E2EApplicationAccountDefinitionSchema.parse(next);
          planned.harness.db.set({ pk: current.pk, sk: String(current.sk).replace("#REV#1", "#REV#2"), entityType: "E2E_ACCOUNT", ...definition });
          planned.harness.db.set({ ...latest, revision: 2, definitionDigest: e2eApplicationAccountDefinitionDigest(definition) });
          return deriveE2EApplicationRuntimeAccountRef(definition);
        };

        it("blocks the dispatch with accounts-changed-reapprove, offers retry (not send-back), and the retry approves the same plan against the new revision, after which the round starts", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          const approvedBefore = selectionOf(planned);
          expect(approvedBefore.accountRefs).toMatchObject([{ profileId: planned.target.accountProfileId, revision: 1 }]);
          const next = registerNextRevision(planned);
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
          const { blockReason } = dispatched.taskNow().workflow;
          expect(blockReason).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
          expect(blockReason).toContain("accounts-changed-reapprove");
          expect(blockReason).toContain(planned.target.accountProfileId);
          expect(blockReason!.length).toBeLessThanOrEqual(500);
          expect(dispatched.checksOperations()).toEqual([]);
          const task = dispatched.taskNow() as unknown as { workflow: Parameters<typeof workflowSendBackOffered>[0] & Parameters<typeof workflowApplicationRetryOffered>[0] };
          expect(workflowSendBackOffered(task.workflow)).toBe(false);
          expect(workflowApplicationRetryOffered(task.workflow)).toBe(true);

          const artifact = workflowOf(planned).artifacts.at(-1)!;
          const planText = planned.harness.s3.objects.get(artifact.objectKey)!;
          expect((await retry(planned, dispatched)).status).toBe(200);
          // The plan is the one the owner approved (it still carries the first revision's ref); the selection pins the revision registered now.
          expect(planned.harness.s3.objects.get(artifact.objectKey)).toBe(planText);
          expect(planText).toContain(approvedBefore.accountRefs[0]!.definitionDigest);
          const approvedAfter = selectionOf(planned);
          expect(approvedAfter.accountRefs).toEqual([next]);
          expect(approvedAfter.intentDigest).toBe(approvedBefore.intentDigest);
          expect(workflowOf(planned).e2e!.applicationReapprovals).toHaveLength(1);

          dispatched.reseedReadiness();
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
          const admission = decodeE2EApplicationExecutionAdmission(planned.harness.s3.objects.get(E2EWorkflowAdmissionRefSchema.parse(dispatched.checksOperations()[0]!.workflowE2EAdmission).admissionRef.key)!);
          expect(admission.selectionInput.runtimeAccountRefs).toEqual([next]);
          expect(admission.intent.runtimeAccountRefs).toEqual([next]);
        });

        it("blocks the dispatch when the pinned definition has expired, and a retry is refused while no newer one is registered", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          const profileId = planned.target.accountProfileId;
          const latest = planned.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#") && String(row.sk).endsWith(`#${profileId}`))[0]!;
          const definitionRow = planned.harness.db.get("PROJECT#payments", String(latest.sk).replace("E2E_ACCOUNT_LATEST#", "E2E_ACCOUNT#") + "#REV#1")!;
          const { pk: _pk, sk: _sk, entityType: _entity, ...body } = definitionRow;
          void _pk; void _sk; void _entity;
          const expired = E2EApplicationAccountDefinitionSchema.parse({ ...body, expiresAt: new Date(Date.now() - 1_000).toISOString() });
          planned.harness.db.set({ ...definitionRow, ...expired });
          planned.harness.db.set({ ...latest, definitionDigest: e2eApplicationAccountDefinitionDigest(expired) });
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
          expect(dispatched.taskNow().workflow.blockReason).toMatch(/accounts-changed-reapprove.*expired/);
          expect(dispatched.checksOperations()).toEqual([]);
          // Approving again cannot help while the registry holds only the expired definition: the owner is told so, and nothing changes.
          const before = workflowOf(planned);
          const retried = await retry(planned, dispatched);
          expect(retried.status).toBeGreaterThanOrEqual(400);
          expect(errorOf(retried).message).toMatch(/accounts-changed-reapprove.*expired/);
          expect(workflowOf(planned)).toEqual(before);
        });

        it("refuses a definition the approved contract no longer stands behind (a changed role), even when it is the latest", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          registerNextRevision(planned, (definition) => ({ ...definition, roleRef: "admin" }));
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
          expect((await retry(planned, dispatched)).status).toBeGreaterThanOrEqual(400);
          expect(dispatched.checksOperations()).toEqual([]);
        });

        /** A newer setup approved and registered as a new project revision: the synthetic account's role changes, so it gets a revision of its own contract. */
        const registerNewerSetup = async (planned: Planned) => {
          const admin = { subject: "admin-subject", admin: true };
          planned.capture.mockImplementation(async () => snapshotOf({ "package.json": ordersManifestWith((e2e) => {
            e2e.accountProfiles.find((profile) => profile.profileId === planned.target.accountProfileId)!.roleRef = "editor";
          }) }));
          const proposal = await call(planned.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
          expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
          const approved = await call(planned.harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
            body: { projectName: "payments", proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision: "approve" } });
          expect(approved.status, JSON.stringify(approved.body)).toBe(200);
          const definition = planned.projectRow().definition as Record<string, unknown> & { revision: number };
          const latestRevision = Math.max(...planned.harness.db.find((row) => row.entityType === "PROJECT").map((row) => Number((row.definition as { revision: number }).revision)));
          const registered = await call(planned.harness.handler, { method: "POST", path: "/v1/admin/projects", user: admin,
            body: { definition: { ...definition, revision: latestRevision + 1, e2e: proposal.body.policy }, runtimeBinding: planned.projectRow().runtimeBinding,
              setupApproval: { proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision: "approve" } } });
          expect(registered.status, JSON.stringify(registered.body)).toBe(201);
        };
        const accountRevision = (planned: Planned) => (planned.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).startsWith("E2E_ACCOUNT_LATEST#")
          && String(row.sk).endsWith(`#${planned.target.accountProfileId}`))[0] as unknown as { revision: number }).revision;

        it("does not strand a task pinned to an older project revision: its own line of definitions still runs, and a retry re-approves within that line, recording which account moved", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          const approvedBefore = selectionOf(planned);
          // Revision 1 is the approval's. Revision 2 is the same contract renewed; revision 3 comes with a newer setup (another contract).
          const renewed = registerNextRevision(planned);
          await registerNewerSetup(planned);
          expect(accountRevision(planned)).toBe(3);
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
          expect(dispatched.taskNow().workflow.blockReason).toMatch(/revision 1.*revision 2/);
          const task = dispatched.taskNow() as unknown as { workflow: Parameters<typeof workflowApplicationRetryOffered>[0] };
          expect(workflowApplicationRetryOffered(task.workflow)).toBe(true);

          expect((await retry(planned, dispatched)).status).toBe(200);
          // The retry pins the newest definition this task's contract stands behind (revision 2), not the newer setup's (revision 3).
          expect(selectionOf(planned).accountRefs).toEqual([renewed]);
          const audit = workflowOf(planned).e2e!.applicationReapprovals as Array<{ accounts?: unknown }>;
          expect(audit).toHaveLength(1);
          expect(audit[0]!.accounts).toEqual([{ applicationId: approvedBefore.accountRefs[0]!.applicationId, profileId: planned.target.accountProfileId, from: 1, to: 2 }]);
          dispatched.reseedReadiness();
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
        });

        it("keeps running a task pinned to an older project revision while its own definition is the newest its contract stands behind", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          await registerNewerSetup(planned);
          expect(accountRevision(planned)).toBe(2);
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
          expect(dispatched.checksOperations()).toHaveLength(1);
        });

        it("tells a stranded task's owner what to do, in the block and in the retry's refusal, once its own line has expired", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          await registerNewerSetup(planned);
          const first = planned.harness.db.find((row) => row.pk === "PROJECT#payments" && String(row.sk).includes("#REV#1") && String(row.sk).endsWith(`${planned.target.accountProfileId}#REV#1`))[0]!;
          planned.harness.db.set({ ...first, expiresAt: new Date(Date.now() - 1_000).toISOString() });
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ACCOUNTS_CHANGED_PREFIX);
          const before = workflowOf(planned);
          const retried = await retry(planned, dispatched);
          expect(retried.status).toBeGreaterThanOrEqual(400);
          expect(errorOf(retried).message).toMatch(/accounts-changed-reapprove/);
          expect(errorOf(retried).message).toMatch(/start the task again on the current project revision|expired/);
          expect(workflowOf(planned)).toEqual(before);
        });

        it("keeps the commit fenced on the account pointer: an approval that read revision 1 does not commit once revision 2 is registered", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          const fence = (await import("../../packages/broker/src/aws/e2e-account-registry.js")).accountRegistryFences;
          const entries = accountRegistryEntriesFromRows("payments", planned.harness.db.find((row) => row.pk === "PROJECT#payments"));
          const items = fence({ tableName: "state", projectId: "payments", refs: selectionOf(planned).accountRefs, entries });
          expect(items).toHaveLength(1);
          registerNextRevision(planned);
          const check = (items[0] as unknown as { ConditionCheck: { Key: { pk: string; sk: string }; ExpressionAttributeValues: Record<string, unknown> } }).ConditionCheck;
          expect(planned.harness.db.get(check.Key.pk, check.Key.sk)).toMatchObject({ revision: 2 });
          expect(check.ExpressionAttributeValues[":revision"]).toBe(1);
          void dispatched;
        });
      });

      it("does not loosen the comparison: a row that moves after the plan is approved again blocks the next dispatch again", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned);
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
        await dispatched.runDispatch();
        expect((await retry(planned, dispatched)).status).toBe(200);
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 6 });
        dispatched.reseedReadiness();
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
        expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
        expect(dispatched.checksOperations()).toEqual([]);
      });

      it("refuses the retry, saying why and changing nothing, when the plan cannot be approved against what is ready now", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned);
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
        await dispatched.runDispatch();
        const before = workflowOf(planned);
        planned.harness.db.delete(webKey.pk, webKey.sk);
        const retried = await retry(planned, dispatched);
        expect(retried.status).toBeGreaterThanOrEqual(400);
        expect(errorOf(retried).message).toMatch(/web runtime.*READY|cannot be approved/i);
        expect(workflowOf(planned)).toEqual(before);
        expect(dispatched.dispatchRows()).toEqual([]);
      });

      it("re-approves on a retry whatever block came before (a refused round included), so one retry after the cause is fixed is enough", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned, { buildSource: "REFUSED" });
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX);
        const recorded = selectionOf(planned);
        const retried = await retry(planned, dispatched);
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        const again = selectionOf(planned);
        expect({ ...again, evaluatedAt: "" }).toEqual({ ...recorded, evaluatedAt: "" });
        expect(workflowOf(planned).e2e!.applicationReapprovals).toHaveLength(1);
      });

      it("records every re-approval in the task's history with the actor, the reason and the old and new selection digests (Ruling BQ(2))", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned);
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
        await dispatched.runDispatch();
        const before = selectionOf(planned);
        const workflowBefore = workflowOf(planned);
        const requestId = randomUUID();
        const retried = await planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/retry`,
          { requestId, expectedRevision: dispatched.taskNow().workflow.revision, instructions: "The runtime was requalified; approve the plan again" });
        expect(retried.status, JSON.stringify(retried.body)).toBe(200);
        const after = selectionOf(planned);
        const history = workflowOf(planned).e2e!.applicationReapprovals as Array<Record<string, unknown>>;
        expect(history).toHaveLength(1);
        const fingerprint = (record: typeof before) => ({ selectionDigest: shaCanonical(record), intentDigest: record.intentDigest, executableTargetIds: record.executableTargetIds, runtimeRowsDigest: shaCanonical(record.runtimeRows) });
        expect(history[0]).toMatchObject({ requestId, actorId: (workflowBefore as unknown as { ownerId: string }).ownerId, reason: "The runtime was requalified; approve the plan again",
          previous: fingerprint(before), current: fingerprint(after) });
        expect(typeof history[0]!.at).toBe("string");
        // The two selections differ exactly where the rows do, and the digests say so.
        expect((history[0]!.previous as { runtimeRowsDigest: string }).runtimeRowsDigest).not.toBe((history[0]!.current as { runtimeRowsDigest: string }).runtimeRowsDigest);
        expect((history[0]!.previous as { intentDigest: string }).intentDigest).toBe((history[0]!.current as { intentDigest: string }).intentDigest);
        // It is visible in the task's turn log as well, with both selections' digests.
        const turns = planned.harness.db.find((row) => String(row.pk).includes(planned.taskId) && JSON.stringify(row).includes(fingerprint(before).selectionDigest.slice(0, 12)));
        expect(turns.length).toBeGreaterThan(0);
        // A second re-approval appends and never replaces.
        planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 6 });
        dispatched.reseedReadiness();
        await dispatched.runDispatch();
        expect(dispatched.taskNow().workflow).toMatchObject({ state: "BLOCKED" });
        expect((await retry(planned, dispatched)).status).toBe(200);
        const twice = workflowOf(planned).e2e!.applicationReapprovals as Array<Record<string, unknown>>;
        expect(twice).toHaveLength(2);
        expect(twice[0]).toEqual(history[0]);
        expect((twice[1]!.previous as { selectionDigest: string }).selectionDigest).toBe(fingerprint(after).selectionDigest);
      });

      describe("the same press from Slack", () => {
        const slackRetry = (planned: Planned, dispatched: AtApplication) => planned.harness.handler({ source: "agentx.slack-ingress", action: "workflow-retry", taskId: planned.taskId,
          userId: MAYA.slackUserId, thread: SLACK_THREAD, requestId: randomUUID(), expectedRevision: dispatched.taskNow().workflow.revision, selectedOptionalCheckIds: [] });
        const refusalsOf = (planned: Planned) => planned.harness.db.find((row) => row.pk === `DEVTASK#${planned.taskId}` && String(row.sk).startsWith("REFUSAL#")).map((row) => String(row.message));
        const blocked = async () => {
          const planned = await plannedWithApplicationIntent({ viaSlack: true });
          const dispatched = await atApplicationDispatch(planned);
          planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
          return { planned, dispatched };
        };

        it("Choose checks and retry approves the plan again, dispatches, and records the re-approval", async () => {
          const { planned, dispatched } = await blocked();
          const answer = await slackRetry(planned, dispatched);
          expect(answer.statusCode, answer.body).toBe(200);
          expect(JSON.parse(answer.body)).not.toMatchObject({ refused: true });
          expect(workflowOf(planned).e2e!.applicationReapprovals).toHaveLength(1);
          expect(dispatched.dispatchRows().filter((row) => row.workflowRevision === dispatched.taskNow().workflow.revision)).toHaveLength(1);
          expect(refusalsOf(planned)).toEqual([]);
        });

        it("says in a plain sentence why a plan that cannot be approved against what is ready now was not approved again", async () => {
          const { planned, dispatched } = await blocked();
          const before = workflowOf(planned);
          planned.harness.db.delete(webKey.pk, webKey.sk);
          const answer = await slackRetry(planned, dispatched);
          expect(answer.statusCode, answer.body).toBe(200);
          const message = String((JSON.parse(answer.body) as { message?: string }).message);
          expect(message).toMatch(/cannot be approved/i);
          expect(message).not.toContain("I couldn't save that");
          expect(refusalsOf(planned)).toEqual([message]);
          expect(workflowOf(planned)).toEqual(before);
        });

        it("says in a plain sentence why the plan was not approved again when the approval check is not installed", async () => {
          const { planned, dispatched } = await blocked();
          const before = workflowOf(planned);
          const original = developerTaskRouteDependencies;
          const spy = vi.spyOn(routes, "developerTaskRouteDependencies").mockImplementation((deps, ...rest) => {
            const without = { ...deps };
            delete without.validateWorkflowE2EApplicationPlan;
            return original(without, ...rest);
          });
          try {
            const answer = await slackRetry(planned, dispatched);
            expect(answer.statusCode, answer.body).toBe(200);
            const message = String((JSON.parse(answer.body) as { message?: string }).message);
            expect(message).toMatch(/plan cannot be approved again here/i);
            expect(message).not.toContain("I couldn't save that");
            expect(refusalsOf(planned)).toEqual([message]);
            expect(workflowOf(planned)).toEqual(before);
          } finally { spy.mockRestore(); }
        });
      });

      describe("a refusal caused by the runtime's state asks for an administrator, not for new code (Fix round 1, I2)", () => {
        const soon = () => new Date(Date.now() + 20_000).toISOString();
        const remedy = (dispatched: AtApplication) => {
          const { blockReason } = dispatched.taskNow().workflow;
          expect(blockReason).toContain(WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX);
          expect(blockReason).toMatch(/administrator must qualify the runtime again.*retry the checks/is);
          expect(blockReason).not.toMatch(/send the task back/i);
          expect(blockReason!.length).toBeLessThanOrEqual(500);
          const task = dispatched.taskNow() as unknown as { workflow: Parameters<typeof workflowSendBackOffered>[0] };
          expect(workflowSendBackOffered(task.workflow)).toBe(false);
        };

        it("a runtime that expires before the round could end: remedy text, no send-back, and one retry after requalification re-approves and dispatches", async () => {
          const planned = await plannedWithApplicationIntent();
          planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, expiresAt: soon() });
          const dispatched = await atApplicationDispatch(planned);
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
          expect(dispatched.taskNow().workflow.blockReason).toMatch(/expires at .* before this round could end/);
          remedy(dispatched);
          expect(dispatched.checksOperations()).toEqual([]);
          // The administrator qualifies the runtime again: a new generation that lives long enough.
          planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
          expect((await retry(planned, dispatched)).status).toBe(200);
          expect(selectionOf(planned).runtimeRows[0]).toMatchObject({ generation: 5 });
          dispatched.reseedReadiness();
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
          expect(dispatched.checksOperations()).toHaveLength(1);
        });

        it("no READY row of the kind: remedy text, a retry that is refused while the runtime is still not READY, and one retry after it is restored", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          const row = planned.harness.db.get(webKey.pk, webKey.sk)!;
          planned.harness.db.set({ ...row, state: "REVOKED" });
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow.blockReason).toMatch(/web runtime of profile linux-arm64-web-api-v1/);
          remedy(dispatched);
          const early = await retry(planned, dispatched);
          expect(early.status).toBeGreaterThanOrEqual(400);
          expect(errorOf(early).message).toMatch(/web runtime.*READY/i);
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
          planned.harness.db.set({ ...row, generation: 5 });
          expect((await retry(planned, dispatched)).status).toBe(200);
          dispatched.reseedReadiness();
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
          expect(dispatched.checksOperations()).toHaveLength(1);
        });

        it("a row that was only replaced keeps the changed-selection text, which also needs no new code", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          planned.harness.db.set({ ...planned.harness.db.get(webKey.pk, webKey.sk)!, generation: 5 });
          await dispatched.runDispatch();
          expect(dispatched.taskNow().workflow.blockReason).toContain(WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX);
          const task = dispatched.taskNow() as unknown as { workflow: Parameters<typeof workflowSendBackOffered>[0] };
          expect(workflowSendBackOffered(task.workflow)).toBe(false);
        });

        it("the task page says the same: ask an administrator then retry for the runtime, retry for a changed selection, send back only for a refused round", () => {
          const snapshot = (blockReason: string) => WorkflowSnapshotSchema.parse({ ...workflowFixtureFor(blockReason) });
          const step = (reason: string) => taskPageStage(snapshot(reason), false, true).nextStep;
          expect(step(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}x`)).toMatch(/administrator.*qualify the runtime again.*retry/i);
          expect(step(`${WORKFLOW_APPLICATION_RUNTIME_UNUSABLE_PREFIX}x`)).not.toMatch(/send it back/i);
          expect(step(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}x`)).toMatch(/retry the checks to approve the plan again/i);
          expect(step(`${WORKFLOW_APPLICATION_SELECTION_CHANGED_PREFIX}x`)).not.toMatch(/send it back/i);
          expect(step(`${WORKFLOW_APPLICATION_ROUND_REFUSED_PREFIX}x`)).toMatch(/send it back to coding/i);
        });
      });

      describe("a stored plan that can no longer be approved (portable or web+api criteria) goes back to planning (Fix round 1, M3)", () => {
        /** The approved plan artifact, replaced by an edited copy as a plan approved before Rulings BE and BF would be: same task, new bytes, digests following. */
        function replaceApprovedPlan(planned: Planned, edit: (plan: NonNullable<ReturnType<typeof readCanonicalPlan>>) => void) {
          const { harness, taskId } = planned;
          const key = { pk: `DEVTASK#${taskId}`, sk: "META" };
          const task = harness.db.get(key.pk, key.sk)!;
          const workflow = task.workflow as { artifacts: Array<{ type: string; sha256: string; objectKey: string }>; decisions: Array<{ artifactDigest?: string }>; e2e: Record<string, unknown> };
          const artifact = workflow.artifacts.filter((item) => item.type === "plan").at(-1)!;
          const plan = readCanonicalPlan(harness.s3.objects.get(artifact.objectKey)!)!;
          edit(plan);
          const text = canonicalPlanJson(plan);
          const digest = sha(text);
          harness.s3.objects.set(artifact.objectKey, text);
          const old = artifact.sha256;
          harness.db.set({ ...task, workflow: { ...workflow, artifacts: workflow.artifacts.map((item) => (item === artifact ? { ...item, sha256: digest } : item)),
            decisions: workflow.decisions.map((item) => (item.artifactDigest === old ? { ...item, artifactDigest: digest } : item)), e2e: { ...workflow.e2e, contractDigest: digest } } });
        }
        const withDelta = (plan: NonNullable<ReturnType<typeof readCanonicalPlan>>) => {
          const intent = plan.e2e as E2EApplicationPlanIntent;
          plan.e2e = { ...intent, semanticExportDeltas: [{ applicationId: intent.applicationRuntimeRefs[0]!.applicationId, operationId: "price-rows", requestedTargetIds: ["web-1"],
            expectedExportNames: ["priceRows"], reason: "adds an export" }] };
        };

        it("returns the task to plan review with the reason, and the owner's way on is Request changes; approving the same plan again is refused", async () => {
          const planned = await plannedWithApplicationIntent();
          const dispatched = await atApplicationDispatch(planned);
          replaceApprovedPlan(planned, withDelta);
          await dispatched.runDispatch();
          const workflow = workflowOf(planned) as unknown as { stage: string; state: string; blockReason?: string; e2e?: unknown; revision: number; artifacts: Array<{ sha256: string }> };
          expect(workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
          expect(workflow.blockReason).toContain(WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX);
          expect(workflow.blockReason).toContain("semanticExportDeltas");
          expect(workflow.blockReason!.length).toBeLessThanOrEqual(500);
          expect(workflow.e2e).toBeUndefined();
          expect(dispatched.dispatchRows()).toEqual([]);
          expect(dispatched.checksOperations()).toEqual([]);
          expect(dispatched.admissionObjects()).toEqual([]);
          expect(planned.harness.db.get(`DEVTASK#${planned.taskId}`, "META")!.e2ePlanCorrection).toMatchObject({ requiredE2E: true, reasonCode: "application-plan-not-approvable" });
          // The same plan cannot be approved as it is ...
          const approve = await planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision,
            decision: "APPROVE", reason: "Approve it", artifactDigest: workflow.artifacts.at(-1)!.sha256 });
          expect(approve.status).toBeGreaterThanOrEqual(400);
          // ... and Request changes starts a planning run that is told the plan's rules.
          const planOperationsBefore = planned.harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === planned.workspaceId && row.workflowMode === "PLAN").length;
          const requested = await planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflow.revision,
            decision: "REQUEST_CHANGES", reason: "Correct the plan", artifactDigest: workflow.artifacts.at(-1)!.sha256 });
          expect(requested.status, JSON.stringify(requested.body)).toBe(200);
          expect(planned.harness.db.find((row) => row.entityType === "OPERATION" && row.workspaceId === planned.workspaceId && row.workflowMode === "PLAN").length).toBe(planOperationsBefore + 1);
        });

        it("says so on the task page and in the plan review: only Request changes is offered", () => {
          const workflow = WorkflowSnapshotSchema.parse({ ...workflowFixtureFor(`${WORKFLOW_APPLICATION_PLAN_NOT_APPROVABLE_PREFIX}x`), stage: "PLAN_REVIEW", state: "WAITING" });
          expect(taskPageStage(workflow, false, true).nextStep).toMatch(/request changes/i);
          expect(isE2EPlanCorrectionBlockReason(workflow.blockReason)).toBe(true);
          expect(isE2EPlanCorrectionBlockReason(E2E_PLAN_REFERENCE_INVALID_BLOCK_REASON)).toBe(true);
          expect(isE2EPlanCorrectionBlockReason("something else")).toBe(false);
        });
      });

      it("offers sending the task back to coding when the candidate's build source was refused, and the coder is told why", async () => {
        const planned = await plannedWithApplicationIntent();
        const dispatched = await atApplicationDispatch(planned, { buildSource: "REFUSED" });
        await dispatched.runDispatch();
        const task = dispatched.taskNow() as unknown as { workflow: Parameters<typeof workflowSendBackOffered>[0] & { revision: number } };
        expect(workflowSendBackOffered(task.workflow)).toBe(true);
        const operationsBefore = operationIds(planned);
        const sent = await planned.harness.dev(MAYA, "POST", `/v1/dev/tasks/${planned.taskId}/workflow/send-back`,
          { requestId: randomUUID(), expectedRevision: task.workflow.revision, instructions: "Shrink the oversized file and try again" });
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        expect(workflowOf(planned)).toMatchObject({ stage: "IMPLEMENT" });
        const coding = planned.harness.db.find((row) => row.pk === `WORKSPACE#${planned.workspaceId}` && row.entityType === "OPERATION" && !operationsBefore.includes(row.id) && row.workflowMode === "IMPLEMENT")[0]!;
        const prompt = (planned.harness.db.find((row) => row.entityType === "OUTBOX" && row.operationId === coding.id)[0]!.invocation as { payload: { prompt: string } }).payload.prompt;
        expect(prompt).toContain("per-file limit");
      });
    });
  });

});


describe("anonymous scenarios and inferred-recipe apps (Ruling AZ)", () => {
  const anonymousOnInferred = () => {
    const targetId = anonymousTargetOf(inferredSnapshot);
    return { targetId, scenario: anonymousScenario(targetId) };
  };
  const readyWeb = [{ kind: "web" as const, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedSteps,
    supportedAssertions: webApiRuntimeCapabilities("web", "a".repeat(64)).supportedAssertions }];

  it("selects one application group with no unavailable criteria for a rovara-anonymous web scenario on an inferred target", () => {
    const { targetId, scenario } = anonymousOnInferred();
    const { plan: selected } = plan({ snapshot: inferredSnapshot, targetId, scenario });
    expect(selected.unavailableCriteria).toEqual([]);
    expect(selected.groups).toHaveLength(1);
    expect(selected.groups[0]).toMatchObject({ mode: "real-runtime", runtimeProfileId: PROFILE, targetIds: [targetId] });
    expect(selected.groups[0]?.expectedCases).toHaveLength(1);
    expect(selected.groups[0]?.expectedCases[0]).toMatchObject({ accountProfileId: "rovara-anonymous", targetId });
  });

  it("keeps a signed-in scenario on the same inferred app unavailable with needs-project-contract", () => {
    const { plan: selected } = plan({ snapshot: inferredSnapshot });
    expect(selected.groups).toEqual([]);
    expect(selected.unavailableCriteria).toEqual([{ criterionId: selected.criteria[0]!.criterionId, reason: "needs-project-contract" }]);
  });

  it("runs an anonymous scenario on a project-contract app too, as a variant of the same target", () => {
    const targetId = anonymousTargetOf(contractSnapshot);
    const { plan: selected } = plan({ snapshot: contractSnapshot, targetId, scenario: anonymousScenario(targetId) });
    expect(selected.unavailableCriteria).toEqual([]);
    expect(selected.groups[0]?.expectedCases[0]).toMatchObject({ accountProfileId: "rovara-anonymous" });
  });

  it("gives the anonymous case the account context of the fixed anonymous reference, not of a registered account", () => {
    const { targetId, scenario } = anonymousOnInferred();
    const { plan: selected } = plan({ snapshot: inferredSnapshot, targetId, scenario });
    const other = plan({ snapshot: inferredSnapshot, targetId, scenario, accountRef: { definitionDigest: "2".repeat(64) } });
    // A different reference is a different context, which is what makes the fixed reference the only one the case can be bound to.
    expect(other.plan.groups[0]?.expectedCases[0]?.accountContextDigest).not.toBe(selected.groups[0]?.expectedCases[0]?.accountContextDigest);
  });

  it("offers the planner the anonymous target as executable with the fixed reference, and the inferred base target still as needs-project-contract", () => {
    const { targetId } = anonymousOnInferred();
    const setup = approvedSetup(inferredSnapshot, [{ kind: "web", profileId: PROFILE }]);
    const result = buildFeatureE2EPlanningContext(setup.policy, inferredSnapshot, { origin: "approved-setup", preparedCommitSha: null, accountRegistry: [], readyRuntimes: readyWeb });
    if (result.status !== "available") throw new Error(result.reason);
    expect(result.unavailableReasons).toEqual([{ targetId: "web-1", reason: "needs-project-contract" }]);
    expect(result.runtimeRefs?.map((ref) => [ref.targetId, ref.accountProfileId])).toEqual([["web-1", "synthetic"], [targetId, "rovara-anonymous"]]);
    const application = result.applicationRefs![0]!.applicationId;
    expect(result.runtimeAccountRefs).toEqual([e2eAnonymousRuntimeAccountRef(application)]);
    expect(result.executableKinds).toMatchObject([{ kind: "web" }]);
  });

  it("tells the planner in the version 2 prompt that a rovara-anonymous target runs its scenario signed out, with no account", () => {
    const setup = approvedSetup(inferredSnapshot, [{ kind: "web", profileId: PROFILE }]);
    const context = buildFeatureE2EPlanningContext(setup.policy, inferredSnapshot, { origin: "approved-setup", preparedCommitSha: null, accountRegistry: [], readyRuntimes: readyWeb });
    if (context.status !== "available") throw new Error(context.reason);
    const prompt = planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context });
    expect(prompt).toContain("Application E2E plan guidance (schemaVersion 2):");
    expect(prompt).toMatch(/accountProfileId is rovara-anonymous.*signed out/);
    expect(prompt).toContain('"accountProfileId":"rovara-anonymous"');
  });

  it("tells the planner which base targets got no signed-out variant because the 12-target inventory is full (F7)", () => {
    const manifest = JSON.parse(ordersContractManifest) as { agentx: { e2e: { accountProfiles: Record<string, unknown>[]; targetAccounts: unknown[]; recipe: Record<string, unknown> } } };
    const e2e = manifest.agentx.e2e;
    const names = Array.from({ length: 11 }, (_, index) => `acct-${index + 1}`);
    const profile = e2e.accountProfiles[0]!;
    e2e.accountProfiles = names.map((profileId) => ({ ...profile, profileId }));
    const { recipeDigest: _digest, ...recipeBody } = { ...e2e.recipe, accountProfileIds: names } as Record<string, unknown>;
    void _digest;
    e2e.recipe = { ...recipeBody, recipeDigest: shaCanonical(recipeBody) };
    e2e.targetAccounts = names.map((profileId) => ({ baseTargetId: "web-1", profileId }));
    const full = snapshotOf({ "package.json": JSON.stringify(manifest) });
    // The repository's discovery holds 12 targets; the policy pins the base alone, to keep the planner's context within its bound.
    const setup = approvedSetup(full, [{ kind: "web", profileId: PROFILE }], ["web-1"]);
    expect(setup.proposal.targets).toHaveLength(12);
    const context = buildFeatureE2EPlanningContext(setup.policy, full, { origin: "approved-setup", preparedCommitSha: null, accountRegistry: registryFor(full), readyRuntimes: readyWeb });
    if (context.status !== "available") throw new Error(context.reason);
    expect(context.targets.map((target) => target.accountProfileId)).not.toContain("rovara-anonymous");
    expect(context.anonymousVariantsOmitted).toEqual([{ targetId: "web-1", reason: "target-inventory-full" }]);
    expect(planDocumentInstructions({ kind: "plan", path: "FULL", e2ePlanningContext: context })).toContain('"anonymousVariantsOmitted":[{"targetId":"web-1","reason":"target-inventory-full"}]');
    // Where every variant fits there is nothing to say.
    const fits = buildFeatureE2EPlanningContext(approvedSetup(inferredSnapshot, [{ kind: "web", profileId: PROFILE }]).policy, inferredSnapshot,
      { origin: "approved-setup", preparedCommitSha: null, accountRegistry: [], readyRuntimes: readyWeb });
    if (fits.status !== "available") throw new Error(fits.reason);
    expect(fits.anonymousVariantsOmitted).toBeUndefined();
  });

  it("derives the variant from a policy and a setup proposal stored without it, so a project approved before Task 3.3 can plan a signed-out scenario (F1)", () => {
    const { targetId, scenario } = anonymousOnInferred();
    const fx = planFixture({ snapshot: inferredSnapshot, targetId, scenario });
    // What was stored: the base targets alone.
    expect(fx.setup.proposal.targets.map((target) => target.targetId)).toEqual(["web-1"]);
    expect(fx.policy.targets.map((target) => target.targetId)).toEqual(["web-1"]);
    const result = evaluate({ snapshot: inferredSnapshot, targetId, scenario });
    expect(result.ok, refusal(result)).toBe(true);
  });

  describe("approving the plan", () => {
    it("accepts an anonymous scenario on an inferred target, pins the fixed reference, and needs no registered account", () => {
      const { targetId, scenario } = anonymousOnInferred();
      const result = evaluate({ snapshot: inferredSnapshot, targetId, scenario });
      expect(result.ok, refusal(result)).toBe(true);
      if (!result.ok) return;
      const application = result.derivation.selectionInput.intent.applicationRuntimeRefs[0]!.applicationId;
      expect(result.accountRefs).toEqual([e2eAnonymousRuntimeAccountRef(application)]);
      expect(result.selection).toMatchObject({ executableTargetIds: [targetId], unavailableCriteria: [] });
    });

    it("refuses a signed-in scenario on an inferred target with needs-project-contract, and an anonymous one whose reference is not the fixed one", () => {
      expect(refusal(evaluate({ snapshot: inferredSnapshot }))).toMatch(/needs-project-contract/);
      const { targetId, scenario } = anonymousOnInferred();
      expect(refusal(evaluate({ snapshot: inferredSnapshot, targetId, scenario, accountRef: { definitionDigest: "2".repeat(64) } }))).toMatch(/account/i);
      expect(refusal(evaluate({ snapshot: inferredSnapshot, targetId, scenario, accountRef: { revision: 2 } }))).toMatch(/account/i);
    });

    it("approves it again after dispatch-time re-evaluation too (the fixed reference needs no pinned or registered row)", () => {
      const { targetId, scenario } = anonymousOnInferred();
      const fx = planFixture({ snapshot: inferredSnapshot, targetId, scenario });
      const pinned = [fx.accountRef];
      for (const mode of ["approve", "reapprove", "current"] as const) {
        const result = evaluateApplicationPlanApproval({ intent: fx.intent, taskId: TASK_ID, artifact: APPROVED_ARTIFACT, snapshot: fx.snapshot, setupProposal: fx.setup.proposal,
          setupApproval: fx.setup.setupApproval, policy: fx.policy, registeredRuntimes: [webApiRow("web")], runtimeCatalogId: "catalog", runtimeBinding: binding, now: NOW,
          accounts: { entries: [], mode, pinned: mode === "current" ? pinned : [] } });
        expect(result.ok, `${mode}: ${refusal(result)}`).toBe(true);
      }
    });
  });
});

// Ruling CY (review F1): the broker's setup decision for a proposal made on a repository with a web app answers a retry as it always did.
describe("the setup decision of a project with a web app (nothing stored changed with the signed-out variants)", () => {
  it("proposes the base targets alone, approves, and answers an approval retried with duplicate: true; the policy it registers holds no variant", async () => {
    const capture = vi.fn(async () => contractSnapshot);
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture }, e2eFeatureRuntimeCatalogId: "catalog", projectSetupRuntimeCatalogId: "setup-catalog" } });
    const admin = { subject: "admin-subject", admin: true };
    const proposal = await call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-proposals", user: admin, body: { repositoryUrl: "https://github.com/example/demo.git", ref: "main" } });
    expect(proposal.status, JSON.stringify(proposal.body)).toBe(200);
    const policy = E2EPolicySchema.parse(proposal.body.policy);
    expect(policy.targets.map((target) => target.accountProfileId)).not.toContain("rovara-anonymous");
    const decide = () => call(harness.handler, { method: "POST", path: "/v1/admin/projects/setup-approvals", user: admin,
      body: { projectName: "payments", proposalRef: String(proposal.body.proposalRef), proposalSha256: String(proposal.body.proposalSha256), decision: "approve" } });
    const first = await decide();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.duplicate).toBe(false);
    const retry = await decide();
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.duplicate).toBe(true);
  });
});
