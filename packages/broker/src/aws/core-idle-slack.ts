// Port of the retired idle backstop. Uses the core's recorded task/thread and its cancellation completion; no member is impersonated.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { change, SLACK_CHANNEL, when, type ConversationRef, type TransactItem } from "@agentx/contracts";
import type { TaskFlowDeps } from "../core/task-flow/deps.js";
import { readOperation } from "../core/task-flow/results.js";
import { readTask } from "../core/task-flow/reads.js";
import { readWorkspace } from "../core/task-flow/stage-machine.js";
import { runWatchPartition } from "../core/task-flow/run-watch-rows.js";
import { workspaceKeys } from "../core/task-flow/workspace-location.js";
import { finishCancellation } from "../core/task-flow/cancel-active.js";
import { taskKey } from "../core/task-flow/keys.js";
import { iso } from "../core/task-flow/support.js";
import { stageAudit } from "../core/task-flow/admission.js";
import type { OperationRecord, TaskRecord, WorkspaceRecord } from "../core/task-flow/records.js";
import type { WorkspaceKeys } from "../core/task-flow/workspace-location.js";
import { readTaskThread, taskThreadKey } from "../core/channel/threads.js";
import { lastActivityAt, waiterOf, UNWAITED_TASK_IDLE_LIMIT_MS, UNWAITED_TASK_NOTE } from "./unwaited-tasks.js";

interface IdleSlackDeps {
  flow: TaskFlowDeps;
  documentClient: { send(command: unknown): Promise<unknown> };
  threadsTableName: string | undefined;
  companyOf(conversation: ConversationRef): Promise<string | undefined>;
  postNote(conversation: ConversationRef, text: string, operationId: string): Promise<void>;
  scan?: { cursor?: string | undefined };
}
const LIVE = ["ACCEPTED", "DISPATCHING", "RUNNING"];
const SYSTEM = { type: "system", id: "idle-slack-watchdog" } as const;
const REASON = "Rovara stopped this step after 24 hours idle with nobody waiting. Retry to run it again.";

export async function sweepCoreIdleSlack(deps: IdleSlackDeps): Promise<{ cancelled: number; failed: number }> {
  const { flow } = deps;
  const page = await flow.store.query({ pk: runWatchPartition(flow.companyId), limit: 50, ...(deps.scan?.cursor === undefined ? {} : { cursor: deps.scan.cursor }) });
  if (deps.scan !== undefined) deps.scan.cursor = page.cursor;
  const report = { cancelled: 0, failed: 0 };
  for (const row of page.items) {
    if (row["companyId"] !== flow.companyId || typeof row["workspaceId"] !== "string" || typeof row["operationId"] !== "string") continue;
    try { if (await settleIdle(deps, row["workspaceId"], row["operationId"])) report.cancelled += 1; }
    catch { report.failed += 1; }
  }
  return report;
}

async function settleIdle(deps: IdleSlackDeps, workspaceId: string, operationId: string): Promise<boolean> {
  const { flow } = deps;
  const workspace = await readWorkspace(flow, workspaceId);
  if (workspace?.activeOperationId !== operationId) return false;
  const operation = await readOperation(flow, workspaceId, operationId);
  if (operation?.kind !== "task" || ![...LIVE, "CANCEL_REQUESTED"].includes(operation.status) || !Number.isSafeInteger(operation.eventSequence)) return false;
  const location = await workspaceKeys(flow, workspaceId);
  const pointer = await flow.store.get(location.taskPointerKey());
  const task = typeof pointer?.["taskId"] === "string" ? await readTask(flow, pointer["taskId"]) : undefined;
  if (task === undefined || task.workspaceId !== workspaceId || task.closedAt !== undefined || task.sessionId === undefined) return false;
  const thread = await readTaskThread(flow.store, flow.companyId, task.sessionId);
  if (thread?.conversation.channel !== SLACK_CHANNEL || await deps.companyOf(thread.conversation) !== flow.companyId) return false;
  const requestKey = { pk: `DEVTASK#${task.taskId}`, sk: `REQUEST#idle-cancel-${operationId}` };
  if (operation.status === "CANCEL_REQUESTED") return recoverIdle(deps, task, workspace, operation, thread.conversation, requestKey);
  const now = flow.now?.() ?? new Date();
  const idle = await operationIdle(flow, location, operation, now);
  if (idle === undefined || idle <= UNWAITED_TASK_IDLE_LIMIT_MS) return false;
  if (deps.threadsTableName === undefined) throw new Error("thread waiter store unavailable");
  const { tenant, space, thread: threadTs } = thread.conversation;
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.threadsTableName, Key: { pk: `THREAD#${tenant}/${space}/${threadTs}`, sk: "META" }, ConsistentRead: true, ProjectionExpression: "activeTurn" })) as { Item?: { activeTurn?: unknown } };
  if (waiterOf(response.Item?.activeTurn, operationId, idle, now) !== undefined) return false;
  const at = iso(flow);
  const items: TransactItem[] = [
    { kind: "update", key: location.operationKey(operationId), ops: [change.set("status", "CANCEL_REQUESTED"), change.set("updatedAt", at)], condition: when.and(when.eq("fence", operation.fence), when.eq("eventSequence", operation.eventSequence), when.or(...LIVE.map((status) => when.eq("status", status)))) },
    { kind: "check", key: location.workspaceKey, condition: when.and(when.eq("activeOperationId", operationId), when.eq("fence", operation.fence)) },
    { kind: "check", key: taskKey(task.taskId), condition: when.and(when.eq("companyId", flow.companyId), when.eq("workspaceId", workspaceId), when.eq("sessionId", task.sessionId), when.notExists("closedAt")) },
    { kind: "check", key: taskThreadKey(flow.companyId, task.sessionId), condition: when.eq("conversation", thread.conversation) },
    { kind: "put", item: { ...requestKey, entityType: "IDEMPOTENCY", action: "cancel", actor: SYSTEM, taskId: task.taskId, operationId, eventSequence: operation.eventSequence, fence: operation.fence, at }, condition: when.absent() },
    ...stageAudit(flow, { eventId: `task.idle_cancel:${operationId}`, actor: SYSTEM, action: "task.stop_requested", subject: { type: "task", id: task.taskId }, details: { operationId, reason: "idle-slack" } }),
  ];
  if (!(await flow.store.transact(items)).applied) return false;
  return finishIdle(deps, task, workspace, operation, thread.conversation, requestKey);
}

async function operationIdle(flow: TaskFlowDeps, location: WorkspaceKeys, operation: OperationRecord, now: Date): Promise<number | undefined> {
  const latest = operation.eventSequence > 0 ? await flow.store.get(location.operationEventKey(operation.id, operation.eventSequence)) : undefined;
  // An event allocated but not stored yet is not evidence of inactivity.
  if (operation.eventSequence > 0 && latest === undefined) return undefined;
  return now.getTime() - lastActivityAt(operation, latest === undefined ? undefined : { timestamp: latest["timestamp"] }, now);
}

async function recoverIdle(deps: IdleSlackDeps, task: TaskRecord, workspace: WorkspaceRecord, operation: OperationRecord, conversation: ConversationRef, requestKey: { pk: string; sk: string }): Promise<boolean> {
  const receipt = await deps.flow.store.get(requestKey);
  if (receipt?.["entityType"] !== "IDEMPOTENCY" || receipt["operationId"] !== operation.id || receipt["fence"] !== operation.fence || receipt["action"] !== "cancel") return false;
  return finishIdle(deps, task, workspace, operation, conversation, requestKey);
}

async function finishIdle(deps: IdleSlackDeps, task: TaskRecord, workspace: WorkspaceRecord, operation: OperationRecord, conversation: ConversationRef, requestKey: { pk: string; sk: string }): Promise<boolean> {
  await finishCancellation(deps.flow, task.taskId, workspace, operation, REASON);
  // Claim before sending: as in the retired path, a failed note is never reposted; the durable stop stands.
  const claimed = await deps.flow.store.update({ key: requestKey, ops: [change.set("noteClaimedAt", iso(deps.flow))], condition: when.and(when.eq("operationId", operation.id), when.notExists("noteClaimedAt")) });
  if (claimed.applied) await deps.postNote(conversation, UNWAITED_TASK_NOTE.replace(/^AgentX/u, "Rovara"), operation.id);
  return true;
}
