import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, E2E_EXECUTOR_APP_ORIGIN, E2E_MODEL_CHANNEL_SCHEMA_VERSION, WEB_API_AGENT_GUARD_MARKER_TESTID, WEB_API_AGENT_GUARD_PAGE_PATH, WEB_API_AGENT_PROBE_GOAL, WEB_API_AGENT_PROBE_MAX_ACTIONS, E2E_EXECUTOR_COMPILED_ORIGIN, E2EApplicationExecutionAdmissionSchema, e2eAnonymousRuntimeAccountRef, E2EExecutorPlanSchema, E2ERegisteredRuntimeSchema, E2ERoundSchema, E2ERunBindingSchema,
  E2EApiMockFixtureSchema, E2ERuntimeCapabilityDescriptorSchema, E2EApplicationPlanIntentSchema, canonicalJson, e2eApiSchemaComponentId, createCandidateManifest, deriveE2EApplicationApprovalBinding, e2eApplicationMetadataSourceRefs,
  e2eAppBuildManifestDigest, e2eApplicationLockfileRefs, e2eEffectiveRoundLimitsBeforeRun1, e2ePolicyDigest, e2eRuntimeCapabilityDigest, e2eScenarioBundleDigest, inspectE2EApplicationRepository, inspectE2ERepository, proposeE2ESetup, withE2EAnonymousTargets,
  selectE2EApplicationExecutionPlan, type E2EExecutorPlan, type E2EPolicy, type E2EReplaySourceCase, type E2EReplayTrace, type E2EScenario, type E2ESourceSnapshot } from "@agentx/contracts";
import { compileE2EApplicationScenarios, e2eApplicationGroupUsesModel, encodeE2EApplicationExecutionAdmission, type E2ECompiledApplicationSuite } from "../application-scenarios.js";
import { encodeE2EApplicationBuildSourceArchive } from "../application-build-source.js";
import { loadWebApiQualificationProbeAssets, type E2EAgentProbeScriptTurn } from "../application-runtime-probes.js";
import { ROVARA_HTTP_ENGINE_DESCRIPTOR } from "../rovara-http-engine-descriptor.js";
import { webApiApplicationLaunchTarget } from "../web-api-launch-target.js";
import { E2E_EXECUTOR_HOST_ENTRY_POINT_ID, E2E_EXECUTOR_HOST_PROFILE_ID } from "../executor/host-registry.js";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), Buffer.from(bytes)])).digest("hex");
function gitTreeSha(entries: readonly { path: string; mode: string; objectId: string }[]): string {
  type Node = { files: Array<{ name: string; mode: string; objectId: string }>; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/"); let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) { child = { files: [], dirs: new Map() }; node.dirs.set(part, child); }
      node = child;
    }
    node.files.push({ name: parts.at(-1)!, mode: entry.mode, objectId: entry.objectId });
  }
  const write = (node: Node): Buffer => {
    const rows = [
      ...node.files.map((file) => ({ name: file.name, directory: false, bytes: Buffer.concat([Buffer.from(`${file.mode} ${file.name}\0`), Buffer.from(file.objectId, "hex")]) })),
      ...[...node.dirs].map(([name, child]) => ({ name, directory: true,
        bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(createHash("sha1").update(write(child)).digest("hex"), "hex")]) })),
    ].sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.directory ? "/" : "")), Buffer.from(right.name + (right.directory ? "/" : ""))));
    const bodyBytes = Buffer.concat(rows.map((row) => row.bytes));
    return Buffer.concat([Buffer.from(`tree ${bodyBytes.byteLength}\0`), bodyBytes]);
  };
  return createHash("sha1").update(write(root)).digest("hex");
}

/** The loopback origin compiled suites name; the plan itself reaches the app at http://app:4317. */
export const WEB_API_PROBE_APP_ORIGIN = E2E_EXECUTOR_COMPILED_ORIGIN;

/** The scenarios a probe runs. Each is an ordinary source-style scenario that the real compiler turns into a CLI suite. */
export type WebApiProbeName = "web-csv-positive-v1" | "web-egress-denial-v1" | "api-state-positive-v1" | "api-status-mismatch-v1" | "api-egress-denial-v1" | "web-inventory-status-v1" | "web-inventory-csv-v1" | "web-agent-v1" | "web-agent-isolation-v1";
/** The CSV the positive probe expects, from the installed probe asset (the same bytes the pinned asset digest covers). */
function csvOracle(): { columns: string[]; rows: string[][] } {
  const oracle = loadWebApiQualificationProbeAssets().find((asset) => asset.probeId === "web-csv-positive-v1")!.probe.oracle;
  if (oracle.kind !== "csv") throw new Error("the CSV probe asset has no CSV oracle");
  return { columns: oracle.columns, rows: oracle.rows };
}

function scenarioFor(probe: WebApiProbeName, targetId: string, accountProfileId: string): E2EScenario {
  const common = { requirementId: `${probe}-requirement`, requestedTargetIds: [targetId], required: true, accountProfileId,
    minimumEvidence: "runtime" as const, requiredRealComponentIds: [] as string[] };
  if (probe === "web-csv-positive-v1") {
    const oracle = csvOracle();
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }, { kind: "click" as const, testId: "download-orders" }],
      assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: oracle.columns, rows: oracle.rows }] };
  }
  if (probe === "web-agent-v1") {
    // The CSV export again, but asked for in words: an AI-navigated step names a goal, not the button (Task 4.5). The scripted model finds the button; what the case shows is what the CSV assertion
    // observes in the one download the step caused. The three agent probes run this scenario and differ only in the script and in how the app is started.
    const oracle = csvOracle();
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }, { kind: "agent" as const, goal: WEB_API_AGENT_PROBE_GOAL, maxActions: WEB_API_AGENT_PROBE_MAX_ACTIONS }],
      assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: oracle.columns, rows: oracle.rows }] };
  }
  if (probe === "web-agent-isolation-v1") {
    // The scripted run, then the guard's own page: the app's start guard serves it, with a marker only once it has checked an earlier request before answering it. The step runs after the
    // AI-navigated one, which runs with the model channel open, so the assertion holds only if the guard's in-request checks ran in that window (fix round 1, review I1).
    const oracle = csvOracle();
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }, { kind: "agent" as const, goal: WEB_API_AGENT_PROBE_GOAL, maxActions: WEB_API_AGENT_PROBE_MAX_ACTIONS },
      { kind: "navigate" as const, path: WEB_API_AGENT_GUARD_PAGE_PATH }],
      assertions: [{ kind: "csv" as const, downloadName: "orders.csv", columns: oracle.columns, rows: oracle.rows }, { kind: "visible" as const, testId: WEB_API_AGENT_GUARD_MARKER_TESTID, equals: true }] };
  }
  if (probe === "web-egress-denial-v1") {
    // The page tries to reach an outside host; the scenario claims it succeeded, which an egress-denied run can never show.
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }],
      assertions: [{ kind: "text" as const, testId: "network-denial", equals: "reachable" }] };
  }
  if (probe === "web-inventory-status-v1") {
    // The page asks the app for an order's stock status, which the app reads from its external inventory origin. The assertion is what a working inventory service shows.
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }, { kind: "click" as const, testId: "check-inventory" }],
      assertions: [{ kind: "text" as const, testId: "inventory-status", equals: "in-stock" }] };
  }
  if (probe === "web-inventory-csv-v1") {
    // The owner's export with each order's stock status from the external inventory origin: the approved mock answers `a1` with in-stock and refuses `a2`, which the export shows as unavailable.
    return { ...common, scenarioId: probe, steps: [{ kind: "navigate" as const, path: "/" }, { kind: "click" as const, testId: "download-orders-inventory" }],
      assertions: [{ kind: "csv" as const, downloadName: "orders-inventory.csv", columns: ["id", "customer", "total", "state", "inventory"],
        rows: [["a1", "Ada", "12.5", "ready", "in-stock"], ["a2", "Grace", "23", "ready", "unavailable"]] }] };
  }
  if (probe === "api-status-mismatch-v1") {
    // A healthy app answers 200; the scenario claims 503, so this assertion definitively does not hold.
    return { ...common, scenarioId: probe, steps: [{ kind: "request" as const, requestId: "health", path: "/health", method: "GET" as const, body: {} }],
      assertions: [{ kind: "http-status" as const, path: "/health", method: "GET" as const, equals: 503 }] };
  }
  if (probe === "api-egress-denial-v1") {
    // Two outside calls by the app. The first asks for its inventory by a name nothing in the run serves: the app's resolver sends that name to the sinkhole, which records the call,
    // so the run is UNKNOWN `unmocked-external-call`. The second dials an IP literal, which no resolver touches, so only the wall around the run can stop it; the assertion claims it
    // was reached, which a run with a wall can never show, so a failed `http-status` is the proof that the raw wall holds.
    return { ...common, scenarioId: probe, steps: [{ kind: "request" as const, requestId: "inventory", path: "/api/inventory/status", method: "GET" as const, body: {} },
      { kind: "request" as const, requestId: "raw-egress", path: "/api/egress/raw", method: "GET" as const, body: {} }],
      assertions: [{ kind: "http-status" as const, path: "/api/egress/raw", method: "GET" as const, equals: 200 }] };
  }
  return { ...common, scenarioId: probe, steps: [{ kind: "request" as const, requestId: "health", path: "/health", method: "GET" as const, body: {} }],
    assertions: [{ kind: "state" as const, probeId: "api-state-positive/v1", equals: { orders: "ready", version: 1 }, pollTimeoutMs: 5_000 }] };
}

/** What a registered runtime row records of the machine its runner ran on: the plan fixtures' own (a Linux arm64 host), or a real executor image's (what a journey on a real host registers). */
export type WebApiProbeRunner = { environment: { os: string; arch: string; runtime: string }; toolchain: { execPath: string; version: "v22.23.2"; platform: "linux" | "darwin" | "win32"; arch: "arm64" | "x64" } };
function registeredRuntime(kind: "web" | "api", profileId: string, now: number, agent = false, runner?: WebApiProbeRunner) {
  const web = kind === "web";
  const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId, kind,
    host: { os: "linux", arch: "arm64" }, engine: web ? { name: "web", version: "0.14.0", spiVersion: 1 } : { name: ROVARA_HTTP_ENGINE_DESCRIPTOR.name, version: ROVARA_HTTP_ENGINE_DESCRIPTOR.version, spiVersion: 1 },
    runtimeManifestDigest: (web ? "a" : "f").repeat(64), supportedSteps: web ? ["navigate", "click", "fill", ...(agent ? ["agent"] : [])] : ["request"],
    supportedAssertions: web ? ["text", "visible", "csv", "state"] : ["http-status", "state"], evidenceScopes: ["runtime"], mocks: ["source-backed-api-fixtures/v1"],
    networkPolicyDigest: "1".repeat(64), ...(web ? { browsers: ["chromium"], ...(agent ? { modelChannel: E2E_MODEL_CHANNEL_SCHEMA_VERSION } : {}) } : { protocols: ["http"] }) });
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, ...(runner?.environment ?? { os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" }) };
  const runnerToolchain = runner?.toolchain ?? { execPath: "/usr/local/bin/node", version: "v22.23.2" as const, platform: "linux" as const, arch: "arm64" as const };
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
  const registry = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../assets/application-runtime-v1/cli-hosts.json"), "utf8")) as {
    hosts: { profileId: string; entryPointId: string; entryPointManifestDigest: string }[] };
  const row = registry.hosts.find((host) => host.profileId === E2E_EXECUTOR_HOST_PROFILE_ID && host.entryPointId === E2E_EXECUTOR_HOST_ENTRY_POINT_ID)!;
  return { entryPointId: row.entryPointId, entryPointManifestDigest: row.entryPointManifestDigest };
}

export type WebApiProbePlan = Readonly<{
  plan: E2EExecutorPlan; compiled: E2ECompiledApplicationSuite; caseId: string; probe: WebApiProbeName;
  /** The one scenario the probe runs through the real collector; its digest is pinned in contracts. */
  scenario: E2EScenario;
  /** The app-side seed matching the plan's synthetic account; mount it read-only at `<app>/.owned/seed.json`. */
  seed: { accounts: { email: string; passwordDigest: string; subjectId: string; tenantId: string; role: "owner" | "viewer"; displayName: string }[] };
  account: { email: string; password: string };
  /** Every scenario of the plan (one for a probe; one per account for `accountScenarios`), in the order given. */
  scenarios: readonly E2EScenario[];
}>;

/**
 * Builds a real executor plan for a probe against the qualification app: its `package.json` contract goes through the real discovery,
 * selection and compiler, so the executor runs a genuinely compiled suite. Only the admission inputs that the broker owns
 * (approvals, build manifest, runtime registration) are synthesized, with the same shapes the broker produces.
 * `appRoot` is the app tree whose package.json is the contract: the installed qualification app in production, the source fixture in tests.
 * `runId` binds the run to a qualification challenge; without it the run id is random.
 */
export function createWebApiProbePlan(options: { probe: WebApiProbeName; appRoot: string; runId?: string; /** The workflow task id the run is bound to; default is a fixed qualification label. */ taskId?: string; deadlineMs?: number; healthTimeoutMs?: number; role?: "owner" | "viewer";
  /** Approve the app's inventory mock (its OpenAPI document and its fixture, from the app tree) for the probe's target. */
  mock?: boolean;
  /** Build commands for the recipe (the fixture itself builds nothing); the recipe digest is recomputed to match. */
  recipeBuild?: { program: string; args: string[]; cwd: string; timeoutMs: number; env: Record<string, string> }[];
  /** Overrides of the recipe's start command (arguments, timeout, env); the recipe digest is recomputed to match. */
  recipeStart?: { args?: string[]; timeoutMs?: number; env?: Record<string, string> };
  /**
   * Plans one scenario per listed account instead of the probe's single scenario, all in the same group (Task 3.2). The probe name still decides the target kind (`web-` or `api-`).
   * Every listed profile must be one of the app's account profiles with a target variant of that kind.
   */
  accountScenarios?: readonly { accountProfileId: string; scenario(targetId: string): E2EScenario }[];
  /**
   * Plans an app that has no `agentx.e2e` project contract (Task 3.3): `appRoot` holds its `package.json` and `package-lock.json` at the repository root, and discovery infers the
   * launch recipe (`npm ci`, `npm start`, health on `/`). Its scenarios are `rovara-anonymous` ones, which need no account, so the plan carries none.
   */
  inferred?: boolean;
  /**
   * Plans a web group whose scenarios may have `agent` steps (Task 4.3a): the runtime declares the step, and the policy, the compilation context, the run binding and the admission
   * all pin this route, as the broker's admission does for a project that approved AI navigation. Pair it with `accountScenarios` for the scenario that has the step.
   */
  modelRoute?: { routeId: string; routeRevision: string };
  /**
   * The policy limits of a route-pinned plan, as the broker derives them from the route's budgets (`e2eAgentRoutePolicyLimits`, Task 4.2): a round that makes model calls is held to
   * them, so a plan whose collector must accept model usage needs them. Default: the small model-free ones this builder always used.
   */
  routeLimits?: E2EPolicy["limits"];
  /**
   * Plans an audit replay of a round (Task 4.6b), for the tests and the journeys: the policy still pins `modelRoute` (the revision and the agent-sized limits), but the compilation
   * context and the admission name no model route, the admission carries `replay` (the recordings, and what the source round showed: by default every assertion passed and no CSV),
   * and the executor plan carries the same recordings and no model channel.
   */
  replay?: { traces: readonly E2EReplayTrace[]; sourceRoundId?: string; attempt?: number; sourceCases?: readonly E2EReplaySourceCase[] };
  /**
   * The time the registered runtime row is dated from (qualified an hour before it, expiring a day after it). A case id is bound to the runtime row, so two plans built for the same case
   * (a round and its replay) pass the same one, as a registry that holds one stored row gives them.
   */
  runtimeAt?: number;
  /** The runner the registered runtime row records (default: a Linux 6.8.0 arm64 host). A journey on a real Docker host passes what its executor image reports, as the broker's registration does. */
  runner?: WebApiProbeRunner }): WebApiProbePlan {
  const kind = options.probe.startsWith("web-") ? "web" as const : "api" as const;
  const inferred = options.inferred === true;
  if (inferred && (options.recipeBuild || options.recipeStart || options.mock)) throw new Error("an inferred-recipe app has no recipe to edit and no mock to approve");
  const rawPackage = JSON.parse(readFileSync(join(options.appRoot, "package.json"), "utf8")) as { agentx: { e2e: { targetAccounts: { baseTargetId: string; profileId: string }[];
    recipe: { recipeDigest: string; build: unknown[]; launch: { start: Record<string, unknown> } } } } };
  if (!inferred && (options.recipeBuild || options.recipeStart)) {
    const recipe = rawPackage.agentx.e2e.recipe;
    const launch = options.recipeStart ? { ...recipe.launch, start: { ...recipe.launch.start, ...options.recipeStart } } : recipe.launch;
    const { recipeDigest: _digest, ...body } = { ...recipe, launch, build: options.recipeBuild ?? recipe.build };
    void _digest;
    rawPackage.agentx.e2e.recipe = { ...body, recipeDigest: hash(canonicalJson(body)) };
  }
  // The qualification app lists its account variants on the web target only; an app that lists the API target's own variants keeps them.
  if (!inferred && kind === "api" && !rawPackage.agentx.e2e.targetAccounts.some((item) => item.baseTargetId === "api-1")) {
    rawPackage.agentx.e2e.targetAccounts = rawPackage.agentx.e2e.targetAccounts.map((item) => ({ ...item, baseTargetId: "api-1" }));
  }
  const packagePath = inferred ? "package.json" : kind === "web" ? "apps/orders/package.json" : "server/package.json";
  const appDirectory = dirname(packagePath);
  // An origin's contract path is repository-relative; the app tree is the repository in the installed asset and sits in `appDirectory` in the plan's snapshot.
  if (!inferred) {
    const service = (rawPackage.agentx.e2e as unknown as { service: { originBindings: { contractPath?: string }[] } }).service;
    for (const binding of service.originBindings) if (binding.contractPath !== undefined) binding.contractPath = `${appDirectory}/${binding.contractPath}`;
  }
  const packageBytes = Buffer.from(JSON.stringify(rawPackage));
  const mockFiles = options.mock ? [
    { path: `${appDirectory}/inventory/openapi.json`, bytes: readFileSync(join(options.appRoot, "inventory/openapi.json")) },
    { path: `${appDirectory}/e2e/mocks/inventory-v1.json`, bytes: readFileSync(join(options.appRoot, "e2e/mocks/inventory-v1.json")) },
  ] : [];
  // An inferred recipe runs `npm ci`, so the snapshot carries the lockfile discovery looks for.
  const lockFiles = inferred ? [{ path: "package-lock.json", bytes: readFileSync(join(options.appRoot, "package-lock.json")) }] : [];
  const sourceFiles = [{ path: packagePath, bytes: packageBytes }, ...lockFiles, ...mockFiles];
  const treeSha = gitTreeSha(sourceFiles.map((item) => ({ path: item.path, mode: "100644", objectId: gitBlob(item.bytes) })));
  const candidate = createCandidateManifest([{ repositoryId: "fixture/orders", commitSha: "a".repeat(40), treeSha }]);
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
    treePaths: sourceFiles.map((item) => item.path).sort(), sources: sourceFiles.map((item) => ({ ...item, sha256: hash(item.bytes), kind: "blob" as const })) };
  // The application path's discovery also offers each base target's signed-out variant; the setup proposal is made from the plain one, as the broker makes it.
  const discovery = inspectE2EApplicationRepository(snapshot, candidate);
  // One target per account profile; several scenarios of one account share it.
  const accountProfileIds = [...new Set(options.accountScenarios?.map((item) => item.accountProfileId) ?? [options.role === "viewer" ? "orders-viewer" : "orders-owner"])];
  const targets = accountProfileIds.map((profileId) => {
    const found = discovery.inspection.proposedTargets.find((item) => item.kind === kind && item.accountProfileId === profileId);
    if (!found) throw new Error(`the app has no ${kind} target for account profile ${profileId}`);
    return found;
  });
  const target = targets[0]!;
  const accountProfileId = accountProfileIds[0]!;
  const application = discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  // The account context names the application's package manifest (an inferred app also has a lockfile among its metadata, which is not an application source path).
  const metadataRefs = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths);
  const accountContext = metadataRefs.find((ref) => /(^|\/)package\.json$/.test(ref.path)) ?? metadataRefs[0]!;
  const scenarios = options.accountScenarios
    ? options.accountScenarios.map((item) => item.scenario(targets[accountProfileIds.indexOf(item.accountProfileId)]!.targetId))
    : [scenarioFor(options.probe, target.targetId, accountProfileId)];
  const scenario = scenarios[0]!;
  const accountRefs = accountProfileIds.map((profileId) => (profileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID ? e2eAnonymousRuntimeAccountRef(application.applicationId)
    : { applicationId: application.applicationId, profileId, revision: 1, definitionDigest: "8".repeat(64) }));
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const runtimeProfileId = E2E_EXECUTOR_HOST_PROFILE_ID;
  const runtime = registeredRuntime(kind, runtimeProfileId, options.runtimeAt ?? nowMs, options.modelRoute !== undefined && kind === "web", options.runner);
  // The approved mock: the inventory fixture of the app tree, linked by the inventory origin's contract (its OpenAPI document) to the discovery component of that document.
  const [openApiFile, fixtureFile] = mockFiles;
  const mockComponentId = openApiFile === undefined ? "" : e2eApiSchemaComponentId(openApiFile.path);
  const mockFixture = fixtureFile === undefined ? undefined : E2EApiMockFixtureSchema.parse(JSON.parse(fixtureFile.bytes.toString("utf8")));
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: targets.map((item) => item.targetId), portableOperationRefs: [],
    mockFixtureRefs: mockFixture === undefined || fixtureFile === undefined ? [] : [{ componentId: mockComponentId, requestedTargetId: target.targetId, operationId: mockFixture.operationId,
      sourcePath: fixtureFile.path, sourceSha256: hash(fixtureFile.bytes) }],
    accountContextRefs: accountProfileIds.map((profileId) => ({ applicationId: application.applicationId, profileId, sourcePath: accountContext.path, sourceSha256: accountContext.sha256 })),
    scenarios, semanticExportDeltas: [], applicationRuntimeRefs: targets.map((item, index) => ({ targetId: item.targetId, applicationId: application.applicationId,
      recipeDigest: application.recipe!.recipeDigest, sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths),
      runtimeProfileId, accountProfileId: accountProfileIds[index]! })), runtimeAccountRefs: accountRefs, unavailableTargetRefs: [] });
  // The probe qualifies the runtime that targets are approved against, so its setup carries that qualified profile like a real approved setup.
  const setupProposal = proposeE2ESetup({ inspection: inspectE2ERepository(snapshot, candidate).inspection, snapshot, expectedCandidate: candidate, readyProfiles: [{ kind, profileId: runtimeProfileId }] });
  const setupApproval = { artifactId: "setup-approval", digest: hash(canonicalJson(setupProposal)) };
  const planDigest = "c".repeat(64);
  const semanticApproval = { artifactId: "semantic-approval", digest: "d".repeat(64) };
  const applicationApprovalBinding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent, artifactId: semanticApproval.artifactId,
    artifactSha256: semanticApproval.digest, planDigest, setupProposal, setupApproval });
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: scenarios.map((item) => item.scenarioId),
    targets: withE2EAnonymousTargets(setupProposal.targets, discovery.anonymous), defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: options.modelRoute?.routeRevision ?? null,
    // The real web engine reports screenshot and video capability, and the compiler binds the launch descriptor to the capture policy.
    capture: { screenshots: kind === "web", traces: false, video: kind === "web", downloads: false },
    limits: options.routeLimits ?? { runTimeoutMs: 600_000, startupTimeoutMs: 60_000, preparationTimeoutMs: 60_000, caseTimeoutMs: 120_000,
      maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest, policy, scenarios,
    selectedTargetIds: targets.map((item) => item.targetId), intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval, applicationApprovalBinding,
    registeredRuntimes: [runtime], runtimeAccountRefs: accountRefs, now: nowMs, sandboxAvailability: null,
    runtimeAvailability: targets.map((item) => ({ targetId: item.targetId, profileId: runtimeProfileId, connection: "connected" as const,
      approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "orders-auth-r1" })),
    portableApprovalBinding: { schemaVersion: "portable-approval-binding/v1" as const, planDigest, semanticApproval, operations: [], accountContexts: [],
      bindingDigest: "0".repeat(64) }, approvedSemanticApproval: semanticApproval,
    mockableComponents: mockFixture === undefined || openApiFile === undefined ? [] : [{ componentId: mockComponentId, requestedTargetId: target.targetId, kind: "api" as const,
      sourceRefs: [{ path: openApiFile.path, sha256: hash(openApiFile.bytes) }], fixture: mockFixture }] };
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
    lockfileRefs: e2eApplicationLockfileRefs(applicationApprovalBinding.applications.find((item) => item.applicationId === application.applicationId)!.sourceRefs), toolchainManifestDigest: "6".repeat(64), outputs: [output], createdAt: now };
  const build = { ...buildBody, manifestDigest: e2eAppBuildManifestDigest(buildBody) };
  const applicationBindings = new Map([[application.applicationId, { approval: applicationApprovalBinding, build,
    artifacts: [{ ...output, buildManifestDigest: build.manifestDigest }], buildSource }]]);
  const preparedEnvironmentDigest = "7".repeat(64);
  const runtimeBindings = new Map([[runtimeProfileId, runtime]]);
  const cliHostsByProfile = new Map([[runtimeProfileId, registeredHost()]]);
  const launchTargets = targets.map((item) => webApiApplicationLaunchTarget({ target: { targetId: item.targetId, kind, applicationId: application.applicationId, runtimeProfileId }, runtime, capture: policy.capture }))
    .sort((left, right) => (left.targetId < right.targetId ? -1 : left.targetId > right.targetId ? 1 : 0));
  const bundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1" as const, scenarios, bundleDigest: "0".repeat(64) };
  const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
  const replayBindings = options.replay === undefined ? undefined : options.replay.traces.map((trace) => ({ caseId: trace.caseId, stepIndex: trace.stepIndex, keyHash: trace.keyHash,
    traceSha256: trace.binding.traceSha256, actionCount: trace.binding.actionCount }));
  // The built-in probes keep the model-free limits they were pinned and qualified with (before the evaluation fix RUN-1): they are small fixtures, not a customer's build. This makes the earlier rule
  // (`e2eEffectiveRoundLimitsBeforeRun1` and the validator's fallback) a permanent dependency of the qualification probes: retire it only after re-pinning them.
  const context = { selectionInput, executionPlan, bundle, applicationBindings, runtimeBindings, launchTargets, modelRoute: options.replay === undefined ? options.modelRoute ?? null : null, cliHostsByProfile,
    modelFreeShardRule: "before-run-1" as const,
    preparedEnvironmentsByGroup: new Map([[group.groupId, { preparedEnvironmentDigest, originByApplicationId: [{ applicationId: application.applicationId, origin: WEB_API_PROBE_APP_ORIGIN }] }]]),
    ...(replayBindings === undefined ? {} : { replay: { bindings: replayBindings } }) };
  const compiled = compileE2EApplicationScenarios({ context, groupId: group.groupId });
  const roundId = randomUUID();
  // As the control plane admits a round: a route-pinned policy's round with no agent step runs under the model-free limits, and its deadline fits them (Task 4.3a).
  const roundLimits = options.modelRoute === undefined ? policy.limits : e2eEffectiveRoundLimitsBeforeRun1(policy.limits, e2eApplicationGroupUsesModel(compiled));
  const deadlineSpanMs = options.deadlineMs ?? Math.min(300_000, roundLimits.runTimeoutMs);
  const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: options.runId ?? randomUUID(), roundId, taskId: options.taskId ?? "task-orders", operationId: randomUUID(), operationFence: 1,
    workflowRevision: 1, groupId: group.groupId, executionPlanDigest: executionPlan.digest, executionMode: group.mode, mockManifestDigest: group.mockManifestDigest,
    authorizationRevision: "orders-auth-r1", candidateDigest: candidate.digest, planDigest, policyDigest: e2ePolicyDigest(policy), bundleDigest: bundle.bundleDigest,
    appBuildDigest: hash(canonicalJson(compiled.inventory)), environmentDigest: preparedEnvironmentDigest, runtimeManifestDigest: runtime.manifestDigest,
    modelRouteRevision: options.modelRoute?.routeRevision ?? null, expectedCases: compiled.expectedCases, admittedAt: now, deadlineAt: new Date(nowMs + deadlineSpanMs).toISOString() });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId: binding.taskId, operationId: binding.operationId, operationFence: binding.operationFence,
    workflowRevision: binding.workflowRevision, executionPlanDigest: executionPlan.digest, admittedAt: now, deadlineAt: binding.deadlineAt,
    limits: roundLimits, groupBindings: [binding] });
  const sourceSnapshotWire = { candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true as const,
    treePaths: snapshot.treePaths, sources: snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256,
      bytesBase64: Buffer.from(item.bytes).toString("base64"), kind: "blob" as const })) };
  const groupAdmission = { protocol: "trusted-e2e-application/v1" as const, outerBinding: binding, cliHost: compiled.cliHost,
    preparedEnvironmentDigest, originByApplicationId: compiled.originByApplicationId, compiledInventoryDigest: compiled.inventory.digest,
    shards: compiled.inventory.shards.map((item) => ({ shardId: item.shardId, targetId: item.targetId, inventoryDigest: item.inventoryDigest,
      configDigest: item.expectedConfigDigest, expectedCaseIds: [...item.expectedCaseIds] })) };
  const admissionBody = { schemaVersion: "workflow-e2e-application-admission/v1" as const, taskId: binding.taskId, operationId: binding.operationId,
    operationFence: binding.operationFence, workflowRevision: binding.workflowRevision, candidateDigest: candidate.digest,
    candidateCommitSha: snapshot.commitSha, candidateTreeSha: snapshot.treeSha,
    sourceSnapshot: sourceSnapshotWire, intent, intentDigest: hash(canonicalJson(intent)),
    selectionInput: { ...selectionInput, sourceSnapshot: sourceSnapshotWire }, applicationApprovalBinding,
    applicationBindings: [...applicationBindings].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)),
    runtimeBindings: [...runtimeBindings].map(([key, value]) => ({ key, value })), launchTargets, modelRoute: options.replay === undefined ? options.modelRoute ?? null : null,
    cliHosts: [...cliHostsByProfile].map(([profileId, descriptor]) => ({ profileId, descriptor })),
    preparedEnvironments: [{ groupId: group.groupId, preparedEnvironmentDigest, originByApplicationId: compiled.originByApplicationId }],
    policy, bundle, executionPlan, portableProjection: null, round, groups: [groupAdmission],
    ...(options.replay === undefined ? {} : { replay: { purpose: "replay" as const, sourceRoundId: options.replay.sourceRoundId ?? randomUUID(), sourceAdmissionSha256: "e".repeat(64),
      sourceEvidenceSha256: "f".repeat(64), attempt: options.replay.attempt ?? 1,
      sourceCases: options.replay.sourceCases ?? compiled.expectedCases.map((expected) => ({ caseId: expected.caseId,
        assertionOutcomes: expected.assertionDigests.map(() => "passed" as const), csvSha256: null })),
      traces: [...options.replay.traces] } }) };
  const admission = E2EApplicationExecutionAdmissionSchema.parse(JSON.parse(encodeE2EApplicationExecutionAdmission({ ...admissionBody,
    admissionDigest: hash(canonicalJson(admissionBody)) } as never)));
  const role = options.role ?? "owner";
  const declaredProfiles = inferred ? [] : (rawPackage.agentx.e2e as unknown as { accountProfiles: { profileId: string; login?: unknown }[] }).accountProfiles;
  // The anonymous profile is nobody: it has no email, no password and no seed record.
  const accounts = accountProfileIds.filter((profileId) => profileId !== E2E_ANONYMOUS_ACCOUNT_PROFILE_ID).map((profileId) => ({ profileId, email: `rovara-${randomUUID()}@example.invalid`, password: `pw-${randomUUID()}-${randomUUID()}`,
    ...(declaredProfiles.find((item) => item.profileId === profileId)?.login === undefined ? {} : { login: declaredProfiles.find((item) => item.profileId === profileId)!.login }) }));
  const { email, password } = accounts[0] ?? { email: "", password: "" };
  const plan = E2EExecutorPlanSchema.parse({ schemaVersion: "e2e-executor-plan/v1", runId: binding.runId, groupId: group.groupId, admission,
    admissionDigest: admission.admissionDigest, app: { origin: E2E_EXECUTOR_APP_ORIGIN, health: { path: inferred ? "/" : "/health", expectedStatus: 200, timeoutMs: options.healthTimeoutMs ?? 30_000 } },
    deadlineAt: Date.parse(binding.deadlineAt), accounts, ...(options.replay === undefined ? {} : { replay: { traces: [...options.replay.traces] } }) });
  return { plan, compiled, caseId: compiled.expectedCases[0]!.caseId, probe: options.probe, scenario, scenarios,
    seed: { accounts: inferred ? [] : [{ email, passwordDigest: createHash("sha256").update(password, "utf8").digest("hex"), subjectId: `subject-${randomUUID()}`,
      tenantId: "tenant-a", role, displayName: role === "owner" ? "Orders Owner" : "Orders Viewer" }] },
    account: { email, password } };
}

/** The outside host the egress probes try to reach; the qualification oracle requires exactly this one to be recorded as blocked. */
export const WEB_API_EGRESS_PROBE_HOST = "probe.example.com";
/** The IP literal the API egress probe dials besides that host: a public address that answers plain HTTP, so only a wall can make the call fail. */
export const WEB_API_RAW_EGRESS_PROBE_URL = "http://1.1.1.1/";
type BuildCommand = { program: string; args: string[]; cwd: string; timeoutMs: number; env: Record<string, string> };
/** How one required qualification probe is driven through the qualification app; the oracle in contracts judges the outcome, not this table. */
export type WebApiProbeDriver = Readonly<{ probe: WebApiProbeName; /** A defect file under the app's defects directory, placed in the owned mount. */ defect: string | null;
  appEnv: Readonly<Record<string, string>>; recipeBuild: readonly BuildCommand[] | null;
  /** Replaces the arguments of the app's start command (the program stays `node`); null starts the app as its recipe says. */
  startArgs: readonly string[] | null;
  /** True when the probe's plan approves the app's inventory mock for its target; absent means no mock is approved. */
  mock?: boolean;
  /** Present on the agent probes (Task 4.5): the scripted model's turns, from the installed probe asset. The plan then pins the scripted route and the runner needs a model channel for it. */
  agent?: Readonly<{ script: readonly E2EAgentProbeScriptTurn[] }> }>;

export function webApiProbeDriver(probeId: string): WebApiProbeDriver {
  switch (probeId) {
    case "web-csv-positive-v1": return { probe: "web-csv-positive-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: null };
    case "web-csv-negative-v1": return { probe: "web-csv-positive-v1", defect: "extra-order.json", appEnv: {}, recipeBuild: null, startArgs: null };
    case "web-egress-denial-v1": return { probe: "web-egress-denial-v1", defect: null, appEnv: { FIXTURE_EGRESS_PROBE_URL: `https://${WEB_API_EGRESS_PROBE_HOST}/ping` }, recipeBuild: null, startArgs: null };
    case "api-state-positive-v1": return { probe: "api-state-positive-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: null };
    case "api-egress-denial-v1": return { probe: "api-egress-denial-v1", defect: null, appEnv: { FIXTURE_INVENTORY_ORIGIN: `https://${WEB_API_EGRESS_PROBE_HOST}`, FIXTURE_RAW_EGRESS_URL: WEB_API_RAW_EGRESS_PROBE_URL }, recipeBuild: null, startArgs: null };
    // The inventory origin is declared, and the plan approves its mock: the page's request reaches the app, which reads one order's stock from the mock, once.
    case "web-mock-origin-v1": return { probe: "web-inventory-status-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: null, mock: true };
    // The same page and the same assertion with no approved mock, against an app that hides a failed dependency behind the answer the page expects: every assertion can hold,
    // and the only fact against a pass is the call the app made to an origin that no approved mock serves.
    case "web-unmocked-call-v1": return { probe: "web-inventory-status-v1", defect: "swallow-dependency.json", appEnv: {}, recipeBuild: null, startArgs: null, mock: false };
    case "build-imds-denial-v1": return { probe: "web-csv-positive-v1", defect: null, appEnv: {}, recipeBuild: [webApiBuildProbeCommand("build-imds-denial-v1")], startArgs: null };
    case "build-lateral-denial-v1": return { probe: "web-csv-positive-v1", defect: null, appEnv: {}, recipeBuild: [webApiBuildProbeCommand("build-lateral-denial-v1")], startArgs: null };
    // The CSV scenario again: what makes this probe is that its run must also carry the executor's Chromium sandbox attestation (the pin's `chromiumSandbox`).
    case "chromium-sandbox-v1": return { probe: "web-csv-positive-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: null };
    // Task 4.5: the CSV export as an AI-navigated step, under the scripted route. The script is the asset's, so the pinned asset digest covers what the double does.
    case "web-agent-scripted-v1": return { probe: "web-agent-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: null, agent: { script: webApiAgentProbeScript(probeId) } };
    // The double concludes at once without acting, so no file is downloaded: the case is UNKNOWN `agent-no-download`.
    case "web-agent-wrong-action-v1": return { probe: "web-agent-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: null, agent: { script: webApiAgentProbeScript(probeId) } };
    // The scripted run again, with the app started behind a guard that keeps checking every path to the model (socket, model proxy, gateway) for as long as the app runs, and again before it answers each request, so a check runs inside the window where the channel is open for the executor (the asset's start command).
    case "web-agent-app-isolation-v1": return { probe: "web-agent-isolation-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: webApiAgentIsolationGuardArgs(), agent: { script: webApiAgentProbeScript(probeId) } };
    case "app-host-denial-v1": return { probe: "api-state-positive-v1", defect: null, appEnv: {}, recipeBuild: null, startArgs: webApiAppStartGuardArgs() };
    default: throw new Error(`no probe plan for ${probeId}`);
  }
}

/** The scripted model's turns for an agent probe, from its installed asset (so the pinned asset digest covers them). */
export function webApiAgentProbeScript(probeId: string): readonly E2EAgentProbeScriptTurn[] {
  const asset = loadWebApiQualificationProbeAssets().find((item) => item.probeId === probeId);
  const oracle = asset?.probe.oracle;
  if (oracle === undefined || (oracle.kind !== "agent-scripted" && oracle.kind !== "agent-wrong-action" && oracle.kind !== "agent-app-isolation")) throw new Error(`the ${probeId} probe asset has no script`);
  return oracle.script.map((turn) => ({ ...turn }));
}

/**
 * The start command arguments of `web-agent-app-isolation-v1`, from the installed probe asset. The app is started behind a guard that looks for `/run/rovara/model.sock`, tries to
 * connect to `model-proxy:8080` (unless the name leads only to the run's own sinkhole) and to the gateway on 8080, and starts the app only when every attempt fails.
 */
export function webApiAgentIsolationGuardArgs(): readonly string[] {
  const asset = loadWebApiQualificationProbeAssets().find((item) => item.probeId === "web-agent-app-isolation-v1")!;
  if (asset.probe.oracle.kind !== "agent-app-isolation") throw new Error("the app isolation probe asset has no start guard");
  return Object.freeze([...asset.probe.oracle.appStart.args]);
}

/** The build command and its expected exit code come from the installed probe asset, so the probe the qualifier records is the one that ran. */
export function webApiBuildProbeCommand(probeId: "build-imds-denial-v1" | "build-lateral-denial-v1"): BuildCommand {
  const asset = loadWebApiQualificationProbeAssets().find((item) => item.probeId === probeId)!;
  if (asset.probe.oracle.kind !== "build-command-failure") throw new Error(`the ${probeId} probe asset has no build command`);
  const { program, args, cwd, timeoutMs, env } = asset.probe.oracle.build;
  return { program, args: [...args], cwd, timeoutMs, env: { ...env } };
}

/**
 * The start command arguments of `app-host-denial-v1`, from the installed probe asset (so the pinned asset digest covers them). The qualification app is
 * started behind a guard that connects to the host's address on the run's internal bridge (the first address of the on-link network, from the route table)
 * at port 8080, where the Rovara worker listens on a runner. The app starts, and so the probe can pass, only when that connection times out, which is
 * what the host firewall's DROP does: a refusal or a connection means the host is reachable, and with no route to read the guard refuses to start too.
 */
export function webApiAppStartGuardArgs(): readonly string[] {
  const asset = loadWebApiQualificationProbeAssets().find((item) => item.probeId === "app-host-denial-v1")!;
  if (asset.probe.oracle.kind !== "protected-network-denial" || asset.probe.oracle.appStart === undefined) throw new Error("the app host probe asset has no start guard");
  return Object.freeze([...asset.probe.oracle.appStart.args]);
}

/** The lifecycle input for the probe's one group, shaped like the broker's, for `runIsolatedE2EApplication`. */
export function webApiProbeRunInput(probe: WebApiProbePlan) {
  const { compiled, plan } = probe;
  const ref = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
  const app = compiled.applicationBindings.get(ref.applicationId)!; const runtime = compiled.runtimeBindings.get(ref.runtimeProfileId)!;
  return { binding: plan.admission.round.groupBindings[0]!, suite: { bundle: compiled.bundle, files: compiled.shards[0]!.files, expectedCases: compiled.expectedCases },
    profile: { profileId: runtime.profileId, kind: "web" as const, runtimeManifestDigest: runtime.manifestDigest,
      applications: [{ applicationId: ref.applicationId, appBuildManifestDigest: app.build.manifestDigest,
        appRecipe: app.approval.applications.find((item) => item.applicationId === ref.applicationId)!.recipe }],
      networkPolicyDigest: runtime.capabilities.networkPolicyDigest, seedDigest: "a".repeat(64), limits: runtime.binding,
      capture: compiled.runtimeAdmissionContext.selectionInput.policy.capture }, modelPermit: null };
}
