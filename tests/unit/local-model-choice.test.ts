// Port lane L13: which model a laptop task step calls. The rule is one pure function, shared by the task flow and `rovara up --check`.
import { describe, expect, it } from "vitest";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { PluginConfigSchema } from "@agentx/contracts";
import { DEFAULT_DIRECT_MODELS, DEFAULT_OPENROUTER_WORKER_MODEL } from "@agentx/model-runtime/config";
import type { ModelProviderAdapter } from "@agentx/contracts";
import { chooseLocalModel, defaultModelOf } from "../../packages/broker/src/local/model-choice.js";
import { readyProviders, type ModelProviderBook } from "../../packages/broker/src/local/model-proxy/index.js";
import { BUILTIN_MODEL_PROVIDERS, NATIVE_CHAT_CAPABILITIES, bedrockModelProvider } from "../../packages/broker/src/plugins/model-provider/index.js";
import { E2E_AGENT_ELIGIBLE_MODELS } from "../../packages/contracts/src/e2e-agent-models.generated.js";

describe("the default OpenRouter model", () => {
  it("is a model the installed catalog knows, in OpenRouter's id format", () => {
    expect(openrouterProvider().getModels().map((entry) => entry.id)).toContain(DEFAULT_OPENROUTER_WORKER_MODEL);
    expect(DEFAULT_OPENROUTER_WORKER_MODEL).toMatch(/^anthropic\/claude-/u);
  });
  it("is in the generated model list too", () => {
    expect(E2E_AGENT_ELIGIBLE_MODELS.some((entry) => entry.provider === "openrouter" && entry.modelId === DEFAULT_OPENROUTER_WORKER_MODEL)).toBe(true);
  });
});

describe("chooseLocalModel", () => {

  it.each([
    [["anthropic"], "anthropic", DEFAULT_DIRECT_MODELS.anthropic.worker],
    [["openai"], "openai", DEFAULT_DIRECT_MODELS.openai.worker],
    [["openrouter"], "openrouter", DEFAULT_OPENROUTER_WORKER_MODEL],
    [["anthropic", "openai"], "anthropic", DEFAULT_DIRECT_MODELS.anthropic.worker],
    [["anthropic", "openrouter"], "anthropic", DEFAULT_DIRECT_MODELS.anthropic.worker],
    [["openai", "openrouter"], "openai", DEFAULT_DIRECT_MODELS.openai.worker],
    [["openrouter", "openai", "anthropic"], "anthropic", DEFAULT_DIRECT_MODELS.anthropic.worker],
  ])("with keys %j and no setting picks %s", (have, provider, model) => {
    expect(chooseLocalModel(have)).toEqual({ ok: true, provider, model, source: "default" });
  });
});

describe("the config's model setting", () => {
  const parse = (model: unknown) => PluginConfigSchema.safeParse({ version: 1, plugins: [], model });
  it("takes a provider and a model id", () => {
    expect(parse({ provider: "openrouter", id: "anthropic/claude-sonnet-4.6" }).success).toBe(true);
    expect(parse({ provider: "anthropic", id: "claude-sonnet-4-6" }).success).toBe(true);
    expect(PluginConfigSchema.safeParse({ version: 1, plugins: [] }).success).toBe(true);
  });
  it("takes any provider id (item K2: providers are plug-ins) and a request format, and refuses a bad id or format", () => {
    expect(parse({ provider: "amazon-bedrock", id: "anthropic.claude-test-v1:0" }).success).toBe(true);
    expect(parse({ provider: "amazon-bedrock", api: "openai-completions", id: "vendor.open-model" }).success).toBe(true);
    expect(parse({ provider: "vertex", api: "anthropic-messages", id: "claude-test@20250101" }).success).toBe(true);
    for (const model of [{ provider: "Bad Name", id: "x" }, { provider: "-x", id: "x" }, { provider: "x", api: "gemini-native", id: "x" }]) expect(parse(model).success, JSON.stringify(model)).toBe(false);
  });
  it("refuses a missing or odd id and extra fields", () => {
    for (const model of [{ provider: "openrouter" }, { provider: "openrouter", id: "" }, { provider: "openrouter", id: "a b" }, { provider: "openrouter", id: "../x" }, { provider: "openrouter", id: "x", baseUrl: "http://example.invalid" }, "openrouter"]) {
      expect(parse(model).success, JSON.stringify(model)).toBe(false);
    }
  });
});

describe("chooseLocalModel with model-provider plug-ins (item K2)", () => {
  const gateway: ModelProviderAdapter = {
    kind: "company-gateway", name: "Company gateway", address: "https://models.example.test/v1", signIn: { kind: "bearer-key" }, defaultModel: "house-model",
    formats: [{ format: "openai-completions", pathOverride: "/chat/completions", capabilities: NATIVE_CHAT_CAPABILITIES }],
  };
  const local: ModelProviderAdapter = { ...gateway, kind: "local-llm", name: "Local model", address: "http://127.0.0.1:11434", signIn: { kind: "none" } };
  const bedrock = bedrockModelProvider({ region: "us-west-2", credentials: async () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-never-real" }) });
  const book = (...rows: ModelProviderAdapter[]): ModelProviderBook => {
    const all = [...BUILTIN_MODEL_PROVIDERS, ...rows];
    return { get: (id) => all.find((row) => row.kind === id), ids: () => all.map((row) => row.kind) };
  };

  it("carries the request format the owner named", () => {
    expect(chooseLocalModel(["amazon-bedrock"], { provider: "amazon-bedrock", id: "vendor.open", api: "openai-completions" }, book(bedrock))).toEqual({ ok: true, provider: "amazon-bedrock", model: "vendor.open", api: "openai-completions", source: "setting" });
    const refused = chooseLocalModel(["company-gateway"], { provider: "company-gateway", id: "x", api: "anthropic-messages" }, book(gateway));
    expect(refused).toMatchObject({ ok: false, problem: "setting-format" });
  });

  it("names a provider that is not installed, and tells how to add it", () => {
    const result = chooseLocalModel(["anthropic"], { provider: "nowhere", id: "x" });
    expect(result).toMatchObject({ ok: false, problem: "setting-unknown-provider" });
    if (!result.ok) expect(result.fix).toContain("model-provider");
  });

  it("says a role is the thing to fix for a provider that signs in with one, and a key for the others", () => {
    const role = chooseLocalModel([], { provider: "amazon-bedrock", id: "x" }, book(bedrock));
    expect(role).toMatchObject({ ok: false, problem: "setting-without-key" });
    if (!role.ok) { expect(role.summary).toContain("sign-in"); expect(role.fix).toContain("AWS"); }
    const key = chooseLocalModel([], { provider: "company-gateway", id: "x" }, book(gateway));
    if (!key.ok) expect(key.fix).toContain("ROVARA_MODEL_COMPANY_GATEWAY_API_KEY");
  });

  it("counts a provider that needs no key, or brings its own role, as ready without an entry in the key file", async () => {
    const keys = { async get() { return undefined; }, async providers() { return ["company-gateway"]; } };
    expect(await readyProviders(book(gateway, local, bedrock), keys, "org_00000000000000000000")).toEqual(["company-gateway", "local-llm", "amazon-bedrock"]);
    const noRole = bedrockModelProvider({ region: "us-west-2", credentials: async () => { throw new Error("no role"); } });
    expect(await readyProviders(book(noRole), { async get() { return undefined; }, async providers() { return []; } }, "org_00000000000000000000")).toEqual([]);
  });

  it("needs a default model from a plug-in provider that has none", () => {
    expect(() => defaultModelOf("company-gateway", book({ ...gateway, defaultModel: undefined } as unknown as ModelProviderAdapter))).toThrow(/default model/u);
  });
});
