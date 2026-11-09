import { MissingProviderSecret, type ModelRole } from "./config.js";
import { openRouterRouting, readProviderKey, requireKeyedModel } from "./config.js";
import { ROUTE_PROVIDER, bedrockClaudeModelIds, catalogModel, catalogModelByName, proxyGeographyOfModelId } from "./catalog.js";
export { ROUTE_PROVIDER };
import { TRANSPORTS, requestCompat } from "./transport.js";
import { ModelBudgetExhaustedError, ModelNotAllowedError, budgetExhaustedMarker, budgetScopeOfProxyBody, modelNotAllowedMarker, type ModelBudgetScope } from "./budget.js";
export { ModelBudgetExhaustedError, ModelNotAllowedError, budgetExhaustedFromMarker, modelNotAllowedFromMarker, type ModelBudgetScope } from "./budget.js";
export { readOpenRouterKey, readProviderKey, openRouterRouting, openRouterModel, requireKeyedModel } from "./config.js";
// The governed e2e model route (M1.4): its own surface, never reached through the coding-task fallback above.
export * from "./e2e-route.js";
export { createE2EProviderInvoke } from "./e2e-provider-invoke.js";
export type { E2EProviderInvoke, E2EProviderInvokeDependencies } from "./e2e-provider-invoke.js";
export * from "./e2e-environment-guard.js";
export * from "./e2e-route-derive.js";
export { classifyProviderFailure, isNetworkCode, signalPattern, BEDROCK_SIGNAL_PATTERN, KEYED_SIGNAL_PATTERN, MODEL_NOT_ENABLED_SIGNAL } from "./provider-failure.js";
export type { ProviderFailureFacts } from "./provider-failure.js";
import { CHATGPT_PLAN_LIMIT_ERROR, KEYED_MODEL_PROVIDERS, MODEL_FALLBACK_NONE, MODEL_FALLBACK_PATTERN, agentXError, isKeyedModelProvider, type InvocationModelRoute, type KeyedModelProvider, type ModelIdentifier, type ThinkingLevel } from "@agentx/contracts";
import { InMemoryCredentialStore, createAssistantMessageEventStream, type Api, type Model, type SimpleStreamOptions, type TranscriptContext, type AssistantMessage, type AssistantMessageEventStream, type OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { streamSimple as openAICompletionsStream } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as anthropicMessagesStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openAIResponsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface AuthorizedModelFallback {model:ModelIdentifier&{thinkingLevel?:ThinkingLevel};proxy?:ModelProxyOptions}

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
  /** MODEL3: told when a missing provider secret sent the work to the installation's chosen fallback model. */
  onFallback?: (notice: ModelFallbackNotice) => void;
  /** Optional server authority gate before constructing a missing-key replacement runtime. */
  authorizeFallback?: (notice: ModelFallbackNotice) => Promise<void|AuthorizedModelFallback>;
  /**
   * The model proxy (ruling R29): every request goes to `baseUrl` with a per-task proxy key, and no provider secret is read.
   * Only the Claude models the proxy serves (Bedrock's, under the catalog's own ids) are available; any other model is refused.
   * `apiKey` may be a function, asked before every request, because a task's key lasts an hour and a task can run longer.
   * A ChatGPT plan (`apiKey` above) stays direct and ignores this.
   */
  proxy?: ModelProxyOptions;
}

export interface ModelProxyOptions {
  /** The proxy's origin, without a path: Pi adds /v1/messages. */
  baseUrl: string;
  apiKey: string | (() => Promise<string>);
  /**
   * The model the broker chose for this work (Task 27): one model under `route.alias`, spoken in `route.api`, whatever model was
   * asked for. Without it the proxy serves its Bedrock Claude models as it always has. A ChatGPT plan's own requests ignore it.
   */
  route?: InvocationModelRoute;
}

/**
 * Whether a routed model reasons: the catalog entry it names says so, and a model the catalogs do not know (a company's own) does not.
 * The thinking level a project chose was chosen for another model, so a routed model without reasoning runs with it off.
 */
export function routeSupportsReasoning(route: InvocationModelRoute): boolean {
  return catalogModelByName(route.catalog)?.model.reasoning ?? UNLISTED_ROUTED_MODEL.reasoning;
}

/** The thinking level a routed model runs with: the one asked for if the model reasons, else off; absent stays absent. */
export function routedThinkingLevel<L extends string>(route: InvocationModelRoute, requested: L | undefined): L | "off" | undefined {
  return requested === undefined || routeSupportsReasoning(route) ? requested : "off";
}

/**
 * Who a routed model's usage is reported under: the catalog entry the route names (its provider and id, which price lists and
 * usage records know), or `rovara-route` and the catalog name for a model the installed catalogs do not know.
 */
export function routeUsageIdentity(route: InvocationModelRoute): ModelIdentifier {
  return catalogModelByName(route.catalog)?.identity ?? { provider: ROUTE_PROVIDER, modelId: route.catalog };
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
  /** Optional server authority gate. A rejection must prevent the replacement call, not become telemetry. */
  authorize?(reason: ChatGptFallbackReason): Promise<void>;
  /** Told once, at the first request that fell back. */
  onFallback(reason: ChatGptFallbackReason): void;
}

// Shared by every runtime/session using the same task fallback.
const fallbackAuthorizations = new WeakMap<ChatGptFallback, Promise<void>>();

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

/** The environment variable that carries the installation's chosen fallback model (`none`, unset, or a Bedrock model id of the pinned catalog). */
export const MODEL_FALLBACK_VARIABLE = "AGENTX_MODEL_FALLBACK";

/** Told, once per runtime, that work ran on the chosen fallback because a provider's key secret is missing (MODEL3). `text` is the sentence for the task page and Slack. */
export interface ModelFallbackNotice {
  role: ModelRole;
  reason: string;
  requested: { provider: string; modelId: string };
  effective: { provider: "amazon-bedrock"; modelId: string };
  text: string;
}

/** The chosen fallback as a model, or undefined for `none`, an unset or malformed setting, and an id the pinned Bedrock catalog does not know. */
export function modelFallbackModel(value: string | undefined): { provider: "amazon-bedrock"; modelId: string } | undefined {
  const id = value?.trim();
  if (id === undefined || id === "" || id === MODEL_FALLBACK_NONE || !MODEL_FALLBACK_PATTERN.test(id)) return undefined;
  return catalogModel({ provider: "amazon-bedrock", modelId: id }) === undefined ? undefined : { provider: "amazon-bedrock", modelId: id };
}

const FALLBACK_COMMAND = "`agentx --env <env> config set models.fallback <bedrock model id>`";

/**
 * Resolve a missing provider secret before creating a session, so its model and usage agree. There is no default fallback (MODEL3): with no chosen fallback the call fails by name, and with
 * one it runs on that model and says so, in the log, in the result and through `options.onFallback`.
 */
export async function createModelRuntimeWithFallback<T extends ModelIdentifier>(selected: T, role: ModelRole, options: ModelRuntimeOptions = {}) {
  const route = options.apiKey === undefined ? options.proxy?.route : undefined;
  // A routed task runs the route's model whatever was configured, so what it reports is the route's, not the configured model.
  if (route !== undefined) {
    const { thinkingLevel, ...rest } = selected as T & { thinkingLevel?: ThinkingLevel };
    const level = routedThinkingLevel(route, thinkingLevel);
    return { runtime: await createConfiguredModelRuntime(selected, options), model: { ...rest, provider: ROUTE_PROVIDER, modelId: route.alias, ...(level === undefined ? {} : { thinkingLevel: level }) } };
  }
  try {
    return { runtime: await createConfiguredModelRuntime(selected, options), model: selected };
  } catch (error) {
    if (!(error instanceof MissingProviderSecret)) throw error;
    const label = KEYED_MODEL_PROVIDERS[error.provider].label;
    const chosen = ((options.environment ?? process.env)[MODEL_FALLBACK_VARIABLE] ?? "").trim();
    const model = modelFallbackModel(chosen);
    if (model === undefined) {
      const named = MODEL_FALLBACK_PATTERN.test(chosen) && chosen !== MODEL_FALLBACK_NONE;
      throw agentXError("CONFIG_INVALID", named
        ? `The ${label} key secret is missing, and the fallback model ${chosen} is not a Bedrock model in this Rovara's model catalog. Add or restore the key, or choose another fallback with ${FALLBACK_COMMAND}`
        : `The ${label} key secret is missing, and no fallback model was chosen. Add or restore the key, or choose a fallback with ${FALLBACK_COMMAND}`);
    }
    const reason = `${error.provider}_secret_missing`;
    const notice: ModelFallbackNotice = {
      role, reason, requested: { provider: selected.provider, modelId: selected.modelId }, effective: model,
      text: `ran on Amazon Bedrock \`${model.modelId}\` because the ${label} key secret is missing`,
    };
    const authorized=await options.authorizeFallback?.(notice);
    if(authorized!==undefined){
      const approvedOptions={...options};
      delete approvedOptions.apiKey;delete approvedOptions.chatgptFallback;delete approvedOptions.proxy;
      if(authorized.proxy!==undefined)approvedOptions.proxy=authorized.proxy;
      // The broker already recorded governed history/audit; construct only its approved replacement.
      return {runtime:await createConfiguredModelRuntime(authorized.model,approvedOptions),model:authorized.model};
    }
    console.info(JSON.stringify({ event: "model_fallback", role, reason, requested: notice.requested, effective: model }));
    try { options.onFallback?.(notice); } catch { /* Reporting must not fail the run it is about. */ }
    return { runtime: await createConfiguredModelRuntime(model, options), model, fallback: notice };
  }
}

/**
 * Construct fresh credentials per session so secrets never enter Pi's file-backed auth store. The
 * key goes into an in-memory store, never into ANTHROPIC_API_KEY, OPENAI_API_KEY or any other
 * environment variable, and the stored key wins over those variables if they are set.
 */
export async function createConfiguredModelRuntime(selected: ModelIdentifier & { thinkingLevel?: string }, options: ModelRuntimeOptions = {}): Promise<ModelRuntime> {
  if (options.proxy?.route !== undefined && options.apiKey === undefined) return createRoutedModelRuntime(selected, options, options.proxy, options.proxy.route);
  if (options.proxy !== undefined && options.apiKey === undefined) return createProxiedModelRuntime(selected, options, options.proxy);
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
 * DR-KEY-1: why the proxy key could not be obtained, kept on the error. Only an AgentXError's own words are kept (the worker's key source writes fixed words: the HTTP status and the control plane's
 * refusal code), bounded and printable; any other error (a transport's, whose text can name hosts or addresses) adds its name only. The key itself is never in either.
 */
function proxyKeyUnavailable(error: unknown): Error {
  // By shape, not class: the key source may be built against another copy of the contracts.
  const code = error instanceof Error && error.name === "AgentXError" ? (error as { code?: unknown }).code : undefined;
  const reason = typeof code === "string" && error instanceof Error && error.message.startsWith(`${code}: `) ? error.message.slice(code.length + 2) : error instanceof Error ? error.name : "unknown";
  const safe = reason.replace(/[^\x20-\x7e]/gu, " ").trim().slice(0, 160);
  return agentXError("RUNTIME_UNAVAILABLE", `the model proxy key could not be obtained${safe === "" ? "" : `: ${safe}`}`);
}

/**
 * A runtime whose models are the Claude models the proxy serves (rulings R21 and R29). Pi's own Bedrock transport
 * is replaced by `anthropic-messages` against the proxy, because that is the one route verified end to end; the
 * models keep Pi's Bedrock catalog ids, which the proxy's model list names exactly. The key is the task's proxy key.
 */
async function createProxiedModelRuntime(selected: ModelIdentifier & { thinkingLevel?: string }, options: ModelRuntimeOptions, proxy: ModelProxyOptions): Promise<ModelRuntime> {
  // The geography the model names (the proxy of an eu install serves eu.* profiles); a bare id is judged against the us profiles.
  const served = new Set(bedrockClaudeModelIds(proxyGeographyOfModelId(selected.modelId) ?? "us"));
  if (selected.provider !== "amazon-bedrock" || !served.has(selected.modelId)) {
    throw agentXError("CONFIG_INVALID", `model ${selected.modelId} is not available on this install`);
  }
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const model = runtime.getModel(selected.provider, selected.modelId);
  if (model === undefined) throw agentXError("CONFIG_INVALID", `model ${selected.modelId} is not available on this install`);
  if (!model.reasoning && selected.thinkingLevel && selected.thinkingLevel !== "off") throw agentXError("CONFIG_INVALID", "the selected model does not support reasoning; set thinkingLevel to off");
  const requestKey = typeof proxy.apiKey === "function" ? proxy.apiKey : undefined;
  const initialKey = requestKey === undefined ? proxy.apiKey as string : await requestKey().catch((error: unknown) => {
    // A spent budget is the task's to end on, not a proxy fault.
    if (error instanceof ModelBudgetExhaustedError || error instanceof ModelNotAllowedError) throw error;
    throw proxyKeyUnavailable(error);
  });
  const api = "anthropic-messages";
  runtime.registerProvider(selected.provider, {
    baseUrl: proxy.baseUrl, api,
    models: runtime.getModels(selected.provider).filter((entry) => served.has(entry.id))
      .map((entry) => ({ ...entry, api, baseUrl: proxy.baseUrl, compat: requestCompat("anthropic", undefined) })),
    streamSimple: (entry, context, streamOptions) => safeProviderStream("anthropic", entry, context, streamOptions, undefined, options.fetch, options.onUsage, undefined, requestKey),
  });
  try { await runtime.setRuntimeApiKey(selected.provider, initialKey); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "the model proxy key could not be initialized"); }
  return runtime;
}

/** What a model the installed catalogs do not know (a company's own) is given: no reasoning, no images, a modest window. */
const UNLISTED_ROUTED_MODEL = { reasoning: false, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 16_384 };

/**
 * A runtime whose one model is the route's (Task 27): the proxy alias, spoken in the route's API, with the limits of the
 * catalog entry the route names. Pi sends the alias as the request model and the proxy's key as the credential; the usage
 * record names the catalog entry, so a price list and the spend reports see the model and not the company's alias.
 */
async function createRoutedModelRuntime(selected: ModelIdentifier & { thinkingLevel?: string }, options: ModelRuntimeOptions, proxy: ModelProxyOptions, route: InvocationModelRoute): Promise<ModelRuntime> {
  const catalog = catalogModelByName(route.catalog)?.model;
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null, credentials: new InMemoryCredentialStore() });
  const requestKey = typeof proxy.apiKey === "function" ? proxy.apiKey : undefined;
  const initialKey = requestKey === undefined ? proxy.apiKey as string : await requestKey().catch((error: unknown) => {
    if (error instanceof ModelBudgetExhaustedError || error instanceof ModelNotAllowedError) throw error;
    throw proxyKeyUnavailable(error);
  });
  const origin = proxy.baseUrl.replace(/\/+$/u, "");
  // Pi's Anthropic client adds /v1/messages itself; the OpenAI clients add /responses and /chat/completions to a base that ends in /v1.
  const baseUrl = route.api === "anthropic-messages" ? proxy.baseUrl : `${origin}/v1`;
  const identity = routeUsageIdentity(route);
  const base = catalog ?? UNLISTED_ROUTED_MODEL;
  runtime.registerProvider(ROUTE_PROVIDER, {
    baseUrl, api: route.api,
    models: [{
      id: route.alias, name: route.alias, api: route.api, baseUrl,
      reasoning: base.reasoning, input: base.input, cost: base.cost, contextWindow: base.contextWindow, maxTokens: base.maxTokens,
      ...(catalog?.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: catalog.thinkingLevelMap }),
      ...(catalog?.promptCache === undefined ? {} : { promptCache: catalog.promptCache }),
      compat: routeCompat(route.api, catalog?.api === route.api ? catalog.compat : undefined),
    }],
    streamSimple: (entry, context, streamOptions) => safeProviderStream(route.api === "anthropic-messages" ? "anthropic" : "openai", entry, context, streamOptions, undefined, options.fetch, options.onUsage, undefined, requestKey, { api: route.api, identity }),
  });
  try { await runtime.setRuntimeApiKey(ROUTE_PROVIDER, initialKey); }
  catch { throw agentXError("RUNTIME_UNAVAILABLE", "the model proxy key could not be initialized"); }
  return runtime;
}

/** The request a routed model gets: the shared rules of requestCompat, and no session-affinity header for a company's endpoint. */
function routeCompat(api: InvocationModelRoute["api"], compat: unknown) {
  if (api === "anthropic-messages") return requestCompat("anthropic", compat);
  if (api === "openai-responses") return requestCompat("openai", compat);
  return { ...(compat as OpenAICompletionsCompat | undefined), sendSessionAffinityHeaders: false, supportsMidConvoSystemMessages: false };
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

function safeProviderStream(provider: KeyedModelProvider, model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions | undefined, routing: Record<string, unknown> | undefined, transport: typeof fetch = fetch, onUsage = (record: Record<string, unknown>) => console.info(JSON.stringify(record)), plan?: ChatGptPlan, proxyKey?: () => Promise<string>,
  /** A routed model (Task 27): its API, which picks the client, and the catalog identity its usage is reported under. */
  route?: { api: InvocationModelRoute["api"]; identity: ModelIdentifier }) {
  const output = createAssistantMessageEventStream();
  const chatgpt = plan !== undefined;
  let failureStatus: number | undefined;
  // Set when the proxy answered 422 budget_exceeded. The response is returned to Pi untouched rather than thrown: the
  // Anthropic client retries a thrown fetch error but never a 422, and Pi then reports an error, which safeError words.
  let exhausted: ModelBudgetScope | undefined;
  let refusal: ChatGptFallbackReason | undefined;
  // Set when the model proxy answered 403 because Amazon Bedrock refused the model for this account (not a key or permission problem): the error then says so in its own fixed words.
  let notEnabled = false;
  let returnedModel: string | undefined;
  let returnedProvider: string | undefined;
  const observedFetch: typeof fetch = async (input, init) => {
    const response = await transport(input, init);
    if (!response.ok) failureStatus = response.status;
    // The proxy's body is read for a 422 only (never a stream), classified and dropped.
    if (response.status === 422) exhausted = budgetScopeOfProxyBody(422, (await response.clone().text().catch(() => "")).slice(0, 65_536)) ?? exhausted;
    // A ChatGPT refusal is told apart by its body, which is read here and never kept, logged or shown.
    if (!response.ok && plan?.fallback !== undefined) refusal = chatGptRefusal(response.status, (await response.clone().text().catch(() => "")).slice(0, 65_536));
    // DR-KEY-1 (B): the model proxy's 403 body is read (matched, never kept) to tell a model the account cannot use from a refused key.
    if (response.status === 403 && proxyKey !== undefined && plan === undefined) notEnabled = modelNotEnabledBody((await response.clone().text().catch(() => "")).slice(0, 65_536)) || notEnabled;
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
      let authorization = fallbackAuthorizations.get(fallback);
      if (authorization === undefined) {
        authorization = (async () => {
          await fallback.authorize?.(reason);
          fallback.reason = reason;
          try { fallback.onFallback(reason); } catch { /* Reporting must not fail the request it is about. */ }
        })();
        fallbackAuthorizations.set(fallback, authorization);
      }
      try { await authorization; } catch (error) {
        if (fallbackAuthorizations.get(fallback) === authorization) fallbackAuthorizations.delete(fallback);
        throw error;
      }
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
      // A proxy key is asked for each time too: it is minted for an hour, and a task can run longer.
      if (proxyKey !== undefined) key = { apiKey: await proxyKey() };
      // ChatGPT requests are not retried here: a plan's limit does not lift in seconds, and the fallback is ready.
      const upstreamOptions = { ...options, ...key, ...(plan === undefined ? {} : { maxRetries: 0 }), fetch: observedFetch };
      const upstream = route?.api === "openai-completions" ? openAICompletionsStream(model as Model<"openai-completions">, context, upstreamOptions)
        : upstreamStream(provider, model, context, upstreamOptions, routing);
      let started = false;
      for await (const event of upstream) {
        // Pi's first event comes only once OpenAI accepted the request, so an error first means nothing reached Pi yet.
        if (!started && event.type === "error" && refusal !== undefined && plan?.fallback !== undefined && event.reason !== "aborted") {
          return await fallBack(plan.fallback, refusal);
        }
        started = true;
        if (event.type === "error") event.error.errorMessage = safeError(provider, event.reason === "aborted", failureStatus, chatgpt, exhausted, route !== undefined, notEnabled);
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          // Pi retains the response in the transcript. This record also identifies the serving model
          // and, through OpenRouter, the upstream provider, without treating catalog prices as billed cost.
          const priced = message.usage.cost.total > 0;
          const reported = route === undefined ? { provider, modelId: model.id } : route.identity;
          try { onUsage({ event: "model_request_usage", provider: reported.provider, requestedModel: reported.modelId,
            returnedModel: returnedModel ?? null, returnedProvider: returnedProvider ?? null,
            tokens: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite },
            costUsd: priced ? message.usage.cost.total : null,
            costSource: !priced ? "unknown" : reported.provider === "openrouter" ? "estimated" : "list-price", outcome: message.stopReason,
          }); } catch { /* Telemetry must not turn a completed model response into a failed turn. */ }
        }
        output.push(event);
      }
      output.end(await upstream.result());
    } catch (error) {
      const aborted = options?.signal?.aborted === true;
      const message: AssistantMessage = { role: "assistant", api: model.api, provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: aborted ? "aborted" : "error", errorMessage: error instanceof ModelNotAllowedError && !aborted ? modelNotAllowedMarker(error.text) : safeError(provider, aborted, failureStatus, chatgpt, exhausted ?? (error instanceof ModelBudgetExhaustedError ? error.scope : undefined), route !== undefined, notEnabled),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      output.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      output.end(message);
    }
  })();
  return output;
}

/**
 * A model the ACCOUNT may not use (its access, agreement or entitlement is not in place, e.g. a cross-region profile reaching a region the account is not entitled in), as the model proxy passes Amazon Bedrock's refusal on in
 * its 403 body: the error CLASS (LiteLLM's PermissionDeniedError, Bedrock's AccessDeniedException) and the shape of Bedrock's words for an unentitled model. A refused key or a missing IAM permission has another class or other
 * words ("is not authorized to perform", "invalid api key") and stays a refused key.
 */
const MODEL_NOT_ENABLED_CLASS = /\b(?:PermissionDeniedError|AccessDeniedException)\b/u;
const MODEL_NOT_ENABLED_SHAPE = [
  /\bis not available for this account\b/iu,
  /\byou don't have access to the model with the specified model id\b/iu,
  /\bmodel use case details have not been submitted for this account\b/iu,
];
/** Whether a proxy 403 body says the account cannot use the model. Only matched; nothing of the body is kept. */
export function modelNotEnabledBody(body: string): boolean {
  return MODEL_NOT_ENABLED_CLASS.test(body) && MODEL_NOT_ENABLED_SHAPE.some((pattern) => pattern.test(body));
}

/** The fixed sentence for a model the account cannot use (the worker reads it as `key-rejected ModelNotEnabled`, which the broker learns from). */
export const MODEL_NOT_ENABLED_DETAIL = "the model is not available for this account";

/** A diagnostic chosen from the HTTP status alone, so provider error bodies (which can echo prompts) never surface. */
function safeError(provider: KeyedModelProvider, aborted: boolean, status?: number, chatgpt = false, exhausted?: ModelBudgetScope, routed = false, notEnabled = false): string {
  // A routed model is a company's source, whichever API it speaks: it is not named after a provider it may not be.
  const label = routed ? "Model source" : KEYED_MODEL_PROVIDERS[provider].label;
  if (aborted) return `${label} request cancelled`;
  // The proxy's budget refusal: the worker ends the task on this text (see budgetExhaustedFromMarker).
  if (exhausted !== undefined) return budgetExhaustedMarker(exhausted);
  // A ChatGPT plan has no API key or credit balance: its refusals are the plan's.
  if (chatgpt && (status === 401 || status === 403)) return "ChatGPT request failed; the ChatGPT connection was refused, so connect ChatGPT again";
  if (chatgpt && status === 429) return "ChatGPT request failed; your ChatGPT plan's usage limit may be reached, see https://chatgpt.com/settings/usage";
  if (chatgpt && (status === 400 || status === 404)) return "ChatGPT request failed; your ChatGPT plan may not allow this model";
  // 401 is a key the provider does not accept (invalid, expired, not yet live); 403 is a key that may not use this model or call. Told apart so a person can be sent to the right place (QA6-14).
  // A 403 that Bedrock words as unentitled is MODEL_NOT_ENABLED (DR-KEY-1).
  const detail = status === 403 && notEnabled ? MODEL_NOT_ENABLED_DETAIL
    : status === 401 ? "the API key was refused; check that it is valid and has not expired"
    : status === 403 ? "check the API key and its permissions"
    : status === 402 ? "check the key's credit balance and spending limit"
    : status === 404 ? (provider === "openrouter" ? "check model availability and the provider allowlist" : "check the model ID and that the key's organization can use it")
    : status === 429 ? (provider === "openrouter" ? "rate limited; wait before retrying" : "rate limited or out of credits; check the key's usage limits before retrying")
    : status === 529 ? "the provider is overloaded; wait before retrying"
    : status !== undefined && status >= 500 ? "upstream unavailable; check provider status before retrying"
    : status === 400 || status === 413 ? "the request was refused; check the model's context and output limits"
    : "check credentials, model availability, rate limits and provider status";
  return `${label} request failed; ${detail}`;
}
