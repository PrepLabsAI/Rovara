// SPEND-UNREPORTED-RUN items 1 to 3 together, at the Approve check (journey 13b's KNOWN GAP, A1-10; that journey is on another branch and its gap case flips when both land): every model call of a planning run
// fails BEFORE any response with no HTTP status (network, DNS, TLS, reset), and Approve used to be refused for good with "This isn't ready to be decided yet". Now:
//   a) the worker sends its zero report BY CODE, the broker books it at $0, and Approve passes;
//   b) a worker that sent nothing (an old image) is settled by the broker once the grace has passed, and until then the card says the real reason, in the one words table, never "isn't ready".
// Real model runtime, real worker usage tracker, real usage booking, real spend reader and settler, the real Approve check (`checkPlanRunLimit`).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { STATUS_LINES, spendUnreadableWords, type MeterEntry, type OrgId } from "@agentx/contracts";
import { createConfiguredModelRuntime } from "../../packages/model-runtime/src/index.js";
import { createUsageCheckpointer, type UsageStats } from "../../packages/worker/src/usage.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { operationKey, taskKey, taskPointerKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { TASK_HOLD_SECONDS, holdItems, reservationIdOf } from "../../packages/broker/src/core/cost/holds.js";
import { createUsageBooking } from "../../packages/broker/src/core-host/usage-booking.js";
import { createHostedMoneyStop, type HostedAdmissionSettings } from "../../packages/broker/src/core-host/hosted-modules.js";
import { createCompanyTaskSpend, type TaskSpendRefusal } from "../../packages/broker/src/core-host/company-task-spend.js";
import { UNREPORTED_SETTLE_GRACE_MS, createUnreportedRunSettler } from "../../packages/broker/src/core-host/unreported-run-settle.js";
import { checkPlanRunLimit } from "../../packages/broker/src/services/decisions.js";
import { SubjectRefusal } from "../../packages/broker/src/core/decisions/approval-gate.js";
import { CARD_REFUSAL_OF_GATE } from "../../packages/broker/src/core/decisions/performer.js";
import { DECISION_REFUSALS } from "../../packages/broker/src/core/decisions/routes.js";
import { localResultOf } from "../../packages/broker/src/core/decisions/local-actions.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";
import type { TaskRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { COMPANY_A_ID } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A_ID as OrgId;
const SETTINGS: HostedAdmissionSettings = { taskCapMicros: 20_000_000, companyDayCapMicros: 100_000_000 };
const START = Date.parse("2026-11-25T12:00:00.000Z");
const MODEL = "claude-sonnet-5";
const context: Context = { messages: [{ role: "user", content: "plan it", timestamp: 1 }] };
const nothing: UsageStats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
const meter = { async price() { return null; }, async record(entry: MeterEntry) { return { cost: { micros: entry.reportedCost?.micros ?? 0, currency: "USD" }, source: "price-table" as const }; } };

/** A task with a start hold and ONE planning run that ended FAILED on a machine; `failRun` makes its model calls fail through the real runtime with no HTTP status. */
async function world(cap = 10) {
  const clock = { now: START };
  const now = () => new Date(clock.now);
  const store = new MemoryDocumentStore();
  const taskId = randomUUID(), workspaceId = randomUUID(), operationId = randomUUID();
  const reservationId = reservationIdOf(A, `task.start:${taskId}`);
  await store.transact(holdItems({ companyId: A, reservationId, action: "task.start", taskId, day: "2026-11-25", micros: 2_000_000, capMicros: SETTINGS.companyDayCapMicros, nowSeconds: Math.floor(START / 1000), holdSeconds: TASK_HOLD_SECONDS }));
  await store.put({ item: { pk: costPartition(A, taskId), sk: "TOTAL", entityType: "COST_TOTAL", taskId, companyId: A, micros: 0, entries: 0, unpricedEntries: 0, holdId: reservationId } });
  await store.put({ item: { ...taskKey(taskId), entityType: "DEVELOPER_TASK", taskId, companyId: A, workspaceId, admissionReservationId: reservationId } });
  await store.put({ item: { ...workspaceKey(A, workspaceId), entityType: "WORKSPACE", id: workspaceId, companyId: A, orgId: A } });
  await store.put({ item: { ...taskPointerKey(A, workspaceId), entityType: "DEVELOPER_TASK_POINTER", taskId } });
  await store.put({ item: { ...operationKey(A, workspaceId, operationId), entityType: "OPERATION", id: operationId, workspaceId, companyId: A, kind: "task", workflowMode: "PLAN", status: "FAILED", machineId: "machine-1", fence: 1, updatedAt: new Date(START).toISOString(), eventSequence: 0 } });
  const reasons: TaskSpendRefusal[] = [];
  const settle = createUnreportedRunSettler({ store, companyId: A, moneyStop: createHostedMoneyStop({ store, companyId: A, settings: SETTINGS, now }), now });
  const spend = createCompanyTaskSpend({ store, companyId: A, refused: (reason) => { reasons.push(reason); }, settle: async (id) => { await settle(id); } });
  const flow = { companyId: A, taskCapUsd: async () => cap, taskSpendUsd: spend } as unknown as TaskFlowDeps;
  const task = { taskId, companyId: A } as unknown as TaskRecord;
  const approve = async (): Promise<SubjectRefusal | undefined> => await checkPlanRunLimit(flow, task).then(() => undefined, (error: unknown) => error as SubjectRefusal);
  /** The calls of the run, through the real runtime, observed by the worker's real usage tracker; what its end sends goes through the real booking, as the callback layer does. */
  const failRun = async (calls: number, send: boolean) => {
    const runtime = await createConfiguredModelRuntime({ provider: "anthropic", modelId: MODEL }, { fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, onUsage: () => undefined, proxy: { baseUrl: "https://gateway.example", apiKey: "t", route: { alias: MODEL, api: "anthropic-messages" as const, catalog: MODEL } } });
    const model = { provider: "rovara-route", modelId: MODEL };
    const tracker = createUsageCheckpointer({ enabled: true, baseline: undefined, stats: () => nothing, model: () => model, requested: {}, send: () => undefined });
    for (let index = 0; index < calls; index += 1) tracker.observe({ type: "message_end", message: await runtime.completeSimple(runtime.getModel("rovara-route", MODEL)!, context, { maxRetries: 0, maxRetryDelayMs: 0 }) });
    const report = tracker.endReport(nothing, model, "FAILED", {});
    if (send && report !== undefined) await createUsageBooking({ store, metering: meter, now }).bookOperationEvents({ id: operationId, workspaceId, companyId: A }, [{ type: "usage", timestamp: new Date(START).toISOString(), payload: report }]);
    return report;
  };
  return { clock, store, approve, failRun, reasons, spend, taskId };
}

describe("journey 13b's gap: every model call failed with no HTTP status", () => {
  it("a) the new worker's zero report is booked and Approve passes at once", async () => {
    const w = await world();
    const report = await w.failRun(4, true);
    expect(report).toMatchObject({ outcome: "FAILED", refusedBeforeStreamCalls: 4 });
    expect(await w.approve()).toBeUndefined();
    expect(await w.spend(w.taskId)).toBe(0);
    expect(w.reasons).toEqual([]);
  });

  it("b) a worker that sent nothing: until the grace passes Approve says the real reason (the stable code), then the broker settles the run and Approve passes", async () => {
    const w = await world();
    expect(await w.failRun(4, false)).toBeDefined();
    const early = await w.approve();
    expect(early).toBeInstanceOf(SubjectRefusal);
    expect(early!.code).toBe("spend_unreadable");
    expect(w.reasons).toEqual(["run_unreported"]);
    w.clock.now += UNREPORTED_SETTLE_GRACE_MS + 1_000;
    expect(await w.approve()).toBeUndefined();
    // Nothing was knowable, so only the hold's room ($2) is booked, as a marked estimate: never zero here, and far under the cap.
    expect(await w.spend(w.taskId)).toBe(2);
  });
});

describe("an estimate alone never ends a task at its limit (arch ruling on case iii)", () => {
  it("under a $5 cap and under a $6 cap, a silent failed run's estimate (the hold's $2) leaves Approve open; the fixed top-up would have said 'used its run limit'", async () => {
    for (const cap of [5, 6]) {
      const w = await world(cap);
      await w.failRun(4, false);
      w.clock.now += UNREPORTED_SETTLE_GRACE_MS + 1_000;
      expect(await w.approve(), `cap ${String(cap)}`).toBeUndefined();
      expect(await w.spend(w.taskId)).toBe(2);
    }
  });
});

describe("the card says the real reason, in the one words table", () => {
  it("maps the stable code to its own card reason and words, never to 'isn't ready to be decided yet'", () => {
    expect(CARD_REFUSAL_OF_GATE.spend_unreadable).toBe("spend_unreadable");
    expect(CARD_REFUSAL_OF_GATE.invalid_outcome).toBe("not_ready");
    const refusal = DECISION_REFUSALS.spend_unreadable;
    expect(refusal.code).toBe("MERGE_NOT_READY");
    expect(refusal.message).toBe(spendUnreadableWords());
    expect(refusal.message).toContain("Rovara could not read this task's spend yet");
    expect(refusal.message).toContain(STATUS_LINES.spendUnreadable.next);
    expect(refusal.message).not.toContain("isn't ready");
    expect(DECISION_REFUSALS.not_ready.message).toBe("This isn't ready to be decided yet.");
  });

  it("the local pages and the PR commands say it too", () => {
    expect(localResultOf({ status: "refused", reason: "spend_unreadable", detail: "x" })).toEqual({ ok: false, reason: "refused", message: spendUnreadableWords() });
  });
});
