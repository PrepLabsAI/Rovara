// The product-AI route (plan 7.4 item 7, DEC 157/165/172/216): calls made by the customer's TESTS with the project's own AI
// key. Same token (TC-1, task purpose), same price resolver, same money core as the agent route, but its own meter, its own
// caps (the project's product caps, clamped by the company ceiling) and settled to the project: the token's person and
// payer never pay for product calls.
import { validCaps, type Caps, type CapsScope, type CapsSource } from "./caps.js";
import type { ModelLimitsSource } from "./guard.js";
import type { Meter, MeterItem } from "./meter.js";
import type { ProviderTransport } from "./provider.js";
import type { TaskClaims } from "./model-gateway-token.js";
import { GeminiUsageCollector, guardGemini, parseGeminiPath } from "./product-gemini.js";
import type { ProductProvider, ProductSourceResolution } from "./product-keys.js";
import { EVAL_HOLD_PATH, EVAL_RELEASE_PATH, EVAL_SCOPE_HEADER, EVAL_STAGE_SPENT, EvalEventSink, type EvalStage, type ProductEvalStages, type StageSettle } from "./product-eval.js";
import type { GatewayRoute, GatewaySink, ProductControl, ProductRouteResolver, RouteCall, RouteRefusal } from "./server.js";
import type { MediaPriceSource } from "./media-price.js";
import { EVAL_VERTEX_PLACEHOLDER, guardVertex, parseVertexPath, type VertexPath, type VertexTarget } from "./product-vertex.js";
import { parseStoredVertexCredential } from "./product-vertex-credential.js";
import type { VertexTokenSource } from "./product-vertex-token.js";
import type { ProductKeyRow } from "./product-seal.js";
import type { CredentialSource } from "./aws.js";
import { parseBedrockConnect, type BedrockConnection } from "./bedrock-byo.js";
import { BEDROCK_MODEL_ACCESS_WORDS, type BedrockSessionSource } from "./bedrock-byo-sessions.js";
import { BedrockUsage, bedrockFailureKind, bedrockFamily, bedrockMarker, bedrockUsageKind, guardBedrockProduct, parseBedrockProductPath, PRODUCT_BEDROCK_FEATURE, PRODUCT_BEDROCK_MODEL_NOT_ENABLED, PRODUCT_BEDROCK_NOT_CONNECTED, PRODUCT_BEDROCK_QUOTA, PRODUCT_BEDROCK_REFUSED, PRODUCT_BEDROCK_THROTTLED, type BedrockFamily, type BedrockProductPath } from "./product-bedrock.js";
import { NotSentError } from "./provider.js";

/** What the route needs from the product key store (ProductKeyStore implements it). */
export interface ProductKeySource {
  capsFor(iss: string, cid: string, project: string): Promise<{ caps: { taskMicros: number; projectMonthMicros: number }; companyMonthMicros?: number }>;
  resolve(iss: string, cid: string, project: string, provider: ProductProvider): Promise<ProductSourceResolution | undefined>;
  useKey(iss: string, cid: string, resolution: ProductSourceResolution): Promise<string | undefined>;
  recordWarning(iss: string, cid: string, resolution: ProductSourceResolution, status: 401 | 403): Promise<void>;
}
/** DEC 165: once a product call settles above its hold, every further product call in that task is refused. */
export interface ProductOverrunTasks { isBlocked(iss: string, cid: string, tid: string): Promise<boolean>; block(iss: string, cid: string, tid: string): Promise<void> }
export class InMemoryProductOverrunTasks implements ProductOverrunTasks {
  readonly #blocked = new Set<string>();
  async isBlocked(iss: string, cid: string, tid: string): Promise<boolean> { return this.#blocked.has(JSON.stringify([iss, cid, tid])); }
  async block(iss: string, cid: string, tid: string): Promise<void> { this.#blocked.add(JSON.stringify([iss, cid, tid])); }
}
export interface ProductRouteOptions {
  keys: ProductKeySource;
  /**
   * A meter of its OWN (separate tables) for the task, project and product-ceiling rows, combined with the agent meter for the
   * company row (DEC 228c: `meter.combinedCompany` must be true; otherwise every product call answers 503 and nothing is held).
   */
  meter: Meter;
  /** Per-model output ceilings: the price snapshot's rows (#53 SnapshotPriceSource); see productModelLimitsFrom. */
  modelLimits: ModelLimitsSource;
  transports: { gemini: ProviderTransport; vertex?: ProviderTransport };
  /**
   * Vertex AI (DEC 229b): short-lived Google tokens for the project's Vertex credential (VertexTokens). With `transports.vertex`
   * it mounts `/v1/product/vertex/...`; without either, those paths are 404.
   */
  vertex?: { tokens: VertexTokenSource };
  /** Audio and video prices per model (the price snapshot's media rows, SnapshotPriceSource). Absent: audio and video are refused. */
  media?: MediaPriceSource;
  overrun: ProductOverrunTasks;
  /**
   * The company's budgets from the Cloud company backend (#53 CompanyBudgetCaps): fail closed. A company with no monthly cap,
   * no settings or an unreadable row gets no product calls either; its monthly cap also bounds the product meter's company row.
   */
  companyCaps: CapsSource;
  /** The whole-stage eval holds (Code #683, product-eval.ts). Absent: the eval paths are 404 and a scope header is refused. */
  evalStages?: ProductEvalStages;
  /**
   * Bring your own Bedrock (DEC 238, slice 2): the project's own role, or the company's it links to. `sessions` assumes the company's
   * role (broker, then the customer's, bedrock-byo-sessions.ts); `transport` signs for a connection's Region with that session.
   * Without it `/v1/product/bedrock/...` is 404.
   */
  bedrock?: { sessions: BedrockSessionSource; transport(region: string, credentials: CredentialSource): ProviderTransport };
}
/** Gemini and Bedrock rows' own max output tokens from the price snapshot; a model with no row falls back to GEMINI_DEFAULT_MAX_OUTPUT_TOKENS in the guard. */
export function productModelLimitsFrom(rows: { maxOutputTokens(provider: string, model: string): number | undefined }): ModelLimitsSource {
  return { maxOutputTokens: (provider, model) => provider !== "gemini" && provider !== "bedrock" ? undefined : rows.maxOutputTokens(provider, model) };
}
/**
 * Product caps for a scope: the project's product caps (clamped by the product ceiling), with the company month bounded by the
 * company backend's monthly cap. Used by the route and by the product meter's corrections. Anything unreadable or a company
 * with no monthly cap answers caps that validCaps refuses (503, nothing held or sent).
 */
export function createProductCaps(keys: ProductKeySource, companyCaps: CapsSource): CapsSource {
  return {
    async capsFor(scope: CapsScope, signal?: AbortSignal): Promise<Caps> {
      const company = await companyCaps.capsFor(scope, signal);
      if (!validCaps(company) || company.companyMonth === undefined) return UNAVAILABLE_CAPS;
      const product = await keys.capsFor(scope.iss, scope.cid, scope.pid);
      // DEC 228c: the company backend's monthly cap is ONE cap over agent and product spend together (the agent meter's company row).
      return { task: product.caps.taskMicros, projectMonth: product.caps.projectMonthMicros, companyMonth: Math.min(company.companyMonth, product.companyMonthMicros ?? company.companyMonth), combinedCompanyMonth: company.companyMonth };
    },
  };
}
/** A media call's dearest media kind (REVIEW-1 M2): video carries an audio track, so a video call bills as whichever of the two is dearer. */
function missingDetailsKind(call: RouteCall | undefined): { missingDetails?: "audio" | "video" } {
  if (call?.media === undefined) return {};
  const value = (r: unknown) => typeof r === "number" ? r : 0;
  if (!call.media.video) return { missingDetails: "audio" };
  return { missingDetails: value(call.mediaRates?.videoInput) > value(call.mediaRates?.audioInput) ? "video" : "audio" };
}
const UNAVAILABLE_CAPS = Object.freeze({}) as unknown as Caps;
export const PRODUCT_OVER_BY_ONE_CALL = "budget exceeded by one call";
export const PRODUCT_NOT_SET_UP = "product AI is not set up for this project";
export const PRODUCT_KEY_REFUSED = "not run: the product key was refused (check it in Settings)";
export const PRODUCT_PROVIDER_REFUSED = "the provider refused this request";
export const PRODUCT_PROVIDER_LIMITED = "the provider is limiting this product key; try again later";
export const PRODUCT_PROVIDER_QUOTA = "the provider quota for this product key is used up";
export const PRODUCT_PROVIDER_OVERLOADED = "the provider is overloaded; try again later";
export const PRODUCT_VERTEX_NOT_CONNECTED = "this Google Cloud project or location is not the one connected for product AI";
const QUOTA_WORDS = /insufficient_quota|per ?day|daily|billing|spending cap|prepayment|out of credits|quota exceeded for quota metric .*per day/iu;
const PER_MINUTE = /per ?minute/iu;
const OVERLOADED_WORDS = /overloaded/iu;
/** A 429's kind from the provider's words (read only to classify, never echoed): overloaded, per-minute rate limit, or quota used up. */
export function productLimitKind(body: Uint8Array | undefined): "overloaded" | "rate_limit" | "quota" {
  const text = body === undefined ? "" : Buffer.from(body).subarray(0, 64 * 1024).toString("utf8");
  if (OVERLOADED_WORDS.test(text)) return "overloaded";
  if (PER_MINUTE.test(text)) return "rate_limit";
  if (QUOTA_WORDS.test(text)) return "quota";
  return "rate_limit";
}
/** Eval stage calls' prefix: every item reads as the stage's own held budget being used up. */
const STAGE_PREFIX: Readonly<Record<MeterItem, string>> = { task: EVAL_STAGE_SPENT, person: EVAL_STAGE_SPENT, project: EVAL_STAGE_SPENT, company: EVAL_STAGE_SPENT, upkeep: EVAL_STAGE_SPENT };
/** A stage call reserves nothing on the real meter; these caps only satisfy the core's shape check. */
const STAGE_CAPS: Caps = Object.freeze({ task: 0, projectMonth: 0 });
export const PRODUCT_PREFIX: Readonly<Record<MeterItem, string>> = {
  task: "Product AI budget has been exceeded! Key=task", person: "Product AI budget has been exceeded! User=person",
  project: "Product AI budget has been exceeded! Project=project", company: "Product AI budget has been exceeded! Team=company", upkeep: "Product AI budget has been exceeded! Upkeep=project",
};
const unavailable: RouteRefusal = { ok: false, status: 503, code: "unavailable", message: "model access unavailable" };
const unavailableGuard = { ok: false as const, status: 503, code: "unavailable", message: "model access unavailable" };

export function createProductRoutes(options: ProductRouteOptions): ProductRouteResolver & { caps: CapsSource; evalStages?: ProductEvalStages } {
  const productCaps = createProductCaps(options.keys, options.companyCaps);
  const vertexOn = options.vertex !== undefined && options.transports.vertex !== undefined;
  const bedrockOn = options.bedrock !== undefined;
  options.evalStages?.bind({
    meter: options.meter,
    caps: { capsFor: async (scope, signal) => (options.meter.combinedCompany === true ? productCaps.capsFor(scope, signal) : UNAVAILABLE_CAPS) },
    // A project with only Bedrock counts: its own saved role, or a link to the company's saved role (resolve answers a link only while the company's source is current).
    connected: async (claims) => (await options.keys.resolve(claims.iss, claims.cid, claims.pid, "gemini")) !== undefined || (vertexOn && (await options.keys.resolve(claims.iss, claims.cid, claims.pid, "vertex")) !== undefined)
      || (bedrockOn && (await options.keys.resolve(claims.iss, claims.cid, claims.pid, "bedrock")) !== undefined),
    blocked: (claims) => options.overrun.isBlocked(claims.iss, claims.cid, claims.tid),
    block: (claims) => options.overrun.block(claims.iss, claims.cid, claims.tid),
  });
  /**
   * Vertex admission, before any hold: unseal the project's Vertex credential, check the request names the CONNECTED project and
   * location (another one is refused even if the token could reach it), and mint the company's token. A refused credential is
   * the key-refused answer (free, marked for Settings); an outage is 503. Nothing is held or sent in either case.
   */
  async function admitVertex(claims: TaskClaims, resolution: ProductSourceResolution, path: VertexPath, signal: AbortSignal, evalStage: boolean): Promise<RouteRefusal | { row: ProductKeyRow; target: VertexTarget; token: string }> {
    let text: string | undefined;
    try { text = await options.keys.useKey(claims.iss, claims.cid, resolution); } catch { return unavailable; }
    const credential = text === undefined ? undefined : parseStoredVertexCredential(text);
    if (credential === undefined || options.vertex === undefined) return unavailable;
    // An eval stage's call may name Rovara's placeholder pair instead (the worker does not know the connected one); nothing else, and no call outside a found stage (L4-EVV).
    const placeholder = evalStage && path.project === EVAL_VERTEX_PLACEHOLDER.projectId && path.location === EVAL_VERTEX_PLACEHOLDER.location;
    if (!placeholder && (path.project !== credential.projectId || path.location !== credential.location)) return { ok: false, status: 400, code: "not_allowed", message: PRODUCT_VERTEX_NOT_CONNECTED };
    const row: ProductKeyRow = { iss: claims.iss, cid: claims.cid, owner: resolution.owner, sourceId: resolution.sourceId, versionId: resolution.versionId };
    let minted: Awaited<ReturnType<VertexTokenSource["token"]>>;
    try { minted = await options.vertex.tokens.token(row, credential, signal); } catch { return unavailable; }
    if (!minted.ok) {
      if (minted.reason !== "refused") return unavailable;
      void options.keys.recordWarning(claims.iss, claims.cid, resolution, 401).catch(() => undefined);
      return { ok: false, status: 502, code: "product_key_refused", message: PRODUCT_KEY_REFUSED };
    }
    return { row, target: { projectId: credential.projectId, location: credential.location }, token: minted.token };
  }
  /**
   * Bedrock admission, before any hold: the project's own connection, or the company's one it links to (resolve), opened and parsed
   * as the store sealed it. Nothing is held or sent when it is missing or unreadable; the model and the operation are checked by the
   * guard against what the company picked.
   */
  async function admitBedrock(claims: TaskClaims, resolution: ProductSourceResolution, path: BedrockProductPath): Promise<RouteRefusal | { row: ProductKeyRow; connection: BedrockConnection; family: BedrockFamily }> {
    if (options.bedrock === undefined) return unavailable;
    let text: string | undefined;
    try { text = await options.keys.useKey(claims.iss, claims.cid, resolution); } catch { return unavailable; }
    if (text === undefined) return { ok: false, status: 404, code: "not_set_up", message: PRODUCT_BEDROCK_NOT_CONNECTED };
    const connection = parseBedrockConnect(text);
    // A model that is no family at all (an application profile id) is refused by the guard as not picked, before anything is sent.
    const family = bedrockFamily(path.modelId) ?? "converse";
    if (connection === undefined) return unavailable;
    return { row: { iss: claims.iss, cid: claims.cid, owner: resolution.owner, sourceId: resolution.sourceId, versionId: resolution.versionId }, connection, family };
  }
  return {
    caps: productCaps,
    // The maintenance pass releases expired stages from here when startServe is not given them separately.
    ...(options.evalStages === undefined ? {} : { evalStages: options.evalStages }),
    route(path, query, headers): GatewayRoute | ProductControl | undefined {
      if (path === EVAL_HOLD_PATH || path === EVAL_RELEASE_PATH) return query === "" ? options.evalStages?.control(path) : undefined;
      const parsed = parseGeminiPath(path, query);
      const vertexPath: VertexPath | undefined = parsed === undefined && vertexOn ? parseVertexPath(path, query) : undefined;
      const bedrockPath: BedrockProductPath | undefined = parsed === undefined && vertexPath === undefined && bedrockOn ? parseBedrockProductPath(path, query) : undefined;
      if (parsed === undefined && vertexPath === undefined && bedrockPath === undefined) return undefined;
      const provider: ProductProvider = bedrockPath !== undefined ? "bedrock" : parsed === undefined ? "vertex" : "gemini";
      const scopeId = headers?.[EVAL_SCOPE_HEADER];
      if (scopeId !== undefined && options.evalStages === undefined) return undefined;
      // A Bedrock call is not an eval stage call: its answer is AWS's own bytes, not events.
      if (scopeId !== undefined && bedrockPath !== undefined) return undefined;
      const stages = options.evalStages;
      let stage: EvalStage | undefined;
      let callMeter: (Meter & { settled(): StageSettle | undefined }) | undefined;
      // Per request: the resolution read at admission is the one the hold, caps and key use.
      let resolution: ProductSourceResolution | undefined;
      let admitted: TaskClaims | undefined;
      let guarded: RouteCall | undefined;
      // Vertex: the connected project and location, and the token minted for this company's source (at admission).
      let vertex: { row: ProductKeyRow; target: VertexTarget; token: string } | undefined;
      // Bedrock: the connected role (the project's own, or the company's it links to), opened at admission; the session after the hold.
      let bedrock: { row: ProductKeyRow; connection: BedrockConnection; family: BedrockFamily; credentials?: Awaited<ReturnType<CredentialSource>> } | undefined;
      let bedrockNotSent: RouteRefusal | undefined;
      /**
       * Bedrock's error answers (class read from the error type and words, never echoed). A refusal of the role or a model, a throttle,
       * a quota and a validation error carry no output: free. A timeout or a server error after the send is charged, as for every provider.
       */
      const bedrockFailure = (status: number, body: Uint8Array | undefined): { charged: boolean; refusal: RouteRefusal } => {
        const kind = bedrockFailureKind(status, body, BEDROCK_MODEL_ACCESS_WORDS);
        if (kind === "not_enabled") return { charged: false, refusal: { ok: false, status: 403, code: "model_not_enabled", message: PRODUCT_BEDROCK_MODEL_NOT_ENABLED } };
        if (kind === "refused") {
          // The settings page learns about a refused role, and the session is no longer good: the next call assumes it again.
          if (resolution !== undefined && admitted !== undefined) void options.keys.recordWarning(admitted.iss, admitted.cid, resolution, status === 401 ? 401 : 403).catch(() => undefined);
          if (bedrock !== undefined) { try { options.bedrock?.sessions.forget(bedrock.row); } catch { /* Never changes the call. */ } }
          return { charged: false, refusal: { ok: false, status: 502, code: "product_key_refused", message: PRODUCT_BEDROCK_REFUSED } };
        }
        if (kind === "quota") return { charged: false, refusal: { ok: false, status: 429, code: "provider_quota", message: PRODUCT_BEDROCK_QUOTA } };
        if (kind === "throttled") return { charged: false, refusal: { ok: false, status: 429, code: "provider_limited", message: PRODUCT_BEDROCK_THROTTLED, headers: { "retry-after": "5" } } };
        if (kind === "invalid") return { charged: false, refusal: { ok: false, status: 400, code: "provider_refused", message: PRODUCT_PROVIDER_REFUSED } };
        if (status === 503) return { charged: true, refusal: { ok: false, status: 503, code: "provider_overloaded", message: PRODUCT_PROVIDER_OVERLOADED, headers: { "retry-after": "5" } } };
        return { charged: true, refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } };
      };
      const route: GatewayRoute = {
        // Vertex calls are logged and corrected on the Gemini rows, priced at the dearer of those and the Vertex rows (alsoPricedAs).
        provider: bedrockPath !== undefined ? "bedrock" : "gemini", product: true, meter: options.meter, prefix: PRODUCT_PREFIX,
        get payer() { return bedrockPath === undefined ? undefined : "bedrock_byo"; },
        get chargeSource() { return bedrock === undefined ? undefined : { source: { kind: "company_key" as const, id: bedrock.row.sourceId, name: "Product Bedrock", provider: "bedrock", connectionRevision: bedrock.row.versionId }, billing: "external_provider" as const }; },
        async admit(claims, signal) {
          admitted = claims;
          // Provisioned throughput, application inference profiles and prompts are named by ARN: refused before anything is read.
          if (bedrockPath?.arn === true) return { ok: false, status: 400, code: "not_allowed", message: PRODUCT_BEDROCK_FEATURE };
          try {
            if (await options.overrun.isBlocked(claims.iss, claims.cid, claims.tid)) return { ok: false, status: 422, code: "budget_exceeded", message: PRODUCT_OVER_BY_ONE_CALL };
            resolution = await options.keys.resolve(claims.iss, claims.cid, claims.pid, provider);
          } catch { return unavailable; }
          if (resolution === undefined) return { ok: false, status: 404, code: "not_set_up", message: PRODUCT_NOT_SET_UP };
          if (scopeId !== undefined && stages !== undefined) {
            // Missing, another company's, another project's or another task's stage: one answer.
            try { stage = await stages.find(claims, scopeId); } catch { return unavailable; }
            if (stage === undefined) return { ok: false, status: 404, code: "not_found", message: "not found" };
            callMeter = stages.callMeter(stage);
          }
          if (vertexPath !== undefined) {
            const refused = await admitVertex(claims, resolution, vertexPath, signal, stage !== undefined);
            if (refused !== undefined && "ok" in refused) return refused;
            vertex = refused;
          }
          if (bedrockPath !== undefined) {
            const admittedBedrock = await admitBedrock(claims, resolution, bedrockPath);
            if ("ok" in admittedBedrock) return admittedBedrock;
            bedrock = admittedBedrock;
          }
          return undefined;
        },
        guard: (bytes, headers, claims) => {
          const checked = bedrockPath !== undefined ? (bedrock === undefined ? unavailableGuard : guardBedrockProduct({ bytes, headers, path: bedrockPath, connection: bedrock.connection, claims, modelLimits: options.modelLimits }))
            : parsed !== undefined ? guardGemini(bytes, headers, parsed, options.modelLimits, options.media)
            : vertex === undefined ? unavailableGuard : guardVertex(bytes, headers, vertexPath!, vertex.target, options.modelLimits, options.media);
          // The approved model selection: every call of the stage names the approved model.
          if (checked.ok && stage?.model !== undefined && checked.model !== stage.model) return { ok: false, status: 400, code: "invalid_request", message: "request not allowed" };
          if (checked.ok) guarded = checked;
          return checked;
        },
        // Settled to the project: no person item, whoever started the task.
        scope: (claims) => ({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid }),
        async caps(scope, _claims, signal): Promise<Caps | RouteRefusal> {
          if (resolution === undefined || options.meter.combinedCompany !== true) return unavailable;
          if (scopeId !== undefined) return callMeter === undefined ? unavailable : STAGE_CAPS;
          return productCaps.capsFor(scope, signal);
        },
        async key(claims: TaskClaims) {
          // An empty answer is "not sent" in the core (the call cost nothing).
          if (provider === "vertex") return vertex?.token ?? "";
          if (provider === "bedrock") {
            // The company's role as THIS company (after the hold): a refusal is "not sent" ($0), in its own words; an outage is 503.
            if (bedrock === undefined || options.bedrock === undefined) return "";
            let got: Awaited<ReturnType<BedrockSessionSource["credentials"]>>;
            try { got = await options.bedrock.sessions.credentials(bedrock.row, bedrock.connection); } catch { bedrockNotSent = unavailable; return ""; }
            if (!got.ok) {
              bedrockNotSent = got.reason === "refused" ? { ok: false, status: 502, code: "product_key_refused", message: PRODUCT_BEDROCK_REFUSED } : unavailable;
              if (got.reason === "refused" && resolution !== undefined) void options.keys.recordWarning(claims.iss, claims.cid, resolution, 403).catch(() => undefined);
              return "";
            }
            bedrock.credentials = got.credentials;
            return bedrockMarker();
          }
          return resolution === undefined ? "" : (await options.keys.useKey(claims.iss, claims.cid, resolution)) ?? "";
        },
        transport: provider === "bedrock"
          // Signs with the session the key port assumed, for the connection's own Region (never the request's).
          ? async (request) => {
            const state = bedrock;
            if (state?.credentials === undefined || options.bedrock === undefined) throw new NotSentError();
            const credentials = state.credentials;
            return options.bedrock.transport(state.connection.region, async () => credentials)(request);
          }
          : provider === "gemini" ? options.transports.gemini : options.transports.vertex!,
        usage: () => provider === "bedrock" && bedrockPath !== undefined && bedrock !== undefined ? new BedrockUsage(bedrockUsageKind(bedrockPath, bedrock.family)) : new GeminiUsageCollector(missingDetailsKind(guarded)),
        failureBody: true,
        ...(provider === "bedrock" ? { notSent: () => bedrockNotSent, refusalBody: (type: string, message: string) => ({ message, error: { type, message } }) } : {}),
        providerFailure(status, body) {
          if (provider === "bedrock") return bedrockFailure(status, body);
          // Explicit rejections before any generation (bad key, bad request, unknown model, quota) cost nothing.
          if (status === 401 || status === 403) {
            // The settings page learns about a refused key. A failed write never changes the call.
            if (resolution !== undefined && admitted !== undefined) void options.keys.recordWarning(admitted.iss, admitted.cid, resolution, status).catch(() => undefined);
            // Vertex: the token may have been revoked or lost its role: the next call mints a new one.
            if (vertex !== undefined) { try { options.vertex?.tokens.forget(vertex.row); } catch { /* Never changes the call. */ } }
            return { charged: false, refusal: { ok: false, status: 502, code: "product_key_refused", message: PRODUCT_KEY_REFUSED } };
          }
          if (status === 400 || status === 404) return { charged: false, refusal: { ok: false, status: 400, code: "provider_refused", message: PRODUCT_PROVIDER_REFUSED } };
          if (status === 429) {
            const kind = productLimitKind(body);
            if (kind === "quota") return { charged: false, refusal: { ok: false, status: 429, code: "provider_quota", message: PRODUCT_PROVIDER_QUOTA } };
            if (kind === "overloaded") return { charged: false, refusal: { ok: false, status: 429, code: "provider_overloaded", message: PRODUCT_PROVIDER_OVERLOADED, headers: { "retry-after": "5" } } };
            return { charged: false, refusal: { ok: false, status: 429, code: "provider_limited", message: PRODUCT_PROVIDER_LIMITED, headers: { "retry-after": "5" } } };
          }
          // Overloaded (503, 529): charged as any other failure after the send, but named for what it is.
          if (status === 503 || status === 529) return { charged: true, refusal: { ok: false, status: 503, code: "provider_overloaded", message: PRODUCT_PROVIDER_OVERLOADED, headers: { "retry-after": "5" } } };
          return { charged: true, refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } };
        },
        async overReservation(claims) { await options.overrun.block(claims.iss, claims.cid, claims.tid); },
        // Bedrock: Claude is also priced at the Anthropic row of each model name the company's agents use for that id (never below either).
        ...(provider === "bedrock" ? { alsoPricedAs: (model: string) => Object.entries(bedrock?.connection.models ?? {}).filter(([, id]) => id === model).map(([name]) => ({ provider: "anthropic", model: name })) } : {}),
        // Vertex: never below its own rows either (LiteLLM keys them bare or as vertex_ai/<model>).
        ...(provider === "vertex" ? { alsoPricedAs: (model: string) => [{ provider: "vertex", model }, { provider: "vertex", model: `vertex_ai/${model}` }] } : {}),
      };
      if (scopeId === undefined) return route;
      // An eval stage call: admitted and settled under the stage, answered as events, and its overrun is the stage's (DEC 165).
      const delegate: Meter = {
        reserve: async (input) => (callMeter === undefined ? { ok: false, reason: "busy" } : callMeter.reserve(input)),
        settle: async (reservation, actual, estimated) => { await callMeter?.settle(reservation, actual, estimated); },
        pendingKeys: async () => { throw new Error("meter unavailable"); }, pendingFor: async () => { throw new Error("meter unavailable"); },
        pendingExpired: async () => { throw new Error("meter unavailable"); }, expire: async () => ({ status: "busy" }), correct: async () => ({ status: "busy" }),
        read: async () => { throw new Error("meter unavailable"); },
      };
      // No overReservation: a stage's overrun is the stage's own (product-eval.ts blocks the task when the hold is passed).
      const stageRoute: GatewayRoute = { ...route, meter: delegate, prefix: STAGE_PREFIX };
      delete (stageRoute as { overReservation?: unknown }).overReservation;
      return {
        ...stageRoute,
        events: { sink: (real: GatewaySink) => { const out = new EvalEventSink(real); return Object.assign(out, { finish: (outcome: { completed: boolean; code?: string }) => out.close(outcome, callMeter?.settled()) }); } },
      };
    },
  };
}
