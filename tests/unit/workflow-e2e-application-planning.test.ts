import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  E2EApplicationPlanIntentSchema, E2ERegisteredRuntimeSchema, E2EPolicySchema, WEB_API_RUNTIME_PROFILE_ID, canonicalJson, createCandidateManifest,
  e2eApplicationMetadataSourceRefs, e2eRuntimeCapabilityDigest, inspectE2ERepository, proposeE2ESetup, selectE2EApplicationExecutionPlan,
  type E2EPolicy, type E2EScenario, type E2ESourceSnapshot,
} from "@agentx/contracts";
import { deriveE2EApplicationFeatureExecutionSelection } from "../../packages/broker/src/e2e/application-feature-plan-intent.js";
import { buildFeatureE2EPlanningContext, describeFeatureE2EExecutableKinds }
  from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { e2eRegisteredRuntimeKey } from "../../packages/broker/src/aws/e2e-runtime-readiness.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { planDocumentInstructions } from "../../packages/broker/src/aws/broker-shared.js";
import { createDeveloperTaskBroker, MAYA } from "../support/developer-task-broker.js";
import { call } from "../support/slack-broker.js";

const PROFILE = WEB_API_RUNTIME_PROFILE_ID;
// The broker reads the clock itself, so the rows are valid around the real current time.
const NOW = Date.now();
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const shaCanonical = (value: unknown) => sha(canonicalJson(value));
const ordersContractManifest = readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8");
const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
  subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };

/** One v2 catalog row of the qualified profile, carrying the real registered capability descriptor of its kind. */
function webApiRow(kind: "web" | "api", overrides: Record<string, unknown> = {}) {
  const capabilities = webApiRuntimeCapabilities(kind, "a".repeat(64));
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

/** Runs the production selection facade for one web scenario against the approved setup. */
function plan(input: { snapshot?: E2ESourceSnapshot; scenario?: E2EScenario; targetId?: string; setupReady?: Ready; planRuntimeProfileId?: string; executable?: boolean;
  registeredRuntimes?: ReturnType<typeof webApiRow>[]; modelRouteRevision?: string }) {
  const snapshot = input.snapshot ?? contractSnapshot;
  const scenario = input.scenario ?? csvScenario;
  const setup = approvedSetup(snapshot, input.setupReady ?? [{ kind: "web", profileId: PROFILE }]);
  const target = setup.proposal.targets.find((item) => item.targetId === (input.targetId ?? "web-1"))!;
  const application = setup.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  const refs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths);
  const executable = input.executable ?? true;
  const accountRef = { applicationId: application.applicationId, profileId: target.accountProfileId, revision: 1, definitionDigest: "2".repeat(64) };
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId, sourcePath: "package.json", sourceSha256: refs.find((ref) => ref.path === "package.json")!.sha256 }],
    scenarios: [scenario], semanticExportDeltas: [],
    applicationRuntimeRefs: executable ? [{ targetId: target.targetId, applicationId: application.applicationId, recipeDigest: application.recipe!.recipeDigest,
      sourceRefs: refs, runtimeProfileId: input.planRuntimeProfileId ?? target.runtimeProfileId, accountProfileId: target.accountProfileId }] : [],
    runtimeAccountRefs: executable ? [accountRef] : [],
    unavailableTargetRefs: executable ? [] : [{ targetId: target.targetId, applicationId: application.applicationId, accountProfileId: target.accountProfileId, sourceRefs: refs }] });
  const semanticApproval = { artifactId: "feature-plan", digest: "1".repeat(64) };
  return deriveE2EApplicationFeatureExecutionSelection({ intent, snapshot, artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest,
    planDigest: "3".repeat(64), approvedSemanticApproval: semanticApproval, setupProposal: setup.proposal, setupApproval: setup.setupApproval,
    policy: { ...setup.policy, baselineScenarioIds: [scenario.scenarioId], modelRouteRevision: input.modelRouteRevision ?? null },
    registeredRuntimes: input.registeredRuntimes ?? [webApiRow("web")],
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
  async function plannedInvocation(rows: Record<"web" | "api", Record<string, unknown> | undefined>,
    afterApproval?: (harness: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => void): Promise<{ prompt: string; workflowE2EPlanVersion?: number }> {
    const snapshot = contractSnapshot;
    const capture = vi.fn(async () => snapshot);
    const harness = await createDeveloperTaskBroker({ brokerExtra: { projectSetupSource: { capture }, e2eFeatureRuntimeCatalogId: "catalog" } });
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
    const start = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments",
      instructions: "Add an orders table with an Export CSV button", client: "planning-test", workflow: true, workflowPath: "QUICK" });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const task = harness.db.get(`DEVTASK#${String((start.body.task as { taskId: string }).taskId)}`, "META") as { workspaceId: string };
    const preparation = harness.db.find((row) => row.pk === `WORKSPACE#${task.workspaceId}` && row.entityType === "OPERATION" && row.kind === "prepare")[0]!;
    await harness.finish(task.workspaceId, String(preparation.id), "SUCCEEDED", { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: snapshot.commitSha }] } });
    const planning = harness.db.find((row) => row.pk === `WORKSPACE#${task.workspaceId}` && row.entityType === "OPERATION" && row.workflowMode === "PLAN")[0]!;
    return (harness.db.find((row) => row.entityType === "OUTBOX" && row.operationId === planning.id)[0]!.invocation as { payload: { prompt: string; workflowE2EPlanVersion?: number } }).payload;
  }
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
});
