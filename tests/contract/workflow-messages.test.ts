import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_REVIEW_FAILURE_REASONS, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WorkflowStageSchema, WorkflowStateSchema, createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema, WorkflowSnapshotViewSchema, type WorkflowSnapshot } from "@agentx/contracts";
import { WORKFLOW_ACTION_IDS, documentSummaryLines, plainBlockReason, workflowMessage, workflowMessageKey, workflowModalCopy } from "../../packages/broker/src/developer/workflow-messages.js";
import { WORKFLOW_ACTION_IDS as INTERACTIVITY_ACTION_IDS } from "../../packages/broker/src/aws/slack-interactivity.js";
import { StrictSlackWeb, visibleSlackText } from "../support/strict-slack.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-07T12:00:00.000Z";
const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "a".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
const plan = { id: "plan-v1", type: "plan" as const, version: 1, sha256: "c".repeat(64), producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: now };
const JARGON = /\b(candidate|revision|digest|operation|artifact|workflow|SUCCEEDED|FAILED|INTERRUPTED|invalid json)\b/i;
/** The words no workflow post may use: technical ones in any case, and the raw statuses as written. */
const BANNED = /\b(candidate|revision|digest|operation|artifact|workflow|invalid json)\b|\b(SUCCEEDED|FAILED|INTERRUPTED|CANCELLED)\b|ended (SUCCEEDED|FAILED)/i;
/** Every block reason the broker writes, by the stages it stops (grep blockWorkflow and blockReason in packages/broker). */
const BROKER_BLOCK_REASONS: Array<{ stages: string[]; reason: string; plain: boolean }> = [
  ...Object.values(WORKFLOW_BLOCK_REASONS).map((reason) => ({ stages: ["PLAN", "IMPLEMENT", "VERIFY", "WAIT_FOR_MERGE"], reason, plain: true })),
  { stages: ["REVIEW"], reason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, plain: true },
  { stages: ["REVIEW"], reason: WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, plain: true },
  { stages: ["IMPLEMENT", "VERIFY"], reason: WORKFLOW_HISTORY_REWRITTEN_MESSAGE, plain: true },
  ...["failed", "interrupted", "cancelled"].flatMap((status) => [
    { stages: ["IMPLEMENT"], reason: `implementation operation ended ${status}`, plain: false },
    { stages: ["VERIFY"], reason: `verification retry operation ended ${status}`, plain: false },
    { stages: ["REVIEW"], reason: `independent review operation ended ${status}`, plain: false },
    { stages: ["PLAN"], reason: `planning operation ended ${status}`, plain: false },
  ]),
  { stages: ["REVIEW"], reason: "independent candidate review was invalid, incomplete, or stale", plain: false },
  { stages: ["VERIFY"], reason: "candidate checks are being recorded", plain: false },
];

function snapshot(stage: string, state: string, extra: Record<string, unknown> = {}): WorkflowSnapshot {
  const base = createWorkflowSnapshot({ taskId, ownerId: "a".repeat(64), now });
  const atOrAfterPr = ["PULL_REQUEST", "WAIT_FOR_MERGE", "MERGED"].includes(stage);
  return WorkflowSnapshotSchema.parse({ ...base, revision: 7, stage, state, artifacts: [plan],
    ...(stage === "MERGED" ? { outcome: "MERGED" } : stage === "CLOSED" ? { outcome: "CLOSED" } : {}),
    ...(atOrAfterPr || ["REVIEW", "VERIFY"].includes(stage) ? { candidate, verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }] } } : {}),
    ...(atOrAfterPr ? { reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role, provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })) } : {}),
    ...(["WAIT_FOR_MERGE", "MERGED"].includes(stage) ? { pullRequests: [{ repositoryId: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headSha: "d".repeat(40), candidateDigest: candidate.digest, required: true, state: stage === "MERGED" ? "MERGED" : "OPEN" }] } : {}),
    ...extra });
}

type Button = { action_id: string; text: { text: string }; value: string; style?: string };
const buttonsOf = (blocks: Array<Record<string, unknown>>): Button[] =>
  blocks.filter((block) => block.type === "actions").flatMap((block) => block.elements as Button[]);

const checkPolicy = { required: [{ id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } }],
  optional: [{ id: "lint", label: "npm run lint <x>", command: { cwd: "repo/demo", executable: "npm", args: ["run", "lint"], timeoutSeconds: 30 } }], selectedOptionalIds: ["lint"] };
const review = (role: string, status: string, extra: Record<string, unknown> = {}) => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role, provider: "t", version: "1", status, findings: [], readOnly: true, recordedAt: now, ...extra });

/** Every shape a step can take that has its own words: each stage and state, plus the variants inside a pair. */
function variants(): Array<{ name: string; workflow: WorkflowSnapshot; publishFailure?: { category: string; codeChanged?: boolean } }> {
  const found: Array<{ name: string; workflow: WorkflowSnapshot; publishFailure?: { category: string; codeChanged?: boolean } }> = [];
  for (const stage of WorkflowStageSchema.options) for (const state of WorkflowStateSchema.options) {
    try { found.push({ name: `${stage}/${state}`, workflow: snapshot(stage, state, { checkPolicy }) }); } catch { /* pairs the schema forbids cannot occur */ }
  }
  const failedChecks = { checkPolicy, verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "FAILED" }, { checkId: "lint", status: "FAILED" }] } };
  found.push({ name: "VERIFY/BLOCKED failed checks", workflow: snapshot("VERIFY", "BLOCKED", failedChecks) });
  found.push({ name: "VERIFY/BLOCKED no checks", workflow: snapshot("VERIFY", "BLOCKED", { blockReason: WORKFLOW_BLOCK_REASONS.noChecksConfigured }) });
  for (const reason of WORKFLOW_REVIEW_FAILURE_REASONS) {
    found.push({ name: `REVIEW/BLOCKED ${reason}`, workflow: snapshot("REVIEW", "BLOCKED", { reviews: [review("SECURITY", "UNKNOWN", { failureReason: reason }), review("CRITIC", "FAILED", { failureReason: reason })] }) });
  }
  found.push({ name: "REVIEW/BLOCKED interrupted", workflow: snapshot("REVIEW", "BLOCKED", { reviews: [review("CRITIC", "INTERRUPTED")] }) });
  found.push({ name: "REVIEW/BLOCKED gave up", workflow: snapshot("REVIEW", "BLOCKED", { blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE }) });
  found.push({ name: "REVIEW/BLOCKED findings", workflow: snapshot("REVIEW", "BLOCKED", { reviews: [review("CRITIC", "FINDINGS", { findings: Array.from({ length: 20 }, (_, index) => ({ text: `${"Long problem ".repeat(46)}${index}`, origin: "INTRODUCED", file: `src/${"deep/".repeat(90)}x.ts`, line: 9 })) }), review("SECURITY", "PASS", { findings: Array.from({ length: 20 }, () => ({ text: "Old", origin: "PRE_EXISTING" })) })] }) });
  for (const { stages, reason } of [...BROKER_BLOCK_REASONS, { stages: ["PLAN", "IMPLEMENT", "VERIFY", "REVIEW", "WAIT_FOR_MERGE"], reason: "some internal FAILED digest text", plain: false }]) {
    for (const stage of stages) found.push({ name: `${stage}/BLOCKED ${reason}`, workflow: snapshot(stage, "BLOCKED", { blockReason: reason, checkPolicy }) });
  }
  found.push({ name: "PULL_REQUEST/BLOCKED gave up", workflow: snapshot("PULL_REQUEST", "BLOCKED", { blockReason: WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, checkPolicy }) });
  for (const category of ["publication_failed", "interrupted", "worker_unavailable", "timed_out", "task_failed"]) {
    found.push({ name: `PULL_REQUEST/READY publish ${category}`, workflow: snapshot("PULL_REQUEST", "READY", { checkPolicy }), publishFailure: { category } });
  }
  found.push({ name: "PULL_REQUEST/READY code changed", workflow: snapshot("PULL_REQUEST", "READY", { checkPolicy }), publishFailure: { category: "publication_failed", codeChanged: true } });
  const decided = (decision: string, source?: string) => [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision, actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "r", artifactDigest: "c".repeat(64), ...(source === undefined ? {} : { source }), at: now }];
  found.push({ name: "IMPLEMENT/RUNNING approved", workflow: snapshot("IMPLEMENT", "RUNNING", { checkPolicy, decisions: decided("APPROVE") }) });
  found.push({ name: "IMPLEMENT/RUNNING sent back", workflow: snapshot("IMPLEMENT", "RUNNING", { checkPolicy, decisions: decided("REQUEST_CHANGES", "SEND_BACK") }) });
  found.push({ name: "PLAN/RUNNING changes", workflow: snapshot("PLAN", "RUNNING", { decisions: decided("REQUEST_CHANGES") }) });
  found.push({ name: "PLAN/RUNNING full", workflow: snapshot("PLAN", "RUNNING", { path: "FULL", reviewPhase: "IMPLEMENTATION_PLAN", decisions: decided("APPROVE") }) });
  found.push({ name: "CLOSED/COMPLETE rejected", workflow: snapshot("CLOSED", "COMPLETE", { outcome: "REJECTED" }) });
  return found;
}

describe("workflow Slack messages", () => {
  it("renders every stage and state as brief, jargon-free text with blocks Slack accepts", () => {
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    for (const stage of WorkflowStageSchema.options) for (const state of WorkflowStateSchema.options) {
      let workflow: WorkflowSnapshot;
      try { workflow = snapshot(stage, state); } catch { continue; } // pairs the schema forbids cannot occur
      const message = workflowMessage({ taskId, ownerSlackUserId: "U0123456789", workflow, documentLink: { url: "https://agentx.example.test/review/x/task" }, findingsUrl: "https://agentx.example.test/review/x/task#findings" });
      if (message === undefined) continue;
      expect(visibleSlackText(message.text), `${stage}/${state}`).not.toMatch(JARGON);
      expect(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message }), `${stage}/${state}`).not.toThrow();
    }
  });

  it("never says how a run ended, never uses banned words, stays within 1,200 visible characters, and gives every blocked step its ways out", () => {
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    const rendered: string[] = [];
    for (const { name, workflow, publishFailure } of variants()) {
      const message = workflowMessage({ taskId, ownerSlackUserId: "U0123456789", workflow, documentLink: { url: "https://agentx.example.test/review/x/task" },
        documentSummary: ["Goal: add greet.", "1. Edit greeting.ts", "2. Add a test"], newReplies: 2,
        findingsUrl: "https://agentx.example.test/review/x/task#findings", ...(publishFailure === undefined ? {} : { publishFailure }) });
      if (message === undefined) continue;
      rendered.push(name);
      const visible = visibleSlackText(message.text);
      expect(visible, name).not.toMatch(BANNED);
      const labels = buttonsOf(message.blocks).map((button) => button.text.text).join(" ");
      expect(labels, name).not.toMatch(BANNED);
      expect(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message }), name).not.toThrow();
      const buttons = buttonsOf(message.blocks);
      for (const button of buttons) expect(WORKFLOW_ACTION_IDS.has(button.action_id), `${name}: ${button.action_id}`).toBe(true);
      expect(buttons.filter((button) => button.style === "primary").length, name).toBeLessThanOrEqual(1);
      if (workflow.state === "BLOCKED" || publishFailure !== undefined) {
        expect(buttons.map((button) => button.action_id), name).toContain("agentx_workflow_close");
        // A way on besides closing, except where nothing could work again (no checks are configured).
        // A way on besides closing, except where nothing could work again: no checks configured, history rewritten,
        // or a pull request AgentX no longer follows (nothing on GitHub is retried from Slack).
        const closeOnly = name === "VERIFY/BLOCKED no checks" || name.startsWith("WAIT_FOR_MERGE/") || name === `IMPLEMENT/BLOCKED ${WORKFLOW_HISTORY_REWRITTEN_MESSAGE}` || name === `VERIFY/BLOCKED ${WORKFLOW_HISTORY_REWRITTEN_MESSAGE}`;
        if (closeOnly && name.endsWith(WORKFLOW_HISTORY_REWRITTEN_MESSAGE)) expect(buttons.map((button) => button.action_id), name).toEqual(["agentx_workflow_close"]);
        if (!closeOnly) expect(buttons.length, name).toBeGreaterThan(1);
      }
    }
    // Each blocked stage and the publish failures were rendered, not skipped.
    for (const name of ["PLAN/BLOCKED", "IMPLEMENT/BLOCKED", "VERIFY/BLOCKED", "REVIEW/BLOCKED", "PULL_REQUEST/BLOCKED gave up", "PULL_REQUEST/READY code changed", "REVIEW/BLOCKED findings"]) {
      expect(rendered, name).toContain(name);
    }
  });

  it("acknowledges each owner decision by what it was, not by the stage alone", () => {
    const full = (phase: string, decision: string) => snapshot("PLAN", "RUNNING", { path: "FULL", reviewPhase: phase, decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 6, decision, actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "r", artifactDigest: "c".repeat(64), at: now }] });
    expect(workflowMessage({ taskId, workflow: full("DESIGN", "APPROVE") })?.text).toBe("Requirements approved. Writing the design next.");
    expect(workflowMessage({ taskId, workflow: full("DESIGN", "REQUEST_CHANGES") })?.text).toBe("Got it. Revising the design with your changes.");
    expect(workflowMessage({ taskId, workflow: snapshot("PLAN", "RUNNING") })?.text).toContain("Working on the coding plan");
    const approved = snapshot("IMPLEMENT", "RUNNING", { checkPolicy, decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "r", artifactDigest: "c".repeat(64), at: now }] });
    expect(workflowMessage({ taskId, ownerSlackUserId: "U0123456789", workflow: approved })?.text).toBe("Coding plan approved by <@U0123456789>. Writing the code now; then I'll run 2 checks.");
    expect(workflowMessage({ taskId, workflow: snapshot("IMPLEMENT", "RUNNING") })?.text).toBe("Trying the coding step again.");
  });

  it("lists introduced findings briefly with Send back, Retry and Close, and keeps older issues advisory", () => {
    const findings = snapshot("REVIEW", "BLOCKED", { reviews: [
      { operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "Drops the last line <!channel>", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: now },
      { operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [{ text: "Old logger prints emails", origin: "PRE_EXISTING" }], readOnly: true, recordedAt: now },
    ] });
    const message = workflowMessage({ taskId, workflow: findings, findingsUrl: "https://agentx.example.test/review/x/task#findings" })!;
    expect(message.text).toContain("Reviews found 1 issue in this change.");
    expect(message.text).toContain("Drops the last line &lt;!channel&gt; (src/parse.ts:40)");
    expect(message.text).toContain("1 older issue was noted but doesn't block.");
    expect(JSON.stringify(message.blocks)).toMatch(/agentx_workflow_send_back[\s\S]*agentx_workflow_retry_reviews[\s\S]*agentx_workflow_close/);
  });

  it("says why a review could not finish in plain words, for every recorded reason", () => {
    for (const failureReason of WORKFLOW_REVIEW_FAILURE_REASONS) {
      const text = workflowMessage({ taskId, workflow: snapshot("REVIEW", "BLOCKED", { reviews: [review("SECURITY", "UNKNOWN", { failureReason })] }) })!.text;
      expect(text, failureReason).toMatch(/^A review couldn't finish \(security review: [a-z' ]+\)\. Nothing was sent to GitHub\.$/);
      expect(text, failureReason).not.toContain(failureReason.toLowerCase().replaceAll("_", " "));
    }
    expect(workflowMessage({ taskId, workflow: snapshot("REVIEW", "BLOCKED", { reviews: [review("SECURITY", "UNKNOWN", { failureReason: "INVALID_JSON" })] }) })!.text)
      .toBe("A review couldn't finish (security review: its answer wasn't in the expected format). Nothing was sent to GitHub.");
  });

  it("turns the broker's own block reasons into plain sentences", () => {
    expect(plainBlockReason("implementation operation ended failed")).toBe("The run stopped unexpectedly.");
    expect(plainBlockReason("planning operation ended interrupted")).toBe("The run stopped unexpectedly.");
    expect(plainBlockReason("independent review operation ended cancelled")).toBe("The run stopped unexpectedly.");
    expect(plainBlockReason("independent candidate review was invalid, incomplete, or stale")).toBe("The result couldn't be trusted, so nothing moved forward.");
    // Only exact, known plain reasons pass: a prefix that looks plain is not enough.
    expect(plainBlockReason("AgentX could not verify the selected checks for the final code candidate.")).toBe("Something went wrong on AgentX's side.");
    expect(plainBlockReason("No checks ran: candidate digest abc")).toBe("Something went wrong on AgentX's side.");
    expect(plainBlockReason("planning run succeeded without a saved plan artifact")).toBe("Something went wrong on AgentX's side.");
    expect(plainBlockReason(undefined)).toBe("Something went wrong on AgentX's side.");
    for (const { reason, plain } of BROKER_BLOCK_REASONS) {
      const said = plainBlockReason(reason);
      expect(said, reason).not.toMatch(BANNED);
      if (plain) expect(said, reason).toBe(reason);
      else expect(said, reason).not.toBe(reason);
    }
  });

  it("renders every blocked step the schema allows, with Close task; the rest are refused by the schema", () => {
    for (const stage of WorkflowStageSchema.options) {
      let workflow: WorkflowSnapshot;
      try {
        workflow = snapshot(stage, "BLOCKED", { blockReason: stage === "PULL_REQUEST" ? WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE : "planning operation ended failed" });
      } catch {
        // Nothing runs while a document waits for its owner, a closed task is done, and a merged one is complete.
        expect(["PLAN_REVIEW", "CLOSED", "MERGED"], stage).toContain(stage);
        continue;
      }
      const message = workflowMessage({ taskId, workflow });
      expect(message, stage).toBeDefined();
      expect(buttonsOf(message!.blocks).map((button) => button.action_id), stage).toContain("agentx_workflow_close");
    }
    expect(workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "BLOCKED", { blockReason: WORKFLOW_BLOCK_REASONS.pullRequestChanged }) })!.text)
      .toBe(`I stopped following the pull request. ${WORKFLOW_BLOCK_REASONS.pullRequestChanged}`);
    expect(buttonsOf(workflowMessage({ taskId, workflow: snapshot("IMPLEMENT", "BLOCKED", { blockReason: WORKFLOW_HISTORY_REWRITTEN_MESSAGE }) })!.blocks).map((button) => button.action_id))
      .toEqual(["agentx_workflow_close"]);
  });

  it("shows a task view's unverifiable document plainly with Close, while a stored workflow is never blocked at approval", () => {
    const waiting = snapshot("PLAN_REVIEW", "WAITING");
    const view = WorkflowSnapshotViewSchema.parse({ ...waiting, state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.documentUnverified });
    expect(() => WorkflowSnapshotSchema.parse(view)).toThrow(/cannot be blocked/);
    const message = workflowMessage({ taskId, workflow: view })!;
    expect(message.text).toBe("The saved coding plan couldn't be checked, so I stopped. Close this task and start again.");
    expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_close"]);
  });

  it("keys the merge step by its pull requests, so a pull request with a new head is said again", () => {
    // The same pull request with a new head is a new thing to say.
    const opened = snapshot("WAIT_FOR_MERGE", "WAITING");
    const republished = { ...opened, pullRequests: opened.pullRequests!.map((pullRequest) => ({ ...pullRequest, headSha: "9".repeat(40) })) };
    expect(workflowMessageKey(republished)).not.toBe(workflowMessageKey(opened));
    expect(workflowMessageKey({ ...opened, revision: 9 })).toBe(workflowMessageKey(opened));
    // Opening the pull requests is said once per checked code, however many repositories it takes.
    expect(workflowMessageKey(snapshot("PULL_REQUEST", "READY"))).toBe(workflowMessageKey({ ...snapshot("PULL_REQUEST", "READY"), revision: 12 }));
  });

  it("says a person merges the draft pull request on GitHub, then closes the task here, without promising to follow it", () => {
    const message = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "WAITING") })!;
    expect(message.text).toBe("Draft pull request opened: <https://github.com/example/demo/pull/42|PR #42>. Review it and merge it on GitHub, then close this task here.");
    expect(message.text).not.toMatch(/finish|when it's merged/);
    expect(buttonsOf(message.blocks).map((button) => [button.action_id, button.text.text])).toEqual([["agentx_workflow_close", "Close task"]]);
  });

  it("puts the approval card's document, version, summary, replies and link in one brief post", () => {
    const message = workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING"), documentLink: { url: "https://acme.slack.com/docs/T1/F1" },
      documentSummary: ["Goal: add <greet>."], newReplies: 1 })!;
    expect(message.text).toBe("*Coding plan v1 is ready for your approval.* No code has changed yet.\n> Goal: add &lt;greet&gt;.\n1 thread reply since the last step will be included.\n<https://acme.slack.com/docs/T1/F1|Read the full coding plan>");
    const buttons = buttonsOf(message.blocks);
    expect(buttons.map((button) => [button.action_id, button.text.text, button.style])).toEqual([
      ["agentx_workflow_approve", "Approve coding plan", "primary"], ["agentx_workflow_changes", "Request changes", undefined], ["agentx_workflow_close", "Close task", undefined]]);
    expect(JSON.parse(buttons[0]!.value)).toEqual({ taskId, revision: 7, digest: plan.sha256, decision: "APPROVE" });
    expect(workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING") })!.text).toContain("I couldn't link the full coding plan; ask an AgentX admin to check the task page.");
  });

  it("says replies that came in after the plan, with where to read them, on the draft pull request, merge and blocked posts", () => {
    const page = "https://agentx.example.test/review/x/task";
    const line = `2 thread replies came in after the plan; see <${page}|the task page>.`;
    const opened = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "WAITING"), newReplies: 2, taskPageUrl: page })!;
    expect(opened.text.split("\n")).toEqual([expect.stringContaining("Draft pull request opened"), line]);
    const failedChecks = snapshot("VERIFY", "BLOCKED", { checkPolicy, verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "FAILED" }] } });
    const blocked = workflowMessage({ taskId, workflow: failedChecks, newReplies: 2, taskPageUrl: page })!;
    expect(blocked.text.split("\n").at(-1)).toBe(line);
    // Send back stays offered: it gives the replies to the coder.
    expect(buttonsOf(blocked.blocks).map((button) => button.action_id)).toContain("agentx_workflow_send_back");
    expect(workflowMessage({ taskId, workflow: snapshot("IMPLEMENT", "BLOCKED"), newReplies: 1 })!.text).toContain("1 thread reply came in after the plan; see the task page.");
    // Nothing is said with no such replies, or where the next step takes them anyway.
    expect(workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "WAITING"), newReplies: 0, taskPageUrl: page })!.text).not.toContain("thread repl");
    expect(workflowMessage({ taskId, workflow: snapshot("IMPLEMENT", "RUNNING"), newReplies: 2, taskPageUrl: page })!.text).not.toContain("thread repl");
  });

  it("says when the reviews saw only part of the change", () => {
    const partial = snapshot("PULL_REQUEST", "READY");
    const withPartial = { ...partial, reviews: partial.reviews!.map((entry) => ({ ...entry, partialDiff: true as const })) };
    expect(workflowMessage({ taskId, workflow: withPartial })!.text).toBe("Checks and reviews passed. Opening a draft pull request. The change was too large to show the reviewers in full, so they reviewed only part of it.");
    expect(workflowMessage({ taskId, workflow: partial })!.text).toBe("Checks and reviews passed. Opening a draft pull request.");
  });

  it("names every button the router answers", () => {
    expect(INTERACTIVITY_ACTION_IDS).toBe(WORKFLOW_ACTION_IDS);
  });

  it("names the approval modal after the document being approved", () => {
    expect(workflowModalCopy(snapshot("PLAN_REVIEW", "WAITING", { path: "FULL", reviewPhase: "REQUIREMENTS", artifacts: [{ ...plan, type: "requirements" }] }), "APPROVE")).toEqual({ title: "Approve requirements", submit: "Approve and continue" });
    expect(workflowModalCopy(snapshot("PLAN_REVIEW", "WAITING"), "APPROVE")).toEqual({ title: "Approve coding plan", submit: "Approve and start coding" });
    expect(workflowModalCopy(snapshot("PLAN_REVIEW", "WAITING"), "REQUEST_CHANGES")).toEqual({ title: "Request changes", submit: "Send changes" });
  });

  it("summarises a document in at most three plain lines", () => {
    expect(documentSummaryLines("# Plan\n\n**Goal:** add `greet`.\n\n1. Edit greeting.ts\n2. Add a test\n3. Run checks\n4. Extra")).toEqual(["Goal: add greet.", "1. Edit greeting.ts", "2. Add a test"]);
    expect(documentSummaryLines("```ts\nconst x = 1;\n```\n- [Read](https://example.test) the *spec*\n" + "y".repeat(400), 2)).toEqual(["Read the spec", `${"y".repeat(157)}...`]);
  });
});
