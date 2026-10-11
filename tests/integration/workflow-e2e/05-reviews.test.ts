// Suite 5: reviews. 5.1-5.3 are covered by slack-workflow-e2e.test.ts (pass, accept with a reason, resolve findings).
// Here: a security finding is never advisory, more findings than Resolve findings takes, reviews that can't finish
// (unreadable answers, a timeout) [LIVE-BUG B6], the automatic start failing, older issues, an accepted finding raised
// again on new code, and a change too large to show the reviewers in full.
import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, openReviewFindings } from "@agentx/contracts";
import { reviewerFindings, reviewerHangs, reviewerProse } from "../../support/model-fixtures.js";
import { reviewerReply } from "../../support/faux-scripts.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, PLAN, actionIds, atPlanReview, expectNoJargon, journeySuite, runs, said } from "../../support/workflow-e2e-journeys.js";

const FEEDBACK_FIX = "Implement only the owner-approved PR feedback";
const FIXED = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name.trim()}`;\n}\n" }];

/** A Quick task taken through plan approval and coding to its reviews' outcome. */
async function reviewed(e2e: WorkflowE2E): Promise<void> {
  await atPlanReview(e2e);
  await e2e.click("agentx_workflow_approve");
  await e2e.settle();
}

/** Accepts every open finding in the Resolve findings form with `reason`. */
async function acceptAll(e2e: WorkflowE2E, reason: string): Promise<void> {
  await e2e.click("agentx_workflow_resolve_findings");
  const form = e2e.slack.views.at(-1)!.view as { blocks: Array<{ type: string; block_id?: string }> };
  const inputs = form.blocks.filter((block) => block.type === "input").map((block) => block.block_id!);
  const values: Record<string, Record<string, unknown>> = {};
  for (let index = 0; index < inputs.length; index += 2) {
    values[inputs[index]!] = { action: { selected_option: { value: "ACCEPT" } } };
    values[inputs[index + 1]!] = { note: { value: reason } };
  }
  await e2e.submitView(values);
}

describe("Suite 5: reviews", () => {
  journeySuite();

  it("5.4 a security finding marked advisory still blocks, with Resolve findings, and accepting it needs a reason", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS, reviews: reviewerFindings(1, { role: "SECURITY", advisory: true, severity: "HIGH" }) } });
    await reviewed(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    const card = e2e.slack.lastPostWithAction("agentx_workflow_resolve_findings");
    expect(card.text).toBe("Reviews found 1 issue in this change.\n• [security] Finding 1: the greeting is not trimmed. (greeting.ts:2)\n"
      + `<https://agentx.example.test/review/${e2e.taskId()}/task#findings|See all findings>`);
    expect(actionIds(card)).toEqual(["agentx_workflow_resolve_findings", "agentx_workflow_retry_reviews", "agentx_workflow_close"]);
    expect(runs(e2e)).not.toContain("publish");
    await e2e.click("agentx_workflow_resolve_findings");
    const form = e2e.slack.views.at(-1)!.view as { blocks: Array<{ type: string; block_id?: string }> };
    const [action, note] = form.blocks.filter((block) => block.type === "input").map((block) => block.block_id!);
    await expect(e2e.submitView({ [action!]: { action: { selected_option: { value: "ACCEPT" } } }, [note!]: { note: { value: " " } } })).rejects.toThrow("Give a reason to accept this finding.");
    expect(e2e.github.pullRequests).toEqual([]);
  }, 120_000);

  it("5.5 more than 20 blocking findings: the card shows the first ones, offers Send back instead of Resolve findings, and a resolve is refused", async () => {
    // A reviewer's report keeps at most 20 findings: 20 from the code review and 5 from the security review.
    const findings = (role: string, count: number) => reviewerReply.json(Array.from({ length: count }, (_, index) => ({
      text: `${role} finding ${index + 1}: line ${index + 1} is not trimmed.`, origin: "INTRODUCED" as const, severity: "MEDIUM" as const, file: "greeting.ts", line: 2 })));
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS, reviews: { CODE: [findings("Code", 20)], SECURITY: [findings("Security", 5)] } } });
    await reviewed(e2e);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_send_back");
    expect(card.text.split("\n").slice(0, 5)).toEqual(["Reviews found 25 issues in this change.",
      "• [code] Code finding 1: line 1 is not trimmed. (greeting.ts:2)", "• [code] Code finding 2: line 2 is not trimmed. (greeting.ts:2)", "• [code] Code finding 3: line 3 is not trimmed. (greeting.ts:2)",
      "And 22 more."]);
    expect(actionIds(card)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_reviews", "agentx_workflow_close"]);
    // An AI tool's resolve of 20 of them is refused in plain words, and nothing moves.
    const workflow = e2e.workflow();
    const open = openReviewFindings(workflow);
    expect(open).toHaveLength(25);
    const answer = await e2e.mcp("agentx_resolve_review_findings", { task_id: e2e.taskId(), expected_revision: workflow.revision, candidate_digest: workflow.candidate!.digest,
      resolutions: open.slice(0, 20).map((finding) => ({ finding_id: finding.findingId, action: "fix" })) });
    expect(answer.isError).toBe(true);
    expect(JSON.stringify(answer)).toContain("there are 25 blocking findings and AgentX resolves at most 20 at once; send the change back to coding instead");
    expect(e2e.workflow().revision).toBe(workflow.revision);
  }, 120_000);

  it("5.6 [LIVE-BUG B6] a code review whose answer can't be read, twice, is said with Retry reviews, and the retry opens the PR", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS, reviews: { CODE: [reviewerProse, reviewerProse, reviewerReply.pass()] } } });
    await reviewed(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    const card = e2e.slack.lastPostWithAction("agentx_workflow_retry_reviews");
    expect(card.text).toBe("A review couldn't finish (code review: its answer wasn't in the expected format). Nothing was sent to GitHub.");
    expect(actionIds(card)).toEqual(["agentx_workflow_retry_reviews", "agentx_workflow_close"]);
    expect(e2e.github.pushes.size).toBe(0);
    await e2e.click("agentx_workflow_retry_reviews");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    // Retrying reviews wrote no code.
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    expectNoJargon(e2e);
  }, 120_000);

  it("5.7 [LIVE-BUG B6] a security review that runs out of time is said with Retry reviews", async () => {
    const e2e = await createWorkflowE2E({ workerTimeouts: { reviewMs: 200 }, model: { plan: PLAN, edits: EDITS, reviews: { SECURITY: [reviewerHangs, reviewerReply.pass()] } } });
    await reviewed(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    const card = e2e.slack.lastPostWithAction("agentx_workflow_retry_reviews");
    expect(card.text).toBe("A review couldn't finish (security review: it ran out of time). Nothing was sent to GitHub.");
    await e2e.click("agentx_workflow_retry_reviews");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  // The worker always reports both roles; a result with one report (WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, "The reviews
  // didn't return one code review and one security review...") needs a worker that leaves one out. The harness has no
  // seam to rewrite a worker's result (only to fail or crash a run), and adding one is outside this task's scope.
  it.todo("5.8 incomplete reviews (only one report) are said with Retry reviews");

  it("5.9 says the reviews couldn't start automatically once AgentX gives up starting them, with Retry reviews that works", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    // DynamoDB throttles every write that would start the reviews' run, for as long as `throttled` holds.
    let throttled = true;
    e2e.db.injectFault({ command: "TransactWriteCommand", times: 1_000, error: { name: "ProvisionedThroughputExceededException", message: "Rate exceeded" },
      match: (input) => throttled && JSON.stringify(input).includes('"workflowMode":"REVIEW"') });
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    // The first start failed: the reviews are due again, and the thread has said they are starting.
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "WAITING" });
    expect(said(e2e).at(-1)).toBe("The check passed. Starting the code and security reviews.");
    // The recovery sweep tries again with a growing wait, then gives up and says so.
    for (let sweep = 0; sweep < 12 && e2e.workflow().state === "WAITING"; sweep += 1) {
      e2e.clock.advance(16 * 60_000);
      await e2e.runRecovery();
      await e2e.settle();
    }
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE });
    const card = e2e.slack.lastPostWithAction("agentx_workflow_retry_reviews");
    expect(card.text).toBe(`The checks passed, but the reviews couldn't finish. ${WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE} Nothing was sent to GitHub.`);
    expect(actionIds(card)).toEqual(["agentx_workflow_retry_reviews", "agentx_workflow_close"]);
    throttled = false;
    await e2e.click("agentx_workflow_retry_reviews");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("5.10 an older issue in a file the change never touched is noted and doesn't block; the PR says so", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS, reviews: { CODE: [reviewerReply.json([
      { text: "farewell takes an untyped name.", origin: "PRE_EXISTING", severity: "LOW", file: "repo/demo/farewell.ts", line: 1 }])] } } });
    await reviewed(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const reviewsLine = (e2e.github.pullRequests[0]!.body ?? "").split("\n").find((line) => line.startsWith("Reviews: "));
    expect(reviewsLine).toBe("Reviews: code review passed; security review passed; 1 earlier issue noted");
  }, 120_000);

  it("5.11 a finding accepted on the first code blocks again when the reviews raise it on the fixed code", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: (latest) => (latest.includes(FEEDBACK_FIX) ? FIXED : EDITS), reviews: reviewerFindings(1) } });
    await reviewed(e2e);
    await acceptAll(e2e, "Callers already trim the name.");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.github.pullRequests[0]!.body ?? "").toContain("Owner accepted 1 review finding:");
    const number = e2e.github.pullRequests[0]!.number;
    const comment = e2e.github.comment(number, "octocat", "Please trim the name before greeting.");
    expect(await e2e.githubWebhook(number, { comment })).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    // The fixed code is new code: the same finding on it is the owner's to decide again, and nothing was pushed.
    const workflow = e2e.workflow();
    expect(workflow.state).toBe("BLOCKED");
    expect(openReviewFindings(workflow)).toHaveLength(1);
    expect(e2e.slack.lastPostWithAction("agentx_workflow_resolve_findings").text).toContain("Reviews found 1 issue in this change.");
    expect(e2e.github.pushLog.filter((push) => push.during === "maintain")).toEqual([]);
  }, 120_000);

  it("5.12 a change too large to show the reviewers in full is said in Slack and in the PR", async () => {
    const big = Array.from({ length: 4_000 }, (_, index) => `export const line${index} = "${"x".repeat(30)}";`).join("\n");
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: [...EDITS, { path: "repo/demo/big.ts", content: `${big}\n` }] } });
    await reviewed(e2e);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(said(e2e)).toContain("Checks and reviews passed. Opening a draft pull request. The change was too large to show the reviewers in full, so they reviewed only part of it.");
    expect(e2e.github.pullRequests[0]!.body ?? "").toContain("The change was too large to show the reviewers in full, so the reviews covered only part of it. Review the rest by hand.");
    // The run's event log stayed small: no event near DynamoDB's 400 KB item limit, and no streamed copy of every prefix
    // of the 200 KB file write (that sent about 600 MB for a 40 KB file).
    const stored = e2e.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("EVENT#")).map((item) => Buffer.byteLength(JSON.stringify(item), "utf8"));
    expect(Math.max(...stored)).toBeLessThan(80 * 1024);
    expect(stored.reduce((total, size) => total + size, 0)).toBeLessThan(512 * 1024);
  }, 120_000);
});
