// Spec 063 phase 063b (FR-002, FR-003, FR-005): a registered service signs Rovara users in. Its codes and refresh
// tokens are bound to it, its tokens carry its own audience (so Rovara's API refuses them), and a confidential one
// needs its secret. A company sign-in with the administrator claim is recorded on the session; Slack never is.
import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { DEVELOPER_TOKEN_AUDIENCE } from "@rovara-code/contracts";
import { developerIdentityConfigFromEnvironment } from "../../packages/core/src/aws/developer-identity.js";
import { developerTokenVerifier } from "../../packages/core/src/developer/verify-token.js";
import { ownerKeyForSubject } from "../../packages/core/src/aws/lambda.js";
import { CHALLENGE, ISSUER, OIDC_ISSUER, VERIFIER, httpEvent, identityHarness, type FakeOidcUser, type FakeSlackUser } from "../support/developer-fakes.js";

const WEB = "https://scheduler.example.com/callback";
const LOOPBACK = "http://127.0.0.1:50123/callback";
const SECRET = "scheduler-secret-0123456789abcdefghijklmnop";
const ada: FakeOidcUser = { sub: "ada", name: "Ada", email: "ada@example.com", email_verified: true, groups: ["agentx-admin"] };
const bo: FakeOidcUser = { sub: "bo", name: "Bo", email: "bo@example.com", email_verified: true, groups: ["engineering"] };
const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };

function harness(options: { confidential?: boolean; loopback?: boolean } = {}) {
  const h = identityHarness({ slack: true, oidc: { administrator: { claim: "groups", values: ["agentx-admin"] } }, oidcUsers: [ada, bo], slackUsers: [maya] });
  const register = (clientId = "scheduler", audience = "scheduler") => h.deps.store.putClient({
    clientId, name: "Scheduler", audience, redirectUris: [WEB], loopback: options.loopback ?? true,
    ...(options.confidential === true ? { secretHash: createHash("sha256").update(SECRET).digest("hex") } : {}),
    createdAt: new Date(h.now()).toISOString(), updatedAt: new Date(h.now()).toISOString(), updatedBy: "admin",
  });
  const signIn = (method: "slack" | "oidc", who: string, redirect = WEB, clientId = "scheduler") =>
    h.signIn(method, who, { query: { client_id: clientId, redirect_uri: redirect } });
  const form = async (path: string, body: Record<string, string>, authorization?: string) => {
    const event = httpEvent("POST", path, body);
    const response = await h.http(authorization === undefined ? event : { ...event, headers: { ...event.headers, authorization } });
    return { status: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
  };
  const exchange = (code: string, extra: Record<string, string> = {}, authorization?: string) =>
    form("/v1/auth/token", { grant_type: "authorization_code", client_id: "scheduler", code, code_verifier: VERIFIER, redirect_uri: WEB, ...extra }, authorization);
  const refresh = (refreshToken: string, extra: Record<string, string> = {}) => form("/v1/auth/token", { grant_type: "refresh_token", client_id: "scheduler", refresh_token: refreshToken, ...extra });
  return { h, register, signIn, exchange, refresh, form };
}
const codeOf = (url: URL) => url.searchParams.get("code") ?? `no code: ${url.toString()}`;
const sessions = (h: ReturnType<typeof identityHarness>) => h.db.find((item) => item.entityType === "SESSION");

describe("a registered client's sign-in (FR-002)", () => {
  it("returns to its exact redirect URL with a code that only it can redeem, for tokens addressed to it", async () => {
    const { h, register, signIn, exchange } = harness();
    await register();
    const back = await signIn("oidc", "bo");
    expect(back.origin + back.pathname).toBe(WEB);
    expect(back.searchParams.get("state")).toBe("cli-state");
    const answer = await exchange(codeOf(back));
    expect(answer.status).toBe(200);
    const claims = decodeJwt(answer.body.access_token as string);
    expect(claims).toMatchObject({ iss: ISSUER, aud: "scheduler", azp: "scheduler", amr: "oidc" });
    expect(sessions(h)).toEqual([expect.objectContaining({ clientId: "scheduler" })]);
  });

  it("refuses an unregistered client, a redirect it did not register, and loopback when it may not use it", async () => {
    const { h, register } = harness({ loopback: false });
    await register();
    const authorize = (query: Record<string, string>) => h.http(httpEvent("GET", `/v1/auth/authorize?${new URLSearchParams({
      response_type: "code", client_id: "scheduler", redirect_uri: WEB, code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s", ...query,
    }).toString()}`));
    for (const query of [{ client_id: "dashboard" }, { redirect_uri: "https://scheduler.example.com/other" }, { redirect_uri: `${WEB}?x=1` }, { redirect_uri: LOOPBACK }, { client_id: "Not-An-Id" }]) {
      const response = await authorize(query);
      expect(response.statusCode, JSON.stringify(query)).toBe(400);
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("allows a loopback redirect for a client registered with one, as agentx login uses", async () => {
    const { register, signIn, exchange } = harness();
    await register();
    const back = await signIn("slack", "U0MAYA001", LOOPBACK);
    expect(back.origin + back.pathname).toBe(LOOPBACK);
    expect((await exchange(codeOf(back), { redirect_uri: LOOPBACK })).status).toBe(200);
  });

  it("never lets the CLI redeem a client's code, or a client redeem the CLI's", async () => {
    const { h, register, signIn, exchange } = harness();
    await register();
    const clientCode = codeOf(await signIn("oidc", "bo"));
    expect((await exchange(clientCode, { client_id: "agentx-cli" })).status).toBe(400);
    // The code was burned by that try, so the client cannot redeem it either.
    expect((await exchange(clientCode)).status).toBe(400);

    const cliCode = codeOf(await h.signIn("oidc", "bo"));
    expect((await exchange(cliCode, { redirect_uri: "http://127.0.0.1:49152/callback" })).status).toBe(400);
  });

  it("binds the refresh token to the client, and ends it when the client is removed or registered again", async () => {
    const { h, register, signIn, exchange, refresh } = harness();
    await register();
    const first = await exchange(codeOf(await signIn("oidc", "bo")));
    const refreshToken = first.body.refresh_token as string;
    expect((await h.refresh(refreshToken)).status).toBe(400);
    const again = await refresh(refreshToken);
    expect(again.status).toBe(200);
    expect(decodeJwt(again.body.access_token as string).aud).toBe("scheduler");

    await h.deps.store.removeClient("scheduler");
    expect((await refresh(again.body.refresh_token as string)).body).toMatchObject({ error: "invalid_client" });
    h.tick(1_000);
    await register();
    expect((await refresh(again.body.refresh_token as string)).body).toMatchObject({ error: "invalid_grant" });
    expect(sessions(h)).toEqual([expect.objectContaining({ revokedReason: "client_removed" })]);
  });
});

describe("a confidential client (FR-002)", () => {
  it("needs its secret, by form or HTTP Basic, to redeem a code and to refresh", async () => {
    const { register, signIn, exchange, refresh } = harness({ confidential: true });
    await register();
    const noSecret = await exchange(codeOf(await signIn("oidc", "bo")));
    expect(noSecret).toMatchObject({ status: 401, body: { error: "invalid_client" } });
    expect((await exchange(codeOf(await signIn("oidc", "bo")), { client_secret: "wrong" })).status).toBe(401);

    const viaForm = await exchange(codeOf(await signIn("oidc", "bo")), { client_secret: SECRET });
    expect(viaForm.status).toBe(200);
    const basic = `Basic ${Buffer.from(`scheduler:${SECRET}`).toString("base64")}`;
    const viaBasic = await exchange(codeOf(await signIn("oidc", "bo")), {}, basic);
    expect(viaBasic.status).toBe(200);

    expect((await refresh(viaForm.body.refresh_token as string)).status).toBe(401);
    expect((await refresh(viaForm.body.refresh_token as string, { client_secret: SECRET })).status).toBe(200);
  });

  it("revokes only its own sessions", async () => {
    const { h, register, signIn, exchange, form } = harness({ confidential: true });
    await register();
    const mine = await exchange(codeOf(await signIn("oidc", "bo")), { client_secret: SECRET });
    const cli = await h.exchange(codeOf(await h.signIn("oidc", "bo")));
    expect((await form("/v1/auth/revoke", { client_id: "scheduler", token: cli.body.refresh_token as string, client_secret: SECRET })).status).toBe(200);
    expect((await h.refresh(cli.body.refresh_token as string)).status).toBe(200);
    expect((await form("/v1/auth/revoke", { client_id: "scheduler", token: mine.body.refresh_token as string })).status).toBe(401);
    expect((await form("/v1/auth/revoke", { client_id: "scheduler", token: mine.body.refresh_token as string, client_secret: SECRET })).status).toBe(200);
    expect(sessions(h).filter((session) => session.clientId === "scheduler")).toEqual([expect.objectContaining({ revokedReason: "signed_out" })]);
  });
});

describe("Rovara refuses a client's token (FR-003)", () => {
  it("the broker's verifier accepts the CLI's token and refuses one addressed to a client", async () => {
    const { h, register, signIn, exchange } = harness();
    await register();
    const verify = developerTokenVerifier({ issuer: ISSUER, keys: async () => [await h.signer.publicJwk()], now: h.now });
    const cli = await h.exchange(codeOf(await h.signIn("oidc", "bo")));
    expect(await verify(`Bearer ${cli.body.access_token as string}`)).toMatchObject({ aud: DEVELOPER_TOKEN_AUDIENCE });
    const client = await exchange(codeOf(await signIn("oidc", "bo")));
    await expect(verify(`Bearer ${client.body.access_token as string}`)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("administrator, recorded at sign-in (FR-005)", () => {
  it("is set for a company sign-in carrying the claim, and never for one without it or for Slack", async () => {
    const { h, register, signIn, exchange } = harness();
    await register();
    await exchange(codeOf(await signIn("oidc", "ada")));
    await exchange(codeOf(await signIn("oidc", "bo")));
    await exchange(codeOf(await signIn("slack", "U0MAYA001")));
    const administrator = (developerId: string) => sessions(h).find((session) => session.developerId === developerId)?.administrator;
    expect(administrator(ownerKeyForSubject(OIDC_ISSUER, "ada"))).toBe(true);
    expect(administrator(ownerKeyForSubject(OIDC_ISSUER, "bo"))).toBeUndefined();
    expect(administrator(ownerKeyForSubject("https://slack.com", "U0MAYA001"))).toBeUndefined();
  });

  it("reads the admin client's rule only when company sign-in is the admin's own identity provider", () => {
    const base = { AGENTX_ENV: "staging", DEVELOPER_TOKEN_ISSUER: ISSUER, DEVELOPER_OIDC_ISSUER: OIDC_ISSUER, DEVELOPER_OIDC_CLIENT_ID: "c", ADMIN_CLAIM: "groups", ADMIN_VALUES: "[\"agentx-admin\"]" };
    expect(developerIdentityConfigFromEnvironment({ ...base, ADMIN_OIDC_ISSUER: `${OIDC_ISSUER}/` }).oidcSettings?.administrator).toEqual({ claim: "groups", values: ["agentx-admin"] });
    expect(developerIdentityConfigFromEnvironment({ ...base, ADMIN_OIDC_ISSUER: "https://cognito.example.test" }).oidcSettings?.administrator).toBeUndefined();
    expect(developerIdentityConfigFromEnvironment({ ...base, ADMIN_OIDC_ISSUER: OIDC_ISSUER, ADMIN_VALUES: "not json" }).oidcSettings?.administrator).toBeUndefined();
    expect(developerIdentityConfigFromEnvironment(base).oidcSettings?.administrator).toBeUndefined();
  });
});

describe("discovery", () => {
  it("names the client authentication a confidential client may use", async () => {
    const { h } = harness();
    const discovery = JSON.parse((await h.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"))).body) as Record<string, unknown>;
    expect(discovery.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_basic", "client_secret_post"]);
  });
});
