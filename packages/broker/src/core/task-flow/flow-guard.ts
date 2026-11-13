// The lighter flow's record (`workflow.flow`) is written without moving the workflow's revision: a dispatch row waits for the revision it was made at, so moving it would strand the step that row starts. A writer that holds a
// WHOLE workflow (every engine transition does) and read it before the record was written would write it back over the record. So every such writer adds this condition: the stored `flow` must still be the one it read, and a
// write that lost that race is refused like one that lost the revision (the caller reads again).
import { when, type Condition, type JsonValue, type WorkflowFlow } from "@agentx/contracts";

/** The condition "the task's stored `flow` is the one I read" (absent when I read none). */
export function flowIs(flow: WorkflowFlow | undefined): Condition {
  return flow === undefined ? when.notExists(["workflow", "flow"]) : when.eq(["workflow", "flow"], JSON.parse(JSON.stringify(flow)) as JsonValue);
}
