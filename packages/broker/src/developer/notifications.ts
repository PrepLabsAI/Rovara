// Spec 025 C7, C8: the notices a shared task's thread hears about, from the state table's stream.
// Pure: whether the task is shared is decided when a notice is delivered (Task 7).
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

export interface StreamRecord {
  eventID?: string;
  eventName?: string;
  dynamodb?: { ApproximateCreationDateTime?: number; NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> };
}
export type NoticeKind = "start" | "mode" | "closed" | "cancelled" | "ready" | "setup_failed" | "ended" | "pull_request";
export interface Notice {
  /** Fixed per change, so a repeated delivery posts once (C9). */
  id: string;
  kind: NoticeKind;
  /** When the change committed; changes before a task was shared are not posted. */
  at: string;
  taskId?: string;
  workspaceId?: string;
  operationId?: string;
  mode?: "view" | "continue";
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);

export function noticesOf(previous: Record<string, unknown> | undefined, next: Record<string, unknown>, at: string, eventId: string): Notice[] {
  switch (next.entityType) {
    case "DEVELOPER_TASK": {
      const taskId = text(next.taskId);
      const before = record(previous?.share);
      const after = record(next.share);
      const notices: Notice[] = [];
      if (after !== undefined && before === undefined) notices.push({ id: `${taskId}:start`, kind: "start", taskId, at });
      else if (after !== undefined && before !== undefined && after.mode !== before.mode) {
        notices.push({ id: `${taskId}:mode:${eventId}`, kind: "mode", taskId, at, mode: after.mode === "continue" ? "continue" : "view" });
      }
      if (next.closedAt !== undefined && previous?.closedAt === undefined) notices.push({ id: `${taskId}:closed`, kind: "closed", taskId, at });
      return notices;
    }
    case "DEVELOPER_TASK_POINTER":
      return next.cancelledAt !== undefined && previous?.cancelledAt === undefined
        ? [{ id: `${text(next.taskId)}:cancelled`, kind: "cancelled", taskId: text(next.taskId), at }]
        : [];
    case "OPERATION": {
      // Only the developer's own operations: the Slack service answers a teammate's (C8).
      if (record(next.requestedBy)?.kind !== "developer") return [];
      if (!TERMINAL.has(text(next.status)) || TERMINAL.has(text(previous?.status))) return [];
      const base = { workspaceId: text(next.workspaceId), operationId: text(next.id), at };
      if (next.kind === "prepare") {
        const kind = next.status === "SUCCEEDED" ? "ready" : "setup_failed";
        return [{ ...base, id: `${base.operationId}:${kind}`, kind }];
      }
      if (next.kind === "publish" && next.status === "SUCCEEDED") return [{ ...base, id: `${base.operationId}:pull_request`, kind: "pull_request" }];
      if (next.kind === "task" || next.kind === "publish") return [{ ...base, id: `${base.operationId}:ended`, kind: "ended" }];
      return [];
    }
    default:
      return [];
  }
}

export function noticesFromStream(records: readonly StreamRecord[]): Notice[] {
  const notices: Notice[] = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    const next = unmarshall(image) as Record<string, unknown>;
    const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
    // `noticesOf` takes the time as an argument, so a later caller can stamp it from the new image instead.
    const seconds = entry.dynamodb?.ApproximateCreationDateTime ?? Date.now() / 1000;
    notices.push(...noticesOf(previous, next, new Date(seconds * 1000).toISOString(), entry.eventID ?? ""));
  }
  return notices;
}
