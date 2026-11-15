// TE-F2 part B (M2, release 0.5.19): the NARROW entry of the model helper program (`@agentx/contracts/model-helper`, like `dns-helper`). The helper must have no outbound socket anywhere in its import graph; the package's main entry
// (index.ts) re-exports modules that call `fetch` (a channel client, a setup draft), so the program imports only these named exports, all of them pure model-catalog and reply code. A test walks the program's import graph from
// this file and fails if any module in it can open a connection.
export { FailureSpecSchema, FAILURE_MODES, type FailureSpec } from "./model-failure-pack.js";
export { INITIAL_SERVE_STATE, serveModelRequestWithReplies, type ServeState } from "./model-serve-replies.js";
export { MODEL_ECHO_PATTERN } from "./model-family-common.js";
export { SSE_CONTENT_TYPE, type ModelAnswer } from "./model-render.js";
export { MODEL_FAMILIES, checkModelHost } from "./model-catalog.js";
export { readModelRequestFacts } from "./model-request-facts.js";
export { GCE_DUMMY_TOKEN, serveMetadataRequest } from "./model-family-gemini.js";
export { REPLY_PROVENANCES, replyCountsTowardProof } from "./model-reply-provenance.js";
export { ModelReplySetSchema, type ModelReplySet } from "./model-reply-set.js";
export { SERVED_MODEL_FAMILIES, type ServedModelFamily } from "./model-served-family.js";
export { canonicalJson } from "./canonical-json.js";
export { sha256HexOf } from "./service-catalog-verify.js";
export type { ServableRow } from "./model-serve.js";
