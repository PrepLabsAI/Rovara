// FEEDBACK-REVIEW-USAGE-FIX (2): "Who pays" on a hosted task. The hosted broker stores no charge receipt, so the payer used to stay Unavailable on every hosted task. It is now the task's own member, but ONLY when
// the model gateway would charge exactly that member for every run of the task (the gateway's payer is the operation's requester under the shared `resolvePayer` rule); a receipt that names a payer always wins.
// Each guard below has a test that fails without it (mutants M7-M9, M13-M15 in MUTANTS.md).
import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { readTaskMoney } from "../../packages/broker/src/core/cost/task-money.js";
import { costPartition, createCostLedger } from "../../packages/broker/src/core/cost/ledger.js";
import { operationKey, workspaceKey, developerCharge } from "../../packages/broker/src/core/task-flow/keys.js";
import { parseTaskMoneyV1 } from "../../packages/contracts/src/task-money.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";

const companyId = "org_aaaaaaaaaaaaaaaaaaaa";
const at = "2026-11-18T00:00:00.000Z";
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const WS = "workspace";
const baseTask = { taskId: "task", companyId, workspaceId: WS, createdAt: at, updatedAt: at, project: "payments", developerId: OWNER, developerName: "Ada Owner", charge: developerCharge({ companyId: companyId, developerId: OWNER }) };
type TaskInput = Parameters<typeof readTaskMoney>[0]["task"];
const entry = (id: string, extra = {}) => ({ pk: costPartition(companyId, baseTask.taskId), sk: `ENTRY#${id}`, entryId: id, currency: "USD", micros: 700, ...extra });

/** A hosted task with one worker-aggregate cost entry (no receipt) and the given runs, each with the requester the engine recorded. */
async function hostedMoney(options: { task?: Partial<TaskInput> & Record<string, unknown>; requesters?: Array<string | undefined>; hosted?: boolean; revealPayer?: boolean; receipts?: boolean } = {}) {
  const store = new MemoryDocumentStore();
  await store.put({ item: { ...workspaceKey(companyId, WS), companyId, activeOperationId: null } });
  const requesters = options.requesters ?? [OWNER, OWNER, OWNER];
  let n = 0;
  for (const personId of requesters) {
    n += 1;
    await store.put({ item: { ...operationKey(companyId, WS, `run-${n}`), id: `run-${n}`, companyId, kind: "task", status: "SUCCEEDED", createdAt: `2026-11-18T00:00:0${n}.000Z`, fence: n, ...(personId === undefined ? {} : { requester: { personId, provider: "p" } }) } });
    await store.put({ item: entry(`usage:run-${n}:abc`) });
  }
  if (options.receipts === true) {
    const ledger = createCostLedger({ store, metering: { record: async () => ({ cost: null, source: "unknown" }), price: async () => null }, now: () => new Date(at) });
    await ledger.applyChargeReceipt(chargeReceipt({ companyId, taskId: baseTask.taskId, operationId: "gw", payer: { kind: "project", id: "payments", name: "Payments" } }));
  }
  const task = { ...baseTask, ...(options.task ?? {}) } as unknown as TaskInput;
  return readTaskMoney({ store, companyId, task, hosted: options.hosted ?? true, revealPayer: options.revealPayer ?? true });
}
const unavailable = { payer: { state: "unavailable", reason: "restricted" } };

describe("who pays a hosted task, when no receipt names one", () => {
  it("is the task's own member (the owner) when every run was requested by them", async () => {
    const money = await hostedMoney();
    expect(money.payer).toEqual({ state: "available", value: { kind: "member", id: OWNER, name: "Ada Owner" } });
    expect(money.allocations).toEqual([]);
    expect(parseTaskMoneyV1(money)).toEqual(money);
  });
  it("also for the origins the gateway charges to the starter (app, cli, slack) and for an old record with no origin", async () => {
    for (const origin of [undefined, "app", "cli", "slack", "mcp", "github_issue", "tracker", "jira"]) expect((await hostedMoney({ task: { origin } as never })).payer, String(origin)).toMatchObject({ state: "available", value: { id: OWNER } });
  });
  it("is told only to a reader who may see the payer (revealPayer), and only on a hosted read (local is a different fact)", async () => {
    expect(await hostedMoney({ revealPayer: false })).toMatchObject(unavailable);
    expect(await hostedMoney({ hosted: false })).toMatchObject(unavailable);
  });
  it("stays unavailable for work the gateway charges to someone else: linear, offer, nightly, test_run, automatic, event, schedule, chain, a wiki build and a setup draft", async () => {
    for (const origin of ["linear", "offer", "nightly", "test_run", "automatic", "event", "schedule", "chain"]) expect(await hostedMoney({ task: { origin } as never }), origin).toMatchObject(unavailable);
    for (const purpose of ["wiki_build", "setup_agent"]) expect(await hostedMoney({ task: { purpose } as never }), purpose).toMatchObject(unavailable);
  });
  it("stays unavailable when ANY run was requested by another person, or has no requester (the gateway charges each run to its own requester)", async () => {
    expect(await hostedMoney({ requesters: [OWNER, OTHER, OWNER] })).toMatchObject(unavailable);
    expect(await hostedMoney({ requesters: [OWNER, undefined] })).toMatchObject(unavailable);
  });
  it("stays unavailable for a developer that is not a person's id, a missing name, or a charge counter that is not this developer's own", async () => {
    expect(await hostedMoney({ task: { developerId: "system-owner", charge: developerCharge({ companyId: companyId, developerId: "system-owner" }) }, requesters: ["system-owner"] })).toMatchObject(unavailable);
    expect(await hostedMoney({ task: { developerName: "  " } })).toMatchObject(unavailable);
    expect(await hostedMoney({ task: { charge: developerCharge({ companyId: companyId, developerId: OTHER }) } })).toMatchObject(unavailable);
    expect(await hostedMoney({ task: { developerName: undefined, charge: undefined } as never })).toMatchObject(unavailable);
  });
  it("a receipt that names a payer wins over the task's member, and no allocation is invented without one", async () => {
    const money = await hostedMoney({ receipts: true });
    expect(money.payer).toMatchObject({ state: "available", value: { kind: "project", id: "payments" } });
    expect(money.allocations).toHaveLength(1);
  });
  it("never changes a figure: the same spend with and without the payer", async () => {
    const withPayer = await hostedMoney();
    const without = await hostedMoney({ revealPayer: false });
    expect({ ...withPayer, payer: undefined }).toEqual({ ...without, payer: undefined });
  });
});
