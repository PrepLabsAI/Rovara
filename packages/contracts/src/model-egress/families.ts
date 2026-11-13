// TE-F1a: the per-family rules for what a client may ask a provider for: the method, the path, the query keys and the headers (design 7, SSRF and header injection). The provider URL is built from the ROW: https, the row's exact
// host, port 443. The client supplies only a path and a query, and both are checked here against an allow list; a path that is on no list is `not_allowed`, a path of a shape no client sends is `bad_request`.
import type { ModelEgressRefusal } from "./refusals.js";
import type { ModelEgressFrame } from "./frame.js";
import { proxyHostName } from "./address.js";
import { SIGV4_NOT_RUN_SENTENCE, type ModelEgressConnection, type ModelEgressFamily, type ModelEgressRow } from "./schemes.js";

export const MODEL_EGRESS_PATH_MAX = 512;
export const MODEL_EGRESS_QUERY_MAX = 1024;
export const MODEL_EGRESS_HEADER_VALUE_MAX = 1024;

/** What the family's own headers add to the common three. */
const COMMON_HEADERS = ["content-type", "accept", "user-agent"] as const;
const FAMILY_HEADERS: Readonly<Record<ModelEgressFamily, readonly string[]>> = {
  openai_compatible: ["openai-beta"],
  anthropic_messages: ["anthropic-version", "anthropic-beta"],
  gemini: ["x-goog-api-client"],
  vertex: ["x-goog-api-client"],
  cohere: [],
  bedrock: [],
};
/** The outbound header allow list for a family: nothing else leaves, whatever the client sent. */
export const modelEgressAllowedHeaders = (family: ModelEgressFamily): readonly string[] => [...COMMON_HEADERS, ...FAMILY_HEADERS[family]];

const MODEL = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const GEMINI_OPS = "generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents";
const VERTEX_OPS = `${GEMINI_OPS}|predict|rawPredict|streamRawPredict`;
const VERSION = "v\\d{1,3}(?:[a-z]{1,8}\\d{0,3})?";
const GEMINI_PATH = new RegExp(`^/(${VERSION})/models/(${MODEL}):(${GEMINI_OPS})$`, "u");
const VERTEX_PROJECT_PATH = new RegExp(`^/(${VERSION})/projects/([a-z0-9][a-z0-9-]{3,60})/locations/([a-z0-9-]{1,40})/publishers/([a-z0-9-]{1,40})/models/(${MODEL}):(${VERTEX_OPS})$`, "u");
const VERTEX_EXPRESS_PATH = new RegExp(`^/(${VERSION})/publishers/([a-z0-9-]{1,40})/models/(${MODEL}):(${VERTEX_OPS})$`, "u");
const OPENAI_TAIL = /^(chat\/completions|responses|embeddings)$/u;
/** One API version segment (`v1`, `v1beta`, `v2`): the client's base URL decides whether it is sent; the proxy builds the provider path itself. */
const VERSION_SEGMENT = /^v\d{1,3}(?:[a-z]{1,8}\d{0,3})?$/u;
const ANTHROPIC_TAIL = /^(messages|messages\/count_tokens)$/u;
const COHERE_PATH = /^\/v[12]\/(chat|embed|rerank)$/u;
const AZURE_PATH = /^\/deployments\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/(chat\/completions|embeddings|completions|responses)$/u;

/** The characters a path may hold; every other one (a percent sign, a backslash, `@`, `;`, a space, a control or non-ASCII character) is refused before any rule looks at the path. */
const PATH_CHARACTERS = /^\/[A-Za-z0-9._~:/-]*$/u;
const CONTROL_OR_NON_ASCII = /[^\x21-\x7e]/u;

export type EgressRouteRefusal = { readonly ok: false; readonly refusal: ModelEgressRefusal; readonly notRun?: string };

/** The refusal for a path of a shape no client sends: `..`, encoded slashes (single or double encoded), `@`, a backslash, an absolute-form target, a second `?`, a control character, an over-long path. */
export function checkEgressPathSyntax(path: string): EgressRouteRefusal | undefined {
  if (path.length > MODEL_EGRESS_PATH_MAX) return { ok: false, refusal: "too_large" };
  if (CONTROL_OR_NON_ASCII.test(path)) return { ok: false, refusal: "bad_request" };
  // An absolute-form target (`http://host/...`) does not start with a slash; a scheme-relative one (`//host/...`) starts with two.
  if (!path.startsWith("/") || path.startsWith("//")) return { ok: false, refusal: "bad_request" };
  if (!PATH_CHARACTERS.test(path)) return { ok: false, refusal: "bad_request" };
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return { ok: false, refusal: "bad_request" };
  return undefined;
}

export interface EgressQueryOutcome {
  readonly ok: true;
  /** The allowed pairs, in order, spelled canonically (`$alt` stays `$alt`). The inbound `key` is already gone. */
  readonly pairs: ReadonlyArray<readonly [string, string]>;
}

const QUERY_VALUE = /^[A-Za-z0-9_-]{0,64}$/u;
/** The one query value with a `;` and an `=` in it: the legacy Gemini REST clients' `$alt=json;enum-encoding=int`. Spelled exactly, for `alt` and `$alt` only. */
const LEGACY_ALT_VALUE = "json;enum-encoding=int";

/**
 * The query as the proxy will send it. The inbound `key` (any case, any percent-encoding of its name, duplicates included) is removed: it is a credential. Only `alt` and `$alt` (Gemini and Vertex) and `api-version` (an Azure row, which
 * REQUIRES it equal to the row's) are allowed; any other key is `not_allowed`; a `?`, a `#`, a control character, a percent sign in a value, or a duplicate allowed key is `bad_request`.
 */
export function checkEgressQuery(row: Pick<ModelEgressRow, "family" | "azure">, query: string): EgressQueryOutcome | EgressRouteRefusal {
  if (query.length > MODEL_EGRESS_QUERY_MAX) return { ok: false, refusal: "too_large" };
  if (CONTROL_OR_NON_ASCII.test(query) && query !== "") return { ok: false, refusal: "bad_request" };
  if (query.includes("?") || query.includes("#")) return { ok: false, refusal: "bad_request" };
  const allowed = new Set<string>(row.family === "gemini" || row.family === "vertex" ? ["alt", "$alt"] : []);
  if (row.azure !== undefined) allowed.add("api-version");
  const pairs: Array<readonly [string, string]> = [];
  const seen = new Set<string>();
  if (query !== "") {
    for (const part of query.split("&")) {
      if (part === "") continue;
      const equals = part.indexOf("=");
      const rawName = equals === -1 ? part : part.slice(0, equals);
      const value = equals === -1 ? "" : part.slice(equals + 1);
      let name: string;
      try {
        name = decodeURIComponent(rawName);
      } catch {
        return { ok: false, refusal: "bad_request" };
      }
      if (name.toLowerCase() === "key") continue;
      if (!allowed.has(name)) return { ok: false, refusal: "not_allowed" };
      // `alt` and `$alt` are one parameter in two spellings: both together is two answers to one question.
      const group = name === "$alt" ? "alt" : name;
      if (!(QUERY_VALUE.test(value) || ((name === "alt" || name === "$alt") && value === LEGACY_ALT_VALUE)) || seen.has(group)) return { ok: false, refusal: "bad_request" };
      seen.add(group);
      pairs.push([name, value]);
    }
  }
  if (row.azure !== undefined) {
    const version = pairs.find(([name]) => name === "api-version");
    if (version === undefined || version[1] !== row.azure.apiVersion) return { ok: false, refusal: "not_allowed" };
  }
  return { ok: true, pairs };
}

export type EgressStreaming = "never" | "always" | "by_body";

export interface EgressRoute {
  readonly ok: true;
  /** The exact host the call goes to: the row's, or a Vertex row's host for the connected location. */
  readonly host: string;
  /** The provider path: the row's fixed prefix, then the checked client path. */
  readonly path: string;
  /** The family's operation name (`generateContent`, `chat/completions`, `messages`, ...). */
  readonly operation: string;
  /** The model the path names (Gemini, Vertex, an Azure deployment); undefined where the body names it. */
  readonly model: string | undefined;
  readonly streaming: EgressStreaming;
  /** The allowed query pairs. */
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly allowedHeaders: readonly string[];
}

/** The host of a row that names only a domain suffix (Azure OpenAI: the customer's own `<resource>.openai.azure.com`): it comes from the connected source, and must be a plain public name under a listed suffix. */
function suffixHost(row: Pick<ModelEgressRow, "hostSuffixes">, connection: ModelEgressConnection): string | undefined {
  const host = connection.host;
  if (host === undefined || proxyHostName(host) !== host) return undefined;
  return row.hostSuffixes.some((suffix) => host.endsWith(`.${suffix}`)) ? host : undefined;
}

const vertexHost = (location: string): string => (location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`);

/**
 * Whether a call may go to this row at all, and where. Checks, in order: the row is served (a Bedrock or `sigv4` row answers `not_allowed` with the not-run sentence), the method is `POST`, the path's shape, the query, and the
 * family's path allow list. A Vertex path must name the CONNECTED project and location: another project is `not_allowed`, even when a token could reach it. No client-supplied text reaches the host.
 */
export function routeEgressRequest(row: ModelEgressRow, connection: ModelEgressConnection, frame: Pick<ModelEgressFrame, "method" | "path" | "query">): EgressRoute | EgressRouteRefusal {
  if (row.family === "bedrock" || row.scheme === "sigv4") return { ok: false, refusal: "not_allowed", notRun: SIGV4_NOT_RUN_SENTENCE };
  if (frame.method !== "POST") return { ok: false, refusal: "not_allowed" };
  const syntax = checkEgressPathSyntax(frame.path);
  if (syntax !== undefined) return syntax;
  const query = checkEgressQuery(row, frame.query);
  if (!query.ok) return query;
  const refuse = (refusal: ModelEgressRefusal = "not_allowed"): EgressRouteRefusal => ({ ok: false, refusal });
  const prefix = row.pathPrefix;
  // A client may or may not send the row's own fixed prefix (it depends on the base URL it was given): it is removed when present and always added back by the proxy.
  const clientPath = prefix !== undefined && frame.path.startsWith(`${prefix}/`) ? frame.path.slice(prefix.length) : frame.path;
  const route = (host: string, operation: string, model: string | undefined, streaming: EgressStreaming, providerPath = `${prefix ?? ""}${clientPath}`): EgressRoute => ({
    ok: true,
    host,
    path: providerPath,
    operation,
    model,
    streaming,
    query: query.pairs,
    allowedHeaders: modelEgressAllowedHeaders(row.family),
  });
  const host = row.hosts[0] ?? suffixHost(row, connection);
  if (host === undefined) return refuse();

  switch (row.family) {
    case "gemini": {
      const match = GEMINI_PATH.exec(clientPath);
      if (match === null) return refuse();
      return route(host, match[3] as string, match[2], match[3] === "streamGenerateContent" ? "always" : "never");
    }
    case "vertex": {
      const project = VERTEX_PROJECT_PATH.exec(clientPath);
      if (project !== null) {
        const connected = connection.vertex;
        if (connected === undefined || project[2] !== connected.project || project[3] !== connected.location) return refuse();
        const target = vertexHost(connected.location);
        if (!row.hosts.includes(target)) return refuse();
        return route(target, project[6] as string, project[5], /^stream/u.test(project[6] as string) ? "always" : "never");
      }
      // The express form names no project: only a row that authenticates with a key may use it.
      const express = VERTEX_EXPRESS_PATH.exec(clientPath);
      if (express !== null && row.scheme === "header:x-goog-api-key" && row.hosts.includes("aiplatform.googleapis.com")) {
        return route("aiplatform.googleapis.com", express[4] as string, express[3], /^stream/u.test(express[4] as string) ? "always" : "never");
      }
      return refuse();
    }
    case "openai_compatible": {
      if (row.azure !== undefined) {
        const azurePrefix = prefix ?? "/openai";
        const rest = frame.path.startsWith(`${azurePrefix}/`) ? frame.path.slice(azurePrefix.length) : frame.path;
        const azure = AZURE_PATH.exec(rest);
        if (azure === null || azure[1] !== row.azure.deployment) return refuse();
        return route(host, azure[2] as string, azure[1], "by_body", `${azurePrefix}${rest}`);
      }
      // The provider path is built here: the row's prefix (OpenAI itself has none, and wants `/v1`), then the operation. The client's own version segment, if any, only has to be a version.
      const segments = clientPath.split("/").slice(1);
      const tail = (segments[0] !== undefined && VERSION_SEGMENT.test(segments[0]) ? segments.slice(1) : segments).join("/");
      const match = OPENAI_TAIL.exec(tail);
      return match === null ? refuse() : route(host, match[1] as string, undefined, "by_body", `${prefix ?? "/v1"}/${tail}`);
    }
    case "anthropic_messages": {
      // As OpenAI: the provider path is built here (`/v1` unless the row names its own prefix); the client may or may not send the prefix or a version segment.
      const segments = clientPath.split("/").slice(1);
      const tail = (segments[0] !== undefined && VERSION_SEGMENT.test(segments[0]) ? segments.slice(1) : segments).join("/");
      const match = ANTHROPIC_TAIL.exec(tail);
      return match === null ? refuse() : route(host, match[1] === "messages" ? "messages" : "count_tokens", undefined, "by_body", `${prefix ?? "/v1"}/${tail}`);
    }
    case "cohere": {
      const match = COHERE_PATH.exec(clientPath);
      return match === null ? refuse() : route(host, match[1] as string, undefined, "by_body");
    }
    default:
      return refuse();
  }
}
