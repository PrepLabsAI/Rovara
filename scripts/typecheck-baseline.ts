// The stricter type check's ratchet (issue #50). `tsc -p tsconfig.lint.json` also checks tests/ and
// scripts/, which `npm run typecheck` (tsc -b) leaves out, and those files still have known errors.
// This script counts the errors per file and compares them with tests/typecheck-baseline.json:
// a file whose count goes up, or a new file with errors, fails; a count that goes down passes with
// a reminder to lower the baseline. `update` rewrites the baseline, but only ever lowers it.
// A tsc crash or config error always fails: it must never read as "0 errors". Node runs this file
// directly, so it imports only Node's own modules.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

export type Counts = Record<string, number>;
export interface ParsedOutput { counts: Counts; problems: string[] }
export interface TscRun { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }
export type RunResult = { ok: true; counts: Counts } | { ok: false; reason: string };
export interface Change { file: string; baseline: number; current: number }
export interface Comparison { pass: boolean; raised: Change[]; lowered: Change[]; lines: string[] }

export const BASELINE_PATH = "tests/typecheck-baseline.json";
const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /;
const UNLOCATED = /^error TS\d+: /;

/** Per-file error counts from `tsc --pretty false` output; anything unexpected goes in `problems`. */
export function parseTscOutput(text: string): ParsedOutput {
  const counts: Counts = {};
  const problems: string[] = [];
  let inError = false;
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const located = LOCATED.exec(line);
    if (located !== null) {
      const file = located[1]!.replaceAll("\\", "/");
      const code = located[4]!;
      // A compiler option error, or any error inside a JSON config file, means the check itself is
      // broken, so it is a problem, not a count a baseline could absorb.
      if (code.startsWith("TS5") || file.endsWith(".json")) problems.push(line);
      else counts[file] = (counts[file] ?? 0) + 1;
      inError = true;
    } else if (/^\s/.test(line) && inError) {
      continue; // The indented lines that continue a multi-line error.
    } else {
      problems.push(line);
      inError = UNLOCATED.test(line);
    }
  }
  return { counts, problems };
}

/** Turns a tsc run into per-file counts, or a reason the run cannot be trusted. */
export function interpretTscRun(run: TscRun): RunResult {
  if (run.error !== undefined) return { ok: false, reason: `tsc could not run: ${run.error.message}` };
  if (run.signal !== null) return { ok: false, reason: `tsc was stopped by ${run.signal}` };
  if (run.status === null) return { ok: false, reason: "tsc exited without an exit code" };
  if (run.stderr.trim() !== "") return { ok: false, reason: `tsc wrote to stderr:\n${run.stderr.trim()}` };
  const parsed = parseTscOutput(run.stdout);
  if (parsed.problems.length > 0) return { ok: false, reason: `tsc printed output that is not a per-file type error:\n${parsed.problems.join("\n")}` };
  const found = Object.keys(parsed.counts).length > 0;
  if (run.status === 0) return found ? { ok: false, reason: "tsc exited with code 0 but reported errors" } : { ok: true, counts: {} };
  if (run.status !== 1 && run.status !== 2) return { ok: false, reason: `tsc exited with code ${run.status}, which means the project setup is broken` };
  if (!found) return { ok: false, reason: `tsc exited with code ${run.status} but reported no errors` };
  return { ok: true, counts: parsed.counts };
}

function changes(baseline: Counts, current: Counts): { raised: Change[]; lowered: Change[] } {
  const raised: Change[] = [];
  const lowered: Change[] = [];
  for (const file of [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()) {
    const was = baseline[file] ?? 0;
    const now = current[file] ?? 0;
    if (now > was) raised.push({ file, baseline: was, current: now });
    else if (now < was) lowered.push({ file, baseline: was, current: now });
  }
  return { raised, lowered };
}

const describeChange = (change: Change): string => `  ${change.file}: ${change.baseline} -> ${change.current}`;
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;
function summary(counts: Counts): string {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return `${plural(total, "error")} in ${plural(Object.keys(counts).length, "file")}`;
}

/** Compares the current counts with the baseline: any raised or new file fails. */
export function compareToBaseline(baseline: Counts, current: Counts): Comparison {
  const { raised, lowered } = changes(baseline, current);
  const lines = [`Stricter type check (tsconfig.lint.json): ${summary(current)} (baseline: ${summary(baseline)}).`];
  if (raised.length > 0) {
    lines.push("", "These files have more type errors than the baseline allows. Fix the new errors:", ...raised.map(describeChange));
  }
  if (lowered.length > 0) {
    lines.push("", "These files have fewer type errors than the baseline. Lower the baseline with `npm run typecheck:baseline` and commit it:", ...lowered.map(describeChange));
  }
  return { pass: raised.length === 0, raised, lowered, lines };
}

/** The new baseline after errors were fixed; refuses to raise any count or add any file. */
export function lowerBaseline(baseline: Counts, current: Counts): { ok: true; baseline: Counts } | { ok: false; reason: string } {
  const { raised } = changes(baseline, current);
  if (raised.length > 0) {
    return { ok: false, reason: ["The baseline can only go down. Fix these errors instead of adding them to the baseline:", ...raised.map(describeChange)].join("\n") };
  }
  return { ok: true, baseline: { ...current } };
}

export function formatBaseline(counts: Counts): string {
  const files = Object.fromEntries(Object.keys(counts).sort().map((file) => [file, counts[file]!]));
  return `${JSON.stringify({ files }, null, 2)}\n`;
}

export function parseBaseline(text: string): Counts {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${BASELINE_PATH} must be an object with a "files" map`);
  const extra = Object.keys(value).filter((key) => key !== "files");
  if (extra.length > 0) throw new Error(`${BASELINE_PATH} has unknown keys: ${extra.join(", ")}`);
  const files = (value as { files?: unknown }).files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) throw new Error(`${BASELINE_PATH} must have a "files" map`);
  const counts: Counts = {};
  for (const [file, count] of Object.entries(files)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) throw new Error(`${BASELINE_PATH}: ${file} must have a whole-number count of at least 1`);
    counts[file] = count;
  }
  return counts;
}

function runTsc(): TscRun {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.lint.json", "--noEmit", "--pretty", "false"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, ...(result.error === undefined ? {} : { error: result.error }) };
}

// Usage: node scripts/typecheck-baseline.ts check|update (after tsc -b, so package outputs exist)
if (process.argv[1]?.endsWith("typecheck-baseline.ts")) {
  const mode = process.argv[2];
  if (mode !== "check" && mode !== "update") throw new Error("usage: node scripts/typecheck-baseline.ts check|update");
  const baseline = parseBaseline(readFileSync(BASELINE_PATH, "utf8"));
  const run = interpretTscRun(runTsc());
  if (!run.ok) {
    console.error(`The stricter type check did not run cleanly, so it cannot be compared with the baseline.\n${run.reason}`);
    process.exit(1);
  }
  if (mode === "check") {
    const result = compareToBaseline(baseline, run.counts);
    (result.pass ? console.log : console.error)(result.lines.join("\n"));
    if (!result.pass) {
      console.error("\nRun `npm run typecheck` first if packages show missing-module errors: this check reads their built outputs.");
      process.exit(1);
    }
  } else {
    const lowered = lowerBaseline(baseline, run.counts);
    if (!lowered.ok) {
      console.error(lowered.reason);
      process.exit(1);
    }
    writeFileSync(BASELINE_PATH, formatBaseline(lowered.baseline));
    console.log(`Wrote ${BASELINE_PATH}: ${summary(lowered.baseline)} (was ${summary(baseline)}).`);
  }
}
