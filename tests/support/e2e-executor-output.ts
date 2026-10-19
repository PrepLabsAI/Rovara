import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseE2EApplicationReport } from "../../packages/verifier/src/application-report-schema.js";
import type { OrdersExecutorFixture } from "./e2e-orders-executor-fixture.js";

/** Readers for what a finished executor run leaves in its out directory; shared by the local and the Linux runtime tests. */
export function readReport(outDir: string) {
  const parsed = parseE2EApplicationReport(readFileSync(join(outDir, "report.json")));
  if (parsed.kind !== "parsed") throw new Error(parsed.reason);
  return parsed.report;
}

/** One shard's own report, which exists even when the executor reports the run unavailable and writes no merged report. */
export function readShardReport(path: string) {
  const parsed = parseE2EApplicationReport(readFileSync(path));
  if (parsed.kind !== "parsed") throw new Error(parsed.reason);
  return parsed.report;
}

/** Scenario id to upstream status, joined through the compiled expected cases. */
export function caseStatuses(outDir: string, fixture: OrdersExecutorFixture): Record<string, string> {
  const report = readReport(outDir);
  return Object.fromEntries(report.run.results.map((result) => {
    const expected = fixture.compiled.expectedCases.find((item) => item.upstreamTestId === result.testId);
    return [expected?.scenarioId ?? result.testId, result.status];
  }));
}

type Observation = { caseId: string; kind: string; mediaType: string; encoding?: string; content?: string; file?: string };
export function observations(outDir: string): Observation[] {
  const dir = join(outDir, "observations");
  return readdirSync(dir).filter((name) => name.startsWith("ev-")).sort().map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as Observation);
}

/** The case capture frame is the executor's own record of each assertion's outcome. */
export function failedAssertionKinds(outDir: string, fixture: OrdersExecutorFixture): string[] {
  const scenario = fixture.compiled.bundle.scenarios[0]!;
  const captures = observations(outDir).filter((item) => item.kind === "case-capture")
    .map((item) => JSON.parse(item.content!) as { assertions: { index: number; outcome: string }[] });
  return captures.flatMap((capture) => capture.assertions.filter((item) => item.outcome === "failed").map((item) => scenario.assertions[item.index]!.kind));
}

export function csvRows(outDir: string): string[][] {
  const dir = join(outDir, "downloads");
  const files = readdirSync(dir).filter((name) => name.endsWith(".csv"));
  if (files.length !== 1) throw new Error(`expected exactly one downloaded CSV, found ${files.length}`);
  return readFileSync(join(dir, files[0]!), "utf8").split("\r\n").filter((line) => line.length > 0).map((line) => line.split(","));
}

export function blockedHosts(outDir: string): string[] {
  const value = JSON.parse(readFileSync(join(outDir, "blocked-requests.json"), "utf8")) as { blocked: { host: string }[] };
  return [...new Set(value.blocked.map((item) => item.host))];
}
export function resultOf(outDir: string): { exitCode: number; reason: string | null } {
  return JSON.parse(readFileSync(join(outDir, "executor-result.json"), "utf8")) as { exitCode: number; reason: string | null };
}

/** Every output file as text, for "nothing leaked" checks. */
export function allOutputText(outDir: string): string {
  return readdirSync(outDir, { withFileTypes: true, recursive: true }).filter((entry) => entry.isFile())
    .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1")).join("\n");
}
