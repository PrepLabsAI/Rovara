// TE-B3 (O39): the words for "tests may be weaker" and for the flag at the top of a pull request or a Check: Rovara instruction files changed, files CI runs changed, tests that ran before and not now, more tests skipped,
// changed snapshots, fixtures and test configuration. One pure function, so the pull request description, the Check summary and the task page say the same thing. These are FLAGS, never approvals: nothing here decides a
// verdict (until TE-B5 makes the words gating). Every name in it came from a repository (a path, a test id), so each goes through `inertEvidenceText`; every list is bounded and the rest is counted. Browser-safe.
import { inertEvidenceText } from "./evidence-inert.js";

/** What the flags are made from. Lists hold paths or test ids (untrusted); counts are the true totals when a list was cut. */
export interface WeakeningFacts {
  skipRise?: { before: number; after: number } | undefined;
  removedTests?: readonly string[] | undefined;
  absentOnNew?: readonly string[] | undefined;
  /** How many tests are absent in all, when `absentOnNew` was cut. */
  absentOnNewCount?: number | undefined;
  changedTestConfig?: readonly string[] | undefined;
  changedSnapshots?: readonly string[] | undefined;
  changedFixtures?: readonly string[] | undefined;
  instructionFiles?: readonly string[] | undefined;
  ciExecutedFiles?: readonly string[] | undefined;
}

export const WEAKENING_LIMITS = { namesListed: 3, nameMax: 100, lineMax: 300 } as const;

const num = (count: number): string => (typeof count === "number" && Number.isFinite(count) && count >= 0 ? Math.floor(count).toLocaleString("en-US") : "?");
const noun = (count: number, one: string, many = `${one}s`): string => `${num(count)} ${count === 1 ? one : many}`;
const cut = (text: string, max: number): string => {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
};

/** `a, b, c and 4 more`: the first few names inert and cut, the rest counted (`total` when the list itself was cut). */
function listed(names: readonly string[], total = names.length): string {
  // A reader's data is checked, but the words never trust an entry to be text.
  const shown = names.slice(0, WEAKENING_LIMITS.namesListed).map((name) => (typeof name === "string" ? inertEvidenceText(name, WEAKENING_LIMITS.nameMax) : "")).filter((name) => name !== "");
  const more = Math.max(0, total - shown.length);
  return `${shown.join(", ")}${more > 0 ? `${shown.length > 0 ? " " : ""}and ${num(more)} more` : ""}`;
}

/**
 * The flag lines (instruction files and CI-executed files: shown first, at the top) and the weakening lines (tests). Each is one plain line, no list marker; an empty list gives no line. `flags` is empty when neither
 * kind of file changed. A count that is not a finite number prints "?" rather than a wrong figure.
 */
export function weakeningLines(facts: WeakeningFacts): { flags: string[]; weakening: string[] } {
  const line = (text: string) => cut(text, WEAKENING_LIMITS.lineMax);
  const has = (list: readonly string[] | undefined): list is readonly string[] => Array.isArray(list) && list.length > 0;
  const flags: string[] = [];
  if (has(facts.instructionFiles)) flags.push(line(`Rovara instruction files changed (a flag, not an approval): ${listed(facts.instructionFiles)}`));
  if (has(facts.ciExecutedFiles)) flags.push(line(`Files that CI runs changed (a flag, not an approval): ${listed(facts.ciExecutedFiles)}`));
  const weakening: string[] = [];
  const absent = Array.isArray(facts.absentOnNew) ? facts.absentOnNew : [];
  const absentTotal = Math.max(typeof facts.absentOnNewCount === "number" && Number.isFinite(facts.absentOnNewCount) ? facts.absentOnNewCount : 0, absent.length);
  if (absentTotal > 0) weakening.push(line(`${noun(absentTotal, "test")} ran before and not now${absent.length > 0 ? `: ${listed(absent, absentTotal)}` : ""}`));
  const rise = facts.skipRise;
  if (rise !== undefined && Number.isFinite(rise.before) && Number.isFinite(rise.after) && rise.after > rise.before) weakening.push(`${num(rise.after - rise.before)} more ${rise.after - rise.before === 1 ? "test" : "tests"} skipped than before`);
  if (has(facts.removedTests)) weakening.push(line(`${noun(facts.removedTests.length, "test")} removed: ${listed(facts.removedTests)}`));
  if (has(facts.changedTestConfig)) weakening.push(line(`Test config files changed: ${listed(facts.changedTestConfig)}`));
  if (has(facts.changedSnapshots)) weakening.push(line(`Snapshot files changed: ${listed(facts.changedSnapshots)}`));
  if (has(facts.changedFixtures)) weakening.push(line(`Fixture files changed: ${listed(facts.changedFixtures)}`));
  return { flags, weakening };
}
