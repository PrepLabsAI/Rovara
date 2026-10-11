// Suite 6: the draft pull request. 6.1 is covered by slack-workflow-e2e.test.ts (one PR, a push token only in publish).
// Here: the PR body word for word (checked, review only, accepted findings), a refused push and its retry, a retry while
// GitHub lags [LIVE-BUG B4] [R1], the Slack notice failing once, and the branch moving before the open.
import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE } from "@agentx/contracts";
import { DEV_ISSUER } from "../../support/developer-task-broker.js";
import { reviewerFindings } from "../../support/model-fixtures.js";
import { planAnswer } from "../../support/plan-documents.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, PLAN, PLAN_DOCUMENT, actionIds, atPlanReview, expectNoJargon, journeySuite, runs, said } from "../../support/workflow-e2e-journeys.js";

const pageUrl = (e2e: WorkflowE2E) => `${new URL(DEV_ISSUER).origin}/review/${e2e.taskId()}/task`;
const OPENED = (number: number) => `Draft pull request opened: PR #${number}. Review it and merge it on GitHub; I'll finish this task when it's merged.`;

async function published(e2e: WorkflowE2E): Promise<void> {
  await atPlanReview(e2e);
  await e2e.click("agentx_workflow_approve");
  await e2e.settle();
}

describe("Suite 6: draft PR", () => {
  const logged = journeySuite();

  it("6.2 the PR body ends with the checks, the reviews, the task page and how it was opened, word for word", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await published(e2e);
    const label = e2e.workflow().checkPolicy!.required[0]!.label;
    const body = (e2e.github.pullRequests[0]!.body ?? "").split("\n");
    expect(body.slice(-10)).toEqual([
      "<!-- agentx:checks-and-reviews -->",
      `Checks: ${label} passed`,
      "Reviews: code review passed; security review passed",
      "<!-- /agentx:checks-and-reviews -->",
      `AgentX task: ${pageUrl(e2e)}`,
      "",
      "Opened as a draft by AgentX after the owner-approved plan, checks and reviews passed. Merge it on GitHub.",
      // The publication's own provenance line, added to every AgentX pull request.
      "",
      "---",
      "Requested by the task owner via AgentX, started from Slack",
    ]);
    expect(said(e2e).at(-1)).toBe(OPENED(1));
  }, 120_000);

  it("6.2 a review-only PR says so first, with its reason, and how it was opened", async () => {
    const REASON = "The change only renames a constant; no project check exercises it.";
    const e2e = await createWorkflowE2E({ readiness: [], model: { plan: planAnswer(PLAN_DOCUMENT, { checks: { checks: [], none_reason: REASON } }), edits: EDITS } });
    await published(e2e);
    const body = (e2e.github.pullRequests[0]!.body ?? "").split("\n");
    expect(body.slice(0, 3)).toEqual(["Not verified by automated checks (review only).", `Why: ${REASON}`, ""]);
    expect(body.some((line) => line.startsWith("Checks:"))).toBe(false);
    expect(body.slice(-4)).toEqual(["Opened as a draft by AgentX after the owner-approved plan and reviews passed. Merge it on GitHub.", "", "---",
      "Requested by the task owner via AgentX, started from Slack"]);
  }, 120_000);

  it("6.2 a PR whose finding the owner accepted lists it and the reason", async () => {
    const REASON = "Callers already trim the name.";
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS, reviews: reviewerFindings(1) } });
    await published(e2e);
    await e2e.click("agentx_workflow_resolve_findings");
    const form = e2e.slack.views.at(-1)!.view as { blocks: Array<{ type: string; block_id?: string }> };
    const [action, note] = form.blocks.filter((block) => block.type === "input").map((block) => block.block_id!);
    await e2e.submitView({ [action!]: { action: { selected_option: { value: "ACCEPT" } } }, [note!]: { note: { value: REASON } } });
    await e2e.settle();
    const body = (e2e.github.pullRequests[0]!.body ?? "").split("\n");
    expect(body).toContain("Reviews: code review passed after the owner accepted its findings; security review passed");
    expect(body).toContain("Owner accepted 1 review finding:");
    expect(body).toContain(`- [code] Finding 1: the greeting is not trimmed. — accepted: ${REASON}`);
  }, 120_000);

  it("6.3 a push GitHub refuses is said with Retry opening the pull request, and the retry opens exactly one PR", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.github.failNext("push", 403);
    await published(e2e);
    expect(e2e.workflow().stage).toBe("PULL_REQUEST");
    const card = e2e.slack.lastPostWithAction("agentx_workflow_retry_publish");
    expect(card.text).toBe("Checks and reviews passed, but I couldn't open the draft pull request (GitHub didn't accept it). The checked code is kept.");
    expect(actionIds(card)).toEqual(["agentx_workflow_retry_publish", "agentx_workflow_close"]);
    expect(e2e.github.pullRequests).toEqual([]);
    await e2e.click("agentx_workflow_retry_publish");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]).toMatchObject({ state: "open", tree: e2e.workflow().candidate!.repositories[0]!.treeSha });
    expect(said(e2e).filter((text) => text === OPENED(1))).toHaveLength(1);
    // The retry was a publication, not more coding.
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    expectNoJargon(e2e);
  }, 120_000);

  it("6.4 a GitHub read that fails once right after the open is read again: PR #1 is kept and recorded, never closed", async () => {
    // Found by this scenario: one 502 on the head read that follows the open closed PR #1 as "not the checked code", and
    // Retry opening then opened PR #2 beside the closed one.
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.github.failNext("getPullRequest", 502);
    await published(e2e);
    expect(e2e.github.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.state])).toEqual([[1, "open"]]);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().pullRequests).toEqual([expect.objectContaining({ number: 1, headSha: e2e.github.pullRequests[0]!.commit })]);
    expect(said(e2e).at(-1)).toBe(OPENED(1));
  }, 120_000);

  it("6.4 a head read that fails twice after the open fails closed: PR #1 is closed, nothing is recorded, and Retry opening is offered", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.github.failNext("getPullRequest", 502, 2);
    await published(e2e);
    expect(e2e.github.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.state])).toEqual([[1, "closed"]]);
    expect(e2e.workflow().stage).toBe("PULL_REQUEST");
    expect(e2e.workflow().pullRequests ?? []).toEqual([]);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_retry_publish");
    expect(card.text).toBe(`Checks and reviews passed. ${WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE}`);
    expect(actionIds(card)).toEqual(["agentx_workflow_retry_publish", "agentx_workflow_close"]);
    const unreadable = logged().filter((line) => line.includes("workflow.publication_head_unreadable")).map((line) => (JSON.parse(line) as { attempt: number }).attempt);
    expect(unreadable).toEqual([1, 2]);
  }, 120_000);

  it("6.4 [LIVE-BUG B4] [R1] a publication retry while GitHub lags opens one PR of the checked code and keeps it", async () => {
    // The first publication pushes, then GitHub fails the open (502). Found by this scenario: the thread blamed AgentX
    // ("no worker was free to open it") for GitHub's failure. R1 (a retry whose push moves an open PR's head, which
    // lags, so AgentX closes the PR) does not arise: each publication attempt pushes its own branch, so a retry never
    // pushes to a pull request that is already open.
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.github.failNext("reconcilePullRequest", 502);
    await published(e2e);
    expect(e2e.github.pullRequests).toEqual([]);
    expect(e2e.slack.lastPostWithAction("agentx_workflow_retry_publish").text)
      .toBe("Checks and reviews passed, but I couldn't open the draft pull request (GitHub didn't accept it). The checked code is kept.");
    const first = e2e.github.pushLog.at(-1)!;
    e2e.github.lag({ prHeadReads: 2 });
    await e2e.click("agentx_workflow_retry_publish");
    await e2e.settle();
    const retried = e2e.github.pushLog.at(-1)!;
    expect(retried.branch).not.toBe(first.branch);
    expect(retried.tree).toBe(first.tree);
    expect(e2e.github.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest.state, pullRequest.headBranch])).toEqual([[1, "open", retried.branch]]);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(said(e2e).at(-1)).toBe(OPENED(1));
  }, 120_000);

  it("6.5 the PR notice that Slack refuses once is posted exactly once on the next delivery", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    const post = e2e.slack.post.bind(e2e.slack);
    let refused = false;
    e2e.slack.post = (input) => {
      if (!refused && input.text.startsWith("Draft pull request opened")) {
        refused = true;
        e2e.slack.failNext("chat.postMessage", "ratelimited");
      }
      return post(input);
    };
    await published(e2e);
    expect(refused).toBe(true);
    await e2e.deliverNotices();
    expect(e2e.slack.posts.filter((message) => message.text.startsWith("Draft pull request opened"))).toHaveLength(1);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("6.6 when someone moves the branch between AgentX's push and the open, the PR is closed, nothing is recorded, and Retry opening is offered", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    const push = e2e.github.push.bind(e2e.github);
    let moved = false;
    e2e.github.push = (token, branch, commit, tree, parents) => {
      push(token, branch, commit, tree, parents);
      if (!moved) { moved = true; e2e.github.foreignPushBranch(branch); }
    };
    await published(e2e);
    expect(moved).toBe(true);
    expect(e2e.workflow().stage).toBe("PULL_REQUEST");
    expect(e2e.workflow().pullRequests ?? []).toEqual([]);
    expect(e2e.github.pullRequests.every((pullRequest) => pullRequest.state === "closed")).toBe(true);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_retry_publish");
    expect(card.text).toBe(`Checks and reviews passed. ${WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE}`);
    expectNoJargon(e2e);
  }, 120_000);
});
