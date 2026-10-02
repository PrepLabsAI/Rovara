// Spec 043: SWE-bench runs from Slack. The broker records each run, holds it a slot under the
// deployment's limit on concurrent runs (spec 052), writes the run's launch file, starts the eval
// state machine, and applies the runner's callbacks. The Slack service polls the run and posts to
// the thread; the broker never holds a Slack token (D11).
import { createHmac, timingSafeEqual } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  SWEBENCH_COST_CEILING_DEFAULT_USD,
  SWEBENCH_RUN_TIME_LIMIT_SECONDS,
  SWEBENCH_TERMINAL_STATUSES,
  SwebenchCapabilityClaimsSchema,
  SwebenchChannelRequestSchema,
  SwebenchChannelSchema,
  SwebenchLaunchSchema,
  SwebenchRunResultSchema,
  SwebenchRunSchema,
  SwebenchStartRequestSchema,
  agentXError,
  modelSelectionFor,
  slackThreadSubject,
  type ModelIdentifier,
  type ModelSelection,
  type SlackRequester,
  type SlackThread,
  type SwebenchChannel,
  type SwebenchLaunch,
  type SwebenchRun,
  type SwebenchRunResult,
  type SwebenchSettings,
  type SwebenchStartResult,
} from "@agentx/contracts";

/** What a run needs from the deployment; undefined when the eval stack or runner image is not installed. */
export interface SwebenchDeployment {
  settings: SwebenchSettings;
  runnerImage: string;
  /** The worker settings' model, used when the channel's project approves none. */
  defaultModel: ModelIdentifier;
  environment: SwebenchLaunch["environment"];
  /**
   * Spec 053: the optional run fields the runner image's build parses, as its release recorded them;
   * empty for an image released before them. The runner parses its run strictly.
   */
  runnerFeatures: readonly string[];
}

export interface SwebenchDependencies {
  documentClient: DynamoDBDocumentClient;
  s3: Pick<S3Client, "send">;
  tableName: string;
  artifactBucketName: string;
  callbackSigningKey: string;
  deployment: () => Promise<SwebenchDeployment | undefined>;
  startExecution: (input: { stateMachineArn: string; name: string; input: string }) => Promise<void>;
  /**
   * Spec 052: stops the thread's eval batch, if it has one, and returns the batch ID it stopped.
   * Called by every stop, since a batch between runs holds no slot; absent, no batch is stopped.
   */
  stopBatchForThread?: (thread: SlackThread, requester: SlackRequester) => Promise<string | undefined>;
  /**
   * Spec 052: told of each run the runner's result ended, after its slot is released, so its batch
   * records it and the freed slot is filled. Its errors are logged, never answered: the result is
   * already recorded, and the batch tick records a run end this missed.
   */
  onRunEnded?: (run: SwebenchRun, result: SwebenchRunResult) => Promise<void>;
  now?: () => Date;
}

/** Spec 052: what a batch pins for its runs; a single run takes the deployment's current values. */
export interface SwebenchStartOptions {
  batchId?: string;
  /** The batch's pinned runner image, an ECR image pinned by digest. */
  runnerImage?: string;
  /** The run fields that image parses; the deployment's are used when the image is the current one. */
  runnerFeatures?: readonly string[];
  /** The batch's per-run ceiling, so the cap math and the runner agree. */
  maxCostUsd?: number;
  /** The model's OpenRouter provider pin, in place of the deployment's. */
  openRouterProviders?: readonly string[];
}

/** The Slack context a service route acts in: the thread, its requester and the channel's project. */
export interface SwebenchSlackContext {
  thread: SlackThread;
  requester: SlackRequester;
  projectName: string;
  /**
   * The project's approved model a run may use, with that entry's thinking level when it has one: the
   * requested one if approved, else the current one; undefined when the project approves none.
   */
  projectModel: (requested: ModelIdentifier | undefined) => Promise<ModelSelection | undefined>;
}

/**
 * Spec 052 FR-005: the number of runs holding a slot, against the deployment's maxConcurrentEvals.
 * Each run holds one slot item; a release deletes it and decrements the counter in one
 * transaction, so a run's slot is released once, by the broker or by the state machine.
 */
const SLOT_COUNTER_KEY = { pk: "SWEBENCH#SLOTS", sk: "COUNTER" } as const;
const SLOT_PK = "SWEBENCH#SLOT";
/** The one-run lock before spec 052: a run that started under it is stopped by it, and deletes it as it ends. */
const LEGACY_LOCK_KEY = { pk: "SWEBENCH#ACTIVE", sk: "LOCK" } as const;
/** A release refused while the run is active and its slot held (a conflict on the counter) is tried this many times. */
const RELEASE_ATTEMPTS = 3;
/** The pause before a release is tried again: this much, times the attempt, plus up to as much again at random. */
const RELEASE_BACKOFF_MS = 25;
const CAPABILITY_CONTEXT = "agentx swebench capability v1";
/** The capability outlives the run's two-hour ceiling, so a late result is still accepted once. */
const CAPABILITY_SECONDS = SWEBENCH_RUN_TIME_LIMIT_SECONDS + 60 * 60;
const ACTIVE_STATUSES = ["STARTING", "RUNNING", "CANCEL_REQUESTED"] as const;

export function swebenchChannelKey(teamId: string, channelId: string) {
  return { pk: `SWEBENCH#CHANNEL#${teamId}`, sk: `CHANNEL#${channelId}` };
}

export function swebenchRunKey(runId: string) {
  return { pk: `SWEBENCH_RUN#${runId}`, sk: "META" };
}

export function swebenchSlotKey(runId: string) {
  return { pk: SLOT_PK, sk: `RUN#${runId}` };
}

/** Spec 052: how many runs hold a slot, by the counter; a start re-checks it atomically. */
export async function swebenchSlotsInUse(dependencies: SwebenchDependencies): Promise<number> {
  const counter = await get(dependencies, SLOT_COUNTER_KEY);
  return typeof counter?.count === "number" ? counter.count : 0;
}

/** FR-002: an administrator enables a bound channel, with its cost ceiling. */
export async function putSwebenchChannel(
  dependencies: SwebenchDependencies,
  teamId: string,
  channelId: string,
  value: unknown,
): Promise<SwebenchChannel> {
  const request = SwebenchChannelRequestSchema.parse(value ?? {});
  const channel = SwebenchChannelSchema.parse({
    teamId, channelId,
    maxCostUsd: request.maxCostUsd ?? SWEBENCH_COST_CEILING_DEFAULT_USD,
    updatedAt: now(dependencies).toISOString(),
  });
  await dependencies.documentClient.send(new PutCommand({
    TableName: dependencies.tableName,
    Item: { ...swebenchChannelKey(teamId, channelId), entityType: "SWEBENCH_CHANNEL", ...channel },
  }));
  return channel;
}

export async function deleteSwebenchChannel(dependencies: SwebenchDependencies, teamId: string, channelId: string): Promise<{ deleted: boolean }> {
  const existing = await get(dependencies, swebenchChannelKey(teamId, channelId));
  if (existing === undefined) return { deleted: false };
  await dependencies.documentClient.send(new DeleteCommand({ TableName: dependencies.tableName, Key: swebenchChannelKey(teamId, channelId) }));
  return { deleted: true };
}

export async function getSwebenchChannel(dependencies: SwebenchDependencies, teamId: string, channelId: string): Promise<SwebenchChannel | undefined> {
  const item = await get(dependencies, swebenchChannelKey(teamId, channelId));
  if (item === undefined) return undefined;
  return SwebenchChannelSchema.parse(withoutKeys(item, ["pk", "sk", "entityType"]));
}

/**
 * FR-001 to FR-006: starts a run for the thread. The request ID is the run ID, so a redelivered
 * Slack event finds the run it already started.
 */
export async function startSwebenchRun(
  dependencies: SwebenchDependencies,
  context: SwebenchSlackContext,
  value: unknown,
  options: SwebenchStartOptions = {},
): Promise<SwebenchStartResult> {
  const request = SwebenchStartRequestSchema.parse(value);
  const runId = request.requestId;
  const existing = await readRun(dependencies, runId);
  if (existing !== undefined) {
    if (slackThreadSubject(existing.thread) !== slackThreadSubject(context.thread)) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID belongs to another thread's run");
    return { outcome: "STARTED", run: existing };
  }
  const deployment = await dependencies.deployment();
  if (deployment === undefined) {
    return { outcome: "REFUSED", reason: "NOT_INSTALLED", message: "Eval runs are not installed in this deployment. Ask an administrator to deploy the eval stack and runner image." };
  }
  const channel = await getSwebenchChannel(dependencies, context.thread.teamId, context.thread.channelId);
  if (channel === undefined) {
    return { outcome: "REFUSED", reason: "NOT_ENABLED", message: "Eval runs are not enabled in this channel. An administrator can enable them with `agentx admin eval enable`." };
  }
  const runnerImage = options.runnerImage ?? deployment.runnerImage;
  const runnerFeatures = runnerImage === deployment.runnerImage ? deployment.runnerFeatures : options.runnerFeatures ?? [];
  // The record says what the runner was given: no level when the runner image cannot parse one.
  const model = modelSelectionFor(await context.projectModel(request.model) ?? deployment.defaultModel, runnerFeatures);
  const createdAt = now(dependencies).toISOString();
  const run: SwebenchRun = SwebenchRunSchema.parse({
    runId,
    dataset: request.dataset,
    instanceId: request.instanceId,
    model,
    maxCostUsd: options.maxCostUsd ?? channel.maxCostUsd,
    thread: context.thread,
    requestedBy: context.requester,
    status: "STARTING",
    createdAt,
    updatedAt: createdAt,
    ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
    ...(options.runnerImage === undefined ? {} : { runnerImage }),
  });
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: dependencies.tableName, Item: { ...swebenchRunKey(runId), entityType: "SWEBENCH_RUN", projectName: context.projectName, ...run }, ConditionExpression: "attribute_not_exists(pk)" } },
        {
          Update: {
            TableName: dependencies.tableName,
            Key: SLOT_COUNTER_KEY,
            UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one",
            ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
            ExpressionAttributeNames: { "#count": "count" },
            ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": deployment.settings.maxConcurrentEvals },
          },
        },
        {
          Put: {
            TableName: dependencies.tableName,
            Item: {
              ...swebenchSlotKey(runId), entityType: "SWEBENCH_SLOT", runId, threadSubject: slackThreadSubject(context.thread), startedAt: createdAt,
              ...(options.batchId === undefined ? {} : { batchId: options.batchId }),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      ],
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    // A concurrent delivery of the same request, or no free slot.
    const raced = await readRun(dependencies, runId);
    if (raced !== undefined) return { outcome: "STARTED", run: raced };
    const counter = await get(dependencies, SLOT_COUNTER_KEY);
    return refusedActive(typeof counter?.count === "number" ? counter.count : 0);
  }
  const artifactsPrefix = `evals/${runId}/`;
  try {
    const launch = SwebenchLaunchSchema.parse({
      runnerImage,
      logGroupName: deployment.settings.logGroupName,
      environment: options.openRouterProviders === undefined
        ? deployment.environment
        : { ...deployment.environment, AGENTX_OPENROUTER_PROVIDERS: options.openRouterProviders.join(",") },
      run: {
        runId,
        dataset: run.dataset,
        instanceId: run.instanceId,
        model,
        maxCostUsd: run.maxCostUsd,
        controlPlaneUrl: deployment.settings.controlPlaneUrl,
        capability: issueSwebenchCapability(dependencies, runId),
        artifactBucket: dependencies.artifactBucketName,
        artifactsPrefix,
      },
    });
    await dependencies.s3.send(new PutObjectCommand({
      Bucket: dependencies.artifactBucketName,
      Key: `${artifactsPrefix}launch.json`,
      Body: JSON.stringify(launch),
      ContentType: "application/json",
    }));
    const subnets = deployment.settings.subnetIds;
    await dependencies.startExecution({
      stateMachineArn: deployment.settings.stateMachineArn,
      name: runId,
      input: JSON.stringify({ runId, subnetId: subnets[Math.floor(Math.random() * subnets.length)] }),
    });
  } catch (error) {
    await finishRun(dependencies, runId, { status: "FAILED", error: `the run could not start: ${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined);
    throw error;
  }
  return { outcome: "STARTED", run };
}

/** The Slack service's poll: a run, only from the thread that started it. */
export async function getSwebenchRunForThread(dependencies: SwebenchDependencies, thread: SlackThread, runId: string): Promise<SwebenchRun> {
  const run = await readRun(dependencies, runId);
  if (run === undefined || slackThreadSubject(run.thread) !== slackThreadSubject(thread)) throw agentXError("NOT_FOUND", "SWE-bench run not found");
  return run;
}

/**
 * FR-005: a thread's stop cancels its active runs; the state machine terminates their instances.
 * Spec 052: the thread's runs are those holding a slot for it, and its batch, if any, stops too.
 * The runs are cancelled first, so a failing batch hook cannot keep them running; the slots are read
 * again after the hook, so a run the batch started meanwhile is cancelled too. Returns the first run
 * it cancelled, else the batch it stopped.
 */
export async function stopSwebenchRun(dependencies: SwebenchDependencies, thread: SlackThread, requester: SlackRequester): Promise<string | undefined> {
  const runIds = await threadRunIds(dependencies, thread);
  for (const runId of runIds) await requestCancel(dependencies, runId, requester);
  let batchId: string | undefined;
  if (dependencies.stopBatchForThread !== undefined) {
    try {
      batchId = await dependencies.stopBatchForThread(thread, requester);
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "swebench.stop_batch_failed", error: error instanceof Error ? error.message : String(error) }));
    }
    for (const runId of await threadRunIds(dependencies, thread)) {
      if (runIds.includes(runId)) continue;
      runIds.push(runId);
      await requestCancel(dependencies, runId, requester);
    }
  }
  return runIds[0] ?? batchId;
}

/** The thread's runs that hold a slot, and a still-active run that holds the one-run lock. */
async function threadRunIds(dependencies: SwebenchDependencies, thread: SlackThread): Promise<string[]> {
  const subject = slackThreadSubject(thread);
  // At most maxConcurrentEvals (6) slot items exist, so a filtered read of the partition is cheap.
  const slots = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :run)",
    FilterExpression: "threadSubject = :thread",
    ExpressionAttributeValues: { ":pk": SLOT_PK, ":run": "RUN#", ":thread": subject },
    ConsistentRead: true,
  }));
  const runIds = (slots.Items ?? []).map((item): unknown => item.runId).filter((runId): runId is string => typeof runId === "string");
  const legacy = await get(dependencies, LEGACY_LOCK_KEY);
  if (typeof legacy?.runId === "string" && legacy.threadSubject === subject && !runIds.includes(legacy.runId)) {
    // A lock can outlive its run (one ended before its release deleted it): only an active run counts.
    const run = await readRun(dependencies, legacy.runId);
    if (run !== undefined && (ACTIVE_STATUSES as readonly string[]).includes(run.status)) runIds.push(legacy.runId);
  }
  return runIds;
}

/** Asks an active run to stop; a run already ending or ended, or none at all, is left as it is. */
export async function requestCancel(dependencies: SwebenchDependencies, runId: string, requester: SlackRequester): Promise<void> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: swebenchRunKey(runId),
      UpdateExpression: "SET #status = :cancel, updatedAt = :now, cancelRequestedBy = :requester",
      ConditionExpression: "#status = :starting OR #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":cancel": "CANCEL_REQUESTED", ":now": now(dependencies).toISOString(), ":requester": requester, ":starting": "STARTING", ":running": "RUNNING" },
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
  }
}

export function isSwebenchCallbackPath(pathname: string): { runId: string; action: "started" | "result" } | undefined {
  const match = /^\/v1\/internal\/evals\/([0-9a-f-]{36})\/(started|result)$/.exec(pathname);
  return match ? { runId: match[1]!, action: match[2] as "started" | "result" } : undefined;
}

/** FR-007: the runner's callbacks, authorized by the run's capability. */
export async function handleSwebenchCallback(
  dependencies: SwebenchDependencies,
  capability: string | undefined,
  runId: string,
  action: "started" | "result",
  body: unknown,
): Promise<{ run: SwebenchRun }> {
  verifySwebenchCapability(dependencies, capability, runId);
  const run = await readRun(dependencies, runId);
  if (run === undefined) throw agentXError("NOT_FOUND", "SWE-bench run not found");
  if (action === "started") {
    try {
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName,
        Key: swebenchRunKey(runId),
        UpdateExpression: "SET #status = :running, updatedAt = :now, runnerStartedAt = :now",
        ConditionExpression: "#status = :starting",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":running": "RUNNING", ":starting": "STARTING", ":now": now(dependencies).toISOString() },
      }));
    } catch (error) {
      // Already running, cancelling or finished: the report changes nothing but the record that the
      // runner started (spec 052: a run cancelled before it started is charged nothing).
      if (!isConditionFailure(error)) throw error;
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName,
        Key: swebenchRunKey(runId),
        UpdateExpression: "SET runnerStartedAt = :now",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(runnerStartedAt)",
        ExpressionAttributeValues: { ":now": now(dependencies).toISOString() },
      })).catch((failure: unknown) => { if (!isConditionFailure(failure)) throw failure; });
    }
    return { run: (await readRun(dependencies, runId)) ?? run };
  }
  const result = SwebenchRunResultSchema.parse(body);
  await finishRun(dependencies, runId, result.outcome === "GRADED"
    ? { status: "SUCCEEDED", result }
    : { status: "FAILED", error: result.error, ...(result.usage === undefined ? {} : { usage: result.usage }) });
  const ended = (await readRun(dependencies, runId)) ?? run;
  if (dependencies.onRunEnded !== undefined && SWEBENCH_TERMINAL_STATUSES.has(ended.status)) {
    try {
      await dependencies.onRunEnded(ended, result);
    } catch (error) {
      console.log(JSON.stringify({ component: "broker", event: "swebench.run_ended_hook_failed", runId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { run: ended };
}

/**
 * Moves an active run to its terminal status and releases its slot in one transaction: the slot
 * item is deleted and the counter decremented only if the slot item exists, so the state machine's
 * EndRun (the same transaction) and a repeated result release it once between them. A run already
 * terminal is left as it is, so a repeated result is harmless. A run with no slot item started
 * under the one-run lock, before spec 052: it is ended without a release.
 */
async function finishRun(
  dependencies: SwebenchDependencies,
  runId: string,
  outcome: { status: "SUCCEEDED"; result: unknown } | { status: "FAILED"; error: string; usage?: unknown },
): Promise<void> {
  const at = now(dependencies).toISOString();
  const values: Record<string, unknown> = { ":status": outcome.status, ":now": at };
  ACTIVE_STATUSES.forEach((status, index) => { values[`:active${index}`] = status; });
  // RESULT and STATUS are DynamoDB reserved words, so every attribute here goes through a name.
  const failedUsage = outcome.status === "FAILED" && outcome.usage !== undefined;
  const set = outcome.status === "SUCCEEDED" ? "#result = :result" : `#error = :error${failedUsage ? ", #usage = :usage" : ""}`;
  if (outcome.status === "SUCCEEDED") values[":result"] = outcome.result;
  else {
    values[":error"] = outcome.error.slice(0, 2_000);
    // Spec 052: kept on the run, so whoever records the run's end in its batch has its cost.
    if (failedUsage) values[":usage"] = outcome.usage;
  }
  const endRun = {
    Update: {
      TableName: dependencies.tableName,
      Key: swebenchRunKey(runId),
      UpdateExpression: `SET #status = :status, updatedAt = :now, finishedAt = :now, ${set}`,
      ConditionExpression: ACTIVE_STATUSES.map((_, index) => `#status = :active${index}`).join(" OR "),
      ExpressionAttributeNames: {
        "#status": "status",
        ...(outcome.status === "FAILED" ? { "#error": "error", ...(failedUsage ? { "#usage": "usage" } : {}) } : { "#result": "result" }),
      },
      ExpressionAttributeValues: values,
    },
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      await dependencies.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          endRun,
          { Delete: { TableName: dependencies.tableName, Key: swebenchSlotKey(runId), ConditionExpression: "attribute_exists(pk)" } },
          {
            Update: {
              TableName: dependencies.tableName,
              Key: SLOT_COUNTER_KEY,
              UpdateExpression: "SET #count = #count - :one",
              ConditionExpression: "#count > :zero",
              ExpressionAttributeNames: { "#count": "count" },
              ExpressionAttributeValues: { ":one": 1, ":zero": 0 },
            },
          },
        ],
      }));
      return;
    } catch (error) {
      if (!isTransactionCancelled(error)) throw error;
      // Read back why, as the state machine does: the reasons a cancellation carries are not enough
      // to tell a conflict on the counter from a failed condition.
      const current = await readRun(dependencies, runId);
      if (current === undefined) throw agentXError("NOT_FOUND", "SWE-bench run not found");
      if (SWEBENCH_TERMINAL_STATUSES.has(current.status)) return;
      if (await get(dependencies, swebenchSlotKey(runId)) === undefined) return endRunWithoutSlot(dependencies, runId, endRun);
      // Spec 052 Ruling 3: retryable. The runner treats any other 4xx but 429 as final and would
      // drop a graded result; the broker's catch-all would answer this cancellation 400.
      if (attempt >= RELEASE_ATTEMPTS) throw agentXError("RUNTIME_UNAVAILABLE", "the run's eval slot could not be released; try again shortly");
      await new Promise((resolve) => setTimeout(resolve, RELEASE_BACKOFF_MS * attempt * (1 + Math.random())));
    }
  }
}

/**
 * The migration case: a run that holds no slot started under the one-run lock. It is ended with that
 * lock deleted, as before spec 052, and the counter is left as it is.
 */
async function endRunWithoutSlot(dependencies: SwebenchDependencies, runId: string, endRun: { Update: Record<string, unknown> }): Promise<void> {
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        endRun as never,
        {
          Delete: {
            TableName: dependencies.tableName,
            Key: LEGACY_LOCK_KEY,
            ConditionExpression: "attribute_not_exists(pk) OR runId = :runId",
            ExpressionAttributeValues: { ":runId": runId },
          },
        },
      ],
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    const current = await readRun(dependencies, runId);
    if (current === undefined || !SWEBENCH_TERMINAL_STATUSES.has(current.status)) throw error;
  }
}

export function issueSwebenchCapability(dependencies: Pick<SwebenchDependencies, "callbackSigningKey" | "now">, runId: string): string {
  const claims = SwebenchCapabilityClaimsSchema.parse({
    kind: "swebench",
    runId,
    expiresAt: Math.floor(now(dependencies).getTime() / 1_000) + CAPABILITY_SECONDS,
  });
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", capabilityKey(dependencies.callbackSigningKey)).update(body).digest("base64url")}`;
}

function verifySwebenchCapability(dependencies: Pick<SwebenchDependencies, "callbackSigningKey" | "now">, token: string | undefined, runId: string): void {
  const [body, signature, extra] = (token ?? "").split(".");
  if (!body || !signature || extra !== undefined) throw agentXError("CALLBACK_FORBIDDEN", "invalid eval capability");
  const expected = createHmac("sha256", capabilityKey(dependencies.callbackSigningKey)).update(body).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw agentXError("CALLBACK_FORBIDDEN", "invalid eval capability signature");
  const claims = SwebenchCapabilityClaimsSchema.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  if (!claims.success || claims.data.runId !== runId || claims.data.expiresAt <= Math.floor(now(dependencies).getTime() / 1_000)) {
    throw agentXError("CALLBACK_FORBIDDEN", "eval capability does not allow this run");
  }
}

/** A key derived for evals, so an eval capability never verifies as a workspace capability, nor the reverse. */
function capabilityKey(callbackSigningKey: string): Buffer {
  return createHmac("sha256", callbackSigningKey).update(CAPABILITY_CONTEXT).digest();
}

export async function readRun(dependencies: SwebenchDependencies, runId: string): Promise<SwebenchRun | undefined> {
  const item = await get(dependencies, swebenchRunKey(runId));
  if (item === undefined) return undefined;
  // The state machine records the EC2 instance as ec2InstanceId; the run's instanceId is SWE-bench's.
  return SwebenchRunSchema.parse(withoutKeys(item, ["pk", "sk", "entityType", "projectName", "cancelRequestedBy", "ec2InstanceId"]));
}

async function get(dependencies: SwebenchDependencies, key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({ TableName: dependencies.tableName, Key: key, ConsistentRead: true }));
  return response.Item as Record<string, unknown> | undefined;
}

/** A stored item without its storage-only attributes, for a strict schema. */
function withoutKeys(item: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));
}

/** Spec 052 FR-005: no slot was free; the count is the counter's when it can be read. */
function refusedActive(inProgress: number): SwebenchStartResult {
  const message = inProgress <= 0
    ? "The eval run limit is reached; try again shortly."
    : `${inProgress === 1 ? "1 eval run is" : `${inProgress} eval runs are`} in progress; try again shortly.`;
  return { outcome: "REFUSED", reason: "RUN_ACTIVE", message };
}

function isTransactionCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "TransactionCanceledException";
}

export function isConditionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
  return error.name === "TransactionCanceledException" && Array.isArray(reasons) && reasons.some((reason) => reason?.Code === "ConditionalCheckFailed");
}

function now(dependencies: Pick<SwebenchDependencies, "now">): Date {
  return dependencies.now?.() ?? new Date();
}
