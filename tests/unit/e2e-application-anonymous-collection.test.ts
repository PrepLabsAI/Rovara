import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import process from "node:process";
import { E2E_ANONYMOUS_ACCOUNT_PROFILE_ID, canonicalJson, e2eAnonymousAccountIdDigest } from "@agentx/contracts";
import { createCompiledApiApplicationFixture } from "../support/e2e-application-fixture.js";
import type { E2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";

// Task 3.3 (Ruling AZ): the collector qualifies an anonymous case, which carries no account binding (the sentinel session and the fixed anonymous identity digest, no login and no
// identity observation), and refuses an anonymous case that claims a session, and a signed-in case that claims to be anonymous.
const sha = "a".repeat(64);
const uuidA = "11111111-1111-4111-8111-111111111111";
const ANONYMOUS_SESSION = "rovara-anonymous-5b0f4c1e-8a52-4a8e-9a8f-2d2f3b6c7d10";
const pinnedToolchain = { execPath: process.execPath, version: process.version as "v22.23.2",
  platform: process.platform as "darwin" | "linux" | "win32", arch: process.arch as "arm64" | "x64" };
const hashBytes = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const frame = (artifactId: string, value: unknown) => {
  const body = Buffer.from(canonicalJson(value));
  return { ref: { artifactId, sha256: hashBytes(body), byteLength: body.byteLength, mediaType: "application/json" }, bytes: body };
};

type Claim = { sessionRef: string; accountIdDigest: string; accountSource: (input: { caseId: string; accountRef: unknown; sessionRef: string; accountIdDigest: string; at: string }) => unknown };
const anonymousSource: Claim["accountSource"] = (input) => ({ schemaVersion: "e2e-executor-account-observation/v1", caseId: input.caseId, accountRef: input.accountRef,
  sessionRef: input.sessionRef, accountIdDigest: input.accountIdDigest, observedAt: input.at, login: null, identity: null });
const signedInSource: Claim["accountSource"] = (input) => ({ schemaVersion: "e2e-executor-account-observation/v1", caseId: input.caseId, accountRef: input.accountRef,
  sessionRef: input.sessionRef, accountIdDigest: input.accountIdDigest, observedAt: input.at, login: { status: 200, role: "owner" },
  identity: { status: 200, subjectIdDigest: sha, tenantId: "tenant-a", role: "owner" } });

/** One source-derived API case, collected through the real collector with the account facts the executor would have recorded. */
async function collectCase(options: { anonymous: boolean; claim: (applicationId: string) => Claim }) {
  const { collectE2EApplicationRun } = await import("../../packages/verifier/src/application-collection.js");
  const { E2EApplicationCaseCaptureSchema, E2EApplicationObservationBindingSchema, qualifyE2EApplicationCollection } = await import("../../packages/verifier/src/application-result-adapter.js");
  const { expectedE2EApplicationReporterDigest } = await import("../../packages/verifier/src/application-runtime-assets.js");
  const fixture = createCompiledApiApplicationFixture({ now: new Date(Date.now() - 10_000).toISOString(), anonymous: options.anonymous });
  const { compiled, binding, round } = fixture;
  const shard = compiled.shards[0]!; const tuple = shard.selection.tuples[0]!; const expected = compiled.expectedCases[0]!;
  const launchId = uuidA; const upstreamRunId = "a0000000-0000-7000-8000-000000000011";
  const admissionAt = Date.parse(round.admittedAt);
  const timeAt = (offsetMs: number) => new Date(admissionAt + offsetMs).toISOString();
  const listStarted = timeAt(100); const listFinished = timeAt(200); const processStarted = timeAt(300); const startAt = timeAt(400);
  const reportStarted = timeAt(500); const reportFinished = timeAt(600); const processFinished = timeAt(700);
  const textBytes = (value: string) => Buffer.from(value);
  const app = compiled.runtimeAdmissionContext.selectionInput.intent.applicationRuntimeRefs[0]!;
  const applicationBinding = compiled.applicationBindings.get(app.applicationId)!;
  const runtime = compiled.runtimeBindings.get(app.runtimeProfileId)!;
  const accountRef = compiled.runtimeAdmissionContext.selectionInput.runtimeAccountRefs[0]!;
  const claim = options.claim(app.applicationId);
  const bindingDigest = hashBytes(Buffer.from(canonicalJson(binding)));
  const origin = compiled.originByApplicationId[0]!.origin;
  const context = { bindingDigest, compiledInventoryDigest: compiled.inventory.digest, preparedEnvironmentDigest: compiled.preparedEnvironmentDigest,
    candidateDigest: binding.candidateDigest, roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId, lifecycleId: "owned-api-lifecycle", observedAt: processFinished,
    producer: { producerId: "synthetic-api-supervisor", receiptId: "supervisor-receipt", lifecycleId: "owned-api-lifecycle", operationId: binding.operationId,
      operationFence: binding.operationFence, runtimeManifestDigest: runtime.manifestDigest, transportCorrelationId: "33333333-3333-4333-8333-333333333333" } };
  const responseBody = frame("http-response-body", { healthy: true });
  const subject = { kind: "service" as const, processId: "owned-api-process", origin };
  const evidence = frame("http-observation", { schemaVersion: "e2e-application-assertion-observation/v1", kind: "http-status" as const, caseId: expected.caseId,
    assertionIndex: 0, assertionDigest: expected.assertionDigests[0], observationId: "http-response-1", lifecycleId: context.lifecycleId, observedAt: reportStarted,
    producer: context.producer, subject, accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest,
    sessionRef: claim.sessionRef, accountIdDigest: claim.accountIdDigest, requestId: "health", responseId: "response-1", method: "GET", path: "/health", origin, status: 200,
    bodyRef: responseBody.ref, connectionRef: null });
  const captureValue = E2EApplicationCaseCaptureSchema.parse({ schemaVersion: "e2e-application-case-capture/v1", caseId: expected.caseId, upstreamRunId, shardId: shard.shardId,
    roundId: binding.roundId, runId: binding.runId, groupId: binding.groupId, candidateDigest: binding.candidateDigest, applicationId: app.applicationId,
    buildManifestDigest: applicationBinding.build.manifestDigest, runtimeManifestDigest: runtime.manifestDigest, executionDescriptorDigest: expected.executionDescriptorDigest,
    accountContextId: expected.accountContextId, accountContextDigest: expected.accountContextDigest, observedAt: reportStarted, lifecycleId: context.lifecycleId, subject,
    producer: context.producer,
    steps: [{ index: 0, declaredStepIndex: 0, kind: "request", actionDigest: hashBytes(Buffer.from(canonicalJson(compiled.bundle.scenarios[0]!.steps[0]))),
      observationId: "http-response-1", at: reportStarted, outcome: "completed", evidenceRefs: [evidence.ref], agentOperationRefs: [] }],
    assertions: [{ index: 0, digest: expected.assertionDigests[0], observedAt: reportStarted, observationId: "http-response-1", value: 200, evidenceRef: evidence.ref,
      outcome: "passed", reason: "observed HTTP 200 from owned API service", producer: context.producer }],
    terminal: { kind: "completed" as const, lastDeclaredStepIndex: 0, failedAssertionIndex: null, at: reportFinished, reason: "complete" }, modelReceipts: [], artifacts: [],
    coverage: { observedScope: "runtime", subject: "candidate", executedCandidateParts: [app.applicationId], realComponentIds: [], mockedComponentIds: [],
      observedMockedComponentIds: [], unexercisedBehaviors: [] }, cleanup: "confirmed" });
  const captureFrame = frame("case-capture", captureValue);
  const cleanupFrame = frame("owned-cleanup", { schemaVersion: "e2e-application-owned-cleanup/v1", context, phase: "after-owned-close", cleanup: "confirmed", confirmed: true,
    serverListening: false, ownedResourceInventoryDigest: sha, ownedCleanupReceiptRefs: [] });
  const sourceReceipt = frame("source-ingress-receipt", { schemaVersion: "test-source-ingress/v1", source: "offline-conformance" });
  const identitySourceReceipt = frame("identity-source-receipt", claim.accountSource({ caseId: expected.caseId, accountRef, sessionRef: claim.sessionRef,
    accountIdDigest: claim.accountIdDigest, at: processStarted }));
  const subjectIdentitySourceReceipt = frame("subject-identity-source-receipt", { schemaVersion: "conformance-subject-source/v1", source: "offline fixture only" });
  const identityReceipt = frame("identity-receipt", { schemaVersion: "e2e-application-account-identity/v1", caseId: expected.caseId, bindingDigest, upstreamRunId,
    lifecycleId: context.lifecycleId, producer: context.producer, observedAt: processStarted, sourceReceiptRef: identitySourceReceipt.ref, accountRef,
    sessionRef: claim.sessionRef, accountIdDigest: claim.accountIdDigest });
  const subjectIdentityReceipt = frame("subject-identity-receipt", { schemaVersion: "e2e-application-subject-identity/v1", caseId: expected.caseId, bindingDigest, upstreamRunId,
    lifecycleId: context.lifecycleId, producer: context.producer, observedAt: processStarted, sourceReceiptRef: subjectIdentitySourceReceipt.ref, subject: captureValue.subject });
  const expectedSupervisorRefs = [identityReceipt.ref, identitySourceReceipt.ref, subjectIdentityReceipt.ref, subjectIdentitySourceReceipt.ref, sourceReceipt.ref]
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
  const launches = [{ shardId: shard.shardId, launchId, upstreamRunId }];
  const receipt = frame("supervisor-top-receipt", { schemaVersion: "e2e-application-supervisor-receipt/v1", context, launches,
    caseCaptures: [{ caseId: expected.caseId, shardId: shard.shardId, ref: captureFrame.ref }], cleanupRef: cleanupFrame.ref, additionalSupervisorReceiptRefs: expectedSupervisorRefs,
    mockConsumptions: [] });
  const readback = { schemaVersion: "e2e-application-supervisor-readback/v1" as const, receipt,
    evidence: [captureFrame, cleanupFrame, sourceReceipt, evidence, responseBody, identityReceipt, identitySourceReceipt, subjectIdentityReceipt, subjectIdentitySourceReceipt]
      .sort((left, right) => left.ref.artifactId.localeCompare(right.ref.artifactId)) };
  const publicList = { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-application.test.ts", title: tuple.title, titlePath: [tuple.title], kind: "test",
    sessions: [], target: tuple.targetName, agent: "default", disposition: "run", tags: [], source: tuple.source }], targets: [tuple.targetId], unmatched: [] };
  const listBytes = textBytes(JSON.stringify({ pairs: publicList.pairs })); const stderrBytes = Buffer.alloc(0);
  const runStart = { schemaVersion: "e2e-run-start-capture/v1", challenge: launchId, runId: upstreamRunId, seq: 1, at: startAt };
  const report: E2EApplicationReport = { schemaVersion: "report-1", run: { id: upstreamRunId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" }, status: "passed",
    exitCode: 0, startedAt: reportStarted, finishedAt: reportFinished, project: { id: "rovara-application-e2e", configDigest: shard.expectedConfigDigest },
    environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
    targets: [{ id: tuple.targetId, index: 0, platform: "api", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [],
      artifactCapabilities: [], stateCapability: false }], serialGroups: [],
    results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title], file: ".agentx/e2e/generated-application.test.ts",
      source: tuple.source, targetId: tuple.targetId, platform: "api", agent: "default", repeat: 0, tags: [], selected: true, status: "passed",
      attempts: [{ id: upstreamRunId, index: 0, status: "passed", startedAt: reportStarted, durationMs: 10, artifacts: [], appLog: [], secondaryErrors: [], cleanup: "complete",
        steps: [{ id: "assertion-step", index: 0, kind: "assertion", api: "assert.http-status", label: "health status", source: tuple.source, status: "passed",
          startedAt: reportStarted, durationMs: 1, events: [], artifacts: [] }] }] }],
    errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 },
    limits: { maxAgentContextBytes: 1024, maxLedgerBytes: 1024, maxObservationBytes: 1024, maxEventsPerStep: 1000, maxModelTokensPerCall: 1024 },
    usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0,
      maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } };
  const reportBytes = textBytes(JSON.stringify(report));
  const processRecord = (status: number, startedAt: string, finishedAt: string, stdout: Uint8Array) => ({ status, signal: null, startedAt, finishedAt, timedOut: false, aborted: false,
    stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(stderrBytes), stdoutBytes: stdout.byteLength, stderrBytes: 0 });
  const actual = { protocol: "e2e-actual-application-run/v1" as const, runnerToolchain: pinnedToolchain,
    shards: [{ shardId: shard.shardId, launchId, launchConfigDigest: shard.expectedConfigDigest,
      fixedAssetDigests: { compilerInventory: shard.inventory.digest, reporter: expectedE2EApplicationReporterDigest(launchId) }, publicList, listStdoutBytes: listBytes,
      listStderrBytes: stderrBytes, rawReportBytes: reportBytes, runStderrBytes: stderrBytes, runStartCaptureBytes: textBytes(`${JSON.stringify(runStart)}\n`), runStartCapture: runStart,
      listProcess: processRecord(0, listStarted, listFinished, listBytes), runProcess: processRecord(0, processStarted, processFinished, reportBytes) }],
    applicationCaptures: [captureValue], supervisorReceiptRefs: [receipt.ref, ...expectedSupervisorRefs].sort((left, right) => left.artifactId.localeCompare(right.artifactId)),
    declaredMockComponentIds: [], selected: 1, filtered: 0, supervisorReadback: readback, cleanupConfirmed: true, cleanupServerListening: false, evidenceDirectory: "/offline-fixture" };
  const observationBinding = E2EApplicationObservationBindingSchema.parse({ caseId: expected.caseId, subject: captureValue.subject, caseProducer: context.producer,
    assertionProducers: [{ assertionIndex: 0, producer: context.producer }], accountRef, sessionRef: claim.sessionRef, accountIdDigest: claim.accountIdDigest,
    identityReceiptRef: identityReceipt.ref, subjectIdentityReceiptRef: subjectIdentityReceipt.ref, selectedArtifact: applicationBinding.artifacts[0]!, connection: null });
  const result = collectE2EApplicationRun({ actual, compiled, binding, round, environment: { ci: true, trustNoticeShown: false, os: "linux 6.8.0", arch: "x64", runtime: "node v22.23.2" },
    usage: report.run.usage as Record<string, number>, limits: report.run.limits, expectedSupervisorReceiptRefs: expectedSupervisorRefs, ownedResourceInventoryDigest: sha,
    observationBindings: [observationBinding], assertionAssets: [], governedModelReceipts: null, ownedClosedAt: processFinished });
  return { result, expected, accountRef, qualify: qualifyE2EApplicationCollection };
}

const anonymousClaim = (applicationId: string): Claim => ({ sessionRef: ANONYMOUS_SESSION, accountIdDigest: e2eAnonymousAccountIdDigest(applicationId), accountSource: anonymousSource });

describe("anonymous cases in the collector (Ruling AZ)", () => {
  it("qualifies an anonymous case that has no account binding: the fixed reference, the sentinel session, the fixed identity digest, and no login or identity observed", async () => {
    const { result, expected, accountRef } = await collectCase({ anonymous: true, claim: anonymousClaim });
    expect(result.unavailableReason).toBeNull();
    expect(expected.accountProfileId).toBe(E2E_ANONYMOUS_ACCOUNT_PROFILE_ID);
    expect(accountRef.profileId).toBe(E2E_ANONYMOUS_ACCOUNT_PROFILE_ID);
    expect(result.qualification).toMatchObject({ status: "PASS", result: { qualification: "exploratory", status: "passed" } });
  });

  it("refuses an anonymous case whose record claims a session: a session that is not the sentinel, another identity digest, or a login or identity the executor never made", async () => {
    const refused = async (claim: (applicationId: string) => Claim) => {
      const { result } = await collectCase({ anonymous: true, claim });
      return result.qualification?.status ?? `unavailable: ${result.unavailableReason}`;
    };
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), sessionRef: "api-session-1" }))).toBe("UNKNOWN");
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), sessionRef: "rovara-anonymous-not-a-uuid" }))).toBe("UNKNOWN");
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), accountIdDigest: sha }))).toBe("UNKNOWN");
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), accountSource: signedInSource }))).toBe("UNKNOWN");
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), accountSource: (input) => ({ ...(anonymousSource(input) as object), login: { status: 200, role: "owner" } }) }))).toBe("UNKNOWN");
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), accountSource: (input) => ({ ...(anonymousSource(input) as object), sessionRef: "rovara-anonymous-other" }) }))).toBe("UNKNOWN");
    // The anonymous source must be the executor's own observation, not some other document.
    expect(await refused((applicationId) => ({ ...anonymousClaim(applicationId), accountSource: () => ({ schemaVersion: "conformance-account-source/v1" }) }))).toBe("UNKNOWN");
  });

  it("refuses a signed-in case that claims the anonymous session, so no account can be passed off as the signed-out visitor", async () => {
    const { result } = await collectCase({ anonymous: false, claim: (applicationId) => ({ ...anonymousClaim(applicationId), accountSource: signedInSource }) });
    expect(result.qualification?.status ?? `unavailable: ${result.unavailableReason}`).toBe("UNKNOWN");
  });

  it("keeps qualifying a signed-in case with an ordinary session, as before", async () => {
    const { result } = await collectCase({ anonymous: false, claim: () => ({ sessionRef: "api-session-1", accountIdDigest: sha, accountSource: signedInSource }) });
    expect(result.unavailableReason).toBeNull();
    expect(result.qualification?.status).toBe("PASS");
  });
});
