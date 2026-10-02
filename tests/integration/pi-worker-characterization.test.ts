// tests/integration/pi-worker-characterization.test.ts
// Spec 050 phase 1: pins what Pi 0.85.1 does in the worker's real Pi session, so the 0.99.2 upgrade
// cannot change it unnoticed. Every session goes through pi-session.ts's own path,
// createWorkspacePiSession / openRegisteredWorkspacePiSession with createDefaultPiSessionAdapter, and only
// the model runtime is swapped for Pi's scripted faux model. Offline.
// Characterization: every expected value below was observed on 0.85.1, then pinned exactly.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, type Context, type FauxResponseStep, type TranscriptContext } from "@earendil-works/pi-ai";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { WorkerInvocation } from "../../packages/contracts/src/index.js";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { DevcontainerPaths } from "../../packages/worker/src/devcontainer.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { AGENTX_GIT_IDENTITY_ENVIRONMENT } from "../../packages/worker/src/git.js";
import { createDefaultPiSessionAdapter, createWorkspacePiSession, openRegisteredWorkspacePiSession, type PiSessionAdapter, type PiSessionHandle } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const keys = (value: unknown): string[] => Object.keys(value as object).sort();
const toolUse = (...calls: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
// structuredClone keeps a key whose value is undefined, so the key pins below see every key Pi sets.
const snapshot = <T>(value: T): T => structuredClone(value);
/**
 * What the model is offered on one call: the system prompt, the conversation and the tool names. The context
 * holds tool functions, which structuredClone refuses, so the messages are copied through JSON.
 * The only code phase 2 may change: read the prompt/tools from the leading system message (pi-ai getCurrentSystemPrompt).
 */
type ModelView = { systemPrompt: string | undefined; messages: Context["messages"]; tools: string[] };
// Spec 050 phase 2 (allowed edit 1): Pi 0.86+ carries the prompt and tools in the leading system message (TranscriptContext).
const modelView = (context: TranscriptContext): ModelView => ({
  systemPrompt: getCurrentSystemPrompt(context.messages),
  messages: JSON.parse(JSON.stringify(context.messages.filter((message) => (message as { role: string }).role !== "system"))) as Context["messages"],
  tools: getCurrentTools(context.messages).map((tool) => tool.name),
});
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const anyNumber = expect.any(Number) as number;
type Event = Record<string, unknown> & { type: string; message?: Record<string, unknown> };
// Pi's faux provider streams in randomly sized chunks, so a run of message_update events is pinned as one.
const eventOrder = (events: Event[]) => events.map((event) => event.type).filter((type, index, all) => type !== "message_update" || all[index - 1] !== "message_update");

/** A workspace root with a preparation manifest, as the worker prepares one. */
async function workspaceRoot(repositories: Array<{ name: string; path: string }> = []): Promise<string> {
  const rootPath = await createFixtureDirectory("agentx-char-worker-");
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "char", projectRevision: 1, repositories, completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

/** The worker's real session on the faux model: the default adapter with only its model runtime supplied. */
async function workerSession(responses: FauxResponseStep[], options: {
  rootPath?: string; conversationId?: string; bashOperations?: BashOperations; devcontainerPaths?: DevcontainerPaths;
} = {}) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  const adapter = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const rootPath = options.rootPath ?? await workspaceRoot();
  const handle = await createWorkspacePiSession({
    rootPath, model: FAUX_MODEL,
    ...(options.conversationId === undefined ? {} : { conversationId: options.conversationId }),
    ...(options.bashOperations === undefined ? {} : { bashOperations: options.bashOperations }),
    ...(options.devcontainerPaths === undefined ? {} : { devcontainerPaths: options.devcontainerPaths }),
  }, adapter);
  const events: Event[] = [];
  handle.subscribe((event) => { events.push(snapshot(event) as Event); });
  return { handle, faux, adapter, rootPath, events };
}

/** A shell that runs nothing: it records each call and prints the given output. */
function recordingShell(output = "pinned\n") {
  const calls: Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv | undefined }> = [];
  const operations: BashOperations = {
    exec: async (command, cwd, options) => {
      calls.push({ command, cwd, env: options.env });
      options.onData(Buffer.from(output));
      return { exitCode: 0 };
    },
  };
  return { calls, operations };
}

async function sessionEntries(sessionFile: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(sessionFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function settle(handle: PiSessionHandle, text: string): Promise<string> {
  return handle.prompt(text).then(() => "resolved", (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`);
}

describe("the worker's Pi session on Pi 0.85.1", () => {
  it("runs a plain turn: persisted session file, stable conversation ID, the configured model, and these stats", async () => {
    // protects packages/worker/src/pi-session.ts (createDefaultSession handle); guards: SessionStats and session ID changes (0.99)
    const views: ModelView[] = [];
    const { handle, rootPath } = await workerSession([(context) => { views.push(modelView(context)); return fauxAssistantMessage("Hello."); }]);
    try {
      const conversationId = handle.conversationId;
      expect(await settle(handle, "hi")).toBe("resolved");
      expect(existsSync(handle.sessionFile)).toBe(true);
      expect(dirname(handle.sessionFile)).toBe(join(await realpath(rootPath), "agent-sessions"));
      // Without a broker-issued ID the conversation ID is Pi's session ID, a UUIDv7 that names the session file.
      expect(conversationId).toMatch(UUID_V7);
      expect(handle.conversationId).toBe(conversationId);
      expect(basename(handle.sessionFile)).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z_${conversationId}\\.jsonl$`));
      // Spec 053: getModel also reports the level the session used; the scripted model does not reason, so "off".
      expect(handle.getModel()).toEqual({ provider: "agentx-faux", modelId: "scripted", thinkingLevel: "off" });
      const stats = handle.getSessionStats();
      expect(keys(stats)).toEqual(["assistantMessages", "contextUsage", "cost", "sessionFile", "sessionId", "tokens", "toolCalls", "toolResults", "totalMessages", "userMessages"]);
      expect(keys(stats.tokens)).toEqual(["cacheRead", "cacheWrite", "input", "output", "total"]);
      expect(keys(stats.contextUsage)).toEqual(["contextWindow", "percent", "tokens"]);
      expect({ userMessages: stats.userMessages, assistantMessages: stats.assistantMessages, toolCalls: stats.toolCalls, toolResults: stats.toolResults, totalMessages: stats.totalMessages })
        .toEqual({ userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2 });
      expect({ sessionFile: stats.sessionFile, sessionId: stats.sessionId, cost: stats.cost }).toEqual({ sessionFile: handle.sessionFile, sessionId: conversationId, cost: 0 });
      // The faux model estimates tokens from the prompt's length, which includes this checkout's paths, so
      // only what the readers rely on is pinned: whole numbers, a positive total (swebench/agent.ts:79).
      for (const value of Object.values(stats.tokens)) expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      expect(stats.tokens.total).toBeGreaterThan(0);
      // Ruling D (Pi 0.86+): the prompt and tools are persisted as a leading system message entry, so one more "message".
      expect((await sessionEntries(handle.sessionFile)).map((entry) => entry.type)).toEqual(["session", "model_change", "thinking_level_change", "message", "message", "message"]);
      // Exactly Pi's seven built-in tools, bash being AgentX's shell: no MCP, codemode or tool_search tool is offered.
      expect(views).toHaveLength(1);
      expect([...views[0]!.tools].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
    } finally { handle.dispose(); }
  });

  it("keeps a broker-issued conversation ID instead of Pi's session ID", async () => {
    // protects packages/worker/src/pi-session.ts (conversationId ?? session.sessionId)
    const { handle } = await workerSession([fauxAssistantMessage("Hello.")], { conversationId: "33333333-3333-4333-8333-333333333333" });
    try {
      expect(await settle(handle, "hi")).toBe("resolved");
      expect(handle.conversationId).toBe("33333333-3333-4333-8333-333333333333");
      // Pi still names the session with its own UUIDv7; only the handle's conversation ID is the broker's.
      expect(handle.getSessionStats().sessionId).toMatch(UUID_V7);
    } finally { handle.dispose(); }
  });

  it("runs the model's bash call through AgentX's shell, in the workspace, and shows the model its output", async () => {
    // protects packages/worker/src/pi-session.ts (agentShellTool replaces the built-in bash); guards: customTools override and BashOperations changes (0.99)
    const shell = recordingShell();
    const contexts: ModelView[] = [];
    const { handle, rootPath } = await workerSession([
      toolUse(fauxToolCall("bash", { command: "echo pinned" }, { id: "call-bash-1" })),
      (context) => { contexts.push(modelView(context)); return fauxAssistantMessage("Done."); },
    ], { bashOperations: shell.operations });
    try {
      expect(await settle(handle, "run it")).toBe("resolved");
      expect(shell.calls.map(({ command, cwd }) => ({ command, cwd }))).toEqual([{ command: "echo pinned", cwd: await realpath(rootPath) }]);
      // The spawn hook adds AgentX's git identity to the shell's environment (#208).
      expect(Object.fromEntries(Object.keys(AGENTX_GIT_IDENTITY_ENVIRONMENT).map((name) => [name, shell.calls[0]!.env?.[name]]))).toEqual(AGENTX_GIT_IDENTITY_ENVIRONMENT);
      expect(contexts).toHaveLength(1);
      expect(contexts[0]!.messages.at(-1)).toEqual({
        role: "toolResult", toolCallId: "call-bash-1", toolName: "bash", content: [{ type: "text", text: "pinned\n" }], isError: false, timestamp: anyNumber,
      });
    } finally { handle.dispose(); }
  });

  it("resolves the devcontainer's repository path to the host file in read and edit", async () => {
    // protects packages/worker/src/pi-session.ts (devcontainerFileTools, #128); guards: built-in file tool definitions and edit arguments (0.99)
    const rootPath = await workspaceRoot();
    const hostFolder = join(rootPath, "repo");
    await mkdir(hostFolder);
    await writeFile(join(hostFolder, "a.txt"), "alpha\n");
    const results: unknown[] = [];
    const { handle } = await workerSession([
      toolUse(fauxToolCall("read", { path: "/workspaces/repo/a.txt" }, { id: "call-read-1" })),
      (context) => {
        results.push(modelView(context).messages.at(-1));
        return toolUse(fauxToolCall("edit", { path: "/workspaces/repo/a.txt", edits: [{ oldText: "alpha", newText: "beta" }] }, { id: "call-edit-1" }));
      },
      (context) => { results.push(modelView(context).messages.at(-1)); return fauxAssistantMessage("Edited."); },
    ], { rootPath, devcontainerPaths: { hostFolder, containerFolder: "/workspaces/repo" } });
    try {
      expect(await settle(handle, "edit a.txt")).toBe("resolved");
      const file = join(hostFolder, "a.txt");
      expect(results).toEqual([
        { role: "toolResult", toolCallId: "call-read-1", toolName: "read", content: [{ type: "text", text: "alpha\n" }], isError: false, timestamp: anyNumber },
        { role: "toolResult", toolCallId: "call-edit-1", toolName: "edit", content: [{ type: "text", text: `Successfully replaced 1 block(s) in ${file}.` }],
          details: { diff: "-1 alpha\n+1 beta", patch: `--- ${file}\n+++ ${file}\n@@ -1,1 +1,1 @@\n-alpha\n+beta\n`, firstChangedLine: 1 }, isError: false, timestamp: anyNumber },
      ]);
      expect(await readFile(file, "utf8")).toBe("beta\n");
      expect(existsSync("/workspaces/repo/a.txt")).toBe(false);
    } finally { handle.dispose(); }
  });

  it("gives the model the workspace note and each repository's context file in the system prompt", async () => {
    // protects packages/worker/src/pi-session.ts (createWorkerResources agentsFilesOverride) and repository-context.ts; guards: system prompt assembly (0.99)
    const rootPath = await workspaceRoot([{ name: "web", path: "repos/web" }]);
    await mkdir(join(rootPath, "repos/web"), { recursive: true });
    await writeFile(join(rootPath, "repos/web/AGENTS.md"), "PINNED: run npm test before committing.\n");
    const prompts: string[] = [];
    const { handle } = await workerSession([(context) => { prompts.push(modelView(context).systemPrompt ?? ""); return fauxAssistantMessage("Ok."); }], { rootPath });
    try {
      expect(await settle(handle, "go")).toBe("resolved");
      const root = await realpath(rootPath);
      expect(prompts).toHaveLength(1);
      const section = prompts[0]!.slice(prompts[0]!.indexOf("<project_context>"));
      // Ruling A (Pi 0.86+): sections are tag-wrapped (<project_context>, <cwd>) without the inner blank lines.
      expect(section).toBe([
        "<project_context>", "Project-specific instructions and guidelines:", "",
        "<project_instructions path=\"AgentX workspace\">",
        "AgentX workspace note (written by AgentX, not by any repository):",
        "The repository \"web\" is checked out at repos/web in this workspace. Make every change inside it; files outside it are not part of the repository or its pull request.",
        "</project_instructions>", "",
        `<project_instructions path="${root}/repos/web/AGENTS.md">`,
        "AGENTS.md of the \"web\" repository, checked out at repos/web in this workspace. Its guidance applies to the files under repos/web.", "",
        "PINNED: run npm test before committing.", "",
        "</project_instructions>", "</project_context>", "",
        "<cwd>", root, "</cwd>",
      ].join("\n"));
      // Ruling A: AgentX's own content reaches the model verbatim, whatever Pi's framing: the workspace note and the context file.
      expect(prompts[0]).toContain([
        "AgentX workspace note (written by AgentX, not by any repository):",
        "The repository \"web\" is checked out at repos/web in this workspace. Make every change inside it; files outside it are not part of the repository or its pull request.",
      ].join("\n"));
      expect(prompts[0]).toContain([
        "AGENTS.md of the \"web\" repository, checked out at repos/web in this workspace. Its guidance applies to the files under repos/web.", "",
        "PINNED: run npm test before committing.",
      ].join("\n"));
      expect(prompts[0]!.split("<project_context>")).toHaveLength(2);
      expect(prompts[0]!.startsWith("You are an expert coding assistant operating inside pi, a coding agent harness.")).toBe(true);
      // The prompt's section boundaries in order (headings ending in a colon, XML-ish tags, the working
      // directory line), so a section 0.99 inserts anywhere is caught. The temp root reads <ROOT>.
      const boundaries = prompts[0]!.split(root).join("<ROOT>").split("\n")
        .filter((line) => /^<\/?[a-z_]+( .*)?>$/.test(line) || /^[A-Z][^.]*:$/.test(line) || line.startsWith("Current working directory: "));
      // Ruling A (Pi 0.86+): the headings became tagged sections (<tools>, <rules>, <docs>, <cwd>); the order is unchanged.
      expect(boundaries).toEqual([
        "<tools>", "</tools>", "<rules>", "</rules>", "<docs>",
        "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):", "</docs>",
        "<project_context>", "Project-specific instructions and guidelines:",
        "<project_instructions path=\"AgentX workspace\">", "AgentX workspace note (written by AgentX, not by any repository):", "</project_instructions>",
        "<project_instructions path=\"<ROOT>/repos/web/AGENTS.md\">", "</project_instructions>",
        "</project_context>", "<cwd>", "</cwd>",
      ]);
    } finally { handle.dispose(); }
  });

  it("resumes a saved session: both prompts reach the model once, in order, and the file holds four messages", async () => {
    // protects packages/worker/src/pi-session.ts (openRegisteredWorkspacePiSession, SessionManager.open); guards: session file format and reopen (0.99)
    const { handle, rootPath, adapter, faux } = await workerSession([fauxAssistantMessage("One.")]);
    expect(await settle(handle, "first prompt")).toBe("resolved");
    const { conversationId, sessionFile } = handle;
    handle.dispose();
    const contexts: ModelView[] = [];
    faux.setResponses([(context) => { contexts.push(modelView(context)); return fauxAssistantMessage("Two."); }]);
    const resumed = await openRegisteredWorkspacePiSession({ rootPath, model: FAUX_MODEL, conversationId, sessionFile }, adapter);
    try {
      expect({ conversationId: resumed.conversationId, sessionFile: resumed.sessionFile }).toEqual({ conversationId, sessionFile });
      expect(await settle(resumed, "second prompt")).toBe("resolved");
      expect(contexts).toHaveLength(1);
      const messages = contexts[0]!.messages as Array<{ role: string; content: unknown }>;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      const userTexts = messages.filter((message) => message.role === "user").map((message) => (message.content as Array<{ text: string }>).map((block) => block.text).join(""));
      expect(userTexts).toEqual(["first prompt", "second prompt"]);
      expect(messages[1]!.content).toEqual([{ type: "text", text: "One." }]);
      const entries = await sessionEntries(sessionFile);
      expect(entries.map((entry) => [entry.type, (entry.message as { role?: string } | undefined)?.role])).toEqual([
        ["session", undefined], ["model_change", undefined], ["thinking_level_change", undefined],
        // Ruling D (Pi 0.86+): the leading system message entry that carries the prompt and tools; resume adds no second one.
        ["message", "system"],
        ["message", "user"], ["message", "assistant"], ["message", "user"], ["message", "assistant"],
      ]);
      // Ruling D: the four conversation messages, plus the one system message entry pinned above.
      expect(entries.filter((entry) => entry.type === "message" && (entry.message as { role?: string }).role !== "system")).toHaveLength(4);
      const stats = resumed.getSessionStats();
      expect({ userMessages: stats.userMessages, assistantMessages: stats.assistantMessages, totalMessages: stats.totalMessages }).toEqual({ userMessages: 2, assistantMessages: 2, totalMessages: 4 });
    } finally { resumed.dispose(); }
  });

  it("delivers a steer before the next model call, and ends an aborted turn with an error message_end and a resolved prompt", async () => {
    // protects packages/worker/src/pi-session.ts (steer, abort) and the loop guard's steer (tool-loop-guard.ts, run-task.ts:142-145); guards: steering queue and abort semantics (0.99)
    const shell = recordingShell("ok\n");
    const contexts: ModelView[] = [];
    const call = (n: number): FauxResponseStep => (context) => {
      contexts.push(modelView(context));
      return toolUse(fauxToolCall("bash", { command: `echo ${n}` }, { id: `call-${n}` }));
    };
    const { handle, events } = await workerSession([call(1), call(2), call(3), fauxAssistantMessage("Never sent.")], { bashOperations: shell.operations });
    let ended = 0;
    handle.subscribe((event) => {
      if ((event as Event).type !== "tool_execution_end") return;
      ended += 1;
      if (ended === 1) void handle.steer!("pinned steer");
      if (ended === 2) void handle.abort();
    });
    try {
      expect(await settle(handle, "loop")).toBe("resolved");
      expect(shell.calls.map((entry) => entry.command)).toEqual(["echo 1", "echo 2"]);
      // The third scripted call is never requested: the abort lands before the next model call.
      expect(contexts).toHaveLength(2);
      const userTexts = (contexts[1]!.messages as Array<{ role: string; content: unknown }>).filter((message) => message.role === "user")
        .map((message) => (message.content as Array<{ text: string }>).map((block) => block.text).join(""));
      expect(userTexts).toEqual(["loop", "pinned steer"]);
      expect((contexts[1]!.messages as Array<{ role: string }>).map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "user"]);
      const ends = events.filter((event) => event.type === "message_end").map((event) => event.message!);
      expect(ends.map((message) => [message.role, message.stopReason])).toEqual([
        ["user", undefined], ["assistant", "toolUse"], ["toolResult", undefined], ["user", undefined], ["assistant", "toolUse"], ["toolResult", undefined], ["assistant", "error"],
      ]);
      // Observed on 0.85.1: an abort between model calls is not stopReason "aborted". The next call fails
      // before it streams, and Pi reports it as an error with the AbortSignal's message.
      const last = ends.at(-1)!;
      // Ruling D (Pi 0.99+, additive): assistant messages also carry the thinkingLevel they ran at.
      expect(keys(last)).toEqual(["api", "content", "errorMessage", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"]);
      expect({ role: last.role, stopReason: last.stopReason, errorMessage: last.errorMessage, content: last.content }).toEqual({
        role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [],
      });
      expect(eventOrder(events)).toEqual([
        "agent_start", "turn_start", "message_start", "message_end",
        "message_start", "message_update", "message_end",
        "tool_execution_start", "tool_execution_update", "tool_execution_update", "tool_execution_end", "queue_update", "message_start", "message_end", "turn_end",
        "turn_start", "queue_update", "message_start", "message_end",
        "message_start", "message_update", "message_end",
        "tool_execution_start", "tool_execution_update", "tool_execution_update", "tool_execution_end", "message_start", "message_end", "turn_end",
        "turn_start", "message_start", "message_end", "turn_end", "agent_end", "agent_settled",
      ]);
    } finally { handle.dispose(); }
  });
});

/*
 * Fields the worker reads from Pi's session events and stats through untyped casts, so a 0.99 rename compiles and fails at run time:
 *   run-task.ts:137,431-436    eventType          <- event.type: "tool_execution_start", "tool_execution_end" ("tool_result" never reaches session.subscribe)
 *   run-task.ts:306-316        FileChangeAttempts <- tool_execution_start: type, toolCallId, toolName, args.path; tool_execution_end: type, toolCallId, toolName, isError, result
 *   run-task.ts:370-377        toolResultText     <- tool_execution_end.result.content[]: text
 *   run-task.ts:140,386-393    assistantOutcome   <- message_end: type, message.role, message.stopReason, message.errorMessage
 *   run-task.ts:257            usage telemetry    <- getSessionStats(): tokens.{input, output, cacheRead, cacheWrite, total}, cost (typed, contracts/src/usage.ts:25-28)
 *   tool-loop-guard.ts:38-58   ToolLoopGuard      <- tool_execution_start: type, toolCallId, toolName, args; tool_execution_end: type, toolCallId, toolName, isError, result
 *   tool-loop-guard.ts:78-83   normalizedError    <- tool_execution_end.result.content[]
 *   swebench/agent.ts:75,103-107 assistantEnd     <- message_end: type, message.role, message.stopReason, message.errorMessage
 *   swebench/agent.ts:78-79    cost checks        <- getSessionStats(): tokens.total, cost
 */
describe("the worker's message_end payloads on Pi 0.85.1", () => {
  it("pins message_end for a turn ending in toolUse, stop, error and aborted", async () => {
    // protects packages/worker/src/run-task.ts (assistantOutcome) and swebench/agent.ts (assistantEnd); guards: AssistantMessage and AgentEvent shape changes (0.99)
    const shell = recordingShell();
    const running: { handle?: PiSessionHandle } = {};
    const { handle, events } = await workerSession([
      toolUse(fauxToolCall("bash", { command: "echo pinned" }, { id: "call-bash-1" })),
      fauxAssistantMessage("Done."),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "pinned failure" }),
      // Aborts inside the faux factory, before the reply starts streaming: the stream sees an aborted signal
      // and ends as aborted ("Request was aborted"), unlike the between-calls abort in the steer test.
      () => { void running.handle!.abort(); return fauxAssistantMessage("A reply long enough to stream in more than one chunk."); },
    ], { bashOperations: shell.operations });
    running.handle = handle;
    try {
      expect(await settle(handle, "run it")).toBe("resolved");
      expect(await settle(handle, "fail")).toBe("resolved");
      expect(await settle(handle, "abort")).toBe("resolved");
      const assistantEnds = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
      expect(assistantEnds.map((event) => keys(event))).toEqual([["message", "type"], ["message", "type"], ["message", "type"], ["message", "type"]]);
      // Ruling D (Pi 0.99+, additive): assistant messages also carry the thinkingLevel they ran at.
      expect(assistantEnds.map((event) => keys(event.message))).toEqual([
        ["api", "content", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
        ["api", "content", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
        ["api", "content", "errorMessage", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
        ["api", "content", "errorMessage", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
      ]);
      expect(assistantEnds.map(({ message }) => ({ role: message!.role, stopReason: message!.stopReason, errorMessage: message!.errorMessage }))).toEqual([
        { role: "assistant", stopReason: "toolUse", errorMessage: undefined },
        { role: "assistant", stopReason: "stop", errorMessage: undefined },
        { role: "assistant", stopReason: "error", errorMessage: "pinned failure" },
        { role: "assistant", stopReason: "aborted", errorMessage: "Request was aborted" },
      ]);
      expect(assistantEnds.map(({ message }) => [message!.provider, message!.model])).toEqual(Array(4).fill(["agentx-faux", "scripted"]));
      expect(keys(assistantEnds[0]!.message!.usage)).toEqual(["cacheRead", "cacheWrite", "cost", "input", "output", "totalTokens"]);
      // The other message_end payloads, which the readers skip by role.
      const otherEnds = events.filter((event) => event.type === "message_end" && event.message?.role !== "assistant");
      expect(otherEnds.map((event) => [event.message!.role, keys(event.message)])).toEqual([
        ["user", ["content", "role", "timestamp"]],
        ["toolResult", ["content", "details", "isError", "role", "timestamp", "toolCallId", "toolName", "usage"]],
        ["user", ["content", "role", "timestamp"]],
        ["user", ["content", "role", "timestamp"]],
      ]);
      // Cross-check: every field assistantOutcome and assistantEnd take is there.
      for (const event of assistantEnds) {
        expect(keys(event)).toEqual(expect.arrayContaining(["type", "message"]));
        expect(keys(event.message)).toEqual(expect.arrayContaining(["role", "stopReason"]));
      }
      for (const event of assistantEnds.slice(2)) expect(keys(event.message)).toContain("errorMessage");
    } finally { handle.dispose(); }
  });
});

describe("the worker's session event shapes on Pi 0.85.1", () => {
  it("pins every event session.subscribe delivers in one turn with a tool call", async () => {
    // protects packages/worker/src/run-task.ts (event log, FileChangeAttempts, assistantOutcome), tool-loop-guard.ts and swebench/agent.ts; guards: AgentEvent union changes (0.99)
    const shell = recordingShell();
    const { handle, events } = await workerSession([
      toolUse(fauxToolCall("bash", { command: "echo pinned" }, { id: "call-bash-1" })),
      fauxAssistantMessage("Done."),
    ], { bashOperations: shell.operations });
    try {
      expect(await settle(handle, "run it")).toBe("resolved");
    } finally { handle.dispose(); }

    // The worker loads no extensions, so Pi's extension-only events (tool_call, tool_result, context, ...)
    // never reach session.subscribe; run-task.ts's "tool_result" branch is unreachable on this path.
    expect(eventOrder(events)).toEqual([
      "agent_start", "turn_start", "message_start", "message_end",
      "message_start", "message_update", "message_end",
      "tool_execution_start", "tool_execution_update", "tool_execution_update", "tool_execution_end", "message_start", "message_end", "turn_end",
      "turn_start", "message_start", "message_update", "message_end", "turn_end",
      "agent_end", "agent_settled",
    ]);
    const one = (type: string) => {
      const matches = events.filter((event) => event.type === type);
      expect(matches, type).toHaveLength(1);
      return matches[0]!;
    };
    const start = one("tool_execution_start");
    const end = one("tool_execution_end");
    const agentEnd = one("agent_end");
    expect(keys(one("agent_start"))).toEqual(["type"]);
    expect(keys(one("agent_settled"))).toEqual(["type"]);
    expect(events.filter((event) => event.type === "turn_start").map((event) => keys(event))).toEqual([["type"], ["type"]]);
    const messageUpdates = events.filter((event) => event.type === "message_update");
    expect(messageUpdates.length).toBeGreaterThan(0);
    expect(messageUpdates.map((event) => keys(event))).toEqual(Array(messageUpdates.length).fill(["assistantMessageEvent", "message", "type"]));
    expect(events.filter((event) => event.type === "message_start").map((event) => keys(event))).toEqual(Array(4).fill(["message", "type"]));

    expect(keys(start)).toEqual(["args", "toolCallId", "toolName", "type"]);
    expect(start).toEqual({ type: "tool_execution_start", toolCallId: "call-bash-1", toolName: "bash", args: { command: "echo pinned" } });
    const updates = events.filter((event) => event.type === "tool_execution_update");
    expect(updates).toEqual([
      { type: "tool_execution_update", toolCallId: "call-bash-1", toolName: "bash", args: { command: "echo pinned" }, partialResult: { content: [] } },
      { type: "tool_execution_update", toolCallId: "call-bash-1", toolName: "bash", args: { command: "echo pinned" }, partialResult: { content: [{ type: "text", text: "pinned\n" }], details: {} } },
    ]);
    expect(keys(end)).toEqual(["isError", "result", "toolCallId", "toolName", "type"]);
    // The result carries a details key whose value is undefined; toEqual ignores undefined, so it is pinned on its own.
    // Ruling D (Pi 0.99+, additive): bash results also carry structuredContent (the form codemode scripts read); the model still gets content.
    expect(end).toEqual({ type: "tool_execution_end", toolCallId: "call-bash-1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "pinned\n" }], details: undefined,
      structuredContent: { exit_code: 0, output: "pinned\n", truncated: false, wall_time_seconds: anyNumber } } });
    expect(keys(end.result)).toEqual(["content", "details", "structuredContent"]);
    expect((end.result as { details?: unknown }).details).toBeUndefined();

    const messageEnds = events.filter((event) => event.type === "message_end");
    expect(messageEnds.map((event) => keys(event))).toEqual(Array(4).fill(["message", "type"]));
    // Ruling D (Pi 0.99+, additive): assistant messages also carry the thinkingLevel they ran at.
    expect(messageEnds.map((event) => keys(event.message))).toEqual([
      ["content", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
      ["content", "details", "isError", "role", "timestamp", "toolCallId", "toolName", "usage"],
      ["api", "content", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
    ]);
    const turnEnds = events.filter((event) => event.type === "turn_end");
    expect(turnEnds.map((event) => keys(event))).toEqual([["message", "toolResults", "type"], ["message", "toolResults", "type"]]);
    expect(turnEnds.map((event) => (event.toolResults as unknown[]).length)).toEqual([1, 0]);

    expect(keys(agentEnd)).toEqual(["messages", "type", "willRetry"]);
    expect(agentEnd.willRetry).toBe(false);
    const messages = agentEnd.messages as Array<Record<string, unknown>>;
    // Ruling D (Pi 0.99+, additive): assistant messages also carry the thinkingLevel they ran at.
    expect(messages.map((message) => keys(message))).toEqual([
      ["content", "role", "timestamp"],
      ["api", "content", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
      ["content", "details", "isError", "role", "timestamp", "toolCallId", "toolName", "usage"],
      ["api", "content", "model", "provider", "role", "stopReason", "thinkingLevel", "timestamp", "usage"],
    ]);
    expect(messages.map((message) => [message.role, message.stopReason])).toEqual([["user", undefined], ["assistant", "toolUse"], ["toolResult", undefined], ["assistant", "stop"]]);
    expect(messages.at(-1)!.content).toEqual([{ type: "text", text: "Done." }]);

    // Cross-check: every field a reader above takes is in the pinned shapes.
    expect(keys(start)).toEqual(expect.arrayContaining(["type", "toolCallId", "toolName", "args"]));
    expect(keys(end)).toEqual(expect.arrayContaining(["type", "toolCallId", "toolName", "isError", "result"]));
    expect((end.result as { content: Array<Record<string, unknown>> }).content.map((block) => keys(block))).toEqual([["text", "type"]]);
    for (const event of messageEnds) expect(keys(event)).toEqual(expect.arrayContaining(["type", "message"]));
    for (const event of messageEnds) expect(keys(event.message)).toContain("role");
    for (const event of messageEnds.filter((entry) => entry.message!.role === "assistant")) expect(keys(event.message)).toContain("stopReason");
  });
});

/**
 * A task cancelled while its bash call runs, through runTaskInvocation and the real cancellation controller.
 * The adapter is the default one; the wrapper only subscribes, and cancels when `cancelOn` first matches.
 */
async function cancelDuringTool(command: string, cancelOn: (event: Event) => boolean) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  let factoryCalls = 0;
  faux.setResponses([
    () => { factoryCalls += 1; return toolUse(fauxToolCall("bash", { command }, { id: "call-cancel-1" })); },
    () => { factoryCalls += 1; return fauxAssistantMessage("Done."); },
  ]);
  const base = createDefaultPiSessionAdapter({ modelRuntime: async () => ({ runtime: modelRuntime, model: FAUX_MODEL }) });
  const cancellation = new WorkerCancellationController();
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "run it" },
  };
  let cancelled = false;
  const piAdapter: PiSessionAdapter = {
    async create(input) {
      const handle = await base.create(input);
      handle.subscribe((event) => {
        if (cancelled || !cancelOn(event as Event)) return;
        cancelled = true;
        void cancellation.cancel(invocation.operationId);
      });
      return handle;
    },
  };
  const workerEvents: WorkerEvent[] = [];
  const started = performance.now();
  const failure = await runTaskInvocation(invocation, {
    rootPath: await workspaceRoot(), model: FAUX_MODEL, piAdapter, cancellationController: cancellation,
    eventSink: async (batch) => { workerEvents.push(...batch); }, artifactSink: async () => undefined,
  }).then(() => undefined, (error: unknown) => error);
  return { failure, elapsed: performance.now() - started, factoryCalls, workerEvents };
}

/** What the worker reports for a cancelled task, besides its progress stream. */
function cancelledReport(run: Awaited<ReturnType<typeof cancelDuringTool>>) {
  const assistantEnds = run.workerEvents.flatMap((event) => {
    const payload = event.payload as Event;
    return event.type === "progress" && payload.type === "message_end" && payload.message?.role === "assistant" ? [payload.message] : [];
  });
  return {
    types: run.workerEvents.filter((event) => event.type !== "progress").map((event) => event.type),
    lifecycle: run.workerEvents.filter((event) => event.type === "lifecycle").map((event) => (event.payload as { status: string }).status),
    toolEnd: run.workerEvents.filter((event) => event.type === "tool_end").map((event) => event.payload),
    usageOutcome: run.workerEvents.filter((event) => event.type === "usage").map((event) => (event.payload as { outcome: string }).outcome),
    lastAssistant: assistantEnds.map((message) => ({ stopReason: message.stopReason, errorMessage: message.errorMessage })).at(-1),
  };
}

describe("cancelling a worker task during a tool call on Pi 0.85.1", () => {
  // Guards finishTurn (0.99): a cancel during a tool must abort the tool, end the task CANCELLED with no
  // result, and never call the model again. F3 (the loop calling the model after an aborted tool) is refuted on 0.85.1.
  it("aborts a running bash call, ends the task CANCELLED, and never calls the model again", async () => {
    // protects packages/worker/src/run-task.ts (cancellation outcome) and cancel.ts (cancel -> session.abort)
    const run = await cancelDuringTool("echo started; sleep 5", (event) =>
      event.type === "tool_execution_update" && JSON.stringify(event.partialResult).includes("started"));
    expect(run.failure).toBeInstanceOf(WorkerOperationCancelledError);
    expect(cancelledReport(run)).toEqual({
      types: ["lifecycle", "tool_start", "tool_end", "lifecycle", "usage"],
      lifecycle: ["RUNNING", "CANCELLED"],
      toolEnd: [{ type: "tool_execution_end", toolCallId: "call-cancel-1", toolName: "bash", isError: true,
        result: { content: [{ type: "text", text: "started\n\n\nCommand aborted" }], details: {} } }],
      usageOutcome: ["CANCELLED"],
      // Pi starts the next turn, but its model call fails before the scripted model is asked.
      lastAssistant: { stopReason: "error", errorMessage: "This operation was aborted" },
    });
    expect(run.factoryCalls).toBe(1);
    // The 5 s sleep was killed, not waited out.
    expect(run.elapsed).toBeLessThan(3_000);
  });

  it("ends a bash call cancelled as it starts with \"Operation aborted\", and the task CANCELLED", async () => {
    // protects packages/worker/src/run-task.ts (cancellation outcome) and cancel.ts (cancel -> session.abort)
    const run = await cancelDuringTool("true", (event) => event.type === "tool_execution_start");
    expect(run.failure).toBeInstanceOf(WorkerOperationCancelledError);
    expect(cancelledReport(run)).toEqual({
      types: ["lifecycle", "tool_start", "tool_end", "lifecycle", "usage"],
      lifecycle: ["RUNNING", "CANCELLED"],
      toolEnd: [{ type: "tool_execution_end", toolCallId: "call-cancel-1", toolName: "bash", isError: true,
        result: { content: [{ type: "text", text: "Operation aborted" }], details: {} } }],
      usageOutcome: ["CANCELLED"],
      lastAssistant: { stopReason: "error", errorMessage: "This operation was aborted" },
    });
    expect(run.factoryCalls).toBe(1);
  });
});
