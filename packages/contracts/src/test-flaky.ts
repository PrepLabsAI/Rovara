// TE-C6: a test that failed once in a task round and passed on its one rerun is FLAKY. These are the pure facts and the one fixed line about it.
//   - `flakyOnChangeOf`: the rerun-flaky tests that were NOT already flaky on the base. A test the base's flaky set does not name, or a base that has no usable flaky set, counts as "passed on the base" (fail closed toward holding the draft).
//   - `flakyRerunLine`: the one line a person reads. Fixed words and a count only: a test id is a repository's text and never goes in a sentence here (the ids ride in the evidence's `tests` part, where they are inert data).
// Nothing here is a verdict about the change: a flaky failure is not a pass, and the check report keeps its `regression` class. Whatever tier or budget logic reads these facts reads them as DATA.

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
