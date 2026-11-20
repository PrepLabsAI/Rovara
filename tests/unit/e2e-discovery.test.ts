import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, createCandidateManifest, inferNodeWebRecipe, verifyE2ESetupProposal, type E2EPolicy, type E2EScenario, type E2ESourceSnapshot, createE2EOpenApiFixtureDescriptor } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup, type VerifiedE2ESourceSnapshot } from "../../packages/broker/src/e2e/discovery.js";
import { portableE2ECaseId, portableE2EUpstreamTestId, selectE2EExecutionPlan as selectRawE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { withTestPortableApproval } from "../e2e-test-approval.js";
import { githubRepositoryApi } from "../../packages/cli/src/setup/project-files.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const source = "openapi: 3.0.0\n";
const snapshot: VerifiedE2ESourceSnapshot = {
  candidate: createCandidateManifest([{ repositoryId: "acme/shop", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]),
  commitSha: "a".repeat(40), treeSha: "b".repeat(40), treePaths: ["api/openapi.yaml"],
  sources: [{ path: "api/openapi.yaml", sha256: hash(source), bytes: Buffer.from(source), kind: "blob" }],
  treeComplete: true,
};
const inspection = inspectE2ERepository(snapshot, snapshot.candidate).inspection;

describe("source-backed E2E setup proposal", () => {
  it("accepts only source refs whose bytes belong to the immutable candidate snapshot", () => {
    expect(proposeE2ESetup({ inspection, snapshot, expectedCandidate: snapshot.candidate })).toMatchObject({ candidateDigest: snapshot.candidate.digest, state: "proposed", targets: inspection.proposedTargets });
    expect(() => proposeE2ESetup({ inspection: { ...inspection, candidateDigest: "c".repeat(64) }, snapshot, expectedCandidate: snapshot.candidate })).toThrow(/candidate/);
    expect(() => proposeE2ESetup({ inspection: { ...inspection, sources: [{ path: "api/openapi.yaml", sha256: "d".repeat(64) }] }, snapshot, expectedCandidate: snapshot.candidate })).toThrow(/hash|source-derived/);
  });

  it("refuses fabricated paths and incomplete trees, while preserving a mock-ready connection gap", () => {
    expect(() => proposeE2ESetup({ inspection: { ...inspection, applications: [{ ...inspection.applications[0]!, sourcePaths: ["missing.yaml"] }] }, snapshot, expectedCandidate: snapshot.candidate })).toThrow(/source|path/);
    expect(() => proposeE2ESetup({ inspection, snapshot: { ...snapshot, treeComplete: false } as never, expectedCandidate: snapshot.candidate })).toThrow(/complete|truncated/);
    expect(proposeE2ESetup({ inspection, snapshot, expectedCandidate: snapshot.candidate }).missingInputs[0]?.disposition).toBe("mock-substitutable");
  });
});

describe("immutable four-platform discovery", () => {
  it("maps mixed monorepo manifests to distinct platform targets and source-bound portable exports", async () => {
    const contents: Record<string, string> = {
      "apps/web/package.json": JSON.stringify({ name: "web-app", dependencies: { react: "1" }, scripts: { start: "vite" }, exports: { ".": "./src/index.js" } }),
      "apps/web/src/index.js": "export const run = () => true",
      "apps/api/package.json": JSON.stringify({ name: "api-app", dependencies: { express: "1" }, scripts: { start: "node api.js" }, exports: { ".": "./src/index.js" } }),
      "apps/api/src/index.js": "export const run = () => true",
      "apps/api/openapi.yaml": "openapi: 3.0.0",
      "apps/mobile/package.json": JSON.stringify({ name: "mobile-app", dependencies: { "react-native": "1" }, scripts: { start: "metro" }, exports: { ".": "./src/index.js" } }),
      "apps/mobile/src/index.js": "export const run = () => true",
      "apps/mobile/android/app/src/main/AndroidManifest.xml": '<manifest package="com.example.mobile"><application /></manifest>',
      "apps/mobile/ios/Info.plist": "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>com.example.mobile</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>",
      "apps/desktop/package.json": JSON.stringify({ name: "desktop-app", dependencies: { electron: "1" }, scripts: { start: "electron ." }, exports: { ".": "./src/main.js" } }),
      "apps/desktop/src/main.js": "export const run = () => true",
      "apps/native/Windows/App.csproj": "<Project />",
      "apps/native/macOS/App/Info.plist": "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>fixture.mac</string><key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array></dict></plist>",
      "apps/native/macOS/App.xcodeproj/project.pbxproj": `// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; targets = (DDDDDDDDDDDDDDDDDDDDDDDD,); };
DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; productType = "com.apple.product-type.application"; };
BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (EEEEEEEEEEEEEEEEEEEEEEEE,); };
EEEEEEEEEEEEEEEEEEEEEEEE = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = macosx; SUPPORTED_PLATFORMS = macosx; INFOPLIST_FILE = "App/Info.plist"; PRODUCT_BUNDLE_IDENTIFIER = fixture.mac; }; };
}; rootObject = AAAAAAAAAAAAAAAAAAAAAAAA; }`,
      "apps/native/linux/CMakeLists.txt": "project(native)",
    };
    const sources = Object.entries(contents).map(([path, text]) => ({ path, sha256: hash(text), bytes: Buffer.from(text), kind: "blob" as const }));
    const mixed: VerifiedE2ESourceSnapshot = {
      candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true, treePaths: sources.map((source) => source.path), sources,
    };
    const discovered = inspectE2ERepository(mixed, mixed.candidate);
    expect(discovered.inspection.proposedTargets.map((item) => item.kind)).toEqual(["web", "api", "mobile", "mobile", "desktop", "desktop", "desktop", "desktop"]);
    expect(discovered.inspection.proposedTargets.filter((item) => item.kind === "mobile").map((item) => item.os)).toEqual(["android", "ios"]);
    expect(discovered.inspection.proposedTargets.filter((item) => item.kind === "desktop").map((item) => item.os).sort()).toEqual(["linux", "linux", "macos", "windows"]);
    expect(discovered.inspection.applications.find((item) => item.applicationId === "api-app")?.sourcePaths).toContain("apps/api/openapi.yaml");
    expect(discovered.inspection.dependencyEdges.some((edge) => edge.toComponentId.startsWith("api-schema-") && edge.sourcePaths.includes("apps/api/openapi.yaml"))).toBe(true);
    expect(discovered.portableOperations.every((item) => item.sourceRefs.every((ref) => sources.some((source) => source.path === ref.path && source.sha256 === ref.sha256)))).toBe(true);
    expect(discovered.inspection.proposedScenarios).toEqual([]);
    expect(discovered.inspection.missingInputs.some((item) => item.kind === "business-rule")).toBe(false);
    expect(proposeE2ESetup({ inspection: discovered.inspection, snapshot: mixed, expectedCandidate: mixed.candidate }).state).toBe("proposed");
  });

  it("marks conflicting start and dev recipes as targeted blocking input", () => {
    const text = JSON.stringify({ name: "shop", scripts: { start: "serve", dev: "vite" }, exports: { ".": "./src/index.js" } });
    const code = "export const run = () => true";
    const files = [
      { path: "package.json", sha256: hash(text), bytes: Buffer.from(text), kind: "blob" as const },
      { path: "src/index.js", sha256: hash(code), bytes: Buffer.from(code), kind: "blob" as const },
    ];
    const conflicted: VerifiedE2ESourceSnapshot = { candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true, treePaths: files.map((item) => item.path), sources: files };
    const result = inspectE2ERepository(conflicted, conflicted.candidate);
    expect(result.inspection.applications[0]?.recipe).toBeNull();
    expect(result.inspection.missingInputs[0]).toMatchObject({ kind: "runtime", disposition: "blocking" });
  });
});

describe("qualified web/API targets and Node launch recipes", () => {
  const PROFILE = "linux-arm64-web-api-v1";
  const snapshotOf = (contents: Record<string, string>, extraTreePaths: string[] = []): VerifiedE2ESourceSnapshot => {
    const sources = Object.entries(contents).map(([path, text]) => ({ path, sha256: hash(text), bytes: Buffer.from(text), kind: "blob" as const }));
    return { candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true, treePaths: [...sources.map((item) => item.path), ...extraTreePaths], sources };
  };
  const web = (scripts: Record<string, string>, extra: Record<string, string> = {}, extraTreePaths: string[] = []) =>
    snapshotOf({ "package.json": JSON.stringify({ name: "shop-web", scripts }), ...extra }, extraTreePaths);
  const propose = (source: VerifiedE2ESourceSnapshot, readyProfiles: readonly { kind: "web" | "api"; profileId: string }[]) =>
    proposeE2ESetup({ inspection: inspectE2ERepository(source, source.candidate).inspection, snapshot: source, expectedCandidate: source.candidate, readyProfiles });

  it("assigns the READY profile to a web target and keeps the placeholder when none is ready", () => {
    const source = web({ start: "node server.js" });
    expect(propose(source, [{ kind: "web", profileId: PROFILE }]).targets.map((item) => item.runtimeProfileId)).toEqual([PROFILE]);
    expect(propose(source, []).targets.map((item) => item.runtimeProfileId)).toEqual(["web-phase-unavailable"]);
    expect(propose(source, [{ kind: "api", profileId: PROFILE }]).targets.map((item) => item.runtimeProfileId)).toEqual(["web-phase-unavailable"]);
  });

  it("assigns the READY api profile to an API target only", () => {
    const source = snapshotOf({ "package.json": JSON.stringify({ name: "shop-api", dependencies: { express: "1" }, scripts: { start: "node s.js" } }) });
    expect(propose(source, [{ kind: "web", profileId: "other" }, { kind: "api", profileId: PROFILE }]).targets.map((item) => item.runtimeProfileId)).toEqual([PROFILE]);
  });

  it("leaves mobile, desktop and native targets on their placeholders", () => {
    const source = snapshotOf({ "package.json": JSON.stringify({ name: "desk", dependencies: { electron: "1" }, scripts: { start: "electron ." } }) });
    expect(propose(source, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]).targets.map((item) => item.runtimeProfileId)).toEqual(["electron-phase-unavailable"]);
  });

  it("round-trips a ready-profile proposal through independent verification and rejects a placeholder that does not match the target kind", () => {
    const source = web({ start: "node server.js" });
    const proposal = propose(source, [{ kind: "web", profileId: PROFILE }]);
    expect(verifyE2ESetupProposal(proposal, source, source.candidate)).toEqual(proposal);
    const forged = { ...proposal, targets: proposal.targets.map((item) => ({ ...item, runtimeProfileId: "ios-phase-unavailable" })) };
    expect(() => verifyE2ESetupProposal(forged, source, source.candidate)).toThrow();
  });

  it("infers build commands and a start recipe from a root package with a start script and a lockfile", () => {
    const source = web({ start: "node server.js", build: "tsc" }, { "package-lock.json": "{}" });
    const recipe = inferNodeWebRecipe(source)!;
    expect(recipe.build.map((item) => [item.program, ...item.args])).toEqual([["npm", "ci"], ["npm", "run", "build"]]);
    expect(recipe.launch).toMatchObject({ kind: "service", start: { program: "npm", args: ["start"], cwd: ".", env: { PORT: "4317" } }, health: { path: "/", expectedStatus: 200 } });
    const { recipeDigest, ...body } = recipe;
    expect(recipeDigest).toBe(hash(canonicalJson(body)));
    expect(inspectE2ERepository(source, source.candidate).inspection.applications[0]?.recipe).toEqual(recipe);
  });

  it("omits the build step when there is no build script and accepts a lockfile that is only in the tree inventory", () => {
    const recipe = inferNodeWebRecipe(web({ start: "node server.js" }, {}, ["package-lock.json"]))!;
    expect(recipe.build.map((item) => [item.program, ...item.args])).toEqual([["npm", "ci"]]);
  });

  it("returns null without a lockfile, without a start script, or for a nested package", () => {
    expect(inferNodeWebRecipe(web({ start: "node server.js" }))).toBeNull();
    expect(inferNodeWebRecipe(web({ build: "tsc" }, { "package-lock.json": "{}" }))).toBeNull();
    expect(inferNodeWebRecipe(snapshotOf({ "apps/web/package.json": JSON.stringify({ name: "n", scripts: { start: "x" } }), "apps/web/package-lock.json": "{}" }))).toBeNull();
    expect(inspectE2ERepository(web({ start: "node server.js" }), snapshot.candidate).inspection.applications[0]?.recipe?.build).toEqual([]);
  });

  it("returns the explicit project recipe unchanged, ahead of inference", () => {
    const text = readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8");
    const explicit = (JSON.parse(text) as { agentx: { e2e: { recipe: { recipeDigest: string } } } }).agentx.e2e.recipe;
    const source = snapshotOf({ "package.json": text, "package-lock.json": "{}" });
    expect(inferNodeWebRecipe(source)).toEqual(explicit);
    expect(inferNodeWebRecipe(source)?.recipeDigest).toBe(explicit.recipeDigest);
  });

  describe("inferNodeWebRecipe agrees with discovery", () => {
    const rootRecipe = (source: VerifiedE2ESourceSnapshot) => inspectE2ERepository(source, source.candidate).inspection.applications
      .find((item) => (item.kind === "web" || item.kind === "api") && item.sourcePaths[0] === "package.json")?.recipe ?? null;
    const fixtureText = readFileSync(new URL("../fixtures/e2e-web-api-app/package.json", import.meta.url), "utf8");
    const lock = { "package-lock.json": "{}" };
    const cases: Array<[string, VerifiedE2ESourceSnapshot, boolean]> = [
      ["start and dev scripts", web({ start: "node s.js", dev: "vite" }, lock), false],
      ["an Electron root package", snapshotOf({ "package.json": JSON.stringify({ name: "desk", dependencies: { electron: "1" }, scripts: { start: "electron ." } }), ...lock }), false],
      ["an Expo root package", snapshotOf({ "package.json": JSON.stringify({ name: "mob", dependencies: { expo: "1" }, scripts: { start: "expo start" } }), ...lock }), false],
      ["a malformed project contract", snapshotOf({ "package.json": JSON.stringify({ name: "shop-web", scripts: { start: "x" }, agentx: { e2e: { schemaVersion: "bad" } } }), ...lock }), false],
      ["a native sidecar beside the package", snapshotOf({ "package.json": JSON.stringify({ name: "shop-web", scripts: { start: "x" } }), ".agentx/e2e-application.json": "{}", ...lock }), false],
      ["an explicit project contract", snapshotOf({ "package.json": fixtureText, ...lock }), true],
      ["an inferred recipe", web({ start: "node s.js", build: "tsc" }, lock), true],
    ];
    it.each(cases)("returns the discovered recipe for %s", (_name, source, expectRecipe) => {
      const discovered = rootRecipe(source);
      expect(inferNodeWebRecipe(source)).toEqual(discovered);
      expect(discovered !== null).toBe(expectRecipe);
    });
  });

  describe("verification of a stored READY profile", () => {
    const monorepo = () => {
      const pkg = (name: string) => JSON.stringify({ name, scripts: { start: "node s.js" } });
      const contents = { "apps/a/package.json": pkg("shop-a"), "apps/b/package.json": pkg("shop-b") };
      const sources = Object.entries(contents).map(([path, text]) => ({ path, sha256: hash(text), bytes: Buffer.from(text), kind: "blob" as const }));
      return { candidate: snapshot.candidate, commitSha: snapshot.commitSha, treeSha: snapshot.treeSha, treeComplete: true as const, treePaths: sources.map((item) => item.path), sources } as VerifiedE2ESourceSnapshot;
    };
    const proposed = () => {
      const source = monorepo();
      return { source, proposal: proposeE2ESetup({ inspection: inspectE2ERepository(source, source.candidate).inspection, snapshot: source, expectedCandidate: source.candidate,
        readyProfiles: [{ kind: "web", profileId: "linux-arm64-web-api-v1" }] }) };
    };
    const withProfiles = (proposal: ReturnType<typeof proposed>["proposal"], profiles: string[]) =>
      ({ ...proposal, targets: proposal.targets.map((item, index) => ({ ...item, runtimeProfileId: profiles[index]! })) });

    it("accepts every web target on the qualified profile", () => {
      const { source, proposal } = proposed();
      expect(proposal.targets.map((item) => item.runtimeProfileId)).toEqual(["linux-arm64-web-api-v1", "linux-arm64-web-api-v1"]);
      expect(verifyE2ESetupProposal(proposal, source, source.candidate)).toEqual(proposal);
    });

    it("rejects a profile that is not the qualified web/API profile", () => {
      const { source, proposal } = proposed();
      expect(() => verifyE2ESetupProposal(withProfiles(proposal, ["rogue-profile-v1", "rogue-profile-v1"]), source, source.candidate)).toThrow();
    });

    it("rejects mixed profiles across web targets", () => {
      const { source, proposal } = proposed();
      expect(() => verifyE2ESetupProposal(withProfiles(proposal, ["linux-arm64-web-api-v1", "rogue-profile-v1"]), source, source.candidate)).toThrow();
      expect(() => verifyE2ESetupProposal(withProfiles(proposal, ["linux-arm64-web-api-v1", "web-phase-unavailable"]), source, source.candidate)).toThrow();
    });
  });
});

describe("discovery inputs, source bytes and case identity", () => {
  const selectE2EExecutionPlan = (input: Parameters<typeof selectRawE2EExecutionPlan>[0]) => selectRawE2EExecutionPlan(withTestPortableApproval(input));
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

describe("planned inputs, OpenAPI fixtures and base64 blobs", () => {
  const selectE2EExecutionPlan = (input: Parameters<typeof selectRawE2EExecutionPlan>[0]) => selectRawE2EExecutionPlan(withTestPortableApproval(input));
  const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
  const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: digest(text), kind: "blob" as const });
  const candidate = createCandidateManifest([{ repositoryId: "acme/orders", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const snapshot = (sources: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((item) => item.path), sources });
  const validOpenApi = {
    openapi: "3.1.0", info: { title: "Orders", version: "1" },
    paths: { "/orders": { post: { operationId: "createOrder", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] } } } }, responses: { "201": { description: "created", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } } }, required: ["items"] } } } } } } } },
  };
  const packageAndExport = (root: string, name: string) => [
    file(`${root}/package.json`, JSON.stringify({ name, exports: { ".": "./src/index.ts" } })),
    file(`${root}/src/index.ts`, "export const execute = (input: unknown) => input"),
  ];
  const makeScenario = (targetId: string, operationId: string, delta: Partial<E2EScenario> = {}): E2EScenario => ({
    scenarioId: "orders", requirementId: "orders-read", requestedTargetIds: [targetId], required: true, accountProfileId: "synthetic",
    minimumEvidence: "mock-contract", requiredRealComponentIds: [], steps: [{ kind: "invoke-contract", operationId, input: { orderIds: ["a1", "a2"], tenant: "acme" } }],
    assertions: [
      { kind: "state", probeId: "result", equals: { orderIds: ["a1", "a2"], tenant: "acme" }, pollTimeoutMs: 1000 },
      { kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: { orderIds: ["a1", "a2"], tenant: "acme" } },
    ], ...delta,
  });

  it("plans bounded JSON input and each supported assertion despite unchanged real evidence floors", () => {
    const sources = [...packageAndExport("app", "app"), file("app/openapi.json", JSON.stringify(validOpenApi))];
    const sourceSnapshot = snapshot(sources);
    const discovery = inspectE2ERepository(sourceSnapshot, candidate);
    const target = discovery.inspection.proposedTargets[0]!;
    const edge = discovery.inspection.dependencyEdges[0]!;
    const scenario = makeScenario(target.targetId, discovery.portableOperations[0]!.operationId, { minimumEvidence: "runtime", requiredRealComponentIds: [edge.toComponentId] });
    const plan = selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "c".repeat(64),
      policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
      scenarios: [scenario], selectedTargetIds: [target.targetId], sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
      mockableComponents: [{ componentId: edge.toComponentId, requestedTargetId: target.targetId, kind: "api", sourceRefs: [{ path: "app/openapi.json", sha256: sources[2]!.sha256 }] }],
    });
    expect(plan.groups.flatMap((group) => group.expectedCases)).toHaveLength(1);
    expect(plan.groups[0]?.expectedCases[0]).toMatchObject({ assertionDigests: scenario.assertions.map((item) => digest(canonicalJson([item]))) });
    expect(plan.criteria[0]).toMatchObject({ minimumEvidence: "runtime", requiredRealComponentIds: [edge.toComponentId], expectedCaseIds: [plan.groups[0]!.expectedCases[0]!.caseId] });
    expect(plan.mocks).toHaveLength(1);
    const externalFloor = selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "c".repeat(64),
      policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
      scenarios: [makeScenario(target.targetId, discovery.portableOperations[0]!.operationId, { minimumEvidence: "external-live" })], selectedTargetIds: [target.targetId], sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
    });
    expect(externalFloor.criteria[0]?.minimumEvidence).toBe("external-live");
    expect(externalFloor.groups.flatMap((group) => group.expectedCases)).toHaveLength(1);
    const duplicateScenario = { ...scenario, assertions: [scenario.assertions[0]!, scenario.assertions[0]!] };
    const duplicateAssertions = selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "c".repeat(64),
      policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
      scenarios: [duplicateScenario], selectedTargetIds: [target.targetId], sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
    });
    expect(duplicateAssertions.groups.flatMap((group) => group.expectedCases)).toHaveLength(1);
    const assertionDigests = duplicateAssertions.groups[0]?.expectedCases[0]?.assertionDigests;
    expect(assertionDigests?.[0]).toBe(assertionDigests?.[1]);
  });

  it("accepts only a supported bounded OpenAPI operation/response fixture and binds its exact digest to the group", () => {
    const schema = file("app/openapi.json", JSON.stringify(validOpenApi));
    const sources = [...packageAndExport("app", "app"), schema];
    const sourceSnapshot = snapshot(sources);
    const discovery = inspectE2ERepository(sourceSnapshot, candidate);
    const target = discovery.inspection.proposedTargets[0]!;
    const component = discovery.inspection.dependencyEdges[0]!.toComponentId;
    const plan = selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "d".repeat(64),
      policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
      scenarios: [makeScenario(target.targetId, discovery.portableOperations[0]!.operationId, { requiredRealComponentIds: [component] })], selectedTargetIds: [target.targetId], sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
      mockableComponents: [{ componentId: component, requestedTargetId: target.targetId, kind: "api", sourceRefs: [{ path: schema.path, sha256: schema.sha256 }] }],
    });
    expect(plan.mocks).toHaveLength(1);
    expect(plan.groups[0]?.mockManifestDigest).toBe(digest(canonicalJson(plan.mocks)));

    for (const malformed of [
      { openapi: "nonsense", paths: { garbage: true } },
      { openapi: "3.1.0", paths: [] },
      { openapi: "3.1.0", paths: { "/orders": { get: { responses: {} } } } },
      { openapi: "3.1.0", paths: { "/orders": { get: { responses: { "200": { description: "ok" } } } } } },
      {
        openapi: "3.1.0",
        info: { title: "Orders", version: "1" },
        paths: {
          "/orders": {
            get: {
              operationId: "listOrders",
              responses: {
                "200": {
                  description: "ok",
                  content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } },
                },
              },
            },
          },
        },
      },
    ]) {
      const badSchema = file("app/openapi.json", JSON.stringify(malformed));
      const badSnapshot = snapshot([...packageAndExport("app", "app"), badSchema]);
      const badDiscovery = inspectE2ERepository(badSnapshot, candidate);
      const badTarget = badDiscovery.inspection.proposedTargets[0]!;
      const badComponent = badDiscovery.inspection.dependencyEdges[0]!.toComponentId;
      const badPlan = selectE2EExecutionPlan({
        candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: badSnapshot, planDigest: "e".repeat(64),
        policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [badTarget], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
        scenarios: [makeScenario(badTarget.targetId, badDiscovery.portableOperations[0]!.operationId, { requiredRealComponentIds: [badComponent] })], selectedTargetIds: [badTarget.targetId], sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
        mockableComponents: [{ componentId: badComponent, requestedTargetId: badTarget.targetId, kind: "api", sourceRefs: [{ path: badSchema.path, sha256: badSchema.sha256 }] }],
      });
      expect(badPlan.mocks).toHaveLength(0);
      expect(badPlan.unavailableCriteria).toHaveLength(1);
      expect(badPlan.groups.flatMap((group) => group.expectedCases)).toHaveLength(1);
    }
    const wrongAssociation = selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "7".repeat(64),
      policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
      scenarios: [makeScenario(target.targetId, discovery.portableOperations[0]!.operationId, { requiredRealComponentIds: [component] })], selectedTargetIds: [target.targetId], sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
      mockableComponents: [{ componentId: component, requestedTargetId: target.targetId, kind: "api", sourceRefs: [{ path: "app/unrelated.json", sha256: schema.sha256 }] }],
    });
    expect(wrongAssociation.mocks).toHaveLength(0);
    expect(wrongAssociation.unavailableCriteria).toHaveLength(1);
  });

  it("binds one- and two-target groups to their exact deduplicated mock fixture sets", () => {
    const appRoots = ["apps/one", "apps/two"];
    const sources = appRoots.flatMap((root, index) => [
      ...packageAndExport(root, `app-${index + 1}`),
      file(`${root}/openapi.json`, JSON.stringify(validOpenApi)),
    ]);
    const sourceSnapshot = snapshot(sources);
    const discovery = inspectE2ERepository(sourceSnapshot, candidate);
    const targets = discovery.inspection.proposedTargets;
    const policy = { schemaVersion: 1 as const, policyRevision: 1, executionMode: "trusted-scenarios" as const, baselineScenarioIds: [], targets, defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected" as const, modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
    const scenarios = targets.map((target, index) => {
      const operation = discovery.portableOperations.find((candidateOperation) => candidateOperation.applicationId === target.applicationId)!;
      const component = discovery.inspection.dependencyEdges.find((edge) => edge.fromApplicationId === target.applicationId)!.toComponentId;
      return makeScenario(target.targetId, operation.operationId, { scenarioId: `orders-${index}`, requirementId: `orders-${index}`, required: false, requiredRealComponentIds: [component] });
    });
    const planFor = (selectedTargetIds: string[]) => selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "f".repeat(64), policy, scenarios, selectedTargetIds,
      sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
      mockableComponents: targets.map((target) => ({ componentId: discovery.inspection.dependencyEdges.find((edge) => edge.fromApplicationId === target.applicationId)!.toComponentId, requestedTargetId: target.targetId, kind: "api" as const, sourceRefs: [{ path: `${appRoots[targets.indexOf(target)]}/openapi.json`, sha256: sources.find((source) => source.path === `${appRoots[targets.indexOf(target)]}/openapi.json`)!.sha256 }] })),
    });
    const oneTarget = planFor([targets[0]!.targetId]);
    const twoTargets = planFor(targets.map((target) => target.targetId));
    expect(oneTarget.groups).toHaveLength(1);
    expect(oneTarget.mocks).toHaveLength(1);
    expect(oneTarget.groups[0]?.mockManifestDigest).toBe(digest(canonicalJson(oneTarget.mocks)));
    expect(twoTargets.groups).toHaveLength(1);
    expect(twoTargets.groups[0]?.targetIds).toHaveLength(2);
    expect(twoTargets.mocks).toHaveLength(2);
    expect(twoTargets.groups[0]?.mockManifestDigest).toBe(digest(canonicalJson(twoTargets.mocks)));
  });

  it("parses actual iOS identifiers and reports unresolved metadata without duplicate targets", () => {
    const ios = snapshot([
      file("apps/one/ios/App/Info.plist", "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>acme.one</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>"),
      file("apps/two/ios/App/Info.plist", "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>acme.two</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>"),
    ]);
    const inspection = inspectE2ERepository(ios, candidate).inspection;
    expect(inspection.proposedTargets.filter((target) => target.kind === "mobile").map((target) => target.appId).sort()).toEqual(["acme.one", "acme.two"]);
    expect(new Set(inspection.applications.map((app) => app.applicationId)).size).toBe(2);
    expect(new Set(inspection.proposedTargets.map((target) => target.targetId)).size).toBe(2);
    expect(proposeE2ESetup({ inspection, snapshot: ios, expectedCandidate: candidate }).state).toBe("proposed");

    const unresolved = snapshot([file("ios/App/project.pbxproj", "PRODUCT_BUNDLE_IDENTIFIER = $(PRODUCT_BUNDLE_IDENTIFIER);\n")]);
    const unknown = inspectE2ERepository(unresolved, candidate).inspection;
    expect(unknown.proposedTargets).toHaveLength(0);
    expect(unknown.missingInputs.some((item) => item.disposition === "blocking" && item.kind === "target-selection")).toBe(true);
  });

  it("accepts bounded wrapped GitHub base64 while retaining Git blob verification", async () => {
    const bytes = Buffer.from('{"name":"wrapped"}');
    const blobSha = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
    const encoded = bytes.toString("base64");
    const wrapped = encoded.match(/.{1,4}/g)!.join("\n") + "\n";
    const responses = [
      { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } },
      { sha: "b".repeat(40), truncated: false, tree: [{ path: "package.json", mode: "100644", type: "blob", sha: blobSha, size: bytes.length }] },
      { sha: blobSha, encoding: "base64", size: bytes.length, content: wrapped },
    ];
    const fetcher = (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch;
    const result = await githubRepositoryApi(fetcher).snapshot("local-fixture", "acme/orders", ["package.json"], "main");
    expect(Buffer.from(result.sources[0]!.bytes).toString()).toBe(bytes.toString());
  });

  it("rejects malformed and excessive base64 wrapping", async () => {
    const bytes = Buffer.from('{"name":"wrapped"}');
    const blobSha = createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
    for (const content of ["@@@=", `${bytes.toString("base64")}\n${" ".repeat(16_385)}`]) {
      const responses = [
        { sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } },
        { sha: "b".repeat(40), truncated: false, tree: [{ path: "package.json", mode: "100644", type: "blob", sha: blobSha, size: bytes.length }] },
        { sha: blobSha, encoding: "base64", size: bytes.length, content },
      ];
      const fetcher = (async () => new Response(JSON.stringify(responses.shift()), { status: 200 })) as typeof fetch;
      await expect(githubRepositoryApi(fetcher).snapshot("local-fixture", "acme/orders", ["package.json"], "main")).rejects.toThrow(/source bytes/);
    }
  });
});

describe("OpenAPI fixture validation and native project ownership", () => {
  const selectE2EExecutionPlan = (input: Parameters<typeof selectRawE2EExecutionPlan>[0]) => selectRawE2EExecutionPlan(withTestPortableApproval(input));
  const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: digest(text), kind: "blob" as const });
  const candidate = createCandidateManifest([{ repositoryId: "fixture/fix3", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const snapshot = (sources: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((source) => source.path), sources });
  const packageFiles = (root = "apps/mobile", name = "@fixture/mobile") => [
    file(`${root}/package.json`, JSON.stringify({ name, private: true, workspaces: ["ios/*", "android/*"], dependencies: { "react-native": "1" } })),
  ];
  const plist = (id: string) => `<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>`;
  const manifest = (id: string) => `<manifest package="${id}"><application /></manifest>`;
  const apiSources = (schema: unknown, extraPathItem: Record<string, unknown> = {}, responses?: Record<string, unknown>) => [
    file("app/package.json", JSON.stringify({ name: "app", exports: { ".": "./src/index.ts" } })),
    file("app/src/index.ts", "export const execute = (input: unknown) => input"),
    file("app/openapi.json", JSON.stringify({ openapi: "3.1.0", info: { title: "fixture", version: "1" }, paths: { "/x": {
      ...extraPathItem,
      post: { operationId: "createX", requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } } },
        responses: responses ?? { "201": { description: "created", content: { "application/json": { schema } } } },
    } } } })),
  ];
  const makeScenario = (targetId: string, operationId: string, componentId: string): E2EScenario => ({
    scenarioId: "create", requirementId: "create", requestedTargetIds: [targetId], required: true, accountProfileId: "synthetic",
    minimumEvidence: "mock-contract", requiredRealComponentIds: [componentId],
    steps: [{ kind: "invoke-contract", operationId, input: { name: "example" } }],
    assertions: [{ kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: { name: "example" } }],
  });
  const planApi = (sources: ReturnType<typeof file>[]) => {
    const sourceSnapshot = snapshot(sources);
    const found = inspectE2ERepository(sourceSnapshot, candidate);
    const target = found.inspection.proposedTargets[0]!;
    const component = found.inspection.dependencyEdges.find((edge) => edge.fromApplicationId === target.applicationId)!.toComponentId;
    const source = sources.find((item) => /openapi\.json$/.test(item.path))!;
    return selectE2EExecutionPlan({
      candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot, planDigest: "c".repeat(64),
      policy: { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [], targets: [target], defaultSandboxProfileId: "sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } },
      scenarios: [makeScenario(target.targetId, found.portableOperations[0]!.operationId, component)], selectedTargetIds: [target.targetId],
      sandboxAvailability: { targetId: "default-sandbox", profileId: "sandbox", connection: "connected", approval: "approved", qualification: "qualified", authorizationRevision: "auth1" }, runtimeAvailability: [],
      mockableComponents: [{ componentId: component, requestedTargetId: target.targetId, kind: "api", sourceRefs: [{ path: source.path, sha256: source.sha256 }] }],
    });
  };

  it("does not register impossible or unsupported OpenAPI fixtures", () => {
    for (const schema of [
      { type: "integer", minimum: 0.1, maximum: 0.9 },
      { type: "integer", enum: [1], minimum: 2 },
      { type: "string", enum: ["x"], minLength: 2 },
      { type: "object", properties: {}, required: ["toString"], additionalProperties: false },
      { type: "object", properties: { toString: { type: "string" } }, required: ["toString"], additionalProperties: false, patternProperties: { "^x": { type: "string" } } },
    ]) {
      const plan = planApi(apiSources(schema));
      expect(plan.mocks).toHaveLength(0);
      expect(plan.unavailableCriteria).toHaveLength(1);
      expect(plan.groups[0]?.expectedCases).toHaveLength(1);
    }
  });

  it("validates enum intersections and constrained fixture values against their schemas", () => {
    const plan = planApi(apiSources({ type: "integer", enum: [1, 3], minimum: 2, maximum: 3 }));
    expect(plan.mocks).toHaveLength(1);
    const source = apiSources({ type: "integer", enum: [1, 3], minimum: 2, maximum: 3 }).find((item) => /openapi\.json$/.test(item.path))!;
    const descriptor = createE2EOpenApiFixtureDescriptor(source.bytes);
    expect(descriptor?.operations[0]?.responses[0]?.fixture).toBe(3);
    const schemaChanged = planApi(apiSources({ type: "string", enum: ["x", "xy"], minLength: 2 }));
    expect(schemaChanged.mocks).toHaveLength(1);
    const ownToString = createE2EOpenApiFixtureDescriptor(apiSources({ type: "object", properties: { toString: { type: "string", minLength: 1 } }, required: ["toString"], additionalProperties: false }).find((item) => /openapi\.json$/.test(item.path))!.bytes);
    expect(ownToString?.operations[0]?.responses[0]?.fixture).toEqual({ toString: "x" });
    expect(schemaChanged.groups[0]?.mockManifestDigest).not.toBe(plan.groups[0]?.mockManifestDigest);
  });

  it("accounts for inherited path parameters instead of ignoring their semantics", () => {
    const plan = planApi(apiSources({ type: "string" }, { parameters: [{ $ref: "#/components/parameters/Auth" }] }));
    expect(plan.mocks).toHaveLength(0);
    expect(plan.unavailableCriteria).toHaveLength(1);
  });

  it("uses one bounded fixture budget across response schemas", () => {
    const repeatedProperties = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`field${index}`, { type: "array", items: { type: "object", properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" } } } }]));
    const responseSchema = { type: "object", properties: repeatedProperties, required: Object.keys(repeatedProperties) };
    const manyResponses = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [String(200 + index), { description: "ok", content: { "application/json": { schema: responseSchema } } }]));
    const plan = planApi(apiSources({ type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, {}, manyResponses));
    expect(plan.mocks).toHaveLength(0);
    expect(plan.unavailableCriteria).toHaveLength(1);
  });

  it("retains native ownership across workspace and app boundaries independent of source order", () => {
    const rootWorkspace = file("package.json", JSON.stringify({ name: "workspace", private: true, workspaces: ["apps/*"], scripts: { start: "vite" } }));
    const mobileSources = [
      ...packageFiles(),
      file("apps/mobile/ios/App/Info.plist", plist("fixture.mobile.ios")),
      file("apps/mobile/android/app/src/main/AndroidManifest.xml", manifest("fixture.mobile.android")),
      file("apps/native/ios/App/Info.plist", plist("fixture.native.ios")),
      file("apps/native/android/app/src/main/AndroidManifest.xml", manifest("fixture.native.android")),
    ];
    const inspect = (sources: ReturnType<typeof file>[]) => inspectE2ERepository(snapshot(sources), candidate).inspection;
    const frameworkOnly = inspect(mobileSources);
    expect(frameworkOnly.proposedTargets.filter((target) => target.kind === "mobile")).toHaveLength(4);
    const rootAndChildren = inspect([rootWorkspace, ...mobileSources]);
    expect(rootAndChildren.proposedTargets.some((target) => target.kind === "web")).toBe(true);
    expect(rootAndChildren.proposedTargets.filter((target) => target.kind === "mobile")).toHaveLength(4);
    expect(rootAndChildren.applications.filter((application) => application.kind === "mobile")).toHaveLength(3);

    const sharedIos = inspect([file("ios/One/Info.plist", plist("fixture.same")), file("ios/Two/Info.plist", plist("fixture.same"))]);
    expect(sharedIos.proposedTargets.filter((target) => target.kind === "mobile")).toHaveLength(2);
    expect(new Set(sharedIos.proposedTargets.map((target) => target.targetId)).size).toBe(2);
    const reverse = inspect([file("ios/Two/Info.plist", plist("fixture.same")), file("ios/One/Info.plist", plist("fixture.same"))]);
    expect(canonicalJson(sharedIos.proposedTargets)).toBe(canonicalJson(reverse.proposedTargets));
  });

  it("keeps nested framework and separate native projects attached to their actual owners", () => {
    const sources = [
      ...packageFiles("apps/mobile", "@workspace/mobile"),
      file("apps/mobile/ios/App/Info.plist", plist("fixture.mobile")),
      file("apps/native/ios/One/Info.plist", plist("fixture.one")),
      file("apps/native/ios/Two/Info.plist", plist("fixture.two")),
      file("apps/native/android/One/src/main/AndroidManifest.xml", manifest("fixture.android.one")),
      file("apps/native/android/Two/src/main/AndroidManifest.xml", manifest("fixture.android.two")),
    ];
    const inspection = inspectE2ERepository(snapshot(sources), candidate).inspection;
    const mobileTargets = inspection.proposedTargets.filter((target) => target.kind === "mobile");
    expect(mobileTargets).toHaveLength(5);
    expect(new Set(mobileTargets.map((target) => target.applicationId)).size).toBe(5);
    expect(new Set(mobileTargets.map((target) => target.targetId)).size).toBe(5);
    expect(proposeE2ESetup({ inspection, snapshot: snapshot(sources), expectedCandidate: candidate }).state).toBe("proposed");
  });

  it("retains ambiguous same-platform native children and asks for a bounded app selection", () => {
    const sources = [
      ...packageFiles("apps/mobile", "@workspace/mobile"),
      file("apps/mobile/ios/One/Info.plist", plist("fixture.one")),
      file("apps/mobile/ios/Two/Info.plist", plist("fixture.two")),
      file("apps/mobile/android/app/src/main/AndroidManifest.xml", manifest("fixture.android")),
    ];
    const inspection = inspectE2ERepository(snapshot(sources), candidate).inspection;
    const iosTargets = inspection.proposedTargets.filter((target) => target.kind === "mobile" && target.os === "ios");
    expect(iosTargets).toHaveLength(2);
    expect(new Set(iosTargets.map((target) => target.applicationId)).size).toBe(2);
    expect(inspection.missingInputs.some((item) => item.kind === "target-selection" && item.targetIds.length === 2 && /Multiple ios project identities/.test(item.reason))).toBe(true);
    expect(inspection.proposedTargets.filter((target) => target.kind === "mobile" && target.os === "android")).toHaveLength(1);
  });
});

describe("application ownership by depth and native project", () => {
  const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: hash(text), kind: "blob" as const });
  const candidate = createCandidateManifest([{ repositoryId: "fixture/fix4", commitSha: "d".repeat(40), treeSha: "e".repeat(40) }]);
  const snapshot = (files: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "d".repeat(40), treeSha: "e".repeat(40), treeComplete: true, treePaths: files.map((item) => item.path), sources: files });
  const rootWeb = () => file("package.json", JSON.stringify({ name: "root-workspace", private: true, workspaces: ["apps/*"], scripts: { start: "vite" } }));
  const mobile = (directory: string) => file(`${directory}/package.json`, JSON.stringify({ name: `@fixture/${directory.replaceAll("/", "-")}`, dependencies: { "react-native": "1" } }));
  const plist = (id: string, platform = "iPhoneOS") => `<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleSupportedPlatforms</key><array><string>${platform}</string></array></dict></plist>`;
  const pbx = (sdk: "iphoneos" | "macosx", id: string) => `// !$*UTF8*$!\n{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; targets = (DDDDDDDDDDDDDDDDDDDDDDDD,); };
DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; productType = "com.apple.product-type.application"; };
BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (EEEEEEEEEEEEEEEEEEEEEEEE,); };
EEEEEEEEEEEEEEEEEEEEEEEE = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = ${sdk}; SUPPORTED_PLATFORMS = "${sdk}"; INFOPLIST_FILE = "App/Info.plist"; PRODUCT_BUNDLE_IDENTIFIER = ${id}; }; };
}; rootObject = AAAAAAAAAAAAAAAAAAAAAAAA; }`;
  const inspect = (files: ReturnType<typeof file>[]) => inspectE2ERepository(snapshot(files), candidate).inspection;

  it("assigns one-component app roots deeper than root regardless of inventory order", () => {
    for (const appRoot of ["m", "mobile"]) {
      const childFiles = [mobile(appRoot), file(`${appRoot}/ios/App/Info.plist`, plist(`fixture.${appRoot}`))];
      const rootFirst = inspect([rootWeb(), ...childFiles]);
      const rootLast = inspect([...childFiles, rootWeb()]);
      for (const result of [rootFirst, rootLast]) {
        const target = result.proposedTargets.find((item) => item.kind === "mobile" && item.os === "ios");
        expect(target?.applicationId).toBe(`@fixture/${appRoot}`);
        expect(result.applications.find((item) => item.applicationId === target?.applicationId)?.sourcePaths).toContain(`${appRoot}/ios/App/Info.plist`);
        expect(result.missingInputs.some((item) => /no native platform manifest/.test(item.reason))).toBe(false);
      }
      expect(canonicalJson(rootFirst.proposedTargets)).toBe(canonicalJson(rootLast.proposedTargets));
      expect(canonicalJson(rootFirst.missingInputs)).toBe(canonicalJson(rootLast.missingInputs));
    }
  });

  it("uses component depth and stable ownership for nested and equal-depth packages", () => {
    const sources = [
      rootWeb(), mobile("a/m"), file("a/m/ios/App/Info.plist", plist("fixture.short")),
      mobile("a/mobile"), file("a/mobile/ios/App/Info.plist", plist("fixture.long")),
      mobile("apps/one"), file("apps/one/ios/App/Info.plist", plist("fixture.one")),
      mobile("apps/two"), file("apps/two/ios/App/Info.plist", plist("fixture.two")),
      mobile("apps/one/nested"), file("apps/one/nested/ios/App/Info.plist", plist("fixture.nested")),
    ];
    const forward = inspect(sources);
    const reverse = inspect([...sources].reverse());
    expect(canonicalJson(forward.proposedTargets)).toBe(canonicalJson(reverse.proposedTargets));
    expect(canonicalJson(forward.applications)).toBe(canonicalJson(reverse.applications));
    for (const [id, name] of [["fixture.short", "@fixture/a-m"], ["fixture.long", "@fixture/a-mobile"], ["fixture.one", "@fixture/apps-one"], ["fixture.two", "@fixture/apps-two"], ["fixture.nested", "@fixture/apps-one-nested"]]) {
      const target = forward.proposedTargets.filter((item) => item.kind === "mobile").find((item) => item.appId === id);
      expect(forward.applications.find((app) => app.applicationId === target?.applicationId)?.applicationId).toBe(name);
    }
  });

  it("retains native desktop project identity and runtime gap beside a root web workspace", () => {
    const project = file("apps/mac/App.xcodeproj/project.pbxproj", pbx("macosx", "fixture.mac"));
    const appPlist = file("apps/mac/App/Info.plist", plist("fixture.mac", "MacOSX"));
    const standalone = inspect([project, appPlist]);
    const withRootFirst = inspect([rootWeb(), project, appPlist]);
    const withRootLast = inspect([project, appPlist, rootWeb()]);
    for (const result of [standalone, withRootFirst, withRootLast]) {
      expect(result.proposedTargets.some((item) => item.kind === "desktop" && item.os === "macos" && item.driver === "native")).toBe(true);
      expect(result.missingInputs.some((item) => item.kind === "runtime" && /native build and launch profile/.test(item.reason))).toBe(true);
    }
    expect(withRootFirst.proposedTargets.some((item) => item.kind === "web")).toBe(true);
    expect(withRootFirst.applications.find((item) => item.kind === "web")?.sourcePaths).not.toContain(project.path);
    expect(canonicalJson(withRootFirst.proposedTargets)).toBe(canonicalJson(withRootLast.proposedTargets));
    expect(canonicalJson(withRootFirst.missingInputs)).toBe(canonicalJson(withRootLast.missingInputs));
    expect(canonicalJson(withRootFirst.applications)).toBe(canonicalJson(withRootLast.applications));
  });

  it("retains Gradle-only project metadata as unresolved identity, with or without a root workspace", () => {
    const gradleOnly = file("apps/native/android/app/build.gradle.kts", "plugins { id(\"com.android.application\") }");
    for (const files of [[gradleOnly], [rootWeb(), gradleOnly], [gradleOnly, rootWeb()]] as ReturnType<typeof file>[][]) {
      const result = inspect(files);
      expect(result.applications.some((item) => item.kind === "mobile" && item.sourcePaths.includes(gradleOnly.path))).toBe(true);
      expect(result.missingInputs.some((item) => item.kind === "target-selection" && /no resolvable application identifier/.test(item.reason) && item.sourcePaths.includes(gradleOnly.path))).toBe(true);
      expect(result.proposedTargets.some((item) => item.kind === "mobile" && item.appId === "fixture.gradle")).toBe(false);
    }
    const matched = inspect([
      file("android/app/build.gradle", "plugins { id 'com.android.application' }"),
      file("android/app/src/main/AndroidManifest.xml", '<manifest package="fixture.gradle"><application /></manifest>'),
    ]);
    expect(matched.proposedTargets.filter((item) => item.kind === "mobile" && item.os === "android")).toHaveLength(1);
    expect(matched.proposedTargets.filter((item) => item.kind === "mobile").find((item) => item.os === "android")?.appId).toBe("fixture.gradle");

    const siblingGradle = inspect([
      file("android/One/build.gradle", "plugins { id 'com.android.application' }"),
      file("android/Two/build.gradle.kts", "plugins { id(\"com.android.application\") }"),
    ]);
    expect(siblingGradle.applications.filter((item) => item.kind === "mobile")).toHaveLength(2);
    expect(siblingGradle.missingInputs.filter((item) => item.kind === "target-selection" && /no resolvable application identifier/.test(item.reason))).toHaveLength(2);
  });

  it("keeps a native Xcode project under a declared mobile framework with that mobile app", () => {
    const sources = [
      mobile("apps/rn"),
      file("apps/rn/ios/App/Info.plist", plist("fixture.rn")),
      file("apps/rn/ios/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.rn"))
    ];
    const result = inspect(sources);
    expect(result.applications.filter((item) => item.kind === "mobile")).toHaveLength(1);
    expect(result.proposedTargets.filter((item) => item.kind === "mobile" && item.os === "ios")).toHaveLength(1);
    expect(result.proposedTargets.some((item) => item.kind === "desktop" && item.os === "macos")).toBe(false);
    const unresolved = inspect([mobile("apps/unresolved"), file("apps/unresolved/ios/App.xcodeproj/project.pbxproj", "PBXProject = { rootObject = A; };")]);
    expect(unresolved.proposedTargets.some((item) => item.kind === "desktop")).toBe(false);
    expect(unresolved.missingInputs.some((item) => item.kind === "target-selection" && /no native platform manifest/.test(item.reason))).toBe(true);
  });
});

describe("standalone native and API discovery", () => {
  const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
  const file = (path: string, text: string) => ({ path, bytes: Buffer.from(text), sha256: hash(text), kind: "blob" as const });
  const candidate = createCandidateManifest([{ repositoryId: "fixture/fix5", commitSha: "f".repeat(40), treeSha: "a".repeat(40) }]);
  const snapshot = (files: ReturnType<typeof file>[]): E2ESourceSnapshot => ({ candidate, commitSha: "f".repeat(40), treeSha: "a".repeat(40), treeComplete: true, treePaths: files.map((item) => item.path), sources: files });
  const inspect = (files: ReturnType<typeof file>[]) => inspectE2ERepository(snapshot(files), candidate).inspection;
  const propose = (files: ReturnType<typeof file>[]) => proposeE2ESetup({ inspection: inspect(files), snapshot: snapshot(files), expectedCandidate: candidate });
  const plist = (id: string, platform: "iPhoneOS" | "MacOSX" = "iPhoneOS") => `<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleSupportedPlatforms</key><array><string>${platform}</string></array></dict></plist>`;
  const pbx = (sdk: "iphoneos" | "macosx", id: string, plistPath = "App/Info.plist") => `// !$*UTF8*$!
{ archiveVersion = 1; classes = {}; objectVersion = 56; objects = {
AAAAAAAAAAAAAAAAAAAAAAAA = { isa = PBXProject; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; mainGroup = CCCCCCCCCCCCCCCCCCCCCCCC; targets = (DDDDDDDDDDDDDDDDDDDDDDDD,); };
BBBBBBBBBBBBBBBBBBBBBBBB = { isa = XCConfigurationList; buildConfigurations = (EEEEEEEEEEEEEEEEEEEEEEEE,); defaultConfigurationName = Debug; };
CCCCCCCCCCCCCCCCCCCCCCCC = { isa = PBXGroup; children = (FFFFFFFFFFFFFFFFFFFFFFFF,); sourceTree = "<group>"; };
DDDDDDDDDDDDDDDDDDDDDDDD = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; buildPhases = (); buildRules = (); dependencies = (); name = App; productName = App; productType = "com.apple.product-type.application"; };
EEEEEEEEEEEEEEEEEEEEEEEE = { isa = XCBuildConfiguration; buildSettings = { SDKROOT = ${sdk}; SUPPORTED_PLATFORMS = "${sdk} ${sdk === "iphoneos" ? "iphonesimulator" : ""}"; INFOPLIST_FILE = "${plistPath}"; PRODUCT_BUNDLE_IDENTIFIER = ${id}; }; name = Debug; };
FFFFFFFFFFFFFFFFFFFFFFFF = { isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = ${plistPath.slice(plistPath.lastIndexOf("/") + 1)}; sourceTree = "<group>"; };
}; rootObject = AAAAAAAAAAAAAAAAAAAAAAAA; }`;

  it("discovers standalone Android application metadata independently of an android path prefix", () => {
    const files = [
      file("app/build.gradle", 'plugins { id "com.android.application" }'),
      file("app/src/main/AndroidManifest.xml", '<manifest package="fixture.android"><application/></manifest>'),
    ];
    const withRoot = [file("package.json", JSON.stringify({ name: "root", scripts: { start: "vite" } })), ...files];
    for (const inventory of [files, withRoot, [...withRoot].reverse()]) {
      const result = propose(inventory);
      expect(result.targets.filter((target) => target.kind === "mobile" && target.os === "android")).toHaveLength(1);
      expect(result.missingInputs.some((item) => item.kind === "runtime" && item.sourcePaths.includes("app/src/main/AndroidManifest.xml"))).toBe(true);
    }
    const prefixed = propose(files.map((item) => ({ ...item, path: `android/${item.path}` })));
    expect(prefixed.targets.filter((target) => target.kind === "mobile" && target.os === "android")).toHaveLength(1);
    const gradleOnly = propose([file("native/mobile/build.gradle.kts", 'plugins { id("com.android.application") }')]);
    expect(gradleOnly.applications.some((application) => application.kind === "mobile" && application.sourcePaths.includes("native/mobile/build.gradle.kts"))).toBe(true);
    expect(gradleOnly.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("native/mobile/build.gradle.kts"))).toBe(true);
  });

  it("binds standalone API target and recipe IDs to canonical source paths", () => {
    const schema = JSON.stringify({ openapi: "3.1.0", info: { title: "Fixture", version: "1" }, paths: { "/status": { get: { responses: { "200": { description: "ok" } } } } } });
    const apis = [file("one/openapi.json", schema), file("two/openapi.json", schema)];
    expect(canonicalJson(propose(apis))).toBe(canonicalJson(propose([...apis].reverse())));
    const apiTargets = propose(apis).targets;
    expect(new Set(apiTargets.map((target) => target.targetId)).size).toBe(2);
    expect(apiTargets.every((target) => target.kind === "api")).toBe(true);

  });

  it("keeps duplicate dependency suppliers as a visible ambiguity instead of selecting by inventory order", () => {
    const packages = [
      file("app/package.json", JSON.stringify({ name: "consumer", dependencies: { same: "1" }, scripts: { start: "node app.js" } })),
      file("one/package.json", JSON.stringify({ name: "same" })),
      file("two/package.json", JSON.stringify({ name: "same" })),
    ];
    const forward = propose(packages);
    const reverse = propose([...packages].reverse());
    expect(canonicalJson(forward)).toBe(canonicalJson(reverse));
    expect(forward.dependencyEdges.filter((edge) => edge.fromApplicationId === "consumer")).toHaveLength(0);
    expect(forward.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("app/package.json") && input.sourcePaths.includes("one/package.json") && input.sourcePaths.includes("two/package.json"))).toBe(true);
    const explicitlyLinked = [
      file("app/package.json", JSON.stringify({ name: "consumer", dependencies: { same: "file:../one" }, scripts: { start: "node app.js" } })),
      file("one/package.json", JSON.stringify({ name: "same" })),
      file("two/package.json", JSON.stringify({ name: "same" })),
    ];
    const linked = propose(explicitlyLinked);
    const edge = linked.dependencyEdges.find((item) => item.fromApplicationId === "consumer");
    expect(edge?.sourcePaths).toEqual(["app/package.json", "one/package.json"]);
    expect(linked.missingInputs.some((item) => item.inputId.startsWith("dependency-source-") && item.sourcePaths.includes("two/package.json"))).toBe(false);
  });

  it("uses PBX target configuration to own one plist instead of splitting one target", () => {
    const paired = [
      file("workspace/App/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.ios</string></dict></plist>"),
      file("workspace/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.ios")),
    ];
    const pairedProposal = propose(paired);
    expect(pairedProposal.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(1);
    expect(pairedProposal.targets.some((target) => target.kind === "desktop" && target.os === "macos")).toBe(false);
    expect(pairedProposal.applications.filter((application) => application.sourcePaths.includes("workspace/App/Info.plist"))).toHaveLength(1);
    const root = file("package.json", JSON.stringify({ name: "root", scripts: { start: "vite" } }));
    expect(canonicalJson(propose([root, ...paired]))).toBe(canonicalJson(propose([...paired, root].reverse())));
    const standaloneIos = propose([file("native/App/Info.plist", "<plist><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleIdentifier</key><string>fixture.standalone</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>")]);
    expect(standaloneIos.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(1);

  });

  it("retains distinct PBX application targets associated with one framework-owned plist", () => {
    const multiTargetProject = pbx("iphoneos", "fixture.multi")
      .replace("targets = (DDDDDDDDDDDDDDDDDDDDDDDD,);", "targets = (DDDDDDDDDDDDDDDDDDDDDDDD, GGGGGGGGGGGGGGGGGGGGGGGGGG,);")
      .replace("};\nEEEEEEEEEEEEEEEEEEEEEEEE =", "};\nGGGGGGGGGGGGGGGGGGGGGGGGGG = { isa = PBXNativeTarget; buildConfigurationList = BBBBBBBBBBBBBBBBBBBBBBBB; buildPhases = (); buildRules = (); dependencies = (); name = AppVariant; productName = AppVariant; productType = \"com.apple.product-type.application\"; };\nEEEEEEEEEEEEEEEEEEEEEEEE =");
    const files = [
      file("ios/App/Info.plist", plist("fixture.multi")),
      file("ios/App.xcodeproj/project.pbxproj", multiTargetProject),
      file("package.json", JSON.stringify({ name: "native-shell", dependencies: { "react-native": "1" } })),
    ];
    const proposal = propose(files);
    const iosTargets = proposal.targets.filter((target) => target.kind === "mobile" && target.os === "ios");
    expect(iosTargets).toHaveLength(3);
    expect(new Set(iosTargets.map((target) => target.targetId)).size).toBe(3);
    expect(new Set(iosTargets.map((target) => target.applicationId)).size).toBe(1);
    expect(iosTargets.every((target) => proposal.applications.some((application) => application.applicationId === target.applicationId && application.sourcePaths.includes("ios/App.xcodeproj/project.pbxproj")))).toBe(true);
    expect(iosTargets.filter((target) => target.targetId.startsWith("apple-target-"))).toHaveLength(2);
    expect(proposal.missingInputs.filter((input) => input.inputId.startsWith("native-association-") && input.targetIds.length === 1)).toHaveLength(2);
  });

  it("preserves unrelated same-bundle projects as distinct applications", () => {
    const twoProjects = [
      file("ios/One/App/Info.plist", plist("fixture.same")), file("ios/One/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.same")),
      file("ios/Two/App/Info.plist", plist("fixture.same")), file("ios/Two/App.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.same")),
    ];
    const separate = propose(twoProjects);
    expect(separate.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(2);
    expect(new Set(separate.targets.filter((target) => target.kind === "mobile").map((target) => target.applicationId)).size).toBe(2);

  });

  it("recognizes corroborated macOS metadata and leaves unclassified plist metadata unresolved", () => {
    const mac = propose([file("mac/App/Info.plist", plist("fixture.mac", "MacOSX")), file("mac/App.xcodeproj/project.pbxproj", pbx("macosx", "fixture.mac"))]);
    expect(mac.targets.filter((target) => target.kind === "desktop" && target.os === "macos")).toHaveLength(1);
    const unknown = propose([file("unknown/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.unknown</string></dict></plist>")]);
    expect(unknown.targets.some((target) => target.kind === "mobile" || target.kind === "desktop")).toBe(false);
    expect(unknown.missingInputs.some((input) => input.sourcePaths.includes("unknown/Info.plist"))).toBe(true);
    const contradictory = propose([
      file("ios/App/Info.plist", plist("fixture.conflict", "MacOSX")),
      file("ios/Conflict.xcodeproj/project.pbxproj", pbx("iphoneos", "fixture.conflict")),
    ]);
    expect(contradictory.targets.filter((target) => target.kind === "mobile" && target.os === "ios")).toHaveLength(0);
    expect(contradictory.targets.filter((target) => target.kind === "desktop" && target.os === "macos")).toHaveLength(0);
    expect(contradictory.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("ios/Conflict.xcodeproj/project.pbxproj"))).toBe(true);
    const malformed = propose([
      file("ios/App/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>fixture.broken</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneOS</string></array></dict></plist>"),
      file("ios/Broken.xcodeproj/project.pbxproj", "{ rootObject = MISSING; objects = {}; }"),
    ]);
    expect(malformed.missingInputs.some((input) => input.disposition === "blocking" && input.sourcePaths.includes("ios/Broken.xcodeproj/project.pbxproj"))).toBe(true);
  });
});

