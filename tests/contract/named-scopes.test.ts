// Migration plan v3.2, lane ID part 1 (DEC 214 decision 7): named scopes in front of Rovara's developer API. Every
// /v1/dev/* route has one row in the broker's route table; a sign-in client's token reaches a row only with its scope
// (or, for a `full` row, with full access, which is off unless an administrator turns it on); a route with no row is
// refused; the Rovara CLI's own token reaches every row, as before.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_SCOPES, IMPLICIT_COMPANY_ID, SignInClientRegistrationSchema, type ClientScope } from "@agentx/contracts";
import { signInClientRegistration, signInClientUpdate } from "../../packages/cli/src/admin/sign-in-clients.js";
import { DEV_ROUTES, devRouteOf, type DevRoute } from "../../packages/broker/src/aws/dev-route-scopes.js";
import type { DeveloperApiConfiguration, DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NAMED: readonly ClientScope[] = ["profile:name", "projects:members", "projects:create", "tasks:read", "tasks:start", "tasks:act", "tasks:share", "decisions:decide"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const sample = (path: string) => path.replaceAll("{emailHash}", "a".repeat(64)).replace(/\{[A-Za-z]+\}/g, "x1");

// ---- The table ----

describe("the route table", () => {
  it("names exactly the eight scopes of plan 7.2 row 1, and nothing more", () => {
    expect([...CLIENT_SCOPES].sort()).toEqual([...NAMED].sort());
    for (const route of DEV_ROUTES) expect([...NAMED, "full", "none"]).toContain(route.requires);
  });

  it("lets only the access check and the per-person project read need no scope", () => {
    expect(DEV_ROUTES.filter((route) => route.requires === "none").map((route) => `${route.method} ${route.path}`).sort())
      .toEqual(["GET /v1/dev/client/projects/{project}", "POST /v1/dev/access"]);
  });

  it("has one row per method and path", () => {
    const keys = DEV_ROUTES.map((route) => `${route.method} ${route.path.replace(/\{[A-Za-z]+\}/g, "{}")}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Contract v0 (Layer 1), the calls Cloud's server makes today: each fits one of the eight scopes.
  const CLOUD_CALLS: Array<[string, string, ClientScope | "none"]> = [
    ["POST", "/v1/dev/access", "none"],
    ["PUT", "/v1/dev/me/name", "profile:name"],
    ["POST", "/v1/dev/client/projects", "projects:create"],
    ["GET", "/v1/dev/client/projects/payments", "none"],
    ["GET", "/v1/dev/client/repositories", "projects:create"],
    ["GET", "/v1/dev/client/projects/payments/members", "projects:members"],
    ["PUT", "/v1/dev/client/projects/payments/members/cy%40example.com", "projects:members"],
    ["DELETE", "/v1/dev/client/projects/payments/members/abc", "projects:members"],
    ["POST", "/v1/dev/tasks", "tasks:start"],
    ["GET", "/v1/dev/tasks/t1", "tasks:read"],
    ["POST", "/v1/dev/tasks/t1/cancel", "tasks:act"],
    ["POST", "/v1/dev/tasks/t1/close", "tasks:act"],
    ["GET", "/v1/dev/tasks/t1/people", "tasks:read"],
    ["POST", "/v1/dev/tasks/t1/people/take-ownership", "tasks:act"],
    ["GET", "/v1/dev/tasks/t1/readers", "tasks:share"],
    ["PUT", "/v1/dev/tasks/t1/readers/abc", "tasks:share"],
    ["DELETE", "/v1/dev/tasks/t1/readers/abc", "tasks:share"],
    ["POST", "/v1/dev/tasks/t1/workflow/decision", "decisions:decide"],
    ["POST", "/v1/dev/tasks/t1/workflow/review", "tasks:act"],
  ];
  it.each(CLOUD_CALLS)("fits Cloud's call %s %s with %s", (method, path, scope) => {
    expect(devRouteOf(method, path)?.requires).toBe(scope);
  });

  it("matches no other method, an extra or empty segment, a trailing slash or another prefix", () => {
    for (const path of ["/v1/dev/tasks/", "/v1/dev/tasks//cancel", "/v1/dev/tasks/t1/cancel/x", "/v1/dev/nothing", "/v1/devx/tasks", "/v1/dev", "/v1/dev/", "/v1/admin/tasks", "/v1/dev/tasks/t1/people/requests"]) {
      for (const method of METHODS) expect(devRouteOf(method, path)).toBeUndefined();
    }
    expect(devRouteOf("PATCH", "/v1/dev/tasks")).toBeUndefined();
    expect(devRouteOf("HEAD", "/v1/dev/tasks")).toBeUndefined();
    expect(devRouteOf("get", "/v1/dev/tasks")).toBeUndefined();
    expect(devRouteOf("POST", "/v1/dev/tasks/t1/readers")).toBeUndefined();
  });
});

// ---- Every route the broker registers has a row (and every row is a route) ----

/** The concrete paths a router regex literal matches, each `([^/]+)` as `{}`. */
function expandRegex(source: string): string[] {
  const body = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replaceAll("([^/]+)", "{}").replaceAll("[^/]+", "{}").replaceAll("([a-f0-9]{64})", "{}");
  const expand = (text: string): string[] => {
    const start = text.search(/\((\?:)?/);
    if (start < 0) return [text];
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      if (text[end] === ")" && --depth === 0) break;
    }
    const inner = text.slice(text[start + 1] === "?" ? start + 3 : start + 1, end);
    const optional = text[end + 1] === "?";
    const after = text.slice(end + (optional ? 2 : 1));
    const parts: string[] = [];
    let level = 0;
    let from = 0;
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] === "(") level += 1;
      if (inner[i] === ")") level -= 1;
      if (inner[i] === "|" && level === 0) { parts.push(inner.slice(from, i)); from = i + 1; }
    }
    parts.push(inner.slice(from));
    return [...parts, ...(optional ? [""] : [])].flatMap((part) => expand(`${text.slice(0, start)}${part}${after}`));
  };
  return expand(body);
}

/** Every /v1/dev path the routers name: string literals, a named path constant with suffixes, and regex literals. */
function routerPaths(): Set<string> {
  const paths = new Set<string>();
  for (const file of ["packages/broker/src/aws/developer-routes.ts", "packages/broker/src/aws/developer-tasks.ts"]) {
    const code = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line)).join("\n");
    for (const [, path] of code.matchAll(/"(\/v1\/dev\/[^"]*)"/g)) if (!path!.endsWith("/")) paths.add(path!);
    for (const [, name, path] of code.matchAll(/const (\w+) = "(\/v1\/dev\/[^"]*)"/g)) {
      for (const [, suffix] of code.matchAll(new RegExp(`\`\\$\\{${name}\\}([^\`]*)\``, "g"))) paths.add(`${path}${suffix}`);
    }
    for (const [, source] of code.matchAll(/\/(\^\\\/v1\\\/dev\\\/.*?\$)\/\.?/g)) for (const path of expandRegex(source!)) paths.add(path);
  }
  return paths;
}

describe("every /v1/dev route the broker registers", () => {
  const normal = (path: string) => path.replace(/\{[A-Za-z]*\}/g, "{}");
  const tablePaths = new Set(DEV_ROUTES.map((route) => normal(route.path)));

  it("has a row, by path, and every row's path is a route", () => {
    const found = new Set([...routerPaths()].map(normal));
    expect(found.size).toBeGreaterThan(30);
    expect([...found].filter((path) => !tablePaths.has(path)), "router paths with no table row").toEqual([]);
    expect([...tablePaths].filter((path) => !found.has(path)), "table rows no router names").toEqual([]);
  });

  // The task router, called directly: a method and path it serves touches its dependencies (here a trap); one it does
  // not serve answers "route not found" before touching anything.
  it("has a row for each method the task router serves, and a row only for methods it serves", async () => {
    const trap = new Proxy({}, { get: () => { throw new Error("reached"); } }) as never;
    const caller: DeveloperCaller = { developerId: "a".repeat(64), sessionId: "s", amr: "oidc", name: "Ada" };
    // The readers route loads the task before it looks at the method; the gate refuses the other methods there.
    const checksMethodAfterLoading = (path: string) => /^\/v1\/dev\/tasks\/\{\}\/readers(\/\{\})?$/.test(path);
    for (const path of [...tablePaths].filter((candidate) => candidate === "/v1/dev/tasks" || candidate.startsWith("/v1/dev/tasks/"))) {
      for (const method of METHODS) {
        const concrete = path.replaceAll("{}", "x1");
        let served = true;
        try {
          await routeDeveloperTaskRequest(trap, caller, { method, path: concrete, headers: {}, requestId: "r" }, new URL(concrete, "https://h.invalid"));
        } catch (error) {
          served = !((error as { code?: string }).code === "NOT_FOUND" && (error as Error).message.includes("route not found"));
        }
        const row = devRouteOf(method, concrete);
        if (row !== undefined) expect(served, `${method} ${path} has a row but the task router does not serve it`).toBe(true);
        else if (!checksMethodAfterLoading(path)) expect(served, `${method} ${path} is served but has no row`).toBe(false);
      }
    }
  });
});

// ---- Through the broker: scope checks, refusals, full access, the CLI ----

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const ADA = "a".repeat(64);
const signer = localSigner();
let db: FakeDynamoDb;
let handler: AdminHandler;

async function bearer(claims: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: ISSUER, aud: "web-app", azp: "web-app", sub: ADA, amr: "oidc", env: "production", sid: "s-cloud", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
const cli = () => bearer({ aud: "agentx-developer", azp: "agentx-cli", sid: "s-cli" });
const scoped = (...scopes: ClientScope[]) => bearer(scopes.length === 0 ? {} : { scope: scopes.join(" ") });

async function call(method: string, path: string, authorization?: string) {
  const response = await handler({ rawPath: path, routeKey: "ANY /v1/dev/{proxy+}", headers: authorization === undefined ? {} : { authorization }, body: "{}", requestContext: { requestId: "r", http: { method } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as { error?: { code: string; message: string } } & Record<string, unknown> };
}

/** The Cloud client: confidential, with the given scopes, and full access only when asked for. */
function cloudClient(scopes: readonly ClientScope[], fullAccess = false) {
  const at = new Date(T0 - 60_000).toISOString();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, secretHash: "f".repeat(64), ...(scopes.length === 0 ? {} : { scopes: [...scopes] }), ...(fullAccess ? { fullAccess: true } : {}), createdAt: at, updatedAt: at, updatedBy: "admin" });
}

const scopeRefusal = (route: DevRoute) => route.requires === "full"
  ? `Web App needs full access for ${route.method} ${route.path}, which is off for it; an administrator can turn it on`
  : `Web App needs the ${route.requires} scope for ${route.method} ${route.path}; an administrator can allow it with that scope`;
const refusedForScope = (response: Awaited<ReturnType<typeof call>>) => response.status === 403 && /needs (the \S+ scope|full access) for /.test(response.body.error?.message ?? "");

async function setUp(mode: "linking" | "developer") {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const config: DeveloperApiConfiguration = {
    companies: { companyOf: async () => IMPLICIT_COMPANY_ID },
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(), clientRoutes: true,
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker(mode === "linking" ? { linking: config, channelAdapters: true } : { developer: config, channelAdapters: true }));
  db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", email: "ada@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  const started = new Date(T0).toISOString();
  db.set({ pk: `COMPANY_MEMBER#${ADA}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId: ADA, companyId: IMPLICIT_COMPANY_ID, role: "admin", joinedAt: started });
  db.set({ pk: "SESSION#s-cloud", sk: "META", sessionId: "s-cloud", developerId: ADA, amr: "oidc", clientId: "web-app", administrator: true, startedAt: started, endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: "SESSION#s-cli", sk: "META", sessionId: "s-cli", developerId: ADA, amr: "oidc", startedAt: started, endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: "PROJECT#payments", sk: "REV#000000000003", entityType: "PROJECT", definition: { name: "payments", revision: 3 } });
  db.set({ pk: `MEMBER#${ADA}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: ADA, projectName: "payments", role: "administrator" });
}
afterEach(() => { vi.useRealTimers(); });

describe("the developer API with a scoped client's token (a named environment)", () => {
  beforeEach(async () => { await setUp("developer"); });
  const gated = DEV_ROUTES.filter((route) => route.requires !== "none");

  it("lets each scope through exactly its own routes, and refuses every other route naming the missing scope", async () => {
    cloudClient(NAMED);
    for (const scope of NAMED) {
      const authorization = await scoped(scope);
      for (const route of gated) {
        const response = await call(route.method, sample(route.path), authorization);
        if (route.requires === scope) expect(refusedForScope(response), `${scope} on ${route.method} ${route.path}`).toBe(false);
        else expect(response, `${scope} on ${route.method} ${route.path}`).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: scopeRefusal(route) } } });
      }
    }
  });

  it("refuses a token with no scope on every gated route, and a scope the registration no longer allows", async () => {
    cloudClient([]);
    expect((await call("GET", "/v1/dev/projects", await scoped())).status, "a client with no scope at all is refused as before").toBe(401);
    cloudClient(NAMED);
    const none = await scoped();
    for (const route of gated) expect((await call(route.method, sample(route.path), none)).body.error?.message, `${route.method} ${route.path}`).toBe(scopeRefusal(route));
    cloudClient(["tasks:start"]);
    const read = devRouteOf("GET", "/v1/dev/tasks")!;
    expect(await call("GET", "/v1/dev/tasks", await scoped("tasks:read", "tasks:start"))).toMatchObject({ status: 403, body: { error: { message: scopeRefusal(read) } } });
    expect(refusedForScope(await call("POST", "/v1/dev/tasks", await scoped("tasks:read", "tasks:start")))).toBe(false);
  });

  it("refuses a removed person's client token as a sign-in that ended, before any scope check", async () => {
    cloudClient(NAMED);
    db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", firstSignInAt: "x", lastSignInAt: "x", revoked: true });
    expect((await call("GET", "/v1/dev/workspaces", await scoped())).status).toBe(401);
  });

  it("serves a scoped route as the person (their own name, their projects)", async () => {
    cloudClient(["profile:name", "tasks:read"]);
    expect(await call("GET", "/v1/dev/projects", await scoped("tasks:read"))).toMatchObject({ status: 200, body: { developer: { id: ADA, name: "Ada" }, projects: [{ name: "payments" }] } });
    expect((await call("GET", "/v1/dev/projects", await scoped("profile:name"))).status).toBe(403);
  });

  it("keeps full access off for the Cloud client unless an administrator turns it on, and reads it at every call", async () => {
    // Registered as the CLI registers it, with every named scope and no --full-access.
    const registration = signInClientRegistration("web-app", { audience: "web-app", redirect: ["https://cloud.example.com/callback"], scope: NAMED.join(",") }, "f".repeat(64));
    expect(registration.fullAccess).toBeUndefined();
    expect(SignInClientRegistrationSchema.parse(registration).scopes).toEqual([...NAMED]);
    const view = { clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: [], loopback: true, confidential: true, scopes: [...NAMED], createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z", updatedBy: "admin" };
    expect(signInClientUpdate(view, { name: "Cloud" }).fullAccess).toBeUndefined();
    cloudClient(registration.scopes ?? []);
    const all = await scoped(...NAMED);
    for (const route of DEV_ROUTES.filter((row) => row.requires === "full")) {
      expect(await call(route.method, sample(route.path), all), `${route.method} ${route.path}`).toMatchObject({ status: 403, body: { error: { message: scopeRefusal(route) } } });
    }
    cloudClient(NAMED, true);
    expect((await call("GET", "/v1/dev/workspaces", all)).status).toBe(200);
    expect((await call("GET", "/v1/dev/channel-links", await scoped())).status).toBe(200);
    cloudClient(NAMED);
    expect((await call("GET", "/v1/dev/workspaces", all)).status).toBe(403);
  });

  it("gives a full-access client every row, as before (spec 066)", async () => {
    cloudClient([], true);
    const authorization = await scoped();
    for (const route of gated) expect(refusedForScope(await call(route.method, sample(route.path), authorization)), `${route.method} ${route.path}`).toBe(false);
  });

  it("logs a refusal with the client's id, the route and the missing scope, never the token", async () => {
    cloudClient(["tasks:read"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const authorization = await scoped("tasks:read");
      await call("POST", "/v1/dev/tasks/t1/cancel", authorization);
      const lines = log.mock.calls.map(([line]) => String(line));
      const refusal = lines.map((line) => { try { return JSON.parse(line) as Record<string, unknown>; } catch { return {}; } }).find((entry) => entry.event === "client.scope_refused");
      expect(refusal).toEqual({ component: "broker", event: "client.scope_refused", clientId: "web-app", method: "POST", route: "/v1/dev/tasks/{taskId}/cancel", requires: "tasks:act" });
      expect(lines.join("\n")).not.toContain(authorization.slice(7));
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a route with no row before authenticating, for every caller", async () => {
    cloudClient(NAMED, true);
    for (const authorization of [undefined, await cli(), await scoped(...NAMED)]) {
      for (const [method, path] of [["GET", "/v1/dev/nothing"], ["PATCH", "/v1/dev/tasks"], ["POST", "/v1/dev/projects"], ["POST", "/v1/dev/tasks/t1/readers"], ["GET", "/v1/dev/tasks/t1/cancel"], ["POST", "/v1/dev/client/projects/payments/members"], ["GET", "/v1/dev/tasks/"]] as const) {
        expect(await call(method, path, authorization), `${method} ${path}`).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
      }
    }
  });

  it("leaves the Rovara CLI's token as it was: every row, with the person's rights", async () => {
    const token = await cli();
    for (const route of gated) {
      const response = await call(route.method, sample(route.path), token);
      expect(response.body.error?.message ?? "", `${route.method} ${route.path}`).not.toMatch(/scope|full access|route not found/);
    }
    expect(await call("GET", "/v1/dev/projects", token)).toMatchObject({ status: 200, body: { projects: [{ name: "payments" }] } });
    expect((await call("GET", "/v1/dev/workspaces", token)).status).toBe(200);
    expect((await call("GET", "/v1/dev/tasks")).status).toBe(401);
  });
});

describe("the developer API with a scoped client's token (production, spec 064)", () => {
  beforeEach(async () => { await setUp("linking"); });

  it("checks the same rows on the routes it serves, and still serves no task route", async () => {
    cloudClient(["tasks:read"]);
    expect((await call("GET", "/v1/dev/projects", await scoped("tasks:read"))).status).toBe(200);
    expect((await call("PUT", "/v1/dev/me/name", await scoped("tasks:read"))).body.error?.message).toBe(scopeRefusal(devRouteOf("PUT", "/v1/dev/me/name")!));
    expect((await call("GET", "/v1/dev/workspaces", await scoped("tasks:read"))).body.error?.message).toBe(scopeRefusal(devRouteOf("GET", "/v1/dev/workspaces")!));
    expect(await call("GET", "/v1/dev/tasks", await scoped("tasks:read"))).toMatchObject({ status: 404, body: { error: { message: "route not found" } } });
    expect(await call("GET", "/v1/dev/nothing", await cli())).toMatchObject({ status: 404, body: { error: { message: "route not found" } } });
    expect((await call("GET", "/v1/dev/projects", await cli())).status).toBe(200);
    // A path under a route it serves, with no row of its own, is refused before anyone is authenticated.
    for (const [method, path] of [["GET", "/v1/dev/channel-links/slack/T1/U1"], ["DELETE", "/v1/dev/channel-links"], ["POST", "/v1/dev/me/name"]] as const) {
      expect(await call(method, path), `${method} ${path}`).toMatchObject({ status: 404, body: { error: { message: "route not found" } } });
    }
  });
});
