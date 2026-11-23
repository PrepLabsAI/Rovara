import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { change, startWorkflowPlanWithoutUnderstand } from "@agentx/contracts";
import { createHarness } from "../support/task-flow-harness.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { acceptStep, readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { workspaceKeys } from "../../packages/broker/src/core/task-flow/workspace-location.js";

// A step that loses the race to a legacy Close claim must be told to wait (retryable), never STALE (dropped for good).
it("a step racing a legacy Close claim on the workspace returns WAITING and writes nothing", async () => {
  const h = createHarness();
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: randomUUID(), project: "payments", instructions: "Inspect the task", workflow: true, workflowPath: "QUICK" });
  const initial = (await readTask(h.deps, started.task.taskId))!;
  const task = { ...initial, workflow: { ...initial.workflow!, state: "READY" as const } };
  const workspace = { ...(await readWorkspace(h.deps, task.workspaceId))!, status: "READY" as const, activeOperationId: null };
  await h.store.put({ item: toDocument(task) });
  await h.store.put({ item: toDocument(workspace) });
  const location = await workspaceKeys(h.deps, workspace.id);
  const transact = h.store.transact.bind(h.store);
  let raced = false;
  const race = vi.spyOn(h.store, "transact").mockImplementation(async items => {
    if (!raced && items.some(item => item.kind === "put" && item.item["entityType"] === "OPERATION")) {
      raced = true;
      await h.store.update({ key: location.workspaceKey, ops: [change.set("legacyCloseClaim", randomUUID())] });
    }
    return transact(items);
  });
  try {
    const next = startWorkflowPlanWithoutUnderstand(task.workflow, h.deps.now!().toISOString());
    const accepted = await acceptStep(h.deps, { task, workspace, requestId: randomUUID(), prompt: "Read the current plan", workflowMode: "PLAN", workflow: { current: task.workflow, next } });
    expect(raced).toBe(true);
    expect(accepted.result).toBe("WAITING");
    expect((await readTask(h.deps, task.taskId))!.workflow).toEqual(task.workflow);
    expect((await readWorkspace(h.deps, workspace.id))!.activeOperationId).toBeNull();
  } finally { race.mockRestore(); }
});
