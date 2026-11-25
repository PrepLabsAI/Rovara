// journey-gate: 6, 7, 8, 10
// Journeys 6 (a question is asked and answered), 7 (an over-budget refusal reaches the person with a stable code), 8 (a failed check sends the work back once) and 10 (a worker result with an
// unknown field, as designed today). On the real core and the real worker; see briefs/arch-cleanup/A1-JOURNEY-TESTS-PLAN.md.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { INTENT_BLOCK_INFO_STRING, type AdmissionDecision } from "../../packages/contracts/src/index.js";
import { createAllowAllAdmission } from "../../packages/broker/src/ports/policy-defaults.js";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { FILE_CHECK_PLAN, fenced, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

describe("journey 6: a question is asked and answered", () => {
  it("Understand asks, the task waits for its owner, a form for another round is refused, the owner answers, and Understand runs again with the answers", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await world.prepare(taskId);
    const asked = await world.runStep("UNDERSTAND", [fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, { kind: "questions", restatement: "Add a health endpoint.",
      questions: [{ id: "q1", text: "Should /health also check the database?", options: [{ id: "a", label: "Yes, check the database" }, { id: "b", label: "No, just answer 200" }], recommended: "b" }] }))]);
    expect(asked.operation.status, String(asked.operation.error)).toBe("SUCCEEDED");
    const waiting = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { workflow: { stage: string; state: string; intent?: { assessment?: { kind?: string; questions?: Array<{ text: string }> } } } };
    expect({ stage: waiting.workflow.stage, state: waiting.workflow.state }, "the task waits for its owner").toEqual({ stage: "UNDERSTAND", state: "WAITING" });
    expect(JSON.stringify(waiting.workflow.intent), "the owner can read the question").toContain("Should /health also check the database?");
    // A colleague in the owner's company (project grant, not the owner) cannot answer: they are told what a missing task is told, and the task still waits.
    const colleague = await world.priya("POST", `/v1/dev/tasks/${taskId}/answers`, { requestId: randomUUID(), round: 1, answers: [{ questionId: "q1", optionId: "a" }] });
    expect(colleague.status).toBe(404);
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "UNDERSTAND", state: "WAITING" });
    // A form for a round that is not the one asked is refused with fixed words, and nothing is taken.
    const stale = await world.maya("POST", `/v1/dev/tasks/${taskId}/answers`, { requestId: randomUUID(), round: 2, answers: [{ questionId: "q1", optionId: "b" }] });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect((world.taskRow(taskId)!.workflow as { stage: string; state: string })).toMatchObject({ stage: "UNDERSTAND", state: "WAITING" });
    const requestId = randomUUID();
    const answered = await world.maya("POST", `/v1/dev/tasks/${taskId}/answers`, { requestId, round: 1, answers: [{ questionId: "q1", optionId: "b" }] });
    expect(answered.status, JSON.stringify(answered.body).slice(0, 300)).toBe(200);
    // The same request again answers nothing more.
    expect((await world.maya("POST", `/v1/dev/tasks/${taskId}/answers`, { requestId, round: 1, answers: [{ questionId: "q1", optionId: "b" }] })).status).toBe(200);
    // Understand runs again, now with the answer in its prompt, and the task goes on to its plan.
    const again = await world.runStep("UNDERSTAND", [fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, { kind: "ready", path: "QUICK", restatement: "Add a health endpoint that answers 200.", assumptions: [] }))], asked.invocation.operationId);
    expect(again.operation.status, String(again.operation.error)).toBe("SUCCEEDED");
    expect(JSON.stringify((again.invocation as { payload?: unknown }).payload), "the second Understand run carries the owner's answer").toContain("No, just answer 200");
    world.proof.assertAllCore();
  }, 120_000);
});

describe("journey 7: an over-budget refusal reaches the person with a stable code", () => {
  it("a start the company's budget refuses is answered BUDGET_EXCEEDED in the adapter's words, leaves nothing behind, and the same request starts once the budget has room", async () => {
    let refuse = true;
    const decision: AdmissionDecision = { allowed: false, code: "budget_exceeded", message: "Your company's budget for this month is used up." };
    const base = createAllowAllAdmission();
    const admission = { ...base,
      admit: async (request: Parameters<typeof base.admit>[0]) => refuse ? decision : base.admit(request),
      stage: async (request: Parameters<typeof base.stage>[0]) => refuse ? { decision, items: [] } : base.stage(request) };
    world = await createJourneyWorld({ world: { admission } });
    const requestId = randomUUID();
    const body = { requestId, project: "payments", instructions: "Add a health endpoint", workflow: true, workflowPath: "QUICK" };
    const refused = await world.maya("POST", "/v1/dev/tasks", body);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error, "a stable code and the adapter's own words").toMatchObject({ code: "BUDGET_EXCEEDED", message: decision.message });
    expect(world.harness.db.find((row) => row.entityType === "DEVELOPER_TASK"), "no task is left behind").toEqual([]);
    refuse = false;
    const started = await world.maya("POST", "/v1/dev/tasks", body);
    expect(started.status, JSON.stringify(started.body).slice(0, 300)).toBe(200);
    world.proof.assertAllCore({ callbacks: false });
  }, 120_000);
});

describe("journey 8: a failed check sends the work back once", () => {
  it("a check that fails blocks the task with the reason in words; the owner sends it back with instructions, the coder is told what failed, the second run passes, and a second send-back is refused", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId, { plan: FILE_CHECK_PLAN });
    await world.approvePlan(taskId);
    const workflow = () => world!.taskRow(taskId)!.workflow as unknown as { stage: string; state: string; blockReason?: string; revision: number };
    // The first run changes the wrong file: the plan's check (health.txt must exist) fails inside the worker's own checks.
    const first = await world.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf wrong > repo/demo/other.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the health endpoint.")]);
    expect(first.operation.status, String(first.operation.error)).toBe("SUCCEEDED");
    expect({ stage: workflow().stage, state: workflow().state, reason: workflow().blockReason }, "the person is told the checks failed").toEqual({ stage: "VERIFY", state: "BLOCKED", reason: "The candidate checks failed or have unknown results." });
    const seenByOwner = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { workflow: { blockReason?: string } };
    expect(seenByOwner.workflow.blockReason).toBe("The candidate checks failed or have unknown results.");
    // A send-back needs the revision the person saw: without it, or with an old one, nothing moves.
    const withoutRevision = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), instructions: "Write health.txt." });
    expect(withoutRevision.status).toBeGreaterThanOrEqual(400);
    const stale = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflow().revision - 1, instructions: "Write health.txt." });
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect(workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const sentBack = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflow().revision, instructions: "Write the endpoint's answer to health.txt." });
    expect(sentBack.status, JSON.stringify(sentBack.body).slice(0, 300)).toBe(200);
    // The coder's second run is told what failed and what the owner said, and now passes.
    const second = await world.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf ok > repo/demo/health.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I wrote health.txt.")], first.invocation.operationId);
    expect(second.operation.status, String(second.operation.error)).toBe("SUCCEEDED");
    const prompt = JSON.stringify((second.invocation as { payload: { prompt?: string } }).payload.prompt);
    expect(prompt, "the second run carries the owner's words").toContain("Write the endpoint's answer to health.txt.");
    expect(prompt, "the second run carries the failed check").toContain("health.txt exists");
    expect(workflow(), "the checks passed: on to review").toMatchObject({ stage: "REVIEW" });
    // Sent back once: with nothing failed, a second send-back is refused and nothing moves.
    const again = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: workflow().revision, instructions: "Once more." });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(workflow()).toMatchObject({ stage: "REVIEW" });
    world.proof.assertAllCore();
  }, 180_000);
});

describe("journey 10: a worker result with an unknown field, as designed today", () => {
  it("an unknown top-level field on the result is ignored and the task goes on", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    world.tamperWithResults((body) => ({ ...body, surprise: "a field a newer worker sends" }));
    await planUntilCard(world, taskId);
    expect(world.tampered.count, "the worker's results did carry the odd field").toBeGreaterThan(0);
    expect(world.taskRow(taskId)!.workflow, "the plan is waiting for its owner as if nothing was odd").toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    world.proof.assertAllCore();
  }, 120_000);

  it("an unknown field inside the check report fails closed: the checks are unconfirmed, the owner sees why, and the task does not go on to review", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    world.tamperWithResults((body) => {
      const result = body.result as { checks?: Record<string, unknown> } | undefined;
      return result?.checks === undefined ? body : { ...body, result: { ...result, checks: { ...result.checks, surprise: "a field this broker does not know" } } };
    });
    const built = await world.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: "printf ok > repo/demo/health.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the health endpoint.")]);
    expect(built.operation.status, String(built.operation.error)).toBe("SUCCEEDED");
    expect(world.tampered.count, "the worker's check report did carry the odd field").toBeGreaterThan(0);
    const workflow = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { workflow: { stage: string; state: string; blockReason?: string } };
    expect({ stage: workflow.workflow.stage, state: workflow.workflow.state }, "not on to review").toMatchObject({ state: "BLOCKED" });
    expect(workflow.workflow.blockReason, "the owner is told").toBe("AgentX couldn't read the check results for the final code. Choose checks and retry.");
    world.proof.assertAllCore();
  }, 120_000);
});
