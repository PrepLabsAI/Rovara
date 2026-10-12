// Suite 2: Full planning (requirements, design, coding plan) and the plan page's anchors. 2.1, 2.2 and 2.6-2.8 are
// covered by slack-workflow-e2e.test.ts. Here: decisions at every phase, Request changes at every phase, deciding on the
// page (read only today, D5), cited code on the page, closing at plan review, and a tiny plan shown whole in Slack.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@agentx/contracts";
import { MAYA } from "../../support/developer-task-broker.js";
import { CLOSED_REPLY } from "../../../packages/broker/src/developer/share-messages.js";
import { planTiny, planWithDecisions } from "../../support/model-fixtures.js";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { openTaskPage } from "../../support/page-browser.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, PLAN, actionIds, atPlanReview, expectNoJargon, journeySuite, markInputs, modelInputs, runs, said } from "../../support/workflow-e2e-journeys.js";

const OWNER = MAYA.slackUserId!;
const REQUIREMENTS_PROMPT = /You are writing the requirements/;
const DESIGN_PROMPT = /You are writing the design/;
const IMPLEMENT = "Implement the human-approved plan";

/** A Full task's planner: requirements, design and coding plan, each from `docs`. */
function fullPlanner(docs: { requirements: string; design: string; plan: string }) {
  return (latest: string) => (REQUIREMENTS_PROMPT.test(latest) ? docs.requirements : DESIGN_PROMPT.test(latest) ? docs.design : docs.plan);
}

const titled = (title: string, base: string) => base.replace('"title": "Retry failed payments"', `"title": "${title}"`);
/** A small structured document with no decisions and no citations. */
const plain = (title: string, claims: string[]) => planAnswer(planDocument({ title, claims: claims.map((text, index) => ({ id: String(index + 1), text })), decisions: [] }));

describe("Suite 2: Full planning", () => {
  journeySuite();

  it("2.3 answers each Full phase's decisions with AgentX's recommendations from Slack, and the coder gets every phase's answers", async () => {
    // Requirements with 2 decisions, design with 1, coding plan with 0. The fixtures' claims cite nothing.
    const withDecisions = (count: number, title: string) => {
      const document: PlanDocument = planDocument({ title, claims: [{ id: "1", text: `${title}: greet users by name.` }, { id: "2", text: `${title}: keep one function.` }],
        decisions: (JSON.parse(planWithDecisions(count).split("```agentx-plan\n")[1]!.split("\n```")[0]!) as { decisions: PlanDocument["decisions"] }).decisions });
      return planAnswer(document);
    };
    const e2e = await createWorkflowE2E({ canvas: "unavailable", model: { edits: EDITS,
      plan: fullPlanner({ requirements: withDecisions(2, "Requirements"), design: withDecisions(1, "Design"), plan: plain("Coding plan", ["Add greet to greeting.ts.", "Run node --version."]) }) } });
    expect(await e2e.mention("full: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    const phases = [
      { name: "Requirements", decisions: "Approve here uses AgentX's answers for 2 decisions and includes the open comments (up to 25) from the task page." },
      { name: "Design", decisions: "Approve here uses AgentX's answers for 1 decision and includes the open comments (up to 25) from the task page." },
      { name: "Coding plan", decisions: undefined },
    ];
    for (const phase of phases) {
      const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
      expect(card.text).toContain(`*${phase.name} v1 is ready for your approval.*`);
      if (phase.decisions === undefined) expect(card.text).not.toMatch(/\d+ decisions?\b/);
      else expect(card.text.split("\n")).toContain(phase.decisions);
      // No code is written before the coding plan's approval.
      expect(runs(e2e)).not.toContain("IMPLEMENT");
      await e2e.click("agentx_workflow_approve");
      await approveModal(e2e);
      await e2e.settle();
      // The card is edited to say who approved it, and its buttons are gone.
      const decided = e2e.slack.updates.filter((update) => update.ts === card.ts).at(-1);
      expect(actionIds(decided ?? {})).toEqual([]);
      expect(JSON.stringify(decided?.blocks.at(-1))).toContain(`<@${OWNER}>`);
    }
    // Each phase's answers go to the next phase's planner as decided (to be kept as claims), so the coding plan the coder
    // gets carries them: the design is told the requirements' two answers, the coding plan the design's one.
    const designPrompt = modelInputs(e2e).find((input) => DESIGN_PROMPT.test(input))!;
    expect(designPrompt).toContain("The owner approved this document with AgentX's recommended answer to each decision: d1 — Question 1: which way should this go?: The first way; d2 — Question 2: which way should this go?: The first way.");
    const codingPlanPrompt = modelInputs(e2e).find((input) => /You are writing the coding plan/.test(input))!;
    expect(codingPlanPrompt).toContain("The owner approved this document with AgentX's recommended answer to each decision: d1 — Question 1: which way should this go?: The first way.");
    const implement = modelInputs(e2e).filter((input) => input.includes(IMPLEMENT));
    expect(implement).toHaveLength(1);
    expect(implement[0]).toContain("**1** Add greet to greeting.ts.");
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().decisions.map((decision) => decision.decision)).toEqual(["APPROVE", "APPROVE", "APPROVE"]);
    expectNoJargon(e2e);
  }, 120_000);

  it("2.3b stores only planner replies that stay with their approved design comments", async () => {
    const answers = JSON.stringify([
      { comment: "c1", outcome: "done", reason: "Done in the coding plan, as comment c1 asked." },
      { comment: "c2", outcome: "done", reason: "Done in the coding plan, as comments c2 and c1 asked." },
    ]);
    const e2e = await createWorkflowE2E({ canvas: "unavailable", model: { edits: EDITS, plan: (latest) => {
      if (REQUIREMENTS_PROMPT.test(latest)) return plain("Requirements", ["Keep the change small."]);
      if (DESIGN_PROMPT.test(latest)) return plain("Design", ["Keep the greeting clear."]);
      return plain("Coding plan", ["Add greet to greeting.ts.", "Run node --version."]) + "\n\n```agentx-comment-answers\n" + answers + "\n```";
    } } });
    expect(await e2e.mention("full: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await approveModal(e2e);
    await e2e.settle();

    const design = await openTaskPage(e2e, MAYA, { search: "?doc=design" });
    expect(design.status).toBe(200);
    for (const text of ["Keep the greeting warm.", "Use a short response."]) {
      const open = design.document.querySelector('#design .comment-open[data-target="document"]');
      expect(open).not.toBeNull();
      open!.click();
      const form = design.document.querySelector('#design [data-comments="document"] .comment-form');
      expect(form).not.toBeNull();
      form!.querySelector("textarea")!.type_(text);
      design.button(form!, "Post").click();
      await design.settle();
    }
    expect(runs(e2e)).not.toContain("IMPLEMENT");
    await e2e.click("agentx_workflow_approve");
    await approveModal(e2e);
    await e2e.settle();

    const replies = e2e.db.find((item) => item.pk === `DEVTASK#${e2e.taskId()}` && item.entityType === "TASK_COMMENT" && (item.author as { kind: string }).kind === "agentx");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ text: "Done in the coding plan, as that comment asked.", author: { kind: "agentx", source: "planner" } });
    const designPage = await openTaskPage(e2e, MAYA, { search: "?doc=design" });
    const renderedReplies = designPage.document.querySelectorAll('#design [data-comments="document"] .replies li');
    expect(renderedReplies).toHaveLength(1);
    expect(renderedReplies[0]!.textContent).toContain("Done in the coding plan, as that comment asked.");
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    expect(card.text).toContain("AgentX replied to 1 of 2 comments on the design.");
    expect(card.text).not.toContain("AgentX replied to 2 of 2 comments on the design.");
    expect(runs(e2e)).not.toContain("IMPLEMENT");
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expectNoJargon(e2e);
  }, 120_000);

  it("2.4 the task page refuses a decision posted to it: read only, and nothing changes", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    const before = e2e.workflow().revision;
    const response = await e2e.handler({
      version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${e2e.taskId()}/task`, rawQueryString: "", isBase64Encoded: false,
      headers: { "content-type": "application/json", origin: "https://agentx.example.test" }, body: JSON.stringify({ decision: "APPROVE" }),
      requestContext: { requestId: randomUUID(), http: { method: "POST" } },
    }) as { statusCode: number; body: string; headers?: Record<string, string> };
    expect(response.statusCode).toBe(405);
    expect(response.body).toContain("This page is read only.");
    expect(response.headers?.allow).toBe("GET");
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", revision: before, decisions: [] });
  }, 60_000);

  // D5 (deciding on the page, spec 061 slice 2): Approve on the page with one changed answer and two comments edits the
  // Slack card to "Approved by <owner> · 1 answer changed · 2 comments included", and the coder's Markdown shows
  // "Owner chose: Above (AgentX recommended: Below)". The page is read only until D5 is decided.
  // 2.4 (D5) deciding on the page is built (spec 061 slice 2): one changed answer and two comments reaching the Slack card
  // and the coder are covered by plan-review-slice-2-e2e.test.ts, and the page racing Slack by suite 10.

  for (const phase of [
    { path: "full", name: "requirements", stage: 0 },
    { path: "full", name: "design", stage: 1 },
    { path: "full", name: "coding plan", stage: 2 },
  ] as const) {
    it(`2.5 Request changes on the ${phase.name}: a plain note, the old card retired, a v2 card, and the note reaches the planner marked untrusted`, async () => {
      const NOTE = `Please change the ${phase.name}: greet in English only.`;
      let revised = false;
      const e2e = await createWorkflowE2E({ canvas: "unavailable", model: { edits: EDITS, plan: (latest) => {
        if (latest.includes(NOTE)) revised = true;
        const title = REQUIREMENTS_PROMPT.test(latest) ? "Requirements" : DESIGN_PROMPT.test(latest) ? "Design" : "Coding plan";
        return plain(title, [`${title}: greet users by name${revised ? " in English" : ""}.`, `${title}: keep one function.`]);
      } } });
      expect(await e2e.mention("full: Add a greet(name) function")).toBe(200);
      await e2e.settle();
      for (let step = 0; step < phase.stage; step += 1) {
        await e2e.click("agentx_workflow_approve");
        await approveModal(e2e);
        await e2e.settle();
      }
      const v1 = e2e.slack.lastPostWithAction("agentx_workflow_changes");
      await e2e.click("agentx_workflow_changes");
      // An empty note is refused by the form.
      await expect(e2e.submitView({ workflow_feedback: { reason: { value: "  " } } })).rejects.toThrow("the modal refused the submission");
      const mark = markInputs(e2e);
      await e2e.submitView({ workflow_feedback: { reason: { value: NOTE } } });
      await e2e.settle();
      expect(said(e2e)).toContain(`Got it. Revising the ${phase.name} with your changes.`);
      expect(actionIds(e2e.slack.updates.filter((update) => update.ts === v1.ts).at(-1) ?? {})).toEqual([]);
      const capitalized = `${phase.name.charAt(0).toUpperCase()}${phase.name.slice(1)}`;
      expect(e2e.slack.lastPostWithAction("agentx_workflow_approve").text).toContain(`*${capitalized} v2 is ready for your approval.*`);
      const [planner] = modelInputs(e2e, mark).filter((input) => input.includes(NOTE));
      expect(planner).toBeDefined();
      expect(runs(e2e)).not.toContain("IMPLEMENT");
      expect(e2e.workflow()).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
      expectNoJargon(e2e);
    }, 120_000);
  }

  it("2.9a shows a cited file GitHub does not have at the task's base as not found there, and Slack approval still works", async () => {
    const plan = planAnswer(planDocument({ title: "Add greet(name)", decisions: [],
      claims: [{ id: "1", text: "Add greet next to farewell.", evidence: [{ kind: "code", path: "repo/demo/farewell.ts", startLine: 1, endLine: 1, note: "The farewell is here." }] },
        { id: "2", text: "Run node --version." }] }));
    const e2e = await createWorkflowE2E({ model: { plan, edits: EDITS } });
    await atPlanReview(e2e);
    // GitHub holds no farewell.ts at the base commit (the fake's files are empty): the background job finds it missing.
    expect(await e2e.runPlanEvidenceJobs()).toEqual(["attached"]);
    const page = await e2e.taskPage("?doc=coding-plan&from=1");
    expect(page.status).toBe(200);
    expect(page.body).toContain(`Not found at ${e2e.baseCommit.slice(0, 7)}`);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("2.9b says an excerpt couldn't be loaded when GitHub fails, never shows the model's copy, and Slack approval still works", async () => {
    const plan = planAnswer(planDocument({ title: "Add greet(name)", decisions: [],
      claims: [{ id: "1", text: "Add greet to greeting.ts.", evidence: [{ kind: "code", path: "repo/demo/greeting.ts", startLine: 1, endLine: 3, note: "Today the file only holds constants." }] },
        { id: "2", text: "Run node --version." }] }));
    const e2e = await createWorkflowE2E({ model: { plan, edits: EDITS } });
    e2e.github.files.set("greeting.ts", "export const fromGitHub = 1;\nexport const second = 2;\nexport const third = 3;\n");
    await atPlanReview(e2e);
    e2e.github.failNext("getFileAtCommit", 500, 5);
    expect(await e2e.runPlanEvidenceJobs()).toEqual(["retry"]);
    // While the background job retries, the page says the code is still loading; once that window has passed, that it
    // couldn't be loaded.
    expect((await e2e.taskPage("?doc=coding-plan&from=1")).body).toContain("Loading code… refresh in a moment.");
    e2e.clock.advance(16 * 60_000);
    const page = await e2e.taskPage("?doc=coding-plan&from=1");
    expect(page.body).toContain("Couldn't load this excerpt.");
    // The code on the page only ever comes from GitHub; the workspace's text is never shown in its place.
    expect(page.body).not.toContain("export const placeholder = true;");
    expect(page.body).not.toContain("fromGitHub");
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("2.9c opened from the v1 card after v2 exists: the page says so and shows what changed", async () => {
    const NOTE = "Call the function hello.";
    const e2e = await createWorkflowE2E({ model: { edits: EDITS,
      plan: (latest) => (latest.includes(NOTE) ? plain("Add hello(name)", ["Add hello to greeting.ts.", "Run node --version."]) : plain("Add greet(name)", ["Add greet to greeting.ts.", "Run node --version."])) } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_changes");
    await e2e.submitView({ workflow_feedback: { reason: { value: NOTE } } });
    await e2e.settle();
    const page = await e2e.taskPage("?doc=coding-plan&from=1");
    expect(page.status).toBe(200);
    expect(page.body).toContain("You opened this from v1. Here's what changed since v1.");
    expect(page.body).toMatch(/<details class="changes" open><summary>What changed since v1<\/summary>/);
    expect(page.body).toContain("Add hello to greeting.ts.");
    // Opened from the current card, the page says nothing about an older one.
    expect((await e2e.taskPage("?doc=coding-plan&from=2")).body).not.toContain("You opened this from");
  }, 120_000);

  it("2.10 closes a task at plan review after the owner confirms: no push, no pull request, and the thread says it is closed", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_close");
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ type: "modal" });
    await e2e.submitView({});
    expect(e2e.slack.responses.at(-1)?.text).toBe("Closing this task. Its workspace is being released; I'll post here when it's closed, usually within two minutes.");
    await e2e.settle();
    // A task closed from Slack says so in the share's own words (the workflow's "Closed without changes." would say it twice).
    expect(said(e2e).at(-1)).toBe(CLOSED_REPLY);
    expect(said(e2e).filter((text) => text === CLOSED_REPLY)).toHaveLength(1);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")?.closedAt).toBeDefined();
    expect(e2e.github.pushes.size).toBe(0);
    expect(e2e.github.pullRequests).toEqual([]);
    expect(e2e.github.minted.filter((entry) => entry.access === "push")).toEqual([]);
    expect(runs(e2e)).not.toContain("IMPLEMENT");
  }, 120_000);

  it("2.11 shows a tiny plan whole in Slack, and Approve works with no page visit", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: titled("Greeting punctuation", planTiny()), edits: EDITS } });
    await atPlanReview(e2e);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    for (const claim of ["The greeting ends with an exclamation mark.", "The farewell stays as it is.", "Nothing else changes."]) expect(card.text).toContain(claim);
    expect(card.text).not.toMatch(/And \d+ more claims?\./);
    expect(card.text).not.toMatch(/\d+ decisions?\b/);
    await e2e.click("agentx_workflow_approve");
    expect(e2e.slack.views).toEqual([]);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);
});

/** Submits the approval modal when the press opened one (a Full phase may; Quick with no optional checks does not). */
async function approveModal(e2e: WorkflowE2E): Promise<void> {
  const opened = e2e.slack.views.at(-1) as (typeof e2e.slack.views)[number] & { consumed?: boolean } | undefined;
  if (opened === undefined || opened.consumed === true) return;
  opened.consumed = true;
  await e2e.submitView({});
}
