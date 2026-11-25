// TEST-RESULT-HONESTY: the pack's "not tested" items that a check's own output states, so the pull request and the Evidence tab say what a pass did not test. A check whose every test was skipped is a `check` item (the verdict
// reads it as "a planned check did not run", never "Verified"); some skipped tests and a service the test could not reach are listed beside it. Words come from the contracts' fixed table; only the check's label is
// the project's own, and it is flattened to one plain line here (the pull request shows it through `inertLine`).
import { TEST_RESULT_WORDS, checkResultNote, type CheckEntry, type EvidenceNotTested } from "@agentx/contracts";

/** Ids of the items below: `skipped:<check id>` and `needs_<service>`. The verdict tells them from the worker's own "not tested" items by these. */
export const SKIPPED_ITEM_PREFIX = "skipped:";
export const NEEDS_SERVICE_ITEM_PREFIX = "needs_";

const plain = (text: string, max: number): string => text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);

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
