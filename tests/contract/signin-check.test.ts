import { describe, expect, it } from "vitest";
import { checkDeveloperSignIn, checkLines } from "../../packages/cli/src/signin/check.js";
import { writeSignInSettings, writeSlackTeamId } from "../../packages/cli/src/signin/settings.js";
import { stagingSettings } from "../support/environment-fixtures.js";
import { HOLDER, fakeSlackApi, memoryInitSecrets, TEST_BOT_TOKEN, TEST_SIGNING_SECRET } from "../support/init-fakes.js";
import { MemoryParameterStore } from "../support/memory-parameter-store.js";

const API = "https://abc.execute-api.us-east-1.amazonaws.com";
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
    if (url.origin + url.pathname === "https://slack.com/openid/connect/authorize") return options.slackAuthorize ?? new Response("", { status: 302, headers: { location: "https://acme.slack.com/signin" } });
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

  it("says plainly when Slack's answer to the test request does not settle the redirect URL", async () => {
    const { store, secrets } = await setup(complete, { teamId: "T0TEAM" });
    const checks = await checkDeveloperSignIn({ env: "staging", store, secrets, settings: stagingSettings, slackApi: api(), fetch: fetchFor({ slackAuthorize: new Response("busy", { status: 503 }) }) });
    const redirect = checks.find((check) => check.name === "Slack redirect URL");
    expect(redirect?.ok).toBe(false);
    expect(redirect?.detail).toBe(`could not tell from Slack's answer to a test sign-in request (HTTP 503) whether ${API}/v1/auth/callback/slack is a redirect URL; check that OAuth & Permissions lists it, then try agentx login ${API}`);
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
    expect(discovery?.detail).toContain("could not read https://acme.okta.com/.well-known/openid-configuration");
    expect(down.find((check) => check.name === "company sign-in secret")?.ok).toBe(true);
  });

  it("says sign-in is not set up when there are no settings", async () => {
    const checks = await checkDeveloperSignIn({ env: "staging", store: new MemoryParameterStore(), secrets: memoryInitSecrets(), settings: stagingSettings, slackApi: api(), fetch: fetchFor({}) });
    expect(checks).toEqual([{ name: "settings", ok: false, detail: "developer sign-in is not set up; run agentx signin enable slack (or oidc)" }]);
  });
});
