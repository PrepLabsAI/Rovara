import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerInvocation } from "@agentx/contracts";
import { fauxAssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { WorkerCancellationController, WorkerOperationCancelledError } from "../../packages/worker/src/cancel.js";
import type { WorkerEvent } from "../../packages/worker/src/events.js";
import type { PiSessionAdapter } from "../../packages/worker/src/pi-session.js";
import { runTaskInvocation } from "../../packages/worker/src/run-task.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

/** A real pi session on the scripted model, so the worker sees exactly what pi emits (#136). */
async function realPi(responses: FauxResponseStep[]) {
  const { modelRuntime, faux } = await fauxModelRuntime();
  faux.setResponses(responses);
  const adapter: PiSessionAdapter = {
    async create({ cwd, sessionDirectory, agentDirectory }) {
      const model = modelRuntime.getModel(FAUX_MODEL.provider, FAUX_MODEL.modelId)!;
      const { session } = await createAgentSession({
        cwd, agentDir: agentDirectory, modelRuntime, model, thinkingLevel: "off", tools: ["bash"],
        sessionManager: SessionManager.create(cwd, sessionDirectory),
      });
      return {
        conversationId: "turn", sessionFile: session.sessionFile!,
        prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
        steer: (text) => session.steer(text),
        abort: () => session.abort(),
        getModel: () => ({ provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }),
        getSessionStats: () => session.getSessionStats(),
        subscribe: (listener) => session.subscribe((event) => listener(event)),
        dispose: () => session.dispose(),
      };
    },
  };
  return adapter;
}

async function run(adapter: PiSessionAdapter, cancellationController?: WorkerCancellationController, invocation = taskInvocation()) {
  const events: WorkerEvent[] = [];
  const outcome = await runTaskInvocation(invocation, {
    rootPath: await preparedRoot(), model: { provider: FAUX_MODEL.provider, modelId: FAUX_MODEL.modelId }, piAdapter: adapter,
    eventSink: async (batch) => { events.push(...batch); }, artifactSink: async () => undefined,
    ...(cancellationController === undefined ? {} : { cancellationController }),
  }).then(() => "SUCCEEDED" as const, (error: unknown) => error);
  const usage = events.find((event) => event.type === "usage")?.payload as { outcome?: string } | undefined;
  return { outcome, usageOutcome: usage?.outcome, events };
}

describe("a task whose model call fails", () => {
  it("fails with the model's error instead of succeeding, and records FAILED usage", async () => {
    const adapter = await realPi([fauxAssistantMessage([], {
      stopReason: "error", errorMessage: "OpenRouter request failed; check the key's credit balance and spending limit",
    })]);
    const { outcome, usageOutcome, events } = await run(adapter);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("RUNTIME_UNAVAILABLE: the model call failed: OpenRouter request failed; check the key's credit balance and spending limit");
    expect(usageOutcome).toBe("FAILED");
    expect(events.filter((event) => event.type === "result")).toEqual([]);
    expect(events).toContainEqual(expect.objectContaining({ type: "error", payload: { message: (outcome as Error).message } }));
  });

  it("redacts credentials that a provider's error message carries", async () => {
    const adapter = await realPi([fauxAssistantMessage([], {
      // Not a transient error, so pi does not retry it.
      stopReason: "error", errorMessage: "400 invalid request to https://user:hunter2@proxy.example.test/v1?token=abc123",
    })]);
    const { outcome } = await run(adapter);
    expect((outcome as Error).message).not.toContain("hunter2");
    expect((outcome as Error).message).not.toContain("abc123");
    expect((outcome as Error).message).toContain("[REDACTED]");
  });

  it("judges the turn by its last model call: a transient failure pi retries successfully is a success", async () => {
    const adapter = await realPi([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "fetch failed" }),
      fauxAssistantMessage("Done after a retry."),
    ]);
    const { outcome, usageOutcome } = await run(adapter);
    expect(outcome).toBe("SUCCEEDED");
    expect(usageOutcome).toBe("SUCCEEDED");
  });

  it("still succeeds when the model answers", async () => {
    const adapter = await realPi([fauxAssistantMessage("The tests pass.")]);
    const { outcome, usageOutcome } = await run(adapter);
    expect(outcome).toBe("SUCCEEDED");
    expect(usageOutcome).toBe("SUCCEEDED");
  });

  it("reports a cancelled turn as CANCELLED, not as a success", async () => {
    const cancellationController = new WorkerCancellationController();
    const invocation = taskInvocation();
    // A model that never answers until it is aborted.
    const adapter = await realPi([async (_context, options) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return fauxAssistantMessage([], { stopReason: "aborted" });
    }]);
    const running = run(adapter, cancellationController, invocation);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await cancellationController.cancel(invocation.operationId);
    const { outcome, usageOutcome } = await running;
    expect(outcome).toBeInstanceOf(WorkerOperationCancelledError);
    expect(usageOutcome).toBe("CANCELLED");
  });
});

async function preparedRoot(): Promise<string> {
  const rootPath = await mkdtemp(join(tmpdir(), "agentx-turn-"));
  await mkdir(join(rootPath, ".agentx"));
  await writeFile(join(rootPath, ".agentx/preparation-manifest.json"), JSON.stringify({
    schemaVersion: 2, projectName: "turn", projectRevision: 1, repositories: [], completedSetupSteps: [],
    readinessResults: [], creationIdentity: "fixture", complete: true, updatedAt: new Date().toISOString(),
  }));
  return rootPath;
}

function taskInvocation(): Extract<WorkerInvocation, { kind: "task" }> {
  return {
    protocolVersion: 1, kind: "task", operationId: randomUUID(), workspaceId: randomUUID(), fence: 1, projectRevision: 1,
    callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "add the footer" },
  };
}
