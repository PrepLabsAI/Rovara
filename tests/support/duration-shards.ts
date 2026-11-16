// Splits the test files into shards of about equal total run time. Vitest's own --shard splits by file count, and a few slow files
// (CDK synth, containers, the big contract suites) made some shards take twice as long as others. This is the planner behind
// tests/support/duration-sequencer.ts: a pure function of the file list, the checked-in timings (tests/.timings/vitest-durations.json,
// written by scripts/test-shard-timings.ts) and the shard count, so every shard job, on its own machine, computes the same split.
import { readFileSync } from "node:fs";

/** What the timings file holds: seconds per test file (repository-relative, forward slashes), and the weight of a file it does not list. */
export interface Timings {
  /** The weight, in seconds, of a file the timings do not list (a new test file): the median of the listed ones when the file was written. */
  defaultSeconds: number;
  files: Readonly<Record<string, number>>;
}

/** A file never weighs less than this: vitest's JSON report holds a file's tests but not its import and worker start-up, which even a small file pays. */
export const MIN_WEIGHT_SECONDS = 1;
/** Used only when the timings file is missing or empty: every file weighs the same, which is the old split by file count. */
export const FALLBACK_DEFAULT_SECONDS = 5;

export const TIMINGS_PATH = "tests/.timings/vitest-durations.json";

export function parseTimings(text: string): Timings {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null) throw new Error("the timings file is not an object");
  const { defaultSeconds, files } = value as { defaultSeconds?: unknown; files?: unknown };
  if (typeof defaultSeconds !== "number" || !(defaultSeconds > 0)) throw new Error("the timings file needs a positive defaultSeconds");
  if (typeof files !== "object" || files === null) throw new Error("the timings file needs a files object");
  for (const [file, seconds] of Object.entries(files)) {
    if (typeof seconds !== "number" || !(seconds >= 0)) throw new Error(`the timings file has a bad duration for ${file}`);
  }
  return { defaultSeconds, files: files as Record<string, number> };
}

/** The checked-in timings, or an empty set (every file at the default weight) when the file is not there. */
export function loadTimings(path: string): Timings {
  try {
    return parseTimings(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { defaultSeconds: FALLBACK_DEFAULT_SECONDS, files: {} };
    throw error;
  }
}

export function weightOf(file: string, timings: Timings): number {
  return Math.max(MIN_WEIGHT_SECONDS, timings.files[file] ?? timings.defaultSeconds);
}

/**
 * Longest-processing-time-first: the heaviest file goes to the shard with the least total so far (the lowest-numbered one on a tie), ties between
 * equal weights are broken by path. Deterministic for a given file list, and it covers each file exactly once. Index 0 of the result is shard 1.
 * Each shard's files come back in path order.
 */
export function planShards(files: readonly string[], timings: Timings, count: number): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error("the shard count must be a positive integer");
  const unique = [...new Set(files)];
  const ordered = unique.map((file) => ({ file, weight: weightOf(file, timings) })).sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const shards: string[][] = Array.from({ length: count }, () => []);
  const totals = new Array<number>(count).fill(0);
  for (const { file, weight } of ordered) {
    let lightest = 0;
    for (let index = 1; index < count; index++) if (totals[index]! < totals[lightest]!) lightest = index;
    shards[lightest]!.push(file);
    totals[lightest]! += weight;
  }
  return shards.map((shard) => shard.sort());
}

/** The total weight of each shard of a plan, in seconds. */
export function shardTotals(plan: readonly (readonly string[])[], timings: Timings): number[] {
  return plan.map((shard) => shard.reduce((sum, file) => sum + weightOf(file, timings), 0));
}
