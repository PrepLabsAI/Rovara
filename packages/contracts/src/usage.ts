import { parseChargeReceiptV1, type ChargeReceiptV1 } from "./charge-receipt.js";
import { RunUsageCallSchema, type RunUsageCallV1 } from "./run-usage.js";
import { z } from "zod";
import { isKeyedModelProvider } from "./model-providers.js";
import { ThinkingLevelSchema } from "./models.js";
import { type ThinkingLevel } from "./models-node.js";

export type PiCacheRetention = "short" | "long";
export type TaskUsageOutcome = "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface TaskUsageTelemetry {
  /** Optional evidence envelope. Worker-carried receipts are not authenticated or ingested by the engine. */
  chargeReceipts?: ChargeReceiptV1[];
  /** Assistant calls that ended without token usage or provider cost; absent on older workers. */
  usageMissingCalls?: number;
  /** #1395: on a zero report, the calls the provider refused before any stream (nothing spent); absent otherwise and on older workers. */
  refusedBeforeStreamCalls?: number;
  /** Optional unit history. Old workers omit it; readers accept it before new workers emit it. */
  calls?: RunUsageCallV1[];
  schemaVersion: 1;
  outcome: TaskUsageOutcome;
  provider: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel;
  cacheRetention: PiCacheRetention;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cacheReadRatio: number;
  costUsd: number | null;
  /** Set for keyed providers: OpenRouter's total is its billed amount when the response carried it ("billed") and an estimate otherwise; direct providers' are Pi's list prices. */
  costSource?: "estimated" | "billed" | "list-price" | "unknown";
}

/** The part of Pi's SessionStats usage telemetry reads; SessionStats is assignable to it. */
export interface UsageStats {
  calls?: RunUsageCallV1[];
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /** True when every priced usage carried the provider's own billed total (Pi's `cost.totalFromProvider`); absent when unknown. */
  costFromProvider?: boolean;
}

const TokenCount = z.number().int().nonnegative();

export const TaskUsageTelemetrySchema = z.object({
  schemaVersion: z.literal(1),
  usageMissingCalls: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  refusedBeforeStreamCalls: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  chargeReceipts: z.array(z.custom<ChargeReceiptV1>(v => parseChargeReceiptV1(v) !== undefined)).min(1).max(64).optional(),
  calls: z.array(RunUsageCallSchema).max(2000).optional(),
  outcome: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  thinkingLevel: ThinkingLevelSchema.optional(),
  cacheRetention: z.enum(["short", "long"]),
  tokens: z.object({ input: TokenCount, output: TokenCount, cacheRead: TokenCount, cacheWrite: TokenCount, total: TokenCount }).strict(),
  cacheReadRatio: z.number().min(0).max(1),
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(["estimated", "billed", "list-price", "unknown"]).optional(),
}).strict();

export function effectiveCacheRetention(value: unknown): PiCacheRetention {
  return value === "long" ? "long" : "short";
}

export function createTaskUsageTelemetry(
  stats: UsageStats,
  model: { provider: string; modelId: string; thinkingLevel?: ThinkingLevel; cacheRetention?: PiCacheRetention },
  outcome: TaskUsageOutcome,
): TaskUsageTelemetry {
  if (!model.provider || !model.modelId) throw new Error("usage telemetry requires a provider and model ID");
  const tokens = {
    input: nonNegativeInteger(stats.tokens.input, "input tokens"),
    output: nonNegativeInteger(stats.tokens.output, "output tokens"),
    cacheRead: nonNegativeInteger(stats.tokens.cacheRead, "cache-read tokens"),
    cacheWrite: nonNegativeInteger(stats.tokens.cacheWrite, "cache-write tokens"),
    total: nonNegativeInteger(stats.tokens.total, "total tokens"),
  };
  const inputSideTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  return {
    schemaVersion: 1,
    ...(stats.calls === undefined ? {} : { calls: stats.calls }),
    outcome,
    provider: model.provider,
    modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
    cacheRetention: effectiveCacheRetention(model.cacheRetention),
    tokens,
    cacheReadRatio: inputSideTokens === 0 ? 0 : tokens.cacheRead / inputSideTokens,
    costUsd: isKeyedModelProvider(model.provider) && stats.cost === 0 ? null : nonNegativeNumber(stats.cost, "session cost"),
    ...(isKeyedModelProvider(model.provider) ? { costSource: costSource(model.provider, stats.cost, stats.costFromProvider === true) } : {}),
  };
}

function costSource(provider: string, cost: number, fromProvider: boolean): "estimated" | "billed" | "list-price" | "unknown" {
  if (cost <= 0) return "unknown";
  if (provider !== "openrouter") return "list-price";
  return fromProvider ? "billed" : "estimated";
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}
