import { describe, expect, it } from "vitest";
import { WORKFLOW_AUTO_PUBLISH_FAILED_MESSAGE, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, WORKFLOW_HISTORY_REWRITTEN_MESSAGE, WORKFLOW_PULL_REQUEST_UPDATE_CAUSES, WORKFLOW_REVIEW_FAILURE_REASONS, WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, WorkflowStageSchema, WorkflowStateSchema, createCandidateManifest, createWorkflowSnapshot, WorkflowSnapshotSchema, WorkflowSnapshotViewSchema, workflowFindingFingerprint, type WorkflowSnapshot } from "@agentx/contracts";
import { WORKFLOW_ACTION_IDS, documentSummaryLines, slackSectionTexts, feedbackReviewFailedMessage, plainBlockReason, planReviewLink, workflowMessage, workflowMessageKey, workflowModalCopy } from "../../packages/broker/src/developer/workflow-messages.js";
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
    { stages: ["WAIT_FOR_MERGE"], reason: `PR feedback review operation ended ${status}`, plain: false },
    { stages: ["PLAN"], reason: `planning operation ended ${status}`, plain: false },
  ]),
  { stages: ["REVIEW"], reason: "independent candidate review was invalid, incomplete, or stale", plain: false },
  { stages: ["WAIT_FOR_MERGE"], reason: "PR feedback review report was invalid, incomplete, or stale", plain: false },
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
  // An approved PR feedback fix: pushed to the pull request already open, pushed, or its push failed for each cause.
  const earlier = [{ repositoryId: "demo", number: 42, url: "https://github.com/example/demo/pull/42", headSha: "d".repeat(40), candidateDigest: "e".repeat(64), required: true, state: "OPEN" }];
  found.push({ name: "PULL_REQUEST/READY pushing the fix", workflow: snapshot("PULL_REQUEST", "READY", { checkPolicy, pullRequests: earlier }) });
  found.push({ name: "PULL_REQUEST/RUNNING pushing the fix", workflow: snapshot("PULL_REQUEST", "RUNNING", { checkPolicy, pullRequests: earlier }) });
  found.push({ name: "WAIT_FOR_MERGE/WAITING fix pushed", workflow: snapshot("WAIT_FOR_MERGE", "WAITING", { checkPolicy, pullRequestUpdatedAt: now }) });
  for (const cause of [...WORKFLOW_PULL_REQUEST_UPDATE_CAUSES, undefined]) {
    found.push({ name: `WAIT_FOR_MERGE/BLOCKED push failed ${String(cause)}`, workflow: snapshot("WAIT_FOR_MERGE", "BLOCKED", { checkPolicy, pullRequests: earlier,
      blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed, pullRequestUpdateFailure: { numbers: [42], ...(cause === undefined ? {} : { cause }) } }) });
  }
  // A feedback review starting, on one pull request and on several.
  const feedbackBundle = (number: number, repositoryId: string) => ({ schemaVersion: 1, taskId, repositoryId, number, headSha: "d".repeat(40), candidateDigest: candidate.digest,
    commentSetDigest: "e".repeat(64), producer: "p", version: "1", recordedAt: now, sha256: "f".repeat(64), objectKey: `private/o/w/feedback-${"f".repeat(64)}.json`,
    comments: [{ id: String(number), kind: "DISCUSSION", url: `https://github.com/example/${repositoryId}/pull/${number}#issuecomment-${number}`, author: "mia", updatedAt: now, bodyDigest: "a".repeat(64), bodyBytes: 20 }] });
  found.push({ name: "WAIT_FOR_MERGE/RUNNING feedback review started", workflow: snapshot("WAIT_FOR_MERGE", "RUNNING", { checkPolicy,
    feedbackReview: { status: "COLLECTING", threadObservations: [], bundleRefs: [feedbackBundle(42, "demo")] } }) });
  found.push({ name: "WAIT_FOR_MERGE/RUNNING feedback review started on several", workflow: snapshot("WAIT_FOR_MERGE", "RUNNING", { checkPolicy,
    feedbackReview: { status: "COLLECTING", threadObservations: [], bundleRefs: [feedbackBundle(42, "demo"), feedbackBundle(7, "other")] } }) });
  return found;
}

/** The words each Batch B variant must actually say, so the sweep above checks that copy and not a fallback. */
const BATCH_B_COPY: Record<string, string> = {
  "PULL_REQUEST/READY pushing the fix": "Pushing the fix to PR #42.",
  "WAIT_FOR_MERGE/WAITING fix pushed": "Pushed the fix to PR #42. Review it and merge it on GitHub; I'll finish this task when it's merged.",
  "WAIT_FOR_MERGE/BLOCKED push failed HEAD_MOVED": "I couldn't push the fix to PR #42: it changed on GitHub since I opened it.",
  "WAIT_FOR_MERGE/BLOCKED push failed PUSH_REFUSED": "I couldn't push the fix to PR #42: GitHub refused the push. I'm still watching the pull request and will finish this task when it's merged.",
  "WAIT_FOR_MERGE/BLOCKED push failed WORKER_OUTDATED": "I couldn't push the fix because this AgentX worker is out of date.",
  "WAIT_FOR_MERGE/BLOCKED push failed undefined": "I couldn't push the fix to PR #42. I'm still watching the pull request and will finish this task when it's merged.",
  [`WAIT_FOR_MERGE/BLOCKED ${WORKFLOW_BLOCK_REASONS.feedbackReviewFailed}`]: `${WORKFLOW_BLOCK_REASONS.feedbackReviewFailed} I'm still watching the pull request and will finish this task when it's merged.`,
  "WAIT_FOR_MERGE/RUNNING feedback review started": "Reviewing the feedback on PR #42 (1 comment). I'll propose a fix here before changing any code.",
  "WAIT_FOR_MERGE/RUNNING feedback review started on several": "Reviewing the feedback on PRs #7 and #42 (1 comment). I'll propose a fix here before changing any code.",
};

describe("workflow Slack messages", () => {
  it("offers the ordinary Owner SendBack control for a current failed E2E round even when ordinary checks passed", () => {
    const roundId = "33333333-3333-4333-8333-333333333333";
    const failed = snapshot("VERIFY", "BLOCKED", {
      checkPolicy,
      e2e: { contractDigest: "1".repeat(64), policyDigest: "2".repeat(64), bundleDigest: "3".repeat(64),
        executionPlanDigest: "4".repeat(64), required: true, currentRoundId: roundId, currentGroupRunIds: [roundId], resultRefs: [],
        failedRound: { status: "FAILED", candidateDigest: candidate.digest, roundId, groupRunIds: [roundId], admissionSha256: "5".repeat(64), evidenceSha256: "6".repeat(64) } },
    });
    const message = workflowMessage({ taskId, workflow: failed })!;
    expect(message.text).toContain("required end-to-end verification failed");
    expect(buttonsOf(message.blocks).map((button) => button.action_id)).toContain("agentx_workflow_send_back");
    expect(() => new StrictSlackWeb({ briefLimit: 1_200 }).post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message })).not.toThrow();
  });

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
    // Every Batch B message went through the checks above with its own words.
    const sweep = new Map(variants().map((variant) => [variant.name, variant]));
    for (const [name, words] of Object.entries(BATCH_B_COPY)) {
      expect(rendered, name).toContain(name);
      const message = workflowMessage({ taskId, workflow: sweep.get(name)!.workflow })!;
      expect(visibleSlackText(message.text), name).toContain(words);
    }
  });

  it("acknowledges each owner decision by what it was, not by the stage alone", () => {
    const full = (phase: string, decision: string) => snapshot("PLAN", "RUNNING", { path: "FULL", reviewPhase: phase, decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 6, decision, actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "r", artifactDigest: "c".repeat(64), at: now }] });
    expect(workflowMessage({ taskId, workflow: full("DESIGN", "APPROVE") })?.text).toBe("Requirements approved. Writing the design next.");
    // The approver is named the same way at every approval gate (0.2.12 live test).
    expect(workflowMessage({ taskId, ownerSlackUserId: "U0123456789", workflow: full("DESIGN", "APPROVE") })?.text).toBe("Requirements approved by <@U0123456789>. Writing the design next.");
    expect(workflowMessage({ taskId, ownerSlackUserId: "U0123456789", workflow: full("IMPLEMENTATION_PLAN", "APPROVE") })?.text).toBe("Design approved by <@U0123456789>. Writing the coding plan next.");
    expect(workflowMessage({ taskId, workflow: full("DESIGN", "REQUEST_CHANGES") })?.text).toBe("Got it. Revising the design with your changes.");
    expect(workflowMessage({ taskId, workflow: snapshot("PLAN", "RUNNING") })?.text).toContain("Working on the coding plan");
    const approved = snapshot("IMPLEMENT", "RUNNING", { checkPolicy, decisions: [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "r", artifactDigest: "c".repeat(64), at: now }] });
    expect(workflowMessage({ taskId, ownerSlackUserId: "U0123456789", workflow: approved })?.text).toBe("Coding plan approved by <@U0123456789>. Writing the code now; then I'll run 2 checks.");
    expect(workflowMessage({ taskId, workflow: snapshot("IMPLEMENT", "RUNNING") })?.text).toBe("Trying the coding step again.");
  });

  it("offers Retry planning and Close task when the planner's answer could not be read as a plan", () => {
    const message = workflowMessage({ taskId, workflow: snapshot("PLAN", "BLOCKED", { blockReason: WORKFLOW_BLOCK_REASONS.planUnreadable }) })!;
    // A whole sentence, not the stored phrase tacked on after a full stop.
    expect(message.text).toBe("AgentX couldn't read the coding plan it wrote.");
    expect(message.text).not.toContain(WORKFLOW_BLOCK_REASONS.planUnreadable);
    const full = snapshot("PLAN", "BLOCKED", { path: "FULL", reviewPhase: "DESIGN", blockReason: WORKFLOW_BLOCK_REASONS.planUnreadable });
    expect(workflowMessage({ taskId, workflow: full })!.text).toBe("AgentX couldn't read the design it wrote.");
    const actions = (message.blocks.find((block) => (block as { type: string }).type === "actions") as { elements: Array<{ action_id: string; text: { text: string } }> }).elements;
    expect(actions.map((button) => [button.action_id, button.text.text])).toEqual([["agentx_workflow_retry_plan", "Retry planning"], ["agentx_workflow_close", "Close task"]]);
  });

  it("lists introduced findings briefly with Resolve findings, Retry and Close (no Send back), and keeps older issues advisory", () => {
    const findings = snapshot("REVIEW", "BLOCKED", { reviews: [
      { operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "Drops the last line <!channel>", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: now },
      { operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [{ text: "Old logger prints emails", origin: "PRE_EXISTING" }], readOnly: true, recordedAt: now },
    ] });
    const message = workflowMessage({ taskId, workflow: findings, findingsUrl: "https://agentx.example.test/review/x/task#findings" })!;
    expect(message.text).toContain("Reviews found 1 issue in this change.");
    expect(message.text).toContain("Drops the last line &lt;!channel&gt; (src/parse.ts:40)");
    expect(message.text).toContain("1 older issue was noted but doesn't block.");
    expect(JSON.stringify(message.blocks)).toMatch(/agentx_workflow_resolve_findings[\s\S]*agentx_workflow_retry_reviews[\s\S]*agentx_workflow_close/);
    expect(JSON.stringify(message.blocks)).not.toContain("agentx_workflow_send_back");
  });

  describe("the review-blocked card's buttons (Resolve findings)", () => {
    const finding = (text: string, extra: Record<string, unknown> = {}) => ({ text, origin: "INTRODUCED", ...extra });
    const blocked = (reviews: unknown[], extra: Record<string, unknown> = {}) => snapshot("REVIEW", "BLOCKED", { reviews, ...extra });

    it("offers Resolve findings (primary), then Retry reviews and Close task, with the exact revision and code it was offered at", () => {
      const workflow = blocked([review("CRITIC", "FINDINGS", { findings: [finding("Drops the last line")] }), review("SECURITY", "PASS")]);
      const buttons = buttonsOf(workflowMessage({ taskId, workflow })!.blocks);
      expect(buttons.map((button) => [button.action_id, button.text.text, button.style])).toEqual([
        ["agentx_workflow_resolve_findings", "Resolve findings", "primary"],
        ["agentx_workflow_retry_reviews", "Retry reviews", undefined],
        ["agentx_workflow_close", "Close task", undefined],
      ]);
      expect(JSON.parse(buttons[0]!.value)).toEqual({ taskId, revision: workflow.revision, candidateDigest: candidate.digest });
      expect(WORKFLOW_ACTION_IDS.has("agentx_workflow_resolve_findings")).toBe(true);
    });

    it("keeps Send back only when more than 20 findings are open, which one answer cannot resolve", () => {
      const twenty = Array.from({ length: 20 }, (_, index) => finding(`Problem ${index}`));
      const exactly = blocked([review("CRITIC", "FINDINGS", { findings: twenty }), review("SECURITY", "PASS")]);
      expect(buttonsOf(workflowMessage({ taskId, workflow: exactly })!.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_resolve_findings", "agentx_workflow_retry_reviews", "agentx_workflow_close"]);
      const over = blocked([review("CRITIC", "FINDINGS", { findings: twenty }), review("SECURITY", "FINDINGS", { findings: [finding("One more")] })]);
      expect(buttonsOf(workflowMessage({ taskId, workflow: over })!.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_reviews", "agentx_workflow_close"]);
      // The same finding in both reviews, or the same one twice, is one finding to resolve.
      const same = blocked([review("CRITIC", "FINDINGS", { findings: [finding("Same"), finding("Same")] }), review("SECURITY", "PASS")]);
      expect(workflowMessage({ taskId, workflow: same })!.text).toContain("Reviews found 1 issue in this change.");
    });

    it("leaves an accepted finding off the list, and offers no Resolve findings once every finding is accepted", () => {
      const accepted = { candidateDigest: candidate.digest, role: "CRITIC", fingerprint: workflowFindingFingerprint("CRITIC", { text: "Drops the last line" }), text: "Drops the last line", reason: "Known", actorId: "a".repeat(64), at: now };
      const reviews = [review("CRITIC", "FINDINGS", { findings: [finding("Drops the last line"), finding("Leaks a handle")] }), review("SECURITY", "PASS")];
      const some = workflowMessage({ taskId, workflow: blocked(reviews, { acceptedFindings: [accepted] }) })!;
      expect(some.text).toContain("Reviews found 1 issue in this change.");
      expect(some.text).toContain("Leaks a handle");
      expect(some.text).not.toContain("Drops the last line");
      const all = workflowMessage({ taskId, workflow: blocked([review("CRITIC", "FINDINGS", { findings: [finding("Drops the last line")] }), review("SECURITY", "UNKNOWN", { failureReason: "TIMEOUT" })],
        { acceptedFindings: [accepted] }) })!;
      expect(all.text).toMatch(/review couldn't finish/);
      expect(buttonsOf(all.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_retry_reviews", "agentx_workflow_close"]);
    });
  });

  it("leaves advisory review notes off the list of issues that block", () => {
    const findings = snapshot("REVIEW", "BLOCKED", { reviews: [
      { operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [
        { text: "Drops the last line", origin: "INTRODUCED" }, { text: "The plan's long timeout looks unwise", origin: "INTRODUCED", advisory: true }], readOnly: true, recordedAt: now },
      { operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "Token is logged", origin: "INTRODUCED", advisory: true }], readOnly: true, recordedAt: now },
    ] });
    const message = workflowMessage({ taskId, workflow: findings })!;
    // A code-review advisory note is left off; a security finding is listed whatever its flag says.
    expect(message.text).toContain("Reviews found 2 issues in this change.");
    expect(message.text).toContain("[code] Drops the last line");
    expect(message.text).toContain("[security] Token is logged");
    expect(message.text).not.toContain("long timeout");
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

  it("a failed feedback review says AgentX is still watching the pull request", () => {
    const watching = "I'm still watching the pull request and will finish this task when it's merged.";
    const failed = "I couldn't review the feedback on the pull request, so I have nothing to propose from it.";
    expect(WORKFLOW_BLOCK_REASONS.feedbackReviewFailed).toBe(failed);
    const reasons = [WORKFLOW_BLOCK_REASONS.feedbackReviewFailed, "PR feedback review operation ended failed", "PR feedback review operation ended interrupted",
      "PR feedback review operation ended cancelled", "PR feedback review report was invalid, incomplete, or stale"];
    for (const blockReason of reasons) {
      const message = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "BLOCKED", { blockReason }) })!;
      expect(message.text, blockReason).toBe(`${failed} ${watching}`);
      expect(message.text, blockReason).not.toMatch(BANNED);
      expect(message.text, blockReason).not.toContain("stopped following");
      expect(buttonsOf(message.blocks).map((button) => button.action_id), blockReason).toEqual(["agentx_workflow_close"]);
    }
    // A failed push says so, then that the pull request is still watched.
    const pushed = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "BLOCKED", { blockReason: WORKFLOW_BLOCK_REASONS.pullRequestUpdateFailed }) })!;
    expect(pushed.text).toBe(`I couldn't push the fix to the pull request. ${watching}`);
    expect(pushed.text).not.toMatch(BANNED);
    // Any other reason is still not "stopped following": the merge is still tracked.
    const other = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "BLOCKED", { blockReason: "some internal FAILED digest text" }) })!;
    expect(other.text).toBe(`Something went wrong on AgentX's side. ${watching}`);
  });

  it("a changed pull request still says AgentX stopped following it", () => {
    const message = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "BLOCKED", { blockReason: WORKFLOW_BLOCK_REASONS.pullRequestChanged }) })!;
    expect(message.text).toBe(`I stopped following the pull request. ${WORKFLOW_BLOCK_REASONS.pullRequestChanged}`);
    expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_close"]);
  });

  it("shows a task view's unverifiable document plainly with Close, while a stored workflow is never blocked at approval", () => {
    const waiting = snapshot("PLAN_REVIEW", "WAITING");
    const view = WorkflowSnapshotViewSchema.parse({ ...waiting, state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.documentUnverified });
    expect(() => WorkflowSnapshotSchema.parse(view)).toThrow(/cannot be blocked/);
    const message = workflowMessage({ taskId, workflow: view })!;
    expect(message.text).toBe("The saved coding plan couldn't be checked, so I stopped. Close this task and start again.");
    expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_close"]);
  });

  it("acknowledges PR feedback the owner sent back or dismissed, and says the fix was pushed to the same pull request", () => {
    const feedbackDecision = (decision: string, workflowRevision: number) => ({ schemaVersion: 1, requestId: "44444444-4444-4444-8444-444444444444", workflowRevision, decision,
      actorId: "a".repeat(64), actorRole: "TASK_OWNER", reviewDigest: "f".repeat(64), proposalDigest: "f".repeat(64), bundleDigests: ["f".repeat(64)],
      selectedFindingIds: decision === "APPROVE" ? ["finding-1"] : [], selectedCommentIds: decision === "APPROVE" ? ["comment-1"] : [],
      candidates: decision === "APPROVE" ? [{ repositoryId: "demo", number: 42, headSha: "d".repeat(40), candidateDigest: candidate.digest, commentSetDigest: "f".repeat(64), bundleDigest: "f".repeat(64) }] : [],
      ...(decision === "APPROVE" ? {} : { ownerNote: "Not now." }), at: now });
    const waiting = (decision: string, workflowRevision: number) => snapshot("WAIT_FOR_MERGE", "WAITING", { feedbackDecisions: [feedbackDecision(decision, workflowRevision)] });
    expect(workflowMessage({ taskId, workflow: waiting("REQUEST_CHANGES", 6) })!.text).toBe("Got it. I saved your note for the next round of PR feedback; the pull request stays as it is.");
    expect(workflowMessage({ taskId, workflow: waiting("DISMISS", 6) })!.text).toBe("PR feedback dismissed. The pull request stays as it is.");
    expect(workflowMessageKey(waiting("DISMISS", 6))).toBe("revision:7");
    // An older answer is not repeated: the step says the pull request again.
    expect(workflowMessage({ taskId, workflow: waiting("DISMISS", 3) })!.text).toMatch(/^Draft pull request opened: /);
    // An approval alone pushed nothing yet; once the fix is pushed to the pull request, that is said.
    expect(workflowMessage({ taskId, workflow: waiting("APPROVE", 3) })!.text).toMatch(/^Draft pull request opened: /);
    expect(workflowMessage({ taskId, workflow: { ...waiting("APPROVE", 3), pullRequestUpdatedAt: now } })!.text)
      .toBe("Pushed the fix to <https://github.com/example/demo/pull/42|PR #42>. Review it and merge it on GitHub; I'll finish this task when it's merged.");
    // The same pull request with a new head is a new thing to say.
    const opened = snapshot("WAIT_FOR_MERGE", "WAITING");
    const republished = { ...opened, pullRequests: opened.pullRequests!.map((pullRequest) => ({ ...pullRequest, headSha: "9".repeat(40) })) };
    expect(workflowMessageKey(republished)).not.toBe(workflowMessageKey(opened));
    expect(workflowMessageKey({ ...opened, revision: 9 })).toBe(workflowMessageKey(opened));
    // Opening the pull requests is said once per checked code, however many repositories it takes.
    expect(workflowMessageKey(snapshot("PULL_REQUEST", "READY"))).toBe(workflowMessageKey({ ...snapshot("PULL_REQUEST", "READY"), revision: 12 }));
  });

  it("says it is reviewing PR feedback when a feedback review starts", () => {
    const digest = (seed: string) => seed.repeat(64).slice(0, 64);
    const comment = (id: string, author: string, bodySeed: string) => ({ id, kind: "DISCUSSION", url: `https://github.com/example/demo/pull/3#issuecomment-${id}`, author,
      updatedAt: now, bodyDigest: digest(bodySeed), bodyBytes: 20 });
    const bundle = (number: number, comments: Array<ReturnType<typeof comment>>) => ({ schemaVersion: 1, taskId, repositoryId: number === 3 ? "demo" : "other", number, headSha: "d".repeat(40),
      candidateDigest: candidate.digest, commentSetDigest: digest("e"), producer: "p", version: "1", recordedAt: now, comments, sha256: digest("f"), objectKey: `private/o/w/feedback-${digest("f")}.json` });
    const collecting = (...bundles: Array<ReturnType<typeof bundle>>) => snapshot("WAIT_FOR_MERGE", "RUNNING",
      { feedbackReview: { status: "COLLECTING", bundleRefs: bundles, threadObservations: [] } });
    const said = (workflow: WorkflowSnapshot) => visibleSlackText(workflowMessage({ taskId, workflow })!.text);
    const tail = "I'll propose a fix here before changing any code.";
    // PR #3 is not one the task opened, so it is named without a link.
    expect(said(collecting(bundle(3, [comment("1", "mia", "a")])))).toBe(`Reviewing the feedback on PR #3 (1 comment). ${tail}`);
    expect(said(collecting(bundle(3, [comment("1", "mia", "a"), comment("2", "raj", "b")])))).toBe(`Reviewing the feedback on PR #3 (2 comments). ${tail}`);
    // The same author posting the same text again counts once; the same text from someone else is another comment.
    expect(said(collecting(bundle(3, [comment("1", "mia", "a"), comment("2", "mia", "a")])))).toBe(`Reviewing the feedback on PR #3 (1 comment). ${tail}`);
    expect(said(collecting(bundle(3, [comment("1", "mia", "a"), comment("2", "raj", "a")])))).toBe(`Reviewing the feedback on PR #3 (2 comments). ${tail}`);
    // Several pull requests are named in order, and the count spans all of them.
    expect(said(collecting(bundle(4, [comment("1", "mia", "a")]), bundle(3, [comment("2", "mia", "a"), comment("3", "raj", "b")]))))
      .toBe(`Reviewing the feedback on PRs #3 and #4 (2 comments). ${tail}`);
    expect(said(collecting(bundle(4, [comment("1", "mia", "a")]), bundle(3, [comment("2", "mia", "b"), comment("3", "raj", "b")]))))
      .toBe(`Reviewing the feedback on PRs #3 and #4 (3 comments). ${tail}`);
    // A pull request the task opened is linked; there are no buttons, and the text stays clear of the banned words.
    const opened = snapshot("WAIT_FOR_MERGE", "RUNNING", { feedbackReview: { status: "COLLECTING", threadObservations: [],
      bundleRefs: [{ ...bundle(42, [comment("1", "mia", "a")]), repositoryId: "demo" }] } });
    const message = workflowMessage({ taskId, workflow: opened })!;
    expect(message.text).toBe(`Reviewing the feedback on <https://github.com/example/demo/pull/42|PR #42> (1 comment). ${tail}`);
    expect(message.text).not.toMatch(BANNED);
    expect(buttonsOf(message.blocks)).toEqual([]);
    // Said once for the review's revision, and not at all for other running steps of this stage.
    expect(workflowMessageKey(opened)).toBe("revision:7");
    expect(workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "RUNNING") })).toBeUndefined();
    // Once the owner's approval is bound, the review is no longer what is happening.
    const approval = { taskId, requestId: "44444444-4444-4444-8444-444444444444", ownerId: "a".repeat(64), decisionWorkflowRevision: 6, activeWorkflowRevision: 7, reviewDigest: digest("f"),
      proposalDigest: digest("f"), bundleDigests: [digest("f")], candidateDigest: candidate.digest, selectedFindingIds: ["finding-1"], selectedCommentIds: ["1"] };
    expect(workflowMessage({ taskId, workflow: { ...opened, feedbackDispatchApproval: approval } })).toBeUndefined();
  });

  it("offers Close task on the draft pull request post, so an owner can close the task while its pull request is open", () => {
    const message = workflowMessage({ taskId, workflow: snapshot("WAIT_FOR_MERGE", "WAITING") })!;
    expect(message.text).toMatch(/^Draft pull request opened: /);
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

  it("links the task page when the document could not be shown, never telling the owner to ask an admin", () => {
    const pageUrl = "https://agentx.example.test/review/task-1/task";
    const message = workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING"), taskPageUrl: pageUrl })!;
    expect(message.text).toContain(`I couldn't show the plan summary here. <${pageUrl}|Open the task page to read the plan>`);
    expect(message.text).not.toContain("ask an AgentX admin");
    // The decision buttons are exactly what they are with a linked document.
    expect(buttonsOf(message.blocks).map((button) => [button.action_id, button.text.text])).toEqual([
      ["agentx_workflow_approve", "Approve coding plan"], ["agentx_workflow_changes", "Request changes"], ["agentx_workflow_close", "Close task"]]);
    const structured = workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING"), taskPageUrl: pageUrl, structured: { claims: ["a", "b", "c"], claimCount: 3, decisionCount: 0, tiny: true } })!;
    expect(structured.text).toContain(`<${pageUrl}|Open the task page to read the plan>`);
    expect(structured.text).not.toContain("ask an AgentX admin");
  });

  describe("the card for a structured document", () => {
    const page = "https://agentx.example.test/review/x/task";
    const url = planReviewLink(page, snapshot("PLAN_REVIEW", "WAITING"), 1);
    // In the text Slack reads `&` as `&amp;`; the button's address is the plain one.
    const linkInText = url.replaceAll("&", "&amp;");
    const claims = ["Payments that time out are retried.", "A payment is never charged twice.", "Failed retries are logged."];
    const cardOf = (structured: Record<string, unknown>, extra: Record<string, unknown> = {}) => workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING"),
      documentLink: { url }, taskPageUrl: page, structured: { claims, claimCount: 7, decisionCount: 2, tiny: false, ...structured }, ...extra })!;

    it("links the task page at the document and version, never a version-only link", () => {
      expect(url).toBe(`${page}?doc=coding-plan&from=1#coding-plan`);
      expect(planReviewLink(page, snapshot("PLAN_REVIEW", "WAITING", { path: "FULL", reviewPhase: "REQUIREMENTS" }), 3)).toBe(`${page}?doc=requirements&from=3#requirements`);
      expect(planReviewLink(page, snapshot("PLAN_REVIEW", "WAITING", { path: "FULL", reviewPhase: "DESIGN" }), 2)).toBe(`${page}?doc=design&from=2#design`);
    });

    it("shows the brief, the top claims, how many more, the decisions note and the link, in that order", () => {
      const message = cardOf({}, { newReplies: 2 });
      expect(message.text).toBe([
        "*Coding plan v1 is ready for your approval.* No code has changed yet.",
        "> Payments that time out are retried.", "> A payment is never charged twice.", "> Failed retries are logged.",
        "And 4 more claims.",
        "Approve here uses AgentX's answers for 2 decisions and includes the open comments (up to 25) from the task page.",
        "2 thread replies since the last step will be included.",
        `<${linkInText}|Open the full coding plan>`,
      ].join("\n"));
    });

    it("leaves out the 'more claims' and decisions lines when there are none, and says one of each in the singular", () => {
      const none = cardOf({ claims: claims.slice(0, 2), claimCount: 2, decisionCount: 0, tiny: true }).text;
      expect(none).not.toMatch(/more claim|decision/);
      expect(cardOf({ claimCount: 4, decisionCount: 1 }).text).toContain("And 1 more claim.\nApprove here uses AgentX's answers for 1 decision and includes the open comments (up to 25) from the task page.\n");
    });

    it("the card says Approve uses AgentX's answers and includes open comments", () => {
      expect(cardOf({ decisionCount: 3 }).text).toContain("\nApprove here uses AgentX's answers for 3 decisions and includes the open comments (up to 25) from the task page.\n");
      // No decisions, and not a tiny plan: the comments are still said.
      expect(cardOf({ decisionCount: 0 }).text).toContain("\nApprove here includes the open comments (up to 25) from the task page.\n");
      expect(cardOf({ decisionCount: 0 }).text).not.toContain("recommended");
    });

    it("the answered-comments line", () => {
      const text = cardOf({}, { commentAnswers: { answered: 2, total: 3, fromVersion: 1 } }).text;
      expect(text).toContain("\nAgentX answered 2 of 3 comments from v1.\n");
      expect(cardOf({}, { commentAnswers: { answered: 1, total: 1, fromVersion: 2 } }).text).toContain("AgentX answered 1 of 1 comment from v2.");
      expect(cardOf({}).text).not.toContain("AgentX answered");
    });

    it("after an Approve with comments, one line says AgentX replied, linked to the first reply on the earlier document's page", () => {
      const approvedOn = (extra: Record<string, unknown> = {}) => ({ document: "design", commentId: "c0ffee00-0000-4000-8000-000000000001", allOwners: true, ...extra });
      const card = (answers: Record<string, unknown>) => cardOf({}, { commentAnswers: { answered: 2, total: 2, fromVersion: 0, approvedOn: approvedOn(), ...answers } }).text;
      const link = `${page}?doc=design#comment-c0ffee00-0000-4000-8000-000000000001`;
      expect(card({})).toContain(`\n<${link}|AgentX replied to your 2 comments on the design.>\n`);
      expect(card({ answered: 1, total: 1 })).toContain("|AgentX replied to your 1 comment on the design.>");
      // Some comments left unanswered, comments by teammates, and another document.
      expect(card({ answered: 1 })).toContain("|AgentX replied to 1 of your 2 comments on the design.>");
      expect(card({ approvedOn: approvedOn({ allOwners: false }) })).toContain("|AgentX replied to 2 comments on the design.>");
      expect(card({ approvedOn: approvedOn({ document: "requirements" }) })).toContain(`<${page}?doc=requirements#comment-c0ffee00-0000-4000-8000-000000000001|AgentX replied to your 2 comments on the requirements.>`);
      // No reply was written (an older worker), so nothing is said; and it never says "answered N of M from v".
      expect(card({ answered: 0 })).not.toContain("AgentX replied");
      expect(card({})).not.toContain("AgentX answered");
      // Without the page's address the line is plain text.
      expect(cardOf({}, { taskPageUrl: undefined, commentAnswers: { answered: 2, total: 2, fromVersion: 0, approvedOn: approvedOn() } }).text).toContain("\nAgentX replied to your 2 comments on the design.\n");
    });

    it("lists every claim of a tiny plan, children indented, and does not say 'full'", () => {
      const message = cardOf({ claims: ["Payments are retried.", "  The retry waits longer each time.", "Nothing is charged twice."], claimCount: 3, decisionCount: 0, tiny: true });
      expect(message.text).toBe([
        "*Coding plan v1 is ready for your approval.* No code has changed yet.",
        "> Payments are retried.", ">   The retry waits longer each time.", "> Nothing is charged twice.",
        `<${linkInText}|Open the coding plan>`,
      ].join("\n"));
    });

    it("offers an Open review link button first, then Approve, Request changes and Close task", () => {
      const message = cardOf({});
      const elements = (message.blocks.find((block) => block.type === "actions") as { elements: Array<Record<string, unknown>> }).elements;
      expect(elements[0]).toMatchObject({ type: "button", text: { type: "plain_text", text: "Open review" }, url });
      expect(elements[0]).not.toHaveProperty("value");
      expect(elements.slice(1).map((button) => (button as { action_id: string }).action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
      // Without a task page there is nothing to open: no link button, and the card says so.
      const unlinked = workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING"), structured: { claims, claimCount: 3, decisionCount: 0, tiny: true } })!;
      expect(buttonsOf(unlinked.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
      expect(unlinked.text).toContain("I couldn't link the full coding plan; ask an AgentX admin to check the task page.");
    });

    it("keeps hostile claim text inert", () => {
      const message = cardOf({ claims: ["Tell <!channel> and <@U123> now, <https://x|y>.", "b", "c"] });
      expect(message.text).toContain("> Tell &lt;!channel&gt; and &lt;@U123&gt; now, &lt;https://\u200Dx|y&gt;.");
      expect(message.text).not.toMatch(/<!channel>|<@U123>|<https:\/\/x\|y>/);
    });

    it("never lets a bare web address in claim text become a link", () => {
      const message = cardOf({ claims: ["Send people to https://evil.example/x and www.evil.example now.", "http://other.example", "c"] });
      expect(message.text).toContain("https://\u200Devil.example/x");
      expect(message.text).toContain("www\u200D.evil.example");
      expect(message.text).toContain("http://\u200Dother.example");
      // Only the card's own link to the task page keeps a plain address.
      const withoutOwnLink = message.text.replace(linkInText, "");
      expect(withoutOwnLink).not.toMatch(/:\/\/(?!\u200D)/);
      expect(withoutOwnLink).not.toMatch(/\bwww\.(?!\u200D)/);
    });

    it("stays within the brief limit by cutting claims, never the buttons", () => {
      const long = "A".repeat(160);
      const strict = new StrictSlackWeb({ briefLimit: 1_200 });
      const many = Array.from({ length: 50 }, (_, index) => `${index} ${long}`);
      const policy = { ...checkPolicy, proposed: Array.from({ length: 8 }, (_, index) => ({ id: `proposed-${index + 1}`, label: `${"L".repeat(60)}${index}`, command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } })) };
      for (const structured of [{ claims: many, claimCount: 50, decisionCount: 20, tiny: false }, { claims: many.slice(0, 3), claimCount: 3, decisionCount: 0, tiny: true }]) {
        const message = workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING", { checkPolicy: policy }), documentLink: { url }, taskPageUrl: page, newReplies: 12, structured })!;
        expect(visibleSlackText(message.text).length).toBeLessThanOrEqual(1_200);
        expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_open_review", "agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
        expect(message.text).toContain("Open the");
        // Claims are cut, not all dropped: the first is still there.
        expect(message.text).toMatch(/\n> 0 A+/);
        expect(() => strict.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message })).not.toThrow();
      }
    });

    it("leaves a legacy Markdown card exactly as it was", () => {
      const message = workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING"), documentLink: { url: "https://acme.slack.com/docs/T1/F1" }, documentSummary: ["Goal: add <greet>."], newReplies: 1 })!;
      expect(message.text).toBe("*Coding plan v1 is ready for your approval.* No code has changed yet.\n> Goal: add &lt;greet&gt;.\n1 thread reply since the last step will be included.\n<https://acme.slack.com/docs/T1/F1|Read the full coding plan>");
      expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_approve", "agentx_workflow_changes", "agentx_workflow_close"]);
    });
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

  it("says a review-only task had no automated check, never that checks passed", () => {
    const reviewOnly = (stage: string, state: string) => {
      const base = snapshot(stage, state, { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } });
      return WorkflowSnapshotSchema.parse({ ...base, verification: { ...base.verification!, results: [], reviewOnly: true } });
    };
    expect(workflowMessage({ taskId, workflow: reviewOnly("REVIEW", "WAITING") })!.text).toBe("No automated check applied. Starting the code and security reviews.");
    expect(workflowMessage({ taskId, workflow: reviewOnly("REVIEW", "RUNNING") })!.text).toBe("No automated check applied. Code and security reviews are running on the current code.");
    expect(workflowMessage({ taskId, workflow: reviewOnly("PULL_REQUEST", "READY") })!.text).toBe("Reviews passed (no automated check applied). Opening a draft pull request.");
    expect(workflowMessage({ taskId, workflow: { ...reviewOnly("REVIEW", "BLOCKED"), blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE } })!.text).toMatch(/^No automated check applied, and the reviews couldn't finish\./u);
    const regressed = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] }, verification: undefined, blockReason: WORKFLOW_BLOCK_REASONS.regressionFound }) })!;
    expect(buttonsOf(regressed.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_send_back", "agentx_workflow_close"]);
    expect(regressed.text).toBe("A test that passed before this change fails now. Send it back to coding, or close the task. Nothing was sent to GitHub.");
    const named = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] }, verification: undefined,
      blockReason: WORKFLOW_BLOCK_REASONS.regressionFound, regressedChecks: ["npm test <@U123>", "npx vitest run tests/retry.test.ts"] }) })!;
    expect(named.text).toBe("These tests passed before this change and fail now: npm test &lt;@U123&gt;, npx vitest run tests/retry.test.ts. Send it back to coding, or close the task. Nothing was sent to GitHub.");
    for (const [stage, state] of [["REVIEW", "WAITING"], ["REVIEW", "RUNNING"], ["PULL_REQUEST", "READY"]] as const) {
      expect(workflowMessage({ taskId, workflow: reviewOnly(stage, state) })!.text).not.toMatch(/checks? passed|No checks ran|Configure/u);
    }
  });

  it("words a review-only change whose code changed before publishing without a check rerun it can't do", () => {
    const base = snapshot("PULL_REQUEST", "READY", { checkPolicy: { required: [], optional: [], selectedOptionalIds: [] } });
    const reviewOnly = WorkflowSnapshotSchema.parse({ ...base, verification: { ...base.verification!, results: [], reviewOnly: true } });
    const message = workflowMessage({ taskId, workflow: reviewOnly, publishFailure: { category: "publication_failed", codeChanged: true } })!;
    expect(message.text).toBe("The code changed after its reviews passed, so I didn't open the pull request. Send it back to coding, or close the task.");
    expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_send_back", "agentx_workflow_close"]);
  });

  it("says no checks ran without claiming the project has none", () => {
    expect(plainBlockReason(WORKFLOW_BLOCK_REASONS.noChecksConfigured)).toBe("AgentX ran none of this task's checks on the final code. Choose checks and retry, or close the task.");
    // A task blocked before this wording changed still reads plainly.
    expect(plainBlockReason("No checks ran: this project has no required checks and the task selected no optional checks. Configure or select at least one check, then retry."))
      .toBe("AgentX ran none of this task's checks on the final code. Choose checks and retry, or close the task.");
  });

  it("says when a failed check's program is not installed on the worker", () => {
    const proposed = { id: "proposed-1", label: "Cargo tests", command: { cwd: "repo/demo", executable: "cargo", args: ["test"], timeoutSeconds: 60 } };
    const message = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy: { ...checkPolicy, proposed: [proposed] },
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }, { checkId: "proposed-1", status: "FAILED", programNotFound: true }] } }) })!;
    expect(message.text).toBe("These checks couldn't run because the check itself is broken: Cargo tests. cargo is not installed on the AgentX worker. Untick them with Choose checks and retry, or close the task.");
  });

  describe("checks that could not run", () => {
    const proposed = (id: string, label: string, executable: string) => ({ id, label, command: { cwd: "repo/demo", executable, args: ["x"], timeoutSeconds: 60 } });
    const policy = { ...checkPolicy, proposed: [proposed("proposed-1", "Cargo tests", "cargo"), proposed("proposed-2", "Script check", "python3")] };
    const withResults = (results: Array<Record<string, unknown>>) => snapshot("VERIFY", "BLOCKED", { checkPolicy: policy,
      blockReason: results.every((result) => result.status !== "FAILED" || result.broken === true) ? WORKFLOW_BLOCK_REASONS.checksBroken : "candidate checks failed or have unknown results",
      verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results } });

    it("says the check itself is broken, with no Send back, when every failed check could not run", () => {
      const message = workflowMessage({ taskId, workflow: withResults([{ checkId: "required-1", status: "PASS" }, { checkId: "proposed-1", status: "FAILED", broken: true }, { checkId: "proposed-2", status: "FAILED", broken: true }]) })!;
      expect(message.text).toBe("These checks couldn't run because the check itself is broken: Cargo tests, Script check. Untick them with Choose checks and retry, or close the task.");
      expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
    });

    it("keeps the not installed note for a program the worker could not start", () => {
      const message = workflowMessage({ taskId, workflow: withResults([{ checkId: "required-1", status: "PASS" }, { checkId: "proposed-1", status: "FAILED", programNotFound: true, broken: true }]) })!;
      expect(message.text).toBe("These checks couldn't run because the check itself is broken: Cargo tests. cargo is not installed on the AgentX worker. Untick them with Choose checks and retry, or close the task.");
      expect(buttonsOf(message.blocks).map((button) => button.action_id)).not.toContain("agentx_workflow_send_back");
    });

    it("tells a project admin to fix a broken required check, which cannot be unticked", () => {
      const only = workflowMessage({ taskId, workflow: withResults([{ checkId: "required-1", status: "FAILED", broken: true }, { checkId: "proposed-1", status: "PASS" }]) })!;
      expect(only.text).toBe("npm test is a project check and couldn't run; ask a project admin to fix it, or close the task.");
      expect(only.text).not.toMatch(/[Uu]ntick/u);
      expect(buttonsOf(only.blocks).map((button) => button.action_id)).not.toContain("agentx_workflow_send_back");
      // Unticking advice stays for the checks that can be unticked.
      const mixed = workflowMessage({ taskId, workflow: withResults([{ checkId: "required-1", status: "FAILED", broken: true }, { checkId: "proposed-1", status: "FAILED", broken: true }]) })!;
      expect(mixed.text).toBe("These checks couldn't run because the check itself is broken: Cargo tests. Untick them with Choose checks and retry, or close the task. npm test is a project check and couldn't run; ask a project admin to fix it, or close the task.");
      // A real failure beside a broken required check: Send back stays, and the broken one is named with the right advice.
      const real = workflowMessage({ taskId, workflow: withResults([{ checkId: "required-1", status: "FAILED", broken: true }, { checkId: "proposed-1", status: "FAILED" }]) })!;
      expect(real.text).toBe("1 of 2 checks didn't pass: Cargo tests. npm test is a project check and couldn't run; ask a project admin to fix it, or close the task. Nothing was sent to GitHub.");
      expect(buttonsOf(real.blocks).map((button) => button.action_id)).toContain("agentx_workflow_send_back");
    });

    it("offers Send back and names the broken checks when some failures are real", () => {
      const message = workflowMessage({ taskId, workflow: withResults([{ checkId: "required-1", status: "FAILED" }, { checkId: "proposed-1", status: "FAILED", broken: true }]) })!;
      expect(message.text).toBe("1 of 2 checks didn't pass: npm test. Couldn't run because the check itself is broken: Cargo tests. Nothing was sent to GitHub.");
      expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_send_back", "agentx_workflow_retry_checks", "agentx_workflow_close"]);
    });
  });

  it("offers Send back and Close on every other blocked review-only verification, and never says to retry checks it can't run", () => {
    const empty = { required: [], optional: [], selectedOptionalIds: [] };
    for (const reason of [WORKFLOW_BLOCK_REASONS.codeChangedAfterChecks, WORKFLOW_BLOCK_REASONS.repositoriesIncomplete, WORKFLOW_BLOCK_REASONS.startChanged,
      WORKFLOW_BLOCK_REASONS.startUnrecorded, WORKFLOW_BLOCK_REASONS.checksUnconfirmed, WORKFLOW_BLOCK_REASONS.checkReportUnreadable, WORKFLOW_BLOCK_REASONS.checkRunnerFailed]) {
      const message = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy: empty, verification: undefined, blockReason: reason }) })!;
      expect(buttonsOf(message.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_send_back", "agentx_workflow_close"]);
      expect(message.text).toMatch(/Send it back to coding, or close the task\.$/u);
      expect(message.text).not.toMatch(/[Rr]etry|checks again|[Cc]hoose checks|start a new one/u);
    }
    // History rewritten past the task's start can't be fixed by coding again.
    const rewritten = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy: empty, verification: undefined, blockReason: WORKFLOW_HISTORY_REWRITTEN_MESSAGE }) })!;
    expect(buttonsOf(rewritten.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_close"]);
    // A task with checks keeps its retry.
    const checked = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy, verification: undefined, blockReason: WORKFLOW_BLOCK_REASONS.codeChangedAfterChecks }) })!;
    expect(buttonsOf(checked.blocks).map((button) => button.action_id)).toEqual(["agentx_workflow_retry_checks", "agentx_workflow_close"]);
  });

  it("names every button the router answers", () => {
    expect(INTERACTIVITY_ACTION_IDS).toBe(WORKFLOW_ACTION_IDS);
  });

  it("names the approval modal after the document being approved", () => {
    expect(workflowModalCopy(snapshot("PLAN_REVIEW", "WAITING", { path: "FULL", reviewPhase: "REQUIREMENTS", artifacts: [{ ...plan, type: "requirements" }] }), "APPROVE")).toEqual({ title: "Approve requirements", submit: "Approve and continue" });
    expect(workflowModalCopy(snapshot("PLAN_REVIEW", "WAITING"), "APPROVE")).toEqual({ title: "Approve coding plan", submit: "Approve and start coding" });
    expect(workflowModalCopy(snapshot("PLAN_REVIEW", "WAITING"), "REQUEST_CHANGES")).toEqual({ title: "Request changes", submit: "Send changes" });
  });

  it("says on the coding plan's card which checks will run, or that it is review only, or that the proposal could not be read", () => {
    const proposed = [{ id: "proposed-1", label: "Typecheck", command: { cwd: "repo/demo", executable: "npx", args: ["tsc"], timeoutSeconds: 600 } },
      { id: "proposed-2", label: "Unit <tests>", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 } }];
    const card = (policy: Record<string, unknown>, extra: Record<string, unknown> = {}) => workflowMessage({ taskId, documentLink: { url: "https://acme.slack.com/docs/T1/F1" },
      workflow: snapshot("PLAN_REVIEW", "WAITING", { checkPolicy: { required: [], optional: [], selectedOptionalIds: [], ...policy }, ...extra }) })!;
    const lines = (policy: Record<string, unknown>) => card(policy).text.split("\n");
    expect(lines({ required: checkPolicy.required, proposed })).toContain("Checks proposed by AgentX: Typecheck, Unit &lt;tests&gt;; plus 1 project check.");
    expect(lines({ proposed: proposed.slice(0, 1) })).toContain("Checks proposed by AgentX: Typecheck.");
    expect(lines({ required: checkPolicy.required })).toContain("Checks: 1 project check.");
    expect(lines({ noneReason: "Only <!channel> docs change." })).toContain("No automated checks apply: Only &lt;!channel&gt; docs change. Review only.");
    expect(lines({})).toContain("No automated checks apply. Review only.");
    // Optional checks can still be chosen when approving.
    expect(lines({ optional: checkPolicy.optional })).toContain("No automated checks apply. Review only unless you choose an optional check.");
    expect(lines({ optional: checkPolicy.optional, noneReason: "Docs." })).toContain("No automated checks apply: Docs. Review only unless you choose an optional check.");
    // Eight long labels stay on one line within Slack's brief limit, each escaped.
    const many = Array.from({ length: 8 }, (_, index) => ({ id: `proposed-${index + 1}`, label: `<@U1> ${"x".repeat(74)}`, command: proposed[0]!.command }));
    const manyLine = lines({ proposed: many }).find((line) => line.startsWith("Checks proposed by AgentX:"))!;
    expect(manyLine).not.toContain("<@U1>");
    expect(manyLine.length).toBeLessThanOrEqual(400);
    expect(manyLine).toMatch(/and \d+ more\.$/u);
    expect(() => new StrictSlackWeb({ briefLimit: 1_200 }).post({ channel: "C0123456789", threadTs: "1695500000.000001", ...card({ proposed: many }) })).not.toThrow();
    expect(lines({ required: checkPolicy.required, proposalNote: "AgentX could not read the proposed checks" })).toContain("AgentX could not read the proposed checks.");
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    for (const policy of [{ proposed }, { noneReason: "x".repeat(300) }, { proposalNote: "AgentX could not read the proposed checks" }]) {
      expect(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...card(policy) })).not.toThrow();
    }
    // Requirements and design propose no checks, and a task stored without a check policy says nothing new.
    expect(card({ proposed }, { path: "FULL", reviewPhase: "DESIGN", artifacts: [{ ...plan, type: "design" }] }).text).not.toContain("Checks:");
    expect(workflowMessage({ taskId, workflow: snapshot("PLAN_REVIEW", "WAITING") })!.text).not.toMatch(/Checks:|Review only/);
  });

  it("counts proposed checks when coding starts, and offers to retry them after they fail", () => {
    const proposed = [{ id: "proposed-1", label: "Typecheck <x>", command: { cwd: "repo/demo", executable: "npx", args: ["tsc"], timeoutSeconds: 600 } }];
    const policy = { required: checkPolicy.required, optional: [], selectedOptionalIds: [], proposed };
    const decisions = [{ requestId: "33333333-3333-4333-8333-333333333333", workflowRevision: 5, decision: "APPROVE", actorId: "a".repeat(64), actorRole: "TASK_OWNER", reason: "r", artifactDigest: "c".repeat(64), at: now }];
    expect(workflowMessage({ taskId, workflow: snapshot("IMPLEMENT", "RUNNING", { checkPolicy: policy, decisions }) })!.text).toBe("Coding plan approved. Writing the code now; then I'll run 2 checks.");
    const failed = { checkPolicy: { ...policy, required: [] }, verification: { candidateDigest: candidate.digest, producer: "t", environmentId: "w", recordedAt: now, results: [{ checkId: "proposed-1", status: "FAILED" }] } };
    const message = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", failed) })!;
    expect(message.text).toBe("1 of 1 check didn't pass: Typecheck &lt;x&gt;. Nothing was sent to GitHub.");
    expect(buttonsOf(message.blocks).map((button) => button.action_id)).toContain("agentx_workflow_retry_checks");
    const none = workflowMessage({ taskId, workflow: snapshot("VERIFY", "BLOCKED", { checkPolicy: { required: [], optional: [], selectedOptionalIds: [], proposed: [] }, blockReason: WORKFLOW_BLOCK_REASONS.noCheckResults }) })!;
    expect(buttonsOf(none.blocks).map((button) => button.action_id)).not.toContain("agentx_workflow_retry_checks");
  });


  it("says plainly that a PR feedback review failed, why in the owner's words, and offers Retry review", () => {
    const reasons: Array<[string, string]> = [
      ["reviewer output: not valid JSON", "the reviewer's answer couldn't be read"],
      ["reviewer output: not the expected shape", "the reviewer's answer couldn't be read"],
      ["reviewer output: no answer", "the reviewer's answer couldn't be read"],
      ["reviewer output: comment review_comment:123 not accounted for", "the reviewer didn't answer every comment"],
      ["reviewer output: comment review_comment:123 answered more than once", "the reviewer didn't answer every comment"],
      ["reviewer output: finding 2 names a comment or bundle that was not supplied", "the reviewer didn't answer every comment"],
      ["reviewer output: fixProposal.tests is empty", "the reviewer's proposal was incomplete"],
      ["reviewer output: finding 1 field fixProposal.summary is missing or invalid", "the reviewer's proposal was incomplete"],
      ["reviewer output: fixProposal path does not match the code (MODIFY of a missing file or ADD of an existing one)", "the reviewer's proposal was incomplete"],
      ["reviewer output was malformed or did not account for every comment", "the reviewer's answer couldn't be read"],
      // 0.2.8 live test: answers that were read, but broke a rule, are named by the rule, never as unreadable.
      ["reviewer output: fixProposal.fileChanges is empty for an IMPLEMENT finding", "the reviewer's proposal was incomplete"],
      ["reviewer output: finding 1 is uncertain but not left for the owner", "the reviewer was unsure but didn't leave the choice to you"],
      ["reviewer output: finding 1 field confidence is missing or invalid", "the reviewer's answer was missing details"],
      ["reviewer output: finding 3 does not have the required fields", "the reviewer's answer was missing details"],
      ["reviewer output: finding IDs are not unique", "the reviewer's answer was missing details"],
      // 0.2.12: a check change the reviewer proposed broke the rules for checks.
      ["reviewer output: fixProposal.replacementChecks[1] of finding 1: its program must be a plain program name or a ./ path inside the repository", "the reviewer proposed a check change AgentX can't use"],
      ["reviewer output: fixProposal.obsoleteChecks of finding 2 names a required project check", "the reviewer proposed a check change AgentX can't use"],
    ];
    const slack = new StrictSlackWeb({ briefLimit: 1_200 });
    for (const [blockReason, plain] of reasons) {
      const message = feedbackReviewFailedMessage({ taskId, revision: 9, reviewDigest: "f".repeat(64), blockReason,
        pullRequests: [{ number: 42, url: "https://github.com/example/demo/pull/42" }] });
      expect(message.text, blockReason).toBe(`I couldn't review the feedback on <https://github.com/example/demo/pull/42|PR #42>: ${plain}. You can retry the review, or merge or close the pull request on GitHub.`);
      expect(visibleSlackText(message.text), blockReason).not.toMatch(BANNED);
      expect(message.text, blockReason).not.toContain("reviewer output");
      const buttons = buttonsOf(message.blocks);
      expect(buttons.map((button) => [button.action_id, button.text.text])).toEqual([["agentx_feedback_review_retry", "Retry review"]]);
      expect(JSON.parse(String(buttons[0]!.value))).toEqual({ taskId, revision: 9, reviewDigest: "f".repeat(64) });
      expect(buttons.map((button) => button.text.text).join(" ")).not.toMatch(BANNED);
      expect(() => slack.post({ channel: "C0123456789", threadTs: "1695500000.000001", ...message }), blockReason).not.toThrow();
    }
    const several = feedbackReviewFailedMessage({ taskId, revision: 9, reviewDigest: "f".repeat(64), blockReason: "reviewer output: not valid JSON",
      pullRequests: [{ number: 42, url: "https://github.com/example/demo/pull/42" }, { number: 7, url: "" }] });
    expect(several.text).toBe("I couldn't review the feedback on PRs #7 and <https://github.com/example/demo/pull/42|#42>: the reviewer's answer couldn't be read. You can retry the review, or merge or close the pull requests on GitHub.");
    expect(WORKFLOW_ACTION_IDS.has("agentx_feedback_review_retry")).toBe(true);
  });

  it("says plainly that a PR feedback review timed out, was interrupted, or met changed code", () => {
    const cases: Array<[status: "BLOCKED" | "INTERRUPTED", blockReason: string, plain: string]> = [
      ["BLOCKED", "review timed out", "the review timed out"],
      ["INTERRUPTED", "review was cancelled", "the review was stopped before it finished"],
      ["INTERRUPTED", "review was cancelled before it started", "the review was stopped before it finished"],
      ["BLOCKED", "candidate changed during review", "the code changed during the review"],
      ["BLOCKED", "candidate changed before review", "the code changed during the review"],
      ["BLOCKED", "review could not verify the exact candidate", "the review couldn't check the code"],
    ];
    for (const [status, blockReason, plain] of cases) {
      const message = feedbackReviewFailedMessage({ taskId, revision: 9, reviewDigest: "f".repeat(64), status, blockReason,
        pullRequests: [{ number: 42, url: "https://github.com/example/demo/pull/42" }] });
      expect(message.text, blockReason).toBe(`I couldn't review the feedback on <https://github.com/example/demo/pull/42|PR #42>: ${plain}. You can retry the review, or merge or close the pull request on GitHub.`);
      expect(visibleSlackText(message.text), blockReason).not.toMatch(BANNED);
    }
  });
  it("summarises a document in at most three plain lines", () => {
    expect(documentSummaryLines("# Plan\n\n**Goal:** add `greet`.\n\n1. Edit greeting.ts\n2. Add a test\n3. Run checks\n4. Extra")).toEqual(["Goal: add greet.", "1. Edit greeting.ts", "2. Add a test"]);
    expect(documentSummaryLines("```ts\nconst x = 1;\n```\n- [Read](https://example.test) the *spec*\n" + "y".repeat(400), 2)).toEqual(["Read the spec", `${"y".repeat(157)}...`]);
  });
});

describe("splitting a long Slack text into sections (0.2.12 review)", () => {
  it("splits at a line break whenever the text has one, so a later line stays whole", () => {
    const command = "`" + "&lt;".repeat(650) + "`";
    expect(slackSectionTexts(`${"a".repeat(500)}\n${command}`)).toEqual(["a".repeat(500), command]);
  });

  it("never ends a section inside an escaped character or a code span when it must split one long line", () => {
    const entities = slackSectionTexts("&lt;".repeat(1_000));
    expect(entities.join("")).toBe("&lt;".repeat(1_000));
    for (const section of entities) expect(section).toMatch(/^(?:&lt;)+$/);
    const code = slackSectionTexts(`${"x".repeat(2_700)} \`${"y".repeat(200)}\``);
    expect(code.join("")).toBe(`${"x".repeat(2_700)} \`${"y".repeat(200)}\``);
    for (const section of code) expect((section.match(/`/g) ?? []).length % 2).toBe(0);
  });
});
