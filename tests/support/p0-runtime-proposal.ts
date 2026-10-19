import { createHash } from "node:crypto";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { runtimeInstallChallengeDigest, type RuntimeInstallChallenge } from "../../packages/contracts/src/runtime-installation.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

/** A complete, schema-valid P0 (v1) runtime installation proposal for a challenge, as the standard qualifier produces. */
export function proposalFor(challenge: RuntimeInstallChallenge) {
  const proofChallenge = challenge;
  const probeIds = ["source-interface-positive/v1", "process-response-positive/v1", "process-response-negative/v1"];
  const correlations = [proofChallenge.probeCorrelations.sourceInterface, proofChallenge.probeCorrelations.featurePositive, proofChallenge.probeCorrelations.featureNegative];
  const probes = probeIds.map((probeId, index) => {
    const wireId = (index + 1).toString().repeat(48);
    const expectedInput = { qualificationChallengeId: proofChallenge.challengeId, qualificationChallengeDigest: runtimeInstallChallengeDigest(challenge), qualificationRequestId: correlations[index], qualificationProbe: ["source-interface", "positive", "negative"][index] };
    const output = index === 0 ? { protocol: "registered-module-export-inventory/v1", exports: [{ name: "listRows", kind: "callable" }, { name: "otherRows", kind: "callable" }] } : { rows: [1] };
    const frames = [JSON.stringify({ wireId, input: expectedInput }), `${JSON.stringify({ wireId, output })}\n`, ""];
    const names = probeId.replace(/\/v1$/, "");
    const captures = frames.map((frame, frameIndex) => { const bytes = Buffer.from(frame); return { name: `${names}-${frameIndex === 0 ? "request" : frameIndex === 1 ? "response" : "stderr"}.${frameIndex === 2 ? "bin" : "json"}`, bytesBase64: bytes.toString("base64"), sha256: sha(bytes) }; });
    const evidence = (value: string) => { const bytes = Buffer.from(value); return { bytesBase64: bytes.toString("base64"), sha256: sha(bytes) }; };
    const req = Buffer.from(captures[0]!.bytesBase64, "base64");
    const stdout = Buffer.from(captures[1]!.bytesBase64, "base64");
    const stderr = Buffer.from(captures[2]!.bytesBase64, "base64");
    const sourceDigest = index === 0 ? "3b5ad26d381ff4ea28b41019954b23771a598d838aeb4008cdae41c87bc09a79" : "d364565e3e56fec557da690e15fbc385fccd215096deff75b92dcfb7229e3a4a";
    const sourceBytes = index === 0 ? 782 : 2021;
    const nonce = String(index + 1).repeat(48);
    const expected = [
      { caseId: "case-a9eb53e1895372a6148bf5bb92aca811df9d7e7d72c6e4bf0e0341de7033e229", assertionDigest: "1c28b3d0f687398bf7abcd40fc79ebe1f273a5ce368899259e8ee0e56e09929a" },
      { caseId: "case-e1a9e129a98030e665eb13a5dbbc2c643624b1bfb893d2611baaed6688b9b9a7", assertionDigest: "e1278b28ba1f5605a24c8c8c0eff3e43940ae92ec531934d897490453d85959a" },
      { caseId: "case-e014583b1e51edfe14e5d0cb2df6bde986cd7583c6b51eb913e0891cfc2d0fbe", assertionDigest: "72bffdef0f4bf7965fa6b62dac5d04643587adac796f31c18fa399cb9f5d38af" },
    ][index]!;
    const receipt = { scope: "contained-candidate-process-response/v1", adapterVersion: 1, plannedName: `agentx-contained-${String(index + 1).repeat(20)}`, recordRef: String(index + 1).repeat(32), containerId: String(index + 1).repeat(64), image: "node@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9", sourceDigest, sourceBytes,
      entry: "__agentx_adapter__/entry.mjs", exportName: "default", owner: { nonce, labels: { "agentx.owner": "contained-candidate-v1", "agentx.nonce": nonce, "agentx.source": sourceDigest } }, endpoint: proofChallenge.profileId === "linux-arm64-docker-v1" ? "unix:///var/run/docker.sock" : "unix:///Users/test/.colima/default/docker.sock", exitCode: 0, requestWritten: true, timedOut: false, aborted: false,
      stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength, aggregateBytes: stdout.byteLength + stderr.byteLength, overflow: false, cleanup: "confirmed" };
    return { probeId, requestCorrelationId: correlations[index], expectedOutcome: index === 2 ? "EXPECTED_FAILURE" : "PASS", observedOutcome: index === 2 ? "EXPECTED_FAILURE" : "PASS", candidateExitCode: 0,
      cleanup: { candidateContainers: 0, bridgeListening: false, scratchRemoved: true, sentinelRemoved: true },
      containmentReceipt: evidence(JSON.stringify({ profileId: proofChallenge.profileId, receipt, capture: { requestBytes: req.byteLength, requestSha256: sha(req), stdoutBytes: stdout.byteLength, stdoutSha256: sha(stdout), stderrBytes: stderr.byteLength, stderrSha256: sha(stderr) } })),
      assertionReceipt: evidence(JSON.stringify({ caseId: expected.caseId, outcome: index === 2 ? "failed" : "passed", assertionIndex: 0, assertionDigest: expected.assertionDigest, responseSha256: captures[1]!.sha256 })), captures };
  });
  const entries = [
    { path: "packages/verifier/assets/runtime-installation/probe-oracle.json", sha256: "b".repeat(64) },
    { path: "packages/verifier/dist/runtime-cli.js", sha256: "a".repeat(64) },
  ];
  const manifestBody = { schemaVersion: "installed-runtime-manifest/v1", entries };
  const evidence = (value: string) => { const bytes = Buffer.from(value); return { bytesBase64: bytes.toString("base64"), sha256: sha(bytes) }; };
  const scenarios = ["runtime-source-interface", "runtime-feature-positive", "runtime-feature-negative"];
  const reportCaseIds = ["case-a9eb53e1895372a6148bf5bb92aca811df9d7e7d72c6e4bf0e0341de7033e229", "case-e1a9e129a98030e665eb13a5dbbc2c643624b1bfb893d2611baaed6688b9b9a7", "case-e014583b1e51edfe14e5d0cb2df6bde986cd7583c6b51eb913e0891cfc2d0fbe"];
  const reportRows = scenarios.map((_scenario, index) => { const testId = `.agentx/e2e/generated-contract.test.ts::${reportCaseIds[index]}`; const targetId = "contract-web-1"; const agent = "default"; const status = ["passed", "passed", "failed"][index]; return { id: sha(canonicalJson({ testId, targetId, agent })), testId, titlePath: [reportCaseIds[index]], file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: index + 3, column: 1 }, declarationIndex: index, targetId, platform: targetId, agent, kind: "test", selected: true, repeat: 0, tags: [], status, attempts: [{ id: `66666666-6666-4666-8666-66666666666${index}`, index: 0, status, startedAt: new Date(Date.parse(proofChallenge.issuedAt) + 6_000 + index * 1_000).toISOString(), durationMs: 1, cleanup: "complete", artifacts: [], steps: [], secondaryErrors: [], ...(status === "failed" ? { error: { category: "test", code: "ASSERTION_FAILED", message: "fixed negative assertion mismatch", retryable: false, phase: "body", source: { file: "worker-bridge.mjs", line: 60, column: 35 } } } : {}) }] }; });
  const launchConfigDigest = "a".repeat(64);
  const runnerEnvironment = { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "arm64", runtime: "node v22.23.2" };
  const startedAt = new Date(Date.parse(proofChallenge.issuedAt) + 5_000).toISOString();
  const finishedAt = new Date(Date.parse(proofChallenge.issuedAt) + 10_000).toISOString();
  const createdAt = new Date(Date.parse(proofChallenge.issuedAt) + 30_000).toISOString();
  const report = { schemaVersion: "report-1", run: { id: "33333333-3333-7333-8333-333333333333", specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" }, status: "failed", exitCode: 1, startedAt, finishedAt, project: { id: "rovara-contract-p0", configDigest: launchConfigDigest }, environment: { ...runnerEnvironment, os: proofChallenge.profileId === "linux-arm64-docker-v1" ? "linux 6.8.0" : "darwin 24.6.0" }, targets: [{ id: "contract-web-1", index: 0, platform: "contract-web-1", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }], errors: [], serialGroups: [], summary: { discovered: 3, selected: 3, executed: 3, passed: 2, failed: 1, interrupted: 0, flaky: 0, skipped: 0 }, limits: { maxAgentContextBytes: 16384, maxLedgerBytes: 8192, maxObservationBytes: 262144, maxEventsPerStep: 1000, maxModelTokensPerCall: 64000 }, usage: { discoveredResults: 3, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 }, results: reportRows } };
  const launchId = "55555555-5555-4555-8555-555555555555";
  const proposal = { schemaVersion: "runtime-installation-proposal/v1", challenge, createdAt,
    manifest: { ...manifestBody, sha256: sha(canonicalJson(manifestBody)) },
    runnerEnvironment: { ...runnerEnvironment, os: proofChallenge.profileId === "linux-arm64-docker-v1" ? "linux 6.8.0" : "darwin 24.6.0" },
    runnerToolchain: { execPath: proofChallenge.profileId === "linux-arm64-docker-v1" ? "/usr/local/bin/node" : "/opt/homebrew/bin/node", version: "v22.23.2", platform: proofChallenge.profileId === "linux-arm64-docker-v1" ? "linux" : "darwin", arch: "arm64" },
    execution: { launchConfigDigest, list: { stdout: evidence(JSON.stringify({ pairs: reportRows.map((row, index) => ({ id: row.id, file: row.file, title: row.titlePath[0], titlePath: row.titlePath, kind: "test", tags: [], source: { file: row.file, line: 20 + index, column: 1 }, sessions: [], target: "contract-web-1", agent: "default", disposition: "run" })) })), stderr: evidence(""), exitCode: 0 }, run: { stdout: evidence(JSON.stringify(report)), stderr: evidence(""), runStartCapture: evidence(`${JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", runId: report.run.id, seq: 1, challenge: launchId, at: startedAt })}\n`), launchId, exitCode: 1, signal: null, timedOut: false, aborted: false }, workerCleanup: { confirmed: true, serverListening: false, socketPresent: false, aliasEntryPresent: false, privateSentinelPresent: false } }, probes };
  return proposal;
}
