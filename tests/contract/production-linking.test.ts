// Spec 064 phase 064a: the legacy deployment's sign-in is for account linking only. Its broker serves the link page,
// a registered service's access check and a person's own links; developer tasks, projects and admin changes are not
// there, whatever token the caller holds.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const developerId = "d".repeat(64);
const T0 = Date.parse("2026-11-12T12:00:00.000Z");
const signer = localSigner();

let db: FakeDynamoDb;
let handler: AdminHandler;

async function token(): Promise<string> {
  const claims = { iss: ISSUER, aud: "agentx-developer", sub: developerId, amr: "oidc", env: "production", sid: "s-1", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600 };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}

async function call(method: string, path: string, options: { routeKey?: string; authorization?: string; body?: unknown } = {}) {
  const response = await handler({
    rawPath: path, routeKey: options.routeKey ?? "ANY /v1/dev/{proxy+}",
    headers: options.authorization === undefined ? {} : { authorization: options.authorization },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    requestContext: { requestId: "r", http: { method } },
  });
  return { status: response.statusCode, body: response.body };
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const linking: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker({ linking, channelAdapters: true }));
  db.set({ pk: "SESSION#s-1", sk: "META", sessionId: "s-1", developerId, amr: "oidc", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "oidc", issuer: "https://cognito.example.test", subject: "ada", displayName: "Ada", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
});

describe("the legacy deployment's developer API (spec 064 FR-001, FR-005)", () => {
  it("lists a signed-in person's own links", async () => {
    const answer = await call("GET", "/v1/dev/channel-links", { authorization: await token() });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ links: [] });
  });

  it("refuses the links without a valid token", async () => {
    expect((await call("GET", "/v1/dev/channel-links")).status).toBe(401);
  });

  it("serves the access check, which answers a bad token with its own 401", async () => {
    const answer = await call("POST", "/v1/dev/access", { authorization: "Bearer not-a-token" });
    expect(answer.status).toBe(401);
  });

  it("has no developer tasks or ChatGPT connection, even for a signed-in person", async () => {
    const authorization = await token();
    for (const [method, path] of [["GET", "/v1/dev/tasks"], ["POST", "/v1/dev/tasks"], ["GET", "/v1/dev/chatgpt-connection"]] as const) {
      const answer = await call(method, path, { authorization, ...(method === "POST" ? { body: {} } : {}) });
      expect(answer.status, `${method} ${path}`).toBe(404);
    }
  });

  it("lists a signed-in person's projects and workspaces (spec 066 FR-005)", async () => {
    const authorization = await token();
    for (const path of ["/v1/dev/projects", "/v1/dev/workspaces"]) expect((await call("GET", path, { authorization })).status, path).toBe(200);
  });

  it("serves the link page on the review route, and nothing else there", async () => {
    const link = await call("GET", `/review/link/${"A1_-".repeat(8)}`, { routeKey: "ANY /review/{proxy+}" });
    expect(link.status).not.toBe(404);
    const task = await call("GET", "/review/1b4e28ba-2fa1-11d2-883f-0016d3cca427/task", { routeKey: "ANY /review/{proxy+}" });
    expect(task.status).toBe(404);
  });
});
