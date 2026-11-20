import { expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { decodeJwt } from "jose";
import { companyScoped, IMPLICIT_COMPANY_ID } from "@agentx/contracts";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { httpEvent, VERIFIER } from "../support/developer-fakes.js";
import { companyMembershipFromDynamo } from "../../packages/broker/src/aws/company-check.js";
import type { CompanySignInAuditInput } from "../../packages/broker/src/developer/company-signin-audit.js";
import { authenticateDeveloper, authenticateDeveloperSessionId, companyPreapprovalsThroughLambda, routeDeveloperRequest, type DeveloperRouteDependencies } from "../../packages/broker/src/aws/developer-routes.js";
import { developerTokenVerifier } from "../../packages/broker/src/developer/verify-token.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";

const A = COMPANY_A.orgId, B = COMPANY_B.orgId;
const SIGN_IN_AGAIN = "AUTH_REQUIRED: your AgentX sign-in has ended; run agentx login <url> again";
const ACCESS_REFUSED = "AUTH_REQUIRED: this access check needs a signed-in person's token for this service, or a confidential service's own credentials";
const paths = ["cli", "browser", "client"] as const;
type Path = typeof paths[number];
async function world(path: Path = "cli", scoped = false) {
  const h = signinCompanyWorld(); await h.create(A); await h.create(B);
  if (path === "client") await h.deps.store.putClient({ clientId: "company-app", name: "App", audience: "company-app", redirectUris: [], loopback: true, companyId: A, ...(scoped ? { scopes: ["tasks:read" as const] } : {}),
    createdAt: new Date(h.now()).toISOString(), updatedAt: new Date(h.now()).toISOString(), updatedBy: "operator" }, A);
  const signed = await h.signInCompany(A, "person", "shared@example.test", path === "client" ? { client_id: "company-app", ...(scoped ? { scope: "tasks:read" } : {}) } : {});
  const code = new URL(signed.headers.location!).searchParams.get("code")!;
  const issued = path === "client" ? JSON.parse((await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "authorization_code", client_id: "company-app", code, code_verifier: VERIFIER, redirect_uri: "http://127.0.0.1:49152/callback" }))).body) as Record<string, unknown> : (await h.exchange(code)).body;
  expect(issued.access_token).toBeTypeOf("string");
  const token = issued.access_token as string, claims = decodeJwt(token);
  const session = h.db.get(`SESSION#${String(claims.sid)}`, "META")!;
  // Browser entry authenticates a server-stored opaque session, never a token claim.
  if (path === "browser") h.db.set({ ...session, reviewExpiresAt: h.now() / 1000 + 300 });
  const deps: DeveloperRouteDependencies = {
    documentClient: h.db, tableName: "state", now: h.now, companies: companyMembershipFromDynamo(h.db, "signin"),
    developer: { issuer: h.deps.config.issuer, env: h.deps.config.env, methods: { slack: true, oidc: true }, signInTableName: "signin",
      channelMembers: async () => ({ ok: true, memberOf: [] }),
      verifyAccessToken: developerTokenVerifier({ issuer: h.deps.config.issuer, keys: async () => [await h.signer.publicJwk()], now: h.now }),
      companyPreapprovals: companyPreapprovalsThroughLambda(async (payload) => ({ Payload: Buffer.from(JSON.stringify(await h.handler(JSON.parse(Buffer.from(payload).toString()) as never))) })),
    },
  };
  const run = async () => {
    try {
      if (path === "browser") await authenticateDeveloperSessionId(deps, String(claims.sid));
      else {
        const url = path === "cli" ? "/v1/dev/company/preapprovals" : "/v1/dev/access";
        const result = await routeDeveloperRequest(deps, { method: "POST", path: url, requestId: "auth-scope-repro", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(path === "cli" ? { email: "next@example.test", role: "member", expiresInHours: 1 } : {}) }, new URL(url, "https://broker.example.test"));
        expect(result).toBeDefined();
      }
      return { status: 200 };
    } catch (error) { return { status: (error as { statusCode?: number }).statusCode, message: (error as Error).message }; }
  };
  const row = (kind: string) => h.db.find((item) => item.entityType === kind && (kind !== "COMPANY_MEMBERSHIP" || item.personId === claims.sub))[0]!;
  const issuer = () => h.db.get(companyScoped(A, "SIGNIN_ISSUER"), "OIDC")!;
  return { ...h, deps, run, claims, token, session, row, issuer, issued, refused: { status: 401, message: path === "client" ? ACCESS_REFUSED : SIGN_IN_AGAIN } };
}

it.each(paths)("%s control: company issuer member reaches real broker auth", async (path) => { expect(await (await world(path)).run()).toEqual({ status: 200 }); });
it.each(paths.flatMap((path) => ["install-off", "install-cutoff"].map((mode) => ({ path, mode }))))("$path company issuer is independent of $mode", async ({ path, mode }) => {
  const h = await world(path);
  if (mode === "install-off") h.deps.developer.methods.oidc = false;
  else h.deps.developer.since = { oidc: h.now() / 1000 + 1 };
  expect(await h.run()).toEqual({ status: 200 });
});

const damages = ["disabled", "cutoff", "enabled-cutoff", "issuer-missing", "issuer-malformed", "issuer-foreign", "issuer-read", "member-missing", "member-revoked", "member-malformed", "member-moved", "member-read", "session-missing", "session-company-missing", "session-company-malformed", "session-company-foreign", "session-revoked", "session-expired", "session-time-malformed", "session-end-malformed", "session-method", "session-person", "session-read", "developer-missing", "developer-revoked", "developer-revoked-malformed", "developer-provider", "developer-ended", "developer-issuer", "developer-read"] as const;
it.each(paths.flatMap((path) => damages.map((damage) => ({ path, damage }))))("$path refuses $damage with fixed bytes", async ({ path, damage }) => {
  const h = await world(path); expect(await h.run()).toEqual({ status: 200 });
  const member = h.row("COMPANY_MEMBERSHIP"), developer = h.row("DEVELOPER"), session = h.db.get(h.session.pk as string, "META")!, issuer = h.issuer();
  const change = (row: Record<string, unknown>, field: string, value: unknown) => h.db.set({ ...row, [field]: value });
  const remove = (row: Record<string, unknown>) => h.db.delete(row.pk as string, row.sk as string);
  switch (damage) {
    case "disabled": change(issuer, "enabled", false); break;
    case "cutoff": change(issuer, "since", h.now() / 1000 + 1); break;
    case "enabled-cutoff": change(issuer, "enabledSince", h.now() / 1000 + 1); break;
    case "issuer-missing": remove(issuer); break;
    case "issuer-malformed": change(issuer, "enabled", "private-canary"); break;
    case "issuer-foreign": h.db.set({ ...h.db.get(companyScoped(B, "SIGNIN_ISSUER"), "OIDC")!, pk: issuer.pk }); break;
    case "member-missing": remove(member); break;
    case "member-revoked": change(member, "revokedAt", new Date(h.now()).toISOString()); break;
    case "member-malformed": change(member, "companyId", "private-canary"); break;
    case "member-moved": change(member, "companyId", B); break;
    case "session-missing": remove(session); break;
    case "session-company-missing": { const copy = { ...session }; delete copy.companyId; h.db.set(copy); break; }
    case "session-company-malformed": change(session, "companyId", "private-canary"); break;
    case "session-company-foreign": change(session, "companyId", B); break;
    case "session-revoked": change(session, "revokedAt", new Date(h.now()).toISOString()); break;
    case "session-expired": change(session, "endsAt", h.now() / 1000); break;
    case "session-time-malformed": change(session, "startedAt", "private-canary"); break;
    case "session-end-malformed": change(session, "endsAt", "private-canary"); break;
    case "session-method": change(session, "amr", "private-canary"); break;
    case "session-person": change(session, "developerId", "a".repeat(64)); break;
    case "developer-missing": remove(developer); break;
    case "developer-revoked": change(developer, "revoked", true); break;
    case "developer-revoked-malformed": change(developer, "revoked", null); break;
    case "developer-provider": change(developer, "provider", "private-canary"); break;
    case "developer-ended": change(developer, "sessionsEndedAt", new Date(h.now() + 1000).toISOString()); break;
    case "developer-issuer": change(developer, "issuer", "https://private-canary.example.test"); break;
    default: {
      const key = damage === "issuer-read" ? issuer.pk : damage === "member-read" ? member.pk : damage === "session-read" ? session.pk : developer.pk;
      const send = h.db.send.bind(h.db);
      vi.spyOn(h.db, "send").mockImplementation(async (command) => { if (command instanceof GetCommand && command.input.Key?.pk === key) throw new Error("private-canary"); return send(command); });
    }
  }
  const answer = await h.run();
  // Existing admin-ending wording remains on the CLI/browser path.
  expect(answer).toEqual(damage === "developer-ended" && path !== "client" ? { status: 401, message: "AUTH_REQUIRED: an AgentX admin ended your sign-in; run agentx login <url> again" } : h.refused);
  expect(JSON.stringify(answer)).not.toContain("private-canary");
});

it("records a sign-in outcome only for the company resolved from membership", async () => {
  const h = signinCompanyWorld(); await h.create(A);
  const rows: CompanySignInAuditInput[] = [];
  h.deps.signInAudit = async (row) => { rows.push(row); };
  const succeeded = await h.signInCompany(A, "known-person", "shared@example.test");
  expect(succeeded.statusCode).toBe(302);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ companyId: A, method: "cli", outcome: "succeeded" });
  expect(rows[0]).not.toHaveProperty("token");

  const unknown = await h.signInCompany(A, "unknown-person", "unknown@example.test");
  expect(unknown.statusCode).toBe(302);
  expect(rows).toHaveLength(1);
});

it("operator's explicit since cutoff is stored and also enforced on refresh", async () => {
  const h = await world(); const settings = h.issuer();
  for (const field of ["pk", "sk", "entityType", "enabledSince"]) delete settings[field];
  const since = h.now() / 1000 + 1;
  expect(await h.operator({ kind: "company-issuer-set", companyId: A, ...settings, since })).toEqual({ ok: true });
  expect(h.issuer().since).toBe(since);
  expect((await h.refresh(h.issued.refresh_token as string)).status).toBe(400);
  expect(await h.run()).toEqual(h.refused);
});

it.each(paths)("%s accepts the company's exact cutoff boundary and ignores unrelated token company", async (path) => {
  const h = await world(path);
  h.db.set({ ...h.issuer(), since: h.now() / 1000 });
  expect(await h.run()).toEqual({ status: 200 });
});

it.each([ "required-claim"])("runtime-refuses issuer %s with fixed words", async (damage) => {
  const h = await world(); const row = h.issuer();
  const value: Record<string, unknown> = { ...row, ...(damage === "bad-since" ? { since: "private-canary" } : damage === "negative-since" ? { since: -1 } : damage === "bad-enabled-since" ? { enabledSince: "private-canary" } : damage === "required-claim" ? { requiredValues: ["staff"] } : damage === "wrong-kind" ? { entityType: "private-canary" } : {}) };
  if (damage === "missing-enabled") delete value.enabled;
  const send = h.db.send.bind(h.db);
  vi.spyOn(h.db, "send").mockImplementation(async (command) => command instanceof GetCommand && command.input.Key?.pk === row.pk ? { Item: damage === "wrong-key" ? { ...value, pk: companyScoped(B, "SIGNIN_ISSUER") } : value } : send(command));
  expect(await h.run()).toEqual(h.refused);
});


// Frozen ordinary broker outcomes; no runtime git/history reads. The legacy sign-in
// response/item goldens in company-signin-goldens cover the rest of the flow.
it.each([false, true].flatMap((enabled) => paths.flatMap((path) => ["oidc", "slack"].flatMap((amr) => ["on", "off", "cutoff"].map((policy) => ({ enabled, path, amr, policy }))))))("legacy bytes enabled=$enabled $path $amr $policy", async ({ enabled, path, amr, policy }) => {
  const h = await world(path);
  h.db.set({ ...h.row("COMPANY_MEMBERSHIP"), companyId: IMPLICIT_COMPANY_ID });
  const session = h.db.get(h.session.pk as string, "META")!; delete session.companyId;
  h.db.set({ ...session, amr });
  if (path === "client") { const client = h.db.get("SIGNIN_CLIENTS", "CLIENT#company-app")!; delete client.companyId; h.db.set(client); }
  if (!enabled) delete h.deps.companies;
  const method = amr as "slack" | "oidc";
  h.deps.developer.methods[method] = policy !== "off";
  if (policy === "cutoff") h.deps.developer.since = { [method]: h.now() / 1000 + 1 };
  // Signature verification has its own real-token controls above; these golden claims
  // isolate the policy/legacy record boundary for both historical methods.
  h.deps.developer.verifyAccessToken = async () => ({ ...h.claims, amr });
  const answer = async () => {
    try {
      if (path === "cli") await authenticateDeveloper(h.deps, { ...h.claims, amr });
      else if (path === "browser") await authenticateDeveloperSessionId(h.deps, String(h.claims.sid));
      else return h.run();
      return { status: 200 };
    } catch (error) { return { status: (error as { statusCode?: number }).statusCode, message: (error as Error).message }; }
  };
  const expected = policy === "on" || (policy === "off" && path === "browser") ? { status: 200 }
    : { status: 401, message: path === "client" ? ACCESS_REFUSED : policy === "off"
      ? `AUTH_REQUIRED: ${amr === "slack" ? "Slack" : "Company"} sign-in is turned off in this environment; sign in another way with agentx login <url>`
      : `AUTH_REQUIRED: your sign-in ended when ${amr === "slack" ? "Slack" : "company sign-in"} was turned off; sign in again with agentx login <url>` };
  expect(JSON.stringify(await answer())).toBe(JSON.stringify(expected));
});



it.each(paths.flatMap((path) => ["on", "off", "cutoff"].map((policy) => ({ path, policy }))))("$path implicit broker policy ignores every stray issuer ($policy)", async ({ path, policy }) => {
  const h = await world(path);
  h.db.set({ ...h.row("COMPANY_MEMBERSHIP"), companyId: IMPLICIT_COMPANY_ID });
  h.db.set({ ...h.db.get(h.session.pk as string, "META")!, companyId: IMPLICIT_COMPANY_ID });
  if (path === "client") h.db.set({ ...h.db.get("SIGNIN_CLIENTS", "CLIENT#company-app")!, companyId: IMPLICIT_COMPANY_ID });
  h.deps.developer.methods.oidc = policy !== "off";
  if (policy === "cutoff") h.deps.developer.since = { oidc: h.now() / 1000 + 1 };
  const run = async () => {
    if (path !== "cli") return h.run();
    try { await authenticateDeveloper(h.deps, h.claims); return { status: 200 }; }
    catch (error) { return { status: (error as { statusCode: number }).statusCode, message: (error as Error).message }; }
  };
  const baseline = await run();
  expect(baseline.status).toBe(policy === "on" || (path === "browser" && policy === "off") ? 200 : 401);
  for (const settings of [{ enabled: true, since: 0 }, { enabled: false, since: h.now() / 1000 + 100 }, { enabled: "private-canary" }]) {
    h.db.set({ ...h.issuer(), pk: companyScoped(IMPLICIT_COMPANY_ID, "SIGNIN_ISSUER"), ...settings });
    expect(await run()).toEqual(baseline);
  }
});


it("company OIDC policy and named scopes both govern the same registered-client route", async () => {
  const h = await world("client", true);
  h.deps.developer.methods.oidc = false;
  h.deps.developer.since = { oidc: h.now() / 1000 + 1 };
  const request = { method: "GET", path: "/v1/dev/projects", requestId: "company-scope", headers: { authorization: `Bearer ${h.token}` } };
  const run = () => routeDeveloperRequest(h.deps, request, new URL(request.path, "https://broker.example.test"));
  expect(await run()).toBeDefined();
  const client = h.db.get("SIGNIN_CLIENTS", "CLIENT#company-app")!;
  h.db.set({ ...client, scopes: ["tasks:act"] });
  await expect(run()).rejects.toMatchObject({ statusCode: 403, message: "FORBIDDEN: App needs the tasks:read scope for GET /v1/dev/projects; an administrator can allow it with that scope" });
  h.db.set(client);
  const issuer = h.issuer();
  for (const changed of [{ ...issuer, enabled: false }, { ...issuer, since: h.now() / 1000 + 1 }, { ...issuer, issuer: "https://foreign.example.test" }]) {
    h.db.set(changed);
    await expect(run()).rejects.toMatchObject({ statusCode: 401, message: ACCESS_REFUSED });
  }
  h.db.set(issuer);
  expect(await run()).toBeDefined();
});
