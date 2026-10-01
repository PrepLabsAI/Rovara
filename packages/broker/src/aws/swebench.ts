// Spec 043: SWE-bench runs from Slack. The broker records each run, allows one active run per
// deployment, writes the run's launch file, starts the eval state machine, and applies the runner's
// callbacks. The Slack service polls the run and posts to the thread; the broker never holds a Slack
// token (D11).
import { createHmac, timingSafeEqual } from "node:crypto";
import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
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
  slackThreadSubject,
  type ModelIdentifier,
  type SlackRequester,
  type SlackThread,
  type SwebenchChannel,
  type SwebenchLaunch,
  type SwebenchRun,
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
}

export interface SwebenchDependencies {
  documentClient: DynamoDBDocumentClient;
  s3: Pick<S3Client, "send">;
  tableName: string;
  artifactBucketName: string;
  callbackSigningKey: string;
  deployment: () => Promise<SwebenchDeployment | undefined>;
  startExecution: (input: { stateMachineArn: string; name: string; input: string }) => Promise<void>;
  now?: () => Date;
}

/** The Slack context a service route acts in: the thread, its requester and the channel's project. */
export interface SwebenchSlackContext {
  thread: SlackThread;
  requester: SlackRequester;
  projectName: string;
  /** The project's approved model a run may use: the requested one if approved, else the current one; undefined when the project approves none. */
  projectModel: (requested: ModelIdentifier | undefined) => Promise<ModelIdentifier | undefined>;
}

const ACTIVE_KEY = { pk: "SWEBENCH#ACTIVE", sk: "LOCK" } as const;
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
export async function startSwebenchRun(dependencies: SwebenchDependencies, context: SwebenchSlackContext, value: unknown): Promise<SwebenchStartResult> {
  const request = SwebenchStartRequestSchema.parse(value);
  const runId = request.requestId;
  const existing = await readRun(dependencies, runId);
  if (existing !== undefined) {
    if (slackThreadSubject(existing.thread) !== slackThreadSubject(context.thread)) throw agentXError("IDEMPOTENCY_CONFLICT", "this request ID belongs to another thread's run");
    return { outcome: "STARTED", run: existing };
  }
  const deployment = await dependencies.deployment();
  if (deployment === undefined) {
    return { outcome: "REFUSED", reason: "NOT_INSTALLED", message: "SWE-bench runs are not installed in this deployment. Ask an administrator to deploy the eval stack and runner image." };
  }
  const channel = await getSwebenchChannel(dependencies, context.thread.teamId, context.thread.channelId);
  if (channel === undefined) {
    return { outcome: "REFUSED", reason: "NOT_ENABLED", message: "SWE-bench runs are not enabled in this channel. An administrator can enable them with `agentx admin eval enable`." };
  }
  const model = await context.projectModel(request.model) ?? deployment.defaultModel;
  const active = await get(dependencies, ACTIVE_KEY);
  if (active !== undefined) return refusedActive(active);
  const createdAt = now(dependencies).toISOString();
  const run: SwebenchRun = SwebenchRunSchema.parse({
    runId,
    dataset: request.dataset,
    instanceId: request.instanceId,
    model,
    maxCostUsd: channel.maxCostUsd,
    thread: context.thread,
    requestedBy: context.requester,
    status: "STARTING",
    createdAt,
    updatedAt: createdAt,
  });
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: dependencies.tableName, Item: { ...swebenchRunKey(runId), entityType: "SWEBENCH_RUN", projectName: context.projectName, ...run }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Put: { TableName: dependencies.tableName, Item: { ...ACTIVE_KEY, entityType: "SWEBENCH_ACTIVE", runId, threadSubject: slackThreadSubject(context.thread), startedAt: createdAt }, ConditionExpression: "attribute_not_exists(pk)" } },
      ],
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    // A concurrent delivery of the same request, or another run that took the lock first.
    const raced = await readRun(dependencies, runId);
    if (raced !== undefined) return { outcome: "STARTED", run: raced };
    const holder = await get(dependencies, ACTIVE_KEY);
    return refusedActive(holder ?? {});
  }
  const artifactsPrefix = `evals/${runId}/`;
  try {
    const launch = SwebenchLaunchSchema.parse({
      runnerImage: deployment.runnerImage,
      logGroupName: deployment.settings.logGroupName,
      environment: deployment.environment,
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

/** FR-005: a thread's stop cancels its active run; the state machine terminates the instance. */
export async function stopSwebenchRun(dependencies: SwebenchDependencies, thread: SlackThread, requester: SlackRequester): Promise<string | undefined> {
  const active = await get(dependencies, ACTIVE_KEY);
  if (typeof active?.runId !== "string" || active.threadSubject !== slackThreadSubject(thread)) return undefined;
  try {
    await dependencies.documentClient.send(new UpdateCommand({
      TableName: dependencies.tableName,
      Key: swebenchRunKey(active.runId),
      UpdateExpression: "SET #status = :cancel, updatedAt = :now, cancelRequestedBy = :requester",
      ConditionExpression: "#status = :starting OR #status = :running",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":cancel": "CANCEL_REQUESTED", ":now": now(dependencies).toISOString(), ":requester": requester, ":starting": "STARTING", ":running": "RUNNING" },
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
  }
  return active.runId;
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
        UpdateExpression: "SET #status = :running, updatedAt = :now",
        ConditionExpression: "#status = :starting",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":running": "RUNNING", ":starting": "STARTING", ":now": now(dependencies).toISOString() },
      }));
    } catch (error) {
      // Already running, cancelling or finished: the report changes nothing.
      if (!isConditionFailure(error)) throw error;
    }
    return { run: (await readRun(dependencies, runId)) ?? run };
  }
  const result = SwebenchRunResultSchema.parse(body);
  await finishRun(dependencies, runId, result.outcome === "GRADED"
    ? { status: "SUCCEEDED", result }
    : { status: "FAILED", error: result.error });
  return { run: (await readRun(dependencies, runId)) ?? run };
}

/**
 * Moves an active run to its terminal status and releases the deployment's lock in one transaction.
 * A run already terminal is left as it is, so a repeated result is harmless.
 */
async function finishRun(
  dependencies: SwebenchDependencies,
  runId: string,
  outcome: { status: "SUCCEEDED"; result: unknown } | { status: "FAILED"; error: string },
): Promise<void> {
  const at = now(dependencies).toISOString();
  const values: Record<string, unknown> = { ":status": outcome.status, ":now": at, ":runId": runId };
  ACTIVE_STATUSES.forEach((status, index) => { values[`:active${index}`] = status; });
  // RESULT and STATUS are DynamoDB reserved words, so every attribute here goes through a name.
  const set = outcome.status === "SUCCEEDED" ? "#result = :result" : "#error = :error";
  if (outcome.status === "SUCCEEDED") values[":result"] = outcome.result;
  else values[":error"] = outcome.error.slice(0, 2_000);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: dependencies.tableName,
            Key: swebenchRunKey(runId),
            UpdateExpression: `SET #status = :status, updatedAt = :now, finishedAt = :now, ${set}`,
            ConditionExpression: ACTIVE_STATUSES.map((_, index) => `#status = :active${index}`).join(" OR "),
            ExpressionAttributeNames: { "#status": "status", ...(outcome.status === "FAILED" ? { "#error": "error" } : { "#result": "result" }) },
            ExpressionAttributeValues: Object.fromEntries(Object.entries(values).filter(([key]) => key !== ":runId")),
          },
        },
        {
          Delete: {
            TableName: dependencies.tableName,
            Key: ACTIVE_KEY,
            ConditionExpression: "attribute_not_exists(pk) OR runId = :runId",
            ExpressionAttributeValues: { ":runId": runId },
          },
        },
      ],
    }));
  } catch (error) {
    if (!isConditionFailure(error)) throw error;
    const current = await readRun(dependencies, runId);
    if (current === undefined) throw agentXError("NOT_FOUND", "SWE-bench run not found");
    if (!SWEBENCH_TERMINAL_STATUSES.has(current.status)) throw error;
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

async function readRun(dependencies: SwebenchDependencies, runId: string): Promise<SwebenchRun | undefined> {
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

function refusedActive(holder: Record<string, unknown>): SwebenchStartResult {
  const since = typeof holder.startedAt === "string" ? ` (started ${holder.startedAt})` : "";
  return { outcome: "REFUSED", reason: "RUN_ACTIVE", message: `Another SWE-bench run is in progress${since}. One run at a time is allowed; try again when it finishes.` };
}

function isConditionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "ConditionalCheckFailedException") return true;
  const reasons = (error as Error & { CancellationReasons?: Array<{ Code?: string } | undefined> }).CancellationReasons;
  return error.name === "TransactionCanceledException" && Array.isArray(reasons) && reasons.some((reason) => reason?.Code === "ConditionalCheckFailed");
}

function now(dependencies: Pick<SwebenchDependencies, "now">): Date {
  return dependencies.now?.() ?? new Date();
}
