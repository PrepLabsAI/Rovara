// DEC 253z, 254a: a person with no company signs in to the web app with no company, sees "create your company" through the access check, and
// makes their own company with an operator's invite code (POST /v1/dev/company). Real sign-in server, real broker routes, one wire-level table.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { AgentXError, COMPANY_SELF_CREATE_TEXT, IMPLICIT_COMPANY_ID, companyScoped, newCompanyInviteCode } from "@agentx/contracts";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { companyMembershipFromDynamo, membershipKey } from "../../packages/broker/src/aws/company-check.js";
import { companySelfCreateThroughLambda, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { CompanyInviteStore, INVITE_CODES_PK, INVITE_LOG_PK, SELF_CREATE_TRIES_PER_HOUR } from "../../packages/broker/src/developer/company-invites.js";
import { CompanySignInStore, companyKey, companyMemberKey } from "../../packages/broker/src/developer/company-membership.js";
import { companyOperator } from "../../packages/broker/src/developer/company-operator.js";
import { COMPANY_CHECKED_ROUTES } from "../support/company-route-harness.js";
import { identityHarness, ISSUER, OIDC_ISSUER } from "../support/developer-fakes.js";

const WEB = "https://cloud.example.test/callback";
const SECRET = ["web", "app", "secret", "for", "tests"].join("-");
const X = COMPANY_A.orgId, Y = COMPANY_B.orgId;
const TASK = "11111111-1111-4111-8111-111111111111";
const NEW_SESSION = "22222222-2222-4222-8222-222222222222";
const person = (subject: string) => ownerKeyForSubject(OIDC_ISSUER, subject);
type Answer = { status: number; body: Record<string, unknown> };

function world(options: { webApp?: boolean; administrator?: boolean } = {}) {
  const users = ["new", "second", "legacy", "member"].map((sub) => ({ sub, email: `${sub}@example.test`, email_verified: true, name: `${sub} person`, groups: ["admins"] }));
  const h = identityHarness({ oidc: options.administrator === true ? { administrator: { claim: "groups", values: ["admins"] } } : {}, oidcUsers: users });
  const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  const ids = [X, Y]; let next = 0;
  const invites = new CompanyInviteStore({ documentClient: h.db, tableName: "signin", now: h.now, company, selfServeAllowed: true, newCompanyId: () => ids[next++]! });
  h.deps.company = company; h.deps.companyInvites = invites;
  const before = new Date(h.now() - 86_400_000).toISOString();
  const client = { pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Rovara", audience: "web-app", redirectUris: [WEB], loopback: false,
    installLevel: true, fullAccess: true, ...(options.webApp === false ? {} : { webApp: true }), secretHash: createHash("sha256").update(SECRET).digest("hex"), createdAt: before, updatedAt: before, updatedBy: "operator" };
  h.db.set(client);
  const operator = (event: unknown) => companyOperator({ store: company, invites, now: h.now, log: h.deps.log }, event);
  /** An operator's code, made as the CLI makes it. */
  const code = async (hours = 24) => { const made = newCompanyInviteCode(); await operator({ kind: "company-invite-create", codeHash: made.codeHash, expiresInHours: hours }); return made; };
  /** A real sign-in to the web app with the install's OIDC: its tokens, or the refusal text. */
  const signIn = async (subject: string, clientId = "web-app") => {
    const back = await h.signIn("oidc", subject, { query: clientId === "web-app" ? { client_id: "web-app", redirect_uri: WEB } : {} });
    const grant = back.searchParams.get("code");
    if (grant === null) return { refused: back.searchParams.get("error_description") ?? "no-code" };
    const tokens = await h.exchange(grant, clientId === "web-app" ? { client_id: "web-app", client_secret: SECRET, redirect_uri: WEB } : {});
    return { access: tokens.body.access_token as string | undefined, refresh: tokens.body.refresh_token as string | undefined, status: tokens.status, refused: undefined };
  };
  const refresh = async (token: string) => {
    const response = await h.http({ version: "2.0", rawPath: "/v1/auth/token", rawQueryString: "", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: "web-app", client_secret: SECRET, refresh_token: token }).toString(), isBase64Encoded: false, requestContext: { http: { method: "POST" }, requestId: "r" } });
    const answer = response as { statusCode: number; body: string };
    return { status: answer.statusCode, body: JSON.parse(answer.body) as Record<string, unknown> };
  };
  const forwarded: unknown[] = [];
  const routes: DeveloperRouteDependencies = {
    documentClient: h.db, tableName: "State", now: h.now, companies: companyMembershipFromDynamo(h.db, "signin"),
    developer: {
      issuer: ISSUER, env: "staging", methods: { slack: true, oidc: true }, signInTableName: "signin",
      verifyAccessToken: async (authorization) => decodeJwt(/^Bearer (\S+)$/.exec(authorization ?? "")?.[1] ?? ""),
      channelMembers: async (request) => ({ ok: true, memberOf: request.channelIds }),
      companySelfCreate: companySelfCreateThroughLambda(async (payload) => {
        const event = JSON.parse(new TextDecoder().decode(payload)) as never; forwarded.push(event);
        return { Payload: new TextEncoder().encode(JSON.stringify(await h.handler(event))) };
      }),
    },
  };
  const call = async (method: string, path: string, token: string | undefined, body?: unknown): Promise<Answer> => {
    const request = { method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, requestId: "r", ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) };
    try { return { status: 200, body: await routeDeveloperRequest(routes, request, new URL(path, "https://broker.example.test")) as Record<string, unknown> }; }
    catch (error) {
      if (!(error instanceof AgentXError)) throw error;
      return { status: error.statusCode, body: { error: { code: error.code, message: error.message.slice(error.code.length + 2) } } };
    }
  };
  const access = (token: string | undefined) => call("POST", "/v1/dev/access", token, {});
  const create = (token: string | undefined, body: unknown) => call("POST", "/v1/dev/company", token, body);
  const codes = () => h.db.find((row) => row.pk === INVITE_CODES_PK);
  const companies = () => h.db.find((row) => row.entityType === "COMPANY");
  return { ...h, company, invites, routes, operator, code, signIn, refresh, call, access, create, codes, companies, forwarded };
}

describe("a sign-in with no company (DEC 253z)", () => {
  it("a new person with no invitation signs in to the web app with no company; the session, record and email index say so", async () => {
    const w = world();
    const signed = await w.signIn("new");
    expect(signed.access).toBeDefined();
    const id = person("new");
    expect(w.db.find((row) => row.entityType === "SESSION" && row.developerId === id)).toEqual([expect.not.objectContaining({ companyId: expect.anything() as unknown })]);
    expect(w.db.get(`DEVELOPER#${id}`, "META")).toMatchObject({ companyless: true, revoked: false });
    expect(w.db.get(membershipKey(id).pk, membershipKey(id).sk)).toBeUndefined();
    // Its email goes in no company's email index (the built-in company's included).
    expect(w.db.find((row) => row.entityType === "DEVELOPER_EMAIL")).toEqual([]);
    // The access check: who they are, no company, no projects.
    const answer = await w.access(signed.access);
    expect(answer).toEqual({ status: 200, body: { developerId: id, displayName: "new person", nameChosen: false, administrator: false, projects: [], notices: [] } });
  });

  it("only the web app: the CLI, an install-level client without the web app mark, and Slack still refuse a person with no invitation", async () => {
    expect((await world().signIn("new", "agentx-cli")).refused).toBe("not invited");
    expect((await world({ webApp: false }).signIn("new")).refused).toBe("not invited");
    const w = world();
    expect(w.db.find((row) => row.entityType === "DEVELOPER")).toEqual([]);
  });

  it("a record written by a no-company sign-in is never legacy: a later CLI sign-in does not join the built-in company", async () => {
    const w = world();
    await w.signIn("new");
    expect((await w.signIn("new", "agentx-cli")).refused).toBe("not invited");
    expect(w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toEqual([]);
  });

  it("a legacy person (a record from before, unmarked) joins the built-in company as before, never no company", async () => {
    const w = world();
    await w.deps.store.upsertDeveloper({ developerId: person("legacy"), provider: "oidc", issuer: OIDC_ISSUER, subject: "legacy", displayName: "Legacy" });
    const signed = await w.signIn("legacy");
    expect((await w.access(signed.access)).body).toMatchObject({ companyId: IMPLICIT_COMPANY_ID, companyRole: "member" });
    expect(w.db.get(`DEVELOPER#${person("legacy")}`, "META")).not.toHaveProperty("companyless");
  });

  it("a session with no company is never an install administrator", async () => {
    const w = world({ administrator: true });
    const signed = await w.signIn("new");
    expect(w.db.find((row) => row.entityType === "SESSION")).toEqual([expect.not.objectContaining({ administrator: true })]);
    expect((await w.access(signed.access)).body.administrator).toBe(false);
    // Even a stored session that says administrator answers false while it has no company.
    const session = w.db.find((row) => row.entityType === "SESSION")[0]!;
    w.db.set({ ...session, administrator: true });
    expect((await w.access(signed.access)).body.administrator).toBe(false);
  });

  it("every company route refuses the session with no company; only the access check and company create read it", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    expect((await w.access(token)).status).toBe(200);
    const probes = [...COMPANY_CHECKED_ROUTES.filter((route) => route !== "POST /v1/dev/access" && !route.includes("/v1/admin/")), "PUT /v1/dev/me/name", "GET /v1/dev/workspaces", "GET /v1/dev/channel-links"];
    for (const probe of probes) {
      const [method, template] = probe.split(" ") as [string, string];
      const path = template.replace("{taskId}", TASK).replace("{id}", method === "GET" && template.includes("/members/") ? "f".repeat(64) : template.includes("/members/") ? "f".repeat(64) : "shared-project");
      const answer = await w.call(method, path, token, method === "GET" || method === "DELETE" ? undefined : { name: "x" });
      expect([401, 404], probe).toContain(answer.status);
    }
    // The routes that reach authentication refuse it as a sign-in that ended.
    for (const [method, path] of [["GET", "/v1/dev/projects"], ["GET", "/v1/dev/tasks"], ["PUT", "/v1/dev/me/name"], ["POST", "/v1/dev/company/preapprovals"], ["GET", "/v1/dev/workspaces"]] as const) {
      expect((await w.call(method, path, token, method === "GET" ? undefined : { name: "New Name" })).status, path).toBe(401);
    }
  });

  it("a removed member stays refused (401) at sign-in and at the access check, never 'no company'", async () => {
    const w = world();
    const { access: first } = await w.signIn("new");
    const made = await w.code();
    expect((await w.create(first, { name: "Acme", inviteCode: made.code })).status).toBe(200);
    w.db.set({ ...w.db.get(membershipKey(person("new")).pk, "COMPANY")!, revokedAt: new Date(w.now()).toISOString(), revokedBy: "operator" });
    expect((await w.signIn("new")).refused).toBe("access ended by a company admin");
    expect((await w.access(first)).status).toBe(401);
  });

  it("refresh rechecks: it works while the person has no company, and ends the session once they have one", async () => {
    const w = world();
    const signed = await w.signIn("new");
    const rotated = await w.refresh(signed.refresh!);
    expect(rotated.status).toBe(200);
    expect((await w.create(signed.access, { name: "Acme", inviteCode: (await w.code()).code })).status).toBe(200);
    expect((await w.refresh(rotated.body.refresh_token as string)).status).toBe(400);
    expect(w.db.find((row) => row.entityType === "SESSION")).toEqual([expect.objectContaining({ revokedReason: "company_changed" })]);
  });
});

describe("POST /v1/dev/company (DEC 253z, 254a)", () => {
  it("makes the company, the owner membership and its mirror, the logs, and spends the code, in one transaction", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    const made = await w.code();
    const answer = await w.create(token, { name: "  Acme Robotics  ", inviteCode: made.code });
    expect(answer).toEqual({ status: 200, body: { companyId: X, companyName: "Acme Robotics", companyRole: "owner" } });
    const id = person("new");
    expect(w.db.get(companyKey(X).pk, "META")).toMatchObject({ entityType: "COMPANY", companyId: X, name: "Acme Robotics", createdBy: "self-serve", selfServedBy: id });
    expect(w.db.get(membershipKey(id).pk, "COMPANY")).toMatchObject({ companyId: X, role: "owner", joinedVia: "self-serve" });
    expect(w.db.get(companyMemberKey(X, id).pk, companyMemberKey(X, id).sk)).toMatchObject({ entityType: "COMPANY_MEMBER_VIEW", role: "owner" });
    expect(w.db.find((row) => row.pk === companyScoped(X, "COMPANY_LOG"))).toEqual([expect.objectContaining({ event: "company-self-create", personId: id })]);
    expect(w.db.find((row) => row.pk === INVITE_LOG_PK).map((row) => row.event)).toEqual(["company-invite-create", "company-invite-use"]);
    expect(w.codes()).toEqual([expect.objectContaining({ status: "used", usedBy: id, companyId: X })]);
    // The code is never stored or logged, and the broker forwards only its hash.
    expect(JSON.stringify(w.db.find(() => true))).not.toContain(made.code);
    expect(JSON.stringify(w.logs)).not.toContain(made.code);
    expect(w.forwarded).toEqual([{ kind: "company-self-create", personId: id, name: "Acme Robotics", codeHash: made.codeHash }]);
  });

  it("after create the old session has no company and must sign in again; a session bound to the new company answers it", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    await w.create(token, { name: "Acme", inviteCode: (await w.code()).code });
    expect((await w.access(token)).status).toBe(401);
    // What a new sign-in bound to the new company holds (a later lane mints it with the shared sign-in method).
    const id = person("new");
    const old = w.db.find((row) => row.entityType === "SESSION")[0]!;
    w.db.set({ ...old, pk: `SESSION#${NEW_SESSION}`, sessionId: NEW_SESSION, companyId: X, startedAt: new Date(w.now()).toISOString() });
    w.db.set({ pk: companyScoped(X, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", issuer: OIDC_ISSUER, clientId: "shared", displayName: "Google", requiredValues: [], enabled: true, enabledSince: w.now() / 1000 - 60 });
    const claims = decodeJwt(token!);
    const forged = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, sid: NEW_SESSION })).toString("base64url")}.sig`;
    expect((await w.access(forged)).body).toMatchObject({ developerId: id, companyId: X, companyRole: "owner", companyName: "Acme" });
  });

  it.each(["unknown", "used", "revoked", "expired", "not-text", "too-long", "missing", "empty", "closed"])("every code problem and a closed switch get one answer, with the same reads: %s", async (cause) => {
    const w = world();
    const { access: token } = await w.signIn("new");
    const valid = await w.code(1);
    const baseline = async () => {
      const start = w.db.commandNames().length;
      const answer = await w.create(token, { name: "Acme", inviteCode: newCompanyInviteCode().code });
      return { answer, commands: w.db.commandNames().slice(start) };
    };
    const expected = await baseline();
    expect(expected.answer).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: COMPANY_SELF_CREATE_TEXT.refused } } });
    const row = w.codes()[0]!;
    if (cause === "used") w.db.set({ ...row, status: "used" });
    if (cause === "revoked") w.db.set({ ...row, status: "revoked" });
    if (cause === "expired") w.tick(3600_000);
    if (cause === "closed") await w.operator({ kind: "company-self-serve-set", open: false });
    const inviteCode = { unknown: newCompanyInviteCode().code, "not-text": 12345, "too-long": `${valid.code}${"x".repeat(128)}`, missing: undefined, empty: "" }[cause as "unknown"] ?? valid.code;
    const start = w.db.commandNames().length;
    const answer = await w.create(token, { name: "Acme", ...(cause === "missing" ? {} : { inviteCode }) });
    expect(answer).toEqual(expected.answer);
    expect(w.db.commandNames().slice(start)).toEqual(expected.commands);
    expect(JSON.stringify(answer)).not.toContain(valid.code.slice(6, 20));
    expect(w.companies()).toEqual([]);
    expect(w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toEqual([]);
  });

  it("a person already in a company gets 409 and the code stays live; a bad name is 400 and counts nothing", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    await w.create(token, { name: "Acme", inviteCode: (await w.code()).code });
    const second = await w.code();
    // The person now holds a session bound to their company (a new sign-in).
    const old = w.db.find((row) => row.entityType === "SESSION")[0]!;
    w.db.set({ ...old, pk: `SESSION#${NEW_SESSION}`, sessionId: NEW_SESSION, companyId: X, startedAt: new Date(w.now()).toISOString() });
    w.db.set({ pk: companyScoped(X, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", issuer: OIDC_ISSUER, clientId: "shared", displayName: "Google", requiredValues: [], enabled: true, enabledSince: w.now() / 1000 - 60 });
    const claims = decodeJwt(token!);
    const bound = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ ...claims, sid: NEW_SESSION })).toString("base64url")}.sig`;
    expect(await w.create(bound, { name: "Beta", inviteCode: second.code })).toEqual({ status: 409, body: { error: { code: "ALREADY_IN_ORG", message: COMPANY_SELF_CREATE_TEXT.alreadyMember } } });
    expect(w.codes().find((row) => row.sk === `CODE#${second.codeHash}`)).toMatchObject({ status: "live" });
    expect(w.companies()).toHaveLength(1);
    const before = w.forwarded.length;
    for (const body of [{ name: "", inviteCode: second.code }, { name: "x".repeat(81), inviteCode: second.code }, { inviteCode: second.code }, { name: "Beta", inviteCode: second.code, companyId: Y }, "not json"]) {
      expect((await w.create(bound, body)).status).toBe(400);
    }
    expect(w.forwarded.length).toBe(before);
  });

  it(`counts tries before the code is read: the ${SELF_CREATE_TRIES_PER_HOUR + 1}th try in an hour is 429 even with a good code`, async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    for (let i = 0; i < SELF_CREATE_TRIES_PER_HOUR; i++) expect((await w.create(token, { name: "Acme", inviteCode: newCompanyInviteCode().code })).status).toBe(403);
    const good = await w.code(48);
    expect(await w.create(token, { name: "Acme", inviteCode: good.code })).toEqual({ status: 429, body: { error: { code: "TOO_MANY_REQUESTS", message: COMPANY_SELF_CREATE_TEXT.rateLimited } } });
    expect(w.codes().find((row) => row.sk === `CODE#${good.codeHash}`)).toMatchObject({ status: "live" });
    expect(w.db.find((row) => row.entityType === "COMPANY_SELF_CREATE_RATE")).toEqual([expect.objectContaining({ count: SELF_CREATE_TRIES_PER_HOUR, expiresAt: expect.any(Number) as unknown })]);
    // Another person is not limited by this one's tries; the next hour this person may try again.
    w.tick(3600_000);
    const fresh = await w.signIn("new");
    expect((await w.create(fresh.access, { name: "Acme", inviteCode: good.code })).status).toBe(200);
  });

  it("two people racing one code: exactly one company; the loser gets the uniform refusal and stays without a company", async () => {
    const w = world();
    const [a, b] = [await w.signIn("new"), await w.signIn("second")];
    const made = await w.code();
    const answers = await Promise.all([w.create(a.access, { name: "A", inviteCode: made.code }), w.create(b.access, { name: "B", inviteCode: made.code })]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 403]);
    expect(w.companies()).toHaveLength(1);
    expect(w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toHaveLength(1);
    expect(w.codes()).toEqual([expect.objectContaining({ status: "used" })]);
  });

  it("one person racing two codes: exactly one company, and the other code stays live", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    const [one, two] = [await w.code(), await w.code()];
    const answers = await Promise.all([w.create(token, { name: "A", inviteCode: one.code }), w.create(token, { name: "B", inviteCode: two.code })]);
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(1);
    expect(answers.filter((answer) => answer.status !== 200).map((answer) => answer.status)).toEqual([expect.toBeOneOf([401, 403, 409])]);
    expect(w.companies()).toHaveLength(1);
    expect(w.codes().map((row) => row.status).sort()).toEqual(["live", "used"]);
  });

  it("a used code cannot touch the company it made, or make another", async () => {
    const w = world();
    const [a, b] = [await w.signIn("new"), await w.signIn("second")];
    const made = await w.code();
    expect((await w.create(a.access, { name: "Alpha", inviteCode: made.code })).status).toBe(200);
    const companyBefore = JSON.stringify(w.db.find((row) => String(row.pk).startsWith(`ORG#${X}`)));
    expect((await w.create(b.access, { name: "Alpha", inviteCode: made.code })).status).toBe(403);
    expect(JSON.stringify(w.db.find((row) => String(row.pk).startsWith(`ORG#${X}`)))).toBe(companyBefore);
    expect(w.db.get(membershipKey(person("second")).pk, "COMPANY")).toBeUndefined();
    // With a code of their own, the second person gets their own company, never the first one's.
    expect((await w.create(b.access, { name: "Beta", inviteCode: (await w.code()).code })).body).toEqual({ companyId: Y, companyName: "Beta", companyRole: "owner" });
    expect(w.db.get(membershipKey(person("second")).pk, "COMPANY")).toMatchObject({ companyId: Y });
    expect(w.db.find((row) => row.entityType === "COMPANY_MEMBER_VIEW" && row.companyId === X)).toHaveLength(1);
  });

  it("only from the web app: a full-access client without the mark and the CLI are refused, and nothing is forwarded", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    w.db.set({ ...w.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!, webApp: undefined });
    expect((await w.create(token, { name: "Acme", inviteCode: (await w.code()).code })).status).toBe(401);
    expect(w.forwarded).toEqual([]);
  });

  it("is unknown where the company layer is off, or the forward is not wired", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    const { companies: _c, ...off } = w.routes; void _c;
    const request = { method: "POST", path: "/v1/dev/company", headers: { authorization: `Bearer ${token}` }, requestId: "r", body: JSON.stringify({ name: "Acme", inviteCode: "x" }) };
    await expect(routeDeveloperRequest(off, request, new URL("/v1/dev/company", "https://b.example.test"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { companySelfCreate: _s, ...developer } = w.routes.developer; void _s;
    await expect(routeDeveloperRequest({ ...w.routes, developer }, request, new URL("/v1/dev/company", "https://b.example.test"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await w.call("GET", "/v1/dev/company", token)).status).toBe(404);
  });

  it("each mark on a live no-company session is checked at every call", async () => {
    const w = world();
    const signed = await w.signIn("new");
    const id = person("new");
    const session = w.db.find((row) => row.entityType === "SESSION")[0]!;
    const developer = w.db.get(`DEVELOPER#${id}`, "META")!;
    const client = w.db.get("SIGNIN_CLIENTS", "CLIENT#web-app")!;
    expect((await w.access(signed.access)).status).toBe(200);
    const damages: Array<() => void> = [
      () => w.db.set({ ...client, installLevel: undefined }), () => w.db.set({ ...client, webApp: undefined }),
      () => w.db.set({ ...client, fullAccess: undefined, webApp: undefined }),
      () => w.db.set({ ...session, companyId: IMPLICIT_COMPANY_ID }), () => w.db.set({ ...developer, companyless: undefined }),
      () => w.db.set({ ...developer, revoked: true }),
      () => w.db.set({ ...membershipKey(id), entityType: "OTHER" }),
    ];
    for (const damage of damages) {
      damage();
      expect((await w.access(signed.access)).status).toBe(401);
      w.db.set(client); w.db.set(session); w.db.set(developer); w.db.delete(membershipKey(id).pk, membershipKey(id).sk);
      expect((await w.access(signed.access)).status).toBe(200);
    }
    // A slack-method session with no company is never one.
    w.db.set({ ...session, amr: "slack" });
    expect((await w.access(signed.access)).status).toBe(401);
  });

  it("the switch and the code's conditions are checked again inside the transaction (closed or expired between read and write)", async () => {
    for (const race of ["closed", "expired", "replaced"] as const) {
      const w = world();
      const { access: token } = await w.signIn("new");
      const made = await w.code(1);
      const send = w.db.send.bind(w.db);
      vi.spyOn(w.db, "send").mockImplementation(async (command) => {
        if (command instanceof TransactWriteCommand && command.input.TransactItems?.length === 7) {
          if (race === "closed") await w.invites.setSelfServe(false);
          const row = w.codes()[0]!;
          if (race === "expired") w.db.set({ ...row, expiresAt: Math.floor(w.now() / 1000) });
          if (race === "replaced") w.db.set({ ...row, createdAt: new Date(w.now() + 1).toISOString() });
        }
        return send(command);
      });
      expect((await w.create(token, { name: "Acme", inviteCode: made.code })).status, race).toBe(403);
      expect(w.companies()).toEqual([]);
      expect(w.db.find((row) => row.entityType === "COMPANY_MEMBERSHIP")).toEqual([]);
    }
  });

  it("a write conflict is 'try again' (503), never the code refusal, and the code stays live", async () => {
    const w = world();
    const { access: token } = await w.signIn("new");
    const made = await w.code();
    const send = w.db.send.bind(w.db);
    vi.spyOn(w.db, "send").mockImplementation(async (command) => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.length === 7) {
        throw Object.assign(new Error("conflict"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "TransactionConflict" }, { Code: "None" }] });
      }
      return send(command);
    });
    expect((await w.create(token, { name: "Acme", inviteCode: made.code })).status).toBe(503);
    expect(w.codes()[0]).toMatchObject({ status: "live" });
  });

  it.each(["Rovara\u202eSupport", "Acme\u0000", "Acme\u200b", "Ae\u0301"])("refuses a company name with control or formatting characters, or not NFC (%s)", async (raw) => {
    const w = world();
    const { access: token } = await w.signIn("new");
    const name = raw;
    expect((await w.create(token, { name, inviteCode: (await w.code()).code })).status).toBe(400);
    expect(await w.operator({ kind: "company-self-create", personId: person("new"), name, codeHash: newCompanyInviteCode().codeHash })).toEqual({ ok: false, error: "invalid_request" });
    expect(w.forwarded).toEqual([]);
  });

  it("a CLI token is refused in fixed words before anything is forwarded, even for a signed-in member", async () => {
    const w = world();
    await w.deps.store.upsertDeveloper({ developerId: person("legacy"), provider: "oidc", issuer: OIDC_ISSUER, subject: "legacy", displayName: "Legacy" });
    const cli = await w.signIn("legacy", "agentx-cli");
    expect(cli.access).toBeDefined();
    const answer = await w.create(cli.access, { name: "Acme", inviteCode: (await w.code()).code });
    expect(answer).toEqual({ status: 403, body: { error: { code: "FORBIDDEN", message: "creating a company is done in the Rovara web app" } } });
    expect(w.forwarded).toEqual([]);
  });

  it("the Lambda refuses a create event it did not get from the broker's shape", async () => {
    const w = world();
    const made = await w.code();
    for (const event of [{ kind: "company-self-create", personId: person("new"), name: "Acme", codeHash: made.code }, { kind: "company-self-create", personId: "x", name: "Acme", codeHash: made.codeHash }, { kind: "company-self-create", personId: person("new"), name: "Acme", codeHash: made.codeHash, companyId: Y }]) {
      expect(await w.operator(event)).toEqual({ ok: false, error: "invalid_request" });
    }
    expect(w.companies()).toEqual([]);
  });

  it("a stored company from before (created by an operator) still reads; a self-serve record must name its owner", async () => {
    const { CompanyRecord } = await import("../../packages/broker/src/developer/company-membership.js");
    const at = "2026-11-01T00:00:00.000Z";
    expect(CompanyRecord.safeParse({ entityType: "COMPANY", companyId: X, name: "Old", status: "active", createdAt: at, createdBy: "operator" }).success).toBe(true);
    expect(CompanyRecord.safeParse({ entityType: "COMPANY", companyId: X, name: "New", status: "active", createdAt: at, createdBy: "self-serve" }).success).toBe(false);
    expect(CompanyRecord.safeParse({ entityType: "COMPANY", companyId: X, name: "New", status: "active", createdAt: at, createdBy: "operator", selfServedBy: person("new") }).success).toBe(false);
  });
});
