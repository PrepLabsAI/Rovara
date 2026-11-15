// Spec 065 phase 065a: a sign-in client acts as its signed-in person, within the scopes an administrator registered it
// with and the person's own rights. Its token carries the scopes it asked for that the registration allows; the
// /v1/dev/client/* routes take only such a token, and a project's members are managed only by the project's
// administrators or a Rovara administrator.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signInClientRegistration } from "../../packages/cli/src/admin/sign-in-clients.js";
import type { DeveloperApiConfiguration } from "../../packages/broker/src/aws/developer-routes.js";
import { emailIndexKey } from "../../packages/broker/src/developer/store.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { createAdminBroker, type AdminHandler } from "../support/admin-broker.js";
import { localSigner } from "../support/developer-fakes.js";
import { VERIFIER, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";

// ---- The token: scopes asked for at sign-in, limited by the registration (FR-002) ----

describe("a client's token scopes (FR-002)", () => {
  const WEB = "https://cloud.example.com/callback";
  const ada: FakeOidcUser = { sub: "ada", name: "Ada", email: "ada@example.com", email_verified: true, groups: ["agentx-admin"] };
  function harness() {
    const h = identityHarness({ oidc: { administrator: { claim: "groups", values: ["agentx-admin"] } }, oidcUsers: [ada] });
    const register = (scopes?: Array<"projects:members" | "projects:create">) => h.deps.store.putClient({
      clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: [WEB], loopback: false,
      secretHash: createHash("sha256").update("cloud-secret").digest("hex"), ...(scopes === undefined ? {} : { scopes }),
      createdAt: new Date(h.now() - 1000).toISOString(), updatedAt: new Date(h.now()).toISOString(), updatedBy: "admin",
    });
    const basic = `Basic ${Buffer.from("web-app:cloud-secret").toString("base64")}`;
    const form = async (body: Record<string, string>) => {
      const event = httpEvent("POST", "/v1/auth/token", body);
      const response = await h.http({ ...event, headers: { ...event.headers, authorization: basic } });
      return JSON.parse(response.body) as Record<string, unknown>;
    };
    const signIn = async (scope?: string) => {
      const back = await h.signIn("oidc", "ada", { query: { client_id: "web-app", redirect_uri: WEB, ...(scope === undefined ? {} : { scope }) } });
      return form({ grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", code_verifier: VERIFIER, redirect_uri: WEB });
    };
    return { register, signIn, refresh: (token: string) => form({ grant_type: "refresh_token", refresh_token: token }) };
  }

  it("carries the scopes asked for that the registration allows, and drops the rest without refusing", async () => {
    const { register, signIn } = harness();
    await register(["projects:members"]);
    const tokens = await signIn("projects:members projects:create made:up");
    expect(decodeJwt(tokens.access_token as string)).toMatchObject({ aud: "web-app", scope: "projects:members" });
  });

  it("carries none when the client asked for none, or may use none", async () => {
    const { register, signIn } = harness();
    await register();
    expect(decodeJwt((await signIn("projects:members")).access_token as string).scope).toBeUndefined();
  });

  it("ends a scope at the next refresh once the registration no longer allows it", async () => {
    const { register, signIn, refresh } = harness();
    await register(["projects:members", "projects:create"]);
    const tokens = await signIn("projects:members projects:create");
    expect(decodeJwt(tokens.access_token as string).scope).toBe("projects:members projects:create");
    await register(["projects:create"]);
    const refreshed = await refresh(tokens.refresh_token as string);
    expect(decodeJwt(refreshed.access_token as string).scope).toBe("projects:create");
  });

  it("is registered with the CLI's --scope, and refuses one that does not exist", () => {
    expect(signInClientRegistration("web-app", { audience: "web-app", redirect: [WEB], scope: "projects:members, projects:create" }).scopes)
      .toEqual(["projects:members", "projects:create"]);
    expect(() => signInClientRegistration("web-app", { audience: "web-app", redirect: [WEB], scope: "projects:delete" })).toThrow("--scope");
  });
});

// ---- The routes: as the signed-in person (FR-003 to FR-005) ----

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com/v1/auth";
const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const ADA = "a".repeat(64);
const BO = "b".repeat(64);
const CY = "c".repeat(64);
const signer = localSigner();
let db: FakeDynamoDb;
let handler: AdminHandler;

async function token(claims: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: ISSUER, aud: "web-app", azp: "web-app", sub: ADA, amr: "oidc", env: "production", sid: "s-ada", iat: T0 / 1000, nbf: T0 / 1000, exp: T0 / 1000 + 3600, scope: "projects:members", ...claims };
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: (await signer.publicJwk()).kid })).toString("base64url");
  const input = `${header}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `Bearer ${input}.${(await signer.sign(Buffer.from(input))).toString("base64url")}`;
}

async function call(method: string, path: string, authorization: string) {
  const response = await handler({ rawPath: path, routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization }, requestContext: { requestId: "r", http: { method } } });
  return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
}

function session(id: string, developerId: string, extra: Record<string, unknown> = {}) {
  db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId, amr: "oidc", clientId: "web-app", startedAt: new Date(T0).toISOString(), endsAt: T0 / 1000 + 604_800, ...extra });
}

beforeEach(async () => {
  vi.useFakeTimers({ now: T0, toFake: ["Date"] });
  const linking: DeveloperApiConfiguration = {
    issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(), clientRoutes: true,
    verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
  };
  ({ db, handler } = await createAdminBroker({ linking, channelAdapters: true }));
  const at = new Date(T0 - 60_000).toISOString();
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, scopes: ["projects:members"], createdAt: at, updatedAt: at, updatedBy: "admin" });
  for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"], [CY, "Cy"]] as const) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "oidc", issuer: "https://idp.example.test", subject: name.toLowerCase(), displayName: name, email: `${name.toLowerCase()}@example.com`, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
  db.set({ ...emailIndexKey("cy@example.com"), developerId: CY });
  db.set({ pk: "PROJECT#payments", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "payments", revision: 1 } });
  session("s-ada", ADA, { administrator: true });
  session("s-bo", BO);
});
afterEach(() => { vi.useRealTimers(); });

describe("a project's members, as the signed-in person (FR-003 to FR-005)", () => {
  it("lets a Rovara administrator add a member by email, list them, and remove them", async () => {
    const added = await call("PUT", "/v1/dev/client/projects/payments/members/cy%40example.com", await token());
    expect(added).toMatchObject({ status: 200, body: { project: "payments", developerId: CY, outcome: "granted" } });
    expect(db.get(`MEMBER#${CY}`, "PROJECT#payments")).toMatchObject({ role: "developer", grantedBy: { issuer: "sign-in-client:web-app", subject: ADA } });
    const listed = await call("GET", "/v1/dev/client/projects/payments/members", await token());
    expect(listed.body).toMatchObject({ project: "payments", members: [{ developerId: CY, name: "Cy", role: "developer" }] });
    expect((await call("PUT", `/v1/dev/client/projects/payments/members/${CY}`, await token())).body).toMatchObject({ outcome: "already_member" });
    const removed = await call("DELETE", `/v1/dev/client/projects/payments/members/${CY}`, await token());
    expect(removed.body).toMatchObject({ outcome: "revoked" });
    expect(db.get(`MEMBER#${CY}`, "PROJECT#payments")).toBeUndefined();
    expect((await call("GET", "/v1/dev/client/projects/payments/members", await token())).body).toMatchObject({ members: [] });
  });

  it("lets a project's own administrator manage it, and no one else", async () => {
    const bo = await token({ sub: BO, sid: "s-bo" });
    expect((await call("GET", "/v1/dev/client/projects/payments/members", bo)).status).toBe(403);
    db.set({ pk: `MEMBER#${BO}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: BO, projectName: "payments", role: "administrator" });
    expect((await call("PUT", `/v1/dev/client/projects/payments/members/${CY}`, bo)).body).toMatchObject({ outcome: "granted" });
  });

  it("refuses without the scope, even for an administrator, and when the registration no longer allows it", async () => {
    expect((await call("GET", "/v1/dev/client/projects/payments/members", await token({ scope: undefined }))).status).toBe(403);
    db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, createdAt: new Date(T0 - 60_000).toISOString(), updatedAt: new Date(T0).toISOString(), updatedBy: "admin" });
    expect((await call("GET", "/v1/dev/client/projects/payments/members", await token())).status).toBe(403);
  });

  it("refuses Rovara's own CLI token, another audience, and an ended session, with the same 401", async () => {
    expect((await call("GET", "/v1/dev/client/projects/payments/members", await token({ aud: "agentx-developer", azp: undefined }))).status).toBe(401);
    expect((await call("GET", "/v1/dev/client/projects/payments/members", await token({ aud: "someone-else" }))).status).toBe(401);
    session("s-ada", ADA, { administrator: true, revokedAt: new Date(T0).toISOString() });
    expect((await call("GET", "/v1/dev/client/projects/payments/members", await token())).status).toBe(401);
  });

  it("answers 404 for a project that is not registered", async () => {
    expect((await call("GET", "/v1/dev/client/projects/ledger/members", await token())).status).toBe(404);
  });
});

describe("a project the signed-in person may use (spec 065)", () => {
  it("answers its revision, their access and its repositories, with no scope needed", async () => {
    db.set({ pk: "PROJECT#payments", sk: "REV#000000000002", entityType: "PROJECT", definition: { name: "payments", revision: 2, repositories: [
      { name: "api", url: "https://github.com/acme/payments-api.git", path: "repo/api", defaultBranch: "main", credentialRef: "github-app" },
      { name: "docs", url: "https://git.example.com/docs", path: "repo/docs", defaultBranch: "trunk", credentialRef: "github-app" },
    ] } });
    db.set({ pk: `MEMBER#${ADA}`, sk: "PROJECT#payments", entityType: "MEMBERSHIP", ownerKey: ADA, projectName: "payments", role: "administrator" });
    const read = await call("GET", "/v1/dev/client/projects/payments", await token({ scope: undefined }));
    expect(read).toEqual({ status: 200, body: { requestId: "r", name: "payments", latestRevision: 2, access: "administrator", repositories: [
      { name: "api", url: "https://github.com/acme/payments-api.git", defaultBranch: "main", fullName: "acme/payments-api" },
      { name: "docs", url: "https://git.example.com/docs", defaultBranch: "trunk" },
    ] } });
  });

  it("answers 404 for a project they may not use, and refuses another token with 401", async () => {
    expect((await call("GET", "/v1/dev/client/projects/payments", await token({ sub: BO, sid: "s-bo" }))).status).toBe(404);
    expect((await call("GET", "/v1/dev/client/projects/payments", await token({ aud: "agentx-developer", azp: undefined }))).status).toBe(401);
  });
});

describe("the client routes are off unless the host turns them on (controller guidance, 2026-11-13)", () => {
  it("answers 404 for every /v1/dev/client route without clientRoutes, even for a valid token", async () => {
    const linking: DeveloperApiConfiguration = {
      issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(),
      verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    };
    ({ db, handler } = await createAdminBroker({ linking, channelAdapters: true }));
    const at = new Date(T0 - 60_000).toISOString();
    db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, scopes: ["projects:members", "projects:create"], createdAt: at, updatedAt: at, updatedBy: "admin" });
    db.set({ pk: `DEVELOPER#${ADA}`, sk: "META", developerId: ADA, provider: "oidc", issuer: "https://idp.example.test", subject: "ada", displayName: "Ada", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    db.set({ pk: "PROJECT#payments", sk: "REV#000000000001", entityType: "PROJECT", definition: { name: "payments", revision: 1 } });
    session("s-ada", ADA, { administrator: true });
    const bearer = await token({ scope: "projects:members projects:create" });
    for (const [method, path] of [["GET", "/v1/dev/client/projects/payments"], ["GET", "/v1/dev/client/projects/payments/members"], ["PUT", `/v1/dev/client/projects/payments/members/${ADA}`], ["POST", "/v1/dev/client/projects"], ["GET", "/v1/dev/client/repositories"]] as const) {
      expect((await call(method, path, bearer)).status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("creating a project from a repository (spec 065b)", () => {
  const binding = { deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0", subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }], volumeSizeGiB: 20, volumeType: "gp3" };
  async function creating() {
    const looked: string[] = [];
    const linking: DeveloperApiConfiguration = {
      issuer: ISSUER, env: "production", methods: { slack: false, oidc: true }, signInTableName: "signin", channelMembers: vi.fn(), clientRoutes: true,
      verifyAccessToken: developerTokenVerifier({ issuer: ISSUER, keys: async () => [await signer.publicJwk()], now: () => Date.now() }),
    };
    const clientProjects = {
      credentialRef: "github-agentx",
      repositoryDefaults: async (url: string) => { looked.push(url); return { owner: "acme", name: "Web-App", defaultBranch: "trunk" }; },
      repositories: async () => [{ installationId: 7, accountLogin: "acme", accountType: "Organization" as const, repositorySelection: "selected" as const, status: "active" as const, repositories: [{ fullName: "acme/Web-App", githubRepositoryId: 101, private: true, defaultBranch: "trunk" }] }],
      workerBinding: async () => binding,
    };
    ({ db, handler } = await createAdminBroker({ linking, channelAdapters: true, clientProjects }));
    const at = new Date(T0 - 60_000).toISOString();
    db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false, scopes: ["projects:members", "projects:create"], createdAt: at, updatedAt: at, updatedBy: "admin" });
    for (const [id, name] of [[ADA, "Ada"], [BO, "Bo"]] as const) db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "oidc", issuer: "https://idp.example.test", subject: name.toLowerCase(), displayName: name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    session("s-ada", ADA, { administrator: true });
    session("s-bo", BO);
    const create = async (body: unknown, authorization?: string) => {
      const response = await handler({ rawPath: "/v1/dev/client/projects", routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization: authorization ?? await token({ scope: "projects:create" }) }, body: JSON.stringify(body), requestContext: { requestId: "r", http: { method: "POST" } } });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    const repositories = async (authorization?: string) => {
      const response = await handler({ rawPath: "/v1/dev/client/repositories", routeKey: "ANY /v1/dev/{proxy+}", headers: { authorization: authorization ?? await token({ scope: "projects:create" }) }, requestContext: { requestId: "r", http: { method: "GET" } } });
      return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
    };
    return { create, looked, repositories };
  }

  it("lists the repositories the GitHub App can reach, with the same scope and rights as creating", async () => {
    const { repositories } = await creating();
    expect(await repositories()).toMatchObject({ status: 200, body: { installations: [{ installationId: 7, accountLogin: "acme", status: "active", repositories: [{ fullName: "acme/Web-App", githubRepositoryId: 101 }] }] } });
    expect((await repositories(await token({ scope: "projects:members" }))).status).toBe(403);
    expect((await repositories(await token({ sub: BO, sid: "s-bo", scope: "projects:create" }))).status).toBe(403);
  });

  it("builds the project from the repository with the GitHub App and the worker binding, and makes its creator its administrator", async () => {
    const { create, looked } = await creating();
    const created = await create({ repository: "acme/Web-App", setupCommands: ["npm ci"], testCommands: ["npm test", "npm run lint"] });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: "web-app", latestRevision: 1, access: "administrator", repositories: [{ name: "web-app", url: "https://github.com/acme/Web-App.git", defaultBranch: "trunk", fullName: "acme/Web-App" }] });
    expect(looked).toEqual(["https://github.com/acme/Web-App.git"]);
    expect(db.get("PROJECT#web-app", "REV#000000000001")).toMatchObject({
      definition: {
        repositories: [{ name: "web-app", path: "repo/web-app", defaultBranch: "trunk", credentialRef: "github-agentx" }],
        setup: [{ cwd: "repo/web-app", executable: "npm", args: ["ci"] }],
        readiness: [{ executable: "npm", args: ["test"] }, { executable: "npm", args: ["run", "lint"] }],
      },
      runtimeBinding: binding,
    });
    expect(db.get(`MEMBER#${ADA}`, "PROJECT#web-app")).toMatchObject({ role: "administrator" });
    expect(db.get("PROJECT_MEMBERS#web-app", `DEVELOPER#${ADA}`)).toMatchObject({ role: "administrator" });
  });

  it("takes a name, and refuses one that is taken", async () => {
    const { create } = await creating();
    expect((await create({ repository: "acme/Web-App", name: "storefront" })).body).toMatchObject({ name: "storefront" });
    const taken = await create({ repository: "acme/Web-App", name: "storefront" });
    expect(taken.status).toBe(400);
    expect(JSON.stringify(taken.body)).toContain("already exists");
  });

  it("refuses without the scope, for someone who is not a Rovara administrator, and an invalid request", async () => {
    const { create } = await creating();
    expect((await create({ repository: "acme/Web-App" }, await token({ scope: "projects:members" }))).status).toBe(403);
    expect((await create({ repository: "acme/Web-App" }, await token({ sub: BO, sid: "s-bo", scope: "projects:create" }))).status).toBe(403);
    expect((await create({ repository: "not a repository" })).status).toBe(400);
    expect(db.find((item) => String(item.pk).startsWith("PROJECT#"))).toEqual([]);
  });
});

describe("the foundation's worker binding from its zone=subnet pairs (spec 065b)", () => {
  it("lists one subnet per zone, in order, and refuses a malformed pair", async () => {
    const { workerBindingFromPairs } = await import("../../packages/broker/src/aws/worker-binding.js");
    expect(workerBindingFromPairs("us-east-1a=subnet-0123456789abcdef0, us-east-1b=subnet-0fedcba9876543210", "lt-0123456789abcdef0")).toMatchObject({
      deploymentMode: "ec2-ebs", launchTemplateId: "lt-0123456789abcdef0",
      subnets: [{ availabilityZone: "us-east-1a", subnetId: "subnet-0123456789abcdef0" }, { availabilityZone: "us-east-1b", subnetId: "subnet-0fedcba9876543210" }],
    });
    expect(() => workerBindingFromPairs("subnet-0123456789abcdef0", "lt-0123456789abcdef0")).toThrow();
  });
});
