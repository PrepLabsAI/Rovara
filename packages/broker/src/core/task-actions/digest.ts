// S1: the confirm digest (server half of safeguard 2). A move whose risk is high or irreversible, or that raises the run limit, carries the digest of what its confirm showed THIS person at THIS state; `perform` recomputes it from the
// task as it is now and refuses a missing digest (`needs_input`) or a different one (`stale`) BEFORE any write, so a renderer that skipped the dialog, or another surface, cannot make the move without the confirm.
import { createHash } from "node:crypto";
import type { ActionBinding, ConfirmLines, TaskActionId } from "@agentx/contracts";

/** Canonical JSON: object keys sorted, so the same facts hash the same wherever they were built. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, field]) => `${JSON.stringify(key)}:${canonical(field)}`).join(",")}}`;
}

/** The digest of one confirm: the action, the task, the person, the revision and digest shown, the words, and whatever the move binds beyond them (the close preview's digest, the run limit shown). */
export function confirmDigestOf(input: { action: TaskActionId; taskId: string; personId: string; binding: ActionBinding; confirm: ConfirmLines; bound?: unknown }): string {
  return createHash("sha256").update(canonical(["rovara:task-action-confirm:v1", input.action, input.taskId, input.personId, input.binding, input.confirm, input.bound ?? null]), "utf8").digest("hex");
}
