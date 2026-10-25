// T8 AUTOFIX-WIRING: the real broker flow around T3's policy. A blocked VERIFY or REVIEW is looked at once; Rovara sends code-caused work back by itself (AGENTX decision), retries a
// one-off fault once, and otherwise asks with the details. It never approves, skips, rejects or publishes, and it never wins against the owner's own press.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, createCandidateManifest, workflowAutoActionRequestId, type WorkflowSnapshot,
} from "@agentx/contracts";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { AutoFixAskSchema } from "../../packages/broker/src/developer/autofix-messages.js";
import { autofixConfigFromEnvironment } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { publicWorkflowDecision } from "../../packages/broker/src/aws/developer-tasks.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

type Harness = Awaited<ReturnType<typeof broker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskOf = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; workspaceId: string; autofixAsk?: unknown };
const workflowOf = (harness: Harness, taskId: string) => taskOf(harness, taskId).workflow;
const dispatchRows = (harness: Harness) => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const sweep = (harness: Harness) => harness.handler({ source: "agentx.workflow-dispatch-recovery" });
const codingRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
const reviewRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW");
const outboxPrompt = (harness: Harness, operationId: string) =>
  String((harness.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]?.invocation as { payload: { prompt: string } }).payload.prompt);
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });
const candidateOf = (n: number) => createCandidateManifest([{ repositoryId: "demo", commitSha: n.toString(16).padStart(40, "d"), treeSha: n.toString(16).padStart(40, "b"), baseCommitSha: "e".repeat(40) }]);
const findingsReview = (operationId: string, candidate: ReturnType<typeof candidateOf>) => {
  const now = new Date().toISOString();
  return { result: { workflowCandidateRepositories: candidate.repositories, workflowReviews: [
    { operationId, candidateDigest: candidate.digest, role: "CRITIC", provider: "t", version: "1", status: "FINDINGS", findings: [{ text: "The new parser drops the last line.", origin: "INTRODUCED", severity: "HIGH", file: "src/parse.ts", line: 40 }], readOnly: true, recordedAt: now },
    { operationId, candidateDigest: candidate.digest, role: "SECURITY", provider: "t", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
  ] } };
};
const usagePayload = (costUsd: number | null) => ({ schemaVersion: 1, outcome: "SUCCEEDED", provider: "p", modelId: "m", cacheRetention: "short",
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cacheReadRatio: 0, costUsd });

type Config = { enabled: boolean; capUsd: number; roundEstimateUsd: number; since?: string };
const ON: Config = { enabled: true, capUsd: 15, roundEstimateUsd: 3 };
/** The harness, with the very config object the broker reads (`.config`), so a test can switch automatic fixing on after a block was committed. */
const broker = async (autofix: Config | null = { ...ON }) => Object.assign(await createDeveloperTaskBroker({ brokerExtra: { planSelfCheck: false, ...(autofix === null ? {} : { autofix }) } }), { config: autofix });

/** A Quick task past planning, approved, and in coding; `finishCoding(n)` ends the coding run with the nth candidate and its passing checks. */
async function startCoding(harness: Harness) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = taskOf(harness, taskId);
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  const planning = operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!;
  await harness.events(workspaceId, String(planning.id), [{ type: "usage", payload: usagePayload(0.1) }]);
  await finishPlanningWithMarkdown(harness, workspaceId, String(planning.id), plan);
  const digest = createHash("sha256").update(plan).digest("hex");
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: digest });
  const finishCoding = async (n: number, costUsd: number | "none" = 0.1) => {
    const candidate = candidateOf(n);
    const run = codingRuns(harness, workspaceId).at(-1)!;
    if (costUsd !== "none") await harness.events(workspaceId, String(run.id), [{ type: "usage", payload: usagePayload(costUsd) }]);
    await harness.finish(workspaceId, String(run.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
    return candidate;
  };
  return { taskId, workspaceId, finishCoding };
}

/** Coding ends with the nth candidate and its reviews find an introduced problem: REVIEW blocks. */
async function blockOnFindings(harness: Harness, ctx: Awaited<ReturnType<typeof startCoding>>, n: number, costUsd: number | "none" = 0.1) {
  const candidate = await ctx.finishCoding(n, costUsd);
  const review = reviewRuns(harness, ctx.workspaceId).at(-1)!;
  if (costUsd !== "none") await harness.events(ctx.workspaceId, String(review.id), [{ type: "usage", payload: usagePayload(0.1) }]);
  await harness.finish(ctx.workspaceId, String(review.id), "SUCCEEDED", findingsReview(String(review.id), candidate));
  return candidate;
}

const decisionsOf = (harness: Harness, taskId: string) => workflowOf(harness, taskId).decisions;
const automatic = (harness: Harness, taskId: string) => decisionsOf(harness, taskId).filter((decision) => decision.source === "AUTO_FIX" || decision.source === "AUTO_RETRY");
/** Nothing but the one owner approval of the plan, and Rovara's own send backs and retries, is in the history: no approval, skip, rejection or publication by Rovara. */
const onlyOwnerPlanApprovalAndAutomatic = (harness: Harness, taskId: string) => {
  const decisions = decisionsOf(harness, taskId);
  expect(decisions.filter((decision) => decision.actorRole !== "AGENTX").map((decision) => decision.decision)).toEqual(["APPROVE"]);
  for (const decision of decisions.filter((entry) => entry.actorRole === "AGENTX")) {
    expect(decision).toMatchObject({ decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID });
    expect(decision.artifactDigest).toBeUndefined();
  }
};
const noPublication = (harness: Harness, workspaceId: string) => {
  expect(operations(harness, workspaceId).filter((item) => item.kind === "publish" || item.kind === "maintain")).toEqual([]);
  expect(harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH" && (item.kind === "PUBLISH" || item.kind === "UPDATE"))).toEqual([]);
};

describe("automatic fixing of blocked checks and reviews (AUTOFIX)", () => {
  it("sends review findings back to coding by itself, once, as Rovara, with the owner's usual coding run and only the fixed problem text", async () => {
    const harness = await broker();
    const ctx = await startCoding(harness);
    const first = await blockOnFindings(harness, ctx, 1);
    // The trigger ran in the same invocation as the block: no owner press, one more coding run, running.
    const after = workflowOf(harness, ctx.taskId);
    expect(after).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(2);
    const sentBack = automatic(harness, ctx.taskId);
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0]).toMatchObject({ source: "AUTO_FIX", actorRole: "AGENTX", decision: "REQUEST_CHANGES", auto: { stage: "REVIEW", candidateDigest: first.digest },
      requestId: workflowAutoActionRequestId(ctx.taskId, sentBack[0]!.workflowRevision, "AUTO_FIX") });
    expect(codingRuns(harness, ctx.workspaceId).at(-1)).toMatchObject({ requestId: sentBack[0]!.requestId });
    const prompt = outboxPrompt(harness, String(codingRuns(harness, ctx.workspaceId).at(-1)!.id));
    expect(prompt).toContain("The new parser drops the last line. (src/parse.ts:40)");
    expect(prompt).toContain("Note (written by AgentX, which sent this back by itself)");
    // The look is done: the row is gone, and a sweep does nothing more.
    expect(dispatchRows(harness)).toEqual([]);
    await sweep(harness);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(2);
    onlyOwnerPlanApprovalAndAutomatic(harness, ctx.taskId);
    noPublication(harness, ctx.workspaceId);
    expect(workflowOf(harness, ctx.taskId).stage).not.toBe("PULL_REQUEST");
  });

  it("asks after two automatic send backs, with what Rovara tried and the limit, and acts no further", async () => {
    const harness = await broker();
    const ctx = await startCoding(harness);
    await blockOnFindings(harness, ctx, 1);
    await blockOnFindings(harness, ctx, 2);
    expect(automatic(harness, ctx.taskId)).toHaveLength(2);
    await blockOnFindings(harness, ctx, 3);
    // The third block is not sent back: it is asked about.
    const blocked = workflowOf(harness, ctx.taskId);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(automatic(harness, ctx.taskId)).toHaveLength(2);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(3);
    const ask = AutoFixAskSchema.parse(taskOf(harness, ctx.taskId).autofixAsk);
    expect(ask).toMatchObject({ workflowRevision: blocked.revision, reason: "send-back-limit", codes: ["review-findings"] });
    const card = workflowMessage({ taskId: ctx.taskId, workflow: blocked, autoFix: { ask } })!;
    expect(card.text).toContain("Sent back to coding twice.");
    expect(card.text).toContain("I already sent this back to coding twice for this plan, which is my limit.");
    // The options are the card's own buttons.
    expect(JSON.stringify(card.blocks)).toContain("agentx_workflow_resolve_findings");
    // A card for a task Rovara never touched reads as before.
    expect(workflowMessage({ taskId: ctx.taskId, workflow: blocked })!.text).not.toContain("Rovara");
    // A sweep and a new look change nothing.
    await sweep(harness);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(3);
    onlyOwnerPlanApprovalAndAutomatic(harness, ctx.taskId);
    noPublication(harness, ctx.workspaceId);
  });

  it("retries a one-off review fault once, then asks naming the retry limit", async () => {
    const harness = await broker({ ...ON, enabled: false });
    const ctx = await startCoding(harness);
    const candidate = await ctx.finishCoding(1);
    const review = reviewRuns(harness, ctx.workspaceId).at(-1)!;
    await harness.finish(ctx.workspaceId, String(review.id), "FAILED", { error: "timed out" });
    // The review run ended badly: shape the block as "the reviews could not be started/finished" (a fixed transient reason), then let Rovara look at it.
    const record = taskOf(harness, ctx.taskId);
    const { reviews: _reviews, ...rest } = record.workflow;
    void _reviews;
    const blockAgain = (revisionBump: number) => {
      const current = taskOf(harness, ctx.taskId);
      harness.db.set({ ...current, workflow: { ...rest, ...current.workflow, stage: "REVIEW", state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, revision: current.workflow.revision + revisionBump, candidate } });
      const revision = taskOf(harness, ctx.taskId).workflow.revision;
      harness.db.set((workflowDispatchItem("state", ctx.taskId, revision, "AUTOFIX", candidate.digest, new Date().toISOString()).Put as { Item: Record<string, unknown> }).Item);
    };
    harness.config!.enabled = true;
    blockAgain(1);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(automatic(harness, ctx.taskId)[0]).toMatchObject({ source: "AUTO_RETRY", actorRole: "AGENTX", auto: { stage: "REVIEW", candidateDigest: candidate.digest } });
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "RUNNING" });
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(2);
    // The same fault on the same code again: no second retry, an ask.
    blockAgain(1);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(2);
    expect(AutoFixAskSchema.parse(taskOf(harness, ctx.taskId).autofixAsk)).toMatchObject({ reason: "retry-limit", codes: ["review-not-run"] });
    const card = workflowMessage({ taskId: ctx.taskId, workflow: workflowOf(harness, ctx.taskId), autoFix: { ask: AutoFixAskSchema.parse(taskOf(harness, ctx.taskId).autofixAsk) } })!;
    expect(card.text).toContain("Retried the reviews once.");
    expect(card.text).toContain("which is my limit");
  });

  it("retries blocked checks that could not run on Rovara's side once, with the owner's checks selected, and asks the second time", async () => {
    const harness = await broker({ ...ON, enabled: false });
    const ctx = await startCoding(harness);
    const candidate = await ctx.finishCoding(1);
    // The reviews that started by themselves end, so the workspace is free for the checks.
    await harness.finish(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId).at(-1)!.id), "FAILED", { error: "stopped" });
    const blockChecks = () => {
      const current = taskOf(harness, ctx.taskId);
      harness.db.set({ ...current, workflow: { ...current.workflow, stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checkRunnerFailed, revision: current.workflow.revision + 1, candidate } });
      harness.db.set((workflowDispatchItem("state", ctx.taskId, taskOf(harness, ctx.taskId).workflow.revision, "AUTOFIX", candidate.digest, new Date().toISOString()).Put as { Item: Record<string, unknown> }).Item);
    };
    harness.config!.enabled = true;
    blockChecks();
    await sweep(harness);
    const retry = automatic(harness, ctx.taskId);
    expect(retry).toHaveLength(1);
    expect(retry[0]).toMatchObject({ source: "AUTO_RETRY", actorRole: "AGENTX", auto: { stage: "VERIFY" } });
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    expect(workflowOf(harness, ctx.taskId).verificationRetries?.at(-1)).toMatchObject({ requestId: retry[0]!.requestId, actorId: WORKFLOW_AGENTX_ACTOR_ID, selectedOptionalCheckIds: [] });
    expect(operations(harness, ctx.workspaceId).filter((item) => item.workflowMode === "CHECKS")).toHaveLength(1);
    blockChecks();
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(operations(harness, ctx.workspaceId).filter((item) => item.workflowMode === "CHECKS")).toHaveLength(1);
    expect(AutoFixAskSchema.parse(taskOf(harness, ctx.taskId).autofixAsk)).toMatchObject({ reason: "retry-limit", codes: ["check-runner-failed"] });
    onlyOwnerPlanApprovalAndAutomatic(harness, ctx.taskId);
  });

  it("asks, naming the cap, when the WHOLE task's spend plus one more round would pass it", async () => {
    const harness = await broker();
    const ctx = await startCoding(harness);
    // 14 dollars were spent in the first coding run (not in the last round): 14 + 3 > 15.
    await blockOnFindings(harness, ctx, 1, 14);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(automatic(harness, ctx.taskId)).toHaveLength(0);
    const ask = AutoFixAskSchema.parse(taskOf(harness, ctx.taskId).autofixAsk);
    expect(ask).toMatchObject({ reason: "spend-cap", capUsd: 15 });
    expect(workflowMessage({ taskId: ctx.taskId, workflow: workflowOf(harness, ctx.taskId), autoFix: { ask } })!.text).toContain("over the $15 per-task cap");
  });

  it("counts a run that used a model but reported no cost as one more round, never as free", async () => {
    const harness = await broker({ ...ON, capUsd: 4 });
    const ctx = await startCoding(harness);
    await blockOnFindings(harness, ctx, 1, "none");
    // Planning and coding reported nothing: each counts the 3 dollar estimate, so 6 + 3 is over 4.
    expect(AutoFixAskSchema.parse(taskOf(harness, ctx.taskId).autofixAsk)).toMatchObject({ reason: "spend-cap" });
  });

  it("does nothing when automatic fixing is off: no row, no decision, the task waits for its owner as before", async () => {
    for (const autofix of [null, { ...ON, enabled: false }]) {
      const harness = await broker(autofix);
      const ctx = await startCoding(harness);
      await blockOnFindings(harness, ctx, 1);
      expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
      expect(dispatchRows(harness)).toEqual([]);
      expect(automatic(harness, ctx.taskId)).toEqual([]);
      expect(taskOf(harness, ctx.taskId).autofixAsk).toBeUndefined();
      await sweep(harness);
      expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
    }
    expect(autofixConfigFromEnvironment({ AUTOFIX_ENABLED: "false" }).enabled).toBe(false);
    expect(autofixConfigFromEnvironment({}).enabled).toBe(true);
    expect(autofixConfigFromEnvironment({ AUTOFIX_CAP_USD: "nonsense" }).capUsd).toBeNaN();
    expect(autofixConfigFromEnvironment({}).capUsd).toBe(15);
  });

  it("starts exactly one coding run when the owner presses Send back at the moment the trigger runs, whichever is first", async () => {
    for (const order of ["owner first", "trigger first", "together"] as const) {
      const harness = await broker({ ...ON, enabled: false });
      const ctx = await startCoding(harness);
      const candidate = await blockOnFindings(harness, ctx, 1);
      const blocked = workflowOf(harness, ctx.taskId);
      expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
      harness.config!.enabled = true;
      harness.db.set((workflowDispatchItem("state", ctx.taskId, blocked.revision, "AUTOFIX", candidate.digest, new Date().toISOString()).Put as { Item: Record<string, unknown> }).Item);
      const press = () => harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: blocked.revision, instructions: "Fix what the reviews found." });
      if (order === "owner first") { await press(); await sweep(harness); }
      else if (order === "trigger first") { await sweep(harness); const late = await press(); expect(late.status).not.toBe(200); }
      else await Promise.all([press(), sweep(harness)]);
      expect(codingRuns(harness, ctx.workspaceId), order).toHaveLength(2);
      expect(workflowOf(harness, ctx.taskId), order).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
      expect(decisionsOf(harness, ctx.taskId).filter((decision) => decision.decision === "REQUEST_CHANGES"), order).toHaveLength(1);
    }
  });

  it("is idempotent: the same trigger again on the same block starts nothing new", async () => {
    const harness = await broker();
    const ctx = await startCoding(harness);
    const candidate = await blockOnFindings(harness, ctx, 1);
    const sentBack = automatic(harness, ctx.taskId)[0]!;
    // A recovered dispatch row for the block that was already handled finds the revision moved and the decision made.
    harness.db.set((workflowDispatchItem("state", ctx.taskId, sentBack.workflowRevision, "AUTOFIX", candidate.digest, new Date().toISOString()).Put as { Item: Record<string, unknown> }).Item);
    await sweep(harness);
    await sweep(harness);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(2);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(dispatchRows(harness)).toEqual([]);
  });

  it("looks only at blocks newer than the installation's cut-off, and never acts in a plan review or a pull request", async () => {
    // A block from before the cut-off is left to its owner.
    const old = await broker({ ...ON, since: new Date(Date.now() + 3_600_000).toISOString() });
    const oldCtx = await startCoding(old);
    await blockOnFindings(old, oldCtx, 1);
    expect(workflowOf(old, oldCtx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    expect(automatic(old, oldCtx.taskId)).toEqual([]);
    expect(dispatchRows(old)).toEqual([]);

    // A row for a task that is waiting for its plan's approval, or has its pull request open, changes nothing.
    const harness = await broker();
    const ctx = await startCoding(harness);
    for (const stage of ["PLAN_REVIEW", "PULL_REQUEST"] as const) {
      const current = taskOf(harness, ctx.taskId);
      const state = stage === "PLAN_REVIEW" ? "WAITING" : "BLOCKED";
      harness.db.set({ ...current, workflow: { ...current.workflow, stage, state, ...(state === "BLOCKED" ? { blockReason: "x" } : {}) } });
      const before = JSON.stringify(taskOf(harness, ctx.taskId).workflow);
      harness.db.set((workflowDispatchItem("state", ctx.taskId, current.workflow.revision, "AUTOFIX", "0".repeat(64), new Date().toISOString()).Put as { Item: Record<string, unknown> }).Item);
      await sweep(harness);
      expect(JSON.stringify(taskOf(harness, ctx.taskId).workflow), stage).toBe(before);
      expect(dispatchRows(harness)).toEqual([]);
    }
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
    noPublication(harness, ctx.workspaceId);
  });

  it("shows Rovara's decisions to older clients as an ordinary send back, and Rovara by name in the task's history", async () => {
    const harness = await broker();
    const ctx = await startCoding(harness);
    await blockOnFindings(harness, ctx, 1);
    const stored = automatic(harness, ctx.taskId)[0]!;
    expect(publicWorkflowDecision(stored)).toMatchObject({ source: "SEND_BACK", actorRole: "TASK_OWNER", decision: "REQUEST_CHANGES" });
    expect(publicWorkflowDecision(stored)).not.toHaveProperty("auto");
    const view = await harness.dev(MAYA, "GET", `/v1/dev/tasks/${ctx.taskId}`);
    const decisions = (view.body.task as { workflow: { decisions: Array<Record<string, unknown>> } }).workflow.decisions;
    const shown = decisions.find((decision) => decision.requestId === stored.requestId)!;
    expect(shown).toMatchObject({ source: "SEND_BACK", actorRole: "TASK_OWNER" });
    expect(shown).not.toHaveProperty("auto");
    // The owner's own decisions are untouched.
    expect(decisions.find((decision) => decision.decision === "APPROVE")).toMatchObject({ actorRole: "TASK_OWNER" });
  });
});
