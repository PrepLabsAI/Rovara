import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { NOW, PROFILE, approvedSetup, snapshotOf } from "../support/e2e-application-plan-fixtures.js";
import { registryFor } from "../support/e2e-account-registry-fixtures.js";

// PLANCTX (Ruling DE): the planning context lists each source-backed mock once, with the targets that may use it, instead of once per target.
const FIXTURE = join(import.meta.dirname, "../fixtures/orders-web-m13");
const FILES = ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"];
const ready = (kind: "web" | "api") => ({ kind, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedSteps, supportedAssertions: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedAssertions });

function contextOf(baselineScenarioIds?: string[]) {
  const snapshot = snapshotOf(Object.fromEntries(FILES.map((path) => [path, readFileSync(join(FIXTURE, path), "utf8")])));
  const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
  const policy = baselineScenarioIds === undefined ? setup.policy : { ...setup.policy, baselineScenarioIds };
  return buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [ready("web"), ready("api")], accountRegistry: registryFor(snapshot, NOW) });
}

describe("the planning context lists each source-backed mock once", () => {

  it("still refuses a context that is over its bound once the mock is listed once", () => {
    expect(contextOf(["x".repeat(12_001)])).toMatchObject({ status: "unknown", reason: "source-backed planning references exceed the bounded prompt context" });
  });
});
