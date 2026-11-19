// Trust fix A2: what a person reads about the model that reviewed the code, in the task's message and the pull request's Reviews section. The model is the one the review report records (the
// worker names the model its reviewer sessions ran on); the note says so when review used the build's own model. A model name is a report's text, so each line passes through the caller's
// inert helper before it is shown.
import { redactText, type WorkflowSnapshot } from "@agentx/contracts";

/**
 * Whether the reviews of the workflow's current code ran on the build's own model. The broker keeps this on the task record beside the workflow (`reviewSameModel`, naming the code it is about), never in the
 * workflow: a stored review is a strict record, and one with a key an older broker does not know would not parse after a rollback.
 */
export function reviewSameModelOf(task: { reviewSameModel?: { candidateDigest: string } | undefined }, workflow: Pick<WorkflowSnapshot, "candidate">): boolean {
  return task.reviewSameModel !== undefined && (workflow.candidate === undefined || task.reviewSameModel.candidateDigest === workflow.candidate.digest);
}

/** The model the reviews of the workflow's current code ran on when none of another company than the build's was usable (`reviewNoOtherCompany` on the task record), else undefined. */
export function reviewNoOtherCompanyOf(task: { reviewNoOtherCompany?: { candidateDigest: string; model: { provider: string; modelId: string } } | undefined }, workflow: Pick<WorkflowSnapshot, "candidate">): { provider: string; modelId: string } | undefined {
  const flag = task.reviewNoOtherCompany;
  return flag !== undefined && (workflow.candidate === undefined || flag.candidateDigest === workflow.candidate.digest) ? flag.model : undefined;
}

/** Said when the project (or the account) offered no model but the build's for the review. */
export const REVIEW_SAME_MODEL_NOTE = "Review used the same model as Build. Enable another model for an independent review.";

/** Said (owner decision 2026-11-02) when the reviews' default is another company's model than the build's and none was usable, so they ran on the build's own company. Fixed words; the model is a report's text, so the caller makes the line inert. */
export const reviewNoOtherCompanyLine = (model: { provider: string; modelId: string }): string => `Review uses ${redactText(`${model.provider}/${model.modelId}`).replace(/\s+/gu, " ").trim().slice(0, 80)} (same company as the builder: no other company's model is available)`;

const ROLE_WORD = { CRITIC: "code review", SECURITY: "security review" } as const;
const MODEL_MAX = 80;

const modelName = (review: { provider: string; version: string }): string => redactText(`${review.provider}/${review.version}`).replace(/\s+/gu, " ").trim().slice(0, MODEL_MAX);

/**
 * The lines about the reviewer model for the current code of a Rovara Code (version 2) task: one line naming the model of each review, and the same-model note when `sameModel` says the reviews of this code
 * used the build's model (`reviewSameModelOf`). Nothing for a version 1 task, or before any review of the current code. Each line is for the caller to make inert (`inertLine` for GitHub, `cleanLine` for Slack).
 */
export function reviewModelLines(workflow: Pick<WorkflowSnapshot, "definitionVersion" | "candidate" | "reviews">, sameModel: boolean): string[] {
  if (workflow.definitionVersion !== "1.1.0") return [];
  const current = (workflow.reviews ?? []).filter((review) => workflow.candidate === undefined || review.candidateDigest === workflow.candidate.digest);
  if (current.length === 0) return [];
  const ordered = (["CRITIC", "SECURITY"] as const).flatMap((role) => current.filter((review) => review.role === role));
  const names = new Set(ordered.map(modelName));
  const line = names.size === 1 ? `Reviewed by ${[...names][0]!}` : `Reviewed by ${ordered.map((review) => `${ROLE_WORD[review.role]}: ${modelName(review)}`).join("; ")}`;
  return [line, ...(sameModel ? [REVIEW_SAME_MODEL_NOTE] : [])];
}
