// Spec 062 Phase 5b: the Slack request queue's consumer: the core queue runner (consumer.ts) reading Slack request
// messages (version 1, or a Slack version 2 inbound message; another channel's is discarded), with page comments
// checked against their schema before their handler sees them.
import { SlackPageCommentMessageSchema, readSlackRequestMessage, type SlackPageCommentMessage, type SlackRequestMessage } from "@rovara-code/contracts";
import {
  processGroup as processQueueGroup,
  runConsumer as runQueueConsumer,
  type ConsumerOptions,
  type QueueClient,
  type QueueMessage,
  type RequestHandler,
} from "./consumer.js";
import type { ServiceLog } from "./processor.js";

export type { QueueClient, QueueMessage } from "./consumer.js";
export type SlackRequestHandler = RequestHandler<SlackRequestMessage>;
export type SlackPageCommentHandler = (message: SlackPageCommentMessage, context: { handoff?: AbortSignal }) => Promise<void>;

type SlackGroupOptions = Omit<Parameters<typeof processQueueGroup<SlackRequestMessage>>[3], "read" | "pageComment"> & { pageComment?: SlackPageCommentHandler };
export type SlackConsumerOptions = Omit<ConsumerOptions<SlackRequestMessage>, "read" | "pageComment"> & { pageComment?: SlackPageCommentHandler };

/** A page comment's handler behind its schema: an unreadable body is dropped and logged, never answered. */
function checkedPageComment(handler: SlackPageCommentHandler | undefined, log: ServiceLog) {
  if (handler === undefined) return {};
  return {
    pageComment: async (body: unknown, context: { handoff?: AbortSignal }) => {
      const comment = SlackPageCommentMessageSchema.safeParse(body);
      if (!comment.success) {
        log("message.discarded", { reason: "invalid_message" });
        return;
      }
      await handler(comment.data, context);
    },
  };
}

export function runConsumer(queue: QueueClient, handle: SlackRequestHandler, options: SlackConsumerOptions): Promise<void> {
  const { pageComment, ...rest } = options;
  return runQueueConsumer(queue, handle, { ...rest, read: readSlackRequestMessage, ...checkedPageComment(pageComment, options.log ?? (() => undefined)) });
}

export function processGroup(queue: QueueClient, handle: SlackRequestHandler, group: readonly QueueMessage[], options: SlackGroupOptions, log: ServiceLog): Promise<void> {
  const { pageComment, ...rest } = options;
  return processQueueGroup(queue, handle, group, { ...rest, read: readSlackRequestMessage, ...checkedPageComment(pageComment, log) }, log);
}
