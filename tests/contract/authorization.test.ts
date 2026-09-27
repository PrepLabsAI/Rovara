import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  assertNoUntrustedRoutingFields,
  authorizeProject,
  authorizeWorkspace,
  JwtAuthenticator,
} from "../../packages/broker/src/index.js";

async function signedIdentity(subject: string, groups: string[] = []) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test";
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const token = await new SignJWT({ groups })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .setIssuer("https://issuer.example.com")
    .setAudience("agentx")
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const authenticator = new JwtAuthenticator(
    {
      issuer: "https://issuer.example.com",
      audience: "agentx",
      adminClaim: "groups",
      adminValues: ["agentx-admin"],
    },
    getKey,
  );
  return authenticator.authenticate(token);
}

describe("authentication and authorization", () => {
  it("derives stable owner identity from verified issuer and subject", async () => {
    const first = await signedIdentity("alice");
    const second = await signedIdentity("alice");
    expect(first.ownerKey).toBe(second.ownerKey);
    expect(first.subject).toBe("alice");
    expect(first.isAdministrator).toBe(false);
  });

  it("recognizes only verified administrator claims", async () => {
    expect((await signedIdentity("admin", ["agentx-admin"])).isAdministrator).toBe(true);
  });

  it("denies project and workspace access without matching membership and ownership", async () => {
    const alice = await signedIdentity("alice");
    expect(() => authorizeProject(alice, "payments", [{ ownerKey: alice.ownerKey, project: "shop" }])).toThrow(
      /NOT_FOUND/,
    );
    expect(() => authorizeWorkspace(alice, { ownerKey: "bob-key", projectName: "payments" })).toThrow(
      /NOT_FOUND/,
    );
  });

  it("rejects client-controlled identity and AgentCore routing fields at any depth", () => {
    expect(() => assertNoUntrustedRoutingFields({ prompt: "ok", nested: { runtimeSessionId: "x" } })).toThrow(
      /runtimeSessionId/,
    );
    expect(() => assertNoUntrustedRoutingFields({ ownerSubject: "bob" })).toThrow(/ownerSubject/);
    expect(() => assertNoUntrustedRoutingFields({ deploymentMode: "instances-ebs" })).toThrow(
      /deploymentMode/,
    );
    expect(() => assertNoUntrustedRoutingFields({ nested: { provider: "bedrock" } })).toThrow(/provider/);
    expect(() => assertNoUntrustedRoutingFields({ modelId: "server-choice" })).toThrow(/modelId/);
  });
});
