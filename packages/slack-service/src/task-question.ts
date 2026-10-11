// A reply that mentions AgentX in a Slack-started task's own thread. The ingress saved it as a thread note first; this
// decides whether it is a question. A question gets a read-only answer from the chat agent (no tools, only what the
// broker says about the task), and its note is then marked answered so the next step skips it. Anything else, and any
// failure on the way, leaves the note as an instruction for the next step, and the sender is told so privately.
import {
  TASK_NOTE_SAVED_TEXT,
  slackThreadSubject,
  splitSlackMessage,
  type SlackRequestMessage,
  type SlackThread,
  type SlackThreadNoteAnsweredRequest,
  type TaskQuestionRoute,
} from "@agentx/contracts";
import { NO_TEXT_RESPONSE } from "@agentx/orchestrator/orchestrator";
import type { RequestRoute, RequestRouter } from "@agentx/orchestrator/request-router";
import { deterministicUuid, requestIdSequence } from "./ids.js";
import type { ServiceLog, ThreadServiceApi, TurnInput } from "./processor.js";
import { slackReplyText } from "./slack-format.js";

export { TASK_NOTE_SAVED_TEXT };
/** The line the service ends every posted answer with (the model does not write it): the answered reply is not an instruction. */
export const TASK_ANSWER_FOOTER = "_This was answered as a question, so it won't be passed to the next step. To give an instruction instead, reply without @mentioning AgentX._";
/** Said privately when the question could not be answered: the message still waits for the next step. */
export const TASK_ANSWER_FAILED_TEXT = "I couldn't answer that just now; your message is saved for the next step.";

export interface TaskQuestionDependencies {
  /** The classifier model's router. Absent (it is not available here): nothing is classified, so the note stays an instruction. */
  route?: RequestRouter;
  /** Runs the read-only answer turn for the question (its text without any `chat:` prefix) and returns the answer. */
  answer(question: string): Promise<string>;
  /** Posts a visible reply in the task's thread. */
  post(thread: SlackThread, text: string): Promise<void>;
  /** Posts a message only `userId` sees, in the thread. */
  postPrivate(thread: SlackThread, userId: string, text: string): Promise<void>;
  /** Marks the saved note answered. */
  markAnswered(input: SlackThreadNoteAnsweredRequest): Promise<void>;
  /** Lowers the thread's queued-request count; the ingress raised it when it sent this message. */
  finish(subject: string): Promise<void>;
  log: ServiceLog;
  now?: () => number;
}

/** The text after a leading `chat:` (any case), or the text itself when it has none. */
export function withoutChatPrefix(text: string): string {
  return text.replace(/^\s*chat\s*:/iu, "").trim();
}

/**
 * Handles one queued task-thread mention. Never throws: the note is already saved, every failure leaves it as an
 * instruction, and the thread's count is lowered on every path (a redelivery could only repeat a question).
 */
export async function handleTaskQuestion(message: SlackRequestMessage, route: TaskQuestionRoute, deps: TaskQuestionDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const fields = { eventId: message.eventId, taskId: route.taskId };
  try {
    const startedAt = now();
    let question = route.chat;
    if (!route.chat) {
      let sorted: RequestRoute;
      if (deps.route === undefined) {
        sorted = { kind: "unclear", outcome: "unavailable" };
      } else {
        try {
          sorted = await deps.route(message.text);
        } catch {
          sorted = { kind: "unclear", outcome: "invalid" };
        }
      }
      question = sorted.kind === "question";
      // Never the text or the model's reason.
      deps.log("task_question.classified", { ...fields, kind: sorted.kind, outcome: sorted.outcome, latencyMs: Math.max(0, now() - startedAt) });
    } else {
      deps.log("task_question.classified", { ...fields, kind: "question", outcome: "chat_prefix", latencyMs: 0 });
    }
    if (!question) {
      await tell(message, deps, TASK_NOTE_SAVED_TEXT);
      return;
    }
    let reply: string;
    try {
      const answer = await deps.answer(withoutChatPrefix(message.text));
      reply = slackReplyText(answer);
    } catch (error) {
      deps.log("task_question.answer_failed", { ...fields, errorName: errorName(error) });
      await tell(message, deps, TASK_ANSWER_FAILED_TEXT);
      return;
    }
    try {
      for (const chunk of splitSlackMessage(`<@${message.userId}> ${reply}`)) await deps.post(message.thread, chunk);
    } catch (error) {
      // The answer may not have reached the thread, so the note stays an instruction.
      deps.log("task_question.answer_post_failed", { ...fields, errorName: errorName(error) });
      await tell(message, deps, TASK_ANSWER_FAILED_TEXT);
      return;
    }
    try {
      // The fixed line is its own message, so a long answer is never cut around it. The answer already reached the thread.
      await deps.post(message.thread, TASK_ANSWER_FOOTER);
    } catch (error) {
      deps.log("task_question.footer_post_failed", { ...fields, errorName: errorName(error) });
    }
    try {
      await deps.markAnswered({ taskId: route.taskId, messageTs: route.noteTs, thread: message.thread });
    } catch (error) {
      // The answer stands; the note is still read as an instruction by the next step.
      deps.log("task_question.mark_failed", { ...fields, errorName: errorName(error) });
    }
  } finally {
    try {
      await deps.finish(slackThreadSubject(message.thread));
    } catch (error) {
      deps.log("task_question.finish_failed", { ...fields, errorName: errorName(error) });
    }
  }
}

async function tell(message: SlackRequestMessage, deps: TaskQuestionDependencies, text: string): Promise<void> {
  try {
    await deps.postPrivate(message.thread, message.userId, text);
  } catch (error) {
    deps.log("task_question.private_post_failed", { eventId: message.eventId, errorName: errorName(error) });
  }
}

/**
 * The read-only answer turn: the broker's task-mode workspace for the task's own thread (nothing is prepared or run on
 * it), its untrusted-data task context as the turn's note, and a turn with no tools and no saved session.
 */
export async function runTaskAnswer(
  message: SlackRequestMessage,
  /** A thread question's route, or a task page comment being answered (spec 061 slice 2). */
  taskAnswer: TaskQuestionRoute | { taskId: string; commentId: string },
  question: string,
  deps: { api: ThreadServiceApi; runTurn: (input: TurnInput) => Promise<string>; handoff?: AbortSignal },
): Promise<string> {
  if (deps.api.taskAnswerWorkspace === undefined) throw new Error("task answers are unavailable in this deployment");
  const requestId = deterministicUuid(`${message.eventId}:task-answer`);
  const workspace = "commentId" in taskAnswer
    ? await deps.api.taskAnswerWorkspace(requestId, taskAnswer.taskId, taskAnswer.commentId)
    : await deps.api.taskAnswerWorkspace(requestId, taskAnswer.taskId);
  if (workspace.outcome !== "WORKSPACE" || workspace.mode !== "task-answer" || workspace.taskContext === undefined) {
    throw new Error("the task's thread cannot be answered in task mode");
  }
  const answer = await deps.runTurn({
    message: { ...message, text: question },
    subject: slackThreadSubject(message.thread),
    workspaceId: workspace.workspaceId,
    // Nothing reads the conversation of a turn with no tools.
    conversationId: deterministicUuid(`${message.eventId}:task-answer-conversation`),
    orchestratorInstructions: workspace.orchestratorInstructions,
    requestId: requestIdSequence(message.eventId),
    turnNote: workspace.taskContext,
    answerOnly: true,
    ...(deps.handoff === undefined ? {} : { signal: deps.handoff }),
  });
  // A turn stopped at the hand-off returns whatever text it had (or the no-text line) instead of throwing; neither is an
  // answer, so the sender gets the private fallback and the note stays an instruction.
  if (deps.handoff?.aborted === true) throw Object.assign(new Error("the answer was stopped by a restart"), { name: "TurnHandedOffError" });
  if (answer.trim().length === 0 || answer === NO_TEXT_RESPONSE) throw Object.assign(new Error("the model gave no answer"), { name: "EmptyAnswerError" });
  return answer;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
