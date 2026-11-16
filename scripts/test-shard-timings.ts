// Writes tests/.timings/vitest-durations.json, the run time of each test file that CI uses to balance its test shards
// (tests/support/duration-shards.ts). Run the whole suite once with vitest's JSON reporter, then turn the report into the file:
//   ROVARA_FULL_SUITE=1 ~/.local/share/rovara-tools/heavy.sh <node 22.23.2> node_modules/vitest/vitest.mjs run --maxWorkers=4 --reporter=json --outputFile=<report.json>
//   node scripts/test-shard-timings.ts <report.json> [--out tests/.timings/vitest-durations.json]
// Only the relative weights matter: a local run is faster than a 2 vCPU CI runner, but a file that is slow here is slow there. Regenerate it
// now and then (after many test files are added or one gets much slower); a file the timings do not list gets the median weight.
// Node runs this file directly, so only erasable syntax and Node's own modules.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

interface FileResult { name?: unknown; startTime?: unknown; endTime?: unknown; assertionResults?: { duration?: unknown }[] }

/** Seconds per test file (repository-relative, forward slashes) from the JSON of vitest's JSON reporter. */
export function durationsFromReport(report: unknown, root: string): Record<string, number> {
  const results = (report as { testResults?: FileResult[] } | null)?.testResults;
  if (!Array.isArray(results)) throw new Error("not a vitest JSON report: no testResults");
  const seconds: Record<string, number> = {};
  for (const result of results) {
    if (typeof result.name !== "string") continue;
    const file = relative(root, result.name).replaceAll("\\", "/");
    if (file.startsWith("..")) continue;
    const wall = typeof result.startTime === "number" && typeof result.endTime === "number" ? result.endTime - result.startTime : 0;
    const tests = (result.assertionResults ?? []).reduce((sum, test) => sum + (typeof test.duration === "number" ? test.duration : 0), 0);
    // The file's own span, which holds its set-up and tear-down; the tests' sum is the fallback for a report that has no times.
    seconds[file] = Math.round(Math.max(wall, tests)) / 1000;
  }
  return seconds;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 5;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The file's text: stable key order and one file per line, so a regeneration diffs file by file. */
export function renderTimings(seconds: Readonly<Record<string, number>>): string {
  const files = Object.keys(seconds).sort();
  const defaultSeconds = Math.max(1, Math.round(median(files.map((file) => seconds[file]!)) * 100) / 100);
  const lines = files.map((file) => `    ${JSON.stringify(file)}: ${seconds[file]}`);
  return `{\n  "defaultSeconds": ${defaultSeconds},\n  "files": {\n${lines.join(",\n")}\n  }\n}\n`;
}

if (process.argv[1]?.endsWith("test-shard-timings.ts")) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args.splice(outIndex, 2)[1] : "tests/.timings/vitest-durations.json";
  const reportPath = args[0];
  if (reportPath === undefined || out === undefined || args.length !== 1) {
    console.error("Usage: node scripts/test-shard-timings.ts <vitest-json-report> [--out <file>]");
    process.exit(2);
  }
  const seconds = durationsFromReport(JSON.parse(readFileSync(reportPath, "utf8")), process.cwd());
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, renderTimings(seconds));
  const total = Object.values(seconds).reduce((sum, value) => sum + value, 0);
  console.log(`Wrote ${out}: ${Object.keys(seconds).length} files, ${Math.round(total)} s in all.`);
}
