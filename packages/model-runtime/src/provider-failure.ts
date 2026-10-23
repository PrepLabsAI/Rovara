import { E2E_MODEL_FAILURE_SIGNAL_PATTERN, type E2EModelFailure, type E2EModelFailureClass, type ModelProvider } from "@agentx/contracts";

/**
 * Provider-neutral failure classes (M1.4 Task 4.10B, plan D-5). One pure function from what a failed provider call showed (an HTTP status, the error's own name or code, a network
 * code, a timeout) to one of the fixed classes, so every provider's failures read the same to the owner. It is not specific to the e2e route: model checks reuse it.
 *
 * It only ever sees allow-listed tokens. The caller captures a signal with `signalPattern` and never keeps message text; this function drops any signal outside the pattern again, so a
 * hostile value cannot reach a receipt through it. An unknown signal is decided by the status; with neither, the class is `unknown`.
 */

type Cls = E2EModelFailureClass;

/** A signal is one token: a Bedrock error type is letters only, a keyed provider's error type or code is lower-case letters, digits and underscores. */
export const BEDROCK_SIGNAL_PATTERN = /^[A-Za-z]{1,64}$/;
export const KEYED_SIGNAL_PATTERN = /^[a-z0-9_]{1,64}$/;
export const signalPattern = (provider: ModelProvider): RegExp => (provider === "amazon-bedrock" ? BEDROCK_SIGNAL_PATTERN : KEYED_SIGNAL_PATTERN);

/** The network errors that mean "no answer at all". Anything else is not trusted as a code. */
const NETWORK_CODES: ReadonlySet<string> = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);
export const isNetworkCode = (code: string): boolean => NETWORK_CODES.has(code) || /^CERT_[A-Z0-9_]{1,56}$/.test(code);

const named = (entries: Record<Cls, readonly string[]>): ReadonlyMap<string, Cls> =>
  new Map((Object.entries(entries) as Array<[Cls, readonly string[]]>).flatMap(([cls, names]) => names.map((name) => [name, cls] as const)));

const none = [] as const;
const SIGNALS: Record<ModelProvider, ReadonlyMap<string, Cls>> = {
  "amazon-bedrock": named({
    "limit-or-rate-limited": ["ThrottlingException", "ServiceQuotaExceededException"],
    "key-rejected": ["AccessDeniedException", "UnrecognizedClientException", "ExpiredTokenException"],
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
  const signal = typeof facts.signal === "string" && signalPattern(facts.provider).test(facts.signal) && E2E_MODEL_FAILURE_SIGNAL_PATTERN.test(facts.signal) ? facts.signal : null;
  const bySignal = signal === null ? undefined : SIGNALS[facts.provider].get(signal);
  if (bySignal !== undefined) return { class: bySignal, signal };
  if (status !== undefined) {
    const byStatus = STATUSES[facts.provider].find(([, matches]) => matches(status))?.[0];
    return { class: byStatus ?? "unknown", signal };
  }
  return { class: "unknown", signal };
}
