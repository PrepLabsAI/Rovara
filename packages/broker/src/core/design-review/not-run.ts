// Design review stage: the one plain line that says a design review did not run, and why. It is shown on the task's page beside the design and put in the pull request's Proof section, in the same words, so a design
// that nobody reviewed is never taken for one that was. Fixed words only: the reason is a code the broker set, never text a model or a person wrote.
import type { WorkflowDesignReview } from "@agentx/contracts";

type NotRunReason = NonNullable<WorkflowDesignReview["notRunReason"]>;

const REASON_WORDS: Record<NotRunReason, string> = {
  no_model_source: "no model was available for it",
  no_verified_model: "no model could be verified for it",
  cost_declined: "no price is known for the model on this install, so its cost could not be held to a limit",
  timeout: "it took too long",
  worker_failed: "a step of it failed",
  inputs_unverified: "its inputs could not be verified",
  rearm_limit: "the design was sent back more often than a review is repeated",
  skipped: "it was skipped",
  cancelled: "it was cancelled",
  task_limit: "the task's own limit left no room for it",
  switched_off: "it was switched off",
};

/** "Design review did not run: <reason>", or undefined when the review ran (or there is none, or it ended some other way). */
export function designNotRunLine(review: Pick<WorkflowDesignReview, "status" | "notRunReason"> | undefined): string | undefined {
  if (review === undefined || review.status !== "not_run") return undefined;
  const reason = review.notRunReason === undefined ? undefined : REASON_WORDS[review.notRunReason];
  return reason === undefined ? "Design review did not run." : `Design review did not run: ${reason}.`;
}
