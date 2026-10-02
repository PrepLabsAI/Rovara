// Spec 052 Task 5: what the admin routes of eval batches do (FR-001, FR-003, FR-009, FR-010). The
// broker checks the administrator first; this module reads and writes the batch.
import { createHash } from "node:crypto";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  EvalBatchFileSchema,
  EvalBatchSummarySchema,
  SlackChannelIdSchema,
  SlackTeamIdSchema,
  agentXError,
  type EvalBatchRecord,
  type EvalBatchSummary,
  type SlackRequester,
  type SlackThread,
} from "@agentx/contracts";
import { createBatch, evalBatchResultsKeys, getBatch, stopBatch, type EvalBatchDependencies } from "./eval-batch.js";
import type { SwebenchSlackContext } from "./swebench.js";

const TERMINAL: ReadonlySet<EvalBatchRecord["status"]> = new Set(["DONE", "STOPPED", "CAPPED"]);

/** The Slack user an administrator's batch is attributed to: an administrator has no Slack identity. */
export const EVAL_BATCH_ADMIN_USER = "UAGENTXCLI";

/**
 * A batch started from the CLI has no Slack thread yet: Task 6's watcher opens one with its first post.
 * Until then the record carries a placeholder timestamp unique to the batch. Real timestamps are ten
 * digits that begin with 1; a placeholder begins with 00, so the watcher can tell them apart.
 */
export function evalBatchPlaceholderThreadTs(batchId: string): string {
  const digits = BigInt(`0x${createHash("sha256").update(`agentx eval batch thread v1:${batchId}`).digest("hex").slice(0, 12)}`).toString().padStart(14, "0").slice(-14);
  return `00${digits.slice(0, 8)}.${digits.slice(8)}`;
}

export function isPlaceholderThreadTs(threadTs: string): boolean {
  return threadTs.startsWith("00");
}

/** Keys sorted at every level, so the same content hashes the same however the file was written. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/**
 * A batch's ID is derived from the file's validated content (defaults filled in), the channel and an
 * optional label, so a repeated or redelivered start finds its batch instead of creating a second.
 * A label starts a deliberate second run of the same file.
 */
export function evalBatchIdFor(file: unknown, teamId: string, channelId: string, label?: string): string {
  const parsed = EvalBatchFileSchema.parse(file);
  const bytes = createHash("sha256").update(JSON.stringify(["agentx eval batch v1", canonical(parsed), teamId, channelId, label ?? null])).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What `show` and `stop` answer: the record without its queue (up to 1000 entries), and whether it has ended, by its status. */
function view(record: EvalBatchRecord) {
  const { queue, ...rest } = record;
  return { ...rest, models: record.file.models.length, runs: queue.length };
}

export interface StartBatchBody {
  teamId: string;
  channelId: string;
  file: unknown;
  label?: string | undefined;
}

export function parseStartBody(value: unknown): StartBatchBody {
  const body = (value ?? {}) as Record<string, unknown>;
  const label = body.label;
  if (label !== undefined && (typeof label !== "string" || label.length === 0 || label.length > 80)) {
    throw agentXError("CONFIG_INVALID", "label must be 1 to 80 characters");
  }
  return {
    teamId: SlackTeamIdSchema.parse(body.teamId),
    channelId: SlackChannelIdSchema.parse(body.channelId),
    file: body.file,
    label,
  };
}

export async function startBatch(
  dependencies: EvalBatchDependencies,
  context: Omit<SwebenchSlackContext, "thread" | "requester">,
  body: StartBatchBody,
) {
  const batchId = evalBatchIdFor(body.file, body.teamId, body.channelId, body.label);
  const existing = await getBatch(dependencies, batchId);
  const thread: SlackThread = { teamId: body.teamId, channelId: body.channelId, threadTs: evalBatchPlaceholderThreadTs(batchId) };
  const requester: SlackRequester = { teamId: body.teamId, userId: EVAL_BATCH_ADMIN_USER };
  const record = existing ?? await createBatch(dependencies, { ...context, thread, requester }, body.file, { batchId });
  // The Slack thread is opened by the batch watcher (Task 6); only a real one is reported.
  return {
    created: existing === undefined,
    batch: view(record),
    ...(isPlaceholderThreadTs(record.thread.threadTs) ? {} : { thread: record.thread }),
  };
}

export async function showBatch(dependencies: EvalBatchDependencies, batchId: string) {
  const record = await requireBatch(dependencies, batchId);
  return { ended: TERMINAL.has(record.status), batch: view(record) };
}

/** FR-009. An ended batch is not stopped again: its final status is reported (Ruling 11). */
export async function stopBatchById(dependencies: EvalBatchDependencies, batchId: string) {
  const record = await requireBatch(dependencies, batchId);
  if (TERMINAL.has(record.status)) return { alreadyEnded: true, ended: true, batch: view(record) };
  const stopped = await stopBatch(dependencies, batchId, { teamId: record.thread.teamId, userId: EVAL_BATCH_ADMIN_USER });
  const after = stopped ?? await requireBatch(dependencies, batchId);
  return { alreadyEnded: false, ended: TERMINAL.has(after.status), batch: view(after) };
}

/** FR-010: the results the tick wrote to S3, read here so the CLI needs no AWS credentials. */
export async function batchResults(dependencies: EvalBatchDependencies, batchId: string) {
  const record = await requireBatch(dependencies, batchId);
  if (!TERMINAL.has(record.status)) {
    return { ready: false, status: record.status, message: `batch ${batchId} is still running (${record.status}); its results are written once it ends` };
  }
  const keys = evalBatchResultsKeys(batchId);
  const [csv, summary] = [await readObject(dependencies, keys.csv), await readObject(dependencies, keys.summary)];
  if (csv === undefined || summary === undefined) {
    return { ready: false, status: record.status, message: `batch ${batchId} has ended (${record.status}), but its results are not written yet; they are written within a few minutes, try again shortly` };
  }
  const parsed: EvalBatchSummary = EvalBatchSummarySchema.parse(JSON.parse(summary));
  return { ready: true, status: record.status, csv, summary: parsed };
}

async function readObject(dependencies: EvalBatchDependencies, key: string): Promise<string | undefined> {
  try {
    const object = await dependencies.s3.send(new GetObjectCommand({ Bucket: dependencies.artifactBucketName, Key: key }));
    return object.Body ? await object.Body.transformToString("utf8") : undefined;
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NoSuchKey" || name === "NotFound") return undefined;
    throw error;
  }
}

export async function requireBatch(dependencies: EvalBatchDependencies, batchId: string): Promise<EvalBatchRecord> {
  const record = await getBatch(dependencies, batchId);
  if (record === undefined) throw agentXError("NOT_FOUND", `batch ${batchId} not found`);
  return record;
}
