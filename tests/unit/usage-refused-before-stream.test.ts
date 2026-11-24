// #1395: a run whose every model call the provider refused before any stream (a company key with no balance, say) spent nothing. Its worker used to report nothing at all, so the
// broker could never book the run's end report, its task's spend stayed unknown, and every next step of the task was refused (`task_spend_refused`, `run_unreported`) for good.
// Now the worker says so in a zero report (`refusedBeforeStreamCalls`), and the broker books it at $0: the run is reported and the task goes on.
import { describe, expect, it } from "vitest";
import { createUsageCheckpointer, type UsageStats } from "../../packages/worker/src/usage.js";
import { EMPTY_REPORT_CHARGE_MICROS, readUsagePayload } from "../../packages/broker/src/core-host/usage-booking.js";
import { TaskUsageTelemetrySchema } from "../../packages/contracts/src/usage.js";

const model = { provider: "rovara-route", modelId: "gpt-5" };
const nothing: UsageStats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
/** The provider refused before any stream: Pi's first event is already an error, with model-runtime's fixed words. */
const refused = { type: "message_end", message: { role: "assistant", stopReason: "error", content: [], errorMessage: "Model source request failed; rate limited or out of credits; check the key's usage limits before retrying", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } };

function tracker(stats: () => UsageStats = () => nothing) {
  const sent: Record<string, unknown>[] = [];
  return { sent, tracker: createUsageCheckpointer({ enabled: true, baseline: undefined, stats, model: () => model, requested: {}, send: (payload) => sent.push(payload) }) };
}

describe("the worker's end report of a run the provider refused", () => {
  it("is a zero report that names the refused calls, instead of nothing", () => {
    const { tracker: t, sent } = tracker();
    t.observe(refused); t.observe(refused);
    const report = t.endReport(nothing, model, "FAILED", {});
    expect(report).toMatchObject({ outcome: "FAILED", modelId: "gpt-5", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, refusedBeforeStreamCalls: 2 });
    expect(report).not.toHaveProperty("usageMissingCalls");
    expect(report).not.toHaveProperty("final");
    expect(sent).toEqual([]);
    expect(TaskUsageTelemetrySchema.safeParse(report).success).toBe(true);
  });

  it("is still nothing for a run that made no model call at all", () => {
    expect(tracker().tracker.endReport(nothing, model, "FAILED", {})).toBeUndefined();
  });

  it("is the ordinary report once anything was spent, refused attempts before it or not", () => {
    let stats = nothing;
    const { tracker: t } = tracker(() => stats);
    t.observe(refused);
    stats = { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 }, cost: 0.001 };
    const report = t.endReport(stats, model, "SUCCEEDED", {})!;
    expect(report).toMatchObject({ tokens: { input: 100, output: 20 }, costUsd: 0.001 });
    expect(report).not.toHaveProperty("refusedBeforeStreamCalls");
  });

  it("does not count a call whose stream began (that one may have been billed: a missing-usage call)", () => {
    const { tracker: t } = tracker();
    t.observe({ type: "message_start", message: { role: "assistant", stopReason: "pending" } });
    t.observe({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [], errorMessage: "connection reset" } });
    const report = t.endReport(nothing, model, "FAILED", {})!;
    expect(report).toMatchObject({ usageMissingCalls: 1 });
    expect(report).not.toHaveProperty("refusedBeforeStreamCalls");
  });
});

describe("the broker's reading of it", () => {
  const zero = (extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, outcome: "FAILED", provider: "rovara-route", modelId: "gpt-5", cacheRetention: "short", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cacheReadRatio: 0, costUsd: 0, ...extra });

  it("books a zero report of refused calls at $0, not at the empty-report floor", () => {
    const read = readUsagePayload(zero({ refusedBeforeStreamCalls: 1 }));
    expect(read).toEqual({ usage: { provider: "rovara-route", modelId: "gpt-5", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    expect(read).not.toHaveProperty("reportedMicros");
  });

  it("keeps the floor for an empty report that says nothing, and the missing-usage reading when a call is missing its usage", () => {
    expect(readUsagePayload(zero())).toMatchObject({ reportedMicros: EMPTY_REPORT_CHARGE_MICROS, estimated: true });
    // A missing-usage call is read exactly as before (its own path books it as awaiting usage); the refused count changes nothing there.
    expect(readUsagePayload(zero({ refusedBeforeStreamCalls: 1, usageMissingCalls: 1 }))).toEqual(readUsagePayload(zero({ usageMissingCalls: 1 })));
  });

  it("refuses a malformed count, as any unreadable report", () => {
    for (const bad of [0, -1, 1.5, "1", null]) expect(readUsagePayload(zero({ refusedBeforeStreamCalls: bad })), String(bad)).toBeUndefined();
  });

  it("reads a spent report with the field as an ordinary one (the tokens and cost decide)", () => {
    expect(readUsagePayload({ ...zero({ refusedBeforeStreamCalls: 1 }), tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 } })).toEqual({ usage: { provider: "rovara-route", modelId: "gpt-5", tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  });
});
