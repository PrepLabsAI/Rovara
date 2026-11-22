import { describe, expect, it } from "vitest";
import { routeUsageIdentity } from "../../packages/model-runtime/src/index.js";
import type { InvocationModelRoute } from "@agentx/contracts";

describe("gateway receipt identity", () => {
  it("preserves a connected OpenRouter model exactly even when the catalog lacks it", () => {
    const route: InvocationModelRoute = { alias: "openai/future-model", catalog: "claude-sonnet-5-5", api: "anthropic-messages",
      identity: { provider: "openrouter", sourceId: "company-openrouter", connectionRevision: "r9", modelId: "openai/future-model" } };
    expect(routeUsageIdentity(route)).toEqual({ provider: "openrouter", modelId: "openai/future-model" });
  });
  it("retains the catalog identity for an ordinary legacy route", () => {
    expect(routeUsageIdentity({ alias: "legacy", catalog: "claude-sonnet-5-5", api: "anthropic-messages" })).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
  });
});
