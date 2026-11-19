import { describe, expect, it, vi } from "vitest";
import { savedEnvRepositoryName } from "@agentx/contracts";
import { createAdapterRegistry } from "../../packages/broker/src/ports/adapter-registry.js";
import * as bindings from "../../packages/broker/src/core/test-env/saved-env-real.js";
import { checkRebuild, onProjectDeleted, sweepDeleted } from "../../packages/broker/src/core/test-env/saved-env.js";
import { mintPushSession, mintPullSession } from "../../packages/broker/src/core/test-env/saved-env-session.js";
import { eraseCompanySavedEnvironments } from "../../packages/broker/src/aws/saved-env-company-erase.js";
import { hostedSavedEnvDeps } from "../../packages/broker/src/aws/hosted-saved-env.js";
import { savedWorld, approve, environmentBody, COMPANY, PROJECT, HEAD, BASE_IMAGE } from "../support/saved-env-harness.js";

describe("hosted saved image rule bindings", () => {
  it("without a configured registry leaves hosted bindings absent", () => {
    const registry = createAdapterRegistry();
    expect(hostedSavedEnvDeps({ registry, flow: {} as never, companyId: COMPANY, env: {}, now: () => 0 })).toBeUndefined();
  });
  it("off retains real hosted purge and company erase bindings but cannot build or issue logins", async () => {
    const w = savedWorld();
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", w.h.store);
    registry.register("audit-sink", "audit", w.h.deps.audit);
    registry.register("image-registry", "fake", w.registry);
    const saved = hostedSavedEnvDeps({ registry, flow: w.h.deps, companyId: COMPANY, env: { ROVARA_SAVED_ENVIRONMENTS: "0", AGENTX_ENV: "test" }, now: () => w.h.clock.now })!;
    expect(saved.session.config.enabled).toBe(false);
    const login = vi.spyOn(w.registry, "login");
    const deletion = vi.spyOn(w.registry, "deleteRepository");
    expect(await checkRebuild(saved, { orgId: COMPANY, projectId: PROJECT }, "poll")).toMatchObject({ ok: false, reason: "disabled" });
    const input = { orgId: COMPANY, projectId: PROJECT, approved: { revision: 1, digest: "a".repeat(64) } };
    expect(await mintPushSession(saved.session.config, saved.session.ports, input)).toEqual({ ok: false, reason: "disabled" });
    expect(await mintPullSession(saved.session.config, saved.session.ports, input)).toEqual({ ok: false, reason: "disabled" });
    expect(login).not.toHaveBeenCalled();
    w.registry.pushForTest(savedEnvRepositoryName({ env: "test", orgId: COMPANY, projectId: PROJECT }));
    expect(await onProjectDeleted(saved, input)).toMatchObject({ ok: true });
    w.h.clock.now += 3 * 3_600_000 + 1;
    expect(await sweepDeleted(saved)).toMatchObject({ ok: true });
    expect(deletion).toHaveBeenCalled();
    const sessions = { listCompanyRepositories: vi.fn(async () => []) };
    expect(await eraseCompanySavedEnvironments({ companyId: COMPANY, companyClosing: async id => id === COMPANY, store: w.h.store, saved, sessions, registry: w.registry })).toMatchObject({ complete: false, reason: "push_sessions_draining" });
    w.h.clock.now += 15 * 3_600_000 + 1;
    expect(await eraseCompanySavedEnvironments({ companyId: COMPANY, companyClosing: async id => id === COMPANY, store: w.h.store, saved, sessions, registry: w.registry })).toEqual({ complete: true, repositories: 0 });
    expect(sessions.listCompanyRepositories).toHaveBeenCalledWith({ companyId: COMPANY });
  });
  it("binds hosted auth and computes heads and keys through this project's registered code host", async () => {
    const w = savedWorld();
    await w.h.registerProject();
    await approve(w.test, environmentBody());
    const registry = createAdapterRegistry();
    registry.register("storage", "memory", w.h.store);
    registry.register("audit-sink", "audit", w.h.deps.audit);
    registry.register("image-registry", "fake", w.registry);
    const host = {
      kind: "github", async baseBranchHead() { return HEAD; },
      async repositoryTree() { return { complete: true, entries: [{ path: "package-lock.json", kind: "file" }] }; },
      async setupFileVersions() { return { complete: true, files: [{ path: "package-lock.json", id: "a".repeat(40) }] }; },
      async fileAtRevision() { return undefined; },
    };
    registry.register("code-host", "github", host as never);
    const factory = vi.spyOn(bindings, "createSavedEnvCleanupDeps");
    const saved = hostedSavedEnvDeps({ registry, flow: w.h.deps, companyId: COMPANY, env: { ROVARA_SAVED_ENVIRONMENTS: "1", AGENTX_ENV: "test", AGENTX_SANDBOX_IMAGE: `example/worker@${BASE_IMAGE}` }, now: () => w.h.clock.now })!;
    const wiring = factory.mock.calls[0]![0];
    factory.mockRestore();
    expect(() => wiring.keyHost("org_other00000000000000", PROJECT)).toThrow("saved environment company is unavailable");
    expect(saved.session.config).toEqual({ enabled: true, env: "test" });
    expect(saved.session.ports.registryAuthSchema?.safeParse({ registry: "127.0.0.1:5000", repository: "rovara-env/test/x/y", username: "local", password: "p", expiresAt: new Date().toISOString() }).success).toBe(false);
    const heads = await saved.defaultHeads(COMPANY, PROJECT);
    expect(heads).toEqual(new Map([["demo", HEAD]]));
    expect(await saved.currentKey(COMPANY, PROJECT, heads)).toMatch(/^[a-f0-9]{64}$/u);
    expect(await saved.defaultHeads("org_other00000000000000", PROJECT)).toBeUndefined();
    host.repositoryTree = async () => ({ complete: false, entries: [] });
    expect(await saved.currentKey(COMPANY, PROJECT, new Map([["demo", "b".repeat(40)]]))).toBeUndefined();
  });
});
