import { MissingProviderSecret, defaultBedrockModel, type ModelRole } from "./config.js";
import { openRouterRouting, readProviderKey, requireKeyedModel } from "./config.js";
export { readOpenRouterKey, readProviderKey, openRouterRouting, openRouterModel, requireKeyedModel } from "./config.js";
// The governed e2e model route (M1.4): its own surface, never reached through the coding-task fallback above.
export * from "./e2e-route.js";
export * from "./e2e-bedrock-invoke.js";
import { CHATGPT_PLAN_LIMIT_ERROR, KEYED_MODEL_PROVIDERS, agentXError, isKeyedModelProvider, type KeyedModelProvider, type ModelIdentifier } from "@agentx/contracts";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type Api, type Model, type SimpleStreamOptions, type TranscriptContext, type AssistantMessage, type AssistantMessageEventStream, type AnthropicMessagesCompat, type OpenAICompletionsCompat, type OpenAIResponsesCompat } from "@earendil-works/pi-ai";
import { streamSimple as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openAIResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  readSecret?: (arn: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  onUsage?: (record: Record<string, unknown>) => void;
  /**
   * Sign in with ChatGPT (#341): the OpenAI credential is the task owner's ChatGPT access token, asked for before every
   * request (it lasts an hour, and a task can run longer) instead of read from the OpenAI secret. OpenAI models only.
   */
  apiKey?: () => Promise<string>;
  /**
   * #342: where a ChatGPT task's requests go once its plan cannot serve them (its limit, a refused connection, a model
   * it no longer allows). The request that found it goes there before Pi sees anything, and so does every later one.
   */
  chatgptFallback?: ChatGptFallback;
}

/** Why a ChatGPT task stopped using its plan (#342). */
export type ChatGptFallbackReason = "limit" | "revoked" | "model";

export interface ChatGptFallback {
  /**
   * Why the task stopped using its plan, set at the first request that fell back. Kept here, not per runtime, so every
   * session of the task (its turn, its reviews) goes straight to the fallback once one request found it.
   */
  reason?: ChatGptFallbackReason;
  /** The same request, on the install's default model. Options carry no ChatGPT key. */
  stream(context: TranscriptContext, options: SimpleStreamOptions | undefined): Promise<AssistantMessageEventStream>;
  /** Told once, at the first request that fell back. */
  onFallback(reason: ChatGptFallbackReason): void;
}

/** A ChatGPT task's plan: its token, and where its requests go once it cannot serve them. */
interface ChatGptPlan { apiKey: () => Promise<string>; fallback?: ChatGptFallback }

/** OpenAI's words for a ChatGPT plan that no longer allows the model (the spike of 2026-10-11). */
const CHATGPT_MODEL_REFUSAL = /not supported when using (?:Codex with )?a ChatGPT account/u;

/** Why OpenAI refused a ChatGPT request, from its status and body, or undefined for a refusal a fallback does not fix. */
function chatGptRefusal(status: number, body: string): ChatGptFallbackReason | undefined {
  if (body.includes(CHATGPT_PLAN_LIMIT_ERROR)) return "limit";
  if (status === 401 || status === 403) return "revoked";
  if ((status === 400 || status === 404) && CHATGPT_MODEL_REFUSAL.test(body)) return "model";
  return undefined;
}

/** Resolve missing-credential fallback before creating a session, so its model and usage agree. */
export async function createModelRuntimeWithFallback<T extends ModelIdentifier>(selected: T, role: ModelRole, options: ModelRuntimeOptions = {}) {
  try {
    return { runtime: await createConfiguredModelRuntime(selected, options), model: selected };
  } catch (error) {
    if (!(error instanceof MissingProviderSecret)) throw error;
    const model = defaultBedrockModel(role, options.environment ?? process.env);
    console.info(JSON.stringify({ event: "model_fallback", role, reason: `${error.provider}_secret_missing`, requested: { provider: selected.provider, modelId: selected.modelId }, effective: model }));
    return { runtime: await createConfiguredModelRuntime(model, options), model };
  }
}

/** How each keyed provider reaches its API through Pi. OpenRouter adds its routing policy. */
const TRANSPORTS = {
  openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
} as const satisfies Record<KeyedModelProvider, { api: Api; baseUrl: string }>;

/**
 * Construct fresh credentials per session so secrets never enter Pi's file-backed auth store. The
 * key goes into an in-memory store, never into ANTHROPIC_API_KEY, OPENAI_API_KEY or any other
 * environment variable, and the stored key wins over those variables if they are set.
 */
export async function createConfiguredModelRuntime(selected: ModelIdentifier & { thinkingLevel?: string }, options: ModelRuntimeOptions = {}): Promise<ModelRuntime> {
  if (!isKeyedModelProvider(selected.provider)) return ModelRuntime.create({ refreshOnCreate: false });
  const provider = selected.provider;
  const { label, secretArnVariable } = KEYED_MODEL_PROVIDERS[provider];
  const environment = options.environment ?? process.env;
  const routing = provider === "openrouter" ? openRouterRouting(environment) : undefined;
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const model = requireKeyedModel(provider, selected.modelId);
  if (!model.reasoning && selected.thinkingLevel && selected.thinkingLevel !== "off") throw agentXError("CONFIG_INVALID", "the selected model does not support reasoning; set thinkingLevel to off");
  if (options.apiKey !== undefined && provider !== "openai") throw agentXError("CONFIG_INVALID", "a ChatGPT plan can run only OpenAI models");
  const key = options.apiKey === undefined ? await readProviderKey(provider, environment[secretArnVariable] ?? "", options.readSecret) : await options.apiKey();
  const { api, baseUrl } = TRANSPORTS[provider];
  const plan: ChatGptPlan | undefined = options.apiKey === undefined ? undefined
    : { apiKey: options.apiKey, ...(options.chatgptFallback === undefined ? {} : { fallback: options.chatgptFallback }) };
  runtime.registerProvider(provider, {
    baseUrl, api,
    models: runtime.getModels(provider).map((entry) => ({ ...entry, api, baseUrl, compat: requestCompat(provider, entry.compat) })),
    streamSimple: (entry, context, streamOptions) => safeProviderStream(provider, entry, context, streamOptions, routing, options.fetch, options.onUsage, plan),
  });
  try { await runtime.setRuntimeApiKey(provider, key); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", `${label} credentials could not be initialized`); }
  return runtime;
}

/**
 * The request each provider gets on Pi 1.0 (spec 050 Ruling 7). Pi records prompt changes as
 * mid-conversation system messages, which a model would receive after the old prompt; without them Pi
 * collapses the transcript into one leading, current prompt, as 0.85.1 sent (a resumed Slack turn
 * changes the orchestrator's cwd every turn). OpenRouter also sends no x-session-id header, as on
 * 0.85.1. Anthropic's catalog lists server-side fallback models for some Claude models; AgentX never
 * lets another model answer for the one requested, so they are dropped (spec 054 FR-003).
 */
function requestCompat(provider: KeyedModelProvider, compat: unknown) {
  if (provider === "openrouter") return { ...(compat as OpenAICompletionsCompat | undefined), sendSessionAffinityHeaders: false, supportsMidConvoSystemMessages: false };
  if (provider === "anthropic") {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the server-side fallbacks
    const { allowedFallbackModels: _fallbacks, ...rest } = (compat ?? {}) as AnthropicMessagesCompat;
    return { ...rest, supportsMidConvoSystemMessages: false };
  }
  return { ...(compat as OpenAIResponsesCompat | undefined), supportsMidConvoSystemMessages: false };
}

function upstreamStream(provider: KeyedModelProvider, model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions, routing: Record<string, unknown> | undefined): AssistantMessageEventStream {
  if (provider === "anthropic") return anthropicMessagesStream(model as Model<"anthropic-messages">, context, options);
  if (provider === "openai") return openAIResponsesStream(model as Model<"openai-responses">, context, options);
  return openAICompletionsStream(model as Model<"openai-completions">, context, {
    ...options, maxRetries: 0,
    onPayload: async (payload, selected) => {
      const transformed = await options.onPayload?.(payload, selected) ?? payload;
      const request = { ...(transformed as Record<string, unknown>), model: model.id, provider: routing };
      // Caller hooks cannot opt into automatic model escalation.
      delete (request as Record<string, unknown>).models;
      delete (request as Record<string, unknown>).route;
      return request;
    },
  });
}

/** The model an SSE event says served the request: OpenRouter and OpenAI chunks, Anthropic's message_start, OpenAI's response events. */
function eventModel(data: { model?: unknown; message?: { model?: unknown }; response?: { model?: unknown } }): unknown {
  return data.model ?? data.message?.model ?? data.response?.model;
}

function safeProviderStream(provider: KeyedModelProvider, model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, routing: Record<string, unknown> | undefined, transport: typeof fetch = fetch, onUsage = (record: Record<string, unknown>) => console.info(JSON.stringify(record)), plan?: ChatGptPlan) {
  const output = createAssistantMessageEventStream();
  const chatgpt = plan !== undefined;
  let failureStatus: number | undefined;
  let refusal: ChatGptFallbackReason | undefined;
  let returnedModel: string | undefined;
  let returnedProvider: string | undefined;
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await transport(input, init);
    if (!response.ok) failureStatus = response.status;
    // A ChatGPT refusal is told apart by its body, which is read here and never kept, logged or shown.
    if (!response.ok && plan?.fallback !== undefined) refusal = chatGptRefusal(response.status, (await response.clone().text().catch(() => "")).slice(0, 65_536));
    if (!response.ok || !response.body) return response;
    // Observe only the serving model and router provider identifiers; never record request/response bodies.
    const decoder = new TextDecoder();
    let pending = "";
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as { provider?: unknown; model?: unknown; message?: { model?: unknown }; response?: { model?: unknown } };
            const served = eventModel(data);
            if (typeof served === "string" && /^[A-Za-z0-9._:/@+=-]{1,256}$/.test(served)) returnedModel = served;
            if (provider === "openrouter" && typeof data.provider === "string" && /^[A-Za-z0-9 ._:/-]{1,128}$/.test(data.provider)) returnedProvider = data.provider;
          } catch { /* Incomplete or non-JSON events are handled by Pi. */ }
        }
        if (pending.length > 1_048_576) pending = "";
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  /** The rest of this request, and every later one, on the fallback; told once, with why. */
  const fallBack = async (fallback: ChatGptFallback, reason: ChatGptFallbackReason) => {
    if (fallback.reason === undefined) {
      fallback.reason = reason;
      try { fallback.onFallback(reason); } catch { /* Reporting must not fail the request it is about. */ }
    }
    const rest = { ...options };
    delete rest.apiKey;
    const replacement = await fallback.stream(context, rest);
    for await (const event of replacement) output.push(event);
    output.end(await replacement.result());
  };
  void (async () => {
    try {
      if (plan?.fallback?.reason !== undefined) return await fallBack(plan.fallback, plan.fallback.reason);
      // A ChatGPT task's token is asked for each time, so a refreshed one replaces an expiring one. A token the
      // control plane will not give (the connection was revoked) sends the request to the fallback.
      let key: { apiKey?: string } = {};
      if (plan !== undefined) {
        try { key = { apiKey: await plan.apiKey() }; }
        catch (error) {
          if (plan.fallback === undefined) throw error;
          return await fallBack(plan.fallback, "revoked");
        }
      }
      // ChatGPT requests are not retried here: a plan's limit does not lift in seconds, and the fallback is ready.
      const upstream = upstreamStream(provider, model, context, { ...options, ...key, ...(plan === undefined ? {} : { maxRetries: 0 }), fetch: observedFetch }, routing);
      let started = false;
      for await (const event of upstream) {
        // Pi's first event comes only once OpenAI accepted the request, so an error first means nothing reached Pi yet.
        if (!started && event.type === "error" && refusal !== undefined && plan?.fallback !== undefined && event.reason !== "aborted") {
          return await fallBack(plan.fallback, refusal);
        }
        started = true;
        if (event.type === "error") event.error.errorMessage = safeError(provider, event.reason === "aborted", failureStatus, chatgpt);
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          // Pi retains the response in the transcript. This record also identifies the serving model
          // and, through OpenRouter, the upstream provider, without treating catalog prices as billed cost.
          const priced = message.usage.cost.total > 0;
          try { onUsage({ event: "model_request_usage", provider, requestedModel: model.id,
            returnedModel: returnedModel ?? null, returnedProvider: returnedProvider ?? null,
            tokens: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite },
            costUsd: priced ? message.usage.cost.total : null,
            costSource: !priced ? "unknown" : provider === "openrouter" ? "estimated" : "list-price", outcome: message.stopReason,
          }); } catch { /* Telemetry must not turn a completed model response into a failed turn. */ }
        }
        output.push(event);
      }
      output.end(await upstream.result());
    } catch {
      const aborted = options?.signal?.aborted === true;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: safeError(provider, aborted, failureStatus, chatgpt),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      output.end(message);
    }
  })();
  return output;
}

/** A diagnostic chosen from the HTTP status alone, so provider error bodies (which can echo prompts) never surface. */
function safeError(provider: KeyedModelProvider, aborted: boolean, status?: number, chatgpt = false): string {
  const { label } = KEYED_MODEL_PROVIDERS[provider];
  if (aborted) return `${label} request cancelled`;
  // A ChatGPT plan has no API key or credit balance: its refusals are the plan's.
  if (chatgpt && (status === 401 || status === 403)) return "ChatGPT request failed; the ChatGPT connection was refused, so connect ChatGPT again";
  if (chatgpt && status === 429) return "ChatGPT request failed; your ChatGPT plan's usage limit may be reached, see https://chatgpt.com/settings/usage";
  if (chatgpt && (status === 400 || status === 404)) return "ChatGPT request failed; your ChatGPT plan may not allow this model";
  const detail = status === 401 || status === 403 ? "check the API key and its permissions"
    : status === 402 ? "check the key's credit balance and spending limit"
    : status === 404 ? (provider === "openrouter" ? "check model availability and the provider allowlist" : "check the model ID and that the key's organization can use it")
    : status === 429 ? (provider === "openrouter" ? "rate limited; wait before retrying" : "rate limited or out of credits; check the key's usage limits before retrying")
    : status === 529 ? "the provider is overloaded; wait before retrying"
    : status !== undefined && status >= 500 ? "upstream unavailable; check provider status before retrying"
    : status === 400 || status === 413 ? "the request was refused; check the model's context and output limits"
    : "check credentials, model availability, rate limits and provider status";
  return `${label} request failed; ${detail}`;
}
