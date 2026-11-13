// TE-F1a: the evidence class of one model call (design 5). A provider's 429 goes back to the client UNCHANGED; only the class is added, for the evidence ("not run: provider rate limit", never "failed"). Two readers:
//   `classifyProviderResponse` reads what a PROVIDER sent (status and body) and never trusts any header of it, so a provider cannot claim to be our cap;
//   `classifyOwnResponse` reads the head of one of OUR answers (after `sanitizeResponseHeaders`, which strips every `x-rovara-*` header a provider sent), and so can read `x-rovara-refusal`.
import { MODEL_EGRESS_REFUSAL_HEADER, MODEL_EGRESS_REFUSALS, type ModelEgressRefusal } from "./refusals.js";
import { formatUsdMicros } from "./cost.js";

export const MODEL_EGRESS_CLASSES = ["ok", "rate_limit", "quota", "overloaded", "cap", "key_refused", "provider_error", "refused"] as const;
export type ModelEgressClass = (typeof MODEL_EGRESS_CLASSES)[number];

/** The classes that make a check "not run" and never "failed". */
export const NOT_RUN_CLASSES = ["rate_limit", "quota", "overloaded", "cap", "key_refused"] as const;
export type ModelEgressNotRunClass = (typeof NOT_RUN_CLASSES)[number];

export const NOT_RUN_SENTENCES: Readonly<Record<Exclude<ModelEgressNotRunClass, "cap">, string>> = {
  rate_limit: "not run: provider rate limit",
  quota: "not run: provider quota used up",
  overloaded: "not run: provider overloaded",
  key_refused: "not run: the product key was refused (check it in Settings)",
};

/** `not run: test model budget reached ($2.00 per task)`. Without a usable amount the sentence names no amount, never a made-up one. */
export function capSentence(capMicros?: number): string {
  return Number.isSafeInteger(capMicros) && (capMicros as number) >= 0 ? `not run: test model budget reached (${formatUsdMicros(capMicros as number)} per task)` : "not run: test model budget reached";
}

/** The most of a body the classifier reads. */
const BODY_READ_MAX = 64 * 1024;

const QUOTA_WORDS = /insufficient_quota|credit balance is too low|billing details|per ?day|daily|spending cap|prepayment|out of credits/iu;
const RATE_WORDS = /rate_limit|rate limit|per ?minute|too many requests|retry/iu;
/** Google words its free-tier per-minute limit like its billing limit ("check your plan and billing details"): a per-minute quota id wins. */
const PER_MINUTE = /per ?minute/iu;

const OVERLOADED_WORDS = /overloaded/iu;

/**
 * The class of a provider's answer. 401 and 403 are the key being refused. A 429 (or a quota message on any 4xx: Anthropic answers an empty balance with a 400) is `quota` when the body says the quota or balance is used up
 * (OpenAI `insufficient_quota`, Anthropic "credit balance is too low", Google daily or billing quota) and `rate_limit` otherwise (Google `RESOURCE_EXHAUSTED` with a per-minute message, Anthropic `rate_limit_error`). 529, 503 and an
 * `overloaded_error` body are `overloaded`. Any other non-2xx is `provider_error`. The body is read as text, bounded, never parsed as trusted structure.
 */
export function classifyProviderResponse(args: { readonly status: number; readonly body?: Uint8Array | string }): ModelEgressClass {
  const { status } = args;
  if (!Number.isInteger(status) || status < 100 || status > 599) return "provider_error";
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "key_refused";
  const text = args.body === undefined ? "" : typeof args.body === "string" ? args.body.slice(0, BODY_READ_MAX) : new TextDecoder().decode(args.body.subarray(0, BODY_READ_MAX));
  if (status === 529 || status === 503 || OVERLOADED_WORDS.test(text)) return "overloaded";
  if (status === 429 || /RESOURCE_EXHAUSTED/u.test(text) || QUOTA_WORDS.test(text)) {
    if (PER_MINUTE.test(text)) return "rate_limit";
    if (QUOTA_WORDS.test(text)) return "quota";
    if (status === 429 || RATE_WORDS.test(text)) return "rate_limit";
  }
  return "provider_error";
}

const REFUSAL_CLASS: Readonly<Record<ModelEgressRefusal, ModelEgressClass>> = {
  not_found: "refused",
  not_allowed: "refused",
  cap: "cap",
  key_refused: "key_refused",
  rate_limit: "rate_limit",
  quota: "quota",
  overloaded: "overloaded",
  bad_request: "refused",
  too_large: "refused",
  ssrf: "refused",
};
export const classOfRefusal = (word: ModelEgressRefusal): ModelEgressClass => REFUSAL_CLASS[word];

/** The class of one of OUR answers, from its head: `x-rovara-refusal` names the word. Without it the answer is a provider's, and `status` alone decides (a missing body means a 429 reads as a rate limit). */
export function classifyOwnResponse(args: { readonly status: number; readonly headers: ReadonlyArray<readonly [string, string]>; readonly body?: Uint8Array | string }): ModelEgressClass {
  const word = args.headers.find(([name]) => name.toLowerCase() === MODEL_EGRESS_REFUSAL_HEADER)?.[1];
  if (word !== undefined && (MODEL_EGRESS_REFUSALS as readonly string[]).includes(word)) return classOfRefusal(word as ModelEgressRefusal);
  return classifyProviderResponse(args);
}
