// Spec 062 Phase 7c3a: Slack's button presses that open no form go through the channel API. The Slack adapter hands a
// press on after Slack has its answer; the channel API runs the same handlers, with the same request IDs, and they
// answer through the adapter's commands. Presses that open a form stay with Slack's interactivity (Phase 7c3b).
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_PATH_QUICK_ACTION, builtInAdapterRecord, createCandidateManifest, createWorkflowSnapshot, generateWebhookSecret, webhookHeaders, WorkflowSnapshotSchema,
  type ChannelAction, type ChannelQueueItem,
} from "../../packages/contracts/src/index.js";
import { createChannelIngressHandler } from "../../packages/broker/src/aws/channel-ingress.js";
import { channelPressTransport, slackPressOfChannelAction } from "../../packages/broker/src/aws/slack-channel-presses.js";
import { createSlackInteractivityHandler, createSlackPressDispatcher, workflowSlackHandlers, type SlackBlockAction } from "../../packages/broker/src/aws/slack-interactivity.js";
import type { SlackNoticeChannel } from "../../packages/broker/src/aws/slack-notice-channel.js";
import { ROUTED_SLACK_PRESSES, channelActionOfPress } from "../../packages/broker/src/aws/slack-press-routing.js";

const nowSeconds = 1_758_657_600;
const NOW = nowSeconds * 1_000;
const requester = "U0123456789";
const taskId = "11111111-1111-4111-8111-111111111111";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const SECRET = generateWebhookSecret();

const candidate = createCandidateManifest([{ repositoryId: "demo", commitSha: "c".repeat(40), treeSha: "d".repeat(40) }]);
const blocked = WorkflowSnapshotSchema.parse({ ...createWorkflowSnapshot({ taskId, ownerId: "b".repeat(64), now: new Date(NOW).toISOString() }),
  revision: 7, stage: "REVIEW", state: "BLOCKED", candidate,
  verification: { candidateDigest: candidate.digest, producer: "agentx-broker", environmentId: "test", recordedAt: new Date(NOW).toISOString(), results: [{ checkId: "required-1", status: "PASS" }] },
  reviews: [{ operationId: "33333333-3333-4333-8333-333333333333", candidateDigest: candidate.digest, role: "SECURITY", provider: "test", version: "1", status: "UNKNOWN", failureReason: "INVALID_JSON", findings: [], readOnly: true, recordedAt: new Date(NOW).toISOString() }],
});
const task = { taskId, slackUserId: requester, share: thread, workflow: blocked };

const press = (overrides: Partial<SlackBlockAction> = {}): SlackBlockAction => ({
  actionId: "agentx_workflow_retry_reviews", value: JSON.stringify({ taskId, revision: blocked.revision, candidateDigest: candidate.digest }),
  userId: requester, userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: NOW,
  thread, messageTs: "1695500001.000002", messageText: "Reviews could not finish.", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc",
  triggerId: "1.2.3", actionTs: "1695500009.123456", ...overrides,
});

function notices() {
  const said: Array<Record<string, unknown>> = [];
  const channel: SlackNoticeChannel = {
    post: vi.fn(), createPlanCanvas: vi.fn(), deleteCanvas: vi.fn(),
    update: async (input) => { said.push({ update: input }); },
    postEphemeral: async (input) => { said.push({ ephemeral: input }); },
  };
  return { channel, said };
}

describe("a press as a channel action", () => {
  it("carries the press, the pressed message and Slack's own press ID; the core sees the press Slack's interactivity saw", () => {
    const action = channelActionOfPress(press())!;
    expect(action).toMatchObject({
      channel: "slack", eventId: "1695500009.123456:agentx_workflow_retry_reviews", actionId: "agentx_workflow_retry_reviews",
      conversation: { channel: "slack", tenant: thread.teamId, space: thread.channelId, thread: thread.threadTs },
      actor: { channel: "slack", tenant: thread.teamId, userId: requester }, messageId: "1695500001.000002", messageText: "Reviews could not finish.",
    });
    const seen = slackPressOfChannelAction(action, NOW);
    const original: Partial<SlackBlockAction> = { ...press() };
    delete original.responseUrl;
    delete original.triggerId;
    expect(seen).toMatchObject(original);
    expect(seen.responseUrl.startsWith("channel-reply:")).toBe(true);
  });

  it("is made only for presses the core takes, from the thread's own workspace", () => {
    // Phase 7c3b: presses that open a form are taken too (answered at once with the form).
    expect(channelActionOfPress(press({ actionId: "agentx_workflow_approve" }))).toBeDefined();
    expect(channelActionOfPress(press({ actionId: "rovara_chatgpt_open" }))).toBeUndefined();
    expect(channelActionOfPress(press({ actionId: "someone_elses_button" }))).toBeUndefined();
    expect(channelActionOfPress(press({ userTeamId: "T0OTHERORG1" }))).toBeUndefined();
    expect(ROUTED_SLACK_PRESSES.has(WORKFLOW_PATH_QUICK_ACTION)).toBe(true);
  });
});

describe("the channel API runs the press", () => {
  it("with the same handler and the same request ID as Slack's interactivity, and answers through the adapter", async () => {
    const retries: Array<Record<string, unknown>> = [];
    const handlers = (respondEphemeral: (url: string, text: string) => Promise<void>) => workflowSlackHandlers({
      loadTask: async () => task, openView: async () => undefined, submit: async () => undefined,
      retryReviews: async (input) => { retries.push(input); }, respondEphemeral,
    });
    // Slack's interactivity, as it runs today.
    await createSlackPressDispatcher({ handlers: [], workflow: handlers(async () => undefined) })(press());
    // The channel API, from the action the adapter handed on.
    const { channel, said } = notices();
    const transport = channelPressTransport({ notices: channel, enqueueAnswer: vi.fn(), runStart: vi.fn() });
    await createSlackPressDispatcher({ handlers: [], workflow: handlers((url, text) => transport.respondEphemeral(url, text)), respondEphemeral: (url, text) => transport.respondEphemeral(url, text) })(
      slackPressOfChannelAction(channelActionOfPress(press())!, NOW));
    expect(retries).toHaveLength(2);
    expect(retries[1]).toEqual(retries[0]);
    // Its acknowledgement goes to the presser privately, in the task's thread.
    expect(said).toHaveLength(1);
    expect(said[0]!.ephemeral).toMatchObject({ channel: thread.channelId, threadTs: thread.threadTs, user: requester });
  });

  it("tells the presser privately when the press is out of date", async () => {
    const { channel, said } = notices();
    const transport = channelPressTransport({ notices: channel, enqueueAnswer: vi.fn(), runStart: vi.fn() });
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async () => undefined, submit: async () => undefined, retryReviews: vi.fn() });
    const stale = press({ value: JSON.stringify({ taskId, revision: blocked.revision - 1, candidateDigest: candidate.digest }) });
    await createSlackPressDispatcher({ handlers: [], workflow: handlers, respondEphemeral: (url, text) => transport.respondEphemeral(url, text) })(
      slackPressOfChannelAction(channelActionOfPress(stale)!, NOW));
    expect(said).toHaveLength(1);
    expect(said[0]!.ephemeral).toMatchObject({ user: requester });
    expect(String((said[0]!.ephemeral as { text: string }).text)).toMatch(/out of date/);
  });

  it("edits the pressed card in place of Slack's replace, and never opens a form", async () => {
    const { channel, said } = notices();
    const transport = channelPressTransport({ notices: channel, enqueueAnswer: vi.fn(), runStart: vi.fn() });
    const target = slackPressOfChannelAction(channelActionOfPress(press())!, NOW).responseUrl;
    await transport.respondReplace(target, { text: "Starting this on Quick.", blocks: [] });
    expect(said).toEqual([{ update: { channel: thread.channelId, ts: "1695500001.000002", text: "Starting this on Quick.", blocks: [] } }]);
    await expect(transport.openView("1.2.3", {})).rejects.toThrow(/Slack adapter/);
  });

  it("is answered by the press handler when it takes it, and queued for the orchestrator when it does not", async () => {
    const builtIn = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", secretName: "agentx/test/channel-adapter/slack" });
    const queued: ChannelQueueItem[] = [];
    const surface = vi.fn(async (action: ChannelAction) => (action.actionId === "agentx_workflow_retry_reviews" ? { statusCode: 200, body: "{\"status\":\"handled\"}" } : undefined));
    const ingress = createChannelIngressHandler({
      getAdapter: async () => builtIn, getSecret: async () => SECRET, getBinding: async (ref) => ({ ...ref, projectName: "web", updatedAt: "2026-11-01T00:00:00.000Z" }),
      linkedDeveloper: vi.fn(), issueLinkCode: vi.fn(), linkUrl: (code) => code, claim: async () => true, release: async () => undefined,
      enqueue: async (item) => { queued.push(item); }, sendEvent: vi.fn(), actionSurfaces: { slack: surface }, now: () => NOW, log: () => undefined,
    });
    const send = (action: ChannelAction, id: string) => {
      const body = JSON.stringify(action);
      return ingress({ rawPath: "/v1/channels/slack/actions", body, headers: webhookHeaders({ secret: SECRET, id, timestamp: nowSeconds, body }), requestContext: { http: { method: "POST" } } });
    };
    const action = channelActionOfPress(press())!;
    expect(JSON.parse((await send(action, "w1")).body)).toEqual({ status: "handled" });
    expect(surface).toHaveBeenCalledWith(action, { projectName: "web" });
    expect(queued).toEqual([]);
    await send({ ...action, eventId: "EvAgxApprove1", actionId: "slack.confirmation", value: "yes" }, "w2");
    expect(queued).toHaveLength(1);
  });
});

describe("Slack's interactivity with presses routed", () => {
  function signedPress(actionId: string) {
    const payload = { type: "block_actions", user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId },
      container: { channel_id: thread.channelId, message_ts: "1695500001.000002", thread_ts: thread.threadTs }, message: { ts: "1695500001.000002", thread_ts: thread.threadTs, text: "x" },
      response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", trigger_id: "1.2.3", actions: [{ action_id: actionId, value: "{}", action_ts: "1695500009.123456" }] };
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const timestamp = String(nowSeconds);
    const signature = `v0=${createHmac("sha256", "slack-signing").update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return { rawPath: "/v1/slack/interactions", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature } };
  }
  function interactivity(routePress: (action: SlackBlockAction) => Promise<boolean>) {
    const local = vi.fn(async () => undefined);
    const replies: string[] = [];
    const handler = createSlackInteractivityHandler({
      secrets: async () => ({ signingSecret: "slack-signing", botToken: "xoxb" }), now: () => NOW,
      handlers: [{ matches: () => true, handle: local }], respondEphemeral: async (_url, text) => { replies.push(text); }, routePress,
    });
    return { handler, local, replies };
  }

  it("hands a routed press on and runs nothing itself", async () => {
    const { handler, local } = interactivity(async () => true);
    expect((await handler(signedPress("agentx_workflow_retry_reviews"))).statusCode).toBe(200);
    expect(local).not.toHaveBeenCalled();
  });

  it("answers a press it does not route itself", async () => {
    const { handler, local } = interactivity(async () => false);
    await handler(signedPress("agentx_details"));
    expect(local).toHaveBeenCalledTimes(1);
  });

  it("tells the presser when the hand-off failed, so they can press again", async () => {
    const { handler, local, replies } = interactivity(async () => { throw new Error("invoke failed"); });
    await handler(signedPress("agentx_workflow_retry_reviews"));
    expect(local).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
  });
});
