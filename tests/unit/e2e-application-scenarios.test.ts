import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalJson, createCandidateManifest,
  e2eApplicationMetadataSourceRefs, e2ePolicyDigest,
  e2eAppBuildManifestDigest, e2eRuntimeCapabilityDigest, e2eScenarioBundleDigest,
  E2EApplicationLaunchTargetSchema, E2EApplicationPlanIntentSchema, E2ERoundSchema, E2ERunBindingSchema, E2ERegisteredRuntimeSchema,
  E2ERuntimeCapabilityDescriptorSchema, projectE2EApplicationPortableSelection, proposeE2ESetup,
  selectE2EApplicationExecutionPlan, type E2EPolicy, type E2EScenario, type E2ESourceSnapshot } from "../../packages/contracts/src/index.js";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";
import { deriveE2EApplicationApprovalBinding } from "../../packages/broker/src/e2e/application-plan-binding.js";
import { deriveE2EFeaturePortableApprovalBinding } from "../../packages/broker/src/e2e/feature-plan-intent.js";
import { compileE2EScenarios } from "../../packages/verifier/src/scenarios.js";
import { encodeE2EApplicationBuildSourceArchive } from "../../packages/verifier/src/application-build-source.js";
import { compileE2EApplicationScenarios, createE2EApplicationPortableChildBindings, decodeE2EApplicationExecutionAdmission,
  encodeE2EApplicationExecutionAdmission, validateE2EApplicationExecutionAdmission, validateE2EApplicationLaunchTarget } from "../../packages/verifier/src/application-scenarios.js";

function gitTreeSha(entries: readonly { path: string; mode: string; objectId: string }[]): string {
  type Node = { files: Array<{ name: string; mode: string; objectId: string }>; dirs: Map<string, Node> };
  const root: Node = { files: [], dirs: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
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
      ...[...node.dirs].map(([name, child]) => ({ name, directory: true, bytes: Buffer.concat([Buffer.from(`40000 ${name}\0`), Buffer.from(createHash("sha1").update(write(child)).digest("hex"), "hex")]) })),
    ].sort((left, right) => Buffer.compare(Buffer.from(left.name + (left.directory ? "/" : "")), Buffer.from(right.name + (right.directory ? "/" : ""))));
    const body = Buffer.concat(rows.map((row) => row.bytes));
    return Buffer.concat([Buffer.from(`tree ${body.byteLength}\0`), body]);
  };
  return createHash("sha1").update(write(root)).digest("hex");
}
function qualifiedWebRuntime(profileId: string, now: number, hostOs: "linux" | "darwin" = "linux") {
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId,
    kind: "web", host: { os: hostOs, arch: hostOs === "darwin" ? "arm64" : "x64" }, engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
    runtimeManifestDigest: "a".repeat(64), supportedSteps: ["navigate"], supportedAssertions: ["visible"], evidenceScopes: ["runtime"],
    networkPolicyDigest: "b".repeat(64), browsers: ["chromium"] });
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: hostOs === "darwin" ? "darwin 15" : "linux 6.8.0",
    arch: hostOs === "darwin" ? "arm64" : "x64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: hostOs === "darwin" ? "/opt/darwin-node/bin/node" : "/opt/node/bin/node",
    version: "v22.23.2" as const, platform: hostOs, arch: hostOs === "darwin" ? "arm64" : "x64" };
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId, capabilityDigest,
    runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "c".repeat(64), fixtureRefs: [{ path: "fixtures/smoke.json", sha256: "d".repeat(64) }],
    positiveProbeIds: ["browser-opens"], negativeProbeIds: ["browser-blocked-network"] };
  const probeManifest = { ...probeBody, manifestDigest: hash(probeBody) };
  return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "runtime-catalog",
    catalogRevision: 3, profileId, generation: 4, binding, bindingDigest: hash(binding), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "11111111-1111-4111-8111-111111111111", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: hash(runnerEnvironment), runnerToolchain, runnerToolchainDigest: hash(runnerToolchain),
    capabilities, capabilityDigest, probeManifest, qualificationEvidenceRef: { key: "runtime-evidence/qual-4.json", sha256: "e".repeat(64), byteLength: 128 },
    state: "READY", qualifiedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
}
function qualifiedApiRuntime(profileId: string, now: number) {
  const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
  const capabilities = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId,
    kind: "api", host: { os: "linux", arch: "x64" }, engine: { name: "api-supervisor", version: "1.0.0", spiVersion: 1 },
    runtimeManifestDigest: "f".repeat(64), supportedSteps: ["request"], supportedAssertions: ["http-status"], evidenceScopes: ["runtime"],
    networkPolicyDigest: "1".repeat(64), protocols: ["http"] });
  const binding = { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-0123456789abcdef",
    subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" as const };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" };
  const runnerToolchain = { execPath: "/opt/node/bin/node", version: "v22.23.2" as const, platform: "linux" as const, arch: "x64" as const };
  const capabilityDigest = e2eRuntimeCapabilityDigest(capabilities);
  const probeBody = { schemaVersion: "e2e-runtime-probe-manifest/v1" as const, profileId, capabilityDigest,
    runtimeManifestDigest: capabilities.runtimeManifestDigest, suiteDigest: "2".repeat(64), fixtureRefs: [{ path: "fixtures/api.json", sha256: "3".repeat(64) }],
    positiveProbeIds: ["api-responds"], negativeProbeIds: ["api-blocked-network"] };
  const probeManifest = { ...probeBody, manifestDigest: hash(probeBody) };
  return E2ERegisteredRuntimeSchema.parse({ schemaVersion: 2, entityType: "E2E_FEATURE_VERIFIER", runtimeCatalogId: "runtime-catalog",
    catalogRevision: 3, profileId, generation: 4, binding, bindingDigest: hash(binding), endpoint: "http://10.0.0.8:8080",
    transportCorrelationId: "22222222-2222-4222-8222-222222222222", manifestDigest: capabilities.runtimeManifestDigest,
    runnerEnvironment, runnerEnvironmentDigest: hash(runnerEnvironment), runnerToolchain, runnerToolchainDigest: hash(runnerToolchain),
    capabilities, capabilityDigest, probeManifest, qualificationEvidenceRef: { key: "runtime-evidence/api-qual.json", sha256: "4".repeat(64), byteLength: 128 },
    state: "READY", qualifiedAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString() });
}
function omitUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitUndefined);
  if (value && typeof value === "object" && !ArrayBuffer.isView(value)) {
    return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, omitUndefined(entry)]));
  }
  return value;
}

describe("application scenario compilation", () => {
  it("accepts only canonical concrete HTTP origins for supervisor-owned web apps", () => {
    const base = { targetId: "web-a", profileId: "web-profile", factoryId: "installed-web", factoryManifestDigest: "a".repeat(64),
      engine: { name: "playwright", version: "1.0.0", spiVersion: 1 as const, platform: "web", capabilities: ["actions", "observation"] },
      artifactCapabilities: [] as Array<"screenshot" | "video">, stateCapability: false,
      app: { identity: "app-a", environment: "test" as const, url: "https://shop.test" } };
    expect(() => E2EApplicationLaunchTargetSchema.parse(base)).not.toThrow();
    expect(() => E2EApplicationLaunchTargetSchema.parse({ ...base, app: { ...base.app, url: "https://shop.test:8443" } })).not.toThrow();
    for (const url of ["https://shop.test/", "https://shop.test/path", "https://shop.test?x=1", "https://shop.test#x",
      "https://user:pass@shop.test", "https://shop.test:0", "ftp://shop.test", "https://*.shop.test"]) {
      expect(() => E2EApplicationLaunchTargetSchema.parse({ ...base, app: { ...base.app, url } }), url).toThrow();
    }
  });
  it("maps a real portable child compiler round and rejects case, mode, and run-ID substitutions", () => {
    const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
    const packageBytes = Buffer.from(JSON.stringify({ name: "shop", scripts: { start: "node app.js" }, exports: { "./rows": "./src/rows.js" } }));
    const blogPackageBytes = Buffer.from(JSON.stringify({ name: "blog", scripts: { start: "node server.js" } }));
    const docsPackageBytes = Buffer.from(JSON.stringify({ name: "docs", scripts: { start: "node server.js" } }));
    const apiPackageBytes = Buffer.from(JSON.stringify({ name: "service", scripts: { start: "node server.js" }, dependencies: { express: "1.0.0" } }));
    const operationBytes = Buffer.from("export const listRows = async(input) => input;\n");
    const manifestBytes = Buffer.from('<manifest package="com.example.mobile"><application/></manifest>\n');
    const gradleBytes = Buffer.from('plugins { id "com.android.application" }\n');
    const iosBytes = Buffer.from('<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>com.example.mobile.ios</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array></dict></plist>\n');
    const gitBlob = (bytes: Uint8Array) => createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), Buffer.from(bytes)])).digest("hex");
    const sourceFiles = [
      { path: "apps/shop/package.json", bytes: packageBytes, sha256: hash(packageBytes), kind: "blob" as const },
      { path: "apps/blog/package.json", bytes: blogPackageBytes, sha256: hash(blogPackageBytes), kind: "blob" as const },
      { path: "apps/docs/package.json", bytes: docsPackageBytes, sha256: hash(docsPackageBytes), kind: "blob" as const },
      { path: "apps/service/package.json", bytes: apiPackageBytes, sha256: hash(apiPackageBytes), kind: "blob" as const },
      { path: "apps/shop/src/rows.js", bytes: operationBytes, sha256: hash(operationBytes), kind: "blob" as const },
      { path: "apps/mobile/android/app/src/main/AndroidManifest.xml", bytes: manifestBytes, sha256: hash(manifestBytes), kind: "blob" as const },
      { path: "apps/mobile/android/app/build.gradle", bytes: gradleBytes, sha256: hash(gradleBytes), kind: "blob" as const },
      { path: "apps/mobile/ios/Runner/Info.plist", bytes: iosBytes, sha256: hash(iosBytes), kind: "blob" as const },
    ];
    const treeEntries = sourceFiles.map((item) => ({ path: item.path, mode: "100644", objectId: gitBlob(item.bytes) }));
    const treeSha = gitTreeSha(treeEntries);
    const candidate = createCandidateManifest([{ repositoryId: "acme/shop", commitSha: "a".repeat(40), treeSha }]);
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha,
      treeSha, treeComplete: true, treePaths: sourceFiles.map((item) => item.path), sources: sourceFiles };
    const discovered = inspectE2ERepository(snapshot, candidate);
    const webTargets = discovered.inspection.proposedTargets.filter((item) => item.kind === "web").sort((a, b) => a.applicationId.localeCompare(b.applicationId));
    const target = webTargets.find((item) => item.applicationId === "shop")!;
    const blogTarget = webTargets.find((item) => item.applicationId === "blog")!;
    const docsTarget = webTargets.find((item) => item.applicationId === "docs")!;
    expect(webTargets).toHaveLength(3);
    const apiTarget = discovered.inspection.proposedTargets.find((item) => item.kind === "api")!;
    const nativeTarget = discovered.inspection.proposedTargets.find((item) => item.kind === "mobile")!;
    const nativeIOSTarget = discovered.inspection.proposedTargets.find((item) => item.kind === "mobile" && item.os === "ios")!;
    const nativeIOSApplication = discovered.inspection.applications.find((item) => item.applicationId === nativeIOSTarget.applicationId)!;
    expect(nativeIOSApplication.recipe).toBeNull();
    expect(nativeIOSTarget.runtimeProfileId).toBe("ios-phase-unavailable");
    const operation = discovered.portableOperations.find((item) => item.exportName === "./rows")!;
    const scenario: E2EScenario = { scenarioId: "portable-rows", requirementId: "rows-work", requestedTargetIds: [target.targetId], required: true,
      accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [],
      steps: [{ kind: "invoke-contract", operationId: operation.operationId, input: { query: "ok" } }],
      assertions: [{ kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: { rows: [1] } }] };
    const realScenario: E2EScenario = { scenarioId: "web-home", requirementId: "web-home-visible", requestedTargetIds: [target.targetId], required: true,
      accountProfileId: target.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "home", equals: true }] };
    const blogScenario: E2EScenario = { scenarioId: "blog-home", requirementId: "blog-home-visible", requestedTargetIds: [blogTarget.targetId], required: true,
      accountProfileId: blogTarget.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "blog-home", equals: true }] };
    const docsScenario: E2EScenario = { scenarioId: "docs-home", requirementId: "docs-home-visible", requestedTargetIds: [docsTarget.targetId], required: true,
      accountProfileId: docsTarget.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "navigate", path: "/" }], assertions: [{ kind: "visible", testId: "docs-home", equals: true }] };
    const apiScenario: E2EScenario = { scenarioId: "service-health", requirementId: "service-health-ok", requestedTargetIds: [apiTarget.targetId], required: true,
      accountProfileId: apiTarget.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "request", requestId: "health", path: "/health", method: "GET", body: {} }],
      assertions: [{ kind: "http-status", path: "/health", method: "GET", equals: 200 }] };
    const nativeScenario: E2EScenario = { scenarioId: "native-home", requirementId: "native-home-visible", requestedTargetIds: [nativeTarget.targetId], required: true,
      accountProfileId: nativeTarget.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "launch-app" }], assertions: [{ kind: "visible", testId: "home", equals: true }] };
    const nativeIOSScenario: E2EScenario = { scenarioId: "native-ios-home", requirementId: "native-ios-home-visible", requestedTargetIds: [nativeIOSTarget.targetId], required: true,
      accountProfileId: nativeIOSTarget.accountProfileId, minimumEvidence: "runtime", requiredRealComponentIds: [],
      steps: [{ kind: "launch-app" }], assertions: [{ kind: "visible", testId: "home", equals: true }] };
    const application = discovered.inspection.applications.find((item) => item.applicationId === operation.applicationId)!;
    const sourceIdentity = e2eApplicationMetadataSourceRefs(snapshot, operation.applicationId, application.sourcePaths)[0]!;
    const nativeApplication = discovered.inspection.applications.find((item) => item.applicationId === nativeTarget.applicationId)!;
    const nativeSourceIdentity = e2eApplicationMetadataSourceRefs(snapshot, nativeTarget.applicationId, nativeApplication.sourcePaths)[0]!;
    const accountContextRef = { applicationId: operation.applicationId, profileId: target.accountProfileId,
      sourcePath: sourceIdentity.path, sourceSha256: sourceIdentity.sha256 };
    const webAccountContextRefs = webTargets.map((item) => {
      const app = discovered.inspection.applications.find((candidate) => candidate.applicationId === item.applicationId)!;
      const ref = e2eApplicationMetadataSourceRefs(snapshot, item.applicationId, app.sourcePaths)[0]!;
      return { applicationId: item.applicationId, profileId: item.accountProfileId, sourcePath: ref.path, sourceSha256: ref.sha256 };
    });
    const apiApplication = discovered.inspection.applications.find((item) => item.applicationId === apiTarget.applicationId)!;
    const apiSourceIdentity = e2eApplicationMetadataSourceRefs(snapshot, apiTarget.applicationId, apiApplication.sourcePaths)[0]!;
    const apiAccountContextRef = { applicationId: apiTarget.applicationId, profileId: apiTarget.accountProfileId,
      sourcePath: apiSourceIdentity.path, sourceSha256: apiSourceIdentity.sha256 };
    const nativeAccountContextRef = { applicationId: nativeTarget.applicationId, profileId: nativeTarget.accountProfileId,
      sourcePath: nativeSourceIdentity.path, sourceSha256: nativeSourceIdentity.sha256 };
    const nativeIOSSourceIdentity = e2eApplicationMetadataSourceRefs(snapshot, nativeIOSTarget.applicationId, nativeIOSApplication.sourcePaths)[0]!;
    const nativeIOSAccountContextRef = { applicationId: nativeIOSTarget.applicationId, profileId: nativeIOSTarget.accountProfileId,
      sourcePath: nativeIOSSourceIdentity.path, sourceSha256: nativeIOSSourceIdentity.sha256 };
    const operationRef = { operationId: operation.operationId, applicationId: operation.applicationId, requestedTargetIds: [target.targetId],
      packageExportSubpath: operation.exportName, moduleSpecifier: "./src/rows.js",
      callableSelector: { kind: "named" as const, exportName: "listRows" } };
    const semanticApproval = { artifactId: "semantic-approval", digest: hash("approved semantic approval") };
    const planDigest = "c".repeat(64);
    const setupProposal = proposeE2ESetup({ inspection: discovered.inspection, snapshot, expectedCandidate: candidate });
    const setupApproval = { artifactId: "setup-approval", digest: hash(canonicalJson(setupProposal)) };
    const runtimeProfileId = "web-runtime";
    const runtime = qualifiedWebRuntime(runtimeProfileId, Date.parse("2026-10-17T12:00:00.000Z"));
    const darwinRuntimeProfileId = "darwin-web-runtime";
    const darwinRuntime = qualifiedWebRuntime(darwinRuntimeProfileId, Date.parse("2026-10-17T12:00:00.000Z"), "darwin");
    const apiRuntimeProfileId = "api-runtime";
    const apiRuntime = qualifiedApiRuntime(apiRuntimeProfileId, Date.parse("2026-10-17T12:00:00.000Z"));
    const webRuntimeRefs = webTargets.map((item) => {
      const app = discovered.inspection.applications.find((candidate) => candidate.applicationId === item.applicationId)!;
      const profileId = item.applicationId === "docs" ? darwinRuntimeProfileId : runtimeProfileId;
      return { targetId: item.targetId, applicationId: item.applicationId, recipeDigest: app.recipe!.recipeDigest,
        sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, item.applicationId, app.sourcePaths), runtimeProfileId: profileId, accountProfileId: item.accountProfileId };
    });
    const runtimeAccountRefs = webTargets.map((item) => ({ applicationId: item.applicationId, profileId: item.accountProfileId, revision: 1, definitionDigest: hash(`runtime account ${item.applicationId}`) }));
    const apiRuntimeRef = { targetId: apiTarget.targetId, applicationId: apiTarget.applicationId, recipeDigest: apiApplication.recipe!.recipeDigest,
      sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, apiTarget.applicationId, apiApplication.sourcePaths), runtimeProfileId: apiRuntimeProfileId, accountProfileId: apiTarget.accountProfileId };
    const apiRuntimeAccountRef = { applicationId: apiTarget.applicationId, profileId: apiTarget.accountProfileId, revision: 1, definitionDigest: hash("runtime account service") };
    const intent = JSON.parse(canonicalJson(E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [...webTargets.map((item) => item.targetId), apiTarget.targetId, nativeTarget.targetId, nativeIOSTarget.targetId].sort(),
      portableOperationRefs: [operationRef], mockFixtureRefs: [], accountContextRefs: [...webAccountContextRefs, apiAccountContextRef, nativeAccountContextRef, nativeIOSAccountContextRef], scenarios: [scenario, realScenario, blogScenario, docsScenario, apiScenario, nativeScenario, nativeIOSScenario],
      semanticExportDeltas: [], applicationRuntimeRefs: [...webRuntimeRefs, apiRuntimeRef], runtimeAccountRefs: [...runtimeAccountRefs, apiRuntimeAccountRef], unavailableTargetRefs: [
        { targetId: nativeTarget.targetId, applicationId: nativeTarget.applicationId, accountProfileId: nativeTarget.accountProfileId,
          sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, nativeTarget.applicationId, nativeApplication.sourcePaths) },
        { targetId: nativeIOSTarget.targetId, applicationId: nativeIOSTarget.applicationId, accountProfileId: nativeIOSTarget.accountProfileId,
          sourceRefs: e2eApplicationMetadataSourceRefs(snapshot, nativeIOSTarget.applicationId, nativeIOSApplication.sourcePaths) },
      ] }))) as ReturnType<typeof E2EApplicationPlanIntentSchema.parse>;
    const realTargets = [...webTargets, apiTarget];
    const realIntent = E2EApplicationPlanIntentSchema.parse({ ...intent, requestedTargetIds: realTargets.map((item) => item.targetId).sort(), portableOperationRefs: [],
      scenarios: [realScenario, blogScenario, docsScenario, apiScenario], accountContextRefs: [...webAccountContextRefs, apiAccountContextRef], applicationRuntimeRefs: [...webRuntimeRefs, apiRuntimeRef],
      runtimeAccountRefs: [...runtimeAccountRefs, apiRuntimeAccountRef], unavailableTargetRefs: [] });
    const applicationApprovalBinding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: snapshot, intent: realIntent,
      artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest, setupProposal, setupApproval });
    const portableIntent = { schemaVersion: 1 as const, requestedTargetIds: [target.targetId], portableOperationRefs: [operationRef], mockFixtureRefs: [],
      accountContextRefs: [accountContextRef], scenarios: [scenario], semanticExportDeltas: [] };
    const portableApprovalBinding = deriveE2EFeaturePortableApprovalBinding({ intent: portableIntent,
      snapshot, artifactId: semanticApproval.artifactId, artifactSha256: semanticApproval.digest, planDigest });
    const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [nativeScenario.scenarioId, nativeIOSScenario.scenarioId],
      targets: discovered.inspection.proposedTargets, defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: "route-v1",
      capture: { screenshots: false, traces: false, video: false, downloads: false },
      limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
        maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
    const selectionInputRaw = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest, policy,
      scenarios: intent.scenarios, selectedTargetIds: intent.requestedTargetIds, intent, intentDigest: hash(canonicalJson(intent)), setupProposal, setupApproval,
      applicationApprovalBinding, registeredRuntimes: [runtime, darwinRuntime, apiRuntime], runtimeAccountRefs: [...runtimeAccountRefs, apiRuntimeAccountRef], now: Date.parse("2026-10-17T12:00:00.000Z"),
      sandboxAvailability: { targetId: "default-sandbox" as const, profileId: "default-sandbox", connection: "connected" as const,
        approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "auth-r1" },
      runtimeAvailability: [...webTargets.map((item) => ({ targetId: item.targetId, profileId: item.applicationId === "docs" ? darwinRuntimeProfileId : runtimeProfileId,
        connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: `web-auth-${item.applicationId}` })),
        { targetId: apiTarget.targetId, profileId: apiRuntimeProfileId, connection: "connected" as const, approval: "approved" as const,
          qualification: "qualified" as const, authorizationRevision: "api-auth-service" }],
      portableApprovalBinding, approvedSemanticApproval: semanticApproval,
      mockableComponents: [] };
    const selectionInput = omitUndefined(selectionInputRaw) as typeof selectionInputRaw;
    const projection = projectE2EApplicationPortableSelection(selectionInput)!;
    expect(projection.selectionInput.policy.modelRouteRevision).toBeNull();
    expect(selectionInput.policy.modelRouteRevision).toBe("route-v1");
    const fullPlan = selectE2EApplicationExecutionPlan(selectionInput);
    const effectiveApiTarget = fullPlan.effectiveTargets.find((item) => item.targetId === apiTarget.targetId)!;
    const appGroups = fullPlan.groups.filter((item) => item.mode === "real-runtime");
    const appGroup = appGroups.find((item) => item.targetIds.includes(target.targetId))!;
    const darwinGroup = appGroups.find((item) => item.targetIds.includes(docsTarget.targetId))!;
    const apiGroup = appGroups.find((item) => item.targetIds.includes(apiTarget.targetId))!;
    expect(appGroups).toHaveLength(3);
    expect(appGroup.targetIds.slice().sort()).toEqual([target.targetId, blogTarget.targetId].sort());
    expect(darwinGroup.targetIds).toEqual([docsTarget.targetId]);
    const group = fullPlan.groups.find((item) => item.groupId === projection.executionPlan.groups[0]?.groupId)!;
    const projectedGroup = projection.executionPlan.groups[0]!;
    expect(projectedGroup.expectedCases.map((item) => item.caseId)).toEqual(group.expectedCases.map((item) => item.caseId));
    const compiled = compileE2EScenarios(projection.bundle, projection.executionPlan.effectiveTargets, projectedGroup,
      { selectionInput: projection.selectionInput, executionPlan: projection.executionPlan, group: projectedGroup });
    expect(compiled.expectedCases.map((item) => item.caseId)).toEqual(projectedGroup.expectedCases.map((item) => item.caseId));
    const fullBundleBody = { schemaVersion: 1 as const, planDigest, templateVersion: "trusted-e2e-application/v1" as const,
      scenarios: intent.scenarios, bundleDigest: "0".repeat(64) };
    const fullBundle = { ...fullBundleBody, bundleDigest: e2eScenarioBundleDigest(fullBundleBody) };
    const buildArchive = encodeE2EApplicationBuildSourceArchive(sourceFiles.map((item) => ({ path: item.path, mode: "100644" as const, bytes: item.bytes })));
    const buildSourceBody = { schemaVersion: "e2e-application-build-source-manifest/v1" as const, candidateDigest: candidate.digest,
      repository: { repositoryId: "acme/shop", commitSha: snapshot.commitSha, treeSha: snapshot.treeSha }, sourceState: "candidate-index-tree" as const,
      pathPolicy: "existing-safe-e2e-source-path/v1" as const, treeEntries,
      files: sourceFiles.map((item, index) => ({ path: item.path, mode: "100644" as const, gitBlobId: treeEntries[index]!.objectId,
        sha256: item.sha256, byteLength: item.bytes.byteLength })), omissions: [],
      archive: { format: "e2e-application-build-source-archive/v1" as const, sha256: buildArchive.sha256,
        byteLength: buildArchive.byteLength, fileCount: buildArchive.fileCount } };
    const buildSourceManifest = { ...buildSourceBody, manifestDigest: hash(canonicalJson(buildSourceBody)) };
    const buildSourceReference = { artifactId: "private-source-archive", sha256: buildArchive.sha256,
      byteLength: buildArchive.byteLength, manifestDigest: buildSourceManifest.manifestDigest };
    const applicationById = new Map(discovered.inspection.applications.map((item) => [item.applicationId, item]));
    const applicationBindings = new Map(realTargets.map((item) => {
      const app = applicationById.get(item.applicationId)!;
      const output = { artifactId: `build-${item.applicationId}`, sha256: hash(`app build bytes ${item.applicationId}`), appId: item.applicationId, platform: item.kind === "api" ? "api" as const : "web" as const };
      const body = { schemaVersion: "e2e-app-build/v1" as const, candidateDigest: candidate.digest, applicationId: item.applicationId,
        repository: { repositoryId: "acme/shop", commitSha: snapshot.commitSha, treeSha: snapshot.treeSha }, recipeDigest: app.recipe!.recipeDigest,
        lockfileRefs: [], toolchainManifestDigest: hash(`toolchain ${item.applicationId}`), outputs: [output], createdAt: "2026-10-17T12:00:00.000Z" };
      const build = { ...body, manifestDigest: e2eAppBuildManifestDigest(body) };
      const artifacts = [{ ...output, buildManifestDigest: build.manifestDigest }];
      return [item.applicationId, { approval: applicationApprovalBinding, build, artifacts, buildSource: { manifest: buildSourceManifest, reference: buildSourceReference } }];
    }));
    const preparedEnvironmentsByGroup = new Map(appGroups.map((group) => {
      const groupTargets = group.targetIds.map((id) => realTargets.find((item) => item.targetId === id)!);
      const origins = groupTargets.map((item) => ({ applicationId: item.applicationId, origin: `https://${item.applicationId}.test` })).sort((a, b) => a.applicationId.localeCompare(b.applicationId));
      return [group.groupId, { preparedEnvironmentDigest: hash(`prepared group ${group.groupId}`), originByApplicationId: origins }];
    }));
    const runtimeBindings = new Map([[runtimeProfileId, runtime], [darwinRuntimeProfileId, darwinRuntime], [apiRuntimeProfileId, apiRuntime]]);
    const cliHostsByProfile = new Map([[runtimeProfileId, { entryPointId: "installed-linux-web-cli", entryPointManifestDigest: hash("installed linux web cli") }],
      [darwinRuntimeProfileId, { entryPointId: "installed-darwin-web-cli", entryPointManifestDigest: hash("installed darwin web cli") }],
      [apiRuntimeProfileId, { entryPointId: "installed-api-cli", entryPointManifestDigest: hash("installed api cli") }]]);
    const profileForTarget = (item: typeof realTargets[number]) => item.kind === "api" ? apiRuntimeProfileId
      : item.applicationId === "docs" ? darwinRuntimeProfileId : runtimeProfileId;
    const launchTargets = realTargets.map((item) => {
      const profileId = profileForTarget(item);
      const activeRuntime = runtimeBindings.get(profileId)!;
      return { targetId: item.targetId, profileId, factoryId: item.kind === "api" ? "installed-api-supervisor" : "installed-playwright",
        factoryManifestDigest: activeRuntime.manifestDigest,
        engine: item.kind === "api" ? null : { name: "playwright", version: "1.0.0", spiVersion: 1 as const, platform: "web", capabilities: ["actions", "observation"] },
        artifactCapabilities: [] as Array<"screenshot" | "video">, stateCapability: false,
        app: item.kind === "api" ? null : { identity: item.applicationId, environment: "test" as const, url: `https://${item.applicationId}.test` } };
    }).sort((a, b) => a.targetId.localeCompare(b.targetId));
    const context = { selectionInput, executionPlan: fullPlan, bundle: fullBundle,
      applicationBindings, runtimeBindings, launchTargets, modelRoute: { routeId: "route-1", routeRevision: "route-v1" },
      cliHostsByProfile, preparedEnvironmentsByGroup };
    const compiledApplications = new Map(appGroups.map((group) => [group.groupId, compileE2EApplicationScenarios({ context: context as never, groupId: group.groupId })]));
    const compiledApplication = compiledApplications.get(appGroup.groupId)!;
    const compiledDarwinApplication = compiledApplications.get(darwinGroup.groupId)!;
    const compiledApiApplication = compiledApplications.get(apiGroup.groupId)!;
    expect(compiledApplication.expectedCases.map((item) => item.caseId)).toEqual(appGroup.expectedCases.map((item) => item.caseId));
    expect(compiledApplication.shards.map((item) => item.targetId).sort()).toEqual([target.targetId, blogTarget.targetId].sort());
    expect(compiledApplication.shards.every((shard) => shard.expectedCases.every((item) => item.targetId === shard.targetId))).toBe(true);
    expect(compiledApplication.shards.flatMap((shard) => shard.expectedCases.map((item) => item.caseId)).sort()).toEqual(appGroup.expectedCases.map((item) => item.caseId).sort());
    expect(compiledDarwinApplication.cliHost).toEqual({ profileId: darwinRuntimeProfileId, descriptor: cliHostsByProfile.get(darwinRuntimeProfileId) });
    expect(launchTargets.find((item) => item.targetId === apiTarget.targetId)).toEqual(expect.objectContaining({ targetId: apiTarget.targetId, engine: null, app: null }));
    expect(compiledApiApplication.originByApplicationId).toEqual([{ applicationId: apiTarget.applicationId, origin: `https://${apiTarget.applicationId}.test` }]);
    expect(runtimeBindings.get(runtimeProfileId)?.capabilities.host.os).toBe("linux");
    expect(runtimeBindings.get(darwinRuntimeProfileId)?.capabilities.host.os).toBe("darwin");
    const apiLaunch = launchTargets.find((item) => item.targetId === apiTarget.targetId)!;
    expect(() => validateE2EApplicationLaunchTarget(effectiveApiTarget, apiLaunch as never, apiRuntime, policy.capture)).not.toThrow();
    expect(() => validateE2EApplicationLaunchTarget(effectiveApiTarget, { ...apiLaunch, engine: { name: "api-supervisor", version: "1.0.0", spiVersion: 1, platform: "web", capabilities: ["actions", "observation"] } } as never, apiRuntime, policy.capture)).toThrow(/API application target/);
    expect(() => validateE2EApplicationLaunchTarget(effectiveApiTarget, { ...apiLaunch, app: { identity: apiTarget.applicationId, environment: "test", url: "https://service.test" } } as never, apiRuntime, policy.capture)).toThrow(/API application target/);
    expect(compiledApplication.cliHost).toEqual({ profileId: runtimeProfileId, descriptor: cliHostsByProfile.get(runtimeProfileId) });
    const roundId = "a0000000-0000-4000-8000-000000000010";
    const groupBindings = fullPlan.groups.map((item, index) => {
      const compiledForGroup = compiledApplications.get(item.groupId);
      const groupProfileId = item.targetIds[0] === apiTarget.targetId ? apiRuntimeProfileId
        : item.targetIds[0] === docsTarget.targetId ? darwinRuntimeProfileId : runtimeProfileId;
      return E2ERunBindingSchema.parse({ schemaVersion: 1,
      runId: `a0000000-0000-4000-8000-00000000000${index + 1}`, roundId, taskId: "task-1", operationId: "operation-1",
      operationFence: 1, workflowRevision: 1, groupId: item.groupId, executionPlanDigest: fullPlan.digest, executionMode: item.mode,
      mockManifestDigest: item.mockManifestDigest, authorizationRevision: "web-auth-r1", candidateDigest: candidate.digest, planDigest,
      policyDigest: e2ePolicyDigest(policy), bundleDigest: fullBundle.bundleDigest,
      appBuildDigest: compiledForGroup ? hash(canonicalJson(compiledForGroup.inventory)) : hash("portable build"),
      environmentDigest: compiledForGroup ? compiledForGroup.preparedEnvironmentDigest : hash("portable environment"),
      runtimeManifestDigest: compiledForGroup ? runtimeBindings.get(groupProfileId)!.manifestDigest : hash("portable runtime"),
      modelRouteRevision: policy.modelRouteRevision, expectedCases: compiledForGroup ? compiledForGroup.expectedCases : compiled.expectedCases,
      admittedAt: "2026-10-17T12:00:00.000Z", deadlineAt: "2026-10-17T12:01:00.000Z" });
    }).sort((a, b) => a.groupId.localeCompare(b.groupId));
    const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId, taskId: "task-1", operationId: "operation-1", operationFence: 1,
      workflowRevision: 1, executionPlanDigest: fullPlan.digest, admittedAt: "2026-10-17T12:00:00.000Z", deadlineAt: "2026-10-17T12:01:00.000Z",
      limits: policy.limits, groupBindings });
    const binding = groupBindings.find((item) => item.groupId === group.groupId)!;
    const childRoundId = "a0000000-0000-4000-8000-000000000020";
    const childRunId = "a0000000-0000-4000-8000-000000000099";
    const mapping = createE2EApplicationPortableChildBindings({ projection, outerRound: round, outerPlan: fullPlan, childRoundId,
      childRunIdsByGroup: new Map([[group.groupId, childRunId]]) });
    expect(mapping.childRound).toMatchObject({ roundId: childRoundId, executionPlanDigest: projection.executionPlan.digest, taskId: binding.taskId, deadlineAt: binding.deadlineAt });
    expect(mapping.mappings).toHaveLength(1);
    const childBinding = mapping.mappings[0]!.childBinding;
    expect(childBinding).toMatchObject({ runId: childRunId, roundId: childRoundId, executionPlanDigest: projection.executionPlan.digest,
      policyDigest: e2ePolicyDigest(projection.selectionInput.policy), bundleDigest: projection.bundle.bundleDigest, modelRouteRevision: null,
      taskId: binding.taskId, operationId: binding.operationId, operationFence: binding.operationFence,
      workflowRevision: binding.workflowRevision, candidateDigest: binding.candidateDigest, planDigest: binding.planDigest,
      expectedCases: binding.expectedCases, appBuildDigest: binding.appBuildDigest, environmentDigest: binding.environmentDigest,
      runtimeManifestDigest: binding.runtimeManifestDigest, deadlineAt: binding.deadlineAt });
    expect(() => createE2EApplicationPortableChildBindings({ projection, outerRound: round, outerPlan: fullPlan, childRoundId,
      childRunIdsByGroup: new Map([[group.groupId, roundId]]) })).toThrow(/fresh unique/);
    const changedCases = E2ERoundSchema.parse({ ...round, groupBindings: round.groupBindings.map((item) => item.groupId === group.groupId ? { ...item, expectedCases: [] } : item) });
    expect(() => createE2EApplicationPortableChildBindings({ projection, outerRound: changedCases, outerPlan: fullPlan, childRoundId,
      childRunIdsByGroup: new Map([[group.groupId, childRunId]]) })).toThrow(/case, mode, or mock identity/);
    const changedMode = E2ERoundSchema.parse({ ...round, groupBindings: round.groupBindings.map((item) => item.groupId === group.groupId ? { ...item, executionMode: "hybrid" } : item) });
    expect(() => createE2EApplicationPortableChildBindings({ projection, outerRound: changedMode, outerPlan: fullPlan, childRoundId,
      childRunIdsByGroup: new Map([[group.groupId, childRunId]]) })).toThrow(/case, mode, or mock identity/);

    const sourceWire = { candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true,
      treePaths: snapshot.treePaths, sources: snapshot.sources.map((item) => ({ path: item.path, sha256: item.sha256,
        bytesBase64: Buffer.from(item.bytes).toString("base64"), kind: "blob" as const })) };
    const portableWire = { ...projection, selectionInput: { ...omitUndefined(projection.selectionInput) as Record<string, unknown>, sourceSnapshot: sourceWire } };
    const appAdmissions = appGroups.map((group) => {
      const compiledGroup = compiledApplications.get(group.groupId)!;
      const profileId = group.targetIds[0] === apiTarget.targetId ? apiRuntimeProfileId
        : group.targetIds[0] === docsTarget.targetId ? darwinRuntimeProfileId : runtimeProfileId;
      return { protocol: "trusted-e2e-application/v1" as const, outerBinding: groupBindings.find((item) => item.groupId === group.groupId)!,
        cliHost: { profileId, descriptor: cliHostsByProfile.get(profileId)! }, preparedEnvironmentDigest: compiledGroup.preparedEnvironmentDigest,
        originByApplicationId: compiledGroup.originByApplicationId, compiledInventoryDigest: compiledGroup.inventory.digest,
        shards: compiledGroup.inventory.shards.map((shard) => ({ shardId: shard.shardId, targetId: shard.targetId,
          inventoryDigest: shard.inventoryDigest, configDigest: shard.expectedConfigDigest, expectedCaseIds: [...shard.expectedCaseIds] })) };
    });
    const admissionGroups = [...mapping.mappings, ...appAdmissions].sort((left, right) => left.outerBinding.groupId.localeCompare(right.outerBinding.groupId));
    const admissionBody = { schemaVersion: "workflow-e2e-application-admission/v1" as const, taskId: binding.taskId,
      operationId: binding.operationId, operationFence: binding.operationFence, workflowRevision: binding.workflowRevision,
      candidateDigest: candidate.digest, sourceSnapshot: sourceWire, intent: selectionInput.intent, intentDigest: selectionInput.intentDigest,
      selectionInput: { ...selectionInput, sourceSnapshot: sourceWire }, applicationApprovalBinding,
      applicationBindings: [...applicationBindings].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
      runtimeBindings: [...runtimeBindings].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value })),
      launchTargets, modelRoute: { routeId: "route-1", routeRevision: "route-v1" },
      cliHosts: [...cliHostsByProfile].sort(([a], [b]) => a.localeCompare(b)).map(([profileId, descriptor]) => ({ profileId, descriptor })),
      preparedEnvironments: [...preparedEnvironmentsByGroup].sort(([a], [b]) => a.localeCompare(b)).map(([groupId, facts]) => ({ groupId, ...facts })),
      policy, bundle: fullBundle, executionPlan: fullPlan, portableProjection: portableWire, round,
      groups: admissionGroups, admissionDigest: "0".repeat(64) };
    const canonicalAdmissionBody = omitUndefined(Object.fromEntries(Object.entries(admissionBody).filter(([key]) => key !== "admissionDigest")));
    const admission = { ...omitUndefined(admissionBody) as typeof admissionBody, admissionDigest: hash(canonicalJson(canonicalAdmissionBody)) };
    const encoded = encodeE2EApplicationExecutionAdmission(admission as never);
    const decoded = decodeE2EApplicationExecutionAdmission(encoded);
    const validated = validateE2EApplicationExecutionAdmission(decoded);
    expect(validated.applicationSuites).toHaveLength(3);
    expect(validated.portableSuites).toHaveLength(1);
    expect(validated.admission.policy.modelRouteRevision).toBe("route-v1");
    expect(validated.admission.portableProjection?.selectionInput).toMatchObject({ policy: { modelRouteRevision: null } });
    expect(validated.applicationSuites.map((suite) => suite.cliHost.profileId).sort()).toEqual([runtimeProfileId, darwinRuntimeProfileId, apiRuntimeProfileId].sort());
    expect(validated.applicationSuites.find((suite) => suite.cliHost.profileId === runtimeProfileId)?.shards.map((shard) => shard.targetId).sort())
      .toEqual([target.targetId, blogTarget.targetId].sort());
    expect(validated.applicationSuites.find((suite) => suite.cliHost.profileId === darwinRuntimeProfileId)?.shards.map((shard) => shard.targetId))
      .toEqual([docsTarget.targetId]);
    const nativeCriterion = validated.executionPlan.criteria.find((item) => item.requestedTargetId === nativeTarget.targetId);
    expect(nativeCriterion).toBeDefined();
    expect(validated.executionPlan.unavailableCriteria.some((item) => item.criterionId === nativeCriterion?.criterionId)).toBe(true);
    expect(validated.executionPlan.groups.flatMap((item) => item.targetIds)).not.toContain(nativeTarget.targetId);
    const nativeIOSCriterion = validated.executionPlan.criteria.find((item) => item.requestedTargetId === nativeIOSTarget.targetId);
    expect(nativeIOSCriterion).toBeDefined();
    expect(validated.executionPlan.unavailableCriteria.some((item) => item.criterionId === nativeIOSCriterion?.criterionId)).toBe(true);
    expect(validated.executionPlan.groups.flatMap((item) => item.targetIds)).not.toContain(nativeIOSTarget.targetId);
    const substitutedAdmissionBody = { ...decoded, groups: decoded.groups.map((item) => item.protocol === "trusted-e2e/v1"
      ? { ...item, childBinding: { ...item.childBinding, operationFence: item.childBinding.operationFence + 1 } } : item), admissionDigest: "0".repeat(64) };
    const substitutedAdmission = { ...substitutedAdmissionBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(substitutedAdmissionBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(substitutedAdmission)).toThrow(/portable child bindings or round differ/);
    const changedHostBody = { ...decoded, groups: decoded.groups.map((item) => item.protocol === "trusted-e2e-application/v1"
      ? { ...item, cliHost: { ...item.cliHost, descriptor: { ...item.cliHost.descriptor, entryPointManifestDigest: hash("swapped installed host") } } } : item), admissionDigest: "0".repeat(64) };
    const changedHost = { ...changedHostBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(changedHostBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(changedHost)).toThrow(/application admission group differs/);
    const darwinHostBody = { ...decoded, groups: decoded.groups.map((item) => item.protocol === "trusted-e2e-application/v1" && item.cliHost.profileId === darwinRuntimeProfileId
      ? { ...item, cliHost: { ...item.cliHost, descriptor: cliHostsByProfile.get(runtimeProfileId)! } } : item), admissionDigest: "0".repeat(64) };
    const darwinHost = { ...darwinHostBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(darwinHostBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(darwinHost)).toThrow(/application admission group differs/);
    const changedOriginBody = { ...decoded, groups: decoded.groups.map((item) => item.protocol === "trusted-e2e-application/v1" && item.cliHost.profileId === runtimeProfileId
      ? { ...item, originByApplicationId: item.originByApplicationId.map((origin) => ({ ...origin, origin: "https://substituted.test" })) } : item), admissionDigest: "0".repeat(64) };
    const changedOrigin = { ...changedOriginBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(changedOriginBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(changedOrigin)).toThrow(/application admission group differs/);
    const changedPreparedBody = { ...decoded, groups: decoded.groups.map((item) => item.protocol === "trusted-e2e-application/v1" && item.cliHost.profileId === runtimeProfileId
      ? { ...item, preparedEnvironmentDigest: hash("substituted prepared facts") } : item), admissionDigest: "0".repeat(64) };
    const changedPrepared = { ...changedPreparedBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(changedPreparedBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(changedPrepared)).toThrow(/application admission group differs/);
    const apiAdmissionGroup = decoded.groups.find((item) => item.protocol === "trusted-e2e-application/v1" && item.cliHost.profileId === apiRuntimeProfileId)!;
    const changedApiOriginBody = { ...decoded, groups: decoded.groups.map((item) => item === apiAdmissionGroup && item.protocol === "trusted-e2e-application/v1"
      ? { ...item, originByApplicationId: item.originByApplicationId.map((origin) => ({ ...origin, origin: "https://substituted-api.test" })) } : item), admissionDigest: "0".repeat(64) };
    const changedApiOrigin = { ...changedApiOriginBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(changedApiOriginBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(changedApiOrigin)).toThrow(/application admission group differs/);
    const missingApiOriginBody = { ...decoded, groups: decoded.groups.map((item) => item === apiAdmissionGroup && item.protocol === "trusted-e2e-application/v1"
      ? { ...item, originByApplicationId: [] } : item), admissionDigest: "0".repeat(64) };
    const missingApiOrigin = { ...missingApiOriginBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(missingApiOriginBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(missingApiOrigin)).toThrow(/application admission group differs/);
    const changedApiPreparedBody = { ...decoded, groups: decoded.groups.map((item) => item === apiAdmissionGroup && item.protocol === "trusted-e2e-application/v1"
      ? { ...item, preparedEnvironmentDigest: hash("changed API prepared origin record") } : item), admissionDigest: "0".repeat(64) };
    const changedApiPrepared = { ...changedApiPreparedBody,
      admissionDigest: hash(canonicalJson(Object.fromEntries(Object.entries(changedApiPreparedBody).filter(([key]) => key !== "admissionDigest")))) };
    expect(() => validateE2EApplicationExecutionAdmission(changedApiPrepared)).toThrow(/application admission group differs/);
    const overflowAdmission = { ...decoded, groups: decoded.groups.map((item) => item.protocol === "trusted-e2e-application/v1" && item.cliHost.profileId === runtimeProfileId
      ? { ...item, shards: item.shards.map((shard) => ({ ...shard, expectedCaseIds: [...shard.expectedCaseIds, ...Array.from({ length: 65 }, (_, index) => `overflow-case-${index}`)] })) } : item) };
    expect(() => encodeE2EApplicationExecutionAdmission(overflowAdmission)).toThrow();
  });

  it("rejects accessor-bearing compilation envelopes without invoking getters", () => {
    let getterCalls = 0;
    const hostile = Object.defineProperty({}, "context", { enumerable: true, get() { getterCalls += 1; return {}; } });
    expect(() => compileE2EApplicationScenarios(hostile as never)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("requires the exact installed CLI host descriptor for each runnable profile", () => {
    expect(() => compileE2EApplicationScenarios({ context: {} as never, groupId: "missing-group" })).toThrow();
  });

  it("binds a valid web launch to its source app, installed browser, engine, and approved capture state", () => {
    const capability = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId: "web-profile",
      kind: "web", host: { os: "linux", arch: "x64" }, engine: { name: "playwright", version: "1.0.0", spiVersion: 1 },
      runtimeManifestDigest: "a".repeat(64), supportedSteps: ["navigate"], supportedAssertions: ["visible"], evidenceScopes: ["runtime"],
      networkPolicyDigest: "b".repeat(64), browsers: ["chromium"] });
    const target = { targetId: "web-a", applicationId: "app-a", runtimeProfileId: "web-profile", accountProfileId: "account-a",
      kind: "web", browser: "chromium" } as unknown as Parameters<typeof validateE2EApplicationLaunchTarget>[0];
    const runtime = { profileId: "web-profile", manifestDigest: "c".repeat(64), capabilities: capability } as unknown as Parameters<typeof validateE2EApplicationLaunchTarget>[2];
    const launchRaw = { targetId: "web-a", profileId: "web-profile", factoryId: "installed-web", factoryManifestDigest: "c".repeat(64),
      engine: { name: "playwright", version: "1.0.0", spiVersion: 1, platform: "web", capabilities: ["actions", "observation"] },
      artifactCapabilities: [], stateCapability: false, app: { identity: "app-a", environment: "test" } };
    const launch = launchRaw as unknown as Parameters<typeof validateE2EApplicationLaunchTarget>[1];
    const capture = { screenshots: false, traces: false, video: false, downloads: false };
    expect(() => validateE2EApplicationLaunchTarget(target, launch, runtime, capture)).not.toThrow();
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, app: { ...launchRaw.app, identity: "app-b" } } as never, runtime, capture)).toThrow(/source application/);
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, targetId: "web-b" } as never, runtime, capture)).toThrow(/source target/);
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, artifactCapabilities: ["screenshot"] } as never, runtime, capture)).toThrow(/capture policy/);
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, engine: { ...launchRaw.engine, capabilities: ["actions"] } } as never, runtime, capture)).toThrow(/action or observation/);
  });

  it("rejects a native bundle or device descriptor swapped within the same platform", () => {
    const capability = E2ERuntimeCapabilityDescriptorSchema.parse({ schemaVersion: "e2e-runtime-capabilities/v1", profileId: "ios-profile",
      kind: "ios", host: { os: "darwin", arch: "arm64" }, engine: { name: "xctest", version: "2.0.0", spiVersion: 1 },
      runtimeManifestDigest: "a".repeat(64), supportedSteps: ["launch-app"], supportedAssertions: ["visible"], evidenceScopes: ["runtime"],
      networkPolicyDigest: "b".repeat(64), deviceProfileIds: ["sim-a"], os: "ios", deviceKinds: ["simulator"] });
    const target = { targetId: "ios-a", applicationId: "app-a", runtimeProfileId: "ios-profile", accountProfileId: "account-a",
      kind: "mobile", os: "ios", appId: "com.example.a", deviceProfileId: "sim-a" } as unknown as Parameters<typeof validateE2EApplicationLaunchTarget>[0];
    const runtime = { profileId: "ios-profile", manifestDigest: "c".repeat(64), capabilities: capability } as unknown as Parameters<typeof validateE2EApplicationLaunchTarget>[2];
    const launchRaw = { targetId: "ios-a", profileId: "ios-profile", factoryId: "installed-ios", factoryManifestDigest: "c".repeat(64),
      engine: { name: "xctest", version: "2.0.0", spiVersion: 1, platform: "ios", capabilities: ["actions", "observation"] },
      artifactCapabilities: [], stateCapability: false, app: { identity: "app-a", bundleId: "com.example.a", appPath: "/staged/app-a.app", environment: "test" } };
    const launch = launchRaw as unknown as Parameters<typeof validateE2EApplicationLaunchTarget>[1];
    const capture = { screenshots: false, traces: false, video: false, downloads: false };
    expect(() => validateE2EApplicationLaunchTarget(target, launch, runtime, capture)).not.toThrow();
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, app: { ...launchRaw.app, bundleId: "com.example.b" } } as never, runtime, capture)).toThrow(/source bundle/);
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, app: { ...launchRaw.app, identity: "app-b" } } as never, runtime, capture)).toThrow(/source application/);
    expect(() => validateE2EApplicationLaunchTarget(target, { ...launchRaw, engine: { ...launchRaw.engine, platform: "android" } } as never, runtime, capture)).toThrow(/target platform/);
  });
});
