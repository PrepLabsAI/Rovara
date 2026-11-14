// Spec 066: a sign-in client with full access. Rovara's developer API accepts its tokens as the signed-in person, with all
// their rights, as it does the Rovara CLI's; a client without it is refused there as before. The setting is read at every
// request, so turning it off ends that at once. Only a client with a secret can have it.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInClientRegistrationSchema } from "@agentx/contracts";
import { signInClientRegistration, signInClientUpdate } from "../../packages/cli/src/admin/sign-in-clients.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { identityHarness, localSigner } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const ADA = "a".repeat(64);
const signer = localSigner();
let db: FakeDynamoDb;
let handler: AdminHandler;

async function bearer(claims: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: ISSUER, aud: "rovara-cloud", azp: "rovara-cloud", sub: ADA, amr: "oidc", env: "production", sid: "s-cloud", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}
const cli = () => bearer({ aud: "agentx-developer", azp: "agentx-cli", sid: "s-cli" });

async function call(path: string, authorization: string) {
  const response = await handler({ rawPath: path, routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization }, requestContext: { requestId: "r", http: { method: "GET" } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

function client(fullAccess: boolean) {
  const at = new Date(T0 - 60_000).toISOString();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#rovara-cloud", entityType: "SIGN_IN_CLIENT", clientId: "rovara-cloud", name: "Rovara Cloud", audience: "rovara-cloud", redirectUris: ["https://cloud.example.com/callback"], loopback: false, secretHash: "f".repeat(64), ...(fullAccess ? { fullAccess: true } : {}), createdAt: at, updatedAt: at, updatedBy: "admin" });
}

async function setUp(mode: "linking" | "developer") {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const config: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker(mode === "linking" ? { linking: config, channelAdapters: true } : { developer: config, channelAdapters: true }));
  db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", email: "ada@example.com", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  const started = new Date(T0).toISOString();
  db.set({ pk: "SESSION#s-cloud", sk: "META", sessionId: "s-cloud", developerId: ADA, amr: "oidc", clientId: "rovara-cloud", startedAt: started, endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: "SESSION#s-cli", sk: "META", sessionId: "s-cli", developerId: ADA, amr: "oidc", startedAt: started, endsAt: T0 / 1000 + 604_800 });
  db.set({ pk: "PROJECT#payments", sk: "REV#000000000003", entityType: "PROJECT", definition: { name: "payments", revision: 3 } });
  db.set({ pk: `MEMBER#${ADA}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: ADA, projectName: "payments", role: "developer" });
}
afterEach(() => { vi.useRealTimers(); });

for (const mode of ["linking", "developer"] as const) {
  describe(`the developer API with a full-access client's token (${mode === "linking" ? "production, spec 064" : "a named environment"})`, () => {
    beforeEach(async () => { await setUp(mode); });

    it("lists the person's projects and workspaces, as it does for the Rovara CLI's token", async () => {
      client(true);
      const listed = await call("/v1/dev/projects", await bearer());
      expect(listed).toMatchObject({ status: 200, body: { developer: { id: ADA, name: "Ada", provider: "oidc", email: "ada@example.com" }, projects: [{ name: "payments", latestRevision: 3, access: "granted" }] } });
      expect((await call("/v1/dev/projects", await cli())).body.projects).toEqual(listed.body.projects);
      expect(await call("/v1/dev/workspaces", await bearer())).toMatchObject({ status: 200, body: { projects: [{ name: "payments" }], workspaces: [] } });
      expect((await call("/v1/dev/channel-links", await bearer())).status).toBe(200);
    });

    it("refuses a client without full access, and stops at once when full access is turned off", async () => {
      client(false);
      expect((await call("/v1/dev/projects", await bearer())).status).toBe(401);
      client(true);
      expect((await call("/v1/dev/projects", await bearer())).status).toBe(200);
      client(false);
      expect((await call("/v1/dev/projects", await bearer())).status).toBe(401);
      expect((await call("/v1/dev/projects", await cli())).status).toBe(200);
    });

    it("refuses an ended session, a removed person, another audience and another client's session", async () => {
      client(true);
      expect((await call("/v1/dev/projects", await bearer({ aud: "someone-else" }))).status).toBe(401);
      expect((await call("/v1/dev/projects", await bearer({ sid: "s-cli" }))).status).toBe(401);
      db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", firstSignInAt: "x", lastSignInAt: "x", revoked: true });
      expect((await call("/v1/dev/projects", await bearer())).status).toBe(401);
      db.set({ pk: "SESSION#s-cloud", sk: "META", sessionId: "s-cloud", developerId: ADA, amr: "oidc", clientId: "rovara-cloud", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800, revokedAt: new Date(T0).toISOString() });
      expect((await call("/v1/dev/projects", await bearer())).status).toBe(401);
    });

    it("gives a full-access client every scope on its own routes", async () => {
      client(true);
      db.set({ pk: `MEMBER#${ADA}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: ADA, projectName: "payments", role: "administrator" });
      expect((await call("/v1/dev/client/projects/payments/members", await bearer())).status).toBe(200);
    });
  });
}

describe("registering full access (spec 066)", () => {
  it("is only for a client with a secret, new or kept", () => {
    const base = { name: "Rovara Cloud", audience: "rovara-cloud", redirectUris: [], loopback: true, fullAccess: true };
    expect(SignInClientRegistrationSchema.safeParse(base).success).toBe(false);
    expect(SignInClientRegistrationSchema.safeParse({ ...base, secretHash: "f".repeat(64) }).success).toBe(true);
    expect(SignInClientRegistrationSchema.safeParse({ ...base, keepSecret: true }).success).toBe(true);
    expect(() => signInClientRegistration("rovara-cloud", { audience: "rovara-cloud", loopback: true, fullAccess: true })).toThrow("--full-access");
    expect(signInClientRegistration("rovara-cloud", { audience: "rovara-cloud", loopback: true, fullAccess: true }, "f".repeat(64)).fullAccess).toBe(true);
  });

  it("is kept by an update that does not name it, and turned off with --no-full-access", () => {
    const current = { clientId: "rovara-cloud", name: "Rovara Cloud", audience: "rovara-cloud", redirectUris: [], loopback: true, confidential: true, fullAccess: true as const, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z", updatedBy: "admin" };
    expect(signInClientUpdate(current, { name: "Cloud" })).toMatchObject({ fullAccess: true, keepSecret: true });
    expect(signInClientUpdate(current, { fullAccess: false }).fullAccess).toBeUndefined();
    expect(() => signInClientUpdate({ ...current, confidential: false, fullAccess: undefined }, { fullAccess: true })).toThrow("--full-access");
  });

  it("is refused by the sign-in server for a client with no secret", async () => {
    const h = identityHarness();
    const at = "2026-11-13T00:00:00.000Z";
    const record = { clientId: "rovara-cloud", name: "Rovara Cloud", audience: "rovara-cloud", redirectUris: [], loopback: true, fullAccess: true, createdAt: at, updatedAt: at, updatedBy: "admin" };
    expect(await h.handler({ kind: "put-sign-in-client", client: record } as never)).toEqual({ ok: false, error: "invalid_request" });
    expect(await h.handler({ kind: "put-sign-in-client", client: { ...record, secretHash: createHash("sha256").update("s").digest("hex") } } as never)).toEqual({ ok: true });
  });
});
