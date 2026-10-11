// Suite 8: merge and close. 8.1 (a merge while waiting completes the task) is covered by slack-workflow-e2e.test.ts and
// suite 7. Here: a merge in every stage (while the feedback review runs, while a proposal waits, while the fix is made,
// while it is pushed [LIVE-BUG B4], at someone else's head), closing from Slack (while waiting for the merge, and a
// blocked task's discard), a teammate's Close, and the Canvas closeout.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS } from "@agentx/contracts";
import { CLOSED_REPLY } from "../../../packages/broker/src/developer/share-messages.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, FIXED, MERGED, PLAN, TEAMMATE, actionIds, atPlanReview, editsOrFix, journeySuite, openDraftPr, runs, said } from "../../support/workflow-e2e-journeys.js";

const OWNER = "U0MAYA001";
const CLOSING = "Closing this task. Its workspace is being released; I'll post here when it's closed, usually within two minutes.";
const OUT_OF_DATE = "That button is out of date. Use the latest message in this thread.";

async function waiting(options: Parameters<typeof createWorkflowE2E>[0] = {}) {
  const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix }, ...options });
  const pullRequest = await openDraftPr(e2e);
  return { e2e, pullRequest };
}

/** A comment on the pull request, and its webhook; the journey is not settled (the feedback review is queued). */
async function comment(e2e: WorkflowE2E, number: number, body = "Please trim the name."): Promise<void> {
  const added = e2e.github.comment(number, "octocat", body);
  expect(await e2e.githubWebhook(number, { comment: added })).toBe(200);
}

async function mergeWebhook(e2e: WorkflowE2E, number: number): Promise<void> {
  e2e.github.merge(number);
  expect(await e2e.githubWebhook(number, { merged: true })).toBe(200);
}

/** A plan saved as Markdown (before plans were structured): the only kind whose card is a Slack Canvas. */
const MARKDOWN_PLAN = "# Plan\n\n1. Add greet to greeting.ts.\n2. Run node --version.\n";
const canvasIds = (e2e: WorkflowE2E) => (e2e.workflow().canvasLineage ?? []).map((entry) => entry.canvasId).filter((id): id is string => id !== undefined);

const fixPushes = (e2e: WorkflowE2E) => e2e.github.pushLog.filter((push) => push.during === "maintain" && e2e.github.tokens.has(push.token));
/** What the thread said after the task's completion. */
const afterCompletion = (e2e: WorkflowE2E) => said(e2e).slice(said(e2e).indexOf(MERGED) + 1);

describe("Suite 8: merge and close", () => {
  journeySuite();

  it("8.2 a merge while the feedback review runs completes the task, and the late review says nothing after it", async () => {
    const { e2e, pullRequest } = await waiting();
    await comment(e2e, pullRequest.number);
    await e2e.deliverNotices();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "RUNNING" });
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    expect(said(e2e)).toContain(MERGED);
    expect(afterCompletion(e2e)).toEqual([]);
    expect(e2e.slack.posts.filter((post) => post.text.startsWith("PR feedback is ready"))).toEqual([]);
  }, 120_000);

  it("8.3 a merge while a proposal waits completes the task, retires the card, and an old press is refused", async () => {
    const { e2e, pullRequest } = await waiting();
    await comment(e2e, pullRequest.number);
    await e2e.settle();
    const card = e2e.slack.lastPostWithAction("agentx_feedback_review_recommended");
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(said(e2e).at(-1)).toBe(MERGED);
    const edits = e2e.slack.updates.filter((update) => update.ts === card.ts);
    expect(edits.at(-1)?.blocks?.some((block) => (block as { type: string }).type === "actions")).toBe(false);
    const revision = e2e.workflow().revision;
    await e2e.click("agentx_feedback_review_recommended", { messageTs: card.ts });
    await e2e.settle();
    expect([...e2e.slack.responses.map((response) => response.text), ...e2e.slack.ephemerals.map((message) => message.text)].at(-1)).toBe(OUT_OF_DATE);
    expect(e2e.workflow().revision).toBe(revision);
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
  }, 120_000);

  it("8.4 a merge of the reviewed code while the fix is coded completes the task, and the fix is never pushed", async () => {
    const { e2e, pullRequest } = await waiting();
    const reviewedHead = pullRequest.commit;
    await comment(e2e, pullRequest.number);
    await e2e.settle();
    await e2e.click("agentx_feedback_review_recommended");
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT" });
    // The fix is coded (one step); then GitHub merges the pull request as it is.
    await e2e.settle(1).catch(() => undefined);
    expect(await e2e.repoFile("greeting.ts")).toBe(FIXED[0]!.content);
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED", pullRequests: [expect.objectContaining({ state: "MERGED", headSha: reviewedHead })] });
    expect(e2e.github.minted.filter((entry) => entry.during === "maintain")).toEqual([]);
    expect(fixPushes(e2e)).toEqual([]);
    expect(said(e2e).filter((text) => text.startsWith("Checks and reviews passed. Pushing the fix"))).toEqual([]);
    expect(said(e2e).at(-1)).toBe(MERGED);
  }, 120_000);

  it("8.5 [LIVE-BUG B4] GitHub merges the pushed fix before its result is recorded: the task completes with the fix recorded", async () => {
    const { e2e, pullRequest } = await waiting();
    await comment(e2e, pullRequest.number);
    await e2e.settle();
    const push = e2e.github.push.bind(e2e.github);
    let mergedAtFix = false;
    e2e.github.push = (token, branch, commit, tree, parents) => {
      push(token, branch, commit, tree, parents);
      if (e2e.github.during === "maintain" && !mergedAtFix) { mergedAtFix = true; e2e.github.merge(pullRequest.number); }
    };
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    expect(mergedAtFix).toBe(true);
    expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await e2e.settle();
    const fix = fixPushes(e2e);
    expect(fix).toHaveLength(1);
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
    expect(e2e.workflow().pullRequests).toEqual([expect.objectContaining({ state: "MERGED", headSha: fix[0]!.commit, headTreeSha: fix[0]!.tree })]);
    expect(said(e2e).at(-1)).toBe(MERGED);
  }, 120_000);

  it("8.6 a merge at someone else's head does not complete the task", async () => {
    const { e2e, pullRequest } = await waiting();
    e2e.github.foreignPush(pullRequest.number);
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow().stage).not.toBe("MERGED");
    expect(said(e2e)).not.toContain(MERGED);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(said(e2e).at(-1)).toBe("I stopped following the pull request. The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.");
  }, 120_000);

  it("8.7 a pull request closed on GitHub without merging stops the task with Close; reopened and merged, it completes", async () => {
    // Found by this scenario: the close was recorded but the task kept waiting, and the thread said "Draft pull request
    // opened: PR #1. Review it and merge it on GitHub..." again for a pull request that was closed. The words are open
    // decision D3's recommendation.
    const { e2e, pullRequest } = await waiting();
    e2e.github.close(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "closed", number: pullRequest.number, merged: false })).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestClosed });
    const card = e2e.slack.posts.at(-1)!;
    expect(card.text).toBe("The pull request was closed on GitHub without merging. Reopen it there, or close this task.");
    expect(actionIds(card)).toEqual(["agentx_workflow_close"]);
    expect(said(e2e).filter((text) => text.startsWith("Draft pull request opened"))).toHaveLength(1);
    e2e.github.reopen(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "reopened", number: pullRequest.number })).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(said(e2e).at(-1)).toBe(MERGED);
  }, 120_000);

  it.todo("8.7 D3: what the thread says when a closed pull request is reopened (open decision D3; today it says \"Draft pull request opened\" again)");

  it("8.8 closing from Slack while waiting for the merge: confirmed, said, the PR stays open, and a later merge is ignored", async () => {
    const { e2e, pullRequest } = await waiting();
    await e2e.click("agentx_workflow_close");
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ type: "modal" });
    await e2e.submitView({});
    expect(e2e.slack.responses.at(-1)?.text).toBe(CLOSING);
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.closedAt).toBeDefined();
    expect(pullRequest.state).toBe("open");
    const posts = e2e.slack.posts.length;
    const revision = e2e.workflow().revision;
    e2e.github.merge(pullRequest.number);
    const late = await e2e.webhook({ kind: "pull_request", action: "closed", number: pullRequest.number, merged: true });
    expect(late.status).toBe(200);
    await e2e.settle();
    expect(e2e.slack.posts).toHaveLength(posts);
    expect(e2e.workflow().revision).toBe(revision);
    expect(e2e.workflow().stage).not.toBe("MERGED");
  }, 120_000);

  it("8.8 closing while an approved fix GitHub refused is still unpushed: the confirmed close discards it and closes", async () => {
    // Found by this scenario: with a pull request open, the close kept its check for unpublished work, so the unpushed fix
    // refused it, and the thread, told "I'll post here when it's closed", heard nothing more. The modal the owner
    // confirmed says code that isn't in a pull request is discarded.
    const { e2e, pullRequest } = await waiting();
    await comment(e2e, pullRequest.number);
    await e2e.settle();
    e2e.github.failNext("push", 403);
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    await e2e.click("agentx_workflow_close");
    expect(JSON.stringify(e2e.slack.views.at(-1)?.view)).toContain("Code that isn't in a pull request is discarded. Its open pull request stays on GitHub.");
    await e2e.submitView({});
    expect(e2e.slack.responses.at(-1)?.text).toBe(CLOSING);
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.closedAt).toBeDefined();
    expect(fixPushes(e2e)).toEqual([]);
    expect(pullRequest.state).toBe("open");
  }, 120_000);

  it("8.9 closing a blocked task before any pull request discards its work: no push token, no branch", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, checkResult: () => ({ exitCode: 1, stdout: "", stderr: "1 failing" }) });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    await e2e.click("agentx_workflow_close");
    await e2e.submitView({});
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
    expect(e2e.github.minted.filter((entry) => entry.access === "push")).toEqual([]);
    expect(e2e.github.pushes.size).toBe(0);
    expect(e2e.github.pullRequests).toEqual([]);
  }, 120_000);

  it("8.10 a teammate's Close is refused, and nothing moves", async () => {
    const { e2e } = await waiting();
    const revision = e2e.workflow().revision;
    await e2e.click("agentx_workflow_close", { user: TEAMMATE });
    if (e2e.slack.views.length > 0) await e2e.submitView({}, { user: TEAMMATE }).catch(() => undefined);
    await e2e.settle();
    expect(e2e.slack.responses.at(-1)?.text).toBe(`Only <@${OWNER}> can close this task.`);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", revision });
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.closedAt).toBeUndefined();
  }, 120_000);

  it("8.11 after the merge the plan's Canvas is closed out once, even when the stream delivers the closeout twice", async () => {
    const { e2e, pullRequest } = await waiting({ legacyPlanMarkdown: MARKDOWN_PLAN });
    const canvases = canvasIds(e2e);
    expect(canvases).toHaveLength(1);
    e2e.stream.duplicateNext();
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow().canvasCloseout).toMatchObject({ status: "COMPLETE", terminalState: "MERGED" });
    expect(e2e.canvasesDeleted).toEqual(canvases);
    await e2e.settle();
    expect(e2e.canvasesDeleted).toEqual(canvases);
  }, 120_000);

  it("8.11 after a close from Slack the Canvas is closed out with the task CLOSED", async () => {
    const { e2e } = await waiting({ legacyPlanMarkdown: MARKDOWN_PLAN });
    const canvases = canvasIds(e2e);
    expect(canvases).toHaveLength(1);
    await e2e.click("agentx_workflow_close");
    await e2e.submitView({});
    await e2e.settle();
    expect(e2e.workflow().canvasCloseout).toMatchObject({ status: "COMPLETE", terminalState: "CLOSED" });
    expect(e2e.canvasesDeleted).toEqual(canvases);
  }, 120_000);

  it("8.11 where Slack can't create a Canvas, the card links the task page, and the closeout has nothing to delete", async () => {
    const { e2e, pullRequest } = await waiting({ canvas: "unavailable", legacyPlanMarkdown: MARKDOWN_PLAN });
    const card = e2e.slack.posts.find((post) => actionIds(post).includes("agentx_workflow_approve"))!;
    expect(card.text).toContain(`/review/${e2e.taskId()}/task`);
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(e2e.canvasesDeleted).toEqual([]);
    expect(e2e.workflow().canvasCloseout?.canvases ?? []).toEqual([]);
  }, 120_000);
});
