import { initialCharge, finishCharge, type ChargeSource } from "./charge-producer.js";
import { ROVARA_AI_PAUSED } from "./rovara-ai-stop.js";
import { chargeValue, type ChargeReceiptV1 } from "./charge-receipt.js";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { openRouterDecimal, openRouterHold, openRouterPolicy, type OpenRouterTariff } from "./openrouter-policy.js";
import { runPriceDenial, type RunPriceDenial } from "./run-price.js";
import { AGENT_AI_SOURCES, agentSourceSwitchedOn, resolveAgentSource, type AgentAiSource, type ResolvedAgentSource, type AgentSourceVia, type AgentAiSourceReader, type ByoBedrock, type CompanyChatAi, type CompanyEndpointAi, type RovaraAi } from "./agent-ai.js";
import { endpointTarget, ENDPOINT_ADDRESS_REFUSED, type EndpointTarget } from "./endpoint-guard.js";
import { parseEndpointConnect, type EndpointConnection, type EndpointModel } from "./endpoint-source.js";
import { OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS, OPENAI_AGENT_MODEL, OPENAI_AGENT_UPSTREAM, toChatCompletions, type OpenAiAgentProvider } from "./agent-openai.js";
import type { AwsCredentials } from "./aws.js";
import { BEDROCK_BYO_REGION } from "./bedrock-byo.js";
import { BEDROCK_MODEL_ACCESS_WORDS } from "./bedrock-byo-sessions.js";
import { BEDROCK_CLAUDE_ID } from "./bedrock-transport.js";
import { ANTHROPIC_KEY_AGENT_MODELS, OPENAI_KEY_AGENT_MODELS } from "./offered-models.js";
import { invokeCall, PROVIDER_ERROR, rovaraChargeSource, rovaraGuard, rovaraProviderFailure } from "./rovara-ai-call.js";
export { BEDROCK_ANTHROPIC_VERSION, ROVARA_AI_FEATURE, ROVARA_AI_MODEL, ROVARA_AI_MODEL_NOT_ENABLED, ROVARA_AI_QUOTA, ROVARA_AI_UNAVAILABLE } from "./rovara-ai-call.js";
import { validCaps, type Caps, type CapsSource } from "./caps.js";
import type { EndedTasks } from "./ended.js";
import { estimateCall, TOOL_INPUT_ALLOWANCE_TOKENS, type MediaEstimate } from "./estimate.js";
import type { MediaRates } from "./media-price.js";
import type { InlineImageBound } from "./inline-image.js";
import { guardRequest, MAX_BODY_BYTES, tooLarge, type GuardFailure, type ModelLimitsSource } from "./guard.js";
import type { BillLine, Meter, MeterItem, MeterScope, Reservation } from "./meter.js";
import { LEARNING_PATH_PREFIX, LEARNING_STEP, type LearningKeySource, type LearningRouteFactory } from "./learning-route.js";
import { ANSWERS_PATH_PREFIX, ANSWERS_STEP } from "./answers-route.js";
import { isUpkeepCall, upkeepRefusal, withUpkeepCap, type UpkeepLimits } from "./upkeep-cap.js";
import { usageEstimated } from "./price-tiers.js";
import { dearerPrice, resolvePrice, UnknownPriceSource, type PriceKind, type PriceSource } from "./price.js";
import { AnswerBrokeError, CALL_HARD_CEILING_MS, callDurationMs, MAX_RESPONSE_BYTES, NotSentError, SecretScanner, type ProviderKeys, type ProviderResponse, type ProviderTransport } from "./provider.js";
import { AUTH_ERROR, TASK_TOKEN_SECONDS, consumeReviewerGrant, type TaskClaims, type TaskTokenVerifier } from "./token.js";
import { closeReviewSession, REVIEW_SESSION_CLOSE_GRACE_MS, REVIEW_SESSION_SECONDS, type ReviewerGrantStore } from "./reviewer-grants.js";
import { hasUsage, settleAmount, validUsage } from "./reported-cost.js";
import { cutCallMicros, failedCallPhase, FAILED_CALL_RECEIVED_BYTES_PER_TOKEN, mayReasonUnseen, providerErrorReason, type FailedCallCause, type FailedCallPhase, type ProviderErrorReason, type StreamProgress } from "./failed-call.js";
import type { ResolvedPrice } from "./price.js";
import type { EstimatedSettlement } from "./meter.js";
import type { TokenUsage } from "./usage.js";
import { UsageCollector } from "./usage.js";
export interface GatewayRequest { method: string; url: string; headers: Readonly<Record<string, string | undefined>>; body: AsyncIterable<Uint8Array>; signal?: AbortSignal }
export interface GatewaySink { head(status: number, headers: Readonly<Record<string, string>>): void; write(bytes: Uint8Array): Promise<void>; end(): void; destroy(): void }
/**
 * The reason a call was refused (lead 4 TA12): the fixed refusal code and HTTP status, plus where it was refused. `cap` is the meter row whose cap was reached
 * (task, person, project, upkeep, company), `route` the route that answered and `payer` who pays for the call's AI (the source word, set once the company's choice
 * is read). Fixed words and numbers only: never a token, key, prompt, provider text, company or task id.
 */
export type RefusedLogReason = "bedrock_401" | "bedrock_403" | "bedrock_429" | "bedrock_other" | "meter_busy" | RunPriceRefusedReason;
/**
 * Which run-price check refused a `run_price_authorization_required` call. Log only: the client's body, status and code never change. One fixed word per check
 * (a stable list: add, never rename): `signed_price_missing` the token carries no run price for a source that needs one; the `rovara_*`, `receipts_unavailable`
 * and `settlement_unavailable` rows are the hosted-purpose admission; `input_unbounded`, `media_unsupported`, `image_unbounded` the request shape;
 * `price_*` and `rate_above_ceiling` the price; `snapshot_mismatch`, `snapshot_version_mismatch`, `price_basis_missing`, `price_version_changed`,
 * `tariff_snapshot_changed` the price basis; `company_mismatch`, `model_mismatch`, `token_expired`, `provider_mismatch`, `source_mismatch`, `connection_changed`
 * the signed authorization against the admitted source; `cache_write_price_unknown` the cached-call rates.
 */
export type RunPriceRefusedReason = RunPriceDenial | "signed_price_missing" | "rovara_signed_price_missing" | "price_usage_estimated" | "receipts_unavailable" | "settlement_unavailable" | "input_unbounded" | "media_unsupported" | "image_unbounded" | "price_basis_missing" | "snapshot_mismatch" | "snapshot_version_mismatch" | "cache_write_price_unknown";
/**
 * `upstreamStatus` (Rovara-cloud#319): the provider's own HTTP status when the refusal is a provider's error answer (401, 404, 429, 400...),
 * so the log says why a call failed. Only the number is logged; the provider's body never is.
 */
export interface RefusedLog { event: "refused"; code: string; status: number; cap?: MeterItem; route?: "agent" | "product" | "learning" | "answers"; payer?: string; reason?: RefusedLogReason; upstreamStatus?: number; method?: string; path?: string; query?: boolean }
const REFUSAL_CODE = /^[a-z0-9_]{1,64}$/u;
/** A refusal code as it is logged: a fixed lower-case word, or "other" for anything else (a code never carries provider text). */
export const logCode = (code: string): string => REFUSAL_CODE.test(code) ? code : "other";
const PAYER = /^[a-z0-9_]{1,32}$/u;
export type GatewayLogEvent = { event: "customer_source_over_reservation"; source: "bedrock_byo" | "openrouter"; company: string; costMicros: number; heldMicros: number; overageMicros: number } | { event: "openrouter_over_reservation"; costMicros: number; holdMicros: number; sourceId: string; failed?: true } | { event: "settled"; estimated: boolean; costMicros: number; appliedMaxOutputTokens: number; route?: "product" | "learning" | "answers" } | { event: "overrun_busy"; company: string } | { event: "agent_source"; company: string; source: string; via: string } | RefusedLog | { event: "provider_error"; reason?: ProviderErrorReason } | { event: "settle_failed" | "price_operator_review" | "product_key_refused" | "product_over_reservation" };
export interface GatewayDependencies {
  /** DEC 328: production always supplies the live install setting. Own sources never read it. */
  rovaraAiSetting?: { enabled(): Promise<boolean> };
  /** Reviewed tariffs; injected only for offline qualification fixtures. */
  openRouterTariffs?: readonly OpenRouterTariff[];
  runPriceReady?: () => number | undefined;
  /** Negotiated token-only receipts. The server supplies the actual saved source identity/revision; no inferred key identity. */
  chargeReceipts?: { source(claims: TaskClaims, model: string, resolved?: ChargeSource): ChargeSource | undefined };
  verifyToken: TaskTokenVerifier; ended: EndedTasks; meter: Meter; caps: CapsSource; prices?: PriceSource;
  metrics: { overrunBusy(issuer: string, company: string): void };
  modelLimits: ModelLimitsSource; now?: () => number;
  keys: ProviderKeys; transport: ProviderTransport; cautiousCeiling?: number; timeoutMs?: number;
  log: (event: GatewayLogEvent) => void;
  /**
   * DEC 254zzz41: the durable store of reviewer grants and of the review session each one opens (reviewer-grants.ts). Absent: a token carrying a `reviewer` grant is refused
   * (401) before anything is read, held or sent, so a gateway without it never serves a review call.
   */
  reviewerGrants?: ReviewerGrantStore;
  /** The product-AI route (calls made by the customer's tests with the project's own key). Absent: every product path is 404, as before. */
  product?: ProductRouteResolver;
  /** The learning route (DEC 226, learning-route.ts: lessons' calls on the company's own key). Absent: its path is 404. */
  learning?: LearningRouteFactory;
  /** The answers route (answers-route.ts: hosted Ask and smart Just answer on the company's own key). Absent: its path is 404. */
  answers?: LearningRouteFactory;
  /** Nightly upkeep's per-project monthly cap (upkeep-cap.ts). Absent: an upkeep-origin call is paused with no_budget. */
  upkeep?: UpkeepLimits;
  /**
   * DEC 236: the agent route on each company's OWN connected AI key (company-key mode), from the same sealed company-level store
   * the learning route reads. Set: `keys` (Rovara's install key) is never read for an agent call, a company with no usable key is
   * refused before anything is held (AGENT_KEY_MISSING), and the combined company cap applies as before. Absent: the install key.
   */
  agentKeys?: LearningKeySource;
  /**
   * DEC 240, only with `agentKeys` (company-key mode): each company's chosen agent AI source. A saved "rovara" sends the call to
   * Rovara's AI (`rovara`; refused when absent) and never reads the company's key; "anthropic_key" or no saved choice is DEC 236
   * exactly; "bedrock_byo" sends it to the company's OWN Bedrock through its own role (`byo`; refused when absent, DEC 238).
   * Absent: DEC 236 exactly.
   */
  agentAi?: {
    sources: AgentAiSourceReader; rovara?: RovaraAi; byo?: ByoBedrock;
    /** DEC 254t (A2): the company's own OpenAI / OpenRouter key through Chat Completions (agent-openai.ts). Absent: that source is refused (not offered). */
    openai?: CompanyChatAi; openrouter?: CompanyChatAi;
    /** DEC 254t (A3): the company's own OpenAI-compatible endpoint behind the SSRF guard. Absent: that source is refused (not offered). */
    endpoint?: CompanyEndpointAi;
    /**
     * DEC 254t: the company source kinds this install switched on (GATEWAY_AI_SOURCE_KINDS). A saved source whose kind is off is
     * refused at admission (AGENT_SOURCE_SWITCHED_OFF): nothing read, held or sent. Absent: none. Rovara's AI and the pre-switch
     * sources (agent-ai.ts PRE_SWITCH_AGENT_SOURCES) are not gated.
     */
    switchedOn?: ReadonlySet<string>;
    /** DEC 254zzz84(4): Rovara's AI models not enabled yet (GATEWAY_AGENT_MODELS_DISABLED). Read only to pass Rovara's AI over in a company's saved order. Absent: none. */
    rovaraDisabled?: ReadonlySet<string>;
  };
}
/** One provider call shape after its route's guard. `path` is built by the guard from checked parts, never copied from the request. */
export interface RouteCall {
  ok: true; hasTools: boolean; inputBounded: boolean; model: string; maxTokens: number; streaming: boolean; bytes: Buffer; headers: Readonly<Record<string, string>>; path?: string;
  /** Inline cache breakpoints retain a token ceiling but require cache-write pricing. */
  usesPromptCache?: boolean;
  /** Claude inline image tokens replace encoded data bytes in the hold only. */
  images?: InlineImageBound;
  /** The model's audio/video prices (product route): attached to the call's price for the estimate and the settle. */
  mediaRates?: MediaRates;
  /** Inline audio/video: estimated prompt tokens, replacing their `dataBytes` encoded bytes in the hold (DEC 228e). */
  media?: MediaEstimate & { dataBytes: number };
  /** A streamed answer's content type when it is not SSE (Bedrock's binary event stream, product-bedrock.ts). Absent: text/event-stream. */
  streamContentType?: string;
  /** The price kind of the call's model (a Titan embedding is priced as "embedding"). Absent: "chat". */
  priceKind?: PriceKind;
}
export interface UsageReader { actualInputTokens?(): number | undefined; /** How far a stream got (failed-call.ts). */ progress?(): StreamProgress; push(bytes: Uint8Array): void; whole(value: unknown): void; finish(): TokenUsage | undefined }
/** A fixed refusal a route answers before any money moves. */
export interface RouteRefusal { ok: false; status: number; code: string; message: string; headers?: Readonly<Record<string, string>>; /** Logged with the refusal only; never sent. */ reason?: RefusedLogReason }
/** Everything that differs between the agent route and the product route. The money core (hold, settle, deadline, scan) is shared. */
export interface GatewayRoute {
  /** Saved source of this admitted call, when its adapter can pin the credential revision. */
  readonly chargeSource?: ChargeSource | undefined;
  /** Price, ledger and log provider name. */
  readonly provider: string;
  readonly product: boolean;
  readonly meter: Meter;
  readonly prefix: Readonly<Record<MeterItem, string>>;
  guard(bytes: Buffer, headers: Readonly<Record<string, string | undefined>>, claims: TaskClaims): RouteCall | GuardFailure;
  scope(claims: TaskClaims): MeterScope;
  /** Before the hold. A refusal here moves no money. */
  admit?(claims: TaskClaims, signal: AbortSignal): Promise<RouteRefusal | undefined>;
  caps(scope: MeterScope, claims: TaskClaims, signal: AbortSignal): Promise<Caps | RouteRefusal>;
  key(claims: TaskClaims, signal: AbortSignal): Promise<string>;
  transport: ProviderTransport;
  usage(): UsageReader;
  /** A provider answer that is not 2xx. `charged: false` only for an explicit rejection before any generation. `body`: its first bytes, when `failureBody`. */
  providerFailure(status: number, body?: Uint8Array): { charged: boolean; refusal: RouteRefusal; reason?: RefusedLogReason };
  /** Read (at most FAILURE_BODY_BYTES of) a failed provider answer for providerFailure's classification. Never echoed. */
  readonly failureBody?: boolean;
  /**
   * The answer as events (an eval stage call, product-eval.ts): the core writes through the returned sink and, after the call
   * settled, calls its finish exactly once with how the call ended.
   */
  readonly events?: { sink(real: GatewaySink): GatewaySink & { finish(outcome: { completed: boolean; code?: string }): Promise<void> } };
  /**
   * The token purpose this route serves. "learning": only learning tokens (`stp` = LEARNING_STEP); "answers": only answers tokens (`stp` = ANSWERS_STEP);
   * absent: only task tokens.
   * Either mismatch gets the fixed 401 before anything is read, held or sent.
   */
  readonly purpose?: "learning" | "answers";
  /**
   * DEC 254zzz41: true only on the agent route in company-key mode, the one route a reviewer grant (a task token carrying `reviewer`) may
   * use: it is paid by the SAME source as the task's main AI (the company's saved choice, resolved by admit for the token's company).
   * Absent: a reviewer grant is refused on this route (401), so none can reach the product, learning, answers or install-key routes.
   */
  readonly reviewerGrants?: true;
  /** Who pays for this call's AI, as a fixed lower-case word (the company's source: rovara, anthropic_key, bedrock_byo, ...), for the refusal log only. Absent: the route's kind says it. */
  readonly payer?: string | undefined;
  /**
   * The response header that carries this call's settled cost (US dollars, a plain decimal of six places: whole micro-dollars). Set only on the answers route (L4-E2).
   * Sent on a complete NON-streaming success only, and only when the figure is exact: the core settles first, then sends the head, so the figure is the amount
   * the same settle wrote to the meter. Absent (never 0, never a guess) when the price is estimated, the provider reported no usage, or the meter could not settle, and it is lost if the response head is never sent. A slow meter delays the head for that route (no separate time limit, as the settle was never bounded).
   */
  readonly costHeader?: string;
  /** false: the task-ended record does not stop this route's calls (learning runs after its task ended). Absent: it does. */
  readonly stopsWithTask?: false;
  /**
   * true: the provider is Bedrock on Rovara's own account. A call that fails after it was sent, with no usage reported, settles at what was used
   * (nothing before any stream event; the input estimate, plus the output seen) instead of the full hold (failed-call.ts). Absent: the hold for
   * a stream the provider broke; a call WE cut (client left, deadline, task ended) settles at what was used on every route (cutCallMicros).
   */
  readonly settlesFailedCalls?: true | undefined;
  /** A permanent cap refusal from the meter, in the route's own words. Absent: 422 budget_exceeded with `prefix`. */
  capRefusal?(refused: { reason: "cap" | "overrun"; item: MeterItem }, scope: MeterScope, caps: Caps, estimateMicros: number, signal: AbortSignal): Promise<RouteRefusal>;
  /** Why a call was not sent after its hold (the key port answered nothing): the route's own refusal. Absent or undefined: 502 provider_error. */
  notSent?(): RouteRefusal | undefined;
  /** After settlement: the actual cost passed the hold (DEC 165). Never throws to the caller. */
  overReservation?(claims: TaskClaims): Promise<void>;
  /**
   * More price rows for the same call (Vertex: its own vertex rows besides the Gemini rows `provider` names). Each one that is
   * known is merged in at the dearer rate per component (dearerPrice): a call is never priced below any of its rows.
   */
  alsoPricedAs?(model: string): ReadonlyArray<{ provider: string; model: string }>;
  /** DEC 240b: the billable line this call's hold carries to its ledger row (Rovara's AI). Absent or undefined: none. */
  line?(claims: TaskClaims, model: string): BillLine | undefined;
  /** An error answer's JSON when the route's callers expect another shape (the AWS SDK reads a top-level `message`). Absent: `{error:{type,message}}`. */
  refusalBody?(type: string, message: string): Readonly<Record<string, unknown>>;
}
/** A product request that is not a provider call (the eval stage hold and release): JSON in, JSON out, after the token check. */
export interface ProductControl { readonly control: true; /** Also answered after the task ended (a release only gives budget back). */ readonly afterTaskEnd?: true; handle(claims: TaskClaims, body: unknown, signal: AbortSignal): Promise<{ status: number; body: Readonly<Record<string, unknown>> }> }
/** Builds a product route for a request path, or undefined (404). Pure path parsing only; nothing is read before the token is checked. */
export interface ProductRouteResolver { route(path: string, query: string, headers: Readonly<Record<string, string | undefined>>): GatewayRoute | ProductControl | undefined }
export const CONTROL_BODY_BYTES = 16 * 1024;
export const FAILURE_BODY_BYTES = 64 * 1024;
export const OVERRUN_BUSY_MESSAGE = "Another call for this company may exceed its reserved cost right now; try again in a moment.";
export const OVERRUN_BUSY_RETRY_SECONDS = 2;
export const ENDED_TASK_POLL_MS = 1000;
const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const PREFIX: Record<MeterItem, string> = { task: "Budget has been exceeded! Key=task", person: "ExceededBudget: User=person", project: "Budget has been exceeded! Project=project", company: "Budget has been exceeded! Team=company", upkeep: "Budget has been exceeded! Upkeep=project" };
export const PRODUCT_ROUTE_PREFIX = "/v1/product/";
/** DEC 254zzz41: a review call whose own worst-case cost is above the grant's ceiling. Before any hold; fixed words. */
export const REVIEWER_CEILING_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 422, code: "budget_exceeded", message: "Budget has been exceeded! Key=reviewer" });
/** The unbounded-image refusal (a 409 before any hold or send). Its own sentence: the shared "AI source or price changed" wording would mislead here. */
const UNBOUNDED_IMAGE_REFUSED_MESSAGE = "This image can't be priced (only inline png, jpeg, gif or webp up to the size limit can be sent). Send it inline or leave it out.";
/** The agent route's refusal in company-key mode when the company has no usable AI key connected (DEC 236). Fixed words. */
export const AGENT_KEY_MISSING: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect an AI key: this company has no AI provider key connected, so its agents cannot call AI." });
/** Company-key mode: the provider refused the company's own key (401/403 before any output). Free; fixed words. */
export const AGENT_KEY_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect an AI key: the AI provider refused this company's connected key." });
const NOTHING_SWITCHED_ON: ReadonlySet<string> = new Set();
const AGENT_UNAVAILABLE: RouteRefusal = Object.freeze({ ok: false as const, status: 503, code: "unavailable", message: "model access unavailable" });
/** DEC 254zzz84(4): with a saved fallback, a source that does not serve the call's model is passed over; when none in the order serves it and the first refused only for that, this. Fixed words. */
export const AGENT_MODEL_NOT_SERVED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: none of the AI sources your company set up serves this model." });
/** DEC 240: the company chose its own Bedrock (DEC 238), and this gateway does not offer it. Nothing held or sent; no fallback. */
export const AGENT_SOURCE_NOT_OFFERED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: your own Bedrock is not available on this install." });
/** DEC 254t: the company chose an AI source this install has not switched on. Nothing read, held or sent; no fallback. */
export const AGENT_SOURCE_SWITCHED_OFF: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: the AI source your company chose is not switched on for this install." });
/** DEC 254t (A2): the company chose its own OpenAI or OpenRouter key, and this gateway does not offer it. Nothing held or sent; no fallback. */
export const AGENT_CHAT_NOT_OFFERED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: the AI source your company chose is not available on this install." });
/** DEC 254t (A2): a request with something an OpenAI or OpenRouter key cannot be given faithfully (images, documents, thinking, server or strict tools). Before any hold. */
export const AGENT_CHAT_FEATURE: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This request uses something your company's own OpenAI or OpenRouter key does not offer for agents (only text and tools)." });
/** DEC 254t (A3): the company's endpoint address failed the SSRF guard (at admission, or its DNS at call time). Free; fixed words, never the address. */
export const ENDPOINT_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "endpoint_refused", message: ENDPOINT_ADDRESS_REFUSED });
/** A3-REVIEW-1 M1: too many endpoint name resolutions at once for this company or this gateway. Not sent ($0); fixed words. */
export const ENDPOINT_BUSY: RouteRefusal = Object.freeze({ ok: false as const, status: 429, code: "busy", message: "Too many calls to your own endpoint are starting right now. Try again in a moment.", headers: { "retry-after": "2" } });
/** DEC 254t (A3): a model the company did not register for its endpoint. Before any hold. */
export const ENDPOINT_MODEL: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This model is not one your company registered for its own endpoint." });
/** DEC 238: the company chose its own Bedrock but has no connection saved. Nothing held or sent; no fallback. */
export const BYO_BEDROCK_NOT_CONNECTED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Connect your Bedrock: this company chose its own Bedrock for its agents, and no AWS role is connected." });
/** DEC 238: a model the company did not pick when it connected its Bedrock. Before any hold. */
export const BYO_BEDROCK_MODEL: GuardFailure = Object.freeze({ ok: false as const, status: 400, code: "invalid_request", message: "This model is not one your company picked for its Bedrock connection." });
/** DEC 238: AWS refused Rovara's use of the company's role (trust changed, role deleted, or no permission). Free. */
export const BYO_BEDROCK_REFUSED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Check your Bedrock connection: AWS refused Rovara's use of your company's role. Test the connection again in settings." });
/** DEC 238: the model is picked but not enabled yet in the company's AWS account (its one-time access or Marketplace step). Free. */
export const BYO_BEDROCK_MODEL_NOT_ENABLED: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "model_not_enabled", message: "This model is not enabled yet in your company's AWS account. An AWS admin opens it once in the Bedrock console, then try again." });
/**
 * Bedrock throttled a call in the company's OWN account (HTTP 429): a model whose tokens-per-minute quota there is 0 answers every call this way. The Region
 * comes from the company's own saved connection (a validated Region name), never from the request or the answer. Free; Anthropic's `rate_limit_error` type.
 */
export const byoBedrockQuota = (region: string): RouteRefusal => Object.freeze({ ok: false as const, status: 429, code: "rate_limit_error", message: `Your AWS account has no Bedrock room for this model in ${region}: its quota is used up or set to 0. Choose another model, or ask AWS to raise the quota (Service Quotas).` });
/** DEC 240: the company chose Rovara's AI, and this gateway does not offer it. Nothing held or sent; no fallback to its key. */
export const ROVARA_AI_OFF: RouteRefusal = Object.freeze({ ok: false as const, status: 403, code: "no_ai_key", message: "Choose AI for your agents: Rovara's AI is not available on this install." });
/** The agent route: Anthropic Messages, the R3a behaviour exactly; on the company's own key when `agentKeys` is set (DEC 236). */
export function agentRoute(deps: GatewayDependencies): GatewayRoute {
  return deps.agentKeys !== undefined ? companyKeyAgentRoute(deps, deps.agentKeys) : installKeyAgentRoute(deps);
}
function installKeyAgentRoute(deps: GatewayDependencies): GatewayRoute {
  return {
    provider: "anthropic", product: false, meter: deps.meter, prefix: PREFIX,
    guard: (bytes, headers, claims) => guardRequest(bytes, headers, claims.mdl, deps.modelLimits),
    // The signed payer owns the budget; `claims.per` remains the requester for audit/key lookup.
    scope: (claims) => ({ iss: claims.iss, cid: claims.cid, pid: claims.pid, tid: claims.tid, ...(claims.pay.kind === "member" ? { per: claims.pay.developerId } : {}) }),
    caps: (scope, _claims, signal) => deps.caps.capsFor(scope, signal),
    key: (claims, signal) => deps.keys.keyFor(claims, "anthropic", signal),
    transport: deps.transport,
    usage: () => new UsageCollector(),
    // An explicit rejection before any output uses the not-sent accounting rule for BOTH input and output.
    providerFailure: (status) => ({ charged: !(status === 429 || status === 529), refusal: { ok: false, status: 502, code: "provider_error", message: "provider unavailable" } }),
  };
}
/**
 * The agent route in company-key mode (DEC 236): the same guard, scope, caps (the combined company cap), meter, transport and usage
 * as the install-key route, but the key is ONLY the company's own connected key. Admission reads whether one is connected before
 * any hold; the key itself is read just before sending, and a key that went missing meanwhile is "not sent" ($0). The install key
 * (`deps.keys`) is never called, so there is no fallback to Rovara's account.
 */
function companyKeyAgentRoute(deps: GatewayDependencies, keys: LearningKeySource): GatewayRoute {
  const base = installKeyAgentRoute(deps);
  let admitted = false;
  let chargeSource: ChargeSource | undefined;
  let boundKey: (() => Promise<string | undefined>) | undefined;
  type Connection = { chargeSource?: ChargeSource; boundKey?: () => Promise<string | undefined> };
  const connect = async (claims: TaskClaims, provider: Parameters<LearningKeySource["connected"]>[2], signal: AbortSignal): Promise<Connection | undefined> => {
    if ((deps.chargeReceipts !== undefined || claims.runPrice !== undefined) && keys.resolveForCharge !== undefined) {
      const saved = await keys.resolveForCharge(claims.iss, claims.cid, provider, signal);
      if (saved === undefined) return undefined;
      return { chargeSource: { source: saved.source, billing: "external_provider" }, boundKey: () => saved.key() };
    }
    return await keys.connected(claims.iss, claims.cid, provider, signal) ? {} : undefined;
  };
  const bind = (connection: Connection): void => { chargeSource = connection.chargeSource; boundKey = connection.boundKey; };
  let notSent: RouteRefusal | undefined;
  // DEC 240: set by admit when the company chose Rovara's AI; then the company's key is never read.
  let rovara: { ai: RovaraAi; marker: string } | undefined;
  // DEC 238: set by admit when the company chose its own Bedrock; then neither its key nor Rovara's account is used.
  let byo: { deps: ByoBedrock; row: Parameters<ByoBedrock["sessions"]["credentials"]>[0]; connection: Parameters<ByoBedrock["sessions"]["credentials"]>[1]; marker: string; transport: ProviderTransport; credentials?: AwsCredentials } | undefined;
  // DEC 254t (A2): set by admit when the company chose its own OpenAI or OpenRouter key; then only that provider's account is read.
  let chat: { provider: OpenAiAgentProvider; ai: CompanyChatAi } | undefined;
  let claimsOf: TaskClaims | undefined;
  // DEC 254t (A3): set by admit when the company chose its own endpoint (its sealed connection, opened for this company only).
  let endpoint: { ai: CompanyEndpointAi; connection: EndpointConnection; target: EndpointTarget; transport: ProviderTransport; model?: EndpointModel; refused?: "address" | "busy" } | undefined;
  type Candidate = { admit(): void } | { refusal: RouteRefusal; hard: boolean };
  const soft = (refusal: RouteRefusal): Candidate => ({ refusal, hard: false });
  const hard = (refusal: RouteRefusal): Candidate => ({ refusal, hard: true });
  // DEC 254zzz84(4): only while the company saved a fallback is the token's model checked here (`checkModel`); every model the token allows must be served.
  const serves = (checkModel: boolean, claims: TaskClaims, has: (model: string) => boolean): boolean => !checkModel || claims.mdl.every(has);
  /**
   * Whether one saved source can take this call, and how to admit it. Nothing is set on the route until `admit` runs, so a source passed over leaves
   * no state behind. `hard`: a read failed (or answered something unreadable): the call is refused, never tried on the next source.
   */
  async function candidate(choice: NonNullable<GatewayDependencies["agentAi"]>, source: AgentAiSource, claims: TaskClaims, signal: AbortSignal, checkModel: boolean): Promise<Candidate> {
    if (!agentSourceSwitchedOn(source, choice.switchedOn ?? NOTHING_SWITCHED_ON)) return soft(AGENT_SOURCE_SWITCHED_OFF);
    // A source this route does not serve is never sent on another one's key (no fallback to the company's Anthropic key).
    if (!(AGENT_AI_SOURCES as readonly string[]).includes(source)) return hard(AGENT_UNAVAILABLE);
    if (source === "openrouter_key" && checkModel && claims.mdl.some(model => !model.includes("/"))) return soft(AGENT_MODEL_NOT_SERVED);
    // Reviewer grants never authorize a source reporting its own cost, with or without
    // ordinary run-price authority. Preserve the reviewer refusal before key/price reads.
    if (source === "openrouter_key" && claims.reviewer !== undefined) return hard(REVIEWER_CEILING_REFUSED);
    if (source === "openrouter_key" && claims.runPrice === undefined) return hard({ ok: false, status: 409, code: "run_price_authorization_required", message: "Authorize the current AI source and price before this run.", reason: "signed_price_missing" });
    if (source === "bedrock_byo") {
      if (choice.byo === undefined) return soft(AGENT_SOURCE_NOT_OFFERED);
      // Only the verified company's own connection (the token's iss and cid), never another company's.
      let found;
      try { found = await choice.byo.connection(claims.iss, claims.cid, signal); } catch { return hard(AGENT_UNAVAILABLE); }
      if (found === undefined) return soft(BYO_BEDROCK_NOT_CONNECTED);
      const models = found.connection.models;
      if (!serves(checkModel, claims, (m) => Object.hasOwn(models, m) && BEDROCK_CLAUDE_ID.test(models[m]!))) return soft(AGENT_MODEL_NOT_SERVED);
      const byoDeps = choice.byo, connected = found;
      return { admit() {
        const state = { deps: byoDeps, row: connected.row, connection: connected.connection, marker: `byo-bedrock-${randomUUID()}` } as NonNullable<typeof byo>;
        // The transport signs with the session `key` assumed (after the hold); without one, nothing is sent.
        state.transport = byoDeps.transport(connected.connection.region, async () => { if (state.credentials === undefined) throw new Error("no session"); return state.credentials; });
        byo = state;
        chargeSource = { source: { kind: "company_key", id: connected.row.sourceId, name: "Company Bedrock", provider: "bedrock", connectionRevision: connected.row.versionId }, billing: "external_provider" };
      } };
    }
    if (source === "custom_endpoint") {
      const ai = choice.endpoint;
      if (ai === undefined) return soft(AGENT_CHAT_NOT_OFFERED);
      // Only the verified company's own endpoint account; read now because the guard needs its models (the key stays in this call's memory).
      let text: string | undefined, connected: Connection | undefined;
      try {
        connected = await connect(claims, "endpoint", signal);
        if (connected === undefined) return soft(AGENT_KEY_MISSING);
        text = await (connected.boundKey?.() ?? keys.keyFor(claims.iss, claims.cid, "endpoint", signal));
      } catch { return hard(AGENT_UNAVAILABLE); }
      if (text === undefined) return soft(AGENT_KEY_MISSING);
      const connection = parseEndpointConnect(text);
      if (connection === undefined) return hard(AGENT_UNAVAILABLE);
      const target = endpointTarget(connection.baseUrl);
      if (target === undefined) return soft(ENDPOINT_REFUSED);
      if (!serves(checkModel, claims, (m) => connection.models.some((entry) => entry.name === m))) return soft(AGENT_MODEL_NOT_SERVED);
      const saved = connected;
      return { admit() {
        bind(saved);
        const state = { ai, connection, target } as NonNullable<typeof endpoint>;
        state.transport = ai.transport(target, (reason) => { state.refused = reason; }, claims.cid);
        endpoint = state;
      } };
    }
    if (source === "openai_key" || source === "openrouter_key") {
      const provider: OpenAiAgentProvider = source === "openai_key" ? "openai" : "openrouter";
      if (provider === "openrouter" && (deps.chargeReceipts === undefined || deps.meter.settleV2 === undefined)) return hard(AGENT_UNAVAILABLE);
      if (provider === "openrouter" && claims.mdl.some(m => openRouterPolicy(m, (deps.now ?? Date.now)(), deps.openRouterTariffs) === undefined)) return soft(AGENT_MODEL_NOT_SERVED);
      const ai = choice[provider];
      if (ai === undefined) return soft(AGENT_CHAT_NOT_OFFERED);
      // Only the verified company's own account of THAT provider (an Anthropic key is never a stand-in).
      let connected: Connection | undefined;
      try { connected = await connect(claims, provider, signal); if (connected === undefined) return soft(AGENT_KEY_MISSING); }
      catch { return hard(AGENT_UNAVAILABLE); }
      if (!serves(checkModel, claims, (m) => provider === "openai" ? OPENAI_KEY_AGENT_MODELS.includes(m) : openRouterPolicy(m, (deps.now ?? Date.now)(), deps.openRouterTariffs) !== undefined)) return soft(AGENT_MODEL_NOT_SERVED);
      const saved = connected;
      return { admit() { bind(saved); chat = { provider, ai }; } };
    }
    if (source === "rovara") {
      const ai = choice.rovara;
      if (ai === undefined) return soft(ROVARA_AI_OFF);
      // DEC 254zzz263 supersedes round C R2-M2: non-exempt companies use this source billed as customer, under the same caps.
      if (!serves(checkModel, claims, (m) => ai.models.has(m) && choice.rovaraDisabled?.has(m) !== true)) return soft(AGENT_MODEL_NOT_SERVED);
      // A per-call marker stands in for a key: the transport signs with the task role, and no key exists to leak.
      return { admit() {
        rovara = { ai, marker: `rovara-ai-${randomUUID()}` };
        // Rovara has no company credential: pin the offered model configuration itself.
        chargeSource = rovaraChargeSource(ai, claims.cid);
      } };
    }
    // anthropic_key: the company's own Anthropic key (DEC 236).
    let connected: Connection | undefined;
    try { connected = await connect(claims, "anthropic", signal); if (connected === undefined) return soft(AGENT_KEY_MISSING); }
    catch { return hard(AGENT_UNAVAILABLE); }
    if (!serves(checkModel, claims, (m) => ANTHROPIC_KEY_AGENT_MODELS.includes(m))) return soft(AGENT_MODEL_NOT_SERVED);
    const saved = connected;
    return { admit() { bind(saved); } };
  }
  return {
    ...base,
    reviewerGrants: true as const,
    get chargeSource() { return chargeSource; },
    // The source word this call was admitted on (log only); nothing before admit has chosen one.
    get payer() { return !admitted ? undefined : rovara !== undefined ? "rovara" : byo !== undefined ? "bedrock_byo" : chat !== undefined ? `${chat.provider}_key` : endpoint !== undefined ? "custom_endpoint" : "anthropic_key"; },
    // An endpoint call is priced as the catalog model each registered model stands for.
    get provider() { return endpoint !== undefined ? endpoint.model?.catalog.provider ?? "endpoint" : chat !== undefined ? chat.provider : rovara === undefined && byo === undefined ? base.provider : "bedrock"; },
    get transport() { return endpoint !== undefined ? endpoint.transport : chat !== undefined ? chat.ai.transport : byo !== undefined ? byo.transport : rovara === undefined ? base.transport : rovara.ai.transport; },
    // Bedrock's refusal: its first bytes, only to tell "model not enabled yet" apart (never echoed or logged).
    get failureBody() { return rovara !== undefined || byo !== undefined; },
    // Bedrock on Rovara's own account: a call that fails after it was sent settles at what was used (failed-call.ts).
    get settlesFailedCalls() { return rovara !== undefined ? true as const : undefined; },
    async admit(claims, signal) {
      claimsOf = claims;
      const choice = deps.agentAi;
      let via: AgentSourceVia = "none";
      if (choice !== undefined) {
        let resolved: ResolvedAgentSource;
        // DEC 254zzz263: saved choice/order wins; no choice defaults to company-billed Rovara AI.
        try { resolved = await resolveAgentSource({ sources: choice.sources, ...(choice.rovara === undefined ? {} : { exempt: choice.rovara.exempt }), keys }, claims.iss, claims.cid, signal); } catch { return AGENT_UNAVAILABLE; }
        via = resolved.via;
        if (resolved.source !== undefined) {
          // DEC 254zzz84(4): the company's saved order, first choice first. Without a saved fallback this is the first choice alone, exactly as before.
          // With one, a source is passed over only when it is plainly not usable for THIS call (switched off, not offered here, not connected, or it
          // does not serve the token's model); a read that fails refuses the call at once (never guessed onto the next source). Decided before any
          // hold or send: one call goes out on one source, and a provider's answer never moves it to another.
          const order = [resolved.source, ...(resolved.fallback ?? [])];
          const fallingBack = order.length > 1;
          let first: RouteRefusal | undefined;
          for (const [index, source] of order.entries()) {
            const outcome = await candidate(choice, source, claims, signal, fallingBack);
            if ("admit" in outcome) {
              outcome.admit();
              admitted = true;
              // The source this call is admitted on, once, for the audit: ids and words only.
              deps.log({ event: "agent_source", company: claims.cid, source: source === "anthropic_key" ? "company_key" : source, via: index === 0 ? via : "fallback" });
              return undefined;
            }
            if (outcome.hard || !fallingBack) return outcome.refusal;
            first ??= outcome.refusal;
          }
          return first ?? AGENT_UNAVAILABLE;
        }
      }
      try {
        const connected = await connect(claims, "anthropic", signal);
        if (connected === undefined) return AGENT_KEY_MISSING;
        bind(connected);
      } catch { return AGENT_UNAVAILABLE; }
      admitted = true;
      deps.log({ event: "agent_source", company: claims.cid, source: "company_key", via });
      return undefined;
    },
    guard(bytes, headers, claims) {
      const checked = base.guard(bytes, headers, claims);
      if (endpoint !== undefined && checked.ok) {
        // Only a model the company registered, sent under the name the endpoint serves it by, priced and limited as its catalog model.
        const model = endpoint.connection.models.find((m) => m.name === checked.model);
        if (model === undefined) return ENDPOINT_MODEL;
        let limit: unknown;
        try { limit = endpoint.ai.maxOutputTokens?.(model.catalog.provider, model.catalog.modelId); } catch { limit = undefined; }
        const maxTokens = Math.min(checked.maxTokens, typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS);
        let translated: Record<string, unknown> | undefined;
        try { translated = toChatCompletions(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>, model.name, maxTokens, "endpoint"); } catch { translated = undefined; }
        if (translated === undefined) return AGENT_CHAT_FEATURE;
        let forwarded: Buffer;
        try { forwarded = Buffer.from(JSON.stringify(translated)); } catch { return AGENT_CHAT_FEATURE; }
        endpoint.model = model;
        // Chat Completions drops the Anthropic cache markers; this outgoing request cannot request cache writes.
        return { ...checked, usesPromptCache: false, model: model.catalog.modelId, maxTokens, bytes: forwarded, headers: { "content-type": "application/json" }, path: endpoint.target.path };
      }
      if (chat !== undefined && checked.ok) {
        if (!OPENAI_AGENT_MODEL.test(checked.model)) return AGENT_CHAT_FEATURE;
        // Held to the model's own output limit (the price snapshot's row for this provider), else the default.
        let limit: unknown;
        try { limit = chat.ai.maxOutputTokens?.(checked.model); } catch { limit = undefined; }
        // OpenRouter: read the installed row ONCE. No row (or an expired one) refuses here, before anything is translated.
        const policy = chat.provider === "openrouter" ? openRouterPolicy(checked.model, (deps.now ?? Date.now)(), deps.openRouterTariffs) : undefined;
        if (chat.provider === "openrouter" && policy === undefined) return AGENT_CHAT_FEATURE;
        // Ruling (b): a larger request is CLAMPED to the row's ceiling (the dearest output the hold, the wire cap and the proof cover), never refused.
        // The clamped value is what the hold, appliedMaxOutputTokens and the forwarded body all use.
        const maxTokens = Math.min(checked.maxTokens, typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : OPENAI_AGENT_DEFAULT_MAX_OUTPUT_TOKENS, policy?.max_completion_tokens ?? Number.POSITIVE_INFINITY);
        let translated: Record<string, unknown> | undefined;
        try { translated = toChatCompletions(JSON.parse(checked.bytes.toString("utf8")) as Record<string, unknown>, checked.model, maxTokens, chat.provider, policy); } catch { translated = undefined; }
        if (translated === undefined) return AGENT_CHAT_FEATURE;
        let forwarded: Buffer;
        try { forwarded = Buffer.from(JSON.stringify(translated)); } catch { return AGENT_CHAT_FEATURE; }
        // Keep admission tied to the translated body, which carries no prompt-cache write controls.
        return { ...checked, usesPromptCache: false, maxTokens, bytes: forwarded, headers: { "content-type": "application/json" }, path: OPENAI_AGENT_UPSTREAM[chat.provider].path };
      }
      if (byo !== undefined && checked.ok) {
        // Only a model the company picked, sent as the Claude id or profile it picked for it (Claude only in slice 1).
        const id = Object.hasOwn(byo.connection.models, checked.model) ? byo.connection.models[checked.model] : undefined;
        if (id === undefined || !BEDROCK_CLAUDE_ID.test(id)) return BYO_BEDROCK_MODEL;
        return invokeCall(checked, id);
      }
      if (rovara === undefined || !checked.ok) return checked;
      return rovaraGuard(checked, rovara.ai);
    },
    // DEC 238: the company's own Bedrock is priced at the dearer of its Bedrock row and the Anthropic row of the model it stands for
    // (like Vertex's), so the cap never counts less than either list price.
    alsoPricedAs(model) {
      if (byo === undefined) return [];
      return Object.entries(byo.connection.models).filter(([, id]) => id === model).map(([name]) => ({ provider: "anthropic", model: name }));
    },
    line(claims, model) {
      if (rovara === undefined) return undefined;
      return { source: "rovara_ai", charge: rovara.ai.exempt.has(claims.cid) ? "exempt" : "customer", model };
    },
    async key(claims, signal) {
      if (!admitted) return "";
      if (rovara !== undefined) return rovara.marker;
      if (endpoint !== undefined) return endpoint.connection.key;
      if (byo !== undefined) {
        // The customer's role as THIS company (after the hold): a refusal is "not sent" ($0), in its own words.
        let got;
        try { got = await byo.deps.sessions.credentials(byo.row, byo.connection, signal); } catch { notSent = AGENT_UNAVAILABLE; return ""; }
        if (!got.ok) {
          notSent = got.reason === "refused" ? BYO_BEDROCK_REFUSED : AGENT_UNAVAILABLE;
          if (got.reason === "refused") await byo.deps.refused?.(claims.iss, claims.cid, byo.row).catch(() => undefined);
          return "";
        }
        byo.credentials = got.credentials;
        return byo.marker;
      }
      let key: string | undefined;
      try { key = await (boundKey?.() ?? keys.keyFor(claims.iss, claims.cid, chat?.provider ?? "anthropic", signal)); } catch { notSent = AGENT_UNAVAILABLE; return ""; }
      if (key === undefined) { notSent = AGENT_KEY_MISSING; return ""; }
      return key;
    },
    // The endpoint's DNS answered an address the guard refuses: nothing was sent, in fixed words.
    notSent: () => endpoint?.refused === "address" ? ENDPOINT_REFUSED : endpoint?.refused === "busy" ? ENDPOINT_BUSY : notSent,
    providerFailure: (status, body) => {
      if (endpoint !== undefined) {
        // An error answer (a redirect included: never followed) carries no output: never charged. A refused key is the company's to fix.
        if (status === 401 || status === 403) {
          if (claimsOf !== undefined) { const who = claimsOf; void (async () => { try { await keys.refused?.(who.iss, who.cid, "endpoint"); } catch { /* a warning never changes a call */ } })(); }
          return { charged: false, refusal: AGENT_KEY_REFUSED };
        }
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      if (chat !== undefined) {
        // An error answer carries no output (OpenAI and OpenRouter bill only what they generate): never charged. A refused key is the
        // company's to fix (marked on its settings page), in fixed words; nothing from the answer is echoed.
        if (status === 401 || status === 403) {
          if (claimsOf !== undefined) { const who = claimsOf; void (async () => { try { await keys.refused?.(who.iss, who.cid, chat.provider); } catch { /* a warning never changes a call */ } })(); }
          return { charged: false, refusal: AGENT_KEY_REFUSED };
        }
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      if (byo !== undefined) {
        // A Bedrock error answer carries no output: nothing used, never charged (AWS bills the customer only for what it generated).
        // A refusal of the role means the session is no longer good: the next call assumes it again.
        if (status === 403 && body !== undefined && BEDROCK_MODEL_ACCESS_WORDS.test(Buffer.from(body).toString("utf8"))) return { charged: false, refusal: BYO_BEDROCK_MODEL_NOT_ENABLED };
        if (status === 401 || status === 403) { byo.deps.sessions.forget(byo.row); void byo.deps.refused?.(byo.row.iss, byo.row.cid, byo.row).catch(() => undefined); return { charged: false, refusal: BYO_BEDROCK_REFUSED }; }
        if (status === 429 && BEDROCK_BYO_REGION.test(byo.connection.region)) return { charged: false, refusal: byoBedrockQuota(byo.connection.region), reason: "bedrock_429" };
        return { charged: false, refusal: PROVIDER_ERROR };
      }
      if (rovara !== undefined) return rovaraProviderFailure(status, body);
      // The provider refused the company's key: an explicit rejection before any generation, free; the company must connect a working key.
      return status === 401 || status === 403 ? { charged: false, refusal: AGENT_KEY_REFUSED } : base.providerFailure(status, body);
    },
  };
}
/** A not_found refusal's method and pathname for the log: at most 120 printable ASCII characters, the query only as a yes/no. */
function notFoundWhere(request: GatewayRequest): Pick<RefusedLog, "method" | "path" | "query"> {
  const at = request.url.indexOf("?");
  const path = (at < 0 ? request.url : request.url.slice(0, at)).replace(/[^\x21-\x7e]/gu, "?").slice(0, 120);
  return { method: String(request.method).replace(/[^A-Z]/gu, "").slice(0, 10), path, query: at >= 0 };
}
/** The agent route with the one query the Anthropic SDK beta client adds. */
const AGENT_BETA_URL = "/v1/messages?beta=true";
/** The purpose a step reserves (learning, answers), or undefined for any task step. */
const tokenPurpose = (step: string): "learning" | "answers" | undefined => step === LEARNING_STEP ? "learning" : step === ANSWERS_STEP ? "answers" : undefined;
function routeFor(deps: GatewayDependencies, request: GatewayRequest): GatewayRoute | ProductControl | undefined {
  if (request.method !== "POST") return undefined;
  // The Anthropic SDK's beta client (Pi's anthropic-messages runtime on hosted workers) posts to /v1/messages?beta=true. Accept exactly that
  // one query besides the bare path; any other query stays not_found.
  if (request.url === "/v1/messages" || request.url === AGENT_BETA_URL) return agentRoute(deps);
  if (request.url.startsWith(LEARNING_PATH_PREFIX)) {
    if (request.url.length > 2048) return undefined;
    const at = request.url.indexOf("?");
    try { return deps.learning?.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1)); } catch { return undefined; }
  }
  if (request.url.startsWith(ANSWERS_PATH_PREFIX)) {
    if (request.url.length > 2048) return undefined;
    const at = request.url.indexOf("?");
    try { return deps.answers?.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1)); } catch { return undefined; }
  }
  if (deps.product === undefined || !request.url.startsWith(PRODUCT_ROUTE_PREFIX) || request.url.length > 2048) return undefined;
  const at = request.url.indexOf("?");
  try { return deps.product.route(at < 0 ? request.url : request.url.slice(0, at), at < 0 ? "" : request.url.slice(at + 1), request.headers); } catch { return undefined; }
}
/** Core also used directly by the in-process harness. One deadline covers request, dependencies, transport, streaming and backpressure. */
export async function handleGateway(deps: GatewayDependencies, request: GatewayRequest, sink: GatewaySink): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(); request.signal?.addEventListener("abort", abort, { once: true });
  const now = deps.now ?? Date.now;
  const duration = Math.min(deps.timeoutMs ?? CALL_HARD_CEILING_MS, CALL_HARD_CEILING_MS);
  const startedAt = now();
  let deadline = startedAt + duration;
  let endedTimer: ReturnType<typeof setTimeout> | undefined;
  let timer = setTimeout(abort, duration);
  const shortenDeadline = (end: number) => {
    deadline = Math.min(deadline, end);
    clearTimeout(timer); timer = setTimeout(abort, Math.max(0, deadline - now()));
  };
  let rejectAbort!: (reason: Error) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  // Observe the rejection even if abort happens while awaiting a non-cancellable meter transaction.
  void aborted.catch(() => undefined);
  const onAbort = () => rejectAbort(new Error("provider unavailable"));
  controller.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) abort();
  const wait = async <T>(operation: Promise<T>): Promise<T> => {
    if (now() >= deadline || controller.signal.aborted) { void operation.catch(() => undefined); abort(); throw new Error("provider unavailable"); }
    return Promise.race([operation, aborted]);
  };
  const log = (event: GatewayLogEvent) => { try { deps.log?.(event); } catch { /* Observability never changes settlement. */ } };
  let head = false;
  let reservation: Reservation | undefined;
  let route: GatewayRoute | undefined;
  let callClaims: TaskClaims | undefined;
  let cost = 0;
  let estimated = true;
  let appliedMaxOutputTokens = 0;
  let reservedMicros = 0;
  let charge: ChargeReceiptV1 | undefined;
  let customerReview = false;
  // DEC 254zzz41: a review's first call holds the grant's whole ceiling (`held`) and opens the session that keeps it (`heldKept`); every call of a review debits that session
  // and holds nothing of its own (`sessionCall`: what it debited and gives back when it finishes).
  let held: Reservation | undefined; let heldKept = false; let pendingOpen: Promise<unknown> | undefined;
  let sessionCall: { debited: number; claims: TaskClaims } | undefined;
  let provider: ProviderResponse | undefined;
  let settlementPrice: ResolvedPrice | undefined;
  let settlementUsage: TokenUsage | undefined;
  let settlementReported: number | undefined;
  let settlementModel: string | undefined;
  let settlementKind: PriceKind = "chat";
  let cacheWritesForbidden = false;
  const unexpectedRouterWrite = (value: TokenUsage | undefined): boolean => cacheWritesForbidden && (value?.cacheWrite ?? 0) > 0;
  // How the call ended, for an events route's settle: the refusal word last answered, or a complete answer.
  let refusedCode: string | undefined; let completed = false;
  let early: TokenUsage | undefined;
  let usage: UsageReader | undefined;
  // How a call that failed after it was sent ended (failed-call.ts): who stopped it, how far it got, and what the hold counted as input.
  let failure: { cause: FailedCallCause; phase: FailedCallPhase } | undefined;
  let providerFault = false; let stoppedByUs = false; let received = 0; let streamed = false;
  let failureInput: { bytes: number; fixedTokens: number; media: MediaEstimate | undefined; plainInput: boolean; reasoningUnseen: boolean } | undefined;
  let answerBroke = false;
  // The settle, run once: early for a route that sends its cost in the head, else in the finally. Its result says what was written.
  let settled: { ok: boolean; micros: number; estimated: boolean } | undefined; let settling = false;
  // How far the answer got: the larger of what the usage reader saw in the stream passed on and what the transport saw as it read it (reasoning and held text included).
  // UNDEFINED when neither counts progress (the OpenAI, Gemini and product-Bedrock readers do not): the caller then uses the bytes received, never "nothing came" (an under-count).
  const streamProgress = (): StreamProgress | undefined => {
    let a: StreamProgress | undefined; let b: StreamProgress | undefined;
    try { a = usage?.progress?.(); } catch { a = undefined; }
    try { b = provider?.progress?.(); } catch { b = undefined; }
    if (a === undefined && b === undefined) return undefined;
    return { events: Math.max(a?.events ?? 0, b?.events ?? 0), outputBytes: Math.max(a?.outputBytes ?? 0, b?.outputBytes ?? 0) };
  };
  const settleOnce = async (): Promise<{ ok: boolean; micros: number; estimated: boolean } | undefined> => {
    if (settling || (reservation === undefined && sessionCall === undefined) || route === undefined) return settled;
    settling = true;
    try {
      // Negotiated receipts may use authoritative provider money independently of token coverage.
      if (charge !== undefined && settlementReported === undefined) {
        try { const reported = provider?.reportedCostMicros?.(); if (typeof reported === "number" && Number.isSafeInteger(reported) && reported > 0) settlementReported = reported; } catch { /* Missing evidence remains provisional. */ }
      }
      // A call WE cut (client left, deadline, task ended: cause "aborted") on the company's own key that had ALREADY read the provider's complete usage
      // (the stream's last usage event, or a whole answer read in full before the client left) settles at that ACTUAL usage (DEC 254zzz521), never an estimate.
      // OpenRouter only with its complete reported cost (tokens alone cannot release its fees: that call is an estimate of use below). Rovara's own Bedrock is unchanged.
      if (failure?.cause === "aborted" && route.settlesFailedCalls !== true && !completed && settlementUsage === undefined && usage !== undefined) {
        let routerCostKnown = route.provider !== "openrouter";
        if (!routerCostKnown) { try { routerCostKnown = settlementReported !== undefined && provider?.reportedCostComplete?.() !== false; } catch { routerCostKnown = false; } }
        if (routerCostKnown) { try { const known = usage.finish(); if (known !== undefined && validUsage(known) && hasUsage(known)) settlementUsage = known; } catch { /* Unreadable usage is no usage: the estimate of use below. */ } }
      }
      // Tokens cannot release OpenRouter request/cache fees, but remain evidence of an above-hold debit.
      let retainMissingUsage = callClaims?.runPrice !== undefined && (!validUsage(settlementUsage) || !hasUsage(settlementUsage));
      if (route.provider === "openrouter") {
        let complete = false;
        try { complete = provider?.reportedCostComplete?.() !== false; } catch { /* An unreadable provenance keeps the hold. */ }
        if (settlementReported === undefined || !complete || unexpectedRouterWrite(settlementUsage)) retainMissingUsage = true;
      }
      // A failed OpenRouter call that RECEIVED its complete, final reported cost (the usage chunk arrived after the answer ended, then the stream broke, or WE cut the call after it) settles at that cost
      // when it is within the hold; above the hold it keeps the known-debit rule (estimated, above the hold, alarm and source stop) as before, logged `failed: true`.
      // Only when the PROVIDER's stream broke or WE cut it, and no token usage was read (a fault of the gateway's own keeps the hold),
      // and not for a cache write the route forbids (it keeps the debit rule above). A call with no / incomplete reported cost is an estimate of use below (a provider-broken stream keeps the hold).
      let failedWithReportedCost = false;
      if (route.provider === "openrouter" && (failure?.cause === "provider" || failure?.cause === "aborted") && !completed && (settlementUsage === undefined || !hasUsage(settlementUsage)) && charge?.billing === "external_provider" && settlementReported !== undefined && !unexpectedRouterWrite(settlementUsage)) {
        try { failedWithReportedCost = provider?.reportedCostComplete?.() === true && provider.reportedCostFinal?.() === true; } catch { failedWithReportedCost = false; }
      }
      let estimateRecord: EstimatedSettlement | undefined;
      // A call that failed after it was sent and reported no usage: what was used, not the hold (a free call is the not-sent receipt below). Rovara's own Bedrock: any failure
      // after the send; every other route (the company's own key): a call WE cut (cutCallMicros), the one place the task-end cut, a client disconnect and the deadline settle.
      let failedMicros: number | undefined;
      if (failure !== undefined && cost > 0 && !completed && settlementUsage === undefined && !failedWithReportedCost && settlementPrice !== undefined && failureInput !== undefined) {
        const measured = usage?.actualInputTokens?.(); const progress = streamProgress();
        failedMicros = cutCallMicros({ ownBedrock: route.settlesFailedCalls === true, ...failure, inputBytes: failureInput.bytes, fixedInputTokens: failureInput.fixedTokens, media: failureInput.media, ...(measured === undefined ? {} : { inputTokens: measured }), outputBytes: failure.phase === "after_output" ? Math.max(progress?.outputBytes ?? 0, progress === undefined || !streamed ? received : 0) : 0, ...(progress === undefined ? { outputBytesPerToken: FAILED_CALL_RECEIVED_BYTES_PER_TOKEN } : {}), reasoningUnseen: failureInput.reasoningUnseen, wholeAnswer: !streamed && provider !== undefined, price: settlementPrice, plainInput: failureInput.plainInput, reservationMicros: reservedMicros });
      }
      if (failedMicros !== undefined) {
        cost = failedMicros; estimated = failedMicros > 0;
        if (failedMicros > 0 && settlementPrice !== undefined && settlementModel !== undefined) estimateRecord = { provider: route.provider, model: settlementModel, kind: settlementKind, settledAt: now(), priceVersion: settlementPrice.priceVersion ?? 0 };
      } else if (cost > 0 && settlementPrice !== undefined && settlementModel !== undefined) {
        const amount = settleAmount({ ...(settlementUsage === undefined ? {} : { usage: settlementUsage }), ...(settlementReported === undefined ? {} : { reportedCostMicros: settlementReported }), price: settlementPrice, reservationMicros: reservedMicros, retainMissingUsage, failedWithReportedCost });
        cost = amount.actualMicros; estimated = amount.estimated;
        // Customer Bedrock reviews record the true bill like every customer call; other review sources retain their ceiling clamp.
        if (callClaims?.reviewer !== undefined && route.payer !== "bedrock_byo" && cost > reservedMicros) cost = reservedMicros;
        if (estimated) estimateRecord = { provider: route.provider, model: settlementModel, kind: settlementKind, settledAt: now(), priceVersion: settlementPrice.priceVersion ?? 0, ...(amount.usage === undefined ? {} : { usage: amount.usage }) };
      }
      if (charge !== undefined && reservation !== undefined && route.meter.settleV2 !== undefined && settlementPrice !== undefined) {
        const receipt = finishCharge(charge, { ...(settlementUsage === undefined ? {} : { usage: settlementUsage }), ...(settlementReported === undefined ? {} : { reportedCostMicros: settlementReported }), price: settlementPrice, retainMissingUsage, failedWithReportedCost, customerPriceAuthorized: callClaims?.runPrice !== undefined, notSent: cost === 0, now: now(), ...(failedMicros === undefined ? {} : { failedMicros }) });
        // Record the customer's true bill, even above the hold. The meter atomically latches overrun.
        const observed = chargeValue(receipt.amountMicros)!;
        if (receipt.billing === "external_provider" && (route.payer === "bedrock_byo" || route.provider === "openrouter") && callClaims !== undefined && observed > reservedMicros) {
          log({ event: "customer_source_over_reservation", source: route.payer === "bedrock_byo" ? "bedrock_byo" : "openrouter", company: callClaims.cid, costMicros: observed, heldMicros: reservedMicros, overageMicros: observed - reservedMicros });
        }
        const actualInputTokens = usage?.actualInputTokens?.();
        await route.meter.settleV2({ reservationId: reservation.id, receipt, ...(actualInputTokens === undefined ? {} : { actualInputTokens }), ...(cacheWritesForbidden ? { noWriteRoute: true } : {}) });
        cost = chargeValue(receipt.amountMicros)!; estimated = receipt.status !== "final";
        if (route.provider === "openrouter" && cost > reservedMicros) log({ event: "openrouter_over_reservation", costMicros: cost, holdMicros: reservedMicros, sourceId: receipt.source.id, ...(failedWithReportedCost ? { failed: true as const } : {}) });
        if (customerReview && sessionCall !== undefined) await deps.reviewerGrants?.giveBack(sessionCall.claims.iss, sessionCall.claims.cid, sessionCall.claims.jti, Math.max(0, sessionCall.debited - cost));
      } else if (sessionCall !== undefined) await deps.reviewerGrants?.giveBack(sessionCall.claims.iss, sessionCall.claims.cid, sessionCall.claims.jti, Math.max(0, sessionCall.debited - cost)); else await route.meter.settle(reservation!, cost, estimateRecord); log({ event: "settled", costMicros: cost, estimated, appliedMaxOutputTokens, ...(route.product ? { route: "product" as const } : route.purpose === undefined ? {} : { route: route.purpose }) });
      settled = { ok: true, micros: cost, estimated };
      if (route.overReservation !== undefined && callClaims !== undefined && cost > reservedMicros) {
        log({ event: "product_over_reservation" });
        try { await route.overReservation(callClaims); } catch { log({ event: "settle_failed" }); }
      }
    }
    catch { log({ event: "settle_failed" }); settled ??= { ok: false, micros: cost, estimated }; } // Adapter keeps the hold if its atomic settle fails.
    return settled;
  };
  let events: (GatewaySink & { finish(outcome: { completed: boolean; code?: string }): Promise<void> }) | undefined;
  // The cap row a cap refusal is about, set just before it is answered (the reason code alone says "budget_exceeded" for every row).
  let refusedCap: MeterItem | undefined;
  let refusedReason: RefusedLogReason | undefined;
  // The provider's HTTP status, set only when the provider itself answered with an error (never its body).
  let refusedUpstream: number | undefined;
  const refusedLine = (type: string, status: number): RefusedLog => {
    const payer = route?.payer;
    return { event: "refused", code: logCode(type), status, ...(refusedUpstream === undefined ? {} : { upstreamStatus: refusedUpstream }), ...(refusedCap === undefined ? {} : { cap: refusedCap }), ...(route === undefined ? {} : { route: route.purpose ?? (route.product ? "product" as const : "agent" as const) }), ...(payer !== undefined && PAYER.test(payer) ? { payer } : {}), ...(refusedReason === undefined ? {} : { reason: refusedReason }) };
  };
  let notFoundAt: Pick<RefusedLog, "method" | "path" | "query"> | undefined;
  const respond = async (status: number, type: string, message: string, extra: Readonly<Record<string, string>> = {}) => {
    refusedCode = type;
    if (head) { sink.destroy(); return; }
    head = true; sink.head(status, { ...JSON_HEADERS, ...extra });
    await wait(sink.write(Buffer.from(JSON.stringify(route?.refusalBody?.(type, message) ?? { error: { type, message } })))); sink.end(); log(notFoundAt === undefined ? refusedLine(type, status) : { ...refusedLine(type, status), ...notFoundAt });
  };
  try {
    if (request.method === "GET" && request.url === "/healthz") { head = true; sink.head(200, JSON_HEADERS); await wait(sink.write(Buffer.from(JSON.stringify({ ok: true, ...(deps.runPriceReady?.() === undefined ? {} : { runPrice: { version: 1, admissionVersion: 1, snapshotVersion: deps.runPriceReady() } }) })))); sink.end(); return; }
    const routed = routeFor(deps, request);
    // Which path was not found (pathname only, bounded, printable; never the query, which could carry anything), so operators can tell probes from a client on a wrong path.
    if (routed === undefined) { notFoundAt = notFoundWhere(request); await respond(404, "not_found", "not found"); return; }
    let control: ProductControl | undefined;
    if ("control" in routed) control = routed;
    else {
      route = routed;
      if (route.events !== undefined) { events = route.events.sink(sink); sink = events; }
    }
    const rawKey = request.headers["x-api-key"];
    const auth = request.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    // Ambiguous credentials are refused before either verifier is called.
    const token = rawKey ?? bearer;
    const claims = (rawKey !== undefined && auth !== undefined && rawKey !== bearer) || (auth !== undefined && bearer === undefined) ? undefined : await wait(deps.verifyToken(token));
    if (claims === undefined) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    // A learning token only on the learning route, an answers token only on the answers route, and only such a token there (DEC 226, DEC 254z-amend2).
    if (tokenPurpose(claims.stp) !== route?.purpose) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    // DEC 254zzz41: a reviewer grant spends only on the agent route in company-key mode, and only where a durable single-use store is wired.
    if (claims.reviewer !== undefined && (control !== undefined || route?.reviewerGrants !== true || deps.reviewerGrants === undefined)) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    callClaims = claims;
    const stopsWithTask = route?.stopsWithTask !== false;
    const taskEnded = async () => stopsWithTask && await wait(deps.ended.isEnded(claims.iss, claims.cid, claims.tid, controller.signal));
    if (control?.afterTaskEnd !== true && await taskEnded()) { await respond(403, "task_ended", "task ended"); return; }
    if (control !== undefined) {
      const parts: Uint8Array[] = []; let size = 0;
      const body = request.body[Symbol.asyncIterator]();
      for (;;) { const part = await wait(body.next()); if (part.done) break; size += part.value.byteLength; if (size > CONTROL_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; } parts.push(part.value); }
      let value: unknown;
      try { if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "")) throw new Error(); value = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { await respond(400, "invalid_request", "request not allowed"); return; }
      // Not raced against the deadline: a hold's transaction outcome must be known before answering (adapters bound their own).
      const answer = await control.handle(claims, value, controller.signal);
      head = true; sink.head(answer.status, JSON_HEADERS);
      await wait(sink.write(Buffer.from(JSON.stringify(answer.body)))); sink.end();
      return;
    }
    if (route === undefined) { await respond(404, "not_found", "not found"); return; }
    if (route.admit !== undefined) { const refused = await wait(route.admit(claims, controller.signal)); if (refused !== undefined) { refusedReason = refused.reason; await respond(refused.status, refused.code, refused.message, refused.headers); return; } }
    // Every resolved Rovara purpose, including exempt companies, before holds, reviewer
    // debits or sends. A pause never falls back or retries.
    if (route.chargeSource?.source.kind === "rovara_ai") {
      let enabled = false;
      try { enabled = deps.rovaraAiSetting === undefined || await wait(deps.rovaraAiSetting.enabled()); } catch { /* fail closed */ }
      if (!enabled) { await respond(ROVARA_AI_PAUSED.status, ROVARA_AI_PAUSED.code, ROVARA_AI_PAUSED.message); return; }
    }
    const declared = request.headers["content-length"];
    if (declared !== undefined && /^\d+$/u.test(declared) && Number(declared) > MAX_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; }
    const parts: Uint8Array[] = []; let size = 0;
    const body = request.body[Symbol.asyncIterator]();
    for (;;) { const part = await wait(body.next()); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY_BYTES) { const e = tooLarge(); await respond(e.status, e.code, e.message); return; } parts.push(part.value); }
    const guarded = route.guard(Buffer.concat(parts), request.headers, claims);
    if (!guarded.ok) { await respond(guarded.status, guarded.code, guarded.message); return; }
    shortenDeadline(startedAt + callDurationMs(guarded.maxTokens));
    const inputBytes = guarded.bytes.length - (guarded.images?.dataBytes ?? 0) + (guarded.images?.tokens ?? 0);
    const inputCeiling = inputBytes + (guarded.hasTools ? TOOL_INPUT_ALLOWANCE_TOKENS : 0);
    const scope = route.scope(claims);
    let resolved = await wait(resolvePrice(deps.prices ?? UnknownPriceSource, route.provider, guarded.model, deps.cautiousCeiling, controller.signal, guarded.priceKind ?? "chat"));
    const providerPrice = resolved;
    for (const also of route.alsoPricedAs?.(guarded.model) ?? []) resolved = dearerPrice(resolved, await wait(resolvePrice(deps.prices ?? UnknownPriceSource, also.provider, also.model, deps.cautiousCeiling, controller.signal, guarded.priceKind ?? "chat")));
    const price = guarded.mediaRates === undefined ? resolved : { ...resolved, media: guarded.mediaRates };
    // DEC 254zzz312: hosted Rovara purpose calls require exact signed pricing and durable per-call receipts, including exempt calls.
    const rovaraPurpose = route.purpose !== undefined && route.payer === "rovara";
    const PRICE_CHANGED = "AI source or price changed; pause this run for fresh authorization.";
    // The run-price refusal: the client sees the same 409 and words as ever; the log line also names the check that refused.
    const priceRefused = async (reason: RunPriceRefusedReason, message: string = PRICE_CHANGED) => { refusedReason = reason; await respond(409, "run_price_authorization_required", message); };
    const rovaraWhy: RunPriceRefusedReason | undefined = !rovaraPurpose ? undefined : claims.runPrice === undefined ? "rovara_signed_price_missing" : price.estimated ? "price_estimated" : usageEstimated(price, { input: inputCeiling, output: guarded.maxTokens, cacheRead: 0, cacheWrite: 0 }) ? "price_usage_estimated" : deps.chargeReceipts === undefined ? "receipts_unavailable" : route.meter.settleV2 === undefined ? "settlement_unavailable" : undefined;
    if (rovaraWhy !== undefined) { await priceRefused(rovaraWhy); return; }
    const customerBedrock = route.payer === "bedrock_byo";
    // Product Bedrock retains its existing media admission; agent compatibility requires a bounded, known-price request.
    const legacyBedrock = customerBedrock && !route.product && claims.runPrice === undefined;
    const legacyWhy: RunPriceRefusedReason | undefined = !legacyBedrock ? undefined : !guarded.inputBounded ? "input_unbounded" : guarded.media !== undefined ? "media_unsupported" : providerPrice.estimated || price.estimated ? "price_estimated" : usageEstimated(price, { input: inputCeiling, output: guarded.maxTokens, cacheRead: 0, cacheWrite: 0 }) ? "price_usage_estimated" : price.operatorReview ? "price_operator_review" : route.meter.settleV2 === undefined ? "settlement_unavailable" : undefined;
    if (legacyWhy !== undefined) {
      if (claims.reviewer !== undefined) { await respond(REVIEWER_CEILING_REFUSED.status, REVIEWER_CEILING_REFUSED.code, REVIEWER_CEILING_REFUSED.message); return; }
      await priceRefused(legacyWhy); return;
    }
    // Unsafe reviews get their own refusal even with a signed price; genuine stale authorizations still use the guard below.
    if (customerBedrock && claims.reviewer !== undefined && (!guarded.inputBounded || guarded.media !== undefined || price.estimated || usageEstimated(price, { input: inputBytes, output: guarded.maxTokens, cacheRead: 0, cacheWrite: 0 }))) { await respond(REVIEWER_CEILING_REFUSED.status, REVIEWER_CEILING_REFUSED.code, REVIEWER_CEILING_REFUSED.message); return; }
    if (guarded.images !== undefined && !guarded.inputBounded) { await priceRefused("image_unbounded", UNBOUNDED_IMAGE_REFUSED_MESSAGE); return; }
    const basis = claims.runPrice === undefined ? undefined : deps.prices?.quoteBasis?.(route.provider, guarded.model);
    const basisWhy: RunPriceRefusedReason | undefined = claims.runPrice === undefined ? undefined : !guarded.inputBounded ? "input_unbounded" : guarded.media !== undefined ? "media_unsupported" : price.estimated && !price.knownTokenPrice ? "price_estimated" : basis === undefined ? "price_basis_missing" : basis.hash !== claims.runPrice.snapshotHash ? "snapshot_mismatch" : basis.version !== claims.runPrice.snapshotVersion ? "snapshot_version_mismatch" : undefined;
    const allowWhy = basisWhy ?? runPriceDenial(claims, route.provider, guarded.model, route.chargeSource, price, now(), deps.openRouterTariffs);
    if (allowWhy !== undefined) { await priceRefused(allowWhy); return; }
    if (claims.runPrice !== undefined) {
      if (guarded.usesPromptCache) {
        // Check the base and every reachable band: derived/missing write rates are not evidence of a price.
        const probes = [1, ...(price.longContext ?? []).filter((tier) => tier.aboveTokens < inputCeiling).map((tier) => tier.aboveTokens + 1)];
        if (probes.some((tokens) => usageEstimated(price, { input: 0, output: 0, cacheRead: 0, cacheWrite: tokens }))) {
          await priceRefused("cache_write_price_unknown", "This model has no known cache-write price; pause this run for fresh authorization."); return;
        }
      }
      shortenDeadline(claims.runPrice.expiresAt);
    }
    if (price.operatorReview) log({ event: "price_operator_review" });
    settlementPrice = price; settlementModel = guarded.model; settlementKind = guarded.priceKind ?? "chat";
    // Capture the admitted policy: expiry during the call cannot remove enforcement.
    cacheWritesForbidden = route.provider === "openrouter" && openRouterPolicy(guarded.model, now(), deps.openRouterTariffs)?.cacheWriteBasis === "never_requested_enforced";
    let caps = await wait(route.caps(scope, claims, controller.signal));
    if ((caps as RouteRefusal).ok === false) { const refused = caps as RouteRefusal; await respond(refused.status, refused.code, refused.message, refused.headers); return; }
    if (!validCaps(caps)) { await respond(503, "unavailable", "model access unavailable"); return; }
    // Nightly upkeep AI (L4-E): the project's upkeep cap joins the call's rows before the hold, so the call is checked BEFORE it is sent.
    const upkeep = isUpkeepCall(route, claims);
    if (upkeep) {
      const withCap = await wait(withUpkeepCap(caps, deps.upkeep, claims, controller.signal));
      if ("ok" in withCap) { await respond(withCap.status, withCap.code, withCap.message, withCap.headers); return; }
      caps = withCap;
    }
    let estimate: number;
    try { estimate = estimateCall(inputBytes - (guarded.media?.dataBytes ?? 0), guarded.maxTokens, price, guarded.hasTools ? TOOL_INPUT_ALLOWANCE_TOKENS : 0, guarded.inputBounded && !guarded.usesPromptCache, guarded.media); } catch { await respond(400, "invalid_request", "request not allowed"); return; }
    if (route.provider === "openrouter") {
      const policy = openRouterPolicy(guarded.model, now(), deps.openRouterTariffs);
      if (policy === undefined) { await respond(409, "invalid_request", "request not allowed"); return; }
      // DEC 254zzz330: admission stays at the dearer rate; actual completion
      // includes reasoning. The money core takes max(this token floor, reported debit).
      settlementPrice = { ...price, outputMicrosPerMTok: Number(openRouterDecimal(policy.pricing.completion) / 1_000_000n) };
      try { estimate = Math.max(estimate, openRouterHold(policy, inputCeiling, guarded.maxTokens)); }
      catch { await respond(400, "invalid_request", "request not allowed"); return; }
    }
    if (estimate === Number.MAX_SAFE_INTEGER && !price.operatorReview) log({ event: "price_operator_review" });
    // Do not race a transaction: its outcome must be known before forwarding or settling. Adapters bound their own transactions.
    const overrunCapable = price.estimated || !guarded.inputBounded || (guarded.usesPromptCache === true && claims.runPrice === undefined);
    const admissionExpiresSeconds = Math.floor(now() / 1000) + TASK_TOKEN_SECONDS;
    if (overrunCapable) shortenDeadline(Math.floor(Math.min(deadline, admissionExpiresSeconds * 1000) / 1000) * 1000);
    appliedMaxOutputTokens = guarded.maxTokens;
    const line = route.line?.(claims, guarded.model);
    // DEC 254zzz41: a review call is held at its priced worst case, which must fit the grant's ceiling and be exact (no estimated price, no unbounded input):
    // the hold below is then taken inside the task's limit AND the company's cap, so the ceiling cannot be spent beyond either.
    const grant = claims.reviewer;
    customerReview = grant !== undefined && route.payer === "bedrock_byo";
    // Bedrock reviews retain session authorization/debits, but meter each call with its own receipt and source slot.
    // REVIEW-1 M1: nothing may settle a review above its hold: no estimated price, no tier the request can reach whose rates are derived or uncertain (usageEstimated, at the most tokens the request's bytes can be), no unbounded input, and no source
    // whose provider reports its own cost (OpenRouter), which is a source Code never lists for reviews (reviewerProviderOf) but could be saved within the grant's 120 s.
    if (grant !== undefined && (overrunCapable || route.provider === "openrouter" || usageEstimated(price, { input: inputBytes, output: guarded.maxTokens, cacheRead: 0, cacheWrite: 0 }) || estimate > Math.floor(grant.ceilingUsd * 1_000_000))) { await respond(REVIEWER_CEILING_REFUSED.status, REVIEWER_CEILING_REFUSED.code, REVIEWER_CEILING_REFUSED.message); return; }
    // The grant's own lifetime and binding, and the model the request names, are pure: checked BEFORE anything is read or held (the claim itself comes later).
    // A ceiling hold can only fund calls on the source and accounting mode that opened it. Old/incompatible sessions
    // take a fresh hold below, then fail the store's atomic binding check; the unused hold is settled once in finally.
    const bind = grant === undefined ? "" : JSON.stringify([scope.cid, scope.pid, scope.tid, claims.ws, claims.op, grant.kind, grant.slot, claims.mdl[0], route.payer, route.provider, route.chargeSource, customerReview ? "per_call" : "session_ceiling"]);
    let named: unknown;
    if (grant !== undefined) {
      try { named = (JSON.parse(Buffer.concat(parts).toString("utf8")) as { model?: unknown }).model; } catch { named = undefined; }
      if (typeof named !== "string" || !(await consumeReviewerGrant(claims, { cid: scope.cid, pid: scope.pid, tid: scope.tid, ws: claims.ws, op: claims.op, kind: grant.kind, slot: grant.slot, model: named }, Math.floor(now() / 1000), async () => true))) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    }
    // A review's first call holds the grant's WHOLE ceiling (inside the task's limit and the company's cap) for its session; a later call of the same review
    // (the session exists) holds nothing new and debits the session below. Anything the store cannot answer is the fixed refusal, before any hold.
    let session: Awaited<ReturnType<ReviewerGrantStore["read"]>>;
    if (grant !== undefined) { try { session = await wait(deps.reviewerGrants!.read(claims.iss, scope.cid, claims.jti, controller.signal)); } catch { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; } }
    const ceilingMicros = grant === undefined ? 0 : Math.floor(grant.ceilingUsd * 1_000_000);
    if ((deps.chargeReceipts !== undefined || customerBedrock) && (grant === undefined || customerReview) && guarded.media === undefined && route.meter.settleV2 !== undefined) {
      const source = customerBedrock ? route.chargeSource : deps.chargeReceipts!.source(claims, guarded.model, route.chargeSource);
      if (source !== undefined) charge = initialCharge(route.product ? { ...claims, pay: { kind: "project", project: claims.pid } } : claims, { provider: route.provider, modelId: guarded.model }, source, estimate, now(), price);
    }
    if (rovaraPurpose && charge === undefined) { await respond(503, "unavailable", "model access unavailable"); return; }
    const reserved = grant !== undefined && !customerReview && session?.bind === bind ? { ok: true as const, reservation: undefined } : await route.meter.reserve({ scope, caps, estimateMicros: grant === undefined || customerReview ? estimate : ceilingMicros, appliedMaxOutputTokens,
      routeClass: route.product ? "product" : "agent",
      // GATEWAY-RUN-CHARGES-ROUTE: every hold of a task call is findable by its run, so the run's charges are read whole or not at all.
      run: { operationId: claims.op },
      ...(route.payer === "bedrock_byo" ? { customerSource: "bedrock_byo" as const } : route.provider === "openrouter" ? { customerSource: "openrouter" as const } : {}), ...(charge === undefined ? {} : { charge: { receipt: charge, kind: guarded.priceKind ?? "chat", requestFingerprint: createHash("sha256").update(guarded.bytes).digest("hex") }, ...(claims.runPrice !== undefined || customerBedrock ? {} : { provisional: { requestBytes: inputBytes, toolInputAllowanceTokens: guarded.hasTools ? TOOL_INPUT_ALLOWANCE_TOKENS : 0, maxOutputTokens: guarded.maxTokens, price } }) }), ...(line === undefined ? {} : { line }),
      ...(grant === undefined || customerReview ? {} : { sweepAfter: now() + (REVIEW_SESSION_SECONDS * 1000) + REVIEW_SESSION_CLOSE_GRACE_MS, review: { jti: claims.jti.toLowerCase() } }),
      ...(!overrunCapable ? {} : { overrun: { deadlineSeconds: Math.floor(deadline / 1000), tokenExpiresSeconds: admissionExpiresSeconds } }),
    });
    if (!reserved.ok) {
      if (reserved.reason === "busy" && reserved.overrunInFlight) {
        try { deps.metrics.overrunBusy(claims.iss, claims.cid); } catch { /* A metrics outage never changes admission or settlement. */ }
        log({ event: "overrun_busy", company: claims.cid });
        await respond(429, "busy", OVERRUN_BUSY_MESSAGE, { "retry-after": String(OVERRUN_BUSY_RETRY_SECONDS) });
      } else if (reserved.reason === "busy") { refusedReason = "meter_busy"; await respond(503, "unavailable", "model access unavailable"); }
      else if (reserved.held) await respond(429, "budget_held", "budget is held by another call", { "retry-after": "2" });
      else if (route.capRefusal !== undefined) { const refused = await wait(route.capRefusal({ reason: reserved.reason, item: reserved.item }, scope, caps, estimate, controller.signal)); refusedCap = reserved.item; await respond(refused.status, refused.code, refused.message, refused.headers); }
      else if (upkeep && reserved.item === "upkeep") { refusedCap = reserved.item; const refused = upkeepRefusal(caps, estimate); await respond(refused.status, refused.code, refused.message, refused.headers); }
      else { refusedCap = reserved.item; await respond(422, "budget_exceeded", route.prefix[reserved.item]); }
      return;
    }
    if (grant === undefined || customerReview) reservation = reserved.reservation;
    if (grant !== undefined && (!customerReview || session === undefined)) held = reserved.reservation;
    reservedMicros = estimate;
    streamed = guarded.streaming;
    failureInput = { bytes: guarded.bytes.length - (guarded.images?.dataBytes ?? 0) - (guarded.media?.dataBytes ?? 0), fixedTokens: guarded.images?.tokens ?? 0, media: guarded.media, plainInput: guarded.inputBounded && !guarded.usesPromptCache, reasoningUnseen: mayReasonUnseen(route.provider, guarded.model, guarded.bytes) };
    // One non-overlapping, deadline-bounded poll also stops streams stalled between chunks.
    const pollEnded = async (): Promise<void> => {
      try { if (await taskEnded()) abort(); } catch { abort(); }
      if (!controller.signal.aborted) endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    };
    endedTimer = setTimeout(() => { void pollEnded(); }, ENDED_TASK_POLL_MS);
    // No call has left the process yet, including while the key port is read.
    cost = 0; estimated = false;
    if (grant !== undefined && deps.reviewerGrants !== undefined) {
      // Only after the hold is taken (a transient "busy" or a cap refusal burns nothing) and before any key is read or byte sent. The expected
      // company, project and task are the SCOPE the hold was taken in; the model is the one the request itself names (read from its body, not the grant).
      const store = deps.reviewerGrants;
      // Opens this call's session on the hold it took. Never raced against the deadline or an abort and never throws: the finally waits for it, so the hold is
      // never released while a write that may have landed is unresolved.
      const openSession = async (jti: string, at: number): Promise<"opened" | "exists" | "failed"> => {
        const hold = held!;
        try {
          if (!(await store.open({ iss: claims.iss, cid: scope.cid, jti, bind, holdId: hold.id, ceilingMicros, firstDebitMicros: estimate, endsAt: at + REVIEW_SESSION_SECONDS }))) return "exists";
          heldKept = true; sessionCall = { debited: estimate, claims };
          // Whatever the review leaves unused goes back when its session ends (a short grace after); the session-aware hold sweep is only the backstop for a gateway task that died.
          if (!customerReview) { const timer = setTimeout(() => { void closeReviewSession(store, route!.meter, scope, jti, hold.id).catch(() => { log({ event: "settle_failed" }); }); }, (REVIEW_SESSION_SECONDS * 1000) + REVIEW_SESSION_CLOSE_GRACE_MS);
          timer.unref(); }
          return "opened";
        } catch {
          // The write's outcome is unknown. Certainly not written: the finally gives the hold back whole. Written by THIS hold: the session is closed at what was debited (never left
          // on a released hold). Written by another call's hold: not ours to close, we continue as a later call of that review. Unreadable: the hold stays for the sweep.
          let seen: Awaited<ReturnType<ReviewerGrantStore["read"]>>; let readable = true;
          try { seen = await store.read(claims.iss, scope.cid, jti); } catch { readable = false; }
          if (!readable) { heldKept = true; return "failed"; }
          if (seen === undefined) return "failed";
          if (seen.holdId !== hold.id) return "exists";
          heldKept = true;
          try { if (customerReview) await store.close(claims.iss, scope.cid, jti, hold.id); else await closeReviewSession(store, route!.meter, scope, jti, hold.id); } catch { log({ event: "settle_failed" }); }
          return "failed";
        }
      };
      const usable = typeof named === "string" && await wait(consumeReviewerGrant(claims, { cid: scope.cid, pid: scope.pid, tid: scope.tid, ws: claims.ws, op: claims.op, kind: grant.kind, slot: grant.slot, model: named }, Math.floor(now() / 1000), async (jti) => {
        const at = Math.floor(now() / 1000);
        // The first use claims the grant by opening the session (the one atomic write), with this call's worst case already debited.
        if (held !== undefined) {
          pendingOpen = openSession(jti, at);
          const outcome = await pendingOpen;
          if (outcome === "opened") return true;
          if (outcome === "failed") return false;
        }
        // A later call of the same review (or the loser of a race between two first calls): one more debit, never past the ceiling or the session's end.
        if (!(await store.debit(claims.iss, scope.cid, jti, bind, estimate, at, controller.signal))) return false;
        sessionCall = { debited: estimate, claims };
        return true;
      }));
      // A refused grant (another task, kind or model, expired, a call past the ceiling or the session, or a store that did not answer) sends nothing; a hold taken for it is given back ($0) in the finally.
      if (!usable) { await respond(401, AUTH_ERROR.error.type, AUTH_ERROR.error.message); return; }
    }
    if (controller.signal.aborted) throw new NotSentError();
    const key = await wait(route.key(claims, controller.signal));
    if (typeof key !== "string" || key.length < 6 || key.length > 8192 || /[\r\n]/u.test(key)) throw new NotSentError();
    if (controller.signal.aborted) throw new NotSentError();
    cost = estimate; estimated = true;
    try { provider = await wait(route.transport({ body: guarded.bytes, headers: guarded.headers, key, signal: controller.signal, ...(guarded.path === undefined ? {} : { path: guarded.path }) })); }
    catch (error) { if (error instanceof NotSentError) { cost = 0; estimated = false; } else if (!controller.signal.aborted) { providerFault = true; answerBroke = error instanceof AnswerBrokeError; } throw error; }
    if (provider.status < 200 || provider.status >= 300) {
      let failureBytes: Uint8Array | undefined;
      if (route.failureBody === true) {
        // Its first bytes only, for the class (quota, rate limit, overloaded); never echoed, never logged.
        const read: Uint8Array[] = []; let got = 0; const it = provider.body[Symbol.asyncIterator]();
        try { while (got < FAILURE_BODY_BYTES) { const next = await wait(it.next()); if (next.done) break; read.push(next.value); got += next.value.byteLength; } } catch { /* Classified from the status alone. */ }
        failureBytes = Buffer.concat(read).subarray(0, FAILURE_BODY_BYTES);
      }
      const failure = route.providerFailure(provider.status, failureBytes);
      refusedReason = failure.reason;
      if (Number.isInteger(provider.status) && provider.status >= 100 && provider.status <= 599) refusedUpstream = provider.status;
      if (!failure.charged) { cost = 0; estimated = false; }
      if (route.product && (provider.status === 401 || provider.status === 403)) log({ event: "product_key_refused" });
      await respond(failure.refusal.status, failure.refusal.code, failure.refusal.message, failure.refusal.headers); return; }
    const scanner = new SecretScanner([key, ...(typeof token === "string" ? [token] : [])]);
    usage = route.usage();
    const output: Uint8Array[] = []; let total = 0;
    const stream = provider.body[Symbol.asyncIterator]();
    if (guarded.streaming) { head = true; sink.head(200, { ...JSON_HEADERS, "content-type": guarded.streamContentType ?? "text/event-stream; charset=utf-8" }); }
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try { next = await wait(stream.next()); } catch (error) { if (!controller.signal.aborted) providerFault = true; throw error; }
      if (next.done) break;
      if (await taskEnded()) { stoppedByUs = true; throw new Error("provider unavailable"); }
      received += next.value.byteLength;
      total += next.value.byteLength; if (total > MAX_RESPONSE_BYTES) throw new Error("provider unavailable");
      const safe = scanner.push(next.value); if (safe.hit) throw new Error("provider unavailable");
      if (guarded.streaming) { usage.push(next.value); if (safe.bytes.length) await wait(sink.write(safe.bytes)); }
      else output.push(safe.bytes);
    }
    const last = scanner.finish();
    if (guarded.streaming) { if (last.length) await wait(sink.write(last)); }
    else {
      output.push(last); const bytes = Buffer.concat(output);
      let value: unknown; try { value = JSON.parse(bytes.toString()); } catch { throw new Error("provider unavailable"); }
      usage.whole(value);
      if (route.provider === "openrouter") {
        settlementUsage = usage.finish();
        if (unexpectedRouterWrite(settlementUsage)) throw new Error("provider unavailable");
      }
      let successHeaders: Readonly<Record<string, string>> = JSON_HEADERS;
      if (route.costHeader !== undefined) {
        // The cost header (answers route): settle BEFORE the head, so the figure sent is the one the meter was written with. Never a guess:
        // the usage was read, the price is exact, and the settle went through; otherwise no header.
        early = usage.finish();
        if (early === undefined) throw new Error("provider unavailable");
        settlementUsage = early;
        try { const reported = provider.reportedCostMicros?.(); if (reported !== undefined) settlementReported = reported; } catch { /* no reported cost */ }
        const settledNow = await settleOnce();
        if (settledNow?.ok === true && !settledNow.estimated && settledNow.micros > 0 && validUsage(early) && hasUsage(early)) successHeaders = { ...JSON_HEADERS, [route.costHeader]: usdOf(settledNow.micros) };
      }
      head = true; sink.head(200, successHeaders); await wait(sink.write(bytes));
    }
    const counts = early ?? settlementUsage ?? usage.finish();
    if (unexpectedRouterWrite(counts)) {
      settlementUsage = counts;
      throw new Error("provider unavailable");
    }
    // Incomplete/malformed SSE is a failed stream, never a silent partial success.
    if (counts === undefined) { providerFault = true; throw new Error("provider unavailable"); }
    sink.end(); completed = true;
    settlementUsage = counts;
    // A provider-reported cost (OpenRouter) counts only for a call that completed with readable usage; settleAmount applies its rules.
    try { const reported = provider.reportedCostMicros?.(); if (reported !== undefined) settlementReported = reported; } catch { /* no reported cost */ }
  } catch (error) {
    // Who stopped the call and how far it got: the log's reason, and (a Bedrock route) what the call is settled at instead of the hold.
    const cause: FailedCallCause | "not_sent" = error instanceof NotSentError ? "not_sent" : controller.signal.aborted || stoppedByUs ? "aborted" : providerFault ? "provider" : "gateway";
    const phase = failedCallPhase({ streaming: streamed, answered: provider !== undefined || answerBroke, received, progress: streamProgress() });
    if (cause !== "not_sent") failure = { cause, phase };
    log({ event: "provider_error", reason: providerErrorReason(cause, phase) });
    const notSent = !head && error instanceof NotSentError ? route?.notSent?.() : undefined;
    try { if (head) sink.destroy(); else if (notSent !== undefined) await respond(notSent.status, notSent.code, notSent.message, notSent.headers); else await respond(502, "provider_error", "provider unavailable"); } catch { sink.destroy(); }
  } finally {
    controller.abort(); clearTimeout(timer); clearTimeout(endedTimer); request.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", onAbort);
    try { provider?.cancel?.(); } catch { /* Fixed log fields only; no provider text. */ }
    // The claim is never left running past this point: a session it opened is then known (heldKept) before the hold is judged.
    if (pendingOpen !== undefined) await pendingOpen.catch(() => undefined);
    // A hold taken for a review's first call that never opened its session (a refused or failed claim) is given back whole ($0).
    if (held !== undefined && held !== reservation && !heldKept && route !== undefined) { try { await route.meter.settle(held, 0); } catch { log({ event: "settle_failed" }); } }
    await settleOnce();
    // Exactly one settle event, after the call settled.
    if (events !== undefined) { try { await events.finish({ completed, ...(refusedCode === undefined ? {} : { code: refusedCode }) }); } catch { /* The sink ends or destroys itself. */ } }
  }
}
/** Whole micro-dollars as a plain decimal USD string (six places), by integer arithmetic: no float noise. */
const usdOf = (micros: number): string => `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
/** node:http adapter, including backpressure and disconnect cancellation. It never opens a listener itself. */
export function createGatewayHandler(deps: GatewayDependencies): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const controller = new AbortController(); const abort = () => controller.abort();
    req.once("aborted", abort); res.once("close", abort);
    const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
    for (const [name, value] of Object.entries(req.headers)) headers[name] = Array.isArray(value) ? value.join(",") : value;
    try {
      await handleGateway(deps, { method: req.method ?? "", url: req.url ?? "", headers, body: req as AsyncIterable<Uint8Array>, signal: controller.signal }, {
        head: (status, outgoing) => { res.writeHead(status, outgoing); },
        write: async (bytes) => {
          if (res.destroyed || controller.signal.aborted) throw new Error("response unavailable");
          if (res.write(bytes)) return;
          await new Promise<void>((resolve, reject) => {
            const clean = () => { res.off("drain", drained); res.off("close", closed); res.off("error", closed); controller.signal.removeEventListener("abort", closed); };
            const drained = () => { clean(); resolve(); }; const closed = () => { clean(); reject(new Error("response unavailable")); };
            res.once("drain", drained); res.once("close", closed); res.once("error", closed); controller.signal.addEventListener("abort", closed, { once: true });
          });
        },
        end: () => { res.end(); }, destroy: () => { res.destroy(); },
      });
    } finally { req.off("aborted", abort); res.off("close", abort); }
  };
}
