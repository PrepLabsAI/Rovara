// Lane L12: the core engine's own /v1/app/* routes on the broker's HTTP API (sessions, decision cards, how we work, script tokens, person erase).
//   - Off (no core entry): every /v1/app/* path on the core's route answers "route not found" and reads nothing; on any other route the broker answers as before (the golden is in
//     aws-core-root-golden.test.ts).
//   - On: a method and path with no row in the route table is refused before anyone is authenticated; the developer token is verified by the broker; a sign-in client reaches a row only
//     with its scope; the core gets the verified caller (the step-up only from the verified token) and never the credential; the company is the caller's LIVE membership.
//   - Two companies over one core: a person of one company never sees or reaches the other's script tokens or people.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_SCOPES, orgProjectCatalogKey, projectRevisionKey, type ClientScope, type JsonValue, type OrgId, type ProjectDefinition } from "@agentx/contracts";
import { APP_ROUTES, DEV_ROUTES, appRouteOf, devRouteOf, type DevRoute } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { CORE_APP_SIGN_IN_AGAIN, CORE_APP_UNAVAILABLE, coreAppEntryFrom, type CoreAppEntry } from "../../packages/broker/src/aws/core-app-routes.js";
import { deployedCallerFromMembership, membershipWithRoleFromDynamo, personStandingFromDynamo, projectGrantFromDynamo } from "../../packages/broker/src/aws/core-engine-root.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import type { CoreEntryCaller } from "../../packages/broker/src/aws/engine-boundary.js";
import { createCoreHostApp } from "../../packages/broker/src/core-host/index.js";
import { NOT_ON_THE_CORE_YET, createCoreDevRoutes } from "../../packages/broker/src/core-host/dev-routes.js";
import { ERASE_ON_A_PAGE, createPersonEraseRoute } from "../../packages/broker/src/core-host/person-erase-route.js";
import { noLearningToErase, noWikiToErase } from "../../packages/broker/src/core/people/erase.js";
import { createOwnerTaskAccess } from "../../packages/broker/src/core/task-flow/access.js";
import type { BrokerRequest, BrokerResponse } from "../../packages/broker/src/handler.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { FAKE_COMPANY, createFakeWorld, type FakeWorld } from "../support/core-host-fakes.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NAMED: readonly ClientScope[] = ["profile:name", "projects:members", "projects:create", "tasks:read", "tasks:start", "tasks:act", "tasks:share", "decisions:decide"];
const ROUTE_KEY = "ANY /v1/app/{proxy+}";
const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
// The fake world's clock: the broker's token checks and the core's step-up age read the same time.
const T0 = Date.parse("2026-11-15T10:00:00.000Z");
const ADA = "a".repeat(64);
const BO = "b".repeat(64);
const CY = "c".repeat(64);
const OTHER = "org_corehost00000000000b" as OrgId;
const sample = (path: string) => path.replace(/\{[A-Za-z]+\}/g, "x1");

// ---- The table ----

describe("the /v1/app route table", () => {
  it("gives every row a named scope or full access, never `none`, and one row per method and path, all under /v1/app/", () => {
    expect([...CLIENT_SCOPES].sort()).toEqual([...NAMED].sort());
    for (const route of APP_ROUTES) {
      expect([...NAMED, "full"], `${route.method} ${route.path}`).toContain(route.requires);
      expect(route.path.startsWith("/v1/app/")).toBe(true);
    }
    const keys = APP_ROUTES.map((route) => `${route.method} ${route.path.replace(/\{[A-Za-z]+\}/g, "{}")}`);
    expect(new Set(keys).size).toBe(keys.length);
    // The two tables never overlap: a /v1/dev path is never a core app row, and the reverse.
    for (const route of APP_ROUTES) expect(devRouteOf(route.method, sample(route.path))).toBeUndefined();
    for (const route of DEV_ROUTES) expect(appRouteOf(route.method, sample(route.path))).toBeUndefined();
  });

  // Written out by hand: what the core serves on AWS (core-host/dev-routes.ts over the session, decision, playbook and script-token handlers, and the person erase), with its scope.
  const SERVED: Array<[string, string, ClientScope | "full"]> = [
    ["GET", "/v1/app/sessions", "tasks:read"], ["GET", "/v1/app/sessions/s1", "tasks:read"],
    ["POST", "/v1/app/sessions/s1/follow", "tasks:read"], ["DELETE", "/v1/app/sessions/s1/follow", "tasks:read"], ["POST", "/v1/app/sessions/s1/unfollow", "tasks:read"], ["POST", "/v1/app/sessions/s1/presence", "tasks:read"],
    ["POST", "/v1/app/sessions/s1/stop", "tasks:act"], ["POST", "/v1/app/sessions/s1/retry", "tasks:act"], ["POST", "/v1/app/sessions/s1/messages", "tasks:act"],
    ["POST", "/v1/app/sessions/s1/answers", "tasks:act"], ["POST", "/v1/app/sessions/s1/revise-plan", "tasks:act"], ["POST", "/v1/app/sessions/s1/close", "tasks:act"],
    ["GET", "/v1/app/decisions", "decisions:decide"], ["POST", "/v1/app/decisions/plan/t1/approve", "decisions:decide"], ["POST", "/v1/app/decisions/plan/t1/reject", "decisions:decide"],
    ["POST", "/v1/app/decisions/plan/t1/request-changes", "decisions:decide"], ["POST", "/v1/app/decisions/plan/t1/evidence-opened", "decisions:decide"],
    ["GET", "/v1/app/projects/payments/how-we-work", "full"], ["GET", "/v1/app/projects/payments/playbook", "full"],
    // DEC 254z-amend3: the project's test environment state, read only.
    ["GET", "/v1/app/projects/payments/test-environment", "full"],
    // L4-MF1: the project's saved environment image panel, read only.
    ["GET", "/v1/app/projects/payments/environment-image", "full"],
    ["GET", "/v1/app/script-tokens", "full"], ["POST", "/v1/app/script-tokens", "full"], ["POST", "/v1/app/script-tokens/tok_1/revoke", "full"],
    ["POST", "/v1/app/people/p1/erase", "full"],
    // Guided onboarding L2-3: the hosted setup run.
    ["GET", "/v1/app/projects/payments/setup-agent", "full"], ["POST", "/v1/app/projects/payments/setup-agent", "full"], ["POST", "/v1/app/projects/payments/setup-agent/stop", "full"],
    ["GET", "/v1/app/projects/payments/setup-agent/journal", "full"],
    // Web task channel C7: the in-app inbox (core/notify/inbox.ts over core-host/inbox-routes.ts).
    ["GET", "/v1/app/inbox", "tasks:read"], ["POST", "/v1/app/inbox/read", "tasks:read"], ["POST", "/v1/app/notify/unsubscribe", "full"],
    // Wiki W0: a project's free file map.
    ["GET", "/v1/app/projects/payments/wiki-map", "full"], ["POST", "/v1/app/projects/payments/wiki-map", "full"],
    // Lead 4 W2: the project wiki's reads.
    ["GET", "/v1/app/projects/payments/wiki", "full"], ["GET", "/v1/app/projects/payments/wiki/search", "full"], ["GET", "/v1/app/projects/payments/wiki/pages/overview", "full"], ["GET", "/v1/app/projects/payments/wiki/pages/overview/sources", "full"],
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
    // Lead 4 N1: the nightly upkeep switch.
    ["GET", "/v1/app/projects/payments/upkeep", "full"], ["PUT", "/v1/app/projects/payments/upkeep", "full"],
    // L4-B5: the task's log of questions, answers and decisions (core/task-log/read.ts), for whoever may read the session.
    ["GET", "/v1/app/sessions/s1/log", "tasks:read"],
    // Lead 4 PCF: the plan card's "Change" lists the open features (the same people as the filing).
    ["GET", "/v1/app/tasks/t1/feature-choices", "full"],
    // L4-P3: the company's one control over Rovara's automatic runs.
    ["GET", "/v1/app/company/system-runs", "full"], ["PUT", "/v1/app/company/system-runs", "full"],
    // L4-EVC (DEC 254zzz20): the eval card and its one approval.
    ["GET", "/v1/app/projects/payments/setup-agent/eval", "full"], ["POST", "/v1/app/projects/payments/setup-agent/eval-approve", "full"], ["POST", "/v1/app/projects/payments/setup-agent/eval-decide", "full"], ["POST", "/v1/app/projects/payments/setup-agent/eval-health", "full"],
  ];
  it.each(SERVED)("has a row for %s %s needing %s", (method, path, scope) => {
    expect(appRouteOf(method, path)?.requires).toBe(scope);
  });

  it("has a row only for what the core serves on AWS", () => {
    expect(APP_ROUTES).toHaveLength(SERVED.length);
    // The laptop's own routes, the asks (not built on AWS), a playbook edit (Cloud's editor), other methods, extra or empty segments and other prefixes.
    for (const [method, path] of [
      ["POST", "/v1/app/sessions/s1/log"], ["PUT", "/v1/app/sessions/s1/log"], ["DELETE", "/v1/app/sessions/s1/log"], ["GET", "/v1/app/sessions/s1/logs"], ["GET", "/v1/app/sessions/s1/log/x"], ["POST", "/v1/app/sessions/s1/ask"], ["GET", "/v1/app/sessions/s1/asks/ask_00000000000000000000"], ["GET", "/v1/app/triggers"], ["POST", "/v1/app/chains"], ["GET", "/v1/local/sessions"],
      ["PUT", "/v1/app/projects/payments/playbook"], ["POST", "/v1/app/projects/payments/playbook"],
      ["POST", "/v1/app/projects/payments/test-environment/propose"], ["GET", "/v1/app/projects/payments/test-environment/approve"], ["PUT", "/v1/app/projects/payments/test-environment/approve"], ["POST", "/v1/app/projects/payments/test-environment"], ["GET", "/v1/app/projects/payments/test-environment/service-images"], ["GET", "/v1/app/people/p1/erase"], ["POST", "/v1/app/people/p1"],
      ["POST", "/v1/app/decisions/plan/t1/x/approve"], ["POST", "/v1/app/decisions/approve"], ["GET", "/v1/app/sessions/"], ["GET", "/v1/app/sessions//stop"], ["GET", "/v1/app/"],
      // The laptop page's own setup acts (a typed command, eval confirm, the setup check's other methods) are not served on AWS, nor other methods on the setup run.
      ["POST", "/v1/app/projects/payments/setup-agent/command"], ["POST", "/v1/app/projects/payments/setup-agent/eval-confirm"], ["GET", "/v1/app/projects/payments/setup-agent/decide"], ["GET", "/v1/app/projects/payments/setup-agent/host-decide"], ["GET", "/v1/app/projects/payments/setup-agent/confirm"], ["PUT", "/v1/app/projects/payments/setup-check"], ["DELETE", "/v1/app/projects/payments/setup-check"],
      ["POST", "/v1/app/projects/payments/setup-agent/journal"], ["POST", "/v1/app/projects/payments/setup-agent/eval"], ["GET", "/v1/app/projects/payments/setup-agent/eval-approve"], ["GET", "/v1/app/projects/payments/setup-agent/eval-health"], ["GET", "/v1/app/projects/payments/setup-agent/eval-decide"], ["GET", "/v1/app/projects/payments/setup-agent/stop"], ["PUT", "/v1/app/projects/payments/setup-agent"], ["DELETE", "/v1/app/projects/payments/setup-agent"],
      ["PUT", "/v1/app/projects/payments/wiki-map"], ["DELETE", "/v1/app/projects/payments/wiki-map"], ["GET", "/v1/app/projects/payments/wiki-map/extra"], ["POST", "/v1/app/projects/payments/wiki-maps"],
      // The saved environment image has no Reset or setting write here (those stay Cloud's / the laptop's): only the read.
      ["POST", "/v1/app/projects/payments/environment-image"], ["PUT", "/v1/app/projects/payments/environment-image"], ["PUT", "/v1/app/projects/payments/environment-image/setting"], ["GET", "/v1/app/projects/payments/environment-image/setting"], ["GET", "/v1/app/projects/payments/environment-images"],
      // The wiki has no write route here (the build and corrections bring their own), nor other paths under it.
      ["POST", "/v1/app/projects/payments/wiki"], ["PUT", "/v1/app/projects/payments/wiki/pages/overview"], ["DELETE", "/v1/app/projects/payments/wiki/pages/overview"], ["GET", "/v1/app/projects/payments/wiki/pages"], ["GET", "/v1/app/projects/payments/wiki/notes"],
      // Corrections: only the methods and paths that exist (a note is deleted by POST .../delete; there is no DELETE, PUT or PATCH row, and no read of the notes list).
      ["DELETE", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001"], ["PUT", "/v1/app/projects/payments/wiki/pages/overview/notes"], ["GET", "/v1/app/projects/payments/wiki/pages/overview/notes"],
      ["GET", "/v1/app/projects/payments/wiki/pages/overview/flags"], ["POST", "/v1/app/projects/payments/wiki/pages/overview/corrections"], ["POST", "/v1/app/projects/payments/wiki/disputed"], ["GET", "/v1/app/projects/payments/wiki/pages/overview/notes/note0001/approve"],
      // The report: no write on the rows, no delete, no people route (a later slice), no other method on a feature.
      ["POST", "/v1/app/org/report/tasks"], ["PUT", "/v1/app/org/report/features"], ["DELETE", "/v1/app/org/report/features/ft_1"], ["GET", "/v1/app/org/report/features/ft_1/rename"], ["POST", "/v1/app/org/report/features/ft_1/delete"],
      ["GET", "/v1/app/org/report/people"], ["GET", "/v1/app/tasks/t1/feature"], ["POST", "/v1/app/tasks/t1/feature/extra"], ["POST", "/v1/app/tasks/feature"],
      // The wiki build controls: no other methods, no other tails.
      ["PUT", "/v1/app/projects/payments/wiki-build"], ["DELETE", "/v1/app/projects/payments/wiki-build"], ["GET", "/v1/app/projects/payments/wiki-build/stop"], ["GET", "/v1/app/projects/payments/wiki-build/delete"], ["POST", "/v1/app/projects/payments/wiki-build/extra"], ["GET", "/v1/app/projects/payments/wiki-builds"],
      // The start box's suggestion is a POST on its own path; starting work itself (`/code`) is Cloud's route, and nothing else sits under it.
      ["GET", "/v1/app/projects/payments/code/suggest"], ["PUT", "/v1/app/projects/payments/code/suggest"], ["POST", "/v1/app/projects/payments/code"], ["POST", "/v1/app/projects/payments/code/suggest/x"], ["POST", "/v1/app/projects/payments/code/start"],
      // The answer route is one POST: no read of answers, no other writes, no deeper paths.
      ["GET", "/v1/app/projects/payments/answers"], ["PUT", "/v1/app/projects/payments/answers"], ["DELETE", "/v1/app/projects/payments/answers"], ["POST", "/v1/app/projects/payments/answers/a1"], ["POST", "/v1/app/projects/payments/answer"],
      // J5: "Not right" is one POST, and the gap list one GET.
      ["GET", "/v1/app/projects/payments/answers/a0123456789/not-right"], ["PUT", "/v1/app/projects/payments/answers/a0123456789/not-right"], ["POST", "/v1/app/projects/payments/answers/a0123456789/not-right/x"], ["POST", "/v1/app/projects/payments/wiki/gaps"], ["DELETE", "/v1/app/projects/payments/wiki/gaps"],
      // The upkeep switch: GET and PUT only, no other tail.
      ["POST", "/v1/app/projects/payments/upkeep"], ["DELETE", "/v1/app/projects/payments/upkeep"], ["PATCH", "/v1/app/projects/payments/upkeep"], ["GET", "/v1/app/projects/payments/upkeep/extra"], ["PUT", "/v1/app/projects/payments/upkeeps"],
      ["POST", "/v1/app/tasks/t1/feature-choices"], ["GET", "/v1/app/tasks/t1/feature-choices/extra"], ["GET", "/v1/app/tasks/feature-choices"],
      // The company's automatic-runs control: GET and PUT only, no other tail.
      ["POST", "/v1/app/company/system-runs"], ["DELETE", "/v1/app/company/system-runs"], ["PATCH", "/v1/app/company/system-runs"], ["GET", "/v1/app/company/system-runs/extra"], ["PUT", "/v1/app/company/system-run"],
      ["PATCH", "/v1/app/sessions"], ["HEAD", "/v1/app/sessions"], ["get", "/v1/app/sessions"], ["GET", "/v1/appx/sessions"], ["GET", "/v1/dev/app/sessions"],
    ] as const) expect(appRouteOf(method, path), `${method} ${path}`).toBeUndefined();
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
/** The Rovara CLI's token for a person; `stepUpSecondsAgo`: the verified token states a passkey step-up that long ago. */
const cli = (who = ADA, stepUpSecondsAgo?: number) => bearer({ sub: who, sid: `s-${who.slice(0, 2)}`, ...(stepUpSecondsAgo === undefined ? {} : { step_up_at: T0 / 1000 - stepUpSecondsAgo, step_up_amr: "passkey" }) });
/** The Cloud web app's token for ADA, with these scopes. */
const scoped = (...scopes: ClientScope[]) => bearer({ aud: "web-app", azp: "web-app", sid: "s-cloud", ...(scopes.length === 0 ? {} : { scope: scopes.join(" ") }) });

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

async function setUp(coreApp: CoreAppEntry | undefined, mode: "developer" | "linking" = "developer"): Promise<void> {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "staging", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(), clientRoutes: true,
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    ...(coreApp === undefined ? {} : { coreApp }),
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

  it("answers 'route not found' on the legacy (linking-only) deployment too", async () => {
    const { entry, seen } = spyEntry();
    await setUp(entry, "linking");
    expect(await call("GET", "/v1/app/script-tokens", await cli())).toMatchObject({ status: 404, body: { error: { message: "route not found" } } });
    expect(seen).toEqual([]);
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

  it("hands the core the verified caller with the token's step-up, and the request without its credential; the answer comes back as the core gave it, never cached", async () => {
    const authorization = await cli(ADA, 30);
    const answer = await call("POST", "/v1/app/script-tokens?x=1", authorization, { body: { requestId: "r1" } });
    expect(answer).toMatchObject({ status: 200, body: { served: true } });
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(spy.seen).toHaveLength(1);
    const [{ request, caller }] = spy.seen as [{ request: BrokerRequest; caller: CoreEntryCaller }];
    expect(caller).toMatchObject({ developerId: ADA, sessionId: "s-aa", name: "Ada", stepUp: { at: new Date(T0 - 30_000).toISOString(), method: "passkey" } });
    expect(request).toMatchObject({ method: "POST", path: "/v1/app/script-tokens?x=1", body: JSON.stringify({ requestId: "r1" }) });
    expect(JSON.stringify(request)).not.toContain(authorization.slice(7));
    expect(request.headers.authorization).toBeUndefined();
  });

  it("never takes a step-up from a header, a query or a body: only the verified token's", async () => {
    await call("POST", "/v1/app/people/p1/erase?step_up_at=1", await cli(), { body: { step_up_at: T0 / 1000, stepUp: { at: new Date(T0).toISOString(), method: "passkey" } } });
    await handler({ rawPath: "/v1/app/people/p1/erase", routeKey: ROUTE_KEY, headers: { authorization: await cli(), "x-step-up-at": String(T0 / 1000) }, requestContext: { requestId: "r", http: { method: "POST" } } });
    expect(spy.seen).toHaveLength(2);
    for (const { caller } of spy.seen) expect(caller.stepUp).toBeUndefined();
  });

  it("answers 'route not found' when the core does not serve the path, and passes the core's refusals through as they are", async () => {
    spy = spyEntry((request) => request.path.startsWith("/v1/app/decisions") ? { statusCode: 404, headers: {}, body: JSON.stringify({ error: { code: "NOT_FOUND", message: NOT_ON_THE_CORE_YET } }) } : undefined);
    await setUp(spy.entry);
    expect(await call("GET", "/v1/app/sessions", await cli())).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } });
    expect(await call("GET", "/v1/app/decisions", await cli())).toMatchObject({ status: 404, body: { error: { message: NOT_ON_THE_CORE_YET } } });
  });

  it("also serves a /v1/app path that reached the broker on another route (one answer whatever the route), and still refuses an unknown one", async () => {
    expect(await call("GET", "/v1/app/script-tokens", await cli(), { routeKey: "ANY /{proxy+}" })).toMatchObject({ status: 200, body: { served: true } });
    expect(await call("GET", "/v1/app/triggers", await cli(), { routeKey: "ANY /{proxy+}" })).toMatchObject({ status: 404, body: { error: { message: "route not found" } } });
  });
});

describe("the core's /v1/app routes with a sign-in client's token (a named environment)", () => {
  let spy: ReturnType<typeof spyEntry>;
  const cloudClient = (scopes: readonly ClientScope[], fullAccess = false) => {
    const at = new Date(T0 - 60_000).toISOString();
    db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, secretHash: "f".repeat(64), ...(scopes.length === 0 ? {} : { scopes: [...scopes] }), ...(fullAccess ? { fullAccess: true } : {}), createdAt: at, updatedAt: at, updatedBy: "admin" });
  };
  const scopeRefusal = (route: DevRoute) => route.requires === "full"
    ? `Web App needs full access for ${route.method} ${route.path}, which is off for it; an administrator can turn it on`
    : `Web App needs the ${route.requires} scope for ${route.method} ${route.path}; an administrator can allow it with that scope`;
  beforeEach(async () => { spy = spyEntry(); await setUp(spy.entry); });

  it("lets each scope through exactly its own rows, and refuses every other row naming the missing scope, before the core", async () => {
    cloudClient(NAMED);
    for (const scope of NAMED) {
      const authorization = await scoped(scope);
      for (const route of APP_ROUTES) {
        spy.seen.length = 0;
        const response = await call(route.method, sample(route.path), authorization);
        if (route.requires === scope) {
          expect(response.status, `${scope} on ${route.method} ${route.path}`).toBe(200);
          expect(spy.seen, `${scope} on ${route.method} ${route.path}`).toHaveLength(1);
        } else {
          expect(response, `${scope} on ${route.method} ${route.path}`).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN", message: scopeRefusal(route) } } });
          expect(spy.seen).toEqual([]);
        }
      }
    }
  });

  it("keeps the full-access rows (script tokens, person erase, how we work) off unless an administrator turns full access on", async () => {
    cloudClient(NAMED);
    const all = await scoped(...NAMED);
    const full = APP_ROUTES.filter((route) => route.requires === "full");
    expect(full.map((route) => `${route.method} ${route.path}`)).toEqual(expect.arrayContaining(["POST /v1/app/people/{personId}/erase", "POST /v1/app/script-tokens"]));
    for (const route of full) expect(await call(route.method, sample(route.path), all), `${route.method} ${route.path}`).toMatchObject({ status: 403, body: { error: { message: scopeRefusal(route) } } });
    expect(spy.seen).toEqual([]);
    cloudClient([], true);
    for (const route of APP_ROUTES) expect((await call(route.method, sample(route.path), await scoped())).status, `${route.method} ${route.path}`).toBe(200);
    // A client's token never carries a step-up to the core.
    expect(spy.seen.every(({ caller }) => caller.stepUp === undefined)).toBe(true);
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
    env: { ROVARA_CORE_ENGINE: "on" }, modules: world.modules, context: () => world.context(), nowMs: () => world.clock.now,
    runtime: () => ({ callbackSigningKey: Buffer.alloc(32, 7), access: createOwnerTaskAccess(), repositoryGrantKey: Buffer.alloc(32, 5), repositoryCredential: async () => ({ token: "unused" }), now: () => new Date(world.clock.now), log: () => undefined, services: SERVICES, ciReporting: { honest: true as const, ciMode: () => "their_ci_fix" as const } }),
  });
  const membershipOf = membershipWithRoleFromDynamo(db, "signin");
  const routes = createCoreDevRoutes({
    app, companyOf: async (caller) => await membershipOf(caller.principal.personId),
    wiring: () => ({ origin: () => "https://api.example", scriptTokens: {}, canReadProject: projectGrantFromDynamo(db, "state") }),
  });
  const registry = await app.registry();
  const personErase = createPersonEraseRoute({
    app, standing: personStandingFromDynamo(db, "signin"), companyOf: async (who) => await membershipOf(who.principal.personId),
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
  });
  const makeToken = { requestId: "", name: "ci", projects: ["payments"], permissions: ["read"] };

  it("makes a script token only with a fresh step-up from the verified token, and shows it only within the maker's company", async () => {
    expect(await call("POST", "/v1/app/script-tokens", await cli(ADA), { body: { ...makeToken, requestId: randomUUID() } })).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED" } } });
    expect(await call("POST", "/v1/app/script-tokens", await cli(ADA, 3_600), { body: { ...makeToken, requestId: randomUUID() } })).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED" } } });
    const made = await call("POST", "/v1/app/script-tokens", await cli(ADA, 30), { body: { ...makeToken, requestId: randomUUID() } });
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
    expect((await call("POST", `/v1/app/script-tokens/${encodeURIComponent(tokenId)}/revoke`, await cli(BO, 30))).status).toBe(404);
    expect((await call("GET", "/v1/app/script-tokens", await cli(ADA))).body).toMatchObject({ tokens: [{ tokenId, status: "active" }] });
  });

  it("uses live membership for canCreate and creation, while a demoted member can still list and revoke their own tokens", async () => {
    const authorization = await cli(ADA, 30);
    const create = () => call("POST", "/v1/app/script-tokens", authorization, { body: { ...makeToken, requestId: randomUUID() } });
    const own = await create();
    expect(own.status).toBe(201);
    const tokenId = (own.body as { token: { tokenId: string } }).token.tokenId;
    expect((await call("GET", "/v1/app/script-tokens", authorization)).body).toMatchObject({ canCreate: true });
    // A second person's token in this company stays hidden from the demoted member.
    membership(BO, FAKE_COMPANY, "owner");
    const others = await call("POST", "/v1/app/script-tokens", await cli(BO, 30), { body: { ...makeToken, requestId: randomUUID() } });
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

  it("erases a removed person only for an admin of that person's company with a fresh step-up; another company's admin is told 'not found'", async () => {
    const erase = async (who: string, stepUp?: number) => await call("POST", `/v1/app/people/${CY}/erase`, await cli(who, stepUp), { body: { requestId: randomUUID() } });
    expect(await erase(BO, 30)).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(await erase(ADA)).toMatchObject({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: ERASE_ON_A_PAGE } } });
    const done = await erase(ADA, 30);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ receipt: expect.any(Object) as unknown });
    expect(JSON.stringify(done.body)).not.toContain("Cy");
  });

  it("takes the company from LIVE membership: a person removed from their company, or never in one, is asked to sign in again", async () => {
    membership(BO, OTHER, "admin", new Date(T0 - 1_000).toISOString());
    expect(await call("GET", "/v1/app/script-tokens", await cli(BO))).toMatchObject({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: CORE_APP_SIGN_IN_AGAIN } } });
    expect(await call("GET", "/v1/app/script-tokens", await cli(CY))).toMatchObject({ status: 401, body: { error: { code: "UNAUTHENTICATED" } } });
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
