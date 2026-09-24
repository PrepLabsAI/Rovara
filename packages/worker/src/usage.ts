import type { SessionStats } from "@earendil-works/pi-coding-agent";

export type PiCacheRetention = "short" | "long";
export type TaskUsageOutcome = "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface TaskUsageTelemetry {
  schemaVersion: 1;
  outcome: TaskUsageOutcome;
  provider: string;
  modelId: string;
  cacheRetention: PiCacheRetention;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cacheReadRatio: number;
  costUsd: number;
}

export function effectiveCacheRetention(value: unknown): PiCacheRetention {
  return value === "long" ? "long" : "short";
}

export function createTaskUsageTelemetry(
  stats: SessionStats,
  model: { provider: string; modelId: string; cacheRetention?: PiCacheRetention },
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
    cacheRetention: effectiveCacheRetention(model.cacheRetention),
    tokens,
    cacheReadRatio: inputSideTokens === 0 ? 0 : tokens.cacheRead / inputSideTokens,
    costUsd: nonNegativeNumber(stats.cost, "session cost"),
  };
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}
