import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { networkInterfaces, release as osRelease } from "node:os";
import { join, resolve } from "node:path";
import {
  canonicalJson, createCandidateManifest, e2EDefaultSyntheticAccountDefinition, e2EPortableApprovalBindingDigest, runtimeInstallChallengeDigest,
  e2eScenarioBundleDigest, e2ePortableOperationDescriptorDigest, inspectE2ERepository, selectE2EExecutionPlan,
  type E2EPolicy, type E2EScenario, type E2ESourceSnapshot, type RuntimeInstallChallenge,
  RuntimeInstallChallengeSchema, RuntimeInstallationProposalSchema,
  WEB_API_REQUIRED_PROBES, WEB_API_RUNTIME_PROFILE_ID, WEB_API_RUNTIME_SCOPE, WebApiProbeObservationSchema, WebApiRuntimeInstallProposalSchema,
  evaluateWebApiProbeObservation, type WebApiProbeObservation, type WebApiRuntimeInstallProposal,
} from "@agentx/contracts";
import { compileE2EScenarios, type E2EImmutableCompilationContext } from "./scenarios.js";
import { runE2EActualCli } from "./runtime-cli.js";
import { parseE2EReport } from "./result-adapter.js";
import { CONTAINED_IMAGE, CONTAINED_RUNTIME_PROFILE, inspectContainedRuntimeReadinessForHost } from "./contained-candidate.js";
import { observeInstalledRuntimeManifestForHost, type InstalledRuntimeManifest } from "./installed-runtime-manifest.js";
import { loadWebApiQualificationProbeAssets } from "./application-runtime-probes.js";
import type { E2ESelectionPacket } from "./selection.js";

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
type ProbeOracle = {
  schemaVersion: "runtime-install-probe-oracle/v1";
  source: { protocol: string; exports: Array<{ name: string; kind: string }> };
  feature: { inputPositive: Record<string, JsonValue>; inputNegative: Record<string, JsonValue>; output: JsonValue; negativeAssertion: JsonValue };
};
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

async function loadOracle(installedRuntimeRoot: string): Promise<ProbeOracle> {
  const path = join(installedRuntimeRoot, "packages/verifier/assets/runtime-installation/probe-oracle.json");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error("installed runtime qualification oracle is missing or is not a canonical regular file");
  const oracle = JSON.parse(await readFile(path, "utf8")) as ProbeOracle;
  if (oracle.schemaVersion !== "runtime-install-probe-oracle/v1") throw new Error("installed runtime qualification oracle version is unsupported");
  return oracle;
}

function preparedSuite(oracle: ProbeOracle) {
  const candidate = createCandidateManifest([{ repositoryId: "agentx/runtime-install-qualification", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const files = [
    { path: "apps/qualification/package.json", bytes: Buffer.from(JSON.stringify({ name: "runtime-install-qualification", exports: { "./rows": "./src/rows.js" } })) },
    { path: "apps/qualification/src/rows.js", bytes: Buffer.from("export const listRows = async() => ({ rows: [1] });\nexport const otherRows = async() => ({ rows: [2] });\n") },
  ].map((file) => ({ ...file, sha256: sha(file.bytes), kind: "blob" as const }));
  const snapshot: E2ESourceSnapshot = { candidate, commitSha: candidate.repositories[0]!.commitSha, treeSha: candidate.repositories[0]!.treeSha, treeComplete: true, treePaths: files.map((file) => file.path), sources: files };
  const inspection = inspectE2ERepository(snapshot, candidate);
  const target = inspection.inspection.proposedTargets.find((item) => item.kind === "web");
  const operation = inspection.portableOperations.find((item) => item.exportName === "./rows");
  if (!target || !operation) throw new Error("fixed installed runtime qualification fixture is unsupported by the compiler");
  const callableSelector = { kind: "named" as const, exportName: "listRows" };
  const registrationBase = { operationId: operation.operationId, applicationId: operation.applicationId, packageExportSubpath: operation.exportName,
    moduleSpecifier: "./src/rows.js", callableSelector, expectedExportNames: null, purpose: "feature-invocation" as const,
    schemaVersion: "portable-source-operation/v1" as const, sourceRefs: [...operation.sourceRefs] };
  const featureRegistration = { ...registrationBase, descriptorDigest: e2ePortableOperationDescriptorDigest(registrationBase) };
  const sourceRegistrationBase = { ...registrationBase, callableSelector: null, expectedExportNames: oracle.source.exports.map((item) => item.name), purpose: "source-interface" as const };
  const sourceRegistration = { ...sourceRegistrationBase, descriptorDigest: e2ePortableOperationDescriptorDigest(sourceRegistrationBase) };
  const semanticApproval = { artifactId: "runtime-install-qualification/v1", digest: sha("fixed runtime installation qualification semantic approval") };
  const accountContext = { schemaVersion: "synthetic-account-context/v1" as const, contextId: "runtime-install-synthetic-account", profileId: "synthetic", applicationId: operation.applicationId, scope: "SYNTHETIC" as const,
    fixture: { version: "synthetic-fixture/v1" as const, sourcePath: operation.manifestPath, sourceSha256: files[0]!.sha256, definition: e2EDefaultSyntheticAccountDefinition(operation.applicationId, "synthetic") },
    sourceRefs: [{ path: operation.manifestPath, sha256: files[0]!.sha256 }], approval: { ...semanticApproval, planDigest: "c".repeat(64) } };
  const bindingBody = { schemaVersion: "portable-approval-binding/v1" as const, planDigest: "c".repeat(64), semanticApproval, operations: [sourceRegistration, featureRegistration], accountContexts: [accountContext] };
  const portableApprovalBinding = { ...bindingBody, bindingDigest: e2EPortableApprovalBindingDigest(bindingBody) };
  const scenarios: E2EScenario[] = [
    { scenarioId: "runtime-source-interface", requirementId: "installed-runtime-source-interface", requestedTargetIds: [target.targetId], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [],
      steps: [{ kind: "inspect-contract", operationId: operation.operationId }], assertions: [{ kind: "state", probeId: "module-export-names", equals: oracle.source.exports.map((item) => item.name), pollTimeoutMs: 1000 }] },
    { scenarioId: "runtime-feature-positive", requirementId: "installed-runtime-feature-positive", requestedTargetIds: [target.targetId], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [],
      steps: [{ kind: "invoke-contract", operationId: operation.operationId, input: structuredClone(oracle.feature.inputPositive) }], assertions: [{ kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: structuredClone(oracle.feature.output) }] },
    { scenarioId: "runtime-feature-negative", requirementId: "installed-runtime-feature-negative", requestedTargetIds: [target.targetId], required: true, accountProfileId: "synthetic", minimumEvidence: "mock-contract", requiredRealComponentIds: [],
      steps: [{ kind: "invoke-contract", operationId: operation.operationId, input: structuredClone(oracle.feature.inputNegative) }], assertions: [{ kind: "json", responseId: "result", schemaRef: "json-value-v1", equals: structuredClone(oracle.feature.negativeAssertion) }] },
  ];
  const policy: E2EPolicy = { schemaVersion: 1, policyRevision: 1, executionMode: "trusted-scenarios", baselineScenarioIds: scenarios.map((scenario) => scenario.scenarioId), targets: [target], defaultSandboxProfileId: "default-sandbox", fallback: "mock-unconnected", modelRouteRevision: null,
    capture: { screenshots: false, traces: false, video: false, downloads: false }, limits: { runTimeoutMs: 60_000, startupTimeoutMs: 10_000, preparationTimeoutMs: 10_000, caseTimeoutMs: 10_000, maxActionsPerCase: 10, maxModelRequests: 1, maxInputTokens: 1, maxOutputTokens: 1, maxSpendUsd: null } };
  const selectionInput = { candidateDigest: candidate.digest, expectedCandidate: candidate, sourceSnapshot: snapshot, planDigest: "c".repeat(64), policy, scenarios,
    selectedTargetIds: [target.targetId], sandboxAvailability: { targetId: "default-sandbox" as const, profileId: "default-sandbox", connection: "connected" as const, approval: "approved" as const, qualification: "qualified" as const, authorizationRevision: "runtime-install-v1" },
    runtimeAvailability: [], portableApprovalBinding, approvedSemanticApproval: semanticApproval };
  const plan = selectE2EExecutionPlan(selectionInput);
  const group = plan.groups[0];
  if (!group || group.expectedCases.length !== 3) throw new Error("fixed installed runtime qualification suite did not compile into exactly three cases");
  const bundleBody = { schemaVersion: 1 as const, planDigest: selectionInput.planDigest, templateVersion: "trusted-e2e/v1", scenarios, bundleDigest: "0".repeat(64) };
  const bundle = { ...bundleBody, bundleDigest: e2eScenarioBundleDigest(bundleBody) };
  const compiled = compileE2EScenarios(bundle, plan.effectiveTargets, group, { selectionInput, executionPlan: plan, group } satisfies E2EImmutableCompilationContext);
  const selection = JSON.parse(compiled.files.get(compiled.selectionPacketPath) ?? "null") as E2ESelectionPacket;
  return { candidate, snapshot, compiled, selection, semanticApproval };
}

/** Runs the immutable installed probe suite through the production compiler, e2e CLI, collector bridge, and pinned Linux candidate. */
export async function qualifyInstalledP0Runtime(input: Readonly<{ challenge: RuntimeInstallChallenge; evidenceRoot: string }>) {
  const challenge = RuntimeInstallChallengeSchema.parse(input.challenge);
  const profile = CONTAINED_RUNTIME_PROFILE;
  if (!profile || !profile.id || profile.id !== challenge.profileId || profile.platform !== process.platform || profile.arch !== process.arch) throw new Error("runtime installation challenge profile does not match this actual host");
  assertRuntimeInstallationHostIdentity(profile.id, challenge, process.env);
  if (profile.image !== CONTAINED_IMAGE) throw new Error("installed fixed candidate image differs from the approved runtime profile");
  const readiness = await inspectContainedRuntimeReadinessForHost(process.platform, process.arch);
  if (readiness.status !== "ready" || readiness.profileId !== profile.id) throw new Error(`installed runtime prerequisites are unavailable: ${readiness.status === "unavailable" ? readiness.reason : "profile-mismatch"}`);
  const toolchain = { execPath: process.execPath, version: process.version as "v22.23.2", platform: process.platform, arch: process.arch };
  if (toolchain.version !== "v22.23.2") throw new Error("runtime qualification requires the exact installed Node v22.23.2 toolchain");
  const installedManifest = await observeInstalledRuntimeManifestForHost(process.platform, process.arch);
  const evidenceRoot = await realpath(resolve(input.evidenceRoot));
  const rootStat = await lstat(evidenceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0) throw new Error("qualification evidence root must be a pre-created private owned directory");
  const evidenceDirectory = await mkdtemp(join(evidenceRoot, "runtime-install-"));
  await import("node:fs/promises").then(({ chmod }) => chmod(evidenceDirectory, 0o700));
    const runtimeOracle = await loadOracle(profile.installedRuntimeRoot);
    const { snapshot, compiled, selection } = preparedSuite(runtimeOracle);
    const correlationByScenario = new Map<string, string>([["runtime-source-interface", challenge.probeCorrelations.sourceInterface], ["runtime-feature-positive", challenge.probeCorrelations.featurePositive], ["runtime-feature-negative", challenge.probeCorrelations.featureNegative]]);
    const challengeDigest = runtimeInstallChallengeDigest(challenge);
    const hostRequestIds = new Map(compiled.expectedCases.map((item) => [item.caseId, correlationByScenario.get(item.scenarioId)!]));
    const hostProbeInputs = new Map(compiled.expectedCases.map((item) => [item.caseId, {
      qualificationChallengeId: challenge.challengeId, qualificationChallengeDigest: challengeDigest,
      qualificationRequestId: correlationByScenario.get(item.scenarioId)!,
      qualificationProbe: item.scenarioId === "runtime-source-interface" ? "source-interface" : item.scenarioId === "runtime-feature-positive" ? "positive" : "negative",
    }]));
    const actual = await runE2EActualCli({ compiled, snapshot, selection, runnerToolchain: toolchain, hostRequestIds, hostProbeInputs,
      sourceRoot: profile.installedRuntimeRoot, evidenceDirectory, deadlineAt: Date.now() + 60_000, signal: new AbortController().signal });
    if (!actual.cleanupConfirmed || actual.cleanupServerListening || actual.listProcess.status !== 0 || actual.runProcess.status !== 1 || actual.runProcess.signal !== null || actual.runProcess.timedOut || actual.runProcess.aborted) throw new Error("installed qualification run did not produce the exact positive/negative process statuses and confirmed cleanup");
    const parsedReport = parseE2EReport(actual.rawReportBytes);
    const capture = actual.runStartCapture;
    if (parsedReport.kind !== "parsed" || capture.status !== "valid" || capture.capture.runId !== parsedReport.report.run.id
      || capture.capture.challenge !== actual.launchId || actual.selected !== 3 || actual.filtered !== 0) throw new Error("actual pinned CLI report and first-party run-start identity are incomplete or inconsistent");
    const report = parsedReport.report;
    const expectedReportRows = compiled.expectedCases.map((expected) => ({ expected, tuple: selection.tuples.find((tuple) => tuple.caseId === expected.caseId) }));
    if (expectedReportRows.some(({ tuple }) => !tuple) || report.run.runner.name !== "e2e" || report.run.runner.version !== "0.20.0"
      || report.run.project.id !== "rovara-contract-p0" || report.run.project.configDigest !== actual.launchConfigDigest
      || report.run.status !== "failed" || report.run.exitCode !== 1 || report.run.errors.length !== 0 || report.run.serialGroups.length !== 0
      || report.run.summary.discovered !== 3 || report.run.summary.selected !== 3 || report.run.summary.executed !== 3
      || report.run.summary.passed !== 2 || report.run.summary.failed !== 1 || report.run.summary.interrupted !== 0
      || report.run.summary.flaky !== 0 || report.run.summary.skipped !== 0 || report.run.results.length !== 3) throw new Error("upstream report does not contain the exact complete fixed qualification run");
    const reportRows = new Map(report.run.results.map((row) => [row.id, row]));
    for (const { expected, tuple } of expectedReportRows) {
      const negative = expected.scenarioId === "runtime-feature-negative";
      const row = tuple && reportRows.get(tuple.upstreamResultId);
      const attempt = row?.attempts[0];
      if (!row || row.selected !== true || row.kind !== "test" || row.repeat !== 0 || row.attempts.length !== 1
        || row.status !== (negative ? "failed" : "passed") || attempt?.index !== 0 || attempt.status !== (negative ? "failed" : "passed")
        || attempt.cleanup !== "complete" || attempt.steps.length !== 0 || attempt.secondaryErrors.length !== 0
        || (negative ? attempt.error?.category !== "test" : attempt.error !== undefined)) throw new Error("one fixed qualification report case did not have its expected clean first-attempt result");
    }
    const probeDefinitions = [
      { probeId: "source-interface-positive/v1", scenarioId: "runtime-source-interface", outcome: "PASS" as const },
      { probeId: "process-response-positive/v1", scenarioId: "runtime-feature-positive", outcome: "PASS" as const },
      { probeId: "process-response-negative/v1", scenarioId: "runtime-feature-negative", outcome: "EXPECTED_FAILURE" as const },
    ];
    const cases = new Map(compiled.expectedCases.map((item) => [item.scenarioId, item]));
    const capturesByCase = new Map(actual.candidateCaptures.map((capture) => [String(capture.caseId), capture]));
    const probes = probeDefinitions.map((definition) => {
      const expectedCase = cases.get(definition.scenarioId);
      if (!expectedCase) throw new Error("fixed qualification scenario has no compiler-admitted case");
      const candidateCapture = capturesByCase.get(expectedCase.caseId);
      const capture = candidateCapture?.capture as Record<string, unknown> | undefined;
      const cleanup = candidateCapture?.receipt as Record<string, unknown> | undefined;
      if (!capture || cleanup?.cleanup !== "confirmed" || cleanup?.exitCode !== 0 || cleanup?.aborted !== false || cleanup?.timedOut !== false
        || typeof capture.requestFrameBase64 !== "string" || typeof capture.stdoutFrameBase64 !== "string") throw new Error(`probe ${definition.probeId} lacks original candidate frames or confirmed candidate cleanup`);
      const outcome = actual.assertionReceipts.find((receipt) => typeof receipt === "object" && receipt !== null && (receipt as Record<string, unknown>).caseId === expectedCase.caseId) as Record<string, unknown> | undefined;
      if (definition.outcome === "PASS" && outcome?.outcome !== "passed" || definition.outcome === "EXPECTED_FAILURE" && outcome?.outcome !== "failed") throw new Error(`probe ${definition.probeId} did not produce its fixed independent assertion outcome`);
      const requestBytes = Buffer.from(capture.requestFrameBase64, "base64");
      const responseBytes = Buffer.from(capture.stdoutFrameBase64, "base64");
      const stderrBytes = Buffer.from(typeof capture.stderrFrameBase64 === "string" ? capture.stderrFrameBase64 : "", "base64");
      const assertionReceipt = actual.assertionReceipts.find((receipt) => typeof receipt === "object" && receipt !== null && (receipt as Record<string, unknown>).caseId === expectedCase.caseId) as Record<string, unknown> | undefined;
      if (!assertionReceipt || assertionReceipt.assertionIndex !== 0 || assertionReceipt.outcome !== (definition.outcome === "PASS" ? "passed" : "failed")
        || assertionReceipt.responseSha256 !== sha(responseBytes)) throw new Error(`probe ${definition.probeId} lacks a fixed independent assertion receipt bound to the captured response`);
      const receiptEvidence = { profileId: profile.id, receipt: cleanup, capture: {
        requestBytes: capture.requestBytes, requestSha256: capture.requestSha256,
        stdoutBytes: capture.stdoutBytes, stdoutSha256: capture.stdoutSha256,
        stderrBytes: capture.stderrBytes, stderrSha256: capture.stderrSha256,
      } };
      const receiptBytes = Buffer.from(JSON.stringify(receiptEvidence));
      const assertionBytes = Buffer.from(JSON.stringify(assertionReceipt));
      const requestName = definition.probeId.replace(/\/v1$/, "") + "-request.json";
      const responseName = definition.probeId.replace(/\/v1$/, "") + "-response.json";
      return { probeId: definition.probeId, requestCorrelationId: correlationByScenario.get(definition.scenarioId)!, expectedOutcome: definition.outcome, observedOutcome: definition.outcome,
        candidateExitCode: 0,
        cleanup: { candidateContainers: 0 as const, bridgeListening: false as const, scratchRemoved: true as const, sentinelRemoved: true as const },
        containmentReceipt: { bytesBase64: receiptBytes.toString("base64"), sha256: sha(receiptBytes) },
        assertionReceipt: { bytesBase64: assertionBytes.toString("base64"), sha256: sha(assertionBytes) },
        captures: [{ name: requestName, bytesBase64: requestBytes.toString("base64"), sha256: sha(requestBytes) }, { name: responseName, bytesBase64: responseBytes.toString("base64"), sha256: sha(responseBytes) },
          { name: `${definition.probeId.replace(/\/v1$/, "")}-stderr.bin`, bytesBase64: stderrBytes.toString("base64"), sha256: sha(stderrBytes) }] };
    });
    const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: `${process.platform} ${osRelease()}`, arch: process.arch, runtime: `node ${process.version}` };
    const bytesEvidence = (bytes: Uint8Array) => ({ bytesBase64: Buffer.from(bytes).toString("base64"), sha256: sha(bytes) });
    const execution = { launchConfigDigest: actual.launchConfigDigest, list: { stdout: bytesEvidence(actual.listStdoutBytes), stderr: bytesEvidence(actual.listStderrBytes), exitCode: 0 as const },
      run: { stdout: bytesEvidence(actual.rawReportBytes), stderr: bytesEvidence(actual.runStderrBytes),
        runStartCapture: bytesEvidence(actual.runStartCaptureBytes), launchId: actual.launchId, exitCode: 1 as const, signal: null, timedOut: false as const, aborted: false as const },
      workerCleanup: { confirmed: true as const, serverListening: false as const, socketPresent: false as const, aliasEntryPresent: false as const, privateSentinelPresent: false as const } };
    return RuntimeInstallationProposalSchema.parse({ schemaVersion: "runtime-installation-proposal/v1", challenge, createdAt: new Date().toISOString(), manifest: installedManifest, runnerEnvironment, runnerToolchain: toolchain, execution, probes });
}

/** Linux qualification is bound to the actual EC2 worker's boot-injected workspace and generation. */
export function assertRuntimeInstallationHostIdentity(profileId: string, challenge: RuntimeInstallChallenge, environment: NodeJS.ProcessEnv): void {
  if (profileId !== "linux-arm64-docker-v1" && profileId !== WEB_API_RUNTIME_PROFILE_ID) return;
  if (environment.AGENTX_WORKSPACE_ID !== challenge.transportCorrelationId
    || !/^[1-9][0-9]*$/.test(environment.AGENTX_SESSION_GENERATION ?? "")
    || Number(environment.AGENTX_SESSION_GENERATION) !== challenge.generation) throw new Error("runtime qualification challenge does not match the actual boot-injected workspace identity and generation");
  const portValue = environment.PORT ?? "8080";
  if (!/^[1-9][0-9]*$/.test(portValue) || Number(portValue) > 65_535) throw new Error("runtime worker port is invalid for endpoint identity qualification");
  const addresses = Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).filter((entry) => !entry.internal && entry.family === "IPv4").map((entry) => entry.address));
  assertRuntimeInstallationEndpointIdentity(challenge.endpoint, Number(portValue), addresses);
}

/** Confirms the administrator-selected endpoint belongs to this host's active worker listener. */
export function assertRuntimeInstallationEndpointIdentity(endpoint: string, workerPort: number, hostIpv4Addresses: readonly string[]): void {
  const url = new URL(endpoint);
  const endpointPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (url.protocol !== "http:" || endpointPort !== workerPort || !hostIpv4Addresses.includes(url.hostname)) throw new Error("runtime qualification endpoint does not match a non-loopback address and listener port on this host");
}

/** Where the qualifier reads the facts of the host it runs on; tests substitute these, the installed CLI uses the real ones. */
export type WebApiQualificationEnvironment = Readonly<{
  platform: string; arch: string; nodeVersion: string; nodeExecPath: string; osRelease: string; now(): number;
  assertHostIdentity(challenge: RuntimeInstallChallenge): void;
  observeManifest(): Promise<InstalledRuntimeManifest>;
}>;
const realWebApiEnvironment = (): WebApiQualificationEnvironment => ({
  platform: process.platform, arch: process.arch, nodeVersion: process.version, nodeExecPath: process.execPath, osRelease: osRelease(), now: () => Date.now(),
  assertHostIdentity: (challenge) => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, process.env),
  observeManifest: () => observeInstalledRuntimeManifestForHost(process.platform, process.arch),
});

/** Qualification failed closed; `reasons` are the stable per-probe codes, for example `negative-probe-passed:web-csv-negative-v1`. */
export class WebApiQualificationRejected extends Error {
  constructor(readonly reasons: readonly string[]) { super(`web/API runtime qualification rejected: ${reasons.join(", ")}`); this.name = "WebApiQualificationRejected"; }
}

/**
 * Qualifies the web/API application runtime. Each required probe runs through the supplied runner (the real Docker host and the
 * real collector in production), and its observed facts are judged by the same pure oracle the registrar re-runs. Any probe that is
 * wrong, missing, skipped, flaky or retried rejects the whole qualification; nothing here returns a partial proposal.
 */
export async function qualifyInstalledWebApiRuntime(input: Readonly<{
  challenge: RuntimeInstallChallenge; evidenceRoot: string;
  runProbe: (probeId: string) => Promise<WebApiProbeObservation>;
  environment?: Partial<WebApiQualificationEnvironment>;
}>): Promise<WebApiRuntimeInstallProposal> {
  const challenge = RuntimeInstallChallengeSchema.parse(input.challenge);
  const environment = { ...realWebApiEnvironment(), ...input.environment };
  if (challenge.profileId !== WEB_API_RUNTIME_PROFILE_ID) throw new Error("runtime installation challenge profile is not the web/API runtime profile");
  if (environment.platform !== "linux" || environment.arch !== "arm64") throw new Error("runtime installation challenge profile does not match this actual host");
  if (environment.nodeVersion !== "v22.23.2") throw new Error("runtime qualification requires the exact installed Node v22.23.2 toolchain");
  environment.assertHostIdentity(challenge);
  const evidenceRoot = await realpath(resolve(input.evidenceRoot));
  const rootStat = await lstat(evidenceRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0) throw new Error("qualification evidence root must be a pre-created private owned directory");
  const evidenceDirectory = await mkdtemp(join(evidenceRoot, "web-api-qualification-"));
  await chmod(evidenceDirectory, 0o700);
  const manifest = await environment.observeManifest();
  const assets = new Map(loadWebApiQualificationProbeAssets().map((asset) => [asset.probeId, asset]));
  const probes: WebApiRuntimeInstallProposal["probes"] = [];
  const reasons: string[] = [];
  for (const required of WEB_API_REQUIRED_PROBES) {
    let observation: WebApiProbeObservation;
    try { observation = WebApiProbeObservationSchema.parse(await input.runProbe(required.probeId)); }
    catch { reasons.push(`probe-run-failed:${required.probeId}`); continue; }
    await writeFile(join(evidenceDirectory, `${required.probeId}.json`), `${canonicalJson(observation)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const verdict = evaluateWebApiProbeObservation(required.probeId, observation);
    if (!verdict.ok) { reasons.push(verdict.reason); continue; }
    probes.push({ probeId: required.probeId, kind: required.kind, expectedOutcome: required.expectedOutcome, observedOutcome: required.expectedOutcome,
      assetDigest: assets.get(required.probeId)!.assetDigest, observation });
  }
  if (reasons.length > 0) throw new WebApiQualificationRejected(reasons);
  const toolchain = { execPath: environment.nodeExecPath, version: environment.nodeVersion as "v22.23.2", platform: environment.platform, arch: environment.arch };
  const runnerEnvironment = { ci: true as const, trustNoticeShown: false as const, os: `${environment.platform} ${environment.osRelease}`, arch: environment.arch, runtime: `node ${environment.nodeVersion}` };
  return WebApiRuntimeInstallProposalSchema.parse({ schemaVersion: "runtime-installation-proposal/v2", state: "READY", profileId: WEB_API_RUNTIME_PROFILE_ID,
    scope: WEB_API_RUNTIME_SCOPE, challenge, createdAt: new Date(environment.now()).toISOString(), manifest, runnerEnvironment, runnerToolchain: toolchain, probes });
}
