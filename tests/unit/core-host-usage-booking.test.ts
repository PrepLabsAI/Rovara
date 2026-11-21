import { createUsageCheckpointer } from "../../packages/worker/src/usage.js";
// Switch-on lane L8: a core task's model usage, as its worker reports it (`usage` events through the callback layer), is booked into the task's cost ledger before the batch is acknowledged,
// once, and never at $0 when it cannot be priced: an unknown model is charged the cautious price, a higher reported cost wins, and an unreadable report makes the day's spend unknown.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { companyDayKey, costPartition, createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { operationKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import { SPEND_UNKNOWN, UNKNOWN_MODEL_PRICE, createHostedAdmission, createHostedLedger, createHostedMetering, hostedSecurityModules } from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { coreMoneyWiring } from "../../packages/broker/src/aws/core-engine-root.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { EMPTY_REPORT_CHARGE_MICROS, NO_TASK_FOR_USAGE, UNREADABLE_USAGE_PROVIDER, createUsageBooking, readUsagePayload, type UsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
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
  return { store, booking, ledger, taskId, operation, pointer: () => store.put({ item: { ...taskPointerKey(operation.companyId, operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } }) };
}

describe("reading a usage report", () => {
  it("reads the provider, the model, whole token counts and a reported dollar cost", () => {
    expect(readUsagePayload(telemetry("known", 10, 20, 0.0000015))).toEqual({ usage: { provider: "anthropic", modelId: "known", tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } }, reportedMicros: 2 });
    expect(readUsagePayload(telemetry("known", 10, 20, null))).toEqual({ usage: { provider: "anthropic", modelId: "known", tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } } });
    // Only a cost reported with no tokens still prices; no tokens and no cost is charged the fixed amount, never $0.
    expect(readUsagePayload(telemetry("known", 0, 0, 0.5))).toMatchObject({ reportedMicros: 500_000 });
    for (const empty of [telemetry("known", 0, 0, null), telemetry("known", 0, 0, 0)]) expect(readUsagePayload(empty)).toMatchObject({ reportedMicros: EMPTY_REPORT_CHARGE_MICROS });
    expect(EMPTY_REPORT_CHARGE_MICROS).toBeGreaterThan(0);
  });

  it("reads nothing it cannot trust as a usage: no model, counts that are not whole numbers, a bad cost, or nothing at all to price", () => {
    for (const payload of [null, "usage", [], {}, { ...telemetry("known", 1, 1), provider: "" }, { ...telemetry("known", 1, 1), modelId: undefined }, { ...telemetry("known", 1, 1), tokens: { input: 1.5, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { ...telemetry("known", 1, 1), tokens: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }, { ...telemetry("known", 1, 1), tokens: { input: 1, output: 0 } }, { ...telemetry("known", 1, 1), costUsd: -1 },
      { ...telemetry("known", 1, 1), costUsd: "1" }, { ...telemetry("known", 1, 1), costUsd: Number.POSITIVE_INFINITY }, { ...telemetry("known", 1, 1), costUsd: 1e300 }]) {
      expect(readUsagePayload(payload), JSON.stringify(payload)).toBeUndefined();
    }
  });
});

describe("booking a core operation's usage events", () => {

  it("books an unreadable report as a usage with no dollar figure: the day's spend is then unknown and the admission refuses new spending", async () => {
    const w = world();
    await w.pointer();
    await w.store.put({ item: { ...workspaceKey(w.operation.companyId, w.operation.workspaceId), id: w.operation.workspaceId, companyId: w.operation.companyId } });
    expect(await w.booking.bookOperationEvents(w.operation, [event({ tokens: "lots" }), event({ ...telemetry("known", 1, 0), costUsd: "free" }, "2026-11-15T10:00:01.000Z")])).toEqual({ booked: 2, unreadable: 2 });
    expect(await w.ledger.taskCost(ORG, w.taskId)).toMatchObject({ micros: 0, entries: 2, unpricedEntries: 2 });
    expect(await w.store.get(companyDayKey(ORG, DAY))).toMatchObject({ usdMicros: 0, uncountedEntries: 2 });
    const entries = (await w.store.query({ pk: costPartition(ORG, w.taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items;
    expect(entries.map((e) => [e["provider"], e["micros"]])).toEqual([[UNREADABLE_USAGE_PROVIDER, undefined], [UNREADABLE_USAGE_PROVIDER, undefined]]);
    const admission = createHostedAdmission({ settings: { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 }, store: w.store, ledger: w.ledger, now: () => NOW });
    expect(await admission.admit({ companyId: ORG, idempotencyKey: "next", action: "task.start", subject: { type: "task", id: randomUUID() } })).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
  });

  it("fails, in fixed words, a batch with usage whose operation names no task; a batch with no usage reads nothing", async () => {
    const w = world();
    expect(await w.booking.bookOperationEvents(w.operation, [event({}, NOW.toISOString(), "progress")])).toEqual({ booked: 0, unreadable: 0 });
    await expect(w.booking.bookOperationEvents(w.operation, [event(telemetry("known", 1, 1))])).rejects.toThrow(new RegExp(`^${NO_TASK_FOR_USAGE}$`, "u"));
  });
});

describe("the callback layer books before it acknowledges", () => {
  const key = "k".repeat(40);
  async function callbackWorld(bookUsage?: Parameters<typeof createCallbackHandler>[0]["bookUsage"], status = "RUNNING") {
    const w = world();
    await w.pointer();
    await w.store.put({ item: { ...workspaceKey(w.operation.companyId, w.operation.workspaceId), id: w.operation.workspaceId, companyId: w.operation.companyId } });
    await w.store.put({ item: { ...operationKey(w.operation.companyId, w.operation.workspaceId, w.operation.id), entityType: "OPERATION", id: w.operation.id, workspaceId: w.operation.workspaceId, companyId: ORG, kind: "task", status, fence: 1, eventSequence: 0 } });
    const flow = { store: w.store, companyId: ORG, callbackSigningKey: key, now: () => NOW, log: () => undefined } as unknown as TaskFlowDeps;
    const handler = createCallbackHandler({ flow, blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } }, ...(bookUsage === undefined ? {} : { bookUsage }) });
    const token = new CallbackCapabilities(Buffer.from(key)).issue({ workspaceId: w.operation.workspaceId, operationId: w.operation.id, fence: 1, actions: ["events"], expiresInSeconds: 600 });
    const post = (events: unknown[]) => handler({ method: "POST", path: `/v1/internal/workspaces/${w.operation.workspaceId}/operations/${w.operation.id}/events`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ events }) });
    const stored = async () => (await w.store.query({ pk: operationKey(w.operation.companyId, w.operation.workspaceId, w.operation.id).pk, sk: { op: "beginsWith", prefix: `EVENT#${w.operation.id}#` } })).items.length;
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

describe("the usage of an operation that already ended (stopped or closed) is still booked (review H1)", () => {
  const key = "k".repeat(40);
  it("books a usage batch of a terminal operation and takes it; any other batch is refused after its usage is booked; without booking nothing changes", async () => {
    for (const status of ["CANCELLED", "INTERRUPTED"]) {
      const w = world();
      await w.pointer();
    await w.store.put({ item: { ...workspaceKey(w.operation.companyId, w.operation.workspaceId), id: w.operation.workspaceId, companyId: w.operation.companyId } });
      await w.store.put({ item: { ...operationKey(w.operation.companyId, w.operation.workspaceId, w.operation.id), entityType: "OPERATION", id: w.operation.id, workspaceId: w.operation.workspaceId, companyId: ORG, kind: "task", status, fence: 1, eventSequence: 0 } });
      const flow = { store: w.store, companyId: ORG, callbackSigningKey: key, now: () => NOW, log: () => undefined } as unknown as TaskFlowDeps;
      const make = (withBooking: boolean) => createCallbackHandler({ flow, blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } }, ...(withBooking ? { bookUsage: (operation, events) => w.booking.bookOperationEvents({ id: operation.id, workspaceId: operation.workspaceId, companyId: ORG }, events) } : {}) });
      const token = new CallbackCapabilities(Buffer.from(key)).issue({ workspaceId: w.operation.workspaceId, operationId: w.operation.id, fence: 1, actions: ["events"], expiresInSeconds: 600 });
      const post = (handler: ReturnType<typeof make>, events: unknown[]) => handler({ method: "POST", path: `/v1/internal/workspaces/${w.operation.workspaceId}/operations/${w.operation.id}/events`, headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify({ events }) });
      expect((await post(make(false), [event(telemetry("known", 1_000_000, 0))])).statusCode, status).toBe(409);
      expect(await w.store.get(companyDayKey(ORG, DAY))).toBeUndefined();
      const usageOnly = await post(make(true), [event(telemetry("known", 1_000_000, 0))]);
      expect(usageOnly.statusCode).toBe(200);
      expect(JSON.parse(usageOnly.body ?? "{}")).toEqual({ accepted: 1 });
      const mixed = await post(make(true), [event(telemetry("known", 2_000_000, 0), "2026-11-15T10:00:05.000Z"), event({ note: "x" }, NOW.toISOString(), "progress")]);
      expect(mixed.statusCode).toBe(409);
      expect((await w.ledger.taskCost(ORG, w.taskId)).micros).toBe(9_000_000);
      // Nothing of the terminal batches was stored as events.
      expect((await w.store.query({ pk: operationKey(w.operation.companyId, w.operation.workspaceId, w.operation.id).pk, sk: { op: "beginsWith", prefix: `EVENT#${w.operation.id}#` } })).items).toEqual([]);
    }
  });
});

describe("the broker root's money wiring (one company's runtime)", () => {
  it("refuses another company's operation, books its own over the registry's store and hosted meter, and sweeps its own holds", async () => {
    const store = new MemoryDocumentStore();
    const modules = hostedSecurityModules({ env: {}, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined }, runStopWired: true });
    const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), ...modules], context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [] });
    const money = coreMoneyWiring(registry, COMPANY_A_ID, () => NOW);
    const operation = { id: randomUUID(), workspaceId: randomUUID(), companyId: COMPANY_B_ID } as unknown as OperationRecord;
    const taskId = randomUUID();
    await store.put({ item: { ...taskPointerKey(operation.companyId, operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    await expect(money.bookUsage(operation, [event(telemetry("never-heard-of", 1_000, 0))])).rejects.toThrow("operation belongs to another company");
    expect(await store.get(companyDayKey(COMPANY_A_ID, DAY))).toBeUndefined();
    expect(await store.get(companyDayKey(COMPANY_B_ID, DAY))).toBeUndefined();
    const ownOperation = { ...operation, companyId: COMPANY_A_ID };
    await store.put({ item: { ...taskPointerKey(ownOperation.companyId, ownOperation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    await money.bookUsage(ownOperation, [event(telemetry("never-heard-of", 1_000, 0))]);
    expect(await store.get(companyDayKey(COMPANY_A_ID, DAY))).toMatchObject({ entries: 1, uncountedEntries: 0, usdMicros: costMicrosOf(UNKNOWN_MODEL_PRICE, { input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0 }) });
    expect(await store.get(companyDayKey(COMPANY_B_ID, DAY))).toBeUndefined();
    // The admission the registry holds takes holds; the wiring's sweep gives that company's expired ones back.
    const admission = registry.require("admission");
    expect(admission.enforcesCost).toBe(true);
    await admission.admit({ companyId: COMPANY_A_ID, idempotencyKey: "call", action: "model.call" });
    const later = coreMoneyWiring(registry, COMPANY_A_ID, () => new Date(NOW.getTime() + 3 * 3_600_000));
    expect(await later.holdSweep.pass({ budgetMs: 10_000 })).toMatchObject({ released: 1 });
  });
});

import { chargeReceipt } from "./charge-receipt-fixture.js";
it("ignores worker receipts, including final revisions and signed deltas, while booking all token totals", async () => {
  const w = world(); await w.pointer();
  const receipt = chargeReceipt({ companyId: ORG, taskId: w.taskId, operationId: w.operation.id });
  // Seed authenticated evidence at the ledger seam; workers cannot revise it.
  await w.ledger.applyChargeReceipt(receipt);
  const forged = { ...receipt, revision: 2, replacesRevision: 1, status: "final", reason: "reported_cost", amountMicros: { state: "available", value: 0 }, providerCostMicros: { state: "available", value: 0 } };
  const report = { ...telemetry("known", 1_000_000, 0), chargeReceipts: [forged] };
  expect(await w.booking.bookOperationEvents(w.operation, [event(report)])).toMatchObject({ booked: 1, unreadable: 0 });
  expect(await w.ledger.taskCost(ORG, w.taskId)).toMatchObject({ micros: 3_000_080, tokens: { input: 1_000_000 }, provisionalCalls: 1 });
  expect(await w.ledger.companyDayCost(ORG, receipt.accountingDay)).toMatchObject({ usdMicros: 80 });
  expect(await w.booking.bookOperationEvents(w.operation, [event(report)])).toMatchObject({ booked: 0 });
  const chargeEntry = (await w.store.query({ pk: costPartition(ORG, w.taskId), sk: { op: "beginsWith", prefix: "ENTRY#usage-charge:" } })).items[0];
  expect(chargeEntry).toMatchObject({ revision: 1, chargeStatus: "awaiting_usage" });
});
it("books missing calls alongside reported tokens as awaiting_usage with no dollar amount, once, and blocks admission", async () => {
  const w = world(); await w.pointer();
  const report = { ...telemetry("known", 1_000_000, 0), usageMissingCalls: 2 };
  await w.booking.bookOperationEvents(w.operation, [event(report)]);
  await w.booking.bookOperationEvents(w.operation, [event(report)]);
  expect(await w.ledger.taskCost(ORG, w.taskId)).toMatchObject({ micros: 3_000_000, unpricedEntries: 2, provisionalCalls: 2 });
  const rows = (await w.store.query({ pk: costPartition(ORG, w.taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items;
  const pending = rows.find(r => r["chargeStatus"] === "awaiting_usage");
  expect(pending).toMatchObject({ usageMissingCalls: 2, reason: "missing_usage" });
  expect(pending).not.toHaveProperty("micros");
  expect(await w.ledger.companyDayCost(ORG, DAY)).toMatchObject({ usdMicros: 3_000_000, uncountedEntries: 2 });
  const admission = createHostedAdmission({ store: w.store, ledger: w.ledger, settings: { companyDayCapMicros: 100_000_000, taskCapMicros: 100_000_000 }, now: () => NOW });
  expect(await admission.admit({ companyId: ORG, idempotencyKey: "missing", action: "task.start", subject: { type: "task", id: randomUUID() } })).toMatchObject({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
});
it("missing-only calls have no guessed empty-report amount; legacy empty reports are explicitly estimated", async () => {
  const w = world(); await w.pointer();
  await w.booking.bookOperationEvents(w.operation, [event({ ...telemetry("known", 0, 0), usageMissingCalls: 1 })]);
  expect(await w.ledger.taskCost(ORG, w.taskId)).toMatchObject({ micros: 0, entries: 1, unpricedEntries: 1, provisionalCalls: 1 });
  const empty = world(); await empty.pointer();
  await empty.booking.bookOperationEvents(empty.operation, [event(telemetry("known", 0, 0))]);
  expect(await empty.ledger.taskCost(ORG, empty.taskId)).toMatchObject({ micros: EMPTY_REPORT_CHARGE_MICROS, provisionalCalls: 1 });
  expect((await empty.store.query({ pk: costPartition(ORG, empty.taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items[0]).toMatchObject({ chargeStatus: "estimated" });
});

// Exercise the worker evidence through booking and the company's real admission guard.
it.each([
  ["provider 429", [{ type: "message_end", message: { role: "assistant", provider: "anthropic", stopReason: "error", errorMessage: '429 {"error":{"type":"rate_limit_error"}}' } }], false],
  ["routed 429", [{ type: "message_end", message: { role: "assistant", provider: "rovara-route", stopReason: "error", errorMessage: "Model source request failed; rate limited or out of credits; check the key's usage limits before retrying" } }], false],
  ["gateway cap", [{ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "AI budget exhausted (org)" } }], false],
  ["retry then success", [
    { type: "message_start", message: { role: "assistant" } },
    { type: "message_end", message: { role: "assistant", provider: "anthropic", stopReason: "error", errorMessage: "Anthropic request failed; upstream unavailable; check provider status before retrying" } },
    { type: "auto_retry_start", attempt: 1 },
    { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10, output: 1 } } },
  ], false],
  ["mid-answer abort", [
    { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: "answer" } },
    { type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Model source request cancelled" } },
  ], true],
  ["stream error despite HTTP diagnostic", [
    { type: "message_update", message: { role: "assistant" }, assistantMessageEvent: { type: "start" } },
    { type: "message_end", message: { role: "assistant", stopReason: "error", status: 503 } },
  ], true],
  ["started stream before empty abort", [
    { type: "message_start", message: { role: "assistant", stopReason: "pending" } },
    { type: "message_end", message: { role: "assistant", stopReason: "aborted", status: 503 } },
  ], true],
  ["ambiguous error", [{ type: "message_end", message: { role: "assistant", stopReason: "error" } }], false],
  ["cancel before headers: Anthropic request cancelled", [
    { type: "message_start", message: { role: "assistant", stopReason: "aborted", errorMessage: "Anthropic request cancelled" } },
    { type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Anthropic request cancelled" } },
  ], false],
  ["cancel before headers: Model source request cancelled", [
    { type: "message_start", message: { role: "assistant", stopReason: "aborted", errorMessage: "Model source request cancelled" } },
    { type: "message_end", message: { role: "assistant", stopReason: "aborted", errorMessage: "Model source request cancelled" } },
  ], false],
  ["connection reset with no status", [
    { type: "message_start", message: { role: "assistant", stopReason: "error", errorMessage: "connection reset" } },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "connection reset" } },
  ], false],
  ["cut-off after start with a refusal-looking message", [
    { type: "message_start", message: { role: "assistant", stopReason: "pending" } },
    { type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Model source request failed; rate limited or out of credits; check the key's usage limits before retrying" } },
  ], true],
  ["Bedrock refusal", [{ type: "message_end", message: { role: "assistant", provider: "amazon-bedrock", stopReason: "error", diagnostics: [{ details: { status: 503 } }] } }], false],
  ["status refusal", [{ type: "message_end", message: { role: "assistant", stopReason: "error", status: 429 } }], false],
])("%s counts only started calls with missing usage and preserves company admission", async (_name, events, missing) => {
  const w = world(); await w.pointer();
  const stats = { tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, total: 11 }, cost: 0 };
  const checkpointer = createUsageCheckpointer({ enabled: false, baseline: undefined, stats: () => stats, model: () => ({ provider: "anthropic", modelId: "known" }), requested: {}, send: () => undefined });
  for (const e of events) checkpointer.observe(e);
  const report = checkpointer.endReport(stats, { provider: "anthropic", modelId: "known" }, "SUCCEEDED", {});
  expect(report?.usageMissingCalls ?? 0).toBe(missing ? 1 : 0);
  await w.booking.bookOperationEvents(w.operation, [event(report)]);
  expect(await w.ledger.companyDayCost(ORG, DAY)).toMatchObject({ uncountedEntries: missing ? 1 : 0 });
  const admission = createHostedAdmission({ store: w.store, ledger: w.ledger, settings: { companyDayCapMicros: 100_000_000, taskCapMicros: 100_000_000 }, now: () => NOW });
  expect(await admission.admit({ companyId: ORG, idempotencyKey: "refusal-check", action: "task.start", subject: { type: "task", id: randomUUID() } })).toMatchObject(missing ? { allowed: false, code: "spend_unknown" } : { allowed: true });
});

describe("one task-money projection", () => {
  const task = { taskId: "money-task", companyId: ORG, workspaceId: "money-workspace", status: "CLOSED", updatedAt: NOW.toISOString(), createdAt: NOW.toISOString() };
  const read = async (store: MemoryDocumentStore, extra = {}) => {
    const module = await import("../../packages/broker/src/core/cost/ledger.js");
    const project = Reflect.get(module, "readTaskMoney");
    expect(project).toBeTypeOf("function");
    return project({ store, companyId: ORG, task, ...extra });
  };
  it("counts awaiting usage once, keeps terminal money provisional and replaces corrections", async () => {
    const { chargeReceipt: receipt } = await import("./charge-receipt-fixture.js");
    const store = new MemoryDocumentStore();
    const ledger = createCostLedger({ store, metering, now: () => NOW });
    const r = receipt({ companyId: ORG, taskId: task.taskId, amountMicros: { state: "available", value: 80 }, originalReservationMicros: { state: "available", value: 80 } });
    await ledger.applyChargeReceipt(r);
    const first = await read(store, { hosted: true, revealPayer: true });
    expect(first).toMatchObject({ state: "partial", revision: 1, spentMicros: { value: 80 }, estimatedMicros: { value: 80 }, awaitingUsageMicros: { value: 80 }, awaitingUsageCalls: { value: 1 }, finality: "provisional" });
    await ledger.applyChargeReceipt(receipt({ ...r, revision: 2, replacesRevision: 1, status: "final", reason: "confirmed_not_sent", amountMicros: { state: "available", value: 0 } }));
    const corrected = await read(store, { hosted: true });
    expect(corrected).toMatchObject({ revision: 2, spentMicros: { value: 0 }, awaitingUsageCalls: { value: 0 }, finality: "provisional" });
  });
  it("counts calls with no amount without inventing a dollar and restricts payer detail", async () => {
    const { chargeReceipt: receipt } = await import("./charge-receipt-fixture.js");
    const store = new MemoryDocumentStore();
    const ledger = createCostLedger({ store, metering, now: () => NOW });
    await ledger.applyChargeReceipt(receipt({ companyId: ORG, taskId: task.taskId, amountMicros: { state: "unavailable", reason: "not_measured" }, originalReservationMicros: { state: "unavailable", reason: "not_measured" } }));
    expect(await read(store, { hosted: true })).toMatchObject({ spentMicros: { state: "unavailable" }, awaitingUsageCalls: { value: 1 }, awaitingUsageMicros: { state: "unavailable" }, payer: { state: "unavailable", reason: "restricted" }, allocations: [] });
  });
});
