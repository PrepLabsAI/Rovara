// Lane core-money-stop, the deployed side (core-host/hosted-modules.ts, core/cost/holds.ts, aws/core-engine-root.ts `coreMoneyWiring`, services/callbacks.ts): where a run stands
// against the task's and the day's caps, the run stopped as its usage is booked, a stopped run's whole hold kept as spent (marked estimated), and unattended work refused until the
// per-run stop is wired. Two companies throughout: nothing one does reads or moves the other's money.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type MeterEntry, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyDayKey, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { holdKey, openHoldRoom } from "../../packages/broker/src/core/cost/holds.js";
import {
  COMPANY_DAY_CAP_REACHED, CORE_OUTBOX_STREAM_RELAY_VARIABLE, RUN_STOP_NOT_WIRED, SPEND_UNKNOWN, TASK_CAP_REACHED, createHostedAdmission, createHostedLedger, createHostedMoneyStop, hostedSecurityModules,
  runSpendState, runStopWiredFrom, runsOwed, unflushedEntryId, unflushedEstimateMicros, type HostedAdmissionSettings,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { coreMoneyWiring } from "../../packages/broker/src/aws/core-engine-root.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { CHECKPOINT_ENTRY_PREFIX, EMPTY_REPORT_CHARGE_MICROS, readUsagePayload } from "../../packages/broker/src/core-host/usage-booking.js";
import { RUN_START_ACTION, type MoneyStop } from "../../packages/broker/src/core/task-flow/money-stop.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const B = COMPANY_B_ID as OrgId;
const DAY = "2026-11-15";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const SETTINGS: HostedAdmissionSettings = { allowedCompanies: "all", taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };

/** A meter that charges exactly `input` tokens' count in micros (USD), or no price for model `unpriced`. */
const exactMeter = {
  async price() { return null; },
  async record(e: MeterEntry) {
    if (e.usage.modelId === "unpriced") return { cost: null, source: "unknown" as const };
    // A reported cost higher than the tokens' price wins, as the hosted meter's does.
    return { cost: { micros: Math.max(e.usage.tokens.input, e.reportedCost?.micros ?? 0), currency: "USD" }, source: "price-table" as const };
  },
};

function setup(settings: HostedAdmissionSettings = SETTINGS) {
  const store = new MemoryDocumentStore();
  const now = () => NOW;
  const ledger = createHostedLedger({ store, metering: exactMeter, now });
  const admission = createHostedAdmission({ settings, store, ledger, now, runStopWired: true });
  const book = (companyId: string, taskId: string, micros: number, modelId = "m") =>
    ledger.recordUsage({ companyId, entryId: randomUUID(), at: NOW.toISOString(), taskId, usage: { provider: "anthropic", modelId, tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  /** A task start's hold, committed as the start transaction does. */
  const start = async (companyId: string, taskId: string) => {
    const staged = await admission.stage({ companyId, idempotencyKey: `task.start:${taskId}`, action: "task.start", subject: { type: "task", id: taskId }, taskStart: { workflow: true, path: "FULL", pathFrom: "request" } });
    expect(staged.decision.allowed).toBe(true);
    expect((await store.transact([...staged.items])).applied).toBe(true);
    return staged.decision.allowed ? staged.decision.reservationId! : "";
  };
  const state = (companyId: string, taskId: string) => runSpendState({ store, ledger, settings, now }, companyId, taskId);
  return { store, ledger, admission, book, start, state };
}

describe("where a run stands against the caps (runSpendState)", () => {
  it("is within while the task's booked spend is under the task cap and the day has room", async () => {
    const w = setup();
    const task = randomUUID();
    await w.start(A, task);
    await w.book(A, task, 4_999_999);
    expect(await w.state(A, task)).toBe("within");
    await w.book(A, task, 1);
    expect(await w.state(A, task)).toBe("task_cap");
  });

  it("at a full day, stops a run whose own hold is used up, and lets one go on that still has room in its own hold", async () => {
    const w = setup({ ...SETTINGS, companyDayCapMicros: 10_000_000 });
    const mine = randomUUID();
    const other = randomUUID();
    await w.start(A, mine);
    await w.start(A, other);
    // Two holds of $5 fill the $10 day; neither has spent yet: both go on (their spend was promised to them).
    expect(await w.state(A, mine)).toBe("within");
    await w.book(A, mine, 4_000_000);
    expect(await w.state(A, mine)).toBe("within");
    // Its hold used up and the day full: the next of its spend has no room anywhere.
    await w.book(A, mine, 1_000_000);
    expect(await w.state(A, mine)).toBe("task_cap");
    // Booked spend past the day cap from a task with no hold: stopped by the day.
    const unheld = randomUUID();
    await w.book(A, unheld, 1);
    expect(await w.state(A, unheld)).toBe("company_day_cap");
    expect(await w.state(A, other)).toBe("within");
  });

  it("at a full day, stops a run whose own hold is used up even under the task cap; a hold of an earlier day gives no room today", async () => {
    // With a $20 task cap a start holds the full $6 planning allowance.
    const w = setup({ ...SETTINGS, taskCapMicros: 20_000_000, companyDayCapMicros: 12_000_000 });
    const mine = randomUUID();
    await w.start(A, mine);
    await w.start(A, randomUUID());
    await w.book(A, mine, 6_000_000);
    // Its $6 hold is used up, the day is at $12 of $12: no room left anywhere, though the task is under its cap.
    expect(await w.state(A, mine)).toBe("company_day_cap");
    // A hold taken yesterday, with room: today's full day stops the run all the same.
    const store = new MemoryDocumentStore();
    const yesterday = new Date(`2026-11-14T10:00:00.000Z`);
    const old = createHostedLedger({ store, metering: exactMeter, now: () => yesterday });
    const staged = await createHostedAdmission({ settings: SETTINGS, store, ledger: old, now: () => yesterday, runStopWired: true }).stage({ companyId: A, idempotencyKey: "s", action: "task.start", subject: { type: "task", id: mine }, taskStart: { workflow: true, path: "FULL", pathFrom: "request" } });
    expect((await store.transact([...staged.items])).applied).toBe(true);
    const today = createHostedLedger({ store, metering: exactMeter, now: () => NOW });
    await today.recordUsage({ companyId: A, entryId: "big", at: NOW.toISOString(), taskId: randomUUID(), usage: { provider: "p", modelId: "m", tokens: { input: 25_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    expect(await runSpendState({ store, ledger: today, settings: SETTINGS, now: () => NOW }, A, mine)).toBe("company_day_cap");
  });

  it("reads a task with unpriced usage as unknown even when the day reads", async () => {
    const w = setup();
    const task = randomUUID();
    await w.store.put({ item: { pk: costPartition(A, task), sk: "TOTAL", entityType: "COST_TOTAL", taskId: task, companyId: A, micros: 0, entries: 1, unpricedEntries: 1 } });
    expect(await w.state(A, task)).toBe("spend_unknown");
  });

  it("reads spend that is not dollars as unknown (fails closed), and so a read that throws", async () => {
    const w = setup();
    const task = randomUUID();
    await w.book(A, task, 10, "unpriced");
    expect(await w.state(A, task)).toBe("spend_unknown");
    const throwing = { taskCost: async () => { throw new Error("down"); } };
    expect(await runSpendState({ store: w.store, ledger: throwing, settings: SETTINGS, now: () => NOW }, A, randomUUID())).toBe("spend_unknown");
    // Another task of the company booked an unreadable usage: the day is unknown, so this run stops too.
    const fine = randomUUID();
    expect(await w.state(A, fine)).toBe("spend_unknown");
  });

  it("never reads another company's day or task", async () => {
    const w = setup({ ...SETTINGS, companyDayCapMicros: 5_000_000 });
    const task = randomUUID();
    await w.book(B, task, 5_000_000);
    expect(await w.state(B, task)).toBe("task_cap");
    expect(await w.state(A, task)).toBe("within");
    expect(await w.state(A, randomUUID())).toBe("within");
  });
});

describe("the admission's gate before each model run (run.start)", () => {
  it("allows a run within the caps, holding nothing, and refuses one at a cap in the admission's own words", async () => {
    const w = setup();
    const task = randomUUID();
    await w.start(A, task);
    const before = await w.store.get(companyDayKey(A, DAY));
    const ask = (taskId: string, companyId: string = A) => w.admission.admit({ companyId, idempotencyKey: `${RUN_START_ACTION}:${randomUUID()}`, action: RUN_START_ACTION, subject: { type: "task", id: taskId } });
    expect(await ask(task)).toEqual({ allowed: true });
    expect(await w.store.get(companyDayKey(A, DAY))).toEqual(before);
    await w.book(A, task, 5_000_000);
    expect(await ask(task)).toEqual({ allowed: false, code: "task_cap", message: TASK_CAP_REACHED });
    const unheld = randomUUID();
    await w.book(A, unheld, 1);
    const full = setup({ ...SETTINGS, companyDayCapMicros: 1 });
    await full.book(A, unheld, 1);
    expect(await full.admission.admit({ companyId: A, idempotencyKey: "r", action: RUN_START_ACTION, subject: { type: "task", id: unheld } })).toEqual({ allowed: false, code: "company_day_cap", message: COMPANY_DAY_CAP_REACHED });
    // No task named: refused, never let through.
    expect(await w.admission.admit({ companyId: A, idempotencyKey: "r2", action: RUN_START_ACTION })).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
    // A company off the list: refused before anything is read.
    const listed = createHostedAdmission({ settings: { ...SETTINGS, allowedCompanies: [A] }, store: w.store, ledger: w.ledger, now: () => NOW, runStopWired: true });
    expect((await listed.admit({ companyId: B, idempotencyKey: "r3", action: RUN_START_ACTION, subject: { type: "task", id: task } })).allowed).toBe(false);
  });
});

describe("unattended work waits for the per-run stop", () => {
  it("an admission whose root has not wired the stop declares no enforced cost and refuses automation.run, holding nothing", async () => {
    const store = new MemoryDocumentStore();
    const ledger = createHostedLedger({ store, metering: exactMeter, now: () => NOW });
    const unwired = createHostedAdmission({ settings: SETTINGS, store, ledger, now: () => NOW });
    expect(unwired.enforcesCost).toBe(false);
    const run = { companyId: A, idempotencyKey: `automation.run#${randomUUID()}`, action: "automation.run", estimate: { cost: { micros: 1_000_000, currency: "USD" } } };
    expect(await unwired.admit(run)).toEqual({ allowed: false, code: "run_stop_not_wired", message: RUN_STOP_NOT_WIRED });
    expect(await store.get(companyDayKey(A, DAY))).toBeUndefined();
    const wired = createHostedAdmission({ settings: SETTINGS, store, ledger, now: () => NOW, runStopWired: true });
    expect(wired.enforcesCost).toBe(true);
    expect((await wired.admit(run)).allowed).toBe(true);
    // The registry's module follows the root's word.
    for (const runStopWired of [undefined, true] as const) {
      const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: "all" }, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined }, ...(runStopWired === undefined ? {} : { runStopWired }) });
      const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => new MemoryDocumentStore() }), ...modules], context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [] });
      expect(registry.require("admission").enforcesCost).toBe(runStopWired === true);
    }
  });
});

describe("a stopped run's usage that never arrived: the whole hold is kept, marked estimated", () => {
  it("keeps what usage drew plus all the hold still holds (never less than the hold), and marks the hold and the day", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    await w.book(A, task, 1_500_000);
    const stop = createHostedMoneyStop({ store: w.store, companyId: A, settings: SETTINGS, now: () => NOW });
    const operationId = randomUUID();
    await stop.keepWholeHold(hold, { operationId, taskId: task });
    expect(await w.store.get(holdKey(A, hold))).toMatchObject({ state: "settled", keptMicros: 3_500_000, drawnMicros: 1_500_000, estimated: true, estimatedFor: operationId });
    // The unreported spend is kept at no less than the fixed estimate ($5): the hold's $3.50 room, and $1.50 more as the estimate entry. The checkpoints' $1.50 stays booked.
    expect(await w.store.get({ pk: costPartition(A, task), sk: `ENTRY#${unflushedEntryId(operationId)}` })).toBeDefined();
    expect((await w.ledger.taskCost(A, task)).micros).toBe(3_000_000);
    expect(await w.store.get(companyDayKey(A, DAY))).toMatchObject({ usdMicros: 3_000_000, settledMicros: 3_500_000, estimatedMicros: 3_500_000, reservedMicros: 0, loadMicros: 6_500_000 });
    // The next run of the task stopped without its usage (after a Retry): its hold is closed now, so a fixed estimate is booked on the task, never $0; once per run.
    const next = randomUUID();
    await stop.keepWholeHold(hold, { operationId: next, taskId: task });
    expect(await w.store.get({ pk: costPartition(A, task), sk: `ENTRY#${unflushedEntryId(next)}` })).toBeDefined();
    expect((await w.ledger.taskCost(A, task)).micros).toBe(3_000_000 + unflushedEstimateMicros(SETTINGS));
    expect(await w.store.get(companyDayKey(A, DAY))).toMatchObject({ usdMicros: 8_000_000, loadMicros: 11_500_000 });
    await stop.keepWholeHold(hold, { operationId: next, taskId: task });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(3_000_000 + unflushedEstimateMicros(SETTINGS));
    expect(unflushedEstimateMicros(SETTINGS)).toBe(5_000_000);
    expect(unflushedEstimateMicros(undefined)).toBe(6_000_000);
  });

  it("a hold its usage used up keeps nothing more, so the estimate is booked; a hold of an earlier day leaves no room on this one", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    await w.book(A, task, 5_000_000);
    const stop = createHostedMoneyStop({ store: w.store, companyId: A, settings: SETTINGS, now: () => NOW });
    await stop.keepWholeHold(hold, { operationId: "o1", taskId: task });
    expect(await w.store.get(holdKey(A, hold))).toMatchObject({ state: "settled", keptMicros: 0, estimated: true });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(10_000_000);
    const other = setup();
    const t2 = randomUUID();
    const h2 = await other.start(A, t2);
    expect(await openHoldRoom(other.store, h2, DAY)).toBe(5_000_000);
    expect(await openHoldRoom(other.store, h2, "2026-11-16")).toBe(0);
  });

  it("touches only the hold's own company, and does nothing for no hold or an id that is not one", async () => {
    const w = setup();
    const task = randomUUID();
    const holdA = await w.start(A, task);
    const holdB = await w.start(B, task);
    const stop = createHostedMoneyStop({ store: w.store, companyId: A, settings: SETTINGS, now: () => NOW });
    const dayB = await w.store.get(companyDayKey(B, DAY));
    await stop.keepWholeHold(holdA, { operationId: randomUUID(), taskId: task });
    expect(await w.store.get(companyDayKey(B, DAY))).toEqual(dayB);
    expect(await w.store.get(holdKey(B, holdB))).toMatchObject({ state: "open" });
    for (const id of [undefined, "", "hold:org_x:abc", holdA.replace(A, B), holdB]) await stop.keepWholeHold(id, { operationId: randomUUID(), taskId: task });
    // B's own hold through A's money stop: untouched; what is kept is A's estimate, on A's task.
    expect(await w.store.get(companyDayKey(B, DAY))).toEqual(dayB);
    expect(await w.store.get(holdKey(B, holdB))).toMatchObject({ state: "open" });
    expect((await w.ledger.taskCost(B, task)).micros).toBe(0);
  });

  it("a run taken as unflushed is owed until its estimate is booked (closing the task then keeps the hold); checkpoints alone never make a run booked", async () => {
    const store = new MemoryDocumentStore();
    const taskId = randomUUID();
    const workspaceId = randomUUID();
    await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, workspaceId, companyId: A } });
    await store.put({ item: { ...workspaceKey(A, workspaceId), id: workspaceId, companyId: A } });
    const run = (id: string, extra: Record<string, unknown> = {}) => store.put({ item: { ...operationKey(A, workspaceId, id), entityType: "OPERATION", id, workspaceId, companyId: A, kind: "task", status: "CANCELLED", fence: 1, eventSequence: 3, dispatch: { kind: "task", payload: {} }, createdAt: NOW.toISOString(), ...extra } });
    const entry = (entryId: string) => store.put({ item: { pk: costPartition(A, taskId), sk: `ENTRY#${entryId}`, entityType: "COST_ENTRY" } });
    const op = randomUUID();
    await run(op);
    await entry(`${CHECKPOINT_ENTRY_PREFIX}:${op}:abc`);
    expect(await runsOwed(store, A, taskId)).toBe(true);
    await entry(`usage:${op}:def`);
    expect(await runsOwed(store, A, taskId)).toBe(false);
    const lost = randomUUID();
    await run(lost, { usageUnflushed: true });
    await entry(`usage:${lost}:xyz`);
    expect(await runsOwed(store, A, taskId)).toBe(true);
    await entry(unflushedEntryId(lost));
    expect(await runsOwed(store, A, taskId)).toBe(false);
  });
});

describe("the per-run stop is wired only with the fast relay (lane L9)", () => {
  it("reads the relay's variable: on only for exactly on", () => {
    expect(runStopWiredFrom({})).toBe(false);
    expect(runStopWiredFrom({ [CORE_OUTBOX_STREAM_RELAY_VARIABLE]: "off" })).toBe(false);
    expect(runStopWiredFrom({ [CORE_OUTBOX_STREAM_RELAY_VARIABLE]: "true" })).toBe(false);
    expect(runStopWiredFrom({ [CORE_OUTBOX_STREAM_RELAY_VARIABLE]: " on " })).toBe(true);
  });
});

describe("the run is stopped as its usage is booked (the broker root's wiring and the callback layer)", () => {
  const telemetry = (input: number) => ({ schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: "m", cacheRetention: "short", tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input }, cacheReadRatio: 0, costUsd: null, checkpoint: true });

  async function root(companyId: OrgId) {
    const store = new MemoryDocumentStore();
    const modules = hostedSecurityModules({ env: { ROVARA_CORE_ALLOWED_COMPANIES: "all" }, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined }, runStopWired: true });
    const registry = await buildCoreRegistry({
      modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => store }), coreAdapter({ point: "metering", name: "exact", owner: "test", create: () => exactMeter }), ...modules.filter((module) => module.point !== "metering")],
      context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [],
    });
    const money = coreMoneyWiring(registry, companyId, () => NOW, SETTINGS);
    return { store, money };
  }

  it("answers the batch that takes the task past its cap with the stop's code, and only that one", async () => {
    const { store, money } = await root(A);
    const operation = { id: randomUUID(), workspaceId: randomUUID(), companyId: A } as unknown as OperationRecord;
    await store.put({ item: { ...taskPointerKey(operation.companyId, operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId: randomUUID() } });
    const at = (n: number) => `${DAY}T10:00:0${String(n)}.000Z`;
    expect(await money.bookUsage(operation, [{ type: "usage", timestamp: at(1), payload: telemetry(4_000_000) }])).toEqual({ booked: 1, unreadable: 0 });
    expect(await money.bookUsage(operation, [{ type: "progress", timestamp: at(2), payload: {} }])).toEqual({ booked: 0, unreadable: 0 });
    expect(await money.bookUsage(operation, [{ type: "usage", timestamp: at(3), payload: telemetry(1_000_000) }])).toEqual({ booked: 1, unreadable: 0, spendStop: "task_cap" });
    // Without the caps (a root that does not wire the stop) nothing is read.
    const bare = coreMoneyWiring({ require: ((point: string) => (point === "storage" ? store : exactMeter)) as never }, A, () => NOW);
    expect(await bare.bookUsage(operation, [{ type: "usage", timestamp: at(4), payload: telemetry(1) }])).toEqual({ booked: 1, unreadable: 0 });
  });

  it("books a checkpoint under its own entry kind, and a session's final zero after checkpoints at $0 (an ordinary zero report is still charged)", async () => {
    const { store, money } = await root(A);
    const operation = { id: randomUUID(), workspaceId: randomUUID(), companyId: A } as unknown as OperationRecord;
    const taskId = randomUUID();
    await store.put({ item: { ...taskPointerKey(operation.companyId, operation.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    const zero = { ...telemetry(0), checkpoint: undefined };
    await money.bookUsage(operation, [
      { type: "usage", timestamp: `${DAY}T10:00:01.000Z`, payload: telemetry(1_000) },
      { type: "usage", timestamp: `${DAY}T10:00:02.000Z`, payload: { ...zero, final: true } },
    ]);
    const entries = (await store.query({ pk: costPartition(A, taskId), sk: { op: "beginsWith", prefix: "ENTRY#" } })).items.map((item) => String(item["sk"]));
    expect(entries.filter((sk) => sk.startsWith(`ENTRY#${CHECKPOINT_ENTRY_PREFIX}:${operation.id}:`))).toHaveLength(1);
    expect(entries.filter((sk) => sk.startsWith(`ENTRY#usage:${operation.id}:`))).toHaveLength(1);
    expect(await store.get({ pk: costPartition(A, taskId), sk: "TOTAL" })).toMatchObject({ micros: 1_000 });
    await money.bookUsage(operation, [{ type: "usage", timestamp: `${DAY}T10:00:03.000Z`, payload: zero }]);
    expect(await store.get({ pk: costPartition(A, taskId), sk: "TOTAL" })).toMatchObject({ micros: 1_000 + EMPTY_REPORT_CHARGE_MICROS });
  });

  it("a final zero with no checkpoint of its run in the ledger keeps the empty-report floor (the worker's word alone never makes it $0)", async () => {
    const { store, money } = await root(A);
    const taskId = randomUUID();
    const mine = { id: randomUUID(), workspaceId: randomUUID(), companyId: A } as unknown as OperationRecord;
    const other = { id: randomUUID(), workspaceId: mine.workspaceId, companyId: A } as unknown as OperationRecord;
    await store.put({ item: { ...taskPointerKey(mine.companyId, mine.workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
    const finalZero = { ...telemetry(0), checkpoint: undefined, final: true };
    // Another run's checkpoint does not count for this one.
    await money.bookUsage(other, [{ type: "usage", timestamp: `${DAY}T10:00:01.000Z`, payload: telemetry(1_000) }]);
    await money.bookUsage(mine, [{ type: "usage", timestamp: `${DAY}T10:00:02.000Z`, payload: finalZero }]);
    expect(await store.get({ pk: costPartition(A, taskId), sk: "TOTAL" })).toMatchObject({ micros: 1_000 + EMPTY_REPORT_CHARGE_MICROS });
    expect(readUsagePayload(finalZero)).toMatchObject({ reportedMicros: EMPTY_REPORT_CHARGE_MICROS });
    expect(readUsagePayload(finalZero, { checkpointsBooked: true })).not.toHaveProperty("reportedMicros");
    // A checkpoint of its own booked in an earlier batch counts.
    await money.bookUsage(mine, [{ type: "usage", timestamp: `${DAY}T10:00:03.000Z`, payload: telemetry(2_000) }]);
    await money.bookUsage(mine, [{ type: "usage", timestamp: `${DAY}T10:00:04.000Z`, payload: finalZero }]);
    expect(await store.get({ pk: costPartition(A, taskId), sk: "TOTAL" })).toMatchObject({ micros: 3_000 + EMPTY_REPORT_CHARGE_MICROS });
  });

  it("the callback layer acks the batch and asks the run to stop (CANCEL_REQUESTED, the code, a cancel to its worker); another company's run is never touched", async () => {
    const store = new MemoryDocumentStore();
    const signingKey = Buffer.alloc(32, 7);
    // The broker never reaches a worker: the cancel is staged in the outbox for the dispatcher and relayed at once.
    const queued: Array<{ companyId: string; body: Record<string, unknown> }> = [];
    const relayed: unknown[] = [];
    const delivered: unknown[] = [];
    const stop: MoneyStop = { async keepWholeHold() {} };
    const flowFor = (companyId: OrgId) => ({
      companyId, store, callbackSigningKey: signingKey, now: () => NOW, moneyStop: stop,
      outbox: {
        stage: (message: { id: string; companyId: string; body: Record<string, unknown> }) => { queued.push(message); return { kind: "put", item: { pk: `OUTBOX#${message.companyId}`, sk: message.id } }; },
        relay: async (options: unknown) => { relayed.push(options); return { relayed: 1 }; },
      },
      machines: { async deliver(...args: unknown[]) { delivered.push(args); return { duplicate: false }; } },
    }) as unknown as TaskFlowDeps;
    const operationOf = async (companyId: OrgId) => {
      const workspaceId = randomUUID();
      const operation = { pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${randomUUID()}` };
      const id = operation.sk.slice("OPERATION#".length);
      await store.put({ item: { ...operationKey(companyId, workspaceId, id), entityType: "OPERATION", id, workspaceId, companyId, kind: "task", status: "RUNNING", fence: 1, eventSequence: 0, machineId: `m-${companyId}`, dispatch: { kind: "task", payload: {} } } });
      await store.put({ item: { ...workspaceKey(companyId, workspaceId), id: workspaceId, companyId, projectRevision: 1 } });
      return { workspaceId, id };
    };
    const a = await operationOf(A);
    const b = await operationOf(B);
    const handler = createCallbackHandler({
      flow: flowFor(A), blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); } },
      bookUsage: async () => ({ booked: 1, unreadable: 0, spendStop: "company_day_cap" }),
    });
    const capability = new CallbackCapabilities(signingKey).issue({ workspaceId: a.workspaceId, operationId: a.id, fence: 1, actions: ["events"], expiresInSeconds: 600 });
    const answer = await handler({ method: "POST", path: `/v1/internal/workspaces/${a.workspaceId}/operations/${a.id}/events`, headers: { [CAPABILITY_HEADER]: capability }, body: JSON.stringify({ events: [{ type: "usage", timestamp: NOW.toISOString(), payload: telemetry(1) }] }) });
    expect(answer.statusCode).toBe(200);
    expect(await store.get(operationKey(A, a.workspaceId, a.id))).toMatchObject({ status: "CANCEL_REQUESTED", stopReason: "company_day_cap", stopRequestedAt: NOW.toISOString() });
    expect(queued).toHaveLength(1);
    expect(queued[0]!.companyId).toBe(A);
    expect(queued[0]!.body).toMatchObject({ v: 1, companyId: A, workspaceId: a.workspaceId, operationId: a.id });
    expect(typeof queued[0]!.body["cancel"]).toBe("string");
    expect(relayed).toEqual([{ companyId: A, ids: [queued[0]!.body["cancel"]] }]);
    expect(delivered).toEqual([]);
    expect(await store.get(operationKey(B, b.workspaceId, b.id))).toMatchObject({ status: "RUNNING" });
    expect(await store.get(operationKey(B, b.workspaceId, b.id))).not.toHaveProperty("stopReason");
    // B's operation through A's callback layer: refused as not found, nothing stopped.
    const foreign = new CallbackCapabilities(signingKey).issue({ workspaceId: b.workspaceId, operationId: b.id, fence: 1, actions: ["events"], expiresInSeconds: 600 });
    const refused = await handler({ method: "POST", path: `/v1/internal/workspaces/${b.workspaceId}/operations/${b.id}/events`, headers: { [CAPABILITY_HEADER]: foreign }, body: JSON.stringify({ events: [{ type: "usage", timestamp: NOW.toISOString(), payload: telemetry(1) }] }) });
    expect(refused.statusCode).toBe(404);
    expect(await store.get(operationKey(B, b.workspaceId, b.id))).toMatchObject({ status: "RUNNING" });
    expect(queued).toHaveLength(1);
    expect(costPartition(A, "t")).not.toEqual(costPartition(B, "t"));
  });
});

it("refuses unattended staged starts too and gates task.round against its own company's cap", async () => {
  const w = setup();
  const admission = createHostedAdmission({ settings: SETTINGS, store: w.store, ledger: w.ledger, now: () => NOW, runStopWired: false });
  const request = { companyId: A, idempotencyKey: "unattended", action: "automation.run" };
  expect(await admission.stage(request)).toEqual({ decision: { allowed: false, code: "run_stop_not_wired", message: RUN_STOP_NOT_WIRED }, items: [] });
  const task = randomUUID();
  await w.book(A, task, 5_000_000);
  expect(await admission.admit({ companyId: A, action: "task.round", idempotencyKey: "round-a", subject: { type: "task", id: task } })).toMatchObject({ allowed: false, code: "task_cap" });
  expect(await admission.admit({ companyId: B, action: "task.round", idempotencyKey: "round-b", subject: { type: "task", id: task } })).toMatchObject({ allowed: true });
});
