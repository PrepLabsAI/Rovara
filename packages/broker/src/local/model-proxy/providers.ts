// Port lane L9a, K1: where each provider is called, the request fields the proxy forwards, and the headers it sets.
//
// Mirrors Cloud's proxy guard (`rovara_guard.py` in packages/model-proxy, which Code does not carry because it is Python): a per-route allow-list of
// request fields (anything else is refused, fallbacks and credential-bearing names included), a refusal of billing and proxy-control headers, an
// allow-list for `anthropic-beta`, and no following of redirects. The allow-lists are Cloud's, field for field.
import type { InvocationModelRoute, ModelProviderAdapter, ModelProviderFormat } from "@agentx/contracts";
import { BUILTIN_MODEL_PROVIDERS } from "../../plugins/model-provider/builtin.js";
import type { ProxyApi, ProxyProvider, ProxyRoute } from "./types.js";

/** Where each provider is, by provider id. Set by the owner's own code (tests point them at a fake), never by a request. A provider with no entry is at its `address`. */
export type ProviderEndpoints = Readonly<Record<string, string>>;

/** The built-in providers' addresses (their `model-provider` rows hold them; this is the same table for callers that only need the address). */
export const DEFAULT_PROVIDER_ENDPOINTS: ProviderEndpoints = Object.fromEntries(BUILTIN_MODEL_PROVIDERS.map((provider) => [provider.kind, provider.address]));

/** The path on the provider for each wire shape, unless the provider's format entry overrides it. */
const UPSTREAM_PATH: Record<ProxyApi, string> = {
  "anthropic-messages": "/v1/messages",
  "openai-responses": "/v1/responses",
  "openai-completions": "/v1/chat/completions",
};

/** The path on this proxy (after its prefix) for each wire shape: the paths the worker's model library appends to the proxy's address. */
export const PROXY_PATH_API: Readonly<Record<string, ProxyApi>> = {
  "/v1/messages": "anthropic-messages",
  "/v1/responses": "openai-responses",
  "/v1/chat/completions": "openai-completions",
};

/** The request format a built-in provider speaks (its first format), for callers that name a built-in only. */
function builtinFormat(provider: ProxyProvider): ProxyApi | undefined {
  return BUILTIN_MODEL_PROVIDERS.find((entry) => entry.kind === provider)?.formats[0].format;
}

/**
 * The route for a model the owner chose: its proxy alias and the worker's route for it. `api` is the request format; absent, a built-in provider's own. Any other provider
 * must be given its format (the app takes it from the provider's row).
 */
export function localRoute(provider: ProxyProvider, model: string, api?: ProxyApi): { route: ProxyRoute; workerRoute: InvocationModelRoute } {
  const format = api ?? builtinFormat(provider);
  if (format === undefined) throw new Error(`the request format of model provider ${provider.slice(0, 40)} is not known; name it`);
  const alias = `${provider}/${model}`;
  return { route: { alias, provider, model, api: format }, workerRoute: { alias, api: format, catalog: model } };
}

/** What the proxy sends and where, for one call. */
export interface UpstreamTarget {
  url: string;
  /** `vertex`: the model is in the address and `anthropic_version` is in the body. */
  variant?: "vertex" | undefined;
}

/**
 * The address of a call, or undefined when the provider does not speak the route's format (a configuration mistake, not a request to forward). `address` replaces the
 * provider's own (tests, and the owner's own code).
 */
export function upstreamTarget(provider: ModelProviderAdapter, format: ModelProviderFormat, model: string, stream: boolean, address?: string): UpstreamTarget {
  const base = (address ?? provider.address).replace(/\/+$/u, "");
  if (format.variant === "vertex") return { url: `${base}/${encodeURIComponent(model)}:${stream ? "streamRawPredict" : "rawPredict"}`, variant: "vertex" };
  return { url: base + (format.pathOverride ?? UPSTREAM_PATH[format.format]) };
}

/** Compatibility for the built-in providers: where `api` is served, or undefined when the built-in does not speak it. */
export function upstreamUrl(endpoints: ProviderEndpoints, provider: ProxyProvider, api: ProxyApi): string | undefined {
  const row = BUILTIN_MODEL_PROVIDERS.find((entry) => entry.kind === provider);
  const format = row?.formats.find((entry) => entry.format === api);
  if (row === undefined || format === undefined) return undefined;
  return upstreamTarget(row, format, "", false, endpoints[provider]).url;
}

/** The request fields each wire shape may carry (Cloud's `ROUTE_FIELDS`). */
export const ROUTE_FIELDS: Readonly<Record<ProxyApi, ReadonlySet<string>>> = {
  "anthropic-messages": new Set(["model", "messages", "max_tokens", "stream", "system", "temperature", "thinking", "output_config", "tool_choice", "tools"]),
  "openai-responses": new Set(["model", "input", "stream", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "store", "max_output_tokens", "temperature", "reasoning", "include", "tool_choice", "tools"]),
  "openai-completions": new Set(["model", "messages", "stream", "stream_options", "store", "max_tokens", "max_completion_tokens", "temperature", "reasoning_effort", "reasoning", "thinking", "enable_thinking", "chat_template_kwargs", "tool_choice", "tools", "tool_stream", "provider", "prompt_cache_key", "prompt_cache_retention"]),
};

/** Fields that would turn one call into several or point it somewhere else; named so the refusal says what it found (Cloud's `FALLBACK_FIELDS` and `CREDENTIAL_NAMES`). */
export const FALLBACK_FIELDS = ["fallbacks", "context_window_fallbacks", "content_policy_fallbacks", "router_settings_override"] as const;

/** OpenRouter's routing options that stay allowed under `provider` (Cloud's `OPENROUTER_PROVIDER_KEYS`); `allow_fallbacks` must be false. */
export const OPENROUTER_PROVIDER_KEYS: ReadonlySet<string> = new Set(["allow_fallbacks", "require_parameters", "data_collection", "only", "order", "ignore", "sort", "zdr", "max_price", "quantizations"]);

export const BANNED_HEADERS: readonly string[] = ["openai-organization", "openai-project", "x-api-key-override"];
export const ALLOWED_BETAS: ReadonlySet<string> = new Set(["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"]);

export class RequestNotAllowed extends Error {
  constructor(readonly reason: string) {
    super(`request not allowed: ${reason}`);
    this.name = "RequestNotAllowed";
  }
}

/** Refuses a header the proxy never forwards or a value it does not allow; returns nothing. Header names are lower case. */
export function checkRequestHeaders(headers: Readonly<Record<string, string | undefined>>): void {
  for (const name of Object.keys(headers)) {
    if (name.startsWith("x-litellm-") || BANNED_HEADERS.includes(name)) throw new RequestNotAllowed(`header ${name.slice(0, 40)}`);
  }
  const beta = headers["anthropic-beta"];
  if (beta !== undefined && beta.split(",").some((value) => !ALLOWED_BETAS.has(value.trim()))) throw new RequestNotAllowed("header anthropic-beta value");
}

/** The request body to forward: the allowed fields only, or a refusal naming the first one that is not. */
export function checkRequestBody(api: ProxyApi, body: Record<string, unknown>): void {
  for (const name of FALLBACK_FIELDS) if (name in body) throw new RequestNotAllowed(name);
  const allowed = ROUTE_FIELDS[api];
  for (const name of Object.keys(body)) {
    if (name === "metadata" && api === "anthropic-messages") continue; // checked below
    if (!allowed.has(name)) throw new RequestNotAllowed(`field ${name.slice(0, 40)}`);
  }
  if ("metadata" in body) {
    const value = body.metadata;
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((name) => name !== "user_id")) throw new RequestNotAllowed("metadata");
  }
  checkTools(api, body.tools);
  checkNestedTools(api, body);
  if (api === "openai-responses") checkInclude(body.include);
  checkToolChoice(body.tool_choice);
  if (api === "openai-completions" && "provider" in body) {
    const provider = body.provider;
    if (provider === null || typeof provider !== "object" || Array.isArray(provider)
      || Object.keys(provider).some((name) => !OPENROUTER_PROVIDER_KEYS.has(name)) || (provider as Record<string, unknown>).allow_fallbacks !== false) {
      throw new RequestNotAllowed("provider routing (allow_fallbacks must be false)");
    }
  }
}

/**
 * The one tool type each route serves, field for field as Cloud's guard (`ROUTE_TOOL_TYPES` and `_check_tools` in packages/model-proxy rovara-guard.ts, fix/0512-guard-tool-types).
 * Anthropic: a client tool has no `type` or `custom`; every typed tool (web_search_*, web_fetch_*, code_execution_*, computer_*, bash_*, text_editor_*, mcp_toolset, ...) is run or defined by
 * the provider. OpenAI chat and Responses: `function` only (refuses mcp, web_search*, code_interpreter, file_search, image_generation, computer_use*, custom, ...). A provider-side tool
 * would fetch pages or run code from the provider's side of the network, around the egress allow-list, and bill per use outside the token counts the budget reads.
 */
const ROUTE_TOOL_TYPES: Readonly<Record<ProxyApi, readonly (string | undefined)[]>> = {
  "anthropic-messages": [undefined, "custom"],
  "openai-responses": ["function"],
  "openai-completions": ["function"],
};
const TOOL_CHOICE_TYPES: ReadonlySet<string> = new Set(["auto", "any", "none", "required", "tool", "function"]);

/** Python's name for a JSON value's type, as Cloud's refusal text shows it. */
function kindName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "dict";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return "str";
}

/** A place in the request as the refusal shows it: bounded, so a deeply nested body cannot make a long message. */
const at = (where: string): string => (where.length > 200 ? `${where.slice(0, 200)}...` : where);

function checkTools(api: ProxyApi, tools: unknown, where = "tools"): void {
  if (tools === undefined || tools === null) return;
  if (!Array.isArray(tools)) throw new RequestNotAllowed(`field ${at(where)} (must be a list of function tools)`);
  const allowed = ROUTE_TOOL_TYPES[api];
  tools.forEach((tool: unknown, index) => checkTool(allowed, tool, `${where}[${String(index)}]`));
}

function checkTool(allowed: readonly (string | undefined)[], tool: unknown, where: string): void {
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) throw new RequestNotAllowed(`${at(where)} is not a function tool`);
  // A missing type and a JSON null both read as "no type" in Cloud's guard (Python `None`).
  const raw = (tool as Record<string, unknown>).type;
  const kind = raw === null ? undefined : raw;
  if ((kind !== undefined && typeof kind !== "string") || !allowed.includes(kind)) {
    const shown = typeof kind === "string" ? kind.slice(0, 64) : kindName(raw);
    throw new RequestNotAllowed(`tool type '${shown}' at ${at(where)} (only function tools are served: provider-side tools such as web search, code execution, MCP, computer use and file search are refused)`);
  }
}

/** Blocks whose `input` is the model's own tool arguments (any JSON, which may hold a key named `tools`): not tool definitions, not walked. */
const ARGUMENT_BLOCKS: ReadonlySet<string> = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

/**
 * Tool definitions can also travel inside the conversation: Responses `input` items (`additional_tools`, `tool_search_output` carry a `tools` list) and Anthropic messages (a
 * `tool_addition` block carries a `tool_definition`). Walks `input`, `messages` and (Anthropic's) top-level `system`, and holds every such list or definition to the rule of the top-level tools (a definition to
 * Anthropic's). Iterative, so a deeply nested body cannot overflow the stack. Cloud's `_check_nested_tools`, case for case.
 */
function checkNestedTools(api: ProxyApi, body: Readonly<Record<string, unknown>>): void {
  for (const field of ["input", "messages", "system"]) {
    if (!(field in body)) continue;
    const stack: Array<[string, unknown]> = [[field, body[field]]];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const [where, value] = next;
      if (Array.isArray(value)) {
        value.forEach((item: unknown, index) => stack.push([`${where}[${String(index)}]`, item]));
      } else if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if ("tools" in record) checkTools(api, record.tools, `${where}.tools`);
        if (record.type === "tool_addition") {
          // A tool_addition holds a tool_definition and nothing else; its definition is checked when the walk reaches it.
          const tool = record.tool;
          const kind = tool !== null && typeof tool === "object" && !Array.isArray(tool) ? (tool as Record<string, unknown>).type : undefined;
          if (kind !== "tool_definition") throw new RequestNotAllowed(`${at(`${where}.tool`)} is not a tool_definition (a tool_addition may only add a function tool's definition)`);
        }
        if (record.type === "tool_definition") checkTool(ROUTE_TOOL_TYPES["anthropic-messages"], record.definition, `${where}.definition`);
        const skipInput = typeof record.type === "string" && ARGUMENT_BLOCKS.has(record.type);
        for (const [name, item] of Object.entries(record)) if (name !== "tools" && !(skipInput && name === "input")) stack.push([`${where}.${name}`, item]);
      }
    }
  }
}

/** The only value of a Responses `include` that is served: the others add the output of a hosted tool call. */
const RESPONSES_INCLUDE: ReadonlySet<string> = new Set(["reasoning.encrypted_content"]);
function checkInclude(include: unknown): void {
  if (include === undefined || include === null) return;
  if (!Array.isArray(include) || include.some((value: unknown) => typeof value !== "string" || !RESPONSES_INCLUDE.has(value))) throw new RequestNotAllowed("field include (only reasoning.encrypted_content is served)");
}

/** A tool_choice may name a function, never a provider-side tool type (Cloud's `_check_tool_choice`). */
function checkToolChoice(choice: unknown): void {
  if (choice === undefined || choice === null || typeof choice === "string") return;
  const kind = typeof choice === "object" && !Array.isArray(choice) ? (choice as Record<string, unknown>).type : undefined;
  if (typeof kind !== "string" || !TOOL_CHOICE_TYPES.has(kind)) {
    throw new RequestNotAllowed(`tool_choice type '${typeof kind === "string" ? kind.slice(0, 64) : "unknown"}' (only auto, any, none, required, tool and function are served)`);
  }
}
