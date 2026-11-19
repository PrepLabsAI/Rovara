import { expect, it } from "vitest";
import { createUsageCheckpointer, createTaskUsageTelemetry, type UsageStats } from "../../packages/worker/src/usage.js";
import { EventBatcher, WORKER_EVENT_PAYLOAD_MAX_BYTES, type WorkerEvent } from "../../packages/worker/src/events.js";
const model = { provider: "fixture", modelId: "model" };
const tokens = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 };
const un = { state: "unavailable", reason: "not_measured" } as const;
function nearCap(): UsageStats {
 const stats: UsageStats = { tokens, cost: 0.25, calls: [] };
 const call = { callId: "call", stage: "build", granularity: "call", model: un, source: un, usage: un, price: un, settledMicros: un, status: "estimated" } as const;
 while (Buffer.byteLength(JSON.stringify(createTaskUsageTelemetry(stats, model, "SUCCEEDED"))) < WORKER_EVENT_PAYLOAD_MAX_BYTES - 500) stats.calls!.push({ ...call, callId: String(stats.calls!.length) });
 const size = Buffer.byteLength(JSON.stringify(createTaskUsageTelemetry(stats, model, "SUCCEEDED")));
 stats.calls!.at(-1)!.stage += "x".repeat(WORKER_EVENT_PAYLOAD_MAX_BYTES - 1 - size);
 expect(Buffer.byteLength(JSON.stringify(createTaskUsageTelemetry(stats, model, "SUCCEEDED")))).toBe(WORKER_EVENT_PAYLOAD_MAX_BYTES - 1);
 return stats;
}
it.each(["checkpoint", "final"] as const)("bounds the final %s payload including missing-usage fields, preserving totals through the batcher", async kind => {
 let stats: UsageStats = { tokens: { ...tokens, input: 0, output: 0, total: 0 }, cost: 0 };
 const sent: Record<string, unknown>[] = [];
 const tracker = createUsageCheckpointer({ enabled: true, baseline: undefined, stats: () => stats, model: () => model, requested: {}, send: p => sent.push(p) });
 if (kind === "final") { stats = { tokens, cost: 0.25 }; tracker.checkpointNow(); sent.length = 0; }
 tracker.observe({ type: "message_start", message: { role: "assistant", stopReason: "pending" } });
 tracker.observe({ type: "message_end", message: { role: "assistant" } });
 stats = nearCap();
 if (kind === "final") { stats = { ...stats, tokens: { ...tokens, input: 20, output: 4, total: 24 }, cost: 0.5 }; }
 const payload = kind === "checkpoint" ? (tracker.checkpointNow(), sent[0]!) : tracker.endReport(stats, model, "SUCCEEDED", {})!;
 expect(payload).toMatchObject({ tokens, costUsd: 0.25, usageMissingCalls: 1, [kind]: true });
 expect(payload).not.toHaveProperty("calls");
 expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(WORKER_EVENT_PAYLOAD_MAX_BYTES);
 const events: WorkerEvent[] = [], batcher = new EventBatcher(async batch => { events.push(...batch); }, 1, { maxDelayMs: false });
 await batcher.append("usage", payload); await batcher.flush();
 expect(events[0]?.payload).toMatchObject({ tokens, costUsd: 0.25, usageMissingCalls: 1, [kind]: true });
 expect(events[0]?.payload).not.toHaveProperty("truncated");
});
