// Port lane L13: which model a laptop task step calls. The rule is one pure function, shared by the task flow and `rovara up --check`.
import { describe, expect, it } from "vitest";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { PluginConfigSchema } from "@agentx/contracts";
import { DEFAULT_DIRECT_MODELS, DEFAULT_OPENROUTER_WORKER_MODEL } from "@agentx/model-runtime/config";
import { chooseLocalModel, defaultModelOf } from "../../packages/broker/src/local/model-choice.js";
import { localRoute } from "../../packages/broker/src/local/model-proxy/providers.js";
import { E2E_AGENT_ELIGIBLE_MODELS } from "../../packages/contracts/src/e2e-agent-models.generated.js";

describe("the default OpenRouter model", () => {
  it("is a model the installed catalog knows, in OpenRouter's id format", () => {
    expect(openrouterProvider().getModels().map((entry) => entry.id)).toContain(DEFAULT_OPENROUTER_WORKER_MODEL);
    expect(DEFAULT_OPENROUTER_WORKER_MODEL).toMatch(/^anthropic\/claude-/u);
  });
  it("is in the generated model list too", () => {
    expect(E2E_AGENT_ELIGIBLE_MODELS.some((entry) => entry.provider === "openrouter" && entry.modelId === DEFAULT_OPENROUTER_WORKER_MODEL)).toBe(true);
  });
  it("is spoken in the chat shape through the proxy, under the openrouter alias", () => {
    const { route, workerRoute } = localRoute("openrouter", defaultModelOf("openrouter"));
    expect(route).toEqual({ alias: `openrouter/${DEFAULT_OPENROUTER_WORKER_MODEL}`, provider: "openrouter", model: DEFAULT_OPENROUTER_WORKER_MODEL, api: "openai-completions" });
    expect(workerRoute).toEqual({ alias: route.alias, api: "openai-completions", catalog: DEFAULT_OPENROUTER_WORKER_MODEL });
  });
});

describe("chooseLocalModel", () => {
  const setting = { provider: "openrouter", id: "anthropic/claude-sonnet-5.5" } as const;

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

  it("lets the setting win over the key order, when its provider has a key", () => {
    expect(chooseLocalModel(["anthropic", "openai", "openrouter"], setting)).toEqual({ ok: true, provider: "openrouter", model: "anthropic/claude-sonnet-5.5", source: "setting" });
    expect(chooseLocalModel(["openrouter"], setting)).toMatchObject({ ok: true, provider: "openrouter", source: "setting" });
    expect(chooseLocalModel(["anthropic", "openai"], { provider: "openai", id: "gpt-5.4-mini" })).toEqual({ ok: true, provider: "openai", model: "gpt-5.4-mini", source: "setting" });
  });

  it("does not replace a setting whose provider has no key with another provider, and says what to set", () => {
    const result = chooseLocalModel(["anthropic"], setting);
    expect(result).toMatchObject({ ok: false, problem: "setting-without-key" });
    if (!result.ok) {
      expect(result.summary).toContain("openrouter");
      expect(result.fix).toContain("OPENROUTER_API_KEY");
    }
  });

  it("says what to set when there is no key at all", () => {
    const result = chooseLocalModel([]);
    expect(result).toMatchObject({ ok: false, problem: "no-key" });
    if (!result.ok) {
      for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "\"model\""]) expect(result.fix).toContain(name);
    }
  });

  it("ignores a provider the proxy does not serve", () => {
    expect(chooseLocalModel(["github", "amazon-bedrock"])).toMatchObject({ ok: false, problem: "no-key" });
  });
});

describe("the config's model setting", () => {
  const parse = (model: unknown) => PluginConfigSchema.safeParse({ version: 1, plugins: [], model });
  it("takes a provider and a model id", () => {
    expect(parse({ provider: "openrouter", id: "anthropic/claude-sonnet-4.6" }).success).toBe(true);
    expect(parse({ provider: "anthropic", id: "claude-sonnet-4-6" }).success).toBe(true);
    expect(PluginConfigSchema.safeParse({ version: 1, plugins: [] }).success).toBe(true);
  });
  it("refuses another provider, a missing or odd id, and extra fields", () => {
    for (const model of [{ provider: "amazon-bedrock", id: "x" }, { provider: "openrouter" }, { provider: "openrouter", id: "" }, { provider: "openrouter", id: "a b" }, { provider: "openrouter", id: "../x" }, { provider: "openrouter", id: "x", baseUrl: "http://example.invalid" }, "openrouter"]) {
      expect(parse(model).success, JSON.stringify(model)).toBe(false);
    }
  });
});
