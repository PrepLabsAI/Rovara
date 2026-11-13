// TE-F0a: the ONE entry the helper calls, `serveModelRequest(rows, request, options) -> response`, and nothing else of the helper: no process, no socket, no clock, no network. TE-F2 wires a thin HTTP loop around it
// (DECISIONS 158: one small loopback process per check round, beside the customer's tests; reached by a base-URL variable or one configuration line; not `packages/worker/src/fake-helper.ts`; not sealed until `tx` is on,
// so the evidence says "not sealed", O44). Pure: the answer depends only on the arguments.
//
// The helper's address carries the row: `http://rovara-models:8080/p/<rowId>/<the API's own path>` (te-f1-model-proxy-design 2.3). The row decides the family; the family's router decides the operation. A Bedrock row is
// never served here (it routes to the local AWS front, which 9d owns). The scripted reply comes from TE-F2 (`options.reply`); without one the answer is a fixed "no script" error, never a made-up reply. Credentials a
// client sent are noted by kind only and never copied into an answer.
import type { ModelCatalogRow } from "./model-catalog.js";
import { MODEL_REQUEST_BODY_MAX_BYTES, type HeaderBag, type ModelReply } from "./model-family-common.js";
import { buildGeminiGenerateContent, buildGeminiStreamChunks, geminiJsonArrayBody, geminiSseBody, routeGeminiRequest, type GeminiCredential, type GeminiMode } from "./model-family-gemini.js";
import { buildChatCompletion, buildChatCompletionStream, echoableModelName, routeOpenAiCompatibleRequest } from "./model-family-openai.js";

/** What a row must have to be served: a catalog row and a company gateway row both fit. */
export interface ServableRow {
  readonly id: string;
  readonly family: ModelCatalogRow["family"];
  readonly pathPrefix?: string | undefined;
  readonly routesTo?: ModelCatalogRow["routesTo"];
}

export interface ModelHelperRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: HeaderBag;
  readonly body?: string | Uint8Array | undefined;
}
export interface ServeOptions {
  /** The scripted reply to render (TE-F2 picks it). Undefined: the answer is "no script". */
  readonly reply: ModelReply | undefined;
  /** Ids in the answer come from this seed. */
  readonly seed: string;
  readonly lineEnding?: "lf" | "crlf";
  /** The `created` time written into an OpenAI-compatible answer; this code has no clock. */
  readonly created?: number;
}
export interface ServedInfo {
  readonly rowId: string;
  readonly family: ModelCatalogRow["family"];
  readonly operation: string;
  readonly mode: GeminiMode | "openai_compatible";
  readonly credential: GeminiCredential;
}
export interface ModelHelperResponse {
  readonly status: number;
  /** Lowercase names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** What was served, for the evidence ledger; undefined when the request did not reach an operation. */
  readonly served: ServedInfo | undefined;
}

export const SERVE_ERROR_WORDS = {
  unknown_row: "no model row for this address",
  bad_request: "this request is not one the model helper serves",
  body_too_large: "the request body is too large",
  no_script: "no scripted reply was set for this call",
  family_not_built: "this API shape is not served by the model helper yet",
  operation_not_built: "this operation is not served by the model helper yet",
  routes_to_local_aws_front: "this row is served by the local AWS front, not by the model helper",
  route_not_for_row: "this path does not belong to this row",
  internal_error: "the model helper could not build this answer",
} as const;
export type ServeErrorCode = keyof typeof SERVE_ERROR_WORDS;

const JSON_TYPE = "application/json";
const failure = (status: number, code: ServeErrorCode, served: ServedInfo | undefined = undefined): ModelHelperResponse => ({
  status,
  headers: { "content-type": JSON_TYPE },
  body: JSON.stringify({ error: { code, message: SERVE_ERROR_WORDS[code] } }),
  served,
});
const ok = (body: string, contentType: string, served: ServedInfo): ModelHelperResponse => ({ status: 200, headers: { "content-type": contentType }, body, served });

const ROW_PATH = /^\/p\/([a-z][a-z0-9-]{0,39})(\/.*)?$/u;
const bodyText = (body: ModelHelperRequest["body"]): string => (body === undefined ? "" : typeof body === "string" ? body : new TextDecoder().decode(body));
const bodyBytes = (body: ModelHelperRequest["body"]): number => (body === undefined ? 0 : typeof body === "string" ? new TextEncoder().encode(body.length > MODEL_REQUEST_BODY_MAX_BYTES + 4 ? body.slice(0, MODEL_REQUEST_BODY_MAX_BYTES + 4) : body).length : body.byteLength);

function requestedModel(text: string): { model: string; stream: boolean } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return { model: "unknown-model", stream: false };
    const own = (key: string): unknown => (Object.hasOwn(parsed, key) ? (parsed as Record<string, unknown>)[key] : undefined);
    return { model: echoableModelName(own("model")), stream: own("stream") === true };
  } catch {
    return { model: "unknown-model", stream: false };
  }
}

/** The Gemini modes each Gemini-family row serves. */
const MODES_OF_FAMILY: Record<string, readonly GeminiMode[]> = { gemini: ["ai_studio", "openai_compatible"], vertex: ["vertex_express", "vertex_project", "openai_compatible"] };

/**
 * One request, one answer. Finds the row by the `/p/<rowId>` prefix, then routes by the row's family: Gemini and Vertex by `routeGeminiRequest`, the OpenAI-compatible family by `routeOpenAiCompatibleRequest`;
 * Anthropic and Cohere are TE-F2's, Bedrock is the local AWS front's. The body is checked for size first (1 MiB). Never throws: a fixed error answer (404, 405, 413, 421, 501, or 500 `internal_error`) comes back instead.
 */
export function serveModelRequest(rows: readonly ServableRow[], request: ModelHelperRequest, options: ServeOptions): ModelHelperResponse {
  try {
    return serveUnchecked(rows, request, options);
  } catch {
    // A scripted reply out of bounds (a RangeError), a BigInt or a cycle in a tool call (a TypeError), a hostile request object: one fixed answer, never a throw and never the error's text.
    return failure(500, "internal_error");
  }
}

function serveUnchecked(rows: readonly ServableRow[], request: ModelHelperRequest, options: ServeOptions): ModelHelperResponse {
  if (bodyBytes(request.body) > MODEL_REQUEST_BODY_MAX_BYTES) return failure(413, "body_too_large");
  const matched = typeof request.path === "string" && request.path.length <= 600 ? ROW_PATH.exec(request.path) : null;
  const row = matched === null ? undefined : rows.find((candidate) => candidate.id === matched[1]);
  if (matched === null || row === undefined) return failure(404, "unknown_row");
  if (row.routesTo === "local_aws_front" || row.family === "bedrock") return failure(421, "routes_to_local_aws_front");
  const rest = matched[2] ?? "/";
  const lineEnding = options.lineEnding ?? "lf";
  const created = options.created ?? 1_700_000_000;

  if (row.family === "gemini" || row.family === "vertex") {
    const route = routeGeminiRequest({ method: request.method, path: rest, query: request.query, headers: request.headers });
    if (!route.ok) return failure(route.reason === "method_not_allowed" ? 405 : 404, "bad_request");
    if (!(MODES_OF_FAMILY[row.family] ?? []).includes(route.mode)) return failure(404, "route_not_for_row");
    const served: ServedInfo = { rowId: row.id, family: row.family, operation: route.operation, mode: route.mode, credential: route.credential };
    if (options.reply === undefined) return failure(501, "no_script", served);
    if (route.mode === "openai_compatible") return serveOpenAi(route.operation, request, options, served, created, lineEnding);
    const model = route.model ?? "unknown-model";
    const build = { model, seed: options.seed, enumEncoding: route.enumEncoding } as const;
    switch (route.operation) {
      case "generateContent":
        return ok(JSON.stringify(buildGeminiGenerateContent(options.reply, build)), JSON_TYPE, served);
      case "streamGenerateContent": {
        const chunks = buildGeminiStreamChunks(options.reply, build);
        return route.stream === "sse" ? ok(geminiSseBody(chunks, lineEnding), "text/event-stream", served) : ok(geminiJsonArrayBody(chunks), JSON_TYPE, served);
      }
      case "countTokens":
        return ok(JSON.stringify({ totalTokens: Math.ceil(bodyBytes(request.body) / 4) }), JSON_TYPE, served);
      default:
        return failure(501, "operation_not_built", served);
    }
  }
  if (row.family === "openai_compatible") {
    const route = routeOpenAiCompatibleRequest({ method: request.method, path: rest, pathPrefix: row.pathPrefix });
    if (!route.ok) return failure(route.reason === "method_not_allowed" ? 405 : 404, "bad_request");
    const served: ServedInfo = { rowId: row.id, family: row.family, operation: route.operation, mode: "openai_compatible", credential: credentialKind(request.headers) };
    if (options.reply === undefined) return failure(501, "no_script", served);
    return serveOpenAi(route.operation, request, options, served, created, lineEnding);
  }
  return failure(501, "family_not_built");
}

function credentialKind(headers: HeaderBag): GeminiCredential {
  const names = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
  return names.has("x-goog-api-key") ? "x-goog-api-key" : names.has("authorization") ? "authorization" : "none";
}

function serveOpenAi(operation: string, request: ModelHelperRequest, options: ServeOptions, served: ServedInfo, created: number, lineEnding: "lf" | "crlf"): ModelHelperResponse {
  if (operation !== "chat_completions" || options.reply === undefined) return failure(501, "operation_not_built", served);
  const { model, stream } = requestedModel(bodyText(request.body));
  const build = { model, seed: options.seed, created } as const;
  return stream ? ok(buildChatCompletionStream(options.reply, build, lineEnding), "text/event-stream", served) : ok(JSON.stringify(buildChatCompletion(options.reply, build)), JSON_TYPE, served);
}
