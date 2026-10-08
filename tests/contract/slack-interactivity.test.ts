// tests/contract/slack-interactivity.test.ts
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIRMATION_TTL_MS,
  createWorkflowSnapshot,
  createCandidateManifest,
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
  WORKFLOW_ACTION_IDS,
  confirmationActionHandler,
  createSlackInteractivityHandler,
  respondEphemeral,
  slackApi,
  type ConfirmationClickDependencies,
  type SlackActionHandler,
  type SlackBlockAction,
  answeredWorkflowCard,
  invokeWorkflowDecision,
  workflowCheckControls,
  workflowSlackHandlers,
} from "../../packages/broker/src/aws/slack-interactivity.js";
import { SlackWorkflowStartError, workflowChoiceRefusal } from "../../packages/broker/src/aws/slack-workflow-choice.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

// Every workflow modal a test opens is checked against Slack's limits.
const strict = new StrictSlackWeb();
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

function harness(options: { confirmation?: PendingConfirmation | undefined; failEnqueue?: boolean; extra?: SlackActionHandler[]; pendingAfter?: number; workflow?: { handleAction: (action: SlackBlockAction) => Promise<void>; handleSubmission: (payload: Record<string, unknown>) => Promise<void> } } = {}) {
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
    ...(options.workflow === undefined ? {} : { workflow: options.workflow }),
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

  it("answers a removed legacy PR-feedback button as unavailable", async () => {
    const workflow = { handleAction: vi.fn(async () => undefined), handleSubmission: vi.fn(async () => undefined) };
    const { handler, ephemeral, logs } = harness({ workflow });
    expect((await handler(signed(payload({ actionId: "agentx_github_feedback_approve" })))).statusCode).toBe(200);
    expect(ephemeral).toEqual([UNKNOWN_BUTTON_TEXT]);
    expect(workflow.handleAction).not.toHaveBeenCalled();
    expect(logs.at(-1)).toMatchObject({ event: "interaction.ignored", fields: { reason: "unknown_action" } });
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
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async (input) => { submitted.push(input); } });
    await handlers.handleAction({ actionId: "agentx_workflow_approve", value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "APPROVE" }), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    expect(opened).toMatchObject({ callback_id: "agentx_workflow_review_submission" });
    const blocks = opened?.blocks as Array<Record<string, unknown>>;
    expect(JSON.stringify(blocks)).toContain("Always run these project checks:");
    expect(JSON.stringify(blocks)).toContain("Coverage report");
    expect(JSON.stringify(blocks)).not.toContain("required-1");
    await handlers.handleSubmission({ user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, view: {
      private_metadata: (opened?.private_metadata),
      state: { values: { workflow_checks: { selected_options: { selected_options: [{ value: "coverage" }, { value: "forged" }] } } } },
    } });
    await handlers.handleSubmission({ user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, view: {
      private_metadata: (opened?.private_metadata),
      state: { values: { workflow_checks: { selected_options: { selected_options: [{ value: "coverage" }, { value: "forged" }] } } } },
    } });
    expect(submitted[0]).toMatchObject({ taskId, userId: requester, thread, expectedRevision: workflow.revision, artifactDigest: digest, decision: "APPROVE", selectedOptionalCheckIds: ["coverage"] });
    expect(submitted[1]?.requestId).toBe(submitted[0]?.requestId);
  });

  it("submits optional checks in one canonical order so a reordered resubmission is the same decision", async () => {
    const now = new Date(nowSeconds * 1_000).toISOString();
    const twoOptional = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now, checkPolicy: {
      required: [], optional: ["lint", "coverage"].map((id) => ({ id, label: id, command: { cwd: "workspace", executable: "npm", args: ["run", id], timeoutSeconds: 60 } })), selectedOptionalIds: [] } }),
      { expectedRevision: 1, now, artifact: { id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "agentx-plan", objectKey: "private/o/w/op/plan.md", createdAt: now } });
    let opened: Record<string, unknown> | undefined;
    const submitted: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: twoOptional }), openView: async (_t, view) => { opened = view; }, submit: async (input) => { submitted.push(input); } });
    await handlers.handleAction({ actionId: "agentx_workflow_approve", value: JSON.stringify({ taskId, revision: twoOptional.revision, digest, decision: "APPROVE" }), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    const submit = (order: string[]) => handlers.handleSubmission({ user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, view: { private_metadata: opened?.private_metadata, state: { values: { workflow_checks: { selected_options: { selected_options: order.map((value) => ({ value })) } } } } } });
    await submit(["lint", "coverage"]);
    await submit(["coverage", "lint"]);
    expect(submitted[0]?.selectedOptionalCheckIds).toEqual(["coverage", "lint"]);
    expect(submitted[1]).toEqual(submitted[0]);
  });

  it("retries verification with optional checks in one canonical order so a reordered resubmission replays", async () => {
    const now = new Date(nowSeconds * 1_000).toISOString();
    const planned = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now, checkPolicy: {
      required: [], optional: ["lint", "coverage"].map((id) => ({ id, label: id, command: { cwd: "workspace", executable: "npm", args: ["run", id], timeoutSeconds: 60 } })), selectedOptionalIds: [] } }),
      { expectedRevision: 1, now, artifact: { id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "agentx-plan", objectKey: "private/o/w/op/plan.md", createdAt: now } });
    const blocked = { ...planned, stage: "VERIFY", state: "BLOCKED", blockedReason: "No checks ran." };
    let opened: Record<string, unknown> | undefined;
    const retried: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: blocked }), openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined, retryChecks: async (input) => { retried.push(input); } });
    await handlers.handleAction({ actionId: "agentx_workflow_retry_checks", value: JSON.stringify({ taskId, revision: blocked.revision }), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "blocked", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    expect(opened).toMatchObject({ callback_id: "agentx_workflow_checks_retry_submission" });
    const submit = (order: string[]) => handlers.handleSubmission({ user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, view: { callback_id: "agentx_workflow_checks_retry_submission", private_metadata: opened?.private_metadata, state: { values: { workflow_checks: { selected_options: { selected_options: order.map((value) => ({ value })) } } } } } });
    await submit(["lint", "coverage"]);
    await submit(["coverage", "lint"]);
    expect(retried[0]?.selectedOptionalCheckIds).toEqual(["coverage", "lint"]);
    expect(retried[1]).toEqual(retried[0]);
  });

  it("keeps long plan text out of Slack modal metadata", async () => {
    let opened: Record<string, unknown> | undefined;
    const handlers = workflowSlackHandlers({ loadTask: async () => task,
      openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined });
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

  it("retries a blocked review only for the exact current candidate and workflow revision, findings included", async () => {
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
    // Task 16: reviews that found problems may be retried too, on the same checked code.
    loaded = { ...loaded, workflow: { ...blocked, reviews: [{ ...blocked.reviews![0]!, status: "FINDINGS", findings: [{ text: "x", origin: "INTRODUCED" }] }] } };
    await handlers.handleAction(action);
    expect(retries).toHaveLength(2);
    loaded = { ...loaded, workflow: { ...blocked, verification: { ...blocked.verification!, results: [{ checkId: "required-1", status: "FAILED" }] } } };
    await expect(handlers.handleAction(action)).rejects.toThrow(/no longer current/);
  });

  it("retries opening the pull request only for the owner, in the task's thread, at the current revision", async () => {
    const now = new Date(nowSeconds * 1_000).toISOString();
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
    const ready = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now }),
      revision: 9, stage: "PULL_REQUEST", state: "READY", candidate,
      verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" }] },
      reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: now })),
    });
    let loaded = { ...task, workflow: ready };
    const retries: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async () => undefined, submit: async () => undefined,
      retryPublication: async (input) => { retries.push(input); } });
    const action = { actionId: "agentx_workflow_retry_publish", value: JSON.stringify({ taskId, revision: ready.revision }),
      userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "retry", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" };
    await handlers.handleAction(action);
    expect(retries).toEqual([expect.objectContaining({ taskId, userId: requester, thread, expectedRevision: ready.revision })]);
    await expect(handlers.handleAction({ ...action, userId: other })).rejects.toThrow(/Only the task owner/);
    await expect(handlers.handleAction({ ...action, thread: { ...thread, threadTs: "1695500009.000009" } })).rejects.toThrow(/another Slack thread/);
    await expect(handlers.handleAction({ ...action, value: JSON.stringify({ taskId, revision: ready.revision - 1 }) })).rejects.toThrow(/no longer current/);
    loaded = { ...loaded, workflow: { ...ready, stage: "WAIT_FOR_MERGE", state: "WAITING" } as never };
    await expect(handlers.handleAction(action)).rejects.toThrow(/no longer current/);
    expect(retries).toHaveLength(1);
  });

  describe("exits for blocked work (Task 16)", () => {
    const now = new Date(nowSeconds * 1_000).toISOString();
    const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
    const verification = { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: now, results: [{ checkId: "required-1", status: "PASS" as const }] };
    const review = (role: "CRITIC" | "SECURITY", status: "PASS" | "FINDINGS", findings: unknown[]) => ({ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role, provider: "test", version: "1", status, findings, readOnly: true, recordedAt: now });
    const reviewBlocked = WorkflowSnapshotSchema.parse({ ...workflow, revision: 12, stage: "REVIEW", state: "BLOCKED", blockReason: "the critic review did not pass", candidate, verification,
      reviews: [review("CRITIC", "FINDINGS", [{ text: "The new parser drops the last line.", origin: "INTRODUCED" }]), review("SECURITY", "PASS", [])] });
    const press = (actionId: string, value: Record<string, unknown>, userId = requester): SlackBlockAction => ({ actionId, value: JSON.stringify(value),
      userId, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "blocked", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", actionTs: "1695500001.000009" });

    it("asks the owner to confirm Close task in a modal that says unpublished work is discarded, then hands it to the broker", async () => {
      const closes: Array<Record<string, unknown>> = [];
      let opened: Record<string, unknown> | undefined;
      const blockedTask = { ...task, workflow: { ...workflow, stage: "REVIEW", state: "BLOCKED" } };
      const handlers = workflowSlackHandlers({ loadTask: async () => blockedTask, openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined, close: async (input) => { closes.push(input); } });
      await handlers.handleAction(press("agentx_workflow_close", { taskId, revision: workflow.revision }));
      expect(opened).toMatchObject({ callback_id: "agentx_workflow_close_submission", title: { text: "Close this task" }, submit: { text: "Close task" } });
      expect(JSON.stringify(opened?.blocks)).toContain("discard");
      await handlers.handleSubmission({ user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, view: { callback_id: "agentx_workflow_close_submission", private_metadata: opened?.private_metadata, state: { values: {} } } });
      expect(closes).toEqual([expect.objectContaining({ taskId, userId: requester, thread, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown })]);
      // Another member can neither open the confirmation nor submit one opened by the owner.
      await expect(handlers.handleAction(press("agentx_workflow_close", { taskId, revision: workflow.revision }, other))).rejects.toThrow(/Only/);
      await expect(handlers.handleSubmission({ user: { id: other, team_id: thread.teamId }, team: { id: thread.teamId }, view: { callback_id: "agentx_workflow_close_submission", private_metadata: opened?.private_metadata, state: { values: {} } } })).rejects.toThrow(/Only/);
      expect(closes).toHaveLength(1);
    });

    it("routes Send back to coding for blocked reviews and failed checks to the broker with the exact revision", async () => {
      let loaded: Record<string, unknown> = { ...task, workflow: reviewBlocked };
      const sent: Array<Record<string, unknown>> = [];
      const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async () => undefined, submit: async () => undefined, sendBack: async (input) => { sent.push(input); } });
      await handlers.handleAction(press("agentx_workflow_send_back", { taskId, revision: reviewBlocked.revision }));
      expect(sent).toEqual([{ taskId, userId: requester, thread, expectedRevision: reviewBlocked.revision, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown }]);
      await expect(handlers.handleAction(press("agentx_workflow_send_back", { taskId, revision: reviewBlocked.revision - 1 }))).rejects.toThrow(/no longer current/);
      await expect(handlers.handleAction(press("agentx_workflow_send_back", { taskId, revision: reviewBlocked.revision }, other))).rejects.toThrow(/Only/);
      // Failed checks are sent back the same way; reviews with only pre-existing notes are not a reason to.
      const checksFailed = WorkflowSnapshotSchema.parse({ ...reviewBlocked, stage: "VERIFY", reviews: [], verification: { ...verification, results: [{ checkId: "required-1", status: "FAILED" }] } });
      loaded = { ...task, workflow: checksFailed };
      await handlers.handleAction(press("agentx_workflow_send_back", { taskId, revision: checksFailed.revision }));
      expect(sent).toHaveLength(2);
      loaded = { ...task, workflow: { ...reviewBlocked, reviews: [review("CRITIC", "PASS", [{ text: "old", origin: "PRE_EXISTING" }])] } };
      await expect(handlers.handleAction(press("agentx_workflow_send_back", { taskId, revision: reviewBlocked.revision }))).rejects.toThrow(/no longer current/);
      expect(sent).toHaveLength(2);
    });

    it("retries blocked planning and blocked coding for the owner at the exact revision", async () => {
      let loaded: Record<string, unknown> = { ...task, workflow: { ...workflow, revision: 4, stage: "PLAN", state: "BLOCKED", blockReason: "planning operation ended failed" } };
      const plans: Array<Record<string, unknown>> = [];
      const codings: Array<Record<string, unknown>> = [];
      const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async () => undefined, submit: async () => undefined,
        retryPlan: async (input) => { plans.push(input); }, retryImplementation: async (input) => { codings.push(input); } });
      await handlers.handleAction(press("agentx_workflow_retry_plan", { taskId, revision: 4 }));
      expect(plans).toEqual([expect.objectContaining({ taskId, userId: requester, thread, expectedRevision: 4, step: "plan" })]);
      await expect(handlers.handleAction(press("agentx_workflow_retry_implementation", { taskId, revision: 4 }))).rejects.toThrow(/no longer current/);
      loaded = { ...task, workflow: { ...workflow, revision: 6, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" } };
      await handlers.handleAction(press("agentx_workflow_retry_implementation", { taskId, revision: 6 }));
      expect(codings).toEqual([expect.objectContaining({ taskId, userId: requester, thread, expectedRevision: 6, step: "coding" })]);
      await expect(handlers.handleAction(press("agentx_workflow_retry_implementation", { taskId, revision: 6 }, other))).rejects.toThrow(/Only/);
      await expect(handlers.handleAction(press("agentx_workflow_retry_plan", { taskId, revision: 6 }))).rejects.toThrow(/no longer current/);
    });

    it("offers Run checks again on a ready change whose code changed, through the same check choice", async () => {
      const ready = WorkflowSnapshotSchema.parse({ ...reviewBlocked, stage: "PULL_REQUEST", state: "READY", blockReason: undefined, reviews: [review("CRITIC", "PASS", []), review("SECURITY", "PASS", [])] });
      let opened: Record<string, unknown> | undefined;
      const retries: Array<Record<string, unknown>> = [];
      const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: ready }), openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined,
        retryChecks: async (input) => { retries.push(input); } });
      await handlers.handleAction(press("agentx_workflow_retry_checks", { taskId, revision: ready.revision }));
      expect(opened).toMatchObject({ callback_id: "agentx_workflow_checks_retry_submission" });
      await handlers.handleSubmission({ user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, view: { callback_id: "agentx_workflow_checks_retry_submission", private_metadata: opened?.private_metadata, state: { values: {} } } });
      expect(retries).toEqual([expect.objectContaining({ taskId, expectedRevision: ready.revision, selectedOptionalCheckIds: [] })]);
    });

    it("answers a refused Close task submission by replacing the modal with its reason, mentions rendered, through the signed endpoint", async () => {
      const closes: Array<Record<string, unknown>> = [];
      let opened: Record<string, unknown> | undefined;
      const workflowHandlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: reviewBlocked }), openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; },
        submit: async () => undefined, close: async (input) => { closes.push(input); } });
      const { handler, ephemeral } = harness({ workflow: workflowHandlers });
      const click = (user: string) => ({ type: "block_actions", user: { id: user, team_id: thread.teamId }, team: { id: thread.teamId },
        container: { channel_id: thread.channelId, message_ts: "1695500001.000002", thread_ts: thread.threadTs }, message: { ts: "1695500001.000002", thread_ts: thread.threadTs, text: "blocked" },
        response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", trigger_id: "1.2.3", actions: [{ action_id: "agentx_workflow_close", value: JSON.stringify({ taskId, revision: reviewBlocked.revision }), action_ts: "1695500001.000009" }] });
      expect((await handler(signed(click(other)))).statusCode).toBe(200);
      expect(ephemeral.at(-1)).toBe(`Only <@${requester}> can close this task.`);
      expect((await handler(signed(click(requester)))).statusCode).toBe(200);
      expect(opened).toMatchObject({ callback_id: "agentx_workflow_close_submission" });
      const submission = (user: string) => ({ type: "view_submission", user: { id: user, team_id: thread.teamId }, team: { id: thread.teamId },
        view: { callback_id: "agentx_workflow_close_submission", private_metadata: opened?.private_metadata, state: { values: {} } } });
      const refused = await handler(signed(submission(other)));
      const answer = JSON.parse(refused.body) as { response_action: string; view: Record<string, unknown> };
      expect(answer.response_action).toBe("update");
      expect(answer.view.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: `Only <@${requester}> can close this task.` } }]);
      await strict.openView("1.2.3", answer.view);
      expect(closes).toEqual([]);
      expect(JSON.parse((await handler(signed(submission(requester)))).body)).toEqual({ response_action: "clear" });
      expect(closes).toEqual([expect.objectContaining({ taskId, userId: requester })]);
    });

    it("routes every new exit button to the workflow handlers and names them all in WORKFLOW_ACTION_IDS", () => {
      for (const id of ["agentx_workflow_send_back", "agentx_workflow_retry_plan", "agentx_workflow_retry_implementation", "agentx_workflow_retry_publish", "agentx_workflow_close"]) {
        expect(WORKFLOW_ACTION_IDS.has(id), id).toBe(true);
      }
    });
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
    const handlers = workflowSlackHandlers({ loadTask: async () => fullTask, openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined });
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
      openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined });
    await handlers.handleAction({ actionId: "agentx_workflow_changes",
      value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "REQUEST_CHANGES" }),
      userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "",
      requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan",
      responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
    const changeBlocks = JSON.stringify(opened?.blocks);
    expect(changeBlocks).toContain("workflow_feedback");
    expect(changeBlocks).toContain("What should change?");
  });

  describe("Slack interaction hardening (Task 19)", () => {
    const approve = (revision: number, overrides: Partial<SlackBlockAction> = {}): SlackBlockAction => ({ actionId: "agentx_workflow_approve",
      value: JSON.stringify({ taskId, revision, digest, decision: "APPROVE" }), userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId,
      enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002", messageText: "plan",
      responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", ...overrides });
    const submission = (privateMetadata: unknown, values: Record<string, unknown> = {}, user = requester, team = thread.teamId) => ({
      user: { id: user, team_id: team }, team: { id: team }, view: { private_metadata: privateMetadata, state: { values } } });

    it("offers more than ten optional checks in a multi-select with Slack-safe labels and a capped required list", async () => {
      const command = { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 60 };
      const required = Array.from({ length: 64 }, (_, index) => ({ id: `required-${index + 1}`, label: `npm run check-${index} ${"y".repeat(70)}`.slice(0, 80), command }));
      const optional = Array.from({ length: 20 }, (_, index) => ({ id: `extra-${index}`, label: `Optional check ${index} ${"x".repeat(70)}`.slice(0, 80), command }));
      const at = new Date(nowSeconds * 1_000).toISOString();
      const big = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now: at, checkPolicy: { required, optional, selectedOptionalIds: [] } }),
        { expectedRevision: 1, now: at, artifact: { id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: at } });
      let opened: Record<string, unknown> | undefined;
      const submitted: Array<Record<string, unknown>> = [];
      const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: big }), openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async (input) => { submitted.push(input); } });
      await handlers.handleAction(approve(big.revision));
      const blocks = opened?.blocks as Array<Record<string, unknown>>;
      const input = blocks.find((block) => block.block_id === "workflow_checks") as { element: { type: string; options: Array<{ text: { text: string } }> } };
      expect(input.element.type).toBe("multi_static_select");
      expect(input.element.options).toHaveLength(20);
      expect(input.element.options.every((option) => option.text.text.length <= 75)).toBe(true);
      expect(input.element.options[0]!.text.text.endsWith("…")).toBe(true);
      expect(JSON.stringify(blocks)).toContain("and 44 more required checks");
      expect(blocks.every((block) => (block as { text?: { text: string } }).text === undefined || (block as { text: { text: string } }).text.text.length <= 3_000)).toBe(true);
      await handlers.handleSubmission(submission(opened?.private_metadata, { workflow_checks: { selected_options: { type: "multi_static_select", selected_options: [{ value: "extra-13" }, { value: "extra-2" }] } } }));
      expect(submitted[0]?.selectedOptionalCheckIds).toEqual(["extra-13", "extra-2"]);
    });

    it("keeps ten or fewer optional checks as checkboxes, and asks for none before the coding plan", () => {
      const command = { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 60 };
      const optional = Array.from({ length: 10 }, (_, index) => ({ id: `extra-${index}`, label: `Optional ${index}`, command }));
      const controls = workflowCheckControls({ required: [], optional, selectedOptionalIds: [] }, { codingPlan: true });
      expect(controls.find((block) => block.block_id === "workflow_checks")).toMatchObject({ element: { type: "checkboxes" } });
      expect(workflowCheckControls({ required: [], optional, selectedOptionalIds: [] }, { codingPlan: false }).some((block) => block.block_id === "workflow_checks")).toBe(false);
    });

    it("escapes check labels that would read as a broadcast or a disguised link", async () => {
      const command = { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 60 };
      const at = new Date(nowSeconds * 1_000).toISOString();
      const hostile = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now: at, checkPolicy: {
        required: [{ id: "required-1", label: "<!channel> & <https://evil|Approve>", command }], optional: [{ id: "extra", label: "<!here>", command }], selectedOptionalIds: [] } }),
      { expectedRevision: 1, now: at, artifact: { id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: at } });
      let opened: Record<string, unknown> | undefined;
      const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: hostile }), openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined });
      await handlers.handleAction(approve(hostile.revision));
      const mrkdwn = (opened?.blocks as Array<{ type: string; text?: { type: string; text: string } }>).filter((block) => block.text?.type === "mrkdwn").map((block) => block.text!.text).join("\n");
      expect(mrkdwn).toContain("&lt;!channel&gt; &amp; &lt;https://evil|Approve&gt;");
      expect(mrkdwn).not.toContain("<!channel>");
      expect(mrkdwn).not.toContain("<https://evil|Approve>");
      // An answered card keeps its own text, with any broadcast in it made inert.
      expect(JSON.stringify(answeredWorkflowCard("<!channel> ready", `<@${requester}> chose Retry reviews.`))).not.toContain("<!channel>");
    });

    it("closes the form when the decision it would submit is already recorded, without sending it again", async () => {
      let loaded: Record<string, unknown> = task;
      let opened: Record<string, unknown> | undefined;
      const submitted: Array<Record<string, unknown>> = [];
      const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async (_t, view) => { opened = view; }, submit: async (input) => { submitted.push(input); } });
      await handlers.handleAction(approve(workflow.revision));
      const form = submission(opened?.private_metadata, { workflow_checks: { selected_options: { selected_options: [{ value: "coverage" }] } } });
      await handlers.handleSubmission(form);
      const decided = { requestId: String(submitted[0]?.requestId), workflowRevision: workflow.revision, decision: "APPROVE", actorId: "b".repeat(64), actorRole: "TASK_OWNER",
        reason: "Approved in Slack.", artifactDigest: digest, selectedOptionalCheckIds: ["coverage"], at: new Date(nowSeconds * 1_000).toISOString() };
      loaded = { ...task, workflow: { ...workflow, revision: workflow.revision + 2, stage: "IMPLEMENT", state: "RUNNING", decisions: [decided] } };
      await expect(handlers.handleSubmission(form)).resolves.toBeUndefined();
      expect(submitted).toHaveLength(1);
      // A different decision on the moved-on task is still refused as out of date.
      await expect(handlers.handleSubmission(submission(opened?.private_metadata))).rejects.toThrow(/changed/);
    });

    it("refuses an approval from a member of another Slack organization, on the button and on the form", async () => {
      let opened: Record<string, unknown> | undefined;
      const submitted: Array<Record<string, unknown>> = [];
      const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async (_t, view) => { opened = view; }, submit: async (input) => { submitted.push(input); } });
      await expect(handlers.handleAction(approve(workflow.revision, { userTeamId: "T0OTHERORG1" }))).rejects.toThrow(/workspace/);
      await expect(handlers.handleAction(approve(workflow.revision, { workspaceTeamId: "T0OTHERORG1" }))).rejects.toThrow(/workspace/);
      await handlers.handleAction(approve(workflow.revision));
      await expect(handlers.handleSubmission(submission(opened?.private_metadata, {}, requester, "T0OTHERORG1"))).rejects.toThrow(/workspace/);
      await expect(handlers.handleSubmission({ user: { id: requester }, view: { private_metadata: opened?.private_metadata, state: { values: {} } } })).rejects.toThrow(/workspace/);
      expect(submitted).toEqual([]);
    });

    it("hands decisions to the broker asynchronously instead of waiting under Slack's three seconds", async () => {
      const send = vi.fn<(command: unknown) => Promise<{ StatusCode: number }>>(async () => ({ StatusCode: 202 }));
      await invokeWorkflowDecision({ send }, "broker", { action: "workflow-decision", taskId });
      expect((send.mock.calls[0]?.[0] as { input: { InvocationType: string; FunctionName: string } }).input).toMatchObject({ InvocationType: "Event", FunctionName: "broker" });
      await expect(invokeWorkflowDecision({ send: async () => ({ StatusCode: 500 }) }, "broker", {})).rejects.toThrow();
    });

    it("clears the form at once while a slow broker saves the decision, and a resubmission after it saved is quiet", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      try {
        let loaded: Record<string, unknown> = task;
        const brokerRuns: Array<Record<string, unknown>> = [];
        // The broker takes five seconds (a cold start), well past Slack's three-second wait.
        const lambda = { send: vi.fn(async (command: { input: { Payload?: Uint8Array } }) => {
          const event = JSON.parse(Buffer.from(command.input.Payload!).toString("utf8")) as Record<string, unknown>;
          setTimeout(() => {
            brokerRuns.push(event);
            loaded = { ...task, workflow: { ...workflow, revision: workflow.revision + 1, stage: "IMPLEMENT", state: "RUNNING", decisions: [{
              requestId: event.requestId, workflowRevision: workflow.revision, decision: "APPROVE", actorId: "b".repeat(64), actorRole: "TASK_OWNER",
              reason: event.reason, artifactDigest: digest, selectedOptionalCheckIds: event.selectedOptionalCheckIds, at: new Date(nowSeconds * 1_000).toISOString() }] } };
          }, 5_000);
          return { StatusCode: 202 };
        }) };
        let opened: Record<string, unknown> | undefined;
        const workflowHandlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; },
          submit: (input) => invokeWorkflowDecision(lambda as never, "broker", { source: "agentx.slack-ingress", action: "workflow-decision", ...input }) });
        const { handler } = harness({ workflow: workflowHandlers });
        await workflowHandlers.handleAction(approve(workflow.revision));
        const submit = () => handler(signed({ type: "view_submission", user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId },
          view: { callback_id: "agentx_workflow_review_submission", private_metadata: opened?.private_metadata, state: { values: {} } } }));
        expect(JSON.parse((await submit()).body)).toEqual({ response_action: "clear" });
        expect(brokerRuns).toEqual([]);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(brokerRuns).toHaveLength(1);
        // The owner, unsure, submits the same decision again: it was saved, so the form just closes.
        expect(JSON.parse((await submit()).body)).toEqual({ response_action: "clear" });
        expect(lambda.send).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows a refusal it can tell before saving in the form's own words, not as a failed save", async () => {
      let opened: Record<string, unknown> | undefined;
      let loaded: Record<string, unknown> = task;
      const workflowHandlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async (_t, view) => { opened = view; }, submit: async () => undefined });
      const { handler } = harness({ workflow: workflowHandlers });
      await workflowHandlers.handleAction(approve(workflow.revision));
      loaded = { ...task, workflow: { ...workflow, revision: workflow.revision + 1 } };
      const answer = JSON.parse((await handler(signed({ type: "view_submission", user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId },
        view: { callback_id: "agentx_workflow_review_submission", private_metadata: opened?.private_metadata, state: { values: {} } } }))).body) as { errors: Record<string, string> };
      expect(answer.errors.workflow_feedback).toBe("This approval has changed. Use the latest AgentX message.");
    });

    it("asks for changes to a coding plan without saying its checks are chosen later (Task 19 fix)", async () => {
      const at = new Date(nowSeconds * 1_000).toISOString();
      const optionalOnly = submitWorkflowArtifact(createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now: at, checkPolicy: {
        required: [], optional: [{ id: "lint", label: "Lint", command: { cwd: "workspace", executable: "npm", args: ["run", "lint"], timeoutSeconds: 60 } }], selectedOptionalIds: [] } }),
      { expectedRevision: 1, now: at, artifact: { id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "p", objectKey: "private/o/w/op/plan.md", createdAt: at } });
      let opened: Record<string, unknown> | undefined;
      const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: optionalOnly }), openView: async (trigger, view) => { await strict.openView(trigger, view); opened = view; }, submit: async () => undefined });
      await handlers.handleAction(approve(optionalOnly.revision, { actionId: "agentx_workflow_changes", value: JSON.stringify({ taskId, revision: optionalOnly.revision, digest, decision: "REQUEST_CHANGES" }) }));
      const text = JSON.stringify(opened?.blocks);
      expect(text).toContain("No project checks are required. You choose checks when you approve the coding plan.");
      expect(text).not.toContain("Checks are chosen when you approve the coding plan.");
      expect(text).toContain("workflow_feedback");
    });

    it("acknowledges Retry reviews privately and leaves the card's buttons, so a busy refusal is not a dead end", async () => {
      const at = new Date(nowSeconds * 1_000).toISOString();
      const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
      const blocked = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now: at }),
        revision: 7, stage: "REVIEW", state: "BLOCKED", candidate,
        verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: at, results: [{ checkId: "required-1", status: "PASS" }] },
        reviews: [{ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role: "SECURITY", provider: "test", version: "1", status: "UNKNOWN", failureReason: "INVALID_JSON", findings: [], readOnly: true, recordedAt: at }],
      });
      // The card as the notifier posted it, with its Retry reviews button.
      const slack = new StrictSlackWeb({ briefLimit: 1_200 });
      const card = slack.post({ channel: thread.channelId, threadTs: thread.threadTs, text: "A review couldn't finish.", blocks: [
        { type: "section", text: { type: "mrkdwn", text: "A review couldn't finish." } },
        { type: "actions", elements: [{ type: "button", action_id: "agentx_workflow_retry_reviews", text: { type: "plain_text", text: "Retry reviews" },
          value: JSON.stringify({ taskId, revision: 7, candidateDigest: candidate.digest }) }] }] });
      const respondEphemeral = vi.fn<(url: string, text: string) => Promise<void>>(async () => undefined);
      // The broker, later, finds the workspace busy: its refusal reaches the owner privately (the notifier's job).
      const retryReviews = async () => { slack.postEphemeral({ channel: thread.channelId, threadTs: thread.threadTs, user: requester, text: "AgentX is still working on the previous step. Try again when it posts." }); };
      const handlers = workflowSlackHandlers({ loadTask: async () => ({ ...task, workflow: blocked }), openView: async () => undefined, submit: async () => undefined, retryReviews, respondEphemeral });
      await handlers.handleAction({ actionId: "agentx_workflow_retry_reviews", value: JSON.stringify({ taskId, revision: 7, candidateDigest: candidate.digest }),
        userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread,
        messageTs: card.ts, messageText: "A review couldn't finish.", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3" });
      expect(respondEphemeral).toHaveBeenCalledWith("https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", "Retrying the reviews on the same checked code.");
      expect(slack.ephemerals.map((entry) => entry.text)).toEqual(["AgentX is still working on the previous step. Try again when it posts."]);
      // The card was never edited: Retry reviews is still there to press again.
      expect(slack.updates).toEqual([]);
      expect(slack.lastPostWithAction("agentx_workflow_retry_reviews").ts).toBe(card.ts);
    });

    it("acknowledges Send back, Retry coding and Retry opening the pull request privately, and an acknowledgement Slack refuses changes nothing", async () => {
      const at = new Date(nowSeconds * 1_000).toISOString();
      const respondEphemeral = vi.fn<(url: string, text: string) => Promise<void>>(async () => { throw new Error("expired_url"); });
      const handed: string[] = [];
      let loaded: Record<string, unknown> = { ...task, workflow: { ...workflow, revision: 6, stage: "IMPLEMENT", state: "BLOCKED", blockReason: "implementation operation ended failed" } };
      const handlers = workflowSlackHandlers({ loadTask: async () => loaded, openView: async () => undefined, submit: async () => undefined,
        retryImplementation: async () => { handed.push("coding"); }, sendBack: async () => { handed.push("send back"); }, retryPublication: async () => { handed.push("publish"); }, respondEphemeral });
      const press = (actionId: string, revision: number): SlackBlockAction => ({ actionId, value: JSON.stringify({ taskId, revision }), userId: requester, userTeamId: thread.teamId,
        workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: nowSeconds * 1_000, thread, messageTs: "1695500001.000002",
        messageText: "blocked", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", actionTs: "1695500001.000009" });
      await handlers.handleAction(press("agentx_workflow_retry_implementation", 6));
      expect(respondEphemeral).toHaveBeenLastCalledWith(expect.any(String), "Retrying.");
      const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
      loaded = { ...task, workflow: WorkflowSnapshotSchema.parse({ ...workflow, revision: 9, stage: "VERIFY", state: "BLOCKED", candidate,
        verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: at, results: [{ checkId: "required-1", status: "FAILED" }] } }) };
      await handlers.handleAction(press("agentx_workflow_send_back", 9));
      expect(respondEphemeral).toHaveBeenLastCalledWith(expect.any(String), "Sending this back to coding.");
      loaded = { ...task, workflow: WorkflowSnapshotSchema.parse({ ...workflow, revision: 11, stage: "PULL_REQUEST", state: "READY", candidate,
        verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: at, results: [{ checkId: "required-1", status: "PASS" }] },
        reviews: ["CRITIC", "SECURITY"].map((role) => ({ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role, provider: "test", version: "1", status: "PASS", findings: [], readOnly: true, recordedAt: at })) }) };
      await handlers.handleAction(press("agentx_workflow_retry_publish", 11));
      expect(respondEphemeral).toHaveBeenLastCalledWith(expect.any(String), "Opening the draft pull request again.");
      expect(handed).toEqual(["coding", "send back", "publish"]);
    });
  });
});

const RETRY_NOTICE = "I couldn't take that click. Press the button again, or reply `@AgentX yes`.";
const PROCESS_NOTICE = "I couldn't process that click. Press the button again, or reply `@AgentX yes`.";

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

describe("Quick or Full buttons (gap 3)", () => {
  const choiceId = "11111111-1111-4111-8111-111111111111";
  const responseUrl = "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc";
  function buttons(outcome: "started" | "none" | "not_requester" | "other_path" | "starting" | Error) {
    const choices: Array<Record<string, unknown>> = [];
    const acks: string[] = [];
    const workflow = workflowSlackHandlers({
      loadTask: async () => undefined, openView: async () => undefined, submit: async () => undefined,
      chooseWorkflowPath: async (input) => { choices.push(input); if (outcome instanceof Error) throw outcome; return outcome; },
      respondEphemeral: async (_url, text) => { acks.push(text); },
    });
    return { choices, acks, ...harness({ workflow }) };
  }
  const press = (actionId: string, user = requester, value = JSON.stringify({ choiceId })) => signed(payload({ actionId, user, value }));

  it("hands the requester's choice over with the question's message, and leaves the question as it is until the task starts (Task 19)", async () => {
    const { handler, choices, acks, ephemeral, updates } = buttons("started");
    expect((await handler(press("agentx_workflow_path_quick"))).statusCode).toBe(200);
    expect(choices).toEqual([{ thread, userId: requester, workflowPath: "QUICK", choiceId, responseUrl, messageTs: "1695500001.000002" }]);
    // Only a private acknowledgement: the buttons and the "reply quick or full" hint stay until the start succeeds.
    expect(acks).toEqual(["Starting this on Quick."]);
    expect(updates).toEqual([]);
    expect(ephemeral).toEqual([]);
    const full = buttons("started");
    await full.handler(press("agentx_workflow_path_full"));
    expect(full.choices).toEqual([{ thread, userId: requester, workflowPath: "FULL", choiceId, responseUrl, messageTs: "1695500001.000002" }]);
    expect(full.acks).toEqual(["Starting this on Full."]);
  });

  it("tells anyone else privately that only the person who asked can choose", async () => {
    const { handler, choices, acks, ephemeral, updates } = buttons("not_requester");
    await handler(press("agentx_workflow_path_quick", other));
    expect(choices).toEqual([{ thread, userId: other, workflowPath: "QUICK", choiceId, responseUrl, messageTs: "1695500001.000002" }]);
    expect(ephemeral).toEqual(["Only the person who asked can choose."]);
    expect(acks).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("says privately when the choice is no longer waiting, or the button is not one AgentX made", async () => {
    const stale = buttons("none");
    await stale.handler(press("agentx_workflow_path_full"));
    expect(stale.ephemeral).toEqual(["This choice is no longer waiting."]);
    for (const outcome of ["other_path", "starting"] as const) {
      const refused = buttons(outcome);
      await refused.handler(press("agentx_workflow_path_full"));
      expect(refused.ephemeral).toEqual([workflowChoiceRefusal(outcome)]);
      expect(refused.updates).toEqual([]);
    }
    const forged = buttons("started");
    await forged.handler(press("agentx_workflow_path_full", requester, "not json"));
    await forged.handler(press("agentx_workflow_path_full", requester, JSON.stringify({ choiceId: "nope" })));
    expect(forged.choices).toEqual([]);
    expect(forged.ephemeral).toEqual(["This choice is no longer waiting.", "This choice is no longer waiting."]);
  });

  it("explains a refused start in plain words", async () => {
    const { handler, ephemeral, updates } = buttons(new SlackWorkflowStartError("WORKSPACE_LIMIT"));
    await handler(press("agentx_workflow_path_quick"));
    expect(ephemeral).toEqual(["You've reached your open-task limit. Close a finished AgentX task, then try again."]);
    expect(updates).toEqual([]);
    const unknown = buttons(new SlackWorkflowStartError("UNKNOWN"));
    await unknown.handler(press("agentx_workflow_path_quick"));
    expect(unknown.ephemeral[0]).toContain(choiceId);
  });
});
