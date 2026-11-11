// What the chat tool says to Rovara, turned into the neutral shapes the core takes (`InboundMessage`, `ChannelDecision`). Only two things are heard: a person mentioning the bot in a channel (a message) and a person pressing
// a button on a card Rovara posted (a decision). Nothing else is read, so a message that does not mention the bot is never seen. Who is speaking is the tool's claim: the sink checks it against the links the owner made.
import { ChannelDecisionSchema, InboundMessageSchema, type ChannelDecision, type InboundMessage } from "@agentx/contracts";
import { z } from "zod";
import { ACTION_PREFIX, NO_THREAD, type ButtonValue } from "./format.js";

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
  const parsed = ChannelDecisionSchema.safeParse({
    version: 1, channel: "slack", eventId: pressed.data.trigger_id,
    conversation: { channel: "slack", tenant: pressed.data.team.id, space: pressed.data.channel.id, thread: pressed.data.message.thread_ts ?? NO_THREAD },
    actor: { channel: "slack", tenant: pressed.data.user.team_id, userId: pressed.data.user.id },
    requestId: value.r, expectedRevision: value.v, artifactDigest: value.d, decision: value.o, reason: "Pressed in chat.", receivedAt: now().toISOString(),
  });
  return parsed.success ? parsed.data : undefined;
}
