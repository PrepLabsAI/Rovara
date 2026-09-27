import { describe, expect, it } from "vitest";
import { ProviderNotConfiguredError, ProviderUnavailableError, oidcSignInProvider, slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import {
  ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, fakeOidc, fakeSlack, routeFetch, rsaKeyPair,
} from "../support/developer-fakes.js";

const REFUSED = { ok: false, reason: "the identity token could not be verified; run agentx login again" };
const seconds = () => Math.floor(Date.now() / 1000);
const publicKeyAsSecret = (key: { export(options: { format: "pem"; type: "spki" }): string | Buffer }) => new TextEncoder().encode(String(key.export({ format: "pem", type: "spki" })));

const slackCallback = `${ISSUER}/callback/slack`;
const oidcCallback = `${ISSUER}/callback/oidc`;
const maya = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const now = () => Date.now();

function slack(overrides: { teamId?: string | undefined; credentials?: { clientId?: string; clientSecret?: string } } = {}) {
  const fake = fakeSlack({ users: [maya] });
  const provider = slackSignInProvider({
    teamId: "teamId" in overrides ? overrides.teamId : TEAM,
    credentials: async () => overrides.credentials ?? { clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET },
    fetch: routeFetch(fake.handler), jwks: fake.jwks, now,
  });
  return { fake, provider };
}

async function codeFrom(callbackUrl: string): Promise<string> {
  return new URL(callbackUrl).searchParams.get("code")!;
}

describe("Sign in with Slack (FR-003)", () => {
  it("sends the browser to Slack with openid email profile, the nonce, the state and the environment's team", async () => {
    const { provider } = slack();
    const url = new URL(await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback }));
    expect(url.origin + url.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code", scope: "openid email profile", client_id: SLACK_CLIENT_ID, state: "s1", nonce: "n1", redirect_uri: slackCallback, team: TEAM,
    });
  });

  it("accepts a member of the environment's team, subject = the Slack user ID", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n1", redirectUri: slackCallback });
    expect(result).toEqual({ ok: true, identity: { method: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya Chen", email: "maya@example.com", slackUserId: "U0MAYA001" } });
  });

  it("refuses another team, naming both teams, including another team of the same Grid (SC-007)", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId, { teamId: "T0OTHER1" })), nonce: "n1", redirectUri: slackCallback });
    expect(result).toEqual({ ok: false, reason: `you signed in to Slack workspace T0OTHER1, but this AgentX serves ${TEAM}` });
  });

  it("refuses a nonce that does not match", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s1", nonce: "n1", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "other", redirectUri: slackCallback });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/nonce/);
  });

  it("refuses an identity token signed by a key that is not Slack's", async () => {
    const fake = fakeSlack({ users: [maya] });
    const impostor = fakeSlack({ users: [maya] });
    const provider = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(fake.handler), jwks: impostor.jwks, now });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/could not be verified/);
  });

  it("refuses an expired identity token", async () => {
    const fake = fakeSlack({ users: [maya] });
    const provider = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(fake.handler), jwks: fake.jwks, now: () => Date.now() + 10 * 60_000 });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/could not be verified/);
  });

  it("records the email only when Slack says it is verified", async () => {
    const fake = fakeSlack({ users: [{ ...maya, emailVerified: false }] });
    const provider = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(fake.handler), jwks: fake.jwks, now });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(true);
    expect(result.ok && result.identity.email).toBeUndefined();
  });

  it("refuses to start without a team ID or without the app's client credentials (FR-006)", async () => {
    await expect(slack({ teamId: undefined }).provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    await expect(slack({ credentials: {} }).provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("reports Slack being down or rate limiting as unavailable, never as a refusal", async () => {
    const { fake, provider } = slack();
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const code = await codeFrom(fake.approve(authorize, maya.userId));
    fake.state.down = true;
    await expect(provider.complete({ code, nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderUnavailableError);
    fake.state.down = false;
    fake.state.rateLimited = true;
    await expect(provider.complete({ code, nonce: "n", redirectUri: slackCallback })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("never puts the client secret or the code in an error", async () => {
    const { fake, provider } = slack({ credentials: { clientId: SLACK_CLIENT_ID, clientSecret: "ffffffffffffffffffffffffffffffff" } });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const code = await codeFrom(fake.approve(authorize, maya.userId));
    const result = await provider.complete({ code, nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("ffffffffffffffffffffffffffffffff");
    expect(JSON.stringify(result)).not.toContain(code);
  });
});

describe("Slack identity token checks", () => {
  const good = { sub: maya.userId, nonce: "n", name: maya.name, "https://slack.com/user_id": maya.userId };
  async function withToken(mintToken: (fake: ReturnType<typeof fakeSlack>) => Promise<string>) {
    const fake = fakeSlack({ users: [maya] });
    const provider = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(fake.handler), jwks: fake.jwks, now });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const idToken = await mintToken(fake);
    return provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId, { idToken })), nonce: "n", redirectUri: slackCallback });
  }

  it("accepts a well-formed token minted by the test helper (so the refusals below mean something)", async () => {
    expect((await withToken((fake) => fake.issue(good))).ok).toBe(true);
  });

  it("refuses alg none", async () => {
    expect(await withToken((fake) => fake.issue(good, { alg: "none" }))).toEqual(REFUSED);
  });

  it("refuses HS256 signed with Slack's public key as the secret", async () => {
    expect(await withToken((fake) => fake.issue(good, { alg: "HS256" }, publicKeyAsSecret(fake.publicKey)))).toEqual(REFUSED);
  });

  it("refuses a token for another audience", async () => {
    expect(await withToken((fake) => fake.issue({ ...good, aud: "9999999999.8888888888888" }))).toEqual(REFUSED);
  });

  it("refuses a token from another issuer", async () => {
    expect(await withToken((fake) => fake.issue({ ...good, iss: "https://evil.example.test" }))).toEqual(REFUSED);
  });

  it("refuses a token issued in the future (beyond 60 seconds of clock skew) or too long ago", async () => {
    expect(await withToken((fake) => fake.issue({ ...good, iat: seconds() + 300, exp: seconds() + 900 }))).toEqual(REFUSED);
    expect(await withToken((fake) => fake.issue({ ...good, iat: seconds() - 20 * 60, exp: seconds() + 300 }))).toEqual(REFUSED);
    expect((await withToken((fake) => fake.issue({ ...good, iat: seconds() + 30 }))).ok).toBe(true);
  });

  it("refuses an azp that is not this app, and several audiences without azp", async () => {
    expect(await withToken((fake) => fake.issue({ ...good, azp: "9999999999.8888888888888" }))).toEqual(REFUSED);
    expect(await withToken((fake) => fake.issue({ ...good, aud: [SLACK_CLIENT_ID, "another-app"] }))).toEqual(REFUSED);
    expect((await withToken((fake) => fake.issue({ ...good, aud: [SLACK_CLIENT_ID, "another-app"], azp: SLACK_CLIENT_ID }))).ok).toBe(true);
  });
});

describe("company sign-in (FR-004)", () => {
  const users = [
    { sub: "okta-1", name: "Ravi", email: "ravi@example.com", email_verified: true, groups: ["engineering", "staff"] },
    { sub: "okta-2", name: "Sam", email: "sam@example.com", email_verified: false, groups: ["sales"] },
  ];
  function oidc(requiredClaim?: string, requiredValues: string[] = [], clientSecret = OIDC_CLIENT_SECRET) {
    const fake = fakeOidc({ users });
    const provider = oidcSignInProvider({
      issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => clientSecret,
      ...(requiredClaim === undefined ? {} : { requiredClaim }), requiredValues,
      fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now,
    });
    return { fake, provider };
  }
  async function signIn(provider: ReturnType<typeof oidc>["provider"], fake: ReturnType<typeof oidc>["fake"], sub: string) {
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback });
    return provider.complete({ code: await codeFrom(fake.approve(authorize, sub)), nonce: "n", redirectUri: oidcCallback });
  }

  it("uses the discovery document's authorization endpoint with openid email profile", async () => {
    const { provider } = oidc();
    const url = new URL(await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback }));
    expect(url.origin + url.pathname).toBe(`${OIDC_ISSUER}/authorize`);
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("client_id")).toBe(OIDC_CLIENT_ID);
  });

  it("accepts a person in the required group, with their verified email", async () => {
    const { fake, provider } = oidc("groups", ["engineering"]);
    expect(await signIn(provider, fake, "okta-1")).toEqual({ ok: true, identity: { method: "oidc", issuer: OIDC_ISSUER, subject: "okta-1", displayName: "Ravi", email: "ravi@example.com" } });
  });

  it("refuses a person outside the required group and names the group (US4 scenario 3)", async () => {
    const { fake, provider } = oidc("groups", ["engineering", "platform"]);
    expect(await signIn(provider, fake, "okta-2")).toEqual({ ok: false, reason: "this AgentX requires the groups claim to include engineering or platform" });
  });

  it("drops an unverified email", async () => {
    const { fake, provider } = oidc();
    const result = await signIn(provider, fake, "okta-2");
    expect(result.ok && result.identity.email).toBe(undefined);
  });

  it("never puts the client secret in a refusal", async () => {
    const { fake, provider } = oidc(undefined, [], "planted-wrong-oidc-secret");
    const result = await signIn(provider, fake, "okta-1");
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("planted-wrong-oidc-secret");
  });

  describe("identity token checks", () => {
    const good = { sub: "okta-1", nonce: "n", name: "Ravi" };
    async function withToken(mintToken: (fake: ReturnType<typeof fakeOidc>) => Promise<string>, nonce = "n") {
      const { fake, provider } = oidc();
      const authorize = await provider.authorizeUrl({ state: "s", nonce, redirectUri: oidcCallback });
      const idToken = await mintToken(fake);
      return provider.complete({ code: await codeFrom(fake.approve(authorize, "okta-1", { idToken })), nonce, redirectUri: oidcCallback });
    }

    it("accepts a well-formed token minted by the test helper", async () => {
      expect((await withToken((fake) => fake.issue(good))).ok).toBe(true);
    });

    it("refuses a nonce that does not match", async () => {
      expect(await withToken((fake) => fake.issue({ ...good, nonce: "someone-elses" }))).toEqual({ ok: false, reason: "the identity token's nonce does not match this sign-in; run agentx login again" });
    });

    it("refuses a token signed by a key that is not the provider's", async () => {
      expect(await withToken((fake) => fake.issue(good, {}, rsaKeyPair().privateKey))).toEqual(REFUSED);
    });

    it("refuses an expired token", async () => {
      expect(await withToken((fake) => fake.issue({ ...good, iat: seconds() - 600, exp: seconds() - 120 }))).toEqual(REFUSED);
    });

    it("refuses alg none, HS256 with the public key, another audience and an azp that is not this app", async () => {
      expect(await withToken((fake) => fake.issue(good, { alg: "none" }))).toEqual(REFUSED);
      expect(await withToken((fake) => fake.issue(good, { alg: "HS256" }, publicKeyAsSecret(fake.publicKey)))).toEqual(REFUSED);
      expect(await withToken((fake) => fake.issue({ ...good, aud: "someone-else" }))).toEqual(REFUSED);
      expect(await withToken((fake) => fake.issue({ ...good, azp: "someone-else" }))).toEqual(REFUSED);
    });
  });

  it("form-encodes the client ID and secret in the Basic header (RFC 6749 section 2.3.1)", async () => {
    const secret = "s3cr et!'()*~";
    const fake = fakeOidc({ users, clientSecret: secret });
    const provider = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => secret, requiredValues: [], fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, "okta-1")), nonce: "n", redirectUri: oidcCallback });
    expect(fake.state.authorizations).toEqual([`Basic ${Buffer.from("agentx-developers:s3cr+et%21%27%28%29*%7E").toString("base64")}`]);
    expect(result.ok).toBe(true);
  });

  it("refuses required values without a required claim instead of letting everyone in", async () => {
    const fake = fakeOidc({ users });
    const provider = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: ["engineering"], fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now });
    await expect(provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("reports an unreachable provider as unavailable", async () => {
    const { fake, provider } = oidc();
    fake.state.down = true;
    await expect(provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("refuses a discovery document whose issuer is not the configured one", async () => {
    const fake = fakeOidc({ users });
    const provider = oidcSignInProvider({
      issuer: "https://other.example.test", clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: [],
      fetch: routeFetch(async (url, init) => (url.origin === "https://other.example.test" ? fake.handler(new URL(url.pathname, OIDC_ISSUER), init) : undefined)),
      jwksFor: () => fake.jwks, now,
    });
    await expect(provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});
