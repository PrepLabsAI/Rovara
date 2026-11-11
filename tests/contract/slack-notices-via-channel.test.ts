// Spec 062 Phase 7c: the notifier's Slack posts through the built-in Slack adapter's commands. A card goes as a neutral
// message and is posted as the same Block Kit; Slack's answers and refusals come back as the notifier has always read
// them; a Canvas is made, shared and linked in one command. All in-process, against the adapter's real route.
import { describe, expect, it, vi } from "vitest";
import {
  ChannelCommandSchema, builtInAdapterRecord, channelMessageOfSlackBlocks, generateWebhookSecret, slackBlocksOf, verifyWebhook, webhookHeaders,
  type ChannelCommand,
} from "../../packages/contracts/src/index.js";
import { createSlackChannelCommandsHandler } from "../../packages/broker/src/aws/slack-adapter.js";
import { createSlackNoticeChannel } from "../../packages/broker/src/aws/slack-notice-channel.js";
import { SlackPostError, postMayHaveLanded } from "../../packages/broker/src/aws/slack-web.js";
import { answeredWorkflowCard, feedbackReviewFailedMessage } from "../../packages/broker/src/developer/workflow-messages.js";

const NOW = Date.parse("2026-11-11T12:00:00.000Z");
const SECRET = generateWebhookSecret();
const API = "https://api.example.com";
const adapter = builtInAdapterRecord({ channel: "slack", callbackUrl: `${API}/v1/slack/channel-events`, commandsUrl: `${API}/v1/slack/channel-commands`, secretName: "agentx/test/channel-adapter/slack" });
const TEAM = "T0123456789";
const CHANNEL = "C0123456789";
const THREAD = "1695500000.000001";

interface SlackCall { method: string; body: Record<string, unknown> }
const urlOf = (url: string | URL | Request) => (url instanceof Request ? url.url : url.toString());
const bodyOf = (init: RequestInit | undefined) => (typeof init?.body === "string" ? init.body : "");

/** Slack's Web API: answers each call from `answer`, or ok with a new timestamp. */
function slackApi(answer: (call: SlackCall) => Record<string, unknown> | Error | undefined = () => undefined) {
  const calls: SlackCall[] = [];
  let ts = 200;
  const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(urlOf(url));
    const method = parsed.pathname.replace("/api/", "");
    const body = init?.body === undefined ? Object.fromEntries(parsed.searchParams) : JSON.parse(bodyOf(init)) as Record<string, unknown>;
    const call = { method, body };
    calls.push(call);
    const result = answer(call);
    if (result instanceof Error) throw result;
    const defaults: Record<string, Record<string, unknown>> = {
      "canvases.create": { canvas_id: "F0123456789" },
      "files.info": { file: { permalink: "https://example.slack.com/docs/T0123456789/F0123456789" } },
    };
    return new Response(JSON.stringify({ ok: true, ts: `1700000000.000${++ts}`, ...(defaults[method] ?? {}), ...(result ?? {}) }), { status: 200 });
  });
  return { calls, fetchFn };
}

function system(slack = slackApi(), overrides: { secret?: string } = {}) {
  const commands: ChannelCommand[] = [];
  const handler = createSlackChannelCommandsHandler({ secret: async () => SECRET, botToken: async () => "xoxb-test", fetch: slack.fetchFn, now: () => NOW });
  const logs: Array<Record<string, unknown>> = [];
  const notices = createSlackNoticeChannel({
    adapter, teamId: TEAM, getSecret: async () => overrides.secret ?? SECRET, checkAddresses: async () => undefined, now: () => NOW, log: (entry) => { logs.push(entry); },
    fetch: async (url, init) => {
      commands.push(ChannelCommandSchema.parse(JSON.parse(bodyOf(init))));
      const response = await handler({ rawPath: new URL(urlOf(url)).pathname, body: bodyOf(init), headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    },
  });
  return { notices, commands, slack, logs, handler };
}

const card = feedbackReviewFailedMessage({ taskId: "11111111-2222-4333-8444-555555555555", revision: 4, reviewDigest: "a".repeat(64), blockReason: undefined, pullRequests: [{ number: 3, url: "https://github.com/example/web/pull/3" }] });

describe("a card as a neutral message", () => {
  it.each([
    ["a feedback review card with its Retry button", card.text, card.blocks],
    ["an answered card", "Plan v2 is ready.", answeredWorkflowCard("Plan v2 is ready.", "Approved by <@U0123456789>.")],
    ["a card with a link button and a divider", "Review", [
      { type: "section", text: { type: "mrkdwn", text: "*Plan* is ready." } },
      { type: "divider" },
      { type: "actions", elements: [
        { type: "button", action_id: "agentx_open_review", text: { type: "plain_text", text: "Open review" }, url: "https://rovara.example.com/review/1/plan" },
        { type: "button", action_id: "agentx_workflow_approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: "{\"taskId\":\"1\"}" },
      ] },
      { type: "context", elements: [{ type: "mrkdwn", text: "E2E is not required." }] },
    ]],
  ] as const)("renders back to the same blocks: %s", (_name, text, blocks) => {
    const message = channelMessageOfSlackBlocks(text, blocks);
    expect(message).toBeDefined();
    expect(slackBlocksOf(message!)).toEqual(blocks);
  });

  it("is not read from a block it does not know, so the post goes as text", () => {
    expect(channelMessageOfSlackBlocks("x", [{ type: "header", text: { type: "plain_text", text: "x" } }])).toBeUndefined();
    expect(channelMessageOfSlackBlocks("x", [{ type: "section", text: { type: "mrkdwn", text: "x" }, accessory: { type: "image" } }])).toBeUndefined();
  });
});

describe("the notifier's posts through the adapter", () => {
  it("posts a card in its task thread as the same blocks, signed both ways, and answers its timestamp", async () => {
    const { notices, commands, slack } = system();
    const posted = await notices.post({ channel: CHANNEL, threadTs: THREAD, text: card.text, blocks: card.blocks });
    expect(posted).toEqual({ ts: "1700000000.000201", channel: CHANNEL });
    expect(commands[0]).toMatchObject({ kind: "post_message", channel: "slack", tenant: TEAM, space: CHANNEL, thread: THREAD });
    expect(slack.calls).toEqual([{ method: "chat.postMessage", body: { channel: CHANNEL, thread_ts: THREAD, text: card.text, blocks: card.blocks, unfurl_links: false, unfurl_media: false } }]);
  });

  it("starts a task thread with a top-level post, whose timestamp is the thread", async () => {
    const { notices, commands } = system();
    expect(await notices.post({ channel: CHANNEL, text: "Task started." })).toEqual({ ts: "1700000000.000201", channel: CHANNEL });
    expect(commands[0]).not.toHaveProperty("thread");
  });

  it("sends a person's post as a direct message, and answers where it went", async () => {
    const { notices, commands, slack } = system(slackApi((call) => (call.method === "chat.postMessage" ? { channel: "D0123456789" } : undefined)));
    expect(await notices.post({ channel: "U0123456789", text: "You now have the reviewer role." })).toEqual({ ts: "1700000000.000201", channel: "D0123456789" });
    expect(commands[0]).toMatchObject({ kind: "direct_message", to: { channel: "slack", tenant: TEAM, userId: "U0123456789" } });
    expect(slack.calls[0]!.body).toMatchObject({ channel: "U0123456789" });
  });

  it("edits a posted card, and tells one person privately", async () => {
    const { notices, slack } = system();
    await notices.update({ channel: CHANNEL, ts: "1700000000.000150", text: "Approved.", blocks: answeredWorkflowCard("Plan", "Approved.") });
    await notices.postEphemeral({ channel: CHANNEL, threadTs: THREAD, user: "U0123456789", text: "That button is out of date." });
    expect(slack.calls).toEqual([
      { method: "chat.update", body: { channel: CHANNEL, ts: "1700000000.000150", text: "Approved.", blocks: answeredWorkflowCard("Plan", "Approved.") } },
      { method: "chat.postEphemeral", body: { channel: CHANNEL, thread_ts: THREAD, user: "U0123456789", text: "That button is out of date." } },
    ]);
  });

  it("reads Slack's refusal as Slack's own error, which did not land", async () => {
    const { notices } = system(slackApi(() => ({ ok: false, error: "channel_not_found" })));
    const error = await notices.post({ channel: CHANNEL, threadTs: THREAD, text: "x" }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(SlackPostError);
    expect((error as SlackPostError).slackError).toBe("channel_not_found");
    expect(postMayHaveLanded(error)).toBe(false);
  });

  it("reads no answer as a post that may have landed", async () => {
    const { notices } = system(slackApi(() => new TypeError("fetch failed")));
    const error = await notices.post({ channel: CHANNEL, threadTs: THREAD, text: "x" }).catch((thrown: unknown) => thrown);
    expect(postMayHaveLanded(error)).toBe(true);
  });

  it("is refused by the adapter when not signed with its secret, and nothing reaches Slack", async () => {
    const { notices, slack } = system(slackApi(), { secret: generateWebhookSecret() });
    const error = await notices.post({ channel: CHANNEL, threadTs: THREAD, text: "x" }).catch((thrown: unknown) => thrown);
    expect((error as SlackPostError).slackError).toBe("http_401");
    expect(postMayHaveLanded(error)).toBe(false);
    expect(slack.calls).toEqual([]);
  });
});

describe("a plan Canvas through the adapter", () => {
  it("is made, shared with the channel and linked in one command; its ID is recorded once known", async () => {
    const { notices, slack } = system();
    const created: string[] = [];
    const canvas = await notices.createPlanCanvas({ channel: CHANNEL, taskId: "task-1", title: "Fix the menu", version: 2, markdown: "# Plan" }, async (id) => { created.push(id); });
    expect(canvas).toEqual({ canvasId: "F0123456789", permalink: "https://example.slack.com/docs/T0123456789/F0123456789" });
    expect(created).toEqual(["F0123456789"]);
    expect(slack.calls.map((call) => call.method)).toEqual(["canvases.create", "canvases.access.set", "files.info"]);
    expect(slack.calls[0]!.body).toMatchObject({ title: "Plan: Fix the menu (v2)" });
  });

  it("is removed by the adapter when it cannot be shared, and the refusal is Slack's code", async () => {
    const { notices, slack } = system(slackApi((call) => (call.method === "canvases.access.set" ? { ok: false, error: "missing_scope" } : undefined)));
    const created: string[] = [];
    const error = await notices.createPlanCanvas({ channel: CHANNEL, taskId: "task-1", title: "Fix", version: 1, markdown: "# Plan" }, async (id) => { created.push(id); }).catch((thrown: unknown) => thrown);
    expect((error as SlackPostError).slackError).toBe("missing_scope");
    expect(slack.calls.map((call) => call.method)).toEqual(["canvases.create", "canvases.access.set", "canvases.delete"]);
    expect(created).toEqual([]);
  });

  it("is deleted by its ID", async () => {
    const { notices, slack } = system();
    expect(await notices.deleteCanvas("F0123456789")).toBe("deleted");
    expect(slack.calls).toEqual([{ method: "canvases.delete", body: { canvas_id: "F0123456789" } }]);
  });
});

describe("the adapter's command route", () => {
  const signed = (command: Record<string, unknown>, secret = SECRET) => {
    const body = JSON.stringify(command);
    return { rawPath: "/v1/slack/channel-commands", body, headers: webhookHeaders({ secret, id: String(command.id), timestamp: NOW / 1000, body }), requestContext: { http: { method: "POST" } } };
  };
  const base = { version: 1, id: "cmd_aaaaaaaaaaaaaaaaaaaaaa", channel: "slack", createdAt: new Date(NOW).toISOString() };

  it("signs its answer with the command's own ID", async () => {
    const { handler } = system();
    const response = await handler(signed({ ...base, kind: "post_message", space: CHANNEL, message: { text: "hi" } }));
    expect(response.statusCode).toBe(200);
    expect(verifyWebhook({ secret: SECRET, headers: response.headers, body: response.body, nowSeconds: NOW / 1000 })).toMatchObject({ ok: true, id: base.id });
  });

  it("refuses a command it does not run, and one for another channel", async () => {
    const { handler, slack } = system();
    expect(JSON.parse((await handler(signed({ ...base, kind: "space_members", tenant: TEAM, space: CHANNEL }))).body)).toMatchObject({ ok: false, error: { code: "unsupported" } });
    expect((await handler(signed({ ...base, channel: "chatops", kind: "post_message", space: CHANNEL, message: { text: "hi" } }))).statusCode).toBe(400);
    expect((await handler(signed({ ...base, kind: "post_message", space: CHANNEL, message: { text: "hi" } }, generateWebhookSecret()))).statusCode).toBe(401);
    expect(slack.calls).toEqual([]);
  });
});
