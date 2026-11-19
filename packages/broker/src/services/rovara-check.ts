// L4-RC: the "Rovara" Check is on for everyone (owner decision 2026-11-17: the pull request redesign rolls out with no switch). A host asks for the Check by passing this source to the merge tracking service
// as `summaryCheck` (the service adds the verdict source, `createMergeTrackingService`). The gate is open for every task; nothing else is decided here:
//   - the Check's status, conclusion and words are the contracts' `rovaraCheckOf` table and nothing more (a Rovara problem or a check that did not run is neutral; only a change-proof hold or a failed full suite is a failure);
//   - the Check is never made a *required* check by Rovara: it is the customer's branch rule that decides whether a failed Rovara Check blocks a merge (as the table's own comment says), and Rovara never sets one;
//   - it is written only through the code host the task's repository record names, for the task's own company (the tracking pass is built per company; the hosted code host serves a company's own repositories only);
//   - an install whose GitHub App has not been given the Checks permission refuses the token: the host answers `no_permission`, no Check is written, the pass goes on, and the write is asked again only after an hour.
import type { SummaryCheckSource } from "../core/merge/summary-check.js";
import type { MergeTask } from "../core/merge/seams.js";

export interface RovaraCheckSourceOptions {
  /** Where the Check's "Details" opens: the task's signed-in page (only an https address is used). Absent: the Check has no link. */
  detailsUrl?: (task: MergeTask) => string | undefined;
}

/** The `summaryCheck` option of a host that turns the Check on for every task. */
export function rovaraCheckSource(options: RovaraCheckSourceOptions = {}): SummaryCheckSource {
  return { enabled: () => true, ...(options.detailsUrl === undefined ? {} : { detailsUrl: options.detailsUrl }) };
}
