// Spec 063 phase 063c (FR-004, FR-005): a registered service asks Rovara who its signed-in person is and what they can
// use now, with the person's own token for that service or, for a confidential service, by developer ID. Every
// refusal is the same 401; a live check means an ended sign-in or a revoked developer is refused at once.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import type { AccessCheckContext, AccessCheckRule } from "../../packages/broker/src/developer/access-rules.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-09-27T12:00:00.000Z");
const SECRET = "scheduler-secret-0123456789abcdefghijklmnop";
const signer = localSigner();

let db: FakeDynamoDb;
let handler: AdminHandler;
/** A host's stricter rules (owner decision 132); each test sets its own. */
const rules: AccessCheckRule[] = [];
let channelMembers: ReturnType<typeof vi.fn<(request: ChannelMembersRequest) => Promise<ChannelMembersResponse>>>;

const clientClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: "scheduler", azp: "scheduler", sub: developerId, amr: "oidc", env: "staging", sid: "s-client", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...overrides,
});
async function signed(jwt: Record<string, unknown>): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(jwt)).toString("base64url")}`;
  return `${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
const basic = (clientId: string, secret: string) => `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
async function access(authorization: string, body?: unknown, path = "/v1/dev/access") {
  const response = await handler({
    rawPath: path, headers: { authorization }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: { requestId: "r", http: { method: "POST" } },
  });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}
const bearer = async (overrides: Record<string, unknown> = {}) => access(`Bearer ${await signed(clientClaims(overrides))}`);

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001"] }));
  rules.length = 0;
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true }, slackTeamId: "T0TEAM1", signInTableName: "signin", channelMembers,
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    accessRules: rules,
  };
  ({ db, handler } = await createAdminBroker({ developer: config }));
  const at = new Date(T0 - 60_000).toISOString();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#scheduler", entityType: "SIGN_IN_CLIENT", clientId: "scheduler", name: "Scheduler", audience: "scheduler", redirectUris: ["https://scheduler.example.com/callback"], loopback: true,
    secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: at, updatedAt: at, updatedBy: "admin" });
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#dashboard", entityType: "SIGN_IN_CLIENT", clientId: "dashboard", name: "Dashboard", audience: "dashboard", redirectUris: ["https://dash.example.com/cb"], loopback: false, createdAt: at, updatedAt: at, updatedBy: "admin" });
  db.set({ pk: "SESSION#s-client", sk: "META", sessionId: "s-client", developerId, amr: "oidc", clientId: "scheduler", administrator: true, startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: "SESSION#s-cli", sk: "META", sessionId: "s-cli", developerId, amr: "oidc", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", slackUserId: "U0ADA0001", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAY0001", teamId: "T0TEAM1", channelId: "C0PAY0001", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
  db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000007", entityType: "PROJECT", definition: { name: "payments-api", revision: 7 } });
  db.set({ pk: "PROJECT#solo", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "solo", revision: 1 } });
  db.set({ pk: "PROJECT#hidden", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "hidden", revision: 1 } });
  db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#solo", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "solo", role: "developer" });
});

describe("POST /v1/dev/access with the person's token for the service (FR-004)", () => {
  it("answers who they are, that they are an administrator, and the projects Rovara's rules give them now", async () => {
    const answer = await bearer();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({
      developerId, displayName: "Ada", administrator: true, notices: [],
      projects: [{ name: "payments-api", access: "channel" }, { name: "solo", access: "granted" }],
    });
  });

  it("lists the projects they administer too (spec 065), once each, and only a registered one", async () => {
    db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#hidden", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "hidden", role: "administrator" });
    db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#gone", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "gone", role: "administrator" });
    expect((await bearer()).body.projects).toEqual([
      { name: "payments-api", access: "channel" }, { name: "solo", access: "granted" }, { name: "hidden", access: "administrator" },
    ]);
  });

  it("reads grants live: a revoked grant is gone on the next call", async () => {
    db.delete(`MEMBER#${developerId}`, "PROJECT#solo");
    expect((await bearer()).body.projects).toEqual([{ name: "payments-api", access: "channel" }]);
  });

  it("is not an administrator unless the session recorded it", async () => {
    db.set({ ...db.get("SESSION#s-client", "META")!, administrator: undefined });
    expect((await bearer()).body.administrator).toBe(false);
  });

  it("refuses an ended, revoked or admin-ended sign-in, and a revoked developer, with the same 401", async () => {
    const refusals: Array<() => void> = [
      () => db.set({ ...db.get("SESSION#s-client", "META")!, revokedAt: new Date(T0).toISOString() }),
      () => db.set({ ...db.get("SESSION#s-client", "META")!, endsAt: T0 / 1000 - 1 }),
      () => db.set({ ...db.get(`DEVELOPER#${developerId}`, "META")!, sessionsEndedAt: new Date(T0 + 1_000).toISOString() }),
      () => db.set({ ...db.get(`DEVELOPER#${developerId}`, "META")!, revoked: true }),
      () => db.delete("SIGNIN_CLIENTS", "CLIENT#scheduler"),
    ];
    const bodies = new Set<string>();
    for (const refuse of refusals) {
      const before = { session: db.get("SESSION#s-client", "META")!, developer: db.get(`DEVELOPER#${developerId}`, "META")!, client: db.get("SIGNIN_CLIENTS", "CLIENT#scheduler") };
      refuse();
      const answer = await bearer();
      expect(answer.status).toBe(401);
      bodies.add(JSON.stringify((answer.body as { error?: unknown }).error));
      db.set(before.session);
      db.set(before.developer);
      if (before.client !== undefined) db.set(before.client);
    }
    expect(bodies.size).toBe(1);
  });

  it("refuses another client's token, the CLI's token, and a session of another client", async () => {
    expect((await bearer({ aud: "dashboard", azp: "dashboard" })).status).toBe(401);
    expect((await bearer({ aud: "agentx-developer", azp: undefined, sid: "s-cli" })).status).toBe(401);
    expect((await bearer({ aud: "scheduler", azp: "dashboard" })).status).toBe(401);
    expect((await bearer({ sid: "s-cli" })).status).toBe(401);
    expect((await access("Bearer not-a-token")).status).toBe(401);
  });
});

describe("POST /v1/dev/access by developer ID, for a confidential service (FR-004)", () => {
  it("answers with the service's secret, never as an administrator", async () => {
    const answer = await access(basic("scheduler", SECRET), { developerId });
    expect(answer).toMatchObject({ status: 200, body: { developerId, administrator: false, projects: [{ name: "payments-api" }, { name: "solo" }] } });
  });

  it("refuses a wrong secret, a public client, a token with a developer ID, and an unknown developer", async () => {
    expect((await access(basic("scheduler", "wrong"), { developerId })).status).toBe(401);
    expect((await access(basic("dashboard", "anything"), { developerId })).status).toBe(401);
    expect((await access(basic("scheduler", SECRET))).status).toBe(401);
    expect((await access(basic("scheduler", SECRET), { developerId: "e".repeat(64) })).status).toBe(401);
    expect((await access(`Bearer ${await signed(clientClaims())}`, { developerId })).status).toBe(401);
  });
});

describe("a client's token on Rovara's own routes (FR-003)", () => {
  it("is refused, even naming a client session", async () => {
    const response = await handler({ rawPath: "/v1/dev/projects", headers: { authorization: `Bearer ${await signed(clientClaims())}` }, requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(response.statusCode).toBe(401);
    // A CLI-shaped token that names a client's session is refused too.
    const forged = await handler({ rawPath: "/v1/dev/projects", headers: { authorization: `Bearer ${await signed(clientClaims({ aud: "agentx-developer", azp: undefined }))}` }, requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(forged.statusCode).toBe(401);
  });
});

describe("a host's stricter rules on the access check (owner decision 132)", () => {
  it("are told who asked, how, and the session when the person's own token asked", async () => {
    const seen: AccessCheckContext[] = [];
    rules.push((context) => { seen.push(context); return undefined; });
    expect((await bearer()).status).toBe(200);
    expect((await access(basic("scheduler", SECRET), { developerId })).status).toBe(200);
    expect(seen[0]).toEqual({ clientId: "scheduler", via: "token", developerId, session: { sessionId: "s-client", amr: "oidc", startedAt: new Date(T0).toISOString(), administrator: true }, now: T0 });
    expect(seen[1]).toEqual({ clientId: "scheduler", via: "client_secret", developerId, now: T0 });
  });

  it("can refuse with the access check's one 401, as a fresh-sign-in rule would", async () => {
    const plain = await access("Bearer not-a-token");
    rules.push((context) => (context.session !== undefined && context.now - Date.parse(context.session.startedAt) < 5 * 60_000 ? undefined : { refuse: true }));
    expect((await bearer()).status).toBe(200);
    vi.setSystemTime(T0 + 10 * 60_000);
    const refused = await bearer();
    expect(refused.status).toBe(401);
    expect((refused.body as { error?: unknown }).error).toEqual((plain.body as { error?: unknown }).error);
    expect((await access(basic("scheduler", SECRET), { developerId })).status).toBe(401);
  });

  it("refuses when a rule throws: a broken stricter rule never opens", async () => {
    rules.push(() => { throw new Error("approval store down"); });
    expect((await bearer()).status).toBe(401);
  });

  it("can take administrator away and keep only some projects, but never add a project or make an administrator", async () => {
    rules.push(() => ({ administrator: false, projects: ["solo", "hidden"] }));
    const narrowed = await bearer();
    expect(narrowed.body).toMatchObject({ administrator: false, projects: [{ name: "solo", access: "granted" }] });
    rules.length = 0;
    rules.push(() => ({ administrator: true, projects: ["payments-api", "solo", "hidden"] }) as unknown as { projects: string[] });
    const widened = await access(basic("scheduler", SECRET), { developerId });
    expect(widened.body).toMatchObject({ administrator: false, projects: [{ name: "payments-api" }, { name: "solo" }] });
  });

  it("never gives back a project the rules took away, even one the person administers (spec 065)", async () => {
    db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#hidden", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "hidden", role: "administrator" });
    // Positive control: without a rule the administered project is in the answer.
    expect((await bearer()).body.projects).toContainEqual({ name: "hidden", access: "administrator" });
    rules.push(() => ({ projects: ["solo"] }));
    const narrowed = await bearer();
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.projects).toEqual([{ name: "solo", access: "granted" }]);
    expect(JSON.stringify(narrowed.body.projects)).not.toContain("hidden");
    const byId = await access(basic("scheduler", SECRET), { developerId });
    expect(byId.body.projects).toEqual([{ name: "solo", access: "granted" }]);
  });

  it("cannot widen the answer by changing what it was given: the reviewer's probe", async () => {
    rules.push((context, answer) => {
      const loose = answer as unknown as { administrator: boolean; projects: Array<{ name: string; access: string }> };
      try { loose.administrator = true; } catch { /* frozen */ }
      try { loose.projects.push({ name: "hidden", access: "granted" }); } catch { /* frozen */ }
      try { loose.projects[0]!.access = "admin"; } catch { /* frozen */ }
      try { (context as { developerId: string }).developerId = "e".repeat(64); } catch { /* frozen */ }
      return undefined;
    });
    const answer = await access(basic("scheduler", SECRET), { developerId });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ developerId, administrator: false, projects: [{ name: "payments-api", access: "channel" }, { name: "solo", access: "granted" }] });
    expect(answer.body.projects).toHaveLength(2);
  });

  it("refuses with the one 401 when a rule answers anything but undefined or an object", async () => {
    for (const odd of [null, "allow", 1, true, ["solo"]]) {
      rules.length = 0;
      rules.push(() => odd as never);
      expect((await bearer()).status).toBe(401);
    }
    rules.length = 0;
    rules.push(() => ({ projects: "solo" }) as never);
    expect((await bearer()).status).toBe(401);
  });

  it("narrows whatever else the verdict says: refuse false still keeps only the named projects and drops administrator", async () => {
    rules.push(() => ({ refuse: false, administrator: false, projects: [] }));
    expect((await bearer()).body).toMatchObject({ administrator: false, projects: [] });
  });

  it("run in order, each on what the one before left", async () => {
    const seenProjects: string[][] = [];
    rules.push(() => ({ projects: ["solo"] }), (_context, answer) => { seenProjects.push(answer.projects.map((project) => project.name)); return undefined; });
    expect((await bearer()).body.projects).toEqual([{ name: "solo", access: "granted" }]);
    expect(seenProjects).toEqual([["solo"]]);
  });
});
