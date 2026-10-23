import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  E2E_AGENT_BEDROCK_QUOTA_CODES, E2E_AGENT_ELIGIBLE_MODELS, E2E_AGENT_RECOMMENDED_MODELS, e2eAgentModelsFor, e2eAgentScopeSentence, eligibleE2EAgentModel,
} from "../../packages/contracts/src/e2e-agent-models.js";
import { MODEL_PROVIDERS } from "../../packages/contracts/src/model-providers.js";
import { catalogEligibilityRows, eligibilityRow, renderEligibleModelsSource } from "../../scripts/generate-e2e-agent-models.js";

// M1.4 Task 4.10A, tests 3 to 5: which models the AI navigation route accepts, and the shape of the request each one gets, come from the pinned pi catalog.

const GENERATED = new URL("../../packages/contracts/src/e2e-agent-models.generated.ts", import.meta.url);

/** A catalog entry as pi lists it, with the fields eligibility reads. */
const entry = (overrides: Record<string, unknown> = {}) => ({
  id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5 (US)", api: "bedrock-converse-stream", type: "chat", input: ["text", "image"],
  cost: { input: 1.1, output: 5.5 }, contextWindow: 200_000, maxTokens: 64_000, reasoning: true, ...overrides,
});

describe("eligibility from the generated table (test 3)", () => {
  it("accepts US and Global Bedrock profiles of Haiku 4.5 and 5.5", () => {
    expect(eligibleE2EAgentModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "us-east-1")).toMatchObject({ modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", scope: "geographic", inputUsdPerMTok: 1.1, outputUsdPerMTok: 5.5 });
    expect(eligibleE2EAgentModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5", "us-east-1")).toMatchObject({ scope: "global" });
    // Global is eligible from any region.
    expect(eligibleE2EAgentModel("amazon-bedrock", "global.anthropic.claude-haiku-5-5", "eu-west-1")).not.toBeNull();
  });

  it("refuses a bare foundation id, a batch id, a router alias, a short context and a model that needs reasoning replayed", () => {
    expect(eligibleE2EAgentModel("amazon-bedrock", "anthropic.claude-haiku-4-5-20251001-v1:0", "us-east-1")).toBeNull();
    expect(eligibleE2EAgentModel("openrouter", "anthropic/claude-haiku-5.5:batch", "us-east-1")).toBeNull();
    expect(eligibleE2EAgentModel("openrouter", "~anthropic/claude-haiku-latest", "us-east-1")).toBeNull();
    expect(eligibleE2EAgentModel("openrouter", "anthropic/claude-haiku-5.5", "us-east-1")).not.toBeNull();
    // The rules themselves, on synthetic catalog entries (the pinned catalog has no 32,000-token model on these four providers that is otherwise eligible).
    expect(eligibilityRow("amazon-bedrock", entry())).not.toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ contextWindow: 32_000 }))).toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ contextWindow: 33_024 }))).not.toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ maxTokens: 1_000 }))).toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ compat: { requiresReasoningContentOnAssistantMessages: true } }))).toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ input: ["image"] }))).toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ type: "embedding" }))).toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ api: "openai-completions" }))).toBeNull();
    expect(eligibilityRow("openrouter", entry({ id: "openrouter/auto", api: "openai-completions" }))).toBeNull();
    // An image-less model is fine: the navigator sends no pixels.
    expect(eligibilityRow("amazon-bedrock", entry({ input: ["text"] }))).not.toBeNull();
  });

  it("makes a geography profile eligible only in its own geography", () => {
    expect(eligibleE2EAgentModel("amazon-bedrock", "eu.anthropic.claude-haiku-5-5", "eu-west-1")).not.toBeNull();
    expect(eligibleE2EAgentModel("amazon-bedrock", "eu.anthropic.claude-haiku-5-5", "us-east-1")).toBeNull();
    expect(eligibleE2EAgentModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5", "eu-west-1")).toBeNull();
    expect(eligibleE2EAgentModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5", "us-west-2")).not.toBeNull();
    expect(eligibleE2EAgentModel("amazon-bedrock", "jp.anthropic.claude-haiku-5-5", "ap-northeast-1")).not.toBeNull();
    expect(eligibleE2EAgentModel("amazon-bedrock", "jp.anthropic.claude-haiku-5-5", "us-east-1")).toBeNull();
    expect(e2eAgentModelsFor("amazon-bedrock", "eu-west-1").every((row) => /^(eu|global)\./.test(row.modelId))).toBe(true);
  });

  it("answers null for an undefined, empty or foreign id and for the wrong provider", () => {
    expect(eligibleE2EAgentModel("amazon-bedrock", undefined, "us-east-1")).toBeNull();
    expect(eligibleE2EAgentModel("amazon-bedrock", "", "us-east-1")).toBeNull();
    expect(eligibleE2EAgentModel("anthropic", "us.anthropic.claude-haiku-5-5", null)).toBeNull();
    expect(eligibleE2EAgentModel("anthropic", "claude-haiku-5-5", null)).not.toBeNull();
  });

  it("holds every recommended model, each eligible, with the effort the route has always had", () => {
    expect(E2E_AGENT_RECOMMENDED_MODELS).toEqual({
      "amazon-bedrock": "us.anthropic.claude-haiku-5-5", anthropic: "claude-haiku-5-5", openai: "gpt-5.4-mini", openrouter: "anthropic/claude-haiku-5.5",
    });
    for (const provider of MODEL_PROVIDERS) {
      const row = eligibleE2EAgentModel(provider, E2E_AGENT_RECOMMENDED_MODELS[provider], "us-east-1");
      expect(row, provider).not.toBeNull();
      expect(row!.effort, provider).toBe(provider === "openai" ? null : "low");
    }
  });

  it("names the Bedrock quota codes of Haiku 5.5, both scopes", () => {
    expect(E2E_AGENT_BEDROCK_QUOTA_CODES["anthropic.claude-haiku-5-5"]).toEqual({ geographic: "L-47520EB7", global: "L-F26CA8D1" });
  });
});

describe("the generated table (test 4)", () => {
  it("equals what the generator makes from the pinned catalog, byte for byte", () => {
    expect(renderEligibleModelsSource(catalogEligibilityRows())).toBe(readFileSync(GENERATED, "utf8"));
  });

  it("goes red when a row is missing (mutation)", () => {
    const rows = catalogEligibilityRows();
    expect(renderEligibleModelsSource(rows.slice(1))).not.toBe(readFileSync(GENERATED, "utf8"));
    expect(E2E_AGENT_ELIGIBLE_MODELS.length).toBe(rows.length);
  });

  it("is sorted and has no duplicate (provider, modelId)", () => {
    const keys = E2E_AGENT_ELIGIBLE_MODELS.map((row) => `${row.provider}\u0000${row.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("the request shape comes from the model's metadata (test 5)", () => {
  it("gives effort low to Haiku 5.5 and null to Haiku 4.5 and gpt-5.4-mini", () => {
    expect(eligibleE2EAgentModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5", "us-east-1")!.effort).toBe("low");
    expect(eligibleE2EAgentModel("amazon-bedrock", "us.anthropic.claude-haiku-4-5-20251001-v1:0", "us-east-1")!.effort).toBeNull();
    expect(eligibleE2EAgentModel("anthropic", "claude-haiku-5-5", null)!.effort).toBe("low");
    expect(eligibleE2EAgentModel("anthropic", "claude-haiku-4-5", null)!.effort).toBeNull();
    expect(eligibleE2EAgentModel("openai", "gpt-5.4-mini", null)!.effort).toBeNull();
  });

  it("reads the rule from the entry: a thinkingLevelMap with a low key on a Claude entry, or a Bedrock Claude entry with any map", () => {
    const claude = { id: "claude-x", name: "X", api: "anthropic-messages", type: "chat", input: ["text"], cost: { input: 1, output: 5 }, contextWindow: 200_000, maxTokens: 64_000 };
    expect(eligibilityRow("anthropic", { ...claude, thinkingLevelMap: { low: "low" } })!.effort).toBe("low");
    expect(eligibilityRow("anthropic", { ...claude, thinkingLevelMap: { xhigh: "xhigh" } })!.effort).toBeNull();
    expect(eligibilityRow("anthropic", claude)!.effort).toBeNull();
    expect(eligibilityRow("amazon-bedrock", entry({ id: "us.anthropic.claude-x", thinkingLevelMap: { xhigh: "xhigh" } }))!.effort).toBe("low");
    expect(eligibilityRow("amazon-bedrock", entry({ id: "us.anthropic.claude-x" }))!.effort).toBeNull();
    // OpenAI's path sets its own reasoning effort, so the route records none.
    expect(eligibilityRow("openai", { ...claude, id: "gpt-x", api: "openai-responses", thinkingLevelMap: { low: "low" } })!.effort).toBeNull();
  });

  it("records the catalog's prices and limits", () => {
    expect(eligibleE2EAgentModel("amazon-bedrock", "us.anthropic.claude-haiku-5-5", "us-east-1")).toMatchObject({ inputUsdPerMTok: 0.11, outputUsdPerMTok: 0.55, contextWindow: 1_000_000, maxTokens: 128_000, label: "Claude Haiku 5.5 (US)" });
  });
});

describe("the scope sentence (test 14, first half)", () => {
  it("says what the owner approved for the US-only and Global profiles, and nothing for anything else", () => {
    expect(e2eAgentScopeSentence("us.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Your app's pages are processed by the AI in US data centers.");
    expect(e2eAgentScopeSentence("global.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Slightly cheaper and less likely to hit limits; your app's pages may be processed by the AI outside the US.");
    expect(e2eAgentScopeSentence("claude-haiku-5-5")).toBeNull();
    expect(e2eAgentScopeSentence("anthropic/claude-haiku-5.5")).toBeNull();
  });
});
