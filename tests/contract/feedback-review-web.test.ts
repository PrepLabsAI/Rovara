import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFeedbackReviewWeb, type FeedbackReviewWebDependencies } from "../../packages/broker/src/aws/feedback-review-web.js";
import { getWorkflowFeedbackReview, submitWorkflowFeedbackDecision } from "../../packages/broker/src/aws/developer-tasks.js";
import { authenticateDeveloperSessionId } from "../../packages/broker/src/aws/developer-routes.js";
import { createCandidateManifest, createWorkflowSnapshot, observeWorkflowPullRequest, requestWorkflowFeedbackReview, WorkflowFeedbackBundleCommentsSchema, WorkflowFeedbackBundleSchema, WorkflowFeedbackReviewReportSchema, type TaskPersonProofRequest, type TaskPersonProofResponse, type WorkflowCheckPolicyInput, type WorkflowSnapshot } from "@agentx/contracts";
import { createDeveloperTaskBroker, MAYA, OMAR } from "../support/developer-task-broker.js";
import { githubWorkflowPullRequestKey, taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { feedbackReviewNoticeId } from "../../packages/broker/src/developer/notifications.js";
import type { AdaptedHttpRequest } from "../../packages/broker/src/aws/lambda.js";
import { changeTaskPeople, type CheckTaskPerson, type StoredTaskRole, type TaskPeopleDependencies } from "../../packages/broker/src/developer/task-people.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { SLACK_TEAM } from "../support/slack-broker.js";

const taskId = randomUUID();
const origin = "https://agentx.example.test";
const finding = {
  id: "finding-empty-input", bundleDigest: "a".repeat(64), commentIds: ["comment-1"],
  priority: "MUST_FIX", assessment: "ACTIONABLE", recommended: true,
  evidence: [{ source: "PR diff", reference: "src/retry.ts:10" }], rationale: "Empty input reaches the retry loop.",
  confidence: { level: "HIGH", reason: "The current code has no empty-input check." }, proposedDisposition: "IMPLEMENT",
  fixProposal: { summary: "Return safely for empty input.",
    fileChanges: [{ repositoryId: "payments", path: "src/retry.ts", operation: "MODIFY", change: "Add an empty-input guard." }],
    tests: [{ repositoryId: "payments", path: "src/retry.test.ts", operation: "ADD", behavior: "Assert empty input returns an empty result." }] },
};

function request(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): AdaptedHttpRequest {
  return { method, path, headers: { host: "agentx.example.test", ...headers }, requestId: randomUUID(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

type FeedbackReviewTestDependencies = FeedbackReviewWebDependencies & { observed: {
  reviewReads: Array<Parameters<FeedbackReviewWebDependencies["getWorkflowFeedbackReview"]>>;
  decisions: Array<Parameters<FeedbackReviewWebDependencies["submitWorkflowFeedbackDecision"]>>;
} };

function dependencies(overrides: Partial<FeedbackReviewWebDependencies> = {}): FeedbackReviewTestDependencies {
  const observed: FeedbackReviewTestDependencies["observed"] = { reviewReads: [], decisions: [] };
  const getReview = vi.fn(async (...args: Parameters<FeedbackReviewWebDependencies["getWorkflowFeedbackReview"]>) => {
    observed.reviewReads.push(args);
    return {
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [{ repositoryId: "payments", number: 42, headSha: "c".repeat(40) }],
      findings: [{ ...finding, comments: [{ id: "comment-1", author: "reviewer", url: "https://github.com/example/repo/pull/42#discussion_r1", body: "Handle empty input", updatedAt: "2026-10-05T12:00:00.000Z", path: "src/retry.ts", line: 10 }] }],
      recommendedFindingIds: [finding.id], checks: ["npm test"],
    };
  });
  const submitDecision = vi.fn(async (...args: Parameters<FeedbackReviewWebDependencies["submitWorkflowFeedbackDecision"]>) => {
    observed.decisions.push(args);
    return { status: "accepted" };
  });
  return {
    origin,
    authenticateSession: vi.fn(async (sessionId: string) => sessionId === "session-owner"
      ? { developerId: "d".repeat(64), sessionId, amr: "slack" as const, name: "Maya", slackUserId: "UOWNER" }
      : undefined),
    getWorkflowFeedbackReview: getReview,
    submitWorkflowFeedbackDecision: submitDecision,
    observed,
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
    // The sign-in lasts 30 days, but the CSRF cookie stays short-lived.
    expect(response.headers["set-cookie"]).toMatch(/__Host-agentx_review_csrf=[A-Za-z0-9_-]+; Secure; SameSite=Lax; Path=\/; Max-Age=900$/);
    expect(response.body).toContain("AI-generated advisory");
    expect(response.body).toContain("Approving starts the selected code changes and checks");
    expect(response.body).toContain("Handle retries");
    expect(response.body).toContain("1 comment grouped into 1 finding.<");
    expect(response.body).toContain("Approve recommended fixes");
    expect(response.body).toContain("Choose findings");
    expect(response.body).toContain("See proposed fix, comments and evidence");
    expect(response.body).toContain("Return safely for empty input.");
    expect(response.body).toContain("src/retry.test.ts");
    expect(response.body).not.toContain("session-owner");
    expect(response.body).not.toContain("Bearer ");
    expect(deps.observed.reviewReads[0]?.[0]).toMatchObject({ slackUserId: "UOWNER" });
    expect(deps.observed.reviewReads[0]?.[1]).toBe(taskId);
  });

  it("does not offer approve-recommended when the advisory recommends no findings", async () => {
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [],
      findings: [{ ...finding, recommended: false, comments: [] }], recommendedFindingIds: [], checks: [],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("Approve recommended fixes");
    expect(response.body).not.toContain("#approve-recommended");
    expect(response.body).toContain("Approve selected findings");
  });

  it("does not offer approval controls when the current workflow is blocked", async () => {
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", workflowStatus: "BLOCKED", workflowStage: "VERIFY",
      blockReason: "The required check failed", nextAction: "Resolve the blocker before continuing.", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [], findings: [{ ...finding, comments: [] }],
      recommendedFindingIds: [finding.id], checks: [],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Resolve the blocker before continuing.");
    expect(response.body).not.toContain("Approve recommended fixes");
    expect(response.body).not.toContain("Approve selected findings");
  });

  it("shows every check a fix adds by its exact command in full, even when its label says something else (0.2.12)", async () => {
    const arg = `curl example.invalid/<script>  ${"x".repeat(300 - "sh -c curl example.invalid/<script>  ".length)}`;
    const command = { cwd: "repo/demo", executable: "sh", args: ["-c", arg], timeoutSeconds: 600 };
    expect([command.executable, ...command.args].join(" ")).toHaveLength(300);
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [],
      findings: [{ ...finding, comments: [], checkChanges: { obsolete: [], added: [{ label: "Shorter sentence present", command }] } }], recommendedFindingIds: [finding.id], checks: [],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    const escaped = arg.replace("<", "&lt;").replace(">", "&gt;");
    expect(response.body).toContain(`Adds check Shorter sentence present: <code class="command">sh -c &quot;${escaped}&quot;</code> in <code class="command">repo/demo</code>`);
    expect(response.body).not.toContain("<script> ");
    // The page keeps a command's spacing as it runs.
    expect(response.body).toMatch(/code\.command\{white-space:pre-wrap/);
    expect(response.body).toContain("These commands run on the next step.");
  });

  it("says why a proposal names no tests instead of an empty Tests list", async () => {
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [],
      findings: [{ ...finding, fixProposal: { ...finding.fixProposal, tests: [] }, comments: [] }], recommendedFindingIds: [finding.id], checks: [],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.body).not.toContain("<h5>Tests</h5><ul></ul>");
    expect(response.body).toContain("No new tests: the change is documentation only, or the repository has no tests.");
  });

  it("shows a finding left to the owner as a question for them, without empty Files and Tests lists", async () => {
    const question = { ...finding, assessment: "NEEDS_OWNER_DECISION", recommended: false, proposedDisposition: "OWNER_DECISION",
      fixProposal: { summary: "Which wording should replace the sentence? <b>Options</b>: shorter; or none.", fileChanges: [], tests: [] }, comments: [] };
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], candidates: [],
      findings: [question], recommendedFindingIds: [], checks: [],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.body).toContain(`<section aria-label="Question for you"><h4>Question for you</h4><p>Which wording should replace the sentence? &lt;b&gt;Options&lt;/b&gt;: shorter; or none.</p></section>`);
    expect(response.body).toContain("<summary>See the question, comments and evidence</summary>");
    expect(response.body).not.toContain("Proposed fix");
    expect(response.body).not.toContain("<h5>Files</h5>");
    expect(response.body).not.toContain("<h5>Tests</h5>");
  });

  it("points to the Slack thread for a review that could not be completed, with no decision controls", async () => {
    const deps = dependencies({ getWorkflowFeedbackReview: vi.fn(async () => ({
      taskId, title: "Handle retries", revision: 12, status: "PENDING", reportStatus: "FAILED", workflowStatus: "WAITING", workflowStage: "WAIT_FOR_MERGE",
      nextAction: "Retry the review from the Slack thread of this task.", bundleDigests: ["a".repeat(64)], candidates: [], findings: [], recommendedFindingIds: [], checks: [],
    })) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${taskId}`, origin));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Retry the review from the Slack thread of this task.");
    // No count of an unfinished review's comments: it read none of them into findings.
    expect(response.body).not.toContain("grouped into");
    expect(response.body).toContain("The review didn't finish. Retry it from the task's Slack thread.");
    expect(response.body).not.toContain("Approve selected findings");
    expect(response.body).not.toContain("Request changes");
  });

  describe("a browser review sign-in lasts a fixed 30 days", () => {
    const signedInAt = 1_791_212_400_000;
    const DAY = 24 * 60 * 60;
    const copiedCookieSession = "11111111-1111-4111-8111-111111111111";
    const setup = (session: Record<string, unknown> = {}) => {
      const sent: unknown[] = [];
      const endsAt = Math.floor(signedInAt / 1000) + 30 * DAY;
      const deps = {
        developer: { issuer: origin, env: "test", methods: { slack: true, oidc: false }, signInTableName: "signin", channelMembers: vi.fn() },
        documentClient: { send: vi.fn(async (command: { input?: { Key?: { pk?: string } } }) => {
          sent.push(command);
          return { Item: command.input?.Key?.pk?.startsWith("DEVELOPER#")
            ? { displayName: "Maya", slackUserId: "UOWNER", revoked: false }
            : { sessionId: "session-owner", developerId: "d".repeat(64), amr: "slack", startedAt: new Date(signedInAt).toISOString(), endsAt, reviewExpiresAt: endsAt, ...session } };
        }) },
        now: () => signedInAt,
      };
      return { deps, sent };
    };

    it("works 29 days after sign-in and is refused after 30", async () => {
      const { deps } = setup();
      await expect(authenticateDeveloperSessionId(deps as never, copiedCookieSession)).resolves.toMatchObject({ sessionId: copiedCookieSession });
      deps.now = () => signedInAt + 29 * DAY * 1000;
      await expect(authenticateDeveloperSessionId(deps as never, copiedCookieSession)).resolves.toMatchObject({ sessionId: copiedCookieSession });
      deps.now = () => signedInAt + 30 * DAY * 1000;
      await expect(authenticateDeveloperSessionId(deps as never, copiedCookieSession)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    });

    it("is refused at once when the session is revoked", async () => {
      const { deps } = setup({ revokedAt: new Date(signedInAt + DAY * 1000).toISOString() });
      deps.now = () => signedInAt + 2 * DAY * 1000;
      await expect(authenticateDeveloperSessionId(deps as never, copiedCookieSession)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    });

    it("only reads the sign-in table on an authenticated page request", async () => {
      const { deps, sent } = setup();
      deps.now = () => signedInAt + 2 * DAY * 1000;
      await authenticateDeveloperSessionId(deps as never, copiedCookieSession);
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.map((command) => (command as object).constructor.name)).toEqual(sent.map(() => "GetCommand"));
    });
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
    expect(deps.observed.decisions).toHaveLength(0);
  });

  it("rechecks the signed-in session for every request and does not reveal task data to another owner", async () => {
    const deps = dependencies({ authenticateSession: vi.fn(async () => undefined) });
    const response = await createFeedbackReviewWeb(deps)(request("GET", `/review/${taskId}/api`, { cookie: "__Host-agentx_review_session=revoked-session" }), new URL(`/review/${taskId}/api`, origin));
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain("Handle retries");
    expect(deps.observed.reviewReads).toHaveLength(0);
  });

  it("sends an explicit batch decision to the broker only after the owner action", async () => {
    const deps = dependencies();
    const handler = createFeedbackReviewWeb(deps);
    const payload = { requestId: randomUUID(), expectedRevision: 12, reviewDigest: "d".repeat(64), proposalDigest: "b".repeat(64), bundleDigests: ["a".repeat(64)], decision: "APPROVE", selectedFindingIds: [finding.id] };
    const response = await handler(request("POST", `/review/${taskId}/api/decision`, { cookie: "__Host-agentx_review_session=session-owner; __Host-agentx_review_csrf=csrf-value-0123456789abcdef012345", origin, "x-agentx-csrf": "csrf-value-0123456789abcdef012345", "content-type": "application/json" }, payload), new URL(`/review/${taskId}/api/decision`, origin));
    expect(response.statusCode).toBe(200);
    expect(deps.observed.decisions[0]?.[0]).toMatchObject({ slackUserId: "UOWNER" });
    expect(deps.observed.decisions[0]?.[1]).toBe(taskId);
    expect(deps.observed.decisions[0]?.[2]).toEqual(payload);
    expect(response.headers["cache-control"]).toContain("no-store");
  });
});

describe("broker-backed feedback review data", () => {
  /** `firstFinding` changes the first finding (and its reference): for example, to leave it to the owner as a question. */
  async function preparedReview(prCount = 1, firstFinding: Record<string, unknown> = {}, checkPolicy?: WorkflowCheckPolicyInput,
    secondFinding: Record<string, unknown> = {}, taskPersonProof?: (request: TaskPersonProofRequest) => Promise<TaskPersonProofResponse>) {
    const now = "2026-10-05T12:00:00.000Z";
    const repositories = prCount === 1 ? [{ repositoryId: "demo", number: 42 }] : [
      { repositoryId: "demo", number: 42 }, { repositoryId: "ui", number: 43 },
    ];
    const bodyFor = (index: number) => index === 0 ? "Handle empty input" : "Keep the retry notice accessible";
    const githubFeedback = { pullRequest: { number: 42, url: "https://github.com/example/demo/pull/42", state: "open" as const,
      headBranch: "feature", baseBranch: "main", headCommit: "c".repeat(40), headTreeSha: "e".repeat(40), title: "Handle retries", body: "" },
      comments: [{ id: "comment-1", threadId: "thread-1", kind: "DISCUSSION" as const,
        url: "https://github.com/example/demo/pull/42#discussion_r1", author: "reviewer", updatedAt: now, body: bodyFor(0), path: "src/retry.ts", line: 10 }], threads: [] };
    const githubRead = vi.fn(async (url: string) => {
      const repositoryId = url.includes("/ui.") || url.endsWith("/ui") ? "ui" : "demo";
      const number = repositoryId === "ui" ? 43 : 42;
      const pullRequestUrl = `https://github.com/example/${repositoryId}/pull/${number}`;
      return { ...githubFeedback, pullRequest: { ...githubFeedback.pullRequest, number, url: pullRequestUrl,
        headCommit: repositoryId === "ui" ? "a".repeat(40) : "c".repeat(40),
        headTreeSha: repositoryId === "ui" ? "b".repeat(40) : "e".repeat(40) },
      comments: githubFeedback.comments.map(comment => ({ ...comment, url: `${pullRequestUrl}#discussion_r1` })) };
    });
    const harness = await createDeveloperTaskBroker({
      brokerExtra: { githubPullRequests: { getPullRequestFeedback: githubRead } },
      ...(taskPersonProof === undefined ? {} : { developerExtra: {
        taskPeopleConfiguration: { peopleChangesEnabled: true }, taskPersonProof,
      } }),
    });
    const started = await harness.dev(MAYA, "POST", "/v1/dev/tasks", { requestId: randomUUID(), project: "payments", instructions: "Handle retries", client: "test", workflow: true, workflowPath: "QUICK" });
    const taskId = String((started.body.task as { taskId: string }).taskId);
    const task = harness.db.get(`DEVTASK#${taskId}`, "META") as Record<string, unknown> & { ownerKey: string; workspaceId: string };
    const candidate = createCandidateManifest(repositories.map(({ repositoryId }) => ({ repositoryId, commitSha: repositoryId === "demo" ? "c".repeat(40) : "a".repeat(40), treeSha: repositoryId === "demo" ? "e".repeat(40) : "b".repeat(40) })));
    const bundles = await Promise.all(repositories.map(async ({ repositoryId, number }, index) => {
      const body = bodyFor(index);
      const commentId = `comment-${index + 1}`;
      const threadId = `thread-${index + 1}`;
      const url = `https://github.com/example/${repositoryId}/pull/${number}#discussion_r${index + 1}`;
      const commentRef = { id: commentId, threadId, kind: "DISCUSSION" as const, url, author: "reviewer",
        bodyDigest: createHash("sha256").update(body).digest("hex"), bodyBytes: Buffer.byteLength(body), updatedAt: now,
        path: index === 0 ? "src/retry.ts" : "src/notice.ts", line: 10 };
      const validComment = WorkflowFeedbackBundleCommentsSchema.parse([{ ...commentRef, body }])[0]!;
      const commentSetDigest = createHash("sha256").update(JSON.stringify([validComment])).digest("hex");
      const bundle = WorkflowFeedbackBundleSchema.parse({ schemaVersion: 1, taskId, repositoryId, number,
        headSha: repositoryId === "demo" ? "c".repeat(40) : "a".repeat(40), candidateDigest: candidate.digest,
        headTreeSha: candidate.repositories.find(repository => repository.repositoryId === repositoryId)?.treeSha,
        commentSetDigest, producer: "test", version: "1", recordedAt: now, comments: [validComment], sourceDeliveryIds: ["delivery-1"] });
      const bundleBytes = JSON.stringify(bundle);
      const bundleDigest = createHash("sha256").update(bundleBytes).digest("hex");
      const bundleKey = `private/${task.ownerKey}/${task.workspaceId}/feedback/${bundleDigest}.json`;
      harness.s3.objects.set(bundleKey, bundleBytes);
      const { sourceDeliveryIds: deliveryIds, comments, ...bundleMetadata } = bundle;
      void deliveryIds; void comments;
      return { digest: bundleDigest, commentSetDigest, ref: { ...bundleMetadata, sha256: bundleDigest, objectKey: bundleKey, comments: [commentRef] }, findingRef: {
        id: `finding-${index + 1}`, bundleDigest, commentIds: [commentId], priority: "MUST_FIX" as const,
        assessment: "ACTIONABLE" as const, recommended: true,
      }, finding: { id: `finding-${index + 1}`, bundleDigest, commentIds: [commentId], priority: "MUST_FIX" as const,
        assessment: "ACTIONABLE" as const, recommended: true, evidence: [{ source: "code", reference: `${commentRef.path}:10` }],
        rationale: index === 0 ? "The input is not guarded." : "The notice can be missed by keyboard users.",
        confidence: { level: "HIGH" as const, reason: "The linked source supports this finding." }, proposedDisposition: "IMPLEMENT" as const },
      };
    }));
    const refFields = ["assessment", "recommended", "priority"];
    bundles[0]!.finding = { ...bundles[0]!.finding, ...firstFinding };
    bundles[0]!.findingRef = { ...bundles[0]!.findingRef, ...Object.fromEntries(Object.entries(firstFinding).filter(([key]) => refFields.includes(key))) };
    if (bundles[1] !== undefined) {
      bundles[1].finding = { ...bundles[1].finding, ...secondFinding };
      bundles[1].findingRef = { ...bundles[1].findingRef, ...Object.fromEntries(Object.entries(secondFinding).filter(([key]) => refFields.includes(key))) };
    }
    const report = WorkflowFeedbackReviewReportSchema.parse({ schemaVersion: 1, taskId, workflowRevision: 2, operationMode: "FEEDBACK_REVIEW", qualification: "AI_GENERATED_ADVISORY",
      proposalDigest: "b".repeat(64), taskRequirementsDigest: "d".repeat(64), candidateBindings: bundles.map(({ ref, commentSetDigest, digest }) => ({ repositoryId: ref.repositoryId, number: ref.number,
        headSha: ref.headSha, candidateDigest: candidate.digest, commentSetDigest, bundleDigest: digest })),
      operationId: randomUUID(), provider: "test", version: "1", status: "COMPLETE", bundleDigests: bundles.map(bundle => bundle.digest),
      findingRefs: bundles.map(bundle => bundle.findingRef), findings: bundles.map(bundle => bundle.finding), recordedAt: now });
    const reportBytes = JSON.stringify(report);
    const reviewDigest = (await import("node:crypto")).createHash("sha256").update(reportBytes).digest("hex");
    const reportKey = `private/${task.ownerKey}/${task.workspaceId}/feedback-reviews/${reviewDigest}.json`;
    harness.s3.objects.set(reportKey, reportBytes);
    const { findings, ...reportMetadata } = report;
    void findings;
    const reportRef = { ...reportMetadata, sha256: reviewDigest, objectKey: reportKey };
    const base = createWorkflowSnapshot({ taskId, ownerId: task.ownerKey, now, ...(checkPolicy === undefined ? {} : { checkPolicy }) });
    const waiting = { ...base, stage: "WAIT_FOR_MERGE" as const, state: "WAITING" as const, candidate,
      verification: { candidateDigest: candidate.digest, producer: "test", environmentId: "fixture", recordedAt: now, results: [{ checkId: "test", status: "PASS" as const }] },
      reviews: (["CRITIC", "SECURITY"] as const).map(role => ({ operationId: randomUUID(), candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS" as const, findings: [], readOnly: true as const, recordedAt: now })),
      pullRequests: repositories.map(({ repositoryId, number }) => ({ repositoryId, number,
        headSha: repositoryId === "demo" ? "c".repeat(40) : "a".repeat(40), url: `https://github.com/example/${repositoryId}/pull/${number}`,
        candidateDigest: candidate.digest, required: true, state: "OPEN" as const })) };
    const workflow = requestWorkflowFeedbackReview(waiting, { bundleRefs: bundles.map(bundle => bundle.ref), reviewRef: reportRef }, now);
    harness.db.set({ ...task, workflow });
    for (const { repositoryId, number } of repositories) harness.db.set({ ...githubWorkflowPullRequestKey(`example/${repositoryId}`, number),
      entityType: "GITHUB_WORKFLOW_PR", repositoryFullName: `example/${repositoryId}`, number, repositoryId, taskId,
      workspaceId: task.workspaceId, candidateDigest: candidate.digest, url: `https://github.com/example/${repositoryId}/pull/${number}` });
    const workspace = harness.db.get(`WORKSPACE#${task.workspaceId}`, "META") as Record<string, unknown>;
    harness.db.set({ ...workspace, status: "READY", activeOperationId: undefined });
    const deps = { documentClient: harness.db, tableName: "state", actions: harness.actions,
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [] }), projectChannelIds: async () => [],
      refreshTaskFeedback: async () => undefined, now: () => Date.parse(now) };
    return { harness, taskId, deps, workflow, bundleDigest: bundles[0]!.digest, bundleDigests: bundles.map(bundle => bundle.digest), reviewDigest, githubRead };
  }

  const coOwner = { developerId: developerIdForSlackUser("U0COOWNER1"), slackUserId: "U0COOWNER1", name: "Bailey Co-owner",
    sessionId: "s-feedback-co-owner", amr: "slack" as const };
  const backupOwner = { developerId: developerIdForSlackUser("U0BACKUP01"), slackUserId: "U0BACKUP01", name: "Riley Backup" };

  async function preparedPeopleApproval() {
    let coOwnerProof: "eligible" | "departed" | "unknown" = "eligible";
    const linkedExternal = new Map<string, { developerId: string; slackUserId: string; name: string; issuer: string; subject: string }>();
    let pauseProof: Promise<void> | undefined;
    let proofEntered: (() => void) | undefined;
    const taskPersonProof = vi.fn(async (request: TaskPersonProofRequest) => {
      if (request.slackUserId === coOwner.slackUserId && pauseProof !== undefined) { proofEntered?.(); await pauseProof; }
      if (request.slackUserId === coOwner.slackUserId && coOwnerProof === "unknown") return { ok: false as const, error: "slack_unavailable" as const };
      if (request.slackUserId === coOwner.slackUserId && coOwnerProof === "departed") return { ok: false as const, error: "ineligible" as const };
      return { ok: true as const, user: { id: request.slackUserId, teamId: SLACK_TEAM,
        name: request.slackUserId === coOwner.slackUserId ? coOwner.name : request.slackUserId === backupOwner.slackUserId ? backupOwner.name : MAYA.name }, memberOf: [...request.channelIds] };
    });
    const fixture = await preparedReview(1, {}, undefined, {}, taskPersonProof);
    const createdAt = new Date().toISOString();
    const ownerPersonId = randomUUID();
    const coOwnerPersonId = randomUUID();
    const backupOwnerPersonId = randomUUID();
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON#${ownerPersonId}`, schemaVersion: 1, personId: ownerPersonId,
      developerId: MAYA.developerId, slackUserId: MAYA.slackUserId, name: MAYA.name, method: "slack", issuer: "https://slack.com", subject: MAYA.slackUserId, createdAt });
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON_SUBJECT#${MAYA.developerId}`, schemaVersion: 1,
      personId: ownerPersonId, developerId: MAYA.developerId, createdAt });
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON#${coOwnerPersonId}`, schemaVersion: 1, personId: coOwnerPersonId,
      developerId: coOwner.developerId, slackUserId: coOwner.slackUserId, name: coOwner.name, method: "slack", issuer: "https://slack.com", subject: coOwner.slackUserId, createdAt });
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON_SUBJECT#${coOwner.developerId}`, schemaVersion: 1,
      personId: coOwnerPersonId, developerId: coOwner.developerId, createdAt });
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON#${backupOwnerPersonId}`, schemaVersion: 1, personId: backupOwnerPersonId,
      developerId: backupOwner.developerId, slackUserId: backupOwner.slackUserId, name: backupOwner.name, method: "slack", issuer: "https://slack.com", subject: backupOwner.slackUserId, createdAt });
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON_SUBJECT#${backupOwner.developerId}`, schemaVersion: 1,
      personId: backupOwnerPersonId, developerId: backupOwner.developerId, createdAt });
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
      people: [{ developerId: MAYA.developerId, slackUserId: MAYA.slackUserId, name: MAYA.name, role: "owner" }] });
    const checkTaskPerson: CheckTaskPerson = async (_task, developerId) => {
      const person = developerId === coOwner.developerId ? coOwner : developerId === backupOwner.developerId ? backupOwner
        : linkedExternal.get(developerId) ?? { developerId: MAYA.developerId, slackUserId: MAYA.slackUserId!, name: MAYA.name };
      const state = developerId === coOwner.developerId ? coOwnerProof : "eligible";
      if (state === "unknown") throw new Error("proof unavailable");
      return { subject: { developerId, slackUserId: person.slackUserId },
        identity: { developerId, slackUserId: person.slackUserId, name: person.name,
          method: linkedExternal.has(developerId) ? "oidc" : "slack",
          issuer: linkedExternal.get(developerId)?.issuer ?? "https://slack.com",
          subject: linkedExternal.get(developerId)?.subject ?? person.slackUserId },
        eligible: state === "eligible", channelMember: state === "eligible" };
    };
    const peopleDeps: TaskPeopleDependencies = { ...fixture.deps, now: () => Date.parse("2026-10-05T12:00:00.000Z"),
      taskPeopleConfiguration: { peopleChangesEnabled: true }, checkTaskPerson };
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId! };
    await changeTaskPeople(peopleDeps, owner, fixture.taskId, { requestId: randomUUID(), expectedPeopleRevision: 1,
      targetDeveloperId: coOwner.developerId, role: "owner" });
    await changeTaskPeople(peopleDeps, owner, fixture.taskId, { requestId: randomUUID(), expectedPeopleRevision: 2,
      targetDeveloperId: backupOwner.developerId, role: "owner" });
    Object.assign(fixture.deps, { taskPeopleConfiguration: { peopleChangesEnabled: true }, checkTaskPerson });
    await submitWorkflowFeedbackDecision(fixture.deps, coOwner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const approvedTask = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const operation = fixture.harness.db.find(item => item.pk === `WORKSPACE#${approvedTask.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")[0]!;
    const outbox = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === operation.id)[0]!;
    const invocation = outbox.invocation as { payload?: { workflowFeedbackApproval?: unknown } };
    const callback = () => fixture.harness.callback(approvedTask.workspaceId, String(operation.id), "feedback-approval", invocation.payload?.workflowFeedbackApproval);
    const setCoOwnerRole = async (role: StoredTaskRole) => {
      const people = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "PEOPLE") as { revision: number };
      return changeTaskPeople(peopleDeps, owner, fixture.taskId, { requestId: randomUUID(), expectedPeopleRevision: people.revision,
        targetDeveloperId: coOwner.developerId, role });
    };
    const linkExternalCommenter = () => {
      const identity = { developerId: ownerKeyForSubject("https://login.example.test", "linked-co-owner"),
        slackUserId: coOwner.slackUserId, name: "Bailey External", issuer: "https://login.example.test", subject: "linked-co-owner" };
      linkedExternal.set(identity.developerId, identity);
      const personId = randomUUID();
      const createdAt = new Date().toISOString();
      fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId,
        ...identity, method: "oidc", createdAt });
      fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: `PERSON_SUBJECT#${identity.developerId}`, schemaVersion: 1,
        personId, developerId: identity.developerId, createdAt });
      const people = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "PEOPLE") as { revision: number; orphaned: boolean; people: unknown[] };
      fixture.harness.db.set({ ...people, revision: people.revision + 1, people: [...people.people,
        { developerId: identity.developerId, slackUserId: identity.slackUserId, name: identity.name, role: "commenter" }] });
      return identity;
    };
    return { ...fixture, callback, setCoOwnerRole, setProof: (value: typeof coOwnerProof) => { coOwnerProof = value; },
      linkExternalCommenter,
      pause: (proof: Promise<void>, entered: () => void) => { pauseProof = proof; proofEntered = entered; },
      actorId: taskOwnerKey(coOwner.developerId, fixture.taskId) };
  }

  it("lets a current co-owner read retained COMPLETE/MERGED feedback, while terminal mutation remains refused", async () => {
    const fixture = await preparedPeopleApproval();
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    fixture.harness.db.set({ ...task, workflow: { ...task.workflow!, stage: "MERGED", state: "COMPLETE" } });
    const reader = { ...coOwner, sessionId: coOwner.sessionId, amr: "slack" as const };
    const operationsBefore = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION");
    const decisionsBefore = task.workflow?.feedbackDecisions;

    await expect(getWorkflowFeedbackReview(fixture.deps as never, reader, fixture.taskId))
      .resolves.toMatchObject({ workflowStatus: "COMPLETE", workflowStage: "MERGED", reviewDigest: fixture.reviewDigest });
    await expect(submitWorkflowFeedbackDecision(fixture.deps as never, reader, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest,
      proposalDigest: "b".repeat(64), bundleDigests: [fixture.bundleDigest], decision: "DISMISS", selectedFindingIds: [],
    })).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const after = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    expect(after.workflow?.feedbackDecisions).toEqual(decisionsBefore);
    expect(fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION")).toEqual(operationsBefore);
  });

  it.each([
    ["viewer", "viewer" as const, "eligible" as const],
    ["denied principal", "denied" as const, "eligible" as const],
    ["unknown current proof", "owner" as const, "unknown" as const],
  ])("refuses terminal feedback artifact reads for a %s before reading any artifact", async (_label, role, proof) => {
    const fixture = await preparedPeopleApproval();
    if (role !== "owner") await fixture.setCoOwnerRole(role);
    fixture.setProof(proof);
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    fixture.harness.db.set({ ...task, workflow: { ...task.workflow!, stage: "MERGED", state: "COMPLETE" } });
    const readArtifact = vi.spyOn(fixture.harness.actions, "readArtifact");
    const failure = await getWorkflowFeedbackReview(fixture.deps as never, { ...coOwner, amr: "slack" }, fixture.taskId)
      .then(() => undefined, (error: unknown) => error);

    expect(failure).toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(readArtifact).not.toHaveBeenCalled();
    expect(fixture.harness.db.find(item => item.entityType === "OUTBOX")).toHaveLength(2);
  });

  it("does not treat a separately linked external identity as the native co-owner's terminal feedback grant", async () => {
    const fixture = await preparedPeopleApproval();
    const external = fixture.linkExternalCommenter();
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    fixture.harness.db.set({ ...task, workflow: { ...task.workflow!, stage: "MERGED", state: "COMPLETE" } });
    const readArtifact = vi.spyOn(fixture.harness.actions, "readArtifact");

    await expect(getWorkflowFeedbackReview(fixture.deps as never, { ...external, sessionId: "s-external", amr: "oidc" }, fixture.taskId))
      .rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    expect(readArtifact).not.toHaveBeenCalled();
  });

  it("loads only the current owner's verified report and comment bundles through broker artifact reads", async () => {
    const fixture = await preparedReview();
    const data = await getWorkflowFeedbackReview(fixture.deps, { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack", name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" }, fixture.taskId);
    expect(data).toMatchObject({ status: "PENDING", qualification: "AI_GENERATED_ADVISORY", reviewDigest: fixture.reviewDigest, bundleDigests: [fixture.bundleDigest], findings: [{ id: "finding-1", comments: [{ body: "Handle empty input" }] }] });
    await expect(getWorkflowFeedbackReview(fixture.deps as never, { developerId: OMAR.developerId, sessionId: OMAR.sessionId, amr: "oidc", name: OMAR.name }, fixture.taskId)).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });

  it("returns a review that could not be completed without reading its report, pointing to the Slack thread", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workflow: WorkflowSnapshot };
    const review = task.workflow.feedbackReview;
    if (review?.status !== "PENDING") throw new Error("the fixture's review is pending");
    fixture.harness.db.set({ ...task, workflow: { ...task.workflow, feedbackReview: { ...review,
      reviewRef: { ...review.reviewRef, status: "BLOCKED", blockReason: "review timed out", findingRefs: [] } } } });
    const data = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);
    expect(data).toMatchObject({ status: "PENDING", reportStatus: "BLOCKED", findings: [], nextAction: "Retry the review from the Slack thread of this task." });
  });

  it.each([
    ["VERIFY", "RUNNING", "Run the required checks for the current code version."],
    ["REVIEW", "RUNNING", "Complete the required code and security reviews."],
    ["PULL_REQUEST", "READY", "Create the required pull requests for the verified code."],
  ] as const)("shows the current %s stage action after the feedback decision", async (stage, state, expectedNextAction) => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workflow: Record<string, unknown> };
    fixture.harness.db.set({ ...task, workflow: { ...task.workflow, stage, state } });

    const data = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);

    expect(data).toMatchObject({ workflowStage: stage, workflowStatus: state, nextAction: expectedNextAction });
  });

  it("stores the attributed owner decision with a revision and digest condition", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const result = await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    expect(result).toMatchObject({ status: "APPROVED", nextAction: "implementation" });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { ownerKey: string };
    expect(fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META")?.workflow).toMatchObject({ stage: "IMPLEMENT", state: "RUNNING", feedbackDecisions: [{ actorRole: "TASK_OWNER", actorId: task.ownerKey, selectedFindingIds: ["finding-1"] }] });
  });

  it("approving a fix approves its check changes: the coding step and its checks run the updated set, and the review page shows them (0.2.12)", async () => {
    const grep = (text: string) => ({ cwd: "repo/demo", executable: "grep", args: ["-q", text, "README.md"], timeoutSeconds: 30 });
    const unit = { id: "required-1", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 } };
    const sentence = { id: "proposed-1", label: "Sentence present", command: grep("Old sentence.") };
    const links = { id: "proposed-2", label: "Links present", command: grep("CODE_OF_CONDUCT.md") };
    const replacement = { label: "Shorter sentence present", cwd: "repo/demo", executable: "grep", args: ["-q", "New.", "README.md"] };
    const fixture = await preparedReview(1, { fixProposal: { summary: "Shorten the sentence.",
      fileChanges: [{ repositoryId: "demo", path: "README.md", operation: "MODIFY", change: "Use the shorter sentence." }], tests: [],
      obsoleteChecks: ["proposed-1"], replacementChecks: [replacement] } },
    { required: [unit], optional: [], selectedOptionalIds: [], proposed: [sentence, links] });
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const review = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);
    const added = { cwd: replacement.cwd, executable: replacement.executable, args: replacement.args, timeoutSeconds: 600 };
    // The review returns each added check's command, which the owner approves with the fix.
    expect((review.findings as Array<Record<string, unknown>>)[0]?.checkChanges).toEqual({ obsolete: ["Sentence present"], added: [{ label: "Shorter sentence present", command: added }] });
    const page = await createFeedbackReviewWeb(dependencies({ getWorkflowFeedbackReview: vi.fn(async () => review) }))(
      request("GET", `/review/${fixture.taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }), new URL(`/review/${fixture.taskId}`, origin));
    expect(page.body).toContain("Updates checks: Sentence present → Shorter sentence present");
    // The per-finding view says it is for that finding alone; the combined block says what Approve recommended applies,
    // from the same computation the approval uses.
    expect(page.body).toContain("<h5>Checks, if approved on its own</h5>");
    expect(review.recommendedCheckChanges).toEqual([{ obsolete: ["Sentence present"], added: [{ label: "Shorter sentence present", command: added }] }]);
    expect(page.body).toMatch(/<section aria-label="Approve recommended applies"><h2>Approve recommended applies:<\/h2><p>Updates checks: Sentence present → Shorter sentence present<\/p><p>Adds check Shorter sentence present: <code class="command">grep -q New\. README\.md<\/code>/);
    expect(page.body).toContain('Adds check Shorter sentence present: <code class="command">grep -q New. README.md</code> in <code class="command">repo/demo</code>');
    expect(page.body).toContain("These commands run on the next step.");

    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string; workflow: WorkflowSnapshot };
    expect(task.workflow.checkPolicy?.proposed).toEqual([links, { id: "feedback-1-1", label: replacement.label, command: added }]);
    expect(task.workflow.checkPolicy?.required).toEqual([unit]);
    const dispatch = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION").find(item => item.workflowMode === "IMPLEMENT");
    const invocation = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === dispatch?.id)[0]?.invocation as { payload?: { readiness?: unknown; prompt?: string } };
    expect(invocation.payload?.readiness).toEqual([unit.command, links.command, added]);
    // The coder is given the approved fix itself (its summary and file changes), inside the untrusted data, so it makes
    // the change the owner approved.
    const prompt = invocation.payload?.prompt ?? "";
    const data = JSON.parse(prompt.split("\n\n").find((part) => part.startsWith("{\"findings\""))!) as { findings: Array<Record<string, unknown>> };
    expect(data.findings[0]).toMatchObject({ id: "finding-1", fix: { summary: "Shorten the sentence.",
      fileChanges: [{ repositoryId: "demo", operation: "MODIFY", path: "README.md", change: "Use the shorter sentence." }] } });
  });

  it("applies the approved findings' check changes in report order, as the card shows them, not in the page's priority order", async () => {
    const grep = (text: string) => ({ cwd: "repo/demo", executable: "grep", args: ["-q", text, "README.md"], timeoutSeconds: 30 });
    const sentence = { id: "proposed-1", label: "Sentence present", command: grep("Old sentence.") };
    const replacement = (label: string) => ({ label, cwd: "repo/demo", executable: "grep", args: ["-q", "New.", "README.md"] });
    const fix = (label: string) => ({ fixProposal: { summary: "Shorten the sentence.",
      fileChanges: [{ repositoryId: "demo", path: "README.md", operation: "MODIFY", change: "Use the shorter sentence." }], tests: [], replacementChecks: [replacement(label)] } });
    // The report lists finding-1 first; the page lists finding-2 first, because it is a must fix and finding-1 only a should fix.
    const fixture = await preparedReview(2, { priority: "SHOULD_FIX", ...fix("First label") }, { required: [], optional: [], selectedOptionalIds: [], proposed: [sentence] }, fix("Second label"));
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const review = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);
    expect((review.findings as Array<{ id: string }>).map(finding => finding.id)).toEqual(["finding-2", "finding-1"]);
    expect(review.reportOrder).toEqual(["finding-1", "finding-2"]);
    // What the card shows for the same two recommended fixes: the earlier finding's label is the one added.
    const { feedbackCardCheckChanges } = await import("../../packages/broker/src/aws/developer-task-notifier.js");
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workflow: WorkflowSnapshot };
    expect(review.recommendedCheckChanges).toMatchObject([{ added: [{ label: "First label" }] }]);
    expect(feedbackCardCheckChanges(task.workflow.checkPolicy, [fix("First label"), fix("Second label")].map(item => ({ proposedDisposition: "IMPLEMENT", ...item })))
      .map(entry => entry.added.map(check => check.label))).toEqual([["First label"], []]);

    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: fixture.bundleDigests, decision: "APPROVE", selectedFindingIds: ["finding-1", "finding-2"],
    });
    const stored = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workflow: WorkflowSnapshot };
    expect(stored.workflow.checkPolicy?.proposed.map(check => check.label)).toEqual(["Sentence present", "First label"]);
  });

  it("refuses, in plain words, approving a fix whose corrected check runs outside the task's repositories or drops a project check, and applies nothing (0.2.12)", async () => {
    const grep = (text: string) => ({ cwd: "repo/demo", executable: "grep", args: ["-q", text, "README.md"], timeoutSeconds: 30 });
    const unit = { id: "required-1", label: "Unit tests", command: { cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 600 } };
    const sentence = { id: "proposed-1", label: "Sentence present", command: grep("Old sentence.") };
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    for (const [checks, problem] of [
      [{ obsoleteChecks: ["proposed-1"], replacementChecks: [{ label: "Shorter sentence present", cwd: "other", executable: "grep", args: ["-q", "New.", "README.md"] }] }, "it must run in one of the task's repositories"],
      [{ obsoleteChecks: ["required-1"] }, "it names a project check, which always runs"],
    ] as const) {
      const fixture = await preparedReview(1, { fixProposal: { summary: "Shorten the sentence.",
        fileChanges: [{ repositoryId: "demo", path: "README.md", operation: "MODIFY", change: "Use the shorter sentence." }], tests: [], ...checks } },
      { required: [unit], optional: [], selectedOptionalIds: [], proposed: [sentence] });
      const refused = submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
        requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
        bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
      });
      await expect(refused).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      await expect(refused).rejects.toThrow(`The approved fix proposes a check change AgentX won't make: ${problem}. Dismiss the proposal or request changes.`);
      const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string; workflow: WorkflowSnapshot };
      expect(task.workflow).toEqual(fixture.workflow);
      expect(fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION").filter(item => item.workflowMode === "IMPLEMENT")).toEqual([]);
    }
  });

  it("checks corrected checks against the folders of the task's starting project revision, and looks the project up only when a fix adds checks (0.2.12 review)", async () => {
    const grep = (text: string) => ({ cwd: "repo/demo", executable: "grep", args: ["-q", text, "README.md"], timeoutSeconds: 30 });
    const sentence = { id: "proposed-1", label: "Sentence present", command: grep("Old sentence.") };
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const approve = (fixture: Awaited<ReturnType<typeof preparedReview>>) => submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const withProjects = (fixture: Awaited<ReturnType<typeof preparedReview>>, projects: { latestProject: unknown; projectRevision: unknown }) => {
      const actions = Object.assign(Object.create(fixture.deps.actions) as typeof fixture.deps.actions, projects);
      fixture.deps = { ...fixture.deps, actions };
    };
    const fixWith = (checks: Record<string, unknown>) => ({ fixProposal: { summary: "Shorten the sentence.",
      fileChanges: [{ repositoryId: "demo", path: "README.md", operation: "MODIFY", change: "Use the shorter sentence." }], tests: [], ...checks } });
    const policy = { required: [], optional: [], selectedOptionalIds: [], proposed: [sentence] };
    // A later registration renamed the folder; the task still works in the folder it started with.
    const renamed = await preparedReview(1, fixWith({ obsoleteChecks: ["proposed-1"], replacementChecks: [{ label: "Shorter", cwd: "repo/demo", executable: "grep", args: ["-q", "New.", "README.md"] }] }), policy);
    const revisions: Array<[string, number]> = [];
    const task = renamed.harness.db.get(`DEVTASK#${renamed.taskId}`, "META") as { project: string; startingRevision: number };
    withProjects(renamed, {
      latestProject: vi.fn(async () => ({ definition: { repositories: [{ path: "repo/renamed" }] } })),
      projectRevision: vi.fn(async (name: string, revision: number) => { revisions.push([name, revision]); return { definition: { repositories: [{ path: "repo/demo" }] } }; }),
    });
    await expect(approve(renamed)).resolves.toMatchObject({ status: "APPROVED" });
    expect(revisions).toEqual([[task.project, task.startingRevision]]);
    // A fix that adds no check never looks the project up.
    const plain = await preparedReview(1, fixWith({ obsoleteChecks: ["proposed-1"] }), policy);
    const unused = vi.fn(async () => { throw new Error("the project was looked up"); });
    withProjects(plain, { latestProject: unused, projectRevision: unused });
    await expect(approve(plain)).resolves.toMatchObject({ status: "APPROVED" });
    expect(unused).not.toHaveBeenCalled();
  });

  it("emits only privacy-safe aggregate decision measures after the owner decision commits", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const events: Array<Record<string, unknown>> = [];
    const decisionDeps = { ...fixture.deps, log: (entry: Record<string, unknown>) => { events.push(entry); } };
    fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`,
      sk: `NOTICE#${feedbackReviewNoticeId(fixture.taskId, fixture.reviewDigest, fixture.workflow.revision)}`,
      entityType: "NOTICE", deliveredAt: "2026-10-05T11:30:00.000Z" });

    await submitWorkflowFeedbackDecision(decisionDeps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest,
      proposalDigest: "b".repeat(64), bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });

    expect(events).toEqual([
      { event: "feedback_review.measure", measure: "feedback_notice_to_decision_1m_to_1h", count: 1, at: fixture.workflow.updatedAt },
      { event: "feedback_review.measure", measure: "feedback_recommendation_followed", count: 1, at: fixture.workflow.updatedAt },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/task|finding|reviewer|comment|diff|Maya|UOWNER/i);
  });

  it("refreshes GitHub twice and commits approval with one fenced implementation outbox", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const refresh = vi.fn(async () => undefined);
    fixture.deps.refreshTaskFeedback = refresh;
    const requestId = randomUUID();
    const payload = { requestId, expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE" as const, selectedFindingIds: ["finding-1"] };
    const result = await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, payload);
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

  it("refuses in plain words a decision whose GitHub refresh collected new feedback, before or right before dispatch", async () => {
    for (const refreshThatCollects of [1, 2]) {
      const fixture = await preparedReview();
      const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
      let refreshes = 0;
      // GitHub has a comment the card did not show: the refresh collects it, which starts a new review.
      fixture.deps.refreshTaskFeedback = vi.fn(async (): Promise<undefined> => {
        if (++refreshes !== refreshThatCollects) return undefined;
        const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workflow: WorkflowSnapshot };
        const review = task.workflow.feedbackReview!;
        fixture.harness.db.set({ ...task, workflow: { ...task.workflow, revision: task.workflow.revision + 1,
          feedbackReview: { status: "COLLECTING", bundleRefs: review.bundleRefs, threadObservations: [] } } });
        return undefined;
      });
      const refusal = await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, { requestId: randomUUID(), expectedRevision: fixture.workflow.revision,
        reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64), bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"] })
        .then(() => undefined, (error: unknown) => error);
      expect(refusal).toMatchObject({ code: "CONFIG_INVALID" });
      expect(refusal instanceof Error ? refusal.message : "").toContain("The feedback changed since this card; a new review is starting.");
      const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string; workflow: WorkflowSnapshot };
      expect(task.workflow.feedbackDecisions).toBeUndefined();
      expect(fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")).toEqual([]);
    }
  });

  /** The first finding as the 0.2.8 live test's reviewer left it: a question for the owner, with no file changes. */
  const QUESTION = { assessment: "NEEDS_OWNER_DECISION", recommended: false, proposedDisposition: "OWNER_DECISION",
    fixProposal: { summary: "Which wording should replace the sentence? Options: shorter; or none.", fileChanges: [], tests: [] } };

  it("refuses approving a question without the owner's answer, from the web page as from Slack", async () => {
    const fixture = await preparedReview(1, QUESTION);
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const payload = { requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE" as const, selectedFindingIds: ["finding-1"] };
    await expect(submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, payload)).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, payload)).rejects.toThrow(/add your answer to the reviewer's question/);
    expect(fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META")?.workflow).toMatchObject({ stage: "WAIT_FOR_MERGE", state: "WAITING", feedbackReview: { status: "PENDING" } });
    expect(fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META")?.workflow).not.toHaveProperty("feedbackDecisions");
  });

  it("caps the owner's words that reach the coder at 500 characters, as in Slack, and scopes them to the question", async () => {
    const fixture = await preparedReview(1, QUESTION);
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const payload = { requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE" as const, selectedFindingIds: ["finding-1"] };
    await expect(submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, { ...payload, ownerNote: "x".repeat(501) }))
      .rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, { ...payload, requestId: randomUUID(), ownerNote: "x".repeat(501) }))
      .rejects.toThrow(/to 500 characters/);
    await expect(submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, { ...payload, requestId: randomUUID(), ownerNote: "Use the shorter wording." }))
      .resolves.toMatchObject({ status: "APPROVED" });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string };
    const dispatch = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION").find(item => item.workflowMode === "IMPLEMENT");
    const invocation = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === dispatch?.id)[0]?.invocation as { payload?: { prompt?: string } };
    expect(invocation.payload?.prompt).toContain("The task owner's answer to the question of finding finding-1 (carry it out for that finding only): \"Use the shorter wording.\"");
    expect(invocation.payload?.prompt).toContain("\"question\":\"Which wording should replace the sentence? Options: shorter; or none.\"");
  });

  it("lets the owner approve findings bound to both linked PRs in one decision and dispatches once", async () => {
    const fixture = await preparedReview(2);
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const review = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);
    expect(review.candidates).toEqual([
      { repositoryId: "demo", number: 42, headSha: "c".repeat(40) },
      { repositoryId: "ui", number: 43, headSha: "a".repeat(40) },
    ]);
    expect(review.findings).toMatchObject([{ id: "finding-1" }, { id: "finding-2" }]);
    await expect(submitWorkflowFeedbackDecision(fixture.deps as never, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest,
      proposalDigest: "b".repeat(64), bundleDigests: fixture.bundleDigests, decision: "APPROVE",
      selectedFindingIds: ["finding-1", "finding-2"],
    })).resolves.toMatchObject({ status: "APPROVED", nextAction: "implementation" });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as { workspaceId: string; workflow: { feedbackDecisions: Array<{ bundleDigests: string[]; selectedFindingIds: string[] }> } };
    expect(task.workflow.feedbackDecisions[0]).toMatchObject({ bundleDigests: fixture.bundleDigests, selectedFindingIds: ["finding-1", "finding-2"] });
    expect(fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")).toHaveLength(1);
  });

  it("recreated review handlers show current blocked and merged status after an earlier approval", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    const webDependencies = (): FeedbackReviewWebDependencies => ({
      origin,
      authenticateSession: async sessionId => sessionId === "session-owner" ? owner : undefined,
      getWorkflowFeedbackReview: (caller, id) => getWorkflowFeedbackReview(fixture.deps, caller, id),
      submitWorkflowFeedbackDecision: (caller, id, input) => submitWorkflowFeedbackDecision(fixture.deps, caller, id, input),
      now: () => Date.parse("2026-10-05T12:00:00.000Z"),
    });
    const requestPage = async () => createFeedbackReviewWeb(webDependencies())(
      request("GET", `/review/${fixture.taskId}`, { cookie: "__Host-agentx_review_session=session-owner" }),
      new URL(`/review/${fixture.taskId}`, origin));

    expect((await requestPage()).body).toContain("Current workflow status");
    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest,
      proposalDigest: "b".repeat(64), bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const approvedReview = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);
    expect(approvedReview.decision).not.toHaveProperty("nextAction");
    expect(approvedReview.nextAction).toMatch(/^Implementation is (queued to start|in progress)\.$/);
    let pageAfterRestart = await requestPage(); // a new handler reads the committed owner decision from the persisted task
    expect(pageAfterRestart.body).toContain("Decision recorded: Approved");

    const blockedTask = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: Record<string, unknown> };
    fixture.harness.db.set({ ...blockedTask, workflow: { ...blockedTask.workflow, state: "BLOCKED", blockReason: "Required unit check failed" } });
    const workspace = fixture.harness.db.get(`WORKSPACE#${blockedTask.workspaceId}`, "META") as Record<string, unknown>;
    const operationId = randomUUID();
    fixture.harness.db.set({ ...workspace, activeOperationId: operationId });
    fixture.harness.db.set({ pk: `WORKSPACE#${blockedTask.workspaceId}`, sk: `OPERATION#${operationId}`, entityType: "OPERATION", id: operationId,
      workspaceId: blockedTask.workspaceId, kind: "task", workflowMode: "IMPLEMENT", status: "FAILED" });
    pageAfterRestart = await requestPage();
    expect(pageAfterRestart.body).toContain("Current workflow status: BLOCKED");
    expect(pageAfterRestart.body).toContain("Current operation status: FAILED");
    expect(pageAfterRestart.body).toContain("Required unit check failed");
    expect(pageAfterRestart.body).toContain("Resolve the blocker before continuing.");
    expect(pageAfterRestart.body).not.toContain("AgentX will continue with implementation and the selected checks.");

    const beforeMerge = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as Record<string, unknown> & { workspaceId: string; workflow: WorkflowSnapshot };
    const waitingForMerge = { ...beforeMerge.workflow, stage: "WAIT_FOR_MERGE", state: "WAITING", blockReason: undefined };
    fixture.harness.db.set({ ...beforeMerge, workflow: waitingForMerge });
    const candidate = waitingForMerge.candidate;
    if (candidate === undefined) throw new Error("fixture workflow must retain its candidate");
    const completed = observeWorkflowPullRequest(waitingForMerge, { repositoryId: "demo", number: 42,
      candidateDigest: candidate.digest, state: "MERGED", source: "GITHUB_API", observedAt: "2026-10-05T12:05:00.000Z" }, "2026-10-05T12:05:00.000Z");
    fixture.harness.db.set({ ...beforeMerge, workflow: { ...completed, canvasCloseout: {
      status: "ARCHIVE_PENDING", terminalState: "MERGED", manifestDigest: "c".repeat(64),
      manifestRef: `private/task-closeouts/${fixture.taskId}/${"c".repeat(64)}.json`, preparedAt: "2026-10-05T12:06:00.000Z",
      canvases: [{ lineageKey: "plan:1", canvasId: "F12345678", status: "UNKNOWN", attempts: 1, errorCategory: "canvas_not_found" }],
    } } });
    pageAfterRestart = await requestPage();
    expect(pageAfterRestart.body).toContain("Current workflow status: COMPLETE");
    expect(pageAfterRestart.body).toContain("Current stage: MERGED");
    expect(pageAfterRestart.body).toContain("All required pull requests are merged.");
    expect(pageAfterRestart.body).toContain('aria-label="Slack cleanup status"');
    expect(pageAfterRestart.body).toContain("Work complete.");
    expect(pageAfterRestart.body).toContain("AgentX is retrying Slack Canvas cleanup in the background.");
    expect(pageAfterRestart.body).toContain("No action is needed.");
  });

  it("refuses a queued implementation at the broker worker-start callback after approval is invalidated", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
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

  it("authorizes the exact freshly eligible co-owner at worker start while retaining the creator-bound approval", async () => {
    const fixture = await preparedPeopleApproval();
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const decision = task.workflow?.feedbackDecisions?.at(-1);
    const operation = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")[0]!;
    expect(decision?.actorId).toBe(fixture.actorId);
    expect(operation.workflowFeedbackApproval).toMatchObject({ ownerId: task.ownerKey });
    await expect(fixture.callback()).resolves.toMatchObject({ authorized: true });
  });

  it.each(["viewer", "denied"] as const)("refuses the stored co-owner after an accepted demotion to %s", async (role) => {
    const fixture = await preparedPeopleApproval();
    await fixture.setCoOwnerRole(role);
    await expect(fixture.callback()).rejects.toThrow(/feedback-approval callback failed/);
  });

  it("refuses an unavailable stored co-owner even while a different canonical owner remains freshly eligible", async () => {
    const fixture = await preparedPeopleApproval();
    fixture.setProof("unknown");
    const people = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "PEOPLE") as { people: Array<{ developerId: string; role: string }> };
    expect(people.people).toContainEqual(expect.objectContaining({ developerId: backupOwner.developerId, role: "owner" }));
    await expect(fixture.callback()).rejects.toThrow(/feedback-approval callback failed/);
  });

  it("fences a co-owner role change that commits while fresh proof is in flight", async () => {
    const fixture = await preparedPeopleApproval();
    let releaseProof!: () => void;
    const proofGate = new Promise<void>(resolve => { releaseProof = resolve; });
    let proofStarted!: () => void;
    const entered = new Promise<void>(resolve => { proofStarted = resolve; });
    fixture.pause(proofGate, proofStarted);
    const callback = fixture.callback();
    await entered;
    await fixture.setCoOwnerRole("viewer");
    releaseProof();
    await expect(callback).rejects.toThrow(/feedback-approval callback failed/);
  });

  it("fences a task close that commits while co-owner proof is in flight", async () => {
    const fixture = await preparedPeopleApproval();
    let releaseProof!: () => void;
    const proofGate = new Promise<void>(resolve => { releaseProof = resolve; });
    let proofStarted!: () => void;
    const entered = new Promise<void>(resolve => { proofStarted = resolve; });
    fixture.pause(proofGate, proofStarted);
    const callback = fixture.callback();
    await entered;
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META")!;
    fixture.harness.db.set({ ...task, closedAt: "2026-10-05T12:01:00.000Z" });
    releaseProof();
    await expect(callback).rejects.toThrow(/feedback-approval callback failed/);
  });

  it("keeps the legacy no-People creator callback valid", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const operation = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")[0]!;
    const outbox = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === operation.id)[0]!;
    const approval = (outbox.invocation as { payload?: { workflowFeedbackApproval?: unknown } }).payload?.workflowFeedbackApproval;
    await expect(fixture.harness.callback(task.workspaceId, String(operation.id), "feedback-approval", approval)).resolves.toMatchObject({ authorized: true });
  });

  it("fences People creation that commits after a legacy authorization read", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: "APPROVE", selectedFindingIds: ["finding-1"],
    });
    const task = fixture.harness.db.get(`DEVTASK#${fixture.taskId}`, "META") as unknown as DeveloperTaskRecord;
    const operation = fixture.harness.db.find(item => item.pk === `WORKSPACE#${task.workspaceId}` && item.entityType === "OPERATION" && item.workflowMode === "IMPLEMENT")[0]!;
    const outbox = fixture.harness.db.find(item => item.entityType === "OUTBOX" && item.operationId === operation.id)[0]!;
    const approval = (outbox.invocation as { payload?: { workflowFeedbackApproval?: unknown } }).payload?.workflowFeedbackApproval;
    const send = fixture.harness.db.send;
    fixture.harness.db.send = async (command) => {
      const input = (command as { constructor: { name: string }; input?: { Key?: { pk?: unknown; sk?: unknown } } }).input;
      const response = await send(command);
      if (command.constructor.name === "GetCommand" && input?.Key?.pk === `DEVTASK#${fixture.taskId}` && input.Key.sk === "PEOPLE"
        && (response as { Item?: unknown }).Item === undefined) {
        fixture.harness.db.set({ pk: `DEVTASK#${fixture.taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
          people: [{ developerId: MAYA.developerId, slackUserId: MAYA.slackUserId, name: MAYA.name, role: "owner" }] });
      }
      return response;
    };
    await expect(fixture.harness.callback(task.workspaceId, String(operation.id), "feedback-approval", approval))
      .rejects.toThrow(/feedback-approval callback failed/);
    fixture.harness.db.send = send;
  });

  it("does not dispatch when the second fresh GitHub read advances the bound workflow", async () => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
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
    ["REQUEST_CHANGES", "CHANGES_REQUESTED", "AgentX is waiting for your updated instructions.", []],
    ["DISMISS", "DISMISSED", "No code changes will start from this proposal.", []],
  ] as const)("keeps a verified %s review available as a private outcome after the owner decision", async (action, status, nextAction, selectedFindingIds) => {
    const fixture = await preparedReview();
    const owner = { developerId: MAYA.developerId, sessionId: MAYA.sessionId, amr: "slack" as const, name: MAYA.name, slackUserId: MAYA.slackUserId ?? "UOWNER" };
    await submitWorkflowFeedbackDecision(fixture.deps, owner, fixture.taskId, {
      requestId: randomUUID(), expectedRevision: fixture.workflow.revision, reviewDigest: fixture.reviewDigest, proposalDigest: "b".repeat(64),
      bundleDigests: [fixture.bundleDigest], decision: action, selectedFindingIds: [...selectedFindingIds],
      ...(action === "APPROVE" ? {} : { ownerNote: "Please stop or revise this proposal." }),
    });
    const current = await getWorkflowFeedbackReview(fixture.deps, owner, fixture.taskId);
    expect(current).toMatchObject({ status, decision: { decision: action, selectedFindingIds } });
    if (action === "APPROVE") expect(current.nextAction).toMatch(/^Implementation is (queued to start|in progress)\.$/);
    else expect(current.nextAction).toBe(nextAction);
  });

  it("serves the verified review to the current owner through the broker route", async () => {
    const fixture = await preparedReview();
    const sessionId = randomUUID();
    fixture.harness.db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId: MAYA.developerId, amr: "slack", slackUserId: MAYA.slackUserId ?? "UOWNER",
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
