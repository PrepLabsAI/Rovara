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
      // A mode notice is named by its stream event; without one, two changes would collapse into one ID.
      else if (after !== undefined && before !== undefined && after.mode !== before.mode && eventId !== "") {
        notices.push({ id: `${taskId}:mode:${eventId}`, kind: "mode", taskId, at, mode: after.mode === "continue" ? "continue" : "view" });
      }
      // A stored NULL counts as unset.
      if (next.closedAt != null && previous?.closedAt == null) notices.push({ id: `${taskId}:closed`, kind: "closed", taskId, at });
      return notices;
    }
    case "DEVELOPER_TASK_POINTER":
      return next.cancelledAt != null && previous?.cancelledAt == null
        ? [{ id: `${text(next.taskId)}:cancelled`, kind: "cancelled", taskId: text(next.taskId), at }]
        : [];
    case "OPERATION": {
      // Only the developer's own operations: the Slack service answers a teammate's (C8).
      if (record(next.requestedBy)?.kind !== "developer") return [];
      if (!TERMINAL.has(text(next.status)) || TERMINAL.has(text(previous?.status))) return [];
      const base = { workspaceId: text(next.workspaceId), operationId: text(next.id), at };
      if (next.kind === "prepare") {
        // A cancelled setup has no notice of its own: the cancel notice covers it.
        const kind = next.status === "SUCCEEDED" ? "ready" : next.status === "FAILED" || next.status === "INTERRUPTED" ? "setup_failed" : undefined;
        return kind === undefined ? [] : [{ ...base, id: `${base.operationId}:${kind}`, kind }];
      }
      if (next.kind === "publish" && next.status === "SUCCEEDED") return [{ ...base, id: `${base.operationId}:pull_request`, kind: "pull_request" }];
      if (next.kind === "task" || next.kind === "publish") return [{ ...base, id: `${base.operationId}:ended`, kind: "ended" }];
      return [];
    }
    default:
      return [];
  }
}

/** A stream record that could not be read: its event name and ID only, never an error message. */
export interface SkippedRecord { eventID?: string; eventName?: string }

/** The notices of a batch. A malformed record is skipped and named, so one bad record never loses the batch. */
export function readStream(records: readonly StreamRecord[]): { notices: Notice[]; skipped: SkippedRecord[] } {
  const notices: Notice[] = [];
  const skipped: SkippedRecord[] = [];
  for (const entry of records) {
    const image = entry.dynamodb?.NewImage;
    if (image === undefined) continue;
    try {
      const next = unmarshall(image) as Record<string, unknown>;
      const previous = entry.dynamodb?.OldImage === undefined ? undefined : unmarshall(entry.dynamodb.OldImage) as Record<string, unknown>;
      // `noticesOf` takes the time as an argument, so a later caller can stamp it from the new image instead.
      const approximate = entry.dynamodb?.ApproximateCreationDateTime;
      const seconds = typeof approximate === "number" && Number.isFinite(approximate) ? approximate : Date.now() / 1000;
      notices.push(...noticesOf(previous, next, new Date(seconds * 1000).toISOString(), entry.eventID ?? ""));
    } catch {
      skipped.push({ ...(entry.eventID === undefined ? {} : { eventID: entry.eventID }), ...(entry.eventName === undefined ? {} : { eventName: entry.eventName }) });
    }
  }
  return { notices, skipped };
}

export function noticesFromStream(records: readonly StreamRecord[]): Notice[] {
  return readStream(records).notices;
}
