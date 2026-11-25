import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentXError, SLACK_OIDC_ISSUER, type ChannelInfoRequest, type ChannelMembersRequest, type ChannelMembersResponse } from "@agentx/contracts";
import { channelInfoThroughLambda, channelMembersThroughLambda, checkProjectAccess, developerKeysThroughLambda, developerSinceFromEnvironment, developerTaskRouteDependencies, taskPeopleDisplayReadThroughLambda, taskPersonProofThroughLambda, type DeveloperApiConfiguration, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { slackDirectory } from "../../packages/broker/src/developer/slack-directory.js";
import { getTaskPeople, getTaskPeopleCapabilities } from "../../packages/broker/src/developer/task-people.js";
import { adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { identityHarness, localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-09-27T12:00:00.000Z");

let db: FakeDynamoDb;
let handler: AdminHandler;
let channelMembers: ReturnType<typeof vi.fn<(request: ChannelMembersRequest) => Promise<ChannelMembersResponse>>>;
let config: DeveloperApiConfiguration;

/** Structured log lines the developer routes wrote, parsed; console output stays quiet. */
function captureLogs(): () => Array<Record<string, unknown>> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return () => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

const signer = localSigner();
const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: "agentx-developer", sub: developerId, amr: "slack", env: "staging", sid: "s-1", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...overrides,
});
/** A developer access token for `jwt`, signed with the sign-in server's (fake KMS) key. */
async function bearer(jwt: Record<string, unknown>): Promise<string> {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(jwt)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
/** /v1/dev/* has no API Gateway authorizer (D17): the token is only in the Authorization header. On
 * other routes the admin authorizer's claims are passed as API Gateway would. */
const call = async (path: string, jwt: Record<string, unknown>, method = "GET") =>
  handler({
    rawPath: path, headers: { authorization: await bearer(jwt) },
    requestContext: { requestId: "r", http: { method }, ...(path.startsWith("/v1/dev/") ? {} : { authorizer: { jwt: { claims: jwt } } }) },
  });

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001"] }));
  config = {
    issuer: ISSUER, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin", channelMembers,
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker({ developer: config }));
  db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "slack", slackUserId: "U0MAYA001", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", slackUserId: "U0MAYA001", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAY0001", teamId: "T0TEAM1", channelId: "C0PAY0001", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
  db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0LEDGER1", teamId: "T0TEAM1", channelId: "C0LEDGER1", projectName: "ledger", updatedAt: "2026-09-27T00:00:00.000Z" });
  db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000007", entityType: "PROJECT", definition: { name: "payments-api", revision: 7 } });
  db.set({ pk: "PROJECT#ledger", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "ledger", revision: 2 } });
  db.set({ pk: "PROJECT#solo", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "solo", revision: 1 } });
  db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#solo", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "solo", role: "developer" });
});

describe("GET /v1/dev/projects (FR-016, FR-013)", () => {

  it("reads every page of grants and bindings", async () => {
    db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#ledger", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "ledger", role: "developer" });
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0DOCS001", teamId: "T0TEAM1", channelId: "C0DOCS001", projectName: "docs", updatedAt: "2026-09-27T00:00:00.000Z" });
    db.set({ pk: "PROJECT#docs", sk: "REV#000000000003", entityType: "PROJECT", definition: { name: "docs", revision: 3 } });
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: ["C0DOCS001", "C0PAY0001"] });
    const original = db.send;
    const pagedStarts: unknown[] = [];
    // One item per page for the grant and binding queries, so every page but the last has a LastEvaluatedKey.
    vi.spyOn(db, "send").mockImplementation(async (command) => {
      const { constructor, input } = command;
      const pk = (input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"];
      if (constructor.name !== "QueryCommand" || typeof pk !== "string" || !(pk.startsWith("MEMBER#") || pk.startsWith("SLACK_BINDING#"))) return original(command);
      const all = ((await original(command)) as { Items: Array<Record<string, unknown>> }).Items;
      const start = input.ExclusiveStartKey as { sk: string } | undefined;
      if (start !== undefined) pagedStarts.push(start);
      const index = start === undefined ? 0 : all.findIndex((item) => item.sk === start.sk) + 1;
      const item = all[index];
      return { Items: item === undefined ? [] : [item], ...(index + 1 < all.length && item ? { LastEvaluatedKey: { pk: item.pk, sk: item.sk } } : {}) };
    });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; access: string }> };
    expect(body.projects.map((project) => [project.name, project.access])).toEqual([["docs", "channel"], ["ledger", "granted"], ["payments-api", "channel"], ["solo", "granted"]]);
    expect(channelMembers).toHaveBeenCalledWith({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0DOCS001", "C0PAY0001"] });
    expect(pagedStarts).toHaveLength(3); // one more grant page, two more binding pages
  });

  it("fails closed, keeping grants, when the channel check throws", async () => {
    const logs = captureLogs();
    channelMembers.mockRejectedValueOnce(new Error("socket hang up"));
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { projects: Array<{ name: string }>; notices: string[] };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(body.notices).toEqual(["slack_unavailable"]);
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_members_failed", reason: "threw", error: "Error" }]);
  });

});

describe("PUT /v1/dev/me/name (#634)", () => {
  const put = async (body: string, broker: AdminHandler, jwt = claims()) => broker({
    rawPath: "/v1/dev/me/name", headers: { authorization: await bearer(jwt), "content-type": "application/json" }, body,
    requestContext: { requestId: "r", http: { method: "PUT" } },
  });
  async function withSetName(answer: Awaited<ReturnType<NonNullable<DeveloperApiConfiguration["setDisplayName"]>>>) {
    const setDisplayName = vi.fn(async () => answer);
    const built = await createAdminBroker({ developer: { ...config, setDisplayName } });
    built.db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "slack", slackUserId: "U0MAYA001", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
    built.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", slackUserId: "U0MAYA001", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    return { setDisplayName, handler: built.handler, db: built.db };
  }

  it("puts the new name on the tasks the person started, and only theirs (#661)", async () => {
    const logs = captureLogs();
    const { handler: broker, db: built } = await withSetName({ ok: true, name: "Maya C" });
    const mine = "11111111-1111-4111-8111-111111111111", theirs = "22222222-2222-4222-8222-222222222222";
    built.set({ pk: `DEVTASK#${mine}`, sk: "META", taskId: mine, developerId, developerName: "Maya Chen" });
    built.set({ pk: `DEVELOPER#${developerId}`, sk: `TASK#2026-09-27T12:00:00.000Z#${mine}`, taskId: mine });
    built.set({ pk: `DEVTASK#${theirs}`, sk: "META", taskId: theirs, developerId: "e".repeat(64), developerName: "Eve" });
    expect((await put(JSON.stringify({ name: "Maya C" }), broker)).statusCode).toBe(200);
    expect(built.get(`DEVTASK#${mine}`, "META")).toMatchObject({ developerName: "Maya C" });
    expect(built.get(`DEVTASK#${theirs}`, "META")).toMatchObject({ developerName: "Eve" });
    expect(logs()).toContainEqual({ component: "broker", event: "developer.tasks_renamed", developerId, tasks: 1, renamed: 1 });
  });

  it("refuses a body that is not just a valid name, before it reaches the sign-in Lambda", async () => {
    const { setDisplayName, handler: broker } = await withSetName({ ok: true, name: "x" });
    for (const body of [JSON.stringify({ name: "maya@example.com" }), JSON.stringify({ name: "Maya", developerId: "e".repeat(64) }), JSON.stringify({}), "not json"]) {
      const response = await put(body, broker);
      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: "CONFIG_INVALID" } });
    }
    expect(setDisplayName).not.toHaveBeenCalled();
  });

  it("asks to sign in again when the sign-in record is gone, and says unavailable when the Lambda is", async () => {
    expect((await put(JSON.stringify({ name: "Maya" }), (await withSetName({ ok: false, error: "not_found" })).handler)).statusCode).toBe(401);
    expect(JSON.parse((await put(JSON.stringify({ name: "Maya" }), (await withSetName({ ok: false, error: "unavailable" })).handler)).body)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
  });

  it("is not found where the deployment cannot store names", async () => {
    expect((await put(JSON.stringify({ name: "Maya" }), handler)).statusCode).toBe(404);
  });
});

describe("the developer check on every /v1/dev request (FR-009, R12, R13)", () => {
  it.each([
    ["a token from another environment", { env: "production" }],
    ["a subject that is not a developer ID", { sub: "not-hex" }],
  ])("refuses %s with AUTH_REQUIRED", async (_name, overrides) => {
    const response = await call("/v1/dev/projects", claims(overrides));
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("verifies the token itself, ignoring any authorizer claims, since /v1/dev has no API Gateway authorizer (D17)", async () => {
    const claimsOnly = await handler({ rawPath: "/v1/dev/projects", requestContext: { requestId: "r", http: { method: "GET" }, authorizer: { jwt: { claims: claims() } } } });
    expect(claimsOnly.statusCode).toBe(401);
    const forged = await bearer(claims());
    const [header, payload] = forged.slice("Bearer ".length).split(".");
    const unsigned = await handler({ rawPath: "/v1/dev/projects", headers: { authorization: `Bearer ${header}.${payload}.` }, requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(unsigned.statusCode).toBe(401);
    expect(JSON.parse(unsigned.body)).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
    expect(unsigned.body).not.toContain(payload!);
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(200);
  });

  it.each([
    "/v1/dev/../v1/admin/x",
  ])("answers 404 for %s, a path with dot segments, before anything normalizes it", async (rawPath) => {
    const response = await handler({ rawPath, headers: { authorization: await bearer(claims()) }, requestContext: { requestId: "r", http: { method: "GET" }, authorizer: { jwt: { claims: { iss: adminIssuer, sub: "admin-subject", groups: ["admins"] } } } } });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  it("routes by API Gateway's route key: the /v1/dev route never reaches another handler", async () => {
    const response = await handler({ rawPath: "/v1/admin/turns", routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization: await bearer(claims()) }, requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(response.statusCode).toBe(404);
    const dev = await handler({ rawPath: "/v1/dev/projects", routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization: await bearer(claims()) }, requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(dev.statusCode).toBe(200);
  });

  it("refuses an oidc token when company sign-in is turned off", async () => {
    db.set({ ...db.get("SESSION#s-1", "META")!, amr: "oidc" });
    const response = await call("/v1/dev/projects", claims({ amr: "oidc" }));
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Company sign-in is turned off");
  });

  it("refuses a token whose method is turned off", async () => {
    config.methods.slack = false;
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Slack sign-in is turned off");
  });

  it("refuses a session started before its method was last turned on, and serves one started after (FR-045)", async () => {
    // The session started at T0; Slack was turned off and back on a minute later.
    config.since = { slack: T0 / 1000 + 60 };
    const refused = await call("/v1/dev/projects", claims());
    expect(refused.statusCode).toBe(401);
    expect(refused.body).toContain("your sign-in ended when Slack was turned off");
    // A company sign-in cutoff does not touch a Slack session.
    config.since = { oidc: T0 / 1000 + 60 };
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(200);
    config.since = { slack: T0 / 1000 - 60 };
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(200);
  });

  it("reads each method's cutoff from the broker's environment, and 0 or unreadable as none", () => {
    expect(developerSinceFromEnvironment({ DEVELOPER_SIGNIN_SLACK_SINCE: "1790000000", DEVELOPER_OIDC_SINCE: "0" })).toEqual({ slack: 1790000000 });
    expect(developerSinceFromEnvironment({ DEVELOPER_SIGNIN_SLACK_SINCE: "x", DEVELOPER_OIDC_SINCE: "1790000001" })).toEqual({ oidc: 1790000001 });
    expect(developerSinceFromEnvironment({})).toEqual({});
  });

  it("refuses a revoked or ended session, a session of someone else, and a revoked developer", async () => {
    db.set({ ...db.get("SESSION#s-1", "META")!, revokedAt: new Date(T0).toISOString() });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
    db.set({ ...db.get("SESSION#s-1", "META")!, revokedAt: undefined, endsAt: T0 / 1000 - 1 });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
    db.set({ ...db.get("SESSION#s-1", "META")!, endsAt: T0 / 1000 + 100, developerId: "e".repeat(64) });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
    db.set({ ...db.get("SESSION#s-1", "META")!, developerId });
    db.set({ ...db.get(`DEVELOPER#${developerId}`, "META")!, revoked: true });
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(401);
  });

});

describe("admin and developer tokens stay apart (FR-009, FR-015)", () => {
  it("refuses a developer token on /v1/admin/*", async () => {
    const response = await call("/v1/admin/turns", claims());
    expect(response.statusCode).toBe(401);
  });

  it("answers NOT_FOUND on /v1/dev/* when developer sign-in is not configured", async () => {
    const { handler: bare } = await createAdminBroker();
    const response = await bare({ rawPath: "/v1/dev/projects", headers: { authorization: await bearer(claims()) }, requestContext: { requestId: "r", http: { method: "GET" } } });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("developer sign-in is not set up");
  });
});

describe("the sign-in keys through the DeveloperIdentity function (D17)", () => {
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

  it("invokes the function's own JWKS route and returns its keys", async () => {
    const identity = identityHarness();
    const keys = await developerKeysThroughLambda(async (payload) => ({ Payload: encode(await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never)) }))();
    expect(keys).toEqual((await identity.signer.jwks()).keys);
  });

  it.each([
    ["a thrown invoke error", async () => { throw Object.assign(new Error("arn:aws:lambda:planted"), { name: "AccessDeniedException" }); }, { reason: "invoke_error", error: "AccessDeniedException" }],
    ["a function error", async () => ({ FunctionError: "Unhandled", Payload: encode({ errorMessage: "planted" }) }), { reason: "function_error", functionError: "Unhandled" }],
    ["an empty reply", async () => ({}), { reason: "empty_reply" }],
    ["a 500 reply", async () => ({ Payload: encode({ statusCode: 500, body: "{}" }) }), { reason: "unreadable_reply" }],
    ["no keys", async () => ({ Payload: encode({ statusCode: 200, body: JSON.stringify({ keys: [] }) }) }), { reason: "no_keys" }],
  ])("throws, logging only the reason, on %s", async (_name, invoke, logged) => {
    const logs = captureLogs();
    await expect(developerKeysThroughLambda(invoke)()).rejects.toThrow(/the developer sign-in keys could not be read/);
    expect(logs()).toEqual([{ component: "broker", event: "developer.jwks_failed", ...logged }]);
    expect(JSON.stringify(logs())).not.toContain("planted");
  });
});

describe("the channel check through the DeveloperIdentity function", () => {
  const request: ChannelMembersRequest = { kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0PAY0001"] };
  const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });

  it("sends the request as the payload and passes a member list through", async () => {
    const invoke = vi.fn<(payload: Uint8Array) => Promise<{ Payload: Uint8Array }>>(async () => reply({ ok: true, memberOf: ["C0PAY0001", 7] }));
    expect(await channelMembersThroughLambda(invoke)(request)).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
    expect(JSON.parse(new TextDecoder().decode(invoke.mock.calls[0]![0]))).toEqual(request);
  });

  it("logs an invalid_request reply as a broker bug and still fails closed", async () => {
    const logs = captureLogs();
    expect(await channelMembersThroughLambda(async () => reply({ ok: false, error: "invalid_request" }))(request)).toEqual({ ok: false, error: "invalid_request" });
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_members_invalid_request", reason: "the identity function refused the broker's request; this is a broker bug" }]);
  });

  it.each([
    ["an empty reply", async () => ({}), { reason: "empty_reply" }],
    ["an unreadable reply", async () => ({ Payload: new TextEncoder().encode("not json xoxb-planted") }), { reason: "unreadable_reply" }],
  ])("fails closed and logs %s", async (_name, invoke, logged) => {
    const logs = captureLogs();
    expect(await channelMembersThroughLambda(invoke)(request)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_members_failed", ...logged }]);
    expect(JSON.stringify(logs())).not.toContain("planted");
  });
});

describe("the fresh task person proof through the DeveloperIdentity function", () => {
  const request = { kind: "task-person-proof" as const, slackUserId: "U0MAYA001", channelIds: ["C0LEDGER1", "C0PAY0001"] };
  const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });

  it("sends the exact request and accepts one fully scoped proof", async () => {
    const invoke = vi.fn(async (payload: Uint8Array) => {
      void payload;
      return reply({ ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001"] });
    });
    await expect(taskPersonProofThroughLambda(invoke)(request)).resolves.toEqual({
      ok: true,
      user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" },
      memberOf: ["C0PAY0001"],
    });
    expect(JSON.parse(new TextDecoder().decode(invoke.mock.calls[0]![0]))).toEqual(request);
  });

  it("refuses old capability and malformed, mismatched, duplicate, or out-of-scope proof", async () => {
    const badReplies = [
      { ok: false, error: "invalid_request" },
      { ok: true, user: { id: "U0OTHER01", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001"] },
      { ok: true, user: { id: "U0MAYA001", teamId: "bad-team", name: "Maya Chen" }, memberOf: ["C0PAY0001"] },
      { ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001", "C0PAY0001"] },
      { ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0OTHER01"] },
      { ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "" }, memberOf: [] },
      { ok: false, error: "unknown" },
    ];
    for (const value of badReplies) {
      const answer = await taskPersonProofThroughLambda(async () => reply(value))(request);
      expect(answer.ok).toBe(false);
    }
  });

  it("passes through a verified ineligible answer without turning it into availability", async () => {
    await expect(taskPersonProofThroughLambda(async () => reply({ ok: false, error: "ineligible" }))(request))
      .resolves.toEqual({ ok: false, error: "ineligible" });
  });
});

describe("the metered Task People display read through DeveloperIdentity", () => {
  const request = { kind: "task-people-display-read" as const, operation: "proof" as const,
    admission: { version: 1 as const, deadlineAt: 2_000_000_000_000, slackCallsLimit: 2 },
    request: { kind: "task-person-proof" as const, slackUserId: "U0MAYA001", channelIds: ["C0PAY0001"] } };
  const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });

  it("accepts the operation-matched receipt and refuses lost, skewed, or mismatched usage", async () => {
    const good = { operation: "proof", admission: { version: 1, slackCallsUsed: 2 }, result: {
      ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001"],
    } };
    await expect(taskPeopleDisplayReadThroughLambda(async () => reply(good))(request)).resolves.toEqual(good);
    for (const invoke of [
      async () => ({}),
      async () => reply({ ok: false, error: "invalid_request" }),
      async () => reply({ ...good, admission: { version: 1, slackCallsUsed: 3 } }),
      async () => reply({ operation: "directory", admission: { version: 1, slackCallsUsed: 1 }, result: { ok: true, users: [] } }),
    ]) await expect(taskPeopleDisplayReadThroughLambda(invoke)(request)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });
});

describe("GET /v1/dev/projects with the task policy (FR-014, FR-016)", () => {

  it("names public bound channels when DeveloperIdentity can read them, and only flags private ones", async () => {
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAYSEC1", teamId: "T0TEAM1", channelId: "C0PAYSEC1", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
    config.channelInfo = vi.fn(async () => ({ ok: true as const, channels: [
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0PAYSEC1", name: "payments-sec", isPrivate: true },
    ] }));
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: ["C0PAY0001"] });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")?.channels).toEqual([
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0PAYSEC1", isPrivate: true },
    ]);
  });

});

describe("checkProjectAccess, FR-018's first three checks (FR-013, FR-014, FR-049, R10)", () => {
  const maya: DeveloperCaller = { developerId, sessionId: "s-1", amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
  const deps = () => ({ documentClient: db, tableName: "state", developer: config, now: () => T0 });
  const refusal = async (project: string, caller: DeveloperCaller = maya) => {
    try {
      await checkProjectAccess(deps(), caller, project);
    } catch (error) {
      // AgentXError's message starts with "<code>: "; the rest is what the developer reads.
      if (error instanceof AgentXError) return { code: error.code, message: error.message.slice(`${error.code}: `.length) };
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("uses supplied fresh proof for a target subject without a session or cached Slack lookup", async () => {
    const subject = { developerId, slackUserId: "U0MAYA001" };
    channelMembers.mockRejectedValue(new Error("cached path must not run"));

    await expect(checkProjectAccess(deps(), subject, "payments-api", { freshMemberOf: ["C0PAY0001"] }))
      .resolves.toMatchObject({ access: "channel", channelIds: ["C0PAY0001"] });
    await expect(checkProjectAccess(deps(), subject, "ledger", { freshMemberOf: ["C0PAY0001"] }))
      .rejects.toMatchObject({ code: "PROJECT_ACCESS_DENIED" });
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("answers PROJECT_NOT_FOUND for a project with no revision or an invalid name, without asking Slack", async () => {
    expect(await refusal("nope")).toEqual({ code: "PROJECT_NOT_FOUND", message: "project `nope` doesn't exist in this AgentX" });
    expect((await refusal("../PROJECT#solo")).code).toBe("PROJECT_NOT_FOUND");
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("fails closed when the policy is damaged: no channel access, and tasks off even with a grant", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { share: "sometimes" } } });
    expect((await refusal("payments-api")).code).toBe("PROJECT_ACCESS_DENIED");
    expect(channelMembers).not.toHaveBeenCalled();
    db.set({ pk: "PROJECT#solo", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "solo", revision: 2, developerTasks: { unknownField: true } } });
    expect((await refusal("solo")).code).toBe("PROJECT_TASKS_DISABLED");
  });

  it("answers SLACK_UNAVAILABLE only when a channel could have given access and Slack is down", async () => {
    channelMembers.mockResolvedValueOnce({ ok: false, error: "slack_unavailable" });
    expect(await refusal("ledger")).toEqual({ code: "SLACK_UNAVAILABLE", message: "Slack could not be reached to check your channel membership; try again, or ask an admin for access" });
    // A grant needs no Slack.
    channelMembers.mockResolvedValue({ ok: false, error: "slack_unavailable" });
    expect((await checkProjectAccess(deps(), maya, "solo")).access).toBe("granted");
  });

});

describe("D2 task-person route dependencies", () => {
  const maya: DeveloperCaller = { developerId, sessionId: "s-1", amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
  const taskId = "11111111-1111-4111-8111-111111111111";
  const nativeDeveloperId = developerIdForSlackUser("U0MAYA001");
  const task = {
    pk: `DEVTASK#${taskId}`, sk: "META", entityType: "DEVELOPER_TASK", taskId,
    developerId: nativeDeveloperId, provider: "slack", developerName: "Maya Chen", slackUserId: "U0MAYA001",
    project: "payments-api", share: { teamId: "T0TEAM1", channelId: "C0PAY0001" },
  } as DeveloperTaskRecord;

  it.each(["tasks-disabled", "missing-project"] as const)("does not persist an owner demotion on a capability read when project authority is %s", async (mode) => {
    const ownerId = developerIdForSlackUser("U0MAYA001");
    const nativeCaller: DeveloperCaller = { ...maya, developerId: ownerId };
    const storedTask = { ...task, developerId: ownerId };
    const originalPeople = { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
      people: [{ developerId: ownerId, slackUserId: "U0MAYA001", name: "Maya Chen", role: "owner" }] };
    db.set(storedTask);
    db.set(originalPeople);
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAY0001", teamId: "T0TEAM1", channelId: "C0PAY0001",
      projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
    if (mode === "tasks-disabled") {
      db.set({ pk: `MEMBER#${ownerId}`, sk: "PROJECT#payments-api", entityType: "MEMBERSHIP", ownerKey: ownerId,
        projectName: "payments-api", role: "developer" });
      db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT",
        definition: { name: "payments-api", revision: 8, developerTasks: { enabled: false } } });
    } else {
      db.delete("PROJECT#payments-api", "REV#000000000007");
    }
    config.taskPeopleConfiguration = { peopleChangesEnabled: false };
    config.taskPersonProof = async () => ({ ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001"] });
    const route = developerTaskRouteDependencies({ documentClient: db, tableName: "state", developer: config, now: () => T0 }, nativeCaller);

    await expect(getTaskPeopleCapabilities(route, nativeCaller, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });

    expect(db.get(`DEVTASK#${taskId}`, "PEOPLE")).toEqual(originalPeople);
  });

  it("still reconciles a definite project-access loss on a capability read", async () => {
    const ownerId = developerIdForSlackUser("U0MAYA001");
    const nativeCaller: DeveloperCaller = { ...maya, developerId: ownerId };
    const storedTask = { ...task, developerId: ownerId };
    const originalPeople = { pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
      people: [{ developerId: ownerId, slackUserId: "U0MAYA001", name: "Maya Chen", role: "owner" }] };
    db.set(storedTask);
    db.set(originalPeople);
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT",
      definition: { name: "payments-api", revision: 8, developerTasks: { enabled: true, channelMembersMayUse: false } } });
    db.delete(`MEMBER#${ownerId}`, "PROJECT#payments-api");
    config.taskPeopleConfiguration = { peopleChangesEnabled: false };
    config.taskPersonProof = async () => ({ ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001"] });
    const route = developerTaskRouteDependencies({ documentClient: db, tableName: "state", developer: config, now: () => T0 }, nativeCaller);

    await expect(getTaskPeopleCapabilities(route, nativeCaller, taskId)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(db.get(`DEVTASK#${taskId}`, "PEOPLE")).toMatchObject({ revision: 2, orphaned: true, people: [{ role: "denied" }] });
  });

  it.each([{ grant: false, kept: "commenter", orphaned: true }, { grant: true, kept: "owner", orphaned: false }] as const)(
    "ARCH RULING (b): an owner who is admitted by the project's Slack channel alone is read as a commenter; with an individual grant (%j) the owner stays", async ({ grant, kept, orphaned }) => {
      const ownerId = developerIdForSlackUser("U0MAYA001");
      const nativeCaller: DeveloperCaller = { ...maya, developerId: ownerId };
      // A task of the hosted core (not a Slack-native one, which keeps its channel rule), whose People list holds the Slack-native person.
      const storedTask = { ...task, developerId: ownerId, provider: "github" };
      const personId = "99999999-9999-4999-8999-999999999999";
      db.set(storedTask);
      db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: ownerId, slackUserId: "U0MAYA001", name: "Maya Chen", method: "slack",
        issuer: SLACK_OIDC_ISSUER, subject: "U0MAYA001", createdAt: "2026-09-27T00:00:00.000Z" });
      db.set({ pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${ownerId}`, schemaVersion: 1, personId, developerId: ownerId, createdAt: "2026-09-27T00:00:00.000Z" });
      db.set({ pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
        people: [{ developerId: ownerId, slackUserId: "U0MAYA001", name: "Maya Chen", role: "owner" }] });
      db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAY0001", teamId: "T0TEAM1", channelId: "C0PAY0001", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
      db.delete(`MEMBER#${ownerId}`, "PROJECT#payments-api");
      if (grant) db.set({ pk: `MEMBER#${ownerId}`, sk: "PROJECT#payments-api", entityType: "MEMBERSHIP", ownerKey: ownerId, projectName: "payments-api", role: "developer" });
      config.taskPeopleConfiguration = { peopleChangesEnabled: false };
      config.taskPersonProof = async () => ({ ok: true, user: { id: "U0MAYA001", teamId: "T0TEAM1", name: "Maya Chen" }, memberOf: ["C0PAY0001"] });
      const route = developerTaskRouteDependencies({ documentClient: db, tableName: "state", developer: config, now: () => T0 }, nativeCaller);

      await getTaskPeopleCapabilities(route, nativeCaller, taskId);

      expect(db.get(`DEVTASK#${taskId}`, "PEOPLE")).toMatchObject({ orphaned, people: [{ role: kept }] });
    });

  it("fails closed when the trusted fresh-proof port is absent", async () => {
    db.set(task as unknown as Record<string, unknown>);
    delete config.taskPersonProof;
    const route = developerTaskRouteDependencies({ documentClient: db, tableName: "state", developer: config, now: () => T0 }, maya);
    const check = Reflect.get(route, "checkTaskPerson") as ((value: DeveloperTaskRecord, id: string) => Promise<Record<string, unknown>>) | undefined;

    await expect(check?.(task, nativeDeveloperId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("stops registering later directory identities when the first new write crosses the display deadline", async () => {
    const firstNewSlackUserId = "U0NEW0001";
    const secondNewSlackUserId = "U0NEW0002";
    const caller = { ...maya, developerId: nativeDeveloperId };
    let clock = T0;
    db.set(task as unknown as Record<string, unknown>);
    db.set({
      pk: `DEVTASK#${taskId}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false,
      people: [{ developerId: nativeDeveloperId, slackUserId: "U0MAYA001", name: "Maya Chen", role: "owner" }],
    });
    db.set({
      pk: `DEVTASK#${taskId}`, sk: "PERSON#22222222-2222-4222-8222-222222222222", schemaVersion: 1,
      personId: "22222222-2222-4222-8222-222222222222", developerId: nativeDeveloperId,
      slackUserId: "U0MAYA001", name: "Maya Chen", method: "slack", issuer: "https://slack.com", subject: "U0MAYA001",
      createdAt: new Date(T0).toISOString(),
    });
    db.set({
      pk: `DEVTASK#${taskId}`, sk: `PERSON_SUBJECT#${nativeDeveloperId}`, schemaVersion: 1,
      personId: "22222222-2222-4222-8222-222222222222", developerId: nativeDeveloperId, createdAt: new Date(T0).toISOString(),
    });
    const originalSend = db.send.bind(db);
    const newRegistryWrites: string[] = [];
    vi.spyOn(db, "send").mockImplementation(async (command) => {
      const transactItems = (command as { input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, unknown> } }> } }).input?.TransactItems;
      const slackUserId = transactItems?.find((item) => String(item.Put?.Item?.sk).startsWith("PERSON#"))?.Put?.Item?.slackUserId;
      const answer = await originalSend(command);
      if (slackUserId === firstNewSlackUserId || slackUserId === secondNewSlackUserId) {
        newRegistryWrites.push(String(slackUserId));
        if (slackUserId === firstNewSlackUserId) clock += 20_001;
      }
      return answer;
    });
    const users = new Map([
      ["U0MAYA001", "Maya Chen"],
      [firstNewSlackUserId, "First New Person"],
      [secondNewSlackUserId, "Second New Person"],
    ]);
    const directory = slackDirectory({
      teamId: "T0TEAM1", botToken: async () => "INERT", now: () => clock,
      fetch: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("conversations.members")) {
          return new Response(JSON.stringify({ ok: true, members: [...users.keys()], response_metadata: { next_cursor: "" } }));
        }
        const slackUserId = url.searchParams.get("user") ?? "";
        return new Response(JSON.stringify({ ok: true, user: {
          id: slackUserId, team_id: "T0TEAM1", name: users.get(slackUserId), is_bot: false, deleted: false, is_stranger: false,
        } }));
      },
    });
    config.taskPeopleConfiguration = { peopleChangesEnabled: false };
    config.taskPeopleDisplayRead = (request) => directory.taskPeopleDisplayRead(request);
    const route = developerTaskRouteDependencies(
      { documentClient: db, tableName: "state", developer: config, now: () => clock },
      caller,
    );

    await expect(getTaskPeople(route, caller, taskId)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });

    expect(newRegistryWrites).toEqual([firstNewSlackUserId]);
    const newlyStored = db.find((item) => item.pk === `DEVTASK#${taskId}`
      && (item.slackUserId === firstNewSlackUserId || item.slackUserId === secondNewSlackUserId));
    expect(newlyStored.filter((item) => String(item.sk).startsWith("PERSON#"))).toHaveLength(1);
    expect(db.get(`DEVTASK#${taskId}`, `PERSON_SUBJECT#${developerIdForSlackUser(firstNewSlackUserId)}`)).toBeDefined();
    expect(db.get(`DEVTASK#${taskId}`, `PERSON_SUBJECT#${developerIdForSlackUser(secondNewSlackUserId)}`)).toBeUndefined();
  });
});

describe("the channel names through the DeveloperIdentity function (R10)", () => {
  const request: ChannelInfoRequest = { kind: "channel-info", channelIds: ["C0PAY0001"] };
  const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });

  it("works against the identity handler itself", async () => {
    const identity = identityHarness({ channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false } } });
    const invoke = async (payload: Uint8Array) => ({ Payload: new TextEncoder().encode(JSON.stringify(await identity.handler(JSON.parse(new TextDecoder().decode(payload)) as never))) });
    expect(await channelInfoThroughLambda(invoke)(request)).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: false }] });
  });

  it("logs an invalid_request reply as a broker bug", async () => {
    const logs = captureLogs();
    expect(await channelInfoThroughLambda(async () => reply({ ok: false, error: "invalid_request" }))(request)).toEqual({ ok: false, error: "invalid_request" });
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_info_invalid_request", reason: "the identity function refused the broker's request; this is a broker bug" }]);
  });


  it("lists channels by ID, logging the reason, when the names call throws", async () => {
    const logs = captureLogs();
    config.channelInfo = vi.fn(async () => { throw new Error("planted socket error"); });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")?.channels).toEqual([{ channelId: "C0PAY0001" }]);
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_info_failed", reason: "threw", error: "Error" }]);
  });
});

describe("the projects list's cost and consistency (Task 7 fix round 1)", () => {
  it("gives up on channel names at the deadline and lists the channels by ID", async () => {
    const logs = captureLogs();
    config.channelInfoDeadlineMs = 20;
    config.channelInfo = vi.fn(() => new Promise<never>(() => undefined));
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")?.channels).toEqual([{ channelId: "C0PAY0001" }]);
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_info_failed", reason: "deadline" }]);
  });

});

