import { z } from "zod";
import {
  SLACK_THREAD_OWNER_ISSUER, SlackMessageTimestampSchema, SlackRequestMessageSchema, SlackTeamIdSchema,
  SlackUserIdSchema, type SlackRequestMessage,
} from "./slack.js";

/**
 * Spec 062: a conversation, a person and a request without Slack's types, so any channel adapter can reach the
 * core. Slack keeps its exact keys: a Slack subject is the three-segment thread subject and its owner issuer is
 * `slack-thread`, so no stored row or workspace owner key moves.
 */

export const SLACK_CHANNEL = "slack";

/** A channel adapter's ID, such as `slack` or `whatsapp`. */
export const ChannelIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);

/** An adapter's own ID for a tenant, space, thread, user or event. Never `/`, so a subject splits unambiguously. */
export const ChannelOpaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:+@=-]+$/);

function checkSlack(context: z.RefinementCtx, schema: z.ZodType, value: string, field: string): void {
  if (!schema.safeParse(value).success) context.addIssue({ code: "custom", path: [field], message: `not a Slack ${field}` });
}

/**
 * A Slack conversation's space: a public or private channel, or a direct message (`D...`: where a person is told, and a message from them is heard). A binding of a space to a project (channel-binding.ts) stays
 * on channels only.
 */
const SlackConversationSpaceSchema = z.string().regex(/^[CGD][A-Z0-9]{2,31}$/);

export const ConversationRefSchema = z.object({
  channel: ChannelIdSchema,
  tenant: ChannelOpaqueIdSchema,
  space: ChannelOpaqueIdSchema,
  thread: ChannelOpaqueIdSchema,
}).strict().superRefine((ref, context) => {
  if (ref.channel !== SLACK_CHANNEL) return;
  checkSlack(context, SlackTeamIdSchema, ref.tenant, "tenant");
  checkSlack(context, SlackConversationSpaceSchema, ref.space, "space");
  checkSlack(context, SlackMessageTimestampSchema, ref.thread, "thread");
});
export type ConversationRef = z.infer<typeof ConversationRefSchema>;

export const ActorRefSchema = z.object({
  channel: ChannelIdSchema,
  tenant: ChannelOpaqueIdSchema,
  userId: ChannelOpaqueIdSchema,
}).strict().superRefine((actor, context) => {
  if (actor.channel !== SLACK_CHANNEL) return;
  checkSlack(context, SlackTeamIdSchema, actor.tenant, "tenant");
  checkSlack(context, SlackUserIdSchema, actor.userId, "userId");
});
export type ActorRef = z.infer<typeof ActorRefSchema>;

/** One message from a channel adapter, as the request queue carries it. `eventId` is what duplicates are dropped by. */
export const InboundMessageSchema = z.object({
  version: z.literal(2),
  channel: ChannelIdSchema,
  eventId: ChannelOpaqueIdSchema,
  conversation: ConversationRefSchema,
  actor: ActorRefSchema,
  text: z.string().min(1).max(40_000),
  receivedAt: z.string().datetime(),
}).strict().superRefine((message, context) => {
  if (message.conversation.channel !== message.channel) context.addIssue({ code: "custom", path: ["conversation", "channel"], message: "must equal channel" });
  if (message.actor.channel !== message.channel) context.addIssue({ code: "custom", path: ["actor", "channel"], message: "must equal channel" });
});
export type InboundMessage = z.infer<typeof InboundMessageSchema>;

/** `<tenant>/<space>/<thread>` for Slack (today's thread subject), `<channel>/<tenant>/<space>/<thread>` otherwise. */
export function conversationSubject(ref: ConversationRef): string {
  const parsed = ConversationRefSchema.parse(ref);
  const tail = `${parsed.tenant}/${parsed.space}/${parsed.thread}`;
  return parsed.channel === SLACK_CHANNEL ? tail : `${parsed.channel}/${tail}`;
}

/** The reference a subject names: three segments are Slack, four are another channel. */
export function parseConversationSubject(subject: string): ConversationRef {
  const parts = subject.split("/");
  if (parts.length === 3) {
    const [tenant, space, thread] = parts;
    return ConversationRefSchema.parse({ channel: SLACK_CHANNEL, tenant, space, thread });
  }
  if (parts.length === 4 && parts[0] !== SLACK_CHANNEL) {
    const [channel, tenant, space, thread] = parts;
    return ConversationRefSchema.parse({ channel, tenant, space, thread });
  }
  throw new Error("conversation subject must have three segments (Slack) or four (another channel)");
}

/** The issuer a conversation's workspace owner key is hashed with. Never an OIDC issuer, which is an https URL. */
export function conversationOwnerIssuer(channel: string): string {
  const parsed = ChannelIdSchema.parse(channel);
  return parsed === SLACK_CHANNEL ? SLACK_THREAD_OWNER_ISSUER : `channel-thread:${parsed}`;
}

export function conversationFromSlackThread(thread: { teamId: string; channelId: string; threadTs: string }): ConversationRef {
  return ConversationRefSchema.parse({ channel: SLACK_CHANNEL, tenant: thread.teamId, space: thread.channelId, thread: thread.threadTs });
}

export function slackThreadOf(ref: ConversationRef): { teamId: string; channelId: string; threadTs: string } {
  const parsed = ConversationRefSchema.parse(ref);
  if (parsed.channel !== SLACK_CHANNEL) throw new Error(`not a Slack conversation: ${parsed.channel}`);
  return { teamId: parsed.tenant, channelId: parsed.space, threadTs: parsed.thread };
}

export function actorFromSlackRequester(requester: { teamId: string; userId: string }): ActorRef {
  return ActorRefSchema.parse({ channel: SLACK_CHANNEL, tenant: requester.teamId, userId: requester.userId });
}

export function slackRequesterOf(actor: ActorRef): { teamId: string; userId: string } {
  const parsed = ActorRefSchema.parse(actor);
  if (parsed.channel !== SLACK_CHANNEL) throw new Error(`not a Slack actor: ${parsed.channel}`);
  return { teamId: parsed.tenant, userId: parsed.userId };
}

export function inboundFromSlackRequest(message: SlackRequestMessage): InboundMessage {
  return InboundMessageSchema.parse({
    version: 2,
    channel: SLACK_CHANNEL,
    eventId: message.eventId,
    conversation: conversationFromSlackThread(message.thread),
    actor: actorFromSlackRequester({ teamId: message.thread.teamId, userId: message.userId }),
    text: message.text,
    receivedAt: message.receivedAt,
  });
}

/** Throws unless the message is on Slack and every ID, the event ID included, has Slack's form. */
export function slackRequestFromInbound(message: InboundMessage): SlackRequestMessage {
  const parsed = InboundMessageSchema.parse(message);
  if (parsed.actor.tenant !== parsed.conversation.tenant) throw new Error("Slack actor is from another team");
  return SlackRequestMessageSchema.parse({
    version: 1,
    eventId: parsed.eventId,
    thread: slackThreadOf(parsed.conversation),
    userId: parsed.actor.userId,
    text: parsed.text,
    receivedAt: parsed.receivedAt,
  });
}

/**
 * A queued body as the Slack request the Slack service handles, whichever version ingress wrote; undefined for
 * anything else, including a valid message on another channel. Lets ingress and the service deploy in either order.
 */
export function readSlackRequestMessage(value: unknown): SlackRequestMessage | undefined {
  const v1 = SlackRequestMessageSchema.safeParse(value);
  if (v1.success) return v1.data;
  const v2 = InboundMessageSchema.safeParse(value);
  if (!v2.success || v2.data.channel !== SLACK_CHANNEL) return undefined;
  try {
    return slackRequestFromInbound(v2.data);
  } catch {
    return undefined;
  }
}
