import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { REPEAT_LIMIT, REPEAT_WARNING_AT, TOOL_CALL_LIMIT, ToolLoopGuard, type ToolLoopAction } from "../../packages/worker/src/tool-loop-guard.js";

const GIT_ADD = "cd /workspaces/sample-project-a && git add. && git commit -m 'Add Notes API and UI for demo' && git log -1";

function toolCall(args: unknown, outcome: { isError: boolean; text: string }, toolName = "bash") {
  const toolCallId = randomUUID();
  return [
    { type: "tool_execution_start", toolCallId, toolName, args },
    { type: "tool_execution_end", toolCallId, toolName, isError: outcome.isError, result: { content: [{ type: "text", text: outcome.text }] } },
  ];
}

const failing = (command: string, text = "git: 'add.' is not a git command.\n\nCommand exited with code 1") =>
  toolCall({ command }, { isError: true, text });

function actions(guard: ToolLoopGuard, events: unknown[]): ToolLoopAction[] {
  return events.map((event) => guard.observe(event)).filter((action) => action.kind !== "none");
}

describe("the tool loop guard", () => {
  it("warns once at the third identical failure and stops at the fifth", () => {
    const guard = new ToolLoopGuard();
    const seen = Array.from({ length: REPEAT_LIMIT }, (_, index) => ({ index: index + 1, actions: actions(guard, failing(GIT_ADD)) }));
    expect(seen.filter((entry) => entry.actions.length > 0).map((entry) => [entry.index, entry.actions[0]!.kind])).toEqual([
      [REPEAT_WARNING_AT, "warn"],
      [REPEAT_LIMIT, "stop"],
    ]);
    const stop = seen.at(-1)!.actions[0]!;
    expect(stop.kind === "stop" && stop.error.message).toBe(
      "OPERATION_INTERRUPTED: the agent repeated the same failing bash call 5 times with the same error; stopped it. Rephrase the request or check the error it hit.",
    );
  });

  it("treats errors that differ only in digits as the same, and any success as the end of a streak", () => {
    const guard = new ToolLoopGuard();
    const run = (seconds: number) => failing("npm test", `Tests 1 failed\nStart at 22:17:${seconds}\nDuration ${seconds}ms`);
    expect(actions(guard, [...run(1), ...run(2)])).toEqual([]);
    expect(actions(guard, run(3))).toEqual([expect.objectContaining({ kind: "warn" })]);
    // An edit between runs is ordinary debugging, not a loop: the streak starts again. The model
    // was already warned about this exact failure, so it is not warned twice; the limit still holds.
    const edit = toolCall({ path: "src/app.ts", oldText: "a", newText: "b" }, { isError: false, text: "ok" }, "edit");
    expect(actions(guard, [...edit, ...run(4), ...run(5), ...run(6), ...run(7)])).toEqual([]);
    expect(actions(guard, run(8))).toEqual([expect.objectContaining({ kind: "stop" })]);
  });

  it("does not count different commands, different errors or repeated successful calls", () => {
    const guard = new ToolLoopGuard();
    const events = [
      ...failing("git add."), ...failing("git add ."), ...failing("git add. -A"),
      ...failing("npm test", "error one"), ...failing("npm test", "error two"), ...failing("npm test", "error three"),
      ...Array.from({ length: 10 }, () => toolCall({ command: "npm test" }, { isError: false, text: "Tests 7 passed" })).flat(),
    ];
    expect(actions(guard, events)).toEqual([]);
  });

  it("does not let a successful read, grep, find or ls end a failing edit streak (#158)", () => {
    const guard = new ToolLoopGuard();
    const failingEdit = () => toolCall(
      { path: "README.md", edits: [{ oldText: "a", newText: "b" }] },
      { isError: true, text: "Could not find the exact text in README.md. The old text must match exactly including all whitespace and newlines." },
      "edit",
    );
    const lookups = [
      toolCall({ path: "README.md" }, { isError: false, text: "# Title" }, "read"),
      toolCall({ pattern: "Title" }, { isError: false, text: "README.md:1" }, "grep"),
      toolCall({ pattern: "*.md" }, { isError: false, text: "README.md" }, "find"),
      toolCall({ path: "." }, { isError: false, text: "README.md" }, "ls"),
      toolCall({ path: "README.md" }, { isError: false, text: "# Title" }, "read"),
    ];
    const found = lookups.flatMap((lookup) => actions(guard, [...lookup, ...failingEdit()]));
    expect(found.map((action) => action.kind)).toEqual(["warn", "stop"]);
    const stop = found.at(-1)!;
    expect(stop.kind === "stop" && stop.error.message).toMatch(/repeated the same failing edit call 5 times/);
  });

  it("matches arguments regardless of key order", () => {
    const guard = new ToolLoopGuard();
    const events = [
      ...toolCall({ path: "a.ts", limit: 10 }, { isError: true, text: "ENOENT" }, "read"),
      ...toolCall({ limit: 10, path: "a.ts" }, { isError: true, text: "ENOENT" }, "read"),
      ...toolCall({ path: "a.ts", limit: 10 }, { isError: true, text: "ENOENT" }, "read"),
    ];
    expect(actions(guard, events)).toEqual([expect.objectContaining({ kind: "warn" })]);
  });

  it(`stops a task that starts more than ${TOOL_CALL_LIMIT} tool calls`, () => {
    const guard = new ToolLoopGuard();
    const calls = Array.from({ length: TOOL_CALL_LIMIT + 1 }, (_, index) => toolCall({ command: `echo ${index}` }, { isError: false, text: "ok" })).flat();
    const found = actions(guard, calls);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind === "stop" && found[0]!.error.message).toMatch(/more than 200 tool calls/);
  });
});

describe("a task whose model loops on a failing call", () => {
  it("steers the model once, then aborts and fails the task with the reason", async () => {
    const rootPath = await preparedRoot();
    const steered: string[] = [];
    let aborted = false;
    let listener: ((event: unknown) => void) | undefined;
    const adapter: PiSessionAdapter = {
      async create({ sessionDirectory }) {
        const sessionFile = join(sessionDirectory, "loop.jsonl");
        await writeFile(sessionFile, "");
        return {
          conversationId: "loop", sessionFile,
          // Like the model on 2026-09-27: the same failing call until something stops it.
          async prompt() {
            for (let attempt = 0; attempt < 50 && !aborted; attempt += 1) {
              for (const event of failing(GIT_ADD)) listener?.(event);
              await new Promise((resolve) => setImmediate(resolve));
            }
          },
          steer: async (text) => { steered.push(text); },
          abort: async () => { aborted = true; },
          getModel: () => ({ provider: "fixture", modelId: "looping-model" }),
          getSessionStats: () => ({ sessionFile, sessionId: "loop", userMessages: 1, assistantMessages: 5, toolCalls: 5, toolResults: 5, totalMessages: 11, tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 }, cost: 0 }),
          subscribe: (next) => { listener = next; return () => { listener = undefined; }; },
          dispose: () => undefined,
        };
      },
    };
    const events: WorkerEvent[] = [];
    await expect(runTaskInvocation(taskInvocation(), {
      rootPath, model: { provider: "fixture", modelId: "looping-model" }, piAdapter: adapter,
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined,
    })).rejects.toThrow(/OPERATION_INTERRUPTED: the agent repeated the same failing bash call 5 times/);

    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatch(/same bash call 3 times in a row/);
    expect(aborted).toBe(true);
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(REPEAT_LIMIT);
    const errors = events.filter((event) => event.type === "error").map((event) => (event.payload as { message?: string }).message);
    expect(errors).toEqual([expect.stringMatching(/repeated the same failing bash call/)]);
    const usage = events.find((event) => event.type === "usage");
    expect((usage?.payload as { outcome?: string } | undefined)?.outcome).toBe("FAILED");
  });
});

describe("a real pi session whose model loops on a failing command", () => {
  it("receives the warning before its next call, and the task stops at the limit", async () => {
    const rootPath = await preparedRoot();
    const { modelRuntime, faux } = await fauxModelRuntime();
    // The messages each call saw; the context itself holds tool functions, which cannot be cloned.
    const contexts: string[] = [];
    // A scripted model that runs the same failing command no matter what it is told.
    faux.setResponses(Array.from({ length: 20 }, () => (context: Context) => {
      contexts.push(JSON.stringify(context.messages));
      return fauxAssistantMessage(fauxToolCall("bash", { command: "agentx-no-such-command --retry" }));
    }));
    const adapter: PiSessionAdapter = {
      async create({ cwd, sessionDirectory, agentDirectory }) {
        const model = modelRuntime.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId)!;
        const { session } = await createAgentSession({
          cwd, agentDir: agentDirectory, modelRuntime, model, thinkingLevel: "off", tools: ["bash"],
          sessionManager: SessionManager.create(cwd, sessionDirectory),
        });
        return {
          conversationId: "real-loop", sessionFile: session.sessionFile!,
          prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
          // Pi 0.99 returns a queued-input disposition; the adapter contract is Promise<void>.
          steer: async (text) => { await session.steer(text); },
          abort: () => session.abort(),
          getModel: () => ({ provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }),
          getSessionStats: () => session.getSessionStats(),
          subscribe: (listener) => session.subscribe((event) => listener(event)),
          dispose: () => session.dispose(),
        };
      },
    };

    await expect(runTaskInvocation(taskInvocation(), {
      rootPath, model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, piAdapter: adapter,
      eventSink: async () => undefined, artifactSink: async () => undefined,
    })).rejects.toThrow(/OPERATION_INTERRUPTED: the agent repeated the same failing bash call 5 times/);

    const warned = (messages: string) => messages.includes("Repeating it will not help");
    // Calls 1-3 were made before the warning; the model's 4th call already saw it.
    expect(contexts.slice(0, REPEAT_WARNING_AT).some(warned)).toBe(false);
    expect(warned(contexts[REPEAT_WARNING_AT]!)).toBe(true);
    // Stopped at the fifth failure: the scripted model was not asked again.
    expect(contexts).toHaveLength(REPEAT_LIMIT);
  }, 60_000);
});

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-loop-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "loop", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "commit the Notes feature" },
  };
}
