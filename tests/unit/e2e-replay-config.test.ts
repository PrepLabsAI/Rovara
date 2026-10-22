import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { APPLICATION_E2E_TEST_PATH } from "../../packages/contracts/src/e2e-application-execution-plan.js";
import { E2E_REPLAY_EXECUTOR_NAME, E2E_REPLAY_EXECUTOR_VERSION, expectedE2EApplicationConfigDigest, renderE2EApplicationDeclaration } from "../../packages/verifier/src/application-templates.js";

// M1.4 Task 4.6b, test 20: the replay config's digest is pinned to the pinned runner's own `resolveConfig`, and the digests every other kind of group already had do not move (stored
// admissions carry them, and a worker recompiles an admission and compares).

const target = { targetId: "web-fresh", profileId: "web-profile", factoryId: "installed-playwright", factoryManifestDigest: "f".repeat(64),
  engine: { name: "playwright", version: "1.0.0", spiVersion: 1, platform: "web", capabilities: ["actions", "observation"] },
  artifactCapabilities: [], stateCapability: false, app: { identity: "shop", environment: "test", url: "https://shop.test" } } as never;
const base = { projectId: "rovara-application-e2e", tests: [APPLICATION_E2E_TEST_PATH], target, timeout: 9000 };
const route = { routeId: "route-fresh", routeRevision: "route-revision-fresh" };

describe("the config digests that existed before the replay do not move", () => {
  it("a candidate group with an agent step (4.3b), a group with no route, and the declarations they render are exactly what they were", () => {
    // Computed with the code of the base this task starts from (06737048).
    expect(expectedE2EApplicationConfigDigest({ ...base, modelRoute: route })).toBe("8fc618de1f334b5d945609579cd9e4256dede4bc9c2942738821aacf1594bccd");
    expect(expectedE2EApplicationConfigDigest({ ...base, modelRoute: null })).toBe("8ebfa0d18f23af840738282afe612b3ae6ea0b2de006dffb7f23bb17fca1c6b2");
    const cases = [{ caseId: "case-a", upstreamTestId: `${APPLICATION_E2E_TEST_PATH}::case-a`, targetId: "web-fresh", scenarioId: "s", assertionDigests: ["a".repeat(64)] }];
    const bindings = new Map([["case-a", [{ index: 0, kind: "visible", digest: "a".repeat(64) }]]]);
    const declaration = (modelRoute: typeof route | null) => createHash("sha256").update(renderE2EApplicationDeclaration({ target, cliHost: { profileId: "p", descriptor: { entryPointId: "e", entryPointManifestDigest: "d".repeat(64) } },
      preparedEnvironmentDigest: "e".repeat(64), originByApplicationId: [], timeoutMs: 9000, modelRoute, expectedConfigDigest: "c".repeat(64), cases: cases as never, assertionsByCase: bindings })).digest("hex");
    expect(declaration(null)).toBe("f5a28dfcc73e6674010f333522d02cba82409013a1275a2020b27e6c505139e7");
    expect(declaration(route)).toBe("63d7ce65c1ed0a79408f067433b9e9c59e581c8a2e3c08fecd7f6899c80da996");
  });
});

describe("the replay config digest", () => {
  const replayDigest = expectedE2EApplicationConfigDigest({ ...base, modelRoute: null, replay: true });
  it("is its own digest: a read-only cache of a store that does not write, and the replay executor with no model and no ceiling", () => {
    expect(replayDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(replayDigest).not.toBe(expectedE2EApplicationConfigDigest({ ...base, modelRoute: null }));
    expect(replayDigest).not.toBe(expectedE2EApplicationConfigDigest({ ...base, modelRoute: route }));
    expect(E2E_REPLAY_EXECUTOR_NAME).toBe("rovara-e2e-replay");
    expect(E2E_REPLAY_EXECUTOR_VERSION).toBe("1");
  });
  it("refuses a replay that names a model route", () => {
    expect(() => expectedE2EApplicationConfigDigest({ ...base, modelRoute: route, replay: true })).toThrow(/replay/);
  });
  it("is the digest the pinned runner computes for the config the replay bootstrap builds", async () => {
    const { resolveConfig } = await import(new URL("../../node_modules/e2e/dist/config/resolve.js", import.meta.url).href) as { resolveConfig(config: unknown, options: { projectRoot: string }): { configDigest: string } };
    const { defineEngine } = await import("e2e/engine");
    const engine = defineEngine({ name: "playwright", version: "1.0.0", spiVersion: 1, platform: "web", observe: async () => { throw new Error("no effects"); }, perform: async () => { throw new Error("no effects"); }, actions: ["tap"] });
    // What the bootstrap builds for a replay shard: a store that never writes, and an executor that holds no model (so no model and no input ceiling in the agents entry).
    const store = { writable: false, read: async () => ({ status: "miss" }), write: async () => undefined };
    const executor = { name: E2E_REPLAY_EXECUTOR_NAME, version: E2E_REPLAY_EXECUTOR_VERSION, runStep: async () => ({ status: "blocked", summary: "x" }) };
    const config = { projectId: base.projectId, tests: [...base.tests], workers: 1, retries: 0, timeout: base.timeout, cache: { mode: "read-only", store }, reporters: [],
      agents: { default: { executor } }, targets: [{ name: "web-fresh", engine, app: { identity: "shop", environment: "test", url: "https://shop.test" } }] };
    const resolved = resolveConfig(config, { projectRoot: process.cwd() });
    // The target's platform enters the digest as the engine's ("web"), exactly as the launch target declares it.
    expect(resolved.configDigest).toBe(replayDigest);
  });
});
