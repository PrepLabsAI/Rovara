import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { e2eCaseIdFromIdentity, e2eUpstreamTestIdFromIdentity } from "../../packages/contracts/src/e2e-case-identity.js";
import { E2ERoundSchema, E2ERunBindingSchema, type E2EExpectedCase } from "../../packages/contracts/src/e2e.js";
import { E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, projectE2EModuleExportNames, qualifyE2ECollection, type E2ECollection, type E2ECollectionOracle } from "../../packages/verifier/src/result-adapter.js";
import { E2EReportSchema, type E2EReport } from "../../packages/verifier/src/report-schema.js";
import type { E2ESelectionTuple } from "../../packages/verifier/src/selection.js";

type DeepMutable<T> = T extends Uint8Array ? Uint8Array : T extends readonly (infer U)[] ? DeepMutable<U>[] : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const d = (char: string) => char.repeat(64);
const runId = "01a13408-3523-7f7a-934e-960e833611cf";
const parseReport = (bytes: Uint8Array): DeepMutable<E2EReport> => E2EReportSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
function fixture() {
  const assertionDigests = Array.from({ length: 20 }, (_, index) => index.toString(16).padStart(64, "0"));
  const identityBase = { criterionId: "criterion-1", scenarioId: "scenario-1", targetId: "web-1", requestedTargetId: "web-1", agentId: "template-v1", repeat: 0 as const, executionDescriptorDigest: d("1"), accountContextId: "context-1", accountContextDigest: "2".repeat(64), accountProfileId: "account-1", assertionDigest: digest(JSON.stringify(assertionDigests)), assertionDigests, required: true, minimumEvidence: "mock-contract" as const, requiredRealComponentIds: [] };
  const identity: E2EExpectedCase = { ...identityBase, caseId: e2eCaseIdFromIdentity(identityBase), upstreamTestId: "" };
  const exactIdentity: E2EExpectedCase = { ...identity, upstreamTestId: e2eUpstreamTestIdFromIdentity(identity) };
  const binding = E2ERunBindingSchema.parse({ schemaVersion: 1, runId: "a0000000-0000-4000-8000-000000000001", roundId: "a0000000-0000-4000-8000-000000000010", taskId: "task-1", operationId: "operation-1", operationFence: 1, workflowRevision: 1, groupId: "group-1", executionPlanDigest: d("a"), executionMode: "mock-only", mockManifestDigest: d("5"), authorizationRevision: "auth-1", candidateDigest: d("c"), planDigest: d("a"), policyDigest: d("7"), bundleDigest: d("8"), appBuildDigest: d("1"), environmentDigest: d("2"), runtimeManifestDigest: d("3"), modelRouteRevision: null, expectedCases: [exactIdentity], admittedAt: "2026-10-13T11:59:00.000Z", deadlineAt: "2026-10-13T12:05:00.000Z" });
  const round = E2ERoundSchema.parse({ schemaVersion: 1, roundId: binding.roundId, taskId: binding.taskId, operationId: binding.operationId, operationFence: binding.operationFence, workflowRevision: binding.workflowRevision, executionPlanDigest: binding.executionPlanDigest, admittedAt: binding.admittedAt, deadlineAt: binding.deadlineAt, limits: { runTimeoutMs: 600000, startupTimeoutMs: 60000, preparationTimeoutMs: 180000, caseTimeoutMs: 90000, maxActionsPerCase: 30, maxModelRequests: 60, maxInputTokens: 200000, maxOutputTokens: 20000, maxSpendUsd: null }, groupBindings: [binding] });
  const configDigest = d("a");
  const tuple: E2ESelectionTuple = { caseId: exactIdentity.caseId, compilerCaseIdentity: d("b"), registrationKey: "registration:v1", candidateResponseScope: "contained-candidate-process-response/v1", requestProtocol: "contained-candidate-host-request/v1", upstreamTestId: exactIdentity.upstreamTestId, upstreamResultId: d("e"), title: "fixture case", targetId: "web-1", targetName: "contract-api", agent: "default", disposition: "run" };
  const report = parseReport(Buffer.from(JSON.stringify({ schemaVersion: "report-1", run: { id: runId, specVersion: "0.1", runner: { name: "e2e", version: "0.20.0" }, status: "passed", exitCode: 0, startedAt: "2026-10-13T12:00:00.000Z", finishedAt: "2026-10-13T12:00:01.000Z", project: { id: "rovara-contract-p0", configDigest }, environment: { ci: false, trustNoticeShown: true, os: "darwin", arch: "arm64", runtime: "node" }, targets: [{ id: "contract-api", index: 0, platform: "contract-api", environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }], serialGroups: [], results: [{ id: tuple.upstreamResultId, testId: tuple.upstreamTestId, kind: "test", declarationIndex: 0, titlePath: [tuple.title], file: ".agentx/e2e/generated-contract.test.ts", source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, targetId: tuple.targetName, platform: tuple.targetName, agent: "default", repeat: 0, tags: [], selected: true, status: "passed", attempts: [{ id: runId, index: 0, status: "passed", startedAt: "2026-10-13T12:00:00.100Z", durationMs: 0.5, steps: [], artifacts: [], secondaryErrors: [], cleanup: "complete" }] }], errors: [], summary: { discovered: 1, selected: 1, executed: 1, passed: 1, failed: 0, interrupted: 0, flaky: 0, skipped: 0 }, limits: { maxAgentContextBytes: 1, maxLedgerBytes: 1, maxObservationBytes: 1, maxEventsPerStep: 1, maxModelTokensPerCall: 1 }, usage: { discoveredResults: 1, maxAgentContextBytes: 0, maxLedgerBytes: 0, maxObservationBytes: 0, artifactBytes: 0, downloads: 0, events: 0, modelTokens: 0, maxModelCallsInStep: 0, maxActionStepsInStep: 0 } } })));
  const requestBytes = Buffer.from('{"wireId":"0123456789abcdef0123456789abcdef0123456789abcdef","input":1}');
  const responseBytes = Buffer.from('{"wireId":"0123456789abcdef0123456789abcdef0123456789abcdef","output":true}');
  const observation = { caseId: exactIdentity.caseId, requestId: "request-1", requestBytes, responseBytes, observedAt: "2026-10-13T12:00:00.500Z", lifecycleId: "life-1", cleanup: "complete" as const, coverage: { observedScope: "mock-contract", subject: "candidate", executedCandidateParts: ["src"], realComponentIds: [], mockedComponentIds: ["api"], observedMockedComponentIds: ["api"], unexercisedBehaviors: [] } };
  const receipts = assertionDigests.map((assertionDigest, assertionIndex) => ({ runId: binding.runId, roundId: binding.roundId, groupId: binding.groupId, caseId: exactIdentity.caseId, upstreamRunId: runId, candidateDigest: binding.candidateDigest, sourceDigest: d("f"), bundleDigest: binding.bundleDigest, compilerCaseIdentity: tuple.compilerCaseIdentity, registrationKey: tuple.registrationKey, semanticApprovalDigest: d("9"), executionDescriptorDigest: exactIdentity.executionDescriptorDigest, accountIdDigest: d("6"), assertionIndex, assertionDigest, requestId: observation.requestId, requestSha256: digest(requestBytes), responseSha256: digest(responseBytes), observedAt: observation.observedAt, lifecycleId: observation.lifecycleId, cleanup: "complete" as const, outcome: "passed" as const }));
  const oracle: DeepMutable<E2ECollectionOracle> = { binding, round, selection: { schemaVersion: 1, algorithm: "e2e-public-list-selection/v1", planDigest: binding.executionPlanDigest, groupId: binding.groupId, tuples: [tuple] }, projectId: "rovara-contract-p0", configDigest, compiledConfigDigest: configDigest, runnerName: "e2e", runnerVersion: "0.20.0", fixedAssetDigests: { bootstrap: d("4") }, declaredMockComponentIds: ["api"], sourceDigest: d("f"), artifacts: [], usage: report.run.usage, limits: report.run.limits, environment: report.run.environment, targets: report.run.targets, cases: [{ caseId: exactIdentity.caseId, hostRequestId: "request-1", projectionVersion: null, compilerCaseIdentity: tuple.compilerCaseIdentity, registrationKey: tuple.registrationKey, semanticApprovalDigest: d("9"), accountIdDigest: d("6"), mockComponentIds: ["api"], declarationIndex: 0, sourceLine: 1, sourceColumn: 1, tags: [], expectedRequest: { protocol: "supervisor", expectedExportNames: null, input: 1 }, expectedCandidateInput: 1, assertions: assertionDigests.map((assertionDigest, index) => ({ index, digest: assertionDigest, expectedResponse: true })) }] };
  const collection: DeepMutable<E2ECollection> = { rawReportBytes: Buffer.from(JSON.stringify(report)), runStart: { runId, sequence: 1, launchId: "launch-1", capturedAt: report.run.startedAt }, process: { exitCode: 0, signal: null, startedAt: report.run.startedAt, finishedAt: report.run.finishedAt!, drained: true, aborted: false, timedOut: false }, configDigest, fixedAssetDigests: { bootstrap: d("4") }, publicList: { pairs: [{ id: tuple.upstreamResultId, file: ".agentx/e2e/generated-contract.test.ts", title: tuple.title, titlePath: [tuple.title], kind: "test", sessions: [], target: tuple.targetName, agent: "default", disposition: "run", source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, tags: [] }], unmatched: [] }, receivedAt: report.run.finishedAt!, observations: [observation], receipts };
  const filteredTuple = { ...tuple, upstreamTestId: "generated::filtered", upstreamResultId: d("2"), title: "filtered case", disposition: "filtered" as const };
  oracle.selection.tuples.push(filteredTuple);
  const filteredReason = "test declares platforms [fixture case]";
  report.run.results.push({ ...report.run.results[0]!, id: filteredTuple.upstreamResultId, testId: filteredTuple.upstreamTestId, titlePath: [filteredTuple.title], selected: false, status: "skipped", attempts: [], skip: { cause: "platform-unavailable", reason: filteredReason } });
  report.run.summary.discovered = 2;
  (collection.publicList as { pairs: Record<string, unknown>[] }).pairs.push({ id: filteredTuple.upstreamResultId, file: ".agentx/e2e/generated-contract.test.ts", title: filteredTuple.title, titlePath: [filteredTuple.title], kind: "test", sessions: [], target: filteredTuple.targetName, agent: "default", disposition: "filtered", reason: filteredReason, source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 }, tags: [] });
  collection.rawReportBytes = Buffer.from(JSON.stringify(report));
  return { oracle, collection, report, identity: exactIdentity, receipt: receipts[0]! };
}
function expandToCases(f: ReturnType<typeof fixture>, caseCount: number): void {
  const baseTuple = f.oracle.selection.tuples[0]!;
  const baseOracleCase = f.oracle.cases[0]!;
  const baseExpected = f.oracle.binding.expectedCases[0]!;
  const baseRow = structuredClone(f.report.run.results[0]!);
  const basePair = (f.collection.publicList as { pairs: Record<string, unknown>[] }).pairs[0]!;
  const baseObservation = f.collection.observations[0]!;
  const baseReceipts = [...f.collection.receipts];
  const addedRows: DeepMutable<E2EReport["run"]["results"][number]>[] = [];
  const addedPairs: Record<string, unknown>[] = [];
  for (let index = 1; index < caseCount; index += 1) {
    const scenarioId = `scenario-extra-${index}`;
    const criterionId = `criterion-extra-${index}`;
    const caseCore = { ...f.identity, caseId: "", upstreamTestId: "", scenarioId, criterionId };
    const caseId = e2eCaseIdFromIdentity(caseCore);
    const expected = { ...caseCore, caseId, upstreamTestId: "" };
    expected.upstreamTestId = e2eUpstreamTestIdFromIdentity(expected);
    const title = `fixture case ${index}`;
    const resultId = index.toString(16).padStart(64, "0");
    const tuple = { ...baseTuple, caseId, upstreamTestId: expected.upstreamTestId, upstreamResultId: resultId, title };
    f.oracle.selection.tuples.splice(1, 0, tuple);
    f.oracle.binding.expectedCases.push(expected);
    f.oracle.round.groupBindings[0]!.expectedCases.push(expected);
    f.oracle.cases.push({ ...baseOracleCase, caseId, declarationIndex: index, hostRequestId: `request-${index}` });
    const row = structuredClone(baseRow);
    row.id = resultId; row.testId = expected.upstreamTestId; row.titlePath = [title]; row.declarationIndex = index;
    addedRows.push(row);
    const pair = { ...basePair, id: resultId, title, titlePath: [title], source: { file: ".agentx/e2e/generated-contract.test.ts", line: 1, column: 1 } };
    addedPairs.push(pair);
    const wireId = index.toString(16).padStart(48, "0");
    const requestBytes = Buffer.from(JSON.stringify({ wireId, input: 1 }));
    const responseBytes = Buffer.from(JSON.stringify({ wireId, output: true }));
    f.collection.observations.push({ ...baseObservation, caseId, requestId: `request-${index}`, requestBytes, responseBytes });
    for (const receipt of baseReceipts.filter((item) => item.caseId === baseExpected.caseId)) {
      f.collection.receipts.push({ ...receipt, caseId, requestId: `request-${index}`, requestSha256: digest(requestBytes), responseSha256: digest(responseBytes) });
    }
  }
  f.report.run.results.splice(1, 0, ...addedRows);
  (f.collection.publicList as { pairs: Record<string, unknown>[] }).pairs.splice(1, 0, ...addedPairs);
  f.report.run.summary.discovered = caseCount + 1; f.report.run.summary.selected = caseCount; f.report.run.summary.executed = caseCount; f.report.run.summary.passed = caseCount; f.report.run.summary.skipped = 0;
  f.collection.rawReportBytes = Buffer.from(JSON.stringify(f.report));
}

describe("complete structural collection qualification", () => {
  it("accepts the exact 260 receipt packet from thirteen twenty-assertion cases", () => {
    const f = fixture();
    expandToCases(f, 13);
    expect(f.collection.receipts).toHaveLength(260);
    const result = qualifyE2ECollection(f.oracle, f.collection);
    expect(result.status, result.reason).toBe("PASS");
  });
  it("retains the complete admitted sixty-four-case twenty-receipt ceiling", () => {
    const f = fixture();
    expandToCases(f, 64);
    expect(f.collection.receipts).toHaveLength(1_280);
    expect(qualifyE2ECollection(f.oracle, f.collection).status).toBe("PASS");
  });
  it("projects validated actual module inventory rows while retaining the source object protocol", () => {
    expect(projectE2EModuleExportNames({ protocol: E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, exports: [{ name: "zeta", kind: "value" }, { name: "alpha", kind: "callable" }] })).toEqual(["alpha", "zeta"]);
    expect(() => projectE2EModuleExportNames({ protocol: "foreign/v1", exports: [{ name: "alpha", kind: "callable" }] })).toThrow();
    expect(() => projectE2EModuleExportNames({ protocol: E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, exports: [{ name: "alpha", kind: "callable" }, { name: "alpha", kind: "value" }] })).toThrow();
    expect(() => projectE2EModuleExportNames({ protocol: E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, exports: [{ name: "alpha", kind: "runtime-body" }] })).toThrow();
  });
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
    const counterfeitReport = parseReport(counterfeit.rawReportBytes);
    counterfeitReport.run.summary.skipped = 1;
    counterfeit.rawReportBytes = Buffer.from(JSON.stringify(counterfeitReport));
    expect(qualifyE2ECollection(f.oracle, counterfeit).status).toBe("UNKNOWN");
    const failed = structuredClone(f.collection);
    const failedReport = parseReport(failed.rawReportBytes);
    const row = failedReport.run.results[0]!;
    row.status = "failed"; row.attempts[0]!.status = "failed"; row.attempts[0]!.error = { category: "test", code: "ASSERTION_FAILED", message: "assertion mismatch", retryable: false };
    failedReport.run.status = "failed"; failedReport.run.exitCode = 1; failedReport.run.summary.passed = 0; failedReport.run.summary.failed = 1;
    failed.rawReportBytes = Buffer.from(JSON.stringify(failedReport));
    failed.process.exitCode = 1;
    failed.observations[0]!.responseBytes = Buffer.from("{\"wireId\":\"0123456789abcdef0123456789abcdef0123456789abcdef\",\"output\":false}");
    failed.receipts = failed.receipts.map((receipt) => ({ ...receipt, responseSha256: digest(failed.observations[0]!.responseBytes), outcome: "failed" }));
    const normalized = qualifyE2ECollection(f.oracle, failed);
    expect(normalized.status).toBe("FAILED");
    expect(normalized.result?.cases[0]?.status).toBe("failed");
    const retried = structuredClone(f.collection);
    const retryReport = parseReport(retried.rawReportBytes);
    const retryRow = retryReport.run.results[0]!;
    retryRow.status = "flaky";
    retryRow.attempts[0]!.status = "failed";
    retryRow.attempts[0]!.error = { category: "test", code: "FIRST_ATTEMPT_FAILED", message: "first attempt failed", retryable: true };
    retryRow.attempts.push({ ...retryRow.attempts[0]!, durationMs: retryRow.attempts[0]!.durationMs ?? 0, steps: retryRow.attempts[0]!.steps ?? [], artifacts: retryRow.attempts[0]!.artifacts ?? [], secondaryErrors: retryRow.attempts[0]!.secondaryErrors ?? [], cleanup: retryRow.attempts[0]!.cleanup ?? "complete", id: "018f47a2-9b3c-7abc-8def-1123456789ab", index: 1, status: "passed", startedAt: "2026-10-13T12:00:00.600Z", error: undefined });
    retryReport.run.status = "failed"; retryReport.run.exitCode = 1; retryReport.run.summary.executed = 1; retryReport.run.summary.passed = 0; retryReport.run.summary.flaky = 1;
    retried.rawReportBytes = Buffer.from(JSON.stringify(retryReport)); retried.process.exitCode = 1;
    const unstable = qualifyE2ECollection(f.oracle, retried);
    expect(unstable.status, unstable.reason).toBe("FAILED");
    expect(unstable.result?.cases[0]?.status).toBe("unstable");
  });

  it("blocks any global runner error even when an external assertion failure is otherwise valid", () => {
    const f = fixture();
    const report = parseReport(f.collection.rawReportBytes);
    const row = report.run.results[0]!;
    row.status = "failed";
    row.attempts[0]!.status = "failed";
    row.attempts[0]!.error = { category: "test", code: "ASSERTION_FAILED", message: "assertion mismatch", retryable: false };
    report.run.status = "failed";
    report.run.exitCode = 1;
    report.run.summary.passed = 0;
    report.run.summary.failed = 1;
    f.collection.process.exitCode = 1;
    f.collection.observations[0]!.responseBytes = Buffer.from(JSON.stringify({ wireId: "0123456789abcdef0123456789abcdef0123456789abcdef", output: false }));
    f.collection.receipts = f.collection.receipts.map((receipt) => ({ ...receipt, responseSha256: digest(f.collection.observations[0]!.responseBytes), outcome: "failed" }));
    report.run.errors.push({ category: "test", code: "ASSERTION_FAILED", message: "run-level assertion failure", retryable: false });
    f.collection.rawReportBytes = Buffer.from(JSON.stringify(report));
    const result = qualifyE2ECollection(f.oracle, f.collection);
    expect(result.status).toBe("UNKNOWN");
    expect(result.result).toBeNull();
  });

  it("bounds oracle constituents independently and rejects unsafe or oversized snapshots", () => {
    const ordinary = fixture();
    const accessor = structuredClone(ordinary.oracle);
    Object.defineProperty(accessor.cases[0]!, "expectedCandidateInput", { enumerable: true, get: () => 1 });
    expect(qualifyE2ECollection(accessor, ordinary.collection).status).toBe("UNKNOWN");
    const proxy = structuredClone(ordinary.oracle);
    proxy.cases[0] = new Proxy(proxy.cases[0]!, {});
    expect(qualifyE2ECollection(proxy, ordinary.collection).status).toBe("UNKNOWN");
    const wideRequest = structuredClone(ordinary.oracle);
    wideRequest.cases[0]!.expectedRequest = { body: "x".repeat(262_144) };
    expect(qualifyE2ECollection(wideRequest, ordinary.collection).status).toBe("UNKNOWN");
    const oversizedMetadata = structuredClone(ordinary.oracle);
    oversizedMetadata.cases[0]!.tags = ["x".repeat(9_000)];
    expect(qualifyE2ECollection(oversizedMetadata, ordinary.collection).status).toBe("UNKNOWN");
    const oversizedApprovedCase = structuredClone(ordinary.oracle);
    oversizedApprovedCase.cases[0]!.assertions.forEach((assertion) => { assertion.expectedResponse = "y".repeat(15_000); });
    expect(qualifyE2ECollection(oversizedApprovedCase, ordinary.collection).status).toBe("UNKNOWN");
  });
  it("rejects unmet scope, unsafe collection hooks, stale identity, and malformed bytes without throwing", () => {
    const f = fixture();
    const weaker = structuredClone(f.collection);
    (weaker.observations[0]!.coverage as { observedScope: string }).observedScope = "source";
    expect(qualifyE2ECollection(f.oracle, weaker).status).toBe("UNKNOWN");
    const forgedMockUse = structuredClone(f.collection);
    (forgedMockUse.observations[0]!.coverage as { observedMockedComponentIds: string[] }).observedMockedComponentIds = ["undeclared"];
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
    const mutateReport = (change: (report: DeepMutable<E2EReport>) => void) => {
      const collection = structuredClone(f.collection);
      const report = parseReport(collection.rawReportBytes);
      change(report);
      collection.rawReportBytes = Buffer.from(JSON.stringify(report));
      return collection;
    };
    expect(qualifyE2ECollection(f.oracle, mutateReport((report) => { report.run.runner.version = "9.9.9"; })).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, mutateReport((report) => { report.run.results[0]!.source.line += 1; })).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, mutateReport((report) => { report.run.results[0]!.attempts[0]!.error = { category: "test", code: "ASSERTION_FAILED", message: "contradicts passed row", retryable: false }; })).status).toBe("UNKNOWN");
    expect(qualifyE2ECollection(f.oracle, { ...f.collection, configDigest: d("1") }).status).toBe("UNKNOWN");
  });

  it("blocks internal run errors even when the process exits zero", () => {
    const f = fixture();
    const report = parseReport(f.collection.rawReportBytes);
    report.run.errors.push({ category: "internal", code: "INTERNAL", message: "runner error", retryable: false });
    f.collection.rawReportBytes = Buffer.from(JSON.stringify(report));
    expect(qualifyE2ECollection(f.oracle, f.collection).status).toBe("UNKNOWN");
  });

  it("accepts a maximum approved JSON literal inside a larger bounded app frame", () => {
    const f = fixture();
    const input = "x".repeat(65_534);
    const requestBytes = Buffer.from(JSON.stringify({ wireId: "0123456789abcdef0123456789abcdef0123456789abcdef", input }));
    expect(Buffer.byteLength(input)).toBe(65_534);
    expect(requestBytes.byteLength).toBeGreaterThan(65_536);
    expect(requestBytes.byteLength).toBeLessThanOrEqual(262_144);
    f.oracle.cases[0]!.expectedCandidateInput = input;
    f.collection.observations[0]!.requestBytes = requestBytes;
    f.collection.receipts = f.collection.receipts.map((receipt) => ({ ...receipt, requestSha256: digest(requestBytes) }));
    const result = qualifyE2ECollection(f.oracle, f.collection);
    expect(result.status, result.reason).toBe("PASS");
  });

  it("projects a compiled inspection inventory and rejects malformed inventory outputs", () => {
    const f = fixture();
    const expectedNames = ["alpha", "zeta"];
    const inventory = { protocol: E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, exports: [{ name: "zeta", kind: "value" }, { name: "alpha", kind: "callable" }] };
    const responseBytes = Buffer.from(JSON.stringify({ wireId: "0123456789abcdef0123456789abcdef0123456789abcdef", output: inventory }));
    f.oracle.cases[0]!.projectionVersion = "module-export-names/v1";
    f.oracle.cases[0]!.expectedCandidateInput = null;
    f.oracle.cases[0]!.assertions.forEach((assertion) => { assertion.expectedResponse = expectedNames; });
    f.collection.observations[0]!.requestBytes = Buffer.from(JSON.stringify({ wireId: "0123456789abcdef0123456789abcdef0123456789abcdef", input: null }));
    f.collection.observations[0]!.responseBytes = responseBytes;
    f.collection.receipts = f.collection.receipts.map((receipt) => ({ ...receipt, requestSha256: digest(f.collection.observations[0]!.requestBytes), responseSha256: digest(responseBytes) }));
    expect(qualifyE2ECollection(f.oracle, f.collection).status).toBe("PASS");
    for (const output of [null, { protocol: "foreign/v1", exports: [] }, { protocol: E2E_MODULE_EXPORT_INVENTORY_PROTOCOL, exports: [{ name: "alpha", kind: "callable" }, { name: "alpha", kind: "value" }] }]) {
      const mutant = structuredClone(f.collection);
      const malformed = Buffer.from(JSON.stringify({ wireId: "0123456789abcdef0123456789abcdef0123456789abcdef", output }));
      mutant.observations[0]!.responseBytes = malformed;
      mutant.receipts = mutant.receipts.map((receipt) => ({ ...receipt, responseSha256: digest(malformed) }));
      expect(qualifyE2ECollection(f.oracle, mutant).status).toBe("UNKNOWN");
    }
  });

  it("rejects attempt durations outside the admitted case window", () => {
    const f = fixture();
    const report = parseReport(f.collection.rawReportBytes);
    report.run.results[0]!.attempts[0]!.durationMs = 999999999;
    f.collection.rawReportBytes = Buffer.from(JSON.stringify(report));
    expect(qualifyE2ECollection(f.oracle, f.collection).status).toBe("UNKNOWN");
  });

  it("rejects retries outside the admitted run window", () => {
    const f = fixture();
    const report = parseReport(f.collection.rawReportBytes);
    const row = report.run.results[0]!; row.status = "flaky";
    row.attempts[0]!.status = "failed"; row.attempts[0]!.error = { category: "test", code: "FIRST", message: "first failed", retryable: true };
    row.attempts.push({ ...row.attempts[0]!, steps: row.attempts[0]!.steps ?? [], artifacts: row.attempts[0]!.artifacts ?? [], secondaryErrors: row.attempts[0]!.secondaryErrors ?? [], cleanup: row.attempts[0]!.cleanup ?? "complete", id: runId, index: 1, status: "passed", startedAt: "2099-01-01T00:00:00.000Z", durationMs: 1, error: undefined });
    report.run.status = "failed"; report.run.exitCode = 1; report.run.summary.passed = 0; report.run.summary.flaky = 1;
    f.collection.rawReportBytes = Buffer.from(JSON.stringify(report)); f.collection.process.exitCode = 1;
    expect(qualifyE2ECollection(f.oracle, f.collection).status).toBe("UNKNOWN");
  });
});
