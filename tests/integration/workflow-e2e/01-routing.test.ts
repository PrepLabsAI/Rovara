// Suite 1: routing and start. Who may press what on a task's cards, what a repeated or stale press does, which Slack
// events start nothing, and what the owner is told when a task cannot start. Scenarios 1.1-1.7 are covered by
// slack-workflow-e2e.test.ts and slack-request-routing.test.ts (see the plan's catalogue).
import { describe, expect, it } from "vitest";
import { MAYA } from "../../support/developer-task-broker.js";
import { createWorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, PLAN, TEAMMATE, actionIds, atPlanReview, expectNoJargon, journeySuite, runs, said } from "../../support/workflow-e2e-journeys.js";
import { workflowStartedNotice } from "../../../packages/broker/src/aws/slack-workflow-choice.js";

const OWNER = MAYA.slackUserId!;
const APPROVED = `Coding plan approved by <@${OWNER}>. Writing the code now; then I'll run 1 check.`;
const tasks = (e2e: Awaited<ReturnType<typeof createWorkflowE2E>>) => e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META");

describe("Suite 1: routing and start", () => {
  journeySuite();

  it("1.8 refuses a teammate's Approve on the plan card privately, and the card keeps its buttons", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    const before = e2e.workflow().revision;
    await e2e.click("agentx_workflow_approve", { user: "U0OTHER01" });
    await e2e.settle();
    // The refusal names the owner, privately, to the presser only (the button's own answer).
    expect(e2e.slack.responses.map((response) => response.text)).toEqual([`Only <@${OWNER}> can approve this step.`]);
    expect(e2e.slack.views).toEqual([]);
    // Nothing moved: same revision, no decision, no coding run, and the card was not edited.
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision: before, decisions: [] });
    expect(runs(e2e)).not.toContain("IMPLEMENT");
    expect(e2e.slack.updates.filter((update) => update.ts === card.ts)).toEqual([]);
    expect(actionIds(card)).toContain("agentx_workflow_approve");
    // The owner's own press still works from the same card.
    await e2e.click("agentx_workflow_approve", { messageTs: card.ts });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expectNoJargon(e2e);
  }, 120_000);

  it("1.9 records one approval and one coding run when Slack delivers the same press twice", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve", { deliver: "twice" });
    await e2e.settle();
    expect(e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE")).toHaveLength(1);
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    expect(e2e.slack.posts.filter((post) => post.text === APPROVED)).toHaveLength(1);
    // The repeated press is never told that something went wrong.
    expect([...e2e.slack.responses.map((response) => response.text), ...e2e.slack.ephemerals.map((message) => message.text)]
      .filter((text) => /error|couldn't|wrong/i.test(text))).toEqual([]);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.github.pullRequests).toHaveLength(1);
  }, 120_000);

  it("1.9 records one approval and one coding run for a double tap (two presses at once)", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    await e2e.concurrently(() => e2e.click("agentx_workflow_approve"), () => e2e.click("agentx_workflow_approve"));
    await e2e.settle();
    expect(e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE")).toHaveLength(1);
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    expect(e2e.slack.posts.filter((post) => post.text === APPROVED)).toHaveLength(1);
    expect([...e2e.slack.responses.map((response) => response.text), ...e2e.slack.ephemerals.map((message) => message.text)]
      .filter((text) => /error|couldn't|wrong/i.test(text))).toEqual([]);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("1.10 tells the owner an Approve on the v1 card is out of date once v2 exists, and the v2 card is untouched", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    const v1 = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    await e2e.click("agentx_workflow_changes");
    await e2e.submitView({ workflow_feedback: { reason: { value: "Name the function hello instead." } } });
    await e2e.settle();
    const v2 = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    expect(v2.ts).not.toBe(v1.ts);
    expect(v2.text).toContain("*Coding plan v2 is ready for your approval.*");
    const revision = e2e.workflow().revision;
    await e2e.click("agentx_workflow_approve", { messageTs: v1.ts });
    await e2e.settle();
    // Slack's interactivity sees the card's plan is not the current one and answers the press privately at once (the
    // broker's own "That approval is out of date..." is for a press that gets past this check).
    expect(e2e.slack.responses.map((response) => response.text).at(-1)).toBe("That approval is out of date. Use the latest message in this thread.");
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision });
    expect(e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE")).toEqual([]);
    expect(runs(e2e)).not.toContain("IMPLEMENT");
    expect(e2e.slack.updates.filter((update) => update.ts === v2.ts)).toEqual([]);
    expectNoJargon(e2e);
  }, 120_000);

  it("1.11 ignores the bot's own messages, at the top level and in a task thread", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, route: () => { throw new Error("the classifier must not be asked"); } });
    expect(await e2e.mention("quick: Add a greet(name) function", { type: "message", botId: "B0AGENTX01", subtype: "bot_message", ts: "1695500300.000001", threadTs: "1695500300.000001" })).toBe(200);
    expect(tasks(e2e)).toEqual([]);
    expect(e2e.slack.posts).toEqual([]);
    await atPlanReview(e2e);
    const posts = e2e.slack.posts.length;
    const notes = () => e2e.db.find((item) => String(item.sk).startsWith("NOTE#"));
    expect(await e2e.mention("Draft pull request opened: PR #1.", { type: "message", botId: "B0AGENTX01", subtype: "bot_message" })).toBe(200);
    expect(await e2e.mention("Here is what I think.", { botId: "B0AGENTX01" })).toBe(200);
    await e2e.settle();
    expect(tasks(e2e)).toHaveLength(1);
    expect(notes()).toEqual([]);
    expect(e2e.taskQuestions).toEqual([]);
    expect(e2e.slack.posts).toHaveLength(posts);
    expect(e2e.slack.ephemerals).toEqual([]);
    expect(e2e.routeCalls).toEqual([]);
    expect(e2e.chatQueue).toEqual([]);
  }, 120_000);

  it("1.12 starts nothing and saves nothing for an edited message, top level or in the task thread", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, route: () => { throw new Error("the classifier must not be asked"); } });
    await atPlanReview(e2e);
    const posts = e2e.slack.posts.length;
    expect(await e2e.mention("quick: something else", { type: "message", subtype: "message_changed", ts: "1695500400.000001", threadTs: "1695500400.000001" })).toBe(200);
    expect(await e2e.mention("Keep it in English, please.", { type: "message", subtype: "message_changed" })).toBe(200);
    await e2e.settle();
    expect(tasks(e2e)).toHaveLength(1);
    expect(e2e.db.find((item) => String(item.sk).startsWith("NOTE#"))).toEqual([]);
    expect(e2e.slack.posts).toHaveLength(posts);
    expect(e2e.slack.ephemerals).toEqual([]);
    expect(e2e.chatQueue).toEqual([]);
    expect(e2e.routeCalls).toEqual([]);
  }, 120_000);

  it("1.13 starts one task and says so once when Slack delivers the same event again", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function", { eventId: "Ev0DUPLICATE1", ts: "1695500500.000001", threadTs: "1695500500.000001" })).toBe(200);
    expect(await e2e.mention("quick: Add a greet(name) function", { eventId: "Ev0DUPLICATE1", ts: "1695500500.000001", threadTs: "1695500500.000001", retryNum: 1 })).toBe(200);
    await e2e.settle();
    expect(tasks(e2e)).toHaveLength(1);
    expect(said(e2e).filter((text) => text === workflowStartedNotice("QUICK"))).toHaveLength(1);
    expect(said(e2e).filter((text) => text.startsWith("*Coding plan v1 is ready"))).toHaveLength(1);
  }, 120_000);

  it("1.14 treats a quick: mention in a thread that already has a task as a note for that task, not a second task", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    const posts = e2e.slack.posts.length;
    expect(await e2e.mention("quick: another change")).toBe(200);
    await e2e.settle();
    // The ingress keeps it in the task's thread: saved as a note and sent for the question check; no second task, no refusal.
    expect(tasks(e2e)).toHaveLength(1);
    expect(e2e.taskQuestions.map((message) => message.text)).toEqual(["quick: another change"]);
    expect(e2e.db.find((item) => String(item.sk).startsWith("NOTE#"))).toHaveLength(1);
    expect(e2e.slack.posts).toHaveLength(posts);
    expect(said(e2e)).not.toContain("This thread already has a task. Start a new request in the channel.");
  }, 120_000);

  it("1.15 stays silent in a channel no project is bound to, and starts no task", async () => {
    // Product decision (pinned by tests/contract/slack-ingress.test.ts "ignores an unbound channel without queueing
    // work"): the ingress ignores an unbound channel before it claims or answers anything.
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    const [binding] = e2e.db.find((item) => String(item.pk).startsWith("SLACK_BINDING#"));
    e2e.db.delete(String(binding!.pk), String(binding!.sk));
    expect(await e2e.mention("quick: Add a greet(name) function", { ts: "1695500600.000001", threadTs: "1695500600.000001" })).toBe(200);
    await e2e.settle();
    expect(tasks(e2e)).toEqual([]);
    expect(e2e.slack.posts).toEqual([]);
    expect(e2e.chatQueue).toEqual([]);
  }, 60_000);

  it("1.15 says, word for word, that the channel isn't connected when it is unbound while the request is on its way", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    const [binding] = e2e.db.find((item) => String(item.pk).startsWith("SLACK_BINDING#"));
    // An admin unbinds the channel after the Slack ingress read the binding and before the broker reads it: the broker's
    // read of the binding is the moment the binding goes (the match removes it and lets the read through).
    e2e.db.injectFault({ command: "GetCommand", error: { name: "Unused" },
      match: (input) => {
        if ((input.Key as { pk?: string } | undefined)?.pk === binding!.pk) e2e.db.delete(String(binding!.pk), String(binding!.sk));
        return false;
      } });
    expect(await e2e.mention("quick: Add a greet(name) function", { ts: "1695500600.000001", threadTs: "1695500600.000001" })).toBe(200);
    await e2e.settle();
    expect(tasks(e2e)).toEqual([]);
    expect(e2e.slack.posts.map((post) => post.text)).toEqual(["This channel isn't connected to an AgentX project you can use. Ask an AgentX admin to check the channel."]);
  }, 60_000);

  it("1.15 says, word for word, that the owner reached their open-task limit, and starts no second task", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    // The admin's workspace limits: one open task per person.
    e2e.db.set({ pk: "SETTINGS", sk: "WORKSPACE_LIMITS", entityType: "SETTING", perPerson: 1, perOrganization: 20, updatedBy: "admin", updatedAt: new Date().toISOString() });
    await atPlanReview(e2e);
    expect(await e2e.mention("quick: Add a farewell(name) function", { ts: "1695500700.000001", threadTs: "1695500700.000001" })).toBe(200);
    await e2e.settle();
    expect(tasks(e2e)).toHaveLength(1);
    expect(e2e.slack.posts.filter((post) => post.threadTs === "1695500700.000001").map((post) => post.text))
      .toEqual(["You've reached your limit of open AgentX tasks. Close one of your open tasks, or merge its pull request, then try again."]);
  }, 120_000);

  it("1.16 starts each path with its own one-line notice", async () => {
    expect(workflowStartedNotice("QUICK")).toBe("Started on Quick. I'll write a short coding plan here first; nothing changes in the code until you approve it.");
    expect(workflowStartedNotice("FULL")).toBe("Started on Full. I'll write the requirements here first; nothing changes in the code until you approve each step.");
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function", { ts: "1695500800.000001", threadTs: "1695500800.000001" })).toBe(200);
    expect(await e2e.mention("full: Rework how greetings are stored", { ts: "1695500900.000001", threadTs: "1695500900.000001" })).toBe(200);
    expect(e2e.slack.posts.filter((post) => post.threadTs === "1695500800.000001").map((post) => post.text)).toEqual([workflowStartedNotice("QUICK")]);
    expect(e2e.slack.posts.filter((post) => post.threadTs === "1695500900.000001").map((post) => post.text)).toEqual([workflowStartedNotice("FULL")]);
  }, 60_000);

  it("1.8 (teammate) cannot request changes or close the task either", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    const before = e2e.workflow().revision;
    await e2e.click("agentx_workflow_changes", { user: TEAMMATE });
    await e2e.click("agentx_workflow_close", { user: TEAMMATE });
    await e2e.settle();
    expect(e2e.slack.views).toEqual([]);
    expect(e2e.slack.responses.map((response) => response.text).every((text) => text.startsWith(`Only <@${OWNER}> can `))).toBe(true);
    expect(e2e.slack.responses).toHaveLength(2);
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision: before });
  }, 120_000);
});
