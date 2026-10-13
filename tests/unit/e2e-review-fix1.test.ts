import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCandidateManifest, type E2EPolicy, type E2EScenario } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup, type VerifiedE2ESourceSnapshot } from "../../packages/broker/src/e2e/discovery.js";
import { portableE2ECaseId, portableE2EUpstreamTestId, selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { githubRepositoryApi } from "../../packages/cli/src/setup/project-files.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const source = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: sha(text), kind: "blob" as const });
const candidate = createCandidateManifest([{ repositoryId: "acme/app", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
const snapshot = (sources: ReturnType<typeof source>[]): VerifiedE2ESourceSnapshot => ({ candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((item) => item.path), sources });
const manifest = source("app/package.json", JSON.stringify({ name: "app", scripts: { start: "vite" }, exports: { ".": "./module.ts", "./orders": "./orders.ts" } }));
const moduleFile = source("app/module.ts", "export const execute = () => true");
const ordersFile = source("app/orders.ts", "export const orders = () => []");
const snap = snapshot([manifest, moduleFile, ordersFile]);
const discovery = inspectE2ERepository(snap, candidate);
const web = discovery.inspection.proposedTargets[0]!;
const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["inherited"], targets: [web], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
const scenario: E2EScenario = { scenarioId: "selected", requirementId: "req", requestedTargetIds: [web.targetId], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [], steps: [{ kind: "invoke-contract", operationId: discovery.portableOperations[0]!.operationId, input: null }], assertions: [{ kind: "state", probeId: "result", equals: true, pollTimeoutMs: 1000 }] };
const base = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snap, planDigest: "c".repeat(64), policy, scenarios: [scenario], selectedTargetIds: [web.targetId], sandboxAvailability: { targetId: "default-sandbox" as const, profileId: "sandbox", connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "auth1" }, runtimeAvailability: [] };

describe("Task2A independent review regressions", () => {
  it("checks exact Git tree and blob object identities before returning source bytes", async () => {
    const good = Buffer.from('{"name":"good"}');
    const bad = Buffer.from('{"name":"evil"}');
    const gitBlobSha = createHash("sha1").update(Buffer.from(`blob ${good.length}\0`)).update(good).digest("hex");
    const calls = (treeSha: string, blobSha: string) => {
      const responses = [
        { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } },
        { sha: treeSha, truncated: false, tree: [{ path: "package.json", mode: "100644", type: "blob", sha: gitBlobSha, size: good.length }] },
        { sha: blobSha, encoding: "base64", size: bad.length, content: bad.toString("base64") },
      ];
      return (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch;
    };
    await expect(githubRepositoryApi(calls("f".repeat(40), gitBlobSha)).snapshot("token", "acme/app", ["package.json"], "main")).rejects.toThrow(/tree/);
    await expect(githubRepositoryApi(calls("b".repeat(40), gitBlobSha)).snapshot("token", "acme/app", ["package.json"], "main")).rejects.toThrow(/blob|Git/i);
  });

  it("rejects missing required baseline inventory and unsupported operation/native/agent work", () => {
    expect(() => selectE2EExecutionPlan(base)).toThrow(/baseline|scenario/i);
    const operation = discovery.portableOperations[0]!.operationId;
    const noBaseline = { ...base, policy: { ...policy, baselineScenarioIds: [] } };
    const unknown = selectE2EExecutionPlan({ ...noBaseline, scenarios: [{ ...scenario, steps: [{ kind: "invoke-contract", operationId: "missing", input: null }] }] });
    expect(unknown.groups).toHaveLength(0);
    const agent = selectE2EExecutionPlan({ ...noBaseline, scenarios: [{ ...scenario, steps: [{ kind: "agent", goal: "Tap", maxActions: 1 }] }] });
    expect(agent.groups).toHaveLength(0);
    const nativeSnapshot = snapshot([source("mobile/package.json", JSON.stringify({ name: "mobile", dependencies: { "react-native": "1" } })), source("mobile/android/app/src/main/AndroidManifest.xml", '<manifest package="acme.app"><application/></manifest>')]);
    const nativeDiscovery = inspectE2ERepository(nativeSnapshot, candidate);
    const native = nativeDiscovery.inspection.proposedTargets[0]!;
    const nativePolicy = { ...policy, baselineScenarioIds: [], targets: [native] };
    const tap = selectE2EExecutionPlan({ ...noBaseline, sourceSnapshot: nativeSnapshot, candidateDigest: candidate.digest, policy: nativePolicy, selectedTargetIds: [native.targetId], scenarios: [{ ...scenario, requestedTargetIds: [native.targetId], steps: [{ kind: "tap", testId: "native-export" }], assertions: [{ kind: "visible", testId: "native-success", equals: true }] }] });
    const direct = selectE2EExecutionPlan({ ...noBaseline, scenarios: [{ ...scenario, steps: [{ kind: "invoke-contract", operationId: operation, input: null }] }] });
    expect(tap.groups).toHaveLength(0);
    expect(direct.groups).toHaveLength(1);
  });

  it("rejects forged candidate/tree and normalized-source traversal at all planner inputs", () => {
    expect(() => inspectE2ERepository({ ...snap, candidate: { ...candidate, digest: "e".repeat(64) }, treeSha: "f".repeat(40) }, candidate)).toThrow();
    const unsafeSnapshot = { ...snap, sources: [...snap.sources, source("../outside.ts", "export const execute = () => true")], treePaths: [...snap.treePaths, "../outside.ts"] };
    expect(() => selectE2EExecutionPlan({ ...base, policy: { ...policy, baselineScenarioIds: [] }, sourceSnapshot: unsafeSnapshot })).toThrow();
  });

  it("normalizes only source-derived recipes, account assignments and complete graph identities", () => {
    const forged = { ...discovery.inspection, applications: [{ ...discovery.inspection.applications[0]!, recipe: { schemaVersion: 1, recipeDigest: "d".repeat(64), build: [], launch: { kind: "service", start: { program: "node", args: ["-e", "process.exit(0)"], cwd: "app", timeoutMs: 1000, env: {} }, health: { path: "/", expectedStatus: 200 } }, serviceProfileIds: [], seedProfileId: "fake", accountProfileIds: ["elsewhere"], allowedOrigins: ["elsewhere"] } }], proposedScenarios: [{ ...scenario, accountProfileId: "elsewhere" }] } as never;
    expect(() => proposeE2ESetup({ inspection: forged, snapshot: snap, expectedCandidate: candidate })).toThrow();
  });

  it("does not treat arbitrary source files as registered mock boundaries", () => {
    const plan = selectE2EExecutionPlan({ ...base, policy: { ...policy, baselineScenarioIds: [] }, scenarios: [{ ...scenario, requiredRealComponentIds: ["bank-api"] }], mockableComponents: [{ componentId: "bank-api", requestedTargetId: web.targetId, kind: "api", sourceRefs: [{ path: moduleFile.path, sha256: moduleFile.sha256 }] }] });
    expect(plan.mocks).toHaveLength(0);
    expect(plan.unavailableCriteria.length).toBe(1);
    expect(plan.criteria[0]?.requiredRealComponentIds).toEqual(["bank-api"]);
  });

  it("supports repository-root cwd, discovers standalone native mobile metadata, and does not guess missing platforms", () => {
    const root = snapshot([source("package.json", JSON.stringify({ name: "app", scripts: { start: "vite" } }))]);
    expect(() => inspectE2ERepository(root, candidate)).not.toThrow();
    const native = snapshot([source("android/app/src/main/AndroidManifest.xml", '<manifest package="acme.app"><application/></manifest>'), source("android/app/build.gradle", 'plugins { id "com.android.application" }'), source("ios/App/Info.plist", "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>acme.ios</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>")]);
    expect(inspectE2ERepository(native, candidate).inspection.proposedTargets.filter((item) => item.kind === "mobile").map((item) => item.os).sort()).toEqual(["android", "ios"]);
    const noPlatform = snapshot([source("package.json", JSON.stringify({ name: "mobile", dependencies: { "react-native": "1" } }))]);
    expect(inspectE2ERepository(noPlatform, candidate).inspection.proposedTargets).toHaveLength(0);
  });

  it("keeps same-named workspace packages as distinct discovered applications", () => {
    const workspace = snapshot([
      source("apps/one/package.json", JSON.stringify({ name: "@acme/service", scripts: { start: "node one.js" } })),
      source("apps/two/package.json", JSON.stringify({ name: "@acme/service", scripts: { start: "node two.js" } })),
    ]);
    const applications = inspectE2ERepository(workspace, candidate).inspection.applications;
    expect(new Set(applications.map((item) => item.applicationId)).size).toBe(2);
  });

  it("uses a safe export-subpath codec and full evidence-aware case identity", () => {
    const subpath = discovery.portableOperations.find((item) => item.exportName === "./orders")!;
    expect(subpath.operationId).toMatch(/^[A-Za-z0-9._:-]+$/);
    const identity = { scenario, requestedTargetId: web.targetId, effectiveTargetId: `contract-${web.targetId}`, accountProfileId: scenario.accountProfileId, minimumEvidence: scenario.minimumEvidence, requiredRealComponentIds: [], agentId: "default", repeat: 0, assertionDigest: sha(JSON.stringify(scenario.assertions)) };
    expect(portableE2ECaseId(identity)).not.toBe(portableE2ECaseId({ ...identity, minimumEvidence: "runtime" }));
    expect(portableE2EUpstreamTestId(identity)).not.toBe(portableE2EUpstreamTestId({ ...identity, accountProfileId: "viewer" }));
  });
});
