// Suite 3: the Quick path. 3.1-3.3 are covered by slack-workflow-e2e.test.ts (the happy path, a proposed check, review
// only). Here: a revised coding plan, optional checks chosen at approval, a coding run that fails, and one that
// changes nothing.
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS } from "@agentx/contracts";
import { planAnswer, planDocument } from "../../support/plan-documents.js";
import { E2E_CHECK, createWorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, LINT, PLAN, SELECT_LINT, actionIds, atPlanReview, expectNoJargon, journeySuite, markInputs, modelInputs, runs, said } from "../../support/workflow-e2e-journeys.js";

const IMPLEMENT = "Implement the human-approved plan";
const NOTE = "Call the function hello, not greet.";
const V2 = planAnswer(planDocument({ title: "Add hello(name)", why: [{ text: "Users should be greeted by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add hello to greeting.ts." }, { id: "2", text: "Run node --version." }], decisions: [] }));

describe("Suite 3: Quick path", () => {
  journeySuite();

  it("3.4 revises the coding plan on Request changes, and the coder gets v2, never v1", async () => {
    const e2e = await createWorkflowE2E({ model: { edits: EDITS, plan: (latest) => (latest.includes(NOTE) ? V2 : PLAN) } });
    await atPlanReview(e2e);
    const v1 = e2e.slack.lastPostWithAction("agentx_workflow_changes");
    await e2e.click("agentx_workflow_changes");
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ title: { text: "Request changes" } });
    // An empty note is refused in the form.
    await expect(e2e.submitView({ workflow_feedback: { reason: { value: "   " } } })).rejects.toThrow("the modal refused the submission");
    const mark = markInputs(e2e);
    await e2e.submitView({ workflow_feedback: { reason: { value: NOTE } } });
    await e2e.settle();
    expect(said(e2e)).toContain("Got it. Revising the coding plan with your changes.");
    // The planner got the note; the v1 card lost its buttons; a v2 card asks again.
    expect(modelInputs(e2e, mark).some((input) => input.includes(NOTE))).toBe(true);
    const retired = e2e.slack.updates.filter((update) => update.ts === v1.ts).at(-1);
    expect(actionIds(retired ?? {})).toEqual([]);
    const v2 = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    expect(v2.text).toContain("*Coding plan v2 is ready for your approval.*");
    expect(v2.text).toContain("Add hello to greeting.ts.");
    expect(runs(e2e)).not.toContain("IMPLEMENT");
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    const implement = modelInputs(e2e).filter((input) => input.includes(IMPLEMENT));
    expect(implement).toHaveLength(1);
    expect(implement[0]).toContain("Add hello to greeting.ts.");
    expect(implement[0]).not.toContain("Add greet to greeting.ts.");
    const workflow = e2e.workflow();
    expect(workflow.decisions.map((decision) => decision.decision)).toEqual(["REQUEST_CHANGES", "APPROVE"]);
    expect(workflow.decisions.at(-1)?.artifactDigest).toBe(workflow.artifacts.filter((artifact) => artifact.type === "plan").at(-1)?.sha256);
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expectNoJargon(e2e);
  }, 120_000);

  it("3.5 runs the project check, then the optional check the owner selected, and the PR lists both as passed", async () => {
    const e2e = await createWorkflowE2E({ optionalChecks: [LINT], model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ title: { text: "Approve coding plan" } });
    await e2e.submitView(SELECT_LINT);
    await e2e.settle();
    expect(e2e.checkRuns.map((run) => run.command)).toEqual([E2E_CHECK, LINT.command]);
    const workflow = e2e.workflow();
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const projectLabel = workflow.checkPolicy?.required[0]?.label;
    expect(projectLabel).toBeDefined();
    const body = e2e.github.pullRequests[0]?.body ?? "";
    expect(body.split("\n")).toContain(`Checks: ${projectLabel} passed, ${LINT.label} passed`);
    expect(said(e2e)).toContain(`Coding plan approved by @${"U0MAYA001"}. Writing the code now; then I'll run 2 checks.`);
  }, 120_000);

  it("3.6 says coding stopped when the model fails mid-run, and Retry coding goes on to the draft PR", async () => {
    // The model provider fails every call of the first coding run (the worker's own retries included).
    let failing = true;
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: () => {
      if (failing) throw new Error("upstream model overloaded (529)");
      return EDITS;
    } } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    const stopped = e2e.slack.lastPostWithAction("agentx_workflow_retry_implementation");
    expect(stopped.text).toMatch(/^Coding stopped before it finished\. /);
    expect(stopped.text).not.toContain("529");
    expect(actionIds(stopped)).toEqual(["agentx_workflow_retry_implementation", "agentx_workflow_close"]);
    expect(e2e.github.pushes.size).toBe(0);
    // Only the owner may retry.
    await e2e.click("agentx_workflow_retry_implementation", { user: "U0TEAMMATE1" });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    failing = false;
    await e2e.click("agentx_workflow_retry_implementation");
    await e2e.settle();
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(2);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.github.pullRequests).toHaveLength(1);
    expectNoJargon(e2e);
  }, 120_000);

  it("3.7 stops at coding when the coding run changes nothing, says so, and nothing is checked or published", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: (latest) => (latest.includes("Retry") ? EDITS : []) } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    // Found by this scenario: the empty change was checked and reviewed, then the publish refusal read "GitHub didn't
    // accept it" with a Retry opening that could never succeed. Now coding stops, in plain words, with Retry coding.
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.noCodeChanged });
    const stopped = e2e.slack.lastPostWithAction("agentx_workflow_retry_implementation");
    expect(stopped.text).toBe("Coding finished, but no code changed, so there is nothing to check or open as a pull request. Retry coding, or close the task.");
    expect(actionIds(stopped)).toEqual(["agentx_workflow_retry_implementation", "agentx_workflow_close"]);
    // (The coding run ran the project check on its own workspace, as every coding run does; nothing went on to review.)
    expect(runs(e2e)).not.toContain("REVIEW");
    expect(runs(e2e)).not.toContain("publish");
    expect(e2e.github.pushes.size).toBe(0);
    expect(e2e.github.minted.filter((entry) => entry.access === "push")).toEqual([]);
    expect((await e2e.taskPage()).body).toContain("Coding finished, but no code changed");
    expectNoJargon(e2e);
  }, 120_000);
});
