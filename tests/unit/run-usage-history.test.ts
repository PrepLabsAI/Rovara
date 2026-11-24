import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { RateQuoteV1Schema, RunUsageSampleV1Schema, type RunUsageSampleV1, type RateQuoteV1 } from "../../packages/contracts/src/run-usage.js";
import { repriceSample, accuracyByPath, recordRunUsage, runUsageKey, captureStartQuote, recordClosedRunUsage } from "../../packages/broker/src/core/cost/run-usage.js";
const at = "2026-11-18T12:00:00.000Z";
const companyId = "org_00000000000000000000";
const source = { kind: "company_key" as const, id: "own", name: "Own", provider: "anthropic", connectionRevision: "1" };
const model = { provider: "anthropic", modelId: "claude-test" };
const available = <T>(value: T) => ({ state: "available" as const, value });
const unknown = { state: "unavailable" as const, reason: "legacy_data" as const };
const rates = { input: 100, output: 200, cacheRead: 10, cacheWrite5m: 300, cacheWrite1h: 500 };
const quote: RateQuoteV1 = { version: 1, currency: "USD", unit: "micros_per_million_tokens", ref: { authority: "gateway", version: "1", hash: "a".repeat(64), fetchedAt: at }, source, model, region: "us-west-2", asOf: at, expiresAt: "2026-11-18T12:05:00.000Z", base: rates, longContext: [{ aboveInputTokens: 100, rates: { ...rates, input: 200 } }], derived: [] };
const call = { callId: "one", stage: "IMPLEMENT", model: available(model), source: available(source), usage: available({ input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 }), price: available(quote.ref), settledMicros: available(3), status: "final" as const, granularity: "call" as const };
const sample = (more: Partial<RunUsageSampleV1> = {}): RunUsageSampleV1 => ({ version: 1, companyId, project: "web", taskId: "task", purpose: unknown, agentId: "rovara-code", path: "QUICK", outcome: "completed", workflowVersion: available("1"), optionsVersion: available("1"), calls: [call], callCount: available(1), completionCoverage: "complete", priceCoverage: "complete", endedAt: at, revision: 1, startQuote: available({ asOf: at, path: "QUICK", range: available({ lowMicros: 2, highMicros: 4 }), basis: "default", inputs: { model: unknown, source: unknown, price: unknown, optionsVersion: unknown }, modelPriced: false }), ...more });

describe("run usage learning", () => {
  it("selects strict context thresholds and the dearer unknown write tier", () => {
    const usage = { input: 100, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 };
    expect(repriceSample(sample({ calls: [{ ...call, usage: available(usage) }] }), quote, at)).toEqual(available(1));
    expect(repriceSample(sample({ calls: [{ ...call, usage: available({ ...usage, input: 101, cacheWriteUnknown: 1_000_000 }) }] }), quote, at)).toEqual(available(501));
  });
  it("refuses stale, incompatible, aggregate, censored and unresolved evidence", () => {
    for (const value of [sample({ outcome: "cancelled" }), sample({ outcome: "cap_stopped" }), sample({ completionCoverage: "partial" }), sample({ calls: [{ ...call, granularity: "session" }] }), sample({ calls: [{ ...call, status: "awaiting_usage" }] }), sample({ calls: [{ ...call, source: unknown }] }), sample({ calls: [{ ...call, model: available({ ...model, modelId: "other" }) }] })]) expect(repriceSample(value, quote, at).state).toBe("unavailable");
    expect(repriceSample(sample(), quote, quote.expiresAt).state).toBe("unavailable");
    expect(repriceSample(sample(), { ...quote, source: { ...source, connectionRevision: "2" } }, at).state).toBe("unavailable");
  });
  it("rejects unsafe counts, duplicate calls, bad ranges, unsorted bands and invalid timestamps", () => {
    expect(RateQuoteV1Schema.safeParse({ ...quote, base: { ...rates, input: Number.MAX_SAFE_INTEGER + 1 } }).success).toBe(false);
    expect(RateQuoteV1Schema.safeParse({ ...quote, longContext: [{ aboveInputTokens: 200, rates }, { aboveInputTokens: 100, rates }] }).success).toBe(false);
    expect(RunUsageSampleV1Schema.safeParse(sample({ calls: [call, call] })).success).toBe(false);
    expect(RunUsageSampleV1Schema.safeParse(sample({ endedAt: "bad" })).success).toBe(false);
    const bad = sample(); if (bad.startQuote.state === "available") bad.startQuote.value.range = available({ lowMicros: 5, highMicros: 4 });
    expect(RunUsageSampleV1Schema.safeParse(bad).success).toBe(false);
    expect(repriceSample(sample({ calls: [{ ...call, usage: available({ ...call.usage.value, input: Number.MAX_SAFE_INTEGER }) }] }), { ...quote, base: { ...rates, input: Number.MAX_SAFE_INTEGER }, longContext: [] }, at).state).toBe("unavailable");
  });
  it("replaces corrected samples, ignores duplicate/older revisions and enforces company/project", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: "DEVTASK#task", sk: "META", companyId, project: "web" } });
    expect(await recordRunUsage({ store }, sample())).toBe("applied");
    expect(await recordRunUsage({ store }, sample())).toBe("duplicate");
    expect(await recordRunUsage({ store }, sample({ revision: 2, calls: [{ ...call, settledMicros: available(7) }] }))).toBe("applied");
    expect(await recordRunUsage({ store }, sample())).toBe("older");
    expect((await store.query({ pk: runUsageKey(companyId, "web", "task").pk })).items).toHaveLength(1);
    await expect(recordRunUsage({ store }, sample({ companyId: "org_bbbbbbbbbbbbbbbbbbbb" }))).rejects.toThrow();
    await expect(recordRunUsage({ store }, sample({ project: "other" }))).rejects.toThrow();
  });
  it("tracks final interval coverage and signed dollar error by path, excludes censored and duplicate tasks", () => {
    const rows = [sample(), sample({ revision: 2, calls: [{ ...call, settledMicros: available(6) }] }), sample({ taskId: "canceled", outcome: "cancelled" })];
    expect(accuracyByPath(rows)).toEqual({ QUICK: { samples: 1, quoted: 1, validated: 1, covered: 0, exceeded: 1, coverage: available(0), meanErrorMicros: available(3) } });
  });
  it("keeps session aggregates and canceled outcomes censored at close, with original amounts", async () => {
    const store = new MemoryDocumentStore();
    const task = { companyId, taskId: "task", project: "web", workflow: { path: "QUICK", stage: "IMPLEMENT" } };
    await store.put({ item: { pk: "DEVTASK#task", sk: "META", ...task } });
    await store.put({ item: { pk: `ORG#${companyId}#COST#task`, sk: "ENTRY#usage:op:1", provider: "anthropic", modelId: "claude-test", tokensInput: 20, tokensOutput: 2, tokensCacheRead: 0, tokensCacheWrite: 7, micros: 9, currency: "USD" } });
    await recordClosedRunUsage({ store }, task, at);
    const row = await store.get(runUsageKey(companyId, "web", "task"));
    const read = RunUsageSampleV1Schema.parse(row?.["sample"]);
    expect(read.outcome).toBe("cancelled");
    expect(read.calls[0]).toMatchObject({ granularity: "session", settledMicros: available(9), usage: available({ input: 20, cacheWriteUnknown: 7 }) });
    expect(read.callCount.state).toBe("unavailable");
    expect(read.completionCoverage).toBe("partial");
  });
});


it("uses full stored comparisons for learning and falls back safely for a restricted member comparison", async () => {
 const { startEstimates } = await import("../../packages/broker/src/core/cost/start-estimates.js");
 const { restrictPreviewV2 } = await import("../../packages/contracts/src/start-estimates.js");
 const store = new MemoryDocumentStore();
 const full = await startEstimates({ store }, { orgId: companyId, project: "web", request: { quoteVersion: 2 }, asOf: at, context: { policyRevision: "1", stages: {}, limits: [], initialHoldCeilingMicros: 0 } });
 const task = { companyId, project: "web", taskId: "task", workflow: { path: "QUICK" } };
 expect((await captureStartQuote({ store }, { ...task, startComparison: { ...full, selectedPath: "QUICK" } }, at)).inputs.optionsVersion.state).toBe("available");
 const restricted = restrictPreviewV2(full);
 const fallback = await captureStartQuote({ store }, { ...task, startComparison: { ...restricted, selectedPath: "QUICK" } }, at);
 expect(fallback.range).toEqual(available({ lowMicros: 1_000_000, highMicros: 3_000_000 }));
 expect(fallback.inputs.optionsVersion.state).toBe("unavailable");
});

// A setup run has no merge stage, so "MERGED" can never say it finished: its label comes from the end the broker stored on the task (a proposal, a person's Stop, a spent budget, a fault).
describe("a setup run's RUN_USAGE outcome follows how the run ended, not the merge stage", () => {
  const sampleOf = async (stored: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const store = new MemoryDocumentStore();
    const task = { companyId, taskId: "setup", project: "web", purpose: "setup_agent" as const };
    await store.put({ item: { pk: "DEVTASK#setup", sk: "META", ...task, ...stored } });
    await recordClosedRunUsage({ store }, { ...task, ...extra }, at);
    return RunUsageSampleV1Schema.parse((await store.get(runUsageKey(companyId, "web", "setup")))?.["sample"]);
  };
  const ready = { status: "ready", stop: "proposed", proposal: {}, summary: {} };
  it("a run that ended with a proposal (stop=proposed) is completed", async () => {
    expect((await sampleOf({ setupAgentResult: ready })).outcome).toBe("completed");
  });
  it("a person's Stop is cancelled, with the result stored or only the stop mark on the task", async () => {
    expect((await sampleOf({ setupAgentResult: { status: "failed", stop: "stopped_by_person", failure: "x" }, setupAgentStop: { by: "ada", at } })).outcome).toBe("cancelled");
    expect((await sampleOf({ setupAgentStop: { by: "ada", at } })).outcome).toBe("cancelled");
  });
  it("a fault (infrastructure, a machine that could not go on, no stored end) is failed", async () => {
    expect((await sampleOf({ setupAgentResult: { status: "failed", stop: "infrastructure", failure: "x" } })).outcome).toBe("failed");
    expect((await sampleOf({ setupAgentResult: { status: "failed", stop: "needs_code_change", failure: "x" } })).outcome).toBe("failed");
    expect((await sampleOf({})).outcome).toBe("failed");
  });
  it("a spent budget stays cap_stopped, and a run with a proposal is completed even when a Stop was pressed late", async () => {
    expect((await sampleOf({ setupAgentResult: { status: "failed", stop: "budget_used", failure: "x" } })).outcome).toBe("cap_stopped");
    expect((await sampleOf({ setupAgentResult: ready, setupAgentStop: { by: "ada", at } })).outcome).toBe("completed");
  });
  it("is read from the stored task: the copy handed to the close (read before the end was written) does not decide", async () => {
    expect((await sampleOf({ setupAgentResult: ready }, { setupAgentResult: undefined })).outcome).toBe("completed");
  });
  it("the setup rule needs only the stored purpose, and a spent cap on the run still says cap_stopped", async () => {
    expect((await sampleOf({ setupAgentResult: ready }, { purpose: undefined })).outcome).toBe("completed");
    expect((await sampleOf({ setupAgentResult: ready }, { workflow: { blockReason: "the monthly spend cap was reached" } })).outcome).toBe("cap_stopped");
  });
  it("an ordinary unmerged task is still cancelled (the setup rule is only for setup runs)", async () => {
    const store = new MemoryDocumentStore();
    const task = { companyId, taskId: "plain", project: "web", workflow: { path: "QUICK", stage: "IMPLEMENT" } };
    await store.put({ item: { pk: "DEVTASK#plain", sk: "META", ...task, setupAgentResult: ready } });
    await recordClosedRunUsage({ store }, task, at);
    expect(RunUsageSampleV1Schema.parse((await store.get(runUsageKey(companyId, "web", "plain")))?.["sample"]).outcome).toBe("cancelled");
  });
});

describe("REVIEW: a setup run that ends ready with a spent budget (partial proposal) is cap_stopped", () => {
  it("status ready + stop budget_used", async () => {
    const store = new MemoryDocumentStore();
    const task = { companyId, taskId: "setup2", project: "web", purpose: "setup_agent" as const };
    await store.put({ item: { pk: "DEVTASK#setup2", sk: "META", ...task, setupAgentResult: { status: "ready", stop: "budget_used", proposal: {}, summary: {} } } });
    await recordClosedRunUsage({ store }, task, at);
    expect(RunUsageSampleV1Schema.parse((await store.get(runUsageKey(companyId, "web", "setup2")))?.["sample"]).outcome).toBe("cap_stopped");
  });
});
