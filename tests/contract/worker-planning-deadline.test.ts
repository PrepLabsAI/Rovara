import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

// PLANINC-3b: how a planning run ends when the model call hangs, fails, or is cancelled, and what the task's events say about it.

const SECRET_THINKING = "SECRET-REASONING-TEXT-9d1f";
const SECRET_PROVIDER_TEXT = "Internal server error: The system encountered an unexpected error during processing. Try your request again. PRIVATE-PROVIDER-DETAIL";
const REQUEST_ID = "9e7ea41c-561a-49e1-bbc3-2737b23fa76c";

/** Pi's event 75 of operation 1910a8ce: a Bedrock InternalServerException after 441950 ms, with only thinking in its content. */
const iseMessageEnd = () => ({
  type: "message_end",
  message: {
    role: "assistant", stopReason: "error", provider: "amazon-bedrock", durationMs: 441950,
    content: [{ type: "thinking", thinking: SECRET_THINKING }],
    errorMessage: SECRET_PROVIDER_TEXT,
    diagnostics: [{ type: "bedrock_response_failure", details: { errorCode: "InternalServerException", requestId: REQUEST_ID } }],
  },
});
const planEnd = (text = "## Plan\n\n1. Update the route.") => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
const abortedEnd = () => ({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "planinc-3b-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  const now = new Date().toISOString();
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: now }));
  return rootPath;
}

interface Script {
  /** What the model call does. `emit` feeds the session's subscriber; `aborted` resolves when the session is aborted. */
  prompt(emit: (event: unknown) => void, aborted: Promise<void>, call: number): Promise<void>;
  /** The adapter's abort. Default: mark the session aborted and return. */
  abort?(release: () => void): Promise<void>;
}

function adapterFor(script: Script) {
  const state = { aborts: 0, prompts: 0, emitted: [] as unknown[] };
  let listener: (event: unknown) => void = () => undefined;
  let release: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => { release = resolve; });
  const adapter: PiSessionAdapter = {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      return {
        sessionFile, conversationId: "fixture",
        prompt: async () => {
          state.prompts += 1;
          await script.prompt((event) => { state.emitted.push(event); listener(event); }, aborted, state.prompts);
        },
        abort: async () => { state.aborts += 1; if (script.abort !== undefined) await script.abort(release); else release(); },
        getModel: () => ({ provider: "fixture", modelId: "fixture" }),
        getSessionStats: () => ({ sessionFile, sessionId: "fixture", userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
        subscribe: (next) => { listener = next; return () => undefined; },
        dispose: () => undefined,
      };
    },
  };
  return { adapter, state };
}

const invocation = (mode: "PLAN" | "IMPLEMENT" = "PLAN") => ({
  protocolVersion: 1 as const, kind: "task" as const, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
  payload: { conversationId: randomUUID(), prompt: "Plan the change", workflowMode: mode },
});

async function run(script: Script, options: {
  limits?: { deadlineMs?: number; stallMs?: number; abortConfirmMs?: number; heartbeatMs?: number; tickMs?: number };
  sink?: (batch: readonly WorkerEvent[], sent: WorkerEvent[]) => Promise<void>;
  controller?: WorkerCancellationController;
  invocation?: ReturnType<typeof invocation>;
} = {}) {
  const { adapter, state } = adapterFor(script);
  const sent: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; content: string }> = [];
  const logs: Array<{ level: string; json: Record<string, unknown> }> = [];
  const task = options.invocation ?? invocation();
  const running = runTaskInvocation(task, {
    rootPath: await preparedRoot(), model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
    eventSink: async (batch) => { if (options.sink !== undefined) await options.sink(batch, sent); else sent.push(...batch); },
    artifactSink: async (artifact) => { artifacts.push(artifact); },
    modelCallLimits: { tickMs: 10, ...options.limits },
    log: (level, line) => { logs.push({ level, json: JSON.parse(line) as Record<string, unknown> }); },
    ...(options.controller === undefined ? {} : { cancellationController: options.controller }),
  });
  const settled = running.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  return { settled, sent, artifacts, logs, state, task };
}

const notes = (sent: readonly WorkerEvent[]) => sent.flatMap((event) => {
  const note = (event.payload as { modelCall?: unknown } | null)?.modelCall;
  return event.type === "progress" && note !== undefined ? [note as { outcome: string }] : [];
});
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("a planning run whose model call stops answering", () => {
  it("ends on the stall limit: aborts the session, tells the task first, and fails with fixed text", async () => {
    const started = Date.now();
    const { settled, sent, state } = await run({
      // One event, then silence until the abort; the abort ends the call as Pi does.
      async prompt(emit, aborted) { emit({ type: "message_start", message: { role: "assistant", content: [] } }); await aborted; emit(abortedEnd()); },
    }, { limits: { stallMs: 150, deadlineMs: 60_000, abortConfirmMs: 2_000 } });
    const result = await settled;
    expect(result.ok).toBe(false);
    const message = (result as { error: Error }).error.message;
    expect(message).toMatch(/^RUNTIME_UNAVAILABLE: planning stopped: the model sent nothing for \d+ s \(model call 1 of 3\)\. Retry planning\.$/u);
    expect(state.aborts).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(notes(sent).map((note) => note.outcome)).toEqual(expect.arrayContaining(["stalled", "stopped"]));
    // The stall note is sent before the terminal error event.
    const stalledAt = sent.findIndex((event) => (event.payload as { modelCall?: { outcome?: string } } | null)?.modelCall?.outcome === "stalled");
    const errorAt = sent.findIndex((event) => event.type === "error");
    expect(stalledAt).toBeGreaterThan(-1);
    expect(errorAt).toBeGreaterThan(stalledAt);
    expect(sent[errorAt]!.payload).toEqual({ message });
    expect(sent.some((event) => event.type === "result")).toBe(false);
  });

  it("ends on the planning deadline even while the model keeps streaming", async () => {
    const { settled, sent, state } = await run({
      async prompt(emit, aborted) {
        const ticker = setInterval(() => emit({ type: "message_update", message: { role: "assistant", content: [] } }), 20);
        await aborted;
        clearInterval(ticker);
        emit(abortedEnd());
      },
    }, { limits: { deadlineMs: 300, stallMs: 60_000, abortConfirmMs: 2_000 } });
    const result = await settled;
    expect((result as { error: Error }).error.message).toMatch(/^RUNTIME_UNAVAILABLE: planning stopped: the model did not finish within \d+ s \(model call 1 of 3\)\. Retry planning\.$/u);
    expect(state.aborts).toBe(1);
    expect(notes(sent).map((note) => note.outcome)).toContain("deadline");
    expect(notes(sent).map((note) => note.outcome)).not.toContain("stalled");
  });

  it("ends as interrupted, within the confirmation bound, when the abort never settles", async () => {
    const started = Date.now();
    const { settled, sent } = await run({
      async prompt() { await new Promise<void>(() => undefined); },
      async abort() { await new Promise<void>(() => undefined); },
    }, { limits: { stallMs: 100, deadlineMs: 60_000, abortConfirmMs: 250 } });
    const result = await settled;
    expect(result.ok).toBe(false);
    expect((result as { error: Error & { code?: string } }).error.message).toMatch(/^OPERATION_INTERRUPTED: planning stopped: the model sent nothing for \d+ s \(model call 1 of 3\) and did not stop when asked\. Retry planning\.$/u);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(notes(sent).map((note) => note.outcome)).toContain("stalled");
  });

  it("lets a cancel decide the outcome: no deadline note, CANCELLED", async () => {
    const controller = new WorkerCancellationController();
    const task = invocation();
    const { settled, sent, logs } = await run({
      async prompt(emit, aborted) { emit({ type: "message_start", message: { role: "assistant", content: [] } }); await aborted; emit(abortedEnd()); },
    }, { controller, invocation: task, limits: { stallMs: 400, deadlineMs: 60_000, abortConfirmMs: 2_000 } });
    await wait(50);
    await controller.cancel(task.operationId);
    const result = await settled;
    expect((result as { error: unknown }).error).toBeInstanceOf(WorkerOperationCancelledError);
    await wait(600);
    expect(notes(sent).map((note) => note.outcome)).not.toContain("stalled");
    expect(logs.map((line) => line.json.event)).not.toContain("planning.stalled");
  });

  it("sends a numbers-only heartbeat while the model call is in flight", async () => {
    const { settled, sent } = await run({
      async prompt(emit) { emit({ type: "message_start", message: { role: "assistant", content: [] } }); await wait(450); emit(planEnd()); },
    }, { limits: { heartbeatMs: 100, stallMs: 60_000, deadlineMs: 120_000 } });
    expect((await settled).ok).toBe(true);
    const beats = sent.flatMap((event) => (event.type === "progress" && (event.payload as { heartbeat?: unknown } | null)?.heartbeat !== undefined ? [(event.payload as { heartbeat: Record<string, unknown> }).heartbeat] : []));
    expect(beats.length).toBeGreaterThanOrEqual(1);
    for (const beat of beats) {
      expect(Object.keys(beat).sort()).toEqual(["attempt", "elapsedMs", "phase", "sinceActivityMs"]);
      expect(beat.phase).toBe("model");
      expect(typeof beat.elapsedMs).toBe("number");
    }
  });
});

describe("a model failure in the task's events", () => {
  it("sends one sanitized note for the failed call and its retry, and never the provider's message or the model's thinking", async () => {
    // Pi repeats the failed message in `turn_end` and `agent_end` too.
    const failed = iseMessageEnd().message;
    const raw = [iseMessageEnd(), { type: "turn_end", message: failed, toolResults: [] }, { type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "Plan the change" }] }, failed], willRetry: true },
      { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: SECRET_PROVIDER_TEXT }, planEnd(),
      { type: "auto_retry_end", success: true, attempt: 1 }];
    const { settled, sent, state, artifacts } = await run({ async prompt(emit) { for (const event of raw) emit(event); } });
    expect((await settled).ok).toBe(true);
    // Positive control: the raw events held the secrets, and the worker really saw them.
    expect(JSON.stringify(state.emitted)).toContain(SECRET_THINKING);
    expect(JSON.stringify(state.emitted)).toContain("PRIVATE-PROVIDER-DETAIL");
    expect(notes(sent)).toEqual([
      { outcome: "failed", class: "provider-outage", signal: "InternalServerException", attempt: 1, provider: "amazon-bedrock", requestId: REQUEST_ID, durationMs: 441950 },
      { outcome: "retrying", attempt: 1, maxAttempts: 2, delayMs: 2000 },
      { outcome: "retry-finished", success: true, attempt: 1 },
    ]);
    const everything = JSON.stringify(sent);
    expect(everything).not.toContain(SECRET_THINKING);
    expect(everything).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(everything).not.toContain("unexpected error during processing");
    // The turn and agent ends are still forwarded, without the failed message's text, and the user's own message is kept.
    expect(sent.find((event) => (event.payload as { type?: string } | null)?.type === "turn_end")?.payload).toMatchObject({ message: { role: "assistant", stopReason: "error", content: [] } });
    expect(JSON.stringify(sent.find((event) => (event.payload as { type?: string } | null)?.type === "agent_end")?.payload)).toContain("Plan the change");
    // No raw failure or retry event is forwarded beside the notes.
    expect(sent.filter((event) => ["auto_retry_start", "auto_retry_end"].includes((event.payload as { type?: string } | null)?.type ?? ""))).toEqual([]);
    expect(sent.filter((event) => (event.payload as { type?: string; message?: { stopReason?: string } } | null)?.type === "message_end" && (event.payload as { message?: { stopReason?: string } }).message?.stopReason === "error")).toEqual([]);
    expect(artifacts.find((artifact) => artifact.name === "plan.md")?.content).toContain("Update the route");
  });

  it("fails with the class, error type, request id and call number, and the same text in the error event", async () => {
    const { settled, sent } = await run({ async prompt(emit) { emit(iseMessageEnd()); } });
    const message = (await settled as { error: Error }).error.message;
    expect(message).toBe(`RUNTIME_UNAVAILABLE: the model call failed: provider-outage InternalServerException request ${REQUEST_ID} attempt 1; retry the step`);
    expect(sent.find((event) => event.type === "error")?.payload).toEqual({ message });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE-PROVIDER-DETAIL");
  });

  it("writes a worker log line per failed call, retry and deadline, with fixed fields only", async () => {
    const { settled, logs } = await run({
      async prompt(emit) { emit(iseMessageEnd()); emit({ type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 2000, errorMessage: SECRET_PROVIDER_TEXT }); emit(planEnd()); },
    });
    expect((await settled).ok).toBe(true);
    const lines = logs.filter((line) => String(line.json.event).startsWith("model."));
    expect(lines.map((line) => line.json.event)).toEqual(["model.attempt_failed", "model.retry_scheduled"]);
    expect(lines[0]!.json).toMatchObject({ component: "worker", class: "provider-outage", signal: "InternalServerException", requestId: REQUEST_ID, attempt: 1 });
    expect(JSON.stringify(logs)).not.toContain("PRIVATE-PROVIDER-DETAIL");
    expect(JSON.stringify(logs)).not.toContain(SECRET_THINKING);
  });
});

describe("a refused event send", () => {
  it("does not crash a planning run or lose its result", async () => {
    const { settled, artifacts, logs } = await run({ async prompt(emit) { emit(planEnd()); } }, {
      // Every send is refused, as after a cancel made the operation terminal.
      sink: async () => { throw Object.assign(new Error("worker callback events failed with HTTP 409"), { code: "STALE_FENCE" }); },
    });
    const result = await settled;
    expect(result.ok).toBe(true);
    expect(artifacts.find((artifact) => artifact.name === "plan.md")?.content).toContain("Update the route");
    const refused = logs.filter((line) => line.json.event === "events.refused");
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.length).toBeLessThanOrEqual(10);
    expect(refused[0]!.json).toMatchObject({ component: "worker", errorCode: "STALE_FENCE" });
    expect(JSON.stringify(logs)).not.toContain("HTTP 409");
  });

  it("ends a cancelled run as cancelled, not as the sink's refusal", async () => {
    const controller = new WorkerCancellationController();
    const task = invocation();
    let cancelled = false;
    const { settled } = await run({
      async prompt(emit, aborted) { emit({ type: "message_start", message: { role: "assistant", content: [] } }); await aborted; emit(abortedEnd()); },
    }, {
      controller, invocation: task,
      sink: async (batch, sent) => { if (cancelled) throw new Error("STALE_FENCE terminal operations cannot publish more output"); sent.push(...batch); },
    });
    await wait(50);
    cancelled = true;
    await controller.cancel(task.operationId);
    const result = await settled;
    expect((result as { error: unknown }).error).toBeInstanceOf(WorkerOperationCancelledError);
  });
});

describe("a cancel and the events buffered before it", () => {
  it("sends them before the cancel returns, so the cancel result cannot refuse them", async () => {
    const controller = new WorkerCancellationController();
    const task = invocation();
    const { settled, sent } = await run({
      async prompt(emit, aborted) {
        emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "buffered-note-1" }] } });
        // The stopped call reports nothing urgent and takes a moment to unwind, as a cancel that lands between model events does.
        await aborted;
        await wait(300);
      },
    }, { controller, invocation: task });
    await wait(50);
    // Nothing urgent has happened since the first event: the second one is still waiting in the batcher.
    expect(JSON.stringify(sent)).not.toContain("buffered-note-1");
    await controller.cancel(task.operationId);
    expect(JSON.stringify(sent)).toContain("buffered-note-1");
    expect((await settled).ok).toBe(false);
  });
});
