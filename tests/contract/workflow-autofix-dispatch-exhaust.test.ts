// DISPATCHEXHAUST (LIVEFIX-1 review M-1 and its uncovered owner-stop / lost-run writers), on the real broker. Three blocks that no finished run wrote used to post a plain card with no automatic
// decision and no "Why I'm asking you": the dispatch budget spent (a CHECKS or REVIEW start failing ten times), a run the runner lost, and a run the owner stopped. Each now commits an AUTOFIX
// row with the block. The two infrastructure faults get ONE automatic retry after a delay (never a send back to coding), then an ask; the owner's stop is explained and never retried.
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  WORKFLOW_AGENTX_ACTOR_ID, WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, WORKFLOW_BLOCK_REASONS, autoFixDecision, classifyBlockedWorkflow, createCandidateManifest, WorkflowDecisionRecordSchema, WorkflowSnapshotSchema, createWorkflowSnapshot, wholeTaskSpendUsd, workflowAutoActionRequestId, workflowAutomaticRetryDecision,
  type AutoFixBudget, type AutoFixFacts, type WorkflowSnapshot,
} from "@agentx/contracts";
import { AUTOFIX_ROUND_ESTIMATE_USD, autofixConfigFromEnvironment } from "../../packages/broker/src/aws/workflow-autofix-runner.js";
import {
  DISPATCH_EXHAUST_RETRY_DELAY_MS, autofixBlockCauseOf, autofixBlockRows, autofixRowHeld, autofixSwitchOn, dispatchExhaustRows, endedRunRows, ownerStopRows,
} from "../../packages/broker/src/aws/workflow-autofix-dispatch-exhaust.js";
import { workflowDispatchItem } from "../../packages/broker/src/aws/broker-shared.js";
import { failActiveOperation } from "../../packages/broker/src/aws/outbox-failure.js";
import { sweepStuckCancels } from "../../packages/broker/src/aws/stuck-cancels.js";
import { AutoFixAskSchema, autoFixCardLines } from "../../packages/broker/src/developer/autofix-messages.js";
import { workflowMessage } from "../../packages/broker/src/developer/workflow-messages.js";
import { MAYA, createSingleAnswerPlanBroker } from "../support/developer-task-broker.js";
import { finishPlanningWithMarkdown } from "../support/plan-documents.js";

type Config = { enabled: boolean; capUsd: number; roundEstimateUsd: number };
const ON: Config = { enabled: true, capUsd: 100, roundEstimateUsd: 3 };
type Harness = Awaited<ReturnType<typeof broker>>;
const PREPARED = { result: { preparedBase: [{ repositoryId: "demo", baseCommitSha: "e".repeat(40) }] } };
const REQUIRED_CHECK = { id: "required-1", label: "npm test", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 30 } };
const passingChecks = () => ({ status: "verified", source: "project", preambleVersion: "1", preambleSha256: "c".repeat(64), checks: [{ id: "readiness:0", label: "npm test", source: "project", before: "passed", after: "passed", class: "passing", output: "", durationMs: 12 }], extraTry: "not_needed", agentClaim: "success" });

const broker = async (autofix: Config | null = { ...ON }) => Object.assign(await createSingleAnswerPlanBroker({ brokerExtra: { planSelfCheck: false, ...(autofix === null ? {} : { autofix }) } }), { config: autofix });
const operations = (harness: Harness, workspaceId: string) => harness.db.find((item) => item.pk === `WORKSPACE#${workspaceId}` && item.entityType === "OPERATION");
const taskOf = (harness: Harness, taskId: string) => harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot; workspaceId: string; autofixAsk?: unknown };
const workflowOf = (harness: Harness, taskId: string) => taskOf(harness, taskId).workflow;
const dispatchRows = (harness: Harness) => harness.db.find((item) => item.pk === "WORKFLOW_DISPATCH");
const sweep = (harness: Harness) => harness.handler({ source: "agentx.workflow-dispatch-recovery" });
const reviewRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "REVIEW");
const checkRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "CHECKS");
const codingRuns = (harness: Harness, workspaceId: string) => operations(harness, workspaceId).filter((item) => item.workflowMode === "IMPLEMENT");
const automatic = (harness: Harness, taskId: string) => workflowOf(harness, taskId).decisions.filter((decision) => decision.source === "AUTO_FIX" || decision.source === "AUTO_RETRY");
const busyReviewStart = (harness: Harness, times = 1) => harness.db.injectFault({ command: "TransactWriteCommand",
  match: (input) => JSON.stringify(input).includes('"workflowMode":"REVIEW"'), error: { name: "TransactionCanceledException" }, times });
const past = () => new Date(Date.now() - 1_000).toISOString();
/** The delay (and the row's backoff) has passed. */
const elapse = (harness: Harness, row: Record<string, unknown>) => harness.db.set({ ...row, nextAttemptAt: past(), dispatchDueSk: `${past()}#${String(row.sk)}`, ...(row.autofixNotBefore === undefined ? {} : { autofixNotBefore: past() }) });
const ask = (harness: Harness, taskId: string) => AutoFixAskSchema.parse(taskOf(harness, taskId).autofixAsk);
const card = (harness: Harness, taskId: string) => workflowMessage({ taskId, workflow: workflowOf(harness, taskId), autoFix: { ask: ask(harness, taskId) } })!;

/** One item of a transaction, as far as these tests read it. */
interface TxItem { Put?: { Item: Record<string, unknown> }; Update?: { Key: { pk: string; sk: string }; ExpressionAttributeValues?: Record<string, unknown> }; Delete?: unknown }
const putOf = (items: TxItem[]) => items.find((item) => item.Put?.Item.kind === "AUTOFIX")!.Put!.Item;

/** Every TransactWrite the table receives, so a test can say what was committed together. */
function recordTransactions(harness: Harness) {
  const committed: TxItem[][] = [];
  const original = harness.db.send;
  harness.db.send = async (command) => {
    if (command.constructor.name === "TransactWriteCommand") committed.push(structuredClone((command.input as { TransactItems: TxItem[] }).TransactItems));
    return original(command);
  };
  return committed;
}
/** The one transaction that blocked the task and put its AUTOFIX row: both are in it, or the test fails. */
function blockWithRow(committed: TxItem[][], taskId: string) {
  const together = committed.filter((items) => items.some((item) => item.Put?.Item.kind === "AUTOFIX")
    && items.some((item) => item.Update?.Key.pk === `DEVTASK#${taskId}` && (item.Update.ExpressionAttributeValues?.[":workflow"] as { state?: string } | undefined)?.state === "BLOCKED"));
  expect(together).toHaveLength(1);
  return together[0]!;
}

/** A Quick task with its plan approved and coding running; `finishImplementation` ends coding with a candidate and passing checks. */
async function workflowAtVerification(harness: Harness) {
  const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Fix the retry bug", client: "test-client", workflow: true, workflowPath: "QUICK" });
  const taskId = String((started.body.task as { taskId: string }).taskId);
  const record = taskOf(harness, taskId);
  const workspaceId = record.workspaceId;
  harness.db.set({ ...record, workflow: { ...record.workflow, checkPolicy: { required: [REQUIRED_CHECK], optional: [], selectedOptionalIds: [] } } });
  await harness.finish(workspaceId, String(operations(harness, workspaceId).find((item) => item.kind === "prepare")?.id), "SUCCEEDED", PREPARED);
  const plan = "# Plan\n\n1. Fix retry handling.\n2. Add a regression test.\n";
  await finishPlanningWithMarkdown(harness, workspaceId, String(operations(harness, workspaceId).find((item) => item.workflowMode === "PLAN")!.id), plan);
  await harness.dev(MAYA, "POST", `/v1/dev/tasks/${taskId}/workflow/decision`, { requestId: randomUUID(), expectedRevision: workflowOf(harness, taskId).revision, decision: "APPROVE", reason: "Approved", artifactDigest: createHash("sha256").update(plan).digest("hex") });
  const implementation = operations(harness, workspaceId).find((item) => item.workflowMode === "IMPLEMENT")!;
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  const finishImplementation = () => harness.finish(workspaceId, String(implementation.id), "SUCCEEDED", { result: { workflowCandidateRepositories: candidate.repositories, workflowCheckCandidateRepositories: candidate.repositories, checks: passingChecks() } });
  return { taskId, workspaceId, candidate, finishImplementation };
}

/** The review start fails ten times: the budget is spent and the task blocks. Returns the block's transaction. */
async function reviewDispatchExhausted(harness: Harness, ctx: Awaited<ReturnType<typeof workflowAtVerification>>) {
  busyReviewStart(harness);
  await ctx.finishImplementation();
  const [row] = dispatchRows(harness);
  expect(row).toMatchObject({ kind: "REVIEW", attempts: 1 });
  const committed = recordTransactions(harness);
  elapse(harness, { ...row!, attempts: 9 });
  busyReviewStart(harness);
  await sweep(harness);
  return committed;
}

describe("DISPATCHEXHAUST 1: the dispatch budget is spent (a start that fails ten times)", () => {
  it("commits the AUTOFIX row in the SAME transaction as the block, held for the retry delay, with the cause", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    const before = Date.now();
    const committed = await reviewDispatchExhausted(harness, ctx);
    const blocked = workflowOf(harness, ctx.taskId);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE });
    const transaction = blockWithRow(committed, ctx.taskId);
    // The same transaction deletes the exhausted row and puts the AUTOFIX row for the revision the block commits at.
    expect(transaction.some((item) => item.Delete !== undefined)).toBe(true);
    const put = putOf(transaction);
    expect(put).toMatchObject({ kind: "AUTOFIX", taskId: ctx.taskId, workflowRevision: blocked.revision, candidateDigest: ctx.candidate.digest, autofixCause: "dispatch-exhausted" });
    const [row] = dispatchRows(harness);
    expect(row).toMatchObject({ kind: "AUTOFIX", workflowRevision: blocked.revision, autofixCause: "dispatch-exhausted", attempts: 0 });
    // Held for the delay: neither due nor to be looked at before it.
    expect(Date.parse(String(row!.autofixNotBefore))).toBeGreaterThanOrEqual(before + DISPATCH_EXHAUST_RETRY_DELAY_MS);
    expect(row!.nextAttemptAt).toBe(row!.autofixNotBefore);
    expect(row!.dispatchDueSk).toBe(`${String(row!.autofixNotBefore)}#${String(row!.sk)}`);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(taskOf(harness, ctx.taskId).autofixAsk).toBeUndefined();
  });

  it("does not look at the block before the delay is over, even when something runs the row early (the nested dispatch)", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await reviewDispatchExhausted(harness, ctx);
    const [row] = dispatchRows(harness);
    // The sweep does not even find it (not due); a run of the task's rows right after another event does, and it must leave the held row alone.
    expect(JSON.parse((await sweep(harness)).body)).toMatchObject({ attempted: 0 });
    harness.db.set({ ...row!, nextAttemptAt: past(), dispatchDueSk: `${past()}#${String(row!.sk)}` });
    expect(JSON.parse((await sweep(harness)).body)).toMatchObject({ attempted: 1, dispatched: 0 });
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(0);
    expect(dispatchRows(harness)).toHaveLength(1);
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  });

  it("retries ONCE after the delay (an AGENTX retry of the reviews, never a send back), even when the sweep runs twice at once", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await reviewDispatchExhausted(harness, ctx);
    const blocked = workflowOf(harness, ctx.taskId);
    elapse(harness, dispatchRows(harness)[0]!);
    await Promise.all([sweep(harness), sweep(harness)]);
    const retries = automatic(harness, ctx.taskId);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ source: "AUTO_RETRY", actorRole: "AGENTX", actorId: WORKFLOW_AGENTX_ACTOR_ID, decision: "REQUEST_CHANGES", auto: { stage: "REVIEW", candidateDigest: ctx.candidate.digest },
      requestId: workflowAutoActionRequestId(ctx.taskId, blocked.revision, "AUTO_RETRY") });
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "RUNNING" });
    // One review run (the earlier ones never started), no coding run, no ask, nothing left to sweep.
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)[0]).toMatchObject({ requestId: retries[0]!.requestId });
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(taskOf(harness, ctx.taskId).autofixAsk).toBeUndefined();
    expect(dispatchRows(harness)).toEqual([]);
    await sweep(harness);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    // The nested look that ran just before the sweep left its row behind (a lost delete): the row for the block that was already handled changes nothing and goes away.
    const [leftover] = autofixBlockRows("state", { ...blocked, revision: blocked.revision - 1 }, "dispatch-exhausted", new Date(Date.now() - 4 * 60_000).toISOString());
    harness.db.set((leftover as { Put: { Item: Record<string, unknown> } }).Put.Item);
    await Promise.all([sweep(harness), sweep(harness)]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(dispatchRows(harness)).toEqual([]);
  });

  it("asks after the one retry (what failed, what Rovara tried, the limit), never retrying twice and never sending back to coding", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await reviewDispatchExhausted(harness, ctx);
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    // The retried reviews are lost the same way: the budget is spent again for the same candidate.
    const current = taskOf(harness, ctx.taskId);
    harness.db.set({ ...current, workflow: { ...current.workflow, state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, revision: current.workflow.revision + 1 } });
    const second = workflowOf(harness, ctx.taskId);
    const [put] = autofixBlockRows("state", second, "dispatch-exhausted", new Date(Date.now() - 4 * 60_000).toISOString());
    harness.db.set({ ...(put as { Put: { Item: Record<string, unknown> } }).Put.Item });
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(workflowOf(harness, ctx.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toEqual([]);
    expect(ask(harness, ctx.taskId)).toMatchObject({ workflowRevision: second.revision, reason: "retry-limit", codes: ["dispatch-exhausted"] });
    const text = card(harness, ctx.taskId).text;
    expect(text).toContain("What failed:");
    expect(text).toContain("Rovara tried several times to start this step and could not.");
    expect(text).toContain("Retried the reviews once.");
    expect(text).toContain("Why I'm asking you");
    expect(text).toContain("I already retried this once for this code, which is my limit.");
    // The options are the card's own buttons: retry the reviews, and cancel.
    expect(JSON.stringify(card(harness, ctx.taskId).blocks)).toContain("agentx_workflow_retry");
    expect(dispatchRows(harness)).toEqual([]);
  });

  it("never gives a second FREE retry when one already happened for this code: the first block asks at once", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    // An earlier block of the same candidate was already retried by Rovara (its decision is in the history).
    busyReviewStart(harness);
    await ctx.finishImplementation();
    const task = taskOf(harness, ctx.taskId);
    const earlier = { requestId: randomUUID(), workflowRevision: task.workflow.revision, decision: "REQUEST_CHANGES" as const, actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX" as const,
      reason: "Rovara retried the reviews by itself.", source: "AUTO_RETRY" as const, auto: { stage: "REVIEW" as const, candidateDigest: ctx.candidate.digest }, at: new Date().toISOString() };
    harness.db.set({ ...task, workflow: { ...task.workflow, decisions: [...task.workflow.decisions, earlier] } });
    elapse(harness, { ...dispatchRows(harness)[0]!, attempts: 9 });
    busyReviewStart(harness);
    await sweep(harness);
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(0);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "retry-limit", codes: ["dispatch-exhausted"] });
  });

  it("respects the per-task spend cap: no retry, an ask naming the cap", async () => {
    const harness = await broker({ ...ON, capUsd: 5 });
    const ctx = await workflowAtVerification(harness);
    await reviewDispatchExhausted(harness, ctx);
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(0);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "spend-cap", capUsd: 5, codes: ["dispatch-exhausted"] });
    expect(card(harness, ctx.taskId).text).toContain("over the $5 per-task cap");
  });

  it("writes no row (and decides nothing) when automatic fixing is off, exactly as before", async () => {
    for (const autofix of [null, { ...ON, enabled: false }]) {
      const harness = await broker(autofix);
      const ctx = await workflowAtVerification(harness);
      await reviewDispatchExhausted(harness, ctx);
      expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE });
      expect(dispatchRows(harness)).toEqual([]);
      expect(automatic(harness, ctx.taskId)).toEqual([]);
      expect(taskOf(harness, ctx.taskId).autofixAsk).toBeUndefined();
    }
  });

  it("a deterministic refusal's own reason is classified by its text, with no cause (no infrastructure retry for a refusal)", () => {
    const step = { taskId: "t", revision: 4, stage: "VERIFY" as const, candidate: undefined };
    const refusal = dispatchExhaustRows({ tableName: "state", autofix: { enabled: true } }, { kind: "CHECKS" }, step, "agent-route-not-approved: the route is not approved", new Date().toISOString());
    expect(refusal).toHaveLength(1);
    const item = (refusal[0] as { Put: { Item: Record<string, unknown> } }).Put.Item;
    expect(item).not.toHaveProperty("autofixCause");
    expect(item).not.toHaveProperty("autofixNotBefore");
    expect(item.workflowRevision).toBe(5);
    const generic = dispatchExhaustRows({ tableName: "state", autofix: { enabled: true } }, { kind: "CHECKS" }, step, undefined, new Date().toISOString());
    expect((generic[0] as { Put: { Item: Record<string, unknown> } }).Put.Item).toMatchObject({ autofixCause: "dispatch-exhausted", workflowRevision: 5 });
    // Only the steps the policy looks at, and only while the switch is on.
    expect(dispatchExhaustRows({ tableName: "state", autofix: { enabled: true } }, { kind: "PUBLISH" }, step, undefined, new Date().toISOString())).toEqual([]);
    expect(dispatchExhaustRows({ tableName: "state" }, { kind: "CHECKS" }, step, undefined, new Date().toISOString())).toEqual([]);
    expect(autofixBlockRows("state", { ...step, stage: "IMPLEMENT" }, "run-lost", new Date().toISOString())).toEqual([]);
  });
});

describe("DISPATCHEXHAUST 1b: the CHECKS start (a required browser and API round)", () => {
  /** The checks of a required-E2E task fail to start: its readiness warm-up meets a table fault, ten times. */
  async function checksDispatchExhausted(harness: Harness) {
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    await harness.finish(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId)[0]!.id), "FAILED", { error: "stopped" });
    for (const row of dispatchRows(harness)) harness.db.delete(String(row.pk), String(row.sk));
    const staged = await readinessInFlight(harness, ctx, "idle");
    const committed = recordTransactions(harness);
    const row = dispatchRows(harness)[0]!;
    harness.db.set({ ...row, attempts: 9 });
    // Every read of the workspace fails (a throttled table): the warm-up cannot even be looked at.
    harness.db.injectFault({ command: "GetCommand", match: (input) => JSON.stringify(input).includes("WORKSPACE#"), error: { name: "ProvisionedThroughputExceededException" }, times: 50 });
    await sweep(harness);
    return { ctx, staged, committed };
  }

  it("blocks with the unconfirmed-checks reason and commits the AUTOFIX row (cause dispatch-exhausted) in the same transaction", async () => {
    const harness = await broker();
    const { ctx, staged, committed } = await checksDispatchExhausted(harness);
    const blocked = workflowOf(harness, ctx.taskId);
    expect(blocked).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checksUnconfirmed, revision: staged.waiting.revision + 1 });
    const transaction = blockWithRow(committed, ctx.taskId);
    expect(putOf(transaction)).toMatchObject({ workflowRevision: blocked.revision, autofixCause: "dispatch-exhausted", candidateDigest: ctx.candidate.digest });
    expect(dispatchRows(harness)).toHaveLength(1);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
  });

  for (const cause of ["dispatch-exhausted", "run-lost"] as const) {
    it(`${cause}: retries the blocked checks ONCE after the delay (the owner's checks, an AGENTX decision), then asks naming the retry limit`, async () => {
      const harness = await broker();
      const ctx = await workflowAtVerification(harness);
      const candidate = await ctx.finishImplementation().then(() => workflowOf(harness, ctx.taskId).candidate!);
      await harness.finish(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId)[0]!.id), "FAILED", { error: "stopped" });
      for (const row of dispatchRows(harness)) harness.db.delete(String(row.pk), String(row.sk));
      const blockChecks = (heldFor: number) => {
        const current = taskOf(harness, ctx.taskId);
        harness.db.set({ ...current, workflow: { ...current.workflow, stage: "VERIFY", state: "BLOCKED", blockReason: WORKFLOW_BLOCK_REASONS.checksUnconfirmed, revision: current.workflow.revision + 1, candidate } });
        const [put] = autofixBlockRows("state", { ...workflowOf(harness, ctx.taskId), revision: workflowOf(harness, ctx.taskId).revision }, cause, new Date(Date.now() - heldFor).toISOString());
        harness.db.set((put as { Put: { Item: Record<string, unknown> } }).Put.Item);
      };
      blockChecks(60_000);
      // Still inside the delay: the sweep leaves it.
      await sweep(harness);
      expect(automatic(harness, ctx.taskId)).toEqual([]);
      expect(checkRuns(harness, ctx.workspaceId)).toHaveLength(0);
      blockChecks(DISPATCH_EXHAUST_RETRY_DELAY_MS + 60_000);
      await sweep(harness);
      const retry = automatic(harness, ctx.taskId);
      expect(retry).toHaveLength(1);
      expect(retry[0]).toMatchObject({ source: "AUTO_RETRY", actorRole: "AGENTX", auto: { stage: "VERIFY", candidateDigest: candidate.digest } });
      expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
      expect(checkRuns(harness, ctx.workspaceId)).toHaveLength(1);
      expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
      blockChecks(DISPATCH_EXHAUST_RETRY_DELAY_MS + 60_000);
      await sweep(harness);
      expect(automatic(harness, ctx.taskId)).toHaveLength(1);
      expect(checkRuns(harness, ctx.workspaceId)).toHaveLength(1);
      expect(workflowOf(harness, ctx.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toEqual([]);
      expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "retry-limit", codes: [cause] });
      expect(card(harness, ctx.taskId).text).toContain("Retried the checks once.");
      expect(card(harness, ctx.taskId).text).toContain("What failed:");
    });
  }

  it("without the cause this block would be read as unreadable and asked at once; with it the policy retries the checks once, then asks", () => {
    const workflow = blockedWorkflow("VERIFY");
    expect(autoFixDecision(workflow, {}, budget())).toMatchObject({ action: "ASK", reason: "needs-a-person" });
    expect(autoFixDecision(workflow, { blockCause: "dispatch-exhausted" }, budget())).toEqual({ action: "RETRY", stage: "VERIFY", codes: ["dispatch-exhausted"] });
  });
});

describe("DISPATCHEXHAUST 2: the runner lost the task mid-run", () => {
  /** Reviews are running; the compute is lost under them (the reconciler's failActiveOperation), which blocks the step. */
  async function lostReviews(harness: Harness, ctx: Awaited<ReturnType<typeof workflowAtVerification>>) {
    const committed = recordTransactions(harness);
    await failActiveOperation(harness.db as never, "state", ctx.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    return committed;
  }

  it("blocks and commits the AUTOFIX row (cause run-lost, held) in one transaction; one automatic retry after the delay; then an ask", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "RUNNING" });
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    let committed = await lostReviews(harness, ctx);
    const blocked = workflowOf(harness, ctx.taskId);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "independent review operation ended failed" });
    const transaction = blockWithRow(committed, ctx.taskId);
    expect(putOf(transaction)).toMatchObject({ workflowRevision: blocked.revision, autofixCause: "run-lost", candidateDigest: ctx.candidate.digest });
    // Held: the sweep does nothing for the delay.
    expect(JSON.parse((await sweep(harness)).body)).toMatchObject({ attempted: 0 });
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    // After the delay: one AGENTX retry of the reviews.
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(automatic(harness, ctx.taskId)[0]).toMatchObject({ source: "AUTO_RETRY", auto: { stage: "REVIEW" } });
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(2);
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "RUNNING" });
    // The retried run is lost too: the same candidate, so no second retry, an ask with what failed.
    committed = await lostReviews(harness, ctx);
    blockWithRow(committed, ctx.taskId);
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(2);
    expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(workflowOf(harness, ctx.taskId).decisions.filter((decision) => decision.source === "AUTO_FIX")).toEqual([]);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "retry-limit", codes: ["run-lost"] });
    const text = card(harness, ctx.taskId).text;
    expect(text).toContain("What failed:");
    expect(text).toContain("The runner lost the task partway through the run.");
    expect(text).toContain("Retried the reviews once.");
    expect(text).toContain("Why I'm asking you");
    expect(dispatchRows(harness)).toEqual([]);
  });

  it("a failed result the worker REPORTS is not a lost run: it is decided as before, with no cause and no delay", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    await harness.finish(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId)[0]!.id), "FAILED", { error: "the reviewer crashed" });
    const [row] = dispatchRows(harness);
    // The result path wrote its row as it always did (and it was looked at in the same invocation).
    expect(row === undefined || row.autofixCause === undefined).toBe(true);
  });

  it("respects the spend cap: a lost run is not retried when the cap would be passed", async () => {
    const harness = await broker({ ...ON, capUsd: 5 });
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    await lostReviews(harness, ctx);
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "spend-cap", codes: ["run-lost"] });
  });

  it("a lost CODING run (a step the policy does not look at) writes no row", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await failActiveOperation(harness.db as never, "state", ctx.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "IMPLEMENT", state: "BLOCKED" });
    expect(dispatchRows(harness)).toEqual([]);
  });

  it("endedRunRows: the cause is the caller's, a lost run or the owner's stop; the switch is read as the broker reads it", () => {
    const step = { taskId: "t", revision: 7, stage: "REVIEW" as const, candidate: undefined };
    const at = new Date().toISOString();
    const rowOf = (rows: ReturnType<typeof endedRunRows>) => (rows[0] as { Put: { Item: Record<string, unknown> } }).Put.Item;
    expect(rowOf(endedRunRows("state", step, "run-lost", at, {}))).toMatchObject({ autofixCause: "run-lost", workflowRevision: 8 });
    expect(rowOf(endedRunRows("state", step, "owner-stopped", at, {}))).toMatchObject({ autofixCause: "owner-stopped", workflowRevision: 8 });
    expect(rowOf(endedRunRows("state", step, "owner-stopped", at, {}))).not.toHaveProperty("autofixNotBefore");
    expect(endedRunRows("state", step, "run-lost", at, { AUTOFIX_ENABLED: "false" })).toEqual([]);
    for (const env of [{}, { AUTOFIX_ENABLED: "false" }, { AUTOFIX_ENABLED: " FALSE " }, { AUTOFIX_ENABLED: "true" }, { AUTOFIX_ENABLED: "" }]) expect(autofixSwitchOn(env)).toBe(autofixConfigFromEnvironment(env).enabled);
  });
});

/** A required-E2E task waiting in VERIFY with its readiness warm-up in flight (the shape the existing cancel tests build). */
async function readinessInFlight(harness: Harness, ctx: Awaited<ReturnType<typeof workflowAtVerification>>, mode: "idle" | "active") {
  const { taskId, workspaceId, candidate } = ctx;
  const taskRow = taskOf(harness, taskId);
  const waiting = { ...taskRow.workflow, stage: "VERIFY" as const, state: "WAITING" as const,
    e2e: { contractDigest: "a".repeat(64), policyDigest: "b".repeat(64), bundleDigest: "c".repeat(64), executionPlanDigest: "d".repeat(64), required: true, currentGroupRunIds: [], resultRefs: [] } };
  harness.db.set({ ...taskRow, workflow: waiting });
  const dispatchSk = `${taskId}#${waiting.revision}`;
  const readinessOperationId = randomUUID();
  const outboxId = randomUUID();
  const marker = { purpose: "workflow-e2e-readiness", taskId, workflowRevision: waiting.revision, candidateDigest: candidate.digest, dispatchSk, outboxId, ...(mode === "idle" ? { readyGeneration: 4 } : {}) };
  const workspace = harness.db.get(`WORKSPACE#${workspaceId}`, "META") as Record<string, unknown>;
  const fence = Number(workspace.fence);
  const { activeOperationId: _active, ...idle } = workspace;
  void _active;
  harness.db.set({ ...operations(harness, workspaceId)[0]!, pk: `WORKSPACE#${workspaceId}`, sk: `OPERATION#${readinessOperationId}`, id: readinessOperationId, entityType: "OPERATION", workspaceId, kind: "resume",
    status: mode === "idle" ? "SUCCEEDED" : "DISPATCHING", fence, workflowE2EReadiness: marker, ...(mode === "idle" ? { result: { status: "READY", generation: 4 } } : {}) });
  if (mode === "idle") harness.db.set({ ...idle, status: "READY" });
  else {
    harness.db.set({ ...workspace, status: "BUSY", activeOperationId: readinessOperationId, fence });
    harness.db.set({ pk: `OUTBOX#${outboxId}`, sk: "OUTBOX", id: outboxId, entityType: "OUTBOX", status: "QUEUED", operationId: readinessOperationId, workspaceId, deploymentMode: "ec2-ebs", workflowE2EReadiness: marker,
      invocation: { kind: "resume", operationId: readinessOperationId, workspaceId, fence } });
  }
  const now = new Date().toISOString();
  harness.db.set({ pk: "WORKFLOW_DISPATCH", sk: dispatchSk, entityType: "WORKFLOW_DISPATCH", taskId, workflowRevision: waiting.revision, kind: "CHECKS", candidateDigest: candidate.digest, readinessOperationId,
    createdAt: now, attempts: 0, nextAttemptAt: now, dispatchDuePk: "WORKFLOW_DISPATCH", dispatchDueSk: `${now}#${dispatchSk}`, indexExpiresAt: Math.floor(Date.now() / 1_000) + 86_400 });
  return { waiting, readinessOperationId };
}

describe("DISPATCHEXHAUST 3: the owner stopped the task", () => {
  for (const mode of ["idle", "active"] as const) {
    it(`a stop of the ${mode} readiness warm-up commits the explanation row with the block; no retry, no send back, the ask explains`, async () => {
      const harness = await broker();
      const ctx = await workflowAtVerification(harness);
      await ctx.finishImplementation();
      // The reviews that started by themselves end, so the workspace is free for the staged warm-up.
      await harness.finish(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId)[0]!.id), "FAILED", { error: "stopped" });
      for (const row of dispatchRows(harness)) harness.db.delete(String(row.pk), String(row.sk));
      const staged = await readinessInFlight(harness, ctx, mode);
      const committed = recordTransactions(harness);
      const stopped = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/cancel`, { requestId: randomUUID() });
      expect(stopped.status).toBe(200);
      const blocked = workflowOf(harness, ctx.taskId);
      expect(blocked).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
      expect(blocked.revision).toBe(staged.waiting.revision + 1);
      const transaction = blockWithRow(committed, ctx.taskId);
      expect(putOf(transaction)).toMatchObject({ workflowRevision: blocked.revision, autofixCause: "owner-stopped" });
      const [row] = dispatchRows(harness);
      expect(row).toMatchObject({ kind: "AUTOFIX", autofixCause: "owner-stopped" });
      // Not held: the owner's stop is explained at once.
      expect(row).not.toHaveProperty("autofixNotBefore");
      const operationsBefore = operations(harness, ctx.workspaceId).length;
      await sweep(harness);
      expect(automatic(harness, ctx.taskId)).toEqual([]);
      expect(operations(harness, ctx.workspaceId)).toHaveLength(operationsBefore);
      expect(codingRuns(harness, ctx.workspaceId)).toHaveLength(1);
      expect(ask(harness, ctx.taskId)).toMatchObject({ workflowRevision: blocked.revision, reason: "owner-stopped", codes: ["owner-stopped"] });
      const text = card(harness, ctx.taskId).text;
      expect(text).toContain("Why I'm asking you");
      expect(text).toContain("You stopped this, so I did not retry it by myself.");
      expect(text).not.toContain("What Rovara already tried");
      expect(text).not.toContain("What failed");
      expect(dispatchRows(harness)).toEqual([]);
      // A second look (the nested dispatch and the sweep both running) changes nothing.
      await sweep(harness);
      expect(automatic(harness, ctx.taskId)).toEqual([]);
    });
  }

  it("a stop of the running reviews (the cancel path) is explained too, and never retried even with the budget untouched", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "RUNNING" });
    await harness.events(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId)[0]!.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    const stopped = await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/cancel`, { requestId: randomUUID() });
    expect(stopped.status).toBe(200);
    const cancel = operations(harness, ctx.workspaceId).find((item) => item.kind === "cancel" && item.targetOperationId === reviewRuns(harness, ctx.workspaceId)[0]!.id)!;
    expect(cancel).toBeDefined();
    await harness.finish(ctx.workspaceId, String(cancel.id), "SUCCEEDED");
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "owner-stopped" });
    expect(card(harness, ctx.taskId).text).toContain("You stopped this, so I did not retry it by myself.");
  });

  /** The reviews are running and the owner asks to stop them; the stop is requested, and the worker's cancel result is what the caller decides. */
  async function stopRequested(harness: Harness, ctx: Awaited<ReturnType<typeof workflowAtVerification>>) {
    await ctx.finishImplementation();
    const run = reviewRuns(harness, ctx.workspaceId)[0]!;
    await harness.events(ctx.workspaceId, String(run.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/cancel`, { requestId: randomUUID() })).status).toBe(200);
    return { run, cancel: operations(harness, ctx.workspaceId).find((item) => item.kind === "cancel" && item.targetOperationId === run.id)! };
  }
  const sweepStuck = (harness: Harness, workspaceId: string, at: Date = new Date()) => sweepStuckCancels({ client: harness.db, tableName: "state" }, [{ workspaceId, compute: "gone" }], at);

  it("a stop whose cancel failed and was released by the reconciler (the owner asked to stop) is explained and never retried", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    const { run, cancel } = await stopRequested(harness, ctx);
    await harness.finish(ctx.workspaceId, String(cancel.id), "FAILED");
    expect((await sweepStuck(harness, ctx.workspaceId)).interrupted).toEqual([run.id]);
    const blocked = workflowOf(harness, ctx.taskId);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "independent review operation ended interrupted" });
    expect(dispatchRows(harness)).toHaveLength(1);
    expect(dispatchRows(harness)[0]).toMatchObject({ kind: "AUTOFIX", workflowRevision: blocked.revision, autofixCause: "owner-stopped" });
    expect(dispatchRows(harness)[0]).not.toHaveProperty("autofixNotBefore");
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "owner-stopped", codes: ["owner-stopped"] });
  });

  it("B-1: a stop that never answered because the compute is gone is STILL the owner's stop: explained, never started again", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    const { run } = await stopRequested(harness, ctx);
    expect((await sweepStuck(harness, ctx.workspaceId, new Date(Date.now() + 31 * 60_000))).ended).toEqual([run.id]);
    const blocked = workflowOf(harness, ctx.taskId);
    expect(blocked).toMatchObject({ stage: "REVIEW", state: "BLOCKED", blockReason: "independent review operation ended failed" });
    expect(dispatchRows(harness)).toHaveLength(1);
    expect(dispatchRows(harness)[0]).toMatchObject({ kind: "AUTOFIX", workflowRevision: blocked.revision, autofixCause: "owner-stopped" });
    expect(dispatchRows(harness)[0]).not.toHaveProperty("autofixNotBefore");
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "owner-stopped", codes: ["owner-stopped"] });
    expect(card(harness, ctx.taskId).text).toContain("You stopped this, so I did not retry it by myself.");
  });

  it("B-1: the reconciler losing the compute under a run the owner asked to stop (CANCEL_REQUESTED) is the owner's stop; under a run nobody asked to stop it is a lost run", async () => {
    const stopped = await broker();
    const ctx = await workflowAtVerification(stopped);
    await stopRequested(stopped, ctx);
    expect(operations(stopped, ctx.workspaceId).find((item) => item.workflowMode === "REVIEW")).toMatchObject({ status: "CANCEL_REQUESTED" });
    await failActiveOperation(stopped.db as never, "state", ctx.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    expect(dispatchRows(stopped)[0]).toMatchObject({ kind: "AUTOFIX", autofixCause: "owner-stopped" });
    expect(dispatchRows(stopped)[0]).not.toHaveProperty("autofixNotBefore");
    await sweep(stopped);
    expect(automatic(stopped, ctx.taskId)).toEqual([]);
    expect(reviewRuns(stopped, ctx.workspaceId)).toHaveLength(1);
    expect(ask(stopped, ctx.taskId)).toMatchObject({ reason: "owner-stopped" });
    // The same loss with no stop asked for is the infrastructure fault.
    const lost = await broker();
    const other = await workflowAtVerification(lost);
    await other.finishImplementation();
    await failActiveOperation(lost.db as never, "state", other.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    expect(dispatchRows(lost)[0]).toMatchObject({ kind: "AUTOFIX", autofixCause: "run-lost" });
  });

  it("B-1 race: a row that says run-lost (an older writer) for a run the owner asked to stop is read as the owner's stop: the scheduled retry does not start", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    const { run } = await stopRequested(harness, ctx);
    // An older Lambda (or any writer that only knows the status) blocks the step as a lost run, held for the delay.
    await failActiveOperation(harness.db as never, "state", ctx.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    const owner = dispatchRows(harness)[0]!;
    harness.db.set({ ...owner, autofixCause: "run-lost", autofixNotBefore: new Date(Date.now() + DISPATCH_EXHAUST_RETRY_DELAY_MS).toISOString() });
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toEqual([]);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)[0]!.id).toBe(run.id);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "owner-stopped", codes: ["owner-stopped"] });
  });

  it("race: the owner stops the running reviews of the AUTOMATIC retry while it runs: the owner's stop is explained and nothing starts again", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    await failActiveOperation(harness.db as never, "state", ctx.workspaceId, "RUNTIME_UNAVAILABLE: workspace compute was lost; retry the request");
    elapse(harness, dispatchRows(harness)[0]!);
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    const retried = reviewRuns(harness, ctx.workspaceId)[1]!;
    await harness.events(ctx.workspaceId, String(retried.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/cancel`, { requestId: randomUUID() })).status).toBe(200);
    const cancel = operations(harness, ctx.workspaceId).find((item) => item.kind === "cancel" && item.targetOperationId === retried.id)!;
    await harness.finish(ctx.workspaceId, String(cancel.id), "SUCCEEDED");
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(1);
    expect(reviewRuns(harness, ctx.workspaceId)).toHaveLength(2);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "owner-stopped" });
  });

  it("the owner's Stop of a running NON-E2E VERIFY step ends the step (blocked, explained), not RUNNING: the cancel-path fix with automatic fixing on", async () => {
    const harness = await broker();
    const ctx = await workflowAtVerification(harness);
    // The final checks report is unreadable, so verification blocks; the owner's retry then runs the checks alone.
    await harness.finish(ctx.workspaceId, String(codingRuns(harness, ctx.workspaceId)[0]!.id), "SUCCEEDED", { result: { workflowCandidateRepositories: ctx.candidate.repositories, workflowCheckCandidateRepositories: ctx.candidate.repositories, checks: "not a report" } });
    const blocked = workflowOf(harness, ctx.taskId);
    expect([blocked.stage, blocked.state]).toEqual(["VERIFY", "BLOCKED"]);
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/workflow/retry`, { requestId: randomUUID(), instructions: "Run the checks again", expectedRevision: blocked.revision })).status).toBe(200);
    const checks = checkRuns(harness, ctx.workspaceId)[0]!;
    await harness.events(ctx.workspaceId, String(checks.id), [{ type: "lifecycle", payload: { status: "RUNNING" } }]);
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "VERIFY", state: "RUNNING" });
    const automaticBefore = automatic(harness, ctx.taskId).length;
    expect((await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/cancel`, { requestId: randomUUID() })).status).toBe(200);
    await harness.finish(ctx.workspaceId, String(operations(harness, ctx.workspaceId).find((item) => item.kind === "cancel" && item.targetOperationId === checks.id)!.id), "SUCCEEDED");
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "VERIFY", state: "BLOCKED", blockReason: "verification retry operation ended cancelled" });
    // The row committed with the block was looked at in the same invocation and is gone; its ask explains the stop.
    await sweep(harness);
    expect(automatic(harness, ctx.taskId)).toHaveLength(automaticBefore);
    expect(checkRuns(harness, ctx.workspaceId)).toHaveLength(1);
    expect(ask(harness, ctx.taskId)).toMatchObject({ reason: "owner-stopped" });
  });

  it("without automatic fixing the stop leaves no row and no ask", async () => {
    const harness = await broker(null);
    const ctx = await workflowAtVerification(harness);
    await ctx.finishImplementation();
    await harness.finish(ctx.workspaceId, String(reviewRuns(harness, ctx.workspaceId)[0]!.id), "FAILED", { error: "stopped" });
    for (const row of dispatchRows(harness)) harness.db.delete(String(row.pk), String(row.sk));
    await readinessInFlight(harness, ctx, "active");
    await harness.dev(MAYA, "POST", `/v1/dev/tasks/${ctx.taskId}/cancel`, { requestId: randomUUID() });
    expect(workflowOf(harness, ctx.taskId)).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    expect(dispatchRows(harness)).toEqual([]);
    expect(ownerStopRows({ tableName: "state" }, { taskId: "t", revision: 1, stage: "VERIFY", candidate: undefined }, new Date().toISOString())).toEqual([]);
  });
});

/** A blocked workflow as the policy reads it. */
const blockedWorkflow = (stage: "VERIFY" | "REVIEW", extra: Record<string, unknown> = {}): WorkflowSnapshot => {
  const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "d".repeat(40), treeSha: "b".repeat(40), baseCommitSha: "e".repeat(40) }]);
  return { taskId: "t", revision: 9, stage, state: "BLOCKED", blockReason: stage === "REVIEW" ? WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE : WORKFLOW_BLOCK_REASONS.checksUnconfirmed, decisions: [], candidate, updatedAt: "2026-10-27T00:00:00.000Z", ...extra } as unknown as WorkflowSnapshot;
};
const spend = (spentUsd: number, capUsd = 15) => ({ spentUsd: wholeTaskSpendUsd(spentUsd), roundEstimateUsd: AUTOFIX_ROUND_ESTIMATE_USD, capUsd });
const budget = (extra: Partial<AutoFixBudget> = {}): AutoFixBudget => ({ enabled: true, spend: spend(1), dayBudgetHasRoom: true, baselineRequests: 0, ...extra });
const retryDecision = (stage: "VERIFY" | "REVIEW", digest: string) => ({ requestId: `r-${stage}`, workflowRevision: 3, decision: "REQUEST_CHANGES", actorId: WORKFLOW_AGENTX_ACTOR_ID, actorRole: "AGENTX", reason: "x", source: "AUTO_RETRY", auto: { stage, candidateDigest: digest }, at: "2026-10-27T00:00:00.000Z" });

describe("DISPATCHEXHAUST policy: a cause is the whole classification of the block", () => {
  for (const stage of ["VERIFY", "REVIEW"] as const) {
    for (const cause of ["dispatch-exhausted", "run-lost"] as const) {
      it(`${stage} ${cause}: ONE retry of that stage, an infrastructure fault`, () => {
        const workflow = blockedWorkflow(stage);
        const facts: AutoFixFacts = { blockCause: cause };
        expect(classifyBlockedWorkflow(workflow, facts)).toEqual([{ class: "transient", code: cause }]);
        expect(autoFixDecision(workflow, facts, budget())).toEqual({ action: "RETRY", stage, codes: [cause] });
      });

      it(`${stage} ${cause}: never a send back to coding, whatever else the block holds (failed checks, findings)`, () => {
        const candidate = blockedWorkflow(stage).candidate!;
        const workflow = blockedWorkflow(stage, {
          verification: { candidateDigest: candidate.digest, results: [{ checkId: "required-1", status: "FAILED" }] },
          reviews: [{ operationId: "o", candidateDigest: candidate.digest, role: "CRITIC", status: "FINDINGS", findings: [{ text: "x", origin: "INTRODUCED", severity: "HIGH" }] }],
        });
        // Without the cause these signals send the work back; with it they cannot.
        expect(autoFixDecision(workflow, { blockCause: undefined, checkExpectsPass: ["required-1"] }, budget()).action).toBe("SEND_BACK");
        const decision = autoFixDecision(workflow, { blockCause: cause }, budget());
        expect(decision.action).toBe("RETRY");
      });

      it(`${stage} ${cause}: a second one for the same candidate asks (retry-limit), and the limits and the money are held`, () => {
        const workflow = blockedWorkflow(stage);
        const digest = workflow.candidate!.digest;
        const facts: AutoFixFacts = { blockCause: cause };
        const retried = { ...workflow, decisions: [retryDecision(stage, digest)] } as unknown as WorkflowSnapshot;
        expect(autoFixDecision(retried, facts, budget())).toEqual({ action: "ASK", reason: "retry-limit", codes: [cause] });
        // The other stage's retry is not this stage's, but a different candidate's retry does not use this one up either.
        expect(autoFixDecision({ ...workflow, decisions: [retryDecision(stage === "VERIFY" ? "REVIEW" : "VERIFY", digest)] } as unknown as WorkflowSnapshot, facts, budget()).action).toBe("RETRY");
        expect(autoFixDecision({ ...workflow, decisions: [retryDecision(stage, "f".repeat(64))] } as unknown as WorkflowSnapshot, facts, budget()).action).toBe("RETRY");
        expect(autoFixDecision(workflow, facts, budget({ spend: spend(14) }))).toEqual({ action: "ASK", reason: "spend-cap", codes: [cause] });
        expect(autoFixDecision(workflow, facts, budget({ spend: spend(Number.NaN) }))).toEqual({ action: "ASK", reason: "inputs-missing", codes: [cause] });
        expect(autoFixDecision(workflow, facts, budget({ dayBudgetHasRoom: false }))).toEqual({ action: "ASK", reason: "day-budget", codes: [cause] });
        const sixActions = Array.from({ length: 6 }, (_, index) => ({ ...retryDecision("VERIFY", `${index}`.repeat(64)), requestId: `a${index}` }));
        expect(autoFixDecision({ ...workflow, decisions: sixActions } as unknown as WorkflowSnapshot, facts, budget())).toEqual({ action: "ASK", reason: "total-limit", codes: [cause] });
        expect(autoFixDecision(workflow, facts, budget({ enabled: false }))).toEqual({ action: "NONE" });
      });
    }

    it(`${stage} owner-stopped: never a retry, never a send back, whatever the budget: the ask explains`, () => {
      const workflow = blockedWorkflow(stage);
      const facts: AutoFixFacts = { blockCause: "owner-stopped" };
      expect(classifyBlockedWorkflow(workflow, facts)).toEqual([{ class: "person", code: "owner-stopped" }]);
      expect(autoFixDecision(workflow, facts, budget())).toEqual({ action: "ASK", reason: "owner-stopped", codes: ["owner-stopped"] });
      expect(autoFixDecision(workflow, facts, budget({ spend: spend(0, 1000) })).action).toBe("ASK");
      expect(autoFixDecision(blockedWorkflow(stage, { pullRequests: [{}] }), facts, budget()).action).toBe("ASK");
    });
  }

  it("the system move holds the same limits again by itself (a second line of defence behind the policy)", () => {
    const candidate = blockedWorkflow("REVIEW").candidate!;
    const workflow = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId: "8b579b4b-eaa7-4bf2-87bc-6da86b97c9e6", ownerId: "a".repeat(64), now: "2026-10-27T00:00:00.000Z" }),
      revision: 9, stage: "REVIEW", state: "BLOCKED", blockReason: WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, candidate });
    const input = { expectedRevision: 9, stage: "REVIEW" as const, reason: "Rovara retried the reviews by itself.", spend: spend(1), now: "2026-10-27T00:00:00.000Z" };
    expect(workflowAutomaticRetryDecision(workflow, input)).toMatchObject({ source: "AUTO_RETRY", actorRole: "AGENTX", auto: { stage: "REVIEW" } });
    expect(() => workflowAutomaticRetryDecision({ ...workflow, decisions: [WorkflowDecisionRecordSchema.parse({ ...retryDecision("REVIEW", candidate.digest), requestId: randomUUID() })] }, input)).toThrow(/already retried/);
    expect(() => workflowAutomaticRetryDecision(workflow, { ...input, spend: spend(14) })).toThrow(/spend/);
    expect(() => workflowAutomaticRetryDecision(workflow, { ...input, spend: spend(Number.NaN) })).toThrow(/spend/);
  });

  it("a row written by the old code (no cause) is decided as it always was, and a cause this code does not know reads as none", () => {
    const old = (workflowDispatchItem("state", "t", 9, "AUTOFIX", "d".repeat(64), "2026-10-27T00:00:00.000Z") as { Put: { Item: Record<string, unknown> } }).Put.Item;
    expect(autofixBlockCauseOf(old.autofixCause)).toBeUndefined();
    expect(autofixRowHeld(old as never, Date.now())).toBe(false);
    expect(autofixBlockCauseOf("a-newer-cause")).toBeUndefined();
    expect(autofixBlockCauseOf("run-lost")).toBe("run-lost");
    expect(autofixRowHeld({ autofixNotBefore: new Date(Date.now() + 60_000).toISOString() }, Date.now())).toBe(true);
    expect(autofixRowHeld({ autofixNotBefore: new Date(Date.now() - 60_000).toISOString() }, Date.now())).toBe(false);
    expect(autofixRowHeld({ autofixNotBefore: "not a date" }, Date.now())).toBe(false);
    // Without a cause the generic dispatch block is read from its text exactly as before: the checks start that was never confirmed is a person's (nothing readable), the review give-up is transient.
    expect(autoFixDecision(blockedWorkflow("VERIFY"), {}, budget())).toMatchObject({ action: "ASK", reason: "needs-a-person", codes: ["unreadable"] });
    expect(autoFixDecision(blockedWorkflow("REVIEW"), {}, budget())).toMatchObject({ action: "RETRY", stage: "REVIEW", codes: ["review-not-run"] });
    // An ask record written before this change still parses, and the lines it makes are the ones it made.
    const oldAsk = AutoFixAskSchema.parse({ workflowRevision: 4, reason: "retry-limit", codes: ["review-not-run"], at: "2026-10-26T00:00:00.000Z" });
    expect(autoFixCardLines({ decisions: [], revision: 4 }, oldAsk).join("\n")).not.toContain("What failed");
  });
});
