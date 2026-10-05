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
import { INDEX_EXPIRY_ATTRIBUTE, AdminChangePendingRecordSchema, PullRequestResultSchema, SHARE_DELIVERY_WINDOW_MS, adminChangeKey, indexExpiresAt, lastAssistantResponse, sharedTaskKey, type PendingChange } from "@agentx/contracts";
import { adminChangeExpiredMessage, adminChangeMessage, adminChangeOutcomeMessage } from "../developer/change-messages.js";
import { readStream, type Notice, type StreamRecord } from "../developer/notifications.js";
import { CANCELLED_REPLY, CLOSED_REPLY, READY_REPLY, endedReply, modeReply, pullRequestReply, setupFailedReply, startMessage } from "../developer/share-messages.js";
import { deriveTaskStatus, failureCategory, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type OperationFacts, type TaskShare } from "../developer/task-records.js";
import { isConditional } from "./broker-shared.js";
import { requiredEnvironment } from "./lambda.js";
import { parseSlackSecrets } from "./slack-ingress.js";
import { SlackPostError, chatPostMessage, chatUpdate, createTaskPlanCanvas, postMayHaveLanded } from "./slack-web.js";

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
  /** Creates a channel-readable detail page and returns Slack's verified link. */
  createPlanCanvas?(input: { channel: string; taskId: string; title: string; version: number; markdown: string }): Promise<{ canvasId: string; permalink: string }>;
  /** Spec 025 E13: chat.update, to edit an admin change's message when it ends. */
  update?(input: UpdateInput): Promise<void>;
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

const NOTICE_KINDS = new Set(["start", "mode", "closed", "cancelled", "ready", "setup_failed", "ended", "pull_request", "workflow", "github_feedback", "admin_change_dm", "admin_change_outcome", "admin_change_expiry"]);

/**
 * #217: how long after a change's expiry its message is edited. The broker refuses a claim at or
 * after `expiresAt` by its own clock; the margin keeps a press in the last second, read by a
 * Lambda whose clock runs a little ahead, from being shown as expired.
 */
export const ADMIN_CHANGE_EXPIRY_GRACE_MS = 5_000;
/** SQS's longest per-message delay. */
const MAX_DELAY_SECONDS = 900;
const slackText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

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

async function putMarker(deps: NotifierDependencies, marker: { pk: string; sk: string }): Promise<void> {
  try {
    await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, Item: { ...marker, entityType: "NOTICE", deliveredAt: new Date(deps.now()).toISOString(), ...noticeExpiry(deps) }, ConditionExpression: MARKER_CONDITION }));
  } catch (error) {
    if (!isConditional(error)) throw error;
  }
}

const noticeMarker = (taskId: string, noticeId: string) => ({ pk: `DEVTASK#${taskId}`, sk: `NOTICE#${noticeId}` });

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

async function replyText(deps: NotifierDependencies, task: DeveloperTaskRecord & { share: TaskShare }, notice: Notice): Promise<string | undefined> {
  const operation = async () => (notice.workspaceId === undefined || notice.operationId === undefined
    ? undefined
    : getItem<{ id: string; kind: string; status: string; error?: string; result?: unknown }>(deps, { pk: `WORKSPACE#${notice.workspaceId}`, sk: `OPERATION#${notice.operationId}` }));
  switch (notice.kind) {
    case "ready": return READY_REPLY;
    case "cancelled": return CANCELLED_REPLY;
    case "closed": return CLOSED_REPLY;
    // A change a later one replaced is not said: the later notice says the current mode.
    case "mode": return notice.mode === task.share.mode ? modeReply(task.share.mode) : undefined;
    case "setup_failed": return setupFailedReply((await operation())?.error);
    case "pull_request": {
      const published = PullRequestResultSchema.safeParse((await operation())?.result);
      return published.success ? pullRequestReply(published.data.url) : undefined;
    }
    case "workflow": {
      const workflow = task.workflow;
      if (workflow === undefined) return undefined;
      if (workflow.feedback?.status === "APPROVED") return "Approved. AgentX is addressing the PR feedback and will rerun required checks and reviews.";
      if (workflow.feedback?.status === "DISMISSED") return "Dismissed. AgentX made no code changes for this feedback.";
      if (workflow.stage === "PLAN" && workflow.state === "RUNNING") return "Thanks. AgentX is revising the plan based on your feedback. It will post the updated plan here for review.";
      if (workflow.stage === "IMPLEMENT" && workflow.state === "RUNNING") return "Plan approved. AgentX is starting the implementation.";
      if (workflow.stage === "MERGED" && workflow.state === "COMPLETE") {
        const total = workflow.pullRequests?.filter((pullRequest) => pullRequest.required).length ?? 0;
        return total > 0 ? `GitHub confirms all ${total} required pull requests are merged. The task is complete.` : undefined;
      }
      if (workflow.stage === "WAIT_FOR_MERGE" && workflow.state === "WAITING") {
        const required = workflow.pullRequests?.filter((pullRequest) => pullRequest.required) ?? [];
        if (required.length === 0) return undefined;
        const merged = required.filter((pullRequest) => pullRequest.state === "MERGED").length;
        const waiting = required.filter((pullRequest) => pullRequest.state !== "MERGED");
        const progress = `GitHub update: ${merged} of ${required.length} pull requests ${merged === 1 ? "is" : "are"} merged.`;
        const remaining = waiting.map((pullRequest) => ` <${pullRequest.url}|PR #${pullRequest.number}> is still ${pullRequest.state === "CLOSED" ? "closed" : "open"}.`).join("");
        return `${progress}${remaining}`;
      }
      if (workflow.state === "COMPLETE") return "This workflow is closed. No more work will run from this plan.";
      if (workflow.state === "BLOCKED") return "The workflow is blocked. AgentX has stopped and needs attention before it can continue.";
      return undefined;
    }
    case "github_feedback": {
      const feedback = task.workflow?.feedback;
      if (feedback?.status !== "PENDING" || feedback.feedbackId !== notice.id.split(":").at(-1)) return undefined;
      const comment = feedback.comments.at(-1);
      if (comment === undefined) return undefined;
      const excerpt = comment.body.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 180);
      const more = comment.body.trim().length > 180 ? "…" : "";
      return `PR #${feedback.number} feedback from ${slackText(comment.author)}: “${slackText(excerpt)}${more}” <${comment.url}|open comment>. Proposed: ${feedback.proposedPlan}`;
    }
    case "ended": {
      const ended = await operation();
      if (ended === undefined || !ENDED_STATUSES.has(ended.status)) return undefined;
      if (task.workflow?.stage === "PLAN_REVIEW" && task.workflow.state === "WAITING") {
        const plan = task.workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
        if (plan === undefined || deps.readArtifact === undefined || deps.createPlanCanvas === undefined) {
          return "The plan is ready for review, but AgentX couldn't prepare its Slack details link. No code changes have started. Ask an administrator to check the Slack Canvas setup.";
        }
        const markdown = await deps.readArtifact(plan.objectKey);
        if (createHash("sha256").update(markdown, "utf8").digest("hex") !== plan.sha256) {
          return "The plan is ready, but its saved copy failed an integrity check. No code changes have started. Ask an administrator to investigate.";
        }
        let canvas: { canvasId: string; permalink: string };
        try {
          canvas = await deps.createPlanCanvas({ channel: task.share.channelId, taskId: task.taskId, title: task.title, version: plan.version, markdown });
        } catch (error) {
          if (error instanceof SlackPostError && [
            "missing_scope", "not_allowed_token_type", "feature_not_enabled", "method_not_supported_for_channel_type",
            "canvas_disabled_user_team", "canvas_disabled_file_team", "canvas_globally_disabled",
            "free_teams_cannot_create_standalone_canvases", "team_tier_cannot_create_channel_canvases",
          ].includes(error.slackError)) {
            return "The plan is ready, but Slack couldn't open its detail page. Ask an administrator to enable Canvas access for AgentX. No code changes have started.";
          }
          throw error;
        }
        return `The plan is ready. No code changes have started. <${canvas.permalink}|Read the plan and checks>.`;
      }
      if (task.workflow?.stage === "VERIFY" && task.workflow.state === "BLOCKED") {
        return "AgentX finished implementation, but the task is blocked until candidate-bound checks and review are available. The pull request has not been opened.";
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
      return endedReply({
        kind: ended.kind,
        status: ended.status,
        ...(failed ? { failure: { category: failureCategory(ended.kind, ended.status, ended.error), message: ended.error ?? `the ${ended.kind} operation ended ${ended.status}` } } : {}),
        ...(summary === undefined ? {} : { summary }),
      });
    }
    default: return undefined;
  }
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

interface NoticeMarker { deliveredAt?: string; postedTs?: string; postingUntil?: number }

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

async function deliver(deps: NotifierDependencies, notice: Notice): Promise<Outcome> {
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
  if (delivered?.deliveredAt !== undefined) return "delivered";
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
  const text = await replyText(deps, { ...task, share }, notice);
  if (text === undefined) return "stale";
  // Accepted: a close that commits while this reply is being posted can put this one reply after
  // "closed". The checks above read the task before the post; at most one reply per notice lands late.
  const workflow = task.workflow;
  const plan = workflow?.artifacts.filter((artifact) => artifact.type === "plan").at(-1);
  const feedback = workflow?.feedback;
  const feedbackNotice = notice.kind === "github_feedback" && feedback?.status === "PENDING" && feedback.feedbackId === notice.id.split(":").at(-1);
  const blocks = feedbackNotice && feedback !== undefined
    ? [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "actions", elements: [
          { type: "button", action_id: "agentx_github_feedback_approve", style: "primary", text: { type: "plain_text", text: "Approve and address" }, value: JSON.stringify({ taskId: task.taskId, revision: workflow!.revision, feedbackId: feedback.feedbackId, candidateDigest: feedback.candidateDigest, decision: "APPROVE" }) },
          { type: "button", action_id: "agentx_github_feedback_dismiss", text: { type: "plain_text", text: "Dismiss" }, value: JSON.stringify({ taskId: task.taskId, revision: workflow!.revision, feedbackId: feedback.feedbackId, candidateDigest: feedback.candidateDigest, decision: "REQUEST_CHANGES" }) },
        ] },
      ]
    : notice.kind === "ended" && workflow?.stage === "PLAN_REVIEW" && workflow.state === "WAITING" && plan !== undefined
    ? [
        { type: "section", text: { type: "mrkdwn", text } },
        { type: "actions", elements: [
          { type: "button", action_id: "agentx_workflow_approve", style: "primary", text: { type: "plain_text", text: "Approve plan" }, value: JSON.stringify({ taskId: task.taskId, revision: workflow.revision, digest: plan.sha256, decision: "APPROVE" }) },
          { type: "button", action_id: "agentx_workflow_changes", text: { type: "plain_text", text: "Request changes" }, value: JSON.stringify({ taskId: task.taskId, revision: workflow.revision, digest: plan.sha256, decision: "REQUEST_CHANGES" }) },
        ] },
      ]
    : undefined;
  await deps.post({ channel: share.channelId, threadTs: share.threadTs, text, ...(blocks === undefined ? {} : { blocks }) });
  await putMarker(deps, marker);
  return "posted";
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
} {
  const withToken = cachedBotToken(loadToken, now);
  return {
    post: (input) => withToken((token) => chatPostMessage(token, input, fetchImplementation)),
    update: (input) => withToken((token) => chatUpdate(token, input, fetchImplementation)),
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
    async readArtifact(key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: requiredEnvironment("ARTIFACT_BUCKET_NAME"), Key: key }));
      if (response.Body === undefined) throw new Error("workflow plan artifact has no body");
      return response.Body.transformToString("utf8");
    },
    createPlanCanvas(input) {
      return cachedBotToken(() => secretsManager.send(new GetSecretValueCommand({ SecretId: requiredEnvironment("SLACK_SECRET_ARN") }))
        .then((response) => parseSlackSecrets(response.SecretString ?? "").botToken))((token) => createTaskPlanCanvas(token, input));
    },
    update: slack.update,
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
