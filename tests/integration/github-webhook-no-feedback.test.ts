// A pull request event that carries no feedback (an approval with no summary, the pull request marked ready for review)
// starts no feedback review and says nothing in the thread. Found by the realistic E2E harness: GitHub sends such an
// approval with `body: null`, and AgentX ran the feedback reviewer on zero comments and posted "PR feedback is ready:
// 0 comments" in the task's thread.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { registerJourneyInvariants } from "../support/workflow-e2e-invariants.js";
import { createWorkflowE2E } from "../support/workflow-e2e.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Add greet(name)", why: [{ text: "Greet by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add greet to greeting.ts." }], decisions: [] }));
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];

describe("a GitHub event with no feedback on a task's pull request", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });
  registerJourneyInvariants({ logs: () => log.mock.calls.map(([line]) => String(line)) });

  it("starts no feedback review and posts nothing, and a later comment is reviewed as usual", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    const number = e2e.github.pullRequests[0]!.number;
    const posts = e2e.slack.posts.length;
    const runs = e2e.invocations.length;

    const approval = e2e.github.review(number, "octocat", { body: null, state: "APPROVED" });
    expect((await e2e.webhook({ kind: "pull_request_review", number, review: approval.review, body: null, state: "APPROVED" })).status).toBe(200);
    expect((await e2e.webhook({ kind: "pull_request", action: "ready_for_review", number })).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().feedbackReview).toBeUndefined();
    expect(e2e.invocations.length).toBe(runs);
    expect(e2e.slack.posts.length).toBe(posts);

    // An inline comment whose thread is already resolved when AgentX first sees it is no feedback either.
    const inline = e2e.github.reviewComment(number, "octocat", "Nit: a blank line here.", "greeting.ts", 1);
    e2e.github.resolveThread(inline.threadId!);
    expect((await e2e.webhook({ kind: "pull_request_review_comment", number, comment: inline })).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow().feedbackReview).toBeUndefined();
    expect(e2e.invocations.length).toBe(runs);
    expect(e2e.slack.posts.length).toBe(posts);

    const comment = e2e.github.comment(number, "octocat", "Please trim the name before greeting.");
    expect(await e2e.githubWebhook(number, { comment })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow().feedbackReview).toMatchObject({ status: "PENDING", reviewRef: { status: "COMPLETE" } });
  }, 120_000);
});
