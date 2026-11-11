// Work events, the part that needs Node (`node:crypto`): the id of an event. See `work-event.ts` for what an event is.
import { createHash } from "node:crypto";
import type { WorkEventKind } from "./work-event.js";

/**
 * The id of a work event, derived from the source change: the same kind, task and `source` (a short text that names the change inside the task: a request id, a milestone number, `<repository>#<number>`, an
 * operation id) is always the same id. A repeat of a change (a retry, a replayed webhook) therefore names the event it already wrote, and a store that writes an id once keeps one event.
 */
export function workEventId(parts: { kind: WorkEventKind; taskId: string; source: string }): string {
  if (parts.source === "") throw new Error("a work event names the change it records");
  return `wev_${createHash("sha256").update(`work-event/v1\0${parts.kind}\0${parts.taskId}\0${parts.source}`).digest("hex").slice(0, 32)}`;
}
