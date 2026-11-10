// Port lane L13: which model a task step calls on a laptop. One pure rule, used by the task flow (`createLocalApp`) and by `rovara up --check`, so the check says what the flow will do.
//
//   1. The owner's `model` setting in ~/.rovara/config.json wins. If its provider has no key the answer is "none", with the fix: a setting is the owner's order, so it is never quietly
//      replaced by another provider (the owner may have chosen OpenRouter for a reason).
//   2. Else the first provider with a key, in this order: Anthropic, OpenAI, OpenRouter, each with its default model.
import { DEFAULT_DIRECT_MODELS, DEFAULT_OPENROUTER_WORKER_MODEL } from "@agentx/model-runtime/config";
import type { ProxyProvider } from "./model-proxy/types.js";

/** The order a provider is picked in when the owner names none. */
export const LOCAL_MODEL_PROVIDER_ORDER = ["anthropic", "openai", "openrouter"] as const satisfies readonly ProxyProvider[];

export interface LocalModelChoice {
  provider: ProxyProvider;
  model: string;
}

/** The owner's `model` setting (config.json). */
export interface LocalModelSetting {
  provider: ProxyProvider;
  id: string;
}

export type LocalModelChoiceResult =
  | { ok: true; provider: ProxyProvider; model: string; source: "setting" | "default" }
  | { ok: false; problem: "no-key" | "setting-without-key"; summary: string; fix: string };

const KEY_VARIABLE: Record<ProxyProvider, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" };

export function defaultModelOf(provider: ProxyProvider): string {
  return provider === "openrouter" ? DEFAULT_OPENROUTER_WORKER_MODEL : DEFAULT_DIRECT_MODELS[provider].worker;
}

/** `have`: the providers that have a key on this computer. */
export function chooseLocalModel(have: readonly string[], setting?: LocalModelSetting): LocalModelChoiceResult {
  if (setting !== undefined) {
    if (have.includes(setting.provider)) return { ok: true, provider: setting.provider, model: setting.id, source: "setting" };
    return {
      ok: false, problem: "setting-without-key",
      summary: `The config names ${setting.provider} (${setting.id}) as the model, but no ${setting.provider} key was found.`,
      fix: `Set ${KEY_VARIABLE[setting.provider]} in your environment (or put {"${setting.provider}": "<your key>"} in the keys file), or change or remove the "model" setting in your config.`,
    };
  }
  const provider = LOCAL_MODEL_PROVIDER_ORDER.find((candidate) => have.includes(candidate));
  if (provider === undefined) {
    return {
      ok: false, problem: "no-key", summary: "No model key was found, so no model can be chosen.",
      fix: "Set ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY in your environment, or put the key in the keys file. With several keys, add a \"model\" setting to the config to choose: {\"model\": {\"provider\": \"openrouter\", \"id\": \"anthropic/claude-sonnet-4.6\"}}.",
    };
  }
  return { ok: true, provider, model: defaultModelOf(provider), source: "default" };
}
