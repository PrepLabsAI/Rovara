// Spec 062 Phase 7b (FR-073): the built-in Slack adapter's conversations, as the channel consumer hands them over. Each
// runs as a Slack thread does (Slack's subject, format, identity, turn records and commands), and everything it says
// leaves as an event for the adapter to post, as any adapter's conversation does.
import { randomUUID } from "node:crypto";
import {
  SLACK_CONFIRMATION_ACTION_ID,
  SlackRequestMessageSchema,
  TURN_DETAILS_ACTION_ID,
  channelEventId,
  slackThreadOf,
  type ChannelEvent,
  type ChannelQueueItem,
  type ConversationRef,
  type QueuedRouting,
  type SlackRequestMessage,
} from "@rovara-code/contracts";
import { approvalRequestData, channelTurn, type ConversationQueueItem } from "./channel-requests.js";
import type { RequestContext } from "./consumer.js";
import { processSlackRequest, type ProcessorDependencies, type ServiceLog } from "./slack-processor.js";

export interface SlackChannelDependencies {
  /** The Slack processor's dependencies, except how its words reach the thread. */
  processor: Omit<ProcessorDependencies, "post" | "postConfirmation" | "postWithBlocks" | "postDetails" | "postProgress" | "updateMessage">;
  /** Queues an event for the adapter; the event sender signs and delivers it, in order. */
  send(event: ChannelEvent): Promise<void>;
  /**
   * Phase 7c2: a message the core's router marked: a plain new request to route to an answer or a suggested task, or a
   * task's saved note to answer if it is a question. `answer` runs a request as this conversation's turn. Absent: a
   * marked message runs as any other.
   */
  routed?: (input: { message: SlackRequestMessage; routing: QueuedRouting; context: RequestContext; answer: (message: SlackRequestMessage) => Promise<void> }) => Promise<void>;
  log?: ServiceLog;
  now?: () => number;
}

/** The channel consumer's surface for channel `slack`. */

/** A confirmation press as the typed reply it stands for, which the processor answers as it always has. */
function confirmationReply(item: Extract<ChannelQueueItem, { kind: "action" }>): ConversationQueueItem | undefined {
  const { action } = item;
  if (action.actionId !== SLACK_CONFIRMATION_ACTION_ID || action.conversation === undefined || (action.value !== "yes" && action.value !== "cancel")) return undefined;
  return {
    kind: "message", projectName: item.projectName ?? "unknown", stepUp: item.stepUp,
    message: { version: 2, channel: action.channel, eventId: action.eventId, conversation: action.conversation, actor: action.actor, text: action.value, receivedAt: action.receivedAt },
  };
}

export function slackChannelRequests(deps: SlackChannelDependencies): (item: ChannelQueueItem, context: RequestContext) => Promise<void> {
  const now = deps.now ?? Date.now;
  const handle = conversation(deps, now);
  return async (item, context) => {
    if (item.kind !== "action") return handle(item, context);
    const reply = confirmationReply(item);
    if (reply === undefined) {
      deps.log?.("channel.action_unhandled", { channel: item.action.channel, actionId: item.action.actionId, eventId: item.action.eventId });
      return;
    }
    return handle(reply, context);
  };
}

function conversation(deps: SlackChannelDependencies, now: () => number): (item: ConversationQueueItem, context: RequestContext) => Promise<void> {
  return async (item, context) => {
    const { message: turn, answer } = channelTurn(item);
    const conversation: ConversationRef = turn.thread;
    // Slack's own request: the channel API checked the signature and binding; Slack's IDs are checked again here.
    const message: SlackRequestMessage = SlackRequestMessageSchema.parse({
      version: 1, eventId: turn.eventId, thread: slackThreadOf(conversation), userId: turn.userId, text: turn.text, receivedAt: turn.receivedAt,
    });
    const queuedBehind = item.kind === "message" ? item.queuedBehind : undefined;
    const event = <T extends Exclude<ChannelEvent["type"], "direct">>(type: T, data: Extract<ChannelEvent, { type: T }>["data"]): ChannelEvent =>
      ({ version: 1, id: channelEventId(), channel: conversation.channel, conversation, createdAt: new Date(now()).toISOString(), type, data }) as ChannelEvent;
    const say = async (data: Extract<ChannelEvent, { type: "message" }>["data"]) => {
      if (data.text.trim().length > 0) await deps.send(event("message", { ...data, text: data.text.trim() }));
    };
    const run = (request: SlackRequestMessage) => processSlackRequest(request, {
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
      // What the router told the thread: how many requests this one waits behind (none said, before Phase 7c2).
      queuedBehind: queuedBehind ?? 0,
      ...(context.redelivered === true ? { redelivered: true } : {}),
      ...(context.handoff === undefined ? {} : { handoff: context.handoff }),
      ...(context.onHeartbeat === undefined ? {} : { onHeartbeat: context.onHeartbeat }),
      ...(answer === undefined ? {} : { answer }),
    });
    if (item.kind === "message" && item.routing !== undefined && deps.routed !== undefined) {
      await deps.routed({ message, routing: item.routing, context, answer: run });
      return;
    }
    await run(message);
  };
}
