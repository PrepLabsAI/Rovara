// A workflow step whose run ends without a result (the worker's compute was lost, or the dispatcher gave up delivering
// it) blocks the task with a retry, as a failed result would, instead of leaving it "running" for ever with nothing said.
// Found by the realistic E2E harness: the session reconciler and the dispatcher failed the operation, but only a pull
// request update's workflow was told; a coding or planning step stayed RUNNING and the thread stayed silent.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { registerJourneyInvariants } from "../support/workflow-e2e-invariants.js";
import { LOST_COMPUTE_ERROR, createWorkflowE2E } from "../support/workflow-e2e.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Add greet(name)", why: [{ text: "Greet by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add greet to greeting.ts." }], decisions: [] }));
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];

describe("a workflow step that ends without a result", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });
  registerJourneyInvariants({ logs: () => log.mock.calls.map(([line]) => String(line)) });
  const lastPost = (e2e: Awaited<ReturnType<typeof createWorkflowE2E>>) => e2e.slack.posts.at(-1)!;
  const buttons = (post: { blocks?: unknown[] }) => (post.blocks ?? []).flatMap((block) => ((block as { elements?: Array<{ action_id?: string }> }).elements ?? []).map((element) => element.action_id));

  it("blocks coding with Retry when the session reconciler finds its compute lost, and Retry codes it", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    e2e.worker.crashNext("task:IMPLEMENT");
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const posts = e2e.slack.posts.length;
    expect((await e2e.runRecovery()).lostOperations).toHaveLength(1);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" });
    // The thread says so, with the retry the owner presses.
    expect(e2e.slack.posts.length).toBe(posts + 1);
    expect(lastPost(e2e).text).toBe("Coding stopped before it finished. The run stopped unexpectedly.");
    expect(buttons(lastPost(e2e))).toEqual(["agentx_workflow_retry_implementation", "agentx_workflow_close"]);
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(LOST_COMPUTE_ERROR))).toEqual([]);
  }, 120_000);

  it("blocks planning with Retry when the dispatcher gives up because the worker cannot parse the run", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.worker.features([]);
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    expect(e2e.worker.deliveryFailures).toHaveLength(1);
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended failed" });
    expect(lastPost(e2e).text).toBe("I couldn't finish the coding plan. The run stopped unexpectedly.");
    expect(buttons(lastPost(e2e))).toEqual(["agentx_workflow_retry_plan", "agentx_workflow_close"]);
  }, 120_000);

  it("blocks planning with Retry planning when the planning run's compute is lost, and Retry plans it", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.worker.crashNext("task:PLAN");
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    expect((await e2e.runRecovery()).lostOperations).toHaveLength(1);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended failed" });
    expect(lastPost(e2e).text).toBe("I couldn't finish the coding plan. The run stopped unexpectedly.");
    await e2e.click("agentx_workflow_retry_plan");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
  }, 120_000);

  it("says a PR feedback review whose compute was lost could not finish, and the merge is still followed", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    const number = e2e.github.pullRequests[0]!.number;
    e2e.worker.crashNext("task:FEEDBACK_REVIEW");
    const comment = e2e.github.comment(number, "octocat", "Please trim the name before greeting.");
    expect(await e2e.githubWebhook(number, { comment })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "RUNNING" });
    expect((await e2e.runRecovery()).lostOperations).toHaveLength(1);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: "I couldn't review the feedback on the pull request, so I have nothing to propose from it." });
    const card = lastPost(e2e);
    expect(card.text).toBe("I couldn't review the feedback on the pull request, so I have nothing to propose from it. I'm still watching the pull request and will finish this task when it's merged.");
    // As for a feedback review run that ends failed: the merge is still followed, and Close task is the only button.
    // (No Retry review here: retrying a review from this state is not offered today; see the journeys report.)
    expect(buttons(card)).toEqual(["agentx_workflow_close"]);
    e2e.github.merge(number);
    expect(await e2e.githubWebhook(number, { merged: true })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
  }, 120_000);
});
