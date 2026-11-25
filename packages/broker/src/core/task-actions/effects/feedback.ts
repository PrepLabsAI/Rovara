// S1: the owner's choices on PR feedback, as registry effects: fix the recommended findings (or the ones the owner picks), dismiss the comments and keep the pull request, answer in the owner's own words (the engine's
// REQUEST_CHANGES decision with `ownerNote`, which the web card never sent), and retry a feedback review that did not finish. Each is ONE call into `decidePrFeedback` / `retryPrFeedback`, with the digests the engine's own
// view names (never the surface's), so a card that is out of date is refused by the engine as the web's is.
import { WORKFLOW_KEEP_PULL_REQUESTS_NOTE, type ActionBinding } from "@agentx/contracts";
import { readPrFeedbackView } from "../../../core-host/pr-feedback-view.js";
import { decidePrFeedback, retryPrFeedback } from "../../pr-feedback/decide.js";
import type { TaskRecord } from "../../task-flow/records.js";
import type { ActionEnv, ActionCaller, Description, PressContext, Performed } from "../types.js";
import { inert, listOf, requiredText, staleRefusal } from "./values.js";
import { taskIsOpen } from "./moves.js";

/** A feedback review that finished and waits for the owner's choice. */
function pendingReview(task: TaskRecord) {
  const review = task.workflow?.feedbackReview;
  return taskIsOpen(task) && task.workflow?.stage === "WAIT_FOR_MERGE" && review?.status === "PENDING" ? review : undefined;
}

const choiceBinding = (task: TaskRecord): ActionBinding | undefined => {
  const review = pendingReview(task);
  return review?.reviewRef.status === "COMPLETE" && review.reviewRef.findingRefs.length > 0 ? { revision: task.workflow!.revision, digest: review.reviewRef.sha256 } : undefined;
};
export const feedbackChoiceWhen = choiceBinding;

/** A feedback review that could not finish: the same comments are reviewed again. */
export const feedbackRetryWhen = (task: TaskRecord): ActionBinding | undefined => {
  const review = pendingReview(task);
  return review !== undefined && review.reviewRef.status !== "COMPLETE" ? { revision: task.workflow!.revision, digest: review.reviewRef.sha256 } : undefined;
};

type FeedbackView = { reviewDigest: string; proposalDigest: string; bundleDigests: string[]; findings: Array<{ id: string; recommended: boolean; priority?: string; fixProposal?: { summary?: string } }> };
async function viewOf(ctx: Pick<PressContext, "deps" | "caller" | "task" | "binding">): Promise<FeedbackView> {
  const view = await readPrFeedbackView(ctx.deps, ctx.caller, ctx.task.taskId) as unknown as Partial<FeedbackView>;
  if (view.reviewDigest !== ctx.binding.digest || view.proposalDigest === undefined || view.bundleDigests === undefined || view.findings === undefined) throw staleRefusal("this review changed");
  return view as FeedbackView;
}

export async function describeFix(env: ActionEnv, caller: ActionCaller, task: TaskRecord, binding: ActionBinding): Promise<Description> {
  const view = await viewOf({ deps: env.deps, caller, task, binding });
  const options = view.findings.slice(0, 100).map((finding, index) => ({
    value: finding.id, label: inert(`${finding.priority === undefined ? "" : `${finding.priority.replace(/_/gu, " ").toLowerCase()}: `}${finding.fixProposal?.summary ?? `finding ${String(index + 1)}`}`, 110), selected: finding.recommended,
  }));
  return { spec: { fields: [{ kind: "pick-many", id: "findings", label: "What to fix (a fix costs a paid round)", min: 1, max: Math.min(100, options.length), options }] } };
}

export async function performFix(ctx: PressContext): Promise<Performed> {
  const view = await viewOf(ctx);
  const known = new Set(view.findings.map((finding) => finding.id));
  const selected = listOf(ctx.values, "findings").filter((id) => known.has(id));
  const chosen = selected.length > 0 ? selected : view.findings.filter((finding) => finding.recommended).map((finding) => finding.id);
  await decidePrFeedback(ctx.deps, ctx.caller, ctx.task.taskId, {
    requestId: ctx.requestId, expectedRevision: ctx.binding.revision, reviewDigest: view.reviewDigest, proposalDigest: view.proposalDigest, bundleDigests: view.bundleDigests, decision: "APPROVE", selectedFindingIds: chosen,
  });
  return { status: "started" };
}

export async function performDismiss(ctx: PressContext): Promise<Performed> {
  const view = await viewOf(ctx);
  await decidePrFeedback(ctx.deps, ctx.caller, ctx.task.taskId, {
    requestId: ctx.requestId, expectedRevision: ctx.binding.revision, reviewDigest: view.reviewDigest, proposalDigest: view.proposalDigest, bundleDigests: view.bundleDigests, decision: "DISMISS", selectedFindingIds: [], ownerNote: WORKFLOW_KEEP_PULL_REQUESTS_NOTE,
  });
  return { status: "done" };
}

export const describeAnswer = async (): Promise<Description> => ({ spec: { fields: [{ kind: "text", id: "note", label: "Your answer (the feedback is reviewed again)", required: true, max: 2_000, multiline: true }] } });

export async function performAnswer(ctx: PressContext): Promise<Performed> {
  const note = requiredText(ctx.values, "note", "your answer");
  const view = await viewOf(ctx);
  await decidePrFeedback(ctx.deps, ctx.caller, ctx.task.taskId, {
    requestId: ctx.requestId, expectedRevision: ctx.binding.revision, reviewDigest: view.reviewDigest, proposalDigest: view.proposalDigest, bundleDigests: view.bundleDigests, decision: "REQUEST_CHANGES", selectedFindingIds: [], ownerNote: note,
  });
  return { status: "started" };
}

export async function performRetryReview(ctx: PressContext): Promise<Performed> {
  const digest = ctx.binding.digest;
  if (digest === undefined) throw staleRefusal("this review changed");
  const result = await retryPrFeedback(ctx.deps, ctx.caller, ctx.task.taskId, { reviewDigest: digest });
  return result.started ? { status: "started" } : { status: "replayed" };
}
