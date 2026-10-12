// Self-tests for the workflow E2E harness's controls: the clock, worker faults and version skew, recovery sweeps, Slack
// variants, the feedback page, MCP, the webhook builder and secret rotation, wire mode, and the model fixtures.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { execFileSync } from "node:child_process";
import { PLAN_CLAIMS_MAX, WORKER_INVOCATION_FEATURES, parsePlanDocument } from "@agentx/contracts";
import { fauxProvider, normalizeContext } from "@earendil-works/pi-ai";
import { LOST_COMPUTE_ERROR, SLACK_MAYA, createWorkflowE2E, type WorkflowE2E } from "../support/workflow-e2e.js";
import { OMAR } from "../support/developer-task-broker.js";
import { feedbackCriticReply, workflowModel } from "../support/faux-scripts.js";
import {
  conflictingAsImplement, duplicateFindingIds, feedbackBundles, implementWithLowConfidence, implementWithoutFileChanges, missingComment,
  ownerDecisionEmptyLists, planCitesMissingFile, planMissingWhy, planOverCeiling, planProse, planTiny, planTruncatedJson, planWithDecisions,
  reviewerFindings, reviewerHangs, supersedeAwareImplement, SUPERSEDE_RULE,
} from "../support/model-fixtures.js";
import { planAnswer, planDocument } from "../support/plan-documents.js";

const PLAN = planAnswer(planDocument({ title: "Add greet(name)", why: [{ text: "Greet by name.", author: "Maya" }],
  claims: [{ id: "1", text: "Add greet to greeting.ts." }], decisions: [] }));
const EDITS = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n" }];
const FIX = [{ path: "repo/demo/greeting.ts", content: "export function greet(name: string): string {\n  return `Hello, ${name.trim()}`;\n}\n" }];
const edits = (latest: string) => (latest.includes("Implement only the owner-approved PR feedback") ? FIX : EDITS);

async function toDraftPullRequest(e2e: WorkflowE2E): Promise<number> {
  expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
  await e2e.settle();
  await e2e.click("agentx_workflow_approve");
  await e2e.settle();
  expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  return e2e.github.pullRequests[0]!.number;
}

describe("workflow E2E harness", () => {
  let log: MockInstance<typeof console.log>;
  beforeEach(() => { log = vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { log.mockRestore(); });

  it("e2e.clock fakes Date only: now, advance and set move it, timers still run, and the test's end restores it", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.clock.set("2030-01-02T03:04:05.000Z");
    expect(new Date().toISOString()).toBe("2030-01-02T03:04:05.000Z");
    e2e.clock.advance(90_000);
    expect(e2e.clock.now()).toBe(Date.parse("2030-01-02T03:05:35.000Z"));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(e2e.clock.now()).toBe(Date.parse("2030-01-02T03:05:35.000Z"));
  });

  it("the clock is real again in the next test", () => {
    expect(Date.now()).toBeGreaterThan(Date.parse("2026-01-01T00:00:00Z"));
    expect(new Date().getUTCFullYear()).toBeLessThan(2030);
  });

  it("initial repository files are confined to repo/demo and included in its base commit", async () => {
    const content = "export const baseFixture = true;\n";
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: [] }, initialRepositoryFiles: [{ path: "nested/fixture.ts", content }] });
    expect(execFileSync("git", ["-C", e2e.repoDirectory, "show", `${e2e.baseCommit}:nested/fixture.ts`], { encoding: "utf8" })).toBe(content);
    await expect(createWorkflowE2E({ initialRepositoryFiles: [{ path: "../outside.txt", content }] })).rejects.toThrow(/stay inside repo\/demo/);
    await expect(createWorkflowE2E({ initialRepositoryFiles: [{ path: "/tmp/outside.txt", content }] })).rejects.toThrow(/stay inside repo\/demo/);
  }, 120_000);

  it("resets coder command queues for a fresh session with the same prompt, without resetting within-session tool turns", async () => {
    const step = workflowModel({ plan: PLAN, edits: EDITS, beforeEditsCommands: ["echo before"], afterEditsCommands: ["echo after"] });
    if (typeof step !== "function") throw new Error("workflowModel did not return a callable response step");
    type Message = Parameters<typeof step>[0]["messages"][number];
    const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
    const assistant: Message = { role: "assistant", content: [], api: "openai-completions", provider: "openai", model: "test-model",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 0 };
    const toolResult: Message = { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [], isError: false, timestamp: 0 };
    const faux = fauxProvider();
    const model = faux.getModel();
    if (model === undefined) throw new Error("fauxProvider did not provide its default model");
    const samePrompt = "Implement the approved plan.";
    const call = (messages: Message[]) => step(normalizeContext({ messages }), undefined, faux.state, model) as Promise<{ content: Array<{ type: string; name?: string }> }>;
    const names = async (messages: Message[]) => (await call(messages)).content.map((part) => part.name ?? part.type);
    const opening = [user(samePrompt)];
    expect(await names(opening)).toEqual(["bash"]);
    expect(await names([...opening, assistant, toolResult])).toEqual(["write"]);
    expect(await names([...opening, assistant, toolResult, assistant, toolResult])).toEqual(["bash"]);
    expect(await names([...opening, assistant, toolResult, assistant, toolResult, assistant, toolResult])).toEqual(["text"]);
    // A new Pi session starts with the same user text but has no prior assistant or tool-result messages.
    expect(await names([user(samePrompt)])).toEqual(["bash"]);
  });

  it("result rewrites are kind-matched, one-shot, and leave defaults inert", async () => {
    let failing = true;
    const rewrites: string[] = [];
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS },
      checkResult: () => failing ? { exitCode: 1, stdout: "", stderr: "expected failure\n" } : undefined });
    await expect(e2e.repoFile("greeting.test.js")).rejects.toThrow();
    e2e.worker.rewriteNextResult("task:IMPLEMENT", (result) => { rewrites.push("IMPLEMENT"); return result; });
    e2e.worker.rewriteNextResult("task:PLAN", (result) => { rewrites.push("PLAN"); return result; });
    expect(e2e.agentCheckRuns).toEqual([]);
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    expect(rewrites).toEqual(["PLAN"]);
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(rewrites).toEqual(["PLAN", "IMPLEMENT"]);
    expect(e2e.workflow()).toMatchObject({ stage: "VERIFY", state: "BLOCKED" });
    failing = false;
    await e2e.click("agentx_workflow_send_back");
    await e2e.settle();
    expect(rewrites).toEqual(["PLAN", "IMPLEMENT"]);
    expect(e2e.workflow()).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING" });
  }, 120_000);

  it("worker.failNext fails the next matching run at once, without running it", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.worker.failNext("task:PLAN", "the model provider is down");
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "PLAN", state: "BLOCKED" });
    expect(e2e.prompts).toEqual([]);
  }, 120_000);

  it("worker.crashNext loses a coding run with no callback; runRecovery's reconciler step fails it", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    e2e.worker.crashNext("task:IMPLEMENT");
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.worker.crashed).toEqual([expect.objectContaining({ kind: "task" })]);
    expect(e2e.workflow()).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING" });
    const { operationId: crashedOperation, workspaceId } = e2e.worker.crashed[0]!;
    const recovery = await e2e.runRecovery();
    expect(recovery.dispatch.statusCode).toBe(200);
    expect(recovery.lostOperations).toEqual([crashedOperation]);
    await e2e.settle();
    const operation = e2e.db.get(`WORKSPACE#${workspaceId}`, `OPERATION#${crashedOperation}`);
    expect(operation).toMatchObject({ status: "FAILED", error: LOST_COMPUTE_ERROR });
    // What the task does next is tests/integration/workflow-lost-run.test.ts's.
  }, 120_000);

  it("worker.crashNext with afterPush pushes the branch, then calls nothing back", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.worker.crashNext("publish", { afterPush: true });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.github.pushes.size).toBe(1);
    expect(e2e.github.pullRequests).toEqual([]);
    expect(e2e.worker.crashed).toEqual([expect.objectContaining({ kind: "publish" })]);
  }, 120_000);

  it("worker.features routes invocations through the real dispatcher and EC2 feature gate", async () => {
    const old = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    old.worker.features([]);
    expect(await old.mention("quick: Add a greet(name) function")).toBe(200);
    await old.settle();
    // The planning run carries a workflow mode, which a worker that lists no features cannot parse: the dispatcher fails it.
    expect(old.worker.deliveryFailures.map((failure) => failure.kind)).toEqual(["task"]);
    expect(old.worker.deliveryFailures[0]?.error).toMatch(/^RUNTIME_UNAVAILABLE: worker dispatch failed after 1 attempts/);
    expect(old.prompts).toEqual([]);

    const current = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    current.worker.features([...WORKER_INVOCATION_FEATURES]);
    await toDraftPullRequest(current);
    expect(current.worker.deliveryFailures).toEqual([]);

    // A worker that predates review feedback and plans gets reviews without those fields, as the gate drops them.
    const older = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    older.worker.features(WORKER_INVOCATION_FEATURES.filter((feature) => feature !== "task.workflowReviewPlan"));
    await toDraftPullRequest(older);
    const review = older.invocations.find((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "REVIEW");
    expect(review?.kind === "task" ? review.payload.workflowReviewPlan : "missing").toBeUndefined();
  }, 120_000);

  it("worker.stripInvocationFields leaves fields out, as an old broker would", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    e2e.worker.stripInvocationFields(["workflowReviewChecks"]);
    await toDraftPullRequest(e2e);
    const review = e2e.invocations.find((invocation) => invocation.kind === "task" && invocation.payload.workflowMode === "REVIEW");
    expect(review === undefined ? undefined : "workflowReviewChecks" in review.payload).toBe(false);
  }, 120_000);

  it("mention variants: a Slack retry of the same event starts nothing new, and a bot's message is not a request", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function", { eventId: "Ev0SAMEEVENT1" })).toBe(200);
    expect(await e2e.mention("quick: Add a greet(name) function", { eventId: "Ev0SAMEEVENT1", retryNum: 1 })).toBe(200);
    expect(e2e.db.find((item) => String(item.pk).startsWith("DEVTASK#") && item.sk === "META")).toHaveLength(1);
    const posts = e2e.slack.posts.length;
    expect(await e2e.mention("I am a bot", { type: "message", subtype: "bot_message", botId: "B0OTHERBOT1", threadTs: "1695500999.000001", ts: "1695500999.000001" })).toBe(200);
    expect(e2e.slack.posts.length).toBe(posts);
  }, 120_000);

  it("click variants: a press delivered twice records one decision; a press on a named card; concurrently runs steps together", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    const card = e2e.slack.lastPostWithAction("agentx_workflow_approve");
    await e2e.click("agentx_workflow_approve", { messageTs: card.ts, deliver: "twice" });
    await e2e.settle();
    expect(e2e.workflow().decisions.filter((decision) => decision.decision === "APPROVE")).toHaveLength(1);
    expect(e2e.slackActionTimestamps).toHaveLength(2);
    expect(e2e.slackActionTimestamps[0]).toBe(e2e.slackActionTimestamps[1]);
    await e2e.click("agentx_workflow_close");
    expect(e2e.slackActionTimestamps[2]).not.toBe(e2e.slackActionTimestamps[1]);
    expect(await e2e.concurrently(async () => 1, async () => 2)).toEqual([1, 2]);
  }, 120_000);

  it("feedbackPage and feedbackDecision drive the PR feedback page with its CSRF cookie and origin", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits } });
    const number = await toDraftPullRequest(e2e);
    const comment = e2e.github.comment(number, "octocat", "Please trim the name before greeting.");
    expect(await e2e.githubWebhook(number, { comment })).toBe(200);
    await e2e.settle();
    const page = await e2e.feedbackPage();
    expect(page.status).toBe(200);
    expect(page.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const review = JSON.parse((await e2e.feedbackPage(SLACK_MAYA, { api: true })).body) as { revision: number; reviewDigest: string; proposalDigest: string; bundleDigests: string[]; findings: Array<{ id: string }> };
    const body = { requestId: "4b0f5d3e-2c1a-4e6b-9f7d-1a2b3c4d5e6f", expectedRevision: review.revision, reviewDigest: review.reviewDigest,
      proposalDigest: review.proposalDigest, bundleDigests: review.bundleDigests, decision: "APPROVE", selectedFindingIds: review.findings.map((finding) => finding.id) };
    expect((await e2e.feedbackDecision(body, { csrf: null })).status).toBe(403);
    expect((await e2e.feedbackDecision(body, { origin: "https://evil.example" })).status).toBe(403);
    expect((await e2e.feedbackPage(OMAR)).status).toBe(404);
    expect((await e2e.feedbackDecision(body)).status).toBe(200);
    await e2e.settle();
    expect(e2e.workflow().feedbackDecisions?.at(-1)).toMatchObject({ decision: "APPROVE" });
  }, 120_000);

  it("e2e.mcp calls the real MCP tools against the same broker, as the named developer", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: EDITS } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    const listed = await e2e.mcp("agentx_list_tasks", {});
    expect(listed.isError).toBe(false);
    expect(JSON.stringify(listed.value)).toContain(e2e.taskId());
    expect(JSON.stringify((await e2e.mcp("agentx_list_tasks", {}, OMAR)).value)).not.toContain(e2e.taskId());
  }, 120_000);

  it("webhook() builds each event kind; redelivery is a duplicate; a wrong signature is refused; recovery runs", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits } });
    const number = await toDraftPullRequest(e2e);
    const made = e2e.github.review(number, "octocat", { body: null, state: "APPROVED" });
    const deliveryId = "0b7f8a52-6a4c-4c1e-9d0e-0f2a6f1e9c11";
    const first = await e2e.webhook({ kind: "pull_request_review", number, review: made.review, body: null, state: "APPROVED" }, { deliveryId });
    expect(first).toMatchObject({ status: 200, body: { delivery: "ACCEPTED" } });
    expect((await e2e.webhook({ kind: "pull_request_review", number, review: made.review, body: null, state: "APPROVED" }, { deliveryId })).body).toMatchObject({ delivery: "DUPLICATE" });
    expect((await e2e.webhook({ kind: "pull_request", action: "synchronize", number }, { secret: "x".repeat(40) })).status).toBe(403);
    await e2e.settle();
    const edited = e2e.github.editComment(e2e.github.comment(number, "octocat", "first words").id, "second words");
    expect((await e2e.webhook({ kind: "issue_comment", action: "edited", number, comment: edited })).status).toBe(200);
    expect((await e2e.runWebhookRecovery()).statusCode).toBe(200);
  }, 120_000);

  it("webhook secret controls: a rotated secret is read again on a bad signature; a missing one answers 503", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits } });
    const number = await toDraftPullRequest(e2e);
    e2e.rotateWebhookSecret("rotated-webhook-secret-0123456789abcdefghij");
    expect((await e2e.webhook({ kind: "pull_request", action: "synchronize", number })).status).toBe(200);
    e2e.setWebhookSecret(null);
    expect((await e2e.webhook({ kind: "pull_request", action: "synchronize", number })).status).toBe(503);
    const missing = await createWorkflowE2E({ webhookSecret: null, model: { plan: PLAN, edits } });
    const other = await toDraftPullRequest(missing);
    expect((await missing.webhook({ kind: "pull_request", action: "synchronize", number: other })).status).toBe(503);
  }, 120_000);

  it("wire mode reads PR feedback through the real GitHub App provider, with string GraphQL IDs", async () => {
    const e2e = await createWorkflowE2E({ github: { wire: true }, model: { plan: PLAN, edits } });
    const number = await toDraftPullRequest(e2e);
    const made = e2e.github.review(number, "octocat", { body: "Trim it.", state: "CHANGES_REQUESTED", comments: [{ body: "Here.", path: "greeting.ts", line: 2 }] });
    expect((await e2e.webhook({ kind: "pull_request_review", number, review: made.review })).status).toBe(200);
    await e2e.settle();
    expect(e2e.github.graphqlDatabaseIdTypes()).toEqual(new Set(["string"]));
    expect(e2e.workflow().feedbackReview).toMatchObject({ status: "PENDING", reviewRef: { status: "COMPLETE" } });
  }, 120_000);

  it("workerTimeouts.reviewMs with reviewerHangs makes the review time out", async () => {
    const e2e = await createWorkflowE2E({ workerTimeouts: { reviewMs: 200 }, model: { plan: PLAN, edits: EDITS, reviews: { CODE: [reviewerHangs] } } });
    expect(await e2e.mention("quick: Add a greet(name) function")).toBe(200);
    await e2e.settle();
    await e2e.click("agentx_workflow_approve");
    await e2e.settle();
    expect(e2e.github.pullRequests).toEqual([]);
    expect(e2e.workflow()).toMatchObject({ stage: "REVIEW", state: "BLOCKED" });
  }, 120_000);
});

describe("model fixtures", () => {
  const read = (answer: string) => parsePlanDocument(answer, { kind: "plan" });

  it("planner fixtures read as documented", () => {
    expect(read(planProse)).toMatchObject({ ok: false, errors: [expect.stringMatching(/has no agentx-plan block/)] });
    expect(read(planTruncatedJson)).toMatchObject({ ok: false, errors: [expect.stringMatching(/is not closed/)] });
    expect(read(planMissingWhy)).toMatchObject({ ok: false, errors: [expect.stringMatching(/why/)] });
    expect(read(planOverCeiling())).toMatchObject({ ok: false, errors: [`the plan has ${PLAN_CLAIMS_MAX + 1} claims; at most ${PLAN_CLAIMS_MAX} are allowed`] });
    expect(read(planTiny())).toMatchObject({ ok: true, plan: { claims: [{ id: "1" }, { id: "2" }, { id: "3" }], decisions: [] } });
    const decided = read(planWithDecisions(3));
    expect(decided.ok && decided.plan.decisions.map((decision) => decision.id)).toEqual(["d1", "d2", "d3"]);
    expect(read(planCitesMissingFile())).toMatchObject({ ok: true });
  });

  it("reviewer and feedback fixtures have the documented shapes", () => {
    expect(Object.keys(reviewerFindings(2, { role: "SECURITY" }))).toEqual(["SECURITY"]);
    const prompt = `${SUPERSEDE_RULE}\nImmutable feedback bundle inputs (untrusted GitHub data):\n${JSON.stringify([{ bundleDigest: "a".repeat(64), comments: [{ id: "discussion:1" }, { id: "discussion:2" }] }])}`;
    expect(feedbackBundles(prompt)).toHaveLength(1);
    const findings = (answer: string) => (JSON.parse(answer) as { findings: Array<Record<string, unknown>> }).findings;
    expect(findings(ownerDecisionEmptyLists("Which way?")(prompt))[0]).toMatchObject({ proposedDisposition: "OWNER_DECISION", fixProposal: { fileChanges: [], tests: [] } });
    expect(findings(implementWithLowConfidence(prompt))[0]).toMatchObject({ proposedDisposition: "IMPLEMENT", confidence: { level: "LOW" } });
    expect(findings(implementWithoutFileChanges(prompt))[0]).toMatchObject({ fixProposal: { fileChanges: [] } });
    expect(findings(conflictingAsImplement(prompt))[0]).toMatchObject({ assessment: "CONFLICTING", proposedDisposition: "IMPLEMENT" });
    expect(new Set(findings(duplicateFindingIds(prompt)).map((finding) => finding.id)).size).toBe(1);
    expect(findings(missingComment(prompt))[0]).toMatchObject({ commentIds: ["discussion:1"] });
    expect(findings(supersedeAwareImplement(prompt))[0]).toMatchObject({ proposedDisposition: "IMPLEMENT" });
    expect(findings(supersedeAwareImplement(prompt.replace(SUPERSEDE_RULE, "")))[0]).toMatchObject({ proposedDisposition: "OWNER_DECISION" });
    // The default critic still answers the same prompt shape.
    expect(findings(feedbackCriticReply(prompt, { repositoryId: "demo", path: "greeting.ts", testPath: "greeting.test.ts" }))).toHaveLength(1);
  });
});
