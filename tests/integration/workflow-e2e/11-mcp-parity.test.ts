// Suite 11: MCP parity. An AI tool is an equal path: the same broker transitions, owner checks and thread messages as the
// Slack buttons. 11.3 (an MCP-started task's Slack press) is covered by developer-task-workflow-flow.test.ts. Here: an
// MCP-started Quick task to its draft PR, a Slack-started task decided through MCP, each recovery tool against its Slack
// button, PR feedback decided through MCP [R4, decision D4], and agentx_get_task's next step at every stage.
import { describe, expect, it } from "vitest";
import { SLACK_OIDC_ISSUER, openReviewFindings, type TaskPeopleDisplayReadRequest, type TaskPersonProofRequest } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../../packages/broker/src/aws/admin-actions.js";
import type { CheckTaskPerson } from "../../../packages/broker/src/developer/task-people.js";
import { taskOwnerKey } from "../../../packages/broker/src/developer/task-records.js";
import { reviewerFindings, reviewerHangs } from "../../support/model-fixtures.js";
import { feedbackCriticReply } from "../../support/faux-scripts.js";
import { OMAR } from "../../support/developer-task-broker.js";
import { visibleSlackText } from "../../support/strict-slack.js";
import { SLACK_MAYA, createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { EDITS, MERGED, PLAN, PUSHED_FIX, actionIds, atPlanReview, editsOrFix, journeySuite, openDraftPr, runs, said } from "../../support/workflow-e2e-journeys.js";

const WAITING_FOR_MERGE = "Waiting for the pull request to be merged. Review and merge it on GitHub; the task finishes when it's merged.";
const FEEDBACK_READY = (revision: number) => `PR feedback is ready for your decision. Read it with agentx_get_pr_feedback, then approve, request changes or dismiss it with agentx_decide_pr_feedback and expected_revision ${revision}. Nothing changes in the code until you approve.`;
const SAVED_NOTE = "Got it. I saved your note for the next round of PR feedback; the pull request stays as it is.";
const FIX_APPROVED = "PR feedback approved. Updating the code now; the checks and reviews run again after.";
const BAILEY = { slackUserId: "U0BAILEY01", name: "Bailey Stone" };
const SLACK_BAILEY = { ...BAILEY, developerId: developerIdForSlackUser(BAILEY.slackUserId), provider: "slack" as const, sessionId: "s-bailey-slack" };
const SECOND_CHANNEL = "C0PEOPLE01";

function taskPeopleDirectory(baileyInTaskChannel = true) {
  const members = new Map<string, Set<string>>([
    [SLACK_MAYA.slackUserId!, new Set(["C0123456789"])],
    [BAILEY.slackUserId, new Set([...(baileyInTaskChannel ? ["C0123456789"] : []), SECOND_CHANNEL])],
  ]);
  const names = new Map([[SLACK_MAYA.slackUserId!, SLACK_MAYA.name], [BAILEY.slackUserId, BAILEY.name]]);
  const proof = async (request: TaskPersonProofRequest) => {
    const name = names.get(request.slackUserId);
    if (name === undefined) return { ok: false as const, error: "ineligible" as const };
    return { ok: true as const, user: { id: request.slackUserId, teamId: "T0BSHLLUGBD", name },
      memberOf: [...(members.get(request.slackUserId) ?? [])].filter((channel) => request.channelIds.includes(channel)) };
  };
  const display = async (request: TaskPeopleDisplayReadRequest) => request.operation === "proof"
    ? { operation: "proof" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: await proof(request.request) }
    : { operation: "directory" as const, admission: { version: 1 as const, slackCallsUsed: 1 }, result: { ok: true as const,
      users: [...names].map(([id, name]) => ({ id, teamId: "T0BSHLLUGBD", name,
        memberOf: [...(members.get(id) ?? [])].filter((channel) => request.request.channelIds.includes(channel)) })) } };
  const check: CheckTaskPerson = async (task, developerId) => {
    const found = [...names].find(([slackUserId]) => developerIdForSlackUser(slackUserId) === developerId);
    if (found === undefined) throw new Error("fresh task person proof is unavailable");
    const [slackUserId, name] = found;
    return {
      subject: { developerId, slackUserId },
      identity: { developerId, slackUserId, name, method: "slack", issuer: SLACK_OIDC_ISSUER, subject: slackUserId },
      eligible: true,
      channelMember: task.share === undefined || members.get(slackUserId)?.has(task.share.channelId) === true,
    };
  };
  return { members, proof, display, check };
}

/** The MCP answer's text, which an AI tool reads; fails the test on a tool error. */
async function tool(e2e: WorkflowE2E, name: string, args: Record<string, unknown>, who?: Parameters<WorkflowE2E["mcp"]>[2]) {
  const answer = await e2e.mcp(name, args, who);
  if (answer.isError) throw new Error(`${name} failed: ${JSON.stringify(answer.error)}`);
  return answer;
}

const workflowOf = (answer: { value: Record<string, unknown> }) => answer.value.workflow as { stage: string; state: string; revision: number; candidate_digest?: string;
  approval_document?: { sha256: string }; feedback_review?: { status: string; review_digest?: string; review_complete?: boolean } };

/** A card's buttons are gone once it is answered or out of date. */
function retired(e2e: WorkflowE2E, ts: string): boolean {
  const edits = e2e.slack.updates.filter((update) => update.ts === ts);
  return edits.length > 0 && edits.at(-1)!.blocks?.some((block) => (block as { type: string }).type === "actions") === false;
}

/** A PR feedback journey: a draft PR, a comment and the review's proposal card. */
async function feedbackProposed(feedback?: (prompt: string) => string | typeof reviewerHangs, options: Parameters<typeof createWorkflowE2E>[0] = {}) {
  const e2e = await createWorkflowE2E({ ...options, model: { plan: PLAN, edits: editsOrFix,
    feedback: feedback ?? ((prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" })) } });
  const pullRequest = await openDraftPr(e2e);
  const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
  expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
  await e2e.settle();
  // The proposal's card (none when the review couldn't finish).
  return { e2e, pullRequest, card: e2e.slack.posts.filter((post) => actionIds(post).includes("agentx_feedback_review_recommended")).at(-1)! };
}

/** What the thread said after `from` posts, as the owner reads it. */
const saidSince = (e2e: WorkflowE2E, from: number) => said(e2e).slice(from);

describe("Suite 11: MCP parity", () => {
  journeySuite();

  it("11.1 an MCP-started Quick task: the owner approves the exact plan through MCP, and the reviewed code opens one draft PR", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    const started = await tool(e2e, "agentx_start_workflow", { project: "payments", instructions: "Add a greet(name) function", workflow_path: "quick" });
    expect(workflowOf(started)).toMatchObject({ stage: "PLAN", state: "RUNNING" });
    await e2e.settle();
    const waited = await tool(e2e, "agentx_wait_for_task", { task_id: e2e.taskId(), wait_seconds: 5 });
    const plan = workflowOf(waited);
    expect(plan).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    // A wrong digest is refused, and nothing moves.
    const wrong = await e2e.mcp("agentx_decide_workflow", { task_id: e2e.taskId(), request_id: "7b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a41", expected_revision: plan.revision,
      decision: "APPROVE", reason: "Looks right.", artifact_digest: "0".repeat(64) });
    expect(wrong.isError).toBe(true);
    expect(e2e.workflow().revision).toBe(plan.revision);
    await tool(e2e, "agentx_decide_workflow", { task_id: e2e.taskId(), request_id: "7b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a42", expected_revision: plan.revision,
      decision: "APPROVE", reason: "Looks right.", artifact_digest: plan.approval_document!.sha256 });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE")).toEqual([expect.objectContaining({ actorRole: "TASK_OWNER" })]);
    expect(e2e.github.pullRequests).toHaveLength(1);
    expect(e2e.github.pullRequests[0]!.tree).toBe(e2e.workflow().candidate!.repositories[0]!.treeSha);
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
    const after = await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    expect(workflowOf(after)).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(after.text).toContain(WAITING_FOR_MERGE);
    expect(after.text).not.toContain("agentx_open_pull_request");
  }, 120_000);

  it("11.2 a Slack-started task approved through MCP: the Slack card is retired, the thread says so, and the old card's press is refused", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    await atPlanReview(e2e);
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    const plan = workflowOf(await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() }));
    await tool(e2e, "agentx_decide_workflow", { task_id: e2e.taskId(), request_id: "8b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a43", expected_revision: plan.revision,
      decision: "APPROVE", reason: "Looks right.", artifact_digest: plan.approval_document!.sha256 });
    await e2e.deliverNotices();
    expect(retired(e2e, card.ts)).toBe(true);
    // The same words as the owner's own press in Slack.
    expect(said(e2e).at(-1)).toBe("Coding plan approved by @U0MAYA001. Writing the code now; then I'll run 1 check.");
    const revision = e2e.workflow().revision;
    await e2e.click("agentx_workflow_approve", { messageTs: card.ts });
    // Refused privately in plain words (the exact stale-button copy is suite 2's and suite 8's), and nothing moves.
    expect([...e2e.slack.responses.map((response) => response.text), ...e2e.slack.ephemerals.map((message) => message.text)].at(-1)).toMatch(/Use the latest (AgentX )?message/);
    expect(e2e.workflow().revision).toBe(revision);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(runs(e2e).filter((run) => run === "IMPLEMENT")).toHaveLength(1);
  }, 120_000);

  let checksFail = false;
  // 11.4: each recovery tool against its Slack button, from the same blocked state: the same state change and thread messages.
  const recoveries: Array<{
    name: string;
    options: () => Parameters<typeof createWorkflowE2E>[0];
    /** Takes the journey to the blocked state. */
    reach: (e2e: WorkflowE2E) => Promise<void>;
    slack: (e2e: WorkflowE2E) => Promise<void>;
    mcp: (e2e: WorkflowE2E) => Promise<void>;
  }> = [
    { name: "agentx_retry_workflow (planning) and Retry planning",
      options: () => ({ model: { plan: PLAN, edits: EDITS } }),
      reach: async (e2e) => { e2e.worker.failNext("task:PLAN", "timeout:1800000"); expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200); await e2e.settle(); },
      slack: (e2e) => e2e.click("agentx_workflow_retry_plan"),
      mcp: async (e2e) => { await tool(e2e, "agentx_retry_workflow", { task_id: e2e.taskId(), instructions: "Plan the request again." }); } },
    { name: "agentx_retry_workflow (coding) and Retry coding",
      options: () => ({ model: { plan: PLAN, edits: EDITS } }),
      reach: async (e2e) => { await atPlanReview(e2e); e2e.worker.failNext("task:IMPLEMENT", "timeout:1800000"); await e2e.click("agentx_workflow_approve"); await e2e.settle(); },
      slack: (e2e) => e2e.click("agentx_workflow_retry_implementation"),
      mcp: async (e2e) => { await tool(e2e, "agentx_retry_workflow", { task_id: e2e.taskId(), instructions: "Retry the coding step." }); } },
    { name: "agentx_send_workflow_back and Send back to coding",
      // The check fails until the change is sent back.
      options: () => ({ model: { plan: PLAN, edits: EDITS }, checkResult: () => (checksFail ? { exitCode: 1, stdout: "", stderr: "1 failing" } : undefined) }),
      reach: async (e2e) => { checksFail = true; await atPlanReview(e2e); await e2e.click("agentx_workflow_approve"); await e2e.settle(); checksFail = false; },
      slack: async (e2e) => { await e2e.click("agentx_workflow_send_back"); if (e2e.slack.views.length > 0) await e2e.submitView({}); },
      mcp: async (e2e) => { await tool(e2e, "agentx_send_workflow_back", { task_id: e2e.taskId(), expected_revision: e2e.workflow().revision, instructions: "Fix the problems listed above, then report what changed." }); } },
    { name: "agentx_resolve_review_findings and Resolve findings",
      options: () => ({ model: { plan: PLAN, edits: EDITS, reviews: reviewerFindings(1, { role: "CODE" }) } }),
      reach: async (e2e) => { await atPlanReview(e2e); await e2e.click("agentx_workflow_approve"); await e2e.settle(); },
      slack: async (e2e) => {
        await e2e.click("agentx_workflow_resolve_findings");
        const form = e2e.slack.views.at(-1)!.view as { blocks: Array<{ type: string; block_id?: string }> };
        const [action, note] = form.blocks.filter((block) => block.type === "input").map((block) => block.block_id!);
        await e2e.submitView({ [action!]: { action: { selected_option: { value: "ACCEPT" } } }, [note!]: { note: { value: "Names are trimmed upstream." } } });
      },
      mcp: async (e2e) => {
        const workflow = e2e.workflow();
        await tool(e2e, "agentx_resolve_review_findings", { task_id: e2e.taskId(), expected_revision: workflow.revision, candidate_digest: workflow.candidate!.digest,
          resolutions: openReviewFindings(workflow).map((finding) => ({ finding_id: finding.findingId, action: "accept", note: "Names are trimmed upstream." })) });
      } },
    { name: "agentx_retry_workflow_publish and Retry opening the pull request",
      options: () => ({ model: { plan: PLAN, edits: EDITS } }),
      reach: async (e2e) => { e2e.github.failNext("push", 403); await atPlanReview(e2e); await e2e.click("agentx_workflow_approve"); await e2e.settle(); },
      slack: (e2e) => e2e.click("agentx_workflow_retry_publish"),
      mcp: async (e2e) => { await tool(e2e, "agentx_retry_workflow_publish", { task_id: e2e.taskId(), expected_revision: e2e.workflow().revision }); } },
    { name: "agentx_close_task and Close task",
      options: () => ({ model: { plan: PLAN, edits: EDITS } }),
      reach: async (e2e) => { await openDraftPr(e2e); },
      slack: async (e2e) => { await e2e.click("agentx_workflow_close"); await e2e.submitView({}); },
      mcp: async (e2e) => { await tool(e2e, "agentx_close_task", { task_id: e2e.taskId() }); } },
  ];
  for (const recovery of recoveries) {
    it(`11.4 ${recovery.name}: the same state change and thread messages`, async () => {
      const outcomes: Array<{ stage: string; state: string; said: string[]; prs: number; implement: number }> = [];
      for (const path of ["slack", "mcp"] as const) {
        const e2e = await createWorkflowE2E(recovery.options());
        await recovery.reach(e2e);
        const from = said(e2e).length;
        await recovery[path](e2e);
        await e2e.settle();
        const workflow = e2e.workflow();
        outcomes.push({ stage: workflow.stage, state: workflow.state, said: saidSince(e2e, from), prs: e2e.github.pullRequests.length,
          implement: runs(e2e).filter((run) => run === "IMPLEMENT").length });
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      expect(outcomes[0]!.said.length).toBeGreaterThan(0);
    }, 120_000);
  }

  it("11.5 [R4] PR feedback approved through MCP: the Slack card is retired, the thread says what a press says, and the fix is pushed", async () => {
    const { e2e, pullRequest, card } = await feedbackProposed();
    const task = await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    expect(task.text).toContain(FEEDBACK_READY(workflowOf(task).revision));
    expect(workflowOf(task).feedback_review).toMatchObject({ status: "PENDING", review_complete: true });
    const proposal = await tool(e2e, "agentx_get_pr_feedback", { task_id: e2e.taskId() });
    expect(proposal.value).toMatchObject({ status: "PENDING", review_complete: true, recommended_finding_ids: [expect.any(String)],
      findings: [expect.objectContaining({ recommended: true, kind: "fix", comments: [expect.objectContaining({ author: "octocat", text: "Please trim the name." })] })] });
    const { revision, review_digest, proposal_digest, bundle_digests } = proposal.value as { revision: number; review_digest: string; proposal_digest: string; bundle_digests: string[] };
    // Someone else's AI tool sees no such task, and a stale revision is refused; nothing moves.
    const other = await e2e.mcp("agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "APPROVE", expected_revision: revision, review_digest, proposal_digest, bundle_digests }, OMAR);
    expect(other.isError).toBe(true);
    expect(other.error?.code).toBe("TASK_NOT_FOUND");
    const stale = await e2e.mcp("agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "APPROVE", expected_revision: revision - 1, review_digest, proposal_digest, bundle_digests });
    expect(stale.isError).toBe(true);
    expect(e2e.workflow().revision).toBe(revision);
    expect(e2e.workflow().feedbackDecisions).toBeUndefined();
    const from = said(e2e).length;
    await tool(e2e, "agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "APPROVE", expected_revision: revision, review_digest, proposal_digest, bundle_digests });
    await e2e.settle();
    expect(retired(e2e, card.ts)).toBe(true);
    expect(e2e.workflow().feedbackDecisions).toEqual([expect.objectContaining({ decision: "APPROVE", actorRole: "TASK_OWNER" })]);
    expect(saidSince(e2e, from)[0]).toBe(FIX_APPROVED);
    expect(said(e2e).at(-1)).toBe(PUSHED_FIX(pullRequest.number));
    expect(e2e.github.parents.get(pullRequest.commit)).toHaveLength(1);
    // The old card's press changes nothing and pushes nothing more.
    const decided = e2e.workflow().revision;
    await e2e.click("agentx_feedback_review_recommended", { messageTs: card.ts });
    await e2e.settle();
    expect(e2e.workflow().revision).toBe(decided);
    expect(e2e.workflow().feedbackDecisions).toHaveLength(1);
    expect(e2e.github.pushLog.filter((push) => push.during === "maintain")).toHaveLength(1);
  }, 120_000);

  it("11.5 [R4] Request changes through MCP keeps the PR as it is and saves the note, as the Slack form does", async () => {
    const { e2e, pullRequest } = await feedbackProposed();
    const head = pullRequest.commit;
    const proposal = await tool(e2e, "agentx_get_pr_feedback", { task_id: e2e.taskId() });
    const { revision, review_digest, proposal_digest, bundle_digests } = proposal.value as { revision: number; review_digest: string; proposal_digest: string; bundle_digests: string[] };
    const missing = await e2e.mcp("agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "REQUEST_CHANGES", expected_revision: revision, review_digest, proposal_digest, bundle_digests });
    expect(missing.isError).toBe(true);
    await tool(e2e, "agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "REQUEST_CHANGES", expected_revision: revision, review_digest, proposal_digest, bundle_digests,
      note: "Keep greet's signature; only trim inside it." });
    await e2e.settle();
    expect(said(e2e).at(-1)).toBe(SAVED_NOTE);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(e2e.workflow().feedbackDecisions?.at(-1)).toMatchObject({ decision: "REQUEST_CHANGES", ownerNote: "Keep greet's signature; only trim inside it." });
    expect(pullRequest.commit).toBe(head);
    const after = await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    expect(after.text).toContain(WAITING_FOR_MERGE);
  }, 120_000);

  it("11.5 [R4] a PR feedback review that couldn't finish is retried through MCP, as Retry review does", async () => {
    let calls = 0;
    const { e2e } = await feedbackProposed((prompt) => (++calls === 1 ? reviewerHangs : feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" })),
      { workerTimeouts: { feedbackReviewMs: 200 } });
    const failed = e2e.slack.lastPostWithAction("agentx_feedback_review_retry");
    const task = await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    const review = workflowOf(task).feedback_review!;
    expect(review).toMatchObject({ status: "PENDING", review_complete: false });
    expect(task.text).toContain(`Retry it with agentx_decide_pr_feedback, decision RETRY_REVIEW and review_digest ${review.review_digest}`);
    const retried = await tool(e2e, "agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "RETRY_REVIEW", review_digest: review.review_digest });
    expect(retried.value).toMatchObject({ started: true });
    await e2e.settle();
    expect(visibleSlackText(e2e.slack.lastPostWithAction("agentx_feedback_review_recommended").text)).toMatch(/^PR feedback is ready: 1 comment; 1 recommendation\./);
    expect(retired(e2e, failed.ts)).toBe(true);
    // A second retry of the same failed review starts nothing.
    const again = await tool(e2e, "agentx_decide_pr_feedback", { task_id: e2e.taskId(), decision: "RETRY_REVIEW", review_digest: review.review_digest });
    expect(again.value).toMatchObject({ started: false });
  }, 120_000);

  it("11.5 a fix that changed nothing: agentx_keep_pull_request keeps the PR as it is, as the Slack button does", async () => {
    let fixRuns = 0;
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: (latest) => {
      if (!latest.includes("Implement only the owner-approved PR feedback")) return editsOrFix(latest);
      fixRuns += 1;
      return [];
    }, feedback: (prompt) => feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }) } });
    const pullRequest = await openDraftPr(e2e);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_feedback_review_recommended");
    await e2e.settle();
    expect(fixRuns).toBe(1);
    const card = e2e.slack.posts.at(-1)!;
    expect(actionIds(card)).toContain("agentx_workflow_keep_pull_requests");
    const task = await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    const { revision } = workflowOf(task);
    expect(task.text).toContain(`The approved fix didn't change any code, so nothing was pushed to the pull request. To run the fix again, use agentx_retry_workflow with expected_revision ${revision}. To keep the pull request as it is and wait for its merge, use agentx_keep_pull_request with expected_revision ${revision}.`);
    const other = await e2e.mcp("agentx_keep_pull_request", { task_id: e2e.taskId(), expected_revision: revision }, OMAR);
    expect(other.isError).toBe(true);
    const stale = await e2e.mcp("agentx_keep_pull_request", { task_id: e2e.taskId(), expected_revision: revision - 1 });
    expect(stale.isError).toBe(true);
    expect(e2e.workflow().revision).toBe(revision);
    await tool(e2e, "agentx_keep_pull_request", { task_id: e2e.taskId(), expected_revision: revision });
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(said(e2e).at(-1)).toBe("Got it. The pull request stays as it is; I'll finish this task when it's merged.");
    expect(retired(e2e, card.ts)).toBe(true);
    const after = await tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    expect(after.text).toContain(WAITING_FOR_MERGE);
    expect(e2e.github.pushLog.filter((push) => push.during === "maintain")).toEqual([]);
  }, 120_000);

  it("11.5 a request ID already used for a dismissal is refused by agentx_keep_pull_request, never answered as a keep", async () => {
    // Found in review: any earlier dismissal with the same request ID was taken for this Keep's replay.
    const { e2e } = await feedbackProposed();
    const proposal = await tool(e2e, "agentx_get_pr_feedback", { task_id: e2e.taskId() });
    const { revision, review_digest, proposal_digest, bundle_digests } = proposal.value as { revision: number; review_digest: string; proposal_digest: string; bundle_digests: string[] };
    const requestId = "11511111-2222-4333-8444-555555555555";
    await tool(e2e, "agentx_decide_pr_feedback", { task_id: e2e.taskId(), request_id: requestId, decision: "DISMISS", expected_revision: revision, review_digest, proposal_digest, bundle_digests,
      note: "Not needed." });
    await e2e.settle();
    const reused = await e2e.mcp("agentx_keep_pull_request", { task_id: e2e.taskId(), request_id: requestId, expected_revision: revision });
    expect(reused.isError).toBe(true);
    expect(reused.error).toMatchObject({ code: "INVALID_REQUEST", message: "this request ID was already used for another decision on this task; use a new one" });
    expect(e2e.workflow().feedbackDecisions?.filter((decision) => decision.decision === "DISMISS")).toHaveLength(1);
  }, 120_000);

  it("11.6 agentx_get_task's stage and next step match the thread at every stage, through the merge", async () => {
    const { e2e, pullRequest } = await feedbackProposed();
    const at = async () => tool(e2e, "agentx_get_task", { task_id: e2e.taskId() });
    const proposed = await at();
    expect(workflowOf(proposed)).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(proposed.text).toContain(FEEDBACK_READY(workflowOf(proposed).revision));
    expect(said(e2e).at(-1)).toMatch(/^PR feedback is ready/);
    await e2e.click("agentx_feedback_review_recommended");
    const coding = await at();
    expect(workflowOf(coding)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(coding.text).not.toContain("agentx_open_pull_request");
    await e2e.settle();
    const pushed = await at();
    expect(said(e2e).at(-1)).toBe(PUSHED_FIX(pullRequest.number));
    expect(workflowOf(pushed)).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(pushed.text).toContain(WAITING_FOR_MERGE);
    e2e.github.merge(pullRequest.number);
    expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await e2e.settle();
    const merged = await at();
    expect(said(e2e).at(-1)).toBe(MERGED);
    expect(workflowOf(merged)).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(merged.text).toContain("The pull request is merged. This task is complete.");
    expect(merged.text).not.toContain("agentx_open_pull_request");
  }, 120_000);

  it("11.7 signed People, MCP proposals and a current-owner Retry preserve the parked operation", async () => {
    const directory = taskPeopleDirectory(false);
    directory.members.get(SLACK_MAYA.slackUserId!)!.add(SECOND_CHANNEL);
    await expect(directory.check({
      pk: "DEVTASK#11711111-2222-4333-8444-555555555550", sk: "META", entityType: "DEVELOPER_TASK",
      taskId: "11711111-2222-4333-8444-555555555550", developerId: SLACK_MAYA.developerId, provider: "slack",
      developerName: SLACK_MAYA.name, slackUserId: SLACK_MAYA.slackUserId!, client: "slack", project: "payments", title: "People proof",
      workspaceId: "11711111-2222-4333-8444-555555555551", ownerKey: "owner", conversationId: "conversation", startingRevision: 1,
      charge: { member: { pk: "MEMBER#maya", sk: "USAGE" }, organization: { pk: "ORG#acme", sk: "USAGE" } },
      shared: true, share: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", mode: "continue", sharedReason: "requested", sharedAt: "2026-10-11T00:00:00.000Z" },
      createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z",
    }, "e".repeat(64))).rejects.toThrow("fresh task person proof is unavailable");
    const linkedExternal = { developerId: "f".repeat(64), name: "Maya External", provider: "oidc" as const,
      sessionId: "s-maya-external", slackUserId: SLACK_MAYA.slackUserId! };
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, taskPeople: {
      changesEnabled: true, checkTaskPerson: directory.check, taskPersonProof: directory.proof, taskPeopleDisplayRead: directory.display,
      developers: [linkedExternal, SLACK_BAILEY], boundChannels: [SECOND_CHANNEL],
    } });
    await atPlanReview(e2e);
    await e2e.click("agentx_task_people");
    expect(e2e.people.replies).toEqual([expect.objectContaining({ action: "read", statusCode: 200 })]);
    await e2e.submitView({
      task_person: { person: { selected_user: BAILEY.slackUserId } },
      task_role: { role: { selected_option: { value: "viewer" } } },
    });
    await e2e.deliverNotices();
    const committed = e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")!;
    expect(committed).toMatchObject({ revision: 2, orphaned: false, people: [
      expect.objectContaining({ slackUserId: SLACK_MAYA.slackUserId, role: "owner" }),
      expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "viewer" }),
    ] });
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toEqual([
      expect.objectContaining({ actorDeveloperId: SLACK_MAYA.developerId, afterRole: "viewer" }),
    ]);
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_NOTIFICATION")).toEqual([
      expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "viewer", status: "SENT", attempts: 1 }),
    ]);
    directory.members.get(BAILEY.slackUserId)!.add("C0123456789");

    const view = await tool(e2e, "agentx_get_task_people", { task_id: e2e.taskId() });
    const person = (view.value.people as Array<{ person_id: string; name: string }>).find((entry) => entry.name === BAILEY.name)!;
    const beforeProposal = structuredClone(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE"));
    const proposed = await tool(e2e, "agentx_set_task_person", { task_id: e2e.taskId(), request_id: "11711111-2222-4333-8444-555555555555",
      expected_people_revision: 2, person_id: person.person_id, role: "commenter" });
    expect(proposed.value).toMatchObject({ status: "PENDING", request_id: "11711111-2222-4333-8444-555555555555" });
    const polled = await tool(e2e, "agentx_get_task_people_request", { task_id: e2e.taskId(), request_id: "11711111-2222-4333-8444-555555555555" });
    expect(polled.value).toMatchObject({ status: "PENDING", request_id: "11711111-2222-4333-8444-555555555555",
      confirmation_url: proposed.value.confirmation_url, expires_at: proposed.value.expires_at });
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")).toEqual(beforeProposal);
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(1);
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_NOTIFICATION")).toHaveLength(1);

    const external = await e2e.mcp("agentx_set_task_person", { task_id: e2e.taskId(), request_id: "11711111-2222-4333-8444-555555555556",
      expected_people_revision: 2, person_id: person.person_id, role: "owner" }, linkedExternal);
    expect(external.isError).toBe(true);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")).toEqual(beforeProposal);

    e2e.people.changesEnabled(false);
    const disabled = await e2e.mcp("agentx_set_task_person", { task_id: e2e.taskId(), request_id: "11711111-2222-4333-8444-555555555557",
      expected_people_revision: 2, person_id: person.person_id, role: "owner" });
    expect(disabled.isError).toBe(true);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")).toEqual(beforeProposal);
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(1);
    e2e.people.changesEnabled(true);

    const invocationsBeforeApproval = e2e.invocations.length;
    const charge = structuredClone(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!.charge);
    await e2e.click("agentx_workflow_approve");
    directory.members.get(SLACK_MAYA.slackUserId!)!.delete("C0123456789");
    expect([...directory.members.get(SLACK_MAYA.slackUserId!)!]).toEqual([SECOND_CHANNEL]);
    await e2e.settle();
    const queued = e2e.db.find((item) => item.entityType === "OUTBOX"
      && (item.invocation as { payload?: { workflowMode?: string } } | undefined)?.payload?.workflowMode === "IMPLEMENT")[0]!;
    expect(e2e.db.get(String(queued.pk), String(queued.sk))).toMatchObject({
      status: "WAITING_FOR_TASK_ACCESS", operationId: queued.operationId, invocation: queued.invocation,
    });
    expect(e2e.invocations).toHaveLength(invocationsBeforeApproval);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!.charge).toEqual(charge);

    const peopleRepliesBeforeTakeover = e2e.people.replies.length;
    await e2e.click("agentx_task_people", { user: BAILEY.slackUserId });
    expect(e2e.people.replies.slice(peopleRepliesBeforeTakeover)).toEqual([expect.objectContaining({ action: "read", statusCode: 200 })]);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")).toMatchObject({ orphaned: true,
      people: [expect.objectContaining({ slackUserId: SLACK_MAYA.slackUserId, role: "commenter" }), expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "viewer" })] });
    expect(e2e.slack.views.at(-1)?.view).toMatchObject({ callback_id: "agentx_task_take_ownership" });
    const beforeTakeoverProposal = structuredClone(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE"));
    const takeoverProposal = await tool(e2e, "agentx_take_task_ownership", { task_id: e2e.taskId(), request_id: "11711111-2222-4333-8444-555555555559",
      expected_people_revision: beforeTakeoverProposal!.revision }, SLACK_BAILEY);
    expect(takeoverProposal.value).toMatchObject({ status: "PENDING", request_id: "11711111-2222-4333-8444-555555555559" });
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")).toEqual(beforeTakeoverProposal);
    await e2e.submitView({}, { user: BAILEY.slackUserId });
    const taken = e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")!;
    expect(taken).toMatchObject({ orphaned: false, people: [
      expect.objectContaining({ slackUserId: SLACK_MAYA.slackUserId, role: "commenter" }),
      expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "owner" }),
    ] });
    expect(e2e.db.get(String(queued.pk), String(queued.sk))?.status).toBe("WAITING_FOR_TASK_ACCESS");
    expect(e2e.invocations).toHaveLength(invocationsBeforeApproval);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!.charge).toEqual(charge);

    await tool(e2e, "agentx_retry_workflow", { task_id: e2e.taskId(), request_id: "11711111-2222-4333-8444-555555555558",
      instructions: "Continue the accepted coding run." }, SLACK_BAILEY);
    expect(e2e.db.get(String(queued.pk), String(queued.sk))).toMatchObject({ status: "PENDING", operationId: queued.operationId, invocation: queued.invocation });
    expect(e2e.db.find((item) => item.entityType === "TASK_ACCESS_RETRY")).toEqual([
      expect.objectContaining({ operationId: queued.operationId, actorId: taskOwnerKey(SLACK_BAILEY.developerId, e2e.taskId()) }),
    ]);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")).toMatchObject({
      developerId: SLACK_MAYA.developerId, slackUserId: SLACK_MAYA.slackUserId,
    });
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "META")!.charge).toEqual(charge);
    expect(await e2e.worker.redeliver(String(queued.operationId))).toBe(true);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    e2e.github.merge(e2e.github.pullRequests[0]!.number);
    expect(await e2e.githubWebhook(e2e.github.pullRequests[0]!.number, { merged: true })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
  }, 120_000);

  it("11.8 a signed owner invite is bounded when unknown and notifies once after confirmed membership", async () => {
    const roleSubmission = {
      task_person: { person: { selected_user: BAILEY.slackUserId } },
      task_role: { role: { selected_option: { value: "owner" } } },
    };
    const viewerSubmission = {
      task_person: { person: { selected_user: BAILEY.slackUserId } },
      task_role: { role: { selected_option: { value: "viewer" } } },
    };

    const unknownDirectory = taskPeopleDirectory(false);
    const unknownInvitations: Array<{ teamId: string; channelId: string; slackUserId: string }> = [];
    const unknown = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, taskPeople: {
      changesEnabled: true, checkTaskPerson: unknownDirectory.check, taskPersonProof: unknownDirectory.proof,
      taskPeopleDisplayRead: unknownDirectory.display, boundChannels: [SECOND_CHANNEL],
      inviteTaskPerson: async (input) => { unknownInvitations.push(input); return "unknown"; },
    } });
    await atPlanReview(unknown);
    await unknown.click("agentx_task_people");
    const beforeUnknown = structuredClone(unknown.db.get(`DEVTASK#${unknown.taskId()}`, "PEOPLE"));
    await expect(unknown.submitView(roleSubmission)).rejects.toThrow("the modal refused the submission");
    expect(unknownInvitations).toEqual([{ teamId: "T0BSHLLUGBD", channelId: "C0123456789", slackUserId: BAILEY.slackUserId }]);
    expect(unknown.db.get(`DEVTASK#${unknown.taskId()}`, "PEOPLE")).toEqual(beforeUnknown);
    expect(unknown.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toEqual([]);
    expect(unknown.db.find((item) => item.entityType === "TASK_PEOPLE_NOTIFICATION")).toEqual([]);
    await unknown.click("agentx_workflow_approve");
    await unknown.settle();
    unknown.github.merge(unknown.github.pullRequests[0]!.number);
    expect(await unknown.githubWebhook(unknown.github.pullRequests[0]!.number, { merged: true })).toBe(200);
    await unknown.settle();

    const directory = taskPeopleDirectory(false);
    const invitations: Array<{ teamId: string; channelId: string; slackUserId: string }> = [];
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS }, taskPeople: {
      changesEnabled: true, checkTaskPerson: directory.check, taskPersonProof: directory.proof, taskPeopleDisplayRead: directory.display, boundChannels: [SECOND_CHANNEL],
      inviteTaskPerson: async (input) => { invitations.push(input); directory.members.get(input.slackUserId)?.add(input.channelId); return "accepted"; },
    } });
    await atPlanReview(e2e);
    await e2e.click("agentx_task_people");
    e2e.stream.duplicateNext();
    await e2e.submitView(viewerSubmission);
    await e2e.deliverNotices();
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_NOTIFICATION")).toEqual([
      expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "viewer", status: "SENT", attempts: 1 }),
    ]);
    await e2e.click("agentx_task_people");
    await e2e.submitView(roleSubmission);
    expect(invitations).toEqual([{ teamId: "T0BSHLLUGBD", channelId: "C0123456789", slackUserId: BAILEY.slackUserId }]);
    expect(e2e.db.get(`DEVTASK#${e2e.taskId()}`, "PEOPLE")).toMatchObject({ revision: 3, orphaned: false,
      people: [expect.objectContaining({ role: "owner" }), expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "owner" })] });
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_EVENT")).toHaveLength(2);
    expect(e2e.db.find((item) => item.entityType === "TASK_PEOPLE_NOTIFICATION")).toEqual([
      expect.objectContaining({ slackUserId: BAILEY.slackUserId, role: "viewer", status: "SENT", attempts: 1 }),
    ]);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    e2e.github.merge(e2e.github.pullRequests[0]!.number);
    expect(await e2e.githubWebhook(e2e.github.pullRequests[0]!.number, { merged: true })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
  }, 120_000);
});
