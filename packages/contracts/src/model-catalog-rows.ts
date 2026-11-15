// TE-F0a: the built-in rows of the model catalog (data). Every fact for the Google rows is from designs-2026-10-30/gemini-redirect-check-2026-11-13.md (a run against a local plain-HTTP fake on 2026-11-12 plus the SDK
// sources); anything that note calls UNVERIFIED is `verified: false` here and written "UNVERIFIED: ..." in the row's notes. The hosted-gateway rows were NOT part of that check (this lane has no network): all of their facts are
// unverified, and the readiness run must confirm a gateway's base URL before it proposes a redirect.
//
// The rows are data, not code per provider: a new OpenAI-compatible provider is one more row. They are not signed yet (see `model-catalog-digest.ts`).
import { ModelCatalogSchema, type ModelCatalog } from "./model-catalog.js";

const errorIds = (family: string) => ({ rateLimit: `${family}.rate_limit`, tokenLimit: `${family}.token_limit`, refusal: `${family}.refusal`, badToolJson: `${family}.bad_tool_json`, cutOffStream: `${family}.cut_off_stream` });

/** Exact names only (never *.googleapis.com). Compared 2026-11-13 with
 * https://docs.cloud.google.com/vertex-ai/docs/general/locations and
 * https://docs.cloud.google.com/docs/security/compliance/restrict-endpoint-usage (also verifies us-west8/mTLS).
 * Retain the existing northamerica-south1 entries; that location is not verified by these lists.
 */
const VERTEX_LOCATIONS = [
  "us", "eu", "us-central1", "us-east1", "us-east4", "us-east5", "us-south1", "us-west1", "us-west2", "us-west3", "us-west4", "northamerica-northeast1", "northamerica-northeast2", "southamerica-east1",
  "southamerica-west1", "europe-central2", "europe-north1", "europe-southwest1", "europe-west1", "europe-west2", "europe-west3", "europe-west4", "europe-west6", "europe-west8", "europe-west9", "europe-west12",
  "asia-east1", "asia-east2", "asia-northeast1", "asia-northeast2", "asia-northeast3", "asia-south1", "asia-southeast1", "asia-southeast2", "australia-southeast1", "australia-southeast2", "me-central1",
  "me-central2", "me-west1", "africa-south1", "europe-west10", "asia-south2", "northamerica-south1", "europe-north2", "us-west8",
] as const;

/** Exact REP locations verified 2026-11-13: https://docs.cloud.google.com/docs/security/compliance/restrict-endpoint-usage */
const VERTEX_REP_LOCATIONS = [
  "africa-south1", "asia-east1", "asia-east2", "asia-northeast1", "asia-northeast2", "asia-northeast3",
  "asia-south1", "asia-south2", "asia-southeast1", "asia-southeast2", "australia-southeast1", "australia-southeast2",
  "eu", "europe-central2", "europe-north1", "europe-north2", "europe-southwest1", "europe-west1",
  "europe-west10", "europe-west12", "europe-west2", "europe-west3", "europe-west4", "europe-west6",
  "europe-west8", "europe-west9", "me-central1", "me-central2", "me-west1", "northamerica-northeast1",
  "northamerica-northeast2", "southamerica-east1", "southamerica-west1", "us", "us-central1", "us-east1",
  "us-east4", "us-east5", "us-south1", "us-west1", "us-west2", "us-west3",
  "us-west4", "us-west8",
] as const;

const GOOGLE_DUMMY_KEY_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];

const BUILTIN_ROWS_DATA = {
  schemaVersion: 1,
  revision: 5,
  rows: [
    {
      id: "gemini",
      kind: "provider",
      hosts: ["generativelanguage.googleapis.com", "generativelanguage.mtls.googleapis.com", "firebasevertexai.googleapis.com"],
      authHosts: [],
      family: "gemini",
      auth: [{ scheme: "header", name: "x-goog-api-key" }],
      redirect: [
        { kind: "env_var", client: "google-genai (Python, JS), langchain-google-genai (Python)", names: ["GOOGLE_GEMINI_BASE_URL"], companion: GOOGLE_DUMMY_KEY_VARS, verified: true, note: "Node only for JS. Plain http accepted. Tested 2026-11-12." },
        { kind: "sdk_option", client: "@ai-sdk/google (JS)", option: "createGoogleGenerativeAI({ baseURL: '<helper>/v1beta' })", needsRestTransport: false, verified: true, note: "No base-URL variable: GOOGLE_GENERATIVE_AI_BASE_URL is ignored. baseURL must carry /v1beta." },
        { kind: "sdk_option", client: "@langchain/google-genai (JS)", option: "baseUrl option of the chat model", needsRestTransport: false, verified: true, note: "GOOGLE_GEMINI_BASE_URL is NOT honoured: that probe reached the real host." },
        { kind: "sdk_option", client: "@google/generative-ai (JS, legacy)", option: "getGenerativeModel({ model }, { baseUrl })", needsRestTransport: false, verified: true, note: "Streams with alt=sse. No variable found." },
        { kind: "sdk_option", client: "google-generativeai (Python, legacy)", option: "genai.configure(transport='rest', client_options={'api_endpoint': '<helper>'})", needsRestTransport: true, verified: true, note: "Streams a JSON array, not SSE. No variable found (not proven absent)." },
        { kind: "none", client: "google-generativeai (Python, legacy) on its default gRPC transport", verified: false, note: "UNVERIFIED beyond a hang: gRPC needs TLS and HTTP/2, so it is treated as not supported until the client is set to rest." },
        { kind: "none", client: "google-genai Live API (WebSocket)", verified: false, note: "The client rewrites the scheme to wss, so a plain-http base URL does not give ws://. UNVERIFIED by a run." },
      ],
      streaming: ["sse", "json_array"],
      errors: errorIds("gemini"),
      notes: [
        "Source: gemini-redirect-check-2026-11-13.md (clients actually run: google-genai 2.34.0 and 3.3.0, google-generativeai 0.8.6, @ai-sdk/google 4.0.119, langchain-google-genai 4.4.3).",
        "Any API version prefix is sent (v1 in JS 3.3.0, v1beta in Python 2.34.0): serve v1, v1beta, v1alpha and v1beta1 alike.",
        "The key travels as x-goog-api-key and never as Authorization. The legacy REST clients send ?$alt=json;enum-encoding=int.",
        "SSE: each event is 'data: <GenerateContentResponse JSON>' then a blank line; Python needs 'data: ' with the space; there is no [DONE] sentinel.",
        "UNVERIFIED: enum-as-int (enum-encoding=int) answers. The test used the string form 'STOP' and the legacy client parsed it; the integer form is built but not proven.",
        "UNVERIFIED: the Live API (WebSocket) cannot be redirected to plain http and is treated as not redirectable.",
        "UNVERIFIED: the Interactions API (/v1beta/interactions?alt=sse) is not served; whether customers use it is unknown.",
        "Firebase AI Logic host verified 2026-11-13: https://firebase.google.com/docs/reference/js/ai.requestoptions . Its SDK redirect is not verified by the redirect check.",
        "Two probes (the AI SDK and LangChain JS variables) sent a fake key to the real endpoint: this is why every host here is also blocked at the network, not only redirected.",
      ],
    },
    {
      id: "vertex",
      kind: "provider",
      hosts: ["aiplatform.googleapis.com", "aiplatform.mtls.googleapis.com", ...VERTEX_LOCATIONS.flatMap((location) => [`${location}-aiplatform.googleapis.com`, `${location}-aiplatform.mtls.googleapis.com`]), ...VERTEX_REP_LOCATIONS.flatMap((location) => [`aiplatform.${location}.rep.googleapis.com`, `aiplatform.${location}.rep.mtls.googleapis.com`])],
      authHosts: ["iamcredentials.googleapis.com", "oauth2.googleapis.com", "sts.googleapis.com"],
      family: "vertex",
      auth: [{ scheme: "gcp_oauth" }, { scheme: "header", name: "x-goog-api-key" }],
      redirect: [
        { kind: "env_var", client: "google-genai (Python, JS) in Vertex mode", names: ["GOOGLE_VERTEX_BASE_URL"], companion: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION", "GCE_METADATA_HOST", "GCE_METADATA_IP", "GOOGLE_API_KEY"], verified: true, note: "Express mode (an API key) needs no credentials. Project and location need Application Default Credentials: set the metadata variables (Python needs both GCE_METADATA_HOST and GCE_METADATA_IP, JS needs GCE_METADATA_HOST)." },
        { kind: "sdk_option", client: "vertexai / google-cloud-aiplatform (Python)", option: "vertexai.init(api_endpoint='<helper>', api_transport='rest', credentials=...)", needsRestTransport: true, verified: true, note: "Tested with a throwaway token credential. Streams a JSON array. Deprecated by Google." },
        { kind: "sdk_option", client: "@ai-sdk/google-vertex (JS)", option: "createVertex({ baseURL: '<helper>/v1/projects/<p>/locations/<l>/publishers/google' })", needsRestTransport: false, verified: true, note: "Non-express mode asks google-auth-library for credentials: it worked with GCE_METADATA_HOST set." },
        { kind: "sdk_option", client: "langchain-google-vertexai (Python)", option: "ChatVertexAI(base_url=..., api_transport='rest', credentials=...)", needsRestTransport: true, verified: true, note: "ChatVertexAI is deprecated; ChatGoogleGenerativeAI(vertexai=True) rides google-genai and should follow the first row (UNVERIFIED)." },
        { kind: "env_var", client: "OpenAI SDK against Vertex's OpenAI endpoint", names: ["OPENAI_BASE_URL"], companion: [], verified: false, note: "UNVERIFIED: no Vertex-style customer snippet was run. The customer's own code still fetches the OAuth token through google.auth, so the metadata variables apply." },
        { kind: "none", client: "vertexai / google-cloud-aiplatform on its default gRPC transport", verified: false, note: "UNVERIFIED beyond the docs: gRPC to plain http is not a viable redirect; set api_transport='rest'." },
        { kind: "none", client: "any client with GOOGLE_APPLICATION_CREDENTIALS set to a real key file", verified: true, note: "A real key file mints a real token with the customer's own credential; the model call still goes to the helper, which drops the bearer. This credential setting needs no redirect." },
      ],
      streaming: ["sse", "json_array"],
      errors: errorIds("vertex"),
      notes: [
        "Source: gemini-redirect-check-2026-11-13.md sections 1, 3, 4 and 5; te-f1-model-proxy-design-2026-11-13.md section 4.5 (metadata emulation).",
        "Paths seen: /v1beta1/publishers/google/models/<m>:generateContent (express), /v1beta1/projects/<p>/locations/<l>/publishers/google/models/<m>:generateContent, /v1/projects/... (vertexai REST). Any version prefix.",
        "Express mode sends x-goog-api-key; project and location mode sends Authorization: Bearer <token>, plus x-goog-user-project only when the credentials carry a quota project.",
        "Google's token hosts (oauth2, sts, iamcredentials) are authHosts, NOT blocked: they serve every Google API; the helper drops any bearer. Only Vertex rounds without a project credential use the metadata stand-in.",
        "UNVERIFIED: the retained northamerica-south1 location is absent from the checked Google endpoint lists; no REP name is inferred for it. Other locational and REP/mTLS names were checked against the documented endpoint inventory. Hosts are listed by name, never as *.googleapis.com.",
        "A client that calls a Google AI host that is not listed is reported 'unlisted model host' by findRedirectEscapes, never silently let through.",
        "UNVERIFIED: enum-as-int answers for the ?$alt=json;enum-encoding=int clients (same as the gemini row).",
        "Vertex's OpenAI-compatible endpoint is .../endpoints/openapi (the router serves it); its key is a short-lived OAuth token the customer's code fetches.",
      ],
    },
    {
      id: "gemini-openai",
      kind: "provider",
      hosts: ["generativelanguage.googleapis.com", "generativelanguage.mtls.googleapis.com"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1beta/openai",
      auth: [{ scheme: "bearer" }],
      redirect: [
        { kind: "env_var", client: "OpenAI SDK (Python)", names: ["OPENAI_BASE_URL"], companion: ["OPENAI_API_KEY"], verified: true, note: "OPENAI_BASE_URL=<helper>/v1beta/openai: POST /v1beta/openai/chat/completions with Authorization: Bearer <key>. Plain http fine. Tested 2026-11-12 (not in stream mode)." },
      ],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: [
        "Gemini through Google's OpenAI-compatible endpoint is the openai_compatible family (a data row, no code of its own).",
        "Source: gemini-redirect-check-2026-11-13.md section 5. The documented base URL is https://generativelanguage.googleapis.com/v1beta/openai/.",
        "Streaming is the standard chat.completions SSE ending in 'data: [DONE]'. UNVERIFIED: not run in stream mode against a client.",
      ],
    },
    {
      id: "openai",
      kind: "provider",
      // Residency endpoints: https://developers.openai.com/api/docs/guides/your-data#data-residency
      hosts: ["api.openai.com", "eu.api.openai.com", "us.api.openai.com"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1",
      auth: [{ scheme: "bearer" }],
      redirect: [{ kind: "env_var", client: "OpenAI SDKs (Python, JS)", names: ["OPENAI_BASE_URL"], companion: ["OPENAI_API_KEY"], verified: false, note: "UNVERIFIED for api.openai.com itself; the same SDK variable was verified against Google's OpenAI-compatible endpoint (gemini-openai row)." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, /v1 prefix and bearer auth are written from general knowledge, not from a run. The Responses API is routed but not built (F2).", "api.openai.com is already on the hosted DNS firewall list."],
    },
    {
      id: "anthropic",
      kind: "provider",
      hosts: ["api.anthropic.com"],
      authHosts: [],
      family: "anthropic_messages",
      pathPrefix: "/v1",
      auth: [{ scheme: "header", name: "x-api-key" }],
      redirect: [{ kind: "env_var", client: "Anthropic SDKs (Python, JS)", names: ["ANTHROPIC_BASE_URL"], companion: ["ANTHROPIC_API_KEY"], verified: false, note: "UNVERIFIED: not in the redirect check." }],
      streaming: ["sse"],
      errors: errorIds("anthropic_messages"),
      notes: ["UNVERIFIED: host, /v1/messages path, x-api-key auth and the anthropic-version header are written from general knowledge, not from a run. The family is not served by the helper yet (F2).", "api.anthropic.com is already on the hosted DNS firewall list."],
    },
    {
      id: "cohere",
      kind: "provider",
      hosts: ["api.cohere.ai", "api.cohere.com"],
      authHosts: [],
      family: "cohere",
      auth: [{ scheme: "bearer" }],
      redirect: [{ kind: "env_var", client: "Cohere SDKs", names: ["CO_API_URL"], companion: ["CO_API_KEY"], verified: false, note: "UNVERIFIED: the variable name is written from general knowledge; newer SDKs may need a base_url option instead." }],
      streaming: ["sse", "json_lines"],
      errors: errorIds("cohere"),
      notes: ["UNVERIFIED: both hosts, bearer auth and the streaming formats (v2 chat SSE, older chat as JSON lines) are written from general knowledge. The family is not served by the helper yet (F2)."],
    },
    {
      id: "mistral",
      kind: "provider",
      // Dedicated code-model endpoint: https://mistral.ai/news/codestral
      hosts: ["api.mistral.ai", "codestral.mistral.ai"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1",
      auth: [{ scheme: "bearer" }],
      redirect: [
        { kind: "env_var", client: "OpenAI SDK pointed at Mistral", names: ["OPENAI_BASE_URL"], companion: ["OPENAI_API_KEY"], verified: false, note: "UNVERIFIED: Mistral's own SDK has no base-URL variable that was checked." },
        { kind: "sdk_option", client: "mistralai SDKs", option: "server_url option of the client", needsRestTransport: false, verified: false, note: "UNVERIFIED: option name written from general knowledge." },
      ],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, /v1 prefix and bearer auth are written from general knowledge, not from a run."],
    },
    {
      id: "groq",
      kind: "provider",
      hosts: ["api.groq.com"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/openai/v1",
      auth: [{ scheme: "bearer" }],
      redirect: [{ kind: "env_var", client: "Groq SDKs", names: ["GROQ_BASE_URL"], companion: ["GROQ_API_KEY"], verified: false, note: "UNVERIFIED: not in the redirect check." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, /openai/v1 prefix and bearer auth are written from general knowledge, not from a run."],
    },
    {
      id: "together",
      kind: "provider",
      hosts: ["api.together.ai", "api.together.xyz"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1",
      auth: [{ scheme: "bearer" }],
      redirect: [{ kind: "env_var", client: "Together SDKs", names: ["TOGETHER_BASE_URL"], companion: ["TOGETHER_API_KEY"], verified: false, note: "UNVERIFIED: not in the redirect check." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: both hosts, /v1 prefix and bearer auth are written from general knowledge, not from a run."],
    },
    {
      id: "azure-openai",
      kind: "provider",
      hosts: [],
      // Foundry public DNS zones: https://learn.microsoft.com/en-us/azure/private-link/private-endpoint-dns
      hostSuffixes: ["openai.azure.com", "cognitiveservices.azure.com", "services.ai.azure.com"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/openai",
      auth: [{ scheme: "header", name: "api-key" }],
      redirect: [{ kind: "env_var", client: "Azure OpenAI SDKs", names: ["AZURE_OPENAI_ENDPOINT"], companion: ["AZURE_OPENAI_API_KEY"], verified: false, note: "UNVERIFIED: not in the redirect check. The deployment path and api-version query are the customer's." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["Azure OpenAI and Foundry resources use the documented openai.azure.com, cognitiveservices.azure.com and services.ai.azure.com suffixes. A hosts file cannot hold a pattern: the block is by DNS suffix (modelHostSuffixBlockList), and the finder reports a call to any subdomain.", "UNVERIFIED: paths look like /openai/deployments/<deployment>/chat/completions?api-version=...; the router serves them."],
    },
    {
      id: "azure-ai-inference",
      kind: "provider",
      // Microsoft SDK endpoint forms: https://github.com/MicrosoftDocs/azure-docs-sdk-python/blob/main/docs-ref-services/preview/ai-inference-readme.md
      hosts: ["models.inference.ai.azure.com"],
      hostSuffixes: ["models.ai.azure.com"],
      authHosts: [],
      family: "openai_compatible",
      auth: [{ scheme: "bearer" }, { scheme: "header", name: "api-key" }],
      redirect: [{ kind: "sdk_option", client: "Azure AI Inference SDKs", option: "endpoint option of the client", needsRestTransport: false, verified: false, note: "UNVERIFIED: endpoint redirect has not been run against the helper." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["Microsoft documents models.inference.ai.azure.com for GitHub Models and <deployment>.<region>.models.ai.azure.com for serverless inference. A hosts file needs exact names; suffixes are for DNS blocking and the finder.", "UNVERIFIED: authentication, streaming and helper compatibility have not been exercised with the SDK. Inference uses /chat/completions, without Azure OpenAI's deployment prefix."],
    },
    {
      id: "openrouter",
      kind: "hosted_gateway",
      hosts: ["openrouter.ai"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/api/v1",
      auth: [{ scheme: "bearer" }],
      redirect: [{ kind: "env_var", client: "OpenAI SDK", names: ["OPENAI_BASE_URL"], companion: ["OPENAI_API_KEY"], verified: false, note: "UNVERIFIED: this lane has no network and the gateway was not in the redirect check." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, /api/v1 prefix and bearer auth are written from general knowledge, not from a run. Gemini through OpenRouter is the openai_compatible family.", "openrouter.ai is already on the hosted DNS firewall list."],
    },
    {
      id: "cloudflare-ai-gateway",
      kind: "hosted_gateway",
      hosts: ["gateway.ai.cloudflare.com"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1",
      auth: [{ scheme: "bearer" }, { scheme: "header", name: "cf-aig-authorization" }],
      redirect: [{ kind: "env_var", client: "OpenAI SDK", names: ["OPENAI_BASE_URL"], companion: ["OPENAI_API_KEY"], verified: false, note: "UNVERIFIED: the base URL has account and gateway segments after /v1 that belong to the customer; the readiness run reads them from the code." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, path shape and both auth headers are written from general knowledge, not from a run.", "The path carries the customer's account and gateway ids (/v1/<account>/<gateway>/...): the row holds the fixed prefix only."],
    },
    {
      id: "vercel-ai-gateway",
      kind: "hosted_gateway",
      hosts: ["ai-gateway.vercel.sh"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1",
      auth: [{ scheme: "bearer" }],
      redirect: [{ kind: "env_var", client: "OpenAI SDK", names: ["OPENAI_BASE_URL"], companion: ["OPENAI_API_KEY"], verified: false, note: "UNVERIFIED: this lane has no network and the gateway was not in the redirect check." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, /v1 prefix and bearer auth are written from general knowledge, not from a run."],
    },
    {
      id: "portkey",
      kind: "hosted_gateway",
      hosts: ["api.portkey.ai"],
      authHosts: [],
      family: "openai_compatible",
      pathPrefix: "/v1",
      auth: [{ scheme: "header", name: "x-portkey-api-key" }],
      redirect: [{ kind: "sdk_option", client: "OpenAI SDK", option: "base_url with default_headers for the Portkey key", needsRestTransport: false, verified: false, note: "UNVERIFIED: Portkey also needs its own headers (a provider or a virtual key); the redirect needs a config line, not only OPENAI_BASE_URL." }],
      streaming: ["sse"],
      errors: errorIds("openai_compatible"),
      notes: ["UNVERIFIED: host, /v1 prefix and the x-portkey-api-key header are written from general knowledge, not from a run."],
    },
  ],
} as const;

/** The built-in catalog, parsed under the strict schema on every call (a fresh object each time; nothing here is shared state). A bad row in this file throws here, and a test parses it. */
export function builtinModelCatalog(): ModelCatalog {
  return ModelCatalogSchema.parse(JSON.parse(JSON.stringify(BUILTIN_ROWS_DATA)));
}
