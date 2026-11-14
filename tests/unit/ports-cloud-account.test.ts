import { describe, expect, it } from "vitest";
import { CloudAccountRefusedError, PLUGIN_POINT_CARDINALITY, PluginPointSchema, SecretValue } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import { registerCodeDefaults } from "../../packages/broker/src/ports/policy-defaults.js";
import { createFakeCloudAccountWorld } from "../../packages/testing/src/fakes/cloud-account.js";
import { runCloudAccountConformance } from "../../packages/testing/src/ports/cloud-account-conformance.js";

runCloudAccountConformance("offline fake", createFakeCloudAccountWorld);

describe("cloud-account registry", () => {
  it("registers one unavailable default, replaceable by a configured adapter", async () => {
    expect(PluginPointSchema.parse("cloud-account")).toBe("cloud-account");
    expect(PLUGIN_POINT_CARDINALITY["cloud-account"]).toBe("one");
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    const unavailable = registry.require("cloud-account");
    const ref = { provider: "aws", tenant: "", accountId: "account" };
    await expect(unavailable.credentialsFor("org_aaaaaaaaaaaaaaaaaaaa", ref, "invoke_only_endpoint")).rejects.toThrow(CloudAccountRefusedError);
    await expect(unavailable.testConnection("org_aaaaaaaaaaaaaaaaaaaa", ref)).rejects.toThrow(CloudAccountRefusedError);
    await expect(unavailable.externalIdFor("org_aaaaaaaaaaaaaaaaaaaa")).rejects.toThrow(CloudAccountRefusedError);
    const fake = createFakeCloudAccountWorld();
    registry.register("cloud-account", "configured", fake.port);
    expect(registry.require("cloud-account")).toBe(fake.port);
    expect(() => registry.register("cloud-account", "second", createFakeCloudAccountWorld().port)).toThrow();
  });
});

describe("cloud-account reads", () => {
  it("rejects malformed fixture grants instead of making widened purposes reachable", () => {
    const world = createFakeCloudAccountWorld();
    const ref = { provider: "aws", tenant: "", accountId: "account" };
    for (const purpose of ["*", "all", ["recording_bucket", "device_farm_project"]]) {
      expect(() => world.grant("org_aaaaaaaaaaaaaaaaaaaa", ref, purpose as "recording_bucket", () => undefined)).toThrow(CloudAccountRefusedError);
    }
    expect(() => world.grant("org_aaaaaaaaaaaaaaaaaaaa", { ...ref, tenant: "bad\u0000tenant" }, "recording_bucket", () => undefined)).toThrow(CloudAccountRefusedError);
  });

  it("rejects fixture grants for company ids outside OrgIdSchema", () => {
    const world = createFakeCloudAccountWorld();
    const ref = { provider: "aws", tenant: "", accountId: "account" };
    for (const company of ["*", "ORG_aaaaaaaaaaaaaaaaaaaa", "org_short", "org_x/../org_y"]) {
      expect(() => world.grant(company, ref, "recording_bucket", () => undefined)).toThrow(CloudAccountRefusedError);
    }
  });

  it("checks expiry after provider completion, without caching credentials", async () => {
    const world = createFakeCloudAccountWorld();
    const ref = { provider: "aws", tenant: "", accountId: "account" };
    world.setNow(100);
    let issued = 0;
    world.grant("org_aaaaaaaaaaaaaaaaaaaa", ref, "recording_bucket", async () => {
      issued += 1;
      await Promise.resolve();
      world.setNow(200);
      return { provider: "aws", accessKeyId: new SecretValue("access"), secretAccessKey: new SecretValue("secret"), sessionToken: new SecretValue("session"), expiresAt: 200 };
    });
    await expect(world.port.credentialsFor("org_aaaaaaaaaaaaaaaaaaaa", ref, "recording_bucket")).rejects.toThrow(CloudAccountRefusedError);
    await expect(world.port.credentialsFor("org_aaaaaaaaaaaaaaaaaaaa", ref, "recording_bucket")).rejects.toThrow(CloudAccountRefusedError);
    expect(issued).toBe(2);
    expect(world.issuances).toEqual([]);
  });
});
