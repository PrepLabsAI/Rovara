// Lead 4 J2 (DEC 254z, 254zza): the Slack door of the smart Just answer. A question, or a message the classifier could not sort but read cleanly (`unclear`), in a bound project channel goes to the answer
// service instead of a card or the chat agent. This file is the Slack side only: it sends the person's words to the control plane (which decides who may ask, which project and which company, from the
// verified Slack thread and member, aws/slack-answers.ts) and puts the answer in Slack:
//   - ONE message per question: a "Looking..." line only if the answer takes more than a moment, edited in place into the answer (one new message only if the edit fails);
//   - the answer's words as the answer service wrote them, made safe for Slack (no mention, link or channel notice can come out of a model's or the wiki's words);
//   - at most ONE button, "Start a Quick task", only when the answer carries it. It is the existing Quick choice (same saved request, same requester-only press, same Start path and checks); the saved
//     request's text is the person's own question followed by the answer as untrusted data, which the control plane framed. Nothing starts by itself.
//   - a decline (answers not set up, no role, no bound channel, not a question this door takes) changes nothing: the caller does what it did before, so the chat agent still answers questions and the card
//     still offers the choices. A refusal (rate, spending limit, a fault) is said once, in fixed words, in the same message.
// Nothing the person wrote or the answer said is logged.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ANSWER_WORDS, SLACK_ANSWER_QUESTION_MAX, SLACK_ANSWER_WORDS, routedChoiceId, slackAnswerCard, workflowChoiceKey, workflowChoicePut, workflowChoiceQuestionUpdate,
  type AnswerResponse, type SlackAnswerAsk, type SlackAnswerResult, type SlackRequestMessage, type SlackThread,
} from "@agentx/contracts";
import type { ServiceLog } from "./processor.js";

/** The control plane's side of the door: the Slack thread's own client (slack-thread-api.ts `askAnswer`). */
export interface AnswerDoorApi { askAnswer?(input: SlackAnswerAsk): Promise<SlackAnswerResult> }

/** The saved request behind the answer's one button (a Quick choice on the Slack threads table, `createAnswerChoices`). */
export interface AnswerChoices {
  /** Saves it before the message with its button is posted. `saved`; `posted`: this very request's message already went out (a redelivery); `taken`: another request waits in the thread, so no button. */
  save(input: { thread: SlackThread; userId: string; choiceId: string; instructions: string; cardText: string }): Promise<"saved" | "posted" | "taken">;
  /** Keeps the posted message with its choice, best effort. */
  attachMessage(thread: SlackThread, choiceId: string, ts: string): Promise<void>;
  /** Forgets a choice whose message could not be posted. */
  discard(thread: SlackThread, choiceId: string): Promise<void>;
}

export interface AnswerDoorDeps {
  api(message: Pick<SlackRequestMessage, "thread" | "userId">): AnswerDoorApi;
  /** Posts in the thread; answers the message's timestamp. */
  post(thread: SlackThread, text: string, blocks?: unknown[]): Promise<string | undefined>;
  /** Edits the bot's own message (chat.update) with its blocks. Absent: no "Looking..." line is posted and the answer is posted once, new. */
  update?(thread: SlackThread, ts: string, text: string, blocks?: unknown[]): Promise<void>;
  /** Removes the bot's own message (the "Looking..." line of an answer that was not made). */
  remove?(thread: SlackThread, ts: string): Promise<void>;
  choices: AnswerChoices;
  /** How long an answer may take before the "Looking..." line is posted. Default 1.5 seconds: a decline is quicker than that and leaves no trace. */
  lookingDelayMs?: number;
  log: ServiceLog;
}

export type AnswerDoor = (message: SlackRequestMessage) => Promise<"handled" | "declined">;

const LOOKING_DELAY_MS = 1_500;

/** The person's words as a question: control and format characters (but not line breaks) become spaces, whitespace is trimmed. Undefined: not a question this door takes. */
export function questionOf(text: string): string | undefined {
  const clean = text.replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " ")).replace(/[ \t]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
  return clean === "" || Array.from(clean).length > SLACK_ANSWER_QUESTION_MAX ? undefined : clean;
}

const REFUSAL_WORDS = { rate: ANSWER_WORDS.rate, limit_reached: ANSWER_WORDS.limitReached, unavailable: ANSWER_WORDS.unavailable } as const;

/** One line of code place, safe inside a Slack code span. */
const place = (source: AnswerResponse["sources"][number]): string => `${source.repo}/${source.path}:${String(source.line)}${source.lineEnd === undefined ? "" : `-${String(source.lineEnd)}`}`.replace(/[`\n\r]/gu, "'");

/**
 * Words made plain for Slack: only Slack's three control characters are escaped, so a `<` never starts a mention, a channel notice, a channel link or a link with a label that hides where it goes. (The Slack
 * reply escaper that turns Markdown links into Slack links is for the chat agent's own words; an answer is the wiki's and the code's words through a model, and it gets no live link at all.)
 */
export const slackPlain = (text: string): string => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");

/** An answer as Slack text: the sentences, the honesty line, the sources and at most one wiki page. Everything is made plain first (`slackPlain`). */
export function answerSlackText(answer: AnswerResponse): string {
  const lines: string[] = [];
  if (answer.text !== "") lines.push(slackPlain(answer.text));
  if (answer.honesty !== undefined && answer.honesty !== "") lines.push(answer.text === "" ? slackPlain(answer.honesty) : `_${slackPlain(answer.honesty)}_`);
  if (answer.sources.length > 0) lines.push(`Sources: ${answer.sources.map((source) => `[${String(source.n)}] \`${slackPlain(place(source))}\``).join(" · ")}`);
  const page = answer.wikiPages[0];
  if (page !== undefined) lines.push(`Wiki: ${slackPlain(page.title)}`);
  return lines.join("\n");
}

export function createAnswerDoor(deps: AnswerDoorDeps): AnswerDoor {
  const delayMs = deps.lookingDelayMs ?? LOOKING_DELAY_MS;
  return async function answerDoor(message) {
    const fields = { eventId: message.eventId };
    const question = questionOf(message.text);
    const api = deps.api(message);
    if (question === undefined || api.askAnswer === undefined) {
      deps.log("answer.declined", { ...fields, reason: question === undefined ? "not_a_question" : "no_api" });
      return "declined";
    }
    const thread = message.thread;
    const choiceId = routedChoiceId(message.eventId);

    // "Looking..." only when the answer takes a moment, and only where the message can be edited into the answer afterwards.
    let looking: Promise<string | undefined> | undefined;
    const timer = deps.update === undefined ? undefined : setTimeout(() => {
      looking = deps.post(thread, SLACK_ANSWER_WORDS.looking).catch((error: unknown) => { deps.log("answer.looking_failed", { ...fields, errorName: errorName(error) }); return undefined; });
    }, delayMs);
    timer?.unref();

    let result: SlackAnswerResult | undefined;
    try {
      result = await api.askAnswer({ requestId: choiceId, question });
    } catch (error) {
      deps.log("answer.failed", { ...fields, errorName: errorName(error) });
    }
    if (timer !== undefined) clearTimeout(timer);
    const lookingTs = looking === undefined ? undefined : await looking;

    if (result?.status === "declined") {
      deps.log("answer.declined", { ...fields, reason: result.reason });
      // The "Looking..." line of an answer that was not made goes away; the caller then does what it did before.
      if (lookingTs !== undefined) await deps.remove?.(thread, lookingTs).catch((error: unknown) => deps.log("answer.looking_not_removed", { ...fields, errorName: errorName(error) }));
      return "declined";
    }

    // Said in fixed words, in the same message.
    if (result === undefined || result.status === "refused") {
      deps.log("answer.refused", { ...fields, reason: result?.reason ?? "unavailable" });
      await deliver({ thread, lookingTs, text: REFUSAL_WORDS[result?.reason ?? "unavailable"], fields });
      return "handled";
    }

    const { answer, attach } = result;
    const text = answerSlackText(answer);
    let button: { requesterId: string; choiceId: string } | undefined;
    if (answer.action !== undefined && attach !== undefined) {
      try {
        const saved = await deps.choices.save({ thread, userId: message.userId, choiceId, instructions: `${question}\n\n${attach}`, cardText: text });
        // This request's message was already posted (a redelivery): nothing more is said.
        if (saved === "posted") { deps.log("answer.already_posted", fields); return "handled"; }
        if (saved === "saved") button = { requesterId: message.userId, choiceId };
      } catch (error) {
        deps.log("answer.choice_not_saved", { ...fields, errorName: errorName(error) });
      }
    }
    const card = slackAnswerCard({ text, ...(button === undefined ? {} : { button }) });
    const ts = await deliver({ thread, lookingTs, text: card.text, blocks: card.blocks, fields });
    deps.log("answer.posted", { ...fields, outcome: answer.outcome, button: button !== undefined, sources: answer.sources.length });
    if (button !== undefined) {
      if (ts === undefined) await deps.choices.discard(thread, choiceId).catch((error: unknown) => deps.log("answer.choice_discard_failed", { ...fields, errorName: errorName(error) }));
      else await deps.choices.attachMessage(thread, choiceId, ts).catch((error: unknown) => deps.log("answer.choice_unrecorded", { ...fields, errorName: errorName(error) }));
    }
    return "handled";
  };

  /** Puts the words in Slack: the "Looking..." line edited, or one new message. Answers the message's timestamp, or undefined when nothing could be put there. Never throws. */
  async function deliver(input: { thread: SlackThread; lookingTs: string | undefined; text: string; blocks?: unknown[]; fields: Record<string, string> }): Promise<string | undefined> {
    const { thread, lookingTs, text, blocks, fields } = input;
    if (lookingTs !== undefined && deps.update !== undefined) {
      try {
        await deps.update(thread, lookingTs, text, blocks);
        return lookingTs;
      } catch (error) {
        // The edit failed: one new message, and the old line goes away if it can.
        deps.log("answer.update_failed", { ...fields, errorName: errorName(error) });
      }
    }
    let ts: string | undefined;
    try {
      ts = await deps.post(thread, text, blocks);
    } catch (error) {
      deps.log("answer.post_failed", { ...fields, errorName: errorName(error) });
      return undefined;
    }
    if (lookingTs !== undefined) await deps.remove?.(thread, lookingTs).catch((error: unknown) => deps.log("answer.looking_not_removed", { ...fields, errorName: errorName(error) }));
    return ts;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * The saved request behind the answer's one button, on the Slack threads table: the Quick choice item (`workflowChoicePut`) with the answer's own words kept on it (`cardText`), so no press or failed start
 * ever replaces the answer with a card question, and with no suggestion (so a typed `answer` is not offered and the card's telemetry is not counted). It may replace an earlier answer's choice that nobody
 * pressed; it never replaces a card question that waits, or a choice somebody already pressed (`selectedPath` is set the moment a press takes it, and stays while a failed start is retried).
 */
export function createAnswerChoices(deps: {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  log: ServiceLog;
  now?: () => number;
}): AnswerChoices {
  const now = deps.now ?? Date.now;
  return {
    async save(input) {
      const put = workflowChoicePut({ thread: input.thread, userId: input.userId, instructions: input.instructions, choiceId: input.choiceId, nowMs: now() });
      try {
        await deps.documentClient.send(new PutCommand({
          TableName: deps.tableName,
          Item: { ...put.Item, cardText: input.cardText, fromAnswer: true },
          ConditionExpression: `${put.ConditionExpression} OR (fromAnswer = :answer AND choiceId <> :choiceId AND attribute_not_exists(selectedPath))`,
          ExpressionAttributeValues: { ...put.ExpressionAttributeValues, ":answer": true },
        }));
        return "saved";
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
      // Not saved: this very request's message already went out, or something else waits in the thread.
      const current = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: workflowChoiceKey(input.thread), ConsistentRead: true })) as { Item?: Record<string, unknown> };
      return current.Item?.choiceId === input.choiceId && typeof current.Item.messageTs === "string" ? "posted" : "taken";
    },
    async attachMessage(thread, choiceId, ts) {
      try {
        await deps.documentClient.send(new UpdateCommand({ TableName: deps.tableName, ...workflowChoiceQuestionUpdate(thread, choiceId, ts) }));
      } catch (error) {
        // Already pressed and forgotten: nothing is left to attach to.
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    },
    async discard(thread, choiceId) {
      try {
        await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: workflowChoiceKey(thread), ConditionExpression: "choiceId = :choiceId", ExpressionAttributeValues: { ":choiceId": choiceId } }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    },
  };
}
