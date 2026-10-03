import { z } from "zod";
import { isKeyedModelProvider } from "./model-providers.js";
import { ThinkingLevelSchema, type ThinkingLevel } from "./models.js";

export type PiCacheRetention = "short" | "long";
export type TaskUsageOutcome = "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface TaskUsageTelemetry {
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
  /** Set for keyed providers: OpenRouter prices are estimates, direct providers' are Pi's list prices. */
  costSource?: "estimated" | "list-price" | "unknown";
}

/** The part of Pi's SessionStats usage telemetry reads; SessionStats is assignable to it. */
export interface UsageStats {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
}

const TokenCount = z.number().int().nonnegative();

export const TaskUsageTelemetrySchema = z.object({
  schemaVersion: z.literal(1),
  outcome: z.enum(["SUCCEEDED", "FAILED", "CANCELLED"]),
  provider: z.string().min(1).max(128),
  modelId: z.string().min(1).max(256),
  thinkingLevel: ThinkingLevelSchema.optional(),
  cacheRetention: z.enum(["short", "long"]),
  tokens: z.object({ input: TokenCount, output: TokenCount, cacheRead: TokenCount, cacheWrite: TokenCount, total: TokenCount }).strict(),
  cacheReadRatio: z.number().min(0).max(1),
  costUsd: z.number().nonnegative().nullable(),
  costSource: z.enum(["estimated", "list-price", "unknown"]).optional(),
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
    outcome,
    provider: model.provider,
    modelId: model.modelId,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
    cacheRetention: effectiveCacheRetention(model.cacheRetention),
    tokens,
    cacheReadRatio: inputSideTokens === 0 ? 0 : tokens.cacheRead / inputSideTokens,
    costUsd: isKeyedModelProvider(model.provider) && stats.cost === 0 ? null : nonNegativeNumber(stats.cost, "session cost"),
    ...(isKeyedModelProvider(model.provider) ? { costSource: costSource(model.provider, stats.cost) } : {}),
  };
}

function costSource(provider: string, cost: number): "estimated" | "list-price" | "unknown" {
  if (cost <= 0) return "unknown";
  return provider === "openrouter" ? "estimated" : "list-price";
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}
