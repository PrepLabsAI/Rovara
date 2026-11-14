// Proof and evidence B2: an API sample is one request/response record of an API case, kept as evidence in a form that cannot hold a secret by construction. Raw bodies cannot be redacted reliably by pattern
// alone, so a sample is built on an ALLOW-LIST (design 3.3):
//   1. Headers: only content-type, content-length, cache-control and a request id survive. Authorization, cookies and every other header are dropped, never masked.
//   2. Bodies: JSON only (anything else is recorded as "non-JSON body, n bytes"). Every leaf value becomes a type placeholder (`<string 12>`, `<number>`, `<bool>`) unless its JSON path is on the
//      scenario's approved "safe to show" list. Keys are kept (the structure is the evidence), except a key that looks like a token, an identifier or an address.
//   3. The run's own redaction and credential scan run over the finished bytes by the caller (the capture recorder drops a sample that carries an account credential in any spelling).
//   4. The before/after diff compares structure plus the values of allowed paths, and its output is a list of changed paths, never a value.
// Pure and bounded: no I/O, no clock, no randomness. Browser-safe (nothing here imports a Node module).
import { z } from "zod";
import { redactText } from "./redaction.js";

export const API_SAMPLE_SCHEMA_VERSION = "rovara-api-sample/v1" as const;
/** An API sample is at most this many bytes (the evidence artifact cap for `api_sample_json`). */
export const API_SAMPLE_MAX_BYTES = 16_384;
export const API_SAMPLE_MAX_DEPTH = 8;
export const API_SAMPLE_MAX_NODES = 300;
export const API_SAMPLE_MAX_KEYS = 40;
export const API_SAMPLE_MAX_SAFE_PATHS = 50;
const KEY_MAX = 60;
const SAFE_STRING_MAX = 200;
export const API_SAMPLE_CHANGED_PATHS_MAX = 50;

/** The headers a sample keeps. Everything else, `x-*` included, is dropped. */
export const API_SAMPLE_HEADER_ALLOW = ["content-type", "content-length", "cache-control", "x-request-id", "x-amzn-requestid"] as const;
const HEADER_VALUE = /^[\x20-\x7e]{1,128}$/u;

/** A JSON path on the "safe to show" list: dot-separated keys, `[]` for any array element (`items[].status`). */
export const SafeJsonPathSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+(?:\[\])?(?:\.[A-Za-z0-9_-]+(?:\[\])?)*$/u, "a JSON path of keys and []");
export const SafeJsonPathsSchema = z.array(SafeJsonPathSchema).max(API_SAMPLE_MAX_SAFE_PATHS);

/** The structure of a JSON value with its leaves replaced. A string is `<string n>`, so a reader sees a value was there and how long, never what. */
export type SampleNode = null | boolean | number | string | SampleNode[] | { [key: string]: SampleNode };
const SampleNodeSchema: z.ZodType<SampleNode> = z.lazy(() => z.union([z.null(), z.boolean(), z.number().finite(), z.string().max(SAFE_STRING_MAX + 20), z.array(SampleNodeSchema).max(API_SAMPLE_MAX_NODES), z.record(z.string().max(KEY_MAX + 10), SampleNodeSchema)]));

const BodySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), value: SampleNodeSchema, truncated: z.literal(true).optional() }).strict(),
  z.object({ kind: z.literal("non_json"), bytes: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("empty") }).strict(),
]);
const HeadersSchema = z.partialRecord(z.enum(API_SAMPLE_HEADER_ALLOW), z.string().regex(HEADER_VALUE));
export const ApiSampleSchema = z
  .object({
    schemaVersion: z.literal(API_SAMPLE_SCHEMA_VERSION),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).max(300).regex(/^\/[\x21-\x7e]*$/u).refine((path) => !path.includes("?") && !path.includes("#"), "a fixed path: no query and no fragment"),
    status: z.number().int().min(100).max(599),
    request: z.object({ headers: HeadersSchema, body: BodySchema }).strict(),
    response: z.object({ headers: HeadersSchema, body: BodySchema }).strict(),
  })
  .strict();
export type ApiSample = z.infer<typeof ApiSampleSchema>;

function pickHeaders(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (!(API_SAMPLE_HEADER_ALLOW as readonly string[]).includes(lower) || typeof value !== "string") continue;
    const clean = redactText(value).trim();
    if (HEADER_VALUE.test(clean) && !(lower in kept)) kept[lower] = clean;
  }
  return kept;
}

/** A key kept as it is only when it reads as a name; a token, an identifier or an address is replaced, so a map keyed by customer never leaks them. */
const NAME_KEY = /^[A-Za-z_][A-Za-z0-9_.:-]{0,59}$/u;
const TOKEN_KEY = /^(?:[A-Fa-f0-9]{16,}|[A-Za-z0-9+/_=-]{24,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;
function keyOf(key: string): string {
  return NAME_KEY.test(key) && !TOKEN_KEY.test(key) && redactText(key) === key ? key : `<key ${Math.min(key.length, 99_999)}>`;
}

function leaf(value: unknown, safe: boolean): SampleNode {
  if (value === null) return null;
  if (typeof value === "string") {
    if (safe && value.length <= SAFE_STRING_MAX) return redactText(value).slice(0, SAFE_STRING_MAX);
    return `<string ${Math.min(value.length, 99_999)}>`;
  }
  if (typeof value === "number") return safe && Number.isFinite(value) ? value : "<number>";
  if (typeof value === "boolean") return safe ? value : "<bool>";
  return "<value>";
}

/** The structure of `value`, bounded in depth, nodes and keys; `truncated` says a bound was reached. */
function structureOf(value: unknown, safePaths: ReadonlySet<string>): { node: SampleNode; truncated: boolean } {
  let nodes = 0;
  let truncated = false;
  const walk = (current: unknown, path: string, depth: number): SampleNode => {
    nodes += 1;
    if (nodes > API_SAMPLE_MAX_NODES || depth > API_SAMPLE_MAX_DEPTH) { truncated = true; return "<truncated>"; }
    if (Array.isArray(current)) {
      const out: SampleNode[] = [];
      for (const item of current) {
        if (nodes >= API_SAMPLE_MAX_NODES) { truncated = true; break; }
        out.push(walk(item, `${path}[]`, depth + 1));
      }
      return out;
    }
    if (typeof current === "object" && current !== null) {
      const out: { [key: string]: SampleNode } = {};
      let count = 0;
      for (const [rawKey, child] of Object.entries(current)) {
        if (count >= API_SAMPLE_MAX_KEYS) { truncated = true; break; }
        const key = keyOf(rawKey);
        if (key in out) continue;
        count += 1;
        out[key] = walk(child, path === "" ? rawKey : `${path}.${rawKey}`, depth + 1);
      }
      return out;
    }
    return leaf(current, safePaths.has(path));
  };
  return { node: walk(value, "", 0), truncated };
}

function bodyOf(bytes: Uint8Array | undefined, contentType: string | undefined, safePaths: ReadonlySet<string>): z.infer<typeof BodySchema> {
  if (bytes === undefined || bytes.byteLength === 0) return { kind: "empty" };
  if (contentType === undefined || !/^application\/(?:[a-z0-9.+-]+\+)?json\s*(?:;|$)/iu.test(contentType)) return { kind: "non_json", bytes: bytes.byteLength };
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const { node, truncated } = structureOf(parsed, safePaths);
    return { kind: "json", value: node, ...(truncated ? { truncated: true as const } : {}) };
  } catch {
    return { kind: "non_json", bytes: bytes.byteLength };
  }
}

export interface ApiSampleInput {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The approved fixed path (no query). */
  path: string;
  status: number;
  requestHeaders?: Readonly<Record<string, string>> | undefined;
  requestBody?: Uint8Array | undefined;
  responseHeaders?: Readonly<Record<string, string>> | undefined;
  responseBody?: Uint8Array | undefined;
  /** The scenario's approved "safe to show" JSON paths. Absent or empty: every value is a placeholder. */
  safePaths?: readonly string[] | undefined;
}

export interface ApiSampleBuilt {
  /** The sample as JSON bytes, at most `API_SAMPLE_MAX_BYTES`. Absent when it cannot be made to fit or is not valid. */
  bytes: Uint8Array | undefined;
  withheld?: "too_large" | "invalid";
}

/**
 * Builds the sample. A body that does not fit is cut to its first level before the sample is given up on; one that is still too big (or whose result is not a valid sample) is `withheld`, never half
 * written. The caller (the capture recorder) scans the bytes for the run's credentials in every spelling and drops the sample on a match.
 */
export function buildApiSample(input: ApiSampleInput): ApiSampleBuilt {
  const safe = new Set((SafeJsonPathsSchema.safeParse(input.safePaths ?? []).data ?? []));
  const make = (shallow: boolean): ApiSample => {
    const body = (bytes: Uint8Array | undefined, headers: Readonly<Record<string, string>> | undefined) => {
      const built = bodyOf(bytes, headers === undefined ? undefined : Object.entries(headers).find(([name]) => name.toLowerCase() === "content-type")?.[1], shallow ? new Set<string>() : safe);
      if (!shallow || built.kind !== "json" || built.value === null || typeof built.value !== "object") return built;
      const top = Array.isArray(built.value) ? built.value.slice(0, 1).map((): SampleNode => "<truncated>") : Object.fromEntries(Object.keys(built.value).slice(0, 10).map((key) => [key, "<truncated>"]));
      return { kind: "json" as const, value: top, truncated: true as const };
    };
    return {
      schemaVersion: API_SAMPLE_SCHEMA_VERSION, method: input.method, path: input.path, status: input.status,
      request: { headers: pickHeaders(input.requestHeaders), body: body(input.requestBody, input.requestHeaders) },
      response: { headers: pickHeaders(input.responseHeaders), body: body(input.responseBody, input.responseHeaders) },
    };
  };
  for (const shallow of [false, true]) {
    const sample = make(shallow);
    if (!ApiSampleSchema.safeParse(sample).success) return { bytes: undefined, withheld: "invalid" };
    const bytes = new TextEncoder().encode(JSON.stringify(sample));
    if (bytes.byteLength <= API_SAMPLE_MAX_BYTES) return { bytes };
  }
  return { bytes: undefined, withheld: "too_large" };
}

/** A stored sample read back: strictly the schema, or undefined. Never throws. */
export function parseApiSample(bytes: Uint8Array): ApiSample | undefined {
  try {
    if (bytes.byteLength === 0 || bytes.byteLength > API_SAMPLE_MAX_BYTES) return undefined;
    const parsed = ApiSampleSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ---- the structural diff

/** `<string 12>` and `<string 15>` are the same shape: the length of a hidden value is not structure. */
const normalized = (value: SampleNode): string => (typeof value === "string" ? value.replace(/^<(string|key) \d+>$/u, "<$1>") : JSON.stringify(value));

/** path -> the set of leaf shapes seen at it (array elements merge under `[]`). Allowed values are part of the shape, hidden ones are only their type. */
function flatten(node: SampleNode, path: string, into: Map<string, Set<string>>): void {
  if (Array.isArray(node)) {
    const at = `${path}[]`;
    if (!into.has(at)) into.set(at, new Set(["<array>"]));
    for (const item of node) flatten(item, at, into);
    return;
  }
  if (node !== null && typeof node === "object") {
    if (!into.has(path)) into.set(path, new Set(["<object>"]));
    for (const [key, child] of Object.entries(node)) flatten(child, path === "" ? key.replace(/^<key \d+>$/u, "<key>") : `${path}.${key.replace(/^<key \d+>$/u, "<key>")}`, into);
    return;
  }
  const shapes = into.get(path) ?? new Set<string>();
  shapes.add(normalized(node));
  into.set(path, shapes);
}

function shapesOf(sample: ApiSample): Map<string, string> {
  const flat = new Map<string, Set<string>>();
  flat.set("$status", new Set([String(sample.status)]));
  const contentType = sample.response.headers["content-type"];
  if (contentType !== undefined) flat.set("$content-type", new Set([contentType.split(";")[0]!.trim().toLowerCase()]));
  const body = sample.response.body;
  if (body.kind === "json") flatten(body.value, "$", flat);
  else flat.set("$body", new Set([body.kind]));
  return new Map([...flat.entries()].map(([path, shapes]) => [path, [...shapes].sort().join("|")]));
}

export interface ApiSampleDiff {
  diff: "none" | "changed" | "no_baseline";
  /** JSON paths whose shape (or allowed value) differs between the baseline and the candidate, sorted, at most `API_SAMPLE_CHANGED_PATHS_MAX`. Never a value. */
  changedPaths: string[];
}

/** Compares the candidate's sample to the baseline's. No baseline sample: `no_baseline`. */
export function diffApiSamples(baseline: ApiSample | undefined, candidate: ApiSample): ApiSampleDiff {
  if (baseline === undefined) return { diff: "no_baseline", changedPaths: [] };
  const before = shapesOf(baseline);
  const after = shapesOf(candidate);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).sort();
  return { diff: changed.length === 0 ? "none" : "changed", changedPaths: changed.slice(0, API_SAMPLE_CHANGED_PATHS_MAX) };
}
