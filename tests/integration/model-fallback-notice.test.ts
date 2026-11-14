import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelFallbackNotice } from "../../packages/model-runtime/src/index.js";
import { createOrchestratorRuntime } from "../../packages/orchestrator/src/orchestrator.js";
import type { OrchestrationApi } from "../../packages/orchestrator/src/orchestration-tools.js";
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
    const resolved = await workerModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, undefined, undefined, undefined, (notice) => notices.push(notice));
    expect(resolved.model).toMatchObject({ provider: "amazon-bedrock", modelId: CHOSEN });
    expect(notices.map((notice) => notice.text)).toEqual([`ran on Amazon Bedrock \`${CHOSEN}\` because the OpenAI key secret is missing`]);
  });

  it("fails the worker's runtime by name, and tells nobody, when no fallback was chosen", async () => {
    vi.stubEnv("AGENTX_MODEL_FALLBACK", "");
    vi.stubEnv("AGENTX_OPENAI_SECRET_ARN", "");
    const notices: ModelFallbackNotice[] = [];
    await expect(workerModelRuntime({ provider: "openai", modelId: "gpt-5.4" }, undefined, undefined, undefined, (notice) => notices.push(notice))).rejects.toThrow("no fallback model was chosen");
    expect(notices).toEqual([]);
  });

  it("reaches the orchestrator's host the same way", async () => {
    vi.stubEnv("AGENTX_MODEL_FALLBACK", CHOSEN);
    vi.stubEnv("AGENTX_OPENAI_SECRET_ARN", "");
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const notices: ModelFallbackNotice[] = [];
    const runtime = await createOrchestratorRuntime({
      stateDirectory: await createFixtureDirectory("agentx-fallback-notice-"), projectInstructions: "Delegate coding.",
      api: { discoverConnectorTools: async () => undefined } as unknown as OrchestrationApi, context: { workspaceId: randomUUID(), conversationId: randomUUID() },
      model: { provider: "openai", modelId: "gpt-5.4" }, onModelFallback: (notice) => notices.push(notice),
    });
    await runtime.dispose();
    expect(notices.map((notice) => [notice.role, notice.text])).toEqual([["orchestrator", `ran on Amazon Bedrock \`${CHOSEN}\` because the OpenAI key secret is missing`]]);
  });
});

it("worker MODEL3 denial prevents replacement construction and progress reporting",async()=>{
 vi.stubEnv("AGENTX_MODEL_FALLBACK",CHOSEN);vi.stubEnv("AGENTX_OPENAI_SECRET_ARN","");
 const create=vi.spyOn(ModelRuntime,"create"),report=vi.fn(),authorize=vi.fn(async()=>{throw Error("policy refused");});
 await expect(workerModelRuntime({provider:"openai",modelId:"gpt-5.4"},undefined,undefined,undefined,report,authorize)).rejects.toThrow("policy refused");
 expect(create).toHaveBeenCalledTimes(1);expect(report).not.toHaveBeenCalled();expect(authorize).toHaveBeenCalledOnce();
});
it("worker MODEL3 runs the approved model instead of the environment candidate",async()=>{
 vi.stubEnv("AGENTX_MODEL_FALLBACK",CHOSEN);vi.stubEnv("AGENTX_OPENAI_SECRET_ARN","");
 const report=vi.fn(),approved={provider:"amazon-bedrock",modelId:"us.anthropic.claude-haiku-4-5-20251001-v1:0"};
 const result=await workerModelRuntime({provider:"openai",modelId:"gpt-5.4"},undefined,undefined,undefined,report,async()=>({model:approved}));
 expect(result.model).toEqual(approved);expect(report).not.toHaveBeenCalled();
});
