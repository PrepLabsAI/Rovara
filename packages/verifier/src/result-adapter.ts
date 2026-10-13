import { createHash } from "node:crypto";
import { types } from "node:util";
import { copyBoundedE2EJsonData, copyBoundedE2ESourceBytes } from "@agentx/contracts";
import { canonicalJson, E2EQualifiedResultSchema, E2ERoundSchema, E2ERunBindingSchema, type E2EQualifiedResult, type E2ERunBinding, type E2ERound, type E2EScenario } from "@agentx/contracts";
import { E2EReportSchema, type E2EReport } from "./report-schema.js";
import type { E2ESelectionPacket, E2ESelectionTuple } from "./selection.js";
import { compareE2EPublicList } from "./selection.js";
import type { E2ECompiledSuite } from "./scenarios.js";
import { E2E_GENERATED_TEST_PATH, E2E_UPSTREAM_PACKAGE, E2E_UPSTREAM_VERSION } from "./identity.js";

export const E2E_REPORT_MAX_BYTES = 4 * 1024 * 1024;
export const E2E_APP_RPC_FRAME_MAX_BYTES = 262_144;
export const E2E_APP_LITERAL_MAX_BYTES = 65_536;
export const E2E_APP_LITERAL_MAX_DEPTH = 32;
export const E2E_COLLECTION_ORACLE_MAX_CARRIER_BYTES = 262_144 + 3 * 262_144 + 3 * 16_384 + 64 * (8_192 + 262_144 + 262_144 + 262_144 + 262_144 + 8_192);
export const E2E_MODULE_EXPORT_INVENTORY_PROTOCOL = "registered-module-export-inventory/v1" as const;
export const E2E_MODULE_EXPORT_PROJECTION_VERSION = "module-export-names/v1" as const;
export function projectE2EModuleExportNames(value: unknown): readonly string[] {
  const inventory = copyBoundedE2EJsonData(value, { maxBytes: E2E_APP_LITERAL_MAX_BYTES, maxDepth: E2E_APP_LITERAL_MAX_DEPTH });
  if (inventory === null || typeof inventory !== "object" || Array.isArray(inventory)) throw new TypeError("module export inventory must be an object");
  const record = inventory as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "exports,protocol" || record.protocol !== E2E_MODULE_EXPORT_INVENTORY_PROTOCOL || !Array.isArray(record.exports) || record.exports.length > 256) throw new TypeError("module export inventory protocol or rows are invalid");
  const names: string[] = [];
  for (const row of record.exports) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new TypeError("module export row is invalid");
    const item = row as Record<string, unknown>;
    if (Object.keys(item).sort().join(",") !== "kind,name" || typeof item.name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]{0,254}$/.test(item.name) || !["callable", "value", "type"].includes(String(item.kind))) throw new TypeError("module export name or kind is invalid");
    names.push(item.name);
  }
  if (new Set(names).size !== names.length) throw new TypeError("module export names must be unique");
  return names.sort();
}
export type ParsedE2EReport = { kind: "parsed"; report: E2EReport; rawSha256: string } | { kind: "unavailable"; reason: string };
export function parseE2EReport(input: Uint8Array): ParsedE2EReport {
  try {
    const bytes = copyBoundedE2ESourceBytes(input, E2E_REPORT_MAX_BYTES);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    const bounded = copyBoundedE2EJsonData(value, { maxBytes: E2E_REPORT_MAX_BYTES, maxDepth: 64, maxNodes: 65_536 });
    const parsed = E2EReportSchema.safeParse(bounded);
    if (!parsed.success) return { kind: "unavailable", reason: "report does not match pinned report-1 structure" };
    return { kind: "parsed", report: parsed.data, rawSha256: createHash("sha256").update(bytes).digest("hex") };
  } catch { return { kind: "unavailable", reason: "report is not valid bounded UTF-8 JSON" }; }
}

export type E2EReportExpectation = Readonly<{ upstreamRunId: string; projectId: string; configDigest: string; selection: E2ESelectionPacket; processExitCode: number | null }>;
export type E2EReportMapping = Readonly<{ status: "PASS" | "FAILED" | "UNKNOWN"; rawReportSha256: string | null; runId: string | null; cases: readonly { caseId: string; status: "passed" | "failed" | "unavailable"; attempts: number }[]; reason: string }>;
const unknown = (reason: string, parsed?: ParsedE2EReport): E2EReportMapping => ({ status: "UNKNOWN", rawReportSha256: parsed?.kind === "parsed" ? parsed.rawSha256 : null, runId: parsed?.kind === "parsed" ? parsed.report.run.id : null, cases: [], reason });

/** Structural mapping only; it cannot authenticate its caller or mint first-party assertion receipts. */
export function qualifyE2EReport(input: { parsed: ParsedE2EReport; expected: E2EReportExpectation | null; capture: unknown; receipts: readonly unknown[] }): E2EReportMapping {
  const { parsed, expected } = input;
  if (parsed.kind !== "parsed") return unknown(parsed.reason);
  if (!expected || input.capture === null || input.receipts.length === 0) return unknown("independent run binding, capture, and assertion receipts are required", parsed);
  const { report } = parsed;
  const tuples = expected.selection.tuples;
  const rows = report.run.results;
  if (report.run.id !== expected.upstreamRunId || report.run.project.id !== expected.projectId || report.run.project.configDigest !== expected.configDigest) return unknown("upstream run or fixed project/config identity mismatch", parsed);
  if (report.run.exitCode !== 0 || expected.processExitCode !== 0 || report.run.status !== "passed" || report.run.errors.length !== 0 || report.run.serialGroups.length !== 0) return unknown("runner exit, status, errors, or serial execution prevents qualification", parsed);
  if (rows.length !== tuples.length || report.run.summary.discovered !== tuples.length || report.run.summary.selected !== tuples.filter((item) => item.disposition === "run").length) return unknown("report does not contain the complete independently compiled tuple packet", parsed);
  const tupleById = new Map(tuples.map((tuple) => [tuple.upstreamResultId, tuple]));
  const seen = new Set<string>();
  const cases: { caseId: string; status: "passed" | "failed" | "unavailable"; attempts: number }[] = [];
  for (const row of rows) {
    const tuple = tupleById.get(row.id);
    if (!tuple || seen.has(row.id) || !sameTuple(row, tuple)) return unknown("report contains a missing, extra, duplicate, or altered tuple identity", parsed);
    seen.add(row.id);
    if (tuple.disposition === "filtered") {
      if (row.status !== "skipped" || row.attempts.length !== 0) return unknown("filtered tuple was executed or has no filtered disposition", parsed);
      continue;
    }
    const attempt = row.attempts[0];
    const pass = row.status === "passed" && row.selected === true && row.repeat === 0 && row.agent === "default" && row.attempts.length === 1 && attempt?.status === "passed" && attempt.cleanup === "complete" && attempt.steps.length === 0 && attempt.secondaryErrors.length === 0;
    cases.push({ caseId: tuple.caseId, status: pass ? "passed" : row.status === "failed" || row.status === "flaky" ? "failed" : "unavailable", attempts: row.attempts.length });
  }
  if (seen.size !== tuples.length || report.run.summary.executed !== cases.length || report.run.summary.passed !== cases.filter((item) => item.status === "passed").length || report.run.summary.failed !== cases.filter((item) => item.status === "failed").length || report.run.summary.flaky !== 0 || report.run.summary.interrupted !== 0 || report.run.summary.skipped !== tuples.filter((item) => item.disposition === "filtered").length) return unknown("report summary disagrees with the exact tuple and attempt rows", parsed);
  if (cases.some((item) => item.status !== "passed")) return { status: cases.some((item) => item.status === "failed") ? "FAILED" : "UNKNOWN", rawReportSha256: parsed.rawSha256, runId: report.run.id, cases, reason: "one or more selected tuples did not produce a clean first attempt" };
  // A syntactically complete report is still only eligible for the later native authentication and receipt gate.
  return { status: "UNKNOWN", rawReportSha256: parsed.rawSha256, runId: report.run.id, cases, reason: "report mapping is structural; native authentication and authoritative assertion receipts remain required" };
}

/** Explicit structural collection supplied by a later authenticated collector. This function never authenticates that producer. */
export type E2ECollectionOracle = Readonly<{
  binding: E2ERunBinding; round: E2ERound; selection: E2ESelectionPacket;
  projectId: string; configDigest: string; compiledConfigDigest: string; runnerName: string; runnerVersion: string;
  fixedAssetDigests: Readonly<Record<string, string>>;
  declaredMockComponentIds: readonly string[];
  sourceDigest: string; artifacts: readonly unknown[]; usage: Readonly<Record<string, number>>; limits: Readonly<Record<string, number>>; environment: Readonly<{ ci: boolean; trustNoticeShown: boolean; os: string; arch: string; runtime: string }>;
  targets: readonly unknown[];
  cases: readonly Readonly<{ caseId: string; hostRequestId: string; projectionVersion: typeof E2E_MODULE_EXPORT_PROJECTION_VERSION | null; compilerCaseIdentity: string; registrationKey: string; semanticApprovalDigest: string; accountIdDigest: string; declarationIndex: number; sourceLine: number; sourceColumn: number; tags: readonly string[]; expectedRequest: unknown; expectedCandidateInput: unknown; assertions: readonly Readonly<{ index: number; digest: string; expectedResponse: unknown }>[] }>[];
}>;
export type E2EObservedReceipt = Readonly<{
  runId: string; roundId: string; groupId: string; caseId: string; upstreamRunId: string;
  candidateDigest: string; sourceDigest: string; bundleDigest: string; compilerCaseIdentity: string;
  registrationKey: string; semanticApprovalDigest: string; executionDescriptorDigest: string;
  accountIdDigest: string; assertionIndex: number; assertionDigest: string; requestId: string;
  requestSha256: string; responseSha256: string; observedAt: string; lifecycleId: string;
  cleanup: "complete" | "failed"; outcome: "passed" | "failed";
}>;
export type E2ECaseObservation = Readonly<{ caseId: string; requestId: string; requestBytes: Uint8Array; responseBytes: Uint8Array; observedAt: string; lifecycleId: string; cleanup: "complete" | "failed"; coverage: unknown }>;
export type E2ECollection = Readonly<{
  rawReportBytes: Uint8Array; runStart: Readonly<{ runId: string; sequence: number; launchId: string; capturedAt: string }>;
  process: Readonly<{ exitCode: number | null; signal: string | null; startedAt: string; finishedAt: string; drained: boolean; aborted: boolean; timedOut: boolean }>;
  configDigest: string; fixedAssetDigests: Readonly<Record<string, string>>; publicList: unknown;
  receivedAt: string; observations: readonly E2ECaseObservation[]; receipts: readonly E2EObservedReceipt[];
}>;
export type E2EStructuralQualification = Readonly<{ status: "PASS" | "FAILED" | "UNKNOWN"; reason: string; runId: string | null; rawReportSha256: string | null; result: E2EQualifiedResult | null }>;

/** Derive the adapter oracle from the accepted compiler output and separate fixed capture expectations. */
export function createE2ECollectionOracleFromCompiledSuite(input: {
  compiled: E2ECompiledSuite; binding: E2ERunBinding; round: E2ERound; selection: E2ESelectionPacket;
  sourceDigest: string; launchConfigDigest: string; semanticApprovalDigests: ReadonlyMap<string, string>; hostRequestIds: ReadonlyMap<string, string>;
  declaredMockComponentIds: readonly string[];
  fixedAssetDigests: Readonly<Record<string, string>>;
  environment: E2ECollectionOracle["environment"]; usage: E2ECollectionOracle["usage"]; limits: E2ECollectionOracle["limits"];
}): E2ECollectionOracle {
  const generated = input.compiled.files.get(E2E_GENERATED_TEST_PATH);
  if (!generated || input.compiled.expectedCases.length !== input.binding.expectedCases.length || input.selection.groupId !== input.binding.groupId || input.selection.planDigest !== input.binding.executionPlanDigest) throw new Error("compiled suite, binding, and selection do not describe one exact group");
  const lines = generated.split("\n");
  if (input.compiled.hostRequestPayloads.size !== input.compiled.expectedCases.length || input.hostRequestIds.size !== input.compiled.expectedCases.length || new Set(input.hostRequestIds.values()).size !== input.hostRequestIds.size) throw new Error("compiled host payload or independently admitted request identity inventory is incomplete or ambiguous");
  const targetNames = [...new Set(input.selection.tuples.map((tuple) => tuple.targetName))];
  const targets = targetNames.map((name, index) => ({ id: name, index, platform: name, environment: "test", engine: { name: "none", version: "unversioned", spiVersion: 1 }, capabilities: [], artifactCapabilities: [], stateCapability: false }));
  const cases = input.compiled.expectedCases.map((expectedCase, declarationIndex) => {
    const caseBinding = input.compiled.caseBindings.get(expectedCase.caseId);
    const scenario = input.compiled.bundle.scenarios.find((item) => item.scenarioId === expectedCase.scenarioId) as E2EScenario | undefined;
    const semanticApprovalDigest = input.semanticApprovalDigests.get(expectedCase.scenarioId);
    const hostRequestId = input.hostRequestIds.get(expectedCase.caseId);
    const title = input.selection.tuples.find((tuple) => tuple.caseId === expectedCase.caseId)?.title;
    const sourceLine = lines.findIndex((line) => line.startsWith(`test(${JSON.stringify(title)},`)) + 1;
    if (!caseBinding || !scenario || !semanticApprovalDigest || !hostRequestId || !title || sourceLine < 1 || caseBinding.compilerCaseIdentity.length !== 64 || expectedCase.executionDescriptorDigest.length !== 64 || expectedCase.accountContextId.length === 0 || expectedCase.accountContextDigest.length !== 64) throw new Error("compiled case is missing its source, registration, semantic, or exact test declaration binding");
    const sourceInterface = scenario.steps[0]?.kind === "inspect-contract";
    const payload = input.compiled.hostRequestPayloads.get(expectedCase.caseId);
    if (payload === undefined || !generated.includes(JSON.stringify(payload))) throw new Error("compiled suite omitted its exact emitted supervisor payload");
    const assertions = scenario.assertions.map((assertion, index) => {
      let expectedResponse: unknown;
      if (assertion.kind === "state" && assertion.probeId === "result" || assertion.kind === "json" && assertion.responseId === "result") expectedResponse = assertion.equals;
      else if (assertion.kind === "state" && assertion.probeId === "module-export-names" && caseBinding.callableSelector === null) expectedResponse = assertion.equals;
      else throw new Error("compiled assertion uses an unsupported result adapter semantic");
      return { index, digest: expectedCase.assertionDigests[index]!, expectedResponse };
    });
    const accountIdDigest = createHash("sha256").update(canonicalJson({ accountProfileId: expectedCase.accountProfileId, accountContextId: expectedCase.accountContextId, accountContextDigest: expectedCase.accountContextDigest })).digest("hex");
    return { caseId: expectedCase.caseId, hostRequestId, projectionVersion: sourceInterface ? E2E_MODULE_EXPORT_PROJECTION_VERSION : null, compilerCaseIdentity: caseBinding.compilerCaseIdentity, registrationKey: caseBinding.registrationKey, semanticApprovalDigest, accountIdDigest, declarationIndex, sourceLine, sourceColumn: 1, tags: [], expectedRequest: payload, expectedCandidateInput: scenario.steps[0]?.kind === "invoke-contract" ? scenario.steps[0].input : null, assertions };
  });
  const targetSet = new Set(targetNames);
  if (input.selection.tuples.some((tuple) => !targetSet.has(tuple.targetName))) throw new Error("selection references a target absent from the compiled group");
  if (!/^[a-f0-9]{64}$/.test(input.launchConfigDigest)) throw new Error("fixed launch config projection must provide an independent digest");
  return { binding: input.binding, round: input.round, selection: input.selection, projectId: "rovara-contract-p0", configDigest: input.launchConfigDigest, compiledConfigDigest: input.compiled.expectedConfigDigest, runnerName: E2E_UPSTREAM_PACKAGE, runnerVersion: E2E_UPSTREAM_VERSION, fixedAssetDigests: input.fixedAssetDigests, declaredMockComponentIds: input.declaredMockComponentIds, sourceDigest: input.sourceDigest, artifacts: [], environment: input.environment, targets, usage: input.usage, limits: input.limits, cases };
}

/** Structural qualification only. `qualification: exploratory` intentionally cannot satisfy the trusted workflow admission gate. */
export function qualifyE2ECollection(oracleInput: E2ECollectionOracle, collectionInput: E2ECollection): E2EStructuralQualification {
  const unavailable = (reason: string, runId: string | null = null, rawReportSha256: string | null = null): E2EStructuralQualification => ({ status: "UNKNOWN", reason, runId, rawReportSha256, result: null });
  try {
    const oracle = snapshotE2ECollectionOracle(oracleInput);
    const raw = copyCollection(collectionInput);
    const binding = E2ERunBindingSchema.parse(oracle.binding);
    const round = E2ERoundSchema.parse(oracle.round);
    if (!/^[a-f0-9]{64}$/.test(oracle.sourceDigest) || !/^[a-f0-9]{64}$/.test(oracle.configDigest) || Object.keys(oracle.fixedAssetDigests).length === 0 || Object.values(oracle.fixedAssetDigests).some((digest) => !/^[a-f0-9]{64}$/.test(digest)) || new Set(oracle.declaredMockComponentIds).size !== oracle.declaredMockComponentIds.length) return unavailable("independent source, configuration, fixed asset, or mock manifest identity is invalid");
    const currentBinding = round.groupBindings.find((item) => item.runId === binding.runId);
    if (!currentBinding || canonicalJson(currentBinding) !== canonicalJson(binding) || round.roundId !== binding.roundId || round.executionPlanDigest !== binding.executionPlanDigest) return unavailable("binding is not an exact member of the current authoritative round");
    if (oracle.selection.groupId !== binding.groupId || oracle.selection.planDigest !== binding.executionPlanDigest || oracle.selection.tuples.length > 192) return unavailable("selection packet does not bind the current group");
    if (oracle.cases.length !== binding.expectedCases.length || new Set(oracle.cases.map((item) => item.caseId)).size !== oracle.cases.length || oracle.cases.some((item) => !binding.expectedCases.some((expected) => expected.caseId === item.caseId))) return unavailable("compiled oracle case inventory differs from the complete binding");
    const parsed = parseE2EReport(raw.rawReportBytes);
    if (parsed.kind !== "parsed") return unavailable(parsed.reason);
    const { report } = parsed;
    const runId = report.run.id;
    const now = Date.parse(raw.receivedAt);
    const started = Date.parse(raw.process.startedAt);
    const finished = Date.parse(raw.process.finishedAt);
    const reportStarted = Date.parse(report.run.startedAt);
    const reportFinished = Date.parse(report.run.finishedAt ?? "");
    const capturedAt = Date.parse(raw.runStart.capturedAt);
    if (!raw.runStart.runId || !Number.isSafeInteger(raw.runStart.sequence) || raw.runStart.sequence < 1 || !raw.runStart.launchId || raw.runStart.runId !== runId || report.run.id !== raw.runStart.runId) return unavailable("independent run-start capture does not bind the report UUID", runId, parsed.rawSha256);
    if (![now, started, finished, reportStarted, reportFinished, capturedAt].every(Number.isFinite) || finished < started || started < Date.parse(binding.admittedAt) || finished > Date.parse(binding.deadlineAt) || now < finished || now > Date.parse(round.deadlineAt) + 5000 || capturedAt < started - 1000 || capturedAt > reportStarted + 1000 || reportStarted < started || reportFinished < reportStarted || reportFinished > finished) return unavailable("collection timing is outside the admitted round window", runId, parsed.rawSha256);
    if (report.run.runner.name !== oracle.runnerName || report.run.runner.version !== oracle.runnerVersion || report.run.project.id !== oracle.projectId || report.run.project.configDigest !== oracle.configDigest || raw.configDigest !== oracle.configDigest || canonicalJson(raw.fixedAssetDigests) !== canonicalJson(oracle.fixedAssetDigests) || canonicalJson(report.run.environment) !== canonicalJson(oracle.environment) || canonicalJson(report.run.targets) !== canonicalJson(oracle.targets) || canonicalJson(report.run.usage) !== canonicalJson(oracle.usage) || canonicalJson(report.run.limits) !== canonicalJson(oracle.limits) || report.run.serialGroups.length !== 0) return unavailable("pinned runner, project, configuration, environment, target, or fixed asset identity mismatch", runId, parsed.rawSha256);
    if (binding.modelRouteRevision === null && (report.run.usage.modelTokens !== 0 || report.run.usage.maxModelCallsInStep !== 0 || report.run.usage.maxActionStepsInStep !== 0)) return unavailable("model usage was observed although the admitted route is null", runId, parsed.rawSha256);
    if (raw.process.signal !== null || typeof raw.process.aborted !== "boolean" || typeof raw.process.timedOut !== "boolean" || typeof raw.process.drained !== "boolean" || raw.process.aborted || raw.process.timedOut || !raw.process.drained || !Number.isInteger(raw.process.exitCode)) return unavailable("process was interrupted, timed out, aborted, or not fully drained", runId, parsed.rawSha256);
    const { selected, filtered } = compareE2EPublicList(oracle.selection, raw.publicList);
    const tuples = oracle.selection.tuples;
    const rows = report.run.results;
    if (rows.length !== tuples.length || report.run.summary.discovered !== rows.length || report.run.summary.selected !== selected.length) return unavailable(`report rows do not cover exact packet (rows=${rows.length}, tuples=${tuples.length}, discovered=${report.run.summary.discovered}, selected=${report.run.summary.selected}, selectedPacket=${selected.length})`, runId, parsed.rawSha256);
    const byId = new Map(tuples.map((tuple) => [tuple.upstreamResultId, tuple]));
    const seen = new Set<string>();
    const selectedRows: { tuple: E2ESelectionTuple; row: E2EReport["run"]["results"][number] }[] = [];
    for (const row of rows) {
      const tuple = byId.get(row.id);
      if (!tuple || seen.has(row.id) || !sameTuple(row, tuple)) return unavailable("report has an extra, duplicate, or identity-mutated physical row", runId, parsed.rawSha256);
      seen.add(row.id);
      const rowOracle = oracle.cases.find((item) => item.caseId === tuple.caseId);
      if (!rowOracle || row.declarationIndex !== rowOracle.declarationIndex || row.source.file !== ".agentx/e2e/generated-contract.test.ts" || row.file !== row.source.file || row.source.line !== rowOracle.sourceLine || row.source.column !== rowOracle.sourceColumn || canonicalJson(row.tags ?? []) !== canonicalJson(rowOracle.tags)) return unavailable("report declaration, source location, or tag identity differs from compiled output", runId, parsed.rawSha256);
      const listPair = (raw.publicList as { pairs: Array<{ id: string; source?: unknown; tags?: unknown }> }).pairs.find((pair) => pair.id === tuple.upstreamResultId);
      if (!listPair || canonicalJson(listPair.source) !== canonicalJson({ file: ".agentx/e2e/generated-contract.test.ts", line: rowOracle.sourceLine, column: rowOracle.sourceColumn }) || canonicalJson(listPair.tags ?? []) !== canonicalJson(rowOracle.tags)) return unavailable("public-list source location or tags differ from compiled output", runId, parsed.rawSha256);
      if (tuple.disposition === "filtered") {
        const skip = row.skip as { cause?: unknown; reason?: unknown } | undefined;
        const expectedReason = typeof (raw.publicList as { pairs?: unknown[] }).pairs?.find((pair) => (pair as { id?: unknown }).id === tuple.upstreamResultId) === "object" ? ((raw.publicList as { pairs: Array<{ id: string; reason?: string }> }).pairs.find((pair) => pair.id === tuple.upstreamResultId)?.reason) : undefined;
        if (row.selected !== false || row.status !== "skipped" || row.attempts.length !== 0 || skip?.cause !== "platform-unavailable" || typeof skip.reason !== "string" || skip.reason.length === 0 || expectedReason !== undefined && skip.reason !== expectedReason) return unavailable("filtered row was selected, executed, or has an unexpected reason", runId, parsed.rawSha256);
      } else selectedRows.push({ tuple, row });
    }
    if (seen.size !== tuples.length) return unavailable("report omitted a compiled physical row", runId, parsed.rawSha256);
    if (report.run.summary.executed !== selectedRows.filter(({ row }) => row.attempts.length > 0).length || report.run.summary.passed !== selectedRows.filter(({ row }) => row.status === "passed").length || report.run.summary.failed !== selectedRows.filter(({ row }) => row.status === "failed" || row.status === "timed-out").length || report.run.summary.interrupted !== selectedRows.filter(({ row }) => row.status === "interrupted").length || report.run.summary.flaky !== selectedRows.filter(({ row }) => row.status === "flaky").length || report.run.summary.skipped !== selectedRows.filter(({ row }) => row.status === "skipped").length) return unavailable("runner summary contradicts selected-row counts", runId, parsed.rawSha256);
    const observedTestFailure = raw.process.exitCode !== 0 && report.run.status === "failed" && report.run.exitCode === raw.process.exitCode && report.run.errors.every((error) => error.category === "test");
    if (report.run.errors.length !== 0 || report.run.exitCode !== raw.process.exitCode || (raw.process.exitCode === 0 ? report.run.status !== "passed" : !observedTestFailure)) return unavailable("report and actual process outcomes contradict or contain a run-level error", runId, parsed.rawSha256);
    const normalizedCases: E2EQualifiedResult["cases"] = [];
    if (raw.observations.length !== selectedRows.length || raw.receipts.length !== selectedRows.reduce((total, { tuple }) => total + (oracle.cases.find((item) => item.caseId === tuple.caseId)?.assertions.length ?? 0), 0)) return unavailable("observations or assertion receipts contain missing, duplicate, or foreign rows", runId, parsed.rawSha256);
    for (const { tuple, row } of selectedRows) {
      const expectation = oracle.cases.find((item) => item.caseId === tuple.caseId);
      const observation = raw.observations.find((item) => item.caseId === tuple.caseId);
      const expectedCase = binding.expectedCases.find((item) => item.caseId === tuple.caseId);
      const attemptsForRow = row.attempts;
      if (!expectation || !observation || raw.observations.filter((item) => item.caseId === tuple.caseId).length !== 1 || !expectedCase || expectedCase.upstreamTestId !== tuple.upstreamTestId || attemptsForRow.length < 1 || attemptsForRow.length > 2 || attemptsForRow.some((attempt, index) => { const attemptStart = Date.parse(attempt.startedAt); const attemptEnd = attemptStart + attempt.durationMs; return attempt.index !== index || attempt.durationMs < 0 || !Number.isFinite(attempt.durationMs) || attempt.durationMs > round.limits.caseTimeoutMs || !Number.isFinite(attemptStart) || !Number.isFinite(attemptEnd) || attemptStart < started || attemptStart > finished || attemptEnd > finished || attemptEnd > Date.parse(binding.deadlineAt) || attempt.steps.length !== 0 || canonicalJson(attempt.artifacts) !== canonicalJson(oracle.artifacts); }) || attemptsForRow.length > 1 && row.status !== "flaky" || row.status === "passed" && (attemptsForRow.length !== 1 || attemptsForRow[0]?.status !== "passed" || attemptsForRow[0]?.error !== undefined || attemptsForRow[0]?.secondaryErrors.length !== 0) || row.status === "failed" && (attemptsForRow.at(-1)?.status !== "failed" || attemptsForRow.at(-1)?.error?.category !== "test") || row.status === "timed-out" && attemptsForRow.at(-1)?.status !== "timed-out" || row.status === "flaky" && (attemptsForRow.length < 2 || attemptsForRow.at(-1)?.status !== "passed" || attemptsForRow.slice(0, -1).some((attempt) => attempt.status !== "failed" || attempt.error?.category !== "test")) || row.selected !== true || row.kind !== "test" || row.skip !== undefined) return unavailable("selected case lacks exact compiled expectation, observation, or bounded attempt history", runId, parsed.rawSha256);
      const request = copyBoundedE2ESourceBytes(observation.requestBytes, E2E_APP_RPC_FRAME_MAX_BYTES);
      const response = copyBoundedE2ESourceBytes(observation.responseBytes, E2E_APP_RPC_FRAME_MAX_BYTES);
      const requestSha256 = createHash("sha256").update(request).digest("hex");
      const responseSha256 = createHash("sha256").update(response).digest("hex");
      const receipts = raw.receipts.filter((receipt) => receipt.caseId === tuple.caseId);
      if (expectation.assertions.length !== receipts.length || receipts.length !== expectedCase.assertionDigests.length) return unavailable("case does not have exactly one receipt for every approved assertion", runId, parsed.rawSha256);
      const sortedReceipts = [...receipts].sort((a, b) => a.assertionIndex - b.assertionIndex);
      const observationTime = Date.parse(observation.observedAt);
      const attemptStartedAt = Date.parse(attemptsForRow[0]!.startedAt);
      if (!Number.isFinite(observationTime) || !Number.isFinite(attemptStartedAt) || observationTime < attemptStartedAt || observationTime > attemptStartedAt + round.limits.caseTimeoutMs || observationTime < started || observationTime > finished || observation.cleanup !== "complete" || observation.lifecycleId.length === 0) return unavailable("case observation window or owned lifecycle is incomplete", runId, parsed.rawSha256);
      let requestData: unknown;
      let responseData: unknown;
      try {
        requestData = copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request)), { maxBytes: 262_144, maxDepth: 64 });
        responseData = copyBoundedE2EJsonData(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response)), { maxBytes: 262_144, maxDepth: 64 });
      } catch { return unavailable("actual request or response bytes are not bounded UTF-8 JSON", runId, parsed.rawSha256); }
      if (requestData === null || typeof requestData !== "object" || Array.isArray(requestData) || Object.keys(requestData).sort().join(",") !== "input,wireId" || typeof (requestData as Record<string, unknown>).wireId !== "string" || !/^[a-f0-9]{48}$/.test((requestData as Record<string, unknown>).wireId as string) || observation.requestId !== expectation.hostRequestId) return unavailable("actual app request frame has no fresh wire identity", runId, parsed.rawSha256);
      let appInput: unknown;
      try { appInput = copyBoundedE2EJsonData((requestData as Record<string, unknown>).input, { maxBytes: E2E_APP_LITERAL_MAX_BYTES, maxDepth: E2E_APP_LITERAL_MAX_DEPTH }); }
      catch { return unavailable("actual app input literal exceeds its independent JSON limit", runId, parsed.rawSha256); }
      if (canonicalJson(appInput) !== canonicalJson(expectation.expectedCandidateInput)) return unavailable("actual app request input differs from the independently approved scenario literal", runId, parsed.rawSha256);
      const assertionOutcomes: ("passed" | "failed")[] = [];
      for (let index = 0; index < sortedReceipts.length; index += 1) {
        const receipt = sortedReceipts[index]!;
        const assertion = expectation.assertions[index]!;
        if (responseData === null || typeof responseData !== "object" || Array.isArray(responseData) || Object.keys(responseData).sort().join(",") !== "output,wireId" || (responseData as Record<string, unknown>).wireId !== (requestData as Record<string, unknown>).wireId) return unavailable("actual response does not bind its actual app wire identifier", runId, parsed.rawSha256);
        let payload: unknown;
        try { payload = copyBoundedE2EJsonData((responseData as Record<string, unknown>).output, { maxBytes: E2E_APP_LITERAL_MAX_BYTES, maxDepth: E2E_APP_LITERAL_MAX_DEPTH }); }
        catch { return unavailable("actual app output literal exceeds its independent JSON limit", runId, parsed.rawSha256); }
        let projectedPayload = payload;
        if (expectation.projectionVersion === E2E_MODULE_EXPORT_PROJECTION_VERSION && Array.isArray(assertion.expectedResponse)) {
          try { projectedPayload = projectE2EModuleExportNames(payload); }
          catch { return unavailable("registered module export inventory failed its fixed projection schema", runId, parsed.rawSha256); }
        }
        const assertionOutcome = canonicalJson(projectedPayload) === canonicalJson(assertion.expectedResponse) ? "passed" : "failed";
        if (receipt.assertionIndex !== index || assertion.index !== index || receipt.assertionDigest !== assertion.digest || receipt.assertionDigest !== expectedCase.assertionDigests[index] || receipt.runId !== binding.runId || receipt.roundId !== binding.roundId || receipt.groupId !== binding.groupId || receipt.upstreamRunId !== runId || receipt.candidateDigest !== binding.candidateDigest || receipt.sourceDigest !== oracle.sourceDigest || receipt.bundleDigest !== binding.bundleDigest || receipt.compilerCaseIdentity !== expectation.compilerCaseIdentity || receipt.registrationKey !== expectation.registrationKey || receipt.semanticApprovalDigest !== expectation.semanticApprovalDigest || receipt.executionDescriptorDigest !== expectedCase.executionDescriptorDigest || receipt.accountIdDigest !== expectation.accountIdDigest || receipt.requestId !== observation.requestId || receipt.requestSha256 !== requestSha256 || receipt.responseSha256 !== responseSha256 || receipt.observedAt !== observation.observedAt || receipt.lifecycleId !== observation.lifecycleId || receipt.cleanup !== observation.cleanup || receipt.outcome !== assertionOutcome || row.status === "passed" && assertionOutcome !== "passed") return unavailable("assertion receipt identity, ordering, actual byte hash, window, or lifecycle mismatch", runId, parsed.rawSha256);
        assertionOutcomes.push(assertionOutcome);
      }
      const assertionFailed = assertionOutcomes.includes("failed");
      const clean = row.status === "passed" && attemptsForRow.length === 1 && attemptsForRow[0]?.status === "passed" && attemptsForRow[0]?.error === undefined && attemptsForRow[0]?.secondaryErrors.length === 0 && attemptsForRow[0]?.cleanup === "complete" && observation.cleanup === "complete" && !assertionFailed;
      const caseFailed = row.status === "failed" || row.status === "timed-out" || row.status === "flaky" || assertionFailed;
      const status = clean ? "passed" : row.status === "flaky" || attemptsForRow.length > 1 ? "unstable" : caseFailed ? "failed" : "unavailable";
      const coverage = copyBoundedE2EJsonData(observation.coverage, { maxBytes: 65_536, maxDepth: 32 });
      const normalizedCoverage = coverage as E2EQualifiedResult["cases"][number]["coverage"];
      if (canonicalJson(normalizedCoverage.mockedComponentIds) !== canonicalJson([...oracle.declaredMockComponentIds].sort()) || normalizedCoverage.observedMockedComponentIds.some((componentId) => !oracle.declaredMockComponentIds.includes(componentId))) return unavailable("declared and observed mock coverage differs from the immutable group manifest");
      const evidenceRank = { source: 0, "mock-contract": 1, runtime: 2, "external-live": 3 } as const;
      const scopeMet = normalizedCoverage.subject === "candidate" && evidenceRank[normalizedCoverage.observedScope] >= evidenceRank[expectedCase.minimumEvidence] && expectedCase.requiredRealComponentIds.every((componentId) => normalizedCoverage.realComponentIds.includes(componentId)) && normalizedCoverage.unexercisedBehaviors.length === 0;
      const qualifiedStatus = clean && !scopeMet ? "unavailable" : status;
      normalizedCases.push({ caseId: expectedCase.caseId, executionDescriptorDigest: expectedCase.executionDescriptorDigest, accountContextId: expectedCase.accountContextId, accountContextDigest: expectedCase.accountContextDigest, status: qualifiedStatus, reason: clean ? scopeMet ? "assertions-passed" : "evidence-floor-unmet" : "observed-case-failure", attemptCount: attemptsForRow.length, assertionDigest: expectedCase.assertionDigest, assertionReceipts: expectedCase.assertionDigests.map((assertionDigest, assertionIndex) => ({ assertionIndex, assertionDigest, status: clean ? qualifiedStatus : assertionOutcomes[assertionIndex] === "failed" ? "failed" : status, reason: clean ? scopeMet ? "assertion-receipt-complete" : "evidence-floor-unmet" : assertionOutcomes[assertionIndex] === "failed" ? "assertion-failed" : "assertion-observed" })), artifacts: [], coverage: normalizedCoverage });
    }
    const anyFailure = normalizedCases.some((item) => item.status === "failed" || item.status === "unstable") || raw.process.exitCode !== 0;
    const allPassed = normalizedCases.length === binding.expectedCases.length && normalizedCases.every((item) => item.status === "passed");
    const overallStatus = anyFailure ? "failed" : allPassed ? "passed" : "unavailable";
    const result = E2EQualifiedResultSchema.parse({ schemaVersion: 1, binding, producer: "structural-e2e-report-adapter", startedAt: raw.process.startedAt, finishedAt: raw.process.finishedAt, receivedAt: raw.receivedAt, status: overallStatus, qualification: "exploratory", executionMode: binding.executionMode, reason: anyFailure ? "observed-test-failure" : allPassed ? "structural-observations-complete" : "evidence-floor-unmet", cases: normalizedCases, rawReportSha256: parsed.rawSha256, modelReceiptIds: [], cleanup: "confirmed" });
    if (filtered.length + selected.length !== tuples.length) return unavailable("selection packet cardinality changed", runId, parsed.rawSha256);
    return { status: anyFailure ? "FAILED" : allPassed ? "PASS" : "UNKNOWN", reason: anyFailure ? "selected case failure preserved" : allPassed ? "complete structural scoped qualification; producer authentication remains external" : "observations do not satisfy every independent evidence floor", runId, rawReportSha256: parsed.rawSha256, result };
  } catch (error) { const detail = error instanceof Error ? error.message.slice(0, 240) : "invalid data"; return unavailable(`collection or independent oracle is malformed, unsafe, or outside structural bounds: ${detail}`); }
}

/** Safely snapshot each admitted oracle constituent under its own protocol budget. */
function snapshotE2ECollectionOracle(input: E2ECollectionOracle): E2ECollectionOracle {
  const commonKeys = ["projectId", "configDigest", "compiledConfigDigest", "runnerName", "runnerVersion", "sourceDigest", "artifacts", "usage", "limits", "environment"] as const;
  const otherKeys = ["binding", "round", "selection", "fixedAssetDigests", "declaredMockComponentIds", "targets"] as const;
  const caseKeys = ["caseId", "hostRequestId", "projectionVersion", "compilerCaseIdentity", "registrationKey", "semanticApprovalDigest", "accountIdDigest", "declarationIndex", "sourceLine", "sourceColumn", "tags", "expectedRequest", "expectedCandidateInput", "assertions"] as const;
  const top = ownRecord(input, [...commonKeys, ...otherKeys, "cases"]);
  requireExactKeys(top, [...commonKeys, ...otherKeys, "cases"]);
  const commonInput: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of commonKeys) commonInput[key] = top[key];
  const common = copyBoundedE2EJsonData(commonInput, { maxBytes: 262_144, maxDepth: 64 }) as Omit<E2ECollectionOracle, "cases">;
  const binding = copyBoundedE2EJsonData(top.binding, { maxBytes: 262_144, maxDepth: 64 }) as E2ERunBinding;
  const round = copyBoundedE2EJsonData(top.round, { maxBytes: 262_144, maxDepth: 64 }) as E2ERound;
  const selection = copyBoundedE2EJsonData(top.selection, { maxBytes: 262_144, maxDepth: 64 }) as E2ESelectionPacket;
  const fixedAssetDigests = copyBoundedE2EJsonData(top.fixedAssetDigests, { maxBytes: 16_384, maxDepth: 16 }) as Readonly<Record<string, string>>;
  const declaredMockComponentIds = copyBoundedE2EJsonData(top.declaredMockComponentIds, { maxBytes: 16_384, maxDepth: 8 }) as readonly string[];
  const targets = copyBoundedE2EJsonData(ownArray(top.targets, 3), { maxBytes: 16_384, maxDepth: 16 }) as readonly unknown[];
  const commonBytes = Buffer.byteLength(canonicalJson(common), "utf8");
  let carrierBytes = commonBytes + Buffer.byteLength(canonicalJson(binding), "utf8") + Buffer.byteLength(canonicalJson(round), "utf8") + Buffer.byteLength(canonicalJson(selection), "utf8") + Buffer.byteLength(canonicalJson(fixedAssetDigests), "utf8") + Buffer.byteLength(canonicalJson(declaredMockComponentIds), "utf8") + Buffer.byteLength(canonicalJson(targets), "utf8") + 8_192;
  const rows = ownArray(top.cases, 64);
  const cases = rows.map((value) => {
    const row = ownRecord(value, caseKeys);
    requireExactKeys(row, caseKeys);
    const metadataInput: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of caseKeys) if (key !== "expectedRequest" && key !== "expectedCandidateInput" && key !== "assertions") metadataInput[key] = row[key];
    const metadata = copyBoundedE2EJsonData(metadataInput, { maxBytes: 8_192, maxDepth: 64 });
    const expectedRequest = copyBoundedE2EJsonData(row.expectedRequest, { maxBytes: E2E_APP_RPC_FRAME_MAX_BYTES, maxDepth: 64 });
    const expectedCandidateInput = copyBoundedE2EJsonData(row.expectedCandidateInput, { maxBytes: E2E_APP_LITERAL_MAX_BYTES, maxDepth: E2E_APP_LITERAL_MAX_DEPTH });
    const rawAssertions = ownArray(row.assertions, 20);
    const assertions = rawAssertions.map((rawAssertion) => {
      const assertion = ownRecord(rawAssertion, ["index", "digest", "expectedResponse"]);
      requireExactKeys(assertion, ["index", "digest", "expectedResponse"]);
      const metadata = copyBoundedE2EJsonData({ index: assertion.index, digest: assertion.digest }, { maxBytes: 2_048, maxDepth: 8 });
      const expectedResponse = copyBoundedE2EJsonData(assertion.expectedResponse, { maxBytes: E2E_APP_LITERAL_MAX_BYTES, maxDepth: E2E_APP_LITERAL_MAX_DEPTH });
      return { ...(metadata as { index: number; digest: string }), expectedResponse };
    });
    const boundedAssertions = copyBoundedE2EJsonData(assertions, { maxBytes: 262_144, maxDepth: 64 }) as typeof assertions;
    const approvedCaseData = copyBoundedE2EJsonData({ input: expectedCandidateInput, assertions: boundedAssertions.map((assertion) => assertion.expectedResponse) }, { maxBytes: 262_144, maxDepth: 64 });
    const metadataBytes = Buffer.byteLength(canonicalJson(metadata), "utf8");
    const requestBytes = Buffer.byteLength(canonicalJson(expectedRequest), "utf8");
    const approvedBytes = Buffer.byteLength(canonicalJson(approvedCaseData), "utf8");
    const assertionBytes = Buffer.byteLength(canonicalJson(boundedAssertions), "utf8");
    carrierBytes += metadataBytes + requestBytes + approvedBytes + assertionBytes + 8_192;
    return { ...(metadata as Omit<E2ECollectionOracle["cases"][number], "expectedRequest" | "expectedCandidateInput" | "assertions">), expectedRequest, expectedCandidateInput, assertions: boundedAssertions };
  });
  if (carrierBytes > E2E_COLLECTION_ORACLE_MAX_CARRIER_BYTES) throw new TypeError("independent oracle constituents exceed the derived structural carrier limit");
  return { ...common, binding, round, selection, fixedAssetDigests, declaredMockComponentIds, targets, cases };
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw new TypeError("bounded record is missing or contains unexpected fields");
}

function copyCollection(input: E2ECollection): E2ECollection {
  const top = ownRecord(input, ["rawReportBytes", "runStart", "process", "configDigest", "fixedAssetDigests", "publicList", "receivedAt", "observations", "receipts"]);
  const rawReportBytes = copyBoundedE2ESourceBytes(top.rawReportBytes, E2E_REPORT_MAX_BYTES);
  const json = (value: unknown, maxBytes = 262_144) => copyBoundedE2EJsonData(value, { maxBytes, maxDepth: 64 });
  const receiptKeys = ["runId", "roundId", "groupId", "caseId", "upstreamRunId", "candidateDigest", "sourceDigest", "bundleDigest", "compilerCaseIdentity", "registrationKey", "semanticApprovalDigest", "executionDescriptorDigest", "accountIdDigest", "assertionIndex", "assertionDigest", "requestId", "requestSha256", "responseSha256", "observedAt", "lifecycleId", "cleanup", "outcome"];
  const receiptRows = ownArray(top.receipts, 1280).map((item) => json(ownRecord(item, receiptKeys), 8192) as E2EObservedReceipt);
  const observationRows = ownArray(top.observations, 64).map((value) => {
    const item = ownRecord(value, ["caseId", "requestId", "requestBytes", "responseBytes", "observedAt", "lifecycleId", "cleanup", "coverage"]);
    return { metadata: json({ caseId: item.caseId, requestId: item.requestId, observedAt: item.observedAt, lifecycleId: item.lifecycleId, cleanup: item.cleanup, coverage: item.coverage }, 65_536) as Omit<E2ECaseObservation, "requestBytes" | "responseBytes">, requestBytes: copyBoundedE2ESourceBytes(item.requestBytes, E2E_APP_RPC_FRAME_MAX_BYTES), responseBytes: copyBoundedE2ESourceBytes(item.responseBytes, E2E_APP_RPC_FRAME_MAX_BYTES) };
  });
  const runStart = json(ownRecord(top.runStart, ["runId", "sequence", "launchId", "capturedAt"]), 4096) as E2ECollection["runStart"];
  const process = json(ownRecord(top.process, ["exitCode", "signal", "startedAt", "finishedAt", "drained", "aborted", "timedOut"]), 8192) as E2ECollection["process"];
  return { rawReportBytes, runStart, process, configDigest: json(top.configDigest, 128) as string, fixedAssetDigests: json(top.fixedAssetDigests, 16_384) as Readonly<Record<string, string>>, publicList: json(top.publicList, 262_144), receivedAt: json(top.receivedAt, 128) as string, receipts: receiptRows, observations: observationRows.map(({ metadata, requestBytes, responseBytes }) => ({ ...metadata, requestBytes, responseBytes })) };
}
function ownRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("collection field must be an ordinary data record");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !keys.includes(key))) throw new TypeError("collection record contains unknown fields");
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors) as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("collection record must contain only own enumerable data values");
    result[key] = descriptor.value;
  }
  return result;
}
function ownArray(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) throw new TypeError("collection array is invalid or exceeds its bound");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || key !== "length" && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) throw new TypeError("collection array has extra properties");
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) throw new TypeError("collection array must be dense own data");
    return descriptor.value as unknown;
  });
}
function sameTuple(row: E2EReport["run"]["results"][number], tuple: E2ESelectionTuple): boolean {
  return row.testId === tuple.upstreamTestId && row.targetId === tuple.targetName && row.platform === tuple.targetName && row.agent === tuple.agent && row.repeat === 0 && row.file === ".agentx/e2e/generated-contract.test.ts" && row.kind === "test" && JSON.stringify(row.titlePath) === JSON.stringify([tuple.title]);
}
