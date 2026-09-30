// Spec 025 FR-032, FR-034, C7 to C9: the DeveloperTaskNotifier, the only new reader of the Slack
// secret. The state table's stream (filtered in infra) brings changes, which become notices on the
// notifier's own queue; the queue brings each notice back, and it is posted once. Logs carry event
// names, IDs, notice kinds and Slack error codes only: never a token, a post's text or a task's text.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ChangeMessageVisibilityCommand, SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, PullRequestResultSchema, SHARE_DELIVERY_WINDOW_MS, indexExpiresAt, lastAssistantResponse, sharedTaskKey } from "@agentx/contracts";
import { readStream, type Notice, type StreamRecord } from "../developer/notifications.js";
import { CANCELLED_REPLY, CLOSED_REPLY, READY_REPLY, endedReply, modeReply, pullRequestReply, setupFailedReply, startMessage } from "../developer/share-messages.js";
import { deriveTaskStatus, failureCategory, taskKey, taskPointerKey, type DeveloperTaskPointerRecord, type DeveloperTaskRecord, type OperationFacts, type TaskShare } from "../developer/task-records.js";
import { isConditional } from "./broker-shared.js";
import { requiredEnvironment } from "./lambda.js";
import { parseSlackSecrets } from "./slack-ingress.js";
import { SlackPostError, chatPostMessage } from "./slack-web.js";

type Client = { send(command: unknown): Promise<unknown> };
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");
interface QueueRecord { eventSource: "aws:sqs"; messageId: string; receiptHandle: string; body: string; attributes?: { ApproximateReceiveCount?: string } }
interface PostInput { channel: string; threadTs?: string; text: string }

export interface NotifierDependencies {
  documentClient: Client;
  tableName: string;
  enqueue(notices: readonly Notice[]): Promise<void>;
  retryLater(receiptHandle: string, seconds: number): Promise<void>;
  post(input: PostInput): Promise<{ ts: string }>;
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

const NOTICE_KINDS = new Set(["start", "mode", "closed", "cancelled", "ready", "setup_failed", "ended", "pull_request"]);
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
    case "ended": {
      const ended = await operation();
      if (ended === undefined || !ENDED_STATUSES.has(ended.status)) return undefined;
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

interface NoticeMarker { deliveredAt?: string; postedTs?: string }

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
    const status = await currentStatus(deps, task);
    let ts: string;
    try {
      ({ ts } = await deps.post({
        channel: share.channelId,
        text: startMessage({ developerName: task.developerName, slackUserId: task.slackUserId, client: task.client, title: task.title, project: task.project, mode: share.mode, status, sharedReason: share.sharedReason }),
      }));
    } catch (error) {
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
  await deps.post({ channel: share.channelId, threadTs: share.threadTs, text });
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
        deps.log({ event: "developer_notifier.notice", kind: notice.kind, noticeId: notice.id, outcome: await deliver(deps, notice) });
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

/** chat.postMessage with the bot token cached for five minutes, and dropped when Slack refuses it. */
export function cachedSlackPoster(loadToken: () => Promise<string>, now: () => number = Date.now, fetchImplementation: typeof fetch = fetch): (input: PostInput) => Promise<{ ts: string }> {
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
  return async (input) => {
    const entry = cached;
    try {
      return await chatPostMessage(await token(), input, fetchImplementation);
    } catch (error) {
      if (error instanceof SlackPostError && REFUSED_TOKEN.has(error.slackError) && (entry === undefined || cached === entry)) cached = undefined;
      throw error;
    }
  };
}

/** The Lambda's own dependencies, built on first use: the environment is read only then. */
function createAwsNotifierHandler() {
  const awsClientConfiguration = process.env.AWS_REGION === undefined ? {} : { region: process.env.AWS_REGION };
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfiguration), { marshallOptions: { removeUndefinedValues: true } });
  const sqs = new SQSClient(awsClientConfiguration);
  const secretsManager = new SecretsManagerClient(awsClientConfiguration);
  const queueUrl = () => requiredEnvironment("NOTICE_QUEUE_URL");
  const post = cachedSlackPoster(() => secretsManager.send(new GetSecretValueCommand({ SecretId: requiredEnvironment("SLACK_SECRET_ARN") }))
    .then((response) => parseSlackSecrets(response.SecretString ?? "").botToken));
  return createNotifierHandler({
    documentClient,
    tableName: requiredEnvironment("STATE_TABLE_NAME"),
    async enqueue(notices) {
      for (let start = 0; start < notices.length; start += 10) {
        const batch = notices.slice(start, start + 10);
        const result = await sqs.send(new SendMessageBatchCommand({
          QueueUrl: queueUrl(),
          Entries: batch.map((notice, index) => ({ Id: String(index), MessageBody: JSON.stringify(notice) })),
        }));
        // The stream mapping retries the whole batch; a notice queued twice still posts once (C9).
        if ((result.Failed ?? []).length > 0) throw new Error("some notices could not be queued");
      }
    },
    async retryLater(receiptHandle, seconds) {
      await sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queueUrl(), ReceiptHandle: receiptHandle, VisibilityTimeout: seconds }));
    },
    post,
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
