import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackReviewWeb, type FeedbackReviewWebDependencies } from "../../packages/broker/src/aws/feedback-review-web.js";
import { getWorkflowFeedbackReview, submitWorkflowFeedbackDecision } from "../../packages/broker/src/aws/developer-tasks.js";
import { authenticateDeveloperSessionId } from "../../packages/broker/src/aws/developer-routes.js";
import { createCandidateManifest, createWorkflowSnapshot, requestWorkflowFeedbackReview, WorkflowFeedbackBundleSchema, WorkflowFeedbackReviewReportSchema } from "@agentx/contracts";
import { createDeveloperTaskBroker, MAYA, OMAR } from "../support/developer-task-broker.js";
import { githubWorkflowPullRequestKey } from "../../packages/broker/src/developer/task-records.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";

const taskId = randomUUID();
const origin = "https://agentx.example.test";
const finding = {
  id: "finding-empty-input", bundleDigest: "a".repeat(64), commentIds: ["comment-1"],
  priority: "MUST_FIX", assessment: "ACTIONABLE", recommended: true,
  evidence: [{ source: "PR diff", reference: "src/retry.ts:10" }], rationale: "Empty input reaches the retry loop.",
  confidence: { level: "HIGH", reason: "The current code has no empty-input check." }, proposedDisposition: "IMPLEMENT",
};

function request(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): AdaptedHttpRequest {
  return { method, path, headers: { host: "agentx.example.test", ...headers }, requestId: randomUUID(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

function dependencies(overrides: Partial<FeedbackReviewWebDependencies> = {}): FeedbackReviewWebDependencies {
  return {
    origin,
    authenticateSession: vi.fn(async (sessionId: string) => sessionId === "session-owner"
      ? { developerId: "d".repeat(64), sessionId, amr: "slack" as const, name: "Maya", slackUserId: "UOWNER" }
      : undefined),
    getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [{ repositoryId: "payments", number: 42, headSha: "c".repeat(40) }],
      findings: [{ ...finding, comments: [{ id: "comment-1", author: "reviewer", url: "https://github.com/example/repo/pull/42#discussion_r1", body: "Handle empty input", updatedAt: "2026-10-05T12:00:00.000Z", path: "src/retry.ts", line: 10 }] }],
      recommendedFindingIds: [finding.id], checks: ["npm test"],
    })),
    submitWorkflowFeedbackDecision: vi.fn(async (_caller, _task, input) => ({ status: "accepted", decision: input.decision })),
    now: () => 1_791_212_400_000,
    ...overrides,
  };
}

describe("authenticated PR feedback review web journey", () => {
  it("sends signed-out owners to same-origin sign-in with only an allowlisted review return path", async () => {
    const deps = dependencies();
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${taskId}`)}`);
    expect(response.body).not.toContain("Handle empty input");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  });

  it("renders a concise advisory first view and sets a secure CSRF cookie without exposing a token", async () => {
    const deps = dependencies();
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["x-robots-tag"]).toContain("noindex");
    expect(response.headers["set-cookie"]).toMatch(/__Host-agentx_review_csrf=[A-Za-z0-9_-]+; Secure; SameSite=Lax; Path=\//);
    expect(response.body).toContain("AI-generated advisory");
    expect(response.body).toContain("Approving starts the selected code changes and checks");
    expect(response.body).toContain("Handle retries");
    expect(response.body).toContain("1 comment grouped into 1 findings");
    expect(response.body).toContain("Approve recommended fixes");
    expect(response.body).toContain("Choose findings");
    expect(response.body).not.toContain("session-owner");
    expect(response.body).not.toContain("Bearer ");
    expect(deps.getWorkflowFeedbackReview).toHaveBeenCalledWith(expect.objectContaining({ slackUserId: "UOWNER" }), taskId);
  });

  it("does not let a copied browser review cookie outlive its server-side 15 minute expiry", async () => {
    const now = 1_791_212_400_000;
    const expiresAt = Math.floor(now / 1000) + 15 * 60;
    const deps = {
      developer: { issuer: origin, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: vi.fn() },
      documentClient: { send: vi.fn(async (command: { input?: { Key?: { pk?: string } } }) => ({ Item: command.input?.Key?.pk?.startsWith("DEVELOPER#")
        ? { displayName: "Maya", slackUserId: "UOWNER", revoked: false }
        : { sessionId: "session-owner", developerId: "d".repeat(64), amr: "slack", startedAt: new Date(now).toISOString(), endsAt: expiresAt + 7 * 24 * 60 * 60, reviewExpiresAt: expiresAt } })) },
      now: () => now,
    };
    const copiedCookieSession = "11111111-1111-4111-8111-111111111111";
    await expect(authenticateDeveloperSessionId(deps as never, copiedCookieSession)).resolves.toMatchObject({ sessionId: copiedCookieSession });
    deps.now = () => now + 15 * 60 * 1000;
    await expect(authenticateDeveloperSessionId(deps as never, copiedCookieSession)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it.each([
    ["APPROVE", "APPROVED", "Approved", "AgentX will continue with implementation"],
    ["REQUEST_CHANGES", "CHANGES_REQUESTED", "Changes requested", "AgentX is waiting for your updated instructions"],
    ["DISMISS", "DISMISSED", "Dismissed", "No code changes will start from this proposal"],
  ] as const)("renders a durable read-only %s outcome after the pending decision controls disappear", async (action, status, label, nextActionText) => {
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 13, status, qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [], findings: [{ ...finding, comments: [] }], recommendedFindingIds: [], checks: [],
      decision: { decision: action, nextAction: action === "APPROVE" ? "implementation" : "owner_review", at: "2026-10-05T12:00:00.000Z", selectedFindingIds: action === "APPROVE" ? [finding.id] : [] },
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`Decision recorded: ${label}`);
    expect(response.body).toContain(nextActionText);
    expect(response.body).not.toContain("Approve recommended fixes");
    expect(response.body).not.toContain("Request changes");
    expect(response.body).not.toContain("Include this finding");
    expect(response.body).not.toContain("__Host-agentx_review_csrf=");
  });

  it("keeps report-controlled finding IDs inside the inline script string", async () => {
    const attack = "bad</script><script>alert(1)</script>";
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      reviewDigest: "d".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [], checks: [],
      findings: [{ ...finding, id: attack, comments: [] }], recommendedFindingIds: [attack],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("</script><script>alert(1)");
    expect(response.body).toContain("bad\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e");
  });

  it("does not render comment source links outside canonical GitHub HTTPS", async () => {
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [], checks: [], recommendedFindingIds: [],
      findings: [{ ...finding, comments: [{ id: "comment-1", url: "https://evil.example/track", body: "Handle empty input", author: "reviewer" }] }],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.body).toContain("Handle empty input");
    expect(response.body).not.toContain("href=\"https://evil.example");
  });

  it("requires same-origin and the page CSRF token before accepting a decision", async () => {
    const deps = dependencies();
    const handler = createFeedbackReviewWeb(deps);
    const body = { requestId: randomUUID(), expectedRevision: 12, reviewDigest: "d".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], decision: "APPROVE", selectedFindingIds: [finding.id] };
    const deniedOrigin = await handler(request("POST", `/review/${taskId}/api/decision`, { cookie: "__Host-agentx_review_session=session-owner; __Host-agentx_review_csrf=csrf-value-0123456789abcdef012345", origin: "https://evil.example", "x-agentx-csrf": "csrf-value-0123456789abcdef012345", "content-type": "application/json" }, body), new URL(`/review/${taskId}/api/decision`, origin));
    expect(deniedOrigin.statusCode).toBe(403);
    const deniedToken = await handler(request("POST", `/review/${taskId}/api/decision`, { cookie: "__Host-agentx_review_session=session-owner; __Host-agentx_review_csrf=csrf-value-0123456789abcdef012345", origin, "x-agentx-csrf": "wrong", "content-type": "application/json" }, body), new URL(`/review/${taskId}/api/decision`, origin));
    expect(deniedToken.statusCode).toBe(403);
    expect(deps.submitWorkflowFeedbackDecision).not.toHaveBeenCalled();
  });

  it("rechecks the signed-in session for every request and does not reveal task data to another owner", async () => {
    const deps = dependencies({ authenticateSession: vi.fn(async () => undefined) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}/api`, { cookie: "__Host-agentx_review_session=revoked-session" }), new URL(`/review/${taskId}/api`, origin));
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("Handle retries");
    expect(deps.getWorkflowFeedbackReview).not.toHaveBeenCalled();
  });

  it("sends an explicit batch decision to the broker only after the owner action", async () => {
    const deps = dependencies();
    const handler = createFeedbackReviewWeb(deps);
    const payload = { requestId: randomUUID(), expectedRevision: 12, reviewDigest: "d".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], decision: "APPROVE", selectedFindingIds: [finding.id] };
    const response = await handler(request("POST", `/review/${taskId}/api/decision`, { cookie: "__Host-agentx_review_session=session-owner; __Host-agentx_review_csrf=csrf-value-0123456789abcdef012345", origin, "x-agentx-csrf": "csrf-value-0123456789abcdef012345", "content-type": "application/json" }, payload), new URL(`/review/${taskId}/api/decision`, origin));
    expect(response.statusCode).toBe(200);
    expect(deps.submitWorkflowFeedbackDecision).toHaveBeenCalledWith(expect.objectContaining({ slackUserId: "UOWNER" }), taskId, payload);
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

describe("broker-backed feedback review data", () => {
  async function preparedReview() {
    const now = "2026-10-05T12:00:00.000Z";
    const body = "Handle empty input";
    const githubFeedback = { pullRequest: { number: 42, url: "https://github.com/example/demo/pull/42", state: "open" as const,
      headBranch: "feature", baseBranch: "main", headCommit: "c".repeat(40), title: "Handle retries", body: "" },
      comments: [{ id: "comment-1", threadId: "thread-1", kind: "DISCUSSION" as const,
        url: "https://github.com/example/demo/pull/42#discussion_r1", author: "reviewer", updatedAt: now, body, path: "src/retry.ts", line: 10 }], threads: [] };
    const githubRead = vi.fn(async () => githubFeedback);
    const harness = await createDeveloperTaskBroker({ brokerExtra: { githubPullRequests: { getPullRequestFeedback: githubRead } } });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Handle retries", client: "test", workflow: true });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { ownerKey: string; workspaceId: string };
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "e".repeat(40) }]);
    const comment = { id: "comment-1", threadId: "thread-1", kind: "DISCUSSION" as const, author: "reviewer", url: "https://github.com/example/demo/pull/42#discussion_r1", bodyDigest: "f".repeat(64), bodyBytes: 18, updatedAt: now, path: "src/retry.ts", line: 10 };
    const commentRef = { ...comment, bodyDigest: createHash("sha256").update(body).digest("hex"), bodyBytes: Buffer.byteLength(body) };
    const validComment = { id: commentRef.id, threadId: commentRef.threadId, kind: commentRef.kind, url: commentRef.url,
      author: commentRef.author, updatedAt: commentRef.updatedAt, bodyDigest: commentRef.bodyDigest, bodyBytes: commentRef.bodyBytes,
      path: commentRef.path, line: commentRef.line, body };
    const commentSetDigest = createHash("sha256").update(JSON.stringify([validComment])).digest("hex");
    const bundle = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId, repositoryId: "demo", number: 42, headSha: "c".repeat(40), candidateDigest: candidate.digest,
      commentSetDigest, producer: "test", version: "1", recordedAt: now, comments: [validComment], sourceDeliveryIds: ["delivery-1"] });
    const bundleBytes = JSON.stringify(bundle);
    const bundleDigest = (await import("node:crypto")).createHash("sha256").update(bundleBytes).digest("hex");
    const bundleKey = `private/${task.ownerKey}/${task.workspaceId}/feedback/${bundleDigest}.json`;
    harness.s3.objects.set(bundleKey, bundleBytes);
    const { sourceDeliveryIds: _deliveryIds, comments, ...bundleMetadata } = bundle;
    const bundleRef = { ...bundleMetadata, sha256: bundleDigest, objectKey: bundleKey, comments: [commentRef] };
    const findingRef = { id: "finding-1", bundleDigest, commentIds: ["comment-1"], priority: "MUST_FIX" as const,
      assessment: "ACTIONABLE" as const, recommended: true };
    const finding = { ...findingRef, evidence: [{ source: "code", reference: "src/retry.ts:10" }],
      rationale: "The input is not guarded.", confidence: { level: "HIGH" as const, reason: "The current branch accepts empty input." }, proposedDisposition: "IMPLEMENT" as const };
    const report = WorkflowFeedbackReviewReportSchema.parse({ schemaVersion: 1, taskId, workflowRevision: 2, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), taskRequirementsDigest: "d".repeat(64), candidateBindings: [{ repositoryId: "demo", number: 42, headSha: "c".repeat(40), candidateDigest: candidate.digest, commentSetDigest, bundleDigest }],
      operationId: randomUUID(), provider: "test", version: "1", status: "COMPLETE", bundleDigests: [bundleDigest], findingRefs: [findingRef], findings: [finding], recordedAt: now });
    const reportBytes = JSON.stringify(report);
    const reviewDigest = (await import("node:crypto")).createHash("sha256").update(reportBytes).digest("hex");
    const reportKey = `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/${reviewDigest}.json`;
    harness.s3.objects.set(reportKey, reportBytes);
    const { findings, ...reportMetadata } = report;
    const reportRef = { ...reportMetadata, sha256: reviewDigest, objectKey: reportKey };
    const base = createWorkflowSnapshot({ taskId, ownerId: task.ownerKey, now });
    const waiting = { ...base, stage: "WAIT_FOR_MERGE" as const, state: "WAITING" as const, candidate,
      verification: { candidateDigest: candidate.digest, producer: "test", environmentId: "fixture", recordedAt: now, results: [{ checkId: "test", status: "PASS" as const }] },
      reviews: (["CRITIC", "SECURITY"] as const).map(role => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: now })),
      pullRequests: [{ repositoryId: "demo", number: 42, url: "https://github.com/example/demo/pull/42", candidateDigest: candidate.digest, required: true, state: "OPEN" as const }] };
    const workflow = requestWorkflowFeedbackReview(waiting, { bundleRefs: [bundleRef], reviewRef: reportRef }, now);
    harness.db.set({ ...task, workflow });
    harness.db.set({ ...githubWorkflowPullRequestKey("example/demo", 42), entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: "example/demo",
      number: 42, repositoryId: "demo", taskId, workspaceId: task.workspaceId, candidateDigest: candidate.digest,
      url: "https://github.com/example/demo/pull/42" });
    const workspace = harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as Record<string, unknown>;
    harness.db.set({ ...workspace, status: "READY", activeOperationId: undefined });
    const deps = { documentClient: harness.db, tableName: "state", actions: harness.actions,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }), projectChannelIds: async () => [],
      refreshTaskFeedback: async () => undefined, now: () => Date.parse(now) };
    return { harness, taskId, deps, workflow, bundleDigest, reviewDigest, githubRead };
  }

  it("loads only the current owner's verified report and comment bundles through broker artifact reads", async () => {
    const fixture = await preparedReview();
    const data = await getWorkflowFeedbackReview(fixture.deps as never, { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId }, fixture.taskId);
    expect(data).toMatchObject({ status: "PENDING", qualification: "AI_GENERATED_ADVISORY", reviewDigest: fixture.reviewDigest, bundleDigests: [fixture.bundleDigest], findings: [{ id: "finding-1", comments: [{ body: "Handle empty input" }] }] });
    await expect(getWorkflowFeedbackReview(fixture.deps as never, { developerId: OMAR.developerId, sessionId: OMAR.sessionId, amr: "oidc", name: OMAR.name }, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("stores the attributed owner decision with a revision and digest condition", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId };
    const result = await submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    expect(result).toMatchObject({ status: "APPROVED", nextAction: "implementation" });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { ownerKey: string };
    expect(fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META")?.workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", feedbackDecisions: [{ actorRole: "TASK_OWNER", actorId: task.ownerKey, selectedFindingIds: ["finding-1"] }] });
  });

  it("refreshes GitHub twice and commits approval with one fenced implementation outbox", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId };
    const refresh = vi.fn(async () => undefined);
    fixture.deps.refreshTaskFeedback = refresh;
    const requestId = randomUUID();
    const payload = { requestId, expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE" as const, selectedFindingIds: ["finding-1"] };
    const result = await submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, payload);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "APPROVED", nextAction: "implementation" });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string; workflow: { state: string; feedbackDecisions: Array<{ requestId: string; selectedCommentIds: string[] }> } };
    expect(task.workflow).toMatchObject({ state: "RUNNING", feedbackDecisions: [{ requestId, selectedCommentIds: ["comment-1"] }] });
    const operations = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION");
    const dispatches = operations.filter(item => item.workflowMode === "IMPLEMENT");
    expect(dispatches).toHaveLength(1);
    const invocation = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === dispatches[0]?.id)[0]?.invocation as { payload?: { prompt?: string } };
    expect(invocation.payload?.prompt).toContain("Handle empty input");
    expect(invocation.payload?.prompt).toContain("finding-1");
    expect(invocation.payload?.prompt).toContain("do not post or submit a GitHub reply or review");
    await expect(submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, payload)).resolves.toMatchObject({ status: "APPROVED" });
    await expect(submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, { ...payload, selectedFindingIds: ["different-finding"] }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(operations.filter(item => item.workflowMode === "IMPLEMENT")).toHaveLength(1);
  });

  it("refuses a queued implementation at the broker worker-start callback after approval is invalidated", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId };
    await submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
    const operation = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")[0]!;
    const outbox = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === operation.id)[0]!;
    const invocation = outbox.invocation as { payload?: { workflowFeedbackApproval?: unknown } };
    // A GitHub delivery or owner action invalidates the approval after durable queueing but before
    // the worker's first callback. The queue entry remains; broker authorization must stop it.
    fixture.harness.db.set({ ...task, workflow: { ...task.workflow, revision: Number(task.workflow.revision) + 1 } });
    await expect(fixture.harness.callback(task.workspaceId, String(operation.id), "feedback-approval", invocation.payload?.workflowFeedbackApproval))
      .rejects.toThrow(/feedback approval|GitHub PR feedback changed|no longer current/i);
    expect(fixture.githubRead).toHaveBeenCalledWith("https://github.com/example/demo.git", 42);
  });

  it("does not dispatch when the second fresh GitHub read advances the bound workflow", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId };
    let reads = 0;
    fixture.deps.refreshTaskFeedback = async () => {
      reads += 1;
      if (reads === 2) {
        const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> & { revision: number } };
        fixture.harness.db.set({ ...task, workflow: { ...task.workflow, revision: task.workflow.revision + 1 } });
      }
    };
    await expect(submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    })).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string; workflow: { feedbackDecisions?: unknown[] } };
    expect(task.workflow.feedbackDecisions).toBeUndefined();
    expect(fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION").filter(item => item.workflowMode === "IMPLEMENT")).toHaveLength(0);
  });

  it.each([
    ["APPROVE", "APPROVED", "implementation", ["finding-1"]],
    ["REQUEST_CHANGES", "CHANGES_REQUESTED", "owner_review", []],
    ["DISMISS", "DISMISSED", "owner_review", []],
  ] as const)("keeps a verified %s review available as a private outcome after the owner decision", async (action, status, nextAction, selectedFindingIds) => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId };
    await submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: action, selectedFindingIds,
      ...(action === "APPROVE" ? {} : { ownerNote: "Please stop or revise this proposal." }),
    });
    await expect(getWorkflowFeedbackReview(fixture.deps as never, owner, fixture.taskId)).resolves.toMatchObject({
      status, decision: { decision: action, nextAction, selectedFindingIds },
    });
  });

  it("serves the verified review to the current owner through the broker route", async () => {
    const fixture = await preparedReview();
    const sessionId = randomUUID();
    fixture.harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: "slack", slackUserId: MAYA.slackUserId,
      startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, reviewExpiresAt: Math.floor(Date.now() / 1000) + 600 });
    const response = await fixture.harness.handler({
      version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${fixture.taskId}`, rawQueryString: "", headers: { host: "abc123.execute-api.us-east-1.amazonaws.com", cookie: `__Host-agentx_review_session=${sessionId}` },
      requestContext: { requestId: randomUUID(), http: { method: "GET" } },
    }) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("AI-generated advisory");
    expect(response.body).toContain("Handle empty input");
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

describe("broker feedback review route", () => {
  it("serves the public review route through the broker while preserving the same-origin sign-in redirect", async () => {
    const harness = await createDeveloperTaskBroker();
    const response = await harness.handler({
      version: "2.0", routeKey: "ANY /review/{proxy+}", rawPath: `/review/${taskId}`, rawQueryString: "", headers: { host: "abc123.execute-api.us-east-1.amazonaws.com" },
      requestContext: { requestId: randomUUID(), http: { method: "GET" } },
    }) as { statusCode: number; headers: Record<string, string>; body: string };
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`/v1/auth/browser/authorize?return_to=${encodeURIComponent(`/review/${taskId}`)}`);
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});
