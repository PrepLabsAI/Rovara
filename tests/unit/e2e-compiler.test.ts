import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { list } from "e2e/runner";
import { canonicalJson, createCandidateManifest, e2eScenarioBundleDigest, type E2EPolicy, type E2EScenario, type E2ESourceSnapshot } from "@agentx/contracts";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { compileE2EScenarios, type E2EImmutableCompilationContext } from "../../packages/verifier/src/scenarios.js";
import { E2E_CANDIDATE_RESPONSE_PROTOCOL } from "../../packages/verifier/src/identity.js";
import { e2ePortableOperationDescriptorDigest } from "../../packages/verifier/src/templates.js";
import { compareE2EPublicList } from "../../packages/verifier/src/selection.js";
import { verifyE2ECompiledFileInventory } from "../../packages/verifier/src/identity.js";

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
const selection = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest: "c".repeat(64), policy, scenarios: [scenario], selectedTargetIds: [target.targetId], sandboxAvailability: sandbox, runtimeAvailability: [] };
const plan = selectE2EExecutionPlan(selection);
const group = plan.groups[0]!;
const bundle = { schemaVersion: 1 as const, planDigest: selection.planDigest, templateVersion: "trusted-e2e/v1", scenarios: [scenario], bundleDigest: "0".repeat(64) };
const approvedBundle = { ...bundle, bundleDigest: e2eScenarioBundleDigest(bundle) };
const callableSelector = { kind: "named" as const, exportName: "listRows" };
const registrationBase = { operationId: operation.operationId, applicationId: operation.applicationId, packageExportSubpath: operation.exportName,
  moduleSpecifier: "./src/rows.js", callableSelector, schemaVersion: "portable-source-operation/v1" as const };
const registration = { ...registrationBase, descriptorDigest: e2ePortableOperationDescriptorDigest(registrationBase, operation.sourceRefs[0]!) };
const selectors = [{ operationId: operation.operationId, callableSelector }];
const deltaBody = { schemaVersion: "portable-export-delta/v1" as const, id: "delta-r1", responseProtocol: E2E_CANDIDATE_RESPONSE_PROTOCOL, selectors };
const immutableCompilationContext: E2EImmutableCompilationContext = { selectionInput: selection, executionPlan: plan, group, purpose: "feature-invocation",
  registeredOperations: [registration],
  approvedSemanticDelta: { ...deltaBody, digest: hash(canonicalJson(deltaBody)) } };

describe("trusted E2E compiler", () => {
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
    expect(compiled.caseBindings.get(group.expectedCases[0]!.caseId)?.requestProtocol).toBe("supervisor-admitted-json-request/v1");
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
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, { ...immutableCompilationContext,
      registeredOperations: [{ ...immutableCompilationContext.registeredOperations[0]!, callableSelector: { kind: "named", exportName: "default" } as const }] })).toThrow();
    const missingSelector = { kind: "named" as const, exportName: "notExported" };
    const missingSelectorBase = { ...registrationBase, callableSelector: missingSelector };
    const missingSelectorRegistration = { ...missingSelectorBase, descriptorDigest: e2ePortableOperationDescriptorDigest(missingSelectorBase, operation.sourceRefs[0]!) };
    const missingSelectorDelta = { ...deltaBody, id: "delta-missing-selector", selectors: [{ operationId: operation.operationId, callableSelector: missingSelector }] };
    expect(() => compileE2EScenarios(approvedBundle, plan.effectiveTargets, group, { ...immutableCompilationContext,
      registeredOperations: [missingSelectorRegistration], approvedSemanticDelta: { ...missingSelectorDelta, digest: hash(canonicalJson(missingSelectorDelta)) } })).toThrow(/declared by the verified source module/);
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
      const packet = JSON.parse(await readFile(join(root, compiled.selectionPacketPath), "utf8"));
      const actual = await list({ cwd: root, config: join(root, "e2e.config.json"), env: { CI: "1" } });
      const verified = compareE2EPublicList(packet, actual);
      expect(verified.selected.map((item) => item.caseId)).toEqual(group.expectedCases.map((item) => item.caseId));
      expect(verified.filtered).toEqual([]);
      expect(actual.pairs.every((item) => item.disposition === "run")).toBe(true);
      expect(() => compareE2EPublicList(packet, { ...actual, pairs: [{ ...actual.pairs[0]!, id: "f".repeat(64) }] })).toThrow(/extra, foreign, or duplicate/);
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
      return [{ path: `${base}/package.json`, bytes: packageBytes, sha256: hash(packageBytes), kind: "blob" as const }, { path: `${base}/src/index.js`, bytes: moduleBytes, sha256: hash(moduleBytes), kind: "blob" as const }];
    });
    const snapshot3: E2ESourceSnapshot = { candidate: candidate3, commitSha: "e".repeat(40), treeSha: "f".repeat(40), treeComplete: true, treePaths: sources3.map((item) => item.path), sources: sources3 };
    const discovered3 = inspectE2ERepository(snapshot3, candidate3);
    const targets3 = discovered3.inspection.proposedTargets.filter((item) => item.kind === "web");
    const operations3 = discovered3.portableOperations;
    const scenarios3: E2EScenario[] = targets3.map((item, index) => ({ scenarioId: `s${index}`, requirementId: `r${index}`, requestedTargetIds: [item.targetId], required: true, accountProfileId: item.accountProfileId, minimumEvidence: "mock-contract", requiredRealComponentIds: [], steps: [{ kind: "invoke-contract", operationId: operations3.find((operationItem) => operationItem.applicationId === item.applicationId)!.operationId, input: { app: item.applicationId } }], assertions: [{ kind: "state", probeId: "result", equals: { app: item.applicationId }, pollTimeoutMs: 500 }] }));
    const policy3: E2EPolicy = { ...policy, baselineScenarioIds: scenarios3.map((item) => item.scenarioId), targets: targets3 };
    const selection3 = { ...selection, candidateDigest: candidate3.digest, expectedCandidate: candidate3, sourceSnapshot: snapshot3, policy: policy3, scenarios: scenarios3, selectedTargetIds: targets3.map((item) => item.targetId) };
    const plan3 = selectE2EExecutionPlan(selection3);
    const group3 = plan3.groups[0]!;
    const bundle3Body = { schemaVersion: 1 as const, planDigest: selection3.planDigest, templateVersion: "trusted-e2e/v1", scenarios: scenarios3, bundleDigest: "0".repeat(64) };
    const bundle3 = { ...bundle3Body, bundleDigest: e2eScenarioBundleDigest(bundle3Body) };
    const registrations3 = operations3.map((operationItem) => {
      const selector = { kind: "default" as const };
      const registrationBase3 = { operationId: operationItem.operationId, applicationId: operationItem.applicationId, packageExportSubpath: operationItem.exportName, moduleSpecifier: "./src/index.js", callableSelector: selector, schemaVersion: "portable-source-operation/v1" as const };
      return { ...registrationBase3, descriptorDigest: e2ePortableOperationDescriptorDigest(registrationBase3, operationItem.sourceRefs[0]!) };
    });
    const selectors3 = registrations3.map((item) => ({ operationId: item.operationId, callableSelector: item.callableSelector }));
    const deltaBody3 = { schemaVersion: "portable-export-delta/v1" as const, id: "delta-three-apps", responseProtocol: E2E_CANDIDATE_RESPONSE_PROTOCOL, selectors: selectors3 };
    const context3: E2EImmutableCompilationContext = { selectionInput: selection3, executionPlan: plan3, group: group3, purpose: "feature-invocation", registeredOperations: registrations3, approvedSemanticDelta: { ...deltaBody3, digest: hash(canonicalJson(deltaBody3)) } };
    const compiled3 = compileE2EScenarios(bundle3, plan3.effectiveTargets, group3, context3);
    const root = await mkdtemp(join(process.cwd(), ".tmp-e2e-list-three-"));
    try {
      for (const [relative, bytes] of compiled3.files) {
        const absolute = join(root, relative);
        await mkdir(join(absolute, ".."), { recursive: true });
        await writeFile(absolute, bytes, { flag: "wx" });
      }
      const packet = JSON.parse(await readFile(join(root, compiled3.selectionPacketPath), "utf8"));
      const actual = await list({ cwd: root, config: join(root, "e2e.config.json"), env: { CI: "1" } });
      const evidenceRoot = join(`${process.cwd()}-evidence`, "task2b");
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
      expect(verified.selected).toHaveLength(3);
      expect(verified.filtered).toHaveLength(6);
      expect(actual.pairs.filter((item) => item.disposition === "skip")).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
