// Spec 051 Task 5 (FR-008, D-2, D-7/P-2): a remaining regression opens a draft pull request with a checks section, the
// workspace keeps its latest task report, and with nothing to report the pull request is exactly as before.
import { randomUUID } from "node:crypto";
import {
  AGENTX_PREAMBLE_VERSION,
  agentxPreambleSha256,
  checksReplyPrefix,
  checksSection,
  type CheckEntry,
  type CheckReport,
} from "@agentx/contracts";
import { beforeAll, describe, expect, it, type vi } from "vitest";
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
const attribution = `Requested in Slack thread https://slack.com/archives/${SLACK_CHANNEL}/p1695500000000002 by ${user}.`;

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

  it("does not ask when the project has no readiness checks, so the dispatcher need not ping the worker (M-3)", async () => {
    const h = await harness({ readiness: [] });
    const { invocation } = await publish(h);
    expect(invocation.payload).not.toHaveProperty("reportChecks");
  });

  // Ruling S (C-1): task 2 sees task 1's failure as already failing, but the pull request is the whole change since
  // preparation, where the check passed. It must open as a draft.
  it("opens a draft when task 1 regressed and task 2 reported the check as already failing", async () => {
    const h = await harness();
    await completeTask(h, report({ status: "regression", checks: [regression], extraTry: "given" }));
    const already = entry({ before: "failed", after: "failed", class: "already_failing", output: "1 failed" });
    const second = report({ checks: [already] });
    await completeTask(h, second);
    // The worker judges publish against preparation (Ruling S): passed then, failing now.
    await publish(h, [regression]);
    const sent = sentToGitHub(h);
    expect(sent.draft).toBe(true);
    expect(sent.body).toBe(`${attribution}\n\n${checksSection([regression], second)}`);
  });

  // Ruling S (I-1): a workspace prepared before spec 051 has no prepared keys, so its checks have no earlier result.
  it("opens a draft for a pre-051 workspace whose check fails at publish", async () => {
    const h = await harness();
    await publish(h, [entry({ before: "unknown", after: "failed", class: "failing_no_before", output: "1 failed" })]);
    const sent = sentToGitHub(h);
    expect(sent.draft).toBe(true);
    expect(sent.body).toContain("**This pull request is a draft: a check fails at publish.**");
    expect(sent.body).toContain("unknown → failed, fails now, with no earlier result");
  });

  it("keeps the developer API's draft default, and appends the section (M-5)", async () => {
    const h = await harness();
    const latest = report();
    await completeTask(h, latest);
    await publish(h, [entry()], { draft: true });
    expect(sentToGitHub(h)).toMatchObject({ draft: true, body: `${attribution}\n\n${checksSection([entry()], latest)}` });
  });

  it("tells the worker whether the pull request opened as a draft (Ruling Z)", async () => {
    const drafted = await harness();
    expect(await publishAnswer(drafted, [regression])).toMatchObject({ number: 7, draft: true });
    const normal = await harness();
    expect(await publishAnswer(normal, [entry()])).toMatchObject({ number: 7, draft: false });
  });

  it("forces a draft over an explicit draft: false when a check regressed", async () => {
    const h = await harness();
    await publish(h, [regression], { draft: false });
    expect(sentToGitHub(h).draft).toBe(true);
  });

  it("redacts a secret in a label or output again before it reaches GitHub (M-1)", async () => {
    const h = await harness();
    const secret = `ghp_${"a".repeat(36)}`;
    await publish(h, [entry({ label: `npm test --token ${secret}`, after: "failed", class: "regression", output: `token=${secret}` })]);
    expect(sentToGitHub(h).body).not.toContain(secret);
  });

  // P-2 (approved): this publication used to be refused by the worker; it now opens as a draft.
  it("opens a draft with the section when a publish-time check regressed", async () => {
    const h = await harness();
    expect((await publish(h, [regression])).status).toBe(200);
    const sent = sentToGitHub(h);
    expect(sent.draft).toBe(true);
    expect(sent.body).toBe(`${attribution}\n\n${checksSection([regression], undefined)}`);
    expect(sent.body).toContain("**This pull request is a draft: a check that passed before this change fails now.**");
    expect(sent.body).toContain("```text\n1 failed\n```");
    // The record keeps the body GitHub was given.
    expect(h.db.find((item) => item.entityType === "PULL_REQUEST")[0]).toMatchObject({ body: sent.body });
  });

  it("opens a draft after a task whose report is a regression, even when publish's checks pass", async () => {
    const h = await harness();
    const latest = report({ status: "regression", checks: [regression], extraTry: "given" });
    await completeTask(h, latest);
    await publish(h, [entry()]);
    const sent = sentToGitHub(h);
    expect(sent.draft).toBe(true);
    expect(sent.body).toBe(`${attribution}\n\n${checksSection([entry()], latest)}`);
  });

  it("opens a normal pull request with the section after a verified task", async () => {
    const h = await harness();
    const latest = report();
    await completeTask(h, latest);
    await publish(h, [entry()]);
    const sent = sentToGitHub(h);
    expect(sent).not.toHaveProperty("draft");
    expect(sent.body).toBe(`${attribution}\n\n${checksSection([entry()], latest)}`);
    expect(sent.body).toContain("No check that passed before this change fails now.");
  });

  it("leaves the pull request exactly as before with no report and passing checks (Review Focus 5)", async () => {
    const h = await harness();
    await completeTask(h);
    const { invocation } = await publish(h, [entry()]);
    expect(sentToGitHub(h)).toStrictEqual({
      repositoryUrl: "https://github.com/example/demo.git",
      headBranch: invocation.payload.headBranch,
      baseBranch: "main",
      title: "Fix the bug",
      body: attribution,
    });
    // Ruling T: the old worker's task is recorded as sending no report, which adds nothing to the description.
    expect(latestChecksOf(h)).toMatchObject({ report: { status: "not_verified", reason: "no_report" } });
  });

  it("leaves it exactly as before for a worker that reports no checks", async () => {
    const h = await harness();
    const { invocation } = await publish(h);
    expect(sentToGitHub(h)).toStrictEqual({
      repositoryUrl: "https://github.com/example/demo.git",
      headBranch: invocation.payload.headBranch,
      baseBranch: "main",
      title: "Fix the bug",
      body: attribution,
    });
  });

  it("notes a check the last task found already failing, and opens a normal pull request when publish's checks pass", async () => {
    const h = await harness();
    await completeTask(h, report({ checks: [entry({ before: "failed", after: "failed", class: "already_failing", output: "lint error" })] }));
    await publish(h, [entry()]);
    const sent = sentToGitHub(h);
    expect(sent).not.toHaveProperty("draft");
    expect(sent.body).toContain("- `npm test (in repo/demo)`: failed → failed, already failing before this change");
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

  it("keeps the whole description within GitHub's limit", async () => {
    const h = await harness();
    const many = Array.from({ length: 64 }, (_, index) => entry({
      id: `readiness:${index}`, label: `check ${index} ${"y".repeat(1_000)}`, after: "failed", class: "regression", output: "z\n".repeat(39) + "z".repeat(3_900),
    }));
    await publish(h, many);
    const sent = sentToGitHub(h);
    expect((sent.body as string).length).toBeLessThanOrEqual(65_536);
    expect(sent.body).toContain("to keep this description within GitHub's limit._");
    expect(sent.draft).toBe(true);
  });

  it("refuses checks that are not check entries", async () => {
    const h = await harness();
    expect((await publish(h, [{ ...regression, class: "bogus" } as unknown as CheckEntry])).status).toBe(400);
    expect(h.reconcilePullRequest).not.toHaveBeenCalled();
  });
});

describe("the workspace's latest checks (spec 051, Ruling T)", () => {
  it("stores the report of a task that succeeded, with its operation and fence", async () => {
    const h = await harness();
    const latest = report({ checks: [entry({ output: "q".repeat(10_000) })] });
    const operationId = await completeTask(h, latest);
    const stored = latestChecksOf(h)!;
    expect(stored).toMatchObject({
      operationId,
      // Cut to what the section shows, so the workspace record stays small.
      report: { ...latest, checks: [{ ...latest.checks[0], output: "q".repeat(4_000) }] },
    });
    expect(typeof stored.recordedAt).toBe("string");
    expect(stored.fence).toBe(h.db.get(`WORKSPACE#${h.workspaceId}`, `OPERATION#${operationId}`)!.fence);
  });

  it("reads a running task as interrupted, so an older report never stands for it", async () => {
    const h = await harness();
    await completeTask(h, report());
    const running = await completeTask(h, undefined, "none");
    expect(latestChecksOf(h)).toMatchObject({ operationId: running, report: { status: "not_verified", reason: "interrupted" } });
  });

  it.each([
    ["SUCCEEDED", "no_report"],
    ["FAILED", "failed"],
    ["CANCELLED", "cancelled"],
  ] as const)("records a %s task without a report as not verified (%s)", async (status, reason) => {
    const h = await harness();
    await completeTask(h, report());
    const operationId = await completeTask(h, undefined, status);
    expect(latestChecksOf(h)).toMatchObject({ operationId, report: { status: "not_verified", reason } });
  });

  it("keeps a failed task's report when it has one", async () => {
    const h = await harness();
    const stopped = report({ status: "not_verified", notVerifiedReason: "stopped", source: "none", checks: [] });
    await completeTask(h, stopped, "FAILED");
    expect(latestChecksOf(h)).toMatchObject({ report: stopped });
  });

  it("records a task its cancel ended as cancelled, and one whose cancel failed as interrupted", async () => {
    for (const [cancelStatus, reason] of [["SUCCEEDED", "cancelled"], ["FAILED", "interrupted"]] as const) {
      const h = await harness();
      await completeTask(h, report());
      const task = await completeTask(h, undefined, "none");
      const stopped = await h.handler({
        source: "agentx.slack-ingress", action: "stop-task", userId: user,
        thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000002" },
      });
      const cancelId = (JSON.parse(stopped.body) as { cancelOperationId: string }).cancelOperationId;
      await finishOperation(h.handler, h.db, h.workspaceId, cancelId, cancelStatus);
      expect(latestChecksOf(h)).toMatchObject({ operationId: task, report: { status: "not_verified", reason } });
    }
  });

  it("keeps the newer report when an older task's result arrives again after it", async () => {
    const h = await harness();
    const older = await completeTask(h, report({ status: "regression", checks: [regression] }));
    const newer = await completeTask(h, report());
    expect(latestChecksOf(h)).toMatchObject({ operationId: newer, report: { status: "verified" } });
    // The older task's terminal callback, retried late.
    await finishOperation(h.handler, h.db, h.workspaceId, older, "SUCCEEDED", { summary: "done", checks: report({ status: "regression", checks: [regression] }) });
    expect(latestChecksOf(h)).toMatchObject({ operationId: newer, report: { status: "verified" } });
  });

  it("writes the checks in the terminal transaction, so they land with the result or not at all", async () => {
    const h = await harness();
    const sent: string[] = [];
    const original = h.db.send;
    h.db.send = async (command) => {
      sent.push(command.constructor.name);
      return original(command);
    };
    await completeTask(h, report());
    expect(sent.filter((name) => name === "UpdateCommand")).toHaveLength(0);
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
    ["reruns the test before editing, so it is already failing", agentReport([agentEntry({ before: "failed", class: "already_failing" })])],
    ["reruns the test after editing, with no earlier result", agentReport([agentEntry({ before: "unknown", class: "failing_no_before" })])],
    ["runs a different test that passes", agentReport([agentEntry({ id: "agent:0", label: "pytest -k b", before: "unknown", after: "passed", class: "passing", output: "ok" })])],
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

  it("clears the failure when task 2 reruns the test and it now passes, and opens a normal pull request (C-1b)", async () => {
    const h = await harness({ readiness: [] });
    await completeTask(h, task1());
    const fixed = agentReport([agentEntry({ before: "failed", after: "passed", class: "fixed", output: "ok" })]);
    await completeTask(h, fixed);
    expect(standingOf(h)).toStrictEqual([]);
    await publish(h);
    const sent = sentToGitHub(h);
    expect(sent).not.toHaveProperty("draft");
    expect(sent.body).toContain("No check that passed before this change fails now.");
  });

  it("keeps a regression when the extra turn failed on a model error, because the failed task still reports it (C-1c)", async () => {
    const h = await harness({ readiness: [] });
    await completeTask(h, task1(), "FAILED");
    expect(standingOf(h)).toMatchObject(listed);
    await completeTask(h, undefined);
    await publish(h);
    expect(sentToGitHub(h).draft).toBe(true);
  });

  it.each([
    ["a task without a report", async (h: Harness) => { await completeTask(h, undefined, "SUCCEEDED"); }],
    ["a failed task", async (h: Harness) => { await completeTask(h, undefined, "FAILED"); }],
    ["a cancelled task", async (h: Harness) => { await completeTask(h, undefined, "CANCELLED"); }],
    ["a task still running", async (h: Harness) => { await completeTask(h, undefined, "none"); }],
    ["a task its cancel ended", async (h: Harness) => {
      await completeTask(h, undefined, "none");
      const stopped = await h.handler({
        source: "agentx.slack-ingress", action: "stop-task", userId: user,
        thread: { teamId: SLACK_TEAM, channelId: SLACK_CHANNEL, threadTs: "1695500000.000002" },
      });
      await finishOperation(h.handler, h.db, h.workspaceId, (JSON.parse(stopped.body) as { cancelOperationId: string }).cancelOperationId, "SUCCEEDED");
    }],
  ])("keeps the earlier failures through %s", async (_name, marker) => {
    const h = await harness({ readiness: [] });
    await completeTask(h, task1());
    await marker(h);
    expect(standingOf(h)).toMatchObject(listed);
    expect(latestChecksOf(h)).toMatchObject({ report: { status: "not_verified" } });
  });

  it("keeps a failure that a later task stopped before rerunning, and clears it only on a pass", async () => {
    const h = await harness({ readiness: [] });
    await completeTask(h, task1());
    await completeTask(h, agentReport([], { status: "not_verified", notVerifiedReason: "stopped", source: "none" }));
    expect(standingOf(h)).toMatchObject(listed);
  });

  it("does not let a project check's earlier failure draft a pull request that publish reran and passed", async () => {
    const h = await harness();
    await completeTask(h, report({ checks: [entry({ before: "failed", after: "failed", class: "already_failing", output: "lint error" })] }));
    await publish(h, [entry()]);
    expect(sentToGitHub(h)).not.toHaveProperty("draft");
  });
});
