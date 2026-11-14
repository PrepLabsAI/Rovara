// TE-F1a: building the one outbound request. Every inbound credential is dropped FIRST (any header name that is, or could be read as, a credential, in any case, with duplicates and line folding; and the `key` query parameter),
// then only an allow list of headers is kept, then EXACTLY ONE credential is added, as the row's scheme says. The secret arrives as an argument and is never stored here.
import { hasExternalInput, maxOutputFieldOf, requestedMaxOutputTokens, withDefaultMaxOutput } from "./cost.js";
import type { ModelEgressFrame } from "./frame.js";
import { MODEL_EGRESS_HEADER_VALUE_MAX, routeEgressRequest, type EgressRoute } from "./families.js";
import type { ModelEgressRefusal } from "./refusals.js";
import { isTokenScheme, type ModelEgressConnection, type ModelEgressRow, type ModelEgressScheme } from "./schemes.js";

/** Header names that carry a credential, exactly. */
const CREDENTIAL_NAMES = new Set(["authorization", "x-api-key", "x-goog-api-key", "api-key", "x-goog-user-project", "cookie", "cookie2"]);

/** A header name as a lenient reader would compare it: whitespace, control characters and colons gone, lower case. A name with a fold (`authorization\r\n x`) reads as `authorization`. */
export function normalizeHeaderName(name: string): string {
  let kept = "";
  for (const character of name.replace(/[\s:]/gu, "")) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) kept += character;
  }
  return kept.toLowerCase();
}

/** Whether an inbound header could carry a credential: a known credential header, `proxy-*`, any `x-amz-*`, or any name that mentions authorization, an api key or a cookie. Over-broad on purpose: a false positive drops a header nobody needs. */
export function isInboundCredentialHeader(name: string): boolean {
  const normal = normalizeHeaderName(name);
  return CREDENTIAL_NAMES.has(normal) || normal.startsWith("proxy-") || normal.startsWith("x-amz-") || normal.includes("authorization") || normal.includes("api-key") || normal.includes("apikey") || normal.includes("cookie");
}

/** Every inbound credential header removed; what is left is not yet checked against the allow list. */
export function dropInboundCredentials(headers: ReadonlyArray<readonly [string, string]>): Array<[string, string]> {
  return headers.filter(([name]) => !isInboundCredentialHeader(name)).map(([name, value]) => [name, value]);
}

const TOKEN_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const BAD_VALUE = /[^\x20-\x7e]/u;

export interface OutboundRequest {
  /** The exact host (the row's, or a Vertex row's for the connected location). Always port 443 over https. */
  readonly host: string;
  readonly method: "POST";
  readonly path: string;
  /** The query string without its `?`, credential included for the `query:key` scheme. */
  readonly query: string;
  /** Lower-case names, each once. Includes exactly one credential (or, for `query:key`, none: the key is in the query). */
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
}

export type BuildOutcome =
  | {
      readonly ok: true;
      readonly request: OutboundRequest;
      readonly route: EgressRoute;
      /** The maximum output the request carries (the client's, or the row's default the proxy set), for the reservation. */
      readonly maxOutputTokens: number | undefined;
      /** The request names a file or cached content: reserve for input the body does not hold. */
      readonly externalInput: boolean;
    } | { readonly ok: false; readonly refusal: ModelEgressRefusal; readonly notRun?: string };

/** The refused words for a secret the core cannot place: empty, too long, or holding a control character (it would be a header injection). Never echoes the secret. */
export function assertPlaceableSecret(secret: string): void {
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 4096 || BAD_VALUE.test(secret)) throw new RangeError("the credential cannot be placed in a request");
}

/** The credential a scheme adds, as a header or as a query pair. */
function credentialFor(scheme: ModelEgressScheme, secret: string): { readonly header?: readonly [string, string]; readonly query?: string } {
  if (scheme === "bearer" || isTokenScheme(scheme)) return { header: ["authorization", `Bearer ${secret}`] };
  if (scheme === "query:key") return { query: `key=${encodeURIComponent(secret)}` };
  if (scheme === "header:x-goog-api-key" || scheme === "header:x-api-key" || scheme === "header:api-key") return { header: [scheme.slice("header:".length), secret] };
  // `sigv4` never gets here: the route refuses it first.
  throw new RangeError("this scheme cannot be placed by the proxy");
}

/**
 * The outbound request for one frame, or the refusal. In order: route and check the frame (`families.ts`), drop every inbound credential, keep only the family's allow-listed headers (a value with a control character or over 1 KB, a
 * header written with a fold, or a duplicate allowed header refuses the call, `bad_request`), then add exactly one credential. A JSON body gets the row's default maximum output spliced into its own text when it names none (every other byte is the client's). `secret` is the key (or the minted token) for this call; it is placed and not kept.
 */
export function buildOutboundRequest(row: ModelEgressRow, connection: ModelEgressConnection, frame: ModelEgressFrame, secret: string): BuildOutcome {
  const routed = routeEgressRequest(row, connection, frame);
  if (!routed.ok) return routed;
  assertPlaceableSecret(secret);
  const allowed = new Set(routed.allowedHeaders);
  const kept = new Map<string, string>();
  for (const [name, value] of dropInboundCredentials(frame.headers)) {
    const lower = name.toLowerCase();
    if (normalizeHeaderName(name) !== lower || !TOKEN_NAME.test(lower)) {
      // A name written with whitespace or a fold is dropped unless it names an allowed header, in which case it is an injection attempt.
      if (allowed.has(normalizeHeaderName(name))) return { ok: false, refusal: "bad_request" };
      continue;
    }
    if (!allowed.has(lower)) continue;
    if (BAD_VALUE.test(value) || value.length > MODEL_EGRESS_HEADER_VALUE_MAX || kept.has(lower)) return { ok: false, refusal: "bad_request" };
    kept.set(lower, value);
  }
  const credential = credentialFor(row.scheme, secret);
  const headers: Array<readonly [string, string]> = [...kept.entries()];
  // Responses are read as plain text (the key-echo scan cannot look inside a compressed body).
  headers.push(["accept-encoding", "identity"]);
  if (credential.header !== undefined) headers.push(credential.header);
  const pairs = routed.query.map(([name, value]) => `${name}=${value}`);
  if (credential.query !== undefined) pairs.push(credential.query);
  // The row's default maximum output is set when the request names none (the reservation and the provider's limit are then the same number); the number priced is the number the provider reads.
  const prepared = withDefaultMaxOutput(row.family, routed.operation, frame.body, row.defaultMaxOutputTokens, maxOutputFieldOf(row));
  return {
    ok: true,
    route: routed,
    maxOutputTokens: requestedMaxOutputTokens(row.family, prepared.body),
    externalInput: hasExternalInput(prepared.body),
    request: { host: routed.host, method: "POST", path: routed.path, query: pairs.join("&"), headers, body: prepared.body },
  };
}

/** How many credentials a request carries: credential-named headers plus a `key` query pair. A built request has exactly one. */
export function countCredentials(request: Pick<OutboundRequest, "headers" | "query">): number {
  const headerCount = request.headers.filter(([name]) => isInboundCredentialHeader(name)).length;
  const queryCount = request.query.split("&").filter((pair) => decodeURIComponent(pair.split("=")[0] ?? "").toLowerCase() === "key").length;
  return headerCount + queryCount;
}
