import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import {
  developerIdentityConfigFromEnvironment,
  parseOidcClientSecret,
  parseSlackSignInSecret,
  remoteJwksCache,
  unconfiguredProvider,
} from "../../packages/broker/src/aws/developer-identity.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { ProviderNotConfiguredError, slackSignInProvider } from "../../packages/broker/src/developer/providers.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { kmsTokenSigner } from "../../packages/broker/src/developer/tokens.js";
import {
  BOT_TOKEN, CLI_REDIRECT, ISSUER, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, TEAM, authorizeQuery, httpEvent, identityHarness,
  type FakeSlackUser,
} from "../support/developer-fakes.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const mayaId = ownerKeyForSubject("https://slack.com", "U0MAYA001");
const json = (body: string) => JSON.parse(body) as Record<string, unknown>;
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/0000aaaa-planted-key-arn";

describe("discovery (FR-001, FR-048)", () => {
  it("publishes an OpenID configuration whose issuer is exactly the authorizer's, and the JWKS", async () => {
    const h = identityHarness();
    const discovery = json((await h.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"))).body);
    expect(discovery).toMatchObject({
      issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, revocation_endpoint: `${ISSUER}/revoke`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"], id_token_signing_alg_values_supported: ["RS256"],
    });
    expect(json((await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"))).body)).toEqual(await h.signer.jwks());
  });

  it("reports the environment, API version and the methods that can actually be used", async () => {
    const both = identityHarness({ oidc: {} });
    expect(json((await both.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toEqual({
      env: "staging", apiVersion: "1.2", adminApiVersion: "1.1", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
      revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: true, oidc: { displayName: "Okta" } },
    });
    // FR-006: Slack sign-in is refused while the team ID is unset, so it is not offered.
    const noTeam = identityHarness({ teamId: undefined });
    expect(json((await noTeam.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toMatchObject({ methods: { slack: false, oidc: null } });
  });

  it("answers 404 for an unknown route", async () => {
    const h = identityHarness();
    expect((await h.http(httpEvent("GET", "/v1/auth/nothing-here"))).statusCode).toBe(404);
  });
});

describe("authorize (FR-001, FR-002)", () => {
  it("never redirects to a URI that is not the CLI's loopback, and names the problem", async () => {
    const h = identityHarness();
    for (const query of [{ client_id: "other" }, { redirect_uri: "https://evil.example.test/callback" }, { redirect_uri: "http://localhost:1/callback" }]) {
      const response = await h.http(httpEvent("GET", authorizeQuery(query)));
      expect(response.statusCode).toBe(400);
      expect(response.headers.location).toBeUndefined();
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.body).toContain("agentx login");
    }
  });

  it("sends a bad PKCE or response type back to the CLI as invalid_request", async () => {
    const h = identityHarness();
    for (const query of [{ code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }, { state: "" }]) {
      const location = new URL((await h.http(httpEvent("GET", authorizeQuery(query)))).headers.location!);
      expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("goes straight to the only enabled method, with a server-held state and nonce", async () => {
    const h = identityHarness();
    const response = await h.http(httpEvent("GET", authorizeQuery()));
    expect(response.statusCode).toBe(302);
    const slack = new URL(response.headers.location!);
    expect(slack.origin).toBe("https://slack.com");
    expect(slack.searchParams.get("state")).not.toBe("cli-state");
    expect(slack.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(slack.searchParams.get("redirect_uri")).toBe(`${ISSUER}/callback/slack`);
  });

  it("shows a page with each enabled method when there are two, escaping the display name", async () => {
    const h = identityHarness({ oidc: {} });
    h.deps.config.oidc = { displayName: "<Okta & co>" };
    const response = await h.http(httpEvent("GET", authorizeQuery()));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sign in with Slack");
    expect(response.body).toContain("Sign in with &lt;Okta &amp; co&gt;");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("sends the security headers on every HTML page, including refusals", async () => {
    const h = identityHarness({ oidc: {} });
    const pages = [
      await h.http(httpEvent("GET", authorizeQuery())),
      await h.http(httpEvent("GET", authorizeQuery({ client_id: "other" }))),
      await h.http(httpEvent("GET", "/v1/auth/callback/slack?state=nope&code=x")),
    ];
    for (const response of pages) {
      expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("tells the CLI when no method is enabled", async () => {
    const h = identityHarness({ slack: false });
    const location = new URL((await h.http(httpEvent("GET", authorizeQuery()))).headers.location!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toContain("agentx signin enable");
  });

  it("says Slack sign-in is not finished when the Slack secret has no bot token (F25)", async () => {
    const h = identityHarness();
    h.deps.providers.slack = slackSignInProvider({
      teamId: TEAM,
      credentials: async () => parseSlackSignInSecret(JSON.stringify({ botToken: "unset", clientId: SLACK_CLIENT_ID, clientSecret: SLACK_CLIENT_SECRET })),
      fetch: h.fetch, jwks: h.slack.jwks, now: h.now,
    });
    const response = await h.http(httpEvent("GET", authorizeQuery()));
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toContain("not finished");
    expect(location.searchParams.get("state")).toBe("cli-state");
    expect(JSON.stringify(h.logs) + response.headers.location!).not.toContain(SLACK_CLIENT_SECRET);
  });
});

describe("Sign in with Slack end to end (US4 scenario 1, FR-003, FR-005, FR-008)", () => {
  it("issues a code to the loopback, then an access token the broker accepts and a refresh token", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const back = await h.signIn("slack", maya.userId);
    expect(`${back.origin}${back.pathname}`).toBe(CLI_REDIRECT);
    expect(back.searchParams.get("state")).toBe("cli-state");
    const code = back.searchParams.get("code")!;
    const { status, body } = await h.exchange(code);
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(body.refresh_token).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);
    const { payload } = await jwtVerify(String(body.access_token), createLocalJWKSet(await h.signer.jwks()), { issuer: ISSUER, audience: "agentx-developer", currentDate: new Date(h.now()) });
    expect(payload).toMatchObject({ sub: mayaId, amr: "slack", env: "staging" });
    expect(h.db.get(`DEVELOPER#${mayaId}`, "META")).toMatchObject({ provider: "slack", displayName: "Maya Chen", email: "maya@example.com", slackUserId: "U0MAYA001", revoked: false });
  });

  it("refuses another Slack team: no code, no developer record, the reason goes to the CLI (US4 scenario 2, SC-007)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const back = await h.signIn("slack", maya.userId, { teamId: "T0OTHER1" });
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("error")).toBe("access_denied");
    // The hint matters: a provider that silently reuses the refused account's session refuses again.
    expect(back.searchParams.get("error_description")).toBe(`you signed in to Slack workspace T0OTHER1, but this AgentX serves ${TEAM}. If you signed in with the wrong account, sign out of Slack or use a private window, then try again.`);
    expect(h.db.get(`DEVELOPER#${mayaId}`, "META")).toBeUndefined();
    expect(h.logs.some((entry) => entry.event === "signin.refused" && entry.method === "slack")).toBe(true);
  });

  it("refuses a developer an admin revoked", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    h.db.set({ pk: `DEVELOPER#${mayaId}`, sk: "META", developerId: mayaId, provider: "slack", issuer: "https://slack.com", subject: "U0MAYA001", displayName: "Maya", firstSignInAt: "x", lastSignInAt: "x", revoked: true });
    const back = await h.signIn("slack", maya.userId);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("code")).toBeNull();
  });

  it("uses a callback state once, and not after 10 minutes", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", authorizeQuery()));
    const callback = h.slack.approve(start.headers.location!, maya.userId);
    expect((await h.http(httpEvent("GET", callback))).statusCode).toBe(302);
    expect((await h.http(httpEvent("GET", callback))).statusCode).toBe(400);
    const late = await h.http(httpEvent("GET", authorizeQuery()));
    const lateCallback = h.slack.approve(late.headers.location!, maya.userId);
    h.tick(601_000);
    expect((await h.http(httpEvent("GET", lateCallback))).statusCode).toBe(400);
  });

  it("refuses a state started for one method at the other method's callback", async () => {
    const h = identityHarness({ slackUsers: [maya], oidc: {} });
    const page = await h.http(httpEvent("GET", authorizeQuery()));
    const link = /href="([^"]*method=slack)"/.exec(page.body)![1]!.replaceAll("&amp;", "&");
    const slack = new URL((await h.http(httpEvent("GET", link))).headers.location!);
    const state = slack.searchParams.get("state")!;
    expect((await h.http(httpEvent("GET", `/v1/auth/callback/oidc?code=x&state=${state}`))).statusCode).toBe(400);
  });

  it("sends a Slack outage back to the CLI as temporarily_unavailable", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", authorizeQuery()));
    const callback = h.slack.approve(start.headers.location!, maya.userId);
    h.slack.state.down = true;
    const location = new URL((await h.http(httpEvent("GET", callback))).headers.location!);
    expect(location.searchParams.get("error")).toBe("temporarily_unavailable");
  });
});

describe("company sign-in (US4 scenario 3, FR-004, FR-012)", () => {
  const ravi = { sub: "okta-ravi", name: "Ravi", email: "ravi@example.com", email_verified: true, groups: ["engineering"] };
  const sam = { sub: "okta-sam", name: "Sam", email: "sam@example.com", email_verified: true, groups: ["sales"] };

  it("refuses a person outside the required group, naming it", async () => {
    const h = identityHarness({ slack: false, oidc: { requiredClaim: "groups", requiredValues: ["engineering"] }, oidcUsers: [sam] });
    const back = await h.signIn("oidc", "okta-sam");
    expect(back.searchParams.get("error_description")).toBe("this AgentX requires the groups claim to include engineering. If you signed in with the wrong account, sign out of Okta or use a private window, then try again.");
  });

  it("links a company user to the Slack user with the same verified email", async () => {
    const h = identityHarness({ slack: false, oidc: { requiredClaim: "groups", requiredValues: ["engineering"] }, oidcUsers: [ravi], slackUsers: [{ userId: "U0RAVI001", name: "Ravi", email: "ravi@example.com" }] });
    const back = await h.signIn("oidc", "okta-ravi");
    expect((await h.exchange(back.searchParams.get("code")!)).status).toBe(200);
    expect(h.db.get(`DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, "okta-ravi")}`, "META")).toMatchObject({ provider: "oidc", email: "ravi@example.com", slackUserId: "U0RAVI001" });
  });

  it("never looks up an unverified email in Slack", async () => {
    const unverified = { sub: "okta-eve", name: "Eve", email: "ravi@example.com", email_verified: false };
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [unverified], slackUsers: [{ userId: "U0RAVI001", name: "Ravi", email: "ravi@example.com" }] });
    const back = await h.signIn("oidc", "okta-eve");
    expect(back.searchParams.get("code")).not.toBeNull();
    expect(h.fetch.calls.some((call) => call.includes("users.lookupByEmail"))).toBe(false);
    const record = h.db.get(`DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, "okta-eve")}`, "META")!;
    expect(record.slackUserId).toBeUndefined();
    expect(record.email).toBeUndefined();
  });

  it("keeps the earlier Slack link when Slack is down at sign-in (R18)", async () => {
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [ravi], slackUsers: [{ userId: "U0RAVI001", name: "Ravi", email: "ravi@example.com" }] });
    await h.signIn("oidc", "okta-ravi");
    h.slack.state.down = true;
    const back = await h.signIn("oidc", "okta-ravi");
    expect(back.searchParams.get("code")).not.toBeNull();
    expect(h.db.get(`DEVELOPER#${ownerKeyForSubject(OIDC_ISSUER, "okta-ravi")}`, "META")).toMatchObject({ slackUserId: "U0RAVI001" });
  });
});

describe("the token endpoint (FR-001, FR-005, FR-007)", () => {
  async function signedIn() {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const first = await h.exchange(code);
    return { h, code, refreshToken: String(first.body.refresh_token) };
  }
  const revocations = (logs: Array<Record<string, unknown>>) => logs.filter((entry) => entry.event === "signin.session_revoked");

  it("refuses a reused code, a wrong verifier, a wrong redirect URI and another client", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const wrongVerifier = await h.exchange(code, { code_verifier: "w".repeat(64) });
    expect(wrongVerifier.status).toBe(400);
    expect(Object.keys(wrongVerifier.body).sort()).toEqual(["error", "error_description"]);
    expect(wrongVerifier.body.error).toBe("invalid_grant");
    expect(typeof wrongVerifier.body.error_description).toBe("string");
    const code2 = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const wrongRedirect = await h.exchange(code2, { redirect_uri: "http://127.0.0.1:1/callback" });
    expect(wrongRedirect.body).toEqual(wrongVerifier.body);
    const code3 = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    expect((await h.exchange(code3, { client_id: "other" })).status).toBe(401);
    expect((await h.exchange(code3)).status).toBe(200);
    expect((await h.exchange(code3)).body).toEqual(wrongVerifier.body);
  });

  it("rotates refresh tokens and keeps the 7-day end (US4 scenario 4)", async () => {
    const { h, refreshToken } = await signedIn();
    h.tick(3_600_000);
    const next = await h.refresh(refreshToken);
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(refreshToken);
    h.tick(6 * 86_400_000);
    expect((await h.refresh(String(next.body.refresh_token))).status).toBe(200);
  });

  it("revokes the whole session when an old refresh token is used again after the grace window (FR-005)", async () => {
    const { h, refreshToken } = await signedIn();
    const next = await h.refresh(refreshToken);
    h.tick(61_000);
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
    expect((await h.refresh(String(next.body.refresh_token))).body.error).toBe("invalid_grant");
    expect(revocations(h.logs).map((entry) => entry.reason)).toEqual(["refresh_token_reused"]);
  });

  it("mints a fresh successor, without revoking, when the old token comes back within 60 seconds", async () => {
    const { h, refreshToken } = await signedIn();
    const next = await h.refresh(refreshToken);
    h.tick(30_000);
    const again = await h.refresh(refreshToken);
    expect(again.status).toBe(200);
    expect(again.body.refresh_token).toMatch(/^agxr_[A-Za-z0-9_-]{43}$/);
    expect(again.body.refresh_token).not.toBe(next.body.refresh_token);
    expect(revocations(h.logs)).toEqual([]);
    expect((await h.refresh(String(again.body.refresh_token))).status).toBe(200);
  });

  it("revokes when the grace window closes between the lookup and the rotation", async () => {
    const { h, refreshToken } = await signedIn();
    await h.refresh(refreshToken);
    h.deps.store.rotateRecentlyUsed = async () => ({ reused: true });
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
    expect(revocations(h.logs).map((entry) => entry.reason)).toEqual(["refresh_token_reused"]);
  });

  it("asks for a new sign-in, without a revocation, when the session ended during the rotation", async () => {
    const { h, refreshToken } = await signedIn();
    h.deps.store.rotateRefresh = async () => ({ ended: true });
    const refused = await h.refresh(refreshToken);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_grant");
    expect(revocations(h.logs)).toEqual([]);
  });

  it("answers a retryable store error with 503 and keeps the session", async () => {
    const { h, refreshToken } = await signedIn();
    const send = h.db.send;
    h.db.send = async (command) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
        throw Object.assign(new Error("Transaction cancelled"), { name: "TransactionCanceledException", CancellationReasons: [{ Code: "None" }, { Code: "None" }, { Code: "TransactionConflict" }] });
      }
      return send(command);
    };
    const retry = await h.refresh(refreshToken);
    expect(retry.status).toBe(503);
    expect(retry.body.error).toBe("temporarily_unavailable");
    expect(revocations(h.logs)).toEqual([]);
    h.db.send = send;
    expect((await h.refresh(refreshToken)).status).toBe(200);
  });

  it("ends the session 7 days after the provider sign-in (US4 scenario 5)", async () => {
    const { h, refreshToken } = await signedIn();
    h.tick(604_801_000);
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
  });

  it("fails and revokes when the Slack user is deactivated (FR-007)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const { body } = await h.exchange(code);
    maya.deleted = true;
    try {
      const refused = await h.refresh(String(body.refresh_token));
      expect(refused.body.error).toBe("invalid_grant");
      expect(refused.body.error_description).toContain("no longer active");
      expect(revocations(h.logs).map((entry) => entry.reason)).toEqual(["slack_user_inactive"]);
    } finally {
      delete maya.deleted;
    }
  });

  it("keeps the session when Slack cannot be reached at refresh (Review Focus 3, R18)", async () => {
    const { h, refreshToken } = await signedIn();
    h.slack.state.down = true;
    const unavailable = await h.refresh(refreshToken);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error).toBe("temporarily_unavailable");
    h.slack.state.down = false;
    h.slack.state.rateLimited = true;
    expect((await h.refresh(refreshToken)).status).toBe(503);
    h.slack.state.rateLimited = false;
    expect((await h.refresh(refreshToken)).status).toBe(200);
  });

  it("refuses a refresh once the method is disabled, and revokes that session (FR-045, R13)", async () => {
    const { h, refreshToken } = await signedIn();
    h.deps.config.slack.enabled = false;
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
    h.deps.config.slack.enabled = true;
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
  });

  it("keeps a session the disable ended from coming back once the method is on again: a refresh started before the cutoff is refused and revoked (FR-045)", async () => {
    const { h, refreshToken } = await signedIn();
    // The laptop slept through the disable; an admin turned Slack back on an hour later.
    h.tick(3_600_000);
    h.deps.config.slack.since = Math.floor(h.now() / 1000);
    h.tick(60_000);
    const refused = await h.refresh(refreshToken);
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_grant");
    expect(refused.body.error_description).toContain("Slack was turned off");
    expect(revocations(h.logs).map((entry) => entry.reason)).toEqual(["method_disabled"]);
  });

  it("keeps a session started after the method's cutoff working", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    h.deps.config.slack.since = Math.floor(h.now() / 1000) - 60;
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const first = await h.exchange(code);
    h.tick(60_000);
    expect((await h.refresh(String(first.body.refresh_token))).status).toBe(200);
    expect(revocations(h.logs)).toEqual([]);
  });

  it("answers unsupported_grant_type for anything else", async () => {
    const h = identityHarness();
    const response = await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "password", client_id: "agentx-cli" }));
    expect(json(response.body).error).toBe("unsupported_grant_type");
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("turns a KMS failure into a generic 500 that never repeats the error's message", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const code = (await h.signIn("slack", maya.userId)).searchParams.get("code")!;
    const failure = Object.assign(new Error(`User is not authorized to perform kms:Sign on ${KEY_ARN}`), { name: "AccessDeniedException" });
    h.deps.signer = kmsTokenSigner({ kms: { send: () => Promise.reject(failure) }, keyId: KEY_ARN });
    const token = await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "authorization_code", client_id: "agentx-cli", code, code_verifier: "v".repeat(64), redirect_uri: CLI_REDIRECT }));
    const keys = await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"));
    expect(token.statusCode).toBe(500);
    expect(json(token.body)).toEqual({ error: "server_error", error_description: "sign-in failed on the server; try again" });
    expect(keys.statusCode).toBe(500);
    expect(json(keys.body).error).toBe("server_error");
    const everything = token.body + keys.body + JSON.stringify(h.logs);
    expect(everything).not.toContain(KEY_ARN);
    expect(everything).not.toContain("not authorized");
  });
});

describe("revocation and the channel-members invoke", () => {
  it("ends the session of a revoked refresh token and always answers 200 (RFC 7009, R14)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const { body } = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    expect((await h.http(httpEvent("POST", "/v1/auth/revoke", { token: String(body.refresh_token), client_id: "agentx-cli" }))).statusCode).toBe(200);
    expect((await h.refresh(String(body.refresh_token))).body.error).toBe("invalid_grant");
    expect(h.logs.some((entry) => entry.event === "signin.session_revoked" && entry.reason === "signed_out")).toBe(true);
    expect((await h.http(httpEvent("POST", "/v1/auth/revoke", { token: "agxr_unknown", client_id: "agentx-cli" }))).statusCode).toBe(200);
    expect((await h.http(httpEvent("POST", "/v1/auth/revoke", { token: "agxr_unknown" }))).statusCode).toBe(200);
  });

  it("ends the session when the previous token, rotated moments ago, is revoked", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const { body } = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    const next = await h.refresh(String(body.refresh_token));
    expect((await h.http(httpEvent("POST", "/v1/auth/revoke", { token: String(body.refresh_token) }))).statusCode).toBe(200);
    expect((await h.refresh(String(next.body.refresh_token))).body.error).toBe("invalid_grant");
  });

  it("refuses revocation from another client", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const { body } = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    const response = await h.http(httpEvent("POST", "/v1/auth/revoke", { token: String(body.refresh_token), client_id: "other" }));
    expect(response.statusCode).toBe(401);
    expect(json(response.body).error).toBe("invalid_client");
    expect((await h.refresh(String(body.refresh_token))).status).toBe(200);
  });

  it("answers which bound channels a Slack user is in", async () => {
    const h = identityHarness({ channels: { C0PAY0001: ["U0MAYA001"], C0LEDGER1: [] } });
    expect(await h.handler({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0PAY0001", "C0LEDGER1"] })).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
  });

  it("answers invalid_request, not slack_unavailable, for a malformed channel-members request", async () => {
    const h = identityHarness();
    expect(await h.handler({ kind: "channel-members", slackUserId: "not-a-user", channelIds: [] })).toEqual({ ok: false, error: "invalid_request" });
  });

  it("answers the broker's channel-info request, and refuses a malformed one", async () => {
    const h = identityHarness({ channelInfo: { C0PAY0001: { name: "payments-dev", isPrivate: false } } });
    expect(await h.handler({ kind: "channel-info", channelIds: ["C0PAY0001"] })).toEqual({ ok: true, channels: [{ channelId: "C0PAY0001", name: "payments-dev", isPrivate: false }] });
    expect(await h.handler({ kind: "channel-info", channelIds: ["not-a-channel"] })).toEqual({ ok: false, error: "invalid_request" });
  });
});

describe("failure answers (Task 6 fix round 1)", () => {
  const commandName = (command: unknown) => (command as { constructor: { name: string } }).constructor.name;
  const throttled = () => Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });

  it("answers any retryable store error in the refresh grant or revoke with 503, never 500", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const { body } = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    const refreshToken = String(body.refresh_token);
    const send = h.db.send;
    h.db.send = async (command) => {
      if (commandName(command) === "GetCommand") throw throttled();
      return send(command);
    };
    const refresh = await h.refresh(refreshToken);
    expect(refresh.status).toBe(503);
    expect(refresh.body.error).toBe("temporarily_unavailable");
    const revoke = await h.http(httpEvent("POST", "/v1/auth/revoke", { token: refreshToken }));
    expect(revoke.statusCode).toBe(503);
    expect(json(revoke.body).error).toBe("temporarily_unavailable");
    h.db.send = async (command) => {
      if (commandName(command) === "UpdateCommand") throw throttled();
      return send(command);
    };
    expect((await h.refresh(refreshToken)).status).toBe(200); // rotates: TransactWrite, not an UpdateCommand
    h.tick(61_000);
    expect((await h.refresh(refreshToken)).status).toBe(503); // reused past the window: revokeSession is throttled
    h.db.send = send;
    expect((await h.refresh(refreshToken)).body.error).toBe("invalid_grant");
  });

  it("sends an unexpected failure after the state was used back to the CLI as server_error", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    h.deps.store.upsertDeveloper = () => Promise.reject(Object.assign(new Error(`boom ${KEY_ARN}`), { name: "InternalServerError" }));
    const start = await h.http(httpEvent("GET", authorizeQuery()));
    const response = await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, maya.userId)));
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    expect(location.searchParams.get("error")).toBe("server_error");
    expect(location.searchParams.get("state")).toBe("cli-state");
    expect(response.headers.location + JSON.stringify(h.logs)).not.toContain(KEY_ARN);
    expect(h.logs.some((entry) => entry.event === "signin.error" && entry.error === "InternalServerError")).toBe(true);
  });

  it("sends any failure after /authorize validated the request back to the CLI as server_error, never a 500 page", async () => {
    const expectServerError = (response: HttpResult) => {
      expect(response.statusCode).toBe(302);
      const location = new URL(response.headers.location!);
      expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
      expect(location.searchParams.get("error")).toBe("server_error");
      expect(location.searchParams.get("state")).toBe("cli-state");
      expect(response.headers.location).not.toContain(KEY_ARN);
    };
    // The Slack secret cannot be read (AccessDenied), with one method or from the method page.
    const denied = () => Promise.reject(Object.assign(new Error(`not authorized on ${KEY_ARN}`), { name: "AccessDeniedException" }));
    const one = identityHarness();
    one.deps.providers.slack = { method: "slack", authorizeUrl: denied, complete: denied };
    expectServerError(await one.http(httpEvent("GET", authorizeQuery())));
    const two = identityHarness({ oidc: {} });
    two.deps.providers.slack = { method: "slack", authorizeUrl: denied, complete: denied };
    const page = await two.http(httpEvent("GET", authorizeQuery()));
    const link = /href="([^"]*method=slack)"/.exec(page.body)![1]!.replaceAll("&amp;", "&");
    expectServerError(await two.http(httpEvent("GET", link)));
    // The store is throttled while recording the request.
    const throttledStore = identityHarness();
    throttledStore.deps.store.createAuthRequest = () => Promise.reject(throttled());
    expectServerError(await throttledStore.http(httpEvent("GET", authorizeQuery())));
    for (const h of [one, two, throttledStore]) {
      expect(JSON.stringify(h.logs)).not.toContain(KEY_ARN);
      expect(h.logs.some((entry) => entry.event === "signin.error")).toBe(true);
    }
  });

  it("sends pragma: no-cache only with no-store, never beside a public cache-control", async () => {
    const h = identityHarness();
    for (const path of ["/v1/auth/.well-known/openid-configuration", "/v1/auth/.well-known/jwks.json"]) {
      const response = await h.http(httpEvent("GET", path));
      expect(response.headers["cache-control"]).toBe("public, max-age=300");
      expect(response.headers.pragma).toBeUndefined();
    }
    const token = await h.http(httpEvent("POST", "/v1/auth/token", { grant_type: "password", client_id: "agentx-cli" }));
    expect(token.headers["cache-control"]).toBe("no-store");
    expect(token.headers.pragma).toBe("no-cache");
  });

  it("gives every expired-link page its own headers object", async () => {
    const h = identityHarness();
    const first = await h.http(httpEvent("GET", "/v1/auth/callback/slack?state=nope&code=x"));
    const second = await h.http(httpEvent("GET", "/v1/auth/callback/slack?state=nope&code=x"));
    expect(first.statusCode).toBe(400);
    expect(first.headers).toEqual(second.headers);
    expect(first.headers).not.toBe(second.headers);
  });
});

describe("secrets never leave", () => {
  it("keeps client secrets, the bot token, codes and refresh tokens out of every log line and HTML page", async () => {
    const h = identityHarness({ slackUsers: [maya], oidc: {}, oidcUsers: [{ sub: "okta-1", email: "a@example.com", email_verified: true }] });
    const pages: string[] = [];
    const slackBack = await h.signIn("slack", maya.userId);
    const code = slackBack.searchParams.get("code")!;
    const { body } = await h.exchange(code);
    const refreshed = await h.refresh(String(body.refresh_token));
    h.tick(61_000);
    await h.refresh(String(body.refresh_token));
    await h.http(httpEvent("POST", "/v1/auth/revoke", { token: String(refreshed.body.refresh_token) }));
    pages.push((await h.http(httpEvent("GET", authorizeQuery()))).body);
    pages.push((await h.http(httpEvent("GET", `/v1/auth/callback/slack?code=${code}&state=nope`))).body);
    const everything = JSON.stringify(h.logs) + pages.join("");
    for (const secret of [SLACK_CLIENT_SECRET, OIDC_CLIENT_SECRET, BOT_TOKEN, code, String(body.refresh_token), String(refreshed.body.refresh_token), String(body.access_token)]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe("the Lambda's configuration", () => {
  const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: ISSUER };
  it("turns Slack on only for enabled, keeps an empty team ID unset, and company sign-in off without an issuer", () => {
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_SLACK: "enabled", SLACK_TEAM_ID: "" })).toEqual({ env: "staging", issuer: ISSUER, slack: { enabled: true } });
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_SLACK: "disabled", SLACK_TEAM_ID: TEAM }).slack).toEqual({ enabled: false, teamId: TEAM });
  });

  it("reads each method's enabled-since cutoff, and treats 0, empty or unreadable as none (FR-045)", () => {
    const slackOn = { ...base, DEVELOPER_SIGNIN_SLACK: "enabled", SLACK_TEAM_ID: TEAM };
    expect(developerIdentityConfigFromEnvironment({ ...slackOn, DEVELOPER_SIGNIN_SLACK_SINCE: "1790000000" }).slack).toEqual({ enabled: true, teamId: TEAM, since: 1790000000 });
    for (const since of ["0", "", "soon", undefined]) {
      expect(developerIdentityConfigFromEnvironment({ ...slackOn, DEVELOPER_SIGNIN_SLACK_SINCE: since }).slack).toEqual({ enabled: true, teamId: TEAM });
    }
    const oidc = developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_CLIENT_ID: "c", DEVELOPER_OIDC_DISPLAY_NAME: "Okta", DEVELOPER_OIDC_SINCE: "1790000500" });
    expect(oidc.oidc).toEqual({ displayName: "Okta", since: 1790000500 });
  });

  it("reads its argument, not the process environment (F1)", () => {
    expect(() => developerIdentityConfigFromEnvironment({ DEVELOPER_TOKEN_ISSUER: ISSUER })).toThrow(/^AGENTX_ENV is required$/);
  });

  it("records a company sign-in problem instead of failing the whole Lambda", () => {
    const missingClient = developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_DISPLAY_NAME: "Okta" });
    expect(missingClient.oidc).toEqual({ displayName: "Okta" });
    expect(missingClient.oidcSettings).toBeUndefined();
    expect(missingClient.oidcProblem).toContain("DEVELOPER_OIDC_CLIENT_ID");
  });

  it("reads the company settings", () => {
    expect(developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_CLIENT_ID: "c", DEVELOPER_OIDC_REQUIRED_CLAIM: "groups", DEVELOPER_OIDC_REQUIRED_VALUES: "[\"engineering\"]", DEVELOPER_OIDC_DISPLAY_NAME: "Okta" }))
      .toMatchObject({ oidc: { displayName: "Okta" }, oidcSettings: { issuer: OIDC_ISSUER, clientId: "c", requiredClaim: "groups", requiredValues: ["engineering"] } });
  });

  it("refuses required values without a required claim, and values that are not a JSON array of strings, as a company sign-in problem", () => {
    const oidc = { ...base, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_CLIENT_ID: "c" };
    const noClaim = developerIdentityConfigFromEnvironment({ ...oidc, DEVELOPER_OIDC_REQUIRED_VALUES: "[\"engineering\"]" });
    expect(noClaim.oidcSettings).toBeUndefined();
    expect(noClaim.oidcProblem).toContain("DEVELOPER_OIDC_REQUIRED_CLAIM");
    for (const values of ["{\"a\":1}", "not json", "[1]"]) {
      const config = developerIdentityConfigFromEnvironment({ ...oidc, DEVELOPER_OIDC_REQUIRED_CLAIM: "groups", DEVELOPER_OIDC_REQUIRED_VALUES: values });
      expect(config.oidcSettings).toBeUndefined();
      expect(config.oidcProblem).toContain("DEVELOPER_OIDC_REQUIRED_VALUES must be a JSON array of strings");
    }
    expect(developerIdentityConfigFromEnvironment({ ...oidc, DEVELOPER_OIDC_REQUIRED_CLAIM: "groups", DEVELOPER_OIDC_REQUIRED_VALUES: "[\"engineering\"]" }).oidcProblem).toBeUndefined();
  });

  it("keeps everything else working when the company sign-in settings are broken", async () => {
    const config = developerIdentityConfigFromEnvironment({ ...base, DEVELOPER_SIGNIN_SLACK: "enabled", SLACK_TEAM_ID: TEAM, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_CLIENT_ID: "c", DEVELOPER_OIDC_REQUIRED_VALUES: "[\"engineering\"]", DEVELOPER_OIDC_DISPLAY_NAME: "Okta" });
    const h = identityHarness({ slackUsers: [maya], oidc: {}, channels: { C0PAY0001: ["U0MAYA001"] } });
    h.deps.providers.oidc = unconfiguredProvider("oidc", config.oidcProblem!);
    expect((await h.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"))).statusCode).toBe(200);
    expect((await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"))).statusCode).toBe(200);
    const slack = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    expect(slack.status).toBe(200);
    expect((await h.refresh(String(slack.body.refresh_token))).status).toBe(200);
    expect(await h.handler({ kind: "channel-members", slackUserId: "U0MAYA001", channelIds: ["C0PAY0001"] })).toEqual({ ok: true, memberOf: ["C0PAY0001"] });
    const company = await h.signIn("oidc", "nobody");
    expect(`${company.origin}${company.pathname}`).toBe(CLI_REDIRECT);
    expect(company.searchParams.get("error")).toBe("access_denied");
    expect(company.searchParams.get("error_description")).toContain("not finished");
    expect(company.searchParams.get("error_description")).toContain("DEVELOPER_OIDC_REQUIRED_CLAIM");
  });

  it("parses the Slack secret with or without the sign-in keys, and never echoes it", () => {
    expect(parseSlackSignInSecret(JSON.stringify({ signingSecret: "s", botToken: BOT_TOKEN }))).toEqual({ botToken: BOT_TOKEN });
    expect(parseSlackSignInSecret(JSON.stringify({ botToken: BOT_TOKEN, clientId: "1.2", clientSecret: SLACK_CLIENT_SECRET }))).toEqual({ botToken: BOT_TOKEN, clientId: "1.2", clientSecret: SLACK_CLIENT_SECRET });
    expect(() => parseSlackSignInSecret(JSON.stringify({ botToken: "unset", clientSecret: SLACK_CLIENT_SECRET }))).toThrow(/^the Slack secret has no bot token yet/);
    expect(() => parseSlackSignInSecret(JSON.stringify({ botToken: "unset" }))).toThrow(ProviderNotConfiguredError);
    for (const broken of [`{"botToken":"${BOT_TOKEN}", "clientSecret":"${SLACK_CLIENT_SECRET}"`, ""]) {
      let message = "";
      try {
        parseSlackSignInSecret(broken);
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderNotConfiguredError);
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(BOT_TOKEN);
      expect(message).not.toContain(SLACK_CLIENT_SECRET);
    }
  });

  it("parses the company secret, and never echoes it", () => {
    expect(parseOidcClientSecret(JSON.stringify({ clientSecret: OIDC_CLIENT_SECRET }))).toBe(OIDC_CLIENT_SECRET);
    for (const broken of [JSON.stringify({ clientSecret: "" }), `{"clientSecret":"${OIDC_CLIENT_SECRET}"`]) {
      expect(() => parseOidcClientSecret(broken)).toThrow(ProviderNotConfiguredError);
      try {
        parseOidcClientSecret(broken);
      } catch (error) {
        expect((error as Error).message).not.toContain(OIDC_CLIENT_SECRET);
      }
    }
  });

  it("creates one remote key set per URI, so jose's cache and cooldown apply", () => {
    const created: string[] = [];
    const jwksFor = remoteJwksCache((url) => {
      created.push(url.href);
      return () => Promise.reject(new Error("unused"));
    });
    const first = jwksFor("https://idp.example.test/jwks");
    expect(jwksFor("https://idp.example.test/jwks")).toBe(first);
    expect(jwksFor("https://slack.com/openid/connect/keys")).not.toBe(first);
    expect(created).toEqual(["https://idp.example.test/jwks", "https://slack.com/openid/connect/keys"]);
  });
});
