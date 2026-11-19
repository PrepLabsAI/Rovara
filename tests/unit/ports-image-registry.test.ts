// The `image-registry` point: the in-memory fake and the default "none" pass the contract; a login is held to one repository and a local-looking host.
import { describe, expect, it } from "vitest";
import { HostedSavedEnvRegistryAuthSchema, ImageRegistryError, PLUGIN_POINTS, PLUGIN_POINT_CARDINALITY, SavedEnvRegistryAuthSchema, savedEnvRegistryAuthSchema, savedEnvRepositoryName } from "@agentx/contracts";
import { createAdapterRegistry, createFakeImageRegistry, createUnavailableImageRegistry, registerCodeDefaults } from "../../packages/broker/src/ports/index.js";
import { runImageRegistryConformance } from "../support/ports/image-registry-conformance.js";

runImageRegistryConformance("the in-memory fake", {
  async create() {
    const registry = createFakeImageRegistry();
    return { registry, async push(repository) { return registry.pushForTest(repository); }, async makeForeign(repository) { registry.makeForeignForTest(repository); } };
  },
});

describe("the image-registry point", () => {
  const repository = savedEnvRepositoryName({ env: "test", orgId: "org_00000000000000000000", projectId: "alpha" });
  it("is a point of one adapter, and Code's default is 'none', which says so", async () => {
    expect(PLUGIN_POINTS).toContain("image-registry");
    expect(PLUGIN_POINT_CARDINALITY["image-registry"]).toBe("one");
    const none = createUnavailableImageRegistry();
    expect(none.capabilities).toEqual({ workerPush: false, workerPull: false, scan: false });
    expect(await none.inspect({ companyId: "c", repository })).toBe("unusable");
    await expect(none.login({ companyId: "c", repository, access: "push", maxSeconds: 60 })).rejects.toBeInstanceOf(ImageRegistryError);
  });

  it("is registered as a default by registerCodeDefaults, and a configured adapter replaces it", () => {
    const registry = createAdapterRegistry();
    registerCodeDefaults(registry, { priceTable: { currency: "USD", models: {} } });
    expect(registry.names("image-registry")).toEqual(["none"]);
    registry.register("image-registry", "fake", createFakeImageRegistry());
    expect(registry.names("image-registry")).toEqual(["fake"]);
  });

  it("holds a login's registry to the hosted registry's host or this machine's loopback and a port, nothing else", () => {
    const base = { repository, username: "rovara-local", password: "p".repeat(20), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    for (const registry of ["127.0.0.1:5001", "localhost:5001", "123456789012.dkr.ecr.us-west-2.amazonaws.com"]) expect(SavedEnvRegistryAuthSchema.safeParse({ ...base, registry }).success, registry).toBe(true);
    for (const registry of ["example.com:5001", "127.0.0.1", "127.0.0.1:99999", "127.0.0.1:5001/x", "user@127.0.0.1:5001", "localhost.evil.com:5001", "10.0.0.5:5001", "[::1]:5001", "127.0.0.1:80", ""]) expect(SavedEnvRegistryAuthSchema.safeParse({ ...base, registry }).success, registry).toBe(false);
    expect(SavedEnvRegistryAuthSchema.safeParse({ ...base, registry: "127.0.0.1:5001", username: "root" }).success).toBe(false);
  });

  it("a hosted install accepts only the cloud registry's host and its fixed user name: the widened contract does not loosen it", () => {
    const base = { repository, password: "p".repeat(20), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const cloud = { ...base, registry: "123456789012.dkr.ecr.us-west-2.amazonaws.com", username: "AWS" };
    expect(HostedSavedEnvRegistryAuthSchema.safeParse(cloud).success).toBe(true);
    for (const registry of ["127.0.0.1:5001", "localhost:5001"]) expect(HostedSavedEnvRegistryAuthSchema.safeParse({ ...cloud, registry }).success, registry).toBe(false);
    expect(HostedSavedEnvRegistryAuthSchema.safeParse({ ...cloud, username: "rovara-local" }).success).toBe(false);
    expect(HostedSavedEnvRegistryAuthSchema.safeParse({ ...base, registry: "127.0.0.1:5001", username: "rovara-local" }).success).toBe(false);
    // The factory is the one place the difference is made, and Code's own schema is the one that takes the loopback registry.
    expect(savedEnvRegistryAuthSchema({ allowLocal: false }).safeParse({ ...base, registry: "localhost:5001", username: "AWS" }).success).toBe(false);
    expect(savedEnvRegistryAuthSchema({ allowLocal: true }).safeParse({ ...base, registry: "localhost:5001", username: "rovara-local" }).success).toBe(true);
    expect(SavedEnvRegistryAuthSchema.safeParse({ ...base, registry: "localhost:5001", username: "rovara-local" }).success).toBe(true);
  });
});
