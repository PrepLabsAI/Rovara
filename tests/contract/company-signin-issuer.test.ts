import { expect, it, vi } from "vitest";
import { companyScoped } from "@agentx/contracts";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyIssuerProvider, companyIssuerSecretName } from "../../packages/broker/src/developer/company-issuer.js";
import { fakeOidc, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, routeFetch, T0 } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { COMPANY_A, COMPANY_B } from "../../packages/testing/src/isolation/two-company.js";
import { httpEvent, identityHarness } from "../support/developer-fakes.js";
import { ProviderNotConfiguredError } from "../../packages/broker/src/developer/providers.js";
import { remoteJwksCache } from "../../packages/broker/src/aws/developer-identity.js";

const companyId = "org_" + "b".repeat(20);
function world() {
  const db = new FakeDynamoDb();
  const store = new CompanySignInStore({ documentClient: db, tableName: "signin", now: () => T0 });
  const oidc = fakeOidc({ users: [{ sub: "person", email: "person@example.test", email_verified: true, groups: ["admin"] }], now: () => T0 });
  const secrets: string[] = [];
  const build = companyIssuerProvider({ store, env: "test", readSecret: async (name) => { secrets.push(name); return OIDC_CLIENT_SECRET; }, fetch: routeFetch(oidc.handler), jwksFor: () => oidc.jwks, now: () => T0 });
  const record = { pk: companyScoped(companyId, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, displayName: "Company sign-in", requiredValues: [], enabled: true, enabledSince: T0 / 1000 };
  db.set(record);
  return { db, build, record, secrets, oidc };
}

it("derives the company's secret and never maps its admin claim", async () => {
  const h = world();
  const selected = (await h.build(companyId))!;
  const redirectUri = "https://signin.example.test/v1/auth/callback/oidc";
  const target = await selected.provider.authorizeUrl({ state: "state", nonce: "nonce", redirectUri });
  const callback = new URL(h.oidc.approve(target, "person"));
  const result = await selected.provider.complete({ code: callback.searchParams.get("code")!, nonce: "nonce", redirectUri });
  expect(result).toMatchObject({ ok: true, identity: { issuer: OIDC_ISSUER, email: "person@example.test" } });
  expect(result.ok && result.identity.administrator).not.toBe(true);
  expect(h.secrets).toEqual([`agentx/test/org-signin/${companyId}/oidc`]);
  expect(companyIssuerSecretName("test", companyId)).toBe(h.secrets[0]);
});

it.each([ { issuer: "not-a-url" }, { requiredValues: ["staff"] }])("refuses disabled or unreadable issuer %s without reading a secret", async (damage) => {
  const h = world(); h.db.set({ ...h.record, ...damage });
  expect(await h.build(companyId)).toBeUndefined(); expect(h.secrets).toEqual([]);
});

it("unknown and disabled selectors equal the unknown-method page byte for byte", async () => {
  const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
  const expected = await h.http(httpEvent("GET", "/v1/auth/authorize?request=none&method=unknown"));
  const disabled = h.db.get(companyScoped(COMPANY_A.orgId, "SIGNIN_ISSUER"), "OIDC")!;
  h.db.set({ ...disabled, enabled: false });
  expect(await h.signInCompany(COMPANY_A.orgId)).toEqual(expected);
  expect(await h.signInCompany(COMPANY_B.orgId)).toEqual(expected);
});

it("issuer off ends the session at refresh", async () => {
  const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId);
  const first = await h.signInCompany(COMPANY_A.orgId);
  const signed = await h.exchange(new URL(first.headers.location!).searchParams.get("code")!);
  expect(signed.status).toBe(200);
  const row = h.db.get(companyScoped(COMPANY_A.orgId, "SIGNIN_ISSUER"), "OIDC")!;
  h.db.set({ ...row, enabled: false });
  expect((await h.refresh(signed.body.refresh_token as string)).status).toBe(400);
});

it("a legacy implicit-company client refuses a selector naming another company", async () => {
  const h = signinCompanyWorld(); await h.create(COMPANY_B.orgId);
  await h.deps.store.putClient({ clientId: "legacy-web", name: "Legacy", audience: "legacy-web", redirectUris: [], loopback: true, createdAt: new Date(h.now()).toISOString(), updatedAt: new Date(h.now()).toISOString(), updatedBy: "operator" });
  const expected = await h.http(httpEvent("GET", "/v1/auth/authorize?request=none&method=unknown"));
  expect(await h.signInCompany(COMPANY_B.orgId, "person", "shared@example.test", { client_id: "legacy-web" })).toEqual(expected);
});

it.each(["secretDown", "discoveryDown"] as const)("a company %s failure gives fixed words and leaves another company and Slack usable", async (failure) => {
  const h = signinCompanyWorld(); await h.create(COMPANY_A.orgId); h[failure]();
  const answer = await h.signInCompany(COMPANY_A.orgId);
  expect(JSON.stringify(answer)).not.toMatch(/secret-read-canary|discovery-read-canary|org-signin/);
  expect(JSON.stringify(h.logs)).not.toMatch(/secret-read-canary|discovery-read-canary|org-signin/);
  expect(new URL(answer.headers.location!).searchParams.get("error_description")).toBe("sign-in is not finished");
  expect(h.db.find((row) => ["DEVELOPER", "DEVELOPER_EMAIL", "AUTH_CODE", "SESSION"].includes(row.entityType as string))).toEqual([]);
  await h.create(COMPANY_B.orgId);
  const other = await h.signInCompany(COMPANY_B.orgId);
  expect((await h.exchange(new URL(other.headers.location!).searchParams.get("code")!)).status).toBe(200);
  await h.operator({ kind: "company-preapprove", companyId: "org_00000000000000000000", email: "shared@example.test", role: "member", expiresInHours: 24 });
  const slack = await h.signIn("slack", "U0SHARED");
  expect((await h.exchange(slack.searchParams.get("code")!)).status).toBe(200);
});

it("company JWKS caching is bounded as issuers change", () => {
  let made = 0;
  const cache = remoteJwksCache(() => { made++; return async () => { throw new Error("unused test key"); }; }, 50);
  const first = cache("https://first.example.test/jwks");
  expect(cache("https://first.example.test/jwks")).toBe(first);
  for (let i = 0; i < 50; i++) cache(`https://issuer-${i}.example.test/jwks`);
  expect(cache("https://first.example.test/jwks")).not.toBe(first);
  expect(made).toBe(52);
});

it("the provider cache holds at most fifty companies and rereads settings", async () => {
  const h = world();
  const first = await h.build(companyId);
  expect(await h.build(companyId)).toBe(first);
  for (let i = 1; i <= 50; i++) {
    const id = `org_${i.toString(36).padStart(20, "0")}`;
    h.db.set({ ...h.record, pk: companyScoped(id, "SIGNIN_ISSUER") });
    expect(await h.build(id)).toBeDefined();
  }
  expect(await h.build(companyId)).not.toBe(first);
  h.db.set({ ...h.record, enabled: false });
  expect(await h.build(companyId)).toBeUndefined();
});






it.each([false])("implicit browser callback error bytes stay golden with company mode %s", async (companyMode) => {
  const h = identityHarness({ slackUsers: [{ userId: "UFAIL", name: "Person", email: "person@example.test" }] });
  if (companyMode) {
    h.deps.company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
    await h.deps.company.preapprove("org_00000000000000000000", "person@example.test", "member", 24);
  }
  const error = new Error("secret-email-canary@example.test"); error.name = "secret-name-canary";
  vi.spyOn(h.deps.store, "upsertDeveloper").mockRejectedValue(error);
  const target = "/review/11111111-1111-4111-8111-111111111111";
  const start = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(target)}`));
  const event = httpEvent("GET", h.slack.approve(start.headers.location!, "UFAIL"));
  event.headers = { cookie: start.cookies![0]!.split(";", 1)[0] };
  const result = await h.http(event);
  expect(result).toEqual({ statusCode: 302, headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" }, body: "",
    cookies: ["__Host-agentx_review_pkce=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"] });
  if (companyMode) {
    expect(h.logs).toContainEqual({ event: "signin.browser_error", method: "slack", error: "sign_in_failed" });
    expect(JSON.stringify(h.logs)).not.toMatch(/secret-email-canary|secret-name-canary/);
  }
});


it.each([ true])("implicit provider configuration error gives customer guidance with company mode %s", async (companyMode) => {
  const h = identityHarness({ slackUsers: [{ userId: "UFAIL", name: "Person" }] });
  if (companyMode) h.deps.company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  const error = new ProviderNotConfiguredError("the Slack secret has no bot token yet; ask an admin to run agentx signin check");
  error.name = "secret-name-canary";
  vi.spyOn(h.deps.providers.slack!, "complete").mockRejectedValue(error);
  const answer = await h.signIn("slack", "UFAIL");
  expect(answer.search).toBe("?error=access_denied&state=cli-state&error_description=Slack+sign-in+is+not+finished.+Ask+a+Rovara+administrator+to+check+the+sign-in+settings.");
  if (companyMode) {
    expect(h.logs).toContainEqual({ event: "signin.not_configured", method: "slack", detail: "sign_in_not_configured" });
    expect(JSON.stringify(h.logs)).not.toMatch(/secret-name-canary|the Slack secret/);
  }
});
