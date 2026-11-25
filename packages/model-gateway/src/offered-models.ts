// "Agents pick models" (DEC 243c, DEC 236j): which models one company's agents may use. Rovara Code reads this list for the company's
// page (it offers exactly these models and refuses any other), so it must be what the agent route accepts for that company on its very
// next call. The shape is Code's OfferedAgentModels (contracts/shared/offered-agent-models.v1.json):
//
//   GET /v1/service/companies/<companyId>/offered-models   ->   { "version": 1, "models": [ { "model": "<name>" }, ... ] }
//
// Authentication: a service token the Code install's broker signs with its TASK key, so this route trusts exactly what the agent route
// trusts (the pinned issuer, the pinned task key ids, the JWKS the install publishes) and nothing else: no new key, no new secret. It is
// a different token from a task token on purpose: header typ `rovara-service+jwt`, audience `rovara-model-gateway-offered-models`, exactly
// the claims iss/aud/jti/iat/nbf/exp/cid, at most SERVICE_TOKEN_SECONDS of life, so a task token never opens this route and this token
// never opens the agent route. (The vertex-check HMAC is Cloud's own KMS key: only Cloud's settings role may sign with it, and Code's
// broker has no such right, so it is not an option for Code.)
//
// DEC 254zzz84(4): with the company's saved fallback order, the list is the models of every usable source of that order, in order, each once (the agent
// route admits the first source that serves the call's model); without one, exactly the first choice's list as before.
//
// Company isolation: the company is the token's `cid`, the path must name the same company (anything else is refused as an unsigned call,
// so a caller that builds company A's address with company B's token learns nothing), and every read below is for that one company. The
// source row's own companyId is checked again by CompanyAgentAiSource.
//
// Every failure is a fixed answer: nothing from the request, a token or the store is echoed or logged.
import { openRouterCapOrder, openRouterRates, openRouterPolicy, REVIEWED_OPENROUTER_POLICIES, type OpenRouterPolicy, type OpenRouterTariff } from "./openrouter-policy.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { agentSourceSwitchedOn, resolveAgentSource, type AgentAiSource, type AgentAiSourceReader, type ByoBedrock } from "./agent-ai.js";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import type { LearningKeySource } from "./learning-route.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import { serviceCallLimiter } from "./service-call.js";
import type { SignedTokenKind } from "./token.js";
import { validPrice, type PriceSource } from "./price.js";

export const SERVICE_TOKEN_TYPE = "rovara-service+jwt";
export const SERVICE_TOKEN_AUDIENCE = "rovara-model-gateway-offered-models";
export const SERVICE_TOKEN_SECONDS = 60;
export const SERVICE_TOKEN_CLAIMS = ["iss", "aud", "jti", "iat", "nbf", "exp", "cid"] as const;
export const OFFERED_MODELS_PATH = /^\/v1\/service\/companies\/(org_[0-9a-z]{20})\/offered-models$/u;
/** Code's AGENT_MODEL_NAME and OFFERED_AGENT_MODELS_MAX (packages/contracts/src/agent-model-choice.ts). */
export const OFFERED_MODEL_NAME = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,127}|[a-z0-9][a-z0-9._-]{0,62}\/[a-z0-9][a-z0-9._-]{0,62})$/u;
export const OFFERED_MODELS_MAX = 64;
/** At most this many checks at once and started per minute, per serving task, before any key fetch (the path is on the public load balancer). */
export const OFFERED_MODELS_OPEN = 8;
export const OFFERED_MODELS_PER_MINUTE = 600;

export interface ServiceClaims { iss: string; aud: typeof SERVICE_TOKEN_AUDIENCE; jti: string; iat: number; nbf: number; exp: number; cid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function parseServiceClaims(value: unknown): ServiceClaims | undefined {
  const c = record(value);
  if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((name) => Object.hasOwn(c, name))) return undefined;
  if (typeof c.iss !== "string" || c.iss.length === 0 || c.iss.length > 2048 || c.aud !== SERVICE_TOKEN_AUDIENCE) return undefined;
  if (typeof c.jti !== "string" || !UUID.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
  if (typeof c.cid !== "string" || !COMPANY.test(c.cid)) return undefined;
  return c as unknown as ServiceClaims;
}
export const SERVICE_TOKEN_KIND: SignedTokenKind<ServiceClaims> = { typ: SERVICE_TOKEN_TYPE, parse: parseServiceClaims, maxSeconds: SERVICE_TOKEN_SECONDS };

/**
 * Anthropic's own models, named as Anthropic's API names them (the engine names Code's catalog uses): what a company that connected its
 * own Anthropic key (or saved no choice: company-key mode) may use. One name per model. A contract test holds these equal to the
 * Claude names of ROVARA_AI_US_MODELS (one per model).
 */
export const ANTHROPIC_KEY_AGENT_MODELS: readonly string[] = Object.freeze(["claude-haiku-4-5", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]);
/**
 * Models Rovara's AI lists but whose Bedrock access the account has not enabled yet (the one-time Marketplace enable, 2026-11-16): a call
 * answers model_not_enabled, so none is offered until the operator enables it and removes it from GATEWAY_AGENT_MODELS_DISABLED. They
 * are only the default: that variable, when set (even empty), replaces this list. Only Rovara's AI is affected (Bedrock's account state);
 * a company's own Anthropic key never answers model_not_enabled.
 */
export const AGENT_MODELS_DISABLED_DEFAULT: readonly string[] = Object.freeze(["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-2"]);

/** GATEWAY_AGENT_MODELS_DISABLED: model names, comma-separated; empty means none; absent means the default list. Throws on anything else. */
export function parseDisabledAgentModels(value: string | undefined): ReadonlySet<string> {
  if (value === undefined) return new Set(AGENT_MODELS_DISABLED_DEFAULT);
  if (value.trim() === "") return new Set();
  const names = value.split(",").map((name) => name.trim());
  if (names.length > OFFERED_MODELS_MAX || names.some((name) => !OFFERED_MODEL_NAME.test(name)) || new Set(names).size !== names.length) throw new Error("invalid disabled agent models");
  return new Set(names);
}

export type OfferedModelsOutcome = { ok: true; models: string[] } | { ok: false; status: number; code: string; message: string };
const refusal = (status: number, code: string, message: string): OfferedModelsOutcome => ({ ok: false, status, code, message });
export const OFFERED_BYO_OFF = refusal(403, "no_ai_key", "Choose AI for your agents: your own Bedrock is not available on this install.");
export const OFFERED_BYO_NOT_CONNECTED = refusal(403, "no_ai_key", "Connect your Bedrock: this company chose its own Bedrock for its agents, and no AWS role is connected.");
export const OFFERED_ROVARA_OFF = refusal(403, "no_ai_key", "Choose AI for your agents: Rovara's AI is not available on this install.");
export const OFFERED_EMPTY = refusal(503, "unavailable", "No models are available for your agents right now.");
/** DEC 254t: the company chose a source this install has not switched on, or does not offer (the agent route's AGENT_SOURCE_SWITCHED_OFF / AGENT_CHAT_NOT_OFFERED). */
export const OFFERED_SWITCHED_OFF = refusal(403, "no_ai_key", "Choose AI for your agents: the AI source your company chose is not switched on for this install.");
export const OFFERED_CHAT_OFF = refusal(403, "no_ai_key", "Choose AI for your agents: the AI source your company chose is not available on this install.");
/**
 * DEC 254t (A2): OpenRouter names its models `vendor/model`, and Code's offered-models contract (OFFERED_MODEL_NAME, Code's
 * AGENT_MODEL_NAME) has no "/" yet, so no OpenRouter model can be offered until Code accepts that shape. Fixed words, never a guessed rename.
 */
export const OFFERED_OPENROUTER_PENDING = refusal(503, "unavailable", "Your agents can't pick OpenRouter models on this Rovara Code yet.");
/**
 * DEC 254t (A2): the OpenAI models a company on its own OpenAI key may use (OpenAI's API names). Owner to confirm the list before the kind
 * is switched on; each must have passed the real-key check's tool call.
 */
export const OPENAI_KEY_AGENT_MODELS: readonly string[] = Object.freeze(["gpt-5", "gpt-5-mini", "gpt-5-codex"]);

/**
 * What the agent route accepts for a company with this source, now. rovara: every name the gateway's allow-list calls (one name per
 * Bedrock id; a dated alias of the same profile is not a second model), minus the disabled ones. anthropic_key, or nothing saved:
 * Anthropic's models. bedrock_byo: see offeredByoModels. Never empty (a refusal), never more than OFFERED_MODELS_MAX, never a name the
 * contract's pattern rejects.
 */
export function offeredModelsFor(source: AgentAiSource | undefined, rovara: { models: ReadonlyMap<string, string> } | undefined, disabled: ReadonlySet<string>): OfferedModelsOutcome {
  let names: string[];
  // bedrock_byo is answered from the company's own connection (offeredByoModels), never here.
  if (source === "bedrock_byo") return OFFERED_BYO_OFF;
  if (source === "openrouter_key") return OFFERED_OPENROUTER_PENDING;
  if (source === "custom_endpoint") return OFFERED_CHAT_OFF;
  if (source === "rovara") {
    if (rovara === undefined) return OFFERED_ROVARA_OFF;
    const seen = new Set<string>();
    names = [];
    for (const [name, id] of rovara.models) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!disabled.has(name)) names.push(name);
    }
  } else if (source === "openai_key") names = [...OPENAI_KEY_AGENT_MODELS];
  else names = [...ANTHROPIC_KEY_AGENT_MODELS];
  names = names.filter((name) => OFFERED_MODEL_NAME.test(name)).slice(0, OFFERED_MODELS_MAX);
  return names.length === 0 ? OFFERED_EMPTY : { ok: true, models: names };
}

export const OFFERED_ENDPOINT_NOT_CONNECTED = refusal(403, "no_ai_key", "Connect your endpoint: this company chose its own endpoint for its agents, and none is connected.");
/** DEC 254t (A3): the company's own endpoint offers exactly the names it registered (those Code's name shape accepts). */
export async function offeredEndpointModels(read: OfferedModelsHandlerOptions["endpointModels"], iss: string, cid: string): Promise<OfferedModelsOutcome> {
  if (read === undefined) return OFFERED_CHAT_OFF;
  const names = await read(iss, cid);
  if (names === undefined) return OFFERED_ENDPOINT_NOT_CONNECTED;
  const offered = names.filter((name) => OFFERED_MODEL_NAME.test(name)).slice(0, OFFERED_MODELS_MAX);
  return offered.length === 0 ? OFFERED_EMPTY : { ok: true, models: offered };
}

/**
 * DEC 238, slice 1: the models the agent route accepts for a company on its own Bedrock are exactly the names of that company's own
 * connection (`models`: agent model name to the Bedrock Claude id or profile it picked), and only Claude ids are sent (server.ts guard).
 * The connection is read for the verified token's install and company only. The disabled list does not apply (it is Rovara's account).
 */
export async function offeredByoModels(byo: Pick<ByoBedrock, "connection"> | undefined, iss: string, cid: string): Promise<OfferedModelsOutcome> {
  if (byo === undefined) return OFFERED_BYO_OFF;
  const found = await byo.connection(iss, cid);
  if (found === undefined) return OFFERED_BYO_NOT_CONNECTED;
  const names = Object.entries(found.connection.models).filter(([name, id]) => BEDROCK_CLAUDE_ID.test(id) && OFFERED_MODEL_NAME.test(name)).map(([name]) => name).slice(0, OFFERED_MODELS_MAX);
  return names.length === 0 ? OFFERED_EMPTY : { ok: true, models: names };
}

/**
 * DEC 254zzz41 (L4-GW6): the provider a model is attributed to when Code looks for a SECOND reviewer from another provider. Rovara's AI serves many
 * vendors through one account, so a model's provider is its vendor (a Claude name is anthropic; a Bedrock id's leading vendor, after any geography
 * prefix); every other source is ONE connection, so all its models are that one provider (the company pays through that one source only).
 */
export const BEDROCK_VENDOR_ALIASES: Readonly<Record<string, string>> = Object.freeze({ moonshotai: "moonshot" });
export function reviewerProviderOf(source: AgentAiSource | undefined, model: string): string | undefined {
  let provider: string | undefined;
  if (source === "openai_key") provider = "openai";
  else if (source === "bedrock_byo") provider = "bedrock";
  else if (source === "custom_endpoint") provider = "endpoint";
  else if (source === undefined || source === "anthropic_key") provider = "anthropic";
  else if (source === "rovara") {
    if (model.startsWith("claude-")) provider = "anthropic";
    else {
      const vendor = model.replace(/^(?:us|eu|apac|jp|au|ca)\./u, "").split(".", 1)[0] ?? "";
      provider = BEDROCK_VENDOR_ALIASES[vendor] ?? vendor;
    }
  }
  return provider !== undefined && /^[a-z][a-z0-9-]{0,63}$/u.test(provider) ? provider : undefined;
}
/** Code's OfferedAgentModels.reviewerAccess: a company-bound attestation of what the company's REAL connections serve now, and its company limit. */
export interface ReviewerAccess { companyId: string; companyLimitUsd: number; models: Array<{ model: string; provider: string }> }
export interface ReviewerAccessOptions {
  /** Whether the company's own account of this provider is connected now (the same store the agent route admits on). Absent: no reviewer access. */
  keys: Pick<LearningKeySource, "connected">;
  /** The company limit in micro-dollars the reviews share with the task's main AI (its room now), or undefined when none can be read. */
  companyLimitMicros(iss: string, cid: string): Promise<number | undefined>;
}
/**
 * Only from the SAME resolved source the agent route admits this company's next call on, and only while that source is really connected: an own-key
 * source needs its key connected now, Rovara's AI needs the install to serve it, own Bedrock and own endpoint were just read as connected. Anything
 * else (a failed read, no limit, a limit of zero) is no reviewer access, never a guess.
 */
export async function reviewerAccessFor(options: ReviewerAccessOptions, source: AgentAiSource | undefined, iss: string, cid: string, models: readonly string[]): Promise<ReviewerAccess | undefined> {
  try {
    if (source === "openai_key" ? (await options.keys.connected(iss, cid, "openai")) !== true : (source === undefined || source === "anthropic_key") && (await options.keys.connected(iss, cid, "anthropic")) !== true) return undefined;
    const micros = await options.companyLimitMicros(iss, cid);
    if (micros === undefined || !Number.isSafeInteger(micros) || micros <= 0) return undefined;
    const listed: Array<{ model: string; provider: string }> = [];
    for (const model of models) { const provider = reviewerProviderOf(source, model); if (provider !== undefined) listed.push({ model, provider }); }
    return listed.length === 0 ? undefined : { companyId: cid, companyLimitUsd: Math.min(1_000_000, micros / 1_000_000), models: listed };
  } catch { return undefined; }
}

export interface OfferedModelsHandlerOptions {
  openRouterTariffs?: readonly OpenRouterTariff[];
  /** createSignedTokenVerifier(..., SERVICE_TOKEN_KIND) over this gateway's one install. */
  verify: (token: unknown) => Promise<ServiceClaims | undefined>;
  sources: AgentAiSourceReader;
  /** The agent route's Rovara's AI allow-list, when configured, and (DEC 254zzz3(1)) its exempt companies: an exempt company with no saved choice is offered what the agent route's default serves it. */
  rovara?: { models: ReadonlyMap<string, string>; exempt?: ReadonlySet<string> };
  /** The company key source the agent route reads (needed for the default above; without it no company is defaulted). */
  keys?: Pick<LearningKeySource, "connected" | "bedrockConnected"> & { identityFor?(iss: string, cid: string, provider: "openrouter"): Promise<{ sourceId: string; versionId: string } | undefined> };
  disabled: ReadonlySet<string>;
  /** The company's own Bedrock (DEC 238), when this gateway has it built (as the agent route's `agentAi.byo`). Absent: bedrock_byo is refused. */
  byo?: Pick<ByoBedrock, "connection">;
  /** DEC 254t: the switched-on kinds (as the agent route's `agentAi.switchedOn`). Absent: none. */
  switchedOn?: ReadonlySet<string>;
  /** DEC 254t (A2): which own-key Chat Completions sources this gateway has built (as the agent route's `agentAi.openai` / `.openrouter`). */
  chat?: { openai?: boolean; openrouter?: boolean };
  /** DEC 254t (A3): the names a company registered for its own endpoint (its sealed account; undefined when none). Absent: custom_endpoint is refused. */
  endpointModels?: (iss: string, cid: string) => Promise<readonly string[] | undefined>;
  /**
   * DEC 254zzz96 (2): set (GATEWAY_OFFERED_PRICES=on), each model carries its list price where the price snapshot knows it, for the company's step models
   * card only: `price: { inputUsdPerMillion, outputUsdPerMillion }`. Display only: a price that can't be read is left out, never a refusal. Absent: the
   * answer is exactly as before (Code accepts the field only from the release that added it, so it stays off until that release is installed).
   */
  priceOf?: (model: string, source: AgentAiSource | undefined) => Promise<OfferedModelPrice | undefined>;
  /** DEC 254zzz41: set, the answer also carries `reviewerAccess` (above). Absent: the answer is exactly as before and no review can run. */
  reviewer?: ReviewerAccessOptions;
  now?: () => number;
}

/** Never asked: without a key source no company is defaulted (resolveAgentSource reads keys only for an exempt company). */
const NO_KEYS: Pick<LearningKeySource, "connected"> = { connected: async () => false };
const ANSWERS = {
  busy: { status: 429, body: { error: { type: "busy", message: "too many service calls; try again later" } } },
  notFound: { status: 404, body: { error: { type: "not_found", message: "not found" } } },
  notAllowed: { status: 405, body: { error: { type: "not_found", message: "not found" } } },
  refused: { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } },
  unavailable: { status: 503, body: { error: { type: "unavailable", message: "model access unavailable" } } },
} as const;

/** The answer to one request: status and JSON body. Exported for tests; the server writes it. */
export async function answerOfferedModels(options: OfferedModelsHandlerOptions, request: { method: string; url: string; headers: Readonly<Record<string, string | string[] | undefined>> }): Promise<{ status: number; body: unknown }> {
  const target = OFFERED_MODELS_PATH.exec(request.url);
  if (target === null) return ANSWERS.notFound;
  if (request.method !== "GET") return ANSWERS.notAllowed;
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return ANSWERS.refused;
  const claims = await options.verify(auth.slice(7));
  // The token's company is THE company; a path naming another company is an unsigned call (nothing about either company is said).
  if (claims === undefined || claims.cid !== target[1]) return ANSWERS.refused;
  // The same resolution as the agent route's admission (agent-ai.ts resolveAgentSource), so the list is what its very next call accepts.
  let resolved: Awaited<ReturnType<typeof resolveAgentSource>>;
  try {
    resolved = await resolveAgentSource({ sources: options.sources, ...(options.rovara?.exempt === undefined || options.keys === undefined ? {} : { exempt: options.rovara.exempt }), keys: options.keys ?? NO_KEYS, ...(options.byo === undefined ? {} : { byo: options.byo }) }, claims.iss, claims.cid);
  } catch { return ANSWERS.unavailable; }
  // DEC 254zzz84(4): with a saved fallback, every usable source of the company's order in turn (the agent route admits the first that serves the call's model),
  // its models in order, each once. Without one, the first choice alone, exactly as before. A read that fails anywhere is the fixed 503 (never a partial list).
  const order: Array<AgentAiSource | undefined> = [resolved.source, ...(resolved.fallback ?? [])];
  const served: Array<{ source: AgentAiSource | undefined; models: string[] }> = [];
  let first: OfferedModelsOutcome | undefined;
  try {
    for (const source of order) {
      // With a fallback, an own-key source counts only while its key is connected now (the agent route passes it over otherwise): never offer what the next call refuses.
      if (order.length > 1 && !(await ownKeyConnected(options, source, claims.iss, claims.cid))) { first ??= OFFERED_KEY_NOT_CONNECTED; continue; }
      const outcome = await offeredForSource(options, source, claims.iss, claims.cid);
      first ??= outcome;
      if (outcome.ok) served.push({ source, models: outcome.models });
    }
  } catch { return ANSWERS.unavailable; }
  if (order.length === 1 || served.length === 0) {
    const outcome = first!;
    if (!outcome.ok) return { status: outcome.status, body: { error: { type: outcome.code, message: outcome.message } } };
  }
  const models: string[] = [];
  const seen = new Set<string>();
  const access: ReviewerAccess[] = [];
  for (const { source, models: names } of served) {
    const added = names.filter((name) => { if (seen.has(name) || seen.size >= OFFERED_MODELS_MAX) return false; seen.add(name); return true; });
    models.push(...added);
    if (options.reviewer !== undefined && added.length > 0) { const one = await reviewerAccessFor(options.reviewer, source, claims.iss, claims.cid, added); if (one !== undefined) access.push(one); }
  }
  const reviewerAccess = access.length === 0 ? undefined : { companyId: claims.cid, companyLimitUsd: access[0]!.companyLimitUsd, models: access.flatMap((one) => one.models) };
  // The source each model is served from: the first in the order that lists it (the one the agent route admits a call on), so its price is that source's.
  const servedBy = new Map<string, AgentAiSource | undefined>();
  for (const { source, models: names } of served) for (const name of names) if (!servedBy.has(name)) servedBy.set(name, source);
  const entries = options.priceOf === undefined ? models.map((model) => ({ model })) : await Promise.all(models.map(async (model) => {
    let price: OfferedModelPrice | undefined;
    try { price = await options.priceOf!(model, servedBy.get(model)); } catch { price = undefined; }
    return price === undefined || !offeredPrice(price) ? { model } : { model, price: { inputUsdPerMillion: price.inputUsdPerMillion, outputUsdPerMillion: price.outputUsdPerMillion } };
  }));
  const identities = await Promise.all(entries.map(async entry => {
    if (servedBy.get(entry.model) !== "openrouter_key") return entry;
    const identity = await options.keys?.identityFor?.(claims.iss, claims.cid, "openrouter");
    if (identity === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(identity.sourceId) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(identity.versionId)) throw new Error("connection unavailable");
    const policy = openRouterPolicy(entry.model, (options.now ?? Date.now)(), options.openRouterTariffs);
    if (policy === undefined) throw new Error("price unavailable");
    return { ...entry, identity: { provider: "openrouter", sourceId: identity.sourceId, connectionRevision: identity.versionId, modelId: entry.model }, price: { inputUsdPerMillion: openRouterRates(policy).inputMicrosPerMTok / 1_000_000, outputUsdPerMillion: openRouterRates(policy).outputMicrosPerMTok / 1_000_000 } };
  })).catch(() => undefined);
  if (identities === undefined) return ANSWERS.unavailable;
  return { status: 200, body: { version: 1, models: identities, ...(reviewerAccess === undefined ? {} : { reviewerAccess }) } };
}

/** A model's list price in US dollars per million tokens (Code's OfferedModelPriceSchema: each 0 to OFFERED_PRICE_USD_MAX). */
export interface OfferedModelPrice { inputUsdPerMillion: number; outputUsdPerMillion: number }
/** Code's OFFERED_PRICE_USD_MAX (packages/contracts/src/agent-model-choice.ts). */
export const OFFERED_PRICE_USD_MAX = 10_000;
const usd = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= OFFERED_PRICE_USD_MAX;
const offeredPrice = (value: OfferedModelPrice): boolean => usd(value.inputUsdPerMillion) && usd(value.outputUsdPerMillion);
/**
 * The list price shown for an offered name, as the agent route meters the source that serves it (server.ts): the company's own Anthropic key (or company-key
 * mode) on Anthropic's row; Rovara's AI on the Bedrock row of the id it calls; the company's own OpenAI key on OpenAI's row. No price for its own Bedrock (metered
 * at the dearer of two rows), OpenRouter or its own endpoint (their own catalog rows): never a price that could understate. Only an exact snapshot row: undefined
 * when the snapshot has none, or the row waits for an operator's review (never shown as a plain list price).
 */
export async function offeredModelPrice(prices: Pick<PriceSource, "priceFor">, model: string, source: AgentAiSource | undefined, rovaraModels?: ReadonlyMap<string, string>): Promise<OfferedModelPrice | undefined> {
  let row: [string, string] | undefined;
  if (source === undefined || source === "anthropic_key") row = ["anthropic", model];
  else if (source === "openai_key") row = ["openai", model];
  else if (source === "rovara") { const id = rovaraModels?.get(model); row = id === undefined ? undefined : ["bedrock", id]; }
  if (row === undefined) return undefined;
  const price = await prices.priceFor(row[0], row[1]);
  if (price === undefined || !validPrice(price) || price.operatorReview === true) return undefined;
  return { inputUsdPerMillion: price.inputMicrosPerMTok / 1_000_000, outputUsdPerMillion: price.outputMicrosPerMTok / 1_000_000 };
}

const OFFERED_KEY_NOT_CONNECTED = refusal(403, "no_ai_key", "Connect an AI key: this company has no AI provider key connected, so its agents cannot call AI.");
const KEY_PROVIDER: Readonly<Partial<Record<AgentAiSource, "anthropic" | "openai" | "openrouter">>> = { anthropic_key: "anthropic", openai_key: "openai", openrouter_key: "openrouter" };
/** Whether a source's own key is connected now (true for a source without one). No key source on this gateway: not connected (never guessed). Throws on a failed read. */
async function ownKeyConnected(options: OfferedModelsHandlerOptions, source: AgentAiSource | undefined, iss: string, cid: string): Promise<boolean> {
  const provider = source === undefined ? undefined : KEY_PROVIDER[source];
  if (provider === undefined) return true;
  const keys = options.keys ?? options.reviewer?.keys;
  return keys !== undefined && (await keys.connected(iss, cid, provider)) === true;
}

/** The OpenRouter models offered now: the rows the gateway's validator accepts now, never more than OFFERED_MODELS_MAX. Over it (DEC 254zzz419) the best-known families
 * first, then the cheapest hold (openRouterCapOrder, the order the harness' install selection uses); at or under it the tariff's own order, unchanged. */
export function offeredOpenRouterModels(rows: readonly OpenRouterTariff[], now: number, tariffs?: readonly OpenRouterTariff[]): string[] {
  const policies = rows.map((row) => openRouterPolicy(row.model, now, tariffs)).filter((policy): policy is OpenRouterPolicy => policy !== undefined);
  return openRouterCapOrder(policies, OFFERED_MODELS_MAX).kept.map((policy) => policy.model);
}

/** What one source offers the company now (the agent route's order of checks: the switch first, then whether this gateway serves the source at all). Throws on a failed read. */
async function offeredForSource(options: OfferedModelsHandlerOptions, source: AgentAiSource | undefined, iss: string, cid: string): Promise<OfferedModelsOutcome> {
  if (source !== undefined && !agentSourceSwitchedOn(source, options.switchedOn ?? new Set())) return OFFERED_SWITCHED_OFF;
  if ((source === "openai_key" && options.chat?.openai !== true) || (source === "openrouter_key" && options.chat?.openrouter !== true)) return OFFERED_CHAT_OFF;
  if (source === "openrouter_key") {
    const models = offeredOpenRouterModels(options.openRouterTariffs ?? REVIEWED_OPENROUTER_POLICIES, (options.now ?? Date.now)(), options.openRouterTariffs);
    return models.length === 0 ? OFFERED_EMPTY : { ok: true, models };
  }
  if (source === "custom_endpoint") return offeredEndpointModels(options.endpointModels, iss, cid);
  return source === "bedrock_byo" ? offeredByoModels(options.byo, iss, cid) : offeredModelsFor(source, options.rovara, options.disabled);
}

/** The HTTP handler the serving process mounts for OFFERED_MODELS_PATH (process.ts), only in company-key mode. */
export function createOfferedModelsHandler(options: OfferedModelsHandlerOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limit = serviceCallLimiter(options.now ?? Date.now, OFFERED_MODELS_OPEN, OFFERED_MODELS_PER_MINUTE);
  return async (req, res) => {
    const release = limit.take();
    try {
      // A GET carries no body worth reading; it is dropped unread.
      req.resume();
      const url = req.url ?? "";
      const answer = release === undefined ? ANSWERS.busy : await answerOfferedModels(options, { method: req.method ?? "", url, headers: req.headers });
      if (res.headersSent || res.destroyed) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(answer.body));
    } finally { release?.(); }
  };
}
