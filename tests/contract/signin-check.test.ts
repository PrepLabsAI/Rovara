import { describe, expect, it } from "vitest";
import { checkDeveloperSignIn, checkLines } from "../../packages/cli/src/signin/check.js";
import { writeSignInSettings, writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { HOLDER, fakeSlackApi, memoryInitSecrets, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const API = "https://abc.execute-api.us-east-1.amazonaws.com";
const CALLBACK = `${API}/v1/auth/callback/slack`;
const redirectTo = (location: string) => new Response("", { status: 302, headers: { location } });
const CLIENT_SECRET = "fedcba9876543210fedcba9876543210";
const scopes = ["channels:read", "groups:read", "im:write", "users:read", "users:read.email"];

function fetchFor(options: { methods?: { slack: boolean; oidc: null | { displayName: string } }; issuer?: string; slackAuthorize?: Response; discovery?: boolean }): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const fetchFn = async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    urls.push(url.href);
    if (url.href === `${API}/v1/auth/.well-known/agentx-configuration`) {
      return Response.json({ env: "staging", apiVersion: "1.0", issuer: options.issuer ?? `${API}/v1/auth`, authorizationEndpoint: `${API}/v1/auth/authorize`, tokenEndpoint: `${API}/v1/auth/token`, revocationEndpoint: `${API}/v1/auth/revoke`, clientId: "agentx-cli", methods: options.methods ?? { slack: true, oidc: null } });
    }
    if (url.origin + url.pathname === "https://slack.com/openid/connect/authorize") return options.slackAuthorize ?? redirectTo(`${CALLBACK}?code=abc&state=agentx-signin-check`);
    if (url.href === "https://acme.okta.com/.well-known/openid-configuration" && options.discovery !== false) {
      return Response.json({ issuer: "https://acme.okta.com", authorization_endpoint: "https://acme.okta.com/authorize", token_endpoint: "https://acme.okta.com/token", jwks_uri: "https://acme.okta.com/keys" });
    }
    throw new TypeError("fetch failed");
  };
  return Object.assign(fetchFn, { urls });
}

async function setup(slackSecret: Record<string, string>, extra: { oidc?: boolean; teamId?: string } = {}) {
  const store = new MemoryParameterStore();
  await writeSignInSettings(store, {
    schemaVersion: 1, env: "staging", slack: true, updatedAt: "2026-09-27T00:00:00.000Z", updatedBy: HOLDER,
    ...(extra.oidc ? { oidc: { issuer: "https://acme.okta.com", clientId: "0oa1", displayName: "Okta", clientSecretName: "agentx/staging/developer-oidc" } } : {}),
  });
  if (extra.teamId !== undefined) await writeSlackTeamId(store, "staging", extra.teamId);
  const secrets = memoryInitSecrets({ "agentx/staging/slack": JSON.stringify(slackSecret), ...(extra.oidc ? { "agentx/staging/developer-oidc": JSON.stringify({ clientSecret: "x" }) } : {}) });
  return { store, secrets };
}

const api = (granted = scopes) => fakeSlackApi({ authTest: async () => ({ ok: true, team_id: "T0TEAM", user_id: "U0BOT", bot_id: "B0BOT", scopes: granted }) });
const complete = { signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222", clientSecret: CLIENT_SECRET };

describe("agentx signin check (FR-046, R5)", () => {
  it("passes every check for a complete Slack setup", async () => {
    const { store, secrets } = await setup(complete, { teamId: "T0TEAM" });
    const fetchFn = fetchFor({});
    const checks = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, fetch: fetchFn, slackApi: api() });
    expect(checks.map((check) => [check.name, check.ok])).toEqual([
      ["settings", true], ["control plane", true], ["Slack app credentials", true], ["Slack team ID", true], ["Slack bot scopes", true], ["Slack redirect URL", true],
    ]);
    const text = checkLines(checks).join("\n");
    for (const secret of [CLIENT_SECRET, TEST_BOT_TOKEN, TEST_SIGNING_SECRET]) expect(text).not.toContain(secret);
    // The test authorize request carries the client ID and the callback, never the client secret.
    const authorize = fetchFn.urls.find((url) => url.startsWith("https://slack.com/openid/connect/authorize"));
    expect(authorize).toContain("client_id=1111.2222");
    expect(authorize).toContain(`redirect_uri=${encodeURIComponent(`${API}/v1/auth/callback/slack`)}`);
    for (const url of fetchFn.urls) expect(url).not.toContain(CLIENT_SECRET);
  });

  it("names each missing piece with what to do", async () => {
    // A client ID without its secret: the credentials check fails, and the redirect check still runs.
    const { store, secrets } = await setup({ signingSecret: TEST_SIGNING_SECRET, botToken: TEST_BOT_TOKEN, clientId: "1111.2222" });
    const checks = await checkDeveloperSignIn({
      env: "staging", store, secrets, settings: stagingSettings, slackApi: api(["users:read"]),
      fetch: fetchFor({ methods: { slack: false, oidc: null }, slackAuthorize: new Response("<p>redirect_uri did not match any configured URIs</p>", { status: 200 }) }),
    });
    expect(Object.fromEntries(checks.map((check) => [check.name, check.detail]))).toEqual({
      settings: "Slack sign-in on, company sign-in off",
      "control plane": "the control plane does not offer Slack sign-in, but the settings say it is on; run agentx signin enable slack again",
      "Slack app credentials": "the Slack app's client ID and client secret are not stored in agentx/staging/slack; run agentx signin enable slack",
      "Slack team ID": "no team ID is recorded at /agentx/staging/slack/teamId; run agentx signin enable slack",
      "Slack bot scopes": "the app is missing channels:read, groups:read, im:write, users:read.email; add them on OAuth & Permissions and reinstall the app",
      "Slack redirect URL": "Slack does not list https://abc.execute-api.us-east-1.amazonaws.com/v1/auth/callback/slack as a redirect URL; add it on OAuth & Permissions",
    });
    expect(checks.every((check, index) => index === 0 || !check.ok)).toBe(true);
  });

  async function redirectCheckFor(slackAuthorize: Response | undefined, fetchOverride?: typeof fetch) {
    const { store, secrets } = await setup(complete, { teamId: "T0TEAM" });
    const checks = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, slackApi: api(), fetch: fetchOverride ?? fetchFor(slackAuthorize === undefined ? {} : { slackAuthorize }) });
    return checks.find((check) => check.name === "Slack redirect URL");
  }
  const unverified = (why: string) => ({ name: "Slack redirect URL", ok: true, warn: true, detail: `not verified: ${why}, so it does not show whether ${CALLBACK} is a redirect URL; run agentx login ${API} to confirm` });

  it("counts a redirect back to the callback as registered, even with an error that is not about redirect_uri (fix round 1, I2)", async () => {
    expect(await redirectCheckFor(redirectTo(`${CALLBACK}?error=access_denied&state=agentx-signin-check`))).toEqual({ name: "Slack redirect URL", ok: true, detail: `Slack sent a test sign-in request back to ${CALLBACK}, so it is a registered redirect URL` });
  });

  it("counts an error about redirect_uri as not registered, on a redirect or on Slack's error page", async () => {
    const no = { name: "Slack redirect URL", ok: false, detail: `Slack does not list ${CALLBACK} as a redirect URL; add it on OAuth & Permissions` };
    expect(await redirectCheckFor(redirectTo(`${CALLBACK}?error=invalid_redirect_uri`))).toEqual(no);
    expect(await redirectCheckFor(new Response("<h1>Something went wrong</h1><p>bad_redirect_uri</p>", { status: 400 }))).toEqual(no);
  });

  it("warns, without failing, when Slack's answer does not settle the redirect URL", async () => {
    expect(await redirectCheckFor(redirectTo("https://acme.slack.com/signin?redir=%2Fopenid%2Fconnect%2Fauthorize"))).toEqual(unverified("Slack sent the test sign-in request to https://acme.slack.com/signin"));
    expect(await redirectCheckFor(new Response("<html>Sign in to your workspace</html>", { status: 200 }))).toEqual(unverified("Slack answered the test sign-in request with HTTP 200"));
    // "invalid" alone, without a redirect_uri error, says nothing about the redirect URL.
    expect(await redirectCheckFor(new Response("<p>redirect_uri ok, invalid team</p>", { status: 400 }))).toEqual(unverified("Slack answered the test sign-in request with HTTP 400"));
    expect(await redirectCheckFor(undefined, async () => { throw new TypeError("fetch failed"); })).toMatchObject({ name: "Slack redirect URL", ok: true, warn: true });
  });

  it("prints a warning as warn, not ok or FAIL", () => {
    expect(checkLines([{ name: "Slack redirect URL", ok: true, warn: true, detail: "not verified" }])).toEqual(["warn  Slack redirect URL: not verified"]);
  });

  it("compares the control plane's issuer with <ApiEndpoint>/v1/auth, the DeveloperSignInIssuer value (F22)", async () => {
    const { store, secrets } = await setup(complete, { teamId: "T0TEAM" });
    const checks = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, slackApi: api(), fetch: fetchFor({ issuer: "https://other.example.test/v1/auth" }) });
    expect(checks.find((check) => check.name === "control plane")).toEqual({
      name: "control plane", ok: false,
      detail: `the control plane names issuer https://other.example.test/v1/auth, not ${API}/v1/auth; check that this environment's settings name its own control plane (agentx env adopt or agentx init)`,
    });
  });

  it("checks the company issuer and secret when company sign-in is on", async () => {
    const { store, secrets } = await setup(complete, { teamId: "T0TEAM", oidc: true });
    const down = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, slackApi: api(), fetch: fetchFor({ methods: { slack: true, oidc: { displayName: "Okta" } }, discovery: false }) });
    const discovery = down.find((check) => check.name === "company sign-in discovery");
    expect(discovery?.ok).toBe(false);
    expect(discovery?.detail).toBe("could not read https://acme.okta.com/.well-known/openid-configuration; check the issuer URL and that this computer can reach it");
    expect(down.find((check) => check.name === "company sign-in secret")?.ok).toBe(true);
  });

  it("says sign-in is not set up when there are no settings", async () => {
    const checks = await checkDeveloperSignIn({ env: "staging", store: new MemoryParameterStore(), secrets: memoryInitSecrets(), settings: stagingSettings, slackApi: api(), fetch: fetchFor({}) });
    expect(checks).toEqual([{ name: "settings", ok: false, detail: "developer sign-in is not set up; run agentx signin enable slack (or oidc)" }]);
  });
});
