import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { WorkerInvocation } from "@agentx/contracts";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { createReviewSessionOpener } from "../../packages/worker/src/design-review-sessions.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

const model = { provider: "fixture", modelId: "fixture-model" };
async function fixture(events?: unknown[]) {
  const rootPath = await mkdtemp(join(tmpdir(), "missing-usage-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ schemaVersion: 2, projectName: "usage", projectRevision: 1, repositories: [], completedSetupSteps: [], readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString() }));
  const adapter: PiSessionAdapter = { async create(input) {
    const sessionFile = join(input.sessionDirectory, "missing.jsonl"); await writeFile(sessionFile, "");
    const listeners = new Set<(event: unknown) => void>();
    let made = 0;
    return {
      sessionFile, conversationId: "missing", getModel: () => model,
      async prompt() {
        for (const event of events ?? Array.from({ length: 2 }, () => [
          { type: "message_start", message: { role: "assistant", stopReason: "pending", content: [] } },
          { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } },
        ]).flat()) {
          if ((event as { type?: unknown }).type === "message_end") made++;
          for (const listener of listeners) listener(event);
        }
        await writeFile(join(rootPath, "task-complete.txt"), "complete\n");
      },
      getSessionStats: () => ({ sessionFile, sessionId: "missing", userMessages: 1, assistantMessages: made, toolCalls: 0, toolResults: 0, totalMessages: made + 1, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
      abort: async () => undefined, dispose: () => undefined,
    };
  } };
  return { rootPath, adapter };
}
it.each([false, true])("a task sends wholly missing calls even with zero session stats, checkpoints=%s", async checkpoints => {
  const f = await fixture(); const usage: unknown[] = [];
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "work", ...(checkpoints ? { usageCheckpoints: true } : {}) } };
  await runTaskInvocation(invocation, { rootPath: f.rootPath, model, piAdapter: f.adapter, eventSink: async events => { for (const event of events) if (event.type === "usage") usage.push(event.payload); }, artifactSink: async () => undefined });
  expect(usage).toEqual([expect.objectContaining({ usageMissingCalls: 2, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })]);
});
it("a design-review session reports missing usage once when disposed", async () => {
  const f = await fixture(); const usage: unknown[] = [];
  const open = createReviewSessionOpener({ rootPath: f.rootPath, runtimeFor: () => ({ model, piAdapter: f.adapter }), onUsage: payload => usage.push(payload) });
  const session = await open({ purpose: "reviewer", keySlot: "slot-critic", model, system: "Review", tools: [] });
  await session.prompt("review"); session.dispose(); session.dispose();
  expect(usage).toEqual([expect.objectContaining({ usageMissingCalls: 2, costUsd: 0 })]);
});

it("the task forwards stream-start evidence to usage even when the answer ends empty with an HTTP diagnostic", async () => {
  const f = await fixture([
    { type: "message_start", message: { role: "assistant", stopReason: "pending", content: [] } },
    { type: "message_end", message: { role: "assistant", stopReason: "error", status: 429, content: [] } },
  ]);
  const usage: unknown[] = [];
  const invocation: Extract<WorkerInvocation, { kind: "task" }> = { protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "work" } };
  await expect(runTaskInvocation(invocation, { rootPath: f.rootPath, model, piAdapter: f.adapter, eventSink: async events => { for (const event of events) if (event.type === "usage") usage.push(event.payload); }, artifactSink: async () => undefined })).rejects.toThrow();
  expect(usage).toEqual([expect.objectContaining({ usageMissingCalls: 1 })]);
});
