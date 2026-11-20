import { describe, expect, it } from "vitest";
import { ProviderNotConfiguredError, ProviderUnavailableError, oidcSignInProvider, slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import { ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, fakeOidc, fakeSlack, routeFetch } from "../support/developer-fakes.js";

const REFUSED = { ok: false, reason: "the identity token could not be verified; run agentx login again" };

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

  it("refuses an identity token signed by a key that is not Slack's", async () => {
    const fake = fakeSlack({ users: [maya] });
    const impostor = fakeSlack({ users: [maya] });
    const provider = slackSignInProvider({ teamId: TEAM, credentials: async () => ({ clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET }), fetch: routeFetch(fake.handler), jwks: impostor.jwks, now });
    const authorize = await provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: slackCallback });
    const result = await provider.complete({ code: await codeFrom(fake.approve(authorize, maya.userId)), nonce: "n", redirectUri: slackCallback });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toMatch(/could not be verified/);
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

    it("refuses a nonce that does not match", async () => {
      expect(await withToken((fake) => fake.issue({ ...good, nonce: "someone-elses" }))).toEqual({ ok: false, reason: "the identity token's nonce does not match this sign-in; run agentx login again" });
    });

  });

  it("refuses required values without a required claim instead of letting everyone in", async () => {
    const fake = fakeOidc({ users });
    const provider = oidcSignInProvider({ issuer: OIDC_ISSUER, clientId: OIDC_CLIENT_ID, clientSecret: async () => OIDC_CLIENT_SECRET, requiredValues: ["engineering"], fetch: routeFetch(fake.handler), jwksFor: () => fake.jwks, now });
    await expect(provider.authorizeUrl({ state: "s", nonce: "n", redirectUri: oidcCallback })).rejects.toBeInstanceOf(ProviderNotConfiguredError);
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
