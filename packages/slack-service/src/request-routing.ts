// Task 21: a plain top-level @AgentX request, which the Slack ingress queued with the routing mark once Slack had its
// answer. Small talk gets a fixed reply first (smart intake, no model). Otherwise the classifier model sorts it: a question is answered by the chat agent, like any chat request; anything
// else gets a card suggesting Quick or Full (or, unclear, offering all three), and nothing starts until its requester
// presses a button there, which the Slack ingress Lambda answers.
import { DeleteCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  quickAutoStartedMessage,
  routedChoiceId,
  slackThreadSubject,
  smallTalkOf,
  smallTalkReply,
  suggestionCardMessage,
  workflowChoiceKey,
  workflowChoicePut,
  workflowChoiceQuestionUpdate,
  type QuickAutoStartResult,
  type RequestSuggestion,
  type SlackRequestMessage,
  type SlackThread,
} from "@agentx/contracts";
import type { RequestRoute, RequestRouter } from "@agentx/orchestrator/request-router";
import type { ServiceLog } from "./processor.js";

/** Said when the card could not be posted, so the requester is not left in silence. */
export const ROUTE_CARD_FAILED_TEXT = "I couldn't ask how to handle this. Mention me again, or start with `quick:`, `full:` or `chat:`.";

export interface ChoiceOffer {
  thread: SlackThread;
  userId: string;
  instructions: string;
  choiceId: string;
  suggestion: RequestSuggestion;
}

export interface RequestRoutingDependencies {
  /** The classifier model's router. Absent (the classifier is not available here): every request gets the three-choice card. */
  route?: RequestRouter;
  /** Saves the request for its requester's choice and posts its card. */
  offer(input: ChoiceOffer): Promise<void>;
  /** Posts in the thread: the small-talk reply, the auto-started notice (with its Stop button), or the card-failed notice. */
  notify(thread: SlackThread, text: string, blocks?: Array<Record<string, unknown>>): Promise<void>;
  /**
   * Decision 134: asks the broker to start Quick on a request the classifier read as a clear small change. The broker
   * checks the text itself and starts it as the requester's Start press would; `started: false` (or a throw) means the
   * card with Start is posted instead. Absent: every change gets the card.
   */
  autoStart?(input: { message: SlackRequestMessage; requestId: string }): Promise<QuickAutoStartResult>;
  /** Decision 147: records that AgentX answered this request's sender in its thread (small talk, a card, a start, or a chat answer); never throws. */
  answered?(message: SlackRequestMessage): Promise<void>;
  /** Answers the request as the chat agent does any chat request. */
  answer(message: SlackRequestMessage): Promise<void>;
  /** Tells the thread's queued-request count that this request is done (the chat agent's path does so itself). */
  finish(subject: string): Promise<void>;
  log: ServiceLog;
  now?: () => number;
}

/**
 * Routes one queued request. Logs one `route.classified` line (kind, outcome, latency; never the text or the model's
 * reason), keyed by the choice ID its card would carry, so the requester's later choice can be joined to it.
 */
export async function routeSlackRequest(message: SlackRequestMessage, deps: RequestRoutingDependencies): Promise<void> {
  await routeOnce(message, deps);
  await deps.answered?.(message);
}

async function routeOnce(message: SlackRequestMessage, deps: RequestRoutingDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  // Smart intake: small talk ("hello", "thanks", "what can you do?") gets its fixed reply at once: no model call, no
  // spend, no card. It works when the classifier is down too.
  const smallTalk = smallTalkOf(message.text);
  if (smallTalk !== undefined) {
    deps.log("route.small_talk", { eventId: message.eventId, kind: smallTalk });
    await deps.notify(message.thread, smallTalkReply(smallTalk))
      .catch((error: unknown) => deps.log("route.small_talk_reply_failed", { eventId: message.eventId, errorName: errorName(error) }));
    await finishQuietly(message, deps);
    return;
  }
  let route: RequestRoute;
  if (deps.route === undefined) {
    route = { kind: "unclear", outcome: "unavailable" };
  } else {
    try {
      route = await deps.route(message.text);
    } catch {
      route = { kind: "unclear", outcome: "invalid" };
    }
  }
  const choiceId = routedChoiceId(message.eventId);
  deps.log("route.classified", { eventId: message.eventId, choiceId, kind: route.kind, outcome: route.outcome, latencyMs: Math.max(0, now() - startedAt) });
  if (route.kind === "question") {
    await deps.answer(message);
    return;
  }
  // Decision 134: only a usable "small change" answer is tried on its own; unclear, large, or any classifier failure never is.
  if (route.kind === "small_change" && route.outcome === "ok" && deps.autoStart !== undefined) {
    let result: QuickAutoStartResult | undefined;
    try {
      result = await deps.autoStart({ message, requestId: choiceId });
    } catch (error) {
      deps.log("route.auto_start_failed", { eventId: message.eventId, choiceId, errorName: errorName(error) });
    }
    if (result?.started === true) {
      deps.log("route.auto_started", { eventId: message.eventId, choiceId, taskId: result.taskId });
      const started = quickAutoStartedMessage({ requesterId: message.userId, taskId: result.taskId });
      await deps.notify(message.thread, started.text, started.blocks)
        .catch((error: unknown) => deps.log("route.auto_started_notice_failed", { eventId: message.eventId, errorName: errorName(error) }));
      await finishQuietly(message, deps);
      return;
    }
    if (result !== undefined) deps.log("route.auto_start_skipped", { eventId: message.eventId, choiceId, reason: result.reason, ...(result.code === undefined ? {} : { code: result.code }) });
  }
  try {
    await deps.offer({ thread: message.thread, userId: message.userId, instructions: message.text, choiceId, suggestion: route.kind });
  } catch (error) {
    // Never retried: a redelivery would only come after the queue's 15-minute visibility timeout. The requester is told
    // at once, and the request counts as done, as the chat agent's path does with a request it could not run.
    deps.log("route.offer_failed", { eventId: message.eventId, choiceId, errorName: errorName(error) });
    await deps.notify(message.thread, ROUTE_CARD_FAILED_TEXT)
      .catch((postError: unknown) => deps.log("route.card_failed_notice_failed", { eventId: message.eventId, errorName: errorName(postError) }));
  }
  await finishQuietly(message, deps);
}

async function finishQuietly(message: SlackRequestMessage, deps: RequestRoutingDependencies): Promise<void> {
  try {
    await deps.finish(slackThreadSubject(message.thread));
  } catch (error) {
    // The reply or card is posted; a count left one high only says "queued behind" once too often.
    deps.log("route.finish_failed", { eventId: message.eventId, errorName: errorName(error) });
  }
}

/**
 * The card's offer on the Slack threads table, as the Slack ingress saves a Quick or Full choice: the same item, so its
 * buttons and typed answers work the same. A redelivered request saves the same choice again (until it is answered),
 * but posts no second card once the first one went out. A card that could not be posted leaves nothing waiting and
 * throws, so the router tells the requester.
 */
export function createChoiceOffer(deps: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Posts in the thread and answers the message's timestamp. */
  post(thread: SlackThread, text: string, blocks?: unknown[]): Promise<string | undefined>;
  log: ServiceLog;
  now?: () => number;
}): (input: ChoiceOffer) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (input) => {
    try {
      await deps.documentClient.send(new PutCommand({ TableName: deps.tableName, ...workflowChoicePut({ ...input, nowMs: now() }) }));
    } catch (error) {
      if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      // This choice was answered already, or another one waits in the thread: nothing more to ask.
      deps.log("route.choice_not_saved", { choiceId: input.choiceId });
      return;
    }
    const card = suggestionCardMessage({ choiceId: input.choiceId, requesterId: input.userId, suggestion: input.suggestion });
    let ts: string | undefined;
    try {
      ts = await deps.post(input.thread, card.text, card.blocks);
    } catch (error) {
      deps.log("route.card_failed", { choiceId: input.choiceId, errorName: errorName(error) });
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: workflowChoiceKey(input.thread),
        ConditionExpression: "choiceId = :choiceId", ExpressionAttributeValues: { ":choiceId": input.choiceId } }))
        .catch((deleteError: unknown) => deps.log("route.choice_discard_failed", { choiceId: input.choiceId, errorName: errorName(deleteError) }));
      throw error;
    }
    if (ts === undefined) return;
    try {
      await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, ...workflowChoiceQuestionUpdate(input.thread, input.choiceId, ts) }));
    } catch (error) {
      // The card is asked; only its buttons stay after a typed answer.
      deps.log("route.card_unrecorded", { choiceId: input.choiceId, errorName: errorName(error) });
    }
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
