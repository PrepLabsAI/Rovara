// SPEND-UNREPORTED-RUN item 1: an ENDED model run that sent no usage report is settled by the broker, so a task's spend can always be read. Three cases, in this order (the money review decides the rule):
//   (i) the gateway's own record of the run's calls is in the task's ledger: a $0 marker, nothing added, no hold touched;
//   (ii) zero ONLY when the run never reached a machine: a $0 marker;
//   (iii) neither knowable (arch ruling): ONLY the hold's room is booked as a marked estimate (not topped up to a fixed estimate) and the rest released; never left unsettled.
// Real in-memory store, the real ledger, the real hosted money stop, the real spend reader and settler. The clock is a variable: a run is settled only after a short grace.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MeterEntry, OrgId, StoredDocument } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { costPartition, companyDayKey } from "../../packages/broker/src/core/cost/ledger.js";
import { TASK_HOLD_SECONDS, closeHold, holdItems, holdKey, reservationIdOf } from "../../packages/broker/src/core/cost/holds.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createHostedLedger, createHostedMoneyStop, runsOwed, unflushedEntryId, unreportedSettleEntryId, type HostedAdmissionSettings } from "../../packages/broker/src/core-host/hosted-modules.js";
import { TASK_SPEND_UNKNOWN, createCompanyTaskSpend, type TaskSpendRefusal } from "../../packages/broker/src/core-host/company-task-spend.js";
import { UNREPORTED_SETTLE_GRACE_MS, countUnreportedRuns, createUnreportedRunSettler } from "../../packages/broker/src/core-host/unreported-run-settle.js";
import { COMPANY_A_ID, COMPANY_B_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId, B = COMPANY_B_ID as OrgId;
const SETTINGS: HostedAdmissionSettings = { taskCapMicros: 5_000_000, companyDayCapMicros: 25_000_000 };
const START = Date.parse("2026-11-25T12:00:00.000Z");
const exactMeter = {
  async price() { return null; },
  async record(entry: MeterEntry) { return { cost: { micros: Math.max(entry.usage.tokens.input, entry.reportedCost?.micros ?? 0), currency: "USD" }, source: "price-table" as const }; },
};
const ENDED = ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const;

interface RunSpec { status?: string; machine?: boolean; events?: Array<{ type: string; payload?: unknown }>; counted?: number; usageUnflushed?: boolean; receipt?: boolean; endedAgoMs?: number; workflowMode?: string; booked?: number }

async function world(options: { company?: OrgId; hold?: number; withSettle?: boolean } = {}) {
  const company = options.company ?? A;
  const clock = { now: START };
  const now = () => new Date(clock.now);
  const store = new MemoryDocumentStore();
  const ledger = createHostedLedger({ store, metering: exactMeter, now });
  const moneyStop = createHostedMoneyStop({ store, companyId: company, settings: SETTINGS, now });
  const taskId = randomUUID(), workspaceId = randomUUID();
  const reservationId = reservationIdOf(company, `task.start:${taskId}`);
  const holdMicros = options.hold ?? 3_000_000;
  if (holdMicros > 0) {
    const day = new Date(START).toISOString().slice(0, 10);
    expect((await store.transact(holdItems({ companyId: company, reservationId, action: "task.start", taskId, day, micros: holdMicros, capMicros: SETTINGS.companyDayCapMicros, nowSeconds: Math.floor(START / 1000), holdSeconds: TASK_HOLD_SECONDS }))).applied).toBe(true);
  }
  // The start transaction's own TOTAL row: it names the hold the ledger draws from (core-host/hosted-modules.ts, `holdId`).
  if (holdMicros > 0) await store.put({ item: { pk: costPartition(company, taskId), sk: "TOTAL", entityType: "COST_TOTAL", taskId, companyId: company, micros: 0, entries: 0, unpricedEntries: 0, holdId: reservationId } });
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: company, workspaceId, ...(holdMicros > 0 ? { admissionReservationId: reservationId } : {}) } });
  await store.put({ item: { ...workspaceKey(company, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: company, orgId: company } });
  await store.put({ item: { ...taskPointerKey(company, workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
  const reasons: TaskSpendRefusal[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const settle = createUnreportedRunSettler({ store, companyId: company, moneyStop, now, log: (entry) => logs.push(entry) });
  let settleCalls = 0;
  const spend = createCompanyTaskSpend({ store, companyId: company, refused: (reason) => { reasons.push(reason); }, ...(options.withSettle === false ? {} : { settle: async (id) => { settleCalls += 1; await settle(id); } }) });
  let sequence = 0;
  const addRun = async (spec: RunSpec = {}) => {
    sequence += 1;
    const id = `op-${String(sequence)}-${randomUUID().slice(0, 8)}`;
    const events = spec.events ?? [];
    await store.put({ item: {
      ...operationKey(company, workspaceId, id), entityType: "OPERATION", id, workspaceId, companyId: company, kind: "task", workflowMode: spec.workflowMode ?? "PLAN", status: spec.status ?? "FAILED", fence: sequence,
      ...(spec.machine === false ? {} : { machineId: "machine-1" }), updatedAt: new Date(START - (spec.endedAgoMs ?? 600_000)).toISOString(), createdAt: new Date(START - 700_000).toISOString(),
      eventSequence: spec.counted ?? events.length, ...(spec.usageUnflushed === true ? { usageUnflushed: true } : {}),
    } });
    for (const [index, event] of events.entries()) {
      await store.put({ item: { ...operationKey(company, workspaceId, id), sk: `EVENT#${id}#${String(index + 1).padStart(10, "0")}`, entityType: "OPERATION_EVENT", operationId: id, sequence: index + 1, type: event.type, timestamp: new Date(START).toISOString(), payload: event.payload ?? null } as StoredDocument });
    }
    if (spec.receipt === true) await store.put({ item: { pk: costPartition(company, taskId), sk: `ENTRY#usage-charge:${id}:charge-1`, entityType: "COST_ENTRY", companyId: company, taskId } });
    if (spec.booked !== undefined) await book(id, spec.booked, "end");
    return id;
  };
  /** A usage as the worker's report books it (the ledger draws the task's hold). */
  const book = (operationId: string, micros: number, label: string) =>
    ledger.recordUsage({ companyId: company, entryId: `usage:${operationId}:${label}`, at: now().toISOString(), taskId, usage: { provider: "anthropic", modelId: "m", tokens: { input: micros, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  const run = async (id: string) => await store.get(operationKey(company, workspaceId, id));
  const entry = async (entryId: string) => await store.get({ pk: costPartition(company, taskId), sk: `ENTRY#${entryId}` });
  const total = async () => (await store.get({ pk: costPartition(company, taskId), sk: "TOTAL" }))?.["micros"];
  return { store, ledger, clock, taskId, workspaceId, reservationId, spend, settle, addRun, book, run, entry, total, reasons, logs, moneyStop, settleCalls: () => settleCalls, hold: () => store.get(holdKey(company, reservationId)), day: () => store.get(companyDayKey(company, new Date(START).toISOString().slice(0, 10))) };
}

/** The reader's answer, or the refusal. */
const read = async (spend: (taskId: string) => Promise<number>, taskId: string) => await spend(taskId).then((value) => value, (error: Error) => error.message);

describe("no ended run status can leave a task's spend unreadable", () => {
  it.each(ENDED)("a %s run with no usage report: refused with no settle, read after it", async (status) => {
    const without = await world({ withSettle: false });
    await without.addRun({ status });
    expect(await read(without.spend, without.taskId), "no settle wired (the laptop, an old reader): the old refusal").toBe(TASK_SPEND_UNKNOWN);
    expect(without.reasons).toEqual(["run_unreported"]);
    const w = await world();
    const id = await w.addRun({ status });
    // Nothing is knowable (no gateway record, no complete log): case (iii), only the hold's room ($3) booked as a marked estimate.
    expect(await read(w.spend, w.taskId)).toBe(3);
    expect(w.reasons).toEqual([]);
    expect(await w.run(id)).not.toHaveProperty("usageUnflushed");
    expect(await w.hold()).toMatchObject({ state: "released", keptMicros: 0, drawnMicros: 3_000_000 });
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 3_000_000, chargeStatus: "estimated", modelId: "hold-estimate" });
    expect(w.logs.filter((entry) => entry["event"] === "task_flow.unreported_run_settled")).toEqual([{ component: "task-flow", event: "task_flow.unreported_run_settled", case: "estimate", taskId: w.taskId }]);
  });

  // Production read (arch, 2026-11-25): the ended runs that reached a machine and booked nothing were a FAILED UNDERSTAND run and a CANCELLED SETUP_AGENT run. Both modes are model runs here (only CHECKS is not), and a
  // CANCELLED run is no exception: every mode and every ended status is settled and read. The hold sweep (`runsOwed`) then sees the run as booked.
  it.each(["UNDERSTAND", "SETUP_AGENT", "PLAN", "IMPLEMENT", "REVIEW"].flatMap((mode) => ENDED.map((status) => [mode, status] as const)))("a %s run that ended %s with no usage report is settled and read", async (mode, status) => {
    const w = await world();
    await w.addRun({ status, workflowMode: mode });
    expect(await runsOwed(w.store, A, w.taskId), "owed before (the hold sweep never counted a SUCCEEDED run)").toBe(status !== "SUCCEEDED");
    expect(await read(w.spend, w.taskId)).toBe(3);
    expect(await runsOwed(w.store, A, w.taskId), "booked after").toBe(false);
  });

  it("a CHECKS run is no model run: it owes nothing and never blocks a read", async () => {
    const w = await world();
    await w.addRun({ status: "CANCELLED", workflowMode: "CHECKS" });
    await w.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    expect(await read(w.spend, w.taskId)).toBe(1);
    expect(w.settleCalls()).toBe(0);
  });

  // The shape an earlier release left (its lost-run rule kept the whole hold and topped the estimate up): still read, and a hold that cannot be read still refuses (rule 8: stored records read tolerantly).
  it("a lost run an earlier release kept as an estimate (INTERRUPTED, marked unflushed, hold settled estimated, estimate entry booked) is readable, with what its hold kept added; a hold that cannot be read refuses", async () => {
    const legacy = async (w: Awaited<ReturnType<typeof world>>) => {
      const id = await w.addRun({ status: "INTERRUPTED", usageUnflushed: true });
      await closeHold(w.store, w.reservationId, { kind: "settle", actualMicros: undefined, estimated: { operationId: id } }, () => new Date(START));
      await w.ledger.recordUsage({ companyId: A, entryId: unflushedEntryId(id), at: new Date(START).toISOString(), taskId: w.taskId, usage: { provider: "rovara-unflushed-estimate", modelId: "estimate", tokens: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } });
      return id;
    };
    const w = await world();
    await legacy(w);
    expect(await read(w.spend, w.taskId)).toBe(5);
    expect(w.settleCalls(), "nothing owed: no settle").toBe(0);
    const gone = await world();
    await legacy(gone);
    await gone.store.delete({ key: holdKey(A, gone.reservationId) });
    expect(await read(gone.spend, gone.taskId)).toBe(TASK_SPEND_UNKNOWN);
    expect(gone.reasons).toEqual(["unreadable_figures"]);
  });

  it("a run marked unflushed with nothing booked for it (a lost run: nothing is booked when it is lost) is settled by the next read like any ended run: the hold's room, never the whole hold topped up", async () => {
    const w = await world();
    const id = await w.addRun({ status: "INTERRUPTED", usageUnflushed: true });
    expect(await read(w.spend, w.taskId)).toBe(3);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 3_000_000, chargeStatus: "estimated" });
    expect(await w.hold()).toMatchObject({ state: "released" });
  });
});

describe("case (i): the gateway's own record of the run's calls", () => {
  it("the receipts are in the total already; the marker follows the receipts rule (awaiting usage, no dollar figure: nothing proves the record complete), the hold untouched, and the read refuses as unpriced until the gateway finalizes", async () => {
    const w = await world();
    await w.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    const id = await w.addRun({ status: "FAILED", receipt: true });
    const before = await w.day();
    expect(await read(w.spend, w.taskId)).toBe(TASK_SPEND_UNKNOWN);
    expect(w.reasons).toEqual(["unpriced_usage"]);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ provider: "rovara-unreported-settle", modelId: "gateway-record", chargeStatus: "awaiting_usage" });
    expect(await w.entry(unreportedSettleEntryId(id))).not.toHaveProperty("micros");
    expect(await w.run(id)).not.toHaveProperty("usageUnflushed");
    expect(await w.hold()).toMatchObject({ state: "open" });
    expect(await w.day()).toMatchObject({ usdMicros: before!["usdMicros"] });
    expect(w.logs.map((entry) => entry["case"])).toEqual(["gateway_record"]);
  });
});

describe("case (ii): zero only when the run never reached a machine", () => {
  const modelFree = [{ type: "lifecycle", payload: { phase: "started" } }, { type: "progress", payload: { message: "Cloning the repository" } }, { type: "error", payload: { message: "clone failed" } }, { type: "result", payload: {} }];

  it("a run that never reached a machine did no model work: a marker at $0, the figure unchanged, the hold untouched", async () => {
    const w = await world();
    await w.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    const id = await w.addRun({ status: "SUCCEEDED", machine: false });
    expect(await read(w.spend, w.taskId)).toBe(1);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 0, modelId: "no-call" });
    expect(await w.hold()).toMatchObject({ state: "open" });
  });

  it.each([
    ["a log of plain notes only (the shape of a clean no-call run)", modelFree],
    ["a SETUP_AGENT-shaped log: plain notes, a usage event and a result; its Pi events are never logged", [{ type: "lifecycle", payload: { phase: "started" } }, { type: "progress", payload: { message: "Reading the repository" } }, { type: "usage", payload: {} }, { type: "result", payload: {} }]],
    ["a REVIEW-shaped log whose usage batch was refused: nothing after it stored, the row count matching", [{ type: "lifecycle", payload: { phase: "started" } }, { type: "progress", payload: { message: "Reviewing" } }]],
    ["a log with a real Pi event", [...modelFree, { type: "progress", payload: { type: "message_end", message: { role: "assistant" } } }]],
    ["no event at all", []],
  ])("a run on a machine is NOT proved no-call by %s: the estimate", async (_label, events) => {
    const w = await world();
    await w.addRun({ status: "FAILED", workflowMode: "SETUP_AGENT", events });
    expect(await read(w.spend, w.taskId)).toBe(3);
    expect(await read(w.spend, w.taskId)).toBe(3);
  });

  it("a report that arrives AFTER a settlement is booked exactly, on top", async () => {
    const w = await world();
    const id = await w.addRun({ status: "SUCCEEDED", machine: false });
    expect(await read(w.spend, w.taskId)).toBe(0);
    await w.book(id, 2_000_000, "late");
    expect(await read(w.spend, w.taskId)).toBe(2);
  });
});

describe("case (iii): nothing is knowable, only the hold's room is booked, as a marked estimate (arch ruling)", () => {
  it("books exactly the hold's room on the task, marked estimated for the run, and releases the hold: never topped up", async () => {
    const w = await world({ hold: 3_000_000 });
    const id = await w.addRun({ status: "SUCCEEDED" });
    expect(await read(w.spend, w.taskId)).toBe(3);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 3_000_000, chargeStatus: "estimated" });
    expect(await w.hold()).toMatchObject({ state: "released" });
    // The day counts it once: drawn from the hold, not added to it.
    expect(await w.day()).toMatchObject({ usdMicros: 3_000_000, reservedMicros: 0, loadMicros: 3_000_000 });
    const small = await world({ hold: 500_000 });
    await small.addRun({ status: "FAILED" });
    expect(await read(small.spend, small.taskId), "a hold smaller than the fixed estimate is NOT topped up").toBe(0.5);
    const big = await world({ hold: 5_500_000 });
    await big.addRun({ status: "FAILED" });
    expect(await read(big.spend, big.taskId), "the hold, whatever the fixed estimate").toBe(5.5);
  });

  it("only the room the hold still has: what usage already drew is booked once, in its own entries", async () => {
    const w = await world({ hold: 3_000_000 });
    await w.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    await w.addRun({ status: "FAILED" });
    expect(await read(w.spend, w.taskId)).toBe(3);
  });

  it("a task with no hold of its own books a marked $0 (the run still counts as booked, the figure reads)", async () => {
    const w = await world({ hold: 0 });
    const id = await w.addRun({ status: "FAILED" });
    expect(await read(w.spend, w.taskId)).toBe(0);
    expect(await w.entry(unreportedSettleEntryId(id))).toMatchObject({ micros: 0, chargeStatus: "estimated" });
  });

  it("a SECOND unreported run is brought to the cap (its hold is already closed; at most two runs per task are counted this way), a third adds nothing: once each, never two estimates of one hold", async () => {
    const w = await world();
    await w.addRun({ status: "FAILED" });
    expect(await read(w.spend, w.taskId)).toBe(3);
    await w.addRun({ status: "FAILED" });
    expect(await read(w.spend, w.taskId)).toBe(5);
    expect(await read(w.spend, w.taskId)).toBe(5);
    await w.addRun({ status: "FAILED" });
    expect(await read(w.spend, w.taskId)).toBe(5);
  });

  it("the estimate alone never reaches a $5 or $6 cap: a hold of $2 under a $5 cap leaves room, where the fixed estimate used to end the task at its limit", async () => {
    for (const cap of [5, 6]) {
      const w = await world({ hold: 2_000_000 });
      await w.addRun({ status: "FAILED" });
      const spent = await read(w.spend, w.taskId);
      expect(spent).toBe(2);
      expect(spent as number).toBeLessThan(cap);
    }
  });
});

describe("when, how often, and for whom", () => {
  it("settles only after the grace: a run that just ended may still report", async () => {
    const w = await world();
    await w.addRun({ status: "FAILED", endedAgoMs: UNREPORTED_SETTLE_GRACE_MS - 1_000 });
    expect(await read(w.spend, w.taskId)).toBe(TASK_SPEND_UNKNOWN);
    expect(w.reasons).toEqual(["run_unreported"]);
    expect(await w.hold()).toMatchObject({ state: "open" });
    w.clock.now += 2_000;
    expect(await read(w.spend, w.taskId)).toBe(3);
  });

  it("an end time that cannot be read is 'not yet': the grace is never skipped for it", async () => {
    const w = await world();
    const id = await w.addRun({ status: "FAILED" });
    await w.store.update({ key: operationKey(A, w.workspaceId, id), ops: [{ op: "set", path: ["updatedAt"], value: "not a time" }] });
    expect(await read(w.spend, w.taskId)).toBe(TASK_SPEND_UNKNOWN);
    expect(await w.hold()).toMatchObject({ state: "open" });
  });

  it("is once per run: a repeat read books nothing more, in the task or the day", async () => {
    const w = await world();
    await w.addRun({ status: "FAILED" });
    await read(w.spend, w.taskId);
    const [total, day] = [await w.total(), await w.day()];
    expect(await w.settle(w.taskId)).toEqual([]);
    expect(await read(w.spend, w.taskId)).toBe(3);
    expect([await w.total(), await w.day()]).toEqual([total, day]);
  });

  it("never settles a run that is still going (it is still spending), and never calls the settle for a task that owes nothing", async () => {
    const w = await world();
    await w.addRun({ status: "RUNNING" });
    await w.addRun({ status: "FAILED" });
    expect(await read(w.spend, w.taskId)).toBe(TASK_SPEND_UNKNOWN);
    expect(w.settleCalls(), "a task with a run going is not settled").toBe(0);
    expect(await w.hold()).toMatchObject({ state: "open" });
    const clean = await world();
    await clean.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    expect(await read(clean.spend, clean.taskId)).toBe(1);
    expect(clean.settleCalls()).toBe(0);
  });

  it("a settle that fails is a refusal in fixed words, never the raw error; the next read tries again", async () => {
    const w = await world();
    await w.addRun({ status: "FAILED" });
    let fail = true;
    const spend = createCompanyTaskSpend({ store: w.store, companyId: A, refused: (reason) => { w.reasons.push(reason); }, settle: async (id) => { if (fail) throw new Error("DynamoDB said secret-detail-xyz"); await w.settle(id); } });
    const first = await spend(w.taskId).then(() => new Error("no refusal"), (error: Error) => error);
    expect(first.message).toBe(TASK_SPEND_UNKNOWN);
    expect(JSON.stringify([first.message, w.reasons])).not.toContain("secret-detail");
    fail = false;
    expect(await spend(w.taskId)).toBe(3);
  });

  it("settles only the company's own task and run: another company's task is nothing to this company's settler, and its money is not touched", async () => {
    const b = await world({ company: B });
    await b.addRun({ status: "FAILED" });
    const dayBefore = await b.day();
    const a = await world({ company: A });
    const foreign = createUnreportedRunSettler({ store: b.store, companyId: A, moneyStop: createHostedMoneyStop({ store: b.store, companyId: A, settings: SETTINGS, now: () => new Date(START) }), now: () => new Date(START + 600_000) });
    expect(await foreign(b.taskId)).toEqual([]);
    expect(await b.hold()).toMatchObject({ state: "open" });
    expect(await b.day()).toEqual(dayBefore);
    expect(a.settleCalls()).toBe(0);
  });
});

describe("the read-only count of tasks stuck this way (item 4)", () => {
  it("counts running, unreadable, clean and stuck tasks and the case each owed run would get, and writes nothing", async () => {
    const w = await world();
    await w.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    await w.addRun({ status: "FAILED", receipt: true });
    await w.addRun({ status: "SUCCEEDED", machine: false });
    await w.addRun({ status: "FAILED" });
    await w.addRun({ status: "INTERRUPTED", usageUnflushed: true });
    const running = await world();
    await running.addRun({ status: "RUNNING" });
    const clean = await world();
    await clean.addRun({ status: "SUCCEEDED", booked: 1_000_000 });
    const keys = (store: MemoryDocumentStore) => JSON.stringify([...(store as unknown as { rows?: Map<string, unknown> }).rows?.keys() ?? []]);
    const before = [keys(w.store), await w.total(), await w.day(), await w.hold()];
    expect(await countUnreportedRuns(w.store, A, [w.taskId, randomUUID()])).toEqual({ tasks: 2, running: 0, unreadable: 1, clean: 0, stuck: 1, runs: { gateway_record: 1, no_call: 1, estimate: 2 } });
    expect(await countUnreportedRuns(running.store, A, [running.taskId])).toMatchObject({ running: 1, stuck: 0 });
    expect(await countUnreportedRuns(clean.store, A, [clean.taskId])).toMatchObject({ clean: 1, stuck: 0 });
    expect([keys(w.store), await w.total(), await w.day(), await w.hold()]).toEqual(before);
  });

  it("the script imports no write command of the SDK and opens no write method of the store", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../scripts/spend-unreported-count.ts", import.meta.url), "utf8");
    expect(source).toMatch(/\b(?:ScanCommand|QueryCommand|GetCommand)\b/u);
    for (const write of ["PutCommand", "UpdateCommand", "DeleteCommand", "BatchWrite", "TransactWrite", "PutItem", "UpdateItem", "DeleteItem"]) expect(source, write).not.toContain(write);
    const { readOnlyStore } = await import("../../scripts/spend-unreported-count.js");
    const store = readOnlyStore({ send: async () => ({}) } as never, "table");
    await expect(store.put({ item: { pk: "a", sk: "b" } })).rejects.toThrow("read-only");
    await expect(store.transact([])).rejects.toThrow("read-only");
  });
});
