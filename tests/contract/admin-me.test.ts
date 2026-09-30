// tests/contract/admin-me.test.ts
// Spec 025 A12 (Q3): who the admin is, and whether their verified email matches a Slack user.
import { describe, expect, it, vi } from "vitest";
import { adminIdentityReader } from "../../packages/broker/src/aws/admin-me.js";
import { createAdminReadBroker } from "../support/admin-read-broker.js";
import { issuer } from "../support/slack-broker.js";

const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool";
const identity = (claims: Record<string, unknown> = {}) => ({ issuer: ISSUER, subject: "admin-subject", ownerKey: "o".repeat(64), isAdministrator: true, claims: { iss: ISSUER, sub: "admin-subject", ...claims } });

function idp(userinfo: Record<string, unknown> | "missing" | "slow") {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json(userinfo === "missing" ? { issuer: ISSUER } : { issuer: ISSUER, userinfo_endpoint: "https://agentx.auth.us-east-1.amazoncognito.com/oauth2/userInfo" });
    }
    if (userinfo === "slow") await new Promise((resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))); });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-token");
    return Response.json(userinfo);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("GET /v1/admin/me (A12)", () => {
  it("reads a verified email from userinfo (Cognito's string \"true\") and links the Slack user", async () => {
    const { fetch } = idp({ sub: "admin-subject", email: "ada@example.com", email_verified: "true", name: "Ada" });
    const slackUserByEmail = vi.fn(async () => ({ ok: true as const, userId: "U0ADA00001" }));
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail, now: Date.now, log: vi.fn() });
    expect(await reader.me(identity(), "Bearer admin-token")).toEqual({
      issuer: ISSUER, subject: "admin-subject", name: "Ada", email: "ada@example.com", slack: { linked: true, userId: "U0ADA00001" },
    });
    expect(slackUserByEmail).toHaveBeenCalledWith({ kind: "slack-user-by-email", email: "ada@example.com" });
  });

  it("uses the token's own claims when it carries a verified email, without calling userinfo", async () => {
    const { fetch, calls } = idp({});
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail: async () => ({ ok: true }), now: Date.now, log: vi.fn() });
    expect(await reader.me(identity({ email: "ada@example.com", email_verified: true }), "Bearer admin-token")).toMatchObject({ email: "ada@example.com", slack: { linked: false, reason: "no_match" } });
    expect(calls).toEqual([]);
  });

  it("ignores an unverified email, and says so", async () => {
    const { fetch } = idp({ sub: "admin-subject", email: "ada@example.com", email_verified: false });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail: vi.fn(), now: Date.now, log: vi.fn() });
    const answer = await reader.me(identity(), "Bearer admin-token");
    expect(answer).not.toHaveProperty("email");
    expect(answer.slack).toEqual({ linked: false, reason: "no_email" });
  });

  it("answers without an email when userinfo is missing or slow", async () => {
    for (const shape of ["missing", "slow"] as const) {
      const { fetch } = idp(shape);
      const log = vi.fn();
      const started = Date.now();
      const reader = adminIdentityReader({ issuer: ISSUER, fetch, slackUserByEmail: vi.fn(), now: Date.now, log, timeoutMs: 50 });
      expect(await reader.me(identity(), "Bearer admin-token")).toEqual({ issuer: ISSUER, subject: "admin-subject", slack: { linked: false, reason: "no_email" } });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(JSON.stringify(log.mock.calls)).not.toContain("admin-token");
    }
  });

  it("says not_set_up without the Slack lookup, and slack_unavailable when it fails", async () => {
    const verified = identity({ email: "ada@example.com", email_verified: true });
    const unset = adminIdentityReader({ issuer: ISSUER, fetch: idp({}).fetch, now: Date.now, log: vi.fn() });
    expect((await unset.me(verified, "Bearer admin-token")).slack).toEqual({ linked: false, reason: "not_set_up" });
    const down = adminIdentityReader({ issuer: ISSUER, fetch: idp({}).fetch, slackUserByEmail: async () => ({ ok: false, error: "slack_unavailable" }), now: Date.now, log: vi.fn() });
    expect((await down.me(verified, "Bearer admin-token")).slack).toEqual({ linked: false, reason: "slack_unavailable" });
  });

  it("says slack_unavailable when the Slack lookup throws, and logs only the error name", async () => {
    const verified = identity({ email: "ada@example.com", email_verified: true });
    const log = vi.fn();
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: idp({}).fetch, slackUserByEmail: async () => { throw Object.assign(new Error("ada@example.com Bearer admin-token"), { name: "TimeoutError" }); }, now: Date.now, log });
    expect((await reader.me(verified, "Bearer admin-token")).slack).toEqual({ linked: false, reason: "slack_unavailable" });
    expect(log).toHaveBeenCalledWith({ event: "admin.slack_user_lookup_failed", error: "TimeoutError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("admin-token");
  });

  it("keeps a profile for five minutes per token, and never keeps a failure", async () => {
    let now = 0;
    const { fetch, calls } = idp({ sub: "admin-subject", email: "ada@example.com", email_verified: true });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch, now: () => now, log: vi.fn() });
    await reader.profile(identity(), "Bearer admin-token");
    await reader.profile(identity(), "Bearer admin-token");
    expect(calls.filter((url) => url.includes("userInfo"))).toHaveLength(1);
    now += 300_001;
    await reader.profile(identity(), "Bearer admin-token");
    expect(calls.filter((url) => url.includes("userInfo"))).toHaveLength(2);
  });
});

describe("the route", () => {
  it("answers through GET /v1/admin/me, and refuses a non-admin", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => (urlOf(input).endsWith("openid-configuration") ? Response.json({ issuer }) : Response.json({}))) as unknown as typeof globalThis.fetch;
    const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { me: { issuer, fetch } } } });
    // The broker's answers carry the request ID, as every route's do.
    expect((await admin("GET", "/v1/admin/me")).body).toEqual({ issuer, subject: "admin-subject", slack: { linked: false, reason: "no_email" }, requestId: expect.any(String) as unknown });
    expect((await admin("GET", "/v1/admin/me", { admin: false })).body.error).toMatchObject({ code: "FORBIDDEN" });
  });

  it("never logs the admin's token or puts it in the answer, when userinfo fails", async () => {
    const planted = "planted-admin-token-5f1c";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (urlOf(input).endsWith("openid-configuration")) return Response.json({ issuer, userinfo_endpoint: "https://identity.example.test/userinfo" });
      throw Object.assign(new Error(`refused for ${planted}`), { name: "TypeError" });
    }) as unknown as typeof globalThis.fetch;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { admin } = await createAdminReadBroker({ brokerExtra: { adminReads: { me: { issuer, fetch } } } });
      const answer = await admin("GET", "/v1/admin/me", { headers: { authorization: `Bearer ${planted}` } });
      expect(answer.body).toMatchObject({ slack: { linked: false, reason: "no_email" } });
      expect(JSON.stringify(answer.body)).not.toContain(planted);
      expect(JSON.stringify([...log.mock.calls, ...error.mock.calls])).not.toContain(planted);
      expect(JSON.stringify(log.mock.calls)).toContain("admin.userinfo_failed");
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

/** A fake issuer: `discovery` answers the discovery document, `userinfo` answers per bearer token. */
function issuerFake(options: { discovery?: () => Response | Promise<Response>; userinfo?: (authorization: string | null) => Response | Promise<Response> }) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    calls.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) return options.discovery?.() ?? Response.json({ issuer: ISSUER, userinfo_endpoint: "https://agentx.auth.us-east-1.amazoncognito.com/oauth2/userInfo" });
    return options.userinfo?.(new Headers(init?.headers).get("authorization")) ?? Response.json({});
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, userinfoCalls: () => calls.filter((url) => url.includes("userInfo")).length, discoveryCalls: () => calls.filter((url) => url.endsWith("openid-configuration")).length };
}

describe("the identity reader's guards", () => {
  it("rejects a userinfo answer for another subject, and does not keep it", async () => {
    const fake = issuerFake({ userinfo: () => Response.json({ sub: "someone-else", email: "eve@example.com", email_verified: true }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    expect(await reader.profile(identity(), "Bearer admin-token")).toEqual({});
    expect(await reader.profile(identity(), "Bearer admin-token")).toEqual({});
    expect(fake.userinfoCalls()).toBe(2);
  });

  it("refuses a userinfo endpoint that is not HTTPS", async () => {
    const fake = issuerFake({ discovery: () => Response.json({ issuer: ISSUER, userinfo_endpoint: "http://agentx.auth.us-east-1.amazoncognito.com/oauth2/userInfo" }), userinfo: () => Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    expect(await reader.profile(identity(), "Bearer admin-token")).toEqual({});
    expect(fake.userinfoCalls()).toBe(0);
  });

  it("keeps each token's profile apart", async () => {
    const fake = issuerFake({ userinfo: (authorization) => Response.json({ sub: "admin-subject", email: authorization === "Bearer token-a" ? "a@example.com" : "b@example.com", email_verified: true }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    expect((await reader.profile(identity(), "Bearer token-a")).email).toBe("a@example.com");
    expect((await reader.profile(identity(), "Bearer token-b")).email).toBe("b@example.com");
    expect((await reader.profile(identity(), "Bearer token-a")).email).toBe("a@example.com");
    expect(fake.userinfoCalls()).toBe(2);
  });

  it("does not keep a failed userinfo call: the next call tries again", async () => {
    let fail = true;
    const fake = issuerFake({ userinfo: () => (fail ? new Response("down", { status: 500 }) : Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true })) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    expect(await reader.profile(identity(), "Bearer admin-token")).toEqual({});
    fail = false;
    expect((await reader.profile(identity(), "Bearer admin-token")).email).toBe("ada@example.com");
    expect(fake.userinfoCalls()).toBe(2);
  });

  it("logs a refused userinfo or discovery answer by status or error name only", async () => {
    const log = vi.fn();
    const userinfoDown = issuerFake({ userinfo: () => new Response("Bearer admin-token", { status: 500 }) });
    await adminIdentityReader({ issuer: ISSUER, fetch: userinfoDown.fetch, now: () => 0, log }).profile(identity(), "Bearer admin-token");
    expect(log).toHaveBeenCalledWith({ event: "admin.userinfo_failed", status: 500 });
    const discoveryDown = issuerFake({ discovery: () => new Response("", { status: 503 }) });
    await adminIdentityReader({ issuer: ISSUER, fetch: discoveryDown.fetch, now: () => 0, log }).profile(identity(), "Bearer admin-token");
    expect(log).toHaveBeenCalledWith({ event: "admin.discovery_failed", status: 503 });
    const discoveryThrows = issuerFake({ discovery: () => { throw Object.assign(new Error("Bearer admin-token"), { name: "TypeError" }); } });
    await adminIdentityReader({ issuer: ISSUER, fetch: discoveryThrows.fetch, now: () => 0, log }).profile(identity(), "Bearer admin-token");
    expect(log).toHaveBeenCalledWith({ event: "admin.discovery_failed", error: "TypeError" });
    expect(JSON.stringify(log.mock.calls)).not.toContain("admin-token");
  });

  it("redacts a token-shaped display name (A16), from the token or from userinfo", async () => {
    const planted = `xoxb-${"1".repeat(12)}-${"2".repeat(13)}-${"a".repeat(24)}`;
    const fake = issuerFake({ userinfo: () => Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true, name: planted }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    for (const found of [await reader.profile(identity(), "Bearer admin-token"), await reader.profile(identity({ name: planted, email: "ada@example.com", email_verified: true }), undefined)]) {
      expect(found.name).toContain("[REDACTED]");
      expect(JSON.stringify(found)).not.toContain(planted);
    }
  });

  // Final review, item 8 (T11): an email shown as the name is capped and redacted like any other name.
  it("caps and redacts a verified email used as the name", async () => {
    const planted = `ghp_${"E".repeat(36)}`;
    const long = `${"a".repeat(240)}@example.com`;
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: vi.fn() as unknown as typeof fetch, now: () => 0, log: vi.fn() });
    const cut = await reader.profile(identity({ email: long, email_verified: true }), undefined);
    expect(cut.email).toBe(long);
    expect(cut.name?.length).toBeLessThanOrEqual(200);
    const redacted = await reader.profile(identity({ email: `${planted}@example.com`, email_verified: true }), undefined);
    expect(redacted.name).toContain("[REDACTED]");
    expect(redacted.name).not.toContain(planted);
  });

  it("keeps the token's name when userinfo adds only a verified email", async () => {
    const fake = issuerFake({ userinfo: () => Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    expect(await reader.profile(identity({ name: "Ada Lovelace" }), "Bearer admin-token")).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
  });

  it("keeps a discovery document without a usable endpoint only for the cache time", async () => {
    let now = 0;
    const fake = issuerFake({ discovery: () => Response.json({ issuer: ISSUER }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => now, log: vi.fn() });
    await reader.profile(identity(), "Bearer admin-token");
    await reader.profile(identity(), "Bearer admin-token");
    expect(fake.discoveryCalls()).toBe(1);
    now += 300_001;
    await reader.profile(identity(), "Bearer admin-token");
    expect(fake.discoveryCalls()).toBe(2);
  });

  it("answers only the token's own claims, without the network, for a token from another issuer", async () => {
    const fake = issuerFake({ userinfo: () => Response.json({ sub: "admin-subject", email: "ada@example.com", email_verified: true }) });
    const reader = adminIdentityReader({ issuer: ISSUER, fetch: fake.fetch, now: () => 0, log: vi.fn() });
    const other = { ...identity({ name: "Ada" }), issuer: "https://other.example.test" };
    expect(await reader.profile(other, "Bearer admin-token")).toEqual({ name: "Ada" });
    expect(fake.calls).toEqual([]);
  });
});
