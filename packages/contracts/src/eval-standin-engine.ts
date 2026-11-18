// Eval stand-ins, L4-E56 (owner decision DEC 254zzz55: never stop; D4 no customer secret for evals; setup-and-evals-final-review.md rows E5 and E6). The PURE half of the outside-HTTP stand-in an eval round runs against:
//
//   - the REQUEST KEY: one hash of a request (method, host, path, sorted query, body) that does not depend on the side, the time or the run, so the base side and the change side ask the same question the same way;
//   - the ANSWER BOOK: ONE per eval round, shared by both sides. A request that has an answer in it (a repository cassette, or one generated earlier in the round) gets those exact bytes back; a request with none is a GAP:
//     the stand-in makes a deterministic answer seeded by the request key, SHAPED from the contract finder (the OpenAPI fake, the answer types of an SDK, or the fields the caller reads), stores it in the book, and counts it;
//   - the COUNTS the result carries ("1 answer was generated: ..."), in fixed words and numbers only, and the gap rule: a question that failed in a run that hit a gap is "not compared" on both sides.
// Never stop: this module has no "cannot answer". The weakest answer is a minimal one built from the request itself. A host the plan never named is a "new connection": still answered, and counted as the weakest class.
// Rovara-made answers are labelled (`x-rovara-label: madeByRovara`) and NEVER count as change proof.
// Pure: no filesystem, network or clock; the only node import is the hash. The hosted helper imports this file through the narrow entry `eval-standin-helper-entry.ts`.
import { createHash } from "node:crypto";
import { OPENAPI_FAKE_LIMITS, answerOpenApiFake, reviveOpenApiFake, serializeOpenApiFake, type OpenApiFake, type SerializedOpenApiFake } from "./openapi-fake.js";
import type { ServiceMockJsonSchema } from "./service-mocks.js";

/** The classes of an answer. `recorded` is the repository's own (a cassette): not a gap. The other three are made up by the stand-in, weakest last. */
export const EVAL_STAND_IN_CLASSES = ["recorded", "generated", "generated_no_contract", "new_connection"] as const;
export type EvalStandInClass = (typeof EVAL_STAND_IN_CLASSES)[number];
/** The classes that make a request a GAP: Rovara had no stored answer and made one up. */
export const EVAL_STAND_IN_GAP_CLASSES: readonly EvalStandInClass[] = ["generated", "generated_no_contract", "new_connection"];
export const isEvalStandInGap = (cls: EvalStandInClass): boolean => cls !== "recorded";

export const EVAL_STAND_IN_LABEL_HEADER = "x-rovara-label";
export const EVAL_STAND_IN_LABEL = "madeByRovara";
export const EVAL_STAND_IN_CLASS_HEADER = "x-rovara-standin";
export const EVAL_STAND_IN_BODY_MAX_BYTES = 64 * 1024;
/** What one round's book holds: past it an answer is still made (the same way, so still identical on both sides) but not stored, and the counts say "saturated". */
export const EVAL_STAND_IN_BOOK_MAX_ENTRIES = 4_096;
export const EVAL_STAND_IN_BOOK_MAX_BYTES = 4 * 1024 * 1024;
/** What a round's repository recordings may weigh in all (they travel in the set file). */
export const EVAL_STAND_IN_RECORDED_MAX_BYTES = 3 * 1024 * 1024;
export const EVAL_STAND_IN_MAX_HOSTS = 32;
export const EVAL_STAND_IN_MAX_RECORDED = 2_000;
export const EVAL_STAND_IN_MAX_TYPE_ROUTES = 256;
export const EVAL_STAND_IN_MAX_READ_FIELDS = 128;
export const EVAL_STAND_IN_COUNT_MAX = 1_000_000;

const HOST_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62})(?:\.[a-z0-9](?:[a-z0-9-]{0,62}))*$/u;
export const isEvalStandInHostName = (host: string): boolean => host.length >= 1 && host.length <= 253 && HOST_NAME.test(host);
/**
 * A name the stand-in may STAND IN FOR (it goes in the box's host table): a plain name with at least one dot, and never `localhost` or a name under it, which would take the box's own loopback away from it. An outside vendor
 * has a dotted name; a one-word name is an internal service (the sealed DNS's job, lane E12), not an outside host.
 */
export const isEvalStandInPlanHost = (host: string): boolean => isEvalStandInHostName(host) && host.includes(".") && host !== "localhost" && !host.endsWith(".localhost") && !/^\d+(?:\.\d+){3}$/u.test(host);

// ---- the request key

/** What the stand-in reads of a request. `query` is the raw query string without `?`; `body` is the text (a body past the limit is hashed as its first bytes by the caller). */
export interface EvalStandInRequest {
  readonly method: string;
  readonly host: string | null;
  readonly path: string;
  readonly query: string;
  readonly contentType: string;
  readonly body: string;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const byteLength = (text: string): number => new TextEncoder().encode(text).length;
const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

/** The query as sorted `name=value` pairs: the order a client builds it in never makes a different question. */
export function sortedQueryPairs(query: string): string[] {
  if (query === "") return [];
  return query.split("&").filter((pair) => pair !== "").sort();
}

function canonicalBody(contentType: string, body: string): string {
  if (body === "") return "";
  if (/^application\/(?:[a-z0-9.+-]*\+)?json\b/iu.test(contentType)) {
    try { return JSON.stringify(sortValue(JSON.parse(body) as unknown)); } catch { return body; }
  }
  return body;
}
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue((value as Record<string, unknown>)[key])]));
  return value;
}

/** The key of a request: a hash that is the same on both sides of a comparison and on every re-ask. It holds no side, no time and no run id. */
export function evalStandInRequestKey(request: EvalStandInRequest): string {
  return sha(JSON.stringify([
    clip(request.method.toUpperCase(), 16), (request.host ?? "").toLowerCase(), clip(request.path, 1_024), sortedQueryPairs(request.query).slice(0, 64), sha(canonicalBody(request.contentType, request.body)),
  ]));
}

/** The looser key a repository cassette matches by: method, host, path and sorted query (a recording rarely keeps the body a test sent). */
export function evalStandInRecordedKey(input: { method: string; host: string; path: string; query: string }): string {
  return sha(JSON.stringify(["recorded", clip(input.method.toUpperCase(), 16), input.host.toLowerCase(), clip(input.path, 1_024), sortedQueryPairs(input.query).slice(0, 64)]));
}

// ---- answers and the book

export interface EvalStandInStoredAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly cls: EvalStandInClass;
}

export interface EvalStandInCounts {
  /** Answers the repository's own cassettes gave (not a gap). */
  readonly recorded: number;
  /** Distinct answers made up this round: the contract knew the operation / only the caller's fields or nothing did / the host was never named. */
  readonly generated: number;
  readonly generatedNoContract: number;
  readonly newConnections: number;
  /** Every call answered, repeats included. */
  readonly served: number;
  /** Calls answered with a made-up answer, repeats included: what a run "hit" of gaps. */
  readonly gapCalls: number;
  /** True when the book was full or a count reached its limit: every number is then a lower bound. */
  readonly saturated: boolean;
}
export const EMPTY_EVAL_STAND_IN_COUNTS: EvalStandInCounts = { recorded: 0, generated: 0, generatedNoContract: 0, newConnections: 0, served: 0, gapCalls: 0, saturated: false };

/** One entry of the book as it travels: the key, the answer and where it came from. */
export interface EvalStandInBookEntry extends EvalStandInStoredAnswer { readonly key: string }

/**
 * The round's one answer book. Both sides of a comparison, and every re-ask, ask THIS book (the worker keeps it between the sandbox runs and gives each helper its entries), and the first answer for a key is the only
 * answer for that key: a second `resolve` of the same key never calls `make` and returns the same bytes. Counts are exact up to EVAL_STAND_IN_COUNT_MAX.
 */
export class EvalAnswerBook {
  private readonly entries = new Map<string, EvalStandInStoredAnswer>();
  private readonly recordedIndex = new Map<string, EvalStandInStoredAnswer>();
  private bytes = 0;
  private recordedBytes = 0;
  private servedCalls = 0;
  private gapCallCount = 0;
  private saturated = false;
  private readonly distinct: Record<EvalStandInClass, number> = { recorded: 0, generated: 0, generated_no_contract: 0, new_connection: 0 };

  /** A repository cassette's answer, matched by method, host, path and query. Kept out of the count until a request uses it. First one wins. Refused (false) past the bounds. */
  preloadRecorded(input: { method: string; host: string; path: string; query: string; status: number; contentType: string; body: string }): boolean {
    if (this.recordedIndex.size >= EVAL_STAND_IN_MAX_RECORDED || !isEvalStandInHostName(input.host.toLowerCase()) || !validStatus(input.status) || byteLength(input.body) > EVAL_STAND_IN_BODY_MAX_BYTES) return false;
    const key = evalStandInRecordedKey(input);
    if (this.recordedIndex.has(key)) return true;
    const size = byteLength(input.body) + 128;
    if (this.recordedBytes + size > EVAL_STAND_IN_RECORDED_MAX_BYTES) return false;
    this.recordedBytes += size;
    this.recordedIndex.set(key, { status: input.status, contentType: input.contentType, body: input.body, cls: "recorded" });
    return true;
  }

  /** The recorded entries, for the set file the helper reads (the worker's own book is what holds them). */
  recordedEntries(): readonly (EvalStandInBookEntry)[] { return [...this.recordedIndex].map(([key, answer]) => ({ key, ...answer })); }

  /** An entry stored earlier in the round (by a previous helper). Never replaces one. */
  restore(entry: EvalStandInBookEntry): boolean {
    if (this.entries.has(entry.key)) return true;
    return this.store(entry.key, entry);
  }

  private store(key: string, answer: EvalStandInStoredAnswer): boolean {
    const size = byteLength(answer.body) + 128;
    if (this.entries.size >= EVAL_STAND_IN_BOOK_MAX_ENTRIES || this.bytes + size > EVAL_STAND_IN_BOOK_MAX_BYTES) { this.saturated = true; return false; }
    this.entries.set(key, answer);
    this.bytes += size;
    this.distinct[answer.cls] += 1;
    return true;
  }

  /**
   * The answer for a request: the stored one, else a recorded one, else the one `make` builds (stored and counted as a gap). `make` is called at most once per key. A key the book could not store (it is full) is answered by
   * `make` again each time; `make` is a pure function of the request, so the bytes are the same.
   */
  resolve(key: string, recordedKey: string | undefined, make: () => EvalStandInStoredAnswer): EvalStandInStoredAnswer {
    let answer = this.entries.get(key);
    if (answer === undefined && recordedKey !== undefined) {
      const recorded = this.recordedIndex.get(recordedKey);
      if (recorded !== undefined) { this.store(key, recorded); answer = recorded; }
    }
    if (answer === undefined) {
      answer = make();
      this.store(key, answer);
    }
    this.servedCalls = Math.min(EVAL_STAND_IN_COUNT_MAX, this.servedCalls + 1);
    if (isEvalStandInGap(answer.cls)) this.gapCallCount = Math.min(EVAL_STAND_IN_COUNT_MAX, this.gapCallCount + 1);
    if (this.servedCalls >= EVAL_STAND_IN_COUNT_MAX) this.saturated = true;
    return answer;
  }

  /** How many answers are stored. */
  size(): number { return this.entries.size; }

  /** What is stored, in a stable order, for the worker to keep between runs. Recorded cassette answers that were never asked are not included. */
  snapshot(): readonly EvalStandInBookEntry[] {
    return [...this.entries].map(([key, answer]) => ({ key, ...answer })).sort((a, b) => (a.key < b.key ? -1 : 1));
  }

  counts(): EvalStandInCounts {
    return {
      recorded: this.distinct.recorded, generated: this.distinct.generated, generatedNoContract: this.distinct.generated_no_contract, newConnections: this.distinct.new_connection,
      served: this.servedCalls, gapCalls: this.gapCallCount, saturated: this.saturated,
    };
  }

  /** A digest of what the book stores (keys and answers): a change in the stand-in set is a new version (the base cache keys on it; lane E4). */
  digest(): string {
    return sha(JSON.stringify(this.snapshot().map((entry) => [entry.key, entry.status, entry.contentType, sha(entry.body), entry.cls])));
  }

  /** Calls answered with a made-up answer since the book was made. A run's own gap calls are the difference of two readings. */
  gapCalls(): number { return this.gapCallCount; }
}

const validStatus = (status: number): boolean => Number.isInteger(status) && status >= 200 && status <= 599;

// ---- the plan: what the stand-in knows of each outside host

/** An answer type of an SDK or a contract: the operation (method and path template) and the schema of its answer. */
export interface EvalStandInTypeRoute { readonly method: string; readonly template: string; readonly schema: ServiceMockJsonSchema }
/** What the contract finder found for one host. Any mix; the first shape that can answer a request wins, in this order of strength: the OpenAPI description, the SDK types, the fields the caller reads. */
export interface EvalStandInHostPlan {
  readonly host: string;
  readonly openapi?: OpenApiFake | undefined;
  readonly types?: readonly EvalStandInTypeRoute[] | undefined;
  /** Field paths the caller reads in the answer: `data.user.display_name`, `items[].id`. The weakest shape. */
  readonly reads?: readonly string[] | undefined;
}
export type EvalStandInPlan = readonly EvalStandInHostPlan[];

/** The storable form of one host's plan. */
export interface SerializedEvalStandInHostPlan {
  host: string;
  openapi?: SerializedOpenApiFake;
  types?: { method: string; template: string; schema: ServiceMockJsonSchema }[];
  reads?: string[];
}

export function serializeEvalStandInPlan(plan: EvalStandInPlan): SerializedEvalStandInHostPlan[] | undefined {
  if (plan.length > EVAL_STAND_IN_MAX_HOSTS || new Set(plan.map((entry) => entry.host)).size !== plan.length) return undefined;
  const out: SerializedEvalStandInHostPlan[] = [];
  for (const entry of plan) {
    if (!isEvalStandInPlanHost(entry.host)) return undefined;
    const serialized: SerializedEvalStandInHostPlan = { host: entry.host };
    if (entry.openapi !== undefined) {
      const fake = serializeOpenApiFake(entry.openapi);
      if (fake === undefined) return undefined;
      serialized.openapi = fake;
    }
    if (entry.types !== undefined) {
      if (entry.types.length > EVAL_STAND_IN_MAX_TYPE_ROUTES) return undefined;
      serialized.types = entry.types.map((route) => ({ method: route.method, template: route.template, schema: route.schema }));
    }
    if (entry.reads !== undefined) {
      if (entry.reads.length > EVAL_STAND_IN_MAX_READ_FIELDS) return undefined;
      serialized.reads = [...entry.reads];
    }
    out.push(serialized);
  }
  return out;
}

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\[\])?(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}(?:\[\])?){0,7}$/u;
const TEMPLATE = /^\/[A-Za-z0-9._~%{}:@!$&'()*+,;=/-]{0,1023}$/u;
const METHODS = new Set(["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The plan of a serialized form, or undefined: checked again (it came from a file). A bad entry refuses the whole plan. */
export function reviveEvalStandInPlan(value: unknown): EvalStandInPlan | undefined {
  if (!Array.isArray(value) || value.length > EVAL_STAND_IN_MAX_HOSTS) return undefined;
  const out: EvalStandInHostPlan[] = [];
  const seen = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!object(entry) || typeof entry.host !== "string" || !isEvalStandInPlanHost(entry.host) || seen.has(entry.host)) return undefined;
    seen.add(entry.host);
    const unknown = Object.keys(entry).filter((key) => !["host", "openapi", "types", "reads"].includes(key));
    if (unknown.length > 0) return undefined;
    let openapi: OpenApiFake | undefined;
    if (entry.openapi !== undefined) {
      openapi = reviveOpenApiFake(entry.openapi);
      if (openapi === undefined) return undefined;
    }
    let types: EvalStandInTypeRoute[] | undefined;
    if (entry.types !== undefined) {
      if (!Array.isArray(entry.types) || entry.types.length > EVAL_STAND_IN_MAX_TYPE_ROUTES) return undefined;
      types = [];
      for (const route of entry.types as unknown[]) {
        if (!object(route) || typeof route.method !== "string" || !METHODS.has(route.method) || typeof route.template !== "string" || !TEMPLATE.test(route.template) || !validSchema(route.schema)) return undefined;
        types.push({ method: route.method, template: route.template, schema: route.schema });
      }
    }
    let reads: string[] | undefined;
    if (entry.reads !== undefined) {
      if (!Array.isArray(entry.reads) || entry.reads.length > EVAL_STAND_IN_MAX_READ_FIELDS || !entry.reads.every((field) => typeof field === "string" && FIELD_PATH.test(field))) return undefined;
      reads = [...(entry.reads as string[])];
    }
    out.push({ host: entry.host, ...(openapi === undefined ? {} : { openapi }), ...(types === undefined ? {} : { types }), ...(reads === undefined ? {} : { reads }) });
  }
  return out;
}

const SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
function validSchema(value: unknown, depth = 1, budget = { nodes: 0 }): value is ServiceMockJsonSchema {
  if (!object(value) || depth > 16 || ++budget.nodes > 512 || typeof value.type !== "string" || !SCHEMA_TYPES.has(value.type)) return false;
  if (value.properties !== undefined) {
    if (!object(value.properties) || Object.keys(value.properties).length > 128) return false;
    for (const child of Object.values(value.properties)) if (!validSchema(child, depth + 1, budget)) return false;
  }
  if (value.items !== undefined && !validSchema(value.items, depth + 1, budget)) return false;
  return true;
}

// ---- the seeded generator (mulberry32 over the key's first 28 bits: the same key always gives the same values)

interface Generator { int(min: number, max: number): number; pick<T>(values: readonly T[]): T; id(prefix: string): string; uuid(): string }
function generatorFor(key: string): Generator {
  let state = parseInt(key.slice(0, 7), 16) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (Math.max(min, max) - min + 1));
  const hex = (length: number): string => Array.from({ length }, () => int(0, 15).toString(16)).join("");
  return {
    int,
    pick: (values) => values[int(0, values.length - 1)]!,
    id: (prefix) => `${prefix}-${hex(8)}`,
    uuid: () => `${hex(8)}-${hex(4)}-4${hex(3)}-${["8", "9", "a", "b"][int(0, 3)]!}${hex(3)}-${hex(12)}`,
  };
}

function synthesize(schema: ServiceMockJsonSchema, generator: Generator, depth = 1): unknown {
  if (depth > 12) return null;
  if (schema.enum !== undefined && schema.enum.length > 0) return generator.pick(schema.enum);
  switch (schema.type) {
    case "null": return null;
    case "boolean": return generator.int(0, 1) === 1;
    case "integer": {
      const low = Math.ceil(schema.minimum ?? 0);
      const high = Math.floor(schema.maximum ?? low + 1_000);
      return generator.int(low, Math.max(low, Math.min(high, low + 1_000)));
    }
    case "number": {
      const low = schema.minimum ?? 0;
      const high = Math.max(low, Math.min(schema.maximum ?? low + 1, low + 1));
      return low + (high - low) * (generator.int(0, 1_000) / 1_000);
    }
    case "string": {
      let text = schema.format === "date-time" ? "2026-01-01T00:00:00.000Z" : schema.format === "date" ? "2026-01-01" : schema.format === "uuid" ? generator.uuid() : schema.format === "email" ? `${generator.id("user")}@example.test` : generator.id("synthetic");
      if (schema.minLength !== undefined && text.length < schema.minLength) text = text.padEnd(Math.min(schema.minLength, 4_096), "x");
      if (schema.maxLength !== undefined && text.length > schema.maxLength) text = text.slice(0, schema.maxLength);
      return text;
    }
    case "array": {
      const count = Math.min(Math.min(schema.maxItems ?? 1_000, 16), Math.max(schema.minItems ?? 0, schema.items === undefined ? 0 : 1));
      return Array.from({ length: count }, () => (schema.items === undefined ? null : synthesize(schema.items, generator, depth + 1)));
    }
    case "object": {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(schema.properties ?? {})) result[key] = synthesize(child, generator, depth + 1);
      for (const key of schema.required ?? []) if (!(key in result)) result[key] = null;
      return result;
    }
  }
}

/** A value for a field the caller reads, by what its name says: a count is a number, `is_`/`has_` a flag, a time a date, a link a link, anything else a short word. */
function valueForField(name: string, generator: Generator): unknown {
  const lower = name.toLowerCase();
  if (/^(?:is|has|can|should)_|^(?:is|has|can|should)[A-Z]|(?:^|_)(?:enabled|active|verified|private|deleted)$/u.test(name)) return generator.int(0, 1) === 1;
  if (/(?:^|_)(?:count|total|num|number|size|length|followers|following|likes|views|shares|comments|score|amount|quantity|limit|offset|page|age)$|count$/u.test(lower) || /^(?:count|total|size|limit|offset|page)$/u.test(lower)) return generator.int(0, 1_000);
  if (/(?:^|_)(?:at|date|time|timestamp)$|(?:At|Date|Time)$/u.test(name)) return "2026-01-01T00:00:00.000Z";
  if (/(?:^|_)(?:url|uri|link|href|image|avatar|thumbnail)$|(?:Url|Uri|Link)$/u.test(name)) return `https://example.test/${generator.id("item")}`;
  if (/(?:^|_)email$/u.test(lower)) return `${generator.id("user")}@example.test`;
  if (lower === "id" || /(?:^|_)id$/u.test(lower) || /Id$/u.test(name)) return generator.id("id");
  if (/(?:^|_)(?:name|title|username|handle|display_name)$|Name$/u.test(name) || lower === "name") return generator.id("sample");
  return generator.id("synthetic");
}

/** An object that has every field path the caller reads: `a.b` nests, `a[]` is an array of one. */
function bodyFromReads(reads: readonly string[], generator: Generator): unknown {
  const root: Record<string, unknown> = {};
  for (const path of reads) {
    const parts = path.split(".");
    let cursor: Record<string, unknown> = root;
    parts.forEach((part, index) => {
      const array = part.endsWith("[]");
      const name = array ? part.slice(0, -2) : part;
      const last = index === parts.length - 1;
      if (last) {
        const value = valueForField(name, generator);
        if (cursor[name] === undefined) cursor[name] = array ? [value] : value;
        return;
      }
      const existing = cursor[name];
      let child: Record<string, unknown>;
      if (array) {
        if (!Array.isArray(existing)) cursor[name] = [{}];
        child = ((cursor[name] as unknown[])[0] ?? {}) as Record<string, unknown>;
        (cursor[name] as unknown[])[0] = child;
      } else {
        child = object(existing) ? existing : {};
        cursor[name] = child;
      }
      cursor = child;
    });
  }
  return root;
}

const templateMatcher = (template: string): RegExp => new RegExp(`^${template.split("/").map((segment) => (/\{[^}]+\}/u.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))).join("/")}$`, "u");

const toAnswer = (status: number, body: unknown, cls: EvalStandInClass): EvalStandInStoredAnswer => {
  if (body === undefined || status === 204) return { status, contentType: "application/json", body: "", cls };
  const text = JSON.stringify(body);
  return { status, contentType: "application/json", body: byteLength(text) > EVAL_STAND_IN_BODY_MAX_BYTES ? "{}" : text, cls };
};

/**
 * The made-up answer for a request that has none: from the contract when the host's plan can answer the operation (class `generated`), else from the fields the caller reads or the weakest minimal answer built from the request
 * (`generated_no_contract`), and for a host the plan never named the minimal answer (`new_connection`). A pure function of the key, the plan and the request: the same on both sides. Never "cannot answer".
 */
export function generateEvalStandInAnswer(plan: EvalStandInPlan, request: EvalStandInRequest, key: string): EvalStandInStoredAnswer {
  const host = (request.host ?? "").toLowerCase();
  const entry = plan.find((candidate) => candidate.host === host);
  const generator = generatorFor(key);
  const method = request.method.toUpperCase();
  if (entry !== undefined) {
    if (entry.openapi !== undefined) {
      const served = answerOpenApiFake(entry.openapi, method, request.path);
      if (served.kind === "served") return toAnswer(served.status, served.body, "generated");
    }
    for (const route of entry.types ?? []) {
      if (route.method === method && templateMatcher(route.template).test(request.path.split(/[?#]/u)[0]!)) return toAnswer(200, synthesize(route.schema, generator), "generated");
    }
    if (entry.reads !== undefined && entry.reads.length > 0) return toAnswer(200, bodyFromReads(entry.reads, generator), "generated_no_contract");
  }
  const minimal = { ok: true, id: generator.id("id"), request: { method: clip(method, 16), path: clip(request.path.split(/[?#]/u)[0]!, 256) } };
  return toAnswer(method === "POST" ? 201 : 200, minimal, entry === undefined ? "new_connection" : "generated_no_contract");
}

/** One call: the book's answer for a request (made and stored when it has none). The status of a HEAD answer keeps its headers; the caller drops the body. */
export function answerEvalStandInRequest(book: EvalAnswerBook, plan: EvalStandInPlan, request: EvalStandInRequest): EvalStandInStoredAnswer {
  const key = evalStandInRequestKey(request);
  const host = (request.host ?? "").toLowerCase();
  const recordedKey = host === "" ? undefined : evalStandInRecordedKey({ method: request.method, host, path: request.path.split(/[?#]/u)[0]!, query: request.query });
  return book.resolve(key, recordedKey, () => generateEvalStandInAnswer(plan, request, key));
}

// ---- the gap rule

/**
 * Which questions are "not compared". `runs` are the sandbox runs of the round in order (each: the side, its questions, and whether the run hit any gap). A question is gap-affected when the LATEST run that asked it on
 * a side hit a gap: a later run of fewer questions (the re-ask) clears a question the big first run could not tell apart. A gap-affected question is dropped from BOTH sides only when it failed somewhere (the caller says
 * which questions failed in any sample): a gap in Rovara's stand-in is never the customer's regression, and a gap that did not change an outcome costs nothing. Pure.
 */
export function evalStandInNotCompared(runs: readonly { readonly side: "old" | "new"; readonly ids: readonly string[]; readonly hitGap: boolean }[], failed: ReadonlySet<string>): Set<string> {
  const latest = new Map<string, { old?: boolean; new?: boolean }>();
  for (const run of runs) for (const id of run.ids) { const state = latest.get(id) ?? {}; state[run.side] = run.hitGap; latest.set(id, state); }
  const out = new Set<string>();
  for (const [id, state] of latest) if ((state.old === true || state.new === true) && failed.has(id)) out.add(id);
  return out;
}

// ---- limits for tests and refusals
export const EVAL_STAND_IN_LIMITS = { hosts: EVAL_STAND_IN_MAX_HOSTS, recorded: EVAL_STAND_IN_MAX_RECORDED, book: EVAL_STAND_IN_BOOK_MAX_ENTRIES, operations: OPENAPI_FAKE_LIMITS.operations } as const;
