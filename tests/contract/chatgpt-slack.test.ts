// Sign in with ChatGPT from Slack (#340): the mention, the private answer, the paste form, and the
// finish, through the real ingress, interactivity and broker handlers over the real connection store.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHATGPT_CALLBACK_URL } from "@agentx/contracts";
import { chatGptConnections, type ChatGptSealer } from "../../packages/broker/src/chatgpt/connections.js";
import { CHATGPT_TOKEN_URL } from "../../packages/broker/src/chatgpt/oauth.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import {
  CHATGPT_CONNECTING_TEXT, CHATGPT_OPEN_ACTION, CHATGPT_PASTE_ACTION, CHATGPT_PASTE_SUBMISSION, answerSlackChatGpt, chatGptSlackCommand,
  chatGptSubmission, isHandedOffChatGptFinish, runHandedOffChatGptFinish, type HandedOffChatGptFinish,
} from "../../packages/broker/src/aws/slack-chatgpt.js";
import { createSlackIngressHandler } from "../../packages/broker/src/aws/slack-ingress.js";
import { chatGptActionHandler, createSlackInteractivityHandler } from "../../packages/broker/src/aws/slack-interactivity.js";
import { createAdminBroker } from "../support/admin-broker.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";
const team = "T0BSHLLUGBD";
const channel = "C0123456789";
const bot = "U0BOT000001";
const maya = "U0123456789";
const sam = "U0456789012";
const nowSeconds = 1_758_657_600;
const threadTs = "1695500000.000001";

const SEALER: ChatGptSealer = {
  seal: async (plaintext, context) => `sealed:${context.developerId}:${context.field}:${Buffer.from(plaintext).toString("base64")}`,
  open: async (sealed, context) => {
    const [, developerId, field, body] = sealed.split(":");
    if (developerId !== context.developerId || field !== context.field) throw new Error("wrong encryption context");
    return Buffer.from(body ?? "", "base64").toString("utf8");
  },
};

/** OpenAI's token endpoint and model list: any code is exchanged, as OpenAI would for a real one. */
const openAi = (async (url: string | URL) => {
  if (String(url) === CHATGPT_TOKEN_URL) {
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "maya@acme.com" })).toString("base64url")}.y`;
    return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, id_token: idToken, scope: "openid chatgpt.tokens.use.direct" });
  }
  if (String(url) === "https://api.openai.com/v1/models") return Response.json({ models: [{ slug: "gpt-6.1-sol" }, { slug: "gpt-5.5" }] });
  return new Response("not found", { status: 404 });
}) as typeof fetch;

function signedEvent(payload: unknown) {
  const body = JSON.stringify(payload);
  const timestamp = String(nowSeconds);
  return {
    version: "2.0", rawPath: "/v1/slack/events", isBase64Encoded: false, body,
    headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}` },
    requestContext: { requestId: "request", http: { method: "POST" } },
  };
}

function signedInteraction(payload: unknown) {
  const raw = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const timestamp = String(nowSeconds);
  return { rawPath: "/v1/slack/interactions", body: raw, headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${raw}`).digest("hex")}` } };
}

const mention = (text: string, options: { user?: string; eventId?: string } = {}) => ({
  type: "event_callback", team_id: team, event_id: options.eventId ?? `Ev${Math.random().toString(36).slice(2, 12)}`,
  authorizations: [{ team_id: team, user_id: bot, is_bot: true }],
  event: { type: "app_mention", user: options.user ?? maya, team, channel, ts: threadTs, text: `<@${bot}> ${text}` },
});

async function rovara(options: { chatgpt?: boolean } = {}) {
  let clock = nowSeconds * 1000;
  const { handler: broker, db } = await createAdminBroker({
    ...(options.chatgpt === false ? {} : {
      chatgpt: (table) => chatGptConnections({ documentClient: table, tableName: "state", sealer: SEALER, fetch: openAi, now: () => clock, hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" }),
    }),
  });
  const invokeBroker = async (event: Record<string, unknown>) => broker(event);
  const slack = new StrictSlackWeb();
  const queued: unknown[] = [];
  const ingress = createSlackIngressHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    getBinding: async (teamId, channelId) => ({ teamId, channelId, projectName: "payments", updatedAt: "2026-09-23T21:00:00.000Z" }),
    claimEvent: async () => true,
    releaseEvent: async () => undefined,
    changePending: async () => 1,
    enqueue: async (message) => { queued.push(message); },
    postMessage: async (input) => { await slack.postMessage(input); },
    postEphemeral: async (input) => { slack.postEphemeral(input); },
    chatgpt: (input) => invokeBroker({ source: "agentx.slack-ingress", action: "chatgpt-command", ...input }),
    now: () => nowSeconds * 1000,
  });
  const handedOff: HandedOffChatGptFinish[] = [];
  const responses: Array<{ url: string; text: string }> = [];
  const interactivity = createSlackInteractivityHandler({
    secrets: async () => ({ signingSecret, botToken: "xoxb-test" }),
    handlers: [chatGptActionHandler({ openView: (triggerId, view) => slack.openView(triggerId, view), respondEphemeral: async (url, text) => { responses.push({ url, text }); } })],
    respondEphemeral: async (url, text) => { responses.push({ url, text }); },
    chatgptSubmission: (payload) => chatGptSubmission({ handOff: async (event) => { handedOff.push(event); } }, payload),
    now: () => nowSeconds * 1000,
  });
  const views: Array<{ viewId: string; view: Record<string, unknown> }> = [];
  /** The asynchronous invoke the submission handed off, as the ingress Lambda runs it. */
  const finishHandedOff = async () => {
    const event = handedOff.shift();
    if (event === undefined) throw new Error("nothing was handed off");
    expect(isHandedOffChatGptFinish(JSON.parse(JSON.stringify(event)))).toBe(true);
    return runHandedOffChatGptFinish({
      finish: (input) => invokeBroker({ source: "agentx.slack-ingress", action: "chatgpt-finish", ...input }),
      updateView: async (viewId, view) => { views.push({ viewId, view }); },
      postEphemeral: async (input) => { slack.postEphemeral(input); },
    }, event);
  };
  const say = async (text: string, user = maya) => {
    const before = slack.ephemerals.length;
    expect((await ingress(signedEvent(mention(text, { user })))).statusCode).toBe(200);
    return slack.ephemerals.slice(before);
  };
  const press = async (user: string, options: { userTeam?: string } = {}) => interactivity(signedInteraction({
    type: "block_actions", team: { id: team }, user: { id: user, team_id: options.userTeam ?? team },
    // An ephemeral answer: Slack sends no message, and the container's timestamp is the answer's own.
    container: { type: "message", message_ts: "1695500002.000009", channel_id: channel, is_ephemeral: true },
    response_url: "https://hooks.slack.com/actions/T0BSHLLUGBD/1/abc", trigger_id: "1.2.3",
    actions: [{ action_id: CHATGPT_PASTE_ACTION, value: threadTs, block_id: "b" }],
  }));
  const submit = async (user: string, address: string, options: { privateMetadata?: string; userTeam?: string } = {}) => {
    const response = await interactivity(signedInteraction({
      type: "view_submission", team: { id: team }, user: { id: user, team_id: options.userTeam ?? team },
      view: { id: "V0FORM0001", callback_id: CHATGPT_PASTE_SUBMISSION, private_metadata: options.privateMetadata ?? JSON.stringify({ channel, threadTs }),
        state: { values: { chatgpt_callback: { address: { type: "plain_text_input", value: address } } } } },
    }));
    return JSON.parse(response.body) as Record<string, unknown>;
  };
  return { db, slack, queued, say, press, submit, handedOff, finishHandedOff, views, responses, advance: (ms: number) => { clock += ms; } };
}

const linkOf = (blocks: unknown) => {
  const actions = (blocks as Array<{ type: string; elements?: Array<{ action_id: string; url?: string; value?: string }> }>).find((block) => block.type === "actions");
  return {
    url: actions?.elements?.find((element) => element.action_id === CHATGPT_OPEN_ACTION)?.url ?? "",
    pasteValue: actions?.elements?.find((element) => element.action_id === CHATGPT_PASTE_ACTION)?.value,
  };
};
const callbackFor = (authorizeUrl: string, extra = "") => `${CHATGPT_CALLBACK_URL}?code=the-code&scope=x&state=${new URL(authorizeUrl).searchParams.get("state") ?? ""}&client_id=oaiapp_issued${extra}`;

describe("the ChatGPT commands in Slack (#340)", () => {
  it("reads only the three commands, loosely typed", () => {
    expect(chatGptSlackCommand("connect chatgpt")).toBe("connect");
    expect(chatGptSlackCommand("  Connect   ChatGPT. ")).toBe("connect");
    expect(chatGptSlackCommand("link my chatgpt")).toBe("connect");
    expect(chatGptSlackCommand("disconnect chatgpt")).toBe("disconnect");
    expect(chatGptSlackCommand("chatgpt status")).toBe("status");
    expect(chatGptSlackCommand("connect chatgpt to the billing page")).toBeUndefined();
    expect(chatGptSlackCommand("what is chatgpt")).toBeUndefined();
  });

  it("connects end to end: a private link, the paste form, and the connection, without queuing anything", async () => {
    const h = await rovara();
    const [answer] = await h.say("connect chatgpt");
    expect(answer).toMatchObject({ channel, user: maya, threadTs });
    expect(answer?.blocks).toBeDefined();
    const { url, pasteValue } = linkOf(answer?.blocks);
    expect(new URL(url).origin).toBe("https://auth.openai.com");
    expect(new URL(url).searchParams.get("agent_name_hint")).toBe("Rovara");
    expect(pasteValue).toBe(threadTs);
    expect(JSON.stringify(answer?.blocks)).toContain("can't connect to 127.0.0.1");
    expect(h.queued).toEqual([]);
    expect(h.slack.posts).toEqual([]);

    // Paste the address: the form opens, carrying the thread (not the ephemeral answer's own timestamp).
    expect((await h.press(maya)).statusCode).toBe(200);
    const [form] = h.slack.views;
    expect(form?.view.callback_id).toBe(CHATGPT_PASTE_SUBMISSION);
    expect(JSON.parse(String(form?.view.private_metadata))).toEqual({ channel, threadTs });

    // Sending the form answers at once; the finish runs after Slack's three seconds.
    const sent = await h.submit(maya, callbackFor(url));
    expect(sent.response_action).toBe("update");
    expect(JSON.stringify(sent.view)).toContain(JSON.stringify(CHATGPT_CONNECTING_TEXT));
    expect(await h.finishHandedOff()).toBe("connected");
    const connected = "Connected your ChatGPT plan (maya@acme.com).\nModels your plan offers: gpt-6.1-sol, gpt-5.5.";
    expect(h.views.map(({ viewId }) => viewId)).toEqual(["V0FORM0001"]);
    expect(h.views[0]?.view.blocks).toEqual([{ type: "section", text: { type: "mrkdwn", text: connected } }]);
    expect(h.slack.ephemerals.at(-1)).toMatchObject({ channel, threadTs, user: maya, text: connected });
    expect(h.db.get(`CHATGPT#${developerIdForSlackUser(maya)}`, "CONNECTION")).toMatchObject({ status: "connected", email: "maya@acme.com" });

    expect((await h.say("chatgpt status"))[0]?.text).toBe("Your ChatGPT plan (maya@acme.com) is connected.\nModels your plan offers: gpt-6.1-sol, gpt-5.5.");
    expect((await h.say("disconnect chatgpt"))[0]?.text).toContain("Disconnected ChatGPT.");
    expect((await h.say("chatgpt status"))[0]?.text).toBe("ChatGPT isn't connected. Mention me with `connect chatgpt` to connect your ChatGPT plan.");
    expect(h.queued).toEqual([]);
  });

  it("refuses an address pasted by someone the sign-in was not started for, and the starter can still finish", async () => {
    const h = await rovara();
    const { url } = linkOf((await h.say("connect chatgpt"))[0]?.blocks);
    expect((await h.submit(sam, callbackFor(url))).response_action).toBe("update");
    expect(await h.finishHandedOff()).toBe("refused");
    expect(h.slack.ephemerals.at(-1)).toMatchObject({ user: sam, text: "This sign-in was not started by you, or a newer one replaced it; start connecting ChatGPT again." });
    expect(h.db.get(`CHATGPT#${developerIdForSlackUser(sam)}`, "CONNECTION")).toBeUndefined();
    await h.submit(maya, callbackFor(url));
    expect(await h.finishHandedOff()).toBe("connected");
  });

  it("refuses an address pasted after the sign-in expired", async () => {
    const h = await rovara();
    const { url } = linkOf((await h.say("connect chatgpt"))[0]?.blocks);
    h.advance(11 * 60 * 1000);
    await h.submit(maya, callbackFor(url));
    expect(await h.finishHandedOff()).toBe("refused");
    expect(h.slack.ephemerals.at(-1)?.text).toBe("This sign-in has expired; start connecting ChatGPT again.");
  });

  it("shows a declined consent, or an address that is not the callback, on the form at once, never echoing it", async () => {
    const h = await rovara();
    const { url } = linkOf((await h.say("connect chatgpt"))[0]?.blocks);
    const state = new URL(url).searchParams.get("state") ?? "";
    expect(await h.submit(maya, `${CHATGPT_CALLBACK_URL}?error=access_denied&state=${state}`)).toEqual({
      response_action: "errors", errors: { chatgpt_callback: "ChatGPT was not connected: the sign-in was declined on OpenAI's page." },
    });
    const elsewhere = await h.submit(maya, "https://evil.example/auth/callback?code=secret-looking&state=s&client_id=c");
    expect(elsewhere.response_action).toBe("errors");
    expect(JSON.stringify(elsewhere)).toContain("That is not the address the browser ended on");
    expect(JSON.stringify(elsewhere)).not.toContain("secret-looking");
    expect((await h.submit(maya, "just some words")).response_action).toBe("errors");
    expect(h.handedOff).toEqual([]);
  });

  it("opens the form, and takes it, only for a member of the thread's own workspace", async () => {
    const h = await rovara();
    const { url } = linkOf((await h.say("connect chatgpt"))[0]?.blocks);
    await h.press(sam, { userTeam: "T0OTHERORG1" });
    expect(h.slack.views).toEqual([]);
    expect(h.responses.at(-1)?.text).toBe("ChatGPT can be connected only by a member of this Slack workspace.");
    expect((await h.submit(sam, callbackFor(url), { userTeam: "T0OTHERORG1" })).response_action).toBe("errors");
    expect(h.handedOff).toEqual([]);
  });

  it("says so when this deployment has no Sign in with ChatGPT", async () => {
    const h = await rovara({ chatgpt: false });
    expect((await h.say("connect chatgpt"))[0]?.text).toBe("Sign in with ChatGPT is not set up in this deployment.");
    expect(h.queued).toEqual([]);
  });

  it("leaves anything else to the agent", async () => {
    const h = await rovara();
    expect(await h.say("connect chatgpt to the billing page")).toEqual([]);
    expect(h.queued).toHaveLength(1);
  });
});

describe("the broker's side of a Slack ChatGPT command (#340)", () => {
  it("connects only members of this Rovara's own Slack workspace", async () => {
    const connections = { start: async () => ({ authorizeUrl: "https://auth.openai.com/x", expiresAt: "z" }) } as never;
    await expect(answerSlackChatGpt({ chatgpt: connections, slackTeamId: team }, { source: "agentx.slack-ingress", action: "chatgpt-command", command: "connect", teamId: "T0OTHERORG1", userId: maya }))
      .rejects.toThrow("ChatGPT can be connected only from this Rovara's own Slack workspace");
    await expect(answerSlackChatGpt({ chatgpt: connections, slackTeamId: team }, { source: "agentx.slack-ingress", action: "chatgpt-command", command: "connect", teamId: team, userId: maya }))
      .resolves.toMatchObject({ authorizeUrl: "https://auth.openai.com/x" });
  });

  it("takes a hand-off only from a direct invoke, never from an HTTP request", () => {
    const event = { source: "agentx.slack-interactivity", action: "chatgpt-finish", teamId: team, userId: maya, callbackUrl: "x", viewId: "V0FORM0001", channel, threadTs };
    expect(isHandedOffChatGptFinish(event)).toBe(true);
    expect(isHandedOffChatGptFinish({ ...event, requestContext: {} })).toBe(false);
    expect(isHandedOffChatGptFinish({ ...event, viewId: "not a view" })).toBe(false);
  });
});
