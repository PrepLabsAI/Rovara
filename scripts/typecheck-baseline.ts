// The stricter type check's ratchet (issue #50). `tsc -p tsconfig.lint.json` also checks tests/ and
// scripts/, which `npm run typecheck` (tsc -b) leaves out, and those files still have known errors.
// This script counts the errors per file and compares them with tests/typecheck-baseline.json:
// a file whose count goes up, or a new file with errors, fails; a count that goes down passes with
// a reminder to lower the baseline. `update` rewrites the baseline, but only ever lowers it.
// A tsc crash or config error always fails: it must never read as "0 errors". So does a baseline
// file the check no longer reads (a narrowed tsconfig), which would otherwise look like a fix.
// A renamed file keeps its errors under its new path: move its entry in the baseline by hand.
// Node runs this file directly; it loads TypeScript, a dev dependency, only to list the program.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { relative } from "node:path";
import type * as TypeScript from "typescript";

export type Counts = Record<string, number>;
export interface ParsedOutput { counts: Counts; problems: string[] }
export interface TscRun { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; error?: Error }
export type RunResult = { ok: true; counts: Counts } | { ok: false; reason: string };
export interface Change { file: string; baseline: number; current: number }
export interface Comparison { pass: boolean; raised: Change[]; lowered: Change[]; lines: string[] }
export type ProgramList = { ok: true; files: readonly string[] } | { ok: false; reason: string };
export interface RatchetDeps {
  github: boolean;
  readBaseline(): string;
  runTsc(): TscRun;
  listProgram(): ProgramList;
  writeBaseline(text: string): void;
}
export interface RatchetResult { code: 0 | 1; out: string[]; err: string[] }

export const BASELINE_PATH = "tests/typecheck-baseline.json";
const LOCATED = /^(.+?)\((\d+),(\d+)\): error (TS\d+): /;
const UNLOCATED = /^error TS\d+: /;
const REPO_PATH = /^[^/\\:][^\\:]*$/;

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
  if (run.signal === "SIGABRT") {
    return { ok: false, reason: `tsc was stopped by SIGABRT. It may have run out of memory: Node aborts when its heap is full. The heap limit is set by --max-old-space-size in tscArguments (scripts/typecheck-baseline.ts).` };
  }
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
    return {
      ok: false,
      reason: [
        "The baseline can only go down. Fix these errors instead of adding them to the baseline:",
        ...raised.map(describeChange),
        `If you renamed a file that already had errors, move its entry in ${BASELINE_PATH} by hand.`,
      ].join("\n"),
    };
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
    if (!REPO_PATH.test(file) || file.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`${BASELINE_PATH}: "${file}" must be a repository-relative path with forward slashes`);
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) throw new Error(`${BASELINE_PATH}: ${file} must have a whole-number count of at least 1`);
    counts[file] = count;
  }
  return counts;
}

/** Baseline files the type check no longer reads, so their errors cannot be counted. */
export function uncheckedBaselineFiles(baseline: Counts, programFiles: readonly string[]): string[] {
  const checked = new Set(programFiles);
  return Object.keys(baseline).filter((file) => !checked.has(file)).sort();
}

/** GitHub Actions annotations, so a raised or lowered count shows on the pull request. */
export function githubAnnotations(comparison: Comparison): string[] {
  return [
    ...comparison.raised.map((change) => `::error file=${BASELINE_PATH}::${change.file} has ${plural(change.current, "type error")}, more than its baseline of ${change.baseline}. Fix the new errors.`),
    ...comparison.lowered.map((change) => `::warning file=${BASELINE_PATH}::${change.file} has ${plural(change.current, "type error")}, fewer than its baseline of ${change.baseline}. Run npm run typecheck:baseline and commit it.`),
  ];
}

/** The whole command, with its side effects passed in: `check` compares, `update` lowers the baseline. */
export function runRatchet(mode: "check" | "update", deps: RatchetDeps): RatchetResult {
  const out: string[] = [];
  const err: string[] = [];
  const fail = (...lines: string[]): RatchetResult => ({ code: 1, out, err: [...err, ...lines] });
  let baseline: Counts;
  try {
    baseline = parseBaseline(deps.readBaseline());
  } catch (error) {
    return fail(`Could not read the baseline: ${error instanceof Error ? error.message : String(error)}`);
  }
  const program = deps.listProgram();
  if (!program.ok) return fail(`Could not list the files tsconfig.lint.json type-checks: ${program.reason}`);
  const tsc = deps.runTsc();
  const run = interpretTscRun(tsc);
  if (!run.ok) return fail("The stricter type check did not run cleanly, so it cannot be compared with the baseline.", run.reason);
  const unchecked = uncheckedBaselineFiles(baseline, program.files);
  if (unchecked.length > 0) {
    return fail(
      ...unchecked.map((file) => `${file} is in the baseline but is no longer type-checked by tsconfig.lint.json.`),
      `If the file was deleted or renamed, remove or move its entry in ${BASELINE_PATH} by hand. Otherwise put it back in the check.`,
    );
  }
  if (mode === "check") {
    const result = compareToBaseline(baseline, run.counts);
    (result.pass ? out : err).push(...result.lines);
    if (deps.github) out.push(...githubAnnotations(result));
    if (result.pass) return { code: 0, out, err };
    if (tsc.stdout.includes("error TS2307")) err.push("", "Some errors are missing-module errors (TS2307). Run `npm run typecheck` first: this check reads the packages' built outputs.");
    return { code: 1, out, err };
  }
  const lowered = lowerBaseline(baseline, run.counts);
  if (!lowered.ok) return fail(lowered.reason);
  deps.writeBaseline(formatBaseline(lowered.baseline));
  out.push(`Wrote ${BASELINE_PATH}: ${summary(lowered.baseline)} (was ${summary(baseline)}).`);
  return { code: 0, out, err };
}

const LINT_CONFIG = "tsconfig.lint.json";
const require = createRequire(import.meta.url);

/** Node's arguments for the tsc run. The lint project covers every test file, which outgrows Node's
 * default heap on a CI runner, so it gets the same 6 GB that `npm run lint` gives ESLint. */
export function tscArguments(tscPath: string, heapMb = 6144): string[] {
  return [`--max-old-space-size=${heapMb}`, tscPath, "-p", LINT_CONFIG, "--noEmit", "--pretty", "false"];
}

function runTsc(): TscRun {
  const result = spawnSync(process.execPath, tscArguments(require.resolve("typescript/bin/tsc")), {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, ...(result.error === undefined ? {} : { error: result.error }) };
}

function listProgram(): ProgramList {
  const ts = require("typescript") as typeof TypeScript;
  const unrecoverable: string[] = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(LINT_CONFIG, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => { unrecoverable.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); },
  });
  const errors = [...unrecoverable, ...(parsed?.errors ?? []).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))];
  if (parsed === undefined || errors.length > 0) return { ok: false, reason: errors.join("\n") || `${LINT_CONFIG} could not be parsed` };
  if (parsed.options.noCheck === true) return { ok: false, reason: `${LINT_CONFIG} sets noCheck, so it would report no errors at all` };
  return { ok: true, files: parsed.fileNames.map((file) => relative(process.cwd(), file).replaceAll("\\", "/")) };
}

// Usage: node scripts/typecheck-baseline.ts check|update, from the repository root, after tsc -b
if (process.argv[1]?.endsWith("typecheck-baseline.ts")) {
  const mode = process.argv[2];
  if (mode !== "check" && mode !== "update") throw new Error("usage: node scripts/typecheck-baseline.ts check|update");
  const result = runRatchet(mode, {
    github: process.env.GITHUB_ACTIONS === "true",
    readBaseline: () => readFileSync(BASELINE_PATH, "utf8"),
    runTsc,
    listProgram,
    writeBaseline: (text) => { writeFileSync(BASELINE_PATH, text); },
  });
  if (result.out.length > 0) console.log(result.out.join("\n"));
  if (result.err.length > 0) console.error(result.err.join("\n"));
  process.exitCode = result.code;
}
