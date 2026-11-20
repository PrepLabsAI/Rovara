import { describe, expect, it } from "vitest";
import { E2E_OWNER_SENTENCES, modelSentenceContext } from "../../packages/broker/src/e2e/owner-sentences.js";

const MODEL_CODES = ["model-limit-reached", "model-key-rejected", "model-not-found", "model-unreachable", "model-request-rejected", "model-provider-outage", "model-secret-unreadable", "model-not-in-catalog", "model-unavailable"] as const;

describe("22. the sentence of each model code, from the approved wording", () => {

  it("cuts a very long model id and a long provider label, so a sentence always fits a row's 300 characters", () => {
    for (const code of MODEL_CODES) {
      const sentence = E2E_OWNER_SENTENCES.agentCode(code, { providerLabel: "Amazon Bedrock", modelId: "x".repeat(200) });
      expect(sentence.length, code).toBeLessThanOrEqual(300);
      if (code !== "model-secret-unreadable") expect(sentence, code).toContain("…");
    }
    // A long provider label is cut too, whatever the sentence.
    for (const code of MODEL_CODES) expect(E2E_OWNER_SENTENCES.agentCode(code, { providerLabel: "P".repeat(300), modelId: "x".repeat(300) }).length, code).toBeLessThanOrEqual(300);
  });

  it("the context comes from a stored route definition: the provider's name and the pinned model, and nothing for a scripted route", () => {
    expect(modelSentenceContext({ provider: "amazon-bedrock", modelId: "us.anthropic.claude-haiku-5-5" })).toEqual({ providerLabel: "Amazon Bedrock", modelId: "us.anthropic.claude-haiku-5-5" });
    expect(modelSentenceContext({ provider: "anthropic", modelId: "claude-haiku-5-5" })?.providerLabel).toBe("Anthropic");
    expect(modelSentenceContext({ provider: "openai", modelId: "gpt-5.4-mini" })?.providerLabel).toBe("OpenAI");
    expect(modelSentenceContext({ provider: "openrouter", modelId: "anthropic/claude-haiku-5.5" })?.providerLabel).toBe("OpenRouter");
    expect(modelSentenceContext({ provider: "rovara-scripted", modelId: "scripted" })).toBeUndefined();
    expect(modelSentenceContext(null)).toBeUndefined();
    expect(modelSentenceContext(undefined)).toBeUndefined();
  });
});

