import { CORE_CONTEXT_WORKER_ROUTES, coreContextWorkerRouteOf, appRouteOf as contextAppRouteOf, devRouteOf as contextDevRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
// Lane L12: the core engine's own /v1/app/* routes on the broker's HTTP API (sessions, decision cards, how we work, script tokens, person erase).
//   - Off (no core entry): every /v1/app/* path on the core's route answers "route not found" and reads nothing; on any other route the broker answers as before (the golden is in
//     aws-core-root-golden.test.ts).
//   - On: a method and path with no row in the route table is refused before anyone is authenticated; the developer token is verified by the broker; a sign-in client reaches a row only
//     with its scope; the core gets the verified caller (DEC 254zzz73: no step-up) and never the credential; the company is the caller's LIVE membership.
//   - Two companies over one core: a person of one company never sees or reaches the other's script tokens or people.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ON_THE_WEBSITE_MESSAGE, orgProjectCatalogKey, projectRevisionKey, type ClientScope, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { APP_ROUTES, appRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { CORE_APP_SIGN_IN_AGAIN, CORE_APP_UNAVAILABLE, coreAppEntryFrom, type CoreAppEntry } from "../../packages/broker/src/aws/core-app-routes.js";
import { deployedCallerFromMembership, membershipWithRoleFromDynamo, personStandingFromDynamo, projectGrantFromDynamo } from "../../packages/broker/src/aws/core-engine-root.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import type { CoreTaskEntry, CoreEntryCaller } from "../../packages/broker/src/aws/engine-boundary.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes } from "../../packages/broker/src/core-host/dev-routes.js";
import { createPersonEraseRoute } from "../../packages/broker/src/core-host/person-erase-route.js";
import { noLearningToErase, noWikiToErase } from "../../packages/broker/src/core/people/erase.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { BrokerRequest, BrokerResponse } from "../../packages/broker/src/handler.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ROUTE_KEY = "ANY /v1/app/{proxy+}";
const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
// The fake world's clock: the broker's token checks and the core read the same time.
const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const ADA = "a".repeat(64);
const BO = "b".repeat(64);
const CY = "c".repeat(64);
const OTHER = "org_corehost00000000000b" as OrgId;
const sample = (path: string) => path.replace(/\{[A-Za-z]+\}/g, "x1");

// ---- The table ----

describe("the /v1/app route table", () => {

  // Written out by hand: what the core serves on AWS (core-host/dev-routes.ts over the session, decision, playbook and script-token handlers, and the person erase), with its scope.
  const SERVED: Array<[string, string, ClientScope | "full"]> = [
    ["GET", "/v1/app/projects/payments/known-failing", "full"], ["POST", "/v1/app/projects/payments/known-failing", "full"],
    ["GET", "/v1/app/sessions", "tasks:read"], ["GET", "/v1/app/sessions/s1", "tasks:read"],
    ["POST", "/v1/app/sessions/s1/follow", "tasks:read"], ["DELETE", "/v1/app/sessions/s1/follow", "tasks:read"], ["POST", "/v1/app/sessions/s1/unfollow", "tasks:read"], ["POST", "/v1/app/sessions/s1/presence", "tasks:read"],
    ["POST", "/v1/app/sessions/s1/stop", "tasks:act"], ["POST", "/v1/app/sessions/s1/retry", "tasks:act"], ["POST", "/v1/app/sessions/s1/messages", "tasks:act"],
    ["POST", "/v1/app/sessions/s1/answers", "tasks:act"], ["POST", "/v1/app/sessions/s1/revise-plan", "tasks:act"], ["POST", "/v1/app/sessions/s1/close", "tasks:act"], ["GET", "/v1/app/sessions/s1/close", "tasks:read"],
    ["GET", "/v1/app/decisions", "decisions:decide"], ["POST", "/v1/app/decisions/plan/t1/approve", "decisions:decide"], ["POST", "/v1/app/decisions/plan/t1/reject", "decisions:decide"],
    ["POST", "/v1/app/decisions/plan/t1/request-changes", "decisions:decide"], ["POST", "/v1/app/decisions/plan/t1/evidence-opened", "decisions:decide"],
    ["GET", "/v1/app/projects/payments/how-we-work", "full"], ["GET", "/v1/app/projects/payments/playbook", "full"],
    // DEC 254z-amend3: the project's test environment state, read only.
    ["GET", "/v1/app/projects/payments/test-environment", "full"],
    // L4-MF1: the project's saved environment image panel, read only.
    ["GET", "/v1/app/projects/payments/environment-image", "full"],
    // #1175: the company's per-step agent model choice (core-host/agent-model-routes.ts); missing, the broker refused it before auth and Cloud's "AI and spending" never finished.
    ["GET", "/v1/app/agent-models", "full"], ["POST", "/v1/app/agent-models", "full"],
    ["GET", "/v1/app/script-tokens", "full"], ["POST", "/v1/app/script-tokens", "full"], ["POST", "/v1/app/script-tokens/tok_1/revoke", "full"],
    ["POST", "/v1/app/people/p1/erase", "full"],
    // Guided onboarding L2-3: the hosted setup run.
    ["GET", "/v1/app/projects/payments/setup-agent", "full"], ["POST", "/v1/app/projects/payments/setup-agent", "full"], ["POST", "/v1/app/projects/payments/setup-agent/stop", "full"],
    ["GET", "/v1/app/projects/payments/setup-agent/journal", "full"],
    // Web task channel C7: the in-app inbox (core/notify/inbox.ts over core-host/inbox-routes.ts).
    ["GET", "/v1/app/inbox", "tasks:read"], ["POST", "/v1/app/inbox/read", "tasks:read"], ["POST", "/v1/app/notify/unsubscribe", "full"],
    // L4-U5b: the project notices (setup needs repair, upkeep paused) in the person's own inbox. Project-level words, so a full sign-in only (an AI tool's tasks:read token never reads them).
    ["GET", "/v1/app/inbox/project-notices", "full"],
    // Wiki W0: a project's free file map.
    ["GET", "/v1/app/projects/payments/wiki-map", "full"], ["POST", "/v1/app/projects/payments/wiki-map", "full"],
    // Lead 4 W2: the project wiki's reads.
    ["GET", "/v1/app/projects/payments/wiki", "full"], ["GET", "/v1/app/projects/payments/wiki/search", "full"], ["GET", "/v1/app/projects/payments/wiki/pages/overview", "full"], ["GET", "/v1/app/projects/payments/wiki/pages/overview/sources", "full"], ["GET", "/v1/app/projects/payments/wiki/pages/overview/lessons", "full"],
    // L4-B3b: approving the project's test environment (the state read keeps its own row above).
    ["POST", "/v1/app/projects/payments/test-environment/approve", "full"],
    // Lead 4 L4-MF3: the company-wide agent directory (a live company owner or administrator reads it).
    ["GET", "/v1/app/agents", "full"],
    // L4-D: confirm, discard and decide a setup candidate.
    ["POST", "/v1/app/projects/payments/setup-agent/confirm", "full"], ["POST", "/v1/app/projects/payments/setup-agent/discard", "full"], ["POST", "/v1/app/projects/payments/setup-agent/decide", "full"],
    // Lead 4 C1: the wiki's corrections (additive: no existing row changed).
    ["GET", "/v1/app/projects/payments/wiki/pages/overview/corrections", "full"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes", "full"],
    ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/approve", "full"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/delete", "full"],
    ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/suggest-lesson", "full"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/acknowledge", "full"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/flags", "full"],
    ["POST", "/v1/app/projects/payments/wiki/pages/overview/flags/resolve", "full"], ["GET", "/v1/app/projects/payments/wiki/disputed", "full"],
    // Lead 4 A1/A2: the cost and time report (full access only; a live company owner or admin, or the task's starter or a maintainer for a task's feature).
    ["GET", "/v1/app/org/report/tasks", "full"], ["GET", "/v1/app/org/report/features", "full"], ["POST", "/v1/app/org/report/features", "full"],
    ["POST", "/v1/app/org/report/features/ft_00000000000000000001/rename", "full"], ["POST", "/v1/app/org/report/features/ft_00000000000000000001/merge", "full"], ["POST", "/v1/app/org/report/features/ft_00000000000000000001/state", "full"],
    ["POST", "/v1/app/tasks/t1/feature", "full"],
    // L4-P1: "Re-check setup".
    ["GET", "/v1/app/projects/payments/setup-check", "full"], ["POST", "/v1/app/projects/payments/setup-check", "full"],
    // Lead 4 W4: the wiki build controls.
    ["GET", "/v1/app/projects/payments/wiki-build", "full"], ["POST", "/v1/app/projects/payments/wiki-build", "full"], ["POST", "/v1/app/projects/payments/wiki-build/continue", "full"], ["POST", "/v1/app/projects/payments/wiki-build/stop", "full"],
    ["POST", "/v1/app/projects/payments/wiki-build/refresh", "full"], ["POST", "/v1/app/projects/payments/wiki-build/agents", "full"], ["POST", "/v1/app/projects/payments/wiki-build/delete", "full"],
    // L4-SC: the Update setup offers, making a candidate from one, and "Not now".
    ["GET", "/v1/app/projects/payments/setup-agent/updates", "full"], ["POST", "/v1/app/projects/payments/setup-agent/updates/prepare", "full"], ["POST", "/v1/app/projects/payments/setup-agent/updates/dismiss", "full"],
    // Lead 4 J3: the start box's path suggestion.
    ["POST", "/v1/app/projects/payments/code/suggest", "full"],
    // Lead 4 J1: the smart Just answer.
    ["POST", "/v1/app/projects/payments/answers", "full"],
    // Lead 4 J5: answers feed the wiki (additive: no existing row changed).
    ["POST", "/v1/app/projects/payments/answers/a0123456789/not-right", "full"], ["GET", "/v1/app/projects/payments/wiki/gaps", "full"],
    // L4-SF: allow or refuse a website a setup run asked for.
    ["POST", "/v1/app/projects/payments/setup-agent/host-decide", "full"],
    // SETUP-LIMITS: the project's setup-run limits.
    ["GET", "/v1/app/projects/payments/setup-agent/limits", "full"], ["PUT", "/v1/app/projects/payments/setup-agent/limits", "full"],
    // Lead 4 N1: the nightly upkeep switch.
    ["GET", "/v1/app/projects/payments/upkeep", "full"], ["PUT", "/v1/app/projects/payments/upkeep", "full"],
    // L4-EVCI2: the setup card's eval check from the customer's CI (additive: no existing row changed).
    ["GET", "/v1/app/projects/payments/ci-eval-check", "full"], ["PUT", "/v1/app/projects/payments/ci-eval-check", "full"],
    // L4-B5: the task's log of questions, answers and decisions (core/task-log/read.ts), for whoever may read the session.
    ["GET", "/v1/app/sessions/s1/log", "tasks:read"],
    // Lead 4 PCF: the plan card's "Change" lists the open features (the same people as the filing).
    ["GET", "/v1/app/tasks/t1/feature-choices", "full"],
    // L4-P3: the company's one control over Rovara's automatic runs.
    ["GET", "/v1/app/company/system-runs", "full"], ["PUT", "/v1/app/company/system-runs", "full"],
    // PRIVATE-PACKAGES P1b: the company's package tokens (status line, set or replace, delete; no row answers a value).
    ["GET", "/v1/app/company/package-registries", "full"], ["PUT", "/v1/app/company/package-registries", "full"], ["DELETE", "/v1/app/company/package-registries", "full"],
    // L4-EVC (DEC 254zzz20): the eval card and its one approval.
    ["GET", "/v1/app/projects/payments/setup-agent/eval", "full"], ["POST", "/v1/app/projects/payments/setup-agent/eval-approve", "full"], ["POST", "/v1/app/projects/payments/setup-agent/eval-decide", "full"], ["POST", "/v1/app/projects/payments/setup-agent/eval-health", "full"],
    // L4-EVW2 (DEC 254zzz20 D2): Rovara's proposed wrapper file, tried again.
    ["POST", "/v1/app/projects/payments/setup-agent/eval-wrapper", "full"],
    // Audit gap 11b: a project's ticket-sharing settings (the laptop's intake/updates route; additive: no existing row changed).
    ["GET", "/v1/app/projects/payments/intake/updates", "full"], ["PUT", "/v1/app/projects/payments/intake/updates", "full"],
    // DEC 254zzz39 (6): the task owner's Accept findings on the web page (a security finding needs it). Additive: no existing row changed.
    ["POST", "/v1/app/tasks/t1/review-findings", "full"],
    ["GET", "/v1/app/tasks/t1/merge", "tasks:read"],
    ["POST", "/v1/app/tasks/t1/merge", "full"],
  ];
  it.each(SERVED)("has a row for %s %s needing %s", (method, path, scope) => {
    expect(appRouteOf(method, path)?.requires).toBe(scope);
  });

});

// ---- Through the broker ----

const signer = localSigner();
let db: FakeDynamoDb;
let handler: AdminHandler;

async function bearer(claims: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: ISSUER, aud: "agentx-developer", azp: "agentx-cli", sub: ADA, amr: "oidc", env: "staging", sid: "s-ada", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
/** The Rovara CLI's token for a person. */
const cli = (who = ADA) => bearer({ sub: who, sid: `s-${who.slice(0, 2)}` });

async function call(method: string, path: string, authorization?: string, options: { routeKey?: string; body?: unknown } = {}) {
  const [rawPath, rawQueryString] = path.split("?");
  const response = await handler({
    rawPath, ...(rawQueryString === undefined ? {} : { rawQueryString }), routeKey: options.routeKey ?? ROUTE_KEY,
    headers: authorization === undefined ? {} : { authorization }, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    requestContext: { requestId: "r", http: { method } },
  });
  return { status: response.statusCode, headers: (response as { headers?: Record<string, string> }).headers ?? {}, body: JSON.parse(response.body) as { error?: { code: string; message: string } } & Record<string, unknown> };
}

function person(developerId: string, name: string, sessionId: string, clientId?: string): void {
  const started = new Date(T0 - 60_000).toISOString();
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://idp.example.test", subject: name, displayName: name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ pk: `SESSION#${sessionId}`, sk: "META", sessionId, developerId, amr: "oidc", ...(clientId === undefined ? {} : { clientId, administrator: true }), startedAt: started, endsAt: T0 / 1000 + 604_800 });
}
const membership = (personId: string, companyId: string, role: string, revokedAt?: string) =>
  db.set({ pk: `COMPANY_MEMBER#${personId}`, sk: "COMPANY", entityType: "COMPANY_MEMBERSHIP", personId, companyId, role, joinedAt: "2026-11-01T00:00:00.000Z", ...(revokedAt === undefined ? {} : { revokedAt }) });

async function setUp(coreApp: CoreAppEntry | undefined, mode: "developer" | "linking" = "developer", coreTasks?: CoreTaskEntry): Promise<void> {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "staging", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    ...(coreApp === undefined ? {} : { coreApp }),
    ...(coreTasks === undefined ? {} : { coreTasks }),
  };
  ({ db, handler } = await createAdminBroker(mode === "linking" ? { linking: config } : { developer: config }));
  person(ADA, "Ada", "s-aa");
  person(ADA, "Ada", "s-cloud", "web-app");
  person(BO, "Bo", "s-bb");
  person(CY, "Cy", "s-cc");
}
afterEach(() => { vi.useRealTimers(); });

/** A core entry that records what it was handed and answers `reply`. */
function spyEntry(reply: (request: BrokerRequest) => BrokerResponse | undefined = () => ({ statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ served: true }) })) {
  const seen: Array<{ request: BrokerRequest; caller: CoreEntryCaller }> = [];
  const entry: CoreAppEntry = { route: async (request, caller) => { seen.push({ request, caller }); return reply(request); } };
  return { entry, seen };
}

describe("the core's /v1/app routes, switch off (no core entry)", () => {
  it("answers every row 'route not found' on the core's route, before reading anything", async () => {
    await setUp(undefined);
    const send = vi.spyOn(db, "send");
    for (const route of APP_ROUTES) {
      expect(await call(route.method, sample(route.path), await cli()), `${route.method} ${route.path}`).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    }
    expect(send).not.toHaveBeenCalled();
  });

});

describe("the core's /v1/app routes, switch on (a core entry)", () => {
  let spy: ReturnType<typeof spyEntry>;
  beforeEach(async () => { spy = spyEntry(); await setUp(spy.entry); });

  it("refuses a method and path with no row before authenticating anyone, and the core's route carries nothing else", async () => {
    const send = vi.spyOn(db, "send");
    for (const authorization of [undefined, await cli()]) {
      for (const [method, path] of [["GET", "/v1/app/triggers"], ["POST", "/v1/app/sessions/s1/ask"], ["PUT", "/v1/app/projects/payments/playbook"], ["GET", "/v1/app/people/p1/erase"], ["GET", "/v1/app/"]] as const) {
        expect(await call(method, path, authorization), `${method} ${path}`).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
      }
      // The core's route never reaches the developer API or anything else.
      for (const path of ["/v1/dev/projects", "/v1/admin/changes", "/v1/internal/workspaces/w/operations/o/result"]) expect((await call("GET", path, authorization)).status, path).toBe(404);
    }
    expect(send).not.toHaveBeenCalled();
    expect(spy.seen).toEqual([]);
  });

  it("refuses a path the URL parser would read differently (never matched two ways)", async () => {
    expect(await call("GET", "/v1/app\\script-tokens", await cli())).toMatchObject({ status: 404, body: { error: { message: "route not found" } } });
    expect(await call("POST", "/v1/app/people/p1/..%2Ferase", await cli())).toMatchObject({ status: 404 });
    expect(spy.seen).toEqual([]);
  });

  it("refuses a request without a valid developer token, and a session that ended, before the core", async () => {
    expect((await call("GET", "/v1/app/script-tokens")).status).toBe(401);
    expect((await call("GET", "/v1/app/script-tokens", "Bearer not-a-token")).status).toBe(401);
    db.set({ pk: "SESSION#s-aa", sk: "META", sessionId: "s-aa", developerId: ADA, amr: "oidc", startedAt: new Date(T0 - 60_000).toISOString(), endsAt: T0 / 1000 - 1 });
    expect((await call("GET", "/v1/app/script-tokens", await cli())).status).toBe(401);
    expect(spy.seen).toEqual([]);
  });

  it("answers 'route not found' when the core does not serve the path, and passes the core's refusals through as they are", async () => {
    spy = spyEntry((request) => request.path.startsWith("/v1/app/decisions") ? { statusCode: 404, headers: {}, body: JSON.stringify({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } }) } : undefined);
    await setUp(spy.entry);
    expect(await call("GET", "/v1/app/sessions", await cli())).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    expect(await call("GET", "/v1/app/decisions", await cli())).toMatchObject({ status: 404, body: { error: { message: NOT_ON_THE_CORE_YET } } });
  });

});

// ---- Over the core itself: two companies ----

const PROJECT: ProjectDefinition = {
  name: "payments", revision: 1, setup: [], readiness: [], orchestratorInstructions: "Delegate work.",
  repositories: [{ name: "demo", url: "https://github.com/example/demo.git", path: "repo/demo", defaultBranch: "main", credentialRef: "host-app" }],
};
const SERVICES = () => ({ "merge-tracking": { pass: async () => ({}) }, "session-sweep": { pass: async () => ({}) }, "notify-deliver": { pass: async () => ({}) }, "admission-hold-sweep": { pass: async () => ({}) } });

/** The deployment's composition (core-engine-root.ts) over a fake world: the core's routes and the person erase, behind the membership caller mapping, reading the broker's own table. */
async function coreOver(world: FakeWorld): Promise<{ entry: CoreAppEntry; log: Array<Record<string, unknown>> }> {
  for (const companyId of [FAKE_COMPANY, OTHER]) {
    await world.store.put({ item: { ...projectRevisionKey(companyId, PROJECT.name, PROJECT.revision), entityType: "PROJECT", definition: JSON.parse(JSON.stringify(PROJECT)) as JsonValue } });
    await world.store.put({ item: { ...orgProjectCatalogKey(companyId, PROJECT.name), entityType: "PROJECT_CATALOG", latestRevision: PROJECT.revision } });
  }
  const log: Array<Record<string, unknown>> = [];
  const app = createCoreHostApp({
    modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
  const membershipOf = membershipWithRoleFromDynamo(db, "signin");
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller) => await membershipOf(caller.principal.personId),
    wiring: () => ({ origin: () => "https://api.example", scriptTokens: {}, canReadProject: projectGrantFromDynamo(db, "state") }),
  });
  const registry = await app.registry();
  const personErase = createPersonEraseRoute({
    standing: personStandingFromDynamo(db, "signin"), companyOf: async (who) => await membershipOf(who.principal.personId),
    eraseDeps: () => ({ store: registry.require("storage"), audit: registry.require("audit-sink"), objects: { deleteEveryVersion: async () => true }, eraseLearning: noLearningToErase, eraseWiki: noWikiToErase, now: () => world.clock.now }),
  });
  return { entry: coreAppEntryFrom({ routes, personErase, deployedCallerOf: deployedCallerFromMembership(membershipOf), log: (entry) => log.push(entry) }), log };
}

describe("the core's /v1/app routes over the core, two companies", () => {
  let log: Array<Record<string, unknown>>;
  beforeEach(async () => {
    const world = createFakeWorld();
    let entry: CoreAppEntry | undefined;
    // The entry reads the broker's table, which setUp makes: built in between.
    await setUp({ route: async (request, caller) => await entry!.route(request, caller) });
    ({ entry, log } = await coreOver(world));
    // ADA and BO are admins of two companies, both with the payments grant; CY was removed from ADA's company.
    membership(ADA, FAKE_COMPANY, "admin");
    membership(BO, OTHER, "admin");
    membership(CY, FAKE_COMPANY, "member", new Date(T0 - 86_400_000).toISOString());
    for (const who of [ADA, BO]) db.set({ pk: `MEMBER#${who}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: who, projectName: "payments", role: "developer" });
    // Owner DEC 254zzz91: the Rovara website's own client (operator-marked: full access AND webApp), with a web session for each person.
    const at = new Date(T0 - 60_000).toISOString();
    db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, secretHash: "f".repeat(64), fullAccess: true, webApp: true, createdAt: at, updatedAt: at, updatedBy: "admin" });
    for (const who of [ADA, BO, CY]) db.set({ pk: `SESSION#w-${who.slice(0, 2)}`, sk: "META", sessionId: `w-${who.slice(0, 2)}`, developerId: who, amr: "oidc", clientId: "web-app", startedAt: at, endsAt: T0 / 1000 + 604_800 });
  });
  const makeToken = { requestId: "", name: "ci", projects: ["payments"], permissions: ["read"] };
  /** The Rovara website's own client's token for a person (owner DEC 254zzz91: making a script token and erasing a person are its acts alone). */
  const site = (who = ADA) => bearer({ aud: "web-app", azp: "web-app", sub: who, sid: `w-${who.slice(0, 2)}` });

  it("makes a script token for a live owner or admin with no step-up (DEC 254zzz73), and shows it only within the maker's company", async () => {
    const made = await call("POST", "/v1/app/script-tokens", await site(ADA), { body: { ...makeToken, requestId: randomUUID() } });
    expect(made.status).toBe(201);
    expect(made.headers["cache-control"]).toBe("no-store");
    const tokenId = (made.body as { token: { tokenId: string } }).token.tokenId;
    expect(made.body).toMatchObject({ token: { mine: true, status: "active" }, secret: expect.stringMatching(/^rvst_/u) as unknown });
    const own = await call("GET", "/v1/app/script-tokens", await cli(ADA));
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).toContain(tokenId);
    // BO, an admin of the other company, neither sees nor revokes it.
    const other = await call("GET", "/v1/app/script-tokens", await cli(BO));
    expect(other).toMatchObject({ status: 200, body: { tokens: [] } });
    expect((await call("POST", `/v1/app/script-tokens/${encodeURIComponent(tokenId)}/revoke`, await cli(BO))).status).toBe(404);
    expect((await call("GET", "/v1/app/script-tokens", await cli(ADA))).body).toMatchObject({ tokens: [{ tokenId, status: "active" }] });
  });

  it("uses live membership for canCreate and creation, while a demoted member can still list and revoke their own tokens", async () => {
    const authorization = await site(ADA);
    const create = () => call("POST", "/v1/app/script-tokens", authorization, { body: { ...makeToken, requestId: randomUUID() } });
    const own = await create();
    expect(own.status).toBe(201);
    const tokenId = (own.body as { token: { tokenId: string } }).token.tokenId;
    expect((await call("GET", "/v1/app/script-tokens", authorization)).body).toMatchObject({ canCreate: true });
    // A second person's token in this company stays hidden from the demoted member.
    membership(BO, FAKE_COMPANY, "owner");
    const others = await call("POST", "/v1/app/script-tokens", await site(BO), { body: { ...makeToken, requestId: randomUUID() } });
    expect(others.status).toBe(201);
    const otherId = (others.body as { token: { tokenId: string } }).token.tokenId;
    membership(ADA, FAKE_COMPANY, "member");
    expect(await create()).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: "Only an owner or an admin of the company can create script tokens." } } });
    expect((await call("GET", "/v1/app/script-tokens", authorization)).body).toMatchObject({ canCreate: false, tokens: [{ tokenId }] });
    expect((await call("POST", `/v1/app/script-tokens/${otherId}/revoke`, authorization)).status).toBe(404);
    expect(await call("POST", `/v1/app/script-tokens/${tokenId}/revoke`, authorization)).toMatchObject({ status: 200, body: { token: { tokenId, status: "revoked" } } });
    membership(ADA, FAKE_COMPANY, "owner");
    expect((await create()).status).toBe(201);
    membership(ADA, FAKE_COMPANY, "owner", new Date(T0 - 1_000).toISOString());
    expect(await create()).toMatchObject({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: CORE_APP_SIGN_IN_AGAIN } } });
  });

  it("erases a removed person only for an admin of that person's company (no step-up, DEC 254zzz73); another company's admin is told 'not found'", async () => {
    const erase = async (who: string) => await call("POST", `/v1/app/people/${CY}/erase`, await site(who), { body: { requestId: randomUUID() } });
    expect(await erase(BO)).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    const done = await erase(ADA);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ receipt: expect.any(Object) as unknown });
    expect(JSON.stringify(done.body)).not.toContain("Cy");
  });

  it("owner DEC 254zzz91: an admin's CLI token makes no script token and erases nobody: 403 with the website words, nothing made or erased", async () => {
    const website = { status: 403, body: { error: { code: "FORBIDDEN", message: ON_THE_WEBSITE_MESSAGE } } };
    expect(await call("POST", "/v1/app/script-tokens", await cli(ADA), { body: { ...makeToken, requestId: randomUUID() } })).toMatchObject(website);
    expect((await call("GET", "/v1/app/script-tokens", await cli(ADA))).body).toMatchObject({ tokens: [] });
    expect(await call("POST", `/v1/app/people/${CY}/erase`, await cli(ADA), { body: { requestId: randomUUID() } })).toMatchObject(website);
    // The website's own client erases the same person, so nothing was erased above.
    expect((await call("POST", `/v1/app/people/${CY}/erase`, await site(ADA), { body: { requestId: randomUUID() } })).status).toBe(200);
  });

  it("answers the parts not wired on the core yet (session levels, decision cards, how we work) with fixed words", async () => {
    for (const [method, path] of [["GET", "/v1/app/sessions"], ["GET", "/v1/app/decisions"], ["GET", "/v1/app/projects/payments/how-we-work"]] as const) {
      expect(await call(method, path, await cli(ADA)), `${method} ${path}`).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } } });
    }
    expect(log).toEqual([]);
  });
});

describe("the core app entry", () => {
  it("answers the sign-in refusal when the caller mapping finds no member or throws, and fixed words (no echo) when the core throws", async () => {
    const caller: CoreEntryCaller = { developerId: ADA, sessionId: "s", name: "Ada" };
    const request: BrokerRequest = { method: "GET", path: "/v1/app/script-tokens", headers: {} };
    const log: Array<Record<string, unknown>> = [];
    const throwing = { route: async (): Promise<BrokerResponse | undefined> => { throw Object.assign(new Error("secret-detail-1"), { name: "RegistryRefused" }); } };
    const ok = { route: async (): Promise<BrokerResponse | undefined> => ({ statusCode: 200, headers: {}, body: "{}" }) };
    for (const deployedCallerOf of [async () => undefined, async () => { throw new Error("secret-detail-2"); }]) {
      const entry = coreAppEntryFrom({ routes: throwing, personErase: throwing, deployedCallerOf, log: (line) => log.push(line) });
      const answer = await entry.route(request, caller);
      expect(answer?.statusCode).toBe(401);
      expect(JSON.parse(answer!.body)).toEqual({ error: { code: "UNAUTHENTICATED", message: CORE_APP_SIGN_IN_AGAIN } });
    }
    const principal = { companyId: FAKE_COMPANY, personId: ADA, displayName: "Ada", roles: ["admin"], provider: "developer" } as never;
    const entry = coreAppEntryFrom({ routes: throwing, personErase: ok, deployedCallerOf: async () => ({ principal }), log: (line) => log.push(line) });
    const failed = await entry.route(request, caller);
    expect(failed?.statusCode).toBe(503);
    expect(JSON.parse(failed!.body)).toEqual({ error: { code: "RUNTIME_UNAVAILABLE", message: CORE_APP_UNAVAILABLE } });
    expect(log).toEqual([{ event: "core_engine.app_route_unavailable", error: "RegistryRefused" }]);
    expect(JSON.stringify([failed, log])).not.toMatch(/secret-detail/u);
    // The person erase goes to its own route; anything outside /v1/app/ is not this entry's.
    expect((await entry.route({ method: "POST", path: `/v1/app/people/${CY}/erase`, headers: {} }, caller))?.statusCode).toBe(200);
    expect(await entry.route({ method: "GET", path: "/v1/dev/tasks", headers: {} }, caller)).toBeUndefined();
  });
});

// Internal worker routes are inventoried in the scope table, with no person scope.
it("inventories exactly four worker-only saved image callbacks without exposing app or developer aliases", async () => {
  const { APP_ROUTES, DEV_ROUTES, SAVED_ENV_WORKER_ROUTES, savedEnvWorkerRouteOf, appRouteOf, devRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
  expect(SAVED_ENV_WORKER_ROUTES.map(row => [row.method, row.path, row.requires])).toEqual(["push-login", "result", "fallback", "login"].map(action => ["POST", `/v1/internal/workspaces/{workspace}/operations/{operation}/saved-env-${action}`, "worker"]));
  for (const row of SAVED_ENV_WORKER_ROUTES) {
    const path = row.path.replace("{workspace}", "w").replace("{operation}", "o");
    expect(savedEnvWorkerRouteOf("POST", path)).toEqual(row);
    expect(savedEnvWorkerRouteOf("GET", path)).toBeUndefined();
    expect(appRouteOf("POST", path)).toBeUndefined();
    expect(devRouteOf("POST", path)).toBeUndefined();
  }
  expect([...APP_ROUTES, ...DEV_ROUTES].some(row => row.path.includes("/v1/internal/"))).toBe(false);
});

it("inventories the four exact context worker routes without person authority", () => {
  expect(CORE_CONTEXT_WORKER_ROUTES.map(row => `${row.method} ${row.path}`)).toEqual([
    "GET /v1/internal/context-tools", "GET /v1/internal/design-review/packet", "POST /v1/internal/context-tools/call", "POST /v1/internal/mcp",
  ]);
  for (const row of CORE_CONTEXT_WORKER_ROUTES) {
    expect(coreContextWorkerRouteOf(row.method, row.path)).toEqual({ ...row, requires: "worker" });
    expect(coreContextWorkerRouteOf(row.method === "GET" ? "POST" : "GET", row.path)).toBeUndefined();
    expect(coreContextWorkerRouteOf(row.method, `${row.path}/extra`)).toBeUndefined();
    expect(contextAppRouteOf(row.method, row.path)).toBeUndefined();
    expect(contextDevRouteOf(row.method, row.path)).toBeUndefined();
  }
});


it("the existing PR feedback action paths retain their production scopes", () => {
  const taskPath = "/v1/dev/tasks/99999999-9999-4999-8999-999999999999";
  expect(contextDevRouteOf("GET", taskPath)?.requires).toBe("tasks:read");
  expect(contextDevRouteOf("GET", `${taskPath}/workflow/feedback`)?.requires).toBe("tasks:read");
  expect(contextDevRouteOf("POST", `${taskPath}/workflow/feedback`)).toBeUndefined();
  expect(contextAppRouteOf("GET", taskPath.replace("/v1/dev/", "/v1/app/") + "/workflow/feedback")).toBeUndefined();
  const id = "11111111-1111-4111-8111-111111111111";
  for (const [action, scope] of [["feedback-decision", "decisions:decide"], ["feedback-retry", "tasks:act"], ["keep-pull-requests", "tasks:act"]] as const) {
    const path = `/v1/dev/tasks/${id}/workflow/${action}`;
    expect(contextDevRouteOf("POST", path)?.requires).toBe(scope);
    expect(contextDevRouteOf("DELETE", path)).toBeUndefined();
  }
});

// CORE-PARITY: these existing MCP routes must remain admitted by the production scope table.
describe("core parity dev-route scopes", () => {
  it.each([
    ["POST", "workflow/decision", "decisions:decide"],
    ["POST", "workflow/retry", "tasks:act"],
    ["POST", "workflow/review", "tasks:act"],
    ["POST", "workflow/publish-retry", "tasks:act"],
    ["POST", "close", "tasks:act"],
    ["POST", "pull-requests", "tasks:act"],
    ["POST", "share", "tasks:share"],
    ["GET", "plan", "tasks:read"],
    ["GET", "diff", "tasks:read"],
  ])("keeps %s %s scoped to %s", (method, rest, requires) => {
    expect(contextDevRouteOf(method, `/v1/dev/tasks/11111111-1111-4111-8111-111111111111/${rest}`)?.requires).toBe(requires);
  });
});

// The retained plan-comment POST must stay admitted by the production scope registry.
it("core plan comments use the existing developer tasks:act scope", async () => {
  const { devRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
  const path = "/v1/dev/tasks/11111111-1111-4111-8111-111111111111/comments";
  expect(devRouteOf("POST", path)).toMatchObject({ requires: "tasks:act" });
  expect(devRouteOf("GET", path)).toMatchObject({ requires: "tasks:read" });
  expect(devRouteOf("DELETE", path)).toBeUndefined();
});

// The server-read routes belong to the outer DEV dispatcher, with no APP aliases.
describe("dedicated server-read route registration", () => {
  it("registers only the approved methods/scopes and no script-token APP alias", async () => {
    const { devRouteOf, appRouteOf } = await import("../../packages/broker/src/aws/dev-route-scopes.js");
    expect(devRouteOf("GET", "/v1/dev/tasks/start-requests/original")).toMatchObject({ requires: "tasks:read" });
    expect(devRouteOf("POST", "/v1/dev/company/connections/impact")).toMatchObject({ requires: "full" });
    expect(devRouteOf("DELETE", "/v1/dev/company/connections/impact")).toBeUndefined();
    expect(appRouteOf("GET", "/v1/app/task-start-requests/original")).toBeUndefined();
    expect(appRouteOf("POST", "/v1/app/github/disconnect-preview")).toBeUndefined();
  });
  it("reaches the outer broker and preserves the original operation ID", async () => {
    const { serverReadWorld } = await import("../support/server-read-world.js");
    const w = await serverReadWorld();
    const r = await w.start(); expect(r.status).toBe(200); expect(r.body.requestId).toBe(w.requestId);
    w.addInstallation(); const impact = await w.impact();
    expect(impact.status).toBe(200); expect(impact.body).not.toHaveProperty("requestId");
  });
});

it("task Ask history is a full-access GET route, distinct from asking", () => {
  expect(appRouteOf("GET", "/v1/app/projects/alpha/tasks/11111111-1111-4111-8111-111111111111/answers")).toMatchObject({ requires: "full" });
  expect(appRouteOf("POST", "/v1/app/projects/alpha/tasks/11111111-1111-4111-8111-111111111111/answers")).toBeUndefined();
});

import { toDocument } from "../../packages/broker/src/core/task-flow/records.js";
import { hostedFeedbackWorld } from "../support/hosted-pr-feedback-world.js";
import { engineStampKey } from "../../packages/broker/src/core-host/engine-stamp.js";

it.each([["GET", "feedback"], ["POST", "feedback-decision"], ["POST", "feedback-retry"], ["POST", "keep-pull-requests"]] as const)("the real developer broker reaches hosted %s %s and preserves missing-task answers", async (method, action) => {
  const w = await hostedFeedbackWorld(action === "feedback-retry" ? "BLOCKED" : "COMPLETE");
  w.h.deps.access.ownerActing = async principal => principal.personId === ADA ? { actorId: w.task.ownerKey } : undefined;
  let wrongCompany = false;
  let coreStatus: number | undefined;
  const entry: CoreTaskEntry = { route: async (request, caller) => {
    const response = await w.routes.route(request, { ...w.caller, principal: { ...w.caller.principal, personId: caller.developerId, companyId: wrongCompany ? "org_bbbbbbbbbbbbbbbbbbbb" : w.caller.principal.companyId } });
    coreStatus = response?.statusCode;
    return response;
  } };
  await setUp(undefined, "developer", entry);
  membership(ADA, w.h.deps.companyId, "member");
  const path = `/v1/dev/tasks/${w.task.taskId}/workflow/${action}`;
  const authorization = await cli();
  const options = { routeKey: "ANY /v1/dev/{proxy+}", body: action === "feedback-retry" ? { reviewDigest: w.request.reviewDigest } : action === "keep-pull-requests" ? { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision } : { ...w.request, decision: "DISMISS", selectedFindingIds: [], ownerNote: "The owner kept the pull request as it is." } };
  const missing = await call(method, path, authorization, options);
  db.set((await w.h.store.get(engineStampKey(w.task.taskId)))!);
  db.set(toDocument(w.task));
  if (action === "keep-pull-requests") {
    w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
    await w.h.store.put({ item: toDocument(w.task) });
    expect(await call("GET", `/v1/dev/tasks/${w.task.taskId}/workflow/feedback`, authorization, options)).toEqual(missing);
  }
  expect(contextDevRouteOf(method, path)?.requires).toBe(action === "feedback" ? "tasks:read" : action === "feedback-decision" ? "decisions:decide" : "tasks:act");
  const response = await call(method, path, authorization, options);
  expect(response.status).toBe(200);
  expect(JSON.stringify(response.body)).not.toContain(NOT_ON_THE_CORE_YET);
  expect(Object.keys(response.body).filter(key => key !== "requestId").sort()).toEqual(action === "feedback" ? ["review"] : action === "feedback-retry" ? ["started", "task"] : ["task"]);
  w.h.deps.access.ownerActing = async () => undefined;
  expect(await call(method, path, authorization, options)).toEqual(missing);
  expect(coreStatus).toBe(404);
  wrongCompany = true;
  expect(await call(method, path, authorization, options)).toEqual(missing);
  expect(coreStatus).toBe(401);
});

it.each([["GET", "feedback", "tasks:read"], ["POST", "feedback-decision", "decisions:decide"], ["POST", "feedback-retry", "tasks:act"], ["POST", "keep-pull-requests", "tasks:act"]] as const)("the developer broker enforces %s %s scope before the mounted handler", async (method, action, scope) => {
  const w = await hostedFeedbackWorld(action === "feedback-retry" ? "BLOCKED" : "COMPLETE");
  const route = vi.fn(async (request: BrokerRequest) => w.routes.route(request, w.caller));
  await setUp(undefined, "developer", { route });
  membership(ADA, w.h.deps.companyId, "member");
  db.set((await w.h.store.get(engineStampKey(w.task.taskId)))!);
  db.set(toDocument(w.task));
  const at = new Date(T0 - 60_000).toISOString();
  const client = { pk: "SIGNIN_CLIENTS", sk: "CLIENT#tool", entityType: "SIGN_IN_CLIENT", clientId: "tool", name: "Tool", audience: "tool", redirectUris: ["https://tool.example/callback"], loopback: false, installLevel: true, scopes: ["tasks:start"], secretHash: "f".repeat(64), createdAt: at, updatedAt: at, updatedBy: "operator" };
  db.set(client);
  person(ADA, "Ada", "s-tool", "tool");
  const authorization = await bearer({ aud: "tool", azp: "tool", sid: "s-tool", scope });
  const path = `/v1/dev/tasks/${w.task.taskId}/workflow/${action}`;
  const options = { routeKey: "ANY /v1/dev/{proxy+}", body: action === "feedback-retry" ? { reviewDigest: w.request.reviewDigest } : action === "keep-pull-requests" ? { requestId: w.request.requestId, expectedRevision: w.task.workflow!.revision } : w.request };
  expect((await call(method, path, authorization, options)).status).toBe(403);
  expect(route).not.toHaveBeenCalled();
  db.set({ ...client, scopes: [scope] });
  if (action === "keep-pull-requests") {
    w.task.workflow!.feedbackReview = { status: "COLLECTING", bundleRefs: w.task.workflow!.feedbackReview!.bundleRefs, threadObservations: [] };
    await w.h.store.put({ item: toDocument(w.task) });
  }
  expect((await call(method, path, authorization, options)).status).toBe(200);
  expect(route).toHaveBeenCalled();
});
