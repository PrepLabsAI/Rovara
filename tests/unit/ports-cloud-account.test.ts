import { describe, expect, it } from "vitest";
import { CloudAccountRefusedError, PLUGIN_POINT_CARDINALITY, PluginPointSchema } from "@agentx/contracts";
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

