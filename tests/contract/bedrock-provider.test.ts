import { describe, expect, it } from "vitest";
import { agentCoreBedrockProvider } from "../../packages/worker/src/pi-session.js";

describe("AgentCore Bedrock provider", () => {
  it("uses the execution role without manufacturing or storing an API key", async () => {
    const provider = agentCoreBedrockProvider();
    const apiKey = provider.auth.apiKey;
    expect(apiKey).toBeDefined();
    const input = {
      ctx: {
        env: async () => undefined,
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    };

    await expect(apiKey!.check!(input)).resolves.toEqual({
      type: "api_key",
      source: "AgentCore execution role",
    });
    await expect(apiKey!.resolve(input)).resolves.toEqual({
      auth: {},
      source: "AgentCore execution role",
    });
  });
});
