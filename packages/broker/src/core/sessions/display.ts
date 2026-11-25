// The status model's words for a task session (lane L6b): where the work stands in the ONE status model of the contracts (a state, a reason sentence where the state needs one, and the next step), from the
// task's facts. The task flow may supply richer words for its own task page (`facts.display`); this is the default, with the same states and fixed sentences, so every surface says the same thing and the
// notifications always have a state to compare. Fixed words only: never task content, never a raw code. F2-A: the switch itself moved to `core/task-view/status.ts`, the ONE rule the served standing shares.
import type { SessionStatus, TaskStatus } from "@agentx/contracts";
import { statusOfTask } from "../task-view/status.js";
import type { SessionTaskFacts } from "./facts.js";

export { BUDGET_PAUSE_NEXT, BUDGET_PAUSE_REASON } from "../task-view/status.js";

export function defaultTaskDisplay(facts: SessionTaskFacts, status: SessionStatus, input: { lastRunFailed?: true | undefined; ended?: boolean; step?: string | undefined } = {}): TaskStatus {
  return statusOfTask(facts, status, input);
}
