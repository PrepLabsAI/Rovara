// The lighter flow's record (`workflow.flow`) is written without moving the workflow's revision: a dispatch row waits for the revision it was made at, so moving it would strand the step that row starts.
// A writer that holds a WHOLE workflow (every engine transition does) and read it before the record was written must not write it back over the record, and must not be refused for it either (a refusal strands the
// row the same way). So such a writer sets only the keys it changed (`workflowWriteOps`), never `flow` unless it changed `flow` itself; the stored record is carried forward. A writer that does change `flow` is fenced
// on the record it read (`flowIs`): a write that lost that race is refused like one that lost the revision, and the caller reads again.
import { agentXError, change, when, type UpdateOp as ChangeOp, type Condition, type JsonValue, type WorkflowFlow, type WorkflowSnapshot } from "@agentx/contracts";

/** The condition "the task's stored `flow` is the one I read" (absent when I read none). */
export function flowIs(flow: WorkflowFlow | undefined): Condition {
  return flow === undefined ? when.notExists(["workflow", "flow"]) : when.eq(["workflow", "flow"], JSON.parse(JSON.stringify(flow)) as JsonValue);
}

const stable = (value: unknown): string => JSON.stringify(value, (_key, inner: unknown) => (inner !== null && typeof inner === "object" && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : 1))) : inner));

export interface WorkflowWrite {
  /** The updates of the task item's `workflow`: one per key that differs, and none for `flow` unless the writer changed it. */
  ops: ChangeOp[];
  /** Conditions to add to the write's own (the fence on `flow`, when `flow` is among the changes). */
  guard: Condition[];
}

/**
 * The updates that turn the stored workflow (which the writer read as `current`, at the revision its condition names) into `next`: a key set where it differs, a key removed where `next` has dropped it. `flow` is carried forward
 * (left alone) unless `next.flow` differs from `current.flow` and `ownsFlow` is true; then it is set, under a fence on the record read. A writer that does not own `flow` and changed it throws. Without `current` the whole workflow is written, as before.
 */
export function workflowWriteOps(current: Pick<WorkflowSnapshot, "revision"> & Record<string, unknown> | undefined, next: WorkflowSnapshot, options: { ownsFlow?: boolean } = {}): WorkflowWrite {
  const after = JSON.parse(JSON.stringify(next)) as Record<string, JsonValue>;
  if (current === undefined) return { ops: [change.set(["workflow"], after)], guard: [] };
  const before = JSON.parse(JSON.stringify(current)) as Record<string, JsonValue>;
  const ops: ChangeOp[] = [];
  const guard: Condition[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "flow") {
      // A writer that does not own `flow` and still carries a changed one would lose it silently: that is a bug in the writer, and it is refused, loudly.
      if (options.ownsFlow !== true && stable(before[key]) !== stable(after[key])) throw agentXError("CONFIG_INVALID", "a workflow writer that does not own the flow record changed it");
      if (options.ownsFlow === true && stable(before[key]) !== stable(after[key])) {
        ops.push(after[key] === undefined ? change.remove(["workflow", "flow"]) : change.set(["workflow", "flow"], after[key]));
        guard.push(flowIs(current["flow"] as WorkflowFlow | undefined));
      }
      continue;
    }
    if (stable(before[key]) === stable(after[key])) continue;
    ops.push(after[key] === undefined ? change.remove(["workflow", key]) : change.set(["workflow", key], after[key]));
  }
  return { ops, guard };
}
