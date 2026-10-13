import { createHash } from "node:crypto";
import { E2EReportSchema, type E2EReport } from "./report-schema.js";
import type { E2ESelectionPacket, E2ESelectionTuple } from "./selection.js";

export const E2E_REPORT_MAX_BYTES = 4 * 1024 * 1024;
export type ParsedE2EReport = { kind: "parsed"; report: E2EReport; rawSha256: string } | { kind: "unavailable"; reason: string };
export function parseE2EReport(bytes: Uint8Array): ParsedE2EReport {
  if (bytes.byteLength > E2E_REPORT_MAX_BYTES) return { kind: "unavailable", reason: "report exceeds 4 MiB limit" };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    const parsed = E2EReportSchema.safeParse(value);
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
function sameTuple(row: E2EReport["run"]["results"][number], tuple: E2ESelectionTuple): boolean {
  return row.testId === tuple.upstreamTestId && row.targetId === tuple.targetName && row.platform === tuple.targetName && row.agent === tuple.agent && row.repeat === 0 && row.file === ".agentx/e2e/generated-contract.test.ts" && row.kind === "test" && JSON.stringify(row.titlePath) === JSON.stringify([tuple.title]);
}
