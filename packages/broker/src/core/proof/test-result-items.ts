// TEST-RESULT-HONESTY: the pack's "not tested" items that a check's own output states, so the pull request and the Evidence tab say what a pass did not test. A check whose every test was skipped is a `check` item (the verdict
// reads it as "a planned check did not run", never "Verified"); some skipped tests and a service the test could not reach are listed beside it. Words come from the contracts' fixed table; only the check's label is
// the project's own, and it is flattened to one plain line here (the pull request shows it through `inertLine`).
import { SANDBOX_MODEL_HOSTS_ITEM_ID, TEST_RESULT_WORDS, checkResultNote, type CheckEntry, type EvidenceNotTested } from "@agentx/contracts";

/** Ids of the items below: `skipped:<check id>` and `needs_<service>`. The verdict tells them from the worker's own "not tested" items by these. */
export const SKIPPED_ITEM_PREFIX = "skipped:";
export const NEEDS_SERVICE_ITEM_PREFIX = "needs_";

/** The environment notes the broker writes itself, in fixed words: shown with the result, never a sign that test details could not be read (the model-hosts line, and "looks like a check needs <service>"). */
export const isFixedEnvironmentNote = (id: string): boolean => id === SANDBOX_MODEL_HOSTS_ITEM_ID || id.startsWith(NEEDS_SERVICE_ITEM_PREFIX);

const plain = (text: string, max: number): string => text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

/** What the pack's skipped-test items add up to, for the pull request's heading when the task has no Testing view: the tests skipped in checks that passed, and whether some check ran no test at all. Undefined: nothing was skipped. */
export function skippedFactsOf(notTested: readonly Pick<EvidenceNotTested, "id" | "kind" | "text">[]): { skipped: number; allSkipped: boolean } | undefined {
  let skipped = 0;
  let allSkipped = false;
  for (const item of notTested) {
    if (!item.id.startsWith(SKIPPED_ITEM_PREFIX)) continue;
    if (item.kind === "check") allSkipped = true;
    else skipped += Number(/^(\d{1,9}) tests? skipped in /u.exec(item.text)?.[1] ?? 0);
  }
  return allSkipped || skipped > 0 ? { skipped, allSkipped } : undefined;
}

export function testResultNotTested(checks: readonly CheckEntry[]): EvidenceNotTested[] {
  const items: EvidenceNotTested[] = [];
  const needed = new Set<string>();
  for (const check of checks) {
    const note = checkResultNote(check);
    const label = plain(check.label, 70);
    const id = `${SKIPPED_ITEM_PREFIX}${check.id}`.slice(0, 64);
    if (note.skipped?.all === true) items.push({ kind: "check", id, text: `${label}: every test was skipped`, reason: "not tested" });
    else if (note.skipped !== undefined) items.push({ kind: "not_selected", id, text: `${TEST_RESULT_WORDS.skipped(note.skipped.skipped)} in ${label}`, reason: "skipped, not run" });
    for (const service of note.needs) {
      if (needed.has(service)) continue;
      needed.add(service);
      items.push({ kind: "environment", id: `${NEEDS_SERVICE_ITEM_PREFIX}${service.toLowerCase()}`, text: `A check looks like it needs ${service}: Rovara didn't start one`, reason: "service not available" });
    }
  }
  return items;
}
