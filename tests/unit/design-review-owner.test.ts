// What the owner does to a design review. The cost hold and its choices (through the approval gate), the question card, Skip, Retry, Resume, `design first`, the wait sweep (reminders, parking,
// closing), and the design's approval that carries the task on through the plan, the build and the reviews. The worker is simulated; the broker's records are checked in the store.
import { describe, expect, it } from "vitest";
import { BUDGET_EXHAUSTED_FAILURE_MESSAGE, DesignReviewBindingSchema, WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE, createCandidateManifest, type PlanDocument, type WorkflowSnapshot } from "@agentx/contracts";
import { designChoicesOf } from "../../packages/broker/src/core/design-review/choice-subject.js";
import { answerReviewQuestions, resumeParkedReview, retryBlockedReview } from "../../packages/broker/src/core/design-review/actions.js";
import { sweepDesignWaits, designWaitNotifyKey, designWaitRowKey } from "../../packages/broker/src/core/design-review/wait.js";
import { designPanelOf, designQuestionsOf } from "../../packages/broker/src/core/design-review/panel.js";
import { loadDesignProof } from "../../packages/broker/src/core/design-review/design-proof.js";
import { designProofLine } from "../../packages/broker/src/core/design-review/proof-line.js";
import { workflowPullRequestBody } from "../../packages/broker/src/core/proof/workflow-pull-request-body.js";
import { NO_LESSONS_USED } from "../../packages/broker/src/core/build-step/changed-files.js";
import { taskKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { readWorkspace, runDueDispatches } from "../../packages/broker/src/core/task-flow/stage-machine.js";
import { chargeMarkerKey, taskIndexKey, taskPointerKey } from "../../packages/broker/src/core/task-flow/keys.js";
import { createDesignChoiceSubject } from "../../packages/broker/src/core/design-review/choice-subject.js";
import type { Admission, TransactItem } from "@agentx/contracts";
import { COMPANY, newRequestId } from "../support/task-flow-harness.js";
import {
  BASE, SESSION, localDesignReview, answerRound, approve, choose, design, finish, makeGate, mintKeys, nextJob, planned, plannedStructured, sha, taskOf, toDesignPhase, toRound, world, type World,
} from "../support/design-review-flow-world.js";
import { DESIGN_REVIEW_INFO_STRING } from "@agentx/contracts";
import { createLocalOwnerApprovers, localOwnerPrincipal, LOCAL_SESSION_METHOD } from "../../packages/broker/src/ports/policy-defaults.js";
import { designChoiceDigest } from "../../packages/broker/src/core/design-review/choice-subject.js";
import { DESIGN_CHOICE_KIND } from "../../packages/broker/src/core/design-review/choice-subject.js";

const CODING_PLAN: PlanDocument = {
  schemaVersion: 1, title: "Retry", why: [{ text: "Timed-out payments are dropped.", author: "Priya" }], claims: [{ id: "1", text: "A timed-out payment is retried once." }], notChanging: ["Refunds stay as they are."], risks: ["A retry could charge twice."], decisions: [],
  checks: { proposed: [{ id: "unit", label: "Unit tests", command: { cwd: "repo/payments", executable: "npm", args: ["test"], timeoutSeconds: 30 } }], proves: { unit: ["1"] } },
};
const DAY = 86_400;
const NOWISO = "2026-11-09T12:00:00.000Z";
const workflowOf = async (w: World): Promise<WorkflowSnapshot> => (await taskOf(w)).workflow;
const sweep = (w: World) => sweepDesignWaits({ flow: w.h.deps, reader: w.runtime.reader, env: w.runtime.env, releaseKeys: async () => undefined });

/** A planner's answer that asks one question about the first finding, and fixes the rest. */
const askingAnswer = (workflow: WorkflowSnapshot, text = design()): string => {
  const findings = workflow.designReview!.rounds[0]!.findings;
  const resolutions = findings.map((finding, index) => (index === 0
    ? { findingId: finding.id, action: "asked", questionId: "q1", note: "Needs a person." }
    : { findingId: finding.id, action: "fixed", note: "Changed it." }));
  const questions = [{ id: "q1", unclear: "How many times may it retry?", evidence: [{ kind: "design", section: "§3" }], options: [{ id: "a", label: "Three", consequence: "Most payments recover." }, { id: "b", label: "Once", consequence: "Faster failures." }], recommended: "a", why: "Three recovers most." }];
  return `${text}\n\`\`\`rovara-design-resolve\n${JSON.stringify({ resolutions, questions })}\n\`\`\`\n`;
};

/** Round 1 answered with one major finding, up to the planner's run. */
async function toPlannerRun(w: World, severity: "major" | "blocker" = "major") {
  await toRound(w);
  const round1 = await nextJob(w);
  await mintKeys(w, round1.operation);
  await answerRound(w, round1.operation, () => [{ id: "1", severity, section: "§3", text: "The retry has no limit.", citations: [{ kind: "design", section: "§3" }] }]);
  return { ...(await nextJob(w)), round1 };
}

describe("the cost hold: no price known", () => {
  it("holds the review for the owner's choice, and the owner's accepted choice runs it under a bounded budget", async () => {
    const w = await world({ holdAnswerable: true, price: false });
    await toRound(w);
    // No price: nothing runs, and nothing is approved by default. The hold offers to run it anyway, or to skip.
    const held = await workflowOf(w);
    expect(held).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING", designReview: { status: "waiting_cost" } });
    expect(held.designReview!.estimateUsd).toBeUndefined();
    expect(designChoicesOf(held, { allowSkip: true }).map((choice) => choice.choice)).toEqual(["run_unpriced", "skip"]);
    expect(designChoicesOf(held, { allowSkip: false }).map((choice) => choice.choice)).toEqual(["run_unpriced"]);
    const panel = designPanelOf(held, { allowSkip: true, holdOffer: { requestId: newRequestId(), revision: held.revision, artifactDigest: designChoiceDigest(held)! } });
    expect(panel?.hold?.choices.map((choice) => choice.label)).toEqual(["Run it anyway", "Skip design review"]);
    expect(await w.h.flow.dispatchOnce()).toMatchObject({ received: 0 });

    // A wrong proof is refused and changes nothing; the owner's session accepts it.
    const gate = makeGate(w);
    const forged = await gate.decide({ companyId: COMPANY, kind: DESIGN_CHOICE_KIND, subjectId: w.taskId, requestId: newRequestId(), outcome: "approve", seen: { revision: held.revision, artifactDigest: designChoiceDigest(held)! }, credentials: [{ method: LOCAL_SESSION_METHOD, token: "not-the-session" }], details: { choice: "run_unpriced" } });
    expect(forged).toMatchObject({ status: "refused" });
    expect((await workflowOf(w)).revision).toBe(held.revision);
    // A choice the hold does not offer is refused.
    expect(await choose(w, "raise_cap", gate)).toMatchObject({ status: "refused", reason: "invalid_outcome" });
    expect(await choose(w, "run_unpriced", gate)).toMatchObject({ status: "decided" });
    await runDueDispatches(w.h.deps);
    const round = await nextJob(w);
    const binding = DesignReviewBindingSchema.parse(round.operation.designReview);
    expect(round.operation).toMatchObject({ workflowMode: "PLAN_CRITIQUE" });
    expect((await workflowOf(w)).designReview!.approvals).toMatchObject([{ kind: "spend", by: { actorId: expect.any(String) as string } }]);
    expect(binding.reviewers.length).toBeGreaterThan(0);
    await mintKeys(w, round.operation);
    await answerRound(w, round.operation, () => []);
    expect(await workflowOf(w)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "done" } });
  });

  it("skips the review when the setting allows it, and goes on to the approval of the design; a project that does not allow skipping is not offered it", async () => {
    const w = await world({ holdAnswerable: true, price: false });
    await toRound(w);
    expect(await choose(w, "skip")).toMatchObject({ status: "decided" });
    expect(await workflowOf(w)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN", designReview: { status: "not_run", notRunReason: "skipped" } });
    const none = await world({ holdAnswerable: true, price: false, allowSkip: false });
    await toRound(none);
    expect(await choose(none, "skip")).toMatchObject({ status: "refused" });
    expect(await workflowOf(none)).toMatchObject({ stage: "PLAN_CRITIQUE", state: "WAITING" });
  });
});

describe("questions, retry and resume", () => {
  it("puts the planner's question to the owner, and the owner's answers send the planner on", async () => {
    const w = await world({ holdAnswerable: true });
    const resolveRun = await toPlannerRun(w);
    const findings = (await workflowOf(w)).designReview!.rounds[0]!.findings;
    expect(findings.length).toBeGreaterThan(0);
    w.results.set(`${resolveRun.operation.id}:plan.md`, askingAnswer(await workflowOf(w)));
    await finish(w, resolveRun.operation, { kind: "ended" });
    const asking = await workflowOf(w);
    expect(asking).toMatchObject({ stage: "PLAN", state: "WAITING", designReview: { status: "waiting_answers" } });
    const card = designQuestionsOf(asking);
    expect(card?.items).toHaveLength(1);
    expect(card?.items[0]?.options.map((option) => option.id)).toEqual(["a", "b"]);

    // A task that moved since the page was drawn refuses the answers; an answer that names no question of the card is the request's fault.
    await expect(answerReviewQuestions(w.h.deps, { taskId: w.taskId, expectedRevision: asking.revision - 1, answers: [{ questionId: "q1", optionId: "a" }], actorId: (await workflowOf(w)).ownerId })).rejects.toMatchObject({ code: "CHANGE_STALE" });
    await expect(answerReviewQuestions(w.h.deps, { taskId: w.taskId, expectedRevision: asking.revision, answers: [{ questionId: "q9", optionId: "a" }], actorId: (await workflowOf(w)).ownerId })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await answerReviewQuestions(w.h.deps, { taskId: w.taskId, expectedRevision: asking.revision, answers: [{ questionId: "q1", optionId: "a" }], actorId: (await workflowOf(w)).ownerId });
    // The planner answers again with the owner's words, as data, and is told not to ask the same thing.
    const again = await nextJob(w);
    expect((again.invocation.payload as { prompt: string }).prompt).toContain("A person answered your question card");
    expect((await workflowOf(w)).designReview).toMatchObject({ status: "resolving" });
  });

  it("retries a review step that blocked: the same round is made due again, and what the blocked round cost is not counted twice", async () => {
    const w = await world({ holdAnswerable: true });
    await toRound(w);
    const round1 = await nextJob(w);
    await mintKeys(w, round1.operation);
    await finish(w, round1.operation, undefined, "FAILED", WORKFLOW_RULE_FILES_UNVERIFIED_MESSAGE);
    const blocked = await taskOf(w);
    expect(blocked.workflow).toMatchObject({ stage: "PLAN_CRITIQUE", state: "BLOCKED" });
    const spent = blocked.workflow.designReview!.spentUsd;
    expect(spent).toBeGreaterThan(0);
    await expect(retryBlockedReview(w.h.deps, blocked, blocked.workflow.revision - 1)).rejects.toMatchObject({ code: "CHANGE_STALE" });
    expect(await retryBlockedReview(w.h.deps, blocked, blocked.workflow.revision)).toBe(true);
    const retried = await nextJob(w);
    expect(DesignReviewBindingSchema.parse(retried.operation.designReview).round).toBe(1);
    expect(retried.operation.id).not.toBe(round1.operation.id);
    expect((await workflowOf(w)).designReview!.spentUsd).toBe(spent);
  });

  it("stops the review at its cost cap when a reviewer ran out of budget, with what its keys spent", async () => {
    const w = await world({ holdAnswerable: true });
    await toRound(w);
    const round1 = await nextJob(w);
    await mintKeys(w, round1.operation);
    await finish(w, round1.operation, undefined, "FAILED", BUDGET_EXHAUSTED_FAILURE_MESSAGE);
    expect(await workflowOf(w)).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", designReview: { status: "stopped_at_cap" } });
  });
});

describe("`design first`", () => {
  it("asks for the review whatever the project's setting says, and the request is the text after the prefix", async () => {
    const w = await world({ holdAnswerable: true, mode: "never" });
    const { task } = await w.h.flow.start(w.h.owner, { requestId: newRequestId(), project: "payments", instructions: "design first: Retry timed-out payments", workflow: true });
    const record = (await w.h.store.get(taskKey(task.taskId)))!;
    expect(record["designFirst"]).toMatchObject({ by: "local-owner" });
    expect(record["requestText"]).toBe("Retry timed-out payments");
    // A project set to Off reads the request as it came when the switch is off: the prefix is left in the text.
    const off = await world({ holdAnswerable: true, mode: "never" });
    off.runtime.env = {};
    const plain = await off.h.flow.start(off.h.owner, { requestId: newRequestId(), project: "payments", instructions: "design first: Retry timed-out payments", workflow: true });
    expect((await off.h.store.get(taskKey(plain.task.taskId)))!["designFirst"]).toBeUndefined();
    expect((await off.h.store.get(taskKey(plain.task.taskId)))!["requestText"]).toBe("design first: Retry timed-out payments");
  });
});

describe("`design first:` and the company check", () => {
  it("is not read for a person of another company: the request is refused before the prefix is looked at", async () => {
    const w = await world({ holdAnswerable: true });
    let read = 0;
    const steps = w.h.deps.designReview!;
    w.h.deps.designReview = { ...steps, designFirst: async (text) => { read += 1; return steps.designFirst(text); } };
    const stranger = { ...w.h.owner, principal: { ...w.h.owner.principal, companyId: "another-company" } };
    await expect(w.h.flow.start(stranger as never, { requestId: newRequestId(), project: "payments", instructions: "design first: Retry payments", workflow: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(read).toBe(0);
  });
});

describe("the wait sweep", () => {
  it("reminds at a day and at three days (once each), parks at a week with the keys released, resumes on the owner's word, and closes a parked review after thirty days", async () => {
    const w = await world({ holdAnswerable: true, price: false });
    await toRound(w);
    const held = await workflowOf(w);
    expect(held.designReview!.status).toBe("waiting_cost");
    // Nothing is due yet.
    expect(await sweep(w)).toMatchObject({ attempted: 0 });
    w.h.clock.advance(25 * 3_600);
    expect(await sweep(w)).toMatchObject({ attempted: 1, reminded: 1 });
    expect(await w.h.store.get(designWaitNotifyKey(w.taskId, held.revision, "24h"))).toMatchObject({ step: "24h", waitKind: "cost" });
    // The same step is not sent again.
    expect(await sweep(w)).toMatchObject({ reminded: 0 });
    w.h.clock.advance(48 * 3_600);
    expect(await sweep(w)).toMatchObject({ reminded: 1 });
    expect(await w.h.store.get(designWaitNotifyKey(w.taskId, held.revision, "72h"))).toBeDefined();
    w.h.clock.advance(5 * DAY);
    expect(await sweep(w)).toMatchObject({ parked: 1 });
    const parked = await workflowOf(w);
    expect(parked.designReview).toMatchObject({ status: "waiting_cost" });
    // A parked review shows the owner a way to pick it up, and nothing else changed: nothing approved, nothing spent.
    expect(designPanelOf(parked, { allowSkip: true })?.parked).toBeDefined();
    await resumeParkedReview(w.h.deps, { taskId: w.taskId, expectedRevision: parked.revision, actorId: (await workflowOf(w)).ownerId });
    expect((await workflowOf(w)).revision).toBeGreaterThan(parked.revision);
    w.h.clock.advance(8 * DAY);
    expect(await sweep(w)).toMatchObject({ parked: 1 });
    w.h.clock.advance(31 * DAY);
    expect(await sweep(w)).toMatchObject({ closed: 1 });
    expect(await workflowOf(w)).toMatchObject({ stage: "CLOSED", state: "COMPLETE" });
  });

  it("ends a cost hold of a review that was switched off, as not run, and does nothing else new for it", async () => {
    const w = await world({ holdAnswerable: true, price: false });
    await toRound(w);
    w.runtime.env = {};
    w.h.clock.advance(25 * 3_600);
    expect(await sweep(w)).toMatchObject({ attempted: 1 });
    expect(await workflowOf(w)).toMatchObject({ stage: "PLAN_REVIEW", designReview: { status: "not_run", notRunReason: "switched_off" } });
  });
});

describe("the design's approval carries the task on", () => {
  it("records who approved with the reason for an open blocker, then plans, builds and reviews the code with the review's stage in the program", async () => {
    const w = await world({ holdAnswerable: true });
    const resolveRun = await toPlannerRun(w, "blocker");
    // The planner answers nothing the owner can settle: it contests nothing and declines the finding, which stays open as a blocker for the owner to see.
    const findingIds = (await workflowOf(w)).designReview!.rounds[0]!.findings.map((finding) => finding.id);
    w.results.set(`${resolveRun.operation.id}:plan.md`, `${design()}\n\`\`\`rovara-design-resolve\n${JSON.stringify({ resolutions: findingIds.map((findingId) => ({ findingId, action: "declined", note: "Left to the owner." })) })}\n\`\`\`\n`);
    await finish(w, resolveRun.operation, { kind: "ended" });
    const waiting = await workflowOf(w);
    expect(waiting).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING", reviewPhase: "DESIGN" });
    const panel = designPanelOf(waiting, { allowSkip: true });
    expect(panel?.findings.some((finding) => finding.open)).toBe(true);

    // The approval goes through the gate: the owner's session, the design's own digest.
    const gate = makeGate(w);
    const digest = waiting.artifacts.filter((artifact) => artifact.type === "design").at(-1)!.sha256;
    const approval = await gate.decide({
      companyId: COMPANY, kind: "workflow-document", subjectId: w.taskId, requestId: newRequestId(), outcome: "approve", seen: { revision: waiting.revision, artifactDigest: digest },
      credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }], reason: "The retry limit is decided in the plan.", details: { via: "PAGE" },
    });
    expect(approval).toMatchObject({ status: "decided" });
    await runDueDispatches(w.h.deps);
    // The proof knows who approved the design, at what tier, and the reason; the Proof's design line says so in counts and fixed words.
    const proof = await loadDesignProof({ store: w.h.store, artifacts: w.h.deps.artifacts }, w.taskId, await workflowOf(w));
    expect(proof).toMatchObject({ approval: { openBlockers: 1, reason: "The retry limit is decided in the plan." } });
    expect(proof === undefined ? "" : designProofLine(proof)).toContain("Design review: coverage all");

    // The coding plan is the next document; its plan check runs on its own, and the plan's approval starts the build.
    const plan = await nextJob(w);
    expect(plan.invocation.payload).toMatchObject({ workflowMode: "PLAN" });
    await finish(w, plan.operation, plannedStructured(w, plan.operation, CODING_PLAN, 1));
    // The coding plan gets its own plan check (the design review's rows are not used for it); a check that cannot run sends the plan to the owner as not checked.
    const critique = await nextJob(w);
    expect(critique.operation).toMatchObject({ workflowMode: "PLAN_CRITIQUE" });
    expect(critique.operation.designReview).toBeUndefined();
    await finish(w, critique.operation, undefined, "FAILED", "The check could not run.");
    const checked = await workflowOf(w);
    expect(checked).toMatchObject({ stage: "PLAN_REVIEW", state: "WAITING" });
    expect(checked.program?.steps.map((step) => step.kind)).toEqual(["plan", "plan_critic", "build", "check", "review", "pull_request"]);
    const planDigest = checked.artifacts.filter((artifact) => artifact.type === "plan").at(-1)!.sha256;
    expect(await gate.decide({
      companyId: COMPANY, kind: "workflow-document", subjectId: w.taskId, requestId: newRequestId(), outcome: "approve", seen: { revision: checked.revision, artifactDigest: planDigest },
      credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }], details: { via: "PAGE" },
    })).toMatchObject({ status: "decided" });
    await runDueDispatches(w.h.deps);
    // Coding, the checks and both reviews run on the approved plan as they do for a task with no design review: the program's plan-check step changes nothing after the plan.
    const coding = await nextJob(w);
    expect(coding.invocation.payload).toMatchObject({ workflowMode: "IMPLEMENT" });
    expect(await workflowOf(w)).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const commit = "c".repeat(40);
    const tree = "d".repeat(40);
    const candidate = [{ repositoryId: "demo", commitSha: commit, treeSha: tree, baseCommitSha: BASE }];
    const checks = { status: "not_verified", notVerifiedReason: "no_checks", source: "none", preambleVersion: "1", preambleSha256: "a".repeat(64), checks: [], extraTry: "not_needed", agentClaim: "none" };
    await finish(w, coding.operation, { kind: "built", result: { conversationId: "conversation", checks, workflowCandidateRepositories: candidate, workflowCheckCandidateRepositories: candidate } });
    const review = await nextJob(w);
    expect(review.invocation.payload).toMatchObject({ workflowMode: "REVIEW" });
    const candidateDigest = createCandidateManifest(candidate).digest;
    const report = (role: "CRITIC" | "SECURITY") => ({ operationId: review.operation.id, candidateDigest, role, provider: "examplehost-model", version: "1", readOnly: true, recordedAt: NOWISO, status: "PASS", findings: [], ...(role === "CRITIC" ? { risk: "low" } : {}) });
    await finish(w, review.operation, { kind: "reviewed", result: { conversationId: "conversation", workflowCandidateRepositories: candidate, workflowReviews: [report("CRITIC"), report("SECURITY")] } });
    const done = await taskOf(w);
    expect(done.workflow).toMatchObject({ stage: "PULL_REQUEST", state: "READY" });
    // The pull request's Proof section carries the design line, the same words as the proof page; the code with no design review has no such line.
    const proofContext = await w.h.deps.designReview!.proofContext!(w.h.deps, done, done.workflow);
    expect(proofContext?.design?.line).toContain("Design review: coverage all");
    const body = workflowPullRequestBody(done, done.workflow, undefined, undefined, { lessonsUsed: NO_LESSONS_USED, ...(proofContext === undefined ? {} : { proof: proofContext }) });
    expect(body).toContain("### Proof");
    expect(body).toContain(proofContext!.design!.line);
    expect(workflowPullRequestBody(done, done.workflow, undefined, undefined, { lessonsUsed: NO_LESSONS_USED })).not.toContain("Design review: coverage");
    expect(sha("x")).toHaveLength(64);
    void createLocalOwnerApprovers; void localOwnerPrincipal; void approve; void toDesignPhase; void DESIGN_REVIEW_INFO_STRING; void planned;
  });
});

/** An admission that records every reservation given back. */
function recordingAdmission(): Admission & { released: string[] } {
  const released: string[] = [];
  return {
    released,
    async admit(request) { return { allowed: true, reservationId: `res:${request.idempotencyKey}` }; },
    async stage(request) { return { decision: { allowed: true, reservationId: `res:${request.idempotencyKey}` }, items: [] as readonly TransactItem[] }; },
    async settle() {},
    async release(id) { released.push(id); },
  };
}

describe("a review nobody decided, thirty days after it was parked", () => {
  it("closes the task the way closing it by hand does: its slot goes back, its workspace and pointer are closed, its machine is stopped and its admission is released", async () => {
    const admission = recordingAdmission();
    const w = await world({ price: false, holdAnswerable: true, admission });
    await toRound(w);
    const before = await taskOf(w);
    const workspaceBefore = (await readWorkspace(w.h.deps, w.workspaceId))!;
    const machineId = workspaceBefore.machine?.machineId;
    expect(machineId).toBeDefined();
    expect(await w.h.store.get(chargeMarkerKey(before.charge, w.taskId))).toBeDefined();
    w.h.clock.advance(8 * DAY);
    expect(await sweep(w)).toMatchObject({ parked: 1 });
    w.h.clock.advance(31 * DAY);
    expect(await sweep(w)).toMatchObject({ closed: 1 });
    const task = await taskOf(w);
    expect(task.workflow).toMatchObject({ stage: "CLOSED", state: "COMPLETE" });
    // The task itself: closed, and its active-task slot given back (the marker of the charge is gone, the release is recorded).
    expect(task.closedAt).toBeDefined();
    expect(task.releasedAt).toBeDefined();
    expect(await w.h.store.get(chargeMarkerKey(before.charge, w.taskId))).toBeUndefined();
    // Its workspace is closed under a new fence, and no operation is active; its pointer is cancelled and its index row says closed.
    const workspace = (await readWorkspace(w.h.deps, w.workspaceId))!;
    expect(workspace).toMatchObject({ status: "CLOSED", activeOperationId: null });
    expect(workspace.fence).toBe(workspaceBefore.fence + 1);
    expect((await w.h.store.get(taskPointerKey(w.workspaceId)))?.["cancelledAt"]).toBeDefined();
    expect((await w.h.store.get(taskIndexKey(before.developerId, before.createdAt, w.taskId)))?.["status"]).toBe("CLOSED");
    // Its machine is stopped and the allowances held for it are given back.
    expect((await w.h.machines.health(machineId!)).state).toBe("terminated");
    expect(admission.released).toEqual(expect.arrayContaining([`res:task.start:${w.taskId}:1`]));
  });
});

describe("the reviewers' keys of a review that waits", () => {
  it("are released when it is parked: the model proxy is told to close every key of the rounds already run", async () => {
    const w = await world({ holdAnswerable: true });
    const resolveRun = await toPlannerRun(w);
    w.results.set(`${resolveRun.operation.id}:plan.md`, askingAnswer(await workflowOf(w)));
    await finish(w, resolveRun.operation, { kind: "ended" });
    expect(await workflowOf(w)).toMatchObject({ designReview: { status: "waiting_answers" } });
    const binding = DesignReviewBindingSchema.parse(resolveRun.round1.operation.designReview);
    const keyIds = binding.reviewers.map((reviewer) => sha(`key:${resolveRun.round1.operation.id}:${reviewer.keySlot}`));
    const { local, closed } = localDesignReview(w);
    // Nothing is closed while the owner still has time.
    await local.sweepWaits();
    expect(closed).toEqual([]);
    w.h.clock.advance(8 * DAY);
    await local.sweepWaits();
    expect((await workflowOf(w)).designReview).toMatchObject({ status: "waiting_answers" });
    expect(closed.sort()).toEqual([...keyIds].sort());
  });
});

describe("the grade of a cost choice", () => {
  it("is high whatever the amount when the review is about a high-risk area (infrastructure), and by the amount otherwise", async () => {
    const gradeOf = async (reasons: string[]) => {
      const w = await world({ price: false, holdAnswerable: true });
      await toRound(w, reasons);
      const subject = createDesignChoiceSubject({ flow: w.h.deps, reader: w.runtime.reader });
      return (await subject.load(COMPANY, w.taskId))!.request.risk;
    };
    expect(await gradeOf(["infrastructure"])).toBe("high");
    expect(await gradeOf(["new_api"])).not.toBe("high");
  });
});

describe("what a cost choice leaves behind", () => {
  it("records the choice in the decision history under the card it answers (the choice word is the reason, the developer is the person who decided), and arms the wait of the state it lands in", async () => {
    const w = await world({ price: false, holdAnswerable: true });
    await toRound(w);
    const held = await workflowOf(w);
    const requestId = newRequestId();
    const decided = await makeGate(w).decide({
      companyId: COMPANY, kind: DESIGN_CHOICE_KIND, subjectId: w.taskId, requestId, outcome: "approve", seen: { revision: held.revision, artifactDigest: designChoiceDigest(held)! },
      credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }], details: { choice: "skip" },
    });
    expect(decided).toMatchObject({ status: "decided" });
    const developerId = localOwnerPrincipal({ companyId: COMPANY }).personId;
    expect(await w.h.store.get({ pk: `DECISION#${COMPANY}#${developerId}`, sk: `DECIDED#${requestId}` })).toMatchObject({
      entityType: "DECISION_RECORD", cardId: `approve_spend:${w.taskId}`, kind: "approve_spend", outcome: "approved", reason: "skip", requestId,
    });
    // Skip lands at the owner's decision, which waits on the owner like any other: its row is armed for the new revision in the same commit.
    const after = await workflowOf(w);
    expect(after.stage).toBe("PLAN_REVIEW");
    expect(await w.h.store.get(designWaitRowKey(w.taskId))).toMatchObject({ workflowRevision: after.revision, waitKind: "decision" });
  });

  it("keeps a reminder's row under the revision as Cloud writes it, without padding, so a send-once guard sees the same row on either install", async () => {
    const w = await world({ price: false, holdAnswerable: true });
    await toRound(w);
    const held = await workflowOf(w);
    expect(designWaitNotifyKey(w.taskId, held.revision, "24h").sk).toBe(`DESIGN_WAIT_NOTIFY#${String(held.revision)}#24h`);
  });
});

describe("the run-anyway choice and the answers, as the owner's page makes them", () => {
  it("records the run-anyway choice in the decision history like every other choice, and the round it starts names the owner", async () => {
    const w = await world({ price: false, holdAnswerable: true });
    await toRound(w);
    const held = await workflowOf(w);
    const requestId = newRequestId();
    expect(await makeGate(w).decide({
      companyId: COMPANY, kind: DESIGN_CHOICE_KIND, subjectId: w.taskId, requestId, outcome: "approve", seen: { revision: held.revision, artifactDigest: designChoiceDigest(held)! },
      credentials: [{ method: LOCAL_SESSION_METHOD, token: SESSION }], details: { choice: "run_unpriced" },
    })).toMatchObject({ status: "decided" });
    const developerId = localOwnerPrincipal({ companyId: COMPANY }).personId;
    expect(await w.h.store.get({ pk: `DECISION#${COMPANY}#${developerId}`, sk: `DECIDED#${requestId}` })).toMatchObject({
      entityType: "DECISION_RECORD", cardId: `approve_spend:${w.taskId}`, kind: "approve_spend", outcome: "approved", reason: "run_unpriced", requestId,
    });
  });

  it("records the owner's answers under the workflow's own owner id (the person the review's record accepts), through the page's action", async () => {
    const w = await world({ holdAnswerable: true });
    const resolveRun = await toPlannerRun(w);
    w.results.set(`${resolveRun.operation.id}:plan.md`, askingAnswer(await workflowOf(w)));
    await finish(w, resolveRun.operation, { kind: "ended" });
    const asking = await workflowOf(w);
    const { local } = localDesignReview(w);
    const actions = local.pageActions({ gate: makeGate(w), owner: localOwnerPrincipal({ companyId: COMPANY }) });
    const answered = await actions.answerQuestions({ taskId: w.taskId, revision: asking.revision, answers: [{ questionId: "q1", optionId: "a" }] });
    expect(answered).toMatchObject({ ok: true });
    const after = await workflowOf(w);
    expect(after.designReview!.rounds[0]!.answers).toMatchObject({ by: { actorId: asking.ownerId } });
  });
});
