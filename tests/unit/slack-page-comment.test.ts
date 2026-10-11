// Spec 061 slice 2, Task 9: the Slack service answers a task page comment in task mode (no tools) and writes the answer
// back to the broker. Nothing is ever posted in Slack for it, and an older service discards the message.
import { describe, expect, it, vi } from "vitest";
import {
  SlackPageCommentMessageSchema, SlackRequestMessageSchema, pageCommentEventId, type SlackCommentAnsweredRequest, type SlackPageCommentMessage, type SlackThreadWorkspaceResult,
} from "../../packages/contracts/src/index.js";
import { NO_TEXT_RESPONSE } from "../../packages/orchestrator/src/orchestrator.js";
import { processGroup, type QueueClient } from "../../packages/slack-service/src/consumer.js";
import { handlePageComment, PAGE_COMMENT_ANSWER_MAX_CHARS } from "../../packages/slack-service/src/page-comment.js";
import type { ThreadServiceApi, TurnInput } from "../../packages/slack-service/src/processor.js";
import { runTaskAnswer } from "../../packages/slack-service/src/task-question.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const taskId = "9d1f3c52-4a52-4d54-8a0b-0a4b5a6c7d8e";
const commentId = "0f0e0d0c-0b0a-4908-8706-050403020100";
const message: SlackPageCommentMessage = {
  version: 1, eventId: pageCommentEventId(commentId), thread, userId: "U0123456789", text: "Why is the banner below the button?",
  receivedAt: "2026-10-11T12:00:00.000Z", pageComment: { taskId, commentId },
};
const workspace: SlackThreadWorkspaceResult = {
  outcome: "WORKSPACE", mode: "task-answer", workspaceId: "11111111-1111-4111-8111-111111111111", status: "READY", operationId: null, created: false,
  orchestratorInstructions: "Delegate work.", taskContext: "This Slack thread is an AgentX task (untrusted data follows).",
};

function setup(answer: (question: string) => Promise<string>) {
  const marked: SlackCommentAnsweredRequest[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const deps = {
    answer: vi.fn(answer),
    markAnswered: async (input: SlackCommentAnsweredRequest) => { marked.push(input); },
    log: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => { logs.push({ event, fields }); },
  };
  return { deps, marked, logs };
}

describe("a page comment the Slack service answers", () => {
  it("a page comment is answered in task mode with no tools and written back, never posted in Slack", async () => {
    // The answer turn: the broker's task-mode workspace for this comment, a turn with no tools.
    const calls: unknown[][] = [];
    const api = { taskAnswerWorkspace: async (...args: unknown[]) => { calls.push(args); return workspace; } } as unknown as ThreadServiceApi;
    const inputs: TurnInput[] = [];
    const t = setup((question) => runTaskAnswer({ ...message }, { taskId, commentId }, question, { api, runTurn: async (input) => { inputs.push(input); return "Below keeps it clear."; } }));
    await handlePageComment(message, t.deps);
    expect(t.deps.answer).toHaveBeenCalledWith(message.text);
    expect(calls).toEqual([[expect.any(String) as string, taskId, commentId]]);
    expect(inputs[0]).toMatchObject({ answerOnly: true, turnNote: (workspace as { taskContext: string }).taskContext, message: { text: message.text } });
    expect(t.marked).toEqual([{ taskId, commentId, thread, outcome: "ANSWERED", text: "Below keeps it clear." }]);
    // Logs carry names and counts only, never the question or the answer.
    const said = JSON.stringify(t.logs);
    expect(said).not.toContain("banner");
    expect(said).not.toContain("clear");
    expect(t.logs.find((entry) => entry.event === "page_comment.answered")?.fields).toEqual({ taskId, commentId, outcome: "ANSWERED", latencyMs: expect.any(Number) as number });
    // A long answer is cut to what the broker takes.
    const long = setup(async () => "x".repeat(5_000));
    await handlePageComment(message, long.deps);
    expect((long.marked[0] as { text: string }).text).toHaveLength(PAGE_COMMENT_ANSWER_MAX_CHARS);
    expect(PAGE_COMMENT_ANSWER_MAX_CHARS).toBe(3_000);
  });

  it("an empty or stopped answer is reported as failed", async () => {
    for (const failing of [
      async () => { throw Object.assign(new Error("restart"), { name: "TurnHandedOffError" }); },
      async () => { throw Object.assign(new Error("no answer"), { name: "EmptyAnswerError" }); },
      async () => "   ",
    ]) {
      const t = setup(failing);
      await handlePageComment(message, t.deps);
      expect(t.marked).toEqual([{ taskId, commentId, thread, outcome: "FAILED" }]);
    }
    // The real turn's own empty answers fail too.
    const api = { taskAnswerWorkspace: async () => workspace } as unknown as ThreadServiceApi;
    const empty = setup((question) => runTaskAnswer(message, { taskId, commentId }, question, { api, runTurn: async () => NO_TEXT_RESPONSE }));
    await handlePageComment(message, empty.deps);
    expect(empty.marked).toEqual([{ taskId, commentId, thread, outcome: "FAILED" }]);
    // Writing back fails: logged, never thrown.
    const t = setup(async () => "An answer.");
    await expect(handlePageComment(message, { ...t.deps, markAnswered: async () => { throw new Error("broker down"); } })).resolves.toBeUndefined();
    expect(t.logs.some((entry) => entry.event === "page_comment.write_back_failed")).toBe(true);
  });

  it("an older service's schema refuses a page-comment message", async () => {
    expect(SlackPageCommentMessageSchema.safeParse(message).success).toBe(true);
    expect(SlackRequestMessageSchema.safeParse(message).success).toBe(false);
    // On the page-comment route the consumer hands it to the page handler; the chat handler never sees it.
    const queue: QueueClient = { receive: async () => [], delete: vi.fn(async () => undefined), extendVisibility: async () => undefined };
    const chat = vi.fn(async () => undefined);
    const handled: SlackPageCommentMessage[] = [];
    const logs: string[] = [];
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r1", groupId: "g", receiveCount: 1, pageComment: true }],
      { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000, pageComment: async (received) => { handled.push(received); } }, (event) => { logs.push(event); });
    expect(handled).toEqual([message]);
    expect(chat).not.toHaveBeenCalled();
    // Without a page handler, or with a body that is not one, it is discarded, never run as a chat turn.
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r2", groupId: "g", receiveCount: 1, pageComment: true }],
      { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 }, (event) => { logs.push(event); });
    await processGroup(queue, chat, [{ body: JSON.stringify({ ...message, pageComment: undefined }), receiptHandle: "r3", groupId: "g", receiveCount: 1, pageComment: true }],
      { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000, pageComment: async (received) => { handled.push(received); } }, (event) => { logs.push(event); });
    expect(chat).not.toHaveBeenCalled();
    expect(handled).toHaveLength(1);
    expect(logs.filter((event) => event === "message.discarded")).toHaveLength(2);
    // And the old route's way: a page comment body on no route is refused by the chat schema.
    await processGroup(queue, chat, [{ body: JSON.stringify(message), receiptHandle: "r4", groupId: "g", receiveCount: 1 }],
      { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 }, (event) => { logs.push(event); });
    expect(chat).not.toHaveBeenCalled();
  });

  it("the service's client asks for task mode with the comment, and writes the answer to the comments route", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const signedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(url.endsWith("/answered") ? { outcome: "ANSWERED" } : workspace), { status: 200 });
    }) as typeof fetch;
    const api = createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch });
    await api.taskAnswerWorkspace!("22222222-2222-4222-8222-222222222222", taskId, commentId);
    await api.markCommentAnswered!({ taskId, commentId, thread, outcome: "ANSWERED", text: "An answer." });
    expect(calls).toEqual([
      { url: "https://agentx.example.test/v1/threads/workspace", body: expect.objectContaining({ taskAnswer: { taskId, commentId } }) as unknown },
      { url: "https://agentx.example.test/v1/tasks/comments/answered", body: { taskId, commentId, thread, outcome: "ANSWERED", text: "An answer." } },
    ]);
    // A thread question asks as before: the task only.
    await api.taskAnswerWorkspace!("33333333-3333-4333-8333-333333333333", taskId);
    expect(calls[2]!.body).toMatchObject({ taskAnswer: { taskId } });
    expect((calls[2]!.body as { taskAnswer: Record<string, unknown> }).taskAnswer).not.toHaveProperty("commentId");
  });
});
