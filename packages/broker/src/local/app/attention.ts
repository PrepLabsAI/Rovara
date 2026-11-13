// Lane L12, slice 4: what the owner needs to see about a task besides its plan, in Rovara's fixed words: why it stopped and asks, where its pull request stands, what it is doing about it, and the questions it waits on.
// One reader for the task page and for the session views (the sessions' "step" and status), so they cannot say different things. A name from CI or a worker is redacted and flattened to one line; no sentence here is
// a worker's or a person's.
import {
  CI_FIX_ROUNDS_MAX, CI_STATE_WORDS, CONFLICT_ROUNDS_MAX, WORKFLOW_BLOCK_REASONS, redactText, workflowFixRounds,
  type MergeTrackingItem, type TaskStatus, type WorkflowSnapshot,
} from "@agentx/contracts";
import type { AttentionView } from "../../core/local-pages/views.js";
import { DEFAULT_CI_MODE, ciCountsAsPassing, type ProjectCiMode } from "../../core/merge/merge-tracking.js";
import { readMergeTracking } from "../../core/merge/store.js";
import { CHANGED_OUTSIDE_NOTE } from "../../core/build-step/head-check.js";
import { pullRequestRecordOf } from "../../core/build-step/records.js";
import { AutoFixAskSchema, autoFixAskReasonSentence, autoFixCodeSentence } from "../../developer/autofix-messages.js";
import type { TaskFlowDeps } from "../../core/task-flow/deps.js";
import type { TaskRecord } from "../../core/task-flow/records.js";

const line = (text: string, max = 200): string => Array.from(redactText(text).replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim()).slice(0, max).join("");
/** The stages whose blocked step the owner can run again from the page. */
const RETRY_STAGES = new Set(["UNDERSTAND", "PLAN", "PLAN_CRITIQUE", "IMPLEMENT", "VERIFY", "REVIEW", "PULL_REQUEST"]);

export const retryableBlock = (workflow: WorkflowSnapshot): boolean =>
  workflow.state === "BLOCKED" && (RETRY_STAGES.has(workflow.stage) || (workflow.stage === "WAIT_FOR_MERGE" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed));

/** Whether a pull request is ready for a person to merge, from what tracking read (the same words the session says). */
export function readyToMerge(item: Pick<MergeTrackingItem, "state" | "draft" | "ci" | "review" | "branch" | "headByRovara">, ciMode: ProjectCiMode = DEFAULT_CI_MODE): boolean {
  // A review that was asked for and has not come is not "ready": ready needs the reviews approved, or none asked for.
  return item.state === "open" && !item.draft && ciCountsAsPassing(item.ci, ciMode) && (item.review === "approved" || item.review === "not_requested") && item.branch !== "conflicted" && item.headByRovara;
}

const CI_WORDS: Record<MergeTrackingItem["ci"], string> = { none: `${CI_STATE_WORDS.none}: no checks run on it`, unreadable: CI_STATE_WORDS.unreadable, pending: "its checks are running", passing: "its checks pass", failing: "its checks are failing" };
const REVIEW_WORDS: Record<MergeTrackingItem["review"], string> = { not_requested: "no review asked for yet", requested: "waiting for a review", approved: "approved", changes_requested: "changes were requested" };

export interface TaskAttention {
  view: AttentionView;
  /** The one line the sessions show for the step (absent: the plan stages' own words apply). */
  step?: string;
  /** The status model's words, when the pull request or an ask changes what the default would say. */
  display?: TaskStatus;
}

/** What the owner sees and answers, and the words the sessions use, for one task. */
export async function attentionOf(deps: Pick<TaskFlowDeps, "store" | "companyId">, task: TaskRecord, options: { ciMode?: ProjectCiMode } = {}): Promise<TaskAttention> {
  const workflow = task.workflow;
  if (workflow === undefined) return { view: {} };
  const view: AttentionView = {};
  let step: string | undefined;
  let display: TaskStatus | undefined;

  // ---- Rovara's ask
  if (workflow.state === "BLOCKED") {
    const ask = AutoFixAskSchema.safeParse(task.autofixAsk);
    const current = ask.success && ask.data.workflowRevision === workflow.revision ? ask.data : undefined;
    const lines = [
      ...(workflow.blockReason === undefined ? [] : [line(workflow.blockReason, 400)]),
      ...(current === undefined ? [] : [`Why I'm asking you: ${autoFixAskReasonSentence(current.reason, current.capUsd)}`, ...current.codes.slice(0, 5).map((code) => autoFixCodeSentence(code))]),
    ];
    if (lines.length > 0) view.ask = { lines, retry: retryableBlock(workflow) };
    display = { state: "needs_you", reason: current === undefined ? "the task is blocked" : autoFixAskReasonSentence(current.reason, current.capUsd), next: retryableBlock(workflow) ? "Retry the step from the task page, or ask for changes." : "Look at the task page." };
  }

  // ---- questions
  const asked = workflow.intent?.assessment;
  if (workflow.stage === "UNDERSTAND" && workflow.state === "WAITING" && asked?.kind === "questions" && workflow.intent !== undefined) {
    view.questions = { round: workflow.intent.rounds, items: asked.questions.map((question) => ({ id: question.id, text: question.text, options: (question.options ?? []).map((option) => ({ id: option.id, label: option.label })) })) };
  }

  // ---- the pull request
  if ((workflow.pullRequests ?? []).length > 0 && workflow.stage !== "MERGED" && workflow.stage !== "CLOSED") {
    const items = await readMergeTracking(deps.store, task.taskId, deps.companyId).catch(() => []);
    const lines: string[] = [];
    const rounds = workflowFixRounds(workflow);
    if (workflow.fixSource === "ci" && workflow.state !== "BLOCKED") lines.push(`Rovara is fixing failing checks (round ${String(rounds.ci)} of ${String(CI_FIX_ROUNDS_MAX)}).`);
    else if (workflow.fixSource === "conflict" && workflow.state !== "BLOCKED") lines.push(`Rovara is resolving a conflict with the base branch (round ${String(rounds.conflict)} of ${String(CONFLICT_ROUNDS_MAX)}).`);
    for (const pullRequest of workflow.pullRequests ?? []) {
      const item = items.find((entry) => entry.repositoryId === pullRequest.repositoryId && entry.number === pullRequest.number);
      const record = await pullRequestRecordOf(deps, task.workspaceId, pullRequest.repositoryId, pullRequest.number);
      const name = `${line(pullRequest.repositoryId, 80)} pull request #${String(pullRequest.number)}`;
      if (pullRequest.state === "MERGED") { lines.push(`${name}: merged.`); continue; }
      if (item === undefined) { lines.push(`${name}: not read yet.`); continue; }
      const failing = item.ci === "failing" && item.failingChecks.length > 0 ? `: ${item.failingChecks.slice(0, 3).map((name_) => line(name_, 60)).join(", ")}` : "";
      lines.push(`${name}: ${item.state === "open" ? (item.draft ? "a draft" : "ready for review") : item.state}; ${CI_WORDS[item.ci]}${failing}; ${REVIEW_WORDS[item.review]}; ${item.branch === "conflicted" ? "it conflicts with its base" : item.branch === "behind" ? "it is behind its base" : "it is up to date with its base"}.`);
      if (!item.headByRovara) lines.push("Someone else pushed to it, so Rovara has stopped changing it and only watches.");
      if (record?.changedOutside !== undefined) lines.push(`${CHANGED_OUTSIDE_NOTE.charAt(0).toUpperCase()}${CHANGED_OUTSIDE_NOTE.slice(1)}.`);
    }
    const ready = items.length > 0 && items.length === (workflow.pullRequests ?? []).length && items.every((entry) => readyToMerge(entry, options.ciMode)) && workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING";
    if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING") {
      lines.push(ready ? "Ready to merge. Rovara never merges by itself: a person merges it on the code host." : "Rovara is watching it. It is not ready to merge yet.");
      if (!ready && workflow.state === "WAITING") {
        const failing = items.some((entry) => entry.ci === "failing");
        step = failing ? "Waiting to fix failing checks" : items.some((entry) => entry.ci === "unreadable") ? "CI not readable" : items.some((entry) => entry.ci === "none" && entry.draft) ? "No CI on this repository: left as a draft" : items.some((entry) => entry.ci === "pending" || entry.draft) ? "Waiting for the pull request's checks" : items.some((entry) => entry.review === "changes_requested") ? "Changes requested on the pull request" : items.some((entry) => entry.review === "requested") ? (items.some((entry) => entry.ci === "none") ? "No CI on this repository; waiting for a review" : "Checks pass; waiting for a review") : "Watching the pull request";
        display = { state: "checking", reason: step.toLowerCase(), next: "Rovara keeps watching; it tells you when the pull request is ready to merge." };
      } else {
        step = "Ready to merge";
        display = { state: "ready_to_merge", next: "Review the pull request and merge it on the code host." };
      }
    } else if (workflow.state !== "BLOCKED") {
      step = workflow.fixSource === "ci" ? "Fixing failing checks" : workflow.fixSource === "conflict" ? "Resolving a conflict" : undefined;
    }
    if (lines.length > 0) view.merge = { lines };
  }
  return { view, ...(step === undefined ? {} : { step }), ...(display === undefined ? {} : { display }) };
}
