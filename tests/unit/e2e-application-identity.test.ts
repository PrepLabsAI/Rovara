import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { list } from "e2e/runner";
import { APPLICATION_E2E_TEST_PATH, e2eApplicationUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-application-execution-plan.js";
import { canonicalJson, e2eExecutionPlanDigest } from "../../packages/contracts/src/index.js";
import { e2eCaseIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import { compareE2EApplicationPublicList, createE2EApplicationSelectionPacket, E2EApplicationSelectionPacketSchema } from "../../packages/verifier/src/application-identity.js";
import { expectedE2EApplicationConfigDigest, renderE2EApplicationDeclaration, renderE2EApplicationGeneratedTest } from "../../packages/verifier/src/application-templates.js";

const tuple = {
  caseId: "case-1", executionDescriptorDigest: "a".repeat(64),
  upstreamTestId: `${APPLICATION_E2E_TEST_PATH}::case-abc`, upstreamResultId: "b".repeat(64),
  title: "case-abc", targetId: "web-1", targetName: "web-1", platform: "web", agent: "default" as const,
  disposition: "run" as const, source: { file: APPLICATION_E2E_TEST_PATH, line: 1, column: 1 }, tags: [],
};

describe("application public-list identity", () => {
  it("matches generated multi-case source coordinates in a fresh pinned Node22 runner process", async () => {
    const scenario = { scenarioId: "scenario-fresh", requirementId: "requirement-fresh", requestedTargetIds: ["api-fresh"], required: true,
      accountProfileId: "account-fresh", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "request", method: "GET", path: "/" }],
      assertions: [{ kind: "visible", testId: "home", equals: true }] } as never;
    const cases = [0, 1, 2].map((index) => ({ caseId: `case-${String(index + 1).padStart(64, "0")}`,
      upstreamTestId: `${APPLICATION_E2E_TEST_PATH}::case-${String(index + 1).padStart(64, "0")}`, scenarioId: "scenario-fresh",
      assertionDigests: ["a".repeat(64)] }));
    const assertionBindings = new Map(cases.map((item) => [item.caseId, [{ index: 0, kind: "visible", digest: "a".repeat(64) }]]));
    const generated = renderE2EApplicationGeneratedTest({ cases: cases as never, scenarios: [scenario], timeoutMs: 1000, assertionsByCase: assertionBindings });
    const target = { targetId: "web-fresh", profileId: "web-profile", factoryId: "installed-playwright", factoryManifestDigest: "f".repeat(64),
      engine: { name: "playwright", version: "1.0.0", spiVersion: 1, platform: "web", capabilities: ["actions", "observation"] },
      artifactCapabilities: [], stateCapability: false, app: { identity: "shop", environment: "test", url: "https://shop.test" } } as never;
    const modelRoute = { routeId: "route-fresh", routeRevision: "route-revision-fresh" };
    const expectedConfigDigest = expectedE2EApplicationConfigDigest({ projectId: "rovara-application-e2e", tests: [APPLICATION_E2E_TEST_PATH],
      target, timeout: 9000, modelRoute });
    const declaration = JSON.parse(renderE2EApplicationDeclaration({ target, cliHost: { profileId: "api-profile",
      descriptor: { entryPointId: "installed-api-cli", entryPointManifestDigest: "d".repeat(64) } }, preparedEnvironmentDigest: "e".repeat(64),
      originByApplicationId: [], timeoutMs: 9000, modelRoute, expectedConfigDigest, cases: cases as never, assertionsByCase: assertionBindings })) as {
      projectId: string; testPath: string; timeoutMs: number; modelRoute: typeof modelRoute; expectedConfigDigest: string;
    };
    const lines = generated.split("\n");
    const expectedLines = cases.map((item) => lines.findIndex((line) => line.includes(item.upstreamTestId.split("::")[1]!)) + 1);
    const root = await mkdtemp(join(process.cwd(), "tests/.tmp-e2e-app-list-fresh-"));
    try {
      const testPath = join(root, APPLICATION_E2E_TEST_PATH);
      await mkdir(join(root, ".agentx", "e2e"), { recursive: true });
      await writeFile(testPath, generated);
      const script = `import { list } from "e2e/runner"; import { defineEngine } from "e2e/engine"; const input = JSON.parse(process.argv[1]); const { resolveConfig } = await import(input.resolverUrl); const model = { provider: "agentx-e2e", modelId: input.declaration.modelRoute.routeId, specificationVersion: "v4", doGenerate: async () => { throw new Error("model calls are forbidden in list conformance"); } }; const engine = defineEngine({ name: "playwright", version: "1.0.0", spiVersion: 1, platform: "web", observe: async () => { throw new Error("engine effects are forbidden in list conformance"); }, perform: async () => { throw new Error("engine effects are forbidden in list conformance"); }, actions: ["tap"] }); const config = { projectId: input.declaration.projectId, tests: [input.declaration.testPath], workers: 1, retries: 0, timeout: input.declaration.timeoutMs, cache: "off", agents: { default: { model } }, targets: [{ name: input.declaration.target.targetId, engine, app: input.declaration.target.app }] }; const resolved = resolveConfig(config, { projectRoot: input.cwd }); const result = await list({ cwd: input.cwd, config, files: [input.declaration.testPath] }); process.stdout.write(JSON.stringify({ ...result, configDigest: resolved.configDigest }));`;
      const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script,
        JSON.stringify({ cwd: root, declaration, resolverUrl: new URL("../../node_modules/e2e/dist/config/resolve.js", import.meta.url).href })],
      { cwd: root, encoding: "utf8" })) as { pairs: Array<{ source: { line: number } }>; configDigest: string };
      expect(result.pairs.map((pair) => pair.source.line)).toEqual(expectedLines);
      expect(expectedLines).toEqual([3, 8, 13]);
      expect(result.configDigest).toBe(expectedConfigDigest);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a public-list result that substitutes another same-platform target", () => {
  const packet = E2EApplicationSelectionPacketSchema.parse({ schemaVersion: 1, algorithm: "e2e-application-public-list-selection/v1",
      executionPlanDigest: "c".repeat(64), groupId: "group-1", shardId: "shard-1", targetId: "web-1", tuples: [tuple] });
    expect(() => compareE2EApplicationPublicList(packet, { pairs: [{ id: tuple.upstreamResultId,
      file: APPLICATION_E2E_TEST_PATH, title: tuple.title, titlePath: [tuple.title], kind: "test", session: undefined,
      sessions: [], serialId: undefined, target: "web-2", agent: "default", disposition: "run", tags: [],
      source: { file: APPLICATION_E2E_TEST_PATH, line: 1, column: 1 } }], unmatched: [] })).toThrow();
  });

  it("rejects missing one-target expected identities instead of filtering by platform", () => {
    expect(() => createE2EApplicationSelectionPacket({ plan: {} as never, groupId: "group-1", shardId: "shard-1",
      targetId: "web-1", targetPlatform: "web", titleByCaseId: new Map(), sourceByCaseId: new Map() })).toThrow();
  });

  it("matches the installed 0.20 public runner list IDs and tuple facts without starting an engine", async () => {
    const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
    const assertionDigests = [digest([{ kind: "visible", testId: "home", equals: true }])];
    const identity = { scenarioId: "scenario-a", targetId: "api-a", requestedTargetId: "api-a", accountProfileId: "account-a",
      accountContextId: "context-a", accountContextDigest: "a".repeat(64), executionDescriptorDigest: "b".repeat(64),
      minimumEvidence: "runtime" as const, requiredRealComponentIds: [] as string[], agentId: "default" as const, repeat: 0 as const, assertionDigests };
    const caseId = e2eCaseIdFromIdentity(identity);
    const title = caseId;
    const expected = { ...identity, caseId, criterionId: "criterion-a", scenarioId: "scenario-a",
      upstreamTestId: e2eApplicationUpstreamTestIdFromIdentity(identity), targetId: "api-a", requestedTargetId: "api-a",
      assertionDigest: digest(assertionDigests), required: true, minimumEvidence: "runtime" as const, requiredRealComponentIds: [] };
    const target = { targetId: "api-a", applicationId: "app-a", runtimeProfileId: "api-profile", accountProfileId: "account-a",
      kind: "api", protocol: "http", originRef: "origin-app-a" };
    const group = { groupId: "group-a", targetIds: ["api-a"], runtimeProfileId: "api-profile", mode: "real-runtime",
      mockManifestDigest: "c".repeat(64), expectedCases: [expected] };
    const criterion = { criterionId: "criterion-a", requirementId: "requirement-a", scenarioId: "scenario-a", requestedTargetId: "api-a",
      required: true, minimumEvidence: "runtime", requiredRealComponentIds: [], expectedCaseIds: [caseId] };
    const planBody = { schemaVersion: 1 as const, candidateDigest: "d".repeat(64), planDigest: "e".repeat(64), criteria: [criterion],
      effectiveTargets: [target], groups: [group], mocks: [], unavailableCriteria: [] };
    const plan = { ...planBody, digest: e2eExecutionPlanDigest({ ...planBody, digest: "" } as never) };
    const scenario = { scenarioId: "scenario-a", requirementId: "requirement-a", requestedTargetIds: ["api-a"], required: true,
      accountProfileId: "account-a", minimumEvidence: "runtime", requiredRealComponentIds: [], steps: [{ kind: "request", method: "GET", path: "/" }],
      assertions: [{ kind: "visible", testId: "home", equals: true }] } as never;
    const generated = renderE2EApplicationGeneratedTest({ cases: [expected], scenarios: [scenario], timeoutMs: 1000,
      assertionsByCase: new Map([[caseId, [{ index: 0, kind: "visible", digest: assertionDigests[0]! }]]]) });
    // The pinned upstream TypeScript collector removes the declaration-only
    // global block before capturing this source location.
    const line = generated.split("\n").findIndex((row) => row.startsWith(`test(${JSON.stringify(title)},`));
    const packet = createE2EApplicationSelectionPacket({ plan: plan as never, groupId: "group-a", shardId: "shard-a", targetId: "api-a",
      targetPlatform: "api", titleByCaseId: new Map([[caseId, title]]), sourceByCaseId: new Map([[caseId, { file: APPLICATION_E2E_TEST_PATH, line, column: 1 }]]) });
    // Keep the generated project beneath this checkout so the upstream public
    // runner resolves the exact installed `e2e` package from its normal graph.
    const root = await mkdtemp(join(process.cwd(), "tests/.tmp-e2e-app-list-"));
    try {
      const testPath = join(root, APPLICATION_E2E_TEST_PATH);
      await mkdir(join(root, ".agentx", "e2e"), { recursive: true });
      await writeFile(testPath, generated);
      const listed = await list({ cwd: root, config: { projectId: "rovara-application-e2e", tests: [APPLICATION_E2E_TEST_PATH], workers: 1,
        retries: 0, targets: [{ name: "api-a", platform: "api" }] }, files: [APPLICATION_E2E_TEST_PATH] });
      expect(compareE2EApplicationPublicList(packet, listed)).toMatchObject({ selected: [{ upstreamResultId: packet.tuples[0]?.upstreamResultId }] });
      expect(listed.targets).toEqual(["api-a"]);
      expect(listed.pairs).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
