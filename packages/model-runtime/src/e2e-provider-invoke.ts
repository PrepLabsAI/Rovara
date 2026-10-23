import { createHash } from "node:crypto";
import { agentXError, isKeyedModelProvider, type E2EModelFailure, type KeyedModelProvider } from "@agentx/contracts";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Message, Model, Tool } from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { stream as bedrockStream } from "@earendil-works/pi-ai/api/bedrock-converse-stream";
import { stream as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { stream as openAIResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { catalogModel } from "./catalog.js";
import { readProviderKey, requireKeyedModel } from "./config.js";
import { assertE2EEnvironmentCannotRedirect, assertE2ERouteMatchesInstallation } from "./e2e-environment-guard.js";
import type { E2EInvoke, E2EInvokeInput, E2EInvokeOutput, E2EModelChannelCall } from "./e2e-route.js";
import { BEDROCK_SIGNAL_PATTERN, KEYED_SIGNAL_PATTERN, classifyProviderFailure, isNetworkCode } from "./provider-failure.js";
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
}

/** Loopback overrides for tests only: the third argument of the private builder, reached only through `createE2EProviderInvokeForTesting`. */
interface E2EProviderInvokeTesting { bedrockEndpoint?: string; providerEnv?: Record<string, string> }

/** An invoke that also names the secret values it holds, so the proxy can add them to its credential scan, and the Bedrock endpoint it names. */
export type E2EProviderInvoke = E2EInvoke & { readonly secrets: readonly string[]; readonly endpoint?: string };

type ProviderError = Error & { status?: number; mayHaveBeenBilled?: boolean; failure?: E2EModelFailure };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** An error raised before any request went out: the route charges nothing for it and releases the day reservation. */
function notSent<T>(error: T): T {
  const target = (typeof error === "object" && error !== null ? error : new Error(String(error))) as T & { requestNotSent?: boolean };
  target.requestNotSent = true;
  return target;
}

function providerError(message: string, extra: { status?: number; mayHaveBeenBilled?: boolean; failure?: E2EModelFailure } = {}): ProviderError {
  return Object.assign(new Error(message), extra);
}

// ---------------------------------------------------------------------------------------------------------------------
// The served model, as the provider's stream says it
// ---------------------------------------------------------------------------------------------------------------------

/**
 * What a call saw: the status of a failed response, whether a 2xx response arrived, and the served model. Also (Task 4.10B) the failure's signal, one allow-listed token of the
 * provider's own error type or code, and the network code of a call that got no answer. Never a message.
 */
interface Observed { status?: number; accepted?: boolean; responses?: number; model?: string; upstream?: string; signal?: string; networkCode?: string }

/** The most of a failed response's body that is read to find its error type: 8 KiB, in memory, within two seconds. Nothing of it is kept but one token. */
const ERROR_BODY_MAX_BYTES = 8_192;
const ERROR_BODY_READ_MS = 2_000;

/**
 * The provider's own error type or code from a failed response's body (Anthropic `error.type`, OpenAI `error.code` else `error.type`, OpenRouter's numeric `error.code`), or undefined.
 * The response is a clone, so the SDK still reads the original. The text is parsed and dropped: only a token that matches the keyed pattern leaves this function.
 */
async function readKeyedErrorSignal(response: Response): Promise<string | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.body?.getReader();
    if (reader === undefined) return undefined;
    const active = reader;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const read = (async () => {
      while (total < ERROR_BODY_MAX_BYTES) {
        const { done, value } = await active.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
    })();
    read.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([read, new Promise<void>((resolve) => { timer = setTimeout(resolve, ERROR_BODY_READ_MS); })]);
    clearTimeout(timer);
    const text = new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).subarray(0, ERROR_BODY_MAX_BYTES));
    const error = (JSON.parse(text) as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return undefined;
    const { code, type } = error as { code?: unknown; type?: unknown };
    const token = [typeof code === "number" && Number.isInteger(code) ? String(code) : code, type].find((value): value is string => typeof value === "string" && KEYED_SIGNAL_PATTERN.test(value));
    return token;
  } catch { return undefined; }
  finally { void reader?.cancel().catch(() => undefined); }
}

/** The network code of a transport error (`error.cause.code` for undici's fetch, else `error.code`), only when it is one of the allow-listed codes. */
function networkCodeOf(error: unknown): string | undefined {
  const record = (value: unknown) => (typeof value === "object" && value !== null ? value as { code?: unknown; cause?: unknown } : {});
  const outer = record(error);
  const code = [record(outer.cause).code, outer.code].find((value): value is string => typeof value === "string" && isNetworkCode(value));
  return code;
}

/** A network code named in an adapter's error text (the AWS SDK's and pi-ai's errors carry the code in the message): only the allow-listed token is taken from it, never the text. */
function networkCodeInText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const found = /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|CERT_[A-Z0-9_]{1,56})\b/.exec(text)?.[1];
  return found;
}

/** Observes only the serving model and the router's upstream provider, the status of a failed response and its error type; never anything else of a body. */
function observingFetch(transport: typeof fetch, observed: Observed): typeof fetch {
  return async (input, init) => {
    let response: Response;
    try { response = await transport(input, init); }
    catch (error) {
      const code = networkCodeOf(error);
      if (code !== undefined) observed.networkCode = code;
      throw error;
    }
    if (!response.ok) {
      observed.status = response.status;
      const signal = await readKeyedErrorSignal(response.clone());
      if (signal !== undefined) observed.signal = signal;
    } else observed.accepted = true;
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

/** The error type pi-ai's Bedrock adapter recorded for a failure that came as a stream event after a 200 (`bedrock_response_failure`), when it is one letters-only token. */
function bedrockDiagnosticSignal(message: AssistantMessage): string | undefined {
  const diagnostics = (message as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  for (const item of diagnostics as Array<{ type?: unknown; details?: { errorCode?: unknown } }>) {
    const code = item?.type === "bedrock_response_failure" ? item.details?.errorCode : undefined;
    if (typeof code === "string" && BEDROCK_SIGNAL_PATTERN.test(code)) return code;
  }
  return undefined;
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
export function createE2EProviderInvoke(definition: E2EModelRouteDefinition, dependencies: E2EProviderInvokeDependencies = {}): Promise<E2EProviderInvoke> {
  return buildE2EProviderInvoke(definition, dependencies, undefined);
}

/**
 * The test-only factory: it can point Bedrock at a loopback endpoint and give pi-ai provider-scoped environment values.
 * Only `e2e-provider-invoke-testing.ts` re-exports it, and a test asserts that no other source mentions it. The builder
 * behind both factories is not exported from this module.
 */
export function createE2EProviderInvokeForTesting(definition: E2EModelRouteDefinition, dependencies: E2EProviderInvokeDependencies, testing: E2EProviderInvokeTesting): Promise<E2EProviderInvoke> {
  return buildE2EProviderInvoke(definition, dependencies, testing);
}

async function buildE2EProviderInvoke(definition: E2EModelRouteDefinition, dependencies: E2EProviderInvokeDependencies, testing: E2EProviderInvokeTesting | undefined): Promise<E2EProviderInvoke> {
  if (definition.provider === "rovara-scripted") throw new Error("a scripted route has no provider to call");
  const provider = definition.provider;
  const readSecret = dependencies.readSecret;
  const transport = dependencies.fetch ?? globalThis.fetch;
  const identifier = definition.inferenceProfileArn ?? definition.modelId;

  // Production names the standard regional endpoint. (pi-ai takes its explicit-endpoint path only when no region is
  // configured anywhere, which a worker with AWS_REGION set never satisfies, so with a region the SDK resolves this same
  // endpoint itself; the environment guard closes the overrides that could change that.)
  const bedrockEndpoint = provider === "amazon-bedrock" ? (testing?.bedrockEndpoint ?? `https://bedrock-runtime.${definition.region ?? ""}.amazonaws.com`) : undefined;

  let setupFailure: unknown;
  // Which fixed failure a setup error is, by the step it came from (Task 4.10B): the error's own text is never read. A route/installation mismatch has none.
  let setupStep: "installation" | "secret" | "catalog" = "installation";
  let key: string | undefined;
  let model: Model<Api> | undefined;
  try {
    assertE2ERouteMatchesInstallation(definition, dependencies.environment ?? process.env);
    if (isKeyedModelProvider(provider)) {
      const keyed: KeyedModelProvider = provider;
      setupStep = "secret";
      key = await readProviderKey(keyed, definition.secretArn ?? "", readSecret);
      setupStep = "catalog";
      const entry = requireKeyedModel(keyed, definition.modelId);
      const { api, baseUrl } = TRANSPORTS[keyed];
      model = { ...entry, api, baseUrl, compat: requestCompat(keyed, entry.compat), samplingParams: undefined, samplingParamsByThinkingLevel: undefined } as unknown as Model<Api>;
    } else {
      setupStep = "catalog";
      const entry = catalogModel({ provider, modelId: definition.modelId });
      if (entry === undefined) throw agentXError("CONFIG_INVALID", "the route's Bedrock model is not in the installed Pi catalog");
      model = { ...entry, id: identifier, baseUrl: bedrockEndpoint, samplingParams: undefined, samplingParamsByThinkingLevel: undefined } as unknown as Model<Api>;
    }
  } catch (error) {
    setupFailure = error;
  }
  const setupClass: E2EModelFailure | undefined = setupFailure === undefined ? undefined
    : setupStep === "secret" ? { class: "key-rejected", signal: "secret-unreadable" } : setupStep === "catalog" ? { class: "model-not-found", signal: "not-in-catalog" } : undefined;

  const invoke = async (input: E2EInvokeInput): Promise<E2EInvokeOutput> => {
    if (setupFailure !== undefined) {
      const refused = notSent(setupFailure) as Error & { failure?: E2EModelFailure };
      if (setupClass !== undefined) refused.failure = setupClass;
      throw refused;
    }
    // pi-ai and the AWS SDK read the real process environment on every call, and so does this guard.
    try { assertE2EEnvironmentCannotRedirect(dependencies.environment); } catch (error) { throw notSent(error) as Error; }
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
    let refusal: (Error & { $metadata?: { attempts?: number } }) | undefined;
    let context: ReturnType<typeof normalizeContext>;
    try { context = normalizeContext(toPiContext(input.call, activeModel, provider)); } catch (error) { throw notSent(error) as Error; }
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
          ...(testing?.providerEnv === undefined ? {} : { env: testing.providerEnv }),
          // pi sets no maxAttempts on its Bedrock client, so the SDK would retry a throttle or a 5xx twice more. Each HTTP
          // response passes here, inside the SDK's retry loop. Throwing a plain error for a failed response makes the loop
          // classify it as a client error and stop (aborting the signal here instead leaves the loop hanging; Step 0).
          onResponse: (response: { status: number; headers?: Record<string, string> }) => {
            observed.responses = (observed.responses ?? 0) + 1;
            if (response.status >= 400) {
              observed.status = response.status;
              // The part of the error type header before the colon (`ThrottlingException:http://internal.amazon.com/coral/...`), when it is one letters-only token.
              const header = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "x-amzn-errortype")?.[1];
              const type = typeof header === "string" ? header.split(":")[0]!.trim() : "";
              if (BEDROCK_SIGNAL_PATTERN.test(type)) observed.signal = type;
              // The SDK's retry loop records how many attempts it made on the error it throws.
              refusal = new Error("the provider refused the call");
              throw refusal;
            }
            observed.accepted = true;
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
    if (hookFailure !== undefined) throw (payloadSha256 === undefined ? notSent(hookFailure) : hookFailure) as Error;
    if (final.stopReason === "error" || final.stopReason === "aborted") {
      const status = observed.status;
      // The call may have been billed unless the provider refused it with an HTTP status: anything that was accepted (a 2xx
      // response, even one cut before its first delta) or that went out and got no response at all (a dropped connection,
      // which the AWS SDK may also have retried) is charged the reserved bound.
      // An attempt that went out and got no response at all (dropped before the one that was answered) may have been processed.
      const attempts = refusal?.$metadata?.attempts;
      const unansweredAttempt = attempts !== undefined && attempts > (observed.responses ?? 0);
      const billed = unansweredAttempt || sawContent || final.usage.input > 0 || observed.accepted === true || (payloadSha256 !== undefined && status === undefined);
      if (input.signal.aborted && status === undefined) throw providerError("the model call was stopped", { mayHaveBeenBilled: billed });
      // Why it failed, as one fixed class (Task 4.10B). The adapter's error text is read for nothing but a timeout and an allow-listed network code; Bedrock's own diagnostic names a
      // stream error that came after a 200.
      // The adapter's text is read only when no 2xx response was seen: after one, it can hold what the model or the provider's stream said, which must not steer the class.
      const text = observed.accepted === true ? undefined : final.errorMessage;
      const networkCode = observed.networkCode ?? networkCodeInText(text);
      const failure = classifyProviderFailure({ provider, status, signal: observed.signal ?? bedrockDiagnosticSignal(final), networkCode,
        timedOut: status === undefined && (final.stopReason === "aborted" || (text !== undefined && /\btimed? ?out\b/i.test(text))) });
      throw providerError("the provider call failed", { ...(status === undefined ? {} : { status }), mayHaveBeenBilled: billed, failure });
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

  return Object.assign(invoke, { secrets: key === undefined ? [] : [key] as readonly string[], ...(bedrockEndpoint === undefined ? {} : { endpoint: bedrockEndpoint }) });
}
