// Spec 062 Phase 7c3b (FR-080): Slack's forms through the channel API. A press that opens a form is answered at once
// with the form, which the adapter opens as the same modal; a submitted form reaches the same handler with the same
// values, and its answer (close, errors, a new form) is Slack's response; an admin change press and a form's later
// update go through the channel too.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_CHANGE_CONFIRM_ACTION, builtInAdapterRecord, createWorkflowSnapshot, formOfSlackModal, generateWebhookSecret, slackModalOf, submitWorkflowArtifact, verifyWebhook, webhookHeaders,
  type ChannelAction,
} from "../../packages/contracts/src/index.js";
import { createChannelIngressHandler } from "../../packages/broker/src/aws/channel-ingress.js";
import { createSlackChannelActionClient, createSlackChannelCommandsHandler } from "../../packages/broker/src/aws/slack-adapter.js";
import { formAnswerOf, formCapture, slackPressOfChannelAction, slackSubmissionPayloadOf } from "../../packages/broker/src/aws/slack-channel-presses.js";
import { createSlackInteractivityHandler, createSlackPressDispatcher, workflowSlackHandlers, type SlackBlockAction } from "../../packages/broker/src/aws/slack-interactivity.js";
import { channelActionOfAdminPress, channelActionOfPress, channelActionOfSubmission } from "../../packages/broker/src/aws/slack-press-routing.js";

const nowSeconds = 1_758_657_600;
const NOW = nowSeconds * 1_000;
const requester = "U0123456789";
const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const SECRET = generateWebhookSecret();
const taskId = "44444444-4444-5444-8444-444444444444";
const digest = "a".repeat(64);
const workflow = submitWorkflowArtifact(createWorkflowSnapshot({
  taskId, ownerId: "b".repeat(64), now: new Date(NOW).toISOString(),
  checkPolicy: {
    required: [{ id: "required-1", label: "npm test", command: { cwd: "workspace", executable: "npm", args: ["test"], timeoutSeconds: 120 } }],
    optional: [{ id: "coverage", label: "Coverage report", command: { cwd: "workspace", executable: "npm", args: ["run", "coverage"], timeoutSeconds: 120 } }], selectedOptionalIds: [],
  },
}), { expectedRevision: 1, now: new Date(NOW).toISOString(), artifact: {
  id: "plan-1", type: "plan", version: 1, sha256: digest, producer: "agentx-plan", objectKey: "private/owner/workspace/op/plan.md", createdAt: new Date(NOW).toISOString(),
} });
const task = { taskId, slackUserId: requester, share: thread, workflow };
const approve: SlackBlockAction = {
  actionId: "agentx_workflow_approve", value: JSON.stringify({ taskId, revision: workflow.revision, digest, decision: "APPROVE" }), userId: requester,
  userTeamId: thread.teamId, workspaceTeamId: thread.teamId, enterpriseId: "", userEnterpriseId: "", requestStartedAt: NOW, thread, messageTs: "1695500001.000002",
  messageText: "plan", responseUrl: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", triggerId: "1.2.3", actionTs: "1695500009.000001",
};

/** Slack's view_submission for a modal as opened, as Slack sends it: its own keys added, and the person's answers. */
function slackSubmission(view: Record<string, unknown>, values: Record<string, unknown>) {
  const withEmoji = JSON.parse(JSON.stringify(view).replaceAll('"type":"plain_text","text"', '"type":"plain_text","emoji":true,"text"')) as Record<string, unknown>;
  return { type: "view_submission", team: { id: thread.teamId }, user: { id: requester, team_id: thread.teamId },
    view: { ...withEmoji, id: "V0123456789", team_id: thread.teamId, hash: "1.abc", app_id: "A0AGENTX", bot_id: "B0AGENTX", root_view_id: "V0123456789", state: { values } } };
}

describe("a press that opens a form", () => {
  it("is answered with the form, which the adapter opens as the same modal", async () => {
    let local: Record<string, unknown> | undefined;
    await workflowSlackHandlers({ loadTask: async () => task, openView: async (_trigger, view) => { local = view; }, submit: async () => undefined }).handleAction(approve);
    const forms = formCapture();
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: forms.openView, submit: async () => undefined });
    const open = await forms.run(() => createSlackPressDispatcher({ handlers: [], workflow: handlers })(slackPressOfChannelAction(channelActionOfPress(approve)!, NOW)));
    expect(open).toBeDefined();
    // Only the press's request ID, in the form's state, differs: the reply target replaces Slack's response URL.
    expect(slackModalOf(open!).blocks).toEqual(local!.blocks);
    expect(slackModalOf(open!)).toMatchObject({ callback_id: local!.callback_id, title: local!.title, submit: local!.submit, close: local!.close });
  });
});

describe("a submitted form", () => {
  it("reaches the same handler with the same values as Slack's own submission, from what Slack sends", async () => {
    let opened: Record<string, unknown> | undefined;
    const submitted: Array<Record<string, unknown>> = [];
    const handlers = workflowSlackHandlers({ loadTask: async () => task, openView: async (_trigger, view) => { opened = view; }, submit: async (input) => { submitted.push(input); } });
    await handlers.handleAction(approve);
    const payload = slackSubmission(opened!, { workflow_checks: { selected_options: { type: "checkboxes", selected_options: [{ value: "coverage", text: { type: "plain_text", text: "Coverage report", emoji: true } }] } } });
    await handlers.handleSubmission(payload);
    const action = channelActionOfSubmission(payload, NOW)!;
    expect(action).toMatchObject({ actionId: "agentx_workflow_review_submission", actor: { tenant: thread.teamId, userId: requester }, formSubmission: { handle: "V0123456789" } });
    expect(action).not.toHaveProperty("conversation");
    await handlers.handleSubmission(slackSubmissionPayloadOf(action));
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(submitted[0]).toMatchObject({ decision: "APPROVE", selectedOptionalCheckIds: ["coverage"] });
  });

  it("is taken only from the form's own workspace, and only for a form the core opened", () => {
    const view = slackModalOf({ formId: "agentx_workflow_review_submission", title: "Approve", parts: [] });
    expect(channelActionOfSubmission({ ...slackSubmission(view, {}), user: { id: requester, team_id: "T0OTHERORG1" } }, NOW)).toBeUndefined();
    expect(channelActionOfSubmission(slackSubmission({ ...view, callback_id: "someone_elses_form" }, {}), NOW)).toBeUndefined();
  });

  it("answers as Slack's response does: close, errors on a field, or a new form", () => {
    expect(formAnswerOf({ response_action: "clear" })).toEqual({ status: "handled", form: { kind: "close" } });
    expect(formAnswerOf({ response_action: "errors", errors: { workflow_feedback: "Say what should change." } })).toEqual({ status: "handled", form: { kind: "errors", errors: { workflow_feedback: "Say what should change." } } });
    const view = slackModalOf({ formId: "agentx_workflow_close_submission", title: "Close this task", parts: [{ type: "section", text: "It closed already." }] });
    expect(formAnswerOf({ response_action: "update", view })).toEqual({ status: "handled", form: { kind: "update", form: formOfSlackModal(view) } });
  });
});

describe("Slack's interactivity with forms routed", () => {
  const signed = (payload: unknown) => {
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const timestamp = String(nowSeconds);
    return { rawPath: "/v1/slack/interactions", body, headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": `v0=${createHmac("sha256", "slack-signing").update(`v0:${timestamp}:${body}`).digest("hex")}` } };
  };
  const base = { secrets: async () => ({ signingSecret: "slack-signing", botToken: "xoxb" }), now: () => NOW, handlers: [] };

  it("answers a submission with the core's response, and falls back to its own when the core does not take it", async () => {
    const workflow = { handleAction: vi.fn(), handleSubmission: vi.fn(async () => undefined) };
    const routed = createSlackInteractivityHandler({ ...base, workflow, routeSubmission: async () => ({ response_action: "errors", errors: { workflow_feedback: "No." } }) });
    const payload = slackSubmission(slackModalOf({ formId: "agentx_workflow_review_submission", title: "Approve", parts: [] }), {});
    expect(JSON.parse((await routed(signed(payload))).body)).toEqual({ response_action: "errors", errors: { workflow_feedback: "No." } });
    expect(workflow.handleSubmission).not.toHaveBeenCalled();
    const local = createSlackInteractivityHandler({ ...base, workflow, routeSubmission: async () => undefined });
    expect(JSON.parse((await local(signed(payload))).body)).toEqual({ response_action: "clear" });
    expect(workflow.handleSubmission).toHaveBeenCalledTimes(1);
  });

  it("hands an admin change's press to the core instead of the broker", async () => {
    const press = vi.fn(async () => undefined);
    const routeAdminChange = vi.fn(async () => true);
    const handler = createSlackInteractivityHandler({ ...base, adminChange: { press }, routeAdminChange, respondEphemeral: async () => undefined });
    await handler(signed({ type: "block_actions", user: { id: requester, team_id: thread.teamId }, team: { id: thread.teamId }, container: { channel_id: "D0123456789" },
      response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", actions: [{ action_id: ADMIN_CHANGE_CONFIRM_ACTION, value: "11111111-2222-4333-8444-555555555555" }] }));
    expect(routeAdminChange).toHaveBeenCalledWith(expect.objectContaining({ changeId: "11111111-2222-4333-8444-555555555555", click: "confirm", slackUserId: requester }));
    expect(press).not.toHaveBeenCalled();
    expect(channelActionOfAdminPress({ changeId: "11111111-2222-4333-8444-555555555555", click: "confirm", slackUserId: requester, teamId: thread.teamId }, NOW))
      .toMatchObject({ actionId: ADMIN_CHANGE_CONFIRM_ACTION, value: "11111111-2222-4333-8444-555555555555", actor: { tenant: thread.teamId, userId: requester } });
  });
});

describe("the channel API and the adapter for forms", () => {
  const builtIn = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", secretName: "agentx/test/channel-adapter/slack" });
  const submission: ChannelAction = { version: 1, channel: "slack", eventId: "form:V1:1", actor: { channel: "slack", tenant: thread.teamId, userId: requester },
    actionId: "agentx_workflow_close_submission", value: "", formSubmission: { form: { formId: "agentx_workflow_close_submission", title: "Close", parts: [] }, values: {} }, receivedAt: new Date(NOW).toISOString() };
  function ingress(builtInAdapter = true) {
    const surface = vi.fn(async () => ({ statusCode: 200, body: JSON.stringify({ status: "handled", form: { kind: "close" } }) }));
    const handler = createChannelIngressHandler({
      getAdapter: async () => (builtInAdapter ? builtIn : { ...builtIn, channel: "slack", builtIn: undefined }), getSecret: async () => SECRET,
      getBinding: vi.fn(), linkedDeveloper: vi.fn(), issueLinkCode: vi.fn(), linkUrl: (code) => code, claim: async () => true, release: async () => undefined,
      enqueue: vi.fn(), sendEvent: vi.fn(), actionSurfaces: { slack: surface }, now: () => NOW, log: () => undefined,
    });
    return { handler, surface };
  }

  it("runs the built-in adapter's form outside any conversation, and answers what the core said", async () => {
    const { handler, surface } = ingress();
    const client = createSlackChannelActionClient({ channelApiUrl: "https://api.example.com", secret: async () => SECRET, now: () => NOW,
      fetch: async (url, init) => {
        const response = await handler({ rawPath: new URL(url instanceof Request ? url.url : url.toString()).pathname, body: typeof init?.body === "string" ? init.body : "", headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
        return new Response(response.body, { status: response.statusCode });
      } });
    expect(await client(submission, 2_000)).toEqual({ status: "handled", form: { kind: "close" } });
    expect(surface).toHaveBeenCalledWith(submission, {});
  });

  it("refuses a conversation-less action from any other adapter", async () => {
    const { handler, surface } = ingress(false);
    const body = JSON.stringify(submission);
    const response = await handler({ rawPath: "/v1/channels/slack/actions", body, headers: webhookHeaders({ secret: SECRET, id: "w1", timestamp: nowSeconds, body }), requestContext: { http: { method: "POST" } } });
    expect(response.statusCode).toBe(400);
    expect(surface).not.toHaveBeenCalled();
  });

  it("updates a form still open, by the handle its submission gave", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const commands = createSlackChannelCommandsHandler({ secret: async () => SECRET, botToken: async () => "xoxb", now: () => NOW,
      fetch: async (url, init) => { calls.push({ method: new URL(url instanceof Request ? url.url : url.toString()).pathname, body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } });
    const form = { title: "Connect ChatGPT", closeLabel: "Done", parts: [{ type: "section" as const, text: "ChatGPT is connected." }] };
    const command = { version: 1, id: "cmd_bbbbbbbbbbbbbbbbbbbbbb", channel: "slack", createdAt: new Date(NOW).toISOString(), kind: "update_form", handle: "V0123456789", form };
    const body = JSON.stringify(command);
    const response = await commands({ rawPath: "/v1/slack/channel-commands", body, headers: webhookHeaders({ secret: SECRET, id: command.id, timestamp: nowSeconds, body }), requestContext: { http: { method: "POST" } } });
    expect(JSON.parse(response.body)).toEqual({ ok: true, result: { updated: true } });
    expect(verifyWebhook({ secret: SECRET, headers: response.headers, body: response.body, nowSeconds })).toMatchObject({ ok: true, id: command.id });
    expect(calls).toEqual([{ method: "/api/views.update", body: { view_id: "V0123456789", view: slackModalOf(form) } }]);
  });
});
