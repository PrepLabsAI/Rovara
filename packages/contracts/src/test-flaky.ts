// TE-C6: a test that failed once in a task round and passed on its one rerun is FLAKY. These are the pure facts and the one fixed line about it.
//   - `flakyOnChangeOf`: the rerun-flaky tests that were NOT already flaky on the base. A test the base's flaky set does not name, or a base that has no usable flaky set, counts as "passed on the base" (fail closed toward holding the draft).
//   - `flakyRerunLine`: the one line a person reads. Fixed words and a count only: a test id is a repository's text and never goes in a sentence here (the ids ride in the evidence's `tests` part, where they are inert data).
// Nothing here is a verdict about the change: a flaky failure is not a pass, and the check report keeps its `regression` class. Whatever tier or budget logic reads these facts reads them as DATA.
import { z } from "zod";
import { isValidTestId, TEST_ID_MAX } from "./test-id.js";

/** The most flaky test ids the evidence lists for one check (the count says how many there are in all). */
export const FLAKY_ON_RERUN_MAX = 50;

/**
 * The tests that were flaky in this round's rerun and are not known flaky on the base, in the order given, each once, at most `FLAKY_ON_RERUN_MAX`.
 * `baseFlaky` undefined means the base's flaky set could not be read or is not usable: then no test is known flaky on the base.
 */
export function flakyOnChangeOf(rerunFlaky: readonly string[], baseFlaky: readonly string[] | undefined): string[] {
  const base = new Set(baseFlaky ?? []);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of rerunFlaky) {
    if (typeof id !== "string" || id === "" || seen.has(id) || base.has(id)) continue;
    seen.add(id);
    if (out.length < FLAKY_ON_RERUN_MAX) out.push(id);
  }
  return out;
}

/** The line about tests that failed once and passed on the rerun: a count in fixed words, or undefined when there were none. */
export function flakyRerunLine(count: number): string | undefined {
  if (!Number.isSafeInteger(count) || count <= 0) return undefined;
  return `${count.toLocaleString("en-US")} ${count === 1 ? "test was" : "tests were"} flaky (passed on rerun); not counted against this change.`;
}

// ---- the worker's file about the rerun, and what the broker may do with it (9d's decision on the VERIFY block, 2026-11-13)
// A check whose ONLY failures are tests that failed once and passed on the rerun is recorded as passed for VERIFY, and the workflow carries a typed `flakyOnChange` fact (count and ids) that B5's `flaky_on_change` hold
// reads, so the pull request stays a draft with that reason. The worker is untrusted: its file only NAMES the checks it saw pass on the rerun; the broker's own entries decide whether such a check may be excused.

/** The artifact a worker saves when a task round's rerun found a check fully flaky (every failing test of it passed on the rerun). */
export const FLAKY_RERUN_ARTIFACT = "flaky-rerun.json";
/** The most the broker reads of it. */
export const FLAKY_RERUN_FILE_MAX_BYTES = 64 * 1024;
const FlakyTestId = z.string().min(1).max(TEST_ID_MAX).refine(isValidTestId, "a test id has no control, hidden or look-alike characters, and no space at either end");

export const FlakyRerunFileSchema = z.object({
  schemaVersion: z.literal(1),
  /** Only checks that are FULLY flaky: each lists the tests that failed in the round and passed on the rerun. */
  checks: z.array(z.object({ checkId: z.string().regex(/^readiness:\d{1,2}$/u), flaky: z.array(FlakyTestId).min(1).max(FLAKY_ON_RERUN_MAX) }).strict()).max(64),
}).strict().superRefine((file, context) => {
  if (new Set(file.checks.map((check) => check.checkId)).size !== file.checks.length) context.addIssue({ code: "custom", path: ["checks"], message: "a check appears once" });
});
export type FlakyRerunFile = z.infer<typeof FlakyRerunFileSchema>;

/**
 * The checks the file may excuse, with their rerun-flaky ids: a check the BROKER's own report shows as a project check that failed (not timed out, not skipped) and is a regression (the only class the worker reruns).
 * A check the broker has no entry for, an agent command, an already-failing check, a timeout or a check that did not run is never excused, whatever the file says.
 */
export function flakyOnlyChecks(file: FlakyRerunFile | undefined, entries: ReadonlyArray<{ id: string; source: string; after: string; class: string }>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (file === undefined) return out;
  for (const check of file.checks) {
    const entry = entries.find((candidate) => candidate.id === check.checkId);
    if (entry === undefined || entry.source !== "project" || entry.after !== "failed" || entry.class !== "regression") continue;
    out.set(check.checkId, [...new Set(check.flaky)]);
  }
  return out;
}

/** What the workflow carries for B5's hold: the rerun-flaky tests (across the excused checks) that the base does not already have as flaky. Undefined when there are none: flaky on both is no hold. */
export function flakyHoldFactOf(flakyIdsByCheck: Iterable<readonly string[]>, baseFlaky: readonly string[] | undefined): { count: number; ids: string[] } | undefined {
  const all = [...new Set([...flakyIdsByCheck].flat())];
  const base = new Set(baseFlaky ?? []);
  const onChange = all.filter((id) => !base.has(id));
  return onChange.length === 0 ? undefined : { count: onChange.length, ids: flakyOnChangeOf(all, baseFlaky) };
}
