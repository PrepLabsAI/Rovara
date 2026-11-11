// Spec 062 Phase 7b (FR-073): the built-in Slack adapter's conversations, as the channel consumer hands them over. Each
// runs as a Slack thread does (Slack's subject, format, identity, turn records and commands), and everything it says
// leaves as an event for the adapter to post, as any adapter's conversation does.
import { randomUUID } from "node:crypto";
import {
  SlackRequestMessageSchema,
  TURN_DETAILS_ACTION_ID,
  channelEventId,
  slackThreadOf,
  type ChannelEvent,
  type ConversationRef,
  type SlackRequestMessage,
} from "@agentx/contracts";
import { approvalRequestData, channelTurn, type ConversationQueueItem } from "./channel-requests.js";
import type { RequestContext } from "./consumer.js";
import { processSlackRequest, type ProcessorDependencies } from "./slack-processor.js";

export interface SlackChannelDependencies {
  /** The Slack processor's dependencies, except how its words reach the thread. */
  processor: Omit<ProcessorDependencies, "post" | "postConfirmation" | "postWithBlocks" | "postDetails" | "postProgress" | "updateMessage">;
  /** Queues an event for the adapter; the event sender signs and delivers it, in order. */
  send(event: ChannelEvent): Promise<void>;
  now?: () => number;
}

/** The channel consumer's surface for channel `slack`. */
export function slackChannelRequests(deps: SlackChannelDependencies): (item: ConversationQueueItem, context: RequestContext) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (item, context) => {
    const { message: turn, answer } = channelTurn(item);
    const conversation: ConversationRef = turn.thread;
    // Slack's own request: the channel API checked the signature and binding; Slack's IDs are checked again here.
    const message: SlackRequestMessage = SlackRequestMessageSchema.parse({
      version: 1, eventId: turn.eventId, thread: slackThreadOf(conversation), userId: turn.userId, text: turn.text, receivedAt: turn.receivedAt,
    });
    const event = <T extends Exclude<ChannelEvent["type"], "direct">>(type: T, data: Extract<ChannelEvent, { type: T }>["data"]): ChannelEvent =>
      ({ version: 1, id: channelEventId(), channel: conversation.channel, conversation, createdAt: new Date(now()).toISOString(), type, data }) as ChannelEvent;
    const say = async (data: Extract<ChannelEvent, { type: "message" }>["data"]) => {
      if (data.text.trim().length > 0) await deps.send(event("message", { ...data, text: data.text.trim() }));
    };
    await processSlackRequest(message, {
      ...deps.processor,
      post: (_thread, text) => say({ text }),
      postConfirmation: async (_thread, confirmation, text) => { await deps.send(event("approval_request", approvalRequestData(confirmation, text))); },
      postDetails: (_thread, text, value) => say({ text, actions: [{ type: "button", actionId: TURN_DETAILS_ACTION_ID, value, label: "Details" }] }),
      // Issue 219: the progress note is a keyed message, which the adapter edits in place.
      postProgress: async (_thread, text) => {
        const key = `progress:${randomUUID()}`;
        await say({ text, key });
        return key;
      },
      updateMessage: (_thread, key, text) => say({ text, key }),
    }, {
      finalAttempt: context.finalAttempt,
      // The ingress said "Got it" or how many requests are ahead; the channel API carries no count.
      queuedBehind: 0,
      ...(context.redelivered === true ? { redelivered: true } : {}),
      ...(context.handoff === undefined ? {} : { handoff: context.handoff }),
      ...(context.onHeartbeat === undefined ? {} : { onHeartbeat: context.onHeartbeat }),
      ...(answer === undefined ? {} : { answer }),
    });
  };
}
