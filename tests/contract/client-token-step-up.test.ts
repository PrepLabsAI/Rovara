// Switch-on L11 (found by L12, #734): a sign-in client's token (Cloud's web app) carries the person's step-up to the developer routes exactly as the Rovara CLI's does. The sign-in server
// writes `step_up_at` / `step_up_amr` only into the token of a session that began with a step-up on Code's own page (`acr_values=step-up`); the broker reads them only from the VERIFIED
// token (`stepUpOf`), never from anything else the request sends, and the core's routes check the age. A claim that does not read, or one claim alone, is no step-up.
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { authenticateCaller, type DeveloperApiConfiguration, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { devRouteOf } from "../../packages/broker/src/aws/dev-route-scopes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { localSigner } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const T0 = Date.parse("2026-11-15T12:00:00.000Z");
const ADA = "a".repeat(64);
const STEPPED = T0 / 1000 - 120;
const signer = localSigner();

async function bearer(claims: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: ISSUER, aud: "web-app", azp: "web-app", sub: ADA, amr: "oidc", env: "production", sid: "s-cloud", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}

let deps: DeveloperRouteDependencies;
let db: FakeDynamoDb;
function client(access: { fullAccess?: true; scopes?: string[] }) {
  const at = new Date(T0 - 60_000).toISOString();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, secretHash: "f".repeat(64), ...access, createdAt: at, updatedAt: at, updatedBy: "admin" });
}

beforeEach(() => {
  db = new FakeDynamoDb();
  const developer: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => T0 }),
  };
  deps = { documentClient: db, tableName: "state", developer, now: () => T0 };
  db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", email: "ada@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ pk: "SESSION#s-cloud", sk: "META", sessionId: "s-cloud", developerId: ADA, amr: "oidc", clientId: "web-app", startedAt: new Date(T0 - 1000).toISOString(), endsAt: T0 / 1000 + 604_800 });
});
afterEach(() => { vi.useRealTimers(); });

const projects = devRouteOf("GET", "/v1/dev/projects")!;

describe("a sign-in client's token carries the verified step-up to the developer routes", () => {
  it("a full-access client's token with a step-up gives the caller that step-up (ISO time, Code's factor)", async () => {
    client({ fullAccess: true });
    const caller = await authenticateCaller(deps, await bearer({ step_up_at: STEPPED, step_up_amr: "email_code" }), projects);
    expect(caller).toMatchObject({ developerId: ADA, clientId: "web-app", stepUp: { at: new Date(STEPPED * 1000).toISOString(), method: "email_code" } });
  });

  it("a scoped client's token carries it too, behind the route's own scope check", async () => {
    client({ scopes: ["tasks:read"] });
    const caller = await authenticateCaller(deps, await bearer({ scope: "tasks:read", step_up_at: STEPPED, step_up_amr: "passkey" }), projects);
    expect(caller.stepUp).toEqual({ at: new Date(STEPPED * 1000).toISOString(), method: "passkey" });
  });

  it("gives no step-up for a token without one, a factor Code does not own, one claim alone, or a time that does not read", async () => {
    client({ fullAccess: true });
    for (const claims of [{}, { step_up_at: STEPPED, step_up_amr: "slack" }, { step_up_at: STEPPED }, { step_up_amr: "email_code" }, { step_up_at: "2026-11-15T11:58:00.000Z", step_up_amr: "email_code" }, { step_up_at: -1, step_up_amr: "email_code" }]) {
      const caller = await authenticateCaller(deps, await bearer(claims), projects);
      expect(caller.stepUp, JSON.stringify(claims)).toBeUndefined();
    }
  });

  it("never takes a step-up from a token it did not verify (a forged signature is refused whole)", async () => {
    client({ fullAccess: true });
    const good = await bearer({ step_up_at: STEPPED, step_up_amr: "email_code" });
    const [head, , signature] = good.slice("Bearer ".length).split(".");
    const forged = Buffer.from(JSON.stringify({ iss: ISSUER, aud: "web-app", azp: "web-app", sub: ADA, amr: "oidc", env: "production", sid: "s-cloud", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, step_up_at: T0 / 1000, step_up_amr: "passkey" })).toString("base64url");
    await expect(authenticateCaller(deps, `Bearer ${head}.${forged}.${signature}`, projects)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
