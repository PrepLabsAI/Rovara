import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { E2E_DEFAULT_MODEL_ROUTE_ID, e2eModelRouteRevision } from "@agentx/contracts";
import {
  approveE2EAgentRoute, checkE2EAgentRouteCurrent, deriveE2EAgentRoute, e2eAgentRouteDefinitionDigest, e2eModelRouteCanaryKey, e2eModelRouteLatestKey, e2eModelRouteRevisionKey,
  planE2EAgentRoute, readAdmittedE2EModelRoute, readE2EModelRouteLatest, type E2EAgentInstallation,
} from "../../packages/broker/src/e2e/model-route-registry.js";
import { deriveE2EAgentRouteForModel } from "../../packages/model-runtime/src/e2e-route-derive.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SECRET_ARN, drivingTestRow } from "../support/e2e-model-fixtures.js";

// M1.4 Task 4.10C, tests 36 and 37: no route of any provider is approvable or dispatchable without a driving test that passed for its exact definition. This file never assumes a pass.

const store = (db: FakeDynamoDb) => ({ documentClient: { send: db.send } as unknown as DynamoDBDocumentClient, tableName: "state" });
const INSTALLATIONS: ReadonlyArray<readonly [string, E2EAgentInstallation]> = [
  ["amazon-bedrock", { provider: "amazon-bedrock", region: "us-east-1" }],
  ["anthropic", { provider: "anthropic", secretArn: SECRET_ARN }],
  ["openai", { provider: "openai", secretArn: SECRET_ARN }],
  ["openrouter", { provider: "openrouter", secretArn: SECRET_ARN }],
];
const definitionOf = (installation: E2EAgentInstallation) => {
  const derived = deriveE2EAgentRoute(installation, 1);
  if (derived.status !== "available") throw new Error(derived.detail);
  return derived.definition;
};

describe.each(INSTALLATIONS)("%s: the driving test gates the route", (_name, installation) => {
  it("is unavailable without a gating row, and names the model that must be tested", async () => {
    const db = new FakeDynamoDb();
    const planned = await planE2EAgentRoute(store(db), installation);
    expect(planned).toMatchObject({ status: "unavailable", reason: "agent-route-not-approved", untested: { modelId: definitionOf(installation).modelId } });
    expect(planned.status === "unavailable" ? planned.detail : "").toMatch(/^the driving test with .+ `.+` has not passed yet$/);
    await expect(approveE2EAgentRoute(store(db), installation, "r1-000000000000")).rejects.toThrow(/agent-route-not-approved/);
    expect(db.items.size).toBe(0);
  });

  it("is available once the gating row of its exact digest has the driving-test marker", async () => {
    const db = new FakeDynamoDb();
    const definition = definitionOf(installation);
    db.set(drivingTestRow(definition, e2eAgentRouteDefinitionDigest(definition)));
    expect(await planE2EAgentRoute(store(db), installation)).toMatchObject({ status: "available", revisionNumber: 1 });
  });

  it("a row written the way Task 4.9's canary wrote it (no marker) does not satisfy the gate", async () => {
    const db = new FakeDynamoDb();
    const definition = definitionOf(installation);
    db.set({ ...e2eModelRouteCanaryKey(E2E_DEFAULT_MODEL_ROUTE_ID, e2eAgentRouteDefinitionDigest(definition)), entityType: "E2E_MODEL_ROUTE_CANARY", routeId: definition.routeId, definitionDigest: e2eAgentRouteDefinitionDigest(definition) });
    expect(await planE2EAgentRoute(store(db), installation)).toMatchObject({ status: "unavailable" });
  });

  it("a row with the marker for another digest, or whose own fields are not the key's, does not satisfy it", async () => {
    const db = new FakeDynamoDb();
    const definition = definitionOf(installation);
    const digest = e2eAgentRouteDefinitionDigest(definition);
    db.set({ ...drivingTestRow(definition, "f".repeat(64)), sk: `E2E_MODEL_ROUTE_CANARY#${definition.routeId}#${digest}` });
    expect(await planE2EAgentRoute(store(db), installation)).toMatchObject({ status: "unavailable" });
  });

  it("a pass is for one exact definition: another model, another shape and another scope are untested again", async () => {
    const db = new FakeDynamoDb();
    const definition = definitionOf(installation);
    db.set(drivingTestRow(definition, e2eAgentRouteDefinitionDigest(definition)));
    const minimal = deriveE2EAgentRouteForModel(installation, definition.modelId, "minimal", 1);
    if (minimal.status !== "available") throw new Error("expected a minimal route");
    expect(await planE2EAgentRoute(store(db), { ...installation, payloadShape: "minimal" })).toMatchObject({ status: "unavailable" });
    db.set(drivingTestRow(minimal.definition, e2eAgentRouteDefinitionDigest(minimal.definition)));
    expect(await planE2EAgentRoute(store(db), { ...installation, payloadShape: "minimal" })).toMatchObject({ status: "available" });
  });

  it("checkE2EAgentRouteCurrent gives model-route-not-tested for an approved route whose row is not there (and ok when it is)", async () => {
    const db = new FakeDynamoDb();
    const definition = definitionOf(installation);
    const row = drivingTestRow(definition, e2eAgentRouteDefinitionDigest(definition));
    db.set(row);
    const planned = await planE2EAgentRoute(store(db), installation);
    if (planned.status !== "available") throw new Error("unavailable");
    await approveE2EAgentRoute(store(db), installation, planned.revision);
    expect(await checkE2EAgentRouteCurrent(store(db), installation, planned.revision)).toMatchObject({ ok: true });
    db.delete(String(row.pk), String(row.sk));
    expect(await checkE2EAgentRouteCurrent(store(db), installation, planned.revision)).toMatchObject({ ok: false, code: "model-route-not-tested" });
  });
});

describe("rows written before Task 4.10 still parse (test 37)", () => {
  it("reads a LATEST and a REV row exactly as 38b55645 wrote them", async () => {
    const db = new FakeDynamoDb();
    const definition = definitionOf(INSTALLATIONS[0]![1]);
    const revision = e2eModelRouteRevision(definition);
    // The shapes `approveE2EAgentRoute` has always written: no test marker, no shape.
    db.set({ ...e2eModelRouteRevisionKey(definition.routeId, 1), entityType: "E2E_MODEL_ROUTE", routeId: definition.routeId, revisionNumber: 1, revision, definitionDigest: e2eAgentRouteDefinitionDigest(definition),
      definition, approvedAt: "2026-10-21T10:00:00.000Z" });
    db.set({ ...e2eModelRouteLatestKey(definition.routeId), entityType: "E2E_MODEL_ROUTE_LATEST", routeId: definition.routeId, revisionNumber: 1, revision, definitionDigest: e2eAgentRouteDefinitionDigest(definition), approvedAt: "2026-10-21T10:00:00.000Z" });
    expect(await readE2EModelRouteLatest(store(db), definition.routeId)).toEqual({ routeId: definition.routeId, revisionNumber: 1, revision, definitionDigest: e2eAgentRouteDefinitionDigest(definition) });
    expect(await readAdmittedE2EModelRoute(async (key) => db.get(key.pk, key.sk), { routeId: definition.routeId, routeRevision: revision })).toEqual(definition);
    // Such an approval is there, but without a passed driving test it is not dispatchable.
    expect(await checkE2EAgentRouteCurrent(store(db), INSTALLATIONS[0]![1], revision)).toMatchObject({ ok: false, code: "model-route-not-tested" });
  });
});
