// Spec 053 FR-003 (Ruling 5): an approved thinking level the model does not support is refused,
// checked against the same Pi catalogs the runtime uses, instead of being clamped by Pi.
import { describe, expect, it } from "vitest";
import { thinkingLevelRefusal, thinkingLevelSupport, unsupportedThinkingLevels } from "../../packages/model-runtime/src/thinking-levels.js";

const glm = { provider: "openrouter", modelId: "z-ai/glm-5.3" };
const sonnet = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const llama = { provider: "amazon-bedrock", modelId: "meta.llama3-3-70b-instruct-v1:0" };

describe("thinkingLevelSupport", () => {

  it("accepts a model the catalog does not know, leaving the check to first use", () => {
    expect(thinkingLevelSupport({ provider: "openrouter", modelId: "example/not-in-catalog" }, "medium")).toEqual({ ok: true });
    expect(thinkingLevelSupport({ provider: "amazon-bedrock", modelId: "example.not-in-catalog-v1:0" }, "xhigh")).toEqual({ ok: true });
    expect(thinkingLevelSupport({ provider: "some-other-provider", modelId: "z-ai/glm-5.3" }, "medium")).toEqual({ ok: true });
  });
});

describe("unsupportedThinkingLevels", () => {
  it("names each approved model whose level is unsupported, by label and ID", () => {
    expect(unsupportedThinkingLevels({
      default: { ...sonnet, thinkingLevel: "medium" },
      approved: [
        { ...sonnet, thinkingLevel: "medium", label: "Sonnet" },
        { ...glm, thinkingLevel: "medium", label: "GLM 5.3" },
        { ...llama, thinkingLevel: "low" },
      ],
    })).toEqual([
      'GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high',
      'meta.llama3-3-70b-instruct-v1:0 does not support thinking level "low"; supported: off',
    ]);
  });

  it("says so when the model supports no level AgentX can set", () => {
    expect(thinkingLevelRefusal("Max only (example/max-only)", "high", [])).toBe(
      'Max only (example/max-only) does not support thinking level "high"; it supports no thinking level AgentX can set',
    );
    expect(thinkingLevelRefusal("GLM 5.3 (z-ai/glm-5.3)", "medium", ["low", "high"])).toBe(
      'GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high',
    );
  });

  it("leaves unset levels alone and passes supported ones", () => {
    expect(unsupportedThinkingLevels({ default: glm, approved: [glm, { ...sonnet, thinkingLevel: "high" }] })).toEqual([]);
  });
});
