// A request for changes to a plan plans again, with Understand off (a task whose start named the path, version 1.0.0) as well as on. With Understand off there is no assessment: the planner is
// given the request and the owner's words. The tests drive the real flow on the in-memory fakes and play the owner's decision the way the gate's `onDecided` does (the words, then a PLAN row).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decideWorkflow, type JsonValue, type WorkerInvocation } from "@agentx/contracts";
import { dispatchRowItem, dueDispatchRows } from "../../packages/broker/src/core/task-flow/dispatch-rows.js";
import { taskKey, workspaceKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readTask } from "../../packages/broker/src/core/task-flow/reads.js";
import type { WorkspaceRecord } from "../../packages/broker/src/core/task-flow/records.js";
import { commitWorkflow, planFeedbackKey, runDispatchRow } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { COMPANY, createHarness, newRequestId, type Harness } from "../support/task-flow-harness.js";

const READY = { kind: "ready", path: "QUICK", restatement: "Add a health endpoint", assumptions: ["It returns 200"] } as const;
const DIGEST = (round: number): string => String(round).repeat(64);

async function drain(h: Harness, rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    if ((await h.flow.dispatchOnce({ maxMessages: 10 })).received === 0) return;
    h.clock.advance(70);
  }
}
const lastInvocation = (h: Harness, machineId: string): WorkerInvocation => h.machines.delivered(machineId).at(-1)!;
const promptOf = (invocation: WorkerInvocation): string => (invocation as unknown as { payload: { prompt: string } }).payload.prompt;

/** A task whose first plan is waiting for the owner. `understand: false` is the Quick path with Understand off; `true` runs Understand first. */
async function planWaiting(understand: boolean) {
  const h = createHarness({ understandFirst: understand, machines: { startingChecks: 0 } });
  await h.registerProject();
  const started = await h.flow.start(h.owner, { requestId: newRequestId(), project: "payments", instructions: "Add a /health endpoint", workflow: true, ...(understand ? {} : { workflowPath: "QUICK" as const }) });
  expect(started.task.workflow).toMatchObject({ definitionVersion: understand ? "1.1.0" : "1.0.0" });
  await drain(h);
  const workspace = (await h.store.get(workspaceKey(started.task.workspaceId))) as unknown as WorkspaceRecord;
  const machineId = workspace.machine!.machineId;
  let fence = 1;
  const finish = async (invocation: WorkerInvocation, outcome: Record<string, unknown>): Promise<void> => {
    h.machines.finish(machineId, invocation.operationId);
    await h.flow.recordResult({ workspaceId: workspace.id, operationId: invocation.operationId, fence, status: "SUCCEEDED", outcome } as never);
    fence += 1;
    await drain(h);
  };
  const planned = (round: number) => ({ kind: "planned", artifact: { id: `plan-${round}`, type: "plan", version: round, sha256: DIGEST(round), producer: "agentx-worker-untrusted", objectKey: `tasks/${started.task.taskId}/plan-${round}.md`, createdAt: h.deps.now!().toISOString() } });
  await finish(lastInvocation(h, machineId), { kind: "prepared" });
  if (understand) await finish(lastInvocation(h, machineId), { kind: "understood", assessment: READY });
  const first = lastInvocation(h, machineId);
  expect(first).toMatchObject({ payload: { workflowMode: "PLAN" } });
  await finish(first, planned(1));
  const taskId = started.task.taskId;
  expect((await h.flow.get(h.owner, taskId)).workflow).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });

  /** The owner's request for changes, as the gate commits it: the decision, the words and the PLAN row, then the row runs. Returns what the row's run said. */
  const requestChanges = async (round: number, words: string) => {
    const task = (await readTask(h.deps, taskId))!;
    const now = h.deps.now!().toISOString();
    const next = decideWorkflow(task.workflow, { requestId: randomUUID(), expectedRevision: task.workflow!.revision, decision: "REQUEST_CHANGES", reason: words, artifactDigest: DIGEST(round) }, { actorId: task.workflow!.ownerId, role: "TASK_OWNER" }, { now, allowedSkipStages: [] });
    expect(next).toMatchObject({ stage: "PLAN", state: "READY" });
    const committed = await commitWorkflow(h.deps, task, next, [
      { kind: "put", item: { ...planFeedbackKey(taskId, next.revision), entityType: "PLAN_FEEDBACK", text: words, createdAt: now } },
      dispatchRowItem(h.deps, taskId, next.revision, "PLAN", now),
    ]);
    expect(committed).toBe(true);
    const result = await runDispatchRow(h.deps, { taskId, workflowRevision: next.revision, kind: "PLAN" });
    await drain(h);
    return result;
  };
  const rows = async () => dueDispatchRows(h.store, COMPANY, new Date(h.clock.now + 86_400_000).toISOString(), 20);
  return { h, taskId, machineId, finish, planned, requestChanges, rows, workflow: async () => (await h.flow.get(h.owner, taskId)).workflow };
}

describe("a request for changes plans again", () => {
  it("with Understand off, plans again from the request and the owner's words, and the task moves on to the second plan", async () => {
    const w = await planWaiting(false);
    expect(await w.requestChanges(1, "Also return the build number")).toBe("STARTED");
    const replan = lastInvocation(w.h, w.machineId);
    expect(replan).toMatchObject({ kind: "task", payload: { workflowMode: "PLAN" } });
    const prompt = promptOf(replan);
    expect(prompt).toContain("Add a /health endpoint");
    expect(prompt).toContain("Also return the build number");
    // The row is spent, and the task is planning (not stuck at PLAN/READY).
    expect(await w.rows()).toEqual([]);
    expect(await w.workflow()).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    await w.finish(replan, w.planned(2));
    expect(await w.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("with Understand off, plans again after a second request for changes, and the planner is told both", async () => {
    const w = await planWaiting(false);
    expect(await w.requestChanges(1, "Also return the build number")).toBe("STARTED");
    await w.finish(lastInvocation(w.h, w.machineId), w.planned(2));
    expect(await w.requestChanges(2, "Cache the answer for ten seconds")).toBe("STARTED");
    const prompt = promptOf(lastInvocation(w.h, w.machineId));
    expect(prompt).toContain("Add a /health endpoint");
    expect(prompt).toContain("Also return the build number");
    expect(prompt).toContain("Cache the answer for ten seconds");
    expect(await w.rows()).toEqual([]);
    await w.finish(lastInvocation(w.h, w.machineId), w.planned(3));
    expect(await w.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect((await readTask(w.h.deps, w.taskId))!.workflow!.decisions.filter((decision) => decision.decision === "REQUEST_CHANGES")).toHaveLength(2);
  });

  it("with Understand off, the planner's automatic second run goes ahead too (no assessment to wait for)", async () => {
    const w = await planWaiting(false);
    expect(await w.requestChanges(1, "Also return the build number")).toBe("STARTED");
    // The second plan could not be read: the flow asks the planner again, as a REPLAN row.
    await w.finish(lastInvocation(w.h, w.machineId), { kind: "plan_again", prompt: "The plan lacked its checks; write them.", selfCheck: { artifactType: "plan", version: 2, used: 1 } });
    const again = lastInvocation(w.h, w.machineId);
    expect(promptOf(again)).toContain("The plan lacked its checks; write them.");
    expect(promptOf(again)).toContain("Also return the build number");
    await w.finish(again, w.planned(2));
    expect(await w.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("with Understand on, plans again from Understand's assessment as before", async () => {
    const w = await planWaiting(true);
    expect(await w.requestChanges(1, "Also return the build number")).toBe("STARTED");
    const prompt = promptOf(lastInvocation(w.h, w.machineId));
    expect(prompt).toContain("Add a health endpoint");
    expect(prompt).toContain("It returns 200");
    expect(prompt).toContain("Also return the build number");
    await w.finish(lastInvocation(w.h, w.machineId), w.planned(2));
    expect(await w.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("with Understand on, a task with no assessment to plan from is still stale (the new branch is for Understand off alone)", async () => {
    const w = await planWaiting(true);
    const task = (await readTask(w.h.deps, w.taskId))!;
    const { intent: _intent, ...bare } = task.workflow!;
    void _intent;
    const now = w.h.deps.now!().toISOString();
    const ready = { ...bare, revision: bare.revision + 1, stage: "PLAN", state: "READY", updatedAt: now };
    await w.h.store.update({ key: taskKey(w.taskId), ops: [{ op: "set", path: ["workflow"], value: JSON.parse(JSON.stringify(ready)) as JsonValue }] });
    await w.h.store.put({ item: dispatchRowItem(w.h.deps, w.taskId, ready.revision, "PLAN", now).item });
    const before = (await w.workflow())!.revision;
    expect(await runDispatchRow(w.h.deps, { taskId: w.taskId, workflowRevision: ready.revision, kind: "PLAN" })).toBe("STALE");
    expect((await w.workflow())!.revision).toBe(before);
    expect(await w.rows()).toEqual([]);
  });
});

describe("a row that is truly stale is still resolved STALE", () => {
  it("when the workflow moved on past the row's revision", async () => {
    const w = await planWaiting(false);
    const task = (await readTask(w.h.deps, w.taskId))!;
    const now = w.h.deps.now!().toISOString();
    await w.h.store.put({ item: dispatchRowItem(w.h.deps, w.taskId, task.workflow!.revision - 1, "PLAN", now).item });
    expect(await runDispatchRow(w.h.deps, { taskId: w.taskId, workflowRevision: task.workflow!.revision - 1, kind: "PLAN" })).toBe("STALE");
    expect(await w.rows()).toEqual([]);
    expect(await w.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  });

  it("when the workflow is not ready to plan (it is waiting for the owner's decision)", async () => {
    const w = await planWaiting(false);
    const task = (await readTask(w.h.deps, w.taskId))!;
    const now = w.h.deps.now!().toISOString();
    await w.h.store.put({ item: dispatchRowItem(w.h.deps, w.taskId, task.workflow!.revision, "PLAN", now).item });
    expect(await runDispatchRow(w.h.deps, { taskId: w.taskId, workflowRevision: task.workflow!.revision, kind: "PLAN" })).toBe("STALE");
    expect(await w.rows()).toEqual([]);
    expect((await w.workflow())!.revision).toBe(task.workflow!.revision);
  });

  it("when the task is closed, and for an Understand row on a task that never understood", async () => {
    const w = await planWaiting(false);
    const task = (await readTask(w.h.deps, w.taskId))!;
    const now = w.h.deps.now!().toISOString();
    await w.h.store.put({ item: dispatchRowItem(w.h.deps, w.taskId, task.workflow!.revision, "UNDERSTAND", now).item });
    expect(await runDispatchRow(w.h.deps, { taskId: w.taskId, workflowRevision: task.workflow!.revision, kind: "UNDERSTAND" })).toBe("STALE");
    await w.h.flow.close(w.h.owner, w.taskId);
    await w.h.store.put({ item: dispatchRowItem(w.h.deps, w.taskId, task.workflow!.revision, "PLAN", now).item });
    expect(await runDispatchRow(w.h.deps, { taskId: w.taskId, workflowRevision: task.workflow!.revision, kind: "PLAN" })).toBe("STALE");
    expect(await w.rows()).toEqual([]);
  });
});
