import type { TaskFlowDeps } from "../task-flow/deps.js";
import type { TaskActionsOptions } from "../task-flow/owner-round.js";

/** The live task cap and the same ledger used by ordinary fixes. Unknown spend refuses through admitRound. */
export function feedbackRoundOptions(deps: TaskFlowDeps): TaskActionsOptions {
  return { roundCap: async task => {
    const limitUsd = await deps.taskCapUsd?.(task);
    if (deps.taskCapUsd !== undefined && limitUsd === undefined) throw new Error("The task spending limit is unknown.");
    if (limitUsd === undefined) return undefined;
    return { limitUsd, spentUsd: await deps.taskSpendUsd?.(task.taskId) };
  } };
}
