import {
  ChannelQueueItemSchema,
  adapterMayDecide,
  channelEventId,
  conversationSubject,
  type ChannelEvent,
  type ChannelQueueItem,
  type ConversationRef,
  type PendingConfirmation,
} from "@agentx/contracts";
import { confirmationApprovalKind, confirmationDigest, type ConfirmationAnswer } from "./confirmations.js";
import type { RequestHandler } from "./consumer.js";
import { processSlackRequest, type ProcessorDependencies, type ProcessorMessage, type ServiceLog } from "./processor.js";

/**
 * Spec 062 Phase 4: runs what the channel API queued, through the same processor as a Slack thread. The conversation's
 * replies leave as signed events on the event queue instead of Slack posts, and the broker checks the adapter, binding
 * and link again on every call it makes for the conversation.
 */

export const SLACK_ONLY_COMMAND_TEXT = "SWE-bench runs and eval batches can only be started from Slack.";

/** A queued item, or undefined for one this consumer cannot read (it is discarded). */
export function readChannelQueueItem(value: unknown): ChannelQueueItem | undefined {
  const parsed = ChannelQueueItemSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The processor's request for a queued item; a decision becomes a "yes" or "cancel" bound to one confirmation. */
export function channelTurn(item: ChannelQueueItem): { message: ProcessorMessage<ConversationRef>; answer?: ConfirmationAnswer } {
  if (item.kind === "message") {
    const { message } = item;
    return { message: { eventId: message.eventId, thread: message.conversation, userId: message.actor.userId, text: message.text, receivedAt: message.receivedAt } };
  }
  const { decision } = item;
  const reply = decision.decision === "APPROVE" ? "yes" : "cancel";
  return {
    message: { eventId: decision.eventId, thread: decision.conversation, userId: decision.actor.userId, text: reply, receivedAt: decision.receivedAt },
    answer: { confirmationId: decision.requestId, digest: decision.artifactDigest, reply },
  };
}

/**
 * Slack markup to plain text, for an adapter. The core still writes Slack's markup (spec 062 Phase 4b moves formatting
 * into each adapter); until then mentions are dropped, links show their address, and Slack's escapes are undone.
 */
export function plainText(text: string): string {
  const plain = text
    .replace(/<@[^>|]+(?:\|[^>]*)?>,?\s?/g, "")
    .replace(/<#[^>|]+\|([^>]*)>/g, "#$1")
    .replace(/<(https?:[^>|]+)\|([^>]*)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/`@AgentX /g, "`")
    .replace(/@AgentX /g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .trim();
  return plain.length === 0 ? plain : `${plain.charAt(0).toUpperCase()}${plain.slice(1)}`;
}

export interface ChannelRequestDependencies {
  /** Everything the processor needs that is not about how replies reach the conversation. */
  processor: Omit<ProcessorDependencies<ConversationRef>, "post" | "postConfirmation" | "postWithBlocks" | "postProgress" | "updateMessage"
    | "subjectOf" | "plainReplies" | "slackOnlyCommandText" | "mayApprove" | "turnRecords">;
  /** Queues an event for the adapter; the event sender signs and delivers it. */
  send(event: ChannelEvent): Promise<void>;
  now?: () => number;
  log: ServiceLog;
}

/** The consumer's handler for the channel request queue. */
export function channelRequestHandler(deps: ChannelRequestDependencies): RequestHandler<ChannelQueueItem> {
  const now = deps.now ?? Date.now;
  return async (item, context) => {
    const { message, answer } = channelTurn(item);
    const conversation = message.thread;
    const event = <T extends ChannelEvent["type"]>(type: T, data: Extract<ChannelEvent, { type: T }>["data"]): ChannelEvent =>
      ({ version: 1, id: channelEventId(), channel: conversation.channel, conversation, createdAt: new Date(now()).toISOString(), type, data }) as ChannelEvent;
    // Each reply is queued as it is posted, so what the processor counts as said has reached the queue.
    const post = async (_thread: ConversationRef, text: string) => {
      const plain = plainText(text);
      if (plain.length > 0) await deps.send(event("message", { text: plain }));
    };
    const postConfirmation = async (_thread: ConversationRef, confirmation: PendingConfirmation, text: string) => {
      await deps.send(event("approval_request", {
        text: plainText(text),
        kind: confirmationApprovalKind(confirmation),
        requestId: confirmation.confirmationId,
        expectedRevision: 1,
        artifactDigest: confirmationDigest(confirmation),
        actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Cancel" }],
      }));
    };
    await processSlackRequest(message, {
      ...deps.processor,
      post,
      postConfirmation,
      subjectOf: conversationSubject,
      plainReplies: true,
      slackOnlyCommandText: SLACK_ONLY_COMMAND_TEXT,
      // FR-032: the step-up set the adapter had when the channel API accepted the item.
      mayApprove: (confirmation) => adapterMayDecide({ stepUp: item.stepUp }, confirmationApprovalKind(confirmation)),
    }, {
      finalAttempt: context.finalAttempt,
      // The channel API's ack already said the request was received; "working on it" is said only after a wait.
      queuedBehind: 0,
      ...(context.redelivered === true ? { redelivered: true } : {}),
      ...(context.handoff === undefined ? {} : { handoff: context.handoff }),
      ...(context.onHeartbeat === undefined ? {} : { onHeartbeat: context.onHeartbeat }),
      ...(answer === undefined ? {} : { answer }),
    });
    // The request finished. The marker only tells the adapter so; losing it loses nothing said.
    try {
      await deps.send(event("done", { inReplyTo: message.eventId }));
    } catch (error) {
      deps.log("channel.done_failed", { eventId: message.eventId, errorName: error instanceof Error ? error.name : "unknown" });
    }
  };
}
