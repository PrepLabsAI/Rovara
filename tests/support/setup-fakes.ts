// Fakes for the setup modules (phase 15d2). Nothing here reaches AWS, a vendor or the control plane.
import type { StoredTokens, TokenStore } from "../../packages/cli/src/token-store.js";
import type { CognitoAdmin, SetupServices } from "../../packages/cli/src/setup/services.js";

export const CONTROL_PLANE = "https://cp.example.test";
export const ADMIN_EMAIL = "alice@example.com";

/** A JWT-shaped token (unsigned) with the given payload: the CLI only reads claims, never verifies. */
export function accessToken(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(payload)}.sig`;
}

export function memoryTokenStore(initial: Record<string, StoredTokens> = {}): TokenStore & { values: Map<string, StoredTokens> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key) => values.get(key),
    set: async (key, tokens) => { values.set(key, tokens); },
    delete: async (key) => { values.delete(key); },
  };
}

export function fakeCognito(users: Record<string, string> = {}): CognitoAdmin & { created: string[]; grouped: string[] } {
  const status = new Map(Object.entries(users));
  const created: string[] = [];
  const grouped: string[] = [];
  return {
    created, grouped,
    userStatus: async (_pool, username) => status.get(username),
    createUser: async (_pool, email) => { created.push(email); status.set(email, "FORCE_CHANGE_PASSWORD"); },
    addToGroup: async (_pool, username, group) => { grouped.push(`${username}:${group}`); },
  };
}

export interface FakeControlPlane {
  fetch: typeof fetch;
  requests: Array<{ method: string; path: string; body?: unknown; token?: string }>;
  /** Answer GET /v1/admin/credentials with 403 for this token. */
  forbidden: Set<string>;
  credentials: Array<Record<string, unknown>>;
  registered: unknown[];
  /** The preflight each registration answers with, by connector name. */
  preflight: Record<string, { status: "connected" | "not_connected" | "unavailable"; problem?: string }>;
  bindings: string[];
  turns: unknown[];
}

/** Serves the admin routes the setup modules call, in memory. */
export function fakeControlPlane(): FakeControlPlane {
  const plane: FakeControlPlane = {
    requests: [], forbidden: new Set(), registered: [], preflight: {}, bindings: [], turns: [],
    credentials: [{ ref: "github-agentx-sdlc", type: "github-app", secretName: "agentx/staging/github-app", builtIn: true, tokenCached: false }],
    fetch: async (url, init) => {
      const parsed = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
      const method = init?.method ?? "GET";
      const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace(/^Bearer /, "");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      plane.requests.push({ method, path: parsed.pathname, ...(body === undefined ? {} : { body }), ...(token === undefined ? {} : { token }) });
      const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (token !== undefined && plane.forbidden.has(token)) return json(403, { error: { code: "FORBIDDEN", message: "administrator role required" } });
      if (parsed.pathname === "/v1/admin/credentials" && method === "GET") return json(200, { credentials: plane.credentials });
      if (parsed.pathname === "/v1/admin/credentials" && method === "POST") { plane.credentials.push(body as Record<string, unknown>); return json(200, { registered: true }); }
      if (parsed.pathname === "/v1/admin/projects" && method === "POST") {
        plane.registered.push(body);
        const definition = (body as { definition: { name: string; revision: number; integrations?: { connectors?: Array<{ name: string }> } } }).definition;
        const connectors = (definition.integrations?.connectors ?? []).map((connector) => ({ name: connector.name, offered: [], skipped: [], ...(plane.preflight[connector.name] ?? { status: "connected" }) }));
        return json(200, { name: definition.name, revision: definition.revision, preflight: { connectors } });
      }
      if (parsed.pathname.startsWith("/v1/admin/slack/bindings/") && method === "PUT") { plane.bindings.push(parsed.pathname.split("/").slice(-2).join("/")); return json(200, { bound: true }); }
      if (parsed.pathname === "/v1/admin/turns") return json(200, { turns: plane.turns });
      return json(404, { error: { code: "NOT_FOUND", message: `no route ${method} ${parsed.pathname}` } });
    },
  };
  return plane;
}

/** Every SetupServices field has a default here, with no cast (F20): a task that adds a field must
 * add its fake, or this stops type-checking. */
export function setupServices(overrides: Partial<SetupServices> = {}): SetupServices {
  const plane = fakeControlPlane();
  return {
    tokenStore: memoryTokenStore(),
    cognito: fakeCognito(),
    login: async () => ({ accessToken: accessToken({ "cognito:groups": ["agentx-admin"] }), expiresAt: Date.parse("2026-09-27T01:00:00.000Z") }),
    fetch: plane.fetch,
    ...overrides,
  };
}
