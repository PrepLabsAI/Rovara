// SageMaker endpoints (design: SageMaker endpoint shim, lane SM4): the fixture document the SageMaker Runtime front of Rovara local AWS accepts for an endpoint answered from recorded or written answers
// (mode "canned"). This file is the SAME shape the front reads, checked the same way, so a document that parses here is one the front accepts and a typo in a field name is refused here as it is there:
//   - the answer to a request is the first rule (in order) whose conditions all hold and whose `times` is not used up, then the next answer of the queue (each once, in order), then the default, then nothing (a
//     ModelError that says no fixture matched, counted as unmatched);
//   - an answer from the default is counted as "made up": the evidence says how many calls had no matching answer;
//   - every list, body and delay is bounded (limits below).
// What it does not check: a regular expression's syntax (the front compiles it with RE2; JavaScript's dialect differs) and a JSON path's grammar beyond its shape. The front refuses those when it reads the document.
// Nothing here imports a Node module, and nothing here is a secret: the recorder (`rovara record sagemaker`) scans every body for personal data before it writes a document.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./web-hash.js";

/** The limits the front holds a document to (the same numbers). */
export const SAGEMAKER_FIXTURE_LIMITS = {
  rules: 1_000,
  queue: 1_000,
  /** The whole document, and the bytes of all its answers together. */
  documentBytes: 8 * 1_048_576,
  /** SageMaker's own response limit: one answer is at most 6 MiB. */
  replyBytes: 6 * 1_048_576,
  delayMs: 60_000,
  partSize: 1_048_576,
  regexLength: 1_000,
  /** The recorder keeps a request's text in the rule (`bodyEquals`) up to this size; a larger or binary body is matched by its hash. */
  requestTextBytes: 65_536,
} as const;

export const SAGEMAKER_OPERATIONS = ["invoke", "stream", "async"] as const;
export const SAGEMAKER_FIXTURE_SOURCES = ["recorded", "handwritten"] as const;
/** The errors a fixture may answer with, and the HTTP status each has. */
export const SAGEMAKER_ERROR_STATUS = { ModelError: 424, ValidationError: 400, ModelNotReadyException: 429, InternalFailure: 500, ServiceUnavailable: 503 } as const;
export const SAGEMAKER_ERROR_CODES = ["ModelError", "ValidationError", "ModelNotReadyException", "InternalFailure", "ServiceUnavailable"] as const;
export const SAGEMAKER_STREAM_ERROR_CODES = ["StreamBroken", "ModelInvocationTimeExceeded"] as const;

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;
const NO_LINE_BREAK = /^[^\r\n\0]*$/u;
const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
const Sha256Hex = z.string().regex(/^[a-f0-9]{64}$/u, "a lower-case hex SHA-256");

/** A header value: one line, no control character. */
const headerValue = (max: number) => z.string().max(max).regex(NO_LINE_BREAK, "one line");

/** The conditions of one rule; every condition present must hold. */
export const SageMakerMatchSchema = z
  .object({
    /** `invoke`, `stream` or `async`; absent: any. */
    operation: z.enum(SAGEMAKER_OPERATIONS).optional(),
    /** The request's content type, compared without parameters and without case. */
    contentType: headerValue(200).optional(),
    accept: headerValue(200).optional(),
    /** The hex SHA-256 of the request body. */
    bodySha256: Sha256Hex.optional(),
    /** The whole body, as text. */
    bodyEquals: z.string().max(SAGEMAKER_FIXTURE_LIMITS.requestTextBytes).optional(),
    /** Text inside the body. */
    bodyContains: z.string().min(1).max(SAGEMAKER_FIXTURE_LIMITS.requestTextBytes).optional(),
    /** `$.a.b[0]['c']` on a JSON body, with one of `equals`, `matches` or `exists`. */
    jsonPath: z.string().min(1).max(500).regex(/^\$[^\p{Cc}\p{Cf}]*$/u, "a JSON path that starts with $").optional(),
    /** The value at `jsonPath`, as JSON. */
    equals: z.unknown().optional(),
    /** A regular expression (RE2) the value at `jsonPath`, or the body, must match. */
    matches: z.string().min(1).max(SAGEMAKER_FIXTURE_LIMITS.regexLength).optional(),
    exists: z.boolean().optional(),
    targetVariant: headerValue(63).optional(),
    customAttributes: headerValue(1_024).optional(),
    targetModel: headerValue(1_024).optional(),
  })
  .strict()
  .superRefine((match, context) => {
    if (match.jsonPath === undefined && (match.exists !== undefined || match.equals !== undefined)) context.addIssue({ code: "custom", path: ["jsonPath"], message: "equals and exists need a jsonPath" });
  });
export type SageMakerMatch = z.infer<typeof SageMakerMatchSchema>;

export const SageMakerErrorSpecSchema = z
  .object({
    /** Default `ModelError`. */
    code: z.enum(SAGEMAKER_ERROR_CODES).optional(),
    message: z.string().max(4_096).optional(),
    /** `ModelError`: the status the container answered with (default 500). */
    originalStatusCode: z.number().int().min(0).max(599).optional(),
    originalMessage: z.string().max(4_096).optional(),
  })
  .strict();

export const SageMakerStreamErrorSchema = z
  .object({
    /** Default `StreamBroken`. */
    errorCode: z.enum(SAGEMAKER_STREAM_ERROR_CODES).optional(),
    message: z.string().max(4_096).optional(),
  })
  .strict();

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
/** The bytes a base64 text holds (0 for text that is not base64: the schema refuses it separately). */
export const base64DecodedBytes = (text: string): number => (text.length % 4 === 0 && BASE64.test(text) ? (text.length / 4) * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0) : 0);

/** One answer: a body (text, bytes, JSON or streamed parts) or an error, with the reply's headers and delays. */
export const SageMakerResponseSchema = z
  .object({
    body: z.string().optional(),
    bodyBase64: z.string().regex(BASE64, "base64").optional(),
    /** A JSON value, written as compact JSON. */
    json: z.unknown().optional(),
    /** Streaming: the parts, in order (instead of a body). */
    parts: z.array(z.string()).max(10_000).optional(),
    /** Streaming: split the body into parts of about this many bytes (default 64). */
    partSize: z.number().int().min(0).max(SAGEMAKER_FIXTURE_LIMITS.partSize).optional(),
    partDelayMs: z.number().int().min(0).max(SAGEMAKER_FIXTURE_LIMITS.delayMs).optional(),
    streamError: SageMakerStreamErrorSchema.optional(),
    /** Default: the request's Accept when it names one, else application/json. */
    contentType: headerValue(200).optional(),
    customAttributes: headerValue(1_024).optional(),
    /** The production variant that answered. */
    variant: headerValue(63).optional(),
    delayMs: z.number().int().min(0).max(SAGEMAKER_FIXTURE_LIMITS.delayMs).optional(),
    error: SageMakerErrorSpecSchema.optional(),
  })
  .strict()
  .superRefine((response, context) => {
    const forms = [response.body !== undefined, response.bodyBase64 !== undefined, response.json !== undefined, (response.parts?.length ?? 0) > 0].filter(Boolean).length;
    if (forms > 1) context.addIssue({ code: "custom", path: [], message: "an answer has one of body, bodyBase64, json or parts" });
    if (response.bodyBase64 !== undefined && base64DecodedBytes(response.bodyBase64) === 0 && response.bodyBase64 !== "") context.addIssue({ code: "custom", path: ["bodyBase64"], message: "bodyBase64 is not base64" });
    if (sageMakerResponseBytes(response) > SAGEMAKER_FIXTURE_LIMITS.replyBytes) context.addIssue({ code: "custom", path: [], message: "an answer is larger than 6 MiB" });
  });
export type SageMakerResponse = z.infer<typeof SageMakerResponseSchema>;

/** The bytes an answer's body holds (0 for an error answer). Never throws: a value that cannot be written as JSON counts as nothing. */
export function sageMakerResponseBytes(response: Pick<SageMakerResponse, "body" | "bodyBase64" | "json" | "parts">): number {
  if (response.body !== undefined) return bytes(response.body);
  if (response.bodyBase64 !== undefined) return base64DecodedBytes(response.bodyBase64);
  if (response.json !== undefined) {
    try { return bytes(JSON.stringify(response.json)); } catch { return 0; }
  }
  return (response.parts ?? []).reduce((sum, part) => sum + bytes(part), 0);
}

export const SageMakerRuleSchema = z
  .object({
    match: SageMakerMatchSchema,
    response: SageMakerResponseSchema,
    /** 0 or absent: any number of times. */
    times: z.number().int().min(0).max(1_000_000).optional(),
  })
  .strict();
export type SageMakerRule = z.infer<typeof SageMakerRuleSchema>;

/** `YYYY-MM-DD`, or a UTC time: when a recording was made. At most 40 characters, as the front reads it. */
const RecordedOn = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(?:T[0-9:.]{2,20}Z)?$/u, "a date");

/**
 * The document of an endpoint answered from fixtures. `source` says what the evidence calls the answers (`recorded` in the customer's own environment, or `handwritten`, the default). The front reads a `mode`
 * of `canned` (the default) from the same document; the other modes have no fixtures.
 */
export const SageMakerFixtureDocumentSchema = z
  .object({
    mode: z.literal("canned").optional(),
    source: z.enum(SAGEMAKER_FIXTURE_SOURCES).optional(),
    recordedOn: RecordedOn.optional(),
    /** Wait before an asynchronous answer is written (the front's default is 100). */
    asyncDelayMs: z.number().int().min(0).max(SAGEMAKER_FIXTURE_LIMITS.delayMs).optional(),
    rules: z.array(SageMakerRuleSchema).max(SAGEMAKER_FIXTURE_LIMITS.rules).optional(),
    queue: z.array(SageMakerResponseSchema).max(SAGEMAKER_FIXTURE_LIMITS.queue).optional(),
    default: SageMakerResponseSchema.optional(),
  })
  .strict()
  .superRefine((document, context) => {
    const total = sageMakerDocumentAnswerBytes(document);
    if (total > SAGEMAKER_FIXTURE_LIMITS.documentBytes) context.addIssue({ code: "custom", path: [], message: "the answers hold more than 8 MiB" });
    if (document.source === "recorded" && document.recordedOn === undefined) context.addIssue({ code: "custom", path: ["recordedOn"], message: "a recorded document says when it was recorded" });
    if (document.source !== "recorded" && document.recordedOn !== undefined) context.addIssue({ code: "custom", path: ["recordedOn"], message: "only a recorded document has a recording date" });
    for (const [index, rule] of (document.rules ?? []).entries()) {
      for (const field of ["contentType", "accept"] as const) if (rule.match[field] !== undefined && !NO_HIDDEN.test(rule.match[field])) context.addIssue({ code: "custom", path: ["rules", index, "match", field], message: "one plain line" });
    }
  });
export type SageMakerFixtureDocument = z.infer<typeof SageMakerFixtureDocumentSchema>;

/** The bytes of every answer in a document together (the front's 8 MiB limit). */
export function sageMakerDocumentAnswerBytes(document: Pick<SageMakerFixtureDocument, "rules" | "queue" | "default">): number {
  return [...(document.rules ?? []).map((rule) => rule.response), ...(document.queue ?? []), ...(document.default === undefined ? [] : [document.default])].reduce((sum, response) => sum + sageMakerResponseBytes(response), 0);
}

/** Whether the document answers a request that matches nothing with a made-up answer (it has a default). The evidence counts those calls. */
export const sageMakerDocumentMakesUpAnswers = (document: Pick<SageMakerFixtureDocument, "default">): boolean => document.default !== undefined;

/** The digest a document is pinned by in the approved plan: the SHA-256 of its canonical JSON. */
export function sageMakerFixtureDigest(document: SageMakerFixtureDocument): string {
  return sha256Hex(canonicalJson(SageMakerFixtureDocumentSchema.parse(document)));
}

/** Text with a control character other than tab, carriage return and line feed is not text: it is how UTF-16 and other encodings of text look when read as UTF-8. */
export function looksBinary(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

/**
 * What a scan reads of bytes that are not plain UTF-8 text: the bytes as lossy UTF-8, as UTF-16 (either byte order), and with the NUL bytes taken out (how UTF-16 of ASCII text looks as single-byte text). An encoding that
 * only changes how text is stored must not hide it from the scan.
 */
export function binaryScanTexts(raw: Uint8Array): string[] {
  const even = raw.subarray(0, raw.length - (raw.length % 2));
  const swapped = Uint8Array.from(even);
  for (let index = 0; index + 1 < swapped.length; index += 2) { const first = swapped[index] ?? 0; swapped[index] = swapped[index + 1] ?? 0; swapped[index + 1] = first; }
  const stripped = Array.from(raw.filter((byte) => byte !== 0), (byte) => String.fromCharCode(byte)).join("");
  return [new TextDecoder().decode(raw), new TextDecoder("utf-16le").decode(even), new TextDecoder("utf-16le").decode(swapped), stripped];
}

/** The request texts and answer texts of a document, each with the path that names it, for a scan. A base64 body is decoded so personal data cannot hide in it, and a body that is not plain text (not UTF-8, or holding control characters such as the NULs of UTF-16) is listed once for each way it can be read, with `binary` set. Every string field of a rule's match is listed, and streamed parts both one by one and joined. */
export function sageMakerDocumentTexts(document: SageMakerFixtureDocument): Array<{ path: string; text: string; binary: boolean }> {
  const out: Array<{ path: string; text: string; binary: boolean }> = [];
  const push = (path: string, text: string | undefined): void => { if (text !== undefined) out.push({ path, text, binary: looksBinary(text) }); };
  const answer = (path: string, response: SageMakerResponse): void => {
    push(`${path}.body`, response.body);
    if (response.bodyBase64 !== undefined) {
      const raw = base64ToBytes(response.bodyBase64);
      const text = new TextDecoder().decode(raw);
      if (isUtf8(raw) && !looksBinary(text)) out.push({ path: `${path}.bodyBase64`, text, binary: false });
      else for (const variant of binaryScanTexts(raw)) out.push({ path: `${path}.bodyBase64`, text: variant, binary: true });
    }
    if (response.json !== undefined) push(`${path}.json`, safeJson(response.json));
    const parts = response.parts ?? [];
    parts.forEach((part, index) => push(`${path}.parts[${String(index)}]`, part));
    if (parts.length > 1) push(`${path}.parts`, parts.join(""));
    for (const field of ["customAttributes", "variant", "contentType"] as const) push(`${path}.${field}`, response[field]);
    push(`${path}.error.message`, response.error?.message);
    push(`${path}.error.originalMessage`, response.error?.originalMessage);
    push(`${path}.streamError.message`, response.streamError?.message);
  };
  (document.rules ?? []).forEach((rule, index) => {
    const path = `rules[${String(index)}]`;
    for (const field of ["contentType", "accept", "bodyEquals", "bodyContains", "matches", "jsonPath", "targetVariant", "customAttributes", "targetModel"] as const) push(`${path}.match.${field}`, rule.match[field]);
    if (rule.match.equals !== undefined) push(`${path}.match.equals`, safeJson(rule.match.equals));
    answer(`${path}.response`, rule.response);
  });
  (document.queue ?? []).forEach((response, index) => answer(`queue[${String(index)}]`, response));
  if (document.default !== undefined) answer("default", document.default);
  return out;
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

/** The bytes of a base64 text (as `base64DecodedBytes` counted them); empty for text that is not base64. */
export function base64ToBytes(text: string): Uint8Array {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return new Uint8Array(0);
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function isUtf8(raw: Uint8Array): boolean {
  try { new TextDecoder("utf-8", { fatal: true }).decode(raw); return true; } catch { return false; }
}
