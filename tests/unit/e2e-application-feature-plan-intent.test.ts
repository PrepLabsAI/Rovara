import { describe, expect, it } from "vitest";
import { deriveE2EApplicationFeatureExecutionSelection, type E2EApplicationFeatureSelectionInput } from "../../packages/broker/src/e2e/application-feature-plan-intent.js";
import type { E2EApplicationPlanIntent, E2EPolicy } from "../../packages/contracts/src/index.js";

const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [],
  targets: [{ targetId: "android-target", applicationId: "mobile-app", runtimeProfileId: "android-phase-unavailable", accountProfileId: "synthetic",
    kind: "mobile", os: "android", appId: "com.example.mobile", deviceProfileId: "no-device-selected" }],
  defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
  capture: { screenshots: false, traces: false, video: false, downloads: false },
  limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000,
    maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };

const intent: E2EApplicationPlanIntent = { schemaVersion: 2, requestedTargetIds: ["android-target"], portableOperationRefs: [],
  mockFixtureRefs: [], accountContextRefs: [{ applicationId: "mobile-app", profileId: "synthetic", sourcePath: "app/src/main/AndroidManifest.xml", sourceSha256: "a".repeat(64) }],
  scenarios: [{ scenarioId: "native-home", requirementId: "home-visible", requestedTargetIds: ["android-target"], required: true,
    accountProfileId: "synthetic", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "launch-app" }],
    assertions: [{ kind: "visible", testId: "home", equals: true }] }], semanticExportDeltas: [], applicationRuntimeRefs: [],
  unavailableTargetRefs: [{ targetId: "android-target", applicationId: "mobile-app", accountProfileId: "synthetic",
    sourceRefs: [{ path: "app/src/main/AndroidManifest.xml", sha256: "b".repeat(64) }] }], runtimeAccountRefs: [] };

describe("application feature selection facade", () => {
  it("requires the owner artifact identity to equal the independent semantic approval", () => {
    const input = { intent, policy, artifactId: "canonical-plan", artifactSha256: "c".repeat(64),
      approvedSemanticApproval: { artifactId: "different-plan", digest: "c".repeat(64) } } as unknown as E2EApplicationFeatureSelectionInput;
    expect(() => deriveE2EApplicationFeatureExecutionSelection(input)).toThrow(/artifact identity differs/);
  });
});
