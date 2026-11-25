// journey-gate: 13
// Journey 13: resilience. The worker's machine is lost in the middle of a step: the core's watch ends the run after its grace period, the owner sees why, a late result from the old worker changes
// nothing, and a duplicate of a result the core already took changes nothing. On the real core and the real worker; see briefs/arch-cleanup/A1-JOURNEY-TESTS-PLAN.md.
// D1 deletes tests/integration/workflow-e2e/09-resilience.test.ts and the old dispatch-recovery and cancel-reconcile machinery; the core's watches (core/task-flow/run-watch.ts, results.ts) are then the only recovery.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

describe("journey 13: the worker goes silent", () => {
  it("the machine is lost mid-step: the watch interrupts the run after its grace period, the owner reads why, the old worker's late result changes nothing, and a retry is answered in words", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    const workflow = () => world!.taskRow(taskId)!.workflow as unknown as { stage: string; state: string; blockReason?: string; revision: number };
    const implementOps = () => world!.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === "IMPLEMENT").map((row) => String(row.status));
    // The worker is running the step (its model call is waiting) when its machine is lost.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let began!: () => void;
    const modelBegan = new Promise<void>((resolve) => { began = resolve; });
    const running = await world.startStep("IMPLEMENT", [async () => { began(); await gate; return fauxAssistantMessage([fauxToolCall("bash", { command: "printf late > repo/demo/health.txt" })], { stopReason: "toolUse" }); }, fauxAssistantMessage("done late")]);
    await modelBegan;
    expect({ stage: workflow().stage, state: workflow().state }).toEqual({ stage: "IMPLEMENT", state: "RUNNING" });
    await world.harness.world.machines.terminate(running.machineId);
    // The watch: the first sweep notes the lost machine, a later one past the grace period ends the run.
    const flow = world.harness.runtime.flow;
    const reports = [];
    for (let pass = 0; pass < 3; pass += 1) { world.harness.world.clock.advance(100); reports.push(await flow.sweepRunsOnce()); await flow.sweepOnce(); }
    expect(reports.map((report) => report.interrupted), "interrupted once, after the grace period").toEqual([0, 0, 1]);
    expect({ stage: workflow().stage, state: workflow().state, reason: workflow().blockReason }, "what the owner reads").toEqual({ stage: "IMPLEMENT", state: "BLOCKED", reason: "implementation operation ended interrupted" });
    expect(implementOps()).toEqual(["INTERRUPTED"]);
    // The old worker was only silent: it finishes and posts its result to the real route. The core already ended that run, so nothing changes.
    release();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(implementOps(), "the late result did not change the run").toEqual(["INTERRUPTED"]);
    expect({ stage: workflow().stage, state: workflow().state }, "no review, no pull request").toEqual({ stage: "IMPLEMENT", state: "BLOCKED" });
    // The owner asks for a retry: in this fixture the lost run's whole hold is kept as spent and the task's run limit refuses more work, in words (a deployment's price table decides this).
    const retried = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: workflow().revision, instructions: "Try again." });
    expect({ status: retried.status, code: (retried.body.error as { code: string }).code }, "the owner is answered in words, not left with silence").toEqual({ status: 402, code: "BUDGET_EXCEEDED" });
    world.proof.assertAllCore();
  }, 180_000);

  it("a duplicate of a result the core already took (a worker that posts twice) changes nothing, and a result under another run's capability is refused", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await world.prepare(taskId);
    const understood = await world.runStep("UNDERSTAND", [fauxAssistantMessage('```rovara-intent\n{"kind":"ready","path":"QUICK","restatement":"Add a health endpoint.","assumptions":[]}\n```\n')]);
    expect(understood.operation.status).toBe("SUCCEEDED");
    const snapshot = () => JSON.stringify([world!.taskRow(taskId)!.workflow, world!.harness.db.find((row) => row.entityType === "OPERATION").map((row) => [row.workflowMode, row.status])]);
    const before = snapshot();
    const { workspaceId } = world.taskRow(taskId)!;
    const post = (capability: string, operationId: string, status: string) => world!.postWorkerCallback(workspaceId, operationId, "result", capability, { operationId, status, result: { workflowMode: "UNDERSTAND" } });
    const twice = await post(understood.invocation.callbackCapability, understood.invocation.operationId, "SUCCEEDED");
    expect({ status: twice.status, body: twice.body }, "a repeat of the same result is answered as a duplicate").toEqual({ status: 200, body: { duplicate: true, ok: true } });
    // The same operation reported failed afterwards cannot undo what the core took.
    const contradiction = await post(understood.invocation.callbackCapability, understood.invocation.operationId, "FAILED");
    expect({ status: contradiction.status, body: contradiction.body }, "answered as a duplicate, changing nothing").toEqual({ status: 200, body: { duplicate: true, ok: true } });
    expect(snapshot(), "nothing about the task or its runs changed").toBe(before);
    // A capability that is not this run's is refused.
    const foreign = await post("f".repeat(64), understood.invocation.operationId, "SUCCEEDED");
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(snapshot()).toBe(before);
    world.proof.assertAllCore();
  }, 120_000);
});
