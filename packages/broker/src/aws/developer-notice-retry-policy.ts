import { SHARE_DELIVERY_WINDOW_MS } from "@agentx/contracts";
import type { DeveloperTaskRecord } from "../developer/task-records.js";

/** How long a task-state card ("workflow" notice) is retried before it is given up on: far longer than the hour of the other notices, and well inside the queue's day of retention and its 100 receives. */
export const WORKFLOW_CARD_RETRY_WINDOW_MS = 12 * 60 * 60_000;

/**
 * How long a Canvas closeout is retried before it is given up on and recorded as failed. Under the queue's day of retention and its 100 receives (about 25 h at the 900 s back-off), so the
 * notice always ends here with a durable record and never in the dead-letter queue.
 */
export const CANVAS_CLOSEOUT_RETRY_WINDOW_MS = 12 * 60 * 60_000;

/** True when the task cannot own a Canvas: it has no workflow, or no Slack share and no lineage entry beyond Slack's outright refusals (the closeout's own rule for "nothing to delete"). */
export function hasNoCanvasesToClose(task: Pick<DeveloperTaskRecord, "workflow" | "share">): boolean {
  if (task.workflow === undefined) return true;
  if (task.share?.teamId !== undefined) return false;
  return (task.workflow.canvasLineage ?? []).every((entry) => entry.state === "CREATE_FAILED");
}

/** How long a notice of this kind is retried: a Canvas closeout and a task-state card keep their own windows; every other notice gets the hour. */
export function retryWindowMs(kind: string): number {
  if (kind === "canvas_closeout") return CANVAS_CLOSEOUT_RETRY_WINDOW_MS;
  return kind === "workflow" ? WORKFLOW_CARD_RETRY_WINDOW_MS : SHARE_DELIVERY_WINDOW_MS;
}

/** Whether a failed notice that is `elapsedMs` old is retried again (a workflow card is also retried within the hour; it never has a shorter window). */
export const keepsRetrying = (kind: string, elapsedMs: number): boolean => elapsedMs < retryWindowMs(kind);

/** The kinds that are retried past the hour, so a notice that finally fails ends with its own "abandoned" words and a marked durable record. */
export const endsAbandoned = (kind: string): boolean => kind === "workflow" || kind === "canvas_closeout";
