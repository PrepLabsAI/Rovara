// REVIEW-1's three successful exploit probes, inverted into regressions.
import { expect, it, vi } from "vitest";
import { IMPLICIT_COMPANY_ID, companyScoped } from "@agentx/contracts";
import { signinCompanyWorld } from "../support/signin-company-world.js";
import { authorizeQuery, httpEvent, identityHarness, OIDC_ISSUER, CLI_REDIRECT, CHALLENGE } from "../support/developer-fakes.js";
import { CompanySignInStore } from "../../packages/broker/src/developer/company-membership.js";
import { companyIssuerProvider } from "../../packages/broker/src/developer/company-issuer.js";

const issuerSettings = { issuer: OIDC_ISSUER, clientId: "company-client", displayName: "Implicit second issuer", requiredValues: [], enabled: true };
const issuerEvent = { kind: "company-issuer-set", companyId: IMPLICIT_COMPANY_ID, ...issuerSettings };
function stray(h: ReturnType<typeof identityHarness>) {
  h.db.set({ pk: companyScoped(IMPLICIT_COMPANY_ID, "SIGNIN_ISSUER"), sk: "OIDC", entityType: "COMPANY_SIGNIN_ISSUER", ...issuerSettings, enabledSince: 0 });
}
async function implicit() {
  const h = identityHarness({ oidc: {}, oidcUsers: [{ sub: "person", email: "shared@example.test", email_verified: true }] });
  const company = new CompanySignInStore({ documentClient: h.db, tableName: "signin", now: h.now });
  h.deps.company = company;
  h.deps.companyIssuer = companyIssuerProvider({ store: company, env: "test", now: h.now, fetch: h.fetch, jwksFor: () => h.oidc.jwks, readSecret: async () => "unused" });
  await company.preapprove(IMPLICIT_COMPANY_ID, "shared@example.test", "member", 24);
  stray(h);
  const first = await h.signIn("oidc", "person");
  const code = first.searchParams.get("code")!;
  expect(code).toBeTypeOf("string");
  // Model a historical explicit implicit-company record; membership remains real.
  const row = h.db.find((row) => row.entityType === "AUTH_CODE")[0]!;
  h.db.set({ ...row, companyId: IMPLICIT_COMPANY_ID });
  return { ...h, code };
}

it("PROBE inverted: operator and store refuse an implicit company issuer without writes", async () => {
  const h = signinCompanyWorld();
  expect(await h.company.companyExists(IMPLICIT_COMPANY_ID)).toBe(true);
  await expect(h.company.setIssuer(IMPLICIT_COMPANY_ID, issuerSettings)).rejects.toThrow("company sign-in unavailable");
  expect(await h.operator(issuerEvent)).toEqual({ ok: false, error: "invalid_request" });
  expect(await h.handler(issuerEvent as never)).toEqual({ ok: false, error: "invalid_request" });
  expect(h.db.items.size).toBe(0); expect(h.logs).toEqual([]);
});

it("PROBE inverted: stray implicit issuer cannot select, mint or refresh with install OIDC off", async () => {
  const h = await implicit();
  // Existing sessions can carry the explicit implicit id too.
  const signed = await h.exchange(h.code); expect(signed.status).toBe(200);
  const second = await h.signIn("oidc", "person");
  const row = h.db.find((row) => row.entityType === "AUTH_CODE")[0]!;
  h.db.set({ ...row, companyId: IMPLICIT_COMPANY_ID });
  delete h.deps.config.oidc; delete h.deps.providers.oidc;
  const expected = await h.http(httpEvent("GET", "/v1/auth/authorize?request=none&method=unknown"));
  expect(await h.http(httpEvent("GET", authorizeQuery({ company: IMPLICIT_COMPANY_ID })))).toEqual(expected);
  expect((await h.exchange(second.searchParams.get("code")!)).status).toBe(400);
  expect((await h.refresh(signed.body.refresh_token as string)).status).toBe(400);
});

it("PROBE inverted: implicit refresh obeys install since despite a looser stray issuer", async () => {
  const h = await implicit();
  const signed = await h.exchange(h.code); expect(signed.status).toBe(200);
  h.deps.config.oidc!.since = h.now() / 1000 + 10;
  expect(await h.refresh(signed.body.refresh_token as string)).toEqual({ status: 400, body: {
    error: "invalid_grant", error_description: "your sign-in ended when Okta was turned off; sign in again",
  } });
});

it("implicit issuer selection never reads a stray record or secret", async () => {
  const h = signinCompanyWorld(); stray(h);
  const read = vi.spyOn(h.company, "read");
  expect(await h.deps.companyIssuer!(IMPLICIT_COMPANY_ID)).toBeUndefined();
  expect(read).not.toHaveBeenCalled(); expect(h.secretReads).toEqual([]);
});

it("the server refuses an implicit selector even with an injected permissive issuer resolver", async () => {
  const h = await implicit();
  const select = vi.fn(async () => ({ provider: h.deps.providers.oidc!, issuer: OIDC_ISSUER, since: 0 }));
  h.deps.companyIssuer = select;
  const expected = await h.http(httpEvent("GET", "/v1/auth/authorize?request=none&method=unknown"));
  expect(await h.http(httpEvent("GET", authorizeQuery({ company: IMPLICIT_COMPANY_ID })))).toEqual(expected);
  expect(select).not.toHaveBeenCalled();
});


it("a pending implicit callback cannot use an injected company issuer", async () => {
  const h = await implicit();
  const select = vi.fn(async () => ({ provider: h.deps.providers.oidc!, issuer: OIDC_ISSUER, since: 0 }));
  h.deps.companyIssuer = select;
  const request = await h.deps.store.createAuthRequest({ clientRedirectUri: CLI_REDIRECT, clientState: "state", codeChallenge: CHALLENGE, nonce: "nonce", companyId: IMPLICIT_COMPANY_ID });
  await h.deps.store.chooseMethod(request.id, "oidc");
  const before = h.db.find((row) => row.entityType === "AUTH_CODE");
  const result = await h.http(httpEvent("GET", `/v1/auth/callback/oidc?state=${request.id}&code=unused`));
  expect(new URL(result.headers.location!).searchParams.get("error_description")).toBe("sign-in is not finished");
  expect(select).not.toHaveBeenCalled();
  expect(h.db.find((row) => row.entityType === "AUTH_CODE")).toEqual(before);
});

it("implicit mint and refresh never consult even a permissive injected company issuer", async () => {
  const h = await implicit();
  const select = vi.fn(async () => ({ provider: h.deps.providers.oidc!, issuer: OIDC_ISSUER, since: 0 }));
  h.deps.companyIssuer = select;
  const signed = await h.exchange(h.code); expect(signed.status).toBe(200);
  expect((await h.refresh(signed.body.refresh_token as string)).status).toBe(200);
  expect(select).not.toHaveBeenCalled();
});
