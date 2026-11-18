import { expect, it } from "vitest";
import { callsOfEntries } from "../../packages/worker/src/usage-calls.js";
import { createTaskUsageTelemetry, TaskUsageTelemetrySchema } from "../../packages/contracts/src/usage.js";
import { statsSince } from "../../packages/worker/src/usage.js";
it("collects real assistant call boundaries with actual models and explicit missing prices", () => {
  const calls = callsOfEntries([{ id: "a", type: "message", message: { role: "assistant", provider: "anthropic", model: "actual", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } }, { id: "b", type: "message", message: { role: "assistant", provider: "anthropic", model: "fallback" } }, { id: "c", type: "message", message: { role: "toolResult" } }]);
  expect(calls).toHaveLength(2);
  expect(calls[0]).toMatchObject({ callId: "a", granularity: "call", model: { state: "available", value: { provider: "anthropic", modelId: "actual" } }, usage: { state: "available", value: { input: 2, output: 3, cacheRead: 4, cacheWriteUnknown: 5 } }, price: { state: "unavailable" }, settledMicros: { state: "unavailable" } });
  expect(calls[1]).toMatchObject({ usage: { state: "unavailable" }, status: "awaiting_usage" });
});
it("excludes prior conversation calls from checkpoints and forwards the optional strict-reader field", () => {
  const calls = callsOfEntries(["a", "b"].map((id) => ({ id, type: "message", message: { role: "assistant", provider: "anthropic", model: "actual", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } })));
  const stats = { tokens: { input: 2, output: 2, cacheRead: 0, cacheWrite: 0, total: 4 }, cost: 0, calls };
  const delta = statsSince(stats, { ...stats, calls: calls.slice(0, 1) });
  expect(delta.calls.map((c) => c.callId)).toEqual(["b"]);
  const report = createTaskUsageTelemetry(delta, { provider: "anthropic", modelId: "actual" }, "SUCCEEDED");
  expect(TaskUsageTelemetrySchema.parse(report).calls).toEqual(delta.calls);
});
it("books optional call units idempotently and retains original session money separately at close", async () => {
  const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
  const { createUsageBooking } = await import("../../packages/broker/src/core-host/usage-booking.js");
  const { recordClosedRunUsage, runUsageKey } = await import("../../packages/broker/src/core/cost/run-usage.js");
  const { RunUsageSampleV1Schema } = await import("../../packages/contracts/src/run-usage.js");
  const companyId = "org_00000000000000000000"; const at = "2026-11-18T12:00:00.000Z";
  const store = new MemoryDocumentStore(); const task = { companyId, taskId: "task", project: "web" };
  await store.put({ item: { pk: "DEVTASK#task", sk: "META", ...task } });
  const calls = callsOfEntries([{ id: "a", type: "message", message: { role: "assistant", provider: "anthropic", model: "actual", usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 } } }]);
  const booking = createUsageBooking({ store, metering: { price: async () => ({ micros: 9, currency: "USD" }), record: async () => ({ cost: { micros: 9, currency: "USD" }, source: "price-table" }) } });
  const report = { ...task, entryId: "usage:op:1", at, payload: { provider: "anthropic", modelId: "actual", tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5 }, calls } };
  expect(await booking.bookUsageReport(report)).toBe(true); expect(await booking.bookUsageReport(report)).toBe(false);
  await recordClosedRunUsage({ store }, task, at);
  const sample = RunUsageSampleV1Schema.parse((await store.get(runUsageKey(companyId, "web", "task")))?.["sample"]);
  await recordClosedRunUsage({ store }, task, at);
  expect((await store.get(runUsageKey(companyId, "web", "task")))?.["revision"]).toBe(1);
  expect(sample.callCount).toEqual({ state: "available", value: 1 });
  expect(sample.calls[0]).toMatchObject({ callId: "op:a", usage: { state: "available", value: { input: 2, cacheWriteUnknown: 5 } }, settledMicros: { state: "unavailable" } });
  expect(sample.settledAmounts).toEqual([{ entryId: "usage:op:1", amountMicros: { state: "available", value: 9 } }]);
});
it("keeps closed and cap-stopped work censored, and makes a broken start quote unavailable", async () => {
  const { MemoryDocumentStore } = await import("../../packages/broker/src/ports/memory-document-store.js");
  const { recordClosedRunUsage, runUsageKey, captureStartQuote } = await import("../../packages/broker/src/core/cost/run-usage.js");
  const companyId = "org_00000000000000000000"; const at = "2026-11-18T12:00:00.000Z";
  for (const [workflow, expected] of [[{ state: "COMPLETE", stage: "CLOSED" }, "cancelled"], [{ stage: "IMPLEMENT", blockReason: "task_cap" }, "cap_stopped"]] as const) {
    const store = new MemoryDocumentStore(); const task = { companyId, taskId: "task", project: "web", workflow };
    await store.put({ item: { pk: "DEVTASK#task", sk: "META", ...task } }); await recordClosedRunUsage({ store }, task, at);
    expect((await store.get(runUsageKey(companyId, "web", "task")))?.["sample"]).toMatchObject({ outcome: expected, completionCoverage: "partial" });
  }
  const quote = await captureStartQuote({ store: { query: async () => { throw new Error("unreadable"); } } }, { companyId, taskId: "task", project: "web" }, at);
  expect(quote.range).toEqual({ state: "unavailable", reason: "unreadable" });
});
