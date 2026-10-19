import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_EXECUTOR_APP_ORIGIN, E2E_EXECUTOR_COMPILED_ORIGIN, E2EApplicationExecutionAdmissionSchema, E2EExecutorPlanSchema, E2ERegisteredRuntimeSchema, E2ERoundSchema, E2ERunBindingSchema,
  E2ERuntimeCapabilityDescriptorSchema, E2EApplicationPlanIntentSchema, canonicalJson, createCandidateManifest, e2eApplicationMetadataSourceRefs,
  e2eAppBuildManifestDigest, e2ePolicyDigest, e2eRuntimeCapabilityDigest, e2eScenarioBundleDigest, inspectE2ERepository, proposeE2ESetup,
  selectE2EApplicationExecutionPlan, type E2EExecutorPlan, type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { deriveE2EApplicationApprovalBinding } from "../../packages/broker/src/e2e/application-plan-binding.js";
import { compileE2EApplicationScenarios, encodeE2EApplicationExecutionAdmission, type E2ECompiledApplicationSuite } from "../../packages/verifier/src/application-scenarios.js";
import { encodeE2EApplicationBuildSourceArchive } from "../../packages/verifier/src/application-build-source.js";
import { E2E_EXECUTOR_HOST_ENTRY_POINT_ID, E2E_EXECUTOR_HOST_PROFILE_ID } from "../../packages/verifier/src/executor/host-registry.js";
import { gitBlob, gitTreeSha, hash } from "./e2e-application-fixture.js";

const repoRoot = join(import.meta.dirname, "../..");
const fixtureRoot = join(repoRoot, "tests/fixtures/e2e-web-api-app");
export const ORDERS_FIXTURE_ROOT = fixtureRoot;
/** The loopback origin compiled suites name; the plan itself reaches the app at http://app:4317. */
export const ORDERS_APP_ORIGIN = E2E_EXECUTOR_COMPILED_ORIGIN;

/** The scenarios a probe runs. Each is an ordinary source-style scenario that the real compiler turns into a CLI suite. */
export type OrdersProbeName = "web-csv-positive-v1" | "web-egress-denial-v1" | "api-state-positive-v1";
const probeOracle = (name: string) => (JSON.parse(readFileSync(join(repoRoot, "packages/verifier/assets/application-runtime-v1/probes", `${name}.json`), "utf8")) as {
  oracle: { columns: string[]; rows: string[][] } }).oracle;

function scenarioFor(probe: OrdersProbeName, targetId: string, accountProfileId: string) {
  const common = { requirementId: `${probe}-requirement`, requestedTargetIds: [targetId], required: true, accountProfileId,
    minimumEvidence: "runtime" as const, requiredRealComponentIds: [] as string[] };
  if (probe === "web-csv-positive-v1") {
    const oracle = probeOracle("web-csv-positive-v1");
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }, { kind: "click" as const, testId: "download-orders" }],
      assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: oracle.columns, rows: oracle.rows }] };
  }
  if (probe === "web-egress-denial-v1") {
    // The page tries to reach an outside host; the scenario claims it succeeded, which an egress-denied run can never show.
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }],
      assertions: [{ kind: "text" as const, testId: "network-denial", equals: "reachable" }] };
  }
  return { ...common, scenarioId: probe, steps: [{ kind: "request" as const, requestId: "health", path: "/health", method: "GET" as const, body: {} }],
    assertions: [{ kind: "state" as const, probeId: "api-state-positive/v1", equals: { orders: "ready", version: 1 }, pollTimeoutMs: 5_000 }] };
}

function registeredRuntime(kind: "web" | "api", profileId: string, now: number) {
  const web = kind === "web";
  const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId, kind,
    host: { os: "linux", arch: "arm64" }, engine: { name: web ? "web" : "api-supervisor", version: web ? "0.14.0" : "1.0.0", spiVersion: 1 },
    runtimeManifestDigest: (web ? "a" : "f").repeat(64), supportedSteps: web ? ["navigate", "click", "fill"] : ["request"],
    supportedAssertions: web ? ["text", "visible", "csv", "state"] : ["http-status", "state"], evidenceScopes: ["runtime"],
    networkPolicyDigest: "1".repeat(64), ...(web ? { browsers: ["chromium"] } : { protocols: ["http"] }) });
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: "/usr/local/bin/node", version: "v22.23.2" as const, platform: "linux" as const, arch: "arm64" as const };
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId, capabilityDigest, runtimeManifestDigest: capabilities.runtimeManifestDigest,
    suiteDigest: "2".repeat(64), fixtureRefs: [{ path: "fixtures/orders.json", sha256: "3".repeat(64) }], positiveProbeIds: ["orders-positive"], negativeProbeIds: ["orders-negative"] };
  const probeManifest = { ...probeBody, manifestDigest: hash(canonicalJson(probeBody)) };
  return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "runtime-catalog",
    catalogRevision: 3, profileId, generation: 4, binding, bindingDigest: hash(canonicalJson(binding)), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "22222222-2222-4222-8222-222222222222", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: hash(canonicalJson(runnerEnvironment)), runnerToolchain,
    runnerToolchainDigest: hash(canonicalJson(runnerToolchain)), capabilities, capabilityDigest, probeManifest,
    qualificationEvidenceRef: { key: "runtime-evidence/orders-qual.json", sha256: "4".repeat(64), byteLength: 128 },
    state: "READY", qualifiedAt: new Date(now - 3_600_000).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString() });
}

/** The host registry row the built executor ships; the compiled suite must name exactly this host. */
function registeredHost() {
  const registry = JSON.parse(readFileSync(join(repoRoot, "packages/verifier/assets/application-runtime-v1/cli-hosts.json"), "utf8")) as {
    hosts: { profileId: string; entryPointId: string; entryPointManifestDigest: string }[] };
  const row = registry.hosts.find((host) => host.profileId === E2E_EXECUTOR_HOST_PROFILE_ID && host.entryPointId === E2E_EXECUTOR_HOST_ENTRY_POINT_ID)!;
  return { entryPointId: row.entryPointId, entryPointManifestDigest: row.entryPointManifestDigest };
}

export type OrdersExecutorFixture = Readonly<{
  plan: E2EExecutorPlan; compiled: E2ECompiledApplicationSuite; caseId: string; probe: OrdersProbeName;
  /** The app-side seed matching the plan's synthetic account; mount it read-only at `<app>/.owned/seed.json`. */
  seed: { accounts: { email: string; passwordDigest: string; subjectId: string; tenantId: string; role: "owner" | "viewer"; displayName: string }[] };
  account: { email: string; password: string };
}>;

/**
 * Builds a real executor plan for the orders fixture app: its `package.json` contract goes through the real discovery,
 * selection and compiler, so the executor runs a genuinely compiled suite. Only the admission inputs that the broker owns
 * (approvals, build manifest, runtime registration) are synthesized, with the same shapes the broker produces.
 */
export function createOrdersExecutorPlan(options: { probe: OrdersProbeName; deadlineMs?: number; healthTimeoutMs?: number; role?: "owner" | "viewer";
  /** Build commands for the recipe (the fixture itself builds nothing); the recipe digest is recomputed to match. */
  recipeBuild?: { program: string; args: string[]; cwd: string; timeoutMs: number; env: Record<string, string> }[];
  /** Overrides of the recipe's start command (arguments, timeout, env); the recipe digest is recomputed to match. */
  recipeStart?: { args?: string[]; timeoutMs?: number; env?: Record<string, string> } }): OrdersExecutorFixture {
  const kind = options.probe.startsWith("web-") ? "web" as const : "api" as const;
  const rawPackage = JSON.parse(readFileSync(join(fixtureRoot, "package.json"), "utf8")) as { agentx: { e2e: { targetAccounts: { baseTargetId: string; profileId: string }[];
    recipe: { recipeDigest: string; build: unknown[]; launch: { start: Record<string, unknown> } } } } };
  if (options.recipeBuild || options.recipeStart) {
    const recipe = rawPackage.agentx.e2e.recipe;
    const launch = options.recipeStart ? { ...recipe.launch, start: { ...recipe.launch.start, ...options.recipeStart } } : recipe.launch;
    const { recipeDigest: _digest, ...body } = { ...recipe, launch, build: options.recipeBuild ?? recipe.build };
    void _digest;
    rawPackage.agentx.e2e.recipe = { ...body, recipeDigest: hash(canonicalJson(body)) };
  }
  if (kind === "api") rawPackage.agentx.e2e.targetAccounts = rawPackage.agentx.e2e.targetAccounts.map((item) => ({ ...item, baseTargetId: "api-1" }));
  const packageBytes = Buffer.from(JSON.stringify(rawPackage));
  const packagePath = kind === "web" ? "apps/orders/package.json" : "server/package.json";
  const sourceFiles = [{ path: packagePath, bytes: packageBytes }];
  const treeSha = gitTreeSha(sourceFiles.map((item) => ({ path: item.path, mode: "100644", objectId: gitBlob(item.bytes) })));
  const candidate = createCandidateManifest([{ repositoryId: "fixture/orders", commitSha: "a".repeat(40), treeSha }]);
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
    treePaths: sourceFiles.map((item) => item.path), sources: sourceFiles.map((item) => ({ ...item, sha256: hash(item.bytes), kind: "blob" as const })) };
  const discovery = inspectE2ERepository(snapshot, candidate);
  const accountProfileId = options.role === "viewer" ? "orders-viewer" : "orders-owner";
  const target = discovery.inspection.proposedTargets.find((item) => item.kind === kind && item.accountProfileId === accountProfileId)!;
  const application = discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  const accountContext = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths)[0]!;
  const scenario = scenarioFor(options.probe, target.targetId, accountProfileId);
  const accountRef = { applicationId: application.applicationId, profileId: accountProfileId, revision: 1, definitionDigest: "8".repeat(64) };
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const runtimeProfileId = E2E_EXECUTOR_HOST_PROFILE_ID;
  const runtime = registeredRuntime(kind, runtimeProfileId, nowMs);
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [], mockFixtureRefs: [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: accountProfileId, sourcePath: accountContext.path, sourceSha256: accountContext.sha256 }],
    scenarios: [scenario], semanticExportDeltas: [], applicationRuntimeRefs: [{ targetId: target.targetId, applicationId: application.applicationId,
      recipeDigest: application.recipe!.recipeDigest, sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths),
      runtimeProfileId, accountProfileId }], runtimeAccountRefs: [accountRef], unavailableTargetRefs: [] });
  const setupProposal = proposeE2ESetup({ inspection: discovery.inspection, snapshot, expectedCandidate: candidate });
  const setupApproval = { artifactId: "setup-approval", digest: hash(canonicalJson(setupProposal)) };
  const planDigest = "c".repeat(64);
  const semanticApproval = { artifactId: "semantic-approval", digest: "d".repeat(64) };
  const applicationApprovalBinding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent, artifactId: semanticApproval.artifactId,
    artifactSha256: semanticApproval.digest, planDigest, setupProposal, setupApproval });
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [scenario.scenarioId],
    targets: discovery.inspection.proposedTargets, defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
    // The real web engine reports screenshot and video capability, and the compiler binds the launch descriptor to the capture policy.
    capture: { screenshots: kind === "web", traces: false, video: kind === "web", downloads: false },
    limits: { runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 60_000, caseTimeoutMs: 120_000,
      maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest, policy, scenarios: [scenario],
    selectedTargetIds: [target.targetId], intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval, applicationApprovalBinding,
    registeredRuntimes: [runtime], runtimeAccountRefs: [accountRef], now: nowMs, sandboxAvailability: null,
    runtimeAvailability: [{ targetId: target.targetId, profileId: runtimeProfileId, connection: "connected" as const,
      approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "orders-auth-r1" }],
    portableApprovalBinding: { schemaVersion: "portable-approval-binding/v1" as const, planDigest, semanticApproval, operations: [], accountContexts: [],
      bindingDigest: "0".repeat(64) }, approvedSemanticApproval: semanticApproval, mockableComponents: [] };
  selectionInput.portableApprovalBinding.bindingDigest = hash(canonicalJson(Object.fromEntries(Object.entries(selectionInput.portableApprovalBinding)
    .filter(([key]) => key !== "bindingDigest"))));
  const executionPlan = selectE2EApplicationExecutionPlan(selectionInput);
  const group = executionPlan.groups[0]!;
  const archive = encodeE2EApplicationBuildSourceArchive(sourceFiles.map((item) => ({ ...item, mode: "100644" as const })));
  const sourceBody = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: candidate.digest,
    repository: { repositoryId: "fixture/orders", commitSha: snapshot.commitSha, treeSha }, sourceState: "candidate-index-tree" as const,
    pathPolicy: "existing-safe-e2e-source-path/v1" as const,
    treeEntries: sourceFiles.map((item) => ({ path: item.path, mode: "100644" as const, objectId: gitBlob(item.bytes) })),
    files: sourceFiles.map((item) => ({ path: item.path, mode: "100644" as const, gitBlobId: gitBlob(item.bytes), sha256: hash(item.bytes), byteLength: item.bytes.byteLength })),
    omissions: [], archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: archive.sha256, byteLength: archive.byteLength, fileCount: sourceFiles.length } };
  const buildSourceManifest = { ...sourceBody, manifestDigest: hash(canonicalJson(sourceBody)) };
  const buildSource = { manifest: buildSourceManifest, reference: { artifactId: "orders-source-archive", sha256: archive.sha256,
    byteLength: archive.byteLength, manifestDigest: buildSourceManifest.manifestDigest } };
  const output = { artifactId: "orders-build", sha256: "5".repeat(64), appId: application.applicationId, platform: kind };
  const buildBody = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: candidate.digest, applicationId: application.applicationId,
    repository: { repositoryId: "fixture/orders", commitSha: snapshot.commitSha, treeSha }, recipeDigest: application.recipe!.recipeDigest,
    lockfileRefs: [], toolchainManifestDigest: "6".repeat(64), outputs: [output], createdAt: now };
  const build = { ...buildBody, manifestDigest: e2eAppBuildManifestDigest(buildBody) };
  const applicationBindings = new Map([[application.applicationId, { approval: applicationApprovalBinding, build,
    artifacts: [{ ...output, buildManifestDigest: build.manifestDigest }], buildSource }]]);
  const preparedEnvironmentDigest = "7".repeat(64);
  const runtimeBindings = new Map([[runtimeProfileId, runtime]]);
  const cliHostsByProfile = new Map([[runtimeProfileId, registeredHost()]]);
  const launchTargets = [{ targetId: target.targetId, profileId: runtimeProfileId, factoryId: "executor-host", factoryManifestDigest: runtime.manifestDigest,
    // The real @e2e-dev/web 0.14.0 engine descriptor, as the pinned runner's own report states it for a web target.
    engine: kind === "web" ? { name: "web", version: "0.14.0", spiVersion: 1 as const, platform: "web",
      capabilities: ["actions", "artifacts", "browser", "keyboard", "location", "observation", "pointer", "state"] } : null,
    artifactCapabilities: kind === "web" ? ["screenshot" as const, "video" as const] : [], stateCapability: kind === "api" || kind === "web",
    app: kind === "web" ? { url: ORDERS_APP_ORIGIN, identity: application.applicationId, environment: "test" as const } : null }];
  const bundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1" as const, scenarios: [scenario], bundleDigest: "0".repeat(64) };
  const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
  const context = { selectionInput, executionPlan, bundle, applicationBindings, runtimeBindings, launchTargets, modelRoute: null, cliHostsByProfile,
    preparedEnvironmentsByGroup: new Map([[group.groupId, { preparedEnvironmentDigest, originByApplicationId: [{ applicationId: application.applicationId, origin: ORDERS_APP_ORIGIN }] }]]) };
  const compiled = compileE2EApplicationScenarios({ context, groupId: group.groupId });
  const roundId = randomUUID();
  const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: randomUUID(), roundId, taskId: "task-orders", operationId: randomUUID(), operationFence: 1,
    workflowRevision: 1, groupId: group.groupId, executionPlanDigest: executionPlan.digest, executionMode: group.mode, mockManifestDigest: group.mockManifestDigest,
    authorizationRevision: "orders-auth-r1", candidateDigest: candidate.digest, planDigest, policyDigest: e2ePolicyDigest(policy), bundleDigest: bundle.bundleDigest,
    appBuildDigest: hash(canonicalJson(compiled.inventory)), environmentDigest: preparedEnvironmentDigest, runtimeManifestDigest: runtime.manifestDigest,
    modelRouteRevision: null, expectedCases: compiled.expectedCases, admittedAt: now, deadlineAt: new Date(nowMs + (options.deadlineMs ?? 300_000)).toISOString() });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId: binding.taskId, operationId: binding.operationId, operationFence: binding.operationFence,
    workflowRevision: binding.workflowRevision, executionPlanDigest: executionPlan.digest, admittedAt: now, deadlineAt: binding.deadlineAt,
    limits: policy.limits, groupBindings: [binding] });
  const sourceSnapshotWire = { candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true as const,
    treePaths: snapshot.treePaths, sources: snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256,
      bytesBase64: Buffer.from(item.bytes).toString("base64"), kind: "blob" as const })) };
  const groupAdmission = { protocol: "trusted-e2e-application/v1" as const, outerBinding: binding, cliHost: compiled.cliHost,
    preparedEnvironmentDigest, originByApplicationId: compiled.originByApplicationId, compiledInventoryDigest: compiled.inventory.digest,
    shards: compiled.inventory.shards.map((item) => ({ shardId: item.shardId, targetId: item.targetId, inventoryDigest: item.inventoryDigest,
      configDigest: item.expectedConfigDigest, expectedCaseIds: [...item.expectedCaseIds] })) };
  const admissionBody = { schemaVersion: "workflow-e2e-application-admission/v1" as const, taskId: binding.taskId, operationId: binding.operationId,
    operationFence: binding.operationFence, workflowRevision: binding.workflowRevision, candidateDigest: candidate.digest,
    sourceSnapshot: sourceSnapshotWire, intent, intentDigest: hash(canonicalJson(intent)),
    selectionInput: { ...selectionInput, sourceSnapshot: sourceSnapshotWire }, applicationApprovalBinding,
    applicationBindings: [...applicationBindings].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)),
    runtimeBindings: [...runtimeBindings].map(([key, value]) => ({ key, value })), launchTargets, modelRoute: null,
    cliHosts: [...cliHostsByProfile].map(([profileId, descriptor]) => ({ profileId, descriptor })),
    preparedEnvironments: [{ groupId: group.groupId, preparedEnvironmentDigest, originByApplicationId: compiled.originByApplicationId }],
    policy, bundle, executionPlan, portableProjection: null, round, groups: [groupAdmission] };
  const admission = E2EApplicationExecutionAdmissionSchema.parse(JSON.parse(encodeE2EApplicationExecutionAdmission({ ...admissionBody,
    admissionDigest: hash(canonicalJson(admissionBody)) } as never)));
  const password = `pw-${randomUUID()}-${randomUUID()}`;
  const email = `rovara-${randomUUID()}@example.invalid`;
  const role = options.role ?? "owner";
  const plan = E2EExecutorPlanSchema.parse({ schemaVersion: "e2e-executor-plan/v1", runId: binding.runId, groupId: group.groupId, admission,
    admissionDigest: admission.admissionDigest, app: { origin: E2E_EXECUTOR_APP_ORIGIN, health: { path: "/health", expectedStatus: 200, timeoutMs: options.healthTimeoutMs ?? 30_000 } },
    deadlineAt: Date.parse(binding.deadlineAt), accounts: [{ profileId: accountProfileId, email, password }] });
  return { plan, compiled, caseId: compiled.expectedCases[0]!.caseId, probe: options.probe,
    seed: { accounts: [{ email, passwordDigest: createHash("sha256").update(password, "utf8").digest("hex"), subjectId: `subject-${randomUUID()}`,
      tenantId: "tenant-a", role, displayName: role === "owner" ? "Orders Owner" : "Orders Viewer" }] },
    account: { email, password } };
}
