import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createPiSessionRuntime, runOrchestratorTurn } from "../../packages/orchestrator/src/orchestrator.js";
import { TurnRecorder } from "../../packages/orchestrator/src/turn-recorder.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
import { createHostedSlackRuntime } from "../../packages/slack-service/src/runtime.js";
import { createFixtureDirectory } from "../fixtures/index.js";
import { FAUX_MODEL, fauxModelRuntime } from "../support/faux-model.js";

const secret = "SECRET-in-error-message-and-stack";

describe("Pi extension error reporting", () => {
  it("wires hosted failures to the host callback and the current turn recorder", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const recorder = new TurnRecorder();
    const failures = vi.fn();
    vi.spyOn(recorder, "extension").mockReturnValue({ name: "agentx-turn-recorder", factory: (pi) => {
      pi.on("agent_end", () => { throw new Error(secret); });
    } });
    const runtime = await createHostedSlackRuntime({
      message: {
        version: 1, eventId: "EvERROR00001", receivedAt: "2026-09-27T10:00:00.000Z", userId: "U0123456789",
        thread: { teamId: "T0BSHLLUGBD", channelId: "C0123456789", threadTs: "1695500000.000001" }, text: "hello",
      },
      subject: "T0BSHLLUGBD/C0123456789/1695500000.000001",
      workspaceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222",
      orchestratorInstructions: "Delegate coding.", requestId: () => "33333333-3333-4333-8333-333333333333", recorder,
    }, {
      stateDirectory: await createFixtureDirectory("agentx-hosted-errors-"),
      api: {} as OrchestrationApi, model: FAUX_MODEL, modelRuntime, onExtensionError: failures,
    });
    try {
      faux.setResponses([fauxAssistantMessage("Hello.")]);
      expect(await runOrchestratorTurn(runtime, "hello", recorder)).toBe("Hello.");
      expect(failures).toHaveBeenCalledExactlyOnceWith({ extension: "agentx-turn-recorder", event: "agent_end", errorName: "unknown" });
      expect(recorder.observation().recordingErrors).toEqual(["handler_failed:agentx-turn-recorder:agent_end"]);
    } finally { await runtime.dispose(); }
  });

  it("reports startup and turn failures once per session, including replacement and resume", async () => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const failures = vi.fn();
    const recorder = new TurnRecorder();
    let starts = 0;
    const runtime = await createPiSessionRuntime({
      stateDirectory: await createFixtureDirectory("agentx-extension-errors-"), modelRuntime, model: FAUX_MODEL,
      systemPrompt: "Reply briefly.", customTools: [], onExtensionError: failures, turnRecorder: recorder,
      extensions: [{ name: "test-extension", factory: (pi) => {
        pi.on("session_start", () => { starts += 1; throw new TypeError(secret); });
        pi.on("agent_end", async () => { throw new Error(secret); });
      } }],
    });
    try {
      expect(starts).toBe(1);
      expect(failures).toHaveBeenCalledExactlyOnceWith({ extension: "test-extension", event: "session_start", errorName: "unknown" });
      faux.setResponses([fauxAssistantMessage("Done.")]);
      expect(await runOrchestratorTurn(runtime, "hello")).toBe("Done.");
      const saved = runtime.session.sessionFile!;
      expect(failures).toHaveBeenCalledTimes(2);
      await runtime.newSession();
      expect(starts).toBe(2);
      await runtime.switchSession(saved);
      expect(starts).toBe(3);
      faux.setResponses([fauxAssistantMessage("Resumed.")]);
      expect(await runOrchestratorTurn(runtime, "again")).toBe("Resumed.");
      expect(failures).toHaveBeenCalledTimes(5);
      expect(recorder.observation().recordingErrors).toEqual([
        "handler_failed:test-extension:session_start", "handler_failed:test-extension:agent_end",
      ]);
      expect(JSON.stringify(failures.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(recorder.observation())).not.toContain(secret);
      runtime.session.extensionRunner.emitError({ extensionPath: `/private/${secret}`, event: secret, error: secret, stack: secret });
      expect(failures).toHaveBeenLastCalledWith({ extension: "unknown", event: "unknown", errorName: "unknown" });
    } finally { await runtime.dispose(); }
  });

  it.each(["no recorder", "logger throws", "recorder throws"])("keeps reporting independent when %s", async (mode) => {
    const { modelRuntime, faux } = await fauxModelRuntime();
    const recorder = mode === "no recorder" ? undefined : new TurnRecorder();
    if (mode === "recorder throws") vi.spyOn(recorder!, "recordingFailed").mockImplementation(() => { throw new Error(secret); });
    const failures = vi.fn(() => { if (mode === "logger throws") throw new Error(secret); });
    const runtime = await createPiSessionRuntime({
      stateDirectory: await createFixtureDirectory("agentx-extension-sinks-"), modelRuntime, model: FAUX_MODEL,
      systemPrompt: "Reply briefly.", customTools: [], onExtensionError: failures,
      ...(recorder === undefined ? {} : { turnRecorder: recorder }),
      extensions: [{ name: "test-extension", factory: (pi) => {
        pi.on("agent_end", () => { throw new Error(secret); });
      } }],
    });
    try {
      faux.setResponses([fauxAssistantMessage("Done.")]);
      expect(await runOrchestratorTurn(runtime, "hello")).toBe("Done.");
      expect(failures).toHaveBeenCalledExactlyOnceWith({ extension: "test-extension", event: "agent_end", errorName: "unknown" });
      if (mode === "logger throws") expect(recorder!.observation().recordingErrors).toEqual(["handler_failed:test-extension:agent_end"]);
    } finally { await runtime.dispose(); }
  });
});
