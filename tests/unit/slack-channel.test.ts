// The chat tool's channel adapter: its web client, its message shapes, what it hears, its socket, and the adapter as a plug-in. The network is a fake; every token is built at run time (push protection).
import { describe, expect, it } from "vitest";
import { IMPLICIT_COMPANY_ID, type ChannelDecision, type ChannelEvent, type InboundMessage } from "@agentx/contracts";
import { createAdapterRegistry, loadAdapters } from "../../packages/broker/src/ports/adapter-registry.js";
import {
  NO_THREAD, SLACK_CAPABILITIES, SlackApiError, SlackChannel, changesModal, changesPressOf, changesSubmissionOf, cleanChatText, decisionOf, escapeText, messageOf, renderEvent, slackChannelPlugin, slackWeb, startSocket, textOf, SOCKET_QUEUE_MAX, type SocketLike,
} from "../../packages/broker/src/plugins/channel/slack/index.js";

const BOT_TOKEN = ["xoxb", "1111111111", "2222222222", "abcdefghijklmnop"].join("-");
const APP_TOKEN = ["xapp", "1", "A0123456789", "3333333333", "abcdefghijklmnopqrstuvwx"].join("-");
const WSS = "wss://wss-primary.slack.com/link/?ticket=t1";
const TEAM = "T0AAAAAAA";
const BOT = "U0BOTBOT1";
const PERSON = "U0PERSON1";
const CHANNEL = "C0ROOM001";
const CLOCK = (): Date => new Date("2026-11-10T10:00:00.000Z");

interface Call { method: string; headers: Headers; body: string }
function fakeSlack(answers: Record<string, (body: Record<string, unknown>) => Response | Record<string, unknown>> = {}) {
  const calls: Call[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.replace("/api/", "");
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ method, headers: new Headers(init?.headers), body });
    const parsed = body.startsWith("{") ? (JSON.parse(body) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(body));
    const given = answers[method];
    const result = given === undefined ? defaults(method) : given(parsed);
    return result instanceof Response ? result : Response.json(result);
  };
  return { fetch: impl, calls };
}
const defaults = (method: string): Record<string, unknown> => {
  if (method === "auth.test") return { ok: true, team_id: TEAM, user_id: BOT };
  if (method === "chat.postMessage") return { ok: true, ts: "1700000000.000100" };
  if (method === "apps.connections.open") return { ok: true, url: WSS };
  return { ok: true };
};
const reader = (value: string) => async () => value;

describe("the web client", () => {
  it("asks who the bot is and posts a message in a thread with no previews and no name read as a mention", async () => {
    const slack = fakeSlack();
    const web = slackWeb({ botToken: reader(BOT_TOKEN), fetch: slack.fetch });
    expect(await web.authTest()).toEqual({ teamId: TEAM, botUserId: BOT });
    await web.postMessage({ channel: CHANNEL, threadTs: "1700000000.000001", text: "hello" });
    const post = slack.calls.find((call) => call.method === "chat.postMessage")!;
    expect(post.headers.get("authorization")).toBe(`Bearer ${BOT_TOKEN}`);
    expect(JSON.parse(post.body)).toMatchObject({ channel: CHANNEL, thread_ts: "1700000000.000001", text: "hello", unfurl_links: false, unfurl_media: false, link_names: false, parse: "none" });
  });

  it("names the tool's error code and nothing else, and never sends a token of the wrong shape", async () => {
    const refused = fakeSlack({ "chat.postMessage": () => ({ ok: false, error: "channel_not_found" }) });
    await expect(slackWeb({ botToken: reader(BOT_TOKEN), fetch: refused.fetch }).postMessage({ channel: CHANNEL, text: "x" })).rejects.toMatchObject({ code: "channel_not_found" });
    const wrong = fakeSlack();
    await expect(slackWeb({ botToken: reader("not-a-token"), fetch: wrong.fetch }).authTest()).rejects.toMatchObject({ code: "bad_bot_token" });
    expect(wrong.calls).toEqual([]);
    const text = await slackWeb({ botToken: reader(BOT_TOKEN), fetch: refused.fetch }).postMessage({ channel: CHANNEL, text: "secret task text" }).catch((error: Error) => error.message);
    expect(text).toBe("slack: channel_not_found");
    expect(text).not.toContain(BOT_TOKEN);
  });

  it("reports a rate limit with its wait, an outage, and an error text that is not a code", async () => {
    const limited = fakeSlack({ "chat.postMessage": () => new Response("", { status: 429, headers: { "retry-after": "7" } }) });
    await expect(slackWeb({ botToken: reader(BOT_TOKEN), fetch: limited.fetch }).postMessage({ channel: CHANNEL, text: "x" })).rejects.toMatchObject({ code: "ratelimited", retryAfterSeconds: 7 });
    const down = fakeSlack({ "chat.postMessage": () => new Response("", { status: 503 }) });
    await expect(slackWeb({ botToken: reader(BOT_TOKEN), fetch: down.fetch }).postMessage({ channel: CHANNEL, text: "x" })).rejects.toMatchObject({ code: "http_503" });
    const odd = fakeSlack({ "chat.postMessage": () => ({ ok: false, error: `echo ${BOT_TOKEN}` }) });
    await expect(slackWeb({ botToken: reader(BOT_TOKEN), fetch: odd.fetch }).postMessage({ channel: CHANNEL, text: "x" })).rejects.toMatchObject({ code: "refused" });
  });

  it("follows only the tool's own socket host, with the app token", async () => {
    const good = fakeSlack();
    expect(await slackWeb({ botToken: reader(BOT_TOKEN), appToken: reader(APP_TOKEN), fetch: good.fetch }).openConnection()).toBe(WSS);
    expect(good.calls[0]!.headers.get("authorization")).toBe(`Bearer ${APP_TOKEN}`);
    for (const url of ["ws://wss-primary.slack.com/x", "wss://evil.example/x", "wss://slack.com.evil.example/x", "https://wss-primary.slack.com/x"]) {
      const bad = fakeSlack({ "apps.connections.open": () => ({ ok: true, url }) });
      await expect(slackWeb({ botToken: reader(BOT_TOKEN), appToken: reader(APP_TOKEN), fetch: bad.fetch }).openConnection(), url).rejects.toMatchObject({ code: "bad_answer" });
    }
    await expect(slackWeb({ botToken: reader(BOT_TOKEN), fetch: good.fetch }).openConnection()).rejects.toMatchObject({ code: "no_app_token" });
  });
});

describe("what Rovara says", () => {
  const base = { version: 1 as const, id: "evt_aaaaaaaaaaaaaaaaaaaa", channel: "slack", createdAt: "2026-11-10T10:00:00.000Z", conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread: "1700000000.000001" } };

  it("escapes what could become a mention, a link or a channel reference", () => {
    expect(escapeText("<!channel> <@U123> <https://x.example|click> & more")).toBe("&lt;!channel&gt; &lt;@U123&gt; &lt;https://x.example|click&gt; &amp; more");
    const rendered = renderEvent({ ...base, type: "progress", data: { text: "Task <!here> needs you" } }, 3_000)!;
    expect(rendered.text).toBe("Task &lt;!here&gt; needs you");
  });

  it("cuts to the length the adapter said it takes and never leaves half an escape", () => {
    const rendered = renderEvent({ ...base, type: "progress", data: { text: "<".repeat(500) } }, 200)!;
    expect([...rendered.text].length).toBeLessThanOrEqual(200);
    expect(rendered.text.endsWith("…")).toBe(true);
    expect(rendered.text).not.toMatch(/&[a-z]{0,3}…$/u);
  });

  it("shows a card with its buttons only when the event has actions, and carries only the exact request in each button", () => {
    const data = { text: "Plan waits.", kind: "other" as const, requestId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", expectedRevision: 3, artifactDigest: "d".repeat(64), taskUrl: "https://example.test/t" };
    const withButtons = renderEvent({ ...base, type: "approval_request", data: { ...data, actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Reject" }] } }, 3_000)!;
    const elements = (withButtons.blocks![1] as { elements: Array<{ action_id: string; value?: string; url?: string }> }).elements;
    expect(elements.map((element) => element.action_id)).toEqual(["rovara_decide_APPROVE", "rovara_decide_REJECT", "rovara_open_task"]);
    expect(JSON.parse(elements[0]!.value!)).toEqual({ r: data.requestId, v: 3, d: data.artifactDigest, o: "APPROVE" });
    const pointer = renderEvent({ ...base, type: "approval_request", data }, 3_000)!;
    expect((pointer.blocks![1] as { elements: unknown[] }).elements).toHaveLength(1);
  });

  it("shows mainline's message event as its text, to one person when its audience is one, and says nothing for a done with no closing line or a direct message", () => {
    expect(renderEvent({ ...base, type: "message", data: { text: "Working on <it>" } }, 3_000)).toEqual({ text: "Working on &lt;it&gt;" });
    const privately = renderEvent({ ...base, type: "message", data: { text: "Only you.", audience: { kind: "ephemeral", actor: { channel: "slack", tenant: TEAM, userId: PERSON } } } }, 3_000)!;
    expect(privately.ephemeralTo).toBe(PERSON);
    expect(renderEvent({ ...base, type: "done", data: {} }, 3_000)).toBeUndefined();
    expect(renderEvent({ ...base, type: "done", data: { text: "Finished." } }, 3_000)).toEqual({ text: "Finished." });
    const rest = { version: base.version, id: base.id, channel: base.channel, createdAt: base.createdAt };
    expect(renderEvent({ ...rest, type: "direct", to: { channel: "slack", tenant: TEAM, userId: PERSON }, data: { text: "Hi" } }, 3_000)).toBeUndefined();
  });

  it("shows a link request only to the person who asked", () => {
    const rendered = renderEvent({ ...base, type: "link_required", data: { linkUrl: "https://example.test/link", expiresAt: "2026-11-10T11:00:00.000Z", actor: { channel: "slack", tenant: TEAM, userId: PERSON } } }, 3_000)!;
    expect(rendered.ephemeralTo).toBe(PERSON);
  });
});

describe("what it hears", () => {
  const mention = (overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) => ({
    team_id: TEAM, event_id: "Ev0001", event: { type: "app_mention", user: PERSON, text: `<@${BOT}> add a retry for <@U0OTHER99> &amp; more`, ts: "1700000000.000200", channel: CHANNEL, user_team: TEAM, ...overrides }, ...envelope,
  });

  it("reads a mention of the bot as a message in its thread, without the bot's name or anyone's account id", () => {
    const message = messageOf(mention(), { userId: BOT }, CLOCK)!;
    expect(message).toMatchObject({
      version: 2, channel: "slack", eventId: "Ev0001", text: "add a retry for @member & more",
      conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread: "1700000000.000200" }, actor: { channel: "slack", tenant: TEAM, userId: PERSON },
    });
    expect(messageOf(mention({ thread_ts: "1700000000.000001" }), { userId: BOT }, CLOCK)!.conversation.thread).toBe("1700000000.000001");
  });

  it("refuses a mention that does not say which workspace the speaker belongs to, and says so in one fixed word", () => {
    const logs: Array<Record<string, unknown>> = [];
    expect(messageOf(mention({ user_team: undefined }), { userId: BOT }, CLOCK, (entry) => logs.push(entry))).toBeUndefined();
    expect(logs).toEqual([{ event: "slack.speaker_workspace_unknown" }]);
  });

  it("takes the speaker's workspace from the speaker, so a guest from a shared channel is not of the channel's workspace", () => {
    const guest = messageOf(mention({ user_team: "T0GUESTTT" }), { userId: BOT }, CLOCK)!;
    expect(guest.actor.tenant).toBe("T0GUESTTT");
    expect(guest.conversation.tenant).toBe(TEAM);
    expect(messageOf(mention({ user_team: TEAM }), { userId: BOT }, CLOCK)!.actor.tenant).toBe(TEAM);
  });

  it("hears nothing else: another event, the bot's own words, another bot, an empty mention, a malformed event", () => {
    const bot = { userId: BOT };
    expect(messageOf(mention({ type: "message" }), bot, CLOCK)).toBeUndefined();
    expect(messageOf(mention({ user: BOT }), bot, CLOCK)).toBeUndefined();
    expect(messageOf(mention({ bot_id: "B0001" }), bot, CLOCK)).toBeUndefined();
    expect(messageOf(mention({ subtype: "bot_message" }), bot, CLOCK)).toBeUndefined();
    expect(messageOf(mention({ text: `<@${BOT}>` }), bot, CLOCK)).toBeUndefined();
    expect(messageOf(mention({ ts: "later" }), bot, CLOCK)).toBeUndefined();
    expect(messageOf({ event: {} }, bot, CLOCK)).toBeUndefined();
    expect(textOf("<@U0BOTBOT1|rovara> hi", BOT)).toBe("hi");
  });

  const press = (value: unknown, actionId = "rovara_decide_APPROVE", overrides: Record<string, unknown> = {}) => ({
    type: "block_actions", trigger_id: "1337.42.abcdef", user: { id: PERSON, team_id: TEAM }, team: { id: TEAM }, channel: { id: CHANNEL }, message: { ts: "1700000000.000300", thread_ts: "1700000000.000001" },
    actions: [{ action_id: actionId, value: typeof value === "string" ? value : JSON.stringify(value) }], ...overrides,
  });
  const VALUE = { r: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", v: 3, d: "d".repeat(64), o: "APPROVE" };

  it("reads a press of one of its buttons as a decision for exactly the request the button names", () => {
    expect(decisionOf(press(VALUE), CLOCK)).toMatchObject({
      version: 1, channel: "slack", eventId: "1337.42.abcdef", requestId: VALUE.r, expectedRevision: 3, artifactDigest: VALUE.d, decision: "APPROVE",
      conversation: { tenant: TEAM, space: CHANNEL, thread: "1700000000.000001" }, actor: { userId: PERSON },
    });
    // A card posted at the top of a space has no thread.
    expect(decisionOf(press(VALUE, undefined, { message: { ts: "1700000000.000300" } }), CLOCK)!.conversation.thread).toBe(NO_THREAD);
  });

  it("refuses a press that does not say which workspace the presser belongs to, and says so in one fixed word", () => {
    const logs: Array<Record<string, unknown>> = [];
    expect(decisionOf(press(VALUE, undefined, { user: { id: PERSON } }), CLOCK, (entry) => logs.push(entry))).toBeUndefined();
    expect(logs).toEqual([{ event: "slack.speaker_workspace_unknown" }]);
  });

  it("takes the presser's workspace from the presser", () => {
    const external = decisionOf(press(VALUE, undefined, { user: { id: PERSON, team_id: "T0GUESTTT" } }), CLOCK)!;
    expect(external.actor.tenant).toBe("T0GUESTTT");
    expect(external.conversation.tenant).toBe(TEAM);
    expect(decisionOf(press(VALUE, undefined, { user: { id: PERSON, team_id: TEAM } }), CLOCK)!.actor.tenant).toBe(TEAM);
  });

  it("ignores a press that is not Rovara's, whose value does not read, or whose button and value disagree", () => {
    expect(decisionOf(press(VALUE, "someone_elses_button"), CLOCK)).toBeUndefined();
    expect(decisionOf(press("{not json"), CLOCK)).toBeUndefined();
    expect(decisionOf(press({ ...VALUE, d: "short" }), CLOCK)).toBeUndefined();
    expect(decisionOf(press({ ...VALUE, extra: 1 }), CLOCK)).toBeUndefined();
    expect(decisionOf(press({ ...VALUE, o: "REJECT" }), CLOCK)).toBeUndefined();
    expect(decisionOf({ type: "view_submission" }, CLOCK)).toBeUndefined();
  });
});

/** A socket the test drives: it is told what the tool sends, and records what Rovara sends back. */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; queueMicrotask(() => this.onclose?.()); }
  hear(envelope: unknown): void { this.onmessage?.({ data: JSON.stringify(envelope) }); }
}
const until = async (check: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); expect(check()).toBe(true); };

describe("the socket", () => {
  it("acknowledges an envelope at once, then hands it over, in order, and reopens after the tool asks to disconnect", async () => {
    const sockets: FakeSocket[] = [];
    const handled: string[] = [];
    let opened = 0;
    const run = startSocket({
      web: { openConnection: async () => { opened += 1; return WSS; } }, connect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      handle: async ({ type, payload }) => { handled.push(`${type}:${JSON.stringify(payload)}`); }, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); },
    });
    await until(() => sockets.length === 1);
    sockets[0]!.hear({ type: "hello" });
    sockets[0]!.hear({ type: "events_api", envelope_id: "e1", payload: { n: 1 } });
    sockets[0]!.hear({ type: "interactive", envelope_id: "e2", payload: { n: 2 } });
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: "e1" }), JSON.stringify({ envelope_id: "e2" })]);
    await until(() => handled.length === 2);
    expect(handled).toEqual(['events_api:{"n":1}', 'interactive:{"n":2}']);
    sockets[0]!.hear({ type: "disconnect", reason: "refresh_requested" });
    await until(() => sockets.length === 2);
    expect(opened).toBe(2);
    await run.stop();
    expect(sockets[1]!.closed).toBe(true);
  });

  it("waits a growing time when it cannot connect, never throws, and stops promptly", async () => {
    const waits: number[] = [];
    let tries = 0;
    const run = startSocket({
      web: { openConnection: async () => { tries += 1; throw new SlackApiError("unreachable"); } }, handle: async () => undefined, sleep: async (ms) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, 1)); },
    });
    await until(() => waits.length >= 4);
    expect(waits.slice(0, 4)).toEqual([1_000, 2_000, 5_000, 10_000]);
    await run.stop();
    expect(tries).toBeGreaterThanOrEqual(4);
  });

  it("holds at most a fixed number of envelopes for the handler, acknowledges every one, and logs what it drops", async () => {
    const socket = new FakeSocket();
    const logs: Array<Record<string, unknown>> = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let handled = 0;
    const run = startSocket({ web: { openConnection: async () => WSS }, connect: () => socket, handle: async () => { handled += 1; await gate; }, log: (entry) => logs.push(entry), sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); } });
    await until(() => socket.onmessage !== null);
    for (let n = 0; n < SOCKET_QUEUE_MAX + 50; n += 1) socket.hear({ type: "events_api", envelope_id: `e${String(n)}`, payload: {} });
    expect(socket.sent).toHaveLength(SOCKET_QUEUE_MAX + 50);
    expect(logs.filter((entry) => entry["event"] === "slack.queue_full")).toHaveLength(50);
    release();
    await until(() => handled === SOCKET_QUEUE_MAX);
    await run.stop();
  });

  it("keeps reading after a handler fails, logging only the error's name", async () => {
    const socket = new FakeSocket();
    const logs: Array<Record<string, unknown>> = [];
    let n = 0;
    const run = startSocket({ web: { openConnection: async () => WSS }, connect: () => socket, handle: async () => { n += 1; if (n === 1) throw new Error(`boom ${BOT_TOKEN}`); }, log: (entry) => logs.push(entry), sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); } });
    await until(() => socket.onmessage !== null);
    socket.hear({ type: "events_api", envelope_id: "e1", payload: {} });
    socket.hear({ type: "events_api", envelope_id: "e2", payload: {} });
    await until(() => n === 2);
    expect(JSON.stringify(logs)).not.toContain(BOT_TOKEN);
    expect(logs).toContainEqual({ event: "slack.handler_failed", errorName: "Error" });
    await run.stop();
  });
});

describe("the adapter", () => {
  const event = (overrides: Record<string, unknown> = {}, id = "evt_aaaaaaaaaaaaaaaaaaaa"): ChannelEvent => ({
    version: 1, id, channel: "slack", createdAt: "2026-11-10T10:00:00.000Z", conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread: "1700000000.000001" }, type: "progress", data: { text: "A task needs you." }, ...overrides,
  });
  const make = (slack = fakeSlack(), extra: Partial<ConstructorParameters<typeof SlackChannel>[0]> = {}) => ({ slack, adapter: new SlackChannel({ projects: ["web"], botToken: reader(BOT_TOKEN), fetch: slack.fetch, now: CLOCK, ...extra }) });
  const posts = (slack: ReturnType<typeof fakeSlack>) => slack.calls.filter((call) => call.method === "chat.postMessage").map((call) => JSON.parse(call.body) as Record<string, unknown>);

  it("describes itself: threads, four buttons, no edits, may message first, and asks for a sign-in on a plan and an admin change", () => {
    const { adapter } = make();
    expect(adapter.capabilities).toEqual(SLACK_CAPABILITIES);
    expect(adapter.stepUp).toEqual(["plan_approval", "admin"]);
    expect(adapter.noThread).toBe(NO_THREAD);
    expect(adapter.projects).toEqual(["web"]);
  });

  it("refuses a direct message, which needs the `direct` ability it does not declare, and posts nothing", async () => {
    const { slack, adapter } = make();
    const direct = { version: 1, id: "evt_cccccccccccccccccccc", channel: "slack", createdAt: "2026-11-10T10:00:00.000Z", type: "direct", to: { channel: "slack", tenant: TEAM, userId: PERSON }, data: { text: "Hi" } } as ChannelEvent;
    await expect(adapter.deliver(direct)).rejects.toMatchObject({ code: "direct_not_supported" });
    expect(posts(slack)).toHaveLength(0);
  });

  it("posts an event in its thread, or at the top of a space when the conversation has no thread, and drops a repeat of an event id", async () => {
    const { slack, adapter } = make();
    await adapter.deliver(event());
    await adapter.deliver(event());
    await adapter.deliver(event({ conversation: { channel: "slack", tenant: TEAM, space: "D0DIRECT01", thread: NO_THREAD } }, "evt_bbbbbbbbbbbbbbbbbbbb"));
    const sent = posts(slack);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ channel: CHANNEL, thread_ts: "1700000000.000001", text: "A task needs you." });
    expect(sent[1]).toMatchObject({ channel: "D0DIRECT01" });
    expect(sent[1]).not.toHaveProperty("thread_ts");
  });

  it("shows a private notice to the one account it names, and never posts it in the thread", async () => {
    const slack = fakeSlack();
    const { adapter } = make(slack);
    await adapter.deliver(event({ data: { text: "Paste this code: abc", onlyTo: PERSON } }));
    expect(posts(slack)).toEqual([]);
    const ephemeral = slack.calls.filter((call) => call.method === "chat.postEphemeral").map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(ephemeral).toHaveLength(1);
    expect(ephemeral[0]).toMatchObject({ channel: CHANNEL, user: PERSON, thread_ts: "1700000000.000001", text: "Paste this code: abc" });
  });

  it("does not post a failed event as sent, so the retry posts it", async () => {
    let fail = true;
    const slack = fakeSlack({ "chat.postMessage": () => (fail ? { ok: false, error: "ratelimited" } : { ok: true, ts: "1700000000.000100" }) });
    const { adapter } = make(slack);
    await expect(adapter.deliver(event())).rejects.toBeInstanceOf(SlackApiError);
    fail = false;
    await adapter.deliver(event());
    expect(posts(slack)).toHaveLength(2);
  });

  it("posts only in its own workspace, and only for its own channel id", async () => {
    const { slack, adapter } = make();
    await expect(adapter.deliver(event({ conversation: { channel: "slack", tenant: "T0BBBBBBB", space: CHANNEL, thread: NO_THREAD } }))).rejects.toMatchObject({ code: "wrong_workspace" });
    await expect(adapter.deliver(event({ channel: "otherchat", conversation: { channel: "otherchat", tenant: "t", space: "s", thread: "th" } }))).rejects.toMatchObject({ code: "wrong_channel" });
    expect(posts(slack)).toEqual([]);
  });

  it("hears a mention and a button press through the sink it is given, and only after its token was accepted", async () => {
    const sockets: FakeSocket[] = [];
    const messages: InboundMessage[] = [];
    const decisions: ChannelDecision[] = [];
    const slack = fakeSlack();
    const { adapter } = make(slack, { appToken: reader(APP_TOKEN), socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); } });
    const listening = await adapter.start({ message: async (message) => { messages.push(message); }, decision: async (decision) => { decisions.push(decision); } });
    await until(() => sockets.length === 1);
    sockets[0]!.hear({ type: "events_api", envelope_id: "e1", payload: { team_id: TEAM, event_id: "Ev1", event: { type: "app_mention", user: PERSON, user_team: TEAM, text: `<@${BOT}> do it`, ts: "1700000000.000200", channel: CHANNEL } } });
    sockets[0]!.hear({ type: "interactive", envelope_id: "e2", payload: { type: "block_actions", trigger_id: "9.9.z", user: { id: PERSON, team_id: TEAM }, team: { id: TEAM }, channel: { id: CHANNEL }, message: { ts: "1700000000.000300", thread_ts: "1700000000.000001" }, actions: [{ action_id: "rovara_decide_REJECT", value: JSON.stringify({ r: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", v: 2, d: "e".repeat(64), o: "REJECT" }) }] } });
    await until(() => messages.length === 1 && decisions.length === 1);
    expect(messages[0]!.text).toBe("do it");
    expect(decisions[0]).toMatchObject({ decision: "REJECT", expectedRevision: 2 });
    await listening.stop();
  });

  it("fails to start with the tool's code when its token is not accepted, and without an app token only sends", async () => {
    const refused = fakeSlack({ "auth.test": () => ({ ok: false, error: "invalid_auth" }) });
    await expect(make(refused).adapter.start({ message: async () => undefined, decision: async () => undefined })).rejects.toMatchObject({ code: "invalid_auth" });
    const sockets: FakeSocket[] = [];
    const { adapter } = make(fakeSlack(), { socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; } });
    await (await adapter.start({ message: async () => undefined, decision: async () => undefined })).stop();
    expect(sockets).toEqual([]);
  });
});

describe("the plug-in", () => {
  const entry = (settings: Record<string, unknown>) => ({ plugins: [{ point: "channel" as const, name: "slack", module: "x", enabled: true, settings }] });
  const load = async (settings: Record<string, unknown>, environment: Record<string, string> = {}) => {
    const registry = createAdapterRegistry();
    const slack = fakeSlack();
    const plugin = slackChannelPlugin({ fetch: slack.fetch });
    const saved = { ...process.env };
    Object.assign(process.env, environment);
    try {
      await loadAdapters({ companyId: IMPLICIT_COMPANY_ID, ...entry(settings) } as never, { registry, importModule: async () => ({ plugin }) });
    } finally {
      for (const key of Object.keys(environment)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    }
    return { registry, slack };
  };

  it("registers a channel adapter named slack that reads its tokens through the secrets point, each time it posts", async () => {
    const { registry, slack } = await load({ botToken: { env: "TEST_SLACK_BOT_TOKEN" }, projects: ["web"] }, { TEST_SLACK_BOT_TOKEN: BOT_TOKEN });
    const adapter = registry.require("channel", "slack");
    expect(adapter.projects).toEqual(["web"]);
    // The token is not in the environment now: the read happens when the post is made.
    await expect(adapter.deliver({ version: 1, id: "evt_cccccccccccccccccccc", channel: "slack", createdAt: "2026-11-10T10:00:00.000Z", conversation: { channel: "slack", tenant: TEAM, space: CHANNEL, thread: NO_THREAD }, type: "progress", data: { text: "x" } })).rejects.toThrow("the secret is not available");
    expect(slack.calls).toEqual([]);
  });

  it("refuses settings that are not valid, saying which field and never what it held", async () => {
    await expect(load({ botToken: { env: "X" }, projects: [] })).rejects.toThrow(/projects/u);
    await expect(load({ botToken: "xoxb-in-the-config", projects: ["web"] })).rejects.toThrow(/botToken/u);
    await expect(load({ botToken: { env: "X" }, projects: ["web"], extra: true })).rejects.toThrow();
    const error = await load({ botToken: BOT_TOKEN, projects: ["web"] }).catch((caught: Error) => caught.message);
    expect(error).not.toContain(BOT_TOKEN);
  });
});

describe("Request changes asks what should change", () => {
  const REQUEST = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
  const VALUE = { r: REQUEST, v: 3, d: "d".repeat(64), o: "REQUEST_CHANGES" };
  const press = (overrides: Record<string, unknown> = {}) => ({
    type: "block_actions", trigger_id: "1337.42.abcdef", user: { id: PERSON, team_id: TEAM }, team: { id: TEAM }, channel: { id: CHANNEL }, message: { ts: "1700000000.000300", thread_ts: "1700000000.000001" },
    actions: [{ action_id: "rovara_decide_REQUEST_CHANGES", value: JSON.stringify(VALUE) }], ...overrides,
  });
  const context = changesPressOf(press())!.context;
  const submission = (text: string | null | undefined, overrides: Record<string, unknown> = {}, meta: unknown = context) => ({
    type: "view_submission", user: { id: PERSON, team_id: TEAM }, team: { id: TEAM },
    view: { id: "V0VIEW001", callback_id: "rovara_changes", private_metadata: JSON.stringify(meta), state: { values: { rovara_changes_reason: { text: { type: "plain_text_input", value: text } } } } }, ...overrides,
  });

  it("declares forms, and a press of the button is not a decision: it is a request to open the box for exactly that request, by that person", () => {
    expect(SLACK_CAPABILITIES.forms).toBe(true);
    expect(decisionOf(press(), CLOCK)).toBeUndefined();
    expect(changesPressOf(press())).toEqual({ triggerId: "1337.42.abcdef", context: { r: REQUEST, v: 3, d: "d".repeat(64), t: TEAM, s: CHANNEL, h: "1700000000.000001", u: PERSON, w: TEAM } });
    // Another button, a value that disagrees with its button, and a presser with no workspace open no box.
    expect(changesPressOf(press({ actions: [{ action_id: "rovara_decide_APPROVE", value: JSON.stringify({ ...VALUE, o: "APPROVE" }) }] }))).toBeUndefined();
    expect(changesPressOf(press({ actions: [{ action_id: "rovara_decide_REQUEST_CHANGES", value: JSON.stringify({ ...VALUE, o: "REJECT" }) }] }))).toBeUndefined();
    expect(changesPressOf(press({ user: { id: PERSON } }))).toBeUndefined();
    const modal = changesModal(context) as { type: string; callback_id: string; private_metadata: string; blocks: Array<{ label: { text: string }; element: { max_length: number } }> };
    expect(modal).toMatchObject({ type: "modal", callback_id: "rovara_changes" });
    expect(modal.blocks[0]!.label.text).toBe("What should change?");
    expect(modal.blocks[0]!.element.max_length).toBe(500);
    expect(JSON.parse(modal.private_metadata)).toEqual(context);
  });

  it("reads the words typed in the box as the reason of a request for changes for the request the box was opened for", () => {
    const heard = changesSubmissionOf(submission("Use the retry helper."), { userId: BOT }, CLOCK);
    expect(heard).toMatchObject({ status: "ok", decision: { decision: "REQUEST_CHANGES", reason: "Use the retry helper.", requestId: REQUEST, expectedRevision: 3, eventId: "V0VIEW001", conversation: { tenant: TEAM, space: CHANNEL, thread: "1700000000.000001" }, actor: { userId: PERSON, tenant: TEAM } } });
  });

  it("makes the words safe the way other chat text is, and cuts them to the limit", () => {
    expect(cleanChatText(`<@${BOT}> hi <@U0OTHER99> &lt;b&gt;\u0000 a\u200b   b`, BOT, 500)).toBe("hi @member <b> a b");
    const heard = changesSubmissionOf(submission(`ask <@U0OTHER99>${"y".repeat(900)}`), { userId: BOT }, CLOCK);
    expect(heard?.status === "ok" && heard.decision.reason.startsWith("ask @member")).toBe(true);
    expect(heard?.status === "ok" && [...heard.decision.reason].length).toBe(500);
  });

  it("refuses nothing typed, only spaces, or only invisible characters, and the box stays open with a fixed error", () => {
    for (const text of ["", "   \n ", "\u200b\u0007", null, undefined]) expect(changesSubmissionOf(submission(text), { userId: BOT }, CLOCK)).toEqual({ status: "empty" });
    expect(changesSubmissionOf({ ...submission("x"), view: { id: "V1", callback_id: "rovara_changes", private_metadata: JSON.stringify(context), state: { values: {} } } }, { userId: BOT }, CLOCK)).toEqual({ status: "empty" });
  });

  it("refuses a box sent by a person other than the one who opened it, from another workspace, or whose record does not read, and ignores a box that is not Rovara's", () => {
    const logs: Array<Record<string, unknown>> = [];
    expect(changesSubmissionOf(submission("x", { user: { id: "U0SOMEONE", team_id: TEAM } }), { userId: BOT }, CLOCK, (entry) => logs.push(entry))).toEqual({ status: "refused" });
    expect(changesSubmissionOf(submission("x", { user: { id: PERSON, team_id: "T0GUESTTT" } }), { userId: BOT }, CLOCK)).toEqual({ status: "refused" });
    expect(changesSubmissionOf(submission("x", { user: { id: PERSON } }), { userId: BOT }, CLOCK)).toEqual({ status: "refused" });
    expect(changesSubmissionOf(submission("x", {}, { ...context, d: "short" }), { userId: BOT }, CLOCK)).toEqual({ status: "refused" });
    expect(changesSubmissionOf(submission("x", {}, "{not json"), { userId: BOT }, CLOCK)).toEqual({ status: "refused" });
    expect(logs).toEqual([{ event: "slack.changes_box_other_person" }]);
    const other = submission("x");
    other.view.callback_id = "someone_elses";
    expect(changesSubmissionOf(other, { userId: BOT }, CLOCK)).toBeUndefined();
    expect(changesSubmissionOf({ type: "block_actions" }, { userId: BOT }, CLOCK)).toBeUndefined();
  });

  const listen = async () => {
    const sockets: FakeSocket[] = [];
    const decisions: ChannelDecision[] = [];
    const slack = fakeSlack();
    const adapter = new SlackChannel({ projects: ["web"], botToken: reader(BOT_TOKEN), appToken: reader(APP_TOKEN), fetch: slack.fetch, now: CLOCK, socket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; }, sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); } });
    const listening = await adapter.start({ message: async () => undefined, decision: async (decision) => { decisions.push(decision); } });
    await until(() => sockets.length === 1);
    return { sockets, decisions, slack, listening };
  };

  it("opens the box with the press's own trigger, decides nothing yet, then sends the typed words as the decision", async () => {
    const { sockets, decisions, slack, listening } = await listen();
    sockets[0]!.hear({ type: "interactive", envelope_id: "e1", payload: press() });
    await until(() => slack.calls.some((call) => call.method === "views.open"));
    const opened = JSON.parse(slack.calls.find((call) => call.method === "views.open")!.body) as { trigger_id: string; view: { callback_id: string; private_metadata: string } };
    expect(opened.trigger_id).toBe("1337.42.abcdef");
    expect(opened.view.callback_id).toBe("rovara_changes");
    expect(JSON.parse(opened.view.private_metadata)).toEqual(context);
    expect(decisions).toEqual([]);
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ envelope_id: "e1" })]);
    sockets[0]!.hear({ type: "interactive", envelope_id: "e2", payload: submission("Use the retry helper.") });
    await until(() => decisions.length === 1);
    expect(decisions[0]).toMatchObject({ decision: "REQUEST_CHANGES", reason: "Use the retry helper." });
    expect(sockets[0]!.sent[1]).toBe(JSON.stringify({ envelope_id: "e2" }));
    await listening.stop();
  });

  it("answers an empty box with an error on its field and sends no decision, and closes a box from another person with no decision", async () => {
    const { sockets, decisions, listening } = await listen();
    sockets[0]!.hear({ type: "interactive", envelope_id: "e1", payload: submission("   ") });
    sockets[0]!.hear({ type: "interactive", envelope_id: "e2", payload: submission("x", { user: { id: "U0SOMEONE", team_id: TEAM } }) });
    sockets[0]!.hear({ type: "interactive", envelope_id: "e3", payload: submission("Fine.") });
    await until(() => decisions.length === 1);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({ envelope_id: "e1", payload: { response_action: "errors", errors: { rovara_changes_reason: "Say what should change." } } });
    expect(JSON.parse(sockets[0]!.sent[1]!)).toEqual({ envelope_id: "e2", payload: { response_action: "clear" } });
    expect(JSON.parse(sockets[0]!.sent[2]!)).toEqual({ envelope_id: "e3" });
    expect(decisions.map((decision) => decision.reason)).toEqual(["Fine."]);
    await listening.stop();
  });
});
