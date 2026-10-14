import { createHash, randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../packages/contracts/src/canonical-json.js";
import { RuntimeInstallationProposalSchema, runtimeInstallChallengeDigest, runtimeInstallationProposalSha256, type RuntimeInstallChallenge } from "../../packages/contracts/src/runtime-installation.js";
import { issueRuntimeInstallChallenge, registerRuntimeInstallation, type RuntimeInstallationDependencies } from "../../packages/broker/src/aws/runtime-installation.js";
import type { AuthenticatedIdentity } from "../../packages/broker/src/auth.js";
import { assertRuntimeInstallationEndpointIdentity, assertRuntimeInstallationHostIdentity } from "../../packages/verifier/src/install-qualification.js";

const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const admin: AuthenticatedIdentity = { issuer: "test", subject: "admin", ownerKey: "admin", isAdministrator: true, claims: {} };
const ordinary: AuthenticatedIdentity = { ...admin, subject: "operator", ownerKey: "operator", isAdministrator: false };

function proposalFor(challenge: RuntimeInstallChallenge) {
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
  const reportRows = scenarios.map((_scenario, index) => { const testId = `.agentx/e2e/generated-contract.test.ts::${reportCaseIds[index]}`; const targetId = "contract-web-1"; const agent = "default"; const status = ["passed", "passed", "failed"][index]; return { id: sha(canonicalJson({ testId, targetId, agent })), testId, titlePath: [reportCaseIds[index]], file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: index + 1, column: 1 }, declarationIndex: index, targetId, platform: targetId, agent, kind: "test", selected: true, repeat: 0, tags: [], status, attempts: [{ id: `66666666-6666-4666-8666-66666666666${index}`, index: 0, status, startedAt: "2026-10-14T12:01:00.000Z", durationMs: 1, cleanup: "complete", artifacts: [], steps: [], secondaryErrors: [], ...(status === "failed" ? { error: { category: "test", code: "ASSERTION_FAILED", message: "fixed negative assertion mismatch", retryable: false, phase: "body", source: { file: "worker-bridge.mjs", line: 60, column: 35 } } } : {}) }] }; });
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
    execution: { launchConfigDigest, list: { stdout: evidence(JSON.stringify({ pairs: reportRows.map((row) => ({ id: row.id, disposition: "run", title: row.titlePath[0], target: row.targetId, agent: row.agent })) })), stderr: evidence(""), exitCode: 0 }, run: { stdout: evidence(JSON.stringify(report)), stderr: evidence(""), runStartCapture: evidence(`${JSON.stringify({ schemaVersion: "e2e-run-start-capture/v1", runId: report.run.id, seq: 1, challenge: launchId, at: startedAt })}\n`), launchId, exitCode: 1, signal: null, timedOut: false, aborted: false }, workerCleanup: { confirmed: true, serverListening: false, socketPresent: false, aliasEntryPresent: false, privateSentinelPresent: false } }, probes };
  return proposal;
}

function challengeStore() {
  const items = new Map<string, Record<string, unknown>>();
  const documentClient = { send: async (command: unknown) => {
    const record = command as { input?: Record<string, unknown> };
    const input = record.input ?? {};
    if (input.Item && typeof input.Item === "object") {
      const item = input.Item as Record<string, unknown>;
      items.set(`${String(item.pk)}|${String(item.sk)}`, item);
      return {};
    }
    if (input.Key && typeof input.Key === "object") {
      const key = input.Key as Record<string, unknown>;
      return { Item: items.get(`${String(key.pk)}|${String(key.sk)}`) };
    }
    throw new Error("unexpected registrar datastore access in wrong-host test");
  } };
  return { items, documentClient };
}

function seedIssuedChallenge(items: Map<string, Record<string, unknown>>, challenge: RuntimeInstallChallenge) {
  items.set(`RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}|CHALLENGE`, {
    pk: `RUNTIME_INSTALL_CHALLENGE#${challenge.challengeId}`, sk: "CHALLENGE", entityType: "RUNTIME_INSTALL_CHALLENGE", state: "ISSUED",
    challengeDigest: runtimeInstallChallengeDigest(challenge), secretSha256: sha(Buffer.from(challenge.challengeSecret, "base64")),
    issuedByOwnerKey: challenge.issuedByOwnerKey, issuedBySubject: challenge.issuedBySubject, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt,
  });
}

describe("runtime installation broker registration", () => {
  it("fails closed when a Linux challenge does not match actual boot workspace and generation", () => {
    const localIpv4 = Object.values(networkInterfaces()).flatMap((items) => (items ?? []).filter((item) => !item.internal && item.family === "IPv4").map((item) => item.address))[0] ?? "192.168.1.2";
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      issuedByOwnerKey: "admin", issuedBySubject: "admin", binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "linux-arm64-docker-v1" as const, endpoint: `http://${localIpv4}:8080`, generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, {})).toThrow(/boot-injected workspace identity/);
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, { AGENTX_WORKSPACE_ID: randomUUID(), AGENTX_SESSION_GENERATION: "3" })).toThrow(/boot-injected workspace identity/);
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, { AGENTX_WORKSPACE_ID: challenge.transportCorrelationId, AGENTX_SESSION_GENERATION: "2" })).toThrow(/boot-injected workspace identity/);
    expect(() => assertRuntimeInstallationHostIdentity(challenge.profileId, challenge, { AGENTX_WORKSPACE_ID: challenge.transportCorrelationId, AGENTX_SESSION_GENERATION: "3" })).not.toThrow();
    expect(() => assertRuntimeInstallationEndpointIdentity("http://10.1.2.3:8080", 8080, ["10.1.2.3"])).not.toThrow();
    expect(() => assertRuntimeInstallationEndpointIdentity("http://10.1.2.4:8080", 8080, ["10.1.2.3"])).toThrow(/does not match/);
    expect(() => assertRuntimeInstallationEndpointIdentity("http://10.1.2.3:3000", 8080, ["10.1.2.3"])).toThrow(/does not match/);
  });

  it("requires administrator authority before issuing a challenge and derives catalog IDs server-side", async () => {
    const { items, documentClient } = challengeStore();
    const deps = { documentClient, s3: { send: async () => { throw new Error("unused"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature" } as unknown as RuntimeInstallationDependencies;
    const request = { binding: { deploymentMode: "ec2-ebs", launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" }, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), profileId: "darwin-arm64-colima-v1" };
    await expect(issueRuntimeInstallChallenge(deps, ordinary, request)).rejects.toThrow(/administrator/);
    expect(items.size).toBe(0);
    const challenge = await issueRuntimeInstallChallenge(deps, admin, request);
    expect(challenge.setupCatalogId).toBe("configured-setup");
    expect(challenge.featureCatalogId).toBe("configured-feature");
    expect(new Set(Object.values(challenge.probeCorrelations)).size).toBe(3);
    expect(items.size).toBe(1);
  });

  it("does not publish local Darwin evidence into the standard Linux catalog", async () => {
    const { items, documentClient } = challengeStore();
    const now = Date.parse("2026-10-14T12:04:00.000Z");
    const deps = { documentClient, s3: { send: async () => { throw new Error("must reject before evidence storage"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => now } as unknown as RuntimeInstallationDependencies;
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date(now - 120_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      issuedByOwnerKey: "admin", issuedBySubject: "admin", binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "darwin-arm64-colima-v1" as const, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    seedIssuedChallenge(items, challenge);
    const proposal = proposalFor(challenge);
    const parsedProposal = RuntimeInstallationProposalSchema.safeParse(proposal);
    if (!parsedProposal.success) throw new Error(JSON.stringify(parsedProposal.error.issues));
    await expect(registerRuntimeInstallation(deps, admin, { proposal, proposalSha256: runtimeInstallationProposalSha256(proposal) })).rejects.toThrow(/Linux ARM64 worker supervisor/);
    expect(items.size).toBe(1);
  });

  it("binds redemption and immutable evidence approval to the challenge issuer", async () => {
    const { items, documentClient } = challengeStore();
    const now = Date.parse("2026-10-14T12:04:00.000Z");
    const deps = { documentClient, s3: { send: async () => { throw new Error("must reject before evidence storage"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => now } as unknown as RuntimeInstallationDependencies;
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date(now - 120_000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      issuedByOwnerKey: admin.ownerKey, issuedBySubject: admin.subject, binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", profileId: "darwin-arm64-colima-v1" as const, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    seedIssuedChallenge(items, challenge);
    const proposal = proposalFor(challenge);
    const otherAdmin: AuthenticatedIdentity = { ...admin, ownerKey: "other-admin", subject: "other-admin" };
    await expect(registerRuntimeInstallation(deps, otherAdmin, { proposal, proposalSha256: runtimeInstallationProposalSha256(proposal) })).rejects.toThrow(/administrator who issued its challenge/);
    expect(items.size).toBe(1);
  });

  it("rejects wrong catalog identities and fresh-challenge replay before registrar writes", async () => {
    const { items, documentClient } = challengeStore();
    const now = Date.parse("2026-10-14T12:00:00.000Z");
    const deps = { documentClient, s3: { send: async () => { throw new Error("must reject before evidence storage"); } }, tableName: "state", artifactBucketName: "artifacts", setupCatalogId: "configured-setup", featureCatalogId: "configured-feature", now: () => now } as unknown as RuntimeInstallationDependencies;
    const challenge = { schemaVersion: "runtime-install-challenge/v1" as const, challengeId: randomUUID(), challengeSecret: randomBytes(32).toString("base64"), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString(),
      issuedByOwnerKey: "admin", issuedBySubject: "admin", binding: { deploymentMode: "ec2-ebs" as const, launchTemplateId: "lt-01234567", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-01234567" }], volumeSizeGiB: 32, volumeType: "gp3" as const }, setupCatalogId: "attacker-catalog", featureCatalogId: "attacker-feature", profileId: "darwin-arm64-colima-v1" as const, endpoint: "http://10.0.2.15:8080", generation: 3, transportCorrelationId: randomUUID(), probeCorrelations: { sourceInterface: randomUUID(), featurePositive: randomUUID(), featureNegative: randomUUID() } };
    seedIssuedChallenge(items, challenge);
    const proposal = proposalFor(challenge);
    await expect(registerRuntimeInstallation(deps, admin, { proposal, proposalSha256: runtimeInstallationProposalSha256(proposal) })).rejects.toThrow(/catalogs do not match/);
    const replay = structuredClone(proposal);
    replay.challenge.challengeId = randomUUID();
    await expect(registerRuntimeInstallation(deps, admin, { proposal: replay, proposalSha256: "a".repeat(64) })).rejects.toThrow();
    expect(items.size).toBe(1);
  });
});
