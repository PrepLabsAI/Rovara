import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { list } from "e2e/runner";
import { canonicalJson, createCandidateManifest, e2eExecutionPlanDigest, e2eScenarioBundleDigest, e2EDefaultSyntheticAccountDefinition, E2ERoundSchema, E2ERunBindingSchema, inspectE2EPortableSource, e2ePortableOperationDescriptorDigest as contractDescriptorDigest, e2EPortableApprovalBindingDigest, copyBoundedE2ESourceBytes, copyBoundedE2ETreePaths, e2ePortableRegistrationKey, resolveE2EPortableRegistration, type E2EPolicy, type E2EPortableApprovalBinding, type E2EScenario, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { compileE2EScenarios, validateE2ECompiledRuntimeAdmission, type E2EImmutableCompilationContext } from "../../packages/verifier/src/scenarios.js";
import { e2ePortableOperationDescriptorDigest } from "../../packages/verifier/src/templates.js";
import { compareE2EPublicList, createE2ESelectionPacket, type E2ESelectionPacket } from "../../packages/verifier/src/selection.js";
import { verifyE2ECompiledFileInventory } from "../../packages/verifier/src/identity.js";
import { e2eApplicationUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-application-execution-plan.js";
import { createE2ECollectionOracleFromCompiledSuite } from "../../packages/verifier/src/result-adapter.js";
import { runE2EActualCli } from "../../packages/verifier/src/runtime-cli.js";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const candidate = createCandidateManifest([{ repositoryId: "acme/shop", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
const manifest = Buffer.from(JSON.stringify({ name: "shop", scripts: { start: "node app.js" }, exports: { ".": "./src/index.js", "./rows": "./src/rows.js" } }));
const source = Buffer.from("export default async function(input) { return input; }\n");
const rowSource = Buffer.from("export const listRows = async(input) => input;\n");
const sources = [
  { path: "apps/shop/package.json", bytes: manifest, sha256: hash(manifest), kind: "blob" as const },
  { path: "apps/shop/src/index.js", bytes: source, sha256: hash(source), kind: "blob" as const },
  { path: "apps/shop/src/rows.js", bytes: rowSource, sha256: hash(rowSource), kind: "blob" as const },
];
const snapshot: E2ESourceSnapshot = { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((item) => item.path), sources };
const inspection = inspectE2ERepository(snapshot, candidate);
const target = inspection.inspection.proposedTargets.find((item) => item.kind === "web")!;
const operation = inspection.portableOperations.find((item) => item.exportName === "./rows")!;
const sandbox = { targetId: "default-sandbox" as const, profileId: "default-sandbox", connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "auth-r1" };
const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: ["s"], targets: [target], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null, capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
const scenario: E2EScenario = { scenarioId: "s", requirementId: "r", requestedTargetIds: [target.targetId], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [], steps: [{ kind: "invoke-contract", operationId: operation.operationId, input: { query: "ok" } }], assertions: [{ kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: { rows: [1] } }, { kind: "state", probeId: "result", equals: { rows: [1] }, pollTimeoutMs: 500 }] };
const callableSelector = { kind: "named" as const, exportName: "listRows" };
const registrationBase = { operationId: operation.operationId, applicationId: operation.applicationId, packageExportSubpath: operation.exportName,
  moduleSpecifier: "./src/rows.js", callableSelector, expectedExportNames: null, purpose: "feature-invocation" as const, schemaVersion: "portable-source-operation/v1" as const, sourceRefs: [...operation.sourceRefs] };
const registration = { ...registrationBase, descriptorDigest: contractDescriptorDigest(registrationBase) };
const semanticApproval = { artifactId: "sem-r1", digest: hash("approved semantic approval") };
const accountContext = { schemaVersion: "synthetic-account-context/v1" as const, contextId: "account-shop-synthetic", profileId: "synthetic", applicationId: operation.applicationId, scope: "SYNTHETIC" as const,
  fixture: { version: "synthetic-fixture/v1" as const, sourcePath: operation.manifestPath, sourceSha256: sources[0]!.sha256, definition: e2EDefaultSyntheticAccountDefinition(operation.applicationId, "synthetic") },
  sourceRefs: [{ path: operation.manifestPath, sha256: sources[0]!.sha256 }], approval: { ...semanticApproval, planDigest: "c".repeat(64) } };
const bindingBody = { schemaVersion: "portable-approval-binding/v1" as const, planDigest: "c".repeat(64), semanticApproval, operations: [registration], accountContexts: [accountContext] };
const binding = { ...bindingBody, bindingDigest: e2EPortableApprovalBindingDigest(bindingBody) };
const selection = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest: "c".repeat(64), policy, scenarios: [scenario], selectedTargetIds: [target.targetId], sandboxAvailability: sandbox, runtimeAvailability: [], portableApprovalBinding: binding, approvedSemanticApproval: semanticApproval };
const plan = selectE2EExecutionPlan(selection);
const group = plan.groups[0]!;
const bundle = { schemaVersion: 1 as const, planDigest: selection.planDigest, templateVersion: "trusted-e2e/v1", scenarios: [scenario], bundleDigest: "0".repeat(64) };
const approvedBundle = { ...bundle, bundleDigest: e2eScenarioBundleDigest(bundle) };
const immutableCompilationContext: E2EImmutableCompilationContext = { selectionInput: selection, executionPlan: plan, group };

describe("trusted E2E compiler", () => {
  it("keeps application IDs representable while rejecting them in the portable compiler and packet", () => {
    const compiled = compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, immutableCompilationContext);
    const expectedCase = compiled.expectedCases[0]!;
    const applicationCase = { ...expectedCase, upstreamTestId: e2eApplicationUpstreamTestIdFromIdentity(expectedCase) };
    const changedGroup = { ...group, expectedCases: [applicationCase] };
    const changedBody = { ...plan, groups: [changedGroup], digest: "0".repeat(64) };
    const changedPlan = { ...changedBody, digest: e2eExecutionPlanDigest(changedBody) };
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, changedGroup,
      { selectionInput: selection, executionPlan: changedPlan, group: changedGroup })).toThrow();
    const caseBinding = compiled.caseBindings.get(expectedCase.caseId)!;
    expect(() => createE2ESelectionPacket(changedPlan, changedGroup.groupId,
      new Map([[applicationCase.caseId, expectedCase.upstreamTestId.split("::").at(-1)!]]), new Map([[applicationCase.caseId, {
        compilerCaseIdentity: caseBinding.compilerCaseIdentity, registrationKey: caseBinding.registrationKey,
        candidateResponseScope: "contained-candidate-process-response/v1" as const,
        requestProtocol: "contained-candidate-host-request/v1" as const,
      }]]))).toThrow(/pinned public identity/);
  });
  it("retains complete compiler-origin source admission and rejects foreign or incomplete runtime snapshots", () => {
    const compiled = compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, immutableCompilationContext);
    expect(validateE2ECompiledRuntimeAdmission(compiled, snapshot).commitSha).toBe(snapshot.commitSha);
    const changedBytes = Buffer.from("export const listRows = async(input) => ({ changed: input });\n");
    const foreign = { ...snapshot, sources: snapshot.sources.map((item) => item.path === "apps/shop/src/rows.js" ? { ...item, bytes: changedBytes, sha256: hash(changedBytes) } : item) };
    expect(() => validateE2ECompiledRuntimeAdmission(compiled, foreign)).toThrow(/differs from its compiler-origin/);
    const incomplete = { ...snapshot, treePaths: snapshot.treePaths.slice(0, -1), sources: snapshot.sources.slice(0, -1) };
    expect(() => validateE2ECompiledRuntimeAdmission(compiled, incomplete)).toThrow();
    expect(() => validateE2ECompiledRuntimeAdmission({ ...compiled, runtimeAdmission: undefined } as never, snapshot)).toThrow(/no compiler-origin runtime admission/);
  });
  it("rejects candidate, tree, source inventory, context, and case-binding changes before any runtime allocation", async () => {
    const compiled = compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, immutableCompilationContext);
    const foreignSource = Buffer.from("export const listRows = async(input) => ({ foreign: input });\n");
    const foreign = { ...snapshot, sources: snapshot.sources.map((item) => item.path === "apps/shop/src/rows.js" ? { ...item, bytes: foreignSource, sha256: hash(foreignSource) } : item) };
    expect(() => validateE2ECompiledRuntimeAdmission(compiled, { ...foreign, commitSha: "f".repeat(40) })).toThrow();
    expect(() => validateE2ECompiledRuntimeAdmission(compiled, { ...snapshot, treeSha: "e".repeat(40) })).toThrow();
    expect(() => validateE2ECompiledRuntimeAdmission(compiled, { ...snapshot, treePaths: snapshot.treePaths.slice(0, -1), sources: snapshot.sources.slice(0, -1) })).toThrow();
    const changedContext = { ...compiled.runtimeAdmissionContext, selectionInput: { ...compiled.runtimeAdmissionContext.selectionInput, planDigest: "d".repeat(64) } };
    expect(() => validateE2ECompiledRuntimeAdmission({ ...compiled, runtimeAdmissionContext: changedContext }, snapshot)).toThrow(/context.*changed/);
    const changedBinding = new Map(compiled.caseBindings);
    const binding = changedBinding.get(compiled.expectedCases[0]!.caseId)!;
    changedBinding.set(compiled.expectedCases[0]!.caseId, { ...binding, applicationId: "foreign-app" });
    expect(() => validateE2ECompiledRuntimeAdmission({ ...compiled, caseBindings: changedBinding }, snapshot)).toThrow(/source binding differs/);
    const scratch = await mkdtemp("/tmp/e2e-admission-");
    const evidenceDirectory = join(scratch, "runtime-evidence");
    await mkdir(evidenceDirectory, { mode: 0o700 });
    try {
      const selectionPacket = JSON.parse(compiled.files.get(compiled.selectionPacketPath)!) as E2ESelectionPacket;
      const runnerToolchain = { execPath: process.execPath, version: process.version as "v22.23.2", platform: process.platform, arch: process.arch };
      await expect(runE2EActualCli({ compiled, snapshot, selection: selectionPacket, runnerToolchain: { ...runnerToolchain, execPath: `${process.execPath}.foreign` }, hostRequestIds: new Map([[compiled.expectedCases[0]!.caseId, "host-request"]]), sourceRoot: process.cwd(), evidenceDirectory, deadlineAt: Date.now() + 60_000, signal: new AbortController().signal })).rejects.toThrow(/ready-registry Node toolchain identity/);
      expect(await readdir(evidenceDirectory)).toEqual([]);
      await expect(runE2EActualCli({ compiled, snapshot: foreign, selection: selectionPacket, runnerToolchain, hostRequestIds: new Map([[compiled.expectedCases[0]!.caseId, "host-request"]]), sourceRoot: process.cwd(), evidenceDirectory, deadlineAt: Date.now() + 60_000, signal: new AbortController().signal })).rejects.toThrow(/compiler-origin/);
      expect(await readdir(evidenceDirectory)).toEqual([]);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
  it("copies byte views through intrinsic accessors and keeps tree membership independently bounded", () => {
    const backing = Uint8Array.from([0, 1, 2, 3]);
    const copied = copyBoundedE2ESourceBytes(backing.subarray(1, 3), 4);
    backing[1] = 9;
    expect([...copied]).toEqual([1, 2]);
    let getterCalls = 0;
    const getterBytes = Object.defineProperty(Uint8Array.from([1]), "byteLength", { get() { getterCalls += 1; return 1; } });
    expect(() => copyBoundedE2ESourceBytes(getterBytes, 4)).toThrow();
    expect(getterCalls).toBe(0);
    let speciesCalls = 0;
    class HostileBytes extends Uint8Array { static get [Symbol.species]() { speciesCalls += 1; return Uint8Array; } }
    expect(() => copyBoundedE2ESourceBytes(new HostileBytes([1, 2]), 4)).toThrow();
    expect(speciesCalls).toBe(0);
    const paths = Array.from({ length: 16_385 }, (_, index) => `apps/a/${index}`);
    expect(copyBoundedE2ETreePaths(paths)).toHaveLength(16_385);
    expect(copyBoundedE2ETreePaths(Array.from({ length: 100_000 }, (_, index) => `p${index}`))).toHaveLength(100_000);
    expect(() => copyBoundedE2ETreePaths(Array.from({ length: 100_001 }, (_, index) => `p${index}`))).toThrow();
  });
  it("classifies callable aliases and exported data without treating classes or unresolved exports as callable", () => {
    expect(inspectE2EPortableSource("const local = (x) => x; export { local as run };", "src/api.ts").exports).toContainEqual({ name: "run", kind: "callable" });
    expect(inspectE2EPortableSource("export const answer = 42;", "src/api.js").exports).toContainEqual({ name: "answer", kind: "data" });
    expect(inspectE2EPortableSource("export class Client {}", "src/api.ts").exports).toContainEqual({ name: "Client", kind: "data" });
    expect(inspectE2EPortableSource("export { external as run } from './other.js';", "src/api.js").exports).toEqual([]);
    expect(inspectE2EPortableSource("export type { run };", "src/api.ts").exports).toEqual([]);
    expect(inspectE2EPortableSource("export { type run };", "src/api.ts").exports).toEqual([]);
    expect(inspectE2EPortableSource("export default (() =>", "src/api.ts").parseable).toBe(false);
  });
  it("emits the distinct registered source-interface inspector with fixed projection and no candidate invoke call", () => {
    const sourceRegistrationBase = { ...registrationBase, purpose: "source-interface" as const, callableSelector: null, expectedExportNames: ["listRows"] };
    const sourceRegistration = { ...sourceRegistrationBase, descriptorDigest: contractDescriptorDigest(sourceRegistrationBase) };
    const sourceBindingBody = { ...bindingBody, operations: [sourceRegistration] };
    const sourceBinding = { ...sourceBindingBody, bindingDigest: e2EPortableApprovalBindingDigest(sourceBindingBody) };
    const inspectionScenario: E2EScenario = { ...scenario, steps: [{ kind: "inspect-contract", operationId: operation.operationId }], assertions: [{ kind: "state", probeId: "module-export-names", equals: ["listRows"], pollTimeoutMs: 1000 }] };
    const inspectionSelection = { ...selection, scenarios: [inspectionScenario], portableApprovalBinding: sourceBinding };
    const inspectionPlan = selectE2EExecutionPlan(inspectionSelection);
    expect(inspectionPlan.groups[0]?.expectedCases).toHaveLength(1);
    const inspectionGroup = inspectionPlan.groups[0]!;
    const inspectionBundleBody = { schemaVersion: 1 as const, planDigest: inspectionSelection.planDigest, templateVersion: "trusted-e2e/v1", scenarios: [inspectionScenario], bundleDigest: "0".repeat(64) };
    const inspectionBundle = { ...inspectionBundleBody, bundleDigest: e2eScenarioBundleDigest(inspectionBundleBody) };
    const inspectionCompiled = compileE2EScenarios(inspectionBundle, inspectionPlan.effectiveTargets, inspectionGroup, { selectionInput: inspectionSelection, executionPlan: inspectionPlan, group: inspectionGroup });
    const emitted = inspectionCompiled.files.get(".agentx/e2e/generated-contract.test.ts")!;
    expect(emitted).toContain("observation.inspectContract(");
    expect(emitted).toContain('"inspectionProtocol":"registered-module-export-inventory/v1"');
    expect(emitted).toContain('"expectedExportNames":["listRows"]');
    expect(emitted).toContain('"probeId":"module-export-names"');
    expect(emitted).not.toContain("observation.request(");
    const invalidRegistrationBase = { ...sourceRegistrationBase, expectedExportNames: ["missing"] };
    const invalidRegistration = { ...invalidRegistrationBase, descriptorDigest: contractDescriptorDigest(invalidRegistrationBase) };
    const invalidBindingBody = { ...bindingBody, operations: [invalidRegistration] };
    const invalidBinding = { ...invalidBindingBody, bindingDigest: e2EPortableApprovalBindingDigest(invalidBindingBody) };
    const invalidSelection = { ...inspectionSelection, portableApprovalBinding: invalidBinding };
    expect(selectE2EExecutionPlan(invalidSelection).unavailableCriteria.length).toBeGreaterThan(0);
  });
  it("rejects caller-added defaults and extra source references for the synthetic account", () => {
    const injectedAccount = { ...accountContext, fixture: { ...accountContext.fixture, definition: { ...accountContext.fixture.definition, answer: "injected" } } };
    const bindingBodyInjected = { ...bindingBody, accountContexts: [injectedAccount] };
    const bindingInjected = { ...bindingBodyInjected, bindingDigest: e2EPortableApprovalBindingDigest(bindingBodyInjected) };
    expect(() => selectE2EExecutionPlan({ ...selection, portableApprovalBinding: bindingInjected })).toThrow(/canonical minimal profile/);
    const extraRefAccount = { ...accountContext, sourceRefs: [...accountContext.sourceRefs, { path: "apps/shop/src/rows.js", sha256: sources[2]!.sha256 }] };
    const bindingBodyExtraRef = { ...bindingBody, accountContexts: [extraRefAccount] };
    const bindingExtraRef = { ...bindingBodyExtraRef, bindingDigest: e2EPortableApprovalBindingDigest(bindingBodyExtraRef) };
    expect(() => selectE2EExecutionPlan({ ...selection, portableApprovalBinding: bindingExtraRef })).toThrow(/exactly match/);
  });

  it("requires source-backed mock fixtures to match the immutable approval binding", () => {
    const fixture = { schemaVersion: "source-backed-api-fixtures/v1", operationId: "getRows", method: "GET", path: "/api/rows", inputField: "query", variants: [
      { id: "success", inputValue: "ok", status: 200, body: { rows: [] } },
      { id: "refusal", inputValue: "refuse", status: 403, body: { error: "refused" } },
      { id: "invalid-data", inputValue: "bad", status: 200, body: { rows: "bad" } },
    ] };
    const registration = { componentId: "bank-api", requestedTargetId: target.targetId, kind: "api" as const, sourceRefs: [{ path: "apps/shop/openapi.json", sha256: hash("openapi") }], fixture };
    const bindingWithoutFixture = { ...bindingBody, bindingDigest: "0".repeat(64) };
    const bindingWithoutFixtureBody = { ...bindingBody };
    const validUnbound = { ...bindingWithoutFixtureBody, bindingDigest: e2EPortableApprovalBindingDigest(bindingWithoutFixtureBody) };
    expect(() => selectE2EExecutionPlan({ ...selection, mockableComponents: [registration], portableApprovalBinding: validUnbound })).toThrow(/does not match the immutable portable approval binding/);
    const approvedBody = { ...bindingBody, mockFixtures: [registration] };
    const approved = { ...approvedBody, bindingDigest: e2EPortableApprovalBindingDigest(approvedBody) };
    expect(() => selectE2EExecutionPlan({ ...selection, mockableComponents: [registration], portableApprovalBinding: approved })).not.toThrow(/immutable portable approval binding/);
    expect(bindingWithoutFixture.bindingDigest).toHaveLength(64);
  });

  it("requires the richer source fixture to declare synthetic scope without filtering nested business values", () => {
    const fixturePath = "apps/shop/fixtures/alternate-account.json";
    const alternateScenario: E2EScenario = { ...scenario, accountProfileId: "synthetic-alt", steps: [{ kind: "invoke-contract", operationId: operation.operationId, input: { businessInput: { status: "LIVE" } } }] };
    const makeSelection = (definition: Record<string, unknown>) => {
      const fixtureBytes = Buffer.from(JSON.stringify(definition));
      const fixtureSource = { path: fixturePath, bytes: fixtureBytes, sha256: hash(fixtureBytes), kind: "blob" as const };
      const sourceSnapshot: E2ESourceSnapshot = { ...snapshot, treePaths: [...snapshot.treePaths, fixturePath], sources: [...sources, fixtureSource] };
      const alternateAccount = { ...accountContext, contextId: "account-shop-alt", profileId: "synthetic-alt", fixture: { version: "synthetic-fixture/v1" as const, sourcePath: fixturePath, sourceSha256: fixtureSource.sha256, definition }, sourceRefs: [{ path: fixturePath, sha256: fixtureSource.sha256 }] };
      const body = { ...bindingBody, accountContexts: [alternateAccount] };
      const portableApprovalBinding = { ...body, bindingDigest: e2EPortableApprovalBindingDigest(body) };
      const selectionInput = { ...selection, sourceSnapshot, scenarios: [alternateScenario], policy: { ...policy, baselineScenarioIds: [alternateScenario.scenarioId] }, portableApprovalBinding };
      return { sourceSnapshot, selectionInput };
    };
    const validDefinition = { schemaVersion: "synthetic-fixture/v1", scope: "SYNTHETIC", profileId: "synthetic-alt", applicationId: operation.applicationId, preferences: { status: "LIVE" } };
    const valid = makeSelection(validDefinition);
    const plan = selectE2EExecutionPlan(valid.selectionInput);
    const group = plan.groups[0]!;
    const bundleBody = { schemaVersion: 1 as const, planDigest: valid.selectionInput.planDigest, templateVersion: "trusted-e2e/v1", scenarios: [alternateScenario], bundleDigest: "0".repeat(64) };
    const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
    const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput: valid.selectionInput, executionPlan: plan, group });
    expect(compiled.expectedCases).toHaveLength(1);
    expect(compiled.expectedCases[0]?.scenarioId).toBe("s");
    const emittedPayload = compiled.hostRequestPayloads.get(compiled.expectedCases[0]!.caseId);
    expect(emittedPayload).toBeDefined();
    expect(compiled.files.get(".agentx/e2e/generated-contract.test.ts")).toContain(JSON.stringify(emittedPayload));
    expect(emittedPayload).toMatchObject({ expectedExportNames: null });
    const selectionPacket = JSON.parse(compiled.files.get(compiled.selectionPacketPath)!) as E2ESelectionPacket;
    const runBinding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000001", roundId: "a0000000-0000-4000-8000-000000000010", taskId: "task-1", operationId: "operation-1", operationFence: 1, workflowRevision: 1, groupId: group.groupId, executionPlanDigest: plan.digest, executionMode: group.mode, mockManifestDigest: group.mockManifestDigest, authorizationRevision: "auth-1", candidateDigest: plan.candidateDigest, planDigest: plan.planDigest, policyDigest: hash("policy"), bundleDigest: compiled.bundle.bundleDigest, appBuildDigest: hash("build"), environmentDigest: hash("environment"), runtimeManifestDigest: hash("runtime"), modelRouteRevision: null, expectedCases: compiled.expectedCases, admittedAt: "2026-10-13T12:00:00.000Z", deadlineAt: "2026-10-13T12:01:00.000Z" });
    const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId: runBinding.roundId, taskId: runBinding.taskId, operationId: runBinding.operationId, operationFence: runBinding.operationFence, workflowRevision: runBinding.workflowRevision, executionPlanDigest: plan.digest, admittedAt: runBinding.admittedAt, deadlineAt: runBinding.deadlineAt, limits: policy.limits, groupBindings: [runBinding] });
    const oracle = createE2ECollectionOracleFromCompiledSuite({ compiled, binding: runBinding, round, selection: selectionPacket, sourceDigest: hash("source"), launchConfigDigest: compiled.expectedConfigDigest, semanticApprovalDigests: new Map([["s", semanticApproval.digest]]), hostRequestIds: new Map([[compiled.expectedCases[0]!.caseId, "host-request-1"]]), declaredMockComponentIds: [], fixedAssetDigests: { bootstrap: hash("bootstrap") }, environment: { ci: false, trustNoticeShown: true, os: "darwin", arch: "arm64", runtime: "node" }, usage: {}, limits: {} });
    expect(canonicalJson(oracle.cases[0]!.expectedRequest)).toBe(canonicalJson(emittedPayload));
    const mutatedPayload = { ...(emittedPayload as Record<string, unknown>), expectedExportNames: [] };
    const mutatedCompiled = { ...compiled, hostRequestPayloads: new Map([[compiled.expectedCases[0]!.caseId, mutatedPayload]]) };
    expect(() => createE2ECollectionOracleFromCompiledSuite({ compiled: mutatedCompiled, binding: runBinding, round, selection: selectionPacket, sourceDigest: hash("source"), launchConfigDigest: compiled.expectedConfigDigest, semanticApprovalDigests: new Map([["s", semanticApproval.digest]]), hostRequestIds: new Map([[compiled.expectedCases[0]!.caseId, "host-request-1"]]), declaredMockComponentIds: [], fixedAssetDigests: { bootstrap: hash("bootstrap") }, environment: { ci: false, trustNoticeShown: true, os: "darwin", arch: "arm64", runtime: "node" }, usage: {}, limits: {} })).toThrow();
    const { scope: omittedScope, ...missingScopeDefinition } = validDefinition;
    void omittedScope;
    for (const definition of [
      { ...validDefinition, scope: "LIVE" },
      { ...validDefinition, scope: "FOREIGN" },
      missingScopeDefinition,
      { ...validDefinition, scope: 7 },
    ]) {
      const negative = makeSelection(definition);
      expect(() => selectE2EExecutionPlan(negative.selectionInput)).toThrow();
    }
  });

  it("requires an approved scenario association when one operation has multiple callable selectors", () => {
    const firstBase = { ...registrationBase, callableSelector: { kind: "named" as const, exportName: "listRows" } };
    const secondBase = { ...registrationBase, callableSelector: { kind: "named" as const, exportName: "otherRows" } };
    const first = { ...firstBase, descriptorDigest: contractDescriptorDigest(firstBase) };
    const second = { ...secondBase, descriptorDigest: contractDescriptorDigest(secondBase) };
    expect(e2ePortableRegistrationKey(first)).not.toBe(e2ePortableRegistrationKey(second));
    expect(resolveE2EPortableRegistration(scenario, [first, second])).toBeUndefined();
    const selectedKey = e2ePortableRegistrationKey(second);
    expect(resolveE2EPortableRegistration(scenario, [first, second], [{ scenarioId: "s", registrationKey: selectedKey }])?.registration.callableSelector).toEqual(second.callableSelector);
    expect(() => resolveE2EPortableRegistration(scenario, [first, second], [{ scenarioId: "s", registrationKey: "f".repeat(64) }])).toThrow(/does not match/);
  });

  it("binds two explicitly associated named selectors for one operation into their own compiled cases", async () => {
    const moduleBytes = Buffer.from("export const listRows = async(input) => ({ selector: 'listRows', input }); export const otherRows = async(input) => ({ selector: 'otherRows', input });\n");
    const sourceSnapshot = { ...snapshot, sources: snapshot.sources.map((item) => item.path === "apps/shop/src/rows.js" ? { ...item, bytes: moduleBytes, sha256: hash(moduleBytes) } : item) };
    const sourceOperation = inspectE2ERepository(sourceSnapshot, candidate).portableOperations.find((item) => item.operationId === operation.operationId)!;
    const makeRegistration = (exportName: string) => {
      const body = { ...registrationBase, sourceRefs: [...sourceOperation.sourceRefs], callableSelector: { kind: "named" as const, exportName } };
      return { ...body, descriptorDigest: contractDescriptorDigest(body) };
    };
    const first = makeRegistration("listRows");
    const second = makeRegistration("otherRows");
    const secondScenario = { ...scenario, scenarioId: "other", requirementId: "r-other" };
    const scenarios = [scenario, secondScenario];
    const associations = [
      { scenarioId: "s", registrationKey: e2ePortableRegistrationKey(first) },
      { scenarioId: "other", registrationKey: e2ePortableRegistrationKey(second) },
    ];
    const body = { ...bindingBody, operations: [first, second], scenarioRegistrations: associations };
    const portableApprovalBinding = { ...body, bindingDigest: e2EPortableApprovalBindingDigest(body) };
    const selectionInput = { ...selection, sourceSnapshot, scenarios, policy: { ...policy, baselineScenarioIds: ["s", "other"] }, portableApprovalBinding };
    const executionPlan = selectE2EExecutionPlan(selectionInput);
    const group = executionPlan.groups[0]!;
    const bundleBody = { schemaVersion: 1 as const, planDigest: selectionInput.planDigest, templateVersion: "trusted-e2e/v1", scenarios, bundleDigest: "0".repeat(64) };
    const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
    const compiled = compileE2EScenarios(bundle, executionPlan.effectiveTargets, group, { selectionInput, executionPlan, group });
    expect(compiled.caseBindings.get(group.expectedCases.find((item) => item.scenarioId === "s")!.caseId)?.callableSelector).toEqual(first.callableSelector);
    expect(compiled.caseBindings.get(group.expectedCases.find((item) => item.scenarioId === "other")!.caseId)?.callableSelector).toEqual(second.callableSelector);
    expect(new Set([...compiled.caseBindings.values()].map((item) => item.registrationKey)).size).toBe(2);
    const root = await mkdtemp(join(process.cwd(), ".tmp-e2e-selectors-"));
    try {
      for (const [filePath, bytes] of compiled.files) {
        const absolute = join(root, filePath);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, bytes, { flag: "wx" });
      }
      const packet = JSON.parse(await readFile(join(root, compiled.selectionPacketPath), "utf8")) as E2ESelectionPacket;
      const actual = await list({ cwd: root, config: join(root, "e2e.config.json"), env: { CI: "1" } });
      const verified = compareE2EPublicList(packet, actual);
      expect(verified.selected).toHaveLength(2);
      expect(verified.selected.map((item) => item.registrationKey).sort()).toEqual([...compiled.caseBindings.values()].map((item) => item.registrationKey).sort());
      expect(actual.pairs.every((item) => item.disposition !== "skip")).toBe(true);
      const receiptPath = process.env.AGENTX_E2E_SELECTOR_LIST_RECEIPT;
      if (receiptPath) {
        const destination = resolve(receiptPath);
        const evidenceRoot = resolve(`${process.cwd()}-evidence`, "task2b-fix2");
        const relativeDestination = relative(evidenceRoot, destination);
        if (relativeDestination.startsWith(`..${sep}`) || relativeDestination === ".." || resolve(evidenceRoot, relativeDestination) !== destination) throw new Error("selector public-list receipt must remain under the assigned evidence namespace");
        const sourceHashes = Object.fromEntries(sourceSnapshot.sources.map((item) => [item.path, item.sha256]));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, `${JSON.stringify({ evidenceType: "pinned-public-list-observation/v1", upstreamPackage: "e2e@0.20.0", node: process.version, platform: process.platform, arch: process.arch, sourceHashes, inventory: compiled.inventory, packet, actual }, null, 2)}\n`, { flag: "wx" });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("composes inspection and feature registrations for one operation with distinct case identities", () => {
    const sourceRegistrationBase = { ...registrationBase, purpose: "source-interface" as const, callableSelector: null, expectedExportNames: ["listRows"] };
    const sourceRegistration = { ...sourceRegistrationBase, descriptorDigest: contractDescriptorDigest(sourceRegistrationBase) };
    const inspectionScenario: E2EScenario = { ...scenario, scenarioId: "inspect", requirementId: "inspect-r", steps: [{ kind: "inspect-contract", operationId: operation.operationId }], assertions: [{ kind: "state", probeId: "module-export-names", equals: ["listRows"], pollTimeoutMs: 1000 }] };
    const scenarios = [scenario, inspectionScenario];
    const bindingBodyBoth = { ...bindingBody, operations: [registration, sourceRegistration] };
    const bindingBoth = { ...bindingBodyBoth, bindingDigest: e2EPortableApprovalBindingDigest(bindingBodyBoth) };
    const selectionBoth = { ...selection, scenarios, portableApprovalBinding: bindingBoth };
    const planBoth = selectE2EExecutionPlan(selectionBoth);
    const groupBoth = planBoth.groups[0]!;
    const bundleBodyBoth = { schemaVersion: 1 as const, planDigest: selectionBoth.planDigest, templateVersion: "trusted-e2e/v1", scenarios, bundleDigest: "0".repeat(64) };
    const bundleBoth = { ...bundleBodyBoth, bundleDigest: e2eScenarioBundleDigest(bundleBodyBoth) };
    const compiled = compileE2EScenarios(bundleBoth, planBoth.effectiveTargets, groupBoth, { selectionInput: selectionBoth, executionPlan: planBoth, group: groupBoth });
    const generated = compiled.files.get(".agentx/e2e/generated-contract.test.ts")!;
    expect(groupBoth.expectedCases.map((item) => item.scenarioId).sort()).toEqual(["inspect", "s"]);
    expect(generated).toContain("observation.inspectContract(");
    expect(generated).toContain("observation.request(");
    expect(compiled.caseBindings.size).toBe(2);
    expect(new Set([...compiled.caseBindings.values()].map((item) => item.registrationKey)).size).toBe(2);
    expect(generated).toContain('"assertionIndex":1');
  });

  it("retains a source-known unavailable criterion while compiling the supported case in the same group", () => {
    const unavailableScenario: E2EScenario = { ...scenario, scenarioId: "unsupported", requirementId: "r-unsupported" };
    const unsupportedRegistrationBase = { ...registrationBase, callableSelector: { kind: "named" as const, exportName: "notExported" } };
    const unsupportedRegistration = { ...unsupportedRegistrationBase, descriptorDigest: contractDescriptorDigest(unsupportedRegistrationBase) };
    const unsupportedKey = e2ePortableRegistrationKey(unsupportedRegistration);
    const supportedKey = e2ePortableRegistrationKey(registration);
    const scenarios = [scenario, unavailableScenario];
    const bindingBodyMixed = { ...bindingBody, operations: [registration, unsupportedRegistration], scenarioRegistrations: [
      { scenarioId: "s", registrationKey: supportedKey }, { scenarioId: "unsupported", registrationKey: unsupportedKey },
    ] };
    const bindingMixed = { ...bindingBodyMixed, bindingDigest: e2EPortableApprovalBindingDigest(bindingBodyMixed) };
    const selectionMixed = { ...selection, scenarios, policy: { ...policy, baselineScenarioIds: scenarios.map((item) => item.scenarioId) }, portableApprovalBinding: bindingMixed };
    const planMixed = selectE2EExecutionPlan(selectionMixed);
    const groupMixed = planMixed.groups[0]!;
    expect(groupMixed.expectedCases.map((item) => item.scenarioId)).toEqual(["s"]);
    expect(planMixed.unavailableCriteria.some((item) => item.reason.includes("source-validated callable capability"))).toBe(true);
    const bundleBodyMixed = { schemaVersion: 1 as const, planDigest: selectionMixed.planDigest, templateVersion: "trusted-e2e/v1", scenarios, bundleDigest: "0".repeat(64) };
    const bundleMixed = { ...bundleBodyMixed, bundleDigest: e2eScenarioBundleDigest(bundleBodyMixed) };
    const compiled = compileE2EScenarios(bundleMixed, planMixed.effectiveTargets, groupMixed, { selectionInput: selectionMixed, executionPlan: planMixed, group: groupMixed });
    expect(compiled.expectedCases.map((item) => item.scenarioId)).toEqual(["s"]);
    expect(compiled.caseBindings.size).toBe(1);
  });

  it("requires the immutable planner context and emits a distinct selector, per-assertion map, and immutable inventory", () => {
    expect(() => (compileE2EScenarios as unknown as (...args: unknown[]) => unknown)(approvedBundle, plan.effectiveTargets, group)).toThrow();
    const compiled = compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, immutableCompilationContext);
    expect(compiled.expectedCases).toEqual(group.expectedCases);
    expect(compiled.files.has(".agentx/e2e/generated-contract.test.ts")).toBe(true);
    expect(compiled.inventory.files.every((file) => file.sha256 === hash(compiled.files.get(file.path)!))).toBe(true);
    expect(compiled.inventory.upstream.expectedConfigDigest).toBe(compiled.expectedConfigDigest);
    verifyE2ECompiledFileInventory(compiled.files, compiled.inventory);
    const changedFiles = new Map(compiled.files);
    changedFiles.set(".agentx/e2e/generated-contract.test.ts", `${changedFiles.get(".agentx/e2e/generated-contract.test.ts")}\n// mutated`);
    expect(() => verifyE2ECompiledFileInventory(changedFiles, compiled.inventory)).toThrow();
    expect(compiled.caseBindings.get(group.expectedCases[0]!.caseId)?.candidateResponseScope).toBe("contained-candidate-process-response/v1");
    expect(compiled.caseBindings.get(group.expectedCases[0]!.caseId)?.requestProtocol).toBe("contained-candidate-host-request/v1");
    const generated = compiled.files.get(".agentx/e2e/generated-contract.test.ts")!;
    expect(generated).toContain('"packageExportSubpath":"./rows"');
    expect(generated).toContain('"callableSelector":{"kind":"named","exportName":"listRows"}');
    expect(generated).not.toContain("./rows\"]");
    expect(generated).toContain('"assertionIndex":0');
    expect(generated).toContain('"assertionIndex":1');
    expect(generated).toContain("compilerCaseIdentity");
    expect(generated).toContain("contained-candidate-process-response/v1");
  });

  it("rejects a caller-mutated group, target set, bundle, or unregistered named selector", () => {
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, { ...group, groupId: "foreign" }, immutableCompilationContext)).toThrow();
    expect(() => compileE2EScenarios(approvedBundle, [], group, immutableCompilationContext)).toThrow();
    expect(() => compileE2EScenarios({ ...approvedBundle, bundleDigest: "d".repeat(64) }, plan.effectiveTargets, group, immutableCompilationContext)).toThrow();
    const invalidSelectorBase = { ...registrationBase, callableSelector: { kind: "named" as const, exportName: "default" } };
    const invalidSelectorRegistration = { ...invalidSelectorBase, descriptorDigest: contractDescriptorDigest(invalidSelectorBase) };
    const invalidSelectorBindingBody = { ...bindingBody, operations: [invalidSelectorRegistration] };
    const invalidSelectorBinding = { ...invalidSelectorBindingBody, bindingDigest: e2EPortableApprovalBindingDigest(invalidSelectorBindingBody) };
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, { ...immutableCompilationContext, selectionInput: { ...selection, portableApprovalBinding: invalidSelectorBinding } })).toThrow();
    const missingSelector = { kind: "named" as const, exportName: "notExported" };
    const missingSelectorBase = { ...registrationBase, callableSelector: missingSelector };
    const missingSelectorRegistration = { ...missingSelectorBase, descriptorDigest: e2ePortableOperationDescriptorDigest(missingSelectorBase) };
    const missingSelectorBindingBody = { ...bindingBody, operations: [missingSelectorRegistration] };
    const missingSelectorBinding = { ...missingSelectorBindingBody, bindingDigest: e2EPortableApprovalBindingDigest(missingSelectorBindingBody) };
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, { ...immutableCompilationContext,
      selectionInput: { ...selection, portableApprovalBinding: missingSelectorBinding } })).toThrow();
    let getterInvoked = false;
    const hostileContext = Object.defineProperty({ ...immutableCompilationContext }, "selectionInput", { enumerable: true, get() { getterInvoked = true; return selection; } });
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, hostileContext as never)).toThrow(/data properties/);
    expect(getterInvoked).toBe(false);
  });

  it("matches the pinned public list's exact selected result tuple without starting candidate code", async () => {
    const compiled = compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, immutableCompilationContext);
    const root = await mkdtemp(join(process.cwd(), ".tmp-e2e-list-"));
    try {
      for (const [relative, bytes] of compiled.files) {
        const absolute = join(root, relative);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes, { flag: "wx" });
      }
      const packet = JSON.parse(await readFile(join(root, compiled.selectionPacketPath), "utf8")) as E2ESelectionPacket;
      const actual = await list({ cwd: root, config: join(root, "e2e.config.json"), env: { CI: "1" } });
      const verified = compareE2EPublicList(packet, actual);
      expect(verified.selected.map((item) => item.caseId)).toEqual(group.expectedCases.map((item) => item.caseId));
      expect(verified.filtered).toEqual([]);
      expect(actual.pairs.every((item) => item.disposition === "run")).toBe(true);
      const relocated = { ...actual, pairs: actual.pairs.map((item, index) => ({ ...item, source: { ...item.source, line: index + 41, column: 1 } })) };
      expect(compareE2EPublicList(packet, relocated).selected.map((item) => item.caseId)).toEqual(group.expectedCases.map((item) => item.caseId));
      expect(() => compareE2EPublicList(packet, { ...actual, pairs: actual.pairs.map((item, index) => index === 0 ? { ...item, source: { ...item.source, file: "foreign.ts" } } : item) })).toThrow(/source metadata is malformed/);
      expect(() => compareE2EPublicList(packet, { ...actual, pairs: [{ ...actual.pairs[0]!, id: "f".repeat(64) }] })).toThrow(/extra, foreign, or duplicate/);
      let getterInvoked = false;
      const hostileList = Object.defineProperty({}, "pairs", { enumerable: true, get() { getterInvoked = true; return actual.pairs; } });
      expect(() => compareE2EPublicList(packet, hostileList as never)).toThrow();
      expect(getterInvoked).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("matches all three selected tuples and six expected filtered cross-target tuples in the public list", async () => {
    const candidate3 = createCandidateManifest([{ repositoryId: "acme/three-apps", commitSha: "e".repeat(40), treeSha: "f".repeat(40) }]);
    const sources3 = ["one", "two", "three"].flatMap((name) => {
      const packageBytes = Buffer.from(JSON.stringify({ name, scripts: { start: "node app.js" }, exports: { ".": "./src/index.js" } }));
      const moduleBytes = Buffer.from("export default async function(value) { return value; }\n");
      const base = `apps/${name}`;
      const items = [{ path: `${base}/package.json`, bytes: packageBytes, sha256: hash(packageBytes), kind: "blob" as const }, { path: `${base}/src/index.js`, bytes: moduleBytes, sha256: hash(moduleBytes), kind: "blob" as const }];
      if (name === "one") {
        const fixture = Buffer.from(JSON.stringify({ schemaVersion: "synthetic-fixture/v1", scope: "SYNTHETIC", profileId: "synthetic-alt", applicationId: "one" }));
        items.push({ path: `${base}/fixtures/alternate-account.json`, bytes: fixture, sha256: hash(fixture), kind: "blob" as const });
      }
      return items;
    });
    const snapshot3: E2ESourceSnapshot = { candidate: candidate3, commitSha: "e".repeat(40), treeSha: "f".repeat(40), treeComplete: true, treePaths: sources3.map((item) => item.path), sources: sources3 };
    const discovered3 = inspectE2ERepository(snapshot3, candidate3);
    const targets3 = discovered3.inspection.proposedTargets.filter((item) => item.kind === "web" && item.accountProfileId !== "rovara-anonymous");
    const operations3 = discovered3.portableOperations;
    const scenarios3: E2EScenario[] = targets3.map((item, index) => ({ scenarioId: `s${index}`, requirementId: `r${index}`, requestedTargetIds: [item.targetId], required: true, accountProfileId: item.accountProfileId, minimumEvidence: "mock-contract", requiredRealComponentIds: [], steps: [{ kind: "invoke-contract", operationId: operations3.find((operationItem) => operationItem.applicationId === item.applicationId)!.operationId, input: { app: item.applicationId } }], assertions: [{ kind: "state", probeId: "result", equals: { app: item.applicationId }, pollTimeoutMs: 500 }] }));
    scenarios3.push({ ...scenarios3[0]!, scenarioId: "s-one-alt-account", requirementId: "r-one-alt-account", accountProfileId: "synthetic-alt" });
    const policy3: E2EPolicy = { ...policy, baselineScenarioIds: scenarios3.map((item) => item.scenarioId), targets: targets3 };
    const { portableApprovalBinding: previousBinding, approvedSemanticApproval: previousApproval, ...unboundSelection } = selection;
    void previousBinding;
    void previousApproval;
    const selection3 = { ...unboundSelection, candidateDigest: candidate3.digest, expectedCandidate: candidate3, sourceSnapshot: snapshot3, policy: policy3, scenarios: scenarios3, selectedTargetIds: targets3.map((item) => item.targetId) };
    const bundle3Body = { schemaVersion: 1 as const, planDigest: selection3.planDigest, templateVersion: "trusted-e2e/v1", scenarios: scenarios3, bundleDigest: "0".repeat(64) };
    const bundle3 = { ...bundle3Body, bundleDigest: e2eScenarioBundleDigest(bundle3Body) };
    const registrations3 = operations3.map((operationItem) => {
      const selector = { kind: "default" as const };
      const registrationBase3 = { operationId: operationItem.operationId, applicationId: operationItem.applicationId, packageExportSubpath: operationItem.exportName, moduleSpecifier: "./src/index.js", callableSelector: selector, expectedExportNames: null, purpose: "feature-invocation" as const, schemaVersion: "portable-source-operation/v1" as const, sourceRefs: [...operationItem.sourceRefs] };
      return { ...registrationBase3, descriptorDigest: contractDescriptorDigest(registrationBase3) };
    });
    const semanticApproval3 = { artifactId: "sem-three-apps", digest: hash("approved three app semantics") };
    const accounts3: E2EPortableApprovalBinding["accountContexts"] = targets3.map((item) => {
      const manifestSource = sources3.find((sourceItem) => sourceItem.path === `apps/${item.applicationId}/package.json`)!;
      return { schemaVersion: "synthetic-account-context/v1" as const, contextId: `account-${item.applicationId}`, profileId: item.accountProfileId, applicationId: item.applicationId, scope: "SYNTHETIC" as const,
        fixture: { version: "synthetic-fixture/v1" as const, sourcePath: manifestSource.path, sourceSha256: manifestSource.sha256, definition: e2EDefaultSyntheticAccountDefinition(item.applicationId, item.accountProfileId) },
      sourceRefs: [{ path: manifestSource.path, sha256: manifestSource.sha256 }], approval: { ...semanticApproval3, planDigest: selection3.planDigest } };
    });
    const alternateFixture = sources3.find((item) => item.path === "apps/one/fixtures/alternate-account.json")!;
    const alternateDefinition = JSON.parse(alternateFixture.bytes.toString("utf8")) as { schemaVersion: "synthetic-fixture/v1"; scope: "SYNTHETIC"; profileId: string; applicationId: string };
    accounts3.push({ schemaVersion: "synthetic-account-context/v1", contextId: "account-one-synthetic-alt", profileId: "synthetic-alt", applicationId: "one", scope: "SYNTHETIC",
      fixture: { version: "synthetic-fixture/v1", sourcePath: alternateFixture.path, sourceSha256: alternateFixture.sha256, definition: alternateDefinition },
      sourceRefs: [{ path: alternateFixture.path, sha256: alternateFixture.sha256 }], approval: { ...semanticApproval3, planDigest: selection3.planDigest } });
    const bindingBody3 = { schemaVersion: "portable-approval-binding/v1" as const, planDigest: selection3.planDigest, semanticApproval: semanticApproval3, operations: registrations3, accountContexts: accounts3 };
    const binding3 = { ...bindingBody3, bindingDigest: e2EPortableApprovalBindingDigest(bindingBody3) };
    const selection3Bound = { ...selection3, portableApprovalBinding: binding3, approvedSemanticApproval: semanticApproval3 };
    const plan3Bound = selectE2EExecutionPlan(selection3Bound);
    const group3Bound = plan3Bound.groups[0]!;
    const context3: E2EImmutableCompilationContext = { selectionInput: selection3Bound, executionPlan: plan3Bound, group: group3Bound };
    const compiled3 = compileE2EScenarios(bundle3, plan3Bound.effectiveTargets, group3Bound, context3);
    const root = await mkdtemp(join(process.cwd(), ".tmp-e2e-list-three-"));
    try {
      for (const [relative, bytes] of compiled3.files) {
        const absolute = join(root, relative);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes, { flag: "wx" });
      }
      const packet = JSON.parse(await readFile(join(root, compiled3.selectionPacketPath), "utf8")) as E2ESelectionPacket;
      const actual = await list({ cwd: root, config: join(root, "e2e.config.json"), env: { CI: "1" } });
      const evidenceRoot = join(`${process.cwd()}-evidence`, "task2b-fix2");
      const receiptPath = process.env.AGENTX_E2E_LIST_RECEIPT;
      if (receiptPath) {
        const destination = resolve(receiptPath);
        const relativeDestination = relative(evidenceRoot, destination);
        if (relativeDestination.startsWith(`..${sep}`) || relativeDestination === ".." || resolve(evidenceRoot, relativeDestination) !== destination) throw new Error("public-list evidence destination must remain under the assigned evidence directory");
        const sourcePaths = ["upstream/e2e-0.20.0.tgz", "package-lock.json", "node_modules/e2e/dist/runner.js", "node_modules/e2e/dist/internal/ids.js", "node_modules/e2e/dist/config/resolve.js", "node_modules/e2e/dist/config/targets.js"];
        const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [path, hash(await readFile(join(process.cwd(), path)))] as const)));
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, `${JSON.stringify({ evidenceType: "pinned-public-list-observation/v1", upstreamPackage: "e2e@0.20.0", node: process.version, platform: process.platform, arch: process.arch, sanitizedEnvironment: { CI: "1" }, sourceHashes, generatedInventory: compiled3.inventory, expectedConfigDigestProjection: compiled3.expectedConfigDigest, packet, actual }, null, 2)}\n`, { flag: "wx" });
      }
      const verified = compareE2EPublicList(packet, actual);
      expect(verified.selected).toHaveLength(4);
      expect(verified.filtered).toHaveLength(8);
      expect(actual.pairs.filter((item) => item.disposition === "skip")).toHaveLength(0);
      const run = actual.pairs.find((pair) => pair.disposition === "run")!;
      const filtered = actual.pairs.find((pair) => pair.disposition === "filtered")!;
      const swapped = actual.pairs.map((pair) => pair === run ? { ...pair, disposition: "filtered" } : pair === filtered ? { ...pair, disposition: "run" } : pair);
      expect(() => compareE2EPublicList(packet, { ...actual, pairs: swapped })).toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

});
