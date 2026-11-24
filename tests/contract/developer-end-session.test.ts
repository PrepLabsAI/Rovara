// Cloud sign-out, issue 314: signing out of a registered client (the web app) also ends the browser's sessions behind it, so the next sign-in shows the
// provider's login form instead of signing the same person straight back in. Code's end-session endpoint (OpenID Connect RP-Initiated Logout)
// sends the browser through the company sign-in provider's sign-out (Cognito's /logout) and back to an address the client registered.
import { describe, expect, it } from "vitest";
import { oidcSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, fakeOidc, httpEvent, identityHarness, routeFetch } from "../support/developer-fakes.js";
import type { HttpApiV2Event } from "../../packages/broker/src/aws/lambda.js";

const APP = "https://app.example.test";
const SIGNED_OUT = `${APP}/app/signed-out?reason=ended`;
const RETURN = `${ISSUER}/end-session/return`;
const now = () => Date.now();

function harness(options: { oidc?: boolean; endSession?: string } = {}) {
  const h = identityHarness(options.oidc === false ? {} : { oidc: {} });
  if (options.endSession !== undefined) h.oidc.state.endSession = options.endSession;
  const at = new Date(h.now() - 60_000).toISOString();
  h.db.set({ pk: "SIGNIN_CLIENTS", sk: "CLIENT#web-app", entityType: "SIGN_IN_CLIENT", clientId: "web-app", name: "Web App", audience: "web-app",
    redirectUris: [`${APP}/v1/auth/browser/callback`], loopback: false, secretHash: "f".repeat(64), createdAt: at, updatedAt: at, updatedBy: "admin" });
  return h;
}
const endSession = (query: Record<string, string>) => httpEvent("GET", `/v1/auth/end-session?${new URLSearchParams(query).toString()}`);
const withCookie = (event: HttpApiV2Event, cookie: string): HttpApiV2Event => ({ ...event, cookies: [cookie] });
/** The cookie a response sets, as `name=value`. */
const setCookie = (cookies: string[] | undefined, name: string) => cookies?.find((cookie) => cookie.startsWith(`${name}=`))?.split(";")[0];

describe("the company sign-in provider's sign-out address", () => {
  it("is the discovery document's end_session_endpoint with the client and return address; none without one", async () => {
    const fake = fakeOidc({ users: [] });
    const provider = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [], fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now });
    expect(await provider.endSessionUrl!({ postLogoutRedirectUri: RETURN })).toBeUndefined();

    const withLogout = fakeOidc({ users: [] });
    withLogout.state.endSession = `${OIDC_ISSUER}/logout`;
    const standard = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [], fetch: routeFetch(withLogout.handler), jwksFor: () => withLogout.jwks, now });
    const url = new URL((await standard.endSessionUrl!({ postLogoutRedirectUri: RETURN }))!);
    expect(`${url.origin}${url.pathname}`).toBe(`${OIDC_ISSUER}/logout`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: OIDC_CLIENT_ID, post_logout_redirect_uri: RETURN });
  });

  it("uses Cognito's own logout_uri parameter for a Cognito user pool", async () => {
    const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE1";
    const domain = "https://example-pool.auth.us-east-1.amazoncognito.com";
    const fetch = routeFetch(async (url) => (url.href === `${issuer}/.well-known/openid-configuration`
      ? Response.json({ issuer, authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`, jwks_uri: `${issuer}/.well-known/jwks.json`, end_session_endpoint: `${domain}/logout` })
      : undefined));
    const provider = oidcSignInProvider({ issuer, clientId: "pool-client", clientSecret: async () => "s", requiredValues: [], fetch, jwksFor: () => fakeOidc({ users: [] }).jwks, now });
    const url = new URL((await provider.endSessionUrl!({ postLogoutRedirectUri: RETURN }))!);
    expect(`${url.origin}${url.pathname}`).toBe(`${domain}/logout`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: "pool-client", logout_uri: RETURN });
  });

  it("is none for an end_session_endpoint that is not HTTPS", async () => {
    const fake = fakeOidc({ users: [] });
    fake.state.endSession = "http://idp.example.test/logout";
    const provider = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [], fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now });
    expect(await provider.endSessionUrl!({ postLogoutRedirectUri: RETURN })).toBeUndefined();
  });
});

describe("Code's end-session endpoint", () => {
  it("goes through the provider's sign-out and back to the client's address, clearing Code's own browser session", async () => {
    const h = harness({ endSession: `${OIDC_ISSUER}/logout` });
    const out = await h.http(endSession({ client_id: "web-app", post_logout_redirect_uri: SIGNED_OUT }));
    expect(out.statusCode).toBe(302);
    const target = new URL(out.headers.location!);
    expect(`${target.origin}${target.pathname}`).toBe(`${OIDC_ISSUER}/logout`);
    expect(target.searchParams.get("client_id")).toBe(OIDC_CLIENT_ID);
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(RETURN);
    expect(out.cookies).toContain("__Host-agentx_review_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    const pending = setCookie(out.cookies, "__Host-rovara_end_session");
    expect(pending).toBeDefined();
    expect(out.cookies!.find((cookie) => cookie.startsWith(`${pending}`))).toMatch(/; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=600$/u);

    const back = await h.http(withCookie(httpEvent("GET", "/v1/auth/end-session/return"), pending!));
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(SIGNED_OUT);
    expect(back.cookies).toEqual(["__Host-rovara_end_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"]);
    expect(h.logs).toContainEqual({ event: "signin.session_ended", clientId: "web-app", provider: true });
  });

  it("returns straight to the client when the provider has no sign-out address, is off or can't be reached", async () => {
    for (const h of [harness(), harness({ oidc: false }), (() => { const down = harness({ endSession: `${OIDC_ISSUER}/logout` }); down.oidc.state.down = true; return down; })()]) {
      const out = await h.http(endSession({ client_id: "web-app", post_logout_redirect_uri: SIGNED_OUT }));
      expect(out.statusCode).toBe(302);
      expect(out.headers.location).toBe(SIGNED_OUT);
      expect(setCookie(out.cookies, "__Host-rovara_end_session")).toBeUndefined();
      expect(out.cookies).toContain("__Host-agentx_review_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
    }
  });

  it("never redirects for an unknown client, the CLI, or an address off the client's registered origins", async () => {
    const h = harness({ endSession: `${OIDC_ISSUER}/logout` });
    for (const query of [
      { client_id: "someone-else", post_logout_redirect_uri: SIGNED_OUT },
      { client_id: "agentx-cli", post_logout_redirect_uri: "http://127.0.0.1:49152/callback" },
      { client_id: "web-app", post_logout_redirect_uri: "https://evil.example.test/app/signed-out" },
      { client_id: "web-app", post_logout_redirect_uri: "http://app.example.test/app/signed-out" },
      { client_id: "web-app", post_logout_redirect_uri: "https://user:pw@app.example.test/app/signed-out" },
      { client_id: "web-app", post_logout_redirect_uri: `${SIGNED_OUT}#x` },
      { client_id: "web-app", post_logout_redirect_uri: "/app/signed-out" },
      { client_id: "web-app" },
      { client_id: "web-app", post_logout_redirect_uri: `${APP}/${"a".repeat(2100)}` },
    ]) {
      const out = await h.http(endSession(query));
      expect(out.statusCode).toBe(400);
      expect(out.headers.location).toBeUndefined();
      expect(out.cookies).toBeUndefined();
      expect(out.body).toContain("This sign-out link is not valid");
    }
  });

  it("shows a signed-out page, never a redirect, when the return has no good waiting address", async () => {
    const h = harness({ endSession: `${OIDC_ISSUER}/logout` });
    const forged = Buffer.from(JSON.stringify({ clientId: "web-app", returnTo: "https://evil.example.test/" })).toString("base64url");
    for (const cookie of [undefined, "__Host-rovara_end_session=not-json", `__Host-rovara_end_session=${forged}`, `__Host-rovara_end_session=${Buffer.from("null").toString("base64url")}`]) {
      const event = httpEvent("GET", "/v1/auth/end-session/return");
      const back = await h.http(cookie === undefined ? event : withCookie(event, cookie));
      expect(back.statusCode).toBe(200);
      expect(back.headers.location).toBeUndefined();
      expect(back.body).toContain("You are signed out");
      expect(back.cookies).toEqual(["__Host-rovara_end_session=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"]);
    }
  });
});
