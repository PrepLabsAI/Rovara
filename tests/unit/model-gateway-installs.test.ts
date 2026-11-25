import { beforeAll as beforeNetworkTests } from "vitest";
import { denyNetwork } from "./model-gateway-no-network.js";
beforeNetworkTests(denyNetwork);
import { describe, expect, it, vi } from "vitest";
import { StaticInstallRegistry, createJwksReader } from "../../packages/model-gateway/src/installs.js";
import { createTaskTokenVerifier } from "../../packages/model-gateway/src/token.js";
import { claims, jwk, kid, mint, now } from "./model-gateway-fixture.js";

describe("pinned installs", () => {
  const entry = { issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid, "rotation"] };
  it("never fetches an unknown install or a developer kid", async () => {
    const readJwks = vi.fn(async () => [jwk]);
    const verify = createTaskTokenVerifier({ registry: new StaticInstallRegistry([entry]), readJwks, now: () => now });
    expect(await verify(mint({ iss: "https://unknown.example" }))).toBeUndefined();
    expect(await verify(mint({}, { kid: "developer" }))).toBeUndefined();
    expect(readJwks).not.toHaveBeenCalled();
  });
  it("coalesces reads, refetches missing kids only after 60 seconds, pauses failed fetches 10 seconds", async () => {
    let clock = now;
    const readJwks = vi.fn(async () => [jwk]);
    const verify = createTaskTokenVerifier({ registry: new StaticInstallRegistry([entry]), readJwks, now: () => clock });
    await Promise.all(Array.from({ length: 20 }, () => verify(mint())));
    expect(readJwks).toHaveBeenCalledTimes(1);
    await verify(mint({}, { kid: "rotation" })); expect(readJwks).toHaveBeenCalledTimes(1);
    clock += 60_000; await verify(mint({}, { kid: "rotation" })); expect(readJwks).toHaveBeenCalledTimes(2);
    readJwks.mockRejectedValue(new Error("private cause")); clock += 60_000;
    await verify(mint({}, { kid: "rotation" })); await verify(mint({}, { kid: "rotation" })); expect(readJwks).toHaveBeenCalledTimes(3);
    clock += 10_000; await verify(mint({}, { kid: "rotation" })); expect(readJwks).toHaveBeenCalledTimes(4);
  });
  it("fetches only the pinned address, refuses redirects, bounds bytes and keys, and fixes errors", async () => {
    const fake = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ keys: [jwk] })));
    expect(await createJwksReader(fake)(entry.jwksUrl)).toEqual([jwk]);
    expect(fake.mock.calls[0]?.[0]).toBe(entry.jwksUrl);
    expect(fake.mock.calls[0]?.[1]?.redirect).toBe("error");
    for (const body of ["secret", JSON.stringify({ keys: Array.from({ length: 33 }, () => jwk) }), "x".repeat(65537)]) {
      await expect(createJwksReader(async () => new Response(body))(entry.jwksUrl)).rejects.toThrow("keys unavailable");
    }
  });
});
it("recovers after a synchronously throwing key reader once the failure pause expires", async () => {
  let clock = now; let fail = true;
  const verify = createTaskTokenVerifier({ registry: new StaticInstallRegistry([{ issuer: claims.iss, jwksUrl: `${claims.iss}/.well-known/jwks.json`, taskKids: [kid] }]), readJwks: () => { if (fail) throw new Error("private"); return Promise.resolve([jwk]); }, now: () => clock });
  expect(await verify(mint())).toBeUndefined(); fail = false; clock += 10001;
  expect(await verify(mint())).toEqual(claims);
});
