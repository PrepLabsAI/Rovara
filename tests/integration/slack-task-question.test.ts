// Slice 1.1 Task 8: a task-thread mention the Slack service answers as a question (read only, no tools) or confirms as saved.
import { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  slackThreadSubject, type RequestRouteKind, type RequestRouteOutcome, type SlackRequestMessage, type SlackThreadWorkspaceResult, type TaskQuestionRoute,
} from "../../packages/contracts/src/index.js";
import { ANSWER_ONLY_INSTRUCTIONS, NO_TEXT_RESPONSE, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { processGroup, type QueueClient } from "../../packages/slack-service/src/consumer.js";
import type { ThreadServiceApi, TurnInput } from "../../packages/slack-service/src/processor.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import {
  TASK_ANSWER_FAILED_TEXT, TASK_ANSWER_FOOTER, TASK_NOTE_SAVED_TEXT, handleTaskQuestion, runTaskAnswer, withoutChatPrefix, type TaskQuestionDependencies,
} from "../../packages/slack-service/src/task-question.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import { StrictSlackWeb } from "../support/strict-slack.js";

const thread = { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" };
const taskId = "9d1f3c52-4a52-4d54-8a0b-0a4b5a6c7d8e";
const noteTs = "1695500002.000007";
const message: SlackRequestMessage = { version: 1, eventId: "Ev0000000077", thread, userId: "U0123456789", text: "What does the plan cover?", receivedAt: "2026-10-09T12:00:00.000Z" };
const route: TaskQuestionRoute = { taskId, noteTs, chat: false };

type Log = Array<{ event: string; fields: Readonly<Record<string, string | number | boolean>> }>;

function setup(options: {
  kind?: RequestRouteKind; outcome?: RequestRouteOutcome; router?: "none" | "throws"; answer?: () => Promise<string>; mark?: () => Promise<void>; finish?: () => Promise<void>;
} = {}) {
  const slack = new StrictSlackWeb({ briefLimit: 1_200 });
  const logs: Log = [];
  const routerCalls: string[] = [];
  const answerCalls: string[] = [];
  const marked: Array<{ taskId: string; messageTs: string; thread: typeof thread }> = [];
  const finished: string[] = [];
  const deps: TaskQuestionDependencies = {
    ...(options.router === "none" ? {} : {
      route: async (text) => {
        routerCalls.push(text);
        if (options.router === "throws") throw new Error("model down");
        return { kind: options.kind ?? "question", outcome: options.outcome ?? "ok" };
      },
    }),
    answer: async (question) => {
      answerCalls.push(question);
      return options.answer === undefined ? "The plan covers the greeting change." : options.answer();
    },
    post: async (target, text) => { slack.post({ channel: target.channelId, threadTs: target.threadTs, text }); },
    postPrivate: async (target, user, text) => { slack.postEphemeral({ channel: target.channelId, threadTs: target.threadTs, user, text }); },
    markAnswered: async (input) => {
      if (options.mark !== undefined) await options.mark();
      marked.push(input);
    },
    finish: async (subject) => {
      if (options.finish !== undefined) await options.finish();
      finished.push(subject);
    },
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  return { slack, logs, routerCalls, answerCalls, marked, finished, deps, subject: slackThreadSubject(thread) };
}

describe("a task-thread mention the router calls a question", () => {
  it("posts the answer in the thread, then marks the saved note answered, and counts the message done", async () => {
    const t = setup();
    await handleTaskQuestion(message, route, t.deps);
    expect(t.routerCalls).toEqual([message.text]);
    expect(t.answerCalls).toEqual([message.text]);
    // The answer, then the fixed line as its own post.
    expect(t.slack.posts.map((post) => [post.threadTs, post.text])).toEqual([
      [thread.threadTs, `<@${message.userId}> The plan covers the greeting change.`],
      [thread.threadTs, TASK_ANSWER_FOOTER],
    ]);
    expect(TASK_ANSWER_FOOTER).toBe("_This was answered as a question, so it won't be passed to the next step. To give an instruction instead, reply without @mentioning AgentX._");
    expect(t.slack.ephemerals).toEqual([]);
    expect(t.marked).toEqual([{ taskId, messageTs: noteTs, thread }]);
    expect(t.finished).toEqual([t.subject]);
    // The log says how it was sorted, never the text.
    expect(t.logs.find((entry) => entry.event === "task_question.classified")?.fields).toEqual({ eventId: message.eventId, taskId, kind: "question", outcome: "ok", latencyMs: expect.any(Number) as number });
    expect(JSON.stringify(t.logs)).not.toContain(message.text);
  });

  it("escapes the answer like any reply, so a model's mention does not notify anyone", async () => {
    const t = setup({ answer: async () => "Ask <!channel> or see **the plan**." });
    await handleTaskQuestion(message, route, t.deps);
    expect(t.slack.posts[0]!.text).toBe(`<@${message.userId}> Ask &lt;!channel&gt; or see *the plan*.`);
  });

  it("posts the fixed line as its own message after a long answer, once, and never inside the answer's messages", async () => {
    const t = setup({ answer: async () => Array.from({ length: 80 }, (_, index) => `Line ${index} ${"x".repeat(60)}`).join("\n") });
    // Long enough to split into several posts, which the harness's brief limit would refuse, so the posts are collected here.
    const posted: string[] = [];
    await handleTaskQuestion(message, route, { ...t.deps, post: async (_target, text) => { posted.push(text); } });
    expect(posted.length).toBeGreaterThan(2);
    expect(posted.at(-1)).toBe(TASK_ANSWER_FOOTER);
    expect(posted.filter((text) => text.includes(TASK_ANSWER_FOOTER))).toHaveLength(1);
  });

  it("still marks the note answered and says nothing more when only the fixed line could not be posted", async () => {
    const t = setup();
    let calls = 0;
    await handleTaskQuestion(message, route, { ...t.deps, post: async (target, text) => { calls += 1; if (text === TASK_ANSWER_FOOTER) throw new Error("rate limited"); await t.deps.post(target, text); } });
    expect(calls).toBe(2);
    expect(t.slack.posts).toHaveLength(1);
    expect(t.slack.ephemerals).toEqual([]);
    expect(t.marked).toEqual([{ taskId, messageTs: noteTs, thread }]);
    expect(t.logs.some((entry) => entry.event === "task_question.footer_post_failed")).toBe(true);
  });

  it("keeps the answer and logs when the note cannot be marked", async () => {
    const t = setup({ mark: async () => { throw Object.assign(new Error("broker said no"), { name: "ForbiddenError" }); } });
    await handleTaskQuestion(message, route, t.deps);
    expect(t.slack.posts).toHaveLength(2);
    expect(t.slack.ephemerals).toEqual([]);
    expect(t.marked).toEqual([]);
    expect(t.logs.find((entry) => entry.event === "task_question.mark_failed")?.fields).toEqual({ eventId: message.eventId, taskId, errorName: "ForbiddenError" });
    expect(t.finished).toEqual([t.subject]);
  });
});

describe("a task-thread mention that is not a question", () => {
  const cases: ReadonlyArray<readonly [string, Parameters<typeof setup>[0]]> = [
    ["small_change", { kind: "small_change" }],
    ["large_change", { kind: "large_change" }],
    ["unclear", { kind: "unclear" }],
    ["a classifier timeout", { kind: "unclear", outcome: "timeout" }],
    ["an unusable classifier answer", { kind: "unclear", outcome: "invalid" }],
    ["a router that throws", { router: "throws" }],
    ["no router", { router: "none" }],
  ];
  it.each(cases)("says only the private saved message for %s, and answers and marks nothing", async (_name, options) => {
    const t = setup(options);
    await handleTaskQuestion(message, route, t.deps);
    expect(t.slack.posts).toEqual([]);
    expect(t.slack.ephemerals).toEqual([{ channel: thread.channelId, threadTs: thread.threadTs, user: message.userId, text: TASK_NOTE_SAVED_TEXT }]);
    expect(TASK_NOTE_SAVED_TEXT).toBe("Saved for the next step.");
    expect(t.answerCalls).toEqual([]);
    expect(t.marked).toEqual([]);
    expect(t.finished).toEqual([t.subject]);
  });

  it("still counts the message done when the private message cannot be posted", async () => {
    const t = setup({ kind: "small_change" });
    t.slack.failNext("chat.postEphemeral", "channel_not_found");
    await expect(handleTaskQuestion(message, route, t.deps)).resolves.toBeUndefined();
    expect(t.logs.map((entry) => entry.event)).toContain("task_question.private_post_failed");
    expect(t.finished).toEqual([t.subject]);
  });
});

describe("a task-thread mention starting with chat:", () => {
  it.each(["chat: why is it waiting?", "CHAT:why is it waiting?", "  Chat :   why is it waiting?"])("is a question without asking the router (%s), with the prefix stripped", async (text) => {
    const t = setup({ kind: "large_change" });
    await handleTaskQuestion({ ...message, text }, { ...route, chat: true }, t.deps);
    expect(t.routerCalls).toEqual([]);
    expect(t.answerCalls).toEqual(["why is it waiting?"]);
    expect(t.slack.posts).toHaveLength(2);
    expect(t.marked).toHaveLength(1);
    expect(withoutChatPrefix(text)).toBe("why is it waiting?");
  });

  it("is still a question when no router is available", async () => {
    const t = setup({ router: "none" });
    await handleTaskQuestion({ ...message, text: "chat: status?" }, { ...route, chat: true }, t.deps);
    expect(t.answerCalls).toEqual(["status?"]);
    expect(t.marked).toHaveLength(1);
  });
});

describe("a question whose answer fails", () => {
  it("says the private fallback, does not mark the note, and counts the message done", async () => {
    const t = setup({ answer: async () => { throw Object.assign(new Error("model unavailable"), { name: "RuntimeUnavailable" }); } });
    await handleTaskQuestion(message, route, t.deps);
    expect(t.slack.posts).toEqual([]);
    expect(t.slack.ephemerals).toEqual([{ channel: thread.channelId, threadTs: thread.threadTs, user: message.userId, text: TASK_ANSWER_FAILED_TEXT }]);
    expect(TASK_ANSWER_FAILED_TEXT).toBe("I couldn't answer that just now; your message is saved for the next step.");
    expect(t.marked).toEqual([]);
    expect(t.logs.find((entry) => entry.event === "task_question.answer_failed")?.fields).toEqual({ eventId: message.eventId, taskId, errorName: "RuntimeUnavailable" });
    expect(t.finished).toEqual([t.subject]);
  });

  it("does the same when the answer cannot be posted", async () => {
    const t = setup();
    t.slack.failNext("chat.postMessage", "is_archived");
    await handleTaskQuestion(message, route, t.deps);
    expect(t.marked).toEqual([]);
    expect(t.slack.ephemerals.map((entry) => entry.text)).toEqual([TASK_ANSWER_FAILED_TEXT]);
    expect(t.finished).toEqual([t.subject]);
  });

  it("does not fail the message when the done count cannot be lowered", async () => {
    const t = setup({ finish: async () => { throw Object.assign(new Error("DynamoDB unavailable"), { name: "InternalServerError" }); } });
    await expect(handleTaskQuestion(message, route, t.deps)).resolves.toBeUndefined();
    expect(t.logs.at(-1)).toEqual({ event: "task_question.finish_failed", fields: { eventId: message.eventId, taskId, errorName: "InternalServerError" } });
  });
});

describe("the queue's task-question route", () => {
  it("hands the task, note and chat mark to the handler, and nothing for an ordinary request", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const queue: QueueClient = { receive: async () => [], delete: async () => undefined, extendVisibility: async () => undefined };
    const body = JSON.stringify(message);
    await processGroup(queue, async (_message, context) => { contexts.push(context); },
      [{ body, receiptHandle: "r1", groupId: "g", receiveCount: 1, taskQuestion: { ...route, chat: true } }, { body, receiptHandle: "r2", groupId: "g", receiveCount: 1 }],
      { maxReceiveCount: 5, visibilitySeconds: 900, heartbeatMilliseconds: 60_000 }, () => undefined);
    expect(contexts.map((context) => context.taskQuestion)).toEqual([{ taskId, noteTs, chat: true }, undefined]);
  });
});

describe("the service's task-mode client calls", () => {
  const recorded = () => {
    const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const signedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push({ url, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify(url.endsWith("/answered") ? { outcome: "ANSWERED" } : { outcome: "WORKSPACE", mode: "task-answer", workspaceId: "11111111-1111-4111-8111-111111111111",
        status: "READY", operationId: null, created: false, orchestratorInstructions: "Delegate.", taskContext: "Untrusted." }), { status: 200 });
    }) as typeof fetch;
    return { calls, api: createThreadApi({ controlPlaneUrl: "https://agentx.example.test", signedFetch }) };
  };

  it("asks for task mode with the task's ID on the workspace route", async () => {
    const { calls, api } = recorded();
    const result = await api.taskAnswerWorkspace!("22222222-2222-4222-8222-222222222222", taskId);
    expect(result).toMatchObject({ outcome: "WORKSPACE", mode: "task-answer", taskContext: "Untrusted." });
    expect(calls).toEqual([{ url: "https://agentx.example.test/v1/threads/workspace", method: "POST",
      body: expect.objectContaining({ requestId: "22222222-2222-4222-8222-222222222222", taskAnswer: { taskId } }) as unknown }]);
  });

  it("marks a note answered with the task, the note's timestamp and the thread", async () => {
    const { calls, api } = recorded();
    await api.markThreadNoteAnswered!({ taskId, messageTs: noteTs, thread });
    expect(calls).toEqual([{ url: "https://agentx.example.test/v1/tasks/thread-notes/answered", method: "POST", body: { taskId, messageTs: noteTs, thread } }]);
  });
});

describe("the task-mode answer turn", () => {
  const workspace: SlackThreadWorkspaceResult = {
    outcome: "WORKSPACE", mode: "task-answer", workspaceId: "11111111-1111-4111-8111-111111111111", status: "READY", operationId: null, created: false,
    orchestratorInstructions: "Delegate work.", taskContext: "This Slack thread is an AgentX task (untrusted data follows).\nTitle: Add a greeting",
  };
  const apiWith = (answer: SlackThreadWorkspaceResult | Error): { api: ThreadServiceApi; calls: Array<[string, string]> } => {
    const calls: Array<[string, string]> = [];
    const taskAnswerWorkspace: ThreadServiceApi["taskAnswerWorkspace"] = async (requestId, id) => { calls.push([requestId, id]); if (answer instanceof Error) throw answer; return answer; };
    return { calls, api: { taskAnswerWorkspace } as unknown as ThreadServiceApi };
  };

  it("runs a tool-less turn on the task's context with the question, and nothing is prepared or saved", async () => {
    const api = apiWith(workspace);
    const inputs: TurnInput[] = [];
    const answer = await runTaskAnswer({ ...message, text: "chat: why?" }, { ...route, chat: true }, "why?", { api: api.api, runTurn: async (input) => { inputs.push(input); return "Because."; } });
    expect(answer).toBe("Because.");
    expect(api.calls).toEqual([[expect.any(String) as string, taskId]]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      message: { text: "why?", userId: message.userId }, subject: slackThreadSubject(thread), workspaceId: workspace.workspaceId,
      orchestratorInstructions: "Delegate work.", turnNote: (workspace as { taskContext: string }).taskContext, answerOnly: true,
    });
    for (const absent of ["worker", "connectors", "repositories", "gate", "actionPolicy", "recoverableOperations", "computePrepared", "recorder"]) expect(inputs[0]).not.toHaveProperty(absent);
  });

  it("thread questions are unchanged", async () => {
    // A thread question asks for the task's context with the task only: no page comment rides along.
    const args: unknown[][] = [];
    const api = { taskAnswerWorkspace: async (...given: unknown[]) => { args.push(given); return workspace; } } as unknown as ThreadServiceApi;
    await runTaskAnswer(message, route, "why?", { api, runTurn: async () => "Because." });
    expect(args).toEqual([[expect.any(String) as string, taskId]]);
  });

  it("fails when the hand-off signal was aborted by the time the turn returned, whatever text it gave", async () => {
    const handoff = new AbortController();
    const api = apiWith(workspace).api;
    const runTurn = async () => { handoff.abort(); return "Partial answ"; };
    await expect(runTaskAnswer(message, route, "why?", { api, runTurn, handoff: handoff.signal })).rejects.toThrow("restart");
  });

  it.each(["", "   \n", NO_TEXT_RESPONSE])("fails when the model gave no answer (%j)", async (text) => {
    await expect(runTaskAnswer(message, route, "why?", { api: apiWith(workspace).api, runTurn: async () => text })).rejects.toThrow("no answer");
  });

  it("gives the private fallback and does not mark the note when the answer turn was handed off or empty", async () => {
    for (const failure of ["handoff", "empty"] as const) {
      const handoff = new AbortController();
      const t = setup({ answer: () => runTaskAnswer(message, route, message.text, { api: apiWith(workspace).api, handoff: handoff.signal,
        runTurn: async () => { if (failure === "handoff") handoff.abort(); return failure === "handoff" ? "Partial" : NO_TEXT_RESPONSE; } }) });
      await handleTaskQuestion(message, route, t.deps);
      expect(t.slack.posts, failure).toEqual([]);
      expect(t.slack.ephemerals.map((entry) => entry.text), failure).toEqual([TASK_ANSWER_FAILED_TEXT]);
      expect(t.marked, failure).toEqual([]);
      expect(t.finished, failure).toEqual([t.subject]);
    }
  });

  it("fails, running no turn, when the broker does not give a task-mode workspace", async () => {
    for (const answer of [{ ...workspace, mode: undefined, taskContext: undefined }, { outcome: "VIEW_ONLY", taskId, closed: true }, new Error("broker down")] as const) {
      const runTurn = vi.fn(async () => "never");
      await expect(runTaskAnswer(message, route, "why?", { api: apiWith(answer as SlackThreadWorkspaceResult | Error).api, runTurn })).rejects.toThrow();
      expect(runTurn).not.toHaveBeenCalled();
    }
  });
});

describe("a hosted task-mode turn", () => {
  const input: TurnInput = {
    message, subject: slackThreadSubject(thread), workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "33333333-3333-4333-8333-333333333333",
    orchestratorInstructions: "Delegate work.", requestId: () => "44444444-4444-4444-8444-444444444444",
    turnNote: "This Slack thread is an AgentX task (untrusted data follows).\nTitle: Add a greeting",
    answerOnly: true,
    // Even if a caller passed these, an answer-only turn offers none of them.
    connectors: [{ name: "tracker", type: "tracker", label: "Tracker", scopes: ["payments"], connected: true }],
    repositories: ["payments"],
  };
  const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });

  it("exposes zero tools even when the model asks to submit a task, and tells the model what it can do", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    let first = "";
    faux.setResponses([(context: Context) => {
      first = JSON.stringify(context.messages);
      return toolUse(fauxToolCall("agentx_submit_task", { prompt: "Rewrite everything." }), fauxToolCall("tracker__list_items", {}));
    }, fauxAssistantMessage([fauxText("I can only answer questions about this task.")])]);
    const api = {
      discoverConnectorTools: vi.fn(), callConnectorTool: vi.fn(),
      submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn(),
    } satisfies OrchestrationApi;
    const runtime = await createHostedSlackRuntime(input, { stateDirectory: await createFixtureDirectory("agentx-task-answer-"), api, model: FAUX_MODEL, modelRuntime });
    try {
      expect(runtime.session.systemPrompt).toContain(ANSWER_ONLY_INSTRUCTIONS);
      // The real options only: a reply without a mention is used at the next step, Request changes edits the document, and nothing is promised.
      expect(ANSWER_ONLY_INSTRUCTIONS).toBe("You are answering a question about this AgentX task. You cannot change the task, start work, or read code. If the question needs code investigation, say so. A reply without @mentioning AgentX is used at the next step; Request changes on the card changes the current document. Never promise to change anything yourself.");
      expect(ANSWER_ONLY_INSTRUCTIONS).not.toMatch(/suggest (asking|posting)/);
      // No capabilities list of tools and repositories is shown either.
      expect(runtime.session.systemPrompt).not.toContain("What this channel can do");
      const reply = await runOrchestratorTurn(runtime, "What does the plan cover?");
      expect(reply).toBe("I can only answer questions about this task.");
      expect(runtime.session.getActiveToolNames()).toEqual([]);
      expect(runtime.session.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin")).toEqual([]);
      // The task's context reaches the model as the turn's note.
      expect(first).toContain("Title: Add a greeting");
      const results = runtime.session.messages.flatMap((entry) => {
        const result = entry as { role?: string; toolName?: string; isError?: boolean };
        return result.role === "toolResult" ? [[result.toolName, result.isError]] : [];
      });
      expect(results).toEqual([["agentx_submit_task", true], ["tracker__list_items", true]]);
    } finally { await runtime.dispose(); }
    for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
  });

  it("keeps every tool for an ordinary turn", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    faux.setResponses([fauxAssistantMessage([fauxText("Ok.")])]);
    const api = { submitTask: vi.fn(), taskStatus: vi.fn(), taskResult: vi.fn(), followUp: vi.fn(), createPullRequest: vi.fn(), managePullRequest: vi.fn(), pullRequestResult: vi.fn() } satisfies OrchestrationApi;
    const { answerOnly: _answerOnly, connectors: _connectors, ...ordinary } = input;
    void _answerOnly;
    void _connectors;
    const runtime = await createHostedSlackRuntime(ordinary, { stateDirectory: await createFixtureDirectory("agentx-ordinary-"), api, model: FAUX_MODEL, modelRuntime });
    try {
      expect(runtime.session.systemPrompt).not.toContain(ANSWER_ONLY_INSTRUCTIONS);
      expect(runtime.session.getActiveToolNames()).toContain("agentx_submit_task");
      await runOrchestratorTurn(runtime, "hi");
    } finally { await runtime.dispose(); }
  });
});
