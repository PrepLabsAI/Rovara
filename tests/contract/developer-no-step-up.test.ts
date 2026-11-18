// DEC 254zzz73: there is no step-up ("confirm it's you"). A client that still asks for one (`acr_values=step-up`) gets an ordinary sign-in: the code goes straight back, the token carries
// no step-up claims, and Code serves no step-up page, factor email or passkey route.
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import { CLI_REDIRECT, OIDC_ISSUER, authorizeQuery, httpEvent, identityHarness, type FakeOidcUser, type FakeSlackUser } from "../support/developer-fakes.js";

const maya: FakeSlackUser = { userId: "U0MAYA001", name: "Maya Chen", email: "maya@example.com" };
const ana: FakeOidcUser = { sub: "okta|ana", name: "Ana Ruiz", email: "ana@example.com" };

describe("no step-up (DEC 254zzz73)", () => {
  it("answers a Slack sign-in that asks for acr_values=step-up as an ordinary one: a code straight back, no step-up claims", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up" })));
    expect(start.statusCode).toBe(302);
    const back = await h.http(httpEvent("GET", h.slack.approve(start.headers.location!, "U0MAYA001")));
    const location = new URL(back.headers.location!);
    expect(`${location.origin}${location.pathname}`).toBe(CLI_REDIRECT);
    expect(location.searchParams.get("code")).toMatch(/^agxc_/);
    expect(back.cookies).toBeUndefined();
    const tokens = await h.exchange(location.searchParams.get("code")!);
    const claims = decodeJwt(String(tokens.body.access_token));
    expect(claims.sub).toBeTypeOf("string");
    expect(claims).not.toHaveProperty("step_up_at");
    expect(claims).not.toHaveProperty("step_up_amr");
    // No step-up row of any kind was written.
    expect([...h.db.items.values()].filter((item) => /^(STEPUP|PASSKEYS)/.test(String(item.pk)))).toEqual([]);
    expect([...h.db.items.values()].some((item) => "factorEmail" in item || "firstSignInMark" in item)).toBe(false);
  });

  it("never asks a company sign-in to re-authenticate (no prompt=login or max_age), whatever acr_values says", async () => {
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [ana] });
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up", method: "oidc" })));
    expect(start.statusCode).toBe(302);
    const provider = new URL(start.headers.location!);
    expect(provider.origin).toBe(OIDC_ISSUER);
    expect(provider.searchParams.has("prompt")).toBe(false);
    expect(provider.searchParams.has("max_age")).toBe(false);
  });

  it("serves no step-up page and does not advertise acr_values in its discovery document", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    for (const [method, path] of [["GET", "/v1/auth/step-up"], ["POST", "/v1/auth/step-up/email"], ["POST", "/v1/auth/step-up/verify"], ["POST", "/v1/auth/step-up/passkey/options"]] as const) {
      expect((await h.http(httpEvent(method, path, method === "POST" ? {} : undefined))).statusCode).toBe(404);
    }
    const discovery = await h.http(httpEvent("GET", "/v1/auth/.well-known/openid-configuration"));
    expect(JSON.parse(discovery.body)).not.toHaveProperty("acr_values_supported");
  });

  it("answers the removed factor requests as unknown, never as a factor answer", async () => {
    const h = identityHarness({ slackUsers: [maya] });
    for (const kind of ["list-passkeys", "list-sign-in-factors", "remove-passkey", "remove-person-passkeys", "set-factor-email"]) {
      const answer = await h.handler({ kind, developerId: "a".repeat(64), sessionId: "00000000-0000-4000-8000-000000000000" } as never) as Record<string, unknown>;
      expect(answer).not.toHaveProperty("passkeys");
      expect(answer).not.toHaveProperty("factorEmail");
      expect(answer["ok"]).not.toBe(true);
    }
  });
});
