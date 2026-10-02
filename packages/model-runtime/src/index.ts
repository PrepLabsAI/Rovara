import { MissingOpenRouterSecret, defaultBedrockModel, type ModelRole } from "./config.js";
import { readOpenRouterKey, openRouterRouting, openRouterModel } from "./config.js";
export { readOpenRouterKey, openRouterRouting, openRouterModel } from "./config.js";
import { agentXError, type ModelIdentifier } from "@agentx/contracts";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type Model, type SimpleStreamOptions, type Context, type AssistantMessage } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelRuntimeOptions {
  environment?: NodeJS.ProcessEnv;
  readSecret?: (arn: string) => Promise<string | undefined>;
  fetch?: typeof fetch;
  onUsage?: (record: Record<string, unknown>) => void;
}

/** Resolve missing-credential fallback before creating a session, so its model and usage agree. */
export async function createModelRuntimeWithFallback<T extends ModelIdentifier>(selected: T, role: ModelRole, options: ModelRuntimeOptions = {}) {
  try {
    return { runtime: await createConfiguredModelRuntime(selected, options), model: selected };
  } catch (error) {
    if (!(error instanceof MissingOpenRouterSecret)) throw error;
    const model = defaultBedrockModel(role, options.environment ?? process.env);
    console.info(JSON.stringify({ event: "model_fallback", role, reason: "openrouter_secret_missing", requested: { provider: selected.provider, modelId: selected.modelId }, effective: model }));
    return { runtime: await createConfiguredModelRuntime(model, options), model };
  }
}

/** Construct fresh credentials per session so secrets never enter Pi's file-backed auth store. */
export async function createConfiguredModelRuntime(selected: ModelIdentifier & { thinkingLevel?: string }, options: ModelRuntimeOptions = {}): Promise<ModelRuntime> {
  if (selected.provider !== "openrouter") return ModelRuntime.create({ refreshOnCreate: false });
  const environment = options.environment ?? process.env;
  const routing = openRouterRouting(environment);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const model = openRouterModel(selected.modelId);
  if (!model.reasoning && selected.thinkingLevel && selected.thinkingLevel !== "off") throw agentXError("CONFIG_INVALID", "the selected model does not support reasoning; set thinkingLevel to off");
  const key = await readOpenRouterKey(environment.AGENTX_OPENROUTER_SECRET_ARN ?? "", options.readSecret);
  runtime.registerProvider("openrouter", {
    baseUrl: "https://openrouter.ai/api/v1", api: "openai-completions",
    models: runtime.getModels("openrouter").map((entry) => ({ ...entry, api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" })),
    streamSimple: (entry, context, streamOptions) => safeOpenRouterStream(entry as Model<"openai-completions">, context, streamOptions, routing, options.fetch, options.onUsage),
  });
  try { await runtime.setRuntimeApiKey("openrouter", key); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "OpenRouter credentials could not be initialized"); }
  return runtime;
}

function safeOpenRouterStream(model: Model<"openai-completions">, context: Context, options: SimpleStreamOptions | undefined, routing: Record<string, unknown>, transport: typeof fetch = fetch, onUsage = (record: Record<string, unknown>) => console.info(JSON.stringify(record))) {
  const output = createAssistantMessageEventStream();
  let failureStatus: number | undefined;
  let returnedModel: string | undefined;
  let returnedProvider: string | undefined;
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await transport(input, init);
    if (!response.ok) failureStatus = response.status;
    if (!response.ok || !response.body) return response;
    // Observe only the router's provider identifier; never record request/response bodies.
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
            const data = JSON.parse(line.slice(6)) as { provider?: unknown; model?: unknown };
            if (typeof data.model === "string" && /^[A-Za-z0-9._:/@+=-]{1,256}$/.test(data.model)) returnedModel = data.model;
            if (typeof data.provider === "string" && /^[A-Za-z0-9 ._:/-]{1,128}$/.test(data.provider)) returnedProvider = data.provider;
          } catch { /* Incomplete or non-JSON events are handled by Pi. */ }
        }
        if (pending.length > 1_048_576) pending = "";
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  void (async () => {
    try {
      const upstream = streamSimple(model, context, {
        ...options, fetch: observedFetch, maxRetries: 0,
        onPayload: async (payload, selected) => {
          const transformed = await options?.onPayload?.(payload, selected) ?? payload;
          const request = { ...(transformed as Record<string, unknown>), model: model.id, provider: routing };
          // Caller hooks cannot opt into automatic model escalation.
          delete (request as Record<string, unknown>).models;
          delete (request as Record<string, unknown>).route;
          return request;
        },
      });
      for await (const event of upstream) {
        if (event.type === "error") event.error.errorMessage = safeError(event.reason === "aborted", failureStatus);
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          // Pi retains responseModel in the transcript. This record also identifies the upstream
          // provider, when the router supplied one, without treating catalog prices as billed cost.
          try { onUsage({ event: "model_request_usage", provider: "openrouter", requestedModel: model.id,
            returnedModel: returnedModel ?? null, returnedProvider: returnedProvider ?? null,
            tokens: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite },
            costUsd: message.usage.cost.total > 0 ? message.usage.cost.total : null,
            costSource: message.usage.cost.total > 0 ? "estimated" : "unknown", outcome: message.stopReason,
          }); } catch { /* Telemetry must not turn a completed model response into a failed turn. */ }
        }
        output.push(event);
      }
      output.end(await upstream.result());
    } catch {
      const aborted = options?.signal?.aborted === true;
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "openrouter", model: model.id,
        content: [], timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: safeError(aborted, failureStatus),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      output.end(message);
    }
  })();
  return output;
}

function safeError(aborted: boolean, status?: number): string {
  if (aborted) return "OpenRouter request cancelled";
  const detail = status === 401 || status === 403 ? "check the API key and its permissions"
    : status === 402 ? "check the key's credit balance and spending limit"
    : status === 404 ? "check model availability and the provider allowlist"
    : status === 429 ? "rate limited; wait before retrying"
    : status !== undefined && status >= 500 ? "upstream unavailable; check provider status before retrying"
    : "check credentials, model availability, rate limits and provider status";
  return `OpenRouter request failed; ${detail}`;
}
