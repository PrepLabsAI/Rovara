// Vertex AI (Gemini on Google Cloud) for the product route (DEC 229b): path parsing, the body guard and the provider transport.
// The body, the answer, the usage and the prices are Gemini's (product-gemini.ts): Vertex serves the same GenerateContent
// shape; a call is priced at the dearer of the AI Studio and Vertex rows of the model (product-route.ts alsoPricedAs).
// What differs: the host ({location}-aiplatform.googleapis.com, or aiplatform.googleapis.com for "global"), the path names the
// Google Cloud project and location, and the credential is a short-lived bearer token (product-vertex-token.ts). The project
// and location sent upstream come from the key store; a request naming another one is refused by the route.
import https from "node:https";
import type { ClientRequest } from "node:http";
import { record } from "./model-gateway-token.js";
import type { GuardFailure, ModelLimitsSource } from "./guard.js";
import { NotSentError, type ProviderTransport } from "./provider.js";
import type { RouteCall } from "./server.js";
import type { MediaPriceSource } from "./media-price.js";
import { GEMINI_MODEL, guardGemini } from "./product-gemini.js";
import { GCP_PROJECT, VERTEX_LOCATION } from "./product-vertex-credential.js";

export const VERTEX_VERSIONS = ["v1", "v1beta1"] as const;
export const VERTEX_HOST_GLOBAL = "aiplatform.googleapis.com";
export const vertexHost = (location: string): string => (location === "global" ? VERTEX_HOST_GLOBAL : `${location}-aiplatform.googleapis.com`);
export interface VertexPath { version: typeof VERTEX_VERSIONS[number]; project: string; location: string; model: string; streaming: boolean }
/**
 * The project and location Code's worker gives an eval sandbox's Vertex client (`GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`; Code's `EVAL_VERTEX_PLACEHOLDER`, packages/contracts/src/eval-discovery-report.ts). The worker does not know the
 * customer's connected pair, so under an eval stage's scope, and only there, the route reads exactly this pair as "the connected one". Both words pass `parseVertexPath` and are not real Google names. The upstream path is built from the key
 * store (`guardVertex`), never from the request, so this changes where a call GOES by nothing; a drift between the two repos' constants fails closed (400 not_allowed).
 */
export const EVAL_VERTEX_PLACEHOLDER = Object.freeze({ projectId: "rovara-eval-project", location: "rovara-eval1" });
/** Where the route sends a call: the key store's project and location. */
export interface VertexTarget { projectId: string; location: string }

/**
 * `/v1/product/vertex/{v1|v1beta1}/projects/{project}/locations/{location}/publishers/google/models/{model}:{generateContent|streamGenerateContent}`;
 * streaming requires `alt=sse` and no other query. Only Google's own models (another publisher is priced differently).
 * A project number parses here, and is then refused by the route unless it is the connected project id.
 */
export function parseVertexPath(path: string, query: string): VertexPath | undefined {
  const m = /^\/v1\/product\/vertex\/(v1|v1beta1)\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/u.exec(path);
  if (m === null) return undefined;
  const [, version, project, location, model, method] = m as unknown as [string, VertexPath["version"], string, string, string, string];
  if (!(GCP_PROJECT.test(project) || /^[0-9]{1,20}$/u.test(project)) || !VERTEX_LOCATION.test(location) || !GEMINI_MODEL.test(model)) return undefined;
  const streaming = method === "streamGenerateContent";
  if (streaming ? query !== "alt=sse" : query !== "") return undefined;
  return { version, project, location, model, streaming };
}
const bad = (): GuardFailure => ({ ok: false, status: 400, code: "invalid_request", message: "request not allowed" });
/** Google credential and identity headers the worker must have removed (beyond the Gemini guard's x-goog-api-key and x-goog-user-project). */
const GOOGLE_HEADER = /^x-goog-(?:iam-|authenticated-|user-project$|api-key$)/u;

/** The Gemini guard (same body rules, media rules, output ceiling) plus Vertex's: the upstream path from the key store, and a cached context in that project and location. */
export function guardVertex(bytes: Buffer, headers: Readonly<Record<string, string | undefined>>, path: VertexPath, target: VertexTarget, modelLimits: ModelLimitsSource, media?: MediaPriceSource): RouteCall | GuardFailure {
  if (Object.keys(headers).some((name) => GOOGLE_HEADER.test(name.toLowerCase()))) return bad();
  const checked = guardGemini(bytes, headers, { version: "v1", model: path.model, streaming: path.streaming }, modelLimits, media);
  if (!checked.ok) return checked;
  let cached: unknown;
  try { cached = record(JSON.parse(checked.bytes.toString("utf8")) as unknown)?.cachedContent; } catch { return bad(); }
  if (cached !== undefined && (typeof cached !== "string" || !cached.startsWith(`projects/${target.projectId}/locations/${target.location}/cachedContents/`) || !/^[A-Za-z0-9/_-]+$/u.test(cached))) return bad();
  return { ...checked, path: `/${path.version}/projects/${target.projectId}/locations/${target.location}/publishers/google/models/${path.model}:${path.streaming ? "streamGenerateContent?alt=sse" : "generateContent"}` };
}

const UPSTREAM = /^\/(?:v1|v1beta1)\/projects\/([a-z][a-z0-9-]{4,28}[a-z0-9])\/locations\/([a-z0-9-]{1,40})\/publishers\/google\/models\/[a-z0-9][a-z0-9.-]{0,95}:(?:generateContent|streamGenerateContent\?alt=sse)$/u;
/** The host is derived from the checked location only; TLS, port 443, one attempt, no redirects; the token as a bearer. */
export function createVertexTransport(request: typeof https.request = https.request): ProviderTransport {
  return async (input) => {
    if (input.signal.aborted) throw new NotSentError();
    const m = typeof input.path === "string" ? UPSTREAM.exec(input.path) : null;
    if (m === null || !VERTEX_LOCATION.test(m[2]!)) throw new NotSentError();
    const hostname = vertexHost(m[2]!);
    return new Promise((resolve, reject) => {
      let connected = false;
      const fail = () => reject(connected ? new Error("provider unavailable") : new NotSentError());
      let call: ClientRequest;
      try { call = request({ hostname, port: 443, path: input.path, method: "POST", agent: false, rejectUnauthorized: true, headers: { ...input.headers, authorization: `Bearer ${input.key}`, "content-length": String(input.body.byteLength) } }, (response) => {
        resolve({ status: response.statusCode ?? 0, body: response as AsyncIterable<Uint8Array>, cancel: () => response.destroy() });
      }); } catch { reject(new NotSentError()); return; }
      const abort = () => { call.destroy(); fail(); };
      call.once("socket", (socket) => socket.once("secureConnect", () => { connected = true; }));
      call.once("error", fail);
      call.once("close", () => input.signal.removeEventListener("abort", abort));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      else { try { call.end(input.body); } catch { call.destroy(); fail(); } }
    });
  };
}
