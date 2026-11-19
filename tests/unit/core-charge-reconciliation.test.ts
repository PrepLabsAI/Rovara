import { expect, it } from "vitest";
import { runCostKey } from "@agentx/contracts";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { createCostLedger, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";
const meter = { async price() { return null; }, async record() { return { cost: null, source: "unknown" as const }; } };
it("rejects conflicting older revisions and revises a closed task's one training sample", async () => {
  const store = new MemoryDocumentStore(), r = chargeReceipt();
  await store.put({ item: { pk: `DEVTASK#${r.taskId}`, sk: "META", companyId: r.companyId, project: r.project, runCostRecordedAt: r.occurredAt, workflow: { path: "QUICK" } } });
  const ledger = createCostLedger({ store, metering: meter });
  await ledger.applyChargeReceipt(r);
  const final = { ...r, revision: 2, replacesRevision: 1, status: "final" as const, reason: "reported_cost" as const, amountMicros: { state: "available" as const, value: 30 }, providerCostMicros: { state: "available" as const, value: 30 } };
  await ledger.applyChargeReceipt(final);
  await expect(ledger.applyChargeReceipt({ ...r, amountMicros: { state: "available", value: 81 }, originalReservationMicros: { state: "available", value: 81 } })).rejects.toThrow();
  await expect(ledger.applyChargeReceipt({ ...r, recordedAt: "2026-02-01T00:00:00.000Z" })).rejects.toThrow();
  const sample = await store.get(runCostKey(r.companyId, r.project, "rovara-code", "QUICK", r.occurredAt, r.taskId));
  expect(sample).toMatchObject({ costUsd: 0.00003 });
  expect((await store.query({ pk: costPartition(r.companyId, r.taskId), sk: { op: "beginsWith", prefix: "ADJUST#" } })).items).toHaveLength(2);
});
it("unrecoverable reservation remains unknown and refuses arithmetic overflow without partial writes", async () => {
  const store = new MemoryDocumentStore(), ledger = createCostLedger({ store, metering: meter });
  const r = chargeReceipt({ amountMicros: { state: "unavailable", reason: "legacy_data" }, originalReservationMicros: { state: "unavailable", reason: "legacy_data" } });
  await ledger.applyChargeReceipt(r);
  expect(await ledger.taskCost(r.companyId, r.taskId)).toMatchObject({ micros: 0, unpricedEntries: 1, provisionalCalls: 1 });
  expect(await ledger.companyDayCost(r.companyId, r.accountingDay)).toMatchObject({ uncountedEntries: 1 });
  await expect(ledger.applyChargeReceipt({ ...r, revision: 2, replacesRevision: 1, status: "final", reason: "reported_cost", amountMicros: { state: "available", value: Number.MAX_SAFE_INTEGER + 1 }, providerCostMicros: { state: "available", value: 5 } })).rejects.toThrow();
  expect((await ledger.taskCost(r.companyId, r.taskId)).entries).toBe(1);
});
