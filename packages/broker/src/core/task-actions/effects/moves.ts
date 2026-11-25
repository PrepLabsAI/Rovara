// S1: the owner's simple moves as registry effects: stop, retry a step, retry the reviews, send back to coding, keep the pull request, and the free-form ones (continue, open a pull request by hand). Each `perform` is ONE call into
// the function the web and the AI tools already use; nothing is rewritten here, and the surface is told only what the move did.
import {
  WORKFLOW_BLOCK_REASONS, agentXError, isRunLimitBlockReason, workflowKeepPullRequestsOffered, workflowPublicationRetryable, workflowReviewRetryOffered, workflowSendBackOffered, workflowStepRetryOffered,
  type ActionBinding, type InputField, type WorkflowSnapshot,
} from "@agentx/contracts";
import { runParityTaskAction } from "../../../core-host/parity-task-actions.js";
import { keepPrFeedback } from "../../pr-feedback/keep.js";
import { startManualPublication } from "../../task-flow/manual-publication.js";
import { reviewTaskOnRequest } from "../../task-flow/manual-review.js";
import { stopTaskOnRequest } from "../../task-flow/stop-request.js";
import { createTaskActions } from "../../task-flow/task-actions.js";
import type { TaskRecord } from "../../task-flow/records.js";
import { readWorkspace } from "../../task-flow/stage-machine.js";
import type { ActionEnv, Description, PressContext, Performed } from "../types.js";
import { inert, listOf, textOf } from "./values.js";

const RETRY_WORDS = "Retry the blocked workflow step.";
export const SEND_BACK_DEFAULT = "Fix the review findings.";

/** A task still open (closed tasks offer nothing but their own record). */
export const taskIsOpen = (task: TaskRecord): boolean => task.closedAt === undefined;
/** A workflow task the person's retry is not held back for (a run limit or a budget pause is lifted only by its own approval). */
export const spendIsNotBlocking = (workflow: WorkflowSnapshot): boolean => !(workflow.state === "BLOCKED" && (workflow.blockReason === WORKFLOW_BLOCK_REASONS.budgetPaused || isRunLimitBlockReason(workflow.blockReason)));

const bindingOf = (workflow: WorkflowSnapshot, digest?: string): ActionBinding => ({ revision: workflow.revision, ...(digest === undefined ? {} : { digest }) });

// ---- stop

export const stopWhen = (task: TaskRecord): ActionBinding | undefined =>
  // A stop is the same whatever step runs: its card never goes stale because a step moved on (so the Stop button a card carries needs no revision).
  taskIsOpen(task) && (task.workflow === undefined || task.workflow.state === "RUNNING") ? { revision: 0 } : undefined;

export async function performStop(ctx: PressContext): Promise<Performed> {
  const result = await stopTaskOnRequest(ctx.deps, ctx.caller, ctx.task.taskId, () => ({ requestId: ctx.requestId }));
  if (result.repeated) return { status: "replayed" };
  return result.nothingRunning === true ? { status: "done", said: "Nothing was running." } : { status: "done" };
}

// ---- retry a step (planning, coding, checks, the pull request, a failed push)

/** The kinds of retry: the checks (with the owner's choice), the pull request opened again, any other stopped step. A stopped review is `task.review`. */
export type RetryKind = "checks" | "publish" | "step";
export function retryKindOf(workflow: WorkflowSnapshot): RetryKind | undefined {
  if (!spendIsNotBlocking(workflow)) return undefined;
  if (workflowPublicationRetryable(workflow) && workflow.candidate !== undefined) return "publish";
  if (!workflowStepRetryOffered(workflow)) return undefined;
  return workflow.stage === "VERIFY" ? "checks" : "step";
}

export const stepRetryWhen = (task: TaskRecord): ActionBinding | undefined =>
  taskIsOpen(task) && task.workflow !== undefined && retryKindOf(task.workflow) !== undefined ? bindingOf(task.workflow) : undefined;

/** The checks the owner may choose for a retry of verification: the project's approved optional checks, those the plan proposed are kept. */
export function checkChoiceOf(workflow: WorkflowSnapshot): InputField | undefined {
  const policy = workflow.checkPolicy;
  if (policy === undefined || policy.optional.length === 0) return undefined;
  return { kind: "pick-many", id: "checks", label: "Optional checks to run", min: 0, max: Math.min(100, policy.optional.length),
    options: policy.optional.map((check) => ({ value: check.id, label: inert(check.label, 100), selected: policy.selectedOptionalIds.includes(check.id) })) };
}

export async function describeStepRetry(_env: ActionEnv, task: TaskRecord): Promise<Description> {
  const choice = task.workflow === undefined || retryKindOf(task.workflow) !== "checks" ? undefined : checkChoiceOf(task.workflow);
  return { spec: { fields: choice === undefined ? [] : [choice] } };
}

export async function performStepRetry(ctx: PressContext): Promise<Performed> {
  const workflow = ctx.task.workflow;
  const kind = workflow === undefined ? undefined : retryKindOf(workflow);
  if (workflow === undefined || kind === undefined) throw agentXError("TASK_ACTION_NOT_OFFERED", "there is nothing to retry now", { reason: "not_offered", writes: "none" });
  const body = { requestId: ctx.requestId, expectedRevision: workflow.revision };
  const options = ctx.env.options;
  if (kind === "publish") await runParityTaskAction(ctx.deps, options, ctx.caller, ctx.task.taskId, "workflow/publish-retry", body);
  else {
    const chosen = kind === "checks" && ctx.values["checks"] !== undefined ? { selectedOptionalCheckIds: listOf(ctx.values, "checks") } : {};
    await runParityTaskAction(ctx.deps, options, ctx.caller, ctx.task.taskId, "workflow/retry", { ...body, instructions: RETRY_WORDS, ...chosen });
  }
  return { status: "started" };
}

// ---- retry the reviews (a stopped review, with an optional note)

export const reviewWhen = (task: TaskRecord): ActionBinding | undefined =>
  taskIsOpen(task) && task.workflow !== undefined && workflowReviewRetryOffered(task.workflow) && spendIsNotBlocking(task.workflow) ? bindingOf(task.workflow, task.workflow.candidate?.digest) : undefined;

export const describeReview = async (): Promise<Description> => ({ spec: { fields: [{ kind: "text", id: "note", label: "Anything the reviewers should know (optional)", required: false, max: 1_000, multiline: true }] } });

export async function performReview(ctx: PressContext): Promise<Performed> {
  const workflow = ctx.task.workflow!;
  const note = textOf(ctx.values, "note");
  await reviewTaskOnRequest(ctx.deps, ctx.env.options, ctx.caller, ctx.task.taskId, {
    requestId: ctx.requestId, instructions: note === "" ? RETRY_WORDS : note, expectedRevision: workflow.revision, candidateDigest: workflow.candidate!.digest,
  });
  return { status: "started" };
}

// ---- send back to coding

export const sendBackWhen = (task: TaskRecord): ActionBinding | undefined =>
  taskIsOpen(task) && task.workflow !== undefined && task.purpose === undefined && spendIsNotBlocking(task.workflow) && workflowSendBackOffered(task.workflow) ? bindingOf(task.workflow) : undefined;

export const describeSendBack = async (): Promise<Description> => ({ spec: { fields: [{ kind: "text", id: "instructions", label: "What should coding do?", required: false, max: 1_000, multiline: true, initial: SEND_BACK_DEFAULT }] } });

export async function performSendBack(ctx: PressContext): Promise<Performed> {
  const instructions = textOf(ctx.values, "instructions") || SEND_BACK_DEFAULT;
  await createTaskActions(ctx.deps, ctx.env.options).sendBack(ctx.caller, ctx.task.taskId, { requestId: ctx.requestId, instructions, expectedRevision: ctx.binding.revision });
  return { status: "started" };
}

// ---- keep the pull request as it is (after an approved fix changed nothing, or while the feedback review is collecting)

export const keepWhen = (task: TaskRecord): ActionBinding | undefined => {
  const workflow = task.workflow;
  if (!taskIsOpen(task) || workflow === undefined) return undefined;
  const collecting = workflow.stage === "WAIT_FOR_MERGE" && workflow.feedbackReview?.status === "COLLECTING";
  return workflowKeepPullRequestsOffered(workflow) || collecting ? bindingOf(workflow) : undefined;
};

export async function performKeep(ctx: PressContext): Promise<Performed> {
  await keepPrFeedback(ctx.deps, ctx.caller, ctx.task.taskId, { requestId: ctx.requestId, expectedRevision: ctx.binding.revision });
  return { status: "done" };
}

// ---- the free-form moves of a task with no workflow (more instructions, a pull request by hand)

export const continueWhen = (task: TaskRecord): ActionBinding | undefined =>
  taskIsOpen(task) && task.workflow === undefined && task.purpose === undefined ? { revision: 0 } : undefined;

export const describeContinue = async (): Promise<Description> => ({ spec: { fields: [{ kind: "text", id: "instructions", label: "More instructions", required: true, max: 3_000, multiline: true }] } });

export async function performContinue(ctx: PressContext): Promise<Performed> {
  await createTaskActions(ctx.deps, ctx.env.options).continue(ctx.caller, ctx.task.taskId, { requestId: ctx.requestId, instructions: textOf(ctx.values, "instructions") });
  return { status: "started" };
}

export const openPullRequestWhen = continueWhen;

export async function describePullRequest(env: ActionEnv, task: TaskRecord): Promise<Description> {
  const workspace = await readWorkspace(env.deps, task.workspaceId);
  const project = workspace === undefined ? undefined : await env.deps.projects.revision(workspace.projectName, workspace.projectRevision);
  const repositories = project?.definition.repositories ?? [];
  return { spec: { fields: [
    { kind: "text", id: "title", label: "Title", required: true, max: 256 },
    { kind: "text", id: "body", label: "Description (optional)", required: false, max: 3_000, multiline: true },
    ...(repositories.length > 1 ? [{ kind: "choice" as const, id: "repository", label: "Repository", required: true, options: repositories.map((repository) => ({ value: repository.name, label: inert(repository.name, 100) })) }] : []),
  ] } };
}

export async function performPullRequest(ctx: PressContext): Promise<Performed> {
  const repository = textOf(ctx.values, "repository");
  const body = textOf(ctx.values, "body");
  await startManualPublication(ctx.deps, ctx.caller, ctx.task.taskId, {
    requestId: ctx.requestId, title: textOf(ctx.values, "title"), draft: true, ...(body === "" ? {} : { body }), ...(repository === "" ? {} : { repository }),
  });
  return { status: "started" };
}
