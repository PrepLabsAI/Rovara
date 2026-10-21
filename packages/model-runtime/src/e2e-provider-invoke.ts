import { createHash } from "node:crypto";
import { agentXError, isKeyedModelProvider, type KeyedModelProvider } from "@agentx/contracts";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openAIResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { catalogModel } from "./catalog.js";
import { readProviderKey, requireKeyedModel } from "./config.js";
import type { E2EInvoke, E2EInvokeInput, E2EInvokeOutput, E2EModelChannelCall } from "./e2e-route.js";
import { TRANSPORTS, requestCompat } from "./transport.js";
import type { E2EModelRouteDefinition } from "@agentx/contracts";

/**
 * The provider call of the governed e2e model route (M1.4 Task 4.1, amendment A1 and Ruling M4-Q).
 *
 * The AI browser-test agent reaches the installation's configured provider (Bedrock through the worker role, or
 * Anthropic, OpenAI or OpenRouter through the provider key's secret) through the same layer as the coding agent:
 * model-runtime's configuration and pi-ai's API adapters. It calls those adapters directly, as coding's
 * `safeProviderStream` does, and never `ModelRuntime.create()` (whose auth resolution reads the ambient environment and
 * credential stores) and never `createModelRuntimeWithFallback`. A missing secret is a failed call, never a fall back to
 * another provider.
 *
 * What it sends is shaped on the way out, in the last `onPayload` hook: no temperature, top-p or top-k (Haiku 5.5
 * rejects temperature 0 and every provider has its own default), Claude thinking disabled with a low effort (a thinking
 * block would count against the output cap and the channel schema refuses it), OpenRouter's routing policy from the
 * route, the pinned model, exactly the offered tools, and a last credential scan by the proxy. The digest of the final
 * payload is returned for the stored transcript.
 *
 * One attempt per call. The keyed adapters make no retry at `maxRetries: 0`. pi-ai's Bedrock client sets no
 * `maxAttempts`, so the AWS SDK would retry a throttle three times; its response hook throws on the first failed HTTP
 * response instead, which the SDK's retry loop treats as a client error and stops on (proved against a loopback endpoint).
 *
 * The process environment is not trusted here: the proxy refuses to start when it can redirect or re-authenticate a
 * call (`assertE2EEnvironmentCannotRedirect`), and every setting this call depends on is passed explicitly.
 */

export interface E2EProviderInvokeDependencies {
  /** Where `AGENTX_*` settings are read from. Defaults to the process environment. */
  environment?: NodeJS.ProcessEnv;
  /** Reads a Secrets Manager secret by ARN. Defaults to the SDK. The value stays in memory. */
  readSecret?: (arn: string) => Promise<string | undefined>;
  /** The HTTP transport of the keyed providers. Defaults to `fetch`. Tests pass a fake. */
  fetch?: typeof fetch;
  /** For loopback tests only: a Bedrock endpoint and provider-scoped environment values. Production leaves it unset. */
  testing?: { bedrockEndpoint?: string; providerEnv?: Record<string, string> };
}

/** An invoke that also names the secret values it holds, so the proxy can add them to its credential scan. */
export type E2EProviderInvoke = E2EInvoke & { readonly secrets: readonly string[] };

type ProviderError = Error & { status?: number; mayHaveBeenBilled?: boolean };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function providerError(message: string, extra: { status?: number; mayHaveBeenBilled?: boolean } = {}): ProviderError {
  return Object.assign(new Error(message), extra);
}

// ---------------------------------------------------------------------------------------------------------------------
// The served model, as the provider's stream says it
// ---------------------------------------------------------------------------------------------------------------------

interface Observed { status?: number; model?: string; upstream?: string }

/** Observes only the serving model and the router's upstream provider, and the status of a failed response; never a body. */
function observingFetch(transport: typeof fetch, observed: Observed): typeof fetch {
  return async (input, init) => {
    const response = await transport(input, init);
    if (!response.ok) observed.status = response.status;
    if (!response.ok || !response.body) return response;
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
            const served = data.model ?? data.message?.model ?? data.response?.model;
            if (typeof served === "string" && /^[A-Za-z0-9._:/@+=-]{1,200}$/.test(served)) observed.model = served;
            if (typeof data.provider === "string" && /^[A-Za-z0-9 ._:/-]{1,128}$/.test(data.provider)) observed.upstream = data.provider;
          } catch { /* An incomplete or non-JSON event is the adapter's to handle. */ }
        }
        if (pending.length > 1_048_576) pending = "";
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Channel call to pi's context
// ---------------------------------------------------------------------------------------------------------------------

/**
 * OpenAI's Responses API ids are `call_id|item_id` pairs, and the channel's tool call ids cannot hold a `|`. Neither half
 * contains a `.`, so the bar travels as a dot on the channel and is restored when the id comes back in a prompt.
 */
const toChannelId = (provider: E2EInvokeInput["target"]["provider"], id: string) => (provider === "openai" ? id.replace("|", ".") : id);
const fromChannelId = (provider: E2EInvokeInput["target"]["provider"], id: string) => (provider === "openai" ? id.replace(".", "|") : id);

function toPiContext(call: E2EModelChannelCall, model: Model<Api>, provider: E2EInvokeInput["target"]["provider"]): Context {
  const system = call.prompt.flatMap((message) => (message.role === "system" ? [message.content] : [])).join("\n\n");
  const tools: Tool[] = (call.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? "", parameters: tool.inputSchema }));
  const messages: Message[] = [];
  let timestamp = 0;
  for (const message of call.prompt) {
    timestamp += 1;
    if (message.role === "system") continue;
    if (message.role === "user") {
      messages.push({ role: "user", content: message.content.map((part) => ({ type: "text" as const, text: part.text })), timestamp });
    } else if (message.role === "assistant") {
      const content: AssistantMessage["content"] = [];
      for (const part of message.content) {
        if (part.type === "text") {
          if (part.text !== "") content.push({ type: "text", text: part.text });
        } else {
          if (typeof part.input !== "object" || part.input === null || Array.isArray(part.input)) throw new Error("a tool call input must be a JSON object");
          content.push({ type: "toolCall", id: fromChannelId(provider, part.toolCallId), name: part.toolName, arguments: part.input as Record<string, never> });
        }
      }
      messages.push({
        role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: zeroUsage,
        stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", timestamp,
      });
    } else {
      for (const part of message.content) {
        const text = part.output.type === "content" ? part.output.value.map((item) => item.text).join("\n") : part.output.value;
        messages.push({ role: "toolResult", toolCallId: fromChannelId(provider, part.toolCallId), toolName: part.toolName, content: [{ type: "text", text }], isError: part.output.type === "error-text", timestamp });
      }
    }
  }
  return { ...(system === "" ? {} : { systemPrompt: system }), ...(tools.length === 0 ? {} : { tools }), messages };
}

type ToolChoice = E2EModelChannelCall["toolChoice"];

function toolChoiceFor(provider: E2EInvokeInput["target"]["provider"], choice: ToolChoice): unknown {
  if (choice === undefined) return undefined;
  if (provider === "amazon-bedrock") return choice.type === "auto" ? "auto" : choice.type === "required" ? "any" : { type: "tool", name: choice.toolName };
  if (provider === "anthropic") return choice.type === "auto" ? "auto" : choice.type === "required" ? "any" : { type: "tool", name: choice.toolName };
  if (provider === "openai") return choice.type === "auto" ? "auto" : choice.type === "required" ? "required" : { type: "function", name: choice.toolName };
  return choice.type === "auto" ? "auto" : choice.type === "required" ? "required" : { type: "function", function: { name: choice.toolName } };
}

// ---------------------------------------------------------------------------------------------------------------------
// The final payload
// ---------------------------------------------------------------------------------------------------------------------

type Payload = Record<string, unknown>;

function offeredNames(call: E2EModelChannelCall): string[] {
  return (call.tools ?? []).map((tool) => tool.name).sort();
}

function payloadToolNames(provider: E2EInvokeInput["target"]["provider"], payload: Payload): string[] {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  if (provider === "amazon-bedrock") return list((payload["toolConfig"] as { tools?: unknown } | undefined)?.tools).map((tool) => String((tool as { toolSpec?: { name?: unknown } }).toolSpec?.name)).sort();
  if (provider === "openrouter") return list(payload["tools"]).map((tool) => String((tool as { function?: { name?: unknown } }).function?.name)).sort();
  return list(payload["tools"]).map((tool) => String((tool as { name?: unknown }).name)).sort();
}

function withoutSampling<T extends Payload>(payload: T): T {
  const copy: Payload = { ...payload };
  for (const key of ["temperature", "top_p", "top_k", "topP", "topK"]) delete copy[key];
  return copy as T;
}

function shapePayload(rawPayload: unknown, input: E2EInvokeInput, definition: E2EModelRouteDefinition): Payload {
  if (typeof rawPayload !== "object" || rawPayload === null) throw providerError("the provider payload is not an object");
  const provider = input.target.provider;
  let payload = withoutSampling(rawPayload as Payload);
  const expectedModel = input.target.identifier;
  const claude = provider === "anthropic" || (provider === "amazon-bedrock" && /anthropic\.claude/.test(expectedModel)) || (provider === "openrouter" && definition.modelId.startsWith("anthropic/"));

  if (provider === "amazon-bedrock") {
    const inference = withoutSampling((payload["inferenceConfig"] ?? {}) as Payload);
    payload = { ...payload, inferenceConfig: inference };
    delete payload["additionalModelRequestFields"];
    if (claude) payload["additionalModelRequestFields"] = { thinking: { type: "disabled" }, ...(input.effort === null ? {} : { output_config: { effort: input.effort } }) };
    if (payload["modelId"] !== expectedModel) throw providerError("the provider payload names another model than the route pins");
  } else if (provider === "anthropic") {
    payload["thinking"] = { type: "disabled" };
    if (input.effort !== null) payload["output_config"] = { ...((payload["output_config"] ?? {}) as Payload), effort: input.effort };
    if (payload["model"] !== expectedModel) throw providerError("the provider payload names another model than the route pins");
  } else if (provider === "openai") {
    if (input.effort !== null || (payload["reasoning"] !== undefined)) payload["reasoning"] = { ...((payload["reasoning"] ?? {}) as Payload), effort: "low" };
    if (payload["model"] !== expectedModel) throw providerError("the provider payload names another model than the route pins");
  } else {
    // OpenRouter: the route's routing policy replaces whatever the adapter built, and no router field survives.
    const policy = definition.openRouter;
    if (policy === null) throw providerError("an OpenRouter route needs its routing policy");
    payload["provider"] = { allow_fallbacks: policy.allowFallbacks, require_parameters: policy.requireParameters, data_collection: policy.dataCollection, ...(policy.only.length > 0 ? { only: policy.only, order: policy.only } : {}) };
    delete payload["models"];
    delete payload["route"];
    if (definition.modelId.startsWith("anthropic/")) payload["reasoning"] = { effort: "none" };
    if (payload["model"] !== expectedModel) throw providerError("the provider payload names another model than the route pins");
  }
  if (JSON.stringify(payloadToolNames(provider, payload)) !== JSON.stringify(offeredNames(input.call))) {
    throw providerError("the provider payload carries other tools than the request offered");
  }
  return payload;
}

// ---------------------------------------------------------------------------------------------------------------------
// The factory
// ---------------------------------------------------------------------------------------------------------------------

function finishFor(stopReason: AssistantMessage["stopReason"]): string {
  switch (stopReason) {
    case "stop": return "stop";
    case "toolUse": return "tool-calls";
    case "length": return "length";
    default: return "error";
  }
}

function contentOf(message: AssistantMessage, provider: E2EInvokeInput["target"]["provider"]): Array<Record<string, unknown>> {
  return message.content.flatMap((block): Array<Record<string, unknown>> => {
    if (block.type === "text") return block.text === "" ? [] : [{ type: "text", text: block.text }];
    if (block.type === "toolCall") {
      // A tool call whose arguments were not a JSON object has no input the route could trust.
      if (block.argumentsError !== undefined) return [{ type: "unsupported-block" }];
      return [{ type: "tool-call", toolCallId: toChannelId(provider, block.id), toolName: block.name, input: JSON.stringify(block.arguments) }];
    }
    return [{ type: "unsupported-block" }];
  });
}

/**
 * The provider call for a route on a real provider. Never throws: a failure to set up (a missing secret, a model the
 * pinned catalog lacks) is raised by the returned invoke on every call, so the route answers `provider-error` and the
 * step becomes UNKNOWN with no fall back.
 */
export async function createE2EProviderInvoke(definition: E2EModelRouteDefinition, dependencies: E2EProviderInvokeDependencies = {}): Promise<E2EProviderInvoke> {
  if (definition.provider === "rovara-scripted") throw new Error("a scripted route has no provider to call");
  const provider = definition.provider;
  const readSecret = dependencies.readSecret;
  const transport = dependencies.fetch ?? globalThis.fetch;
  const identifier = definition.inferenceProfileArn ?? definition.modelId;

  let setupFailure: unknown;
  let key: string | undefined;
  let model: Model<Api> | undefined;
  try {
    if (isKeyedModelProvider(provider)) {
      const keyed: KeyedModelProvider = provider;
      key = await readProviderKey(keyed, definition.secretArn ?? "", readSecret);
      const entry = requireKeyedModel(keyed, definition.modelId);
      const { api, baseUrl } = TRANSPORTS[keyed];
      model = { ...entry, api, baseUrl, compat: requestCompat(keyed, entry.compat), samplingParams: undefined, samplingParamsByThinkingLevel: undefined } as unknown as Model<Api>;
    } else {
      const entry = catalogModel({ provider, modelId: definition.modelId });
      if (entry === undefined) throw agentXError("CONFIG_INVALID", "the route's Bedrock model is not in the installed Pi catalog");
      const region = definition.region ?? "";
      model = { ...entry, id: identifier, baseUrl: dependencies.testing?.bedrockEndpoint ?? `https://bedrock-runtime.${region}.amazonaws.com`, samplingParams: undefined, samplingParamsByThinkingLevel: undefined } as unknown as Model<Api>;
    }
  } catch (error) {
    setupFailure = error;
  }

  const invoke = async (input: E2EInvokeInput): Promise<E2EInvokeOutput> => {
    if (setupFailure !== undefined) throw setupFailure as Error;
    const activeModel = model as Model<Api>;
    // The adapters are given a controller of this call's own, so a failed first response can end the call.
    const attempt = new AbortController();
    const stopWithRun = () => attempt.abort(input.signal.reason);
    if (input.signal.aborted) stopWithRun();
    else input.signal.addEventListener("abort", stopWithRun, { once: true });

    const observed: Observed = {};
    let payloadSha256: string | undefined;
    // pi-ai catches an error thrown by the payload hook and turns it into a failed stream, so the hook keeps its own error.
    let hookFailure: unknown;
    const context = normalizeContext(toPiContext(input.call, activeModel, provider));
    const common = {
      signal: attempt.signal,
      maxRetries: 0,
      timeoutMs: 30_000,
      cacheRetention: "none" as const,
      maxTokens: input.maxOutputTokens,
      toolChoice: toolChoiceFor(provider, input.call.toolChoice),
      onPayload: (raw: unknown) => {
        try {
          const shaped = shapePayload(raw, input, definition);
          input.inspectPayload?.(shaped);
          payloadSha256 = sha256(JSON.stringify(shaped));
          return shaped;
        } catch (error) {
          hookFailure = error;
          throw error;
        }
      },
    };
    let events: AssistantMessageEventStream;
    try {
      if (provider === "amazon-bedrock") {
        events = bedrockStream(activeModel as Model<"bedrock-converse-stream">, context, {
          ...common, toolChoice: common.toolChoice as never, ...(definition.region === null ? {} : { region: definition.region }),
          ...(dependencies.testing?.providerEnv === undefined ? {} : { env: dependencies.testing.providerEnv }),
          // pi sets no maxAttempts on its Bedrock client, so the SDK would retry a throttle or a 5xx twice more. Each HTTP
          // response passes here, inside the SDK's retry loop. Throwing a plain error for a failed response makes the loop
          // classify it as a client error and stop (aborting the signal here instead leaves the loop hanging; Step 0).
          onResponse: (response: { status: number }) => {
                if (response.status >= 400) { observed.status = response.status; throw new Error("the provider refused the call"); }
          },
        });
      } else {
        const options = { ...common, ...(key === undefined ? {} : { apiKey: key }), fetch: observingFetch(transport, observed) };
        if (provider === "anthropic") events = anthropicStream(activeModel as Model<"anthropic-messages">, context, { ...options, toolChoice: options.toolChoice as never });
        else if (provider === "openai") events = openAIResponsesStream(activeModel as Model<"openai-responses">, context, { ...options, toolChoice: options.toolChoice as never });
        else events = openAICompletionsStream(activeModel as Model<"openai-completions">, context, { ...options, toolChoice: options.toolChoice as never });
      }
    } catch (error) {
      input.signal.removeEventListener("abort", stopWithRun);
      throw error;
    }

    let sawContent = false;
    let final: AssistantMessage;
    try {
      for await (const event of events) {
        if (event.type !== "start" && event.type !== "error") sawContent = true;
      }
      final = await events.result();
    } finally {
      input.signal.removeEventListener("abort", stopWithRun);
    }

    // A payload the proxy's last check refused never left: surface that, not a generic failure.
    if (hookFailure !== undefined) throw hookFailure as Error;
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      const status = observed.status;
      const billed = sawContent || final.usage.input > 0;
      if (input.signal.aborted && status === undefined) throw providerError("the model call was stopped", { mayHaveBeenBilled: billed });
      throw providerError("the provider call failed", { ...(status === undefined ? {} : { status }), mayHaveBeenBilled: billed });
    }

    const usage = final.usage;
    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    return {
      servedModelId: final.responseModel ?? observed.model ?? null,
      ...(observed.upstream === undefined ? {} : { servedUpstream: observed.upstream }),
      ...(payloadSha256 === undefined ? {} : { providerPayloadSha256: payloadSha256 }),
      content: contentOf(final, provider),
      finishReason: { unified: finishFor(final.stopReason), raw: final.rawStopReason ?? null },
      // pi always reports a usage object, so a stream that reported none shows as zero input: that is no usage.
      usage: inputTokens > 0 ? { inputTokens, outputTokens: usage.output } : undefined,
    };
  };

  return Object.assign(invoke, { secrets: key === undefined ? [] : [key] as readonly string[] });
}
