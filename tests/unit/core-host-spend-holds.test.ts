// Switch-on lane L8: the deployed admission's caps are HELD. A start takes its path's planning allowance on the company's day in the start's own transaction, so concurrent starts see each
// other; booked usage draws the task's own hold down so the day counts it once; settle keeps the actual (all of the hold when unknown, never $0); release gives the rest back; the sweep gives
// back a hold nobody closed. Every money guard here has a mutant (see the lane notes).
import { describe, expect, it } from "vitest";
import type { AdmissionRequest, MeterEntry, OrgId, TransactItem } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { companyDayKey, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { HOLD_SWEEP_MAX, companyOfReservation, holdKey, readDayLoad, reservationIdOf, sweepExpiredHolds } from "../../packages/broker/src/core/cost/holds.js";
import {
  COMPANY_DAY_CAP_REACHED, SPEND_UNKNOWN, UNKNOWN_CALL_HOLD_MICROS, createHostedAdmission, createHostedHoldSweep, createHostedLedger, type HostedAdmissionSettings,
} from "../../packages/broker/src/core-host/hosted-modules.js";
import { runAdmissionConformance } from "../support/ports/policy-conformance.js";
import { COMPANY_A_ID as COMPANY_A, COMPANY_B_ID as COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const ORG = "org_staging0000000000001" as OrgId;
const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const TASK_2 = "11111111-2222-4333-8444-555555555555";
const DAY = "2026-11-15";
const NOW = new Date(`${DAY}T10:00:00.000Z`);
const SETTINGS: HostedAdmissionSettings = { allowedCompanies: "all", taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };

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
  const admission = createHostedAdmission({ settings, store, ledger, now });
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
  create: async () => setup({ allowedCompanies: [ORG], taskCapMicros: 5_000_000, companyDayCapMicros: 5_000_000 }).admission,
  admissible: dollar(1),
  refused: { ...dollar(6), idempotencyKey: "too-much" },
  enforcesCost: true,
  capacity: { request: dollar(1), fits: 5 },
});

describe("a task start holds its path's planning allowance on the company's day", () => {
  it("holds the full path's allowance (never more than the task cap) and the Quick path's smaller one, in the start's own transaction", async () => {
    const w = setup();
    const full = await startTask(w, TASK);
    expect(full.applied).toBe(true);
    expect(full.staged.items.map((item) => item.kind)).toEqual(["put", "put", "update", "update"]);
    expect(await w.day()).toMatchObject({ reservedMicros: 5_000_000, loadMicros: 5_000_000, usdMicros: 0, uncountedEntries: 0 });
    // The task's total names its hold: the task's usage draws it down.
    expect(await w.store.get({ pk: costPartition(ORG, TASK), sk: "TOTAL" })).toMatchObject({ holdId: reservationOf(full.staged), micros: 0, unpricedEntries: 0 });
    const quick = await startTask(w, TASK_2, { taskStart: { workflow: true, path: "QUICK", pathFrom: "request" } });
    expect(quick.applied).toBe(true);
    expect(await w.day()).toMatchObject({ reservedMicros: 7_000_000, loadMicros: 7_000_000 });
  });

  it("holds the full allowance when Understand chooses the path, or the task runs no workflow", async () => {
    for (const taskStart of [{ workflow: true, pathFrom: "understand" as const }, { workflow: false }, undefined] as const) {
      const w = setup();
      expect((await startTask(w, TASK, taskStart === undefined ? {} : { taskStart })).applied).toBe(true);
      expect(await w.day()).toMatchObject({ reservedMicros: 5_000_000 });
    }
  });

  it("lets concurrent starts see each other: the day holds five full starts and refuses the sixth", async () => {
    const w = setup();
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${String(i)}`);
    // All six are staged before any commits (the race): the day's condition lets five commit.
    const staged = await Promise.all(ids.map((id) => w.admission.stage(start({ idempotencyKey: `task.start:${id}:1`, subject: { type: "task", id } }))));
    expect(staged.every((s) => s.decision.allowed)).toBe(true);
    const applied = [];
    for (const [i, s] of staged.entries()) applied.push((await w.store.transact([...s.items, { kind: "put", item: { pk: `TASK#${ids[i]!}`, sk: "META" } }])).applied);
    expect(applied.filter(Boolean)).toHaveLength(5);
    expect(await w.day()).toMatchObject({ loadMicros: 25_000_000 });
    expect(await w.admission.admit(start({ idempotencyKey: "late", subject: { type: "task", id: TASK_2 } }))).toEqual({ allowed: false, code: "company_day_cap", message: COMPANY_DAY_CAP_REACHED });
  });

  it("a start whose transaction did not commit holds nothing, and giving its reservation back does nothing", async () => {
    const w = setup();
    const staged = await w.admission.stage(start());
    await w.admission.release(reservationOf(staged)!);
    expect(await w.day()).toBeUndefined();
    expect(await w.store.get(holdKey(ORG, reservationOf(staged)!))).toBeUndefined();
  });

  it("asks again with the same key: the same reservation, held once", async () => {
    const w = setup();
    const first = await startTask(w, TASK);
    const again = await w.admission.stage(start());
    expect(again).toEqual({ decision: { allowed: true, reservationId: reservationOf(first.staged) }, items: [] });
    expect(await w.day()).toMatchObject({ loadMicros: 5_000_000 });
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

  it("a task with no hold of its own, and an unpriced usage, draw nothing", async () => {
    const w = setup();
    await startTask(w, TASK);
    await w.book("other", 1_000_000, { taskId: TASK_2 });
    expect(await w.day()).toMatchObject({ usdMicros: 1_000_000, reservedMicros: 5_000_000, loadMicros: 6_000_000 });
    await w.book("unpriced", 0, { usage: { provider: "x", modelId: "unpriced", tokens: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    expect(await w.day()).toMatchObject({ reservedMicros: 5_000_000, loadMicros: 6_000_000, uncountedEntries: 1 });
    expect(await w.admission.admit(start({ idempotencyKey: "next", subject: { type: "task", id: TASK_2 } }))).toEqual({ allowed: false, code: "spend_unknown", message: SPEND_UNKNOWN });
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

describe("settle and release", () => {
  it("release gives back what the hold still holds, once", async () => {
    const w = setup();
    const { staged } = await startTask(w, TASK);
    await w.book("u", 1_000_000);
    await w.admission.release(reservationOf(staged)!);
    await w.admission.release(reservationOf(staged)!);
    expect(await w.day()).toMatchObject({ usdMicros: 1_000_000, reservedMicros: 0, loadMicros: 1_000_000 });
    expect(await w.store.get(holdKey(ORG, reservationOf(staged)!))).toMatchObject({ state: "released", keptMicros: 0 });
  });

  it("settle keeps the actual dollars the ledger did not book, and all of the hold when the actual is not known in dollars (never $0)", async () => {
    const w = setup();
    const known = await w.admission.admit({ ...dollar(2), idempotencyKey: "known" });
    const unknown = await w.admission.admit({ ...dollar(2), idempotencyKey: "unknown" });
    const tokensOnly = await w.admission.admit({ ...dollar(2), idempotencyKey: "tokens" });
    const euro = await w.admission.admit({ ...dollar(2), idempotencyKey: "euro" });
    expect(await w.day()).toMatchObject({ loadMicros: 8_000_000 });
    await w.admission.settle((known as { reservationId: string }).reservationId, { cost: { micros: 500_000, currency: "USD" } });
    expect(await w.day()).toMatchObject({ loadMicros: 6_500_000, reservedMicros: 6_000_000, settledMicros: 500_000 });
    await w.admission.settle((unknown as { reservationId: string }).reservationId, {});
    await w.admission.settle((tokensOnly as { reservationId: string }).reservationId, { tokens: 10 });
    await w.admission.settle((euro as { reservationId: string }).reservationId, { cost: { micros: 1, currency: "EUR" } });
    expect(await w.day()).toMatchObject({ loadMicros: 6_500_000, reservedMicros: 0, settledMicros: 6_500_000 });
    // A settled hold is closed: neither a release nor a second settle frees it.
    await w.admission.release((known as { reservationId: string }).reservationId);
    await w.admission.settle((known as { reservationId: string }).reservationId, { cost: { micros: 0, currency: "USD" } });
    expect(await w.day()).toMatchObject({ loadMicros: 6_500_000 });
  });

  it("settle keeps the actual beyond what the hold covered, less what booked usage already drew", async () => {
    const w = setup();
    const { staged } = await startTask(w, TASK);
    await w.book("u", 1_000_000);
    await w.admission.settle(reservationOf(staged)!, { cost: { micros: 7_000_000, currency: "USD" } });
    expect(await w.day()).toMatchObject({ usdMicros: 1_000_000, reservedMicros: 0, settledMicros: 6_000_000, loadMicros: 7_000_000 });
  });

  it("an id that is not ours, or another shape, does nothing", async () => {
    const w = setup();
    for (const id of ["no-such-reservation", "", `hold:${ORG}:zz`, undefined as unknown as string, `hold:org_bad:${"a".repeat(40)}`]) {
      await w.admission.release(id);
      await w.admission.settle(id, { tokens: 1 });
    }
    expect((await w.store.query({ pk: `ORG#${ORG}#COST_DAY` })).items).toEqual([]);
  });
});

describe("what the admission holds for other actions", () => {
  it("a model call of unknown cost holds a fixed amount, never nothing; a machine start holds nothing and needs the day below its cap", async () => {
    const w = setup({ ...SETTINGS, companyDayCapMicros: 2_000_000 });
    const call = await w.admission.admit({ companyId: ORG, idempotencyKey: "ask-1", action: "model.call" });
    expect(call.allowed && call.reservationId).toBeTruthy();
    expect(await w.day()).toMatchObject({ loadMicros: UNKNOWN_CALL_HOLD_MICROS });
    expect(await w.admission.admit({ companyId: ORG, idempotencyKey: "m-1", action: "machine.start", subject: { type: "workspace", id: "w" } })).toEqual({ allowed: true });
    expect(await w.day()).toMatchObject({ loadMicros: UNKNOWN_CALL_HOLD_MICROS });
    await w.admission.admit({ companyId: ORG, idempotencyKey: "ask-2", action: "model.call" });
    expect(await w.admission.admit({ companyId: ORG, idempotencyKey: "m-2", action: "machine.start" })).toEqual({ allowed: false, code: "company_day_cap", message: COMPANY_DAY_CAP_REACHED });
    expect((await w.admission.admit({ companyId: ORG, idempotencyKey: "ask-3", action: "model.call" })).allowed).toBe(false);
    // A gate's staged check fails once a hold fills the day after it was decided.
    const fresh = setup({ ...SETTINGS, companyDayCapMicros: 2_000_000 });
    const gate = await fresh.admission.stage({ companyId: ORG, idempotencyKey: "m", action: "machine.start" });
    await fresh.admission.admit({ ...dollar(2), idempotencyKey: "fill" });
    expect((await fresh.store.transact([...gate.items as TransactItem[], { kind: "put", item: { pk: "X", sk: "Y" } }])).applied).toBe(false);
  });

  it("the task cap is checked on the task's booked spend, in the same transaction", async () => {
    const w = setup();
    await startTask(w, TASK);
    await w.book("u", 4_500_000);
    expect(await w.admission.admit({ ...dollar(1), idempotencyKey: "r", subject: { type: "task", id: TASK } })).toMatchObject({ allowed: false, code: "task_cap" });
    const ok = await w.admission.stage({ companyId: ORG, idempotencyKey: "r2", action: "model.call", subject: { type: "task", id: TASK }, estimate: { cost: { micros: 500_000, currency: "USD" } } });
    expect(ok.decision.allowed).toBe(true);
    await w.book("u2", 1);
    expect((await w.store.transact(ok.items)).applied).toBe(false);
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
  it("gives back the holds past their time, keeps the others, and drops nothing it cannot read", async () => {
    const clock = { at: NOW };
    const w = setup(SETTINGS, clock);
    const { staged } = await startTask(w, TASK);
    const call = await w.admission.admit({ ...dollar(1), idempotencyKey: "call" });
    const sweep = createHostedHoldSweep({ store: w.store, companyId: ORG, now: () => clock.at });
    expect(await sweep.pass({ budgetMs: 10_000 })).toMatchObject({ released: 0, more: false });
    clock.at = new Date(NOW.getTime() + 3 * 3_600_000);
    // The call's hold (2 hours) is past its time; the task's (24 hours) is not.
    expect(await sweep.pass({ budgetMs: 10_000 })).toMatchObject({ released: 1, more: false });
    expect(await w.store.get(holdKey(ORG, (call as { reservationId: string }).reservationId))).toMatchObject({ state: "released" });
    expect(await w.day()).toMatchObject({ reservedMicros: 5_000_000, loadMicros: 5_000_000 });
    clock.at = new Date(NOW.getTime() + 25 * 3_600_000);
    expect(await sweep.pass({ budgetMs: 10_000 })).toMatchObject({ released: 1 });
    expect(await w.store.get(holdKey(ORG, reservationOf(staged)!))).toMatchObject({ state: "released" });
    expect(await w.day()).toMatchObject({ reservedMicros: 0, loadMicros: 0 });
    expect((await w.store.query({ pk: `ORG#${ORG}#COST_HOLD_OPEN` })).items).toEqual([]);
  });

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

describe("two companies (isolation)", () => {
  it("a company's holds, bookings and sweep never touch another company's day, and a reservation names its own company", async () => {
    const store = new MemoryDocumentStore();
    const clock = { at: NOW };
    const ledger = createHostedLedger({ store, metering: exactMeter, now: () => clock.at });
    const admission = createHostedAdmission({ settings: SETTINGS, store, ledger, now: () => clock.at });
    const a = await admission.stage(start({ companyId: COMPANY_A }));
    const b = await admission.stage(start({ companyId: COMPANY_B }));
    expect(reservationOf(a)).not.toBe(reservationOf(b));
    expect(companyOfReservation(reservationOf(a))).toBe(COMPANY_A);
    await store.transact(a.items);
    await store.transact(b.items);
    await ledger.recordUsage({ companyId: COMPANY_A, entryId: "u", at: NOW.toISOString(), taskId: TASK, usage: { provider: "p", modelId: "m", tokens: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
    expect(await store.get(companyDayKey(COMPANY_A, DAY))).toMatchObject({ usdMicros: 2_000_000, reservedMicros: 3_000_000 });
    // Positive control above; B's day and B's hold are untouched by A's booking.
    expect(await store.get(companyDayKey(COMPANY_B, DAY))).toMatchObject({ usdMicros: 0, reservedMicros: 5_000_000, loadMicros: 5_000_000 });
    expect(await store.get(holdKey(COMPANY_B, reservationOf(b)!))).toMatchObject({ drawnMicros: 0 });
    await admission.release(reservationOf(a)!);
    expect(await store.get(companyDayKey(COMPANY_B, DAY))).toMatchObject({ reservedMicros: 5_000_000 });
    clock.at = new Date(NOW.getTime() + 25 * 3_600_000);
    await sweepExpiredHolds(store, COMPANY_A, { budgetMs: 10_000, now: () => clock.at });
    expect(await store.get(companyDayKey(COMPANY_B, DAY))).toMatchObject({ reservedMicros: 5_000_000 });
    // The same key in two companies is two reservations.
    expect(reservationIdOf(COMPANY_A, "k")).not.toBe(reservationIdOf(COMPANY_B, "k"));
  });
});
