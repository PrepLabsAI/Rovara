// TE-F1a: what goes back to the client. Response headers are an allow list (no `set-cookie`, no provider account headers, nothing of ours a provider could forge). Bodies are scrubbed for the key: on a 401 or 403 the body is
// replaced with a fixed message (some providers echo part of a bad key); every other body is scanned for the key's spellings (raw, JSON-escaped, percent-encoded, base64: `e2e-secret-spellings.ts`) and for its first and last four
// characters, and a hit replaces the body. A body that cannot be scanned (compressed) is replaced too: fail closed.
import { e2eSecretSpellings } from "../e2e-secret-spellings.js";
import { familyErrorBody, MODEL_EGRESS_REFUSAL_HEADER, MODEL_EGRESS_REFUSAL_WORDS } from "./refusals.js";
import type { ModelEgressFamily } from "./schemes.js";

/** The response headers that go back to the client. A retry hint is kept (the client's own retry logic reads it); account, organisation, rate-limit-quota and cookie headers are not. */
export const MODEL_EGRESS_RESPONSE_HEADERS = ["content-type", "cache-control", "retry-after", "retry-after-ms", "x-should-retry", "x-request-id", "request-id"] as const;

const BAD_VALUE = /[^\x20-\x7e]/u;

/**
 * The allow-listed response headers, lower-cased, each once; a value with a control character or non-ASCII is dropped. Anything named `x-rovara-*` is dropped: only our own answers carry it, and they add it AFTER this.
 * With `key` (the adapter's own credential for the call), a header whose value holds any spelling of the key (the body's needles: raw, JSON-escaped, percent-encoded, base64, hex, and the key's first and last four characters,
 * compared without regard to case) is dropped too: an allow-listed name is no promise about what a provider puts in the value (`x-request-id: echo-<key>`). A key too short to scan for throws, as `keyEchoNeedles` does.
 */
export function sanitizeResponseHeaders(headers: ReadonlyArray<readonly [string, string]>, options: { readonly key?: string } = {}): Array<[string, string]> {
  const allowed = new Set<string>(MODEL_EGRESS_RESPONSE_HEADERS);
  const needles = options.key === undefined ? [] : keyEchoNeedles(options.key).map((needle) => needle.toLowerCase());
  const kept = new Map<string, string>();
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (!allowed.has(lower) || lower.startsWith("x-rovara-") || kept.has(lower) || BAD_VALUE.test(value) || value.length > 1024) continue;
    const folded = value.toLowerCase();
    if (needles.some((needle) => folded.includes(needle))) continue;
    kept.set(lower, value);
  }
  return [...kept.entries()];
}

/** Keys shorter than this cannot be scanned for safely: a four-character piece of a shorter key is most of the key, and the same text would match innocent bodies. The adapter refuses to use one. */
export const MODEL_EGRESS_MIN_KEY_CHARS = 12;
const PIECE = 4;

/** Every string a body must not contain: the key's spellings, and its first and last four characters. */
export function keyEchoNeedles(key: string): string[] {
  if (typeof key !== "string" || key.length < MODEL_EGRESS_MIN_KEY_CHARS) throw new RangeError("the key is too short to scan for");
  return [...new Set([...e2eSecretSpellings(key), key.slice(0, PIECE), key.slice(-PIECE)])].filter((needle) => needle.length > 0);
}

export const WITHHELD_SCRUB_SENTENCE = "The provider's answer was withheld because it could not be checked for the product key.";
export const WITHHELD_ECHO_SENTENCE = "The provider's answer was withheld because it appeared to contain the product key.";

/** A provider's 3xx is never followed (a redirect is where a host sends a call somewhere nobody checked): the adapter answers `ssrf` instead, and the `location` header is not on the response allow list. */
export const isRedirectStatus = (status: number): boolean => Number.isInteger(status) && status >= 300 && status < 400;

export type ScrubReason = "auth_status" | "key_echo" | "unscannable";

/** A fixed replacement body in the family's own error shape. */
export function withheldBody(family: ModelEgressFamily, status: number, reason: ScrubReason): Uint8Array {
  const message = reason === "auth_status" ? MODEL_EGRESS_REFUSAL_WORDS.key_refused : reason === "key_echo" ? WITHHELD_ECHO_SENTENCE : WITHHELD_SCRUB_SENTENCE;
  return familyErrorBody(family, status, message, `rovara_${reason}`);
}

export interface ScrubbedBody {
  readonly body: Uint8Array;
  readonly replaced: boolean;
  readonly reason?: ScrubReason;
}

/** Whether a response's `content-encoding` header says the body is not plain text. */
export function isCompressed(headers: ReadonlyArray<readonly [string, string]>): boolean {
  const encoding = headers.find(([name]) => name.toLowerCase() === "content-encoding")?.[1];
  return encoding !== undefined && encoding.trim().toLowerCase() !== "identity" && encoding.trim() !== "";
}

/**
 * One whole body, scrubbed. 401 and 403: always replaced. A compressed body: replaced. Otherwise replaced only when it holds any of the key's needles. Never throws for a body; throws RangeError for a key too short to scan for.
 */
export function scrubResponseBody(args: { readonly family: ModelEgressFamily; readonly status: number; readonly headers: ReadonlyArray<readonly [string, string]>; readonly body: Uint8Array; readonly key: string }): ScrubbedBody {
  const needles = keyEchoNeedles(args.key);
  if (args.status === 401 || args.status === 403) return { body: withheldBody(args.family, args.status, "auth_status"), replaced: true, reason: "auth_status" };
  if (isCompressed(args.headers)) return { body: withheldBody(args.family, args.status, "unscannable"), replaced: true, reason: "unscannable" };
  const text = new TextDecoder().decode(args.body);
  if (needles.some((needle) => text.includes(needle))) return { body: withheldBody(args.family, args.status, "key_echo"), replaced: true, reason: "key_echo" };
  return { body: args.body, replaced: false };
}

export interface KeyEchoScanner {
  /** Feed one chunk. `safe` is what may go to the client now (the last characters that could begin a needle are held back until the next chunk); `hit` is true once any needle was seen, and nothing more is ever released. */
  push(chunk: Uint8Array): { safe: Uint8Array; hit: boolean };
  /** The end of the stream: releases what was held back, unless a needle was seen. */
  finish(): { safe: Uint8Array; hit: boolean };
}

/** A scanner for a streamed body: a key that straddles two chunks is still found, at the cost of holding back the longest needle's length minus one. */
export function createKeyEchoScanner(key: string): KeyEchoScanner {
  const needles = keyEchoNeedles(key);
  const hold = Math.max(...needles.map((needle) => needle.length)) - 1;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let carry = "";
  let hit = false;
  const empty = new Uint8Array(0);
  return {
    push(chunk) {
      if (hit) return { safe: empty, hit: true };
      const text = carry + decoder.decode(chunk, { stream: true });
      if (needles.some((needle) => text.includes(needle))) {
        hit = true;
        carry = "";
        return { safe: empty, hit: true };
      }
      const cut = Math.max(0, text.length - hold);
      // Never split a surrogate pair.
      const edge = cut > 0 && /[\ud800-\udbff]/u.test(text.charAt(cut - 1)) ? cut - 1 : cut;
      carry = text.slice(edge);
      return { safe: encoder.encode(text.slice(0, edge)), hit: false };
    },
    finish() {
      if (hit) return { safe: empty, hit: true };
      const text = carry + decoder.decode();
      carry = "";
      if (needles.some((needle) => text.includes(needle))) {
        hit = true;
        return { safe: empty, hit: true };
      }
      return { safe: encoder.encode(text), hit: false };
    },
  };
}

/** The header an own answer carries to say why: kept here so every builder spells it once. */
export const ownRefusalHeader = (word: string): [string, string] => [MODEL_EGRESS_REFUSAL_HEADER, word];
