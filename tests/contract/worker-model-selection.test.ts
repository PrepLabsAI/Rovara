import { describe, expect, it } from "vitest";
import { resolveTaskModel } from "../../packages/worker/src/task-model.js";

describe("worker task model resolution", () => {
  it("lets Pi choose supported reasoning for an OpenRouter project model", () => {
    expect(resolveTaskModel({ provider: "openrouter", modelId: "qwen/qwen3-coder" }, {})).not.toHaveProperty("thinkingLevel");
  });

  it("uses the broker-resolved model while keeping deployment-owned session settings", () => {
    expect(resolveTaskModel(
      { provider: "amazon-bedrock", modelId: "project-model" },
      { AGENTX_MODEL_PROVIDER: "fallback", AGENTX_MODEL_ID: "fallback-model", PI_CACHE_RETENTION: "long" },
    )).toEqual({ provider: "amazon-bedrock", modelId: "project-model", thinkingLevel: "medium", cacheRetention: "long" });
  });

  it("uses deployment defaults when an older task has no model", () => {
    expect(resolveTaskModel(undefined, { AGENTX_MODEL_PROVIDER: "fallback", AGENTX_MODEL_ID: "fallback-model" }))
      .toMatchObject({ provider: "fallback", modelId: "fallback-model" });
  });
});
