// A PR comment that arrives while AgentX is still reviewing the previous one (two comments a few seconds apart, as on a
// real pull request) is kept and collected again by the recovery sweep. Found by the realistic E2E harness: the broker
// answered such a delivery 400 "check it and try again" and logged an unexpected error, although it keeps the delivery
// for a retry; GitHub's delivery log then showed a client error for a delivery AgentX goes on to process.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createWorkflowE2E } from "../support/workflow-e2e.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Add greet(name)", why: [{ text: "Greet by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add greet to greeting.ts." }], decisions: [] }));
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];

describe("a GitHub webhook for a task that is busy reviewing feedback", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

  it("is answered as retryable (503), and the recovery sweep collects the comment once the review is done", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    const number = e2e.github.pullRequests[0]!.number;

    const first = e2e.github.comment(number, "octocat", "Please trim the name before greeting.");
    expect(await e2e.githubWebhook(number, { comment: first })).toBe(200);
    // The feedback review of the first comment is running when the second comment arrives.
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "RUNNING" });
    const second = e2e.github.comment(number, "octocat", "Also add a test for an empty name.");
    const answer = await e2e.webhook({ kind: "issue_comment", number, comment: second });
    expect(answer).toMatchObject({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook processing will be retried" } } });
    expect(log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes("request.unexpected_error"))).toEqual([]);

    await e2e.settle();
    e2e.clock.advance(5 * 60_000);
    expect((await e2e.runWebhookRecovery()).body).toMatchObject({ attempted: 1, processed: 1 });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" } });
    expect(e2e.workflow().feedbackReview?.bundleRefs.flatMap((bundle) => bundle.comments.map((comment) => comment.id)).sort()).toEqual([first.id, second.id].sort());
  }, 120_000);
});
