import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "@agentx/contracts";
import { buildFeatureE2EPlanningContext } from "../../packages/broker/src/e2e/feature-plan-planning-context.js";
import { webApiRuntimeCapabilities } from "../../packages/broker/src/aws/e2e-feature-verifier-catalog.js";
import { NOW, PROFILE, approvedSetup, snapshotOf } from "../support/e2e-application-plan-fixtures.js";
import { registryFor } from "../support/e2e-account-registry-fixtures.js";

// PLANCTX (Ruling DE): the planning context lists each source-backed mock once, with the targets that may use it, instead of once per target.
const FIXTURE = join(import.meta.dirname, "../fixtures/orders-web-m13");
const FILES = ["package.json", "inventory/openapi.json", "e2e/mocks/inventory-v1.json"];
const ready = (kind: "web" | "api") => ({ kind, profileId: PROFILE, supportedSteps: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedSteps, supportedAssertions: webApiRuntimeCapabilities(kind, "a".repeat(64)).supportedAssertions });
const bytesOf = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8");

function contextOf(baselineScenarioIds?: string[]) {
  const snapshot = snapshotOf(Object.fromEntries(FILES.map((path) => [path, readFileSync(join(FIXTURE, path), "utf8")])));
  const setup = approvedSetup(snapshot, [{ kind: "web", profileId: PROFILE }, { kind: "api", profileId: PROFILE }]);
  const policy = baselineScenarioIds === undefined ? setup.policy : { ...setup.policy, baselineScenarioIds };
  return buildFeatureE2EPlanningContext(policy, snapshot, { origin: "approved-setup", preparedCommitSha: null, readyRuntimes: [ready("web"), ready("api")], accountRegistry: registryFor(snapshot, NOW) });
}

describe("the planning context lists each source-backed mock once", () => {
  it("lists the inventory mock one time, naming every target that may use it, with its variants written once", () => {
    const context = contextOf();
    if (context.status !== "available") throw new Error(context.reason);
    expect(context.mockFixtures).toHaveLength(1);
    const mock = context.mockFixtures[0]!;
    expect(mock.requestedTargetIds).toHaveLength(context.targets.length);
    expect(new Set(mock.requestedTargetIds).size).toBe(mock.requestedTargetIds.length);
    // Every target, web and API, base account and signed-out visitor alike, still learns it may use the mock.
    for (const target of context.targets) expect(mock.requestedTargetIds, target.targetId).toContain(target.targetId);
    for (const variant of mock.variants) expect(canonicalJson(context).split(`"id":"${variant.id}"`), variant.id).toHaveLength(2);
    expect(canonicalJson(context).split(mock.sourceSha256)).toHaveLength(2);
    expect(canonicalJson(context).split(mock.contractSha256)).toHaveLength(2);
  });

  it("keeps the whole context for the ten-target fixture inside the 12,000-byte bound, well under what one copy per target needs", () => {
    const context = contextOf();
    if (context.status !== "available") throw new Error(context.reason);
    const once = bytesOf(context);
    expect(once).toBeLessThanOrEqual(12_000);
    // What the context cost when the mock was written for every target (measured at 16,792 bytes on this fixture).
    const perTarget = bytesOf({ ...context, mockFixtures: context.mockFixtures.flatMap((mock) => mock.requestedTargetIds.map((requestedTargetId) => ({ ...mock, requestedTargetId }))) });
    expect(perTarget).toBeGreaterThan(12_000);
    expect(once).toBeLessThan(perTarget - 5_000);
  });

  it("still refuses a context that is over its bound once the mock is listed once", () => {
    expect(contextOf(["x".repeat(12_001)])).toMatchObject({ status: "unknown", reason: "source-backed planning references exceed the bounded prompt context" });
  });
});
