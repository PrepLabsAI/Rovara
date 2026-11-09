// Lane L6b: the cost split. The estimate (from the cost of earlier runs), the actual figure (tokens times a price table, through the Metering seam), and the run-cost record that feeds the next estimate.
 
import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_ESTIMATE_USD, MAX_RUN_LIMIT_USD, runCostKey, type MeterEntry, type Metering, type OrgId, type PriceTable } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createPriceTableMetering } from "../../packages/broker/src/ports/policy-defaults.js";
import { costLine, costUsdOf, createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { estimatePathOf, estimateRun, planRunLimit, recordRunCost, runCostInputOf } from "../../packages/broker/src/core/cost/estimate.js";

const ORG = "org_00000000000000000000" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const table: PriceTable = { currency: "USD", models: { "any-provider/model-a": { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 } } };
const usage = (modelId = "model-a", input = 1_000_000, output = 100_000) => ({ provider: "any-provider", modelId, tokens: { input, output, cacheRead: 0, cacheWrite: 0 } });
const entry = (entryId: string, overrides: Partial<MeterEntry> = {}): MeterEntry => ({ companyId: ORG, entryId, at: "2026-11-09T10:00:00.000Z", usage: usage(), taskId: TASK, ...overrides });

async function seedRuns(store: MemoryDocumentStore, costs: number[], path = "QUICK") {
  for (const [index, costUsd] of costs.entries()) {
    const endedAt = new Date(Date.UTC(2026, 10, 1 + index)).toISOString();
    await store.put({ item: { ...runCostKey(ORG, "web", "rovara-code", path, endedAt, `task-${String(index)}`), costUsd } });
  }
}

describe("estimateRun", () => {
  it("with too little history it is the default for the path, and the limit follows", async () => {
    const store = new MemoryDocumentStore();
    await seedRuns(store, [1, 2, 3, 4]);
    const estimate = await estimateRun({ store }, { orgId: ORG, project: "web", agentId: "rovara-code", path: "QUICK" });
    expect(estimate).toEqual({ lowUsd: DEFAULT_RUN_ESTIMATE_USD.QUICK.lowUsd, highUsd: DEFAULT_RUN_ESTIMATE_USD.QUICK.highUsd, runLimitUsd: DEFAULT_RUN_ESTIMATE_USD.QUICK.highUsd * 2, stopAtUsd: DEFAULT_RUN_ESTIMATE_USD.QUICK.highUsd * 2, basis: "default", samples: 4 });
  });

  it("with five runs it is their p50 and p80 by nearest rank, rounded up to fifty cents", async () => {
    const store = new MemoryDocumentStore();
    await seedRuns(store, [0.1, 1.2, 2.1, 3.3, 9.9]);
    const estimate = await estimateRun({ store }, { orgId: ORG, project: "web", agentId: "rovara-code", path: "QUICK" });
    expect(estimate).toMatchObject({ lowUsd: 2.5, highUsd: 3.5, basis: "history", samples: 5, runLimitUsd: 7 });
  });

  it("reads only the newest twenty, another project's runs never, and never exceeds the cap", async () => {
    const store = new MemoryDocumentStore();
    await seedRuns(store, [...Array.from({ length: 10 }, () => 900), ...Array.from({ length: 20 }, () => 1)]);
    // Twenty newest are the 1-dollar runs (later dates), the old expensive ones are not read.
    expect((await estimateRun({ store }, { orgId: ORG, project: "web", agentId: "rovara-code", path: "QUICK" })).highUsd).toBe(1);
    expect((await estimateRun({ store }, { orgId: ORG, project: "other", agentId: "rovara-code", path: "QUICK" })).basis).toBe("default");
    const rich = new MemoryDocumentStore();
    await seedRuns(rich, Array.from({ length: 6 }, () => 900));
    expect((await estimateRun({ store: rich }, { orgId: ORG, project: "web", agentId: "rovara-code", path: "QUICK" })).runLimitUsd).toBe(MAX_RUN_LIMIT_USD);
  });

  it("an agent's cap on one run lowers the stop but not the limit, and the multiplier is an option", async () => {
    const store = new MemoryDocumentStore();
    const estimate = await estimateRun({ store, runLimitMultiplier: 3 }, { orgId: ORG, project: "web", agentId: "rovara-code", path: "FULL", maxPerRunUsd: 5 });
    expect(estimate).toMatchObject({ highUsd: 10, runLimitUsd: 30, stopAtUsd: 5 });
  });

  it("the path of a task is its workflow's, else TASK; a plan's run limit takes the lower of the estimate and what the start asked for", async () => {
    expect(estimatePathOf({ workflow: { path: "FULL" } })).toBe("FULL");
    expect(estimatePathOf({})).toBe("TASK");
    const store = new MemoryDocumentStore();
    expect(await planRunLimit({ store }, { orgId: ORG, project: "web", workflow: { path: "QUICK" } })).toBe(6);
    expect(await planRunLimit({ store }, { orgId: ORG, project: "web", workflow: { path: "QUICK" }, requestedRunLimitUsd: 2.5 })).toBe(2.5);
    expect(await planRunLimit({ store }, { orgId: ORG, project: "web", runEstimate: { runLimitUsd: 4 }, requestedRunLimitUsd: 50 })).toBe(4);
  });
});

describe("recordRunCost", () => {
  const task = (store: MemoryDocumentStore) => store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", orgId: ORG } });
  const input = { orgId: ORG, project: "web", taskId: TASK, path: "QUICK" as const, endedAt: "2026-11-09T11:00:00.000Z" };

  it("writes the cost and the task's mark together, once however often the end is told", async () => {
    const store = new MemoryDocumentStore();
    await task(store);
    expect(await recordRunCost({ store }, { ...input, costUsd: 2.5 })).toBe("recorded");
    expect(await recordRunCost({ store }, { ...input, costUsd: 2.5 })).toBe("already_recorded");
    const runs = await store.query({ pk: runCostKey(ORG, "web", "rovara-code", "QUICK", input.endedAt, TASK).pk });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({ costUsd: 2.5, taskId: TASK });
    expect((await store.get({ pk: `DEVTASK#${TASK}`, sk: "META" }))!["runCostRecordedAt"]).toBe(input.endedAt);
  });

  it("a run whose cost is a floor writes only the mark, so it never teaches the estimator that runs are cheap", async () => {
    const store = new MemoryDocumentStore();
    await task(store);
    expect(runCostInputOf({ micros: 3_000_000, currency: "USD", unpricedEntries: 1 })).toEqual({ costUsd: 3, partial: true });
    expect(runCostInputOf({ micros: 3_000_000, currency: "EUR", unpricedEntries: 0 })).toEqual({ costUsd: 0, partial: true });
    expect(runCostInputOf({ micros: 3_000_000, currency: "USD", unpricedEntries: 0 })).toEqual({ costUsd: 3 });
    expect(await recordRunCost({ store }, { ...input, ...runCostInputOf({ micros: 3_000_000, currency: "USD", unpricedEntries: 1 }) })).toBe("skipped");
    expect((await store.query({ pk: runCostKey(ORG, "web", "rovara-code", "QUICK", input.endedAt, TASK).pk })).items).toHaveLength(0);
    expect(await recordRunCost({ store }, { ...input, costUsd: 2 })).toBe("already_recorded");
  });

  it("the task flow's record (it names `companyId`, not `orgId`) takes the mark", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", companyId: ORG } });
    expect(await recordRunCost({ store }, { ...input, costUsd: 2 })).toBe("recorded");
    expect((await store.get({ pk: `DEVTASK#${TASK}`, sk: "META" }))!["runCostRecordedAt"]).toBe(input.endedAt);
  });

  it("the mark is written only on a task of the company", async () => {
    const store = new MemoryDocumentStore();
    await store.put({ item: { pk: `DEVTASK#${TASK}`, sk: "META", orgId: "org_11111111111111111111" } });
    await expect(recordRunCost({ store }, { ...input, costUsd: 1 })).rejects.toThrow();
  });

  it("a run that spent nothing writes only the mark, a task with a purpose feeds nothing, and a task that is not there is an error", async () => {
    const store = new MemoryDocumentStore();
    await task(store);
    expect(await recordRunCost({ store }, { ...input, costUsd: 0 })).toBe("skipped");
    expect((await store.query({ pk: runCostKey(ORG, "web", "rovara-code", "QUICK", input.endedAt, TASK).pk })).items).toHaveLength(0);
    expect(await recordRunCost({ store }, { ...input, costUsd: 3, purpose: "setup" })).toBe("skipped");
    await expect(recordRunCost({ store: new MemoryDocumentStore() }, { ...input, costUsd: 1 })).rejects.toThrow();
    await expect(recordRunCost({ store }, { ...input, costUsd: -1 })).rejects.toThrow();
  });
});

describe("the cost ledger", () => {
  const world = () => {
    const store = new MemoryDocumentStore();
    return { store, ledger: createCostLedger({ store, metering: createPriceTableMetering(table), now: () => new Date("2026-11-09T12:00:00.000Z") }) };
  };

  it("prices tokens times the table and keeps the task's running total", async () => {
    const { ledger } = world();
    expect(await ledger.recordUsage(entry("e1"))).toMatchObject({ source: "price-table", cost: { micros: 4_500_000, currency: "USD" }, counted: true });
    await ledger.recordUsage(entry("e2", { usage: usage("model-a", 2_000_000, 0) }));
    const total = await ledger.taskCost(ORG, TASK);
    expect(total).toMatchObject({ currency: "USD", micros: 10_500_000, entries: 2, unpricedEntries: 0, tokens: { input: 3_000_000, output: 100_000 } });
    expect(costUsdOf(total)).toBe(10.5);
    expect(costLine(total)).toBe("$10.50");
  });

  it("a usage told twice counts once, even told at the same moment", async () => {
    const { ledger } = world();
    const results = await Promise.all([ledger.recordUsage(entry("e1")), ledger.recordUsage(entry("e1")), ledger.recordUsage(entry("e1"))]);
    expect(results.filter((result) => result.counted)).toHaveLength(1);
    expect(await ledger.taskCost(ORG, TASK)).toMatchObject({ micros: 4_500_000, entries: 1 });
    const again = await ledger.recordUsage(entry("e1"));
    expect(again).toMatchObject({ counted: false, cost: { micros: 4_500_000 } });
  });

  it("a model with no price is kept and counted as not priced, so the figure says it is a floor", async () => {
    const { ledger } = world();
    await ledger.recordUsage(entry("e1"));
    expect(await ledger.recordUsage(entry("e2", { usage: usage("model-z") }))).toMatchObject({ cost: null, source: "unknown", counted: true });
    const total = await ledger.taskCost(ORG, TASK);
    expect(total).toMatchObject({ micros: 4_500_000, entries: 2, unpricedEntries: 1 });
    expect(costLine(total)).toBe("$4.50 so far, 1 call not priced");
  });

  it("a cost in another currency than the task's first is kept but not added to the total", async () => {
    const store = new MemoryDocumentStore();
    let currency = "USD";
    const metering: Metering = { async price() { return null; }, async record(e) { return { cost: { micros: e.usage.tokens.input, currency }, source: "provider-reported" }; } };
    const ledger = createCostLedger({ store, metering });
    await ledger.recordUsage(entry("e1"));
    currency = "EUR";
    await ledger.recordUsage(entry("e2"));
    expect(await ledger.taskCost(ORG, TASK)).toMatchObject({ currency: "USD", micros: 1_000_000, entries: 2, unpricedEntries: 1 });
  });

  it("one usage is counted once in the company even when it is told under another task", async () => {
    const { ledger } = world();
    await ledger.recordUsage(entry("e1"));
    const other = await ledger.recordUsage(entry("e1", { taskId: "22222222-3333-4444-8555-666666666666" }));
    expect(other).toMatchObject({ counted: false, cost: { micros: 4_500_000 } });
    expect((await ledger.taskCost(ORG, "22222222-3333-4444-8555-666666666666")).entries).toBe(0);
    expect((await ledger.taskCost(ORG, TASK)).micros).toBe(4_500_000);
  });

  it("tasks and companies are kept apart, an unknown task is zero, and bad counts are refused", async () => {
    const { ledger } = world();
    await ledger.recordUsage(entry("e1"));
    expect((await ledger.taskCost(ORG, "other-task")).micros).toBe(0);
    expect((await ledger.taskCost("org_11111111111111111111", TASK)).micros).toBe(0);
    await expect(ledger.recordUsage(entry("bad", { usage: usage("model-a", -1, 0) }))).rejects.toThrow();
    await expect(ledger.recordUsage(entry("bad2", { usage: usage("model-a", 1.5, 0) }))).rejects.toThrow();
    const { taskId: _omitted, ...withoutTask } = entry("bad3");
    void _omitted;
    await expect(ledger.recordUsage(withoutTask as MeterEntry)).rejects.toThrow();
    expect((await ledger.taskCost(ORG, TASK)).entries).toBe(1);
  });

  it("an adapter that answers a fraction of a micro or a negative cost is refused, and nothing is kept", async () => {
    const store = new MemoryDocumentStore();
    const metering: Metering = { async price() { return null; }, async record() { return { cost: { micros: -5, currency: "USD" }, source: "price-table" }; } };
    const ledger = createCostLedger({ store, metering });
    await expect(ledger.recordUsage(entry("e1"))).rejects.toThrow();
    expect((await ledger.taskCost(ORG, TASK)).entries).toBe(0);
  });
});
