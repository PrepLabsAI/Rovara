// Spec 053 FR-003 (Ruling 5): an approved thinking level the model does not support is refused,
// checked against the same Pi catalogs the runtime uses, instead of being clamped by Pi.
import { describe, expect, it } from "vitest";
import { thinkingLevelRefusal, thinkingLevelSupport, unsupportedThinkingLevels } from "../../packages/model-runtime/src/thinking-levels.js";

const glm = { provider: "openrouter", modelId: "z-ai/glm-5.3" };
const sonnet = { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-6" };
const novaLite = { provider: "amazon-bedrock", modelId: "amazon.nova-lite-v1:0" };

describe("thinkingLevelSupport", () => {
  it("refuses medium on GLM 5.3 and lists the levels the catalog supports", () => {
    expect(thinkingLevelSupport(glm, "medium")).toEqual({ ok: false, supported: ["low", "high"] });
  });

  it("refuses off on GLM 5.3, which always reasons", () => {
    expect(thinkingLevelSupport(glm, "off")).toEqual({ ok: false, supported: ["low", "high"] });
  });

  it("accepts high on GLM 5.3", () => {
    expect(thinkingLevelSupport(glm, "high")).toEqual({ ok: true });
  });

  it("accepts medium on Bedrock Sonnet 4.6, and refuses xhigh, proving the catalog knows the model", () => {
    expect(thinkingLevelSupport(sonnet, "medium")).toEqual({ ok: true });
    // Pi's catalog gives Sonnet 4.6 no xhigh; a model the catalog did not know would pass.
    expect(thinkingLevelSupport(sonnet, "xhigh")).toEqual({ ok: false, supported: ["off", "minimal", "low", "medium", "high"] });
  });

  it("lists only levels AgentX can set: Pi's own \"max\" is left out (FR-003)", () => {
    for (const support of [thinkingLevelSupport(glm, "medium"), thinkingLevelSupport(sonnet, "xhigh")]) {
      expect(support.ok).toBe(false);
      expect(support.ok ? [] : support.supported).not.toContain("max");
    }
  });

  it("refuses a reasoning level on a non-reasoning model, which supports only off", () => {
    expect(thinkingLevelSupport(novaLite, "high")).toEqual({ ok: false, supported: ["off"] });
    expect(thinkingLevelSupport(novaLite, "off")).toEqual({ ok: true });
  });

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
        { ...novaLite, thinkingLevel: "low" },
      ],
    })).toEqual([
      'GLM 5.3 (z-ai/glm-5.3) does not support thinking level "medium"; supported: low, high',
      'amazon.nova-lite-v1:0 does not support thinking level "low"; supported: off',
    ]);
  });

  it("checks the default's level too, once when it repeats an approved entry's problem", () => {
    expect(unsupportedThinkingLevels({
      default: { ...glm, thinkingLevel: "off" },
      approved: [{ ...glm, thinkingLevel: "off", label: "GLM 5.3" }],
    })).toEqual(['GLM 5.3 (z-ai/glm-5.3) does not support thinking level "off"; supported: low, high']);
    expect(unsupportedThinkingLevels({
      default: { ...glm, thinkingLevel: "medium" },
      approved: [{ ...glm, thinkingLevel: "high" }],
    })).toEqual(['z-ai/glm-5.3 does not support thinking level "medium"; supported: low, high']);
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
