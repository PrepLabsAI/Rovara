// Suite 4: checks. 4.1 (pass), 4.3 (a broken proposed check) and 4.8 (code changed after checks) are covered by
// slack-workflow-e2e.test.ts. Here: a real failure sent back, a broken project check, project checks in every round, a
// timeout, the check runner failing, and an old broker that sends no checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKFLOW_BLOCK_REASONS, type ProjectCommand } from "@agentx/contracts";
import { E2E_CHECK, createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, LINT, PLAN, SELECT_LINT, actionIds, atPlanReview, expectNoJargon, journeySuite, markInputs, modelInputs, runs, said } from "../../support/workflow-e2e-journeys.js";

const FIXED = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name.trim()}`;\n}\n" }];
const SENT_BACK = "Address the problems below in the code";
const same = (left: ProjectCommand, right: ProjectCommand) => JSON.stringify(left) === JSON.stringify(right);
/** The project check's label as the task's check policy names it. */
const projectLabel = (e2e: WorkflowE2E) => e2e.workflow().checkPolicy!.required[0]!.label;

describe("Suite 4: checks", () => {
  journeySuite();

  it("4.2 a real failure is shown, sent back with the failure, checked again on the new code, and opens the PR", async () => {
    const at: { e2e?: WorkflowE2E } = {};
    // The project check fails on code that greets without trimming the name, and passes on the base and on the fix.
    const checkResult = (command: ProjectCommand) => {
      if (!same(command, E2E_CHECK)) return undefined;
      const code = readFileSync(join(at.e2e!.repoDirectory, "greeting.ts"), "utf8");
      return code.includes("greet(") && !code.includes("trim()") ? { exitCode: 1, stdout: "", stderr: "AssertionError: greet(' Ada ') should be 'Hello, Ada'\n" } : undefined;
    };
    const e2e = at.e2e = await createWorkflowE2E({ checkResult, model: { plan: PLAN, edits: (latest) => (latest.includes(SENT_BACK) ? FIXED : EDITS) } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const failed = e2e.slack.lastPostWithAction("agentx_workflow_send_back");
    expect(failed.text).toBe(`1 of 1 check didn't pass: ${projectLabel(e2e)}. Nothing was sent to GitHub.`);
    expect(actionIds(failed)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
    expect(runs(e2e)).not.toContain("REVIEW");
    expect(e2e.github.pushes.size).toBe(0);
    const firstTree = e2e.workflow().candidate!.repositories[0]!.treeSha;
    const mark = markInputs(e2e);
    await e2e.click("agentx_workflow_send_back");
    if (e2e.slack.views.length > 0) await e2e.submitView({});
    await e2e.settle();
    expect(said(e2e)).toContain("Sent back to coding with 1 failed check. Checks and reviews will run again after.");
    // The coder was told what failed.
    const [fix] = modelInputs(e2e, mark).filter((input) => input.includes(SENT_BACK));
    expect(fix).toContain(projectLabel(e2e));
    const workflow = e2e.workflow();
    expect(workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    const fixedTree = workflow.candidate!.repositories[0]!.treeSha;
    expect(fixedTree).not.toBe(firstTree);
    // The second round's project check ran on the new code, which is what the PR carries.
    expect(e2e.checkRuns.filter((run) => same(run.command, E2E_CHECK)).at(-1)?.tree).toBe(fixedTree);
    expect(e2e.github.pullRequests).toEqual([expect.objectContaining({ tree: fixedTree })]);
    expectNoJargon(e2e);
  }, 120_000);

  it("4.4 a project check that can't run asks a project admin, offers no Send back, and Choose checks can't untick it", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS },
      // The worker's runner could not start the program: its spawn fails as Node reports it.
      checkResult: (command) => { if (same(command, E2E_CHECK)) throw new Error("spawn node ENOENT"); return undefined; } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const card = e2e.slack.posts.at(-1)!;
    expect(card.text).toBe(`${projectLabel(e2e)} is a project check and couldn't run; ask a project admin to fix it, or close the task. node is not installed on the AgentX worker.`);
    expect(actionIds(card)).not.toContain("agentx_workflow_send_back");
    expect(actionIds(card)).toContain("agentx_workflow_close");
    if (actionIds(card).includes("agentx_workflow_retry_checks")) {
      await e2e.click("agentx_workflow_retry_checks");
      // The project's own check is never a choice to untick.
      expect(JSON.stringify(e2e.slack.views.at(-1)?.view ?? {})).not.toContain(`"value":"${e2e.workflow().checkPolicy!.required[0]!.id}"`);
    }
    expect(e2e.github.pushes.size).toBe(0);
    expectNoJargon(e2e);
  }, 120_000);

  it("4.5 runs the project check in every round, also when the owner unticks every optional check on a retry", async () => {
    let lintFails = true;
    const e2e = await createWorkflowE2E({ optionalChecks: [LINT], model: { plan: PLAN, edits: EDITS },
      checkResult: (command) => (lintFails && same(command, LINT.command) ? { exitCode: 1, stdout: "", stderr: "greeting.ts:2 unexpected token\n" } : undefined) });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.submitView(SELECT_LINT);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const firstRound = e2e.checkRuns.length;
    expect(e2e.checkRuns.some((run) => same(run.command, E2E_CHECK))).toBe(true);
    // Choose checks and retry, with no optional check selected: the project check still runs.
    lintFails = false;
    await e2e.click("agentx_workflow_retry_checks");
    await e2e.submitView({ workflow_checks: { selected_options: { selected_options: [] } } });
    await e2e.settle();
    const retried = e2e.checkRuns.slice(firstRound);
    expect(retried.map((run) => run.command)).toEqual([E2E_CHECK]);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("4.6 a check that times out is a real failure, not a broken check, and can be sent back", async () => {
    const at: { e2e?: WorkflowE2E } = {};
    const checkResult = (command: ProjectCommand) => {
      if (!same(command, E2E_CHECK)) return undefined;
      const code = readFileSync(join(at.e2e!.repoDirectory, "greeting.ts"), "utf8");
      return code.includes("greet(") ? { exitCode: null, stdout: "", stderr: "", timedOut: true } : undefined;
    };
    const e2e = at.e2e = await createWorkflowE2E({ checkResult, model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    const card = e2e.slack.lastPostWithAction("agentx_workflow_send_back");
    expect(card.text).toBe(`1 of 1 check didn't pass: ${projectLabel(e2e)}. Nothing was sent to GitHub.`);
    expect(e2e.workflow().verification?.results[0]).not.toHaveProperty("broken");
  }, 120_000);

  it("4.7 a real agent test regression blocks review until the owner sends it back and it is fixed", async () => {
    const e2e = await createWorkflowE2E({ readiness: [],
      initialRepositoryFiles: [{ path: "greeting.test.js", content: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\ntest("greet trims names", () => {\n  const code = readFileSync(new URL("./greeting.ts", import.meta.url), "utf8");\n  if (!code.includes("function greet(")) return;\n  assert.match(code, /name\\.trim\\(\\)/);\n});\n` }],
      model: { plan: PLAN, beforeEditsCommands: ["node --test repo/demo/greeting.test.js"],
        edits: (latest) => latest.includes("These tests passed before this change and fail now.") ? FIXED : EDITS } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.agentCheckRuns.map(({ replay }) => replay)).toEqual(["node --test repo/demo/greeting.test.js", "node --test repo/demo/greeting.test.js"]);
    expect(e2e.agentCheckRuns[0]?.tree).not.toBe(e2e.baseTree);
    expect(e2e.agentCheckRuns[1]?.tree).toBe(e2e.agentCheckRuns[0]?.tree);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.regressionFound });
    expect(e2e.workflow().regressedChecks).toEqual(["node --test repo/demo/greeting.test.js"]);
    const blocked = e2e.slack.lastPostWithAction("agentx_workflow_send_back");
    expect(blocked.text).toBe("This test passed before this change and fails now: node --test repo/demo/greeting.test.js. Send it back to coding, or close the task. Nothing was sent to GitHub.");
    expect(actionIds(blocked)).toEqual(["agentx_workflow_send_back", "agentx_workflow_close"]);
    expect(runs(e2e)).not.toContain("REVIEW");
    expect(e2e.github.pushes.size).toBe(0);
    expect(e2e.github.pullRequests).toEqual([]);
    const mark = markInputs(e2e);
    const blockedTree = e2e.agentCheckRuns.at(-1)!.tree;
    await e2e.click("agentx_workflow_send_back");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(modelInputs(e2e, mark).join("\n")).toContain("These tests passed before this change and fail now.");
    expect(e2e.workflow().candidate!.repositories[0]!.treeSha).not.toBe(blockedTree);
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(e2e.workflow().candidate!.repositories[0]!.treeSha);
    const pullRequestBody = (e2e.github.pullRequests[0]!.body ?? "").split("\n");
    expect(pullRequestBody[0]).toBe("Not verified by automated checks (review only).");
    expect(pullRequestBody.some((line) => line.startsWith("Checks:"))).toBe(false);
  }, 120_000);

  it("4.9 a check the runner couldn't start is not the code failing: no Send back, and Choose checks and retry runs it again", async () => {
    // Found by this scenario: a check whose process never started (its spawn failed, "spawn node EAGAIN") read as "1 of 1
    // check didn't pass" with Send back to coding first, which would recode working code. It is now a check that couldn't run.
    let runnerDown = true;
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS },
      checkResult: () => { if (runnerDown) throw new Error("spawn node EAGAIN"); return undefined; } });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(e2e.workflow().verification?.results).toEqual([{ checkId: "required-1", status: "FAILED", broken: true, neverStarted: true }]);
    const card = e2e.slack.posts.at(-1)!;
    // Nothing is wrong with the check itself: it may start on a retry, so no project admin is needed.
    expect(card.text).toBe(`${projectLabel(e2e)} couldn't start on the AgentX worker this time. Choose checks and retry to run it again, or close the task.`);
    expect(card.text).not.toContain("EAGAIN");
    expect(actionIds(card)).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    expect(runs(e2e)).not.toContain("REVIEW");
    runnerDown = false;
    await e2e.click("agentx_workflow_retry_checks");
    if (e2e.slack.views.length > 0) await e2e.submitView({});
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
  }, 120_000);

  it("4.9 a stopped check round retries checks and reviews without recoding", async () => {
    let budget = 0;
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, checkBudgetMs: () => budget });
    await atPlanReview(e2e);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checkRunnerFailed });
    const implementation = e2e.invocations.find((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "IMPLEMENT")!;
    expect(e2e.db.get(`WORKSPACE#${implementation.workspaceId}`, `OPERATION#${implementation.operationId}`)?.result)
      .toMatchObject({ checks: { status: "not_verified", notVerifiedReason: "stopped" } });
    const blocked = e2e.slack.posts.at(-1)!;
    expect(blocked.text).toBe("The code is written, but I couldn't run the checks. AgentX couldn't run the selected checks. Retry once the check runner is working.");
    expect(actionIds(blocked)).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    expect(runs(e2e)).not.toContain("REVIEW");
    expect(e2e.github.pushes.size).toBe(0);
    await e2e.click("agentx_workflow_retry_checks");
    expect(JSON.stringify(e2e.slack.views.at(-1)?.view ?? {})).not.toContain(`"value":"${e2e.workflow().checkPolicy!.required[0]!.id}"`);
    await e2e.submitView({});
    budget = 30 * 60_000;
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    expect(runs(e2e).filter((run) => run === "REVIEW")).toHaveLength(1);
    expect(e2e.turns.filter((turn) => turn.role === "CODE" || turn.role === "SECURITY").map((turn) => turn.role).sort()).toEqual(["CODE", "SECURITY"]);
    expect(e2e.github.pullRequests).toHaveLength(1);
  }, 120_000);

  it("4.10 says, word for word, that none of the task's checks ran when an old broker sends the coder no checks", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    // Deploy skew: a broker from before readiness was sent leaves it out of the coding run.
    e2e.worker.stripInvocationFields(["readiness"]);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.noChecksConfigured });
    expect(e2e.slack.posts.at(-1)?.text).toBe(`The code is written, but I couldn't run the checks. ${WORKFLOW_BLOCK_REASONS.noChecksConfigured}`);
    expect(e2e.github.pushes.size).toBe(0);
    expectNoJargon(e2e);
  }, 120_000);
});
