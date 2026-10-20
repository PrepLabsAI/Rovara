import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2EApplicationIdentityMissingError, E2EApplicationPlanIntentSchema, WEB_API_RUNTIME_PROFILE_ID, createCandidateManifest, inspectE2ERepository, proposeE2ESetup,
  type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { readFileSync } from "node:fs";
import { buildFeatureE2EPlanningContext, describeFeatureE2EExecutableKinds } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { evaluateApplicationPlanApproval } from "../../packages/broker/src/e2e/application-plan-approval.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { webApiRow } from "../support/e2e-application-plan-fixtures.js";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const candidate = createCandidateManifest([{ repositoryId: "ordinary-orders", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
function snapshotOf(files: Record<string, string>): E2ESourceSnapshot {
  return { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha, treeComplete: true, treePaths: Object.keys(files),
    sources: Object.entries(files).map(([path, text]) => { const bytes = Buffer.from(text); return { path, sha256: sha(bytes), bytes, kind: "blob" as const }; }) };
}
const webFiles = { "package.json": JSON.stringify({ name: "orders-web", type: "module", scripts: { start: "node src/index.mjs" } }), "src/index.mjs": "export const orders = 1;\n" };
// An Android project with only a build script: discovery lists it, but it has no source-owned identity and no target.
const androidFiles = { "android/app/build.gradle": "plugins { id 'com.android.application' }\n" };
// An API contract with no package.json beside it: discovery proposes a target for it, but it has no source-owned identity.
const apiContractFiles = { "openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "Billing", version: "1" }, paths: {} }) };
const API_TARGET_ID = "api-schema-a9865368a7fc";
const webTarget = { targetId: "web-1", applicationId: "orders-web", runtimeProfileId: "web-phase-unavailable", accountProfileId: "synthetic", kind: "web" as const, browser: "chromium" as const, viewport: { width: 1280, height: 720 } };
const apiTarget = { targetId: API_TARGET_ID, applicationId: "api-contract-a9865368a7fc", runtimeProfileId: "api-phase-unavailable", accountProfileId: "synthetic", kind: "api" as const, protocol: "http" as const, originRef: "app-origin" };
const policyFor = (targets: E2EPolicy["targets"]): E2EPolicy => ({ schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets, defaultSandboxProfileId: "default-sandbox",
  fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false },
  limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } });
const approvedSetup = { origin: "approved-setup" as const, preparedCommitSha: null };

describe("the planning context survives a discovered application that has no source-owned identity", () => {
  it("leaves a discovered app the policy does not target out of the context, and changes nothing else", () => {
    const policy = policyFor([webTarget]);
    const baseline = buildFeatureE2EPlanningContext(policy, snapshotOf(webFiles), approvedSetup);
    const withAndroid = buildFeatureE2EPlanningContext(policy, snapshotOf({ ...webFiles, ...androidFiles }), approvedSetup);
    expect(baseline.status).toBe("available");
    expect(withAndroid).toEqual(baseline);
    if (withAndroid.status !== "available") return;
    expect(withAndroid.source).toMatchObject({ commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha, candidateDigest: candidate.digest });
    expect(withAndroid.applicationRefs?.map((item) => item.applicationId)).toEqual(["orders-web"]);
  });

  it("makes only a targeted app without identity unavailable, with its own reason, and keeps the other target and the commit and tree", () => {
    const context = buildFeatureE2EPlanningContext(policyFor([webTarget, apiTarget]), snapshotOf({ ...Object.fromEntries(Object.entries(webFiles).map(([path, text]) => [`web/${path}`, text])), ...apiContractFiles }), approvedSetup);
    expect(context.status).toBe("available");
    if (context.status !== "available") return;
    expect(context.source).toMatchObject({ commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha });
    expect(context.targets.map((item) => item.targetId).sort()).toEqual([API_TARGET_ID, "web-1"]);
    expect(context.unavailableReasons).toContainEqual({ targetId: API_TARGET_ID, reason: "no-source-identity" });
    expect(context.unavailableReasons?.find((item) => item.targetId === "web-1")?.reason).not.toBe("no-source-identity");
    // The target without identity has no application reference and no account context; the other target keeps both.
    expect(context.applicationRefs?.map((item) => item.applicationId)).toEqual(["orders-web"]);
    expect(context.accountContextRefs.map((item) => item.applicationId)).toEqual(["orders-web"]);
    expect(context.runtimeRefs?.map((item) => item.targetId)).toEqual(["web-1"]);
    expect(context.unavailableTargetRefs?.map((item) => item.targetId) ?? []).not.toContain(API_TARGET_ID);
  });

  it("still fails closed for any other identity failure, and reports a policy whose every target lacks identity", () => {
    const policy = policyFor([webTarget]);
    // A targeted application whose package.json is not valid JSON.
    expect(buildFeatureE2EPlanningContext(policy, snapshotOf({ ...webFiles, "package.json": "{ not json" }), approvedSetup)).toMatchObject({ status: "unknown" });
    // A policy whose every target lacks identity has nothing source-backed to plan against.
    const onlyIdentityless = buildFeatureE2EPlanningContext(policyFor([apiTarget]), snapshotOf(apiContractFiles), approvedSetup);
    expect(onlyIdentityless.status).toBe("available");
    if (onlyIdentityless.status === "available") expect(onlyIdentityless.unavailableReasons).toEqual([{ targetId: API_TARGET_ID, reason: "no-source-identity" }]);
  });
});

describe("a qualified-profile policy with an identity-less target beside a ready one of the same kind (Ruling BN)", () => {
  const ordersManifest = JSON.parse(readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8")) as { name: string; agentx: { e2e: Record<string, unknown> } };
  const files = { "api/package.json": JSON.stringify({ ...ordersManifest, name: "@acme/orders-api", dependencies: { express: "4.0.0" }, agentx: { e2e: { ...ordersManifest.agentx.e2e, targetAccounts: [] } } }),
    "billing/openapi.json": JSON.stringify({ openapi: "3.1.0", info: { title: "Billing", version: "1" }, paths: {} }) };
  const snapshot = snapshotOf(files);
  const inspection = inspectE2ERepository(snapshot, candidate).inspection;
  const setup = proposeE2ESetup({ inspection, snapshot, expectedCandidate: candidate, readyProfiles: [{ kind: "api", profileId: WEB_API_RUNTIME_PROFILE_ID }] });
  const policy: E2EPolicy = { ...policyFor(setup.targets), baselineScenarioIds: [] };
  const apiCaps = webApiRuntimeCapabilities("api", "a".repeat(64));
  const ready = [{ kind: "api" as const, profileId: WEB_API_RUNTIME_PROFILE_ID, supportedSteps: apiCaps.supportedSteps, supportedAssertions: apiCaps.supportedAssertions }];
  const context = buildFeatureE2EPlanningContext(policy, snapshot, { ...approvedSetup, readyRuntimes: ready });
  if (context.status !== "available") throw new Error(context.reason);
  const identityless = context.unavailableReasons?.find((item) => item.reason === "no-source-identity")?.targetId;
  const readyTarget = context.runtimeRefs?.find((item) => !context.unavailableReasons?.some((reason) => reason.targetId === item.targetId))?.targetId;

  it("has one ready api target and one target without identity, each in its own place in the context", () => {
    expect(identityless).toBeDefined();
    expect(readyTarget).toBeDefined();
    expect(context.targets.map((item) => item.targetId)).toContain(identityless);
    expect(context.executableKinds?.map((item) => item.kind)).toEqual(["api"]);
    expect(context.runtimeRefs?.map((item) => item.targetId)).not.toContain(identityless);
  });

  it("lists only the ready target as executable in the planner's prompt text, never the one without identity, and says what a no-source-identity target gets", () => {
    const text = describeFeatureE2EExecutableKinds(context);
    const apiLine = text.split("\n").find((line) => line.startsWith("- api targets"))!;
    expect(apiLine).toContain(readyTarget!);
    expect(apiLine).not.toContain(identityless!);
    expect(text).toContain("no-source-identity");
    expect(text).toMatch(/no-source-identity[^\n]*(no scenario|no application scenario|not plan)/i);
  });

  it("excludes every target in unavailableReasons from the executable list, even when it is in no unavailableTargetRefs entry", () => {
    const text = describeFeatureE2EExecutableKinds({ targets: [{ targetId: "api-ready", applicationId: "a", kind: "api", accountProfileId: "synthetic" },
      { targetId: "api-noid", applicationId: "b", kind: "api", accountProfileId: "synthetic" }], unavailableTargetRefs: [], unavailableReasons: [{ targetId: "api-noid", reason: "no-source-identity" }],
    executableKinds: [{ kind: "api", steps: ["request"], assertions: ["http-status"] }] });
    expect(text).toContain("api targets (api-ready):");
    expect(text.split("\n").find((line) => line.startsWith("- api targets"))).not.toContain("api-noid");
  });

  it("is refused at plan approval when an intent names the identity-less target as executable", () => {
    const application = inspection.applications.find((item) => inspection.proposedTargets.some((target) => target.targetId === identityless && target.applicationId === item.applicationId))!;
    const target = setup.targets.find((item) => item.targetId === identityless)!;
    const readyRef = context.runtimeRefs!.find((item) => item.targetId === readyTarget)!;
    const scenario = { scenarioId: "billing-health", requirementId: "billing", requestedTargetIds: [identityless!], required: true, accountProfileId: target.accountProfileId, minimumEvidence: "runtime" as const,
      requiredRealComponentIds: [], steps: [{ kind: "request" as const, requestId: "health", path: "/health", method: "GET" as const, body: {} }],
      assertions: [{ kind: "http-status" as const, path: "/health", method: "GET" as const, equals: 200 }] };
    const sourcePath = "billing/openapi.json";
    const source = snapshot.sources.find((item) => item.path === sourcePath)!;
    const intent = E2EApplicationPlanIntentSchema.parse({ schemaVersion: 2, requestedTargetIds: [identityless], portableOperationRefs: [], mockFixtureRefs: [],
      accountContextRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId, sourcePath, sourceSha256: source.sha256 }], scenarios: [scenario], semanticExportDeltas: [],
      applicationRuntimeRefs: [{ ...readyRef, targetId: identityless, applicationId: application.applicationId, recipeDigest: readyRef.recipeDigest!, sourceRefs: [{ path: sourcePath, sha256: source.sha256 }],
        accountProfileId: target.accountProfileId }],
      runtimeAccountRefs: [{ applicationId: application.applicationId, profileId: target.accountProfileId, revision: 1, definitionDigest: "3".repeat(64) }], unavailableTargetRefs: [] });
    const result = evaluateApplicationPlanApproval({ intent, taskId: "task-1", artifact: { id: "plan", sha256: "1".repeat(64) }, snapshot, setupProposal: setup,
      setupApproval: { artifactId: "setup", digest: "2".repeat(64) }, policy, registeredRuntimes: [webApiRow("api")], runtimeCatalogId: "catalog",
      runtimeBinding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef" }], volumeSizeGiB: 32, volumeType: "gp3" },
      now: Date.now() });
    expect(result.ok).toBe(false);
    // With a READY api row the refusal cannot be the runtime's: it is the target's own missing identity.
    expect(result.ok).toBe(false);
    const reason = result.ok ? "approved" : result.reason;
    expect(reason).toMatch(/no-source-identity/);
    expect(reason).not.toMatch(/READY/);
    expect(!result.ok && result.scope).toBe("plan");
  });

  it("carries its name, so a log or stack says what failed", () => {
    expect(new E2EApplicationIdentityMissingError("x").name).toBe("E2EApplicationIdentityMissingError");
  });
});
