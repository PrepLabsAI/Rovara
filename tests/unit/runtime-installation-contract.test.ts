import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import {
  RuntimeInstallChallengeSchema,
  RuntimeInstallationProposalSchema,
  runtimeInstallChallengeDigest,
  runtimeInstallationProposalSha256,
} from "../../packages/contracts/src/runtime-installation.js";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const challenge = {
  schemaVersion: "runtime-install-challenge/v1" as const,
  challengeId: "11111111-1111-4111-8111-111111111111",
  challengeSecret: Buffer.alloc(32, 7).toString("base64"),
  issuedAt: "2026-10-14T12:00:00.000Z",
  expiresAt: "2026-10-14T12:05:00.000Z",
  issuedByOwnerKey: "admin",
  issuedBySubject: "admin",
  binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const },
  setupCatalogId: "agentx-test-setup",
  featureCatalogId: "agentx-test-feature",
  profileId: "linux-arm64-docker-v1" as const,
  endpoint: "http://10.0.2.15:8080",
  generation: 3,
  transportCorrelationId: "22222222-2222-4222-8222-222222222222",
  probeCorrelations: { sourceInterface: "44444444-4444-4444-8444-444444444441", featurePositive: "44444444-4444-4444-8444-444444444442", featureNegative: "44444444-4444-4444-8444-444444444443" },
};
const correlations = [challenge.probeCorrelations.sourceInterface, challenge.probeCorrelations.featurePositive, challenge.probeCorrelations.featureNegative];
const captures = (probeId: string, index: number) => {
  const prefix = probeId.replace(/\/v1$/, "");
  const wireId = (probeId.includes("source") ? "1" : probeId.includes("positive") ? "2" : "3").repeat(48);
  const input = { qualificationChallengeId: challenge.challengeId, qualificationChallengeDigest: runtimeInstallChallengeDigest(challenge), qualificationRequestId: correlations[index], qualificationProbe: index === 0 ? "source-interface" : index === 1 ? "positive" : "negative" };
  const output = probeId.includes("source")
    ? { protocol: "registered-module-export-inventory/v1", exports: [{ name: "listRows", kind: "callable" }, { name: "otherRows", kind: "callable" }] }
    : { rows: [1] };
  return [
    { name: `${prefix}-request.json`, bytes: JSON.stringify({ wireId, input }) },
    { name: `${prefix}-response.json`, bytes: `${JSON.stringify({ wireId, output })}\n` },
    { name: `${prefix}-stderr.bin`, bytes: "" },
  ].map(({ name, bytes }) => ({ name, bytesBase64: Buffer.from(bytes).toString("base64"), sha256: sha(bytes) }));
};
const probe = (probeId: "source-interface-positive/v1" | "process-response-positive/v1" | "process-response-negative/v1", outcome: "PASS" | "EXPECTED_FAILURE") => {
  const index = probeId.includes("source") ? 0 : probeId.includes("positive") ? 1 : 2;
  const frames = captures(probeId, index);
  const requestBytes = Buffer.from(frames[0]!.bytesBase64, "base64");
  const stdoutBytes = Buffer.from(frames[1]!.bytesBase64, "base64");
  const stderrBytes = Buffer.from(frames[2]!.bytesBase64, "base64");
  const sourceDigest = index === 0 ? "3b5ad26d381ff4ea28b41019954b23771a598d838aeb4008cdae41c87bc09a79" : "d364565e3e56fec557da690e15fbc385fccd215096deff75b92dcfb7229e3a4a";
  const sourceBytes = index === 0 ? 782 : 2021;
  const nonce = `${String(index + 1).repeat(48)}`;
  const responseSha256 = frames[1]!.sha256;
  const expected = [
    { caseId: "case-a9eb53e1895372a6148bf5bb92aca811df9d7e7d72c6e4bf0e0341de7033e229", assertionDigest: "1c28b3d0f687398bf7abcd40fc79ebe1f273a5ce368899259e8ee0e56e09929a" },
    { caseId: "case-e1a9e129a98030e665eb13a5dbbc2c643624b1bfb893d2611baaed6688b9b9a7", assertionDigest: "e1278b28ba1f5605a24c8c8c0eff3e43940ae92ec531934d897490453d85959a" },
    { caseId: "case-e014583b1e51edfe14e5d0cb2df6bde986cd7583c6b51eb913e0891cfc2d0fbe", assertionDigest: "72bffdef0f4bf7965fa6b62dac5d04643587adac796f31c18fa399cb9f5d38af" },
  ][index]!;
  const receipt = { scope: "contained-candidate-process-response/v1", adapterVersion: 1, plannedName: `agentx-contained-${String(index + 1).repeat(20)}`, recordRef: String(index + 1).repeat(32), containerId: String(index + 1).repeat(64), image: "node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9", sourceDigest, sourceBytes,
    entry: "__agentx_adapter__/entry.mjs", exportName: "default", owner: { nonce, labels: { "agentx.owner": "contained-candidate-v1", "agentx.nonce": nonce, "agentx.source": sourceDigest } }, endpoint: "unix:///var/run/docker.sock", exitCode: 0, requestWritten: true, timedOut: false, aborted: false,
    stdoutBytes: stdoutBytes.length, stderrBytes: stderrBytes.length, aggregateBytes: stdoutBytes.length + stderrBytes.length, overflow: false, cleanup: "confirmed" };
  return {
  probeId,
  requestCorrelationId: correlations[probeId.includes("source") ? 0 : probeId.includes("positive") ? 1 : 2],
  expectedOutcome: outcome,
  observedOutcome: outcome,
  candidateExitCode: 0,
  cleanup: { candidateContainers: 0, bridgeListening: false, scratchRemoved: true, sentinelRemoved: true },
  containmentReceipt: evidence(JSON.stringify({ profileId: "linux-arm64-docker-v1", receipt, capture: { requestBytes: requestBytes.length, requestSha256: sha(requestBytes.toString("binary")), stdoutBytes: stdoutBytes.length, stdoutSha256: sha(stdoutBytes.toString("binary")), stderrBytes: stderrBytes.length, stderrSha256: sha(stderrBytes.toString("binary")) } })),
  assertionReceipt: evidence(JSON.stringify({ caseId: expected.caseId, outcome: outcome === "PASS" ? "passed" : "failed", assertionIndex: 0, assertionDigest: expected.assertionDigest, responseSha256 })),
  captures: frames,
}; };
function evidence(value: string) { const bytes = Buffer.from(value); return { bytesBase64: bytes.toString("base64"), sha256: sha(bytes) }; }
const scenarios = ["runtime-source-interface", "runtime-feature-positive", "runtime-feature-negative"];
const reportCaseIds = ["case-a9eb53e1895372a6148bf5bb92aca811df9d7e7d72c6e4bf0e0341de7033e229", "case-e1a9e129a98030e665eb13a5dbbc2c643624b1bfb893d2611baaed6688b9b9a7", "case-e014583b1e51edfe14e5d0cb2df6bde986cd7583c6b51eb913e0891cfc2d0fbe"];
const reportRows = scenarios.map((_scenario, index) => { const testId = `.agentx/e2e/generated-contract.test.ts::${reportCaseIds[index]}`; const targetId = "contract-web-1"; const agent = "default"; const status = ["passed", "passed", "failed"][index]; return { id: sha(canonicalJson({ testId, targetId, agent })), testId, titlePath: [reportCaseIds[index]], file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: index + 3, column: 1 }, declarationIndex: index, targetId, platform: targetId, agent, kind: "test", selected: true, repeat: 0, tags: [], status, attempts: [{ id: `66666666-6666-4666-8666-66666666666${index}`, index: 0, status, startedAt: `2026-10-14T12:01:0${index}.000Z`, durationMs: 1, cleanup: "complete", artifacts: [], steps: [], secondaryErrors: [], ...(status === "failed" ? { error: { category: "test", code: "ASSERTION_FAILED", message: "expected fixed negative case to fail", retryable: false, phase: "body", source: { file: "worker-bridge.mjs", line: 60, column: 35 } } } : {}) }] }; });
const launchConfigDigest = "a".repeat(64);
const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
const executionReport = { schemaVersion: "report-1", run: { id: "33333333-3333-7333-8333-333333333333", specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" }, status: "failed", exitCode: 1, startedAt: "2026-10-14T12:01:00.000Z", finishedAt: "2026-10-14T12:01:30.000Z", project: { id: "rovara-contract-p0", configDigest: launchConfigDigest }, environment: runnerEnvironment, targets: [{ id: "contract-web-1", index: 0, platform: "contract-web-1", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }], errors: [], serialGroups: [], summary: { discovered: 3, selected: 3, executed: 3, passed: 2, failed: 1, interrupted: 0, flaky: 0, skipped: 0 }, limits: { maxAgentContextBytes: 16384, maxLedgerBytes: 8192, maxObservationBytes: 262144, maxEventsPerStep: 1000, maxModelTokensPerCall: 64000 }, usage: { discoveredResults: 3, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 }, results: reportRows } };
const entries = [
  { path: "packages/verifier/assets/runtime-installation/probe-oracle.json", sha256: "b".repeat(64) },
  { path: "packages/verifier/dist/runtime-cli.js", sha256: "a".repeat(64) },
].sort((left, right) => left.path.localeCompare(right.path));
const manifestBody = { schemaVersion: "installed-runtime-manifest/v1" as const, entries };
const validProposal = {
  schemaVersion: "runtime-installation-proposal/v1" as const,
  challenge,
  createdAt: "2026-10-14T12:02:00.000Z",
  manifest: { ...manifestBody, sha256: sha(canonicalJson(manifestBody)) },
  runnerEnvironment,
  runnerToolchain: { execPath: "/usr/local/bin/node", version: "v22.23.2" as const, platform: "linux", arch: "arm64" },
    execution: { launchConfigDigest, list: { stdout: evidence(JSON.stringify({ pairs: reportRows.map((row) => ({ id: row.id, file: row.file, title: row.titlePath[0], titlePath: row.titlePath, kind: "test", tags: [], source: { ...row.source, line: 25 }, sessions: [], target: "contract-web-1", agent: "default", disposition: "run" })) })), stderr: evidence(""), exitCode: 0 as const }, run: { stdout: evidence(JSON.stringify(executionReport)), stderr: evidence(""), runStartCapture: evidence(JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", runId: executionReport.run.id, seq: 1, challenge: "55555555-5555-4555-8555-555555555555", at: "2026-10-14T12:01:00.000Z" }) + "\n"), launchId: "55555555-5555-4555-8555-555555555555", exitCode: 1 as const, signal: null, timedOut: false as const, aborted: false as const }, workerCleanup: { confirmed: true as const, serverListening: false as const, socketPresent: false as const, aliasEntryPresent: false as const, privateSentinelPresent: false as const } },
  probes: [probe("source-interface-positive/v1", "PASS"), probe("process-response-positive/v1", "PASS"), probe("process-response-negative/v1", "EXPECTED_FAILURE")],
};

describe("runtime installation proposal contract", () => {
  it("accepts a complete challenge-bound setup and feature probe proposal", () => {
    expect(RuntimeInstallChallengeSchema.safeParse(challenge).success).toBe(true);
    expect(RuntimeInstallChallengeSchema.safeParse({ ...challenge, endpoint: "http://10.1.evil.com:8080" }).success).toBe(false);
    expect(RuntimeInstallChallengeSchema.safeParse({ ...challenge, endpoint: "http://10.1.2.3:3000" }).success).toBe(false);
    expect(RuntimeInstallationProposalSchema.parse(validProposal)).toEqual(validProposal);
    expect(runtimeInstallationProposalSha256(validProposal)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects caller-selected readiness and extra proof fields", () => {
    expect(RuntimeInstallationProposalSchema.safeParse({ ...validProposal, state: "READY" }).success).toBe(false);
    expect(RuntimeInstallationProposalSchema.safeParse({ ...validProposal, operatorClaim: true }).success).toBe(false);
    expect(RuntimeInstallationProposalSchema.safeParse({ ...validProposal, probes: validProposal.probes.slice(0, 2) }).success).toBe(false);
  });

  it("rejects altered raw capture bytes, an unexpected negative result, and setup-only catalogs", () => {
    const changedCapture = structuredClone(validProposal);
    changedCapture.probes[0]!.captures[0]!.bytesBase64 = Buffer.from("altered").toString("base64");
    expect(RuntimeInstallationProposalSchema.safeParse(changedCapture).success).toBe(false);
    const passingNegative = structuredClone(validProposal);
    passingNegative.probes[2]!.observedOutcome = "PASS";
    expect(RuntimeInstallationProposalSchema.safeParse(passingNegative).success).toBe(false);
    expect(RuntimeInstallChallengeSchema.safeParse({ ...challenge, setupCatalogId: challenge.featureCatalogId }).success).toBe(false);
    const replay = structuredClone(validProposal);
    replay.challenge.challengeId = "99999999-9999-4999-8999-999999999999";
    expect(RuntimeInstallationProposalSchema.safeParse(replay).success).toBe(false);
    const passingReport = structuredClone(validProposal);
    const report = JSON.parse(Buffer.from(passingReport.execution.run.stdout.bytesBase64, "base64").toString("utf8")) as { run: { results: Array<{ status: string; attempts: Array<{ status: string }> }> } };
    report.run.results[2]!.status = "passed";
    report.run.results[2]!.attempts[0]!.status = "passed";
    const reportBytes = Buffer.from(JSON.stringify(report));
    passingReport.execution.run.stdout.bytesBase64 = reportBytes.toString("base64");
    passingReport.execution.run.stdout.sha256 = sha(reportBytes);
    expect(RuntimeInstallationProposalSchema.safeParse(passingReport).success).toBe(false);
    for (const field of ["interrupted", "flaky", "skipped"] as const) {
      const inconsistent = structuredClone(validProposal);
      const body = JSON.parse(Buffer.from(inconsistent.execution.run.stdout.bytesBase64, "base64").toString("utf8")) as { run: { summary: Record<string, number> } };
      body.run.summary[field] = 1;
      const bytes = Buffer.from(JSON.stringify(body));
      inconsistent.execution.run.stdout.bytesBase64 = bytes.toString("base64");
      inconsistent.execution.run.stdout.sha256 = sha(bytes);
      expect(RuntimeInstallationProposalSchema.safeParse(inconsistent).success).toBe(false);
    }
    const alteredOracle = structuredClone(validProposal);
    const oracleReport = JSON.parse(Buffer.from(alteredOracle.execution.run.stdout.bytesBase64, "base64").toString("utf8")) as { run: { targets: Array<Record<string, unknown>>; usage: Record<string, number>; results: Array<Record<string, unknown>> } };
    oracleReport.run.targets[0]!.id = "other-target";
    oracleReport.run.usage.downloads = 1;
    oracleReport.run.results[0]!.skip = "operator supplied skip";
    const oracleBytes = Buffer.from(JSON.stringify(oracleReport));
    alteredOracle.execution.run.stdout.bytesBase64 = oracleBytes.toString("base64");
    alteredOracle.execution.run.stdout.sha256 = sha(oracleBytes);
    expect(RuntimeInstallationProposalSchema.safeParse(alteredOracle).success).toBe(false);
    const serialized = structuredClone(validProposal);
    const serializedBody = JSON.parse(Buffer.from(serialized.execution.run.stdout.bytesBase64, "base64").toString("utf8")) as { run: { serialGroups: unknown[] } };
    serializedBody.run.serialGroups.push({ id: "unexpected" });
    const serializedBytes = Buffer.from(JSON.stringify(serializedBody));
    serialized.execution.run.stdout.bytesBase64 = serializedBytes.toString("base64");
    serialized.execution.run.stdout.sha256 = sha(serializedBytes);
    expect(RuntimeInstallationProposalSchema.safeParse(serialized).success).toBe(false);
    const forgedList = structuredClone(validProposal);
    const list = JSON.parse(Buffer.from(forgedList.execution.list.stdout.bytesBase64, "base64").toString("utf8")) as { pairs: Array<{ file: string }> };
    list.pairs[0]!.file = "attacker.test.ts";
    const listBytes = Buffer.from(JSON.stringify(list));
    forgedList.execution.list.stdout.bytesBase64 = listBytes.toString("base64");
    forgedList.execution.list.stdout.sha256 = sha(listBytes);
    expect(RuntimeInstallationProposalSchema.safeParse(forgedList).success).toBe(false);
    const missingSource = structuredClone(validProposal);
    const sourceList = JSON.parse(Buffer.from(missingSource.execution.list.stdout.bytesBase64, "base64").toString("utf8")) as { pairs: Array<{ source?: unknown }> };
    delete sourceList.pairs[0]!.source;
    const sourceBytes = Buffer.from(JSON.stringify(sourceList));
    missingSource.execution.list.stdout.bytesBase64 = sourceBytes.toString("base64");
    missingSource.execution.list.stdout.sha256 = sha(sourceBytes);
    expect(RuntimeInstallationProposalSchema.safeParse(missingSource).success).toBe(false);
    const forgedCleanup = structuredClone(validProposal);
    forgedCleanup.probes[0]!.containmentReceipt.bytesBase64 = Buffer.from(JSON.stringify({ cleanup: "pending" })).toString("base64");
    forgedCleanup.probes[0]!.containmentReceipt.sha256 = sha(Buffer.from(forgedCleanup.probes[0]!.containmentReceipt.bytesBase64, "base64"));
    expect(RuntimeInstallationProposalSchema.safeParse(forgedCleanup).success).toBe(false);
  });
});
