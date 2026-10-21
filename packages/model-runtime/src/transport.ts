import type { Api, AnthropicMessagesCompat, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import type { KeyedModelProvider } from "@agentx/contracts";

// Shared by the coding runtime (index.ts) and the governed e2e route (e2e-provider-invoke.ts), so both reach a keyed
// provider the same way. Neither imports the other.

/** How each keyed provider reaches its API through Pi. OpenRouter adds its routing policy. */
export const TRANSPORTS = {
  openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
} as const satisfies Record<KeyedModelProvider, { api: Api; baseUrl: string }>;

/**
 * The request each provider gets on Pi 1.0 (spec 050 Ruling 7). Pi records prompt changes as
 * mid-conversation system messages, which a model would receive after the old prompt; without them Pi
 * collapses the transcript into one leading, current prompt, as 0.85.1 sent (a resumed Slack turn
 * changes the orchestrator's cwd every turn). OpenRouter also sends no x-session-id header, as on
 * 0.85.1. Anthropic's catalog lists server-side fallback models for some Claude models; AgentX never
 * lets another model answer for the one requested, so they are dropped (spec 054 FR-003).
 */
export function requestCompat(provider: KeyedModelProvider, compat: unknown) {
  if (provider === "openrouter") return { ...(compat as OpenAICompletionsCompat | undefined), sendSessionAffinityHeaders: false, supportsMidConvoSystemMessages: false };
  if (provider === "anthropic") {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the server-side fallbacks
    const { allowedFallbackModels: _fallbacks, ...rest } = (compat ?? {}) as AnthropicMessagesCompat;
    return { ...rest, supportsMidConvoSystemMessages: false };
  }
  return { ...(compat as OpenAIResponsesCompat | undefined), supportsMidConvoSystemMessages: false };
}

