import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  E2EApplicationApprovalBindingSchema, E2EApplicationPlanIntentSchema, E2EAppBuildManifestSchema,
  E2EAppArtifactOutputSchema, E2EAppArtifactRefSchema, E2EApplicationRuntimeRefSchema, E2EFeaturePlanIntentAnySchema,
  E2ERuntimeAccountRefSchema, PlanApprovalRefSchema, SourceRefSchema, canonicalJson, createCandidateManifest, e2eAppBuildManifestDigest,
  inspectE2ERepository, proposeE2ESetup, type E2EApplicationPlanIntent, type E2EAppBuildManifest,
  type E2EAppArtifactRef, type E2EPolicy, type E2ESourceSnapshot,
} from "@agentx/contracts";
import {
  deriveE2EApplicationApprovalBinding, validateE2EAppBuildBinding,
  e2eApplicationMetadataSourceRefs,
} from "../../packages/broker/src/e2e/application-plan-binding.js";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const packageBytes = Buffer.from(JSON.stringify({ name: "ordinary-orders", type: "module", scripts: { start: "node server.js" } }));
const lockfileBytes = Buffer.from("lockfileVersion: 9\n");
const implementationBytes = Buffer.from("export const version = 1;\n");

function snapshot(commit: string, tree: string, implementation = implementationBytes): E2ESourceSnapshot {
  const candidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: commit, treeSha: tree }]);
  const sources = [
    { path: "package.json", bytes: packageBytes },
    { path: "pnpm-lock.yaml", bytes: lockfileBytes },
    { path: "src/index.mjs", bytes: implementation },
    { path: "fixtures/unrelated/pnpm-lock.yaml", bytes: Buffer.from("lockfileVersion: 9\n# unrelated fixture\n") },
    { path: "fixtures/unrelated/native/Podfile", bytes: Buffer.from("platform :ios, '17.0'\n") },
  ];
  return {
    candidate, commitSha: commit, treeSha: tree, treeComplete: true,
    treePaths: sources.map((source) => source.path),
    sources: sources.map((source) => ({ ...source, sha256: sha(source.bytes), kind: "blob" as const })),
  };
}

const scenario = {
  scenarioId: "orders-visible", requirementId: "orders-render", requestedTargetIds: ["web-1"], required: true,
  accountProfileId: "synthetic", minimumEvidence: "runtime" as const, requiredRealComponentIds: [],
  steps: [{ kind: "navigate" as const, path: "/orders" }],
  assertions: [{ kind: "visible" as const, testId: "orders", equals: true }],
};

function planIntent(source: E2ESourceSnapshot): E2EApplicationPlanIntent {
  const inspection = inspectE2ERepository(source, source.candidate).inspection;
  const application = inspection.applications.find((item) => item.applicationId === "ordinary-orders");
  if (!application?.recipe) throw new Error("fixture must discover the source-backed application recipe");
  const metadataRefs = ["package.json", "pnpm-lock.yaml"].map((path) => {
    const item = source.sources.find((candidate) => candidate.path === path);
    if (!item) throw new Error(`fixture is missing ${path}`);
    return { path, sha256: item.sha256 };
  });
  return {
    schemaVersion: 2, requestedTargetIds: ["web-1"], accountContextRefs: [{ applicationId: "ordinary-orders", profileId: "synthetic",
      sourcePath: "package.json", sourceSha256: sha(packageBytes) }], scenarios: [scenario], semanticExportDeltas: [],
    applicationRuntimeRefs: [{ targetId: "web-1", applicationId: "ordinary-orders", recipeDigest: application.recipe.recipeDigest,
      sourceRefs: metadataRefs, runtimeProfileId: "qualified-chromium", accountProfileId: "synthetic" }],
    runtimeAccountRefs: [{ applicationId: "ordinary-orders", profileId: "synthetic", revision: 1, definitionDigest: "a".repeat(64) }],
  };
}

function setupFor(source: E2ESourceSnapshot) {
  const inspection = inspectE2ERepository(source, source.candidate).inspection;
  return proposeE2ESetup({ inspection, snapshot: source, expectedCandidate: source.candidate });
}

function approval(source: E2ESourceSnapshot, setup = setupFor(source), intent = planIntent(source)) {
  return deriveE2EApplicationApprovalBinding({ preparedSnapshot: source, intent, artifactId: "feature-plan",
    artifactSha256: "b".repeat(64), planDigest: "c".repeat(64), setupProposal: setup,
    setupApproval: { artifactId: "setup-proposal", digest: sha(canonicalJson(setup)) } });
}

function buildManifest(final: E2ESourceSnapshot, binding = approval(final)): E2EAppBuildManifest {
  const body = {
    schemaVersion: "e2e-app-build/v1" as const, candidateDigest: final.candidate.digest, applicationId: "ordinary-orders",
    repository: { repositoryId: "ordinary-orders", commitSha: final.commitSha, treeSha: final.treeSha },
    recipeDigest: binding.applications[0]!.recipe.recipeDigest,
    lockfileRefs: [{ path: "pnpm-lock.yaml", sha256: sha(lockfileBytes) }], toolchainManifestDigest: "d".repeat(64),
    outputs: [{ artifactId: "orders-web-bundle", sha256: "e".repeat(64), appId: "ordinary-orders", platform: "web" as const }],
    createdAt: "2026-10-17T12:30:00.000Z",
  };
  return { ...body, manifestDigest: sha(canonicalJson(body)) };
}

function artifactRefs(manifest: E2EAppBuildManifest): E2EAppArtifactRef[] {
  return manifest.outputs.map((output) => ({ ...output, buildManifestDigest: manifest.manifestDigest }));
}

const policy: E2EPolicy = {
  schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [],
  targets: [{ targetId: "web-1", applicationId: "ordinary-orders", runtimeProfileId: "web-phase-unavailable",
    accountProfileId: "synthetic", kind: "web", browser: "chromium", viewport: { width: 1280, height: 720 } }],
  defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
  capture: { screenshots: false, traces: false, video: false, downloads: false },
  limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
    maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null },
};

describe("source-bound application approval and build identity", () => {
  it("binds a real UI scenario without inventing portable operations", () => {
    const prepared = snapshot("1".repeat(40), "2".repeat(40));
    const intent = planIntent(prepared);
    expect(E2EApplicationPlanIntentSchema.safeParse(intent).success).toBe(true);
    expect(intent.portableOperationRefs).toBeUndefined();
    expect(approval(prepared).runtimeRefs).toMatchObject([{ targetId: "web-1", runtimeProfileId: "qualified-chromium" }]);
    expect(approval(prepared).runtimeRefs[0]?.runtimeProfileId).not.toBe("web-phase-unavailable");
    expect(E2EFeaturePlanIntentAnySchema.safeParse(intent).success).toBe(true);
    const portableIntent = { schemaVersion: 1 as const, requestedTargetIds: intent.requestedTargetIds,
      accountContextRefs: intent.accountContextRefs, scenarios: intent.scenarios, semanticExportDeltas: intent.semanticExportDeltas };
    expect(E2EFeaturePlanIntentAnySchema.safeParse({ ...portableIntent, schemaVersion: 1 }).success).toBe(true);
  });

  it("represents a source-bound unavailable application obligation without inventing runtime authority", () => {
    const source = snapshot("1".repeat(40), "2".repeat(40));
    const intent = planIntent(source);
    const runtimeRef = intent.applicationRuntimeRefs[0]!;
    const unavailable = { ...intent, applicationRuntimeRefs: [], runtimeAccountRefs: [],
      unavailableTargetRefs: [{ targetId: runtimeRef.targetId, applicationId: runtimeRef.applicationId,
        accountProfileId: runtimeRef.accountProfileId, sourceRefs: runtimeRef.sourceRefs }] };
    expect(E2EApplicationPlanIntentSchema.safeParse(unavailable).success).toBe(true);
    expect(E2EApplicationPlanIntentSchema.safeParse({ ...unavailable,
      unavailableTargetRefs: [{ ...unavailable.unavailableTargetRefs[0]!, runtimeProfileId: "invented" }] }).success).toBe(false);
    expect(E2EApplicationPlanIntentSchema.safeParse({ ...unavailable,
      applicationRuntimeRefs: [runtimeRef] }).success).toBe(false);
  });

  it("retains approved setup lineage when only application implementation bytes change", () => {
    const setupSnapshot = snapshot("3".repeat(40), "4".repeat(40));
    const prepared = snapshot("5".repeat(40), "6".repeat(40), Buffer.from("export const version = 2;\n"));
    const setup = setupFor(setupSnapshot);
    const binding = deriveE2EApplicationApprovalBinding({ preparedSnapshot: prepared, intent: planIntent(prepared), artifactId: "feature-plan",
      artifactSha256: "b".repeat(64), planDigest: "c".repeat(64), setupProposal: setup,
      setupApproval: { artifactId: "setup-proposal", digest: sha(canonicalJson(setup)) } });
    expect(binding.proposalSource.commitSha).toBe(prepared.commitSha);
    expect(binding.applications[0]?.sourceRefs.map((ref) => ref.path)).toEqual(["package.json", "pnpm-lock.yaml"]);
  });

  it("projects bounded source-backed application, unavailable runtime, and account context refs", () => {
    const source = snapshot("3".repeat(40), "4".repeat(40));
    const context = buildFeatureE2EPlanningContext(policy, source);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.applicationRefs).toMatchObject([{ applicationId: "ordinary-orders", recipe: { launch: { kind: "service" } },
      sourceRefs: [{ path: "package.json" }, { path: "pnpm-lock.yaml" }] }]);
    expect(context.runtimeRefs).toMatchObject([{ targetId: "web-1", applicationId: "ordinary-orders",
      runtimeProfileId: "web-phase-unavailable", accountProfileId: "synthetic" }]);
    expect(context.accountContextRefs).toMatchObject([{ applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json" }]);
  });

  it("rejects a runtime reference assigned to a target absent from every scenario", () => {
    const source = snapshot("7".repeat(40), "8".repeat(40));
    const intent = planIntent(source);
    intent.applicationRuntimeRefs[0] = { ...intent.applicationRuntimeRefs[0]!, targetId: "foreign-target" };
    expect(() => deriveE2EApplicationApprovalBinding({ preparedSnapshot: source, intent, artifactId: "feature-plan",
      artifactSha256: "b".repeat(64), planDigest: "c".repeat(64), setupProposal: setupFor(source),
      setupApproval: { artifactId: "setup-proposal", digest: sha(canonicalJson(setupFor(source))) } })).toThrow(/target|scenario/i);
  });

  it("rejects a fake portable operation attached to a real UI scenario", () => {
    const intent = planIntent(snapshot("8".repeat(40), "9".repeat(40)));
    intent.portableOperationRefs = [{ operationId: "fake-operation", applicationId: "ordinary-orders", requestedTargetIds: ["web-1"],
      packageExportSubpath: ".", moduleSpecifier: "./src/index.mjs", callableSelector: { kind: "named", exportName: "run" } }];
    expect(E2EApplicationPlanIntentSchema.safeParse(intent).success).toBe(false);
  });

  it("rejects a foreign application, account, or scenario assignment", () => {
    const intent = planIntent(snapshot("8".repeat(40), "a".repeat(40)));
    const foreignApplication = { ...intent, applicationRuntimeRefs: [{ ...intent.applicationRuntimeRefs[0]!, applicationId: "foreign-app" }] };
    const foreignAccount = { ...intent, runtimeAccountRefs: [{ ...intent.runtimeAccountRefs[0]!, profileId: "foreign-account" }] };
    const foreignScenario = { ...intent, scenarios: [{ ...scenario, accountProfileId: "other-account" }] };
    const additionalUnapprovedScenario = { ...intent, scenarios: [scenario, { ...scenario, scenarioId: "admin-orders", accountProfileId: "unapproved-admin" }] };
    expect(E2EApplicationPlanIntentSchema.safeParse(foreignApplication).success).toBe(false);
    expect(E2EApplicationPlanIntentSchema.safeParse(foreignAccount).success).toBe(false);
    expect(E2EApplicationPlanIntentSchema.safeParse(foreignScenario).success).toBe(false);
    expect(E2EApplicationPlanIntentSchema.safeParse(additionalUnapprovedScenario).success).toBe(false);

    const unauthorizedPlan = {
      ...intent,
      accountContextRefs: [...intent.accountContextRefs, { ...intent.accountContextRefs[0]!, profileId: "unapproved-admin" }],
      scenarios: [scenario, { ...scenario, scenarioId: "admin-orders", accountProfileId: "unapproved-admin" }],
      applicationRuntimeRefs: [{ ...intent.applicationRuntimeRefs[0]!, accountProfileId: "unapproved-admin" }],
      runtimeAccountRefs: [{ ...intent.runtimeAccountRefs[0]!, profileId: "unapproved-admin" }],
    };
    const source = snapshot("8".repeat(40), "a".repeat(40));
    const setup = setupFor(source);
    expect(() => deriveE2EApplicationApprovalBinding({ preparedSnapshot: source, intent: unauthorizedPlan,
      artifactId: "feature-plan", artifactSha256: "b".repeat(64), planDigest: "c".repeat(64), setupProposal: setup,
      setupApproval: { artifactId: "setup-proposal", digest: sha(canonicalJson(setup)) } })).toThrow(/account|profile|source-derived/i);
  });

  it("keeps planning-context and binding metadata selection aligned across unrelated descendant files", () => {
    const prepared = snapshot("a".repeat(40), "b".repeat(40));
    const context = buildFeatureE2EPlanningContext(policy, prepared);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    const application = context.applicationRefs?.find((item) => item.applicationId === "ordinary-orders");
    expect(application?.sourceRefs.map((ref) => ref.path)).toEqual(["package.json", "pnpm-lock.yaml"]);
    const preparedIntent = planIntent(prepared);
    preparedIntent.scenarios = [scenario, { ...scenario, scenarioId: "orders-refresh" }];
    expect(E2EApplicationPlanIntentSchema.safeParse(preparedIntent).success).toBe(true);
    const binding = approval(prepared, setupFor(prepared), preparedIntent);
    expect(binding.applications[0]?.sourceRefs).toEqual(application?.sourceRefs);
    const final = snapshot("c".repeat(40), "d".repeat(40));
    const finalIntent = planIntent(final);
    finalIntent.scenarios = [scenario, { ...scenario, scenarioId: "orders-refresh" }];
    const finalBinding = approval(final, setupFor(final), finalIntent);
    const manifest = buildManifest(final, finalBinding);
    expect(validateE2EAppBuildBinding({ finalSnapshot: final, binding: finalBinding, manifest, artifacts: artifactRefs(manifest) }))
      .toMatchObject({ candidateDigest: final.candidate.digest, applicationId: "ordinary-orders" });
  });

  it("keeps account-context provenance on application identity when root build metadata sorts first", () => {
    const base = snapshot("f".repeat(40), "1".repeat(40));
    const ancillaryFiles = [
      { path: "go.mod", bytes: Buffer.from("module example.com/ancillary\ngo 1.23\n") },
      { path: "build.gradle", bytes: Buffer.from("plugins { id 'base' }\n") },
    ].map((item) => ({ ...item, sha256: sha(item.bytes), kind: "blob" as const }));
    const source: E2ESourceSnapshot = { ...base, treePaths: [...base.treePaths, ...ancillaryFiles.map((item) => item.path)],
      sources: [...base.sources, ...ancillaryFiles] };
    const context = buildFeatureE2EPlanningContext(policy, source);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.accountContextRefs).toMatchObject([{ applicationId: "ordinary-orders", profileId: "synthetic", sourcePath: "package.json" }]);
    const application = context.applicationRefs?.find((item) => item.applicationId === "ordinary-orders");
    const runtime = context.runtimeRefs?.find((item) => item.targetId === "web-1");
    if (!application || !runtime || runtime.recipeDigest === null) throw new Error("context must provide a source-backed application recipe");
    const intent: E2EApplicationPlanIntent = {
      ...planIntent(source), accountContextRefs: context.accountContextRefs,
      applicationRuntimeRefs: [{ targetId: runtime.targetId, applicationId: runtime.applicationId, recipeDigest: runtime.recipeDigest,
        sourceRefs: application.sourceRefs, runtimeProfileId: "qualified-chromium", accountProfileId: runtime.accountProfileId }],
    };
    const binding = approval(source, setupFor(source), intent);
    const manifest = buildManifest(source, binding);
    expect(validateE2EAppBuildBinding({ finalSnapshot: source, binding, manifest, artifacts: artifactRefs(manifest) }))
      .toMatchObject({ candidateDigest: source.candidate.digest, applicationId: "ordinary-orders" });
  });

  it("uses native application identity for account provenance when no package manifest exists", () => {
    const commitSha = "2".repeat(40);
    const treeSha = "3".repeat(40);
    const candidate = createCandidateManifest([{ repositoryId: "native-orders", commitSha, treeSha }]);
    const files = [
      { path: "android/app/src/main/AndroidManifest.xml", bytes: Buffer.from('<manifest package="com.example.orders"/>\n') },
      { path: "android/app/build.gradle", bytes: Buffer.from("plugins { id 'com.android.application' }\n") },
      { path: "android/app/gradle.lockfile", bytes: Buffer.from("com.android.tools.build:gradle:8.0=8.0\n") },
    ].map((item) => ({ ...item, sha256: sha(item.bytes), kind: "blob" as const }));
    const source: E2ESourceSnapshot = { candidate, commitSha, treeSha, treeComplete: true,
      treePaths: files.map((file) => file.path), sources: files };
    const inspection = inspectE2ERepository(source, candidate).inspection;
    const target = inspection.proposedTargets.find((item) => item.kind === "mobile" && item.os === "android");
    if (!target || target.kind !== "mobile") throw new Error("fixture must discover a native Android target");
    const nativePolicy: E2EPolicy = { ...policy, targets: [target] };
    const context = buildFeatureE2EPlanningContext(nativePolicy, source);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.accountContextRefs).toMatchObject([{ applicationId: target.applicationId, profileId: "synthetic",
      sourcePath: "android/app/src/main/AndroidManifest.xml" }]);
    expect(context.applicationRefs?.find((item) => item.applicationId === target.applicationId)?.sourceRefs.map((ref) => ref.path))
      .toContain("android/app/build.gradle");
  });

  it("selects native project identity and owned build metadata without requiring package.json", () => {
    const source = snapshot("d".repeat(40), "e".repeat(40));
    const nativeFiles = [
      { path: "android/app/src/main/AndroidManifest.xml", bytes: Buffer.from('<manifest package="com.example.orders"/>\n') },
      { path: "android/app/build.gradle", bytes: Buffer.from("plugins { id 'com.android.application' }\n") },
      { path: "android/app/gradle.lockfile", bytes: Buffer.from("com.android.tools.build:gradle:8.0=8.0\n") },
      { path: "android/build.gradle", bytes: Buffer.from("plugins { id 'com.android.application' apply false }\n") },
    ].map((item) => ({ ...item, sha256: sha(item.bytes), kind: "blob" as const }));
    const refs = e2eApplicationMetadataSourceRefs({ ...source, sources: [...source.sources, ...nativeFiles] },
      "native-orders", ["android/app/src/main/AndroidManifest.xml"]);
    expect(refs.map((ref) => ref.path)).toEqual([
      "android/app/build.gradle", "android/app/gradle.lockfile", "android/app/src/main/AndroidManifest.xml", "android/build.gradle", "pnpm-lock.yaml",
    ]);
    expect(refs.some((ref) => ref.path === "fixtures/unrelated/native/Podfile")).toBe(false);
  });

  it("rejects an ambiguous source recipe instead of choosing start or dev", () => {
    const ambiguousPackage = Buffer.from(JSON.stringify({ name: "ordinary-orders", type: "module", scripts: { start: "node server.js", dev: "node dev.js" } }));
    const ambiguous = snapshot("9".repeat(40), "a".repeat(40));
    const sources = ambiguous.sources.map((source) => source.path === "package.json"
      ? { ...source, bytes: ambiguousPackage, sha256: sha(ambiguousPackage) } : source);
    const changed = { ...ambiguous, sources };
    const inspection = inspectE2ERepository(changed, changed.candidate).inspection;
    const setup = proposeE2ESetup({ inspection, snapshot: changed, expectedCandidate: changed.candidate });
    const intent = planIntent(snapshot("a".repeat(40), "b".repeat(40)));
    expect(() => deriveE2EApplicationApprovalBinding({ preparedSnapshot: changed, intent, artifactId: "feature-plan",
      artifactSha256: "b".repeat(64), planDigest: "c".repeat(64), setupProposal: setup,
      setupApproval: { artifactId: "setup-proposal", digest: sha(canonicalJson(setup)) } })).toThrow(/recipe|start|dev/i);
  });

  it("binds final source, lockfile, candidate, output hashes, and manifest digest", () => {
    const final = snapshot("b".repeat(40), "c".repeat(40));
    const binding = approval(final);
    const manifest = buildManifest(final, binding);
    expect(E2EApplicationApprovalBindingSchema.safeParse(binding).success).toBe(true);
    expect(E2EAppBuildManifestSchema.safeParse(manifest).success).toBe(true);
    expect(E2EAppArtifactRefSchema.safeParse(artifactRefs(manifest)[0]).success).toBe(true);
    expect(validateE2EAppBuildBinding({ finalSnapshot: final, binding, manifest, artifacts: artifactRefs(manifest) }))
      .toMatchObject({ candidateDigest: final.candidate.digest, applicationId: "ordinary-orders", buildManifestDigest: manifest.manifestDigest });
  });

  it("rejects changed recipe metadata and a mismatched final lockfile", () => {
    const prepared = snapshot("d".repeat(40), "e".repeat(40));
    const binding = approval(prepared);
    const changedPackage = Buffer.from(JSON.stringify({ name: "ordinary-orders", type: "module", scripts: { dev: "node server.js" } }));
    const changed = snapshot("f".repeat(40), "1".repeat(40));
    const changedSource = changed.sources.map((source) => source.path === "package.json"
      ? { ...source, bytes: changedPackage, sha256: sha(changedPackage) } : source);
    const changedSnapshot = { ...changed, sources: changedSource };
    const changedManifest = buildManifest(changedSnapshot, binding);
    expect(() => validateE2EAppBuildBinding({ finalSnapshot: changedSnapshot, binding, manifest: changedManifest, artifacts: artifactRefs(changedManifest) }))
      .toThrow(/recipe|source|metadata/i);

    const validFinal = snapshot("2".repeat(40), "3".repeat(40));
    const lockBinding = approval(validFinal);
    const manifest = buildManifest(validFinal, lockBinding);
    const wrongLockBody = { ...manifest, lockfileRefs: [] };
    const wrongLockManifest = { ...wrongLockBody, manifestDigest: e2eAppBuildManifestDigest(wrongLockBody) };
    expect(() => validateE2EAppBuildBinding({ finalSnapshot: validFinal, binding: lockBinding, manifest: wrongLockManifest,
      artifacts: artifactRefs(manifest) })).toThrow(/lockfile/i);

    const changedLockBytes = Buffer.from("lockfileVersion: 9\n# changed dependency resolution\n");
    const changedLockSources = validFinal.sources.map((source) => source.path === "pnpm-lock.yaml"
      ? { ...source, bytes: changedLockBytes, sha256: sha(changedLockBytes) } : source);
    const changedLockSnapshot = { ...validFinal, sources: changedLockSources };
    const changedLockManifest = buildManifest(changedLockSnapshot, lockBinding);
    expect(() => validateE2EAppBuildBinding({ finalSnapshot: changedLockSnapshot, binding: lockBinding,
      manifest: changedLockManifest, artifacts: artifactRefs(changedLockManifest) })).toThrow(/source-owned identity or lockfile metadata/i);
  });

  it("rejects a foreign output platform, candidate, or artifact hash reference", () => {
    const final = snapshot("6".repeat(40), "7".repeat(40));
    const binding = approval(final);
    const manifest = buildManifest(final, binding);
    const foreignPlatformBody = { ...manifest, outputs: manifest.outputs.map((output) => ({ ...output, platform: "android" as const })) };
    const foreignPlatform = { ...foreignPlatformBody, manifestDigest: e2eAppBuildManifestDigest(foreignPlatformBody) };
    expect(() => validateE2EAppBuildBinding({ finalSnapshot: final, binding, manifest: foreignPlatform, artifacts: artifactRefs(foreignPlatform) }))
      .toThrow(/platform|app ID/i);

    const otherCandidate = snapshot("8".repeat(40), "9".repeat(40));
    const otherManifest = buildManifest(otherCandidate, binding);
    expect(() => validateE2EAppBuildBinding({ finalSnapshot: final, binding, manifest: otherManifest, artifacts: artifactRefs(otherManifest) }))
      .toThrow(/candidate|repository/i);
    const wrongArtifact = { ...artifactRefs(manifest)[0]!, sha256: "f".repeat(64) };
    expect(() => validateE2EAppBuildBinding({ finalSnapshot: final, binding, manifest, artifacts: [wrongArtifact] }))
      .toThrow(/artifact references/i);
  });

  it("rejects credential-shaped account data and noncanonical timestamps through strict schemas", () => {
    const source = snapshot("4".repeat(40), "5".repeat(40));
    const intent = planIntent(source);
    const credentialLike = { ...intent.runtimeAccountRefs[0]!, token: "secret-literal" };
    expect(E2EApplicationPlanIntentSchema.safeParse({ ...intent, runtimeAccountRefs: [credentialLike] }).success).toBe(false);
    const manifest = buildManifest(source);
    expect(E2EAppBuildManifestSchema.safeParse({ ...manifest, createdAt: "2026-02-30T12:30:00.000Z" }).success).toBe(false);
    expect(() => E2EAppBuildManifestSchema.safeParse({ ...manifest, outputs: [{ artifactId: "", sha256: "nope" }] })).not.toThrow();
    expect(() => E2EApplicationApprovalBindingSchema.safeParse({ ...approval(source), runtimeRefs: [{ targetId: "x" }] })).not.toThrow();
    expect(() => SourceRefSchema.safeParse({ path: "../package.json", sha256: "bad" })).not.toThrow();
    expect(() => PlanApprovalRefSchema.safeParse({ artifactId: "", digest: "bad" })).not.toThrow();
    expect(() => E2EApplicationRuntimeRefSchema.safeParse({ targetId: "", sourceRefs: [{ path: "../x", sha256: "bad" }] })).not.toThrow();
    expect(() => E2ERuntimeAccountRefSchema.safeParse({ applicationId: "x", profileId: "x", revision: 0, definitionDigest: "bad" })).not.toThrow();
    expect(() => E2EAppArtifactOutputSchema.safeParse({ artifactId: "x", sha256: "bad", appId: "x", platform: "ios", extra: true })).not.toThrow();
  });
});
