// The retired share route, over the core store. The notifier owns posting; every share-map replacement fences its version.
import { ShareDeveloperTaskRequestSchema, agentXError, change, developerTaskPolicy, sharedTaskKey, when, type DocumentKey, type TransactItem } from "@agentx/contracts";
import { channelLabel, decideMode } from "../../developer/share.js";
import type { TaskShare } from "../../developer/task-records.js";
import { stageAudit } from "./admission.js";
import type { TaskCaller, TaskFlowDeps } from "./deps.js";
import { taskIndexKey, taskKey } from "./keys.js";
import { CLOSED_TASK, loadTaskAsOwner, parseBody } from "./owner-round.js";
import { toDocument, type TaskRecord } from "./records.js";
import { hashJson, iso } from "./support.js";
import { workspaceKeys } from "./workspace-location.js";

export interface TaskSharing {
  /** The host's own bound-channel, privacy and live membership proof. No client supplies this. */
  prepare(caller: TaskCaller, project: string, wanted: { shareToChannel: boolean; shareMode?: "view" | "continue" | undefined; channel?: string | undefined }): Promise<TaskShare | undefined>;
}

async function nextShare(deps: TaskFlowDeps, caller: TaskCaller, task: TaskRecord, wanted: { shareMode?: "view" | "continue" | undefined; channel?: string | undefined }): Promise<TaskShare> {
  const project = await deps.projects.latest(task.project);
  if (project === undefined) throw agentXError("CONFIG_INVALID", "this task's project is no longer registered; ask an admin");
  const current = task.share;
  if (current === undefined) {
    const share = await deps.taskSharing?.prepare(caller, task.project, { ...wanted, shareToChannel: true });
    if (share === undefined) throw agentXError("CHANNEL_REQUIRED", "this install has no Slack workspace set, so tasks cannot be shared");
    return share;
  }
  if (wanted.channel !== undefined && wanted.channel !== current.channelId && wanted.channel.replace(/^#/u, "").toLowerCase() !== current.channelName?.toLowerCase()) {
    throw agentXError("CONFIG_INVALID", `this task is already shared in ${channelLabel({ channelId: current.channelId, ...(current.channelName === undefined ? {} : { name: current.channelName, isPrivate: false }) })}; its channel cannot change`);
  }
  const { modeReason: _oldReason, ...base } = current;
  void _oldReason;
  return { ...base, ...decideMode(developerTaskPolicy(project.definition), wanted.shareMode ?? current.mode) };
}

export async function shareTask(deps: TaskFlowDeps, caller: TaskCaller, taskId: string, value: unknown): Promise<TaskRecord> {
  const request = parseBody(ShareDeveloperTaskRequestSchema, value);
  const payloadHash = hashJson({ action: "share", shareMode: request.shareMode ?? null, channel: request.channel ?? null });
  for (let attempt = 0; attempt < 3; attempt++) {
    const { task, acting } = await loadTaskAsOwner(deps, caller, taskId);
    const location = await workspaceKeys(deps, task.workspaceId);
    const idempotencyKey = location.operationRequestKey(task.ownerKey, request.requestId);
    const previous = await deps.store.get(idempotencyKey);
    if (previous !== undefined) {
      if (previous["payloadHash"] !== payloadHash) throw agentXError("IDEMPOTENCY_CONFLICT", "this request_id was already used for another action on this task; use a new request_id");
      return task;
    }
    if (task.closedAt !== undefined) throw agentXError("CONFIG_INVALID", CLOSED_TASK);
    const share = await nextShare(deps, caller, task, request);
    if (JSON.stringify(share) === JSON.stringify(task.share)) return task;
    const now = iso(deps);
    const items = shareWriteItems(deps, caller, task, share, { requestId: request.requestId, idempotencyKey, payloadHash, now, actingItems: acting.items ?? [] });
    if ((await deps.store.transact(items)).applied) return (await loadTaskAsOwner(deps, caller, taskId)).task;
  }
  throw agentXError("WORKSPACE_BUSY", "the task changed while sharing; try again");
}

export async function prepareTaskStartShare(deps: TaskFlowDeps, caller: TaskCaller, project: string, required: boolean, request: { shareToChannel?: boolean | undefined; shareMode?: "view" | "continue" | undefined; channel?: string | undefined }): Promise<TaskShare | undefined> {
  if (!request.shareToChannel && (request.shareMode !== undefined || request.channel !== undefined) && !required) throw agentXError("CONFIG_INVALID", "shareMode and channel require shareToChannel: true");
  const share = await deps.taskSharing?.prepare(caller, project, { shareToChannel: request.shareToChannel === true, shareMode: request.shareMode, channel: request.channel });
  if ((request.shareToChannel === true || required) && share === undefined) throw agentXError("CHANNEL_REQUIRED", "this install has no Slack workspace set, so tasks cannot be shared");
  return share;
}

function shareWriteItems(deps: TaskFlowDeps, caller: TaskCaller, task: TaskRecord, share: TaskShare, input: { requestId: string; idempotencyKey: DocumentKey; payloadHash: string; now: string; actingItems: readonly TransactItem[] }): TransactItem[] {
  const { requestId, idempotencyKey, payloadHash, now, actingItems } = input;
  const version = task.shareVersion ?? 0;
  return [
      { kind: "update", key: taskKey(task.taskId), ops: [change.set("share", toDocument(share)), change.set("shared", true), change.set("shareVersion", version + 1), change.set("updatedAt", now)],
        condition: when.and(when.present(), when.eq("companyId", deps.companyId), when.notExists("closedAt"), version === 0 ? when.notExists("shareVersion") : when.eq("shareVersion", version)) },
      { kind: "update", key: taskIndexKey(task.developerId, task.createdAt, task.taskId), ops: [change.set("shared", true)] },
      ...(share.threadTs === undefined ? [] : [{ kind: "update" as const, key: sharedTaskKey({ teamId: share.teamId, channelId: share.channelId, threadTs: share.threadTs }), ops: [change.set("mode", share.mode)], condition: when.present() }]),
      { kind: "put", item: { ...idempotencyKey, entityType: "IDEMPOTENCY", action: "share", payloadHash }, condition: when.absent() },
      ...actingItems,
      ...stageAudit(deps, { eventId: `task.shared:${task.taskId}:${requestId}`, actor: { type: "person", id: caller.principal.personId }, action: "task.shared", subject: { type: "task", id: task.taskId }, details: { project: task.project, mode: share.mode, channelId: share.channelId } }),
    ];
}
