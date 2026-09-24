import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerArtifact } from "../../packages/worker/src/artifacts.js";
import { redactCredentials, type WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { createTaskUsageTelemetry, effectiveCacheRetention } from "../../packages/worker/src/usage.js";
import { describe, expect, it } from "vitest";

const outcomes = ["SUCCEEDED", "FAILED", "CANCELLED"] as const;

describe("worker usage telemetry", () => {
  it.each(outcomes)("publishes matching redacted usage evidence for a %s task", async (outcome) => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation();
    const events: WorkerEvent[] = [];
    const artifacts: WorkerArtifact[] = [];
    const cancellationController = new WorkerCancellationController();
    const execution = runTaskInvocation(invocation, {
      rootPath,
      model: {
        provider: "fixture",
        modelId: "configured-model",
        cacheRetention: "long",
      },
      piAdapter: usageAdapter(rootPath, invocation.operationId, outcome, cancellationController),
      cancellationController,
      eventSink: async (batch) => { events.push(...batch); },
      artifactSink: async (artifact) => { artifacts.push(artifact); },
    });

    // The result carries the broker's conversation ID, never Pi's internal session ID.
    if (outcome === "SUCCEEDED") {
      await expect(execution).resolves.toMatchObject({ conversationId: invocation.payload.conversationId });
    }
    if (outcome === "FAILED") await expect(execution).rejects.toThrow("fixture task failed");
    if (outcome === "CANCELLED") await expect(execution).rejects.toBeInstanceOf(WorkerOperationCancelledError);

    const usageEvents = events.filter((event) => event.type === "usage");
    const usageArtifacts = artifacts.filter((artifact) => artifact.name === "usage.json");
    expect(usageEvents).toHaveLength(1);
    expect(usageArtifacts).toHaveLength(1);
    const artifactPayload = JSON.parse(usageArtifacts[0]!.content) as Record<string, unknown>;
    expect(usageEvents[0]!.payload).toEqual(artifactPayload);
    expect(artifactPayload).toMatchObject({
      schemaVersion: 1,
      outcome,
      provider: "fixture",
      modelId: "fixture?token=[REDACTED]",
      cacheRetention: "long",
      tokens: { input: 100, output: 50, cacheRead: 80, cacheWrite: 20, total: 250 },
      cacheReadRatio: 0.4,
      costUsd: 0.0123,
    });
    expect(JSON.stringify({ events: usageEvents, artifacts: usageArtifacts })).not.toContain("top-secret");
  });

  it("matches Pi's short fallback and reports a finite ratio for a zero-token session", () => {
    expect(effectiveCacheRetention(undefined)).toBe("short");
    expect(effectiveCacheRetention("unsupported")).toBe("short");
    expect(effectiveCacheRetention("long")).toBe("long");
    expect(createTaskUsageTelemetry({
      sessionFile: undefined,
      sessionId: "zero",
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    }, { provider: "fixture", modelId: "fixture" }, "FAILED")).toMatchObject({
      cacheRetention: "short",
      cacheReadRatio: 0,
    });
    expect(redactCredentials({ tokens: "top-secret" })).toEqual({ tokens: "[REDACTED]" });
  });

  it("preserves the task error when usage artifact publication also fails", async () => {
    const rootPath = await preparedRoot();
    const invocation = taskInvocation();
    const cancellationController = new WorkerCancellationController();
    await expect(runTaskInvocation(invocation, {
      rootPath,
      model: { provider: "fixture", modelId: "fixture", cacheRetention: "long" },
      piAdapter: usageAdapter(rootPath, invocation.operationId, "FAILED", cancellationController),
      cancellationController,
      eventSink: async () => undefined,
      artifactSink: async (artifact) => {
        if (artifact.name === "usage.json") throw new Error("usage callback unavailable");
      },
    })).rejects.toThrow("fixture task failed");
  });
});

function usageAdapter(
  rootPath: string,
  operationId: string,
  outcome: typeof outcomes[number],
  cancellationController: WorkerCancellationController,
): PiSessionAdapter {
  return {
    async create({ sessionDirectory }) {
      const sessionFile = join(sessionDirectory, "usage-session.jsonl");
      await writeFile(sessionFile, "");
      return {
        conversationId: "usage-session",
        sessionFile,
        async prompt() {
          if (outcome === "FAILED") throw new Error("fixture task failed");
          if (outcome === "CANCELLED") {
            await cancellationController.cancel(operationId);
            throw new Error("fixture task aborted");
          }
          await writeFile(join(rootPath, "task-complete.txt"), "complete\n");
        },
        async abort() {},
        getModel: () => ({ provider: "fixture", modelId: "fixture?token=top-secret" }),
        getSessionStats: () => ({
          sessionFile,
          sessionId: "usage-session",
          userMessages: 1,
          assistantMessages: 1,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 2,
          tokens: { input: 100, output: 50, cacheRead: 80, cacheWrite: 20, total: 250 },
          cost: 0.0123,
        }),
        subscribe: () => () => undefined,
        dispose() {},
      };
    },
  };
}

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-usage-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2,
    projectName: "usage",
    projectRevision: 1,
    repositories: [],
    completedSetupSteps: [],
    readinessResults: [],
    creationIdentity: "fixture",
    complete: true,
    updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1,
    kind: "task",
    operationId: randomUUID(),
    workspaceId: randomUUID(),
    fence: 1,
    projectRevision: 1,
    callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "measure this task" },
  };
}
