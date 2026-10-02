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
  /** Starts a run's execution; the ARN it returns is recorded on the run, so the tick can find a dead execution (Ruling 13). */
  startExecution: (input: { stateMachineArn: string; name: string; input: string }) => Promise<{ executionArn?: string | undefined } | void>;
  /**
   * Spec 052 Ruling 13: an execution's status (RUNNING, SUCCEEDED, FAILED, TIMED_OUT, ABORTED…);
   * undefined when it does not exist. Absent, a run with no live callback is ended only by its age.
   */
  describeExecution?: (executionArn: string) => Promise<{ status: string } | undefined>;
  /**
   * Spec 052 Ruling 16: terminates an eval instance; an instance already gone is not an error.
   * Absent, a dead run's instance is left to its execution's own terminate step.
   */
  terminateInstance?: (instanceId: string) => Promise<void>;
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
  let executionArn: string | undefined;
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
    const execution = await dependencies.startExecution({
      stateMachineArn: deployment.settings.stateMachineArn,
      name: runId,
      input: JSON.stringify({ runId, subnetId: subnets[Math.floor(Math.random() * subnets.length)] }),
    });
    executionArn = execution?.executionArn;
  } catch (error) {
    await finishRun(dependencies, runId, { status: "FAILED", error: `the run could not start: ${error instanceof Error ? error.message : String(error)}` }).catch(() => undefined);
    throw error;
  }
  if (executionArn !== undefined) await recordExecutionArn(dependencies, runId, executionArn);
  return { outcome: "STARTED", run };
}

/**
 * Ruling 13: the started execution's ARN, kept on the run (storage only). The execution is running,
 * so a failed write is logged, not thrown: the run is then ended by its age if its execution dies.
 */
async function recordExecutionArn(dependencies: SwebenchDependencies, runId: string, executionArn: string): Promise<void> {
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: swebenchRunKey(runId),
      UpdateExpression: "SET executionArn = :arn",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":arn": executionArn },
    }));
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "swebench.execution_arn_not_recorded", runId, error: error instanceof Error ? error.message : String(error) }));
  }
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
    // Spec 052 Ruling 16: a run that has ended (the tick may have ended a dead one, charged $0 if its
    // runner had not started) refuses its runner's start with a final 409: the reporter treats it
    // as final, and the runner stops before its agent starts.
    if (SWEBENCH_TERMINAL_STATUSES.has(run.status)) throw agentXError("OPERATION_INTERRUPTED", "this eval run has already ended; do not start it");
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
      // Already running, cancelling or finished: the report changes nothing, except that a run being
      // cancelled records that its runner started, so it is charged as one that may have spent
      // (spec 052 Ruling 4). A run that ended meanwhile keeps the charge its end was recorded with.
      if (!isConditionFailure(error)) throw error;
      await dependencies.documentClient.send(new UpdateCommand({
        TableName: dependencies.tableName,
        Key: swebenchRunKey(runId),
        UpdateExpression: "SET runnerStartedAt = :now",
        ConditionExpression: "#status = :cancel AND attribute_not_exists(runnerStartedAt)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":now": now(dependencies).toISOString(), ":cancel": "CANCEL_REQUESTED" },
      })).catch((failure: unknown) => { if (!isConditionFailure(failure)) throw failure; });
      // The run may have ended between the read above and these writes: its start is refused too.
      const current = await readRun(dependencies, runId);
      if (current !== undefined && SWEBENCH_TERMINAL_STATUSES.has(current.status)) throw agentXError("OPERATION_INTERRUPTED", "this eval run has already ended; do not start it");
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

/** A change the slot reconcile made, as it logs it. */
export type SwebenchSlotCorrection =
  | { correction: "released_slot" | "deleted_slot"; runId: string; runStatus: string }
  | { correction: "deleted_legacy_lock"; runId: string; runStatus: string }
  | { correction: "counter_set"; from: number | null; to: number }
  | { correction: "ended_dead_run"; runId: string; executionStatus: string | null; runnerStarted: boolean };

/**
 * Ruling 13: a run holding a slot is looked at only once it is this old. A start records the run,
 * writes launch.json and starts its execution within seconds, and EndRun ends a run within seconds
 * of its execution's end; 10 minutes is far past both, so a run being started or ended is never
 * taken for a dead one, and a dead one holds its slot for at most 12 minutes (one more tick).
 */
export const SWEBENCH_DEAD_RUN_GRACE_MS = 10 * 60_000;
/** Ruling 13: a run whose execution is not recorded is taken for dead past its time limit plus this. */
export const SWEBENCH_DEAD_RUN_FALLBACK_MARGIN_MS = 15 * 60_000;
/** Execution statuses of an execution still at work. */
const LIVE_EXECUTION_STATUSES = new Set(["RUNNING", "PENDING_REDRIVE"]);

/**
 * Spec 052: repairs drift between the slot counter and the slot items, run by the batch tick.
 *
 * - A slot item whose run has ended (an older broker ended it without a release) is released as
 *   finishRun and EndRun release it: the item deleted and the counter decremented in one
 *   transaction, only while the item exists and the run is terminal, so a slot is released once
 *   and a run that has not ended never loses its slot. A counter that cannot be decremented leaves
 *   the item deleted alone, and the counter is set below.
 * - The one-run lock of a run that has ended is deleted.
 * - The counter is set to the number of slot items, only when it is wrong. A start takes its slot
 *   item and the counter together, so the slots are read, then the counter, then the slots again:
 *   if the two reads differ, a run started or ended meanwhile and the counter is left for the next
 *   tick. The write requires the counter unchanged and every slot read still held, so a start or a
 *   release after the reads cancels it. One sequence still passes: a run starts after the first
 *   read, fails within milliseconds after the counter is read, and another run starts before the
 *   write. The counter is then one low, allowing one run over maxConcurrentEvals until the next
 *   reconcile, which counts it right (tested). A version every start and release bumps would close
 *   it, but EndRun in the state machine would have to bump it too.
 * - A run that holds a slot but whose execution died without ending it is ended (Ruling 13).
 */
export async function reconcileSwebenchSlots(dependencies: SwebenchDependencies): Promise<SwebenchSlotCorrection[]> {
  const corrections: SwebenchSlotCorrection[] = [];
  const correct = (correction: SwebenchSlotCorrection) => {
    corrections.push(correction);
    console.log(JSON.stringify({ component: "broker", event: "eval_slots.corrected", ...correction }));
  };
  for (const runId of await slotRunIds(dependencies)) {
    const run = await readRun(dependencies, runId);
    if (run === undefined || !SWEBENCH_TERMINAL_STATUSES.has(run.status)) continue;
    const released = await releaseEndedRunSlot(dependencies, runId);
    if (released !== undefined) correct({ correction: released, runId, runStatus: run.status });
  }
  const legacy = await get(dependencies, LEGACY_LOCK_KEY);
  if (typeof legacy?.runId === "string") {
    const run = await readRun(dependencies, legacy.runId);
    if (run !== undefined && SWEBENCH_TERMINAL_STATUSES.has(run.status)) {
      try {
        await dependencies.documentClient.send(new DeleteCommand({
          TableName: dependencies.tableName,
          Key: LEGACY_LOCK_KEY,
          ConditionExpression: "runId = :runId",
          ExpressionAttributeValues: { ":runId": legacy.runId },
        }));
        correct({ correction: "deleted_legacy_lock", runId: legacy.runId, runStatus: run.status });
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
  }
  const counted = await setSlotCounter(dependencies);
  if (counted !== undefined) correct({ correction: "counter_set", ...counted });
  // After the counter is right, so ending a dead run can release its slot.
  const failures: string[] = [];
  for (const runId of await slotRunIds(dependencies)) {
    try {
      const ended = await endDeadRun(dependencies, runId);
      if (ended !== undefined) correct({ correction: "ended_dead_run", runId, ...ended });
    } catch (error) {
      failures.push(runId);
      console.log(JSON.stringify({ component: "broker", event: "eval_slots.dead_run_not_ended", runId, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  if (failures.length > 0) throw new Error(`the dead eval runs ${failures.join(", ")} could not be ended`);
  return corrections;
}

/**
 * Ruling 13: ends a run that holds a slot but whose execution has stopped without ending it (EndRun's
 * release failed, or the execution died). Its execution is described once the run is past the grace
 * period; a run with no recorded execution is taken for dead past its time limit plus 15 minutes.
 * It is ended FAILED through finishRun, which releases its slot once, with an error the batch reads
 * as the infrastructure's (FR-008): "could not start" when its runner never started, which is
 * charged $0, else "stopped without reporting a result", charged its ceiling (D-5). Its instance is
 * terminated first when the run recorded it, and a late `started` is refused (Ruling 16), so a run
 * charged $0 cannot go on to spend. Undefined when
 * the run is alive, too young, already ended, or was ended meanwhile by its execution.
 */
async function endDeadRun(dependencies: SwebenchDependencies, runId: string): Promise<{ executionStatus: string | null; runnerStarted: boolean } | undefined> {
  const item = await get(dependencies, swebenchRunKey(runId));
  if (item === undefined) return undefined;
  const run = await readRun(dependencies, runId);
  if (run === undefined || SWEBENCH_TERMINAL_STATUSES.has(run.status)) return undefined;
  const age = now(dependencies).getTime() - Date.parse(run.createdAt);
  if (age <= SWEBENCH_DEAD_RUN_GRACE_MS) return undefined;
  const pastLimit = age > SWEBENCH_RUN_TIME_LIMIT_SECONDS * 1_000 + SWEBENCH_DEAD_RUN_FALLBACK_MARGIN_MS;
  const executionArn = typeof item.executionArn === "string" ? item.executionArn : undefined;
  let executionStatus: string | null = null;
  if (executionArn !== undefined && dependencies.describeExecution !== undefined) {
    const execution = await dependencies.describeExecution(executionArn);
    if (execution !== undefined && LIVE_EXECUTION_STATUSES.has(execution.status)) return undefined;
    if (execution === undefined && !pastLimit) return undefined;
    executionStatus = execution?.status ?? null;
  } else if (!pastLimit) {
    return undefined;
  }
  const how = executionStatus === null ? "its execution is unknown and the run is past its time limit" : `its execution ended ${executionStatus}`;
  const runnerStarted = run.runnerStartedAt !== undefined;
  const error = runnerStarted
    ? `the eval instance stopped (${how}) without reporting a result; the batch tick ended the run`
    : `the run could not start: ${how} before the runner started`;
  // Ruling 16: its instance first, so a runner still alive cannot spend once the run is charged. A
  // failure leaves the run to the next tick.
  if (typeof item.ec2InstanceId === "string" && dependencies.terminateInstance !== undefined) {
    try {
      await dependencies.terminateInstance(item.ec2InstanceId);
    } catch (error) {
      // An ID EC2 cannot parse names no instance: treated as missing, so it cannot fail every tick.
      // The run is still ended, and a runner still alive is stopped by the 409 to its start.
      if (!(error instanceof Error) || error.name !== "InvalidInstanceID.Malformed") throw error;
      console.log(JSON.stringify({ component: "broker", event: "eval_slots.instance_not_terminated", level: "warning", runId, instanceId: item.ec2InstanceId, error: error.message }));
    }
  }
  await finishRun(dependencies, runId, { status: "FAILED", error });
  // EndRun may have ended it first: then its own end stands, and this changed nothing.
  return (await readRun(dependencies, runId))?.error === error ? { executionStatus, runnerStarted } : undefined;
}

/**
 * Spec 052 Ruling 10: whether the slot reconcile has anything to look at, in at most two small
 * reads: the counter item, then, only when it is 0 or absent, one slot item (Limit 1). True when the
 * counter is not 0 or a slot item exists.
 */
export async function swebenchSlotsNeedReconcile(dependencies: SwebenchDependencies): Promise<boolean> {
  const counter = await get(dependencies, SLOT_COUNTER_KEY);
  if (counter !== undefined && counter.count !== 0) return true;
  const page = await dependencies.documentClient.send(new QueryCommand({
    TableName: dependencies.tableName,
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :run)",
    ExpressionAttributeValues: { ":pk": SLOT_PK, ":run": "RUN#" },
    ConsistentRead: true,
    Limit: 1,
  }));
  return (page.Items ?? []).length > 0;
}

/** Releases an ended run's slot, as a run's end does; undefined when it was released meanwhile or the run is not terminal. */
async function releaseEndedRunSlot(dependencies: SwebenchDependencies, runId: string): Promise<"released_slot" | "deleted_slot" | undefined> {
  const terminal: Record<string, unknown> = {};
  [...SWEBENCH_TERMINAL_STATUSES].forEach((status, index) => { terminal[`:ended${index}`] = status; });
  const runEnded = {
    ConditionCheck: {
      TableName: dependencies.tableName,
      Key: swebenchRunKey(runId),
      ConditionExpression: Object.keys(terminal).map((name) => `#status = ${name}`).join(" OR "),
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: terminal,
    },
  };
  const deleteSlot = { Delete: { TableName: dependencies.tableName, Key: swebenchSlotKey(runId), ConditionExpression: "attribute_exists(pk)" } };
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        runEnded,
        deleteSlot,
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
    return "released_slot";
  } catch (error) {
    if (!isTransactionCancelled(error)) throw error;
  }
  // Released meanwhile, or a conflict: the next tick looks again. Otherwise the counter is at 0 or
  // below: the item is deleted alone, and the counter is set from the items that remain.
  const counter = await get(dependencies, SLOT_COUNTER_KEY);
  if (await get(dependencies, swebenchSlotKey(runId)) === undefined || (typeof counter?.count === "number" && counter.count > 0)) return undefined;
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [runEnded, deleteSlot] }));
    return "deleted_slot";
  } catch (error) {
    if (!isTransactionCancelled(error)) throw error;
    return undefined;
  }
}

/** Sets the counter to the slot items held, when it differs and nothing changed while they were counted. */
async function setSlotCounter(dependencies: SwebenchDependencies): Promise<{ from: number | null; to: number } | undefined> {
  const before = await slotRunIds(dependencies);
  const counter = await get(dependencies, SLOT_COUNTER_KEY);
  const after = await slotRunIds(dependencies);
  const seen = typeof counter?.count === "number" ? counter.count : undefined;
  if (before.join() !== after.join()) return undefined;
  if ((seen ?? 0) === after.length) return undefined;
  // DynamoDB allows 100 items in a transaction; far more slot items than maxConcurrentEvals (6) is
  // not drift this pass can count safely.
  if (after.length > 98) {
    console.log(JSON.stringify({ component: "broker", event: "eval_slots.too_many_to_count", level: "warning", slots: after.length, counter: seen ?? null }));
    return undefined;
  }
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        ...after.map((runId) => ({ ConditionCheck: { TableName: dependencies.tableName, Key: swebenchSlotKey(runId), ConditionExpression: "attribute_exists(pk)" } })),
        {
          Update: {
            TableName: dependencies.tableName,
            Key: SLOT_COUNTER_KEY,
            UpdateExpression: "SET #count = :count",
            ConditionExpression: seen === undefined ? "attribute_not_exists(#count)" : "#count = :seen",
            ExpressionAttributeNames: { "#count": "count" },
            ExpressionAttributeValues: { ":count": after.length, ...(seen === undefined ? {} : { ":seen": seen }) },
          },
        },
      ],
    }));
  } catch (error) {
    if (!isTransactionCancelled(error)) throw error;
    return undefined;
  }
  return { from: seen ?? null, to: after.length };
}

/** The run IDs of every slot item, sorted. */
async function slotRunIds(dependencies: SwebenchDependencies): Promise<string[]> {
  const runIds: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await dependencies.documentClient.send(new QueryCommand({
      TableName: dependencies.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :run)",
      ExpressionAttributeValues: { ":pk": SLOT_PK, ":run": "RUN#" },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    // The key names the run, so an item is counted even without its runId attribute.
    for (const item of page.Items ?? []) runIds.push(String(item.sk).slice("RUN#".length));
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return runIds.sort();
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
  return SwebenchRunSchema.parse(withoutKeys(item, ["pk", "sk", "entityType", "projectName", "cancelRequestedBy", "ec2InstanceId", "executionArn"]));
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
