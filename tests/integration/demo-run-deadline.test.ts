import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";

afterEach(() => vi.useRealTimers());

it("terminates the task at 180 seconds even when the model/tool and abort do not settle", async () => {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-demo-deadline-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({ complete: true, projectRevision: 1 }));
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  let releasePrompt!: () => void;
  let disposed = false;
  const artifacts: unknown[] = [];
  let outcome: unknown;
  const job = runTaskInvocation({
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(),
    fence: 1, projectRevision: 1, callbackCapability: "c".repeat(64),
    payload: { conversationId: randomUUID(), prompt: "Small demo task" },
  }, {
    rootPath, model: { provider: "amazon-bedrock", modelId: "amazon.nova-pro-v1:0" },
    demoLimits: true,
    eventSink: async () => undefined,
    artifactSink: async (artifact) => { artifacts.push(artifact); },
    piAdapter: { create: async ({ sessionDirectory }) => ({
      conversationId: randomUUID(), sessionFile: join(sessionDirectory, "session.jsonl"),
      prompt: async () => { started(); await new Promise<void>((resolve) => { releasePrompt = resolve; }); },
      abort: async () => { aborted = true; await new Promise(() => undefined); },
      dispose: () => { disposed = true; }, subscribe: () => () => undefined,
    }) },
  }).then(() => { outcome = "success"; }, (error: Error) => { outcome = error.message; });
  await ready;
  await vi.advanceTimersByTimeAsync(179_999);
  expect(outcome).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(outcome).toBe("DEMO_TASK_DEADLINE");
  expect(aborted).toBe(true);
  expect(artifacts).toEqual([]);
  await job;
  releasePrompt();
  await vi.advanceTimersByTimeAsync(0);
  expect(disposed).toBe(true);
  expect(artifacts).toEqual([]);
  expect(outcome).toBe("DEMO_TASK_DEADLINE");
});
