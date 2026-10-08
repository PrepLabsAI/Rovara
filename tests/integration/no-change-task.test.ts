import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { diffStat, type WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it, vi } from "vitest";
import { MISSING_BASE_NOTE, publishWorkspaceDiff, workspaceFingerprint, type WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import type { PiSessionAdapter, PiSessionHandle } from "../../packages/worker/src/pi-session.js";
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

interface ScriptOptions {
  prepared?: { rootPath: string; repository: string };
  conversationId?: string;
  conversationStarted?: boolean;
  cancellationController?: WorkerCancellationController;
  operationId?: string;
  /** Runs after the scripted steps, before the model's final message. */
  afterSteps?: () => Promise<void>;
  /** The final assistant message's stop reason; a cancelled pi turn ends "aborted". */
  stopReason?: string;
  /** Replaces the default artifact sink; the artifacts it accepts are still recorded. */
  artifactSink?: (artifact: WorkerArtifact) => Promise<void>;
}

async function runScripted(steps: Step[], options: ScriptOptions = {}): Promise<Outcome> {
  const { rootPath, repository } = options.prepared ?? await preparedRepository();
  let listener: (event: unknown) => void = () => undefined;
  const handle = (sessionFile: string): PiSessionHandle => ({
    conversationId: "scripted", sessionFile,
    async prompt() {
      for (const step of steps) {
        if ("effect" in step) { await step.effect(repository); continue; }
        const toolCallId = randomUUID();
        listener({ type: "tool_execution_start", toolCallId, toolName: step.tool, args: step.args });
        listener({ type: "tool_execution_end", toolCallId, toolName: step.tool, isError: step.isError, result: { content: [{ type: "text", text: step.text }] } });
      }
      await options.afterSteps?.();
      listener({ type: "message_end", message: { role: "assistant", stopReason: options.stopReason ?? "stop" } });
    },
    async abort() {},
    getModel: () => ({ provider: "fixture", modelId: "fixture" }),
    getSessionStats: () => ({ sessionFile, sessionId: "scripted", userMessages: 1, assistantMessages: 1, toolCalls: steps.length, toolResults: steps.length, totalMessages: 3, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
    subscribe: (next) => { listener = next; return () => { listener = () => undefined; }; },
    dispose: () => undefined,
  });
  const adapter: PiSessionAdapter = {
    async create({ sessionDirectory }) {
      await mkdir(sessionDirectory, { recursive: true });
      const sessionFile = join(sessionDirectory, `${randomUUID()}.jsonl`);
      await writeFile(sessionFile, "");
      return handle(sessionFile);
    },
    async open({ sessionFile }) {
      return handle(sessionFile);
    },
  };
  const events: WorkerEvent[] = [];
  const artifacts: WorkerArtifact[] = [];
  const result = runTaskInvocation(taskInvocation(options), {
    rootPath, model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
    eventSink: async (batch) => { events.push(...batch); },
    artifactSink: async (artifact) => {
      await options.artifactSink?.(artifact);
      artifacts.push(artifact);
    },
    ...(options.cancellationController === undefined ? {} : { cancellationController: options.cancellationController }),
  });
  await result.catch(() => undefined);
  return { events, artifacts, result };
}

const usageOutcome = (events: WorkerEvent[]) =>
  (events.find((event) => event.type === "usage")?.payload as { outcome?: string } | undefined)?.outcome;
const progressMessages = (events: WorkerEvent[]) =>
  events.filter((event) => event.type === "progress").map((event) => (event.payload as { message?: unknown }).message).filter((message) => typeof message === "string");

describe("PR feedback approval worker-start fence", () => {
  it("refuses stale approval before reading the workspace or invoking the coding agent", async () => {
    const invocation = taskInvocation();
    invocation.payload.workflowMode = "IMPLEMENT";
    invocation.payload.workflowFeedbackApproval = {
      taskId: randomUUID(), requestId: randomUUID(), ownerId: "a".repeat(64), decisionWorkflowRevision: 4,
      activeWorkflowRevision: 6, reviewDigest: "b".repeat(64), proposalDigest: "c".repeat(64),
      bundleDigests: ["d".repeat(64)], candidateDigest: "e".repeat(64), selectedFindingIds: ["finding-1"], selectedCommentIds: ["comment-1"],
    };
    const authorize = vi.fn(async () => { throw new Error("STALE_FENCE: approval was invalidated by a newer GitHub event"); });
    await expect(runTaskInvocation(invocation, {
      rootPath: "/path/that/must-not-be-read", model: { provider: "test", modelId: "test" },
      eventSink: async () => undefined, artifactSink: async () => undefined, authorizeFeedbackApproval: authorize,
    })).rejects.toThrow(/STALE_FENCE/);
    expect(authorize).toHaveBeenCalledWith(invocation.payload.workflowFeedbackApproval);
  });
});

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
      "The agent reported 1 successful edit or write call, but no repository changed. The edits may have landed outside the project's repositories or in files git ignores.",
    );
  });
});

describe("review follow-ups (#158)", () => {
  it("a later turn whose edits all fail is caught even when an earlier turn left the tree changed", async () => {
    const prepared = await preparedRepository();
    const conversationId = randomUUID();
    const first = await runScripted([
      edit("README.md", false),
      effect(async (repository) => writeFile(join(repository, "README.md"), "turn one\n")),
    ], { prepared, conversationId });
    await expect(first.result).resolves.toBeDefined();

    const second = await runScripted([edit("README.md", true)], { prepared, conversationId, conversationStarted: true });
    await expect(second.result).rejects.toThrow("no file changed: the only edit call failed (last: README.md, the text to replace was not found)");
  });

  it("a later turn that edits an already modified file again succeeds", async () => {
    const prepared = await preparedRepository();
    const conversationId = randomUUID();
    await runScripted([effect(async (repository) => writeFile(join(repository, "README.md"), "turn one\n"))], { prepared, conversationId });
    const second = await runScripted([
      edit("README.md", true),
      effect(async (repository) => writeFile(join(repository, "README.md"), "turn two\n")),
    ], { prepared, conversationId, conversationStarted: true });
    await expect(second.result).resolves.toBeDefined();
  });

  it("a later turn that rewrites an untracked file from an earlier turn succeeds", async () => {
    const prepared = await preparedRepository();
    const conversationId = randomUUID();
    await runScripted([effect(async (repository) => writeFile(join(repository, "NOTES.md"), "one\n"))], { prepared, conversationId });
    const second = await runScripted([
      edit("NOTES.md", true),
      effect(async (repository) => writeFile(join(repository, "NOTES.md"), "two\n")),
    ], { prepared, conversationId, conversationStarted: true });
    await expect(second.result).resolves.toBeDefined();
  });

  it("a later turn that reverts an earlier turn's change succeeds, even though the tree ends clean", async () => {
    const prepared = await preparedRepository();
    const conversationId = randomUUID();
    await runScripted([effect(async (repository) => writeFile(join(repository, "README.md"), "turn one\n"))], { prepared, conversationId });
    const second = await runScripted([
      edit("README.md", true),
      effect(async (repository) => { await run("git", ["-C", repository, "checkout", "--", "README.md"]); }),
    ], { prepared, conversationId, conversationStarted: true });
    await expect(second.result).resolves.toBeDefined();
  });

  it("judges the task by the final diff, and says so, when the state after the task cannot be read", async () => {
    const prepared = await preparedRepository();
    const { events, result } = await runScripted([
      edit("README.md", true),
      effect(async (repository) => writeFile(join(repository, "README.md"), "changed\n")),
    ], {
      prepared,
      // The diff is published, then the manifest the fingerprint needs is gone.
      artifactSink: async (artifact) => {
        if (artifact.name === "workspace.diff") await writeFile(join(prepared.rootPath, ".agentx/preparation-manifest.json"), "not json");
      },
    });
    await expect(result).resolves.toBeDefined();
    expect(progressMessages(events)).toContainEqual(
      "AgentX could not record the workspace state after this task; it judged the task by the final diff only.",
    );
  });

  it("shows a file whose name starts with two dots by its relative path, and strips invisible characters", async () => {
    const prepared = await preparedRepository();
    const { result } = await runScripted([edit(join(prepared.rootPath, "..no\u202ete\u0085s.md"), true)], { prepared });
    const failure = await result.then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("(last: ..notes.md, the text to replace was not found)");
    expect(failure?.message).not.toContain(prepared.rootPath);
  });

  it("edits that report the file already holds the text are not failures: the task succeeds", async () => {
    const { events, result } = await runScripted([
      edit("README.md", true, "No changes made to README.md. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected."),
    ]);
    await expect(result).resolves.toBeDefined();
    expect(progressMessages(events).some((message) => /no repository changed/i.test(message))).toBe(false);
  });

  it("names a file under the workspace by its relative path and strips control characters", async () => {
    const prepared = await preparedRepository();
    const { result } = await runScripted([edit(join(prepared.rootPath, "repo/app/READ\nME.md"), true)], { prepared });
    const failure = await result.then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("(last: repo/app/README.md, the text to replace was not found)");
    expect(failure?.message).not.toContain(prepared.rootPath);
  });

  it("a cancelled task keeps its tool evidence but does not wait for a workspace diff", async () => {
    const cancellationController = new WorkerCancellationController();
    const operationId = randomUUID();
    const { events, artifacts, result } = await runScripted([edit("README.md", true)], {
      cancellationController, operationId, stopReason: "aborted",
      afterSteps: async () => { await cancellationController.cancel(operationId); },
    });
    await expect(result).rejects.toThrow(/was cancelled/);
    expect(usageOutcome(events)).toBe("CANCELLED");
    const names = artifacts.map(({ name }) => name);
    expect(names).toContain("test-and-tool-evidence.json");
    expect(names).not.toContain("workspace.diff");
  });

  it("says so when a failed task could not save its workspace diff", async () => {
    // The loop guard stops this task before the diff, so the diff is saved on the failure path.
    const { events, result } = await runScripted(Array.from({ length: 6 }, () => edit("README.md", true)), {
      artifactSink: async (artifact) => {
        if (artifact.name === "workspace.diff") throw new Error("artifact store rejected secret-looking detail");
      },
    });
    await expect(result).rejects.toThrow(/repeated the same failing edit call 5 times/);
    const messages = progressMessages(events);
    expect(messages).toContainEqual("AgentX could not save workspace.diff for this task.");
    expect(messages.some((message) => message.includes("secret-looking detail"))).toBe(false);
  });

  it("a task stopped by the loop guard saves its tool evidence and the workspace diff", async () => {
    const failingEdit = () => edit("README.md", true);
    const lookup = () => tool("read", { path: "README.md" });
    const { artifacts, result } = await runScripted(
      Array.from({ length: 6 }, () => [lookup(), failingEdit()]).flat(),
    );
    await expect(result).rejects.toThrow(/repeated the same failing edit call 5 times/);
    const names = artifacts.map(({ name }) => name);
    expect(names).toContain("test-and-tool-evidence.json");
    expect(names).toContain("workspace.diff");
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

const commitAll = async (repository: string, message = "agent change"): Promise<void> => {
  await run("git", ["-C", repository, "add", "-A"]);
  await run("git", ["-C", repository, "-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "--quiet", "-m", message]);
};
const workspaceDiff = (artifacts: WorkerArtifact[]) => artifacts.find(({ name }) => name === "workspace.diff")!.content;

describe("changes the agent commits count as changes (#208)", () => {
  it("an edit that the agent then commits: no warning, and the diff and changed files show it", async () => {
    const { events, artifacts, result } = await runScripted([
      edit("README.md", false),
      effect(async (repository) => {
        await writeFile(join(repository, "README.md"), "old body text\nlive test\n");
        await commitAll(repository);
      }),
    ]);
    await expect(result).resolves.toBeDefined();
    expect(usageOutcome(events)).toBe("SUCCEEDED");
    expect(progressMessages(events).some((message) => /no repository changed/i.test(message))).toBe(false);
    const diff = workspaceDiff(artifacts);
    expect(diff).toContain("+live test");
    expect(diffStat(diff)).toEqual([{ repository: "app", path: "README.md", added: 1, removed: 0 }]);
  });

  it("every edit call fails but a bash change is committed: the task succeeds", async () => {
    const { events, result } = await runScripted([
      edit("README.md", true),
      edit("README.md", true),
      tool("bash", { command: "perl -i -pe 's/old/new/' README.md && git commit -am x" }),
      effect(async (repository) => {
        await writeFile(join(repository, "README.md"), "new body text\n");
        await commitAll(repository);
      }),
    ]);
    await expect(result).resolves.toBeDefined();
    expect(usageOutcome(events)).toBe("SUCCEEDED");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("committed and uncommitted changes since the workspace was prepared both show in the diff", async () => {
    const { artifacts, result } = await runScripted([
      effect(async (repository) => {
        await writeFile(join(repository, "README.md"), "committed\n");
        await commitAll(repository);
        await writeFile(join(repository, "NOTES.md"), "uncommitted\n");
      }),
    ]);
    await expect(result).resolves.toBeDefined();
    expect(diffStat(workspaceDiff(artifacts))).toEqual([
      { repository: "app", path: "README.md", added: 1, removed: 1 },
      { repository: "app", path: "NOTES.md", added: 0, removed: 0 },
    ]);
  });

  it("a later turn that changes nothing after an earlier turn committed is still caught", async () => {
    const prepared = await preparedRepository();
    const conversationId = randomUUID();
    const first = await runScripted([
      edit("README.md", false),
      effect(async (repository) => {
        await writeFile(join(repository, "README.md"), "turn one\n");
        await commitAll(repository);
      }),
    ], { prepared, conversationId });
    await expect(first.result).resolves.toBeDefined();

    const second = await runScripted([edit("README.md", true)], { prepared, conversationId, conversationStarted: true });
    await expect(second.result).rejects.toThrow("no file changed: the only edit call failed (last: README.md, the text to replace was not found)");
    const third = await runScripted([edit("README.md", false)], { prepared, conversationId, conversationStarted: true });
    await expect(third.result).resolves.toBeDefined();
    expect(progressMessages(third.events)).toContainEqual(expect.stringContaining("but no repository changed"));
  });

  it("says so in the diff when the starting commit is gone, and still counts the moved HEAD", async () => {
    const { rootPath, repository } = await preparedRepository();
    const manifestPath = join(rootPath, ".agentx/preparation-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { repositories: Array<{ resolvedCommit: string }> };
    manifest.repositories[0]!.resolvedCommit = "0".repeat(40);
    await writeFile(manifestPath, JSON.stringify(manifest));
    let content = "";
    await expect(publishWorkspaceDiff(rootPath, async (artifact) => { content = artifact.content; })).resolves.toEqual({ changed: true });
    expect(content).toBe(`## app\n\n${MISSING_BASE_NOTE}\n### status\n\n### diff\n`);
    expect(diffStat(content)).toEqual([]);
    await writeFile(join(repository, "README.md"), "uncommitted\n");
    await publishWorkspaceDiff(rootPath, async (artifact) => { content = artifact.content; });
    expect(diffStat(content)).toEqual([{ repository: "app", path: "README.md", added: 1, removed: 1 }]);
  });

  it("publishWorkspaceDiff and the workspace fingerprint both see a commit on a clean tree", async () => {
    const { rootPath, repository } = await preparedRepository();
    const sink = async () => undefined;
    const before = await workspaceFingerprint(rootPath);
    await writeFile(join(repository, "README.md"), "committed\n");
    await commitAll(repository);
    await expect(publishWorkspaceDiff(rootPath, sink)).resolves.toEqual({ changed: true });
    expect(await workspaceFingerprint(rootPath)).not.toBe(before);
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
  const resolvedCommit = (await run("git", ["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  const now = new Date().toISOString();
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "no-change", projectRevision: 1,
    repositories: [{ name: "app", path: "repo/app", defaultBranch: "main", resolvedCommit, resolvedAt: now, completedAt: now }],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now,
  }));
  return { rootPath, repository };
}

function taskInvocation(options: ScriptOptions = {}): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: options.operationId ?? randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {
      conversationId: options.conversationId ?? randomUUID(), prompt: "update the README",
      ...(options.conversationStarted === undefined ? {} : { conversationStarted: options.conversationStarted }),
    },
  };
}
