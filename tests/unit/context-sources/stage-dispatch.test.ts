// Which steps are dispatched with the capability to read a project's sources: a step of a stage that has a source, on a worker that can use it, and no other. The step's own operation record is
// read back, so what the worker would be sent is what is checked.
import { describe, expect, it } from "vitest";
import { DesignReviewBindingSchema } from "@agentx/contracts";
import { acceptStep, readWorkspace, type StepInput } from "../../../packages/broker/src/core/task-flow/stage-machine.js";
import { readTask } from "../../../packages/broker/src/core/task-flow/reads.js";
import { createHarness, newRequestId } from "../../support/task-flow-harness.js";

const BINDING = DesignReviewBindingSchema.parse({ version: 1, round: 1, reviewers: [{ role: "critic", keySlot: "r1-critic", packetDigest: "a".repeat(64), model: { provider: "anthropic", modelId: "m1" } }] });

async function dispatchOf(input: { mode: StepInput["workflowMode"]; has: boolean | "none"; designReview?: boolean }) {
  const h = createHarness({ understandFirst: false, machines: { startingChecks: 0 } });
  await h.registerProject();
  if (input.has !== "none") h.deps.contextSources = { stageHasSources: async () => input.has === true };
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x" });
  // The workspace is made ready the way the flow does: each job it is given (its preparation, and the first run the task's own instructions start) is handed to a worker and answered.
  const task = (await readTask(h.deps, started.task.taskId))!;
  const answered = new Set<string>();
  for (let round = 0; round < 8; round += 1) {
    const current = (await readWorkspace(h.deps, task.workspaceId))!;
    if (current.status === "READY" && current.activeOperationId === null) break;
    await h.flow.dispatchOnce({ maxMessages: 10 });
    h.clock.advance(70);
    const after = (await readWorkspace(h.deps, task.workspaceId))!;
    const job = after.machine === undefined ? undefined : (h.machines.delivered(after.machine.machineId)).find((entry) => !answered.has(entry.operationId));
    if (job === undefined) continue;
    answered.add(job.operationId);
    await h.flow.recordResult({ workspaceId: after.id, operationId: job.operationId, fence: job.fence ?? after.fence, status: "SUCCEEDED" });
  }
  const workspace = (await readWorkspace(h.deps, task.workspaceId))!;
  const accepted = await acceptStep(h.deps, {
    task, workspace, requestId: newRequestId(), prompt: "read", workflowMode: input.mode,
    ...(input.designReview === true ? { designReview: BINDING } : {}),
  });
  expect(accepted.result).toBe("STARTED");
  return accepted.operation!.dispatch;
}

describe("the capability to read sources", () => {
  it("goes with a step of a stage that has a source, with the flag the worker needs and the feature it must list", async () => {
    const dispatch = await dispatchOf({ mode: "PLAN", has: true });
    expect(dispatch.payload).toMatchObject({ contextSources: true });
    expect(dispatch.extraActions).toContain("context-tools");
    expect(dispatch.requires).toContain("task.contextSources.v1");
  });

  it("does not go with a stage that has none, or an install that has no sources at all", async () => {
    for (const has of [false, "none"] as const) {
      const dispatch = await dispatchOf({ mode: "PLAN", has });
      expect(dispatch.payload, String(has)).not.toHaveProperty("contextSources");
      expect(dispatch.extraActions ?? [], String(has)).not.toContain("context-tools");
      expect(dispatch.requires ?? [], String(has)).not.toContain("task.contextSources.v1");
    }
  });

  it("never goes with the stage that writes the code, even when the source lookup says yes", async () => {
    const dispatch = await dispatchOf({ mode: "IMPLEMENT", has: true });
    expect(dispatch.payload).not.toHaveProperty("contextSources");
    expect(dispatch.extraActions ?? []).not.toContain("context-tools");
  });

  it("never goes with a design review's reviewer operation, which reads only its packet, even when its stage has a source", async () => {
    const dispatch = await dispatchOf({ mode: "PLAN_CRITIQUE", has: true, designReview: true });
    expect(dispatch.payload).not.toHaveProperty("contextSources");
    expect(dispatch.extraActions ?? []).not.toContain("context-tools");
    expect(dispatch.requires ?? []).not.toContain("task.contextSources.v1");
    // The same stage as the plan check (no binding) does get it: the exclusion is the binding, not the stage.
    const planCheck = await dispatchOf({ mode: "PLAN_CRITIQUE", has: true });
    expect(planCheck.payload).toMatchObject({ contextSources: true });
  });
});
