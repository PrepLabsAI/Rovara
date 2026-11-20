import { describe, expect, it } from "vitest";
import { OIDC_ISSUER, authorizeQuery, httpEvent, identityHarness, type FakeOidcUser } from "../support/developer-fakes.js";

const ana: FakeOidcUser = { sub: "okta|ana", name: "Ana Ruiz", email: "ana@example.com" };

describe("no step-up (DEC 254zzz73)", () => {

  it("never asks a company sign-in to re-authenticate (no prompt=login or max_age), whatever acr_values says", async () => {
    const h = identityHarness({ slack: false, oidc: {}, oidcUsers: [ana] });
    const start = await h.http(httpEvent("GET", authorizeQuery({ acr_values: "step-up", method: "oidc" })));
    expect(start.statusCode).toBe(302);
    const provider = new URL(start.headers.location!);
    expect(provider.origin).toBe(OIDC_ISSUER);
    expect(provider.searchParams.has("prompt")).toBe(false);
    expect(provider.searchParams.has("max_age")).toBe(false);
  });

});
