import { readFile, writeFile } from "node:fs/promises";
import { EvalBatchFileSchema, SlackChannelIdSchema, SlackTeamIdSchema, agentXError, type EvalBatchSummary } from "@agentx/contracts";
import YAML from "yaml";
import { adminResponseBody } from "./http.js";

interface Connection {
  controlPlaneUrl: string;
  accessToken: string;
}

const BATCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/**
 * FR-001: reads a batch file, parses the YAML and validates it with the contract before anything is
 * posted. The broker validates again. Problems print as `path: message`, one per line.
 */
export async function readEvalBatchFile(filePath: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `cannot read the batch file ${filePath}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (error) {
    throw agentXError("CONFIG_INVALID", `${filePath} is not valid YAML: ${error instanceof Error ? error.message : "parse error"}`);
  }
  const checked = EvalBatchFileSchema.safeParse(parsed);
  if (!checked.success) {
    const problems = checked.error.issues.map((issue) => `  ${issue.path.length === 0 ? "(file)" : issue.path.join(".")}: ${issue.message}`);
    throw agentXError("CONFIG_INVALID", `${filePath} is not a valid batch file:\n${problems.join("\n")}`);
  }
  return checked.data;
}

/** FR-001: posts the validated file. The route derives the batch's ID from the file, channel and label, so a repeat finds the same batch. */
export async function startEvalBatch(
  input: Connection & { teamId: string; channelId: string; filePath: string; label?: string },
  fetchImplementation: typeof fetch = fetch,
): Promise<unknown> {
  const teamId = SlackTeamIdSchema.parse(input.teamId);
  const channelId = SlackChannelIdSchema.parse(input.channelId);
  const file = await readEvalBatchFile(input.filePath);
  return send(input, "POST", "/v1/admin/evals/batches", fetchImplementation, { teamId, channelId, file, ...(input.label === undefined ? {} : { label: input.label }) });
}

export const showEvalBatch = async (input: Connection & { batchId: string }, fetchImplementation: typeof fetch = fetch) =>
  send(input, "GET", `/v1/admin/evals/batches/${batchPath(input.batchId)}`, fetchImplementation);

export const stopEvalBatch = async (input: Connection & { batchId: string }, fetchImplementation: typeof fetch = fetch) =>
  send(input, "POST", `/v1/admin/evals/batches/${batchPath(input.batchId)}/stop`, fetchImplementation);

export const fetchEvalBatchResults = async (input: Connection & { batchId: string }, fetchImplementation: typeof fetch = fetch) =>
  send(input, "GET", `/v1/admin/evals/batches/${batchPath(input.batchId)}/results`, fetchImplementation);

function batchPath(batchId: string): string {
  if (!BATCH_ID.test(batchId)) throw agentXError("CONFIG_INVALID", "the batch ID is not valid; it looks like 4f1d7c1e-0f5e-5b57-8c0b-0d3b1a1e9a11");
  return batchId;
}

async function send(input: Connection, method: "GET" | "POST", path: string, fetchImplementation: typeof fetch, body?: unknown): Promise<unknown> {
  const response = await fetchImplementation(`${input.controlPlaneUrl.replace(/\/$/u, "")}${path}`, {
    method,
    headers: { authorization: `Bearer ${input.accessToken}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return adminResponseBody(response);
}

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? value as Json : {});
/** Text for a value the route sent: a string or number, else the fallback. */
const str = (value: unknown, fallback = ""): string => (typeof value === "string" || typeof value === "number" ? `${value}` : fallback);
const usd = (value: unknown) => `$${Number(value ?? 0).toFixed(2)}`;

/** FR-001: the batch ID, and the Slack thread only when the route returned a real one. */
export function evalBatchStartText(result: unknown): string {
  const answer = record(result);
  const batch = record(answer.batch);
  const lines = [answer.created === false ? `This batch already exists (a repeated start finds the same batch): ${str(batch.batchId)}` : `Batch started: ${str(batch.batchId)}`];
  if (batch.runs !== undefined) lines.push(`Runs queued: ${str(batch.runs)}`);
  const thread = record(answer.thread);
  if (thread.channelId !== undefined) lines.push(`Thread: ${str(thread.channelId)}/${str(thread.threadTs)}`);
  lines.push(`Follow it with: agentx admin eval batch show ${str(batch.batchId)}`);
  return lines.join("\n");
}

/** Progress for `show`; for `stop`, what the stop did. An ended batch is judged by its status (Ruling 11). */
export function evalBatchShowText(result: unknown): string {
  const answer = record(result);
  const batch = record(answer.batch);
  const counts = record(batch.counts);
  const status = str(batch.status);
  const lines: string[] = [];
  if (answer.alreadyEnded === true) lines.push(`Batch ${str(batch.batchId)} already ended (${status}); nothing to stop.`);
  else if (answer.alreadyEnded === false) lines.push(status === "STOPPING" ? "Stop requested: queued runs are cancelled and runs in flight are stopping." : `Batch stopped (${status}).`);
  lines.push(`Batch ${str(batch.batchId)}: ${answer.ended === true ? `ended: ${status}` : status}`);
  lines.push(`Spent ${usd(batch.spentUsd)} of ${usd(record(batch.file).costCapUsd)}`);
  lines.push(`Runs: queued ${str(counts.queued, "0")}, running ${str(counts.running, "0")} (starting ${str(counts.starting, "0")}), done ${str(counts.done, "0")}, failed ${str(counts.failed, "0")}, cancelled ${str(counts.cancelled, "0")}, not started ${str(counts.notStarted, "0")}`);
  return lines.join("\n");
}

/** FR-010: writes the CSV when asked, else prints the per-model table. Not-ready results give a message and write nothing. */
export async function batchResultsOutput(result: unknown, csvPath: string | undefined): Promise<string> {
  const answer = record(result);
  if (answer.ready !== true) return str(answer.message, "the batch's results are not available yet");
  if (csvPath !== undefined) {
    await writeFile(csvPath, str(answer.csv));
    const rows = Math.max(0, str(answer.csv).split("\n").filter((line) => line.length > 0).length - 1);
    return `Wrote ${rows} rows to ${csvPath}`;
  }
  return summaryTable(answer.summary as EvalBatchSummary);
}

function summaryTable(summary: EvalBatchSummary): string {
  const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
  const rows = summary.models.map((model) => [
    `${model.provider}/${model.modelId}${model.thinkingLevel === undefined ? "" : ` (${model.thinkingLevel})`}${model.routing === undefined ? "" : ` [${model.routing.only.join(",")}]`}`,
    `${model.resolved}/${model.runs}`,
    percent(model.rate),
    model.rate === null ? "n/a" : `${percent(model.wilsonLow)} to ${percent(model.wilsonHigh)}`,
    str(model.failed),
    `${usd(model.totalCostUsd)}${model.unpricedRuns > 0 ? "*" : ""}`,
    model.costPerSolvedUsd === null ? "n/a" : usd(model.costPerSolvedUsd),
  ]);
  const table = [["Model", "Solved", "Rate", "95% interval", "Failed", "Cost", "Per solved"], ...rows];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  const lines = table.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  const note = summary.models.some((model) => model.unpricedRuns > 0) ? ["", "* includes runs that reported no cost, charged at the per-run ceiling; the total is an estimate."] : [];
  return [...lines, ...note].join("\n");
}
