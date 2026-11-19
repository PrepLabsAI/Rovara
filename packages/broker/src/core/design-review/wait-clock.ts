// Design review stage: the clock of a design review that waits on people. PURE: a workflow and a time in, what is due out. The three waits are the question card, the cost
// hold's card and the design card's decision (`designWaitOf`). The rules, one table:
//
//   after 24 h of waiting    a reminder to the people asked
//   after 72 h               a second reminder, also to the project's maintainers
//   after 7 days             the review is parked (`parkDesignReview`): "Paused: waiting for the design decision"
//   after 30 days parked     the task is closed as "not decided" (`closeParkedDesignReview`)
//
// NOTHING HERE APPROVES, ANSWERS OR SKIPS: the only outputs are a reminder, a park and a close, and the park and the close are the workflow's own moves that record no decision.
import { DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS, DESIGN_REVIEW_PARK_AFTER_MS, DESIGN_REVIEW_REMIND_AFTER_HOURS, designWaitOf, type DesignWait, type WorkflowSnapshot } from "@agentx/contracts";

const HOUR_MS = 60 * 60 * 1000;

/** The notices a wait sends, each once: the two reminders, the park and the close. */
export type DesignWaitNoticeStep = "24h" | "72h" | "parked" | "closed";

export type DesignWaitStep =
  | { kind: "none" }
  | { kind: "remind"; hours: (typeof DESIGN_REVIEW_REMIND_AFTER_HOURS)[number] }
  | { kind: "park" }
  | { kind: "close" };

/** What is due for this workflow at `nowMs`. A workflow that is not waiting on people has no wait and nothing is due. */
export function designWaitStep(workflow: WorkflowSnapshot, nowMs: number): { wait: DesignWait; step: DesignWaitStep } | undefined {
  const wait = designWaitOf(workflow);
  if (wait === undefined) return undefined;
  const since = Date.parse(wait.since);
  if (!Number.isFinite(since)) return { wait, step: { kind: "none" } };
  if (wait.parkedAt !== undefined) {
    const parkedAt = Date.parse(wait.parkedAt);
    return { wait, step: Number.isFinite(parkedAt) && nowMs - parkedAt >= DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS ? { kind: "close" } : { kind: "none" } };
  }
  const age = nowMs - since;
  if (age >= DESIGN_REVIEW_PARK_AFTER_MS) return { wait, step: { kind: "park" } };
  // The latest reminder that has come due; an earlier one that was never sent (the sweep was down) is not sent late behind it.
  const due = [...DESIGN_REVIEW_REMIND_AFTER_HOURS].reverse().find((hours) => age >= hours * HOUR_MS);
  return { wait, step: due === undefined ? { kind: "none" } : { kind: "remind", hours: due } };
}

/** The next time (ms since the epoch) something becomes due for this wait after `nowMs`, or undefined when nothing ever will (a closed wait). It is when the row that finds waits next looks at the task. */
export function nextDesignWaitDueAt(wait: DesignWait, nowMs: number): number | undefined {
  const since = Date.parse(wait.since);
  if (!Number.isFinite(since)) return undefined;
  const moments = wait.parkedAt !== undefined
    ? [Date.parse(wait.parkedAt) + DESIGN_REVIEW_CLOSE_AFTER_PARKED_MS]
    : [...DESIGN_REVIEW_REMIND_AFTER_HOURS.map((hours) => since + hours * HOUR_MS), since + DESIGN_REVIEW_PARK_AFTER_MS];
  return moments.filter((moment) => Number.isFinite(moment) && moment > nowMs).sort((left, right) => left - right)[0];
}

/** The notice a step sends, by name. */
export const noticeStepOf = (step: Exclude<DesignWaitStep, { kind: "none" }>): DesignWaitNoticeStep =>
  step.kind === "remind" ? (step.hours === 24 ? "24h" : "72h") : step.kind === "park" ? "parked" : "closed";
