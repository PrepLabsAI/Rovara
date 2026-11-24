import { E2E_MODEL_FAILURE_SIGNAL_PATTERN, MODEL_NOT_ENABLED_CODE, type E2EModelFailure, type E2EModelFailureClass, type ModelProvider } from "@agentx/contracts";

/**
 * Provider-neutral failure classes (M1.4 Task 4.10B, plan D-5). One pure function from what a failed provider call showed (an HTTP status, the error's own name or code, a network
 * code, a timeout) to one of the fixed classes, so every provider's failures read the same to the owner. It is not specific to the e2e route: model checks reuse it.
 *
 * It only ever sees allow-listed tokens. The caller captures a signal with `signalPattern` and never keeps message text; this function drops any signal outside the pattern again, so a
 * hostile value cannot reach a receipt through it. An unknown signal is decided by the status; with neither, the class is `unknown`.
 */

type Cls = E2EModelFailureClass;

/** The signal of a model the account has not enabled (Amazon Bedrock's agreement for it is not in place): class `key-rejected`, shown to the owner with its own words. */
export const MODEL_NOT_ENABLED_SIGNAL = MODEL_NOT_ENABLED_CODE;
/**
 * DEC 254g: Rovara's own token for a model the model gateway does not offer the company (its 400 refusal, read by model-runtime). The worker sets it only from model-runtime's own fixed
 * sentence (model-call-monitor.ts), never from a provider's facts: classifyProviderFailure does not grant it.
 */
export const MODEL_NOT_OFFERED_SIGNAL = "ModelNotOffered";

/** A signal is one token: a Bedrock error type is letters only, a keyed provider's error type or code is lower-case letters, digits and underscores. */
export const BEDROCK_SIGNAL_PATTERN = /^[A-Za-z]{1,64}$/;
export const KEYED_SIGNAL_PATTERN = /^[a-z0-9_]{1,64}$/;
export const signalPattern = (provider: ModelProvider): RegExp => (provider === "amazon-bedrock" ? BEDROCK_SIGNAL_PATTERN : KEYED_SIGNAL_PATTERN);

/** The network errors that mean "no answer at all". Anything else is not trusted as a code. */
const NETWORK_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
export const isNetworkCode = (code: string): boolean => NETWORK_CODES.has(code) || /^CERT_[A-Z0-9_]{1,56}$/.test(code);

const named = (entries: Partial<Record<Cls, readonly string[]>>): ReadonlyMap<string, Cls> =>
  new Map((Object.entries(entries) as Array<[Cls, readonly string[]]>).flatMap(([cls, names]) => names.map((name) => [name, cls] as const)));

const none = [] as const;
const SIGNALS: Record<ModelProvider, ReadonlyMap<string, Cls>> = {
  "amazon-bedrock": named({
    "limit-or-rate-limited": ["ThrottlingException", "ServiceQuotaExceededException"],
    // "ModelNotEnabled" is Rovara's own token (not a Bedrock error type): the model proxy answered 403 "<model> is not available for this account", the account has not enabled that model. A key-rejected failure, told apart so the owner is told what to do.
    "key-rejected": ["AccessDeniedException", "UnrecognizedClientException", "ExpiredTokenException", MODEL_NOT_ENABLED_SIGNAL],
    "model-not-found": ["ResourceNotFoundException"],
    "request-rejected": ["ValidationException"],
    // ModelNotReadyException comes with a 429 as well: naming it here is what makes it an outage and not a limit.
    "provider-outage": ["ServiceUnavailableException", "InternalServerException", "ModelNotReadyException", "ModelTimeoutException", "ModelErrorException"],
    unreachable: none, unknown: none,
  }),
  anthropic: named({
    "limit-or-rate-limited": ["rate_limit_error"], "key-rejected": ["authentication_error", "permission_error"], "model-not-found": ["not_found_error"],
    "request-rejected": ["invalid_request_error", "request_too_large"], "provider-outage": ["api_error", "overloaded_error"], unreachable: none, unknown: none,
  }),
  openai: named({
    "limit-or-rate-limited": ["rate_limit_exceeded", "insufficient_quota"], "key-rejected": ["invalid_api_key"], "model-not-found": ["model_not_found"],
    "request-rejected": none, "provider-outage": none, unreachable: none, unknown: none,
  }),
  // OpenRouter's error code is the HTTP status again, so its status decides.
  openrouter: new Map(),
};

type StatusRule = (status: number) => boolean;
const is = (...statuses: number[]): StatusRule => (status) => statuses.includes(status);
const server: StatusRule = (status) => status >= 500 && status <= 599;
const STATUSES: Record<ModelProvider, ReadonlyArray<readonly [Cls, StatusRule]>> = {
  "amazon-bedrock": [["limit-or-rate-limited", is(429)], ["key-rejected", is(401, 403)], ["model-not-found", is(404)], ["request-rejected", is(400, 413, 422)], ["provider-outage", (s) => server(s) || s === 408 || s === 424]],
  anthropic: [["limit-or-rate-limited", is(429)], ["key-rejected", is(401, 403)], ["model-not-found", is(404)], ["request-rejected", is(400, 413)], ["provider-outage", server]],
  openai: [["limit-or-rate-limited", is(429)], ["key-rejected", is(401, 403)], ["model-not-found", is(404)], ["request-rejected", is(400, 422)], ["provider-outage", server]],
  openrouter: [["limit-or-rate-limited", is(429, 402)], ["key-rejected", is(401)], ["model-not-found", is(404)], ["request-rejected", is(400, 403)], ["provider-outage", (s) => server(s) || s === 408]],
};

export interface ProviderFailureFacts {
  provider: ModelProvider;
  /** The HTTP status of a response that came back and was a failure. */
  status?: number | undefined;
  /** The error's own name or code, as captured by the caller (never message text). Dropped here when it is not one allow-listed token. */
  signal?: string | null | undefined;
  /** The network error code, when no response came back. */
  networkCode?: string | undefined;
  /** The call was stopped by its time limit. */
  timedOut?: boolean | undefined;
}

export function classifyProviderFailure(facts: ProviderFailureFacts): E2EModelFailure {
  const status = typeof facts.status === "number" && Number.isInteger(facts.status) ? facts.status : undefined;
  // A call that got no response and named an allow-listed network code is unreachable, even when the SDK rewrote it as "Request timed out." (a connect timeout is the most common
  // unreachable there is). Only a timeout with a response, or with no network code, is the provider's outage.
  if (status === undefined && facts.networkCode !== undefined && isNetworkCode(facts.networkCode)) return { class: "unreachable", signal: facts.networkCode };
  if (facts.timedOut === true) return { class: "provider-outage", signal: "timeout" };
  // DR-KEY-1 (B): Rovara's own ModelNotEnabled token (from the model proxy's 403 for a model the account may not use) is the same on every provider's route: the proxy may be spoken to as Anthropic or as Bedrock.
  // A provider's own "ModelNotOffered" is never Rovara's token (DEC 254g): it is dropped, so the class is the status's.
  const signal = facts.signal === MODEL_NOT_OFFERED_SIGNAL ? null : facts.signal === MODEL_NOT_ENABLED_SIGNAL ? MODEL_NOT_ENABLED_SIGNAL
    : typeof facts.signal === "string" && signalPattern(facts.provider).test(facts.signal) && E2E_MODEL_FAILURE_SIGNAL_PATTERN.test(facts.signal) ? facts.signal : null;
  const bySignal = signal === null ? undefined : signal === MODEL_NOT_ENABLED_SIGNAL ? "key-rejected" : SIGNALS[facts.provider].get(signal);
  if (bySignal !== undefined) return { class: bySignal, signal };
  if (status !== undefined) {
    const byStatus = STATUSES[facts.provider].find(([, matches]) => matches(status))?.[0];
    return { class: byStatus ?? "unknown", signal };
  }
  return { class: "unknown", signal };
}

// ---- the gateway's refusal of a run whose price authorization no longer fits the call

/** The hosted model gateway's 409 code: the run's signed price grant (`runPrice`) no longer matches the call (AI source, price or call shape changed). */
export const RUN_PRICE_REFUSED_CODE = "run_price_authorization_required";
/**
 * The plain words of that stop, for the step's error and its block reason. It is a STOP, never a retry: the same grant is refused again, so the step waits for the person's Retry, which starts a
 * new run and mints a fresh price authorization (broker `handleModelAccess`). Pi's retry list does not match these words.
 */
export const RUN_PRICE_REFUSED_MESSAGE = "The AI price authorization changed. Start the step again to re-authorize.";
/** The stable token the model-call note carries for it (letters only, so it passes the failure-signal allow-list). */
export const RUN_PRICE_REFUSED_SIGNAL = "RunPriceRefused";

/**
 * Whether a gateway answer is the run price refusal: HTTP 409 and `{ error: { type | code: "run_price_authorization_required" } }` (the gateway's default body and its Bedrock-shaped body both carry the
 * code as `error.type`). Matched whole, never kept; any other status, code or shape is not it.
 */
export function runPriceRefusedBody(status: number, body: string): boolean {
  if (status !== 409) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return false; }
  const error = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (error === null || typeof error !== "object") return false;
  const { type, code } = error as { type?: unknown; code?: unknown };
  return type === RUN_PRICE_REFUSED_CODE || code === RUN_PRICE_REFUSED_CODE;
}

// ---- the gateway's fixed quota sentences (a Bedrock throttle: the model's AWS quota is used up or set to 0)

/** The stable token the model-call note carries for it (letters only, so it passes the failure-signal allow-list). */
export const MODEL_QUOTA_SIGNAL = "QuotaExhausted";
/**
 * Code's own fixed sentence after "<Label> request failed; " (the worker reads it whole; never the gateway's words). It starts "rate limited" ON PURPOSE: Pi's retry list (isRetryableAssistantError)
 * matches that, and the gateway sends this one sentence for every Bedrock 429, including a transient per-minute throttle, so it must stay retried as before. Do not add a word Pi treats as final ("quota exceeded", "billing").
 */
export const MODEL_QUOTA_DETAIL = "rate limited; the AWS quota for this model is used up or set to 0; choose another model, or ask AWS to raise the quota";
/** What the task view tells the owner for it (fixed text). */
export const MODEL_QUOTA_VIEW_TEXT = "the AWS quota for this model is used up or set to 0";
export const MODEL_QUOTA_VIEW_NEXT = "Choose another model, or ask AWS to raise the quota.";
/**
 * The hosted gateway's fixed 429 `rate_limit_error` sentences for a Bedrock quota throttle: Rovara's AI (one sentence) and the company's own Bedrock (one sentence naming the Region, which must be
 * an AWS Region name). Matched whole against `error.message`, never kept: any other text, even a near miss, is not it.
 */
export const GATEWAY_QUOTA_ANSWERS: readonly string[] = Object.freeze(["Rovara's AI has no room for this model right now: its AWS quota is used up or set to 0. Choose another model, or try again later."]);
const GATEWAY_QUOTA_OWN_BEDROCK = /^Your AWS account has no Bedrock room for this model in (?:us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-[1-9]: its quota is used up or set to 0\. Choose another model, or ask AWS to raise the quota \(Service Quotas\)\.$/u;
const GATEWAY_QUOTA_ERROR_TYPE = "rate_limit_error";

/** Whether a gateway 429 body is its fixed quota answer: `{ error: { type | code: "rate_limit_error", message: <one of its fixed sentences> } }`. Only matched; nothing of the body is kept. */
export function gatewayQuotaBody(body: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return false; }
  const error = parsed !== null && typeof parsed === "object" ? (parsed as { error?: unknown }).error : undefined;
  if (error === null || typeof error !== "object") return false;
  const { type, code, message } = error as { type?: unknown; code?: unknown; message?: unknown };
  if (type !== GATEWAY_QUOTA_ERROR_TYPE && code !== GATEWAY_QUOTA_ERROR_TYPE) return false;
  return typeof message === "string" && (GATEWAY_QUOTA_ANSWERS.includes(message) || GATEWAY_QUOTA_OWN_BEDROCK.test(message));
}
