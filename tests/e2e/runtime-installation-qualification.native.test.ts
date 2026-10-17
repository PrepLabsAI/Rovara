import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "../../packages/broker/src/aws/runtime-installation.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { qualifyInstalledP0Runtime } from "@agentx/verifier";
import { createCandidateManifest, e2eScenarioBundleDigest, e2EDefaultSyntheticAccountDefinition, e2EPortableApprovalBindingDigest, e2ePortableOperationDescriptorDigest, ProjectSetupRunnerToolchainSchema, type E2EPolicy, type E2EScenario, type E2ESourceSnapshot } from "../../packages/contracts/src/index.js";
import { inspectE2ERepository } from "../../packages/broker/src/e2e/discovery.js";
import { selectE2EExecutionPlan } from "../../packages/broker/src/e2e/execution-plan.js";
import { compileE2EScenarios, type E2EImmutableCompilationContext } from "../../packages/verifier/src/scenarios.js";
import { runE2EActualCli } from "../../packages/verifier/src/runtime-cli.js";
import type { E2ESelectionPacket } from "../../packages/verifier/src/selection.js";

const admin: AuthenticatedIdentity = { issuer: "native-p0", subject: "explicit-test-admin", ownerKey: "native-p0-admin", isAdministrator: true, claims: {} };
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

describe("installed P0 runtime qualification on the current native supervisor", () => {
  it("runs the actual installed positive and negative probes before the Linux registrar rejects this Darwin host", async () => {
    const evidenceRoot = process.env.P0_RUNTIME_INSTALL_EVIDENCE_DIR;
    expect(evidenceRoot, "P0_RUNTIME_INSTALL_EVIDENCE_DIR must be a fresh private external evidence root").toBeDefined();
    const root = resolve(evidenceRoot!);
    const info = await lstat(root);
    expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
    expect(info.uid).toBe(process.getuid?.());
    expect(info.mode & 0o077).toBe(0);
    expect(await realpath(root)).toBe(root);
    expect(basename(dirname(root))).toBe("AgentX-e2e-p0-20261012-evidence");
    const tmpRoot = await realpath(resolve(process.env.TMPDIR ?? "/tmp"));
    expect(root.startsWith(`${tmpRoot}/`)).toBe(false);

    const rows = new Map<string, Record<string, unknown>>();
    const documentClient = { send: async (command: unknown) => {
      const input = (command as { input?: Record<string, unknown> }).input ?? {};
      if (input.Item && typeof input.Item === "object") {
        const item = input.Item as Record<string, unknown>;
        rows.set(`${String(item.pk)}|${String(item.sk)}`, item);
        return {};
      }
      if (input.Key && typeof input.Key === "object") {
        const key = input.Key as Record<string, unknown>;
        return { Item: rows.get(`${String(key.pk)}|${String(key.sk)}`) };
      }
      throw new Error("native Darwin rejection test must not read or update runtime catalogs");
    } };
    const deps = { documentClient, s3: { send: async () => { throw new Error("wrong-host proof must be rejected before artifact storage"); } }, tableName: "runtime-test-state", artifactBucketName: "runtime-test-artifacts", setupCatalogId: "native-setup", featureCatalogId: "native-feature", now: () => Date.now() } as unknown as RuntimeInstallationDependencies;
    const challenge = await issueRuntimeInstallChallenge(deps, admin, {
      binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" },
      endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), profileId: "darwin-arm64-colima-v1",
    });
    expect(rows.size).toBe(1);

    const proposal = await qualifyInstalledP0Runtime({ challenge, evidenceRoot: root });
    expect(proposal.challenge.challengeId).toBe(challenge.challengeId);
    expect(proposal.probes.map((probe) => [probe.probeId, probe.observedOutcome])).toEqual([
      ["source-interface-positive/v1", "PASS"], ["process-response-positive/v1", "PASS"], ["process-response-negative/v1", "EXPECTED_FAILURE"],
    ]);
    expect(proposal.probes.every((probe) => probe.captures.every((capture) => sha(Buffer.from(capture.bytesBase64, "base64")) === capture.sha256))).toBe(true);
    expect(proposal.manifest.entries.some((entry) => entry.path === "packages/verifier/assets/runtime-installation/probe-oracle.json")).toBe(true);
    expect(proposal.runnerToolchain).toMatchObject({ version: "v22.23.2", platform: "darwin", arch: "arm64" });
    expect(challenge.profileId).toBe("darwin-arm64-colima-v1");

    await expect(registerRuntimeInstallation(deps, admin, { proposal, proposalSha256: createHash("sha256").update(canonicalJson(proposal)).digest("hex") })).rejects.toThrow(/Linux ARM64 worker supervisor/);
    expect([...rows.values()].filter((row) => row.entityType === "RUNTIME_INSTALL_CHALLENGE" && row.state === "ISSUED")).toHaveLength(1);
    expect([...rows.values()].some((row) => row.entityType === "PROJECT_SETUP_RUNTIME" || row.entityType === "E2E_FEATURE_VERIFIER")).toBe(false);
  }, 120_000);
});

describe("actual native runtime assertion-mode wiring", () => {
  it("keeps inventory-shaped feature JSON literal through the pinned CLI callback", async () => {
    const evidenceRoot = process.env.P2_RUNTIME_ASSERTION_EVIDENCE_DIR ?? process.env.P0_RUNTIME_INSTALL_EVIDENCE_DIR;
    expect(evidenceRoot, "P2_RUNTIME_ASSERTION_EVIDENCE_DIR or P0_RUNTIME_INSTALL_EVIDENCE_DIR must name a private evidence root").toBeDefined();
    const root = resolve(evidenceRoot!);
    const rootInfo = await lstat(root);
    expect(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && rootInfo.uid === process.getuid?.() && (rootInfo.mode & 0o077) === 0).toBe(true);
    expect(await realpath(root)).toBe(root);
    expect(basename(dirname(root))).toBe("AgentX-e2e-p0-20261012-evidence");
    const evidenceDirectory = join(root, `runtime-assertion-${randomUUID()}`);
    await mkdir(evidenceDirectory, { mode: 0o700 });

    const inventory = { protocol: "registered-module-export-inventory/v1", exports: [{ name: "hello", kind: "callable" }] };
    const manifestBytes = Buffer.from(JSON.stringify({ name: "runtime-assertion", scripts: { start: "node app.js" }, exports: { ".": "./src/index.js", "./feature": "./src/feature.js" } }));
    const sourceBytes = Buffer.from("export default async function(input) { return input; }\n");
    const featureBytes = Buffer.from("export const hello = async(input) => input;\n");
    const sources = [
      { path: "apps/shop/package.json", bytes: manifestBytes, sha256: sha(manifestBytes), kind: "blob" as const },
      { path: "apps/shop/src/index.js", bytes: sourceBytes, sha256: sha(sourceBytes), kind: "blob" as const },
      { path: "apps/shop/src/feature.js", bytes: featureBytes, sha256: sha(featureBytes), kind: "blob" as const },
    ];
    const candidate = createCandidateManifest([{ repositoryId: "runtime-assertion/shop", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
    const snapshot: E2ESourceSnapshot = { candidate, commitSha: "a".repeat(40), treeSha: "b".repeat(40), treeComplete: true, treePaths: sources.map((source) => source.path), sources };
    const inspected = inspectE2ERepository(snapshot, candidate);
    const operation = inspected.portableOperations.find((item) => item.exportName === "./feature")!;
    const target = inspected.inspection.proposedTargets.find((item) => item.kind === "web")!;
    const scenario: E2EScenario = { scenarioId: "literal-feature", requirementId: "literal-feature", requestedTargetIds: [target.targetId], required: true,
      accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [],
      steps: [{ kind: "invoke-contract", operationId: operation.operationId, input: inventory }],
      assertions: [{ kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: inventory }] };
    const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: [scenario.scenarioId],
      targets: [target], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
      capture: { screenshots: false, traces: false, video: false, downloads: false },
      limits: { runTimeoutMs: 120_000, startupTimeoutMs: 30_000, preparationTimeoutMs: 30_000, caseTimeoutMs: 60_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000, maxSpendUsd: null } };
    const sandboxAvailability = { targetId: "default-sandbox" as const, profileId: "default-sandbox", connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "native-test" };
    const semanticApproval = { artifactId: "runtime-assertion-approval", digest: sha("runtime assertion approval") };
    const operationBase = { operationId: operation.operationId, applicationId: operation.applicationId, packageExportSubpath: operation.exportName,
      moduleSpecifier: "./src/feature.js", callableSelector: { kind: "named" as const, exportName: "hello" }, expectedExportNames: null,
      purpose: "feature-invocation" as const, schemaVersion: "portable-source-operation/v1" as const, sourceRefs: [...operation.sourceRefs] };
    const registration = { ...operationBase, descriptorDigest: e2ePortableOperationDescriptorDigest(operationBase) };
    const accountContext = { schemaVersion: "synthetic-account-context/v1" as const, contextId: "runtime-assertion-account", profileId: "synthetic", applicationId: operation.applicationId, scope: "SYNTHETIC" as const,
      fixture: { version: "synthetic-fixture/v1" as const, sourcePath: operation.manifestPath, sourceSha256: sources[0]!.sha256, definition: e2EDefaultSyntheticAccountDefinition(operation.applicationId, "synthetic") },
      sourceRefs: [{ path: operation.manifestPath, sha256: sources[0]!.sha256 }], approval: { ...semanticApproval, planDigest: "c".repeat(64) } };
    const bindingBody = { schemaVersion: "portable-approval-binding/v1" as const, planDigest: "c".repeat(64), semanticApproval, operations: [registration], accountContexts: [accountContext] };
    const portableApprovalBinding = { ...bindingBody, bindingDigest: e2EPortableApprovalBindingDigest(bindingBody) };
    const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest: "c".repeat(64), policy, scenarios: [scenario],
      selectedTargetIds: [target.targetId], sandboxAvailability, runtimeAvailability: [], portableApprovalBinding, approvedSemanticApproval: semanticApproval };
    const plan = selectE2EExecutionPlan(selectionInput);
    const group = plan.groups[0]!;
    const bundleBody = { schemaVersion: 1 as const, planDigest: selectionInput.planDigest, templateVersion: "trusted-e2e/v1", scenarios: [scenario], bundleDigest: "0".repeat(64) };
    const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
    const context: E2EImmutableCompilationContext = { selectionInput, executionPlan: plan, group };
    const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, context);
    const selectionPacket = JSON.parse(compiled.files.get(compiled.selectionPacketPath)!) as E2ESelectionPacket;
    const caseId = compiled.expectedCases[0]!.caseId;
    const hostRequestIds = new Map([[caseId, `native-${randomUUID()}`]]);
    const runnerToolchain = ProjectSetupRunnerToolchainSchema.parse({ execPath: process.execPath, version: process.version, platform: process.platform, arch: process.arch });
    const run = await runE2EActualCli({ compiled, snapshot, selection: selectionPacket, runnerToolchain, hostRequestIds, sourceRoot: process.cwd(),
      evidenceDirectory, deadlineAt: Date.now() + 120_000, signal: new AbortController().signal });
    expect(run.assertionReceipts).toHaveLength(1);
    expect(run.assertionReceipts[0]).toMatchObject({ outcome: "passed" });
  }, 180_000);
});
