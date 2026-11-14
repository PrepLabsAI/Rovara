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
/** Google words its free-tier per-minute limit like its billing limit ("check your plan and billing details"): a per-minute quota id wins. */
const PER_MINUTE = /per ?minute/iu;
const OVERLOADED_WORDS = /overloaded/iu;
/** Anthropic words an empty balance this way, at the START of the error message (never anywhere in it: the message can echo a prompt). */
const CREDIT_BALANCE_START = /^your credit balance is too low to access the anthropic api/iu;

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | undefined => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined);
const own = (object: Rec | undefined, key: string): unknown => (object !== undefined && Object.hasOwn(object, key) ? object[key] : undefined);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The structured fields of a provider error body: OpenAI `error.type` and `error.code`, Anthropic's envelope (`type: "error"` and `error.type`), Google `error.status` and `error.details[].reason`. Free text is kept apart. */
interface ErrorFields {
  readonly type?: string;
  readonly code?: string;
  readonly status?: string;
  readonly reasons: readonly string[];
  /** The body is exactly Anthropic's error envelope: `{ "type": "error", "error": { "type", "message" } }` (and an optional `request_id`), with no other key at either level. */
  readonly anthropicEnvelope: boolean;
  readonly message?: string;
}
function isAnthropicEnvelope(top: Rec | undefined, error: Rec | undefined): boolean {
  if (top === undefined || error === undefined || own(top, "type") !== "error") return false;
  if (Object.keys(top).some((key) => !["type", "error", "request_id"].includes(key))) return false;
  const keys = Object.keys(error);
  return str(own(error, "type")) !== undefined && str(own(error, "message")) !== undefined && keys.every((key) => key === "type" || key === "message");
}

function errorFields(text: string): ErrorFields {
  try {
    const top = rec(JSON.parse(text) as unknown);
    const error = rec(own(top, "error"));
    const details = own(error, "details");
    const reasons = Array.isArray(details) ? (details as unknown[]).map((detail) => str(own(rec(detail), "reason"))).filter((reason): reason is string => reason !== undefined) : [];
    const code = own(error, "code");
    return {
      ...(str(own(error, "type")) === undefined ? {} : { type: str(own(error, "type")) as string }),
      ...(typeof code === "string" ? { code } : typeof code === "number" ? { code: String(code) } : {}),
      ...(str(own(error, "status")) === undefined ? {} : { status: str(own(error, "status")) as string }),
      reasons,
      anthropicEnvelope: isAnthropicEnvelope(top, error),
      ...(str(own(error, "message")) === undefined ? {} : { message: str(own(error, "message")) as string }),
    };
  } catch {
    return { reasons: [], anthropicEnvelope: false };
  }
}

/**
 * The class of a provider's answer. 401 and 403 are the key being refused. The WORD rules (free text) apply only to 429, 503 and 529: a 429 is `quota` when the body says the quota or balance is used up (OpenAI `insufficient_quota`,
 * Google daily or billing quota) and `rate_limit` otherwise (Google `RESOURCE_EXHAUSTED` per minute, Anthropic `rate_limit_error`); 529, 503 and an `overloaded` body on those statuses are `overloaded`. On every other status only
 * STRUCTURED fields count: Google's `API_KEY_INVALID` reason is `key_refused`; `error.type` `overloaded_error` / `rate_limit_error`, `error.code` `insufficient_quota` / `rate_limit_exceeded`, Google `RESOURCE_EXHAUSTED`, and
 * Anthropic's structured credit-balance error (a 400 in its `type: "error"` envelope) are read; free text in a 400, 402, 404, 413 or 500 never reclassifies a failure. Any other non-2xx is `provider_error`. The body is bounded.
 */
export function classifyProviderResponse(args: { readonly status: number; readonly body?: Uint8Array | string }): ModelEgressClass {
  const { status } = args;
  if (!Number.isInteger(status) || status < 100 || status > 599) return "provider_error";
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "key_refused";
  const text = args.body === undefined ? "" : typeof args.body === "string" ? args.body.slice(0, BODY_READ_MAX) : new TextDecoder().decode(args.body.subarray(0, BODY_READ_MAX));
  if (status === 529 || status === 503) return "overloaded";
  if (status === 429) {
    if (OVERLOADED_WORDS.test(text)) return "overloaded";
    if (PER_MINUTE.test(text)) return "rate_limit";
    if (QUOTA_WORDS.test(text)) return "quota";
    return "rate_limit";
  }
  const fields = errorFields(text);
  if (fields.reasons.includes("API_KEY_INVALID")) return "key_refused";
  if (fields.type === "overloaded_error") return "overloaded";
  if (fields.type === "rate_limit_error" || fields.code === "rate_limit_exceeded") return "rate_limit";
  if (fields.type === "insufficient_quota" || fields.code === "insufficient_quota") return "quota";
  if (fields.status === "RESOURCE_EXHAUSTED") return PER_MINUTE.test(fields.message ?? "") ? "rate_limit" : QUOTA_WORDS.test(fields.message ?? "") ? "quota" : "rate_limit";
  // Anthropic's own envelope only: a `billing_error` type, or its fixed empty-balance sentence at the start of the message of a 400 `invalid_request_error`.
  if (fields.anthropicEnvelope && (fields.type === "billing_error" || (status === 400 && fields.type === "invalid_request_error" && CREDIT_BALANCE_START.test(fields.message ?? "")))) return "quota";
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
