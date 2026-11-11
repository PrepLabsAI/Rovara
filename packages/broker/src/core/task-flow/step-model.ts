// The model a task step runs on. Before a workflow step is handed to a worker, the install's model rule (`core/model-selection`) chooses its model; the choice is recorded on the operation in the same transaction that
// claims the dispatch, so a repeat delivery sends the same model, the model proxy grants a token for exactly that route, a plan check and a review are told which model they checked, and a failure that says the model
// cannot be used (not enabled for the account, not priced under a limit) teaches the next choice to leave it out.
import type { InvocationModelRoute, ModelFallback, ModelIdentifier, ModelSelection, StageId, ThinkingLevel } from "@agentx/contracts";
import { STAGE_OF_WORKFLOW_MODE, type ModelSelectionService } from "../model-selection/service.js";
import type { OperationRecord } from "./records.js";
import { workspaceOperations } from "./reads.js";
import type { TaskFlowDeps } from "./deps.js";

/** What the operation record keeps of the choice made for it. */
export interface OperationModelChoice {
  stage: StageId;
  model: ModelIdentifier;
  route: InvocationModelRoute;
  thinkingLevel?: ThinkingLevel;
  reason: string;
  fallback?: ModelFallback;
  /** A checking step on the same model as the step it checks (the install has one model, or nothing else was usable): the plan or the review says so. */
  sameModelAsChecked?: boolean;
}

export type StepModelOutcome =
  | { ok: true; choice: OperationModelChoice; /** The model as the worker takes it (the route carries the alias; this carries the thinking level). */ selection: ModelSelection; /** False: the record already held it. */ fresh: boolean }
  | { ok: false; sentence: string };

/** The operations whose model a checking stage checks, by workflow mode: the plan's for the plan check, the build's for the reviews. */
const CHECKED_MODES: Readonly<Partial<Record<StageId, readonly string[]>>> = { plan_check: ["PLAN", "SPEC_WRITE", "SETUP_DRAFT", "SETUP_AGENT"], code_review: ["IMPLEMENT"], security_review: ["IMPLEMENT"] };

const selectionOf = (choice: OperationModelChoice): ModelSelection => ({ provider: choice.model.provider, modelId: choice.model.modelId, ...(choice.thinkingLevel === undefined ? {} : { thinkingLevel: choice.thinkingLevel }) });

/** The outcome for an operation that already holds its choice (a repeat delivery, or the other of two deliveries that raced). */
export const heldStepModel = (choice: OperationModelChoice): Extract<StepModelOutcome, { ok: true }> => ({ ok: true, choice, selection: selectionOf(choice), fresh: false });

/**
 * The choice for a step of a task, or undefined when this operation has none to make (it is not a workflow step with a model, a design-review round carries its own models, or the install has no per-step rule):
 * the install's one model then stands, as it always did. An operation that already holds a choice (a repeat delivery) keeps it.
 */
export async function chooseStepModel(deps: Pick<TaskFlowDeps, "stepModels" | "store">, operation: OperationRecord): Promise<StepModelOutcome | undefined> {
  const stepModels: Pick<ModelSelectionService, "choose"> | undefined = deps.stepModels;
  if (stepModels === undefined || operation.dispatch.kind !== "task" || operation.designReview !== undefined) return undefined;
  if (operation.modelChoice !== undefined) return heldStepModel(operation.modelChoice);
  const stage = operation.workflowMode === undefined ? undefined : STAGE_OF_WORKFLOW_MODE[operation.workflowMode];
  if (stage === undefined) return undefined;
  // A checking step is told the model of the step it checks: the newest operation of that step that recorded one.
  let reference: ModelIdentifier | undefined;
  const modes = CHECKED_MODES[stage];
  if (modes !== undefined) {
    const earlier = (await workspaceOperations(deps, operation.workspaceId)).filter((other) => other.id !== operation.id && other.workflowMode !== undefined && modes.includes(other.workflowMode) && other.modelChoice !== undefined);
    reference = earlier.at(-1)?.modelChoice?.model;
  }
  const outcome = await stepModels.choose({ stage, reference });
  // No model at all (no key is set up): the step is handed over with no model route, as it always was, and the worker fails with its own reason. Any other refusal says why no model fits this step.
  if (!outcome.ok) return outcome.code === "NO_MODEL" ? undefined : { ok: false, sentence: outcome.words };
  const { step } = outcome;
  const choice: OperationModelChoice = {
    stage, model: step.model, route: step.route, reason: step.reason, ...(step.thinkingLevel === null ? {} : { thinkingLevel: step.thinkingLevel }),
    ...(step.fallback === undefined ? {} : { fallback: step.fallback }), ...(step.sameModelAsChecked ? { sameModelAsChecked: true } : {}),
  };
  return { ok: true, choice, selection: selectionOf(choice), fresh: true };
}
