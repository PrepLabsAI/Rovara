// LOST-RUN-ACTUAL-SPEND (money): Rovara counts only what was actually spent. A run lost before its usage arrived books NOTHING when it is lost; its actual figure is the model gateway's own record of the run's
// calls, read on the next read of the task's spend. Until it is in, the hold stays open and the spend is unreadable (fail closed: never $0, never the hold's whole amount). Real in-memory store, the real
// ledger, the real hosted money stop, the real spend reader and settler; the gateway's answer is a stub. The clock is a variable.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeterEntry, OrgId } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { TASK_HOLD_SECONDS, holdItems, holdKey, reservationIdOf } from "../../packages/broker/src/core/cost/holds.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { GATEWAY_ACTUAL_MODEL_ID, createHostedLedger, createHostedMoneyStop, runsOwed, unflushedEntryId, unreportedSettleEntryId, type HostedAdmissionSettings } from "../../packages/broker/src/core-host/hosted-modules.js";
import { TASK_SPEND_UNKNOWN, createCompanyTaskSpend, type TaskSpendRefusal } from "../../packages/broker/src/core-host/company-task-spend.js";
import { UNREPORTED_SETTLE_GRACE_MS, createUnreportedRunSettler } from "../../packages/broker/src/core-host/unreported-run-settle.js";
import { ACTUAL_FIGURE_WAIT_MS } from "../../packages/broker/src/core-host/lost-run-actual.js";
import { readRunCharges, gatewayRunChargesReader, type GatewayRunChargesReader, type RunCharges } from "../../packages/broker/src/core-host/gateway-run-charges-http.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { endUnflushed } from "../../packages/broker/src/core/task-flow/money-stop.js";
import { retryBlockedStep } from "../../packages/broker/src/core/task-flow/retry.js";
import { stateOf, type StandingFacts } from "../../packages/broker/src/core/task-view/state.js";
import { RUN_LOST_CODE, STATUS_LINES, runLostWords } from "../../packages/contracts/src/task-words.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";
import { signingWorld } from "../support/model-gateway.js";
import { finish, nextJob, taskOf, toDesignPhase, world as taskWorld } from "../support/design-review-flow-world.js";
import { hostedRoundCap } from "../../packages/broker/src/aws/core-engine-root.js";
import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const SETTINGS: HostedAdmissionSettings = { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };
const START = Date.parse("2026-11-25T12:00:00.000Z");
const exactMeter = {
  async price() { return null; },
  async record(entry: MeterEntry) { return { cost: { micros: Math.max(entry.usage.tokens.input, entry.reportedCost?.micros ?? 0), currency: "USD" }, source: "price-table" as const }; },
};
/** The gateway began indexing well before the test runs were created (`addRun` creates a run 3,000 s before START), so a default answer covers them. */
const charges = (over: Partial<RunCharges> = {}): RunCharges => ({ complete: true, actualMicros: 2_250_000, final: true, calls: 3, indexedSinceMs: START - 4_000_000, ...over });

async function world(options: { hold?: number; reader?: GatewayRunChargesReader | undefined; deferEstimate?: boolean } = {}) {
  const clock = { now: START };
  const now = () => new Date(clock.now);
  const store = new MemoryDocumentStore();
  const ledger = createHostedLedger({ store, metering: exactMeter, now });
  const moneyStop = createHostedMoneyStop({ store, companyId: A, settings: SETTINGS, now });
  const taskId = randomUUID(), workspaceId = randomUUID();
  const reservationId = reservationIdOf(A, `task.start:${taskId}`);
  const holdMicros = options.hold ?? 3_000_000;
  const day = new Date(START).toISOString().slice(0, 10);
  if (holdMicros > 0) {
    expect((await store.transact(holdItems({ companyId: A, reservationId, action: "task.start", taskId, day, micros: holdMicros, capMicros: SETTINGS.companyDayCapMicros, nowSeconds: Math.floor(START / 1000), holdSeconds: TASK_HOLD_SECONDS }))).applied).toBe(true);
    await store.put({ item: { pk: costPartition(A, taskId), sk: "TOTAL", entityType: "COST_TOTAL", taskId, companyId: A, micros: 0, entries: 0, unpricedEntries: 0, holdId: reservationId } });
  }
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: A, workspaceId, ...(holdMicros > 0 ? { admissionReservationId: reservationId } : {}) } });
  await store.put({ item: { ...workspaceKey(A, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: A, orgId: A } });
  await store.put({ item: { ...taskPointerKey(A, workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
  const reasons: TaskSpendRefusal[] = [];
  const asked: string[] = [];
  const reader: GatewayRunChargesReader | undefined = options.reader === undefined ? undefined : async (company, task, operation) => { asked.push(`${company}/${task}/${operation}`); return options.reader!(company, task, operation); };
  const settle = createUnreportedRunSettler({ store, companyId: A, moneyStop, now, ...(reader === undefined ? {} : { gatewayCharges: reader }), ...(options.deferEstimate === true ? { deferEstimate: true } : {}) });
  const spend = createCompanyTaskSpend({ store, companyId: A, refused: (reason) => { reasons.push(reason); }, settle: async (id) => { await settle(id); } });
  let n = 0;
  /** A model run that ended `endedAgoMs` ago (past the grace by default), as the run watch leaves a lost one (`usageUnflushed`). */
  const addRun = async (spec: { status?: string; lost?: boolean; endedAgoMs?: number; machine?: boolean } = {}) => {
    n += 1;
    const id = `op-${String(n)}-${randomUUID().slice(0, 8)}`;
    await store.put({ item: {
      ...operationKey(A, workspaceId, id), entityType: "OPERATION", id, workspaceId, companyId: A, kind: "task", workflowMode: "IMPLEMENT", status: spec.status ?? "INTERRUPTED", fence: n,
      ...(spec.machine === false ? {} : { machineId: "machine-1" }), updatedAt: new Date(START - (spec.endedAgoMs ?? UNREPORTED_SETTLE_GRACE_MS * 5)).toISOString(), createdAt: new Date(START - 3_000_000).toISOString(),
      eventSequence: 0, ...(spec.lost === false ? {} : { usageUnflushed: true }),
    } });
    return id;
  };
  const book = (operationId: string, micros: number, label: string, kind: "usage" | "usage-checkpoint" = "usage-checkpoint") =>
    ledger.recordUsage({ companyId: A, entryId: `${kind}:${operationId}:${label}`, at: now().toISOString(), taskId, usage: { provider: "anthropic", modelId: "m", tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  const entry = async (entryId: string) => await store.get({ pk: costPartition(A, taskId), sk: `ENTRY#${entryId}` });
  const total = async () => (await store.get({ pk: costPartition(A, taskId), sk: "TOTAL" }))?.["micros"];
  const read = async () => await spend(taskId).then((value) => value, (error: Error) => error.message);
  return { store, clock, taskId, workspaceId, reservationId, addRun, book, entry, total, read, reasons, asked, ledger, moneyStop, now, hold: () => store.get(holdKey(A, reservationId)) };
}

describe("a lost run is counted at what the gateway says it actually spent", () => {
  it("books only what the worker's checkpoints do not hold, gives the hold back, marks nothing as an estimate, and reads as the exact figure", async () => {
    const w = await world({ hold: 5_000_000, reader: async () => charges({ actualMicros: 2_250_000 }) });
    const id = await w.addRun();
    await w.book(id, 1_500_000, "cp1");
    expect(await w.read()).toBe(2.25);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ modelId: GATEWAY_ACTUAL_MODEL_ID, micros: 750_000 });
    expect(await w.entry(unflushedEntryId(id)), "no estimate is booked for a lost run").toBeUndefined();
    expect(await w.hold()).toMatchObject({ state: "released", keptMicros: 0, drawnMicros: 2_250_000 });
    expect(await runsOwed(w.store, A, w.taskId)).toBe(false);
    expect(w.asked).toEqual([`${A}/${w.taskId}/${id}`]);
    // Read again: nothing more is asked or booked.
    expect(await w.read()).toBe(2.25);
    expect(w.asked).toHaveLength(1);
  });

  it("is never the hold's whole amount: a run that spent $0.40 of a $5 hold counts $0.40 and the task keeps its room (Retry is open)", async () => {
    const w = await world({ hold: 5_000_000, reader: async () => charges({ actualMicros: 400_000, calls: 1 }) });
    await w.addRun();
    expect(await w.read()).toBe(0.4);
  });

  it("a worker figure above the gateway's stays; the gateway never lowers a total (over-counting is the safe side) and never double-books the same calls", async () => {
    const w = await world({ reader: async () => charges({ actualMicros: 500_000 }) });
    const id = await w.addRun();
    await w.book(id, 2_000_000, "cp1");
    expect(await w.read()).toBe(2);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 0 });
  });

  it("the gateway saying the run made no call, complete, books nothing and the task reads as what was booked (the gateway's own record, not a guess)", async () => {
    const w = await world({ reader: async () => charges({ actualMicros: 0, calls: 0 }) });
    await w.addRun();
    await w.book("other-run-ok", 1_000_000, "x", "usage");
    expect(await w.read()).toBe(1);
  });

  it("a worker report that arrives after the run was settled at the gateway's figure is acknowledged, not booked (the same calls are never counted twice)", async () => {
    const w = await world({ reader: async () => charges({ actualMicros: 1_000_000 }) });
    const id = await w.addRun();
    expect(await w.read()).toBe(1);
    const booking = createUsageBooking({ store: w.store, metering: exactMeter, now: w.now });
    const operation = { id, workspaceId: w.workspaceId, companyId: A };
    const late = { type: "usage", timestamp: new Date(START).toISOString(), payload: { schemaVersion: 1, outcome: "SUCCEEDED", provider: "anthropic", modelId: "m", cacheRetention: "short", tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 }, cacheReadRatio: 0, costUsd: null, final: true } };
    expect(await booking.bookOperationEvents(operation as never, [late as never])).toEqual({ booked: 0, unreadable: 0 });
    expect(await w.total()).toBe(1_000_000);
  });
});

describe("a task closed with a lost run (S1: unknown, not a marked $0) is reconciled by the settler", () => {
  it("the close's unknown marker leaves the run owing; the settler books the gateway's actual under the run's settlement id when the figure arrives", async () => {
    const w = await world({ reader: async () => charges({ actualMicros: 1_200_000 }) });
    const id = await w.addRun();
    await w.moneyStop.applyUnflushed!({ schemaVersion: 1, at: new Date(START).toISOString(), restMicros: 0, covered: false }, { operationId: id, taskId: w.taskId });
    expect(await w.entry(unflushedEntryId(id))).toMatchObject({ chargeStatus: "awaiting_usage" });
    expect(await runsOwed(w.store, A, w.taskId)).toBe(true);
    await w.read();
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ modelId: GATEWAY_ACTUAL_MODEL_ID, micros: 1_200_000 });
  });
});

describe("until the actual figure is in: the hold stays, nothing is booked, the spend is unreadable (never $0, never the whole hold)", () => {
  it.each([
    ["the gateway cannot be reached", async () => undefined],
    ["the read throws", async () => { throw new Error("boom"); }],
    ["a call of the run is still open at the gateway (not complete)", async () => charges({ complete: false })],
    ["every call is settled but one is still the gateway's own estimate (not final)", async () => charges({ final: false })],
  ])("%s: unreadable now, the hold open, no entry for the run", async (_label, reader) => {
    const w = await world({ hold: 3_000_000, reader });
    const id = await w.addRun();
    expect(await w.read()).toBe(TASK_SPEND_UNKNOWN);
    expect(w.reasons).toEqual(["run_unreported"]);
    expect(await w.hold()).toMatchObject({ state: "open" });
    expect(await w.entry(unreportedSettleEntryId(id))).toBeUndefined();
    expect(await w.entry(unflushedEntryId(id))).toBeUndefined();
    expect(await w.total()).toBe(0);
  });

  it("a gateway that answers later settles it on the next read, no matter how often it failed before", async () => {
    let up = false;
    const w = await world({ reader: async () => up ? charges({ actualMicros: 600_000 }) : undefined });
    await w.addRun();
    expect(await w.read()).toBe(TASK_SPEND_UNKNOWN);
    expect(await w.read()).toBe(TASK_SPEND_UNKNOWN);
    up = true;
    expect(await w.read()).toBe(0.6);
  });

  it("within the grace nothing is asked or settled (a late report may still come)", async () => {
    const w = await world({ reader: async () => charges() });
    await w.addRun({ endedAgoMs: UNREPORTED_SETTLE_GRACE_MS - 1_000 });
    expect(await w.read()).toBe(TASK_SPEND_UNKNOWN);
    expect(w.asked).toEqual([]);
  });

  it("a figure that is not final is booked as the gateway's own estimate (marked) once the wait is over, and a complete one before", async () => {
    const w = await world({ reader: async () => charges({ final: false, actualMicros: 900_000 }) });
    const id = await w.addRun({ endedAgoMs: ACTUAL_FIGURE_WAIT_MS + 1_000 });
    expect(await w.read()).toBe(0.9);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ modelId: GATEWAY_ACTUAL_MODEL_ID, chargeStatus: "estimated" });
  });
});

describe("when no actual figure can be had", () => {
  it("past the wait the hold's room is counted as a marked estimate, so a task is never stuck for good", async () => {
    const w = await world({ hold: 3_000_000, reader: async () => undefined });
    const id = await w.addRun({ endedAgoMs: ACTUAL_FIGURE_WAIT_MS + 1_000 });
    expect(await w.read()).toBe(3);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 3_000_000, chargeStatus: "estimated" });
    expect(await w.hold()).toMatchObject({ state: "released" });
  });

  it("an install with no gateway to ask (no reader) counts the hold's room at once, exactly as an unreported run always did", async () => {
    const w = await world({ hold: 3_000_000 });
    await w.addRun();
    expect(await w.read()).toBe(3);
  });

  it("a route the gateway does not serve yet (404/501) counts as no gateway at all: the estimate at the grace as before this lane, not an hour's refusal (the route ships first, but a deploy that is ahead of it must not block every lost run)", async () => {
    const w = await world({ hold: 3_000_000, reader: async () => "not_served" });
    const id = await w.addRun();
    expect(await w.read()).toBe(3);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 3_000_000, chargeStatus: "estimated" });
    expect(w.asked).toHaveLength(1);
  });

  it("a run created BEFORE the gateway began indexing by run is unknown, never a final sum (indexedSince); after it, it settles; an answer with NO indexedSince does not read, so it is unknown too", async () => {
    const created = START - 3_000_000;
    const before = await world({ reader: async () => charges({ indexedSinceMs: created + 1_000 }) });
    const early = await before.addRun();
    expect(await before.read()).toBe(TASK_SPEND_UNKNOWN);
    expect(await before.entry(unreportedSettleEntryId(early))).toBeUndefined();
    expect(await before.hold()).toMatchObject({ state: "open" });
    const after = await world({ reader: async () => charges({ actualMicros: 800_000, indexedSinceMs: created - 1_000 }) });
    await after.addRun();
    expect(await after.read()).toBe(0.8);
    // An answer with no indexedSince does not read (the real reader answers undefined for it): unknown, the hold stays, nothing is booked.
    const unsaid = await world({ reader: async () => readRunCharges({ version: 1, operationId: "x", seen: true, complete: true, receipts: [] }, { companyId: A, taskId: "t", operationId: "x" }) });
    const unsaidRun = await unsaid.addRun();
    expect(await unsaid.read()).toBe(TASK_SPEND_UNKNOWN);
    expect(await unsaid.entry(unreportedSettleEntryId(unsaidRun))).toBeUndefined();
    expect(await unsaid.hold()).toMatchObject({ state: "open" });
    // Past the wait an unknown run is counted as the hold's room, as any run with no answer.
    const waited = await world({ hold: 3_000_000, reader: async () => charges({ indexedSinceMs: created + 1_000 }) });
    const old = await waited.addRun({ endedAgoMs: ACTUAL_FIGURE_WAIT_MS + 1_000 });
    expect(await waited.read()).toBe(3);
    expect(await waited.entry(unreportedSettleEntryId(old))).toMatchObject({ modelId: "hold-estimate" });
  });

  it("a gateway that answers but has not seen the run, or says nothing, is NOT a not-served route: unreadable until the wait is over", async () => {
    const w = await world({ reader: async () => undefined });
    await w.addRun();
    expect(await w.read()).toBe(TASK_SPEND_UNKNOWN);
  });

  it("a process that cannot read the gateway but has a broker that can (the dispatcher) NEVER estimates, at any age; a run that never reached a machine is still a proven nothing", async () => {
    const w = await world({ deferEstimate: true });
    const lost = await w.addRun();
    const never = await w.addRun({ machine: false, lost: false, status: "SUCCEEDED" });
    expect(await w.read()).toBe(TASK_SPEND_UNKNOWN);
    expect(await w.entry(unreportedSettleEntryId(never))).toMatchObject({ micros: 0, modelId: "no-call" });
    expect(await w.entry(unreportedSettleEntryId(lost))).toBeUndefined();
    expect(await w.hold()).toMatchObject({ state: "open" });
    w.clock.now += ACTUAL_FIGURE_WAIT_MS + 1_000;
    expect(await w.read(), "past the wait it still books nothing").toBe(TASK_SPEND_UNKNOWN);
    expect(await w.entry(unreportedSettleEntryId(lost))).toBeUndefined();
    expect(await w.hold()).toMatchObject({ state: "open" });
  });

  it("a second unknown run is brought to the cap and a third adds nothing: at most two runs per task are counted without the gateway", async () => {
    const w = await world({ hold: 0 });
    const first = await w.addRun();
    await w.book("seed", 1_000_000, "x", "usage");
    expect(await w.read()).toBe(1);
    expect(await w.entry(unreportedSettleEntryId(first))).toMatchObject({ micros: 0 });
    await w.addRun();
    expect(await w.read()).toBe(5);
    await w.addRun();
    expect(await w.read()).toBe(5);
  });
});

describe("a Stop or a close of a run no longer books the hold (the old estimate to min($6, cap) is gone)", () => {
  it("endUnflushed only marks the run; the task total and the hold are untouched", async () => {
    const w = await world({ hold: 5_000_000 });
    const id = await w.addRun({ status: "CANCELLED", lost: false });
    const deps = { store: w.store, companyId: A, moneyStop: w.moneyStop, log: undefined } as never;
    await endUnflushed(deps, (await w.store.get(operationKey(A, w.workspaceId, id)))! as never);
    expect(await w.store.get(operationKey(A, w.workspaceId, id))).toMatchObject({ usageUnflushed: true });
    expect(await w.total()).toBe(0);
    expect(await w.hold()).toMatchObject({ state: "open" });
    expect(await w.entry(unflushedEntryId(id))).toBeUndefined();
  });
});

describe("the gateway's record of a run", () => {
  const ids = { companyId: "org_aaaaaaaaaaaaaaaaaaaa", taskId: "task-1", operationId: "op-1" };
  const receipt = (over: Record<string, unknown> = {}) => chargeReceipt({ ...ids, ...over });
  const body = (receipts: unknown[], over: Record<string, unknown> = {}) => ({ version: 1, operationId: ids.operationId, seen: true, complete: true, indexedSince: "2026-11-25T11:00:00.000Z", receipts, ...over });
  const available = (value: number) => ({ state: "available", value });

  it("sums the receipts' own amounts, final only when every receipt is final, ignores unknown top-level fields", () => {
    const a = receipt({ callId: "c1", amountMicros: available(80), status: "final", reason: "rated_usage", usageComplete: true, usage: { state: "available", value: { input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0 } }, price: { state: "available", value: { authority: "gateway", version: "v", hash: "h", fetchedAt: "2026-11-09T10:00:00.000Z" } } });
    const read = readRunCharges(body([a], { extra: "ignored" }), ids);
    expect(read).toMatchObject({ complete: true, calls: 1 });
    expect(read?.actualMicros).toBe(80);
    expect(readRunCharges(body([]), ids)).toEqual({ complete: true, actualMicros: 0, final: true, calls: 0, indexedSinceMs: Date.parse("2026-11-25T11:00:00.000Z") });
    expect(readRunCharges(body([], { indexedSince: "2026-11-25T12:00:00.000Z" }), ids)?.indexedSinceMs).toBe(Date.parse("2026-11-25T12:00:00.000Z"));
    expect(readRunCharges({ ...body([]), indexedSince: undefined }, ids), "no indexedSince: the read does not read").toBeUndefined();
    expect(readRunCharges(body([], { seen: false }), ids), "an empty record of a run the gateway never saw is unknown, not a final $0").toBeUndefined();
    expect(readRunCharges(body([], { complete: false }), ids)?.complete).toBe(false);
  });

  it.each([
    ["another run", (r: unknown) => body([r], { operationId: "op-2" })],
    ["a receipt of another task", (r: unknown) => body([{ ...(r as object), taskId: "task-2" }])],
    ["a receipt of another company", (r: unknown) => body([{ ...(r as object), companyId: "org_bbbbbbbbbbbbbbbbbbbb" }])],
    ["a receipt of another run", (r: unknown) => body([{ ...(r as object), operationId: "op-2" }])],
    ["a receipt with no amount", (r: unknown) => body([{ ...(r as object), amountMicros: { state: "unavailable", reason: "not_measured" } }])],
    ["a receipt that does not parse", () => body([{ nope: true }])],
    ["no complete flag", (r: unknown) => ({ version: 1, operationId: ids.operationId, seen: true, receipts: [r] })],
    ["no seen flag (the route must say whether the gateway ever saw the run)", (r: unknown) => ({ version: 1, operationId: ids.operationId, complete: true, receipts: [r] })],
    ["a run the gateway has not seen, with receipts or without (unknown, never a final $0)", (r: unknown) => body([r], { seen: false })],
    ["another version", (r: unknown) => body([r], { version: 2 })],
    ["too many receipts", (r: unknown) => body(Array.from({ length: 501 }, () => r))],
    ["no indexedSince (the run could have spent before the index began)", (r: unknown) => ({ version: 1, operationId: ids.operationId, seen: true, complete: true, receipts: [r] })],
    ["an indexedSince that is not a time", (r: unknown) => body([r], { indexedSince: "yesterday" })],
    ["not an object", () => []],
  ])("a whole read is refused for %s (a figure is never taken from part of a record)", (_label, make) => {
    expect(readRunCharges(make(receipt()), ids)).toBeUndefined();
  });

  it("the reader asks the run's route with the service token, answers undefined for anything but a good 200, and never throws", async () => {
    const signing = signingWorld();
    const urls: string[] = [];
    let answer: () => Response = () => Response.json(body([]));
    const read = gatewayRunChargesReader({ gatewayUrl: "https://gateway.example", signing: () => ({ signer: signing.signer, issuer: "https://install.example/v1/auth" }), fetch: (async (url: string, init: RequestInit) => {
      urls.push(url);
      expect(init.method).toBe("GET");
      expect((init.headers as Record<string, string>)["authorization"]).toMatch(/^Bearer /u);
      return answer();
    }) as never });
    expect(await read(ids.companyId, ids.taskId, ids.operationId)).toEqual({ complete: true, actualMicros: 0, final: true, calls: 0, indexedSinceMs: Date.parse("2026-11-25T11:00:00.000Z") });
    expect(urls).toEqual([`https://gateway.example/v1/service/companies/${ids.companyId}/runs/op-1/charges?task=task-1`]);
    answer = () => new Response("nope", { status: 404 });
    expect(await read(ids.companyId, ids.taskId, ids.operationId), "the route does not know the run / is not served").toBe("not_served");
    answer = () => new Response("nope", { status: 501 });
    expect(await read(ids.companyId, ids.taskId, ids.operationId)).toBe("not_served");
    answer = () => new Response("nope", { status: 500 });
    expect(await read(ids.companyId, ids.taskId, ids.operationId), "a failure is no answer, not a not-served route").toBeUndefined();
    answer = () => new Response("not json", { status: 200 });
    expect(await read(ids.companyId, ids.taskId, ids.operationId)).toBeUndefined();
    expect(await read("not-a-company", ids.taskId, ids.operationId)).toBeUndefined();
    expect(await read(ids.companyId, "bad id!", ids.operationId)).toBeUndefined();
    expect(await gatewayRunChargesReader({ gatewayUrl: "https://gateway.example", signing: () => undefined })(ids.companyId, ids.taskId, ids.operationId)).toBeUndefined();
  });
});

describe("Retry reads the same spend figure Approve does (hosted only)", () => {
  async function blocked(setup: (deps: Record<string, unknown>) => void) {
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", "the planning run failed");
    const workflow = (await taskOf(w)).workflow;
    setup(w.h.deps as unknown as Record<string, unknown>);
    return { w, revision: workflow.revision };
  }
  const hosted = (spent: () => Promise<number | undefined>, cap = 5) => (deps: Record<string, unknown>) => { deps["moneyStop"] = {}; deps["taskSpendUsd"] = spent; deps["taskCapUsd"] = async () => cap; };

  it("an unreadable spend refuses (never read as nothing spent); a spent cap refuses with its words; room under the cap lets it through", async () => {
    const refusalOf = async (state: Awaited<ReturnType<typeof blocked>>): Promise<Error> => await retryBlockedStep(state.w.h.deps, state.w.taskId, state.revision).then(() => new Error("not refused"), (error: unknown) => error as Error);
    const unreadable = await refusalOf(await blocked(hosted(async () => { throw new Error(TASK_SPEND_UNKNOWN); })));
    expect(unreadable).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(unreadable.message).toMatch(/could not read this task's spend/iu);
    const spent = await refusalOf(await blocked(hosted(async () => 5)));
    expect(spent).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(spent.message).toMatch(/run limit/iu);
    const roomy = await blocked(hosted(async () => 0.4));
    await retryBlockedStep(roomy.w.h.deps, roomy.w.taskId, roomy.revision);
    expect((await nextJob(roomy.w)).operation.workflowMode).toBeDefined();
  });

  it("the owner's rounds (send back, continue, reviews) read the flow's own spend figure when it is given, the ledger total only when it is not", async () => {
    const store = new MemoryDocumentStore();
    const taskId = randomUUID();
    await store.put({ item: { pk: costPartition(A, taskId), sk: "TOTAL", entityType: "COST_TOTAL", taskId, companyId: A, currency: "USD", micros: 1_000_000, entries: 1, unpricedEntries: 0 } });
    const registry = { require: ((point: string) => (point === "storage" ? store : exactMeter)) as never };
    const task = { companyId: A, taskId, project: "alpha" };
    const settings = { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };
    expect(await hostedRoundCap(registry, A, () => new Date(START), settings, undefined, task)).toEqual({ limitUsd: 5, spentUsd: 1 });
    expect(await hostedRoundCap(registry, A, () => new Date(START), settings, undefined, task, async () => 4.5), "the figure Approve reads, not the ledger's").toEqual({ limitUsd: 5, spentUsd: 4.5 });
    await expect(hostedRoundCap(registry, A, () => new Date(START), settings, undefined, task, async () => { throw new Error(TASK_SPEND_UNKNOWN); })).rejects.toThrow();
  });

  it("without a money stop (the laptop) Retry reads no spend, as before", async () => {
    const laptop = await blocked((deps) => { deps["taskSpendUsd"] = async () => { throw new Error("must not be read"); }; deps["taskCapUsd"] = async () => 5; });
    await retryBlockedStep(laptop.w.h.deps, laptop.w.taskId, laptop.revision);
  });
});

describe("what the person is told about a lost run", () => {
  const base: StandingFacts = { workflow: undefined, closed: false, budgetPaused: false, failedPrepare: false, needsPerson: true, planRevisionsUsed: 0, failedChecks: false };
  it("a stable code and words from the one table; a lost, blocked step says so and offers Retry, never a spending limit", async () => {
    expect(RUN_LOST_CODE).toBe("run_lost");
    expect(runLostWords()).toBe("The run was lost, through no fault of yours. Choose Retry to run it again.");
    const w = await taskWorld();
    await toDesignPhase(w);
    const job = await nextJob(w);
    await finish(w, job.operation, undefined, "FAILED", "the planning run failed");
    const workflow = (await taskOf(w)).workflow;
    const lost = stateOf({ ...base, workflow, runLost: true });
    expect(lost.status).toMatchObject({ state: "needs_you", ...STATUS_LINES.runLost });
    expect(stateOf({ ...base, workflow }).status.reason).not.toBe(STATUS_LINES.runLost.reason);
    // A step that stopped for money keeps its own words even when the last run was lost.
    expect(JSON.stringify(stateOf({ ...base, workflow, runLost: true, budgetPaused: true }).status)).not.toContain("lost");
  });
});
