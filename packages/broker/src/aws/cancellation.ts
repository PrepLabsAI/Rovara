// The operation records and the cancel path shared by the broker and, for issue 173, the session
// reconciler's backstop: moved here unchanged from broker.ts, so both cancel through the same code.
// No module-level state and no environment reads, so the reconciler can load it without the broker's.
import { createHmac, randomUUID } from "node:crypto";
import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  OperationSchema,
  agentXError,
  unhandledDeploymentMode,
  type CodeBuildGateDefinition,
  type Operation,
  type OperationRequester,
  type OperationStatus,
  type WorkerInvocation,
  type WorkspaceInstance,
} from "@agentx/contracts";
import { hashJson, isConditional } from "./broker-shared.js";
import type { ExtraItems } from "./developer-task-actions.js";
import type { DurableOutboxRecord, RuntimeBinding } from "./lambda.js";

/** The State table, as the broker and the reconciler reach it. */
export interface StateTable {
  documentClient: Pick<DynamoDBDocumentClient, "send">;
  tableName: string;
}

export interface CancellationDependencies extends StateTable {
  callbackSigningKey: string;
}

export const TERMINAL = new Set<OperationStatus>(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

export interface OperationRecord extends Operation {
  pk: string;
  sk: string;
  entityType: "OPERATION";
  eventSequence: number;
  targetOperationId?: string;
  /** The project revision whose non-disk settings applied, which may be newer than the workspace's. */
  settingsRevision?: number;
  workflowMode?: "PLAN" | "IMPLEMENT" | "REVIEW" | "CHECKS" | undefined;
  publication?: {
    repository: string;
    repositoryUrl: string;
    headBranch: string;
    baseBranch: string;
    title: string;
    body?: string;
    /** Spec 025 FR-023: a developer's pull request opens as a draft unless they ask otherwise. */
    draft?: boolean;
    /**
     * A workflow publication: the tree the task's checks and reviews passed on. The broker opens the pull request only
     * when GitHub says the pushed commit has this tree, and always as a draft.
     */
    expectedTreeSha?: string;
    /** The checked candidate the tree belongs to (a workflow publication only). */
    candidateDigest?: string;
    /** The base commit the broker pinned for the task: the pushed commit's only parent (a workflow publication only). */
    expectedBaseCommit?: string;
    mode?: "create" | "replace" | "revert";
    targetPullRequestNumber?: number;
    revertCommit?: string;
    codeBuildGates: CodeBuildGateDefinition[];
  };
  maintenance?: {
    action: "append" | "sync";
    repository: string;
    repositoryUrl: string;
    pullRequestNumber: number;
    headBranch: string;
    baseBranch: string;
    expectedHeadCommit: string;
    codeBuildGates: CodeBuildGateDefinition[];
  };
  candidateCommit?: string;
  closePreviousStatus?: "READY" | "STOPPED";
}

export interface CallbackClaims {
  workspaceId: string;
  operationId: string;
  fence: number;
  actions: Array<"events" | "artifacts" | "result" | "pull-request" | "pull-request-update" | "codebuild">;
  expiresAt: number;
}

export async function getItem<T>(dependencies: StateTable, key: { pk: string; sk: string }): Promise<T | undefined> {
  const response = await dependencies.documentClient.send(new GetCommand({
    TableName: dependencies.tableName,
    Key: key,
    ConsistentRead: true,
  }));
  return response.Item as T | undefined;
}

export async function requireOperation(
  dependencies: StateTable,
  workspaceId: string,
  operationId: string,
): Promise<OperationRecord> {
  const operation = await getItem<OperationRecord>(dependencies, operationKey(workspaceId, operationId));
  if (!operation) throw agentXError("NOT_FOUND", "operation not found");
  return operation;
}

export function operationKey(workspaceId: string, operationId: string) {
  return { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${operationId}` };
}

export function operationRecord(operation: Operation, targetOperationId?: string): OperationRecord {
  const parsed = OperationSchema.parse(operation);
  return {
    pk: `WORKSPACE#${parsed.workspaceId}`,
    sk: `OPERATION#${parsed.id}`,
    entityType: "OPERATION",
    eventSequence: 0,
    ...parsed,
    ...(targetOperationId === undefined ? {} : { targetOperationId }),
  };
}

export function publicOperation(record: OperationRecord): Operation {
  return OperationSchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    kind: record.kind,
    ...(record.discardUnpublished === true ? { discardUnpublished: true } : {}),
    ...(record.workflowMode === undefined ? {} : { workflowMode: record.workflowMode }),
    requestId: record.requestId,
    payloadHash: record.payloadHash,
    status: record.status,
    fence: record.fence,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.conversationId === undefined ? {} : { conversationId: record.conversationId }),
    ...(record.heartbeatAt === undefined ? {} : { heartbeatAt: record.heartbeatAt }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(typeof record.error === "string" ? { error: record.error } : {}),
    ...(record.requestedBy === undefined ? {} : { requestedBy: record.requestedBy }),
  });
}

/** Routes to the workspace's own runtime unless a project binding is given. */
export function outboxRecord(
  workspace: WorkspaceInstance,
  invocation: WorkerInvocation,
  routing: RuntimeBinding | WorkspaceInstance = workspace,
): DurableOutboxRecord & { pk: string; sk: string; createdAt: string } {
  const id = randomUUID();
  const key = { pk: `OUTBOX#${id}`, sk: "OUTBOX" };
  const common = {
    id,
    entityType: "OUTBOX",
    status: "PENDING",
    operationId: invocation.operationId,
    workspaceId: workspace.id,
  } as const;
  const mismatch = () => agentXError(
    "CONFIG_INVALID",
    `a ${workspace.deploymentMode} workspace cannot be routed to a ${routing.deploymentMode} runtime`,
  );
  switch (workspace.deploymentMode) {
    case "instances-ebs":
    case "demo-microvm":
      throw agentXError("RUNTIME_UNAVAILABLE", "retired workspace cannot execute work");
    case "ec2-ebs":
      if (routing.deploymentMode !== "ec2-ebs") throw mismatch();
      return { ...key, ...common, deploymentMode: "ec2-ebs", invocation, createdAt: new Date().toISOString() };
    default:
      return unhandledDeploymentMode(workspace);
  }
}

export function issueCapability(
  dependencies: { callbackSigningKey: string },
  workspaceId: string,
  operationId: string,
  fence: number,
  allowPullRequest = false,
): string {
  const claims: CallbackClaims = {
    workspaceId,
    operationId,
    fence,
    actions: [
      "artifacts",
      "events",
      "result",
      ...(allowPullRequest
        ? ["pull-request" as const, "pull-request-update" as const, "codebuild" as const]
        : []),
    ],
    expiresAt: Math.floor(Date.now() / 1_000) + 32_400,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${body}.${createHmac("sha256", dependencies.callbackSigningKey).update(body).digest("base64url")}`;
}

/**
 * Asks the worker to cancel an operation: the target moves to CANCEL_REQUESTED and a cancel
 * operation is queued for the worker. Callers authorize first (the workspace's owner, an
 * administrator, or a member of the workspace's Slack thread).
 */
export async function requestCancellation(
  dependencies: CancellationDependencies,
  workspace: WorkspaceInstance,
  targetOperationId: string,
  requester: { requestedBy?: OperationRequester },
  extra: ExtraItems = () => [],
  options: { onlyLive?: false; eventSequence?: never } | { onlyLive: true; eventSequence?: number } = {},
): Promise<{ operation: Operation; duplicate: boolean; alreadyCancelling?: true; activeAgain?: true }> {
  const workspaceId = workspace.id;
  const target = await requireOperation(dependencies, workspaceId, targetOperationId);
  if (TERMINAL.has(target.status)) return { operation: publicOperation(target), duplicate: true };
  if (workspace.activeOperationId !== targetOperationId) throw agentXError("STALE_FENCE", "operation no longer owns the workspace");
  const now = new Date().toISOString();
  const operationId = randomUUID();
  const operation = operationRecord({
    id: operationId,
    workspaceId,
    kind: "cancel",
    requestId: randomUUID(),
    payloadHash: hashJson({ targetOperationId }),
    status: "ACCEPTED",
    fence: workspace.fence,
    createdAt: now,
    updatedAt: now,
    ...requester,
  }, targetOperationId);
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "cancel",
    operationId,
    workspaceId,
    fence: workspace.fence,
    projectRevision: workspace.projectRevision,
    callbackCapability: issueCapability(dependencies, workspaceId, operationId, workspace.fence),
    payload: { targetOperationId },
  };
  const outbox = outboxRecord(workspace, invocation);
  try {
    await dependencies.documentClient.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: dependencies.tableName,
        Key: operationKey(workspaceId, targetOperationId),
        UpdateExpression: "SET #status = :cancel, updatedAt = :now",
        // Issue 196: only a target not yet finished, so a result that lands between the read above
        // and this write keeps its final status. By default CANCEL_REQUESTED is still running: a
        // repeated cancel queues again, so a cancel whose dispatch was lost can be sent again.
        // Issue 173: the backstop (onlyLive) leaves out CANCEL_REQUESTED, so a member's stop that
        // lands first wins (one cancel, no note). With eventSequence, also only while no new worker
        // event landed since it was read (every operation record is written with an eventSequence, from 0).
        ConditionExpression: options.onlyLive
          ? `fence = :fence AND (#status = :accepted OR #status = :dispatching OR #status = :running)${options.eventSequence === undefined ? "" : " AND eventSequence = :sequence"}`
          : "fence = :fence AND (#status = :accepted OR #status = :dispatching OR #status = :running OR #status = :cancel)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":cancel": "CANCEL_REQUESTED", ":now": now, ":fence": workspace.fence,
          // Unconditional: both conditions use them.
          ":accepted": "ACCEPTED", ":dispatching": "DISPATCHING", ":running": "RUNNING",
          ...(options.onlyLive && options.eventSequence !== undefined ? { ":sequence": options.eventSequence } : {}),
        },
      } },
      { Put: { TableName: dependencies.tableName, Item: operation } },
      { Put: { TableName: dependencies.tableName, Item: outbox } },
      ...extra(publicOperation(operation)),
    ] }));
  } catch (error) {
    if (!isConditional(error)) throw error;
    // The target finished while the cancel was being written: answer as for a finished target.
    const current = await requireOperation(dependencies, workspaceId, targetOperationId);
    if (TERMINAL.has(current.status)) return { operation: publicOperation(current), duplicate: true };
    // Only an onlyLive cancel can fail these ways: another cancel was recorded first, or the task
    // showed new activity since it was judged idle.
    if (options.onlyLive && current.status === "CANCEL_REQUESTED") return { operation: publicOperation(current), duplicate: true, alreadyCancelling: true };
    if (options.onlyLive && options.eventSequence !== undefined && current.eventSequence !== options.eventSequence) {
      return { operation: publicOperation(current), duplicate: true, activeAgain: true };
    }
    throw agentXError("WORKSPACE_BUSY", "the workspace changed while the cancel was being recorded; try again");
  }
  return { operation: publicOperation(operation), duplicate: false };
}
