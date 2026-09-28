import { describe, expect, it } from "vitest";
import { executionRoleBedrockProvider } from "../../packages/worker/src/pi-session.js";

describe("worker execution-role Bedrock provider", () => {
  it("uses the execution role without manufacturing or storing an API key", async () => {
    const provider = executionRoleBedrockProvider();
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
      source: "worker execution role",
    });
    await expect(apiKey!.resolve(input)).resolves.toEqual({
      auth: {},
      source: "worker execution role",
    });
  });
});
