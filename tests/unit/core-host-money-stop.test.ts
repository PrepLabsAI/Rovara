// Lane core-money-stop, the deployed side (core-host/hosted-modules.ts, core/cost/holds.ts, aws/core-engine-root.ts `coreMoneyWiring`, services/callbacks.ts): where a run stands
// against the task's and the day's caps, the run stopped as its usage is booked, a lost run counted at the gateway actual figure, and unattended work refused until the
// per-run stop is wired. Two companies throughout: nothing one does reads or moves the other's money.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type MeterEntry, type OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyDayKey, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { holdKey } from "../../packages/broker/src/core/cost/holds.js";
import {
  COMPANY_DAY_CAP_REACHED, CORE_OUTBOX_STREAM_RELAY_VARIABLE, RUN_STOP_NOT_WIRED, SPEND_UNKNOWN, TASK_CAP_REACHED, createHostedAdmission, createHostedLedger, createHostedMoneyStop, hostedSecurityModules,
  runSpendState, runStopWiredFrom, runsOwed, unflushedEntryId, unreportedSettleEntryId, type HostedAdmissionSettings,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { buildCoreRegistry, coreAdapter } from "../../packages/broker/src/core-host/registry.js";
import { coreMoneyWiring } from "../../packages/broker/src/aws/core-engine-root.js";
import { CallbackCapabilities } from "../../packages/broker/src/callbacks.js";
import { CAPABILITY_HEADER, createCallbackHandler } from "../../packages/broker/src/services/callbacks.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { CHECKPOINT_ENTRY_PREFIX, EMPTY_REPORT_CHARGE_MICROS } from "../../packages/broker/src/core-host/usage-booking.js";
import { RUN_START_ACTION, type MoneyStop } from "../../packages/broker/src/core/task-flow/money-stop.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import type { OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const B = COMPANY_B_ID as OrgId;
const DAY = "2026-11-15";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const SETTINGS: HostedAdmissionSettings = { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };

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
    // The laptop's implicit company: refused before anything is read (a deployed company has its own id).
    expect((await w.admission.admit({ companyId: IMPLICIT_COMPANY_ID, idempotencyKey: "r3", action: RUN_START_ACTION, subject: { type: "task", id: task } })).allowed).toBe(false);
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
      const modules = hostedSecurityModules({ env: {}, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined }, ...(runStopWired === undefined ? {} : { runStopWired }) });
      const registry = await buildCoreRegistry({ modules: [coreAdapter({ point: "storage", name: "memory", owner: "test", create: () => new MemoryDocumentStore() }), ...modules], context: { installCompanyId: IMPLICIT_COMPANY_ID, now: () => NOW, env: {}, clients: {}, log: () => undefined }, areas: [] });
      expect(registry.require("admission").enforcesCost).toBe(runStopWired === true);
    }
  });
});

describe("a stopped run's usage that never arrived: counted at the gateway's actual figure, never the whole hold (LOST-RUN-ACTUAL-SPEND)", () => {
  const entryOf = (w: ReturnType<typeof setup>, task: string, id: string) => w.store.get({ pk: costPartition(A, task), sk: `ENTRY#${id}` });
  const stopOf = (w: ReturnType<typeof setup>, extra: Partial<Parameters<typeof createHostedMoneyStop>[0]> = {}) => createHostedMoneyStop({ store: w.store, companyId: A, settings: SETTINGS, now: () => NOW, ...extra });

  it("settleFromGateway books only the actual not already in the worker's bookings, draws the hold, gives the rest back, once", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    const operationId = randomUUID();
    // The worker's checkpoint for the run ($1.50) is booked; the gateway says the run cost $2.25: only $0.75 is added, never the whole $2.25 again.
    await w.ledger.recordUsage({ companyId: A, entryId: `${CHECKPOINT_ENTRY_PREFIX}:${operationId}:abc`, at: NOW.toISOString(), taskId: task, usage: { provider: "anthropic", modelId: "m", tokens: { input: 1_500_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    const stop = stopOf(w);
    await stop.settleFromGateway!(hold, { operationId, taskId: task }, { actualMicros: 2_250_000, final: true });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(2_250_000);
    expect(await entryOf(w, task, `usage:${operationId}:settled`)).toMatchObject({ modelId: "gateway-actual", micros: 750_000 });
    // The hold is given back: what the bookings drew is on the day once, the rest (the hold's $6 less $2.25... the task cap is $5, so the hold was $5) is released, never kept as spent.
    expect(await w.store.get(holdKey(A, hold))).toMatchObject({ state: "released", keptMicros: 0, drawnMicros: 2_250_000 });
    expect(await w.store.get(companyDayKey(A, DAY))).toMatchObject({ usdMicros: 2_250_000, reservedMicros: 0, loadMicros: 2_250_000 });
    // Told again: nothing more.
    await stop.settleFromGateway!(hold, { operationId, taskId: task }, { actualMicros: 9_000_000, final: true });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(2_250_000);
  });

  it("a worker figure above the gateway's stays (over-counting is the safe side); a gateway record of nothing adds nothing and is never $0 by itself", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    const operationId = randomUUID();
    await w.ledger.recordUsage({ companyId: A, entryId: `usage:${operationId}:early`, at: NOW.toISOString(), taskId: task, usage: { provider: "anthropic", modelId: "m", tokens: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    await stopOf(w).settleFromGateway!(hold, { operationId, taskId: task }, { actualMicros: 500_000, final: true });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(2_000_000);
    const other = randomUUID();
    await stopOf(w).settleFromGateway!(hold, { operationId: other, taskId: task }, { actualMicros: 0, final: true });
    expect(await entryOf(w, task, `usage:${other}:settled`)).toMatchObject({ micros: 0 });
  });

  it("a gateway figure that is not final is booked as an estimate (marked), a final one is not", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    const provisional = randomUUID();
    await stopOf(w).settleFromGateway!(hold, { operationId: provisional, taskId: task }, { actualMicros: 1_000_000, final: false });
    expect(await w.store.get({ pk: costPartition(A, task), sk: "TOTAL" })).toMatchObject({ micros: 1_000_000, provisionalCalls: 1 });
    const task2 = randomUUID();
    const hold2 = await w.start(A, task2);
    await stopOf(w).settleFromGateway!(hold2, { operationId: randomUUID(), taskId: task2 }, { actualMicros: 1_000_000, final: true });
    expect((await w.store.get({ pk: costPartition(A, task2), sk: "TOTAL" }))?.["provisionalCalls"]).toBeUndefined();
  });

  it("another company's hold is never touched by a settlement (the booking is this company's, on this company's task)", async () => {
    const w = setup();
    const task = randomUUID();
    const holdB = await w.start(B, task);
    const dayB = await w.store.get(companyDayKey(B, DAY));
    await stopOf(w).settleFromGateway!(holdB, { operationId: randomUUID(), taskId: task }, { actualMicros: 1_000_000, final: true });
    expect(await w.store.get(companyDayKey(B, DAY))).toEqual(dayB);
    expect(await w.store.get(holdKey(B, holdB))).toMatchObject({ state: "open" });
    for (const id of [undefined, "", "hold:org_x:abc"]) await stopOf(w).settleFromGateway!(id, { operationId: randomUUID(), taskId: task }, { actualMicros: 0, final: true });
    expect((await w.ledger.taskCost(B, task)).micros).toBe(0);
  });

  /** The task's record, its workspace and these runs (the money stop reads a task's runs to find an earlier estimate), the way the engine writes them. */
  const seedRuns = async (w: ReturnType<typeof setup>, task: string, ids: string[], project = "alpha") => {
    const workspaceId = randomUUID();
    await w.store.put({ item: { ...taskKey(task), entityType: "DEVELOPER_TASK", taskId: task, companyId: A, workspaceId, project } });
    await w.store.put({ item: { ...workspaceKey(A, workspaceId), id: workspaceId, companyId: A } });
    for (const id of ids) await w.store.put({ item: { ...operationKey(A, workspaceId, id), entityType: "OPERATION", id, workspaceId, companyId: A, kind: "task", status: "INTERRUPTED", fence: 1, eventSequence: 0, usageUnflushed: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() } });
  };

  it("keepHoldAsEstimate counts the hold's room only, for the first run, and brings the task to its cap for a second (two runs at most)", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    await w.book(A, task, 1_500_000);
    const first = randomUUID();
    await seedRuns(w, task, [first]);
    const stop = stopOf(w);
    await stop.keepHoldAsEstimate!(hold, { operationId: first, taskId: task });
    // The hold's $3.50 room, nothing topped up; the figure is $5 only because the hold was $5 and untouched room is what admission judged enough.
    expect(await entryOf(w, task, unreportedSettleEntryId(first))).toMatchObject({ micros: 3_500_000, chargeStatus: "estimated", provider: "rovara-unflushed-estimate" });
    expect(await w.store.get(holdKey(A, hold))).toMatchObject({ state: "released" });
    // No room left (no hold of its own): the first unknown run books a marked $0, the second brings the task to its cap, the third adds nothing (two runs at most).
    const w2 = setup();
    const t2 = randomUUID();
    await w2.book(A, t2, 1_000_000);
    const [firstUnknown, second, third] = [randomUUID(), randomUUID(), randomUUID()];
    await seedRuns(w2, t2, [firstUnknown, second, third]);
    const stop2 = stopOf(w2);
    await stop2.keepHoldAsEstimate!(undefined, { operationId: firstUnknown, taskId: t2 });
    expect(await entryOf(w2, t2, unreportedSettleEntryId(firstUnknown))).toMatchObject({ micros: 0, chargeStatus: "estimated" });
    expect((await w2.ledger.taskCost(A, t2)).micros).toBe(1_000_000);
    await stop2.keepHoldAsEstimate!(undefined, { operationId: second, taskId: t2 });
    expect((await w2.ledger.taskCost(A, t2)).micros).toBe(5_000_000);
    await stop2.keepHoldAsEstimate!(undefined, { operationId: third, taskId: t2 });
    expect((await w2.ledger.taskCost(A, t2)).micros).toBe(5_000_000);
  });

  it("an estimate whose run is found by the earlier-estimate read stays found however many usage entries the task holds (it reads the runs' two marker ids, never a scan that can run out)", async () => {
    const w = setup();
    const task = randomUUID();
    const [first, second] = [randomUUID(), randomUUID()];
    await seedRuns(w, task, [first, second]);
    const stop = stopOf(w);
    await stop.keepHoldAsEstimate!(undefined, { operationId: first, taskId: task });
    // 2,100 usage entries of other runs: a scan of the task's entries would run past its page bound and refuse.
    for (let index = 0; index < 2_100; index += 1) await w.store.put({ item: { pk: costPartition(A, task), sk: `ENTRY#usage:filler-${String(index).padStart(5, "0")}:x`, entityType: "COST_ENTRY", companyId: A, taskId: task } });
    await w.book(A, task, 1_000_000);
    await stop.keepHoldAsEstimate!(undefined, { operationId: second, taskId: task });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(5_000_000);
  });

  it("the actual and the estimate of one run exclude each other: whichever is booked first is the figure, in either order, and the second books nothing", async () => {
    for (const order of ["actual first", "estimate first"] as const) {
      const w = setup();
      const task = randomUUID();
      const hold = await w.start(A, task);
      const run = randomUUID();
      await seedRuns(w, task, [run]);
      const stop = stopOf(w);
      const actual = () => stop.settleFromGateway!(hold, { operationId: run, taskId: task }, { actualMicros: 700_000, final: true });
      const estimate = () => stop.keepHoldAsEstimate!(hold, { operationId: run, taskId: task });
      if (order === "actual first") { await actual(); await estimate(); } else { await estimate(); await actual(); }
      expect((await w.ledger.taskCost(A, task)).micros, order).toBe(order === "actual first" ? 700_000 : 5_000_000);
      expect((await w.ledger.taskCost(A, task)).entries, order).toBe(1);
    }
    // Both at once: one figure.
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    const run = randomUUID();
    await seedRuns(w, task, [run]);
    const stop = stopOf(w);
    await Promise.allSettled([stop.settleFromGateway!(hold, { operationId: run, taskId: task }, { actualMicros: 700_000, final: true }), stop.keepHoldAsEstimate!(hold, { operationId: run, taskId: task })]);
    expect((await w.ledger.taskCost(A, task)).entries).toBe(1);
  });

  it("the second estimate is bounded by the project's own lower cap, and a cap that cannot be read refuses (fails closed)", async () => {
    const w = setup();
    const task = randomUUID();
    const [one, two, three] = [randomUUID(), randomUUID(), randomUUID()];
    await seedRuns(w, task, [one, two, three]);
    const hold = await w.start(A, task);
    await w.book(A, task, 500_000);
    const stop = stopOf(w, { projectTaskCap: async () => 2_000_000 });
    await stop.keepHoldAsEstimate!(hold, { operationId: one, taskId: task });
    const total = (await w.ledger.taskCost(A, task)).micros;
    await stop.keepHoldAsEstimate!(undefined, { operationId: two, taskId: task });
    expect((await w.ledger.taskCost(A, task)).micros).toBe(Math.max(total, 2_000_000));
    const broken = stopOf(w, { projectTaskCap: async () => { throw new Error("unreadable"); } });
    await expect(broken.keepHoldAsEstimate!(undefined, { operationId: three, taskId: task })).rejects.toThrow();
  });

  it("a task whose runs cannot be read books no estimate (fails closed, never a bound skipped)", async () => {
    const w = setup();
    const task = randomUUID();
    await expect(stopOf(w).keepHoldAsEstimate!(undefined, { operationId: randomUUID(), taskId: task })).rejects.toThrow();
    expect((await w.ledger.taskCost(A, task)).micros).toBe(0);
  });

  it("a close's plan keeps the hold as spent and tops nothing up; its run is booked UNKNOWN (awaiting usage, no dollar figure), never a marked $0, and the run still owes its settlement", async () => {
    const w = setup();
    const task = randomUUID();
    const hold = await w.start(A, task);
    await w.book(A, task, 1_500_000);
    const operationId = randomUUID();
    await seedRuns(w, task, [operationId]);
    const stop = stopOf(w);
    const planned = await stop.planUnflushed!(hold, { operationId, taskId: task });
    expect(planned.plan.restMicros).toBe(0);
    expect(planned.plan.covered).toBe(false);
    await w.store.transact([...planned.items]);
    await stop.applyUnflushed!(planned.plan, { operationId, taskId: task });
    expect(await entryOf(w, task, unflushedEntryId(operationId))).toMatchObject({ chargeStatus: "awaiting_usage" });
    expect(await entryOf(w, task, unflushedEntryId(operationId))).not.toHaveProperty("micros");
    expect(await w.store.get({ pk: costPartition(A, task), sk: "TOTAL" })).toMatchObject({ unpricedEntries: 1 });
    expect(await runsOwed(w.store, A, task), "the unknown marker is no figure: the settler still owes the run its actual").toBe(true);
    // A plan an earlier release stored with a dollar figure books it as it said.
    const old = randomUUID();
    await stop.applyUnflushed!({ schemaVersion: 1, at: NOW.toISOString(), restMicros: 2_000_000, covered: false }, { operationId: old, taskId: task });
    expect(await entryOf(w, task, unflushedEntryId(old))).toMatchObject({ micros: 2_000_000, chargeStatus: "estimated" });
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
    // A lost run is booked by its settlement too (the gateway's actual figure), and by nothing a partial report did.
    const settled = randomUUID();
    await run(settled, { usageUnflushed: true });
    await entry(`usage:${settled}:partial`);
    expect(await runsOwed(store, A, taskId)).toBe(true);
    await entry(`usage:${settled}:settled`);
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
    const modules = hostedSecurityModules({ env: {}, identity: { membershipOf: async () => undefined, displayNameOf: async () => undefined }, runStopWired: true });
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

  it("the callback layer acks the batch and asks the run to stop (CANCEL_REQUESTED, the code, a cancel to its worker); another company's run is never touched", async () => {
    const store = new MemoryDocumentStore();
    const signingKey = Buffer.alloc(32, 7);
    // The broker never reaches a worker: the cancel is staged in the outbox for the dispatcher and relayed at once.
    const queued: Array<{ companyId: string; body: Record<string, unknown> }> = [];
    const relayed: unknown[] = [];
    const delivered: unknown[] = [];
    const stop: MoneyStop = {};
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
      flow: flowFor(A), blobs: {} as never, grants: { exchange: async () => { throw new Error("unused"); }, inspect: () => { throw new Error("unused"); } },
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
