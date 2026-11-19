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
  it("rounds up each call before summing, keeps booked money immutable", () => {
    const value = sample({ calls: [call, { ...call, callId: "two" }], callCount: available(2) });
    expect(repriceSample(value, quote, at)).toEqual(available(2));
    expect(value.calls[0]!.settledMicros).toEqual(available(3));
  });
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
  it("stores separate rows under the literal company and project partition key", async () => {
    const store = new MemoryDocumentStore();
    for (const { value, taskKey } of [
      { value: sample({ taskId: "task-web-a" }), taskKey: { pk: "DEVTASK#task-web-a", sk: "META" } },
      { value: sample({ companyId: "org_bbbbbbbbbbbbbbbbbbbb", taskId: "task-web-b" }), taskKey: { pk: "DEVTASK#task-web-b", sk: "META" } },
      { value: sample({ project: "api", taskId: "task-api-a" }), taskKey: { pk: "DEVTASK#task-api-a", sk: "META" } },
    ]) {
      await store.put({ item: { ...taskKey, companyId: value.companyId, project: value.project } });
      expect(await recordRunUsage({ store }, value)).toBe("applied");
    }
    const webA = runUsageKey(companyId, "web", "task-web-a");
    const webB = runUsageKey("org_bbbbbbbbbbbbbbbbbbbb", "web", "task-web-b");
    const apiA = runUsageKey(companyId, "api", "task-api-a");
    expect(webA.pk).toBe("ORG#org_00000000000000000000#RUN_USAGE#web");
    expect(webB.pk).toBe("ORG#org_bbbbbbbbbbbbbbbbbbbb#RUN_USAGE#web");
    expect(apiA.pk).toBe("ORG#org_00000000000000000000#RUN_USAGE#api");
    expect((await store.get(webA))?.["sample"]).toMatchObject({ taskId: "task-web-a" });
    expect((await store.get(webB))?.["sample"]).toMatchObject({ taskId: "task-web-b" });
    expect((await store.get(apiA))?.["sample"]).toMatchObject({ taskId: "task-api-a" });
    expect((await store.query({ pk: webA.pk })).items).toHaveLength(1);
  });
  it("tracks final interval coverage and signed dollar error by path, excludes censored and duplicate tasks", () => {
    const rows = [sample(), sample({ revision: 2, calls: [{ ...call, settledMicros: available(6) }] }), sample({ taskId: "canceled", outcome: "cancelled" })];
    expect(accuracyByPath(rows)).toEqual({ QUICK: { samples: 1, quoted: 1, validated: 1, covered: 0, exceeded: 1, coverage: available(0), meanErrorMicros: available(3) } });
  });
  it("stores an immutable pre-execution range, including unavailable quote inputs", async () => {
    const store = new MemoryDocumentStore();
    const task = { companyId, project: "web", taskId: "task", workflow: { path: "QUICK" } };
    const saved = await captureStartQuote({ store }, task, at);
    expect(saved.range).toEqual(available({ lowMicros: 1_000_000, highMicros: 3_000_000 }));
    expect(saved.modelPriced).toBe(false);
    expect(saved.inputs.price.state).toBe("unavailable");
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

it("the actual start persists learning's quote before dispatch, and a retry keeps it", async () => {
  const { createHarness, newRequestId } = await import("../support/task-flow-harness.js");
  const h = createHarness(); await h.registerProject();
  const request = { requestId: newRequestId(), project: "payments", instructions: "Implement the change", workflow: true, workflowPath: "QUICK" };
  const started = await h.flow.start(h.owner, request);
  const row = await h.store.get({ pk: `DEVTASK#${started.task.taskId}`, sk: "META" });
  expect(row?.["usageStartQuote"]).toMatchObject({ path: "QUICK", range: available({ lowMicros: 1_000_000, highMicros: 3_000_000 }), modelPriced: false });
  expect((await h.flow.start(h.owner, request)).task.taskId).toBe(started.task.taskId);
  expect((await h.store.get({ pk: `DEVTASK#${started.task.taskId}`, sk: "META" }))?.["usageStartQuote"]).toEqual(row?.["usageStartQuote"]);
});
