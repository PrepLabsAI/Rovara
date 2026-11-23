// The retired workflow's additional thread moments, using its message builders and the core's
// company/member checks and durable notice claims. Re-read on every session refresh: a failed
// post is retried even when the summary did not change, and an old event never narrates an old step.
import { isPlanUnreadableBlockReason, type OrgId, type RichMessage, type WorkflowSnapshot } from "@agentx/contracts";
import { workflowMessage, workflowMessageKey, type WorkflowMessageContext } from "../../developer/workflow-messages.js";
import { AutoFixAskSchema } from "../../developer/autofix-messages.js";
import { planRevisionsUsed } from "../../developer/plan-self-check.js";
import { PLAN_UNREADABLE_CATEGORIES, planUnreadableCategory } from "../../developer/plan-check-summary.js";
import type { TaskRecord } from "../task-flow/records.js";
import { taskKey } from "../task-flow/keys.js";
import { readTaskThread } from "./threads.js";
import { threadSender, type ThreadNoticeDeps } from "./thread-notices.js";

export function workflowThreadRefresh(deps: Pick<ThreadNoticeDeps, "store" | "registry" | "now" | "companyOf" | "isMember" | "log" | "taskUrl" | "milestones"> & { companyId: OrgId; messageOf: (message: { text: string; blocks: unknown[] }) => RichMessage | undefined }) {
  const sender = threadSender(deps);
  return async (orgId: OrgId, sessionId: string, taskId: string): Promise<void> => {
    if (orgId !== deps.companyId) return;
    const task = await deps.store.get(taskKey(taskId));
    if (task === undefined || (task["companyId"] ?? task["orgId"]) !== orgId || task["closedAt"] !== undefined || task["sessionId"] !== sessionId) return;
    const workflow = task["workflow"] as WorkflowSnapshot | undefined;
    if (workflow === undefined || workflow.revision === 1) return;
    // DEC 254zzz398 (4): a finished PR feedback review with findings waits for the owner. A request for a person is not one of the milestone lines the host's switch mutes.
    const ready = feedbackReadyOf(workflow);
    if (ready === undefined && (existingMoment(workflow) || milestonesOff(deps.milestones))) return;
    const thread = await readTaskThread(deps.store, orgId, sessionId);
    if (thread === undefined) return;
    const adapter = await sender.reach(orgId, thread);
    if (adapter === undefined) return;
    const taskPageUrl = deps.taskUrl?.(taskId, { sessionId, ...(typeof task["project"] === "string" ? { project: task["project"] } : {}) });
    const notice = noticeOf(task as unknown as TaskRecord, workflow, taskPageUrl, ready);
    if (notice === undefined) return;
    const data = deps.messageOf(notice.message);
    if (data === undefined) throw new Error("workflow thread message is unreadable");
    await sender.send(orgId, sessionId, notice.key, () => adapter.deliver({ version: 1, id: notice.id, channel: thread.conversation.channel,
      conversation: thread.conversation, createdAt: new Date(deps.now()).toISOString(), type: "message", data }));
  };
}

const milestonesOff = (milestones: ThreadNoticeDeps["milestones"]): boolean => (typeof milestones === "function" ? !milestones() : milestones === false);

/** The message of the moment, its claim key (one claim per session and key: the dedupe) and its event id. A review that is ready for the owner is told once per review report; any other step once per workflow key. */
function noticeOf(task: TaskRecord, workflow: WorkflowSnapshot, taskPageUrl: string | undefined, ready: FeedbackReady | undefined) {
  if (ready !== undefined) return { message: feedbackReadyNotice(ready, taskPageUrl), key: `feedback_ready#${ready.reviewDigest}`, id: `feedback_ready_${task.taskId}_${ready.reviewDigest.slice(0, 32)}` };
  const context = workflowContext(task, workflow, taskPageUrl);
  const message = coreWorkflowNotice(context);
  if (message === undefined) return undefined;
  return { message, id: `workflow_${task.taskId}_${workflow.revision}`,
    key: `workflow#${workflowMessageKey(workflow, { planAutoRevisions: context.planGroundingHeld === true ? 0 : autoRevisions(task, workflow) })}` };
}

interface FeedbackReady { reviewDigest: string; findings: number; pullRequests: number[] }
/** A complete PR feedback review with findings that waits for the owner's decision, by its report (one per review, so one notice per round). A failed, kept, decided or finding-less one is none. */
function feedbackReadyOf(workflow: WorkflowSnapshot): FeedbackReady | undefined {
  const review = workflow.feedbackReview;
  if (workflow.stage !== "WAIT_FOR_MERGE" || workflow.state !== "WAITING" || review?.status !== "PENDING" || review.reviewRef.status !== "COMPLETE" || review.reviewRef.findingRefs.length === 0) return undefined;
  return { reviewDigest: review.reviewRef.sha256, findings: review.reviewRef.findingRefs.length, pullRequests: review.bundleRefs.map(bundle => bundle.number).sort((a, b) => a - b) };
}
function feedbackReadyNotice(ready: FeedbackReady, taskPageUrl: string | undefined) {
  const names = ready.pullRequests.map(number => `PR #${String(number)}`).join(", ");
  const page = taskPageUrl === undefined ? "Open the task page" : `Open the task page: ${taskPageUrl}`;
  const text = `The review of the feedback on ${names} is ready. ${ready.findings === 1 ? "1 finding waits" : `${String(ready.findings)} findings wait`} for your decision: choose what to fix, or keep the pull request as it is. ${page}`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}

// Retired workflow actions refuse core-owned tasks. Keep their words and task-page
// navigation, but offer no controls until the core can honour them.
function coreWorkflowNotice(context: WorkflowMessageContext) {
  const message = workflowMessage(context);
  if (message === undefined) return undefined;
  const page = context.taskPageUrl === undefined ? "" : `\nOpen the task page to act: ${context.taskPageUrl}`;
  return { text: message.text + page, blocks: [
    ...message.blocks.filter((block) => block["type"] !== "actions"),
    ...(page === "" ? [] : [{ type: "section", text: { type: "mrkdwn", text: page.trim() } }]),
  ] };
}

function existingMoment(workflow: WorkflowSnapshot): boolean {
  return workflow.stage === "MERGED" || workflow.stage === "CLOSED"
    || (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") || (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING" && !(workflow.pullRequests ?? []).some((pr) => pr.required && pr.state === "MERGED"));
}

function workflowContext(task: TaskRecord, workflow: WorkflowSnapshot, taskPageUrl?: string): WorkflowMessageContext {
  const context: WorkflowMessageContext = { taskId: task.taskId, workflow, taskPageUrl, ...(taskPageUrl === undefined ? {} : { findingsUrl: `${taskPageUrl}#findings` }) };
  if (workflow.stage === "PLAN" && workflow.state === "RUNNING" && task.planGrounding !== undefined && task.planGroundingAbandoned !== task.planGrounding.artifactSha256) context.planGroundingHeld = true;
  if (workflow.state !== "BLOCKED") return context;
  if (workflow.stage === "VERIFY" || workflow.stage === "REVIEW") {
    const ask = AutoFixAskSchema.safeParse(task.autofixAsk);
    context.autoFix = { ask: ask.success ? ask.data : undefined };
  }
  if (workflow.stage === "PLAN" && isPlanUnreadableBlockReason(workflow.blockReason) && task.planUnreadable?.workflowRevision === workflow.revision) unreadableContext(context, task);
  return context;
}
function unreadableContext(context: WorkflowMessageContext, task: TaskRecord): void {
  const unreadable = task.planUnreadable!;
  const category = unreadable.category;
  context.planUnreadableCategory = category !== undefined && PLAN_UNREADABLE_CATEGORIES.includes(category) ? category : planUnreadableCategory(unreadable.errors);
  if (unreadable.autoRetried === true) context.planUnreadableAutoRetried = true;
}
function autoRevisions(task: TaskRecord, workflow: WorkflowSnapshot): number {
  if (workflow.stage !== "PLAN" || workflow.state !== "RUNNING") return 0;
  const type = workflow.path === "FULL" && workflow.reviewPhase === "REQUIREMENTS" ? "requirements" : workflow.path === "FULL" && workflow.reviewPhase === "DESIGN" ? "design" : "plan";
  return planRevisionsUsed(task.planSelfCheck, type, workflow.artifacts.filter((entry) => entry.type === type).length + 1);
}
