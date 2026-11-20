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
