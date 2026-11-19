import { expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { readTaskMoney } from "../../packages/broker/src/core/cost/task-money.js";
import { costPartition, createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { workspaceKey, operationKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { parseTaskMoneyV1, taskMoneyWords } from "../../packages/contracts/src/task-money.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";
const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
const at = "2026-11-18T00:00:00.000Z";
const task = { taskId: "task", companyId, workspaceId: "workspace", createdAt: at, updatedAt: at, closedAt: at };
const entry = (id: string, extra = {}) => ({ pk: costPartition(companyId, task.taskId), sk: `ENTRY#${id}`, entryId: id, currency: "USD", micros: 700, ...extra });
const read = (store: MemoryDocumentStore) => readTaskMoney({ store, companyId, task });
it("proves a local zero only with a real workspace and no model operations", async () => {
 const store = new MemoryDocumentStore();
 expect(await read(store)).toMatchObject({ state: "unavailable", spentMicros: { state: "unavailable" } });
 await store.put({ item: { ...workspaceKey(companyId, task.workspaceId), companyId, activeOperationId: null } });
 const empty = await read(store);
 expect(empty).toMatchObject({ state: "current", spentMicros: { value: 0 }, finality: "final" });
 expect(taskMoneyWords(empty)).toBe("No spend yet");
 await store.put({ item: { ...operationKey(companyId, task.workspaceId, "run"), id: "run", companyId, kind: "task", status: "SUCCEEDED" } });
 expect(await read(store)).toMatchObject({ state: "unavailable", finality: "unavailable" });
});
it("does not prove zero for a live task, an active operation or any stage history without booked usage", async () => {
 const store = new MemoryDocumentStore();
 await store.put({ item: { ...workspaceKey(companyId, task.workspaceId), companyId, activeOperationId: null } });
 const liveTask = { taskId: task.taskId, companyId, workspaceId: task.workspaceId, createdAt: at, updatedAt: at };
 expect(await readTaskMoney({ store, companyId, task: liveTask })).toMatchObject({ state: "unavailable", finality: "unavailable", spentMicros: { state: "unavailable" } });
 await store.put({ item: { ...workspaceKey(companyId, task.workspaceId), companyId, activeOperationId: "in-flight" } });
 expect(await read(store)).toMatchObject({ state: "unavailable", spentMicros: { state: "unavailable" } });
 await store.put({ item: { ...workspaceKey(companyId, task.workspaceId), companyId, activeOperationId: null } });
 for (const kind of ["prepare", "task", "publish", "maintain"]) {
  await store.put({ item: { ...operationKey(companyId, task.workspaceId, "run"), id: "run", companyId, kind, status: "SUCCEEDED" } });
  expect(await read(store), kind).toMatchObject({ state: "unavailable", finality: "unavailable", spentMicros: { state: "unavailable" } });
 }
 await store.put({ item: entry("booked", { micros: 0 }) });
 expect(await read(store)).toMatchObject({ state: "partial", finality: "provisional", spentMicros: { value: 0 }, coverage: { expectedCalls: { state: "unavailable" } } });
});
it("keeps checkpoint spend partial when the final report is missing, and rejects foreign-only money", async () => {
 const store = new MemoryDocumentStore();
 await store.put({ item: entry("usage-checkpoint:run:one") });
 const partial = await read(store);
 expect(partial).toMatchObject({ state: "partial", spentMicros: { value: 700 }, coverage: { expectedCalls: { state: "unavailable" } }, finality: "provisional" });
 expect(parseTaskMoneyV1(partial)).toEqual(partial);
 expect(taskMoneyWords(partial)).toBe("under $0.01 (not yet confirmed)");
 await store.put({ item: entry("usage-checkpoint:run:one", { currency: "EUR" }) });
 const foreign = await read(store);
 expect(foreign).toMatchObject({ state: "unavailable", coverage: { incompatibleCurrencyCalls: 1 } });
 expect(parseTaskMoneyV1(foreign)).toEqual(foreign);
});
it("does not count an engine aggregate again beside receipts for its operation; project payer is explicit and restricted by default", async () => {
 const store = new MemoryDocumentStore();
 const ledger = createCostLedger({ store, metering: { record: async () => ({ cost: null, source: "unknown" }), price: async () => null }, now: () => new Date(at) });
 await ledger.applyChargeReceipt(chargeReceipt({ companyId, taskId: task.taskId, operationId: "wiki", payer: { kind: "project", id: "payments", name: "Payments" } }));
 await store.put({ item: entry("usage:wiki:aggregate", { micros: 999 }) });
 expect(await read(store)).toMatchObject({ spentMicros: { value: 80 }, payer: { state: "unavailable", reason: "restricted" } });
 expect(await readTaskMoney({ store, companyId, task, revealPayer: true })).toMatchObject({ spentMicros: { value: 80 }, payer: { state: "available", value: { kind: "project", id: "payments" } } });
});
it("never emits unsafe totals as valid money", async () => {
 const store = new MemoryDocumentStore();
 await store.put({ item: entry("one", { micros: Number.MAX_SAFE_INTEGER }) });
 await store.put({ item: entry("two", { micros: Number.MAX_SAFE_INTEGER }) });
 const money = await read(store);
 expect(money).toMatchObject({ state: "unavailable", spentMicros: { state: "unavailable" } });
 expect(parseTaskMoneyV1(money)).toEqual(money);
});

it("keeps unreported tasks and ledger-read failures unavailable without proof of no spend", async () => {
 const live = { taskId: task.taskId, companyId, workspaceId: task.workspaceId, createdAt: at, updatedAt: at };
 const initial = await readTaskMoney({ store: new MemoryDocumentStore(), companyId, task: live, hosted: true });
 expect(initial.spentMicros.state).toBe("unavailable"); expect(taskMoneyWords(initial)).toBe("Cost unavailable");
 class BrokenStore extends MemoryDocumentStore { override async get(): Promise<never> { throw new Error("unavailable"); } }
 const broken = await readTaskMoney({ store: new BrokenStore(), companyId, task: live, hosted: true });
 expect(taskMoneyWords(broken)).toBe("Cost unavailable");
 expect(broken.spentMicros).toEqual({ state: "unavailable", reason: "unreadable" });
});

it.each([false, true])("does not call legacy TOTAL without entries empty (terminal=%s)", async terminal => {
 const store = new MemoryDocumentStore();
 await store.put({ item: { ...workspaceKey(companyId, task.workspaceId), companyId, activeOperationId: null } });
 await store.put({ item: { pk: costPartition(companyId, task.taskId), sk: "TOTAL", companyId, taskId: task.taskId, currency: "USD", micros: 2_750_000, entries: 4, unpricedEntries: 0 } });
 const snapshot = await readTaskMoney({ store, companyId, task: { taskId: task.taskId, companyId, workspaceId: task.workspaceId, createdAt: at, updatedAt: at, ...(terminal ? { closedAt: at } : {}) } });
 expect(snapshot.spentMicros.state).toBe("unavailable");
 expect(taskMoneyWords(snapshot)).toBe("Cost unavailable");
});
