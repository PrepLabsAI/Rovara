// Slack ingress direct-invoke event shapes and type guards (extracted from aws/broker.ts).
import {
  SlackChannelIdSchema,
  SlackTeamIdSchema,
  WORKFLOW_RESOLVE_FINDINGS_MAX,
  slackBindingOf,
  type SlackChannelBinding,
  type SlackRequester,
  type SlackThread,
} from "@agentx/contracts";

export {
  SlackChannelIdSchema,
  SlackTeamIdSchema,
  slackBindingOf,
  type SlackChannelBinding,
  type SlackRequester,
  type SlackThread,
};

/**
 * The Slack ingress's stop command (#126): a thread's messages queue behind its running task, so a
 * "stop" in the thread is handled before the queue, here. Invoked by the ingress Lambda only, never
 * through API Gateway. Any member of the bound channel may stop the thread's task, as any member
 * may start one.
 */
export interface SlackStopTaskEvent {
  source: "agentx.slack-ingress";
  action: "stop-task";
  thread: SlackThread;
  userId: string;
}

export interface SlackWorkflowStartEvent {
  source: "agentx.slack-ingress";
  action: "start-workflow";
  thread: SlackThread;
  userId: string;
  instructions: string;
  workflowPath: "QUICK" | "FULL";
  requestId: string;
}

export interface SlackWorkflowDecisionEvent {
  source: "agentx.slack-ingress";
  action: "workflow-decision";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  artifactDigest: string;
  workBreakdownDigest?: string;
  decision: "APPROVE" | "REQUEST_CHANGES";
  reason: string;
  selectedOptionalCheckIds: string[];
}

export interface SlackWorkflowRetryEvent {
  source: "agentx.slack-ingress";
  action: "workflow-retry";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  selectedOptionalCheckIds: string[];
  /** The approved plan's proposed checks the owner kept; all of them when absent. */
  selectedProposedCheckIds?: string[];
  /** Task 16: which blocked step the owner retries; the checks when absent. */
  step?: "plan" | "coding";
}

/** Task 16: the owner's Send back to coding, from the task's own thread. */
export interface SlackWorkflowSendBackEvent {
  source: "agentx.slack-ingress";
  action: "workflow-send-back";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
}

/** The owner's answer for each blocking review finding (the Resolve findings form), from the task's own thread. */
export interface SlackWorkflowResolveFindingsEvent {
  source: "agentx.slack-ingress";
  action: "workflow-resolve-findings";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  candidateDigest: string;
  resolutions: Array<{ findingId: string; action: "ACCEPT" | "FIX"; note: string }>;
}

/** Task 16: the owner's confirmed Close task, from the task's own thread. */
export interface SlackWorkflowCloseEvent {
  source: "agentx.slack-ingress";
  action: "workflow-close";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  /** Decision 134: the Stop button of a request that started Quick on its own: a running step is cancelled before the close. */
  stop?: true;
}

export interface SlackWorkflowReviewRetryEvent {
  source: "agentx.slack-ingress";
  action: "workflow-review-retry";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
  candidateDigest: string;
}

export interface SlackWorkflowFeedbackFindingsDecisionEvent {
  source: "agentx.slack-ingress";
  action: "workflow-feedback-findings-decision";
  taskId: string; userId: string; thread: SlackThread; requestId: string; expectedRevision: number;
  reviewDigest: string; proposalDigest: string; bundleSetDigest: string;
  /** ANSWER: the owner's words answer the reviewer's questions shown on the card; they approve those findings only. */
  selection: "RECOMMENDED" | "ANSWER";
  /** ANSWER only: the findings whose questions the card showed (one to three). */
  questionFindingIds?: string[];
  decision: "APPROVE" | "REQUEST_CHANGES" | "DISMISS"; ownerNote?: string;
}

export interface SlackWorkflowFeedbackNoteEvent {
  source: "agentx.slack-ingress"; action: "feedback-note"; taskId: string; userId: string; thread: SlackThread;
  eventId: string; messageTs: string; text: string;
}

export interface SlackTaskAuthorizationEvent {
  source: "agentx.slack-ingress"; action: "task-people-authorize"; taskId: string; userId: string; thread: SlackThread;
  taskAction: "decide" | "retry" | "publish" | "feedback" | "close" | "control";
}

export interface SlackTaskPeopleConfirmEvent {
  source: "agentx.slack-ingress"; action: "task-people-confirm"; taskId: string; requestId: string; userId: string; thread: SlackThread;
}

export interface SlackTaskPeopleReadEvent {
  source: "agentx.slack-ingress"; action: "task-people-read"; taskId: string; userId: string; thread: SlackThread;
}

export interface SlackTaskPeopleChangeEvent {
  source: "agentx.slack-ingress"; action: "task-people-change"; taskId: string; requestId: string; expectedPeopleRevision: number;
  slackUserId: string; role: "owner" | "commenter" | "viewer" | "denied"; userId: string; thread: SlackThread;
}

export interface SlackTaskPeopleTakeOwnershipEvent {
  source: "agentx.slack-ingress"; action: "task-people-take-ownership"; taskId: string; requestId: string; expectedPeopleRevision: number;
  userId: string; thread: SlackThread;
}

export function slackTaskPeopleBase(event: unknown, action: SlackTaskPeopleReadEvent["action"] | SlackTaskPeopleChangeEvent["action"] | SlackTaskPeopleTakeOwnershipEvent["action"]): event is Record<string, unknown> {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === action && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.thread === "object" && value.thread !== null;
}

export const isSlackTaskPeopleReadEvent = (event: unknown): event is SlackTaskPeopleReadEvent => slackTaskPeopleBase(event, "task-people-read");

export const isSlackTaskPeopleChangeEvent = (event: unknown): event is SlackTaskPeopleChangeEvent => {
  if (!slackTaskPeopleBase(event, "task-people-change")) return false;
  return typeof event.requestId === "string" && Number.isSafeInteger(event.expectedPeopleRevision) && typeof event.slackUserId === "string"
    && (event.role === "owner" || event.role === "commenter" || event.role === "viewer" || event.role === "denied");
};

export const isSlackTaskPeopleTakeOwnershipEvent = (event: unknown): event is SlackTaskPeopleTakeOwnershipEvent => {
  if (!slackTaskPeopleBase(event, "task-people-take-ownership")) return false;
  return typeof event.requestId === "string" && Number.isSafeInteger(event.expectedPeopleRevision);
};

export function isSlackTaskPeopleConfirmEvent(event: unknown): event is SlackTaskPeopleConfirmEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "task-people-confirm" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.requestId === "string" && typeof value.userId === "string" && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackTaskAuthorizationEvent(event: unknown): event is SlackTaskAuthorizationEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "task-people-authorize" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.thread === "object" && value.thread !== null
    && ["decide", "retry", "publish", "feedback", "close", "control"].includes(String(value.taskAction));
}

export function isSlackWorkflowStartEvent(event: unknown): event is SlackWorkflowStartEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "start-workflow" && value.requestContext === undefined
    && typeof value.instructions === "string" && value.instructions.trim().length > 0
    && typeof value.requestId === "string" && (value.workflowPath === "QUICK" || value.workflowPath === "FULL");
}

/**
 * The Slack team of a Slack Lambda direct invoke (`source: agentx.slack-ingress`, never an HTTP request): its thread's team, or a core plan press's conversation tenant when the
 * press's actor names the same tenant (slackCorePress refuses any other press). Undefined for anything else.
 */
export function slackIngressThreadTeam(event: unknown): string | undefined {
  if (event === null || typeof event !== "object" || Array.isArray(event)) return undefined;
  const value = event as { source?: unknown; requestContext?: unknown; thread?: unknown; press?: unknown };
  if (value.source !== "agentx.slack-ingress" || value.requestContext !== undefined) return undefined;
  if (value.thread !== null && typeof value.thread === "object") {
    const team = (value.thread as { teamId?: unknown }).teamId;
    return typeof team === "string" ? team : undefined;
  }
  if (value.press === null || typeof value.press !== "object") return undefined;
  const press = value.press as { conversation?: { tenant?: unknown } | null; actor?: { tenant?: unknown } | null };
  const tenant = press.conversation?.tenant;
  return typeof tenant === "string" && press.actor?.tenant === tenant ? tenant : undefined;
}

/** Decision 134: a routed request as the Slack ingress received it, which the broker keeps for a quick start. */
export interface SlackIntakeRecordEvent { source: "agentx.slack-ingress"; action: "intake-record"; choiceId: string; thread: SlackThread; userId: string; text: string }

export function isSlackIntakeRecordEvent(event: unknown): event is SlackIntakeRecordEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "intake-record" && value.requestContext === undefined
    && typeof value.choiceId === "string" && typeof value.userId === "string" && typeof value.text === "string"
    && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackWorkflowDecisionEvent(event: unknown): event is SlackWorkflowDecisionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-decision" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.artifactDigest === "string"
    && (value.workBreakdownDigest === undefined || (typeof value.workBreakdownDigest === "string" && /^[a-f0-9]{64}$/.test(value.workBreakdownDigest)))
    && (value.decision === "APPROVE" || value.decision === "REQUEST_CHANGES") && typeof value.reason === "string"
    && Array.isArray(value.selectedOptionalCheckIds);
}

export function isSlackWorkflowRetryEvent(event: unknown): event is SlackWorkflowRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && Array.isArray(value.selectedOptionalCheckIds)
    && value.selectedOptionalCheckIds.every((id) => typeof id === "string") && typeof value.thread === "object" && value.thread !== null
    && (value.selectedProposedCheckIds === undefined || (Array.isArray(value.selectedProposedCheckIds) && value.selectedProposedCheckIds.every((id) => typeof id === "string")))
    && (value.step === undefined || value.step === "plan" || value.step === "coding");
}

export function isSlackWorkflowSendBackEvent(event: unknown): event is SlackWorkflowSendBackEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-send-back" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackWorkflowResolveFindingsEvent(event: unknown): event is SlackWorkflowResolveFindingsEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-resolve-findings" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(value.candidateDigest)
    && typeof value.thread === "object" && value.thread !== null
    && Array.isArray(value.resolutions) && value.resolutions.length >= 1 && value.resolutions.length <= WORKFLOW_RESOLVE_FINDINGS_MAX
    && value.resolutions.every((entry: unknown) => {
      const resolution = entry as Record<string, unknown> | null;
      return typeof resolution === "object" && resolution !== null && typeof resolution.findingId === "string" && /^[a-f0-9]{64}$/.test(resolution.findingId)
        && (resolution.action === "ACCEPT" || resolution.action === "FIX") && typeof resolution.note === "string";
    });
}

export function isSlackWorkflowCloseEvent(event: unknown): event is SlackWorkflowCloseEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-close" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackWorkflowReviewRetryEvent(event: unknown): event is SlackWorkflowReviewRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-review-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.candidateDigest === "string" && /^[a-f0-9]{64}$/.test(value.candidateDigest)
    && typeof value.thread === "object" && value.thread !== null;
}

export interface SlackWorkflowPublishRetryEvent {
  source: "agentx.slack-ingress";
  action: "workflow-publish-retry";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
}

export function isSlackWorkflowPublishRetryEvent(event: unknown): event is SlackWorkflowPublishRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-publish-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}

/** The owner's "Keep the pull request as it is" after an approved fix changed nothing, from the task's own thread. */
export interface SlackWorkflowKeepPullRequestsEvent {
  source: "agentx.slack-ingress";
  action: "workflow-keep-pull-requests";
  taskId: string;
  userId: string;
  thread: SlackThread;
  requestId: string;
  expectedRevision: number;
}

export function isSlackWorkflowKeepPullRequestsEvent(event: unknown): event is SlackWorkflowKeepPullRequestsEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-keep-pull-requests" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackWorkflowFeedbackFindingsDecisionEvent(event: unknown): event is SlackWorkflowFeedbackFindingsDecisionEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-feedback-findings-decision" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && Number.isInteger(value.expectedRevision) && typeof value.reviewDigest === "string" && /^[a-f0-9]{64}$/.test(value.reviewDigest)
    && typeof value.proposalDigest === "string" && /^[a-f0-9]{64}$/.test(value.proposalDigest)
    && typeof value.bundleSetDigest === "string" && /^[a-f0-9]{64}$/.test(value.bundleSetDigest)
    && ((value.selection === "RECOMMENDED" && (value.decision === "APPROVE" || value.decision === "REQUEST_CHANGES" || value.decision === "DISMISS"))
      || (value.selection === "ANSWER" && value.decision === "APPROVE" && Array.isArray(value.questionFindingIds)
        && value.questionFindingIds.length >= 1 && value.questionFindingIds.length <= 3
        && value.questionFindingIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 128)))
    && (value.selection === "ANSWER" || value.questionFindingIds === undefined)
    && (value.ownerNote === undefined || typeof value.ownerNote === "string");
}

export function isSlackWorkflowFeedbackNoteEvent(event: unknown): event is SlackWorkflowFeedbackNoteEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "feedback-note" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.eventId === "string"
    && value.eventId.length > 0 && value.eventId.length <= 128 && typeof value.messageTs === "string"
    && typeof value.text === "string" && value.text.trim().length > 0 && value.text.trim().length <= 500
    && typeof value.thread === "object" && value.thread !== null;
}

/** The owner's Retry review on a failed PR feedback review's card, from the task's own thread. */
export interface SlackWorkflowFeedbackReviewRetryEvent {
  source: "agentx.slack-ingress"; action: "workflow-feedback-review-retry";
  taskId: string; userId: string; thread: SlackThread; requestId: string; reviewDigest: string;
}

export function isSlackWorkflowFeedbackReviewRetryEvent(event: unknown): event is SlackWorkflowFeedbackReviewRetryEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "workflow-feedback-review-retry" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.requestId === "string"
    && typeof value.reviewDigest === "string" && /^[a-f0-9]{64}$/.test(value.reviewDigest)
    && typeof value.thread === "object" && value.thread !== null;
}

export interface SlackThreadNoteEvent {
  source: "agentx.slack-ingress"; action: "thread-note"; taskId: string; userId: string; thread: SlackThread;
  eventId: string; messageTs: string; text: string; /** L4-U5d: the reply is an @mention of Rovara (as against a plain reply); only a mention answers a core task's questions. */ mention?: true;
  /** Decision 134: the ingress read the reply as small talk; it is saved only when the task waits on this person. */
  smallTalk?: true;
}

export function isSlackThreadNoteEvent(event: unknown): event is SlackThreadNoteEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.source === "agentx.slack-ingress" && value.action === "thread-note" && value.requestContext === undefined
    && typeof value.taskId === "string" && typeof value.userId === "string" && typeof value.eventId === "string"
    && value.eventId.length > 0 && value.eventId.length <= 128 && typeof value.messageTs === "string"
    && typeof value.text === "string" && value.text.trim().length > 0
    && typeof value.thread === "object" && value.thread !== null;
}

export function isSlackStopTaskEvent(event: unknown): event is SlackStopTaskEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // API Gateway always sets requestContext, so a request from outside can never take this path.
  return value.source === "agentx.slack-ingress" && value.action === "stop-task" && value.requestContext === undefined;
}
