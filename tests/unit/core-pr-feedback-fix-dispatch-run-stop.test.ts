// Opus money review of b731b3199 (2026-11-24): with the money check gone from the approval re-check, the hosted per-run stop's gate at dispatch (dispatch.ts RUN_START_ACTION, answered by the
// hosted Admission's runSpendState over the ledger total) is what stops an approved fix whose task crossed its cap after start. These tests wire that gate with the REAL hosted Admission.
import { describe, expect, it, vi } from "vitest";
import type { Admission } from "@agentx/contracts";
import { reviewedFeedbackWorld, type ReviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { decidePrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { costPartition, taskCostFromTotal } from "../../packages/broker/src/core/cost/ledger.js";
import { createCompanyTaskSpend } from "../../packages/broker/src/core-host/company-task-spend.js";
import { runSpendState } from "../../packages/broker/src/core-host/hosted-modules.js";
import { RUN_START_ACTION, spendStopReason } from "../../packages/broker/src/core/task-flow/money-stop.js";

const CAP_USD = 5;

async function bookSpend(w: ReviewedFeedbackWorld, usd: number): Promise<void> {
  await w.h.store.put({ item: { pk: costPartition(w.h.deps.companyId, w.task.taskId), sk: "TOTAL", entityType: "COST_TOTAL", companyId: w.h.deps.companyId, taskId: w.task.taskId,
    currency: "USD", micros: usd * 1_000_000, entries: 1, unpricedEntries: 0, tokensInput: 1, tokensOutput: 1, tokensCacheRead: 0, tokensCacheWrite: 0 } });
}

/** Hosted-shaped: $5 cap, the strict reader, the per-run stop wired, and run.start answered by the real hosted Admission over the ledger total. */
async function hostedRunStopWorld(): Promise<ReviewedFeedbackWorld> {
  const w = await reviewedFeedbackWorld();
  await bookSpend(w, 1);
  for (const run of await workspaceOperations(w.h.deps, w.task.workspaceId)) {
    await w.h.store.put({ item: { pk: costPartition(w.h.deps.companyId, w.task.taskId), sk: `ENTRY#usage:${run.id}:test`, entityType: "COST_ENTRY", companyId: w.h.deps.companyId, taskId: w.task.taskId } });
  }
  w.h.deps.taskCapUsd = async () => CAP_USD;
  w.h.deps.taskSpendUsd = createCompanyTaskSpend({ store: w.h.store, companyId: w.h.deps.companyId });
  // The harness's company is the implicit one, which the hosted Admission refuses outright; so run.start is answered with the REAL runSpendState over the ledger total,
  // mapped as hosted-modules.ts createHostedAdmission maps it (within: allowed; otherwise refused with the stop's code).
  const settings = { taskCapMicros: CAP_USD * 1_000_000, companyDayCapMicros: 1_000 * 1_000_000 };
  const ledger = { taskCost: async (companyId: string, taskId: string) => taskCostFromTotal(taskId, await w.h.store.get({ pk: costPartition(companyId, taskId), sk: "TOTAL" })) };
  const base: Admission = w.h.deps.admission;
  w.h.deps.admission = { ...base, admit: async (request) => {
    if (request.action !== RUN_START_ACTION) return base.admit(request);
    const state = await runSpendState({ store: w.h.store, ledger, settings, now: () => new Date(w.clock.ms) }, request.companyId, request.subject!.id);
    return state === "within" ? { allowed: true } : { allowed: false, code: state, message: state };
  } };
  w.h.deps.moneyStop = {};
  return w;
}

async function approveAndStart(w: ReviewedFeedbackWorld) {
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  expect(await startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision })).toBe("STARTED");
  return (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;
}

describe("an approved PR-feedback fix at dispatch, with the hosted per-run stop wired", () => {
  it("within the cap: the run.start gate admits it and a worker gets it", async () => {
    const w = await hostedRunStopWorld();
    const operation = await approveAndStart(w);
    const start = vi.spyOn(w.h.machines, "start");
    await runDispatchOnce(w.h.deps);
    expect(start).toHaveBeenCalledOnce();
    expect((await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.id === operation.id)!.status).not.toMatch(/FAILED|CANCEL/u);
  });

  it("spend that crossed the task cap after start: the run.start gate stops it before any machine, with the spend-stop words", async () => {
    const w = await hostedRunStopWorld();
    const operation = await approveAndStart(w);
    await bookSpend(w, CAP_USD + 1);
    const start = vi.spyOn(w.h.machines, "start");
    await runDispatchOnce(w.h.deps);
    expect(start).not.toHaveBeenCalled();
    const after = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.id === operation.id)!;
    expect(after.status).toBe("CANCELLED");
    expect(String(after.error)).toBe(spendStopReason("task_cap"));
  });
});
