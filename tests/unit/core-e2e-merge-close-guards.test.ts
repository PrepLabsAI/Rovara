import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { blockWorkflow, startWorkflowPlanWithoutUnderstand } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument, fromDocument, type OperationRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { acceptStep, blockTaskWorkflow, commitWorkflow, onOperationEnded, readWorkspace, runDispatchRow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";

async function fixture(closing: boolean, understandFirst = false) {
  const h = createHarness({ understandFirst });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Inspect the task", workflow: true, workflowPath: "QUICK" });
  const task = (await readTask(h.deps, started.task.taskId))!;
  if (closing) await h.store.put({ item: toDocument({ ...task, closeOperationId: randomUUID() }) });
  return { h, task };
}

describe("accepted Close fences retained by the merge", () => {
  it.each([false, true])("acceptance fences Close independently of the comments counter (closing %s)", async (closing) => {
    const { h, task: initial } = await fixture(false);
    const task = { ...initial, workflow: { ...initial.workflow!, state: "READY" as const } };
    const workspace = { ...(await readWorkspace(h.deps, task.workspaceId))!, status: "READY" as const, activeOperationId: null };
    await h.store.put({ item: toDocument(task) });
    await h.store.put({ item: toDocument(workspace) });
    const transact = h.store.transact.bind(h.store);
    let reached = false;
    const race = vi.spyOn(h.store, "transact").mockImplementation(async (items) => {
      if (!reached && items.some((item) => item.kind === "put" && item.item["entityType"] === "OPERATION")) {
        reached = true;
        if (closing) await h.store.put({ item: toDocument({ ...task, closeOperationId: randomUUID() }) });
      }
      return transact(items);
    });
    try {
      const next = startWorkflowPlanWithoutUnderstand(task.workflow, h.deps.now!().toISOString());
      const accepted = await acceptStep(h.deps, { task, workspace, requestId: randomUUID(), prompt: "Read the current plan", workflowMode: "PLAN", workflow: { current: task.workflow, next } });
      expect(reached).toBe(true);
      expect(accepted.result).toBe(closing ? "STALE" : "STARTED");
      expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(closing ? task.workflow : next);
    } finally { race.mockRestore(); }
  });

  it.each([false, true])("a workflow commit uses its atomic close fence (closing %s)", async (closing) => {
    const { h, task } = await fixture(closing);
    const next = blockWorkflow(task.workflow!, "The step stopped.", h.deps.now!().toISOString());
    expect(await commitWorkflow(h.deps, task, next)).toBe(!closing);
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(closing ? task.workflow : next);
  });

  it.each([false, true])("a block after accepted Close emits no write attempt (closing %s)", async (closing) => {
    const { h, task } = await fixture(closing);
    const transact = vi.spyOn(h.store, "transact");
    await blockTaskWorkflow(h.deps, task.taskId, task.workflow!.revision, "The step stopped.");
    if (closing) {
      expect(transact).not.toHaveBeenCalled();
      expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(task.workflow);
    } else expect((await readTask(h.deps, task.taskId))!.workflow?.state).toBe("BLOCKED");
  });

  it.each([false, true])("a pending workflow dispatch after accepted Close is stale (closing %s)", async (closing) => {
    const { h, task } = await fixture(closing, true);
    const result = await runDispatchRow(h.deps, { taskId: task.taskId, workflowRevision: task.workflow!.revision, kind: "UNDERSTAND" });
    if (closing) {
      expect(result).toBe("STALE");
      expect(await h.store.get(dispatchRowKey(h.deps.companyId, task.taskId, task.workflow!.revision))).toBeUndefined();
    } else expect(["WAITING", "STARTED"]).toContain(result);
  });

  it.each([false, true])("a prepare callback after accepted Close cannot append base data (closing %s)", async (closing) => {
    const { h, task } = await fixture(closing);
    const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
    const keys = await workspaceKeys(h.deps, workspace.id);
    const operation = fromDocument<OperationRecord>(await h.store.get(keys.operationKey(workspace.activeOperationId!)))!;
    const base = [{ repositoryId: "demo", baseCommitSha: "a".repeat(40) }];
    const update = vi.spyOn(h.store, "update");
    await onOperationEnded(h.deps, operation, { status: "SUCCEEDED", outcome: { kind: "prepared", base } });
    expect((await readTask(h.deps, task.taskId))!.preparedBase).toEqual(closing ? undefined : base);
    if (closing) expect(update).not.toHaveBeenCalled();
  });
});
