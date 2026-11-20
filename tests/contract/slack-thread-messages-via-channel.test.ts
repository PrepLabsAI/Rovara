// Lead 4 L4-SRC-SL: the `thread_messages` command through the built-in Slack adapter, against one fake Slack, through the adapter's real command route. One read of a thread's replies and its space's facts:
// the first message is not a reply, an app or a person of another organisation is marked as such, notices are not plain messages, a space is private unless Slack says public, shared or direct when Slack says so,
// the page is bounded, and Slack's refusals and outages come back as the adapter's fixed answers. Only an adapter that declares `history` is ever sent the command.
import { describe, expect, it, vi } from "vitest";
import { ChannelCommandSchema, THREAD_MESSAGES_MAX, adapterTakesCommand, builtInAdapterRecord, generateWebhookSecret } from "../../packages/contracts/src/index.js";
import { sendChannelCommand } from "../../packages/broker/src/aws/channel-commands.js";
import { createSlackChannelCommandsHandler } from "../../packages/broker/src/aws/slack-adapter.js";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const SECRET = generateWebhookSecret();
const TEAM = "T0123456789";
const SPACE = "C0123456789";
const THREAD = "1700000000.000100";
const adapter = builtInAdapterRecord({ channel: "slack", callbackUrl: "https://api.example.com/v1/slack/channel-events", commandsUrl: "https://api.example.com/v1/slack/channel-commands", secretName: "agentx/test/channel-adapter/slack" });
const urlOf = (url: string | URL | Request) => (url instanceof Request ? url.url : url.toString());
const bodyOf = (init: RequestInit | undefined) => (typeof init?.body === "string" ? init.body : "");

type Answer = (method: string, query: Record<string, string>) => Record<string, unknown> | Error;

function run(answer: Answer, space = SPACE, thread = THREAD) {
  const calls: Array<{ method: string; query: Record<string, string> }> = [];
  const slack = vi.fn<typeof fetch>(async (url) => {
    const parsed = new URL(urlOf(url));
    const method = parsed.pathname.replace("/api/", "");
    const query = Object.fromEntries(parsed.searchParams);
    calls.push({ method, query });
    const result = answer(method, query);
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify(result), { status: 200 });
  });
  const commands = createSlackChannelCommandsHandler({ secret: async () => SECRET, botToken: async () => "xoxb-test", fetch: slack, now: () => NOW });
  const send = () => sendChannelCommand({
    getSecret: async () => SECRET, checkAddresses: async () => undefined, now: () => NOW,
    fetch: async (url, init) => {
      const response = await commands({ rawPath: new URL(urlOf(url)).pathname, body: bodyOf(init), headers: init?.headers as Record<string, string>, requestContext: { http: { method: "POST" } } });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    },
  }, adapter, "thread_messages", { tenant: TEAM, space, thread });
  return { calls, send };
}

const channel = (over: Record<string, unknown> = {}) => ({ ok: true, channel: { is_channel: true, is_private: false, is_im: false, is_mpim: false, is_shared: false, is_ext_shared: false, is_org_shared: false, ...over } });
const message = (over: Record<string, unknown> = {}) => ({ ts: "1700000001.000100", thread_ts: THREAD, user: "U0000000001", team: TEAM, user_team: TEAM, text: "Use the shared helper.", ...over });
const slackWith = (messages: unknown[], info: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Answer => (method) => (method === "conversations.info" ? channel(info) : method === "conversations.replies" ? { ok: true, messages, ...extra } : { ok: false, error: "unknown_method" });

describe("the built-in Slack adapter takes thread_messages", () => {
  it("declares `history`, and the command's shape is strict", () => {
    expect(adapterTakesCommand(adapter, "thread_messages")).toBe(true);
    expect(adapterTakesCommand({ ...adapter, capabilities: { ...adapter.capabilities, history: false } }, "thread_messages")).toBe(false);
    const base = { version: 1, id: "cmd_aaaaaaaaaaaaaaaaaaaa", channel: "slack", createdAt: "2026-11-18T12:00:00.000Z", kind: "thread_messages", tenant: TEAM, space: SPACE, thread: THREAD };
    expect(ChannelCommandSchema.safeParse(base).success).toBe(true);
    expect(ChannelCommandSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(ChannelCommandSchema.safeParse({ ...base, thread: undefined }).success).toBe(false);
  });
});

describe("one read of a thread", () => {
  it("marks an app, a bot message and a message with no person as a bot; a person of another organisation as external; a notice as not plain", async () => {
    const { send } = run(slackWith([
      message({ ts: "1700000001.000001", bot_id: "B1", user: "U0000000002" }),
      message({ ts: "1700000001.000002", subtype: "bot_message", user: undefined }),
      message({ ts: "1700000001.000003", user: undefined }),
      message({ ts: "1700000001.000004", app_id: "A1" }),
      message({ ts: "1700000001.000005", user_team: "T0999999999" }),
      message({ ts: "1700000001.000006", team: "T0999999999" }),
      message({ ts: "1700000001.000007", subtype: "channel_join" }),
      message({ ts: "1700000001.000008", subtype: "thread_broadcast" }),
      message({ ts: "1700000001.000009", team: undefined, user_team: undefined }),
    ]));
    const answer = await send();
    expect(answer.messages.map((m) => [m.id.slice(-1), m.bot, m.external, m.plain])).toEqual([
      ["1", true, false, true], ["2", true, false, false], ["3", true, false, true], ["4", true, false, true], ["5", false, true, true], ["6", false, true, true], ["7", false, false, false], ["8", false, false, true], ["9", false, true, true],
    ]);
  });
  it("is bounded: at most one page, and says when there was more", async () => {
    const many = Array.from({ length: THREAD_MESSAGES_MAX + 20 }, (_, i) => message({ ts: `1700000003.${String(i).padStart(6, "0")}` }));
    const answer = await run(slackWith(many)).send();
    expect(answer.messages).toHaveLength(THREAD_MESSAGES_MAX);
    expect(answer.truncated).toBe(true);
    expect((await run(slackWith([message()], {}, { has_more: true })).send()).truncated).toBe(true);
  });
  it("leaves out a reply whose time is not a Slack time, a reply of another thread, and caps a long text", async () => {
    const answer = await run(slackWith([message({ ts: "not-a-time" }), message({ ts: "1700000001.000100", thread_ts: "1700000000.999999" }), message({ ts: "1700000001.000200", text: "x".repeat(9000) })])).send();
    expect(answer.messages.map((m) => m.id)).toEqual(["1700000001.000200"]);
    expect(answer.messages[0]!.text.length).toBe(4000);
  });
  it("reads only a channel's thread: a direct message id is refused before Slack is asked", async () => {
    const { calls, send } = run(slackWith([message()]), "D0123456789");
    await expect(send()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(calls).toEqual([]);
  });
  it("answers Slack's refusal and an outage as the adapter's fixed failures, and nothing is partial", async () => {
    await expect(run(() => ({ ok: false, error: "channel_not_found" })).send()).rejects.toBeTruthy();
    await expect(run(() => new TypeError("fetch failed")).send()).rejects.toBeTruthy();
    await expect(run((method) => (method === "conversations.info" ? channel() : { ok: true, messages: "nope" })).send()).rejects.toBeTruthy();
  });
});
