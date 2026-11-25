// The engine bridge (Code's worker -> the gateway's product route). Mirrored byte-for-byte by
// contracts/shared/model-gateway-product-ai.v1.json, which Code's worker copies (a test pins its SHA-256 in both repos).
//
// How a product call travels: the customer's test in the sandbox calls the worker's local port with a DUMMY Google key (it
// never holds the real one, nor the task token). The worker's trusted part removes the dummy key headers and any `key=`
// query, adds the TC-1 task token it already holds for the task (from GET /v1/internal/model-access, key purpose "task",
// Code #670) as `x-api-key`, and forwards to `<baseUrl>/v1/product/gemini/...`. The gateway refuses a request that still
// carries a Google credential or a URL key, so a sandbox can't reach it directly with a token in Google's places.
import { PRODUCT_KEY_REFUSED, PRODUCT_NOT_SET_UP, PRODUCT_OVER_BY_ONE_CALL, PRODUCT_PROVIDER_LIMITED, PRODUCT_PROVIDER_REFUSED, PRODUCT_VERTEX_NOT_CONNECTED } from "./product-route.js";
import { VERTEX_HOST_GLOBAL, VERTEX_VERSIONS } from "./product-vertex.js";
import { GCP_PROJECT, VERTEX_LOCATION } from "./product-vertex-credential.js";
import { GEMINI_HOST, GEMINI_MODEL, GEMINI_VERSIONS } from "./product-gemini.js";
import { PRODUCT_ROUTE_PREFIX } from "./server.js";
import { AUTH_ERROR } from "./token.js";
import { TASK_KEY_PURPOSE } from "./model-gateway-token.js";
import { EVENT_STREAM_CONTENT_TYPE, PRODUCT_BEDROCK_FEATURE, PRODUCT_BEDROCK_MODEL, PRODUCT_BEDROCK_MODEL_NOT_ENABLED, PRODUCT_BEDROCK_NOT_CONNECTED, PRODUCT_BEDROCK_OPERATION, PRODUCT_BEDROCK_QUOTA, PRODUCT_BEDROCK_REFUSED, PRODUCT_BEDROCK_THROTTLED } from "./product-bedrock.js";

export const PRODUCT_BRIDGE_VERSION = 1;
export const PRODUCT_BRIDGE = {
  version: PRODUCT_BRIDGE_VERSION,
  token: { contract: "model-gateway-token.v1.json", keyPurpose: TASK_KEY_PURPOSE, source: "GET /v1/internal/model-access", headers: ["x-api-key", "authorization: Bearer"] },
  routePrefix: PRODUCT_ROUTE_PREFIX,
  providers: [{
    name: "gemini", upstreamHost: GEMINI_HOST,
    paths: ["/v1/product/gemini/{version}/models/{model}:generateContent", "/v1/product/gemini/{version}/models/{model}:streamGenerateContent?alt=sse"],
    versions: [...GEMINI_VERSIONS], model: GEMINI_MODEL.source,
    workerRemovesHeaders: ["x-goog-api-key", "x-goog-user-project", "authorization"], workerRemovesQuery: ["key"],
  }],
  refusals: [
    { status: 401, type: AUTH_ERROR.error.type, message: AUTH_ERROR.error.message },
    { status: 403, type: "task_ended", message: "task ended" },
    { status: 404, type: "not_set_up", message: PRODUCT_NOT_SET_UP },
    { status: 422, type: "budget_exceeded", message: PRODUCT_OVER_BY_ONE_CALL },
    { status: 422, type: "budget_exceeded", messagePrefix: "Product AI budget has been exceeded! " },
    { status: 429, type: "busy", retryAfter: true },
    { status: 429, type: "budget_held", retryAfter: true },
    { status: 429, type: "provider_limited", message: PRODUCT_PROVIDER_LIMITED },
    { status: 400, type: "provider_refused", message: PRODUCT_PROVIDER_REFUSED },
    { status: 502, type: "product_key_refused", message: PRODUCT_KEY_REFUSED },
  ],
} as const;

/**
 * The Vertex half of the bridge (DEC 229b), its own file so the Gemini contract above (and Code's pinned copy) stays as it is:
 * contracts/shared/model-gateway-product-vertex.v1.json. The sandbox's Vertex SDK calls the worker's local port with a dummy
 * Google bearer token; the worker removes Google credential headers (the Authorization bearer, x-goog-user-project, x-goog-iam-*)
 * and any `key=` query, adds the task token as `x-api-key`, and forwards to `<baseUrl>/v1/product/vertex/...`. The project and
 * location in the path must be the ones connected in Settings: another one is refused (`not_allowed`). The gateway mints the
 * company's own Google token; the worker never holds one.
 */
export const PRODUCT_VERTEX_BRIDGE = {
  version: 1,
  bridge: "model-gateway-product-ai.v1.json",
  provider: {
    name: "vertex", upstreamHosts: ["{location}-aiplatform.googleapis.com", VERTEX_HOST_GLOBAL],
    paths: [
      "/v1/product/vertex/{version}/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent",
      "/v1/product/vertex/{version}/projects/{project}/locations/{location}/publishers/google/models/{model}:streamGenerateContent?alt=sse",
    ],
    versions: [...VERTEX_VERSIONS], project: GCP_PROJECT.source, location: VERTEX_LOCATION.source, model: GEMINI_MODEL.source,
    workerRemovesHeaders: ["authorization", "x-goog-api-key", "x-goog-user-project", "x-goog-iam-authorization-token", "x-goog-iam-authority-selector"], workerRemovesQuery: ["key"],
  },
  refusals: [
    { status: 400, type: "not_allowed", message: PRODUCT_VERTEX_NOT_CONNECTED },
    { status: 502, type: "product_key_refused", message: PRODUCT_KEY_REFUSED },
    { status: 503, type: "unavailable", message: "model access unavailable" },
  ],
} as const;

/**
 * The Bedrock half of the bridge (DEC 238 slice 2, bridge contract v2), its own file so the Gemini contract (and Code's pinned copy)
 * stays as it is: contracts/shared/model-gateway-product-bedrock.v2.json. The sandbox's AWS SDK has AWS_ENDPOINT_URL_BEDROCK_RUNTIME
 * set to the worker's local port and dummy AWS credentials; its request is SigV4-signed with them. The worker removes every
 * credential header (the dummy signature, session token, date and payload hash) and adds the task token as `x-api-key`, then forwards
 * to `<baseUrl>/v1/product/bedrock/model/{id}/{operation}`, streaming the answer back unbuffered (a ConverseStream answer is AWS's
 * binary event stream, application/vnd.amazon.eventstream). The gateway signs for the company's OWN role; the worker never holds one.
 * The model must be one the company picked; the Region is the connection's, never the request's.
 */
export const PRODUCT_BEDROCK_BRIDGE = {
  version: 2,
  bridge: "model-gateway-product-ai.v1.json",
  provider: {
    name: "bedrock",
    upstreamHost: "bedrock-runtime.{region}.amazonaws.com",
    paths: [
      "/v1/product/bedrock/model/{model}/converse",
      "/v1/product/bedrock/model/{model}/converse-stream",
      "/v1/product/bedrock/model/{model}/invoke",
      "/v1/product/bedrock/model/{model}/invoke-with-response-stream",
    ],
    model: "^[a-z0-9][a-z0-9.:-]{1,200}$",
    operations: {
      converse: "every picked model", "converse-stream": "every picked model",
      invoke: "Claude (Anthropic body) and Titan text embeddings", "invoke-with-response-stream": "Claude (Anthropic body)",
    },
    sandbox: { endpointEnvironment: "AWS_ENDPOINT_URL_BEDROCK_RUNTIME", credentials: "dummy" },
    streamContentType: EVENT_STREAM_CONTENT_TYPE,
    workerRemovesHeaders: ["authorization", "x-amz-security-token", "x-amz-date", "x-amz-content-sha256"],
    gatewayRefusesHeaders: ["authorization", "x-amz-security-token", "x-amz-bedrock-*", "x-amzn-bedrock-*"],
    workerRemovesQuery: [],
  },
  refusals: [
    { status: 400, type: "not_allowed", message: PRODUCT_BEDROCK_FEATURE },
    { status: 400, type: "not_allowed", message: PRODUCT_BEDROCK_MODEL },
    { status: 400, type: "not_allowed", message: PRODUCT_BEDROCK_OPERATION },
    { status: 404, type: "not_set_up", message: PRODUCT_BEDROCK_NOT_CONNECTED },
    { status: 403, type: "model_not_enabled", message: PRODUCT_BEDROCK_MODEL_NOT_ENABLED },
    { status: 502, type: "product_key_refused", message: PRODUCT_BEDROCK_REFUSED },
    { status: 429, type: "provider_limited", message: PRODUCT_BEDROCK_THROTTLED },
    { status: 429, type: "provider_quota", message: PRODUCT_BEDROCK_QUOTA },
    { status: 400, type: "provider_refused", message: PRODUCT_PROVIDER_REFUSED },
    { status: 503, type: "unavailable", message: "model access unavailable" },
  ],
} as const;
