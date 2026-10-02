// Spec 051 Task 5 (FR-008, D-2, D-7/P-2): a remaining regression opens a draft pull request with a checks section, the
// workspace keeps its latest task report, and with nothing to report the pull request is exactly as before.
import { randomUUID } from "node:crypto";
import {
  AGENTX_PREAMBLE_VERSION,
  agentxPreambleSha256,
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

beforeAll(loadSlackBroker);

interface Harness {
  handler: Handler;
  db: FakeDynamoDb;
  workspaceId: string;
  reconcilePullRequest: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const { handler, db, brokerInput } = createBroker();
  const reconcilePullRequest = brokerInput.githubPullRequests.reconcilePullRequest as ReturnType<typeof vi.fn>;
  reconcilePullRequest.mockResolvedValue({ number: 7, url: "https://github.com/example/demo/pull/7", reconciled: false });
  await registerSlackProject(handler, { readiness });
  const workspace = await ensureWorkspace(handler, thread, user);
  const workspaceId = workspace.body.workspaceId as string;
  markReady(db, workspaceId);
  return { handler, db, workspaceId, reconcilePullRequest };
}

/** Runs one task to SUCCEEDED, its result carrying `checks` when given, as a worker built with spec 051 does. */
async function completeTask(h: Harness, checks?: CheckReport): Promise<string> {
  const conversation = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {});
  const conversationId = (conversation.body.conversation as { id: string }).id;
  const task = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "fix it" });
  expect(task.status, JSON.stringify(task.body)).toBe(202);
  const operationId = (task.body.operation as { id: string }).id;
  await finishOperation(h.handler, h.db, h.workspaceId, operationId, "SUCCEEDED", {
    summary: "done", ...(checks === undefined ? {} : { checks }),
  });
  return operationId;
}

/** Asks for a pull request, then sends the worker's pull-request callback with publish's checks, when given. */
async function publish(h: Harness, publishChecks?: CheckEntry[]): Promise<{ status: number; invocation: { payload: Record<string, unknown> & { headBranch: string } } }> {
  const accepted = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/pull-requests`, {
    requestId: randomUUID(), repository: "demo", title: "Fix the bug",
  });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(202);
  const operationId = (accepted.body.operation as { id: string }).id;
  const invocation = h.db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as {
    callbackCapability: string;
    payload: Record<string, unknown> & { headBranch: string };
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
  return { status: callback.status, invocation };
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
    expect(latestChecksOf(h)).toBeUndefined();
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

  it("notes an already-failing check alone, and opens a normal pull request", async () => {
    const h = await harness();
    const already = entry({ before: "failed", after: "failed", class: "already_failing", output: "lint error" });
    await publish(h, [already]);
    const sent = sentToGitHub(h);
    expect(sent).not.toHaveProperty("draft");
    expect(sent.body).toContain("- `npm test (in repo/demo)`: failed → failed, already failing before this change");
  });

  it("lists a check with no earlier result without making a draft (Ruling C)", async () => {
    const h = await harness();
    await publish(h, [entry({ before: "unknown", after: "failed", class: "failing_no_before" })]);
    const sent = sentToGitHub(h);
    expect(sent).not.toHaveProperty("draft");
    expect(sent.body).toContain("unknown → failed, fails now, with no earlier result");
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

describe("the workspace's latest checks (spec 051)", () => {
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
    expect(typeof stored.completedAt).toBe("string");
    expect(typeof stored.fence).toBe("number");
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

  it("stores the report on a retried result whose first write did not land", async () => {
    const h = await harness();
    const latest = report();
    const operationId = await completeTask(h, latest);
    delete h.db.get(`WORKSPACE#${h.workspaceId}`, "META")!.latestChecks;
    await finishOperation(h.handler, h.db, h.workspaceId, operationId, "SUCCEEDED", { summary: "done", checks: latest });
    expect(latestChecksOf(h)).toMatchObject({ operationId });
  });

  it("leaves it unset for a worker that sends no report, or a task that failed", async () => {
    const h = await harness();
    await completeTask(h);
    expect(latestChecksOf(h)).toBeUndefined();
    const conversation = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const task = await serviceCall(h.handler, thread, user, "POST", `/v1/service/workspaces/${h.workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "x" });
    await finishOperation(h.handler, h.db, h.workspaceId, (task.body.operation as { id: string }).id, "FAILED", { checks: report() });
    expect(latestChecksOf(h)).toBeUndefined();
  });
});
