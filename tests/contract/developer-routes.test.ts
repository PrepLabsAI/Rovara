import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import { channelMembersThroughLambda, type DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
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

const claims = (overrides: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: "agentx-developer", sub: developerId, amr: "slack", env: "staging", sid: "s-1", ...overrides });
const call = (path: string, jwt: Record<string, unknown>, method = "GET") =>
  handler({ rawPath: path, requestContext: { requestId: "r", http: { method }, authorizer: { jwt: { claims: jwt } } } });

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  channelMembers = vi.fn(async () => ({ ok: true as const, memberOf: ["C0PAY0001"] }));
  config = { issuer: ISSUER, env: "staging", methods: { slack: true, oidc: false }, slackTeamId: "T0TEAM1", signInTableName: "signin", channelMembers };
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
        { name: "payments-api", latestRevision: 7, access: "channel", channels: [{ channelId: "C0PAY0001" }] },
        { name: "solo", latestRevision: 1, access: "granted", channels: [] },
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
    expect((await call("/v1/dev/tasks", claims(), "POST")).statusCode).toBe(404);
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
    const response = await bare({ rawPath: "/v1/dev/projects", requestContext: { requestId: "r", http: { method: "GET" }, authorizer: { jwt: { claims: claims() } } } });
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("developer sign-in is not set up");
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
