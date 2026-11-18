// Lane L12, slice 1: merge tracking on a laptop. The service is host-neutral (`services/merge-tracking.ts`); this file composes it with the laptop's rules:
//
//   settings   Code's fixed settings (self-approval on: one owner)
//   people     the sole owner
//
// Cloud wakes a task's tracking row with a webhook and sweeps the rest on a schedule; a laptop has no public address, so `rovara up` POLLS: a timer calls the service's `sweep`.
//
// Merge tracking never presses merge (owner decision 1): a person merges, in the code host or with their proof. The laptop's token has the owner's own allowance (5,000 an hour on GitHub), which is why a pass and a
// sweep have request allowances (see the service).
import { fixedCodeSettings } from "../../core/merge/defaults.js";
import { soleOwnerPeople, type MergePeople } from "../../core/merge/people.js";
import type { CodeSettingsReader } from "../../core/merge/seams.js";
import {
  createMergeTrackingService, createMilestoneService, type MergeTrackingService, type MergeTrackingServiceOptions,
} from "../../services/merge-tracking.js";
import { rovaraCheckSource } from "../../services/rovara-check.js";

export {
  CLOSED_OUTSIDE, MERGED_OUTSIDE, SWEEP_MAX_MS, SWEEP_MAX_REQUESTS, SWEEP_MAX_ROWS, TRACKING_FAILURE_MAX_MS, TRACKING_POLL_MS, TRACKING_QUIET_MAX_MS, createReadBudget, createRepositoryResolver, sessionTimeline,
} from "../../services/merge-tracking.js";

/** The milestone hook for a laptop: the service's, over the app's store. */
export const createLocalMilestones = createMilestoneService;

export interface LocalTrackingOptions extends Omit<MergeTrackingServiceOptions, "people" | "settings"> {
  /** Default: the sole owner (a laptop has one person and no linked code-host accounts). */
  people?: MergePeople;
  /** Default: Code's fixed settings (self-approval on). */
  settings?: CodeSettingsReader;
}

export type LocalTracking = MergeTrackingService;

export function createLocalTracking(options: LocalTrackingOptions): LocalTracking {
  // L4-RC: the "Rovara" Check is on for every task (owner decision 2026-11-17). It is written only where the code host can write one: a laptop signed in with a personal token cannot (GitHub allows Checks from a GitHub App
  // only; the token client (`token-client.ts`) hands the adapter neither Check method, so `githubTokenCodeHost` offers none), so there it is a no-op, and a laptop whose host is an App (a test's fake host, a future App sign-in) gets it. The Check's "Details" has no link here: the task page is
  // an http address that carries the owner's session, and a Check only opens https addresses.
  return createMergeTrackingService({ ...options, summaryCheck: options.summaryCheck ?? rovaraCheckSource(), people: options.people ?? soleOwnerPeople, settings: options.settings ?? fixedCodeSettings() });
}
