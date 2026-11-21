// Switch-on lane L8: the deployed admission's caps are HELD. A start takes its path's planning allowance on the company's day in the start's own transaction, so concurrent starts see each
// other; booked usage draws the task's own hold down so the day counts it once; settle keeps the actual (all of the hold when unknown, never $0); release gives the rest back; the sweep gives
// back a hold nobody closed. Every money guard here has a mutant (see the lane notes).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AdmissionRequest, MeterEntry, OrgId, TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyDayKey } from "../../packages/broker/src/core/cost/ledger.js";
import { HOLD_SWEEP_MAX, holdKey, readDayLoad, reservationIdOf, sweepExpiredHolds } from "../../packages/broker/src/core/cost/holds.js";
import {
  COMPANY_DAY_CAP_REACHED, RESERVATION_CLOSED, SPEND_UNKNOWN, UNKNOWN_CALL_HOLD_MICROS, createHostedAdmission, createHostedLedger, type HostedAdmissionSettings,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { runAdmissionConformance } from "../support/ports/policy-conformance.js";
import { workspaceKey, operationKey, taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { COMPANY_B_ID as COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const ORG = "org_staging0000000000001" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK_2 = "11111111-2222-4333-8444-555555555555";
const DAY = "2026-11-15";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const SETTINGS: HostedAdmissionSettings = { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };

/** A meter that charges exactly `input` tokens' count in micros (USD), or no price for model `unpriced`. */
const exactMeter = {
  async price() { return null; },
  async record(e: MeterEntry) {
    if (e.usage.modelId === "unpriced") return { cost: null, source: "unknown" as const };
    return { cost: { micros: e.usage.tokens.input, currency: "USD" }, source: "price-table" as const };
  },
};

function setup(settings: HostedAdmissionSettings = SETTINGS, clock = { at: NOW }) {
  const store = new MemoryDocumentStore();
  const now = () => clock.at;
  const ledger = createHostedLedger({ store, metering: exactMeter, now });
  const admission = createHostedAdmission({ settings, store, ledger, now, runStopWired: true });
  const book = (entryId: string, micros: number, overrides: Partial<MeterEntry> = {}) =>
    ledger.recordUsage({ companyId: ORG, entryId, at: clock.at.toISOString(), taskId: TASK, usage: { provider: "anthropic", modelId: "m", tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 } }, ...overrides });
  const day = async (companyId: string = ORG, d = DAY) => store.get(companyDayKey(companyId, d));
  return { store, ledger, admission, book, day, clock };
}

const start = (overrides: Partial<AdmissionRequest> = {}): AdmissionRequest => ({ companyId: ORG, idempotencyKey: `task.start:${TASK}:1`, action: "task.start", subject: { type: "task", id: TASK }, taskStart: { workflow: true, path: "FULL", pathFrom: "request" }, ...overrides });
/** Stages a start and commits its steps (as the task flow's start transaction does), with one row of the caller's own. */
async function startTask(w: ReturnType<typeof setup>, taskId: string, overrides: Partial<AdmissionRequest> = {}) {
  const staged = await w.admission.stage(start({ idempotencyKey: `task.start:${taskId}:1`, subject: { type: "task", id: taskId }, ...overrides }));
  if (!staged.decision.allowed) return { staged, applied: false };
  const committed = await w.store.transact([...staged.items, { kind: "put", item: { pk: `TASK#${taskId}`, sk: "META" }, condition: { op: "notExists", path: ["pk"] } }]);
  return { staged, applied: committed.applied };
}
const reservationOf = (staged: { decision: { allowed: boolean; reservationId?: string } }) => (staged.decision.allowed ? staged.decision.reservationId : undefined);
const dollar = (n: number): AdmissionRequest => ({ companyId: ORG, idempotencyKey: "k", action: "model.call", estimate: { cost: { micros: n * 1_000_000, currency: "USD" } } });

runAdmissionConformance("hosted admission (held day cap, lane L8)", {
  create: async () => setup({ taskCapMicros: 5_000_000, companyDayCapMicros: 5_000_000 }).admission,
  admissible: dollar(1),
  refused: { ...dollar(6), idempotencyKey: "too-much" },
  enforcesCost: true,
  capacity: { request: dollar(1), fits: 5 },
});

describe("a task start holds its path's planning allowance on the company's day", () => {

  it("refuses a key whose hold was already given back or settled: never allowed with nothing held", async () => {
    const w = setup();
    const call = await w.admission.admit({ ...dollar(1), idempotencyKey: "once" });
    await w.admission.release((call as { reservationId: string }).reservationId);
    expect(await w.admission.admit({ ...dollar(1), idempotencyKey: "once" })).toEqual({ allowed: false, code: "reservation_closed", message: RESERVATION_CLOSED });
    expect(await w.admission.stage({ ...dollar(1), idempotencyKey: "once" })).toEqual({ decision: { allowed: false, code: "reservation_closed", message: RESERVATION_CLOSED }, items: [] });
    const settled = await w.admission.admit({ ...dollar(1), idempotencyKey: "twice" });
    await w.admission.settle((settled as { reservationId: string }).reservationId, {});
    expect((await w.admission.admit({ ...dollar(1), idempotencyKey: "twice" })).allowed).toBe(false);
  });
});

describe("booked usage draws the task's own hold down", () => {
  it("counts a booked dollar on the day once: inside the hold it only moves from held to booked; past it, it adds", async () => {
    const w = setup();
    const { staged } = await startTask(w, TASK);
    await w.book("u1", 2_000_000);
    expect(await w.day()).toMatchObject({ usdMicros: 2_000_000, reservedMicros: 3_000_000, loadMicros: 5_000_000 });
    await w.book("u2", 4_000_000);
    expect(await w.day()).toMatchObject({ usdMicros: 6_000_000, reservedMicros: 0, loadMicros: 6_000_000 });
    expect(await w.store.get(holdKey(ORG, reservationOf(staged)!))).toMatchObject({ drawnMicros: 5_000_000, state: "open" });
    // The same usage told again draws nothing more.
    await w.book("u2", 4_000_000);
    expect(await w.day()).toMatchObject({ usdMicros: 6_000_000, loadMicros: 6_000_000 });
    // The close gives back what is left (nothing): the day is what was booked.
    await w.admission.release(reservationOf(staged)!);
    expect(await w.day()).toMatchObject({ usdMicros: 6_000_000, reservedMicros: 0, loadMicros: 6_000_000 });
  });

  it("draws a hold taken yesterday from yesterday's row, and books today's dollars on today's", async () => {
    const clock = { at: new Date("2026-11-14T23:59:00.000Z") };
    const w = setup(SETTINGS, clock);
    await startTask(w, TASK);
    clock.at = NOW;
    await w.book("late", 2_000_000);
    expect(await w.day(ORG, "2026-11-14")).toMatchObject({ reservedMicros: 3_000_000, loadMicros: 3_000_000 });
    expect(await w.day(ORG, DAY)).toMatchObject({ usdMicros: 2_000_000, loadMicros: 2_000_000 });
    expect((await w.day(ORG, DAY))!["reservedMicros"]).toBeUndefined();
  });
});

describe("what the admission holds for other actions", () => {
  it("a model call of unknown cost holds a fixed amount, never nothing; a machine start holds nothing and needs the day at most at its cap (the holds that fill it are its own work's)", async () => {
    const w = setup({ ...SETTINGS, companyDayCapMicros: 2_000_000 });
    const call = await w.admission.admit({ companyId: ORG, idempotencyKey: "ask-1", action: "model.call" });
    expect(call.allowed && call.reservationId).toBeTruthy();
    expect(await w.day()).toMatchObject({ loadMicros: UNKNOWN_CALL_HOLD_MICROS });
    expect(await w.admission.admit({ companyId: ORG, idempotencyKey: "m-1", action: "machine.start", subject: { type: "workspace", id: "w" } })).toEqual({ allowed: true });
    expect(await w.day()).toMatchObject({ loadMicros: UNKNOWN_CALL_HOLD_MICROS });
    await w.admission.admit({ companyId: ORG, idempotencyKey: "ask-2", action: "model.call" });
    // The day is exactly full of holds: the machines of that admitted work still start; one more call does not.
    expect(await w.admission.admit({ companyId: ORG, idempotencyKey: "m-2", action: "machine.start" })).toEqual({ allowed: true });
    expect((await w.admission.admit({ companyId: ORG, idempotencyKey: "ask-3", action: "model.call" })).allowed).toBe(false);
    // Past the cap (booked spend beyond the holds), a machine start is refused, and a gate staged before that does not commit.
    const gate = await w.admission.stage({ companyId: ORG, idempotencyKey: "m-3", action: "machine.start" });
    await w.book("over", 1, { taskId: TASK_2 });
    expect(await w.admission.admit({ companyId: ORG, idempotencyKey: "m-4", action: "machine.start" })).toEqual({ allowed: false, code: "company_day_cap", message: COMPANY_DAY_CAP_REACHED });
    expect((await w.store.transact([...gate.items as TransactItem[], { kind: "put", item: { pk: "X", sk: "Y" } }])).applied).toBe(false);
  });
});

describe("a day the cap cannot read", () => {
  it("refuses a day row without a load, with figures that are not whole numbers, or with a load below its booked dollars", async () => {
    for (const row of [
      { usdMicros: 1, entries: 1, uncountedEntries: 0 },
      { usdMicros: 1, entries: 1, uncountedEntries: 0, loadMicros: "1" },
      { usdMicros: 5, entries: 1, uncountedEntries: 0, loadMicros: 4 },
      { usdMicros: 0, entries: 0, uncountedEntries: 0, loadMicros: 4, reservedMicros: -1 },
      { usdMicros: 0, entries: 0, loadMicros: 4 },
    ]) {
      const w = setup();
      await w.store.put({ item: { ...companyDayKey(ORG, DAY), entityType: "COST_DAY", ...row } });
      expect(await readDayLoad(w.store, ORG, DAY), JSON.stringify(row)).toBe("unknown");
      expect(await w.admission.admit(start()), JSON.stringify(row)).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
      expect(await w.admission.admit({ companyId: ORG, idempotencyKey: "m", action: "machine.start" })).toMatchObject({ allowed: false, code: "spend_unknown" });
    }
  });
});

describe("the hold sweep", () => {

  it("stops at its time and its count, and says there is more", async () => {
    const clock = { at: NOW };
    const w = setup({ ...SETTINGS, companyDayCapMicros: 1_000_000_000 }, clock);
    for (let i = 0; i < HOLD_SWEEP_MAX + 5; i += 1) await w.admission.admit({ ...dollar(1), idempotencyKey: `c${String(i)}` });
    clock.at = new Date(NOW.getTime() + 3 * 3_600_000);
    expect(await sweepExpiredHolds(w.store, ORG, { budgetMs: 0, now: () => clock.at })).toEqual({ released: 0, failed: 0, more: true });
    expect(await sweepExpiredHolds(w.store, ORG, { budgetMs: 60_000, now: () => clock.at })).toEqual({ released: HOLD_SWEEP_MAX, failed: 0, more: true });
    expect(await sweepExpiredHolds(w.store, ORG, { budgetMs: 60_000, now: () => clock.at })).toEqual({ released: 5, failed: 0, more: false });
    expect(await w.day()).toMatchObject({ reservedMicros: 0, loadMicros: 0 });
  });
});

describe("races and edges (lane L8 review)", () => {

  it("two bookings at once draw the hold once: the day counts both usages exactly", async () => {
    const w = setup();
    const { staged } = await startTask(w, TASK);
    // The first booking fixes the task's currency, so the two below race on the hold alone.
    await w.book("first", 1);
    await Promise.all([w.book("a", 3_000_000), w.book("b", 3_000_000)]);
    expect(await w.day()).toMatchObject({ usdMicros: 6_000_001, reservedMicros: 0, loadMicros: 6_000_001 });
    expect(await w.store.get(holdKey(ORG, reservationOf(staged)!))).toMatchObject({ drawnMicros: 5_000_000 });
  });

  it("the sweep leaves an index row that names another company's hold alone, and does not count it", async () => {
    const clock = { at: NOW };
    const w = setup(SETTINGS, clock);
    const foreign = reservationIdOf(COMPANY_B, "k");
    await w.store.put({ item: { pk: `ORG#${ORG}#COST_HOLD_OPEN`, sk: `000000000001#${foreign}`, entityType: "COST_HOLD_OPEN", companyId: ORG, reservationId: foreign, expiresAt: 1 } });
    expect(await sweepExpiredHolds(w.store, ORG, { budgetMs: 10_000, now: () => clock.at })).toEqual({ released: 0, failed: 0, more: false });
    expect((await w.store.query({ pk: `ORG#${ORG}#COST_HOLD_OPEN` })).items).toHaveLength(1);
  });
});

describe("a task's hold is kept while a run of it may have spent unbooked (review H1)", () => {
  const WORKSPACE = "6a1c1d3e-0b6f-4a35-9a3c-1f2e3d4c5b6a";
  async function withRun(w: ReturnType<typeof setup>, status: string, workflowMode = "IMPLEMENT") {
    const opId = randomUUID();
    await w.store.put({ item: { ...workspaceKey(ORG, WORKSPACE), id: WORKSPACE, companyId: ORG } });
    await w.store.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: ORG, workspaceId: WORKSPACE } });
    await w.store.put({ item: { ...operationKey(ORG, WORKSPACE, opId), entityType: "OPERATION", id: opId, workspaceId: WORKSPACE, companyId: ORG, kind: "task", workflowMode, status, fence: 1, eventSequence: 0 } });
    return opId;
  }

  it("keeps the hold when the task's runs cannot be read, or the task names another company", async () => {
    const unreadable = setup();
    const first = await startTask(unreadable, TASK);
    await withRun(unreadable, "SUCCEEDED");
    const query = unreadable.store.query.bind(unreadable.store);
    unreadable.store.query = async (request) => { if (request.pk === workspaceKey(ORG, WORKSPACE).pk) throw new Error("store down"); return await query(request); };
    await unreadable.admission.release(reservationOf(first.staged)!);
    expect(await unreadable.day()).toMatchObject({ reservedMicros: 0, settledMicros: 5_000_000 });
    const other = setup();
    const second = await startTask(other, TASK);
    await other.store.put({ item: { ...taskKey(TASK), entityType: "DEVELOPER_TASK", taskId: TASK, companyId: COMPANY_B, workspaceId: WORKSPACE } });
    await other.admission.release(reservationOf(second.staged)!);
    expect(await other.day()).toMatchObject({ reservedMicros: 0, settledMicros: 5_000_000 });
  });
});
