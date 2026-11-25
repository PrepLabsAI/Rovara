// journey-gate: 13b
// Journey 13b: resilience beyond the silent worker (A1-10, D1-PLAN 5.3 G-D). The cases of tests/integration/workflow-e2e/09-resilience.test.ts that journey 13 does not hold and that the core has a behaviour for:
// a code host that fails to answer, the same comment read twice or at once, a write that conflicts, two presses of one Approve, a fix pushed before its machine was lost, a failed run and its retry, a merge
// seen again, a worker too old to push, and a branch reset under Rovara's fix. On the real core and the real worker; the code host and the state table are the only fakes. Which 09 cases are not here, and
// why, is in briefs/arch-cleanup/A1-10-DONE.md. D1 deletes 09-resilience, which this and journey 13 replace in part.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { INTENT_BLOCK_INFO_STRING, PLAN_CLAIMS_MAX, PLAN_CRITIQUE_INFO_STRING, WORKFLOW_PLAN_MAX_BYTES, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED } from "../../packages/contracts/src/index.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { DYNAMODB_ITEM_MAX_BYTES } from "../support/fake-dynamodb.js";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { criticAnswer, decide, failPush, fixUntilPush, landPush, openPullRequest, readFeedback, reviewRound } from "./harness/feedback.js";
import { HEALTH_PLAN, IMPLEMENT_SCRIPT, fenced, planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

const workflow = (w: JourneyWorld, taskId: string) => w.taskRow(taskId)!.workflow as unknown as { stage: string; state: string; revision: number; blockReason?: string; feedbackReview?: { status: string }; pullRequests?: Array<{ headSha: string }>; pullRequestUpdateFailure?: { numbers: number[]; cause: string } };
const where = (w: JourneyWorld, taskId: string) => ({ stage: workflow(w, taskId).stage, state: workflow(w, taskId).state });
const operations = (w: JourneyWorld, mode: string) => w.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === mode).map((row) => String(row.status));
const maintainOperations = (w: JourneyWorld) => w.harness.db.find((row) => row.entityType === "OPERATION" && row.kind === "maintain").map((row) => String(row.status));
const mergeOnHost = (w: JourneyWorld, pullRequest: Awaited<ReturnType<typeof openPullRequest>>["pullRequest"]) => w.harness.world.host.model.merge(pullRequest.draft.id, { revision: pullRequest.commit, method: "squash" }, "octocat");
/** The code host's own feedback read (core/pr-feedback/collect.ts:117, `codeHost.feedback`) fails for the first `times` reads (all of them when omitted). */
function hostReadsFail(w: JourneyWorld, times = Number.POSITIVE_INFINITY): { reads: () => number } {
  const host = w.harness.world.host;
  const read = host.feedback.bind(host);
  let reads = 0;
  host.feedback = async (...args: Parameters<typeof host.feedback>) => { reads += 1; if (reads <= times) throw new Error("the code host answered 500"); return read(...args); };
  return { reads: () => reads };
}
const unavailable = (): never => { throw new Error("model provider unavailable"); };
const pass = async (w: JourneyWorld, count: number) => { for (let index = 0; index < count; index += 1) await w.runJobs(120); };

describe("journey 13b: resilience, the code host, the state table and the owner's presses", () => {
  it("09 9.1: a code host that fails to answer is no word and no review, the poll tries again every pass, and the comment is reviewed once when the host answers", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    const failing = hostReadsFail(w, 3);
    w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    await pass(w, 3);
    expect({ reads: failing.reads(), review: workflow(w, taskId).feedbackReview?.status, runs: operations(w, "FEEDBACK_REVIEW") }, "three failed reads: nothing collected, nothing run").toEqual({ reads: 3, review: undefined, runs: [] });
    expect(where(w, taskId)).toEqual({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    await pass(w, 1);
    expect(workflow(w, taskId).feedbackReview?.status, "the host answered: the comment is collected").toBe("COLLECTING");
    const reviewed = await w.runStep("FEEDBACK_REVIEW", [criticAnswer()]);
    expect(reviewed.operation.status, String(reviewed.operation.error)).toBe("SUCCEEDED");
    expect(operations(w, "FEEDBACK_REVIEW"), "one review").toEqual(["SUCCEEDED"]);
    expect((await readFeedback(w, taskId)).findings, "one finding for the one comment").toHaveLength(1);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.2: a code host that never answers the feedback read does not stop the task: no review ever starts, and the merge on the host still completes it", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    const failing = hostReadsFail(w);
    w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    await pass(w, 8);
    expect(failing.reads(), "the poll kept trying").toBeGreaterThanOrEqual(8);
    expect({ ...where(w, taskId), runs: operations(w, "FEEDBACK_REVIEW") }).toEqual({ stage: "WAIT_FOR_MERGE", state: "WAITING", runs: [] });
    expect(mergeOnHost(w, pullRequest)).toMatchObject({ outcome: "merged" });
    await pass(w, 2);
    expect(where(w, taskId), "the task reads merged").toEqual({ stage: "MERGED", state: "COMPLETE" });
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.3: the same comment read by passes that run at the same moment starts one review", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    await Promise.all([w.runJobs(120), w.runJobs(), w.runJobs()]);
    await w.runJobs(120);
    expect((await w.runStep("FEEDBACK_REVIEW", [criticAnswer()])).operation.status).toBe("SUCCEEDED");
    // The core asks for nothing more: no second review is waiting to be dispatched.
    await w.harness.runtime.flow.sweepOnce();
    await w.harness.runtime.flow.relayOnce();
    await w.harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
    expect(operations(w, "FEEDBACK_REVIEW")).toEqual(["SUCCEEDED"]);
    expect((await readFeedback(w, taskId)).findings).toHaveLength(1);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.4: a write that conflicts while the feedback is recorded is tried again, with one review and one finding", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    // The state table's first transaction that records the collected feedback is cancelled on a failed condition, as a concurrent writer would make it.
    const wire = w.harness.wire;
    const send = wire.send.bind(wire);
    const seen = { recording: 0, cancelled: 0 };
    wire.send = (async (command: { constructor: { name: string }; input?: unknown }, ...rest: unknown[]) => {
      if (command.constructor.name === "TransactWriteItemsCommand" && JSON.stringify(command.input ?? {}).includes("COLLECTING")) {
        seen.recording += 1;
        if (seen.cancelled === 0) { seen.cancelled += 1; throw Object.assign(new Error("The transaction was cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "ConditionalCheckFailed" }] }); }
      }
      return (send as (...args: unknown[]) => unknown)(command, ...rest);
    });
    await pass(w, 3);
    expect(seen, "the recording write was cancelled once and tried again").toEqual({ recording: 2, cancelled: 1 });
    expect((await w.runStep("FEEDBACK_REVIEW", [criticAnswer()])).operation.status).toBe("SUCCEEDED");
    expect(operations(w, "FEEDBACK_REVIEW"), "one review").toEqual(["SUCCEEDED"]);
    expect((await readFeedback(w, taskId)).findings).toHaveLength(1);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.6: two presses of Approve on the plan at the same moment record one decision and start one coding run", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    const listed = await w.maya("GET", "/v1/app/decisions");
    const card = (listed.body.cards as Array<{ id: string; taskId?: string; risk: string }>).find((item) => item.taskId === taskId)!;
    const shownDigest = (listed.body.digests as Record<string, string>)[card.id]!;
    const path = card.id.replace(":", "/");
    expect(card.risk, "a low-risk card needs no evidence press").toBe("low");
    const presses = await Promise.all([1, 2].map(() => w.maya("POST", `/v1/app/decisions/${path}/approve`, { shownDigest, requestId: randomUUID() })));
    expect(presses.map((press) => [press.status, press.status === 200 ? "approved" : (press.body.error as { message: string }).message]).sort(), "one press approves, the other is told the decision is no longer waiting")
      .toEqual([[200, "approved"], [404, "This decision is no longer waiting for you."]]);
    expect((await w.runStep("IMPLEMENT", IMPLEMENT_SCRIPT)).operation.status).toBe("SUCCEEDED");
    await w.harness.runtime.flow.sweepOnce();
    await w.harness.runtime.flow.relayOnce();
    await w.harness.runtime.flow.dispatchOnce({ waitSeconds: 0 });
    expect(operations(w, "IMPLEMENT"), "one coding run").toEqual(["SUCCEEDED"]);
    expect(w.harness.world.host.model.changeRequests, "no pull request yet: the run is still being checked and reviewed").toHaveLength(0);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.8: a fix whose push reached the code host before its machine was lost is recognised: the task waits for the merge on the pushed head, and nothing is pushed twice", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    const model = w.harness.world.host.model;
    model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    const card = await reviewRound(w, taskId);
    expect((await decide(w, taskId, card, "APPROVE")).status).toBe(200);
    const push = await fixUntilPush(w, "mv repo/demo/health.txt repo/demo/status.txt");
    // The worker's push lands on the host (its branch moves to the fix), and the machine is lost before the worker calls back.
    const landed = await landPush(w, push, { callbacks: false });
    await w.harness.world.machines.terminate(push.machineId);
    const reports = [];
    for (let pass = 0; pass < 4; pass += 1) { w.harness.world.clock.advance(100); reports.push(await w.harness.runtime.flow.sweepRunsOnce()); await w.harness.runtime.flow.sweepOnce(); }
    expect(reports.map((report) => report.interrupted), "interrupted once, after the grace period").toEqual([0, 0, 1, 0]);
    expect(maintainOperations(w), "the push ran once and was not asked for again").toEqual(["INTERRUPTED"]);
    expect(where(w, taskId), "the task waits for the merge").toEqual({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(workflow(w, taskId).pullRequests!.map((entry) => entry.headSha), "on the head the host shows").toEqual([landed.commit]);
    expect(model.branches.get(push.expected.headBranch)).toBe(landed.commit);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.10 (planning): a planning run that fails says so and the owner's retry plans again; KNOWN GAP, pinned: the retried plan then cannot be approved (the card says only \"isn't ready\", the spend being unknown), see A1-10-DONE.md", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await w.prepare(taskId);
    const understood = await w.runStep("UNDERSTAND", [fauxAssistantMessage(fenced(INTENT_BLOCK_INFO_STRING, { kind: "ready", path: "QUICK", restatement: "Add a health endpoint.", assumptions: [] }))]);
    expect(understood.operation.status).toBe("SUCCEEDED");
    const failedPlan = await w.runStep("PLAN", [unavailable, unavailable, unavailable, unavailable]);
    expect(failedPlan.operation.status).toBe("FAILED");
    expect(where(w, taskId)).toEqual({ stage: "PLAN", state: "BLOCKED" });
    expect(workflow(w, taskId).blockReason, "what the owner reads").toMatch(/^Rovara stopped while planning: RUNTIME_UNAVAILABLE: the model call failed/u);
    const retried = await w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: workflow(w, taskId).revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    expect(where(w, taskId), "planning runs again").toEqual({ stage: "PLAN", state: "RUNNING" });
    expect((await w.runStep("PLAN", [fauxAssistantMessage(HEALTH_PLAN)])).operation.status).toBe("SUCCEEDED");
    expect((await w.runStep("PLAN_CRITIQUE", [fauxAssistantMessage(fenced(PLAN_CRITIQUE_INFO_STRING, { verdict: "ok", points: [] }))])).operation.status).toBe("SUCCEEDED");
    expect(where(w, taskId), "the plan waits for the owner").toEqual({ stage: "PLAN_REVIEW", state: "WAITING" });
    // KNOWN GAP: the failed run left the task's spend unread ("Rovara cannot tell what this task has spent, so it does not start more work on it": core/decisions/approval-gate.ts's SubjectRefusal, thrown from the
    // spend read), and two hours of jobs do not settle it. The owner's Approve is answered 409 with the card's generic words, not those. It turns green with a fix that settles a failed run's spend or says why.
    for (let index = 0; index < 4; index += 1) await w.runJobs(1800);
    const listed = await w.maya("GET", "/v1/app/decisions");
    const card = (listed.body.cards as Array<{ id: string; taskId?: string }>).find((item) => item.taskId === taskId)!;
    const approved = await w.maya("POST", `/v1/app/decisions/${card.id.replace(":", "/")}/approve`, { shownDigest: (listed.body.digests as Record<string, string>)[card.id], requestId: randomUUID() });
    expect({ status: approved.status, error: approved.body.error }).toEqual({ status: 409, error: { code: "MERGE_NOT_READY", message: "This isn't ready to be decided yet." } });
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.10 (coding): a coding run that fails is said in the task's own words, and the owner's retry codes again", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    await w.approvePlan(taskId);
    const failedCode = await w.runStep("IMPLEMENT", [unavailable, unavailable, unavailable, unavailable]);
    expect(failedCode.operation.status).toBe("FAILED");
    expect(where(w, taskId)).toEqual({ stage: "IMPLEMENT", state: "BLOCKED" });
    const reason = workflow(w, taskId).blockReason;
    expect(reason, "what the owner reads").toBe("implementation operation ended failed");
    const retried = await w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/retry`, { requestId: randomUUID(), expectedRevision: workflow(w, taskId).revision, instructions: "Try again." });
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    expect(where(w, taskId), "coding runs again").toEqual({ stage: "IMPLEMENT", state: "RUNNING" });
    const again = await w.runStep("IMPLEMENT", IMPLEMENT_SCRIPT);
    expect(again.operation.status, String(again.operation.error)).toBe("SUCCEEDED");
    expect(operations(w, "IMPLEMENT"), "the failed run is kept on the record beside the retry").toEqual(["FAILED", "SUCCEEDED"]);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.14: a merge read again after completion, and a comment after it, change nothing", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    expect(mergeOnHost(w, pullRequest)).toMatchObject({ outcome: "merged" });
    await pass(w, 2);
    expect(where(w, taskId)).toEqual({ stage: "MERGED", state: "COMPLETE" });
    const revision = workflow(w, taskId).revision;
    const operationsBefore = w.harness.db.find((row) => row.entityType === "OPERATION").length;
    await pass(w, 2);
    w.harness.world.host.model.addDiscussionComment(pullRequest.draft.id, "priya", "Nice work.");
    await pass(w, 2);
    expect({ ...where(w, taskId), revision: workflow(w, taskId).revision }, "nothing about the task moved").toEqual({ stage: "MERGED", state: "COMPLETE", revision });
    expect(w.harness.db.find((row) => row.entityType === "OPERATION"), "no operation was started").toHaveLength(operationsBefore);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.17: a worker too old to push the reviewed fix is said as such in the task's record, nothing is pushed, and the merge is still followed", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    const model = w.harness.world.host.model;
    model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    const card = await reviewRound(w, taskId);
    expect((await decide(w, taskId, card, "APPROVE")).status).toBe(200);
    const push = await fixUntilPush(w, "mv repo/demo/health.txt repo/demo/status.txt");
    expect((await failPush(w, push, WORKFLOW_PULL_REQUEST_UPDATE_WORKER_OUTDATED)).status).toBe(200);
    expect(where(w, taskId)).toEqual({ stage: "WAIT_FOR_MERGE", state: "BLOCKED" });
    expect(workflow(w, taskId).pullRequestUpdateFailure, "the record names the cause: a worker that is out of date, not a refused push").toEqual({ numbers: [1], cause: "WORKER_OUTDATED" });
    expect(model.branches.get(push.expected.headBranch), "nothing reached the branch").toBe(push.expected.expectedHeadCommit);
    expect(mergeOnHost(w, pullRequest)).toMatchObject({ outcome: "merged" });
    await pass(w, 2);
    expect(where(w, taskId), "the merge is still followed").toEqual({ stage: "MERGED", state: "COMPLETE" });
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.18: a large plan (twenty long claims, ten long notes and risks) is planned, approved and built from, and the task's record stays within the state table's item limit", async () => {
    world = await createJourneyWorld();
    const w = world;
    const claims = Array.from({ length: Math.min(PLAN_CLAIMS_MAX, 20) }, (_, index) => ({ id: String(index + 1), text: `Step ${index + 1}: ${"change the greeting so it reads well; ".repeat(12)}`.slice(0, index === 0 ? 220 : 300).trim() + (index === 0 ? " The change is in health.txt, and tests/health.test.ts covers it." : "") }));
    const long = (length: number, index: number) => `${index + 1}. ${"Keep every greeting short and friendly for each user. ".repeat(12)}`.slice(0, length).trim();
    const big = planAnswer(planDocument({ title: "Big plan", claims, decisions: [], why: Array.from({ length: 10 }, (_, index) => ({ text: long(500, index), author: "Maya" })),
      risks: Array.from({ length: 10 }, (_, index) => long(200, index)) }),
    { checks: { checks: [{ label: "node runs", cwd: "repo/demo", executable: "node", args: ["--version"], proves: [...claims.map((claim) => claim.id), "nc1"] }], none_reason: null } });
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(WORKFLOW_PLAN_MAX_BYTES * 0.25);
    expect(Buffer.byteLength(big, "utf8")).toBeLessThan(WORKFLOW_PLAN_MAX_BYTES);
    // (Fifty claims, the document's limit, with a check proving them all is asked again by the planner check in this fixture, so the journey uses twenty; the limit itself is a contracts unit test.)
    const taskId = await startTask(w);
    await planUntilCard(w, taskId, { plan: big });
    await w.approvePlan(taskId);
    expect((await w.runStep("IMPLEMENT", IMPLEMENT_SCRIPT)).operation.status, "the build starts from the big plan").toBe("SUCCEEDED");
    const task = w.harness.db.get(`DEVTASK#${taskId}`, "META")!;
    expect(Buffer.byteLength(JSON.stringify(task), "utf8"), "the task's row is well inside the item limit").toBeLessThan(DYNAMODB_ITEM_MAX_BYTES);
    w.proof.assertAllCore();
  }, 240_000);

  it("09 9.19: the branch is reset below Rovara's fix: today the collector reads feedback on a head it did not push as unchanged, so a new comment starts no review, nothing is pushed, and the owner is told nothing (FINDING, see A1-10-DONE.md)", async () => {
    world = await createJourneyWorld();
    const w = world;
    const { taskId, pullRequest } = await openPullRequest(w);
    const model = w.harness.world.host.model;
    const opened = pullRequest.commit;
    model.addDiscussionComment(pullRequest.draft.id, "priya", "Please trim the name.");
    const card = await reviewRound(w, taskId);
    expect((await decide(w, taskId, card, "APPROVE")).status).toBe(200);
    const push = await fixUntilPush(w, "mv repo/demo/health.txt repo/demo/status.txt");
    const fix = await landPush(w, push);
    expect(workflow(w, taskId).pullRequests!.map((entry) => entry.headSha)).toEqual([fix.commit]);
    // Someone resets the branch to the commit before the fix, then comments.
    model.branches.set(push.expected.headBranch, opened);
    model.addDiscussionComment(pullRequest.draft.id, "priya", "Why was this undone?");
    await pass(w, 6);
    // core/pr-feedback/collect.ts:98 (FeedbackHeadMoved) and :187 ("unchanged"): the head differs from the recorded one, so the feedback is not collected.
    expect({ ...where(w, taskId), review: workflow(w, taskId).feedbackReview?.status, runs: operations(w, "FEEDBACK_REVIEW") }).toEqual({ stage: "WAIT_FOR_MERGE", state: "WAITING", review: undefined, runs: ["SUCCEEDED"] });
    expect(maintainOperations(w), "no second push").toEqual(["SUCCEEDED"]);
    w.proof.assertAllCore();
  }, 240_000);
});
