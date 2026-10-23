import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelFallbackNotice } from "../../packages/model-runtime/src/index.js";
import { createOrchestratorRuntime, type OrchestrationApi } from "../../packages/orchestrator/src/orchestrator.js";
import { workerModelRuntime } from "../../packages/worker/src/pi-session.js";
import { createFixtureDirectory } from "../fixtures/index.js";

// M1.4 Task 4.10D, test 41 (MODEL3): where the fallback notice goes. The worker tells its task (a progress event on the task page) and the orchestrator hands the host the same notice, which the Slack
// service puts under the reply.

const CHOSEN = "us.anthropic.claude-sonnet-4-6";
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("the fallback notice", () => {
  it("reaches the worker's host through onModelFallback, once, with the sentence naming the model and the missing secret", async () => {
    vi.stubEnv("AGENTX_MODEL_FALLBACK", CHOSEN);
    vi.stubEnv("AGENTX_OPENAI_SECRET_ARN", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const notices: ModelFallbackNotice[] = [];
    const resolved = await workerModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, undefined, undefined, (notice) => notices.push(notice));
    expect(resolved.model).toMatchObject({ provider: "amazon-bedrock", modelId: CHOSEN });
    expect(notices.map((notice) => notice.text)).toEqual([`ran on Amazon Bedrock \`${CHOSEN}\` because the OpenAI key secret is missing`]);
  });

  it("fails the worker's runtime by name, and tells nobody, when no fallback was chosen", async () => {
    vi.stubEnv("AGENTX_MODEL_FALLBACK", "");
    vi.stubEnv("AGENTX_OPENAI_SECRET_ARN", "");
    const notices: ModelFallbackNotice[] = [];
    await expect(workerModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, undefined, undefined, (notice) => notices.push(notice))).rejects.toThrow("no fallback model was chosen");
    expect(notices).toEqual([]);
  });

  it("reaches the orchestrator's host the same way", async () => {
    vi.stubEnv("AGENTX_MODEL_FALLBACK", CHOSEN);
    vi.stubEnv("AGENTX_OPENAI_SECRET_ARN", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const notices: ModelFallbackNotice[] = [];
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-fallback-notice-"), projectInstructions: "Delegate coding.",
      api: {} as unknown as OrchestrationApi, context: { workspaceId: randomUUID(), conversationId: randomUUID() },
      model: { provider: "openai", modelId: "gpt-5.4" }, onModelFallback: (notice) => notices.push(notice),
    });
    await runtime.dispose();
    expect(notices.map((notice) => [notice.role, notice.text])).toEqual([["orchestrator", `ran on Amazon Bedrock \`${CHOSEN}\` because the OpenAI key secret is missing`]]);
  });
});
