// TE-F2 part A (M2, release 0.5.19): the registry of the families the scripted-replies helper serves: for each, `route` (which operation a request is), `scripted` (the bytes of a scripted answer) and `failure` (the failure
// pack's answer). Five families: `openai_compatible`, `anthropic_messages`, `gemini`, `vertex` (Gemini's shapes), `cohere`. Bedrock is not here (`model-served-family.ts`).
//
// F0a's `serveModelRequest(rows, request, {reply, seed})` stays the way a Gemini or Vertex answer and an OpenAI-compatible chat completion are built: `scripted` calls it for those, so a reply from the reply set plugs into
// F0a's own reply hook and the bytes are F0a's. Everything F0a does not build (the Responses API, embeddings, Anthropic, Cohere) comes from this lane's family files through `model-render.ts`. PURE.
import { lowerHeaders, type HeaderBag, type ModelReply, type SseLineEnding } from "./model-family-common.js";
import { routeGeminiRequest, type GeminiRouteRefusal } from "./model-family-gemini.js";
import { routeOpenAiCompatibleRequest } from "./model-family-openai.js";
import { routeAnthropicRequest } from "./model-family-anthropic.js";
import { routeCohereRequest } from "./model-family-cohere.js";
import { serveModelRequest, type ModelHelperRequest, type ServableRow } from "./model-serve.js";
import { buildFailureAnswer, type FailureContext, type FailureSpec } from "./model-failure-pack.js";
import { isChatOperation, renderModelReply, renderUtilityOperation, type ModelAnswer, type ModelStreamKind, type ModelWire } from "./model-render.js";
import type { ModelRequestFacts } from "./model-request-facts.js";
import type { ServedModelFamily } from "./model-served-family.js";

export type ModelCredentialKind = "x-goog-api-key" | "x-api-key" | "api-key" | "authorization" | "query_key" | "none";

export interface FamilyRouteInput {
  readonly method: string;
  /** The path after `/p/<rowId>`. */
  readonly path: string;
  readonly query: string;
  readonly headers: HeaderBag;
  readonly pathPrefix: string | undefined;
  /** The body said `"stream": true` (OpenAI, Anthropic, Cohere). Gemini decides from the path and query. */
  readonly streamRequested: boolean;
}
export interface FamilyRouteOk {
  readonly ok: true;
  readonly wire: ModelWire;
  readonly operation: string;
  /** The model in the path (Gemini); undefined when it is in the body. */
  readonly model: string | undefined;
  readonly stream: ModelStreamKind;
  readonly enumEncoding: "string" | "int";
  /** Which credential the client sent, by kind (never its value). */
  readonly credential: ModelCredentialKind;
}
export type FamilyRoute = FamilyRouteOk | { readonly ok: false; readonly status: 404 | 405; readonly reason: string };

export interface ScriptedEnv {
  readonly rows: readonly ServableRow[];
  readonly request: ModelHelperRequest;
  readonly facts: ModelRequestFacts;
  readonly requestBytes: number;
  readonly seed: string;
  readonly lineEnding: SseLineEnding;
  readonly created: number;
}

export interface ModelFamilyShape {
  readonly family: ServedModelFamily;
  route(input: FamilyRouteInput, row: ServableRow): FamilyRoute;
  /** The scripted answer for a matched reply, or undefined when this operation is not built here. */
  scripted(route: FamilyRouteOk, reply: ModelReply, env: ScriptedEnv): ModelAnswer | undefined;
  failure(spec: FailureSpec, context: FailureContext): ModelAnswer;
}

function credentialKind(headers: HeaderBag, queryKey = false): ModelCredentialKind {
  const names = new Set(lowerHeaders(headers).keys());
  if (names.has("x-goog-api-key")) return "x-goog-api-key";
  if (names.has("x-api-key")) return "x-api-key";
  if (names.has("api-key")) return "api-key";
  if (names.has("authorization")) return "authorization";
  return queryKey ? "query_key" : "none";
}

const refusalStatus = (reason: string): 404 | 405 => (reason === "method_not_allowed" ? 405 : 404);

const GEMINI_MODES_OF_FAMILY: Record<"gemini" | "vertex", readonly string[]> = { gemini: ["ai_studio", "openai_compatible"], vertex: ["vertex_express", "vertex_project", "openai_compatible"] };

function geminiRoute(family: "gemini" | "vertex") {
  return (input: FamilyRouteInput): FamilyRoute => {
    const route = routeGeminiRequest({ method: input.method, path: input.path, query: input.query, headers: input.headers });
    if (!route.ok) return { ok: false, status: refusalStatus(route.reason satisfies GeminiRouteRefusal), reason: route.reason };
    if (!GEMINI_MODES_OF_FAMILY[family].includes(route.mode)) return { ok: false, status: 404, reason: "route_not_for_row" };
    const openai = route.mode === "openai_compatible";
    return {
      ok: true,
      wire: openai ? "openai" : "gemini",
      operation: route.operation,
      model: route.model,
      stream: openai ? (input.streamRequested ? "sse" : "none") : route.stream,
      enumEncoding: route.enumEncoding,
      credential: route.credential === "x-goog-api-key" ? "x-goog-api-key" : route.credential === "query_key" ? "query_key" : credentialKind(input.headers),
    };
  };
}

const F0A_OPERATIONS: Record<ModelWire, readonly string[]> = { gemini: ["generateContent", "streamGenerateContent", "countTokens"], openai: ["chat_completions"], anthropic: [], cohere: [] };

/** The answer for a matched reply: F0a's entry for what F0a builds, this lane's builders for the rest. */
function scriptedFor(route: FamilyRouteOk, reply: ModelReply, env: ScriptedEnv): ModelAnswer | undefined {
  if (F0A_OPERATIONS[route.wire].includes(route.operation)) {
    const answer = serveModelRequest(env.rows, env.request, { reply, seed: env.seed, lineEnding: env.lineEnding, created: env.created });
    return { status: answer.status, headers: answer.headers, body: answer.body };
  }
  const model = route.model ?? env.facts.model ?? "unknown-model";
  const context = { wire: route.wire, operation: route.operation, model, stream: route.stream, seed: env.seed, lineEnding: env.lineEnding, created: env.created, enumEncoding: route.enumEncoding };
  return isChatOperation(route.wire, route.operation) ? renderModelReply(reply, context) : renderUtilityOperation(env.facts, env.requestBytes, context);
}

const failureFor = (spec: FailureSpec, context: FailureContext): ModelAnswer => buildFailureAnswer(spec, context);

export const MODEL_FAMILY_REGISTRY: Readonly<Record<ServedModelFamily, ModelFamilyShape>> = {
  openai_compatible: {
    family: "openai_compatible",
    route: (input) => {
      const route = routeOpenAiCompatibleRequest({ method: input.method, path: input.path, pathPrefix: input.pathPrefix });
      if (!route.ok) return { ok: false, status: refusalStatus(route.reason), reason: route.reason };
      return { ok: true, wire: "openai", operation: route.operation, model: undefined, stream: input.streamRequested ? "sse" : "none", enumEncoding: "string", credential: credentialKind(input.headers) };
    },
    scripted: scriptedFor,
    failure: failureFor,
  },
  anthropic_messages: {
    family: "anthropic_messages",
    route: (input) => {
      const route = routeAnthropicRequest({ method: input.method, path: input.path, pathPrefix: input.pathPrefix });
      if (!route.ok) return { ok: false, status: refusalStatus(route.reason), reason: route.reason };
      return { ok: true, wire: "anthropic", operation: route.operation, model: undefined, stream: route.operation === "messages" && input.streamRequested ? "sse" : "none", enumEncoding: "string", credential: credentialKind(input.headers) };
    },
    scripted: scriptedFor,
    failure: failureFor,
  },
  gemini: { family: "gemini", route: geminiRoute("gemini"), scripted: scriptedFor, failure: failureFor },
  vertex: { family: "vertex", route: geminiRoute("vertex"), scripted: scriptedFor, failure: failureFor },
  cohere: {
    family: "cohere",
    route: (input) => {
      const route = routeCohereRequest({ method: input.method, path: input.path, pathPrefix: input.pathPrefix });
      if (!route.ok) return { ok: false, status: refusalStatus(route.reason), reason: route.reason };
      return { ok: true, wire: "cohere", operation: route.operation, model: undefined, stream: route.operation === "chat" && input.streamRequested ? "sse" : "none", enumEncoding: "string", credential: credentialKind(input.headers) };
    },
    scripted: scriptedFor,
    failure: failureFor,
  },
};
