import { RunUsageCallSchema, type RunUsageCallV1 } from "@agentx/contracts";
const record = (v: unknown): Record<string, unknown> | undefined => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const missing = { state: "unavailable", reason: "not_measured" } as const;
/** Transcript message IDs are stable across checkpoints and reopening. No prompt or response content leaves the worker. */
export function callsOfEntries(entries: readonly unknown[]): RunUsageCallV1[] {
  const calls: RunUsageCallV1[] = [];
  for (const value of entries) {
    const entry = record(value); const message = record(entry?.["message"]);
    if (entry?.["type"] !== "message" || message?.["role"] !== "assistant" || typeof entry["id"] !== "string") continue;
    const usage = record(message["usage"]);
    const readable = usage !== undefined && ["input", "output", "cacheRead", "cacheWrite"].every((key) => typeof usage[key] === "number" && Number.isSafeInteger(usage[key]) && usage[key] >= 0);
    const call = RunUsageCallSchema.safeParse({
      callId: entry["id"], stage: "unknown", granularity: "call", model: typeof message["provider"] === "string" && typeof message["model"] === "string" ? { state: "available", value: { provider: message["provider"], modelId: message["model"] } } : missing,
      source: missing, price: missing, settledMicros: missing,
      usage: readable ? { state: "available", value: { input: usage["input"], output: usage["output"], cacheRead: usage["cacheRead"], cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: usage["cacheWrite"] } } : missing,
      status: readable ? "estimated" : "awaiting_usage",
    });
    if (call.success) calls.push(call.data);
    if (calls.length >= 2000) break;
  }
  return calls;
}
