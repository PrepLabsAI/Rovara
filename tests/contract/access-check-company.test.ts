// DEC 253z (onboarding, design cloud-per-person-company-onboarding.md section 2): the access check (POST /v1/dev/access)
// names the person's company, company role and company name, read from LIVE membership on each call. Cloud takes the
// company only from this answer. Two companies, a removed member, no company; a token claim or a request field never names it.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AccessCheckResponseSchema, AgentXError, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey, type CompanyMembershipReader } from "../../packages/broker/src/aws/company-check.js";
import { routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { CompanySignInStore, companyKey } from "../../packages/broker/src/developer/company-membership.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIME = "2026-11-01T09:00:00.000Z";
const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const ALICE = "a".repeat(64), BOB = "b".repeat(64), CAROL = "c".repeat(64), NOBODY = "e".repeat(64);
const SESSIONS: Record<string, string> = { [ALICE]: "s-alice", [BOB]: "s-bob", [CAROL]: "s-carol", [NOBODY]: "s-nobody" };
const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
const REFUSED = { status: 401, body: { error: { code: "AUTH_REQUIRED", message: expect.any(String) as unknown } } };

function world(options: { companies?: false; reader?: CompanyMembershipReader } = {}) {
  const db = new FakeDynamoDb({ seed: 11 });
  const claims: Record<string, unknown> = { azp: "web-app", env: "test", sub: ALICE, sid: SESSIONS[ALICE], amr: "slack" };
  db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app", redirectUris: ["https://cloud.example.com/callback"], loopback: false,
    installLevel: true, fullAccess: true, secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: TIME, updatedAt: TIME, updatedBy: "admin" });
  for (const [id, name] of [[ALICE, "Alice"], [BOB, "Bob"], [CAROL, "Carol"], [NOBODY, "Nobody"]] as const) {
    db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "slack", displayName: name, email: `${name.toLowerCase()}@example.test`, revoked: false });
    db.set({ pk: `SESSION#${SESSIONS[id]}`, sk: "META", sessionId: SESSIONS[id], developerId: id, amr: "slack", clientId: "web-app", startedAt: new Date(NOW - 60_000).toISOString(), endsAt: NOW / 1000 + 3600 });
  }
  const join = (id: string, companyId: string, role: "owner" | "admin" | "member", extra: Record<string, unknown> = {}) =>
    db.set({ ...membershipKey(id), entityType: "COMPANY_MEMBERSHIP", personId: id, companyId, role, joinedAt: TIME, ...extra });
  const company = (companyId: string, name: string, extra: Record<string, unknown> = {}) =>
    db.set({ ...companyKey(companyId), entityType: "COMPANY", companyId, name, status: "active", createdAt: TIME, createdBy: "operator", ...extra });
  company(A, "Alpha Works"); company(B, "Beta Labs");
  join(ALICE, A, "owner"); join(BOB, B, "member"); join(CAROL, IMPLICIT_COMPANY_ID, "admin");
  const deps: DeveloperRouteDependencies = {
    documentClient: db, tableName: "State", now: () => NOW,
    ...(options.companies === false ? {} : { companies: options.reader ?? companyMembershipFromDynamo(db, "SignIn") }),
    developer: {
      issuer: "https://signin.example.test", env: "test", methods: { slack: true, oidc: true }, signInTableName: "SignIn",
      verifyAccessToken: async () => claims, channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
    },
  };
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const send = async (authorization: string, body: unknown) => {
    const request = { method: "POST", path: "/v1/dev/access", headers: { authorization }, requestId: "r", body: JSON.stringify(body) };
    try { return { status: 200, body: await routeDeveloperRequest(deps, request, new URL("/v1/dev/access", "https://broker.example.test")) as Record<string, unknown> }; } catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } as Record<string, unknown> };
    }
  };
  /** The person's own token for the web app (Bearer). */
  const asPerson = (id: string, body: unknown = {}) => { claims.sub = id; claims.sid = SESSIONS[id]; return send(`Bearer ${part({ alg: "none" })}.${part(claims)}.sig`, body); };
  /** The web app's own credentials, asking about a person by id (HTTP Basic). */
  const asService = (id: string) => send(`Basic ${Buffer.from(`web-app:${SECRET}`).toString("base64")}`, { developerId: id });
  return { db, deps, claims, join, company, asPerson, asService };
}

const company = (body: Record<string, unknown>) => ({ companyId: body.companyId, companyRole: body.companyRole, companyName: body.companyName });

describe("the access check names the person's company from live membership", () => {
  it("two companies: each person gets only their own company, by token and by service credentials", async () => {
    const w = world();
    for (const ask of [w.asPerson, w.asService]) {
      const alice = await ask(ALICE), bob = await ask(BOB);
      expect(alice.status).toBe(200); expect(bob.status).toBe(200);
      expect(company(alice.body)).toEqual({ companyId: A, companyRole: "owner", companyName: "Alpha Works" });
      expect(company(bob.body)).toEqual({ companyId: B, companyRole: "member", companyName: "Beta Labs" });
      expect(JSON.stringify(alice.body)).not.toMatch(/Beta Labs|org_b/);
      expect(JSON.stringify(bob.body)).not.toMatch(/Alpha Works|org_a/);
      // What leaves is the strict schema, nothing else.
      expect(AccessCheckResponseSchema.parse(alice.body)).toEqual(alice.body);
    }
  });

  it("the role and company are read live on each call", async () => {
    const w = world();
    expect((await w.asPerson(BOB)).body.companyRole).toBe("member");
    w.join(BOB, B, "admin");
    expect((await w.asPerson(BOB)).body.companyRole).toBe("admin");
    w.company(B, "Beta Labs Renamed");
    expect((await w.asService(BOB)).body.companyName).toBe("Beta Labs Renamed");
  });

  it("a token claim or a request field never names the company", async () => {
    const w = world();
    Object.assign(w.claims, { companyId: B, org: B, company: B, companyRole: "owner" });
    const answer = await w.asPerson(BOB);
    expect(company(answer.body)).toEqual({ companyId: B, companyRole: "member", companyName: "Beta Labs" });
    Object.assign(w.claims, { companyId: A, org: A, company: A });
    expect(company((await w.asPerson(BOB)).body)).toEqual({ companyId: B, companyRole: "member", companyName: "Beta Labs" });
    // The request body stays strict: no company field is accepted.
    expect((await w.asPerson(BOB, { companyId: A })).status).toBe(400);
  });

  it("a removed member is refused, with no company in the refusal", async () => {
    const w = world();
    w.join(BOB, B, "member", { revokedAt: TIME, revokedBy: ALICE });
    for (const answer of [await w.asPerson(BOB), await w.asService(BOB)]) {
      expect(answer).toEqual(REFUSED);
      expect(JSON.stringify(answer.body)).not.toMatch(/org_|Beta/);
    }
    // A positive control: the same person answered before removal.
    w.join(BOB, B, "member");
    expect((await w.asPerson(BOB)).status).toBe(200);
  });

  it("a signed-in person in no company is refused (Cloud shows the no-company state)", async () => {
    const w = world();
    for (const answer of [await w.asPerson(NOBODY), await w.asService(NOBODY)]) expect(answer).toEqual(REFUSED);
  });

  it("a Code with no company layer answers as before, with no company fields", async () => {
    const w = world({ companies: false });
    const answer = await w.asPerson(ALICE);
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body).sort()).toEqual(["administrator", "developerId", "displayName", "nameChosen", "notices", "projects"]);
  });

  it("the built-in company has no stored profile: company and role, no name", async () => {
    const w = world();
    const answer = await w.asPerson(CAROL);
    expect(company(answer.body)).toEqual({ companyId: IMPLICIT_COMPANY_ID, companyRole: "admin", companyName: undefined });
    expect("companyName" in answer.body).toBe(false);
    // Once a profile is stored for it, its name is answered.
    w.company(IMPLICIT_COMPANY_ID, "Founders");
    expect((await w.asPerson(CAROL)).body.companyName).toBe("Founders");
  });

  it("a company created through the sign-in store is read by the same key", async () => {
    const w = world();
    const store = new CompanySignInStore({ documentClient: w.db, tableName: "SignIn", now: () => NOW });
    const C = "org_cccccccccccccccccccc";
    await store.create(C, "Gamma Co", "carol@example.test", 24);
    w.join(CAROL, C, "admin");
    expect(company((await w.asPerson(CAROL)).body)).toEqual({ companyId: C, companyRole: "admin", companyName: "Gamma Co" });
  });

  it("a company with no stored profile answers its id and role with no name", async () => {
    const w = world();
    w.db.delete(companyKey(B).pk, companyKey(B).sk);
    const answer = await w.asPerson(BOB);
    expect(company(answer.body)).toEqual({ companyId: B, companyRole: "member", companyName: undefined });
    expect("companyName" in answer.body).toBe(false);
  });

  it.each([
    ["a malformed stored company", (w: ReturnType<typeof world>) => w.company(B, "")],
    ["a stored company with another id", (w: ReturnType<typeof world>) => w.company(B, "Beta Labs", { companyId: A })],
    ["a stored company that is not active", (w: ReturnType<typeof world>) => w.company(B, "Beta Labs", { status: "closed" })],
  ])("fails closed on %s", async (_name, breakIt) => {
    const w = world();
    breakIt(w);
    expect(await w.asPerson(BOB)).toEqual(REFUSED);
    expect(await w.asService(BOB)).toEqual(REFUSED);
  });

  it("fails closed when the membership reader cannot give the role, or names another company than it resolved", async () => {
    const base = world();
    const live = companyMembershipFromDynamo(base.db, "SignIn");
    const noRole: CompanyMembershipReader = { companyOf: (id: string) => live.companyOf(id) };
    const split: CompanyMembershipReader = { companyOf: (id: string) => live.companyOf(id), membershipOf: async (id) => { const m = await live.membershipOf!(id); return m === undefined ? undefined : { ...m, companyId: m.companyId === A ? B : A }; } };
    const broken: CompanyMembershipReader = { companyOf: (id: string) => live.companyOf(id), membershipOf: async () => { throw new Error("secret-cause-canary"); } };
    for (const reader of [noRole, split, broken]) {
      const w = world({ reader });
      const answer = await w.asPerson(ALICE);
      expect(answer).toEqual(REFUSED);
      expect(JSON.stringify(answer.body)).not.toContain("canary");
    }
  });

  it("a host's stricter rule keeps the company fields as Code answered them", async () => {
    const w = world();
    w.deps.developer.accessRules = [(_context, answer) => {
      expect(answer.companyId).toBe(A);
      (answer as { companyId?: string }).companyId = B;
      return { administrator: false };
    }];
    const answer = await w.asPerson(ALICE);
    // A rule that throws (the frozen answer) refuses; one that only narrows keeps Code's company.
    expect(answer).toEqual(REFUSED);
    w.deps.developer.accessRules = [() => ({ administrator: false, projects: [] })];
    expect(company((await w.asPerson(ALICE)).body)).toEqual({ companyId: A, companyRole: "owner", companyName: "Alpha Works" });
  });
});

describe("the access answer schema", () => {
  const base = { developerId: ALICE, displayName: "Alice", nameChosen: false, administrator: false, projects: [], notices: [] };
  it("accepts the old shape and the full company shape", () => {
    expect(AccessCheckResponseSchema.safeParse(base).success).toBe(true);
    expect(AccessCheckResponseSchema.safeParse({ ...base, companyId: A, companyRole: "owner" }).success).toBe(true);
    expect(AccessCheckResponseSchema.safeParse({ ...base, companyId: A, companyRole: "member", companyName: "Alpha" }).success).toBe(true);
  });
  it.each([
    ["a role without a company", { companyRole: "owner" }],
    ["a company without a role", { companyId: A }],
    ["a name without a company", { companyName: "Alpha" }],
    ["an unknown role", { companyId: A, companyRole: "superuser" }],
    ["a bad company id", { companyId: "org_A", companyRole: "owner" }],
    ["an empty name", { companyId: A, companyRole: "owner", companyName: "" }],
    ["a long name", { companyId: A, companyRole: "owner", companyName: "x".repeat(81) }],
    ["an unknown field", { companyId: A, companyRole: "owner", companyPlan: "free" }],
  ])("refuses %s", (_name, extra) => {
    expect(AccessCheckResponseSchema.safeParse({ ...base, ...extra }).success).toBe(false);
  });
});
