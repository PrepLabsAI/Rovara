import { describe, expect, it } from "vitest";
import { WorkflowSnapshotSchema, WORKFLOW_BLOCK_REASONS, createCandidateManifest, createWorkflowSnapshot, WORKFLOW_AGENTX_ACTOR_ID, type OrgId } from "@agentx/contracts";
import { runAutofix } from "../../packages/broker/src/core/build-step/autofix.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { fromDocument, toDocument, type TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { AutoFixAskSchema, autoFixCardLines } from "../../packages/broker/src/developer/autofix-messages.js";
import { hostedAutofixDayBudgetHasRoom } from "../../packages/broker/src/core-host/autofix-day-budget.js";
import { createHostedAdmission, createHostedLedger } from "../../packages/broker/src/core-host/hosted-modules.js";
import { companyDayKey, costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { holdKey, reservationIdOf } from "../../packages/broker/src/core/cost/holds.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { chargeReceipt } from "./charge-receipt-fixture.js";
import { createHarness } from "../support/task-flow-harness.js";

const COMPANY: OrgId = "org_aaaaaaaaaaaaaaaaaaaa";
const TASK = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-11-09T10:00:00.000Z";

async function blocked(dayBudgetHasRoom: () => Promise<boolean>, spent = 1, cap = 15, rounds = 0, extra: Record<string, unknown> = {}, artifacts?: { get(objectKey: string, maxBytes: number): Promise<Uint8Array | undefined> }) {
  const h = createHarness({ companyId: COMPANY });
  if (artifacts !== undefined) Object.assign(h.deps, { artifacts });
  Object.assign(h.deps, { autofixDayBudgetHasRoom: dayBudgetHasRoom, taskSpendUsd: async () => spent, taskCapUsd: async () => cap });
  const workflow = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId: TASK, ownerId: "a".repeat(64), now: NOW }),
    decisions: Array.from({ length: rounds }, (_, i) => ({ requestId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, workflowRevision: i + 1, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "automatic fix", source: "AUTO_FIX", auto: { stage: "VERIFY" }, at: NOW })),
    stage: "VERIFY", state: "BLOCKED", revision: 7, blockReason: WORKFLOW_BLOCK_REASONS.regressionFound,
    candidate: createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]),
    ...extra,
  });
  await h.store.put({ item: toDocument({ ...taskKey(TASK), entityType: "DEVELOPER_TASK", companyId: COMPANY, taskId: TASK, workspaceId: "ws", project: "payments", startingRevision: 1, workflow }) });
  const read = async () => fromDocument<TaskRecord>(await h.store.get(taskKey(TASK)))!;
  const run = () => runAutofix(h.deps, { taskId: TASK, workflowRevision: 7 });
  return { h, read, run };
}

// Removing the policy's day check must send this blocked task back instead of asking.
describe("automatic fix admission uses the company's dollar allowance", () => {
  it("refuses a round without day room and tells the owner which allowance is full", async () => {
    const w = await blocked(async () => false);
    await w.run();
    const task = await w.read();
    expect(task.workflow).toMatchObject({ state: "BLOCKED", revision: 7 });
    const ask = AutoFixAskSchema.parse(task.autofixAsk);
    expect(ask.reason).toBe("day-budget");
    expect(autoFixCardLines(task.workflow!, ask).join("\n")).toContain("The company's daily AI allowance has no room for another automatic round today.");
  });

  it("admits a round when there is day room", async () => {
    const w = await blocked(async () => true);
    await w.run();
    expect((await w.read()).workflow).toMatchObject({ stage: "IMPLEMENT", revision: 8 });
    expect((await w.read()).autofixAsk).toBeUndefined();
  });

  it("keeps the live per-task cap even when the day has room", async () => {
    const w = await blocked(async () => true, 0.8, 1);
    await w.run();
    expect((await w.read()).autofixAsk).toMatchObject({ reason: "spend-cap" });
  });

  // A budget read failure is NO room (never an automatic paid fix): the existing ask path runs, with its own sentence, and zero rounds start.
  it("asks, with its own reason, and starts no automatic round when the day reader throws (first decision)", async () => {
    const w = await blocked(async () => { throw new Error("unreadable"); });
    await w.run();
    const task = await w.read();
    expect(task.workflow).toMatchObject({ state: "BLOCKED", stage: "VERIFY", revision: 7 });
    expect(task.workflow?.decisions ?? []).toHaveLength(0);
    const ask = AutoFixAskSchema.parse(task.autofixAsk);
    expect(ask.reason).toBe("day-budget-unreadable");
    const lines = autoFixCardLines(task.workflow!, ask).join("\n");
    expect(lines).toContain("Couldn't check today's AI budget, so Rovara is asking instead of fixing automatically.");
    expect(lines).not.toContain("has no room");
  });

  it("a full day still says so, not that the budget could not be read", async () => {
    const w = await blocked(async () => false);
    await w.run();
    expect(AutoFixAskSchema.parse((await w.read()).autofixAsk).reason).toBe("day-budget");
  });
});

// Raising the round limit must allow a third send-back and fail this behavior check.
// A failed proposed check whose original-code result is read from the approved plan's dry run is classified by a SECOND policy call; it must use the same company-day answer as the first.
describe("the reclassified (dry-run) automatic-fix decision uses the same day answer", () => {
  const SHA = "b".repeat(64);
  const record = JSON.stringify({ schemaVersion: 1, status: "checked", artifactId: "plan-1", artifactSha256: SHA, checkedAt: NOW, findings: [], notes: [], autoRevisions: 0, tried: [{ checkId: "proposed-1", class: "passed" }] });
  const artifacts = { get: async (key: string) => (key === "plans/plan-1.quality.json" ? new TextEncoder().encode(record) : undefined) };
  const extra = () => {
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "1".repeat(40), treeSha: "2".repeat(40), baseCommitSha: "3".repeat(40) }]);
    return {
      blockReason: undefined,
      artifacts: [{ id: "plan-1", type: "plan", version: 1, sha256: SHA, producer: "planner", objectKey: "plans/plan-1.json", createdAt: NOW }],
      verification: { candidateDigest: candidate.digest, producer: "worker", environmentId: "env", recordedAt: NOW, results: [{ checkId: "lint", status: "PASS" }, { checkId: "proposed-1", status: "FAILED" }] },
    };
  };

  it("sends the code's fault back when the day has room (proves the second call is reached)", async () => {
    const w = await blocked(async () => true, 1, 15, 0, extra(), artifacts);
    await w.run();
    expect((await w.read()).workflow).toMatchObject({ stage: "IMPLEMENT", revision: 8 });
  });

  it("asks about the day allowance, and never sends back, when the day has no room", async () => {
    const w = await blocked(async () => false, 1, 15, 0, extra(), artifacts);
    await w.run();
    expect((await w.read()).workflow).toMatchObject({ state: "BLOCKED", revision: 7 });
    expect((await w.read()).autofixAsk).toMatchObject({ reason: "day-budget" });
  });

  it("asks, with the unreadable-budget reason, and starts no round when the day reader throws (second decision)", async () => {
    const w = await blocked(async () => { throw new Error("unreadable"); }, 1, 15, 0, extra(), artifacts);
    await w.run();
    expect((await w.read()).workflow).toMatchObject({ state: "BLOCKED", revision: 7 });
    expect((await w.read()).autofixAsk).toMatchObject({ reason: "day-budget-unreadable" });
  });
});

it("admits the second round but refuses the third even with dollar room", async () => {
  const second = await blocked(async () => true, 1, 15, 1);
  await second.run();
  expect((await second.read()).workflow).toMatchObject({ stage: "IMPLEMENT", revision: 8 });
  const third = await blocked(async () => true, 1, 15, 2);
  await third.run();
  expect((await third.read()).autofixAsk).toMatchObject({ reason: "send-back-limit" });
});

const SETTINGS = { taskCapMicros: 15_000_000, companyDayCapMicros: 25_000_000 };
const DAY = "2026-11-09";
async function allowance(load = 25_000_000, holdCompany = COMPANY, holdDay = DAY, holdState = "open") {
  const store = new MemoryDocumentStore();
  const task = { companyId: COMPANY, taskId: TASK, project: "demo" } as TaskRecord;
  const holdId = reservationIdOf(holdCompany, "task.start");
  await store.put({ item: { ...taskKey(TASK), companyId: COMPANY, taskId: TASK } });
  await store.put({ item: { ...companyDayKey(COMPANY, DAY), loadMicros: load, uncountedEntries: 0 } });
  await store.put({ item: { pk: costPartition(COMPANY, TASK), sk: "TOTAL", holdId } });
  await store.put({ item: { ...holdKey(holdCompany, holdId), companyId: holdCompany, reservationId: holdId, taskId: TASK, day: holdDay, heldMicros: 5_000_000, drawnMicros: 2_000_000, state: holdState, expiresAt: 2_000_000_000 } });
  const room = hostedAutofixDayBudgetHasRoom({ store, companyId: COMPANY, settings: SETTINGS, now: () => new Date(NOW) });
  return { store, task, room };
}

describe("the company-day dollar reader", () => {
  it("counts the task's current-day hold once, including the exact fit at a full day", async () => {
    const w = await allowance();
    expect(await w.room(w.task, 3)).toBe(true);
    expect(await w.room(w.task, 3.000001)).toBe(false);
    const partial = await allowance(24_000_000);
    expect(await partial.room(partial.task, 4)).toBe(true);
    expect(await partial.room(partial.task, 4.000001)).toBe(false);
  });

  it("never spends another company's hold, yesterday's hold, or a closed hold", async () => {
    for (const [company, day, state] of [["org_bbbbbbbbbbbbbbbbbbbb", DAY, "open"], [COMPANY, "2026-11-08", "open"], [COMPANY, DAY, "settled"]] as const) {
      const w = await allowance(25_000_000, company, day, state);
      expect(await w.room(w.task, 0.25)).toBe(false);
    }
  });

  it("fails closed on unreadable dollars, missing settings, and invalid estimates", async () => {
    const w = await allowance();
    for (const estimate of [NaN, Infinity, -1, 0]) expect(await w.room(w.task, estimate)).toBe(false);
    const unknown = hostedAutofixDayBudgetHasRoom({ store: w.store, companyId: COMPANY, settings: undefined, now: () => new Date(NOW) });
    expect(await unknown(w.task, 1)).toBe(false);
    // An unknown day load cannot be told: the reader throws (the caller asks the owner, with the unreadable-budget sentence), never "room".
    await w.store.put({ item: { ...companyDayKey(COMPANY, DAY), loadMicros: 0, uncountedEntries: 1 } });
    await expect(w.room(w.task, 1)).rejects.toThrow();
  });

  it("refuses when the stored task row belongs to another company, or the store cannot be read", async () => {
    const w = await allowance();
    expect(await w.room(w.task, 1)).toBe(true);
    await w.store.put({ item: { ...taskKey(TASK), companyId: "org_bbbbbbbbbbbbbbbbbbbb", taskId: TASK } });
    expect(await w.room(w.task, 1)).toBe(false);
    const unreadable = Object.create(w.store, { get: { value: async () => { throw new Error("store unreadable"); } } }) as MemoryDocumentStore;
    const reader = hostedAutofixDayBudgetHasRoom({ store: unreadable, companyId: COMPANY, settings: SETTINGS, now: () => new Date(NOW) });
    await expect(reader(w.task, 1)).rejects.toThrow("store unreadable");
  });

  // Review test (lead 4 Opus, e48d7b1b1): a task with NO stored row is never this company's task, so it never has room (an absent row is not "ours").
  it("refuses a task whose stored row is missing", async () => {
    const w = await allowance(0);
    expect(await w.room(w.task, 1)).toBe(true);
    await w.store.delete({ key: taskKey(TASK) });
    expect(await w.room(w.task, 1)).toBe(false);
  });

  // Each read the reader makes must, when it alone fails, stop the round as "cannot read" (a rejection), never be taken as room.
  it("rejects when any ONE of its dollar reads fails: the task row, the day's load, the task's hold pointer, or its hold", async () => {
    const w = await allowance(0);
    const reads: Array<[string, (key: { pk: string; sk: string }) => boolean]> = [
      ["task row", (key) => key.pk === taskKey(TASK).pk && key.sk === taskKey(TASK).sk],
      ["day load", (key) => key.pk === companyDayKey(COMPANY, DAY).pk && key.sk === companyDayKey(COMPANY, DAY).sk],
      ["hold pointer", (key) => key.pk === costPartition(COMPANY, TASK) && key.sk === "TOTAL"],
      ["hold row", (key) => key.pk === holdKey(COMPANY, reservationIdOf(COMPANY, "task.start")).pk && key.sk === holdKey(COMPANY, reservationIdOf(COMPANY, "task.start")).sk],
    ];
    expect(await w.room(w.task, 1)).toBe(true);
    for (const [label, failing] of reads) {
      const store = Object.create(w.store, { get: { value: async (key: { pk: string; sk: string }) => { if (failing(key)) throw new Error(`${label} unreadable`); return w.store.get(key); } } }) as MemoryDocumentStore;
      const reader = hostedAutofixDayBudgetHasRoom({ store, companyId: COMPANY, settings: SETTINGS, now: () => new Date(NOW) });
      await expect(reader(w.task, 1), label).rejects.toThrow(`${label} unreadable`);
    }
  });

  it("passes the fitted estimate to the day check, rather than the default $3", async () => {
    const w = await blocked(async () => true, 0.5, 1);
    const reader = await allowance(24_500_000, COMPANY, "2026-11-08");
    w.h.deps.autofixDayBudgetHasRoom = (task, estimate) => reader.room(task, estimate);
    await w.run();
    expect((await w.read()).workflow).toMatchObject({ stage: "IMPLEMENT", revision: 8 });
  });
});

// Local money boundary: round admission cannot replace model.call admission or trusted per-call receipt accounting.
it("an admitted fix still needs a separate exact-price call hold and receipt for every call", async () => {
  const w = await blocked(async () => true);
  await w.run();
  expect((await w.read()).workflow?.stage).toBe("IMPLEMENT");
  const ledger = createHostedLedger({ store: w.h.store, metering: { async price() { return null; }, async record() { return { cost: null, source: "unknown" }; } }, now: () => new Date(NOW) });
  const admission = createHostedAdmission({ store: w.h.store, ledger, settings: SETTINGS, now: () => new Date(NOW), runStopWired: true });
  for (const n of [1, 2]) {
    const decision = await admission.admit({ companyId: COMPANY, action: "model.call", idempotencyKey: `fix-call-${String(n)}`, subject: { type: "task", id: TASK }, estimate: { cost: { micros: 500_000, currency: "USD" } } });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) throw new Error("call refused");
    expect(decision.reservationId).toBeDefined();
    expect(await w.h.store.get(holdKey(COMPANY, decision.reservationId!))).toMatchObject({ state: "open", heldMicros: 500_000 });
    const receipt = chargeReceipt({ companyId: COMPANY, taskId: TASK, callId: `fix-call-${String(n)}`, occurredAt: NOW, recordedAt: NOW, accountingDay: DAY, accountingMonth: "2026-11" });
    await ledger.applyChargeReceipt(receipt);
    await ledger.applyChargeReceipt(receipt); // One receipt, counted once.
    // The receipt already booked actual dollars: release the separate call reservation.
    await admission.release(decision.reservationId!);
  }
  expect(await ledger.taskCost(COMPANY, TASK)).toMatchObject({ micros: 160, entries: 2, unpricedEntries: 0 });
  await w.h.store.put({ item: { ...companyDayKey(COMPANY, DAY), loadMicros: 25_000_000, uncountedEntries: 0 } });
  expect(await admission.admit({ companyId: COMPANY, action: "model.call", idempotencyKey: "later-call", subject: { type: "task", id: TASK }, estimate: { cost: { micros: 500_000, currency: "USD" } } })).toMatchObject({ allowed: false, code: "company_day_cap" });
});
