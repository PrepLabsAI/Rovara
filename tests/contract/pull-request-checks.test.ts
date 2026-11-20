// Spec 051 Task 5 (FR-008, D-2, D-7/P-2): a remaining regression opens a draft pull request with a checks section, the
// workspace keeps its latest task report, and with nothing to report the pull request is exactly as before.
import { randomUUID } from "node:crypto";
import { AGENTX_PREAMBLE_VERSION, agentxPreambleSha256, checksReplyPrefix, type CheckEntry, type CheckReport } from "@agentx/contracts";
import { beforeAll, describe, expect, it, type vi } from "vitest";
import { DRAFT_REFUSED_PULL_REQUEST_NOTE } from "../../packages/broker/src/github-app.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import {
  call,
  createBroker,
  ensureWorkspace,
  finishOperation,
  loadSlackBroker,
  markReady,
  registerSlackProject,
  serviceCall,
  SLACK_CHANNEL,
  SLACK_TEAM,
  type Handler,
} from "../support/slack-broker.js";

const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000002`;
const user = "U0123456789";
const readiness = [{ cwd: "repo/demo", executable: "npm", args: ["test"], timeoutSeconds: 300 }];

const entry = (overrides: Partial<CheckEntry> = {}): CheckEntry => ({
  id: "readiness:0", label: "npm test (in repo/demo)", source: "project", before: "passed", after: "passed", class: "passing",
  output: "ok", durationMs: 5, ...overrides,
});
const report = (overrides: Partial<CheckReport> = {}): CheckReport => ({
  status: "verified", source: "project", preambleVersion: AGENTX_PREAMBLE_VERSION, preambleSha256: agentxPreambleSha256(),
  checks: [entry()], extraTry: "not_needed", agentClaim: "success", ...overrides,
});
const regression = entry({ after: "failed", class: "regression", output: "1 failed" });

// The first import of the broker module transforms its whole dependency graph (the AWS SDK clients included), which
// can pass vitest's 10 s hook default when many files load at once. The fixtures themselves are in-memory and fast.
beforeAll(loadSlackBroker, 60_000);

interface Harness {
  handler: Handler;
  db: FakeDynamoDb;
  workspaceId: string;
  reconcilePullRequest: ReturnType<typeof vi.fn>;
}

async function harness(options: { readiness?: unknown[] } = {}): Promise<Harness> {
  const { handler, db, brokerInput } = createBroker();
  const reconcilePullRequest = brokerInput.githubPullRequests.reconcilePullRequest as ReturnType<typeof vi.fn>;
  reconcilePullRequest.mockResolvedValue({ number: 7, url: "https://github.com/example/demo/pull/7", reconciled: false });
  await registerSlackProject(handler, { readiness: options.readiness ?? readiness });
  const workspace = await ensureWorkspace(handler, thread, user);
  const workspaceId = workspace.body.workspaceId as string;
  markReady(db, workspaceId);
  return { handler, db, workspaceId, reconcilePullRequest };
}

/** Runs one task to SUCCEEDED, its result carrying `checks` when given, as a worker built with spec 051 does. */
async function completeTask(h: Harness, checks?: CheckReport, status: "SUCCEEDED" | "FAILED" | "CANCELLED" | "none" = "SUCCEEDED"): Promise<string> {
  const conversation = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {});
  const conversationId = (conversation.body.conversation as { id: string }).id;
  const task = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "fix it" });
  expect(task.status, JSON.stringify(task.body)).toBe(202);
  const operationId = (task.body.operation as { id: string }).id;
  if (status !== "none") await finish(h, operationId, status, { summary: "done", ...(checks === undefined ? {} : { checks }) });
  return operationId;
}

/** The worker's terminal callback for one operation. */
async function finish(h: Harness, operationId: string, status: "SUCCEEDED" | "FAILED" | "CANCELLED", result?: unknown): Promise<void> {
  if (status !== "CANCELLED") return finishOperation(h.handler, h.db, h.workspaceId, operationId, status, result);
  const outbox = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!;
  const response = await call(h.handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${h.workspaceId}/operations/${operationId}/result`,
    headers: { "x-agentx-callback-capability": (outbox.invocation as { callbackCapability: string }).callbackCapability },
    body: { operationId, status, ...(result === undefined ? {} : { result }) },
  });
  expect(response.status).toBe(200);
}

/** Asks for a pull request, then sends the worker's pull-request callback with publish's checks, when given. */
async function publish(h: Harness, publishChecks?: CheckEntry[], options: { draft?: boolean } = {}): Promise<{ status: number; invocation: { payload: Record<string, unknown> & { headBranch: string } } }> {
  const accepted = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/pull-requests`, {
    requestId: randomUUID(), repository: "demo", title: "Fix the bug",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const operationId = (accepted.body.operation as { id: string }).id;
  const invocation = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as {
    callbackCapability: string;
    payload: Record<string, unknown> & { headBranch: string };
  };
  if (options.draft !== undefined) {
    // As the developer API stores it: its draft default is true (spec 025 FR-023).
    const stored = h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${operationId}`)!;
    stored.publication = { ...(stored.publication as Record<string, unknown>), draft: options.draft };
  }
  const callback = await call(h.handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${h.workspaceId}/operations/${operationId}/pull-request`,
    headers: { "x-agentx-callback-capability": invocation.callbackCapability },
    body: {
      repository: "demo", repositoryUrl: "https://github.com/example/demo.git", headBranch: invocation.payload.headBranch,
      baseBranch: "main", commit: "d".repeat(40), title: "Fix the bug",
      ...(publishChecks === undefined ? {} : { checks: publishChecks }),
    },
  });
  return { status: callback.status, invocation };
}

/** The broker's answer to the worker's pull-request callback, which the worker puts in the publish result. */
async function publishAnswer(h: Harness, publishChecks?: CheckEntry[]): Promise<Record<string, unknown>> {
  const accepted = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/pull-requests`, {
    requestId: randomUUID(), repository: "demo", title: "Fix the bug",
  });
  const operationId = (accepted.body.operation as { id: string }).id;
  const invocation = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as {
    callbackCapability: string; payload: { headBranch: string };
  };
  const callback = await call(h.handler, {
    method: "POST",
    path: `/v1/internal/workspaces/${h.workspaceId}/operations/${operationId}/pull-request`,
    headers: { "x-agentx-callback-capability": invocation.callbackCapability },
    body: {
      repository: "demo", repositoryUrl: "https://github.com/example/demo.git", headBranch: invocation.payload.headBranch,
      baseBranch: "main", commit: "d".repeat(40), title: "Fix the bug",
      ...(publishChecks === undefined ? {} : { checks: publishChecks }),
    },
  });
  expect(callback.status).toBe(200);
  return callback.body;
}

function sentToGitHub(h: Harness): Record<string, unknown> {
  expect(h.reconcilePullRequest).toHaveBeenCalledOnce();
  return h.reconcilePullRequest.mock.calls[0]![0] as Record<string, unknown>;
}

function latestChecksOf(h: Harness): Record<string, unknown> | undefined {
  return h.db.get(`WORKSPACE#${h.workspaceId}`, "META")?.latestChecks as Record<string, unknown> | undefined;
}

describe("the pull request's checks (spec 051 FR-008)", () => {
  it("asks the worker to report its checks rather than refuse a failing one (P-2)", async () => {
    const h = await harness();
    const { invocation } = await publish(h);
    expect(invocation.payload.reportChecks).toBe(true);
  });

  // Evaluation fix INTG1: GitHub refuses drafts on a private repository without draft support (GitHub Free); the GitHub client then opens a normal pull request, says so in its
  // result, and the broker tells the worker it is not a draft and records that drafts were refused.
  it("says the pull request is not a draft, and records why, when GitHub refused the draft and a normal pull request opened (INTG1)", async () => {
    const h = await harness();
    h.reconcilePullRequest.mockResolvedValue({ number: 7, url: "https://github.com/example/demo/pull/7", reconciled: false, draftRefused: true });
    expect(await publishAnswer(h, [regression])).toMatchObject({ number: 7, draft: false });
    expect(sentToGitHub(h).draft).toBe(true);
    const [record] = h.db.find((item) => item.entityType === "PULL_REQUEST");
    expect(record).toMatchObject({ number: 7, draftRefused: true });
    expect(String(record!.body)).toContain(DRAFT_REFUSED_PULL_REQUEST_NOTE);
  });

  it("says Not verified, and opens a normal pull request, after a task that failed following a verified one (Ruling T)", async () => {
    const h = await harness();
    await completeTask(h, report());
    await completeTask(h, undefined, "FAILED");
    await publish(h, [entry()]);
    const sent = sentToGitHub(h);
    expect(sent).not.toHaveProperty("draft");
    expect(sent.body).toContain("After the last task: Not verified (the task failed).");
    expect(sent.body).not.toContain("AgentX reran the project's checks:\n- `npm test (in repo/demo)`: passed → passed, passing\n\nAt publish");
  });

  it("refuses checks that are not check entries", async () => {
    const h = await harness();
    expect((await publish(h, [{ ...regression, class: "bogus" } as unknown as CheckEntry])).status).toBe(400);
    expect(h.reconcilePullRequest).not.toHaveBeenCalled();
  });
});

describe("the workspace's latest checks (spec 051, Ruling T)", () => {

  it.each([
    ["CANCELLED", "cancelled"],
  ] as const)("records a %s task without a report as not verified (%s)", async (status, reason) => {
    const h = await harness();
    await completeTask(h, report());
    const operationId = await completeTask(h, undefined, status);
    expect(latestChecksOf(h)).toMatchObject({ operationId, report: { status: "not_verified", reason } });
  });

});

// Ruling Y (C-1): with the agent's own commands there is no preparation baseline to judge publish against, so the
// workspace remembers every check that fails now, across tasks, until a later report shows it passing.
describe("standing failures across tasks (spec 051 Ruling Y)", () => {
  const agentEntry = (overrides: Partial<CheckEntry> = {}): CheckEntry => entry({
    id: "agent:0", label: "pytest -k a", source: "agent_commands", before: "passed", after: "failed", class: "regression", output: "1 failed", ...overrides,
  });
  const agentReport = (checks: CheckEntry[], overrides: Partial<CheckReport> = {}): CheckReport => report({ source: "agent_commands", checks, ...overrides });
  const task1 = () => agentReport([agentEntry()], { status: "regression", extraTry: "given" });
  const standingOf = (h: Harness): unknown => h.db.get(`WORKSPACE#${h.workspaceId}`, "META")?.standingFailures;
  const listed = [{ label: "pytest -k a", source: "agent_commands", class: "regression" }];

  it.each([
    ["runs no tests", agentReport([], { status: "not_verified", notVerifiedReason: "no_checks", source: "none" })],
  ])("opens a draft listing the earlier regression when task 2 %s (C-1a)", async (_name, second) => {
    const h = await harness({ readiness: [] });
    await completeTask(h, task1());
    await completeTask(h, second);
    expect(standingOf(h)).toMatchObject(listed);
    await publish(h);
    const sent = sentToGitHub(h);
    expect(sent.draft).toBe(true);
    expect(sent.body).toContain("**This pull request is a draft: a check that passed before this change fails now.**");
    expect(sent.body).toContain("`pytest -k a`");
    expect(sent.body).not.toContain("No check that passed before this change fails now.");
  });

  it("does not say Checks passed in the reply for a task that ran no tests (C-1a)", () => {
    expect(checksReplyPrefix([agentReport([], { status: "not_verified", notVerifiedReason: "no_checks", source: "none" })])).not.toContain("Checks passed");
  });


});
