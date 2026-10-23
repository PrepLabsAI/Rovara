import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntimeWithFallback, modelFallbackModel, type ModelFallbackNotice } from "../../packages/model-runtime/src/index.js";

// M1.4 Task 4.10D, test 41 (MODEL3): a missing provider secret never moves work to a Bedrock model nobody chose. Without a chosen fallback the call fails by name and makes no Bedrock runtime;
// with one it runs on that model and says so.

const openaiArn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:agentx/test/openai-AbCdEf";
const selected = { provider: "openai", modelId: "gpt-5.4" } as const;
const CHOSEN = "us.anthropic.claude-sonnet-4-6";

afterEach(() => vi.restoreAllMocks());

describe("no silent fallback (test 41)", () => {
  it.each(["worker", "orchestrator", "classifier"] as const)("fails the %s's call by name when the secret is missing and no fallback was chosen, and builds no Bedrock runtime", async (role) => {
    const create = vi.spyOn(ModelRuntime, "create");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const environment of [{}, { AGENTX_MODEL_FALLBACK: "none" }, { AGENTX_MODEL_FALLBACK: "" }]) {
      create.mockClear();
      await expect(createModelRuntimeWithFallback(selected, role, { environment })).rejects.toThrow(
        "The OpenAI key secret is missing, and no fallback model was chosen. Restore the key, or choose a fallback with `agentx config set models.fallback <bedrock model id>`",
      );
      // The OpenAI runtime is made before its key is read; a Bedrock one would be a second call.
      expect(create).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("model_fallback"));
    }
  });

  it("no longer reads the role's or the worker's own Bedrock model as a fallback", async () => {
    const environment = { AGENTX_MODEL_PROVIDER: "amazon-bedrock", AGENTX_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0", AGENTX_ORCHESTRATOR_PROVIDER: "amazon-bedrock", AGENTX_ORCHESTRATOR_MODEL: CHOSEN };
    await expect(createModelRuntimeWithFallback(selected, "worker", { environment })).rejects.toThrow("no fallback model was chosen");
    await expect(createModelRuntimeWithFallback(selected, "orchestrator", { environment })).rejects.toThrow("no fallback model was chosen");
  });

  it("runs on the chosen fallback and says so: the result, the callback's notice and the log line all name the model and the secret", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const notices: ModelFallbackNotice[] = [];
    const resolved = await createModelRuntimeWithFallback(selected, "worker", { environment: { AGENTX_MODEL_FALLBACK: CHOSEN }, onFallback: (notice) => notices.push(notice) });
    expect(resolved.model).toEqual({ provider: "amazon-bedrock", modelId: CHOSEN });
    expect(resolved.runtime.getModel("amazon-bedrock", CHOSEN)).toBeDefined();
    const text = `ran on Amazon Bedrock \`${CHOSEN}\` because the OpenAI key secret is missing`;
    expect(resolved.fallback?.text).toBe(text);
    expect(notices).toEqual([{ role: "worker", reason: "openai_secret_missing", requested: { provider: "openai", modelId: "gpt-5.4" }, effective: { provider: "amazon-bedrock", modelId: CHOSEN }, text }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"model_fallback"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"openai_secret_missing"'));
  });

  it("does not use a fallback for a key that can be read, and still refuses access denied", async () => {
    const notices: ModelFallbackNotice[] = [];
    const environment = { AGENTX_OPENAI_SECRET_ARN: openaiArn, AGENTX_MODEL_FALLBACK: CHOSEN };
    const resolved = await createModelRuntimeWithFallback(selected, "worker", { environment, readSecret: async () => "sk-proj-never-persist-this-key", onFallback: (notice) => notices.push(notice) });
    expect(resolved.model).toEqual(selected);
    expect(resolved.fallback).toBeUndefined();
    expect(notices).toEqual([]);
    await expect(createModelRuntimeWithFallback(selected, "worker", { environment, readSecret: async () => { throw Object.assign(new Error("denied"), { name: "AccessDeniedException" }); } })).rejects.toThrow("OpenAI credential could not be loaded");
  });

  it("refuses a fallback that is not a Bedrock model of the pinned catalog, naming it, rather than running on something unchosen", async () => {
    const create = vi.spyOn(ModelRuntime, "create");
    for (const value of ["us.made-up-model-v1", "gpt-5.4", "has space", "x".repeat(81)]) {
      create.mockClear();
      await expect(createModelRuntimeWithFallback(selected, "worker", { environment: { AGENTX_MODEL_FALLBACK: value } })).rejects.toThrow(/no fallback model was chosen|is not a Bedrock model in this Rovara's model catalog/);
      expect(create).toHaveBeenCalledTimes(1);
    }
    expect(modelFallbackModel("none")).toBeUndefined();
    expect(modelFallbackModel(undefined)).toBeUndefined();
    expect(modelFallbackModel(CHOSEN)).toEqual({ provider: "amazon-bedrock", modelId: CHOSEN });
    expect(modelFallbackModel("us.made-up-model-v1")).toBeUndefined();
  });
});
