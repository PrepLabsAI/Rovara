// Spec 061 slice 2: a task page comment someone asked AgentX to answer. The broker queued it on the Slack request queue
// (its own route and a body an older service refuses). The answer comes from the same read-only task mode as a thread
// question (no tools; only what the broker says about the task, the comment's place and its thread, all as untrusted
// data), and is written back to the broker, which shows it on the page as AgentX's reply. Nothing is posted in Slack, and
// the thread's queued-request count is never touched (the ingress never raised it for this message).
import type { SlackCommentAnsweredRequest, SlackPageCommentMessage } from "@agentx/contracts";
import type { ServiceLog } from "./processor.js";

/** The most characters of an answer the broker keeps. */
export const PAGE_COMMENT_ANSWER_MAX_CHARS = 3_000;

export interface PageCommentDependencies {
  /** Runs the task-mode answer turn for the comment's text and returns the answer; throws when there is none. */
  answer(question: string): Promise<string>;
  /** Writes the answer, or that there is none, back to the broker. */
  markAnswered(input: SlackCommentAnsweredRequest): Promise<void>;
  log: ServiceLog;
  now?: () => number;
}

/** Answers one queued page comment. Never throws and never posts in Slack: every failure is written back as FAILED. */
export async function handlePageComment(message: SlackPageCommentMessage, deps: PageCommentDependencies): Promise<void> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const { taskId, commentId } = message.pageComment;
  let result: SlackCommentAnsweredRequest;
  try {
    const answer = (await deps.answer(message.text)).trim();
    if (answer === "") throw Object.assign(new Error("the model gave no answer"), { name: "EmptyAnswerError" });
    result = { taskId, commentId, thread: message.thread, outcome: "ANSWERED", text: Array.from(answer).slice(0, PAGE_COMMENT_ANSWER_MAX_CHARS).join("") };
  } catch (error) {
    deps.log("page_comment.answer_failed", { taskId, commentId, errorName: error instanceof Error ? error.name : "unknown" });
    result = { taskId, commentId, thread: message.thread, outcome: "FAILED" };
  }
  try {
    await deps.markAnswered(result);
    deps.log("page_comment.answered", { taskId, commentId, outcome: result.outcome, latencyMs: Math.max(0, now() - startedAt) });
  } catch (error) {
    deps.log("page_comment.write_back_failed", { taskId, commentId, outcome: result.outcome, errorName: error instanceof Error ? error.name : "unknown" });
  }
}
