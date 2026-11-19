// Per-run dollar stop (core money stop): a run asked for `usageCheckpoints` reports what it spent since its last report after a model call ends, so the broker books it while the run goes and
// can stop the run at its cap. The end's usage event is what is left. A run not asked reports once, at its end, as before.
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { runAgentStep, type RunAgentStepInput } from "../../packages/worker/src/agent-run/run-agent-step.js";
import { createUsageCheckpointer } from "../../packages/worker/src/usage.js";

type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
const tokens = (input: number, output: number): Tokens => ({ input, output, cacheRead: 0, cacheWrite: 0, total: input + output });

/** A session whose prompt makes `calls` model calls; each call adds `perCall` to the session's stats and ends with an assistant message_end. */
function checkpointAdapter(rootPath: string, calls: number, perCall: { input: number; output: number; cost: number }, end?: { cancel: { controller: WorkerCancellationController; operationId: string } }): PiSessionAdapter {
  return {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "checkpoint-session.jsonl");
      await writeFile(sessionFile, "");
      const listeners = new Set<(event: unknown) => void>();
      let made = 0;
      return {
        conversationId: "checkpoint-session",
        sessionFile,
        async prompt() {
          for (let call = 0; call < calls; call += 1) {
            for (const listener of listeners) listener({ type: "message_start", message: { role: "assistant", stopReason: "pending", content: [] } });
            made += 1;
            for (const listener of listeners) listener({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [], usage: { input: perCall.input, output: perCall.output, cost: { total: perCall.cost } } } });
            await new Promise((resolve) => setImmediate(resolve));
          }
          if (end?.cancel !== undefined) {
            await end.cancel.controller.cancel(end.cancel.operationId);
            throw new Error("aborted");
          }
          await writeFile(join(rootPath, "task-complete.txt"), "complete\n");
        },
        async abort() {},
        getModel: () => ({ provider: "fixture", modelId: "fixture-model" }),
        getSessionStats: () => ({
          sessionFile, sessionId: "checkpoint-session", userMessages: 1, assistantMessages: made, toolCalls: 0, toolResults: 0, totalMessages: 1 + made,
          tokens: tokens(perCall.input * made, perCall.output * made), cost: Math.round(perCall.cost * made * 1e9) / 1e9,
        }),
        subscribe: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
        dispose() {},
      };
    },
  };
}

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-checkpoints-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "usage", projectRevision: 1, repositories: [], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

function taskInvocation(checkpoints: boolean): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "spend as you go", ...(checkpoints ? { usageCheckpoints: true as const } : {}) },
  };
}

const usageEvents = (events: WorkerEvent[]) => events.filter((event) => event.type === "usage").map((event) => event.payload as { tokens: Tokens; costUsd: number | null; checkpoint?: true; outcome: string });
const sum = (payloads: ReturnType<typeof usageEvents>) => payloads.reduce((total, payload) => total + payload.tokens.input, 0);

describe("usage checkpoints", () => {
  it("reports the spend so far after model calls, and only what is left at the end: the reports add up to the run's spend", async () => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation(true);
    const events: WorkerEvent[] = [];
    await runTaskInvocation(invocation, {
      rootPath, model: { provider: "fixture", modelId: "fixture-model" }, piAdapter: checkpointAdapter(rootPath, 3, { input: 100, output: 10, cost: 0.01 }),
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined, modelCallLimits: { usageCheckpointMs: 0 },
    });
    const usage = usageEvents(events);
    // One report per model call (the checkpoint wait is 0 here), and the end tells that nothing is left (a zero, marked final).
    expect(usage.filter((payload) => payload.checkpoint === true)).toHaveLength(3);
    expect(usage.map((payload) => payload.tokens.input)).toEqual([100, 100, 100, 0]);
    expect(usage.at(-1)).toMatchObject({ final: true, outcome: "SUCCEEDED" });
    expect(usage.at(-1)).not.toHaveProperty("checkpoint");
    expect(sum(usage)).toBe(300);
    expect(usage.filter((payload) => payload.checkpoint === true).every((payload) => payload.costUsd !== null && Math.abs(payload.costUsd - 0.01) < 1e-9)).toBe(true);
  });

  it("sends what is left since the last checkpoint at the end, when the wait between checkpoints holds some back", async () => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation(true);
    const events: WorkerEvent[] = [];
    await runTaskInvocation(invocation, {
      rootPath, model: { provider: "fixture", modelId: "fixture-model" }, piAdapter: checkpointAdapter(rootPath, 3, { input: 100, output: 10, cost: 0.01 }),
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined, modelCallLimits: { usageCheckpointMs: 60_000 },
    });
    // No checkpoint is due within the minute: the end reports the whole run, as a run not asked does.
    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]).not.toHaveProperty("checkpoint");
    expect(sum(usage)).toBe(300);
  });

  it("a stopped run reports its checkpoints and then the rest before it ends cancelled", async () => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation(true);
    const controller = new WorkerCancellationController();
    const events: WorkerEvent[] = [];
    await expect(runTaskInvocation(invocation, {
      rootPath, model: { provider: "fixture", modelId: "fixture-model" }, cancellationController: controller,
      piAdapter: checkpointAdapter(rootPath, 2, { input: 50, output: 5, cost: 0.005 }, { cancel: { controller, operationId: invocation.operationId } }),
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined, modelCallLimits: { usageCheckpointMs: 0 },
    })).rejects.toBeInstanceOf(WorkerOperationCancelledError);
    expect(sum(usageEvents(events))).toBe(100);
  });

  it("a stop sends what was spent at once, before the ending's other work, even between checkpoints", async () => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation(true);
    const controller = new WorkerCancellationController();
    const events: WorkerEvent[] = [];
    await expect(runTaskInvocation(invocation, {
      rootPath, model: { provider: "fixture", modelId: "fixture-model" }, cancellationController: controller,
      piAdapter: checkpointAdapter(rootPath, 2, { input: 50, output: 5, cost: 0.005 }, { cancel: { controller, operationId: invocation.operationId } }),
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined, modelCallLimits: { usageCheckpointMs: 60_000 },
    })).rejects.toBeInstanceOf(WorkerOperationCancelledError);
    const usage = usageEvents(events);
    expect(usage[0]).toMatchObject({ checkpoint: true, tokens: tokens(100, 10) });
    expect(usage.at(-1)).toMatchObject({ final: true, outcome: "CANCELLED", tokens: tokens(0, 0) });
    expect(sum(usage)).toBe(100);
  });

  it("an agent step reports as it goes too, and its end tells what is left", async () => {
    const rootPath = await preparedRoot();
    const events: WorkerEvent[] = [];
    const operationId = randomUUID();
    await runAgentStep({
      payload: { kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa", version: 1, stepId: "triage", instructions: "Triage.", workspace: "none", inputs: "Request" },
      operationId, workspaceId: randomUUID(), conversationId: randomUUID(), capability: "c".repeat(64), brokerUrl: "http://broker.invalid",
      workspace: { rootPath, localFileTools: true }, modelAccess: { model: { provider: "fixture", modelId: "fixture-model" }, piAdapter: checkpointAdapter(rootPath, 2, { input: 40, output: 4, cost: 0.004 }) },
      eventSink: async (batch: readonly WorkerEvent[]) => { events.push(...batch); }, artifactSink: async () => undefined, catalogs: async () => [], call: async () => ({ status: "SUCCEEDED", text: "ok" }),
      usageCheckpoints: { intervalMs: 0 },
    } as unknown as RunAgentStepInput).catch(() => undefined);
    const usage = usageEvents(events);
    expect(usage.filter((payload) => payload.checkpoint === true).map((payload) => payload.tokens.input)).toEqual([40, 40]);
    expect(usage.at(-1)).toMatchObject({ final: true });
    expect(sum(usage)).toBe(80);
  });

  it("an agent step not asked reports once, at its end", async () => {
    const rootPath = await preparedRoot();
    const events: WorkerEvent[] = [];
    await runAgentStep({
      payload: { kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa", version: 1, stepId: "triage", instructions: "Triage.", workspace: "none", inputs: "Request" },
      operationId: randomUUID(), workspaceId: randomUUID(), conversationId: randomUUID(), capability: "c".repeat(64), brokerUrl: "http://broker.invalid",
      workspace: { rootPath, localFileTools: true }, modelAccess: { model: { provider: "fixture", modelId: "fixture-model" }, piAdapter: checkpointAdapter(rootPath, 2, { input: 40, output: 4, cost: 0.004 }) },
      eventSink: async (batch: readonly WorkerEvent[]) => { events.push(...batch); }, artifactSink: async () => undefined, catalogs: async () => [], call: async () => ({ status: "SUCCEEDED", text: "ok" }),
    } as unknown as RunAgentStepInput).catch(() => undefined);
    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]).not.toHaveProperty("checkpoint");
    expect(usage[0]).not.toHaveProperty("final");
    expect(sum(usage)).toBe(80);
  });

  it("the checkpointer of any session (parts, reviewers): one report per due model call, the end is what is left", () => {
    let made = 0;
    let clock = 0;
    const sent: Array<Record<string, unknown>> = [];
    const stats = () => ({ tokens: tokens(10 * made, 0), cost: 0.001 * made });
    const checkpoints = createUsageCheckpointer({ enabled: true, intervalMs: 5, baseline: undefined, stats, model: () => ({ provider: "p", modelId: "m" }), requested: {}, send: (payload) => sent.push(payload), now: () => clock });
    const end = { type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 10 } } };
    made = 1; checkpoints.observe(end);
    expect(sent).toEqual([]);
    clock = 5; checkpoints.observe({ type: "message_end", message: { role: "user" } });
    expect(sent).toEqual([]);
    checkpoints.observe(end);
    expect(sent).toEqual([expect.objectContaining({ checkpoint: true, tokens: tokens(10, 0) })]);
    made = 3; clock = 6; checkpoints.observe(end);
    expect(sent).toHaveLength(1);
    expect(checkpoints.endReport(stats(), { provider: "p", modelId: "m" }, "FAILED", {})).toMatchObject({ final: true, tokens: tokens(20, 0), outcome: "FAILED" });
    const off = createUsageCheckpointer({ enabled: false, intervalMs: 0, baseline: undefined, stats, model: () => ({ provider: "p", modelId: "m" }), requested: {}, send: (payload) => sent.push(payload) });
    off.observe(end); off.checkpointNow();
    expect(sent).toHaveLength(1);
    expect(off.endReport(stats(), { provider: "p", modelId: "m" }, "SUCCEEDED", {})).not.toHaveProperty("final");
    made = 0;
    expect(off.endReport(stats(), { provider: "p", modelId: "m" }, "SUCCEEDED", {})).toBeUndefined();
  });

  it("a run not asked for checkpoints reports once, at its end (unchanged)", async () => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation(false);
    const events: WorkerEvent[] = [];
    await runTaskInvocation(invocation, {
      rootPath, model: { provider: "fixture", modelId: "fixture-model" }, piAdapter: checkpointAdapter(rootPath, 3, { input: 100, output: 10, cost: 0.01 }),
      eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined, modelCallLimits: { usageCheckpointMs: 0 },
    });
    const usage = usageEvents(events);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ outcome: "SUCCEEDED", tokens: tokens(300, 30) });
    expect(usage[0]).not.toHaveProperty("checkpoint");
  });
});

it.each([false, true])("counts missing usage per assistant call with checkpoints enabled=%s, including a wholly empty session", (enabled) => {
  let stats = { tokens: tokens(10, 2), cost: 0.01 };
  const sent: Array<Record<string, unknown>> = [];
  const model = { provider: "p", modelId: "m" };
  const tracker = createUsageCheckpointer({ enabled, intervalMs: 0, baseline: stats, stats: () => stats, model: () => model, requested: {}, send: payload => sent.push(payload) });
  tracker.observe({ type: "message_end", message: { role: "user" } });
  tracker.observe({ type: "message_start", message: { role: "assistant", stopReason: "pending" } });
  tracker.observe({ type: "message_end", message: { role: "assistant", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } } } });
  tracker.observe({ type: "message_start", message: { role: "assistant", stopReason: "pending" } });
  tracker.observe({ type: "message_end", message: { role: "assistant" } });
  stats = { tokens: tokens(20, 4), cost: 0.02 };
  tracker.observe({ type: "message_end", message: { role: "assistant", usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0.01 } } } });
  const end = tracker.endReport(stats, model, "SUCCEEDED", {});
  const reports = [...sent, ...(end === undefined ? [] : [end])];
  expect(reports.reduce((sum, r) => sum + Number(r.usageMissingCalls ?? 0), 0)).toBe(2);
  expect(reports.reduce((sum, r) => sum + Number((r.tokens as Tokens).input), 0)).toBe(10);
  const empty = createUsageCheckpointer({ enabled, baseline: undefined, stats: () => ({ tokens: tokens(0, 0), cost: 0 }), model: () => model, requested: {}, send: () => undefined });
  empty.observe({ type: "message_start", message: { role: "assistant", stopReason: "pending" } });
  empty.observe({ type: "message_end", message: { role: "assistant" } });
  expect(empty.endReport({ tokens: tokens(0, 0), cost: 0 }, model, "FAILED", {})).toMatchObject({ usageMissingCalls: 1, costUsd: 0 });
});

it("an agent step without checkpoints reports wholly missing calls through its session hook", async () => {
  const rootPath = await preparedRoot();
  const events: WorkerEvent[] = [];
  await runAgentStep({
    payload: { kind: "agent", agentId: "agt_aaaaaaaaaaaaaaaaaaaa", version: 1, stepId: "triage", instructions: "Triage.", workspace: "none", inputs: "Request" },
    operationId: randomUUID(), workspaceId: randomUUID(), conversationId: randomUUID(), capability: "c".repeat(64), brokerUrl: "http://broker.invalid",
    workspace: { rootPath, localFileTools: true }, modelAccess: { model: { provider: "fixture", modelId: "fixture-model" }, piAdapter: checkpointAdapter(rootPath, 2, { input: 0, output: 0, cost: 0 }) },
    eventSink: async (batch: readonly WorkerEvent[]) => { events.push(...batch); }, artifactSink: async () => undefined, catalogs: async () => [], call: async () => ({ status: "SUCCEEDED", text: "ok" }),
  } as unknown as RunAgentStepInput).catch(() => undefined);
  expect(events.filter(event => event.type === "usage").map(event => event.payload)).toEqual([expect.objectContaining({ usageMissingCalls: 2, costUsd: 0 })]);
});
