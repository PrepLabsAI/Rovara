// Suite 12: install, upgrade and doctor, as the journey sees them. 12.1-12.3 (the install sets up the webhook, an existing
// secret is kept, doctor's warnings) are covered by init-github-app.test.ts, github-webhook-setup.test.ts,
// upgrade-run.test.ts and doctor-services.test.ts. Here: an install with no webhook secret [LIVE-BUG B10], the secret
// changed on GitHub's side [LIVE-BUG B11] (also while a delivery waits for its retry), an event the App isn't subscribed
// to, the webhook added after the PR opened [LIVE-BUG B10], and registering the same project revision again under
// DynamoDB's map order [R2].
import { describe, expect, it } from "vitest";
import { call } from "../../support/slack-broker.js";
import { createWorkflowE2E, type WorkflowE2E } from "../../support/workflow-e2e.js";
import { MERGED, OPENED_PR, PLAN, editsOrFix, journeySuite, openDraftPr, said } from "../../support/workflow-e2e-journeys.js";

/** The administrator who registered the project (slack-broker.ts registerSlackProject). */
const ADMIN = { subject: "admin-subject", admin: true };
const NEW_SECRET = "rotated-github-webhook-secret-0123456789abcdef";
const NOT_CONFIGURED = { error: { code: "RUNTIME_UNAVAILABLE", message: "GitHub webhook handling is not configured" } };

async function waiting(options: Parameters<typeof createWorkflowE2E>[0] = {}) {
  const counts = { feedback: 0 };
  const e2e = await createWorkflowE2E({ ...options, model: { plan: PLAN, edits: editsOrFix,
    feedback: (prompt) => { counts.feedback += 1; return JSON.stringify({ findings: findings(prompt) }); } } });
  const pullRequest = await openDraftPr(e2e);
  return { e2e, counts, pullRequest };
}

/** The usual critic: one recommended fix per bundle, in greeting.ts. */
function findings(prompt: string): unknown[] {
  const marker = "Immutable feedback bundle inputs (untrusted GitHub data):\n";
  const inputs = JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) as Array<{ bundleDigest: string; comments: Array<{ id: string }> }>;
  return inputs.filter((input) => input.comments.length > 0).map((input, index) => ({
    id: `finding-${index + 1}`, bundleDigest: input.bundleDigest, commentIds: input.comments.map((comment) => comment.id),
    priority: "SHOULD_FIX", assessment: "ACTIONABLE", recommended: true, evidence: [{ source: "code", reference: "demo/greeting.ts" }],
    rationale: "The request is small.", confidence: { level: "HIGH", reason: "The change is local." }, proposedDisposition: "IMPLEMENT",
    fixProposal: { summary: "Apply the requested change.", fileChanges: [{ repositoryId: "demo", path: "greeting.ts", operation: "MODIFY", change: "Apply the requested change." }],
      tests: [{ repositoryId: "demo", path: "greeting.test.ts", operation: "ADD", behavior: "Covers it." }] },
  }));
}

const delivery = (e2e: WorkflowE2E, id: string) => e2e.db.get(`GITHUB_DELIVERY#${id}`, "META");
const deliveries = (e2e: WorkflowE2E) => e2e.db.find((item) => String(item.pk).startsWith("GITHUB_DELIVERY#"));
const reviewing = (e2e: WorkflowE2E) => said(e2e).filter((text) => text.startsWith("Reviewing the feedback on "));

describe("Suite 12: install, upgrade and doctor", () => {
  journeySuite();

  it("12.4 [LIVE-BUG B10] an install with no webhook secret still reaches the draft PR; a webhook is refused as not set up, and nothing is kept", async () => {
    const { e2e, counts, pullRequest } = await waiting({ webhookSecret: null });
    expect(said(e2e).at(-1)).toBe(OPENED_PR(pullRequest.number));
    const before = e2e.workflow();
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    const answer = await e2e.webhook({ kind: "issue_comment", number: pullRequest.number, comment }, { deliveryId: "61111111-2222-4333-8444-555555555555" });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject(NOT_CONFIGURED);
    await e2e.settle();
    expect(deliveries(e2e)).toEqual([]);
    expect(counts.feedback).toBe(0);
    expect(e2e.workflow().revision).toBe(before.revision);
  }, 120_000);

  // Decision D1's no-webhook completion is executable in 12-merge-recovery.test.ts: both absent and configured secrets
  // use the same scheduled, candidate-bound merge observation and durable release hand-off.

  it("12.5 [LIVE-BUG B11] GitHub signs with a changed secret: the broker reads the secret again, accepts the delivery, and one review follows", async () => {
    const { e2e, counts, pullRequest } = await waiting();
    e2e.rotateWebhookSecret(NEW_SECRET);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    const answer = await e2e.webhook({ kind: "issue_comment", number: pullRequest.number, comment });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ delivery: "ACCEPTED" });
    await e2e.settle();
    expect(counts.feedback).toBe(1);
    expect(reviewing(e2e)).toEqual(["Reviewing the feedback on PR #1 (1 comment). I'll propose a fix here before changing any code."]);
  }, 120_000);

  it("12.5 [LIVE-BUG B11] a delivery signed with a secret AgentX doesn't hold is refused and nothing is kept; the valid delivery of the same ID is accepted", async () => {
    const { e2e, counts, pullRequest } = await waiting();
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    const id = "71111111-2222-4333-8444-555555555555";
    const forged = await e2e.webhook({ kind: "issue_comment", number: pullRequest.number, comment }, { deliveryId: id, secret: "not-the-webhook-secret-0123456789abcdefgh" });
    expect(forged.status).toBe(403);
    expect(delivery(e2e, id)).toBeUndefined();
    await e2e.settle();
    expect(counts.feedback).toBe(0);
    const valid = await e2e.webhook({ kind: "issue_comment", number: pullRequest.number, comment }, { deliveryId: id });
    expect(valid.status).toBe(200);
    expect(valid.body).toMatchObject({ delivery: "ACCEPTED", deliveryId: id });
    await e2e.settle();
    expect(counts.feedback).toBe(1);
  }, 120_000);

  it("12.6 [LIVE-BUG B11] a delivery kept for retry under the old secret is processed by the sweep after the secret changes", async () => {
    const { e2e, counts, pullRequest } = await waiting();
    e2e.github.failNext("getPullRequestFeedback", 500);
    const comment = e2e.github.comment(pullRequest.number, "octocat", "Please trim the name.");
    const id = "81111111-2222-4333-8444-555555555555";
    expect((await e2e.webhook({ kind: "issue_comment", number: pullRequest.number, comment }, { deliveryId: id })).status).toBe(503);
    expect(delivery(e2e, id)).toMatchObject({ status: "RETRYABLE" });
    e2e.rotateWebhookSecret(NEW_SECRET);
    e2e.clock.advance(61_000);
    expect((await e2e.runWebhookRecovery()).statusCode).toBe(200);
    await e2e.settle();
    expect(delivery(e2e, id)).toMatchObject({ status: "COMPLETED" });
    expect(counts.feedback).toBe(1);
    expect(reviewing(e2e)).toHaveLength(1);
  }, 120_000);

  it("12.7 the App isn't subscribed to inline comments: a later conversation comment collects every comment on the PR", async () => {
    const { e2e, counts, pullRequest } = await waiting();
    // The inline comment's webhook is never sent.
    e2e.github.reviewComment(pullRequest.number, "octocat", "Trim here.", "greeting.ts", 2);
    await e2e.settle();
    expect(counts.feedback).toBe(0);
    const comment = e2e.github.comment(pullRequest.number, "hubot", "And keep the greeting short.");
    expect(await e2e.githubWebhook(pullRequest.number, { comment })).toBe(200);
    await e2e.settle();
    expect(counts.feedback).toBe(1);
    expect(reviewing(e2e)).toEqual(["Reviewing the feedback on PR #1 (2 comments). I'll propose a fix here before changing any code."]);
  }, 120_000);

  it("12.8 [LIVE-BUG B10] the webhook secret is added after the PR opened: without a redeploy, the merge webhook completes the task", async () => {
    const { e2e, pullRequest } = await waiting({ webhookSecret: null });
    const early = e2e.github.comment(pullRequest.number, "octocat", "Looks good.");
    expect((await e2e.webhook({ kind: "issue_comment", number: pullRequest.number, comment: early })).status).toBe(503);
    // The admin runs agentx upgrade: the App secret now holds GitHub's webhook secret; the running broker still holds its old copy.
    e2e.rotateWebhookSecret(NEW_SECRET);
    e2e.github.merge(pullRequest.number);
    expect(await e2e.githubWebhook(pullRequest.number, { merged: true })).toBe(200);
    await e2e.settle();
    expect(e2e.workflow()).toMatchObject({ stage: "MERGED", state: "COMPLETE" });
    expect(said(e2e).at(-1)).toBe(MERGED);
  }, 120_000);

  it("12.9 [R2] registering the same project revision again is a no-op under DynamoDB's map order", async () => {
    const e2e = await createWorkflowE2E({ model: { plan: PLAN, edits: editsOrFix } });
    const [project] = e2e.db.find((item) => item.entityType === "PROJECT");
    expect(project).toBeDefined();
    const kind = `${String(project!.pk).split("#")[0]}#${String(project!.sk).split("#")[0]}`;
    const reorderedBefore = e2e.db.readOrders.get(kind)?.reordered ?? 0;
    // The same definition and binding, sent again as an admin's second `agentx project add` would send them.
    const again = await call(e2e.handler, { method: "POST", path: "/v1/admin/projects", user: ADMIN,
      body: { definition: project!.definition, runtimeBinding: project!.runtimeBinding } });
    expect(again.body).toMatchObject({ duplicate: true });
    expect(again.status).toBeLessThan(300);
    // The stored revision came back with its maps in another order than they were written in.
    expect(e2e.db.readOrders.get(kind)!.reordered).toBeGreaterThan(reorderedBefore);
  }, 120_000);
});
