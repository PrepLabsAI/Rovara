import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { publishWorkspaceDiff, type WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const run = promisify(execFile);
const NOT_FOUND = (path: string) =>
  `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`;

type Step =
  | { tool: string; args: Record<string, unknown>; isError: boolean; text: string }
  | { effect: (repository: string) => Promise<void> };

const edit = (path: string, isError: boolean, text = isError ? NOT_FOUND(path) : `Successfully replaced 1 block(s) in ${path}.`): Step =>
  ({ tool: "edit", args: { path, edits: [{ oldText: "old body text", newText: "new body text" }] }, isError, text });
const tool = (name: string, args: Record<string, unknown>, isError = false, text = "ok"): Step => ({ tool: name, args, isError, text });
const effect = (fn: (repository: string) => Promise<void>): Step => ({ effect: fn });

interface Outcome {
  events: WorkerEvent[];
  artifacts: WorkerArtifact[];
  result: Promise<unknown>;
}

async function runScripted(steps: Step[]): Promise<Outcome> {
  const { rootPath, repository } = await preparedRepository();
  let listener: (event: unknown) => void = () => undefined;
  const adapter: PiSessionAdapter = {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "scripted.jsonl");
      await writeFile(sessionFile, "");
      return {
        conversationId: "scripted", sessionFile,
        async prompt() {
          for (const step of steps) {
            if ("effect" in step) { await step.effect(repository); continue; }
            const toolCallId = randomUUID();
            listener({ type: "tool_execution_start", toolCallId, toolName: step.tool, args: step.args });
            listener({ type: "tool_execution_end", toolCallId, toolName: step.tool, isError: step.isError, result: { content: [{ type: "text", text: step.text }] } });
          }
          listener({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
        },
        async abort() {},
        getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "scripted", userMessages: 1, assistantMessages: 1, toolCalls: steps.length, toolResults: steps.length, totalMessages: 3, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: (next) => { listener = next; return () => { listener = () => undefined; }; },
        dispose: () => undefined,
      };
    },
  };
  const events: WorkerEvent[] = [];
  const artifacts: WorkerArtifact[] = [];
  const result = runTaskInvocation(taskInvocation(), {
    rootPath, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
    eventSink: async (batch) => { events.push(...batch); },
    artifactSink: async (artifact) => { artifacts.push(artifact); },
  });
  await result.catch(() => undefined);
  return { events, artifacts, result };
}

const usageOutcome = (events: WorkerEvent[]) =>
  (events.find((event) => event.type === "usage")?.payload as { outcome?: string } | undefined)?.outcome;
const progressMessages = (events: WorkerEvent[]) =>
  events.filter((event) => event.type === "progress").map((event) => (event.payload as { message?: unknown }).message).filter((message) => typeof message === "string");

describe("a task whose every edit failed and nothing changed (#158)", () => {
  it("fails with a reason that names the count and the last file, and keeps its evidence", async () => {
    const { events, artifacts, result } = await runScripted([
      tool("read", { path: "README.md" }),
      edit("README.md", true),
      tool("read", { path: "README.md" }),
      edit("docs/guide.md", true),
      edit("README.md", true),
    ]);

    await expect(result).rejects.toThrow(
      "OPERATION_INTERRUPTED: no file changed: all 3 edit calls failed (last: README.md, the text to replace was not found)",
    );
    const errors = events.filter((event) => event.type === "error").map((event) => (event.payload as { message?: string }).message);
    expect(errors).toEqual([expect.stringContaining("no file changed: all 3 edit calls failed")]);
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(usageOutcome(events)).toBe("FAILED");
    const names = artifacts.map(({ name }) => name);
    expect(names).toContain("test-and-tool-evidence.json");
    expect(names).toContain("workspace.diff");
    expect(names).toContain("usage.json");
    expect(artifacts.find(({ name }) => name === "test-and-tool-evidence.json")!.content).toContain("Could not find the exact text");
  });

  it("counts write calls too, and never puts the tool's error text or file contents in the reason", async () => {
    const { result } = await runScripted([
      edit("README.md", true),
      tool("write", { path: "config/.env", content: "API_TOKEN=do-not-echo" }, true, "EACCES: permission denied\nAPI_TOKEN=do-not-echo"),
    ]);

    const failure = await result.then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toBe(
      "OPERATION_INTERRUPTED: no file changed: all 2 edit and write calls failed (last: config/.env, the write returned an error)",
    );
    expect(failure?.message).not.toContain("do-not-echo");
    expect(failure?.message).not.toContain("old body text");
  });
});

describe("the reason for a single failed edit (#158)", () => {
  it("says the only edit failed, and names the multiple-match reason", async () => {
    const { result } = await runScripted([
      edit("src/app.ts", true, "Found 2 occurrences of the text in src/app.ts. The text must be unique. Please provide more context to make it unique."),
    ]);
    await expect(result).rejects.toThrow(
      "OPERATION_INTERRUPTED: no file changed: the only edit call failed (last: src/app.ts, the text to replace matched more than once)",
    );
  });
});

describe("tasks that must still succeed (#158)", () => {
  it("a read-only task (reads and searches, some failing, no edit or write, empty diff) succeeds", async () => {
    const { events, result } = await runScripted([
      tool("read", { path: "README.md" }),
      tool("grep", { pattern: "TODO" }),
      tool("read", { path: "missing.md" }, true, "ENOENT: no such file or directory"),
      tool("find", { pattern: "*.ts" }),
      tool("ls", { path: "." }),
      tool("bash", { command: "git log -1" }),
    ]);

    await expect(result).resolves.toHaveProperty("conversationId");
    expect(usageOutcome(events)).toBe("SUCCEEDED");
    expect(progressMessages(events).some((message) => /no repository changed/i.test(message))).toBe(false);
  });

  it("an answer-only task (no tool calls) succeeds", async () => {
    const { events, result } = await runScripted([]);
    await expect(result).resolves.toBeDefined();
    expect(usageOutcome(events)).toBe("SUCCEEDED");
  });

  it("one edit fails and a later edit succeeds: succeeds", async () => {
    const { result } = await runScripted([
      edit("README.md", true),
      edit("README.md", false),
      effect(async (repository) => writeFile(join(repository, "README.md"), "new body text\n")),
    ]);
    await expect(result).resolves.toBeDefined();
  });

  it("an edit fails and a bash sed then changes the file: succeeds", async () => {
    const { result } = await runScripted([
      edit("README.md", true),
      tool("bash", { command: "sed -i 's/old/new/' README.md" }),
      effect(async (repository) => writeFile(join(repository, "README.md"), "new body text\n")),
    ]);
    await expect(result).resolves.toBeDefined();
  });

  it("an edit fails and an untracked file appears: succeeds", async () => {
    const { result } = await runScripted([
      edit("README.md", true),
      effect(async (repository) => writeFile(join(repository, "NOTES.md"), "notes\n")),
    ]);
    await expect(result).resolves.toBeDefined();
  });

  it("edits succeed but no repository changed: succeeds with a warning, not a failure", async () => {
    const { events, result } = await runScripted([edit("README.md", true), edit("README.md", false)]);
    await expect(result).resolves.toBeDefined();
    expect(usageOutcome(events)).toBe("SUCCEEDED");
    expect(progressMessages(events)).toContainEqual(
      "The agent reported 1 successful edit or write call, but no repository changed. The edits may have landed outside the project's repositories.",
    );
  });
});

describe("a task that fails for another reason (#158)", () => {
  it("still saves its tool evidence and the workspace diff", async () => {
    const { rootPath } = await preparedRepository();
    let listener: (event: unknown) => void = () => undefined;
    const adapter: PiSessionAdapter = {
      async create({ sessionDirectory }) {
        const sessionFile = join(sessionDirectory, "model-failure.jsonl");
        await writeFile(sessionFile, "");
        return {
          conversationId: "model-failure", sessionFile,
          async prompt() {
            const toolCallId = randomUUID();
            listener({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "npm test" } });
            listener({ type: "tool_execution_end", toolCallId, toolName: "bash", isError: false, result: { content: [{ type: "text", text: "tests passed" }] } });
            listener({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "upstream 500" } });
          },
          async abort() {},
          getModel: () => ({ provider: "fixture", modelId: "fixture" }),
          getSessionStats: () => ({ sessionFile, sessionId: "model-failure", userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 3, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
          subscribe: (next) => { listener = next; return () => { listener = () => undefined; }; },
          dispose: () => undefined,
        };
      },
    };
    const artifacts: WorkerArtifact[] = [];
    await expect(runTaskInvocation(taskInvocation(), {
      rootPath, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
      eventSink: async () => undefined, artifactSink: async (artifact) => { artifacts.push(artifact); },
    })).rejects.toThrow(/RUNTIME_UNAVAILABLE: the model call failed: upstream 500/);
    expect(artifacts.find(({ name }) => name === "test-and-tool-evidence.json")?.content).toContain("tests passed");
    expect(artifacts.map(({ name }) => name)).toContain("workspace.diff");
  });
});

describe("publishWorkspaceDiff reports whether anything changed", () => {
  it("is false for a clean repository and true once an untracked file appears", async () => {
    const { rootPath, repository } = await preparedRepository();
    const sink = async () => undefined;
    await expect(publishWorkspaceDiff(rootPath, sink)).resolves.toEqual({ changed: false });
    await writeFile(join(repository, "NEW.md"), "new\n");
    await expect(publishWorkspaceDiff(rootPath, sink)).resolves.toEqual({ changed: true });
  });
});

async function preparedRepository(): Promise<{ rootPath: string; repository: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-no-change-"));
  const repository = join(rootPath, "repo/app");
  await mkdir(repository, { recursive: true });
  await run("git", ["init", "--quiet", "--initial-branch=main", repository]);
  await writeFile(join(repository, "README.md"), "old body text\n");
  await run("git", ["-C", repository, "add", "."]);
  await run("git", ["-C", repository, "-c", "user.name=AgentX", "-c", "user.email=agentx@example.test", "commit", "--quiet", "-m", "fixture"]);
  const now = new Date().toISOString();
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "no-change", projectRevision: 1,
    repositories: [{ name: "app", path: "repo/app", defaultBranch: "main", resolvedCommit: "fixture", resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  return { rootPath, repository };
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "update the README" },
  };
}
