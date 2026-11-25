import { describe, expect, it } from "vitest";
import { developerIdentityConfigFromEnvironment, taskPublicKeysFromEnvironment, parseOidcClientSecret, parseSlackSignInSecret, unconfiguredProvider } from "../../packages/broker/src/aws/developer-identity.js";
import { CHANNEL_MEMBERS_MAX_CHANNELS, TaskPeopleDisplayReadRequestSchema, TaskPeopleDisplayReadResponseSchema, TaskPersonProofRequestSchema, TaskPersonProofResponseSchema } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { ProviderNotConfiguredError } from "../../packages/broker/src/developer/providers.js";
import type { HttpResult } from "../../packages/broker/src/developer/server.js";
import { kmsTokenSigner } from "../../packages/broker/src/developer/tokens.js";
import { BOT_TOKEN, CLI_REDIRECT, ISSUER, OIDC_CLIENT_SECRET, OIDC_ISSUER, SLACK_CLIENT_SECRET, TEAM, fakeKms, authorizeQuery, httpEvent, identityHarness, type FakeSlackUser } from "../support/developer-fakes.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const mayaId = ownerKeyForSubject("https://slack.com", "U0MAYA001");
const json = (body: string) => JSON.parse(body) as Record<string, unknown>;
const KEY_ARN = "arn:aws:kms:us-east-1:123456789012:key/0000aaaa-planted-key-arn";

describe("discovery (FR-001, FR-048)", () => {

  it("reports the environment, API version and the methods that can actually be used", async () => {
    const both = identityHarness({ oidc: {} });
    expect(json((await both.http(httpEvent("GET", "/v1/auth/.well-known/agentx-configuration"))).body)).toEqual({
      env: "staging", apiVersion: "1.4", adminApiVersion: "1.1", issuer: ISSUER, authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`,
      revocationEndpoint: `${ISSUER}/revoke`, clientId: "agentx-cli", methods: { slack: true, oidc: { displayName: "Okta" } },
      confirm: { elicitation: true, slack: true },
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
      expect(response.body).toContain("Start signing in again");
      expect(response.body).not.toMatch(/AgentX|\bCLI\b|terminal|agentx login/);
    }
  });

  it("uses customer wording when browser sign-in has no enabled method", async () => {
    const h = identityHarness({ teamId: undefined });
    const response = await h.http(httpEvent("GET", "/v1/auth/browser/authorize?return_to=" + encodeURIComponent("/review/11111111-1111-4111-8111-111111111111/task")));
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("Rovara administrator");
    expect(response.body).not.toMatch(/AgentX|\bCLI\b|terminal|agentx login/);
  });

  it("sends a bad PKCE or response type back to the CLI as invalid_request", async () => {
    const h = identityHarness();
    for (const query of [{ code_challenge_method: "plain" }, { code_challenge: "short" }, { response_type: "token" }, { state: "" }]) {
      const location = new URL((await h.http(httpEvent("GET", authorizeQuery(query)))).headers.location!);
      expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
    }
  });

  it("tells the CLI when no method is enabled", async () => {
    const h = identityHarness({ slack: false });
    const location = new URL((await h.http(httpEvent("GET", authorizeQuery()))).headers.location!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toContain("Rovara administrator");
    expect(location.searchParams.get("error_description")).not.toMatch(/AgentX|agentx signin|\bCLI\b/);
  });

});

describe("browser sign-in for an AgentX feedback review", () => {
  const reviewPath = "/review/11111111-1111-4111-8111-111111111111";

  it("accepts only a local review return path and does not accept forwarded URLs", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const good = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(reviewPath)}`));
    expect(good.statusCode).toBe(302);
    expect(new URL(good.headers.location!).origin).toBe("https://slack.com");
    expect(good.cookies?.some(cookie => cookie.includes("__Host-agentx_review_pkce="))).toBe(true);
    // Task 18: the read-only task page signs in the same way.
    const taskPage = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(`${reviewPath}/task`)}`));
    expect(taskPage.statusCode).toBe(302);
    expect(new URL(taskPage.headers.location!).origin).toBe("https://slack.com");
    // The link to one document, and the older version it came from, survives sign-in; nothing else in a query does.
    for (const query of ["?doc=coding-plan&from=2", "?doc=requirements", "?doc=design&from=999"]) {
      const kept = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(`${reviewPath}/task${query}`)}`));
      expect(kept.statusCode).toBe(302);
    }
    for (const returnTo of ["https://evil.test/review/a", "//evil.test/review/a", "/v1/admin", "/review/../v1/admin", `${reviewPath}/task/../x`, `${reviewPath}/tasks`,
      `${reviewPath}/task?doc=other`, `${reviewPath}/task?from=2`, `${reviewPath}/task?doc=design&from=0`, `${reviewPath}/task?doc=design&from=1000`, `${reviewPath}/task?doc=design&from=2&x=1`,
      `${reviewPath}/task?x=1&doc=design`, `${reviewPath}/task?doc=design#top`, `${reviewPath}?doc=design`, `${reviewPath}/task?`]) {
      const refused = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(returnTo)}`));
      expect(refused.statusCode).toBe(400);
      expect(refused.headers.location).toBeUndefined();
    }
  });

  it("sets an opaque secure 30-day session cookie only after state and PKCE-bound Slack sign-in", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(reviewPath)}`));
    const providerUrl = new URL(start.headers.location!);
    const callback = h.slack.approve(start.headers.location!, maya.userId);
    const callbackEvent = httpEvent("GET", callback);
    callbackEvent.headers = { cookie: start.cookies!.find(cookie => cookie.startsWith("__Host-agentx_review_pkce="))!.split(";", 1)[0] };
    const result = await h.http(callbackEvent);
    expect(result.statusCode).toBe(302);
    expect(result.headers.location).toBe(reviewPath);
    expect(providerUrl.searchParams.get("state")).not.toBeNull();
    expect(result.cookies).toHaveLength(2);
    expect(result.cookies?.find(cookie => cookie.startsWith("__Host-agentx_review_session="))).toMatch(/__Host-agentx_review_session=[0-9a-f-]{36}; Secure; HttpOnly; SameSite=Lax; Path=\/; Max-Age=2592000/);
    expect(result.cookies?.find(cookie => cookie.startsWith("__Host-agentx_review_pkce="))).toContain("Max-Age=0");
    expect(result.headers.location).not.toContain("code=");
    const sessionCookie = result.cookies?.find(cookie => cookie.startsWith("__Host-agentx_review_session="));
    if (sessionCookie === undefined) throw new Error("browser review session cookie is required");
    const sessionId = sessionCookie.split("=", 2)[1]!.split(";", 1)[0]!;
    const signedInAt = Math.floor(h.now() / 1000);
    // A fixed 30 days from sign-in, with the stored record's clean-up time kept in step with it.
    expect(h.db.get(`SESSION#${sessionId}`, "META")).toMatchObject({ developerId: mayaId, amr: "slack", reviewExpiresAt: signedInAt + 30 * 86_400, endsAt: signedInAt + 30 * 86_400, expiresAt: signedInAt + 31 * 86_400 });
    expect(h.logs.some(line => JSON.stringify(line).includes(sessionId))).toBe(false);
  });

  it("refuses the callback if its browser PKCE verifier is missing or incorrect", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", `/v1/auth/browser/authorize?return_to=${encodeURIComponent(reviewPath)}`));
    const callback = h.slack.approve(start.headers.location!, maya.userId);
    const refused = await h.http(httpEvent("GET", callback));
    expect(refused.statusCode).toBe(400);
    expect((refused.cookies ?? []).some(cookie => cookie.startsWith("__Host-agentx_review_session="))).toBe(false);
    expect(h.db.get(`DEVELOPER#${mayaId}`, "META")).toBeUndefined();
  });
});

describe("Sign in with Slack end to end (US4 scenario 1, FR-003, FR-005, FR-008)", () => {

  it("refuses another Slack team: no code, no developer record, the reason goes to the CLI (US4 scenario 2, SC-007)", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const back = await h.signIn("slack", maya.userId, { teamId: "T0OTHER1" });
    expect(back.searchParams.get("code")).toBeNull();
    expect(back.searchParams.get("error")).toBe("access_denied");
    // The hint matters: a provider that silently reuses the refused account's session refuses again.
    expect(back.searchParams.get("error_description")).toBe(`you signed in to Slack workspace T0OTHER1, but this Rovara serves ${TEAM}. If you signed in with the wrong account, sign out of Slack or use a private window, then try again.`);
    expect(h.db.get(`DEVELOPER#${mayaId}`, "META")).toBeUndefined();
    expect(h.logs).toContainEqual({ event: "signin.refused", method: "slack", reason: `you signed in to Slack workspace T0OTHER1, but this AgentX serves ${TEAM}` });
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

  it("refuses revocation from another client", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const { body } = await h.exchange((await h.signIn("slack", maya.userId)).searchParams.get("code")!);
    const response = await h.http(httpEvent("POST", "/v1/auth/revoke", { token: String(body.refresh_token), client_id: "other" }));
    expect(response.statusCode).toBe(401);
    expect(json(response.body).error).toBe("invalid_client");
    expect((await h.refresh(String(body.refresh_token))).status).toBe(200);
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

});

describe("the Lambda's configuration", () => {
  const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: ISSUER };

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
    expect(company.searchParams.get("error_description")).toContain("Rovara administrator");
    expect(h.logs.some((entry) => typeof entry.detail === "string" && entry.detail.includes("DEVELOPER_OIDC_REQUIRED_CLAIM"))).toBe(true);
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

});

describe("task person proof invoke contract", () => {
  it("accepts only the strict bounded request and validates either exact response shape", async () => {
    const h = identityHarness({ slackUsers: [maya], channels: { C0PAY0001: [maya.userId] } });
    const request = { kind: "task-person-proof" as const, slackUserId: maya.userId, channelIds: ["C0PAY0001"] };
    expect(TaskPersonProofRequestSchema.parse(request)).toEqual(request);
    expect(TaskPersonProofResponseSchema.parse(await h.handler(request))).toEqual({
      ok: true,
      user: { id: maya.userId, teamId: TEAM, name: maya.name },
      memberOf: ["C0PAY0001"],
    });
    for (const invalid of [
      { ...request, extra: true },
      { ...request, slackUserId: "not-a-user" },
      { ...request, channelIds: Array.from({ length: CHANNEL_MEMBERS_MAX_CHANNELS + 1 }, (_, index) => `C0CH${String(index).padStart(5, "0")}`) },
    ]) expect(TaskPersonProofRequestSchema.safeParse(invalid).success).toBe(false);
    expect(TaskPersonProofResponseSchema.safeParse({ ok: true, user: { id: maya.userId, teamId: TEAM, name: maya.name }, memberOf: ["C0OTHER01"] }).success).toBe(true);
    expect(await h.handler({ ...request, extra: true } as never)).toEqual({ ok: false, error: "invalid_request" });
  });
});

describe("task People metered display invoke contract", () => {
  it("returns strict actual Slack usage and rejects an old unmetered shape", async () => {
    const h = identityHarness({ slackUsers: [maya], channels: { C0PAY0001: [maya.userId] } });
    const request = { kind: "task-people-display-read" as const, operation: "directory" as const,
      admission: { version: 1 as const, deadlineAt: h.now() + 20_000, slackCallsLimit: 2 },
      request: { kind: "task-channel-people" as const, channelIds: ["C0PAY0001"] },
      remainingNewIdentities: 100, knownNativeSlackUserIds: [] };
    expect(TaskPeopleDisplayReadRequestSchema.parse(request)).toEqual(request);
    expect(TaskPeopleDisplayReadResponseSchema.parse(await h.handler(request))).toMatchObject({
      operation: "directory", admission: { version: 1, slackCallsUsed: 2 }, result: { ok: true, users: [{ id: maya.userId }] },
    });
    expect(await h.handler({ ...request, admission: undefined } as never)).toEqual({ ok: false, error: "invalid_request" });
  });
});


describe("task public key publication", () => {

  it("publishes distinct developer and task purposes using the configured KMS key", async () => {
    const h = identityHarness();
    const kms = fakeKms();
    h.deps.extraPublicKeys = taskPublicKeysFromEnvironment({ TASK_TOKEN_KEY_ARN: KEY_ARN }, kms);
    const extra = await h.deps.extraPublicKeys[0]!.publicJwk();
    const developer = await h.signer.publicJwk();
    expect(extra.kid).not.toBe(developer.kid);
    const response = await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ keys: [
      { ...developer, rovara_purpose: "developer" }, { ...extra, rovara_purpose: "task" },
    ] }));
    expect(kms.calls).toEqual([{ name: "GetPublicKeyCommand", input: { KeyId: KEY_ARN } }]);
    expect(response.body).not.toContain(KEY_ARN);
    expect(h.logs).toEqual([]);
  });

  it("omits a failed task key and logs fixed words without taking down developer sign-in", async () => {
    const h = identityHarness();
    const secret = "planted-task-key-failure-secret";
    h.deps.extraPublicKeys = taskPublicKeysFromEnvironment({ TASK_TOKEN_KEY_ARN: KEY_ARN }, {
      send: () => Promise.reject(new Error(secret)),
    });
    const response = await h.http(httpEvent("GET", "/v1/auth/.well-known/jwks.json"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(JSON.stringify({ keys: [{ ...await h.signer.publicJwk(), rovara_purpose: "developer" }] }));
    expect(h.logs).toEqual([{ event: "developer.jwks_task_key_failed" }]);
    expect(JSON.stringify([response, h.logs])).not.toContain(secret);
    expect(JSON.stringify([response, h.logs])).not.toContain(KEY_ARN);
  });
});
