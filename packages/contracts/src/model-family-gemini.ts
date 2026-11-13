// TE-F0a: the Gemini family shapes (AI Studio and Vertex): the request router, the response builders, and the GCE metadata server route table Vertex's Application Default Credentials need. PURE: no `node:http`, no socket, no
// clock, no randomness (an id comes from a passed-in seed). Every fact is from designs-2026-10-30/gemini-redirect-check-2026-11-13.md; what that note calls UNVERIFIED is marked UNVERIFIED here.
//
// HELPER PLACEMENT (DECISIONS 158), stated here because this is the code the helper will call: the helper is one small loopback process per check round, beside the customer's tests, reached by a base-URL environment
// variable or one configuration line the readiness run proposes. It does not need `tx` test services, so dev-container projects are covered. It is NOT `packages/worker/src/fake-helper.ts` (the sealed test-services fake;
// do not edit it) and it does not run inside the sealed round until `tx` is on. Until the sealed round exists the evidence says "not sealed" (O44). No process is built in this file: TE-F2 wires a thin HTTP loop around
// `serveModelRequest` (model-serve.ts), and the metadata server around `serveMetadataRequest` below.
import { openAiOperationOfTail, type OpenAiOperation } from "./model-family-openai.js";
import { MODEL_NAME_PATTERN, assertReplyBounds, chunkText, lowerHeaders, parseQuery, replyUsage, seededId, sseBody, type HeaderBag, type ModelFinish, type ModelReply, type SseLineEnding } from "./model-family-common.js";

export const GEMINI_OPERATIONS = ["generateContent", "streamGenerateContent", "countTokens", "embedContent", "batchEmbedContents"] as const;
export type GeminiOperation = (typeof GEMINI_OPERATIONS)[number];
export const GEMINI_MODES = ["ai_studio", "vertex_express", "vertex_project", "openai_compatible"] as const;
export type GeminiMode = (typeof GEMINI_MODES)[number];
export const GEMINI_ROUTE_REFUSALS = ["method_not_allowed", "bad_path", "unsupported_path", "unsupported_operation", "bad_model", "bad_query", "too_large"] as const;
export type GeminiRouteRefusal = (typeof GEMINI_ROUTE_REFUSALS)[number];
export type GeminiStreamKind = "none" | "sse" | "json_array";
export type GeminiCredential = "x-goog-api-key" | "authorization" | "query_key" | "none";

/**
 * Whether the integer form of the enums (`enum-encoding=int`, sent by the legacy REST clients) is proven. It is NOT: the redirect check used the string form "STOP" and the legacy client parsed it. The integer form is
 * built (the proto numbering below) and tested as built, never as verified.
 */
export const GEMINI_INT_ENCODING_VERIFIED = false;

export interface GeminiRouteRequest {
  readonly method: string;
  /** The path without the query string. */
  readonly path: string;
  /** The raw query string, with or without a leading `?`. */
  readonly query: string;
  readonly headers: HeaderBag;
}
export interface GeminiRoute {
  readonly ok: true;
  readonly operation: GeminiOperation | OpenAiOperation;
  /** The model in the path; undefined for the OpenAI-compatible forms (the model is in the body). */
  readonly model: string | undefined;
  readonly mode: GeminiMode;
  readonly apiVersion: string;
  readonly project: string | undefined;
  readonly location: string | undefined;
  /** What a `streamGenerateContent` call wants back: SSE for `alt=sse`, otherwise the JSON array the legacy REST clients parse. "none" for every other operation. */
  readonly stream: GeminiStreamKind;
  readonly enumEncoding: "string" | "int";
  /** Which credential the client sent (never its value): the helper drops all of them. */
  readonly credential: GeminiCredential;
}
export type GeminiRouteResult = GeminiRoute | { readonly ok: false; readonly reason: GeminiRouteRefusal };

const PATH_MAX = 512;
/** Any API version prefix: v1, v1beta, v1alpha, v1beta1, v2, ... */
const VERSION = /^v\d{1,3}(?:[a-z]{1,8}\d{0,3})?$/u;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const LOCATION = /^[a-z0-9-]{1,40}$/u;
const PATH_CHARS = /^[A-Za-z0-9._~:/-]+$/u;
const refuse = (reason: GeminiRouteRefusal): GeminiRouteResult => ({ ok: false, reason });

function credentialOf(headers: HeaderBag, query: Map<string, string>): GeminiCredential {
  const lowered = lowerHeaders(headers);
  if (lowered.has("x-goog-api-key")) return "x-goog-api-key";
  if (/^bearer\s/iu.test(lowered.get("authorization") ?? "")) return "authorization";
  return query.has("key") ? "query_key" : "none";
}

/**
 * The operation, model, mode, API version and stream kind of a Gemini request, from every path form of the redirect check (AI Studio, Vertex express, Vertex project and location, the OpenAI-compatible forms).
 * Any API version prefix is accepted. Refuses with a fixed reason: a method other than POST, a path with an encoded character, a `..`, an empty segment or a character outside a plain path, an unknown route or
 * operation, a bad model, a bad query. Never throws, never keeps a credential's value, looks at lengths before it looks at content.
 */
export function routeGeminiRequest(request: GeminiRouteRequest): GeminiRouteResult {
  const path = request.path;
  if (typeof path !== "string" || path.length > PATH_MAX) return refuse("too_large");
  const query = parseQuery(typeof request.query === "string" ? request.query : "");
  if (query === undefined) return refuse("bad_query");
  if (path === "/") return refuse("unsupported_path");
  if (!path.startsWith("/") || !PATH_CHARS.test(path)) return refuse("bad_path");
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return refuse("bad_path");
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "";
  const [version, first] = segments as [string, string | undefined];
  if (!VERSION.test(version) || first === undefined) return refuse("unsupported_path");
  const credential = credentialOf(request.headers, query);
  // `alt=sse` (the new clients) and `$alt=json;enum-encoding=int` (the legacy REST clients, plain or percent-encoded) are read alike; the sse format wins.
  const alts = [query.get("alt"), query.get("$alt")].filter((value): value is string => value !== undefined).map((value) => value.split(";"));
  const wantsSse = alts.some((parts) => parts[0] === "sse");
  const enumEncoding = alts.some((parts) => parts.includes("enum-encoding=int")) ? "int" : "string";
  const base = { apiVersion: version, enumEncoding, credential } as const;

  const native = (modelSegment: string | undefined, mode: GeminiMode, project: string | undefined, location: string | undefined): GeminiRouteResult => {
    if (modelSegment === undefined) return refuse("unsupported_path");
    const colon = modelSegment.lastIndexOf(":");
    const operation = colon < 0 ? "" : modelSegment.slice(colon + 1);
    const model = colon < 0 ? modelSegment : modelSegment.slice(0, colon);
    if (!MODEL_NAME_PATTERN.test(model)) return refuse("bad_model");
    if (!(GEMINI_OPERATIONS as readonly string[]).includes(operation)) return refuse("unsupported_operation");
    if (method !== "POST") return refuse("method_not_allowed");
    const stream: GeminiStreamKind = operation !== "streamGenerateContent" ? "none" : wantsSse ? "sse" : "json_array";
    return { ok: true, operation: operation as GeminiOperation, model, mode, project, location, stream, ...base };
  };
  const openai = (tail: string, project: string | undefined, location: string | undefined): GeminiRouteResult => {
    const operation = openAiOperationOfTail(tail);
    if (operation === undefined) return refuse("unsupported_path");
    if (method !== (operation === "models" ? "GET" : "POST")) return refuse("method_not_allowed");
    return { ok: true, operation, model: undefined, mode: "openai_compatible", project, location, stream: "none", ...base };
  };

  if (first === "models" && segments.length === 3) return native(segments[2], "ai_studio", undefined, undefined);
  if (first === "publishers" && segments[2] === "google" && segments[3] === "models" && segments.length === 5) return native(segments[4], "vertex_express", undefined, undefined);
  if (first === "openai") return openai(segments.slice(2).join("/"), undefined, undefined);
  if (first === "projects") {
    const [, , project, locations, location, kind, ...rest] = segments;
    if (project === undefined || location === undefined || locations !== "locations" || !PROJECT.test(project) || !LOCATION.test(location)) return refuse("bad_path");
    if (kind === "publishers" && rest[0] === "google" && rest[1] === "models" && rest.length === 3) return native(rest[2], "vertex_project", project, location);
    if (kind === "endpoints" && rest[0] === "openapi") return openai(rest.slice(1).join("/"), project, location);
  }
  return refuse("unsupported_path");
}

// ---- response builders

/** The integer form of finishReason (the proto enum numbering). UNVERIFIED against a client; see GEMINI_INT_ENCODING_VERIFIED. */
const FINISH_NAME: Record<ModelFinish, string> = { stop: "STOP", length: "MAX_TOKENS", safety: "SAFETY", tool_calls: "STOP", other: "OTHER" };
const FINISH_INT: Record<ModelFinish, number> = { stop: 1, length: 2, safety: 3, tool_calls: 1, other: 5 };

export interface GeminiBuildOptions {
  readonly model: string;
  /** Ids come from this seed, never a clock or a random source. */
  readonly seed: string;
  readonly enumEncoding?: "string" | "int";
  /** The size of a streamed text piece, in characters. */
  readonly chunkChars?: number;
}
export type GeminiGenerateContentResponse = Record<string, unknown>;

const finishReasonOf = (finish: ModelFinish, encoding: "string" | "int" | undefined): string | number => (encoding === "int" ? FINISH_INT[finish] : FINISH_NAME[finish]);
const usageMetadata = (reply: ModelReply) => {
  const usage = replyUsage(reply);
  return { promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens, totalTokenCount: usage.inputTokens + usage.outputTokens };
};
const callParts = (reply: ModelReply) => (reply.toolCalls ?? []).map((call) => ({ functionCall: { name: call.name, args: call.args } }));

/** One `GenerateContentResponse`: a candidate with the reply's text and tool calls, its finish reason, usage metadata, the model version and a seeded response id. */
export function buildGeminiGenerateContent(reply: ModelReply, options: GeminiBuildOptions): GeminiGenerateContentResponse {
  assertReplyBounds(reply, options.model);
  const parts = [...(reply.text.length > 0 ? [{ text: reply.text }] : []), ...callParts(reply)];
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: finishReasonOf(reply.finish, options.enumEncoding), index: 0 }],
    usageMetadata: usageMetadata(reply),
    modelVersion: options.model,
    responseId: seededId(`${options.seed}:${options.model}`),
  };
}

/** The chunks of a streamed answer: each a full `GenerateContentResponse` holding a piece of the text; the last holds the tool calls, the finish reason and the usage. Never more than 20,000 of them. */
export function buildGeminiStreamChunks(reply: ModelReply, options: GeminiBuildOptions): GeminiGenerateContentResponse[] {
  assertReplyBounds(reply, options.model);
  const pieces = chunkText(reply.text, options.chunkChars ?? 32);
  const responseId = seededId(`${options.seed}:${options.model}`);
  const chunks: GeminiGenerateContentResponse[] = (pieces.length === 0 ? [""] : pieces).map((piece, index, all) => {
    const last = index === all.length - 1;
    const parts = [...(piece.length > 0 ? [{ text: piece }] : []), ...(last ? callParts(reply) : [])];
    const candidate: Record<string, unknown> = { content: { role: "model", parts }, index: 0 };
    if (last) candidate.finishReason = finishReasonOf(reply.finish, options.enumEncoding);
    return { candidates: [candidate], ...(last ? { usageMetadata: usageMetadata(reply) } : {}), modelVersion: options.model, responseId };
  });
  return chunks;
}

/** An SSE body: `data: <json>` and a blank line per chunk. No `[DONE]` for Gemini. Python needs `data: ` with the space. */
export function geminiSseBody(chunks: readonly GeminiGenerateContentResponse[], lineEnding: SseLineEnding): string {
  return sseBody(chunks.map((chunk) => JSON.stringify(chunk)), lineEnding);
}

/** The JSON array the legacy REST clients (google-generativeai, vertexai) parse: `[{...},\n{...}]`. */
export function geminiJsonArrayBody(chunks: readonly GeminiGenerateContentResponse[]): string {
  return `[${chunks.map((chunk) => JSON.stringify(chunk)).join(",\n")}]`;
}

// ---- the GCE metadata server (Vertex Application Default Credentials)

export const GCE_METADATA_HOST_VARIABLE = "GCE_METADATA_HOST";
/** Python's google-auth needs this one too (JS needs only the host variable): UNVERIFIED for clients other than the ones the redirect check ran. */
export const GCE_METADATA_IP_VARIABLE = "GCE_METADATA_IP";
/** The token the emulation hands out: a fixed placeholder built at run time. The real token exists only in the egress function. */
export const GCE_DUMMY_TOKEN = ["rovara", "dummy", "token"].join("-");
export const GCE_PLACEHOLDER_EMAIL = "rovara-helper@rovara-test.iam.gserviceaccount.invalid";
const GCE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"];

export const GCE_METADATA_ROUTES = [
  { route: "ping", path: "/", note: "Python's reachability ping" },
  { route: "instance", path: "/computeMetadata/v1/instance", note: "directory listing" },
  { route: "project_id", path: "/computeMetadata/v1/project/project-id", note: "the connected project id, not secret" },
  { route: "service_account", path: "/computeMetadata/v1/instance/service-accounts/default/", note: "with ?recursive=true: JSON email, aliases, scopes" },
  { route: "service_account_token", path: "/computeMetadata/v1/instance/service-accounts/default/token", note: "?scopes=...: JSON access_token, expires_in, token_type" },
] as const;
export type GceMetadataRoute = (typeof GCE_METADATA_ROUTES)[number]["route"];

export type MetadataRouteResult = { ok: true; route: GceMetadataRoute } | { ok: false; status: 403 | 404 | 405 };

/** Which metadata route a request is. The real server refuses a request without `Metadata-Flavor: Google` (403), a method other than GET (405) and anything it does not have (404). */
export function routeMetadataRequest(request: GeminiRouteRequest): MetadataRouteResult {
  if (lowerHeaders(request.headers).get("metadata-flavor") !== "Google") return { ok: false, status: 403 };
  if (typeof request.method !== "string" || request.method.toUpperCase() !== "GET") return { ok: false, status: 405 };
  if (typeof request.path !== "string" || request.path.length > 200) return { ok: false, status: 404 };
  const plain = (path: string): string => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);
  const found = GCE_METADATA_ROUTES.find((entry) => plain(entry.path) === plain(request.path));
  return found === undefined ? { ok: false, status: 404 } : { ok: true, route: found.route };
}

export interface MetadataResponse {
  readonly status: number;
  /** Lowercase names. `metadata-flavor: Google` is on every answer, refusals included. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
const metadataAnswer = (status: number, body: string, contentType: string): MetadataResponse => ({ status, headers: { "metadata-flavor": "Google", "content-type": contentType }, body });

/** The answer of the emulated metadata server. `projectId` is the connected project's id (plain, not secret); a malformed one is a 500, not a made-up answer. */
export function serveMetadataRequest(request: GeminiRouteRequest, options: { readonly projectId: string }): MetadataResponse {
  const routed = routeMetadataRequest(request);
  if (!routed.ok) return metadataAnswer(routed.status, "", "text/plain");
  switch (routed.route) {
    case "ping":
      return metadataAnswer(200, "computeMetadata/\n", "application/text");
    case "instance":
      return metadataAnswer(200, "service-accounts/\n", "application/text");
    case "project_id":
      return PROJECT.test(options.projectId) ? metadataAnswer(200, options.projectId, "text/plain") : metadataAnswer(500, "", "text/plain");
    case "service_account": {
      const recursive = parseQuery(request.query)?.get("recursive") === "true";
      return recursive ? metadataAnswer(200, JSON.stringify({ email: GCE_PLACEHOLDER_EMAIL, aliases: ["default"], scopes: GCE_SCOPES }), "application/json") : metadataAnswer(200, "aliases\nemail\nidentity\nscopes\ntoken\n", "application/text");
    }
    case "service_account_token":
      return metadataAnswer(200, JSON.stringify({ access_token: GCE_DUMMY_TOKEN, expires_in: 3600, token_type: "Bearer" }), "application/json");
  }
}
