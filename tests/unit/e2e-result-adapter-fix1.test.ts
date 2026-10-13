/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- fixture mutators intentionally alter parsed runner and contract packets */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import { qualifyE2ECollection, type E2ECollection, type E2ECollectionOracle } from "../../packages/verifier/src/result-adapter.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const d = (char: string) => char.repeat(64);
const runId = "01a13408-3523-7f7a-934e-960e833611cf";
function fixture() {
  const assertionDigests = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(64, "0"));
  const identity: any = { caseId: "", criterionId: "criterion-1", scenarioId: "scenario-1", targetId: "web-1", requestedTargetId: "web-1", agentId: "template-v1", repeat: 0, executionDescriptorDigest: d("1"), accountContextId: "context-1", accountContextDigest: "2".repeat(64), accountProfileId: "account-1", assertionDigest: digest(JSON.stringify(assertionDigests)), assertionDigests, required: true, minimumEvidence: "mock-contract", requiredRealComponentIds: [] };
  identity.caseId = e2eCaseIdFromIdentity(identity);
  identity.upstreamTestId = e2eUpstreamTestIdFromIdentity(identity);
  const binding: any = { schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000001", roundId: "a0000000-0000-4000-8000-000000000010", taskId: "task-1", operationId: "operation-1", operationFence: 1, workflowRevision: 1, groupId: "group-1", executionPlanDigest: d("a"), executionMode: "mock-only", mockManifestDigest: d("5"), authorizationRevision: "auth-1", candidateDigest: d("c"), planDigest: d("a"), policyDigest: d("7"), bundleDigest: d("8"), appBuildDigest: d("1"), environmentDigest: d("2"), runtimeManifestDigest: d("3"), modelRouteRevision: null, expectedCases: [identity], admittedAt: "2026-10-13T11:59:00.000Z", deadlineAt: "2026-10-13T12:05:00.000Z" };
  const round: any = { schemaVersion: 1, roundId: binding.roundId, taskId: binding.taskId, operationId: binding.operationId, operationFence: binding.operationFence, workflowRevision: binding.workflowRevision, executionPlanDigest: binding.executionPlanDigest, admittedAt: binding.admittedAt, deadlineAt: binding.deadlineAt, limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null }, groupBindings: [binding] };
  const configDigest = d("a");
  const tuple: any = { caseId: identity.caseId, compilerCaseIdentity: d("b"), registrationKey: "registration:v1", candidateResponseScope: "contained-candidate-process-response/v1", requestProtocol: "contained-candidate-host-request/v1", upstreamTestId: identity.upstreamTestId, upstreamResultId: d("e"), title: "fixture case", targetId: "web-1", targetName: "contract-api", agent: "default", disposition: "run" };
  const report: any = { schemaVersion: "report-1", run: { id: runId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" }, status: "passed", exitCode: 0, startedAt: "2026-10-13T12:00:00.000Z", finishedAt: "2026-10-13T12:00:01.000Z", project: { id: "rovara-contract-p0", configDigest }, environment: { ci: false, trustNoticeShown: true, os: "darwin", arch: "arm64", runtime: "node" }, targets: [{ id: "contract-api", index: 0, platform: "contract-api", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }], serialGroups: [], results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title], file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, targetId: tuple.targetName, platform: tuple.targetName, agent: "default", repeat: 0, tags: [], selected: true, status: "passed", attempts: [{ id: runId, index: 0, status: "passed", startedAt: "2026-10-13T12:00:00.100Z", durationMs: 0.5, steps: [], artifacts: [], secondaryErrors: [], cleanup: "complete" }] }], errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 }, limits: { maxAgentContextBytes: 1, maxLedgerBytes: 1, maxObservationBytes: 1, maxEventsPerStep: 1, maxModelTokensPerCall: 1 }, usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } };
  const requestBytes = Buffer.from('{"requestId":"request-1","input":{"protocol":"supervisor","input":1}}');
  const responseBytes = Buffer.from('{"wireId":"request-1","output":true}');
  const observation = { caseId: identity.caseId, requestId: "request-1", requestBytes, responseBytes, observedAt: "2026-10-13T12:00:00.500Z", lifecycleId: "life-1", cleanup: "complete" as const, coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], observedMockedComponentIds: ["api"], unexercisedBehaviors: [] } };
  const receipts = assertionDigests.map((assertionDigest, assertionIndex) => ({ runId: binding.runId, roundId: binding.roundId, groupId: binding.groupId, caseId: identity.caseId, upstreamRunId: runId, candidateDigest: binding.candidateDigest, sourceDigest: d("f"), bundleDigest: binding.bundleDigest, compilerCaseIdentity: tuple.compilerCaseIdentity, registrationKey: tuple.registrationKey, semanticApprovalDigest: d("9"), executionDescriptorDigest: identity.executionDescriptorDigest, accountIdDigest: d("6"), assertionIndex, assertionDigest, requestId: observation.requestId, requestSha256: digest(requestBytes), responseSha256: digest(responseBytes), observedAt: observation.observedAt, lifecycleId: observation.lifecycleId, cleanup: "complete" as const, outcome: "passed" as const }));
  const oracle: E2ECollectionOracle = { binding, round, selection: { schemaVersion: 1, algorithm: "e2e-public-list-selection/v1", planDigest: binding.executionPlanDigest, groupId: binding.groupId, tuples: [tuple] }, projectId: "rovara-contract-p0", configDigest, compiledConfigDigest: configDigest, runnerName: "e2e", runnerVersion: "0.20.0", fixedAssetDigests: { bootstrap: d("4") }, declaredMockComponentIds: ["api"], sourceDigest: d("f"), artifacts: [], usage: report.run.usage, limits: report.run.limits, environment: report.run.environment, targets: report.run.targets, cases: [{ caseId: identity.caseId, compilerCaseIdentity: tuple.compilerCaseIdentity, registrationKey: tuple.registrationKey, semanticApprovalDigest: d("9"), accountIdDigest: d("6"), declarationIndex: 0, sourceLine: 1, sourceColumn: 1, tags: [], expectedRequest: { protocol: "supervisor", input: 1 }, assertions: assertionDigests.map((assertionDigest, index) => ({ index, digest: assertionDigest, expectedResponse: true })) }] };
  const collection: E2ECollection = { rawReportBytes: Buffer.from(JSON.stringify(report)), runStart: { runId, sequence: 1, launchId: "launch-1", capturedAt: report.run.startedAt }, process: { exitCode: 0, signal: null, startedAt: report.run.startedAt, finishedAt: report.run.finishedAt, drained: true, aborted: false, timedOut: false }, configDigest, fixedAssetDigests: { bootstrap: d("4") }, publicList: { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-contract.test.ts", title: tuple.title, titlePath: [tuple.title], kind: "test", sessions: [], target: tuple.targetName, agent: "default", disposition: "run", source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, tags: [] }], unmatched: [] }, receivedAt: report.run.finishedAt, observations: [observation], receipts };
  const filteredTuple = { ...tuple, upstreamTestId: "generated::filtered", upstreamResultId: d("2"), title: "filtered case", disposition: "filtered" as const };
  oracle.selection.tuples.push(filteredTuple);
  const filteredReason = "test declares platforms [fixture case]";
  report.run.results.push({ ...report.run.results[0], id: filteredTuple.upstreamResultId, testId: filteredTuple.upstreamTestId, titlePath: [filteredTuple.title], selected: false, status: "skipped", attempts: [], skip: { cause: "platform-unavailable", reason: filteredReason } });
  report.run.summary.discovered = 2;
  collection.publicList.pairs.push({ id: filteredTuple.upstreamResultId, file: ".agentx/e2e/generated-contract.test.ts", title: filteredTuple.title, titlePath: [filteredTuple.title], kind: "test", sessions: [], target: filteredTuple.targetName, agent: "default", disposition: "filtered", reason: filteredReason, source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, tags: [] });
  collection.rawReportBytes = Buffer.from(JSON.stringify(report));
  return { oracle, collection, report, identity, receipt: receipts[0]! };
}

describe("complete structural collection qualification", () => {
  it("returns normalized scoped PASS only for a complete current binding and every per-index receipt", () => {
    const f = fixture();
    const result = qualifyE2ECollection(f.oracle, f.collection);
    expect(result.status, result.reason).toBe("PASS");
    expect(result.result?.qualification).toBe("exploratory");
    expect(result.result?.cases[0]?.assertionReceipts).toHaveLength(20);
  });
  it("rejects missing, duplicate, and byte-hash-mutated assertion receipts", () => {
    const f = fixture();
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, receipts: f.collection.receipts.slice(0, -1) }).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, receipts: [...f.collection.receipts, f.receipt] }).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, receipts: [{ ...f.receipt, responseSha256: d("1") }, ...f.collection.receipts.slice(1)] }).status).toBe("UNKNOWN");
  });
  it("uses selected-row summary semantics and preserves an actual assertion failure", () => {
    const f = fixture();
    expect(qualifyE2ECollection(f.oracle, f.collection).status).toBe("PASS");
    const counterfeit = structuredClone(f.collection);
    const counterfeitReport = JSON.parse(Buffer.from(counterfeit.rawReportBytes).toString("utf8"));
    counterfeitReport.run.summary.skipped = 1;
    counterfeit.rawReportBytes = Buffer.from(JSON.stringify(counterfeitReport));
    expect(qualifyE2ECollection(f.oracle, counterfeit).status).toBe("UNKNOWN");
    const failed = structuredClone(f.collection);
    const failedReport = JSON.parse(Buffer.from(failed.rawReportBytes).toString("utf8"));
    const row = failedReport.run.results[0];
    row.status = "failed"; row.attempts[0].status = "failed"; row.attempts[0].error = { category: "test", code: "ASSERTION_FAILED", message: "assertion mismatch", retryable: false };
    failedReport.run.status = "failed"; failedReport.run.exitCode = 1; failedReport.run.summary.passed = 0; failedReport.run.summary.failed = 1;
    failed.rawReportBytes = Buffer.from(JSON.stringify(failedReport));
    failed.process.exitCode = 1;
    failed.observations[0].responseBytes = Buffer.from("{\"wireId\":\"request-1\",\"output\":false}");
    failed.receipts = failed.receipts.map((receipt) => ({ ...receipt, responseSha256: digest(failed.observations[0].responseBytes), outcome: "failed" }));
    const normalized = qualifyE2ECollection(f.oracle, failed);
    expect(normalized.status).toBe("FAILED");
    expect(normalized.result?.cases[0]?.status).toBe("failed");
    const retried = structuredClone(f.collection);
    const retryReport = JSON.parse(Buffer.from(retried.rawReportBytes).toString("utf8"));
    const retryRow = retryReport.run.results[0];
    retryRow.status = "flaky";
    retryRow.attempts[0].status = "failed";
    retryRow.attempts[0].error = { category: "test", code: "FIRST_ATTEMPT_FAILED", message: "first attempt failed", retryable: true };
    retryRow.attempts.push({ ...retryRow.attempts[0], id: "018f47a2-9b3c-7abc-8def-1123456789ab", index: 1, status: "passed", startedAt: "2026-10-13T12:00:00.600Z", error: undefined });
    retryReport.run.status = "failed"; retryReport.run.exitCode = 1; retryReport.run.summary.executed = 1; retryReport.run.summary.passed = 0; retryReport.run.summary.flaky = 1;
    retried.rawReportBytes = Buffer.from(JSON.stringify(retryReport)); retried.process.exitCode = 1;
    const unstable = qualifyE2ECollection(f.oracle, retried);
    expect(unstable.status, unstable.reason).toBe("FAILED");
    expect(unstable.result?.cases[0]?.status).toBe("unstable");
  });
  it("rejects unmet scope, unsafe collection hooks, stale identity, and malformed bytes without throwing", () => {
    const f = fixture();
    const weaker = structuredClone(f.collection);
    weaker.observations[0].coverage.observedScope = "source";
    expect(qualifyE2ECollection(f.oracle, weaker).status).toBe("UNKNOWN");
    const forgedMockUse = structuredClone(f.collection);
    forgedMockUse.observations[0].coverage.observedMockedComponentIds = ["undeclared"];
    expect(qualifyE2ECollection(f.oracle, forgedMockUse).status).toBe("UNKNOWN");
    const stale = structuredClone(f.collection);
    stale.runStart.runId = "01a13408-3523-7f7a-934e-960e83361000";
    expect(qualifyE2ECollection(f.oracle, stale).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, rawReportBytes: null as never }).status).toBe("UNKNOWN");
    let invoked = false;
    const receipts: unknown[] = [];
    Object.defineProperty(receipts, "0", { enumerable: true, get() { invoked = true; throw new Error("receipt hook"); } });
    Object.defineProperty(receipts, "length", { value: 1 });
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, receipts: receipts as never }).status).toBe("UNKNOWN");
    expect(invoked).toBe(false);
  });

  it("binds the report to the exact pinned runner, source declaration, process, and attempt outcome", () => {
    const f = fixture();
    const mutateReport = (change: (report: any) => void) => {
      const collection = structuredClone(f.collection);
      const report = JSON.parse(Buffer.from(collection.rawReportBytes).toString("utf8"));
      change(report);
      collection.rawReportBytes = Buffer.from(JSON.stringify(report));
      return collection;
    };
    expect(qualifyE2ECollection(f.oracle, mutateReport((report) => { report.run.runner.version = "9.9.9"; })).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, mutateReport((report) => { report.run.results[0].source.line += 1; })).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, mutateReport((report) => { report.run.results[0].attempts[0].error = { category: "test", code: "ASSERTION_FAILED", message: "contradicts passed row", retryable: false }; })).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, configDigest: d("1") }).status).toBe("UNKNOWN");
  });
});
