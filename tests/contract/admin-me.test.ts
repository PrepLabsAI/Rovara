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
