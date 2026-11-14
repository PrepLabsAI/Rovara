// Service mocks (design proof-test-env, section 4.6): the shapes of a recorded fixture set, the schema inferred from it, what a mock does with a request it has no recording for, and what a
// mock reports back so the evidence names every mocked service honestly. The mock server itself is the verifier's (`verifier/src/service-mocks/*`); this module is what it, the recorder, the
// broker and the evidence all read the same way. Nothing here imports a Node module.
//
// What it guarantees:
//   - a fixture is addressed by the hash of its canonical request, so the same request always finds the same recording and a re-ordered JSON body is the same request;
//   - every list, body and schema is bounded (a recorded body is at most 64 KiB, a set holds at most 500 entries, a schema at most 32 levels deep and 2,048 nodes);
//   - an unmatched request is `fail` unless the maintainer chose `schema_synth`, and either way it is counted (`ServiceMockUsageSchema`), so "mock answered 3 unrecorded requests" is always true;
//   - a fixture that holds personal data or names production is refused by the data guard before it is stored (that check is the verifier's; its report shape is in test-environment.ts).
//
// Test services TS3 (design test-services.md, 7.1): `FixtureSetSchema` (schemaVersion 2) is the one fixture format for tasks, Prove, nightly and the end-to-end checker. It replaces
// `ServiceMockFixtureSetSchema` (v1) and the E2E checker's `E2EApiMockFixture` once those are wired to it; both convert to it (`fixtureSetFromV1`, and `e2eApiMockFixtureToFixtureSet` in e2e-node.ts). The v1
// schema and its hash stay as they are for now, so every stored v1 set still reads. Differences that matter:
//   - an entry keeps its method, path and the query values that identify it, and the hash covers them (v1 hashed a target string only);
//   - `match.ignorePaths` lists JSON pointers (timestamps, request ids) that are taken out of a JSON body before it is hashed, so a recorded answer still matches when only those differ;
//   - `match.query` names the query parameters that identify a request; no other parameter does;
//   - a response keeps only headers from a closed allow-list (never a redirect or a cookie), a set is at most 2,000 entries and 4 MiB, and `syntheticOnly` is still literally true.
import { z } from "zod";
import { canonicalJson } from "./canonical-json.js";
import { FamilyIdSchema, TestEnvDependencyIdSchema, awsServiceOfHost, testEnvDependencyIdFromName } from "./test-env-dependency.js";
import { TEST_ENV_SERVICE_KINDS, TEST_ENV_UNMATCHED } from "./test-environment.js";
import { sha256Hex } from "./web-hash.js";

const NO_HIDDEN = /^[^\p{Cc}\p{Cf}]*$/u;
function line(max: number, min = 1) {
  return z.string().min(min).max(max).regex(NO_HIDDEN, "one plain line");
}
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const SERVICE_MOCK_ENTRIES_MAX = 500;
export const SERVICE_MOCK_BODY_MAX_BYTES = 65_536;
export const SERVICE_MOCK_FAULTS_MAX = 20;
export const SERVICE_MOCK_SCHEMA_MAX_DEPTH = 32;
export const SERVICE_MOCK_SCHEMA_MAX_NODES = 2_048;
export const SERVICE_MOCK_LATENCY_MAX_MS = 30_000;

/** What an unmatched request is answered with when the mode is `fail`: a 500 and these words, so the case fails as "mock had no recording". */
export const SERVICE_MOCK_UNMATCHED_STATUS = 500;
export const SERVICE_MOCK_NO_RECORDING_MESSAGE = "mock had no recording";

/** A JSON schema as the recorder infers it: the small subset the OpenAPI fixtures already use (`E2EFixtureSchema`), bounded in depth and size. */
export interface ServiceMockJsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, ServiceMockJsonSchema> | undefined;
  required?: string[] | undefined;
  items?: ServiceMockJsonSchema | undefined;
  enum?: Array<string | number | boolean> | undefined;
  format?: "date" | "date-time" | "email" | "uuid" | undefined;
  minimum?: number | undefined;
  maximum?: number | undefined;
  minLength?: number | undefined;
  maxLength?: number | undefined;
  minItems?: number | undefined;
  maxItems?: number | undefined;
  additionalProperties?: false | undefined;
}

const JsonSchemaNodeSchema: z.ZodType<ServiceMockJsonSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(["object", "array", "string", "number", "integer", "boolean", "null"]),
      properties: z.record(z.string().max(128), JsonSchemaNodeSchema).optional(),
      required: z.array(z.string().max(128)).max(256).optional(),
      items: JsonSchemaNodeSchema.optional(),
      enum: z.array(z.union([z.string().max(256), z.number(), z.boolean()])).max(64).optional(),
      format: z.enum(["date", "date-time", "email", "uuid"]).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).optional(),
      additionalProperties: z.literal(false).optional(),
    })
    .strict(),
);

function schemaBudget(schema: ServiceMockJsonSchema, depth: number, counter: { nodes: number }): boolean {
  counter.nodes += 1;
  if (depth > SERVICE_MOCK_SCHEMA_MAX_DEPTH || counter.nodes > SERVICE_MOCK_SCHEMA_MAX_NODES) return false;
  for (const child of [...Object.values(schema.properties ?? {}), ...(schema.items === undefined ? [] : [schema.items])]) {
    if (!schemaBudget(child, depth + 1, counter)) return false;
  }
  return true;
}

export const ServiceMockJsonSchemaSchema: z.ZodType<ServiceMockJsonSchema> = JsonSchemaNodeSchema.refine((schema) => schemaBudget(schema, 1, { nodes: 0 }), "a schema is at most 32 levels deep and 2,048 nodes");

const BodySchema = z.string().max(SERVICE_MOCK_BODY_MAX_BYTES).refine((text) => new TextEncoder().encode(text).length <= SERVICE_MOCK_BODY_MAX_BYTES, "a recorded body is at most 64 KiB");

/** A fault a scenario may ask for by name: a timeout, a 5xx or a throttle. Without one, a claim like "a timeout falls back" is shown as not tested. */
export const SERVICE_MOCK_FAULT_KINDS = ["timeout", "http_5xx", "throttle"] as const;
export const ServiceMockFaultSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u),
    kind: z.enum(SERVICE_MOCK_FAULT_KINDS),
    /** The status a `http_5xx` or `throttle` fault answers with. */
    status: z.number().int().min(400).max(599).optional(),
    delayMs: z.number().int().min(0).max(SERVICE_MOCK_LATENCY_MAX_MS),
  })
  .strict()
  .refine((fault) => (fault.kind === "timeout") === (fault.status === undefined), { message: "a timeout has no status and the other faults have one", path: ["status"] });
export type ServiceMockFault = z.infer<typeof ServiceMockFaultSchema>;

export const ServiceMockEntrySchema = z
  .object({
    /** `serviceMockRequestHash` of the request. */
    requestHash: Sha256Schema,
    request: z.object({ contentType: line(100), body: BodySchema }).strict(),
    response: z.object({ status: z.number().int().min(100).max(599), contentType: line(100), body: BodySchema, latencyMs: z.number().int().min(0).max(SERVICE_MOCK_LATENCY_MAX_MS) }).strict(),
  })
  .strict();
export type ServiceMockEntry = z.infer<typeof ServiceMockEntrySchema>;

/** One recorded fixture set: what a maintainer approves (by digest) and the mock serves. */
export const ServiceMockFixtureSetSchema = z
  .object({
    schemaVersion: z.literal(1),
    service: z.object({ name: line(80), kind: z.enum(TEST_ENV_SERVICE_KINDS), target: line(253) }).strict(),
    revision: z.number().int().min(1),
    recordedAt: z.string().datetime(),
    /** Recorded from the project's synthetic inputs only; the data guard has scanned the entries. */
    syntheticOnly: z.literal(true),
    requestSchema: ServiceMockJsonSchemaSchema.nullable(),
    responseSchema: ServiceMockJsonSchemaSchema.nullable(),
    entries: z.array(ServiceMockEntrySchema).max(SERVICE_MOCK_ENTRIES_MAX),
    faults: z.array(ServiceMockFaultSchema).max(SERVICE_MOCK_FAULTS_MAX),
  })
  .strict()
  .superRefine((set, context) => {
    if (new Set(set.entries.map((entry) => entry.requestHash)).size !== set.entries.length) context.addIssue({ code: "custom", path: ["entries"], message: "a request has one recording" });
    if (new Set(set.faults.map((fault) => fault.name)).size !== set.faults.length) context.addIssue({ code: "custom", path: ["faults"], message: "fault names are unique" });
  });
export type ServiceMockFixtureSet = z.infer<typeof ServiceMockFixtureSetSchema>;

/** The digest a fixture set is pinned by in the approved environment (`mock.fixtureSetRef`). */
export function serviceMockFixtureSetDigest(set: ServiceMockFixtureSet): string {
  return sha256Hex(canonicalJson(ServiceMockFixtureSetSchema.parse(set)));
}

export const ServiceMockUnmatchedSchema = z.enum(TEST_ENV_UNMATCHED);

/**
 * What a mock server reports for a round, per service. The broker puts it in the evidence ("mock answered 3 unrecorded requests") and a service with unrecorded answers is never shown as
 * plainly "mocked": a `fail` mock that was asked something unrecorded has failed the case that asked.
 */
export const ServiceMockUsageSchema = z
  .object({
    service: line(80),
    matched: z.number().int().min(0).max(10_000_000),
    unmatchedFailed: z.number().int().min(0).max(10_000_000),
    synthesized: z.number().int().min(0).max(10_000_000),
    faultsInjected: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u), count: z.number().int().min(1).max(10_000_000) }).strict()).max(SERVICE_MOCK_FAULTS_MAX),
  })
  .strict();
export type ServiceMockUsage = z.infer<typeof ServiceMockUsageSchema>;

/**
 * The key a request is looked up by. A JSON body is canonicalised first (keys in a fixed order, so `{"a":1,"b":2}` and `{"b":2,"a":1}` are one request); any other body is hashed as written. The service, target,
 * method and content type are part of the key, so the same bytes sent to another endpoint find nothing.
 */
export function serviceMockRequestHash(input: { service: (typeof TEST_ENV_SERVICE_KINDS)[number]; target: string; method: string; contentType: string; body: string }): string {
  const type = input.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  let body = input.body;
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      body = canonicalJson(JSON.parse(input.body) as unknown);
    } catch {
      // Not valid JSON: it is hashed as written, so it can only match a recording of the same bytes.
    }
  }
  return sha256Hex(canonicalJson({ service: input.service, target: input.target, method: input.method.toUpperCase(), contentType: type, body }));
}

/**
 * The environment variable an AWS SDK reads to send one service's calls to another address (`AWS_ENDPOINT_URL_<SERVICE>`): the service's id uppercased, spaces as underscores. The SageMaker Runtime
 * mock is reached through `AWS_ENDPOINT_URL_SAGEMAKER_RUNTIME`, so the customer's code needs no change (unless it passes `endpoint_url` itself, which takes precedence).
 */
export function awsEndpointUrlVariable(serviceId: string): string {
  if (!/^[A-Za-z][A-Za-z0-9 ]{0,63}$/u.test(serviceId)) throw new RangeError("a service id is letters, digits and spaces");
  return `AWS_ENDPOINT_URL_${serviceId.toUpperCase().replace(/ /gu, "_")}`;
}


// ---- FixtureSet v2 (test services TS3, design 7.1)

export const FIXTURE_SET_SCHEMA_VERSION = 2;
export const FIXTURE_SET_ENTRIES_MAX = 2_000;
export const FIXTURE_SET_MAX_BYTES = 4 * 1024 * 1024;
export const FIXTURE_IGNORE_PATHS_MAX = 20;
export const FIXTURE_MATCH_QUERY_MAX = 8;
export const FIXTURE_RESPONSE_HEADERS_MAX = 8;
export const FIXTURE_PROTOCOLS = ["http_json", "http_any", "aws_json", "aws_query", "model_invoke"] as const;
export const FIXTURE_ORIGINS = ["recorded", "written", "imported"] as const;
export const FIXTURE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** The only response headers a fixture keeps. No redirect, cookie or credential header is on it, so a recorded answer cannot send the app somewhere else or plant state. */
export const FIXTURE_RESPONSE_HEADER_NAMES = ["cache-control", "content-language", "etag", "expires", "last-modified", "retry-after", "x-amz-request-id", "x-amzn-errortype", "x-amzn-requestid", "x-request-id"] as const;

/** An RFC 6901 JSON pointer into a request body. The empty pointer (the whole body) is not one, and neither is any pointer with an empty part (`/`, `//`, `/a/`): ignoring everything, or a member with no name, would make requests the same that are not. */
export const JsonPointerSchema = z.string().min(1).max(200).regex(/^(?:\/(?:[^~/]|~[01])+)+$/u, "a JSON pointer with no empty part");
const QueryNameSchema = z.string().regex(/^[A-Za-z0-9_.~-]{1,64}$/u).refine((name) => name !== "__proto__", "a plain name");
const FixturePathSchema = z
  .string()
  .regex(/^\/[A-Za-z0-9._~%:@!$&'()*+,;=/-]{0,511}$/u)
  .refine((path) => !path.includes("//") && !path.split("/").includes(".."), "a canonical path");

const FixtureRequestSchema = z
  .object({
    method: z.enum(FIXTURE_METHODS),
    path: FixturePathSchema,
    /** The identifying query values, as name and value, one name once. */
    query: z.array(z.object({ name: QueryNameSchema, value: z.string().max(256) }).strict()).max(FIXTURE_MATCH_QUERY_MAX).optional(),
    contentType: line(100, 0),
    body: BodySchema,
  })
  .strict();

const FixtureResponseSchema = z
  .object({
    status: z.number().int().min(100).max(599),
    headers: z.array(z.object({ name: z.enum(FIXTURE_RESPONSE_HEADER_NAMES), value: line(256) }).strict()).max(FIXTURE_RESPONSE_HEADERS_MAX),
    contentType: line(100),
    body: BodySchema,
    latencyMs: z.number().int().min(0).max(SERVICE_MOCK_LATENCY_MAX_MS),
  })
  .strict()
  .refine((response) => new Set(response.headers.map((header) => header.name)).size === response.headers.length, { message: "a header is listed once", path: ["headers"] });

export const FixtureEntrySchema = z.object({ requestHash: Sha256Schema, request: FixtureRequestSchema, response: FixtureResponseSchema }).strict();
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export const FixtureSetSchema = z
  .object({
    schemaVersion: z.literal(FIXTURE_SET_SCHEMA_VERSION),
    dependency: z.object({ id: TestEnvDependencyIdSchema, family: FamilyIdSchema, protocol: z.enum(FIXTURE_PROTOCOLS), target: line(253) }).strict(),
    origin: z.enum(FIXTURE_ORIGINS),
    revision: z.number().int().min(1),
    recordedAt: z.string().datetime().optional(),
    writtenBy: line(80).optional(),
    /** Recorded or written from synthetic inputs only; the data guard has scanned the entries. */
    syntheticOnly: z.literal(true),
    requestSchema: ServiceMockJsonSchemaSchema.optional(),
    responseSchema: ServiceMockJsonSchemaSchema.optional(),
    match: z.object({ ignorePaths: z.array(JsonPointerSchema).max(FIXTURE_IGNORE_PATHS_MAX), query: z.array(QueryNameSchema).max(FIXTURE_MATCH_QUERY_MAX).optional() }).strict(),
    entries: z.array(FixtureEntrySchema).max(FIXTURE_SET_ENTRIES_MAX),
    faults: z.array(ServiceMockFaultSchema).max(SERVICE_MOCK_FAULTS_MAX),
  })
  .strict()
  .superRefine((set, context) => {
    const problem = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
    if ((set.origin === "recorded") !== (set.recordedAt !== undefined)) problem(["recordedAt"], "a recorded set says when, and no other set does");
    if (set.writtenBy !== undefined && set.origin !== "written") problem(["writtenBy"], "only a written set says who wrote it");
    if (new Set(set.match.ignorePaths).size !== set.match.ignorePaths.length) problem(["match", "ignorePaths"], "a path is listed once");
    if (new Set(set.match.query ?? []).size !== (set.match.query ?? []).length) problem(["match", "query"], "a parameter is listed once");
    if (set.match.ignorePaths.length > 0 && set.dependency.protocol === "aws_query") problem(["match", "ignorePaths"], "a form-encoded body has no JSON pointers");
    if (new Set(set.entries.map((entry) => entry.requestHash)).size !== set.entries.length) problem(["entries"], "a request has one recording");
    if (new Set(set.faults.map((fault) => fault.name)).size !== set.faults.length) problem(["faults"], "fault names are unique");
    const identifying = new Set(set.match.query ?? []);
    set.entries.forEach((entry, index) => {
      const names = (entry.request.query ?? []).map((pair) => pair.name);
      if (new Set(names).size !== names.length) problem(["entries", index, "request", "query"], "a parameter is listed once");
      if (names.some((name) => !identifying.has(name))) problem(["entries", index, "request", "query"], "only the parameters the set matches on are kept");
      if (set.dependency.protocol === "model_invoke" && (entry.request.method !== "POST" || entry.request.path !== `/endpoints/${set.dependency.target}/invocations`)) problem(["entries", index, "request"], "a model endpoint is invoked with POST /endpoints/<name>/invocations");
    });
    if (set.dependency.protocol === "model_invoke" && (set.dependency.family !== "aws:sagemaker-runtime" || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/u.test(set.dependency.target))) problem(["dependency"], "a model endpoint set is for SageMaker Runtime, named by its endpoint");
    // The dependency's target is the host its family names: a set for one host cannot be served for another.
    if (set.dependency.protocol !== "model_invoke") {
      if (set.dependency.family.startsWith("http:") && set.dependency.target !== set.dependency.family.slice(5)) problem(["dependency", "target"], "the target is the host of the family");
      if (set.dependency.family.startsWith("aws:") && `aws:${awsServiceOfHost(set.dependency.target) ?? ""}` !== set.dependency.family) problem(["dependency", "target"], "the target is an endpoint of the family's service");
    }
    // ignorePaths must not make recorded requests the same when they are not: none may take out every member of a recorded JSON body.
    if (set.match.ignorePaths.length > 0) {
      set.entries.forEach((entry, index) => {
        if (jsonBodyEmptiedBy(entry.request.contentType, entry.request.body, set.match.ignorePaths)) problem(["entries", index, "request", "body"], "the ignored paths take out every member of a recorded body");
      });
    }
    // A stored entry is trusted only under its own hash: a request that hashes to something else would be served for the wrong request, or never.
    set.entries.forEach((entry, index) => {
      if (entry.requestHash !== fixtureRequestHash(set, entry.request)) problem(["entries", index, "requestHash"], "an entry's hash is the hash of its own request");
    });
    if (new TextEncoder().encode(JSON.stringify(set)).length > FIXTURE_SET_MAX_BYTES) problem([], "a fixture set is at most 4 MiB");
  });
export type FixtureSet = z.infer<typeof FixtureSetSchema>;

/** The digest a v2 fixture set is pinned by (`fixtureSetRef`): the canonical JSON of the parsed set. */
export function fixtureSetDigest(set: FixtureSet): string {
  return sha256Hex(canonicalJson(FixtureSetSchema.parse(set)));
}

/** Takes the pointed-at members out of a parsed JSON value, in place: an object member is deleted, an array element becomes null (so the others keep their places). A pointer that leads nowhere does nothing. */
function withoutPointers(value: unknown, pointers: readonly string[]): unknown {
  for (const pointer of pointers) {
    if (pointer === "" || !pointer.startsWith("/")) continue;
    const tokens = pointer.slice(1).split("/").map((token) => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
    let node: unknown = value;
    for (const token of tokens.slice(0, -1)) {
      if (Array.isArray(node)) node = /^(?:0|[1-9]\d*)$/u.test(token) ? (node as unknown[])[Number(token)] : undefined;
      else if (node !== null && typeof node === "object" && Object.hasOwn(node, token)) node = (node as Record<string, unknown>)[token];
      else node = undefined;
      if (node === undefined) break;
    }
    const last = tokens[tokens.length - 1] ?? "";
    if (Array.isArray(node)) {
      if (/^(?:0|[1-9]\d*)$/u.test(last) && Number(last) < node.length) (node as unknown[])[Number(last)] = null;
    } else if (node !== null && typeof node === "object" && Object.hasOwn(node, last)) {
      delete (node as Record<string, unknown>)[last];
    }
  }
  return value;
}

/** Whether removing the pointed-at members leaves a recorded JSON body with nothing in it (every member of an object gone, or every element of an array null) although it had something. */
function jsonBodyEmptiedBy(contentType: string, body: string, pointers: readonly string[]): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(type === "application/json" || type.endsWith("+json"))) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const had = Array.isArray(parsed) ? parsed.some((member) => member !== null) : parsed !== null && typeof parsed === "object" && Object.keys(parsed).length > 0;
  if (!had) return false;
  const left = withoutPointers(parsed, pointers);
  return Array.isArray(left) ? left.every((member) => member === null) : left !== null && typeof left === "object" && Object.keys(left).length === 0;
}

export interface FixtureRequestParts {
  method: string;
  path: string;
  /** Every query pair of the request; only those the set matches on count. */
  query?: ReadonlyArray<{ name: string; value: string }> | undefined;
  contentType: string;
  body: string;
}

/**
 * The key a request is looked up by in a v2 set. Canonical JSON bodies as in v1 (a re-ordered body is the same request), plus the dependency's family and target, the method, the path and the
 * identifying query values, minus the body members `match.ignorePaths` names. A body that is not JSON is hashed as written, and ignorePaths never apply to it. The version is part of the key, so a v1
 * hash and a v2 hash never meet.
 */
export function fixtureRequestHash(set: Pick<FixtureSet, "dependency" | "match">, request: FixtureRequestParts): string {
  const type = request.contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  let body = request.body;
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      body = canonicalJson(withoutPointers(JSON.parse(request.body) as unknown, set.match.ignorePaths));
    } catch {
      // Not valid JSON: hashed as written, so it can only match a recording of the same bytes.
    }
  }
  const identifying = new Set(set.match.query ?? []);
  const query = (request.query ?? []).filter((pair) => identifying.has(pair.name)).map((pair) => [pair.name, pair.value] as const).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1));
  return sha256Hex(canonicalJson({ v: 2, family: set.dependency.family, target: set.dependency.target, method: request.method.toUpperCase(), path: request.path, query, contentType: type, body }));
}

/** The positions of the entries whose `requestHash` is not the hash of their own request. A set read from storage is trusted only when this is empty; the schema does not hash 2,000 bodies on every parse. */
export function fixtureSetHashProblems(set: FixtureSet): number[] {
  return set.entries.flatMap((entry, index) => (entry.requestHash === fixtureRequestHash(set, entry.request) ? [] : [index]));
}

/** A request the set does not already hold, completed with its hash: the entry a recorder or a writer adds. */
export function fixtureEntry(set: Pick<FixtureSet, "dependency" | "match">, request: FixtureEntry["request"], response: FixtureEntry["response"]): FixtureEntry {
  return { requestHash: fixtureRequestHash(set, request), request, response };
}

// ---- converters to v2

/** Services whose requests are JSON documents addressed by a target header, and services whose requests are form-encoded queries. SQS and S3 are in neither: SQS speaks both, S3 is REST. */
const AWS_JSON_SERVICES: ReadonlySet<string> = new Set(["dynamodb", "kinesis", "events", "secretsmanager", "ssm", "kms", "states"]);
const AWS_QUERY_SERVICES: ReadonlySet<string> = new Set(["sns", "sts"]);

export type FixtureConversion = { ok: true; set: FixtureSet } | { ok: false; reason: "invalid" | "request_line_unknown" | "unreadable_host" | "protocol_unknown" };

/**
 * A v1 set as a v2 one (an AWS service whose wire protocol is not known is `protocol_unknown`, not guessed). A SageMaker Runtime set is `POST /endpoints/<target>/invocations`, so every entry is rebuilt exactly and rehashed. Any other v1 entry kept only a hash, never its method or path, so
 * the caller must say what each request was (`resolveRequest`); an entry it cannot place stops the conversion (`request_line_unknown`). Nothing is guessed. The result is a recorded set with the v1 date and revision.
 */
export function fixtureSetFromV1(
  v1: ServiceMockFixtureSet,
  options: { resolveRequest?: (entry: ServiceMockEntry) => { method: (typeof FIXTURE_METHODS)[number]; path: string; query?: Array<{ name: string; value: string }> } | undefined } = {},
): FixtureConversion {
  const parsed = ServiceMockFixtureSetSchema.safeParse(v1);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  const old = parsed.data;
  let family: string;
  let protocol: (typeof FIXTURE_PROTOCOLS)[number];
  if (old.service.kind === "sagemaker_runtime") {
    family = "aws:sagemaker-runtime";
    protocol = "model_invoke";
  } else if (old.service.kind === "http") {
    family = `http:${old.service.target}`;
    protocol = "http_json";
  } else {
    const service = awsServiceOfHost(old.service.target);
    if (service === undefined) return { ok: false, reason: "unreadable_host" };
    family = `aws:${service}`;
    // The wire protocol is a fact about the service: JSON (a target header) or query (form-encoded). A service in neither list (S3 is REST with XML, SQS has both) is refused, never guessed.
    const known = AWS_JSON_SERVICES.has(service) ? "aws_json" : AWS_QUERY_SERVICES.has(service) ? "aws_query" : undefined;
    if (known === undefined) return { ok: false, reason: "protocol_unknown" };
    protocol = known;
  }
  const skeleton = { dependency: { id: testEnvDependencyIdFromName(old.service.name), family, protocol, target: old.service.target }, match: { ignorePaths: [] as string[] } };
  const entries: FixtureEntry[] = [];
  const queryNames = new Set<string>();
  for (const entry of old.entries) {
    const placed =
      old.service.kind === "sagemaker_runtime"
        ? { method: "POST" as const, path: `/endpoints/${old.service.target}/invocations`, query: undefined }
        : options.resolveRequest?.(entry);
    if (placed === undefined) return { ok: false, reason: "request_line_unknown" };
    for (const pair of placed.query ?? []) queryNames.add(pair.name);
    entries.push({
      requestHash: "",
      request: { method: placed.method, path: placed.path, ...(placed.query === undefined ? {} : { query: placed.query }), contentType: entry.request.contentType, body: entry.request.body },
      response: { status: entry.response.status, headers: [], contentType: entry.response.contentType, body: entry.response.body, latencyMs: entry.response.latencyMs },
    });
  }
  const match = { ignorePaths: [] as string[], ...(queryNames.size === 0 ? {} : { query: [...queryNames].sort() }) };
  const built = {
    schemaVersion: 2,
    dependency: skeleton.dependency,
    origin: "recorded",
    revision: old.revision,
    recordedAt: old.recordedAt,
    syntheticOnly: true,
    ...(old.requestSchema === null ? {} : { requestSchema: old.requestSchema }),
    ...(old.responseSchema === null ? {} : { responseSchema: old.responseSchema }),
    match,
    entries: entries.map((entry) => ({ ...entry, requestHash: fixtureRequestHash({ dependency: skeleton.dependency, match }, entry.request) })),
    faults: old.faults,
  };
  const result = FixtureSetSchema.safeParse(built);
  return result.success ? { ok: true, set: result.data } : { ok: false, reason: "invalid" };
}
