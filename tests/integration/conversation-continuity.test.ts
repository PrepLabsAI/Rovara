import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import { describe, expect, it } from "vitest";
import { WorkerCancellationController } from "../../packages/worker/src/cancel.js";
import { WorkspaceConversationStore } from "../../packages/worker/src/conversations.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter, PiSessionHandle, PiSessionInput } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const model = { provider: "fixture", modelId: "fixture" };

describe("the task path continues one conversation", () => {
  it("creates a session on the first task and reopens that same session on the next one", async () => {
    const rootPath = await workspace();
    const adapter = recordingAdapter();
    const conversationId = randomUUID();

    const first = await runTask(rootPath, conversationId, "Use the existing button style.", adapter);
    // A replacement worker process reaches the same disk with no in-memory state of its own.
    const second = await runTask(rootPath, conversationId, "Now add the Done filter.", adapter);

    expect(first.result.reopened).toBe(false);
    expect(second.result.reopened).toBe(true);
    expect(adapter.created).toHaveLength(1);
    expect(adapter.opened).toEqual([{ conversationId, sessionFile: adapter.created[0]?.sessionFile }]);
    const transcript = await readFile(adapter.created[0]!.sessionFile, "utf8");
    expect(transcript).toContain("Use the existing button style.");
    expect(transcript).toContain("Now add the Done filter.");
  });

  it("keeps the broker's conversation ID in the manifest, the events and the result", async () => {
    const rootPath = await workspace();
    const adapter = recordingAdapter({ internalConversationId: "pi-session-01JB0000000000000000000000" });
    const conversationId = randomUUID();

    const { result, events } = await runTask(rootPath, conversationId, "First turn.", adapter);

    expect(result.conversationId).toBe(conversationId);
    expect(payloads(events, "lifecycle")).toContainEqual(
      expect.objectContaining({ status: "RUNNING", conversationId }),
    );
    expect(payloads(events, "result")).toContainEqual(expect.objectContaining({ conversationId }));
    const manifest = JSON.parse(await readFile(join(rootPath, ".agentx/conversations.json"), "utf8")) as {
      schemaVersion: number;
      conversations: Record<string, { model?: unknown }>;
    };
    expect(manifest.schemaVersion).toBe(2);
    expect(Object.keys(manifest.conversations)).toEqual([conversationId]);
    expect(manifest.conversations[conversationId]?.model).toEqual(model);
  });

  it("gives another conversation its own session without resetting the workspace files", async () => {
    const rootPath = await workspace();
    await writeFile(join(rootPath, "repo/app/value.txt"), "work in progress\n");
    const adapter = recordingAdapter();
    const first = randomUUID();
    const second = randomUUID();

    await runTask(rootPath, first, "First thread.", adapter);
    await runTask(rootPath, second, "Unrelated thread.", adapter);

    expect(adapter.opened).toEqual([]);
    expect(adapter.created).toHaveLength(2);
    expect(adapter.created[0]?.sessionFile).not.toBe(adapter.created[1]?.sessionFile);
    await expect(readFile(adapter.created[1]!.sessionFile, "utf8")).resolves.not.toContain("First thread.");
    await expect(readFile(join(rootPath, "repo/app/value.txt"), "utf8")).resolves.toBe("work in progress\n");
  });

  it("refuses a conversation the control plane has started but this workspace cannot find", async () => {
    const rootPath = await workspace();
    const adapter = recordingAdapter();

    await expect(
      runTask(rootPath, randomUUID(), "Continue where we left off.", adapter, { conversationStarted: true }),
    ).rejects.toThrow(/CONVERSATION_STATE_LOST/);

    expect(adapter.created).toEqual([]);
    expect(adapter.opened).toEqual([]);
  });

  it("refuses a registered conversation whose transcript is gone instead of starting over", async () => {
    const rootPath = await workspace();
    const adapter = recordingAdapter();
    const conversationId = randomUUID();
    await runTask(rootPath, conversationId, "First turn.", adapter);
    await rm(adapter.created[0]!.sessionFile);

    await expect(runTask(rootPath, conversationId, "Second turn.", adapter)).rejects.toThrow(
      /CONVERSATION_STATE_LOST/,
    );

    expect(adapter.created).toHaveLength(1);
  });

  it("rejects a transcript pointer that leaves the session directory before any model runs", async () => {
    const rootPath = await workspace();
    const outside = join(rootPath, "outside.jsonl");
    await writeFile(outside, "");
    const traversal = randomUUID();
    const symlinked = randomUUID();
    await mkdir(join(rootPath, "agent-sessions"), { recursive: true });
    await symlink(outside, join(rootPath, "agent-sessions/escape.jsonl"));
    await writeFile(
      join(rootPath, ".agentx/conversations.json"),
      JSON.stringify({
        schemaVersion: 2,
        conversations: {
          [traversal]: entry("../../elsewhere/transcript.jsonl"),
          [symlinked]: entry("escape.jsonl"),
        },
      }),
    );
    const adapter = recordingAdapter();

    await expect(runTask(rootPath, traversal, "Continue.", adapter)).rejects.toThrow(
      /outside the workspace session directory/,
    );
    await expect(runTask(rootPath, symlinked, "Continue.", adapter)).rejects.toThrow(/FORBIDDEN/);
    expect(adapter.created).toEqual([]);
    expect(adapter.opened).toEqual([]);
  });

  it("keeps a cancelled turn's conversation reopenable rather than replaying it", async () => {
    const rootPath = await workspace();
    const conversationId = randomUUID();
    const adapter = recordingAdapter();
    await runTask(rootPath, conversationId, "First turn.", adapter);

    const cancellationController = new WorkerCancellationController();
    const operationId = randomUUID();
    const cancelling = recordingAdapter({
      onPrompt: async () => {
        await cancellationController.cancel(operationId);
        throw new Error("aborted");
      },
    });
    await expect(
      runTask(rootPath, conversationId, "Cancelled turn.", cancelling, { cancellationController, operationId }),
    ).rejects.toThrow(/was cancelled/);

    const resumed = await runTask(rootPath, conversationId, "Third turn.", adapter);
    expect(resumed.result.reopened).toBe(true);
    const transcript = await readFile(adapter.created[0]!.sessionFile, "utf8");
    expect(transcript).toContain("Third turn.");
    expect(transcript).not.toContain("Cancelled turn.");
  });

  it("reports a conversation that continues on another model rather than silently switching", async () => {
    const rootPath = await workspace();
    const conversationId = randomUUID();
    const adapter = recordingAdapter();
    await runTask(rootPath, conversationId, "First turn.", adapter);

    const { events } = await runTask(rootPath, conversationId, "Second turn.", adapter, {
      model: { provider: "amazon-bedrock", modelId: "claude-opus-5" },
    });

    expect(payloads(events, "progress")).toContainEqual({
      message: "this conversation was built on fixture/fixture and continues on amazon-bedrock/claude-opus-5",
    });
    const store = new WorkspaceConversationStore(rootPath);
    await expect(store.tryResolve(conversationId)).resolves.toMatchObject({
      model: { provider: "amazon-bedrock", modelId: "claude-opus-5" },
    });
  });

  it("reads a manifest written before conversations recorded their model", async () => {
    const rootPath = await workspace();
    const conversationId = randomUUID();
    const legacy = new WorkspaceConversationStore(rootPath);
    const { sessionFile } = await legacy.createSessionFile(conversationId);
    await writeFile(
      join(rootPath, ".agentx/conversations.json"),
      JSON.stringify({
        schemaVersion: 1,
        conversations: { [conversationId]: entry(sessionFile.split("/").pop()!) },
      }),
    );
    const adapter = recordingAdapter();

    const { result } = await runTask(rootPath, conversationId, "Continue.", adapter);

    expect(result.reopened).toBe(true);
    expect(adapter.created).toEqual([]);
    const manifest = JSON.parse(await readFile(join(rootPath, ".agentx/conversations.json"), "utf8")) as {
      schemaVersion: number;
    };
    expect(manifest.schemaVersion).toBe(2);
  });
});

async function runTask(
  rootPath: string,
  conversationId: string,
  prompt: string,
  adapter: RecordingAdapter,
  options: {
    conversationStarted?: boolean;
    cancellationController?: WorkerCancellationController;
    operationId?: string;
    model?: { provider: string; modelId: string };
  } = {},
): Promise<{ result: { conversationId: string; reopened: boolean }; events: WorkerEvent[] }> {
  const events: WorkerEvent[] = [];
  const invocation: WorkerInvocation = {
    protocolVersion: 1,
    kind: "task",
    operationId: options.operationId ?? randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: {
      conversationId,
      prompt,
      ...(options.conversationStarted === undefined ? {} : { conversationStarted: options.conversationStarted }),
    },
  };
  const result = await runTaskInvocation(invocation, {
    rootPath,
    model: options.model ?? model,
    piAdapter: adapter.adapter,
    eventSink: async (batch) => {
      events.push(...batch);
    },
    artifactSink: async () => undefined,
    ...(options.cancellationController === undefined
      ? {}
      : { cancellationController: options.cancellationController }),
  });
  return { result, events };
}

function payloads(events: readonly WorkerEvent[], type: WorkerEvent["type"]): unknown[] {
  return events.filter((event) => event.type === type).map(({ payload }) => payload);
}

function entry(sessionFile: string) {
  const now = new Date().toISOString();
  return { sessionFile, createdAt: now, updatedAt: now };
}

interface RecordingAdapter {
  adapter: PiSessionAdapter;
  created: Array<{ conversationId: string | undefined; sessionFile: string }>;
  opened: Array<{ conversationId: string; sessionFile: string }>;
}

function recordingAdapter(
  options: { internalConversationId?: string; onPrompt?: () => Promise<void> } = {},
): RecordingAdapter {
  const created: RecordingAdapter["created"] = [];
  const opened: RecordingAdapter["opened"] = [];
  const handle = (
    conversationId: string,
    sessionFile: string,
    model: { provider: string; modelId: string },
  ): PiSessionHandle => ({
    conversationId,
    sessionFile,
    async prompt(text) {
      await options.onPrompt?.();
      await appendFile(sessionFile, `${JSON.stringify({ role: "user", text })}\n`);
    },
    async abort() {},
    getModel: () => model,
    getSessionStats: () => ({
      sessionFile,
      sessionId: conversationId,
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }),
    subscribe() {
      return () => undefined;
    },
    dispose() {},
  });
  return {
    created,
    opened,
    adapter: {
      async create(input: PiSessionInput) {
        await mkdir(input.sessionDirectory, { recursive: true });
        const sessionFile = join(input.sessionDirectory, `${randomUUID()}.jsonl`);
        await writeFile(sessionFile, "", { flag: "wx" });
        created.push({ conversationId: input.conversationId, sessionFile });
        return handle(options.internalConversationId ?? input.conversationId ?? randomUUID(), sessionFile, input.model);
      },
      async open(input) {
        opened.push({ conversationId: input.conversationId, sessionFile: input.sessionFile });
        return handle(input.conversationId, input.sessionFile, input.model);
      },
    },
  };
}

async function workspace(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-continuity-"));
  await mkdir(join(rootPath, ".agentx"), { recursive: true });
  await mkdir(join(rootPath, "repo/app"), { recursive: true });
  await writeFile(
    join(rootPath, ".agentx/preparation-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      projectName: "payments",
      projectRevision: 1,
      repositories: [],
      completedSetupSteps: [],
      readinessResults: [],
      creationIdentity: "test",
      complete: true,
      updatedAt: new Date().toISOString(),
    }),
  );
  return rootPath;
}
