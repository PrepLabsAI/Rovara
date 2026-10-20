import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type E2EPolicy, type E2ESourceSnapshot } from "@agentx/contracts";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";

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
