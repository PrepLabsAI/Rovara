// Migration plan v3.2, lane ID part 1 (DEC 214 decision 7): named scopes in front of Rovara's developer API. Every
// /v1/dev/* route has one row in the broker's route table; a sign-in client's token reaches a row only with its scope
// (or, for a `full` row, with full access, which is off unless an administrator turns it on); a route with no row is
// refused; the Rovara CLI's own token reaches every row, as before.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, SignInClientRegistrationSchema, type ClientScope } from "@agentx/contracts";
import { signInClientRegistration, signInClientUpdate } from "../../packages/cli/src/admin/sign-in-clients.js";
import { DEV_ROUTES, devRouteOf, type DevRoute } from "../../packages/broker/src/aws/dev-route-scopes.js";
import type { DeveloperApiConfiguration, DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { routeDeveloperTaskRequest } from "../../packages/broker/src/aws/developer-tasks.js";
import { taskScreenRoute } from "../../packages/broker/src/core-host/task-screen-routes.js";
import { MemoryDocumentStore } from "../../packages/broker/src/ports/memory-document-store.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NAMED: readonly ClientScope[] = ["profile:name", "projects:members", "projects:create", "tasks:read", "tasks:start", "tasks:act", "tasks:share", "decisions:decide"];
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/**
 * RD-2.0: the rows only the CORE host serves (the task page's spec, checks, changes and timeline reads, mounted in core-host/task-screen-routes.ts). The older developer router has no such path and answers "route not found", on purpose:
 * a task of a company that is not on the core has none of these reads. The mount's own matcher says which rows these are, so this list cannot drift from it.
 */
const CORE_ONLY_ID = "11111111-1111-4111-8111-111111111111";
const coreOnlyRow = (path: string): boolean => taskScreenRoute(path.replaceAll("{taskId}", CORE_ONLY_ID).replaceAll("{}", CORE_ONLY_ID), "GET") !== undefined;
const sample = (path: string) => path.replaceAll("{emailHash}", "a".repeat(64)).replaceAll("{inviteId}", "a".repeat(64)).replace(/\{[A-Za-z]+\}/g, "x1");

// ---- The table ----

describe("the route table", () => {

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
    ["POST", "/v1/dev/projects/payments/start-estimates", "tasks:read"],
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

});

// ---- Every route the broker registers has a row (and every row is a route) ----

/** The concrete paths a router regex literal matches, each `([^/]+)` or bare `[^/]+` (R4's grouped task-read pattern) as `{}`. */
function expandRegex(source: string): string[] {
  const body = source.replace(/^\^/, "").replace(/\$$/, "").replace(/\\\//g, "/").replaceAll("([^/]+)", "{}").replaceAll("[^/]+", "{}").replaceAll("([a-f0-9]{64})", "{}").replaceAll("([a-z0-9_]{1,40})", "{}");
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
  // The company reads' paths are constants of their contract (#649), which the router imports.
  for (const file of ["packages/broker/src/aws/developer-routes.ts", "packages/broker/src/aws/developer-tasks.ts", "packages/contracts/src/company-reads.ts", "packages/contracts/src/company-egress-addresses.ts", "packages/broker/src/aws/company-member-routes.ts", "packages/broker/src/aws/company-learning-model-routes.ts", "packages/broker/src/aws/github-connect-routes.ts", "packages/broker/src/aws/github-account-link-routes.ts", "packages/broker/src/aws/linear-account-link-routes.ts", "packages/broker/src/aws/slack-company-install.ts", "packages/broker/src/aws/slack-channel-link.ts", "packages/broker/src/aws/linear-connect-routes.ts", "packages/broker/src/aws/company-engine-model-routes.ts"]) {
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
  // A strictly typed id in a router pattern (a skill name, L4-AK3) is a path parameter like any other.
  const normal = (path: string) => path.replace(/\{[A-Za-z]*\}/g, "{}").replace(/\[a-z0-9\]\[a-z0-9-\]\{0,63\}/g, "{}");
  const tablePaths = new Set(DEV_ROUTES.map((route) => normal(route.path)));

  it("has a row, by path, and every row's path is a route", () => {
    const found = new Set([...routerPaths()].map(normal));
    expect(found.size).toBeGreaterThan(30);
    expect([...found].filter((path) => !tablePaths.has(path)), "router paths with no table row").toEqual([]);
    expect([...tablePaths].filter((path) => !found.has(path) && !coreOnlyRow(path)), "table rows no router names").toEqual([]);
    // The four core-only rows are exactly the task page's new reads.
    expect([...tablePaths].filter(coreOnlyRow).sort()).toEqual(["/v1/dev/tasks/{}/changes", "/v1/dev/tasks/{}/checks", "/v1/dev/tasks/{}/spec", "/v1/dev/tasks/{}/timeline"]);
  });

  // The task router, called directly: a method and path it serves touches its dependencies (here a trap); one it does
  // not serve answers "route not found" before touching anything.
  it("has a row for each method the task router serves, and a row only for methods it serves", async () => {
    const trap = new Proxy({}, { get: () => { throw new Error("reached"); } }) as never;
    const caller: DeveloperCaller = { developerId: "a".repeat(64), sessionId: "s", amr: "oidc", name: "Ada" };
    // The readers route loads the task before it looks at the method; the gate refuses the other methods there.
    const checksMethodAfterLoading = (path: string) => /^\/v1\/dev\/tasks\/\{\}\/readers(\/\{\})?$/.test(path);
    for (const path of [...tablePaths].filter((candidate) => candidate === "/v1/dev/tasks" || (candidate.startsWith("/v1/dev/tasks/") && candidate !== "/v1/dev/tasks/start-requests/{}") && !coreOnlyRow(candidate))) {
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
const previewCore = vi.fn(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ quoteVersion: 2 }) }));

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
    // Lane W part 4: the company admin routes need the member helper to exist; this one finds nobody, so only the route table's answer is tested here.
    companyMembers: { list: async () => ({ ok: false, error: "not_found" }), revoke: async () => ({ ok: false, error: "not_found" }), setRole: async () => ({ ok: false, error: "not_found" }) },
    // Guided onboarding PR 1: the GitHub connect routes need their wiring to exist; this one connects nothing, so only the route table's answer is tested here.
    githubConnect: { bindings: { claimPerson: async () => "taken", companyInstallations: async () => [], ownersOf: async () => [], disconnect: async () => ({ outcome: "not_found" }) }, github: { appSlug: async () => "app", oauthClient: async () => undefined, userControlledInstallations: async () => { throw new Error("none"); } }, log: () => undefined },
    githubLink: { store: new MemoryDocumentStore(), github: { oauthClient: async () => undefined, githubUserOfCode: async () => { throw new Error("none"); } }, log: () => undefined },
    // Guided onboarding PR 4: the Add to Slack routes need their wiring to exist; this one connects nothing, so only the route table's answer is tested here.
    slackInstall: { slack: { clientId: async () => undefined, exchange: async () => "not_set_up" as const, revoke: async () => false, store: async () => undefined, revokeStored: async () => undefined, drop: async () => undefined }, log: () => undefined },
    // Guided onboarding PR 5: a project's Slack channel routes need their wiring to exist; this one sees no channel, so only the route table's answer is tested here.
    slackChannels: { slack: { channels: async () => ({ channels: [] }), channel: async () => "not_found" as const, join: async () => false }, log: () => undefined },
    // Guided onboarding PR 7: the Linear connect routes need their wiring to exist; this one connects nothing, so only the route table's answer is tested here.
    linearConnect: { connections: {} as never, app: async () => undefined, fetch: vi.fn() as never, log: () => undefined },
    // R1 + L1: the member's own Linear link routes and the admin's list of links need their wiring to exist; this one links nothing, so only the route table's answer is tested here.
    linearLink: { connections: {} as never, links: new MemoryDocumentStore(), app: async () => undefined, fetch: vi.fn() as never, log: () => undefined },
    // L2-4: the waiting-ticket routes need the core's intake to exist; this one holds no tickets, so only the route table's answer is tested here.
    coreTasks: { route: previewCore },
    coreIntake: { intakeFor: async () => undefined, mayStart: async () => false, waiting: async () => ({ items: [], sources: [] }), start: async () => ({ outcome: "not_found" }), seedTicketUpdates: async () => "no_intake", dismiss: async () => false },
    // Guided onboarding PR 14: the company engine model route needs its wiring to exist; this gateway offers nothing readable, so only the route table's answer is tested here.
    companyEngineModel: { offered: async () => { throw new Error("none"); }, installModel: () => undefined, log: () => undefined },
    // DEC 254zzz63: the company learning model route, the same way.
    companyLearningModel: { offered: async () => { throw new Error("none"); }, installModel: () => undefined, log: () => undefined },
    companyEgress: { addresses: () => "203.0.113.195,198.51.100.187" },
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
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

  it("leaves the Rovara CLI's token as it was: every row, with the person's rights", async () => {
    const token = await cli();
    for (const route of gated.filter((row) => !coreOnlyRow(row.path))) {
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
