import { describe, expect, it } from "vitest";
import { change, ROVARA_AI_PAUSED_MESSAGE } from "@agentx/contracts";
import { onOperationEnded, runDispatchRow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { dispatchRowKey, operationKey, taskKey, taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readOperation } from "../../packages/broker/src/core/task-flow/results.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { dispatchRowItem } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { acceptedCloseForRun } from "../../packages/broker/src/core/task-flow/close-recovery-state.js";
import { closeRecoveryHarness } from "../support/close-recovery-harness.js";
import { COMPANY } from "../support/task-flow-harness.js";
import { blockedReview, operationsOf, seed, seedPlain, taskOf, TASK_ID, WORKSPACE_ID } from "../support/task-actions-world.js";

describe("existing close and revision fences", () => {
  it("a Close-claimed planning row is resolved STALE while the workspace is CLOSING", async () => {
    const { h } = await seed({ workflow: blockedReview({ stage: "PLAN", state: "READY", definitionVersion: "1.0.0", blockReason: undefined }),
      task: { closeOperationId: "accepted-close" }, workspace: { status: "CLOSING", activeOperationId: "accepted-close", fence: 2 } });
    const key = dispatchRowKey(COMPANY, TASK_ID, 6);
    await h.store.put({ item: dispatchRowItem(h.deps, TASK_ID, 6, "PLAN", new Date(h.clock.now).toISOString()).item });
    expect(await runDispatchRow(h.deps, { taskId: TASK_ID, workflowRevision: 6, kind: "PLAN" })).toBe("STALE");
    expect(await h.store.get(key)).toBeUndefined();
    expect(await operationsOf(h)).toHaveLength(0);
    expect((await taskOf(h)).workflow).toMatchObject({ stage: "PLAN", state: "READY", revision: 6 });
  });

  it.each([5, 6])("AI-stop from operation revision %s only blocks its own current revision", async revision => {
    const { h } = await seedPlain();
    const operation = (await operationsOf(h))[0]!;
    await h.store.update({ key: taskKey(TASK_ID), ops: [change.set("workflow", toDocument(blockedReview({ stage: "PLAN", state: "RUNNING", blockReason: undefined })))] });
    await h.store.put({ item: { ...taskPointerKey(COMPANY, WORKSPACE_ID), taskId: TASK_ID } });
    const before = (await taskOf(h)).workflow;
    await onOperationEnded(h.deps, { ...operation, workflowMode: "PLAN", workflowRevision: revision }, { status: "FAILED", error: `MODEL_NOT_ALLOWED: ${ROVARA_AI_PAUSED_MESSAGE}` });
    if (revision === 5) expect((await taskOf(h)).workflow).toEqual(before);
    else expect((await taskOf(h)).workflow).toMatchObject({ state: "BLOCKED", blockReason: ROVARA_AI_PAUSED_MESSAGE });
    expect(await operationsOf(h)).toHaveLength(1);
  });

  it("a QUEUED run retained by Close is dropped without becoming INTERRUPTED", async () => {
    const w = await closeRecoveryHarness();
    await w.h.store.update({ key: w.runKey, ops: [change.set("status", "QUEUED")] });
    // Leave the accepted Close pending, as after a process restart before its recovery consumer runs.
    w.h.deps.resumeAcceptedClose = async () => {};
    await w.h.flow.close(w.h.owner, w.task.taskId, w.input);
    const run = (await readOperation(w.h.deps, w.task.workspaceId, w.run.id))!;
    expect(run.status).toBe("QUEUED");
    expect(await acceptedCloseForRun(w.h.deps, run)).toBeDefined();
    expect(await w.h.store.get(w.wk)).toMatchObject({ status: "CLOSING" });
    const queue = await w.h.queues.queue("task-dispatch");
    for (const message of await queue.receive({ maxMessages: 10 })) await queue.ack(message.receiptHandle);
    await queue.enqueue({ dedupeId: "pin-existing-close-redelivery", body: { v: 1, companyId: w.h.deps.companyId, workspaceId: run.workspaceId, operationId: run.id } });
    const before = await w.h.store.get(operationKey(w.h.deps.companyId, run.workspaceId, run.id));
    expect(await w.h.flow.dispatchOnce({ maxMessages: 10 })).toMatchObject({ dropped: 1, failed: 0, delivered: 0 });
    expect(await w.h.store.get(w.runKey)).toEqual(before);
    expect((await queue.receive({ maxMessages: 10 })).some(message => (message.body as { operationId?: string }).operationId === run.id)).toBe(false);
    expect((await queue.listDeadLetters()).items).toHaveLength(0);
  });
});
