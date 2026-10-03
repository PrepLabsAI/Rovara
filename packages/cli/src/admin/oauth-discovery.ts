// Spec 055 phase 2: how an MCP server says where to sign in, so `agentx admin credential authorize
// --endpoint` needs no vendor profile. RFC 9728 (protected resource metadata), RFC 8414
// (authorization server metadata) and RFC 7591 (dynamic client registration), as the MCP
// authorization specification uses them. Nothing here sends a credential.
import { agentXError, publicHttpsUrlProblem } from "@agentx/contracts";
import { readLimitedText } from "@agentx/gateway";

const TIMEOUT_MS = 10_000;
const MAX_METADATA = 65_536;
const MAX_SCOPES = 32;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

/** Where to sign a bot user in for one MCP server, and what to ask for. */
export interface DiscoveredOAuth {
  /** The RFC 8707 resource indicator: the server's own `resource` from its metadata. */
  resource: string;
  issuer: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Present when the server lets AgentX register its own client (RFC 7591). */
  registrationUrl?: string;
  /** Scopes the server asked for (WWW-Authenticate) or lists, possibly none. */
  scopes: string[];
}

type Fetch = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** An https URL the browser or CLI may call, as the server spelled it; the token URL also gets the stricter public-URL check. */
function httpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw agentXError("CONFIG_INVALID", `the server's OAuth metadata has no ${label}`);
  let url: URL;
  try { url = new URL(value); } catch { throw agentXError("CONFIG_INVALID", `the server's OAuth metadata gives an invalid ${label}`); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw agentXError("CONFIG_INVALID", `the server's ${label} must be a plain https URL, not ${url.origin}`);
  // The server's own spelling: an issuer and an RFC 8707 resource are compared exactly, so URL
  // normalisation (a trailing slash added to a bare origin) would change them.
  return value;
}

/** GET (or the given request) as JSON, at most MAX_METADATA bytes, never following a redirect. Undefined on a non-2xx answer. */
async function fetchJson(fetchImplementation: Fetch, url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach ${new URL(url).origin} to discover how to sign in; check the endpoint and this computer's network access`);
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); return undefined; }
  try { return JSON.parse(await readLimitedText(response, MAX_METADATA)) as unknown; } catch { return undefined; }
}

/** The `resource_metadata` and `scope` parameters of a Bearer WWW-Authenticate challenge. */
export function bearerChallenge(header: string | null): { resourceMetadata?: string; scopes?: string[] } {
  if (header === null) return {};
  const found: Record<string, string> = {};
  for (const match of header.matchAll(/\b(resource_metadata|scope)="([^"]{0,2048})"/g)) found[match[1]!] ??= match[2]!;
  return {
    ...(found.resource_metadata === undefined ? {} : { resourceMetadata: found.resource_metadata }),
    ...(found.scope === undefined ? {} : { scopes: found.scope.split(" ").filter((scope) => scope !== "") }),
  };
}

/** Well-known metadata URLs, path-inserted first (RFC 8414 §3.1, RFC 9728 §3.1), then at the root. */
function wellKnown(base: URL, suffix: string): string[] {
  const path = base.pathname.replace(/\/$/, "");
  const inserted = `${base.origin}/.well-known/${suffix}${path}`;
  const root = `${base.origin}/.well-known/${suffix}`;
  return path === "" ? [root] : [inserted, root];
}

function sameWithoutSlash(left: string, right: string): boolean {
  return left.replace(/\/$/, "") === right.replace(/\/$/, "");
}

/**
 * Asks the MCP server where to sign in. It answers an unauthenticated request with 401 and a Bearer
 * challenge naming its protected resource metadata; without one, the well-known locations are
 * tried. The metadata must describe this endpoint, and its authorization server must support
 * PKCE S256, as MCP requires.
 */
export async function discoverOAuth(endpoint: URL, fetchImplementation: Fetch = fetch): Promise<DiscoveredOAuth> {
  let challenge: ReturnType<typeof bearerChallenge> = {};
  try {
    const probe = await fetchImplementation(endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentx", version: "0.1.0" } } }),
    });
    await probe.body?.cancel().catch(() => undefined);
    if (probe.status === 401) challenge = bearerChallenge(probe.headers.get("www-authenticate"));
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach ${endpoint.origin}; check the endpoint and this computer's network access`);
  }

  const candidates = challenge.resourceMetadata !== undefined ? [httpsUrl(challenge.resourceMetadata, "resource metadata URL")] : wellKnown(endpoint, "oauth-protected-resource");
  let metadata: Record<string, unknown> | undefined;
  for (const url of candidates) {
    const body = await fetchJson(fetchImplementation, url);
    if (isRecord(body)) { metadata = body; break; }
  }
  if (metadata === undefined) {
    throw agentXError("CONFIG_INVALID", `${endpoint.host} publishes no OAuth protected resource metadata, so its sign-in cannot be discovered; pass --authorize-url and --token-url, or register a static-secret credential`);
  }
  const resource = httpsUrl(metadata.resource, "resource");
  const resourceUrl = new URL(resource);
  if (resourceUrl.origin !== endpoint.origin || !endpoint.href.replace(/\/$/, "").startsWith(resource.replace(/\/$/, ""))) {
    throw agentXError("CONFIG_INVALID", `the server's metadata describes ${resource}, not ${endpoint.href}, so AgentX does not use it`);
  }
  const servers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers : [];
  if (servers.length === 0) throw agentXError("CONFIG_INVALID", `${endpoint.host} names no authorization server in its metadata`);
  const issuer = httpsUrl(servers[0], "authorization server");

  const issuerUrl = new URL(issuer);
  const serverCandidates = [
    ...wellKnown(issuerUrl, "oauth-authorization-server"),
    ...wellKnown(issuerUrl, "openid-configuration"),
    ...(issuerUrl.pathname.replace(/\/$/, "") === "" ? [] : [`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`]),
  ];
  let server: Record<string, unknown> | undefined;
  for (const url of [...new Set(serverCandidates)]) {
    const body = await fetchJson(fetchImplementation, url);
    if (isRecord(body)) { server = body; break; }
  }
  if (server === undefined) throw agentXError("CONFIG_INVALID", `the authorization server ${issuerUrl.host} publishes no OAuth metadata; pass --authorize-url and --token-url`);
  if (typeof server.issuer !== "string" || !sameWithoutSlash(server.issuer, issuer)) {
    throw agentXError("CONFIG_INVALID", `the authorization server's metadata names a different issuer than ${issuer}, so AgentX does not use it`);
  }
  const methods = Array.isArray(server.code_challenge_methods_supported) ? server.code_challenge_methods_supported : [];
  if (!methods.includes("S256")) throw agentXError("CONFIG_INVALID", `the authorization server ${issuerUrl.host} does not list PKCE S256 support, which AgentX requires`);
  const authorizeUrl = httpsUrl(server.authorization_endpoint, "authorization endpoint");
  const tokenUrl = httpsUrl(server.token_endpoint, "token endpoint");
  const tokenProblem = publicHttpsUrlProblem(tokenUrl, "token endpoint");
  if (tokenProblem !== undefined) throw agentXError("CONFIG_INVALID", `the server's ${tokenProblem}`);
  const registrationUrl = server.registration_endpoint === undefined ? undefined : httpsUrl(server.registration_endpoint, "registration endpoint");

  const listed = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter((scope): scope is string => typeof scope === "string") : [];
  const scopes = (challenge.scopes ?? listed).filter((scope) => SCOPE.test(scope)).slice(0, MAX_SCOPES);
  return { resource, issuer, authorizeUrl, tokenUrl, ...(registrationUrl === undefined ? {} : { registrationUrl }), scopes };
}

/**
 * Registers AgentX as an OAuth client of the server (RFC 7591), for the localhost redirect the sign-in
 * listens on. The server may issue a secret (a confidential client) or none (a public client).
 */
export async function registerClient(registrationUrl: string, redirectUri: string, fetchImplementation: Fetch = fetch): Promise<{ clientId: string; clientSecret?: string }> {
  let response: Response;
  try {
    response = await fetchImplementation(registrationUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "AgentX", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "client_secret_post",
      }),
    });
  } catch {
    throw agentXError("RUNTIME_UNAVAILABLE", `could not reach ${new URL(registrationUrl).origin} to register AgentX as a client`);
  }
  let body: unknown;
  try { body = JSON.parse(await readLimitedText(response, MAX_METADATA)) as unknown; } catch { body = undefined; }
  if (!response.ok || !isRecord(body) || typeof body.client_id !== "string" || body.client_id === "" || body.client_id.length > 1_024) {
    const code = isRecord(body) && typeof body.error === "string" && /^[a-z_]{1,64}$/.test(body.error) ? ` (${body.error})` : "";
    throw agentXError("CONFIG_INVALID", `the server refused to register AgentX as a client (HTTP ${response.status}${code}); create an OAuth app yourself and store its client in the secret`);
  }
  const secret = typeof body.client_secret === "string" && body.client_secret !== "" && body.client_secret.length <= 8_192 ? body.client_secret : undefined;
  return { clientId: body.client_id, ...(secret === undefined ? {} : { clientSecret: secret }) };
}
