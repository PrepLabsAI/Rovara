// Guided onboarding PR 7: Linear's side of the OAuth connection (linear-oauth-client.ts), the app settings reader and wiring (linear-wiring.ts), and the per-project hook path that
// API-key projects keep (golden: the app's signing secret and a project's own hook secret never verify each other's deliveries).
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  exchangeLinearCode, linearAuthorizeUrl, linearTeamsOf, linearWorkspaceOf, LinearOAuthFailure, LINEAR_TEAMS_MAX, refreshLinearTokens, revokeLinearToken,
} from "../../packages/broker/src/aws/linear-oauth-client.js";
import { linearAppSettingsReader, linearCompanyWiring } from "../../packages/broker/src/aws/linear-wiring.js";
import { LinearAppSettingsSchema } from "../../packages/broker/src/aws/linear-connections.js";
import { handleLinearAppWebhook } from "../../packages/broker/src/aws/linear-app-webhook.js";
import { linearTracker } from "../../packages/broker/src/plugins/tracker/linear/index.js";
import { SCOPE } from "../support/ports/plugin-fake-worlds.js";
import { LINEAR_APP, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET } from "../support/fake-linear-oauth.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const token = (n: number) => ["tok", String(n), "abcdefghij"].join("_");

describe("the Linear OAuth client", () => {
  it("builds the consent address with PKCE S256 and no admin scope", () => {
    const url = new URL(linearAuthorizeUrl(LINEAR_APP, "state-value", "v".repeat(43)));
    expect(url.searchParams.get("scope")).toBe("read,write,comments:create,issues:create,app:assignable,app:mentionable");
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update("v".repeat(43)).digest("base64url"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain(LINEAR_CLIENT_SECRET);
  });
  it("exchanges a code form-encoded with the verifier, refusing redirects; only invalid_grant is 'refused'", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, init: init! }); return json({ access_token: token(1), refresh_token: token(2), expires_in: 86_399, token_type: "Bearer", scope: "read" }); });
    const tokens = await exchangeLinearCode({ fetch: fetch, app: LINEAR_APP, code: "c0de", verifier: "ver", now: NOW });
    expect(tokens).toEqual({ access: token(1), refresh: token(2), accessExpiresAt: NOW + 86_399_000, scope: "read" });
    expect(seen[0]!.url).toBe("https://api.linear.app/oauth/token");
    expect(seen[0]!.init.redirect).toBe("error");
    expect(Object.fromEntries(new URLSearchParams(seen[0]!.init.body as string))).toEqual({ grant_type: "authorization_code", code: "c0de", redirect_uri: LINEAR_APP.redirectUri, client_id: LINEAR_APP.clientId, client_secret: LINEAR_CLIENT_SECRET, code_verifier: "ver" });
    for (const [status, body, kind] of [[400, { error: "invalid_grant" }, "refused"], [400, { error: "invalid_client" }, "unavailable"], [401, { error: "invalid_client" }, "unavailable"], [500, {}, "unavailable"], [200, { access_token: token(1) }, "unavailable"]] as const) {
      const failing = vi.fn(async () => json(body, status));
      await expect(refreshLinearTokens({ fetch: failing, app: LINEAR_APP, refresh: token(2), now: NOW })).rejects.toMatchObject({ kind });
    }
    const thrown = vi.fn(async () => { throw new Error(`network down for ${token(9)}`); });
    const error = await refreshLinearTokens({ fetch: thrown, app: LINEAR_APP, refresh: token(9), now: NOW }).catch((e: unknown) => e) as LinearOAuthFailure;
    expect(error).toBeInstanceOf(LinearOAuthFailure);
    expect(error.message).not.toContain(token(9));
    const huge = vi.fn(async () => new Response("x".repeat(1_000_001)));
    await expect(refreshLinearTokens({ fetch: huge, app: LINEAR_APP, refresh: token(2), now: NOW })).rejects.toMatchObject({ kind: "unavailable" });
  });
  it("reads the workspace and the teams; a team list with more pages, or one unreadable team, is refused whole", async () => {
    const answer = (data: unknown) => vi.fn(async () => json({ data })) as unknown as typeof fetch;
    expect(await linearWorkspaceOf({ fetch: answer({ viewer: { organization: { id: "org-1", name: "Acme", urlKey: "Acme" } } }), access: token(1) })).toEqual({ id: "org-1", name: "Acme", urlKey: "acme" });
    await expect(linearWorkspaceOf({ fetch: answer({ viewer: { organization: { id: "bad id!", name: "Acme", urlKey: "acme" } } }), access: token(1) })).rejects.toBeInstanceOf(LinearOAuthFailure);
    const team = { id: "t-1", key: "ENG", name: "Engineering" };
    expect(await linearTeamsOf({ fetch: answer({ teams: { nodes: [team], pageInfo: { hasNextPage: false } } }), access: token(1) })).toEqual([team]);
    await expect(linearTeamsOf({ fetch: answer({ teams: { nodes: [team], pageInfo: { hasNextPage: true } } }), access: token(1) })).rejects.toBeInstanceOf(LinearOAuthFailure);
    await expect(linearTeamsOf({ fetch: answer({ teams: { nodes: [team, { id: "t-2", key: "not a key", name: "x" }] } }), access: token(1) })).rejects.toBeInstanceOf(LinearOAuthFailure);
    await expect(linearTeamsOf({ fetch: answer({ teams: { nodes: Array.from({ length: LINEAR_TEAMS_MAX + 1 }, () => team) } }), access: token(1) })).rejects.toBeInstanceOf(LinearOAuthFailure);
    await expect(linearTeamsOf({ fetch: vi.fn(async () => json({ errors: [{ message: "no" }] })), access: token(1) })).rejects.toBeInstanceOf(LinearOAuthFailure);
  });
  it("revokes form-encoded with token=, best effort", async () => {
    const seen: RequestInit[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { seen.push(init!); return new Response("", { status: 200 }); });
    expect(await revokeLinearToken({ fetch: fetch, token: token(3) })).toBe(true);
    expect(new URLSearchParams(seen[0]!.body as string).get("token")).toBe(token(3));
    expect(await revokeLinearToken({ fetch: vi.fn(async () => { throw new Error("down"); }), token: token(3) })).toBe(false);
  });
  it("sends the token_type_hint it is given; 2xx and 400 (already revoked) are done, anything else is not", async () => {
    const seen: RequestInit[] = [];
    const answering = (status: number) => vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { seen.push(init!); return new Response("", { status }); });
    expect(await revokeLinearToken({ fetch: answering(200), token: token(4), hint: "refresh_token" })).toBe(true);
    const sent = new URLSearchParams(seen[0]!.body as string);
    expect(sent.get("token")).toBe(token(4));
    expect(sent.get("token_type_hint")).toBe("refresh_token");
    expect(await revokeLinearToken({ fetch: answering(200), token: token(5), hint: "access_token" })).toBe(true);
    expect(new URLSearchParams(seen[1]!.body as string).get("token_type_hint")).toBe("access_token");
    expect(new URLSearchParams(seen[1]!.body as string).get("token")).toBe(token(5));
    expect(await revokeLinearToken({ fetch: answering(400), token: token(4), hint: "access_token" })).toBe(true);
    for (const status of [401, 429, 500, 503]) expect(await revokeLinearToken({ fetch: answering(status), token: token(4), hint: "access_token" })).toBe(false);
  });
});

describe("the app's settings", () => {
  it("accept only an https callback at Cloud's path, with no query; a malformed secret is 'not set up' and is read again next time", async () => {
    expect(LinearAppSettingsSchema.safeParse(LINEAR_APP).success).toBe(true);
    for (const redirectUri of ["http://app.rovara.example/api/connect/linear/callback", "https://app.rovara.example/other", "https://app.rovara.example/api/connect/linear/callback?x=1", "https://u:p@app.rovara.example/api/connect/linear/callback"]) {
      expect(LinearAppSettingsSchema.safeParse({ ...LINEAR_APP, redirectUri }).success).toBe(false);
    }
    let secret = "{not json";
    const send = vi.fn(async () => ({ SecretString: secret }));
    let clock = NOW;
    const read = linearAppSettingsReader({ send } as never, "name", () => clock);
    expect(await read()).toBeUndefined();
    secret = JSON.stringify(LINEAR_APP);
    // A missing or bad secret is remembered 30 seconds (unauthenticated webhook calls can't make a read each), then read again.
    expect(await read()).toBeUndefined();
    clock += 30_001;
    expect(await read()).toEqual(LINEAR_APP);
    secret = "{}";
    expect(await read()).toEqual(LINEAR_APP);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("through the broker's wiring, unauthenticated webhook POSTs with no app secret make one secret read per 30 seconds, answer 503 before the body is read, and a set secret is not remembered as missing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      let secret: string | undefined;
      const send = vi.fn(async () => { if (secret === undefined) throw Object.assign(new Error("Secrets Manager can't find the specified secret."), { name: "ResourceNotFoundException" }); return { SecretString: secret }; });
      const documentClient = { send: vi.fn() };
      const wiring = linearCompanyWiring({ env: { CHATGPT_CONNECTION_KEY_ARN: "test-linear-key" }, documentClient, tableName: "State", kms: { send: vi.fn() } as never, secrets: { send } as never, connectorSecretPrefix: "agentx/x/connectors/", log: () => undefined })!;
      const post = (rawBody: string | undefined, signature = "00") => handleLinearAppWebhook(wiring.webhook, { rawBody, headers: { "linear-signature": signature } });
      // Not set up: every POST is 503 with the fixed words, whatever its body (none, not JSON, oversized), and only the first one reads the secret.
      for (const body of [undefined, "{not json", "x".repeat(1_048_577), JSON.stringify({ type: "Issue" })]) expect(await post(body)).toEqual({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "Linear app webhooks are not set up" } } });
      expect(send).toHaveBeenCalledTimes(1);
      expect(documentClient.send).not.toHaveBeenCalled();
      vi.setSystemTime(NOW + 29_999);
      expect((await post("{}")).status).toBe(503);
      expect(send).toHaveBeenCalledTimes(1);
      // After the window, one new read.
      vi.setSystemTime(NOW + 30_001);
      expect((await post("{}")).status).toBe(503);
      expect(send).toHaveBeenCalledTimes(2);
      // Once the secret is set (and the missing answer has run out), it is read and used: a bad signature is now refused (401), not "not set up".
      secret = JSON.stringify(LINEAR_APP);
      vi.setSystemTime(NOW + 60_002);
      expect((await post("{}")).status).toBe(401);
      expect(send).toHaveBeenCalledTimes(3);
      // A good read is kept as good (5 minutes), not as missing: removing the secret changes nothing within that time and nothing is read again.
      secret = undefined;
      vi.setSystemTime(NOW + 60_002 + 299_000);
      expect((await post("{}")).status).toBe(401);
      expect(send).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe("golden: an API-key project's own hook keeps its own secret", () => {
  const HOOK_SECRET = ["project", "hook", "secret"].join("-");
  const hook = { project: "payments", organizationId: "org-1", teamId: "team-1" };
  const body = JSON.stringify({ type: "Issue", action: "create", organizationId: "org-1", webhookTimestamp: NOW, data: { id: "i-1", teamId: "team-1", identifier: "ENG-1", labels: [{ name: "rovara" }], url: "https://linear.app/acme/issue/ENG-1" } });
  const signed = (secret: string) => ({ rawBody: body, headers: { "linear-signature": createHmac("sha256", secret).update(Buffer.from(body)).digest("hex") } });
  it("the per-project hook verifies its own delivery and maps it exactly as before; the app's secret does not verify it", async () => {
    const tracker = linearTracker({ hook: async () => ({ hook, secret: HOOK_SECRET }) });
    const scope = SCOPE;
    expect(await tracker.events!.normalise!(signed(HOOK_SECRET), scope)).toEqual([{
      eventId: expect.stringMatching(/^linear:issue:i-1:create:label:[0-9a-f]{16}$/) as string, tracker: "linear", item: { tracker: "linear", id: "ENG-1", url: "https://linear.app/acme/issue/ENG-1" },
      type: "item.labelled", label: "rovara", occurredAt: new Date(NOW).toISOString(),
    }]);
    await expect(tracker.events!.normalise!(signed(LINEAR_WEBHOOK_SECRET), scope)).rejects.toMatchObject({ code: "CALLBACK_FORBIDDEN" });
  });
  it("the app route does not accept a delivery signed with a project's hook secret", async () => {
    const answer = await handleLinearAppWebhook({ connections: {} as never, app: async () => ({ ...LINEAR_APP }), now: () => NOW, log: () => undefined }, signed(HOOK_SECRET));
    expect(answer.status).toBe(401);
  });
});
