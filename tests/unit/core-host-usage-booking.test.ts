// Switch-on lane L8: a core task's model usage, as its worker reports it (`usage` events through the callback layer), is booked into the task's cost ledger before the batch is acknowledged,
// once, and never at $0 when it cannot be priced: an unknown model is charged the cautious price, a higher reported cost wins, and an unreadable report makes the day's spend unknown.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type MeterEntry, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { companyDayKey, costPartition, createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { operationKey, taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { SPEND_UNKNOWN, UNKNOWN_MODEL_PRICE, createHostedAdmission, createHostedLedger, createHostedMetering, hostedSecurityModules } from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { coreMoneyWiring } from "../../packages/broker/src/aws/core-engine-root.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { NO_TASK_FOR_USAGE, UNREADABLE_USAGE_PROVIDER, createUsageBooking, readUsagePayload, type UsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { costMicrosOf } from "../../packages/broker/src/core/cost/price-table.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const ORG = COMPANY_A_ID as OrgId;
const DAY = "2026-11-15";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const KNOWN = { inputMicrosPerMillionTokens: 3_000_000, outputMicrosPerMillionTokens: 15_000_000 };
const metering = createHostedMetering({
  find: (model) => (model.modelId === "known" ? { price: KNOWN, currency: "USD", origin: "catalog" } : undefined),
  findCap: (model) => (model.modelId === "known" ? { price: KNOWN, currency: "USD", origin: "catalog" } : undefined),
});

/** A worker's usage event, as `createTaskUsageTelemetry` makes it. */
const telemetry = (modelId: string, input: number, output: number, costUsd: number | null = null) => ({
  schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId, cacheRetention: "short", tokens: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output }, cacheReadRatio: 0, costUsd,
});
const event = (payload: unknown, timestamp = NOW.toISOString(), type = "usage") => ({ type, timestamp, payload });

function world(companyId: string = ORG) {
  const store = new MemoryDocumentStore();
  const booking = createUsageBooking({ store, metering, now: () => NOW });
  const ledger = createHostedLedger({ store, metering, now: () => NOW });
  const taskId = randomUUID();
  const operation = { id: randomUUID(), workspaceId: randomUUID(), companyId };
  return { store, booking, ledger, taskId, operation, pointer: () => store.put({ item: { ...taskPointerKey(operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } }) };
}

describe("reading a usage report", () => {
  it("reads the provider, the model, whole token counts and a reported dollar cost", () => {
    expect(readUsagePayload(telemetry("known", 10, 20, 0.0000015))).toEqual({ usage: { provider: "anthropic", modelId: "known", tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } }, reportedMicros: 2 });
    expect(readUsagePayload(telemetry("known", 10, 20, null))).toEqual({ usage: { provider: "anthropic", modelId: "known", tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } } });
    // Only a cost reported with no tokens still prices.
    expect(readUsagePayload(telemetry("known", 0, 0, 0.5))).toMatchObject({ reportedMicros: 500_000 });
  });

  it("reads nothing it cannot trust as a usage: no model, counts that are not whole numbers, a bad cost, or nothing at all to price", () => {
    for (const payload of [null, "usage", [], {}, { ...telemetry("known", 1, 1), provider: "" }, { ...telemetry("known", 1, 1), modelId: undefined }, { ...telemetry("known", 1, 1), tokens: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { ...telemetry("known", 1, 1), tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { ...telemetry("known", 1, 1), tokens: { input: 1, output: 0 } }, { ...telemetry("known", 1, 1), costUsd: -1 },
      { ...telemetry("known", 1, 1), costUsd: "1" }, { ...telemetry("known", 1, 1), costUsd: Number.POSITIVE_INFINITY }, telemetry("known", 0, 0, null), telemetry("known", 0, 0, 0), { ...telemetry("known", 1, 1), costUsd: 1e300 }]) {
      expect(readUsagePayload(payload), JSON.stringify(payload)).toBeUndefined();
    }
  });
});

describe("booking a core operation's usage events", () => {
  it("books each usage into the task's cost ledger at the table price, once however often the batch is sent", async () => {
    const w = world();
    await w.pointer();
    const batch = [event({ type: "progress" }, NOW.toISOString(), "progress"), event(telemetry("known", 1_000_000, 0)), event(telemetry("known", 0, 1_000_000), "2026-11-15T10:00:01.000Z")];
    expect(await w.booking.bookOperationEvents(w.operation, batch)).toEqual({ booked: 2, unreadable: 0 });
    expect(await w.booking.bookOperationEvents(w.operation, batch)).toEqual({ booked: 0, unreadable: 0 });
    expect(await w.ledger.taskCost(ORG, w.taskId)).toMatchObject({ micros: 18_000_000, entries: 2, unpricedEntries: 0, currency: "USD" });
    expect(await w.store.get(companyDayKey(ORG, DAY))).toMatchObject({ usdMicros: 18_000_000, loadMicros: 18_000_000, entries: 2, uncountedEntries: 0 });
  });

  it("charges an unknown model the cautious price, and a higher reported cost over the table's; never $0", async () => {
    const w = world();
    await w.pointer();
    await w.booking.bookOperationEvents(w.operation, [event(telemetry("never-heard-of", 1_000, 1_000))]);
    const cautious = costMicrosOf(UNKNOWN_MODEL_PRICE, { input: 1_000, output: 1_000, cacheRead: 0, cacheWrite: 0 });
    expect(cautious).toBeGreaterThan(0);
    expect((await w.ledger.taskCost(ORG, w.taskId)).micros).toBe(cautious);
    // The provider reported $2 for a call the table prices at $0.003: the $2 is booked. A lower reported cost does not lower the table's.
    await w.booking.bookOperationEvents(w.operation, [event(telemetry("known", 1_000, 0, 2), "2026-11-15T10:00:02.000Z"), event(telemetry("known", 1_000_000, 0, 0.01), "2026-11-15T10:00:03.000Z")]);
    expect((await w.ledger.taskCost(ORG, w.taskId)).micros).toBe(cautious + 2_000_000 + 3_000_000);
  });

  it("books an unreadable report as a usage with no dollar figure: the day's spend is then unknown and the admission refuses new spending", async () => {
    const w = world();
    await w.pointer();
    expect(await w.booking.bookOperationEvents(w.operation, [event({ tokens: "lots" }), event(telemetry("known", 0, 0, null), "2026-11-15T10:00:01.000Z")])).toEqual({ booked: 2, unreadable: 2 });
    expect(await w.ledger.taskCost(ORG, w.taskId)).toMatchObject({ micros: 0, entries: 2, unpricedEntries: 2 });
    expect(await w.store.get(companyDayKey(ORG, DAY))).toMatchObject({ usdMicros: 0, uncountedEntries: 2 });
    const entries = (await w.store.query({ pk: costPartition(ORG, w.taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items;
    expect(entries.map((e) => [e["provider"], e["micros"]])).toEqual([[UNREADABLE_USAGE_PROVIDER, undefined], [UNREADABLE_USAGE_PROVIDER, undefined]]);
    const admission = createHostedAdmission({ settings: { allowedCompanies: "all", taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 }, store: w.store, ledger: w.ledger, now: () => NOW });
    expect(await admission.admit({ companyId: ORG, idempotencyKey: "next", action: "task.start", subject: { type: "task", id: randomUUID() } })).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
  });

  it("fails, in fixed words, a batch with usage whose operation names no task; a batch with no usage reads nothing", async () => {
    const w = world();
    expect(await w.booking.bookOperationEvents(w.operation, [event({}, NOW.toISOString(), "progress")])).toEqual({ booked: 0, unreadable: 0 });
    await expect(w.booking.bookOperationEvents(w.operation, [event(telemetry("known", 1, 1))])).rejects.toThrow(new RegExp(`^${NO_TASK_FOR_USAGE}$`, "u"));
  });

  it("keeps two companies' usage apart (isolation)", async () => {
    const a = world(COMPANY_A_ID);
    await a.pointer();
    await a.booking.bookOperationEvents(a.operation, [event(telemetry("known", 1_000_000, 0))]);
    // Positive control, then B's figures untouched.
    expect(await a.store.get(companyDayKey(COMPANY_A_ID, DAY))).toMatchObject({ usdMicros: 3_000_000 });
    expect(await a.store.get(companyDayKey(COMPANY_B_ID, DAY))).toBeUndefined();
    expect(await a.ledger.taskCost(COMPANY_B_ID, a.taskId)).toMatchObject({ micros: 0, entries: 0 });
  });
});

describe("the callback layer books before it acknowledges", () => {
  const key = "k".repeat(40);
  async function callbackWorld(bookUsage?: Parameters<typeof createCallbackHandler>[0]["bookUsage"]) {
    const w = world();
    await w.pointer();
    await w.store.put({ item: { ...operationKey(w.operation.workspaceId, w.operation.id), entityType: "OPERATION", id: w.operation.id, workspaceId: w.operation.workspaceId, companyId: ORG, kind: "task", status: "RUNNING", fence: 1, eventSequence: 0 } });
    const flow = { store: w.store, companyId: ORG, callbackSigningKey: key, now: () => NOW, log: () => undefined } as unknown as TaskFlowDeps;
    const handler = createCallbackHandler({ flow, blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } }, ...(bookUsage === undefined ? {} : { bookUsage }) });
    const token = new CallbackCapabilities(Buffer.from(key)).issue({ workspaceId: w.operation.workspaceId, operationId: w.operation.id, fence: 1, actions: ["events"], expiresInSeconds: 600 });
    const post = (events: unknown[]) => handler({ method: "POST", path: `/v1/internal/workspaces/${w.operation.workspaceId}/operations/${w.operation.id}/events`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ events }) });
    const stored = async () => (await w.store.query({ pk: `WORKSPACE#${w.operation.workspaceId}`, sk: { op: "beginsWith", prefix: `EVENT#${w.operation.id}#` } })).items.length;
    return { ...w, post, stored };
  }

  it("books the batch's usage, then stores the events; the same batch again books nothing more", async () => {
    const w = await callbackWorld();
    const booking: { current?: UsageBooking } = {};
    const hooked = await callbackWorld((operation, events) => booking.current!.bookOperationEvents({ id: operation.id, workspaceId: operation.workspaceId, companyId: ORG }, events));
    booking.current = createUsageBooking({ store: hooked.store, metering, now: () => NOW });
    const batch = [event(telemetry("known", 1_000_000, 0))];
    expect((await hooked.post(batch)).statusCode).toBe(200);
    expect((await hooked.post(batch)).statusCode).toBe(200);
    expect(await hooked.stored()).toBe(2);
    expect(await createCostLedger({ store: hooked.store, metering }).taskCost(ORG, hooked.taskId)).toMatchObject({ micros: 3_000_000, entries: 1 });
    // Without the hook (the laptop, or a switch that is off) the events are stored and nothing is booked.
    expect((await w.post(batch)).statusCode).toBe(200);
    expect(await w.stored()).toBe(1);
    expect(await w.store.get(companyDayKey(ORG, DAY))).toBeUndefined();
  });

  it("fails the batch when its usage cannot be booked: nothing is stored, the worker sends it again, and the answer leaks nothing", async () => {
    const w = await callbackWorld(async () => { throw new Error("secret-canary-l8 store detail"); });
    const answer = await w.post([event(telemetry("known", 1, 1))]);
    expect(answer.statusCode).toBe(500);
    expect(answer.body).not.toContain("secret-canary-l8");
    expect(await w.stored()).toBe(0);
  });
});

describe("the ledger without holds (the laptop) is unchanged", () => {
  it("writes the company's day row exactly as before: no load and no reservation", async () => {
    const store = new MemoryDocumentStore();
    const meter = { async price() { return null; }, async record(e: MeterEntry) { return { cost: { micros: e.usage.tokens.input, currency: "USD" }, source: "price-table" as const }; } };
    await createCostLedger({ store, metering: meter, now: () => NOW }).recordUsage({ companyId: ORG, entryId: "e", at: NOW.toISOString(), taskId: "t", usage: { provider: "p", modelId: "m", tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    expect(await store.get(companyDayKey(ORG, DAY))).toEqual({ ...companyDayKey(ORG, DAY), entityType: "COST_DAY", companyId: ORG, day: DAY, usdMicros: 7, entries: 1, uncountedEntries: 0 });
    expect(await store.get({ pk: costPartition(ORG, "t"), sk: "TOTAL" })).toEqual({
      pk: costPartition(ORG, "t"), sk: "TOTAL", entityType: "COST_TOTAL", taskId: "t", companyId: ORG, currency: "USD", micros: 7,
      tokensInput: 7, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0, entries: 1, unpricedEntries: 0, updatedAt: NOW.toISOString(),
    });
  });
});

describe("the broker root's money wiring (one company's runtime)", () => {
  it("books the usage under the runtime's own company (never the operation's word), over the registry's store and the hosted meter; and sweeps that company's holds", async () => {
    const store = new MemoryDocumentStore();
    const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: "all" }, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined } });
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), ...modules], context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [] });
    const money = coreMoneyWiring(registry, COMPANY_A_ID as OrgId, () => NOW);
    const operation = { id: randomUUID(), workspaceId: randomUUID(), companyId: COMPANY_B_ID } as unknown as OperationRecord;
    const taskId = randomUUID();
    await store.put({ item: { ...taskPointerKey(operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    await money.bookUsage(operation, [event(telemetry("never-heard-of", 1_000, 0))]);
    expect(await store.get(companyDayKey(COMPANY_A_ID, DAY))).toMatchObject({ entries: 1, uncountedEntries: 0, usdMicros: costMicrosOf(UNKNOWN_MODEL_PRICE, { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 }) });
    expect(await store.get(companyDayKey(COMPANY_B_ID, DAY))).toBeUndefined();
    // The admission the registry holds takes holds; the wiring's sweep gives that company's expired ones back.
    const admission = registry.require("admission");
    expect(admission.enforcesCost).toBe(true);
    await admission.admit({ companyId: COMPANY_A_ID, idempotencyKey: "call", action: "model.call" });
    const later = coreMoneyWiring(registry, COMPANY_A_ID as OrgId, () => new Date(NOW.getTime() + 3 * 3_600_000));
    expect(await later.holdSweep.pass({ budgetMs: 10_000 })).toMatchObject({ released: 1 });
  });
});
