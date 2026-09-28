import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentXError, type ChannelInfoRequest, type ChannelMembersRequest, type ChannelMembersResponse } from "@agentx/contracts";
import { channelInfoThroughLambda, channelMembersThroughLambda, checkProjectAccess, developerKeysThroughLambda, developerSinceFromEnvironment, type DeveloperApiConfiguration, type DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
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

interface SentCommand { constructor: { name: string }; input: Record<string, unknown> }
/** Every command the broker sends to the fake table, in order, still answered by the fake. */
function recordCommands(): SentCommand[] {
  const sent: SentCommand[] = [];
  const original = db.send;
  vi.spyOn(db, "send").mockImplementation(async (command) => {
    sent.push(command);
    return original(command);
  });
  return sent;
}
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
  it("lists granted and channel projects with the developer summary", async () => {
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      developer: { id: developerId, name: "Maya Chen", provider: "slack", slackUserId: "U0MAYA001" },
      projects: [
        { name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0PAY0001" }], tasks: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true } },
        { name: "solo", latestRevision: 1, access: "granted", channels: [], tasks: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true } },
      ],
      notices: [],
      requestId: "r",
    });
    expect(channelMembers).toHaveBeenCalledWith({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0LEDGER1", "C0PAY0001"] });
  });

  it("keeps grants and says so when Slack is unavailable", async () => {
    channelMembers.mockResolvedValueOnce({ ok: false, error: "slack_unavailable" });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }>; notices: string[] };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(body.notices).toEqual(["slack_unavailable"]);
  });

  it("does not count an administrator membership as a developer grant (FR-013)", async () => {
    db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#ledger", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "ledger", role: "administrator" });
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: [] });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }> };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
  });

  it("reads the session and developer from the sign-in table, and grants and bindings from the state table", async () => {
    const sent = recordCommands();
    expect((await call("/v1/dev/projects", claims())).statusCode).toBe(200);
    const gets = sent.filter((command) => command.constructor.name === "GetCommand").map((command) => ({ TableName: command.input.TableName, Key: command.input.Key }));
    expect(gets).toEqual([
      { TableName: "signin", Key: { pk: "SESSION#s-1", sk: "META" } },
      { TableName: "signin", Key: { pk: `DEVELOPER#${developerId}`, sk: "META" } },
    ]);
    const queryTables = new Set(sent.filter((command) => command.constructor.name === "QueryCommand").map((command) => command.input.TableName));
    expect([...queryTables]).toEqual(["state"]);
  });

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

  it("shows a company developer with no Slack link only their granted projects, without asking Slack", async () => {
    config.methods.oidc = true;
    db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "oidc", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://login.example.test", subject: "maya", displayName: "Maya Chen", email: "maya@example.test", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    const body = JSON.parse((await call("/v1/dev/projects", claims({ amr: "oidc" }))).body) as { developer: unknown; projects: Array<{ name: string }>; notices: string[] };
    expect(body.developer).toEqual({ id: developerId, name: "Maya Chen", provider: "oidc", email: "maya@example.test" });
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(body.notices).toEqual([]);
    expect(channelMembers).not.toHaveBeenCalled();
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

  it("skips a binding whose project has no registered revision", async () => {
    db.items.delete("PROJECT#payments-api\u0000REV#000000000007");
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }> };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
  });
});

describe("the developer check on every /v1/dev request (FR-009, R12, R13)", () => {
  it.each([
    ["an admin token", { iss: adminIssuer, aud: "agentx-admin-client" }],
    ["another audience", { aud: "something-else" }],
    ["a token from another environment", { env: "production" }],
    ["no session id", { sid: undefined }],
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
    "/v1/dev/../v1/admin/x", "/v1/dev/%2e%2e/admin", "/v1/dev/%2E%2E/admin/turns", "/v1/dev/./projects", "/v1/dev/%2e/projects", "/v1/dev/.%2E/v1/admin/turns",
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

  it("answers 503, not 401, when the sign-in server's keys cannot be read", async () => {
    config.verifyAccessToken = developerTokenVerifier({ issuer: ISSUER, keys: async () => { throw new Error("ResourceNotFoundException"); }, now: () => Date.now() });
    const response = await call("/v1/dev/projects", claims());
    expect(response.statusCode).toBe(503);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "RUNTIME_UNAVAILABLE" } });
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

  it("answers NOT_FOUND for a /v1/dev route this phase does not serve", async () => {
    expect((await call("/v1/dev/not-a-route", claims(), "POST")).statusCode).toBe(404);
  });
});

describe("admin and developer tokens stay apart (FR-009, FR-015)", () => {
  it("refuses a developer token on /v1/admin/*", async () => {
    const response = await call("/v1/admin/turns", claims());
    expect(response.statusCode).toBe(401);
  });

  it("keeps spec 008's refusal for JWT routes that are neither /v1/admin nor /v1/dev", async () => {
    const response = await call("/v1/workspaces", { iss: adminIssuer, sub: "admin-subject", groups: ["admins"] }, "POST");
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("AgentX developer workflows run in the project's Slack channel");
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
    ["a thrown invoke error, by name only", async () => { const error = new Error("arn:aws:lambda:us-east-1:111122223333:function:agentx-planted"); error.name = "ResourceNotFoundException"; throw error; }, { reason: "invoke_error", error: "ResourceNotFoundException" }],
    ["a function error", async () => ({ FunctionError: "Unhandled", Payload: new TextEncoder().encode("{\"errorMessage\":\"xoxb-planted\"}") }), { reason: "function_error", functionError: "Unhandled" }],
    ["an empty reply", async () => ({}), { reason: "empty_reply" }],
    ["an unreadable reply", async () => ({ Payload: new TextEncoder().encode("not json xoxb-planted") }), { reason: "unreadable_reply" }],
    ["a slack_unavailable reply", async () => reply({ ok: false, error: "slack_unavailable" }), { reason: "reply_error", error: "slack_unavailable" }],
    ["a reply of another shape", async () => reply({ ok: false, error: "xoxb-planted" }), { reason: "reply_error", error: "malformed_reply" }],
  ])("fails closed and logs %s", async (_name, invoke, logged) => {
    const logs = captureLogs();
    expect(await channelMembersThroughLambda(invoke)(request)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_members_failed", ...logged }]);
    expect(JSON.stringify(logs())).not.toContain("planted");
  });
});

describe("GET /v1/dev/projects with the task policy (FR-014, FR-016)", () => {
  it("adds each project's policy from its latest revision", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { enabled: true, share: "required", shareMode: { default: "view", allowContinue: false }, channelMembersMayUse: true } } });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; latestRevision: number; tasks: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")).toMatchObject({
      latestRevision: 8, tasks: { share: "required", shareMode: { allowContinue: false } },
    });
    expect(body.projects.find((project) => project.name === "solo")?.tasks).toEqual({ enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true });
  });

  it("does not give channel access to a project whose channelMembersMayUse is false, and does not ask Slack for it", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { channelMembersMayUse: false } } });
    db.set({ pk: "PROJECT#ledger", sk: "REV#000000000003", entityType: "PROJECT", definition: { name: "ledger", revision: 3, developerTasks: { channelMembersMayUse: false } } });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string }> };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(channelMembers).not.toHaveBeenCalled();
  });

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

  it("still answers with channel IDs when the names cannot be read", async () => {
    config.channelInfo = vi.fn(async () => ({ ok: false as const, error: "slack_unavailable" as const }));
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "payments-api")?.channels).toEqual([{ channelId: "C0PAY0001" }]);
  });

  it("never names a private channel anywhere in the answer, and only asks for the channels of listed projects", async () => {
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0PAYSEC1", teamId: "T0TEAM1", channelId: "C0PAYSEC1", projectName: "payments-api", updatedAt: "2026-09-27T00:00:00.000Z" });
    const channelInfo = vi.fn(async (request: ChannelInfoRequest) => ({ ok: true as const, channels: request.channelIds.map((channelId) => ({ channelId, name: `planted-private-${channelId}`, isPrivate: true })) }));
    config.channelInfo = channelInfo;
    const response = await call("/v1/dev/projects", claims());
    expect(response.body).not.toContain("planted-private");
    expect(channelInfo).toHaveBeenCalledWith({ kind: "channel-info", channelIds: ["C0PAY0001", "C0PAYSEC1"] });
  });

  it("fails closed for channel access when a revision's policy is damaged, and keeps a grant", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { channelMembersMayUse: "yes" } } });
    db.set({ pk: "PROJECT#solo", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "solo", revision: 2, developerTasks: { enabled: "sure" } } });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; tasks: { enabled: boolean; channelMembersMayUse: boolean } }> };
    expect(body.projects.map((project) => project.name)).toEqual(["solo"]);
    expect(body.projects[0]?.tasks).toMatchObject({ enabled: false, channelMembersMayUse: false });
    expect(channelMembers).toHaveBeenCalledWith({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0LEDGER1"] });
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
  const names = (channels: Record<string, { name: string; isPrivate: boolean }>) =>
    vi.fn(async (request: ChannelInfoRequest) => ({ ok: true as const, channels: request.channelIds.filter((id) => channels[id] !== undefined).map((channelId) => ({ channelId, ...channels[channelId]! })) }));

  it("grants a granted project, and a project through a bound channel the caller is in", async () => {
    expect(await checkProjectAccess(deps(), maya, "solo")).toEqual({ revision: 1, policy: { enabled: true, share: "optional", shareMode: { default: "view", allowContinue: true }, channelMembersMayUse: true }, access: "granted" });
    expect(await checkProjectAccess(deps(), maya, "payments-api")).toMatchObject({ revision: 7, access: "channel" });
    expect(channelMembers).toHaveBeenLastCalledWith({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0PAY0001"] });
  });

  it("answers PROJECT_NOT_FOUND for a project with no revision or an invalid name, without asking Slack", async () => {
    expect(await refusal("nope")).toEqual({ code: "PROJECT_NOT_FOUND", message: "project `nope` doesn't exist in this AgentX; run agentx_list_projects" });
    expect((await refusal("../PROJECT#solo")).code).toBe("PROJECT_NOT_FOUND");
    expect(channelMembers).not.toHaveBeenCalled();
  });

  it("names only public bound channels in PROJECT_ACCESS_DENIED, never a private one the caller is not in", async () => {
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0LEDSEC1", teamId: "T0TEAM1", channelId: "C0LEDSEC1", projectName: "ledger", updatedAt: "2026-09-27T00:00:00.000Z" });
    db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: "CHANNEL#C0LEDOPS1", teamId: "T0TEAM1", channelId: "C0LEDOPS1", projectName: "ledger", updatedAt: "2026-09-27T00:00:00.000Z" });
    config.channelInfo = names({ C0LEDGER1: { name: "ledger-dev", isPrivate: false }, C0LEDOPS1: { name: "ledger-ops", isPrivate: false }, C0LEDSEC1: { name: "planted-secret", isPrivate: true } });
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: [] });
    const denied = await refusal("ledger");
    expect(denied).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `ledger`: join one of its channels (#ledger-dev, #ledger-ops) or ask an admin" });
    expect(denied.message).not.toContain("planted-secret");
  });

  it("just says ask an admin when the channel names cannot be read, or every bound channel is private", async () => {
    config.channelInfo = vi.fn(async () => ({ ok: false as const, error: "slack_unavailable" as const }));
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: [] });
    expect(await refusal("ledger")).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `ledger`: ask an admin" });
    config.channelInfo = names({ C0LEDGER1: { name: "planted-secret", isPrivate: true } });
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: [] });
    expect(await refusal("ledger")).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `ledger`: ask an admin" });
  });

  it("does not use or name channels when the project turns channel access off, and does not ask Slack", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { channelMembersMayUse: false } } });
    const channelInfo = names({ C0PAY0001: { name: "payments-dev", isPrivate: false } });
    config.channelInfo = channelInfo;
    expect(await refusal("payments-api")).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `payments-api`: ask an admin" });
    expect(channelMembers).not.toHaveBeenCalled();
    expect(channelInfo).not.toHaveBeenCalled();
  });

  it("fails closed when the policy is damaged: no channel access, and tasks off even with a grant", async () => {
    db.set({ pk: "PROJECT#payments-api", sk: "REV#000000000008", entityType: "PROJECT", definition: { name: "payments-api", revision: 8, developerTasks: { share: "sometimes" } } });
    expect((await refusal("payments-api")).code).toBe("PROJECT_ACCESS_DENIED");
    expect(channelMembers).not.toHaveBeenCalled();
    db.set({ pk: "PROJECT#solo", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "solo", revision: 2, developerTasks: { unknownField: true } } });
    expect((await refusal("solo")).code).toBe("PROJECT_TASKS_DISABLED");
  });

  it("does not name channels to a caller with no Slack link, and never asks Slack for them", async () => {
    const company: DeveloperCaller = { developerId, sessionId: "s-1", amr: "oidc", name: "Maya Chen", email: "maya@example.test" };
    const channelInfo = names({ C0LEDGER1: { name: "ledger-dev", isPrivate: false } });
    config.channelInfo = channelInfo;
    expect(await refusal("ledger", company)).toEqual({ code: "PROJECT_ACCESS_DENIED", message: "you don't have access to `ledger`: ask an admin" });
    expect(channelMembers).not.toHaveBeenCalled();
    expect(channelInfo).not.toHaveBeenCalled();
  });

  it("answers SLACK_UNAVAILABLE only when a channel could have given access and Slack is down", async () => {
    channelMembers.mockResolvedValueOnce({ ok: false, error: "slack_unavailable" });
    expect(await refusal("ledger")).toEqual({ code: "SLACK_UNAVAILABLE", message: "Slack could not be reached to check your channel membership; try again, or ask an admin for access" });
    // A grant needs no Slack.
    channelMembers.mockResolvedValue({ ok: false, error: "slack_unavailable" });
    expect((await checkProjectAccess(deps(), maya, "solo")).access).toBe("granted");
  });

  it("answers PROJECT_TASKS_DISABLED to a caller with access when tasks are off", async () => {
    db.set({ pk: "PROJECT#solo", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "solo", revision: 2, developerTasks: { enabled: false } } });
    expect(await refusal("solo")).toEqual({ code: "PROJECT_TASKS_DISABLED", message: "tasks from AI tools are turned off for `solo`; use the project's Slack channel, or ask an admin" });
  });

  it("answers PROJECT_ACCESS_DENIED, not PROJECT_TASKS_DISABLED, to a caller without access to a project with tasks off", async () => {
    db.set({ pk: "PROJECT#ledger", sk: "REV#000000000003", entityType: "PROJECT", definition: { name: "ledger", revision: 3, developerTasks: { enabled: false } } });
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: [] });
    expect((await refusal("ledger")).code).toBe("PROJECT_ACCESS_DENIED");
  });
});

describe("the channel names through the DeveloperIdentity function (R10)", () => {
  const request: ChannelInfoRequest = { kind: "channel-info", channelIds: ["C0PAY0001"] };
  const reply = (value: unknown) => ({ Payload: new TextEncoder().encode(JSON.stringify(value)) });

  it("sends the request as the payload and keeps only well-formed entries", async () => {
    const invoke = vi.fn<(payload: Uint8Array) => Promise<{ Payload: Uint8Array }>>(async () => reply({ ok: true, channels: [
      { channelId: "C0PAY0001", name: "payments-dev", isPrivate: false },
      { channelId: "C0PAY0002", name: 7, isPrivate: false },
      { channelId: "C0PAY0003", name: "x", isPrivate: "no" },
      "junk",
    ] }));
    expect(await channelInfoThroughLambda(invoke)(request)).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: false }] });
    expect(JSON.parse(new TextDecoder().decode(invoke.mock.calls[0]![0]))).toEqual(request);
  });

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

  it.each([
    ["a thrown invoke error, by name only", async () => { const error = new Error("arn:aws:lambda:planted"); error.name = "ResourceNotFoundException"; throw error; }, { reason: "invoke_error", error: "ResourceNotFoundException" }],
    ["a function error", async () => ({ FunctionError: "Unhandled", Payload: new TextEncoder().encode("{\"errorMessage\":\"xoxb-planted\"}") }), { reason: "function_error", functionError: "Unhandled" }],
    ["an empty reply", async () => ({}), { reason: "empty_reply" }],
    ["an unreadable reply", async () => ({ Payload: new TextEncoder().encode("not json xoxb-planted") }), { reason: "unreadable_reply" }],
    ["a slack_unavailable reply", async () => reply({ ok: false, error: "slack_unavailable" }), { reason: "reply_error", error: "slack_unavailable" }],
    ["a reply of another shape", async () => reply({ ok: true, channels: "xoxb-planted" }), { reason: "reply_error", error: "malformed_reply" }],
  ])("is unavailable and logs %s", async (_name, invoke, logged) => {
    const logs = captureLogs();
    expect(await channelInfoThroughLambda(invoke)(request)).toEqual({ ok: false, error: "slack_unavailable" });
    expect(logs()).toEqual([{ component: "broker", event: "developer.channel_info_failed", ...logged }]);
    expect(JSON.stringify(logs())).not.toContain("planted");
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

  it("does not name channels to a caller with no Slack link, like the access check", async () => {
    config.methods.oidc = true;
    db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "oidc", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
    db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://login.example.test", subject: "maya", displayName: "Maya Chen", email: "maya@example.test", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    db.set({ pk: `MEMBER#${developerId}`, sk: "PROJECT#ledger", entityType: "MEMBERSHIP", ownerKey: developerId, projectName: "ledger", role: "developer" });
    const channelInfo = vi.fn(async (request: ChannelInfoRequest) => ({ ok: true as const, channels: request.channelIds.map((channelId) => ({ channelId, name: "ledger-dev", isPrivate: false })) }));
    config.channelInfo = channelInfo;
    const body = JSON.parse((await call("/v1/dev/projects", claims({ amr: "oidc" }))).body) as { projects: Array<{ name: string; channels: unknown }> };
    expect(body.projects.find((project) => project.name === "ledger")?.channels).toEqual([{ channelId: "C0LEDGER1" }]);
    expect(channelInfo).not.toHaveBeenCalled();
  });

  it("reads only the revision and policy of each latest revision, at most 8 at a time", async () => {
    for (let index = 0; index < 20; index += 1) {
      const name = `proj-${index}`;
      db.set({ pk: "SLACK_BINDING#T0TEAM1", sk: `CHANNEL#C0PRJ${String(index).padStart(4, "0")}`, teamId: "T0TEAM1", channelId: `C0PRJ${String(index).padStart(4, "0")}`, projectName: name, updatedAt: "2026-09-27T00:00:00.000Z" });
      db.set({ pk: `PROJECT#${name}`, sk: "REV#000000000001", entityType: "PROJECT", definition: { name, revision: 1 } });
    }
    const original = db.send;
    const projectQueries: Array<Record<string, unknown>> = [];
    let inFlight = 0;
    let most = 0;
    vi.spyOn(db, "send").mockImplementation(async (command) => {
      const pk = (command.input.ExpressionAttributeValues as Record<string, unknown> | undefined)?.[":pk"];
      if (command.constructor.name !== "QueryCommand" || typeof pk !== "string" || !pk.startsWith("PROJECT#")) return original(command);
      projectQueries.push(command.input);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
      return original(command);
    });
    channelMembers.mockResolvedValueOnce({ ok: true, memberOf: ["C0PRJ0003"] });
    const body = JSON.parse((await call("/v1/dev/projects", claims())).body) as { projects: Array<{ name: string; latestRevision: number }> };
    expect(body.projects.map((project) => [project.name, project.latestRevision])).toEqual([["proj-3", 1], ["solo", 1]]);
    expect(projectQueries).toHaveLength(23);
    expect(most).toBe(8);
    for (const input of projectQueries) {
      expect(input).toMatchObject({
        ProjectionExpression: "#definition.#revision, #definition.#developerTasks",
        ExpressionAttributeNames: { "#definition": "definition", "#revision": "revision", "#developerTasks": "developerTasks" },
        ScanIndexForward: false, Limit: 1, ConsistentRead: true,
      });
    }
  });
});

describe("PROJECT_NOT_FOUND for a name that is not a project name (Task 7 fix round 1)", () => {
  it("does not echo the raw input", async () => {
    const maya: DeveloperCaller = { developerId, sessionId: "s-1", amr: "slack", name: "Maya Chen", slackUserId: "U0MAYA001" };
    const raw = `${"x".repeat(200)}\`\nplanted-injection`;
    const error = await checkProjectAccess({ documentClient: db, tableName: "state", developer: config, now: () => T0 }, maya, raw).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentXError);
    expect((error as AgentXError).code).toBe("PROJECT_NOT_FOUND");
    expect((error as AgentXError).message).toBe("PROJECT_NOT_FOUND: that is not a valid AgentX project name; run agentx_list_projects to see the projects you can use");
    expect((error as AgentXError).message).not.toContain("planted");
    expect((error as AgentXError).message).not.toContain("xxxx");
  });
});
