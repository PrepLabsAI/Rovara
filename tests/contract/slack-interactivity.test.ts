// tests/contract/slack-interactivity.test.ts
import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  createWorkflowSnapshot,
  createCandidateManifest,
  requestWorkflowFeedback,
  WorkflowSnapshotSchema,
  submitWorkflowArtifact,
  answeredConfirmationBlocks,
  confirmationBlocks,
  confirmationClickEventId,
  type PendingConfirmation,
  type SlackRequestMessage,
} from "../../packages/contracts/src/index.js";
import {
  UNKNOWN_BUTTON_TEXT,
  confirmationActionHandler,
  createSlackInteractivityHandler,
  respondEphemeral,
  slackApi,
  type ConfirmationClickDependencies,
  type SlackActionHandler,
  type SlackBlockAction,
  workflowSlackHandlers,
} from "../../packages/broker/src/aws/slack-interactivity.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const nowSeconds = 1_758_657_600;
const requester = "U0123456789";
const other = "U0456789012";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const subject = `${thread.teamId}/${thread.channelId}/${thread.threadTs}`;
const pending: PendingConfirmation = {
  confirmationId: "44444444-4444-5444-8444-444444444444", requesterId: requester,
  calls: [{ tool: "tracker__close_item", argumentsHash: "a".repeat(64), summary: "tracker__close_item: id=TRK-9", kind: "destructive" }],
  postedAt: new Date(nowSeconds * 1_000 - 60_000).toISOString(), expiresAt: new Date(nowSeconds * 1_000 - 60_000 + CONFIRMATION_TTL_MS).toISOString(),
};
const text = "<@U0123456789>, before I go ahead, please confirm:\n• tracker__close_item: id=TRK-9 (destructive)";

function payload(options: { actionId?: string; value?: string; user?: string; type?: string } = {}) {
  return {
    type: options.type ?? "block_actions",
    team: { id: thread.teamId },
    user: { id: options.user ?? requester, team_id: thread.teamId },
    container: { type: "message", message_ts: "1695500001.000002", channel_id: thread.channelId, thread_ts: thread.threadTs },
    message: { ts: "1695500001.000002", thread_ts: thread.threadTs, text, blocks: confirmationBlocks(text, pending.confirmationId) },
    response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc",
    trigger_id: "1.2.3",
    actions: [{ action_id: options.actionId ?? "agentx_confirm_approve", value: options.value ?? pending.confirmationId, block_id: "agentx_confirmation" }],
  };
}

function signed(body: unknown, options: { timestamp?: number; signature?: string } = {}) {
  const raw = `payload=${encodeURIComponent(typeof body === "string" ? body : JSON.stringify(body))}`;
  const timestamp = String(options.timestamp ?? nowSeconds);
  const signature = options.signature ?? `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
  return { rawPath: "/v1/slack/interactions", body: raw, headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature, "content-type": "application/x-www-form-urlencoded" } };
}

function harness(options: { confirmation?: PendingConfirmation | undefined; failEnqueue?: boolean; extra?: SlackActionHandler[]; pendingAfter?: number } = {}) {
  const behind: number[] = [];
  const claimed = new Set<string>();
  const pendingCounts: number[] = [];
  const queue: Array<{ message: SlackRequestMessage; groupId: string }> = [];
  const updates: Array<{ channel: string; ts: string; text: string; blocks: unknown[] }> = [];
  const ephemeral: string[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const released: string[] = [];
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields }); };
  const confirmation = "confirmation" in options ? options.confirmation : pending;
  const handler = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    now: () => nowSeconds * 1_000,
    log,
    respondEphemeral: async (_url, value) => { ephemeral.push(value); },
    handlers: [confirmationActionHandler({
      loadConfirmation: async (key) => key === subject ? confirmation : undefined,
      claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
      releaseEvent: async (eventId) => { released.push(eventId); claimed.delete(eventId); },
      changePending: async (_subject, delta) => { pendingCounts.push(delta); return delta === 1 ? options.pendingAfter ?? 1 : 0; },
      enqueue: async (message, groupId, queuedBehind) => { if (options.failEnqueue) throw new Error("SQS down"); queue.push({ message, groupId }); behind.push(queuedBehind); },
      updateMessage: async (input) => { updates.push(input); },
      respondEphemeral: async (_url, value) => { ephemeral.push(value); },
      now: () => nowSeconds * 1_000,
      log,
    }), ...(options.extra ?? [])],
  });
  return { handler, queue, updates, ephemeral, logs, pendingCounts, released, behind };
}

describe("Slack interactivity request URL (spec 014 D2)", () => {
  it("refuses a request whose signature does not verify or is stale, before reading it", async () => {
    const { handler, queue } = harness();
    expect((await handler(signed(payload(), { signature: "v0=bad" }))).statusCode).toBe(401);
    expect((await handler(signed(payload(), { timestamp: nowSeconds - 301 }))).statusCode).toBe(401);
    expect(queue).toHaveLength(0);
  });

  it("refuses a payload that is not JSON, and ignores anything but block_actions", async () => {
    const { handler, queue } = harness();
    expect((await handler(signed("not json"))).statusCode).toBe(400);
    expect((await handler(signed(payload({ type: "view_submission" })))).statusCode).toBe(200);
    expect(queue).toHaveLength(0);
  });

  it("queues the requester's Approve as a yes with an event ID derived from the confirmation, and replaces the buttons", async () => {
    const { handler, queue, updates, ephemeral, pendingCounts } = harness();
    expect((await handler(signed(payload()))).statusCode).toBe(200);
    expect(queue).toEqual([{ groupId: expect.stringMatching(/^[a-f0-9]{64}$/) as string, message: {
      version: 1, eventId: confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt), thread, userId: requester, text: "yes", receivedAt: new Date(nowSeconds * 1_000).toISOString(),
    } }]);
    expect(pendingCounts).toEqual([1]);
    const note = `Approved by <@${requester}>. Running it now.`;
    expect(updates).toEqual([{ channel: thread.channelId, ts: "1695500001.000002", text: `${text}\n${note}`, blocks: answeredConfirmationBlocks(text, note) }]);
    expect(ephemeral).toEqual([]);
  });

  it("tells the queue how many earlier requests a click waits behind, as the message ingress does (spec 014 FR-026)", async () => {
    // Nothing ahead: the Slack service adds no "Working on it now" under the button's "Running it now".
    for (const [pendingAfter, expected] of [[1, 0], [3, 2], [0, 0]] as const) {
      for (const actionId of ["agentx_confirm_approve", "agentx_confirm_cancel"]) {
        const { handler, behind } = harness({ pendingAfter });
        await handler(signed(payload({ actionId })));
        expect(behind, `${actionId} with ${pendingAfter} pending`).toEqual([expected]);
      }
    }
  });

  it("queues the requester's Cancel as a cancel", async () => {
    const { handler, queue, updates } = harness();
    await handler(signed(payload({ actionId: "agentx_confirm_cancel" })));
    expect(queue[0]?.message).toMatchObject({ eventId: confirmationClickEventId(pending.confirmationId, "cancel", pending.postedAt), text: "cancel" });
    expect(updates[0]?.text).toContain(`Cancelled by <@${requester}>.`);
  });

  it("tells anyone else, privately, that only the requester can answer, and queues nothing", async () => {
    const { handler, queue, updates, ephemeral } = harness();
    await handler(signed(payload({ user: other })));
    expect(ephemeral).toEqual([`Only <@${requester}> can answer this confirmation.`]);
    expect(queue).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("says privately that a used, replaced or expired confirmation is no longer pending", async () => {
    for (const confirmation of [{ ...pending, retiredAt: new Date().toISOString(), usedBy: "Ev1234567890" }, { ...pending, confirmationId: "55555555-5555-5555-8555-555555555555" }, { ...pending, expiresAt: new Date(nowSeconds * 1_000).toISOString() }, undefined]) {
      const { handler, queue, ephemeral } = harness({ confirmation });
      await handler(signed(payload()));
      expect(queue).toHaveLength(0);
      expect(ephemeral).toEqual(["That confirmation is no longer pending, so nothing was run."]);
    }
  });

  it("queues a repeated click once", async () => {
    const { handler, queue, updates } = harness();
    await handler(signed(payload()));
    await handler(signed(payload()));
    expect(queue).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it("undoes the click and says so when it cannot be queued", async () => {
    const { handler, ephemeral, pendingCounts, released, updates } = harness({ failEnqueue: true });
    await handler(signed(payload()));
    expect(pendingCounts).toEqual([1, -1]);
    expect(released).toEqual([confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt)]);
    expect(ephemeral).toEqual(["I couldn't take that click. Press the button again, or reply `@AgentX yes`."]);
    expect(updates).toHaveLength(0);
  });

  it("hands other buttons to the handler that matches them, with what a modal needs, and answers an unknown one privately", async () => {
    const seen: SlackBlockAction[] = [];
    const details: SlackActionHandler = { matches: (id) => id === "agentx_details", handle: async (action) => { seen.push(action); } };
    const { handler, logs, ephemeral, queue } = harness({ extra: [details] });
    await handler(signed(payload({ actionId: "agentx_details", value: "turn-1" })));
    expect(seen).toEqual([{ actionId: "agentx_details", value: "turn-1", userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: text, responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", actionTs: "1695500001.000002" }]);
    expect(ephemeral).toEqual([]);
    // An old button after a rollback, or one from a later release: the clicker hears it, the thread does not.
    expect((await handler(signed(payload({ actionId: "something_else" })))).statusCode).toBe(200);
    expect(logs.at(-1)).toMatchObject({ event: "interaction.ignored", fields: { reason: "unknown_action" } });
    expect(ephemeral).toEqual([UNKNOWN_BUTTON_TEXT]);
    expect(queue).toHaveLength(0);
  });

  it("queues a click on a confirmation re-posted under the same ID (a redelivered request), rather than dropping it as the earlier click", async () => {
    // Task 6 derives the confirmation ID from the originating event, so a redelivered event posts the
    // same ID again with a later postedAt. The click event ID carries postedAt, so the earlier click's
    // EVENT# claim (kept 14 days), the queue's deduplication and the turn's idempotency keys never
    // swallow the new click.
    const claimed = new Set<string>();
    const queue: SlackRequestMessage[] = [];
    let current: PendingConfirmation = pending;
    const handler = createSlackInteractivityHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      now: () => nowSeconds * 1_000,
      handlers: [confirmationActionHandler({
        loadConfirmation: async () => current,
        claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
        releaseEvent: async () => undefined,
        changePending: async () => 1,
        enqueue: async (message) => { queue.push(message); },
        updateMessage: async () => undefined,
        respondEphemeral: async () => undefined,
        now: () => nowSeconds * 1_000,
      })],
    });
    await handler(signed(payload()));
    current = { ...pending, postedAt: new Date(nowSeconds * 1_000 - 30_000).toISOString() };
    await handler(signed(payload()));
    expect(queue.map((message) => message.eventId)).toEqual([
      confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt),
      confirmationClickEventId(pending.confirmationId, "approve", current.postedAt),
    ]);
    expect(new Set(queue.map((message) => message.eventId)).size).toBe(2);
  });

  it("releases the click and says so when the thread's pending count cannot be raised, so a second press is not a silent duplicate", async () => {
    const claimed = new Set<string>();
    const released: string[] = [];
    const ephemeral: string[] = [];
    const queue: SlackRequestMessage[] = [];
    let failPending = true;
    const handler = createSlackInteractivityHandler({
      secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
      now: () => nowSeconds * 1_000,
      handlers: [confirmationActionHandler({
        loadConfirmation: async () => pending,
        claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
        releaseEvent: async (eventId) => { released.push(eventId); claimed.delete(eventId); },
        changePending: async () => { if (failPending) throw new Error("DynamoDB down"); return 1; },
        enqueue: async (message) => { queue.push(message); },
        updateMessage: async () => undefined,
        respondEphemeral: async (_url, value) => { ephemeral.push(value); },
        now: () => nowSeconds * 1_000,
      })],
    });
    expect((await handler(signed(payload()))).statusCode).toBe(200);
    expect(released).toEqual([confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt)]);
    expect(ephemeral).toEqual(["I couldn't take that click. Press the button again, or reply `@AgentX yes`."]);
    failPending = false;
    await handler(signed(payload()));
    expect(queue).toHaveLength(1);
  });

  it("takes the clicking member only from Slack's signed payload, and ignores a click without a Slack response URL", async () => {
    const { handler, queue, logs } = harness();
    const forged = { ...payload(), response_url: "https://attacker.example/hook" };
    expect((await handler(signed(forged))).statusCode).toBe(200);
    expect(logs.at(-1)).toMatchObject({ event: "interaction.ignored", fields: { reason: "malformed_action" } });
    expect(queue).toHaveLength(0);
    // A body altered after signing (another user) fails the signature, before it is read.
    const good = signed(payload());
    const tampered = { ...good, body: good.body.replace(requester, other) };
    expect((await handler(tampered)).statusCode).toBe(401);
    expect(queue).toHaveLength(0);
  });
});

describe("Slack native workflow review controls", () => {
  const taskId = "44444444-4444-5444-8444-444444444444";
  const digest = "a".repeat(64);
  const workflow = submitWorkflowArtifact(createWorkflowSnapshot({
    taskId, ownerId: "b".repeat(64), now: new Date(nowSeconds * 1_000).toISOString(),
    checkPolicy: {
      required: [{ id: "required-1", label: "npm test", command: { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 120 } }],
      optional: [{ id: "coverage", label: "Coverage report", command: { cwd: "workspace", executable: "npm", args: ["run", "coverage"], timeoutSeconds: 120 } }], selectedOptionalIds: [],
    },
  }), { expectedRevision: 1, now: new Date(nowSeconds * 1_000).toISOString(), artifact: {
    id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "agentx-plan", objectKey: "private/owner/workspace/op/plan.md", createdAt: new Date(nowSeconds * 1_000).toISOString(),
  } });
  const task = { taskId, slackUserId: requester, share: thread, workflow };

  it("shows locked required checks and only project-approved optional checks, then submits the selected IDs with the exact plan revision", async () => {
    let opened: Record<string, unknown> | undefined;
    const submitted: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async (_trigger, view) => { opened = view; }, submit: async (input) => { submitted.push(input); } });
    await handlers.handleAction({ actionId: "agentx_workflow_approve", value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "APPROVE" }), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    expect(opened).toMatchObject({ callback_id: "agentx_workflow_review_submission" });
    const blocks = opened?.blocks as Array<Record<string, unknown>>;
    expect(JSON.stringify(blocks)).toContain("Always run these project checks:");
    expect(JSON.stringify(blocks)).toContain("Coverage report");
    expect(JSON.stringify(blocks)).not.toContain("required-1");
    await handlers.handleSubmission({ user: { id: requester }, view: {
      private_metadata: (opened?.private_metadata),
      state: { values: { workflow_checks: { selected_options: { selected_options: [{ value: "coverage" }, { value: "forged" }] } } } },
    } });
    await handlers.handleSubmission({ user: { id: requester }, view: {
      private_metadata: (opened?.private_metadata),
      state: { values: { workflow_checks: { selected_options: { selected_options: [{ value: "coverage" }, { value: "forged" }] } } } },
    } });
    expect(submitted[0]).toMatchObject({ taskId, userId: requester, thread, expectedRevision: workflow.revision, artifactDigest: digest, decision: "APPROVE", selectedOptionalCheckIds: ["coverage"] });
    expect(submitted[1]?.requestId).toBe(submitted[0]?.requestId);
  });

  it("keeps long plan text out of Slack modal metadata", async () => {
    let opened: Record<string, unknown> | undefined;
    const handlers = workflowSlackHandlers({ loadTask: async () => task,
      openView: async (_trigger, view) => { opened = view; }, submit: async () => undefined });
    await handlers.handleAction({ actionId: "agentx_workflow_approve",
      value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "APPROVE" }),
      userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002",
      messageText: `plan ${"x".repeat(3_200)}`, responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    const metadata = String(opened?.private_metadata);
    expect(metadata.length).toBeLessThan(3_000);
    expect(metadata).not.toContain("messageText");
    expect(metadata).not.toContain("plan ");
  });

  it("refuses another Slack member and refuses a stale plan button", async () => {
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async () => undefined, submit: async () => undefined });
    const action = { actionId: "agentx_workflow_approve", value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "APPROVE" }), userId: other, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" };
    await expect(handlers.handleAction(action)).rejects.toThrow();
    await expect(handlers.handleAction({ ...action, userId: requester, value: JSON.stringify({ taskId, revision: workflow.revision - 1, digest, decision: "APPROVE" }) })).rejects.toThrow();
  });

  it("retries only an unknown review for the exact current candidate and workflow revision", async () => {
    const now = new Date(nowSeconds * 1_000).toISOString();
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
    const blocked = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now }),
      revision: 7, stage: "REVIEW", state: "BLOCKED", candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }] },
      reviews: [{ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role: "SECURITY", provider: "test", version: "1", status: "UNKNOWN", failureReason: "INVALID_JSON", findings: [], readOnly: true, recordedAt: now }],
    });
    let loaded = { ...task, workflow: blocked };
    const retries: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async () => undefined, submit: async () => undefined,
      retryReviews: async (input) => { retries.push(input); } });
    const action = { actionId: "agentx_workflow_retry_reviews", value: JSON.stringify({ taskId, revision: blocked.revision, candidateDigest: candidate.digest }),
      userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "review", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" };
    await handlers.handleAction(action);
    expect(retries[0]).toMatchObject({ taskId, userId: requester, thread, expectedRevision: blocked.revision, candidateDigest: candidate.digest });
    await expect(handlers.handleAction({ ...action, value: JSON.stringify({ taskId, revision: blocked.revision - 1, candidateDigest: candidate.digest }) })).rejects.toThrow(/no longer current/);
    loaded = { ...loaded, workflow: { ...blocked, reviews: [{ ...blocked.reviews![0]!, status: "FINDINGS" }] } };
    await expect(handlers.handleAction(action)).rejects.toThrow(/no longer current/);
  });

  it("binds a Full path approval button to the current requirements artifact", async () => {
    const now = new Date(nowSeconds * 1_000).toISOString();
    const fullRequirementsDigest = "c".repeat(64);
    const fullWorkflow = submitWorkflowArtifact(createWorkflowSnapshot({
      taskId, ownerId: "b".repeat(64), now, path: "FULL",
    }), { expectedRevision: 1, now, artifact: {
      id: "requirements-1", type: "requirements", version: 1, sha256: fullRequirementsDigest,
      producer: "agentx-plan", objectKey: "private/owner/workspace/op/requirements.md", createdAt: now,
    } });
    const fullTask = { ...task, workflow: fullWorkflow };
    let opened: Record<string, unknown> | undefined;
    const handlers = workflowSlackHandlers({ loadTask: async () => fullTask, openView: async (_trigger, view) => { opened = view; }, submit: async () => undefined });
    const action = { actionId: "agentx_workflow_approve", value: JSON.stringify({ taskId, revision: fullWorkflow.revision, digest: fullRequirementsDigest, decision: "APPROVE" }), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "requirements", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" };
    await handlers.handleAction(action);
    expect(opened).toMatchObject({ callback_id: "agentx_workflow_review_submission" });
    const approvalBlocks = JSON.stringify(opened?.blocks);
    expect(approvalBlocks).toContain("Checks are chosen when you approve the coding plan.");
    expect(approvalBlocks).not.toContain("workflow_feedback");
    expect(approvalBlocks).not.toContain("What should change?");
    await expect(handlers.handleAction({ ...action, value: JSON.stringify({ taskId, revision: fullWorkflow.revision, digest, decision: "APPROVE" }) })).rejects.toThrow(/changed/);
  });

  it("asks for a comment only when the owner requests changes", async () => {
    let opened: Record<string, unknown> | undefined;
    const handlers = workflowSlackHandlers({ loadTask: async () => task,
      openView: async (_trigger, view) => { opened = view; }, submit: async () => undefined });
    await handlers.handleAction({ actionId: "agentx_workflow_changes",
      value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "REQUEST_CHANGES" }),
      userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan",
      responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    const changeBlocks = JSON.stringify(opened?.blocks);
    expect(changeBlocks).toContain("workflow_feedback");
    expect(changeBlocks).toContain("What should change?");
  });

  it("lets only the owner approve the current PR feedback and candidate in the same task thread", async () => {
    const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "1".repeat(40) }]);
    const now = new Date(nowSeconds * 1_000).toISOString();
    const waiting = WorkflowSnapshotSchema.parse({
      ...workflow, revision: workflow.revision + 1, stage: "WAIT_FOR_MERGE", state: "WAITING", candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "ci", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
      reviews: [
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: "CRITIC", provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
        { operationId: "11111111-1111-4111-8111-111111111111", candidateDigest: candidate.digest, role: "SECURITY", provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now },
      ],
      pullRequests: [{ repositoryId: "payments", number: 11, url: "https://github.com/acme/payments/pull/11", candidateDigest: candidate.digest, required: true, state: "OPEN", observedAt: now }],
    });
    const withFeedback = requestWorkflowFeedback(waiting, {
      feedbackId: "f".repeat(64), repositoryId: "payments", number: 11, candidateDigest: candidate.digest,
      comments: [{ id: "4321", url: "https://github.com/acme/payments/pull/11#discussion_r4321", author: "reviewer", body: "Handle the edge case" }],
      proposedPlan: "Review the comment in context and address it.",
    }, now);
    const submitted: Array<Record<string, unknown>> = [];
    const feedbackTask = { ...task, workflow: withFeedback };
    const handlers = workflowSlackHandlers({ loadTask: async () => feedbackTask, openView: async () => undefined, submit: async () => undefined, submitFeedback: async (input) => { submitted.push(input); } });
    const action = {
      actionId: "agentx_github_feedback_approve",
      value: JSON.stringify({ taskId, revision: withFeedback.revision, feedbackId: "f".repeat(64), candidateDigest: candidate.digest, decision: "APPROVE" }),
      userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "feedback", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "",
    };
    await handlers.handleAction(action);
    expect(submitted[0]).toMatchObject({ taskId, userId: requester, thread, expectedRevision: withFeedback.revision, feedbackId: "f".repeat(64), candidateDigest: candidate.digest, decision: "APPROVE" });
    await expect(handlers.handleAction({ ...action, userId: other })).rejects.toThrow(/Only/);
    await expect(handlers.handleAction({ ...action, value: JSON.stringify({ taskId, revision: withFeedback.revision - 1, feedbackId: "f".repeat(64), candidateDigest: candidate.digest, decision: "APPROVE" }) })).rejects.toThrow(/changed/);
  });
});

function feedbackReviewWorkflow(taskId: string) {
  const now = new Date(nowSeconds * 1_000).toISOString();
  const candidate = createCandidateManifest([{ repositoryId: "payments", commitSha: "a".repeat(40), treeSha: "b".repeat(40) }]);
  const comment = { id: "comment-1", kind: "DISCUSSION" as const, url: "https://github.com/acme/payments/pull/11#issuecomment-1",
    author: "reviewer", updatedAt: now, bodyDigest: createHash("sha256").update("private comment").digest("hex"), bodyBytes: 15 };
  const bundleDigest = "c".repeat(64);
  const bundleRef = { schemaVersion: 1 as const, taskId, repositoryId: "payments", number: 11, headSha: "a".repeat(40),
    candidateDigest: candidate.digest, commentSetDigest: "d".repeat(64), producer: "agentx-github-reconciler", version: "1", recordedAt: now,
    comments: [comment], sha256: bundleDigest, objectKey: `private/owner/workspace/feedback/${bundleDigest}.json` };
  const reviewDigest = "e".repeat(64);
  const proposalDigest = "f".repeat(64);
  const findingRef = { id: "finding-1", bundleDigest, commentIds: [comment.id], priority: "MUST_FIX" as const,
    assessment: "ACTIONABLE" as const, recommended: true };
  const reviewRef = { schemaVersion: 1 as const, taskId, workflowRevision: 4, operationMode: "FEEDBACK_REVIEW" as const,
    qualification: "AI_GENERATED_ADVISORY" as const, sha256: reviewDigest, objectKey: `private/owner/workspace/reviews/${reviewDigest}.json`,
    proposalDigest, taskRequirementsDigest: "1".repeat(64), candidateBindings: [{ repositoryId: "payments", number: 11, headSha: "a".repeat(40),
      candidateDigest: candidate.digest, commentSetDigest: bundleRef.commentSetDigest, bundleDigest }], operationId: "11111111-1111-4111-8111-111111111111",
    provider: "scripted", version: "1", status: "COMPLETE" as const, bundleDigests: [bundleDigest], findingRefs: [findingRef], recordedAt: now };
  const workflow = WorkflowSnapshotSchema.parse({
    ...createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now }), revision: 4, stage: "WAIT_FOR_MERGE", state: "WAITING", candidate,
    verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: now, results: [{ checkId: "unit", status: "PASS" }] },
    reviews: ["CRITIC", "SECURITY"].map(role => ({ operationId: "22222222-2222-4222-8222-222222222222", candidateDigest: candidate.digest,
      role, provider: "scripted", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
    pullRequests: [{ repositoryId: "payments", number: 11, url: "https://github.com/acme/payments/pull/11", candidateDigest: candidate.digest, required: true, state: "OPEN" }],
    feedbackReview: { status: "PENDING", bundleRefs: [bundleRef], reviewRef },
  });
  return { workflow, reviewDigest, proposalDigest, bundleDigests: [bundleDigest] };
}

const RETRY_NOTICE = "I couldn't take that click. Press the button again, or reply `@AgentX yes`.";
const PROCESS_NOTICE = "I couldn't process that click. Press the button again, or reply `@AgentX yes`.";

describe("Slack PR feedback review actions", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const review = feedbackReviewWorkflow(taskId);
  const task = { slackUserId: requester, share: thread, workflow: review.workflow };
  const bundleSetDigest = createHash("sha256").update(JSON.stringify(review.bundleDigests), "utf8").digest("hex");
  const value = JSON.stringify({ taskId, expectedRevision: 4, reviewDigest: review.reviewDigest,
    proposalDigest: review.proposalDigest, bundleSetDigest, selection: "RECOMMENDED" });
  const action: SlackBlockAction = { actionId: "agentx_feedback_review_recommended", value, userId: requester,
    userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
    requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "Review ready",
    responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", actionTs: "1695500002.000003" };

  it("routes the exact recommended selection to the task decision callback without trusting Slack finding IDs", async () => {
    const submitted: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async () => undefined,
      submit: async () => undefined, submitFeedback: async input => { submitted.push(input); } });
    await handlers.handleAction(action);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ taskId, userId: requester, thread, expectedRevision: 4,
      reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest, bundleDigests: review.bundleDigests,
      selection: "RECOMMENDED", decision: "APPROVE" });
    expect(submitted[0]?.requestId).toEqual(expect.any(String));
    expect(submitted[0]).not.toHaveProperty("findingIds");
  });

  it("rejects wrong owners, other threads, and stale review digests", async () => {
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async () => undefined,
      submit: async () => undefined, submitFeedback: async () => undefined });
    await expect(handlers.handleAction({ ...action, userId: other })).rejects.toThrow(/Only/);
    await expect(handlers.handleAction({ ...action, thread: { ...thread, channelId: "C9999999999" } })).rejects.toThrow(/another Slack/);
    await expect(handlers.handleAction({ ...action, value: JSON.stringify({ taskId, expectedRevision: 4,
      reviewDigest: "9".repeat(64), proposalDigest: review.proposalDigest, bundleSetDigest, selection: "RECOMMENDED" }) })).rejects.toThrow(/changed/);
  });

  it("opens Request changes and submits the owner's short note as a non-dispatching decision", async () => {
    let opened: Record<string, unknown> | undefined;
    const submitted: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => task,
      openView: async (_trigger, view) => { opened = view; }, submit: async () => undefined,
      submitFeedback: async input => { submitted.push(input); } });
    await handlers.handleAction({ ...action, actionId: "agentx_feedback_review_changes" });
    expect(opened).toMatchObject({ callback_id: "agentx_feedback_review_changes_submission" });
    const modal = opened as Record<string, unknown>;
    const metadata = JSON.parse(String(modal.private_metadata)) as Record<string, unknown>;
    await handlers.handleSubmission({ team: { id: thread.teamId }, user: { id: requester, team_id: thread.teamId }, view: { callback_id: modal.callback_id,
      private_metadata: modal.private_metadata, state: { values: { feedback_note: { reason: { value: "Please reconsider the edge case." } } } } } });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ taskId, userId: requester, thread, expectedRevision: 4,
      reviewDigest: review.reviewDigest, proposalDigest: review.proposalDigest, bundleDigests: review.bundleDigests,
      selection: "RECOMMENDED", decision: "REQUEST_CHANGES", ownerNote: "Please reconsider the edge case.", requestId: metadata.requestId });
  });

  it("rejects missing, mismatched, or Slack Connect modal workspace identities", async () => {
    let opened: Record<string, unknown> | undefined;
    const submitted: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => task,
      openView: async (_trigger, view) => { opened = view; }, submit: async () => undefined,
      submitFeedback: async input => { submitted.push(input); } });
    await handlers.handleAction({ ...action, actionId: "agentx_feedback_review_changes" });
    const modal = opened as Record<string, unknown>;
    const submit = (identity: { team?: unknown; user?: unknown }) => handlers.handleSubmission({ ...identity, view: {
      callback_id: modal.callback_id, private_metadata: modal.private_metadata,
      state: { values: { feedback_note: { reason: { value: "Please reconsider this." } } } },
    } });
    await expect(submit({ user: { id: requester, team_id: thread.teamId } })).rejects.toThrow(/workspace/);
    await expect(submit({ team: { id: thread.teamId }, user: { id: requester } })).rejects.toThrow(/workspace/);
    await expect(submit({ team: { id: "T9999999999" }, user: { id: requester, team_id: thread.teamId } })).rejects.toThrow(/workspace/);
    await expect(submit({ team: { id: thread.teamId }, user: { id: requester, team_id: "T9999999999" } })).rejects.toThrow(/workspace/);
    expect(submitted).toHaveLength(0);
  });
});

/** A handler whose confirmation dependencies can each be replaced, recording what it did. */
function custom(overrides: Partial<ConfirmationClickDependencies> = {}) {
  const claimed = new Set<string>();
  const released: string[] = [];
  const ephemeral: string[] = [];
  const queue: SlackRequestMessage[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const log = (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields }); };
  const handler = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    now: () => nowSeconds * 1_000,
    log,
    respondEphemeral: async (_url, value) => { ephemeral.push(value); },
    handlers: [confirmationActionHandler({
      loadConfirmation: async () => pending,
      claimEvent: async (eventId) => { if (claimed.has(eventId)) return false; claimed.add(eventId); return true; },
      releaseEvent: async (eventId) => { released.push(eventId); claimed.delete(eventId); },
      changePending: async () => 1,
      enqueue: async (message) => { queue.push(message); },
      updateMessage: async () => undefined,
      respondEphemeral: async (_url, value) => { ephemeral.push(value); },
      now: () => nowSeconds * 1_000,
      log,
      ...overrides,
    })],
  });
  return { handler, claimed, released, ephemeral, queue, logs, events: () => logs.map((entry) => entry.event) };
}

describe("Slack interactivity never loses a click silently (spec 014 D2, review fix round 1)", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const eventId = confirmationClickEventId(pending.confirmationId, "approve", pending.postedAt);

  it("still releases the claim and tells the member when the queue send fails and undoing the pending count fails too", async () => {
    const h = custom({
      enqueue: async () => { throw new Error("SQS down"); },
      changePending: async (_subject, delta) => { if (delta === -1) throw new Error("DynamoDB down"); return 1; },
    });
    expect((await h.handler(signed(payload()))).statusCode).toBe(200);
    expect(h.released).toEqual([eventId]);
    expect(h.claimed.size).toBe(0);
    expect(h.ephemeral).toEqual([RETRY_NOTICE]);
    expect(h.events()).toEqual(expect.arrayContaining(["interaction.decrement_failed", "interaction.enqueue_failed"]));
    expect(h.events()).not.toContain("interaction.failed");
  });

  it("still tells the member when releasing the claim fails, and logs it", async () => {
    const h = custom({
      enqueue: async () => { throw new Error("SQS down"); },
      releaseEvent: async () => { throw new Error("DynamoDB down"); },
    });
    await h.handler(signed(payload()));
    expect(h.ephemeral).toEqual([RETRY_NOTICE]);
    expect(h.events()).toEqual(expect.arrayContaining(["interaction.release_failed", "interaction.enqueue_failed"]));
  });

  it("logs, and does not throw, when the retry notice itself cannot be sent", async () => {
    const h = custom({
      enqueue: async () => { throw new Error("SQS down"); },
      respondEphemeral: async () => { throw new Error("Slack down"); },
    });
    expect((await h.handler(signed(payload()))).statusCode).toBe(200);
    expect(h.released).toEqual([eventId]);
    expect(h.events()).toContain("interaction.respond_failed");
    expect(h.events()).not.toContain("interaction.failed");
  });

  it("tells the member privately when a click fails before it is claimed (the confirmation cannot be read, or the claim throws)", async () => {
    for (const overrides of [
      { loadConfirmation: async () => { throw new Error("DynamoDB down"); } },
      { claimEvent: async () => { throw new Error("DynamoDB down"); } },
    ] satisfies Array<Partial<ConfirmationClickDependencies>>) {
      const h = custom(overrides);
      expect((await h.handler(signed(payload()))).statusCode).toBe(200);
      expect(h.ephemeral).toEqual([PROCESS_NOTICE]);
      expect(h.queue).toHaveLength(0);
      expect(h.logs.find((entry) => entry.event === "interaction.failed")).toMatchObject({ fields: { actionId: "agentx_confirm_approve" } });
    }
  });

  it("tells the member it already has a repeated click", async () => {
    const h = custom();
    await h.handler(signed(payload()));
    await h.handler(signed(payload()));
    expect(h.queue).toHaveLength(1);
    expect(h.ephemeral).toEqual(["Already received. I'm on it."]);
  });

  it("refuses a response URL that is not https://hooks.slack.com", async () => {
    for (const responseUrl of ["not a url", "http://hooks.slack.com/actions/T/1/abc", "https://hooks.slack.com.evil.example/actions", "https://evil.example/https://hooks.slack.com/"]) {
      const h = custom();
      await h.handler(signed({ ...payload(), response_url: responseUrl }));
      expect(h.logs.at(-1)).toMatchObject({ event: "interaction.ignored", fields: { reason: "malformed_action" } });
      expect(h.queue).toHaveLength(0);
    }
  });

  /** AbortSignal.timeout runs on Node's internal timers, which fake timers do not reach; this one uses setTimeout. */
  function fakeTimeoutSignals() {
    vi.useFakeTimers();
    return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), milliseconds);
      return controller.signal;
    });
  }

  function hungFetch(seen: RequestInit[]): typeof fetch {
    return ((_url: string, init: RequestInit) => {
      seen.push(init);
      return new Promise((_resolve, reject) => { init.signal?.addEventListener("abort", () => { reject(init.signal?.reason as Error); }); });
    }) as unknown as typeof fetch;
  }

  it("gives up on a hung response_url after 2 seconds, refusing redirects", async () => {
    const timeout = fakeTimeoutSignals();
    const seen: RequestInit[] = [];
    const answer = respondEphemeral("https://hooks.slack.com/actions/T/1/abc", "hi", hungFetch(seen));
    const settled = expect(answer).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(seen[0]).toMatchObject({ redirect: "error" });
  });

  it("gives up on a hung Slack API call after 2 seconds, and the click is still queued", async () => {
    const timeout = fakeTimeoutSignals();
    const seen: RequestInit[] = [];
    const h = custom({ updateMessage: (input) => slackApi("xoxb-test", "chat.update", input, hungFetch(seen)) });
    const response = h.handler(signed(payload()));
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await response).statusCode).toBe(200);
    expect(h.queue).toHaveLength(1);
    expect(h.events()).toContain("interaction.update_failed");
    expect(timeout).toHaveBeenCalledWith(2_000);
    expect(seen[0]).toMatchObject({ redirect: "error" });
  });
});
