// Signed company price read. No reservation or provider invocation; sealed endpoint metadata is projected privately.
import { openRouterPolicy, type OpenRouterTariff } from "./openrouter-policy.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { resolveAgentSource, agentSourceSwitchedOn, type AgentSourcePorts, type ByoBedrock } from "./agent-ai.js";
import type { SnapshotPriceSource } from "./price-index.js";
import { resolvePrice, dearerPrice } from "./price.js";
import { completePrice, type RateKey } from "./price-tiers.js";
import { STALE_ALARM_MS } from "./price-constants.js";
import { SERVICE_TOKEN_TYPE, SERVICE_TOKEN_SECONDS, SERVICE_TOKEN_CLAIMS, ANTHROPIC_KEY_AGENT_MODELS, OPENAI_KEY_AGENT_MODELS } from "./offered-models.js";
import { COMPANY, record, whole } from "./model-gateway-token.js";
import type { SignedTokenKind } from "./token.js";
import type { LearningKeySource } from "./learning-route.js";
import { serviceCallLimiter } from "./service-call.js";

export const RATE_QUOTE_AUDIENCE = "rovara-model-gateway-rate-quote";
export const RATE_QUOTE_PATH = /^\/v1\/service\/companies\/(org_[0-9a-z]{20})\/rate-quote(?:\?.*)?$/u;
interface Claims { iss: string; cid: string; aud: typeof RATE_QUOTE_AUDIENCE; jti: string; iat: number; nbf: number; exp: number }
export const RATE_QUOTE_TOKEN_KIND: SignedTokenKind<Claims> = {
  typ: SERVICE_TOKEN_TYPE, maxSeconds: SERVICE_TOKEN_SECONDS,
  parse(value) {
    const c = record(value);
    if (c === undefined || Object.keys(c).length !== SERVICE_TOKEN_CLAIMS.length || !SERVICE_TOKEN_CLAIMS.every((k) => Object.hasOwn(c, k)) || c.aud !== RATE_QUOTE_AUDIENCE || typeof c.iss !== "string" || !c.iss || c.iss.length > 2048 || typeof c.cid !== "string" || !COMPANY.test(c.cid) || typeof c.jti !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(c.jti) || !whole(c.iat) || !whole(c.nbf) || !whole(c.exp)) return undefined;
    return c as unknown as Claims;
  },
};
export interface RateQuoteOptions extends AgentSourcePorts {
  openRouterTariffs?: readonly OpenRouterTariff[];
  verify(token: unknown): Promise<Claims | undefined>;
  prices: SnapshotPriceSource;
  region: string;
  disabled?: ReadonlySet<string>;
  now?: () => number;
  switchedOn: ReadonlySet<string>;
  /** The company's own Bedrock connection (a chosen `bedrock_byo` is quoted from it; never a default, DEC 254zzz525). */
  byo?: Pick<ByoBedrock, "connection">;
  /** Provider transports actually installed on the agent route. */
  offeredProviders: ReadonlySet<string>;
  rovara?: { sourceId?: string; models: ReadonlyMap<string, string>; exempt: ReadonlySet<string> };
  keys: AgentSourcePorts["keys"] & Pick<LearningKeySource, "endpointMetadata"> & { identityFor?(iss: string, cid: string, provider: "anthropic" | "openai" | "openrouter"): Promise<{ sourceId: string; versionId: string } | undefined> };
}
const unavailable = { status: 200, body: { state: "unavailable", reason: "missing_price" } } as const;
const refused = { status: 401, body: { error: { type: "unauthorized", message: "the service call is not signed" } } } as const;
const names = { inputMicrosPerMTok: "input", outputMicrosPerMTok: "output", cacheReadMicrosPerMTok: "cacheRead", cacheWrite5mMicrosPerMTok: "cacheWrite5m", cacheWrite1hMicrosPerMTok: "cacheWrite1h" } as const;
export async function answerRateQuote(options: RateQuoteOptions, request: { method: string; url: string; headers: Readonly<Record<string, string | string[] | undefined>> }): Promise<{ status: number; body: unknown }> {
  const target = RATE_QUOTE_PATH.exec(request.url);
  if (target === null) return { status: 404, body: { error: { type: "not_found" } } };
  if (request.method !== "GET") return { status: 405, body: { error: { type: "not_found" } } };
  const auth = request.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Bearer ") || request.headers["x-api-key"] !== undefined) return refused;
  let claims: Claims | undefined;
  try { claims = await options.verify(auth.slice(7)); } catch { return refused; }
  if (claims === undefined || claims.cid !== target[1]) return refused;
  const url = new URL(request.url, "https://gateway.invalid");
  const model = url.searchParams.get("model");
  if (model === null || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/u.test(model) || [...url.searchParams.keys()].some((k) => k !== "model" && k !== "runPrice") || url.searchParams.getAll("model").length !== 1 || url.searchParams.getAll("runPrice").length > 1 || (url.searchParams.has("runPrice") && url.searchParams.get("runPrice") !== "1")) return unavailable;
  try {
    const resolved = await resolveAgentSource({ sources: options.sources, keys: options.keys, ...(options.rovara === undefined ? {} : { exempt: options.rovara.exempt }) }, claims.iss, claims.cid);
    const order = [resolved.source ?? "anthropic_key", ...(resolved.fallback ?? [])];
    let selected: { source: string; provider: string; modelId: string; region: string; id: string; revision: string; aliases?: string[] } | undefined;
    for (const source of order) {
      if (!agentSourceSwitchedOn(source, options.switchedOn)) continue;
      if (source === "rovara") {
        const mapped = options.rovara?.models.get(model);
        if (mapped === undefined || !options.offeredProviders.has("bedrock") || options.disabled?.has(model) === true) continue;
        selected = { source, provider: "bedrock", modelId: mapped, region: options.region, id: options.rovara?.sourceId ?? "rovara-ai",
          revision: createHash("sha256").update(JSON.stringify([...options.rovara!.models].sort())).digest("hex") };
      } else if (source === "anthropic_key" || source === "openai_key" || source === "openrouter_key") {
        const provider = source === "anthropic_key" ? "anthropic" : source === "openai_key" ? "openai" : "openrouter";
        if (!options.offeredProviders.has(provider)) continue;
        if (provider === "openrouter" && openRouterPolicy(model, (options.now ?? Date.now)(), options.openRouterTariffs) === undefined) continue;
        // With a fallback, admission tests whether this source serves this model before moving on.
        if (order.length > 1 && (provider === "anthropic" ? !ANTHROPIC_KEY_AGENT_MODELS.includes(model) : provider === "openai" ? !OPENAI_KEY_AGENT_MODELS.includes(model) : !model.includes("/"))) continue;
        if (!await options.keys.connected(claims.iss, claims.cid, provider)) continue;
        const identity = await options.keys.identityFor?.(claims.iss, claims.cid, provider);
        if (identity === undefined || !identity.sourceId || !identity.versionId) return unavailable;
        selected = { source, provider, modelId: model, region: "global", id: identity.sourceId, revision: identity.versionId };
      } else if (source === "bedrock_byo") {
        if (!options.offeredProviders.has("bedrock")) continue;
        const found = await options.byo?.connection(claims.iss, claims.cid);
        if (found === undefined) continue;
        if (found.row.cid !== claims.cid || found.row.iss !== claims.iss) return unavailable;
        const mapped = found.connection.models[model];
        if (mapped === undefined) continue;
        selected = { source, provider: "bedrock", modelId: mapped, region: found.connection.region, id: found.row.sourceId, revision: found.row.versionId,
          aliases: Object.entries(found.connection.models).filter(([, id]) => id === mapped).map(([name]) => name) };
      } else {
        const metadata = await options.keys.endpointMetadata?.(claims.iss, claims.cid);
        if (metadata === undefined) continue;
        const mapped = metadata.models.find((m) => m.name === model);
        if (mapped === undefined) continue;
        // An admitted but unpriced endpoint refuses below; pricing never changes its payer.
        selected = { source, provider: mapped.catalog.provider, modelId: mapped.catalog.modelId, region: "global", id: metadata.sourceId, revision: metadata.versionId };
      }
      if (selected !== undefined) break;
    }
    if (selected === undefined) return unavailable;
    const { source, provider, modelId, region, id, revision } = selected;
    const policy = provider === "openrouter" ? openRouterPolicy(modelId, (options.now ?? Date.now)(), options.openRouterTariffs) : undefined;
    if (provider === "openrouter" && policy === undefined) return unavailable;
    const basis = options.prices.quoteBasis(provider, modelId);
    const now = (options.now ?? Date.now)();
    if (basis === undefined || basis.fetchedAt > now || now - basis.fetchedAt >= STALE_ALARM_MS) return unavailable;
    let price = await resolvePrice(options.prices, provider, modelId);
    if (source === "bedrock_byo") {
      for (const alias of selected.aliases ?? [model]) {
        const anthropic = await resolvePrice(options.prices, "anthropic", alias);
        const components = [...(price.derived ?? []), ...(anthropic.estimated ? [] : anthropic.derived ?? [])];
        price = { ...dearerPrice(price, anthropic), derived: components };
      }
    }
    if (price.operatorReview || (price.estimated && !price.knownTokenPrice) || price.priceVersion !== basis.version) return unavailable;
    if (options.prices.mediaFor(provider, modelId) !== undefined) return unavailable;
    const p = completePrice(price);
    const rates = (r: typeof p) => ({ input: r.inputMicrosPerMTok, output: r.outputMicrosPerMTok, cacheRead: r.cacheReadMicrosPerMTok!, cacheWrite5m: r.cacheWrite5mMicrosPerMTok!, cacheWrite1h: r.cacheWrite1hMicrosPerMTok! });
    const base = rates(p);
    const longContext = (p.longContext ?? []).map((band) => ({ aboveInputTokens: band.aboveTokens, rates: rates({ ...p, ...band }) }));
    if (![base, ...longContext.map((b) => b.rates)].every((r) => Object.values(r).every(whole))) return unavailable;
    const derived = [...new Set([...(p.derived ?? []), ...(p.uncertain ?? [])].map((b) => b.aboveTokens))].sort((a, b) => a - b).map((threshold) => ({ aboveInputTokens: threshold, components: [...new Set([...(p.derived ?? []), ...(p.uncertain ?? [])].filter((b) => b.aboveTokens === threshold).flatMap((b) => b.keys).filter((key): key is Exclude<RateKey, "cacheWriteMicrosPerMTok"> => key !== "cacheWriteMicrosPerMTok").map((key) => names[key]))] }));
    // A whole run's future context is unknown. Pool the effective base and every reachable tier,
    // retaining per-component maxima (including either cache-write duration).
    let active = base;
    const bounds = { ...base };
    for (const band of longContext) {
      active = { ...active, ...band.rates };
      for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) bounds[key] = Math.max(bounds[key], active[key]);
    }
    const runPrice = { companyId: claims.cid, model, provider, sourceId: id, connectionRevision: revision, catalogModel: modelId, snapshotHash: basis.hash, snapshotVersion: basis.version,
      expiresAt: Math.min(now + 300_000, basis.fetchedAt + STALE_ALARM_MS, policy?.expiresAt ?? Infinity),
      inputUsdPerMillion: bounds.input / 1_000_000, outputUsdPerMillion: bounds.output / 1_000_000,
      cacheWriteUsdPerMillion: Math.max(bounds.cacheWrite5m, bounds.cacheWrite1h) / 1_000_000, cacheReadUsdPerMillion: bounds.cacheRead / 1_000_000 };
    // PRICE-BANDS: the base band rides BESIDE `runPrice` (never inside it: an old Code reads `runPrice` strictly and ignores a sibling). Only when a long-context band exists, so a flat model has nothing to separate.
    const runPriceBaseBand = longContext.length === 0 ? undefined : { upToInputTokens: Math.min(...longContext.map((b) => b.aboveInputTokens)), inputUsdPerMillion: base.input / 1_000_000, outputUsdPerMillion: base.output / 1_000_000,
      cacheWriteUsdPerMillion: Math.max(base.cacheWrite5m, base.cacheWrite1h) / 1_000_000, cacheReadUsdPerMillion: base.cacheRead / 1_000_000 };
    return { status: 200, body: { state: "available", ...(url.searchParams.get("runPrice") === "1" && (provider !== "openrouter" || policy !== undefined) && (source !== "rovara" || options.rovara?.sourceId !== undefined) ? { runPrice, ...(runPriceBaseBand === undefined ? {} : { runPriceBaseBand }) } : {}), value: { version: 1, currency: "USD", unit: "micros_per_million_tokens", ref: { authority: "gateway", version: String(basis.version), hash: basis.hash, fetchedAt: new Date(basis.fetchedAt).toISOString() }, source: { kind: source === "rovara" ? "rovara_ai" : "company_key", id, name: source === "rovara" ? "Rovara AI" : "Company AI", provider, connectionRevision: revision }, model: { provider, modelId: basis.model }, region, asOf: new Date(now).toISOString(), expiresAt: new Date(Math.min(now + 300_000, basis.fetchedAt + STALE_ALARM_MS, policy?.expiresAt ?? Infinity)).toISOString(), base, longContext, derived } } };
  } catch { return unavailable; }
}
export function createRateQuoteHandler(options: RateQuoteOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limiter = serviceCallLimiter(options.now ?? Date.now, 8, 600);
  return async (req, res) => {
    const release = limiter.take();
    try {
      req.resume();
      const answer = release === undefined ? { status: 429, body: { error: { type: "busy" } } } : await answerRateQuote(options, { method: req.method ?? "", url: req.url ?? "", headers: req.headers });
      if (res.destroyed || res.headersSent) return;
      res.writeHead(answer.status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(answer.body));
    } finally { release?.(); }
  };
}
