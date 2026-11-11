// Owner decision 2026-11-03: a call that Amazon Bedrock refused as "not available for this account" (the worker names it `key-rejected ModelNotEnabled`) teaches the broker that the account cannot use that model, so the next default
// choice, for any task, leaves it out for a while (`UsableModels.markUnusable`). Only Rovara's own catalog route is learned from: a company's own Bedrock source is another account.
import { MODEL_NOT_ENABLED_CODE, ModelSelectionSchema, modelFailureCodeOf, type ModelIdentifier } from "@agentx/contracts";
import type { UsableModels } from "./usable-models.js";

/**
 * The worker's fixed sentence for a model the account has not enabled (an operation's error, or a reviewer's `modelFailure`). Only a FALLBACK for results of older workers; a current worker carries the
 * structured code (`modelFailureCode` on the failed operation's result, MODEL_NOT_ENABLED_CODE), which is what this module keys on, so a change of wording cannot silently stop the learning.
 */
export const MODEL_NOT_ENABLED_FAILURE = /\bthe model call failed: key-rejected ModelNotEnabled\b/u;

interface Learnable {
  model?: unknown;
  modelRoute?: { sourceId?: unknown } | null | undefined;
}

/** The models a finished operation shows the account cannot use: the one it ran on when it failed that way, and each reviewer of a succeeded review whose own model call failed that way. */
export function modelsNotEnabled(operation: Learnable, terminalStatus: string, terminalError: string | undefined, result: unknown): ModelIdentifier[] {
  if (operation.modelRoute != null && operation.modelRoute.sourceId !== "rovara") return [];
  const found: ModelIdentifier[] = [];
  const coded = terminalStatus !== "SUCCEEDED" && modelFailureCodeOf(result) === MODEL_NOT_ENABLED_CODE;
  if (coded || (terminalStatus !== "SUCCEEDED" && terminalError !== undefined && MODEL_NOT_ENABLED_FAILURE.test(terminalError))) {
    const model = ModelSelectionSchema.safeParse(operation.model);
    if (model.success) found.push({ provider: model.data.provider, modelId: model.data.modelId });
  }
  const reports = result !== null && typeof result === "object" ? (result as { workflowReviews?: unknown }).workflowReviews : undefined;
  for (const report of Array.isArray(reports) ? reports : []) {
    const { provider, version, modelFailure } = (report ?? {}) as { provider?: unknown; version?: unknown; modelFailure?: unknown };
    if (typeof modelFailure !== "string" || !MODEL_NOT_ENABLED_FAILURE.test(modelFailure)) continue;
    const model = ModelSelectionSchema.safeParse({ provider, modelId: version });
    if (model.success) found.push({ provider: model.data.provider, modelId: model.data.modelId });
  }
  return found;
}

/** Best effort: teaching is never a reason an operation's result is not recorded. */
export async function learnModelNotEnabled(usable: UsableModels | undefined, operation: Learnable, terminalStatus: string, terminalError: string | undefined, result: unknown): Promise<void> {
  if (usable === undefined) return;
  try {
    for (const model of modelsNotEnabled(operation, terminalStatus, terminalError, result)) await usable.markUnusable(model);
  } catch { /* markUnusable does not throw; this is a backstop */ }
}
