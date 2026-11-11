import {
  ChannelQueueItemSchema,
  SLACK_CHANNEL,
  adapterMayDecide,
  parseChatGptCommand,
  parseEvalBatchCommand,
  parseSwebenchCommand,
  channelEventId,
  conversationSubject,
  type ChannelAction,
  type ChannelEvent,
  type ChannelQueueItem,
  type ConversationRef,
  type PendingConfirmation,
} from "@agentx/contracts";
import { confirmationApprovalKind, confirmationDigest, type ConfirmationAnswer } from "./confirmations.js";
import { PLAIN_FORMAT } from "./conversation-format.js";
import type { RequestContext, RequestHandler } from "./consumer.js";
import { processConversationRequest, type ProcessorDependencies, type ProcessorMessage, type ServiceLog, type SurfaceCommand } from "./processor.js";

/**
 * Spec 062 Phase 4: runs what the channel API queued, through the same processor as a Slack thread. The conversation's
 * replies leave as signed events on the event queue instead of Slack posts, and the broker checks the adapter, binding
 * and link again on every call it makes for the conversation.
 */

export const SLACK_ONLY_COMMAND_TEXT = "SWE-bench runs and eval batches can only be started from Slack.";

/**
 * FR-041: an adapter conversation may be a group, and ChatGPT's sign-in needs a private reply and a pasted address, so
 * the commands are answered with where to run them. Nothing about the person's connection is said here.
 */
export const CHATGPT_ELSEWHERE_TEXT = "Your ChatGPT connection is private, so I don't manage it here. Use the Rovara CLI: `agentx chatgpt connect`, `agentx chatgpt status` or `agentx chatgpt disconnect`.";

/** A queued item, or undefined for one this consumer cannot read (it is discarded). */
export function readChannelQueueItem(value: unknown): ChannelQueueItem | undefined {
  const parsed = ChannelQueueItemSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** A queued conversation item: a message or a decision. */
export type ConversationQueueItem = Exclude<ChannelQueueItem, { kind: "action" }>;

/** The channel a queued item came through. */
export function channelOf(item: ChannelQueueItem): string {
  return item.kind === "message" ? item.message.channel : item.kind === "decision" ? item.decision.channel : item.action.channel;
}

/** An approval request event's data for a pending confirmation: Approve or Cancel, bound to its digest. */
export function approvalRequestData(confirmation: PendingConfirmation, text: string): Extract<ChannelEvent, { type: "approval_request" }>["data"] {
  return {
    text,
    kind: confirmationApprovalKind(confirmation),
    requestId: confirmation.confirmationId,
    expectedRevision: 1,
    artifactDigest: confirmationDigest(confirmation),
    actions: [{ decision: "APPROVE", label: "Approve" }, { decision: "REJECT", label: "Cancel" }],
  };
}

/** The processor's request for a queued item; a decision becomes a "yes" or "cancel" bound to one confirmation. */
export function channelTurn(item: ConversationQueueItem): { message: ProcessorMessage<ConversationRef>; answer?: ConfirmationAnswer } {
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

export interface ChannelRequestDependencies {
  /** Everything the processor needs that is not about how replies reach the conversation. */
  processor: Omit<ProcessorDependencies<ConversationRef>, "post" | "postConfirmation" | "postReplyEnd" | "postProgress" | "updateMessage"
    | "subjectOf" | "plainReplies" | "format" | "commands" | "mayApprove" | "onFinished">;
  /** Queues an event for the adapter; the event sender signs and delivers it. */
  send(event: ChannelEvent): Promise<void>;
  /**
   * FR-071: what runs a person's press or form, by its action ID. An action with no handler is logged and dropped; the
   * Slack adapter's actions get theirs with Phases 7b and 7c.
   */
  actions?: Readonly<Record<string, ChannelActionHandler>>;
  /**
   * FR-073: channels the deployment runs its own way, by channel ID. The built-in Slack adapter's conversations run
   * as Slack threads (Slack's subject, format, identity and turn records), answering with events all the same.
   */
  surfaces?: Readonly<Record<string, (item: ConversationQueueItem, context: RequestContext) => Promise<void>>>;
  now?: () => number;
  log: ServiceLog;
}

/** Spec 062 FR-038: eval batches and SWE-bench runs need a Slack thread, so an adapter conversation is told so. */
const slackOnly: SurfaceCommand<ConversationRef> = (message) =>
  parseEvalBatchCommand(message.text) === undefined && parseSwebenchCommand(message.text) === undefined
    ? undefined
    : { disposition: "abandoned", run: async (context) => { await context.post(SLACK_ONLY_COMMAND_TEXT); } };

const chatGptElsewhere: SurfaceCommand<ConversationRef> = (message) =>
  parseChatGptCommand(message.text) === undefined
    ? undefined
    : { disposition: "abandoned", run: async (context) => { await context.post(CHATGPT_ELSEWHERE_TEXT); } };

/** Runs one action (FR-071) for a conversation; it may answer with events through `send`. */
export type ChannelActionHandler = (action: ChannelAction, context: { send: (event: ChannelEvent) => Promise<void>; finalAttempt: boolean; log: ServiceLog }) => Promise<void>;

/** The consumer's handler for the channel request queue. */
export function channelRequestHandler(deps: ChannelRequestDependencies): RequestHandler<ChannelQueueItem> {
  const now = deps.now ?? Date.now;
  return async (item, context) => {
    if (item.kind === "action") {
      const handler = deps.actions?.[item.action.actionId];
      if (handler === undefined) {
        deps.log("channel.action_unhandled", { channel: item.action.channel, actionId: item.action.actionId, eventId: item.action.eventId });
        return;
      }
      await handler(item.action, { send: (event) => deps.send(event), finalAttempt: context.finalAttempt, log: deps.log });
      return;
    }
    const surface = deps.surfaces?.[channelOf(item)];
    if (surface !== undefined) {
      await surface(item, context);
      return;
    }
    // The built-in adapter's conversations need their own surface; without it nothing runs as an adapter's would.
    if (channelOf(item) === SLACK_CHANNEL) {
      deps.log("channel.surface_missing", { channel: SLACK_CHANNEL });
      return;
    }
    const { message, answer } = channelTurn(item);
    const conversation = message.thread;
    const event = <T extends ChannelEvent["type"]>(type: T, data: Extract<ChannelEvent, { type: T }>["data"]): ChannelEvent =>
      ({ version: 1, id: channelEventId(), channel: conversation.channel, conversation, createdAt: new Date(now()).toISOString(), type, data }) as ChannelEvent;
    // Each reply is queued as it is posted, so what the processor counts as said has reached the queue. The processor
    // writes in the plain format, so the text is already the adapter's to format.
    const post = async (_thread: ConversationRef, text: string) => {
      const trimmed = text.trim();
      if (trimmed.length > 0) await deps.send(event("message", { text: trimmed }));
    };
    const postConfirmation = async (_thread: ConversationRef, confirmation: PendingConfirmation, text: string) => {
      await deps.send(event("approval_request", approvalRequestData(confirmation, text)));
    };
    await processConversationRequest(message, {
      ...deps.processor,
      post,
      postConfirmation,
      subjectOf: conversationSubject,
      plainReplies: true,
      format: PLAIN_FORMAT,
      commands: [slackOnly, chatGptElsewhere],
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
