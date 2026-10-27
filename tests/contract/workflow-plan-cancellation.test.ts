// PLANINC-2: stopping a workflow step's run (planning, coding, checks, review, feedback review) blocks that step, so Retry is
// offered; a step stranded RUNNING by an earlier release is recovered by the owner's Retry planning; and the extra
// workflow write in the cancel's transaction never fails the cancel.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_BLOCK_REASONS, WorkflowFeedbackBundleSchema, WorkflowSnapshotSchema, collectWorkflowFeedbackBundles, createCandidateManifest, createWorkflowSnapshot, type WorkflowSnapshot } from "@agentx/contracts";
import { startTaskWorkflowFeedbackReviewFromWebhook } from "../../packages/broker/src/aws/developer-tasks.js";
import { releaseFailedCancelWorkspace } from "../../packages/broker/src/aws/failed-cancel-release.js";
import { sweepStuckCancels } from "../../packages/broker/src/aws/stuck-cancels.js";
import { stopBlocksWorkflowStep, strandedPlanningRun, type StoppedRunOperation, type StoppedRunTask } from "../../packages/broker/src/aws/workflow-cancel-reconcile.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

type Harness = Awaited<ReturnType<typeof createSingleAnswerPlanBroker>>;
type Row = Record<string, unknown>;

const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const operationOf = (harness: Harness, workspaceId: string, mode: string) => operations(harness, workspaceId).find((item) => item.workflowMode === mode)!;
const taskRow = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Row & { workflow: WorkflowSnapshot; workspaceId: string; ownerKey: string };
const taskWorkflow = (harness: Harness, taskId: string) => taskRow(harness, taskId).workflow;
const workspaceRow = (harness: Harness, workspaceId: string) => harness.db.get(`WORKSPACE#${workspaceId}`, "META") as Row;
const dispatchRows = (harness: Harness) => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
/** The rows that would start a step. The AUTOFIX row of a blocked VERIFY or REVIEW step starts nothing: it has the policy look at the block. */
const stepRows = (harness: Harness) => dispatchRows(harness).filter((item) => item.kind !== "AUTOFIX");
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });

/** A Quick workflow task whose preparation finished: planning is running (the worker reported RUNNING). */
async function planningTask(harness: Harness) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const workspaceId = taskRow(harness, taskId).workspaceId;
  harness.db.set({ ...taskRow(harness, taskId), workflow: { ...taskWorkflow(harness, taskId), checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
  const plan = operationOf(harness, workspaceId, "PLAN");
  await harness.events(workspaceId, String(plan.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
  return { taskId, workspaceId, plan };
}

/** The owner's stop: the task's cancel request, then the worker's cancel result for the operation. Returns the cancel operation. */
async function requestStop(harness: Harness, taskId: string, workspaceId: string, targetId: string): Promise<Row> {
  const stop = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/cancel`, { requestId: randomUUID() });
  expect(stop.status).toBe(200);
  return operations(harness, workspaceId).find((item) => item.kind === "cancel" && item.targetOperationId === targetId)!;
}
const finishStop = async (harness: Harness, workspaceId: string, cancel: Row, status: "SUCCEEDED" | "FAILED" = "SUCCEEDED") => harness.finish(workspaceId, String(cancel.id), status);

/** A Quick task whose plan was approved and is being implemented. */
async function implementingTask(harness: Harness) {
  const { taskId, workspaceId, plan } = await planningTask(harness);
  const markdown = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(plan.id), markdown);
  const digest = createHash("sha256").update(markdown).digest("hex");
  const approved = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: taskWorkflow(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
  expect(approved.status).toBe(200);
  const implementation = operationOf(harness, workspaceId, "IMPLEMENT");
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  return { taskId, workspaceId, implementation, candidate };
}

/**
 * Moves the task row (a harmless revision bump, as a concurrent writer would) right before each of the next `times`
 * cancel transactions that carry the workflow step, so their condition really fails. Returns how many it moved.
 */
function moveTaskRowOnTransactions(harness: Harness, taskId: string, workspaceId: string, times: number): () => number {
  let moved = 0;
  harness.db.injectFault({ command: "TransactWriteCommand", error: { name: "UNUSED" }, match: (input) => {
    const items = (input.TransactItems ?? []) as Array<{ Update?: { Key?: { pk?: string }; UpdateExpression?: string } }>;
    const withStep = items.some((item) => item.Update?.Key?.pk === `DEVTASK#${taskId}` && item.Update.UpdateExpression?.startsWith("SET workflow = :workflow"))
      && items.some((item) => item.Update?.Key?.pk === `WORKSPACE#${workspaceId}`);
    if (withStep && moved < times) {
      moved += 1;
      const row = taskRow(harness, taskId);
      harness.db.set({ ...row, workflow: { ...row.workflow, revision: row.workflow.revision + 1 } });
    }
    return false;
  } });
  return () => moved;
}

/** Runs `run` with the broker's console log captured (and silenced); returns what it logged. */
async function silently<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, lines: log.mock.calls.map((call) => String(call[0])) };
  } finally { log.mockRestore(); }
}

describe("PLANINC-2: stopping a planning run", () => {
  it("blocks planning in the cancel's own transaction, and Retry planning then starts exactly one new run", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const before = taskWorkflow(harness, taskId);
    expect([before.stage, before.state]).toEqual(["PLAN", "RUNNING"]);
    const operationsBefore = operations(harness, workspaceId).length;

    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    await finishStop(harness, workspaceId, cancel);

    const blocked = taskWorkflow(harness, taskId);
    expect(blocked).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended cancelled", revision: before.revision + 1 });
    expect(blocked.decisions).toEqual(before.decisions);
    expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
    expect(workspaceRow(harness, workspaceId)).not.toHaveProperty("activeOperationId");
    expect(operations(harness, workspaceId).find((item) => item.id === plan.id)).toMatchObject({ status: "CANCELLED" });
    // A cancel queues nothing: no dispatch row, no new operation.
    expect(dispatchRows(harness)).toEqual([]);
    expect(operations(harness, workspaceId)).toHaveLength(operationsBefore + 1);

    // The worker's own late CANCELLED result, and a repeated cancel callback, move nothing.
    await harness.finish(workspaceId, String(plan.id), "CANCELLED", { error: "operation was cancelled" });
    await finishStop(harness, workspaceId, cancel);
    expect(taskWorkflow(harness, taskId)).toEqual(blocked);

    // The incident's second symptom: Retry planning used to answer 400. It starts one run now, once.
    const requestId = randomUUID();
    const retry = { requestId, instructions: "Try again", expectedRevision: blocked.revision };
    const first = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, retry);
    expect(first.status).toBe(200);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING", revision: blocked.revision + 1 });
    const second = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, retry);
    expect(second.status).toBe(200);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
    expect(taskWorkflow(harness, taskId).decisions).toEqual(before.decisions);
  });

  it("keeps a plan that was saved before the stop landed: the cancel records only itself", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    // The planner finished first: its plan is saved and the step moved to review, then the stop's result arrives.
    await finishPlanningWithMarkdown(harness, workspaceId, String(plan.id), "# Plan\n\n1. Fix it.\n");
    const saved = taskWorkflow(harness, taskId);
    expect(saved.state).not.toBe("BLOCKED");
    await finishStop(harness, workspaceId, cancel);
    expect(taskWorkflow(harness, taskId)).toEqual(saved);
    expect(operations(harness, workspaceId).find((item) => item.id === cancel.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(operations(harness, workspaceId).find((item) => item.id === plan.id)).toMatchObject({ status: "SUCCEEDED" });
  });

  it("decides the cancel again with the current step when the task row moved between the read and the commit", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    const before = taskWorkflow(harness, taskId);
    const moved = moveTaskRowOnTransactions(harness, taskId, workspaceId, 1);
    const { lines } = await silently(() => finishStop(harness, workspaceId, cancel));
    expect(moved()).toBe(1);
    expect(lines.some((line) => line.includes("workflow.cancel_step_dropped"))).toBe(false);
    // The step was recomputed against the row as it is now: blocked, one revision after the move.
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended cancelled", revision: before.revision + 2 });
    expect(operations(harness, workspaceId).find((item) => item.id === plan.id)).toMatchObject({ status: "CANCELLED" });
  });

  it("commits the cancel without the step after a second refusal, and blocks the step right after", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    const before = taskWorkflow(harness, taskId);
    const moved = moveTaskRowOnTransactions(harness, taskId, workspaceId, 2);
    const { lines } = await silently(() => finishStop(harness, workspaceId, cancel));
    expect(moved()).toBe(2);
    expect(lines.some((line) => line.includes("workflow.cancel_step_dropped"))).toBe(true);
    expect(operations(harness, workspaceId).find((item) => item.id === plan.id)).toMatchObject({ status: "CANCELLED" });
    expect(operations(harness, workspaceId).find((item) => item.id === cancel.id)).toMatchObject({ status: "SUCCEEDED" });
    expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended cancelled", revision: before.revision + 3 });
  });

  it("still commits the cancel when the step is dropped and the block after it is lost too, leaving Retry planning to recover it", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    moveTaskRowOnTransactions(harness, taskId, workspaceId, 2);
    // The block after the commit is a transaction with a workspace ConditionCheck; it fails once.
    harness.db.injectFault({ command: "TransactWriteCommand", times: 1, error: { name: "TransactionCanceledException" },
      match: (input) => ((input.TransactItems ?? []) as Array<{ ConditionCheck?: unknown }>).some((item) => item.ConditionCheck !== undefined) });
    await silently(() => finishStop(harness, workspaceId, cancel));
    expect(operations(harness, workspaceId).find((item) => item.id === plan.id)).toMatchObject({ status: "CANCELLED" });
    expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: taskWorkflow(harness, taskId).revision });
    expect(retry.status).toBe(200);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
  });

  it("retries the cancel's transaction with the step when it only met another transaction in flight", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    harness.db.injectFault({ command: "TransactWriteCommand", times: 1,
      match: (input) => JSON.stringify(input).includes(`DEVTASK#${taskId}`) && JSON.stringify(input).includes("OPERATION#" + String(cancel.id)),
      error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "TransactionConflict" }] } });
    await finishStop(harness, workspaceId, cancel);
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended cancelled" });
  });
});

describe("PLANINC-2: a planning step stranded RUNNING by an earlier release", () => {
  /** The stored shape the previous code left: the plan CANCELLED, the workspace READY, the workflow PLAN/RUNNING. */
  async function strandedPlanning(harness: Harness) {
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const stored = structuredClone(taskRow(harness, taskId));
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    await finishStop(harness, workspaceId, cancel);
    expect(taskWorkflow(harness, taskId).state).toBe("BLOCKED");
    harness.db.set(stored);
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    return { taskId, workspaceId, plan, stranded: stored.workflow };
  }

  it("shows the stranded step as blocked and lets Retry planning start one run, once", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, stranded } = await strandedPlanning(harness);
    const viewed = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { workflow: { state: string; stage: string; blockReason?: string; revision: number } };
    expect(viewed.workflow).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended cancelled", revision: stranded.revision });
    // A read never writes: the stored row still says RUNNING.
    expect(taskWorkflow(harness, taskId).state).toBe("RUNNING");

    const stale = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: stranded.revision + 5 });
    expect(stale.status).toBe(409);
    expect(taskWorkflow(harness, taskId)).toEqual(stranded);

    const request = { requestId: randomUUID(), instructions: "Try again", expectedRevision: viewed.workflow.revision };
    const first = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, request);
    expect(first.status).toBe(200);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "RUNNING", revision: stranded.revision + 2 });
    expect(taskWorkflow(harness, taskId).decisions).toEqual(stranded.decisions);
    expect(dispatchRows(harness)).toEqual([]);
    const second = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, request);
    expect(second.status).toBe(200);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
  });

  it("refuses, changing nothing, when the workspace is taken between the check and the block", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, stranded } = await strandedPlanning(harness);
    let taken = 0;
    harness.db.injectFault({ command: "TransactWriteCommand", error: { name: "UNUSED" }, match: (input) => {
      const items = (input.TransactItems ?? []) as Array<{ ConditionCheck?: unknown }>;
      if (items.some((item) => item.ConditionCheck !== undefined) && taken === 0) {
        taken += 1;
        harness.db.set({ ...workspaceRow(harness, workspaceId), status: "BUSY", activeOperationId: randomUUID() });
      }
      return false;
    } });
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: stranded.revision });
    expect(taken).toBe(1);
    expect(retry.status).toBe(409);
    expect(taskWorkflow(harness, taskId)).toEqual(stranded);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(1);
  });

  it("refuses, changing nothing, when the planning run's own record changes between the check and the block", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan, stranded } = await strandedPlanning(harness);
    let changed = 0;
    harness.db.injectFault({ command: "TransactWriteCommand", error: { name: "UNUSED" }, match: (input) => {
      const items = (input.TransactItems ?? []) as Array<{ ConditionCheck?: unknown }>;
      if (items.some((item) => item.ConditionCheck !== undefined) && changed === 0) {
        changed += 1;
        // The run ends another way (the fence moved on) after the retry read it.
        harness.db.set({ ...operations(harness, workspaceId).find((item) => item.id === plan.id)!, status: "SUCCEEDED" });
      }
      return false;
    } });
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: stranded.revision });
    expect(changed).toBe(1);
    expect(retry.status).toBe(409);
    expect(taskWorkflow(harness, taskId)).toEqual(stranded);
  });

  it("never touches planning that is really running: the view says running and Retry is refused as before", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId } = await planningTask(harness);
    const before = taskWorkflow(harness, taskId);
    const viewed = (await harness.dev(MAYA, "GET", `/v1/dev/tasks/${taskId}`)).body.task as { workflow: { state: string } };
    expect(viewed.workflow.state).toBe("RUNNING");
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: before.revision });
    expect(retry.status).toBe(400);
    expect(String((retry.body.error as { message: string }).message)).toContain("can retry blocked planning");
    expect(taskWorkflow(harness, taskId)).toEqual(before);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(1);
  });

  it("leaves a step alone while a failed stop keeps the workspace held, and recovers it once the reconciler frees the workspace", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const stored = structuredClone(taskRow(harness, taskId));
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    // The stop failed: the plan is INTERRUPTED and still holds the workspace, as the worker may still run it.
    await finishStop(harness, workspaceId, cancel, "FAILED");
    harness.db.set(stored);
    const interrupted = operations(harness, workspaceId).find((item) => item.id === plan.id)!;
    expect(interrupted.status).toBe("INTERRUPTED");
    expect(workspaceRow(harness, workspaceId).activeOperationId).toBe(plan.id);
    const held = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: stored.workflow.revision });
    expect(held.status).toBe(400);
    expect(taskWorkflow(harness, taskId)).toEqual(stored.workflow);

    // The reconciler's sweep frees the workspace (compute gone): nothing told the workflow.
    expect(await releaseFailedCancelWorkspace(harness.db, "state", { workspaceId, operationId: String(plan.id) }, interrupted, "compute-gone", new Date())).toBe(true);
    expect(taskWorkflow(harness, taskId)).toEqual(stored.workflow);
    const retry = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Try again", expectedRevision: stored.workflow.revision });
    expect(retry.status).toBe(200);
    expect(operations(harness, workspaceId).filter((item) => item.workflowMode === "PLAN")).toHaveLength(2);
  });
});

describe("PLANINC-2: the stuck-cancel release", () => {
  it("blocks the step when the INTERRUPTED task's own late result frees its workspace", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const before = taskWorkflow(harness, taskId);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    await finishStop(harness, workspaceId, cancel, "FAILED");
    expect(taskWorkflow(harness, taskId)).toEqual(before);
    expect(workspaceRow(harness, workspaceId).activeOperationId).toBe(plan.id);

    await harness.finish(workspaceId, String(plan.id), "FAILED", { error: "the worker ended the task" });
    expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended interrupted", revision: before.revision + 1 });
    // A repeated result changes nothing.
    await harness.finish(workspaceId, String(plan.id), "FAILED", { error: "the worker ended the task" });
    expect(taskWorkflow(harness, taskId).revision).toBe(before.revision + 1);
    expect(dispatchRows(harness)).toEqual([]);
  });

  it("blocks the step when the task's own late result arrives after the reconciler already freed the workspace", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const before = taskWorkflow(harness, taskId);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    await finishStop(harness, workspaceId, cancel, "FAILED");
    const interrupted = operations(harness, workspaceId).find((item) => item.id === plan.id)!;
    expect(await releaseFailedCancelWorkspace(harness.db, "state", { workspaceId, operationId: String(plan.id) }, interrupted, "compute-gone", new Date())).toBe(true);
    expect(taskWorkflow(harness, taskId)).toEqual(before);
    await harness.finish(workspaceId, String(plan.id), "FAILED", { error: "late" });
    expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended interrupted", revision: before.revision + 1 });
  });

  it("does not block a step a newer run holds the workspace for", async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, plan } = await planningTask(harness);
    const before = taskWorkflow(harness, taskId);
    const cancel = await requestStop(harness, taskId, workspaceId, String(plan.id));
    await finishStop(harness, workspaceId, cancel, "FAILED");
    // The reconciler freed the workspace, and a newer run now holds it (the owner's next request).
    const interrupted = operations(harness, workspaceId).find((item) => item.id === plan.id)!;
    await releaseFailedCancelWorkspace(harness.db, "state", { workspaceId, operationId: String(plan.id) }, interrupted, "compute-gone", new Date());
    harness.db.set({ ...workspaceRow(harness, workspaceId), status: "BUSY", activeOperationId: randomUUID() });
    await harness.finish(workspaceId, String(plan.id), "FAILED", { error: "late" });
    expect(taskWorkflow(harness, taskId)).toEqual(before);
  });
});

/** Each workflow step a stopped run can leave RUNNING, started so its run is active: its harness, the run, and the owner's Retry for it. */
interface StartedStep { harness: Harness; taskId: string; workspaceId: string; run: Row; stage: string; reason: string; retry?: (revision: number) => Promise<{ status: number }> }
const STEPS: Record<string, { name: string; start: () => Promise<StartedStep>; revisionBoundRun?: true }> = {
  IMPLEMENT: { name: "plain coding (no work breakdown)", start: async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, implementation } = await implementingTask(harness);
    await harness.events(workspaceId, String(implementation.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    return { harness, taskId, workspaceId, run: implementation, stage: "IMPLEMENT", reason: "implementation operation ended",
      retry: (revision) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Code it again", expectedRevision: revision }) };
  } },
  CHECKS: { name: "a checks-only retry (no native E2E round)", start: async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, implementation, candidate } = await implementingTask(harness);
    // The final checks report is unreadable, so verification blocks; the owner's retry then runs the checks alone.
    await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: "not a report" } });
    const blocked = taskWorkflow(harness, taskId);
    expect([blocked.stage, blocked.state]).toEqual(["VERIFY", "BLOCKED"]);
    const first = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Run the checks again", expectedRevision: blocked.revision });
    expect(first.status).toBe(200);
    const checks = operationOf(harness, workspaceId, "CHECKS");
    await harness.events(workspaceId, String(checks.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    return { harness, taskId, workspaceId, run: checks, stage: "VERIFY", reason: "verification retry operation ended",
      retry: (revision) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Run the checks again", expectedRevision: revision }) };
  } },
  REVIEW: { name: "an independent review", start: async () => {
    const harness = await createSingleAnswerPlanBroker();
    const { taskId, workspaceId, implementation, candidate } = await implementingTask(harness);
    await harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
    const review = operationOf(harness, workspaceId, "REVIEW");
    await harness.events(workspaceId, String(review.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    return { harness, taskId, workspaceId, run: review, stage: "REVIEW", reason: "independent review operation ended",
      retry: (revision) => harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/review`, { requestId: randomUUID(), expectedRevision: revision, candidateDigest: candidate.digest, instructions: "Review again" }) };
  } },
  // Its Retry is the existing feedback-review route, on the same blocked shape a failed critic leaves.
  FEEDBACK_REVIEW: { name: "a pull request feedback review", revisionBoundRun: true, start: async () => {
    const currentFeedback = { pullRequest: { number: 7, url: "https://github.com/example/demo/pull/7", state: "open" as const,
      headBranch: "feature", baseBranch: "main", headCommit: "a".repeat(40), headTreeSha: "b".repeat(40), title: "Fix retry", body: "" }, comments: [], threads: [] };
    const harness = await createSingleAnswerPlanBroker({ brokerExtra: { githubPullRequests: { getPullRequestFeedback: async () => currentFeedback } } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const workspaceId = taskRow(harness, taskId).workspaceId;
    await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")!.id), "SUCCEEDED", PREPARED);
    await harness.finish(workspaceId, String(operationOf(harness, workspaceId, "PLAN").id), "FAILED", { error: "test setup advances the workspace to READY" });
    const task = taskRow(harness, taskId);
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
    const now = new Date().toISOString();
    const planSha = createHash("sha256").update("Approved plan").digest("hex");
    const planKey = `private/${String(task.ownerKey)}/${workspaceId}/approved-plan.md`;
    harness.s3.objects.set(planKey, "Approved plan");
    let workflow = WorkflowSnapshotSchema.parse({
      ...createWorkflowSnapshot({ taskId, ownerId: String(task.ownerKey), now }),
      stage: "WAIT_FOR_MERGE", state: "WAITING", candidate,
      artifacts: [{ id: "plan-v1", type: "plan", version: 1, sha256: planSha, producer: "agentx-owner-approved", objectKey: planKey, createdAt: now }],
      decisions: [{ requestId: randomUUID(), workflowRevision: 1, decision: "APPROVE", actorId: String(task.ownerKey), actorRole: "TASK_OWNER", reason: "Approved plan", artifactDigest: planSha, at: now }],
      verification: { candidateDigest: candidate.digest, producer: "broker", environmentId: workspaceId, recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
      pullRequests: [{ repositoryId: "demo", number: 7, url: "https://github.com/example/demo/pull/7", headSha: "a".repeat(40), candidateDigest: candidate.digest, required: true, state: "OPEN" }],
    });
    const commentSetDigest = createHash("sha256").update("[]").digest("hex");
    const bundle = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId, repositoryId: "demo", number: 7, headSha: "a".repeat(40), headTreeSha: "b".repeat(40),
      candidateDigest: candidate.digest, commentSetDigest, producer: "agentx-github-reconciler", version: "1", recordedAt: now, comments: [], sourceDeliveryIds: ["delivery-test"] });
    const bundleBytes = JSON.stringify(bundle);
    const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
    const bundleKey = `private/${String(task.ownerKey)}/${workspaceId}/feedback/${bundleDigest}.json`;
    harness.s3.objects.set(bundleKey, bundleBytes);
    const { sourceDeliveryIds: deliveryIds, comments, ...metadata } = bundle;
    void deliveryIds;
    workflow = collectWorkflowFeedbackBundles(workflow, { bundleRefs: [{ ...metadata, sha256: bundleDigest, objectKey: bundleKey, comments }], threadObservations: [] }, now);
    harness.db.set({ ...task, workflow, updatedAt: now });
    const routeDeps = { documentClient: harness.db, tableName: "state", actions: harness.actions,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }), projectChannelIds: async () => [], now: () => Date.parse(now) };
    expect(await startTaskWorkflowFeedbackReviewFromWebhook(routeDeps as never, taskId)).toBe(true);
    const critic = operationOf(harness, workspaceId, "FEEDBACK_REVIEW");
    const running = taskWorkflow(harness, taskId);
    expect([running.stage, running.state]).toEqual(["WAIT_FOR_MERGE", "RUNNING"]);

    return { harness, taskId, workspaceId, run: critic, stage: "WAIT_FOR_MERGE", reason: WORKFLOW_BLOCK_REASONS.feedbackReviewFailed };
  } },
};

const sweepStuck = (harness: Harness, workspaceId: string, at: Date = new Date()) =>
  sweepStuckCancels({ client: harness.db, tableName: "state" }, [{ workspaceId, compute: "gone" }], at);

describe("PLANINC-2: every other workflow step", () => {
  for (const step of Object.values(STEPS)) {
    const reasonFor = (started: StartedStep, ended: string) => started.reason === WORKFLOW_BLOCK_REASONS.feedbackReviewFailed ? started.reason : `${started.reason} ${ended}`;

    it(`blocks ${step.name} when it is stopped, queuing nothing`, async () => {
      const started = await step.start();
      const { harness, taskId, workspaceId } = started;
      const running = taskWorkflow(harness, taskId);
      expect([running.stage, running.state]).toEqual([started.stage, "RUNNING"]);
      const operationsBefore = operations(harness, workspaceId).length;
      const cancel = await requestStop(harness, taskId, workspaceId, String(started.run.id));
      await finishStop(harness, workspaceId, cancel);
      expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: started.stage, state: "BLOCKED", blockReason: reasonFor(started, "cancelled"), revision: running.revision + 1 });
      expect(taskWorkflow(harness, taskId).decisions).toEqual(running.decisions);
      expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
      expect(dispatchRows(harness)).toEqual([]);
      expect(operations(harness, workspaceId)).toHaveLength(operationsBefore + 1);
      if (started.retry !== undefined) expect((await started.retry(taskWorkflow(harness, taskId).revision)).status).toBe(200);
    });

    it(`blocks ${step.name} when the reconciler frees the workspace of a stop that failed, with no late result`, async () => {
      const started = await step.start();
      const { harness, taskId, workspaceId } = started;
      const running = taskWorkflow(harness, taskId);
      const operationsBefore = operations(harness, workspaceId).length;
      const cancel = await requestStop(harness, taskId, workspaceId, String(started.run.id));
      await finishStop(harness, workspaceId, cancel, "FAILED");
      expect(taskWorkflow(harness, taskId)).toEqual(running);
      expect(workspaceRow(harness, workspaceId).activeOperationId).toBe(started.run.id);
      expect((await sweepStuck(harness, workspaceId)).interrupted).toEqual([started.run.id]);
      expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: started.stage, state: "BLOCKED", blockReason: reasonFor(started, "interrupted"), revision: running.revision + 1 });
      expect(taskWorkflow(harness, taskId).decisions).toEqual(running.decisions);
      expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
      expect(stepRows(harness)).toEqual([]); // DISPATCHEXHAUST: no step is queued; the block of a VERIFY or REVIEW step carries its AUTOFIX row (workflow-autofix-dispatch-exhaust.test.ts)
      expect(operations(harness, workspaceId)).toHaveLength(operationsBefore + 1);
      if (started.retry !== undefined) expect((await started.retry(taskWorkflow(harness, taskId).revision)).status).toBe(200);
      // The sweep again changes nothing.
      const after = taskWorkflow(harness, taskId);
      await sweepStuck(harness, workspaceId);
      expect(taskWorkflow(harness, taskId)).toEqual(after);
    });

    it(`blocks ${step.name} when the reconciler ends a stop that never answered because the compute is gone`, async () => {
      const started = await step.start();
      const { harness, taskId, workspaceId } = started;
      const running = taskWorkflow(harness, taskId);
      const operationsBefore = operations(harness, workspaceId).length;
      await requestStop(harness, taskId, workspaceId, String(started.run.id));
      expect(workspaceRow(harness, workspaceId).activeOperationId).toBe(started.run.id);
      expect((await sweepStuck(harness, workspaceId, new Date(Date.now() + 31 * 60_000))).ended).toEqual([started.run.id]);
      expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: started.stage, state: "BLOCKED", blockReason: reasonFor(started, "failed"), revision: running.revision + 1 });
      expect(taskWorkflow(harness, taskId).decisions).toEqual(running.decisions);
      expect(workspaceRow(harness, workspaceId)).toMatchObject({ status: "READY" });
      expect(stepRows(harness)).toEqual([]); // DISPATCHEXHAUST: no step is queued; the block of a VERIFY or REVIEW step carries its AUTOFIX row (workflow-autofix-dispatch-exhaust.test.ts)
      expect(operations(harness, workspaceId)).toHaveLength(operationsBefore + 1);
      if (started.retry !== undefined) expect((await started.retry(taskWorkflow(harness, taskId).revision)).status).toBe(200);
    });

    // A feedback review is bound to the workflow revision it started at: a moved revision supersedes it, so it is not blocked.
    if (step.revisionBoundRun !== true) it(`blocks ${step.name} right after a cancel that had to drop its workflow item`, async () => {
      const started = await step.start();
      const { harness, taskId, workspaceId } = started;
      const running = taskWorkflow(harness, taskId);
      const cancel = await requestStop(harness, taskId, workspaceId, String(started.run.id));
      moveTaskRowOnTransactions(harness, taskId, workspaceId, 2);
      await silently(() => finishStop(harness, workspaceId, cancel));
      expect(operations(harness, workspaceId).find((item) => item.id === started.run.id)).toMatchObject({ status: "CANCELLED" });
      expect(taskWorkflow(harness, taskId)).toMatchObject({ stage: started.stage, state: "BLOCKED", revision: running.revision + 3 });
      expect(dispatchRows(harness)).toEqual([]);
    });
  }
});

describe("PLANINC-2: which stopped runs block their step", () => {
  const workflow = (stage: string, state = "RUNNING") => ({ stage, state } as unknown as WorkflowSnapshot);
  const task = (extra: Row = {}) => ({ workspaceId: "w1", workflow: workflow("PLAN"), ...extra }) as unknown as StoppedRunTask;
  const run = (extra: Row = {}) => ({ id: "o1", workspaceId: "w1", kind: "task", status: "CANCEL_REQUESTED", fence: 1, createdAt: "2026-10-23T00:00:00.000Z", workflowMode: "PLAN", ...extra }) as unknown as StoppedRunOperation;

  it("blocks the step the run ran, and nothing else", () => {
    expect(stopBlocksWorkflowStep(task(), run())).toBe(true);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("REVIEW") }), run({ workflowMode: "REVIEW" }))).toBe(true);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("VERIFY") }), run({ workflowMode: "CHECKS" }))).toBe(true);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("WAIT_FOR_MERGE") }), run({ workflowMode: "FEEDBACK_REVIEW" }))).toBe(true);
    // An INTERRUPTED run released later still counts; a finished one never does.
    expect(stopBlocksWorkflowStep(task(), run({ status: "INTERRUPTED" }))).toBe(true);
    for (const status of ["SUCCEEDED", "FAILED", "CANCELLED"]) expect(stopBlocksWorkflowStep(task(), run({ status }))).toBe(false);
  });

  it("leaves other steps, states, closed tasks, other workspaces and runs with their own handling alone", () => {
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("IMPLEMENT") }), run())).toBe(false);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("PLAN", "BLOCKED") }), run())).toBe(false);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("PLAN", "WAITING") }), run())).toBe(false);
    expect(stopBlocksWorkflowStep(task({ closedAt: "2026-10-23T00:00:00.000Z" }), run())).toBe(false);
    expect(stopBlocksWorkflowStep(task({ workspaceId: "w2" }), run())).toBe(false);
    expect(stopBlocksWorkflowStep(task({ workflow: undefined }), run())).toBe(false);
    expect(stopBlocksWorkflowStep(task(), run({ kind: "cancel" }))).toBe(false);
    expect(stopBlocksWorkflowStep(task(), run({ workflowMode: undefined }))).toBe(false);
    // An ordered work breakdown and a native E2E round keep their own cancel items; baseline and replay rounds are never the step.
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("IMPLEMENT") }), run({ workflowMode: "IMPLEMENT", workflowDependencies: { graph: {} } }))).toBe(false);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("VERIFY") }), run({ workflowMode: "CHECKS", workflowE2EAdmission: {} }))).toBe(false);
    expect(stopBlocksWorkflowStep(task({ workflow: workflow("VERIFY") }), run({ workflowMode: "CHECKS", workflowE2EAdmission: { purpose: "baseline" } }))).toBe(false);
  });

  it("finds a stranded planning run only when nothing holds the workspace and the newest planning run ended", () => {
    const free = { id: "w1", status: "READY", fence: 3, activeOperationId: null };
    const ended = (status: string, createdAt: string, id = `o-${createdAt}`) => run({ id, status, createdAt });
    expect(strandedPlanningRun(task(), free, [ended("CANCELLED", "2026-10-23T00:00:01.000Z")])?.status).toBe("CANCELLED");
    expect(strandedPlanningRun(task(), free, [ended("SUCCEEDED", "2026-10-23T00:00:01.000Z"), ended("FAILED", "2026-10-23T00:00:02.000Z")])?.status).toBe("FAILED");
    // The newest planning run decides: an older cancelled one does not strand a step whose newest run succeeded.
    expect(strandedPlanningRun(task(), free, [ended("CANCELLED", "2026-10-23T00:00:01.000Z"), ended("SUCCEEDED", "2026-10-23T00:00:02.000Z")])).toBeUndefined();
    expect(strandedPlanningRun(task(), { ...free, activeOperationId: "o9" }, [ended("CANCELLED", "2026-10-23T00:00:01.000Z")])).toBeUndefined();
    expect(strandedPlanningRun(task(), { ...free, status: "BUSY" }, [ended("CANCELLED", "2026-10-23T00:00:01.000Z")])).toBeUndefined();
    expect(strandedPlanningRun(task(), free, [])).toBeUndefined();
    expect(strandedPlanningRun(task({ workflow: workflow("PLAN", "BLOCKED") }), free, [ended("CANCELLED", "2026-10-23T00:00:01.000Z")])).toBeUndefined();
    expect(strandedPlanningRun(task({ workflow: workflow("IMPLEMENT") }), free, [ended("CANCELLED", "2026-10-23T00:00:01.000Z")])).toBeUndefined();
    expect(strandedPlanningRun(task({ closedAt: "2026-10-23T00:00:00.000Z" }), free, [ended("CANCELLED", "2026-10-23T00:00:01.000Z")])).toBeUndefined();
  });
});
