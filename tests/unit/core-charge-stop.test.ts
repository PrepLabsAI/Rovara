import { expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { createHostedMoneyStop } from "../../packages/broker/src/core-host/hosted-modules.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";
it("a covered run with an unreported final call keeps known R and marks unavailable coverage, without inventing Full planning spend", async () => {
  const store = new MemoryDocumentStore(), r = chargeReceipt();
  const ledger = createCostLedger({ store, metering: { async price() { return null; }, async record() { return { cost: null, source: "unknown" }; } } });
  await ledger.applyChargeReceipt(r);
  const stop = createHostedMoneyStop({ store, companyId: r.companyId, now: () => new Date(r.occurredAt) });
  await stop.keepWholeHold(undefined, { operationId: r.operationId, taskId: r.taskId });
  expect(await ledger.taskCost(r.companyId, r.taskId)).toMatchObject({ micros: 80, entries: 2, unpricedEntries: 1 });
  await stop.keepWholeHold(undefined, { operationId: r.operationId, taskId: r.taskId });
  expect((await ledger.taskCost(r.companyId, r.taskId)).entries).toBe(2);
  expect(await ledger.companyDayCost(r.companyId, r.accountingDay)).toMatchObject({ usdMicros: 80, uncountedEntries: 1 });
});

it("the Full planning fallback is explicitly estimated in its entry and total", async () => {
  const store = new MemoryDocumentStore(), r = chargeReceipt();
  const ledger = createCostLedger({ store, metering: { async price() { return null; }, async record() { return { cost: null, source: "unknown" }; } } });
  const stop = createHostedMoneyStop({ store, companyId: r.companyId, now: () => new Date(r.occurredAt) });
  await stop.keepWholeHold(undefined, { operationId: r.operationId, taskId: r.taskId });
  expect(await ledger.taskCost(r.companyId, r.taskId)).toMatchObject({ provisionalCalls: 1, unpricedEntries: 0 });
  const rows = (await store.query({ pk: `ORG#${r.companyId}#COST#${r.taskId}`, sk: { op: "beginsWith", prefix: "ENTRY#" } })).items;
  expect(rows[0]).toMatchObject({ chargeStatus: "estimated" });
});
it("a Full planning fallback covered entirely by hold room still marks the task estimated", async () => {
  const { createHostedAdmission, createHostedLedger } = await import("../../packages/broker/src/core-host/hosted-modules.js");
  const store = new MemoryDocumentStore(), r = chargeReceipt();
  const now = () => new Date(r.occurredAt);
  const settings = { allowedCompanies: "all" as const, taskCapMicros: 5_000_000, companyDayCapMicros: 50_000_000 };
  const ledger = createHostedLedger({ store, now, metering: { async price() { return null; }, async record() { return { cost: null, source: "unknown" }; } } });
  const admission = createHostedAdmission({ store, ledger, settings, now, runStopWired: true });
  const staged = await admission.stage({ companyId: r.companyId, idempotencyKey: "start", action: "task.start", subject: { type: "task", id: r.taskId }, taskStart: { workflow: true, path: "FULL", pathFrom: "request" } });
  expect(staged.decision.allowed).toBe(true);
  expect((await store.transact([...staged.items])).applied).toBe(true);
  if (!staged.decision.allowed) throw new Error("admission");
  const stop = createHostedMoneyStop({ store, companyId: r.companyId, settings, now });
  await stop.keepWholeHold(staged.decision.reservationId, { operationId: r.operationId, taskId: r.taskId });
  expect(await ledger.taskCost(r.companyId, r.taskId)).toMatchObject({ provisionalCalls: 1 });
});
