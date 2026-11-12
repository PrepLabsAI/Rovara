// `rovara record sagemaker` (design: SageMaker endpoint shim, lane SM5): the recorder. A customer runs it in THEIR OWN environment (their account, their laptop or their CI) against THEIR real endpoint, with a file of
// SYNTHETIC requests. It writes the answers as a fixture file that Rovara's SageMaker fake can serve, after a scan for personal data. The order, and every rule:
//   1. the input file is read and checked; every request is scanned FIRST, and nothing is sent while any request holds a finding (the inputs are the customer's to make synthetic);
//   2. each request is sent, one at a time with a deadline, to the endpoint through the invoker (the customer's own AWS CLI by default). A call that fails for any reason but the model's own error stops the recording:
//      a credential problem or a throttle is not the model's answer, and is never recorded;
//   3. every answer (and the headers it returns) is scanned. A finding REFUSES the recording by default; with `--on-finding redact` the found spans are replaced by a fixed placeholder, the redacted text is scanned
//      AGAIN, and a text that cannot be redacted cleanly (a binary answer, JSON that the replacement would break, a finding that is still there) refuses the recording;
//   4. the file is built, validated against the format the SageMaker front accepts, scanned ONE MORE TIME as a whole (what is written is exactly what was scanned), and only then written, atomically, readable by its
//      owner only, and never over an existing file unless `--force`.
// What it never does: send anything anywhere but the customer's endpoint (and, if the customer asks, an analyzer they run); need a Rovara sign-in or credential; print a request, an answer or a matched value (it
// names a kind and a field: `inputs[2].body`, `answers[5].body`); keep a file after a refusal.
// The scanner is an interface: the built-in heuristic scanner always runs, and a Presidio analyzer the customer runs can be added (`presidio.ts`). Rovara scans the file again when it is uploaded (`rescanSageMakerRecording`).
import { createHash } from "node:crypto";
import { access, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  SAGEMAKER_RECORDER_NAME,
  SAGEMAKER_RECORDING_MAX_BYTES,
  SAGEMAKER_RECORDING_MAX_PAIRS,
  SAGEMAKER_FIXTURE_LIMITS,
  SageMakerEndpointNameSchema,
  SageMakerRecordingFileSchema,
  binaryScanTexts,
  deepScan,
  looksBinary,
  type DeepScan,
  rescanSageMakerRecording,
  type PiiKind,
  type PiiScanner,
  type SageMakerFixtureDocument,
  type SageMakerRecordingFile,
  type SageMakerResponse,
  type SageMakerRule,
} from "@agentx/contracts";
import { isSafeCliValue, type InvokeFailure, type InvokeRequest, type SageMakerInvoker } from "./invoker.js";

export const RECORD_MAX_INPUTS = SAGEMAKER_RECORDING_MAX_PAIRS;
/** The most an input file weighs. */
export const RECORD_INPUT_FILE_MAX_BYTES = 8 * 1_048_576;

// ---- the input file

const HeaderText = z.string().min(1).max(1_024).refine(isSafeCliValue, "one plain line that the AWS CLI does not read as a file, an address or an option");
/** One synthetic request: its body as text (`body`), a JSON value (`json`) or bytes (`bodyBase64`), and the request headers that matter. */
const RecordInputSchema = z
  .object({
    body: z.string().max(SAGEMAKER_FIXTURE_LIMITS.replyBytes).optional(),
    json: z.unknown().optional(),
    bodyBase64: z.string().max(SAGEMAKER_FIXTURE_LIMITS.replyBytes * 2).regex(/^[A-Za-z0-9+/]*={0,2}$/u).optional(),
    contentType: HeaderText.max(200).optional(),
    accept: HeaderText.max(200).optional(),
    customAttributes: HeaderText.optional(),
    targetVariant: HeaderText.max(63).optional(),
    targetModel: HeaderText.optional(),
  })
  .strict()
  .refine((input) => [input.body !== undefined, input.json !== undefined, input.bodyBase64 !== undefined].filter(Boolean).length === 1, { message: "a request has one of body, json or bodyBase64" });
export type RecordInput = z.infer<typeof RecordInputSchema>;

export type InputsProblem = "empty" | "too_large" | "too_many" | "not_json" | "invalid_input";

/** The requests of an input file: a JSON array, or one JSON value per line (JSON Lines). Fixed problem words; the offending text is never echoed. */
export function parseRecordInputs(text: string): { ok: true; inputs: RecordInput[] } | { ok: false; problem: InputsProblem; index?: number } {
  if (Buffer.byteLength(text) > RECORD_INPUT_FILE_MAX_BYTES) return { ok: false, problem: "too_large" };
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, problem: "empty" };
  let values: unknown[];
  try {
    values = trimmed.startsWith("[") ? (JSON.parse(trimmed) as unknown[]) : trimmed.split(/\r?\n/u).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as unknown);
  } catch {
    return { ok: false, problem: "not_json" };
  }
  if (!Array.isArray(values)) return { ok: false, problem: "not_json" };
  if (values.length === 0) return { ok: false, problem: "empty" };
  if (values.length > RECORD_MAX_INPUTS) return { ok: false, problem: "too_many" };
  const inputs: RecordInput[] = [];
  for (const [index, value] of values.entries()) {
    const parsed = RecordInputSchema.safeParse(value);
    if (!parsed.success) return { ok: false, problem: "invalid_input", index };
    inputs.push(parsed.data);
  }
  return { ok: true, inputs };
}

// ---- the recording

export type RecordPolicy = "refuse" | "redact";

export interface RecordOptions {
  endpointName: string;
  inputs: readonly RecordInput[];
  /** The file to write. */
  out: string;
  /** What to do with a finding in an ANSWER: refuse the recording (default) or redact the span. A finding in a request always refuses. */
  policy?: RecordPolicy;
  /** The content type a request has when it names none (`application/json`). */
  defaultContentType?: string;
  /** The accept header a request has when it names none. */
  defaultAccept?: string;
  /** Allow requests and answers that are not text (they are stored as bytes, and only scanned as text). */
  allowBinary?: boolean;
  /** Replace an existing file. */
  force?: boolean;
  perCallTimeoutMs?: number;
}

export interface RecordDeps {
  invoker: SageMakerInvoker;
  scanner: PiiScanner;
  now(): Date;
  /** The recorder's version, written into the file. */
  version: string;
}

export type RecordFinding = { kind: PiiKind; field: string };
export type RecordRefusal = "bad_endpoint_name" | "bad_inputs" | "request_findings" | "binary_not_allowed" | "invoke_failed" | "answer_findings" | "redaction_failed" | "scan_failed" | "too_large" | "exists" | "write_failed";

export type RecordResult =
  | { ok: true; out: string; pairs: number; duplicates: number; redactions: number; modelErrors: number; scanners: string }
  | { ok: false; reason: RecordRefusal; /** Where findings are, by kind and field. Never what was found. */ findings?: RecordFinding[]; failure?: InvokeFailure; /** The input or answer that stopped the recording (0-based). */ index?: number };

export const RECORD_REFUSAL_WORDS: Record<RecordRefusal, string> = {
  bad_endpoint_name: "That is not a SageMaker endpoint name.",
  bad_inputs: "The input file is not usable. It is a JSON array, or one JSON object per line, of requests with a `body`, `json` or `bodyBase64`.",
  request_findings: "A request in the input file holds data that looks personal. Nothing was sent. Replace it with synthetic data and run again.",
  binary_not_allowed: "A request or an answer is not text. Add --allow-binary to record it (it is scanned only as text).",
  invoke_failed: "The call to the endpoint failed, so nothing was written.",
  answer_findings: "An answer holds data that looks personal, so nothing was written. Use synthetic inputs that do not make the model echo real data, or run with --on-finding redact.",
  redaction_failed: "An answer could not be redacted cleanly (it is not text, redaction would break its JSON, or a finding was still there), so nothing was written.",
  scan_failed: "The personal-data scan could not finish, so nothing was written.",
  too_large: "The recording does not fit the recording format (more answers or bytes than a recording may hold).",
  exists: "The output file exists. Use --force to replace it.",
  write_failed: "The file could not be written.",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The request's bytes. */
function bodyOf(input: RecordInput): Uint8Array {
  if (input.body !== undefined) return encoder.encode(input.body);
  if (input.bodyBase64 !== undefined) return new Uint8Array(Buffer.from(input.bodyBase64, "base64"));
  return encoder.encode(JSON.stringify(input.json) ?? "null");
}

/** The bytes as text, or undefined when they are not plain text: not UTF-8, or holding control characters other than tab, carriage return and line feed (the NULs of UTF-16 text, for one). */
function textOf(bytes: Uint8Array): string | undefined {
  try {
    const text = decoder.decode(bytes);
    return looksBinary(text) ? undefined : text;
  } catch {
    return undefined;
  }
}

/** What a scan reads of a body: its text, or, for a body that is not plain text, each way its bytes can be read as text. */
const bodyScanItems = (field: string, bytes: Uint8Array, text: string | undefined): Array<{ field: string; text: string }> =>
  text === undefined ? binaryScanTexts(bytes).map((variant) => ({ field, text: variant })) : [{ field, text }];

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const mediaType = (contentType: string): string => (contentType.split(";")[0] ?? "").trim().toLowerCase();

interface Pending { request: InvokeRequest; text: string | undefined; field: string }

type Scanned = Array<{ field: string; kinds: PiiKind[]; deep: DeepScan }>;

/** Scans each item as written, as a reader sees it, and (JSON) decoded. An item with a finding comes back with its kinds and a way to redact it. A scanner that cannot finish fails the whole scan. */
async function scanAll(scanner: PiiScanner, items: ReadonlyArray<{ field: string; text: string }>): Promise<{ ok: true; findings: Scanned } | { ok: false }> {
  const findings: Scanned = [];
  try {
    for (const item of items) {
      const deep = await deepScan(scanner, item.text);
      if (deep.kinds.length > 0) findings.push({ field: item.field, kinds: deep.kinds, deep });
    }
  } catch {
    return { ok: false };
  }
  return { ok: true, findings };
}

const kindsAt = (findings: Scanned): RecordFinding[] => {
  const out: RecordFinding[] = [];
  for (const entry of findings) for (const kind of entry.kinds) if (!out.some((found) => found.field === entry.field && found.kind === kind)) out.push({ kind, field: entry.field });
  return out.slice(0, 100);
};

/** Records the endpoint's answers to a file. Never throws for a refusal: it returns it, with fixed words to show. */
export async function recordSageMakerEndpoint(options: RecordOptions, deps: RecordDeps): Promise<RecordResult> {
  if (!SageMakerEndpointNameSchema.safeParse(options.endpointName).success) return { ok: false, reason: "bad_endpoint_name" };
  if (options.inputs.length === 0 || options.inputs.length > RECORD_MAX_INPUTS) return { ok: false, reason: "bad_inputs" };
  const policy = options.policy ?? "refuse";
  const defaultType = options.defaultContentType ?? "application/json";
  if (!isSafeCliValue(defaultType) || (options.defaultAccept !== undefined && !isSafeCliValue(options.defaultAccept))) return { ok: false, reason: "bad_inputs" };
  if (options.force !== true && (await exists(options.out))) return { ok: false, reason: "exists" };

  // 1. Requests: built, checked and scanned before anything is sent.
  const pending: Pending[] = [];
  const scanItems: Array<{ field: string; text: string }> = [];
  for (const [index, input] of options.inputs.entries()) {
    const body = bodyOf(input);
    if (body.length > SAGEMAKER_FIXTURE_LIMITS.replyBytes) return { ok: false, reason: "bad_inputs", index };
    const text = textOf(body);
    if (text === undefined && options.allowBinary !== true) return { ok: false, reason: "binary_not_allowed", index };
    const request: InvokeRequest = {
      endpointName: options.endpointName, contentType: input.contentType ?? defaultType, body,
      ...((input.accept ?? options.defaultAccept) === undefined ? {} : { accept: (input.accept ?? options.defaultAccept)! }),
      ...(input.customAttributes === undefined ? {} : { customAttributes: input.customAttributes }),
      ...(input.targetVariant === undefined ? {} : { targetVariant: input.targetVariant }),
      ...(input.targetModel === undefined ? {} : { targetModel: input.targetModel }),
    };
    pending.push({ request, text, field: `inputs[${String(index)}]` });
    // A body that is not plain text is scanned each way its bytes can be read, like the upload scan does.
    scanItems.push(...bodyScanItems(`inputs[${String(index)}].body`, body, text));
    for (const name of ["contentType", "accept", "customAttributes", "targetVariant", "targetModel"] as const) if (request[name] !== undefined) scanItems.push({ field: `inputs[${String(index)}].${name}`, text: request[name] });
  }
  const requestScan = await scanAll(deps.scanner, scanItems);
  if (!requestScan.ok) return { ok: false, reason: "scan_failed" };
  if (requestScan.findings.length > 0) return { ok: false, reason: "request_findings", findings: kindsAt(requestScan.findings) };

  // 2 and 3. Send each request, scan its answer.
  const rules: SageMakerRule[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let redactions = 0;
  let modelErrors = 0;
  for (const [index, item] of pending.entries()) {
    const key = [mediaType(item.request.contentType), item.request.accept ?? "", item.request.customAttributes ?? "", item.request.targetVariant ?? "", item.request.targetModel ?? "", sha256(item.request.body)].join("\0");
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.perCallTimeoutMs ?? 70_000);
    let outcome: Awaited<ReturnType<SageMakerInvoker["invoke"]>>;
    try {
      outcome = await deps.invoker.invoke(item.request, controller.signal);
    } catch {
      return { ok: false, reason: "invoke_failed", failure: "failed", index };
    } finally {
      clearTimeout(timer);
    }
    if (outcome.kind === "failed") return { ok: false, reason: "invoke_failed", failure: outcome.failure, index };
    const match = requestMatch(item.request, item.text);
    if (outcome.kind === "model_error") {
      modelErrors += 1;
      rules.push({ match, response: { error: { code: "ModelError", originalStatusCode: outcome.originalStatusCode } } });
      continue;
    }
    const answer = await answerResponse(outcome, `answers[${String(index)}]`, { policy, allowBinary: options.allowBinary === true, scanner: deps.scanner });
    if (!answer.ok) return { ...answer, index };
    redactions += answer.redactions;
    rules.push({ match, response: answer.response });
  }

  // 4. The file, scanned as a whole, then written.
  const recordedAt = deps.now();
  const document: SageMakerFixtureDocument = { mode: "canned", source: "recorded", recordedOn: recordedAt.toISOString().slice(0, 10), rules };
  const file: SageMakerRecordingFile = {
    format: "rovara-sagemaker-recording", version: 1, endpointName: options.endpointName, recordedAt: recordedAt.toISOString(), recorder: { name: SAGEMAKER_RECORDER_NAME, version: deps.version },
    scan: { scanners: deps.scanner.id.split("+"), policy, requests: pending.length, answers: rules.length, redactions, open: 0 },
    pairs: rules.length, fixtures: document,
  };
  const valid = SageMakerRecordingFileSchema.safeParse(file);
  if (!valid.success) return { ok: false, reason: "too_large" };
  const text = `${JSON.stringify(valid.data, null, 2)}\n`;
  if (Buffer.byteLength(text) > SAGEMAKER_RECORDING_MAX_BYTES) return { ok: false, reason: "too_large" };
  let final: Awaited<ReturnType<typeof rescanSageMakerRecording>>;
  try { final = await rescanSageMakerRecording(JSON.parse(text) as unknown, deps.scanner); } catch { return { ok: false, reason: "scan_failed" }; }
  if (!final.ok) return { ok: false, reason: final.reason === "findings" ? "answer_findings" : "too_large", findings: final.findings.map((entry) => ({ kind: entry.kind, field: entry.path })) };
  const written = await writeAtomically(options.out, text, options.force === true);
  if (written !== "ok") return { ok: false, reason: written };
  return { ok: true, out: options.out, pairs: rules.length, duplicates, redactions, modelErrors, scanners: deps.scanner.id };
}

/** How a request is matched when the front serves the recording: its operation, media type, accept and headers, and its text (kept when small) or its hash. */
function requestMatch(request: InvokeRequest, text: string | undefined): SageMakerRule["match"] {
  const small = text !== undefined && encoder.encode(text).length <= SAGEMAKER_FIXTURE_LIMITS.requestTextBytes;
  return {
    operation: "invoke", contentType: mediaType(request.contentType),
    ...(request.accept === undefined ? {} : { accept: mediaType(request.accept) }),
    ...(small ? { bodyEquals: text } : { bodySha256: sha256(request.body) }),
    ...(request.targetVariant === undefined ? {} : { targetVariant: request.targetVariant }),
    ...(request.customAttributes === undefined ? {} : { customAttributes: request.customAttributes }),
    ...(request.targetModel === undefined ? {} : { targetModel: request.targetModel }),
  };
}

type AnswerResult = { ok: true; response: SageMakerResponse; redactions: number } | { ok: false; reason: "answer_findings" | "redaction_failed" | "binary_not_allowed" | "scan_failed"; findings?: RecordFinding[] };

/** One answer, scanned, and redacted or refused. */
async function answerResponse(outcome: { body: Uint8Array; contentType: string; customAttributes?: string | undefined; variant?: string | undefined }, field: string, rules: { policy: RecordPolicy; allowBinary: boolean; scanner: PiiScanner }): Promise<AnswerResult> {
  const text = textOf(outcome.body);
  if (text === undefined && !rules.allowBinary) return { ok: false, reason: "binary_not_allowed" };
  const headers = [["contentType", outcome.contentType], ["customAttributes", outcome.customAttributes], ["variant", outcome.variant]] as const;
  const items = [...bodyScanItems(`${field}.body`, outcome.body, text), ...headers.flatMap(([name, value]) => (value === undefined ? [] : [{ field: `${field}.${name}`, text: value }]))];
  const scanned = await scanAll(rules.scanner, items);
  if (!scanned.ok) return { ok: false, reason: "scan_failed" };
  let redactions = 0;
  const redacted: Record<string, string> = {};
  if (scanned.findings.length > 0) {
    if (rules.policy === "refuse") return { ok: false, reason: "answer_findings", findings: kindsAt(scanned.findings) };
    // Redaction: text only. Binary, and a header, cannot be cleaned.
    for (const entry of scanned.findings) {
      if (entry.field !== `${field}.body` || text === undefined) return { ok: false, reason: "redaction_failed", findings: kindsAt(scanned.findings) };
      redacted.body = entry.deep.redacted();
      redactions += (redacted.body.match(/\[REDACTED:/gu) ?? []).length - (text.match(/\[REDACTED:/gu) ?? []).length;
    }
    const type = mediaType(outcome.contentType);
    if ((type === "application/json" || type.endsWith("+json")) && redacted.body !== undefined) {
      try { JSON.parse(redacted.body); } catch { return { ok: false, reason: "redaction_failed" }; }
    }
    // The redacted text is scanned again: a finding left over refuses the recording.
    const again = await scanAll(rules.scanner, [{ field: `${field}.body`, text: redacted.body ?? "" }]);
    if (!again.ok) return { ok: false, reason: "scan_failed" };
    if (again.findings.length > 0) return { ok: false, reason: "redaction_failed", findings: kindsAt(again.findings) };
  }
  const base = { contentType: outcome.contentType, ...(outcome.customAttributes === undefined ? {} : { customAttributes: outcome.customAttributes }), ...(outcome.variant === undefined ? {} : { variant: outcome.variant }) };
  const response: SageMakerResponse = text === undefined ? { ...base, bodyBase64: Buffer.from(outcome.body).toString("base64") } : { ...base, body: redacted.body ?? text };
  return { ok: true, response, redactions };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Writes the file next to its destination and renames it into place, readable by its owner only. A failed write leaves nothing behind. */
async function writeAtomically(out: string, text: string, force: boolean): Promise<"ok" | "exists" | "write_failed"> {
  const temporary = join(dirname(out), `.${basename(out)}.${createHash("sha256").update(`${out}${String(Date.now())}${String(Math.random())}`).digest("hex").slice(0, 12)}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); } finally { await handle.close(); }
    if (!force && (await exists(out))) { await rm(temporary, { force: true }); return "exists"; }
    await rename(temporary, out);
    return "ok";
  } catch {
    await rm(temporary, { force: true });
    return "write_failed";
  }
}
