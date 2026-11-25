// TASK-TAKEOVER PR A: the actor a checks rerun is recorded under follows the task's CURRENT owner (the person the next step runs for), never the person who started it, when the host names one.
import { describe, expect, it } from "vitest";
import { change, type WorkerInvocation } from "@agentx/contracts";
import { dispatchRowKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readWorkspace } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { COMPANY, createHarness, newRequestId } from "../support/task-flow-harness.js";
import { gatewayChargesMember } from "../../packages/broker/src/core/cost/task-payer.js";
import { retryActorOf } from "../../packages/broker/src/core/task-flow/retry.js";
import { taskOwnerKey } from "../../packages/broker/src/developer/task-records.js";
import type { TaskFlowDeps } from "../../packages/broker/src/core/task-flow/deps.js";

const TASK = "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6";
const STARTER = "a".repeat(64);
const SUCCESSOR = "b".repeat(64);
const task = { taskId: TASK, developerId: STARTER, project: "payments", workflow: { ownerId: taskOwnerKey(STARTER, TASK) } };
const depsOf = (verdict: Awaited<ReturnType<TaskFlowDeps["access"]["checkStep"]>>): TaskFlowDeps => ({ access: { checkStep: async () => verdict } }) as unknown as TaskFlowDeps;

describe("retryActorOf", () => {
  it("is the current owner's task key when the host names one", async () => {
    expect(await retryActorOf(depsOf({ allowed: true, owner: { personId: SUCCESSOR } }), task)).toBe(taskOwnerKey(SUCCESSOR, TASK));
  });

  it("is the workflow's own owner when the host names none (the local owner) or does not allow the step now", async () => {
    expect(await retryActorOf(depsOf({ allowed: true }), task)).toBe(taskOwnerKey(STARTER, TASK));
    expect(await retryActorOf(depsOf({ allowed: false, message: "no" }), task)).toBe(taskOwnerKey(STARTER, TASK));
  });
});

describe("the press on a step's dispatch row", () => {
  it("is read when the step starts, and handed to the access check as the person it is charged to (a reading step has no other way to carry it)", async () => {
    const h = createHarness({ understandFirst: true, machines: { startingChecks: 0 } });
    await h.registerProject();
    const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "x", workflow: true });
    for (let round = 0; round < 12 && (await h.flow.dispatchOnce({ maxMessages: 10 })).received > 0; round += 1) { /* drain */ }
    const workspace = (await readWorkspace(h.deps, started.task.workspaceId))!;
    const prepare = h.machines.delivered(workspace.machine!.machineId)[0] as WorkerInvocation;
    const presser = "c".repeat(64);
    await h.store.update({ key: dispatchRowKey(COMPANY, started.task.taskId, 1), ops: [change.set("by", presser)] });
    const asked: Array<string | undefined> = [];
    h.deps.access = { ...h.deps.access, checkStep: async (_task, by) => { asked.push(by); return { allowed: true }; } };
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: prepare.operationId, fence: 1, status: "SUCCEEDED" });
    await h.flow.sweepOnce();
    expect(asked).toContain(presser);
  });
});

describe("gatewayChargesMember (what \"Charged to\" may say)", () => {
  const task = { developerId: STARTER, project: "payments" };
  it("is true where the gateway charges the step's requester (a member-paid task), false for a setup run, a Linear task or a non-member origin", () => {
    expect(gatewayChargesMember(task)).toBe(true);
    expect(gatewayChargesMember({ ...task, purpose: "setup_agent" })).toBe(false);
    expect(gatewayChargesMember({ ...task, origin: "linear" })).toBe(false);
    expect(gatewayChargesMember({ ...task, origin: "schedule" })).toBe(false);
  });
});
