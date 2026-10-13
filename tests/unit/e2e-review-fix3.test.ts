import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, createCandidateManifest, createE2EOpenApiFixtureDescriptor, type E2EScenario, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup } from "../../packages/broker/src/e2e/discovery.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";

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

describe("Task2A review fix3 regressions", () => {
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
