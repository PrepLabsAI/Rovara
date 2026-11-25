// TIER-GROWTH-MERGE: what a change that GREW after its plan still owes before it may merge, as ONE pure reader that the merge view, the press, the task's standing and the session summary all use, so they cannot disagree.
//
// A change whose diff rates above the level its plan was made at (`flow.grewAfterBuild`) may merge only once the code and security reviews of the higher level ran on the CURRENT head of its pull requests: the tier review
// record for that head (`recordTierReview`), written by the tier pass (`tier-checks.ts`) after it ran both reviews on that head. The normal flow's own review step does NOT stand in for it: it has no level of its own and ran
// before the head was known to have grown. A growth is sticky (the tier never goes down), so a send-back that shrinks the change does not lower the bar: the owed reviews are of the higher level, and the hold clears once
// they are on the record for the head, whatever its size. Nothing is derived that could go stale: the record is for a head, and a new head has none.
import { GROWTH_WORDS, type FlowQuickCheck, type MergeTrackingItem, type WorkflowFlow, type WorkflowSnapshot } from "@agentx/contracts";
import { higherLevel, tierReviewRecorded, type TierLevel } from "../decisions/change-tier.js";
import { boundCommits } from "./change-tier-read.js";

/** How many times a review that could not run is run on one head before only a new push runs it again (a spending-limit stop is not counted: it is run again, for free, until the limit lets it through). */
export const REVIEW_RUNS_MAX = 3;

/** The words a grown tier's review is recorded under for a head: `review level=standard head=<sha>`. */
export const reviewAttempt = (level: TierLevel, head: string): string => `review level=${level} head=${head}`;

/** What a review attempt that did not run says it was stopped by: `did not run (unavailable, cap)`. */
export const failureKindsOf = (detail: string): string[] => /did not run \(([^)]*)\)/u.exec(detail)?.[1]?.split(", ") ?? [];

/** The pull requests that are still open, as the facts this reader needs of each. */
export type OpenHead = Pick<MergeTrackingItem, "repositoryId" | "number" | "headSha">;

/** The level a grown change owes the reviews of: the highest it reached. */
export const owedLevelOfFlow = (flow: WorkflowFlow | undefined): TierLevel | undefined => {
  const grew = flow?.grewAfterBuild;
  return grew === undefined ? undefined : higherLevel(grew.to, flow?.tier?.level ?? grew.to);
};
export const owedLevelOf = (workflow: WorkflowSnapshot | undefined): TierLevel | undefined => owedLevelOfFlow(workflow?.flow);

/** What the person reads and how the task stands while the reviews are owed. */
export interface GrowthOwed {
  level: TierLevel;
  /** `reviewing`: the reviews are being run (or will be). `needs_you`: they cannot run, or found something, so a person has to act. */
  state: "reviewing" | "needs_you";
  /** The fixed sentence (the one words table): what the merge view says and what the press refuses with. */
  words: string;
  /** The short reason a pill or a status line carries. */
  reason: string;
  next: string;
  /** The task's spending limit is what stopped them. */
  cap?: true;
}

const attemptsOn = (checks: readonly FlowQuickCheck[], head: string | undefined): FlowQuickCheck[] =>
  head === undefined ? [] : checks.filter((check) => /^(?:check )?review level=/u.test(check.detail ?? "") && (check.detail ?? "").includes(` head=${head}`));

/**
 * What a grown change still owes at its open pull requests' current heads, or undefined when nothing is owed (it never grew, or the higher level's reviews are on the record for these heads, written only by the tier pass). Read from the workflow and what merge tracking last read; it asks nothing of the code host.
 */
export function growthOwedOf(workflow: WorkflowSnapshot | undefined, items: ReadonlyArray<OpenHead & { state: MergeTrackingItem["state"] }>): GrowthOwed | undefined {
  const flow = workflow?.flow;
  const level = owedLevelOf(workflow);
  if (workflow === undefined || flow === undefined || level === undefined) return undefined;
  const open = items.filter((item) => item.state === "open");
  if (open.length === 0) return undefined;
  const head = boundCommits(open.map((item) => ({ repositoryId: item.repositoryId, headSha: item.headSha }))).headSha;
  if (tierReviewRecorded(flow, level, head)) return undefined;
  const reviewing: GrowthOwed = { level, state: "reviewing", words: GROWTH_WORDS.running(level), reason: GROWTH_WORDS.runningReason(level), next: GROWTH_WORDS.nextRunning };
  const latest = attemptsOn(flow.quickChecks ?? [], head).at(-1);
  return latest === undefined ? reviewing : afterAttempt(level, latest.detail ?? "", reviewing);
}

/** What the latest attempt on this head says: problems found, the limit, a review that cannot run, or an outage that is run again. */
function afterAttempt(level: TierLevel, detail: string, reviewing: GrowthOwed): GrowthOwed {
  const stuck = (words: string, next: string = GROWTH_WORDS.nextNeedsYou, extra: { cap?: true } = {}): GrowthOwed => ({ level, state: "needs_you", words, reason: words, next, ...extra });
  const kinds = failureKindsOf(detail);
  const mustFix = Number(/\b(\d+) must be fixed/u.exec(detail)?.[1] ?? "0");
  if (mustFix > 0) return stuck(GROWTH_WORDS.foundProblems(level));
  if (kinds.length === 0) return reviewing;
  if (kinds.includes("unsupported")) return stuck(GROWTH_WORDS.unsupported(level), GROWTH_WORDS.nextUnsupported);
  if (kinds.includes("no_reviewer")) return stuck(GROWTH_WORDS.noReviewer(level), GROWTH_WORDS.nextNoReviewer);
  if (kinds.every((kind) => kind === "cap")) return stuck(GROWTH_WORDS.cap(level), GROWTH_WORDS.nextRaiseLimit, { cap: true });
  const outage = kinds.every((kind) => kind === "unavailable" || kind === "refused" || kind === "cap");
  const runs = Number(/\bruns=(\d+)/u.exec(detail)?.[1] ?? "1");
  return outage && runs < REVIEW_RUNS_MAX ? reviewing : stuck(GROWTH_WORDS.couldNotRun(level), GROWTH_WORDS.nextRetry);
}
