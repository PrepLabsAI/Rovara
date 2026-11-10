// Port lane L13: which model a task step calls on a laptop. One pure rule, used by the task flow (`createLocalApp`) and by `rovara up --check`, so the check says what the flow will do.
//
//   1. The owner's `model` setting in ~/.rovara/config.json wins. If its provider has no key the answer is "none", with the fix: a setting is the owner's order, so it is never quietly
//      replaced by another provider (the owner may have chosen OpenRouter for a reason).
//   2. Else the first provider with a key, in this order: Anthropic, OpenAI, OpenRouter, each with its default model.
// A provider is any registered `model-provider` plug-in (item K2). A plug-in provider is chosen by the owner's setting only: the default order stays the three built-ins, so adding a plug-in
// never changes which provider an existing install uses.
import { DEFAULT_DIRECT_MODELS, DEFAULT_OPENROUTER_WORKER_MODEL } from "@agentx/model-runtime/config";
import { providerFormat } from "@agentx/contracts";
import { modelKeyVariable } from "../ports/model-key-stores.js";
import { credentialFix } from "./model-proxy/credentials.js";
import { builtinModelProviderBook } from "./model-proxy/proxy.js";
import type { ModelProviderBook, ProxyApi, ProxyProvider } from "./model-proxy/types.js";

/** The order a provider is picked in when the owner names none. */
export const LOCAL_MODEL_PROVIDER_ORDER = ["anthropic", "openai", "openrouter"] as const satisfies readonly ProxyProvider[];

export interface LocalModelChoice {
  provider: ProxyProvider;
  model: string;
  /** The request format, when it is not the provider's first. */
  api?: ProxyApi | undefined;
}

/** The owner's `model` setting (config.json). */
export interface LocalModelSetting {
  provider: ProxyProvider;
  id: string;
  api?: ProxyApi | undefined;
}

export type LocalModelChoiceResult =
  | { ok: true; provider: ProxyProvider; model: string; api?: ProxyApi | undefined; source: "setting" | "default" }
  | { ok: false; problem: "no-key" | "setting-without-key" | "setting-unknown-provider" | "setting-format"; summary: string; fix: string };

export function defaultModelOf(provider: ProxyProvider, book: ModelProviderBook = builtinModelProviderBook()): string {
  if (provider === "openrouter") return DEFAULT_OPENROUTER_WORKER_MODEL;
  if (provider === "anthropic" || provider === "openai") return DEFAULT_DIRECT_MODELS[provider].worker;
  const model = book.get(provider)?.defaultModel;
  if (model === undefined) throw new Error(`model provider ${provider.slice(0, 40)} has no default model; name one in the "model" setting`);
  return model;
}

/**
 * `have`: the providers that can be signed in to on this computer (a key, a role, or none needed; `readyProviders` in model-proxy/credentials.ts). `book`: the registered providers
 * (absent: the three built-ins).
 */
export function chooseLocalModel(have: readonly string[], setting?: LocalModelSetting, book: ModelProviderBook = builtinModelProviderBook()): LocalModelChoiceResult {
  if (setting !== undefined) {
    const row = book.get(setting.provider);
    if (row === undefined) {
      return {
        ok: false, problem: "setting-unknown-provider",
        summary: `The config names ${setting.provider} (${setting.id}) as the model, but no model provider called ${setting.provider} is installed.`,
        fix: `Add a "model-provider" plug-in named ${setting.provider} to your config, or change or remove the "model" setting (the built-in providers are ${book.ids().join(", ")}).`,
      };
    }
    if (setting.api !== undefined && providerFormat(row, setting.api) === undefined) {
      return {
        ok: false, problem: "setting-format",
        summary: `The config asks for ${row.name} to be called as ${setting.api}, which it does not speak.`,
        fix: `Use one of ${row.formats.map((entry) => entry.format).join(", ")} as the "api" of the "model" setting, or remove it.`,
      };
    }
    if (have.includes(setting.provider)) return { ok: true, provider: setting.provider, model: setting.id, ...(setting.api === undefined ? {} : { api: setting.api }), source: "setting" };
    return {
      ok: false, problem: "setting-without-key",
      summary: `The config names ${setting.provider} (${setting.id}) as the model, but no ${setting.provider} ${row.signIn.kind === "bearer-key" || row.signIn.kind === "named-header" ? "key" : "sign-in"} was found.`,
      fix: `${row.signIn.kind === "bearer-key" || row.signIn.kind === "named-header" ? `Set ${modelKeyVariable(row.kind)} in your environment (or put {"${row.kind}": "<your key>"} in the keys file)` : `Fix the sign-in: ${credentialFix(row)}`}, or change or remove the "model" setting in your config.`,
    };
  }
  const provider = LOCAL_MODEL_PROVIDER_ORDER.find((candidate) => have.includes(candidate) && book.get(candidate) !== undefined);
  if (provider === undefined) {
    return {
      ok: false, problem: "no-key", summary: "No model key was found, so no model can be chosen.",
      fix: "Set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY in your environment, or put the key in the keys file. With several keys, add a \"model\" setting to the config to choose: {\"model\": {\"provider\": \"openrouter\", \"id\": \"anthropic/claude-sonnet-4.6\"}}.",
    };
  }
  return { ok: true, provider, model: defaultModelOf(provider, book), source: "default" };
}
