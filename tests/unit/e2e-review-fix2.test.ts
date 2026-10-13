import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson, createCandidateManifest, type E2EScenario, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository, proposeE2ESetup } from "../../packages/broker/src/e2e/discovery.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { githubRepositoryApi } from "../../packages/cli/src/setup/project-files.js";

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

describe("Task2A review fix2 regressions", () => {
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
      file("apps/one/ios/App/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>acme.one</string></dict></plist>"),
      file("apps/two/ios/App/Info.plist", "<plist><dict><key>CFBundleIdentifier</key><string>acme.two</string></dict></plist>"),
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
