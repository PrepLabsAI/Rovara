import { describe, expect, it } from "vitest";
import { APPLICATION_E2E_TEST_PATH } from "../../packages/contracts/src/e2e-application-execution-plan.js";
import { E2E_REPLAY_EXECUTOR_NAME, E2E_REPLAY_EXECUTOR_VERSION, expectedE2EApplicationConfigDigest } from "../../packages/verifier/src/application-templates.js";

// M1.4 Task 4.6b, test 20: the replay config's digest is pinned to the pinned runner's own `resolveConfig`, and the digests every other kind of group already had do not move (stored
// admissions carry them, and a worker recompiles an admission and compares).

const target = { targetId: "web-fresh", profileId: "web-profile", factoryId: "installed-playwright", factoryManifestDigest: "f".repeat(64),
  engine: { name: "playwright", version: "1.0.0", spiVersion: 1, platform: "web", capabilities: ["actions", "observation"] },
  artifactCapabilities: [], stateCapability: false, app: { identity: "shop", environment: "test", url: "https://shop.test" } } as never;
const base = { projectId: "rovara-application-e2e", tests: [APPLICATION_E2E_TEST_PATH], target, timeout: 9000 };
const route = { routeId: "route-fresh", routeRevision: "route-revision-fresh" };

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
});
