// What the chat tool says to Rovara, turned into the neutral shapes the core takes (`InboundMessage`, `ChannelDecision`). Only two things are heard: a person mentioning the bot in a channel (a message) and a person pressing
// a button on a card Rovara posted (a decision). Nothing else is read, so a message that does not mention the bot is never seen. Who is speaking is the tool's claim: the sink checks it against the links the owner made.
import { ChannelDecisionSchema, InboundMessageSchema, type ChannelDecision, type InboundMessage } from "@agentx/contracts";
import { z } from "zod";
import { ACTION_PREFIX, CHANGES_CALLBACK, CHANGES_FIELD, CHANGES_INPUT, NO_THREAD, type ButtonValue, type ChangesContext } from "./format.js";

const ButtonValueSchema = z.object({ r: z.string().uuid(), v: z.number().int().positive(), d: z.string().regex(/^[a-f0-9]{64}$/u), o: z.enum(["APPROVE", "REQUEST_CHANGES", "REJECT", "SKIP"]) }).strict();
const Id = z.string().min(1).max(64);
const Ts = z.string().regex(/^\d{10}\.\d{6}$/u);

const MentionEventSchema = z.object({
  type: z.literal("app_mention"), user: Id, text: z.string().max(40_000), ts: Ts, channel: Id, thread_ts: Ts.optional(), team: Id.optional(), user_team: Id.optional(),
}).passthrough().refine((event) => event["bot_id"] === undefined && event["subtype"] === undefined, "a person's own mention");
const EventsPayloadSchema = z.object({ team_id: Id, event_id: Id, event: z.object({ type: z.string() }).passthrough() }).passthrough();

const ActionPayloadSchema = z.object({
  type: z.literal("block_actions"), trigger_id: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
  user: z.object({ id: Id, team_id: Id.optional() }).passthrough(), team: z.object({ id: Id }).passthrough(), channel: z.object({ id: Id }).passthrough(),
  message: z.object({ ts: Ts, thread_ts: Ts.optional() }).passthrough(),
  actions: z.array(z.object({ action_id: z.string().max(100), value: z.string().max(2_000).optional() }).passthrough()).min(1).max(5),
}).passthrough();

const MENTION = /<@[UW][A-Z0-9]{2,31}(?:\|[^>]{0,80})?>/gu;

/** The text the person wrote, with the tool's escapes undone and every mention of a person replaced by a neutral word (no account id is kept). The bot's own mention is dropped. */
export function textOf(raw: string, botUserId: string): string {
  const withoutBot = raw.replace(new RegExp(`<@${botUserId}(?:\\|[^>]{0,80})?>`, "gu"), "");
  return withoutBot.replace(MENTION, "@member").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&amp;/gu, "&").trim();
}

/** The most a person's words for a change may hold (the decision's own limit). */
export const CHANGE_REASON_MAX = 500;

/** What a person typed in a box, the same way other chat text is made safe: the tool's escapes undone, every mention of a person a neutral word, control characters gone, one space between words, and cut to `max` characters. */
export function cleanChatText(raw: string, botUserId: string, max: number): string {
  const flat = textOf(raw, botUserId).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/gu, " ").trim();
  return [...flat].slice(0, max).join("").trim();
}

/** A mention of the bot in a channel, as a message. Undefined for anything else, for the bot's own and other bots' messages, and for an empty one. */
export function messageOf(payload: unknown, bot: { userId: string }, now: () => Date, log: (entry: Record<string, unknown>) => void = () => undefined): InboundMessage | undefined {
  const envelope = EventsPayloadSchema.safeParse(payload);
  if (!envelope.success) return undefined;
  const event = MentionEventSchema.safeParse(envelope.data.event);
  if (!event.success || event.data.user === bot.userId) return undefined;
  // The speaker's own workspace must be named: a field that is missing is not a reason to take the speaker for a member of the app's workspace (a guest from a shared channel may come without it).
  if (event.data.user_team === undefined) { log({ event: "slack.speaker_workspace_unknown" }); return undefined; }
  const text = textOf(event.data.text, bot.userId);
  if (text === "") return undefined;
  const parsed = InboundMessageSchema.safeParse({
    version: 2, channel: "slack", eventId: envelope.data.event_id,
    conversation: { channel: "slack", tenant: envelope.data.team_id, space: event.data.channel, thread: event.data.thread_ts ?? event.data.ts },
    // The speaker's own workspace (`user_team`), not the app's: a guest from a shared channel belongs to another one, and the sink gives that account nothing.
    actor: { channel: "slack", tenant: event.data.user_team, userId: event.data.user }, text, receivedAt: now().toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}

/** A press of one of Rovara's buttons, as a decision. Undefined for any other press, and for one whose value does not read or does not agree with the button. */
export function decisionOf(payload: unknown, now: () => Date, log: (entry: Record<string, unknown>) => void = () => undefined): ChannelDecision | undefined {
  const pressed = ActionPayloadSchema.safeParse(payload);
  if (!pressed.success) return undefined;
  if (pressed.data.user.team_id === undefined) { log({ event: "slack.speaker_workspace_unknown" }); return undefined; }
  const action = pressed.data.actions.find((entry) => entry.action_id.startsWith(ACTION_PREFIX));
  if (action === undefined || action.value === undefined) return undefined;
  let value: ButtonValue;
  try {
    value = ButtonValueSchema.parse(JSON.parse(action.value));
  } catch {
    return undefined;
  }
  // The button's own name and its value must say the same decision.
  if (action.action_id !== `${ACTION_PREFIX}${value.o}`) return undefined;
  // A request for changes is not a press: it needs the person's words, which a box (`changesPressOf`) asks for. A press alone never carries one.
  if (value.o === "REQUEST_CHANGES") return undefined;
  const parsed = ChannelDecisionSchema.safeParse({
    version: 1, channel: "slack", eventId: pressed.data.trigger_id,
    conversation: { channel: "slack", tenant: pressed.data.team.id, space: pressed.data.channel.id, thread: pressed.data.message.thread_ts ?? NO_THREAD },
    actor: { channel: "slack", tenant: pressed.data.user.team_id, userId: pressed.data.user.id },
    requestId: value.r, expectedRevision: value.v, artifactDigest: value.d, decision: value.o, reason: "Pressed in chat.", receivedAt: now().toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}

/**
 * A press of the Request changes button: what is needed to open the box that asks "What should change?" for exactly that request, by the person who pressed. `taskUrl` is the card's own "Open the task" address when it has one
 * (a plain https address), for the note that says the button expired.
 */
export interface ChangesPress { triggerId: string; context: ChangesContext; taskUrl?: string }

/** The card's own "Open the task" address, read from the message the button is on: a plain https address, or nothing. */
function taskUrlOf(message: Record<string, unknown>): string | undefined {
  const blocks = Array.isArray(message["blocks"]) ? message["blocks"] as unknown[] : [];
  for (const block of blocks) {
    const elements = typeof block === "object" && block !== null && Array.isArray((block as { elements?: unknown }).elements) ? (block as { elements: unknown[] }).elements : [];
    for (const element of elements) {
      const entry = element as { action_id?: unknown; url?: unknown };
      if (entry.action_id !== "rovara_open_task" || typeof entry.url !== "string") continue;
      try {
        const url = new URL(entry.url);
        if (url.protocol === "https:" && url.username === "" && url.password === "") return url.toString();
      } catch { /* not an address */ }
    }
  }
  return undefined;
}

export function changesPressOf(payload: unknown, log: (entry: Record<string, unknown>) => void = () => undefined): ChangesPress | undefined {
  const pressed = ActionPayloadSchema.safeParse(payload);
  if (!pressed.success) return undefined;
  const action = pressed.data.actions.find((entry) => entry.action_id === `${ACTION_PREFIX}REQUEST_CHANGES`);
  if (action === undefined || action.value === undefined) return undefined;
  let value: ButtonValue;
  try {
    value = ButtonValueSchema.parse(JSON.parse(action.value));
  } catch {
    return undefined;
  }
  if (value.o !== "REQUEST_CHANGES") return undefined;
  if (pressed.data.user.team_id === undefined) { log({ event: "slack.speaker_workspace_unknown" }); return undefined; }
  const taskUrl = taskUrlOf(pressed.data.message);
  return {
    triggerId: pressed.data.trigger_id,
    ...(taskUrl === undefined ? {} : { taskUrl }),
    context: { r: value.r, v: value.v, d: value.d, t: pressed.data.team.id, s: pressed.data.channel.id, h: pressed.data.message.thread_ts ?? NO_THREAD, u: pressed.data.user.id, w: pressed.data.user.team_id },
  };
}

const ContextSchema = z.object({
  r: z.string().uuid(), v: z.number().int().positive(), d: z.string().regex(/^[a-f0-9]{64}$/u), t: Id, s: Id, h: Ts, u: Id, w: Id,
}).strict();
const SubmissionSchema = z.object({
  type: z.literal("view_submission"),
  user: z.object({ id: Id, team_id: Id.optional() }).passthrough(),
  view: z.object({
    id: Id, callback_id: z.string().max(100), private_metadata: z.string().max(3_000),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.object({ value: z.string().max(20_000).nullable().optional() }).passthrough())) }).passthrough(),
  }).passthrough(),
}).passthrough();

/**
 * What came back from the box: not Rovara's (`undefined`); the person's words as a decision for the request the box was opened for (`ok`); nothing typed (`empty`: the box shows an error and stays open); or from a person other
 * than the one who opened it, or a box whose own record does not read (`refused`: it is closed and nothing is decided).
 */
export type ChangesSubmission =
  | { status: "ok"; decision: ChannelDecision }
  | { status: "empty" }
  /** `notify` says where to tell the person why nothing was sent, when the box's record still names a place (an unreadable record may not). */
  | { status: "refused"; why: "other_person" | "unreadable"; notify?: { channel: string; thread: string; user: string } };

/** Where a refused box's person can be told: the card's channel and thread, read leniently from a record that did not read as a whole. */
function placeOf(metadata: string, user: string): { channel: string; thread: string; user: string } | undefined {
  try {
    const found = z.object({ s: Id, h: Ts }).passthrough().safeParse(JSON.parse(metadata));
    return found.success ? { channel: found.data.s, thread: found.data.h, user } : undefined;
  } catch {
    return undefined;
  }
}

export function changesSubmissionOf(payload: unknown, bot: { userId: string }, now: () => Date, log: (entry: Record<string, unknown>) => void = () => undefined): ChangesSubmission | undefined {
  const submitted = SubmissionSchema.safeParse(payload);
  if (!submitted.success || submitted.data.view.callback_id !== CHANGES_CALLBACK) return undefined;
  let context: ChangesContext;
  try {
    context = ContextSchema.parse(JSON.parse(submitted.data.view.private_metadata));
  } catch {
    log({ event: "slack.changes_box_unreadable" });
    const place = placeOf(submitted.data.view.private_metadata, submitted.data.user.id);
    return { status: "refused", why: "unreadable", ...(place === undefined ? {} : { notify: place }) };
  }
  // Only the person who pressed the button may send what is in its box, from the workspace they pressed it in.
  if (submitted.data.user.id !== context.u || submitted.data.user.team_id !== context.w) {
    log({ event: "slack.changes_box_other_person" });
    return { status: "refused", why: "other_person", notify: { channel: context.s, thread: context.h, user: submitted.data.user.id } };
  }
  const reason = cleanChatText(submitted.data.view.state.values[CHANGES_INPUT]?.[CHANGES_FIELD]?.value ?? "", bot.userId, CHANGE_REASON_MAX);
  if (reason === "") return { status: "empty" };
  const parsed = ChannelDecisionSchema.safeParse({
    version: 1, channel: "slack", eventId: submitted.data.view.id,
    conversation: { channel: "slack", tenant: context.t, space: context.s, thread: context.h },
    actor: { channel: "slack", tenant: context.w, userId: context.u },
    requestId: context.r, expectedRevision: context.v, artifactDigest: context.d, decision: "REQUEST_CHANGES", reason, receivedAt: now().toISOString(),
  });
  return parsed.success ? { status: "ok", decision: parsed.data } : { status: "refused", why: "unreadable", notify: { channel: context.s, thread: context.h, user: context.u } };
}
