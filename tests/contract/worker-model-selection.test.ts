import { describe, expect, it } from "vitest";
import { resolveTaskModel } from "../../packages/worker/src/task-model.js";

describe("worker task model resolution", () => {
  it("leaves an unset level unset for an OpenRouter project model, so the session default applies (spec 053)", () => {
    expect(resolveTaskModel({ provider: "openrouter", modelId: "qwen/qwen3-coder" }, {})).not.toHaveProperty("thinkingLevel");
  });

  it("returns the selection's level when given, for any provider", () => {
    expect(resolveTaskModel({ provider: "openrouter", modelId: "qwen/qwen3-coder", thinkingLevel: "high" }, {})).toMatchObject({ thinkingLevel: "high" });
    expect(resolveTaskModel({ provider: "amazon-bedrock", modelId: "m", thinkingLevel: "off" }, {})).toMatchObject({ thinkingLevel: "off" });
  });

  it.each([["anthropic", "claude-sonnet-4-6"], ["openai", "gpt-4o"]])("lets the session choose the level from the catalog for a %s model", (provider, modelId) => {
    expect(resolveTaskModel({ provider, modelId }, {})).not.toHaveProperty("thinkingLevel");
    expect(resolveTaskModel(undefined, { AGENTX_MODEL_PROVIDER: provider, AGENTX_MODEL_ID: modelId })).not.toHaveProperty("thinkingLevel");
  });

  it("uses the broker-resolved model while keeping deployment-owned session settings", () => {
    expect(resolveTaskModel(
      { provider: "amazon-bedrock", modelId: "project-model" },
      { AGENTX_MODEL_PROVIDER: "fallback", AGENTX_MODEL_ID: "fallback-model", PI_CACHE_RETENTION: "long" },
    )).toEqual({ provider: "amazon-bedrock", modelId: "project-model", cacheRetention: "long" });
  });

  it("uses deployment defaults when an older task has no model", () => {
    expect(resolveTaskModel(undefined, { AGENTX_MODEL_PROVIDER: "fallback", AGENTX_MODEL_ID: "fallback-model" }))
      .toMatchObject({ provider: "fallback", modelId: "fallback-model" });
  });
});
