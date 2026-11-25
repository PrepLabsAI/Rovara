// journey-gate: 14
// Journey 14: reviews in depth (D1-PLAN 5.3, G-B). The behaviours of the old suite tests/integration/workflow-e2e/05-reviews.test.ts that no other journey holds, on the real core and the real worker:
// a review that cannot finish (its answer unreadable, its time up) and the owner's Retry; a security finding is never advisory; more blocking findings than Resolve findings takes; a finding the owner accepted
// that the reviews raise again on new code; a change too large to show the reviewers in full; a review run that returns one report of two; reviews that cannot be started; an older issue in an untouched file. D1 deletes 05-reviews.test.ts when this lands. Every expectation is what the code does TODAY (file and line in the
// comments), seen the way the owner sees it: the task read, the owner's own routes, the pull request's body. See briefs/arch-cleanup/A1-9-DONE.md for what the old suite held that the core does not.
//
// What the core does that the old suite did not know: a review that FOUND problems is sent back to coding by Rovara itself twice per approved plan (contracts workflow-autofix.ts:353, task-workflow.ts:659) before
// the owner is asked, so a finding reaches the owner on the third review of a task. Each case therefore runs the real coding and review steps three times where it needs the owner to decide.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, openReviewFindings, type WorkflowSnapshot } from "../../packages/contracts/src/index.js";
import { createJourneyWorld, type JourneyWorld } from "./harness/hosted-core.js";
import { findings, reviewerSteps, type ReviewerScript } from "./harness/reviews.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";
import { planUntilCard, startTask } from "./harness/task.js";

let world: JourneyWorld | undefined;
afterEach(async () => { await world?.close(); world = undefined; });

/** The coding step of round `round`: the worker's real bash tool writes health.txt, with different content each round so each round is new code (a new candidate). */
const code = (round: number) => [fauxAssistantMessage([fauxToolCall("bash", { command: `printf round${String(round)} > repo/demo/health.txt` })], { stopReason: "toolUse" }), fauxAssistantMessage("I changed the health file.")];

/** What the owner reads of the task: the workflow the web page is drawn from (the developer route's task read; its reviews, findings, decisions and block reason). */
async function flowOf(w: JourneyWorld, taskId: string): Promise<WorkflowSnapshot> {
  const read = await w.maya("GET", `/v1/dev/tasks/${taskId}`);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return (read.body.task as { workflow: WorkflowSnapshot }).workflow;
}
/** What Rovara recorded about why it stopped and asked the owner (the ask card's record on the task row). */
const askOf = (w: JourneyWorld, taskId: string) => (w.harness.db.get(`DEVTASK#${taskId}`, "META") as { autofixAsk?: { reason: string; codes: string[]; workflowRevision: number } } | undefined)?.autofixAsk;
const operationsOf = (w: JourneyWorld, mode: string) => w.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === mode).map((row) => String(row.status));
const sources = (workflow: WorkflowSnapshot) => workflow.decisions.map((decision) => `${String(decision.source)}/${decision.decision}/${decision.actorRole}`);

/** Start a task, take it to the approved plan, and run the coding and review steps `rounds` times (each round's review answers by `script`); the reviews of the last round are what the owner reads. */
async function reviewed(w: JourneyWorld, script: ReviewerScript, rounds = 1): Promise<string> {
  const taskId = await startTask(w);
  await planUntilCard(w, taskId);
  await w.approvePlan(taskId);
  for (let round = 1; round <= rounds; round += 1) {
    const built = await w.runStep("IMPLEMENT", code(round));
    expect(built.operation.status, String(built.operation.error)).toBe("SUCCEEDED");
    const review = await w.runStep("REVIEW", reviewerSteps(script));
    expect(review.operation.status, String(review.operation.error)).toBe("SUCCEEDED");
  }
  return taskId;
}

/** The owner's Retry of the blocked reviews, as the web page sends it: the revision and the candidate it showed (manual-review.ts:46-53 refuses any other). */
const retryReviews = (w: JourneyWorld, taskId: string, flow: WorkflowSnapshot, overrides: { expectedRevision?: number } = {}) => w.maya("POST", `/v1/dev/tasks/${taskId}/workflow/retry`,
  { requestId: randomUUID(), instructions: "Run the reviews again.", expectedRevision: overrides.expectedRevision ?? flow.revision, candidateDigest: flow.candidate!.digest });

/** The answer to every open finding as `action`, at the revision and candidate the owner saw. */
const answers = (flow: WorkflowSnapshot, action: "ACCEPT" | "FIX", note: string, count?: number) => ({ requestId: randomUUID(), expectedRevision: flow.revision, candidateDigest: flow.candidate!.digest,
  resolutions: openReviewFindings(flow).slice(0, count).map((finding) => ({ findingId: finding.findingId, action, note })) });

describe("journey 14: reviews in depth", () => {
  it("a code review whose answer cannot be read blocks the task and says so, nothing goes to the code host, Rovara does not retry by itself, and the owner's Retry runs the reviews again on the same code and opens the pull request", async () => {
    world = await createJourneyWorld();
    // The reviewer answers in prose, and again in prose when the worker asks for JSON (a prose answer is two calls).
    const taskId = await reviewed(world, { CODE: ["PROSE", "PROSE"] });
    const blocked = await flowOf(world, taskId);
    // The owner reads: the reviews are blocked, the code review has no verdict (UNKNOWN, INVALID_JSON), the security review passed.
    expect({ stage: blocked.stage, state: blocked.state, reason: blocked.blockReason }, "what the owner reads").toEqual({ stage: "REVIEW", state: "BLOCKED", reason: "the code review did not pass" });
    expect(blocked.reviews!.map((review) => `${review.role}:${review.status}:${String(review.failureReason)}`).sort(), "which review could not finish").toEqual(["CRITIC:UNKNOWN:INVALID_JSON", "SECURITY:PASS:undefined"]);
    expect(openReviewFindings(blocked), "no finding to resolve: the review gave none").toEqual([]);
    // An unreadable answer is a review nobody can use, so it asks the owner at once: Rovara does not rerun it by itself (workflow-autofix.ts:230-246, class `person`; only a timeout or a lost run is retried).
    expect({ reason: askOf(world, taskId)?.reason, codes: askOf(world, taskId)?.codes }, "Rovara asked, not retried").toEqual({ reason: "needs-a-person", codes: ["review-unusable"] });
    expect(sources(blocked), "no automatic decision was taken").toEqual(["undefined/APPROVE/TASK_OWNER"]);
    expect(operationsOf(world, "REVIEW"), "one review run so far").toEqual(["SUCCEEDED"]);
    expect({ pullRequests: world.harness.world.host.model.changeRequests.length, publishRuns: world.harness.db.find((row) => row.entityType === "OPERATION" && row.kind === "publish").length }, "nothing was sent to the code host").toEqual({ pullRequests: 0, publishRuns: 0 });
    // A Retry that was drawn for an older revision is refused in words and changes nothing; the page's own fence (manual-review.ts:52).
    const stale = await retryReviews(world, taskId, blocked, { expectedRevision: blocked.revision - 1 });
    expect({ status: stale.status, code: (stale.body.error as { code: string }).code, message: (stale.body.error as { message: string }).message }, "a stale Retry").toEqual({ status: 409, code: "IDEMPOTENCY_CONFLICT", message: "the review retry is stale; refresh the task and use its current candidate and revision" });
    expect((await flowOf(world, taskId)).revision, "nothing moved").toBe(blocked.revision);
    // The owner presses Retry: the reviews run again on the SAME code (the candidate does not change), no coding runs, and now the reviewer answers.
    const retried = await retryReviews(world, taskId, blocked);
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    const again = await world.runStep("REVIEW", reviewerSteps({}));
    expect(again.operation.status, String(again.operation.error)).toBe("SUCCEEDED");
    const passed = await flowOf(world, taskId);
    expect({ stage: passed.stage, state: passed.state, sameCode: passed.candidate!.digest === blocked.candidate!.digest }, "the retry passed on the same code").toEqual({ stage: "PULL_REQUEST", state: "READY", sameCode: true });
    expect(operationsOf(world, "IMPLEMENT"), "Retry reviews wrote no code").toEqual(["SUCCEEDED"]);
    await world.publish();
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    world.proof.assertAllCore();
  }, 180_000);

  it("a security review that runs out of time is retried once by Rovara itself, and when it runs out of time again the owner is asked and Retry opens the pull request", async () => {
    // The worker's review time limit, short (as the old suite's reviewMs did); the faux security reviewer never answers until it is stopped.
    world = await createJourneyWorld({ workerTimeouts: { reviewMs: 1500 } });
    const taskId = await reviewed(world, { SECURITY: ["HANG"] });
    // A timeout is a hiccup, so Rovara reruns the reviews once by itself (workflow-autofix.ts:228 TIMEOUT is transient; :354 the retry limit is 1, task-workflow.ts:661).
    const retrying = await flowOf(world, taskId);
    expect({ stage: retrying.stage, state: retrying.state, decisions: sources(retrying) }, "Rovara reran the reviews by itself").toEqual({ stage: "REVIEW", state: "RUNNING", decisions: ["undefined/APPROVE/TASK_OWNER", "AUTO_RETRY/REQUEST_CHANGES/AGENTX"] });
    const second = await world.runStep("REVIEW", reviewerSteps({ SECURITY: ["HANG"] }));
    expect(second.operation.status, String(second.operation.error)).toBe("SUCCEEDED");
    const blocked = await flowOf(world, taskId);
    expect({ stage: blocked.stage, state: blocked.state, reason: blocked.blockReason }, "what the owner reads").toEqual({ stage: "REVIEW", state: "BLOCKED", reason: "the security review did not pass" });
    expect(blocked.reviews!.map((review) => `${review.role}:${review.status}:${String(review.failureReason)}`).sort(), "the security review ran out of time, the code review passed").toEqual(["CRITIC:PASS:undefined", "SECURITY:UNKNOWN:TIMEOUT"]);
    expect({ reason: askOf(world, taskId)?.reason, codes: askOf(world, taskId)?.codes }, "the one automatic retry is used, so the owner is asked").toEqual({ reason: "retry-limit", codes: ["review-run-failed"] });
    expect(world.harness.world.host.model.changeRequests.length, "nothing was sent to the code host").toBe(0);
    const retried = await retryReviews(world, taskId, blocked);
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    expect((await world.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    expect(await flowOf(world, taskId), "the retry passed").toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    await world.publish();
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    expect(operationsOf(world, "IMPLEMENT"), "no code was rewritten").toEqual(["SUCCEEDED"]);
    world.proof.assertAllCore();
  }, 180_000);

  it("a security finding is never advisory: the reviewer's advisory flag is ignored on it and it blocks, a code finding marked advisory does not; a tool token cannot accept it (the web page alone can), and the pull request says the owner accepted it", async () => {
    world = await createJourneyWorld();
    // Both reviewers mark their one finding advisory, three rounds running (Rovara sends the first two back to coding itself).
    const taskId = await reviewed(world, { CODE: [findings("Code", 1, { advisory: true })], SECURITY: [findings("Security", 1, { severity: "HIGH", advisory: true })] }, 3);
    const flow = await flowOf(world, taskId);
    expect({ stage: flow.stage, state: flow.state, reason: flow.blockReason, decisions: sources(flow) }, "two automatic send-backs, then the owner").toEqual({ stage: "REVIEW", state: "BLOCKED", reason: "the security review did not pass",
      decisions: ["undefined/APPROVE/TASK_OWNER", "AUTO_FIX/REQUEST_CHANGES/AGENTX", "AUTO_FIX/REQUEST_CHANGES/AGENTX"] });
    expect(askOf(world, taskId), "Rovara stopped at its send-back limit").toMatchObject({ reason: "send-back-limit", codes: ["review-findings"] });
    // task-workflow.ts:273-275 `findingBlocks`: "A security finding is never advisory: the flag is ignored on it". The code review's advisory finding is kept and does not block.
    expect(flow.reviews!.map((review) => `${review.role}:${review.status}:${String(review.findings.length)}`).sort()).toEqual(["CRITIC:PASS:1", "SECURITY:FINDINGS:1"]);
    const open = openReviewFindings(flow);
    expect(open.map((finding) => `${finding.role}: ${finding.text}`), "the only blocking finding is the security one").toEqual(["SECURITY: Security finding 1: line 1 is not trimmed."]);
    // A tool's token (the laptop's CLI, an AI tool) may not accept a security finding: refused in fixed words, nothing written (security-accept.ts:18-25; the developer route is always `api-token`: dev-routes.ts:512).
    const viaTool = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/review-findings`, answers(flow, "ACCEPT", "Known."));
    expect({ status: viaTool.status, code: (viaTool.body.error as { code: string }).code, message: (viaTool.body.error as { message: string }).message }, "a tool's accept").toEqual({ status: 403, code: "FORBIDDEN", message: "Accepting a security finding needs the Rovara web page" });
    const untouched = await flowOf(world, taskId);
    expect({ revision: untouched.revision, accepted: untouched.acceptedFindings ?? [], state: untouched.state }, "nothing was written").toEqual({ revision: flow.revision, accepted: [], state: "BLOCKED" });
    // The task page's own route accepts it, with the owner's reason (dev-routes.ts:738-741, via "page"); the draft pull request is due.
    const viaPage = await world.maya("POST", `/v1/app/tasks/${taskId}/review-findings`, answers(flow, "ACCEPT", "Known."));
    expect(viaPage.status, JSON.stringify(viaPage.body).slice(0, 300)).toBe(200);
    const accepted = await flowOf(world, taskId);
    expect({ stage: accepted.stage, state: accepted.state, last: sources(accepted).at(-1), reasons: (accepted.acceptedFindings ?? []).map((entry) => `${entry.role}:${entry.reason}`) }, "accepted by the owner on the page").toEqual({ stage: "PULL_REQUEST", state: "READY", last: "FINDINGS/APPROVE/TASK_OWNER", reasons: ["SECURITY:Known."] });
    const pullRequest = await world.publish();
    const body = pullRequest.draft.body ?? "";
    expect(body, "the pull request says the owner accepted it, who, and where").toContain("- [security] Security finding 1: line 1 is not trimmed. — accepted: Known. (by Maya Chen via the task page)");
    expect(body).toContain("Security review passed after the owner accepted its findings.");
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    world.proof.assertAllCore();
  }, 180_000);

  it("more blocking findings than Resolve findings takes (25: the code review's 20 and the security review's 5): a resolve of all of them and a resolve of 20 are both refused in words and move nothing, and Send back is the way on", async () => {
    world = await createJourneyWorld();
    // A reviewer's report keeps at most 20 findings: 20 from the code review and 5 from the security review, three rounds running.
    const taskId = await reviewed(world, { CODE: [findings("Code", 20)], SECURITY: [findings("Security", 5)] }, 3);
    const flow = await flowOf(world, taskId);
    expect({ stage: flow.stage, state: flow.state, reason: flow.blockReason }).toEqual({ stage: "REVIEW", state: "BLOCKED", reason: "the code and security reviews did not pass" });
    expect(openReviewFindings(flow), "25 blocking findings wait for the owner").toHaveLength(25);
    const refusal = (reply: { status: number; body: Record<string, unknown> }) => ({ status: reply.status, code: (reply.body.error as { code: string }).code, message: (reply.body.error as { message: string }).message });
    // The same two refusals on the laptop's route and on the task page's own route. The request's list holds at most 20 (task-workflow-node.ts:2698-2699) ...
    for (const route of [`/v1/dev/tasks/${taskId}/workflow/review-findings`, `/v1/app/tasks/${taskId}/review-findings`]) {
      expect(refusal(await world.maya("POST", route, answers(flow, "FIX", "", 25))), `all 25 on ${route.slice(0, 8)}`).toEqual({ status: 400, code: "CONFIG_INVALID", message: "resolutions: resolve at most 20 findings at once" });
      // ... and 20 of the 25 leaves five unanswered, which the move refuses by pointing at Send back (task-workflow-node.ts:2737).
      expect(refusal(await world.maya("POST", route, answers(flow, "FIX", "", 20))), `20 of 25 on ${route.slice(0, 8)}`).toEqual({ status: 400, code: "CONFIG_INVALID",
        message: "there are 25 blocking findings and AgentX resolves at most 20 at once; send the change back to coding instead" });
    }
    const unmoved = await flowOf(world, taskId);
    expect({ revision: unmoved.revision, state: unmoved.state, decisions: sources(unmoved).length, accepted: unmoved.acceptedFindings ?? [] }, "nothing moved, nothing was decided").toEqual({ revision: flow.revision, state: "BLOCKED", decisions: 3, accepted: [] });
    // Send back to coding takes any number of findings (the owner's words go with it); the coding step is due again.
    const sentBack = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/send-back`, { requestId: randomUUID(), expectedRevision: flow.revision, instructions: "Trim every name." });
    expect(sentBack.status, JSON.stringify(sentBack.body).slice(0, 300)).toBe(200);
    const after = await flowOf(world, taskId);
    expect({ stage: after.stage, state: after.state, last: `${String(after.decisions.at(-1)?.source)}/${after.decisions.at(-1)?.reason}` }, "back to coding with the owner's words").toEqual({ stage: "IMPLEMENT", state: "RUNNING", last: "SEND_BACK/Trim every name." });
    world.proof.assertAllCore();
  }, 180_000);

  it("a finding the owner accepted is the owner's to decide again when the reviews raise it on new code: it is accepted for that code only, so the fixed code blocks again until the owner answers again", async () => {
    world = await createJourneyWorld();
    const [first, second] = findings("Code", 2) as [ReturnType<typeof findings>[number], ReturnType<typeof findings>[number]];
    // Round 3's review raises two code findings and the owner is asked.
    const taskId = await reviewed(world, { CODE: [[first, second]] }, 3);
    const flow = await flowOf(world, taskId);
    const open = openReviewFindings(flow);
    expect(open.map((finding) => finding.text)).toEqual([first.text, second.text]);
    // The owner accepts the first (a code finding: a tool's token may) and sends the second back to fix; the accept is recorded for THIS candidate (task-workflow-node.ts:2705, task-workflow.ts:301-308).
    const decided = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/review-findings`, { requestId: randomUUID(), expectedRevision: flow.revision, candidateDigest: flow.candidate!.digest,
      resolutions: [{ findingId: open[0]!.findingId, action: "ACCEPT", note: "Callers already trim the name." }, { findingId: open[1]!.findingId, action: "FIX", note: "Trim it." }] });
    expect(decided.status, JSON.stringify(decided.body).slice(0, 300)).toBe(200);
    const fixing = await flowOf(world, taskId);
    expect({ stage: fixing.stage, state: fixing.state, accepted: (fixing.acceptedFindings ?? []).map((entry) => `${entry.candidateDigest === flow.candidate!.digest}:${entry.reason}`) }, "the fix is coding again; the accept belongs to the old code").toEqual({ stage: "IMPLEMENT", state: "RUNNING", accepted: ["true:Callers already trim the name."] });
    // The fix is new code; the reviews raise the accepted finding on it again (and not the fixed one).
    expect((await world.runStep("IMPLEMENT", code(4))).operation.status).toBe("SUCCEEDED");
    expect((await world.runStep("REVIEW", reviewerSteps({ CODE: [[first]] }))).operation.status).toBe("SUCCEEDED");
    const again = await flowOf(world, taskId);
    expect(again.candidate!.digest, "new code").not.toBe(flow.candidate!.digest);
    expect({ stage: again.stage, state: again.state, open: openReviewFindings(again).map((finding) => finding.text) }, "the accepted finding blocks the new code again").toEqual({ stage: "REVIEW", state: "BLOCKED", open: [first.text] });
    expect(world.harness.world.host.model.changeRequests.length, "nothing was sent to the code host").toBe(0);
    // Only the owner's new answer lets the new code through: accepted again, for the new candidate.
    const acceptedAgain = await world.maya("POST", `/v1/dev/tasks/${taskId}/workflow/review-findings`, answers(again, "ACCEPT", "Still fine: callers trim it."));
    expect(acceptedAgain.status, JSON.stringify(acceptedAgain.body).slice(0, 300)).toBe(200);
    const done = await flowOf(world, taskId);
    expect({ stage: done.stage, state: done.state, candidates: new Set((done.acceptedFindings ?? []).map((entry) => entry.candidateDigest)).size }, "two accepts, one per code").toEqual({ stage: "PULL_REQUEST", state: "READY", candidates: 2 });
    world.proof.assertAllCore();
  }, 240_000);

  it("a change too large to show the reviewers in full is said to the owner and in the pull request: both reviews are marked partial, and the pull request tells the reviewer to read the rest by hand", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    // The reviewers are shown at most 120,000 bytes of the change (worker verification/review.ts:621); the coding step may hand over at most 200,000 (broker services/callbacks.ts:74,160: a bigger change fails
    // the coding step, see A1-9-DONE.md). A file of 3,000 lines is in between.
    // The file goes through the worker's real write tool, its whole content in the model's tool call (as the old suite's 5.12 wrote it through the model's edits), so the run's event log is under test too.
    const bigFile = `${Array.from({ length: 3000 }, (_, index) => `export const line${String(index)} = 1; // ${"x".repeat(30)}`).join("\n")}\n`;
    const built = await world.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("write", { path: "repo/demo/big.ts", content: bigFile })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the big file.")]);
    expect(built.operation.status, String(built.operation.error)).toBe("SUCCEEDED");
    // Old 5.12's guard: the run's event log stayed small, no event near DynamoDB's 400 KB item limit and no streamed copy of every prefix of the big write (operation events: task-flow/keys.ts:15-16).
    const events = world.harness.db.find((item) => typeof item.sk === "string" && item.sk.startsWith("EVENT#")).map((item) => Buffer.byteLength(JSON.stringify(item), "utf8"));
    expect(events.length, "the run's events are stored").toBeGreaterThan(0);
    expect(Math.max(...events), "no event near the item limit").toBeLessThan(80 * 1024);
    expect(events.reduce((total, size) => total + size, 0), "no streamed copy of the big write").toBeLessThan(512 * 1024);
    const size = statSync(join(world.repository, "big.ts")).size;
    expect(size, "the file is more than the reviewers are shown and less than the coding step can hand over").toBeGreaterThan(120_000);
    expect(size + 3_000, "with the diff's one marker per line, under what the coding step can hand over").toBeLessThan(200_000);
    expect((await world.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    const flow = await flowOf(world, taskId);
    expect({ stage: flow.stage, state: flow.state, partial: flow.reviews!.map((review) => `${review.role}:${review.status}:${String(review.partialDiff)}`).sort() }, "the reviews passed, and both saw part of the change").toEqual({ stage: "PULL_REQUEST", state: "READY", partial: ["CRITIC:PASS:true", "SECURITY:PASS:true"] });
    const pullRequest = await world.publish();
    const body = pullRequest.draft.body ?? "";
    expect(body, "the pull request's summary").toContain("**The reviews saw only part of the change.**");
    // workflow-pull-request-body.ts:198-209 and pull-request-feedback-section.ts:208.
    expect(body, "the pull request's reviewer instruction").toContain("The change was too large to show the reviewers in full, so the reviews covered only part of it. Review the rest by hand.");
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    world.proof.assertAllCore();
  }, 180_000);

  it("a review run that returns only one of its two reports is said to be incomplete: Rovara reruns it once by itself, then asks, and Retry runs the reviews again on the same code with no new coding", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    await w.approvePlan(taskId);
    // The worker's result for the review step reaches the real route with the security report missing (an older or odd worker); every other result passes untouched.
    const dropSecurity = (body: Record<string, unknown>): Record<string, unknown> => {
      const result = body.result as { workflowReviews?: Array<{ role: string }> } | undefined;
      return result?.workflowReviews === undefined ? body : { ...body, result: { ...result, workflowReviews: result.workflowReviews.filter((review) => review.role !== "SECURITY") } };
    };
    w.tamperWithResults(dropSecurity);
    expect((await w.runStep("IMPLEMENT", code(1))).operation.status).toBe("SUCCEEDED");
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    expect(w.tampered.count, "the worker's review result did lose a report on its way").toBeGreaterThan(0);
    // A missing report is a hiccup, not a verdict (workflow-autofix.ts:233, `review-not-run` is transient): Rovara reruns the reviews once by itself, and that one is incomplete too.
    const rerun = await flowOf(w, taskId);
    expect({ stage: rerun.stage, state: rerun.state, decisions: sources(rerun) }, "Rovara reran the reviews").toEqual({ stage: "REVIEW", state: "RUNNING", decisions: ["undefined/APPROVE/TASK_OWNER", "AUTO_RETRY/REQUEST_CHANGES/AGENTX"] });
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    const blocked = await flowOf(w, taskId);
    // build-step/results.ts:394-398: exactly the reviews the step asks for; anything else blocks with these words, and no review of the run is kept.
    expect({ stage: blocked.stage, state: blocked.state, reason: blocked.blockReason, kept: blocked.reviews ?? [] }, "what the owner reads").toEqual({ stage: "REVIEW", state: "BLOCKED", reason: WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, kept: [] });
    expect({ reason: askOf(w, taskId)?.reason, codes: askOf(w, taskId)?.codes }, "the one automatic retry is used, so the owner is asked").toEqual({ reason: "retry-limit", codes: ["review-not-run"] });
    expect({ pullRequests: w.harness.world.host.model.changeRequests.length, publishRuns: w.harness.db.find((row) => row.entityType === "OPERATION" && row.kind === "publish").length }, "nothing was sent to the code host").toEqual({ pullRequests: 0, publishRuns: 0 });
    // The worker is whole again; the owner's Retry runs both reviews on the same candidate and both reports are the new run's.
    w.tamperWithResults(undefined);
    const retried = await retryReviews(w, taskId, blocked);
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    const passed = await flowOf(w, taskId);
    const latest = w.harness.db.find((row) => row.entityType === "OPERATION" && row.workflowMode === "REVIEW").sort((left, right) => Number(left.eventSequence) - Number(right.eventSequence)).at(-1)!;
    expect({ stage: passed.stage, state: passed.state, sameCode: passed.candidate!.digest === blocked.candidate!.digest, roles: passed.reviews!.map((review) => `${review.role}:${review.operationId === latest.id}`).sort() },
      "both reports, from the retry, on the same code").toEqual({ stage: "PULL_REQUEST", state: "READY", sameCode: true, roles: ["CRITIC:true", "SECURITY:true"] });
    expect(operationsOf(w, "IMPLEMENT"), "no code was rewritten").toEqual(["SUCCEEDED"]);
    expect(operationsOf(w, "REVIEW"), "three review runs: two incomplete, one whole").toEqual(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]);
    await w.publish();
    expect(w.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    w.proof.assertAllCore();
  }, 180_000);

  it("reviews that cannot be started (the table throttles every write that starts them) are said to be so once Rovara gives up, with Retry; and Retry works once the table answers", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    await planUntilCard(w, taskId);
    await w.approvePlan(taskId);
    // Every write that would start the reviews' run is throttled, for as long as the table refuses.
    const stopRefusing = w.refuseWrites((request) => request.includes('"workflowMode":{"S":"REVIEW"}'));
    expect((await w.runStep("IMPLEMENT", code(1))).operation.status).toBe("SUCCEEDED");
    // The first start failed: the reviews are due again, and no review run exists.
    const waiting = await flowOf(w, taskId);
    expect({ stage: waiting.stage, state: waiting.state, reviewRuns: operationsOf(w, "REVIEW") }, "the reviews are due, not started").toEqual({ stage: "REVIEW", state: "WAITING", reviewRuns: [] });
    // The recovery sweep tries again with a growing wait, then gives up and says so (the sweep is the deployment's own schedule; the clock is the world's).
    for (let sweep = 0; sweep < 12 && (await flowOf(w, taskId)).state === "WAITING"; sweep += 1) {
      w.harness.world.clock.advance(16 * 60_000);
      await w.harness.runtime.flow.sweepOnce();
    }
    const gaveUp = await flowOf(w, taskId);
    // stage-machine.ts:457-466: after DISPATCH_ROW_ATTEMPTS_MAX failed starts the row is given up and the owner reads "Rovara could not start the <step>: <the error's own message>". The old engine's fixed words
    // (WORKFLOW_AUTO_REVIEW_FAILED_MESSAGE, "AgentX couldn't start the reviews automatically. Use Retry reviews to try again.") are not the core's; the core's carry the storage error's text (see A1-9-DONE.md).
    expect({ stage: gaveUp.stage, state: gaveUp.state, reason: gaveUp.blockReason }, "what the owner reads once Rovara gives up").toEqual({ stage: "REVIEW", state: "BLOCKED",
      reason: "Rovara could not start the reviews: DynamoDB asked to slow down (ProvisionedThroughputExceededException) on transaction" });
    expect({ reviewRuns: operationsOf(w, "REVIEW"), pullRequests: w.harness.world.host.model.changeRequests.length }, "nothing ran, nothing was sent to the code host").toEqual({ reviewRuns: [], pullRequests: 0 });
    // The table answers again; the owner's Retry starts the reviews, which run on the same code and open the pull request.
    stopRefusing();
    const retried = await retryReviews(w, taskId, gaveUp);
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    const passed = await flowOf(w, taskId);
    expect({ stage: passed.stage, state: passed.state, sameCode: passed.candidate!.digest === gaveUp.candidate!.digest }).toEqual({ stage: "PULL_REQUEST", state: "READY", sameCode: true });
    await w.publish();
    expect(w.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    w.proof.assertAllCore();
  }, 180_000);

  it("an older issue in a file the change never touched is noted and does not block, and the pull request says how many earlier issues were noted", async () => {
    world = await createJourneyWorld();
    // The reviewer reports a PRE_EXISTING issue in a file that is not in the change: it stays PRE_EXISTING (worker verification/review.ts:648-657) and never blocks (task-workflow.ts:273-275).
    const taskId = await reviewed(world, { CODE: [[{ text: "farewell takes an untyped name.", origin: "PRE_EXISTING", severity: "LOW", file: "repo/demo/farewell.ts", line: 1 }]] });
    const flow = await flowOf(world, taskId);
    expect({ stage: flow.stage, state: flow.state, open: openReviewFindings(flow), reviews: flow.reviews!.map((review) => `${review.role}:${review.status}:${String(review.findings.length)}`).sort() }, "noted, not blocking").toEqual({ stage: "PULL_REQUEST", state: "READY", open: [], reviews: ["CRITIC:PASS:1", "SECURITY:PASS:0"] });
    expect(sources(flow), "Rovara did not send it back").toEqual(["undefined/APPROVE/TASK_OWNER"]);
    const pullRequest = await world.publish();
    // workflow-pull-request-body.ts:201: "N earlier issue(s) noted".
    expect((pullRequest.draft.body ?? "").split("\n"), "the pull request's reviews line").toContain("Reviews: code review passed; security review passed; 1 earlier issue noted");
    expect(world.taskRow(taskId)!.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
    world.proof.assertAllCore();
  }, 180_000);

  it("a too-large change is refused: a change whose diff is over 200,000 bytes cannot be handed over, the coding step fails with the artifact refusal, the task reads blocked at coding, and no review runs (KNOWN LIMIT: LARGE-CHANGE-REFUSAL gives it a stable code and a Needs you; then these expectations flip)", async () => {
    world = await createJourneyWorld();
    const taskId = await startTask(world);
    await planUntilCard(world, taskId);
    await world.approvePlan(taskId);
    // 4,000 lines of 61 bytes: a diff of about 247,000 bytes. The worker posts the diff as the artifact `workspace.diff`; the broker takes at most PLAN_MAX_BYTES = 200,000 of any artifact (services/callbacks.ts:74,148-160).
    const tooBig = String.raw`printf ok > repo/demo/health.txt && node -e 'const fs=require("fs");fs.writeFileSync("repo/demo/big.ts",Array.from({length:4000},(_,i)=>"export const line"+i+" = 1; // "+"x".repeat(30)).join("\n")+"\n")'`;
    const built = await world.runStep("IMPLEMENT", [fauxAssistantMessage([fauxToolCall("bash", { command: tooBig })], { stopReason: "toolUse" }), fauxAssistantMessage("I added the big file.")]);
    // TODAY: the run FAILED with the broker's own refusal inside the worker's error text (HTTP 400, CONFIG_INVALID, "the artifact is too large"); there is no code of its own for it and the owner is not told what to do.
    expect(built.operation.status, "the coding run failed").toBe("FAILED");
    expect(String(built.operation.error), "with the artifact refusal").toMatch(/\/artifacts HTTP 400: .*"code":"CONFIG_INVALID".*"message":"the artifact is too large"/u);
    const flow = await flowOf(world, taskId);
    expect({ stage: flow.stage, state: flow.state, reason: flow.blockReason, reviews: flow.reviews ?? [] }, "what the owner reads: blocked at coding in generic words").toEqual({ stage: "IMPLEMENT", state: "BLOCKED", reason: "implementation operation ended failed", reviews: [] });
    expect({ reviewRuns: operationsOf(world, "REVIEW"), pullRequests: world.harness.world.host.model.changeRequests.length }, "nothing was reviewed or sent").toEqual({ reviewRuns: [], pullRequests: 0 });
    world.proof.assertAllCore();
  }, 180_000);

  it("KNOWN GAP (F2-B required case): a blocked review shows the owner no decision card and the task read says only 'the code review did not pass'; flips when standing returns Needs you and the review-could-not-finish reason", async () => {
    world = await createJourneyWorld();
    const taskId = await reviewed(world, { CODE: ["PROSE", "PROSE"] });
    const read = (await world.maya("GET", `/v1/dev/tasks/${taskId}`)).body.task as { status: string; workflow: WorkflowSnapshot };
    // TODAY: the task read's words are the generic block reason, though the review never gave a verdict (its own failure reason, INVALID_JSON, is on the review, not in the words), and the task's status reads SUCCEEDED
    // while it waits for the owner at the reviews.
    expect({ status: read.status, stage: read.workflow.stage, state: read.workflow.state, reason: read.workflow.blockReason, failure: read.workflow.reviews!.find((review) => review.role === "CRITIC")?.failureReason },
      "the task read").toEqual({ status: "SUCCEEDED", stage: "REVIEW", state: "BLOCKED", reason: "the code review did not pass", failure: "INVALID_JSON" });
    // TODAY: the owner's list of decisions waiting for them does not hold it (the ask is recorded on the task row only).
    const cards = await world.maya("GET", "/v1/app/decisions");
    expect(cards.status).toBe(200);
    expect((cards.body.cards as Array<{ taskId?: string }>).filter((card) => card.taskId === taskId), "no decision card for the blocked review").toEqual([]);
    expect(cards.body.total, "nothing waits in the owner's list").toBe(0);
    expect(askOf(world, taskId), "the ask exists only on the task row").toMatchObject({ reason: "needs-a-person", codes: ["review-unusable"] });
    world.proof.assertAllCore();
  }, 180_000);

  it("a REVIEW-ONLY task (the approved plan names no automated check) whose review run returns one report of two: the same incomplete-reviews block, the task says it is checked by review only, and Retry opens a pull request that says so", async () => {
    world = await createJourneyWorld();
    const w = world;
    const taskId = await startTask(w);
    // Review only is not a task kind or a start option: any task started the usual way is one when its approved plan names no check and the project selects none (contracts task-workflow.ts:786-788
    // `workflowIsReviewOnly`; the core runs it in build-step/start.ts:409-418, results.ts:195-297). The plan says why it has no check (`none_reason`).
    const noCheckPlan = planAnswer(planDocument({ title: "Add the health endpoint", claims: [{ id: "1", text: "The service answers /health. The change is in health.txt, and tests/health.test.ts covers it." }] }),
      { checks: { checks: [], none_reason: "The change is a data file that no project command exercises." } });
    await planUntilCard(w, taskId, { plan: noCheckPlan });
    await w.approvePlan(taskId);
    const dropSecurity = (body: Record<string, unknown>): Record<string, unknown> => {
      const result = body.result as { workflowReviews?: Array<{ role: string }> } | undefined;
      return result?.workflowReviews === undefined ? body : { ...body, result: { ...result, workflowReviews: result.workflowReviews.filter((review) => review.role !== "SECURITY") } };
    };
    w.tamperWithResults(dropSecurity);
    expect((await w.runStep("IMPLEMENT", code(1))).operation.status).toBe("SUCCEEDED");
    const review = await flowOf(w, taskId);
    // No check ran and none was asked for: the task is on to the reviews, recorded as review only.
    expect({ reviewOnly: (review.verification as { reviewOnly?: boolean } | undefined)?.reviewOnly, results: review.verification?.results.length, none: review.checkPolicy?.noneReason }, "recorded as review only").toEqual({ reviewOnly: true, results: 0, none: "The change is a data file that no project command exercises." });
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    expect(w.tampered.count, "the worker's review result did lose a report on its way").toBeGreaterThan(0);
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    const blocked = await flowOf(w, taskId);
    // Today's words are the same as for any task (the Slack thread's "No automated check applied, and the reviews couldn't finish" is not the task read's; workflow-messages.ts:529 is the old thread's).
    expect({ stage: blocked.stage, state: blocked.state, reason: blocked.blockReason, reviewOnly: (blocked.verification as { reviewOnly?: boolean } | undefined)?.reviewOnly }, "what the owner reads").toEqual({ stage: "REVIEW", state: "BLOCKED",
      reason: WORKFLOW_REVIEW_RESULT_INCOMPLETE_MESSAGE, reviewOnly: true });
    expect({ reason: askOf(w, taskId)?.reason, codes: askOf(w, taskId)?.codes }, "Rovara asked after its one retry").toEqual({ reason: "retry-limit", codes: ["review-not-run"] });
    expect(w.harness.world.host.model.changeRequests.length, "nothing was sent to the code host").toBe(0);
    w.tamperWithResults(undefined);
    const retried = await retryReviews(w, taskId, blocked);
    expect(retried.status, JSON.stringify(retried.body).slice(0, 300)).toBe(200);
    expect((await w.runStep("REVIEW", reviewerSteps({}))).operation.status).toBe("SUCCEEDED");
    expect(await flowOf(w, taskId), "the retry passed on the same code").toMatchObject({ stage: "PULL_REQUEST", state: "READY", candidate: { digest: blocked.candidate!.digest } });
    const pullRequest = await w.publish();
    // pull-request-layout.ts:123,157 and risk.ts:205: a review-only change says in its pull request that no automated check applied, why, and that it was checked by review only.
    const body = pullRequest.draft.body ?? "";
    expect(body, "the pull request says it is review only").toContain("## Not verified by automated checks (review only)");
    expect(body).toContain("No automated check applied, so this change was checked by review only.");
    expect(body).toContain("**No automated check applied.** Why: The change is a data file that no project command exercises.");
    expect(operationsOf(w, "IMPLEMENT"), "no code was rewritten").toEqual(["SUCCEEDED"]);
    w.proof.assertAllCore();
  }, 180_000);
});
