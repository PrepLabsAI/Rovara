import { createHash } from "node:crypto";
import { E2EApplicationExecutionAdmissionSchema, E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, e2eApplicationLockfileRefs, canonicalJson, e2eAnonymousRuntimeAccountRef, createCandidateManifest, e2eApplicationMetadataSourceRefs, e2eAppBuildManifestDigest,
  e2ePolicyDigest, e2eRuntimeCapabilityDigest, e2eScenarioBundleDigest, E2EApplicationPlanIntentSchema,
  E2ERegisteredRuntimeSchema, E2ERoundSchema, E2ERunBindingSchema, E2ERuntimeCapabilityDescriptorSchema,
  inspectE2EApplicationRepository, inspectE2ERepository, projectE2EApplicationPortableSelection, withE2EAnonymousTargets, proposeE2ESetup, selectE2EApplicationExecutionPlan,
  type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { deriveE2EApplicationApprovalBinding } from "../../packages/broker/src/e2e/application-plan-binding.js";
import { deriveE2EFeaturePortableApprovalBinding } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import { compileE2EApplicationScenarios, createE2EApplicationPortableChildBindings, encodeE2EApplicationExecutionAdmission,
  type E2ECompiledApplicationSuite } from "../../packages/verifier/src/application-scenarios.js";
import { encodeE2EApplicationBuildSourceArchive } from "../../packages/verifier/src/application-build-source.js";

export const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), Buffer.from(bytes)])).digest("hex");
export function gitTreeSha(entries: readonly { path: string; mode: string; objectId: string }[]): string {
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
      ...node.files.map((file) => ({ name: file.name, directory: false,
        bytes: Buffer.concat([Buffer.from(`${file.mode} ${file.name}\0`), Buffer.from(file.objectId, "hex")]) })),
      ...[...node.dirs].map(([name, child]) => ({ name, directory: true,
        bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(createHash("sha1").update(write(child)).digest("hex"), "hex")]) })),
    ].sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.directory ? "/" : "")), Buffer.from(right.name + (right.directory ? "/" : ""))));
    const body = Buffer.concat(rows.map((row) => row.bytes));
    return Buffer.concat([Buffer.from(`tree ${body.byteLength}\0`), body]);
  };
  return createHash("sha1").update(write(root)).digest("hex");
}

function registeredApiRuntime(profileId: string, now: number, supportsAgent = false) {
  const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId,
    kind: "api", host: { os: "linux", arch: "x64" }, engine: { name: "api-supervisor", version: "1.0.0", spiVersion: 1 },
    runtimeManifestDigest: "f".repeat(64), supportedSteps: supportsAgent ? ["request", "agent"] : ["request"], supportedAssertions: ["http-status"], evidenceScopes: ["runtime"],
    networkPolicyDigest: "1".repeat(64), protocols: ["http"], mocks: ["source-backed-api-fixtures/v1"] });
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux" as const, arch: "x64" as const };
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId, capabilityDigest,
    runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "2".repeat(64), fixtureRefs: [{ path: "fixtures/api.json", sha256: "3".repeat(64) }],
    positiveProbeIds: ["api-responds"], negativeProbeIds: ["api-blocked-network"] };
  const probeManifest = { ...probeBody, manifestDigest: hash(canonicalJson(probeBody)) };
  return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "runtime-catalog",
    catalogRevision: 3, profileId, generation: 4, binding, bindingDigest: hash(canonicalJson(binding)), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "22222222-2222-4222-8222-222222222222", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: hash(canonicalJson(runnerEnvironment)), runnerToolchain,
    runnerToolchainDigest: hash(canonicalJson(runnerToolchain)), capabilities, capabilityDigest, probeManifest,
    qualificationEvidenceRef: { key: "runtime-evidence/api-qual.json", sha256: "4".repeat(64), byteLength: 128 },
    state: "READY", qualifiedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
}

/** A source-derived, engine-less API group used only for offline collector conformance. */
export function createCompiledApiApplicationFixture(options: { modelRoute?: { routeId: string; routeRevision: string }; hostManifestDigest?: string; now?: string; withApiMock?: boolean;
  agentAfterRequest?: boolean;
  /** Plan the case on the application's implicit `rovara-anonymous` API variant, with the fixed anonymous account reference (Ruling AZ). */
  anonymous?: boolean } = {}): { compiled: E2ECompiledApplicationSuite; binding: ReturnType<typeof E2ERunBindingSchema.parse>;
  admission: unknown;
  round: ReturnType<typeof E2ERoundSchema.parse>; snapshot: E2ESourceSnapshot; now: string } {
  const packageBytes = Buffer.from(JSON.stringify({ name: "service", scripts: { start: "node server.js" }, dependencies: { express: "1.0.0" } }));
  const openApiBytes = Buffer.from(JSON.stringify({ openapi: "3.0.0", info: { title: "Service", version: "1" }, paths: {
    "/health": { get: { operationId: "getHealth", responses: {
      "200": { description: "healthy", content: { "application/json": { schema: { type: "object", properties: { healthy: { type: "boolean" } }, required: ["healthy"], additionalProperties: false } } } },
      "403": { description: "refused", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } }, required: ["error"], additionalProperties: false } } } },
    } } },
  } }));
  const apiFixture = { schemaVersion: "source-backed-api-fixtures/v1" as const, operationId: "getHealth", method: "GET" as const,
    path: "/health", inputField: "kind", variants: [
      { id: "success" as const, inputValue: "success", status: 200, body: { healthy: true } },
      { id: "refusal" as const, inputValue: "refusal", status: 403, body: { error: "refused" } },
      { id: "invalid-data" as const, inputValue: "invalid", status: 200, body: { healthy: "invalid" } },
    ] };
  const fixtureBytes = Buffer.from(canonicalJson(apiFixture));
  // A signed-out case runs on the recipe discovery infers from a root package with a start script and a lockfile (the start-script fallback is not offered a visitor).
  const sourceFiles = [...(options.anonymous === true ? [{ path: "package.json", bytes: packageBytes }, { path: "package-lock.json", bytes: Buffer.from("{}") }] : [{ path: "apps/service/package.json", bytes: packageBytes }]),
    ...(options.withApiMock ? [{ path: "apps/service/openapi.json", bytes: openApiBytes }, { path: "apps/service/e2e-fixture.json", bytes: fixtureBytes }] : [])];
  const treeEntries = sourceFiles.map((item) => ({ path: item.path, mode: "100644", objectId: gitBlob(item.bytes) }));
  const treeSha = gitTreeSha(treeEntries);
  const candidate = createCandidateManifest([{ repositoryId: "fixture/api", commitSha: "a".repeat(40), treeSha }]);
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
    treePaths: sourceFiles.map((item) => item.path).sort(), sources: sourceFiles.map((item) => ({ ...item, sha256: hash(item.bytes), kind: "blob" as const })) };
  const discovery = inspectE2ERepository(snapshot, candidate);
  // The setup proposal is made from the plain discovery; the application path also reads each base target's signed-out variant, derived from the base.
  const policyTargets = withE2EAnonymousTargets(discovery.inspection.proposedTargets, inspectE2EApplicationRepository(snapshot, candidate).anonymous);
  const target = policyTargets.find((item) => item.kind === "api" && (item.accountProfileId === E2E_ANONYMOUS_ACCOUNT_PROFILE_ID) === (options.anonymous === true))!;
  const application = discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  const accountContext = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths).find((ref) => ref.path.endsWith("package.json"))!;
  const scenario = { scenarioId: "service-health", requirementId: "health-status", requestedTargetIds: [target.targetId], required: true,
    accountProfileId: target.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
    steps: options.modelRoute && !options.agentAfterRequest
      ? [{ kind: "agent" as const, goal: "Inspect the service response without external effects", maxActions: 1 },
        { kind: "request" as const, requestId: "health", path: "/health", method: "GET" as const, body: options.withApiMock ? { kind: "success" } : {} }]
      : [{ kind: "request" as const, requestId: "health", path: "/health", method: "GET" as const, body: options.withApiMock ? { kind: "success" } : {} },
        ...(options.modelRoute ? [{ kind: "agent" as const, goal: "Inspect the service response without external effects", maxActions: 1 }] : [])],
    assertions: [{ kind: "http-status" as const, path: "/health", method: "GET" as const, equals: 200 }] };
  const accountRef = options.anonymous === true ? e2eAnonymousRuntimeAccountRef(application.applicationId)
    : { applicationId: application.applicationId, profileId: target.accountProfileId, revision: 1, definitionDigest: "8".repeat(64) };
  const nowMs = options.now ? Date.parse(options.now) : Date.now() + 30_000;
  if (!Number.isFinite(nowMs)) throw new Error("API conformance fixture admission time must be a finite timestamp");
  const now = new Date(nowMs).toISOString();
  const runtimeProfileId = "api-runtime"; const runtime = registeredApiRuntime(runtimeProfileId, nowMs, options.modelRoute !== undefined);
  const componentId = `api-schema-${createHash("sha256").update("apps/service/openapi.json").digest("hex").slice(0, 12)}`;
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId], portableOperationRefs: [],
    mockFixtureRefs: options.withApiMock ? [{ componentId, requestedTargetId: target.targetId, operationId: "getHealth",
      sourcePath: "apps/service/e2e-fixture.json", sourceSha256: hash(fixtureBytes) }] : [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId, sourcePath: accountContext.path, sourceSha256: accountContext.sha256 }],
    scenarios: [scenario], semanticExportDeltas: [], applicationRuntimeRefs: [{ targetId: target.targetId, applicationId: application.applicationId,
      recipeDigest: application.recipe!.recipeDigest, sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths),
      runtimeProfileId, accountProfileId: target.accountProfileId }], runtimeAccountRefs: [accountRef], unavailableTargetRefs: [] });
  const setupProposal = proposeE2ESetup({ inspection: discovery.inspection, snapshot, expectedCandidate: candidate });
  const setupApproval = { artifactId: "setup-approval", digest: hash(canonicalJson(setupProposal)) }; const planDigest = "c".repeat(64);
  const semanticApproval = { artifactId: "semantic-approval", digest: "d".repeat(64) };
  const applicationApprovalBinding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent, artifactId: semanticApproval.artifactId,
    artifactSha256: semanticApproval.digest, planDigest, setupProposal, setupApproval });
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [scenario.scenarioId],
    targets: policyTargets, defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: options.modelRoute?.routeRevision ?? null,
    capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
      maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest, policy, scenarios: [scenario],
    selectedTargetIds: [target.targetId], intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval, applicationApprovalBinding,
    registeredRuntimes: [runtime], runtimeAccountRefs: [accountRef], now: Date.parse(now), sandboxAvailability: null,
    runtimeAvailability: [{ targetId: target.targetId, profileId: runtimeProfileId, connection: "connected" as const,
      approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "api-auth-r1" }],
    portableApprovalBinding: { schemaVersion: "portable-approval-binding/v1" as const, planDigest, semanticApproval, operations: [], accountContexts: [],
      bindingDigest: "0".repeat(64) }, approvedSemanticApproval: semanticApproval,
    mockableComponents: options.withApiMock ? [{ componentId, requestedTargetId: target.targetId, kind: "api" as const,
      sourceRefs: [{ path: "apps/service/openapi.json", sha256: hash(openApiBytes) }], fixture: apiFixture }] : [] };
  selectionInput.portableApprovalBinding.bindingDigest = hash(canonicalJson(Object.fromEntries(Object.entries(selectionInput.portableApprovalBinding)
    .filter(([key]) => key !== "bindingDigest"))));
  const executionPlan = selectE2EApplicationExecutionPlan(selectionInput); const group = executionPlan.groups[0]!;
  const archive = encodeE2EApplicationBuildSourceArchive(sourceFiles.map((item) => ({ ...item, mode: "100644" as const })));
  const manifestTreeEntries = sourceFiles.map((item) => ({ path: item.path, mode: "100644" as const, objectId: gitBlob(item.bytes) }));
  const sourceBody = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: candidate.digest,
    repository: { repositoryId: "fixture/api", commitSha: snapshot.commitSha, treeSha }, sourceState: "candidate-index-tree" as const,
    pathPolicy: "existing-safe-e2e-source-path/v1" as const, treeEntries: manifestTreeEntries,
    files: sourceFiles.map((item) => ({ path: item.path, mode: "100644" as const, gitBlobId: gitBlob(item.bytes), sha256: hash(item.bytes), byteLength: item.bytes.byteLength })), omissions: [],
    archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: archive.sha256, byteLength: archive.byteLength, fileCount: sourceFiles.length } };
  const buildSourceManifest = { ...sourceBody, manifestDigest: hash(canonicalJson(sourceBody)) };
  const buildSource = { manifest: buildSourceManifest, reference: { artifactId: "api-source-archive", sha256: archive.sha256,
    byteLength: archive.byteLength, manifestDigest: buildSourceManifest.manifestDigest } };
  const output = { artifactId: "api-build", sha256: "5".repeat(64), appId: application.applicationId, platform: "api" as const };
  const buildBody = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: candidate.digest, applicationId: application.applicationId,
    repository: { repositoryId: "fixture/api", commitSha: snapshot.commitSha, treeSha }, recipeDigest: application.recipe!.recipeDigest,
    lockfileRefs: e2eApplicationLockfileRefs(applicationApprovalBinding.applications.find((item) => item.applicationId === application.applicationId)!.sourceRefs), toolchainManifestDigest: "6".repeat(64), outputs: [output], createdAt: now };
  const build = { ...buildBody, manifestDigest: e2eAppBuildManifestDigest(buildBody) };
  const applicationBindings = new Map([[application.applicationId, { approval: applicationApprovalBinding, build,
    artifacts: [{ ...output, buildManifestDigest: build.manifestDigest }], buildSource }]]);
  const preparedEnvironmentDigest = "7".repeat(64); const runtimeBindings = new Map([[runtimeProfileId, runtime]]);
  const cliHostsByProfile = new Map([[runtimeProfileId, { entryPointId: "api-cli", entryPointManifestDigest: options.hostManifestDigest ?? "9".repeat(64) }]]);
  const launchTargets = [{ targetId: target.targetId, profileId: runtimeProfileId, factoryId: "api-host", factoryManifestDigest: runtime.manifestDigest,
    engine: null, artifactCapabilities: [] as Array<"screenshot" | "video">, stateCapability: false, app: null }];
  const bundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1" as const, scenarios: [scenario], bundleDigest: "0".repeat(64) };
  const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
  const context = { selectionInput, executionPlan, bundle, applicationBindings, runtimeBindings, launchTargets, modelRoute: options.modelRoute ?? null, cliHostsByProfile,
    preparedEnvironmentsByGroup: new Map([[group.groupId, { preparedEnvironmentDigest, originByApplicationId: [{ applicationId: application.applicationId, origin: "https://service.test" }] }]]) };
  const compiled = compileE2EApplicationScenarios({ context, groupId: group.groupId });
  const roundId = "a0000000-0000-4000-8000-000000000010";
  const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000011", roundId, taskId: "task-api",
    operationId: "b0000000-0000-4000-8000-000000000001", operationFence: 1, workflowRevision: 1, groupId: group.groupId,
    executionPlanDigest: executionPlan.digest, executionMode: group.mode, mockManifestDigest: group.mockManifestDigest,
    authorizationRevision: "api-auth-r1", candidateDigest: candidate.digest, planDigest, policyDigest: e2ePolicyDigest(policy), bundleDigest: bundle.bundleDigest,
    appBuildDigest: hash(canonicalJson(compiled.inventory)), environmentDigest: preparedEnvironmentDigest, runtimeManifestDigest: runtime.manifestDigest,
    modelRouteRevision: options.modelRoute?.routeRevision ?? null, expectedCases: compiled.expectedCases, admittedAt: now, deadlineAt: new Date(Date.parse(now) + 60_000).toISOString() });
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
    candidateCommitSha: snapshot.commitSha, candidateTreeSha: snapshot.treeSha,
    sourceSnapshot: sourceSnapshotWire, intent, intentDigest: hash(canonicalJson(intent)),
    selectionInput: { ...selectionInput, sourceSnapshot: sourceSnapshotWire }, applicationApprovalBinding,
    applicationBindings: [...applicationBindings].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)),
    runtimeBindings: [...runtimeBindings].map(([key, value]) => ({ key, value })).sort((a, b) => a.key.localeCompare(b.key)), launchTargets,
    modelRoute: options.modelRoute ?? null, cliHosts: [...cliHostsByProfile].map(([profileId, descriptor]) => ({ profileId, descriptor })).sort((a, b) => a.profileId.localeCompare(b.profileId)),
    preparedEnvironments: [{ groupId: group.groupId, preparedEnvironmentDigest, originByApplicationId: compiled.originByApplicationId }],
    policy, bundle, executionPlan, portableProjection: null, round, groups: [groupAdmission] };
  const admission = E2EApplicationExecutionAdmissionSchema.parse(JSON.parse(encodeE2EApplicationExecutionAdmission({ ...admissionBody,
    admissionDigest: hash(canonicalJson(admissionBody)) } as never)));
  return { compiled, binding, round, snapshot, now, admission };
}

/** Two independently compiled API target shards for heterogeneous usage conformance. */
export function createCompiledTwoShardApiApplicationFixture(options: { now?: string; modelRoute?: { routeId: string; routeRevision: string } } = {}) {
  const packageValues = ["service-one", "service-two"].map((name) => ({
    path: `apps/${name}/package.json`, bytes: Buffer.from(JSON.stringify({ name, scripts: { start: "node server.js" }, dependencies: { express: "1.0.0" } })) }));
  const treeEntries = packageValues.map((item) => ({ path: item.path, mode: "100644", objectId: gitBlob(item.bytes) }));
  const treeSha = gitTreeSha(treeEntries);
  const candidate = createCandidateManifest([{ repositoryId: "fixture/api", commitSha: "a".repeat(40), treeSha }]);
  const nowMs = options.now ? Date.parse(options.now) : Date.now() - 10_000;
  if (!Number.isFinite(nowMs)) throw new Error("two-shard API fixture admission time must be finite");
  const now = new Date(nowMs).toISOString();
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
    treePaths: packageValues.map((item) => item.path).sort(), sources: packageValues.map((item) => ({ ...item, sha256: hash(item.bytes), kind: "blob" as const })) };
  const discovery = inspectE2ERepository(snapshot, candidate);
  const targets = discovery.inspection.proposedTargets.filter((item) => item.kind === "api" && item.accountProfileId !== E2E_ANONYMOUS_ACCOUNT_PROFILE_ID).sort((a, b) => a.targetId.localeCompare(b.targetId));
  if (targets.length !== 2) throw new Error("two-shard API fixture did not derive two independent source targets");
  const runtimeProfileId = "api-runtime";
  const runtime = registeredApiRuntime(runtimeProfileId, nowMs, true);
  const scenarios = targets.map((target, index) => ({ scenarioId: `api-shard-${index + 1}`, requirementId: `api-shard-${index + 1}-health`,
    requestedTargetIds: [target.targetId], required: true, accountProfileId: target.accountProfileId, minimumEvidence: "runtime" as const,
    requiredRealComponentIds: [], steps: [{ kind: "agent" as const, goal: `Inspect ${target.targetId} without external effects`, maxActions: 1 },
      { kind: "request" as const, requestId: `health-${index + 1}`, path: "/health", method: "GET" as const, body: {} }],
    assertions: [{ kind: "http-status" as const, path: "/health", method: "GET" as const, equals: 200 }] }));
  const runtimeRefs = targets.map((target) => ({ targetId: target.targetId, applicationId: target.applicationId,
    recipeDigest: discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!.recipe!.recipeDigest,
    sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, target.applicationId,
      discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!.sourcePaths),
    runtimeProfileId, accountProfileId: target.accountProfileId }));
  const accountRefs = targets.map((target) => ({ applicationId: target.applicationId, profileId: target.accountProfileId,
    revision: 1, definitionDigest: (indexToDigest(target.targetId)) }));
  const accountContextRefs = targets.map((target) => {
    const row = e2eApplicationMetadataSourceRefs(snapshot, target.applicationId,
      discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!.sourcePaths)[0]!;
    return { applicationId: target.applicationId, profileId: target.accountProfileId, sourcePath: row.path, sourceSha256: row.sha256 };
  });
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: targets.map((item) => item.targetId), portableOperationRefs: [],
    mockFixtureRefs: [], accountContextRefs, scenarios, semanticExportDeltas: [], applicationRuntimeRefs: runtimeRefs, runtimeAccountRefs: accountRefs, unavailableTargetRefs: [] });
  const setupProposal = proposeE2ESetup({ inspection: discovery.inspection, snapshot, expectedCandidate: candidate });
  const setupApproval = { artifactId: "two-shard-setup-approval", digest: hash(canonicalJson(setupProposal)) };
  const planDigest = "c".repeat(64); const semanticApproval = { artifactId: "two-shard-semantic-approval", digest: "d".repeat(64) };
  const applicationApprovalBinding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent,
    artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest, setupProposal, setupApproval });
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: scenarios.map((item) => item.scenarioId),
    targets: discovery.inspection.proposedTargets, defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected",
    modelRouteRevision: options.modelRoute?.routeRevision ?? null, capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
      maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const portableApprovalBinding = { schemaVersion: "portable-approval-binding/v1" as const, planDigest, semanticApproval, operations: [], accountContexts: [], bindingDigest: "0".repeat(64) };
  portableApprovalBinding.bindingDigest = hash(canonicalJson(Object.fromEntries(Object.entries(portableApprovalBinding).filter(([key]) => key !== "bindingDigest"))));
  const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest, policy, scenarios,
    selectedTargetIds: targets.map((item) => item.targetId), intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval, applicationApprovalBinding,
    registeredRuntimes: [runtime], runtimeAccountRefs: accountRefs, now: nowMs, sandboxAvailability: null,
    runtimeAvailability: targets.map((target) => ({ targetId: target.targetId, profileId: runtimeProfileId, connection: "connected" as const,
      approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "api-auth-r1" })),
    portableApprovalBinding, approvedSemanticApproval: semanticApproval, mockableComponents: [] };
  const executionPlan = selectE2EApplicationExecutionPlan(selectionInput); const group = executionPlan.groups[0]!;
  const archive = encodeE2EApplicationBuildSourceArchive(packageValues.map((item) => ({ ...item, mode: "100644" as const })));
  const treeManifestEntries = packageValues.map((item) => ({ path: item.path, mode: "100644" as const, objectId: gitBlob(item.bytes) }));
  const sourceManifestBody = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: candidate.digest,
    repository: { repositoryId: "fixture/api", commitSha: snapshot.commitSha, treeSha }, sourceState: "candidate-index-tree" as const,
    pathPolicy: "existing-safe-e2e-source-path/v1" as const, treeEntries: treeManifestEntries,
    files: packageValues.map((item) => ({ path: item.path, mode: "100644" as const, gitBlobId: gitBlob(item.bytes), sha256: hash(item.bytes), byteLength: item.bytes.byteLength })),
    omissions: [], archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: archive.sha256, byteLength: archive.byteLength, fileCount: packageValues.length } };
  const buildSourceManifest = { ...sourceManifestBody, manifestDigest: hash(canonicalJson(sourceManifestBody)) };
  const buildSource = { manifest: buildSourceManifest, reference: { artifactId: "two-shard-source-archive", sha256: archive.sha256,
    byteLength: archive.byteLength, manifestDigest: buildSourceManifest.manifestDigest } };
  const applicationBindings = new Map(targets.map((target, index) => {
    const application = discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
    const output = { artifactId: `two-shard-build-${index + 1}`, sha256: (String(index + 5)).repeat(64).slice(0, 64), appId: target.applicationId, platform: "api" as const };
    const buildBody = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: candidate.digest, applicationId: target.applicationId,
      repository: { repositoryId: "fixture/api", commitSha: snapshot.commitSha, treeSha }, recipeDigest: application.recipe!.recipeDigest,
      lockfileRefs: [], toolchainManifestDigest: "6".repeat(64), outputs: [output], createdAt: now };
    const build = { ...buildBody, manifestDigest: e2eAppBuildManifestDigest(buildBody) };
    return [target.applicationId, { approval: applicationApprovalBinding, build,
      artifacts: [{ ...output, buildManifestDigest: build.manifestDigest }], buildSource }] as const;
  }));
  const preparedEnvironmentDigest = "7".repeat(64); const runtimeBindings = new Map([[runtimeProfileId, runtime]]);
  const cliHostsByProfile = new Map([[runtimeProfileId, { entryPointId: "api-cli", entryPointManifestDigest: "9".repeat(64) }]]);
  const launchTargets = targets.map((target) => ({ targetId: target.targetId, profileId: runtimeProfileId, factoryId: "api-host",
    factoryManifestDigest: runtime.manifestDigest, engine: null, artifactCapabilities: [] as Array<"screenshot" | "video">, stateCapability: false, app: null }));
  const bundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1" as const, scenarios, bundleDigest: "0".repeat(64) };
  const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
  const context = { selectionInput, executionPlan, bundle, applicationBindings, runtimeBindings, launchTargets, modelRoute: options.modelRoute ?? null, cliHostsByProfile,
    preparedEnvironmentsByGroup: new Map([[group.groupId, { preparedEnvironmentDigest,
      originByApplicationId: targets.map((target, index) => ({ applicationId: target.applicationId, origin: `https://service-${index + 1}.test` })) }]]) };
  const compiled = compileE2EApplicationScenarios({ context, groupId: group.groupId });
  if (compiled.shards.length !== 2) throw new Error("two-shard fixture did not compile into exactly two target shards");
  const roundId = "a0000000-0000-4000-8000-000000000030";
  const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000031", roundId, taskId: "task-two-shard",
    operationId: "b0000000-0000-4000-8000-000000000003", operationFence: 1, workflowRevision: 1, groupId: group.groupId,
    executionPlanDigest: executionPlan.digest, executionMode: group.mode, mockManifestDigest: group.mockManifestDigest, authorizationRevision: "api-auth-r1",
    candidateDigest: candidate.digest, planDigest, policyDigest: e2ePolicyDigest(policy), bundleDigest: bundle.bundleDigest,
    appBuildDigest: hash(canonicalJson(compiled.inventory)), environmentDigest: preparedEnvironmentDigest, runtimeManifestDigest: runtime.manifestDigest,
    modelRouteRevision: options.modelRoute?.routeRevision ?? null, expectedCases: compiled.expectedCases, admittedAt: now,
    deadlineAt: new Date(Date.parse(now) + 60_000).toISOString() });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId: binding.taskId, operationId: binding.operationId,
    operationFence: binding.operationFence, workflowRevision: binding.workflowRevision, executionPlanDigest: executionPlan.digest,
    admittedAt: now, deadlineAt: binding.deadlineAt, limits: policy.limits, groupBindings: [binding] });
  return { compiled, binding, round, snapshot, now };
}

function indexToDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

/** Source-derived, portable-only admission used to exercise genuine child and outer IDs offline. */
export function createPortableApplicationChildFixture() {
  const packageBytes = Buffer.from(JSON.stringify({ name: "service", scripts: { start: "node server.js" }, dependencies: { express: "1.0.0" }, exports: { "./rows": "./src/rows.js" } }));
  const operationBytes = Buffer.from("export const listRows = async (input) => ({ rows: [input.query] });\n");
  const androidManifestBytes = Buffer.from('<manifest package="com.example.mobile"><application/></manifest>\n');
  const gradleBytes = Buffer.from('plugins { id "com.android.application" }\n');
  const files = [{ path: "apps/service/package.json", bytes: packageBytes }, { path: "apps/service/src/rows.js", bytes: operationBytes },
    { path: "apps/mobile/android/app/src/main/AndroidManifest.xml", bytes: androidManifestBytes },
    { path: "apps/mobile/android/app/build.gradle", bytes: gradleBytes }];
  const treeEntries = files.map((item) => ({ path: item.path, mode: "100644", objectId: gitBlob(item.bytes) }));
  const treeSha = gitTreeSha(treeEntries);
  const candidate = createCandidateManifest([{ repositoryId: "fixture/api", commitSha: "a".repeat(40), treeSha }]);
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha, treeComplete: true,
    treePaths: files.map((item) => item.path).sort(), sources: files.map((item) => ({ ...item, sha256: hash(item.bytes), kind: "blob" as const })) };
  const discovery = inspectE2ERepository(snapshot, candidate);
  const target = discovery.inspection.proposedTargets.find((item) => item.kind === "api" && item.accountProfileId !== E2E_ANONYMOUS_ACCOUNT_PROFILE_ID)!;
  const nativeTarget = discovery.inspection.proposedTargets.find((item) => item.kind === "mobile")!;
  const application = discovery.inspection.applications.find((item) => item.applicationId === target.applicationId)!;
  const nativeApplication = discovery.inspection.applications.find((item) => item.applicationId === nativeTarget.applicationId)!;
  const operation = discovery.portableOperations.find((item) => item.exportName === "./rows")!;
  const scenario = { scenarioId: "portable-rows", requirementId: "rows-work", requestedTargetIds: [target.targetId], required: true,
    accountProfileId: target.accountProfileId, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [],
    steps: [{ kind: "invoke-contract" as const, operationId: operation.operationId, input: { query: "row-1" } }],
    assertions: [{ kind: "json" as const, responseId: "result", schemaRef: "json-value-v1", equals: { rows: ["row-1"] } }] };
  const nativeScenario = { scenarioId: "native-home-unavailable", requirementId: "native-home", requestedTargetIds: [nativeTarget.targetId], required: true,
    accountProfileId: nativeTarget.accountProfileId, minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
    steps: [{ kind: "launch-app" as const }], assertions: [{ kind: "visible" as const, testId: "home", equals: true }] };
  const sourceIdentity = e2eApplicationMetadataSourceRefs(snapshot, application.applicationId, application.sourcePaths)[0]!;
  const operationRef = { operationId: operation.operationId, applicationId: operation.applicationId, requestedTargetIds: [target.targetId],
    packageExportSubpath: operation.exportName, moduleSpecifier: "./src/rows.js", callableSelector: { kind: "named" as const, exportName: "listRows" } };
  const portableIntent = { schemaVersion: 1 as const, requestedTargetIds: [target.targetId], portableOperationRefs: [operationRef], mockFixtureRefs: [],
    accountContextRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId,
      sourcePath: sourceIdentity.path, sourceSha256: sourceIdentity.sha256 }], scenarios: [scenario], semanticExportDeltas: [] };
  const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [target.targetId, nativeTarget.targetId].sort(), portableOperationRefs: [operationRef],
    mockFixtureRefs: [], accountContextRefs: [...portableIntent.accountContextRefs, { applicationId: nativeApplication.applicationId, profileId: nativeTarget.accountProfileId,
      sourcePath: e2eApplicationMetadataSourceRefs(snapshot, nativeApplication.applicationId, nativeApplication.sourcePaths)[0]!.path,
      sourceSha256: e2eApplicationMetadataSourceRefs(snapshot, nativeApplication.applicationId, nativeApplication.sourcePaths)[0]!.sha256 }],
    scenarios: [scenario, nativeScenario], semanticExportDeltas: [], applicationRuntimeRefs: [], runtimeAccountRefs: [], unavailableTargetRefs: [
      { targetId: nativeTarget.targetId, applicationId: nativeApplication.applicationId, accountProfileId: nativeTarget.accountProfileId,
        sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, nativeApplication.applicationId, nativeApplication.sourcePaths) }] });
  const now = new Date(Date.now() - 5_000).toISOString(); const planDigest = "c".repeat(64);
  const semanticApproval = { artifactId: "portable-semantic-approval", digest: "d".repeat(64) };
  const portableApprovalBinding = deriveE2EFeaturePortableApprovalBinding({ intent: portableIntent, snapshot,
    artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest });
  const setupProposal = proposeE2ESetup({ inspection: discovery.inspection, snapshot, expectedCandidate: candidate });
  const setupApproval = { artifactId: "portable-setup-approval", digest: hash(canonicalJson(setupProposal)) };
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [scenario.scenarioId, nativeScenario.scenarioId],
    targets: discovery.inspection.proposedTargets, defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: "portable-route-r1",
    capture: { screenshots: false, traces: false, video: false, downloads: false },
    limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
      maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest, policy, scenarios: intent.scenarios,
    selectedTargetIds: intent.requestedTargetIds, intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval,
    applicationApprovalBinding: null, registeredRuntimes: [], runtimeAccountRefs: [], now: Date.parse(now),
    sandboxAvailability: { targetId: "default-sandbox" as const, profileId: "sandbox", connection: "connected" as const,
      approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "portable-auth-r1" }, runtimeAvailability: [],
    portableApprovalBinding, approvedSemanticApproval: semanticApproval };
  const executionPlan = selectE2EApplicationExecutionPlan(selectionInput);
  const projection = projectE2EApplicationPortableSelection(selectionInput)!;
  const outerGroup = executionPlan.groups[0]!; const roundId = "a0000000-0000-4000-8000-000000000110";
  const outerBinding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000111", roundId, taskId: "task-portable",
    operationId: "b0000000-0000-4000-8000-000000000101", operationFence: 1, workflowRevision: 1, groupId: outerGroup.groupId,
    executionPlanDigest: executionPlan.digest, executionMode: outerGroup.mode, mockManifestDigest: outerGroup.mockManifestDigest,
    authorizationRevision: "portable-auth-r1", candidateDigest: candidate.digest, planDigest, policyDigest: e2ePolicyDigest(policy),
    bundleDigest: e2eScenarioBundleDigest({ schemaVersion: 1, planDigest, templateVersion: "trusted-e2e-application/v1", scenarios: intent.scenarios, bundleDigest: "0".repeat(64) }),
    appBuildDigest: hash("portable fixture has no application build"), environmentDigest: hash("portable environment"), runtimeManifestDigest: hash("portable runtime"),
    modelRouteRevision: policy.modelRouteRevision, expectedCases: outerGroup.expectedCases, admittedAt: now, deadlineAt: new Date(Date.parse(now) + 60_000).toISOString() });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId: outerBinding.taskId, operationId: outerBinding.operationId,
    operationFence: 1, workflowRevision: 1, executionPlanDigest: executionPlan.digest, admittedAt: now, deadlineAt: outerBinding.deadlineAt,
    limits: policy.limits, groupBindings: [outerBinding] });
  const childRunId = "a0000000-0000-4000-8000-000000000199"; const childRoundId = "a0000000-0000-4000-8000-000000000120";
  const mapping = createE2EApplicationPortableChildBindings({ projection, outerRound: round, outerPlan: executionPlan, childRoundId,
    childRunIdsByGroup: new Map([[outerGroup.groupId, childRunId]]) });
  const sourceSnapshotWire = { candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true as const,
    treePaths: snapshot.treePaths, sources: snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256, bytesBase64: Buffer.from(item.bytes).toString("base64"), kind: "blob" as const })) };
  const portableProjection = { ...projection, selectionInput: { ...projection.selectionInput, sourceSnapshot: sourceSnapshotWire } };
  const fullBundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1" as const, scenarios: intent.scenarios, bundleDigest: "0".repeat(64) };
  const bundle = { ...fullBundleBody, bundleDigest: e2eScenarioBundleDigest(fullBundleBody) };
  const admissionBody = { schemaVersion: "workflow-e2e-application-admission/v1" as const, taskId: outerBinding.taskId, operationId: outerBinding.operationId,
    operationFence: outerBinding.operationFence, workflowRevision: outerBinding.workflowRevision, candidateDigest: candidate.digest,
    candidateCommitSha: snapshot.commitSha, candidateTreeSha: snapshot.treeSha,
    sourceSnapshot: sourceSnapshotWire, intent, intentDigest: selectionInput.intentDigest, selectionInput: { ...selectionInput, sourceSnapshot: sourceSnapshotWire },
    applicationApprovalBinding: null, applicationBindings: [], runtimeBindings: [], launchTargets: [],
    modelRoute: { routeId: "fixture-route", routeRevision: policy.modelRouteRevision! }, cliHosts: [], preparedEnvironments: [],
    policy, bundle, executionPlan, portableProjection, round, groups: mapping.mappings };
  const admission = E2EApplicationExecutionAdmissionSchema.parse(JSON.parse(encodeE2EApplicationExecutionAdmission({ ...admissionBody,
    admissionDigest: hash(canonicalJson(admissionBody)) } as never)));
  return { admission, snapshot, projection, executionPlan, mapping, outerBinding, childBinding: mapping.mappings[0]!.childBinding,
    childRound: mapping.childRound, nativeTargetId: nativeTarget.targetId };
}
