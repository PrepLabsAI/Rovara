// Spec 025 C7, C8: the notices a shared task's thread hears about, from the state table's stream.
// Pure: whether the task is shared is decided when a notice is delivered (Task 7).
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

export interface StreamRecord {
  eventID?: string;
  eventName?: string;
  dynamodb?: { ApproximateCreationDateTime?: number; NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> };
}
export type NoticeKind = "start" | "mode" | "closed" | "cancelled" | "ready" | "setup_failed" | "ended" | "pull_request" | "workflow" | "github_feedback" | "admin_change_dm" | "admin_change_outcome" | "admin_change_expiry" | "workflow_refusal";
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
  /** Spec 025 E13: the admin change a direct message is about. */
  changeId?: string;
  /** #217: the queue holds the notice until this time (at most 15 minutes); set only on a notice the notifier schedules itself. */
  notBefore?: string;
  /** Active immutable PR-feedback report announced by this notice. */
  feedbackReviewDigest?: string;
  /** A workflow notice's revision: delivered only while the task is still at it, so a stale step is never said. */
  workflowRevision?: number;
}

/** Stable key shared by notice production and the owner-decision latency measurement. */
export const feedbackReviewNoticeId = (taskId: string, reviewDigest: string, workflowRevision: number): string =>
  `${taskId}:feedback_review:${reviewDigest}:${workflowRevision}`;

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);
/** Spec 025 E2: the statuses an admin change ends in. */
const ENDED_CHANGE = new Set(["applied", "declined", "expired", "failed"]);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown) => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);

export function noticesOf(previous: Record<string, unknown> | undefined, next: Record<string, unknown>, at: string, eventId: string): Notice[] {
  switch (next.entityType) {
    case "DEVELOPER_TASK": {
      const taskId = text(next.taskId);
      const before = record(previous?.share);
      const after = record(next.share);
      const notices: Notice[] = [];
      const beforeWorkflow = record(previous?.workflow);
      const afterWorkflow = record(next.workflow);
      const beforeReview = record(beforeWorkflow?.feedbackReview);
      const afterReview = record(afterWorkflow?.feedbackReview);
      const beforeReviewRef = record(beforeReview?.reviewRef);
      const afterReviewRef = record(afterReview?.reviewRef);
      const oldNotes = Array.isArray(beforeWorkflow?.feedbackNotes) ? beforeWorkflow.feedbackNotes.length : 0;
      const newNotes = Array.isArray(afterWorkflow?.feedbackNotes) ? afterWorkflow.feedbackNotes.length : 0;
      if (afterReview?.status === "PENDING" && afterReviewRef?.status === "COMPLETE" && typeof afterReviewRef.sha256 === "string"
        && (afterReviewRef.sha256 !== beforeReviewRef?.sha256 || newNotes !== oldNotes)) {
        notices.push({ id: feedbackReviewNoticeId(taskId, afterReviewRef.sha256, Number(afterWorkflow?.revision)), kind: "github_feedback", taskId, at,
          feedbackReviewDigest: afterReviewRef.sha256 });
      } else if (afterWorkflow !== undefined && beforeWorkflow !== undefined && afterWorkflow.revision !== beforeWorkflow.revision && eventId !== "") {
        // Gap 5: every step change, keyed by its revision; the notifier words it, or says nothing, when it is delivered.
        // The task's first step is not one: the start message (or Slack's Quick or Full answer) already says it.
        notices.push({ id: `${taskId}:workflow:${String(afterWorkflow.revision)}`, kind: "workflow", taskId, at, workflowRevision: Number(afterWorkflow.revision) });
      }
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
    // Task 19: a Slack press the broker refused, told privately to whoever pressed. Once, when it is written.
    case "WORKFLOW_ACTION_REFUSAL": {
      const taskId = text(next.taskId);
      const sk = text(next.sk);
      if (previous !== undefined || taskId === "" || !sk.startsWith("REFUSAL#")) return [];
      return [{ id: `${taskId}:refusal:${sk}`, kind: "workflow_refusal", taskId, at }];
    }
    case "ADMIN_CHANGE": {
      // Spec 025 E13: the Slack step started, or a change with a message ended. Only stored
      // statuses count: a press that left the change pending (Task 7's `unavailable`) keeps the
      // buttons. A TTL removal has no new image and never reaches here.
      const changeId = text(next.changeId);
      if (changeId === "") return [];
      if (next.status === "pending" && next.slackRequestedAt != null && previous?.slackRequestedAt == null) return [{ id: `${changeId}:dm`, kind: "admin_change_dm", changeId, at }];
      // A message recorded after the change ended (the change was answered while it posted) is edited too.
      const ended = ENDED_CHANGE.has(text(next.status));
      if (ended && next.dm != null && (previous?.status !== next.status || previous?.dm == null)) return [{ id: `${changeId}:outcome`, kind: "admin_change_outcome", changeId, at }];
      return [];
    }
    default:
      return [];
  }
}

const isTime = (value: unknown): value is string => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * Ruling F7: when the change committed, to the millisecond, from the new image's own time (task
 * and operation records carry `updatedAt`; a cancel stamps the pointer's `cancelledAt`), so it
 * compares exactly with a share's `sharedAt`. The stream's time has whole seconds and can come
 * before `sharedAt`, so it is only the fallback.
 */
function changedAt(next: Record<string, unknown>, approximate: number | undefined): string {
  if (isTime(next.updatedAt)) return new Date(next.updatedAt).toISOString();
  if (next.entityType === "DEVELOPER_TASK_POINTER" && isTime(next.cancelledAt)) return new Date(next.cancelledAt).toISOString();
  const seconds = typeof approximate === "number" && Number.isFinite(approximate) ? approximate : Date.now() / 1000;
  return new Date(seconds * 1000).toISOString();
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
      notices.push(...noticesOf(previous, next, changedAt(next, entry.dynamodb?.ApproximateCreationDateTime), entry.eventID ?? ""));
    } catch {
      skipped.push({ ...(entry.eventID === undefined ? {} : { eventID: entry.eventID }), ...(entry.eventName === undefined ? {} : { eventName: entry.eventName }) });
    }
  }
  return { notices, skipped };
}

export function noticesFromStream(records: readonly StreamRecord[]): Notice[] {
  return readStream(records).notices;
}
