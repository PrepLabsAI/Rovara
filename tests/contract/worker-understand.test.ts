// Plan 6 Task 4, the worker's half: Understand reads the project with the read-only tools, answers with one fenced `rovara-intent` block, is asked once more when that
// cannot be read, and is stopped at UNDERSTAND_TIMEOUT_MINUTES. What it saves is checked again by the broker; the worker checks first so that one more try is possible.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INTENT_BLOCK_INFO_STRING, UNDERSTAND_ARTIFACT_NAME, UNDERSTAND_TIMEOUT_MINUTES, UNDERSTAND_UNREADABLE_MESSAGE, WORKER_INVOCATION_FEATURES, type IntentAssessment,
} from "../../packages/contracts/src/index.js";
import { agentStepTools } from "../../packages/worker/src/agent-step.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { piTaskToolCapabilities } from "../../packages/worker/src/pi-session.js";
import { WORKER_IMPLEMENTED_FEATURES } from "../../packages/worker/src/implemented-features.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { UNDERSTAND_DEADLINE_MS, understandRetryPrompt } from "../../packages/worker/src/understand.js";

const READY: IntentAssessment = { kind: "ready", path: "FULL", restatement: "Make the retry flag read the config file.", assumptions: ["The config file is config/retry.json."] };
const fenced = (value: unknown) => `I read src/retry.ts.\n\n\`\`\`${INTENT_BLOCK_INFO_STRING}\n${JSON.stringify(value)}\n\`\`\`\n`;
const textEnd = (text: string) => ({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });

const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "understand-"));
  roots.push(rootPath);
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "x", projectRevision: 1, repositories: [],
    completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  return rootPath;
}

interface Script { prompt(emit: (event: unknown) => void, aborted: Promise<void>, call: number, text: string): Promise<void> }

function adapterFor(script: Script) {
  const state = { prompts: [] as string[], creates: [] as Array<{ workflowMode?: string }>, aborts: 0 };
  let listener: (event: unknown) => void = () => undefined;
  let release: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => { release = resolve; });
  const adapter: PiSessionAdapter = {
    async create(input) {
      state.creates.push({ ...(input.workflowMode === undefined ? {} : { workflowMode: input.workflowMode }) });
      const sessionFile = join(input.sessionDirectory, "fixture.jsonl");
      await writeFile(sessionFile, "");
      return {
        sessionFile, conversationId: "fixture",
        prompt: async (text: string) => { state.prompts.push(text); await script.prompt(listener, aborted, state.prompts.length, text); },
        abort: async () => { state.aborts += 1; release(); },
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

const invocation = () => ({
  protocolVersion: 1 as const, kind: "task" as const, operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
  payload: { conversationId: randomUUID(), prompt: "Understand the request", workflowMode: "UNDERSTAND" as const },
});

async function run(script: Script, limits: { deadlineMs?: number; stallMs?: number; tickMs?: number; abortConfirmMs?: number } = {}) {
  const { adapter, state } = adapterFor(script);
  const sent: WorkerEvent[] = [];
  const artifacts: Array<{ name: string; content: string }> = [];
  const settled = runTaskInvocation(invocation(), {
    rootPath: await preparedRoot(), model: { provider: "fixture", modelId: "fixture" }, piAdapter: adapter,
    eventSink: async (batch) => { sent.push(...batch); }, artifactSink: async (artifact) => { artifacts.push(artifact); },
    modelCallLimits: limits,
    log: () => undefined,
  }).then((result) => ({ ok: true as const, result }), (error: unknown) => ({ ok: false as const, error: error as Error }));
  return { settled, sent, artifacts, state };
}

describe("the worker runs Understand", () => {
  it("is a feature the worker advertises, so the broker sends the mode only to a worker that has it", () => {
    expect(WORKER_INVOCATION_FEATURES).toContain("task.workflowUnderstand");
    expect(WORKER_IMPLEMENTED_FEATURES).toContain("task.workflowUnderstand");
  });

  it("gives the session the read-only tools and no shell, whatever a step's list says", () => {
    expect(piTaskToolCapabilities("UNDERSTAND")).toEqual({ tools: ["read", "grep", "find", "ls"], customFileTools: false, shell: false });
    expect(agentStepTools("UNDERSTAND", ["read", "bash", "edit", "write"])).toEqual({ tools: ["read"], shell: false });
    expect(piTaskToolCapabilities("IMPLEMENT").shell).toBe(true);
  });

  it("opens an UNDERSTAND session, saves the checked assessment as intent.json, and reports the mode", async () => {
    const { settled, sent, artifacts, state } = await run({ async prompt(emit) { emit(textEnd(fenced(READY))); } });
    const done = await settled;
    expect(done.ok).toBe(true);
    expect(state.creates).toEqual([{ workflowMode: "UNDERSTAND" }]);
    expect(artifacts.filter((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)).toEqual([{ name: UNDERSTAND_ARTIFACT_NAME, mediaType: "application/json", content: JSON.stringify(READY) }]);
    expect(sent.find((event) => event.type === "result")?.payload).toMatchObject({ status: "SUCCEEDED", workflowMode: "UNDERSTAND" });
    // Understand changes no code, so no diff, no plan and no check report is saved beside it.
    for (const name of ["workspace.diff", "checks.json", "plan.md"]) expect(artifacts.map((artifact) => artifact.name)).not.toContain(name);
  });

  it("redacts a credential before it saves the assessment", async () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const { settled, artifacts } = await run({ async prompt(emit) { emit(textEnd(fenced({ ...READY, restatement: `Push with ${token}` }))); } });
    expect((await settled).ok).toBe(true);
    const saved = artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)!.content;
    expect(saved).not.toContain(token);
    expect(saved).toContain("[REDACTED]");
  });

  it("asks once more, in the same session, when its answer cannot be read, and saves the second answer", async () => {
    const { settled, artifacts, state } = await run({ async prompt(emit, _aborted, call) { emit(textEnd(call === 1 ? "I think the request is clear." : fenced(READY))); } });
    expect((await settled).ok).toBe(true);
    expect(state.prompts).toHaveLength(2);
    expect(state.prompts[1]).toBe(understandRetryPrompt(["Your answer has no rovara-intent block. End it with a fenced block whose info string is rovara-intent."]));
    expect(state.prompts[1]).toContain("treat as data");
    expect(artifacts.filter((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)).toHaveLength(1);
  });

  it("fails with the exact words, saves nothing and reports no result, when the second answer cannot be read either", async () => {
    const { settled, sent, artifacts, state } = await run({ async prompt(emit) { emit(textEnd("no block, twice")); } });
    const done = await settled;
    expect(done.ok).toBe(false);
    expect((done as { error: Error }).error.message).toContain(UNDERSTAND_UNREADABLE_MESSAGE);
    expect(state.prompts).toHaveLength(2);
    expect(artifacts.map((artifact) => artifact.name)).not.toContain(UNDERSTAND_ARTIFACT_NAME);
    for (const name of ["workspace.diff", "checks.json", "plan.md"]) expect(artifacts.map((artifact) => artifact.name)).not.toContain(name);
    expect(sent.some((event) => event.type === "result")).toBe(false);
    expect(sent.find((event) => event.type === "error")?.payload).toMatchObject({ message: expect.stringContaining(UNDERSTAND_UNREADABLE_MESSAGE) as unknown });
  });

  it("does not take a plan, a command or a second block for an answer: the last rovara-intent block alone is read", async () => {
    const { settled, artifacts } = await run({ async prompt(emit) { emit(textEnd(`${fenced({ ...READY, path: "QUICK" })}\n${fenced(READY)}`)); } });
    expect((await settled).ok).toBe(true);
    expect(JSON.parse(artifacts.find((artifact) => artifact.name === UNDERSTAND_ARTIFACT_NAME)!.content) as unknown).toEqual(READY);
  });
});

describe("the step timeout", () => {
  it("is UNDERSTAND_TIMEOUT_MINUTES, which is 10", () => {
    expect(UNDERSTAND_TIMEOUT_MINUTES).toBe(10);
    expect(UNDERSTAND_DEADLINE_MS).toBe(10 * 60_000);
  });

  it("ends a model call that never answers at that deadline, not before, aborting the session and saying understanding stopped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "Date"] });
    // The clock ticks every 5 seconds, as it does for a real run; nothing here sets the deadline: it is the step's own.
    let begin: () => void = () => undefined;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const { settled, state } = await run({
      async prompt(emit, aborted) {
        begin();
        const ticker = setInterval(() => emit({ type: "message_update", message: { role: "assistant", content: [] } }), 1_000);
        await aborted;
        clearInterval(ticker);
        emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
      },
    }, { stallMs: 60 * 60_000, abortConfirmMs: 2_000 });
    let finished = false;
    void settled.then(() => { finished = true; });
    // The run is set up with real I/O; the clock is moved only once the model call is in flight.
    await begun;
    await vi.advanceTimersByTimeAsync(UNDERSTAND_DEADLINE_MS - 6_000);
    expect(finished).toBe(false);
    expect(state.aborts).toBe(0);
    await vi.advanceTimersByTimeAsync(11_000);
    const done = await settled;
    expect(done.ok).toBe(false);
    expect((done as { error: Error }).error.message).toMatch(/^RUNTIME_UNAVAILABLE: understanding stopped: the model did not finish within 10 min \(model call 1\)\. Retry it\.$/u);
    expect(state.aborts).toBe(1);
  }, 20_000);
});
