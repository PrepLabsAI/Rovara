import { MODEL_PROVIDERS } from "../../packages/contracts/src/model-providers.js";
import { describe, expect, it } from "vitest";
import { catalogModel } from "../../packages/model-runtime/src/catalog.js";
import { DEFAULT_E2E_AGENT_MODELS, requireKeyedModel } from "../../packages/model-runtime/src/config.js";
import {
  E2E_REDIRECTING_ENVIRONMENT_VARIABLES,
  assertE2EEnvironmentCannotRedirect,
  e2eRedirectingEnvironment,
} from "../../packages/model-runtime/src/e2e-environment-guard.js";

describe("the e2e agent's default model per provider (amendment A1, Ruling M4-S)", () => {
  it("has one pinned small model for every provider the installation can configure", () => {
    expect(Object.keys(DEFAULT_E2E_AGENT_MODELS).sort()).toEqual([...MODEL_PROVIDERS].sort());
    expect(DEFAULT_E2E_AGENT_MODELS).toEqual({
      "amazon-bedrock": "us.anthropic.claude-haiku-5-5",
      anthropic: "claude-haiku-5-5",
      openrouter: "anthropic/claude-haiku-5.5",
      openai: "gpt-5.4-mini",
    });
  });

  it("is in the catalog of the pinned pi version for every provider, so a pi change that drops one fails here", () => {
    for (const provider of MODEL_PROVIDERS) {
      const modelId = DEFAULT_E2E_AGENT_MODELS[provider];
      const entry = catalogModel({ provider, modelId });
      expect(entry, `${provider} ${modelId}`).toBeDefined();
      expect(entry!.contextWindow, `${provider} context`).toBeGreaterThan(0);
      expect(entry!.maxTokens, `${provider} max tokens`).toBeGreaterThan(0);
    }
    // Bedrock's inference profile is the foundation model with a geography prefix; both ids are in the catalog.
    expect(catalogModel({ provider: "amazon-bedrock", modelId: "anthropic.claude-haiku-5-5" })).toBeDefined();
  });

  it("refuses a router alias on OpenRouter, whether it starts with openrouter/ or ~", () => {
    expect(() => requireKeyedModel("openrouter", "openrouter/auto")).toThrow(/router/);
    expect(() => requireKeyedModel("openrouter", "~anthropic/claude-haiku-latest")).toThrow(/router|alias/);
    expect(requireKeyedModel("openrouter", DEFAULT_E2E_AGENT_MODELS.openrouter).id).toBe("anthropic/claude-haiku-5.5");
  });
});

describe("the environment guard: a worker whose environment can redirect model calls does not start", () => {
  const variables = [
    "AWS_BEARER_TOKEN_BEDROCK", "AWS_BEDROCK_SKIP_AUTH", "AWS_BEDROCK_FORCE_HTTP1", "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AWS_ENDPOINT_URL", "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY",
    "NODE_TLS_REJECT_UNAUTHORIZED", "NODE_EXTRA_CA_CERTS", "PI_CACHE_RETENTION",
  ];

  it("lists the variables of the ruling", () => {
    for (const name of variables) expect(E2E_REDIRECTING_ENVIRONMENT_VARIABLES.map((item) => item.toLowerCase()), name).toContain(name.toLowerCase());
  });

  for (const name of variables) {
    it(`refuses to start when ${name} is set`, () => {
      expect(e2eRedirectingEnvironment({ [name]: "x" })).toEqual([name]);
      expect(() => assertE2EEnvironmentCannotRedirect({ [name]: "x" })).toThrowError(/environment can redirect model calls/);
      try { assertE2EEnvironmentCannotRedirect({ [name]: "secret-value-123" }); } catch (error) {
        expect(String(error)).toContain(name);
        expect(String(error)).not.toContain("secret-value-123");
        expect(error).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      }
    });
  }

  it("accepts a clean environment, an empty value, and AWS_MAX_ATTEMPTS=1, and refuses any other AWS_MAX_ATTEMPTS", () => {
    expect(e2eRedirectingEnvironment({})).toEqual([]);
    expect(e2eRedirectingEnvironment({ HTTPS_PROXY: "", AWS_PROFILE: "" })).toEqual([]);
    expect(e2eRedirectingEnvironment({ PATH: "/usr/bin", HOME: "/home/agentx", AWS_REGION: "us-east-1", AGENTX_MODEL_PROVIDER: "amazon-bedrock" })).toEqual([]);
    expect(e2eRedirectingEnvironment({ AWS_MAX_ATTEMPTS: "1" })).toEqual([]);
    for (const value of ["3", "2", "0", "10", "abc"]) expect(e2eRedirectingEnvironment({ AWS_MAX_ATTEMPTS: value }), value).toEqual(["AWS_MAX_ATTEMPTS"]);
  });

  it("names every variable found, once, in a stable order", () => {
    expect(e2eRedirectingEnvironment({ HTTPS_PROXY: "a", AWS_PROFILE: "b", https_proxy: "c" })).toEqual(["AWS_PROFILE", "HTTPS_PROXY", "https_proxy"]);
  });
});
