import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelMembersRequest, ChannelMembersResponse } from "@agentx/contracts";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { adminIssuer, createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-09-27T12:00:00.000Z");

let db: FakeDynamoDb;
let handler: AdminHandler;
let channelMembers: ReturnType<typeof vi.fn<(request: ChannelMembersRequest) => Promise<ChannelMembersResponse>>>;
let config: DeveloperApiConfiguration;

const claims = (overrides: Record<string, unknown> = {}) => ({ iss: ISSUER, aud: "agentx-developer", sub: developerId, amr: "slack", env: "staging", sid: "s-1", ...overrides });
const call = (path: string, jwt: Record<string, unknown>, method = "GET") =>
  handler({ rawPath: path, requestContext: { requestId: "r", http: { method }, authorizer: { jwt: { claims: jwt } } } });

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
