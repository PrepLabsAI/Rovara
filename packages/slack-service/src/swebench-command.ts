// Spec 043: the `eval swebench` command. Starts one run, waits for it in this thread (the thread's
// queue holds its later messages meanwhile, as a coding task's does), and posts the result.
import {
  SWEBENCH_RUN_TIME_LIMIT_SECONDS,
  SWEBENCH_TERMINAL_STATUSES,
  type ModelIdentifier,
  type ProjectModelOptions,
  type SwebenchCommand,
  type SwebenchDataset,
  type SwebenchRun,
  type SwebenchStartResult,
} from "@agentx/contracts";
import { matchApprovedModel, modelOptionsMessage } from "./model-command.js";
import { escapeText } from "./slack-format.js";

export interface SwebenchApi {
  startSwebenchRun(request: { requestId: string; dataset: SwebenchDataset; instanceId: string; model?: ModelIdentifier }): Promise<SwebenchStartResult>;
  getSwebenchRun(runId: string): Promise<SwebenchRun>;
  listProjectModels?(): Promise<ProjectModelOptions>;
}

export interface SwebenchCommandOptions {
  requestId: string;
  post: (text: string) => Promise<void>;
  /** False when resuming a run whose start the thread was already told about. */
  announce?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMilliseconds?: number;
}

const DATASET_NAMES: Record<SwebenchDataset, string> = { verified: "SWE-bench Verified", lite: "SWE-bench Lite", full: "SWE-bench" };
/** The broker's state machine ends every run within its ceiling; the wait allows for the last poll. */
const WAIT_LIMIT_MS = (SWEBENCH_RUN_TIME_LIMIT_SECONDS + 15 * 60) * 1_000;

/** Runs the command to its end: a refusal, or the run's result, posted in the thread. */
export async function runSwebenchCommand(command: SwebenchCommand, api: SwebenchApi, options: SwebenchCommandOptions): Promise<void> {
  if (command.kind === "invalid") {
    await options.post(escapeText(command.message));
    return;
  }
  let model: ModelIdentifier | undefined;
  if (command.modelSelector !== undefined) {
    if (api.listProjectModels === undefined) throw new Error("project model selection is unavailable in this deployment");
    const models = await api.listProjectModels();
    const matches = matchApprovedModel(command.modelSelector, models.approved);
    if (matches.length !== 1) {
      const reason = matches.length === 0
        ? `No approved coding model matches “${escapeText(command.modelSelector)}”.`
        : `“${escapeText(command.modelSelector)}” matches more than one approved coding model.`;
      await options.post(modelOptionsMessage(models, reason));
      return;
    }
    model = { provider: matches[0]!.provider, modelId: matches[0]!.modelId };
  }
  const started = await api.startSwebenchRun({
    requestId: options.requestId,
    dataset: command.dataset,
    instanceId: command.instanceId,
    ...(model === undefined ? {} : { model }),
  });
  if (started.outcome === "REFUSED") {
    await options.post(started.message);
    return;
  }
  const run = started.run;
  if (options.announce !== false && !SWEBENCH_TERMINAL_STATUSES.has(run.status)) {
    await options.post([
      `Started a SWE-bench run of \`${escapeText(run.instanceId)}\` from ${DATASET_NAMES[run.dataset]} on \`${escapeText(run.model.provider)}/${escapeText(run.model.modelId)}\`, with a cost ceiling of ${usd(run.maxCostUsd)}.`,
      "It runs on its own instance and usually takes 15 to 60 minutes. I'll post the result here; say `stop` to cancel it.",
    ].join("\n"));
  }
  const finished = await waitForRun(api, run, options);
  await options.post(resultMessage(finished));
}

async function waitForRun(api: SwebenchApi, run: SwebenchRun, options: SwebenchCommandOptions): Promise<SwebenchRun> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + WAIT_LIMIT_MS;
  let current = run;
  while (!SWEBENCH_TERMINAL_STATUSES.has(current.status)) {
    if (now() > deadline) throw new Error(`SWE-bench run ${run.runId} did not finish within its time limit`);
    await sleep(options.pollMilliseconds ?? 30_000);
    current = await api.getSwebenchRun(run.runId);
  }
  return current;
}

/** The thread's result message (spec 043 SC-003): resolved or not, tests, why the agent stopped, time, cost and artifacts. */
export function resultMessage(run: SwebenchRun): string {
  const task = `\`${escapeText(run.instanceId)}\``;
  if (run.status === "CANCELLED") return `The SWE-bench run of ${task} was cancelled and its instance terminated.`;
  if (run.status === "FAILED" || run.result === undefined) {
    return `The SWE-bench run of ${task} failed: ${escapeText(run.error ?? "no reason was recorded")}`;
  }
  const result = run.result;
  const lines = [
    result.resolved ? `*Resolved* ${task} (${DATASET_NAMES[run.dataset]}).` : `*Not resolved:* ${task} (${DATASET_NAMES[run.dataset]}).`,
  ];
  if (result.failToPass !== undefined && result.passToPass !== undefined) {
    lines.push(`• Tests: FAIL_TO_PASS ${result.failToPass.passed}/${result.failToPass.total}, PASS_TO_PASS ${result.passToPass.passed}/${result.passToPass.total}`);
  } else {
    lines.push("• Tests: not run, because the agent changed nothing");
  }
  lines.push(`• Agent: ${stopped(result.stopReason)} after ${duration(result.agentSeconds)}${result.stopDetail === undefined ? "" : ` (${escapeText(result.stopDetail)})`}`);
  const cost = result.usage.costUsd === null ? "unknown cost" : usd(result.usage.costUsd);
  lines.push(`• Cost: ${cost} for ${result.usage.tokens.total.toLocaleString("en-US")} tokens on \`${escapeText(result.usage.provider)}/${escapeText(result.usage.modelId)}\``);
  lines.push(`• Patch, transcript and harness logs: \`${escapeText(result.artifactsPrefix)}\` in the artifact bucket`);
  return lines.join("\n");
}

function stopped(reason: NonNullable<SwebenchRun["result"]>["stopReason"]): string {
  switch (reason) {
    case "finished": return "finished";
    case "time_limit": return "stopped at its time limit";
    case "cost_ceiling": return "stopped at the cost ceiling";
    case "cost_unknown": return "stopped because its cost could not be measured";
    case "loop_guard": return "stopped for repeating a failing call";
    case "model_error": return "stopped by a model error";
  }
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}
