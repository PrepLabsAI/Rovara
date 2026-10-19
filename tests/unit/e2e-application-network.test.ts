import { describe, expect, it } from "vitest";
import {
  normalizeE2EApplicationOrigin,
  validateE2EApplicationNetworkRoutes,
  validateE2EApplicationNetworkObservation,
} from "../../packages/verifier/src/application-network.js";

const digest = "a".repeat(64);
const binding = { schemaVersion: "e2e-application-host-preparation/v1", preparationId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222", workspaceId: "33333333-3333-4333-8333-333333333333",
  operationId: "44444444-4444-4444-8444-444444444444", operationFence: 1, workflowRevision: 2, candidateDigest: digest,
  planDigest: digest, intentDigest: digest, groupId: "group-1", runtimeProfileId: "linux-web-api/v1", runtimeManifestDigest: digest,
  networkPolicyDigest: digest, admittedAt: "2026-10-17T12:00:00.000Z", preparationDeadlineAt: "2026-10-17T12:01:00.000Z",
  deadlineAt: "2026-10-17T12:02:00.000Z" } as const;
const app = { applicationId: "orders-app", serviceContract: { listenPort: 4317, portEnv: "APP_PORT", originBindings: [
  { originRef: "orders-api", envName: "ORDERS_API_ORIGIN" }, { originRef: "inventory-v1", envName: "INVENTORY_ORIGIN" },
] } } as const;

describe("application network route binding", () => {
  it("normalizes only concrete canonical HTTP(S) origins", () => {
    expect(normalizeE2EApplicationOrigin("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
    for (const value of ["https://user:pass@example.test", "http://*.example.test", "http://example.test/path", "http://example.test:0", "file:///tmp/x",
      "http://example.test.", "http://exa%6Dple.test"]) {
      expect(() => normalizeE2EApplicationOrigin(value)).toThrow();
    }
  });

  it("requires every source-declared logical origin exactly once and rejects foreign routes", () => {
    const valid = validateE2EApplicationNetworkRoutes({ binding, applications: [app],
      originByApplicationId: [{ applicationId: "orders-app", origins: [
        { originRef: "orders-api", origin: "http://127.0.0.1:4317" }, { originRef: "inventory-v1", origin: "http://127.0.0.1:4318" },
      ] }], mockManifest: [], approvedExternalConnectionRefs: [] });
    expect(valid).toHaveLength(2);
    expect(() => validateE2EApplicationNetworkRoutes({ binding, applications: [app], originByApplicationId: [
      { applicationId: "orders-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" }] },
    ], mockManifest: [], approvedExternalConnectionRefs: [] })).toThrow();
    expect(() => validateE2EApplicationNetworkRoutes({ binding, applications: [app], originByApplicationId: [
      { applicationId: "orders-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" }, { originRef: "foreign", origin: "http://127.0.0.1:4318" }] },
    ], mockManifest: [], approvedExternalConnectionRefs: [] })).toThrow();
  });

  it("accepts only exact approved external connections or exact mock entries per logical origin", () => {
    const mock = { componentId: "inventory-mock", applicationId: "orders-app", originRef: "inventory-v1", fixtureDigest: digest, mockManifestDigest: digest };
    const valid = validateE2EApplicationNetworkRoutes({ binding, applications: [app], originByApplicationId: [
      { applicationId: "orders-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" },
        { originRef: "inventory-v1", origin: null, mockComponentId: "inventory-mock" }] },
    ], mockManifest: [mock], approvedExternalConnectionRefs: [] });
    expect(valid.find((item) => item.originRef === "inventory-v1")).toMatchObject({ kind: "mock", fixtureDigest: digest, mockManifestDigest: digest });
    expect(() => validateE2EApplicationNetworkRoutes({ binding, applications: [app], originByApplicationId: [
      { applicationId: "orders-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" },
        { originRef: "inventory-v1", origin: null, mockComponentId: "unapproved" }] },
    ], mockManifest: [mock], approvedExternalConnectionRefs: [] })).toThrow();
  });

  it("rejects an unused mock row that aliases a valid component under a foreign originRef", () => {
    const mock = { componentId: "inventory-mock", applicationId: "orders-app", originRef: "inventory-v1", fixtureDigest: digest, mockManifestDigest: digest };
    const foreignAlias = { ...mock, originRef: "orders-api" };
    expect(() => validateE2EApplicationNetworkRoutes({ binding, applications: [app], originByApplicationId: [
      { applicationId: "orders-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" },
        { originRef: "inventory-v1", origin: null, mockComponentId: "inventory-mock" }] },
    ], mockManifest: [mock, foreignAlias], approvedExternalConnectionRefs: [] })).toThrow(/unused or foreign route/);
  });

  it("refuses one external origin grant when the same source originRef belongs to multiple applications", () => {
    const secondApp = { ...app, applicationId: "inventory-app" };
    const connection = { connectionId: "orders-test-connection", revision: 3, originRef: "inventory-v1", grantDigest: digest };
    expect(() => validateE2EApplicationNetworkRoutes({ binding, applications: [app, secondApp], originByApplicationId: [
      { applicationId: "orders-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" },
        { originRef: "inventory-v1", origin: null, externalConnectionRef: connection }] },
      { applicationId: "inventory-app", origins: [{ originRef: "orders-api", origin: "http://127.0.0.1:4317" },
        { originRef: "inventory-v1", origin: null, externalConnectionRef: connection }] },
    ], mockManifest: [], approvedExternalConnectionRefs: [connection] })).toThrow(/multiple source application owners/);
  });

  it("rejects receipt reuse and app-log-only mock consumption", () => {
    const receipt = { runId: "run-1", caseId: "case-1", targetId: "target-1", mockManifestDigest: digest, componentId: "inventory-mock", fixtureDigest: digest, requestId: "req-1", responseStatus: 200 };
    expect(validateE2EApplicationNetworkObservation({ expectedRunId: "run-1", expected: [{ caseId: "case-1", targetId: "target-1", componentId: "inventory-mock", mockManifestDigest: digest, fixtureDigest: digest }],
      observedReceipts: [receipt], observedMockComponentIds: ["inventory-mock"], requiredRealComponentIds: [] })).toEqual({ consumedMockComponentIds: ["inventory-mock"], unavailableComponentIds: [] });
    expect(() => validateE2EApplicationNetworkObservation({ expectedRunId: "run-1", expected: [{ caseId: "case-2", targetId: "target-1", componentId: "inventory-mock", mockManifestDigest: digest, fixtureDigest: digest }],
      observedReceipts: [receipt], observedMockComponentIds: ["inventory-mock"], requiredRealComponentIds: [] })).toThrow();
    expect(() => validateE2EApplicationNetworkObservation({ expectedRunId: "run-2", expected: [{ caseId: "case-1", targetId: "target-1", componentId: "inventory-mock", mockManifestDigest: digest, fixtureDigest: digest }],
      observedReceipts: [receipt], observedMockComponentIds: ["inventory-mock"], requiredRealComponentIds: [] })).toThrow();
    expect(() => validateE2EApplicationNetworkObservation({ expectedRunId: "run-1", expected: [{ caseId: "case-1", targetId: "target-1", componentId: "inventory-mock", mockManifestDigest: digest, fixtureDigest: "b".repeat(64) }],
      observedReceipts: [receipt], observedMockComponentIds: ["inventory-mock"], requiredRealComponentIds: [] })).toThrow();
    expect(() => validateE2EApplicationNetworkObservation({ expectedRunId: "run-1", expected: [{ caseId: "case-1", targetId: "target-1", componentId: "inventory-mock", mockManifestDigest: digest, fixtureDigest: digest }],
      observedReceipts: [], observedMockComponentIds: ["inventory-mock"], requiredRealComponentIds: [] })).toThrow();
  });
});
