// Spec 025 FR-032, FR-034, C7 to C9: the DeveloperTaskNotifier, the only new reader of the Slack
// secret. The state table's stream (filtered in infra) brings changes, which become notices on the
// notifier's own queue; the queue brings each notice back, and it is posted once. Logs carry event
// names, IDs, notice kinds and Slack error codes only: never a token, a post's text or a task's text.
// Spec 025 E13: it also posts an admin change's Slack Confirm message, and edits it when the change ends.
import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ChangeMessageVisibilityCommand, SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, AdminChangePendingRecordSchema, PullRequestResultSchema, SHARE_DELIVERY_WINDOW_MS, WorkflowFeedbackReviewReportSchema, adminChangeKey, indexExpiresAt, lastAssistantResponse, sharedTaskKey, WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE, workflowPublicationRetryable, type PendingChange, type WorkflowArtifact, type WorkflowCanvasLineage, type WorkflowSnapshot } from "@agentx/contracts";
import { adminChangeExpiredMessage, adminChangeMessage, adminChangeOutcomeMessage } from "../developer/change-messages.js";
import { readStream, type Notice, type StreamRecord } from "../developer/notifications.js";
import { CANCELLED_REPLY, CLOSED_REPLY, READY_REPLY, endedReply, modeReply, pullRequestReply, setupFailedReply, startMessage } from "../developer/share-messages.js";
import { answeredWorkflowCard, documentSummaryLines, slackSectionTexts, slackText, workflowDocumentType, workflowMessage, workflowMessageKey, type WorkflowMessageContext } from "../developer/workflow-messages.js";
import { deriveTaskStatus, failureCategory, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type OperationFacts, type TaskShare } from "../developer/task-records.js";
import { isConditional } from "./broker-shared.js";
import { requiredEnvironment } from "./lambda.js";
import { parseSlackSecrets } from "./slack-ingress.js";
import { SlackPostError, chatPostEphemeral, chatPostMessage, chatUpdate, createTaskPlanCanvas, postMayHaveLanded } from "./slack-web.js";

type Client = { send(command: unknown): Promise<unknown> };
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
interface QueueRecord { eventSource: "aws:sqs"; messageId: string; receiptHandle: string; body: string; attributes?: { ApproximateReceiveCount?: string } }
interface PostInput { channel: string; threadTs?: string; text: string; blocks?: unknown[] }
interface UpdateInput { channel: string; ts: string; text: string; blocks: unknown[] }

export interface NotifierDependencies {
  documentClient: Client;
  tableName: string;
  enqueue(notices: readonly Notice[]): Promise<void>;
  retryLater(receiptHandle: string, seconds: number): Promise<void>;
  /** The answer's channel is the direct message's own ID when the post went to a user (E13). */
  post(input: PostInput): Promise<{ ts: string; channel?: string }>;
  /** Reads the plan through its recorded object key; callers verify its digest before linking it. */
  readArtifact?(key: string): Promise<string>;
  /** Trusted same-origin API base used for authenticated AgentX task detail links. */
  reviewUrlBase?: string;
  /** Creates a channel-readable detail page and returns Slack's verified link. */
  createPlanCanvas?(input: { channel: string; taskId: string; title: string; version: number; markdown: string }, onCreated?: (canvasId: string) => Promise<void>): Promise<{ canvasId: string; permalink: string }>;
  /** Spec 025 E13: chat.update, to edit an admin change's message when it ends. */
  update?(input: UpdateInput): Promise<void>;
  /** Task 19: chat.postEphemeral, to tell one member privately, in a thread, why their Slack press was refused. */
  postEphemeral?(input: { channel: string; threadTs: string; user: string; text: string }): Promise<void>;
  now(): number;
  log(entry: Record<string, unknown>): void;
  /** One `SlackDeliveryFailed` count (spec 015 FR-045's alarm sums it). */
  deliveryFailed(): void;
}

/** The start message is still being posted: a reply waits for its thread (C9). */
class StartPending extends Error {
  constructor() {
    super("the start message is not posted yet");
    this.name = "StartPending";
  }
}

/** 30, 60, 120, 240, 480, then 900 seconds, by the delivery attempt that failed. */
export const retryDelaySeconds = (attempt: number): number => Math.min(900, 30 * 2 ** Math.max(0, Math.min(attempt - 1, 5)));

const NOTICE_KINDS = new Set(["start", "mode", "closed", "cancelled", "ready", "setup_failed", "ended", "pull_request", "workflow", "github_feedback", "admin_change_dm", "admin_change_outcome", "admin_change_expiry", "workflow_refusal"]);

/**
 * #217: how long after a change's expiry its message is edited. The broker refuses a claim at or
 * after `expiresAt` by its own clock; the margin keeps a press in the last second, read by a
 * Lambda whose clock runs a little ahead, from being shown as expired.
 */
export const ADMIN_CHANGE_EXPIRY_GRACE_MS = 5_000;
/** SQS's longest per-message delay. */
const MAX_DELAY_SECONDS = 900;

export function feedbackReviewSlackMessage(input: {
  taskId: string;
  revision: number;
  reviewDigest: string;
  proposalDigest: string;
  bundleDigests: string[];
  totalComments: number;
  recommendedFindingIds: string[];
  highestPriority: "MUST_FIX" | "SHOULD_FIX" | "OPTIONAL" | undefined;
  detailUrl: string;
}): { text: string; blocks: unknown[] } {
  const url = new URL(input.detailUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("feedback review link is not a secure AgentX URL");
  }
  const priority = input.highestPriority === "MUST_FIX" ? "must fix" : input.highestPriority === "SHOULD_FIX" ? "should fix"
    : input.highestPriority === "OPTIONAL" ? "optional" : "none recommended";
  const recommendationSummary = input.recommendedFindingIds.length === 0
    ? "No fixes are recommended."
    : `${input.recommendedFindingIds.length} recommendations.`;
  const text = `PR feedback is ready: ${input.totalComments} comments; ${recommendationSummary} Highest priority: ${priority}. <${slackText(url.href)}|Open details>.`;
  const bundleSetDigest = createHash("sha256").update(JSON.stringify(input.bundleDigests), "utf8").digest("hex");
  const binding = JSON.stringify({ taskId: input.taskId, expectedRevision: input.revision, reviewDigest: input.reviewDigest,
    proposalDigest: input.proposalDigest, bundleSetDigest, selection: "RECOMMENDED" });
  const elements: Array<Record<string, unknown>> = [
    ...(input.recommendedFindingIds.length > 0 ? [{ type: "button", action_id: "agentx_feedback_review_recommended", style: "primary",
      text: { type: "plain_text", text: `Approve ${input.recommendedFindingIds.length} recommended` }, value: binding }] : []),
    { type: "button", action_id: "agentx_feedback_review_changes", text: { type: "plain_text", text: "Request changes" }, value: binding },
  ];
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "actions", elements },
    ],
  };
}

/** #217: the queue delay for a notice the notifier scheduled: until its `notBefore`, within SQS's 15 minutes. */
export function noticeDelaySeconds(notice: Notice, now: number): number {
  if (notice.notBefore === undefined) return 0;
  const seconds = Math.ceil((Date.parse(notice.notBefore) - now) / 1_000);
  return Number.isNaN(seconds) ? 0 : Math.min(MAX_DELAY_SECONDS, Math.max(0, seconds));
}

/** #217: the expiry notice came early (a short delay or a fast clock): it is retried. */
class ExpiryPending extends Error {
  constructor() {
    super("the change has not expired yet");
    this.name = "ExpiryPending";
  }
}
/** The statuses an ended operation can have; only these reach the reply text, which does not escape them. */
const ENDED_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

function parseNotice(body: string): Notice | undefined {
  try {
    const value = JSON.parse(body) as Partial<Notice>;
    return typeof value.id === "string" && typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) && typeof value.kind === "string" && NOTICE_KINDS.has(value.kind)
      && (value.workflowRevision === undefined || Number.isSafeInteger(value.workflowRevision) && value.workflowRevision > 0)
      ? value as Notice
      : undefined;
  } catch {
    return undefined;
  }
}

async function getItem<T>(deps: NotifierDependencies, key: { pk: string; sk: string }): Promise<T | undefined> {
  return ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true }))) as { Item?: T }).Item;
}

/**
 * 25c note 2 (owner answer, 2026-09-30): every NOTICE item carries the State table's TTL attribute,
 * 30 days on, far past the hour a notice is delivered in. Only named environments run the notifier,
 * and their State table expires items on this attribute.
 */
const noticeExpiry = (deps: NotifierDependencies) => ({ [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(new Date(deps.now()).toISOString()) });

/** A delivered marker replaces a start's posted-but-unrecorded marker, never another delivered one. */
const MARKER_CONDITION = "attribute_not_exists(pk) OR attribute_not_exists(deliveredAt)";

async function putMarker(deps: NotifierDependencies, marker: { pk: string; sk: string }, details: Partial<NoticeMarker> = {}): Promise<void> {
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...marker, entityType: "NOTICE", ...details, deliveredAt: new Date(deps.now()).toISOString(), ...noticeExpiry(deps) }, ConditionExpression: MARKER_CONDITION }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

const noticeMarker = (taskId: string, noticeId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `NOTICE#${noticeId}` });

/** A workflow notice's revision; notices queued before it was carried name it only at the end of their ID. */
function noticeWorkflowRevision(notice: Notice): number | undefined {
  const revision = notice.workflowRevision ?? Number(notice.id.split(":").at(-1));
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

/** Slack's answers that pass: the same edit can work on a later try. Any other Slack error would fail again. */
const PASSING_SLACK_ERRORS = new Set(["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout", "http_429"]);
const passingSlackError = (error: unknown) => !(error instanceof SlackPostError) || postMayHaveLanded(error) || PASSING_SLACK_ERRORS.has(error.slackError);

/** The short line an answered approval card shows in place of its buttons. */
function decisionStatusLine(decision: { decision: string; actorRole: string }, slackUserId: string | undefined): string {
  const by = decision.actorRole === "TASK_OWNER" && slackUserId !== undefined ? ` by <@${slackUserId}>` : "";
  return decision.decision === "APPROVE" ? `Approved${by}.` : decision.decision === "REQUEST_CHANGES" ? `Changes requested${by}.` : `Closed${by}.`;
}

/**
 * Edits the original approval card after the decision is durably recorded: replacing its blocks removes the stale
 * buttons, and a short status line says what was decided. Gap 10g: best effort. A Slack error that would fail again
 * (the card was deleted, say) is logged and the next step is still posted; only a passing problem retries the notice.
 */
async function updateWorkflowApprovalCard(deps: NotifierDependencies, task: DeveloperTaskRecord, notice: Notice): Promise<void> {
  if (notice.kind !== "workflow" || deps.update === undefined || task.workflow === undefined) return;
  const noticeRevision = noticeWorkflowRevision(notice);
  if (noticeRevision === undefined) return;
  // The decision update can be followed by a separate task-state write before this notice is
  // delivered. Match the decision that led to this revision instead of requiring an exact
  // equality with the current task revision encoded in the notice ID.
  const decision = (task.workflow.decisions ?? []).filter(entry => entry.workflowRevision + 1 <= noticeRevision).at(-1);
  if (decision === undefined || decision.artifactDigest === undefined) return;
  const decisionRevision = decision.workflowRevision + 1;
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":prefix": "NOTICE#" },
    ConsistentRead: true,
  })) as { Items?: Array<NoticeMarker & { pk: string; sk: string }> };
  const marker = response.Items?.find(item => item.postedArtifactDigest === decision.artifactDigest && item.postedWorkflowRevision === decision.workflowRevision
    && typeof item.postedTs === "string" && typeof item.postedChannelId === "string" && typeof item.postedText === "string" && typeof item.deliveredAt === "string");
  if (marker === undefined || typeof marker.postedTs !== "string" || typeof marker.postedChannelId !== "string"
    || typeof marker.postedText !== "string" || typeof marker.deliveredAt !== "string") {
    // Older approval cards were not recorded with message metadata. Keep the workflow notice
    // deliverable and explain the saved decision in its thread reply instead of retrying forever.
    deps.log({ event: "developer_notifier.workflow_approval_card_unavailable", taskId: task.taskId, workflowRevision: decision.workflowRevision });
    return;
  }
  if ((marker.workflowDecisionRevision ?? 0) >= decisionRevision) return;
  // The posted text is kept byte-for-byte, so the card never grows past what Slack took; the status line is its own
  // context block, and the next workflow notice reports the new step separately.
  const text = marker.postedText;
  try {
    await deps.update({ channel: marker.postedChannelId, ts: marker.postedTs, text, blocks: [
      ...slackSectionTexts(text).map((section) => ({ type: "section", text: { type: "mrkdwn", text: section } })),
      { type: "context", elements: [{ type: "mrkdwn", text: decisionStatusLine(decision, task.slackUserId) }] },
    ] });
  } catch (error) {
    if (passingSlackError(error)) throw error;
    // Named by the Slack error code only. The card is not tried again: the same edit would fail the same way.
    deps.log({ event: "developer_notifier.workflow_card_update_failed", taskId: task.taskId, workflowRevision: decision.workflowRevision,
      error: error instanceof SlackPostError ? error.slackError : errorName(error) });
  }
  await deps.documentClient.send(new UpdateCommand({
    TableName: deps.tableName, Key: { pk: marker.pk, sk: marker.sk },
    UpdateExpression: "SET workflowDecisionRevision = :revision",
    ConditionExpression: "deliveredAt = :deliveredAt AND (attribute_not_exists(workflowDecisionRevision) OR workflowDecisionRevision < :revision)",
    ExpressionAttributeValues: { ":revision": decisionRevision, ":deliveredAt": marker.deliveredAt },
  }));
}

const hasButtons = (blocks: unknown[] | undefined): boolean => (blocks ?? []).some((block) => (block as { type?: unknown } | null)?.type === "actions");

/** Task 19: the line a card whose step is over shows in place of its buttons, by where the task is now. */
function movedOnStatusLine(workflow: WorkflowSnapshot): string {
  if (workflow.stage === "CLOSED") return "This task is closed.";
  if (workflow.stage === "MERGED") return "Done. The pull request is merged.";
  return "Done. This step moved on.";
}

/**
 * Task 19: every card with buttons from a step the task has since left (its revision moved on, by any transition: a
 * retry, a send-back, a close, a decision made elsewhere) is edited to drop its buttons and say so in one short line.
 * The text is kept byte for byte, so the card never grows. An approval card whose decision was recorded is the
 * decision edit's (updateWorkflowApprovalCard). Best effort, as that edit is: a Slack error that would fail again is
 * logged and the card given up on; only a passing one retries the notice. A press that was refused (busy, out of
 * date) moves nothing, so its card keeps its buttons.
 */
async function retireButtonCards(deps: NotifierDependencies, task: DeveloperTaskRecord): Promise<void> {
  const workflow = task.workflow;
  if (workflow === undefined || deps.update === undefined) return;
  const markers: Array<NoticeMarker & { pk: string; sk: string }> = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const response = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":prefix": "NOTICE#" },
      ConsistentRead: true,
      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
    })) as { Items?: Array<NoticeMarker & { pk: string; sk: string }>; LastEvaluatedKey?: Record<string, unknown> };
    markers.push(...(response.Items ?? []));
    startKey = response.LastEvaluatedKey;
  } while (startKey !== undefined);
  for (const marker of markers) {
    if (marker.buttonCard !== true || marker.retiredAt !== undefined || typeof marker.deliveredAt !== "string" || typeof marker.postedTs !== "string"
      || typeof marker.postedChannelId !== "string" || typeof marker.postedText !== "string" || typeof marker.postedWorkflowRevision !== "number"
      || marker.postedWorkflowRevision >= workflow.revision) continue;
    // The decision's own edit says what was decided.
    if (marker.workflowDecisionRevision !== undefined || (marker.postedArtifactDigest !== undefined
      && (workflow.decisions ?? []).some((decision) => decision.workflowRevision === marker.postedWorkflowRevision && decision.artifactDigest === marker.postedArtifactDigest))) continue;
    try {
      await deps.update({ channel: marker.postedChannelId, ts: marker.postedTs, text: marker.postedText,
        blocks: answeredWorkflowCard(marker.postedText, movedOnStatusLine(workflow)) });
    } catch (error) {
      if (passingSlackError(error)) throw error;
      deps.log({ event: "developer_notifier.button_card_update_failed", taskId: task.taskId, workflowRevision: marker.postedWorkflowRevision,
        error: error instanceof SlackPostError ? error.slackError : errorName(error) });
    }
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: { pk: marker.pk, sk: marker.sk },
        UpdateExpression: "SET retiredAt = :now",
        ConditionExpression: "deliveredAt = :deliveredAt AND attribute_not_exists(retiredAt)",
        ExpressionAttributeValues: { ":now": new Date(deps.now()).toISOString(), ":deliveredAt": marker.deliveredAt },
      }));
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
}

async function noticeTask(deps: NotifierDependencies, notice: Notice): Promise<DeveloperTaskRecord | undefined> {
  let taskId = notice.taskId;
  if (taskId === undefined && notice.workspaceId !== undefined) taskId = (await getItem<DeveloperTaskPointerRecord>(deps, taskPointerKey(notice.workspaceId)))?.taskId;
  return taskId === undefined ? undefined : getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
}

async function operationsOf(deps: NotifierDependencies, workspaceId: string): Promise<Array<Record<string, unknown>>> {
  const response = await deps.documentClient.send(new QueryCommand({
    TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
    ExpressionAttributeValues: { ":pk": `WORKSPACE#${workspaceId}`, ":prefix": "OPERATION#" }, ConsistentRead: true,
  })) as { Items?: Array<Record<string, unknown>> };
  return (response.Items ?? []).filter((item) => item.entityType === "OPERATION");
}

/** The status the start message shows: R4's rule, on the task's current records (US3 scenario 9). */
async function currentStatus(deps: NotifierDependencies, task: DeveloperTaskRecord): Promise<string> {
  const [workspace, pointer, operations] = await Promise.all([
    getItem<{ status: string }>(deps, { pk: `WORKSPACE#${task.workspaceId}`, sk: "META" }),
    getItem<DeveloperTaskPointerRecord>(deps, taskPointerKey(task.workspaceId)),
    operationsOf(deps, task.workspaceId),
  ]);
  return deriveTaskStatus({ closedAt: task.closedAt, workspaceStatus: workspace?.status ?? "PREPARING", pointer, operations: operations as unknown as OperationFacts[] }).status;
}

/**
 * C1, C2: the thread on the task and its record, in ONE transaction, so the close and the share
 * routes (which condition on the record existing) never find a thread without its record. Retried
 * on a share change or a close meanwhile; a task closed first gets a closed record at once (C24).
 */
async function recordThread(deps: NotifierDependencies, taskId: string, threadTs: string, marker: { pk: string; sk: string }): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = await getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (task?.share === undefined) return;
    if (task.share.threadTs !== undefined) {
      // Another delivery of this notice, running at the same time, posted too and recorded its
      // thread first. The first thread stays the thread; this post stays in the channel unrecorded.
      deps.log({ event: "developer_notifier.start_posted_twice", taskId });
      await putMarker(deps, marker);
      return;
    }
    const share: TaskShare = { ...task.share, threadTs };
    const version = task.shareVersion ?? 0;
    const now = new Date(deps.now()).toISOString();
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Update: {
          TableName: deps.tableName, Key: taskKey(taskId),
          UpdateExpression: "SET #share = :share, shareVersion = :next, updatedAt = :now",
          // A close does not move shareVersion, so the close state read here is a condition too.
          ConditionExpression: task.closedAt === undefined ? "shareVersion = :current AND attribute_not_exists(closedAt)" : "shareVersion = :current",
          ExpressionAttributeNames: { "#share": "share" },
          ExpressionAttributeValues: { ":share": share, ":next": version + 1, ":current": version, ":now": now },
        } },
        { Put: {
          TableName: deps.tableName,
          Item: {
            ...sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs }), entityType: "SHARED_TASK",
            taskId, workspaceId: task.workspaceId, ownerKey: task.ownerKey, developerId: task.developerId, developerName: task.developerName,
            project: task.project, mode: share.mode, sharedAt: share.sharedAt,
            // C24: a task closed before its start message posted gets a closed thread at once.
            ...(task.closedAt === undefined ? {} : { closedAt: task.closedAt }),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        } },
        { Put: { TableName: deps.tableName, Item: { ...marker, entityType: "NOTICE", deliveredAt: now, ...noticeExpiry(deps) }, ConditionExpression: MARKER_CONDITION } },
      ] }));
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  deps.log({ event: "developer_notifier.thread_record_failed", taskId });
  throw new Error("the shared thread could not be recorded");
}

/** C9: the start message gave up; the task view then says so (`postFailed`). */
async function markPostFailed(deps: NotifierDependencies, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const task = await getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
    if (task?.share === undefined || task.share.threadTs !== undefined) return;
    const version = task.shareVersion ?? 0;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [{ Update: {
        TableName: deps.tableName, Key: taskKey(taskId),
        UpdateExpression: "SET #share = :share, shareVersion = :next", ConditionExpression: "shareVersion = :current",
        ExpressionAttributeNames: { "#share": "share" },
        ExpressionAttributeValues: { ":share": { ...task.share, postFailedAt: new Date(deps.now()).toISOString() }, ":next": version + 1, ":current": version },
      } }] }));
      return;
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  deps.log({ event: "developer_notifier.mark_conflict", taskId });
}

async function mutateCanvasLineage(
  deps: NotifierDependencies,
  taskId: string,
  workflowRevision: number,
  key: string,
  mutate: (current: WorkflowCanvasLineage | undefined, artifact: WorkflowArtifact, task: DeveloperTaskRecord) => WorkflowCanvasLineage,
): Promise<WorkflowCanvasLineage | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const task = await getItem<DeveloperTaskRecord>(deps, taskKey(taskId));
    const workflow = task?.workflow;
    if (task === undefined || workflow === undefined || workflow.revision !== workflowRevision || task.closedAt !== undefined) return undefined;
    const artifact = workflow.artifacts.find((entry) => key.endsWith(`:${entry.id}`));
    if (artifact === undefined) return undefined;
    const records = workflow.canvasLineage ?? [];
    const existing = records.find((entry) => entry.key === key);
    const updated = mutate(existing, artifact, task);
    if (updated.key !== key || updated.artifactId !== artifact.id || updated.artifactRef !== artifact.objectKey
      || updated.artifactDigest !== artifact.sha256) return undefined;
    if (existing !== undefined && JSON.stringify(existing) === JSON.stringify(updated)) return existing;
    const version = task.canvasLineageVersion ?? 0;
    const next = [...records.filter((entry) => entry.key !== key), updated];
    const nextWorkflow = { ...workflow, canvasLineage: next, canvasLineageVersion: version + 1, updatedAt: new Date(deps.now()).toISOString() };
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: taskKey(taskId),
        UpdateExpression: "SET workflow = :workflow, canvasLineageVersion = :next",
        ConditionExpression: `workflow.revision = :revision AND ${version === 0 ? "attribute_not_exists(canvasLineageVersion)" : "canvasLineageVersion = :version"} AND attribute_not_exists(closedAt)`,
        ExpressionAttributeValues: { ":workflow": nextWorkflow, ":next": version + 1, ":revision": workflowRevision,
          ...(version === 0 ? {} : { ":version": version }) },
      }));
      return updated;
    } catch (error) {
      if (!isConditional(error)) throw error;
    }
  }
  return undefined;
}

/** What one notice posts: its text, its blocks, and what makes it the same post as another notice's. */
interface Reply {
  text: string;
  blocks?: unknown[];
  /**
   * Two notices that would say the same thing (a refused publication's block and the worker's own
   * failure of that publication, or a step that left the pull requests as they were) share this key, and post once.
   */
  sameAs?: string;
  /** The approval card's document, recorded with the post so the card can be edited after the decision. */
  approval?: WorkflowArtifact;
}

/** The trusted AgentX task page, when the notifier knows its base and it is a plain https origin. */
function taskPageUrl(deps: NotifierDependencies, taskId: string): string | undefined {
  if (deps.reviewUrlBase === undefined) return undefined;
  try {
    const base = new URL(deps.reviewUrlBase);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) return undefined;
    return new URL(`/review/${encodeURIComponent(taskId)}/task`, base).href;
  } catch {
    return undefined;
  }
}

/** Slack's answers that mean this workspace cannot create a Canvas at all: the task page is linked instead. */
const CANVAS_UNAVAILABLE = new Set([
  "missing_scope", "not_allowed_token_type", "feature_not_enabled", "method_not_supported_for_channel_type",
  "canvas_disabled_user_team", "canvas_disabled_file_team", "canvas_globally_disabled",
  "free_teams_cannot_create_standalone_canvases", "team_tier_cannot_create_channel_canvases",
]);

/**
 * The approval card's link and summary: the document is read through its recorded key and its digest checked; then a
 * Canvas holds the full text (recorded before and after it is created, so a retry never makes a second one). When no
 * Canvas can be linked, the task page is; when nothing can be, the card says so. A document whose digest does not
 * match is neither summarised nor linked.
 */
async function prepareDocumentLink(deps: NotifierDependencies, task: DeveloperTaskRecord & { share: TaskShare }, workflow: WorkflowSnapshot): Promise<{ url?: string; summary?: string[] }> {
  const unavailable = (reason: string) => deps.log({ event: "developer_notifier.document_link_unavailable", taskId: task.taskId, workflowRevision: workflow.revision, reason });
  const plan = workflow.artifacts.filter((artifact) => artifact.type === workflowDocumentType(workflow)).at(-1);
  if (plan === undefined || deps.readArtifact === undefined) {
    unavailable(plan === undefined ? "document_missing" : "reader_unconfigured");
    return {};
  }
  const markdown = await deps.readArtifact(plan.objectKey);
  if (createHash("sha256").update(markdown, "utf8").digest("hex") !== plan.sha256) {
    unavailable("integrity_check_failed");
    return {};
  }
  const summary = documentSummaryLines(markdown);
  const fallback = taskPageUrl(deps, task.taskId);
  const linkOr = (reason: string, url: string | undefined = fallback) => {
    if (url === fallback) unavailable(reason);
    return { summary, ...(url === undefined ? {} : { url }) };
  };
  if (deps.createPlanCanvas === undefined) return linkOr("canvas_unconfigured");
  const canvasKey = `${workflow.stage}:${workflow.revision}:${plan.id}`;
  const prior = workflow.canvasLineage?.find((entry) => entry.key === canvasKey);
  // Whether Slack created this Canvas is unknown: an administrator reconciles its exact ID; another would be a duplicate.
  if (prior?.state === "CREATE_OUTCOME_UNKNOWN") return linkOr("canvas_outcome_unknown");
  if (prior?.state === "CREATED") return prior.permalink !== undefined ? linkOr("", prior.permalink) : linkOr("canvas_link_unconfirmed");
  const prepared = await mutateCanvasLineage(deps, task.taskId, workflow.revision, canvasKey, (current, artifact) => ({
    key: canvasKey, stage: workflow.stage, workflowRevision: workflow.revision, artifactId: artifact.id,
    artifactRef: artifact.objectKey, artifactDigest: artifact.sha256,
    state: "PREPARED", createdAt: current?.createdAt ?? new Date(deps.now()).toISOString(),
  }));
  if (prepared === undefined) throw new Error("Canvas creation intent could not be recorded");
  if (prepared.state === "CREATE_OUTCOME_UNKNOWN") return linkOr("canvas_outcome_unknown");
  const attempting = await mutateCanvasLineage(deps, task.taskId, workflow.revision, canvasKey, (current, artifact) => ({
    key: canvasKey, stage: workflow.stage, workflowRevision: workflow.revision, artifactId: artifact.id,
    artifactRef: artifact.objectKey, artifactDigest: artifact.sha256,
    state: "CREATE_OUTCOME_UNKNOWN", createdAt: current?.createdAt ?? new Date(deps.now()).toISOString(),
  }));
  if (attempting === undefined || attempting.state !== "CREATE_OUTCOME_UNKNOWN") throw new Error("Canvas create attempt could not be fenced");
  let canvas: { canvasId: string; permalink: string };
  try {
    canvas = await deps.createPlanCanvas({ channel: task.share.channelId, taskId: task.taskId, title: task.title, version: plan.version, markdown }, async (canvasId) => {
      const recorded = await mutateCanvasLineage(deps, task.taskId, workflow.revision, canvasKey, (current, artifact) => ({
        key: canvasKey, stage: workflow.stage, workflowRevision: workflow.revision, artifactId: artifact.id,
        artifactRef: artifact.objectKey, artifactDigest: artifact.sha256, state: "CREATED", canvasId,
        createdAt: current?.createdAt ?? new Date(deps.now()).toISOString(),
      }));
      if (recorded?.canvasId !== canvasId || recorded.state !== "CREATED") throw new Error("created Canvas ID could not be persisted");
    });
  } catch (error) {
    const latest = await getItem<DeveloperTaskRecord>(deps, taskKey(task.taskId));
    const created = latest?.workflow?.canvasLineage?.find((entry) => entry.key === canvasKey);
    if (created?.state !== "CREATED") {
      const mayHaveLanded = postMayHaveLanded(error);
      await mutateCanvasLineage(deps, task.taskId, workflow.revision, canvasKey, (current, artifact) => ({
        key: canvasKey, stage: workflow.stage, workflowRevision: workflow.revision, artifactId: artifact.id,
        artifactRef: artifact.objectKey, artifactDigest: artifact.sha256,
        state: mayHaveLanded ? "CREATE_OUTCOME_UNKNOWN" : "CREATE_FAILED", createdAt: current?.createdAt ?? new Date(deps.now()).toISOString(),
        ...(!mayHaveLanded && error instanceof SlackPostError ? { errorCategory: error.slackError } : {}),
      }));
    }
    // A long document is never pasted into the thread: the card stays brief and links the task page.
    if (error instanceof SlackPostError && CANVAS_UNAVAILABLE.has(error.slackError)) return linkOr("canvas_unavailable");
    throw error;
  }
  const linked = await mutateCanvasLineage(deps, task.taskId, workflow.revision, canvasKey, (current, artifact) => ({
    key: canvasKey, stage: workflow.stage, workflowRevision: workflow.revision, artifactId: artifact.id,
    artifactRef: artifact.objectKey, artifactDigest: artifact.sha256, state: "CREATED", canvasId: canvas.canvasId,
    permalink: canvas.permalink, createdAt: current?.createdAt ?? new Date(deps.now()).toISOString(),
  }));
  if (linked?.state !== "CREATED" || linked.permalink === undefined) throw new Error("Canvas permalink could not be persisted");
  return { summary, url: canvas.permalink };
}

/** How many thread replies are saved and not yet given to a step: the next step includes them. */
async function newThreadReplies(deps: NotifierDependencies, task: DeveloperTaskRecord): Promise<number> {
  const since = task.threadNotesFedThrough ?? "";
  let count = 0;
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :note)",
      ExpressionAttributeValues: { ":pk": `DEVTASK#${task.taskId}`, ":note": "NOTE#" }, ProjectionExpression: "receivedAt", ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: Array<{ receivedAt?: unknown }>; LastEvaluatedKey?: Record<string, unknown> };
    count += (page.Items ?? []).filter((item) => typeof item.receivedAt === "string" && item.receivedAt > since).length;
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return count;
}

async function workflowReply(deps: NotifierDependencies, task: DeveloperTaskRecord & { share: TaskShare }, workflow: WorkflowSnapshot): Promise<Reply | undefined> {
  // A task closed in Slack has its own closed reply; a second "closed" line would say it twice.
  if (workflow.stage === "CLOSED" && task.closedAt !== undefined) return undefined;
  const page = taskPageUrl(deps, task.taskId);
  const context: WorkflowMessageContext = { taskId: task.taskId, ownerSlackUserId: task.slackUserId, workflow,
    ...(page === undefined ? {} : { findingsUrl: `${page}#findings`, taskPageUrl: page }) };
  let approval: WorkflowArtifact | undefined;
  if (workflow.stage === "PLAN_REVIEW" && workflow.state === "WAITING") {
    const document = await prepareDocumentLink(deps, task, workflow);
    context.documentSummary = document.summary;
    if (document.url !== undefined) context.documentLink = { url: document.url };
    context.newReplies = await newThreadReplies(deps, task);
    approval = workflow.artifacts.filter((artifact) => artifact.type === workflowDocumentType(workflow)).at(-1);
  } else if (workflow.state === "BLOCKED" || (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING")) {
    // Replies that came in after the plan and that no step has taken: said, with where to read them.
    context.newReplies = await newThreadReplies(deps, task);
  }
  const message = workflowMessage(context);
  if (message === undefined) return undefined;
  return { ...message, sameAs: workflowMessageKey(workflow), ...(approval === undefined ? {} : { approval }) };
}

async function replyText(deps: NotifierDependencies, task: DeveloperTaskRecord & { share: TaskShare }, notice: Notice): Promise<Reply | undefined> {
  const operation = async () => (notice.workspaceId === undefined || notice.operationId === undefined
    ? undefined
    : getItem<{ id: string; kind: string; status: string; error?: string; result?: unknown }>(deps, { pk: `WORKSPACE#${notice.workspaceId}`, sk: `OPERATION#${notice.operationId}` }));
  const said = (text: string | undefined): Reply | undefined => (text === undefined ? undefined : { text });
  switch (notice.kind) {
    case "ready": return said(READY_REPLY);
    case "cancelled": return said(CANCELLED_REPLY);
    case "closed": return said(CLOSED_REPLY);
    // A change a later one replaced is not said: the later notice says the current mode.
    case "mode": return notice.mode === task.share.mode ? said(modeReply(task.share.mode)) : undefined;
    case "setup_failed": return said(setupFailedReply((await operation())?.error));
    case "pull_request": {
      // A workflow task's pull request is said by its merge step, with the step's own words.
      if (task.workflow !== undefined) return undefined;
      const published = PullRequestResultSchema.safeParse((await operation())?.result);
      return published.success ? said(pullRequestReply(published.data.url)) : undefined;
    }
    case "workflow": return task.workflow === undefined ? undefined : workflowReply(deps, task, task.workflow);
    case "ended": {
      const ended = await operation();
      if (ended === undefined || !ENDED_STATUSES.has(ended.status)) return undefined;
      const workflow = task.workflow;
      if (workflow !== undefined) {
        // A workflow task's steps are said by its workflow notices, never as "the task ended" with the model's words.
        // The one exception: AgentX's own draft pull request did not open, and the owner retries it from this post.
        if (ended.kind !== "publish" || ended.status === "SUCCEEDED" || !workflowPublicationRetryable(workflow)) return undefined;
        const message = workflowMessage({ taskId: task.taskId, ownerSlackUserId: task.slackUserId, workflow, publishFailure: {
          category: failureCategory(ended.kind, ended.status, ended.error),
          codeChanged: ended.error?.includes(WORKFLOW_PUBLISH_CANDIDATE_CHANGED_MESSAGE) === true,
        } });
        // Blocked by the refused publication, the step's own notice offers the same retry: the two post once.
        return message === undefined ? undefined : { ...message, ...(workflow.state === "BLOCKED" ? { sameAs: `revision:${workflow.revision}` } : {}) };
      }
      const failed = ended.status === "FAILED" || ended.status === "INTERRUPTED";
      let summary: string | undefined;
      if (ended.kind === "task") {
        const events = await deps.documentClient.send(new QueryCommand({
          TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": `OPERATION#${ended.id}`, ":prefix": "EVENT#" }, ScanIndexForward: false, Limit: 500, ConsistentRead: true,
        })) as { Items?: Array<{ entityType?: string; payload: unknown }> };
        summary = lastAssistantResponse((events.Items ?? []).filter((item) => item.entityType === "EVENT").reverse());
      }
      // The status and the category are fixed values, placed unescaped; the message and summary are redacted and escaped there.
      return said(endedReply({
        kind: ended.kind,
        status: ended.status,
        ...(failed ? { failure: { category: failureCategory(ended.kind, ended.status, ended.error), message: ended.error ?? `the ${ended.kind} operation ended ${ended.status}` } } : {}),
        ...(summary === undefined ? {} : { summary }),
      }));
    }
    default: return undefined;
  }
}

async function feedbackReviewNotification(deps: NotifierDependencies, task: DeveloperTaskRecord & { share: TaskShare }, notice: Notice) {
  const workflow = task.workflow;
  const review = workflow?.feedbackReview;
  const reviewRef = review?.reviewRef;
  if (notice.kind !== "github_feedback" || review?.status !== "PENDING" || reviewRef?.status !== "COMPLETE"
    || reviewRef.sha256 !== notice.feedbackReviewDigest) return undefined;
  if (deps.readArtifact === undefined || deps.reviewUrlBase === undefined) throw new Error("feedback review notice is not configured");
  const bytes = await deps.readArtifact(reviewRef.objectKey);
  if (createHash("sha256").update(bytes, "utf8").digest("hex") !== reviewRef.sha256) throw new Error("feedback review artifact integrity check failed");
  const report = WorkflowFeedbackReviewReportSchema.parse(JSON.parse(bytes));
  if (report.taskId !== task.taskId || report.status !== "COMPLETE" || report.proposalDigest !== reviewRef.proposalDigest
    || JSON.stringify(report.bundleDigests) !== JSON.stringify(review.bundleRefs.map(bundle => bundle.sha256))) {
    throw new Error("feedback review artifact binding failed");
  }
  const base = new URL(deps.reviewUrlBase);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("feedback review base URL is invalid");
  const findings = report.findings;
  const highestPriority = findings.some(finding => finding.recommended && finding.priority === "MUST_FIX") ? "MUST_FIX"
    : findings.some(finding => finding.recommended && finding.priority === "SHOULD_FIX") ? "SHOULD_FIX"
      : findings.some(finding => finding.recommended && finding.priority === "OPTIONAL") ? "OPTIONAL" : undefined;
  return feedbackReviewSlackMessage({
    taskId: task.taskId, revision: workflow!.revision, reviewDigest: reviewRef.sha256, proposalDigest: reviewRef.proposalDigest,
    bundleDigests: review.bundleRefs.map(bundle => bundle.sha256),
    totalComments: review.bundleRefs.reduce((total, bundle) => total + bundle.comments.length, 0),
    recommendedFindingIds: findings.filter(finding => finding.recommended).map(finding => finding.id), highestPriority,
    detailUrl: new URL(`/review/${encodeURIComponent(task.taskId)}`, base).href,
  });
}

type Outcome = "posted" | "recorded" | "not_shared" | "before_share" | "after_close" | "delivered" | "no_thread" | "stale";

/** Another delivery of an admin change's message holds the claim: this one is retried (C9). */
class DmPending extends Error {
  constructor() {
    super("the admin change's message is being posted");
    this.name = "DmPending";
  }
}

/** A claim older than this was left by a delivery that died between claiming and posting; longer than a post's timeout. */
const DM_CLAIM_MS = 60_000;

/** The stored change, read strictly as the broker reads it; an unreadable one is named by its ID only. */
async function readChange(deps: NotifierDependencies, changeId: string): Promise<PendingChange | undefined> {
  const item = await getItem<Record<string, unknown>>(deps, adminChangeKey(changeId));
  if (item === undefined) return undefined;
  const parsed = AdminChangePendingRecordSchema.safeParse(item);
  if (!parsed.success) {
    deps.log({ event: "admin_change.unreadable", changeId });
    return undefined;
  }
  return parsed.data;
}

/**
 * Spec 025 E13: posts the change's Confirm message once, to the planning admin's own linked Slack
 * user, and edits it once the change has ended. Every write conditions on the item existing, so a
 * change the TTL removed meanwhile is never recreated as a fragment.
 */
async function deliverAdminChange(deps: NotifierDependencies, notice: Notice): Promise<Outcome> {
  if (notice.changeId === undefined) return "stale";
  const key = adminChangeKey(notice.changeId);
  const change = await readChange(deps, notice.changeId);
  if (change === undefined) return "stale";
  if (notice.kind === "admin_change_expiry") return editExpired(deps, change);
  if (notice.kind === "admin_change_outcome") {
    // No message to edit: nothing was posted, so there is nothing to deliver.
    if (change.dm === undefined) return "stale";
    if (change.dmEditedAt !== undefined) return "delivered";
    if (deps.update === undefined) return "stale";
    // Only a stored end edits the message: a still-pending change keeps its buttons (C13).
    const message = adminChangeOutcomeMessage(change);
    if (message === undefined) return "stale";
    await deps.update({ channel: change.dm.channel, ts: change.dm.ts, ...message });
    try {
      // Ruling B2: a top-level attribute, so the fake and DynamoDB agree on it.
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET dmEditedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND attribute_exists(dm) AND attribute_not_exists(dmEditedAt)",
        ExpressionAttributeValues: { ":now": new Date(deps.now()).toISOString() },
      }));
    } catch (error) {
      // Another delivery edited it too, with the same text; or the TTL removed the change.
      if (!isConditional(error)) throw error;
    }
    deps.log({ event: "admin_change.dm_edited", changeId: change.changeId, traceId: change.traceId, status: change.status });
    return "posted";
  }
  if (change.dm !== undefined) {
    // #217: a repeated delivery schedules the expiry edit again, so a schedule lost to a failure
    // after the post is made good; the edit itself happens at most once.
    if (change.status === "pending" && change.dmEditedAt === undefined) await scheduleExpiry(deps, change);
    return "delivered";
  }
  if (change.status !== "pending" || deps.now() >= Date.parse(change.expiresAt) || change.slackUserId === undefined) return "stale";
  const claimedAt = new Date(deps.now()).toISOString();
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET dmClaimedAt = :now",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(dm) AND (attribute_not_exists(dmClaimedAt) OR dmClaimedAt < :stale)",
      ExpressionAttributeValues: { ":now": claimedAt, ":stale": new Date(deps.now() - DM_CLAIM_MS).toISOString() },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // Another delivery is posting it now; this one is retried and then finds it delivered.
    throw new DmPending();
  }
  // 25c note 3, as for the start message: a claim taken over from a delivery that died, or a post
  // that may have landed, can mean a second message. Logged with the IDs and the error's name only.
  if (change.dmClaimedAt !== undefined) deps.log({ event: "admin_change.dm_post_uncertain", reason: "claim_lapsed", changeId: change.changeId, traceId: change.traceId });
  let posted: { ts: string; channel?: string };
  try {
    posted = await deps.post({ channel: change.slackUserId, ...adminChangeMessage(change, deps.now()) });
  } catch (error) {
    if (postMayHaveLanded(error)) deps.log({ event: "admin_change.dm_post_uncertain", reason: "post_error", changeId: change.changeId, traceId: change.traceId, error: errorName(error) });
    // Gives the claim back at once, so the retry need not wait for it to lapse. Best effort.
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "REMOVE dmClaimedAt", ConditionExpression: "dmClaimedAt = :mine",
        ExpressionAttributeValues: { ":mine": claimedAt },
      }));
    } catch (releaseError) {
      deps.log({ event: "admin_change.dm_release_failed", changeId: change.changeId, traceId: change.traceId, error: errorName(releaseError) });
    }
    throw error;
  }
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: key, UpdateExpression: "SET dm = :dm",
      ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(dm)",
      ExpressionAttributeValues: { ":dm": { channel: posted.channel ?? change.slackUserId, ts: posted.ts, postedAt: new Date(deps.now()).toISOString() } },
    }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // The TTL removed the change while it posted: the message stays, and a press answers not found.
    deps.log({ event: "admin_change.dm_unrecorded", changeId: change.changeId, traceId: change.traceId });
    return "stale";
  }
  // FR-052: the notifier's step, with the change and trace IDs.
  deps.log({ event: "admin_change.dm_posted", changeId: change.changeId, traceId: change.traceId });
  // A failure here retries the notice, which finds the message posted and schedules the edit again.
  await scheduleExpiry(deps, change);
  return "posted";
}

/** #217: queues the edit of the change's message for just after it expires. */
async function scheduleExpiry(deps: NotifierDependencies, change: PendingChange): Promise<void> {
  const notBefore = new Date(Date.parse(change.expiresAt) + ADMIN_CHANGE_EXPIRY_GRACE_MS).toISOString();
  await deps.enqueue([{ id: `${change.changeId}:expiry`, kind: "admin_change_expiry", changeId: change.changeId, at: new Date(deps.now()).toISOString(), notBefore }]);
}

/** Records that the message was edited; false when it already was, or the change is no longer `status`. */
async function markEdited(deps: NotifierDependencies, changeId: string, status?: string): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: adminChangeKey(changeId), UpdateExpression: "SET dmEditedAt = :now",
      ConditionExpression: `attribute_exists(pk) AND attribute_exists(dm) AND attribute_not_exists(dmEditedAt)${status === undefined ? "" : " AND #status = :status"}`,
      ...(status === undefined ? {} : { ExpressionAttributeNames: { "#status": "status" } }),
      ExpressionAttributeValues: { ":now": new Date(deps.now()).toISOString(), ...(status === undefined ? {} : { ":status": status }) },
    }));
    return true;
  } catch (error) {
    if (!isConditional(error)) throw error;
    return false;
  }
}

/**
 * #217: a change nobody answered keeps live buttons until someone presses one, so at its expiry
 * the notifier edits its message to say it expired, with no buttons. The broker records the
 * expiry on the change's next touch, as before (E3); that outcome then edits nothing more. A
 * change answered meanwhile is left to its own outcome edit.
 */
async function editExpired(deps: NotifierDependencies, change: PendingChange): Promise<Outcome> {
  if (change.dm === undefined) return "stale";
  if (change.dmEditedAt !== undefined) return "delivered";
  if (change.status !== "pending" || deps.update === undefined) return "stale";
  if (deps.now() < Date.parse(change.expiresAt) + ADMIN_CHANGE_EXPIRY_GRACE_MS) throw new ExpiryPending();
  await deps.update({ channel: change.dm.channel, ts: change.dm.ts, ...adminChangeExpiredMessage(change) });
  if (await markEdited(deps, change.changeId, "pending")) {
    deps.log({ event: "admin_change.dm_expired", changeId: change.changeId, traceId: change.traceId });
    return "posted";
  }
  // Answered while this edit was made: the stored outcome wins, even over an outcome edit that
  // landed between this delivery's read and its expiry edit. Reaching here needs the broker to
  // accept a claim after this Lambda's expiresAt + grace, so only a clock skew over the grace.
  const current = await readChange(deps, change.changeId);
  if (current?.dm === undefined) return "delivered";
  if (current.status === "expired") {
    // A press recorded the expiry meanwhile: the message already says so, so its outcome edits nothing more.
    await markEdited(deps, current.changeId);
    return "posted";
  }
  const outcome = adminChangeOutcomeMessage(current);
  if (outcome === undefined) return "delivered";
  await deps.update({ channel: current.dm.channel, ts: current.dm.ts, ...outcome });
  await markEdited(deps, current.changeId);
  deps.log({ event: "admin_change.dm_edited", changeId: current.changeId, traceId: current.traceId, status: current.status });
  return "posted";
}

/** How long one delivery holds the start message's post (final review M3); longer than a post's timeout. */
const START_LEASE_MS = 60_000;

/**
 * Final review M3: claims the start message's post, so two deliveries running at the same time
 * cannot both post a top-level message (the second would start a thread with no record). True when
 * this delivery may post; false when another delivery holds a live claim, or already posted.
 */
async function claimStart(deps: NotifierDependencies, marker: { pk: string; sk: string }, until: number): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: marker,
      UpdateExpression: "SET entityType = :notice, postingUntil = :until, #expires = :expires",
      ConditionExpression: "attribute_not_exists(deliveredAt) AND attribute_not_exists(postedTs) AND (attribute_not_exists(postingUntil) OR postingUntil < :now)",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":notice": "NOTICE", ":until": until, ":now": deps.now(), ":expires": noticeExpiry(deps)[INDEX_EXPIRY_ATTRIBUTE] },
    }));
    return true;
  } catch (error) {
    if (isConditional(error)) return false;
    throw error;
  }
}

/** Gives a failed post's claim back at once, so the retry need not wait for it to lapse. Best effort. */
async function releaseStart(deps: NotifierDependencies, marker: { pk: string; sk: string }, until: number): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: marker, UpdateExpression: "REMOVE postingUntil", ConditionExpression: "postingUntil = :until",
      ExpressionAttributeValues: { ":until": until },
    }));
  } catch (error) {
    deps.log({ event: "developer_notifier.start_release_failed", error: errorName(error) });
  }
}

interface NoticeMarker {
  deliveredAt?: string; postedTs?: string; postingUntil?: number;
  postedArtifactDigest?: string; postedWorkflowRevision?: number; postedText?: string; postedChannelId?: string;
  workflowDecisionRevision?: number;
  /** Task 19: the post carried buttons, which go once the task moves past `postedWorkflowRevision`. */
  buttonCard?: boolean;
  /** Task 19: when the card's buttons were taken away (or given up on). */
  retiredAt?: string;
}

/**
 * C1: a start message posted but not recorded keeps its ts on the notice's marker, so the next
 * delivery records that thread instead of posting a second start message. Best effort: when this
 * write fails too, the next delivery posts again, and the record keeps the first thread it gets.
 */
async function keepPostedTs(deps: NotifierDependencies, marker: { pk: string; sk: string }, ts: string): Promise<void> {
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...marker, entityType: "NOTICE", postedTs: ts, ...noticeExpiry(deps) } }));
  } catch (error) {
    deps.log({ event: "developer_notifier.posted_ts_lost", error: errorName(error) });
  }
}

/**
 * Task 19: a refused Slack press, told privately to whoever pressed, in the thread they pressed in. Its words are the
 * broker's own fixed sentences. Marked delivered after the post, so a redelivered notice says it once.
 */
async function deliverRefusal(deps: NotifierDependencies, notice: Notice): Promise<Outcome> {
  const taskId = notice.taskId;
  const prefix = `${taskId ?? ""}:refusal:`;
  if (taskId === undefined || !notice.id.startsWith(prefix)) return "stale";
  const marker = noticeMarker(taskId, notice.id);
  if ((await getItem<NoticeMarker>(deps, marker))?.deliveredAt !== undefined) return "delivered";
  const refusal = await getItem<Record<string, unknown>>(deps, { pk: `DEVTASK#${taskId}`, sk: notice.id.slice(prefix.length) });
  if (refusal?.entityType !== "WORKFLOW_ACTION_REFUSAL" || typeof refusal.channelId !== "string" || typeof refusal.threadTs !== "string"
    || typeof refusal.slackUserId !== "string" || typeof refusal.message !== "string") return "stale";
  if (deps.postEphemeral === undefined) {
    deps.log({ event: "developer_notifier.refusal_not_configured", taskId });
    return "stale";
  }
  await deps.postEphemeral({ channel: refusal.channelId, threadTs: refusal.threadTs, user: refusal.slackUserId, text: refusal.message });
  await putMarker(deps, marker);
  return "posted";
}

async function deliver(deps: NotifierDependencies, notice: Notice): Promise<Outcome> {
  if (notice.kind === "workflow_refusal") return deliverRefusal(deps, notice);
  const task = await noticeTask(deps, notice);
  if (task?.share === undefined) return "not_shared";
  const share = task.share;
  // Ruling F7: a notice carries its change's own time to the millisecond, so it compares exactly with the share's.
  if (notice.kind !== "start" && Date.parse(notice.at) < Date.parse(share.sharedAt)) return "before_share";
  // Q3: a close posts "closed", then the thread stops.
  if (notice.kind !== "start" && notice.kind !== "closed" && task.closedAt !== undefined
    && (Date.parse(notice.at) > Date.parse(task.closedAt) || await getItem(deps, noticeMarker(task.taskId, `${task.taskId}:closed`)) !== undefined)) return "after_close";
  const marker = noticeMarker(task.taskId, notice.id);
  const delivered = await getItem<NoticeMarker>(deps, marker);
  if (delivered?.deliveredAt !== undefined) {
    // The step was posted but the card edit after it met a passing Slack problem: the retry finishes the edit.
    if (notice.kind === "workflow") await updateWorkflowApprovalCard(deps, task, notice);
    await retireButtonCards(deps, task);
    return "delivered";
  }
  if (notice.kind === "start") {
    if (share.threadTs !== undefined) {
      await putMarker(deps, marker);
      return "delivered";
    }
    if (delivered?.postedTs !== undefined) {
      await recordThread(deps, task.taskId, delivered.postedTs, marker);
      return "recorded";
    }
    // 25c note 3 (owner answer, 2026-09-30): a start post may have landed without its ts being kept,
    // so the next post can be a second start message. Left as is; these logs count how often.
    const lapsed = delivered?.postingUntil !== undefined && delivered.postingUntil < deps.now();
    const until = deps.now() + START_LEASE_MS;
    if (!await claimStart(deps, marker, until)) {
      const current = await getItem<NoticeMarker>(deps, marker);
      if (current?.deliveredAt !== undefined) return "delivered";
      if (current?.postedTs !== undefined) {
        await recordThread(deps, task.taskId, current.postedTs, marker);
        return "recorded";
      }
      // Another delivery is posting it now: this one is retried, and then finds it delivered.
      throw new StartPending();
    }
    // Logged by the delivery that won the claim only, so one lapse is counted once.
    if (lapsed) deps.log({ event: "developer_notifier.start_post_uncertain", reason: "claim_lapsed", taskId: task.taskId });
    const status = await currentStatus(deps, task);
    let ts: string;
    try {
      ({ ts } = await deps.post({
        channel: share.channelId,
        text: startMessage({ developerName: task.developerName, slackUserId: task.slackUserId, client: task.client, title: task.title, project: task.project, mode: share.mode, status, sharedReason: share.sharedReason }),
      }));
    } catch (error) {
      // Slack's own error code means nothing was posted; a lost or unreadable answer may not.
      if (postMayHaveLanded(error)) deps.log({ event: "developer_notifier.start_post_uncertain", reason: "post_error", taskId: task.taskId, error: errorName(error) });
      await releaseStart(deps, marker, until);
      throw error;
    }
    try {
      await recordThread(deps, task.taskId, ts, marker);
    } catch (error) {
      await keepPostedTs(deps, marker, ts);
      throw error;
    }
    return "posted";
  }
  if (share.threadTs === undefined) {
    // C9: the start message gave up; nothing is posted outside a thread.
    if (share.postFailedAt !== undefined) return "no_thread";
    throw new StartPending();
  }
  // Gap 5: a workflow notice says its own revision's step only; a later step has its own notice.
  if (notice.kind === "workflow" && task.workflow !== undefined && noticeWorkflowRevision(notice) !== task.workflow.revision) return "stale";
  // The previous approval card is edited after this step's own post, so a card that keeps failing never holds it up.
  const editCard = async () => {
    await updateWorkflowApprovalCard(deps, { ...task, share }, notice);
    await retireButtonCards(deps, task);
  };
  const feedbackReview = await feedbackReviewNotification(deps, { ...task, share }, notice);
  const reply: Reply | undefined = feedbackReview ?? await replyText(deps, { ...task, share }, notice);
  if (reply === undefined) {
    await editCard();
    return "stale";
  }
  const sameAs = reply.sameAs === undefined ? undefined : noticeMarker(task.taskId, `${task.taskId}:said:${reply.sameAs}`);
  if (sameAs !== undefined) {
    const claim = await claimSaid(deps, sameAs, notice.id);
    if (claim === "said") {
      await putMarker(deps, marker);
      await editCard();
      return "delivered";
    }
    // Another notice is posting the same words now: this one is retried, and then finds them said.
    if (claim === "pending") throw new SaidPending();
  }
  // Accepted: a close that commits while this reply is being posted can put this one reply after
  // "closed". The checks above read the task before the post; at most one reply per notice lands late.
  let posted: { ts: string };
  try {
    posted = await deps.post({ channel: share.channelId, threadTs: share.threadTs, text: reply.text, ...(reply.blocks === undefined ? {} : { blocks: reply.blocks }) });
  } catch (error) {
    // Nothing was posted: the words are free for the next delivery. A post that may have landed keeps the claim
    // until its lease ends, as the start message does.
    if (sameAs !== undefined && !postMayHaveLanded(error)) await releaseSaid(deps, sameAs, notice.id);
    throw error;
  }
  const buttons = hasButtons(reply.blocks);
  await putMarker(deps, marker, {
    postedTs: posted.ts,
    // Task 19: a card with buttons is kept with its step, so its buttons go once the task moves past that step.
    ...((reply.approval === undefined && !buttons) || task.workflow === undefined ? {} : {
      postedWorkflowRevision: task.workflow.revision,
      postedText: reply.text,
      postedChannelId: share.channelId,
    }),
    ...(reply.approval === undefined || task.workflow === undefined ? {} : { postedArtifactDigest: reply.approval.sha256 }),
    ...(buttons && task.workflow !== undefined ? { buttonCard: true } : {}),
  });
  if (sameAs !== undefined) await putMarker(deps, sameAs);
  await editCard();
  return "posted";
}

/** How long one notice holds the words it is posting; longer than a post's timeout. */
const SAID_LEASE_MS = 60_000;

/** Another notice holds the claim on the same words: this one is retried (C9). */
class SaidPending extends Error {
  constructor() { super("another notice is posting the same message"); this.name = "SaidPending"; }
}

/**
 * Claims the words a notice is about to post, so two notices that would say the same thing (delivered by two
 * Lambdas at once) post once: "claimed" lets this notice post, "said" means they are already in the thread, and
 * "pending" means another notice holds a live claim. A claim whose lease ended is taken over.
 */
async function claimSaid(deps: NotifierDependencies, said: { pk: string; sk: string }, noticeId: string): Promise<"claimed" | "said" | "pending"> {
  // Read first only to log, as the start message does: a claim still held after its post may have landed (this
  // notice's own, or another notice's whose lease ended) can mean the words are posted twice. At most once each.
  const prior = await getItem<NoticeMarker & { claimedBy?: string }>(deps, said);
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: said,
      UpdateExpression: "SET entityType = :notice, claimedBy = :me, claimUntil = :until, #expires = :expires",
      ConditionExpression: "attribute_not_exists(deliveredAt) AND (attribute_not_exists(claimedBy) OR claimedBy = :me OR claimUntil < :now)",
      ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":notice": "NOTICE", ":me": noticeId, ":until": deps.now() + SAID_LEASE_MS, ":now": deps.now(),
        ":expires": noticeExpiry(deps)[INDEX_EXPIRY_ATTRIBUTE] },
    }));
    if (prior?.claimedBy !== undefined && prior.deliveredAt === undefined) {
      deps.log({ event: "developer_notifier.said_post_uncertain", reason: prior.claimedBy === noticeId ? "claim_retaken" : "claim_lapsed", noticeId });
    }
    return "claimed";
  } catch (error) {
    if (!isConditional(error)) throw error;
    return (await getItem<NoticeMarker>(deps, said))?.deliveredAt !== undefined ? "said" : "pending";
  }
}

/** Gives back a claim whose post never reached Slack, so another notice need not wait for its lease. Best effort. */
async function releaseSaid(deps: NotifierDependencies, said: { pk: string; sk: string }, noticeId: string): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: said, UpdateExpression: "REMOVE claimedBy, claimUntil",
      ConditionExpression: "claimedBy = :me AND attribute_not_exists(deliveredAt)", ExpressionAttributeValues: { ":me": noticeId },
    }));
  } catch (error) {
    deps.log({ event: "developer_notifier.said_release_failed", noticeId, error: errorName(error) });
  }
}

export function createNotifierHandler(deps: NotifierDependencies) {
  return async (event: { Records?: unknown[] }): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
    const records = event.Records ?? [];
    const queued = records.filter((record): record is QueueRecord => (record as { eventSource?: unknown }).eventSource === "aws:sqs");
    if (queued.length === 0) {
      const { notices, skipped } = readStream(records as StreamRecord[]);
      // Named by event ID and name only: a record's content could hold a task's text.
      for (const record of skipped) deps.log({ event: "developer_notifier.record_unreadable", ...record });
      if (notices.length > 0) await deps.enqueue(notices);
      return { batchItemFailures: [] };
    }
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const record of queued) {
      const notice = parseNotice(record.body);
      if (notice === undefined) {
        deps.log({ event: "developer_notifier.notice_unreadable", messageId: record.messageId });
        continue;
      }
      try {
        const outcome = notice.kind === "admin_change_dm" || notice.kind === "admin_change_outcome" || notice.kind === "admin_change_expiry" ? await deliverAdminChange(deps, notice) : await deliver(deps, notice);
        deps.log({ event: "developer_notifier.notice", kind: notice.kind, noticeId: notice.id, outcome });
      } catch (error) {
        const reason = error instanceof SlackPostError ? error.slackError : errorName(error);
        if (deps.now() - Date.parse(notice.at) < SHARE_DELIVERY_WINDOW_MS) {
          const attempt = Number(record.attributes?.ApproximateReceiveCount ?? "1");
          try {
            await deps.retryLater(record.receiptHandle, retryDelaySeconds(attempt));
          } catch (delayError) {
            deps.log({ event: "developer_notifier.delay_failed", error: errorName(delayError) });
          }
          deps.log({ event: "developer_notifier.retry", kind: notice.kind, noticeId: notice.id, attempt, reason });
          batchItemFailures.push({ itemIdentifier: record.messageId });
        } else {
          deps.log({ event: "developer_notifier.delivery_failed", kind: notice.kind, noticeId: notice.id, reason });
          try {
            deps.deliveryFailed();
          } catch (metricError) {
            // An expired notice is dropped whatever happens to its count, so it can never loop.
            deps.log({ event: "developer_notifier.metric_failed", error: errorName(metricError) });
          }
          if (notice.kind === "start" && notice.taskId !== undefined) {
            try {
              await markPostFailed(deps, notice.taskId);
            } catch (markError) {
              deps.log({ event: "developer_notifier.mark_failed", taskId: notice.taskId, error: errorName(markError) });
            }
          }
        }
      }
    }
    return { batchItemFailures };
  };
}

const SECRET_CACHE_MS = 5 * 60_000;
/** Slack's answers that mean the token itself is bad: the next post loads it again. */
const REFUSED_TOKEN = new Set(["invalid_auth", "token_revoked"]);

/** The bot token cached for five minutes, and dropped when Slack refuses it; shared by every Slack call. */
export function cachedBotToken(loadToken: () => Promise<string>, now: () => number = Date.now): <T>(call: (token: string) => Promise<T>) => Promise<T> {
  let cached: { value: Promise<string>; loadedAt: number } | undefined;
  const token = (): Promise<string> => {
    if (cached === undefined || now() - cached.loadedAt > SECRET_CACHE_MS) {
      const value = loadToken();
      const entry = { value, loadedAt: now() };
      cached = entry;
      value.catch(() => { if (cached === entry) cached = undefined; });
    }
    return cached.value;
  };
  return async (call) => {
    const entry = cached;
    try {
      return await call(await token());
    } catch (error) {
      if (error instanceof SlackPostError && REFUSED_TOKEN.has(error.slackError) && (entry === undefined || cached === entry)) cached = undefined;
      throw error;
    }
  };
}

/** chat.postMessage and chat.update on one cached bot token (E13). */
export function cachedSlackClient(loadToken: () => Promise<string>, now: () => number = Date.now, fetchImplementation: typeof fetch = fetch): {
  post: (input: PostInput) => Promise<{ ts: string; channel?: string }>;
  update: (input: UpdateInput) => Promise<void>;
  postEphemeral: (input: { channel: string; threadTs: string; user: string; text: string }) => Promise<void>;
} {
  const withToken = cachedBotToken(loadToken, now);
  return {
    post: (input) => withToken((token) => chatPostMessage(token, input, fetchImplementation)),
    update: (input) => withToken((token) => chatUpdate(token, input, fetchImplementation)),
    postEphemeral: (input) => withToken((token) => chatPostEphemeral(token, input, fetchImplementation)),
  };
}

/** chat.postMessage with the bot token cached for five minutes, and dropped when Slack refuses it. */
export function cachedSlackPoster(loadToken: () => Promise<string>, now: () => number = Date.now, fetchImplementation: typeof fetch = fetch): (input: PostInput) => Promise<{ ts: string; channel?: string }> {
  return cachedSlackClient(loadToken, now, fetchImplementation).post;
}

/** The Lambda's own dependencies, built on first use: the environment is read only then. */
function createAwsNotifierHandler() {
  const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const sqs = new SQSClient(awsClientConfiguration);
  const secretsManager = new SecretsManagerClient(awsClientConfiguration);
  const s3 = new S3Client(awsClientConfiguration);
  const queueUrl = () => requiredEnvironment("NOTICE_QUEUE_URL");
  const slack = cachedSlackClient(() => secretsManager.send(new GetSecretValueCommand({ SecretId: requiredEnvironment("SLACK_SECRET_ARN") }))
    .then((response) => parseSlackSecrets(response.SecretString ?? "").botToken));
  return createNotifierHandler({
    documentClient,
    tableName: requiredEnvironment("STATE_TABLE_NAME"),
    async enqueue(notices) {
      for (let start = 0; start < notices.length; start += 10) {
        const batch = notices.slice(start, start + 10);
        const result = await sqs.send(new SendMessageBatchCommand({
          QueueUrl: queueUrl(),
          // #217: a notice the notifier scheduled waits in the queue until its time.
          Entries: batch.map((notice, index) => {
            const delay = noticeDelaySeconds(notice, Date.now());
            return { Id: String(index), MessageBody: JSON.stringify(notice), ...(delay === 0 ? {} : { DelaySeconds: delay }) };
          }),
        }));
        // The stream mapping retries the whole batch; a notice queued twice still posts once (C9).
        if ((result.Failed ?? []).length > 0) throw new Error("some notices could not be queued");
      }
    },
    async retryLater(receiptHandle, seconds) {
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
    },
    post: slack.post,
    ...(process.env.CONTROL_PLANE_URL === undefined ? {} : { reviewUrlBase: process.env.CONTROL_PLANE_URL }),
    async readArtifact(key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: requiredEnvironment("ARTIFACT_BUCKET_NAME"), Key: key }));
      if (response.Body === undefined) throw new Error("workflow plan artifact has no body");
      return response.Body.transformToString("utf8");
    },
    createPlanCanvas(input, onCreated) {
      return cachedBotToken(() => secretsManager.send(new GetSecretValueCommand({ SecretId: requiredEnvironment("SLACK_SECRET_ARN") }))
        .then((response) => parseSlackSecrets(response.SecretString ?? "").botToken))((token) => createTaskPlanCanvas(token, input, fetch, onCreated));
    },
    update: slack.update,
    postEphemeral: slack.postEphemeral,
    now: Date.now,
    log: (entry) => console.log(JSON.stringify({ component: "developer-task-notifier", ...entry })),
    deliveryFailed: () => console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: requiredEnvironment("AGENTX_METRICS_NAMESPACE"), Dimensions: [[]], Metrics: [{ Name: "SlackDeliveryFailed", Unit: "Count" }] }] },
      component: "developer-task-notifier", event: "metric", SlackDeliveryFailed: 1,
    })),
  });
}

let awsHandler: ReturnType<typeof createNotifierHandler> | undefined;

/** The Lambda entry: the state table's stream and the notice queue both invoke it. */
export const handler = (event: { Records?: unknown[] }): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> => {
  awsHandler ??= createAwsNotifierHandler();
  return awsHandler(event);
};
