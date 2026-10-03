// Spec 055 phase 2: discovering a generic MCP server's sign-in (RFC 9728, RFC 8414), registering
// AgentX as its client (RFC 7591), and `authorize --endpoint` registering a pinned credential.
import { describe, expect, it, vi } from "vitest";
import { CredentialRegistrationSchema } from "../../packages/contracts/src/index.js";
import { authorizeCredential, GENERIC_REDIRECT_URI, type AuthorizeSecrets } from "../../packages/cli/src/admin/authorize.js";
import { bearerChallenge, discoverOAuth, registerClient } from "../../packages/cli/src/admin/oauth-discovery.js";

const ENDPOINT = "https://mcp.vendor.example/mcp";
const PRM_URL = "https://mcp.vendor.example/.well-known/oauth-protected-resource/mcp";
const ISSUER = "https://auth.vendor.example";
const AS_URL = "https://auth.vendor.example/.well-known/oauth-authorization-server";
const CONTROL_PLANE = "https://agentx.example.test";

const prm = (overrides: Record<string, unknown> = {}) => ({ resource: ENDPOINT, authorization_servers: [ISSUER], scopes_supported: ["read", "write"], ...overrides });
const asMetadata = (overrides: Record<string, unknown> = {}) => ({
  issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, registration_endpoint: `${ISSUER}/register`,
  code_challenge_methods_supported: ["S256"], ...overrides,
});

/** A vendor that serves the given URLs; every other URL is a 404. Records each request. */
function vendor(routes: Record<string, () => Response>) {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
    requests.push({ url: href, init });
    const route = routes[href];
    return route ? route() : new Response("not found", { status: 404 });
  });
  return { fetchImplementation, requests };
}
const unauthorized = (header?: string) => () => new Response("", { status: 401, headers: header === undefined ? {} : { "www-authenticate": header } });

describe("bearer challenge", () => {
  it("reads resource_metadata and scope, and nothing else", () => {
    expect(bearerChallenge('Bearer realm="x", resource_metadata="https://mcp.vendor.example/.well-known/oauth-protected-resource", scope="read write"'))
      .toEqual({ resourceMetadata: "https://mcp.vendor.example/.well-known/oauth-protected-resource", scopes: ["read", "write"] });
    expect(bearerChallenge('Bearer error="invalid_token"')).toEqual({});
    expect(bearerChallenge(null)).toEqual({});
  });
});

describe("OAuth discovery", () => {
  it("follows the 401 challenge to the resource metadata, then the authorization server's metadata", async () => {
    const { fetchImplementation, requests } = vendor({
      [ENDPOINT]: unauthorized(`Bearer resource_metadata="https://mcp.vendor.example/prm.json", scope="issues:read"`),
      "https://mcp.vendor.example/prm.json": () => Response.json(prm()),
      [AS_URL]: () => Response.json(asMetadata()),
    });
    expect(await discoverOAuth(new URL(ENDPOINT), fetchImplementation)).toEqual({
      resource: ENDPOINT, issuer: ISSUER, authorizeUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token`, registrationUrl: `${ISSUER}/register`, scopes: ["issues:read"],
    });
    expect(requests.every((request) => request.init?.redirect === "error")).toBe(true);
    expect(requests[0]!.init).toMatchObject({ method: "POST" });
    expect(new Headers(requests[0]!.init?.headers).get("authorization")).toBeNull();
  });

  it("falls back to the well-known locations, path-inserted first, and to OpenID configuration", async () => {
    const { fetchImplementation, requests } = vendor({
      [ENDPOINT]: () => new Response("", { status: 405 }),
      "https://mcp.vendor.example/.well-known/oauth-protected-resource": () => Response.json(prm({ authorization_servers: [`${ISSUER}/tenant`] })),
      [`${ISSUER}/.well-known/openid-configuration/tenant`]: () => Response.json(asMetadata({ issuer: `${ISSUER}/tenant` })),
    });
    const found = await discoverOAuth(new URL(ENDPOINT), fetchImplementation);
    expect(found).toMatchObject({ issuer: `${ISSUER}/tenant`, scopes: ["read", "write"] });
    expect(requests.map((request) => request.url)).toEqual([
      ENDPOINT, PRM_URL, "https://mcp.vendor.example/.well-known/oauth-protected-resource",
      `${ISSUER}/.well-known/oauth-authorization-server/tenant`, `${ISSUER}/.well-known/oauth-authorization-server`, `${ISSUER}/.well-known/openid-configuration/tenant`,
    ]);
  });

  it.each([
    ["no resource metadata", {}, "mcp.vendor.example publishes no OAuth protected resource metadata"],
    ["metadata for another resource", { [PRM_URL]: () => Response.json(prm({ resource: "https://mcp.vendor.example/other" })) }, "describes https://mcp.vendor.example/other"],
    ["metadata for another origin", { [PRM_URL]: () => Response.json(prm({ resource: "https://evil.example/mcp" })) }, "describes https://evil.example/mcp"],
    ["no authorization server", { [PRM_URL]: () => Response.json(prm({ authorization_servers: [] })) }, "names no authorization server"],
    ["a plain-http authorization server", { [PRM_URL]: () => Response.json(prm({ authorization_servers: ["http://auth.vendor.example"] })) }, "must be a plain https URL"],
    ["no server metadata", { [PRM_URL]: () => Response.json(prm()) }, "publishes no OAuth metadata"],
    ["a different issuer", { [PRM_URL]: () => Response.json(prm()), [AS_URL]: () => Response.json(asMetadata({ issuer: "https://evil.example" })) }, "names a different issuer"],
    ["no PKCE S256", { [PRM_URL]: () => Response.json(prm()), [AS_URL]: () => Response.json(asMetadata({ code_challenge_methods_supported: ["plain"] })) }, "does not list PKCE S256 support"],
    ["a token endpoint on an IP address", { [PRM_URL]: () => Response.json(prm()), [AS_URL]: () => Response.json(asMetadata({ token_endpoint: "https://10.0.0.5/token" })) }, "token endpoint host must be a DNS name"],
  ])("refuses %s", async (_case, routes, message) => {
    const { fetchImplementation } = vendor({ [ENDPOINT]: unauthorized(), ...routes as Record<string, () => Response> });
    await expect(discoverOAuth(new URL(ENDPOINT), fetchImplementation)).rejects.toThrow(message);
  });

  it("refuses a challenge that points its metadata at plain http", async () => {
    const { fetchImplementation } = vendor({ [ENDPOINT]: unauthorized('Bearer resource_metadata="http://mcp.vendor.example/prm"') });
    await expect(discoverOAuth(new URL(ENDPOINT), fetchImplementation)).rejects.toThrow("must be a plain https URL");
  });
});

describe("dynamic client registration", () => {
  it("registers for the localhost redirect, as a confidential or a public client", async () => {
    const confidential = vendor({ [`${ISSUER}/register`]: () => Response.json({ client_id: "c1", client_secret: "s1" }, { status: 201 }) });
    expect(await registerClient(`${ISSUER}/register`, GENERIC_REDIRECT_URI, confidential.fetchImplementation)).toEqual({ clientId: "c1", clientSecret: "s1" });
    expect(JSON.parse(confidential.requests[0]!.init?.body as string)).toMatchObject({ client_name: "AgentX", redirect_uris: [GENERIC_REDIRECT_URI], grant_types: ["authorization_code", "refresh_token"] });
    const publicClient = vendor({ [`${ISSUER}/register`]: () => Response.json({ client_id: "c2", token_endpoint_auth_method: "none" }, { status: 201 }) });
    expect(await registerClient(`${ISSUER}/register`, GENERIC_REDIRECT_URI, publicClient.fetchImplementation)).toEqual({ clientId: "c2" });
    const refused = vendor({ [`${ISSUER}/register`]: () => Response.json({ error: "invalid_redirect_uri" }, { status: 400 }) });
    await expect(registerClient(`${ISSUER}/register`, GENERIC_REDIRECT_URI, refused.fetchImplementation)).rejects.toThrow("refused to register AgentX as a client (HTTP 400 (invalid_redirect_uri))");
  });
});

describe("authorize --endpoint", () => {
  function secretsWith(value: string | undefined): AuthorizeSecrets & { writes: Array<[string, string]> } {
    const store = {
      writes: [] as Array<[string, string]>,
      read: vi.fn(async () => value),
      write: vi.fn(async (name: string, next: string) => { store.writes.push([name, next]); }),
      tag: vi.fn(async () => undefined),
    };
    return store;
  }

  /** The vendor's discovery, registration and token endpoints, and the control plane, behind one fetch. */
  function world(options: { registration?: Record<string, unknown> } = {}) {
    const exchanges: Array<Record<string, string>> = [];
    const registrations: unknown[] = [];
    const routes: Record<string, (init?: RequestInit) => Response> = {
      [ENDPOINT]: unauthorized(`Bearer resource_metadata="${PRM_URL}"`),
      [PRM_URL]: () => Response.json(prm()),
      [AS_URL]: () => Response.json(asMetadata()),
      [`${ISSUER}/register`]: () => Response.json(options.registration ?? { client_id: "dyn-client" }, { status: 201 }),
      [`${ISSUER}/token`]: (init) => { exchanges.push(Object.fromEntries(new URLSearchParams(init?.body as string))); return Response.json({ access_token: "a", refresh_token: "r-1", expires_in: 3600 }); },
      [`${CONTROL_PLANE}/v1/admin/credentials`]: (init) => { registrations.push(JSON.parse(init?.body as string)); return Response.json({ credential: { ref: "vendor-bot" }, replaced: false }, { status: 201 }); },
    };
    const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
      const href = url instanceof URL ? url.href : typeof url === "string" ? url : url.url;
      const route = routes[href];
      return route ? route(init) : new Response("not found", { status: 404 });
    });
    return { fetchImplementation, exchanges, registrations };
  }

  /** Plays the browser: answers the local listener with the state it was given and a code. */
  function browser() {
    let port = 0;
    const seen: URL[] = [];
    return {
      seen,
      onListening: (bound: number) => { port = bound; },
      openBrowser: async (url: string) => {
        const authorize = new URL(url);
        seen.push(authorize);
        await (await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=${authorize.searchParams.get("state")!}`)).text();
      },
    };
  }

  const base = (secrets: AuthorizeSecrets, fetchImplementation: typeof fetch, play: ReturnType<typeof browser>) => ({
    controlPlaneUrl: CONTROL_PLANE, accessToken: "admin-token", ref: "vendor-bot", secretName: "agentx/connectors/vendor-bot",
    secrets, fetchImplementation, openBrowser: play.openBrowser, onListening: play.onListening, listenPort: 0, showUrl: () => undefined,
  });

  it("discovers the sign-in, registers a public client, and registers the credential pinned with its token URL and resource", async () => {
    const { fetchImplementation, exchanges, registrations } = world();
    const secrets = secretsWith("{}");
    const play = browser();
    await authorizeCredential({ ...base(secrets, fetchImplementation, play), endpoint: ENDPOINT, registerClient: true });
    const authorize = play.seen[0]!;
    expect(authorize.origin + authorize.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      client_id: "dyn-client", redirect_uri: GENERIC_REDIRECT_URI, code_challenge_method: "S256", resource: ENDPOINT, scope: "read write",
    });
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({ grant_type: "authorization_code", code: "the-code", client_id: "dyn-client", resource: ENDPOINT });
    expect(exchanges[0]).not.toHaveProperty("client_secret");
    expect(secrets.writes).toEqual([["agentx/connectors/vendor-bot", JSON.stringify({ clientId: "dyn-client", refreshToken: "r-1" })]]);
    expect(registrations).toEqual([{
      ref: "vendor-bot", type: "oauth-refresh-token", secretName: "agentx/connectors/vendor-bot",
      host: "mcp.vendor.example", tokenUrl: `${ISSUER}/token`, resource: ENDPOINT,
    }]);
  });

  it("uses the secret's own client and given endpoints without discovery", async () => {
    const { fetchImplementation, exchanges, registrations } = world();
    const play = browser();
    await authorizeCredential({
      ...base(secretsWith(JSON.stringify({ clientId: "own", clientSecret: "own-secret" })), fetchImplementation, play),
      endpoint: ENDPOINT, authorizeUrl: `${ISSUER}/authorize`, tokenUrl: `${ISSUER}/token`, scope: "issues:read",
    });
    expect(fetchImplementation.mock.calls.map(([url]) => (url instanceof Request ? url.url : url instanceof URL ? url.href : url))).not.toContain(PRM_URL);
    expect(play.seen[0]!.searchParams.get("scope")).toBe("issues:read");
    expect(exchanges[0]).toMatchObject({ client_id: "own", client_secret: "own-secret", resource: ENDPOINT });
    expect(registrations[0]).toMatchObject({ host: "mcp.vendor.example", tokenUrl: `${ISSUER}/token`, resource: ENDPOINT });
  });

  it.each([
    [{ provider: "asana", endpoint: ENDPOINT }, "give exactly one of --provider"],
    [{}, "give exactly one of --provider"],
    [{ endpoint: "http://mcp.vendor.example/mcp" }, "--endpoint: endpoint must use https"],
    [{ endpoint: ENDPOINT, authorizeUrl: `${ISSUER}/authorize` }, "give both --authorize-url and --token-url"],
    [{ provider: "asana", registerClient: true }, "go with --endpoint, not --provider"],
    [{ endpoint: ENDPOINT, authorizeUrl: `${ISSUER}/authorize`, tokenUrl: "https://10.0.0.1/token" }, "invalid credential registration: tokenUrl host must be a DNS name"],
  ])("refuses %j before any sign-in", async (options, message) => {
    const { fetchImplementation } = world();
    const play = browser();
    await expect(authorizeCredential({ ...base(secretsWith("{}"), fetchImplementation, play), ...options })).rejects.toThrow(message);
    expect(play.seen).toEqual([]);
  });

  it("asks for an existing secret before registering a client", async () => {
    const { fetchImplementation } = world();
    await expect(authorizeCredential({ ...base(secretsWith(undefined), fetchImplementation, browser()), endpoint: ENDPOINT, registerClient: true }))
      .rejects.toThrow("secret agentx/connectors/vendor-bot was not found; create it first (its value can be {})");
    expect(fetchImplementation.mock.calls.map(([url]) => (url instanceof Request ? url.url : url instanceof URL ? url.href : url))).not.toContain(`${ISSUER}/register`);
  });
});

describe("credential registration with OAuth fields", () => {
  const oauth = { ref: "vendor-bot", type: "oauth-refresh-token", secretName: "agentx/connectors/vendor-bot" };
  it("allows a token URL and resource on OAuth credentials only, each a public https URL", () => {
    expect(CredentialRegistrationSchema.safeParse({ ...oauth, host: "mcp.vendor.example", tokenUrl: `${ISSUER}/token`, resource: ENDPOINT }).success).toBe(true);
    expect(CredentialRegistrationSchema.safeParse({ ...oauth, type: "static-secret", tokenUrl: `${ISSUER}/token` }).error?.issues[0]?.message).toBe("tokenUrl applies only to OAuth credentials");
    for (const tokenUrl of ["http://auth.vendor.example/token", "https://169.254.169.254/token", "https://auth.vendor.internal/token", "https://auth.vendor.example/token?x=1"]) {
      expect(CredentialRegistrationSchema.safeParse({ ...oauth, tokenUrl }).success).toBe(false);
    }
  });
});
