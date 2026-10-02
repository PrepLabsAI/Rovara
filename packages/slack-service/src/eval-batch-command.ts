// Spec 052 FR-002: the `eval batch` command. It resolves the form's models against the project's
// approved list, as `eval swebench` does, has the broker build and record the batch, and posts its
// start message. It does not wait: the batch watcher posts the batch's progress and summary.
import type {
  EvalBatchCommand,
  EvalBatchModel,
  EvalBatchSlackStartRequest,
  EvalBatchSlackStartResult,
  EvalBatchWatchChange,
  EvalBatchWatched,
  EvalBatchWatchUpdateResult,
  ModelIdentifier,
  ProjectModelOptions,
} from "@agentx/contracts";
import { matchApprovedModel, modelOptionsMessage } from "./model-command.js";
import { escapeText } from "./slack-format.js";
import { DATASET_NAMES } from "./swebench-command.js";

export interface EvalBatchStartApi {
  startEvalBatch(request: EvalBatchSlackStartRequest): Promise<EvalBatchSlackStartResult>;
  listProjectModels?(): Promise<ProjectModelOptions>;
  /** Records on the batch that its start message was posted (M-3). */
  updateEvalBatchWatch?(batchId: string, revision: number, change: EvalBatchWatchChange): Promise<EvalBatchWatchUpdateResult>;
}

export async function runEvalBatchCommand(
  command: EvalBatchCommand,
  api: EvalBatchStartApi,
  options: {
    post: (text: string) => Promise<void>;
    redelivered?: boolean;
    now?: () => number;
    log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
  },
): Promise<void> {
  if (command.kind === "invalid") {
    await options.post(escapeText(command.message));
    return;
  }
  if (api.listProjectModels === undefined) throw new Error("project model selection is unavailable in this deployment");
  const approved = await api.listProjectModels();
  const models: ModelIdentifier[] = [];
  for (const selector of command.modelSelectors) {
    const matches = matchApprovedModel(selector, approved.approved);
    if (matches.length !== 1) {
      const reason = matches.length === 0
        ? `No approved coding model matches “${escapeText(selector)}”.`
        : `“${escapeText(selector)}” matches more than one approved coding model.`;
      await options.post(modelOptionsMessage(approved, reason));
      return;
    }
    models.push({ provider: matches[0]!.provider, modelId: matches[0]!.modelId });
  }
  const started = await api.startEvalBatch({
    dataset: command.dataset,
    instanceIds: command.instanceIds,
    models,
    selectors: command.modelSelectors,
    repeats: command.repeats,
    ...(command.costCapUsd === undefined ? {} : { costCapUsd: command.costCapUsd }),
  });
  if (started.outcome === "REFUSED") {
    await options.post(`I couldn't start this batch: ${escapeText(started.message)}`);
    return;
  }
  const { batch } = started;
  // A redelivery whose first delivery created the batch but failed to post its start message posts it now.
  if (started.created || batch.watch.startPostedAt === undefined) {
    await options.post(batchStartMessage(batch, "slack"));
    try {
      await api.updateEvalBatchWatch?.(batch.batchId, batch.watch.revision, { startPostedAt: new Date(options.now?.() ?? Date.now()).toISOString() });
    } catch (error) {
      // Only a hint for a redelivery: the batch runs and the watcher posts either way.
      options.log?.("eval_batch.start_record_failed", { batchId: batch.batchId, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  // A redelivered event found the batch its first delivery created, and announced.
  if (options.redelivered === true) return;
  await options.post(`This thread already started eval batch \`${started.batch.batchId}\` (${started.batch.status}); its progress is posted here.`);
}

/** The batch's start message: posted by the form in its thread, or by the watcher to open a CLI batch's thread. */
export function batchStartMessage(batch: EvalBatchWatched, origin: "slack" | "cli"): string {
  const opening = origin === "slack" ? `Started eval batch \`${batch.batchId}\`:` : `Eval batch \`${batch.batchId}\` started from the CLI:`;
  const ceiling = batch.perRunCeilingUsd === undefined ? "" : ` (each run's ceiling is ${usd(batch.perRunCeilingUsd)})`;
  return [
    `${opening} ${count(batch.runs, "run")} of ${DATASET_NAMES[batch.benchmark]}: ${count(batch.tasks, "task")} × ${count(batch.models.length, "model")} × ${count(batch.repeats, "repeat")}, with a cost cap of ${usd(batch.costCapUsd)}${ceiling}.`,
    `Models: ${batch.models.map((entry) => modelLabel(entry.model)).join(", ")}`,
    "I'll post progress here and a summary table when it ends; say `stop` in this thread to stop the batch.",
  ].join("\n");
}

/** A batch model in a message: its identifier, thinking level and OpenRouter providers. */
export function modelLabel(model: EvalBatchModel): string {
  const via = model.routing === undefined ? "" : `, via ${model.routing.only.map(escapeText).join(", ")}`;
  return `\`${escapeText(model.provider)}/${escapeText(model.modelId)}\` (thinking ${model.thinkingLevel}${via})`;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
