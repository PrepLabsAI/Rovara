// Sign in with ChatGPT from Slack (#340). `@Rovara connect chatgpt` answers only its sender with a
// Sign in with ChatGPT link and a Paste the address button. OpenAI allows only a local callback, so
// the browser ends on an error page whose address carries the code; the person pastes it into a
// Slack form, and the control plane finishes the connection (#338). `chatgpt status` and
// `disconnect chatgpt` answer the same way. The Slack user is their Slack-derived developer, as for
// a task started in Slack.
import {
  AgentXError, CHATGPT_CALLBACK_URL, CHATGPT_CONNECT_STATE_SECONDS, ChatGptConnectionViewSchema, SlackMessageTimestampSchema,
  SlackChannelIdSchema, SlackTeamIdSchema, SlackUserIdSchema, agentXError, type ChatGptConnectionView,
} from "@agentx/contracts";
import type { ChatGptConnections } from "../chatgpt/connections.js";
import { parseChatGptCallback } from "../chatgpt/oauth.js";
import { developerIdForSlackUser } from "./admin-actions.js";

export type ChatGptSlackCommand = "connect" | "status" | "disconnect";

/** The three ChatGPT commands, typed after the mention; anything else is an ordinary request. */
export function chatGptSlackCommand(text: string): ChatGptSlackCommand | undefined {
  const words = text.trim().toLowerCase().replace(/\s+/gu, " ").replace(/[.!]+$/u, "");
  if (/^(?:connect|link) (?:my )?chatgpt$/u.test(words)) return "connect";
  if (/^(?:disconnect|unlink) (?:my )?chatgpt$/u.test(words)) return "disconnect";
  if (/^chatgpt status$/u.test(words)) return "status";
  return undefined;
}

/** The Sign in with ChatGPT link button: a link, so its press needs nothing but an answer. */
export const CHATGPT_OPEN_ACTION = "rovara_chatgpt_open";
/** Opens the form the address is pasted into; its value is the thread to answer in. */
export const CHATGPT_PASTE_ACTION = "rovara_chatgpt_paste";
export const CHATGPT_PASTE_SUBMISSION = "rovara_chatgpt_paste_submission";
const PASTE_BLOCK = "chatgpt_callback";
const PASTE_INPUT = "address";

// ---- The broker's side: the ingress Lambda holds no table or key, so it asks the broker. ----

export interface SlackChatGptCommandEvent { source: "agentx.slack-ingress"; action: "chatgpt-command"; command: ChatGptSlackCommand; teamId: string; userId: string }
export interface SlackChatGptFinishEvent { source: "agentx.slack-ingress"; action: "chatgpt-finish"; teamId: string; userId: string; callbackUrl: string }

const directInvoke = (value: Record<string, unknown>) => value.source === "agentx.slack-ingress" && value.requestContext === undefined
  && SlackTeamIdSchema.safeParse(value.teamId).success && SlackUserIdSchema.safeParse(value.userId).success;

export function isSlackChatGptCommandEvent(event: unknown): event is SlackChatGptCommandEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.action === "chatgpt-command" && directInvoke(value) && (value.command === "connect" || value.command === "status" || value.command === "disconnect");
}

export function isSlackChatGptFinishEvent(event: unknown): event is SlackChatGptFinishEvent {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  return value.action === "chatgpt-finish" && directInvoke(value) && typeof value.callbackUrl === "string" && value.callbackUrl.length <= 4_096;
}

/**
 * The broker's answer to a ChatGPT command or finish from Slack. Only a member of this install's own
 * Slack workspace connects, as only they can sign in with Slack.
 */
export async function answerSlackChatGpt(
  deps: { chatgpt?: ChatGptConnections; slackTeamId?: string },
  event: SlackChatGptCommandEvent | SlackChatGptFinishEvent,
): Promise<unknown> {
  if (deps.chatgpt === undefined) throw agentXError("NOT_FOUND", "Sign in with ChatGPT is not set up in this deployment");
  if (deps.slackTeamId !== undefined && deps.slackTeamId !== event.teamId) throw agentXError("FORBIDDEN", "ChatGPT can be connected only from this Rovara's own Slack workspace");
  const developerId = developerIdForSlackUser(event.userId);
  if (event.action === "chatgpt-finish") return deps.chatgpt.finish(developerId, { callbackUrl: event.callbackUrl });
  if (event.command === "connect") return deps.chatgpt.start(developerId);
  if (event.command === "disconnect") return deps.chatgpt.disconnect(developerId);
  return deps.chatgpt.view(developerId);
}

// ---- The ingress's side: what the person sees. ----

export interface BrokerAnswer { statusCode?: number; body?: string }

/** A broker answer read as either its body or its refusal's message, which is written for the person. */
export function readBrokerAnswer(reply: BrokerAnswer): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(reply.body ?? "{}");
    if (parsed !== null && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch { /* an unreadable answer is a failure below */ }
  if (reply.statusCode === 200) return { ok: true, body };
  const error = body.error !== null && typeof body.error === "object" ? body.error as Record<string, unknown> : {};
  const code = typeof error.code === "string" ? error.code : "";
  // Messages for these codes are written for the person; anything else is a fault they cannot fix.
  if (["CONFIG_INVALID", "FORBIDDEN", "NOT_FOUND", "AUTH_REQUIRED"].includes(code) && typeof error.message === "string") return { ok: false, message: error.message };
  return { ok: false, message: "I couldn't reach Rovara's ChatGPT connections just now. Try again in a moment." };
}

export interface SlackReply { text: string; blocks?: Array<Record<string, unknown>> }

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const sentence = (text: string) => { const trimmed = text.trim(); return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`; };
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** What a connection looks like in Slack: the account, its state, and the models its plan offers. */
export function chatGptConnectionLine(view: ChatGptConnectionView, verb: "connected" | "status"): string {
  if (!view.connected) return "ChatGPT isn't connected. Mention me with `connect chatgpt` to connect your ChatGPT plan.";
  const account = view.email === undefined ? "" : ` (${escape(view.email)})`;
  const lines = [verb === "connected" ? `Connected your ChatGPT plan${account}.` : `Your ChatGPT plan${account} is connected.`];
  if (view.status === "revoked") lines.push("The connection no longer works: it was revoked at OpenAI, or expired. Mention me with `connect chatgpt` to connect again.");
  if (view.status === "limit-reached") lines.push("Your plan reached its usage limit; tasks use this Rovara's default model until it resets.");
  if (view.models !== undefined && view.models.length > 0) lines.push(`Models your plan offers: ${view.models.map(escape).join(", ")}.`);
  return lines.join("\n");
}

/** The answer to a ChatGPT command, shown only to the person who typed it. */
export function chatGptCommandReply(command: ChatGptSlackCommand, answer: ReturnType<typeof readBrokerAnswer>, threadTs: string): SlackReply {
  if (!answer.ok) return { text: escape(capital(sentence(answer.message))) };
  if (command === "disconnect") {
    return { text: "Disconnected ChatGPT. Your tasks use this Rovara's default model. You can also remove Rovara from your ChatGPT account's connected apps." };
  }
  if (command === "status") {
    const view = ChatGptConnectionViewSchema.safeParse(answer.body);
    return { text: view.success ? chatGptConnectionLine(view.data, "status") : "I couldn't read your ChatGPT connection. Try again in a moment." };
  }
  const authorizeUrl = answer.body.authorizeUrl;
  if (typeof authorizeUrl !== "string" || !authorizeUrl.startsWith("https://auth.openai.com/")) {
    return { text: "I couldn't start connecting ChatGPT. Try again in a moment." };
  }
  const minutes = Math.round(CHATGPT_CONNECT_STATE_SECONDS / 60);
  const text = [
    "*Connect your ChatGPT plan to Rovara*",
    "1. Press *Sign in with ChatGPT* and allow Rovara.",
    "2. Your browser then shows an error such as _can't connect to 127.0.0.1_. That is expected: OpenAI sends the sign-in to your own computer.",
    "3. Copy the whole address from the browser's address bar, press *Paste the address*, and paste it.",
    `The link works for ${minutes} minutes, and only for you.`,
  ].join("\n");
  return {
    text: "Connect your ChatGPT plan to Rovara: press Sign in with ChatGPT, then paste the address your browser ends on.",
    blocks: [
      section(text),
      { type: "actions", elements: [
        { type: "button", action_id: CHATGPT_OPEN_ACTION, text: { type: "plain_text", text: "Sign in with ChatGPT" }, url: authorizeUrl, style: "primary" },
        { type: "button", action_id: CHATGPT_PASTE_ACTION, text: { type: "plain_text", text: "Paste the address" }, value: threadTs },
      ] },
    ],
  };
}

interface PasteMetadata { channel: string; threadTs: string }

/** The form the address is pasted into. The thread to answer in rides along in private_metadata. */
export function chatGptPasteModal(metadata: PasteMetadata): Record<string, unknown> {
  return {
    type: "modal", callback_id: CHATGPT_PASTE_SUBMISSION, private_metadata: JSON.stringify(metadata),
    title: { type: "plain_text", text: "Connect ChatGPT" }, submit: { type: "plain_text", text: "Connect" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: PASTE_BLOCK, label: { type: "plain_text", text: "The address your browser ended on" },
        hint: { type: "plain_text", text: `It starts with ${CHATGPT_CALLBACK_URL}` },
        element: { type: "plain_text_input", action_id: PASTE_INPUT, multiline: true, max_length: 3_000, placeholder: { type: "plain_text", text: `${CHATGPT_CALLBACK_URL}?code=…` } } },
    ],
  };
}

/** The form after it is sent: first while the connection finishes, then with how it went. */
export function chatGptResultView(text: string): Record<string, unknown> {
  return { type: "modal", title: { type: "plain_text", text: "Connect ChatGPT" }, close: { type: "plain_text", text: "Done" }, blocks: [section(text)] };
}
export const CHATGPT_CONNECTING_TEXT = "Connecting your ChatGPT plan… This takes a few seconds; I'll show the result here and in the thread.";

/** Finishing runs after Slack's three-second wait, in an asynchronous invoke of the ingress Lambda. */
export interface HandedOffChatGptFinish extends PasteMetadata {
  source: "agentx.slack-interactivity";
  action: "chatgpt-finish";
  teamId: string;
  userId: string;
  callbackUrl: string;
  viewId: string;
}

export function isHandedOffChatGptFinish(event: unknown): event is HandedOffChatGptFinish {
  if (!event || typeof event !== "object") return false;
  const value = event as Record<string, unknown>;
  // Never an HTTP request: API Gateway's events always carry a requestContext.
  return value.source === "agentx.slack-interactivity" && value.action === "chatgpt-finish" && value.requestContext === undefined
    && SlackTeamIdSchema.safeParse(value.teamId).success && SlackUserIdSchema.safeParse(value.userId).success
    && SlackChannelIdSchema.safeParse(value.channel).success && SlackMessageTimestampSchema.safeParse(value.threadTs).success
    && typeof value.callbackUrl === "string" && value.callbackUrl.length <= 4_096 && typeof value.viewId === "string" && /^V[A-Z0-9]{1,30}$/u.test(value.viewId);
}

export interface ChatGptSubmissionDependencies {
  handOff: (event: HandedOffChatGptFinish) => Promise<void>;
}

/**
 * A pasted address. What the form can tell at once (not an address, not the callback, a declined
 * consent, no code) is shown on the input, without echoing it; the rest is handed off. Only a member
 * of the workspace the form was opened in may send it.
 */
export async function chatGptSubmission(deps: ChatGptSubmissionDependencies, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const view = record(payload.view);
  const user = record(payload.user);
  const team = SlackTeamIdSchema.safeParse(record(payload.team).id);
  const userId = SlackUserIdSchema.safeParse(user.id);
  const userTeam = SlackTeamIdSchema.safeParse(user.team_id);
  let metadata: PasteMetadata | undefined;
  try {
    const parsed = record(JSON.parse(typeof view.private_metadata === "string" ? view.private_metadata : ""));
    const channel = SlackChannelIdSchema.safeParse(parsed.channel);
    const threadTs = SlackMessageTimestampSchema.safeParse(parsed.threadTs);
    if (channel.success && threadTs.success) metadata = { channel: channel.data, threadTs: threadTs.data };
  } catch { /* refused below */ }
  const fail = (message: string) => ({ response_action: "errors", errors: { [PASTE_BLOCK]: message } });
  if (!team.success || !userId.success || !userTeam.success || userTeam.data !== team.data || metadata === undefined || typeof view.id !== "string") {
    return fail("ChatGPT can be connected only by a member of this Slack workspace.");
  }
  const pasted = record(record(record(view.state).values)[PASTE_BLOCK])[PASTE_INPUT];
  const value = record(pasted).value;
  const callbackUrl = typeof value === "string" ? value.trim() : "";
  try {
    parseChatGptCallback(callbackUrl);
  } catch (error) {
    return fail(error instanceof AgentXError ? capital(sentence(error.message.slice(error.code.length + 2))) : "That is not the address the browser ended on.");
  }
  try {
    await deps.handOff({ source: "agentx.slack-interactivity", action: "chatgpt-finish", teamId: team.data, userId: userId.data, callbackUrl, viewId: view.id, ...metadata });
  } catch {
    return fail("I couldn't take the address just now. Press Connect again.");
  }
  return { response_action: "update", view: chatGptResultView(CHATGPT_CONNECTING_TEXT) };
}

export interface HandedOffChatGptFinishDependencies {
  finish: (input: { teamId: string; userId: string; callbackUrl: string }) => Promise<BrokerAnswer>;
  updateView: (viewId: string, view: Record<string, unknown>) => Promise<void>;
  postEphemeral: (input: { channel: string; threadTs: string; user: string; text: string }) => Promise<void>;
  log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void;
}

/** Finishes a handed-off connection, then says how it went in the form and, privately, in the thread. */
export async function runHandedOffChatGptFinish(deps: HandedOffChatGptFinishDependencies, event: HandedOffChatGptFinish): Promise<"connected" | "refused"> {
  let answer: ReturnType<typeof readBrokerAnswer>;
  try {
    answer = readBrokerAnswer(await deps.finish({ teamId: event.teamId, userId: event.userId, callbackUrl: event.callbackUrl }));
  } catch {
    answer = { ok: false, message: "I couldn't finish connecting ChatGPT. Mention me with `connect chatgpt` to try again." };
  }
  const view = answer.ok ? ChatGptConnectionViewSchema.safeParse(answer.body) : undefined;
  const text = answer.ok
    ? view?.success === true && view.data.connected ? chatGptConnectionLine(view.data, "connected") : "I couldn't read the new connection. Mention me with `chatgpt status` to check it."
    : escape(capital(sentence(answer.message)));
  // Never the address or anything from it.
  deps.log?.("chatgpt.finish", { outcome: answer.ok ? "connected" : "refused" });
  // The form may be closed by now; the thread keeps the answer either way.
  await deps.updateView(event.viewId, chatGptResultView(text)).catch(() => undefined);
  await deps.postEphemeral({ channel: event.channel, threadTs: event.threadTs, user: event.userId, text }).catch(() => undefined);
  return answer.ok ? "connected" : "refused";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
