// TE-F1a: the refusal words, as fixed strings, and the answer a refusal becomes in each family's own error shape. The words never carry the text that was refused.
import { MODEL_EGRESS_OVERRUN_SENTENCE, formatUsdMicros } from "./cost.js";
import type { ModelEgressFamily } from "./schemes.js";

/** `not_found` is one word for "missing" and "another company's": nothing tells them apart. */
export const MODEL_EGRESS_REFUSALS = ["not_found", "not_allowed", "cap", "key_refused", "rate_limit", "quota", "overloaded", "bad_request", "too_large", "ssrf"] as const;
export type ModelEgressRefusal = (typeof MODEL_EGRESS_REFUSALS)[number];

/** The header our own refusals carry. A provider's answer never carries it past the sanitiser. */
export const MODEL_EGRESS_REFUSAL_HEADER = "x-rovara-refusal";

export const MODEL_EGRESS_REFUSAL_WORDS: Readonly<Record<ModelEgressRefusal, string>> = {
  not_found: "The model source was not found.",
  not_allowed: "This request is not allowed through the test model proxy.",
  cap: "The Rovara test model budget was reached.",
  key_refused: "The product key was refused by the provider. Check it in Settings.",
  rate_limit: "The provider rate limit was reached.",
  quota: "The provider quota is used up.",
  overloaded: "The provider is overloaded.",
  bad_request: "The request is not valid.",
  too_large: "The request is too large.",
  ssrf: "The provider address was refused.",
};

/** The HTTP status each own refusal answers with. */
export const MODEL_EGRESS_REFUSAL_STATUS: Readonly<Record<ModelEgressRefusal, number>> = {
  not_found: 404,
  not_allowed: 403,
  cap: 429,
  key_refused: 401,
  rate_limit: 429,
  quota: 429,
  overloaded: 503,
  bad_request: 400,
  too_large: 413,
  ssrf: 502,
};

const STATUS_NAMES: Readonly<Record<number, string>> = { 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "PERMISSION_DENIED", 404: "NOT_FOUND", 413: "INVALID_ARGUMENT", 429: "RESOURCE_EXHAUSTED", 502: "UNAVAILABLE", 503: "UNAVAILABLE" };
const ANTHROPIC_TYPES: Readonly<Record<number, string>> = { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 413: "request_too_large", 429: "rate_limit_error", 502: "api_error", 503: "overloaded_error" };

/** One error body in the family's own shape: what a client of that provider already parses. `message` is always one of our fixed sentences. */
export function familyErrorBody(family: ModelEgressFamily, status: number, message: string, code: string): Uint8Array {
  let body: unknown;
  switch (family) {
    case "anthropic_messages":
      body = { type: "error", error: { type: ANTHROPIC_TYPES[status] ?? "api_error", message } };
      break;
    case "gemini":
    case "vertex":
      body = { error: { code: status, message, status: STATUS_NAMES[status] ?? "UNKNOWN" } };
      break;
    case "cohere":
    case "bedrock":
      body = { message };
      break;
    case "openai_compatible":
      body = { error: { message, type: status === 429 ? "rovara_budget" : "rovara_refusal", param: null, code } };
      break;
  }
  return new TextEncoder().encode(JSON.stringify(body));
}

export interface ModelEgressRefusalResponse {
  readonly status: number;
  readonly headers: Array<[string, string]>;
  readonly body: Uint8Array;
}

/**
 * The answer for one of our own refusals: the fixed status, the family's error shape, the fixed sentence, and `x-rovara-refusal: <word>`. The cap refusal names the cap ("... ($2.00 per task)") when `capMicros` is given and
 * is a whole non-negative number; it is a 429 in every family.
 */
export function refusalResponse(family: ModelEgressFamily, word: ModelEgressRefusal, options: { readonly capMicros?: number; /** The call before this one settled above its reservation: the words are the fixed overrun sentence. */ readonly overrun?: boolean } = {}): ModelEgressRefusalResponse {
  const status = MODEL_EGRESS_REFUSAL_STATUS[word];
  const cap = options.capMicros;
  const message =
    word === "cap" && options.overrun === true ? `The Rovara test model ${MODEL_EGRESS_OVERRUN_SENTENCE}.` : word === "cap" && cap !== undefined && Number.isSafeInteger(cap) && cap >= 0 ? `${MODEL_EGRESS_REFUSAL_WORDS.cap.slice(0, -1)} (${formatUsdMicros(cap)} per task).` : MODEL_EGRESS_REFUSAL_WORDS[word];
  return {
    status,
    headers: [["content-type", "application/json"], [MODEL_EGRESS_REFUSAL_HEADER, word]],
    body: familyErrorBody(family, status, message, `rovara_${word}`),
  };
}
