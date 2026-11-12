// The channel suite's world for the real Slack adapter (`SlackChannel`, owner decision 58). The adapter is the shipped code: its web client, its rendering, its socket and what it hears. Only the network is fake: a `fetch` that
// answers the way the chat tool's web API does (and keeps what it was sent), and a socket the "tool" pushes envelopes into. Every token is built at run time (the repository is public; push protection refuses key-shaped text).
import { SlackChannel, type SocketLike } from "@agentx/broker/channel-slack-adapter";
import type { ActorRef, ChannelAdapter, ChannelDecision, ConversationRef } from "@agentx/contracts";
import { until, type ChannelPerson, type ChannelWorld, type ShownButton, type ShownMessage, type ShownRequest } from "./channel-conformance.js";

const WSS = "wss://wss-primary.slack.com/link/?ticket=conformance";

export interface SlackWorldOptions {
  /** The workspace the bot belongs to (its team id). Default `T0AAAAAAA`. */
  tenant?: string;
  /** The raw ids the conversation and the speaker use: two worlds may share them. */
  space?: string;
  thread?: string;
  userId?: string;
  botUserId?: string;
  /** Distinguishes this world's tokens from another's. Letters and digits only. */
  tokenTag?: string;
  /** Where the adapter reads its tokens from (a company's secret store). Default: the world's own. */
  botToken?: () => Promise<string>;
  appToken?: () => Promise<string>;
  projects?: readonly string[];
  /** Puts something around the adapter under test (a test breaks it on purpose this way). Default: the adapter itself. */
  wrap?: (adapter: SlackChannel) => ChannelAdapter;
}

interface Call { method: string; authorization: string | null; body: Record<string, unknown>; ok: boolean }

/** A socket the test drives: it is told what the tool sends, and records what the adapter sends back. */
class DrivenSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.closed = true; queueMicrotask(() => this.onclose?.()); }
  hear(envelope: unknown): void { if (!this.closed) this.onmessage?.({ data: JSON.stringify(envelope) }); }
}

/** A bot token and an app-level token of the shapes the web client accepts, built from parts. */
export const slackTokens = (tag = "conformance"): { bot: string; app: string } => ({
  bot: ["xoxb", "1111111111", "2222222222", `${tag}abcdefghijklmnop`].join("-"),
  app: ["xapp", "1", "A0123456789", "3333333333", `${tag}abcdefghijklmnopqrstuvwx`].join("-"),
});

let serial = 0;
const stamp = (): string => { serial += 1; return `17000${String(serial).padStart(5, "0")}.${String(serial).padStart(6, "0")}`; };

export function slackChannelWorld(options: SlackWorldOptions = {}): ChannelWorld {
  const tenant = options.tenant ?? "T0AAAAAAA";
  const bot = options.botUserId ?? "U0BOTBOT1";
  const tokens = slackTokens(options.tokenTag);
  const conversation: ConversationRef = { channel: "slack", tenant, space: options.space ?? "C0ROOM001", thread: options.thread ?? "1700000000.000001" };
  const actor: ActorRef = { channel: "slack", tenant, userId: options.userId ?? "U0PERSON1" };
  const calls: Call[] = [];
  const logs: string[] = [];
  const sockets: DrivenSocket[] = [];
  let failing = false;

  const network: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = url.pathname.replace("/api/", "");
    const text = typeof init?.body === "string" ? init.body : "";
    const body = text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : Object.fromEntries(new URLSearchParams(text));
    const authorization = new Headers(init?.headers).get("authorization");
    const posts = method === "chat.postMessage" || method === "chat.postEphemeral";
    const refused = posts && failing;
    if (refused) failing = false;
    calls.push({ method, authorization, body, ok: !refused });
    if (refused) return Response.json({ ok: false, error: "internal_error" });
    if (method === "auth.test") return Response.json({ ok: true, team_id: tenant, user_id: bot });
    if (method === "chat.postMessage") return Response.json({ ok: true, ts: stamp() });
    if (method === "apps.connections.open") return Response.json({ ok: true, url: WSS });
    return Response.json({ ok: true });
  };

  const real = new SlackChannel({
    projects: [...(options.projects ?? ["web"])],
    botToken: options.botToken ?? (async () => tokens.bot),
    appToken: options.appToken ?? (async () => tokens.app),
    fetch: network,
    socket: () => { const socket = new DrivenSocket(); sockets.push(socket); return socket; },
    now: () => new Date("2026-11-10T10:00:00.000Z"),
    log: (entry) => { logs.push(JSON.stringify(entry)); },
    sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); },
  });

  const adapter: ChannelAdapter = options.wrap === undefined ? real : options.wrap(real);

  const buttonsOf = (blocks: unknown): ShownButton[] => {
    if (!Array.isArray(blocks)) return [];
    const found: ShownButton[] = [];
    for (const block of blocks as Array<{ type?: string; elements?: Array<{ action_id?: string; value?: string; url?: string; text?: { text?: string } }> }>) {
      if (block.type !== "actions") continue;
      for (const element of block.elements ?? []) {
        const label = element.text?.text ?? "";
        if (element.action_id?.startsWith("rovara_decide_") === true && element.value !== undefined) {
          const value = JSON.parse(element.value) as { r: string; v: number; d: string; o: ChannelDecision["decision"] };
          found.push({ label, decision: value.o, request: { requestId: value.r, expectedRevision: value.v, artifactDigest: value.d } });
        } else if (element.url !== undefined) found.push({ label, opens: element.url });
      }
    }
    return found;
  };

  const shown = (): ShownMessage[] => calls.filter((call) => call.ok && (call.method === "chat.postMessage" || call.method === "chat.postEphemeral")).map((call) => ({
    space: String(call.body["channel"]),
    ...(typeof call.body["thread_ts"] === "string" ? { thread: call.body["thread_ts"] } : {}),
    text: String(call.body["text"]),
    ...(call.method === "chat.postEphemeral" ? { onlyTo: String(call.body["user"]) } : {}),
    buttons: buttonsOf(call.body["blocks"]),
  }));

  /** The latest connection, once there is one; undefined when the latest is closed (the tool cannot reach a stopped adapter). */
  const live = async (): Promise<DrivenSocket | undefined> => {
    for (let attempt = 0; attempt < 200 && sockets.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const latest = sockets.at(-1);
    return latest === undefined || latest.closed ? undefined : latest;
  };
  let envelopes = 0;
  const push = async (type: "events_api" | "interactive", payload: unknown): Promise<void> => {
    envelopes += 1;
    (await live())?.hear({ type, envelope_id: `env-${String(envelopes)}`, payload });
  };
  const speak = (type: string, text: string, extra: Record<string, unknown> = {}) => push("events_api", {
    team_id: tenant, event_id: `Ev${String(envelopes + 1).padStart(6, "0")}`,
    event: { type, user: actor.userId, text, ts: stamp(), channel: conversation.space, user_team: tenant, ...extra },
  });

  /** The value a card's button carries, as the tool sends it back on a press. */
  const buttonValue = (decision: ChannelDecision["decision"], request?: ShownRequest): string => {
    if (request !== undefined) return JSON.stringify({ r: request.requestId, v: request.expectedRevision, d: request.artifactDigest, o: decision });
    for (const message of [...shown()].reverse()) {
      const button = message.buttons.find((entry) => entry.decision === decision);
      if (button?.request !== undefined) return JSON.stringify({ r: button.request.requestId, v: button.request.expectedRevision, d: button.request.artifactDigest, o: decision });
    }
    throw new Error(`no card with a ${decision} button has been shown`);
  };
  const press = (decision: ChannelDecision["decision"], request?: ShownRequest): Promise<void> => push("interactive", {
    type: "block_actions", trigger_id: `trigger.${String(envelopes + 1)}.conformance`, user: { id: actor.userId, team_id: tenant }, team: { id: tenant }, channel: { id: conversation.space },
    message: { ts: stamp(), thread_ts: conversation.thread }, actions: [{ action_id: `rovara_decide_${decision}`, value: buttonValue(decision, request) }],
  });

  const person: ChannelPerson = {
    listening: () => sockets.length > 0 && sockets.at(-1)!.closed === false,
    say: (text) => speak("app_mention", `<@${bot}> ${text}`),
    // Another event type, which the adapter does not read at all, and a mention made by another app, which it does not take for a person's.
    saysUnaddressed: async (text) => { await speak("message", text); await speak("app_mention", `<@${bot}> ${text}`, { bot_id: "B0OTHERAPP" }); },
    async press(decision, request) {
      if (decision === "REQUEST_CHANGES") throw new Error("Request changes is asked for in a box: use requestChanges");
      await press(decision, request);
    },
    async requestChanges(reason) {
      const opened = calls.length;
      await press("REQUEST_CHANGES");
      await until(() => calls.slice(opened).some((call) => call.method === "views.open"), "the box was opened");
      const view = calls.slice(opened).find((call) => call.method === "views.open")!.body["view"] as { callback_id: string; private_metadata: string; blocks: Array<{ block_id: string; element: { action_id: string } }> };
      const input = view.blocks[0]!;
      await push("interactive", {
        type: "view_submission", user: { id: actor.userId, team_id: tenant },
        view: { id: `V${String(envelopes + 1)}`, callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: { [input.block_id]: { [input.element.action_id]: { value: reason } } } } },
      });
    },
  };

  return {
    adapter, channel: "slack", conversation, actor, person, markup: "<!channel>",
    foreignConversation: { ...conversation, tenant: "T0FOREIGN" },
    shown: async () => shown(),
    promises: { otherChannel: true, cutsLongText: true, privateNotes: true },
    failNextSend: () => { failing = true; },
    secrets: [tokens.bot, tokens.app],
    logs: () => logs,
    seenCredentials: () => calls.flatMap((call) => (call.authorization === null ? [] : [call.authorization])),
  };
}
