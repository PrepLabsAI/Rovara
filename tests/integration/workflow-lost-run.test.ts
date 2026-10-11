// A workflow step whose run ends without a result (the worker's compute was lost, or the dispatcher gave up delivering
// it) blocks the task with a retry, as a failed result would, instead of leaving it "running" for ever with nothing said.
// Found by the realistic E2E harness: the session reconciler and the dispatcher failed the operation, but only a pull
// request update's workflow was told; a coding or planning step stayed RUNNING and the thread stayed silent.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { LOST_COMPUTE_ERROR, createWorkflowE2E } from "../support/workflow-e2e.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Add greet(name)", why: [{ text: "Greet by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add greet to greeting.ts." }], decisions: [] }));
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];

describe("a workflow step that ends without a result", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

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
    expect(e2e.slack.posts.length).toBeGreaterThan(posts);
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
  }, 120_000);
});
