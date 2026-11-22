// The retired workflow's additional thread moments, using its message builders and the core's
// company/member checks and durable notice claims. Re-read on every session refresh: a failed
// post is retried even when the summary did not change, and an old event never narrates an old step.
import { WORKFLOW_BLOCK_REASONS, type OrgId, type RichMessage, type WorkflowSnapshot } from "@agentx/contracts";
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
    if (orgId !== deps.companyId || (typeof deps.milestones === "function" ? !deps.milestones() : deps.milestones === false)) return;
    const task = await deps.store.get(taskKey(taskId));
    if (task === undefined || (task["companyId"] ?? task["orgId"]) !== orgId || task["closedAt"] !== undefined || task["sessionId"] !== sessionId) return;
    const workflow = task["workflow"] as WorkflowSnapshot | undefined;
    if (workflow === undefined || workflow.revision === 1 || existingMoment(workflow)) return;
    const thread = await readTaskThread(deps.store, orgId, sessionId);
    if (thread === undefined) return;
    const adapter = await sender.reach(orgId, thread);
    if (adapter === undefined) return;
    const taskPageUrl = deps.taskUrl?.(taskId, { sessionId, ...(typeof task["project"] === "string" ? { project: task["project"] } : {}) });
    const context = workflowContext(task as unknown as TaskRecord, workflow, taskPageUrl);
    const message = coreWorkflowNotice(context);
    if (message === undefined) return;
    const key = `workflow#${workflowMessageKey(workflow, { planAutoRevisions: context.planGroundingHeld === true ? 0 : autoRevisions(task as unknown as TaskRecord, workflow) })}`;
    const data = deps.messageOf(message);
    if (data === undefined) throw new Error("workflow thread message is unreadable");
    await sender.send(orgId, sessionId, key, () => adapter.deliver({ version: 1, id: `workflow_${taskId}_${workflow.revision}`, channel: thread.conversation.channel,
      conversation: thread.conversation, createdAt: new Date(deps.now()).toISOString(), type: "message", data }));
  };
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
  if (workflow.stage === "PLAN" && workflow.blockReason === WORKFLOW_BLOCK_REASONS.planUnreadable && task.planUnreadable?.workflowRevision === workflow.revision) unreadableContext(context, task);
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
