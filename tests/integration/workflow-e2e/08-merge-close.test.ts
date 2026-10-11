// Suite 8: merge and close. 8.1 (a merge while waiting completes the task) is covered by slack-workflow-e2e.test.ts and
// suite 7. Here: a merge in every stage (while the feedback review runs, while a proposal waits, while the fix is made,
// while it is pushed [LIVE-BUG B4], at someone else's head), closing from Slack (while waiting for the merge, and a
// blocked task's discard), a teammate's Close, and the Canvas closeout.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, agentXError } from "@agentx/contracts";
import { CLOSED_REPLY } from "../../../packages/broker/src/developer/share-messages.js";
import { SLACK_TEAM } from "../../support/slack-broker.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, FIXED, MERGED, PLAN, TEAMMATE, actionIds, atPlanReview, editsOrFix, journeySuite, openDraftPr, runs, said } from "../../support/workflow-e2e-journeys.js";

const OWNER = "U0MAYA001";
const CLOSING = "Closing this task. Its workspace is being released; I'll post here when it's closed, usually within two minutes.";
const REOPENED = "PR #1 was reopened, so I'm following it again.";
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

/** What the latest close form says. */
const closeFormText = (e2e: WorkflowE2E) => ((e2e.slack.views.at(-1)?.view.blocks as Array<{ text?: { text?: string } }> | undefined) ?? []).map((block) => block.text?.text ?? "").join("\n");
const CLOSE_AFTER_FIX_STARTED = "An approved fix started after you opened this, and closing now would discard it. Close this form and press Close task again if you still want to close.";

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

  it("8.7 D3: a closed pull request reopened is said once, by name, \"following it again\", even when GitHub redelivers the reopening", async () => {
    const { e2e, pullRequest } = await waiting();
    e2e.github.close(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "closed", number: pullRequest.number, merged: false })).status).toBe(200);
    await e2e.settle();
    e2e.github.reopen(pullRequest.number);
    const deliveryId = "87111111-2222-4333-8444-555555555555";
    e2e.stream.duplicateNext();
    expect((await e2e.webhook({ kind: "pull_request", action: "reopened", number: pullRequest.number }, { deliveryId })).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(said(e2e).at(-1)).toBe(REOPENED);
    expect(actionIds(e2e.slack.posts.at(-1)!)).toEqual(["agentx_workflow_close"]);
    const posts = e2e.slack.posts.length;
    // Redelivered (the same delivery, then a new delivery of the same event): nothing more is said.
    expect((await e2e.webhook({ kind: "pull_request", action: "reopened", number: pullRequest.number }, { deliveryId })).body).toMatchObject({ delivery: "DUPLICATE" });
    expect((await e2e.webhook({ kind: "pull_request", action: "reopened", number: pullRequest.number })).status).toBe(200);
    await e2e.settle();
    expect(e2e.slack.posts).toHaveLength(posts);
    expect(said(e2e).filter((text) => text === REOPENED)).toHaveLength(1);
    expect(said(e2e).filter((text) => text.startsWith("Draft pull request opened"))).toHaveLength(1);
    // Closed and reopened again: said again, once.
    e2e.github.close(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "closed", number: pullRequest.number, merged: false })).status).toBe(200);
    await e2e.settle();
    e2e.github.reopen(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "reopened", number: pullRequest.number })).status).toBe(200);
    await e2e.settle();
    expect(said(e2e).filter((text) => text === REOPENED)).toHaveLength(2);
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(MERGED);
  }, 120_000);

  it("8.7 a pull request closed, pushed to by someone else, then reopened: AgentX stops following it rather than following someone else's code", async () => {
    const { e2e, pullRequest } = await waiting();
    e2e.github.close(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "closed", number: pullRequest.number, merged: false })).status).toBe(200);
    await e2e.settle();
    // Someone pushes to the branch while the pull request is closed; reopened, it holds their commit.
    const foreign = e2e.github.foreignPush(pullRequest.number);
    e2e.github.reopen(pullRequest.number);
    expect(pullRequest.commit).toBe(foreign.commit);
    expect((await e2e.webhook({ kind: "pull_request", action: "reopened", number: pullRequest.number })).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.pullRequestChanged });
    expect(said(e2e).at(-1)).toBe("I stopped following the pull request. The pull request on GitHub no longer holds the checked code, so I won't finish this task from it. Close the task.");
    expect(said(e2e)).not.toContain(REOPENED);
    await mergeWebhook(e2e, pullRequest.number);
    await e2e.settle();
    expect(e2e.workflow().stage).not.toBe("MERGED");
  }, 120_000);

  it("8.8 closing from Slack while waiting for the merge: confirmed, said, the PR stays open, and a later merge is ignored", async () => {
    const { e2e, pullRequest } = await waiting();
    await e2e.click("agentx_workflow_close");
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ type: "modal" });
    expect(closeFormText(e2e)).toBe("Closing stops this task and releases its workspace. Code that isn't in a pull request is discarded. PR #1 stays open on GitHub.");
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
    // Found in review: the form said only that code not in a pull request is discarded, never that the approved fix is.
    expect(closeFormText(e2e)).toBe("Closing stops this task and releases its workspace. The approved fix that isn't on PR #1 yet is discarded. PR #1 stays open on GitHub.");
    await e2e.submitView({});
    expect(e2e.slack.responses.at(-1)?.text).toBe(CLOSING);
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.closedAt).toBeDefined();
    expect(fixPushes(e2e)).toEqual([]);
    expect(pullRequest.state).toBe("open");
  }, 120_000);

  it("8.8 the close form of a pull request closed on GitHub says it stays closed, not open", async () => {
    // Found in review: the form said "Its open pull request stays on GitHub" whatever the pull request's state.
    const { e2e, pullRequest } = await waiting();
    e2e.github.close(pullRequest.number);
    expect((await e2e.webhook({ kind: "pull_request", action: "closed", number: pullRequest.number, merged: false })).status).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_close");
    expect(closeFormText(e2e)).toBe("Closing stops this task and releases its workspace. Code that isn't in a pull request is discarded. PR #1 stays closed on GitHub.");
    await e2e.submitView({});
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
  }, 120_000);

  it("8.8 an approved fix that started after the close form opened is not discarded silently: the close is refused with why", async () => {
    // Found in review: the form, opened while the task only waited for the merge, said nothing about a fix; confirmed after
    // the owner approved one, it discarded that fix without a word.
    const { e2e, pullRequest } = await waiting();
    await comment(e2e, pullRequest.number);
    await e2e.settle();
    await e2e.click("agentx_workflow_close");
    expect(closeFormText(e2e)).toBe("Closing stops this task and releases its workspace. Code that isn't in a pull request is discarded. PR #1 stays open on GitHub.");
    // The fix is made, checked and reviewed; GitHub refuses its push, so it is still not on the pull request.
    e2e.github.failNext("push", 403);
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    const answer = await e2e.submitView({});
    expect(answer).toMatchObject({ response_action: "update" });
    expect(JSON.stringify(answer.view)).toContain(CLOSE_AFTER_FIX_STARTED);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.closedAt).toBeUndefined();
    // Pressed again, the form says the fix is discarded, and the confirmed close goes ahead.
    await e2e.click("agentx_workflow_close");
    expect(closeFormText(e2e)).toBe("Closing stops this task and releases its workspace. The approved fix that isn't on PR #1 yet is discarded. PR #1 stays open on GitHub.");
    await e2e.submitView({});
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
    expect(fixPushes(e2e)).toEqual([]);
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

  describe("8.12 a finished task gives back its open-task slot and its workspace (0.2.12 live test)", () => {
    const MEMBER = { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: `MEMBER#${OWNER}` };
    const ORGANIZATION = { pk: `SLACK_LIMIT#${SLACK_TEAM}`, sk: "ORGANIZATION" };
    const counter = (e2e: WorkflowE2E, key: { pk: string; sk: string }) => {
      const item = e2e.db.get(key.pk, key.sk);
      return { count: item?.count, tasks: [...((item?.tasks as Set<string> | undefined) ?? [])].sort() };
    };
    const tasks = (e2e: WorkflowE2E) => e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META");
    const taskById = (e2e: WorkflowE2E, taskId: string) => e2e.db.get(`DEVTASK#${taskId}`, "META")!;
    const workspaceOf = (e2e: WorkflowE2E, taskId: string) => e2e.db.get(`WORKSPACE#${String(taskById(e2e, taskId).workspaceId)}`, "META")!;
    const newestTaskId = (e2e: WorkflowE2E) => String(tasks(e2e).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1)!.taskId);

    let threads = 0;
    /** A new request at the top of the channel: its own thread. */
    const newThread = (e2e: WorkflowE2E, request: string) => {
      const ts = `1695600000.${String(++threads).padStart(6, "0")}`;
      return e2e.mention(request, { ts, threadTs: ts });
    };
    /** A new Quick request in its own thread, taken to its draft pull request and merged. Answers its task. */
    async function mergedTask(e2e: WorkflowE2E, request: string): Promise<string> {
      const before = tasks(e2e).length;
      expect(await newThread(e2e, `quick: ${request}`)).toBe(200);
      await e2e.settle();
      expect(tasks(e2e)).toHaveLength(before + 1);
      const taskId = newestTaskId(e2e);
      await e2e.click("agentx_workflow_approve");
      await e2e.settle();
      const pullRequest = e2e.github.pullRequests.at(-1)!;
      await mergeWebhook(e2e, pullRequest.number);
      await e2e.settle();
      expect(taskById(e2e, taskId).workflow).toMatchObject({ stage: "MERGED", state: "COMPLETE", outcome: "MERGED" });
      return taskId;
    }

    it("a merge releases the task's slot and its workspace, once, and a redelivered merge changes nothing", async () => {
      const { e2e, pullRequest } = await waiting();
      const taskId = e2e.taskId();
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [taskId] });
      await mergeWebhook(e2e, pullRequest.number);
      await e2e.settle();
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(counter(e2e, ORGANIZATION).count).toBe(0);
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(1);
      expect(e2e.deleteEc2Session).toHaveBeenCalledWith(taskById(e2e, taskId).workspaceId);
      // The task is complete, not closed: no close notice, and its last word is the merge.
      expect(taskById(e2e, taskId).closedAt).toBeUndefined();
      expect(said(e2e).at(-1)).toBe(MERGED);
      // GitHub sends the merge again, and once more with a new delivery ID.
      expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
      expect((await e2e.webhook({ kind: "pull_request", number: pullRequest.number, action: "closed", merged: true })).status).toBe(200);
      await e2e.settle();
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(counter(e2e, ORGANIZATION).count).toBe(0);
      expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(1);
    }, 120_000);

    it("a question in a merged task's thread is still answered after its workspace is released", async () => {
      const { e2e, pullRequest } = await waiting();
      await mergeWebhook(e2e, pullRequest.number);
      await e2e.settle();
      expect(workspaceOf(e2e, e2e.taskId()).status).toBe("CLOSED");
      const QUESTION = "what did this change?";
      expect(await e2e.mention(QUESTION)).toBe(200);
      await e2e.settle();
      const before = e2e.slack.posts.length;
      await e2e.answerTaskQuestions({ route: () => ({ kind: "question", outcome: "ok" }), answer: (question) => `Answer to: ${question}` });
      const texts = [...e2e.slack.posts.slice(before).map((post) => post.text), ...e2e.slack.ephemerals.map((message) => message.text)];
      expect(texts).toContain(`<@${OWNER}> Answer to: ${QUESTION}`);
      expect(texts).not.toContain(CLOSED_REPLY);
    }, 120_000);

    /** The owner rejects the coding plan through their AI tool (the one way to reject one). */
    async function rejectPlan(e2e: WorkflowE2E): Promise<void> {
      const workflow = e2e.workflow();
      const plan = workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!;
      const answer = await e2e.mcp("agentx_decide_workflow", { task_id: e2e.taskId(), request_id: randomUUID(), expected_revision: workflow.revision,
        decision: "REJECT", reason: "Not needed after all.", artifact_digest: plan.sha256 });
      expect(answer.isError).toBe(false);
      await e2e.settle();
      expect(e2e.workflow()).toMatchObject({ stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" });
    }

    it("a rejected plan gives back its slot and its workspace at once, with the close's audit record and its reason", async () => {
      const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
      await atPlanReview(e2e);
      const taskId = e2e.taskId();
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [taskId] });
      await rejectPlan(e2e);
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(counter(e2e, ORGANIZATION).count).toBe(0);
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(1);
      const records = e2e.db.find((item) => item.taskId === taskId && item.action === "close" && item.phase === "completed");
      expect(records.map((record) => record.responseText)).toEqual(["The task is complete (its plan was rejected), and its workspace is released."]);
      // Its Canvas closeout runs as a closed task's does.
      expect(e2e.workflow().canvasCloseout).toMatchObject({ status: "COMPLETE", terminalState: "CLOSED" });
    }, 120_000);

    it("a merge writes the close's audit record once, saying the pull request merged", async () => {
      const { e2e, pullRequest } = await waiting();
      await mergeWebhook(e2e, pullRequest.number);
      await e2e.settle();
      expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
      await e2e.settle();
      const records = e2e.db.find((item) => item.taskId === e2e.taskId() && item.action === "close" && item.phase === "completed");
      expect(records.map((record) => record.responseText)).toEqual(["The task is complete (its pull request merged), and its workspace is released."]);
    }, 120_000);

    it("compute that refuses while it stops: the release keeps its claim, and the next event finishes it, once", async () => {
      const { e2e, pullRequest } = await waiting();
      const taskId = e2e.taskId();
      e2e.deleteEc2Session.mockImplementationOnce(async () => { throw agentXError("WORKSPACE_BUSY", "the workspace compute is stopping"); });
      await mergeWebhook(e2e, pullRequest.number);
      // The workspace is claimed (nothing can start there), but nothing is given back yet.
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSING");
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [taskId] });
      // GitHub's next delivery (a redelivery, say) takes the claim up.
      expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
      await e2e.settle();
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(counter(e2e, ORGANIZATION).count).toBe(0);
      expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(2);
    }, 120_000);

    it("a release that keeps finding the compute busy is finished by the recovery sweep", async () => {
      const { e2e, pullRequest } = await waiting();
      const taskId = e2e.taskId();
      e2e.deleteEc2Session.mockImplementationOnce(async () => { throw agentXError("WORKSPACE_BUSY", "the workspace compute is stopping"); });
      await mergeWebhook(e2e, pullRequest.number);
      await e2e.settle();
      expect(counter(e2e, MEMBER).count).toBe(1);
      expect(e2e.db.get("FINISHED_RELEASE", `TASK#${taskId}`)).toBeDefined();
      // No more events come for a merged task: the scheduled sweep tries again once the next try is due.
      expect((await e2e.runRecovery()).dispatch.body.releases).toEqual({ attempted: 0, released: 0 });
      e2e.clock.set(new Date(Date.now() + 6 * 60_000).toISOString());
      const swept = await e2e.runRecovery();
      expect(swept.dispatch.body.releases).toEqual({ attempted: 1, released: 1 });
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(e2e.db.get("FINISHED_RELEASE", `TASK#${taskId}`)).toBeUndefined();
      expect((await e2e.runRecovery()).dispatch.body.releases).toEqual({ attempted: 0, released: 0 });
    }, 120_000);

    /** Copies of a merged task, each finished, in its own thread and workspace (READY), not counted anywhere. */
    function finishedCopies(e2e: WorkflowE2E, taskId: string, ids: readonly string[]): void {
      const original = taskById(e2e, taskId);
      for (const [index, id] of ids.entries()) {
        const workspaceId = randomUUID();
        const { closedAt: _closed, ...workspace } = workspaceOf(e2e, taskId);
        void _closed;
        e2e.db.set({ ...workspace, pk: `WORKSPACE#${workspaceId}`, id: workspaceId, status: "READY" });
        const { releasedAt: _released, ...task } = original;
        void _released;
        e2e.db.set({ ...task, pk: `DEVTASK#${id}`, taskId: id, workspaceId,
          share: { ...(original.share as Record<string, unknown>), threadTs: `1695800000.${String(index).padStart(6, "0")}` } });
      }
    }

    it("marks that keep failing never hold back the others: each is put off with backoff, and a good one behind them is released", async () => {
      const { e2e, pullRequest } = await waiting();
      const taskId = e2e.taskId();
      await mergeWebhook(e2e, pullRequest.number);
      await e2e.settle();
      // Eleven finished tasks whose compute can't be deleted, marked long ago, ahead of the good one in key order too.
      const failing = Array.from({ length: 11 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
      finishedCopies(e2e, taskId, failing);
      const failingWorkspaces = new Set(failing.map((id) => String(taskById(e2e, id).workspaceId)));
      for (const id of failing) e2e.db.set({ pk: "FINISHED_RELEASE", sk: `TASK#${id}`, entityType: "FINISHED_RELEASE", taskId: id, markedAt: "2026-01-01T00:00:00.000Z" });
      // The good one: a merged task whose release found the compute busy once.
      const { releasedAt: _released, ...good } = taskById(e2e, taskId);
      void _released;
      e2e.db.set(good);
      e2e.db.set({ ...workspaceOf(e2e, taskId), status: "READY" });
      e2e.db.set({ pk: "FINISHED_RELEASE", sk: `TASK#${taskId}`, entityType: "FINISHED_RELEASE", taskId, markedAt: new Date().toISOString() });
      e2e.deleteEc2Session.mockImplementation(async (workspaceId: string) => {
        if (failingWorkspaces.has(workspaceId)) throw agentXError("RUNTIME_UNAVAILABLE", "workspace resource cleanup failed");
      });
      expect((await e2e.runRecovery()).dispatch.body.releases).toEqual({ attempted: 10, released: 0 });
      // The ten that failed wait now; the eleventh and the good one are due.
      // (Its slot went back at the merge, so only its workspace was left to release.)
      expect((await e2e.runRecovery()).dispatch.body.releases).toMatchObject({ attempted: 2 });
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(taskById(e2e, taskId).releasedAt).toBeDefined();
      expect(e2e.db.get("FINISHED_RELEASE", `TASK#${taskId}`)).toBeUndefined();
      expect(e2e.db.get("FINISHED_RELEASE", `TASK#${failing[0]!}`)).toMatchObject({ attempts: 1 });
      // Once the compute can be deleted again, later sweeps finish the rest.
      e2e.deleteEc2Session.mockImplementation(async () => undefined);
      e2e.clock.set(new Date(Date.now() + 7 * 3_600_000).toISOString());
      await e2e.runRecovery();
      await e2e.runRecovery();
      expect(failing.map((id) => workspaceOf(e2e, id).status)).toEqual(failing.map(() => "CLOSED"));
      expect(e2e.db.find((item) => item.pk === "FINISHED_RELEASE")).toEqual([]);
    }, 120_000);

    it("a self-heal whose compute delete refuses leaves a mark, and the sweep finishes it", async () => {
      const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
      const merged = await mergedTask(e2e, "Add a greet(name) function");
      const copies = [randomUUID(), randomUUID()];
      finishedCopies(e2e, merged, copies);
      const stuck = [merged, ...copies];
      const { releasedAt: _released, ...task } = taskById(e2e, merged);
      void _released;
      e2e.db.set(task);
      e2e.db.set({ ...workspaceOf(e2e, merged), status: "READY" });
      e2e.db.set({ ...e2e.db.get(MEMBER.pk, MEMBER.sk), count: 3, tasks: new Set(stuck) });
      e2e.db.set({ ...e2e.db.get(ORGANIZATION.pk, ORGANIZATION.sk), count: 3 });
      e2e.deleteEc2Session.mockImplementationOnce(async () => { throw agentXError("WORKSPACE_BUSY", "the workspace compute is stopping"); });
      expect(await newThread(e2e, "quick: Add a farewell(name) function")).toBe(200);
      await e2e.settle();
      const started = newestTaskId(e2e);
      expect(stuck).not.toContain(started);
      // One of the three kept its claim (CLOSING) and its slot, with a mark for the sweep.
      const marks = e2e.db.find((item) => item.pk === "FINISHED_RELEASE");
      expect(marks).toHaveLength(1);
      const kept = String(marks[0]!.taskId);
      expect(workspaceOf(e2e, kept).status).toBe("CLOSING");
      expect(counter(e2e, MEMBER)).toEqual({ count: 2, tasks: [kept, started].sort() });
      e2e.clock.set(new Date(Date.now() + 6 * 60_000).toISOString());
      expect((await e2e.runRecovery()).dispatch.body.releases).toEqual({ attempted: 1, released: 1 });
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [started] });
      expect(counter(e2e, ORGANIZATION).count).toBe(1);
      expect(stuck.map((id) => workspaceOf(e2e, id).status)).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
    }, 240_000);

    it("the compute is deleted but the release's transaction fails: nothing is given back, and a later event gives it back once", async () => {
      const { e2e, pullRequest } = await waiting();
      const taskId = e2e.taskId();
      const workspaceKey = { pk: `WORKSPACE#${String(taskById(e2e, taskId).workspaceId)}`, sk: "META" };
      // While the compute is deleted, the workspace's claim is lost (its record moved back), so the commit's condition fails.
      e2e.deleteEc2Session.mockImplementationOnce(async () => { e2e.db.set({ ...e2e.db.get(workspaceKey.pk, workspaceKey.sk)!, status: "READY" }); });
      await mergeWebhook(e2e, pullRequest.number);
      expect(workspaceOf(e2e, taskId).status).toBe("READY");
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [taskId] });
      expect(taskById(e2e, taskId).releasedAt).toBeUndefined();
      expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
      await e2e.settle();
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(counter(e2e, ORGANIZATION).count).toBe(0);
    }, 120_000);

    it("two releases at once (a webhook and an operation's result racing) give the slot back exactly once", async () => {
      const { e2e, pullRequest } = await waiting();
      const taskId = e2e.taskId();
      e2e.github.merge(pullRequest.number);
      const statuses = await e2e.concurrently(
        () => e2e.webhook({ kind: "pull_request", number: pullRequest.number, action: "closed", merged: true }),
        () => e2e.webhook({ kind: "pull_request", number: pullRequest.number, action: "closed", merged: true }),
        () => e2e.webhook({ kind: "pull_request", number: pullRequest.number, action: "closed", merged: true }),
      ) as Array<{ status: number }>;
      expect(statuses.map((answer) => answer.status)).toEqual([200, 200, 200]);
      await e2e.settle();
      expect(taskById(e2e, taskId).workflow).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(counter(e2e, ORGANIZATION).count).toBe(0);
      expect(workspaceOf(e2e, taskId).status).toBe("CLOSED");
      expect(e2e.db.find((item) => item.taskId === taskId && item.action === "close" && item.phase === "completed")).toHaveLength(1);
    }, 120_000);

    it("a merge while the feedback review runs releases the slot once that review ends", async () => {
      const { e2e, pullRequest } = await waiting();
      await comment(e2e, pullRequest.number);
      await e2e.deliverNotices();
      await mergeWebhook(e2e, pullRequest.number);
      // The review is still running on the workspace: nothing is released under it.
      expect(counter(e2e, MEMBER).count).toBe(1);
      expect(e2e.deleteEc2Session).not.toHaveBeenCalled();
      await e2e.settle();
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(workspaceOf(e2e, e2e.taskId()).status).toBe("CLOSED");
    }, 120_000);

    it("after three merged tasks, a fourth request starts (the per-person limit is 3)", async () => {
      const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
      const merged = [await mergedTask(e2e, "Add a greet(name) function"), await mergedTask(e2e, "Add a farewell(name) function"), await mergedTask(e2e, "Add a wave(name) function")];
      expect(counter(e2e, MEMBER)).toEqual({ count: 0, tasks: [] });
      expect(merged.map((taskId) => workspaceOf(e2e, taskId).status)).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
      expect(await newThread(e2e, "quick: Add a nod(name) function")).toBe(200);
      await e2e.settle();
      expect(tasks(e2e)).toHaveLength(4);
      expect(said(e2e).some((text) => text.includes("limit of open AgentX tasks"))).toBe(false);
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [newestTaskId(e2e)] });
    }, 240_000);

    it("self-heal: slots merged tasks kept before this release are given back when a start meets the limit", async () => {
      const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
      const merged = await mergedTask(e2e, "Add a greet(name) function");
      // As the live table was: three finished tasks still counted (two merged, one rejected), their workspaces READY, no
      // release recorded.
      const original = taskById(e2e, merged);
      const stuck = [merged, randomUUID(), randomUUID()];
      for (const taskId of stuck.slice(1)) {
        const workspaceId = randomUUID();
        e2e.db.set({ ...workspaceOf(e2e, merged), pk: `WORKSPACE#${workspaceId}`, id: workspaceId });
        // Each in its own thread, as each was started.
        const share = { ...(original.share as Record<string, unknown>), threadTs: `1695700000.${String(stuck.indexOf(taskId)).padStart(6, "0")}` };
        // The last one's plan was rejected instead (CLOSED/COMPLETE, outcome REJECTED).
        const workflow = taskId === stuck[2] ? { ...(original.workflow as Record<string, unknown>), stage: "CLOSED", state: "COMPLETE", outcome: "REJECTED" } : original.workflow;
        e2e.db.set({ ...original, pk: `DEVTASK#${taskId}`, taskId, workspaceId, share, workflow });
      }
      for (const taskId of stuck) {
        const { releasedAt: _released, ...task } = taskById(e2e, taskId);
        void _released;
        e2e.db.set(task);
        const { closedAt: _closed, ...workspace } = workspaceOf(e2e, taskId);
        void _closed;
        e2e.db.set({ ...workspace, status: "READY" });
      }
      e2e.db.set({ ...e2e.db.get(MEMBER.pk, MEMBER.sk), count: 3, tasks: new Set(stuck) });
      e2e.db.set({ ...e2e.db.get(ORGANIZATION.pk, ORGANIZATION.sk), count: 3 });
      e2e.deleteEc2Session.mockClear();
      expect(await newThread(e2e, "quick: Add a farewell(name) function")).toBe(200);
      await e2e.settle();
      expect(said(e2e).some((text) => text.includes("limit of open AgentX tasks"))).toBe(false);
      const started = newestTaskId(e2e);
      expect(stuck).not.toContain(started);
      expect(counter(e2e, MEMBER)).toEqual({ count: 1, tasks: [started] });
      expect(counter(e2e, ORGANIZATION).count).toBe(1);
      expect(stuck.map((taskId) => workspaceOf(e2e, taskId).status)).toEqual(["CLOSED", "CLOSED", "CLOSED"]);
      expect(e2e.deleteEc2Session).toHaveBeenCalledTimes(3);
    }, 240_000);
  });
});
