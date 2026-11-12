// The plan check on a model the account could not use. A check whose model refused this account (a model not enabled for it, a key the provider rejected for that model, a model with no endpoint) is made
// again on the next model the install's rule ranks, one try for each, at most `CRITIC_MODEL_ATTEMPTS_MAX` tries after the latest planning run; the models that failed are left out of the next choice and
// the last try may take the planner's own model (it answered this account a moment ago). With no model left the check closes as "not checked": the plan goes to the person, never held back. A failed try
// costs nothing: the model refuses before it answers, and the retry starts no machine until its model is chosen.
//
// Only a check whose model the rule chose for it can be made on another model; a check on the install's one model (no step setting, the laptop default) has no next model to ask, so it closes at the
// first such failure, as before.
import { ModelSelectionSchema, type ModelIdentifier } from "@agentx/contracts";
import { criticModelUnusable } from "../../rovara-code/critic.js";
import type { OperationRecord } from "../task-flow/records.js";

/**
 * The most tries one plan check makes, one model each. Six cover every capability tier once, and the last of them is the model that wrote the plan. The same bound as the hosted product's, so a company
 * moving between the two sees the same number of tries.
 */
export const CRITIC_MODEL_ATTEMPTS_MAX = 6;

/** The words a plan check's step ends with when every try it may make has been made. Never words `criticModelUnusable` reads as a model failure, so the check closes instead of trying again. */
export const PLAN_CHECK_NO_MODEL_LEFT = "Every model this plan check may use was tried, and none could be used by this account, so the plan was not checked.";

/** Whether an operation is a plan check's (not a design review round, which runs in the same stage with its own retry rule). */
const isPlanCheck = (operation: Pick<OperationRecord, "workflowMode" | "designReview">): boolean => operation.workflowMode === "PLAN_CRITIQUE" && operation.designReview === undefined;

/**
 * The plan checks of one workspace that failed because their model could not serve this account: the models they ran on (the model the install's rule chose for each), to leave out of the next choice,
 * and how many came after the latest planning run (a revised plan is checked again with the earlier refusals remembered and the tries counted afresh). A failed check that recorded no model counts as a try.
 */
export function planCheckFailures(operations: readonly OperationRecord[]): { models: ModelIdentifier[]; sinceLatestPlan: number } {
  const planners = operations.filter((operation) => operation.workflowMode === "PLAN");
  const from = planners.reduce((latest, operation) => (operation.createdAt > latest ? operation.createdAt : latest), "");
  const failed = operations.filter((operation) => isPlanCheck(operation) && operation.status === "FAILED" && criticModelUnusable(operation.error));
  const models: ModelIdentifier[] = [];
  for (const operation of failed) {
    const model = ModelSelectionSchema.safeParse(operation.modelChoice?.model);
    if (model.success) models.push({ provider: model.data.provider, modelId: model.data.modelId });
  }
  return { models, sinceLatestPlan: failed.filter((operation) => operation.createdAt >= from).length };
}

/**
 * Whether a plan check that just ended FAILED is made again on the next model: its error says the model could not serve this account, the model it ran on was chosen by the install's rule (so the next
 * choice can leave it out, and it is not the install's one model, which leaves nothing else to ask), and fewer than `CRITIC_MODEL_ATTEMPTS_MAX` tries were made since the latest planning run, counting this one. `earlier` is the workspace's other operations.
 */
export function retriesPlanCheck(ended: Pick<OperationRecord, "modelChoice">, error: string | undefined, earlier: readonly OperationRecord[]): boolean {
  // The install's one model (the rule chose no model of the check's own) has no next model to ask: the check closes at once, with no try that could only fail.
  if (!criticModelUnusable(error) || ended.modelChoice === undefined || ended.modelChoice.reason === "INSTALL_MODEL") return false;
  return planCheckFailures(earlier).sinceLatestPlan + 1 < CRITIC_MODEL_ATTEMPTS_MAX;
}
