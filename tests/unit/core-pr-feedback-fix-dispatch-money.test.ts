// LIVE-BUG (2026-11-24): on hosted, an approved PR-feedback fix always failed at dispatch. The dispatch re-check (feedbackApprovalCurrent) and the worker's feedback-approval callback both ran
// validateFeedbackApproval, which re-ran the full money check through the STRICT hosted reader (createCompanyTaskSpend), and that reader refuses while any run of the task has not ended: the fix's own
// run is ACCEPTED or RUNNING. These tests use the REAL reader over the world's store (not an unset or stubbed one). Money is checked at approval and at start; the re-check only verifies the approval.
import { describe, expect, it, vi } from "vitest";
import { change } from "@agentx/contracts";
import { reviewedFeedbackWorld, type ReviewedFeedbackWorld } from "../support/pr-feedback-world.js";
import { decidePrFeedback } from "../../packages/broker/src/core/pr-feedback/decide.js";
import { startImplementation } from "../../packages/broker/src/core/build-step/start.js";
import { readTask, workspaceOperations } from "../../packages/broker/src/core/task-flow/reads.js";
import { feedbackFixContext, validateFeedbackApproval } from "../../packages/broker/src/core/pr-feedback/fix-context.js";
import { runDispatchOnce } from "../../packages/broker/src/core/task-flow/dispatch.js";
import { costPartition } from "../../packages/broker/src/core/cost/ledger.js";
import { createCompanyTaskSpend } from "../../packages/broker/src/core-host/company-task-spend.js";

const CAP_USD = 5;

/** The task's TOTAL row as the ledger writes it, in whole US dollars. */
async function bookSpend(w: ReviewedFeedbackWorld, usd: number): Promise<void> {
  await w.h.store.put({ item: { pk: costPartition(w.h.deps.companyId, w.task.taskId), sk: "TOTAL", entityType: "COST_TOTAL", companyId: w.h.deps.companyId, taskId: w.task.taskId,
    currency: "USD", micros: usd * 1_000_000, entries: 1, unpricedEntries: 0, tokensInput: 1, tokensOutput: 1, tokensCacheRead: 0, tokensCacheWrite: 0 } });
}

/** A hosted-shaped world: the $5 cap and the real strict spend reader, with the finished review's usage already booked ($1). */
async function hostedMoneyWorld(): Promise<ReviewedFeedbackWorld> {
  const w = await reviewedFeedbackWorld();
  await bookSpend(w, 1);
  // The finished review run reported its usage (the reader asks for one entry per run that reached a worker).
  for (const run of await workspaceOperations(w.h.deps, w.task.workspaceId)) {
    await w.h.store.put({ item: { pk: costPartition(w.h.deps.companyId, w.task.taskId), sk: `ENTRY#usage:${run.id}:test`, entityType: "COST_ENTRY", companyId: w.h.deps.companyId, taskId: w.task.taskId } });
  }
  w.h.deps.taskCapUsd = async () => CAP_USD;
  w.h.deps.taskSpendUsd = createCompanyTaskSpend({ store: w.h.store, companyId: w.h.deps.companyId });
  return w;
}

const implementOf = async (w: ReviewedFeedbackWorld) => (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.workflowMode === "IMPLEMENT")!;

async function approvedAndStarted(w: ReviewedFeedbackWorld) {
  await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
  const approved = (await readTask(w.h.deps, w.task.taskId))!;
  expect(await startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision })).toBe("STARTED");
  return implementOf(w);
}

describe("an approved PR-feedback fix over the real hosted spend reader", () => {
  it("is delivered to a worker at dispatch, not failed, although its own run is open", async () => {
    const w = await hostedMoneyWorld();
    const operation = await approvedAndStarted(w);
    expect(operation.status).not.toBe("FAILED");
    // The strict reader really does refuse while this run is open (it stays strict for automatic fixing).
    await expect(w.h.deps.taskSpendUsd!(w.task.taskId)).rejects.toThrow("the task's spend could not be read");
    const start = vi.spyOn(w.h.machines, "start");
    await runDispatchOnce(w.h.deps);
    expect(start).toHaveBeenCalledOnce();
    const after = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.id === operation.id)!;
    expect(after.status).not.toBe("FAILED");
    expect(after.workflowFeedbackApproval).toEqual(operation.workflowFeedbackApproval);
    expect(JSON.stringify(after.dispatch.payload["prompt"])).toContain("Add a bounded retry.");
  });

  it("answers the worker's feedback-approval callback as authorized while the run is RUNNING", async () => {
    const w = await hostedMoneyWorld();
    const operation = await approvedAndStarted(w);
    await w.h.store.update({ key: { pk: operation.pk, sk: operation.sk }, ops: [change.set("status", "RUNNING")] });
    expect((await implementOf(w)).status).toBe("RUNNING");
    const { createCallbackHandler, CAPABILITY_HEADER } = await import("../../packages/broker/src/services/callbacks.js");
    const { CallbackCapabilities } = await import("../../packages/broker/src/callbacks.js");
    const handler = createCallbackHandler({ flow: w.h.deps, blobs: w.registry.require("object-storage"), grants: w.h.deps.repositoryGrants as never });
    const token = new CallbackCapabilities(Buffer.from(w.h.deps.callbackSigningKey)).issue({ workspaceId: operation.workspaceId,
      operationId: operation.id, fence: operation.fence, actions: ["feedback-approval"], expiresInSeconds: 100 });
    const response = await handler({ method: "POST", path: `/v1/internal/workspaces/${operation.workspaceId}/operations/${operation.id}/feedback-approval`,
      headers: { [CAPABILITY_HEADER]: token }, body: JSON.stringify(operation.workflowFeedbackApproval) });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({ authorized: true });
  });

  it("re-verifies the approval without a money check, but still refuses a changed approval", async () => {
    const w = await hostedMoneyWorld();
    const operation = await approvedAndStarted(w);
    await expect(validateFeedbackApproval(w.h.deps, operation, operation.workflowFeedbackApproval!)).resolves.toBeUndefined();
    const current = (await readTask(w.h.deps, w.task.taskId))!;
    current.workflow!.feedbackDecisions!.at(-1)!.selectedFindingIds = ["finding-2"];
    const { toDocument } = await import("../../packages/broker/src/core/task-flow/records.js");
    await w.h.store.put({ item: toDocument(current) });
    await expect(validateFeedbackApproval(w.h.deps, operation, operation.workflowFeedbackApproval!)).rejects.toBeDefined();
  });

  it("still runs the money check at approval: an over-cap task is refused and nothing is queued", async () => {
    const w = await hostedMoneyWorld();
    await bookSpend(w, CAP_USD + 1);
    await expect(decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await implementOf(w)).toBeUndefined();
  });

  it("still runs the money check at start: spend that crossed the cap after approval stops the fix before any run", async () => {
    const w = await hostedMoneyWorld();
    await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
    await bookSpend(w, CAP_USD + 1);
    const approved = (await readTask(w.h.deps, w.task.taskId))!;
    await expect(startImplementation(w.h.deps, { taskId: w.task.taskId, workflowRevision: approved.workflow!.revision })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await implementOf(w)).toBeUndefined();
  });

  it("feedbackFixContext keeps its money check by default and skips it only when told `admit: false`", async () => {
    const w = await hostedMoneyWorld();
    await decidePrFeedback(w.h.deps, w.h.owner, w.task.taskId, w.request);
    await bookSpend(w, CAP_USD + 1);
    const task = (await readTask(w.h.deps, w.task.taskId))!;
    await expect(feedbackFixContext(w.h.deps, task, task.workflow!.revision)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(feedbackFixContext(w.h.deps, task, task.workflow!.revision, { admit: true })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(feedbackFixContext(w.h.deps, task, task.workflow!.revision, { admit: false })).resolves.toMatchObject({ approval: { taskId: task.taskId } });
  });

  it("a refusal at dispatch says its real reason, never that the approval 'could not be verified' for a money check", async () => {
    const w = await hostedMoneyWorld();
    const operation = await approvedAndStarted(w);
    const current = (await readTask(w.h.deps, w.task.taskId))!;
    current.workflow!.feedbackDecisions!.at(-1)!.selectedCommentIds = ["other-comment"];
    const { toDocument } = await import("../../packages/broker/src/core/task-flow/records.js");
    await w.h.store.put({ item: toDocument(current) });
    const start = vi.spyOn(w.h.machines, "start");
    await runDispatchOnce(w.h.deps);
    expect(start).not.toHaveBeenCalled();
    const after = (await workspaceOperations(w.h.deps, w.task.workspaceId)).find(op => op.id === operation.id)!;
    expect(after.status).toBe("FAILED");
    expect(String(after.error)).toContain("The feedback approval no longer matches its evidence.");
    expect(String(after.error)).not.toContain("could not be verified");
  });
});
