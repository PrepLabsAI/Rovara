// TE-F2 part A (M2, release 0.5.19; DECISIONS 158, 161): `serveModelRequestWithReplies(rows, replySet, request, options)`, the entry the helper's HTTP loop (Part B) calls. It adds to F0a's `serveModelRequest` what F0a
// leaves to F2: it picks the scripted reply from the reply set, serves the families F0a does not build (Anthropic, Cohere, the Responses API, embeddings), fails closed when nothing matches, and runs the failure pack.
// F0a's file is not edited: for the Gemini, Vertex and OpenAI chat answers this function calls F0a's `serveModelRequest` with the chosen reply, so a reply from the set plugs into F0a's own `reply` hook.
//
// What the answer says about itself (for the ledger and the evidence; never a body, a header value, a query or a prompt):
//   kind `scripted`      a matched reply was served; `provenance` is the reply's; `countsTowardProof` is `replyCountsTowardProof(provenance)`.
//   kind `failure_pack`  the failure pack answered; `countsTowardProof` is ALWAYS false.
//   kind `unmatched`     no reply matched: the family's own error envelope at a fixed status (400), the sentence "not run: no scripted reply for this request", never an invented reply; counted.
//   kind `not_served`    the request did not reach a served operation (unknown row, bad request, Bedrock, an operation not built here); never counted.
// The function is a pure state machine: `state` carries the call count (for `afterCalls`) and the per-reply match counts (for `sequence`), and `nextState` is returned. A Bedrock row answers "not run: Bedrock scripted
// replies are served by the local AWS front". PURE: no socket, no clock, no randomness.
import { MODEL_REQUEST_BODY_MAX_BYTES, type SseLineEnding } from "./model-family-common.js";
import { SERVE_ERROR_WORDS, type ModelHelperRequest, type ServableRow, type ServeErrorCode } from "./model-serve.js";
import { MODEL_FAMILY_REGISTRY, type FamilyRouteOk, type ModelCredentialKind } from "./model-families.js";
import { FAILURE_PACK_CLASS, familyErrorAnswer, type FailureContext, type FailureMode, type FailureSpec } from "./model-failure-pack.js";
import { replyCountsTowardProof, type ReplyProvenance, type ReplyResultClass } from "./model-reply-provenance.js";
import { modelReplyContentSha256, modelReplyOf, selectModelReply, type ModelReplySet } from "./model-reply-set.js";
import { readModelRequestFacts } from "./model-request-facts.js";
import { jsonAnswer, type ModelAnswer } from "./model-render.js";
import { BEDROCK_NOT_RUN_SENTENCE, UNMATCHED_SENTENCE, isServedModelFamily, type ServedModelFamily } from "./model-served-family.js";

export const SERVE_KINDS = ["scripted", "failure_pack", "unmatched", "not_served"] as const;
export type ServeKind = (typeof SERVE_KINDS)[number];
/** The status of an unmatched call: a 4xx no SDK retries, so one unmatched call is one ledger row. */
export const UNMATCHED_STATUS = 400;

export interface ServeState {
  /** Calls that reached a served operation so far (any outcome). */
  readonly callCount: number;
  /** Per reply id, the number of calls that matched its other criteria (for `sequence`). */
  readonly matchCounts: ReadonlyMap<string, number>;
}
export const INITIAL_SERVE_STATE: ServeState = { callCount: 0, matchCounts: new Map() };

export interface ServeRepliesOptions {
  /** Ids in an answer come from this seed. */
  readonly seed: string;
  readonly lineEnding?: SseLineEnding | undefined;
  /** The `created` time in an OpenAI-shaped answer; this code has no clock. */
  readonly created?: number | undefined;
  /** Serve the failure pack: from call `afterCalls + 1` on (default 0: every call). */
  readonly failure?: FailureSpec | undefined;
  readonly state?: ServeState | undefined;
}

export interface ServeRepliesResult {
  readonly answer: ModelAnswer;
  readonly kind: ServeKind;
  readonly resultClass: ReplyResultClass;
  readonly countsTowardProof: boolean;
  /** The row and the operation, once the request reached one. */
  readonly rowId: string | undefined;
  readonly family: ServedModelFamily | undefined;
  readonly operation: string | undefined;
  readonly model: string | undefined;
  readonly credential: ModelCredentialKind | undefined;
  readonly replyId: string | undefined;
  readonly provenance: ReplyProvenance | undefined;
  /** SHA-256 of the served reply's response (never the response itself). */
  readonly replySha256: string | undefined;
  readonly failureMode: FailureMode | undefined;
  /** The fixed sentence the evidence uses for an unmatched or Bedrock call. */
  readonly evidenceSentence: string | undefined;
  readonly nextState: ServeState;
}

const ROW_PATH = /^\/p\/([a-z][a-z0-9-]{0,39})(\/.*)?$/u;
const bodyText = (body: ModelHelperRequest["body"]): string => (body === undefined ? "" : typeof body === "string" ? body : new TextDecoder().decode(body));
const bodyBytes = (body: ModelHelperRequest["body"]): number => (body === undefined ? 0 : typeof body === "string" ? new TextEncoder().encode(body.length > MODEL_REQUEST_BODY_MAX_BYTES + 4 ? body.slice(0, MODEL_REQUEST_BODY_MAX_BYTES + 4) : body).length : body.byteLength);

const fixedError = (status: number, code: ServeErrorCode | "bad_reply", message?: string): ModelAnswer => jsonAnswer(status, { error: { code, message: message ?? (code === "bad_reply" ? "the scripted reply could not be rendered" : SERVE_ERROR_WORDS[code]) } });

/** A not-served answer is never a 5xx (an SDK retries those, and each retry would be one more ledger row): a 5xx from the builders below becomes a 422 with the same body. */
const retrySafe = (answer: ModelAnswer): ModelAnswer => (answer.status >= 500 ? { ...answer, status: 422 } : answer);

interface Base {
  readonly rowId: string | undefined;
  readonly family: ServedModelFamily | undefined;
  readonly operation: string | undefined;
  readonly model: string | undefined;
  readonly credential: ModelCredentialKind | undefined;
}
const NO_BASE: Base = { rowId: undefined, family: undefined, operation: undefined, model: undefined, credential: undefined };

function notServed(answer: ModelAnswer, state: ServeState, base: Base = NO_BASE, sentence?: string): ServeRepliesResult {
  return { answer, kind: "not_served", resultClass: "not_served", countsTowardProof: false, ...base, replyId: undefined, provenance: undefined, replySha256: undefined, failureMode: undefined, evidenceSentence: sentence, nextState: state };
}

/** The first tool name, the stream kind and the rest of what a failure answer needs. */
function failureContext(route: FamilyRouteOk, model: string, toolName: string | undefined, options: ServeRepliesOptions): FailureContext {
  return { wire: route.wire, operation: route.operation, model, stream: route.stream, seed: options.seed, lineEnding: options.lineEnding ?? "lf", created: options.created ?? 1_700_000_000, enumEncoding: route.enumEncoding, toolName };
}

/**
 * One request, one answer, one ledger fact set. Finds the row by `/p/<rowId>`, routes by the row's family, then (in this order): serves the failure pack when `options.failure` is set and `afterCalls` calls have already
 * been served; otherwise picks the reply (first match wins) and renders it; otherwise answers "unmatched". Never throws on a request.
 */
export function serveModelRequestWithReplies(rows: readonly ServableRow[], replySet: ModelReplySet | undefined, request: ModelHelperRequest, options: ServeRepliesOptions): ServeRepliesResult {
  const state = options.state ?? INITIAL_SERVE_STATE;
  if (bodyBytes(request.body) > MODEL_REQUEST_BODY_MAX_BYTES) return notServed(fixedError(413, "body_too_large"), state);
  const matched = typeof request.path === "string" && request.path.length <= 600 ? ROW_PATH.exec(request.path) : null;
  const row = matched === null ? undefined : rows.find((candidate) => candidate.id === matched[1]);
  if (matched === null || row === undefined) return notServed(fixedError(404, "unknown_row"), state);
  if (row.routesTo === "local_aws_front" || row.family === "bedrock") {
    return notServed(fixedError(421, "routes_to_local_aws_front", BEDROCK_NOT_RUN_SENTENCE), state, { ...NO_BASE, rowId: row.id }, BEDROCK_NOT_RUN_SENTENCE);
  }
  if (!isServedModelFamily(row.family)) return notServed(fixedError(422, "family_not_built"), state, { ...NO_BASE, rowId: row.id });
  const family: ServedModelFamily = row.family;
  const shape = MODEL_FAMILY_REGISTRY[family];
  const text = bodyText(request.body);
  const facts = readModelRequestFacts(text);
  const route = shape.route({ method: request.method, path: matched[2] ?? "/", query: request.query, headers: request.headers, pathPrefix: row.pathPrefix, streamRequested: facts.stream }, row);
  if (!route.ok) return notServed(fixedError(route.status, route.status === 405 ? "bad_request" : route.reason === "route_not_for_row" ? "route_not_for_row" : "bad_request"), state, { ...NO_BASE, rowId: row.id, family });
  const model = route.model ?? facts.model ?? "unknown-model";
  const base: Base = { rowId: row.id, family, operation: route.operation, model, credential: route.credential };
  const callState = (matchCounts: ReadonlyMap<string, number>): ServeState => ({ callCount: state.callCount + 1, matchCounts });

  const failure = options.failure;
  if (failure !== undefined && state.callCount >= (failure.afterCalls ?? 0)) {
    const answer = shape.failure(failure, failureContext(route, model, facts.toolName, options));
    return { answer, kind: "failure_pack", resultClass: FAILURE_PACK_CLASS, countsTowardProof: false, ...base, replyId: undefined, provenance: undefined, replySha256: undefined, failureMode: failure.mode, evidenceSentence: undefined, nextState: callState(state.matchCounts) };
  }

  const selection = selectModelReply(replySet, { model, operation: route.operation, promptText: facts.promptText }, state.matchCounts, family);
  const next = callState(selection.nextCounts);
  const reply = selection.reply;
  if (reply === undefined) {
    return { answer: { ...familyErrorAnswer(route.wire, "no_script"), status: UNMATCHED_STATUS }, kind: "unmatched", resultClass: "unmatched", countsTowardProof: false, ...base, replyId: undefined, provenance: undefined, replySha256: undefined, failureMode: undefined, evidenceSentence: UNMATCHED_SENTENCE, nextState: next };
  }
  let answer: ModelAnswer | undefined;
  try {
    answer = shape.scripted(route, modelReplyOf(reply), { rows, request, facts, requestBytes: bodyBytes(request.body), seed: options.seed, lineEnding: options.lineEnding ?? "lf", created: options.created ?? 1_700_000_000 });
  } catch {
    return { ...notServed(fixedError(422, "bad_reply"), next, base), replyId: reply.id };
  }
  if (answer === undefined || answer.status !== 200) return { ...notServed(answer === undefined ? fixedError(422, "operation_not_built") : retrySafe(answer), next, base), replyId: reply.id };
  return {
    answer,
    kind: "scripted",
    resultClass: reply.provenance,
    /** A failure-pack run proves nothing: not even the calls that succeed before `afterCalls` count. */
    countsTowardProof: failure === undefined && replyCountsTowardProof(reply.provenance),
    ...base,
    replyId: reply.id,
    provenance: reply.provenance,
    replySha256: modelReplyContentSha256(reply),
    failureMode: undefined,
    evidenceSentence: undefined,
    nextState: next,
  };
}
